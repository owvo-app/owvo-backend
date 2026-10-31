import mongoose from "mongoose";

// Admin team ke private notes kisi booking ke baray me (Bookings redesign).
// Ye notes sirf admin panel me dikhte hain; customer/provider ko kabhi
// nazar nahi ate. CustomerNote jaisa hi pattern hai.
const bookingNoteSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
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

export const BookingNote = mongoose.model("BookingNote", bookingNoteSchema);
