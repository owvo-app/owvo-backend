import mongoose from "mongoose";

// Sequential numbers ke liye counter (support tickets ke T- pattern ki
// tarah, lekin atomic — do records ko ek hi number kabhi nahi mile ga).
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Counter = mongoose.model("Counter", counterSchema);
