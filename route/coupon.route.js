import express from "express";
import {
  createCoupon,
  getAllCoupons,
  applyCoupon,
} from "../controller/coupon.controller.js";
import { protect, isAdminOrStaff } from "../middleware/auth.middleware.js";

const router = express.Router();

// SECURITY FIX (2026-10-06): coupon create/list were public — anyone could
// mint 100%-off coupons. Admin dashboard only now.
router.post("/create", protect, isAdminOrStaff, createCoupon);
router.get("/", protect, isAdminOrStaff, getAllCoupons);
// Customers apply coupons at booking time — stays public.
router.post("/apply", applyCoupon);

export default router;
