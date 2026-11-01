import Stripe from "stripe";
import { Booking } from "../model/booking.model.js";
import { Notification } from "../model/notification.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import { Refund } from "../model/refund.model.js";
import { Wallet } from "../model/wallet.model.js";
import { WalletTransaction } from "../model/walletTransaction.model.js";
import { notifyUser } from "./fcm.util.js";
import {
  applyEarningReversal,
  syncBookingRefundSummary,
} from "./money.util.js";

// ─── Book for Later — usool (document D-L1..D-L7) ───────────────
export const LATER_MIN_ADVANCE_MIN = 120; // kam az kam 2 ghante aage
export const LATER_MAX_ADVANCE_DAYS = 30; // zyada se zyada 30 din
export const LATER_PAYMENT_DEADLINE_MIN = 60; // accept ke baad pay ki muddat
export const LATER_RESPONSE_CUTOFF_MIN = 90; // provider jawab ki aakhri hadd
export const LATER_FREE_CANCEL_MIN = 60; // is se andar app-cancel band
export const LATER_SLOT_STEP_MIN = 30;
export const LATER_DEFAULT_DURATION_MIN = 60;

const ACTIVE_STATUSES = ["pending", "accepted", "arrived", "ongoing"];
const WEEKDAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const asMoney = (value) =>
  Math.round((Number(value) || 0) * 100) / 100;

let stripeClient = null;
const getStripe = () => {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });
  }
  return stripeClient;
};

// ─── Europe/London waqt ka hisaab ───────────────────────────────
const londonParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return map;
};

export const formatLondonDateTime = (date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(date));

// Kisi London calendar date (YYYY-MM-DD) ka UTC din ka daira.
export const londonDayRangeUtc = (dateStr) => {
  const middayUtc = Date.parse(`${dateStr}T12:00:00Z`);
  const parts = londonParts(new Date(middayUtc));
  const londonAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute)
  );
  const offsetMs = londonAsUtc - middayUtc;
  const startUtc = Date.parse(`${dateStr}T00:00:00Z`) - offsetMs;
  return { startUtc, endUtc: startUtc + 24 * 60 * 60 * 1000, offsetMs };
};

const timeToMinutes = (value, fallback) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.test(value || "")
    ? value
    : fallback;
  const [h, m] = match.split(":").map(Number);
  return h * 60 + m;
};

// Provider ka us din ka schedule (mode "always" = default window).
export const scheduleForDate = (provider, dateStr) => {
  const weekdayIndex = new Date(
    Date.parse(`${dateStr}T12:00:00Z`)
  ).getUTCDay();
  const weekdayKey = WEEKDAY_KEYS[weekdayIndex];
  const availability = provider?.availability;
  if (!availability || availability.mode !== "schedule") {
    return { enabled: true, startTime: "08:00", endTime: "17:30", weekdayKey };
  }
  const day = availability.days?.[weekdayKey];
  if (!day) {
    return { enabled: false, startTime: "08:00", endTime: "17:30", weekdayKey };
  }
  return {
    enabled: day.enabled !== false,
    startTime: day.startTime || "08:00",
    endTime: day.endTime || "17:30",
    weekdayKey,
  };
};

// Kya diya gaya lamha provider ke schedule ke andar hai (London)?
export const isWithinScheduleLondon = (provider, date) => {
  const parts = londonParts(date);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const schedule = scheduleForDate(provider, dateStr);
  if (!schedule.enabled) return false;
  const minutes =
    (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const startMin = timeToMinutes(schedule.startTime, "08:00");
  const endMin = timeToMinutes(schedule.endTime, "17:30");
  // System ka mojooda usool (availability.util): shuru aur aakhir
  // barabar hon to provider pura din available hai; aakhir pehle
  // ho to waqt aadhi raat se aage jata hai (overnight).
  if (startMin === endMin) return true;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
};

// Service ki muddat — durationMinutes ho to wohi, warna type ke
// hisaab se andaza (basic 30, standard 45, premium 60).
export const serviceDurationMin = (service) => {
  const direct = Number(service?.durationMinutes);
  if (Number.isFinite(direct) && direct > 0) return direct;
  switch (service?.serviceType) {
    case "basic":
      return 30;
    case "standard":
      return 45;
    case "premium":
      return 60;
    default:
      return LATER_DEFAULT_DURATION_MIN;
  }
};

const fetchDayBookings = async (providerId, dateStr) => {
  const { startUtc, endUtc } = londonDayRangeUtc(dateStr);
  return Booking.find({
    provider: providerId,
    bookingDate: { $gte: new Date(startUtc), $lt: new Date(endUtc) },
    status: { $in: ACTIVE_STATUSES },
  })
    .populate("service", "serviceType durationMinutes")
    .select("bookingDate service status")
    .lean();
};

const overlaps = (aStart, aEnd, bStart, bEnd) =>
  aStart < bEnd && bStart < aEnd;

// Ek waqt par naya slot kisi mojooda booking se takrata hai?
export const hasSlotConflict = async (providerId, startDate, durationMin) => {
  const parts = londonParts(startDate);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const bookings = await fetchDayBookings(providerId, dateStr);
  const start = new Date(startDate).getTime();
  const end = start + durationMin * 60000;
  return bookings.some((booking) => {
    const bStart = new Date(booking.bookingDate).getTime();
    const bEnd = bStart + serviceDurationMin(booking.service) * 60000;
    return overlaps(start, end, bStart, bEnd);
  });
};

// Us din ki kul active bookings (daily limit ke liye).
export const countDayBookings = async (providerId, dateStr) => {
  const { startUtc, endUtc } = londonDayRangeUtc(dateStr);
  return Booking.countDocuments({
    provider: providerId,
    bookingDate: { $gte: new Date(startUtc), $lt: new Date(endUtc) },
    status: { $in: ACTIVE_STATUSES },
  });
};

// Rozana hadd: provider ka override ho to woh, warna platform setting.
export const dailyBookingCap = async (provider) => {
  const override = Number(provider?.dailyWashLimitOverride);
  if (Number.isFinite(override) && override > 0) return override;
  const settings = await PlatformSetting.findOne().lean();
  const value = Number(settings?.dailyWashLimitMax);
  return Number.isFinite(value) && value > 0 ? value : 7;
};

// Ek din ke slots — date/time page ke liye.
export const computeSlotsForDate = async (provider, dateStr, durationMin) => {
  const schedule = scheduleForDate(provider, dateStr);
  if (!schedule.enabled) {
    return {
      date: dateStr,
      closed: true,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      slots: [],
    };
  }
  const { offsetMs } = londonDayRangeUtc(dateStr);
  const startMin = timeToMinutes(schedule.startTime, "08:00");
  const endMin = timeToMinutes(schedule.endTime, "17:30");
  // Waqt ke hisay: barabar shuru/aakhir = pura din (12 AM–12 AM
  // wali setting); aakhir pehle ho to overnight (aadhi raat tak +
  // aadhi raat ke baad wala hissa usi din ki list me).
  const segments =
    startMin === endMin
      ? [[0, 24 * 60]]
      : endMin > startMin
        ? [[startMin, endMin]]
        : [
            [startMin, 24 * 60],
            [0, endMin],
          ];
  const bookings = await fetchDayBookings(provider._id, dateStr);
  const busy = bookings.map((booking) => {
    const bStart = new Date(booking.bookingDate).getTime();
    return {
      start: bStart,
      end: bStart + serviceDurationMin(booking.service) * 60000,
    };
  });
  const now = Date.now();
  const slots = [];
  for (const [segStart, segEnd] of segments) {
    for (
      let minute = segStart;
      minute + durationMin <= segEnd;
      minute += LATER_SLOT_STEP_MIN
    ) {
      const hh = String(Math.floor(minute / 60)).padStart(2, "0");
      const mm = String(minute % 60).padStart(2, "0");
      const startUtc = Date.parse(`${dateStr}T${hh}:${mm}:00Z`) - offsetMs;
      const endUtc = startUtc + durationMin * 60000;
      const taken = busy.some((slot) =>
        overlaps(startUtc, endUtc, slot.start, slot.end)
      );
      slots.push({
        start: new Date(startUtc).toISOString(),
        end: new Date(endUtc).toISOString(),
        label: `${hh}:${mm}`,
        available: startUtc > now && !taken,
      });
    }
  }
  slots.sort((a, b) => a.start.localeCompare(b.start));
  return {
    date: dateStr,
    closed: false,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    slots,
  };
};

// Provider ne later booking accept ki — payment deadline bandhna
// aur customer ko Pay Now ki اطلاع. Booking doc save bhi yahi
// hota hai (deadline ke sath).
export const applyLaterAcceptance = async (booking) => {
  const scheduledAt = new Date(
    booking.scheduledAt || booking.bookingDate
  ).getTime();
  const deadline = Math.min(
    Date.now() + LATER_PAYMENT_DEADLINE_MIN * 60000,
    scheduledAt - LATER_FREE_CANCEL_MIN * 60000
  );
  booking.paymentDeadline = new Date(deadline);
  await booking.save();
  notifyUser(booking.user.toString(), {
    title: "Booking accepted — please complete payment",
    body: `Your scheduled wash on ${formatLondonDateTime(scheduledAt)} was accepted. Please pay by ${formatLondonDateTime(deadline)} to confirm it.`,
    data: {
      type: "later_booking_accepted",
      bookingId: booking._id.toString(),
    },
  });
  return booking.paymentDeadline;
};

// Paid later booking ka MUKAMMAL refund — asal raaste par (wallet
// hissa foran, card hissa Stripe se). Admin ke executeRefund wala
// hi tareeqa hai taake ledger hamesha ek jaisa rahe. Booking
// complete nahi hui hoti, is liye earning reversal ka sawal nahi
// (phir bhi helper mehfooz tor par chalaya jata hai).
export const refundLaterBookingInFull = async (
  booking,
  { reason, initiatedBy, decidedBy } = {}
) => {
  if (booking.payment?.status !== "paid") return null;
  const existing = await Refund.findOne({
    booking: booking._id,
    status: "refunded",
  }).lean();
  if (existing) return existing;

  const record = await paymentInfo
    .findOne({
      bookingId: booking._id,
      type: "booking",
      paymentStatus: "complete",
    })
    .sort({ createdAt: -1 });
  const amount = asMoney(
    record ? record.price : booking.finalPrice || booking.price || 0
  );
  if (!amount || amount <= 0) return null;

  const walletPaidTotal = record
    ? asMoney(record.walletAmount || 0)
    : asMoney(booking.payment?.walletAmount || 0);
  const walletPortion = Math.min(amount, walletPaidTotal);
  const cardPortion = asMoney(amount - walletPortion);

  const refund = await Refund.create({
    booking: booking._id,
    payment: record?._id || null,
    customer: booking.user,
    provider: booking.provider || null,
    amount,
    walletPortion,
    cardPortion,
    reasonCategory:
      initiatedBy === "provider" ? "provider_fault" : "customer_request",
    reason: reason || "Scheduled booking cancelled",
    source: initiatedBy === "provider" ? "admin" : "customer_request",
    status: "processing",
    decidedBy: decidedBy || null,
    decidedAt: new Date(),
  });

  if (cardPortion > 0) {
    const transactionId = record?.transactionId || booking.payment?.trxId;
    if (!transactionId || !String(transactionId).startsWith("pi_")) {
      refund.status = "failed";
      refund.failureReason = "No card payment found to refund.";
      await refund.save();
      return refund;
    }
    refund.stripePaymentIntentId = transactionId;
    const stripeRefund = await getStripe().refunds.create({
      payment_intent: transactionId,
      amount: Math.round(cardPortion * 100),
    });
    refund.stripeRefundId = stripeRefund.id;
  }

  if (walletPortion > 0) {
    const wallet = await Wallet.findOneAndUpdate(
      { user: booking.user },
      { $setOnInsert: { user: booking.user } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const credited = await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: walletPortion } },
      { new: true }
    );
    await WalletTransaction.create({
      wallet: wallet._id,
      user: booking.user,
      type: "refund_credit",
      amount: walletPortion,
      balanceAfter: credited.balance,
      booking: booking._id,
      refund: refund._id,
      status: "complete",
    });
  }

  refund.status = "refunded";
  refund.refundedAt = new Date();
  await refund.save();

  await applyEarningReversal(refund);
  await syncBookingRefundSummary(booking._id, decidedBy || null);

  try {
    const message = `A refund of £${amount.toFixed(2)} has been processed for your cancelled scheduled booking.`;
    await Notification.create({
      recipient: booking.user,
      type: "general",
      title: "Refund processed",
      message,
      sentBy: decidedBy || undefined,
      metadata: { bookingId: booking._id },
    });
    notifyUser(booking.user.toString(), {
      title: "Refund processed",
      body: message,
      data: { type: "booking_refunded", bookingId: booking._id.toString() },
    });
  } catch (e) {
    /* notifications best effort */
  }
  return refund;
};
