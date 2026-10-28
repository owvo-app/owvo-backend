import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Booking } from "../model/booking.model.js";
import { ChatMessage } from "../model/chatMessage.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { uploadOnCloudinary } from "../utils/common.Method.js";
import { emitToUser, isUserConnected } from "../socket/socket.js";


const toMessagePayload = (message) => ({
  id: message._id?.toString(),
  bookingId: message.booking?.toString(),
  senderId: message.sender?._id?.toString() || message.sender?.toString(),
  senderName: message.sender?.name || "",
  recipientId:
    message.recipient?._id?.toString() || message.recipient?.toString(),
  recipientName: message.recipient?.name || "",
  text: message.text,
  attachment: message.attachment?.url
    ? {
        url: message.attachment.url,
        type: message.attachment.type,
        name: message.attachment.name,
        mimeType: message.attachment.mimeType,
        size: message.attachment.size,
      }
    : null,
  createdAt: message.createdAt,
});

export const getBookingMessages = catchAsync(async (req, res) => {
  const { bookingId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid bookingId");
  }

  const booking = await Booking.findById(bookingId).select("user provider");
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  const requesterId = req.user._id.toString();
  const isParticipant =
    booking.user.toString() === requesterId ||
    booking.provider.toString() === requesterId;

  if (!isParticipant && req.user.role !== "admin") {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  const messages = await ChatMessage.find({ booking: booking._id })
    .populate("sender", "name email photo")
    .populate("recipient", "name email photo")
    .sort({ createdAt: 1 })
    .lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Chat messages fetched successfully",
    data: messages.map(toMessagePayload),
  });
});

export const sendAttachmentMessage = catchAsync(async (req, res) => {
  const { bookingId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid bookingId");
  }

  const booking = await Booking.findById(bookingId).select("user provider");
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  const senderId = req.user._id.toString();
  const customerId = booking.user.toString();
  const providerId = booking.provider.toString();

  if (senderId !== customerId && senderId !== providerId) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }
  const recipientId = senderId === customerId ? providerId : customerId;

  const file = req.file;
  if (!file) {
    throw new AppError(httpStatus.BAD_REQUEST, "Please attach a file");
  }

  const uploaded = await uploadOnCloudinary(file.path, "chat");
  if (!uploaded?.secure_url) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "File upload failed. Please try again."
    );
  }

  const isImage = (file.mimetype || "").startsWith("image/");
  const caption = (req.body?.text || "").toString().trim().slice(0, 2000);

  const doc = await ChatMessage.create({
    booking: bookingId,
    sender: senderId,
    recipient: recipientId,
    participants: [senderId, recipientId],
    text: caption,
    attachment: {
      url: uploaded.secure_url,
      type: isImage ? "image" : "file",
      name: file.originalname || "",
      mimeType: file.mimetype || "",
      size: file.size || 0,
    },
  });

  const payload = {
    id: doc._id.toString(),
    bookingId: doc.booking.toString(),
    senderId,
    recipientId,
    text: doc.text,
    attachment: {
      url: doc.attachment.url,
      type: doc.attachment.type,
      name: doc.attachment.name,
      mimeType: doc.attachment.mimeType,
      size: doc.attachment.size,
    },
    createdAt: doc.createdAt.toISOString(),
  };

  // Live: dono taraf socket se bhej do (bilkul text message ki tarah)
  emitToUser(recipientId, "chat_message", payload);
  emitToUser(senderId, "chat_message", payload);

  // Push: recipient offline ho to
  if (!isUserConnected(recipientId)) {
    try {
      const { User } = await import("../model/user.model.js");
      const { notifyUser } = await import("../utils/fcm.util.js");
      const sender = await User.findById(senderId).select("name").lean();
      notifyUser(recipientId, {
        title: `New message from ${sender?.name || "Owvo"}`,
        body: caption || (isImage ? "📎 Photo" : `📎 File: ${file.originalname || "attachment"}`),
        data: { type: "chat_message", bookingId, senderId },
      });
    } catch (e) {
      // push fail ho jaye to message phir bhi gaya hua hy — ignore
    }
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Attachment sent successfully",
    data: payload,
  });
});
