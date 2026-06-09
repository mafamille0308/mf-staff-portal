import {
  portalVisitsCancel_,
  portalVisitsGet_,
  portalVisitsReassign_,
  portalVisitsReactivate_,
  portalVisitsUpdate_,
} from "./portal_api.js";

export async function callCancelVisitPolicy(payload, idToken) {
  return portalVisitsCancel_(idToken, payload);
}

export async function callReactivateVisitPolicy(payload, idToken) {
  return portalVisitsReactivate_(idToken, payload);
}

export async function fetchVisitDetailPolicy(visitId, idToken, options = {}) {
  const includeCustomerDetail = options?.include_customer_detail === true;
  const body = {
    visit_id: String(visitId || "").trim(),
    include_customer_detail: includeCustomerDetail,
  };
  return portalVisitsGet_(idToken, body);
}

export async function callUpdateVisitPolicy(payload, idToken) {
  return portalVisitsUpdate_(idToken, payload);
}

export async function callReassignVisitsPolicy(payload, idToken) {
  return portalVisitsReassign_(idToken, payload);
}
