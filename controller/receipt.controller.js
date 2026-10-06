import httpStatus from "http-status";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import AppError from "../errors/AppError.js";
import { Receipt } from "../model/receipt.model.js";
import { Booking } from "../model/booking.model.js";

const calcTax = (subtotal, taxRate = 0) => {
  const tax = (subtotal * taxRate) / 100;
  return Math.max(0, Number(tax.toFixed(2)));
};

const makeReceiptNo = () => {
  const now = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RCPT-${now}-${rand}`;
};

export const generateReceipt = catchAsync(async (req, res) => {
  const { bookingId } = req.body;

  if (!bookingId) {
    throw new AppError(httpStatus.BAD_REQUEST, "bookingId is required");
  }

  const booking = await Booking.findById(bookingId);

  if (!booking) throw new AppError(httpStatus.NOT_FOUND, "Booking not found");

  if (booking.status !== "completed") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Receipt can be generated only after booking is completed"
    );
  }

  const existing = await Receipt.findOne({ booking: booking._id });
  if (existing) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Receipt already exists",
      data: existing,
    });
  }

  const subtotal =
    Number(booking.price || 0) + Number(booking.addonsTotal || 0);
  const discount = Number(booking.discountPrice || 0);

  const afterDiscount = Math.max(0, subtotal - discount);
  const taxRate = 0;
  const tax = calcTax(afterDiscount, taxRate);

  const total = Math.max(0, afterDiscount + tax);

  const receipt = await Receipt.create({
    booking: booking._id,
    user: booking.user,
    provider: booking.provider,
    service: booking.service,

    subtotal,
    discount,
    tax,
    total,

    currency: booking.currency || "GBP",
    receiptNo: makeReceiptNo(),
    barcode: `BK-${String(booking._id)}`,
    issuedAt: new Date(),
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Receipt generated successfully",
    data: receipt,
  });
});

export const getReceiptByBooking = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const { bookingId } = req.params;

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new AppError(httpStatus.NOT_FOUND, "Booking not found");

  const isOwner = String(booking.user) === String(userId);
  const isProvider = String(booking.provider) === String(userId);
  const isAdmin = req.user?.role === "admin";

  if (!isOwner && !isProvider && !isAdmin) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  const receipt = await Receipt.findOne({ booking: bookingId })
    .populate("user", "name fullName email")
    .populate("provider", "name fullName email")
    .populate("service", "name title price");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: receipt || null,
  });
});
