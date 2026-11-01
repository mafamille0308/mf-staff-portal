// Endpoints:
// - /portal/calendar/sync
// - /portal/calendar/sync-all
import { clonePayload_, portalCall_ } from "./core.js";

export async function portalCalendarSync_(idToken, payload) {
  return portalCall_("/portal/calendar/sync", clonePayload_(payload), idToken);
}

export async function portalCalendarSyncAll_(idToken, payload) {
  return portalCall_("/portal/calendar/sync-all", clonePayload_(payload), idToken);
}
