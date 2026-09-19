import httpStatus from "http-status";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import Stripe from "stripe";
import { User } from "../model/user.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catch.Async.js";
import { Booking } from "../model/booking.model.js";
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
import { uploadOnCloudinary } from "../utils/common.Method.js";
import { emitToUser, broadcast } from "../socket/socket.js";
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
  ]);

  const totalRevenue = asMoney(totalRevenueAgg[0]?.total);
  const todayRevenue = asMoney(todayRevenueAgg[0]?.total);
  const weekRevenue = asMoney(weekRevenueAgg[0]?.total);
  const monthRevenue = asMoney(monthRevenueAgg[0]?.total);
  const pendingPayoutAmount = asMoney(
    completedBookingsForPayout.reduce(
      (sum, booking) => sum + (Number(booking.finalPrice) || 0) * (1 - commissionRate),
      0
    )
  );
  const platformBalance = asMoney(totalRevenue * commissionRate);

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
        count: completedBookingsForPayout.length,
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

  const providers = await User.find(mergeFilter({ role: "provider" }, "createdAt", req.query))
    .select(dashboardUserSelect)
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
  const customers = await User.find(mergeFilter({ role: "user" }, "createdAt", req.query))
    .select(dashboardUserSelect)
    .sort({
      createdAt: -1,
    })
    .lean();
  const customerIds = customers.map((customer) => customer._id).filter(Boolean);
  const [ratingStats, recentReviews] = await Promise.all([
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
  const data = customers.map((customer) => ({
    ...customer,
    ...ratingsByCustomerId.get(customer._id.toString()),
    recentReviews: reviewsByCustomerId.get(customer._id.toString()) || [],
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All customers fetched successfully",
    data,
  });
});

export const getAdminBookings = catchAsync(async (req, res) => {
  const {
    status,
    providerId,
    customerId,
    from,
    to,
    limit = 50,
    page = 1,
  } = req.query;

  const filter = {};
  if (status && BOOKING_STATUSES.includes(status)) filter.status = status;
  if (providerId && mongoose.Types.ObjectId.isValid(providerId)) {
    filter.provider = providerId;
  }
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    filter.user = customerId;
  }
  if (from || to) {
    filter.bookingDate = {};
    if (from) filter.bookingDate.$gte = new Date(from);
    if (to) filter.bookingDate.$lte = new Date(to);
  } else {
    Object.assign(filter, dateFilter("bookingDate", req.query));
  }

  const pageNumber = Math.max(Number(page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const [items, total] = await Promise.all([
    Booking.find(filter)
      .populate(bookingPopulate)
      .sort({ createdAt: -1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize),
    Booking.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin bookings fetched successfully",
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

export const getAdminBookingById = catchAsync(async (req, res) => {
  const { id } = req.params;

  const booking = await Booking.findById(id).populate(bookingPopulate);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin booking fetched successfully",
    data: booking,
  });
});

export const updateAdminBookingStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

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

  booking.status = status;
  if (status === "arrived" && !booking.arrivedAt) {
    booking.arrivedAt = new Date();
    booking.washEndsAt = new Date(booking.arrivedAt.getTime() + 30 * 60 * 1000);
  }

  await booking.save();
  await refreshProviderBusyState(booking.provider);
  await createReceiptForCompletedBooking(booking);
  const completedJobs =
    status === "completed"
      ? await syncProviderCompletedJobs(booking.provider)
      : null;
  await booking.populate(bookingPopulate);

  emitDashboardBookingStatus(booking, status, { completedJobs });
  await recordActivity({
    req,
    action: "booking.status_updated",
    entityType: "booking",
    entityId: booking._id,
    metadata: { status },
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

  if (service.isActive === false) {
    providerUpdate.isActive = false;
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

export const getAdminEarnings = catchAsync(async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;
  const completedRangeFilter = dateFilter("completedAt", req.query);

  const [bookings, paidPayoutsAgg] = await Promise.all([
    Booking.find({ status: "completed", ...completedRangeFilter })
      .populate("user", "_id name email")
      .populate("provider", "_id name email")
      .populate("service", "_id title serviceType")
      .sort({ completedAt: -1, updatedAt: -1 })
      .limit(300)
      .lean(),
    Payout.aggregate([
      { $match: { status: "paid", ...dateFilter("createdAt", req.query) } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const entries = bookings.map((booking) => {
    const grossAmount = asMoney(booking.finalPrice);
    const commissionAmount = asMoney(grossAmount * commissionRate);
    const netAmount = asMoney(grossAmount - commissionAmount);

    return {
      bookingId: booking._id,
      date: booking.completedAt || booking.updatedAt,
      customer: booking.user,
      provider: booking.provider,
      service: booking.service,
      grossAmount,
      commissionRate,
      commissionAmount,
      netAmount,
      currency: booking.currency || "GBP",
      status: "available",
    };
  });

  const sumEntries = (predicate) =>
    entries
      .filter(predicate)
      .reduce(
        (totals, entry) => ({
          grossAmount: asMoney(totals.grossAmount + entry.grossAmount),
          commissionAmount: asMoney(totals.commissionAmount + entry.commissionAmount),
          netAmount: asMoney(totals.netAmount + entry.netAmount),
        }),
        { grossAmount: 0, commissionAmount: 0, netAmount: 0 }
      );

  const totalNet = entries.reduce((sum, entry) => sum + entry.netAmount, 0);
  const totalCommission = entries.reduce((sum, entry) => sum + entry.commissionAmount, 0);
  const paidOut = asMoney(paidPayoutsAgg[0]?.total);

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
        period: sumEntries(() => true),
        netProfit: asMoney(totalCommission),
        pendingNet: asMoney(Math.max(totalNet - paidOut, 0)),
        paidOut,
      },
      entries,
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
    const commissionAmount = asMoney(grossAmount * commissionRate);
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

  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;
  const [grossAgg, allocatedAgg] = await Promise.all([
    Booking.aggregate([
      { $match: { provider: provider._id, status: "completed" } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    // "paid" aur "pending"/"processing" dono ginte hain — warna admin
    // ek hi paisa do payouts mein bhej sakta hai (pehla abhi queue mein
    // hai, dusra usi balance ko phir se "available" samajh kar ban jaye).
    Payout.aggregate([
      {
        $match: {
          provider: provider._id,
          status: { $in: ["paid", "pending", "processing"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);
  const grossAmount = asMoney(grossAgg[0]?.total);
  const netEarned = asMoney(grossAmount * (1 - commissionRate));
  const alreadyAllocated = asMoney(allocatedAgg[0]?.total);
  const payableAmount = asMoney(Math.max(netEarned - alreadyAllocated, 0));

  if (payoutAmount > payableAmount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Payout exceeds provider's available balance (${payoutCurrency} ${payableAmount.toFixed(2)}). This already accounts for any pending payouts.`
    );
  }

  const payout = await Payout.create({
    provider: provider._id,
    amount: payoutAmount,
    currency: payoutCurrency,
    status,
    payoutDate: payoutDate ? new Date(payoutDate) : undefined,
    paidAt: status === "paid" ? new Date() : undefined,
    stripeDestinationAccountId: "",
    stripeMode: "manual",
    manualAdjustmentReason:
      manualAdjustmentReason?.toString?.().trim() ||
      "Manual provider salary marked paid by admin",
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  await recordActivity({
    req,
    action: "payout.created",
    entityType: "payout",
    entityId: payout._id,
    metadata: {
      providerId,
      amount: payoutAmount,
      status: payout.status,
      stripeMode: "manual",
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

  payout.status = status;
  payout.failureReason = status === "failed" ? failureReason.toString().trim() : "";
  payout.paidAt = status === "paid" ? new Date() : payout.paidAt;
  payout.updatedBy = req.user._id;
  await payout.save();

  await recordActivity({
    req,
    action: "payout.status_updated",
    entityType: "payout",
    entityId: payout._id,
    metadata: { status, failureReason },
  });
  broadcast("admin_payout_updated", { payoutId: payout._id, status: payout.status });

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
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    Booking.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
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

  const periodCommission = asMoney((periodCompletedAgg[0]?.total || 0) * commissionRate);
  const allCommission = asMoney((allCompletedAgg[0]?.total || 0) * commissionRate);
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

  const [allCompletedAgg, allWithdrawnAgg] = await Promise.all([
    Booking.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]),
    AdminWithdrawal.aggregate([
      { $match: { status: { $ne: "failed" } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const allCommission = asMoney((allCompletedAgg[0]?.total || 0) * commissionRate);
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
  const { title, topics, isMandatory } = req.body || {};

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
  const { title, topics, isMandatory, isActive } = req.body || {};

  const module = await TrainingModule.findById(id);
  if (!module) {
    throw new AppError(httpStatus.NOT_FOUND, "Training module not found");
  }

  if (typeof title === "string" && title.trim()) module.title = title.trim();
  if (Array.isArray(topics)) module.topics = topics;
  if (typeof isMandatory === "boolean") module.isMandatory = isMandatory;
  if (typeof isActive === "boolean") module.isActive = isActive;

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
    .select("_id title")
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

  const overview = Array.from(byProvider.values()).map((entry) => ({
    provider: entry.provider,
    lastActivityAt: entry.lastActivityAt,
    completedCount: entry.completedModuleIds.size,
    totalModules: modules.length,
    completedModuleIds: Array.from(entry.completedModuleIds),
  }));

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