import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { Addon } from "../model/addon.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { recordActivity } from "../utils/activityLog.util.js";

const asMoney = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

const normalizeName = (value) => value?.toString().trim();

const findAddonOrThrow = async (addonId) => {
  const addon = await Addon.findById(addonId);
  if (!addon) {
    throw new AppError(httpStatus.NOT_FOUND, "Add-on not found");
  }
  return addon;
};

const assertUniqueName = async (name, ignoreId = null) => {
  const existing = await Addon.findOne({ name });
  if (existing && existing._id.toString() !== ignoreId?.toString()) {
    throw new AppError(
      httpStatus.CONFLICT,
      "An add-on with this name already exists"
    );
  }
};

// Public — used by the Flutter app to show bookable add-ons.
export const getActiveAddons = catchAsync(async (req, res) => {
  const addons = await Addon.find({ isActive: true }).sort({ price: 1 });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Add-ons fetched successfully",
    data: addons,
  });
});

// Admin — full list including inactive, for management.
export const getAdminAddons = catchAsync(async (req, res) => {
  const addons = await Addon.find().sort({ price: 1 });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Add-ons fetched successfully",
    data: addons,
  });
});

export const createAdminAddon = catchAsync(async (req, res) => {
  const name = normalizeName(req.body?.name);
  const price = asMoney(req.body?.price);
  const description = normalizeName(req.body?.description) || undefined;
  const isActive = req.body?.isActive === undefined ? true : Boolean(req.body.isActive);

  if (!name) {
    throw new AppError(httpStatus.BAD_REQUEST, "Add-on name is required");
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Add-on price must be greater than 0"
    );
  }

  await assertUniqueName(name);

  const addon = await Addon.create({ name, price, description, isActive });

  await recordActivity({
    req,
    action: "addon.created",
    entityType: "addon",
    entityId: addon._id,
    metadata: { name: addon.name, price: addon.price },
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Add-on created successfully",
    data: addon,
  });
});

export const updateAdminAddon = catchAsync(async (req, res) => {
  const { addonId } = req.params;
  const addon = await findAddonOrThrow(addonId);

  if (req.body?.name !== undefined) {
    const name = normalizeName(req.body.name);
    if (!name) {
      throw new AppError(httpStatus.BAD_REQUEST, "Add-on name is required");
    }
    await assertUniqueName(name, addon._id);
    addon.name = name;
  }

  if (req.body?.price !== undefined) {
    const price = asMoney(req.body.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Add-on price must be greater than 0"
      );
    }
    addon.price = price;
  }

  if (req.body?.description !== undefined) {
    addon.description = normalizeName(req.body.description) || undefined;
  }

  if (req.body?.isActive !== undefined) {
    addon.isActive = Boolean(req.body.isActive);
  }

  await addon.save();

  await recordActivity({
    req,
    action: "addon.updated",
    entityType: "addon",
    entityId: addon._id,
    metadata: { name: addon.name, price: addon.price },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Add-on updated successfully",
    data: addon,
  });
});

export const deleteAdminAddon = catchAsync(async (req, res) => {
  const { addonId } = req.params;
  const addon = await findAddonOrThrow(addonId);

  await Addon.deleteOne({ _id: addon._id });

  await recordActivity({
    req,
    action: "addon.deleted",
    entityType: "addon",
    entityId: addon._id,
    metadata: { name: addon.name },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Add-on deleted successfully",
    data: null,
  });
});
