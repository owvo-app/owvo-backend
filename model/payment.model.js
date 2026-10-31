import mongoose from "mongoose";
import { getNextTxnNumber } from "../utils/counter.util.js";

const paymentInfoSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Types.ObjectId,
      ref: "User",
    },
    bookingId: {
      type: mongoose.Types.ObjectId,
      ref: "Booking",
    },
    providerId: {
      type: mongoose.Types.ObjectId,
      ref: "User",
    },
    price: { type: Number, required: true },
    currency: {
      type: String,
      default: "GBP",
      uppercase: true,
      trim: true,
    },
    paymentStatus: {
      type: String,
      enum: ["complete", "pending", "failed"],
      default: "pending",
    },
    status: {
      type: String,
      enum: ["success", "failed","pending"],
      default: "pending",
    },
    txnNumber: { type: String, unique: true, sparse: true, index: true },
    // Wallet/Card split — cardAmount woh hissa hai jo Stripe se gaya.
    walletAmount: { type: Number, default: 0 },
    cardAmount: { type: Number, default: 0 },
    seasonId: { type: String },
    transactionId: { type: String },
    paymentMethodNonce: { type: String },
    paymentMethod: { type: String },
    type: { type: String, enum: ["donation", "booking", "tips"] },
  },
  {
    timestamps: true,
  }
);

paymentInfoSchema.pre("save", async function assignTxnNumber() {
  if (!this.txnNumber) {
    this.txnNumber = await getNextTxnNumber();
  }
});

export const paymentInfo = mongoose.model("paymentInfo", paymentInfoSchema);
