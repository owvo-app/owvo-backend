import mongoose from "mongoose";

const platformSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "global",
    },
    commissionRate: {
      type: Number,
      default: 0.25,
      min: 0,
      max: 1,
    },
    providerVerificationRequired: {
      type: Boolean,
      default: true,
    },
    dailyWashLimitMax: {
      type: Number,
      default: 7,
      min: 1,
      max: 50,
    },
    autoPayoutEnabled: {
      type: Boolean,
      default: false,
    },
    nextPayoutDay: {
      type: String,
      default: "Friday",
      trim: true,
    },
    supportEmail: {
      type: String,
      default: "support@owvo.co.uk",
      trim: true,
    },
    stripeDashboardUrl: {
      type: String,
      default: "https://dashboard.stripe.com/",
      trim: true,
    },
    stripeAccountId: {
      type: String,
      default: "",
      trim: true,
    },
    stripePayoutsEnabled: {
      type: Boolean,
      default: false,
    },
    // Admin email alerts (Settings > Support & Notification Alerts).
    alertOnNewTicket: {
      type: Boolean,
      default: true,
    },
    alertOnDataRequest: {
      type: Boolean,
      default: true,
    },
    alertOnPayoutFailed: {
      type: Boolean,
      default: true,
    },
    adminAlertEmail: {
      type: String,
      default: "",
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

export const PlatformSetting = mongoose.model("PlatformSetting", platformSettingSchema);
