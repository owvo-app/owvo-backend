import fs from "fs";
import path from "path";
import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Booking } from "../model/booking.model.js";
import { ChatMessage } from "../model/chatMessage.model.js";
import { DataRequest } from "../model/dataRequest.model.js";
import { Payout } from "../model/payout.model.js";
import { Wallet } from "../model/wallet.model.js";
import { IssueReport } from "../model/issueReport.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { Rating } from "../model/rating.model.js";
import { Receipt } from "../model/receipt.model.js";
import { User } from "../model/user.model.js";
import { UserRating } from "../model/userRating.model.js";
import { Vehicle } from "../model/vehicle.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { broadcast, emitToUser } from "../socket/socket.js";
import { recordActivity } from "../utils/activityLog.util.js";
import { notifyUser } from "../utils/fcm.util.js";
import { sendAdminAlert } from "../utils/adminAlert.util.js";
import { computeProviderBalances } from "../utils/money.util.js";

const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads");
const DATA_EXPORT_SNAPSHOT_VERSION = "2026-07-13-readable-v1";

const toObjectId = (value) =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);

const compactRequest = (request) => {
  const data = request.toObject ? request.toObject() : { ...request };
  if (data.status !== "approved") {
    data.exportData = null;
  }
  return data;
};

// Dashboard accounts store their name in `name`; app users in `fullName`.
// Always select both so the admin panel can show a real name.
const adminUserSelect = "_id name fullName email role phoneNumber photo accountStatus";
const adminReviewerSelect = "_id name fullName email role";

const DUE_MS = 30 * 24 * 60 * 60 * 1000;

// Rows created before due dates existed get a computed one (createdAt + 30d)
// for display, without rewriting the stored document.
const withComputedDueAt = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  if (!obj.dueAt && obj.createdAt) {
    obj.dueAt = new Date(new Date(obj.createdAt).getTime() + DUE_MS);
  }
  return obj;
};

const removeLocalUpload = (storedUrl = "") => {
  const value = storedUrl.toString().trim();
  if (!value.startsWith("/uploads/")) return;

  const resolved = path.resolve(process.cwd(), value.replace(/^\/+/, ""));
  if (!resolved.startsWith(UPLOADS_ROOT)) return;

  try {
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
  } catch {
    // Deletion should continue even if an old local file is already gone.
  }
};

const removeUserLocalUploads = (user) => {
  const urls = [
    user?.photo?.url,
    user?.identityVerification?.idFile?.url,
    user?.identityVerification?.passportOrDrivingLicenseFile?.url,
    user?.insurance?.document?.url,
    user?.publicLiabilityInsurance?.document?.url,
    user?.drivewayPhoto?.document?.url,
  ];

  urls.filter(Boolean).forEach(removeLocalUpload);
};
const personSelect = "_id name fullName email role phoneNumber photo";
const serviceSelect = "_id title price serviceType carSize carName carModel";
const vehicleSelect = "_id registrationNo make model year size image isDefault";
const bookingSelect =
  "_id user provider service vehicle vehicleSnapshot price discountPrice finalPrice address postalCode bookingDate payment status cancellationReason cancelledBy cancelledAt isRated currency completedAt arrivedAt washEndsAt createdAt updatedAt";
const bookingPopulate = [
  { path: "user", select: personSelect },
  { path: "provider", select: personSelect },
  { path: "service", select: serviceSelect },
  { path: "vehicle", select: vehicleSelect },
];
const getRatingSnapshot = async (id, role) => {
  const Model = role === "provider" ? Rating : UserRating;
  const field = role === "provider" ? "provider" : "user";
  const rows = await Model.aggregate([
    { $match: { [field]: id } },
    {
      $group: {
        _id: `$${field}`,
        averageRating: { $avg: "$rating" },
        totalRatings: { $sum: 1 },
      },
    },
  ]);
  const stat = rows[0] || { averageRating: 0, totalRatings: 0 };

  return {
    averageRating: Number((stat.averageRating || 0).toFixed(1)),
    totalRatings: stat.totalRatings || 0,
  };
};

const hydrateProfileForExport = async (profile, id) => {
  if (!profile) return profile;

  const ratingSnapshot = await getRatingSnapshot(id, profile.role);
  return {
    ...profile,
    customerRatingAverage: ratingSnapshot.averageRating,
    customerRatingCount: ratingSnapshot.totalRatings,
  };
};

export const buildUserDataExport = async (userId) => {
  const id = toObjectId(userId);

  const [
    profile,
    vehicles,
    bookings,
    payments,
    reports,
    chatMessages,
    providerRatings,
    customerRatings,
    receipts,
  ] = await Promise.all([
    User.findById(id)
      .select("-password -refreshToken -verificationInfo.token -password_reset_token")
      .populate("preferredServices", serviceSelect)
      .populate("adminVerification.reviewedBy", personSelect)
      .populate("enforcement.updatedBy", personSelect)
      .lean(),
    Vehicle.find({ user: id }).sort({ createdAt: -1 }).lean(),
    Booking.find({ $or: [{ user: id }, { provider: id }] })
      .populate(bookingPopulate)
      .sort({ createdAt: -1 })
      .lean(),
    paymentInfo.find({ $or: [{ userId: id }, { providerId: id }] })
      .populate("userId", personSelect)
      .populate("providerId", personSelect)
      .populate({ path: "bookingId", select: bookingSelect, populate: bookingPopulate })
      .sort({ createdAt: -1 })
      .lean(),
    IssueReport.find({ $or: [{ reporter: id }, { reportedUser: id }] })
      .populate("reporter", personSelect)
      .populate("reportedUser", personSelect)
      .populate({ path: "booking", select: bookingSelect, populate: bookingPopulate })
      .populate("assignedTo", personSelect)
      .populate("updatedBy", personSelect)
      .sort({ createdAt: -1 })
      .lean(),
    ChatMessage.find({ $or: [{ sender: id }, { recipient: id }, { participants: id }] })
      .populate({ path: "booking", select: bookingSelect, populate: bookingPopulate })
      .populate("sender", personSelect)
      .populate("recipient", personSelect)
      .populate("participants", personSelect)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean(),
    Rating.find({ $or: [{ user: id }, { provider: id }] })
      .populate("user", personSelect)
      .populate("provider", personSelect)
      .populate({ path: "booking", select: bookingSelect, populate: bookingPopulate })
      .sort({ createdAt: -1 })
      .lean(),
    UserRating.find({ $or: [{ user: id }, { provider: id }] })
      .populate("user", personSelect)
      .populate("provider", personSelect)
      .populate({ path: "booking", select: bookingSelect, populate: bookingPopulate })
      .sort({ createdAt: -1 })
      .lean(),
    Receipt.find({ $or: [{ user: id }, { provider: id }] })
      .populate("user", personSelect)
      .populate("provider", personSelect)
      .populate("service", serviceSelect)
      .populate({ path: "booking", select: bookingSelect, populate: bookingPopulate })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const hydratedProfile = await hydrateProfileForExport(profile, id);

  return {
    generatedAt: new Date(),
    snapshotVersion: DATA_EXPORT_SNAPSHOT_VERSION,
    retentionPolicy:
      "OWVO keeps operational account, booking, support, payment and verification records for up to 6 months unless a longer period is required by law, fraud prevention, dispute handling, tax, accounting, or safety obligations.",
    profile: hydratedProfile,
    vehicles,
    bookings,
    payments,
    reports,
    chatMessages,
    providerRatings,
    customerRatings,
    receipts,
  };
};

const ensureReadableExportSnapshot = async (request) => {
  if (!request || request.status !== "approved") return request;
  if (request.exportData?.snapshotVersion === DATA_EXPORT_SNAPSHOT_VERSION) {
    return request;
  }

  request.exportData = await buildUserDataExport(request.user);
  request.exportGeneratedAt = new Date();
  await request.save();
  return request;
};

export const createDataRequest = catchAsync(async (req, res) => {
  if (!["user", "provider"].includes(req.user?.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "Only app users can request their data.");
  }

  const existingPending = await DataRequest.findOne({
    user: req.user._id,
    status: "pending",
  });

  if (existingPending) {
    if (!existingPending.exportData || existingPending.exportData.snapshotVersion !== DATA_EXPORT_SNAPSHOT_VERSION) {
      existingPending.exportData = await buildUserDataExport(req.user._id);
      existingPending.exportGeneratedAt = existingPending.exportGeneratedAt || new Date();
      await existingPending.save();
    }

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Your data request is already pending review.",
      data: compactRequest(existingPending),
    });
  }

  const exportData = await buildUserDataExport(req.user._id);
  const request = await DataRequest.create({
    user: req.user._id,
    requesterRole: req.user.role,
    requestType: "export",
    requestNote: req.body?.requestNote?.toString().trim() || "",
    exportData,
    exportGeneratedAt: new Date(),
  });

  // Admin email alert (Settings > Notification Alerts) — fire-and-forget.
  sendAdminAlert(
    "data_request",
    "New data request waiting for review",
    `A ${req.user.role === "provider" ? "provider" : "customer"} has asked for a copy of their OWVO data. UK GDPR: it must be answered within 30 days.\n\nOpen the admin panel (Data Requests) to review it.`
  );

  // Tell the admin panel a new GDPR request has arrived (the page also
  // shows a pending-count badge in the sidebar).
  try {
    broadcast("admin_data_request_created", {
      requestId: request._id.toString(),
      status: request.status,
      requesterRole: request.requesterRole,
    });
  } catch {
    // Socket is best-effort; the request itself is already saved.
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Data request submitted successfully.",
    data: compactRequest(request),
  });
});

export const getMyDataRequests = catchAsync(async (req, res) => {
  const requests = await DataRequest.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(20);
  const repairedRequests = await Promise.all(
    requests.map(ensureReadableExportSnapshot)
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Data requests fetched successfully.",
    data: repairedRequests.map(compactRequest),
  });
});

export const getAdminDataRequests = catchAsync(async (req, res) => {
  const statusParam = req.query.status?.toString();
  const status = ["pending", "approved", "rejected"].includes(statusParam)
    ? statusParam
    : null;
  const search = req.query.search?.toString().trim() || "";
  const page = Math.max(1, Number.parseInt(req.query.page?.toString() || "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.limit?.toString() || "20", 10) || 20)
  );

  const filter = {};
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matchedUsers = await User.find({
      $or: [{ name: rx }, { fullName: rx }, { email: rx }],
    }).select("_id");
    const or = [{ user: { $in: matchedUsers.map((u) => u._id) } }];
    if (mongoose.Types.ObjectId.isValid(search)) {
      or.push({ _id: search });
    }
    filter.$or = or;
  }

  const now = new Date();
  const overdueFilter = {
    status: "pending",
    $or: [
      { dueAt: { $lt: now } },
      { dueAt: null, createdAt: { $lt: new Date(now.getTime() - DUE_MS) } },
    ],
  };
  // If a search is active the base filter already carries an $or, so the
  // overdue conditions must be combined with $and instead of overwriting it.
  const overdueCountFilter = filter.$or
    ? { $and: [filter, overdueFilter] }
    : { ...filter, ...overdueFilter };
  const [totalAll, pendingCount, approvedCount, rejectedCount, overdueCount] =
    await Promise.all([
      DataRequest.countDocuments(filter),
      DataRequest.countDocuments({ ...filter, status: "pending" }),
      DataRequest.countDocuments({ ...filter, status: "approved" }),
      DataRequest.countDocuments({ ...filter, status: "rejected" }),
      DataRequest.countDocuments(overdueCountFilter),
    ]);

  const listFilter = status ? { ...filter, status } : filter;
  const total = await DataRequest.countDocuments(listFilter);
  const requests = await DataRequest.find(listFilter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
  const repairedRequests = await Promise.all(
    requests.map(ensureReadableExportSnapshot)
  );
  await DataRequest.populate(repairedRequests, [
    { path: "user", select: adminUserSelect },
    { path: "reviewedBy", select: adminReviewerSelect },
  ]);
  const items = repairedRequests.map((request) => withComputedDueAt(request));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Data requests fetched successfully.",
    data: {
      items,
      total,
      page,
      limit,
      statusCounts: {
        total: totalAll,
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
        overdue: overdueCount,
      },
    },
  });
});

export const updateAdminDataRequest = catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const { status, adminNote = "" } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(requestId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid data request id.");
  }

  if (!["approved", "rejected"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Status must be approved or rejected.");
  }

  const request = await DataRequest.findById(requestId);
  if (!request) {
    throw new AppError(httpStatus.NOT_FOUND, "Data request not found.");
  }

  if (request.requestType === "deletion") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This is a record of a completed account deletion and cannot be reviewed."
    );
  }

  request.status = status;
  request.adminNote = adminNote.toString().trim();
  request.reviewedBy = req.user._id;
  request.reviewedAt = new Date();

  if (status === "approved") {
    if (!request.exportData || request.exportData.snapshotVersion !== DATA_EXPORT_SNAPSHOT_VERSION) {
      request.exportData = await buildUserDataExport(request.user);
      request.exportGeneratedAt = new Date();
    } else if (!request.exportGeneratedAt) {
      request.exportGeneratedAt = request.createdAt || new Date();
    }
  } else {
    request.exportData = null;
    request.exportGeneratedAt = null;
  }

  await request.save();

  emitToUser(request.user.toString(), "data_request_updated", {
    requestId: request._id.toString(),
    status: request.status,
    message:
      status === "approved"
        ? "Your OWVO data request has been approved."
        : "Your OWVO data request has been rejected.",
  });

  // Push + a saved notification, so the user hears about the decision
  // even when the app is closed (the socket emit above only reaches an
  // open app).
  await notifyUser(request.user, {
    title:
      status === "approved"
        ? "Your data request was approved"
        : "Your data request was rejected",
    body:
      status === "approved"
        ? "You can now view and copy your OWVO data export in the app under Help > Privacy & Account Help."
        : "Your OWVO data request was rejected. Please contact support if you need more information.",
    data: {
      type: "data_request",
      requestId: request._id.toString(),
      status: request.status,
    },
  });

  try {
    broadcast("admin_data_request_updated", {
      requestId: request._id.toString(),
      status: request.status,
    });
  } catch {
    // Socket is best-effort.
  }

  await recordActivity({
    req,
    action:
      status === "approved" ? "data_request.approved" : "data_request.rejected",
    entityType: "DataRequest",
    entityId: request._id,
    metadata: {
      requesterRole: request.requesterRole,
      requestType: request.requestType || "export",
    },
  });

  const populated = await DataRequest.findById(request._id)
    .populate("user", adminUserSelect)
    .populate("reviewedBy", adminReviewerSelect)
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Data request updated successfully.",
    data: withComputedDueAt(populated),
  });
});

export const downloadAdminDataRequestExport = catchAsync(async (req, res) => {
  const { requestId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(requestId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid data request id.");
  }

  const request = await DataRequest.findById(requestId);
  if (!request) {
    throw new AppError(httpStatus.NOT_FOUND, "Data request not found.");
  }

  if (request.requestType === "deletion") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Deletion records do not have an export file."
    );
  }

  if (request.status !== "approved" || !request.exportData) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Approve the request before downloading its export."
    );
  }

  await recordActivity({
    req,
    action: "data_request.export_downloaded",
    entityType: "DataRequest",
    entityId: request._id,
    metadata: { requesterRole: request.requesterRole },
  });

  const filename = `owvo-data-export-${request._id
    .toString()
    .slice(-6)
    .toUpperCase()}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(httpStatus.OK).send(JSON.stringify(request.exportData, null, 2));
});

export const deleteMyAccount = catchAsync(async (req, res) => {
  if (!["user", "provider"].includes(req.user?.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "This account cannot be deleted from the app.");
  }

  const confirmed =
    req.body?.confirm === true ||
    req.body?.confirmation?.toString().trim().toUpperCase() === "DELETE";

  if (!confirmed) {
    throw new AppError(httpStatus.BAD_REQUEST, "Please confirm account deletion.");
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found.");
  }

  // Deletion guards (standard-app behaviour): money or a live booking
  // must be settled first, otherwise records and payouts get stranded.
  const activeBooking = await Booking.findOne({
    $or: [{ user: user._id }, { provider: user._id }],
    status: { $in: ["pending", "accepted", "arrived", "ongoing"] },
  }).select("_id");
  if (activeBooking) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You have an active booking. Please complete or cancel it before deleting your account."
    );
  }

  if (user.role === "user") {
    const wallet = await Wallet.findOne({ user: user._id }).select("balance");
    if (wallet && Number(wallet.balance) > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `You still have £${Number(wallet.balance).toFixed(2)} in your OWVO wallet. Please use it or contact support before deleting your account.`
      );
    }
  }

  if (user.role === "provider") {
    const balances = await computeProviderBalances(user._id);
    if (balances && Number(balances.available) > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `You have £${Number(balances.available).toFixed(2)} of earnings waiting to be paid out. Please cash out or contact support before deleting your account.`
      );
    }
    const openPayout = await Payout.findOne({
      provider: user._id,
      status: { $in: ["pending", "processing"] },
    }).select("_id");
    if (openPayout) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "A payout is still in progress for your account. Please wait for it to finish before deleting your account."
      );
    }
  }

  removeUserLocalUploads(user);

  // Best-effort: also remove the user's files from Cloudinary (the local
  // cleanup above only covers files stored under /uploads). A failure
  // here never blocks the deletion.
  try {
    const publicIds = [
      user?.photo?.public_id,
      user?.identityVerification?.idFile?.public_id,
      user?.identityVerification?.passportOrDrivingLicenseFile?.public_id,
      user?.insurance?.document?.public_id,
      user?.publicLiabilityInsurance?.document?.public_id,
      user?.drivewayPhoto?.document?.public_id,
    ].filter((v) => typeof v === "string" && v.trim());
    if (publicIds.length) {
      const { v2: cloudinary } = await import("cloudinary");
      for (const publicId of publicIds) {
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch {
          // Ignore — the file may already be gone.
        }
      }
    }
  } catch {
    // Cloudinary cleanup is best-effort only.
  }

  const id = user._id;
  const suffix = `${id.toString().slice(-8)}-${Date.now()}`;
  const isCustomer = user.role === "user";

  await Promise.all([
    Vehicle.deleteMany({ user: id }),
    ChatMessage.updateMany(
      { $or: [{ sender: id }, { recipient: id }, { participants: id }] },
      { $set: { text: "[Deleted account message removed]" } }
    ),
    Rating.updateMany(
      { $or: [{ user: id }, { provider: id }] },
      { $set: { review: "" } }
    ),
    UserRating.updateMany(
      { $or: [{ user: id }, { provider: id }] },
      { $set: { review: "" } }
    ),
    IssueReport.updateMany(
      { reporter: id },
      {
        $set: {
          description: "[Deleted account report removed]",
          photo: {},
        },
      }
    ),
    isCustomer
      ? Booking.updateMany(
          { user: id },
          {
            $set: {
              "address.addressLine": "Deleted account address removed",
              "address.latitude": 0,
              "address.longitude": 0,
              postalCode: "",
              vehicleSnapshot: {
                registrationNo: "",
                make: "",
                model: "",
                size: "",
                image: "",
              },
            },
          }
        )
      : Promise.resolve(),
  ]);

  user.name = "Deleted account";
  // App users carry their real name in `fullName` — without this line the
  // anonymised account would keep showing the person's real name.
  user.fullName = "Deleted account";
  user.email = `deleted-${suffix}@deleted.owvo.local`;
  user.password = `deleted-${suffix}`;
  user.refreshToken = "";
  user.password_reset_token = "";
  user.verificationInfo = { verified: false, token: "" };
  user.isEmailVerified = false;
  user.accountStatus = "disabled";
  user.deleteReason = req.body?.reason?.toString().trim() || "Self-service account deletion";
  user.deletedAt = new Date();
  user.phoneNumber = undefined;
  user.language = "English";
  user.serviceArea = "";
  user.nationalInsuranceNumber = "";
  user.photo = { public_id: "", url: "" };
  user.residentialAddress = "";
  user.providerAddress = { streetAddress: "", city: "", country: "", postcode: "" };
  user.rightToWorkUK = false;
  user.isProfileCompleted = false;
  user.identityVerification = {
    documentType: "",
    documentNumber: "",
    idFile: {},
    passportOrDrivingLicenseFile: {},
    status: "pending",
  };
  user.drivewayEligibility = {};
  user.isIdentityCompleted = false;
  user.bankDetails = {};
  user.stripeConnect = {};
  user.isBankCompleted = false;
  user.insurance = { document: { public_id: "", url: "" } };
  user.publicLiabilityInsurance = { document: { public_id: "", url: "" } };
  user.drivewayPhoto = { document: { public_id: "", url: "" } };
  user.location = undefined;
  user.preferredServices = [];
  user.isOnline = false;
  user.isBusy = false;

  await user.save();

  // The person's old data-request export snapshots hold a full copy of
  // their data — wipe the contents (the request records themselves stay
  // for the admin audit trail, without the personal data inside).
  await DataRequest.updateMany(
    { user: id },
    { $set: { exportData: null, exportGeneratedAt: null, requestNote: "" } }
  );

  // Leave a record the admin can see on the Data Requests page: who
  // deleted their account, and when. It is a record, not a request, so
  // it cannot be approved or rejected.
  await DataRequest.create({
    user: id,
    requesterRole: user.role === "provider" ? "provider" : "user",
    requestType: "deletion",
    status: "approved",
    requestNote: "",
    adminNote: "Self-service account deletion completed in the app.",
    reviewedAt: new Date(),
    dueAt: new Date(),
  });

  try {
    await recordActivity({
      req,
      action: "account.self_deleted",
      entityType: "User",
      entityId: id,
      metadata: { role: user.role },
    });
  } catch {
    // Logging must never block a deletion that already succeeded.
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account and personal data have been deleted.",
    data: null,
  });
});
