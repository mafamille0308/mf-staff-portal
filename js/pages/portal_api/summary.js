// Endpoints:
// - /portal/summary/monthly
import { clonePayload_, portalCall_ } from "./core.js";

export async function portalSummaryMonthly_(idToken, payload) {
  return portalCall_("/portal/summary/monthly", clonePayload_(payload), idToken);
}
