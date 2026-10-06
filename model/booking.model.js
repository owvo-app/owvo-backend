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
        enum: ["online"],
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
    },
    status: {
      type: String,
      enum: ["pending", "accepted","arrived", "ongoing", "completed", "cancelled"],
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
    isRated: {
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
