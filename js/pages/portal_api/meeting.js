// Endpoints:
// - /portal/meeting/customers/profile/get
// - /portal/meeting/customers/profile/submit
import { clonePayload_, toTrimmed_, portalCall_ } from "./_core.js";

export async function portalMeetingCustomerProfileGet_(idToken, visitId) {
  return portalCall_("/portal/meeting/customers/profile/get", { visit_id: toTrimmed_(visitId) }, idToken);
}

export async function portalMeetingCustomerProfileSubmit_(idToken, payload) {
  return portalCall_("/portal/meeting/customers/profile/submit", clonePayload_(payload), idToken);
}
