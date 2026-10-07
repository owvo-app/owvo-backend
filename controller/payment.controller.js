import Stripe from "stripe";
import { Booking } from "../model/booking.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { User } from "../model/user.model.js";
import { emitToUser } from "../socket/socket.js";
import { notifyUser } from "../utils/fcm.util.js";

const getStripe = () =>
  new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: process.env.STRIPE_API_VERSION || "2025-11-17.clover",
  });

const toPositiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

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

const updateBookingAsPaid = async (paymentRecord, transactionId) => {
  const booking = await Booking.findById(paymentRecord.bookingId)
    .populate("user", "_id name email")
    .populate("provider", "_id name email");

  if (!booking) return;

  const wasPaid = booking.payment?.status === "paid";
  booking.payment = {
    ...(booking.payment?.toObject?.() || booking.payment || {}),
    method: "online",
    status: "paid",
    trxId: transactionId,
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

export const createPayment = async (req, res) => {
  const { price, bookingId, type, paymentMethod, userId: bodyUserId } = req.body;
  const authUserId = req.user?._id?.toString();
  const paymentType = normalizePaymentType(type);
  const selectedPaymentMethod = normalizePaymentMethod(paymentMethod);

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
    const metadata = {
      userId: authUserId,
      bookingId: booking._id.toString(),
      providerId: booking.provider?.toString() || "",
      type: paymentType,
      paymentMethod: selectedPaymentMethod,
      currency,
    };

    const paymentIntent = await getStripe().paymentIntents.create({
      amount: Math.round(amountToCharge * 100),
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
    });

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
    const paymentIntent = event.data.object;

    switch (event.type) {
      case "payment_intent.succeeded":
        await markPaymentSucceeded(paymentIntent);
        break;
      case "payment_intent.payment_failed":
      case "payment_intent.canceled":
        await markPaymentFailed(paymentIntent);
        break;
      case "payment_intent.processing":
        await markPaymentFailed(paymentIntent, "pending");
        break;
      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handling error:", error?.message || error);
    return sendFailure(res, 500, "Stripe webhook handling failed.");
  }
};

