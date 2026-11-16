import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { Booking } from "../model/booking.model.js";
import { IssueReport } from "../model/issueReport.model.js";
import { uploadOnCloudinary } from "../utils/common.Method.js";
import { SupportTicket } from "../model/supportTicket.model.js";
import { broadcast } from "../socket/socket.js";

// One-queue model: a booking "Report an Issue" also becomes a Support
// Ticket, so it lands in Support & Disputes with a conversation and —
// for disputes — the money-outcome workflow. Report type → ticket type.
const REPORT_TO_TICKET_TYPE = {
  payment: "payment",
  service_quality: "complaint",
  safety: "dispute",
  provider_conduct: "dispute",
  general: "complaint",
};
const REPORT_TYPE_LABEL = {
  payment: "Payment issue",
  service_quality: "Service quality",
  safety: "Safety concern",
  provider_conduct: "Provider conduct",
  general: "Issue report",
};

const mirrorReportToTicket = async (report, req) => {
  try {
    const messages = [];
    if (report.photo?.url) {
      messages.push({
        sender: req.user._id,
        senderRole: req.user.role === "provider" ? "provider" : "customer",
        text: "Photo evidence attached",
        attachment: {
          url: report.photo.url,
          type: "image",
          name: "report-photo",
          mimeType: "image/*",
          size: 0,
        },
      });
    }
    const ticket = await SupportTicket.create({
      subject: `${REPORT_TYPE_LABEL[report.type] || "Issue report"} — booking report`,
      description: report.description,
      type: REPORT_TO_TICKET_TYPE[report.type] || "complaint",
      priority: report.type === "safety" ? "high" : "medium",
      reporter: req.user._id,
      reporterRole: req.user.role === "provider" ? "provider" : "customer",
      booking: report.booking || null,
      reportedUser: report.reportedUser || null,
      source: "report",
      messages,
    });
    report.supportTicket = ticket._id;
    await report.save();
    try {
      broadcast("admin_ticket_created", {
        ticketId: ticket._id.toString(),
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
      });
    } catch (e) { /* socket optional */ }
  } catch (e) {
    // The report itself is saved; a failed mirror must not fail the user.
    console.error("Report → ticket mirror failed:", e?.message || e);
  }
};

const photoFromFile = async (file) => {
  if (!file) return undefined;

  const cloudinaryConfigured =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;
  const requiresDurableStorage =
    process.env.NODE_ENV === "production" || process.env.RENDER;

  if (cloudinaryConfigured) {
    const uploadResult = await uploadOnCloudinary(file.path, "issue_reports");
    return {
      public_id: uploadResult.public_id,
      url: uploadResult.secure_url,
    };
  }

  if (requiresDurableStorage) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Cloudinary is required for report photo storage in production."
    );
  }

  return {
    public_id: file.filename || "",
    url: file.path ? `/${file.path.replace(/\\/g, "/")}` : "",
  };
};

export const createIssueReport = catchAsync(async (req, res) => {
  const { bookingId, reportedUserId, description, type } = req.body || {};
  const trimmedDescription = description?.toString().trim();

  if (!trimmedDescription) {
    throw new AppError(httpStatus.BAD_REQUEST, "Report description is required");
  }

  let booking = null;
  let reportedUser = reportedUserId || null;

  if (bookingId) {
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid bookingId");
    }

    booking = await Booking.findById(bookingId).select("user provider");
    if (!booking) {
      throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
    }

    const requesterId = req.user._id.toString();
    const customerId = booking.user?.toString();
    const providerId = booking.provider?.toString();

    if (requesterId !== customerId && requesterId !== providerId) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You can only report issues for your own bookings"
      );
    }

    if (!reportedUser) {
      reportedUser = requesterId === customerId ? providerId : customerId;
    }
  }

  if (reportedUser && !mongoose.Types.ObjectId.isValid(reportedUser)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid reportedUserId");
  }

  const report = await IssueReport.create({
    reporter: req.user._id,
    reporterRole: req.user.role,
    booking: booking?._id || null,
    reportedUser,
    description: trimmedDescription,
    type: ["general", "payment", "service_quality", "safety", "provider_conduct"].includes(type)
      ? type
      : "general",
    photo: await photoFromFile(req.file),
  });

  await mirrorReportToTicket(report, req);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Issue report submitted successfully",
    data: report,
  });
});
