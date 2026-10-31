import Stripe from "stripe";
import { Payout } from "../model/payout.model.js";
import { User } from "../model/user.model.js";
import { getPlatformSettingsDoc } from "./money.util.js";

const getStripe = () =>
  new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: process.env.STRIPE_API_VERSION || "2025-11-17.clover",
  });

// Weekly automatic run ki kam se kam raqam (admin tajweez £10).
export const MIN_AUTO_PAYOUT = 10;

// Ek pending payout ko Stripe Connect se bhejne ki koshish.
// Sharait: settings me autoPayoutEnabled ho, provider ka Connect
// onboarding mukammal (payoutsEnabled) ho, provider manual-only
// na ho. Kamyabi par payout "processing" ho jata hai — final
// "paid" Stripe ke payout.paid webhook par lage ga. Nakami par
// payout "failed" + wajah, taake admin retry ya manual pay kare.
// Idempotency key = payout id — ek payout ke do transfer namumkin.
export const attemptPayoutTransfer = async (payout) => {
  if (!payout || payout.status !== "pending") {
    return { attempted: false, payout };
  }
  const [settings, provider] = await Promise.all([
    getPlatformSettingsDoc(),
    User.findById(payout.provider)
      .select("stripeConnect payoutMode name")
      .lean(),
  ]);
  if (!settings?.autoPayoutEnabled) return { attempted: false, payout };
  if (!provider?.stripeConnect?.accountId || !provider.stripeConnect?.payoutsEnabled) {
    return { attempted: false, payout };
  }
  if (provider.payoutMode === "manual") return { attempted: false, payout };

  try {
    const transfer = await getStripe().transfers.create(
      {
        amount: Math.round(payout.amount * 100),
        currency: (payout.currency || "GBP").toLowerCase(),
        destination: provider.stripeConnect.accountId,
        description: `owvo payout ${payout.txnNumber || payout._id}`,
        metadata: {
          payoutId: payout._id.toString(),
          providerId: provider._id.toString(),
        },
      },
      { idempotencyKey: `payout_${payout._id}` }
    );
    payout.status = "processing";
    payout.mode = "auto";
    payout.stripeMode = "stripe_transfer";
    payout.stripeTransferId = transfer.id;
    payout.stripeDestinationAccountId = provider.stripeConnect.accountId;
    payout.attempts.push({
      action: "stripe_transfer_created",
      result: "processing",
      note: transfer.id,
    });
    await payout.save();
    return { attempted: true, payout };
  } catch (error) {
    payout.status = "failed";
    payout.mode = "auto";
    payout.failureReason = error?.message || "Stripe transfer failed";
    payout.attempts.push({
      action: "stripe_transfer_failed",
      result: "failed",
      note: payout.failureReason,
    });
    await payout.save();
    return { attempted: true, payout };
  }
};

// Cron/admin ke liye: kisi provider ke pending payouts par attempt.
export const attemptPendingPayoutsForProvider = async (providerId) => {
  const pending = await Payout.find({
    provider: providerId,
    status: "pending",
    source: { $ne: "bonus" },
  }).sort({ createdAt: 1 });
  const results = [];
  for (const payout of pending) {
    results.push(await attemptPayoutTransfer(payout));
  }
  return results;
};
