import mongoose from "mongoose";

// Reports & Analytics — admin ki generate ki hui reports (PDF / XLSX / CSV)
// file ke bytes isi record me rehte hain taake Download / View kabhi bhi ho sake.
const generatedReportSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: [
        "earnings",
        "payouts",
        "refunds",
        "bookings",
        "services",
        "customers",
        "financial",
      ],
      required: true,
      index: true,
    },
    groupBy: {
      type: String,
      enum: ["day", "week", "month", "provider", "service", "none"],
      default: "day",
    },
    filters: { type: Object, default: {} },
    rangeFrom: { type: Date, default: null },
    rangeTo: { type: Date, default: null },
    rangeLabel: { type: String, default: "All Time" },
    format: { type: String, enum: ["pdf", "xlsx", "csv"], required: true },
    fileData: { type: Buffer, required: true, select: false },
    sizeBytes: { type: Number, default: 0 },
    rowCount: { type: Number, default: 0 },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

export const GeneratedReport = mongoose.model(
  "GeneratedReport",
  generatedReportSchema
);
