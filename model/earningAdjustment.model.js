import mongoose from "mongoose";

// Admin ki taraf se provider ki kamai par manual adjustment
// (bonus = izafa, deduction = katauti). Reason lazmi hai aur ye
// provider ke available balance me money.util ke zariye shamil
// hota hai. Opportunities wale bonus payouts is se ALAG hain.
const earningAdjustmentSchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    type: {
      type: String,
      enum: ["bonus", "deduction"],
      required: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export const EarningAdjustment = mongoose.model(
  "EarningAdjustment",
  earningAdjustmentSchema
);
