import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    service: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      default: null,
    },
    vehicleSnapshot: {
      registrationNo: { type: String, default: "" },
      make: { type: String, default: "" },
      model: { type: String, default: "" },
      year: { type: Number },
      size: { type: String, default: "" },
      image: { type: String, default: "" },
    },
    price: {
      type: Number,
      required: true,
    },
    addons: [
      {
        addon: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Addon",
        },
        name: {
          type: String,
          default: "",
        },
        price: {
          type: Number,
          default: 0,
        },
      },
    ],
    addonsTotal: {
      type: Number,
      default: 0,
    },
    discountPrice: {
      type: Number,
      default: 0,
    },
    finalPrice: {
      type: Number,
      required: true,
    },
    address: {
      addressLine: { type: String, required: true },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },
    // Customer ki live location — jab customer washer ke driveway ki taraf
    // travel kar raha ho. Customer app PATCH /bookings/:id/customer-location
    // se update bhejti hai.
    customerLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      updatedAt: { type: Date, default: null },
    },
    // Google traffic-aware ETA (minutes) aur distance (miles) — customerLocation
    // update par backend calculate karta hai.
    customerEtaMinutes: { type: Number, default: null },
    customerDistanceMiles: { type: Number, default: null },
    postalCode: {
      type: String,
      trim: true,
      uppercase: true,
    },
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },
    bookingDate: {
      type: Date,
      required: true,
    },
    payment: {
      method: {
        type: String,
        enum: ["online", "wallet", "split"],
        default: "online",
      },
      status: {
        type: String,
        enum: ["pending", "paid", "failed"],
        default: "pending",
      },
      trxId: {
        type: String,
      },
      // Wallet/Card split (Payments phase) — refund asal raaste par
      // wapas bhejne ke liye dono hisse record rehte hain.
      walletAmount: { type: Number, default: 0 },
      cardAmount: { type: Number, default: 0 },
    },
    status: {
      type: String,
      enum: ["pending", "accepted","arrived", "ongoing", "completed", "cancelled", "declined"],
      default: "pending",
    },
    cancellationReason: {
      type: String,
      trim: true,
      default: "",
    },
    cancelledBy: {
      type: String,
      enum: ["", "user", "provider", "admin"],
      default: "",
    },
    cancelledAt: {
      type: Date,
    },
    statusHistory: [
      {
        status: { type: String, default: "" },
        at: { type: Date, default: Date.now },
        by: {
          type: String,
          enum: ["user", "provider", "admin", "system"],
          default: "system",
        },
        note: { type: String, trim: true, default: "" },
        _id: false,
      },
    ],
    estimatedArrival: {
      type: Date,
    },
    refund: {
      status: {
        type: String,
        enum: ["none", "refunded"],
        default: "none",
      },
      amount: { type: Number, default: 0 },
      refundId: { type: String, default: "" },
      reason: { type: String, trim: true, default: "" },
      at: { type: Date, default: null },
      by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },
    // Admin ka manual earning hold (Earnings phase) — is booking ki
    // kamai Available se nikaal kar "On Hold" rakhta hai.
    earningHold: {
      active: { type: Boolean, default: false },
      amount: { type: Number, default: 0 },
      reason: { type: String, trim: true, default: "" },
      by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      at: { type: Date, default: null },
      releasedAt: { type: Date, default: null },
      releasedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },
    // Commission snapshot (Payments phase) — booking complete hone
    // par us lamhe ka rate hamesha ke liye; null = abhi snapshot nahi.
    commissionRate: { type: Number, default: null },
    commissionAmount: { type: Number, default: null },
    providerNetAmount: { type: Number, default: null },
    isRated: {
      type: Boolean,
      default: false,
    },
    savedForLater: {
      type: Boolean,
      default: false,
    },

    currency: {
      type: String,
      default: "GBP",
      uppercase: true,
      trim: true,
    },
    completedAt: {
      type: Date,
    },
    arrivedAt: {
      type: Date,
    },
    washEndsAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

bookingSchema.pre("save", function () {
  if (this.isModified("status") && this.status === "completed") {
    this.completedAt = new Date();
  }
});
bookingSchema.index({ "address.latitude": 1, "address.longitude": 1 });

export const Booking = mongoose.model("Booking", bookingSchema);
