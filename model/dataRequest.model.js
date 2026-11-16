import mongoose from "mongoose";

const dataRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requesterRole: {
      type: String,
      enum: ["user", "provider"],
      required: true,
    },
    requestType: {
      type: String,
      enum: ["export", "deletion"],
      default: "export",
      index: true,
    },
    dueAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    requestNote: {
      type: String,
      trim: true,
      default: "",
    },
    adminNote: {
      type: String,
      trim: true,
      default: "",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    exportData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    exportGeneratedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

dataRequestSchema.index({ user: 1, status: 1, createdAt: -1 });
dataRequestSchema.index({ status: 1, createdAt: -1 });

// UK GDPR: a data request must be answered within one month. Every new
// request gets a due date 30 days after it was submitted so the admin
// page can flag anything overdue.
export const DATA_REQUEST_DUE_DAYS = 30;

dataRequestSchema.pre("save", async function () {
  if (this.isNew && !this.dueAt) {
    const base = this.createdAt ? new Date(this.createdAt) : new Date();
    this.dueAt = new Date(
      base.getTime() + DATA_REQUEST_DUE_DAYS * 24 * 60 * 60 * 1000
    );
  }
});

export const DataRequest = mongoose.model("DataRequest", dataRequestSchema);
