export function productBadgeLabel_(visit) {
  return String((visit && (visit.price_rule_label || visit.product_name || visit.service_name || visit.price_rule_id)) || "").trim() || "-";
}

export function normalizeBillingStatusForPriceRuleEdit_(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") return "paid";
  if (s === "draft" || s === "invoice_draft" || s === "pending" || s === "unpaid") return "billed";
  if (s === "billed" || s === "invoicing" || s === "invoiced" || s === "sent" || s === "scheduled") return "billed";
  return "unbilled";
}
