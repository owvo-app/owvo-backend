import catchAsync from "../utils/catch.Async.js";
import AppError from "../errors/AppError.js";
import httpStatus from "http-status";
import { SupportTicket } from "../model/supportTicket.model.js";
import { User } from "../model/user.model.js";
import { Booking } from "../model/booking.model.js";
import { emitToUser } from "../socket/socket.js";

const TICKET_TYPES = ["complaint", "refund", "dispute", "technical", "cancellation", "payment"];
const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];
const TICKET_PRIORITIES = ["low", "medium", "high"];

const ticketPopulate = [
  { path: "reporter", select: "name email phoneNumber role" },
  { path: "booking", select: "bookingDate status finalPrice" },
  { path: "reportedUser", select: "name email role" },
  { path: "assignedTo", select: "name email" },
  { path: "messages.sender", select: "name role" },
];

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
  });

  await ticket.populate(ticketPopulate);

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

/** POST /tickets/:id/messages — reply to own ticket */
export const replyToTicket = catchAsync(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) {
    throw new AppError(httpStatus.BAD_REQUEST, "Message text is required");
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
    text: text.trim(),
  });
  // Reopen if user replies to resolved ticket
  if (ticket.status === "resolved") ticket.status = "in_progress";
  await ticket.save();
  await ticket.populate(ticketPopulate);

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

// ─── Admin side ───

/** GET /admin/tickets — all tickets with filters */
export const getAdminTickets = catchAsync(async (req, res) => {
  const { status, type, priority, search, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status && TICKET_STATUSES.includes(status)) filter.status = status;
  if (type && TICKET_TYPES.includes(type)) filter.type = type;
  if (priority && TICKET_PRIORITIES.includes(priority)) filter.priority = priority;
  if (search) {
    filter.$or = [
      { ticketNumber: { $regex: search, $options: "i" } },
      { subject: { $regex: search, $options: "i" } },
    ];
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
    ticket.assignedTo = assignedTo || null;
  }
  if (adminNotes !== undefined) ticket.adminNotes = adminNotes;
  if (resolutionNote !== undefined) ticket.resolutionNote = resolutionNote;

  await ticket.save();
  await ticket.populate(ticketPopulate);

  // Notify reporter
  try {
    emitToUser(ticket.reporter.toString(), "ticket_updated", {
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      status: ticket.status,
      message: `Your ticket ${ticket.ticketNumber} is now ${ticket.status}`,
    });
  } catch (e) { /* socket optional */ }

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});

/** POST /admin/tickets/:id/messages — admin reply */
export const adminReplyToTicket = catchAsync(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) throw new AppError(httpStatus.BAD_REQUEST, "Message text is required");

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw new AppError(httpStatus.NOT_FOUND, "Ticket not found");

  ticket.messages.push({
    sender: req.user._id,
    senderRole: req.user.role === "staff" ? "staff" : "admin",
    text: text.trim(),
  });
  if (ticket.status === "open") ticket.status = "in_progress";
  await ticket.save();
  await ticket.populate(ticketPopulate);

  try {
    emitToUser(ticket.reporter.toString(), "ticket_message", {
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      message: `New reply on ticket ${ticket.ticketNumber}`,
    });
  } catch (e) { /* socket optional */ }

  res.status(httpStatus.OK).json({ success: true, data: ticket });
});
