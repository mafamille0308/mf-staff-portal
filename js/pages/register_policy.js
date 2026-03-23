import { portalBulkRegisterVisits_ } from "./portal_api.js";
import {
  searchStaffsForAssignmentPolicy_,
  listCustomerAssignmentsForAssignmentPolicy_,
} from "./assignments_policy.js";

export async function searchStaffsPolicy_(idToken) {
  return searchStaffsForAssignmentPolicy_(idToken);
}

export async function listCustomerAssignmentsPolicy_(idToken, payload) {
  return listCustomerAssignmentsForAssignmentPolicy_(idToken, payload);
}

export async function bulkRegisterVisitsPolicy_(idToken, payload) {
  return portalBulkRegisterVisits_(idToken, payload);
}
