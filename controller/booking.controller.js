import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Addon } from "../model/addon.model.js";
import { Booking } from "../model/booking.model.js";
import { Coupon } from "../model/coupon.model.js";
import { Receipt } from "../model/receipt.model.js";
import { Service } from "../model/service.model.js";
import { User } from "../model/user.model.js";
import { Vehicle } from "../model/vehicle.model.js";
import { broadcast, emitToUser } from "../socket/socket.js";
import { notifyUser } from "../utils/fcm.util.js";
import { isProviderAvailableNow } from "../utils/availability.util.js";
import { syncProviderCompletedJobs } from "../utils/completedJobs.util.js";
import catchAsync from "../utils/catch.Async.js";
import { refreshProviderBusyState } from "../utils/providerBusy.util.js";
import sendResponse from "../utils/sendResponse.js";

const toCustomerSocketPayload = (customer) => {
  if (!customer) return null;
  return {
    _id: customer._id?.toString(),
    name: customer.name,
    email: customer.email,
    phoneNumber: customer.phoneNumber,
    phone: customer.phoneNumber,
    photo: customer.photo,
    location: customer.location,
    residentialAddress: customer.residentialAddress,
    providerAddress: customer.providerAddress,
    averageRating: customer.customerRatingAverage || 0,
    totalRatings: customer.customerRatingCount || 0,
  };
};

const toAdminBookingPayload = (booking, extras = {}) => ({
  bookingId: booking._id?.toString(),
  status: booking.status,
  userId: booking.user?._id?.toString?.() || booking.user?.toString?.(),
  providerId: booking.provider?._id?.toString?.() || booking.provider?.toString?.(),
  serviceId: booking.service?._id?.toString?.() || booking.service?.toString?.(),
  price: booking.finalPrice,
  currency: booking.currency,
  bookingDate: booking.bookingDate,
  createdAt: booking.createdAt,
  updatedAt: booking.updatedAt,
  ...extras,
});


export const createBooking = catchAsync(async (req, res) => {
  const userId = req.user._id;

  const {
    provider,
    service,
    couponCode,
    addonIds,
    address,
    bookingDate,
    payment,
    postalCode,
    vehicle,
    vehicleId,
  } = req.body;

  if (
    !provider ||
    !service ||
    !address ||
    !bookingDate
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Missing required booking fields",
    );
  }

  const washer = await User.findById(provider);

  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }

  if (!washer.isOnline) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer is offline");
  }

  const activeBooking = await refreshProviderBusyState(washer);
  if (activeBooking) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer is currently busy");
  }

  if (!isProviderAvailableNow(washer, new Date(bookingDate))) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Washer is outside their saved availability"
    );
  }

  if (washer.dailyWashLimit <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer daily limit completed");
  }

  const bookedService = await Service.findOne({
    _id: service,
    isActive: true,
    catalogKey: { $exists: true, $ne: null },
  })
    .select("_id provider catalogKey title price serviceType carSize carName carModel description")
    .lean();

  if (!bookedService) {
    throw new AppError(httpStatus.NOT_FOUND, "Service not found");
  }

  if (
    bookedService.provider &&
    bookedService.provider.toString() !== provider.toString()
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Selected service does not belong to this provider"
    );
  }

  if (payment?.method && payment.method !== "online") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Owvo bookings support in-app online payments only"
    );
  }

  const price = Number(bookedService.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid service price");
  }

  // Add-ons are priced server-side from the DB — client prices are never trusted.
  let selectedAddons = [];
  let addonsTotal = 0;

  if (addonIds !== undefined && addonIds !== null) {
    if (!Array.isArray(addonIds)) {
      throw new AppError(httpStatus.BAD_REQUEST, "addonIds must be an array");
    }

    const uniqueAddonIds = [
      ...new Set(addonIds.map((id) => id?.toString()).filter(Boolean)),
    ];

    if (uniqueAddonIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "One or more selected add-ons are not available"
      );
    }

    if (uniqueAddonIds.length > 0) {
      selectedAddons = await Addon.find({
        _id: { $in: uniqueAddonIds },
        isActive: true,
      })
        .select("_id name price")
        .lean();

      if (selectedAddons.length !== uniqueAddonIds.length) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "One or more selected add-ons are not available"
        );
      }

      addonsTotal =
        Math.round(
          selectedAddons.reduce((sum, addon) => sum + Number(addon.price), 0) *
            100
        ) / 100;
    }
  }

  const subtotal = price + addonsTotal;

  let discountPrice = 0;
  let finalPrice = subtotal;
  let appliedCoupon = null;

  
  const normalizedPostalCode = (postalCode || "")
    .toString()
    .toUpperCase()
    .trim();

  if (!normalizedPostalCode) {
    throw new AppError(httpStatus.BAD_REQUEST, "postalCode is required");
  }

  const requestedVehicleId = vehicleId || vehicle;
  let bookingVehicle = null;

  if (requestedVehicleId) {
    bookingVehicle = await Vehicle.findOne({
      _id: requestedVehicleId,
      user: userId,
    }).lean();

    if (!bookingVehicle) {
      throw new AppError(httpStatus.NOT_FOUND, "Vehicle not found");
    }
  } else {
    bookingVehicle =
      (await Vehicle.findOne({ user: userId, isDefault: true }).lean()) ||
      (await Vehicle.findOne({ user: userId }).sort({ createdAt: -1 }).lean());
  }

  const vehicleSnapshot = bookingVehicle
    ? {
        registrationNo: bookingVehicle.registrationNo || "",
        make: bookingVehicle.make || "",
        model: bookingVehicle.model || "",
        year: bookingVehicle.year,
        size: bookingVehicle.size || "",
        image: bookingVehicle.image || "",
      }
    : undefined;

  if (couponCode) {
    const coupon = await Coupon.findOne({
      couponCode: couponCode.toUpperCase(),
      isActive: true,
    });

    if (!coupon) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid coupon code");
    }

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new AppError(httpStatus.BAD_REQUEST, "Coupon has expired");
    }

    const isAllowed = coupon.allowedPostalCodes.includes(normalizedPostalCode);

    if (!isAllowed) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Coupon is not available in your area",
      );
    }

    discountPrice = (subtotal * coupon.discountPercentage) / 100;
    finalPrice = subtotal - discountPrice;
    if (finalPrice < 0) finalPrice = 0;

    appliedCoupon = coupon._id;
  }

  const booking = await Booking.create({
    user: userId,
    provider,
    service,
    price,
    addons: selectedAddons.map((addon) => ({
      addon: addon._id,
      name: addon.name,
      price: addon.price,
    })),
    addonsTotal,
    vehicle: bookingVehicle?._id || null,
    vehicleSnapshot,
    coupon: appliedCoupon,
    discountPrice,
    finalPrice,
    address,
    bookingDate,
    postalCode: normalizedPostalCode,
    currency: "GBP",
    payment: {
      method: "online",
      status: "pending",
    },
    status: "pending",
  });

  // ✅ Real-time: notify the washer about the new incoming booking request
  const customer = await User.findById(userId)
    .select(
      "_id name email phoneNumber photo location residentialAddress providerAddress customerRatingAverage customerRatingCount"
    )
    .lean();

  const customerPayload = customer
    ? {
        ...customer,
        _id: customer._id.toString(),
        phone: customer.phoneNumber,
        averageRating: customer.customerRatingAverage || 0,
        totalRatings: customer.customerRatingCount || 0,
      }
    : { _id: userId.toString() };

  const servicePayload = bookedService
    ? {
        ...bookedService,
        _id: bookedService._id.toString(),
      }
    : service;

  const vehiclePayload = bookingVehicle
    ? {
        _id: bookingVehicle._id.toString(),
        ...vehicleSnapshot,
      }
    : null;

  emitToUser(provider.toString(), "new_booking_request", {
    _id: booking._id.toString(),
    bookingId: booking._id.toString(),
    user: customerPayload,
    userId: userId.toString(),
    service: servicePayload,
    serviceId: service.toString(),
    serviceType: bookedService?.serviceType,
    vehicle: vehiclePayload,
    vehicleId: vehiclePayload?._id,
    vehicleType: vehiclePayload?.size,
    carType: vehiclePayload
      ? [vehiclePayload.make, vehiclePayload.model, vehiclePayload.size]
          .filter(Boolean)
          .join(" ")
      : undefined,
    address,
    customerLocation: {
      type: "Point",
      coordinates: [address.longitude, address.latitude],
    },
    bookingDate,
    price: booking.price,
    finalPrice: booking.finalPrice,
    discount: booking.discountPrice,
    addons: (booking.addons || []).map((a) => ({
      name: a.name,
      price: a.price,
    })),
    addonsTotal: booking.addonsTotal || 0,
    currency: booking.currency,
    payment: booking.payment,
    message: "You have a new booking request!",
  });

  // 🔔 Push: new booking request → provider
  notifyUser(provider.toString(), {
    title: "New booking request!",
    body: `${customerPayload.name || "A customer"} requested ${bookedService?.title || "a wash"} — £${booking.finalPrice}`,
    data: {
      type: "new_booking_request",
      bookingId: booking._id.toString(),
    },
  });

  broadcast("admin_booking_created", toAdminBookingPayload(booking, {
    customer: customerPayload,
    service: servicePayload,
    vehicle: vehiclePayload,
  }));

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Booking created successfully",
    data: booking,
  });
});

export const getSingleBooking = catchAsync(async (req, res) => {
  const { id } = req.params;

  const booking = await Booking.findById(id)
    .populate("user", "name email phoneNumber photo location residentialAddress providerAddress")
    .populate("provider", "name email phoneNumber photo location providerAddress residentialAddress serviceArea")
    .populate("service", "title price serviceType carSize carName carModel")
    .populate("vehicle", "registrationNo make model year size image isDefault");

  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  const isOwner = String(booking.user?._id) === String(req.user._id);
  const isProvider = String(booking.provider?._id) === String(req.user._id);
  const isAdmin = req.user?.role === "admin";

  if (!isOwner && !isProvider && !isAdmin) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: booking,
  });
});

export const getUserBookings = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const {providerId} = req.query;
const filter = { user: userId };

if (providerId) {
  filter.provider = providerId;
}

const bookings = await Booking.find(filter)
    .populate("provider", "_id name email role photo")
    .populate("service", "_id title price serviceType carSize carName carModel")
    .populate("vehicle", "registrationNo make model year size image isDefault")
    .sort({ createdAt: -1 }); 

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: bookings,
  });
});


export const getProviderBookings = catchAsync(async (req, res) => {
  const providerId = req.user._id;

  if (req.user?.role !== "provider" && req.user?.role !== "admin") {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  const bookings = await Booking.find({ provider: providerId })
    .populate(
      "user",
      "name email phoneNumber photo location residentialAddress providerAddress customerRatingAverage customerRatingCount"
    )
    .populate("service", "title price serviceType carSize carName carModel")
    .populate("vehicle", "registrationNo make model year size image isDefault")
    .sort({ createdAt: -1 });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    data: bookings,
  });
});

export const updateBookingStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatus = [
    "pending",
    "accepted",
    "arrived",
    "ongoing",
    "completed",
    "cancelled",
  ];

  if (!allowedStatus.includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid booking status");
  }

  const booking = await Booking.findById(id);
  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  const isProvider = String(booking.provider) === String(req.user._id);
  const isOwner = String(booking.user) === String(req.user._id);
  const isAdmin = req.user?.role === "admin";

  if (status === "arrived") {
    const canMarkArrived = isOwner || isProvider || isAdmin;
    const canArriveFromStatus = ["accepted", "ongoing"].includes(booking.status);
    if (!canMarkArrived) {
      throw new AppError(httpStatus.FORBIDDEN, "Access denied");
    }
    if (!canArriveFromStatus && !isAdmin) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Booking cannot be marked arrived from its current status"
      );
    }
  } else if (!isProvider && !isAdmin) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  booking.status = status;
  if (status === "arrived" && !booking.arrivedAt) {
    booking.arrivedAt = new Date();
    booking.washEndsAt = new Date(booking.arrivedAt.getTime() + 30 * 60 * 1000);
  }
  await booking.save();
  await refreshProviderBusyState(booking.provider);
  await booking.populate([
    {
      path: "user",
      select:
        "_id name email phoneNumber photo location residentialAddress providerAddress customerRatingAverage customerRatingCount",
    },
    {
      path: "service",
      select: "_id title price serviceType carSize carName carModel",
    },
    {
      path: "vehicle",
      select: "registrationNo make model year size image isDefault",
    },
  ]);

  const bookingUserId =
    booking.user?._id?.toString?.() || booking.user?.toString();
  const bookingProviderId =
    booking.provider?._id?.toString?.() || booking.provider?.toString();
  const providerCompletedJobs =
    status === "completed"
      ? await syncProviderCompletedJobs(bookingProviderId)
      : null;
  const customerPayload = toCustomerSocketPayload(booking.user);
  const servicePayload = booking.service
    ? {
        _id: booking.service._id?.toString(),
        title: booking.service.title,
        price: booking.service.price,
        serviceType: booking.service.serviceType,
        carSize: booking.service.carSize,
        carName: booking.service.carName,
        carModel: booking.service.carModel,
      }
    : null;
  const vehiclePayload = booking.vehicle
    ? {
        _id: booking.vehicle._id?.toString(),
        registrationNo: booking.vehicle.registrationNo,
        make: booking.vehicle.make,
        model: booking.vehicle.model,
        year: booking.vehicle.year,
        size: booking.vehicle.size,
        image: booking.vehicle.image,
      }
    : booking.vehicleSnapshot || null;

  // ✅ Real-time notifications based on status change
  const statusMessages = {
    accepted: "Your booking has been accepted!",
    ongoing:  "Your car wash has started!",
    completed:"Your car wash is complete! Please rate your experience.",
    cancelled:"Your booking has been cancelled.",
    arrived:"The user has arrived at the washer location.",
  };

  if (status === "completed") {
    // Notify both user and provider
    emitToUser(bookingUserId, "booking_status_update", {
      bookingId: booking._id,
      status,
      price: booking.finalPrice,
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: statusMessages[status],
    });
    emitToUser(bookingProviderId, "booking_status_update", {
      bookingId: booking._id,
      status,
      price: booking.finalPrice,
      user: customerPayload,
      userId: bookingUserId,
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: "Booking marked as completed.",
    });
  } else if (status === "arrived") {
    emitToUser(bookingProviderId, "booking_status_update", {
      bookingId: booking._id,
      status,
      price: booking.finalPrice,
      user: customerPayload,
      userId: bookingUserId,
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: statusMessages[status],
    });
    emitToUser(bookingUserId, "booking_status_update", {
      bookingId: booking._id,
      status,
      price: booking.finalPrice,
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: "You have arrived. The washer has been notified.",
    });
  } else if (statusMessages[status]) {
    // Notify the user only
    emitToUser(bookingUserId, "booking_status_update", {
      bookingId: booking._id,
      status,
      price: booking.finalPrice,
      service: servicePayload,
      serviceId: servicePayload?._id,
      vehicle: vehiclePayload,
      vehicleId: vehiclePayload?._id,
      currency: booking.currency,
      arrivedAt: booking.arrivedAt,
      washEndsAt: booking.washEndsAt,
      message: statusMessages[status],
    });
  }

  broadcast("admin_booking_status_updated", {
    bookingId: booking._id.toString(),
    status,
    providerId: bookingProviderId,
    userId: bookingUserId,
    completedJobs: providerCompletedJobs,
    updatedAt: booking.updatedAt,
  });
  // ✅ Auto create / update receipt when completed
  if (status === "completed") {
    const subtotal = booking.price;                 // original price
    const discount = booking.discountPrice || 0;    // coupon discount
    const tax = 0;                                  // set your logic if you have tax
    const total = booking.finalPrice;               // final amount user pays

    // simple unique receipt number
    const receiptNo = `RCPT-${booking._id.toString().slice(-6).toUpperCase()}`;

    await Receipt.findOneAndUpdate(
      { booking: booking._id }, // ✅ unique per booking
      {
        booking: booking._id,
        user: bookingUserId,
        provider: bookingProviderId,
        service: booking.service?._id || booking.service,
        subtotal,
        discount,
        tax,
        total,
        currency: "GBP",
        receiptNo,
        issuedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking status updated",
    data: booking,
  });
});

export const cancelBooking = catchAsync(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const booking = await Booking.findOne({ _id: id, user: userId });

  if (!booking) {
    throw new AppError(httpStatus.NOT_FOUND, "Booking not found");
  }

  if (booking.status === "completed") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Completed booking cannot be cancelled",
    );
  }

  booking.status = "cancelled";
  await booking.save();
  await refreshProviderBusyState(booking.provider);

  // ✅ Real-time: notify the washer that the booking was cancelled
  emitToUser(booking.provider.toString(), "booking_cancelled", {
    bookingId: booking._id,
    status: "cancelled",
    message: "A booking has been cancelled by the user.",
  });

  // 🔔 Push: cancelled by customer → provider
  notifyUser(booking.provider.toString(), {
    title: "Booking cancelled",
    body: "A booking was cancelled by the customer.",
    data: { type: "booking_cancelled", bookingId: booking._id.toString() },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking cancelled successfully",
    data: booking,
  });
});

export const rebookBooking = catchAsync(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const prev = await Booking.findById(id);
  if (!prev) throw new AppError(httpStatus.NOT_FOUND, "Booking not found");

  if (String(prev.user) !== String(userId)) {
    throw new AppError(httpStatus.FORBIDDEN, "Access denied");
  }

  const { bookingDate, address, postalCode, payment, couponCode } = req.body;

  const provider = prev.provider;
  const service = prev.service;

  const washer = await User.findById(provider);
  if (!washer || washer.role !== "provider") {
    throw new AppError(httpStatus.NOT_FOUND, "Washer not found");
  }
  if (!washer.isOnline) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer is offline");
  }
  const activeBooking = await refreshProviderBusyState(washer);
  if (activeBooking) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer is currently busy");
  }
  if (!isProviderAvailableNow(washer, new Date(bookingDate ?? prev.bookingDate))) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Washer is outside their saved availability"
    );
  }
  if (washer.dailyWashLimit <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Washer daily limit completed");
  }

  broadcast("admin_booking_status_updated", toAdminBookingPayload(booking, {
    user: customerPayload,
    service: servicePayload,
    vehicle: vehiclePayload,
    arrivedAt: booking.arrivedAt,
    washEndsAt: booking.washEndsAt,
  }));

  const currentService = await Service.findOne({
    _id: service,
    isActive: true,
    catalogKey: { $exists: true, $ne: null },
  })
    .select("_id provider price")
    .lean();

  if (!currentService) {
    throw new AppError(httpStatus.BAD_REQUEST, "Service is no longer available");
  }

  if (
    currentService.provider &&
    currentService.provider.toString() !== provider.toString()
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Selected service does not belong to this provider"
    );
  }

  const price = Number(currentService.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid service price");
  }

  const finalAddress = address ?? prev.address;
  const finalBookingDate = bookingDate ?? prev.bookingDate;
  const finalPayment = payment ?? prev.payment;
  const finalPostalCode = (postalCode ?? prev.postalCode)?.toUpperCase().trim();

  if (!finalAddress || !finalBookingDate || !finalPayment || !finalPostalCode) {
    throw new AppError(httpStatus.BAD_REQUEST, "Missing required rebook fields");
  }

  let discountPrice = 0;
  let finalPrice = price;
  let appliedCoupon = null;

  if (couponCode) {
    const coupon = await Coupon.findOne({
      couponCode: couponCode.toUpperCase(),
      isActive: true,
    });

    if (!coupon) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid coupon code");
    }

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new AppError(httpStatus.BAD_REQUEST, "Coupon has expired");
    }

    const isAllowed = coupon.allowedPostalCodes.includes(finalPostalCode);
    if (!isAllowed) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Coupon is not available in your area"
      );
    }

    discountPrice = (price * coupon.discountPercentage) / 100;
    finalPrice = price - discountPrice;
    if (finalPrice < 0) finalPrice = 0;

    appliedCoupon = coupon._id;
  }

  // 1) Create new booking
  const createdBooking = await Booking.create({
    user: userId,
    provider,
    service,
    price,
    vehicle: prev.vehicle || null,
    vehicleSnapshot: prev.vehicleSnapshot,
    coupon: appliedCoupon,
    discountPrice,
    finalPrice,
    address: finalAddress,
    bookingDate: finalBookingDate,
    postalCode: finalPostalCode,
    payment: finalPayment,
    currency: prev.currency || "GBP",
    status: "pending",
  });

  // 2) Return only what the Figma page needs (trim + populate)
  const booking = await Booking.findById(createdBooking._id)
    .select(
      "provider service bookingDate address price discountPrice finalPrice status createdAt"
    )
    .populate("provider", "_id name avatar")
    .populate("service", "_id title");

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Booking rebooked successfully",
    data: booking,
  });
});
