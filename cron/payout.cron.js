import cron from "node-cron";
import { Booking } from "../model/booking.model.js";
import { Payout } from "../model/payout.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import {
  computeProviderBalances,
  getUnpaidBookingEarnings,
} from "../utils/money.util.js";
import { attemptPayoutTransfer, MIN_AUTO_PAYOUT } from "../utils/payout.util.js";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Har roz 06:00 check: settings me autoPayoutEnabled ho AUR aaj
// wahi din ho jo admin ne chuna hai (nextPayoutDay, default
// Friday) to har provider ke liye — jis ka available balance
// kam se kam £10 ho aur pehle se koi payout na chal raha ho —
// ek payout banta hai aur Stripe Connect se transfer ki koshish
// hoti hai. Connect tayyar na ho to payout pending rehta hai
// (admin manually de sakta hai).
export const payoutCron = () => {
  cron.schedule("0 6 * * *", async () => {
    try {
      const settings = await PlatformSetting.findOne({ key: "global" }).lean();
      if (!settings?.autoPayoutEnabled) return;

      const today = WEEKDAYS[new Date().getDay()];
      const payoutDay = settings.nextPayoutDay || "Friday";
      if (today !== payoutDay) return;

      console.log("Weekly payout run started...");

      const providerIds = await Booking.distinct("provider", {
        status: "completed",
      });

      for (const providerId of providerIds) {
        if (!providerId) continue;

        const existing = await Payout.exists({
          provider: providerId,
          status: { $in: ["pending", "processing"] },
          source: { $ne: "bonus" },
        });
        if (existing) continue;

        const balances = await computeProviderBalances(providerId);
        if (balances.available < MIN_AUTO_PAYOUT) continue;

        const rows = await getUnpaidBookingEarnings(providerId);
        const payout = await Payout.create({
          provider: providerId,
          amount: balances.available,
          currency: "GBP",
          status: "pending",
          payoutDate: new Date(),
          source: "booking",
          bookingIds: rows
            .filter((row) => !row.held)
            .map((row) => row.bookingId),
          attempts: [
            {
              action: "weekly_run_created",
              result: "pending",
              note: `Automatic weekly payout (${payoutDay}).`,
            },
          ],
        });
        await attemptPayoutTransfer(payout);
      }

      console.log("Weekly payout run completed");
    } catch (error) {
      console.error("Payout cron failed:", error);
    }
  });
};
