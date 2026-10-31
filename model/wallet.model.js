import mongoose from "mongoose";

// Customer OWVO Wallet — ek customer ka ek wallet. Balance sirf
// WalletTransaction entries ke zariye badalta hai; debit hamesha
// atomic shart ke sath (balance >= amount) taake double-spend na ho.
const walletSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    balance: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "GBP", uppercase: true, trim: true },
  },
  { timestamps: true }
);

export const Wallet = mongoose.model("Wallet", walletSchema);
