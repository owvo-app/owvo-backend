import mongoose from "mongoose";

// Kisi bhi transaction (payment / payout / refund) par admin ki note.
// Internal sirf staff ko; customer wali note customer ko bhi dikhti hai.
const transactionNoteSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: ["payment", "payout", "refund"],
      required: true,
      index: true,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    visibility: {
      type: String,
      enum: ["internal", "customer"],
      default: "internal",
    },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

transactionNoteSchema.index({ sourceType: 1, sourceId: 1, createdAt: -1 });

export const TransactionNote = mongoose.model(
  "TransactionNote",
  transactionNoteSchema
);
