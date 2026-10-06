import express from "express";
import {
  changePassword,
  getBankDetails,
  getProfile,
  removeFcmToken,
  saveFcmToken,
  updateBankDetails,
  updateIdentityInfo,
  updateProfile,
  uploadIdentityIdFile,
  getUserActivity
} from "../controller/user.controller.js";
import {
  createDataRequest,
  deleteMyAccount,
  getMyDataRequests,
} from "../controller/dataRequest.controller.js";

import { protect } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js"; 

const router = express.Router();

const groupUploadedFilesByField = (req, res, next) => {
  if (Array.isArray(req.files)) {
    req.files = req.files.reduce((groupedFiles, file) => {
      if (!groupedFiles[file.fieldname]) groupedFiles[file.fieldname] = [];
      groupedFiles[file.fieldname].push(file);
      return groupedFiles;
    }, {});
  }

  next();
};
router.get("/profile", protect, getProfile);
router.put(
  "/profile",
  protect,
  upload.any(),
  groupUploadedFilesByField,
  updateProfile
);
router.put("/identity",protect,upload.array("idFiles", 5),updateIdentityInfo);
router.put("/password", protect, changePassword);
router.put("/identity/upload-id",protect,upload.array("idFile", 5),uploadIdentityIdFile);
router.get("/bank", protect, getBankDetails);
router.put("/bank", protect, updateBankDetails);
router.get("/activity", protect, getUserActivity);
router.post("/fcm-token", protect, saveFcmToken);
router.delete("/fcm-token", protect, removeFcmToken);
router.post("/data-requests", protect, createDataRequest);
router.get("/data-requests", protect, getMyDataRequests);
router.delete("/account", protect, deleteMyAccount);


export default router;



