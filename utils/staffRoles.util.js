// Staff system constants — the single source for which dashboard menus
// can be assigned to a staff account, the per-module action catalog,
// and the named role presets (a preset simply pre-fills menus/actions;
// the admin can adjust them per person, which makes the role "custom"
// in effect while keeping the chosen label).
//
// "staff-management" is deliberately NOT assignable: only the admin
// (Super Admin) ever sees or uses Staff Management.

export const STAFF_MENUS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "bookings", label: "Bookings" },
  { key: "tracking", label: "Live Tracking" },
  { key: "washers", label: "Providers", hint: "Includes Provider Opportunities and Training" },
  { key: "customers", label: "Customers" },
  { key: "provider-verification", label: "Provider Verification" },
  { key: "support", label: "Support & Disputes" },
  { key: "payouts-payments", label: "Payments & Refunds" },
  { key: "earnings", label: "Earnings" },
  { key: "reports", label: "Reports & Analytics", hint: "Includes viewing Services & Pricing" },
  { key: "data-requests", label: "Data Requests" },
  { key: "notifications", label: "Notifications" },
  { key: "settings", label: "Settings", hint: "View only — changing settings stays admin-only" },
  { key: "system-logs", label: "System Logs" },
];

export const STAFF_MENU_KEYS = STAFF_MENUS.map((m) => m.key);

export const STAFF_ACTIONS = [
  {
    module: "bookings",
    label: "Bookings",
    actions: [
      { key: "booking.view", label: "View bookings" },
      { key: "booking.create", label: "Create bookings" },
      { key: "booking.status.update", label: "Update booking status" },
      { key: "booking.cancel", label: "Cancel bookings" },
    ],
  },
  {
    module: "washers",
    label: "Providers",
    actions: [
      { key: "provider.view", label: "View providers" },
      { key: "provider.verify", label: "Verify documents" },
      { key: "provider.enforcement", label: "Suspend / warn / ban" },
      { key: "provider.edit", label: "Edit providers" },
    ],
  },
  {
    module: "customers",
    label: "Customers",
    actions: [
      { key: "customer.view", label: "View customers" },
      { key: "customer.edit", label: "Edit customers" },
      { key: "customer.disable", label: "Disable customers" },
    ],
  },
  {
    module: "support",
    label: "Support & Disputes",
    actions: [
      { key: "support.view", label: "View tickets" },
      { key: "support.reply", label: "Reply to tickets" },
      { key: "support.resolve", label: "Resolve / close tickets" },
    ],
  },
  {
    module: "payouts-payments",
    label: "Payments & Refunds",
    actions: [
      { key: "payment.view", label: "View payments" },
      { key: "payment.payout.approve", label: "Approve payouts" },
      { key: "payment.refund.process", label: "Process refunds" },
    ],
  },
  {
    module: "reports",
    label: "Reports & Services",
    actions: [
      { key: "report.view", label: "View reports" },
      { key: "report.export", label: "Export reports" },
      { key: "service.view", label: "View services & pricing" },
      { key: "service.edit", label: "Edit services & pricing" },
    ],
  },
  {
    module: "earnings",
    label: "Earnings",
    actions: [
      { key: "earning.view", label: "View earnings" },
      { key: "earning.export", label: "Export earnings" },
    ],
  },
  {
    module: "tracking",
    label: "Live Tracking",
    actions: [{ key: "tracking.view", label: "View live tracking" }],
  },
  {
    module: "data-requests",
    label: "Data Requests",
    actions: [{ key: "datarequest.view", label: "View data requests" }],
  },
  {
    module: "notifications",
    label: "Notifications",
    actions: [{ key: "notification.view", label: "View notifications" }],
  },
  {
    module: "settings",
    label: "Settings",
    actions: [{ key: "settings.view", label: "View settings" }],
  },
  {
    module: "system-logs",
    label: "System Logs",
    actions: [{ key: "systemlog.view", label: "View system logs" }],
  },
];

export const STAFF_ACTION_KEYS = STAFF_ACTIONS.flatMap((group) =>
  group.actions.map((a) => a.key)
);

export const STAFF_ROLES = [
  { key: "operations_manager", label: "Operations Manager" },
  { key: "support_agent", label: "Support Agent" },
  { key: "finance_staff", label: "Finance Staff" },
  { key: "dispatch_staff", label: "Dispatch Staff" },
  { key: "custom", label: "Custom" },
];

export const STAFF_ROLE_PRESETS = {
  operations_manager: {
    menus: [
      "dashboard",
      "bookings",
      "tracking",
      "washers",
      "customers",
      "provider-verification",
      "support",
      "reports",
      "notifications",
    ],
    actions: [
      "booking.view",
      "booking.create",
      "booking.status.update",
      "booking.cancel",
      "provider.view",
      "provider.verify",
      "provider.enforcement",
      "provider.edit",
      "customer.view",
      "support.view",
      "support.reply",
      "support.resolve",
      "report.view",
      "service.view",
      "tracking.view",
      "notification.view",
    ],
  },
  support_agent: {
    menus: ["dashboard", "bookings", "customers", "support", "notifications"],
    actions: [
      "booking.view",
      "booking.status.update",
      "customer.view",
      "support.view",
      "support.reply",
      "support.resolve",
      "notification.view",
    ],
  },
  finance_staff: {
    menus: ["dashboard", "payouts-payments", "earnings", "reports", "notifications"],
    actions: [
      "payment.view",
      "payment.payout.approve",
      "payment.refund.process",
      "earning.view",
      "earning.export",
      "report.view",
      "report.export",
      "notification.view",
    ],
  },
  dispatch_staff: {
    menus: ["dashboard", "bookings", "tracking", "washers"],
    actions: [
      "booking.view",
      "booking.status.update",
      "tracking.view",
      "provider.view",
    ],
  },
  custom: { menus: [], actions: [] },
};

export const STAFF_DEPARTMENTS = [
  "Management",
  "Operations",
  "Customer Support",
  "Finance",
  "Marketing",
  "Training",
  "Analytics",
  "HR",
];
