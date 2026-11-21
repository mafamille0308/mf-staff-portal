import { portalListBillingPriceRules_ } from "./portal_api.js";

function todayYmdJst_() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizeYmd_(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

export function isSelectablePriceRule_(row, asOfYmd = "") {
  if (!row || row.is_active === false) return false;
  const target = normalizeYmd_(asOfYmd) || todayYmdJst_();
  const from = normalizeYmd_(row.valid_from || row.effective_from) || "2000-01-01";
  const to = normalizeYmd_(row.valid_to || row.effective_to);
  if (target < from) return false;
  if (to && target > to) return false;
  return true;
}

export function filterSelectablePriceRules_(rows, asOfYmd = "") {
  return (Array.isArray(rows) ? rows : []).filter((row) => isSelectablePriceRule_(row, asOfYmd));
}

export async function listBillingPriceRulesPolicy_(idToken, onlyActive) {
  const res = await portalListBillingPriceRules_(idToken, onlyActive);
  if (Array.isArray(res?.results)) {
    return Object.assign({}, res, { results: filterSelectablePriceRules_(res.results) });
  }
  if (Array.isArray(res)) return filterSelectablePriceRules_(res);
  return res;
}
