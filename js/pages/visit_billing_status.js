import { unwrapResults } from "../api.js";
import { portalGetBillingStatusOptions_ } from "./portal_api.js";

export const BILLING_STATUS_LABELS_FALLBACK_ = {
  unbilled: "未請求",
  no_billing_required: "請求不要",
  draft: "下書き",
  billed: "請求済",
  invoice_draft: "下書き",
  pending: "下書き",
  unpaid: "下書き",
  invoicing: "請求済",
  invoiced: "請求済",
  paid: "支払済",
  cancelled: "未請求",
  refunded: "返金済",
  failed: "支払失敗",
  voided: "請求取消",
};

let _billingStatusLabelMapCache = null; // { [key]: label }
let _billingStatusOrderCache = null; // string[]（API results の順序）

export function billingStatusLabel_(key) {
  const k0 = String(key || "").trim();
  // 仕様：初期値は unbilled。空や欠損はUI上 unbilled 扱い（DB更新はしない）
  const k = k0 ? k0 : "unbilled";
  if (_billingStatusLabelMapCache && _billingStatusLabelMapCache[k]) {
    const mapped = String(_billingStatusLabelMapCache[k] || "").trim();
    if (mapped && mapped.toLowerCase() !== String(k).toLowerCase()) return mapped;
  }
  return BILLING_STATUS_LABELS_FALLBACK_[k] || k;
}

export async function ensureBillingStatusLabelMap_(idToken) {
  if (_billingStatusLabelMapCache && Array.isArray(_billingStatusOrderCache)) {
    return { map: _billingStatusLabelMapCache, order: _billingStatusOrderCache };
  }
  try {
    const resp = await portalGetBillingStatusOptions_(idToken);
    const u = unwrapResults(resp);
    const results = (u && Array.isArray(u.results)) ? u.results : [];
    const map = {};
    const order = [];

    for (const x of results) {
      const kk = String(x?.key || x?.status || x?.value || "").trim();
      const ll = String(x?.label || x?.name || "").trim();
      if (!kk || !ll) continue;
      map[kk] = ll;
      order.push(kk);
    }
    // 安全策：unbilled は必ず存在させる（最悪フォールバック）
    if (!map.unbilled) map.unbilled = BILLING_STATUS_LABELS_FALLBACK_.unbilled || "未請求";
    if (!order.includes("unbilled")) order.unshift("unbilled");

    _billingStatusLabelMapCache = Object.keys(map).length ? map : { ...BILLING_STATUS_LABELS_FALLBACK_ };
    _billingStatusOrderCache = order;
  } catch (_) {
    _billingStatusLabelMapCache = { ...BILLING_STATUS_LABELS_FALLBACK_ };
    _billingStatusOrderCache = Object.keys(_billingStatusLabelMapCache);
  }
  return { map: _billingStatusLabelMapCache, order: _billingStatusOrderCache };
}
