import axios from "axios";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { Vehicle } from "../model/vehicle.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";

const DVLA_VEHICLE_ENDPOINT =
  "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";

const VEHICLE_SIZES = new Set([
  "Small Car",
  "Medium Car",
  "Large Car",
  "Small Van",
  "Motorbike",
  "Jeep",
]);

const normalizeRegistrationNo = (value) =>
  value?.toString().trim().toUpperCase().replace(/\s+/g, "");

const validateRegistrationNo = (value) => {
  const registrationNo = normalizeRegistrationNo(value);
  if (!registrationNo || !/^[A-Z0-9]{2,8}$/.test(registrationNo)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Enter a valid UK registration number using letters and numbers only."
    );
  }
  return registrationNo;
};

const getDvlaErrorDetail = (error) => {
  const errors = error.response?.data?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors[0]?.detail || errors[0]?.title || null;
};

const requestDvlaVehicle = async (registrationNo) => {
  const apiKey = process.env.DVLA_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Vehicle lookup is not configured. Please add the vehicle manually for now."
    );
  }

  try {
    const response = await axios.post(
      DVLA_VEHICLE_ENDPOINT,
      { registrationNumber: registrationNo },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error) {
    if (error instanceof AppError) throw error;

    const status = error.response?.status;
    const detail = getDvlaErrorDetail(error);

    if (status === 400) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        detail || "Please check the registration number and try again."
      );
    }
    if (status === 404) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        "We could not find a vehicle with that registration number."
      );
    }
    if (status === 429) {
      throw new AppError(
        httpStatus.TOO_MANY_REQUESTS,
        "Vehicle lookup is busy. Please wait a moment and try again."
      );
    }
    if (status === 401 || status === 403) {
      throw new AppError(
        httpStatus.SERVICE_UNAVAILABLE,
        "Vehicle lookup is temporarily unavailable. Please add the vehicle manually."
      );
    }
    if (error.code === "ECONNABORTED") {
      throw new AppError(
        httpStatus.GATEWAY_TIMEOUT,
        "Vehicle lookup took too long. Please try again."
      );
    }

    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Vehicle lookup is temporarily unavailable. Please try again or add the vehicle manually."
    );
  }
};

// DVLA VES does not return the commercial model or a wash-size category.
// Map its official type/weight fields to the closest existing pricing category.
const estimateVehicleSize = ({ typeApproval, revenueWeight }) => {
  const approval = typeApproval?.toString().trim().toUpperCase() || "";
  const weight = Number(revenueWeight);

  if (approval.startsWith("L")) return "Motorbike";
  if (approval.startsWith("N")) return "Small Van";
  if (approval.startsWith("M2") || approval.startsWith("M3")) {
    return "Large Car";
  }
  if (Number.isFinite(weight) && weight > 0) {
    if (weight <= 1200) return "Small Car";
    if (weight >= 2000) return "Large Car";
  }
  return "Medium Car";
};

const getVehicleYear = (vehicle) => {
  const year =
    Number(vehicle.yearOfManufacture) ||
    Number.parseInt(
      vehicle.monthOfFirstRegistration ||
        vehicle.monthOfFirstDvlaRegistration,
      10
    );
  return Number.isFinite(year) ? year : null;
};

const toVehicleData = (vehicle, requestedRegistrationNo) => {
  const year = getVehicleYear(vehicle);
  if (!vehicle.make || !year) {
    throw new AppError(
      httpStatus.UNPROCESSABLE_ENTITY,
      "DVLA did not return enough information for this vehicle. Please add it manually."
    );
  }

  return {
    registrationNo: normalizeRegistrationNo(
      vehicle.registrationNumber || requestedRegistrationNo
    ),
    make: vehicle.make.toString().trim(),
    model: "Not supplied by DVLA",
    year,
    size: estimateVehicleSize(vehicle),
    sizeIsEstimated: true,
    colour: vehicle.colour || null,
    fuelType: vehicle.fuelType || null,
    engineCapacity: vehicle.engineCapacity || null,
    co2Emissions: vehicle.co2Emissions ?? null,
    typeApproval: vehicle.typeApproval || null,
    taxStatus: vehicle.taxStatus || null,
    taxDueDate: vehicle.taxDueDate || null,
    motStatus: vehicle.motStatus || null,
    motExpiryDate: vehicle.motExpiryDate || null,
    source: "dvla",
  };
};

export const lookupVehicleByRegistration = catchAsync(async (req, res) => {
  const registrationNo = validateRegistrationNo(req.body?.registrationNumber);
  const dvlaVehicle = await requestDvlaVehicle(registrationNo);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Vehicle details found",
    data: toVehicleData(dvlaVehicle, registrationNo),
  });
});

export const addDvlaVehicle = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const registrationNo = validateRegistrationNo(req.body?.registrationNumber);

  if (await Vehicle.exists({ user: userId, registrationNo })) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Vehicle with this registration number already exists"
    );
  }

  const dvlaVehicle = await requestDvlaVehicle(registrationNo);
  const vehicleData = toVehicleData(dvlaVehicle, registrationNo);
  const requestedSize = req.body?.size?.toString().trim();
  const size = VEHICLE_SIZES.has(requestedSize)
    ? requestedSize
    : vehicleData.size;
  const hasExistingVehicle = await Vehicle.exists({ user: userId });

  try {
    const vehicle = await Vehicle.create({
      user: userId,
      registrationNo: vehicleData.registrationNo,
      make: vehicleData.make,
      model: vehicleData.model,
      year: vehicleData.year,
      size,
      image: null,
      isDefault: !hasExistingVehicle,
      source: "dvla",
      colour: vehicleData.colour,
      fuelType: vehicleData.fuelType,
      engineCapacity: vehicleData.engineCapacity,
      co2Emissions: vehicleData.co2Emissions,
      typeApproval: vehicleData.typeApproval,
      taxStatus: vehicleData.taxStatus,
      taxDueDate: vehicleData.taxDueDate,
      motStatus: vehicleData.motStatus,
      motExpiryDate: vehicleData.motExpiryDate,
      dvlaVerifiedAt: new Date(),
    });

    sendResponse(res, {
      statusCode: httpStatus.CREATED,
      success: true,
      message: "Vehicle added successfully",
      data: vehicle,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Vehicle with this registration number already exists"
      );
    }
    throw error;
  }
});
