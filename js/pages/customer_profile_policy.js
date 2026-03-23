import {
  portalCustomersDetail_,
  portalCustomersUpsert_,
  portalCareProfilesUpsert_,
  portalPetsUpsert_,
} from "./portal_api.js";

export async function getCustomerDetailPolicy_(payload, idToken) {
  return portalCustomersDetail_(idToken, payload);
}

export async function upsertCustomerPolicy_(payload, idToken) {
  return portalCustomersUpsert_(idToken, payload);
}

export async function upsertCareProfilePolicy_(payload, idToken) {
  return portalCareProfilesUpsert_(idToken, payload);
}

export async function upsertPetsPolicy_(payload, idToken) {
  return portalPetsUpsert_(idToken, payload);
}
