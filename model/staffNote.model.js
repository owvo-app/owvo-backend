import mongoose from "mongoose";

// Private admin notes about a staff member (Staff Management redesign).
// Only visible inside the admin panel — the staff member never sees them.
const staffNoteSchema = new mongoose.Schema(
  {
    staff: {
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

export const StaffNote = mongoose.model("StaffNote", staffNoteSchema);
