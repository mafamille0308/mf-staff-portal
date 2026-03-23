// Endpoints:
// - /portal/visits/list
// - /portal/visits/get
// - /portal/visits/update
// - /portal/visits/bulk-update
// - /portal/visits/cancel
// - /portal/visits/reactivate
// - /portal/visits/bulk-register
import { clonePayload_, portalCall_ } from "./_core.js";

export async function portalBulkRegisterVisits_(idToken, payload) {
  return portalCall_("/portal/visits/bulk-register", clonePayload_(payload), idToken);
}

export async function portalVisitsCancel_(idToken, payload) {
  return portalCall_("/portal/visits/cancel", clonePayload_(payload), idToken);
}

export async function portalVisitsReactivate_(idToken, payload) {
  return portalCall_("/portal/visits/reactivate", clonePayload_(payload), idToken);
}

export async function portalVisitsGet_(idToken, payload) {
  return portalCall_("/portal/visits/get", clonePayload_(payload), idToken);
}

export async function portalVisitsUpdate_(idToken, payload) {
  return portalCall_("/portal/visits/update", clonePayload_(payload), idToken);
}

export async function portalVisitsList_(idToken, payload) {
  return portalCall_("/portal/visits/list", clonePayload_(payload), idToken);
}

export async function portalBulkUpdateVisits_(idToken, updates) {
  return portalCall_("/portal/visits/bulk-update", { updates: Array.isArray(updates) ? updates : [] }, idToken);
}
