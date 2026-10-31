import Stripe from "stripe";
import { Booking } from "../model/booking.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { User } from "../model/user.model.js";
import { emitToUser } from "../socket/socket.js";
import { notifyUser } from "../utils/fcm.util.js";
import { Payout } from "../model/payout.model.js";
import { SupportTicket } from "../model/supportTicket.model.js";
import { Refund } from "../model/refund.model.js";
import { Wallet } from "../model/wallet.model.js";
import { WalletTransaction } from "../model/walletTransaction.model.js";
import {
  applyEarningReversal,
  syncBookingRefundSummary,
} from "../utils/money.util.js";

const getStripe = () =>
  new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: process.env.STRIPE_API_VERSION || "2025-11-17.clover",
  });

const toPositiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const asMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const normalizePaymentType = (value) =>
  value?.toString().toLowerCase() === "tips" ? "tips" : "booking";

const normalizePaymentMethod = (value) => {
  const method = value?.toString().trim().toLowerCase();
  if (method === "paypal") return "paypal";
  if (method === "amazon" || method === "amazonpay" || method === "amazon_pay") {
    return "amazon_pay";
  }
  return "card";
};

const stripeMethodParams = (paymentMethod) => {
  if (paymentMethod === "paypal") {
    return {
      payment_method_types: ["paypal"],
      payment_method_options: {
        paypal: {
          preferred_locale: "en-GB",
        },
      },
    };
  }

  if (paymentMethod === "amazon_pay") {
    return {
      payment_method_types: ["amazon_pay"],
    };
  }

  return {
    automatic_payment_methods: { enabled: true },
  };
};

const sendFailure = (res, statusCode, message, details = undefined) =>
  res.status(statusCode).json({
    success: false,
    message,
    errorSources: [{ path: "", message }],
    ...(details ? { details } : {}),
  });

const updateBookingAsPaid = async (paymentRecord, transactionId, opts = {}) => {
  const booking = await Booking.findById(paymentRecord.bookingId)
    .populate("user", "_id name email")
    .populate("provider", "_id name email");

  if (!booking) return;

  const wasPaid = booking.payment?.status === "paid";
  booking.payment = {
    ...(booking.payment?.toObject?.() || booking.payment || {}),
    method: opts.method || "online",
    status: "paid",
    trxId: transactionId,
    walletAmount: opts.walletAmount || 0,
    cardAmount:
      opts.cardAmount !== undefined ? opts.cardAmount : paymentRecord.price,
  };
  await booking.save();

  if (!wasPaid && booking.provider?._id) {
    const amount = paymentRecord.price;
    const currency = paymentRecord.currency || "GBP";
    const symbol = currency === "GBP" ? "£" : `${currency} `;
    emitToUser(booking.provider._id.toString(), "booking_payment_confirmed", {
      bookingId: booking._id.toString(),
      status: booking.status,
      paymentStatus: "paid",
      amount,
      currency,
      userId: booking.user?._id?.toString(),
      userName: booking.user?.name,
      message: "The user has paid for this booking.",
    });
    // Push too — socket alone won't reach a closed app.
    notifyUser(booking.provider._id.toString(), {
      title: "Payment received!",
      body: `${booking.user?.name || "The customer"} has paid ${symbol}${amount} for this booking.`,
      data: {
        type: "payment_confirmed",
        bookingId: booking._id.toString(),
      },
    });
  }
};

const addTipToProviderBalance = async (paymentRecord) => {
  const booking = paymentRecord.bookingId
    ? await Booking.findById(paymentRecord.bookingId)
        .populate("user", "_id name email")
        .populate("provider", "_id name email")
    : null;

  const providerId = paymentRecord.providerId
    ? paymentRecord.providerId
    : booking?.provider?._id || booking?.provider;

  if (!providerId) return;

  await User.findByIdAndUpdate(
    providerId,
    {
      $inc: {
        balance: paymentRecord.price,
        totalTipsEarned: paymentRecord.price,
      },
    },
    { new: true }
  );

  const amount = toPositiveNumber(paymentRecord.price);
  const currency = paymentRecord.currency || "GBP";
  const customerName = booking?.user?.name?.trim() || "A customer";

  emitToUser(providerId.toString(), "tip_received", {
    bookingId: booking?._id?.toString() || paymentRecord.bookingId?.toString(),
    amount,
    currency,
    userId: booking?.user?._id?.toString() || paymentRecord.userId?.toString(),
    userName: customerName,
    message: `${customerName} sent you ${currency} ${amount.toFixed(2)} as a tip.`,
  });

  // 🔔 Push too — socket alone won't reach a closed app.
  notifyUser(providerId.toString(), {
    title: "Tip received! 🎉",
    body: `${customerName} sent you ${currency === "GBP" ? "£" : currency + " "}${amount.toFixed(2)} as a tip.`,
    data: {
      type: "tip_received",
      bookingId: booking?._id?.toString() || paymentRecord.bookingId?.toString() || "",
    },
  });
};

const markPaymentSucceeded = async (paymentIntent) => {
  const transactionId = paymentIntent.id;
  const paymentRecord = await paymentInfo.findOne({ transactionId });

  if (!paymentRecord) return null;

  const alreadyComplete =
    paymentRecord.paymentStatus === "complete" ||
    paymentRecord.status === "success";

  if (!alreadyComplete) {
    paymentRecord.paymentStatus = "complete";
    paymentRecord.status = "success";
    paymentRecord.paymentMethod =
      paymentIntent.payment_method_types?.[0] || paymentRecord.paymentMethod;
    await paymentRecord.save();
    await settleWalletHold(paymentRecord, true);
  }

  if (paymentRecord.bookingId && paymentRecord.type !== "tips") {
    await updateBookingAsPaid(paymentRecord, transactionId);
  }

  if (paymentRecord.type === "tips" && !alreadyComplete) {
    await addTipToProviderBalance(paymentRecord);
  }

  return paymentRecord;
};

const markPaymentFailed = async (paymentIntent, status = "failed") => {
  const transactionId = paymentIntent.id;
  const paymentRecord = await paymentInfo.findOne({ transactionId });

  if (!paymentRecord) return null;
  if (paymentRecord.status === "success") return paymentRecord;

  paymentRecord.paymentStatus = status;
  paymentRecord.status = status === "pending" ? "pending" : "failed";
  paymentRecord.paymentMethod =
    paymentIntent.payment_method_types?.[0] || paymentRecord.paymentMethod;
  await paymentRecord.save();
  if (status !== "pending") {
    await settleWalletHold(paymentRecord, false);
  }

  if (paymentRecord.bookingId && paymentRecord.type !== "tips") {
    await Booking.findByIdAndUpdate(paymentRecord.bookingId, {
      $set: {
        "payment.method": "online",
        "payment.status": status === "pending" ? "pending" : "failed",
        "payment.trxId": transactionId,
      },
    });
  }

  return paymentRecord;
};


// ── Customer wallet (Payments phase) ─────────────────────────────
const getOrCreateWallet = async (userId) =>
  Wallet.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

// Top-up sirf verified success par credit hota hai — client ke kehne
// par kabhi nahi. Entry pehle se complete ho to dobara credit nahi.
const creditWalletTopup = async (paymentIntent) => {
  const entry = await WalletTransaction.findOne({
    stripePaymentIntentId: paymentIntent.id,
    type: "topup",
  });
  if (!entry || entry.status === "complete") return entry;
  const wallet = await Wallet.findByIdAndUpdate(
    entry.wallet,
    { $inc: { balance: Math.abs(entry.amount) } },
    { new: true }
  );
  if (!wallet) return entry;
  entry.status = "complete";
  entry.balanceAfter = wallet.balance;
  await entry.save();
  notifyUser(entry.user.toString(), {
    title: "Wallet topped up",
    body: `£${Math.abs(entry.amount).toFixed(2)} has been added to your OWVO wallet.`,
    data: { type: "wallet_topup" },
  });
  return entry;
};

const failWalletTopup = async (paymentIntent) => {
  const entry = await WalletTransaction.findOne({
    stripePaymentIntentId: paymentIntent.id,
    type: "topup",
    status: "pending",
  });
  if (!entry) return;
  entry.status = "failed";
  await entry.save();
};

// Split payment me wallet hissa pehle hold (pending entry) rehta
// hai; card ka natija ane par hold pakka (complete) ya, fail par,
// paisa wallet me wapas credit.
const settleWalletHold = async (paymentRecord, succeeded) => {
  if (!paymentRecord?.bookingId || !(paymentRecord.walletAmount > 0)) return;
  const entry = await WalletTransaction.findOne({
    booking: paymentRecord.bookingId,
    type: "payment",
    status: "pending",
  });
  if (!entry) return;
  if (succeeded) {
    entry.status = "complete";
    await entry.save();
    return;
  }
  const wallet = await Wallet.findByIdAndUpdate(
    entry.wallet,
    { $inc: { balance: Math.abs(entry.amount) } },
    { new: true }
  );
  entry.status = "failed";
  if (wallet) entry.balanceAfter = wallet.balance;
  await entry.save();
};

// Stripe dashboard se seedha diya gaya refund (panel ke bahar) bhi
// ledger me record hota hai — panel par hamesha asal surat-e-hal.
const syncExternalRefund = async (charge) => {
  const paymentIntentId = charge?.payment_intent;
  if (!paymentIntentId) return;
  const record = await paymentInfo.findOne({ transactionId: paymentIntentId });
  if (!record) return;
  const refunds = await getStripe().refunds.list({
    payment_intent: paymentIntentId,
    limit: 20,
  });
  for (const stripeRefund of refunds.data) {
    if (stripeRefund.status !== "succeeded") continue;
    const exists = await Refund.findOne({ stripeRefundId: stripeRefund.id });
    if (exists) continue;
    const refund = await Refund.create({
      booking: record.bookingId,
      payment: record._id,
      customer: record.userId,
      provider: record.providerId,
      amount: asMoney(stripeRefund.amount / 100),
      walletPortion: 0,
      cardPortion: asMoney(stripeRefund.amount / 100),
      source: "admin",
      status: "refunded",
      reasonCategory: "other",
      reason: "Refund issued in Stripe (outside the panel) — synced automatically.",
      stripePaymentIntentId: paymentIntentId,
      stripeRefundId: stripeRefund.id,
      refundedAt: new Date(
        (stripeRefund.created || Math.floor(Date.now() / 1000)) * 1000
      ),
    });
    await applyEarningReversal(refund);
    if (record.bookingId) {
      await syncBookingRefundSummary(record.bookingId);
    }
  }
};

// Stripe Connect account ki halat (onboarding / payouts enabled).
const syncConnectAccount = async (account) => {
  if (!account?.id) return;
  const user = await User.findOne({ "stripeConnect.accountId": account.id });
  if (!user) return;
  user.stripeConnect.payoutsEnabled = !!account.payouts_enabled;
  user.stripeConnect.onboardingComplete = !!(
    account.details_submitted && account.payouts_enabled
  );
  await user.save();
};

// Connected account ke bank payout ka natija — hamari processing
// wali Payout record se mila kar paid/failed lagata hai.
const syncConnectPayout = async (event) => {
  const accountId = event.account;
  if (!accountId) return; // platform account ke payouts yahan nahi ate
  const stripePayout = event.data.object;
  const amount = asMoney((stripePayout.amount || 0) / 100);
  const payout = await Payout.findOne({
    stripeDestinationAccountId: accountId,
    stripeMode: "stripe_transfer",
    status: "processing",
    amount,
  }).sort({ createdAt: 1 });
  if (!payout) {
    console.warn(
      "Connect payout event without matching payout:",
      event.type,
      accountId,
      amount
    );
    return;
  }
  if (event.type === "payout.paid") {
    payout.status = "paid";
    payout.stripePayoutId = stripePayout.id;
    payout.paidAt = stripePayout.arrival_date
      ? new Date(stripePayout.arrival_date * 1000)
      : new Date();
    payout.attempts.push({
      action: "stripe_payout_paid",
      result: "paid",
      note: "Stripe confirmed the money reached the bank.",
    });
  } else {
    payout.status = "failed";
    payout.failureReason =
      stripePayout.failure_message ||
      stripePayout.failure_code ||
      "Stripe payout failed";
    payout.attempts.push({
      action: "stripe_payout_failed",
      result: "failed",
      note: payout.failureReason,
    });
  }
  await payout.save();
  notifyUser(payout.provider.toString(), {
    title: event.type === "payout.paid" ? "Payout sent! 💸" : "Payout failed",
    body:
      event.type === "payout.paid"
        ? `£${amount.toFixed(2)} has been paid to your bank account.`
        : `Your payout of £${amount.toFixed(2)} could not be completed. Our team has been notified.`,
    data: {
      type: event.type === "payout.paid" ? "payout_paid" : "payout_failed",
      payoutId: payout._id.toString(),
    },
  });
};

export const createPayment = async (req, res) => {
  const { price, bookingId, type, paymentMethod, userId: bodyUserId } = req.body;
  const authUserId = req.user?._id?.toString();
  const paymentType = normalizePaymentType(type);
  const selectedPaymentMethod = normalizePaymentMethod(paymentMethod);
  const payMethod = ["wallet", "split"].includes(req.body.payMethod)
    ? req.body.payMethod
    : "card";

  if (!authUserId) {
    return sendFailure(res, 401, "Authentication required.");
  }

  if (bodyUserId && bodyUserId.toString() !== authUserId) {
    return sendFailure(res, 403, "You cannot create payment for another user.");
  }

  if (!bookingId) {
    return sendFailure(res, 400, "bookingId is required.");
  }

  try {
    const booking = await Booking.findById(bookingId).select(
      "user provider price finalPrice currency payment status"
    );

    if (!booking) {
      return sendFailure(res, 404, "Booking not found.");
    }

    if (booking.user?.toString() !== authUserId) {
      return sendFailure(res, 403, "You cannot pay for this booking.");
    }

    if (paymentType === "booking" && booking.payment?.status === "paid") {
      return sendFailure(res, 409, "Booking is already paid.");
    }

    const amountToCharge =
      paymentType === "booking"
        ? toPositiveNumber(booking.finalPrice || booking.price)
        : toPositiveNumber(price);

    if (!amountToCharge) {
      return sendFailure(res, 400, "Payment amount must be greater than 0.");
    }

    const currency = (booking.currency || "GBP").toLowerCase();

    // ── Wallet / Card split (Payments phase) ────────────────────
    // Sirf booking payments ke liye; tips hamesha card se jate hain.
    let walletUse = 0;
    if (paymentType === "booking" && payMethod !== "card") {
      const walletDoc = await getOrCreateWallet(authUserId);
      const balance = asMoney(walletDoc.balance);
      if (payMethod === "wallet") {
        if (balance < amountToCharge) {
          return sendFailure(
            res,
            400,
            "Insufficient wallet balance for this booking."
          );
        }
        walletUse = amountToCharge;
      } else {
        walletUse = Math.min(balance, amountToCharge);
      }
      walletUse = asMoney(walletUse);
    }
    const cardPart = asMoney(amountToCharge - walletUse);

    // Poora wallet se — Stripe payment ki zaroorat hi nahi.
    if (walletUse > 0 && cardPart === 0) {
      const debited = await Wallet.findOneAndUpdate(
        { user: authUserId, balance: { $gte: walletUse } },
        { $inc: { balance: -walletUse } },
        { new: true }
      );
      if (!debited) {
        return sendFailure(res, 409, "Insufficient wallet balance.");
      }
      const walletTxn = await WalletTransaction.create({
        wallet: debited._id,
        user: authUserId,
        type: "payment",
        amount: -walletUse,
        balanceAfter: debited.balance,
        booking: booking._id,
        status: "complete",
      });
      const record = await paymentInfo.create({
        userId: authUserId,
        bookingId: booking._id,
        providerId: booking.provider,
        price: amountToCharge,
        currency: currency.toUpperCase(),
        transactionId: walletTxn.txnNumber,
        paymentStatus: "complete",
        status: "success",
        paymentMethod: "wallet",
        type: paymentType,
        walletAmount: walletUse,
        cardAmount: 0,
      });
      await updateBookingAsPaid(record, walletTxn.txnNumber, {
        method: "wallet",
        walletAmount: walletUse,
        cardAmount: 0,
      });
      return res.status(200).json({
        success: true,
        message: "Paid with wallet.",
        data: {
          walletPaid: true,
          paymentIntentId: null,
          paymentMethod: "wallet",
        },
      });
    }

    // Split: wallet hissa pehle hold (debit). Card fail ho to
    // settleWalletHold paisa wapas kar deta hai.
    let walletHold = null;
    if (walletUse > 0) {
      const debited = await Wallet.findOneAndUpdate(
        { user: authUserId, balance: { $gte: walletUse } },
        { $inc: { balance: -walletUse } },
        { new: true }
      );
      if (!debited) {
        return sendFailure(res, 409, "Insufficient wallet balance.");
      }
      walletHold = await WalletTransaction.create({
        wallet: debited._id,
        user: authUserId,
        type: "payment",
        amount: -walletUse,
        balanceAfter: debited.balance,
        booking: booking._id,
        status: "pending",
      });
    }

    const metadata = {
      userId: authUserId,
      bookingId: booking._id.toString(),
      providerId: booking.provider?.toString() || "",
      type: paymentType,
      paymentMethod: selectedPaymentMethod,
      currency,
      walletAmount: String(walletUse),
      cardAmount: String(cardPart),
    };

    let paymentIntent;
    try {
      paymentIntent = await getStripe().paymentIntents.create({
        amount: Math.round(cardPart * 100),
        currency,
        metadata,
        description:
          paymentType === "tips"
            ? `owvo tip for booking ${booking._id}`
            : `owvo booking ${booking._id}`,
        ...stripeMethodParams(selectedPaymentMethod),
      });

      await paymentInfo.create({
        userId: authUserId,
        bookingId: booking._id,
        providerId: booking.provider,
        price: amountToCharge,
        currency: currency.toUpperCase(),
        transactionId: paymentIntent.id,
        paymentStatus: "pending",
        status: "pending",
        paymentMethod: selectedPaymentMethod,
        type: paymentType,
        walletAmount: walletUse,
        cardAmount: cardPart,
      });
    } catch (stripeError) {
      // Card side ban hi nahi paya — wallet hold foran wapas.
      if (walletHold) {
        await Wallet.findByIdAndUpdate(walletHold.wallet, {
          $inc: { balance: walletUse },
        });
        walletHold.status = "failed";
        await walletHold.save();
      }
      throw stripeError;
    }

    return res.status(200).json({
      success: true,
      message: "PaymentIntent created.",
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        paymentMethod: selectedPaymentMethod,
      },
    });
  } catch (error) {
    console.error("Create payment error:", error?.message || error);
    return sendFailure(
      res,
      error?.statusCode || 500,
      error?.message || "Internal server error."
    );
  }
};

export const confirmPayment = async (req, res) => {
  const { paymentIntentId } = req.body;

  if (!paymentIntentId) {
    return sendFailure(res, 400, "Missing paymentIntentId.");
  }

  try {
    const paymentIntent = await getStripe().paymentIntents.retrieve(
      paymentIntentId
    );

    if (!paymentIntent) {
      return sendFailure(res, 404, "PaymentIntent not found.");
    }

    // Wallet top-up ka apna raasta — booking payment se alag.
    if (paymentIntent.metadata?.type === "wallet_topup") {
      if (paymentIntent.status === "succeeded") {
        await creditWalletTopup(paymentIntent);
        return res.status(200).json({
          success: true,
          message: "Wallet topped up",
          data: { paymentIntentId },
        });
      }
      if (paymentIntent.status === "processing") {
        return sendFailure(
          res,
          202,
          "Payment is still processing. Please wait for confirmation.",
          { stripeStatus: paymentIntent.status }
        );
      }
      await failWalletTopup(paymentIntent);
      return sendFailure(res, 400, "Payment did not succeed.", {
        stripeStatus: paymentIntent.status,
      });
    }

    if (paymentIntent.status === "succeeded") {
      await markPaymentSucceeded(paymentIntent);

      return res.status(200).json({
        success: true,
        message: "Payment confirmed",
        data: { paymentIntentId },
      });
    }

    if (paymentIntent.status === "processing") {
      await markPaymentFailed(paymentIntent, "pending");
      return sendFailure(
        res,
        202,
        "Payment is still processing. Please wait for confirmation.",
        { stripeStatus: paymentIntent.status }
      );
    }

    await markPaymentFailed(paymentIntent);
    return sendFailure(res, 400, "Payment did not succeed.", {
      stripeStatus: paymentIntent.status,
    });
  } catch (error) {
    console.error("Confirm payment error:", error?.message || error);
    return sendFailure(
      res,
      error?.statusCode || 500,
      error?.message || "Internal server error."
    );
  }
};

export const stripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return sendFailure(res, 500, "Stripe webhook secret is not configured.");
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error?.message || error);
    return sendFailure(res, 400, `Webhook Error: ${error.message}`);
  }

  try {
    const obj = event.data.object;

    if (event.type === "charge.refunded") {
      await syncExternalRefund(obj);
    } else if (event.type === "account.updated") {
      await syncConnectAccount(obj);
    } else if (event.type === "payout.paid" || event.type === "payout.failed") {
      // Sirf connected accounts ke events (event.account set hota
      // hai); Stripe dashboard me is webhook par Connect events
      // bhi enable hone chahiye.
      await syncConnectPayout(event);
    } else {
      const paymentIntent = obj;
      const isTopup = paymentIntent?.metadata?.type === "wallet_topup";
      switch (event.type) {
        case "payment_intent.succeeded":
          if (isTopup) await creditWalletTopup(paymentIntent);
          else await markPaymentSucceeded(paymentIntent);
          break;
        case "payment_intent.payment_failed":
        case "payment_intent.canceled":
          if (isTopup) await failWalletTopup(paymentIntent);
          else await markPaymentFailed(paymentIntent);
          break;
        case "payment_intent.processing":
          if (!isTopup) await markPaymentFailed(paymentIntent, "pending");
          break;
        default:
          break;
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handling error:", error?.message || error);
    return sendFailure(res, 500, "Stripe webhook handling failed.");
  }
};

export const getMyWallet = async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user._id);
    const transactions = await WalletTransaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(30);
    return res.status(200).json({
      success: true,
      data: {
        balance: wallet.balance,
        currency: wallet.currency,
        transactions,
      },
    });
  } catch (error) {
    console.error("Get wallet error:", error?.message || error);
    return sendFailure(res, 500, "Could not load your wallet.");
  }
};

export const getMyWalletTransactions = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = { user: req.user._id };
    const [total, transactions] = await Promise.all([
      WalletTransaction.countDocuments(filter),
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        transactions,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Wallet transactions error:", error?.message || error);
    return sendFailure(res, 500, "Could not load wallet transactions.");
  }
};

export const createWalletTopup = async (req, res) => {
  try {
    const amount = asMoney(req.body?.amount);
    if (!amount || amount < 5 || amount > 500) {
      return sendFailure(
        res,
        400,
        "Top-up amount must be between £5 and £500."
      );
    }
    const wallet = await getOrCreateWallet(req.user._id);
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "gbp",
      metadata: { type: "wallet_topup", userId: req.user._id.toString() },
      description: "owvo wallet top-up",
      automatic_payment_methods: { enabled: true },
    });
    await WalletTransaction.create({
      wallet: wallet._id,
      user: req.user._id,
      type: "topup",
      amount,
      balanceAfter: wallet.balance,
      status: "pending",
      stripePaymentIntentId: paymentIntent.id,
    });
    return res.status(200).json({
      success: true,
      message: "Top-up started.",
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      },
    });
  } catch (error) {
    console.error("Wallet top-up error:", error?.message || error);
    return sendFailure(
      res,
      error?.statusCode || 500,
      "Could not start the top-up. Please try again."
    );
  }
};

// Customer apni paid booking ke liye refund ki darkhwast bhejta
// hai — Refund ledger me "requested" record banta hai aur admin
// queue se approve/reject hota hai. Sath me ek support ticket bhi
// khulta hai taake customer ko thread nazar aye.
export const createRefundRequest = async (req, res) => {
  try {
    const { bookingId, reason } = req.body || {};
    if (!bookingId) {
      return sendFailure(res, 400, "bookingId is required.");
    }
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return sendFailure(res, 404, "Booking not found.");
    }
    if (booking.user?.toString() !== req.user._id.toString()) {
      return sendFailure(
        res,
        403,
        "You can only request a refund for your own booking."
      );
    }
    if (booking.payment?.status !== "paid") {
      return sendFailure(res, 400, "This booking has not been paid yet.");
    }
    const existing = await Refund.findOne({
      booking: booking._id,
      status: { $in: ["requested", "under_review", "approved", "processing"] },
    });
    if (existing) {
      return sendFailure(
        res,
        409,
        "A refund request for this booking is already being reviewed."
      );
    }
    const record = await paymentInfo
      .findOne({
        bookingId: booking._id,
        type: "booking",
        paymentStatus: "complete",
      })
      .sort({ createdAt: -1 });
    const refundedAgg = await Refund.aggregate([
      { $match: { booking: booking._id, status: "refunded" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const captured = record
      ? Number(record.price) || 0
      : Number(booking.finalPrice || booking.price) || 0;
    const remaining = asMoney(captured - (refundedAgg[0]?.total || 0));
    if (remaining <= 0) {
      return sendFailure(
        res,
        400,
        "This booking has already been fully refunded."
      );
    }

    let ticket = null;
    try {
      ticket = await SupportTicket.create({
        reporter: req.user._id,
        reporterRole: "customer",
        subject: "Refund request",
        description:
          (reason || "").toString().trim() ||
          "Customer requested a refund from the app.",
        type: "refund",
        booking: booking._id,
        reportedUser: booking.provider || undefined,
        againstRole: booking.provider ? "provider" : undefined,
      });
    } catch (e) {
      /* ticket best effort — ledger request phir bhi banta hai */
    }

    const refund = await Refund.create({
      booking: booking._id,
      payment: record?._id,
      customer: req.user._id,
      provider: booking.provider,
      amount: remaining,
      source: "customer_request",
      status: "requested",
      reason: (reason || "").toString().trim(),
      reasonCategory: "other",
      ticket: ticket?._id,
    });

    return res.status(201).json({
      success: true,
      message: "Refund request sent. Our team will review it.",
      data: refund,
    });
  } catch (error) {
    console.error("Refund request error:", error?.message || error);
    return sendFailure(res, 500, "Could not send the refund request.");
  }
};

export const getMyRefundRequests = async (req, res) => {
  try {
    const refunds = await Refund.find({ customer: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    return res.status(200).json({ success: true, data: refunds });
  } catch (error) {
    console.error("My refunds error:", error?.message || error);
    return sendFailure(res, 500, "Could not load your refund requests.");
  }
};
