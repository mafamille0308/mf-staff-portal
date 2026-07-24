// Endpoints:
// - /portal/customers/detail
// - /portal/customers/list-my
// - /portal/customers/pet-names
// - /portal/customers/upsert
// - /portal/customers/import-from-mail
// - /portal/care-profiles/upsert
// - /portal/pets/upsert
import { clonePayload_, portalCall_ } from "./core.js";

export async function portalCustomersDetail_(idToken, payload) {
  return portalCall_("/portal/customers/detail", clonePayload_(payload), idToken);
}

export async function portalCustomersListMy_(idToken, payload) {
  return portalCall_("/portal/customers/list-my", clonePayload_(payload), idToken);
}

export async function portalCustomersPetNames_(idToken, customerIds) {
  return portalCall_("/portal/customers/pet-names", { customer_ids: Array.isArray(customerIds) ? customerIds : [] }, idToken);
}

export async function portalCustomersUpsert_(idToken, payload) {
  const body = clonePayload_(payload);
  if (!body.customer || typeof body.customer !== "object") {
    const { request_id, action, ...customerFields } = body;
    return portalCall_("/portal/customers/upsert", {
      request_id,
      action: action || "upsertCustomer",
      customer: customerFields,
    }, idToken);
  }
  return portalCall_("/portal/customers/upsert", body, idToken);
}

export async function portalCustomersImportFromMail_(idToken, payload) {
  return portalCall_("/portal/customers/import-from-mail", clonePayload_(payload), idToken);
}

export async function portalCareProfilesUpsert_(idToken, payload) {
  return portalCall_("/portal/care-profiles/upsert", clonePayload_(payload), idToken);
}

export async function portalPetsUpsert_(idToken, payload) {
  return portalCall_("/portal/pets/upsert", clonePayload_(payload), idToken);
}
