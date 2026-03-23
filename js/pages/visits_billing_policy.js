import {
  portalListBillingPriceRules_,
  portalBillingBatchCreate_,
  portalBillingBatchRevertToUnbilled_,
  portalBillingBatchDetail_,
  portalBulkUpdateVisits_,
} from "./portal_api.js";

export async function listBillingPriceRulesForVisit_(idToken, onlyActive) {
  return portalListBillingPriceRules_(idToken, onlyActive);
}

export async function createBillingBatchForVisit_(payload, idToken) {
  return portalBillingBatchCreate_(idToken, payload);
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
