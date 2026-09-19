import express from "express";
import {
  createAdminPayout,
  createAdminCommissionWithdrawal,
  createStaffAccount,
  deleteStaffAccount,
  disableStaffAccount,
  getActivityLogs,
  getAdminBookingById,
  getAdminBookings,
  getAdminEarnings,
  getAdminMe,
  getAdminNotifications,
  getAdminPayments,
  getAdminPayouts,
  getAdminCommissionWithdrawals,
  getAdminReportPhoto,
  getAdminReports,
  getAdminServicesPricing,
  getDashboardOverview,
  getDashboardRevenue,
  getDashboardSettings,
  getAllCustomers,
  getProviderVerificationQueue,
  getRecentBookings,
  getStaffAccounts,
  getUpcomingBookings,
  getAllUsers,
  getAllProviders,
  getProviderAcceptanceHistory,
  resetProviderPolicyAcceptance,
  getAllTrainingModules,
  createTrainingModule,
  updateTrainingModule,
  replaceTrainingModuleVideo,
  reorderTrainingModules,
  deactivateTrainingModule,
  getTrainingCompletionOverview,
  resetProviderTraining,
  updateProviderVerificationDetails,
  getExpiringInsurance,
  sendVerificationReminder,
  changeUserRole,
  deleteUser,
  updateAdminBookingStatus,
  updateAdminPayoutStatus,
  updateAdminReportStatus,
  updateAdminCatalogService,
  updateAdminProviderService,
  updateAdminMe,
  updateDashboardSettings,
  updateProviderDailyWashLimit,
  updateProviderEnforcement,
  updateProviderVerification,
  updateStaffAccount,
  updateUserAccountStatus,
} from "../controller/admin.controller.js";
import { protect, isAdmin, isDashboardUser, hasDashboardMenu } from "../middleware/auth.middleware.js";
import { uploadVideo } from "../middleware/uploadVideo.middleware.js";
import {
  getAdminDataRequests,
  updateAdminDataRequest,
} from "../controller/dataRequest.controller.js";

const router = express.Router();

router.get("/me", protect, isDashboardUser, getAdminMe);
router.patch("/me", protect, isDashboardUser, updateAdminMe);

router.get("/dashboard/overview", protect, hasDashboardMenu("dashboard"), getDashboardOverview);
router.get("/dashboard/revenue", protect, hasDashboardMenu("dashboard"), getDashboardRevenue);
router.get("/dashboard/recent-bookings", protect, hasDashboardMenu("dashboard"), getRecentBookings);
router.get("/dashboard/upcoming-bookings", protect, hasDashboardMenu("dashboard"), getUpcomingBookings);

router.get("/bookings", protect, hasDashboardMenu("bookings"), getAdminBookings);
router.get("/bookings/:id", protect, hasDashboardMenu("bookings"), getAdminBookingById);
router.patch("/bookings/:id/status", protect, hasDashboardMenu("bookings"), updateAdminBookingStatus);

router.get("/reports", protect, hasDashboardMenu("reports"), getAdminReports);
router.get("/reports/:reportId/photo", protect, hasDashboardMenu("reports"), getAdminReportPhoto);
router.patch("/reports/:reportId/status", protect, isAdmin, updateAdminReportStatus);
router.get("/services-pricing", protect, hasDashboardMenu("reports"), getAdminServicesPricing);
router.patch("/services-pricing/catalog/:serviceId", protect, isAdmin, updateAdminCatalogService);
router.patch("/services-pricing/providers/:providerId/services/:serviceId", protect, isAdmin, updateAdminProviderService);
router.patch("/services-pricing/providers/:providerId/daily-wash-limit", protect, isAdmin, updateProviderDailyWashLimit);

router.get("/payments", protect, hasDashboardMenu("payouts-payments"), getAdminPayments);
router.get("/earnings", protect, hasDashboardMenu("earnings"), getAdminEarnings);
router.get("/payouts", protect, hasDashboardMenu("payouts-payments"), getAdminPayouts);
router.post("/payouts", protect, isAdmin, createAdminPayout);
router.patch("/payouts/:payoutId/status", protect, isAdmin, updateAdminPayoutStatus);
router.get("/commission-withdrawals", protect, hasDashboardMenu("payouts-payments"), getAdminCommissionWithdrawals);
router.post("/commission-withdrawals", protect, isAdmin, createAdminCommissionWithdrawal);

router.get("/notifications", protect, hasDashboardMenu("notifications"), getAdminNotifications);
router.get("/settings", protect, hasDashboardMenu("settings"), getDashboardSettings);
router.patch("/settings", protect, isAdmin, updateDashboardSettings);

router.get("/staff", protect, isAdmin, getStaffAccounts);
router.post("/staff", protect, isAdmin, createStaffAccount);
router.patch("/staff/:staffId", protect, isAdmin, updateStaffAccount);
router.patch("/staff/:staffId/disable", protect, isAdmin, disableStaffAccount);
router.delete("/staff/:staffId", protect, isAdmin, deleteStaffAccount);

router.get("/activity-logs", protect, hasDashboardMenu("system-logs"), getActivityLogs);
router.get("/data-requests", protect, hasDashboardMenu("data-requests"), getAdminDataRequests);
router.patch("/data-requests/:requestId", protect, isAdmin, updateAdminDataRequest);

router.get("/provider-verifications", protect, hasDashboardMenu("provider-verification"), getProviderVerificationQueue);
router.patch("/providers/:providerId/verification", protect, isAdmin, updateProviderVerification);
router.patch("/providers/:providerId/enforcement", protect, isAdmin, updateProviderEnforcement);

router.get("/users", protect, isAdmin, getAllUsers);
router.get("/customers", protect, hasDashboardMenu("customers"), getAllCustomers);
router.patch("/users/:userId/status", protect, isAdmin, updateUserAccountStatus);
router.patch("/users/:userId/role", protect, isAdmin, changeUserRole);
router.delete("/users/:userId", protect, isAdmin, deleteUser);
router.get("/providers", protect, hasDashboardMenu("washers"), getAllProviders);
router.get(
  "/providers/:id/acceptance-history",
  protect,
  hasDashboardMenu("washers"),
  getProviderAcceptanceHistory
);
router.patch(
  "/providers/:id/policy-acceptance/reset",
  protect,
  hasDashboardMenu("washers"),
  resetProviderPolicyAcceptance
);

// ─── Training Modules (Provider Academy) ──────────────────────────────────
router.get(
  "/training-modules",
  protect,
  hasDashboardMenu("washers"),
  getAllTrainingModules
);
router.post(
  "/training-modules",
  protect,
  hasDashboardMenu("washers"),
  uploadVideo.single("video"),
  createTrainingModule
);
router.patch(
  "/training-modules/reorder",
  protect,
  hasDashboardMenu("washers"),
  reorderTrainingModules
);
router.get(
  "/training-modules/completion-overview",
  protect,
  hasDashboardMenu("washers"),
  getTrainingCompletionOverview
);
router.patch(
  "/training-modules/:id",
  protect,
  hasDashboardMenu("washers"),
  updateTrainingModule
);
router.patch(
  "/training-modules/:id/replace-video",
  protect,
  hasDashboardMenu("washers"),
  uploadVideo.single("video"),
  replaceTrainingModuleVideo
);
router.delete(
  "/training-modules/:id",
  protect,
  hasDashboardMenu("washers"),
  deactivateTrainingModule
);
router.patch(
  "/providers/:id/training/reset",
  protect,
  hasDashboardMenu("washers"),
  resetProviderTraining
);

// ─── Provider Verification — extra fields ─────────────────────────────────
router.patch(
  "/providers/:id/verification-details",
  protect,
  hasDashboardMenu("washers"),
  updateProviderVerificationDetails
);
router.get(
  "/providers/insurance-expiring",
  protect,
  hasDashboardMenu("washers"),
  getExpiringInsurance
);
router.post(
  "/providers/:id/send-verification-reminder",
  protect,
  hasDashboardMenu("washers"),
  sendVerificationReminder
);

export default router;