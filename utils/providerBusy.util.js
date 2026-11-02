import { Booking } from "../model/booking.model.js";
import { User } from "../model/user.model.js";

export const providerBusyStatuses = ["accepted", "arrived", "ongoing"];
const staleActiveBookingHours = Number(
  process.env.PROVIDER_BUSY_STALE_HOURS || 4
);

const getActiveBookingCutoff = () =>
  new Date(Date.now() - staleActiveBookingHours * 60 * 60 * 1000);

export const findActiveProviderBooking = async (providerId) => {
  const activeBookingCutoff = getActiveBookingCutoff();
  // Book for Later: mustaqbil ki Later booking (masalan aaj shaam
  // 6 baje wali) provider ko ABHI busy nahi karti — woh sirf apne
  // scheduled time se 1 ghanta pehle se busy karegi, jab woh live
  // honay wali ho. Is se Later ki wajah se 'Now' bookings nahi
  // rukti.
  const laterLiveFrom = new Date(Date.now() + 60 * 60 * 1000);

  return Booking.findOne({
    provider: providerId,
    status: { $in: providerBusyStatuses },
    $or: [
      { bookingDate: { $gte: activeBookingCutoff } },
      { createdAt: { $gte: activeBookingCutoff } },
      { updatedAt: { $gte: activeBookingCutoff } },
    ],
    $and: [
      {
        $or: [
          { bookingType: { $ne: "later" } },
          { scheduledAt: { $lte: laterLiveFrom } },
        ],
      },
    ],
  })
    .select("_id status bookingDate createdAt updatedAt bookingType scheduledAt")
    .lean();
};

export const refreshProviderBusyState = async (providerOrId) => {
  const providerId = providerOrId?._id || providerOrId;

  if (!providerId) {
    return null;
  }

  const activeBooking = await findActiveProviderBooking(providerId);
  const isBusy = Boolean(activeBooking);

  if (providerOrId?.save) {
    if (providerOrId.isBusy !== isBusy) {
      providerOrId.isBusy = isBusy;
      await providerOrId.save();
    }
  } else {
    await User.findByIdAndUpdate(providerId, { $set: { isBusy } });
  }

  return activeBooking;
};
