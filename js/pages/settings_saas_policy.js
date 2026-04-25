import {
  portalAdminCreateTenant_,
  portalAdminCreateStore_,
  portalAdminUpsertAccount_,
  portalAdminUpsertMembership_,
} from "./portal_api.js";

export async function createTenantForSettings_(idToken, payload) {
  return portalAdminCreateTenant_(idToken, payload);
}

export async function createStoreForSettings_(idToken, payload) {
  return portalAdminCreateStore_(idToken, payload);
}

export async function upsertAccountForSettings_(idToken, payload) {
  return portalAdminUpsertAccount_(idToken, payload);
}

export async function upsertMembershipForSettings_(idToken, payload) {
  return portalAdminUpsertMembership_(idToken, payload);
}
