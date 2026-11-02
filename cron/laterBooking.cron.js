import cron from "node-cron";
import { Booking } from "../model/booking.model.js";
import { notifyUser } from "../utils/fcm.util.js";
import { emitToUser } from "../socket/socket.js";
import { formatLondonDateTime } from "../utils/laterBooking.util.js";

// Book for Later ki waqt wali zimmedariyan — har 5 minute:
// 1) Payment deadline guzar jaye aur payment na ayi ho → booking
//    khud cancel, slot free, dono ko اطلاع.
// 2) Provider ne jawab ki hadd (requestExpiresAt) tak jawab na
//    diya ho → request expire, customer ko اطلاع.
// 3) Provider ko ek reminder agar request 30 minute se muntazir
//    hai (sirf ek dafa).
// 4) Booking se 1 ghanta pehle customer + provider ko reminder
//    (sirf paid/confirmed bookings, sirf ek dafa).
export const laterBookingCron = () => {
  cron.schedule("*/5 * * * *", async () => {
    try {
      const now = new Date();

      // 1) Payment deadlines
      const unpaidExpired = await Booking.find({
        bookingType: "later",
        status: "accepted",
        paymentDeadline: { $ne: null, $lt: now },
        "payment.status": { $ne: "paid" },
      }).select("_id user provider scheduledAt bookingDate");
      for (const booking of unpaidExpired) {
        await Booking.updateOne(
          { _id: booking._id, status: "accepted" },
          {
            $set: {
              status: "cancelled",
              cancelledBy: "system",
              cancelledAt: now,
              cancellationReason:
                "Payment was not completed in time",
            },
            $push: {
              statusHistory: {
                status: "cancelled",
                at: now,
                by: "system",
                note: "Payment deadline expired",
              },
            },
          }
        );
        notifyUser(booking.user.toString(), {
          title: "Booking cancelled — payment not completed",
          body: `Your scheduled wash on ${formatLondonDateTime(booking.scheduledAt || booking.bookingDate)} was cancelled because payment was not completed in time. You can book again any time.`,
          data: {
            type: "later_booking_cancelled",
            bookingId: booking._id.toString(),
          },
        });
        notifyUser(booking.provider.toString(), {
          title: "Scheduled booking cancelled",
          body: "A scheduled booking was cancelled because the customer did not complete payment in time. The slot is free again.",
          data: {
            type: "later_booking_cancelled",
            bookingId: booking._id.toString(),
          },
        });
      }

      // 2) Provider jawab ki hadd
      const unanswered = await Booking.find({
        bookingType: "later",
        status: "pending",
        requestExpiresAt: { $ne: null, $lt: now },
      }).select("_id user provider scheduledAt bookingDate");
      for (const booking of unanswered) {
        await Booking.updateOne(
          { _id: booking._id, status: "pending" },
          {
            $set: {
              status: "cancelled",
              cancelledBy: "system",
              cancelledAt: now,
              cancellationReason: "The provider did not respond in time",
            },
            $push: {
              statusHistory: {
                status: "cancelled",
                at: now,
                by: "system",
                note: "Provider response window expired",
              },
            },
          }
        );
        notifyUser(booking.user.toString(), {
          title: "Provider did not respond",
          body: `The provider did not respond to your scheduled wash on ${formatLondonDateTime(booking.scheduledAt || booking.bookingDate)}. No payment was taken — please choose another provider or time.`,
          data: {
            type: "later_booking_expired",
            bookingId: booking._id.toString(),
          },
        });
        notifyUser(booking.provider.toString(), {
          title: "Booking request expired",
          body: "A scheduled booking request expired because it was not answered in time.",
          data: {
            type: "later_booking_expired",
            bookingId: booking._id.toString(),
          },
        });
      }

      // 3) Provider reminder (30 minute se muntazir request)
      const waiting = await Booking.find({
        bookingType: "later",
        status: "pending",
        providerReminderSent: { $ne: true },
        createdAt: { $lt: new Date(now.getTime() - 30 * 60000) },
        requestExpiresAt: { $gt: now },
      }).select("_id provider scheduledAt bookingDate");
      for (const booking of waiting) {
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { providerReminderSent: true } }
        );
        notifyUser(booking.provider.toString(), {
          title: "Booking request waiting",
          body: `A scheduled wash on ${formatLondonDateTime(booking.scheduledAt || booking.bookingDate)} is still waiting for your response.`,
          data: {
            type: "later_booking_reminder",
            bookingId: booking._id.toString(),
          },
        });
      }

      // 4) T-60 minute reminders (paid bookings)
      const upcoming = await Booking.find({
        bookingType: "later",
        status: "accepted",
        "payment.status": "paid",
        reminder1hSent: { $ne: true },
        scheduledAt: {
          $lte: new Date(now.getTime() + 60 * 60000),
          $gt: now,
        },
      }).select("_id user provider scheduledAt bookingDate");
      for (const booking of upcoming) {
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { reminder1hSent: true } }
        );
        const when = formatLondonDateTime(
          booking.scheduledAt || booking.bookingDate
        );
        notifyUser(booking.user.toString(), {
          title: "Your wash is in 1 hour",
          body: `Your scheduled wash is at ${when}. Please head over in good time.`,
          data: {
            type: "later_booking_upcoming",
            bookingId: booking._id.toString(),
          },
        });
        notifyUser(booking.provider.toString(), {
          title: "Scheduled wash in 1 hour",
          body: `You have a scheduled wash at ${when}. Please be ready.`,
          data: {
            type: "later_booking_upcoming",
            bookingId: booking._id.toString(),
          },
        });
        // Live ishara: provider ki app khuli ho to andar bhi pata chale —
        // sirf push par inhisaar nahi. Yeh koi nayi request NAHI hai;
        // app isay aik اطلاع wali patti ki tarah dikhati hai.
        emitToUser(booking.provider.toString(), "later_booking_live_soon", {
          bookingId: booking._id.toString(),
          scheduledAt:
            (booking.scheduledAt || booking.bookingDate)?.toISOString?.() ||
            null,
          message: `You have a scheduled wash at ${when}. Please be ready.`,
        });
      }
    } catch (error) {
      console.error("laterBookingCron error:", error?.message || error);
    }
  });
};
