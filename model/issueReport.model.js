import mongoose from "mongoose";

const issueReportSchema = new mongoose.Schema(
  {
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reporterRole: {
      type: String,
      enum: ["user", "provider", "admin", "staff"],
      required: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    reportedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    type: {
      type: String,
      enum: ["general", "payment", "service_quality", "safety", "provider_conduct"],
      default: "general",
    },
    photo: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["open", "reviewing", "resolved", "dismissed"],
      default: "open",
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolutionNote: {
      type: String,
      trim: true,
      default: "",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // The SupportTicket this report was mirrored into (one-queue model).
    supportTicket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupportTicket",
      default: null,
    },
  },
  { timestamps: true }
);

issueReportSchema.index({ reporter: 1, createdAt: -1 });
issueReportSchema.index({ booking: 1, createdAt: -1 });
issueReportSchema.index({ status: 1, createdAt: -1 });
issueReportSchema.index({ type: 1, createdAt: -1 });

export const IssueReport = mongoose.model("IssueReport", issueReportSchema);
