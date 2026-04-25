import { clonePayload_, portalCall_ } from "./core.js";

export async function portalAdminCreateTenant_(idToken, payload) {
  return portalCall_("/portal/admin/tenants/create", clonePayload_(payload), idToken);
}

export async function portalAdminCreateStore_(idToken, payload) {
  return portalCall_("/portal/admin/stores/create", clonePayload_(payload), idToken);
}

export async function portalAdminUpsertAccount_(idToken, payload) {
  return portalCall_("/portal/admin/accounts/upsert", clonePayload_(payload), idToken);
}

export async function portalAdminUpsertMembership_(idToken, payload) {
  return portalCall_("/portal/admin/memberships/upsert", clonePayload_(payload), idToken);
}
