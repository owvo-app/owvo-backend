import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Booking } from "../model/booking.model.js";
import { ChatMessage } from "../model/chatMessage.model.js";
import { corsOriginDelegate } from "../utils/allowedOrigins.util.js";

let io;

// userId -> Set<socketId>. Multiple live sockets can exist during reconnects.
const connectedUsers = new Map();
const isProductionRuntime = () =>
  process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

const socketDebugLog = (...args) => {
  if (!isProductionRuntime()) {
    console.log(...args);
  }
};

const socketErrorLog = (...args) => {
  if (!isProductionRuntime()) {
    console.error(...args);
  }
};

const normalizeUserId = (userId) =>
  userId === undefined || userId === null ? "" : userId.toString().trim();

const getHandshakeUserId = (socket) =>
  normalizeUserId(
    socket.handshake.auth?.userId ||
      socket.handshake.query?.userId ||
      socket.handshake.headers?.userid ||
      socket.handshake.headers?.userId
  );

const getHandshakeToken = (socket) => {
  const authToken =
    socket.handshake.auth?.token ||
    socket.handshake.auth?.accessToken ||
    socket.handshake.query?.token;
  if (authToken) return authToken.toString();

  const header = socket.handshake.headers?.authorization || "";
  if (header.toString().startsWith("Bearer ")) {
    return header.toString().slice(7).trim();
  }

  return "";
};

const addSocketForUser = (userId, socket) => {
  const key = normalizeUserId(userId);
  if (!key) return 0;

  const previousUserId = socket.data.userId;
  if (previousUserId && previousUserId !== key) {
    removeSocketForUser(previousUserId, socket.id);
    socket.leave(previousUserId);
  }

  const sockets = connectedUsers.get(key) || new Set();
  sockets.add(socket.id);
  connectedUsers.set(key, sockets);
  socket.data.userId = key;
  socket.join(key);
  return sockets.size;
};

const removeSocketForUser = (userId, socketId) => {
  const key = normalizeUserId(userId);
  const sockets = connectedUsers.get(key);

  if (!sockets) {
    return 0;
  }

  sockets.delete(socketId);
  if (sockets.size === 0) {
    connectedUsers.delete(key);
  }

  return sockets.size;
};

const authenticateSocket = (socket, next) => {
  const token = getHandshakeToken(socket);
  if (!token) {
    next(new Error("Socket authentication required"));
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const authenticatedUserId = normalizeUserId(decoded?._id);
    const requestedUserId = getHandshakeUserId(socket);

    if (!authenticatedUserId) {
      next(new Error("Invalid socket token"));
      return;
    }

    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      next(new Error("Socket user mismatch"));
      return;
    }

    socket.data.userId = authenticatedUserId;
    socket.data.role = decoded?.role || "";
    next();
  } catch {
    next(new Error("Invalid socket token"));
  }
};

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: corsOriginDelegate,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const socketCount = addSocketForUser(socket.data.userId, socket);
    socketDebugLog(
      `Socket connected | userId=${socket.data.userId} socketId=${socket.id} sockets=${socketCount}`
    );

    socket.on("register", (payload = {}) => {
      const requestedUserId = normalizeUserId(payload.userId);
      if (requestedUserId && requestedUserId !== socket.data.userId) return;

      const count = addSocketForUser(socket.data.userId, socket);
      socketDebugLog(
        `Socket registered | userId=${socket.data.userId} socketId=${socket.id} sockets=${count}`
      );
    });

    socket.on("ping", () => socket.emit("pong"));

    socket.on("chat_message", async (payload = {}, ack) => {
      const senderId = normalizeUserId(socket.data.userId);
      const recipientId = normalizeUserId(
        payload.recipientId || payload.providerId || payload.userId
      );
      const text = (payload.text || payload.message || "").toString().trim();
      const bookingId = normalizeUserId(payload.bookingId);

      if (!senderId || !recipientId || !text) return;

      let message = {
        id: payload.id || `${Date.now()}-${socket.id}`,
        bookingId,
        senderId,
        recipientId,
        text,
        createdAt: new Date().toISOString(),
      };

      if (
        mongoose.Types.ObjectId.isValid(bookingId) &&
        mongoose.Types.ObjectId.isValid(senderId) &&
        mongoose.Types.ObjectId.isValid(recipientId)
      ) {
        try {
          const booking = await Booking.findById(bookingId)
            .select("user provider")
            .lean();

          const participants = booking
            ? [booking.user.toString(), booking.provider.toString()]
            : [];

          if (
            !booking ||
            !participants.includes(senderId) ||
            !participants.includes(recipientId)
          ) {
            if (typeof ack === "function") {
              ack({ success: false, message: "Invalid chat participants" });
            }
            return;
          }

          const doc = await ChatMessage.create({
            booking: bookingId,
            sender: senderId,
            recipient: recipientId,
            participants: [senderId, recipientId],
            text,
          });

          message = {
            id: doc._id.toString(),
            bookingId: doc.booking.toString(),
            senderId: doc.sender.toString(),
            recipientId: doc.recipient.toString(),
            text: doc.text,
            createdAt: doc.createdAt.toISOString(),
          };
        } catch (error) {
          socketErrorLog("Failed to persist chat message", error?.message || error);
        }
      }

      emitToUser(recipientId, "chat_message", message);
      emitToUser(senderId, "chat_message", message);

      // 🔔 Push: new chat message → recipient (skip if they're in the app)
      if (!isUserConnected(recipientId)) {
        try {
          const { User } = await import("../model/user.model.js");
          const { notifyUser } = await import("../utils/fcm.util.js");
          const sender = await User.findById(senderId)
            .select("name")
            .lean();
          const preview =
            text.length > 80 ? `${text.slice(0, 80)}…` : text;
          notifyUser(recipientId, {
            title: `New message from ${sender?.name || "Owvo"}`,
            body: preview,
            data: {
              type: "chat_message",
              bookingId: bookingId || "",
              senderId,
            },
          });
        } catch (e) {
          socketErrorLog("chat push failed", e?.message || e);
        }
      }

      if (typeof ack === "function") {
        ack({ success: true, data: message });
      }
    });

    socket.on("disconnect", (reason) => {
      const userId = socket.data.userId;
      if (userId) {
        const socketCount = removeSocketForUser(userId, socket.id);
        socketDebugLog(
          `Socket disconnected | userId=${userId} socketId=${socket.id} remaining=${socketCount} reason=${reason}`
        );
      }
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialised - call initSocket first.");
  return io;
};

export const emitToUser = (userId, event, data) => {
  if (!io) return;

  const key = normalizeUserId(userId);
  const socketIds = connectedUsers.get(key);
  if (socketIds?.size) {
    socketIds.forEach((socketId) => io.to(socketId).emit(event, data));
    socketDebugLog(`Emitted [${event}] -> userId=${key} sockets=${socketIds.size}`);
  } else {
    socketDebugLog(`[${event}] user ${key} is not connected via socket`);
  }
};

export const broadcast = (event, data) => {
  if (!io) return;
  io.emit(event, data);
};

/** True when the user has at least one active socket connection. */
export const isUserConnected = (userId) => {
  const key = normalizeUserId(userId);
  return !!connectedUsers.get(key)?.size;
};

export default { initSocket, getIO, emitToUser, broadcast };

