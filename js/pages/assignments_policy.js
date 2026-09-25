import {
  portalSearchStaffs_,
  portalListCustomerAssignments_,
  portalLinkCustomerAssignment_,
} from "./portal_api.js";

export async function searchStaffsForAssignmentPolicy_(idToken) {
  return portalSearchStaffs_(idToken);
}

export async function listCustomerAssignmentsForAssignmentPolicy_(idToken, payload) {
  return portalListCustomerAssignments_(idToken, payload);
}

export async function linkCustomerAssignmentPolicy_(idToken, payload) {
  return portalLinkCustomerAssignment_(idToken, payload);
}
