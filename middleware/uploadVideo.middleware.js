import multer from "multer";
import path from "path";
import fs from "fs";
import AppError from "../errors/AppError.js";

/**
 * Training videos ke liye alag upload pipeline — asal `upload.middleware.js`
 * (images/PDF, 12MB limit) ko chhua nahi, taake normal user uploads par
 * koi asar na pare. Videos bari hoti hain isliye limit zyada hai.
 */
const uploadPath = "uploads/training";
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, fileName);
  },
});

const videoExtensions = new Set([".mp4", ".mov", ".webm", ".m4v"]);

const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const mimetype = (file.mimetype || "").toLowerCase();
  const isVideo = mimetype.startsWith("video/") || videoExtensions.has(extension);

  if (isVideo) {
    cb(null, true);
    return;
  }

  cb(new AppError(400, "Please upload a video file (mp4, mov, webm)."), false);
};

export const uploadVideo = multer({
  storage,
  fileFilter,
  // 300 MB — training videos honi chahiye chhoti (2-5 min), ye sirf
  // ek upar ki hadd hai taake galti se koi bohot bari file na chali jaye
  limits: { fileSize: 300 * 1024 * 1024 },
});