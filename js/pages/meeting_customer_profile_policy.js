import {
  portalMeetingCustomerProfileGet_,
  portalMeetingCustomerProfileSubmit_,
} from "./portal_api.js";

export async function getMeetingCustomerProfilePolicy_(visitId, idToken) {
  return portalMeetingCustomerProfileGet_(idToken, visitId);
}

export async function submitMeetingCustomerProfilePolicy_(payload, idToken) {
  return portalMeetingCustomerProfileSubmit_(idToken, payload);
}
