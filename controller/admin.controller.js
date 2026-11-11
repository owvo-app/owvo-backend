import httpStatus from "http-status";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import Stripe from "stripe";
import { User } from "../model/user.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import { createToken } from "../utils/authToken.js";
import { sendEmail } from "../utils/sendEmail.js";
import catchAsync from "../utils/catch.Async.js";
import { Booking } from "../model/booking.model.js";
import {
  applyCommissionSnapshot,
  applyEarningReversal,
  bookingNetAmount,
  computeProviderBalances,
  getCurrentCommissionRate,
  getUnpaidBookingEarnings,
  syncBookingRefundSummary,
} from "../utils/money.util.js";
import { attemptPayoutTransfer } from "../utils/payout.util.js";
import { Refund } from "../model/refund.model.js";
import { EarningAdjustment } from "../model/earningAdjustment.model.js";
import { Wallet } from "../model/wallet.model.js";
import { WalletTransaction } from "../model/walletTransaction.model.js";
import { TransactionNote } from "../model/transactionNote.model.js";
import { IssueReport } from "../model/issueReport.model.js";
import { ActivityLog } from "../model/activityLog.model.js";
import { Receipt } from "../model/receipt.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { Payout } from "../model/payout.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import { AdminWithdrawal } from "../model/adminWithdrawal.model.js";
import { Service } from "../model/service.model.js";
import { Rating } from "../model/rating.model.js";
import { UserRating } from "../model/userRating.model.js";
import ProviderAcceptance from "../model/providerAcceptance.model.js";
import { TrainingModule } from "../model/trainingModule.model.js";
import { Notification } from "../model/notification.model.js";
import { CustomerNote } from "../model/customerNote.model.js";
import { BookingNote } from "../model/bookingNote.model.js";
import { ChatMessage } from "../model/chatMessage.model.js";
import { SupportTicket } from "../model/supportTicket.model.js";
import { Addon } from "../model/addon.model.js";
import { Vehicle } from "../model/vehicle.model.js";
import { ProviderNote } from "../model/providerNote.model.js";
import { generateOTP, uploadOnCloudinary } from "../utils/common.Method.js";
import { emitToUser, broadcast } from "../socket/socket.js";
import { notifyUser } from "../utils/fcm.util.js";
import { refreshProviderBusyState } from "../utils/providerBusy.util.js";
import {
  emptyCompletedJobs,
  getProviderCompletedJobCounts,
  syncProviderCompletedJobs,
  syncProvidersCompletedJobs,
} from "../utils/completedJobs.util.js";
import { recordActivity } from "../utils/activityLog.util.js";
import {
  ensureDefaultServices,
  ensureProviderServices,
  syncProviderPreferredServices,
} from "../utils/defaultServices.util.js";

const DASHBOARD_ROLES = ["admin", "staff"];
const USER_ROLES = ["user", "admin", "provider", "staff"];
const BOOKING_STATUSES = [
  "pending",
  "accepted",
  "arrived",
  "ongoing",
  "completed",
  "cancelled",
];
const STAFF_BOOKING_STATUSES = ["accepted", "arrived", "ongoing", "completed", "cancelled"];

// Bookings redesign Step 1: admin status transitions sirf in raaston se ho
// sakti hain - baqi sab 400. Har tabdeeli statusHistory me bhi likhi jati hai.
const BOOKING_TRANSITIONS = {
  pending: ["accepted", "cancelled"],
  accepted: ["arrived", "cancelled"],
  arrived: ["ongoing", "cancelled"],
  ongoing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  declined: ["accepted", "cancelled"],
};

const ADMIN_BOOKING_STATUS_COPY = {
  accepted: {
    customerTitle: "Booking confirmed",
    customerBody: "Your booking has been confirmed by the OWVO team.",
    providerTitle: "Booking confirmed",
    providerBody: "A booking assigned to you has been confirmed.",
  },
  arrived: {
    customerTitle: "Provider arrived",
    customerBody: "Your provider has been marked as arrived for your booking.",
    providerTitle: "Marked as arrived",
    providerBody: "You have been marked as arrived for a booking.",
  },
  ongoing: {
    customerTitle: "Wash started",
    customerBody: "Your car wash is now in progress.",
    providerTitle: "Wash started",
    providerBody: "A booking has been marked as in progress.",
  },
  completed: {
    customerTitle: "Booking completed",
    customerBody:
      "Your booking has been marked as completed. Thank you for using OWVO.",
    providerTitle: "Booking completed",
    providerBody: "A booking has been marked as completed.",
  },
  cancelled: {
    customerTitle: "Booking cancelled",
    customerBody: "Your booking has been cancelled by the OWVO team.",
    providerTitle: "Booking cancelled",
    providerBody: "A booking assigned to you has been cancelled.",
  },
};

const startOfDay = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const startOfWeek = (date = new Date()) => {
  const value = startOfDay(date);
  const day = value.getDay();
  const diff = day === 0 ? 6 : day - 1;
  value.setDate(value.getDate() - diff);
  return value;
};

const startOfMonth = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const startOfYear = (date = new Date()) => new Date(date.getFullYear(), 0, 1);

const asMoney = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

const DATE_RANGE_VALUES = ["daily", "today", "weekly", "monthly", "yearly", "all", "all_time"];
const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads");
const IMAGE_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const resolveLocalUploadPath = (value = "") => {
  let pathname = String(value || "").trim();
  if (!pathname) return "";

  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // Keep plain relative and absolute paths as-is.
  }

  const relativePath = pathname.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relativePath.startsWith("uploads/")) return "";

  const filePath = path.resolve(process.cwd(), relativePath);
  if (!filePath.startsWith(`${UPLOADS_ROOT}${path.sep}`)) return "";
  return filePath;
};

const getStripe = () =>
  new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: process.env.STRIPE_API_VERSION || "2025-11-17.clover",
  });

const centsToMoney = (amount) => asMoney((Number(amount) || 0) / 100);

const getStripeBalanceSnapshot = async () => {
  const snapshot = {
    configured: Boolean(process.env.STRIPE_SECRET_KEY),
    available: 0,
    pending: 0,
    currency: "GBP",
    liveMode: null,
    error: "",
  };

  if (!snapshot.configured) {
    snapshot.error = "STRIPE_SECRET_KEY is not configured";
    return snapshot;
  }

  try {
    const balance = await getStripe().balance.retrieve();
    const preferredCurrency = "gbp";
    const available =
      balance.available.find((entry) => entry.currency === preferredCurrency) ||
      balance.available[0];
    const pending =
      balance.pending.find((entry) => entry.currency === preferredCurrency) ||
      balance.pending[0];

    snapshot.available = centsToMoney(available?.amount);
    snapshot.pending = centsToMoney(pending?.amount);
    snapshot.currency = (available?.currency || pending?.currency || "gbp").toUpperCase();
    snapshot.liveMode = Boolean(balance.livemode);
    return snapshot;
  } catch (error) {
    snapshot.error = error?.message || "Unable to fetch Stripe balance";
    return snapshot;
  }
};

const getDateRange = (query = {}) => {
  const now = new Date();
  const requested = query.range?.toString().toLowerCase();
  const range = DATE_RANGE_VALUES.includes(requested) ? requested : "weekly";

  if (range === "all" || range === "all_time") {
    return { range: "all", from: null, to: null };
  }

  const customFrom = query.from ? new Date(query.from) : null;
  const customTo = query.to ? new Date(query.to) : null;
  if (customFrom && !Number.isNaN(customFrom.getTime())) {
    const to = customTo && !Number.isNaN(customTo.getTime()) ? customTo : now;
    return { range, from: customFrom, to };
  }

  const starts = {
    daily: startOfDay(now),
    today: startOfDay(now),
    weekly: startOfWeek(now),
    monthly: startOfMonth(now),
    yearly: startOfYear(now),
  };

  return {
    range: range === "today" ? "daily" : range,
    from: starts[range] || startOfWeek(now),
    to: now,
  };
};

const dateFilter = (field, query) => {
  const range = getDateRange(query);
  if (!range.from && !range.to) return {};

  return {
    [field]: {
      ...(range.from ? { $gte: range.from } : {}),
      ...(range.to ? { $lte: range.to } : {}),
    },
  };
};

const mergeFilter = (base, field, query) => ({
  ...base,
  ...dateFilter(field, query),
});

const getRevenueGroupFormat = (range) => {
  if (range === "daily") return "%Y-%m-%dT%H:00:00.000Z";
  if (range === "yearly" || range === "all") return "%Y-%m";
  return "%Y-%m-%d";
};

const dashboardUserSelect =
  "-password -refreshToken -verificationInfo.token -bankDetails.accountNumber -bankDetails.sortCode";
const providerVerificationSelect =
  "-password -refreshToken -verificationInfo.token";
const maskSensitiveValue = (value, visible = 4) => {
  const raw = value?.toString?.().replace(/\s+/g, "") || "";
  if (!raw) return "";
  return `**** ${raw.slice(-visible)}`;
};

const maskProviderVerificationPayload = (provider) => {
  const data = provider?.toObject ? provider.toObject() : { ...(provider || {}) };

  if (data.bankDetails) {
    data.bankDetails = {
      ...data.bankDetails,
      accountNumber: maskSensitiveValue(data.bankDetails.accountNumber),
      sortCode: maskSensitiveValue(data.bankDetails.sortCode, 2),
    };
  }

  if (data.nationalInsuranceNumber) {
    data.nationalInsuranceNumber = maskSensitiveValue(data.nationalInsuranceNumber);
  }

  if (data.identityVerification?.documentNumber) {
    data.identityVerification = {
      ...data.identityVerification,
      documentNumber: maskSensitiveValue(data.identityVerification.documentNumber),
    };
  }

  if (data.stripeConnect?.accountId) {
    data.stripeConnect = {
      ...data.stripeConnect,
      accountId: maskSensitiveValue(data.stripeConnect.accountId),
    };
  }

  return data;
};

const REPORT_TYPES = ["general", "payment", "service_quality", "safety", "provider_conduct"];
const STAFF_MENUS = [
  "dashboard",
  "bookings",
  "washers",
  "customers",
  "provider-verification",
  "payouts-payments",
  "earnings",
  "reports",
  "data-requests",
  "staff-management",
  "notifications",
  "settings",
  "system-logs",
];

const globalServiceFilter = {
  $or: [{ provider: null }, { provider: { $exists: false } }],
};

const serviceEditableFields = [
  "serviceType",
  "title",
  "price",
  "carSize",
  "carName",
  "carModel",
  "description",
  "isActive",
];

const getPlatformSettingsDoc = async () =>
  PlatformSetting.findOneAndUpdate(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

const parseDailyWashLimitMax = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Daily wash limit must be a whole number between 1 and 50"
    );
  }
  return parsed;
};

const getPlatformDailyWashLimitMax = (settings) => {
  const value = Number(settings?.dailyWashLimitMax);
  return Number.isInteger(value) && value > 0 ? value : 7;
};

const getProviderDailyWashLimitMax = (provider, settings) => {
  const providerMax = Number(provider?.dailyWashLimitMax);
  if (Number.isInteger(providerMax) && providerMax > 0) return providerMax;
  return getPlatformDailyWashLimitMax(settings);
};

const buildProviderDailyWashLimitPayload = (provider, settings, completedToday = null) => {
  const providerMax = Number(provider?.dailyWashLimitMax);
  const platformMax = getPlatformDailyWashLimitMax(settings);
  const max = getProviderDailyWashLimitMax(provider, settings);

  return {
    remaining: Math.max(Number(provider?.dailyWashLimit) || 0, 0),
    max,
    customMax: Number.isInteger(providerMax) && providerMax > 0 ? providerMax : null,
    platformMax,
    completedToday,
  };
};

const syncProvidersUsingPlatformDailyWashLimit = async (settings) => {
  const platformMax = getPlatformDailyWashLimitMax(settings);
  const providers = await User.find({
    role: "provider",
    $or: [{ dailyWashLimitMax: { $exists: false } }, { dailyWashLimitMax: null }],
  });

  if (!providers.length) return 0;

  const counts = await getProviderCompletedJobCounts(providers.map((provider) => provider._id));

  await Promise.all(
    providers.map(async (provider) => {
      const completedToday = counts.get(provider._id.toString())?.today || 0;
      const remaining = Math.max(platformMax - completedToday, 0);
      const providerUpdates = { dailyWashLimit: remaining };
      if (remaining <= 0) {
        providerUpdates.isOnline = false;
        providerUpdates.isBusy = false;
      }
      Object.assign(provider, providerUpdates);

      await User.updateOne({ _id: provider._id }, { $set: providerUpdates });

      emitToUser(provider._id.toString(), "provider_daily_wash_limit_update", {
        providerId: provider._id.toString(),
        dailyWashLimit: buildProviderDailyWashLimitPayload(provider, settings, completedToday),
        message: "Your platform daily wash limit has been updated.",
      });
    })
  );

  return providers.length;
};
const bookingPopulate = [
  {
    path: "user",
    select:
      "_id name email phoneNumber photo location residentialAddress providerAddress customerRatingAverage customerRatingCount",
  },
  {
    path: "provider",
    select:
      "_id name email phoneNumber photo location providerAddress residentialAddress serviceArea isOnline isBusy adminVerification enforcement",
  },
  {
    path: "service",
    select: "_id title price serviceType carSize carName carModel",
  },
  {
    path: "vehicle",
    select: "registrationNo make model year size image isDefault",
  },
];

const buildBookingSocketPayload = (booking, extras = {}) => {
  const userId = booking.user?._id?.toString?.() || booking.user?.toString?.();
  const providerId =
    booking.provider?._id?.toString?.() || booking.provider?.toString?.();

  return {
    bookingId: booking._id?.toString(),
    status: booking.status,
    userId,
    providerId,
    serviceId: booking.service?._id?.toString?.() || booking.service?.toString?.(),
    price: booking.finalPrice,
    currency: booking.currency,
    arrivedAt: booking.arrivedAt,
    washEndsAt: booking.washEndsAt,
    updatedAt: booking.updatedAt,
    ...extras,
  };
};

const createReceiptForCompletedBooking = async (booking) => {
  if (booking.status !== "completed") return;

  const bookingUserId = booking.user?._id || booking.user;
  const bookingProviderId = booking.provider?._id || booking.provider;
  const serviceId = booking.service?._id || booking.service;
  const receiptNo = `RCPT-${booking._id.toString().slice(-6).toUpperCase()}`;

  await Receipt.findOneAndUpdate(
    { booking: booking._id },
    {
      booking: booking._id,
      user: bookingUserId,
      provider: bookingProviderId,
      service: serviceId,
      subtotal: booking.price,
      discount: booking.discountPrice || 0,
      tax: 0,
      total: booking.finalPrice,
      currency: booking.currency || "GBP",
      receiptNo,
      issuedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const emitDashboardBookingStatus = (booking, status, extras = {}) => {
  const payload = buildBookingSocketPayload(booking, extras);
  const userId = payload.userId;
  const providerId = payload.providerId;
  const statusMessages = {
    accepted: "Your booking has been accepted!",
    ongoing: "Your car wash has started!",
    completed: "Your car wash is complete! Please rate your experience.",
    cancelled: "Your booking has been cancelled.",
    arrived: "The user has arrived at the washer location.",
  };

  if (userId && statusMessages[status]) {
    emitToUser(userId, "booking_status_update", {
      ...payload,
      message: statusMessages[status],
    });
  }

  if (providerId) {
    emitToUser(providerId, "booking_status_update", {
      ...payload,
      message:
        status === "completed"
          ? "Booking marked as completed."
          : "Booking status was updated by OWVO operations.",
    });
  }

  broadcast("admin_booking_status_updated", payload);
};

export const getAdminMe = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(dashboardUserSelect).lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard account fetched successfully",
    data: user,
  });
});

export const updateAdminMe = catchAsync(async (req, res) => {
  const { name, email } = req.body || {};
  const user = await User.findById(req.user._id);

  if (!user || !DASHBOARD_ROLES.includes(user.role)) {
    throw new AppError(httpStatus.NOT_FOUND, "Dashboard account not found");
  }

  if (name !== undefined) {
    user.name = name.toString().trim();
  }

  if (email !== undefined) {
    const nextEmail = email.toString().trim().toLowerCase();
    if (!nextEmail) {
      throw new AppError(httpStatus.BAD_REQUEST, "Email is required");
    }

    const existing = await User.findOne({ email: nextEmail, _id: { $ne: user._id } });
    if (existing) {
      throw new AppError(httpStatus.CONFLICT, "Email already exists");
    }

    user.email = nextEmail;
  }

  await user.save();
  await recordActivity({
    req,
    action: "dashboard_account.updated",
    entityType: "user",
    entityId: user._id,
    metadata: { name: user.name, email: user.email },
  });

  const data = await User.findById(user._id).select(dashboardUserSelect).lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard account updated successfully",
    data,
  });
});

export const getDashboardOverview = catchAsync(async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const selectedRange = getDateRange(req.query);
  const completedDateFilter = dateFilter("completedAt", req.query);
  const bookingDateFilter = dateFilter("createdAt", req.query);
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;

  const [
    totalRevenueAgg,
    todayRevenueAgg,
    weekRevenueAgg,
    monthRevenueAgg,
    totalBookings,
    weekBookings,
    activeWashers,
    pendingReports,
    completedBookingsForPayout,
    totalCommissionAgg,
  ] = await Promise.all([
    Booking.aggregate([
      { $match: { status: "completed", ...completedDateFilter } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    Booking.aggregate([
      { $match: { status: "completed", completedAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    Booking.aggregate([
      { $match: { status: "completed", completedAt: { $gte: weekStart } } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    Booking.aggregate([
      { $match: { status: "completed", completedAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    Booking.countDocuments(bookingDateFilter),
    Booking.countDocuments({ createdAt: { $gte: weekStart } }),
    User.countDocuments({ role: "provider", isOnline: true }),
    IssueReport.countDocuments({
      status: { $in: ["open", "reviewing"] },
      ...dateFilter("createdAt", req.query),
    }),
    Booking.find({ status: "completed", ...completedDateFilter }).select("finalPrice").lean(),
    Booking.aggregate([
      { $match: { status: "completed", ...completedDateFilter } },
      {
        $group: {
          _id: null,
          total: { $sum: {
              $ifNull: [
                "$commissionAmount",
                {
                  $multiply: [
                    "$finalPrice",
                    { $ifNull: ["$commissionRate", commissionRate] },
                  ],
                },
              ],
            } },
        },
      },
    ]),
  ]);

  const totalRevenue = asMoney(totalRevenueAgg[0]?.total);
  const todayRevenue = asMoney(todayRevenueAgg[0]?.total);
  const weekRevenue = asMoney(weekRevenueAgg[0]?.total);
  const monthRevenue = asMoney(monthRevenueAgg[0]?.total);
  // Pending payouts = is waqt asal payable (money.util ka unified
  // hisaab) — date range ka asar nahi, jo payout ho chuka woh
  // ghata hua. Providers page wale number se hamesha mile ga.
  const payoutProviderIds = await Booking.distinct("provider", {
    status: "completed",
  });
  let pendingPayoutAmount = 0;
  let pendingPayoutProviders = 0;
  for (const pid of payoutProviderIds) {
    if (!pid) continue;
    const balances = await computeProviderBalances(pid);
    if (balances.available > 0) {
      pendingPayoutAmount = asMoney(pendingPayoutAmount + balances.available);
      pendingPayoutProviders += 1;
    }
  }
  // Platform balance = har booking ki ASAL (snapshot) commission ka
  // jama — kul revenue x aaj ka rate nahi, warna rate badalne se
  // purani kamai bhi badli hui nazar ayegi.
  const platformBalance = asMoney(totalCommissionAgg[0]?.total || 0);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard overview fetched successfully",
    data: {
      totalRevenue,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      totalBookings,
      weekBookings,
      activeWashers,
      pendingReports,
      pendingPayouts: {
        amount: pendingPayoutAmount,
        count: pendingPayoutProviders,
      },
      platformBalance,
      commissionRate,
      range: selectedRange.range,
    },
  });
});

export const getDashboardRevenue = catchAsync(async (req, res) => {
  const selectedRange = getDateRange(req.query);
  const range = selectedRange.range;
  const groupFormat = getRevenueGroupFormat(range);

  const rows = await Booking.aggregate([
    { $match: { status: "completed", ...dateFilter("completedAt", req.query) } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: groupFormat,
            date: "$completedAt",
          },
        },
        revenue: { $sum: "$finalPrice" },
        bookings: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard revenue fetched successfully",
    data: rows.map((row) => ({
      date: row._id,
      label: row._id,
      revenue: asMoney(row.revenue),
      bookings: row.bookings,
    })),
  });
});

export const getRecentBookings = catchAsync(async (req, res) => {
  const bookings = await Booking.find(dateFilter("createdAt", req.query))
    .populate(bookingPopulate)
    .sort({ createdAt: -1 })
    .limit(Number(req.query.limit) || 6);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Recent bookings fetched successfully",
    data: bookings,
  });
});

export const getUpcomingBookings = catchAsync(async (req, res) => {
  const bookings = await Booking.find({
    ...(Object.keys(dateFilter("bookingDate", req.query)).length
      ? dateFilter("bookingDate", req.query)
      : { bookingDate: { $gte: new Date() } }),
    status: { $in: ["pending", "accepted", "arrived", "ongoing"] },
  })
    .populate(bookingPopulate)
    .sort({ bookingDate: 1 })
    .limit(Number(req.query.limit) || 6);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Upcoming bookings fetched successfully",
    data: bookings,
  });
});

/**
 * GET /api/v1/admin/tracking/live
 * Live Tracking page ke liye real-time data: stats, active bookings
 * (washer driveway + customer live location + ETA), provider status,
 * top areas, recent activity.
 */
export const getTrackingLive = catchAsync(async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const travellingSince = new Date(now.getTime() - 15 * 60 * 1000); // 15 min
  const ACTIVE_STATUSES = ["accepted", "arrived", "ongoing"];

  const [
    activeBookings,
    washersOnline,
    totalProviders,
    inProgress,
    completedToday,
    providersWithActiveBooking,
  ] = await Promise.all([
    Booking.find({ status: { $in: ACTIVE_STATUSES } })
      .populate("provider", "_id name phoneNumber isOnline location serviceLocationAddress")
      .populate("user", "_id name")
      .populate("service", "_id title")
      .sort({ createdAt: -1 })
      .lean(),
    User.countDocuments({ role: "provider", isOnline: true }),
    User.countDocuments({ role: "provider" }),
    Booking.countDocuments({ status: "ongoing" }),
    Booking.countDocuments({
      status: "completed",
      completedAt: { $gte: todayStart },
    }),
    Booking.distinct("provider", { status: { $in: ACTIVE_STATUSES } }),
  ]);

  const busyProviderIds = new Set(providersWithActiveBooking.map(String));

  // Customers travelling — fresh live location + abhi pahunche nahi
  // (accepted = raste me, ongoing = wash shuru lekin location fresh = abhi safar me)
  const customersTravelling = activeBookings.filter(
    (b) =>
      (b.status === "accepted" || b.status === "ongoing") &&
      b.customerLocation?.latitude != null &&
      b.customerLocation?.updatedAt &&
      new Date(b.customerLocation.updatedAt) >= travellingSince
  ).length;

  const bookings = activeBookings.map((b) => {
    const p = b.provider || {};
    const coords = p.location?.coordinates; // GeoJSON: [lng, lat]
    const providerId = String(p._id || b.provider);
    return {
      id: b._id.toString(),
      status: b.status,
      service: b.service?.title || "Wash",
      price: b.finalPrice,
      // Washer — FIXED driveway (client: washer live movement track nahi karni)
      washerName: p.name || "—",
      washerPhone: p.phoneNumber || "",
      washerStatus: !p.isOnline
        ? "offline"
        : busyProviderIds.has(providerId)
          ? "busy"
          : "online",
      drivewayLat: Array.isArray(coords) ? coords[1] : null,
      drivewayLng: Array.isArray(coords) ? coords[0] : null,
      drivewayAddress: [
        p.serviceLocationAddress?.streetAddress,
        p.serviceLocationAddress?.city,
        p.serviceLocationAddress?.postcode,
      ]
        .filter(Boolean)
        .join(", "),
      // Customer — LIVE location (travelling)
      customerName: b.user?.name || "—",
      customerLat: b.customerLocation?.latitude ?? null,
      customerLng: b.customerLocation?.longitude ?? null,
      customerLocationUpdatedAt: b.customerLocation?.updatedAt || null,
      etaMinutes: b.customerEtaMinutes ?? null,
      distanceMiles: b.customerDistanceMiles ?? null,
      address: b.address?.addressLine || "",
      startedAt: b.createdAt,
    };
  });

  const online = washersOnline;
  const busy = providersWithActiveBooking.length;
  const offline = Math.max(totalProviders - online, 0);

  // Top areas — aaj ki bookings, postalCode area se group
  const todayBookings = await Booking.find({ createdAt: { $gte: todayStart } })
    .select("postalCode")
    .lean();
  const areaCounts = {};
  for (const b of todayBookings) {
    const area = String(b.postalCode || "").split(" ")[0].toUpperCase() || "Unknown";
    areaCounts[area] = (areaCounts[area] || 0) + 1;
  }
  const topAreas = Object.entries(areaCounts)
    .map(([name, bookingsCount]) => ({ name, bookings: bookingsCount }))
    .sort((a, b) => b.bookings - a.bookings)
    .slice(0, 5);

  // Recent activity
  const logs = await ActivityLog.find()
    .sort({ createdAt: -1 })
    .limit(8)
    .select("action createdAt")
    .lean();
  const colorFor = (action = "") => {
    const a = action.toLowerCase();
    if (a.includes("complet") || a.includes("accept") || a.includes("online"))
      return "green";
    if (a.includes("book") || a.includes("payment")) return "blue";
    return "red";
  };
  const recentActivity = logs.map((l) => ({
    time: new Date(l.createdAt).toTimeString().slice(0, 5),
    text: l.action,
    color: colorFor(l.action),
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Live tracking data fetched successfully",
    data: {
      stats: {
        activeBookings: activeBookings.length,
        washersOnline: online,
        inProgress,
        completedToday,
        customersTravelling,
      },
      bookings,
      providerStatus: { total: totalProviders, online, busy, offline },
      topAreas,
      recentActivity,
    },
  });
});

/**
 * GET /api/v1/admin/tracking/booking-stats?range=today|week|month
 * Booking Statistics (hourly/daily buckets) + Top Areas — range filter ke sath.
 */
export const getTrackingBookingStats = catchAsync(async (req, res) => {
  const range = ["today", "week", "month"].includes(req.query.range)
    ? req.query.range
    : "today";
  const now = new Date();

  let start;
  let bucketCount;
  let bucketLabel;
  if (range === "today") {
    start = startOfDay(now);
    bucketCount = 24;
    bucketLabel = (i) => `${i}`;
  } else if (range === "week") {
    start = startOfWeek(now);
    bucketCount = 7;
    bucketLabel = (i) =>
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i];
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    bucketCount = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    bucketLabel = (i) => `${i + 1}`;
  }

  const bookings = await Booking.find({ createdAt: { $gte: start } })
    .select("status createdAt postalCode")
    .lean();

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    label: bucketLabel(i),
    completed: 0,
    active: 0,
    cancelled: 0,
  }));

  const areaCounts = {};
  for (const b of bookings) {
    const d = new Date(b.createdAt);
    let idx;
    if (range === "today") {
      idx = d.getHours();
    } else if (range === "week") {
      idx = (d.getDay() + 6) % 7; // Mon=0
    } else {
      idx = d.getDate() - 1;
    }
    if (idx >= 0 && idx < bucketCount) {
      if (b.status === "completed") buckets[idx].completed++;
      else if (b.status === "cancelled") buckets[idx].cancelled++;
      else buckets[idx].active++;
    }
    const area =
      String(b.postalCode || "").split(" ")[0].toUpperCase() || "Unknown";
    areaCounts[area] = (areaCounts[area] || 0) + 1;
  }

  const topAreas = Object.entries(areaCounts)
    .map(([name, bookingsCount]) => ({ name, bookings: bookingsCount }))
    .sort((a, b) => b.bookings - a.bookings)
    .slice(0, 5);

  // Today range me khali hours chhupao (6-22 jaisa) — sirf jab data ho
  const filtered =
    range === "today" && bookings.length > 0
      ? buckets.filter(
          (bk, i) =>
            i >= 6 && i <= 22 && (bk.completed + bk.active + bk.cancelled > 0 || (i % 2 === 0))
        )
      : buckets;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Tracking booking stats fetched successfully",
    data: { range, buckets: filtered.length ? filtered : buckets, topAreas },
  });
});

export const getAllUsers = catchAsync(async (req, res) => {
  const users = await User.find().select(
    dashboardUserSelect
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All users fetched successfully",
    data: users,
  });
});

export const getAllProviders = catchAsync(async (req, res) => {
  // Default to "all" when no range specified - this is a management list
  const queryWithDefaultRange = { ...req.query, range: req.query.range || "all" };
  await User.updateMany(
    {
      role: "provider",
      isOnline: true,
      $or: [
        { "adminVerification.status": { $ne: "approved" } },
        { "enforcement.status": { $in: ["suspended", "banned"] } },
      ],
    },
    { $set: { isOnline: false, isBusy: false } }
  );

  const providers = await User.find(mergeFilter({ role: "provider", isDeleted: { $ne: true } }, "createdAt", queryWithDefaultRange))
    .select(dashboardUserSelect)
    .populate("preferredServices", "title price isActive")
    .sort({ createdAt: -1 })
    .lean();
  const providerIds = providers.map((provider) => provider._id).filter(Boolean);
  const [ratingStats, completedJobsByProviderId] = await Promise.all([
    Rating.aggregate([
      { $match: { provider: { $in: providerIds } } },
      {
        $group: {
          _id: "$provider",
          averageRating: { $avg: "$rating" },
          totalRatings: { $sum: 1 },
        },
      },
    ]),
    syncProvidersCompletedJobs(providerIds),
  ]);
  const ratingsByProviderId = new Map(
    ratingStats.map((stat) => [
      stat._id.toString(),
      {
        customerRatingAverage: Number((stat.averageRating || 0).toFixed(1)),
        customerRatingCount: stat.totalRatings || 0,
      },
    ])
  );
  const data = providers.map((provider) => ({
    ...provider,
    ...ratingsByProviderId.get(provider._id.toString()),
    completedJobs:
      completedJobsByProviderId.get(provider._id.toString()) || emptyCompletedJobs(),
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All providers fetched successfully",
    data,
  });
});

export const changeUserRole = catchAsync(async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  if (!USER_ROLES.includes(role)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid role");
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  user.role = role;
  await user.save();
  await recordActivity({
    req,
    action: "user.role_changed",
    entityType: "user",
    entityId: user._id,
    metadata: { role },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User role updated successfully",
    data: user,
  });
});

export const deleteUser = catchAsync(async (req, res) => {
  const { userId } = req.params;

  const user = await User.findByIdAndDelete(userId);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  await recordActivity({
    req,
    action: "user.deleted",
    entityType: "user",
    entityId: user._id,
    metadata: { email: user.email, role: user.role },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User deleted successfully",
  });
});

export const getAllCustomers = catchAsync(async (req, res) => {
  const customers = await User.find(mergeFilter({ role: "user", isDeleted: { $ne: true } }, "createdAt", req.query))
    .select(dashboardUserSelect)
    .sort({
      createdAt: -1,
    })
    .lean();
  const customerIds = customers.map((customer) => customer._id).filter(Boolean);
  const [ratingStats, recentReviews, bookingTotals] = await Promise.all([
    UserRating.aggregate([
      { $match: { user: { $in: customerIds } } },
      {
        $group: {
          _id: "$user",
          averageRating: { $avg: "$rating" },
          totalRatings: { $sum: 1 },
        },
      },
    ]),
    UserRating.find({ user: { $in: customerIds } })
      .select("user provider booking rating review createdAt")
      .populate("provider", "_id name email photo")
      .sort({ createdAt: -1 })
      .lean(),
    Booking.aggregate([
      { $match: { user: { $in: customerIds } } },
      {
        $group: {
          _id: "$user",
          totalBookings: { $sum: 1 },
          totalSpent: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, "$finalPrice", 0],
            },
          },
        },
      },
    ]),
  ]);
  const ratingsByCustomerId = new Map(
    ratingStats.map((stat) => [
      stat._id.toString(),
      {
        customerRatingAverage: Number((stat.averageRating || 0).toFixed(1)),
        customerRatingCount: stat.totalRatings || 0,
      },
    ])
  );
  const reviewsByCustomerId = new Map();
  recentReviews.forEach((review) => {
    const customerId = review.user?.toString();
    if (!customerId) return;
    const bucket = reviewsByCustomerId.get(customerId) || [];
    if (bucket.length < 3) {
      bucket.push({
        _id: review._id,
        rating: review.rating,
        review: review.review || "",
        createdAt: review.createdAt,
        provider: review.provider,
      });
    }
    reviewsByCustomerId.set(customerId, bucket);
  });
  const totalsByCustomerId = new Map(
    bookingTotals.map((row) => [
      row._id.toString(),
      {
        totalBookings: row.totalBookings || 0,
        totalSpent: Math.round((row.totalSpent || 0) * 100) / 100,
      },
    ])
  );
  const data = customers.map((customer) => ({
    ...customer,
    ...ratingsByCustomerId.get(customer._id.toString()),
    ...(totalsByCustomerId.get(customer._id.toString()) || {
      totalBookings: 0,
      totalSpent: 0,
    }),
    recentReviews: reviewsByCustomerId.get(customer._id.toString()) || [],
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All customers fetched successfully",
    data,
  });
});

export const createAdminBooking = catchAsync(async (req, res) => {
  const {
    customerId,
    providerId,
    serviceId,
    vehicleId,
    addonIds,
    bookingDate,
    address,
    notes,
  } = req.body;

  if (!customerId || !providerId || !serviceId || !bookingDate || !address) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Missing required fields: customerId, providerId, serviceId, bookingDate, address"
    );
  }

  // NOTE: customer ki role "user" hai (User model enum) — purana code
  // "customer" check karta tha jo hamesha fail hota tha.
  const customer = await User.findById(customerId);
  if (!customer || customer.role !== "user") {
    throw new AppError(httpStatus.NOT_FOUND, "Customer not found");
  }

  const provider = await User.findById(providerId);
  if (!provider || provider.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  const service = await Service.findOne({ _id: serviceId, isActive: true })
    .select("_id title price serviceType")
    .lean();
  if (!service) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "Service not found or inactive"
    );
  }

  // Address: naya form object bhejta hai (Google Places se lat/lng ke sath);
  // purani string shakal bhi qabool hai (coords 0 rahenge, map hide hoga).
  const addressObj =
    typeof address === "string"
      ? { addressLine: address.trim(), latitude: 0, longitude: 0 }
      : {
          addressLine: String(address.addressLine || "").trim(),
          latitude: Number(address.latitude) || 0,
          longitude: Number(address.longitude) || 0,
        };
  if (!addressObj.addressLine) {
    throw new AppError(httpStatus.BAD_REQUEST, "Address is required");
  }
  const postcodeMatch = addressObj.addressLine.match(
    /[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/
  );
  const postalCode = postcodeMatch
    ? postcodeMatch[0].toUpperCase()
    : undefined;

  // Vehicle (optional): sirf customer ka apna vehicle snapshot banega.
  let vehicleDoc = null;
  let vehicleSnapshot;
  if (vehicleId) {
    vehicleDoc = await Vehicle.findOne({
      _id: vehicleId,
      user: customerId,
    }).lean();
    if (!vehicleDoc) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Selected vehicle was not found for this customer"
      );
    }
    vehicleSnapshot = {
      registrationNo: vehicleDoc.registrationNo || "",
      make: vehicleDoc.make || "",
      model: vehicleDoc.model || "",
      year: vehicleDoc.year || null,
      size: vehicleDoc.size || "",
      image:
        typeof vehicleDoc.image === "string"
          ? vehicleDoc.image
          : vehicleDoc.image?.url || "",
    };
  }

  // Add-ons: keemat hamesha server catalog se — client ki bheji hui price
  // par kabhi bharosa nahi.
  let addons = [];
  if (Array.isArray(addonIds) && addonIds.length) {
    const addonDocs = await Addon.find({
      _id: { $in: addonIds },
      isActive: true,
    })
      .select("_id name price")
      .lean();
    addons = addonDocs.map((a) => ({
      addon: a._id,
      name: a.name,
      price: Number(a.price) || 0,
    }));
  }
  const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);
  const price = (Number(service.price) || 0) + addonsTotal;

  const booking = await Booking.create({
    user: customerId,
    provider: providerId,
    service: serviceId,
    // Commission rate booking ke banne par fix (customer flow jaisa).
    commissionRate: await getCurrentCommissionRate(),
    ...(vehicleDoc ? { vehicle: vehicleDoc._id } : {}),
    ...(vehicleSnapshot ? { vehicleSnapshot } : {}),
    addons,
    addonsTotal,
    bookingDate: new Date(bookingDate),
    address: addressObj,
    ...(postalCode ? { postalCode } : {}),
    notes: notes || "",
    status: "accepted",
    statusHistory: [
      {
        status: "accepted",
        at: new Date(),
        by: "admin",
        note: "Created from admin panel",
      },
    ],
    price,
    finalPrice: price,
    payment: { method: "online", status: "pending" },
  });

  // Provider ko socket par foran khabar (purana behavior barqarar).
  try {
    emitToUser(providerId.toString(), "new_booking_request", {
      bookingId: booking._id.toString(),
      message: `New booking assigned by admin: ${service.title}`,
    });
  } catch (e) {
    /* socket optional */
  }

  // Dono taraf inbox notification + push (best effort).
  try {
    await Notification.create([
      {
        recipient: providerId,
        type: "general",
        title: "New booking assigned",
        message: `Admin created a booking for ${service.title}.`,
        sentBy: req.user._id,
        metadata: { bookingId: booking._id },
      },
      {
        recipient: customerId,
        type: "general",
        title: "Booking confirmed",
        message: `Your ${service.title} booking was created by OWVO support.`,
        sentBy: req.user._id,
        metadata: { bookingId: booking._id },
      },
    ]);
    notifyUser(providerId.toString(), {
      title: "New booking assigned",
      body: `Admin created a booking for ${service.title}.`,
      data: {
        type: "admin_booking_created",
        bookingId: booking._id.toString(),
      },
    });
    notifyUser(customerId.toString(), {
      title: "Booking confirmed",
      body: `Your ${service.title} booking was created by OWVO support.`,
      data: {
        type: "admin_booking_created",
        bookingId: booking._id.toString(),
      },
    });
  } catch (e) {
    /* notifications best effort */
  }

  const populated = await Booking.findById(booking._id).populate(
    bookingPopulate
  );

  res.status(httpStatus.CREATED).json({
    success: true,
    data: populated,
  });
});


// ─── Bookings redesign: list filters (list + CSV export shared) ───
// rangeBase sirf date-range + provider/customer scope rakhta hai — summary
// cards aur location options ISI par bante hain taake woh kabhi adhoori
// page-list se gin kar ghalat na hon. filter us par baqi conditions jodta hai.
const bkEscapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Europe/London ke aaj ke din ki shuruaat ka UTC lamha — GMT/BST dono
// me durust. "Upcoming Later" nazar is se peeche ki scheduled bookings
// nahi uthata (aaj subah wali, jo abhi baqi hain, woh shamil rehti hain).
const bkLondonStartOfToday = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const part = (type) =>
    Number(parts.find((x) => x.type === type)?.value || 0);
  const nowSecMs = Math.floor(now.getTime() / 1000) * 1000;
  const londonAsUtcMs = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second")
  );
  const offsetMs = londonAsUtcMs - nowSecMs;
  return new Date(
    Date.UTC(part("year"), part("month") - 1, part("day")) - offsetMs
  );
};

const bkBaseFilter = (query) => {
  const { providerId, customerId, from, to } = query;
  const base = {};
  if (providerId && mongoose.Types.ObjectId.isValid(providerId)) {
    base.provider = providerId;
  }
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    base.user = customerId;
  }
  if (from || to) {
    base.bookingDate = {};
    if (from) base.bookingDate.$gte = new Date(from);
    if (to) base.bookingDate.$lte = new Date(to);
  } else {
    Object.assign(base, dateFilter("bookingDate", query));
  }
  return base;
};

const bkBuildBookingFilters = async (query) => {
  const rangeBase = bkBaseFilter(query);
  const filter = bkBaseFilter(query);

  if (query.status && BOOKING_STATUSES.includes(query.status)) {
    filter.status = query.status;
  }
  if (query.serviceId && mongoose.Types.ObjectId.isValid(query.serviceId)) {
    filter.service = query.serviceId;
  }
  if (["paid", "pending", "failed"].includes(query.paymentStatus)) {
    filter["payment.status"] = query.paymentStatus;
  }
  if (query.paymentStatus === "refunded") {
    filter["refund.status"] = "refunded";
  }
  if (query.location) {
    const outward = String(query.location)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4);
    if (outward) filter.postalCode = { $regex: `^${outward}` };
  }
  // Specific day filter (More Filters) — range ko replace karta hai.
  if (query.day && /^\d{4}-\d{2}-\d{2}$/.test(String(query.day))) {
    const start = new Date(`${query.day}T00:00:00.000Z`);
    filter.bookingDate = {
      $gte: start,
      $lt: new Date(start.getTime() + 24 * 3600 * 1000),
    };
  }
  if (query.disputed === "1" || query.disputed === "true") {
    const disputedIds = await SupportTicket.find({
      type: "dispute",
      status: { $in: ["open", "in_progress"] },
    }).distinct("booking");
    filter._id = { $in: disputedIds };
  }

  // Book for Later: type filter + "upcoming" nazar. Upcoming me global
  // date-range bookingDate par laagu NAHI hota — woh range aam bookings
  // ke liye hai; mustaqbil ki scheduled bookings us se chhup jati hain.
  // Is bajaye scheduledAt aaj (London) se aagy + abhi zinda statuses.
  if (query.bookingType === "later" || query.bookingType === "now") {
    filter.bookingType = query.bookingType;
  }
  if (query.upcoming === "1" || query.upcoming === "true") {
    delete filter.bookingDate;
    filter.scheduledAt = { $gte: bkLondonStartOfToday() };
    if (!query.status) {
      filter.status = { $in: ["pending", "accepted", "arrived", "ongoing"] };
    }
  }

  const search = String(query.search || "").trim();
  if (search) {
    const rx = new RegExp(bkEscapeRegex(search), "i");
    const orParts = [{ postalCode: rx }];
    const matchedUsers = await User.find({
      $or: [{ name: rx }, { phoneNumber: rx }, { email: rx }],
    })
      .select("_id")
      .lean();
    if (matchedUsers.length) {
      const ids = matchedUsers.map((u) => u._id);
      orParts.push({ user: { $in: ids } }, { provider: { $in: ids } });
    }
    if (mongoose.Types.ObjectId.isValid(search)) {
      orParts.push({ _id: new mongoose.Types.ObjectId(search) });
    }
    // Short booking ID (last 6) se bhi search — sirf tab jab candidate set
    // chhota ho, warna full scan mehenga padta hai.
    if (/^[0-9a-fA-F]{6}$/.test(search)) {
      const candidates = await Booking.find(rangeBase)
        .select("_id")
        .limit(2001)
        .lean();
      if (candidates.length <= 2000) {
        const suffixIds = candidates
          .filter((c) =>
            c._id.toString().toLowerCase().endsWith(search.toLowerCase())
          )
          .map((c) => c._id);
        if (suffixIds.length) orParts.push({ _id: { $in: suffixIds } });
      }
    }
    filter.$or = orParts;
  }

  return { filter, rangeBase };
};


export const getAdminBookings = catchAsync(async (req, res) => {
  const { limit = 50, page = 1 } = req.query;
  const { filter, rangeBase } = await bkBuildBookingFilters(req.query);

  const pageNumber = Math.max(Number(page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const [items, total] = await Promise.all([
    Booking.find(filter)
      .populate(bookingPopulate)
      .sort(
        req.query.sort === "scheduled"
          ? { scheduledAt: 1, createdAt: -1 }
          : { createdAt: -1 }
      )
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize),
    Booking.countDocuments(filter),
  ]);

  const plain = items.map((b) => b.toObject());

  // Is page ke providers ki asal ratings (Rating collection) + har booking
  // par open-dispute flag — table inhi ko dikhati hai, koi andaza nahi.
  const providerIds = [
    ...new Set(
      plain.map((b) => b.provider?._id?.toString()).filter(Boolean)
    ),
  ];
  const bookingIds = plain.map((b) => b._id);
  const [ratingAgg, openDisputeIds] = await Promise.all([
    providerIds.length
      ? Rating.aggregate([
          {
            $match: {
              provider: {
                $in: providerIds.map(
                  (id) => new mongoose.Types.ObjectId(id)
                ),
              },
            },
          },
          {
            $group: {
              _id: "$provider",
              avg: { $avg: "$rating" },
              count: { $sum: 1 },
            },
          },
        ])
      : Promise.resolve([]),
    bookingIds.length
      ? SupportTicket.find({
          booking: { $in: bookingIds },
          type: "dispute",
          status: { $in: ["open", "in_progress"] },
        }).distinct("booking")
      : Promise.resolve([]),
  ]);
  const ratingMap = new Map(ratingAgg.map((r) => [r._id.toString(), r]));
  const disputeSet = new Set(openDisputeIds.map((x) => x.toString()));
  for (const item of plain) {
    const pid = item.provider?._id?.toString();
    const r = pid ? ratingMap.get(pid) : null;
    item.providerRating = r
      ? { average: Math.round(r.avg * 10) / 10, count: r.count }
      : { average: 0, count: 0 };
    item.hasOpenDispute = disputeSet.has(item._id.toString());
  }

  // Summary cards (range ke kul numbers) + location options.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [statusAgg, newThisMonth, locationRows] = await Promise.all([
    Booking.aggregate([
      { $match: rangeBase },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Booking.countDocuments({ ...rangeBase, createdAt: { $gte: monthStart } }),
    Booking.find(rangeBase)
      .select("postalCode address.addressLine")
      .limit(2000)
      .lean(),
  ]);
  const byStatus = {
    pending: 0,
    accepted: 0,
    arrived: 0,
    ongoing: 0,
    completed: 0,
    cancelled: 0,
    declined: 0,
  };
  let totalAll = 0;
  for (const row of statusAgg) {
    if (row._id in byStatus) byStatus[row._id] = row.count;
    totalAll += row.count;
  }
  const locMap = new Map();
  for (const row of locationRows) {
    const outward = (row.postalCode || "")
      .toString()
      .trim()
      .split(" ")[0]
      .toUpperCase();
    if (!outward) continue;
    const segments = (row.address?.addressLine || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const town =
      segments.length >= 2
        ? segments[segments.length - 2]
        : segments[0] || "";
    const entry =
      locMap.get(outward) || { value: outward, count: 0, towns: new Map() };
    entry.count += 1;
    if (town) entry.towns.set(town, (entry.towns.get(town) || 0) + 1);
    locMap.set(outward, entry);
  }
  const locations = [...locMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)
    .map((e) => {
      const topTown =
        [...e.towns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      return {
        value: e.value,
        label: topTown ? `${e.value} · ${topTown}` : e.value,
      };
    });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin bookings fetched successfully",
    data: {
      items: plain,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        pages: Math.ceil(total / pageSize),
      },
      summary: { total: totalAll, byStatus, newThisMonth },
      locations,
    },
  });
});


export const getAdminBookingById = catchAsync(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  const bookingDoc = await Booking.findById(id).populate(bookingPopulate);
  if (!bookingDoc) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }
  const booking = bookingDoc.toObject();

  // Is booking ki payment entries (booking fee + tips) - Payment tab ke liye.
  const payments = await paymentInfo
    .find({ bookingId: booking._id })
    .sort({ createdAt: 1 })
    .lean();
  const tipsTotal = payments
    .filter((p) => p.type === "tips" && p.paymentStatus === "complete")
    .reduce((sum, p) => sum + (Number(p.price) || 0), 0);

  // Dono taraf ki ratings: provider ko mili (Rating) + customer ko mili
  // (UserRating). Na ho to null - panel imaandaar khaali haalat dikhayega.
  const [providerRatingDoc, customerRatingDoc] = await Promise.all([
    Rating.findOne({ booking: booking._id })
      .select("rating review createdAt")
      .lean(),
    UserRating.findOne({ booking: booking._id })
      .select("rating review createdAt")
      .lean(),
  ]);

  // Provider ke kul numbers: asal rating average/count (Rating collection)
  // aur mukammal jobs ki tadaad — panel ke "jobs done" isi se banta hai.
  const providerRefId = booking.provider?._id || booking.provider;
  const [providerAgg, providerCompletedJobs, openDispute] =
    await Promise.all([
      Rating.aggregate([
        { $match: { provider: providerRefId } },
        {
          $group: {
            _id: null,
            avg: { $avg: "$rating" },
            count: { $sum: 1 },
          },
        },
      ]),
      Booking.countDocuments({
        provider: providerRefId,
        status: "completed",
      }),
      SupportTicket.findOne({
        booking: booking._id,
        type: "dispute",
        status: { $in: ["open", "in_progress"] },
      })
        .select("ticketNumber status priority createdAt")
        .lean(),
    ]);
  const providerStats = {
    ratingAverage: providerAgg[0]
      ? Math.round(providerAgg[0].avg * 10) / 10
      : 0,
    ratingCount: providerAgg[0]?.count || 0,
    completedJobs: providerCompletedJobs,
  };

  // Timeline: recorded statusHistory ho to wahi; warna purani booking ke
  // liye sirf wohi steps jo maujood timestamps se sabit hote hain - koi
  // step invent nahi hota.
  const recorded = Array.isArray(booking.statusHistory)
    ? booking.statusHistory
    : [];
  let timeline;
  if (recorded.length > 0) {
    timeline = recorded.map((h) => ({
      status: h.status,
      at: h.at || null,
      by: h.by || "",
      note: h.note || "",
      source: "recorded",
    }));
  } else {
    timeline = [
      {
        status: "pending",
        at: booking.createdAt || null,
        by: "user",
        note: "",
        source: "derived",
      },
    ];
    if (booking.arrivedAt) {
      timeline.push({
        status: "arrived",
        at: booking.arrivedAt,
        by: "",
        note: "",
        source: "derived",
      });
    }
    if (booking.completedAt) {
      timeline.push({
        status: "completed",
        at: booking.completedAt,
        by: "",
        note: "",
        source: "derived",
      });
    }
    if (booking.status === "cancelled") {
      timeline.push({
        status: "cancelled",
        at: booking.cancelledAt || null,
        by: booking.cancelledBy || "",
        note: booking.cancellationReason || "",
        source: "derived",
      });
    } else if (
      booking.status !== "pending" &&
      !timeline.some((t) => t.status === booking.status)
    ) {
      timeline.push({
        status: booking.status,
        at: null,
        by: "",
        note: "",
        source: "derived",
      });
    }
    timeline.sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at).getTime() - new Date(b.at).getTime();
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin booking fetched successfully",
    data: {
      ...booking,
      payments,
      tipsTotal,
      providerRating: providerRatingDoc
        ? {
            rating: providerRatingDoc.rating,
            review: providerRatingDoc.review || "",
            at: providerRatingDoc.createdAt,
          }
        : null,
      customerRating: customerRatingDoc
        ? {
            rating: customerRatingDoc.rating,
            review: customerRatingDoc.review || "",
            at: customerRatingDoc.createdAt,
          }
        : null,
      timeline,
      providerStats,
      openDispute: openDispute || null,
    },
  });
});

export const updateAdminBookingStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const {
    status,
    reason,
    notes,
    notifyCustomer,
    notifyProvider,
    providerId,
    estimatedArrival,
  } = req.body || {};

  if (!BOOKING_STATUSES.includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid booking status");
  }

  if (req.user.role === "staff" && !STAFF_BOOKING_STATUSES.includes(status)) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Staff can only update operational booking statuses"
    );
  }

  const booking = await Booking.findById(id);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  if (booking.status === status) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Booking is already ${status}`
    );
  }

  const allowedNext = BOOKING_TRANSITIONS[booking.status] || [];
  if (!allowedNext.includes(status)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Booking cannot move from ${booking.status} to ${status}`
    );
  }

  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (status === "cancelled" && !cleanReason) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A cancellation reason is required"
    );
  }

  // Accept modal ka Select Provider: accept ke waqt provider badla ja
  // sakta hai (masalan declined ki hui booking kisi aur ko dena).
  let providerChanged = false;
  if (
    status === "accepted" &&
    providerId &&
    mongoose.Types.ObjectId.isValid(providerId) &&
    String(booking.provider || "") !== String(providerId)
  ) {
    const newProvider = await User.findOne({
      _id: providerId,
      role: "provider",
    }).select("_id");
    if (!newProvider) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Selected provider not found"
      );
    }
    booking.provider = newProvider._id;
    providerChanged = true;
  }
  if (status === "accepted" && estimatedArrival) {
    const eta = new Date(estimatedArrival);
    if (!Number.isNaN(eta.getTime())) booking.estimatedArrival = eta;
  }

  booking.status = status;
  if (status === "completed") {
    // Commission snapshot — complete hone ke lamhe ka rate pakka.
    await applyCommissionSnapshot(booking);
  }
  if (status === "arrived" && !booking.arrivedAt) {
    booking.arrivedAt = new Date();
    booking.washEndsAt = new Date(booking.arrivedAt.getTime() + 30 * 60 * 1000);
  }
  if (status === "cancelled") {
    booking.cancellationReason = cleanReason;
    booking.cancelledBy = "admin";
    booking.cancelledAt = new Date();
  }
  const cleanNotes = typeof notes === "string" ? notes.trim() : "";
  booking.statusHistory = [
    ...(booking.statusHistory || []),
    {
      status,
      at: new Date(),
      by: "admin",
      note: status === "cancelled" ? cleanReason : cleanNotes,
    },
  ];

  await booking.save();
  await refreshProviderBusyState(booking.provider);
  await createReceiptForCompletedBooking(booking);
  const completedJobs =
    status === "completed"
      ? await syncProviderCompletedJobs(booking.provider)
      : null;
  await booking.populate(bookingPopulate);

  emitDashboardBookingStatus(booking, status, { completedJobs });

  // Customer / provider ko khabar: inbox notification + push. Modal ke
  // toggles (notifyCustomer / notifyProvider) band hon to nahi jati.
  const copy = ADMIN_BOOKING_STATUS_COPY[status];
  if (copy) {
    const targets = [];
    if (notifyCustomer !== false && booking.user) {
      targets.push({
        userId: booking.user?._id || booking.user,
        title: copy.customerTitle,
        body: copy.customerBody,
      });
    }
    if (notifyProvider !== false && booking.provider) {
      targets.push({
        userId: booking.provider?._id || booking.provider,
        title: copy.providerTitle,
        body: copy.providerBody,
      });
    }
    for (const t of targets) {
      try {
        await Notification.create({
          recipient: t.userId,
          type: "general",
          title: t.title,
          message: t.body,
          sentBy: req.user._id,
          metadata: { bookingId: booking._id.toString(), status },
        });
      } catch (err) {
        console.error("Failed to save booking status notification:", err);
      }
      notifyUser(t.userId.toString(), {
        title: t.title,
        body: t.body,
        data: {
          type: "admin_booking_update",
          bookingId: booking._id.toString(),
          status,
        },
      });
    }
  }

  await recordActivity({
    req,
    action: "booking.status_updated",
    entityType: "booking",
    entityId: booking._id,
    metadata: { status, reason: cleanReason || undefined, providerChanged },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking status updated successfully",
    data: booking,
  });
});

export const getProviderVerificationQueue = catchAsync(async (req, res) => {
  const status = req.query.status?.toString();
  const filter = { role: "provider" };

  if (status === "not_approved") {
    filter["adminVerification.status"] = { $ne: "approved" };
  } else if (
    ["not_submitted", "pending", "approved", "rejected"].includes(status)
  ) {
    filter["adminVerification.status"] = status;
  }

  const providers = await User.find(filter)
    .select(providerVerificationSelect)
    .sort({ updatedAt: -1 })
    .lean();
  const data = providers.map(maskProviderVerificationPayload);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider verification queue fetched successfully",
    data,
  });
});

export const updateProviderVerification = catchAsync(async (req, res) => {
  const { providerId } = req.params;
  const { status, rejectionReason = "", notes = "" } = req.body || {};

  if (!["pending", "approved", "rejected"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid verification status");
  }

  const provider = await User.findOne({ _id: providerId, role: "provider" });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  provider.adminVerification = {
    ...provider.adminVerification?.toObject?.(),
    status,
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
    rejectionReason: status === "rejected" ? rejectionReason.toString().trim() : "",
    notes: notes.toString().trim(),
  };

  if (status === "approved" || status === "rejected") {
    provider.identityVerification.status = status;
  }

  if (status !== "approved") {
    provider.isOnline = false;
    provider.isBusy = false;
  }

  await provider.save();

  const missingDocuments =
    status === "rejected" ? findMissingDocuments(provider) : [];
  const missingDocsText =
    missingDocuments.length > 0
      ? ` Still missing: ${missingDocuments.join(", ")}.`
      : "";

  const verificationMessage =
    status === "approved"
      ? "Your OWVO provider verification has been approved. You can now go online."
      : status === "rejected"
        ? (provider.adminVerification.rejectionReason ||
            "Your OWVO provider verification was rejected. Please update your documents or contact support.") +
          missingDocsText
        : "Your OWVO provider verification is under review.";

  emitToUser(provider._id.toString(), "provider_verification_update", {
    providerId: provider._id.toString(),
    status,
    message: verificationMessage,
    rejectionReason: provider.adminVerification.rejectionReason,
    missingDocuments,
    notes: provider.adminVerification.notes,
    reviewedAt: provider.adminVerification.reviewedAt,
  });

  // 🔔 Push too — socket alone won't reach a closed app.
  if (status === "approved" || status === "rejected") {
    notifyUser(provider._id.toString(), {
      title:
        status === "approved"
          ? "Verification approved! 🎉"
          : "Verification rejected",
      body: verificationMessage,
      data: { type: "verification_update", status },
    });
  }

  // Turant (live) socket event sirf tab kaam karta hai jab provider us
  // waqt app mein ho. Isay bhi save kar dete hain taake agar wo offline
  // ho, agli baar app kholte hi Inbox mein dikh jaye — Reminder wale
  // Notification system ko hi reuse kar rahe hain.
  if (status === "approved" || status === "rejected") {
    try {
      await Notification.create({
        recipient: provider._id,
        type: "general",
        title: status === "approved" ? "Verification approved" : "Verification rejected",
        message: verificationMessage,
        sentBy: req.user._id,
        metadata: { verificationStatus: status, missingDocuments },
      });
    } catch (err) {
      console.error("Failed to save verification notification:", err);
    }
  }

  await recordActivity({
    req,
    action: "provider.verification_updated",
    entityType: "user",
    entityId: provider._id,
    metadata: { status, rejectionReason, notes, missingDocuments },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider verification updated successfully",
    data: maskProviderVerificationPayload(provider),
  });
});

export const updateUserAccountStatus = catchAsync(async (req, res) => {
  const { userId } = req.params;
  const { accountStatus } = req.body || {};

  if (!["active", "disabled"].includes(accountStatus)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid account status");
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  user.accountStatus = accountStatus;
  await user.save();
  await recordActivity({
    req,
    action: "user.account_status_updated",
    entityType: "user",
    entityId: user._id,
    metadata: { accountStatus },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account status updated successfully",
    data: user,
  });
});

export const updateProviderEnforcement = catchAsync(async (req, res) => {
  const { providerId } = req.params;
  const { status, reason = "" } = req.body || {};

  if (!["clear", "warned", "suspended", "banned"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid enforcement status");
  }

  const provider = await User.findOne({ _id: providerId, role: "provider" });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  provider.enforcement = {
    status,
    reason: reason.toString().trim(),
    updatedBy: req.user._id,
    updatedAt: new Date(),
  };

  if (["suspended", "banned"].includes(status)) {
    provider.isOnline = false;
  }

  await provider.save();

  await recordActivity({
    req,
    action: "provider.enforcement_updated",
    entityType: "user",
    entityId: provider._id,
    metadata: { status, reason },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider enforcement updated successfully",
    data: maskProviderVerificationPayload(provider),
  });
});

// ─── Provider Soft Delete (Providers redesign — Step 3) ─────────────────────
// DELETE /admin/providers/:id — provider ka data delete NAHI hota (bookings,
// payouts aur earnings ka record mehfooz rehta hy); sirf isDeleted flag lagta
// hy, account disabled + banned ho jata hy aur provider list/detail se ghayab
// ho jata hy. Active bookings hon to delete roka jata hy.
export const deleteAdminProvider = catchAsync(async (req, res) => {
  const { id } = req.params;

  const provider = await User.findOne({
    _id: id,
    role: "provider",
    isDeleted: { $ne: true },
  });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  const activeBookings = await Booking.countDocuments({
    provider: provider._id,
    status: { $in: ["accepted", "arrived", "ongoing"] },
  });
  if (activeBookings > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This provider has active bookings. Complete or cancel them before deleting."
    );
  }

  provider.isDeleted = true;
  provider.deletedAt = new Date();
  provider.isOnline = false;
  provider.isBusy = false;
  provider.accountStatus = "disabled";
  provider.enforcement = {
    status: "banned",
    reason: "Account deleted by admin",
    updatedBy: req.user._id,
    updatedAt: new Date(),
  };
  await provider.save();

  await recordActivity({
    req,
    action: "provider.deleted",
    entityType: "user",
    entityId: provider._id,
    metadata: { name: provider.name, email: provider.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider deleted successfully",
    data: { _id: provider._id },
  });
});

// ─── Provider Detail (Providers redesign — Step 1) ──────────────────────────
// GET /admin/providers/:id — detail panel ke liye provider ki poori profile,
// services, stats (completion rate ke sath), earnings/wallet aur recent
// activity ek hi response me. Bank/NI/Stripe numbers hamesha masked ayenge.
export const getAdminProviderDetail = catchAsync(async (req, res) => {
  const { id } = req.params;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const provider = await User.findOne({ _id: id, role: "provider", isDeleted: { $ne: true } })
    .select(providerVerificationSelect)
    .lean();
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }
  const providerId = provider._id;

  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings?.commissionRate) || 0.25;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const currentDay = now.getUTCDay();
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - (currentDay === 0 ? 6 : currentDay - 1));
  weekStart.setUTCHours(0, 0, 0, 0);

  const [
    services,
    ratingAgg,
    statusCounts,
    earningsAgg,
    todayAgg,
    weekAgg,
    tipsAgg,
    paidOutAgg,
    pendingPayoutAgg,
    recentBookings,
    cancelledByProvider,
  ] = await Promise.all([
    Service.find({ provider: providerId })
      .select("title price isActive serviceType carSize catalogKey")
      .sort({ createdAt: 1 })
      .lean(),
    Rating.aggregate([
      { $match: { provider: providerId } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { provider: providerId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { provider: providerId, status: "completed" } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    Booking.aggregate([
      {
        $match: {
          provider: providerId,
          status: "completed",
          completedAt: { $gte: todayStart },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: {
              $ifNull: [
                "$providerNetAmount",
                {
                  $multiply: [
                    "$finalPrice",
                    {
                      $subtract: [
                        1,
                        { $ifNull: ["$commissionRate", commissionRate] },
                      ],
                    },
                  ],
                },
              ],
            } },
        },
      },
    ]),
    Booking.aggregate([
      {
        $match: {
          provider: providerId,
          status: "completed",
          completedAt: { $gte: weekStart },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: {
              $ifNull: [
                "$providerNetAmount",
                {
                  $multiply: [
                    "$finalPrice",
                    {
                      $subtract: [
                        1,
                        { $ifNull: ["$commissionRate", commissionRate] },
                      ],
                    },
                  ],
                },
              ],
            } },
        },
      },
    ]),
    paymentInfo.aggregate([
      {
        $match: {
          providerId: new mongoose.Types.ObjectId(providerId),
          type: "tips",
          paymentStatus: "complete",
        },
      },
      { $group: { _id: null, total: { $sum: "$price" } } },
    ]),
    Payout.aggregate([
      { $match: { provider: providerId, status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Payout.aggregate([
      { $match: { provider: providerId, status: { $in: ["pending", "processing"] } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Booking.find({ provider: providerId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("user", "name photo")
      .populate("service", "title")
      .lean(),
    Booking.countDocuments({
      provider: providerId,
      status: "cancelled",
      cancelledBy: "provider",
    }),
  ]);

  const counts = {};
  statusCounts.forEach((row) => {
    counts[row._id] = row.count;
  });
  const completedCount = counts.completed || 0;
  const declinedCount = counts.declined || 0;
  // Completion rate — DOCUMENT (Section H) wali formula:
  // completed / (completed + provider-cancelled).
  // Koi finished job hi na ho to null (panel "—" dikhayega).
  const finishedForRate = completedCount + cancelledByProvider;
  const completionRate =
    finishedForRate > 0
      ? Math.round((completedCount / finishedForRate) * 100)
      : null;

  const lifetimeGross = earningsAgg[0]?.total || 0;
  const tipsTotal = r2(tipsAgg[0]?.total || 0);
  // Unified hisaab (money.util) — snapshot + tips − refunds − holds.
  const providerBalances = await computeProviderBalances(providerId);
  const totalEarnings = r2(providerBalances.net + providerBalances.tips);
  const paidOut = r2(providerBalances.paidOut);
  const pendingPayouts = r2(providerBalances.allocated);
  const walletBalance = r2(providerBalances.available);

  // Recent activity — completed bookings, payouts, reviews aur admin actions
  // ko ek timeline me mila kar latest 10.
  const [completedRecent, paidRecent, reviewsRecent, adminActions] =
    await Promise.all([
      Booking.find({ provider: providerId, status: "completed" })
        .sort({ completedAt: -1 })
        .limit(5)
        .select("finalPrice completedAt createdAt")
        .lean(),
      Payout.find({ provider: providerId, status: "paid" })
        .sort({ updatedAt: -1 })
        .limit(3)
        .select("amount updatedAt createdAt")
        .lean(),
      Rating.find({ provider: providerId })
        .sort({ createdAt: -1 })
        .limit(3)
        .select("rating createdAt")
        .lean(),
      ActivityLog.find({ entityId: providerId })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

  const recentActivity = [
    ...completedRecent.map((b) => ({
      type: "booking_completed",
      title: "Completed booking",
      ref: `#${b._id.toString().slice(-6).toUpperCase()}`,
      amount: b.finalPrice ?? null,
      createdAt: b.completedAt || b.createdAt,
    })),
    ...paidRecent.map((p) => ({
      type: "payout",
      title: "Payout paid",
      amount: p.amount ?? null,
      createdAt: p.updatedAt || p.createdAt,
    })),
    ...reviewsRecent.map((r) => ({
      type: "review",
      title: "New review",
      stars: r.rating ?? null,
      createdAt: r.createdAt,
    })),
    ...adminActions.map((a) => ({
      type: "admin_action",
      title: a.action,
      createdAt: a.createdAt,
    })),
  ]
    .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))
    .slice(0, 10);

  const completedTodayCount = await Booking.countDocuments({
    provider: providerId,
    status: "completed",
    completedAt: { $gte: todayStart },
  });

  // Step 6 — Earnings/Bookings tabs: payout history + recent completed jobs
  // (per-booking earnings table ke liye).
  const [payoutHistory, recentCompletedJobs] = await Promise.all([
    Payout.find({ provider: providerId })
      .sort({ createdAt: -1 })
      .limit(15)
      .select("amount currency status payoutDate paidAt failureReason createdAt")
      .lean(),
    Booking.find({ provider: providerId, status: "completed" })
      .sort({ completedAt: -1 })
      .limit(15)
      .populate("user", "name photo")
      .populate("service", "title")
      .select("finalPrice price bookingDate completedAt createdAt")
      .lean(),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider detail fetched successfully",
    data: {
      provider: maskProviderVerificationPayload(provider),
      services,
      stats: {
        totalJobs: completedCount,
        ratingAverage: ratingAgg[0] ? Number(ratingAgg[0].avg.toFixed(1)) : 0,
        ratingCount: ratingAgg[0]?.count || 0,
        completionRate,
        counts: {
          completed: completedCount,
          cancelled: counts.cancelled || 0,
          cancelledByProvider,
          declined: declinedCount,
          active:
            (counts.pending || 0) +
            (counts.accepted || 0) +
            (counts.arrived || 0) +
            (counts.ongoing || 0),
        },
      },
      earnings: {
        totalGross: r2(lifetimeGross),
        totalEarnings,
        todayNet: r2(todayAgg[0]?.total || 0),
        weekNet: r2(weekAgg[0]?.total || 0),
        tipsTotal,
        paidOut,
        pendingPayouts,
        walletBalance,
        commissionRate,
      },
      recentBookings: recentBookings.map((b) => ({
        _id: b._id,
        status: b.status,
        bookingDate: b.bookingDate,
        finalPrice: b.finalPrice,
        price: b.price,
        paymentStatus: b.payment?.status || null,
        serviceTitle: b.service?.title || "Wash Service",
        customerName: b.user?.name || "Customer",
        customerPhoto: b.user?.photo?.url || "",
        createdAt: b.createdAt,
      })),
      recentActivity,
      dailyLimit: buildProviderDailyWashLimitPayload(provider, settings, completedTodayCount),
      payouts: payoutHistory.map((p) => ({
        _id: p._id,
        amount: p.amount,
        currency: p.currency || "GBP",
        status: p.status,
        payoutDate: p.payoutDate || null,
        paidAt: p.paidAt || null,
        failureReason: p.failureReason || "",
        createdAt: p.createdAt,
      })),
      completedJobs: recentCompletedJobs.map((b) => ({
        _id: b._id,
        ref: `#${b._id.toString().slice(-6).toUpperCase()}`,
        serviceTitle: b.service?.title || "Wash Service",
        customerName: b.user?.name || "Customer",
        finalPrice: b.finalPrice,
        bookingDate: b.bookingDate,
        completedAt: b.completedAt,
        createdAt: b.createdAt,
      })),
    },
  });
});


// ─── Provider Notes, Send Message, Add Provider (Providers redesign — Step 7)
const findProviderForPanel = async (id) => {
  const provider = await User.findOne({
    _id: id,
    role: "provider",
    isDeleted: { $ne: true },
  });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }
  return provider;
};

// POST /admin/providers — admin panel se naya provider account banana.
// Provider baqi onboarding (documents, bank) app me khud complete karega;
// account verification approve hone tak "Pending" rahega.
export const createAdminProvider = catchAsync(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phoneNumber = String(req.body?.phoneNumber || "").trim();
  const password = String(req.body?.password || "");
  const serviceArea = String(req.body?.serviceArea || "").trim();

  if (!name) {
    throw new AppError(httpStatus.BAD_REQUEST, "Provider name is required");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError(httpStatus.BAD_REQUEST, "A valid email address is required");
  }
  if (!phoneNumber) {
    throw new AppError(httpStatus.BAD_REQUEST, "Phone number is required");
  }
  if (!password || password.length < 6) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Password must be at least 6 characters"
    );
  }

  const existingEmail = await User.findOne({ email });
  if (existingEmail) {
    throw new AppError(
      httpStatus.CONFLICT,
      "An account with this email already exists"
    );
  }
  const existingPhone = await User.findOne({ phoneNumber });
  if (existingPhone) {
    throw new AppError(
      httpStatus.CONFLICT,
      "An account with this phone number already exists"
    );
  }

  let provider;
  try {
    provider = await User.create({
      name,
      email,
      phoneNumber,
      password,
      role: "provider",
      serviceArea,
      verificationInfo: { verified: true },
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError(
        httpStatus.CONFLICT,
        "An account with this email or phone number already exists"
      );
    }
    throw error;
  }

  await recordActivity({
    req,
    action: "provider.created_by_admin",
    entityType: "user",
    entityId: provider._id,
    metadata: { email: provider.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Provider created successfully",
    data: {
      _id: provider._id,
      name: provider.name,
      email: provider.email,
      phoneNumber: provider.phoneNumber,
      serviceArea: provider.serviceArea,
      role: provider.role,
      createdAt: provider.createdAt,
    },
  });
});

// GET /admin/providers/:id/notes — admin team ke private notes (provider ko
// kabhi nazar nahi ate).
export const getProviderNotes = catchAsync(async (req, res) => {
  const provider = await findProviderForPanel(req.params.id);
  const notes = await ProviderNote.find({ provider: provider._id })
    .populate("author", "name role")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider notes fetched successfully",
    data: notes.map((note) => ({
      _id: note._id,
      text: note.text,
      authorName: note.author?.name || "Admin",
      authorRole: note.author?.role || "",
      createdAt: note.createdAt,
    })),
  });
});

// POST /admin/providers/:id/notes
export const addProviderNote = catchAsync(async (req, res) => {
  const provider = await findProviderForPanel(req.params.id);
  const text = String(req.body?.text || "").trim();
  if (!text) {
    throw new AppError(httpStatus.BAD_REQUEST, "Note text is required");
  }
  if (text.length > 2000) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Note is too long (maximum 2000 characters)"
    );
  }
  const note = await ProviderNote.create({
    provider: provider._id,
    author: req.user._id,
    text,
  });
  await recordActivity({
    req,
    action: "provider.note_added",
    entityType: "user",
    entityId: provider._id,
    metadata: { noteId: note._id },
  });
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Note added",
    data: {
      _id: note._id,
      text: note.text,
      authorName: req.user.name || "Admin",
      authorRole: req.user.role || "",
      createdAt: note.createdAt,
    },
  });
});

// DELETE /admin/providers/:id/notes/:noteId
export const deleteProviderNote = catchAsync(async (req, res) => {
  const provider = await findProviderForPanel(req.params.id);
  const note = await ProviderNote.findOne({
    _id: req.params.noteId,
    provider: provider._id,
  });
  if (!note) {
    throw new AppError(httpStatus.NOT_FOUND, "Note not found");
  }
  await note.deleteOne();
  await recordActivity({
    req,
    action: "provider.note_deleted",
    entityType: "user",
    entityId: provider._id,
    metadata: { noteId: note._id },
  });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Note deleted",
    data: { _id: note._id },
  });
});

// POST /admin/providers/:id/message — provider ko message: app inbox me save
// (Notification) + FCM push. Verification wale flow wala hi pattern.
export const sendProviderMessage = catchAsync(async (req, res) => {
  const provider = await findProviderForPanel(req.params.id);
  const title = String(req.body?.title || "").trim() || "Message from OWVO";
  const message = String(req.body?.message || "").trim();
  if (!message) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message is required");
  }
  if (message.length > 1000) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Message is too long (maximum 1000 characters)"
    );
  }

  await Notification.create({
    recipient: provider._id,
    type: "general",
    title,
    message,
    sentBy: req.user._id,
    metadata: { source: "admin_panel" },
  });
  notifyUser(provider._id.toString(), {
    title,
    body: message,
    data: { type: "admin_message" },
  });
  await recordActivity({
    req,
    action: "provider.message_sent",
    entityType: "user",
    entityId: provider._id,
    metadata: { title },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Message sent to provider",
    data: { providerId: provider._id },
  });
});

// PATCH /admin/providers/:id/profile — admin provider ki basic profile edit
// karta hai (name, phone, service area, home address). Email jaan kar edit
// nahi hota — wo login identity hai.
export const updateAdminProviderProfile = catchAsync(async (req, res) => {
  const provider = await findProviderForPanel(req.params.id);

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) {
      throw new AppError(httpStatus.BAD_REQUEST, "Provider name is required");
    }
    provider.name = name;
  }
  if (req.body?.phoneNumber !== undefined) {
    const phoneNumber = String(req.body.phoneNumber).trim();
    if (!phoneNumber) {
      throw new AppError(httpStatus.BAD_REQUEST, "Phone number is required");
    }
    if (phoneNumber !== provider.phoneNumber) {
      const duplicate = await User.findOne({
        phoneNumber,
        _id: { $ne: provider._id },
      });
      if (duplicate) {
        throw new AppError(
          httpStatus.CONFLICT,
          "An account with this phone number already exists"
        );
      }
      provider.phoneNumber = phoneNumber;
    }
  }
  if (req.body?.serviceArea !== undefined) {
    provider.serviceArea = String(req.body.serviceArea).trim();
  }
  const address = req.body?.providerAddress;
  if (address && typeof address === "object") {
    provider.providerAddress = {
      streetAddress: String(
        address.streetAddress ?? provider.providerAddress?.streetAddress ?? ""
      ).trim(),
      city: String(address.city ?? provider.providerAddress?.city ?? "").trim(),
      country: String(
        address.country ?? provider.providerAddress?.country ?? ""
      ).trim(),
      postcode: String(
        address.postcode ?? provider.providerAddress?.postcode ?? ""
      ).trim(),
    };
  }

  await provider.save();
  await recordActivity({
    req,
    action: "provider.profile_updated",
    entityType: "user",
    entityId: provider._id,
    metadata: {},
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider updated successfully",
    data: {
      _id: provider._id,
      name: provider.name,
      email: provider.email,
      phoneNumber: provider.phoneNumber,
      serviceArea: provider.serviceArea,
      providerAddress: provider.providerAddress,
      updatedAt: provider.updatedAt,
    },
  });
});

// ─── Customers redesign — detail, notes, message, account actions ──────────
const findCustomerDoc = async (id) => {
  const customer = await User.findOne({ _id: id, role: "user" });
  if (!customer) {
    throw new AppError(httpStatus.NOT_FOUND, "Customer not found");
  }
  return customer;
};

// GET /admin/customers/:id — detail panel ke liye customer ki profile, stats
// (total bookings, total spent, dono taraf ki ratings), bookings, vehicles,
// payments aur reviews ek hi response me.
export const getAdminCustomerDetail = catchAsync(async (req, res) => {
  const { id } = req.params;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const customer = await User.findOne({
    _id: id,
    role: "user",
    isDeleted: { $ne: true },
  })
    .select(dashboardUserSelect)
    .lean();
  if (!customer) {
    throw new AppError(httpStatus.NOT_FOUND, "Customer not found");
  }
  const customerId = customer._id;

  const [
    statusCounts,
    spentAgg,
    tipsAgg,
    ratingReceivedAgg,
    ratingGivenAgg,
    bookings,
    vehicles,
    payments,
    reviewsReceived,
    reviewsGiven,
  ] = await Promise.all([
    Booking.aggregate([
      { $match: { user: customerId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { user: customerId, status: "completed" } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    paymentInfo.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(customerId),
          type: "tips",
          paymentStatus: "complete",
        },
      },
      { $group: { _id: null, total: { $sum: "$price" } } },
    ]),
    UserRating.aggregate([
      { $match: { user: customerId } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]),
    Rating.aggregate([
      { $match: { user: customerId } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]),
    Booking.find({ user: customerId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("provider", "name photo")
      .populate("service", "title")
      .populate("vehicle", "registrationNo make model image")
      .lean(),
    Vehicle.find({ user: customerId })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean(),
    paymentInfo
      .find({ userId: customerId, type: { $in: ["booking", "tips"] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    UserRating.find({ user: customerId })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("provider", "name photo")
      .lean(),
    Rating.find({ user: customerId })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("provider", "name photo")
      .populate({
        path: "booking",
        select: "service",
        populate: { path: "service", select: "title" },
      })
      .lean(),
  ]);

  const counts = {};
  statusCounts.forEach((row) => {
    counts[row._id] = row.count;
  });
  const totalBookings = Object.values(counts).reduce((a, b) => a + b, 0);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customer detail fetched successfully",
    data: {
      customer,
      stats: {
        totalBookings,
        counts: {
          completed: counts.completed || 0,
          cancelled: counts.cancelled || 0,
          declined: counts.declined || 0,
          active:
            (counts.pending || 0) +
            (counts.accepted || 0) +
            (counts.arrived || 0) +
            (counts.ongoing || 0),
        },
        totalSpent: r2(spentAgg[0]?.total || 0),
        tipsGiven: r2(tipsAgg[0]?.total || 0),
        ratingReceived: {
          average: ratingReceivedAgg[0]
            ? Number(ratingReceivedAgg[0].avg.toFixed(1))
            : 0,
          count: ratingReceivedAgg[0]?.count || 0,
        },
        ratingGiven: {
          average: ratingGivenAgg[0]
            ? Number(ratingGivenAgg[0].avg.toFixed(1))
            : 0,
          count: ratingGivenAgg[0]?.count || 0,
        },
      },
      bookings: bookings.map((b) => ({
        _id: b._id,
        ref: `#B${b._id.toString().slice(-6).toUpperCase()}`,
        status: b.status,
        bookingDate: b.bookingDate,
        finalPrice: b.finalPrice,
        price: b.price,
        paymentStatus: b.payment?.status || null,
        serviceTitle: b.service?.title || "Wash Service",
        providerName: b.provider?.name || "Provider",
        providerPhoto: b.provider?.photo?.url || "",
        vehicle: {
          registrationNo:
            b.vehicle?.registrationNo || b.vehicleSnapshot?.registrationNo || "",
          make: b.vehicle?.make || b.vehicleSnapshot?.make || "",
          model: b.vehicle?.model || b.vehicleSnapshot?.model || "",
          image: b.vehicleSnapshot?.image || b.vehicle?.image || "",
        },
        address: b.address?.addressLine || "",
        createdAt: b.createdAt,
      })),
      vehicles: vehicles.map((v) => ({
        _id: v._id,
        registrationNo: v.registrationNo || "",
        make: v.make || "",
        model: v.model || "",
        year: v.year || null,
        size: v.size || "",
        colour: v.colour || "",
        image: v.image || "",
        isDefault: Boolean(v.isDefault),
      })),
      payments: payments.map((p) => ({
        _id: p._id,
        ref: p.bookingId
          ? `#B${p.bookingId.toString().slice(-6).toUpperCase()}`
          : "—",
        type: p.type,
        amount: p.price,
        currency: p.currency || "GBP",
        status: p.paymentStatus || p.status || "",
        method: p.paymentMethod || "",
        transactionId: p.transactionId || "",
        createdAt: p.createdAt,
      })),
      reviewsReceived: reviewsReceived.map((r) => ({
        _id: r._id,
        rating: r.rating,
        review: r.review || "",
        providerName: r.provider?.name || "Provider",
        providerPhoto: r.provider?.photo?.url || "",
        bookingRef: r.booking
          ? `#B${r.booking.toString().slice(-6).toUpperCase()}`
          : "",
        createdAt: r.createdAt,
      })),
      reviewsGiven: reviewsGiven.map((r) => ({
        _id: r._id,
        rating: r.rating,
        review: r.review || "",
        providerName: r.provider?.name || "Provider",
        providerPhoto: r.provider?.photo?.url || "",
        serviceTitle: r.booking?.service?.title || "",
        bookingRef: r.booking?._id
          ? `#B${r.booking._id.toString().slice(-6).toUpperCase()}`
          : "",
        createdAt: r.createdAt,
      })),
    },
  });
});

// POST /admin/customers — admin panel se naya customer account (normal signup
// wala hi account; admin banata hai is liye OTP verified marked hota hai,
// warna app login par verification rok lagti).
export const createAdminCustomer = catchAsync(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phoneNumber = String(req.body?.phoneNumber || "").trim();
  const password = String(req.body?.password || "");
  const residentialAddress = String(req.body?.residentialAddress || "").trim();
  const dateOfBirthRaw = String(req.body?.dateOfBirth || "").trim();

  if (!name) {
    throw new AppError(httpStatus.BAD_REQUEST, "Customer name is required");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError(httpStatus.BAD_REQUEST, "A valid email address is required");
  }
  if (!phoneNumber) {
    throw new AppError(httpStatus.BAD_REQUEST, "Phone number is required");
  }
  if (!password || password.length < 6) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Password must be at least 6 characters"
    );
  }
  let dateOfBirth;
  if (dateOfBirthRaw) {
    dateOfBirth = new Date(dateOfBirthRaw);
    if (Number.isNaN(dateOfBirth.getTime())) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid date of birth");
    }
  }

  const existingEmail = await User.findOne({ email });
  if (existingEmail) {
    throw new AppError(
      httpStatus.CONFLICT,
      "An account with this email already exists"
    );
  }
  const existingPhone = await User.findOne({ phoneNumber });
  if (existingPhone) {
    throw new AppError(
      httpStatus.CONFLICT,
      "An account with this phone number already exists"
    );
  }

  let customer;
  try {
    customer = await User.create({
      name,
      email,
      phoneNumber,
      password,
      role: "user",
      residentialAddress,
      ...(dateOfBirth ? { dateOfBirth } : {}),
      verificationInfo: { verified: true },
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError(
        httpStatus.CONFLICT,
        "An account with this email or phone number already exists"
      );
    }
    if (error?.name === "ValidationError") {
      const first = Object.values(error.errors || {})[0];
      throw new AppError(
        httpStatus.BAD_REQUEST,
        first?.message || "Invalid customer data"
      );
    }
    throw error;
  }

  await recordActivity({
    req,
    action: "customer.created_by_admin",
    entityType: "user",
    entityId: customer._id,
    metadata: { email: customer.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Customer created successfully",
    data: {
      _id: customer._id,
      name: customer.name,
      email: customer.email,
      phoneNumber: customer.phoneNumber,
      role: customer.role,
      createdAt: customer.createdAt,
    },
  });
});

// PATCH /admin/customers/:id/profile — basic profile edit (name, email,
// phone, date of birth, address). Password yahan change NAHI hota.
export const updateAdminCustomerProfile = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) {
      throw new AppError(httpStatus.BAD_REQUEST, "Customer name is required");
    }
    customer.name = name;
  }
  if (req.body?.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(httpStatus.BAD_REQUEST, "A valid email address is required");
    }
    if (email !== customer.email) {
      const duplicate = await User.findOne({ email, _id: { $ne: customer._id } });
      if (duplicate) {
        throw new AppError(
          httpStatus.CONFLICT,
          "An account with this email already exists"
        );
      }
      customer.email = email;
    }
  }
  if (req.body?.phoneNumber !== undefined) {
    const phoneNumber = String(req.body.phoneNumber).trim();
    if (!phoneNumber) {
      throw new AppError(httpStatus.BAD_REQUEST, "Phone number is required");
    }
    if (phoneNumber !== customer.phoneNumber) {
      const duplicate = await User.findOne({
        phoneNumber,
        _id: { $ne: customer._id },
      });
      if (duplicate) {
        throw new AppError(
          httpStatus.CONFLICT,
          "An account with this phone number already exists"
        );
      }
      customer.phoneNumber = phoneNumber;
    }
  }
  if (req.body?.dateOfBirth !== undefined) {
    const raw = String(req.body.dateOfBirth || "").trim();
    if (!raw) {
      customer.dateOfBirth = undefined;
    } else {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError(httpStatus.BAD_REQUEST, "Invalid date of birth");
      }
      customer.dateOfBirth = parsed;
    }
  }
  if (req.body?.residentialAddress !== undefined) {
    customer.residentialAddress = String(req.body.residentialAddress).trim();
  }

  try {
    await customer.save();
  } catch (error) {
    if (error?.name === "ValidationError") {
      const first = Object.values(error.errors || {})[0];
      throw new AppError(
        httpStatus.BAD_REQUEST,
        first?.message || "Invalid customer data"
      );
    }
    if (error?.code === 11000) {
      throw new AppError(
        httpStatus.CONFLICT,
        "An account with this email or phone number already exists"
      );
    }
    throw error;
  }

  await recordActivity({
    req,
    action: "customer.profile_updated",
    entityType: "user",
    entityId: customer._id,
    metadata: {},
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customer updated successfully",
    data: {
      _id: customer._id,
      name: customer.name,
      email: customer.email,
      phoneNumber: customer.phoneNumber,
      dateOfBirth: customer.dateOfBirth || null,
      residentialAddress: customer.residentialAddress || "",
      updatedAt: customer.updatedAt,
    },
  });
});

// PATCH /admin/customers/:id/enforcement — providers wala enforcement hi
// customers par (suspend ka asal asar auth middleware + login check se ata
// hai; yahan status + wajah save hoti hai aur audit log banta hai).
export const updateCustomerEnforcement = catchAsync(async (req, res) => {
  const { status, reason = "" } = req.body || {};
  if (!["clear", "warned", "suspended", "banned"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid enforcement status");
  }
  const customer = await findCustomerDoc(req.params.id);
  customer.enforcement = {
    status,
    reason: reason.toString().trim(),
    updatedBy: req.user._id,
    updatedAt: new Date(),
  };
  await customer.save();

  await recordActivity({
    req,
    action: "customer.enforcement_updated",
    entityType: "user",
    entityId: customer._id,
    metadata: { status, reason },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customer enforcement updated successfully",
    data: {
      _id: customer._id,
      name: customer.name,
      email: customer.email,
      enforcement: customer.enforcement,
      accountStatus: customer.accountStatus,
    },
  });
});

// DELETE /admin/customers/:id — soft delete (providers wala pattern): data
// mehfooz rehta hai, account band + list se ghayab. Active booking (accepted /
// arrived / ongoing) ho to pehle block.
export const deleteAdminCustomer = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);
  const activeBooking = await Booking.findOne({
    user: customer._id,
    status: { $in: ["accepted", "arrived", "ongoing"] },
  }).select("_id");
  if (activeBooking) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This customer has an active booking in progress. Delete is blocked until it finishes or is cancelled."
    );
  }
  customer.isDeleted = true;
  customer.deletedAt = new Date();
  customer.accountStatus = "disabled";
  customer.enforcement = {
    status: "banned",
    reason: "Account deleted by admin",
    updatedBy: req.user._id,
    updatedAt: new Date(),
  };
  await customer.save();

  await recordActivity({
    req,
    action: "customer.deleted",
    entityType: "user",
    entityId: customer._id,
    metadata: { email: customer.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customer deleted successfully",
    data: { _id: customer._id },
  });
});

// ─── Customer Notes (admin-only; customer ko kabhi nazar nahi ate) ─────────
export const getCustomerNotes = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);
  const notes = await CustomerNote.find({ customer: customer._id })
    .populate("author", "name role")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customer notes fetched successfully",
    data: notes.map((note) => ({
      _id: note._id,
      text: note.text,
      authorName: note.author?.name || "Admin",
      authorRole: note.author?.role || "",
      createdAt: note.createdAt,
    })),
  });
});

export const addCustomerNote = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);
  const text = String(req.body?.text || "").trim();
  if (!text) {
    throw new AppError(httpStatus.BAD_REQUEST, "Note text is required");
  }
  if (text.length > 2000) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Note is too long (maximum 2000 characters)"
    );
  }
  const note = await CustomerNote.create({
    customer: customer._id,
    author: req.user._id,
    text,
  });
  await recordActivity({
    req,
    action: "customer.note_added",
    entityType: "user",
    entityId: customer._id,
    metadata: { noteId: note._id },
  });
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Note added",
    data: {
      _id: note._id,
      text: note.text,
      authorName: req.user.name || "Admin",
      authorRole: req.user.role || "",
      createdAt: note.createdAt,
    },
  });
});

export const deleteCustomerNote = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);
  const note = await CustomerNote.findOne({
    _id: req.params.noteId,
    customer: customer._id,
  });
  if (!note) {
    throw new AppError(httpStatus.NOT_FOUND, "Note not found");
  }
  await note.deleteOne();
  await recordActivity({
    req,
    action: "customer.note_deleted",
    entityType: "user",
    entityId: customer._id,
    metadata: { noteId: note._id },
  });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Note deleted",
    data: { _id: note._id },
  });
});

// POST /admin/customers/:id/message — app inbox (Notification) + FCM push,
// providers wala hi pattern.
export const sendCustomerMessage = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);
  const title = String(req.body?.title || "").trim() || "Message from OWVO";
  const message = String(req.body?.message || "").trim();
  if (!message) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message is required");
  }
  if (message.length > 1000) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Message is too long (maximum 1000 characters)"
    );
  }

  await Notification.create({
    recipient: customer._id,
    type: "general",
    title,
    message,
    sentBy: req.user._id,
    metadata: { source: "admin_panel" },
  });
  notifyUser(customer._id.toString(), {
    title,
    body: message,
    data: { type: "admin_message" },
  });
  await recordActivity({
    req,
    action: "customer.message_sent",
    entityType: "user",
    entityId: customer._id,
    metadata: { title },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Message sent to customer",
    data: { customerId: customer._id },
  });
});

// POST /admin/customers/:id/reset-password — mojooda OTP reset flow ko admin
// se trigger karna (auth controller ke forgetPassword wala hi tareeqa):
// OTP banta hai, token save hota hai, email jata hai.
export const sendCustomerResetPassword = catchAsync(async (req, res) => {
  const customer = await findCustomerDoc(req.params.id);
  const otp = generateOTP();
  const otpToken = createToken(
    { otp },
    process.env.OTP_SECRET,
    process.env.OTP_EXPIRE
  );
  customer.password_reset_token = otpToken;
  await customer.save();
  await sendEmail(customer.email, "Reset Password", `Your OTP is ${otp}`);

  await recordActivity({
    req,
    action: "customer.reset_password_sent",
    entityType: "user",
    entityId: customer._id,
    metadata: { email: customer.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password reset OTP sent to the customer's email",
    data: { customerId: customer._id },
  });
});

export const getAdminServicesPricing = catchAsync(async (req, res) => {
  const [catalogServices, settings] = await Promise.all([
    ensureDefaultServices(),
    getPlatformSettingsDoc(),
  ]);
  const providers = await User.find({ role: "provider" })
    .select("_id name email serviceArea accountStatus adminVerification dailyWashLimit dailyWashLimitMax isOnline")
    .sort({ createdAt: -1 })
    .lean();

  await Promise.all(providers.map((provider) => ensureProviderServices(provider._id)));

  const providerServices = await Service.find({
    provider: { $ne: null },
    catalogKey: { $exists: true },
  })
    .populate("provider", "_id name email serviceArea")
    .sort({ createdAt: -1 })
    .lean();

  const countsByProvider = providerServices.reduce((map, service) => {
    const providerId = service.provider?._id?.toString() || service.provider?.toString();
    if (!providerId) return map;

    const current = map.get(providerId) || { total: 0, active: 0, inactive: 0 };
    current.total += 1;
    if (service.isActive) current.active += 1;
    else current.inactive += 1;
    map.set(providerId, current);
    return map;
  }, new Map());

  const providerSummaries = providers.map((provider) => ({
    provider,
    counts: countsByProvider.get(provider._id.toString()) || {
      total: 0,
      active: 0,
      inactive: 0,
    },
    dailyWashLimit: buildProviderDailyWashLimitPayload(provider, settings),
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Services and pricing fetched successfully",
    data: {
      catalogServices,
      platformSettings: {
        dailyWashLimitMax: getPlatformDailyWashLimitMax(settings),
      },
      providerSummaries,
      providerServices,
    },
  });
});

export const updateAdminCatalogService = catchAsync(async (req, res) => {
  const { serviceId } = req.params;
  const service = await Service.findOne({ _id: serviceId, ...globalServiceFilter });

  if (!service) {
    throw new AppError(httpStatus.NOT_FOUND, "Catalog service not found");
  }

  const wasActive = service.isActive !== false;

  serviceEditableFields.forEach((field) => {
    if (req.body?.[field] !== undefined) {
      service[field] = field === "price" ? asMoney(req.body[field]) : req.body[field];
    }
  });

  if (!service.price || service.price <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Service price must be greater than 0");
  }

  await service.save();

  const providerUpdate = {
    serviceType: service.serviceType,
    title: service.title,
    price: service.price,
    carSize: service.carSize,
    carName: service.carName,
    carModel: service.carModel,
    description: service.description,
  };

  const nowActive = service.isActive !== false;
  if (req.body?.isActive !== undefined && nowActive !== wasActive) {
    providerUpdate.isActive = nowActive;
  }

  const providerServices = await Service.find({ catalogKey: service.catalogKey, provider: { $ne: null } });
  const providerIds = [...new Set(providerServices.map((item) => item.provider?.toString()).filter(Boolean))];

  await Service.updateMany(
    { catalogKey: service.catalogKey, provider: { $ne: null } },
    { $set: providerUpdate }
  );
  await Promise.all(providerIds.map((providerId) => syncProviderPreferredServices(providerId)));

  await recordActivity({
    req,
    action: "service_catalog.updated",
    entityType: "service",
    entityId: service._id,
    metadata: {
      catalogKey: service.catalogKey,
      title: service.title,
      price: service.price,
      providerServicesUpdated: providerServices.length,
    },
  });

  broadcast("admin_services_pricing_updated", {
    serviceId: service._id,
    catalogKey: service.catalogKey,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Catalog service updated successfully",
    data: service,
  });
});

const SERVICE_TYPES = ["basic", "standard", "premium"];
const CAR_SIZES = ["small", "medium", "high"];

const slugifyCatalogKey = (title) =>
  title
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "service";

const buildUniqueCatalogKey = async (title) => {
  const base = slugifyCatalogKey(title);
  let catalogKey = base;
  let suffix = 2;

  while (
    await Service.exists({ catalogKey, ...globalServiceFilter })
  ) {
    catalogKey = `${base}-${suffix}`;
    suffix += 1;
  }

  return catalogKey;
};

const propagateCatalogToProviders = async () => {
  const providers = await User.find({ role: "provider" }).select("_id").lean();
  await Promise.all(
    providers.map((provider) => ensureProviderServices(provider._id))
  );
};

export const createAdminCatalogService = catchAsync(async (req, res) => {
  const {
    title,
    serviceType,
    price,
    carSize,
    carName,
    carModel,
    description,
    isActive,
  } = req.body ?? {};

  const normalizedTitle = title?.toString().trim();
  if (!normalizedTitle) {
    throw new AppError(httpStatus.BAD_REQUEST, "Service title is required");
  }
  if (!SERVICE_TYPES.includes(serviceType)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `serviceType must be one of: ${SERVICE_TYPES.join(", ")}`
    );
  }
  if (!CAR_SIZES.includes(carSize)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `carSize must be one of: ${CAR_SIZES.join(", ")}`
    );
  }

  const normalizedPrice = asMoney(price);
  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Service price must be greater than 0"
    );
  }

  const catalogKey = await buildUniqueCatalogKey(normalizedTitle);

  const service = await Service.create({
    provider: null,
    catalogKey,
    serviceType,
    title: normalizedTitle,
    price: normalizedPrice,
    carSize,
    carName: carName?.toString().trim() || "Any car",
    carModel: carModel?.toString().trim() || "Any model",
    description: description?.toString().trim() || "",
    isActive: isActive === undefined ? true : Boolean(isActive),
  });

  await propagateCatalogToProviders();

  await recordActivity({
    req,
    action: "service_catalog.created",
    entityType: "service",
    entityId: service._id,
    metadata: {
      catalogKey: service.catalogKey,
      title: service.title,
      price: service.price,
    },
  });

  broadcast("admin_services_pricing_updated", {
    serviceId: service._id,
    catalogKey: service.catalogKey,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Catalog service created successfully",
    data: service,
  });
});

export const deleteAdminCatalogService = catchAsync(async (req, res) => {
  const { serviceId } = req.params;
  const service = await Service.findOne({
    _id: serviceId,
    ...globalServiceFilter,
  });

  if (!service) {
    throw new AppError(httpStatus.NOT_FOUND, "Catalog service not found");
  }

  const catalogKey = service.catalogKey;
  const deletedTitle = service.title;

  await Service.deleteOne({ _id: service._id });

  let providerCopiesRemoved = 0;
  let affectedProviderIds = [];
  if (catalogKey) {
    const providerCopies = await Service.find({
      catalogKey,
      provider: { $ne: null },
    }).select("provider");
    affectedProviderIds = [
      ...new Set(
        providerCopies.map((copy) => copy.provider?.toString()).filter(Boolean)
      ),
    ];
    const result = await Service.deleteMany({
      catalogKey,
      provider: { $ne: null },
    });
    providerCopiesRemoved = result.deletedCount || 0;
  }

  await Promise.all(
    affectedProviderIds.map((providerId) =>
      syncProviderPreferredServices(providerId)
    )
  );

  await recordActivity({
    req,
    action: "service_catalog.deleted",
    entityType: "service",
    entityId: service._id,
    metadata: {
      catalogKey,
      title: deletedTitle,
      providerCopiesRemoved,
    },
  });

  broadcast("admin_services_pricing_updated", {
    serviceId: service._id,
    catalogKey,
    deleted: true,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Catalog service deleted successfully",
    data: null,
  });
});

export const updateAdminProviderService = catchAsync(async (req, res) => {
  const { providerId, serviceId } = req.params;
  const service = await Service.findOne({
    _id: serviceId,
    provider: providerId,
  });

  if (!service) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider service not found");
  }

  if (req.body?.isActive !== undefined) {
    service.isActive = Boolean(req.body.isActive);
  }

  await service.save();
  await syncProviderPreferredServices(providerId);

  await recordActivity({
    req,
    action: "provider_service.updated",
    entityType: "service",
    entityId: service._id,
    metadata: {
      providerId,
      catalogKey: service.catalogKey,
      isActive: service.isActive,
    },
  });

  broadcast("admin_services_pricing_updated", {
    serviceId: service._id,
    providerId,
    isActive: service.isActive,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider service updated successfully",
    data: service,
  });
});

export const updateProviderDailyWashLimit = catchAsync(async (req, res) => {
  const { providerId } = req.params;
  const dailyWashLimitMax = parseDailyWashLimitMax(req.body?.dailyWashLimitMax);

  const provider = await User.findOne({ _id: providerId, role: "provider" });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  const counts = await getProviderCompletedJobCounts([provider._id]);
  const completedToday = counts.get(provider._id.toString())?.today || 0;
  const remaining = Math.max(dailyWashLimitMax - completedToday, 0);

  provider.dailyWashLimitMax = dailyWashLimitMax;
  provider.dailyWashLimit = remaining;
  if (remaining <= 0) {
    provider.isOnline = false;
    provider.isBusy = false;
  }

  await User.updateOne(
    { _id: provider._id },
    {
      $set: {
        dailyWashLimitMax,
        dailyWashLimit: remaining,
        isOnline: provider.isOnline,
        isBusy: provider.isBusy,
      },
    }
  );
  const settings = await getPlatformSettingsDoc();
  const dailyWashLimit = buildProviderDailyWashLimitPayload(provider, settings, completedToday);

  await recordActivity({
    req,
    action: "provider.daily_wash_limit_updated",
    entityType: "user",
    entityId: provider._id,
    metadata: {
      providerId: provider._id.toString(),
      dailyWashLimitMax,
      completedToday,
      remaining,
    },
  });

  broadcast("admin_services_pricing_updated", {
    providerId: provider._id.toString(),
    dailyWashLimit,
  });
  emitToUser(provider._id.toString(), "provider_daily_wash_limit_update", {
    providerId: provider._id.toString(),
    dailyWashLimit,
    message: "Your daily wash limit has been updated.",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider daily wash limit updated successfully",
    data: {
      provider: provider.toObject(),
      dailyWashLimit,
    },
  });
});
export const getAdminReports = catchAsync(async (req, res) => {
  const { status, type, limit = 50, page = 1 } = req.query;
  const filter = dateFilter("createdAt", req.query);

  if (status && ["open", "reviewing", "resolved", "dismissed"].includes(status)) {
    filter.status = status;
  }
  if (type && REPORT_TYPES.includes(type)) {
    filter.type = type;
  }

  const pageNumber = Math.max(Number(page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const [items, total] = await Promise.all([
    IssueReport.find(filter)
      .populate("reporter", "_id name email role phoneNumber photo")
      .populate("reportedUser", "_id name email role phoneNumber photo")
      .populate("booking", "_id status finalPrice bookingDate")
      .populate("assignedTo", "_id name email role")
      .sort({ createdAt: -1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize),
    IssueReport.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Reports fetched successfully",
    data: {
      items,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        pages: Math.ceil(total / pageSize),
      },
    },
  });
});

export const getAdminReportPhoto = catchAsync(async (req, res) => {
  const { reportId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(reportId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid report id");
  }

  const report = await IssueReport.findById(reportId).select("photo").lean();
  const photoUrl = report?.photo?.url?.toString().trim();
  if (!photoUrl) {
    throw new AppError(httpStatus.NOT_FOUND, "Report photo not found");
  }

  const localPath = resolveLocalUploadPath(photoUrl);
  if (localPath) {
    if (!fs.existsSync(localPath)) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        "Report photo file is no longer available on the server"
      );
    }

    const extension = path.extname(localPath).toLowerCase();
    res.setHeader("Content-Type", IMAGE_CONTENT_TYPES[extension] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.sendFile(localPath);
  }

  if (!/^https?:\/\//i.test(photoUrl)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Unsupported report photo source");
  }

  const response = await fetch(photoUrl);
  if (!response.ok) {
    throw new AppError(httpStatus.BAD_GATEWAY, "Unable to load report photo");
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new AppError(httpStatus.BAD_GATEWAY, "Report photo source is not an image");
  }

  const arrayBuffer = await response.arrayBuffer();
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(httpStatus.OK).send(Buffer.from(arrayBuffer));
});

export const updateAdminReportStatus = catchAsync(async (req, res) => {
  const { reportId } = req.params;
  const { status, resolutionNote = "", assignedTo = null } = req.body || {};

  if (!["open", "reviewing", "resolved", "dismissed"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid report status");
  }

  const report = await IssueReport.findById(reportId);
  if (!report) {
    throw new AppError(httpStatus.NOT_FOUND, "Report not found");
  }

  report.status = status;
  report.resolutionNote = resolutionNote.toString().trim();
  report.updatedBy = req.user._id;

  if (assignedTo && mongoose.Types.ObjectId.isValid(assignedTo)) {
    const assignee = await User.findOne({
      _id: assignedTo,
      role: { $in: DASHBOARD_ROLES },
    });
    if (!assignee) {
      throw new AppError(httpStatus.BAD_REQUEST, "Assigned user is not dashboard staff");
    }
    report.assignedTo = assignee._id;
  }

  await report.save();
  await recordActivity({
    req,
    action: "report.status_updated",
    entityType: "issue_report",
    entityId: report._id,
    metadata: { status, assignedTo, resolutionNote },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Report updated successfully",
    data: report,
  });
});

export const getStaffAccounts = catchAsync(async (req, res) => {
  const staff = await User.find(mergeFilter({ role: "staff" }, "createdAt", req.query))
    .select(dashboardUserSelect)
    .sort({
      createdAt: -1,
    });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff accounts fetched successfully",
    data: staff,
  });
});

export const createStaffAccount = catchAsync(async (req, res) => {
  const { name = "", email, password, staffPermissions = {} } = req.body || {};

  if (!email || !password) {
    throw new AppError(httpStatus.BAD_REQUEST, "Email and password are required");
  }

  const existing = await User.findOne({ email: email.toString().trim().toLowerCase() });
  if (existing) {
    throw new AppError(httpStatus.CONFLICT, "User already exists");
  }

  const staff = await User.create({
    name,
    email,
    password,
    role: "staff",
    accountStatus: "active",
    staffPermissions: {
      menus: Array.isArray(staffPermissions.menus)
        ? staffPermissions.menus.filter((menu) => STAFF_MENUS.includes(menu))
        : ["bookings"],
      actions: Array.isArray(staffPermissions.actions)
        ? staffPermissions.actions
        : ["booking.status.update"],
    },
    verificationInfo: {
      verified: true,
      token: "",
    },
    isEmailVerified: true,
  });

  await recordActivity({
    req,
    action: "staff.created",
    entityType: "user",
    entityId: staff._id,
    metadata: { email: staff.email },
  });

  const data = await User.findById(staff._id).select(dashboardUserSelect);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Staff account created successfully",
    data,
  });
});

export const updateStaffAccount = catchAsync(async (req, res) => {
  const { staffId } = req.params;
  const { name, accountStatus, staffPermissions } = req.body || {};

  const staff = await User.findOne({ _id: staffId, role: "staff" });
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }

  if (name !== undefined) staff.name = name.toString().trim();
  if (accountStatus !== undefined) {
    if (!["active", "disabled"].includes(accountStatus)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid account status");
    }
    staff.accountStatus = accountStatus;
  }
  if (staffPermissions !== undefined) {
    staff.staffPermissions = {
      menus: Array.isArray(staffPermissions.menus)
        ? staffPermissions.menus.filter((menu) => STAFF_MENUS.includes(menu))
        : staff.staffPermissions?.menus || ["bookings"],
      actions: Array.isArray(staffPermissions.actions)
        ? staffPermissions.actions
        : staff.staffPermissions?.actions || ["booking.status.update"],
    };
  }

  await staff.save();
  await recordActivity({
    req,
    action: "staff.updated",
    entityType: "user",
    entityId: staff._id,
    metadata: { name, accountStatus },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff account updated successfully",
    data: staff,
  });
});

export const disableStaffAccount = catchAsync(async (req, res) => {
  const { staffId } = req.params;

  const staff = await User.findOne({ _id: staffId, role: "staff" });
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }

  staff.accountStatus = "disabled";
  await staff.save();
  await recordActivity({
    req,
    action: "staff.disabled",
    entityType: "user",
    entityId: staff._id,
    metadata: { email: staff.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff access disabled successfully",
    data: staff,
  });
});

export const deleteStaffAccount = catchAsync(async (req, res) => {
  const { staffId } = req.params;

  const staff = await User.findOne({ _id: staffId, role: "staff" });
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }

  await User.deleteOne({ _id: staff._id, role: "staff" });
  await recordActivity({
    req,
    action: "staff.deleted",
    entityType: "user",
    entityId: staff._id,
    metadata: { email: staff.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff account deleted successfully",
    data: { staffId },
  });
});

export const getActivityLogs = catchAsync(async (req, res) => {
  const { action, limit = 100 } = req.query;
  const filter = dateFilter("createdAt", req.query);
  if (action) filter.action = action;

  const logs = await ActivityLog.find(filter)
    .populate("actor", "_id name email role")
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 100, 200));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Activity logs fetched successfully",
    data: logs,
  });
});

export const getAdminPayments = catchAsync(async (req, res) => {
  const { status, type, limit = 100 } = req.query;
  const filter = dateFilter("createdAt", req.query);

  if (status && ["success", "failed", "pending"].includes(status)) {
    filter.status = status;
  }
  if (type && ["booking", "tips", "donation"].includes(type)) {
    filter.type = type;
  }

  const payments = await paymentInfo
    .find(filter)
    .populate("userId", "_id name email role")
    .populate("providerId", "_id name email role")
    .populate("bookingId", "_id status finalPrice bookingDate")
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 100, 200));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payments fetched successfully",
    data: payments,
  });
});

// ─── Earnings v2 helpers ────────────────────────────────────────
// Har number snapshot par mabni hai (money.util ke usool) — rate
// badalne se purani kamai kabhi nahi badalti.
const EARN_LONDON_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const earnDayKey = (date) => EARN_LONDON_FMT.format(new Date(date));
const earnWeekKey = (date) => {
  const [y, m, d] = earnDayKey(date).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
};
const earnMonthKey = (date) => earnDayKey(date).slice(0, 7);
const earnBucketLabel = (key, granularity) => {
  if (granularity === "monthly") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const [y, m, d] = key.split("-").map(Number);
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
  return granularity === "weekly" ? `W/c ${label}` : label;
};

// Range ki completed bookings ki earning entries — tip, payout
// coverage, hold aur refund reversal ke sath. List aur CSV export
// dono yahi istemal karte hain taake hisaab ek hi rahe.
const buildEarningEntries = async (query = {}) => {
  const rangeFilter = dateFilter("completedAt", query);
  const bookings = await Booking.find({ status: "completed", ...rangeFilter })
    .populate("user", "_id name email")
    .populate("provider", "_id name email")
    .populate("service", "_id title serviceType")
    .sort({ completedAt: -1, updatedAt: -1 })
    .limit(5000)
    .lean();
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;
  const bookingIds = bookings.map((booking) => booking._id);

  const [tipsAgg, payouts, refunds, openDisputes] = await Promise.all([
    bookingIds.length
      ? paymentInfo.aggregate([
          {
            $match: {
              bookingId: { $in: bookingIds },
              type: "tips",
              paymentStatus: "complete",
            },
          },
          { $group: { _id: "$bookingId", total: { $sum: "$price" } } },
        ])
      : [],
    Payout.find({
      source: { $ne: "bonus" },
      status: { $in: ["paid", "processing", "pending"] },
    })
      .select("bookingIds status")
      .lean(),
    Refund.find({ status: "refunded" })
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

  const tipByBooking = new Map(
    tipsAgg.map((row) => [row._id.toString(), asMoney(row.total)])
  );
  const coverageRank = { pending: 1, processing: 2, paid: 3 };
  const coverage = new Map();
  for (const payout of payouts) {
    for (const id of payout.bookingIds || []) {
      const key = id.toString();
      if ((coverageRank[payout.status] || 0) > (coverageRank[coverage.get(key)] || 0)) {
        coverage.set(key, payout.status);
      }
    }
  }
  const reversalByBooking = new Map();
  for (const refund of refunds) {
    const key = refund.booking?.toString();
    if (key) {
      reversalByBooking.set(
        key,
        asMoney(
          (reversalByBooking.get(key) || 0) +
            asMoney(refund.earningReversal?.amount || 0)
        )
      );
    }
  }
  const disputedBookings = new Set(
    openDisputes.map((ticket) => ticket.booking?.toString()).filter(Boolean)
  );

  const entries = bookings.map((booking) => {
    const grossAmount = asMoney(booking.finalPrice || booking.price || 0);
    const hasSnapshot =
      booking.providerNetAmount !== null &&
      booking.providerNetAmount !== undefined;
    const entryCommission = hasSnapshot
      ? asMoney(booking.commissionAmount)
      : asMoney(grossAmount * (booking.commissionRate ?? commissionRate));
    const netAmount = hasSnapshot
      ? asMoney(booking.providerNetAmount)
      : asMoney(grossAmount - entryCommission);
    const key = booking._id.toString();
    const tip = tipByBooking.get(key) || 0;
    const reversalAmount = reversalByBooking.get(key) || 0;
    const manualHold = booking.earningHold?.active ? booking.earningHold : null;
    const disputeHeld = disputedBookings.has(key);

    // Status ki tartib: refund sab se pehle, phir hold, phir payout.
    let status = "Available";
    if (reversalAmount > 0 || booking.refund?.status === "refunded") {
      status = "Refunded";
    } else if (disputeHeld || manualHold) {
      status = "On Hold";
    } else if (coverage.get(key) === "paid") {
      status = "Paid Out";
    } else if (coverage.get(key)) {
      status = "Processing";
    }

    return {
      bookingId: booking._id,
      displayId: `#${key.slice(-6).toUpperCase()}`,
      date: booking.completedAt || booking.updatedAt,
      customer: booking.user,
      provider: booking.provider,
      service: booking.service,
      grossAmount,
      commissionRate: booking.commissionRate ?? commissionRate,
      hasSnapshot,
      commissionAmount: entryCommission,
      netAmount,
      tip,
      reversalAmount,
      totalToProvider: asMoney(Math.max(netAmount - reversalAmount, 0) + tip),
      currency: booking.currency || "GBP",
      status,
      hold: manualHold
        ? {
            source: "manual",
            amount: manualHold.amount,
            reason: manualHold.reason || "",
            at: manualHold.at,
          }
        : disputeHeld
          ? { source: "dispute", amount: netAmount, reason: "Open dispute" }
          : null,
    };
  });

  return { entries, commissionRate };
};

const earnFilterEntries = (entries, query = {}) => {
  const search = (query.search || "").toString().trim().toLowerCase();
  const providerId = (query.providerId || "").toString();
  let filtered = entries;
  if (providerId) {
    filtered = filtered.filter(
      (entry) => entry.provider?._id?.toString() === providerId
    );
  }
  if (search) {
    filtered = filtered.filter((entry) =>
      [
        entry.customer?.name,
        entry.customer?.email,
        entry.provider?.name,
        entry.provider?.email,
        entry.displayId,
        entry.bookingId?.toString(),
      ].some((value) => (value || "").toLowerCase().includes(search))
    );
  }
  return filtered;
};

export const getAdminEarnings = catchAsync(async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const { entries, commissionRate } = await buildEarningEntries(req.query);
  const filtered = earnFilterEntries(entries, req.query);

  const sumOf = (list, field) =>
    asMoney(list.reduce((sum, entry) => sum + (entry[field] || 0), 0));
  const rangeTotals = {
    gross: sumOf(filtered, "grossAmount"),
    commission: sumOf(filtered, "commissionAmount"),
    providerNet: sumOf(filtered, "netAmount"),
    tips: sumOf(filtered, "tip"),
    jobs: filtered.length,
  };

  // Refunds (ledger) aur paid payouts — range ke andar.
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const inRange = (value) => {
    if (!value) return false;
    const time = new Date(value).getTime();
    if (from && time < from.getTime()) return false;
    if (to && time > to.getTime()) return false;
    return true;
  };
  const [refundedRows, paidPayoutRows] = await Promise.all([
    Refund.find({ status: "refunded" })
      .select("amount refundedAt createdAt")
      .lean(),
    Payout.find({ status: "paid", source: { $ne: "bonus" } })
      .select("amount paidAt updatedAt createdAt")
      .lean(),
  ]);
  const rangeRefunds = refundedRows.filter((row) =>
    inRange(row.refundedAt || row.createdAt)
  );
  const refundsTotal = asMoney(
    rangeRefunds.reduce((sum, row) => sum + asMoney(row.amount), 0)
  );
  const paidOut = asMoney(
    paidPayoutRows
      .filter((row) => inRange(row.paidAt || row.updatedAt || row.createdAt))
      .reduce((sum, row) => sum + asMoney(row.amount), 0)
  );

  // Rozana / haftawar / mahana series (Europe/London din).
  const granularity = ["daily", "weekly", "monthly"].includes(
    req.query.granularity
  )
    ? req.query.granularity
    : "daily";
  const bucketOf =
    granularity === "weekly"
      ? earnWeekKey
      : granularity === "monthly"
        ? earnMonthKey
        : earnDayKey;
  const buckets = new Map();
  const bucketFor = (date) => {
    const key = bucketOf(date);
    if (!buckets.has(key)) {
      buckets.set(key, { key, gross: 0, commission: 0, refunds: 0 });
    }
    return buckets.get(key);
  };
  for (const entry of filtered) {
    const bucket = bucketFor(entry.date);
    bucket.gross = asMoney(bucket.gross + entry.grossAmount);
    bucket.commission = asMoney(bucket.commission + entry.commissionAmount);
  }
  for (const row of rangeRefunds) {
    const bucket = bucketFor(row.refundedAt || row.createdAt);
    bucket.refunds = asMoney(bucket.refunds + asMoney(row.amount));
  }
  const series = [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((bucket) => ({
      ...bucket,
      label: earnBucketLabel(bucket.key, granularity),
    }));

  // Per-provider rollup: range ke hisaab + kul available (all-time).
  const byProvider = new Map();
  for (const entry of filtered) {
    const pid = entry.provider?._id?.toString();
    if (!pid) continue;
    if (!byProvider.has(pid)) {
      byProvider.set(pid, {
        provider: entry.provider,
        jobs: 0,
        gross: 0,
        commission: 0,
        net: 0,
        tips: 0,
      });
    }
    const row = byProvider.get(pid);
    row.jobs += 1;
    row.gross = asMoney(row.gross + entry.grossAmount);
    row.commission = asMoney(row.commission + entry.commissionAmount);
    row.net = asMoney(row.net + entry.netAmount);
    row.tips = asMoney(row.tips + entry.tip);
  }
  const providers = await Promise.all(
    [...byProvider.values()].map(async (row) => {
      const balances = await computeProviderBalances(
        row.provider._id.toString()
      );
      return {
        ...row,
        paidOut: balances.paidOut,
        heldAmount: balances.heldAmount,
        manualAdjustments: balances.manualAdjustments,
        available: balances.available,
      };
    })
  );
  providers.sort((a, b) => b.gross - a.gross);

  // Pending payouts = is waqt kul payable (range se bahar, asal halat).
  const allProviderIds = await Booking.distinct("provider", {
    status: "completed",
  });
  let pendingPayouts = 0;
  await Promise.all(
    allProviderIds.map(async (pid) => {
      const balances = await computeProviderBalances(pid.toString());
      pendingPayouts = asMoney(pendingPayouts + balances.available);
    })
  );

  const sumEntries = (predicate) => {
    const list = entries.filter(predicate);
    return {
      grossAmount: sumOf(list, "grossAmount"),
      commissionAmount: sumOf(list, "commissionAmount"),
      netAmount: sumOf(list, "netAmount"),
    };
  };
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 20, 1),
    100
  );
  const total = filtered.length;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Earnings fetched successfully",
    data: {
      commissionRate,
      summary: {
        today: sumEntries((entry) => new Date(entry.date) >= todayStart),
        week: sumEntries((entry) => new Date(entry.date) >= weekStart),
        month: sumEntries((entry) => new Date(entry.date) >= monthStart),
        period: {
          grossAmount: rangeTotals.gross,
          commissionAmount: rangeTotals.commission,
          netAmount: rangeTotals.providerNet,
        },
        netProfit: rangeTotals.commission,
        pendingNet: asMoney(
          Math.max(rangeTotals.providerNet - paidOut, 0)
        ),
        paidOut,
        range: {
          gross: rangeTotals.gross,
          commission: rangeTotals.commission,
          providerNet: rangeTotals.providerNet,
          tips: rangeTotals.tips,
          jobs: rangeTotals.jobs,
          refunds: refundsTotal,
          refundsCount: rangeRefunds.length,
          paidOut,
          effectiveRate:
            rangeTotals.gross > 0
              ? asMoney((rangeTotals.commission / rangeTotals.gross) * 100)
              : 0,
        },
        pendingPayouts,
      },
      series,
      providers,
      entries: filtered.slice((page - 1) * limit, page * limit),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    },
  });
});

export const getAdminPayouts = catchAsync(async (req, res) => {
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;
  const payoutRangeFilter = dateFilter("createdAt", req.query);
  const completedRangeFilter = dateFilter("completedAt", req.query);
  const [payouts, earningsData, payoutBalanceData, stripeBalance] = await Promise.all([
    Payout.find(payoutRangeFilter)
      .populate("provider", "_id name email stripeConnect")
      .populate("createdBy", "_id name email role")
      .populate("updatedBy", "_id name email role")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean(),
    Booking.aggregate([
      { $match: { status: "completed", ...completedRangeFilter } },
      {
        $group: {
          _id: "$provider",
          grossAmount: { $sum: "$finalPrice" },
          commissionTotal: {
            $sum: {
              $ifNull: [
                "$commissionAmount",
                {
                  $multiply: [
                    "$finalPrice",
                    { $ifNull: ["$commissionRate", commissionRate] },
                  ],
                },
              ],
            },
          },
          jobs: { $sum: 1 },
        },
      },
      { $sort: { grossAmount: -1 } },
    ]),
    Payout.aggregate([
      {
        $match: {
          status: { $ne: "failed" },
          ...payoutRangeFilter,
        },
      },
      {
        $group: {
          _id: "$provider",
          paidOut: {
            $sum: {
              $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0],
            },
          },
          pendingOut: {
            $sum: {
              $cond: [
                { $in: ["$status", ["pending", "processing"]] },
                "$amount",
                0,
              ],
            },
          },
        },
      },
    ]),
    getStripeBalanceSnapshot(),
  ]);

  const providers = await User.find({
    _id: { $in: earningsData.map((entry) => entry._id).filter(Boolean) },
  })
    .select("_id name email stripeConnect")
    .lean();
  const providerMap = new Map(providers.map((provider) => [provider._id.toString(), provider]));
  const payoutBalanceMap = new Map(
    payoutBalanceData.map((entry) => [
      entry._id?.toString(),
      {
        paidOut: asMoney(entry.paidOut),
        pendingOut: asMoney(entry.pendingOut),
      },
    ])
  );

  const providerBalances = earningsData.map((entry) => {
    const providerId = entry._id?.toString();
    const grossAmount = asMoney(entry.grossAmount);
    const commissionAmount = asMoney(entry.commissionTotal || 0);
    const netAmount = asMoney(grossAmount - commissionAmount);
    const payoutTotals = payoutBalanceMap.get(providerId) || {
      paidOut: 0,
      pendingOut: 0,
    };

    return {
      provider: providerId ? providerMap.get(providerId) : null,
      jobs: entry.jobs,
      grossAmount,
      commissionAmount,
      netAmount,
      paidOut: payoutTotals.paidOut,
      pendingOut: payoutTotals.pendingOut,
      // Pending/processing payouts ko bhi minus karte hain — warna admin
      // ek aisa paisa "payable" dekh sakta hai jo pehle se kisi payout
      // mein queue ho chuka hai, aur galti se dobara pay kar sakta hai.
      // Provider ke apne wallet (/washers/wallet/summary) mein bhi yehi
      // hisaab hai — dono hamesha match karenge.
      payableAmount: asMoney(
        Math.max(netAmount - payoutTotals.paidOut - payoutTotals.pendingOut, 0)
      ),
    };
  });

  const statusTotals = payouts.reduce(
    (totals, payout) => {
      totals[payout.status] = asMoney((totals[payout.status] || 0) + payout.amount);
      return totals;
    },
    { pending: 0, processing: 0, paid: 0, failed: 0 }
  );
  const manualTotals = providerBalances.reduce(
    (totals, balance) => ({
      unpaidAmount: asMoney(totals.unpaidAmount + balance.payableAmount),
      paidAmount: asMoney(totals.paidAmount + balance.paidOut),
      unpaidProviders: totals.unpaidProviders + (balance.payableAmount > 0 ? 1 : 0),
      paidProviders: totals.paidProviders + (balance.payableAmount <= 0 && balance.netAmount > 0 ? 1 : 0),
    }),
    { unpaidAmount: 0, paidAmount: 0, unpaidProviders: 0, paidProviders: 0 }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payouts fetched successfully",
    data: {
      payouts,
      providerBalances,
      statusTotals,
      manualTotals,
      commissionRate,
      stripe: {
        dashboardUrl: settings.stripeDashboardUrl,
        accountId: settings.stripeAccountId,
        payoutsEnabled: Boolean(settings.stripePayoutsEnabled),
        balance: stripeBalance,
      },
    },
  });
});

export const createAdminPayout = catchAsync(async (req, res) => {
  const {
    providerId,
    amount,
    currency = "GBP",
    payoutDate,
    status = "paid",
    manualAdjustmentReason = "",
    autoAttempt = false,
  } = req.body || {};
  const payoutAmount = asMoney(amount);
  const payoutCurrency = currency.toString().trim().toUpperCase() || "GBP";

  if (!mongoose.Types.ObjectId.isValid(providerId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid providerId");
  }

  if (!payoutAmount || payoutAmount <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Payout amount must be greater than 0");
  }

  if (!["pending", "processing", "paid", "failed"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid payout status");
  }

  const provider = await User.findById(providerId);
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider record not found");
  }

  // Unified hisaab (money.util): snapshot earnings + tips − refunds
  // − dispute holds − pehle ke payouts (bonus alag). Admin is se
  // zyada ka payout nahi bana sakta — double-pay namumkin.
  const balances = await computeProviderBalances(provider._id);
  const payableAmount = balances.available;

  if (payoutAmount > payableAmount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Payout exceeds provider's available balance (${payoutCurrency} ${payableAmount.toFixed(2)}). This already accounts for any pending payouts.`
    );
  }

  const unpaidRows = await getUnpaidBookingEarnings(provider._id);

  let payout = await Payout.create({
    provider: provider._id,
    amount: payoutAmount,
    currency: payoutCurrency,
    status,
    payoutDate: payoutDate ? new Date(payoutDate) : undefined,
    paidAt: status === "paid" ? new Date() : undefined,
    stripeDestinationAccountId: "",
    stripeMode: "manual",
    mode: "manual",
    source: "booking",
    bookingIds: unpaidRows
      .filter((row) => !row.held)
      .map((row) => row.bookingId),
    manualAdjustmentReason:
      manualAdjustmentReason?.toString?.().trim() ||
      "Manual provider payout recorded by admin",
    attempts: [
      {
        action: "admin_created",
        result: status,
        note: manualAdjustmentReason?.toString?.().trim() || "",
        by: req.user._id,
      },
    ],
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  // Admin chahe to pending payout par foran automatic transfer ki
  // koshish bhi ho jaye (Connect tayyar ho tab hi kuch hota hai).
  if (autoAttempt && status === "pending") {
    const attempt = await attemptPayoutTransfer(payout);
    payout = attempt.payout;
  }

  await recordActivity({
    req,
    action: "payout.created",
    entityType: "payout",
    entityId: payout._id,
    metadata: {
      providerId,
      amount: payoutAmount,
      status: payout.status,
      stripeMode: payout.stripeMode,
    },
  });
  broadcast("admin_payout_updated", { payoutId: payout._id, status: payout.status });

  const data = await Payout.findById(payout._id)
    .populate("provider", "_id name email stripeConnect")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Payout created successfully",
    data,
  });
});

export const updateAdminPayoutStatus = catchAsync(async (req, res) => {
  const { payoutId } = req.params;
  const { status, failureReason = "" } = req.body || {};

  if (!["pending", "processing", "paid", "failed"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid payout status");
  }

  const payout = await Payout.findById(payoutId);
  if (!payout) {
    throw new AppError(httpStatus.NOT_FOUND, "Payout not found");
  }

  // Transition matrix — paid final hai; automatic processing ke
  // darmiyan haath se paid karna double-pay ka khatra hai (block).
  const from = payout.status;
  const allowed = {
    pending: ["processing", "paid", "failed"],
    processing: payout.mode === "auto" ? [] : ["paid", "failed"],
    failed: ["pending", "paid"],
    paid: [],
  };
  if (from === status) {
    throw new AppError(httpStatus.BAD_REQUEST, `Payout is already ${status}.`);
  }
  if (!(allowed[from] || []).includes(status)) {
    if (from === "processing" && payout.mode === "auto") {
      throw new AppError(
        httpStatus.CONFLICT,
        "This payout is being processed by Stripe — wait for its result before taking any action (marking it paid by hand could pay the provider twice)."
      );
    }
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `A ${from} payout cannot be changed to ${status}.`
    );
  }
  if (status === "failed" && !failureReason.toString().trim()) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A reason is required when marking a payout as failed."
    );
  }

  payout.status = status;
  payout.failureReason = status === "failed" ? failureReason.toString().trim() : "";
  payout.paidAt = status === "paid" ? new Date() : payout.paidAt;
  payout.updatedBy = req.user._id;
  payout.attempts.push({
    action: `status_${from}_to_${status}`,
    result: status,
    note: status === "failed" ? payout.failureReason : "",
    by: req.user._id,
  });
  await payout.save();

  await recordActivity({
    req,
    action: "payout.status_updated",
    entityType: "payout",
    entityId: payout._id,
    metadata: { status, failureReason },
  });
  broadcast("admin_payout_updated", { payoutId: payout._id, status: payout.status });

  // 🔔 Push to provider when payout is paid or failed.
  if ((status === "paid" || status === "failed") && payout.provider) {
    notifyUser(payout.provider.toString(), {
      title: status === "paid" ? "Payout sent! 💸" : "Payout failed",
      body:
        status === "paid"
          ? `Your payout of £${payout.amount} has been sent.`
          : `Your payout of £${payout.amount} could not be processed.${payout.failureReason ? ` Reason: ${payout.failureReason}` : ""}`,
      data: {
        type: "payout_update",
        payoutId: payout._id.toString(),
        status,
      },
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payout updated successfully",
    data: payout,
  });
});

export const getAdminCommissionWithdrawals = catchAsync(async (req, res) => {
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;
  const withdrawalRangeFilter = dateFilter("createdAt", req.query);

  const [
    periodCompletedAgg,
    allCompletedAgg,
    periodWithdrawnAgg,
    allWithdrawnAgg,
    withdrawals,
    stripeBalance,
  ] = await Promise.all([
    Booking.aggregate([
      { $match: { status: "completed", ...dateFilter("completedAt", req.query) } },
      {
        $group: {
          _id: null,
          total: { $sum: {
              $ifNull: [
                "$commissionAmount",
                {
                  $multiply: [
                    "$finalPrice",
                    { $ifNull: ["$commissionRate", commissionRate] },
                  ],
                },
              ],
            } },
        },
      },
    ]),
    Booking.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          total: { $sum: {
              $ifNull: [
                "$commissionAmount",
                {
                  $multiply: [
                    "$finalPrice",
                    { $ifNull: ["$commissionRate", commissionRate] },
                  ],
                },
              ],
            } },
        },
      },
    ]),
    AdminWithdrawal.aggregate([
      { $match: { status: { $ne: "failed" }, ...withdrawalRangeFilter } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    AdminWithdrawal.aggregate([
      { $match: { status: { $ne: "failed" } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    AdminWithdrawal.find(withdrawalRangeFilter)
      .populate("requestedBy", "_id name email role")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    getStripeBalanceSnapshot(),
  ]);

  const periodCommission = asMoney(periodCompletedAgg[0]?.total || 0);
  const allCommission = asMoney(allCompletedAgg[0]?.total || 0);
  const periodWithdrawn = asMoney(periodWithdrawnAgg[0]?.total);
  const allWithdrawn = asMoney(allWithdrawnAgg[0]?.total);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin commission withdrawals fetched successfully",
    data: {
      summary: {
        commissionRate,
        periodCommission,
        periodWithdrawn,
        availableCommission: asMoney(Math.max(allCommission - allWithdrawn, 0)),
        allCommission,
        allWithdrawn,
      },
      stripe: {
        dashboardUrl: settings.stripeDashboardUrl,
        accountId: settings.stripeAccountId,
        payoutsEnabled: Boolean(settings.stripePayoutsEnabled),
        balance: stripeBalance,
      },
      withdrawals,
    },
  });
});

export const createAdminCommissionWithdrawal = catchAsync(async (req, res) => {
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;
  const amount = asMoney(req.body?.amount);
  const currency = req.body?.currency?.toString().trim().toUpperCase() || "GBP";

  if (!amount || amount <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Withdrawal amount must be greater than 0");
  }

  const [completedForCommission, allWithdrawnAgg] = await Promise.all([
    Booking.find({ status: "completed" })
      .select("finalPrice commissionAmount commissionRate")
      .lean(),
    AdminWithdrawal.aggregate([
      { $match: { status: { $ne: "failed" } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  // Commission snapshot par — rate badalne se purani kamai nahi badalti.
  const allCommission = asMoney(
    completedForCommission.reduce(
      (sum, booking) =>
        sum +
        (booking.commissionAmount !== null &&
        booking.commissionAmount !== undefined
          ? Number(booking.commissionAmount) || 0
          : (Number(booking.finalPrice) || 0) *
            (booking.commissionRate !== null &&
            booking.commissionRate !== undefined
              ? Number(booking.commissionRate)
              : commissionRate)),
      0
    )
  );
  const allWithdrawn = asMoney(allWithdrawnAgg[0]?.total);
  const availableCommission = asMoney(Math.max(allCommission - allWithdrawn, 0));

  if (amount > availableCommission) {
    throw new AppError(httpStatus.BAD_REQUEST, "Withdrawal amount exceeds available commission");
  }

  const withdrawal = await AdminWithdrawal.create({
    amount,
    currency,
    status: "requested",
    stripeAccountId: settings.stripeAccountId || "",
    stripeDashboardUrl: settings.stripeDashboardUrl || "https://dashboard.stripe.com/",
    requestedBy: req.user._id,
  });

  if (settings.stripePayoutsEnabled) {
    if (!process.env.STRIPE_SECRET_KEY) {
      withdrawal.status = "failed";
      withdrawal.failureReason = "STRIPE_SECRET_KEY is not configured";
      await withdrawal.save();
      throw new AppError(httpStatus.BAD_REQUEST, "Stripe secret key is not configured");
    }

    try {
      const payout = await getStripe().payouts.create({
        amount: Math.round(amount * 100),
        currency: currency.toLowerCase(),
        metadata: {
          source: "owvo_admin_commission",
          withdrawalId: withdrawal._id.toString(),
          requestedBy: req.user._id.toString(),
        },
      });

      withdrawal.stripePayoutId = payout.id;
      withdrawal.status = payout.status === "paid" ? "paid" : "processing";
      await withdrawal.save();
    } catch (error) {
      withdrawal.status = "failed";
      withdrawal.failureReason = error?.message || "Stripe payout failed";
      await withdrawal.save();
      throw new AppError(httpStatus.BAD_REQUEST, withdrawal.failureReason);
    }
  }

  await recordActivity({
    req,
    action: "admin_commission.withdrawal_requested",
    entityType: "admin_withdrawal",
    entityId: withdrawal._id,
    metadata: {
      amount,
      currency,
      status: withdrawal.status,
      stripePayoutId: withdrawal.stripePayoutId,
    },
  });
  broadcast("admin_payout_updated", { withdrawalId: withdrawal._id, status: withdrawal.status });

  const data = await AdminWithdrawal.findById(withdrawal._id)
    .populate("requestedBy", "_id name email role")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Admin commission withdrawal recorded successfully",
    data,
  });
});

export const getAdminNotifications = catchAsync(async (req, res) => {
  const createdRangeFilter = dateFilter("createdAt", req.query);
  const updatedRangeFilter = dateFilter("updatedAt", req.query);
  const labelFromValue = (value, fallback = "general") =>
    String(value || fallback)
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const shortId = (value) => value?.toString?.().slice(-6).toUpperCase() || "UNKNOWN";
  const dateValue = (value) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : new Date(0);
  };

  const [bookings, reports, payments, logs] = await Promise.all([
    Booking.find(updatedRangeFilter)
      .select("_id status finalPrice createdAt updatedAt")
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
    IssueReport.find(createdRangeFilter)
      .select("_id type status description createdAt")
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    paymentInfo.find(createdRangeFilter).select("_id status type price currency createdAt").sort({ createdAt: -1 }).limit(8).lean(),
    ActivityLog.find(createdRangeFilter).select("_id action entityType createdAt").sort({ createdAt: -1 }).limit(8).lean(),
  ]);

  const notifications = [
    ...bookings.map((booking) => ({
      id: `booking-${booking._id}`,
      type: "booking",
      title: "Booking activity",
      message: `Booking ${shortId(booking._id)} is ${labelFromValue(booking.status, "updated")}`,
      createdAt: booking.updatedAt || booking.createdAt,
      severity: booking.status === "cancelled" ? "warning" : "info",
    })),
    ...reports.map((report) => ({
      id: `report-${report._id}`,
      type: "report",
      title: "New report activity",
      message: `${labelFromValue(report.type)} report is ${labelFromValue(report.status, "open")}`,
      createdAt: report.createdAt,
      severity: report.status === "open" ? "warning" : "info",
    })),
    ...payments.map((payment) => ({
      id: `payment-${payment._id}`,
      type: "payment",
      title: "Payment activity",
      message: `${labelFromValue(payment.type, "booking")} payment ${labelFromValue(payment.status, "updated")} for ${payment.currency || "GBP"} ${Number(payment.price || 0).toFixed(2)}`,
      createdAt: payment.createdAt,
      severity: payment.status === "failed" ? "danger" : "success",
    })),
    ...logs.map((log) => ({
      id: `log-${log._id}`,
      type: "system",
      title: "System log",
      message: `${labelFromValue(log.action, "activity")} on ${labelFromValue(log.entityType, "system")}`,
      createdAt: log.createdAt,
      severity: "info",
    })),
  ].sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notifications fetched successfully",
    data: notifications.slice(0, 30),
  });
});

export const getDashboardSettings = catchAsync(async (req, res) => {
  const settings = await getPlatformSettingsDoc();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard settings fetched successfully",
    data: settings,
  });
});

export const updateDashboardSettings = catchAsync(async (req, res) => {
  const settings = await getPlatformSettingsDoc();
  const {
    commissionRate,
    providerVerificationRequired,
    dailyWashLimitMax,
    autoPayoutEnabled,
    nextPayoutDay,
    supportEmail,
    stripeDashboardUrl,
    stripeAccountId,
    stripePayoutsEnabled,
  } = req.body || {};
  let shouldSyncDailyWashLimit = false;
  let syncedDailyLimitProviders = 0;

  if (commissionRate !== undefined) {
    const parsedRate = Number(commissionRate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 1) {
      throw new AppError(httpStatus.BAD_REQUEST, "Commission rate must be between 0 and 1");
    }
    settings.commissionRate = parsedRate;
  }
  if (providerVerificationRequired !== undefined) {
    settings.providerVerificationRequired = Boolean(providerVerificationRequired);
  }
  if (dailyWashLimitMax !== undefined) {
    const currentDailyWashLimitMax = getPlatformDailyWashLimitMax(settings);
    const parsedDailyWashLimitMax = Number(dailyWashLimitMax);
    if (
      !Number.isInteger(parsedDailyWashLimitMax) ||
      parsedDailyWashLimitMax < 1 ||
      parsedDailyWashLimitMax > 50
    ) {
      throw new AppError(httpStatus.BAD_REQUEST, "Daily wash limit must be a whole number between 1 and 50");
    }
    settings.dailyWashLimitMax = parsedDailyWashLimitMax;
    shouldSyncDailyWashLimit = parsedDailyWashLimitMax !== currentDailyWashLimitMax;
  }
  if (autoPayoutEnabled !== undefined) {
    settings.autoPayoutEnabled = Boolean(autoPayoutEnabled);
  }
  if (nextPayoutDay !== undefined) settings.nextPayoutDay = nextPayoutDay.toString().trim();
  if (supportEmail !== undefined) settings.supportEmail = supportEmail.toString().trim();
  if (stripeDashboardUrl !== undefined) {
    settings.stripeDashboardUrl = stripeDashboardUrl.toString().trim();
  }
  if (stripeAccountId !== undefined) {
    settings.stripeAccountId = stripeAccountId.toString().trim();
  }
  if (stripePayoutsEnabled !== undefined) {
    settings.stripePayoutsEnabled = Boolean(stripePayoutsEnabled);
  }
  settings.updatedBy = req.user._id;
  await settings.save();

  if (shouldSyncDailyWashLimit) {
    syncedDailyLimitProviders = await syncProvidersUsingPlatformDailyWashLimit(settings);
    broadcast("admin_services_pricing_updated", {
      platformSettings: { dailyWashLimitMax: settings.dailyWashLimitMax },
      syncedDailyLimitProviders,
    });
  }

  await recordActivity({
    req,
    action: "settings.updated",
    entityType: "platform_settings",
    entityId: settings._id,
    metadata: {
      commissionRate: settings.commissionRate,
      providerVerificationRequired: settings.providerVerificationRequired,
      dailyWashLimitMax: settings.dailyWashLimitMax,
      syncedDailyLimitProviders,
      autoPayoutEnabled: settings.autoPayoutEnabled,
      stripePayoutsEnabled: settings.stripePayoutsEnabled,
    },
  });
  broadcast("admin_settings_updated", settings);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard settings updated successfully",
    data: settings,
  });
});



/**
 * GET /admin/providers/:id/acceptance-history
 * Provider ki poori acceptance/training history — Safety Guidelines,
 * Washer Agreement, aur har training module, tareekh/waqt/device ke sath.
 */
export const getProviderAcceptanceHistory = catchAsync(async (req, res) => {
  const { id } = req.params;

  const provider = await User.findOne({ _id: id, role: "provider" }).select(
    "name email policyAcceptance nationalInsuranceStatus publicLiabilityInsurance drivewayEligibility adminVerification"
  );

  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  const acceptanceHistory = await ProviderAcceptance.find({ provider: id })
    .sort({ createdAt: -1 })
    .lean();

  // Admin ke saare verification-related actions (approve/reject, details
  // update, training reset) pehle se ActivityLog mein save ho rahe the —
  // yahan unhe isi provider ke liye jama kar ke ek poori timeline bana rahe
  // hain, dobara log system banane ki zaroorat nahi.
  const verificationActions = [
    "provider.verification_updated",
    "provider.verification_details_updated",
    "provider.policy_acceptance.reset",
    "provider.training.reset",
  ];
  const activityHistory = await ActivityLog.find({
    entityType: "user",
    entityId: id,
    action: { $in: verificationActions },
  })
    .sort({ createdAt: -1 })
    .populate("actor", "name email")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Acceptance history fetched",
    data: {
      provider: { _id: provider._id, name: provider.name, email: provider.email },
      currentStatus: provider.policyAcceptance,
      nationalInsuranceStatus: provider.nationalInsuranceStatus,
      publicLiabilityInsurance: provider.publicLiabilityInsurance,
      drivewayEligibility: provider.drivewayEligibility,
      adminVerification: provider.adminVerification,
      history: acceptanceHistory,
      activityHistory,
    },
  });
});

/**
 * PATCH /admin/providers/:id/policy-acceptance/reset
 * Body: { types?: ["safety_guidelines", "washer_agreement"] }
 * Admin provider ko dobara accept karwana chahta hai (jaise rules badal
 * gaye hon). Bas flag false kar dete hain — app ka maujooda gating
 * (hasAcceptedWasherPolicies / ensureWasherPoliciesAccepted) khud provider
 * ko agli baar Go Online karte waqt screen dikha dega.
 */
export const resetProviderPolicyAcceptance = catchAsync(async (req, res) => {
  const { id } = req.params;
  const requestedTypes = Array.isArray(req.body?.types) ? req.body.types : null;

  const provider = await User.findOne({ _id: id, role: "provider" });

  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  provider.policyAcceptance = provider.policyAcceptance || {};

  const resetSafety =
    !requestedTypes || requestedTypes.includes("safety_guidelines");
  const resetAgreement =
    !requestedTypes || requestedTypes.includes("washer_agreement");

  if (resetSafety) {
    provider.policyAcceptance.safetyGuidelinesAccepted = false;
    provider.policyAcceptance.safetyGuidelinesAcceptedAt = null;
  }
  if (resetAgreement) {
    provider.policyAcceptance.washerAgreementAccepted = false;
    provider.policyAcceptance.washerAgreementAcceptedAt = null;
  }

  // Agar provider abhi online hai, usay bhi offline kar do — warna wo
  // policies dobara accept kiye baghair hi online reh jayega.
  provider.isOnline = false;
  provider.isBusy = false;

  await provider.save();

  await recordActivity({
    req,
    action: "provider.policy_acceptance.reset",
    entityType: "user",
    entityId: provider._id,
    metadata: { resetSafety, resetAgreement },
  });

  broadcast("admin_provider_updated", { providerId: provider._id.toString() });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider will be asked to re-accept the selected policies",
    data: { policyAcceptance: provider.policyAcceptance },
  });
});

// ════════════════════════════════════════════════════════════════════════
// TRAINING MODULES — Provider Academy content management
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/training-modules
 * Admin ki apni list — active aur inactive dono, order se.
 */
export const getAllTrainingModules = catchAsync(async (req, res) => {
  const modules = await TrainingModule.find({}).sort({ order: 1 }).lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Training modules fetched",
    data: modules,
  });
});

/**
 * POST /admin/training-modules
 * multipart/form-data: video (file), title, topics (JSON string array),
 * isMandatory ("true"/"false")
 * Naya module banata hai — video Cloudinary par jati hai.
 */
export const createTrainingModule = catchAsync(async (req, res) => {
  const { title, description, topics, isMandatory } = req.body || {};

  if (!title || typeof title !== "string") {
    throw new AppError(httpStatus.BAD_REQUEST, "title is required");
  }
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "A video file is required");
  }

  let parsedTopics = [];
  try {
    parsedTopics = topics ? JSON.parse(topics) : [];
    if (!Array.isArray(parsedTopics)) parsedTopics = [];
  } catch {
    // topics comma-separated bhi bheja ja sakta hai
    parsedTopics = String(topics || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const uploaded = await uploadOnCloudinary(req.file.path, "training-videos", {
    resourceType: "video",
  });

  if (!uploaded?.secure_url) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Video upload failed, please try again"
    );
  }

  // Naya module hamesha list ke aakhir mein jata hai
  const lastModule = await TrainingModule.findOne({}).sort({ order: -1 });
  const nextOrder = lastModule ? lastModule.order + 1 : 0;

  const module = await TrainingModule.create({
    title,
    description: (description || "").toString().trim(),
    topics: parsedTopics,
    videoUrl: uploaded.secure_url,
    cloudinaryPublicId: uploaded.public_id,
    durationSeconds: uploaded.duration ? Math.round(uploaded.duration) : null,
    order: nextOrder,
    isMandatory: isMandatory !== "false",
    createdBy: req.user?._id,
  });

  await recordActivity({
    req,
    action: "training_module.created",
    entityType: "training_module",
    entityId: module._id,
    metadata: { title },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Training module created",
    data: module,
  });
});

/**
 * PATCH /admin/training-modules/:id
 * Text fields update karta hai (title, topics, isMandatory, isActive).
 * Video badalne ke liye alag endpoint (/replace-video) hai.
 */
export const updateTrainingModule = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { title, description, topics, isMandatory, isActive, trainingVersion } =
    req.body || {};

  const module = await TrainingModule.findById(id);
  if (!module) {
    throw new AppError(httpStatus.NOT_FOUND, "Training module not found");
  }

  if (typeof title === "string" && title.trim()) module.title = title.trim();
  if (typeof description === "string") module.description = description.trim();
  if (Array.isArray(topics)) module.topics = topics;
  if (typeof isMandatory === "boolean") module.isMandatory = isMandatory;
  if (typeof isActive === "boolean") module.isActive = isActive;
  if (typeof trainingVersion === "string" && trainingVersion.trim()) {
    module.trainingVersion = trainingVersion.trim();
  }

  await module.save();

  await recordActivity({
    req,
    action: "training_module.updated",
    entityType: "training_module",
    entityId: module._id,
    metadata: { title: module.title },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Training module updated",
    data: module,
  });
});

/**
 * PATCH /admin/training-modules/:id/replace-video
 * multipart/form-data: video (file)
 * Purani video Cloudinary se hata kar nayi laga deta hai — providers ko
 * agli baar screen kholte hi nayi video dikhegi.
 */
export const replaceTrainingModuleVideo = catchAsync(async (req, res) => {
  const { id } = req.params;

  const module = await TrainingModule.findById(id);
  if (!module) {
    throw new AppError(httpStatus.NOT_FOUND, "Training module not found");
  }
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "A video file is required");
  }

  const uploaded = await uploadOnCloudinary(req.file.path, "training-videos", {
    resourceType: "video",
  });

  if (!uploaded?.secure_url) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Video upload failed, please try again"
    );
  }

  const oldPublicId = module.cloudinaryPublicId;

  module.videoUrl = uploaded.secure_url;
  module.cloudinaryPublicId = uploaded.public_id;
  module.durationSeconds = uploaded.duration
    ? Math.round(uploaded.duration)
    : null;
  await module.save();

  // Purani video hatana — fail ho to bhi module save ho chuka hai, isliye
  // silently ignore karte hain (orphaned Cloudinary file, bara masla nahi)
  if (oldPublicId) {
    try {
      const { v2: cloudinary } = await import("cloudinary");
      await cloudinary.uploader.destroy(oldPublicId, {
        resource_type: "video",
      });
    } catch (err) {
      console.error("Failed to delete old training video:", err);
    }
  }

  await recordActivity({
    req,
    action: "training_module.video_replaced",
    entityType: "training_module",
    entityId: module._id,
    metadata: { title: module.title },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Video replaced",
    data: module,
  });
});

/**
 * PATCH /admin/training-modules/reorder
 * Body: { order: [moduleId1, moduleId2, ...] } — is tarteeb mein 0,1,2...
 * assign ho jata hai.
 */
export const reorderTrainingModules = catchAsync(async (req, res) => {
  const { order } = req.body || {};

  if (!Array.isArray(order) || order.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "order must be a non-empty array");
  }

  await Promise.all(
    order.map((moduleId, index) =>
      TrainingModule.updateOne({ _id: moduleId }, { $set: { order: index } })
    )
  );

  const modules = await TrainingModule.find({}).sort({ order: 1 }).lean();

  await recordActivity({
    req,
    action: "training_module.reordered",
    entityType: "training_module",
    entityId: null,
    metadata: { order },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Training modules reordered",
    data: modules,
  });
});

/**
 * DELETE /admin/training-modules/:id
 * Hard delete nahi karte — isActive false kar dete hain, taake purani
 * completion history (ProviderAcceptance) apna matlab na khoye.
 */
export const deactivateTrainingModule = catchAsync(async (req, res) => {
  const { id } = req.params;

  const module = await TrainingModule.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true }
  );

  if (!module) {
    throw new AppError(httpStatus.NOT_FOUND, "Training module not found");
  }

  await recordActivity({
    req,
    action: "training_module.deactivated",
    entityType: "training_module",
    entityId: module._id,
    metadata: { title: module.title },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Training module removed",
    data: module,
  });
});

/**
 * GET /admin/training-modules/completion-overview
 * Har provider ne kaunse modules mukammal kiye — admin ke liye ek jagah.
 */
export const getTrainingCompletionOverview = catchAsync(async (req, res) => {
  const modules = await TrainingModule.find({ isActive: true })
    .sort({ order: 1 })
    .select("_id title trainingVersion")
    .lean();

  const completions = await ProviderAcceptance.find({
    type: "training_module",
  })
    .sort({ createdAt: -1 })
    .populate("provider", "name email")
    .lean();

  // Har provider ke liye, kaunse module IDs complete hain (sabse pehla/
  // sabse purana record kaafi hai — dobara complete karna dobara record
  // banata hai, hum sirf "kabhi complete hua ya nahi" dekhte hain)
  const byProvider = new Map();
  for (const record of completions) {
    if (!record.provider) continue;
    const providerId = record.provider._id.toString();
    if (!byProvider.has(providerId)) {
      byProvider.set(providerId, {
        provider: record.provider,
        completedModuleIds: new Set(),
        lastActivityAt: record.createdAt,
      });
    }
    byProvider.get(providerId).completedModuleIds.add(record.moduleId);
  }

  const overview = Array.from(byProvider.values()).map((entry) => {
    const completedCount = entry.completedModuleIds.size;
    const totalModules = modules.length;
    return {
      provider: entry.provider,
      // "lastActivityAt" descending sort ki wajah se hamesha is provider
      // ki SABSE NAYI completion ki exact tareekh/waqt hai — agar training
      // mukammal ho chuki hai, yehi asal mein "completion date" bhi hai.
      lastActivityAt: entry.lastActivityAt,
      completedCount,
      totalModules,
      completedModuleIds: Array.from(entry.completedModuleIds),
      status:
        totalModules > 0 && completedCount >= totalModules
          ? "completed"
          : completedCount > 0
            ? "in_progress"
            : "not_started",
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Training completion overview fetched",
    data: { modules, providers: overview },
  });
});

/**
 * PATCH /admin/providers/:id/training/reset
 * Provider ki training progress reset karta hai — server-side history
 * delete nahi karta (audit ke liye rehti hai), lekin ek "resetAt" timestamp
 * save karta hai jis se pehle ke saare completions app ke liye "ginte nahi".
 */
export const resetProviderTraining = catchAsync(async (req, res) => {
  const { id } = req.params;

  const provider = await User.findOne({ _id: id, role: "provider" });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  provider.trainingResetAt = new Date();
  await provider.save();

  await recordActivity({
    req,
    action: "provider.training.reset",
    entityType: "user",
    entityId: provider._id,
  });

  broadcast("admin_provider_updated", { providerId: provider._id.toString() });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider's training progress has been reset",
    data: { trainingResetAt: provider.trainingResetAt },
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROVIDER VERIFICATION — extra fields (NI status, insurance metadata,
// driveway checklist). Identity/document approve-reject already existed
// (updateProviderVerification above) — ye endpoint sirf naye fields ke liye.
// ════════════════════════════════════════════════════════════════════════

/**
 * PATCH /admin/providers/:id/verification-details
 * Body (sab optional, jo bhejo wahi update hoga):
 *   nationalInsuranceStatus: "pending" | "verified" | "rejected"
 *   insurance: { policyNumber, insuranceCompany, expiryDate, status, rejectionReason }
 *   driveway: { isSafeWorkingArea, isResidentialAreaSuitable, isPrivateProperty,
 *               hasPermission, noRoadPayment, oneCarSpaceOnly, notSharedOrCommunal }
 */
export const updateProviderVerificationDetails = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { nationalInsuranceStatus, insurance, driveway } = req.body || {};

  const provider = await User.findOne({ _id: id, role: "provider" });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  const validStatuses = ["pending", "verified", "rejected"];

  if (nationalInsuranceStatus) {
    if (!validStatuses.includes(nationalInsuranceStatus)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid nationalInsuranceStatus");
    }
    provider.nationalInsuranceStatus = nationalInsuranceStatus;
  }

  if (insurance && typeof insurance === "object") {
    provider.publicLiabilityInsurance = provider.publicLiabilityInsurance || {};
    if (typeof insurance.policyNumber === "string") {
      provider.publicLiabilityInsurance.policyNumber = insurance.policyNumber.trim();
    }
    if (typeof insurance.insuranceCompany === "string") {
      provider.publicLiabilityInsurance.insuranceCompany = insurance.insuranceCompany.trim();
    }
    if (insurance.expiryDate) {
      const parsed = new Date(insurance.expiryDate);
      if (!isNaN(parsed.getTime())) {
        provider.publicLiabilityInsurance.expiryDate = parsed;
      }
    }
    if (insurance.status) {
      if (!validStatuses.includes(insurance.status)) {
        throw new AppError(httpStatus.BAD_REQUEST, "Invalid insurance status");
      }
      provider.publicLiabilityInsurance.status = insurance.status;
    }
    if (typeof insurance.rejectionReason === "string") {
      provider.publicLiabilityInsurance.rejectionReason = insurance.rejectionReason.trim();
    }
  }

  if (driveway && typeof driveway === "object") {
    provider.drivewayEligibility = provider.drivewayEligibility || {};
    const drivewayFields = [
      "isPrivateProperty",
      "hasPermission",
      "noRoadPayment",
      "oneCarSpaceOnly",
      "notSharedOrCommunal",
      "isSafeWorkingArea",
      "isResidentialAreaSuitable",
    ];
    for (const field of drivewayFields) {
      if (typeof driveway[field] === "boolean") {
        provider.drivewayEligibility[field] = driveway[field];
      }
    }
  }

  await provider.save();

  await recordActivity({
    req,
    action: "provider.verification_details_updated",
    entityType: "user",
    entityId: provider._id,
    metadata: { nationalInsuranceStatus, insurance, driveway },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Verification details updated",
    data: {
      nationalInsuranceStatus: provider.nationalInsuranceStatus,
      publicLiabilityInsurance: provider.publicLiabilityInsurance,
      drivewayEligibility: provider.drivewayEligibility,
    },
  });
});

/**
 * GET /admin/providers/insurance-expiring
 * Query: days (default 30) — kaunsi insurances itne dinon mein expire ho rahi hain.
 * Renewal reminder banane ke liye admin/cron dono use kar sakte hain.
 */
export const getExpiringInsurance = catchAsync(async (req, res) => {
  const days = Number(req.query.days) || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const providers = await User.find({
    role: "provider",
    "publicLiabilityInsurance.expiryDate": { $ne: null, $lte: cutoff },
  })
    .select("name email publicLiabilityInsurance")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Providers with expiring insurance fetched",
    data: providers,
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROVIDER VERIFICATION REMINDERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Provider ke documents mein se kaunse missing hain — yehi logic checklist
 * badges (Missing/Open) banane ke liye bhi use hoti hai, taake reminder
 * aur UI hamesha ek doosre se match karein.
 */
const findMissingDocuments = (provider) => {
  const missing = [];

  if (!provider.photo?.url) missing.push("Selfie photo");
  if (!provider.identityVerification?.passportOrDrivingLicenseFile?.url) {
    missing.push("Passport / Licence");
  }
  const insuranceUrl =
    provider.publicLiabilityInsurance?.document?.url || provider.insurance?.document?.url;
  if (!insuranceUrl) missing.push("Public Liability Insurance");
  if (!provider.drivewayPhoto?.document?.url) missing.push("Driveway Photo");

  const bank = provider.bankDetails || {};
  const hasBankDetails = Boolean(
    bank.accountHolderName &&
      bank.address &&
      bank.city &&
      bank.postcode &&
      bank.dateOfBirth &&
      bank.accountNumber &&
      bank.sortCode
  );
  if (!hasBankDetails) missing.push("Bank Details");

  return missing;
};

/**
 * POST /admin/providers/:id/send-verification-reminder
 * Body: { message? } — admin apna matn bhej sakta hai, warna khud missing
 * documents ki list se ek matn ban jata hai.
 */
export const sendVerificationReminder = catchAsync(async (req, res) => {
  const { id } = req.params;
  const customMessage = (req.body?.message || "").toString().trim();

  const provider = await User.findOne({ _id: id, role: "provider" });
  if (!provider) {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }

  const missing = findMissingDocuments(provider);

  if (!customMessage && missing.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This provider has no missing documents. Add a custom message to send a reminder anyway."
    );
  }

  const message =
    customMessage ||
    `Your OWVO verification is incomplete. Please upload: ${missing.join(", ")}.`;

  const notification = await Notification.create({
    recipient: provider._id,
    type: "verification_reminder",
    title: "Verification reminder",
    message,
    sentBy: req.user._id,
    metadata: { missingDocuments: missing },
  });

  // Provider abhi app mein hai to turant dikh jaye; nahi hai to agli baar
  // app kholte hi notification list se mil jayega (database mein save ho
  // chuki hai).
  emitToUser(provider._id.toString(), "new_notification", {
    _id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    createdAt: notification.createdAt,
  });

  await recordActivity({
    req,
    action: "provider.verification_reminder_sent",
    entityType: "user",
    entityId: provider._id,
    metadata: { missingDocuments: missing, customMessage: Boolean(customMessage) },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Reminder sent",
    data: notification,
  });
});


// ─── Bookings redesign: export / chat / notes / dispute / refund ───

const bkCsvCell = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /admin/bookings/export — maujooda filters (ya selected ids) ki CSV.
export const exportAdminBookings = catchAsync(async (req, res) => {
  const { filter } = await bkBuildBookingFilters(req.query);
  if (req.query.ids) {
    const ids = String(req.query.ids)
      .split(",")
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    filter._id = { $in: ids };
  }
  const rows = await Booking.find(filter)
    .populate(bookingPopulate)
    .sort({ bookingDate: -1 })
    .limit(5000)
    .lean();

  const header = [
    "Booking ID",
    "Date",
    "Customer",
    "Customer Phone",
    "Provider",
    "Service",
    "Vehicle",
    "Add-ons",
    "Amount",
    "Currency",
    "Payment Status",
    "Booking Status",
    "Postcode",
    "Address",
  ];
  const lines = rows.map((b) => {
    const vehicleText = b.vehicleSnapshot
      ? [
          b.vehicleSnapshot.make,
          b.vehicleSnapshot.model,
          b.vehicleSnapshot.registrationNo,
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    const addonsText = (b.addons || [])
      .map((a) => a.name)
      .filter(Boolean)
      .join("; ");
    const paymentStatus =
      b.refund?.status === "refunded"
        ? "Refunded"
        : b.payment?.status || "pending";
    return [
      `#B${b._id.toString().slice(-6).toUpperCase()}`,
      b.bookingDate ? new Date(b.bookingDate).toISOString() : "",
      b.user?.name || "",
      b.user?.phoneNumber || "",
      b.provider?.name || "",
      b.service?.title || "",
      vehicleText,
      addonsText,
      b.finalPrice ?? "",
      b.currency || "GBP",
      paymentStatus,
      b.status,
      b.postalCode || "",
      b.address?.addressLine || "",
    ]
      .map(bkCsvCell)
      .join(",");
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="bookings-export-${new Date()
      .toISOString()
      .slice(0, 10)}.csv"`
  );
  res.status(httpStatus.OK).send([header.join(","), ...lines].join("\n"));
});

const bkLoadBookingOr404 = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }
  const booking = await Booking.findById(id);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }
  return booking;
};

// ─── Booking chat (admin side) ───
// Messages wahi ChatMessage collection hai jo app use karti hai — query
// sirf booking par hai, is liye admin ka message dono taraf dikhega.
export const getAdminBookingMessages = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const messages = await ChatMessage.find({ booking: booking._id })
    .populate("sender", "name photo role")
    .sort({ createdAt: 1 })
    .lean();

  const customerId = booking.user.toString();
  const providerId = booking.provider.toString();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking messages fetched successfully",
    data: messages.map((m) => {
      const senderId = m.sender?._id?.toString() || m.sender?.toString();
      return {
        _id: m._id,
        text: m.text || "",
        attachment: m.attachment || null,
        senderId,
        senderName: m.sender?.name || "",
        senderPhoto: m.sender?.photo?.url || "",
        isAdmin:
          m.sender?.role === "admin" ||
          m.sender?.role === "staff" ||
          (senderId !== customerId && senderId !== providerId),
        createdAt: m.createdAt,
      };
    }),
  });
});

export const sendAdminBookingMessage = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const text = String(req.body?.text || "").trim();
  if (!text) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message text is required");
  }
  if (text.length > 2000) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Message is too long (max 2000 characters)"
    );
  }

  const message = await ChatMessage.create({
    booking: booking._id,
    sender: req.user._id,
    recipient: booking.user,
    participants: [booking.user, booking.provider, req.user._id],
    text,
  });

  const payload = {
    id: message._id.toString(),
    bookingId: booking._id.toString(),
    senderId: req.user._id.toString(),
    senderName: req.user.name || "OWVO Support",
    recipientId: booking.user.toString(),
    text,
    attachment: null,
    isAdmin: true,
    createdAt: message.createdAt,
  };

  // Dono taraf live delivery + offline ho to push.
  try {
    emitToUser(booking.user.toString(), "chat_message", payload);
    emitToUser(booking.provider.toString(), "chat_message", payload);
  } catch (e) {
    /* socket optional */
  }
  try {
    const pushPayload = {
      title: "New message from OWVO Support",
      body: text.slice(0, 120),
      data: { type: "chat_message", bookingId: booking._id.toString() },
    };
    notifyUser(booking.user.toString(), pushPayload);
    notifyUser(booking.provider.toString(), pushPayload);
  } catch (e) {
    /* push best effort */
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Message sent",
    data: {
      _id: message._id,
      text,
      attachment: null,
      senderId: req.user._id.toString(),
      senderName: req.user.name || "OWVO Support",
      senderPhoto: "",
      isAdmin: true,
      createdAt: message.createdAt,
    },
  });
});

// ─── Booking notes (admin-only) ───
export const getAdminBookingNotes = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const notes = await BookingNote.find({ booking: booking._id })
    .populate("author", "name")
    .sort({ createdAt: -1 })
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking notes fetched successfully",
    data: notes.map((n) => ({
      _id: n._id,
      text: n.text,
      authorName: n.author?.name || "Admin",
      createdAt: n.createdAt,
    })),
  });
});

export const createAdminBookingNote = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const text = String(req.body?.text || "").trim();
  if (!text) {
    throw new AppError(httpStatus.BAD_REQUEST, "Note text is required");
  }
  const note = await BookingNote.create({
    booking: booking._id,
    author: req.user._id,
    text,
  });
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Note added",
    data: {
      _id: note._id,
      text: note.text,
      authorName: req.user.name || "Admin",
      createdAt: note.createdAt,
    },
  });
});

export const deleteAdminBookingNote = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const deleted = await BookingNote.findOneAndDelete({
    _id: req.params.noteId,
    booking: booking._id,
  });
  if (!deleted) {
    throw new AppError(httpStatus.NOT_FOUND, "Note not found");
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Note deleted",
    data: { _id: deleted._id },
  });
});

// ─── Booking dispute (SupportTicket link) ───
const bkMapDispute = (t) =>
  t
    ? {
        _id: t._id,
        ticketNumber: t.ticketNumber || "",
        subject: t.subject || "",
        description: t.description || "",
        priority: t.priority || "medium",
        status: t.status || "open",
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
    : null;

export const getAdminBookingDispute = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const ticket = await SupportTicket.findOne({
    booking: booking._id,
    type: "dispute",
  })
    .sort({ createdAt: -1 })
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking dispute fetched successfully",
    data: { dispute: bkMapDispute(ticket) },
  });
});

export const createAdminBookingDispute = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const description = String(req.body?.description || "").trim();
  if (!description) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Dispute description is required"
    );
  }
  const existingOpen = await SupportTicket.findOne({
    booking: booking._id,
    type: "dispute",
    status: { $in: ["open", "in_progress"] },
  }).select("_id ticketNumber");
  if (existingOpen) {
    throw new AppError(
      httpStatus.CONFLICT,
      `An open dispute already exists for this booking (${existingOpen.ticketNumber || "ticket"})`
    );
  }
  const short = booking._id.toString().slice(-6).toUpperCase();
  const subject =
    String(req.body?.subject || "").trim() || `Dispute for booking #B${short}`;
  const priority = ["low", "medium", "high"].includes(req.body?.priority)
    ? req.body.priority
    : "medium";

  // SupportTicket schema reporter ko customer/provider mangta hai — dispute
  // booking ke customer ke naam par khulta hai, pehla message admin ka
  // hota hai taake Support & Disputes page par sab saaf nazar aye.
  const ticket = await SupportTicket.create({
    reporter: booking.user,
    reporterRole: "customer",
    reportedUser: booking.provider,
    booking: booking._id,
    type: "dispute",
    priority,
    subject,
    description,
    messages: [
      { sender: req.user._id, senderRole: "admin", text: description },
    ],
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Dispute created",
    data: { dispute: bkMapDispute(ticket.toObject()) },
  });
});

// ─── Booking notification (standalone — status change ke baghair) ───
export const sendAdminBookingNotification = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);
  const message = String(req.body?.message || "").trim();
  if (!message) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message is required");
  }
  const targets = [];
  if (req.body?.notifyCustomer !== false) {
    targets.push({ userId: booking.user, who: "customer" });
  }
  if (req.body?.notifyProvider !== false) {
    targets.push({ userId: booking.provider, who: "provider" });
  }
  if (!targets.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Select at least one recipient"
    );
  }
  for (const t of targets) {
    await Notification.create({
      recipient: t.userId,
      type: "general",
      title: "Message from OWVO",
      message,
      sentBy: req.user._id,
      metadata: { bookingId: booking._id },
    });
    notifyUser(t.userId.toString(), {
      title: "Message from OWVO",
      body: message.slice(0, 120),
      data: {
        type: "admin_notification",
        bookingId: booking._id.toString(),
      },
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notification sent",
    data: { notified: targets.map((t) => t.who) },
  });
});

// ─── Refund (admin only — route par isAdmin) ───
// Poori rakam ka refund: booking ki completed payment entry ke Stripe
// PaymentIntent par. Booking ka status NAHI badalta; refund booking.refund
// me record hota hai aur har jagah "Refunded" dikhta hai.
const REFUND_REASON_CATEGORIES = [
  "service_not_as_described",
  "provider_no_show",
  "customer_cancelled",
  "duplicate_charge",
  "quality_issue",
  "other",
];

// Refund execute karne ka asal kaam — admin ka direct refund aur
// customer request ki approval dono yahi istemal karte hain.
// Hisse (wallet/card) booking ki asal payment se tay hote hain:
// card hissa Stripe se wapas, wallet hissa foran wallet credit.
// Cumulative cap: pehle hue refunds ke baad bachi raqam se zyada
// kabhi refund nahi hota. Stripe fail ho to record "approved" par
// ruk jata hai taake admin dobara koshish kar sake.
const executeRefund = async (refund, actorId) => {
  const booking = await Booking.findById(refund.booking);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found for this refund.");
  }

  const record = await paymentInfo
    .findOne({
      bookingId: booking._id,
      type: "booking",
      paymentStatus: "complete",
    })
    .sort({ createdAt: -1 });

  const priorAgg = await Refund.aggregate([
    {
      $match: {
        booking: booking._id,
        status: "refunded",
        _id: { $ne: refund._id },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: "$amount" },
        walletTotal: { $sum: "$walletPortion" },
      },
    },
  ]);
  const alreadyRefunded = asMoney(priorAgg[0]?.total || 0);
  const walletAlreadyRefunded = asMoney(priorAgg[0]?.walletTotal || 0);
  const captured = record
    ? asMoney(record.price)
    : asMoney(booking.finalPrice || booking.price || 0);
  const remaining = asMoney(captured - alreadyRefunded);

  if (!refund.amount || refund.amount <= 0 || refund.amount > remaining + 0.001) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Refund amount must be between £0.01 and £${remaining.toFixed(2)} (the amount still refundable for this booking).`
    );
  }

  const walletPaidTotal = record
    ? asMoney(record.walletAmount || 0)
    : asMoney(booking.payment?.walletAmount || 0);
  const walletPortion = asMoney(
    Math.min(refund.amount, Math.max(walletPaidTotal - walletAlreadyRefunded, 0))
  );
  const cardPortion = asMoney(refund.amount - walletPortion);

  refund.walletPortion = walletPortion;
  refund.cardPortion = cardPortion;
  if (record) refund.payment = record._id;

  // Card hissa — Stripe se.
  if (cardPortion > 0) {
    const transactionId = record?.transactionId || booking.payment?.trxId;
    if (!transactionId || !String(transactionId).startsWith("pi_")) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "No card payment was found for this booking to refund."
      );
    }
    refund.stripePaymentIntentId = transactionId;
    try {
      const stripeRefund = await getStripe().refunds.create({
        payment_intent: transactionId,
        amount: Math.round(cardPortion * 100),
      });
      refund.stripeRefundId = stripeRefund.id;
    } catch (err) {
      refund.status = "approved";
      await refund.save();
      throw new AppError(
        httpStatus.BAD_GATEWAY,
        `Stripe refund failed: ${err?.message || "unknown error"}`
      );
    }
  }

  // Wallet hissa — foran credit.
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
  if (actorId && !refund.decidedBy) {
    refund.decidedBy = actorId;
    refund.decidedAt = new Date();
  }
  await refund.save();

  await applyEarningReversal(refund);
  await syncBookingRefundSummary(booking._id, actorId || null);

  await recordActivity(
    actorId,
    "booking.refunded",
    "Booking",
    booking._id,
    `Refunded £${refund.amount.toFixed(2)} for booking ${booking._id}`,
    { refundId: refund._id.toString(), stripeRefundId: refund.stripeRefundId || "", amount: refund.amount }
  );

  try {
    const parts = [];
    if (walletPortion > 0) {
      parts.push(`£${walletPortion.toFixed(2)} has been credited to your OWVO wallet`);
    }
    if (cardPortion > 0) {
      parts.push(`£${cardPortion.toFixed(2)} will return to your card in 3–10 working days`);
    }
    const message = `A refund of £${refund.amount.toFixed(2)} has been processed for your booking. ${parts.join(". ")}.`;
    await Notification.create({
      recipient: booking.user,
      type: "general",
      title: "Refund processed",
      message,
      sentBy: actorId || undefined,
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

export const refundAdminBooking = catchAsync(async (req, res) => {
  const booking = await bkLoadBookingOr404(req.params.id);

  if (booking.payment?.status !== "paid") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This booking has not been paid — there is nothing to refund."
    );
  }

  const record = await paymentInfo
    .findOne({
      bookingId: booking._id,
      type: "booking",
      paymentStatus: "complete",
    })
    .sort({ createdAt: -1 });
  const priorAgg = await Refund.aggregate([
    { $match: { booking: booking._id, status: "refunded" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const captured = record
    ? asMoney(record.price)
    : asMoney(booking.finalPrice || booking.price || 0);
  const remaining = asMoney(captured - asMoney(priorAgg[0]?.total || 0));
  if (remaining <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This booking has already been fully refunded."
    );
  }

  const amount =
    req.body?.amount !== undefined && req.body?.amount !== null
      ? asMoney(req.body.amount)
      : remaining;
  if (!amount || amount <= 0 || amount > remaining) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Refund amount must be between £0.01 and £${remaining.toFixed(2)}.`
    );
  }

  const reasonCategory = REFUND_REASON_CATEGORIES.includes(req.body?.reasonCategory)
    ? req.body.reasonCategory
    : "other";

  const refund = await Refund.create({
    booking: booking._id,
    payment: record?._id,
    customer: booking.user,
    provider: booking.provider,
    amount,
    source: "admin",
    status: "approved",
    reason: String(req.body?.reason || "").trim(),
    reasonCategory,
    decidedBy: req.user._id,
    decidedAt: new Date(),
  });

  const executed = await executeRefund(refund, req.user._id);

  const populated = await Booking.findById(booking._id).populate(
    bookingPopulate
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Refund processed successfully",
    data: { booking: populated, refund: executed },
  });
});


// ════════════════════════════════════════════════════════════════
// Payments & Refunds — unified transactions, refund queue,
// payout actions aur reconciliation (Payments phase)
// ════════════════════════════════════════════════════════════════

const TXN_SOURCE_TYPES = ["payment", "payout", "refund"];
const REFUND_STATUSES = [
  "requested",
  "under_review",
  "approved",
  "processing",
  "refunded",
  "rejected",
  "failed",
];

const txnPartyOf = (user) =>
  user
    ? { id: user._id, name: user.name || "", email: user.email || "" }
    : null;

// Payments, payouts aur refunds ko ek hi list ki shakal dena —
// page teeno ko ek table me dikhata hai.
export const getAdminTransactions = catchAsync(async (req, res) => {
  const typeFilter = TXN_SOURCE_TYPES.includes(req.query.type)
    ? req.query.type
    : "all";
  const statusFilter = (req.query.status || "").toString().trim();
  const search = (req.query.search || "").toString().trim().toLowerCase();
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const dateCond = dateFilter("createdAt", req.query);

  const [payments, payouts, refunds] = await Promise.all([
    paymentInfo
      .find({ ...dateCond })
      .sort({ createdAt: -1 })
      .limit(600)
      .populate("userId", "name email")
      .populate("providerId", "name email")
      .lean(),
    Payout.find({ ...dateCond })
      .sort({ createdAt: -1 })
      .limit(600)
      .populate("provider", "name email")
      .lean(),
    Refund.find({ ...dateCond })
      .sort({ createdAt: -1 })
      .limit(600)
      .populate("customer", "name email")
      .populate("provider", "name email")
      .lean(),
  ]);

  const rows = [];
  for (const p of payments) {
    rows.push({
      id: p._id,
      sourceType: "payment",
      txnNumber: p.txnNumber || "",
      kind: p.type || "booking",
      direction: "in",
      amount: asMoney(p.price),
      currency: p.currency || "GBP",
      status:
        p.paymentStatus === "complete"
          ? "paid"
          : p.paymentStatus === "pending"
            ? "pending"
            : "failed",
      rawStatus: p.paymentStatus,
      method:
        p.walletAmount > 0 && p.cardAmount > 0
          ? "Wallet + Card"
          : p.walletAmount > 0
            ? "Wallet"
            : p.paymentMethod || "card",
      customer: txnPartyOf(p.userId),
      provider: txnPartyOf(p.providerId),
      bookingId: p.bookingId || null,
      failureReason: "",
      createdAt: p.createdAt,
    });
  }
  for (const p of payouts) {
    rows.push({
      id: p._id,
      sourceType: "payout",
      txnNumber: p.txnNumber || "",
      kind: p.source || "booking",
      direction: "out",
      amount: asMoney(p.amount),
      currency: p.currency || "GBP",
      status: p.status,
      rawStatus: p.status,
      method: p.mode === "auto" ? "Stripe (automatic)" : "Bank transfer (manual)",
      customer: null,
      provider: txnPartyOf(p.provider),
      bookingId: null,
      failureReason: p.failureReason || "",
      createdAt: p.createdAt,
    });
  }
  for (const r of refunds) {
    rows.push({
      id: r._id,
      sourceType: "refund",
      txnNumber: r.txnNumber || "",
      kind: "refund",
      direction: "out",
      amount: asMoney(r.amount),
      currency: "GBP",
      status: r.status,
      rawStatus: r.status,
      method:
        r.walletPortion > 0 && r.cardPortion > 0
          ? "Wallet + Card"
          : r.walletPortion > 0
            ? "Wallet"
            : "Card",
      customer: txnPartyOf(r.customer),
      provider: txnPartyOf(r.provider),
      bookingId: r.booking || null,
      failureReason: "",
      createdAt: r.createdAt,
    });
  }

  const filtered = rows.filter((row) => {
    if (statusFilter && row.status !== statusFilter) return false;
    if (search) {
      const haystack = [
        row.txnNumber,
        row.customer?.name,
        row.customer?.email,
        row.provider?.name,
        row.provider?.email,
        row.bookingId?.toString(),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const counts = {
    all: filtered.length,
    payment: filtered.filter((r) => r.sourceType === "payment").length,
    payout: filtered.filter((r) => r.sourceType === "payout").length,
    refund: filtered.filter((r) => r.sourceType === "refund").length,
    failed: filtered.filter((r) => r.status === "failed").length,
  };

  const summary = {
    totalPayments: asMoney(
      rows
        .filter((r) => r.sourceType === "payment" && r.status === "paid")
        .reduce((sum, r) => sum + r.amount, 0)
    ),
    pendingPayouts: asMoney(
      rows
        .filter(
          (r) =>
            r.sourceType === "payout" &&
            ["pending", "processing"].includes(r.status)
        )
        .reduce((sum, r) => sum + r.amount, 0)
    ),
    refundRequestsAmount: asMoney(
      rows
        .filter(
          (r) =>
            r.sourceType === "refund" &&
            ["requested", "under_review", "approved", "processing"].includes(r.status)
        )
        .reduce((sum, r) => sum + r.amount, 0)
    ),
    refundRequestsCount: rows.filter(
      (r) =>
        r.sourceType === "refund" &&
        ["requested", "under_review", "approved", "processing"].includes(r.status)
    ).length,
    failedAmount: asMoney(
      rows
        .filter((r) => r.status === "failed")
        .reduce((sum, r) => sum + r.amount, 0)
    ),
  };

  const typed =
    typeFilter === "all"
      ? filtered
      : filtered.filter((r) => r.sourceType === typeFilter);
  typed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = typed.length;
  const pageRows = typed.slice((page - 1) * limit, page * limit);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Transactions fetched",
    data: {
      transactions: pageRows,
      counts,
      summary,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

export const getAdminTransactionDetail = catchAsync(async (req, res) => {
  const { sourceType, id } = req.params;
  if (!TXN_SOURCE_TYPES.includes(sourceType)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid transaction type");
  }
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid transaction id");
  }

  let record = null;
  let booking = null;
  let bookings = [];
  let payment = null;

  if (sourceType === "payment") {
    record = await paymentInfo
      .findById(id)
      .populate("userId", "name email phoneNumber")
      .populate("providerId", "name email phoneNumber")
      .lean();
    if (record?.bookingId) {
      booking = await Booking.findById(record.bookingId)
        .populate("user", "name email phoneNumber")
        .populate("provider", "name email phoneNumber")
        .populate("service", "title price")
        .lean();
    }
  } else if (sourceType === "payout") {
    record = await Payout.findById(id)
      .populate("provider", "name email phoneNumber bankDetails stripeConnect payoutMode")
      .lean();
    if (record?.bookingIds?.length) {
      bookings = await Booking.find({ _id: { $in: record.bookingIds } })
        .select("finalPrice price status completedAt service")
        .populate("service", "title")
        .lean();
    }
  } else {
    record = await Refund.findById(id)
      .populate("customer", "name email phoneNumber")
      .populate("provider", "name email phoneNumber")
      .lean();
    if (record?.booking) {
      booking = await Booking.findById(record.booking)
        .populate("user", "name email phoneNumber")
        .populate("provider", "name email phoneNumber")
        .populate("service", "title price")
        .lean();
    }
    if (record?.payment) {
      payment = await paymentInfo.findById(record.payment).lean();
    }
    if (record?.ticket) {
      record.ticketDoc = await SupportTicket.findById(record.ticket)
        .select("ticketNumber type status subject")
        .lean();
    }
  }

  if (!record) {
    throw new AppError(httpStatus.NOT_FOUND, "Transaction not found");
  }

  const notes = await TransactionNote.find({ sourceType, sourceId: id })
    .sort({ createdAt: -1 })
    .populate("author", "name email")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Transaction detail fetched",
    data: { record, booking, bookings, payment, notes },
  });
});

export const createAdminTransactionNote = catchAsync(async (req, res) => {
  const { sourceType, sourceId, text, visibility = "internal" } = req.body || {};
  if (!TXN_SOURCE_TYPES.includes(sourceType)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid transaction type");
  }
  if (!mongoose.Types.ObjectId.isValid(sourceId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid transaction id");
  }
  const cleanText = (text || "").toString().trim();
  if (!cleanText) {
    throw new AppError(httpStatus.BAD_REQUEST, "Note text is required");
  }
  if (!["internal", "customer"].includes(visibility)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid note visibility");
  }
  const note = await TransactionNote.create({
    sourceType,
    sourceId,
    author: req.user._id,
    visibility,
    text: cleanText.slice(0, 2000),
  });
  const data = await TransactionNote.findById(note._id)
    .populate("author", "name email")
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Note added",
    data,
  });
});

export const getAdminTransactionNotes = catchAsync(async (req, res) => {
  const { sourceType, id } = req.params;
  if (!TXN_SOURCE_TYPES.includes(sourceType)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid transaction type");
  }
  const notes = await TransactionNote.find({ sourceType, sourceId: id })
    .sort({ createdAt: -1 })
    .populate("author", "name email")
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notes fetched",
    data: notes,
  });
});

// ── Refund queue ────────────────────────────────────────────────
export const getAdminRefunds = catchAsync(async (req, res) => {
  const filter = {};
  if (REFUND_STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  }
  Object.assign(filter, dateFilter("createdAt", req.query));
  const search = (req.query.search || "").toString().trim();
  if (search) {
    const users = await User.find({
      $or: [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ],
    })
      .select("_id")
      .lean();
    const userIds = users.map((u) => u._id);
    filter.$or = [
      { reason: { $regex: search, $options: "i" } },
      { customer: { $in: userIds } },
      { provider: { $in: userIds } },
    ];
  }
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

  const [total, refunds, countsAgg] = await Promise.all([
    Refund.countDocuments(filter),
    Refund.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("customer", "name email")
      .populate("provider", "name email")
      .populate({
        path: "booking",
        select: "finalPrice service",
        populate: { path: "service", select: "title" },
      })
      .lean(),
    Refund.aggregate([
      { $match: dateFilter("createdAt", req.query) },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
    ]),
  ]);

  const counts = {};
  for (const row of countsAgg) {
    counts[row._id] = { count: row.count, amount: asMoney(row.amount) };
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Refunds fetched",
    data: {
      refunds,
      counts,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

export const decideAdminRefund = catchAsync(async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) {
    throw new AppError(httpStatus.NOT_FOUND, "Refund not found");
  }
  const { decision, amount, note } = req.body || {};
  if (!["requested", "under_review"].includes(refund.status)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `This refund is already ${refund.status}.`
    );
  }

  const addNote = async (text, visibility = "internal") => {
    if (text && text.toString().trim()) {
      await TransactionNote.create({
        sourceType: "refund",
        sourceId: refund._id,
        author: req.user._id,
        visibility,
        text: text.toString().trim().slice(0, 2000),
      });
    }
  };

  if (decision === "reject") {
    refund.status = "rejected";
    refund.decidedBy = req.user._id;
    refund.decidedAt = new Date();
    await refund.save();
    await addNote(note);
    await recordActivity({
      req,
      action: "refund.rejected",
      entityType: "refund",
      entityId: refund._id,
      metadata: { amount: refund.amount },
    });
    try {
      notifyUser(refund.customer.toString(), {
        title: "Refund request update",
        body: "Your refund request was reviewed and could not be approved. Please contact support if you need help.",
        data: { type: "refund_rejected", refundId: refund._id.toString() },
      });
    } catch (e) {
      /* best effort */
    }
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Refund rejected",
      data: refund,
    });
  }

  if (decision === "more_info") {
    refund.status = "under_review";
    await refund.save();
    await addNote(note);
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Refund marked as under review",
      data: refund,
    });
  }

  if (decision === "approve") {
    if (amount !== undefined && amount !== null) {
      const cleanAmount = asMoney(amount);
      if (!cleanAmount || cleanAmount <= 0) {
        throw new AppError(httpStatus.BAD_REQUEST, "Invalid refund amount");
      }
      refund.amount = cleanAmount;
    }
    refund.status = "approved";
    refund.decidedBy = req.user._id;
    refund.decidedAt = new Date();
    await refund.save();
    await addNote(note);
    const executed = await executeRefund(refund, req.user._id);
    await recordActivity({
      req,
      action: "refund.approved",
      entityType: "refund",
      entityId: refund._id,
      metadata: { amount: refund.amount },
    });
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Refund approved and processed",
      data: executed,
    });
  }

  throw new AppError(httpStatus.BAD_REQUEST, "Invalid decision");
});

// Approved par atka hua refund dobara execute karna (masalan Stripe
// fail ke baad).
export const processAdminRefund = catchAsync(async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) {
    throw new AppError(httpStatus.NOT_FOUND, "Refund not found");
  }
  if (refund.status !== "approved") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Only an approved refund can be processed (this one is ${refund.status}).`
    );
  }
  const executed = await executeRefund(refund, req.user._id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Refund processed",
    data: executed,
  });
});

// ── Payout actions ──────────────────────────────────────────────
export const retryAdminPayout = catchAsync(async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) {
    throw new AppError(httpStatus.NOT_FOUND, "Payout not found");
  }
  if (!["failed", "pending"].includes(payout.status)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `A ${payout.status} payout cannot be retried.`
    );
  }
  if (payout.status === "failed") {
    payout.status = "pending";
    payout.failureReason = "";
    payout.attempts.push({
      action: "admin_retry",
      result: "pending",
      note: "Admin retried the automatic payout.",
      by: req.user._id,
    });
    await payout.save();
  }
  const attempt = await attemptPayoutTransfer(payout);
  await recordActivity({
    req,
    action: "payout.retried",
    entityType: "payout",
    entityId: payout._id,
    metadata: { attempted: attempt.attempted, status: attempt.payout.status },
  });
  broadcast("admin_payout_updated", {
    payoutId: payout._id,
    status: attempt.payout.status,
  });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: attempt.attempted
      ? "Automatic payout attempted"
      : "Payout is queued — automatic transfer is not available for this provider yet",
    data: attempt.payout,
  });
});

export const payAdminPayoutManually = catchAsync(async (req, res) => {
  const payout = await Payout.findById(req.params.id);
  if (!payout) {
    throw new AppError(httpStatus.NOT_FOUND, "Payout not found");
  }
  const { reference = "", note = "" } = req.body || {};
  if (payout.status === "processing" && payout.mode === "auto") {
    throw new AppError(
      httpStatus.CONFLICT,
      "This payout is being processed by Stripe — paying it manually now could pay the provider twice. Wait for the Stripe result first."
    );
  }
  if (!["pending", "failed"].includes(payout.status)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `A ${payout.status} payout cannot be paid manually.`
    );
  }
  payout.mode = "manual";
  payout.stripeMode = "manual";
  payout.status = "paid";
  payout.paidAt = new Date();
  payout.failureReason = "";
  payout.updatedBy = req.user._id;
  if (reference.toString().trim()) {
    payout.manualAdjustmentReason = `Manual bank transfer — ref: ${reference.toString().trim()}`;
  } else if (note.toString().trim()) {
    payout.manualAdjustmentReason = note.toString().trim();
  }
  payout.attempts.push({
    action: "manual_paid",
    result: "paid",
    note: [reference, note]
      .map((v) => v?.toString?.().trim())
      .filter(Boolean)
      .join(" — "),
    by: req.user._id,
  });
  await payout.save();

  await recordActivity({
    req,
    action: "payout.paid_manually",
    entityType: "payout",
    entityId: payout._id,
    metadata: { amount: payout.amount, reference: reference || "" },
  });
  broadcast("admin_payout_updated", { payoutId: payout._id, status: payout.status });
  if (payout.provider) {
    notifyUser(payout.provider.toString(), {
      title: "Payout sent! 💸",
      body: `Your payout of £${payout.amount} has been sent.`,
      data: {
        type: "payout_update",
        payoutId: payout._id.toString(),
        status: "paid",
      },
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payout marked as paid",
    data: payout,
  });
});

// ── Reconciliation ──────────────────────────────────────────────
// Ledger aur Stripe ke darmiyan farq dhoondna: bahar se hue
// refunds, atke hue payouts, paid payment par unpaid booking.
export const getAdminReconciliation = catchAsync(async (req, res) => {
  const issues = {
    stripeRefundsNotRecorded: [],
    stuckPayouts: [],
    paidPaymentsBookingNotPaid: [],
    stuckRefunds: [],
  };
  let stripeError = "";

  try {
    const stripeRefunds = await getStripe().refunds.list({ limit: 100 });
    for (const sr of stripeRefunds.data) {
      if (sr.status !== "succeeded") continue;
      const known = await Refund.exists({ stripeRefundId: sr.id });
      if (known) continue;
      const rec = sr.payment_intent
        ? await paymentInfo
            .findOne({ transactionId: sr.payment_intent })
            .select("_id bookingId")
            .lean()
        : null;
      issues.stripeRefundsNotRecorded.push({
        stripeRefundId: sr.id,
        amount: asMoney(sr.amount / 100),
        paymentIntentId: sr.payment_intent || "",
        bookingId: rec?.bookingId || null,
        at: new Date((sr.created || 0) * 1000),
      });
    }
  } catch (e) {
    stripeError = "Stripe could not be reached for the refund check.";
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const oneHourAgo = new Date(Date.now() - 3600 * 1000);

  const [stuckPayouts, stuckRefunds, recentPaid] = await Promise.all([
    Payout.find({ status: "processing", updatedAt: { $lt: sevenDaysAgo } })
      .select("provider amount txnNumber createdAt updatedAt")
      .populate("provider", "name email")
      .limit(20)
      .lean(),
    Refund.find({
      status: { $in: ["approved", "processing"] },
      updatedAt: { $lt: oneDayAgo },
    })
      .select("booking amount status txnNumber createdAt updatedAt")
      .limit(20)
      .lean(),
    paymentInfo
      .find({
        paymentStatus: "complete",
        type: "booking",
        createdAt: { $lt: oneHourAgo },
      })
      .select("bookingId price transactionId createdAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  ]);
  issues.stuckPayouts = stuckPayouts;
  issues.stuckRefunds = stuckRefunds;

  if (recentPaid.length) {
    const bookingIds = recentPaid.map((p) => p.bookingId).filter(Boolean);
    const bookings = await Booking.find({ _id: { $in: bookingIds } })
      .select("payment.status")
      .lean();
    const paidSet = new Set(
      bookings
        .filter((b) => b.payment?.status === "paid")
        .map((b) => b._id.toString())
    );
    issues.paidPaymentsBookingNotPaid = recentPaid
      .filter((p) => p.bookingId && !paidSet.has(p.bookingId.toString()))
      .slice(0, 20);
  }

  let stripeBalance = null;
  try {
    const bal = await getStripe().balance.retrieve();
    stripeBalance = {
      available: (bal.available || []).map((b) => ({
        currency: b.currency.toUpperCase(),
        amount: asMoney(b.amount / 100),
      })),
      pending: (bal.pending || []).map((b) => ({
        currency: b.currency.toUpperCase(),
        amount: asMoney(b.amount / 100),
      })),
    };
  } catch (e) {
    /* balance optional hai */
  }

  const counts = {
    stripeRefundsNotRecorded: issues.stripeRefundsNotRecorded.length,
    stuckPayouts: issues.stuckPayouts.length,
    paidPaymentsBookingNotPaid: issues.paidPaymentsBookingNotPaid.length,
    stuckRefunds: issues.stuckRefunds.length,
  };
  counts.total =
    counts.stripeRefundsNotRecorded +
    counts.stuckPayouts +
    counts.paidPaymentsBookingNotPaid +
    counts.stuckRefunds;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Reconciliation fetched",
    data: { issues, counts, stripeBalance, stripeError, checkedAt: new Date() },
  });
});

export const exportAdminEarningsCsv = catchAsync(async (req, res) => {
  const { entries } = await buildEarningEntries(req.query);
  const filtered = earnFilterEntries(entries, req.query).slice(0, 5000);
  const header = [
    "Booking ID",
    "Date",
    "Customer",
    "Customer Email",
    "Provider",
    "Provider Email",
    "Service",
    "Gross",
    "Commission %",
    "Commission",
    "Net",
    "Tip",
    "Reversal",
    "Total to Provider",
    "Status",
  ];
  const lines = [header.map(bkCsvCell).join(",")];
  for (const entry of filtered) {
    lines.push(
      [
        entry.displayId,
        entry.date ? new Date(entry.date).toISOString() : "",
        entry.customer?.name || "",
        entry.customer?.email || "",
        entry.provider?.name || "",
        entry.provider?.email || "",
        entry.service?.title || entry.service?.serviceType || "",
        entry.grossAmount,
        entry.hasSnapshot
          ? Math.round((entry.commissionRate || 0) * 100)
          : "current",
        entry.commissionAmount,
        entry.netAmount,
        entry.tip,
        entry.reversalAmount,
        entry.totalToProvider,
        entry.status,
      ]
        .map(bkCsvCell)
        .join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="owvo-earnings.csv"'
  );
  return res.status(httpStatus.OK).send(lines.join("\n"));
});

// ─── Earnings adjustments (manual bonus / deduction) ────────────
export const getEarningAdjustments = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.providerId) filter.provider = req.query.providerId;
  const rows = await EarningAdjustment.find(filter)
    .populate("provider", "_id name email")
    .populate("booking", "_id")
    .populate("createdBy", "_id name email")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  const search = (req.query.search || "").toString().trim().toLowerCase();
  const adjustments = search
    ? rows.filter((row) =>
        [row.provider?.name, row.provider?.email, row.reason].some((value) =>
          (value || "").toLowerCase().includes(search)
        )
      )
    : rows;
  const total = adjustments.reduce(
    (sum, row) =>
      asMoney(
        sum + (row.type === "deduction" ? -asMoney(row.amount) : asMoney(row.amount))
      ),
    0
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Earning adjustments fetched",
    data: { adjustments, total },
  });
});

export const createEarningAdjustment = catchAsync(async (req, res) => {
  const { providerId, bookingId, type, amount, reason } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(providerId || "")) {
    throw new AppError(httpStatus.BAD_REQUEST, "Valid providerId is required");
  }
  if (!["bonus", "deduction"].includes(type)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Adjustment type must be bonus or deduction"
    );
  }
  const value = asMoney(amount);
  if (!value || value <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Amount must be greater than 0");
  }
  if (!reason || !reason.toString().trim()) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A reason is required for an adjustment"
    );
  }
  const provider = await User.findById(providerId);
  if (!provider || provider.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Provider not found");
  }
  let booking = null;
  if (bookingId) {
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid bookingId");
    }
    booking = await Booking.findById(bookingId);
    if (!booking || booking.provider?.toString() !== providerId) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Booking does not belong to this provider"
      );
    }
  }
  const adjustment = await EarningAdjustment.create({
    provider: providerId,
    booking: booking ? booking._id : null,
    type,
    amount: value,
    reason: reason.toString().trim(),
    createdBy: req.user._id,
  });
  await recordActivity({
    req,
    action: "earnings.adjustment_created",
    entityType: "earningAdjustment",
    entityId: adjustment._id,
    metadata: { providerId, type, amount: value },
  });
  notifyUser(providerId.toString(), {
    title: "Earnings adjustment",
    body:
      type === "bonus"
        ? `A bonus of £${value.toFixed(2)} has been added to your earnings.`
        : `A deduction of £${value.toFixed(2)} has been applied to your earnings.`,
    data: { type: "earning_adjustment" },
  });
  const data = await EarningAdjustment.findById(adjustment._id)
    .populate("provider", "_id name email")
    .populate("createdBy", "_id name email")
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Adjustment added",
    data,
  });
});

// ─── Manual earning hold / release ──────────────────────────────
export const holdBookingEarning = catchAsync(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }
  if (booking.status !== "completed") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Only a completed booking has earnings to hold"
    );
  }
  const { amount, reason } = req.body || {};
  if (!reason || !reason.toString().trim()) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A reason is required to hold earnings"
    );
  }
  if (booking.earningHold?.active) {
    throw new AppError(
      httpStatus.CONFLICT,
      "This booking's earnings are already on hold"
    );
  }
  const rate = await getCurrentCommissionRate();
  const net = bookingNetAmount(booking, rate);
  const requested = amount ? asMoney(amount) : net;
  const holdAmount = Math.min(requested, net);
  if (!holdAmount || holdAmount <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Nothing available to hold");
  }
  booking.earningHold = {
    active: true,
    amount: holdAmount,
    reason: reason.toString().trim(),
    by: req.user._id,
    at: new Date(),
    releasedAt: null,
    releasedBy: null,
  };
  await booking.save();
  await recordActivity({
    req,
    action: "earnings.hold_placed",
    entityType: "booking",
    entityId: booking._id,
    metadata: { amount: holdAmount, reason: booking.earningHold.reason },
  });
  if (booking.provider) {
    notifyUser(booking.provider.toString(), {
      title: "Earnings on hold",
      body: `£${holdAmount.toFixed(2)} of your earnings has been placed on hold.`,
      data: { type: "earning_hold", bookingId: booking._id.toString() },
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Earnings placed on hold",
    data: { bookingId: booking._id, earningHold: booking.earningHold },
  });
});

export const releaseBookingEarning = catchAsync(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }
  if (!booking.earningHold?.active) {
    throw new AppError(
      httpStatus.CONFLICT,
      "This booking's earnings are not on hold"
    );
  }
  const heldAmount = asMoney(booking.earningHold.amount || 0);
  booking.earningHold.active = false;
  booking.earningHold.releasedAt = new Date();
  booking.earningHold.releasedBy = req.user._id;
  await booking.save();
  await recordActivity({
    req,
    action: "earnings.hold_released",
    entityType: "booking",
    entityId: booking._id,
    metadata: { amount: heldAmount },
  });
  if (booking.provider) {
    notifyUser(booking.provider.toString(), {
      title: "Earnings released",
      body: `£${heldAmount.toFixed(2)} of held earnings has been released.`,
      data: { type: "earning_hold_released", bookingId: booking._id.toString() },
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Earnings hold released",
    data: { bookingId: booking._id, earningHold: booking.earningHold },
  });
});
