import express from "express";
import {
  addVehicle,
  deleteVehicle,
  getMyVehicles,
  getVehicleById,
  setDefaultVehicle,
  updateVehicle,
} from "../controller/vehicle.controller.js";
import {
  addDvlaVehicle,
  lookupVehicleByRegistration,
} from "../controller/dvlaVehicle.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";

const router = express.Router();

router.get("/", protect, getMyVehicles);
router.post("/lookup", protect, lookupVehicleByRegistration);
router.post("/dvla", protect, addDvlaVehicle);
router.post(
  "/",
  protect,
  upload.fields([
    { name: "vehicleImage", maxCount: 1 },
    { name: "vehicle image", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  addVehicle
);
router.get("/:id", protect, getVehicleById);
router.patch("/:id", protect, updateVehicle);
router.delete("/:id", protect, deleteVehicle);
router.patch("/:id/default", protect, setDefaultVehicle);

export default router;
