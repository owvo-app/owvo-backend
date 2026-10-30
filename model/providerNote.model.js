import mongoose from "mongoose";

// Admin team ke private notes kisi provider ke baray me (Providers redesign —
// Step 7). Ye notes sirf admin panel me dikhte hain; provider ko kabhi
// nazar nahi ate.
const providerNoteSchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

export const ProviderNote = mongoose.model("ProviderNote", providerNoteSchema);
