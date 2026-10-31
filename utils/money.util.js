import mongoose from "mongoose";
import { Booking } from "../model/booking.model.js";
import { Payout } from "../model/payout.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import { Refund } from "../model/refund.model.js";
import { SupportTicket } from "../model/supportTicket.model.js";

// ─── OWVO money helpers (Payments phase) ─────────────────────────────
// Ek hi jagah se saara hisaab — taake wallet, admin earnings, payout
// limits aur dashboard kabhi alag numbers na dikhayein.

export const asMoney = (amount) =>
  Math.round((Number(amount) || 0) * 100) / 100;

export const getPlatformSettingsDoc = async () =>
  PlatformSetting.findOneAndUpdate(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

export const getCurrentCommissionRate = async () => {
  const settings = await getPlatformSettingsDoc();
  const rate = Number(settings?.commissionRate);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.25;
};

// Booking complete hone par commission ka snapshot — us lamhe ka rate
// hamesha ke liye booking par likh diya jata hai. Dobara call ho to
// kuch nahi badalta (idempotent). Rate badalne ka asar sirf is ke
// BAAD complete hone wali bookings par hoga.
export const applyCommissionSnapshot = async (booking, knownRate) => {
  if (!booking) return booking;
  if (booking.commissionRate !== null && booking.commissionRate !== undefined) {
    return booking;
  }
  const rate =
    knownRate !== undefined && knownRate !== null
      ? Number(knownRate)
      : await getCurrentCommissionRate();
  const gross = asMoney(booking.finalPrice || booking.price || 0);
  booking.commissionRate = rate;
  booking.commissionAmount = asMoney(gross * rate);
  booking.providerNetAmount = asMoney(gross - booking.commissionAmount);
  return booking;
};

// Ek booking ki asal net earning — snapshot ho to wohi, na ho
// (purani booking, backfill se pehle) to current rate se andaza.
export const bookingNetAmount = (booking, fallbackRate) => {
  if (
    booking?.providerNetAmount !== null &&
    booking?.providerNetAmount !== undefined
  ) {
    return asMoney(booking.providerNetAmount);
  }
  const gross = asMoney(booking?.finalPrice || booking?.price || 0);
  return asMoney(gross * (1 - fallbackRate));
};

export const getProviderTipsTotal = async (providerId) => {
  const agg = await paymentInfo.aggregate([
    {
      $match: {
        providerId: new mongoose.Types.ObjectId(providerId),
        type: "tips",
        paymentStatus: "complete",
      },
    },
    { $group: { _id: null, total: { $sum: "$price" } } },
  ]);
  return asMoney(agg[0]?.total || 0);
};

// Provider ke paisay ka EK unified hisaab:
//   available = (completed bookings ki net earning, snapshot par)
//             + tips (100% provider ke)
//             − refund reversals (jo payout se pehle hue)
//             − dispute par ruki hui earnings (held)
//             − pehle paid ho chuke payouts (booking source ke)
//             − pending/processing payouts (booking source ke)
//             − payout ke baad ke refund adjustments
// Bonus payouts is hisaab ko kabhi nahi chhoote (source: "bonus").
export const computeProviderBalances = async (providerId) => {
  const rate = await getCurrentCommissionRate();
  const providerObjectId = new mongoose.Types.ObjectId(providerId);

  const [bookings, tips, refunds, paidAgg, allocatedAgg, openDisputes] =
    await Promise.all([
      Booking.find({ provider: providerObjectId, status: "completed" })
        .select(
          "_id finalPrice price commissionRate commissionAmount providerNetAmount completedAt"
        )
        .lean(),
      getProviderTipsTotal(providerId),
      Refund.find({
        provider: providerObjectId,
        status: "refunded",
        "earningReversal.status": { $in: ["reversed", "adjusted"] },
      })
        .select("booking earningReversal")
        .lean(),
      Payout.aggregate([
        {
          $match: {
            provider: providerObjectId,
            status: "paid",
            source: { $ne: "bonus" },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Payout.aggregate([
        {
          $match: {
            provider: providerObjectId,
            status: { $in: ["pending", "processing"] },
            source: { $ne: "bonus" },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      SupportTicket.find({
        type: "dispute",
        status: { $in: ["open", "in_progress"] },
        booking: { $ne: null },
      })
        .select("booking")
        .lean(),
    ]);

  const reversedByBooking = new Map();
  let adjustments = 0;
  for (const refund of refunds) {
    const amount = asMoney(refund.earningReversal?.amount || 0);
    if (!amount) continue;
    if (refund.earningReversal.status === "adjusted") {
      adjustments = asMoney(adjustments + amount);
    } else {
      const key = refund.booking?.toString();
      if (key) {
        reversedByBooking.set(
          key,
          asMoney((reversedByBooking.get(key) || 0) + amount)
        );
      }
    }
  }

  const disputedBookingIds = new Set(
    openDisputes.map((ticket) => ticket.booking?.toString()).filter(Boolean)
  );

  let gross = 0;
  let commission = 0;
  let net = 0;
  let heldAmount = 0;
  const heldBookingIds = [];

  for (const booking of bookings) {
    const bookingGross = asMoney(booking.finalPrice || booking.price || 0);
    const bookingNet = bookingNetAmount(booking, rate);
    gross = asMoney(gross + bookingGross);
    commission = asMoney(commission + asMoney(bookingGross - bookingNet));
    const reversed = reversedByBooking.get(booking._id.toString()) || 0;
    const effectiveNet = asMoney(Math.max(bookingNet - reversed, 0));
    net = asMoney(net + effectiveNet);
    if (disputedBookingIds.has(booking._id.toString()) && effectiveNet > 0) {
      heldAmount = asMoney(heldAmount + effectiveNet);
      heldBookingIds.push(booking._id);
    }
  }

  const paidOut = asMoney(paidAgg[0]?.total || 0);
  const allocated = asMoney(allocatedAgg[0]?.total || 0);
  const available = asMoney(
    Math.max(net + tips - heldAmount - paidOut - allocated - adjustments, 0)
  );

  return {
    commissionRate: rate,
    gross,
    commission,
    net,
    tips,
    heldAmount,
    heldBookingIds,
    paidOut,
    allocated,
    adjustments,
    available,
    jobsCompleted: bookings.length,
  };
};

// Refund ke baad provider earning ka reversal: payout me booking
// shamil ho chuki ho (paid/processing) to "adjusted" (agle payout se
// katauti), warna "reversed" (available se hi kam). Raqam booking ki
// net earning ka wohi hissa jo refund ka hai (partial par proportional).
export const applyEarningReversal = async (refund) => {
  if (!refund?.booking) return refund;
  if (refund.earningReversal?.status && refund.earningReversal.status !== "none") {
    return refund;
  }
  const booking = await Booking.findById(refund.booking)
    .select("finalPrice price providerNetAmount")
    .lean();
  if (!booking) return refund;
  const gross = asMoney(booking.finalPrice || booking.price || 0);
  if (!gross || !refund.amount) return refund;
  const rate = await getCurrentCommissionRate();
  const net = bookingNetAmount(booking, rate);
  const reversalAmount = asMoney(net * Math.min(refund.amount / gross, 1));
  const covered = await Payout.exists({
    bookingIds: refund.booking,
    status: { $in: ["paid", "processing"] },
  });
  refund.earningReversal = {
    status: covered ? "adjusted" : "reversed",
    amount: reversalAmount,
  };
  await refund.save();
  return refund;
};

// Booking ka purana `refund` summary (Bookings panel wahi parhta hai)
// naye Refund ledger se dobara banana — hamesha ledger hi sach hai.
export const syncBookingRefundSummary = async (bookingId, byUserId = null) => {
  const oid = new mongoose.Types.ObjectId(bookingId);
  const [agg, latest, booking] = await Promise.all([
    Refund.aggregate([
      { $match: { booking: oid, status: "refunded" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Refund.findOne({ booking: oid, status: "refunded" })
      .sort({ refundedAt: -1, createdAt: -1 })
      .lean(),
    Booking.findById(bookingId),
  ]);
  if (!booking) return;
  if (!latest) {
    booking.refund = {
      status: "none",
      amount: 0,
      refundId: "",
      reason: "",
      at: null,
      by: null,
    };
  } else {
    booking.refund = {
      status: "refunded",
      amount: asMoney(agg[0]?.total || 0),
      refundId: latest.stripeRefundId || "",
      reason: latest.reason || "",
      at: latest.refundedAt || latest.updatedAt || null,
      by: byUserId || latest.decidedBy || null,
    };
  }
  await booking.save();
};

// Ek provider ki woh completed bookings jin ki earning abhi tak
// kisi payout me nahi gayi — payout banate waqt bookingIds isi se
// bhare jate hain. Dispute wali "held" nishan ke sath ati hain
// (un ki raqam available me shamil nahi hoti).
export const getUnpaidBookingEarnings = async (providerId) => {
  const rate = await getCurrentCommissionRate();
  const providerObjectId = new mongoose.Types.ObjectId(providerId);
  const [bookings, payouts, refunds, openDisputes] = await Promise.all([
    Booking.find({ provider: providerObjectId, status: "completed" })
      .select("_id finalPrice price providerNetAmount completedAt")
      .sort({ completedAt: 1 })
      .lean(),
    Payout.find({
      provider: providerObjectId,
      status: { $in: ["pending", "processing", "paid"] },
      source: { $ne: "bonus" },
    })
      .select("bookingIds")
      .lean(),
    Refund.find({
      provider: providerObjectId,
      status: "refunded",
      "earningReversal.status": "reversed",
    })
      .select("booking earningReversal")
      .lean(),
    SupportTicket.find({
      type: "dispute",
      status: { $in: ["open", "in_progress"] },
      booking: { $ne: null },
    })
      .select("booking")
      .lean(),
  ]);

  const covered = new Set();
  for (const payout of payouts) {
    for (const id of payout.bookingIds || []) covered.add(id.toString());
  }
  const reversedByBooking = new Map();
  for (const refund of refunds) {
    const key = refund.booking?.toString();
    if (key) {
      reversedByBooking.set(
        key,
        asMoney(
          (reversedByBooking.get(key) || 0) +
            asMoney(refund.earningReversal?.amount || 0)
        )
      );
    }
  }
  const disputed = new Set(
    openDisputes.map((ticket) => ticket.booking?.toString()).filter(Boolean)
  );

  return bookings
    .filter((booking) => !covered.has(booking._id.toString()))
    .map((booking) => {
      const net = bookingNetAmount(booking, rate);
      const reversed = reversedByBooking.get(booking._id.toString()) || 0;
      return {
        bookingId: booking._id,
        gross: asMoney(booking.finalPrice || booking.price || 0),
        net: asMoney(Math.max(net - reversed, 0)),
        held: disputed.has(booking._id.toString()),
        completedAt: booking.completedAt,
      };
    })
    .filter((row) => row.net > 0);
};
