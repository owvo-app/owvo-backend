import bcrypt from "bcryptjs";
import mongoose, { Schema } from "mongoose";

const availabilityDaySchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    startTime: { type: String, default: "08:00" },
    endTime: { type: String, default: "17:30" },
  },
  { _id: false }
);

const defaultAvailabilityDay = () => ({
  enabled: true,
  startTime: "08:00",
  endTime: "17:30",
});

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = value.toString().trim();
  return normalized ? normalized : undefined;
};

const normalizeEmail = (value) => value?.toString().trim().toLowerCase();

const userSchema = new Schema(
  {
    name: { type: String, maxlength: 100, trim: true, default: "" },

    email: {
      type: String,
      trim: true,
      unique: true,
      lowercase: true,
      required: true,
    },

    password: { type: String, select: false },

    role: {
      type: String,
      enum: ["user", "admin", "provider", "staff"],
      default: "user",
    },
    staffPermissions: {
      menus: {
        type: [String],
        default: ["bookings"],
      },
      actions: {
        type: [String],
        default: ["booking.status.update"],
      },
    },
    accountStatus: {
      type: String,
      enum: ["active", "disabled"],
      default: "active",
    },
    adminVerification: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "approved", "rejected"],
        default: "not_submitted",
      },
      reviewedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      reviewedAt: { type: Date },
      rejectionReason: { type: String, trim: true, default: "" },
      notes: { type: String, trim: true, default: "" },
    },
    enforcement: {
      status: {
        type: String,
        enum: ["clear", "warned", "suspended", "banned"],
        default: "clear",
      },
      reason: { type: String, trim: true, default: "" },
      updatedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      updatedAt: { type: Date },
    },

    isOnline: { type: Boolean, default: false },
    isBusy: { type: Boolean, default: false },
    dailyWashLimit: { type: Number, default: 7 },
    dailyWashLimitMax: { type: Number, min: 1, max: 50 },
    // Admin "reset training" dabaye to yahan waqt save hota hai — is se
    // PEHLE ke saare training completions provider ke liye "ginte" nahi,
    // isay dobara har module dekhna parta hai. Audit history (ProviderAcceptance)
    // delete nahi hoti, sirf gating ka reference point badalta hai.
    trainingResetAt: { type: Date, default: null },
    policyAcceptance: {
      safetyGuidelinesAccepted: { type: Boolean, default: false },
      safetyGuidelinesAcceptedAt: { type: Date },
      washerAgreementAccepted: { type: Boolean, default: false },
      washerAgreementAcceptedAt: { type: Date },
      // Client ke 6-item Provider Agreement list ke baaqi 4 — Terms aur
      // Safety/Washer Agreement pehle se the
      termsConditionsAccepted: { type: Boolean, default: false },
      termsConditionsAcceptedAt: { type: Date },
      privacyPolicyAccepted: { type: Boolean, default: false },
      privacyPolicyAcceptedAt: { type: Date },
      marketplaceRulesAccepted: { type: Boolean, default: false },
      marketplaceRulesAcceptedAt: { type: Date },
      independentContractorAgreementAccepted: { type: Boolean, default: false },
      independentContractorAgreementAcceptedAt: { type: Date },
      version: { type: String, default: "2026-06-03" },
    },
    availability: {
      mode: {
        type: String,
        enum: ["always", "schedule"],
        default: "always",
      },
      days: {
        monday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
        tuesday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
        wednesday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
        thursday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
        friday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
        saturday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
        sunday: { type: availabilityDaySchema, default: defaultAvailabilityDay },
      },
      updatedAt: { type: Date },
    },

    verificationInfo: {
      verified: { type: Boolean, default: false },
      token: { type: String, default: "" },
    },

    password_reset_token: { type: String, default: "" },
    refreshToken: { type: String, default: "" },
    isEmailVerified: { type: Boolean, default: false },
    resetPasswordOTP: { type: String },
    resetPasswordOTPExpiry: { type: Date },
    deleteReason: { type: String },
    deletedAt: { type: Date },

    phoneNumber: {
      type: String,
      required: false,
      trim: true,
      set: normalizeOptionalString,
    },

    language: {
      type: String,
      enum: ["English", "Spanish"],
      default: "English",
    },

    serviceArea: { type: String, trim: true, default: "" },
    nationalInsuranceNumber: { type: String, trim: true, default: "" },
    nationalInsuranceStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },

    photo: {
        public_id: { type: String, default: "" },
        url: { type: String, default: "" }
    },

    dateOfBirth: {
      type: Date,
      validate: {
        validator: function (value) {
          if (!value) return true;

          const today = new Date();
          const dob = new Date(value);

          let age = today.getFullYear() - dob.getFullYear();
          const m = today.getMonth() - dob.getMonth();
          if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;

          return age >= 18;
        },
        message: "User must be 18+",
      },
    },

    residentialAddress: { type: String, trim: true, default: "" },
    providerAddress: {
      streetAddress: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: "" },
      postcode: { type: String, trim: true, default: "" },
    },
    rightToWorkUK: { type: Boolean, default: false },

    isProfileCompleted: { type: Boolean, default: false },

    identityVerification: {
      documentType: {
        type: String,
        enum: ["passport", "driving_license", ""],
        default: "",
      },
      documentNumber: { type: String, trim: true, default: "" },
      idFile: { public_id: String, url: String, default: {} },
      passportOrDrivingLicenseFile: { public_id: String, url: String, default: {} },
      status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "pending",
      },
      submittedAt: { type: Date },
    },

    drivewayEligibility: {
      isPrivateProperty: { type: Boolean, default: false },
      hasPermission: { type: Boolean, default: false },
      noRoadPayment: { type: Boolean, default: false },
      oneCarSpaceOnly: { type: Boolean, default: false },
      notSharedOrCommunal: { type: Boolean, default: false },
      // Client ke 6-item checklist ke baaqi 2 — pehle 4 pehle se maujood thay
      isSafeWorkingArea: { type: Boolean, default: false },
      isResidentialAreaSuitable: { type: Boolean, default: false },
    },

    isIdentityCompleted: { type: Boolean, default: false },

    bankDetails: {
      accountHolderName: { type: String, trim: true, default: "" },
      address: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      postcode: { type: String, trim: true, default: "" },
      dateOfBirth: { type: Date },
      accountNumber: { type: String, trim: true, default: "" },
      sortCode: { type: String, trim: true, default: "" },
    },

    stripeConnect: {
      accountId: { type: String, trim: true, default: "" },
      payoutsEnabled: { type: Boolean, default: false },
      onboardingComplete: { type: Boolean, default: false },
    },

    isBankCompleted: { type: Boolean, default: false },

   insurance: {
      document: {
           public_id: { type: String, default: "" },
          url: { type: String, default: "" },
    },
      uploadedAt: { type: Date },
},

    publicLiabilityInsurance: {
      document: {
        public_id: { type: String, default: "" },
        url: { type: String, default: "" },
      },
      uploadedAt: { type: Date },
      policyNumber: { type: String, trim: true, default: "" },
      insuranceCompany: { type: String, trim: true, default: "" },
      expiryDate: { type: Date, default: null },
      status: {
        type: String,
        enum: ["pending", "verified", "rejected"],
        default: "pending",
      },
      rejectionReason: { type: String, trim: true, default: "" },
    },

    drivewayPhoto: {
      document: {
        public_id: { type: String, default: "" },
        url: { type: String, default: "" },
      },
      uploadedAt: { type: Date },
    },
    // Optional dusri photo — driveway tak entrance/gaadi kahan se andar aati hai
    entrancePhoto: {
      document: {
        public_id: { type: String, default: "" },
        url: { type: String, default: "" },
      },
      uploadedAt: { type: Date },
    },

    location: {
      type: {
        type: String,
        enum: ["Point"],
      },
      coordinates: {
        type: [Number],
      },
    },

    preferredServices: [
      {
        type: Schema.Types.ObjectId,
        ref: "Service",
      },
    ],

    balance: {
      type: Number,
      default: 0,
    },

    totalTipsEarned: {
      type: Number,
      default: 0,
    },
    customerRatingAverage: {
      type: Number,
      default: 0,
    },
    customerRatingCount: {
      type: Number,
      default: 0,
    },
    completedJobs: {
      today: { type: Number, default: 0 },
      week: { type: Number, default: 0 },
      yearly: { type: Number, default: 0 },
      allTime: { type: Number, default: 0 },
      syncedAt: { type: Date },
    },
  },
  { timestamps: true }
);
userSchema.index({ location: "2dsphere" }, { sparse: true });
userSchema.index(
  { phoneNumber: 1 },
  {
    unique: true,
    name: "phoneNumber_unique_when_present",
    partialFilterExpression: { phoneNumber: { $type: "string", $gt: "" } },
  }
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.statics.isUserExistsByEmail = async function (email) {
  return await this.findOne({ email: normalizeEmail(email) }).select("+password");
};

userSchema.statics.isOTPVerified = async function (id) {
  const user = await this.findById(id).select("+verificationInfo");
  return user?.verificationInfo.verified;
};

userSchema.statics.isPasswordMatched = async function (
  plainTextPassword,
  hashPassword
) {
  return await bcrypt.compare(plainTextPassword, hashPassword);
};

export const User = mongoose.model("User", userSchema);