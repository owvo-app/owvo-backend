import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { ActivityLog } from "../model/activityLog.model.js";
import { StaffNote } from "../model/staffNote.model.js";
import { User } from "../model/user.model.js";
import { recordActivity } from "../utils/activityLog.util.js";
import catchAsync from "../utils/catch.Async.js";
import { uploadOnCloudinary } from "../utils/common.Method.js";
import sendResponse from "../utils/sendResponse.js";
import {
  STAFF_ACTIONS,
  STAFF_ACTION_KEYS,
  STAFF_DEPARTMENTS,
  STAFF_MENUS,
  STAFF_MENU_KEYS,
  STAFF_ROLES,
  STAFF_ROLE_PRESETS,
} from "../utils/staffRoles.util.js";

// Staff Management v2 — role-based staff accounts.
// The older handlers in admin.controller only knew name/email/password
// plus a stale menu list (which wrongly allowed "staff-management" to
// be assigned and could not assign Live Tracking at all). These
// handlers add: named role presets, department/location/reporting-to,
// an employment status (active / on leave — separate from the account
// login status), last-login tracking data, search/filters/pagination
// with counts, an admin password reset, staff photo upload, private
// admin notes, and a per-staff activity view. All routes stay
// admin-only (isAdmin) — staff can never manage staff.

const staffSelect =
  "-password -refreshToken -verificationInfo.token -bankDetails.accountNumber -bankDetails.sortCode";

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sanitizePermissions = (input) => {
  const preset =
    input?.staffRole && STAFF_ROLE_PRESETS[input.staffRole]
      ? STAFF_ROLE_PRESETS[input.staffRole]
      : null;
  const menusSource = Array.isArray(input?.menus)
    ? input.menus
    : preset
      ? preset.menus
      : [];
  const actionsSource = Array.isArray(input?.actions)
    ? input.actions
    : preset
      ? preset.actions
      : [];
  return {
    menus: menusSource.filter((m) => STAFF_MENU_KEYS.includes(m)),
    actions: actionsSource.filter((a) => STAFF_ACTION_KEYS.includes(a)),
  };
};

/** GET /admin/staff/meta — menus, actions catalog, roles, departments. */
export const getStaffMeta = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff metadata fetched successfully",
    data: {
      menus: STAFF_MENUS,
      actions: STAFF_ACTIONS,
      roles: STAFF_ROLES,
      presets: STAFF_ROLE_PRESETS,
      departments: STAFF_DEPARTMENTS,
    },
  });
});

/** GET /admin/staff — paged list with search, filters and counts. */
export const getStaffAccountsV2 = catchAsync(async (req, res) => {
  const page = Math.max(
    1,
    Number.parseInt(req.query.page?.toString() || "1", 10) || 1
  );
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.limit?.toString() || "20", 10) || 20)
  );
  const search = req.query.search?.toString().trim() || "";
  const role = req.query.role?.toString().trim() || "";
  const department = req.query.department?.toString().trim() || "";
  const status = req.query.status?.toString().trim() || "";

  const filter = { role: "staff" };
  if (role) filter.staffRole = role;
  if (department) filter.department = department;
  if (status === "active") {
    filter.accountStatus = "active";
    filter.staffStatus = { $ne: "on_leave" };
  } else if (status === "on_leave") {
    filter.staffStatus = "on_leave";
    filter.accountStatus = "active";
  } else if (status === "inactive") {
    filter.accountStatus = "disabled";
  }
  if (search) {
    const rx = new RegExp(escapeRegExp(search), "i");
    filter.$or = [{ name: rx }, { fullName: rx }, { email: rx }];
  }

  const base = { role: "staff" };
  const [total, items, totalAll, activeCount, onLeaveCount, inactiveCount, roleRows, orderRows] =
    await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(staffSelect)
        .populate("reportingTo", "_id name fullName email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(base),
      User.countDocuments({
        ...base,
        accountStatus: "active",
        staffStatus: { $ne: "on_leave" },
      }),
      User.countDocuments({
        ...base,
        accountStatus: "active",
        staffStatus: "on_leave",
      }),
      User.countDocuments({ ...base, accountStatus: "disabled" }),
      User.aggregate([
        { $match: base },
        { $group: { _id: "$staffRole", count: { $sum: 1 } } },
      ]),
      // Join order across ALL staff, so #ST numbers stay stable
      // regardless of filters or pagination.
      User.find(base).select("_id createdAt").sort({ createdAt: 1 }).lean(),
    ]);

  const orderIndex = new Map(orderRows.map((row, i) => [row._id.toString(), i + 1]));
  const roleDistribution = {};
  for (const row of roleRows) {
    roleDistribution[row._id || "custom"] = row.count;
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff accounts fetched successfully",
    data: {
      items: items.map((staff) => ({
        ...staff,
        staffNumber: orderIndex.get(staff._id.toString()) || null,
      })),
      total,
      page,
      limit,
      counts: {
        total: totalAll,
        active: activeCount,
        onLeave: onLeaveCount,
        inactive: inactiveCount,
      },
      roleDistribution,
    },
  });
});

/** POST /admin/staff — create a staff account with a role. */
export const createStaffAccountV2 = catchAsync(async (req, res) => {
  const {
    name = "",
    email,
    password,
    phone,
    staffRole = "custom",
    department = "",
    location = "",
    reportingTo,
    photoUrl,
    staffPermissions = {},
  } = req.body || {};

  if (!email || !password) {
    throw new AppError(httpStatus.BAD_REQUEST, "Email and password are required");
  }
  if (password.toString().length < 6) {
    throw new AppError(httpStatus.BAD_REQUEST, "Password must be at least 6 characters");
  }
  const roleKey = STAFF_ROLES.some((r) => r.key === staffRole) ? staffRole : "custom";

  const normalizedEmail = email.toString().trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    throw new AppError(httpStatus.CONFLICT, "An account with this email already exists");
  }

  const permissions = sanitizePermissions({ ...staffPermissions, staffRole: roleKey });

  const staff = await User.create({
    name: name.toString().trim(),
    email: normalizedEmail,
    password,
    role: "staff",
    accountStatus: "active",
    staffRole: roleKey,
    department: department.toString().trim(),
    staffLocation: location.toString().trim(),
    reportingTo: reportingTo || null,
    staffStatus: "active",
    ...(phone?.toString().trim()
      ? { phoneNumber: phone.toString().trim() }
      : {}),
    ...(photoUrl ? { photo: { url: photoUrl.toString().trim(), public_id: "" } } : {}),
    staffPermissions: permissions,
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
    metadata: { email: staff.email, staffRole: roleKey },
  });

  const data = await User.findById(staff._id)
    .select(staffSelect)
    .populate("reportingTo", "_id name fullName email")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Staff account created successfully",
    data,
  });
});

/** PATCH /admin/staff/:staffId — profile, role, permissions, status. */
export const updateStaffAccountV2 = catchAsync(async (req, res) => {
  const { staffId } = req.params;
  const staff = await User.findOne({ _id: staffId, role: "staff" });
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }

  const {
    name,
    phone,
    staffRole,
    department,
    location,
    reportingTo,
    staffStatus,
    accountStatus,
    photoUrl,
    staffPermissions,
  } = req.body || {};

  if (name !== undefined) staff.name = name.toString().trim();
  if (phone !== undefined) {
    const nextPhone = phone.toString().trim();
    if (nextPhone) staff.phoneNumber = nextPhone;
  }
  if (staffRole !== undefined && STAFF_ROLES.some((r) => r.key === staffRole)) {
    staff.staffRole = staffRole;
  }
  if (department !== undefined) staff.department = department.toString().trim();
  if (location !== undefined) staff.staffLocation = location.toString().trim();
  if (reportingTo !== undefined) staff.reportingTo = reportingTo || null;
  if (staffStatus !== undefined && ["active", "on_leave"].includes(staffStatus)) {
    staff.staffStatus = staffStatus;
  }
  if (accountStatus !== undefined && ["active", "disabled"].includes(accountStatus)) {
    staff.accountStatus = accountStatus;
  }
  if (photoUrl !== undefined && photoUrl) {
    staff.photo = { url: photoUrl.toString().trim(), public_id: staff.photo?.public_id || "" };
  }
  if (staffPermissions !== undefined) {
    staff.staffPermissions = sanitizePermissions({
      ...staffPermissions,
      staffRole: staff.staffRole,
    });
  }

  await staff.save();

  await recordActivity({
    req,
    action: "staff.updated",
    entityType: "user",
    entityId: staff._id,
    metadata: { email: staff.email, staffRole: staff.staffRole },
  });

  const data = await User.findById(staff._id)
    .select(staffSelect)
    .populate("reportingTo", "_id name fullName email")
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff account updated successfully",
    data,
  });
});

/** POST /admin/staff/:staffId/reset-password — admin sets a new password. */
export const resetStaffPassword = catchAsync(async (req, res) => {
  const { staffId } = req.params;
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.toString().length < 6) {
    throw new AppError(httpStatus.BAD_REQUEST, "New password must be at least 6 characters");
  }
  const staff = await User.findOne({ _id: staffId, role: "staff" });
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }
  staff.password = newPassword;
  await staff.save();

  await recordActivity({
    req,
    action: "staff.password_reset",
    entityType: "user",
    entityId: staff._id,
    metadata: { email: staff.email },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff password has been reset",
    data: { _id: staff._id },
  });
});

/** POST /admin/staff/photo — upload a staff profile photo. */
export const uploadStaffPhoto = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "No photo file was received");
  }
  const uploaded = await uploadOnCloudinary(req.file.path, "staff_photos");
  if (!uploaded?.secure_url) {
    throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, "Photo upload failed. Please try again.");
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Photo uploaded successfully",
    data: { url: uploaded.secure_url },
  });
});

/** GET /admin/staff/:staffId/activity — this staff member's audit trail. */
export const getStaffActivity = catchAsync(async (req, res) => {
  const { staffId } = req.params;
  const staff = await User.findOne({ _id: staffId, role: "staff" }).select("_id");
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }
  const logs = await ActivityLog.find({ actor: staffId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff activity fetched successfully",
    data: logs,
  });
});

/** GET /admin/staff/:staffId/notes — private admin notes. */
export const getStaffNotes = catchAsync(async (req, res) => {
  const notes = await StaffNote.find({ staff: req.params.staffId })
    .populate("author", "_id name fullName email")
    .sort({ createdAt: -1 })
    .lean();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Staff notes fetched successfully",
    data: notes,
  });
});

/** POST /admin/staff/:staffId/notes */
export const createStaffNote = catchAsync(async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  if (!text) {
    throw new AppError(httpStatus.BAD_REQUEST, "Note text is required");
  }
  const staff = await User.findOne({ _id: req.params.staffId, role: "staff" }).select("_id");
  if (!staff) {
    throw new AppError(httpStatus.NOT_FOUND, "Staff account not found");
  }
  const note = await StaffNote.create({
    staff: staff._id,
    author: req.user._id,
    text,
  });
  await note.populate("author", "_id name fullName email");
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Note added",
    data: note,
  });
});

/** DELETE /admin/staff/:staffId/notes/:noteId */
export const deleteStaffNote = catchAsync(async (req, res) => {
  const note = await StaffNote.findOneAndDelete({
    _id: req.params.noteId,
    staff: req.params.staffId,
  });
  if (!note) {
    throw new AppError(httpStatus.NOT_FOUND, "Note not found");
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Note deleted",
    data: { _id: note._id },
  });
});
