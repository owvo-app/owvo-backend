import mongoose from "mongoose";

const opportunitySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    type: {
      type: String,
      enum: ["daily", "weekly", "custom", "location", "service", "milestone", "referral"],
      required: true,
    },
    target: {
      type: Number,
      required: true,
      min: 1,
    },
    targetUnit: {
      type: String,
      enum: ["bookings", "revenue", "referrals"],
      default: "bookings",
    },
    rewardAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    // For location type: service area / city
    location: {
      type: String,
      trim: true,
      default: "",
    },
    // For service type: specific service ID
    service: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      default: null,
    },
    audience: {
      type: String,
      enum: ["all", "selected", "areas"],
      default: "all",
    },
    selectedProviders: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }],
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    hasSpecificTime: {
      type: Boolean,
      default: false,
    },
    startTime: {
      type: String,
      default: "",
    },
    endTime: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "scheduled", "paused", "ended"],
      default: "scheduled",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

opportunitySchema.index({ status: 1, isActive: 1 });
opportunitySchema.index({ startDate: 1, endDate: 1 });
opportunitySchema.index({ type: 1 });

export const Opportunity = mongoose.model("Opportunity", opportunitySchema);
