import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Booking } from "../model/booking.model.js";
import { Rating } from "../model/rating.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { notifyUser } from "../utils/fcm.util.js";
    

export const createRating = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const { bookingId, rating, review } = req.body;
  const ratingValue = Number(rating);

  if (!bookingId) {
    throw new AppError(httpStatus.BAD_REQUEST, "bookingId is required");
  }

  if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
    throw new AppError(httpStatus.BAD_REQUEST, "Rating must be between 1 and 5");
  }

  const booking = await Booking.findById(bookingId);

  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  if (String(booking.user) !== String(userId)) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  if (booking.status !== "completed") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You can rate only after booking is completed"
    );
  }

  const doc = await Rating.findOneAndUpdate(
    { booking: booking._id },
    {
      booking: booking._id,
      user: userId,
      provider: booking.provider,
      rating: ratingValue,
      review: review?.trim() || "",
      isLowRating: ratingValue <= 2,
      requiresReview: ratingValue <= 2,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (booking.isRated !== true) {
    booking.isRated = true;
    await booking.save();
  }

  // 🔔 Push to provider — they otherwise never know they were rated.
  if (booking.provider) {
    notifyUser(booking.provider.toString(), {
      title: `You got a ${ratingValue}-star rating! ⭐`,
      body:
        doc.review && doc.review.trim()
          ? `"${doc.review.trim()}"`
          : "A customer rated your service.",
      data: {
        type: "rating_received",
        bookingId: booking._id.toString(),
        rating: String(ratingValue),
      },
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Rating submitted successfully",
    data: doc,
  });
});

export const getRatingByBooking = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const { bookingId } = req.params;

  const booking = await Booking.findById(bookingId);

  if (!booking) throw new AppError(httpStatus.NOT_FOUND, "Booking not found");

  const isOwner = String(booking.user) === String(userId);
  const isProvider = String(booking.provider) === String(userId);
  const isAdmin = req.user?.role === "admin";

  if (!isOwner && !isProvider && !isAdmin) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  const rating = await Rating.findOne({ booking: bookingId })
    .populate("user", "name fullName email")
    .populate("provider", "name fullName email");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: rating || null,
  });
});

export const getRatingsByWasher = catchAsync(async (req, res) => {
  const { washerId } = req.params;

  const ratings = await Rating.find({ provider: washerId })
    .sort({ createdAt: -1 })
    .populate("user", "name fullName avatar photo profileImage");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: ratings,
  });
});

/**
 * GET /api/v1/ratings/average/:washerId
 * Returns the average rating for a washer (provider)
 * Example: 4.5/5 or 5/5 or "No rating"
 */
export const getWasherAverageRating = catchAsync(async (req, res) => {
  const { washerId } = req.params;

  // Validate washerId
  if (!mongoose.Types.ObjectId.isValid(washerId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid washerId");
  }

  // Get all ratings for the washer
  const ratings = await Rating.find({ provider: washerId });

  if (ratings.length === 0) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      data: {
        averageRating: null,
        totalRatings: 0,
        message: "No rating available",
      },
    });
  }

  // Calculate average rating
  const totalRating = ratings.reduce((sum, rating) => sum + rating.rating, 0);
  const averageRating = (totalRating / ratings.length).toFixed(1);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: {
      averageRating: parseFloat(averageRating),
      totalRatings: ratings.length,
      formattedRating: `${averageRating}/5`,
    },
  });
});
