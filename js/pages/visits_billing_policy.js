import {
  portalListBillingPriceRules_,
  portalBillingBatchCreate_,
  portalBillingBatchesList_,
  portalBillingBatchRevertToUnbilled_,
  portalBillingBatchDetail_,
  portalBulkUpdateVisits_,
} from "./portal_api.js";
import { filterSelectablePriceRules_ } from "./billing_price_rules_policy.js";

export async function listBillingPriceRulesForVisit_(idToken, onlyActive) {
  const res = await portalListBillingPriceRules_(idToken, onlyActive);
  if (Array.isArray(res?.results)) {
    return Object.assign({}, res, { results: filterSelectablePriceRules_(res.results) });
  }
  if (Array.isArray(res)) return filterSelectablePriceRules_(res);
  return res;
}

export async function createBillingBatchForVisit_(payload, idToken) {
  return portalBillingBatchCreate_(idToken, payload);
}

export async function listBillingBatchesForVisit_(filters, idToken) {
  return portalBillingBatchesList_(idToken, filters || {});
}

export async function revertBillingBatchToUnbilledForVisit_(batchId, idToken) {
  const bid = String(batchId || "").trim();
  if (!bid) return { ok: true };
  return portalBillingBatchRevertToUnbilled_(idToken, bid);
}

export async function getBillingBatchDetailForVisit_(batchId, idToken) {
  const bid = String(batchId || "").trim();
  if (!bid) return {};
  return portalBillingBatchDetail_(idToken, bid);
}

export async function bulkUpdateVisitsForVisit_(updates, idToken) {
  return portalBulkUpdateVisits_(idToken, updates);
}
