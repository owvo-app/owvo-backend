import httpStatus from "http-status";
import { ActivityLog } from "../model/activityLog.model.js";
import { User } from "../model/user.model.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";

// System Logs v2 — the old handler returned up to 200 rows with no
// search, no filter and no pagination, and populated the actor with a
// select list that missed `fullName` (so logs caused by app users, e.g.
// a self-service account deletion, showed no name). This version adds
// search (action text or actor name/email), an entity-type filter,
// real pagination, and the fullName-safe populate.

const rangeStart = (range) => {
  const now = Date.now();
  if (range === "daily") return new Date(now - 24 * 60 * 60 * 1000);
  if (range === "weekly") return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (range === "monthly") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  if (range === "yearly") return new Date(now - 365 * 24 * 60 * 60 * 1000);
  return null;
};

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getActivityLogsPaged = catchAsync(async (req, res) => {
  const page = Math.max(
    1,
    Number.parseInt(req.query.page?.toString() || "1", 10) || 1
  );
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.limit?.toString() || "20", 10) || 20)
  );
  const search = req.query.search?.toString().trim() || "";
  const entityType = req.query.entityType?.toString().trim() || "";
  const action = req.query.action?.toString().trim() || "";
  const start = rangeStart(req.query.range?.toString());

  const filter = {};
  if (start) filter.createdAt = { $gte: start };
  if (entityType) filter.entityType = entityType;
  if (action) filter.action = action;

  if (search) {
    const rx = new RegExp(escapeRegExp(search), "i");
    const matchedActors = await User.find({
      $or: [{ name: rx }, { fullName: rx }, { email: rx }],
    }).select("_id");
    filter.$or = [
      { action: rx },
      { actor: { $in: matchedActors.map((u) => u._id) } },
    ];
  }

  const [total, items, entityTypes] = await Promise.all([
    ActivityLog.countDocuments(filter),
    ActivityLog.find(filter)
      .populate("actor", "_id name fullName email role")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ActivityLog.distinct("entityType"),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Activity logs fetched successfully.",
    data: {
      items,
      total,
      page,
      limit,
      entityTypes: entityTypes.filter(Boolean).sort(),
    },
  });
});
