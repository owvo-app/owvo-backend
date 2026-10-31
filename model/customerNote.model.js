import mongoose from "mongoose";

// Admin team ke private notes kisi customer ke baray me (Customers redesign).
// Ye notes sirf admin panel me dikhte hain; customer ko kabhi nazar nahi ate.
const customerNoteSchema = new mongoose.Schema(
  {
    customer: {
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

export const CustomerNote = mongoose.model("CustomerNote", customerNoteSchema);
