import httpStatus from "http-status";
import { ActivityLog } from "../model/activityLog.model.js";
import { Booking } from "../model/booking.model.js";
import { DataRequest } from "../model/dataRequest.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { SupportTicket } from "../model/supportTicket.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";

// Admin Notifications feed v2.
//
// The old feed (admin.controller getAdminNotifications) only mixed
// bookings, legacy issue reports, payments and logs, eight of each, so
// support tickets and GDPR data requests never reached the admin's
// notification page at all. This feed keeps those sources, replaces the
// retired IssueReport source with real SupportTickets, adds DataRequests,
// and supports a type filter plus real pagination.
//
// Each item carries a `link` to the page where the admin can act on it.

const FEED_TYPES = ["booking", "payment", "support", "data_request", "system"];
const POOL_PER_SOURCE = 200;
const DUE_MS = 30 * 24 * 60 * 60 * 1000;

const labelFromValue = (value, fallback = "general") =>
  String(value || fallback)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const shortId = (value) =>
  value?.toString?.().slice(-6).toUpperCase() || "UNKNOWN";

const rangeStart = (range) => {
  const now = Date.now();
  if (range === "daily") return new Date(now - 24 * 60 * 60 * 1000);
  if (range === "weekly") return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (range === "monthly") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  if (range === "yearly") return new Date(now - 365 * 24 * 60 * 60 * 1000);
  return null; // "all" or anything else = no lower bound
};

export const getAdminNotificationsFeed = catchAsync(async (req, res) => {
  const typeParam = req.query.type?.toString();
  const type = FEED_TYPES.includes(typeParam) ? typeParam : "all";
  const page = Math.max(
    1,
    Number.parseInt(req.query.page?.toString() || "1", 10) || 1
  );
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(req.query.limit?.toString() || "20", 10) || 20)
  );
  const start = rangeStart(req.query.range?.toString());
  const createdFilter = start ? { createdAt: { $gte: start } } : {};
  const updatedFilter = start ? { updatedAt: { $gte: start } } : {};
  const want = (t) => type === "all" || type === t;

  const [
    bookingCount,
    paymentCount,
    ticketCount,
    dataRequestCount,
    logCount,
    bookings,
    payments,
    tickets,
    dataRequests,
    logs,
  ] = await Promise.all([
    Booking.countDocuments(updatedFilter),
    paymentInfo.countDocuments(createdFilter),
    SupportTicket.countDocuments(createdFilter),
    DataRequest.countDocuments(createdFilter),
    ActivityLog.countDocuments({
      ...createdFilter,
      entityType: { $nin: ["DataRequest", "SupportTicket"] },
    }),
    want("booking")
      ? Booking.find(updatedFilter)
          .select("_id status createdAt updatedAt")
          .sort({ updatedAt: -1 })
          .limit(POOL_PER_SOURCE)
          .lean()
      : [],
    want("payment")
      ? paymentInfo
          .find(createdFilter)
          .select("_id status type price currency createdAt")
          .sort({ createdAt: -1 })
          .limit(POOL_PER_SOURCE)
          .lean()
      : [],
    want("support")
      ? SupportTicket.find(createdFilter)
          .select("_id ticketNumber subject status priority createdAt updatedAt")
          .sort({ updatedAt: -1 })
          .limit(POOL_PER_SOURCE)
          .lean()
      : [],
    want("data_request")
      ? DataRequest.find(createdFilter)
          .select("_id requesterRole status dueAt createdAt updatedAt")
          .sort({ updatedAt: -1 })
          .limit(POOL_PER_SOURCE)
          .lean()
      : [],
    want("system")
      ? ActivityLog.find({
          ...createdFilter,
          entityType: { $nin: ["DataRequest", "SupportTicket"] },
        })
          .select("_id action entityType createdAt")
          .sort({ createdAt: -1 })
          .limit(POOL_PER_SOURCE)
          .lean()
      : [],
  ]);

  const typeCounts = {
    booking: bookingCount,
    payment: paymentCount,
    support: ticketCount,
    data_request: dataRequestCount,
    system: logCount,
  };
  typeCounts.all =
    bookingCount + paymentCount + ticketCount + dataRequestCount + logCount;

  const now = Date.now();
  const items = [
    ...bookings.map((booking) => ({
      id: `booking-${booking._id}`,
      type: "booking",
      title: "Booking activity",
      message: `Booking #${shortId(booking._id)} is ${labelFromValue(booking.status, "updated")}`,
      createdAt: booking.updatedAt || booking.createdAt,
      severity: booking.status === "cancelled" ? "warning" : "info",
      link: "/bookings",
      entityId: booking._id.toString(),
    })),
    ...payments.map((payment) => ({
      id: `payment-${payment._id}`,
      type: "payment",
      title: "Payment activity",
      message: `${labelFromValue(payment.type, "booking")} payment ${labelFromValue(payment.status, "updated")} for ${payment.currency || "GBP"} ${Number(payment.price || 0).toFixed(2)}`,
      createdAt: payment.createdAt,
      severity:
        payment.status === "failed"
          ? "danger"
          : payment.status === "success" || payment.status === "paid"
            ? "success"
            : "info",
      link: "/payments",
      entityId: payment._id.toString(),
    })),
    ...tickets.map((ticket) => ({
      id: `support-${ticket._id}`,
      type: "support",
      title: "Support ticket",
      message: `#${ticket.ticketNumber || shortId(ticket._id)} — ${ticket.subject || "Ticket"} (${labelFromValue(ticket.status, "open")})`,
      createdAt: ticket.updatedAt || ticket.createdAt,
      severity:
        ticket.status === "open" && ticket.priority === "high"
          ? "danger"
          : ticket.status === "open"
            ? "warning"
            : ticket.status === "resolved"
              ? "success"
              : "info",
      link: "/support-disputes",
      entityId: ticket._id.toString(),
    })),
    ...dataRequests.map((request) => {
      const role = request.requesterRole === "provider" ? "provider" : "customer";
      const dueAt = request.dueAt
        ? new Date(request.dueAt).getTime()
        : new Date(request.createdAt).getTime() + DUE_MS;
      const overdue = request.status === "pending" && dueAt < now;
      return {
        id: `data-request-${request._id}`,
        type: "data_request",
        title: "Data request",
        message:
          request.status === "pending"
            ? `A ${role} data request is waiting for review.${overdue ? " It is past its 30-day due date." : ""}`
            : `A ${role} data request was ${request.status}.`,
        createdAt: request.updatedAt || request.createdAt,
        severity:
          request.status === "pending"
            ? overdue
              ? "danger"
              : "warning"
            : request.status === "approved"
              ? "success"
              : "info",
        link: "/data-requests",
        entityId: request._id.toString(),
      };
    }),
    ...logs.map((log) => ({
      id: `system-${log._id}`,
      type: "system",
      title: "System log",
      message: `${labelFromValue(log.action, "activity")} on ${labelFromValue(log.entityType, "system")}`,
      createdAt: log.createdAt,
      severity: "info",
      link: "/system-logs",
      entityId: log._id.toString(),
    })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = type === "all" ? typeCounts.all : typeCounts[type] || 0;
  const paged = items.slice((page - 1) * limit, page * limit);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notifications fetched successfully.",
    data: { items: paged, total, page, limit, typeCounts },
  });
});
