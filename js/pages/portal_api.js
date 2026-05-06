import { clonePayload_, portalCall_ } from "./portal_api/core.js";

export * from "./portal_api/auth.js";
export * from "./portal_api/assignments.js";
export * from "./portal_api/billing.js";
export * from "./portal_api/calendar.js";
export * from "./portal_api/customers.js";
export * from "./portal_api/meeting.js";
export * from "./portal_api/staff.js";
export * from "./portal_api/visits.js";
export * from "./portal_api/admin_tenant_store.js";

export async function portalSummaryMonthly_(idToken, payload) {
  return portalCall_("/portal/summary/monthly", clonePayload_(payload), idToken);
}

export async function portalSummaryMonthlyBulk_(idToken, payload) {
  return portalCall_("/portal/summary/monthly-bulk", clonePayload_(payload), idToken);
}

export async function portalSummaryAdminMonthly_(idToken, payload) {
  return portalCall_("/portal/summary/admin-monthly", clonePayload_(payload), idToken);
}
