import express from "express";
import {
  getBookingMessages,
  sendAttachmentMessage,
} from "../controller/chat.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";

const router = express.Router();

router.get("/booking/:bookingId/messages", protect, getBookingMessages);
router.post(
  "/booking/:bookingId/messages/attachment",
  protect,
  upload.single("document"),
  sendAttachmentMessage
);

export default router;