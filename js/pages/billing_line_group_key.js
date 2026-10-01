export function buildBillingLineGroupKey_(line = {}) {
  const itemType = String(line.item_type || "").trim();
  const priceRuleId = String(line.price_rule_id || "").trim();
  const label = String(line.label || line.name || "").trim();
  const unitPrice = Math.max(0, Number(line.unit_price ?? line.unit_price_snapshot ?? 0) || 0);
  const note = String(line.note || "").trim();
  return JSON.stringify([itemType, priceRuleId, label, String(unitPrice), note]);
}
