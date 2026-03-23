// Endpoints:
// - /portal/staff/admin-create
// - /portal/staff/me/get
// - /portal/staff/me/update
// - /portal/staff/get-by-id
// - /portal/staff/update-by-id
// - /portal/staff/retire-preview
// - /portal/staff/retire-flow
import { clonePayload_, toTrimmed_, portalCall_ } from "./_core.js";

export async function portalStaffAdminCreate_(idToken, payload) {
  return portalCall_("/portal/staff/admin-create", clonePayload_(payload), idToken);
}

export async function portalStaffMeGet_(idToken) {
  return portalCall_("/portal/staff/me/get", {}, idToken);
}

export async function portalStaffMeUpdate_(idToken, payload) {
  return portalCall_("/portal/staff/me/update", clonePayload_(payload), idToken);
}

export async function portalStaffGetById_(idToken, staffId) {
  return portalCall_("/portal/staff/get-by-id", { staff_id: toTrimmed_(staffId) }, idToken);
}

export async function portalStaffUpdateById_(idToken, payload) {
  return portalCall_("/portal/staff/update-by-id", clonePayload_(payload), idToken);
}

export async function portalStaffRetirePreview_(idToken, payload) {
  return portalCall_("/portal/staff/retire-preview", clonePayload_(payload), idToken);
}

export async function portalStaffRetireFlow_(idToken, payload) {
  return portalCall_("/portal/staff/retire-flow", clonePayload_(payload), idToken);
}
