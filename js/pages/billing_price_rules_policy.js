import { portalListBillingPriceRules_ } from "./portal_api.js";

export async function listBillingPriceRulesPolicy_(idToken, onlyActive) {
  return portalListBillingPriceRules_(idToken, onlyActive);
}
