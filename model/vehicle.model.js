import mongoose from "mongoose";

const vehicleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    registrationNo: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    make: {
      type: String,
      required: true,
      trim: true,
    },
    model: {
      type: String,
      required: true,
      trim: true,
    },
    year: {
      type: Number,
      required: true,
      min: 1900,
      max: 2100,
    },
    size: {
      type: String,
      required: true,
      enum: [
        "Small Car",
        "Medium Car",
        "Large Car",
        "Small Van",
        "Motorbike",
        "Jeep",
      ],
    },
    image: {
      type: String,
      default: null,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    source: {
      type: String,
      enum: ["manual", "dvla"],
      default: "manual",
    },
    colour: { type: String, default: null, trim: true },
    fuelType: { type: String, default: null, trim: true },
    engineCapacity: { type: Number, default: null },
    co2Emissions: { type: Number, default: null },
    typeApproval: { type: String, default: null, trim: true },
    taxStatus: { type: String, default: null, trim: true },
    taxDueDate: { type: String, default: null, trim: true },
    motStatus: { type: String, default: null, trim: true },
    motExpiryDate: { type: String, default: null, trim: true },
    dvlaVerifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

vehicleSchema.index({ user: 1, registrationNo: 1 }, { unique: true });

export const Vehicle = mongoose.model("Vehicle", vehicleSchema);
