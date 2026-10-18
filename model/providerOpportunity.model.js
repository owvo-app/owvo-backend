import mongoose from "mongoose";

const providerOpportunitySchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    opportunity: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Opportunity",
      required: true,
    },
    progress: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["active", "completed", "claimed", "paid", "expired"],
      default: "active",
    },
    completedAt: {
      type: Date,
      default: null,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    paidAmount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// One progress record per provider per opportunity
providerOpportunitySchema.index({ provider: 1, opportunity: 1 }, { unique: true });
providerOpportunitySchema.index({ provider: 1, status: 1 });
providerOpportunitySchema.index({ opportunity: 1, status: 1 });

export const ProviderOpportunity = mongoose.model("ProviderOpportunity", providerOpportunitySchema);
