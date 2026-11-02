import mongoose from "mongoose";
import { getNextTxnNumber } from "../utils/counter.util.js";

// Wallet ki har harkat ka record — yahi asal ledger hai, Wallet.balance
// is ki summary hai. amount hamesha signed hai: credit +, debit −.
const walletTransactionSchema = new mongoose.Schema(
  {
    txnNumber: { type: String, unique: true, index: true },
    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["topup", "payment", "refund_credit", "topup_refund", "adjustment"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    currency: { type: String, default: "GBP", uppercase: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "complete", "failed"],
      default: "complete",
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "paymentInfo",
      default: null,
    },
    refund: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Refund",
      default: null,
    },
    stripePaymentIntentId: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });

// Har record ko khud bakhud agla TXN number do — koi bhi jagah
// (top-up, payment, refund) number dena bhool jaye to unique index
// se takra kar fail na ho (E11000 null wali ghalti ka mustaqil hal).
walletTransactionSchema.pre("save", async function () {
  if (!this.txnNumber) {
    this.txnNumber = await getNextTxnNumber();
  }
});

export const WalletTransaction = mongoose.model(
  "WalletTransaction",
  walletTransactionSchema
);
