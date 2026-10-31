import mongoose from "mongoose";
import { getNextTxnNumber } from "../utils/counter.util.js";

const payoutSchema = new mongoose.Schema(
  {
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "GBP",
      uppercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "paid", "failed"],
      default: "pending",
    },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    payoutDate: { type: Date },
    paidAt: { type: Date },
    failureReason: { type: String, trim: true, default: "" },
    txnNumber: { type: String, unique: true, sparse: true, index: true },
    // "booking" = booking earnings; "bonus" = Opportunities bonus.
    // Dono ka hisaab hamesha alag rahe ga.
    source: {
      type: String,
      enum: ["booking", "bonus"],
      default: "booking",
      index: true,
    },
    stripeTransferId: { type: String, trim: true, default: "" },
    stripePayoutId: { type: String, trim: true, default: "" },
    // Is payout me kaun si bookings ki earnings gayin (traceability).
    bookingIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
    ],
    // Har koshish ka record — automatic try, fail, retry, manual pay.
    attempts: [
      {
        at: { type: Date, default: Date.now },
        action: { type: String, trim: true, default: "" },
        result: { type: String, trim: true, default: "" },
        note: { type: String, trim: true, default: "" },
        by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
    ],
    stripeDestinationAccountId: { type: String, trim: true, default: "" },
    stripeMode: {
      type: String,
      enum: ["manual", "stripe_transfer"],
      default: "manual",
    },
    // Payout ka raasta: auto (Stripe Connect) ya manual (bank transfer).
    mode: {
      type: String,
      enum: ["auto", "manual"],
      default: "manual",
    },
    manualAdjustmentAmount: { type: Number, default: 0 },
    manualAdjustmentReason: { type: String, trim: true, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

payoutSchema.index({ provider: 1, createdAt: -1 });
payoutSchema.index({ status: 1, payoutDate: 1 });

payoutSchema.pre("save", async function assignTxnNumber() {
  if (!this.txnNumber) {
    this.txnNumber = await getNextTxnNumber();
  }
});

export const Payout = mongoose.model("Payout", payoutSchema);
