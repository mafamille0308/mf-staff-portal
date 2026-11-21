// Endpoints:
// - /portal/meeting/customers/profile/get
// - /portal/meeting/customers/profile/submit
// - /portal/meeting/notification/manual-status/update
// - /portal/notify-queue/retry
// - /portal/notify-queue/readiness
import { clonePayload_, toTrimmed_, portalCall_ } from "./core.js";

export async function portalMeetingCustomerProfileGet_(idToken, visitId) {
  return portalCall_("/portal/meeting/customers/profile/get", { visit_id: toTrimmed_(visitId) }, idToken);
}

export async function portalMeetingCustomerProfileSubmit_(idToken, payload) {
  return portalCall_("/portal/meeting/customers/profile/submit", clonePayload_(payload), idToken);
}

export async function portalMeetingNotificationManualStatusUpdate_(idToken, payload) {
  return portalCall_("/portal/meeting/notification/manual-status/update", clonePayload_(payload), idToken);
}

export async function portalNotifyQueueRetry_(idToken, payload) {
  return portalCall_("/portal/notify-queue/retry", clonePayload_(payload), idToken);
}

export async function portalNotifyQueueReadiness_(idToken, payload) {
  return portalCall_("/portal/notify-queue/readiness", clonePayload_(payload), idToken);
}
