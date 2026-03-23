// Endpoints:
// - /portal/me
import { portalCall_ } from "./_core.js";

export async function portalMe_(idToken) {
  return portalCall_("/portal/me", {}, idToken);
}
