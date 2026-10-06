import express from "express";

import userRoute from "../route/user.route.js";
import authRoute from "../route/auth.route.js";
import couponRoute from "../route/coupon.route.js";
import washerRoutes from "../route/washer.route.js";
import serviceRoutes from "../route/service.route.js";
import bookingRoutes from "../route/booking.route.js"; 
import adminRoutes from "../route/admin.route.js";
import vehicleRoutes from "../route/vehicle.routes.js";
import receiptRoutes from "../route/receipt.route.js";
import ratingRoutes from "../route/rating.route.js";
import paymentRoutes from "../route/payment.route.js";
import chatRoutes from "../route/chat.route.js";
import userRatingRoutes from "../route/userRating.route.js";
import issueReportRoutes from "../route/issueReport.route.js";
import addonRoutes from "../route/addon.route.js";

const router = express.Router();

router.use("/user", userRoute);
router.use("/auth", authRoute);
router.use("/coupon", couponRoute);
router.use("/washers", washerRoutes);
router.use("/services", serviceRoutes);
router.use("/bookings", bookingRoutes); 
router.use("/payment", paymentRoutes); 
router.use("/admin",adminRoutes);
router.use("/vehicle",vehicleRoutes);
router.use("/receipt", receiptRoutes);
router.use("/rating", ratingRoutes);
router.use("/chat", chatRoutes);
router.use("/user-rating", userRatingRoutes);
router.use("/reports", issueReportRoutes);
router.use("/addons", addonRoutes);

export default router;
