import {
  portalBillingBatchesList_,
  portalBillingBatchDetail_,
  portalBillingBatchRevertToUnbilled_,
  portalBillingPricePreview_,
  portalListBillingPriceRules_,
  portalBillingBatchUpdateItems_,
} from "./portal_api.js";

export async function fetchBillingBatchesPolicy_(idToken, filters) {
  const res = await portalBillingBatchesList_(idToken, {
    billing_status: String(filters?.billing_status || "").trim()
  });
  return Array.isArray(res?.batches) ? res.batches : [];
}

export async function fetchBillingBatchDetailPolicy_(idToken, batchId) {
  return portalBillingBatchDetail_(idToken, batchId);
}

export async function revertBillingBatchToUnbilledPolicy_(idToken, batchId) {
  return portalBillingBatchRevertToUnbilled_(idToken, batchId);
}

export async function fetchPricePreviewPolicy_(idToken, priceRuleId, visitDate) {
  return portalBillingPricePreview_(idToken, priceRuleId, visitDate);
}

export async function fetchAllPriceRulesPolicy_(idToken) {
  const res = await portalListBillingPriceRules_(idToken, false);
  return Array.isArray(res?.results) ? res.results : [];
}

export async function updateBillingBatchItemsPolicy_(idToken, payload) {
  return portalBillingBatchUpdateItems_(idToken, payload);
}
