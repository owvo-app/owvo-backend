import httpStatus from "http-status";
import mongoose from "mongoose";
import Stripe from "stripe";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";

import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catch.Async.js";
import sendResponse from "../utils/sendResponse.js";
import { recordActivity } from "../utils/activityLog.util.js";
import { Booking } from "../model/booking.model.js";
import { User } from "../model/user.model.js";
import { Service } from "../model/service.model.js";
import { Payout } from "../model/payout.model.js";
import { Refund } from "../model/refund.model.js";
import { paymentInfo } from "../model/payment.model.js";
import { WalletTransaction } from "../model/walletTransaction.model.js";
import { AdminWithdrawal } from "../model/adminWithdrawal.model.js";
import { SupportTicket } from "../model/supportTicket.model.js";
import { Rating } from "../model/rating.model.js";
import { GeneratedReport } from "../model/generatedReport.model.js";
import { asMoney, getCurrentCommissionRate } from "../utils/money.util.js";

/* ════════════════════════════════════════════════════════════════════
   Reports & Analytics — saare numbers Earnings / Payments wale hi
   ledger source se: completed bookings ke SNAPSHOT fields
   (commissionAmount / providerNetAmount), Refund, Payout, paymentInfo.
   Commission kabhi current rate se dobara nahi banta — snapshot na ho
   to booking ke apne fixed rate se, woh bhi na ho to current rate.
   ════════════════════════════════════════════════════════════════════ */

// ─── money expressions (snapshot-first) ──────────────────────────────
const commExpr = (fallbackRate) => ({
  $ifNull: [
    "$commissionAmount",
    {
      $multiply: [
        { $ifNull: ["$finalPrice", 0] },
        { $divide: [{ $ifNull: ["$commissionRate", fallbackRate] }, 100] },
      ],
    },
  ],
});
const netExpr = (fallbackRate) => ({
  $ifNull: [
    "$providerNetAmount",
    { $subtract: [{ $ifNull: ["$finalPrice", 0] }, commExpr(fallbackRate)] },
  ],
});

// ─── date helpers (admin.controller wala hi usool: Topbar range) ────
const startOfDay = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const startOfWeek = (date = new Date()) => {
  const value = startOfDay(date);
  const day = value.getDay();
  const diff = day === 0 ? 6 : day - 1;
  value.setDate(value.getDate() - diff);
  return value;
};
const startOfMonth = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), 1);
const startOfYear = (date = new Date()) => new Date(date.getFullYear(), 0, 1);

const getDateRange = (query = {}) => {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  let from;
  switch (query.range) {
    case "daily":
      from = startOfDay(to);
      break;
    case "monthly":
      from = startOfMonth(to);
      break;
    case "yearly":
      from = startOfYear(to);
      break;
    case "all":
      from = null;
      break;
    case "weekly":
    default:
      from = startOfWeek(to);
      break;
  }
  if (query.from) from = new Date(query.from);
  if (Number.isNaN(to.getTime()))
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid 'to' date");
  if (from && Number.isNaN(from.getTime()))
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid 'from' date");
  return { from, to, key: query.range || "weekly" };
};

const prevRangeOf = ({ from, to }) => {
  if (!from) return null;
  const span = to.getTime() - from.getTime();
  if (span <= 0) return null;
  return { from: new Date(from.getTime() - span), to: new Date(from.getTime()) };
};
const inRange = (field, { from, to }) =>
  from ? { [field]: { $gte: from, $lte: to } } : {};
const pctChange = (cur, prev) => {
  if (prev == null || !prev) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
};

const rangeLabelOf = ({ from, to, key }) => {
  if (!from || key === "all") return "All Time";
  const fmt = (d) =>
    d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Europe/London",
    });
  return `${fmt(from)} – ${fmt(to)}`;
};

// Provider ke #P00x numbers — Providers page wala join-order usool.
const providerNumberMap = async () => {
  const providers = await User.find({
    role: "provider",
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .select("_id")
    .lean();
  const map = new Map();
  providers.forEach((p, i) =>
    map.set(String(p._id), `#P${String(i + 1).padStart(3, "0")}`)
  );
  return map;
};

// ─── ledger totals ───────────────────────────────────────────────────
const completedMoney = async (range) => {
  const rate = await getCurrentCommissionRate();
  const [row] = await Booking.aggregate([
    { $match: { status: "completed", ...inRange("completedAt", range) } },
    {
      $group: {
        _id: null,
        gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
        commission: { $sum: commExpr(rate) },
        net: { $sum: netExpr(rate) },
        count: { $sum: 1 },
      },
    },
  ]);
  return {
    gross: asMoney(row?.gross),
    commission: asMoney(row?.commission),
    net: asMoney(row?.net),
    count: row?.count || 0,
  };
};

const refundsTotal = async (range) => {
  const pipe = [
    { $match: { status: "refunded" } },
    {
      $addFields: {
        __eff: { $ifNull: ["$refundedAt", "$createdAt"] },
      },
    },
  ];
  if (range.from)
    pipe.push({ $match: { __eff: { $gte: range.from, $lte: range.to } } });
  pipe.push({
    $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
  });
  const [row] = await Refund.aggregate(pipe);
  return { total: asMoney(row?.total), count: row?.count || 0 };
};
const paidOutTotal = async (range) => {
  const pipe = [
    { $match: { status: "paid" } },
    {
      $addFields: {
        __eff: { $ifNull: ["$paidAt", { $ifNull: ["$updatedAt", "$createdAt"] }] },
      },
    },
  ];
  if (range.from)
    pipe.push({ $match: { __eff: { $gte: range.from, $lte: range.to } } });
  pipe.push({
    $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
  });
  const [row] = await Payout.aggregate(pipe);
  return { total: asMoney(row?.total), count: row?.count || 0 };
};

const tipsTotal = async (range) => {
  const [row] = await paymentInfo.aggregate([
    {
      $match: {
        type: "tips",
        paymentStatus: "complete",
        ...inRange("createdAt", range),
      },
    },
    { $group: { _id: null, total: { $sum: "$price" } } },
  ]);
  return asMoney(row?.total);
};

// ─── daily series + rollup ───────────────────────────────────────────
const dailyMoneySeries = async (range) => {
  const rate = await getCurrentCommissionRate();
  const rows = await Booking.aggregate([
    { $match: { status: "completed", ...inRange("completedAt", range) } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$completedAt",
            timezone: "Europe/London",
          },
        },
        gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
        commission: { $sum: commExpr(rate) },
        net: { $sum: netExpr(rate) },
        jobs: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({
    date: r._id,
    gross: asMoney(r.gross),
    commission: asMoney(r.commission),
    net: asMoney(r.net),
    jobs: r.jobs,
  }));
};

const dayKeyLondon = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const fillDaily = (series, from, to) => {
  if (!from || !to) return series;
  const byDay = new Map(series.map((s) => [s.date, s]));
  const out = [];
  const cursor = new Date(from);
  let guard = 0;
  while (cursor <= to && guard < 800) {
    const key = dayKeyLondon(cursor);
    out.push(
      byDay.get(key) || { date: key, gross: 0, commission: 0, net: 0, jobs: 0 }
    );
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return out;
};

const rollupSeries = (daily, grouping) => {
  if (grouping === "daily") return daily;
  const map = new Map();
  for (const d of daily) {
    let label;
    if (grouping === "monthly") label = d.date.slice(0, 7);
    else {
      const dt = new Date(`${d.date}T12:00:00Z`);
      const dow = dt.getUTCDay();
      const diff = dow === 0 ? 6 : dow - 1;
      dt.setUTCDate(dt.getUTCDate() - diff);
      label = dt.toISOString().slice(0, 10);
    }
    const cur =
      map.get(label) || { date: label, gross: 0, commission: 0, net: 0, jobs: 0 };
    cur.gross += d.gross;
    cur.commission += d.commission;
    cur.net += d.net;
    cur.jobs += d.jobs || 0;
    map.set(label, cur);
  }
  return [...map.values()].map((r) => ({
    ...r,
    gross: asMoney(r.gross),
    commission: asMoney(r.commission),
    net: asMoney(r.net),
  }));
};


/* ════════════════ 1) OVERVIEW ════════════════ */
export const getAnalyticsOverview = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);
  const prev = prevRangeOf(range);
  const rate = await getCurrentCommissionRate();

  const [curMoney, curRefunds, curPaid, prevMoney, prevRefunds, prevPaid] =
    await Promise.all([
      completedMoney(range),
      refundsTotal(range),
      paidOutTotal(range),
      prev ? completedMoney(prev) : Promise.resolve(null),
      prev ? refundsTotal(prev) : Promise.resolve(null),
      prev ? paidOutTotal(prev) : Promise.resolve(null),
    ]);
  const [curBookings, prevBookings] = await Promise.all([
    Booking.countDocuments({ ...inRange("createdAt", range) }),
    prev
      ? Booking.countDocuments({ ...inRange("createdAt", prev) })
      : Promise.resolve(null),
  ]);

  const kpi = (key, value, prevValue, money = true) => ({
    key,
    value,
    prev: prevValue,
    changePct: prevValue == null ? null : pctChange(value, prevValue),
    money,
  });
  const kpis = [
    kpi("totalBookings", curBookings, prevBookings, false),
    kpi("grossVolume", curMoney.gross, prevMoney?.gross),
    kpi("commission", curMoney.commission, prevMoney?.commission),
    kpi("providerEarnings", curMoney.net, prevMoney?.net),
    kpi("refunds", curRefunds.total, prevRefunds?.total),
    kpi("paidOut", curPaid.total, prevPaid?.total),
  ];

  // status distribution (range me bani bookings)
  const statusRows = await Booking.aggregate([
    { $match: { ...inRange("createdAt", range) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const statusDistribution = statusRows
    .map((r) => ({ status: r._id, count: r.count }))
    .sort((a, b) => b.count - a.count);

  // bookings by service (donut: top 4 + others)
  const serviceRows = await Booking.aggregate([
    { $match: { ...inRange("createdAt", range) } },
    { $group: { _id: "$service", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const serviceIds = serviceRows.map((r) => r._id).filter(Boolean);
  const services = await Service.find({ _id: { $in: serviceIds } })
    .select("title")
    .lean();
  const titleOf = new Map(services.map((s) => [String(s._id), s.title]));
  const totalForShare = serviceRows.reduce((a, r) => a + r.count, 0) || 1;
  const byService = [];
  let others = 0;
  serviceRows.forEach((r, i) => {
    if (i < 4)
      byService.push({
        serviceId: String(r._id || ""),
        title: titleOf.get(String(r._id)) || "Service",
        count: r.count,
        pct: Math.round((r.count / totalForShare) * 1000) / 10,
      });
    else others += r.count;
  });
  if (others)
    byService.push({
      serviceId: "",
      title: "Others",
      count: others,
      pct: Math.round((others / totalForShare) * 1000) / 10,
    });

  // top providers (earnings) — top 3
  const numbers = await providerNumberMap();
  const topProviderRows = await Booking.aggregate([
    { $match: { status: "completed", ...inRange("completedAt", range) } },
    {
      $group: {
        _id: "$provider",
        net: { $sum: netExpr(rate) },
        jobs: { $sum: 1 },
      },
    },
    { $sort: { net: -1 } },
    { $limit: 3 },
  ]);
  const topProviderUsers = await User.find({
    _id: { $in: topProviderRows.map((r) => r._id) },
  })
    .select("fullName name profileImage")
    .lean();
  const tpMap = new Map(topProviderUsers.map((u) => [String(u._id), u]));
  const topProviders = topProviderRows.map((r) => ({
    providerId: String(r._id),
    number: numbers.get(String(r._id)) || "",
    name: dispName(tpMap.get(String(r._id)), "Provider"),
    profileImage: tpMap.get(String(r._id))?.profileImage || "",
    earnings: asMoney(r.net),
    jobs: r.jobs,
  }));

  // top services (revenue) — top 4
  const topServiceRows = await Booking.aggregate([
    { $match: { status: "completed", ...inRange("completedAt", range) } },
    {
      $group: {
        _id: "$service",
        revenue: { $sum: { $ifNull: ["$finalPrice", 0] } },
        jobs: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 4 },
  ]);
  const tsIds = topServiceRows.map((r) => r._id).filter(Boolean);
  const tsDocs = await Service.find({ _id: { $in: tsIds } }).select("title").lean();
  const tsMap = new Map(tsDocs.map((s) => [String(s._id), s.title]));
  const topServices = topServiceRows.map((r) => ({
    serviceId: String(r._id || ""),
    title: tsMap.get(String(r._id)) || "Service",
    revenue: asMoney(r.revenue),
    jobs: r.jobs,
  }));

  const openDisputes = await SupportTicket.countDocuments({
    type: "dispute",
    status: { $in: ["open", "in_progress"] },
  });

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Analytics overview fetched",
    data: {
      range: { from: range.from, to: range.to, label: rangeLabelOf(range) },
      kpis,
      statusDistribution,
      byService,
      topProviders,
      topServices,
      openDisputes,
    },
  });
});

/* ════════════════ 2) TREND (Revenue & Commission) ════════════════ */
export const getAnalyticsTrend = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);
  const grouping = ["daily", "weekly", "monthly"].includes(req.query.grouping)
    ? req.query.grouping
    : "daily";
  let daily = await dailyMoneySeries(range);
  if (range.from) daily = fillDaily(daily, range.from, range.to);
  const series = rollupSeries(daily, grouping).map((d) => ({
    label: d.date,
    gross: d.gross,
    commission: d.commission,
  }));
  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Analytics trend fetched",
    data: { grouping, series },
  });
});

/* ════════════════ 3) BOOKINGS TAB ════════════════ */
export const getAnalyticsBookings = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);

  const [statusRows, typeRows, createdDaily, completedDaily] = await Promise.all([
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      { $group: { _id: "$bookingType", count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Europe/London",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Booking.aggregate([
      { $match: { status: "completed", ...inRange("completedAt", range) } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$completedAt",
              timezone: "Europe/London",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const countOf = (rows, key) => rows.find((r) => r._id === key)?.count || 0;
  const completed = countOf(statusRows, "completed");
  const cancelled = countOf(statusRows, "cancelled");
  const declined = countOf(statusRows, "declined");
  const decided = completed + cancelled + declined;
  const completionRate = decided
    ? Math.round((completed / decided) * 1000) / 10
    : null;
  const cancelRate = decided
    ? Math.round((cancelled / decided) * 1000) / 10
    : null;

  const createdMap = new Map(createdDaily.map((r) => [r._id, r.count]));
  const completedMap = new Map(completedDaily.map((r) => [r._id, r.count]));
  let trend;
  if (range.from) {
    trend = fillDaily(
      [...createdMap.keys()].map((date) => ({
        date,
        gross: 0,
        commission: 0,
        net: 0,
        jobs: 0,
      })),
      range.from,
      range.to
    ).map((d) => ({
      date: d.date,
      created: createdMap.get(d.date) || 0,
      completed: completedMap.get(d.date) || 0,
    }));
  } else {
    const keys = [...new Set([...createdMap.keys(), ...completedMap.keys()])].sort();
    trend = keys.map((date) => ({
      date,
      created: createdMap.get(date) || 0,
      completed: completedMap.get(date) || 0,
    }));
  }

  // cancellation kis ne ki (statusHistory me jahan record hai)
  const cancelByRows = await Booking.aggregate([
    { $match: { status: "cancelled", ...inRange("createdAt", range) } },
    { $unwind: "$statusHistory" },
    { $match: { "statusHistory.status": "cancelled" } },
    { $group: { _id: "$statusHistory.by", count: { $sum: 1 } } },
  ]);
  const cancelledBy = cancelByRows.map((r) => ({
    by: r._id || "unknown",
    count: r.count,
  }));

  // peak hours + weekdays (London) — createdAt par
  const stamps = await Booking.find({ ...inRange("createdAt", range) })
    .select("createdAt")
    .lean();
  const hourFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
  });
  const dayFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
  });
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  const dayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const byWeekday = dayOrder.map((d) => ({ day: d, count: 0 }));
  for (const s of stamps) {
    const h = parseInt(hourFmt.format(s.createdAt), 10) % 24;
    if (!Number.isNaN(h)) byHour[h].count += 1;
    const d = dayFmt.format(s.createdAt);
    const row = byWeekday.find((x) => x.day === d);
    if (row) row.count += 1;
  }

  const recentCancellations = await Booking.find({
    status: "cancelled",
    ...inRange("createdAt", range),
  })
    .sort({ updatedAt: -1 })
    .limit(10)
    .populate("user", "fullName")
    .populate("provider", "fullName")
    .populate("service", "title")
    .select("user provider service updatedAt finalPrice")
    .lean();

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Booking analytics fetched",
    data: {
      counts: Object.fromEntries(statusRows.map((r) => [r._id, r.count])),
      total: statusRows.reduce((a, r) => a + r.count, 0),
      completionRate,
      cancelRate,
      nowLater: {
        now: countOf(typeRows, "now"),
        later: countOf(typeRows, "later"),
      },
      trend,
      cancelledBy,
      byHour,
      byWeekday,
      recentCancellations: recentCancellations.map((b) => ({
        id: String(b._id),
        customer: dispName(b.user, "Customer"),
        provider: dispName(b.provider, "Provider"),
        service: b.service?.title || "Service",
        amount: asMoney(b.finalPrice),
        at: b.updatedAt,
      })),
    },
  });
});


/* ════════════════ helpers for revenue/financial ════════════════ */
const methodSplit = async (range) => {
  const [row] = await Booking.aggregate([
    { $match: { status: "completed", ...inRange("completedAt", range) } },
    {
      $addFields: {
        __wallet: { $ifNull: ["$payment.walletAmount", 0] },
        __card: {
          $ifNull: [
            "$payment.cardAmount",
            {
              $subtract: [
                { $ifNull: ["$finalPrice", 0] },
                { $ifNull: ["$payment.walletAmount", 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        card: { $sum: "$__card" },
        wallet: { $sum: "$__wallet" },
        splitCount: {
          $sum: {
            $cond: [
              { $and: [{ $gt: ["$__wallet", 0] }, { $gt: ["$__card", 0] }] },
              1,
              0,
            ],
          },
        },
        walletOnly: { $sum: { $cond: [{ $gt: ["$__wallet", 0] }, 1, 0] } },
      },
    },
  ]);
  return {
    card: asMoney(row?.card),
    wallet: asMoney(row?.wallet),
    splitBookings: row?.splitCount || 0,
    walletBookings: row?.walletOnly || 0,
  };
};

const dailySumBy = async (pipeline) => {
  const rows = await pipeline;
  return new Map(rows.map((r) => [r._id, asMoney(r.total)]));
};

/* ════════════════ 4) REVENUE TAB ════════════════ */
export const getAnalyticsRevenue = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);
  const grouping = ["daily", "weekly", "monthly"].includes(req.query.grouping)
    ? req.query.grouping
    : "monthly";
  const rate = await getCurrentCommissionRate();

  let daily = await dailyMoneySeries(range);
  if (range.from) daily = fillDaily(daily, range.from, range.to);

  const tipsMap = await dailySumBy(
    paymentInfo.aggregate([
      {
        $match: {
          type: "tips",
          paymentStatus: "complete",
          ...inRange("createdAt", range),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Europe/London",
            },
          },
          total: { $sum: "$price" },
        },
      },
    ])
  );
  const refundsMap = await dailySumBy(
    Refund.aggregate([
      { $match: { status: "refunded" } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $ifNull: ["$refundedAt", "$createdAt"] },
              timezone: "Europe/London",
            },
          },
          total: { $sum: "$amount" },
        },
      },
    ]).then((rows) =>
      range.from
        ? rows.filter((r) => {
            const fromK = dayKeyLondon(range.from);
            const toK = dayKeyLondon(range.to);
            return r._id >= fromK && r._id <= toK;
          })
        : rows
    )
  );

  const merged = daily.map((d) => ({
    ...d,
    tips: tipsMap.get(d.date) || 0,
    refunds: refundsMap.get(d.date) || 0,
  }));
  const rollupGeneric = (rows, g) => {
    if (g === "daily") return rows;
    const map = new Map();
    for (const d of rows) {
      let label;
      if (g === "monthly") label = d.date.slice(0, 7);
      else {
        const dt = new Date(`${d.date}T12:00:00Z`);
        const dow = dt.getUTCDay();
        const diff = dow === 0 ? 6 : dow - 1;
        dt.setUTCDate(dt.getUTCDate() - diff);
        label = dt.toISOString().slice(0, 10);
      }
      const cur =
        map.get(label) ||
        { date: label, gross: 0, commission: 0, net: 0, jobs: 0, tips: 0, refunds: 0 };
      for (const k of ["gross", "commission", "net", "tips", "refunds"])
        cur[k] += d[k] || 0;
      cur.jobs += d.jobs || 0;
      map.set(label, cur);
    }
    return [...map.values()].map((r) => ({
      ...r,
      gross: asMoney(r.gross),
      commission: asMoney(r.commission),
      net: asMoney(r.net),
      tips: asMoney(r.tips),
      refunds: asMoney(r.refunds),
      netRevenue: asMoney(r.gross - r.refunds),
    }));
  };
  const periods = rollupGeneric(merged, grouping).map((r) =>
    grouping === "daily"
      ? { ...r, netRevenue: asMoney(r.gross - r.refunds) }
      : r
  );

  const serviceRows = await Booking.aggregate([
    { $match: { status: "completed", ...inRange("completedAt", range) } },
    {
      $group: {
        _id: "$service",
        jobs: { $sum: 1 },
        gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
        commission: { $sum: commExpr(rate) },
        net: { $sum: netExpr(rate) },
      },
    },
    { $sort: { gross: -1 } },
  ]);
  const sDocs = await Service.find({
    _id: { $in: serviceRows.map((r) => r._id).filter(Boolean) },
  })
    .select("title")
    .lean();
  const sMap = new Map(sDocs.map((s) => [String(s._id), s.title]));
  const byService = serviceRows.map((r) => ({
    serviceId: String(r._id || ""),
    title: sMap.get(String(r._id)) || "Service",
    jobs: r.jobs,
    gross: asMoney(r.gross),
    commission: asMoney(r.commission),
    net: asMoney(r.net),
  }));

  const split = await methodSplit(range);
  const totalsRow = periods.reduce(
    (a, r) => ({
      gross: a.gross + r.gross,
      commission: a.commission + r.commission,
      net: a.net + r.net,
      tips: a.tips + (r.tips || 0),
      refunds: a.refunds + (r.refunds || 0),
    }),
    { gross: 0, commission: 0, net: 0, tips: 0, refunds: 0 }
  );

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Revenue analytics fetched",
    data: {
      grouping,
      periods,
      byService,
      methodSplit: split,
      totals: {
        ...totalsRow,
        gross: asMoney(totalsRow.gross),
        commission: asMoney(totalsRow.commission),
        net: asMoney(totalsRow.net),
        tips: asMoney(totalsRow.tips),
        refunds: asMoney(totalsRow.refunds),
        netRevenue: asMoney(totalsRow.gross - totalsRow.refunds),
      },
    },
  });
});

/* ════════════════ 5) PROVIDERS TAB ════════════════ */
export const getAnalyticsProviders = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);
  const rate = await getCurrentCommissionRate();
  const numbers = await providerNumberMap();

  const [jobRows, tipRows, ratingRows, signupCount] = await Promise.all([
    Booking.aggregate([
      { $match: { status: "completed", ...inRange("completedAt", range) } },
      {
        $group: {
          _id: "$provider",
          jobs: { $sum: 1 },
          gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
          commission: { $sum: commExpr(rate) },
          net: { $sum: netExpr(rate) },
        },
      },
      { $sort: { net: -1 } },
      { $limit: 100 },
    ]),
    paymentInfo.aggregate([
      {
        $match: {
          type: "tips",
          paymentStatus: "complete",
          ...inRange("createdAt", range),
        },
      },
      { $group: { _id: "$providerId", total: { $sum: "$price" } } },
    ]),
    Rating.aggregate([
      {
        $group: {
          _id: "$provider",
          avg: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ]),
    User.countDocuments({
      role: "provider",
      isDeleted: { $ne: true },
      ...inRange("createdAt", range),
    }),
  ]);
  const decidedRows = await Booking.aggregate([
    { $match: { ...inRange("createdAt", range) } },
    {
      $group: {
        _id: "$provider",
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        decided: {
          $sum: {
            $cond: [
              { $in: ["$status", ["completed", "cancelled", "declined"]] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  const tipMap = new Map(tipRows.map((r) => [String(r._id), asMoney(r.total)]));
  const ratingMap = new Map(
    ratingRows.map((r) => [
      String(r._id),
      { avg: Math.round((r.avg || 0) * 10) / 10, count: r.count },
    ])
  );
  const decidedMap = new Map(decidedRows.map((r) => [String(r._id), r]));
  const users = await User.find({ _id: { $in: jobRows.map((r) => r._id) } })
    .select("fullName name profileImage isOnline accountStatus")
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));

  const leaderboard = jobRows.map((r) => {
    const id = String(r._id);
    const dec = decidedMap.get(id);
    return {
      providerId: id,
      number: numbers.get(id) || "",
      name: dispName(uMap.get(id), "Provider"),
      profileImage: uMap.get(id)?.profileImage || "",
      isOnline: !!uMap.get(id)?.isOnline,
      accountStatus: uMap.get(id)?.accountStatus || "active",
      jobs: r.jobs,
      gross: asMoney(r.gross),
      commission: asMoney(r.commission),
      net: asMoney(r.net),
      tips: tipMap.get(id) || 0,
      rating: ratingMap.get(id)?.avg ?? null,
      ratingCount: ratingMap.get(id)?.count || 0,
      completionRate:
        dec && dec.decided
          ? Math.round((dec.completed / dec.decided) * 1000) / 10
          : null,
    };
  });

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Provider analytics fetched",
    data: { signupCount, leaderboard },
  });
});

/* ════════════════ 6) CUSTOMERS TAB ════════════════ */
export const getAnalyticsCustomers = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);

  const [signupDaily, totalCustomers, perUser, topRows] = await Promise.all([
    User.aggregate([
      {
        $match: {
          role: "user",
          isDeleted: { $ne: true },
          ...inRange("createdAt", range),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Europe/London",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    User.countDocuments({ role: "user", isDeleted: { $ne: true } }),
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      { $group: { _id: "$user", bookings: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      {
        $group: {
          _id: "$user",
          bookings: { $sum: 1 },
          spent: {
            $sum: {
              $cond: [
                { $eq: ["$status", "completed"] },
                { $ifNull: ["$finalPrice", 0] },
                0,
              ],
            },
          },
          lastBooking: { $max: "$createdAt" },
        },
      },
      { $sort: { spent: -1 } },
      { $limit: 10 },
    ]),
  ]);

  let signupSeries = signupDaily.map((r) => ({ date: r._id, count: r.count }));
  if (range.from) {
    const m = new Map(signupSeries.map((s) => [s.date, s.count]));
    signupSeries = fillDaily(
      signupSeries.map((s) => ({
        date: s.date,
        gross: 0,
        commission: 0,
        net: 0,
        jobs: 0,
      })),
      range.from,
      range.to
    ).map((d) => ({ date: d.date, count: m.get(d.date) || 0 }));
  }
  const bookingCustomers = perUser.length;
  const repeatCustomers = perUser.filter((r) => r.bookings >= 2).length;
  const repeatRate = bookingCustomers
    ? Math.round((repeatCustomers / bookingCustomers) * 1000) / 10
    : null;

  const users = await User.find({ _id: { $in: topRows.map((r) => r._id) } })
    .select("fullName name profileImage createdAt")
    .lean();
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const topCustomers = topRows.map((r) => ({
    customerId: String(r._id),
    name: dispName(uMap.get(String(r._id)), "Customer"),
    profileImage: uMap.get(String(r._id))?.profileImage || "",
    bookings: r.bookings,
    spent: asMoney(r.spent),
    lastBooking: r.lastBooking,
  }));

  let inactiveCount = null;
  if (range.from) {
    const [beforeIds, inRangeIds] = await Promise.all([
      Booking.distinct("user", { createdAt: { $lt: range.from } }),
      Booking.distinct("user", inRange("createdAt", range)),
    ]);
    const inSet = new Set(inRangeIds.map(String));
    inactiveCount = beforeIds.filter((id) => !inSet.has(String(id))).length;
  }

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Customer analytics fetched",
    data: {
      totalCustomers,
      newSignups: signupDaily.reduce((a, r) => a + r.count, 0),
      signupSeries,
      bookingCustomers,
      repeatCustomers,
      repeatRate,
      topCustomers,
      inactiveCount,
    },
  });
});

/* ════════════════ 7) SERVICES TAB ════════════════ */
export const getAnalyticsServices = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);
  const rate = await getCurrentCommissionRate();

  const [rows, addonRows, totalBookings, withAddons] = await Promise.all([
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      {
        $group: {
          _id: "$service",
          bookings: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$status", "completed"] },
                { $ifNull: ["$finalPrice", 0] },
                0,
              ],
            },
          },
          commission: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, commExpr(rate), 0],
            },
          },
        },
      },
      { $sort: { bookings: -1 } },
    ]),
    Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      { $unwind: "$addons" },
      {
        $group: {
          _id: "$addons.name",
          times: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$addons.price", 0] } },
        },
      },
      { $sort: { times: -1 } },
    ]),
    Booking.countDocuments({ ...inRange("createdAt", range) }),
    Booking.countDocuments({
      ...inRange("createdAt", range),
      "addons.0": { $exists: true },
    }),
  ]);
  const docs = await Service.find({
    _id: { $in: rows.map((r) => r._id).filter(Boolean) },
  })
    .select("title basePrice isActive")
    .lean();
  const sMap = new Map(docs.map((s) => [String(s._id), s]));
  const services = rows.map((r) => ({
    serviceId: String(r._id || ""),
    title: sMap.get(String(r._id))?.title || "Service",
    basePrice: sMap.get(String(r._id))?.basePrice ?? null,
    isActive: sMap.get(String(r._id))?.isActive ?? null,
    bookings: r.bookings,
    share: totalBookings
      ? Math.round((r.bookings / totalBookings) * 1000) / 10
      : 0,
    revenue: asMoney(r.revenue),
    commission: asMoney(r.commission),
  }));
  const addons = addonRows.map((r) => ({
    name: r._id || "Add-on",
    times: r.times,
    revenue: asMoney(r.revenue),
  }));
  const attachRate = totalBookings
    ? Math.round((withAddons / totalBookings) * 1000) / 10
    : null;

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Service analytics fetched",
    data: { services, addons, attachRate, totalBookings },
  });
});

/* ════════════════ 8) FINANCIAL TAB ════════════════ */
const stripeSnapshot = async () => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const balance = await stripe.balance.retrieve();
    const sum = (arr) =>
      asMoney((arr || []).reduce((a, b) => a + (b.amount || 0), 0) / 100);
    return {
      available: sum(balance.available),
      pending: sum(balance.pending),
      currency: (balance.available?.[0]?.currency || "gbp").toUpperCase(),
    };
  } catch {
    return null;
  }
};

export const getAnalyticsFinancial = catchAsync(async (req, res) => {
  const range = getDateRange(req.query);
  const [split, payoutRows, refundRows, topups, walletPays, withdrawals, stripe] =
    await Promise.all([
      methodSplit(range),
      Payout.aggregate([
        { $match: { ...inRange("createdAt", range) } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            total: { $sum: "$amount" },
          },
        },
      ]),
      Refund.aggregate([
        { $match: { ...inRange("createdAt", range) } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            total: { $sum: "$amount" },
          },
        },
      ]),
      WalletTransaction.aggregate([
        {
          $match: {
            type: "topup",
            status: "complete",
            ...inRange("createdAt", range),
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      WalletTransaction.aggregate([
        {
          $match: {
            type: "payment",
            status: "complete",
            ...inRange("createdAt", range),
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      AdminWithdrawal.aggregate([
        { $match: { status: { $ne: "failed" }, ...inRange("createdAt", range) } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      stripeSnapshot(),
    ]);
  const [refunded, paidOut] = await Promise.all([
    refundsTotal(range),
    paidOutTotal(range),
  ]);
  const byStatus = (rows) =>
    rows.map((r) => ({ status: r._id, count: r.count, total: asMoney(r.total) }));

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Financial analytics fetched",
    data: {
      methodSplit: split,
      payoutsByStatus: byStatus(payoutRows),
      refundsByStatus: byStatus(refundRows),
      refundsProcessed: refunded,
      paidOut,
      walletTopups: {
        total: asMoney(topups[0]?.total),
        count: topups[0]?.count || 0,
      },
      walletPayments: {
        total: asMoney(walletPays[0]?.total),
        count: walletPays[0]?.count || 0,
      },
      commissionWithdrawals: {
        total: asMoney(withdrawals[0]?.total),
        count: withdrawals[0]?.count || 0,
      },
      stripe,
    },
  });
});


/* ════════════════ REPORT GENERATION ════════════════ */
const REPORT_TYPES = [
  "earnings",
  "payouts",
  "refunds",
  "bookings",
  "services",
  "customers",
  "financial",
];
const TYPE_LABELS = {
  earnings: "Earnings",
  payouts: "Payouts",
  refunds: "Refunds",
  bookings: "Bookings",
  services: "Services",
  customers: "Customers",
  financial: "Financial Summary",
};
const moneyStr = (n) => `£${asMoney(n).toFixed(2)}`;
const dateStr = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Europe/London",
      })
    : "—";
const shortBookingId = (id) => `#B${String(id).slice(-6).toUpperCase()}`;
const dispName = (u, fallback) => u?.fullName || u?.name || fallback;
const bucketLabel = (dateStrValue, groupBy) => {
  if (groupBy === "month") return dateStrValue.slice(0, 7);
  if (groupBy === "week") {
    const dt = new Date(`${dateStrValue}T12:00:00Z`);
    const dow = dt.getUTCDay();
    const diff = dow === 0 ? 6 : dow - 1;
    dt.setUTCDate(dt.getUTCDate() - diff);
    return dt.toISOString().slice(0, 10);
  }
  return dateStrValue;
};

const buildReportData = async ({ type, groupBy = "day", range, filters = {} }) => {
  const rate = await getCurrentCommissionRate();
  const title = `${TYPE_LABELS[type] || "Report"} Report`;
  const fStatus = filters?.status || null;
  const fProvider =
    filters?.providerId && mongoose.Types.ObjectId.isValid(filters.providerId)
      ? new mongoose.Types.ObjectId(filters.providerId)
      : null;
  const fService =
    filters?.serviceId && mongoose.Types.ObjectId.isValid(filters.serviceId)
      ? new mongoose.Types.ObjectId(filters.serviceId)
      : null;
  const fPayStatus = filters?.paymentStatus || null;

  if (type === "earnings") {
    if (groupBy === "provider") {
      const match = {
        status: "completed",
        ...inRange("completedAt", range),
        ...(fProvider ? { provider: fProvider } : {}),
        ...(fService ? { service: fService } : {}),
      };
      const rows = await Booking.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$provider",
            jobs: { $sum: 1 },
            gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
            commission: { $sum: commExpr(rate) },
            net: { $sum: netExpr(rate) },
          },
        },
        { $sort: { net: -1 } },
      ]);
      const users = await User.find({ _id: { $in: rows.map((r) => r._id) } })
        .select("fullName name")
        .lean();
      const m = new Map(users.map((u) => [String(u._id), u.fullName]));
      return {
        title,
        columns: [
          { key: "provider", label: "Provider" },
          { key: "jobs", label: "Jobs" },
          { key: "gross", label: "Gross" },
          { key: "commission", label: "Commission" },
          { key: "net", label: "Provider Net" },
        ],
        rows: rows.map((r) => ({
          provider: dispName(m.get(String(r._id)), "Provider"),
          jobs: r.jobs,
          gross: moneyStr(r.gross),
          commission: moneyStr(r.commission),
          net: moneyStr(r.net),
        })),
      };
    }
    if (groupBy === "service") {
      const rows = await Booking.aggregate([
        {
          $match: {
            status: "completed",
            ...inRange("completedAt", range),
            ...(fProvider ? { provider: fProvider } : {}),
            ...(fService ? { service: fService } : {}),
          },
        },
        {
          $group: {
            _id: "$service",
            jobs: { $sum: 1 },
            gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
            commission: { $sum: commExpr(rate) },
            net: { $sum: netExpr(rate) },
          },
        },
        { $sort: { gross: -1 } },
      ]);
      const docs = await Service.find({
        _id: { $in: rows.map((r) => r._id).filter(Boolean) },
      })
        .select("title")
        .lean();
      const m = new Map(docs.map((s) => [String(s._id), s.title]));
      return {
        title,
        columns: [
          { key: "service", label: "Service" },
          { key: "jobs", label: "Jobs" },
          { key: "gross", label: "Gross" },
          { key: "commission", label: "Commission" },
          { key: "net", label: "Provider Net" },
        ],
        rows: rows.map((r) => ({
          service: m.get(String(r._id)) || "Service",
          jobs: r.jobs,
          gross: moneyStr(r.gross),
          commission: moneyStr(r.commission),
          net: moneyStr(r.net),
        })),
      };
    }
    // day / week / month
    let daily = await dailyMoneySeries(range);
    if (range.from) daily = fillDaily(daily, range.from, range.to);
    if (fProvider || fService) {
      // filter laga ho to daily series filtered aggregate se
      const rows = await Booking.aggregate([
        {
          $match: {
            status: "completed",
            ...inRange("completedAt", range),
            ...(fProvider ? { provider: fProvider } : {}),
            ...(fService ? { service: fService } : {}),
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$completedAt",
                timezone: "Europe/London",
              },
            },
            gross: { $sum: { $ifNull: ["$finalPrice", 0] } },
            commission: { $sum: commExpr(rate) },
            net: { $sum: netExpr(rate) },
            jobs: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      daily = rows.map((r) => ({
        date: r._id,
        gross: asMoney(r.gross),
        commission: asMoney(r.commission),
        net: asMoney(r.net),
        jobs: r.jobs,
      }));
      if (range.from) daily = fillDaily(daily, range.from, range.to);
    }
    const tipsMap = await dailySumBy(
      paymentInfo.aggregate([
        {
          $match: {
            type: "tips",
            paymentStatus: "complete",
            ...inRange("createdAt", range),
            ...(fProvider ? { providerId: fProvider } : {}),
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "Europe/London",
              },
            },
            total: { $sum: "$price" },
          },
        },
      ])
    );
    const buckets = new Map();
    for (const d of daily) {
      const label = bucketLabel(d.date, groupBy);
      const cur =
        buckets.get(label) ||
        { period: label, jobs: 0, gross: 0, commission: 0, net: 0, tips: 0 };
      cur.jobs += d.jobs || 0;
      cur.gross += d.gross;
      cur.commission += d.commission;
      cur.net += d.net;
      cur.tips += tipsMap.get(d.date) || 0;
      buckets.set(label, cur);
    }
    return {
      title,
      columns: [
        { key: "period", label: "Period" },
        { key: "jobs", label: "Jobs" },
        { key: "gross", label: "Gross" },
        { key: "commission", label: "Commission" },
        { key: "net", label: "Provider Net" },
        { key: "tips", label: "Tips" },
      ],
      rows: [...buckets.values()].map((r) => ({
        period: r.period,
        jobs: r.jobs,
        gross: moneyStr(r.gross),
        commission: moneyStr(r.commission),
        net: moneyStr(r.net),
        tips: moneyStr(r.tips),
      })),
    };
  }

  if (type === "payouts") {
    const docs = await Payout.find({
      ...inRange("createdAt", range),
      ...(fStatus ? { status: fStatus } : {}),
      ...(fProvider ? { provider: fProvider } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(5000)
      .populate("provider", "fullName")
      .lean();
    const numbers = await providerNumberMap();
    return {
      title,
      columns: [
        { key: "txn", label: "Transaction" },
        { key: "provider", label: "Provider" },
        { key: "amount", label: "Amount" },
        { key: "status", label: "Status" },
        { key: "source", label: "Source" },
        { key: "created", label: "Created" },
        { key: "paidAt", label: "Paid At" },
      ],
      rows: docs.map((p) => ({
        txn: p.txnNumber || "—",
        provider: `${numbers.get(String(p.provider?._id || p.provider)) || ""} ${
          dispName(p.provider, "Provider")
        }`.trim(),
        amount: moneyStr(p.amount),
        status: p.status,
        source: p.source || "booking",
        created: dateStr(p.createdAt),
        paidAt: dateStr(p.paidAt),
      })),
    };
  }

  if (type === "refunds") {
    const docs = await Refund.find({
      ...inRange("createdAt", range),
      ...(fStatus ? { status: fStatus } : {}),
      ...(fProvider ? { provider: fProvider } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(5000)
      .populate("user", "fullName")
      .populate("provider", "fullName")
      .lean();
    return {
      title,
      columns: [
        { key: "txn", label: "Transaction" },
        { key: "booking", label: "Booking" },
        { key: "customer", label: "Customer" },
        { key: "provider", label: "Provider" },
        { key: "amount", label: "Amount" },
        { key: "status", label: "Status" },
        { key: "reason", label: "Reason" },
        { key: "created", label: "Created" },
      ],
      rows: docs.map((r) => ({
        txn: r.txnNumber || "—",
        booking: r.booking ? shortBookingId(r.booking) : "—",
        customer: dispName(r.user, "Customer"),
        provider: dispName(r.provider, "Provider"),
        amount: moneyStr(r.amount),
        status: r.status,
        reason: r.reason || "—",
        created: dateStr(r.createdAt),
      })),
    };
  }

  if (type === "bookings") {
    const docs = await Booking.find({
      ...inRange("createdAt", range),
      ...(fStatus ? { status: fStatus } : {}),
      ...(fProvider ? { provider: fProvider } : {}),
      ...(fService ? { service: fService } : {}),
      ...(fPayStatus ? { "payment.status": fPayStatus } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(5000)
      .populate("user", "fullName")
      .populate("provider", "fullName")
      .populate("service", "title")
      .lean();
    return {
      title,
      columns: [
        { key: "booking", label: "Booking" },
        { key: "date", label: "Date" },
        { key: "customer", label: "Customer" },
        { key: "provider", label: "Provider" },
        { key: "service", label: "Service" },
        { key: "type", label: "Type" },
        { key: "status", label: "Status" },
        { key: "payment", label: "Payment" },
        { key: "amount", label: "Amount" },
        { key: "commission", label: "Commission" },
      ],
      rows: docs.map((b) => ({
        booking: shortBookingId(b._id),
        date: dateStr(b.createdAt),
        customer: dispName(b.user, "Customer"),
        provider: dispName(b.provider, "Provider"),
        service: b.service?.title || "Service",
        type: b.bookingType === "later" ? "Later" : "Now",
        status: b.status,
        payment: b.payment?.status || "—",
        amount: moneyStr(b.finalPrice),
        commission:
          b.status === "completed"
            ? moneyStr(
                b.commissionAmount ??
                  ((b.finalPrice || 0) * (b.commissionRate ?? rate)) / 100
              )
            : "—",
      })),
    };
  }

  if (type === "services") {
    const data = await Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      {
        $group: {
          _id: "$service",
          bookings: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$status", "completed"] },
                { $ifNull: ["$finalPrice", 0] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { bookings: -1 } },
    ]);
    const total = data.reduce((a, r) => a + r.bookings, 0) || 1;
    const docs = await Service.find({
      _id: { $in: data.map((r) => r._id).filter(Boolean) },
    })
      .select("title")
      .lean();
    const m = new Map(docs.map((s) => [String(s._id), s.title]));
    return {
      title,
      columns: [
        { key: "service", label: "Service" },
        { key: "bookings", label: "Bookings" },
        { key: "share", label: "Share %" },
        { key: "revenue", label: "Revenue" },
      ],
      rows: data.map((r) => ({
        service: m.get(String(r._id)) || "Service",
        bookings: r.bookings,
        share: Math.round((r.bookings / total) * 1000) / 10,
        revenue: moneyStr(r.revenue),
      })),
    };
  }

  if (type === "customers") {
    const rows = await Booking.aggregate([
      { $match: { ...inRange("createdAt", range) } },
      {
        $group: {
          _id: "$user",
          bookings: { $sum: 1 },
          spent: {
            $sum: {
              $cond: [
                { $eq: ["$status", "completed"] },
                { $ifNull: ["$finalPrice", 0] },
                0,
              ],
            },
          },
          lastBooking: { $max: "$createdAt" },
        },
      },
      { $sort: { spent: -1 } },
      { $limit: 1000 },
    ]);
    const users = await User.find({ _id: { $in: rows.map((r) => r._id) } })
      .select("fullName email createdAt")
      .lean();
    const m = new Map(users.map((u) => [String(u._id), u]));
    return {
      title,
      columns: [
        { key: "customer", label: "Customer" },
        { key: "email", label: "Email" },
        { key: "joined", label: "Joined" },
        { key: "bookings", label: "Bookings" },
        { key: "spent", label: "Spent" },
        { key: "lastBooking", label: "Last Booking" },
      ],
      rows: rows.map((r) => ({
        customer: dispName(m.get(String(r._id)), "Customer"),
        email: m.get(String(r._id))?.email || "—",
        joined: dateStr(m.get(String(r._id))?.createdAt),
        bookings: r.bookings,
        spent: moneyStr(r.spent),
        lastBooking: dateStr(r.lastBooking),
      })),
    };
  }

  // financial — metric/value summary
  const [split, refunded, paidOut, payoutPend, topups, withdrawals] =
    await Promise.all([
      methodSplit(range),
      refundsTotal(range),
      paidOutTotal(range),
      Payout.aggregate([
        {
          $match: {
            status: { $in: ["pending", "processing", "failed"] },
            ...inRange("createdAt", range),
          },
        },
        { $group: { _id: "$status", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      WalletTransaction.aggregate([
        {
          $match: {
            type: "topup",
            status: "complete",
            ...inRange("createdAt", range),
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      AdminWithdrawal.aggregate([
        { $match: { status: { $ne: "failed" }, ...inRange("createdAt", range) } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);
  const money = await completedMoney(range);
  const pendOf = (s) => payoutPend.find((r) => r._id === s);
  return {
    title,
    columns: [
      { key: "metric", label: "Metric" },
      { key: "value", label: "Value" },
    ],
    rows: [
      { metric: "Gross Volume (completed)", value: moneyStr(money.gross) },
      { metric: "OWVO Commission", value: moneyStr(money.commission) },
      { metric: "Provider Earnings (net)", value: moneyStr(money.net) },
      { metric: "Collected by Card", value: moneyStr(split.card) },
      { metric: "Collected by Wallet", value: moneyStr(split.wallet) },
      { metric: "Refunds Processed", value: moneyStr(refunded.total) },
      { metric: "Paid Out to Providers", value: moneyStr(paidOut.total) },
      {
        metric: "Payouts Pending",
        value: `${moneyStr(pendOf("pending")?.total)} (${pendOf("pending")?.count || 0})`,
      },
      {
        metric: "Payouts Processing",
        value: `${moneyStr(pendOf("processing")?.total)} (${pendOf("processing")?.count || 0})`,
      },
      {
        metric: "Payouts Failed",
        value: `${moneyStr(pendOf("failed")?.total)} (${pendOf("failed")?.count || 0})`,
      },
      { metric: "Wallet Top-ups", value: moneyStr(topups[0]?.total) },
      { metric: "Commission Withdrawals", value: moneyStr(withdrawals[0]?.total) },
    ],
  };
};

/* ════════════════ file builders ════════════════ */
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns, rows) =>
  [
    columns.map((c) => csvCell(c.label)).join(","),
    ...rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(",")),
  ].join("\n");

const toXlsx = async (sheetTitle, columns, rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report");
  const titleRow = ws.addRow([sheetTitle]);
  titleRow.font = { bold: true, size: 14 };
  const header = ws.addRow(columns.map((c) => c.label));
  header.font = { bold: true };
  for (const r of rows) ws.addRow(columns.map((c) => r[c.key] ?? ""));
  ws.columns.forEach((col) => {
    col.width = 20;
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
};

const toPdf = ({ title, meta, columns, rows }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 36,
      size: "A4",
      layout: columns.length > 5 ? "landscape" : "portrait",
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).font("Helvetica-Bold").text(title);
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#666666")
      .text(meta)
      .fillColor("#000000");
    doc.moveDown(0.7);
    const left = 36;
    const pageW = doc.page.width - left * 2;
    const colW = pageW / columns.length;
    const drawHeader = () => {
      const y = doc.y;
      doc.fontSize(8.5).font("Helvetica-Bold");
      columns.forEach((c, i) =>
        doc.text(String(c.label), left + i * colW, y, {
          width: colW - 4,
          ellipsis: true,
        })
      );
      doc.y = y + 13;
      doc
        .moveTo(left, doc.y)
        .lineTo(doc.page.width - left, doc.y)
        .strokeColor("#cccccc")
        .stroke();
      doc.moveDown(0.3);
    };
    drawHeader();
    doc.font("Helvetica").fontSize(8.5);
    for (const r of rows) {
      if (doc.y > doc.page.height - 50) {
        doc.addPage();
        drawHeader();
        doc.font("Helvetica").fontSize(8.5);
      }
      const y = doc.y;
      columns.forEach((c, i) =>
        doc.text(String(r[c.key] ?? ""), left + i * colW, y, {
          width: colW - 4,
          ellipsis: true,
        })
      );
      doc.y = y + 11;
    }
    doc.end();
  });

const buildFile = async (format, { title, meta, columns, rows }) => {
  if (format === "csv") return Buffer.from(toCsv(columns, rows), "utf8");
  if (format === "xlsx") return toXlsx(title, columns, rows);
  return toPdf({ title, meta, columns, rows });
};

const MIME = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};
const sendFile = (res, doc, inline = false) => {
  const safeName = String(doc.name || "report").replace(/[^\w\- ]+/g, "").trim() || "report";
  res.setHeader("Content-Type", MIME[doc.format] || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${safeName}.${doc.format}"`
  );
  return res.end(doc.fileData);
};

const serializeReport = (doc, userName) => ({
  id: String(doc._id),
  name: doc.name,
  type: doc.type,
  groupBy: doc.groupBy,
  filters: doc.filters || {},
  rangeLabel: doc.rangeLabel,
  rangeFrom: doc.rangeFrom,
  rangeTo: doc.rangeTo,
  format: doc.format,
  sizeBytes: doc.sizeBytes,
  rowCount: doc.rowCount,
  generatedBy:
    (doc.generatedBy && typeof doc.generatedBy === "object"
      ? doc.generatedBy.fullName || doc.generatedBy.name || null
      : null) ||
    userName ||
    null,
  createdAt: doc.createdAt,
});

/* ════════════════ 9) GENERATE ════════════════ */
export const generateAnalyticsReport = catchAsync(async (req, res) => {
  const body = req.body || {};
  const type = body.type;
  const format = body.format || "csv";
  const groupBy = ["day", "week", "month", "provider", "service", "none"].includes(
    body.groupBy
  )
    ? body.groupBy
    : "day";
  if (!REPORT_TYPES.includes(type))
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid report type");
  if (!["pdf", "xlsx", "csv"].includes(format))
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid format");

  const range = getDateRange(body);
  const filters = body.filters || {};
  const data = await buildReportData({ type, groupBy, range, filters });
  const rangeLabel = rangeLabelOf(range);
  const meta = `${rangeLabel} · Generated ${new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
  })} by ${req.user?.fullName || req.user?.name || "Admin"}`;
  const buffer = await buildFile(format, { ...data, meta });
  const name = `${data.title} (${rangeLabel})`;
  const rec = await GeneratedReport.create({
    name,
    type,
    groupBy,
    filters,
    rangeFrom: range.from,
    rangeTo: range.to,
    rangeLabel,
    format,
    fileData: buffer,
    sizeBytes: buffer.length,
    rowCount: data.rows.length,
    generatedBy: req.user._id,
  });
  await recordActivity({
    req,
    action: "analytics.report_generated",
    entityType: "GeneratedReport",
    entityId: rec._id,
    metadata: { type, format, rows: data.rows.length },
  });
  return sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Report generated",
    data: serializeReport(rec, req.user?.fullName || req.user?.name),
  });
});

/* ════════════════ 10) LIBRARY LIST ════════════════ */
export const listAnalyticsReports = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = {};
  if (req.query.type && REPORT_TYPES.includes(req.query.type))
    filter.type = req.query.type;
  if (req.query.search)
    filter.name = { $regex: String(req.query.search), $options: "i" };
  const [docs, total] = await Promise.all([
    GeneratedReport.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("generatedBy", "fullName name")
      .lean(),
    GeneratedReport.countDocuments(filter),
  ]);
  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Reports fetched",
    data: {
      reports: docs.map((d) => serializeReport(d)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    },
  });
});

/* ════════════════ 11) DOWNLOAD ════════════════ */
export const downloadAnalyticsReport = catchAsync(async (req, res) => {
  const doc = await GeneratedReport.findById(req.params.id).select("+fileData");
  if (!doc) throw new AppError(httpStatus.NOT_FOUND, "Report not found");
  return sendFile(res, doc, false);
});

/* ════════════════ 12) PREVIEW ════════════════ */
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

export const previewAnalyticsReport = catchAsync(async (req, res) => {
  const doc = await GeneratedReport.findById(req.params.id).select("+fileData");
  if (!doc) throw new AppError(httpStatus.NOT_FOUND, "Report not found");
  if (doc.format === "pdf") return sendFile(res, doc, true);

  let columns = [];
  let rows = [];
  if (doc.format === "csv") {
    const parsed = parseCsv(doc.fileData.toString("utf8"));
    columns = parsed[0] || [];
    rows = parsed.slice(1);
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(doc.fileData);
    const ws = wb.worksheets[0];
    const all = [];
    ws.eachRow((r) => all.push(r.values.slice(1).map((v) => String(v ?? ""))));
    columns = all[1] || [];
    rows = all.slice(2);
  }
  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Report preview",
    data: {
      id: String(doc._id),
      name: doc.name,
      format: doc.format,
      columns,
      rows: rows.slice(0, 200),
      totalRows: rows.length,
      truncated: rows.length > 200,
    },
  });
});

/* ════════════════ 13) RENAME ════════════════ */
export const renameAnalyticsReport = catchAsync(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name || name.length > 140)
    throw new AppError(httpStatus.BAD_REQUEST, "A valid report name is required");
  const doc = await GeneratedReport.findByIdAndUpdate(
    req.params.id,
    { name },
    { new: true }
  ).populate("generatedBy", "fullName name");
  if (!doc) throw new AppError(httpStatus.NOT_FOUND, "Report not found");
  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Report renamed",
    data: serializeReport(doc),
  });
});

/* ════════════════ 14) DUPLICATE ════════════════ */
export const duplicateAnalyticsReport = catchAsync(async (req, res) => {
  const src = await GeneratedReport.findById(req.params.id).select("+fileData");
  if (!src) throw new AppError(httpStatus.NOT_FOUND, "Report not found");
  const copy = await GeneratedReport.create({
    name: `${src.name} (copy)`.slice(0, 140),
    type: src.type,
    groupBy: src.groupBy,
    filters: src.filters,
    rangeFrom: src.rangeFrom,
    rangeTo: src.rangeTo,
    rangeLabel: src.rangeLabel,
    format: src.format,
    fileData: src.fileData,
    sizeBytes: src.sizeBytes,
    rowCount: src.rowCount,
    generatedBy: req.user._id,
  });
  return sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Report duplicated",
    data: serializeReport(copy, req.user?.fullName || req.user?.name),
  });
});

/* ════════════════ 15) DELETE (admin only — route par guard) ════════════════ */
export const deleteAnalyticsReport = catchAsync(async (req, res) => {
  const doc = await GeneratedReport.findByIdAndDelete(req.params.id);
  if (!doc) throw new AppError(httpStatus.NOT_FOUND, "Report not found");
  await recordActivity({
    req,
    action: "analytics.report_deleted",
    entityType: "GeneratedReport",
    entityId: doc._id,
    metadata: { name: doc.name, type: doc.type },
  });
  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Report deleted",
    data: { id: String(doc._id) },
  });
});

/* ════════════════ 16) TAB EXPORT (save kiye baghair) ════════════════ */
export const exportAnalyticsTab = catchAsync(async (req, res) => {
  const tab = String(req.query.tab || "overview");
  const format = ["pdf", "xlsx", "csv"].includes(req.query.format)
    ? req.query.format
    : "csv";
  const typeMap = {
    overview: "financial",
    bookings: "bookings",
    revenue: "earnings",
    providers: "earnings",
    customers: "customers",
    services: "services",
    financial: "financial",
    reports: "financial",
  };
  const type = typeMap[tab] || "financial";
  const groupBy = tab === "providers" ? "provider" : tab === "services" ? "service" : "day";
  const range = getDateRange(req.query);
  const data = await buildReportData({ type, groupBy, range, filters: {} });
  const rangeLabel = rangeLabelOf(range);
  const meta = `${rangeLabel} · Generated ${new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
  })}`;
  const buffer = await buildFile(format, { ...data, meta });
  const fakeDoc = {
    name: `OWVO ${tab} export (${rangeLabel})`,
    format,
    fileData: buffer,
  };
  return sendFile(res, fakeDoc, false);
});
