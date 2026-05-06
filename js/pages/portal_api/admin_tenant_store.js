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

export async function portalAdminGetOrganizationStoreProfile_(idToken, payload) {
  return portalCall_("/portal/admin/organization-store/profile/get", clonePayload_(payload), idToken);
}

export async function portalAdminUpdateOrganizationStoreProfile_(idToken, payload) {
  return portalCall_("/portal/admin/organization-store/profile/update", clonePayload_(payload), idToken);
}

export async function portalSettingsGetOrganization_(idToken, payload) {
  return portalCall_("/portal/settings/organization/get", clonePayload_(payload), idToken);
}

export async function portalSettingsUpdateOrganization_(idToken, payload) {
  return portalCall_("/portal/settings/organization/update", clonePayload_(payload), idToken);
}

export async function portalSettingsGetStore_(idToken, payload) {
  return portalCall_("/portal/settings/store/get", clonePayload_(payload), idToken);
}

export async function portalSettingsUpdateStore_(idToken, payload) {
  return portalCall_("/portal/settings/store/update", clonePayload_(payload), idToken);
}

export async function portalSettingsGetSquareIntegrationStatus_(idToken, payload) {
  return portalCall_("/portal/settings/integrations/square/status", clonePayload_(payload), idToken);
}

export async function portalSettingsListSquareLocations_(idToken, payload) {
  return portalCall_("/portal/settings/integrations/square/locations/list", clonePayload_(payload), idToken);
}

export async function portalSettingsUpdateStoreSquareLocation_(idToken, payload) {
  return portalCall_("/portal/settings/store/square-location/update", clonePayload_(payload), idToken);
}

export async function portalSettingsStartSquareOAuth_(idToken, payload) {
  return portalCall_("/portal/settings/integrations/square/oauth/start", clonePayload_(payload), idToken);
}

export async function portalSettingsDisconnectSquare_(idToken, payload) {
  return portalCall_("/portal/settings/integrations/square/disconnect", clonePayload_(payload), idToken);
}
