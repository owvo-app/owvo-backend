import mongoose from "mongoose";

const ticketMessageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderRole: {
      type: String,
      enum: ["customer", "provider", "admin", "staff"],
      required: true,
    },
    text: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    // File attachment (image or PDF) sent with the message — REST upload
    // to Cloudinary, same shape as the booking chat attachments.
    attachment: {
      url: { type: String, default: "" },
      type: { type: String, enum: ["image", "file", ""], default: "" },
      name: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      size: { type: Number, default: 0 },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const supportTicketSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      unique: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    type: {
      type: String,
      enum: ["complaint", "refund", "dispute", "technical", "cancellation", "payment"],
      required: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
    },
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reporterRole: {
      type: String,
      enum: ["customer", "provider"],
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
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    adminNotes: {
      type: String,
      trim: true,
      default: "",
    },
    resolutionNote: {
      type: String,
      trim: true,
      default: "",
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    // Where the ticket came from: the app, an admin, or a booking
    // "Report an Issue" submission (which now lands here as a ticket).
    source: {
      type: String,
      enum: ["app", "admin", "report"],
      default: "app",
    },
    // Money outcome decided when a dispute/refund ticket is resolved
    // from the admin panel (Section E of the Support build document).
    resolutionOutcome: {
      type: {
        type: String,
        enum: ["refund_full", "refund_partial", "release_provider", "split", "no_action", null],
        default: null,
      },
      amount: { type: Number, default: 0 },
      refund: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Refund",
        default: null,
      },
      decidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      decidedAt: { type: Date, default: null },
      note: { type: String, trim: true, default: "" },
    },
    messages: [ticketMessageSchema],
  },
  { timestamps: true }
);

// Auto-generate ticket number like T-1024
supportTicketSchema.pre("save", async function () {
  if (!this.ticketNumber) {
    const count = await mongoose.model("SupportTicket").countDocuments();
    this.ticketNumber = `T-${1024 + count}`;
  }
});

supportTicketSchema.index({ reporter: 1, createdAt: -1 });
supportTicketSchema.index({ booking: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ type: 1, createdAt: -1 });
supportTicketSchema.index({ assignedTo: 1, status: 1 });

export const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
