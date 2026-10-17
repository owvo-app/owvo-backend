import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  createTicket,
  getMyTickets,
  getMyTicketById,
  replyToTicket,
} from "../controller/ticket.controller.js";

const router = express.Router();

router.post("/", protect, createTicket);
router.get("/", protect, getMyTickets);
router.get("/:id", protect, getMyTicketById);
router.post("/:id/messages", protect, replyToTicket);

export default router;
