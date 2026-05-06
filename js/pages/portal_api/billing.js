// Endpoints:
// - /portal/billing/status-options
// - /portal/billing/price-rules/list
// - /portal/billing/price-rules/batch-upsert
// - /portal/billing/price-rules/toggle
// - /portal/billing/price-preview
// - /portal/billing/batches/list
// - /portal/billing/batches/detail
// - /portal/billing/batches/create
// - /portal/billing/batches/update-items
// - /portal/billing/batches/revert-to-unbilled
// - /portal/billing/batches/refund-followup
import { clonePayload_, toTrimmed_, portalCall_ } from "./core.js";

export async function portalListBillingPriceRules_(idToken, onlyActive) {
  return portalCall_("/portal/billing/price-rules/list", { only_active: !!onlyActive }, idToken);
}

export async function portalGetBillingStatusOptions_(idToken) {
  return portalCall_("/portal/billing/status-options", {}, idToken);
}

export async function portalBillingBatchesList_(idToken, payload = {}) {
  return portalCall_("/portal/billing/batches/list", clonePayload_(payload), idToken);
}

export async function portalBillingPriceRulesBatchUpsert_(idToken, payload) {
  return portalCall_("/portal/billing/price-rules/batch-upsert", clonePayload_(payload), idToken);
}

export async function portalBillingPriceRulesToggle_(idToken, payload) {
  return portalCall_("/portal/billing/price-rules/toggle", clonePayload_(payload), idToken);
}

export async function portalBillingBatchDetail_(idToken, batchId) {
  return portalCall_("/portal/billing/batches/detail", { batch_id: toTrimmed_(batchId) }, idToken);
}

export async function portalBillingBatchRevertToUnbilled_(idToken, batchId) {
  return portalCall_("/portal/billing/batches/revert-to-unbilled", { batch_id: toTrimmed_(batchId) }, idToken);
}

export async function portalBillingBatchRefundFollowup_(idToken, payload) {
  return portalCall_("/portal/billing/batches/refund-followup", clonePayload_(payload), idToken);
}

export async function portalBillingBatchCreate_(idToken, payload) {
  return portalCall_("/portal/billing/batches/create", clonePayload_(payload), idToken);
}

export async function portalBillingBatchUpdateItems_(idToken, payload) {
  return portalCall_("/portal/billing/batches/update-items", clonePayload_(payload), idToken);
}

export async function portalBillingPricePreview_(idToken, priceRuleId, visitDate) {
  return portalCall_("/portal/billing/price-preview", {
    price_rule_id: toTrimmed_(priceRuleId),
    visit_date: toTrimmed_(visitDate),
  }, idToken);
}
