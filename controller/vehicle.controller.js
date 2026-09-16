import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Vehicle } from "../model/vehicle.model.js";
import catchAsync from "../utils/catch.Async.js";
import { uploadOnCloudinary } from "../utils/common.Method.js";
import sendResponse from "../utils/sendResponse.js";

const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
};

const normalizeRegistrationNo = (value) =>
  value?.toString().trim().toUpperCase().replace(/\s+/g, "");

const getVehicleImageFile = (req) => {
  return (
    req.files?.vehicleImage?.[0] ||
    req.files?.["vehicle image"]?.[0] ||
    req.files?.image?.[0] ||
    req.file ||
    null
  );
};

export const getMyVehicles = catchAsync(async (req, res) => {
  const userId = req.user?._id;

  const vehicles = await Vehicle.find({ user: userId })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Vehicles retrieved successfully",
    data: vehicles,
  });
});

export const getVehicleById = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid vehicle id");
  }

  const vehicle = await Vehicle.findOne({ _id: id, user: userId }).lean();

  if (!vehicle) {
    throw new AppError(httpStatus.NOT_FOUND, "Vehicle not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Vehicle retrieved successfully",
    data: vehicle,
  });
});

export const addVehicle = catchAsync(async (req, res) => {
  const userId = req.user?._id;

  const { registrationNo, make, model, year, size, image, isDefault } = req.body;

  const normalizedRegistrationNo = normalizeRegistrationNo(registrationNo);
  const normalizedMake = make?.trim();
  const normalizedModel = model?.trim();
  const normalizedSize = size?.trim?.() || size;

  if (!normalizedRegistrationNo || !normalizedMake || !normalizedModel || !year || !normalizedSize) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "registrationNo, make, model, year, and size are required"
    );
  }

  const parsedIsDefault = parseBoolean(isDefault);
  const vehicleImageFile = getVehicleImageFile(req);
  let uploadedImageUrl = null;

  if (vehicleImageFile?.path) {
    const uploadedImage = await uploadOnCloudinary(vehicleImageFile.path, "vehicles");
    uploadedImageUrl = uploadedImage?.secure_url || null;
  }

  try {
    const hasExistingVehicle = await Vehicle.exists({ user: userId });
    const shouldMakeDefault =
      parsedIsDefault === true || (parsedIsDefault === undefined && !hasExistingVehicle);

    const vehicle = await Vehicle.create({
      user: userId,
      registrationNo: normalizedRegistrationNo,
      make: normalizedMake,
      model: normalizedModel,
      year: Number(year),
      size: normalizedSize,
      image: uploadedImageUrl || image || null,
      isDefault: shouldMakeDefault,
    });

    if (shouldMakeDefault) {
      await Vehicle.updateMany(
        { user: userId, _id: { $ne: vehicle._id } },
        { $set: { isDefault: false } }
      );
    }

    sendResponse(res, {
      statusCode: httpStatus.CREATED,
      success: true,
      message: "Vehicle added successfully",
      data: vehicle,
    });
  } catch (err) {

    if (err?.code === 11000) {
      throw new AppError(httpStatus.BAD_REQUEST, "Vehicle with this registration number already exists");
    }
    throw err;
  }
});

export const updateVehicle = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid vehicle id");
  }

  const { registrationNo, make, model, year, size, image, isDefault } = req.body;
  const parsedIsDefault = parseBoolean(isDefault);

  const vehicle = await Vehicle.findOne({ _id: id, user: userId });
  if (!vehicle) {
    throw new AppError(httpStatus.NOT_FOUND, "Vehicle not found");
  }

  if (parsedIsDefault === true) {
    await Vehicle.updateMany({ user: userId }, { $set: { isDefault: false } });
    vehicle.isDefault = true;
  } else if (parsedIsDefault === false) {
    vehicle.isDefault = false;
  }

  if (registrationNo?.trim()) vehicle.registrationNo = normalizeRegistrationNo(registrationNo);
  if (make?.trim()) vehicle.make = make.trim();
  if (model?.trim()) vehicle.model = model.trim();
  if (year) vehicle.year = Number(year);
  if (size) vehicle.size = size;
  if (image !== undefined) vehicle.image = image || null;

  try {
    await vehicle.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError(httpStatus.BAD_REQUEST, "Vehicle with this registration number already exists");
    }
    throw err;
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Vehicle updated successfully",
    data: vehicle,
  });
});

export const deleteVehicle = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid vehicle id");
  }

  const vehicle = await Vehicle.findOneAndDelete({ _id: id, user: userId });

  if (!vehicle) {
    throw new AppError(httpStatus.NOT_FOUND, "Vehicle not found");
  }

  if (vehicle.isDefault) {
    const next = await Vehicle.findOne({ user: userId }).sort({ createdAt: -1 });
    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Vehicle removed successfully",
  });
});


export const setDefaultVehicle = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid vehicle id");
  }

  const vehicle = await Vehicle.findOne({ _id: id, user: userId });
  if (!vehicle) throw new AppError(httpStatus.NOT_FOUND, "Vehicle not found");

  await Vehicle.updateMany({ user: userId }, { $set: { isDefault: false } });
  vehicle.isDefault = true;
  await vehicle.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Default vehicle updated",
    data: vehicle,
  });
});
