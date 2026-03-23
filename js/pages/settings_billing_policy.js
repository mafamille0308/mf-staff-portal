import {
  portalListBillingPriceRules_,
  portalBillingBatchesList_,
  portalBillingPriceRulesBatchUpsert_,
  portalBillingPriceRulesToggle_,
  portalBillingBatchDetail_,
} from "./portal_api.js";

export async function listBillingPriceRulesForSettings_(idToken, onlyActive) {
  return portalListBillingPriceRules_(idToken, onlyActive);
}

export async function listBillingBatchesForSettings_(idToken) {
  return portalBillingBatchesList_(idToken, {});
}

export async function batchUpsertBillingPriceRulesForSettings_(idToken, payload) {
  return portalBillingPriceRulesBatchUpsert_(idToken, payload);
}

export async function toggleBillingPriceRuleForSettings_(idToken, payload) {
  return portalBillingPriceRulesToggle_(idToken, payload);
}

export async function getBillingBatchDetailForSettings_(idToken, batchId) {
  return portalBillingBatchDetail_(idToken, batchId);
}
