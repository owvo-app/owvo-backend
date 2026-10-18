import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  getProviderOpportunities,
  claimBonus,
} from "../controller/opportunity.controller.js";

const router = express.Router();

router.get("/", protect, getProviderOpportunities);
router.post("/:id/claim", protect, claimBonus);

export default router;
