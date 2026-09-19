import express from "express";
import {
  acceptWasherPolicies,
  acceptBooking,
  addPreferredService,
  completeWash,
  getAllWashers,
  getWasherAvailability,
  getWasherPolicyStatus,
  // ─── Provider Income ──────────────────────────────────────────────────────
  getDayIncomeProvider,
  // ─── Nearby Washers ───────────────────────────────────────────────────────
  getNearbyWashers,
  // ─── Preferred Services ───────────────────────────────────────────────────
  getPreferredServices,
  getWasherDetails,
  getWasherStatus,
  getWeeklyIncomeProvider,
  goOffline,
  goOnline,
  removePreferredService,
  submitTrainingCompletion,
  getTrainingModules,
  verifyPostcode,
  getMyNotifications,
  markAllNotificationsRead,
  getWalletSummary,
  getWalletPayouts,
  getWalletEarnings,
  emailWalletStatement,
  // ─── Location ─────────────────────────────────────────────────────────────
  updateWasherLocation,
  updateWasherAvailability,
} from "../controller/washer.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// ─── Public ───────────────────────────────────────────────────────────────────
router.get("/", protect, getAllWashers);

/**
 * GET /api/v1/washers/nearby
 * Query: latitude, longitude, radius (metres, default 5000), serviceId (optional)
 * Returns online washers sorted by distance (nearest first) using 2dsphere index.
 */
router.get("/nearby", protect, getNearbyWashers);

// ─── Authenticated ────────────────────────────────────────────────────────────
router.get("/status", protect, getWasherStatus);
router.get("/policies", protect, getWasherPolicyStatus);
router.post("/policies/accept", protect, acceptWasherPolicies);
router.post("/training/complete", protect, submitTrainingCompletion);
router.get("/training/modules", protect, getTrainingModules);
router.post("/verify-postcode", protect, verifyPostcode);
router.get("/notifications", protect, getMyNotifications);
router.patch("/notifications/read-all", protect, markAllNotificationsRead);
router.get("/wallet/summary", protect, getWalletSummary);
router.get("/wallet/payouts", protect, getWalletPayouts);
router.get("/wallet/earnings", protect, getWalletEarnings);
router.post("/wallet/email-statement", protect, emailWalletStatement);
router.get("/availability", protect, getWasherAvailability);
router.put("/availability", protect, updateWasherAvailability);
router.post("/online", protect, goOnline);
router.post("/offline", protect, goOffline);
router.post("/accept/:bookingId", protect, acceptBooking);
router.post("/complete/:bookingId", protect, completeWash);

/**
 * PATCH /api/v1/washers/location
 * Body: { latitude, longitude }
 * Updates the washer's current GPS location (GeoJSON Point).
 */
router.patch("/location", protect, updateWasherLocation);

/**
 * GET    /api/v1/washers/preferred-services   → list washer's preferred services
 * POST   /api/v1/washers/preferred-services   → add a service   { serviceId }
 * DELETE /api/v1/washers/preferred-services/:serviceId → remove a service
 */
router.get("/preferred-services", protect, getPreferredServices);
router.post("/preferred-services", protect, addPreferredService);
router.delete("/preferred-services/:serviceId", protect, removePreferredService);

/**
 * GET /api/v1/washers/income/today
 * Provider's earnings for today (current day only).
 * Query params:
 *   washerId (optional) - filter by specific provider (admin only)
 *   userId (optional)   - filter by specific customer
 */
router.get("/income/today", protect, getDayIncomeProvider);

/**
 * GET /api/v1/washers/income/weekly
 * Provider's earnings for the current week (Monday to Sunday).
 * Query params:
 *   washerId (optional) - filter by specific provider (admin only)
 *   userId (optional)   - filter by specific customer
 */
router.get("/income/weekly", protect, getWeeklyIncomeProvider);

/**
 * GET /api/v1/washers/:washerId/details
 * Washer profile + average rating + wash history for the requesting user.
 */
router.get("/:washerId/details", protect, getWasherDetails);


export default router;