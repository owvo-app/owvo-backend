import fs from "fs";
import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Booking } from "../model/booking.model.js";
import { Rating } from "../model/rating.model.js";
import { User } from "../model/user.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import { syncProviderCompletedJobs } from "../utils/completedJobs.util.js";
import { uploadOnCloudinary } from "../utils/common.Method.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";

const getPlatformSettingsDoc = async () =>
  PlatformSetting.findOneAndUpdate(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

/**
 * UK sort code ke pehle 2 digits se major high-street bank pehchanne ke
 * liye. Koi live bank API nahi — sirf publicly-known sort code ranges.
 * Kisi kam-jaani bank ka code na mile to "UK Bank Account" dikha dete hain
 * (koi ghalat naam nahi dikhate).
 */
const UK_SORT_CODE_BANK_PREFIXES = {
  "04": "HSBC",
  "08": "Co-operative Bank",
  "09": "Santander",
  "16": "Clydesdale Bank",
  "20": "Barclays",
  "23": "Metro Bank",
  "30": "Lloyds Bank",
  "40": "HSBC",
  "60": "NatWest",
  "77": "Bank of Scotland",
  "80": "TSB",
  "83": "Nationwide",
  "87": "Halifax",
};

const identifyBankFromSortCode = (sortCode) => {
  const digits = String(sortCode || "").replace(/\D/g, "");
  if (digits.length !== 6) return "";
  return UK_SORT_CODE_BANK_PREFIXES[digits.slice(0, 2)] || "UK Bank Account";
};

/** "12345678" -> "\u2022\u2022\u2022\u2022 5678" */
const maskAccountNumber = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}`;
};

/** "123456" -> "\u2022\u2022-\u2022\u2022-56" */
const maskSortCode = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 6) return "";
  return `\u2022\u2022-\u2022\u2022-${digits.slice(4)}`;
};

/**
 * Provider ki apni app ko bankDetails bhejte waqt hamesha isay use karo —
 * asal account number/sort code kabhi wapas nahi jaana chahiye, sirf
 * masked version aur bank ka naam.
 */
const maskBankDetailsForResponse = (bankDetails) => {
  if (!bankDetails) return bankDetails;
  const plain =
    typeof bankDetails.toObject === "function"
      ? bankDetails.toObject()
      : bankDetails;
  return {
    accountHolderName: plain.accountHolderName || "",
    address: plain.address || "",
    city: plain.city || "",
    postcode: plain.postcode || "",
    dateOfBirth: plain.dateOfBirth || null,
    bankName: plain.bankName || "",
    accountNumberMasked: maskAccountNumber(plain.accountNumber),
    sortCodeMasked: maskSortCode(plain.sortCode),
  };
};

const resolveProviderDailyWashLimitMax = (user, settings) => {
  const providerMax = Number(user?.dailyWashLimitMax);
  if (Number.isInteger(providerMax) && providerMax > 0) return providerMax;

  const platformMax = Number(settings?.dailyWashLimitMax);
  return Number.isInteger(platformMax) && platformMax > 0 ? platformMax : 7;
};

const buildProfilePayload = async (user) => {
  if (user.role !== "provider") return user;

  const [settings, completedJobs] = await Promise.all([
    getPlatformSettingsDoc(),
    syncProviderCompletedJobs(user._id),
  ]);

  return {
    ...user.toObject(),
    bankDetails: maskBankDetailsForResponse(user.bankDetails),
    dailyWashLimitMax: resolveProviderDailyWashLimitMax(user, settings),
    completedJobs,
  };
};


export const getProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "-password -refreshToken -verificationInfo.token -password_reset_token"
  );

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (
    user.role === "provider" &&
    user.isOnline &&
    (user.adminVerification?.status !== "approved" ||
      ["suspended", "banned"].includes(user.enforcement?.status))
  ) {
    user.isOnline = false;
    user.isBusy = false;
    await user.save();
  }

  const data = await buildProfilePayload(user);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile fetched successfully",
    data,
  });
});


const calculateAge = (date) => {
  const today = new Date();
  const dob = new Date(date);

  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < dob.getDate())
  ) {
    age--;
  }

  return age;
};

const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
};

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = value.toString().trim();
  return normalized ? normalized : undefined;
};

const isCloudinaryConfigured = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

const localUploadReference = (file) => ({
  public_id: file.filename || "",
  url: file.path ? `/${file.path.replace(/\\/g, "/")}` : "",
});

const requiresDurableUploadStorage = () =>
  process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

const uploadUserFile = async (file, folder) => {
  if (!file?.path) {
    throw new AppError(httpStatus.BAD_REQUEST, "No file uploaded");
  }

  if (!isCloudinaryConfigured()) {
    if (requiresDurableUploadStorage()) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        "Secure document storage is not configured. Please contact OWVO support."
      );
    }
    return localUploadReference(file);
  }

  let uploadResult;
  try {
    uploadResult = await uploadOnCloudinary(file.path, folder, {
      deleteOnError: false,
    });
  } catch (error) {
    if (requiresDurableUploadStorage()) {
      throw new AppError(
        httpStatus.BAD_GATEWAY,
        "Secure document storage is temporarily unavailable. Please try again later."
      );
    }
    console.error(
      `Cloudinary upload failed for ${file.fieldname || "file"}; using local development upload reference.`,
      error?.message || error
    );
    return localUploadReference(file);
  }

  const url = uploadResult?.secure_url || uploadResult?.url;
  if (!url) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Uploaded file did not return a usable URL"
    );
  }

  return {
    public_id: uploadResult.public_id || uploadResult.asset_id || file.filename || "",
    url,
  };
};

const uploadProviderDocumentFile = async (file, folder) => ({
  document: await uploadUserFile(file, folder),
  uploadedAt: new Date(),
});

const ensureProfileSubdocuments = (user) => {
  if (!user.identityVerification) user.identityVerification = {};
  if (!user.drivewayEligibility) user.drivewayEligibility = {};
  if (!user.bankDetails) user.bankDetails = {};
  if (!user.providerAddress) user.providerAddress = {};
};

const normalizeUploadFieldName = (fieldName = "") =>
  fieldName.toString().toLowerCase().replace(/[^a-z0-9]/g, "");

const fileGroupsFromUpload = (files) => {
  if (!files) return {};
  if (!Array.isArray(files)) return files;

  return files.reduce((groupedFiles, file) => {
    if (!groupedFiles[file.fieldname]) groupedFiles[file.fieldname] = [];
    groupedFiles[file.fieldname].push(file);
    return groupedFiles;
  }, {});
};

const firstUploadedFile = (files, fieldNames, fieldMatcher) => {
  const groupedFiles = fileGroupsFromUpload(files);
  for (const fieldName of fieldNames) {
    const file = groupedFiles?.[fieldName]?.[0];
    if (file) return file;
  }

  for (const [fieldName, fileList] of Object.entries(groupedFiles)) {
    if (fieldMatcher?.(normalizeUploadFieldName(fieldName))) {
      return fileList?.[0] || null;
    }
  }

  return null;
};

const providerInsuranceUploadFields = [
  "publicLiabilityInsurance",
  "publicLiabilityInsuranceFile",
  "publicLiabilityInsuranceDocument",
  "liabilityInsurance",
  "insuranceDocument",
  "insurance",
];

const drivewayPhotoUploadFields = [
  "drivewayPhoto",
  "drivewayPhotoFile",
  "drivewayPicture",
  "drivewayImage",
];

const entrancePhotoUploadFields = [
  "entrancePhoto",
  "entrancePhotoFile",
  "entranceImage",
  "entrancePicture",
];

const isProviderInsuranceUploadField = (fieldName) =>
  fieldName.includes("insurance") || fieldName.includes("liability");

const isDrivewayPhotoUploadField = (fieldName) =>
  fieldName.includes("driveway") ||
  fieldName.includes("parkingphoto") ||
  fieldName.includes("parkingimage");

const isEntrancePhotoUploadField = (fieldName) =>
  fieldName.includes("entrance");

export const updateProfile = catchAsync(async (req, res) => {
  const {
    name,
    email,
    phoneNumber,
    language,
    dateOfBirth,
    residentialAddress,
    rightToWorkUK,
    serviceArea,
    providerStreetAddress,
    providerCity,
    providerCountry,
    providerPostcode,
    // Service Location / Driveway — home address se alag, isi se customer
    // search ki GPS coordinates banti hain.
    serviceStreetAddress,
    serviceCity,
    servicePostcode,
    sameAsHomeAddress,
    nationalInsuranceNumber,

    documentType,
    documentNumber,

    isPrivateProperty,
    hasPermission,
    noRoadPayment,
    oneCarSpaceOnly,
    notSharedOrCommunal,
    isSafeWorkingArea,
    isResidentialAreaSuitable,

    accountHolderName,
    bankAddress,
    city,
    postcode,
    bankDateOfBirth,
    accountNumber,
    sortCode,
  } = req.body;

  const user = await User.findById(req.user._id);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }
  ensureProfileSubdocuments(user);

  // ---------------------------
  // Unique checks
  // ---------------------------
  const normalizedEmail = normalizeOptionalString(email)?.toLowerCase();
  if (email !== undefined && normalizedEmail && normalizedEmail !== user.email) {
    const existingEmailUser = await User.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
    if (existingEmailUser) throw new AppError(httpStatus.BAD_REQUEST, "Email already in use");
    user.email = normalizedEmail;
  }

  const normalizedPhoneNumber = normalizeOptionalString(phoneNumber);
  if (phoneNumber !== undefined && normalizedPhoneNumber !== user.phoneNumber) {
    if (normalizedPhoneNumber) {
      const existingPhoneUser = await User.findOne({ phoneNumber: normalizedPhoneNumber, _id: { $ne: user._id } });
      if (existingPhoneUser) throw new AppError(httpStatus.BAD_REQUEST, "Phone number already in use");
    }
    user.phoneNumber = normalizedPhoneNumber;
  }

  // ---------------------------
  // Basic profile fields
  // ---------------------------
  if (name !== undefined) user.name = name;
  if (language !== undefined) user.language = language;
  if (residentialAddress !== undefined) user.residentialAddress = residentialAddress;
  if (serviceArea !== undefined) user.serviceArea = serviceArea;
  const hasProviderAddressUpdate =
    providerStreetAddress !== undefined ||
    providerCity !== undefined ||
    providerCountry !== undefined ||
    providerPostcode !== undefined;

  if (hasProviderAddressUpdate) {
    if (!user.providerAddress) user.providerAddress = {};
    if (providerStreetAddress !== undefined) {
      user.providerAddress.streetAddress = providerStreetAddress;
    }
    if (providerCity !== undefined) user.providerAddress.city = providerCity;
    if (providerCountry !== undefined) user.providerAddress.country = providerCountry;
    if (providerPostcode !== undefined) user.providerAddress.postcode = providerPostcode;

    const providerAddressLine = [
      user.providerAddress.streetAddress,
      user.providerAddress.city,
      user.providerAddress.country,
      user.providerAddress.postcode,
    ]
      .filter(Boolean)
      .join(", ");

    // residentialAddress = provider ka apna ghar (display ke liye). Ye ab
    // "location"/customer search ko kabhi affect nahi karti — sirf
    // serviceLocationAddress karti hai (neeche).
    if (providerAddressLine && residentialAddress === undefined) {
      user.residentialAddress = providerAddressLine;
    }
  }

  // ---------------------------
  // Service Location / Driveway — YE address customer search (GPS) chalati
  // hai, home address nahi. "Same as home address" ho to home ka postcode
  // hi copy kar lete hain.
  // ---------------------------
  const hasServiceLocationUpdate =
    serviceStreetAddress !== undefined ||
    serviceCity !== undefined ||
    servicePostcode !== undefined ||
    sameAsHomeAddress !== undefined;

  if (hasServiceLocationUpdate) {
    if (!user.serviceLocationAddress) user.serviceLocationAddress = {};

    const useHomeAddress = parseBoolean(sameAsHomeAddress) === true;
    user.serviceLocationAddress.sameAsHomeAddress = useHomeAddress;

    if (useHomeAddress) {
      user.serviceLocationAddress.streetAddress =
        user.providerAddress?.streetAddress || "";
      user.serviceLocationAddress.city = user.providerAddress?.city || "";
      user.serviceLocationAddress.postcode =
        user.providerAddress?.postcode || "";
    } else {
      if (serviceStreetAddress !== undefined) {
        user.serviceLocationAddress.streetAddress = serviceStreetAddress;
      }
      if (serviceCity !== undefined) {
        user.serviceLocationAddress.city = serviceCity;
      }
      if (servicePostcode !== undefined) {
        user.serviceLocationAddress.postcode = servicePostcode;
      }
    }

    const serviceAddressLine = [
      user.serviceLocationAddress.streetAddress,
      user.serviceLocationAddress.city,
      user.serviceLocationAddress.postcode,
    ]
      .filter(Boolean)
      .join(", ");

    if (serviceAddressLine) {
      user.serviceArea = serviceAddressLine;
    }

    // Postcode se GPS coordinates nikal kar location field mein save kar
    // dete hain — is se pehle sirf "Go Online" hone par (live GPS se)
    // location set hoti thi, matlab naye providers jab tak online na
    // jaayein customer ko nazar hi nahi aate thay. Ab address submit
    // karte hi search-eligible ho jaate hain. postcodes.io free hai,
    // koi API key nahi chahiye.
    const postcodeToGeocode = user.serviceLocationAddress.postcode;
    if (postcodeToGeocode) {
      try {
        const cleaned = String(postcodeToGeocode).trim().replace(/\s+/g, "");
        const geoResponse = await fetch(
          `https://api.postcodes.io/postcodes/${encodeURIComponent(cleaned)}`
        );
        if (geoResponse.ok) {
          const geoPayload = await geoResponse.json();
          const result = geoPayload?.result;
          if (result?.latitude && result?.longitude) {
            user.location = {
              type: "Point",
              coordinates: [result.longitude, result.latitude],
            };
          }
        }
      } catch (err) {
        // Geocoding fail ho to bhi address save hona chahiye — provider
        // baad mein "Go Online" karega to live GPS se location aa jayegi.
        console.error("Postcode geocoding failed:", err);
      }
    }
  }
  if (nationalInsuranceNumber !== undefined) user.nationalInsuranceNumber = nationalInsuranceNumber;

  const parsedRightToWorkUK = parseBoolean(rightToWorkUK);
  if (parsedRightToWorkUK !== undefined) {
    user.rightToWorkUK = parsedRightToWorkUK;
    if (parsedRightToWorkUK && !user.rightToWorkConfirmedAt) {
      user.rightToWorkConfirmedAt = new Date();
    }
    if (!parsedRightToWorkUK) {
      user.rightToWorkConfirmedAt = null;
    }
  }

  if (dateOfBirth) {
    const age = calculateAge(dateOfBirth);
    if (age < 18) throw new AppError(httpStatus.BAD_REQUEST, "User must be 18 years or older");
    user.dateOfBirth = new Date(dateOfBirth);
  }

  // ---------------------------
  // Identity verification
  // ---------------------------
  if (documentType !== undefined) user.identityVerification.documentType = documentType;
  if (documentNumber !== undefined) {
    user.identityVerification.documentNumber = documentNumber;
    if (!user.identityVerification.documentType) {
      user.identityVerification.documentType = "driving_license";
    }
  }

  // ---------------------------
  // Driveway eligibility
  // ---------------------------
  if (isPrivateProperty !== undefined) user.drivewayEligibility.isPrivateProperty = parseBoolean(isPrivateProperty);
  if (hasPermission !== undefined) user.drivewayEligibility.hasPermission = parseBoolean(hasPermission);
  if (noRoadPayment !== undefined) user.drivewayEligibility.noRoadPayment = parseBoolean(noRoadPayment);
  if (oneCarSpaceOnly !== undefined) user.drivewayEligibility.oneCarSpaceOnly = parseBoolean(oneCarSpaceOnly);
  if (notSharedOrCommunal !== undefined) user.drivewayEligibility.notSharedOrCommunal = parseBoolean(notSharedOrCommunal);
  if (isSafeWorkingArea !== undefined) user.drivewayEligibility.isSafeWorkingArea = parseBoolean(isSafeWorkingArea);
  if (isResidentialAreaSuitable !== undefined) user.drivewayEligibility.isResidentialAreaSuitable = parseBoolean(isResidentialAreaSuitable);

  // ---------------------------
  // Bank details
  // ---------------------------
  if (accountHolderName !== undefined) user.bankDetails.accountHolderName = accountHolderName;
  if (bankAddress !== undefined) user.bankDetails.address = bankAddress;
  if (city !== undefined) user.bankDetails.city = city;
  if (postcode !== undefined) user.bankDetails.postcode = postcode;
  if (bankDateOfBirth) {
    const bankAge = calculateAge(bankDateOfBirth);
    if (bankAge < 18) throw new AppError(httpStatus.BAD_REQUEST, "Bank date of birth must be 18 years or older");
    user.bankDetails.dateOfBirth = new Date(bankDateOfBirth);
  }
  if (accountNumber !== undefined) user.bankDetails.accountNumber = accountNumber;
  if (sortCode !== undefined) user.bankDetails.sortCode = sortCode;

  // ---------------------------
  // File uploads
  // ---------------------------
  if (req.files?.photo?.[0]) {
    user.photo = await uploadUserFile(req.files.photo[0], "users");
  }

  if (req.files?.idFile?.[0]) {
    user.identityVerification.idFile = await uploadUserFile(
      req.files.idFile[0],
      "users/identity"
    );
  }

  if (req.files?.passportOrDrivingLicenseFile?.[0]) {
    user.identityVerification.passportOrDrivingLicenseFile = await uploadUserFile(
      req.files.passportOrDrivingLicenseFile[0],
      "users/identity"
    );
  }

  const publicLiabilityInsuranceFile = firstUploadedFile(
    req.files,
    providerInsuranceUploadFields,
    isProviderInsuranceUploadField
  );
  if (publicLiabilityInsuranceFile) {
    const uploadedPublicLiabilityInsurance = await uploadProviderDocumentFile(
      publicLiabilityInsuranceFile,
      "users/insurance"
    );
    user.publicLiabilityInsurance = uploadedPublicLiabilityInsurance;
    user.insurance = uploadedPublicLiabilityInsurance;
  }

  const drivewayPhotoFile = firstUploadedFile(
    req.files,
    drivewayPhotoUploadFields,
    isDrivewayPhotoUploadField
  );
  if (drivewayPhotoFile) {
    user.drivewayPhoto = await uploadProviderDocumentFile(
      drivewayPhotoFile,
      "users/driveway"
    );
  }

  // Optional — client ke mutabiq "if required" hi maangi jati hai, koi
  // completion check isay zaroori nahi banata.
  const entrancePhotoFile = firstUploadedFile(
    req.files,
    entrancePhotoUploadFields,
    isEntrancePhotoUploadField
  );
  if (entrancePhotoFile) {
    user.entrancePhoto = await uploadProviderDocumentFile(
      entrancePhotoFile,
      "users/entrance"
    );
  }
  // ---------------------------
  // Completion checks
  // ---------------------------
  const providerAddressLine = [
    user.providerAddress?.streetAddress,
    user.providerAddress?.city,
    user.providerAddress?.country,
    user.providerAddress?.postcode,
  ]
    .filter(Boolean)
    .join(", ");
  const isPersonalCompleted = Boolean(
    user.name &&
    user.email &&
    user.phoneNumber &&
    user.dateOfBirth &&
    (user.residentialAddress || providerAddressLine)
  );
  user.isProfileCompleted = isPersonalCompleted;

  const d = user.drivewayEligibility;
  const hasPublicLiabilityInsurance = Boolean(
    user.publicLiabilityInsurance?.document?.url || user.insurance?.document?.url
  );
  const hasDrivewayPhoto = Boolean(user.drivewayPhoto?.document?.url);
  const isIdentityCompleted = Boolean(
    user.identityVerification.documentType &&
    user.identityVerification.documentNumber &&
    user.identityVerification.passportOrDrivingLicenseFile?.url &&
    hasPublicLiabilityInsurance &&
    hasDrivewayPhoto &&
    d.isPrivateProperty &&
    d.hasPermission &&
    d.noRoadPayment &&
    d.oneCarSpaceOnly &&
    d.notSharedOrCommunal
  );
  user.isIdentityCompleted = isIdentityCompleted;
  if (isIdentityCompleted && !user.identityVerification.submittedAt) {
    user.identityVerification.submittedAt = new Date();
  }

  const isBankCompleted = Boolean(
    user.bankDetails.accountHolderName &&
    user.bankDetails.address &&
    user.bankDetails.city &&
    user.bankDetails.postcode &&
    user.bankDetails.dateOfBirth &&
    user.bankDetails.accountNumber &&
    user.bankDetails.sortCode
  );
  user.isBankCompleted = isBankCompleted;

  const hasProviderVerificationDocuments = Boolean(
    user.role === "provider" &&
      user.isProfileCompleted &&
      user.isBankCompleted &&
      user.photo?.url &&
      user.identityVerification?.documentType &&
      user.identityVerification?.documentNumber &&
      user.identityVerification?.passportOrDrivingLicenseFile?.url &&
      hasPublicLiabilityInsurance &&
      hasDrivewayPhoto
  );

  if (
    hasProviderVerificationDocuments &&
    !["approved", "rejected"].includes(user.adminVerification?.status)
  ) {
    user.adminVerification = {
      ...(user.adminVerification?.toObject?.() || user.adminVerification || {}),
      status: "pending",
      reviewedBy: null,
      reviewedAt: undefined,
      rejectionReason: "",
    };
    user.identityVerification.status = "pending";
    user.identityVerification.submittedAt =
      user.identityVerification.submittedAt || new Date();
    user.isOnline = false;
    user.isBusy = false;
  }

  // ---------------------------
  // Save user and respond
  // ---------------------------
  await user.save();
  const data = await buildProfilePayload(user);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile updated successfully",
    data,
  });
});

export const uploadPhoto = catchAsync(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "No file uploaded");
  }

  const user = await User.findById(req.user._id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (user.photo && fs.existsSync(user.photo)) fs.unlinkSync(user.photo);
  user.photo = req.files[0].path;

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Photo uploaded successfully",
    data: user,
  });
});

export const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "All password fields are required"
    );
  }

  if (newPassword !== confirmPassword) {
    throw new AppError(httpStatus.BAD_REQUEST, "Passwords do not match");
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  const isMatch = await User.isPasswordMatched(
    currentPassword,
    user.password
  );

  if (!isMatch) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Current password is incorrect"
    );
  }

  user.password = newPassword;
  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password changed successfully",
  });
});

export const updateIdentityInfo = catchAsync(async (req, res) => {
  const {
    documentType, // "passport" | "driving_license"
    drivewayEligibility, // object of booleans
  } = req.body;
  const drivewayEligibility1 = JSON.parse(drivewayEligibility || "{}");

  const user = await User.findById(req.user._id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  // ✅ documentType update
  if (documentType) {
    const allowed = ["passport", "driving_license"];
    if (!allowed.includes(documentType)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "documentType must be passport or driving_license"
      );
    }
    user.identityVerification = user.identityVerification || {};
    user.identityVerification.documentType = documentType;
  }

  // ✅ driveway eligibility update
  if (drivewayEligibility && typeof drivewayEligibility === "object") {
    user.drivewayEligibility = user.drivewayEligibility || {};

    const keys = [
      "isPrivateProperty",
      "hasPermission",
      "noRoadPayment",
      "oneCarSpaceOnly",
      "notSharedOrCommunal",
    ];

    keys.forEach((k) => {
      if (drivewayEligibility1[k] !== undefined) {
        user.drivewayEligibility[k] = Boolean(drivewayEligibility1[k]);
      }
    });
  }

  const allDrivewayChecks =
    user.drivewayEligibility?.isPrivateProperty &&
    user.drivewayEligibility?.hasPermission &&
    user.drivewayEligibility?.noRoadPayment &&
    user.drivewayEligibility?.oneCarSpaceOnly &&
    user.drivewayEligibility?.notSharedOrCommunal;

  if (
    user.identityVerification?.documentType &&
    user.identityVerification?.idFile &&
    allDrivewayChecks
  ) {
    user.isIdentityCompleted = true;
    user.identityVerification.status = "pending";
    user.identityVerification.submittedAt = new Date();
  } else {
    user.isIdentityCompleted = false;
  }
    user.identityVerification = user.identityVerification || {};

  // ✅ delete old id file if exists
  if (user.identityVerification.idFile && fs.existsSync(user.identityVerification.idFile)) {
    fs.unlinkSync(user.identityVerification.idFile);
  }

  user.identityVerification.idFile = req.file.path;

  // if they upload file, keep status pending
  if (!user.identityVerification.status) user.identityVerification.status = "pending";
  user.idNumber = idNumber || user.idNumber;

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Identity information updated successfully",
    data: user,
  });
});

export const uploadIdentityIdFile = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "No file uploaded");
  }

  const user = await User.findById(req.user._id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  user.identityVerification = user.identityVerification || {};

  if (user.identityVerification.idFile && fs.existsSync(user.identityVerification.idFile)) {
    fs.unlinkSync(user.identityVerification.idFile);
  }

  user.identityVerification.idFile = req.file.path;

  if (!user.identityVerification.status) user.identityVerification.status = "pending";

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "ID uploaded successfully",
    data: user,
  });
});

export const getBankDetails = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "bankDetails isBankCompleted"
  );

  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Bank details fetched successfully",
    data: {
      bankDetails: maskBankDetailsForResponse(user.bankDetails),
      isBankCompleted: user.isBankCompleted,
    },
  });
});

export const updateBankDetails = catchAsync(async (req, res) => {
  const {
    accountHolderName,
    address,
    city,
    postcode,
    dateOfBirth,
    accountNumber,
    sortCode,
  } = req.body;

  const user = await User.findById(req.user._id);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  user.bankDetails = user.bankDetails || {};

  if (accountHolderName !== undefined)
    user.bankDetails.accountHolderName = accountHolderName;

  // Address/DOB har baar dobara nahi maangte — agar provider ne pehle hi
  // apni personal details mein bhar diye hain, wahi reuse kar lete hain.
  if (address !== undefined) {
    user.bankDetails.address = address;
  } else if (!user.bankDetails.address && user.providerAddress?.streetAddress) {
    user.bankDetails.address = user.providerAddress.streetAddress;
  }

  if (city !== undefined) {
    user.bankDetails.city = city;
  } else if (!user.bankDetails.city && user.providerAddress?.city) {
    user.bankDetails.city = user.providerAddress.city;
  }

  if (postcode !== undefined) {
    user.bankDetails.postcode = postcode;
  } else if (!user.bankDetails.postcode && user.providerAddress?.postcode) {
    user.bankDetails.postcode = user.providerAddress.postcode;
  }

  if (dateOfBirth) {
    const dob = new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid dateOfBirth");
    }
    user.bankDetails.dateOfBirth = dob;
  } else if (!user.bankDetails.dateOfBirth && user.dateOfBirth) {
    user.bankDetails.dateOfBirth = user.dateOfBirth;
  }

  if (accountNumber !== undefined) {
    const digits = String(accountNumber).replace(/\D/g, "");
    if (digits.length !== 8) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Enter a valid 8-digit account number"
      );
    }
    user.bankDetails.accountNumber = digits;
  }

  if (sortCode !== undefined) {
    const digits = String(sortCode).replace(/\D/g, "");
    if (digits.length !== 6) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Enter a valid 6-digit sort code"
      );
    }
    user.bankDetails.sortCode = digits;
    user.bankDetails.bankName = identifyBankFromSortCode(digits);
  }

  const bd = user.bankDetails;
  const completed =
    bd.accountHolderName &&
    bd.address &&
    bd.city &&
    bd.postcode &&
    bd.dateOfBirth &&
    bd.accountNumber &&
    bd.sortCode;

  user.isBankCompleted = Boolean(completed);

  const hasPublicLiabilityInsurance = Boolean(
    user.publicLiabilityInsurance?.document?.url || user.insurance?.document?.url
  );
  const hasDrivewayPhoto = Boolean(user.drivewayPhoto?.document?.url);

  const hasProviderVerificationDocuments = Boolean(
    user.role === "provider" &&
      user.isProfileCompleted &&
      user.isBankCompleted &&
      user.photo?.url &&
      user.identityVerification?.documentType &&
      user.identityVerification?.documentNumber &&
      user.identityVerification?.passportOrDrivingLicenseFile?.url &&
      hasPublicLiabilityInsurance &&
      hasDrivewayPhoto
  );

  if (
    hasProviderVerificationDocuments &&
    !["approved", "rejected"].includes(user.adminVerification?.status)
  ) {
    user.adminVerification = {
      ...(user.adminVerification?.toObject?.() || user.adminVerification || {}),
      status: "pending",
      reviewedBy: null,
      reviewedAt: undefined,
      rejectionReason: "",
    };
    user.identityVerification.status = "pending";
    user.identityVerification.submittedAt =
      user.identityVerification.submittedAt || new Date();
    user.isOnline = false;
    user.isBusy = false;
  }

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Bank details updated successfully",
    data: {
      bankDetails: maskBankDetailsForResponse(user.bankDetails),
      isBankCompleted: user.isBankCompleted,
    },
  });
});

export const getUserActivity = catchAsync(async (req, res) => {
  const userId = req.user._id;

  const bookings = await Booking.find({ user: userId })
    .populate(
      "provider",
      "_id name email role photo phoneNumber location providerAddress residentialAddress serviceArea"
    )
    .populate("service", "_id title price serviceType carSize carName carModel")
    .populate("vehicle", "registrationNo make model year size image isDefault")
    .sort({ createdAt: -1 })
    .lean();

  const bookingIds = bookings.map((booking) => booking._id);
  const providerIds = [
    ...new Set(
      bookings
        .map((booking) => booking.provider?._id?.toString())
        .filter(Boolean)
    ),
  ];

  const [bookingRatings, providerRatingStats] = await Promise.all([
    Rating.find({ booking: { $in: bookingIds }, user: userId })
      .select("booking rating review createdAt")
      .lean(),
    Rating.aggregate([
      {
        $match: {
          provider: {
            $in: providerIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
      },
      {
        $group: {
          _id: "$provider",
          averageRating: { $avg: "$rating" },
          totalRatings: { $sum: 1 },
        },
      },
    ]),
  ]);

  const ratingsByBookingId = new Map(
    bookingRatings.map((rating) => [
      rating.booking.toString(),
      {
        rating: rating.rating,
        review: rating.review || "",
        createdAt: rating.createdAt,
      },
    ])
  );

  const ratingsByProviderId = new Map(
    providerRatingStats.map((stat) => [
      stat._id.toString(),
      {
        averageRating: Number((stat.averageRating || 0).toFixed(1)),
        totalRatings: stat.totalRatings || 0,
      },
    ])
  );

  const decorateBooking = (booking) => {
    const rating = ratingsByBookingId.get(booking._id.toString()) || null;
    const providerId = booking.provider?._id?.toString();
    const providerRating = providerId
      ? ratingsByProviderId.get(providerId) || {
          averageRating: 0,
          totalRatings: 0,
        }
      : { averageRating: 0, totalRatings: 0 };

    return {
      ...booking,
      isRated: Boolean(rating) || Boolean(booking.isRated),
      userRating: rating,
      provider: booking.provider
        ? {
            ...booking.provider,
            averageRating: providerRating.averageRating,
            totalRatings: providerRating.totalRatings,
          }
        : booking.provider,
    };
  };

  const decoratedBookings = bookings.map(decorateBooking);
  const activeStatuses = new Set(["pending", "accepted", "arrived", "ongoing"]);
  const ongoingBooking =
    decoratedBookings.find((booking) => activeStatuses.has(booking.status)) ||
    null;
  const getBookingActivityTime = (booking) => {
    const value =
      booking.completedAt || booking.updatedAt || booking.bookingDate || booking.createdAt;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isNaN(time) ? 0 : time;
  };
  const recentBookings = decoratedBookings.slice(0, 10);
  const washHistory = decoratedBookings
    .filter((booking) => booking.status?.toLowerCase?.() === "completed")
    .sort((a, b) => getBookingActivityTime(b) - getBookingActivityTime(a));

  const providerHistory = new Map();
  decoratedBookings.forEach((booking) => {
    const provider = booking.provider;
    if (!provider?._id) return;

    const providerId = provider._id.toString();
    const providerRating = ratingsByProviderId.get(providerId) || {
      averageRating: 0,
      totalRatings: 0,
    };

    const current = providerHistory.get(providerId) || {
      _id: provider._id,
      name: provider.name,
      email: provider.email,
      role: provider.role,
      photo: provider.photo,
      phoneNumber: provider.phoneNumber,
      averageRating: providerRating.averageRating,
      totalRatings: providerRating.totalRatings,
      totalBookings: 0,
      lastBooking: null,
      ongoingBooking: null,
      recentBookings: [],
    };

    current.totalBookings += 1;
    if (!current.lastBooking) current.lastBooking = booking;
    if (!current.ongoingBooking && activeStatuses.has(booking.status)) {
      current.ongoingBooking = booking;
    }
    if (current.recentBookings.length < 3) {
      current.recentBookings.push(booking);
    }

    providerHistory.set(providerId, current);
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User activity fetched successfully",
    data: {
      ongoingBooking,
      recentBookings,
      washHistory,
      providers: Array.from(providerHistory.values()),
      totalBookings: bookings.length,
      totalCompletedWashes: washHistory.length,
    },
  });
});
/**
 * Save / refresh the device's FCM push token.
 * Body: { token: string, platform: 'android' | 'ios' | 'web' }
 * Called by the app on login and on token refresh.
 */
export const saveFcmToken = catchAsync(async (req, res) => {
  const { token, platform } = req.body || {};

  if (!token || typeof token !== "string" || token.trim().length < 10) {
    throw new AppError(httpStatus.BAD_REQUEST, "A valid FCM token is required");
  }

  const cleanPlatform = ["android", "ios", "web"].includes(platform)
    ? platform
    : "android";

  // Remove any existing entry for this token, then push a fresh one.
  await User.updateOne(
    { _id: req.user._id },
    { $pull: { fcmTokens: { token: token.trim() } } }
  );
  await User.updateOne(
    { _id: req.user._id },
    {
      $push: {
        fcmTokens: {
          token: token.trim(),
          platform: cleanPlatform,
          updatedAt: new Date(),
        },
      },
    }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Push token saved",
    data: null,
  });
});

/** Remove an FCM token (call on logout). Body: { token: string } */
export const removeFcmToken = catchAsync(async (req, res) => {
  const { token } = req.body || {};
  if (token) {
    await User.updateOne(
      { _id: req.user._id },
      { $pull: { fcmTokens: { token: token.toString().trim() } } }
    );
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Push token removed",
    data: null,
  });
});
