import catchAsync from "../utils/catch.Async.js";
import AppError from "../errors/AppError.js";
import httpStatus from "http-status";
import { SupportTicket } from "../model/supportTicket.model.js";
import { User } from "../model/user.model.js";
import { Booking } from "../model/booking.model.js";
import { Refund } from "../model/refund.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { emitToUser, broadcast } from "../socket/socket.js";
import { notifyUser } from "../utils/fcm.util.js";
import { sendAdminAlert } from "../utils/adminAlert.util.js";
import { uploadOnCloudinary } from "../utils/common.Method.js";
import { asMoney } from "../utils/money.util.js";
import { recordActivity } from "../utils/activityLog.util.js";
import { executeRefund } from "./admin.controller.js";

const TICKET_TYPES = ["complaint", "refund", "dispute", "technical", "cancellation", "payment"];
const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];
const TICKET_PRIORITIES = ["low", "medium", "high"];
const OUTCOME_TYPES = ["refund_full", "refund_partial", "release_provider", "split", "no_action"];
// Above this refund amount a dispute outcome needs the full admin role.
const OUTCOME_ADMIN_THRESHOLD = 50;

const ticketPopulate = [
  { path: "reporter", select: "name email phoneNumber role" },
  { path: "booking", select: "bookingDate status finalPrice" },
  { path: "reportedUser", select: "name email role" },
  { path: "assignedTo", select: "name email" },
  { path: "messages.sender", select: "name role" },
  { path: "resolutionOutcome.decidedBy", select: "name email" },
  { path: "resolutionOutcome.refund", select: "amount status" },
];

/** Uploaded file (field "document") → message attachment, or null. */
const attachmentFromFile = async (file) => {
  if (!file) return null;
  const uploaded = await uploadOnCloudinary(file.path, "ticket_attachments");
  if (!uploaded?.secure_url) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "File upload failed. Please try again."
    );
  }
  const isImage = (file.mimetype || "").startsWith("image/");
  return {
    url: uploaded.secure_url,
    type: isImage ? "image" : "file",
    name: file.originalname || "",
    mimeType: file.mimetype || "",
    size: file.size || 0,
  };
};

const broadcastTicket = (event, ticket) => {
  try {
    broadcast(event, {
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      status: ticket.status,
    });
  } catch (e) {
    /* socket optional */
  }
};

// ─── App side (customer/provider) ───

/** POST /tickets — raise a new support ticket */
export const createTicket = catchAsync(async (req, res) => {
  const { subject, description, type, priority, bookingId, reportedUserId } = req.body;

  if (!subject?.trim() || !description?.trim() || !type) {
    throw new AppError(httpStatus.BAD_REQUEST, "Subject, description and type are required");
  }
  if (!TICKET_TYPES.includes(type)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid ticket type");
  }
  if (priority && !TICKET_PRIORITIES.includes(priority)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid priority");
  }

  const reporterRole = req.user.role === "provider" ? "provider" : "customer";

  let booking = null;
  if (bookingId) {
    booking = await Booking.findById(bookingId);
    if (!booking) throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  const ticket = await SupportTicket.create({
    subject: subject.trim(),
    description: description.trim(),
    type,
    priority: priority || "medium",
    reporter: req.user._id,
    reporterRole,
    booking: booking?._id || null,
    reportedUser: reportedUserId || null,
    source: "app",
  });

  await ticket.populate(ticketPopulate);
  broadcastTicket("admin_ticket_created", ticket);

  // Admin email alert (Settings > Notification Alerts) — fire-and-forget,
  // it never delays or fails the ticket creation.
  sendAdminAlert(
    "ticket",
    `New support ticket #${ticket.ticketNumber || ""} — ${ticket.subject || "Ticket"}`,
    `A new ${ticket.type || "support"} ticket was opened in the OWVO app.\n\nSubject: ${ticket.subject || "-"}\nPriority: ${ticket.priority || "medium"}\n\nOpen the admin panel (Support & Disputes) to respond.`
  );

  res.status(httpStatus.CREATED).json({ success: true, data: ticket });
});

/** GET /tickets — user's own tickets */
export const getMyTickets = catchAsync(async (req, res) => {
  const { status } = req.query;
  const filter = { reporter: req.user._id };
  if (status && TICKET_STATUSES.includes(status)) filter.status = status;

  const tickets = await SupportTicket.find(filter)
    .populate(ticketPopulate)
    .sort({ createdAt: -1 })
    .lean();

  res.status(httpStatus.OK).json({ success: true, data: tickets });
});

/** GET /tickets/:id — single ticket (must be own) */
export const getMyTicketById = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findOne({
    _id: req.params.id,
    reporter: req.user._id,
  }).populate(ticketPopulate);

  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

/** POST /tickets/:id/messages — reply to own ticket (text and/or a file) */
export const replyToTicket = catchAsync(async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const attachment = await attachmentFromFile(req.file);
  if (!text && !attachment) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message text or a file is required");
  }

  const ticket = await SupportTicket.findOne({
    _id: req.params.id,
    reporter: req.user._id,
  });
  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");
  if (["resolved", "closed"].includes(ticket.status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Ticket is already closed");
  }

  ticket.messages.push({
    sender: req.user._id,
    senderRole: req.user.role === "provider" ? "provider" : "customer",
    text,
    ...(attachment ? { attachment } : {}),
  });
  // Reopen if user replies to resolved ticket
  if (ticket.status === "resolved") ticket.status = "in_progress";
  await ticket.save();
  await ticket.populate(ticketPopulate);
  broadcastTicket("admin_ticket_updated", ticket);

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

// ─── Admin side ───

/** POST /admin/tickets — an admin/staff member opens a ticket for a user */
export const createAdminTicket = catchAsync(async (req, res) => {
  const { reporterId, subject, description, type, priority, bookingId } =
    req.body || {};

  if (!reporterId || !subject?.trim() || !description?.trim() || !type) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Reporter, subject, description and type are required"
    );
  }
  if (!TICKET_TYPES.includes(type)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid ticket type");
  }
  if (priority && !TICKET_PRIORITIES.includes(priority)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid priority");
  }

  const reporter = await User.findById(reporterId).select("role name");
  if (!reporter) throw new AppError(httpStatus.NOT_FOUND, "Reporter not found");
  const reporterRole = reporter.role === "provider" ? "provider" : "customer";

  let booking = null;
  let reportedUser = null;
  if (bookingId) {
    booking = await Booking.findById(bookingId).select("user provider");
    if (!booking) throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
    const belongs =
      booking.user?.toString() === reporterId ||
      booking.provider?.toString() === reporterId;
    if (!belongs) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "That booking does not belong to the selected reporter."
      );
    }
    reportedUser =
      booking.user?.toString() === reporterId
        ? booking.provider
        : booking.user;
  }

  const ticket = await SupportTicket.create({
    subject: subject.trim(),
    description: description.trim(),
    type,
    priority: priority || "medium",
    reporter: reporter._id,
    reporterRole,
    booking: booking?._id || null,
    reportedUser,
    source: "admin",
  });

  await ticket.populate(ticketPopulate);
  broadcastTicket("admin_ticket_created", ticket);

  notifyUser(reporter._id.toString(), {
    title: `Support ticket ${ticket.ticketNumber}`,
    body: `A support ticket has been opened for you: ${ticket.subject}`,
    data: {
      type: "support_status",
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
    },
  });

  res.status(httpStatus.CREATED).json({ success: true, data: ticket });
});

/** GET /admin/tickets/assignees — dashboard users a ticket can go to */
export const getTicketAssignees = catchAsync(async (req, res) => {
  const users = await User.find({
    role: { $in: ["admin", "staff"] },
    accountStatus: { $ne: "disabled" },
  })
    .select("name email role")
    .sort({ name: 1 })
    .lean();
  res.status(httpStatus.OK).json({ success: true, data: users });
});

/** GET /admin/tickets/user-bookings?userId= — a user's bookings, for the
 *  New Ticket form's booking picker (latest first, minimal fields). */
export const getAdminUserBookings = catchAsync(async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    throw new AppError(httpStatus.BAD_REQUEST, "userId is required");
  }
  const bookings = await Booking.find({
    $or: [{ user: userId }, { provider: userId }],
  })
    .select("bookingDate status finalPrice bookingType user provider")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.status(httpStatus.OK).json({ success: true, data: bookings });
});

/** GET /admin/tickets — all tickets with filters */
export const getAdminTickets = catchAsync(async (req, res) => {
  const { status, type, priority, search, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status && TICKET_STATUSES.includes(status)) filter.status = status;
  if (type && TICKET_TYPES.includes(type)) filter.type = type;
  if (priority && TICKET_PRIORITIES.includes(priority)) filter.priority = priority;
  if (search) {
    const or = [
      { ticketNumber: { $regex: search, $options: "i" } },
      { subject: { $regex: search, $options: "i" } },
    ];
    // Search by reporter / reported-user name as the placeholder promises.
    const people = await User.find({
      name: { $regex: search, $options: "i" },
    })
      .select("_id")
      .limit(50)
      .lean();
    if (people.length) {
      const ids = people.map((p) => p._id);
      or.push({ reporter: { $in: ids } }, { reportedUser: { $in: ids } });
    }
    filter.$or = or;
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter).populate(ticketPopulate).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    SupportTicket.countDocuments(filter),
  ]);

  // Status counts for cards
  const counts = await SupportTicket.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const statusCounts = { open: 0, in_progress: 0, resolved: 0, closed: 0, total: total };
  counts.forEach((c) => { if (statusCounts[c._id] !== undefined) statusCounts[c._id] = c.count; });
  statusCounts.total = await SupportTicket.countDocuments({});

  res.status(httpStatus.OK).json({
    success: true,
    data: { items: tickets, total, page: Number(page), limit: Number(limit), statusCounts },
  });
});

/** GET /admin/tickets/:id — ticket detail */
export const getAdminTicketById = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id).populate(ticketPopulate);
  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");
  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

/** PATCH /admin/tickets/:id — update status/priority/assign/notes */
export const updateAdminTicket = catchAsync(async (req, res) => {
  const { status, priority, assignedTo, adminNotes, resolutionNote } = req.body;

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");

  if (status) {
    if (!TICKET_STATUSES.includes(status)) throw new AppError(httpStatus.BAD_REQUEST, "Invalid status");
    // A booking-linked dispute/refund ticket can only be finished through
    // the outcome action, so the money decision is never skipped.
    if (
      ["resolved", "closed"].includes(status) &&
      ["dispute", "refund"].includes(ticket.type) &&
      ticket.booking &&
      !ticket.resolutionOutcome?.type
    ) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "This ticket is linked to a booking and needs a resolution outcome. Use the outcome action in the Resolution tab to finish it."
      );
    }
    ticket.status = status;
    if (["resolved", "closed"].includes(status) && !ticket.resolvedAt) {
      ticket.resolvedAt = new Date();
    }
    if (status === "open") ticket.resolvedAt = null;
  }
  if (priority) {
    if (!TICKET_PRIORITIES.includes(priority)) throw new AppError(httpStatus.BAD_REQUEST, "Invalid priority");
    ticket.priority = priority;
  }
  if (assignedTo !== undefined) {
    if (assignedTo) {
      const staff = await User.findById(assignedTo);
      if (!staff) throw new AppError(httpStatus.NOT_FOUND, "Staff user not found");
    }
    const changed =
      (ticket.assignedTo?.toString() || null) !== (assignedTo || null);
    ticket.assignedTo = assignedTo || null;
    if (changed && assignedTo) {
      notifyUser(assignedTo.toString(), {
        title: `Ticket assigned — ${ticket.ticketNumber}`,
        body: `You have been assigned support ticket ${ticket.ticketNumber}: ${ticket.subject}`,
        data: {
          type: "support_assigned",
          ticketId: ticket._id.toString(),
          ticketNumber: ticket.ticketNumber,
        },
      });
    }
  }
  if (adminNotes !== undefined) ticket.adminNotes = adminNotes;
  if (resolutionNote !== undefined) ticket.resolutionNote = resolutionNote;

  await ticket.save();
  await ticket.populate(ticketPopulate);
  broadcastTicket("admin_ticket_updated", ticket);

  // Notify reporter
  try {
    emitToUser(ticket.reporter.toString(), "ticket_updated", {
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      status: ticket.status,
      message: `Your ticket ${ticket.ticketNumber} is now ${ticket.status}`,
    });
  } catch (e) { /* socket optional */ }
  if (status) {
    notifyUser(ticket.reporter.toString(), {
      title: `Support ticket ${ticket.ticketNumber}`,
      body: `Your ticket ${ticket.ticketNumber} is now ${ticket.status}`,
      data: {
        type: "support_status",
        ticketId: ticket._id.toString(),
        ticketNumber: ticket.ticketNumber,
      },
    });
  }

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

/** POST /admin/tickets/:id/messages — admin reply (text and/or a file) */
export const adminReplyToTicket = catchAsync(async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const attachment = await attachmentFromFile(req.file);
  if (!text && !attachment) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message text or a file is required");
  }

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");

  ticket.messages.push({
    sender: req.user._id,
    senderRole: req.user.role === "staff" ? "staff" : "admin",
    text,
    ...(attachment ? { attachment } : {}),
  });
  if (ticket.status === "open") ticket.status = "in_progress";
  await ticket.save();
  await ticket.populate(ticketPopulate);
  broadcastTicket("admin_ticket_updated", ticket);

  try {
    emitToUser(ticket.reporter.toString(), "ticket_message", {
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      message: `New reply on ticket ${ticket.ticketNumber}`,
    });
  } catch (e) { /* socket optional */ }
  notifyUser(ticket.reporter.toString(), {
    title: `Support reply — ${ticket.ticketNumber}`,
    body: text ? text.slice(0, 140) : "You received a file on your support ticket.",
    data: {
      type: "support_message",
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
    },
  });

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

/**
 * POST /admin/tickets/:id/outcome — decide the money outcome of a
 * booking-linked dispute/refund ticket and resolve it in one step.
 * The refund itself runs through the Payments engine (executeRefund).
 */
export const resolveTicketOutcome = catchAsync(async (req, res) => {
  const { outcome, amount, note } = req.body || {};

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");
  if (!["dispute", "refund"].includes(ticket.type)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A money outcome only applies to dispute and refund tickets."
    );
  }
  if (!ticket.booking) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This ticket is not linked to a booking, so no money outcome is possible."
    );
  }
  if (["resolved", "closed"].includes(ticket.status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "This ticket is already finished.");
  }
  if (ticket.resolutionOutcome?.type) {
    throw new AppError(httpStatus.BAD_REQUEST, "An outcome has already been decided for this ticket.");
  }
  if (!OUTCOME_TYPES.includes(outcome)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid outcome");
  }

  const booking = await Booking.findById(ticket.booking);
  if (!booking) throw new AppError(httpStatus.NOT_FOUND, "Linked booking not found");

  let refundAmount = 0;
  let refundDoc = null;

  if (["refund_full", "refund_partial", "split"].includes(outcome)) {
    // How much of this booking's payment can still be refunded?
    const record = await paymentInfo
      .findOne({
        bookingId: booking._id,
        type: "booking",
        paymentStatus: "complete",
      })
      .sort({ createdAt: -1 });
    const captured = record
      ? asMoney(record.price)
      : asMoney(booking.finalPrice || booking.price || 0);
    const priorAgg = await Refund.aggregate([
      { $match: { booking: booking._id, status: "refunded" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const remaining = asMoney(captured - asMoney(priorAgg[0]?.total || 0));

    if (outcome === "refund_full") {
      refundAmount = remaining;
    } else {
      refundAmount = asMoney(Number(amount));
    }
    if (!refundAmount || refundAmount <= 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        outcome === "refund_full"
          ? "There is nothing left to refund for this booking."
          : "Enter the refund amount."
      );
    }
    if (refundAmount > remaining + 0.001) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `The refund cannot be more than £${remaining.toFixed(2)} — the amount still refundable for this booking.`
      );
    }
    if (refundAmount > OUTCOME_ADMIN_THRESHOLD && req.user.role !== "admin") {
      throw new AppError(
        httpStatus.FORBIDDEN,
        `Outcomes above £${OUTCOME_ADMIN_THRESHOLD} need an admin. Ask an admin to decide this one.`
      );
    }

    refundDoc = await Refund.create({
      booking: booking._id,
      payment: record?._id || undefined,
      customer: booking.user,
      provider: booking.provider,
      amount: refundAmount,
      source: "dispute",
      ticket: ticket._id,
      status: "approved",
      reasonCategory: ticket.type === "dispute" ? "provider_fault" : "service_issue",
      reason:
        (note || "").toString().trim() ||
        `Outcome of support ticket ${ticket.ticketNumber}`,
      decidedBy: req.user._id,
    });
    // Runs the real money movement (Stripe + wallet + earning reversal).
    await executeRefund(refundDoc, req.user._id);
  }

  ticket.resolutionOutcome = {
    type: outcome,
    amount: refundAmount,
    refund: refundDoc?._id || null,
    decidedBy: req.user._id,
    decidedAt: new Date(),
    note: (note || "").toString().trim(),
  };
  if ((note || "").toString().trim()) {
    ticket.resolutionNote = (note || "").toString().trim();
  }
  ticket.status = "resolved";
  ticket.resolvedAt = new Date();
  await ticket.save();
  await ticket.populate(ticketPopulate);
  broadcastTicket("admin_ticket_updated", ticket);

  await recordActivity({
    req,
    action: "ticket.outcome_decided",
    entityType: "ticket",
    entityId: ticket._id,
    metadata: {
      ticketNumber: ticket.ticketNumber,
      outcome,
      amount: refundAmount,
      refundId: refundDoc?._id?.toString() || null,
    },
  });

  const outcomeText = {
    refund_full: `resolved with a full refund of £${refundAmount.toFixed(2)}`,
    refund_partial: `resolved with a refund of £${refundAmount.toFixed(2)}`,
    split: `resolved with a refund of £${refundAmount.toFixed(2)}; the rest stays with the provider`,
    release_provider: "resolved in the provider's favour — no refund",
    no_action: "resolved with no money action",
  }[outcome];

  const people = new Set([
    ticket.reporter?.toString(),
    ticket.reportedUser?.toString(),
  ]);
  for (const personId of people) {
    if (!personId) continue;
    notifyUser(personId, {
      title: `Ticket ${ticket.ticketNumber} resolved`,
      body: `Your support ticket ${ticket.ticketNumber} was ${outcomeText}.`,
      data: {
        type: "support_outcome",
        ticketId: ticket._id.toString(),
        ticketNumber: ticket.ticketNumber,
        outcome,
      },
    });
    try {
      emitToUser(personId, "ticket_updated", {
        ticketId: ticket._id.toString(),
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        message: `Your ticket ${ticket.ticketNumber} was ${outcomeText}`,
      });
    } catch (e) { /* socket optional */ }
  }

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});
