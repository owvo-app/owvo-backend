import express from "express";
import {
  createBooking,
  getSingleBooking,
  getUserBookings,
  getProviderBookings,
  updateBookingStatus,
  cancelBooking,
  rebookBooking,
  updateCustomerLocation,
} from "../controller/booking.controller.js";

import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/", protect, createBooking);
router.get("/my-bookings", protect, getUserBookings);
router.get("/provider-bookings", protect, getProviderBookings);
router.post("/:id/rebook", protect, rebookBooking);
router.patch("/:id/status", protect, updateBookingStatus);
router.patch("/:id/cancel", protect, cancelBooking);
router.patch("/:id/customer-location", protect, updateCustomerLocation);
router.get("/:id", protect, getSingleBooking);


export default router;
