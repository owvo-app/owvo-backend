import nodemailer from "nodemailer";
import { getPlatformSettingsDoc } from "./money.util.js";

// Admin email alerts — controlled from the admin Settings page
// (Support & Notification Alerts section). Kinds:
//   "ticket"        a customer/provider opened a support ticket
//   "data_request"  a user asked for a copy of their data (GDPR)
//   "payout_failed" a provider payout failed at the bank step
//
// Every send is best-effort: a mail problem must never break the action
// that triggered the alert, so this helper never throws.

const TOGGLE_BY_KIND = {
  ticket: "alertOnNewTicket",
  data_request: "alertOnDataRequest",
  payout_failed: "alertOnPayoutFailed",
};

const createTransporter = () =>
  nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

export const sendAdminAlert = async (kind, subject, text) => {
  try {
    const settings = await getPlatformSettingsDoc();
    const toggleField = TOGGLE_BY_KIND[kind];
    if (toggleField && settings[toggleField] === false) {
      return false; // The admin turned this alert off in Settings.
    }
    const to = settings.adminAlertEmail || settings.supportEmail;
    if (!to) return false;

    await createTransporter().sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject: `[OWVO Admin] ${subject}`,
      text,
    });
    return true;
  } catch (error) {
    console.error("Admin alert email failed:", error?.message || error);
    return false;
  }
};

// Used by the Settings page "Send test email" button. Unlike
// sendAdminAlert this one reports failure honestly so the admin can
// tell whether email delivery works at all.
export const sendTestAdminAlertEmail = async () => {
  const settings = await getPlatformSettingsDoc();
  const to = settings.adminAlertEmail || settings.supportEmail;
  if (!to) {
    return { sent: false, to: null, reason: "No alert email address is set." };
  }
  await createTransporter().sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject: "[OWVO Admin] Test alert email",
    text: "This is a test email from your OWVO admin panel. If you received it, admin email alerts are working.",
  });
  return { sent: true, to, reason: null };
};
