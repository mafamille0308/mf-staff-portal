import {
  portalAdminCreateTenant_,
  portalAdminCreateStore_,
  portalAdminUpsertAccount_,
  portalAdminUpsertMembership_,
  portalAdminGetOrganizationStoreProfile_,
  portalAdminUpdateOrganizationStoreProfile_,
  portalSettingsGetOrganization_,
  portalSettingsUpdateOrganization_,
  portalSettingsGetStore_,
  portalSettingsUpdateStore_,
  portalSettingsGetSquareIntegrationStatus_,
  portalSettingsListSquareLocations_,
  portalSettingsUpdateStoreSquareLocation_,
  portalSettingsStartSquareOAuth_,
  portalSettingsDisconnectSquare_,
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

export async function getOrganizationStoreProfileForSettings_(idToken, payload) {
  return portalAdminGetOrganizationStoreProfile_(idToken, payload);
}

export async function updateOrganizationStoreProfileForSettings_(idToken, payload) {
  return portalAdminUpdateOrganizationStoreProfile_(idToken, payload);
}

export async function getOrganizationForSettings_(idToken, payload) {
  return portalSettingsGetOrganization_(idToken, payload);
}

export async function updateOrganizationForSettings_(idToken, payload) {
  return portalSettingsUpdateOrganization_(idToken, payload);
}

export async function getStoreForSettings_(idToken, payload) {
  return portalSettingsGetStore_(idToken, payload);
}

export async function updateStoreForSettings_(idToken, payload) {
  return portalSettingsUpdateStore_(idToken, payload);
}

export async function getSquareIntegrationStatusForSettings_(idToken, payload) {
  return portalSettingsGetSquareIntegrationStatus_(idToken, payload);
}

export async function listSquareLocationsForSettings_(idToken, payload) {
  return portalSettingsListSquareLocations_(idToken, payload);
}

export async function updateStoreSquareLocationForSettings_(idToken, payload) {
  return portalSettingsUpdateStoreSquareLocation_(idToken, payload);
}

export async function startSquareOAuthForSettings_(idToken, payload) {
  return portalSettingsStartSquareOAuth_(idToken, payload);
}

export async function disconnectSquareForSettings_(idToken, payload) {
  return portalSettingsDisconnectSquare_(idToken, payload);
}
