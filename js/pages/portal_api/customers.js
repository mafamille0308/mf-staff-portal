// Endpoints:
// - /portal/customers/detail
// - /portal/customers/list-my
// - /portal/customers/pet-names
// - /portal/customers/upsert
// - /portal/care-profiles/upsert
// - /portal/pets/upsert
import { clonePayload_, portalCall_ } from "./_core.js";

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
  return portalCall_("/portal/customers/upsert", clonePayload_(payload), idToken);
}

export async function portalCareProfilesUpsert_(idToken, payload) {
  return portalCall_("/portal/care-profiles/upsert", clonePayload_(payload), idToken);
}

export async function portalPetsUpsert_(idToken, payload) {
  return portalCall_("/portal/pets/upsert", clonePayload_(payload), idToken);
}
