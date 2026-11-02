import express from "express";
import {
  createPayment,
  confirmPayment,
  stripeWebhook,
  getMyWallet,
  getMyWalletTransactions,
  createWalletTopup,
  createRefundRequest,
  getMyRefundRequests,
  createCardSetup,
  getMyCards,
  deleteMyCard,
  setDefaultCard,
} from "../controller/payment.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// Stripe webhook must receive the raw body. The raw parser is mounted in server.js.
router.post("/webhook/stripe", stripeWebhook);

// Create Payment
router.post("/create-payment", protect, createPayment);

// Capture Payment
router.post("/confirm-payment", protect, confirmPayment);

// Customer wallet (Payments phase)
router.get("/wallet", protect, getMyWallet);
router.get("/wallet/transactions", protect, getMyWalletTransactions);
router.post("/wallet/topup", protect, createWalletTopup);

// Saved cards (Stripe SetupIntent se save hote hain)
router.post("/cards/setup", protect, createCardSetup);
router.get("/cards", protect, getMyCards);
router.delete("/cards/:paymentMethodId", protect, deleteMyCard);
router.post("/cards/:paymentMethodId/default", protect, setDefaultCard);

// Customer refund requests
router.post("/refund-request", protect, createRefundRequest);
router.get("/my-refunds", protect, getMyRefundRequests);

export default router;
