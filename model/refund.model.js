import mongoose from "mongoose";

// Refund ledger — har refund apna record hai (ek booking par kai
// partial refunds mumkin). Booking ka purana single `refund` subdoc
// is me migrate ho jayega; booking panel wala refund bhi yahi likhe ga.
const refundSchema = new mongoose.Schema(
  {
    txnNumber: { type: String, unique: true, index: true },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    // Asal captured payment jis se refund ho raha hai.
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "paymentInfo",
      default: null,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: "GBP", uppercase: true, trim: true },
    // Kitni raqam wallet se gayi thi, kitni card se — refund asal
    // raaste par wapas jata hai (wallet hissa foran wallet me).
    walletPortion: { type: Number, default: 0, min: 0 },
    cardPortion: { type: Number, default: 0, min: 0 },
    reasonCategory: {
      type: String,
      enum: [
        "customer_request",
        "service_issue",
        "duplicate",
        "provider_fault",
        "other",
      ],
      default: "customer_request",
    },
    reason: { type: String, trim: true, default: "" },
    customerMessage: { type: String, trim: true, default: "" },
    source: {
      type: String,
      enum: ["admin", "customer_request"],
      default: "admin",
    },
    ticket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupportTicket",
      default: null,
    },
    status: {
      type: String,
      enum: [
        "requested",
        "under_review",
        "approved",
        "processing",
        "refunded",
        "rejected",
        "failed",
      ],
      default: "requested",
      index: true,
    },
    stripePaymentIntentId: { type: String, trim: true, default: "" },
    stripeRefundId: { type: String, trim: true, default: "" },
    failureReason: { type: String, trim: true, default: "" },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    // Provider earning par asar: reversed (payout se pehle) ya
    // adjusted (payout ke baad — agle payout se katauti).
    earningReversal: {
      status: {
        type: String,
        enum: ["none", "reversed", "adjusted"],
        default: "none",
      },
      amount: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

refundSchema.index({ customer: 1, createdAt: -1 });
refundSchema.index({ status: 1, createdAt: -1 });

export const Refund = mongoose.model("Refund", refundSchema);
