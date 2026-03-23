import {
  portalSearchStaffs_,
  portalStaffAdminCreate_,
  portalStaffMeGet_,
  portalStaffMeUpdate_,
  portalStaffGetById_,
  portalStaffUpdateById_,
  portalStaffRetirePreview_,
  portalStaffRetireFlow_,
  portalCalendarSync_,
  portalCalendarSyncAll_,
} from "./portal_api.js";

export async function searchStaffsForSettings_(idToken) {
  return portalSearchStaffs_(idToken);
}

export async function adminCreateStaffForSettings_(idToken, payload) {
  return portalStaffAdminCreate_(idToken, payload);
}

export async function getMyStaffProfileForSettings_(idToken) {
  return portalStaffMeGet_(idToken);
}

export async function updateMyStaffProfileForSettings_(idToken, payload) {
  return portalStaffMeUpdate_(idToken, payload);
}

export async function getStaffProfileByIdForSettings_(idToken, staffId) {
  return portalStaffGetById_(idToken, staffId);
}

export async function updateStaffProfileByIdForSettings_(idToken, payload) {
  return portalStaffUpdateById_(idToken, payload);
}

export async function retireStaffPreviewForSettings_(idToken, payload) {
  return portalStaffRetirePreview_(idToken, payload);
}

export async function retireStaffFlowForSettings_(idToken, payload) {
  return portalStaffRetireFlow_(idToken, payload);
}

export async function syncCalendarOneForSettings_(idToken, payload) {
  return portalCalendarSync_(idToken, payload);
}

export async function syncCalendarAllForSettings_(idToken, payload) {
  return portalCalendarSyncAll_(idToken, payload);
}
