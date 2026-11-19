import mongoose from "mongoose";

// Service Areas (Settings → Service Areas): the admin controls which UK
// postcode areas are open for bookings. An entry covers a postcode
// DISTRICT ("BR5") or one FULL postcode ("BR5 3DA"). New areas start
// inactive. If NO areas exist at all, no restriction applies anywhere.
const serviceAreaSchema = new mongoose.Schema(
  {
    city: { type: String, required: true, trim: true, maxlength: 80 },
    areaName: { type: String, required: true, trim: true, maxlength: 120 },
    // Normalised postcode entry: district ("BR5") or full ("BR5 3DA").
    // Empty string = city placeholder row that covers nothing yet.
    postcode: { type: String, trim: true, uppercase: true, default: "", maxlength: 10 },
    // District derived from the postcode entry ("BR5") — grouping +
    // waitlist key. Empty for placeholder rows.
    postcodeDistrict: { type: String, trim: true, uppercase: true, default: "", index: true },
    kind: { type: String, enum: ["district", "full", "placeholder"], default: "placeholder" },
    isActive: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const ServiceArea = mongoose.model("ServiceArea", serviceAreaSchema);
