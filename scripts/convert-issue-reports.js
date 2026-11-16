// One-time conversion: existing IssueReports → SupportTickets (one-queue
// model). Idempotent — reports that already have a supportTicket link are
// skipped, so it is safe to run more than once.
//
//   node scripts/convert-issue-reports.js --dry   (report only)
//   node scripts/convert-issue-reports.js         (convert)
import mongoose from "mongoose";
import dotenv from "dotenv";
import { IssueReport } from "../model/issueReport.model.js";
import { SupportTicket } from "../model/supportTicket.model.js";

dotenv.config();

const DRY = process.argv.includes("--dry");

const REPORT_TO_TICKET_TYPE = {
  payment: "payment",
  service_quality: "complaint",
  safety: "dispute",
  provider_conduct: "dispute",
  general: "complaint",
};
const REPORT_TYPE_LABEL = {
  payment: "Payment issue",
  service_quality: "Service quality",
  safety: "Safety concern",
  provider_conduct: "Provider conduct",
  general: "Issue report",
};
const REPORT_TO_TICKET_STATUS = {
  open: "open",
  reviewing: "in_progress",
  resolved: "resolved",
  dismissed: "closed",
};

const run = async () => {
  const uri = process.env.MONGO_DB_URL;
  if (!uri) {
    console.error("MONGO_DB_URL is not set.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${DRY ? "DRY RUN" : "LIVE"}`);

  const reports = await IssueReport.find({
    $or: [{ supportTicket: null }, { supportTicket: { $exists: false } }],
  }).sort({ createdAt: 1 });
  console.log(`Reports without a ticket: ${reports.length}`);

  let converted = 0;
  for (const report of reports) {
    const messages = [];
    if (report.photo?.url) {
      messages.push({
        sender: report.reporter,
        senderRole: report.reporterRole === "provider" ? "provider" : "customer",
        text: "Photo evidence attached",
        attachment: {
          url: report.photo.url,
          type: "image",
          name: "report-photo",
          mimeType: "image/*",
          size: 0,
        },
        createdAt: report.createdAt,
      });
    }
    const data = {
      subject: `${REPORT_TYPE_LABEL[report.type] || "Issue report"} — booking report`,
      description: report.description,
      type: REPORT_TO_TICKET_TYPE[report.type] || "complaint",
      priority: report.type === "safety" ? "high" : "medium",
      status: REPORT_TO_TICKET_STATUS[report.status] || "open",
      reporter: report.reporter,
      reporterRole: report.reporterRole === "provider" ? "provider" : "customer",
      booking: report.booking || null,
      reportedUser: report.reportedUser || null,
      assignedTo: report.assignedTo || null,
      resolutionNote: report.resolutionNote || "",
      source: "report",
      messages,
    };
    if (DRY) {
      console.log(
        `would convert report ${report._id} (${report.type}) → ticket [${data.type}/${data.status}]`
      );
      converted += 1;
      continue;
    }
    const ticket = await SupportTicket.create(data);
    // Keep the original dates so the history reads in the right order.
    await SupportTicket.updateOne(
      { _id: ticket._id },
      { $set: { createdAt: report.createdAt, updatedAt: report.updatedAt } }
    );
    report.supportTicket = ticket._id;
    await report.save();
    converted += 1;
    console.log(`converted report ${report._id} → ticket ${ticket.ticketNumber}`);
  }

  console.log(`Done. ${DRY ? "Would convert" : "Converted"}: ${converted}`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});
