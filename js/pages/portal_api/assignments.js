// Endpoints:
// - /portal/staffs/search
// - /portal/customer-assignments/list
// - /portal/customer-assignments/link
import { clonePayload_, portalCall_ } from "./core.js";

export async function portalSearchStaffs_(idToken, payload = {}) {
  return portalCall_("/portal/staffs/search", Object.assign({ query: "", allow_empty: true }, clonePayload_(payload)), idToken);
}

export async function portalListCustomerAssignments_(idToken, payload) {
  return portalCall_("/portal/customer-assignments/list", { list_customer_assignments: clonePayload_(payload) }, idToken);
}

export async function portalLinkCustomerAssignment_(idToken, payload) {
  return portalCall_("/portal/customer-assignments/link", { link_customer_staff: clonePayload_(payload) }, idToken);
}
