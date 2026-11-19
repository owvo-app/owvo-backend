import mongoose from "mongoose";

// Notify-me sign-ups for a postcode district that has not opened yet.
// One entry per user per district. When the district's area is activated,
// everyone with notifiedAt = null is notified once and stamped.
const serviceAreaWaitlistSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["customer", "provider"], required: true },
    postcodeDistrict: { type: String, required: true, uppercase: true, trim: true, index: true },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

serviceAreaWaitlistSchema.index({ user: 1, postcodeDistrict: 1 }, { unique: true });

export const ServiceAreaWaitlist = mongoose.model(
  "ServiceAreaWaitlist",
  serviceAreaWaitlistSchema
);
