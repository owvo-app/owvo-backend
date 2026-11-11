// ════════════════════════════════════════════════════════════════
// OWVO Payments — ek dafa chalane wala backfill (Payments phase)
//   node scripts/backfill-payments.js           (asal tabdeeli)
//   node scripts/backfill-payments.js --dry     (sirf report)
//
// 1) Purani completed bookings par commission snapshot — us rate
//    par jo is waqt database me hai (live rate).
// 1b) Ghair-completed (pending/accepted waghera) bookings par
//     sirf RATE fix — amounts completion par in ke apne rate se
//     katengi, taake rate change in ko bhi na badal sake.
// 2) Jin payments/payouts par TXN number nahi, un ko number
//    (sab se purane pehle, taake tartib durust rahe).
// 3) Purane booking.refund records ko naye Refund ledger me
//    migrate karna + earning reversal lagana.
// Idempotent hai — dobara chalane se kuch kharab nahi hota.
// ════════════════════════════════════════════════════════════════
import "dotenv/config";
import mongoose from "mongoose";
import { Booking } from "../model/booking.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { Payout } from "../model/payout.model.js";
import { PlatformSetting } from "../model/platformSetting.model.js";
import { Refund } from "../model/refund.model.js";
import {
  applyCommissionSnapshot,
  applyEarningReversal,
  getCurrentCommissionRate,
} from "../utils/money.util.js";
import { getNextTxnNumber } from "../utils/counter.util.js";

const dryRun = process.argv.includes("--dry");
const log = (...args) => console.log(dryRun ? "[DRY]" : "[OK]", ...args);

const main = async () => {
  if (!process.env.MONGO_DB_URL) {
    throw new Error("MONGO_DB_URL is not set");
  }
  await mongoose.connect(process.env.MONGO_DB_URL);
  console.log("Connected. Dry run:", dryRun);

  // ── 1) Commission snapshots ──────────────────────────────────
  const rate = await getCurrentCommissionRate();
  const unsnapped = await Booking.find({
    status: "completed",
    $or: [{ commissionRate: null }, { commissionRate: { $exists: false } }],
  });
  log(`Snapshot backfill @ ${(rate * 100).toFixed(0)}%: ${unsnapped.length} bookings`);
  for (const booking of unsnapped) {
    await applyCommissionSnapshot(booking, rate);
    if (!dryRun) await booking.save();
  }

  // ── 1b) Ghair-completed bookings par sirf rate fix ────────────
  const unratedOpen = await Booking.find({
    status: { $ne: "completed" },
    $or: [{ commissionRate: null }, { commissionRate: { $exists: false } }],
  });
  log(
    `Open bookings rate-fix @ ${(rate * 100).toFixed(0)}%: ${unratedOpen.length} bookings`
  );
  for (const booking of unratedOpen) {
    booking.commissionRate = rate;
    if (!dryRun) await booking.save();
  }

  // ── 2) TXN numbers (purane pehle) ────────────────────────────
  for (const [label, Model] of [
    ["paymentInfo", paymentInfo],
    ["Payout", Payout],
    ["Refund", Refund],
  ]) {
    const missing = await Model.find({
      $or: [{ txnNumber: null }, { txnNumber: { $exists: false } }, { txnNumber: "" }],
    }).sort({ createdAt: 1 });
    log(`${label}: ${missing.length} records without TXN number`);
    for (const doc of missing) {
      if (dryRun) continue;
      doc.txnNumber = await getNextTxnNumber();
      await doc.save();
    }
  }

  // ── 3) booking.refund → Refund ledger ────────────────────────
  const legacyRefunded = await Booking.find({
    "refund.status": "refunded",
  }).select("_id user provider refund finalPrice price");
  let migrated = 0;
  for (const booking of legacyRefunded) {
    const exists = await Refund.exists({ booking: booking._id, status: "refunded" });
    if (exists) continue;
    migrated += 1;
    if (dryRun) continue;
    const refund = await Refund.create({
      booking: booking._id,
      customer: booking.user,
      provider: booking.provider,
      amount: Number(booking.refund.amount) || 0,
      walletPortion: 0,
      cardPortion: Number(booking.refund.amount) || 0,
      source: "admin",
      status: "refunded",
      reason: booking.refund.reason || "",
      reasonCategory: "other",
      stripeRefundId: booking.refund.refundId || "",
      decidedBy: booking.refund.by || undefined,
      decidedAt: booking.refund.at || undefined,
      refundedAt: booking.refund.at || new Date(),
    });
    await applyEarningReversal(refund);
  }
  log(`Legacy booking.refund migrated: ${migrated}`);

  console.log("Backfill complete.");
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error("Backfill failed:", error);
  try {
    await mongoose.disconnect();
  } catch (e) {
    /* ignore */
  }
  process.exit(1);
});
