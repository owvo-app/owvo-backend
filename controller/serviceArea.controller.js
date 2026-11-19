import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { ServiceArea } from "../model/serviceArea.model.js";
import { ServiceAreaWaitlist } from "../model/serviceAreaWaitlist.model.js";
import { notifyUser } from "../utils/fcm.util.js";
import { recordActivity } from "../utils/activityLog.util.js";
import {
  normalizePostcode,
  compactPostcode,
  isFullPostcode,
  isDistrict,
  districtOf,
  getServiceAreaState,
  coverageForPostcode,
  providerPostcodeOf,
} from "../utils/serviceArea.util.js";

const kindOf = (postcode) => {
  if (!postcode) return "placeholder";
  return isFullPostcode(postcode) ? "full" : "district";
};

const serializeArea = (a, counts) => ({
  _id: a._id,
  city: a.city,
  areaName: a.areaName,
  postcode: a.postcode || "",
  postcodeDistrict: a.postcodeDistrict || "",
  kind: a.kind,
  isActive: !!a.isActive,
  customerWaitlist: counts?.customer || 0,
  providerWaitlist: counts?.provider || 0,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const waitlistCountsByDistrict = async () => {
  const rows = await ServiceAreaWaitlist.aggregate([
    { $group: { _id: { d: "$postcodeDistrict", r: "$role" }, n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r._id.d) || { customer: 0, provider: 0 };
    cur[r._id.r] = r.n;
    map.set(r._id.d, cur);
  }
  return map;
};

// Notify everyone waiting on a district that it just opened (once each).
const notifyWaitlistForDistrict = async (district, areaLabel) => {
  if (!district) return 0;
  const waiting = await ServiceAreaWaitlist.find({
    postcodeDistrict: district,
    notifiedAt: null,
  }).select("user role");
  let sent = 0;
  for (const w of waiting) {
    const isProvider = w.role === "provider";
    notifyUser(w.user.toString(), {
      title: isProvider
        ? "Bookings are open in your area"
        : "OWVO is now in your area",
      body: isProvider
        ? `Your area ${district} is now active. You can start accepting bookings.`
        : `Good news — bookings are now open in ${district}. Book your wash today.`,
      data: { type: "service_area_opened", district, area: areaLabel || "" },
    });
    w.notifiedAt = new Date();
    await w.save();
    sent += 1;
  }
  return sent;
};

// ── ADMIN ─────────────────────────────────────────────────────────────
export const getAdminServiceAreas = catchAsync(async (req, res) => {
  const areas = await ServiceArea.find()
    .sort({ city: 1, areaName: 1, postcode: 1 })
    .lean();
  const counts = await waitlistCountsByDistrict();
  const state = await getServiceAreaState();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Service areas fetched",
    data: {
      restricted: state.restricted,
      items: areas.map((a) => serializeArea(a, counts.get(a.postcodeDistrict))),
    },
  });
});

export const createAdminServiceArea = catchAsync(async (req, res) => {
  const city = (req.body?.city || "").toString().trim();
  const areaName = (req.body?.areaName || "").toString().trim();
  const postcode = normalizePostcode(req.body?.postcode || "");
  if (!city || !areaName) {
    throw new AppError(httpStatus.BAD_REQUEST, "City and area name are required.");
  }
  if (postcode && !isFullPostcode(postcode) && !isDistrict(postcode)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Enter a valid postcode district (e.g. BR5) or full postcode (e.g. BR5 3DA)."
    );
  }
  if (postcode) {
    const dup = await ServiceArea.findOne({
      postcode: { $regex: `^${postcode.replace(/\s/g, "\\s?")}$`, $options: "i" },
    }).lean();
    const compactDup = await ServiceArea.find().select("postcode").lean();
    const isDup =
      dup ||
      compactDup.some((x) => compactPostcode(x.postcode) === compactPostcode(postcode));
    if (isDup) {
      throw new AppError(
        httpStatus.CONFLICT,
        `${postcode} is already in the service areas list.`
      );
    }
  }
  const area = await ServiceArea.create({
    city,
    areaName,
    postcode,
    postcodeDistrict: districtOf(postcode),
    kind: kindOf(postcode),
    isActive: false,
    createdBy: req.user?._id,
    updatedBy: req.user?._id,
  });
  recordActivity({
    req,
    action: "service_area.created",
    entityType: "ServiceArea",
    entityId: area._id,
    metadata: { city, areaName, postcode },
  });
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Service area added. It starts inactive — switch it on when you are ready to launch.",
    data: serializeArea(area.toObject(), null),
  });
});

export const updateAdminServiceArea = catchAsync(async (req, res) => {
  const area = await ServiceArea.findById(req.params.areaId);
  if (!area) throw new AppError(httpStatus.NOT_FOUND, "Service area not found.");

  const wasActive = !!area.isActive;
  if (typeof req.body?.city === "string" && req.body.city.trim()) {
    area.city = req.body.city.trim();
  }
  if (typeof req.body?.areaName === "string" && req.body.areaName.trim()) {
    area.areaName = req.body.areaName.trim();
  }
  if (typeof req.body?.postcode === "string") {
    const postcode = normalizePostcode(req.body.postcode);
    if (postcode && !isFullPostcode(postcode) && !isDistrict(postcode)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Enter a valid postcode district (e.g. BR5) or full postcode (e.g. BR5 3DA)."
      );
    }
    if (postcode && compactPostcode(postcode) !== compactPostcode(area.postcode)) {
      const all = await ServiceArea.find({ _id: { $ne: area._id } })
        .select("postcode")
        .lean();
      if (all.some((x) => compactPostcode(x.postcode) === compactPostcode(postcode))) {
        throw new AppError(
          httpStatus.CONFLICT,
          `${postcode} is already in the service areas list.`
        );
      }
    }
    area.postcode = postcode;
    area.postcodeDistrict = districtOf(postcode);
    area.kind = kindOf(postcode);
  }
  if (typeof req.body?.isActive === "boolean") {
    area.isActive = req.body.isActive;
  }
  area.updatedBy = req.user?._id;
  await area.save();

  let notified = 0;
  if (!wasActive && area.isActive) {
    notified = await notifyWaitlistForDistrict(
      area.postcodeDistrict,
      `${area.areaName}, ${area.city}`
    );
  }
  recordActivity({
    req,
    action: area.isActive !== wasActive
      ? area.isActive
        ? "service_area.activated"
        : "service_area.paused"
      : "service_area.updated",
    entityType: "ServiceArea",
    entityId: area._id,
    metadata: {
      city: area.city,
      areaName: area.areaName,
      postcode: area.postcode,
      isActive: area.isActive,
      waitlistNotified: notified,
    },
  });
  const counts = await waitlistCountsByDistrict();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: area.isActive !== wasActive
      ? area.isActive
        ? "Area activated. It is now open for bookings in both apps."
        : "Area paused. New bookings there are stopped; existing confirmed bookings are not affected."
      : "Service area updated.",
    data: serializeArea(area.toObject(), counts.get(area.postcodeDistrict)),
  });
});

export const deleteAdminServiceArea = catchAsync(async (req, res) => {
  const area = await ServiceArea.findById(req.params.areaId);
  if (!area) throw new AppError(httpStatus.NOT_FOUND, "Service area not found.");
  await area.deleteOne();
  recordActivity({
    req,
    action: "service_area.deleted",
    entityType: "ServiceArea",
    entityId: area._id,
    metadata: { city: area.city, areaName: area.areaName, postcode: area.postcode },
  });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Service area deleted.",
    data: { _id: area._id },
  });
});

export const checkAdminServiceAreaCoverage = catchAsync(async (req, res) => {
  const postcode = normalizePostcode(req.query.postcode || "");
  if (!isFullPostcode(postcode)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Enter a full postcode to check coverage (e.g. BR6 2AB)."
    );
  }
  const district = districtOf(postcode);
  const areas = await ServiceArea.find().lean();
  const match =
    areas.find((a) => a.kind === "full" && compactPostcode(a.postcode) === compactPostcode(postcode)) ||
    areas.find((a) => a.kind === "district" && districtOf(a.postcode) === district);
  if (!match) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: `${postcode} is not in any service area.`,
      data: { postcode, district, status: "not_listed", area: null },
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: match.isActive
      ? `${postcode} is covered — ${match.postcode} (${match.areaName}, ${match.city}) is Active.`
      : `${postcode} is not open yet — ${match.postcode} (${match.areaName}, ${match.city}) is Inactive.`,
    data: {
      postcode,
      district,
      status: match.isActive ? "active" : "inactive",
      area: {
        _id: match._id,
        city: match.city,
        areaName: match.areaName,
        postcode: match.postcode,
        isActive: !!match.isActive,
      },
    },
  });
});

// ── APP (customer + provider) ─────────────────────────────────────────
export const getServiceAreaCoverage = catchAsync(async (req, res) => {
  const postcode = normalizePostcode(req.query.postcode || "");
  const state = await getServiceAreaState();
  const result = coverageForPostcode(state, postcode);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Coverage checked",
    data: {
      restricted: result.restricted,
      covered: result.covered,
      postcode,
      district: districtOf(postcode),
    },
  });
});

export const joinServiceAreaWaitlist = catchAsync(async (req, res) => {
  const postcode = normalizePostcode(req.body?.postcode || "");
  const district = districtOf(postcode);
  if (!district) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A valid postcode is needed to join the waiting list."
    );
  }
  const state = await getServiceAreaState();
  if (coverageForPostcode(state, postcode).covered) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Good news — OWVO is already open in your area.",
      data: { district, alreadyActive: true },
    });
  }
  const role = req.user?.role === "provider" ? "provider" : "customer";
  await ServiceAreaWaitlist.updateOne(
    { user: req.user._id, postcodeDistrict: district },
    { $setOnInsert: { user: req.user._id, role, postcodeDistrict: district } },
    { upsert: true }
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "You're on the list. We'll let you know when we open in your postcode.",
    data: { district, alreadyActive: false },
  });
});

export const getMyServiceAreaStatus = catchAsync(async (req, res) => {
  const postcode = providerPostcodeOf(req.user);
  const state = await getServiceAreaState();
  const result = coverageForPostcode(state, postcode);
  const onWaitlist = postcode
    ? !!(await ServiceAreaWaitlist.findOne({
        user: req.user._id,
        postcodeDistrict: districtOf(postcode),
      }).lean())
    : false;
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Service area status fetched",
    data: {
      restricted: result.restricted,
      covered: result.covered,
      postcode,
      district: districtOf(postcode),
      onWaitlist,
    },
  });
});
