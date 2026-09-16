import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import {
  createToken,
  getAccessTokenExpiresIn,
  getRefreshTokenExpiresIn,
  verifyToken,
} from "../utils/authToken.js";
import catchAsync from "../utils/catch.Async.js";
import { generateOTP } from "../utils/common.Method.js";
import { recordActivity } from "../utils/activityLog.util.js";
import { sendEmail } from "../utils/sendEmail.js";
import sendResponse from "../utils/sendResponse.js";
import { User } from "./../model/user.model.js";


const generateVerificationCode = () => {
  return Math.floor(1000 + Math.random() * 9000);
};

const normalizeEmail = (email) => email?.toString().trim().toLowerCase();

const getSafeUser = (user) => {
  const userObj = user.toObject ? user.toObject() : { ...user };
  delete userObj.password;
  delete userObj.refreshToken;
  delete userObj.password_reset_token;
  return userObj;
};

const getAuthResponseData = (user, accessToken, refreshToken) => ({
  user: getSafeUser(user),
  accessToken,
  refreshToken,
  role: user.role,
  _id: user._id,
});

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
const loginAttemptStore = new Map();

const getLoginAttempt = (email) => {
  const attempt = loginAttemptStore.get(email);
  if (!attempt) return { count: 0, firstFailedAt: Date.now() };

  if (Date.now() - attempt.firstFailedAt > LOGIN_LOCK_WINDOW_MS) {
    loginAttemptStore.delete(email);
    return { count: 0, firstFailedAt: Date.now() };
  }

  return attempt;
};

const assertLoginNotLocked = (email) => {
  const attempt = getLoginAttempt(email);
  if (attempt.count >= MAX_FAILED_LOGIN_ATTEMPTS) {
    throw new AppError(
      429,
      "Too many failed login attempts. Please try again after 15 minutes."
    );
  }
};

const recordFailedLogin = (email) => {
  const attempt = getLoginAttempt(email);
  loginAttemptStore.set(email, {
    count: attempt.count + 1,
    firstFailedAt: attempt.firstFailedAt || Date.now(),
  });
};

const clearFailedLogin = (email) => {
  loginAttemptStore.delete(email);
};

export const register = catchAsync(async (req, res) => {
  const { email, password, confirmPassword, role, firstName, lastName, name } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const normalizedFirstName = firstName?.toString().trim() || "";
  const normalizedLastName = lastName?.toString().trim() || "";
  const normalizedName =
    name?.toString().trim() ||
    [normalizedFirstName, normalizedLastName].filter(Boolean).join(" ");

 
  if (!normalizedEmail || !password || !confirmPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Please fill in all required fields"
    );
  }

  if (password !== confirmPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Password and confirm password do not match"
    );
  }

 
  const checkUser = await User.findOne({ email: normalizedEmail });
  if (checkUser) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Email already exists, please try another email"
    );
  }

  
  const allowedRoles = ["user", "provider"];
  const assignedRole = allowedRoles.includes(role) ? role : "user";

  
  const user = new User({
    email: normalizedEmail,
    password,
    role: assignedRole,
    name: normalizedName,
    verificationInfo: { token: "", verified: true },
  });

  
  const jwtPayload = {
    _id: user._id,
    email: user.email,
    role: user.role,
  };

  
  const accessToken = createToken(
    jwtPayload,
    process.env.JWT_ACCESS_SECRET,
    getAccessTokenExpiresIn()
  );

  const refreshToken = createToken(
    jwtPayload,
    process.env.JWT_REFRESH_SECRET,
    getRefreshTokenExpiresIn()
  );

  user.refreshToken = refreshToken;
  await user.save();

  
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "User registered successfully",
    data: getAuthResponseData(user, accessToken, refreshToken),
  });
});


export const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Email and password are required"
    );
  }

  assertLoginNotLocked(normalizedEmail);

  const user = await User.isUserExistsByEmail(normalizedEmail);
  if (!user) {
    recordFailedLogin(normalizedEmail);
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }
  if (normalizeEmail(user.email) !== normalizedEmail) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Authenticated account does not match requested email"
    );
  }
  if (!user.password || !(await User.isPasswordMatched(password, user.password))) {
    recordFailedLogin(normalizedEmail);
    throw new AppError(httpStatus.FORBIDDEN, "Password is not correct");
  }
  clearFailedLogin(normalizedEmail);
  if (!(await User.isOTPVerified(user._id))) {
    const otp = generateOTP();
    const jwtPayloadOTP = {
      otp: otp,
    };

    const otptoken = createToken(
      jwtPayloadOTP,
      process.env.OTP_SECRET,
      process.env.OTP_EXPIRE
    );
    user.verificationInfo.token = otptoken;
    await user.save();
    await sendEmail(user.email, "Registerd Account", `Your OTP is ${otp}`);

    return sendResponse(res, {
      statusCode: httpStatus.FORBIDDEN,
      success: false,
      message: "OTP is not verified, please verify your OTP",
      data: { email: user.email },
    });
  }
  const jwtPayload = {
    _id: user._id,
    email: user.email,
    role: user.role,
  };
  const accessToken = createToken(
    jwtPayload,
    process.env.JWT_ACCESS_SECRET,
    getAccessTokenExpiresIn()
  );

  const refreshToken = createToken(
    jwtPayload,
    process.env.JWT_REFRESH_SECRET,
    getRefreshTokenExpiresIn()
  );

  user.refreshToken = refreshToken;
  await user.save();

  if (["admin", "staff"].includes(user.role)) {
    await recordActivity({
      req: { ...req, user },
      action: "dashboard.login",
      entityType: "user",
      entityId: user._id,
      metadata: { email: user.email, role: user.role },
    });
  }

  res.cookie("refreshToken", refreshToken, {
    secure: true,
    httpOnly: true,
    sameSite: "none",
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User Logged in successfully",
    data: getAuthResponseData(user, accessToken, refreshToken),
  });
});

export const forgetPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email);

  const user = await User.isUserExistsByEmail(normalizedEmail);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  const otp = generateOTP();
  const otpPayload = { otp };
  const otpToken = createToken(
    otpPayload,
    process.env.OTP_SECRET,
    process.env.OTP_EXPIRE
  );

  user.password_reset_token = otpToken;
  await user.save();

  await sendEmail(user.email, "Reset Password", `Your OTP is ${otp}`);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to your email successfully",
    data: null,
  });
});

export const resetPassword = catchAsync(async (req, res) => {
  const { email, otp, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  const user = await User.isUserExistsByEmail(normalizedEmail);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (!user.password_reset_token) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Password reset token is invalid or expired"
    );
  }

  let decoded;
  try {
    decoded = verifyToken(user.password_reset_token, process.env.OTP_SECRET);
  } catch (err) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP expired or invalid");
  }

  if (decoded.otp != otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid OTP");
  }

  user.password = password;
  user.password_reset_token = undefined;
  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password reset successfully",
    data: null,
  });
});

export const verifyOTP = catchAsync(async (req, res, next) => {
  const { email, otp } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !otp) {
    return next(new AppError(400, "Email and OTP are required"));
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return next(new AppError(404, "User not found"));
  }

  if (
    !user.resetPasswordOTP ||
    !user.resetPasswordOTPExpiry ||
    user.resetPasswordOTP != otp ||
    user.resetPasswordOTPExpiry < Date.now()
  ) {
    return next(new AppError(400, "Invalid or expired OTP"));
  }

  user.resetPasswordOTP = undefined;
  user.resetPasswordOTPExpiry = undefined;
  user.isEmailVerified = true;
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "OTP verified successfully",
    data: { email: normalizedEmail },
  });
});


export const changePassword = catchAsync(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Old password and new password are required"
    );
  }
  if (oldPassword === newPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Old password and new password cannot be same"
    );
  }
  const user = await User.findById({ _id: req.user?._id });

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }
  user.password = newPassword;
  await user.save();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password changed",
    data: "",
  });
});

export const refreshToken = catchAsync(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    throw new AppError(400, "Refresh token is required");
  }

  const decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user = await User.findById(decoded._id);
  if (!user || user.refreshToken !== refreshToken) {
    throw new AppError(401, "Invalid refresh token");
  }
  const jwtPayload = {
    _id: user._id,
    email: user.email,
    role: user.role,
  };

  const accessToken = createToken(
    jwtPayload,
    process.env.JWT_ACCESS_SECRET,
    getAccessTokenExpiresIn()
  );

  const refreshToken1 = createToken(
    jwtPayload,
    process.env.JWT_REFRESH_SECRET,
    getRefreshTokenExpiresIn()
  );
  user.refreshToken = refreshToken1;
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Token refreshed successfully",
    data: getAuthResponseData(user, accessToken, refreshToken1),
  });
});

export const logout = catchAsync(async (req, res) => {
  const user = req.user?._id;
  const user1 = await User.findByIdAndUpdate(
    user,
    { refreshToken: "" },
    { new: true }
  );

  if (user1 && ["admin", "staff"].includes(user1.role)) {
    await recordActivity({
      req: { ...req, user: user1 },
      action: "dashboard.logout",
      entityType: "user",
      entityId: user1._id,
      metadata: { email: user1.email, role: user1.role },
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Logged out successfully",
    data: "",
  });
});

export const resendOTP = catchAsync(async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Email is required"
    );
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "User not found"
    );
  }

  if (user.verificationInfo?.verified === true) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "User is already verified"
    );
  }

  const otp = generateOTP();

  const otpPayload = {
    otp,
  };

  const otpToken = createToken(
    otpPayload,
    process.env.OTP_SECRET,
    process.env.OTP_EXPIRE
  );

  user.verificationInfo.token = otpToken;
  await user.save();

  await sendEmail(
    user.email,
    "OTP Verification",
    `Your OTP is ${otp}`
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP resent successfully",
    data: {
      email: user.email,
    },
  });
});


