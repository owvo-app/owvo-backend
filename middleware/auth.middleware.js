import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "./../model/user.model.js";
import catchAsync from "../utils/catch.Async.js";

export const protect = catchAsync(async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    throw new AppError(httpStatus.UNAUTHORIZED,"Token not found");
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  } catch (err) {
    throw new AppError(httpStatus.UNAUTHORIZED,"Invalid token");
  }

  const user = await User.findById(decoded._id);

  if (!user) {
    throw new AppError(httpStatus.UNAUTHORIZED,"User not found");
  }

  if (user.accountStatus === "disabled") {
    throw new AppError(httpStatus.FORBIDDEN, "Account access has been disabled");
  }

  // Customers redesign: suspended/banned customer ki har authenticated
  // request yahin rukti hai (nayi booking bhi isi protect se guzarti hai).
  if (
    user.role === "user" &&
    ["suspended", "banned"].includes(user.enforcement?.status)
  ) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      user.enforcement?.reason
        ? `Your account has been suspended: ${user.enforcement.reason}`
        : "Your account has been suspended. Please contact support."
    );
  }

  if (
    user.role === "provider" &&
    user.isOnline &&
    (user.adminVerification?.status !== "approved" ||
      ["suspended", "banned"].includes(user.enforcement?.status))
  ) {
    user.isOnline = false;
    user.isBusy = false;
    await user.save();
  }

  if (!(await User.isOTPVerified(user._id))) {
    throw new AppError(httpStatus.FORBIDDEN, "User not verified");
  }

  req.user = user;
  next();
})

export const isAdmin = catchAsync(async(req, res, next) => {
  if (req.user?.role !== "admin") {
    throw new AppError(403, "Access denied. You are not an admin.");
  }
  next();
})

export const isDashboardUser = catchAsync(async (req, res, next) => {
  if (!["admin", "staff"].includes(req.user?.role)) {
    throw new AppError(403, "Access denied. Dashboard access only.");
  }
  next();
})

export const isAdminOrStaff = isDashboardUser;

export const hasDashboardMenu = (menuKey) =>
  catchAsync(async (req, res, next) => {
    if (req.user?.role === "admin") {
      next();
      return;
    }

    if (req.user?.role !== "staff") {
      throw new AppError(403, "Access denied. Dashboard access only.");
    }

    const menus = req.user?.staffPermissions?.menus || [];
    if (!menus.includes(menuKey)) {
      throw new AppError(403, "Access denied for this dashboard section.");
    }

    next();
  })

export const isProvider =catchAsync(async (req, res, next) => {
  if (req.user?.role !== "provider") {
    throw new AppError(403,"Access denied. You are not a provider.");
  }
  next();
})
