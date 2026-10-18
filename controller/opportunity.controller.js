import catchAsync from "../utils/catch.Async.js";
import AppError from "../errors/AppError.js";
import httpStatus from "http-status";
import { Opportunity } from "../model/opportunity.model.js";
import { ProviderOpportunity } from "../model/providerOpportunity.model.js";
import { User } from "../model/user.model.js";
import { Booking } from "../model/booking.model.js";
import { emitToUser } from "../socket/socket.js";

const OPPORTUNITY_TYPES = ["daily", "weekly", "custom", "location", "service", "milestone", "referral"];
const OPPORTUNITY_STATUSES = ["active", "scheduled", "paused", "ended"];

// ─── Admin ───

/** POST /admin/opportunities — create campaign */
export const createOpportunity = catchAsync(async (req, res) => {
  const {
    name, description, type, target, targetUnit,
    rewardAmount, location, service, audience,
    selectedProviders, startDate, endDate,
    hasSpecificTime, startTime, endTime,
  } = req.body;

  if (!name?.trim() || !type || !target || !rewardAmount || !startDate || !endDate) {
    throw new AppError(httpStatus.BAD_REQUEST, "Name, type, target, reward, start and end date are required");
  }
  if (!OPPORTUNITY_TYPES.includes(type)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid opportunity type");
  }

  const now = new Date();
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) {
    throw new AppError(httpStatus.BAD_REQUEST, "End date must be after start date");
  }

  // Auto-determine status (timezone-tolerant: 12h grace period covers all timezones)
  let status = "scheduled";
  const twelveHours = 12 * 60 * 60 * 1000;
  if (start.getTime() - twelveHours <= now.getTime() && end >= now) status = "active";
  if (end < now) status = "ended";

  const opportunity = await Opportunity.create({
    name: name.trim(),
    description: description?.trim() || "",
    type,
    target: Number(target),
    targetUnit: targetUnit || "bookings",
    rewardAmount: Number(rewardAmount),
    location: location || "",
    service: service || null,
    audience: audience || "all",
    selectedProviders: selectedProviders || [],
    startDate: start,
    endDate: end,
    hasSpecificTime: !!hasSpecificTime,
    startTime: startTime || "",
    endTime: endTime || "",
    status,
    createdBy: req.user._id,
  });

  res.status(httpStatus.CREATED).json({ success: true, data: opportunity });
});

/** GET /admin/opportunities — list with filters + stats */
export const getAdminOpportunities = catchAsync(async (req, res) => {
  const { status, type, search } = req.query;
  const filter = { isActive: true };
  if (status && OPPORTUNITY_STATUSES.includes(status)) filter.status = status;
  if (type && OPPORTUNITY_TYPES.includes(type)) filter.type = type;
  if (search) filter.name = { $regex: search, $options: "i" };

  const opportunities = await Opportunity.find(filter)
    .populate("service", "title")
    .sort({ createdAt: -1 })
    .lean();

  // Participant count per opportunity
  const oppIds = opportunities.map((o) => o._id);
  const participantCounts = await ProviderOpportunity.aggregate([
    { $match: { opportunity: { $in: oppIds } } },
    { $group: { _id: "$opportunity", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(participantCounts.map((c) => [c._id.toString(), c.count]));
  const items = opportunities.map((o) => ({
    ...o,
    participants: countMap.get(o._id.toString()) || 0,
  }));

  // Stats
  const [activeCount, totalParticipants, rewardsAgg] = await Promise.all([
    Opportunity.countDocuments({ status: "active", isActive: true }),
    ProviderOpportunity.countDocuments({ opportunity: { $in: oppIds } }),
    ProviderOpportunity.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, total: { $sum: "$paidAmount" } } },
    ]),
  ]);

  // Status breakdown
  const statusBreakdown = await Opportunity.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const breakdown = { all: 0, active: 0, scheduled: 0, paused: 0, ended: 0 };
  statusBreakdown.forEach((s) => {
    breakdown[s._id] = s.count;
    breakdown.all += s.count;
  });

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      items,
      stats: {
        activeCampaigns: activeCount,
        totalParticipants,
        rewardsEarned: rewardsAgg[0]?.total || 0,
      },
      statusBreakdown: breakdown,
    },
  });
});

/** PATCH /admin/opportunities/:id — update */
export const updateOpportunity = catchAsync(async (req, res) => {
  const opportunity = await Opportunity.findById(req.params.id);
  if (!opportunity) throw new AppError(httpStatus.NOT_FOUND, "Opportunity not found");

  const allowed = ["name", "description", "target", "rewardAmount", "location",
    "audience", "selectedProviders", "startDate", "endDate", "status", "isActive"];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) opportunity[field] = req.body[field];
  });

  await opportunity.save();
  res.status(httpStatus.OK).json({ success: true, data: opportunity });
});

/** DELETE /admin/opportunities/:id — soft delete */
export const deleteOpportunity = catchAsync(async (req, res) => {
  const opportunity = await Opportunity.findById(req.params.id);
  if (!opportunity) throw new AppError(httpStatus.NOT_FOUND, "Opportunity not found");
  opportunity.isActive = false;
  await opportunity.save();
  res.status(httpStatus.OK).json({ success: true, message: "Opportunity deleted" });
});

/** GET /admin/opportunities/progress — all provider progress */
export const getAllProgress = catchAsync(async (req, res) => {
  const { opportunityId, status } = req.query;
  const filter = {};
  if (opportunityId) filter.opportunity = opportunityId;
  if (status) filter.status = status;

  const progress = await ProviderOpportunity.find(filter)
    .populate("provider", "name email phoneNumber")
    .populate("opportunity", "name type target rewardAmount")
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  res.status(httpStatus.OK).json({ success: true, data: progress });
});

/** GET /admin/opportunities/payouts — claimed/paid list */
export const getBonusPayouts = catchAsync(async (req, res) => {
  const payouts = await ProviderOpportunity.find({
    status: { $in: ["claimed", "paid"] },
  })
    .populate("provider", "name email")
    .populate("opportunity", "name rewardAmount")
    .sort({ claimedAt: -1 })
    .lean();

  res.status(httpStatus.OK).json({ success: true, data: payouts });
});

/** PATCH /admin/opportunities/payouts/:id — approve payout (add to wallet) */
export const approvePayout = catchAsync(async (req, res) => {
  const record = await ProviderOpportunity.findById(req.params.id)
    .populate("opportunity")
    .populate("provider");
  if (!record) throw new AppError(httpStatus.NOT_FOUND, "Payout not found");
  if (record.status !== "claimed") {
    throw new AppError(httpStatus.BAD_REQUEST, "Payout is not in claimed state");
  }

  const amount = record.opportunity.rewardAmount;

  // Add to provider wallet
  await User.findByIdAndUpdate(record.provider._id, {
    $inc: { "wallet.balance": amount },
  });

  record.status = "paid";
  record.paidAt = new Date();
  record.paidAmount = amount;
  await record.save();

  try {
    emitToUser(record.provider._id.toString(), "bonus_paid", {
      amount,
      opportunityName: record.opportunity.name,
      message: `Bonus of £${amount} added to your wallet!`,
    });
  } catch (e) { /* socket optional */ }

  res.status(httpStatus.OK).json({ success: true, data: record });
});

// ─── Provider app ───

/** GET /opportunities — active opportunities for provider */
export const getProviderOpportunities = catchAsync(async (req, res) => {
  const now = new Date();
  // 12h grace period for timezone differences (same as createOpportunity)
  const graceStart = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const opportunities = await Opportunity.find({
    isActive: true,
    status: "active",
    startDate: { $lte: graceStart },
    endDate: { $gte: now },
    $or: [
      { audience: "all" },
      { audience: "selected", selectedProviders: req.user._id },
    ],
  })
    .populate("service", "title")
    .sort({ createdAt: -1 })
    .lean();

  // Get or create progress records
  const oppIds = opportunities.map((o) => o._id);
  let progressRecords = await ProviderOpportunity.find({
    provider: req.user._id,
    opportunity: { $in: oppIds },
  }).lean();

  const existingOppIds = new Set(progressRecords.map((p) => p.opportunity.toString()));
  const toCreate = oppIds.filter((id) => !existingOppIds.has(id.toString()));
  if (toCreate.length > 0) {
    const created = await ProviderOpportunity.insertMany(
      toCreate.map((oppId) => ({ provider: req.user._id, opportunity: oppId }))
    );
    progressRecords = [...progressRecords, ...created.map((c) => c.toObject())];
  }

  const progressMap = new Map(progressRecords.map((p) => [p.opportunity.toString(), p]));
  const items = opportunities.map((o) => ({
    ...o,
    progress: progressMap.get(o._id.toString())?.progress || 0,
    progressStatus: progressMap.get(o._id.toString())?.status || "active",
    progressId: progressMap.get(o._id.toString())?._id,
  }));

  res.status(httpStatus.OK).json({ success: true, data: items });
});

/** POST /opportunities/:id/claim — provider claims completed bonus */
export const claimBonus = catchAsync(async (req, res) => {
  const record = await ProviderOpportunity.findOne({
    provider: req.user._id,
    opportunity: req.params.id,
  }).populate("opportunity");

  if (!record) throw new AppError(httpStatus.NOT_FOUND, "Opportunity not found");
  if (record.status !== "completed") {
    throw new AppError(httpStatus.BAD_REQUEST, "Target not yet completed");
  }

  record.status = "claimed";
  record.claimedAt = new Date();
  await record.save();

  res.status(httpStatus.OK).json({
    success: true,
    data: record,
    message: "Bonus claimed! Admin will approve your payout soon.",
  });
});

/**
 * Update provider progress when a booking completes.
 * Called internally from booking completion flow.
 */
export const updateProgressOnBookingComplete = async (providerId, bookingData) => {
  try {
    const now = new Date();
    const activeOpps = await Opportunity.find({
      isActive: true,
      status: "active",
      startDate: { $lte: now },
      endDate: { $gte: now },
      $or: [
        { audience: "all" },
        { audience: "selected", selectedProviders: providerId },
      ],
    });

    for (const opp of activeOpps) {
      // Check type-specific conditions
      if (opp.type === "service" && opp.service) {
        if (bookingData.service?.toString() !== opp.service.toString()) continue;
      }
      // Location check would go here with booking address

      let record = await ProviderOpportunity.findOne({
        provider: providerId,
        opportunity: opp._id,
      });
      if (!record) {
        record = await ProviderOpportunity.create({
          provider: providerId,
          opportunity: opp._id,
        });
      }
      if (["claimed", "paid", "expired"].includes(record.status)) continue;

      record.progress += 1;
      if (record.progress >= opp.target && record.status === "active") {
        record.status = "completed";
        record.completedAt = new Date();

        try {
          emitToUser(providerId.toString(), "opportunity_completed", {
            opportunityId: opp._id.toString(),
            name: opp.name,
            reward: opp.rewardAmount,
            message: `Target reached! Claim your £${opp.rewardAmount} bonus.`,
          });
        } catch (e) { /* socket optional */ }
      }
      await record.save();
    }
  } catch (e) {
    console.error("Opportunity progress update failed:", e.message);
  }
};
