import mongoose from "mongoose";

/**
 * Har acceptance/completion event ka audit record — ek row = ek event.
 * Purana `User.policyAcceptance` (boolean + date) chhua nahi, wo abhi bhi
 * "abhi haal mein accepted hai ya nahi" check karne ke liye use hota hai.
 * Ye collection poori tareekh (history) rakhti hai — jab jab accept hua,
 * kis device se, kaunse app version se.
 */
const providerAcceptanceSchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "safety_guidelines",
        "washer_agreement",
        "training_module",
        "terms_conditions",
        "privacy_policy",
        "marketplace_rules",
        "independent_contractor_agreement",
      ],
      required: true,
    },
    // Sirf training_module ke liye — kaunsa module tha
    moduleId: { type: String, trim: true, default: "" },
    percentWatched: { type: Number, min: 0, max: 100, default: null },
    version: { type: String, trim: true, default: "" },
    acceptedAt: { type: Date, default: Date.now },
    device: { type: String, trim: true, default: "" },
    appVersion: { type: String, trim: true, default: "" },
    ipAddress: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

providerAcceptanceSchema.index({ provider: 1, type: 1, createdAt: -1 });

export default mongoose.model("ProviderAcceptance", providerAcceptanceSchema);