import express from "express";
import { getActiveAddons } from "../controller/addon.controller.js";

const router = express.Router();

router.get("/", getActiveAddons);

export default router;
