export function normalizeCancelBillingStatus_(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["no_billing_required", "no_billing", "billing_not_required"].includes(s)) return "unbilled";
  if (["paid", "completed"].includes(s)) return "paid";
  if (["draft", "invoice_draft", "pending", "unpaid"].includes(s)) return "billed";
  if (["billed", "invoicing", "invoiced", "sent", "scheduled", "partially_paid"].includes(s)) return "billed";
  return "unbilled";
}
