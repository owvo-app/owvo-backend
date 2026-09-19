import mongoose from "mongoose";

/**
 * Provider Academy ka ek module. Admin isay upload/edit/reorder karta hai,
 * provider app isi list se dynamically videos dikhati hai — koi video
 * app ke andar bundled/hardcoded nahi hai.
 */
const trainingModuleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    topics: [{ type: String, trim: true }],

    // Cloudinary se aane wali video
    videoUrl: { type: String, required: true },
    cloudinaryPublicId: { type: String, default: "" },
    durationSeconds: { type: Number, default: null },

    // Admin ke controls
    order: { type: Number, default: 0, index: true },
    isMandatory: { type: Boolean, default: true },
    // false = admin ne "hide" kiya, provider ko ab nahi dikhta, lekin
    // completion history mehfooz rehti hai
    isActive: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

trainingModuleSchema.index({ isActive: 1, order: 1 });

export const TrainingModule = mongoose.model(
  "TrainingModule",
  trainingModuleSchema
);