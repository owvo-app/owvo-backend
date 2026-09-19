import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Booking } from "../model/booking.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { Rating } from "../model/rating.model.js";
import { Service } from "../model/service.model.js";
import { User } from "../model/user.model.js";
import ProviderAcceptance from "../model/providerAcceptance.model.js";
import { TrainingModule } from "../model/trainingModule.model.js";
import { Notification } from "../model/notification.model.js";
import { WashHistory } from "../model/WashHistory.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import { Payout } from "../model/payout.model.js";
import { sendEmail } from "../utils/sendEmail.js";
import { broadcast, emitToUser } from "../socket/socket.js";
import {
  isProviderAvailableNow,
  normalizeAvailability,
} from "../utils/availability.util.js";
import { syncProviderCompletedJobs } from "../utils/completedJobs.util.js";
import catchAsync from "../utils/catch.Async.js";
import {
  ensureProviderServices,
  getCurrentCatalogKeys,
  toPlainServices,
} from "../utils/defaultServices.util.js";
import {
  providerBusyStatuses,
  refreshProviderBusyState,
} from "../utils/providerBusy.util.js";
import sendResponse from "../utils/sendResponse.js";

const WASHER_POLICY_VERSION = "2026-06-03";

/**
 * Render (aur aksar reverse proxies) ke peeche req.ip proxy ka IP deta hai,
 * asal client ka nahi. X-Forwarded-For header mein asal IP hota hai (jo
 * multiple proxies ho to comma se separated list ka pehla wala).
 */
const getRequestIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "";
};

const approximateLocation = (location) => {
  const coordinates = location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return location;

  const round = (value) => Math.round(Number(value) * 1000) / 1000;
  return {
    type: location.type || "Point",
    coordinates: [round(coordinates[0]), round(coordinates[1])],
  };
};

const hasAcceptedWasherPolicies = (washer) =>
  Boolean(
    washer?.policyAcceptance?.safetyGuidelinesAccepted &&
      washer?.policyAcceptance?.washerAgreementAccepted
  );

const assertWasherPoliciesAccepted = (washer) => {
  if (!hasAcceptedWasherPolicies(washer)) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Please accept the Owvo Safety Guidelines and Washer Agreement before continuing."
    );
  }
};

const assertWasherAdminApproved = (washer) => {
  if (washer?.adminVerification?.status !== "approved") {
    const status = washer?.adminVerification?.status || "not_submitted";
    const message =
      status === "pending"
        ? "Your documents are currently under review. You can go online once OWVO verification is complete."
        : status === "rejected"
          ? "Your OWVO provider verification was not approved. Please update your documents or contact support."
          : "Please complete your OWVO provider verification documents. You can go online once admin approval is complete.";

    throw new AppError(
      httpStatus.FORBIDDEN,
      message
    );
  }

  if (["suspended", "banned"].includes(washer?.enforcement?.status)) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Your OWVO provider account is restricted. Please contact support."
    );
  }
};

const toWasherSocketPayload = (washer) => ({
  _id: washer._id.toString(),
  name: washer.name,
  photo: washer.photo,
  phoneNumber: washer.phoneNumber,
  location: washer.location,
  latitude: washer.location?.coordinates?.[1],
  longitude: washer.location?.coordinates?.[0],
});

const toServiceSocketPayload = (service) => {
  if (!service) return null;
  return {
    _id: service._id?.toString(),
    title: service.title,
    price: service.price,
    serviceType: service.serviceType,
    carSize: service.carSize,
    carName: service.carName,
    carModel: service.carModel,
  };
};

const toVehicleSocketPayload = (booking) => {
  const vehicle = booking.vehicle;
  if (
    vehicle &&
    typeof vehicle === "object" &&
    (vehicle.registrationNo || vehicle.make || vehicle.model || vehicle.size)
  ) {
    return {
      _id: vehicle._id?.toString(),
      registrationNo: vehicle.registrationNo,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      size: vehicle.size,
      image: vehicle.image,
    };
  }

  if (booking.vehicleSnapshot) {
    return {
      _id: booking.vehicle?.toString?.(),
      ...booking.vehicleSnapshot,
    };
  }

  return null;
};

const toCustomerSocketPayload = (customer) => {
  if (!customer) return null;

  return {
    _id: customer._id?.toString(),
    name: customer.name,
    email: customer.email,
    phoneNumber: customer.phoneNumber,
    phone: customer.phoneNumber,
    photo: customer.photo,
    location: customer.location,
    residentialAddress: customer.residentialAddress,
    providerAddress: customer.providerAddress,
    averageRating: customer.customerRatingAverage || 0,
    totalRatings: customer.customerRatingCount || 0,
  };
};

export const getAllWashers = catchAsync(async (req, res) => {
  const washers = await User.find({ role: "provider" }).select(
    "_id name photo isOnline isBusy dailyWashLimit location preferredServices customerRatingAverage customerRatingCount"
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washers retrieved successfully",
    data: washers,
  });
});

export const getWasherStatus = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id).select(
    "dailyWashLimit isOnline isBusy availability location policyAcceptance"
  );

  if (!washer) {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washer status fetched",
    data: washer,
  });
});

export const getWasherPolicyStatus = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id).select(
    "role policyAcceptance"
  );

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washer policy status fetched",
    data: {
      policyAcceptance: washer.policyAcceptance,
      allAccepted: hasAcceptedWasherPolicies(washer),
    },
  });
});

export const acceptWasherPolicies = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id);

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  const {
    safetyGuidelinesAccepted,
    washerAgreementAccepted,
    termsConditionsAccepted,
    privacyPolicyAccepted,
    marketplaceRulesAccepted,
    independentContractorAgreementAccepted,
    device,
    appVersion,
  } = req.body || {};
  const now = new Date();
  const ipAddress = getRequestIp(req);

  washer.policyAcceptance = washer.policyAcceptance || {};
  washer.policyAcceptance.version = WASHER_POLICY_VERSION;

  // Har flag: request body mein jo naam aata hai, policyAcceptance mein
  // jo field set hoti hai, aur audit log mein jo "type" jata hai.
  const flagMap = [
    { input: safetyGuidelinesAccepted, field: "safetyGuidelines", type: "safety_guidelines" },
    { input: washerAgreementAccepted, field: "washerAgreement", type: "washer_agreement" },
    { input: termsConditionsAccepted, field: "termsConditions", type: "terms_conditions" },
    { input: privacyPolicyAccepted, field: "privacyPolicy", type: "privacy_policy" },
    { input: marketplaceRulesAccepted, field: "marketplaceRules", type: "marketplace_rules" },
    {
      input: independentContractorAgreementAccepted,
      field: "independentContractorAgreement",
      type: "independent_contractor_agreement",
    },
  ];

  // Har acceptance ka ek alag audit record banate hain, taake purani
  // history bhi mehfooz rahe (sirf abhi ka status nahi).
  const auditEntries = [];

  for (const { input, field, type } of flagMap) {
    if (input !== true) continue;

    washer.policyAcceptance[`${field}Accepted`] = true;
    washer.policyAcceptance[`${field}AcceptedAt`] = now;
    auditEntries.push({
      provider: washer._id,
      type,
      version: WASHER_POLICY_VERSION,
      acceptedAt: now,
      device: device || "",
      appVersion: appVersion || "",
      ipAddress,
    });
  }

  await washer.save();

  if (auditEntries.length > 0) {
    // Audit trail save na ho paye to bhi acceptance khud fail nahi honi
    // chahiye — is liye alag try/catch mein rakha hai.
    try {
      await ProviderAcceptance.insertMany(auditEntries);
    } catch (err) {
      console.error("Failed to write acceptance audit log:", err);
    }
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washer policies updated",
    data: {
      policyAcceptance: washer.policyAcceptance,
      allAccepted: hasAcceptedWasherPolicies(washer),
    },
  });
});

/**
 * POST /washers/training/complete
 * Body: { moduleId, percentWatched, device, appVersion }
 * Provider Academy mein ek module poora dekhne par Flutter isay call
 * karta hai (TrainingProgressService.syncToServer).
 */
export const submitTrainingCompletion = catchAsync(async (req, res) => {
  if (req.user?.role !== "provider") {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Only providers can submit training completion"
    );
  }

  const { moduleId, percentWatched, device, appVersion } = req.body || {};

  if (!moduleId || typeof moduleId !== "string") {
    throw new AppError(httpStatus.BAD_REQUEST, "moduleId is required");
  }

  const record = await ProviderAcceptance.create({
    provider: req.user._id,
    type: "training_module",
    moduleId,
    percentWatched:
      typeof percentWatched === "number" ? percentWatched : 100,
    acceptedAt: new Date(),
    device: device || "",
    appVersion: appVersion || "",
    ipAddress: getRequestIp(req),
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Training completion recorded",
    data: record,
  });
});

export const getWasherAvailability = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id).select("availability role");

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Availability fetched successfully",
    data: washer.availability || normalizeAvailability(),
  });
});

export const updateWasherAvailability = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id);

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  washer.availability = normalizeAvailability(req.body);

  if (washer.isOnline && !isProviderAvailableNow(washer)) {
    washer.isOnline = false;
  }

  await washer.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Availability updated successfully",
    data: washer.availability,
  });
});

export const goOnline = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id);

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  assertWasherPoliciesAccepted(washer);
  assertWasherAdminApproved(washer);

  if (!isProviderAvailableNow(washer)) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "You are outside your saved availability. Set 24/7 active or update today's hours."
    );
  }

  if (washer.dailyWashLimit <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Daily wash limit completed");
  }

  await refreshProviderBusyState(washer);
  washer.isOnline = true;
  await washer.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washer is online",
  });
});

export const goOffline = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id);

  if (!washer) {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  washer.isOnline = false;
  washer.isBusy = false;
  await washer.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washer is offline",
  });
});

export const acceptBooking = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id);
  const { status, cancellationReason } = req.body || {};
  const normalizedCancellationReason =
    typeof cancellationReason === "string"
      ? cancellationReason.trim().slice(0, 280)
      : "";
  const providerCancellationMessage = normalizedCancellationReason
    ? `Your booking has been cancelled by the provider. Reason: ${normalizedCancellationReason}`
    : "Your booking has been cancelled by the provider.";

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  assertWasherPoliciesAccepted(washer);
  assertWasherAdminApproved(washer);

  const statusMessages = {
    accepted: "Your booking has been accepted!",
    ongoing: "Your car wash has started!",
    completed: "Your car wash is complete! Please rate your experience.",
    cancelled: providerCancellationMessage,
    arrived: "The User has arrived at your location.",
  };

  if (!statusMessages[status]) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid booking status");
  }

  if (status !== "cancelled" && washer.dailyWashLimit <= 0) {
    washer.isOnline = false;
    await washer.save();
    throw new AppError(httpStatus.BAD_REQUEST, "Wash limit completed");
  }

  const booking = await Booking.findById(req.params.bookingId)
    .populate(
      "user",
      "_id name email phoneNumber photo location residentialAddress providerAddress customerRatingAverage customerRatingCount"
    )
    .populate("service", "_id title price serviceType carSize carName carModel")
    .populate("vehicle", "registrationNo make model year size image isDefault");

  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  if (booking.provider.toString() !== washer._id.toString()) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "You cannot update this booking"
    );
  }

  const activeBooking = await refreshProviderBusyState(washer);
  if (
    providerBusyStatuses.includes(status) &&
    activeBooking &&
    activeBooking._id.toString() !== booking._id.toString()
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer is currently busy");
  }
  // ✅ Real-time notifications based on status change
  const washerPayload = toWasherSocketPayload(washer);
  const servicePayload = toServiceSocketPayload(booking.service);
  const vehiclePayload = toVehicleSocketPayload(booking);
  const customerPayload = toCustomerSocketPayload(booking.user);
  const bookingUserId =
    booking.user?._id?.toString?.() || booking.user?.toString();
  const bookingProviderId =
    booking.provider?._id?.toString?.() || booking.provider?.toString();

  if (status === "completed" || status === "arrived") {
    if (status === "completed") {
      washer.dailyWashLimit -= 1;
    }

    emitToUser(bookingUserId, "booking_status_update", {
      bookingId: booking._id,
      status,
      washer: washerPayload,
      washerId: washer._id.toString(),
      provider: washer._id.toString(),
      providerLatitude: washer.location?.coordinates?.[1],
      providerLongitude: washer.location?.coordinates?.[0],
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      price: booking.price,
      finalPrice: booking.finalPrice,
      discount: booking.discountPrice,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: statusMessages[status],
    });
    emitToUser(bookingProviderId, "booking_status_update", {
      bookingId: booking._id,
      status,
      user: customerPayload,
      userId: bookingUserId,
      washer: washerPayload,
      washerId: washer._id.toString(),
      provider: washer._id.toString(),
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      price: booking.price,
      finalPrice: booking.finalPrice,
      discount: booking.discountPrice,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message:
        status === "completed"
          ? "Booking marked as completed."
          : statusMessages[status],
    });
  } else {
    emitToUser(bookingUserId, "booking_status_update", {
      bookingId: booking._id,
      status,
      washer: washerPayload,
      washerId: washer._id.toString(),
      provider: washer._id.toString(),
      providerLatitude: washer.location?.coordinates?.[1],
      providerLongitude: washer.location?.coordinates?.[0],
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      price: booking.price,
      finalPrice: booking.finalPrice,
      discount: booking.discountPrice,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: statusMessages[status],
      cancellationReason:
        status === "cancelled" ? normalizedCancellationReason : undefined,
      cancelledBy: status === "cancelled" ? "provider" : undefined,
    });
  }

  booking.status = status;
  if (status === "cancelled") {
    booking.cancellationReason = normalizedCancellationReason;
    booking.cancelledBy = "provider";
    booking.cancelledAt = new Date();
  }
  if (status === "arrived" && !booking.arrivedAt) {
    booking.arrivedAt = new Date();
    booking.washEndsAt = new Date(booking.arrivedAt.getTime() + 30 * 60 * 1000);
  }
  await booking.save();
  await refreshProviderBusyState(washer);
  if (washer.isModified()) {
    await washer.save();
  }
  const providerCompletedJobs =
    status === "completed"
      ? await syncProviderCompletedJobs(bookingProviderId)
      : null;

  broadcast("admin_booking_status_updated", {
    bookingId: booking._id.toString(),
    status,
    providerId: bookingProviderId,
    userId: bookingUserId,
    completedJobs: providerCompletedJobs,
    cancellationReason: booking.cancellationReason,
    cancelledBy: booking.cancelledBy,
    cancelledAt: booking.cancelledAt,
    updatedAt: booking.updatedAt,
  });
  // ✅ Notify user their booking was accepted and wash has started
  if (status === "accepted" || status === "ongoing") {
    emitToUser(bookingUserId, "booking_accepted", {
      bookingId: booking._id,
      washer: washerPayload,
      washerId: washer._id.toString(),
      provider: washer._id.toString(),
      status,
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      price: booking.price,
      finalPrice: booking.finalPrice,
      discount: booking.discountPrice,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: "Your booking has been accepted! The washer is on the way.",
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Car wash started",
  });
});

export const completeWash = catchAsync(async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId);

  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  booking.status = "completed";
  await booking.save();

  const washer = await User.findById(req.user._id);

  await refreshProviderBusyState(washer);

  if (washer.dailyWashLimit <= 0) {
    washer.isOnline = false;
  }

  await washer.save();
  const providerCompletedJobs = await syncProviderCompletedJobs(booking.provider);

  broadcast("admin_booking_status_updated", {
    bookingId: booking._id.toString(),
    status: "completed",
    providerId: booking.provider.toString(),
    userId: booking.user.toString(),
    completedJobs: providerCompletedJobs,
    updatedAt: booking.updatedAt,
  });

  await WashHistory.create({
    washer: washer._id,
    booking: booking._id,
  });

  // ✅ Notify user the wash is complete
  emitToUser(booking.user.toString(), "wash_completed", {
    bookingId: booking._id,
    status: "completed",
    price: booking.price,
    finalPrice: booking.finalPrice,
    discount: booking.discountPrice,
    message: "Your car wash is complete! Please rate your experience.",
  });

  // ✅ Notify washer (confirmation on their side)
  emitToUser(washer._id.toString(), "wash_completed_confirm", {
    bookingId: booking._id,
    status: "completed",
    price: booking.price,
    finalPrice: booking.finalPrice,
    discount: booking.discountPrice,
    message: "Wash marked as completed successfully.",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Wash completed successfully",
  });
});


export const getWasherDetails = catchAsync(async (req, res) => {
  const { washerId } = req.params;
  const userId = req.user?._id;

  if (!mongoose.Types.ObjectId.isValid(washerId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid washerId");
  }

  const washer = await User.findById(washerId).select(
    "fullName name role isOnline isBusy avatar photo profileImage"
  );

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
  const skip = (page - 1) * limit;

  // ✅ Rating summary (adjust field name if your schema uses `washer` instead of `provider`)
  const ratingAgg = await Rating.aggregate([
    { $match: { provider: new mongoose.Types.ObjectId(washerId) } },
    {
      $group: {
        _id: "$provider",
        avgRating: { $avg: "$rating" },
        ratingCount: { $sum: 1 },
      },
    },
  ]);

  const avgRating = ratingAgg[0]?.avgRating ?? 0;
  const ratingCount = ratingAgg[0]?.ratingCount ?? 0;
  const recentReviews = await Rating.find({
    provider: new mongoose.Types.ObjectId(washerId),
  })
    .populate("user", "name photo")
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  // ✅ Correct: filter by user inside DB + correct total + pagination
  const result = await WashHistory.aggregate([
    { $match: { washer: new mongoose.Types.ObjectId(washerId) } },
    {
      $lookup: {
        from: "bookings",
        localField: "booking",
        foreignField: "_id",
        as: "booking",
      },
    },
    { $unwind: "$booking" },
    { $match: { "booking.user": new mongoose.Types.ObjectId(userId) } },
    { $sort: { createdAt: -1 } },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: "services",
              localField: "booking.service",
              foreignField: "_id",
              as: "service",
            },
          },
          { $unwind: { path: "$service", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              washHistoryId: "$_id",
              bookingId: "$booking._id",
              addressLine: { $ifNull: ["$booking.address.addressLine", ""] },
              bookingDate: "$booking.bookingDate",
              serviceName: { $ifNull: ["$service.title", "Service"] },
              status: "$booking.status",
              price: "$booking.finalPrice",
              currency: { $ifNull: ["$booking.currency", "GBP"] },
            },
          },
        ],
        total: [{ $count: "count" }],
      },
    },
  ]);

  const rows = result?.[0]?.data || [];
  const total = result?.[0]?.total?.[0]?.count || 0;

  // ✅ Figma labels: "Sep 5" + "5:32 PM"
  const toDateLabel = (d) =>
    d
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
          new Date(d)
        )
      : "";
  const toTimeLabel = (d) =>
    d
      ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
          new Date(d)
        )
      : "";

  const history = rows.map((r) => ({
    bookingId: r.bookingId,
    addressLine: r.addressLine,
    dateLabel: toDateLabel(r.bookingDate),
    timeLabel: toTimeLabel(r.bookingDate),
    price: r.price ?? 0,
    currency: r.currency || "GBP",
    status: r.status,
    serviceName: r.serviceName || "Service",
  }));

  const latestBooking = history[0] || null;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Washer details fetched successfully",
    data: {
      washer: {
        _id: washer._id,
        name: washer.fullName || washer.name,
        isOnline: washer.isOnline,
        isBusy: washer.isBusy,
        avatar: washer.avatar || washer.photo || washer.profileImage || null,
        avgRating: Number(avgRating.toFixed(1)),
        ratingCount,
      },
      recentReviews: recentReviews.map((review) => ({
        _id: review._id,
        rating: review.rating,
        review: review.review,
        createdAt: review.createdAt,
        user: review.user
          ? {
              _id: review.user._id,
              name: review.user.name,
              photo: review.user.photo,
            }
          : null,
      })),
      latestBooking,
      history,
      meta: { page, limit, total },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PREFERRED SERVICES  (provider only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/washers/preferred-services
 * Returns the logged-in washer's preferred service list.
 */
export const getPreferredServices = catchAsync(async (req, res) => {
  const washer = await User.findById(req.user._id).populate(
    "preferredServices",
    "catalogKey title price serviceType carSize carName carModel description isActive"
  );

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Preferred services fetched",
    data: washer.preferredServices,
  });
});

/**
 * POST /api/v1/washers/preferred-services
 * Body: { serviceId }
 * Adds a service to the washer's preferred list (no duplicates).
 */
export const addPreferredService = catchAsync(async (req, res) => {
  const { serviceId } = req.body;

  if (!serviceId) {
    throw new AppError(httpStatus.BAD_REQUEST, "serviceId is required");
  }

  if (!mongoose.Types.ObjectId.isValid(serviceId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid serviceId");
  }

  const service = await Service.findById(serviceId);
  if (!service) {
    throw new AppError(httpStatus.NOT_FOUND, "Service not found");
  }

  const washer = await User.findById(req.user._id);
  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  // Prevent duplicates
  const alreadyAdded = washer.preferredServices.some(
    (id) => id.toString() === serviceId.toString()
  );
  if (alreadyAdded) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Service is already in your preferred list"
    );
  }

  washer.preferredServices.push(serviceId);
  await washer.save();
  await washer.populate(
    "preferredServices",
    "catalogKey title price serviceType carSize carName carModel description isActive"
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Preferred service added",
    data: washer.preferredServices,
  });
});

/**
 * DELETE /api/v1/washers/preferred-services/:serviceId
 * Removes a service from the washer's preferred list.
 */
export const removePreferredService = catchAsync(async (req, res) => {
  const { serviceId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(serviceId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid serviceId");
  }

  const washer = await User.findById(req.user._id);
  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  washer.preferredServices = washer.preferredServices.filter(
    (id) => id.toString() !== serviceId.toString()
  );
  await washer.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Preferred service removed",
    data: washer.preferredServices,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION  (provider only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/washers/location
 * Body: { latitude, longitude }
 * Updates the washer's current GPS location (GeoJSON Point).
 * Should be called by the provider app whenever their position changes,
 * or at minimum when going online.
 */
export const updateWasherLocation = catchAsync(async (req, res) => {
  if (req.user?.role !== "provider") {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Only providers can update washer location"
    );
  }

  const {
    latitude,
    longitude,
    streetAddress,
    city,
    country,
    postcode,
    addressLine,
  } = req.body;

  if (latitude === undefined || longitude === undefined) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "latitude and longitude are required"
    );
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "latitude and longitude must be valid numbers"
    );
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "latitude must be -90 to 90 and longitude must be -180 to 180"
    );
  }

  const update = {
    location: {
      type: "Point",
      coordinates: [lng, lat], // MongoDB GeoJSON: [longitude, latitude]
    },
  };

  if (streetAddress !== undefined) {
    update["providerAddress.streetAddress"] = streetAddress;
  }
  if (city !== undefined) update["providerAddress.city"] = city;
  if (country !== undefined) update["providerAddress.country"] = country;
  if (postcode !== undefined) update["providerAddress.postcode"] = postcode;
  if (addressLine !== undefined) {
    update.residentialAddress = addressLine;
    update.serviceArea = addressLine;
  }

  const washer = await User.findByIdAndUpdate(
    req.user._id,
    { $set: update },
    {
      new: true,
      select: "location providerAddress residentialAddress serviceArea isOnline isBusy",
    }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Location updated successfully",
    data: {
      location: washer.location,
      providerAddress: washer.providerAddress,
      residentialAddress: washer.residentialAddress,
      serviceArea: washer.serviceArea,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEARBY WASHERS  (public / user-facing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/washers/nearby
 * Query params:
 *   latitude   {number} required  – user's current latitude
 *   longitude  {number} required  – user's current longitude
 *   radius     {number} optional  – max distance in metres (default 5000 = 5 km)
 *   serviceId  {string} optional  – filter to washers who have this service in
 *                                    their preferredServices list
 *
 * Uses MongoDB $nearSphere with a 2dsphere index to return online washers
 * sorted by distance (nearest first).
 */
export const getNearbyWashers = catchAsync(async (req, res) => {
  const { latitude, longitude, radius = 5000, serviceId } = req.query;

  if (!latitude || !longitude) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "latitude and longitude query params are required"
    );
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const maxDistance = parseInt(radius, 10);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "latitude and longitude must be valid numbers"
    );
  }

  // Build query — $nearSphere handles the geo-distance filter
  const query = {
    role: "provider",
    isOnline: true,
    "adminVerification.status": "approved",
    "enforcement.status": { $nin: ["suspended", "banned"] },
    "policyAcceptance.safetyGuidelinesAccepted": true,
    "policyAcceptance.washerAgreementAccepted": true,
    location: {
      $nearSphere: {
        $geometry: {
          type: "Point",
          coordinates: [lng, lat], // MongoDB: [longitude, latitude]
        },
        $maxDistance: maxDistance,
      },
    },
  };

  // Optionally narrow to washers who have the requested service
  if (serviceId) {
    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid serviceId");
    }
    query.preferredServices = new mongoose.Types.ObjectId(serviceId);
  }

  const washers = await User.find(query)
    .select(
      "_id name photo isOnline isBusy dailyWashLimit location preferredServices availability"
    )
    .populate(
      "preferredServices",
      "catalogKey title price serviceType carSize carName carModel description isActive"
    );
  const availableWashers = washers.filter((washer) =>
    isProviderAvailableNow(washer)
  );
  await Promise.all(
    availableWashers.map((washer) => refreshProviderBusyState(washer))
  );
  const providerIds = availableWashers.map((washer) => washer._id);
  const providerIdsWithServiceRecords = new Set(
    (
      await Service.distinct("provider", {
        provider: { $in: providerIds },
      })
    ).map((providerId) => providerId.toString())
  );
  const unconfiguredProviderIds = providerIds.filter(
    (providerId) => !providerIdsWithServiceRecords.has(providerId.toString())
  );
  await Promise.all(
    unconfiguredProviderIds.map((providerId) =>
      ensureProviderServices(providerId)
    )
  );

  const providerServices = await Service.find({
    provider: { $in: providerIds },
    isActive: true,
    catalogKey: { $in: getCurrentCatalogKeys() },
  })
    .select("provider catalogKey title price serviceType carSize carName carModel description isActive")
    .sort({ price: 1 });
  const servicesByProviderId = new Map();
  providerServices.forEach((service) => {
    const providerId = service.provider.toString();
    if (!servicesByProviderId.has(providerId)) {
      servicesByProviderId.set(providerId, []);
    }
    servicesByProviderId.get(providerId).push(service);
  });

  const ratingStats = await Rating.aggregate([
    { $match: { provider: { $in: providerIds } } },
    {
      $group: {
        _id: "$provider",
        averageRating: { $avg: "$rating" },
        totalRatings: { $sum: 1 },
      },
    },
  ]);
  const ratingsByProviderId = new Map(
    ratingStats.map((stat) => [
      stat._id.toString(),
      {
        averageRating: Number(stat.averageRating.toFixed(1)),
        totalRatings: stat.totalRatings,
      },
    ])
  );
  const washersWithServices = availableWashers.map((washer) => {
    const washerData = washer.toObject();
    const providerId = washerData._id.toString();
    const preferredServices = toPlainServices(
      servicesByProviderId.get(providerId) || []
    );
    const rating = ratingsByProviderId.get(providerId) || {
      averageRating: null,
      totalRatings: 0,
    };

    return {
      _id: washerData._id,
      name: washerData.name,
      photo: washerData.photo,
      isOnline: washerData.isOnline,
      isBusy: washerData.isBusy,
      dailyWashLimit: washerData.dailyWashLimit,
      location: approximateLocation(washerData.location),
      preferredServices,
      averageRating: rating.averageRating,
      totalRatings: rating.totalRatings,
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Nearby washers fetched",
    data: washersWithServices,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER INCOME  (provider only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/washers/income/today
 * Returns the provider's earnings for the current day (today only).
 * Query params:
 *   washerId (optional) - filter by specific provider (admin only)
 *   userId (optional)   - filter by specific customer/user
 */
export const getDayIncomeProvider = catchAsync(async (req, res) => {
  let providerId = req.user._id;
  const { washerId, userId } = req.query;

  // If washerId is provided, only admin can access other providers' data
  if (washerId) {
    if (req.user?.role !== "admin") {
      throw new AppError(httpStatus.FORBIDDEN, "Only admin can view other providers' income.");
    }
    if (!mongoose.Types.ObjectId.isValid(washerId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid washerId");
    }
    providerId = washerId;
  } else if (req.user?.role !== "provider" && req.user?.role !== "admin") {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied. Provider or Admin only.");
  }

  // Get start and end of today (UTC)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  // Build query filter
  const filter = {
    provider: providerId,
    status: "completed",
    completedAt: {
      $gte: today,
      $lt: tomorrow,
    },
  };

  if (userId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid userId");
    }
    filter.user = userId;
  }

  // Query completed bookings for this provider on today's date
  const bookings = await Booking.find(filter).select("user finalPrice discountPrice price createdAt completedAt");

  // Calculate totals
  const totalIncome = bookings.reduce((sum, booking) => sum + (booking.finalPrice || 0), 0);
  const totalDiscount = bookings.reduce((sum, booking) => sum + (booking.discountPrice || 0), 0);
  const totalOriginal = bookings.reduce((sum, booking) => sum + (booking.price || 0), 0);
  const bookingCount = bookings.length;

  // Get tips earned today
  const bookingIds = bookings.map((booking) => booking._id);
  const tipsToday = await paymentInfo.find({
    type: "tips",
    paymentStatus: "complete",
    $or: [
      { providerId },
      { bookingId: { $in: bookingIds } },
    ],
    createdAt: {
      $gte: today,
      $lt: tomorrow,
    },
  });

  const totalTipsToday = tipsToday.reduce((sum, tip) => sum + (tip.price || 0), 0);
  
  // Include tips in total income
  const totalIncomeWithTips = totalIncome + totalTipsToday;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Today's income fetched successfully",
    data: {
      date: today.toISOString().split("T")[0],
      totalIncome: totalIncomeWithTips,
      totalOriginal,
      totalDiscount,
      totalTipsToday,
      bookingCount,
      bookings: bookings.map((b) => ({
        bookingId: b._id,
        userId: b.user,
        originalPrice: b.price,
        discount: b.discountPrice,
        finalPrice: b.finalPrice,
        completedAt: b.completedAt,
      })),
    },
  });
});

/**
 * GET /api/v1/washers/income/weekly
 * Returns the provider's earnings for the current week (Monday to Sunday).
 * Query params:
 *   washerId (optional) - filter by specific provider (admin only)
 *   userId (optional)   - filter by specific customer/user
 */
export const getWeeklyIncomeProvider = catchAsync(async (req, res) => {
  let providerId = req.user._id;
  const { washerId, userId } = req.query;

  // If washerId is provided, only admin can access other providers' data
  if (washerId) {
    if (req.user?.role !== "admin") {
      throw new AppError(httpStatus.FORBIDDEN, "Only admin can view other providers' income.");
    }
    if (!mongoose.Types.ObjectId.isValid(washerId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid washerId");
    }
    providerId = washerId;
  } else if (req.user?.role !== "provider" && req.user?.role !== "admin") {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied. Provider or Admin only.");
  }

  // Get current date
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Calculate start of week (Monday)
  const startOfWeek = new Date(now);
  startOfWeek.setUTCDate(now.getUTCDate() - (currentDay === 0 ? 6 : currentDay - 1));
  startOfWeek.setUTCHours(0, 0, 0, 0);

  // Calculate end of week (Sunday) - 7 days from start
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 7);

  // Build query filter
  const filter = {
    provider: providerId,
    status: "completed",
    completedAt: {
      $gte: startOfWeek,
      $lt: endOfWeek,
    },
  };

  if (userId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid userId");
    }
    filter.user = userId;
  }

  // Query completed bookings for this provider in the current week
  const bookings = await Booking.find(filter).select("user finalPrice discountPrice price createdAt completedAt");

  // Calculate totals
  const totalIncome = bookings.reduce((sum, booking) => sum + (booking.finalPrice || 0), 0);
  const totalDiscount = bookings.reduce((sum, booking) => sum + (booking.discountPrice || 0), 0);
  const totalOriginal = bookings.reduce((sum, booking) => sum + (booking.price || 0), 0);
  const bookingCount = bookings.length;

  // Get tips earned this week
  const bookingIds = bookings.map((booking) => booking._id);
  const tipsThisWeek = await paymentInfo.find({
    type: "tips",
    paymentStatus: "complete",
    $or: [
      { providerId },
      { bookingId: { $in: bookingIds } },
    ],
    createdAt: {
      $gte: startOfWeek,
      $lt: endOfWeek,
    },
  });

  const totalTipsWeekly = tipsThisWeek.reduce((sum, tip) => sum + (tip.price || 0), 0);
  
  // Include tips in total income
  const totalIncomeWithTips = totalIncome + totalTipsWeekly;

  // Group by day for detailed breakdown with all bookings per day
  const dailyBreakdown = {};
  bookings.forEach((booking) => {
    const dayStr = new Date(booking.completedAt).toISOString().split("T")[0];
    if (!dailyBreakdown[dayStr]) {
      dailyBreakdown[dayStr] = {
        date: dayStr,
        count: 0,
        income: 0,
        discount: 0,
        original: 0,
        bookings: [],
      };
    }
    dailyBreakdown[dayStr].count += 1;
    dailyBreakdown[dayStr].income += booking.finalPrice || 0;
    dailyBreakdown[dayStr].discount += booking.discountPrice || 0;
    dailyBreakdown[dayStr].original += booking.price || 0;
    dailyBreakdown[dayStr].bookings.push({
      bookingId: booking._id,
      userId: booking.user,
      originalPrice: booking.price,
      discount: booking.discountPrice,
      finalPrice: booking.finalPrice,
      completedAt: booking.completedAt,
    });
  });

  // Convert to array sorted by date
  const dailyBreakdownArray = Object.values(dailyBreakdown).sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Weekly income fetched successfully",
    data: {
      weekStart: startOfWeek.toISOString().split("T")[0],
      weekEnd: new Date(endOfWeek.getTime() - 1).toISOString().split("T")[0],
      totalIncome: totalIncomeWithTips,
      totalOriginal,
      totalDiscount,
      totalTipsWeekly,
      bookingCount,
      dailyBreakdown: dailyBreakdownArray,
    },
  });
});
/**
 * GET /washers/training/modules
 * Provider Academy ki maujooda list — admin jo bhi upload/reorder/mandatory
 * kare, ye endpoint hamesha taaza data deta hai. Har module ke sath ye bhi
 * bata deta hai ke YE provider isay complete kar chuka hai ya nahi (aur
 * agar admin ne training reset ki ho to us tareekh ke baad ka hi ginte hain).
 */
export const getTrainingModules = catchAsync(async (req, res) => {
  const provider = await User.findById(req.user._id).select("trainingResetAt");

  const modules = await TrainingModule.find({ isActive: true })
    .sort({ order: 1 })
    .lean();

  const completionQuery = {
    provider: req.user._id,
    type: "training_module",
  };
  if (provider?.trainingResetAt) {
    completionQuery.createdAt = { $gte: provider.trainingResetAt };
  }

  const completions = await ProviderAcceptance.find(completionQuery)
    .select("moduleId")
    .lean();
  const completedModuleIds = new Set(completions.map((c) => c.moduleId));

  const result = modules.map((m) => ({
    _id: m._id,
    title: m.title,
    topics: m.topics,
    videoUrl: m.videoUrl,
    durationSeconds: m.durationSeconds,
    order: m.order,
    isMandatory: m.isMandatory,
    isCompleted: completedModuleIds.has(m._id.toString()),
  }));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Training modules fetched",
    data: result,
  });
});

/**
 * POST /washers/verify-postcode
 * Body: { postcode }
 * UK postcode ko validate karta hai aur uski city/county/coordinates
 * wapas deta hai — provider address form khud-ba-khud check/fill kar
 * sakta hai. postcodes.io use kiya hai (Google Maps ki jagah): ye free,
 * open UK postcode dataset hai, koi API key ya billing setup nahi chahiye.
 */
export const verifyPostcode = catchAsync(async (req, res) => {
  const { postcode } = req.body || {};

  if (!postcode || typeof postcode !== "string" || !postcode.trim()) {
    throw new AppError(httpStatus.BAD_REQUEST, "postcode is required");
  }

  const cleaned = postcode.trim().replace(/\s+/g, "");

  let response;
  try {
    response = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(cleaned)}`
    );
  } catch (err) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Could not reach the postcode lookup service. Please try again."
    );
  }

  if (response.status === 404) {
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Postcode not found",
      data: { valid: false },
    });
    return;
  }

  if (!response.ok) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Postcode lookup failed. Please try again."
    );
  }

  const payload = await response.json();
  const result = payload?.result;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Postcode verified",
    data: {
      valid: true,
      postcode: result?.postcode,
      city: result?.admin_district || result?.parish || "",
      county: result?.admin_county || result?.region || "",
      country: result?.country || "England",
      latitude: result?.latitude,
      longitude: result?.longitude,
    },
  });
});

/**
 * GET /washers/notifications
 * Provider ki apni notifications — jaise admin ke bheje huye reminders.
 * Newest pehle. unreadCount bhi deta hai taake badge dikha sakein.
 */
export const getMyNotifications = catchAsync(async (req, res) => {
  const notifications = await Notification.find({ recipient: req.user._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const unreadCount = await Notification.countDocuments({
    recipient: req.user._id,
    isRead: false,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notifications fetched",
    data: { notifications, unreadCount },
  });
});

/**
 * PATCH /washers/notifications/read-all
 * Provider notification tab kholte hi call hota hai — sab read mark ho
 * jati hain, badge saaf ho jata hai.
 */
export const markAllNotificationsRead = catchAsync(async (req, res) => {
  await Notification.updateMany(
    { recipient: req.user._id, isRead: false },
    { $set: { isRead: true } }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notifications marked as read",
    data: null,
  });
});

// ════════════════════════════════════════════════════════════════════════
// WALLET — provider ki apni earnings, payouts, aur booking-level breakdown.
// ════════════════════════════════════════════════════════════════════════

const asMoney = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

const getPlatformSettingsDoc = async () =>
  PlatformSetting.findOneAndUpdate(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

/**
 * Ek booking ki gross value se provider ka net (commission minus) hissa
 * nikalta hai. Sab wallet endpoints yehi ek jagah se rate leti hain —
 * admin jab chahe Settings se rate badle, sab khud update ho jata hai.
 */
const netProviderShare = (grossAmount, commissionRate) =>
  asMoney(grossAmount * (1 - commissionRate));

/**
 * GET /washers/wallet/summary
 * Available balance, pending balance, lifetime earnings, this week, today,
 * tips, commission rate, aur total jobs — sab NET (commission minus) hain.
 */
export const getWalletSummary = catchAsync(async (req, res) => {
  const providerId = req.user._id;
  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const currentDay = now.getUTCDay();
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - (currentDay === 0 ? 6 : currentDay - 1));
  weekStart.setUTCHours(0, 0, 0, 0);

  const completedFilter = { provider: providerId, status: "completed" };

  const [lifetimeAgg, weekAgg, todayAgg, jobsCompleted, tipsAgg, paidOutAgg] =
    await Promise.all([
      Booking.aggregate([
        { $match: completedFilter },
        { $group: { _id: null, total: { $sum: "$finalPrice" } } },
      ]),
      Booking.aggregate([
        { $match: { ...completedFilter, completedAt: { $gte: weekStart } } },
        { $group: { _id: null, total: { $sum: "$finalPrice" } } },
      ]),
      Booking.aggregate([
        { $match: { ...completedFilter, completedAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: "$finalPrice" } } },
      ]),
      Booking.countDocuments(completedFilter),
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
    ]);

  const lifetimeGross = lifetimeAgg[0]?.total || 0;
  const weekGross = weekAgg[0]?.total || 0;
  const todayGross = todayAgg[0]?.total || 0;
  const totalTips = asMoney(tipsAgg[0]?.total || 0);
  const totalPaidOut = asMoney(paidOutAgg[0]?.total || 0);

  const lifetimeNet = asMoney(
    netProviderShare(lifetimeGross, commissionRate) + totalTips
  );
  const weekNet = asMoney(netProviderShare(weekGross, commissionRate));
  const todayNet = asMoney(netProviderShare(todayGross, commissionRate));

  // Pending = payouts jo ban chuke hain lekin abhi provider ke bank tak
  // nahi pahunche (queue mein hain). Available = kamaya hua paisa jo
  // abhi tak kisi payout mein shamil nahi hua.
  const pendingPayoutsAgg = await Payout.aggregate([
    {
      $match: {
        provider: providerId,
        status: { $in: ["pending", "processing"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const pendingBalance = asMoney(pendingPayoutsAgg[0]?.total || 0);
  const availableBalance = asMoney(
    Math.max(0, lifetimeNet - totalPaidOut - pendingBalance)
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Wallet summary fetched",
    data: {
      availableBalance,
      pendingBalance,
      lifetimeEarnings: lifetimeNet,
      thisWeekEarnings: weekNet,
      todayEarnings: todayNet,
      totalTips,
      commissionRate,
      totalJobsCompleted: jobsCompleted,
    },
  });
});

/**
 * GET /washers/wallet/payouts
 * Provider ki apni payout history — Payout collection se, jo admin
 * banata hai. Sabse pehla "pending"/"processing" record hi "next payout"
 * hai — koi fixed schedule nahi manaya gaya, jo asal mein bana hai wohi
 * dikhaya jata hai.
 */
export const getWalletPayouts = catchAsync(async (req, res) => {
  const providerId = req.user._id;

  const payouts = await Payout.find({ provider: providerId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const nextPayout =
    payouts.find((p) => ["pending", "processing"].includes(p.status)) || null;
  const lastPaidPayout = payouts.find((p) => p.status === "paid") || null;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Payout history fetched",
    data: {
      payouts,
      nextPayout: nextPayout
        ? { date: nextPayout.payoutDate, status: nextPayout.status, amount: nextPayout.amount }
        : null,
      lastPayout: lastPaidPayout
        ? { date: lastPaidPayout.paidAt, amount: lastPaidPayout.amount }
        : null,
    },
  });
});

/**
 * GET /washers/wallet/earnings?period=today|week|month|custom&from=&to=
 * Har booking ka poora breakdown — service, gross price, provider ka
 * hissa, OWVO commission, tip, tareekh.
 */
export const getWalletEarnings = catchAsync(async (req, res) => {
  const providerId = req.user._id;
  const { period = "week", from, to } = req.query;

  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;

  const now = new Date();
  let rangeStart;
  let rangeEnd = now;

  if (period === "today") {
    rangeStart = new Date(now);
    rangeStart.setUTCHours(0, 0, 0, 0);
  } else if (period === "month") {
    rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (period === "custom") {
    if (!from || !to) {
      throw new AppError(httpStatus.BAD_REQUEST, "from and to are required for a custom range");
    }
    rangeStart = new Date(from);
    rangeEnd = new Date(to);
    if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid from/to date");
    }
  } else {
    // default: this week (Monday-based, matches the rest of the app)
    const currentDay = now.getUTCDay();
    rangeStart = new Date(now);
    rangeStart.setUTCDate(now.getUTCDate() - (currentDay === 0 ? 6 : currentDay - 1));
    rangeStart.setUTCHours(0, 0, 0, 0);
  }

  const bookings = await Booking.find({
    provider: providerId,
    status: "completed",
    completedAt: { $gte: rangeStart, $lte: rangeEnd },
  })
    .populate("service", "title")
    .sort({ completedAt: -1 })
    .lean();

  const bookingIds = bookings.map((b) => b._id);
  const tips = await paymentInfo
    .find({
      type: "tips",
      paymentStatus: "complete",
      bookingId: { $in: bookingIds },
    })
    .lean();
  const tipByBooking = new Map(tips.map((t) => [String(t.bookingId), t.price || 0]));

  const rows = bookings.map((booking) => {
    const gross = booking.finalPrice || 0;
    const commissionAmount = asMoney(gross * commissionRate);
    const providerEarning = asMoney(gross - commissionAmount);
    const tip = asMoney(tipByBooking.get(String(booking._id)) || 0);

    return {
      bookingId: booking._id,
      serviceName: booking.service?.title || "Service",
      servicePrice: gross,
      providerEarning,
      commissionAmount,
      tip,
      completedAt: booking.completedAt,
      // Completed booking ka matlab hai payment pehle hi settle ho chuka
      // hai (booking flow payment-first hai) — koi alag paymentStatus
      // field Booking model mein nahi hai.
      paymentStatus: "paid",
    };
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Earnings breakdown fetched",
    data: {
      period,
      from: rangeStart,
      to: rangeEnd,
      commissionRate,
      rows,
    },
  });
});

/**
 * POST /washers/wallet/email-statement
 * Body: { period: "today" | "week" | "month" }
 * Aaj ke, is hafte ke, ya is mahine ke earnings ka statement provider ke
 * apne registered email par bhejta hai. Wahi commission-split calculation
 * use karta hai jo /wallet/earnings mein hai — dono hamesha match karenge.
 */
export const emailWalletStatement = catchAsync(async (req, res) => {
  const providerId = req.user._id;
  const period = (req.body?.period || "month").toString();

  const provider = await User.findById(providerId).select("name email");
  if (!provider?.email) {
    throw new AppError(httpStatus.BAD_REQUEST, "No email address on file for this account");
  }

  const settings = await getPlatformSettingsDoc();
  const commissionRate = Number(settings.commissionRate) || 0.25;

  const now = new Date();
  let rangeStart;
  let periodLabel;
  if (period === "today") {
    rangeStart = new Date(now);
    rangeStart.setUTCHours(0, 0, 0, 0);
    periodLabel = "Today";
  } else if (period === "week") {
    const currentDay = now.getUTCDay();
    rangeStart = new Date(now);
    rangeStart.setUTCDate(now.getUTCDate() - (currentDay === 0 ? 6 : currentDay - 1));
    rangeStart.setUTCHours(0, 0, 0, 0);
    periodLabel = "This Week";
  } else {
    rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    periodLabel = "This Month";
  }

  const bookings = await Booking.find({
    provider: providerId,
    status: "completed",
    completedAt: { $gte: rangeStart, $lte: now },
  })
    .populate("service", "title")
    .sort({ completedAt: -1 })
    .lean();

  let grossTotal = 0;
  let netTotal = 0;
  const rowsHtml = bookings
    .map((booking) => {
      const gross = booking.finalPrice || 0;
      const commission = asMoney(gross * commissionRate);
      const net = asMoney(gross - commission);
      grossTotal += gross;
      netTotal += net;
      const dateLabel = booking.completedAt
        ? new Date(booking.completedAt).toLocaleDateString("en-GB")
        : "-";
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${dateLabel}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${booking.service?.title || "Service"}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">£${gross.toFixed(2)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">-£${commission.toFixed(2)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">£${net.toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;">
      <h2 style="color:#0b1420;">OWVO Earnings Statement — ${periodLabel}</h2>
      <p style="color:#636363;">Hi ${provider.name || "there"}, here is your earnings summary for ${periodLabel.toLowerCase()}.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:8px;text-align:left;">Date</th>
            <th style="padding:8px;text-align:left;">Service</th>
            <th style="padding:8px;text-align:right;">Price</th>
            <th style="padding:8px;text-align:right;">OWVO ${Math.round(commissionRate * 100)}%</th>
            <th style="padding:8px;text-align:right;">Your Earning</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="5" style="padding:12px;color:#9ca3af;">No completed washes in this period.</td></tr>'}</tbody>
      </table>
      <p style="margin-top:18px;font-size:15px;">
        <strong>Total earned: £${asMoney(netTotal).toFixed(2)}</strong>
        (from £${asMoney(grossTotal).toFixed(2)} gross, ${bookings.length} job${bookings.length === 1 ? "" : "s"})
      </p>
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;">This is an automated statement from OWVO.</p>
    </div>
  `;

  await sendEmail(provider.email, `OWVO Earnings Statement — ${periodLabel}`, html);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Statement emailed",
    data: { email: provider.email, jobCount: bookings.length },
  });
});