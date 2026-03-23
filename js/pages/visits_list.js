// js/pages/visits_list.js
import { render, toast, escapeHtml, showModal, showSelectModal, showFormModal, fmt, displayOrDash, fmtDateTimeJst } from "../ui.js";
import { unwrapResults } from "../api.js";
import { getIdToken, getUser } from "../auth.js";
import { updateVisitDone } from "./visit_done_toggle.js";
import { parkingFeeRuleLabel, pickParkingFeeRule } from "./parking_fee_toggle.js";
import { confirmKeyLocationBeforeBulkDone, confirmKeyLocationBeforeDone } from "./visit_done_key_location.js";
import { callUpdateVisitPolicy, fetchVisitDetailPolicy } from "./visits_policy.js";
import {
  portalVisitsList_,
} from "./portal_api.js";
import { BILLING_STATUS_LABELS_FALLBACK_, billingStatusLabel_, ensureBillingStatusLabelMap_ } from "./visit_billing_status.js";
import { normalizeCancelBillingStatus_, pickCancellationFeeRate_, buildCancelPolicyMessage_ } from "./visit_cancel_policy.js";
import { confirmCancelPreview_ } from "./visit_cancel_confirm.js";
import { fetchReactivateVisitPreview_, runReactivateVisitFlow_ } from "./visit_reactivate_flow.js";
import { fetchCancelVisitPreview_, runCancelVisitFlow_ } from "./visit_cancel_flow.js";
import { pickVisitBasePriceRule_ as pickVisitBasePriceRuleShared_ } from "./visit_base_price_rule_picker.js";
import { normalizeBillingStatusForPriceRuleEdit_, productBadgeLabel_ } from "./visit_common_helpers.js";
import { formatMoney_, runWithBlocking_ } from "./visit_ui_helpers.js";
import {
  listBillingPriceRulesForVisit_ as listBillingPriceRules_,
  createBillingBatchForVisit_ as createBillingBatch_,
  revertBillingBatchToUnbilledForVisit_ as revertBillingBatchToUnbilled_,
  getBillingBatchDetailForVisit_ as getBillingBatchDetail_,
  bulkUpdateVisitsForVisit_ as bulkUpdateVisits_,
} from "./visits_billing_policy.js";

// ===== sessionStorage keys =====
const KEY_VF_STATE = "mf:visits_list:state:v1";
const KEY_VF_CACHE = "mf:visits_list:cache:v1";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善目的）

const KEY_VLIST_SCROLL_Y = "mf:visits_list:scroll_y:v1";
const KEY_VLIST_SCROLL_RESTORE_ONCE = "mf:visits_list:scroll_restore_once:v1";
const KEY_VLIST_DIRTY = "mf:visits_list:dirty:v1";
const KEY_PENDING_CANCEL_DRAFT = "mf:pending_cancel_draft:v1";

function toYmd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate()); // today
  const to = new Date(now);
  to.setDate(to.getDate() + 7); // +7 days
  return { date_from: toYmd(from), date_to: toYmd(to) + " 23:59:59" };
}

function toBool(v) {
  return v === true || String(v || "").toLowerCase() === "true";
}

function isDone_(v) {
  return toBool(v?.is_done);
}

function isActive_(v) {
  return v?.is_active !== false;
}

function safeParseJson_(s) {
  try { return JSON.parse(String(s || "")); } catch (_) { return null; }
}

function loadState_() {
  const obj = safeParseJson_(sessionStorage.getItem(KEY_VF_STATE));
  return (obj && typeof obj === "object") ? obj : null;
}

function saveState_(state) {
  try { sessionStorage.setItem(KEY_VF_STATE, JSON.stringify(state)); } catch (_) {}
}

function cacheKey_(state) {
  return `${String(state.date_from || "")}__${String(state.date_to_ymd || "")}`;
}

function loadCache_(key) {
  const obj = safeParseJson_(sessionStorage.getItem(KEY_VF_CACHE));
  if (!obj || typeof obj !== "object") return null;
  if (obj.key !== key) return null;
  if (!obj.ts || (Date.now() - Number(obj.ts)) > CACHE_TTL_MS) return null;
  if (!Array.isArray(obj.visits)) return null;
  return obj.visits;
}

function saveCache_(key, visits) {
  try { sessionStorage.setItem(KEY_VF_CACHE, JSON.stringify({ key, ts: Date.now(), visits })); } catch (_) {}
}

function invalidateCache_() {
  try { sessionStorage.removeItem(KEY_VF_CACHE); } catch (_) {}
}

function consumeDirty_() {
  try {
    const v = sessionStorage.getItem(KEY_VLIST_DIRTY);
    if (v === "1") {
      sessionStorage.removeItem(KEY_VLIST_DIRTY);
      return true;
    }
  } catch (_) {}
  return false;
}

function markDirty_() {
  try { sessionStorage.setItem(KEY_VLIST_DIRTY, "1"); } catch (_) {}
}

function pickStartIso_(v) {
  return v?.start_time || "";
}

function consumePendingCancelDraft_() {
  try {
    const raw = sessionStorage.getItem(KEY_PENDING_CANCEL_DRAFT);
    if (!raw) return null;
    sessionStorage.removeItem(KEY_PENDING_CANCEL_DRAFT);
    const obj = JSON.parse(raw);
    const visitIds = Array.isArray(obj?.visit_ids)
      ? obj.visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const visitId = String(obj?.visit_id || "").trim();
    if (visitId && !visitIds.includes(visitId)) visitIds.unshift(visitId);
    const rate = Number(obj?.cancellation_rate || 0) || 0;
    const remainingVisitIds = Array.isArray(obj?.remaining_visit_ids)
      ? obj.remaining_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const canceledVisitIds = Array.isArray(obj?.canceled_visit_ids)
      ? obj.canceled_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : (visitId ? [visitId] : []);
    const cancellationFeeByVisit = (obj?.cancellation_fee_by_visit && typeof obj.cancellation_fee_by_visit === "object")
      ? Object.fromEntries(
        Object.entries(obj.cancellation_fee_by_visit)
          .map(([k, v]) => [String(k || "").trim(), Number(v || 0) || 0])
          .filter(([k]) => !!k)
      )
      : {};
    if (![0, 50, 100].includes(rate)) return null;
    if (!visitIds.length && !remainingVisitIds.length) return null;
    const resolvedVisitIds = (rate === 0 && remainingVisitIds.length)
      ? remainingVisitIds
      : (visitIds.length ? visitIds : remainingVisitIds);
    return {
      visit_ids: resolvedVisitIds,
      cancellation_rate: rate,
      open_batch_detail: obj?.open_batch_detail !== false,
      allow_non_unbilled: obj?.allow_non_unbilled === true,
      allow_inactive: obj?.allow_inactive === true,
      source_batch_id: String(obj?.source_batch_id || "").trim(),
      remaining_visit_ids: remainingVisitIds,
      canceled_visit_ids: canceledVisitIds,
      cancellation_fee_by_visit: cancellationFeeByVisit,
    };
  } catch (_) {
    return null;
  }
}

function epochMsSafe_(isoOrAny) {
  const s = String(isoOrAny || "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function normalizeKeyword_(s) {
  return String(s || "").trim().toLowerCase();
}

function keywordHit_(v, kw) {
  if (!kw) return true;
  const hay = [
    v.visit_id,
    v.customer_name,
    v.title,
    v.memo,
    v.staff_name,
  ].map(x => normalizeKeyword_(x)).join("\n");
  return hay.includes(kw);
}

function sortVisits_(list, sortOrder, mode) {
  // mode:
  // - "open_first": 未完了優先
  // - "all": 完了優先なし（日時のみ）
  const dir = (sortOrder === "desc") ? -1 : 1;
  return list.slice().sort((a, b) => {
    if (mode !== "all") {
      const ad = isDone_(a);
      const bd = isDone_(b);
      if (ad !== bd) return ad ? 1 : -1;
    }

    const at = epochMsSafe_(pickStartIso_(a));
    const bt = epochMsSafe_(pickStartIso_(b));
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    if (at === bt) return 0;
    return (at < bt ? -1 : 1) * dir;
  });
}

function mergeVisitById(list, visitId, patch) {
  const id = String(visitId || "");
  const idx = list.findIndex(v => String(v.visit_id || "") === id);
  if (idx < 0) return { list, idx: -1, merged: null };
  const prev = list[idx] || {};
  const merged = { ...prev, ...patch };
  if (Object.prototype.hasOwnProperty.call(patch || {}, "customer_name")) {
    const nextName = String(patch?.customer_name || "").trim();
    const prevName = String(prev?.customer_name || "").trim();
    if (!nextName && prevName) merged.customer_name = prev.customer_name;
  }
  const next = list.slice();
  next[idx] = merged;
  return { list: next, idx, merged };
}

function isAdminUser_() {
  const user = getUser() || {};
  return String(user.role || "").toLowerCase() === "admin";
}

function amountText_(n) {
  const v = Math.max(0, Number(n || 0) || 0);
  return v > 0 ? `${formatMoney_(v)}円` : "未設定";
}



function makeBillingFeeContext_(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const pickAmount = (itemType) => {
    const hit = list.find((r) => String(r?.item_type || "").trim() === itemType && r?.is_active !== false);
    return Math.max(0, Number(hit?.amount || 0) || 0);
  };
  const pickOptions = (itemType) => {
    return list
      .filter((r) => String(r?.item_type || "").trim() === itemType && r?.is_active !== false)
      .sort((a, b) => (Number(a?.display_order || 0) || 0) - (Number(b?.display_order || 0) || 0))
      .map((r) => {
        const rid = String(r?.price_rule_id || "").trim();
        const product = String(r?.product_name || "").trim();
        const variant = String(r?.variant_name || "").trim();
        const label = String(r?.label || [product, variant].filter(Boolean).join(" ").trim() || rid).trim() || rid;
        const amount = Math.max(0, Number(r?.amount || 0) || 0);
        const displayOrder = Number(r?.display_order || 0) || 0;
        return { price_rule_id: rid, label, amount, display_order: displayOrder };
      });
  };
  const visitBaseRules = list
    .filter((r) => String(r?.item_type || "").trim() === "visit_base" && r?.is_active !== false)
    .sort((a, b) => (Number(a?.display_order || 0) || 0) - (Number(b?.display_order || 0) || 0));
  return {
    parking_fee: pickAmount("parking_fee"),
    parking_options: pickOptions("parking_fee"),
    key_pickup_fee: pickAmount("key_pickup_fee"),
    key_return_fee: pickAmount("key_return_fee"),
    key_pickup_options: pickOptions("key_pickup_fee"),
    key_return_options: pickOptions("key_return_fee"),
    travel_options: pickOptions("travel_fee"),
    seasonal_options: pickOptions("seasonal_fee"),
    discount_options: pickOptions("discount"),
    merchandise_options: pickOptions("merchandise"),
    visit_base_rules: visitBaseRules,
  };
}

function resolveVisitBaseAmount_(visit, feeContext) {
  const v = visit || {};
  const direct = Number(v?.base_fee_amount || 0) || 0;
  if (direct > 0) return direct;
  const rules = Array.isArray(feeContext?.visit_base_rules) ? feeContext.visit_base_rules : [];
  const byRuleId = rules.find((r) => String(r?.price_rule_id || "").trim() === String(v?.price_rule_id || "").trim());
  if (byRuleId) {
    const n = Number(byRuleId?.amount || 0) || 0;
    if (n > 0) return n;
  }
  const product = String(v?.product_name || v?.service_name || "").trim();
  const variant = String(v?.variant_name || "").trim();
  const duration = Number(v?.duration_minutes || 0) || 0;
  const hit = rules.find((r) => {
    const rp = String(r?.product_name || "").trim();
    const rv = String(r?.variant_name || "").trim();
    const rd = Number(r?.duration_minutes || 0) || 0;
    if (product && variant) return rp === product && rv === variant;
    if (duration > 0) return rd === duration;
    return false;
  });
  return hit ? (Number(hit?.amount || 0) || 0) : 0;
}

function resolveVisitServiceLabel_(visit, feeContext) {
  const v = visit || {};
  const product = String(v?.product_name || "").trim();
  const variant = String(v?.variant_name || "").trim();
  const direct = [product, variant].filter(Boolean).join(" ").trim();
  if (direct) return direct;
  const rules = Array.isArray(feeContext?.visit_base_rules) ? feeContext.visit_base_rules : [];
  const byRuleId = rules.find((r) => String(r?.price_rule_id || "").trim() === String(v?.price_rule_id || "").trim());
  if (byRuleId) {
    const rp = String(byRuleId?.product_name || "").trim();
    const rv = String(byRuleId?.variant_name || "").trim();
    const fromRule = [rp, rv].filter(Boolean).join(" ").trim();
    if (fromRule) return fromRule;
    const fallback = String(byRuleId?.label || "").trim();
    if (fallback) return fallback;
  }
  const serviceName = String(v?.service_name || "").trim();
  if (serviceName && serviceName !== "訪問サービス") return serviceName;
  return "商品未設定";
}

function selectedVisits_(visitsAll, ids) {
  const set = new Set((ids || []).map(x => String(x || "").trim()).filter(Boolean));
  return (visitsAll || []).filter(v => set.has(String(v?.visit_id || "").trim()));
}

function buildInvoicePreviewHtml_(preview, selected) {
  const p = preview || {};
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const totals = p.totals || {};
  const customer = p.customer || {};
  const selectedCount = Array.isArray(selected) ? selected.length : 0;
  return `
    <div class="p" style="margin-bottom:8px;">
      顧客：<strong>${escapeHtml(String(customer.customer_name || "-"))}</strong><br/>
      請求先メール：${escapeHtml(String(customer.billing_email || "-"))}<br/>
      対象予約：<strong>${escapeHtml(String(selectedCount))}件</strong>
    </div>
    <div class="card" style="max-height:280px; overflow:auto;">
      <div class="p">
        ${lines.map(line => `
          <div class="row row-between" style="gap:12px; margin-bottom:8px; align-items:flex-start;">
            <div>
              <div><strong>${escapeHtml(String(line.label || line.line_type || ""))}</strong>${line.line_type === "additional_fee" ? ` <span class="badge">追加料金</span>` : ``}${line.line_type === "merchandise" ? ` <span class="badge">一般商品</span>` : ``}</div>
              <div style="opacity:.8;">${escapeHtml(String(line.description || line.visit_date || ""))}</div>
            </div>
            <div style="white-space:nowrap;">${escapeHtml(formatMoney_(line.amount))}円</div>
          </div>
        `).join("") || `<div>明細がありません。</div>`}
      </div>
    </div>
    <div class="p" style="margin-top:10px;">
      小計：<strong>${escapeHtml(formatMoney_(totals.subtotal_amount))}円</strong><br/>
      追加料金：${escapeHtml(formatMoney_(totals.additional_fee_total))}円<br/>
      鍵料金：${escapeHtml(formatMoney_(totals.key_fee_total))}円<br/>
      調整：${escapeHtml(formatMoney_(totals.adjustment_total))}円<br/>
      合計：<strong>${escapeHtml(formatMoney_(totals.grand_total))}円</strong>
    </div>
    <div class="p" style="margin-top:8px; opacity:.8;">
      作成すると選択した予約の請求ステータスは「請求ドラフト」に更新されます。
    </div>
  `;
}

function buildInvoiceDraftFormHtml_(additionalFeeRules, merchandiseRules) {
  const additionalRules = Array.isArray(additionalFeeRules) ? additionalFeeRules : [];
  const merchandiseList = Array.isArray(merchandiseRules) ? merchandiseRules : [];
  return `
    <form data-el="invoiceDraftForm">
      <div class="p" style="margin-bottom:8px;">今回の請求ドラフトにだけ適用する上書きです。未指定なら顧客既定値を使います。</div>
      <div style="margin-bottom:10px;">
        <div style="opacity:.85; margin-bottom:4px;"><strong>鍵預かり料金区分</strong></div>
        <select class="input" name="key_pickup_fee_rule">
          <option value="">顧客既定値を使う</option>
          <option value="free">無料</option>
          <option value="paid">有料</option>
        </select>
      </div>
      <div style="margin-bottom:10px;">
        <div style="opacity:.85; margin-bottom:4px;"><strong>鍵返却料金区分</strong></div>
        <select class="input" name="key_return_fee_rule">
          <option value="">顧客既定値を使う</option>
          <option value="free">無料</option>
          <option value="paid">有料</option>
        </select>
      </div>
      <div style="margin-bottom:10px;">
        <div style="opacity:.85; margin-bottom:4px;"><strong>割引名</strong></div>
        <input class="input" type="text" name="discount_label" placeholder="例：初回割引" />
      </div>
      <div>
        <div style="opacity:.85; margin-bottom:4px;"><strong>割引額</strong></div>
        <input class="input" type="number" name="discount_amount" min="0" step="1" inputmode="numeric" placeholder="例：500" />
        <div class="p" style="margin-top:6px; opacity:.8;">入力時は固定額の値引きとして適用します。</div>
      </div>
      ${additionalRules.length ? `
      <div style="margin-top:12px;">
        <div style="opacity:.85; margin-bottom:6px;"><strong>追加料金</strong></div>
        <div class="p" style="margin-bottom:6px; opacity:.8;">必要な商品だけ選択してください。金額は空欄なら商品マスタの金額を使います。</div>
        <div style="display:grid; gap:8px;">
          ${additionalRules.map((rule) => {
            const rid = String(rule.price_rule_id || "").trim();
            return `
              <label class="card" style="display:grid; gap:6px;">
                <div class="row" style="gap:8px; align-items:center;">
                  <input type="checkbox" name="additional_fee_on_${escapeHtml(rid)}" value="1" />
                  <span><strong>${escapeHtml(String(rule.label || "追加料金"))}</strong> / ${escapeHtml(formatMoney_(rule.amount))}円</span>
                </div>
                <input class="input" type="number" name="additional_fee_amount_${escapeHtml(rid)}" min="0" step="1" inputmode="numeric" placeholder="金額上書き（任意）" />
              </label>
            `;
          }).join("")}
        </div>
      </div>` : ``}
      ${merchandiseList.length ? `
      <div style="margin-top:12px;">
        <div style="opacity:.85; margin-bottom:6px;"><strong>一般商品</strong></div>
        <div class="p" style="margin-bottom:6px; opacity:.8;">予約に紐づかない請求明細を追加します。金額は空欄なら商品マスタの金額を使います。</div>
        <div style="display:grid; gap:8px;">
          ${merchandiseList.map((rule) => {
            const rid = String(rule.price_rule_id || "").trim();
            return `
              <label class="card" style="display:grid; gap:6px;">
                <div class="row" style="gap:8px; align-items:center;">
                  <input type="checkbox" name="merchandise_on_${escapeHtml(rid)}" value="1" />
                  <span><strong>${escapeHtml(String(rule.label || "一般商品"))}</strong> / ${escapeHtml(formatMoney_(rule.amount))}円</span>
                </div>
                <input class="input" type="number" name="merchandise_amount_${escapeHtml(rid)}" min="0" step="1" inputmode="numeric" placeholder="金額上書き（任意）" />
              </label>
            `;
          }).join("")}
        </div>
      </div>` : ``}
    </form>
  `;
}

function buildBillingBatchFormHtml_(selected, feeDefaults, customerDefaults, options = {}) {
  const list = Array.isArray(selected) ? selected : [];
  const fd = feeDefaults || {};
  const cd = customerDefaults || {};
  const cancellationRate = Math.max(0, Number(options?.cancellation_rate || 0) || 0);
  const cancellationMode = cancellationRate === 50 || cancellationRate === 100;
  const cancellationPreset = (options?.cancellation_preset && typeof options.cancellation_preset === "object")
    ? options.cancellation_preset
    : null;
  const residualVisitSections = Array.isArray(options?.residual_visit_sections)
    ? options.residual_visit_sections
    : [];
  const presetResidualLines = Array.isArray(cancellationPreset?.residual_extra_lines)
    ? cancellationPreset.residual_extra_lines
    : [];
  const presetRemainingVisitIds = Array.isArray(cancellationPreset?.remaining_visit_ids)
    ? cancellationPreset.remaining_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const residualVisitCount = residualVisitSections.length
    ? residualVisitSections.length
    : presetRemainingVisitIds.length;
  const targetVisitCount = list.length + residualVisitCount;
  const parkingOptions = Array.isArray(fd.parking_options) ? fd.parking_options : [];
  const travelOptions = Array.isArray(fd.travel_options) ? fd.travel_options : [];
  const seasonalOptions = Array.isArray(fd.seasonal_options) ? fd.seasonal_options : [];
  const merchandiseOptions = Array.isArray(fd.merchandise_options) ? fd.merchandise_options : [];
  const keyPickupOptions = Array.isArray(fd.key_pickup_options) ? fd.key_pickup_options : [];
  const keyReturnOptions = Array.isArray(fd.key_return_options) ? fd.key_return_options : [];
  const DEFAULT_DISPLAY_ORDER = 999999;
  const displayOrderByRuleId = new Map();
  const registerDisplayOrder_ = (opts) => {
    (Array.isArray(opts) ? opts : []).forEach((o, idx) => {
      const rid = String(o?.price_rule_id || "").trim();
      if (!rid) return;
      const d = Number(o?.display_order);
      const order = Number.isFinite(d) ? d : idx;
      const cur = displayOrderByRuleId.get(rid);
      if (cur == null || order < cur) displayOrderByRuleId.set(rid, order);
    });
  };
  registerDisplayOrder_(fd.visit_base_rules);
  registerDisplayOrder_(parkingOptions);
  registerDisplayOrder_(travelOptions);
  registerDisplayOrder_(seasonalOptions);
  registerDisplayOrder_(merchandiseOptions);
  registerDisplayOrder_(keyPickupOptions);
  registerDisplayOrder_(keyReturnOptions);
  const resolveDisplayOrder_ = (priceRuleId, fallback = DEFAULT_DISPLAY_ORDER) => {
    const rid = String(priceRuleId || "").trim();
    if (rid && displayOrderByRuleId.has(rid)) return displayOrderByRuleId.get(rid);
    return fallback;
  };
  const findRuleForAmount_ = (opts, amt) => {
    const n = Math.max(0, Number(amt || 0) || 0);
    const hit = opts.find((x) => (Number(x?.amount || 0) || 0) === n);
    return hit ? String(hit.price_rule_id || "") : "";
  };
  const visitIds = list.map((v) => String(v?.visit_id || "").trim()).filter(Boolean);
  const rowsHtml = list.length
    ? list.map((v) => {
      const vid = String(v?.visit_id || "").trim();
      const title = String(v?.title || "").trim() || "(無題)";
      const productLabel = resolveVisitServiceLabel_(v, fd);
      const base = resolveVisitBaseAmount_(v, fd);
      const travelRaw = cancellationMode
        ? 0
        : Math.max(0, Number(cd?.travel_fee_amount || 0) || 0);
      const seasonalRaw = Number(v?.seasonal_fee_amount || 0) || 0;
      const parkingRaw = cancellationMode
        ? 0
        : Math.max(0, Number(cd?.parking_fee_amount || 0) || 0);
      const travelRuleId = findRuleForAmount_(travelOptions, travelRaw);
      const seasonalRuleId = findRuleForAmount_(seasonalOptions, seasonalRaw);
      const parkingRuleId = findRuleForAmount_(parkingOptions, parkingRaw) || String(parkingOptions[0]?.price_rule_id || "").trim();
      const parking = parkingRaw;
      const travelAmount = parseOptionAmount_(`${travelRuleId}|${travelRaw}`);
      const seasonalAmount = parseOptionAmount_(`${seasonalRuleId}|${seasonalRaw}`);
      const rowSubtotal = Math.max(0, base + parking + travelAmount + seasonalAmount);
      return `
        <details style="padding:4px 0;">
          <summary style="cursor:pointer; font-weight:400;">
            <span style="display:inline-flex; justify-content:space-between; align-items:center; gap:12px; width:calc(100% - 16px);">
              <span style="font-weight:600;">${escapeHtml(title)}</span>
              <span style="margin-left:auto; text-align:right; min-width:100px; font-weight:600;" data-el="subtotal_${escapeHtml(vid)}">${escapeHtml(rowSubtotal > 0 ? `${formatMoney_(rowSubtotal)}円` : "未設定")}</span>
            </span>
          </summary>
          <div style="display:grid; gap:8px; margin-top:8px; padding-left:2px;">
            <button type="button" data-edit="base" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ ${escapeHtml(productLabel)}</span>
              <strong data-el="base_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(base))}</strong>
            </button>
            <input type="hidden" name="base_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(base))}" />
            <input type="hidden" name="base_fee_label_${escapeHtml(vid)}" value="${escapeHtml(productLabel)}" />
            <input type="hidden" name="base_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(String(v?.price_rule_id || ""))}" />

            <button type="button" data-edit="parking" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ 駐車料金</span>
              <strong data-el="parking_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(parking))}</strong>
            </button>
            <input type="hidden" name="parking_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(parking))}" />
            <input type="hidden" name="parking_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(parkingRuleId)}" />

            <button type="button" data-edit="travel" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ 出張料金</span>
              <strong data-el="travel_amount_${escapeHtml(vid)}">${travelAmount > 0 ? `${escapeHtml(formatMoney_(travelAmount))}円` : "未選択"}</strong>
            </button>
            <input type="hidden" name="travel_option_${escapeHtml(vid)}" value="${escapeHtml(travelRuleId && travelRaw > 0 ? `${travelRuleId}|${travelRaw}` : "")}" />

            <button type="button" data-edit="seasonal" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ 繁忙期加算</span>
              <strong data-el="seasonal_amount_${escapeHtml(vid)}">${seasonalAmount > 0 ? `${escapeHtml(formatMoney_(seasonalAmount))}円` : "未選択"}</strong>
            </button>
            <input type="hidden" name="seasonal_option_${escapeHtml(vid)}" value="${escapeHtml(seasonalRuleId && seasonalRaw > 0 ? `${seasonalRuleId}|${seasonalRaw}` : "")}" />

            ${cancellationMode ? `` : `
            <button type="button" data-edit="extra" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>➕ 商品追加</span>
              <strong data-el="extra_label_${escapeHtml(vid)}">未設定</strong>
            </button>
            `}
            <input type="hidden" name="extra_label_${escapeHtml(vid)}" value="" />
            <input type="hidden" name="extra_qty_${escapeHtml(vid)}" value="1" />
            <input type="hidden" name="extra_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="extra_price_rule_id_${escapeHtml(vid)}" value="" />
          </div>
        </details>
        <div class="hr"></div>
      `;
    }).join("")
    : `<div>-</div>`;
  const residualRowsHtml = residualVisitSections.length
    ? residualVisitSections.map((s) => {
      const vid = String(s?.visit_id || "").trim();
      const title = String(s?.title || "").trim() || vid || "(無題)";
      const baseLabel = String(s?.base_fee_label || "").trim() || "商品未設定";
      const baseAmount = Math.max(0, Number(s?.base_fee_amount || 0) || 0);
      const basePriceRuleId = String(s?.base_price_rule_id || "").trim();
      const parkingAmount = Math.max(0, Number(s?.parking_fee_amount || 0) || 0);
      const parkingPriceRuleId = String(s?.parking_price_rule_id || "").trim();
      const travelAmount = Math.max(0, Number(s?.travel_fee_amount || 0) || 0);
      const travelPriceRuleId = String(s?.travel_price_rule_id || "").trim();
      const seasonalAmount = Math.max(0, Number(s?.seasonal_fee_amount || 0) || 0);
      const seasonalPriceRuleId = String(s?.seasonal_price_rule_id || "").trim();
      const travelOption = travelPriceRuleId && travelAmount > 0 ? `${travelPriceRuleId}|${travelAmount}` : "";
      const seasonalOption = seasonalPriceRuleId && seasonalAmount > 0 ? `${seasonalPriceRuleId}|${seasonalAmount}` : "";
      const sectionSubtotal = baseAmount + parkingAmount + travelAmount + seasonalAmount;
      return `
        <details style="padding:4px 0;">
          <summary style="cursor:pointer; font-weight:400;">
            <span style="display:inline-flex; justify-content:space-between; align-items:center; gap:12px; width:calc(100% - 16px);">
              <span style="font-weight:600;">${escapeHtml(title)}</span>
              <span style="margin-left:auto; text-align:right; min-width:100px; font-weight:600;" data-el="residual_subtotal_${escapeHtml(vid)}">${escapeHtml(sectionSubtotal > 0 ? `${formatMoney_(sectionSubtotal)}円` : "未設定")}</span>
            </span>
          </summary>
          <div style="display:grid; gap:8px; margin-top:8px; padding-left:2px;">
            <button type="button" data-edit="residual_base" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ <span data-el="residual_base_label_${escapeHtml(vid)}">${escapeHtml(baseLabel)}</span></span>
              <strong data-el="residual_base_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(baseAmount))}</strong>
            </button>
            <input type="hidden" name="residual_visit_id_${escapeHtml(vid)}" value="${escapeHtml(vid)}" />
            <input type="hidden" name="residual_base_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(baseAmount))}" />
            <input type="hidden" name="residual_base_fee_label_${escapeHtml(vid)}" value="${escapeHtml(baseLabel)}" />
            <input type="hidden" name="residual_base_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(basePriceRuleId)}" />

            <button type="button" data-edit="residual_parking" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ 駐車料金</span>
              <strong data-el="residual_parking_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(parkingAmount))}</strong>
            </button>
            <input type="hidden" name="residual_parking_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(parkingAmount))}" />
            <input type="hidden" name="residual_parking_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(parkingPriceRuleId)}" />

            <button type="button" data-edit="residual_travel" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ 出張料金</span>
              <strong data-el="residual_travel_amount_${escapeHtml(vid)}">${travelAmount > 0 ? `${escapeHtml(formatMoney_(travelAmount))}円` : "未選択"}</strong>
            </button>
            <input type="hidden" name="residual_travel_option_${escapeHtml(vid)}" value="${escapeHtml(travelOption)}" />

            <button type="button" data-edit="residual_seasonal" data-visit-id="${escapeHtml(vid)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
              <span>🔄️ 繁忙期加算</span>
              <strong data-el="residual_seasonal_amount_${escapeHtml(vid)}">${seasonalAmount > 0 ? `${escapeHtml(formatMoney_(seasonalAmount))}円` : "未選択"}</strong>
            </button>
            <input type="hidden" name="residual_seasonal_option_${escapeHtml(vid)}" value="${escapeHtml(seasonalOption)}" />
          </div>
        </details>
        <div class="hr"></div>
      `;
    }).join("")
    : ``;
  const first = list[0] || {};
  const keyPickupDefault = String(cd?.key_pickup_fee_rule || first?.key_pickup_fee_rule || "").toLowerCase() === "paid" ? (Number(fd.key_pickup_fee || 0) || 0) : 0;
  const keyReturnDefault = String(cd?.key_return_fee_rule || first?.key_return_fee_rule || "").toLowerCase() === "paid" ? (Number(fd.key_return_fee || 0) || 0) : 0;
  const keyPickupDefaultRuleId = keyPickupDefault > 0 ? findRuleForAmount_(keyPickupOptions, keyPickupDefault) : "";
  const keyReturnDefaultRuleId = keyReturnDefault > 0 ? findRuleForAmount_(keyReturnOptions, keyReturnDefault) : "";
  const summaryBase = list.reduce((acc, v) => {
    const label = resolveVisitServiceLabel_(v, fd);
    const base = resolveVisitBaseAmount_(v, fd);
    const order = resolveDisplayOrder_(v?.price_rule_id);
    if (!acc[label]) acc[label] = { qty: 0, amount: 0, display_order: order };
    acc[label].qty += 1;
    acc[label].amount += Math.max(0, Number(base || 0) || 0);
    if (order < acc[label].display_order) acc[label].display_order = order;
    return acc;
  }, {});
  const defaultTotal = Object.keys(summaryBase).reduce((acc, key) => {
    return acc + (Number(summaryBase[key]?.amount || 0) || 0);
  }, 0) + keyPickupDefault + keyReturnDefault;
  const summaryLines = Object.keys(summaryBase).map((k) => ({
    label: k,
    qty: Number(summaryBase[k]?.qty || 0) || 0,
    amount: Number(summaryBase[k]?.amount || 0) || 0,
    display_order: Number(summaryBase[k]?.display_order || 0) || 0
  })).sort((a, b) => {
    const adRaw = Number(a?.display_order);
    const bdRaw = Number(b?.display_order);
    const ad = Number.isFinite(adRaw) ? adRaw : DEFAULT_DISPLAY_ORDER;
    const bd = Number.isFinite(bdRaw) ? bdRaw : DEFAULT_DISPLAY_ORDER;
    if (ad !== bd) return ad - bd;
    return String(a?.label || "").localeCompare(String(b?.label || ""), "ja");
  });
  return `
    <form data-el="billingBatchForm">
      <div style="max-height:70vh; overflow:auto; padding-right:4px;">
        <div style="margin-bottom:10px;"><strong>対象予約: ${escapeHtml(String(targetVisitCount))}件</strong></div>
        <div style="margin-bottom:10px;">${rowsHtml}${residualRowsHtml}</div>
      <div style="display:grid; gap:8px; margin-bottom:12px;">
        <button type="button" data-edit="key_pickup" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
          <span>🔄️ 鍵預かり料金</span>
          <strong data-el="key_pickup_amount">${escapeHtml(amountText_(keyPickupDefault))}</strong>
        </button>
        <button type="button" data-edit="key_return" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
          <span>🔄️ 鍵返却料金</span>
          <strong data-el="key_return_amount">${escapeHtml(amountText_(keyReturnDefault))}</strong>
        </button>
        <input type="hidden" name="key_pickup_fee_amount" value="${escapeHtml(String(keyPickupDefault))}" />
        <input type="hidden" name="key_return_fee_amount" value="${escapeHtml(String(keyReturnDefault))}" />
        <input type="hidden" name="key_pickup_price_rule_id" value="${escapeHtml(keyPickupDefaultRuleId)}" />
        <input type="hidden" name="key_return_price_rule_id" value="${escapeHtml(keyReturnDefaultRuleId)}" />
      </div>
      <div style="margin-bottom:12px;">
        <button type="button" data-edit="discount" style="display:flex; align-items:center; justify-content:space-between; width:100%; border:none; background:transparent; color:inherit; padding:6px 0; cursor:pointer;">
          <span>🔄️ 割引</span>
          <strong data-el="discount_amount">未設定</strong>
        </button>
        <input type="hidden" name="discount_label" value="割引" />
        <input type="hidden" name="discount_amount" value="0" />
        <input type="hidden" name="discount_price_rule_id" value="" />
      </div>
      <div style="margin-bottom:12px;">
        <div><strong>${cancellationMode ? "キャンセル料明細" : "明細"}</strong></div>
        <div class="row row-between" style="margin-top:6px;">
          <span>請求総額</span><strong style="text-align:right;" data-el="summary_total">${escapeHtml(formatMoney_(defaultTotal))}円</strong>
        </div>
        <div style="margin-top:6px; display:grid; gap:4px; opacity:.9;" data-el="summary_lines">
          ${summaryLines.map((x) => {
            const rowText = `${x.label} ×${x.qty}`;
            return `<div class="row row-between"><span>${escapeHtml(rowText)}</span><span style="text-align:right; min-width:90px;">${escapeHtml(formatMoney_(x.amount))}円</span></div>`;
          }).join("") || `<div>-</div>`}
        </div>
      </div>
      <div>
        <div style="opacity:.85; margin-bottom:4px;"><strong>メモ</strong></div>
        <textarea class="input" name="memo" rows="4" placeholder="備考（任意）"></textarea>
      </div>
      <input type="hidden" name="cancellation_rate" value="${escapeHtml(String(cancellationRate))}" />
      </div>
    </form>
  `;
}

function parseOptionAmount_(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;
  const parts = s.split("|");
  if (parts.length < 2) return 0;
  return Math.max(0, Number(parts[1] || 0) || 0);
}

function wireBillingBatchFormInteractions_(host, selected, feeDefaults, options = {}) {
  const list = Array.isArray(selected) ? selected : [];
  const fd = feeDefaults || {};
  const cancellationRate = Math.max(0, Number(options?.cancellation_rate || host.querySelector('[name="cancellation_rate"]')?.value || 0) || 0);
  const cancellationMode = cancellationRate === 50 || cancellationRate === 100;
  const cancellationPreset = (options?.cancellation_preset && typeof options.cancellation_preset === "object")
    ? options.cancellation_preset
    : null;
  const presetCancellationBaseAmount = Math.max(0, Number(cancellationPreset?.cancellation_base_amount || 0) || 0);
  const presetResidualLines = Array.isArray(cancellationPreset?.residual_extra_lines)
    ? cancellationPreset.residual_extra_lines
    : [];
  const useCancellationPreset = cancellationMode && (presetCancellationBaseAmount > 0 || presetResidualLines.length > 0);
  const parkingOptions = Array.isArray(fd.parking_options) ? fd.parking_options : [];
  const travelOptions = Array.isArray(fd.travel_options) ? fd.travel_options : [];
  const seasonalOptions = Array.isArray(fd.seasonal_options) ? fd.seasonal_options : [];
  const keyPickupOptions = Array.isArray(fd.key_pickup_options) ? fd.key_pickup_options : [];
  const keyReturnOptions = Array.isArray(fd.key_return_options) ? fd.key_return_options : [];
  const merchandiseOptions = Array.isArray(fd.merchandise_options) ? fd.merchandise_options : [];
  const discountOptions = Array.isArray(fd.discount_options) ? fd.discount_options : [];
  const DEFAULT_DISPLAY_ORDER = 999999;
  const displayOrderByRuleId = new Map();
  const registerDisplayOrder_ = (opts) => {
    (Array.isArray(opts) ? opts : []).forEach((o, idx) => {
      const rid = String(o?.price_rule_id || "").trim();
      if (!rid) return;
      const d = Number(o?.display_order);
      const order = Number.isFinite(d) ? d : idx;
      const cur = displayOrderByRuleId.get(rid);
      if (cur == null || order < cur) displayOrderByRuleId.set(rid, order);
    });
  };
  registerDisplayOrder_(fd.visit_base_rules);
  registerDisplayOrder_(parkingOptions);
  registerDisplayOrder_(travelOptions);
  registerDisplayOrder_(seasonalOptions);
  registerDisplayOrder_(merchandiseOptions);
  registerDisplayOrder_(keyPickupOptions);
  registerDisplayOrder_(keyReturnOptions);
  const resolveDisplayOrder_ = (priceRuleId, fallback = DEFAULT_DISPLAY_ORDER) => {
    const rid = String(priceRuleId || "").trim();
    if (rid && displayOrderByRuleId.has(rid)) return displayOrderByRuleId.get(rid);
    return fallback;
  };
  const parseOptionRuleIdLocal_ = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return "";
    return String(s.split("|")[0] || "").trim();
  };
  const resolveParkingRuleId_ = (vid, amount) => {
    const direct = String(host.querySelector(`[name="parking_price_rule_id_${vid}"]`)?.value || "").trim();
    if (direct) return direct;
    const target = Math.max(0, Number(amount || 0) || 0);
    const hit = parkingOptions.find((x) => (Math.max(0, Number(x?.amount || 0) || 0) === target));
    if (hit?.price_rule_id) return String(hit.price_rule_id).trim();
    return String(parkingOptions[0]?.price_rule_id || "").trim();
  };
  const findRuleForAmountLocal_ = (opts, amt) => {
    const target = Math.max(0, Number(amt || 0) || 0);
    const hit = (Array.isArray(opts) ? opts : []).find((x) => (Math.max(0, Number(x?.amount || 0) || 0) === target));
    return String(hit?.price_rule_id || "").trim();
  };
  const baseOptions = (Array.isArray(fd.visit_base_rules) ? fd.visit_base_rules : []).map((r) => {
    const rid = String(r?.price_rule_id || "").trim();
    const product = String(r?.product_name || "").trim();
    const variant = String(r?.variant_name || "").trim();
    const label = String(r?.label || [product, variant].filter(Boolean).join(" ").trim() || rid).trim() || rid;
    const amount = Math.max(0, Number(r?.amount || 0) || 0);
    return { price_rule_id: rid, label, amount };
  });
  const setValue_ = (name, value) => {
    const el = host.querySelector(`[name="${name}"]`);
    if (el) el.value = String(value == null ? "" : value);
  };
  const setText_ = (key, text) => {
    const el = host.querySelector(`[data-el="${key}"]`);
    if (el) el.textContent = String(text || "");
  };
  const openEditor_ = ({ title, bodyHtml, okText = "決定", cancelText = "キャンセル", onSubmit }) => {
    const root = document.createElement("div");
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.background = "rgba(0,0,0,.55)";
    root.style.zIndex = "90";
    root.style.display = "grid";
    root.style.placeItems = "center";
    root.style.padding = "14px";
    root.innerHTML = `
      <div style="width:min(560px,100%); border:1px solid var(--line); background:var(--panel); border-radius:16px; box-shadow:var(--shadow); padding:14px;">
        <div style="font-weight:900; font-size:16px;">${escapeHtml(title || "")}</div>
        <div style="margin-top:8px; color:var(--muted); max-height:55vh; overflow:auto;">${bodyHtml || ""}</div>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:12px; flex-wrap:wrap;">
          <button type="button" data-act="cancel" class="btn btn-ghost">${escapeHtml(cancelText)}</button>
          <button type="button" data-act="ok" class="btn">${escapeHtml(okText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    return new Promise((resolve) => {
      const close_ = (val) => {
        try { root.remove(); } catch (_) {}
        resolve(val);
      };
      root.querySelector('[data-act="cancel"]')?.addEventListener("click", () => close_(null));
      root.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
        try {
          const out = (typeof onSubmit === "function") ? onSubmit(root) : true;
          close_(out);
        } catch (_) {
          close_(null);
        }
      });
      root.addEventListener("click", (e) => {
        if (e.target === root) close_(null);
      });
    });
  };
  const promptNumber_ = async (title, current) => {
    const val = await openEditor_({
      title,
      bodyHtml: `
        <div style="display:flex; align-items:center; gap:8px;">
          <input
            class="input"
            data-el="num"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            placeholder="金額を入力"
            style="text-align:right;"
            value="${escapeHtml((Number(current || 0) || 0) > 0 ? String(Math.round(Number(current || 0) || 0)) : "")}"
          />
          <span>円</span>
        </div>
      `,
      onSubmit: (root) => {
        const raw = String(root.querySelector('[data-el="num"]')?.value || "").trim();
        if (!raw) return 0;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.round(n);
      }
    });
    return (val == null) ? null : val;
  };
  const pickOptionByModal_ = async (title, options) => {
    if (!options.length) {
      window.alert("選択肢がありません。設定画面で料金マスタを作成してください。");
      return null;
    }
    const html = `
      <select class="select" data-el="opt" style="width:100%;">
        <option value="">含めない</option>
        ${options.map((o) => `<option value="${escapeHtml(`${o.price_rule_id}|${o.amount}`)}">${escapeHtml(String(o.label || ""))} (${escapeHtml(formatMoney_(o.amount))}円)</option>`).join("")}
      </select>
    `;
    const val = await openEditor_({
      title,
      bodyHtml: html,
      onSubmit: (root) => String(root.querySelector('[data-el="opt"]')?.value || "")
    });
    return (val == null) ? null : String(val || "");
  };
  const pickMerchandiseByModal_ = async (vid) => {
    if (!merchandiseOptions.length) {
      window.alert("一般商品の選択肢がありません。設定画面で item_type=merchandise を登録してください。");
      return null;
    }
    const qtyCur = Math.max(1, Number(host.querySelector(`[name="extra_qty_${vid}"]`)?.value || 1) || 1);
    const html = `
      <div style="display:grid; gap:8px;">
        <div>
          <div style="opacity:.85; margin-bottom:4px;">商品</div>
          <select class="select" data-el="opt" style="width:100%;">
            ${merchandiseOptions.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}">${escapeHtml(String(o.label || ""))} (${escapeHtml(formatMoney_(o.amount))}円)</option>`).join("")}
          </select>
        </div>
        <div>
          <div style="opacity:.85; margin-bottom:4px;">数量</div>
          <input class="input" data-el="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(String(qtyCur))}" />
        </div>
      </div>
    `;
    const out = await openEditor_({
      title: "商品追加",
      bodyHtml: html,
      onSubmit: (root) => {
        const rid = String(root.querySelector('[data-el="opt"]')?.value || "").trim();
        const qty = Math.max(1, Number(root.querySelector('[data-el="qty"]')?.value || 1) || 1);
        const chosen = merchandiseOptions.find((o) => String(o?.price_rule_id || "").trim() === rid);
        if (!chosen) return null;
        return {
          price_rule_id: rid,
          label: String(chosen.label || "").trim(),
          amount: Math.max(0, Number(chosen.amount || 0) || 0),
          qty
        };
      }
    });
    return out;
  };

  const pickRuleOptionByModal_ = async (title, options) => {
    if (!options.length) {
      window.alert("選択肢がありません。設定画面で料金マスタを作成してください。");
      return null;
    }
    const html = `
      <select class="select" data-el="opt" style="width:100%;">
        <option value="">適用しない</option>
        ${options.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}">${escapeHtml(String(o.label || ""))} (${escapeHtml(formatMoney_(o.amount))}円)</option>`).join("")}
      </select>
    `;
    const pickedId = await openEditor_({
      title,
      bodyHtml: html,
      onSubmit: (root) => String(root.querySelector('[data-el="opt"]')?.value || "").trim()
    });
    if (pickedId == null) return null;
    const chosen = options.find((o) => String(o?.price_rule_id || "").trim() === String(pickedId || "").trim()) || null;
    return chosen || { price_rule_id: "", label: "", amount: 0 };
  };
  const readResidualLines_ = () => {
    const rows = [];
    const vidSet = new Set();
    host.querySelectorAll('input[name^="residual_visit_id_"]').forEach((visitInput) => {
      const vid = String(visitInput?.value || "").trim();
      if (vid) vidSet.add(vid);
    });
    Array.from(vidSet).forEach((visitId) => {
      const baseLabel = String(host.querySelector(`[name="residual_base_fee_label_${visitId}"]`)?.value || "").trim() || "商品未設定";
      const baseAmount = Math.max(0, Number(host.querySelector(`[name="residual_base_fee_amount_${visitId}"]`)?.value || 0) || 0);
      const basePriceRuleId = String(host.querySelector(`[name="residual_base_price_rule_id_${visitId}"]`)?.value || "").trim();
      if (baseAmount > 0) {
        rows.push({
          visit_id: visitId,
          label: baseLabel,
          quantity: 1,
          unit_price: baseAmount,
          amount_total: baseAmount,
          price_rule_id: basePriceRuleId,
        });
      }
      const parkingAmount = Math.max(0, Number(host.querySelector(`[name="residual_parking_fee_amount_${visitId}"]`)?.value || 0) || 0);
      let parkingPriceRuleId = String(host.querySelector(`[name="residual_parking_price_rule_id_${visitId}"]`)?.value || "").trim();
      if (!parkingPriceRuleId) parkingPriceRuleId = findRuleForAmountLocal_(parkingOptions, parkingAmount);
      if (parkingAmount > 0) {
        rows.push({
          visit_id: visitId,
          label: "駐車料金",
          quantity: 1,
          unit_price: parkingAmount,
          amount_total: parkingAmount,
          price_rule_id: parkingPriceRuleId,
        });
      }
      const travelRaw = String(host.querySelector(`[name="residual_travel_option_${visitId}"]`)?.value || "").trim();
      const travelAmount = parseOptionAmount_(travelRaw);
      const travelPriceRuleId = parseOptionRuleIdLocal_(travelRaw);
      if (travelAmount > 0) {
        rows.push({
          visit_id: visitId,
          label: "出張料金",
          quantity: 1,
          unit_price: travelAmount,
          amount_total: travelAmount,
          price_rule_id: travelPriceRuleId,
        });
      }
      const seasonalRaw = String(host.querySelector(`[name="residual_seasonal_option_${visitId}"]`)?.value || "").trim();
      const seasonalAmount = parseOptionAmount_(seasonalRaw);
      const seasonalPriceRuleId = parseOptionRuleIdLocal_(seasonalRaw);
      if (seasonalAmount > 0) {
        rows.push({
          visit_id: visitId,
          label: "繁忙期加算",
          quantity: 1,
          unit_price: seasonalAmount,
          amount_total: seasonalAmount,
          price_rule_id: seasonalPriceRuleId,
        });
      }
    });
    return rows;
  };

  const updateTotals_ = () => {
    let grand = 0;
    let targetSubtotal = 0;
    let residualSubtotal = 0;
    const lineMap = new Map();
    const addLine_ = (label, amount, quantity = 1, priceRuleId = "") => {
      const q = Math.max(0, Number(quantity || 0) || 0);
      const a = Math.max(0, Number(amount || 0) || 0);
      if (!(a > 0) || !(q > 0)) return;
      const key = String(label || "").trim();
      if (!key) return;
      const cur = lineMap.get(key) || { label: key, qty: 0, amount: 0, display_order: resolveDisplayOrder_(priceRuleId) };
      cur.qty += q;
      cur.amount += a;
      const order = resolveDisplayOrder_(priceRuleId);
      if (order < cur.display_order) cur.display_order = order;
      lineMap.set(key, cur);
    };
    list.forEach((v) => {
      const vid = String(v?.visit_id || "").trim();
      if (!vid) return;
      const productLabel = String(host.querySelector(`[name="base_fee_label_${vid}"]`)?.value || "").trim() || resolveVisitServiceLabel_(v, fd);
      const base = Math.max(0, Number(host.querySelector(`[name="base_fee_amount_${vid}"]`)?.value || 0) || 0);
      const parking = Math.max(0, Number(host.querySelector(`[name="parking_fee_amount_${vid}"]`)?.value || 0) || 0);
      const travel = parseOptionAmount_(host.querySelector(`[name="travel_option_${vid}"]`)?.value || "");
      const seasonal = parseOptionAmount_(host.querySelector(`[name="seasonal_option_${vid}"]`)?.value || "");
      const extraQty = Math.max(1, Number(host.querySelector(`[name="extra_qty_${vid}"]`)?.value || 1) || 1);
      const extraAmount = Math.max(0, Number(host.querySelector(`[name="extra_amount_${vid}"]`)?.value || 0) || 0);
      const extraLabel = String(host.querySelector(`[name="extra_label_${vid}"]`)?.value || "").trim();
      const rateFactor = cancellationMode ? (cancellationRate / 100) : 1;
      const subtotal = cancellationMode
        ? Math.max(0, Math.round((base + parking + travel + seasonal) * rateFactor * 100) / 100)
        : (base + parking + travel + seasonal + (extraQty * extraAmount));
      const target = base + parking + travel + seasonal;
      const subtotalEl = host.querySelector(`[data-el="subtotal_${vid}"]`);
      if (subtotalEl) subtotalEl.textContent = subtotal > 0 ? `${formatMoney_(subtotal)}円` : "未設定";
      grand += subtotal;
      targetSubtotal += target;

      const basePriceRuleId = String(host.querySelector(`[name="base_price_rule_id_${vid}"]`)?.value || "").trim();
      const parkingRuleId = resolveParkingRuleId_(vid, parking);
      const travelRuleId = parseOptionRuleIdLocal_(host.querySelector(`[name="travel_option_${vid}"]`)?.value || "");
      const seasonalRuleId = parseOptionRuleIdLocal_(host.querySelector(`[name="seasonal_option_${vid}"]`)?.value || "");
      const extraPriceRuleId = String(host.querySelector(`[name="extra_price_rule_id_${vid}"]`)?.value || "").trim();
      if (!useCancellationPreset) {
        addLine_(productLabel, cancellationMode ? Math.max(0, Math.round(base * rateFactor * 100) / 100) : base, 1, basePriceRuleId);
        addLine_("駐車料金", cancellationMode ? Math.max(0, Math.round(parking * rateFactor * 100) / 100) : parking, 1, parkingRuleId);
        addLine_("出張料金", cancellationMode ? Math.max(0, Math.round(travel * rateFactor * 100) / 100) : travel, 1, travelRuleId);
        addLine_("繁忙期加算", cancellationMode ? Math.max(0, Math.round(seasonal * rateFactor * 100) / 100) : seasonal, 1, seasonalRuleId);
      }
      if (!cancellationMode && extraLabel && extraAmount > 0) addLine_(extraLabel, extraQty * extraAmount, extraQty, extraPriceRuleId);
    });

    const keyPickup = Math.max(0, Number(host.querySelector('[name="key_pickup_fee_amount"]')?.value || 0) || 0);
    const keyReturn = Math.max(0, Number(host.querySelector('[name="key_return_fee_amount"]')?.value || 0) || 0);
    const discount = Math.max(0, Number(host.querySelector('[name="discount_amount"]')?.value || 0) || 0);
    if (keyPickup > 0) {
      let rid = String(host.querySelector('[name="key_pickup_price_rule_id"]')?.value || "").trim();
      if (!rid) rid = findRuleForAmountLocal_(keyPickupOptions, keyPickup);
      addLine_("鍵預かり料金", keyPickup, 1, rid);
    }
    if (keyReturn > 0) {
      let rid = String(host.querySelector('[name="key_return_price_rule_id"]')?.value || "").trim();
      if (!rid) rid = findRuleForAmountLocal_(keyReturnOptions, keyReturn);
      addLine_("鍵返却料金", keyReturn, 1, rid);
    }
    const keyTotal = keyPickup + keyReturn;
    let finalTotal = grand + keyTotal - discount;
    let cancelFee = 0;
    let afterRateTotal = grand + keyTotal;
    if (cancellationMode) {
      const cancelBase = (useCancellationPreset && presetCancellationBaseAmount > 0)
        ? presetCancellationBaseAmount
        : targetSubtotal;
      cancelFee = Math.max(0, Math.round(cancelBase * (cancellationRate / 100) * 100) / 100);
      if (useCancellationPreset) {
        addLine_("キャンセル料", cancelFee, 1, "");
        const residualLines = readResidualLines_();
        residualLines.forEach((x) => {
          const label = String(x?.label || "").trim();
          const qty = Math.max(1, Number(x?.quantity || 1) || 1);
          const unit = Math.max(0, Number(x?.unit_price || 0) || 0);
          const total = Math.max(0, Number(x?.amount_total || (qty * unit)) || 0);
          if (!label || !(total > 0)) return;
          residualSubtotal += total;
          addLine_(label, total, qty, String(x?.price_rule_id || "").trim());
        });
      }
      afterRateTotal = cancelFee + keyTotal + residualSubtotal;
      finalTotal = afterRateTotal - discount;
    }

    const totalEl = host.querySelector('[data-el="summary_total"]');
    if (totalEl) totalEl.textContent = `${formatMoney_(Math.max(0, finalTotal))}円`;
    const linesEl = host.querySelector('[data-el="summary_lines"]');
    if (linesEl) {
      const rows = Array.from(lineMap.values())
        .sort((a, b) => {
          const adRaw = Number(a?.display_order);
          const bdRaw = Number(b?.display_order);
          const ad = Number.isFinite(adRaw) ? adRaw : DEFAULT_DISPLAY_ORDER;
          const bd = Number.isFinite(bdRaw) ? bdRaw : DEFAULT_DISPLAY_ORDER;
          if (ad !== bd) return ad - bd;
          return String(a?.label || "").localeCompare(String(b?.label || ""), "ja");
        })
        .map((x) => `<div class="row row-between"><span>${escapeHtml(`${x.label} ×${x.qty}`)}</span><span style="text-align:right; min-width:90px;">${escapeHtml(formatMoney_(x.amount))}円</span></div>`)
        .join("");
      const discountRow = discount > 0 ? `<div class="row row-between"><span>${escapeHtml(String(host.querySelector('[name="discount_label"]')?.value || "割引"))}</span><span style="text-align:right; min-width:90px;">-${escapeHtml(formatMoney_(discount))}円</span></div>` : ``;
      linesEl.innerHTML = rows + discountRow || `<div>-</div>`;
    }
  };
  const refreshDisplay_ = () => {
    list.forEach((v) => {
      const vid = String(v?.visit_id || "").trim();
      if (!vid) return;
      const parking = Math.max(0, Number(host.querySelector(`[name="parking_fee_amount_${vid}"]`)?.value || 0) || 0);
      const travel = parseOptionAmount_(host.querySelector(`[name="travel_option_${vid}"]`)?.value || "");
      const seasonal = parseOptionAmount_(host.querySelector(`[name="seasonal_option_${vid}"]`)?.value || "");
      const extraQty = Math.max(1, Number(host.querySelector(`[name="extra_qty_${vid}"]`)?.value || 1) || 1);
      const extraAmount = Math.max(0, Number(host.querySelector(`[name="extra_amount_${vid}"]`)?.value || 0) || 0);
      const extraLabel = String(host.querySelector(`[name="extra_label_${vid}"]`)?.value || "").trim();
      setText_(`parking_amount_${vid}`, amountText_(parking));
      setText_(`travel_amount_${vid}`, travel > 0 ? `${formatMoney_(travel)}円` : "未選択");
      setText_(`seasonal_amount_${vid}`, seasonal > 0 ? `${formatMoney_(seasonal)}円` : "未選択");
      setText_(`extra_label_${vid}`, (extraLabel && extraAmount > 0) ? `${extraLabel} × ${extraQty} (${formatMoney_(extraAmount)}円)` : "未設定");
    });
    const residualVidSet = new Set();
    host.querySelectorAll('input[name^="residual_visit_id_"]').forEach((visitInput) => {
      const vid = String(visitInput?.value || "").trim();
      if (vid) residualVidSet.add(vid);
    });
    Array.from(residualVidSet).forEach((vid) => {
      const baseLabel = String(host.querySelector(`[name="residual_base_fee_label_${vid}"]`)?.value || "").trim() || "商品未設定";
      const baseAmount = Math.max(0, Number(host.querySelector(`[name="residual_base_fee_amount_${vid}"]`)?.value || 0) || 0);
      const parkingAmount = Math.max(0, Number(host.querySelector(`[name="residual_parking_fee_amount_${vid}"]`)?.value || 0) || 0);
      const travelAmount = parseOptionAmount_(host.querySelector(`[name="residual_travel_option_${vid}"]`)?.value || "");
      const seasonalAmount = parseOptionAmount_(host.querySelector(`[name="residual_seasonal_option_${vid}"]`)?.value || "");
      setText_(`residual_base_label_${vid}`, baseLabel);
      setText_(`residual_base_amount_${vid}`, amountText_(baseAmount));
      setText_(`residual_parking_amount_${vid}`, amountText_(parkingAmount));
      setText_(`residual_travel_amount_${vid}`, travelAmount > 0 ? `${formatMoney_(travelAmount)}円` : "未選択");
      setText_(`residual_seasonal_amount_${vid}`, seasonalAmount > 0 ? `${formatMoney_(seasonalAmount)}円` : "未選択");
    });
    host.querySelectorAll('[data-el^="residual_subtotal_"]').forEach((el) => {
      if (el) el.textContent = "未設定";
    });
    const residualByVisit = {};
    readResidualLines_().forEach((x) => {
      const vid = String(x?.visit_id || "").trim();
      const amount = Math.max(0, Number(x?.amount_total || 0) || 0);
      if (!vid) return;
      residualByVisit[vid] = (Number(residualByVisit[vid] || 0) || 0) + amount;
    });
    Object.keys(residualByVisit).forEach((vid) => {
      const amt = Math.max(0, Number(residualByVisit[vid] || 0) || 0);
      setText_(`residual_subtotal_${vid}`, amt > 0 ? `${formatMoney_(amt)}円` : "未設定");
    });
    const keyPickup = Math.max(0, Number(host.querySelector('[name="key_pickup_fee_amount"]')?.value || 0) || 0);
    setText_("key_pickup_amount", amountText_(keyPickup));

    const keyReturn = Math.max(0, Number(host.querySelector('[name="key_return_fee_amount"]')?.value || 0) || 0);
    setText_("key_return_amount", amountText_(keyReturn));

    const discount = Math.max(0, Number(host.querySelector('[name="discount_amount"]')?.value || 0) || 0);
    setText_("discount_amount", discount > 0 ? `${formatMoney_(discount)}円` : "未設定");
    updateTotals_();
  };

  host.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const type = String(btn.getAttribute("data-edit") || "");
      const vid = String(btn.getAttribute("data-visit-id") || "");
      if (type === "base" && vid) {
        const picked = await pickRuleOptionByModal_("訪問基本料金を選択", baseOptions);
        if (picked == null) return;
        const amount = Math.max(0, Number(picked.amount || 0) || 0);
        const rid = String(picked.price_rule_id || "").trim();
        const label = String(picked.label || "").trim() || "商品未設定";
        setValue_(`base_fee_amount_${vid}`, amount);
        setValue_(`base_fee_label_${vid}`, label);
        setValue_(`base_price_rule_id_${vid}`, rid);
        setText_(`base_amount_${vid}`, amountText_(amount));
        updateTotals_();
        return;
      }
      if (type === "parking" && vid) {
        const name = `parking_fee_amount_${vid}`;
        const cur = Number(host.querySelector(`[name="${name}"]`)?.value || 0) || 0;
        const next = await promptNumber_("駐車料金", cur);
        if (next == null) return;
        setValue_(name, next);
        const ridName = `parking_price_rule_id_${vid}`;
        const ridCur = String(host.querySelector(`[name="${ridName}"]`)?.value || "").trim();
        if (!ridCur) {
          const rid = String(parkingOptions[0]?.price_rule_id || "").trim();
          if (rid) setValue_(ridName, rid);
        }
        setText_(`parking_amount_${vid}`, amountText_(next));
        updateTotals_();
        return;
      }
      if (type === "travel" && vid) {
        const picked = await pickOptionByModal_("出張料金を選択", travelOptions);
        if (picked == null) return;
        setValue_(`travel_option_${vid}`, picked);
        const amount = parseOptionAmount_(picked);
        setText_(`travel_amount_${vid}`, amount > 0 ? `${formatMoney_(amount)}円` : "未選択");
        updateTotals_();
        return;
      }
      if (type === "seasonal" && vid) {
        const picked = await pickOptionByModal_("繁忙期加算を選択", seasonalOptions);
        if (picked == null) return;
        setValue_(`seasonal_option_${vid}`, picked);
        const amount = parseOptionAmount_(picked);
        setText_(`seasonal_amount_${vid}`, amount > 0 ? `${formatMoney_(amount)}円` : "未選択");
        updateTotals_();
        return;
      }
      if (type === "extra" && vid) {
        const chosen = await pickMerchandiseByModal_(vid);
        if (!chosen) return;
        const qty = Math.max(1, Number(chosen.qty || 1) || 1);
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        const label = String(chosen.label || "").trim();
        setValue_(`extra_label_${vid}`, label);
        setValue_(`extra_qty_${vid}`, qty);
        setValue_(`extra_amount_${vid}`, amount);
        setValue_(`extra_price_rule_id_${vid}`, String(chosen.price_rule_id || ""));
        const txt = (label && amount > 0) ? `${label} × ${qty} (${formatMoney_(amount)}円)` : "未設定";
        setText_(`extra_label_${vid}`, txt);
        updateTotals_();
        return;
      }
      if (type === "residual_base" && vid) {
        const picked = await pickRuleOptionByModal_("訪問基本料金を選択", baseOptions);
        if (picked == null) return;
        const amount = Math.max(0, Number(picked.amount || 0) || 0);
        const rid = String(picked.price_rule_id || "").trim();
        const label = String(picked.label || "").trim() || "商品未設定";
        setValue_(`residual_base_fee_amount_${vid}`, amount);
        setValue_(`residual_base_fee_label_${vid}`, label);
        setValue_(`residual_base_price_rule_id_${vid}`, rid);
        setText_(`residual_base_label_${vid}`, label);
        setText_(`residual_base_amount_${vid}`, amountText_(amount));
        updateTotals_();
        return;
      }
      if (type === "residual_parking" && vid) {
        const name = `residual_parking_fee_amount_${vid}`;
        const cur = Number(host.querySelector(`[name="${name}"]`)?.value || 0) || 0;
        const next = await promptNumber_("駐車料金", cur);
        if (next == null) return;
        setValue_(name, next);
        const ridName = `residual_parking_price_rule_id_${vid}`;
        const ridCur = String(host.querySelector(`[name="${ridName}"]`)?.value || "").trim();
        if (!ridCur) {
          const rid = String(parkingOptions[0]?.price_rule_id || "").trim();
          if (rid) setValue_(ridName, rid);
        }
        setText_(`residual_parking_amount_${vid}`, amountText_(next));
        updateTotals_();
        return;
      }
      if (type === "residual_travel" && vid) {
        const picked = await pickOptionByModal_("出張料金を選択", travelOptions);
        if (picked == null) return;
        setValue_(`residual_travel_option_${vid}`, picked);
        const amount = parseOptionAmount_(picked);
        setText_(`residual_travel_amount_${vid}`, amount > 0 ? `${formatMoney_(amount)}円` : "未選択");
        updateTotals_();
        return;
      }
      if (type === "residual_seasonal" && vid) {
        const picked = await pickOptionByModal_("繁忙期加算を選択", seasonalOptions);
        if (picked == null) return;
        setValue_(`residual_seasonal_option_${vid}`, picked);
        const amount = parseOptionAmount_(picked);
        setText_(`residual_seasonal_amount_${vid}`, amount > 0 ? `${formatMoney_(amount)}円` : "未選択");
        updateTotals_();
        return;
      }
      if (type === "key_pickup") {
        const picked = await pickRuleOptionByModal_("鍵預かり料金を選択", keyPickupOptions);
        if (picked == null) return;
        const amount = Math.max(0, Number(picked.amount || 0) || 0);
        const rid = String(picked.price_rule_id || "").trim();
        setValue_("key_pickup_fee_amount", amount);
        setValue_("key_pickup_price_rule_id", rid);
        setText_("key_pickup_amount", amountText_(amount));
        updateTotals_();
        return;
      }
      if (type === "key_return") {
        const picked = await pickRuleOptionByModal_("鍵返却料金を選択", keyReturnOptions);
        if (picked == null) return;
        const amount = Math.max(0, Number(picked.amount || 0) || 0);
        const rid = String(picked.price_rule_id || "").trim();
        setValue_("key_return_fee_amount", amount);
        setValue_("key_return_price_rule_id", rid);
        setText_("key_return_amount", amountText_(amount));
        updateTotals_();
        return;
      }
      if (type === "discount") {
        const curLabel = String(host.querySelector('[name="discount_label"]')?.value || "割引");
        const curAmount = Math.max(0, Number(host.querySelector('[name="discount_amount"]')?.value || 0) || 0);
        const curPriceRuleId = String(host.querySelector('[name="discount_price_rule_id"]')?.value || "").trim();
        const selectedTemplate = (discountOptions || []).find((x) => String(x?.price_rule_id || "").trim() === curPriceRuleId)
          || (discountOptions || []).find((x) => String(x?.label || "").trim() === curLabel)
          || null;
        const templateOptionsHtml = (discountOptions || []).map((x) => {
          const rid = String(x?.price_rule_id || "").trim();
          const isSelected = selectedTemplate && String(selectedTemplate.price_rule_id || "").trim() === rid;
          const amount = Math.max(0, Number(x?.amount || 0) || 0);
          return `<option value="${escapeHtml(rid)}" ${isSelected ? "selected" : ""}>${escapeHtml(String(x?.label || rid || "テンプレート"))}${amount > 0 ? `（既定 ${escapeHtml(formatMoney_(amount))}円）` : ""}</option>`;
        }).join("");
        const out = await openEditor_({
          title: "割引",
          bodyHtml: `
            <div style="display:grid; gap:8px;">
              ${(!cancellationMode && discountOptions.length) ? `
              <div>
                <div style="opacity:.85; margin-bottom:4px;">テンプレート</div>
                <select class="input" data-el="template">
                  <option value="">選択しない（手入力）</option>
                  ${templateOptionsHtml}
                </select>
              </div>
              ` : ``}
              <div>
                <div style="opacity:.85; margin-bottom:4px;">割引名</div>
                <input class="input" data-el="label" type="text" value="${escapeHtml(curLabel)}" />
              </div>
              <div>
                <div style="opacity:.85; margin-bottom:4px;">割引額</div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <input
                    class="input"
                    data-el="amount"
                    type="number"
                    min="0"
                    step="1"
                    inputmode="numeric"
                    placeholder="金額を入力"
                    style="text-align:right;"
                    value="${escapeHtml(curAmount > 0 ? String(curAmount) : "")}"
                  />
                  <span>円</span>
                </div>
              </div>
            </div>
          `,
          onSubmit: (root) => {
            const templateId = cancellationMode
              ? ""
              : String(root.querySelector('[data-el="template"]')?.value || "").trim();
            const template = cancellationMode
              ? null
              : ((discountOptions || []).find((x) => String(x?.price_rule_id || "").trim() === templateId) || null);
            const rawLabel = String(root.querySelector('[data-el="label"]')?.value || "").trim();
            const rawAmount = String(root.querySelector('[data-el="amount"]')?.value || "").trim();
            return {
              price_rule_id: templateId,
              label: rawLabel || String(template?.label || "割引"),
              amount: rawAmount ? Math.max(0, Number(rawAmount) || 0) : Math.max(0, Number(template?.amount || 0) || 0)
            };
          }
        });
        if (!out) return;
        const amount = Math.max(0, Number(out.amount || 0) || 0);
        setValue_("discount_label", String(out.label || "").trim() || "割引");
        setValue_("discount_amount", amount);
        setValue_("discount_price_rule_id", String(out.price_rule_id || "").trim());
        setText_("discount_amount", amount > 0 ? `${formatMoney_(amount)}円` : "未設定");
        updateTotals_();
      }
    });
  });
  refreshDisplay_();
  return { refresh: refreshDisplay_ };
}

function buildBillingBatchPreviewHtml_(selected, payload, feeDefaults, options = {}) {
  const list = Array.isArray(selected) ? selected : [];
  const p = payload || {};
  const fd = feeDefaults || {};
  const cancellationRate = Math.max(0, Number(options?.cancellation_rate || p?.cancellation_rate || 0) || 0);
  const cancellationMode = cancellationRate === 50 || cancellationRate === 100;
  const DEFAULT_DISPLAY_ORDER = 999999;
  const displayOrderByRuleId = new Map();
  const registerDisplayOrder_ = (opts) => {
    (Array.isArray(opts) ? opts : []).forEach((o, idx) => {
      const rid = String(o?.price_rule_id || "").trim();
      if (!rid) return;
      const d = Number(o?.display_order);
      const order = Number.isFinite(d) ? d : idx;
      const cur = displayOrderByRuleId.get(rid);
      if (cur == null || order < cur) displayOrderByRuleId.set(rid, order);
    });
  };
  registerDisplayOrder_(fd.visit_base_rules);
  registerDisplayOrder_(fd.parking_options);
  registerDisplayOrder_(fd.travel_options);
  registerDisplayOrder_(fd.seasonal_options);
  registerDisplayOrder_(fd.merchandise_options);
  registerDisplayOrder_(fd.key_pickup_options);
  registerDisplayOrder_(fd.key_return_options);
  const resolveDisplayOrder_ = (priceRuleId, fallback = DEFAULT_DISPLAY_ORDER) => {
    const rid = String(priceRuleId || "").trim();
    if (rid && displayOrderByRuleId.has(rid)) return displayOrderByRuleId.get(rid);
    return fallback;
  };
  const discountAmount = Number(p?.discount_amount || 0) || 0;
  const discountLabel = String(p?.discount_label || "").trim() || "割引";
  const byVisit = new Map((Array.isArray(p?.visit_overrides) ? p.visit_overrides : []).map((x) => [String(x?.visit_id || ""), x]));
  const extraByVisit = new Map();
  const extraLines = Array.isArray(p?.extra_lines) ? p.extra_lines : [];
  const selectedVisitIdSet = new Set(list.map((v) => String(v?.visit_id || "").trim()).filter(Boolean));
  extraLines.forEach((x) => {
    const vid = String(x?.visit_id || "").trim();
    if (!vid) return;
    if (!extraByVisit.has(vid)) extraByVisit.set(vid, []);
    extraByVisit.get(vid).push(x);
  });
  const lineMap = new Map();
  let targetSubtotal = 0;
  let cancelLineRuleId = "";
  const addLine_ = (name, unitPrice, quantity, priceRuleId = "") => {
    const n = String(name || "").trim();
    const up = Math.max(0, Number(unitPrice || 0) || 0);
    const qty = Math.max(0, Number(quantity || 0) || 0);
    if (!n || !(up > 0) || !(qty > 0)) return;
    const key = `${n}__${up}`;
    const cur = lineMap.get(key) || { name: n, quantity: 0, unit_price: up, display_order: resolveDisplayOrder_(priceRuleId) };
    cur.quantity += qty;
    const order = resolveDisplayOrder_(priceRuleId);
    if (order < cur.display_order) cur.display_order = order;
    lineMap.set(key, cur);
  };
  list.forEach((v) => {
    const vid = String(v?.visit_id || "").trim();
    const ov = byVisit.get(vid) || {};
    const baseLabel = String(ov?.base_fee_label || "").trim() || resolveVisitServiceLabel_(v, null);
    const base = Math.max(0, Number(ov?.base_fee_amount || 0) || 0);
    const parking = Math.max(0, Number(ov?.parking_fee_amount || 0) || 0);
    const travel = Math.max(0, Number(ov?.travel_fee_amount || 0) || 0);
    const seasonal = Math.max(0, Number(ov?.seasonal_fee_amount || 0) || 0);
    if (cancellationMode) {
      targetSubtotal += (base + parking + travel + seasonal);
      const ridCandidates = [
        String(ov?.price_rule_id || "").trim(),
        String(ov?.parking_price_rule_id || "").trim(),
        String(ov?.travel_price_rule_id || "").trim(),
        String(ov?.seasonal_price_rule_id || "").trim()
      ].filter(Boolean);
      ridCandidates.forEach((rid) => {
        if (!cancelLineRuleId) {
          cancelLineRuleId = rid;
          return;
        }
        const curOrder = resolveDisplayOrder_(cancelLineRuleId);
        const nextOrder = resolveDisplayOrder_(rid);
        if (nextOrder < curOrder) cancelLineRuleId = rid;
      });
    } else {
      addLine_(baseLabel, base, 1, String(ov?.price_rule_id || ""));
      addLine_("駐車料金", parking, 1, String(ov?.parking_price_rule_id || ""));
      addLine_("出張料金", travel, 1, String(ov?.travel_price_rule_id || ""));
      addLine_("繁忙期加算", seasonal, 1, String(ov?.seasonal_price_rule_id || ""));
    }
    const extras = extraByVisit.get(vid) || [];
    extras.forEach((x) => {
      const label = String(x?.label || "").trim();
      const qty = Math.max(1, Number(x?.quantity || 1) || 1);
      const up = Math.max(0, Number(x?.unit_price || 0) || 0);
      addLine_(label, up, qty, String(x?.price_rule_id || ""));
    });
  });
  extraLines.forEach((x) => {
    const vid = String(x?.visit_id || "").trim();
    if (vid && selectedVisitIdSet.has(vid)) return;
    const label = String(x?.label || "").trim();
    const qty = Math.max(1, Number(x?.quantity || 1) || 1);
    const up = Math.max(0, Number(x?.unit_price || 0) || 0);
    addLine_(label, up, qty, String(x?.price_rule_id || ""));
  });
  if (cancellationMode) {
    const cancelBase = Math.max(0, Number(p?.cancellation_base_amount || 0) || 0);
    const sourceAmount = cancelBase > 0 ? cancelBase : targetSubtotal;
    const cancelFee = Math.max(0, Math.round(sourceAmount * (cancellationRate / 100) * 100) / 100);
    addLine_("キャンセル料", cancelFee, 1, cancelLineRuleId);
  }
  const keyPickup = Math.max(0, Number(p?.key_pickup_fee_amount || 0) || 0);
  const keyReturn = Math.max(0, Number(p?.key_return_fee_amount || 0) || 0);
  addLine_("鍵預かり料金", keyPickup, 1, String(p?.key_pickup_price_rule_id || ""));
  addLine_("鍵返却料金", keyReturn, 1, String(p?.key_return_price_rule_id || ""));
  const rows = Array.from(lineMap.values())
    .map((x) => {
      const lineTotal = x.quantity * x.unit_price;
      return {
        name: x.name,
        quantity: x.quantity,
        unit_price: x.unit_price,
        line_total: lineTotal,
        display_order: Number.isFinite(Number(x?.display_order)) ? Number(x?.display_order) : DEFAULT_DISPLAY_ORDER
      };
    })
    .sort((a, b) => {
      const adRaw = Number(a?.display_order);
      const bdRaw = Number(b?.display_order);
      const ad = Number.isFinite(adRaw) ? adRaw : DEFAULT_DISPLAY_ORDER;
      const bd = Number.isFinite(bdRaw) ? bdRaw : DEFAULT_DISPLAY_ORDER;
      if (ad !== bd) return ad - bd;
      return String(a?.name || "").localeCompare(String(b?.name || ""), "ja");
    });
  const subtotal = rows.reduce((acc, x) => acc + x.line_total, 0);
  const grand = Math.max(0, subtotal - discountAmount);
  return `
    <div style="max-height:70vh; overflow:auto; padding-right:4px;">
      <div class="p" style="margin-bottom:8px;">
        顧客: <strong>${escapeHtml(String(list[0]?.customer_name || "-"))}</strong><br/>
        対象予約: <strong>${escapeHtml(String(list.length))}件</strong>
      </div>
      <div style="margin-bottom:6px;"><strong>請求明細</strong></div>
      <div style="display:grid; gap:8px;">
        ${rows.map((x) => `
          <div class="row row-between" style="gap:10px; align-items:flex-start;">
            <div>
              <div><strong>${escapeHtml(x.name)}</strong></div>
              <div style="opacity:.8;">${escapeHtml(`×${x.quantity} (${formatMoney_(x.unit_price)}円)`)}</div>
            </div>
            <div style="white-space:nowrap; text-align:right;">${escapeHtml(formatMoney_(x.line_total))}円</div>
          </div>
        `).join("") || `<div>-</div>`}
        ${discountAmount > 0 ? `
          <div class="row row-between" style="gap:10px; align-items:flex-start;">
            <div>
              <div><strong>${escapeHtml(discountLabel)}</strong></div>
              <div style="opacity:.8;">値引き</div>
            </div>
            <div style="white-space:nowrap; text-align:right;">-${escapeHtml(formatMoney_(discountAmount))}円</div>
          </div>
        ` : ``}
      </div>
      <div style="margin-top:10px;">
        <div><strong>メモ</strong></div>
        <div style="margin-top:6px;">${escapeHtml(String(p.memo || "-"))}</div>
      </div>
      <div style="margin-top:10px;">
        <div class="row row-between"><span>小計</span><strong>${escapeHtml(formatMoney_(subtotal))}円</strong></div>
        <div class="row row-between"><span>割引</span><strong>${escapeHtml(discountAmount > 0 ? `-${formatMoney_(discountAmount)}円` : "0円")}</strong></div>
        <div class="row row-between" style="margin-top:6px; padding-top:6px; border-top:1px solid var(--line);"><span><strong>合計</strong></span><strong>${escapeHtml(formatMoney_(grand))}円</strong></div>
      </div>
    </div>
  `;
}

function collectResidualExtraLinesFromFormValues_(formValues) {
  const fv = formValues || {};
  const rows = [];
  const parseOptionRuleId_ = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return "";
    const parts = s.split("|");
    return String(parts[0] || "").trim();
  };
  const parseOptionAmount_ = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return 0;
    const parts = s.split("|");
    if (parts.length < 2) return 0;
    return Math.max(0, Number(parts[1] || 0) || 0);
  };
  const vidSet = new Set();
  Object.keys(fv).forEach((k) => {
    const m = /^residual_visit_id_(.+)$/.exec(String(k || ""));
    if (!m) return;
    const vid = String(fv[k] || "").trim();
    if (vid) vidSet.add(vid);
  });
  Array.from(vidSet).forEach((visitId) => {
    const baseLabel = String(fv[`residual_base_fee_label_${visitId}`] || "").trim() || "商品未設定";
    const baseAmount = Math.max(0, Number(fv[`residual_base_fee_amount_${visitId}`] || 0) || 0);
    const basePriceRuleId = String(fv[`residual_base_price_rule_id_${visitId}`] || "").trim();
    if (baseAmount > 0) {
      rows.push({
        visit_id: visitId,
        label: baseLabel,
        quantity: 1,
        unit_price: baseAmount,
        price_rule_id: basePriceRuleId,
      });
    }
    const parkingAmount = Math.max(0, Number(fv[`residual_parking_fee_amount_${visitId}`] || 0) || 0);
    const parkingPriceRuleId = String(fv[`residual_parking_price_rule_id_${visitId}`] || "").trim();
    if (parkingAmount > 0) {
      rows.push({
        visit_id: visitId,
        label: "駐車料金",
        quantity: 1,
        unit_price: parkingAmount,
        price_rule_id: parkingPriceRuleId,
      });
    }
    const travelRaw = String(fv[`residual_travel_option_${visitId}`] || "").trim();
    const travelAmount = parseOptionAmount_(travelRaw);
    const travelPriceRuleId = parseOptionRuleId_(travelRaw);
    if (travelAmount > 0) {
      rows.push({
        visit_id: visitId,
        label: "出張料金",
        quantity: 1,
        unit_price: travelAmount,
        price_rule_id: travelPriceRuleId,
      });
    }
    const seasonalRaw = String(fv[`residual_seasonal_option_${visitId}`] || "").trim();
    const seasonalAmount = parseOptionAmount_(seasonalRaw);
    const seasonalPriceRuleId = parseOptionRuleId_(seasonalRaw);
    if (seasonalAmount > 0) {
      rows.push({
        visit_id: visitId,
        label: "繁忙期加算",
        quantity: 1,
        unit_price: seasonalAmount,
        price_rule_id: seasonalPriceRuleId,
      });
    }
  });
  return rows;
}

function buildBillingBatchPayload_(customerId, selected, formValues) {
  const list = Array.isArray(selected) ? selected : [];
  const fv = formValues || {};
  const visitIds = list.map((v) => String(v?.visit_id || "").trim()).filter(Boolean);
  const parseOptionRuleId_ = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return "";
    const parts = s.split("|");
    return String(parts[0] || "").trim();
  };
  const visitOverrides = list.map((v) => {
    const vid = String(v?.visit_id || "").trim();
    const priceRuleId = String(fv[`base_price_rule_id_${vid}`] || "").trim();
    const baseFeeAmount = Math.max(0, Number(fv[`base_fee_amount_${vid}`] || 0) || 0);
    const baseFeeLabel = String(fv[`base_fee_label_${vid}`] || "").trim();
    const parkingFeeAmount = Math.max(0, Number(fv[`parking_fee_amount_${vid}`] || 0) || 0);
    const travelRaw = String(fv[`travel_option_${vid}`] || "").trim();
    const seasonalRaw = String(fv[`seasonal_option_${vid}`] || "").trim();
    return {
      visit_id: vid,
      price_rule_id: priceRuleId,
      base_fee_amount: baseFeeAmount,
      base_fee_label: baseFeeLabel,
      parking_fee_amount: parkingFeeAmount,
      parking_price_rule_id: String(fv[`parking_price_rule_id_${vid}`] || "").trim(),
      travel_fee_amount: parseOptionAmount_(travelRaw),
      travel_price_rule_id: parseOptionRuleId_(travelRaw),
      seasonal_fee_amount: parseOptionAmount_(seasonalRaw),
      seasonal_price_rule_id: parseOptionRuleId_(seasonalRaw),
    };
  }).filter((x) => x.visit_id);
  const extraLines = list.map((v) => {
    const vid = String(v?.visit_id || "").trim();
    const label = String(fv[`extra_label_${vid}`] || "").trim();
    const qty = Math.max(1, Number(fv[`extra_qty_${vid}`] || 1) || 1);
    const amount = Math.max(0, Number(fv[`extra_amount_${vid}`] || 0) || 0);
    const priceRuleId = String(fv[`extra_price_rule_id_${vid}`] || "").trim();
    if (!label || !(amount > 0)) return null;
    return { visit_id: vid, label, quantity: qty, unit_price: amount, price_rule_id: priceRuleId };
  }).filter(Boolean);
  const residualExtraLines = collectResidualExtraLinesFromFormValues_(fv);
  const memo = String(fv.memo || "").trim();
  const discountAmount = Number(fv.discount_amount || 0) || 0;
  const discountLabel = String(fv.discount_label || "").trim() || "割引";
  return {
    customer_id: String(customerId || "").trim(),
    visit_ids: visitIds,
    memo,
    visit_overrides: visitOverrides,
    extra_lines: extraLines.concat(residualExtraLines),
    key_pickup_fee_amount: Math.max(0, Number(fv.key_pickup_fee_amount || 0) || 0),
    key_return_fee_amount: Math.max(0, Number(fv.key_return_fee_amount || 0) || 0),
    key_pickup_price_rule_id: String(fv.key_pickup_price_rule_id || "").trim(),
    key_return_price_rule_id: String(fv.key_return_price_rule_id || "").trim(),
    discount_amount: Math.max(0, discountAmount),
    discount_label: discountLabel
  };
}

function buildCancellationVisitAmounts_(selected, payload, cancellationRate) {
  const list = Array.isArray(selected) ? selected : [];
  const p = payload || {};
  const rate = Math.max(0, Number(cancellationRate || 0) || 0);
  const vids = list.map((v) => String(v?.visit_id || "").trim()).filter(Boolean);
  const rawByVisit = {};
  vids.forEach((vid) => { rawByVisit[vid] = 0; });
  (Array.isArray(p.visit_overrides) ? p.visit_overrides : []).forEach((row) => {
    const vid = String(row?.visit_id || "").trim();
    if (!vid || !Object.prototype.hasOwnProperty.call(rawByVisit, vid)) return;
    const base = Math.max(0, Number(row?.base_fee_amount || 0) || 0);
    const parking = Math.max(0, Number(row?.parking_fee_amount || 0) || 0);
    const travel = Math.max(0, Number(row?.travel_fee_amount || 0) || 0);
    const seasonal = Math.max(0, Number(row?.seasonal_fee_amount || 0) || 0);
    const targetSubtotal = base + parking + travel + seasonal;
    rawByVisit[vid] += Math.max(0, targetSubtotal);
  });
  const result = {};
  vids.forEach((vid) => {
    const base = Math.max(0, Number(rawByVisit[vid] || 0) || 0);
    result[vid] = Math.max(0, Math.round((base * (rate / 100)) * 100) / 100);
  });
  return result;
}

function buildCancellationMemo_(payload, cancellationRate) {
  const p = payload || {};
  const rate = Math.max(0, Number(cancellationRate || 0) || 0);
  const factor = rate / 100;
  const lineMap = new Map();
  const pushLine_ = (label, amount) => {
    const n = Math.max(0, Number(amount || 0) || 0);
    if (!(n > 0)) return;
    const key = String(label || "").trim();
    if (!key) return;
    const cur = lineMap.get(key) || { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += n;
    lineMap.set(key, cur);
  };
  (Array.isArray(p.visit_overrides) ? p.visit_overrides : []).forEach((row) => {
    const baseLabel = String(row?.base_fee_label || "訪問基本料金").trim();
    const base = Math.max(0, Number(row?.base_fee_amount || 0) || 0);
    const parking = Math.max(0, Number(row?.parking_fee_amount || 0) || 0);
    const travel = Math.max(0, Number(row?.travel_fee_amount || 0) || 0);
    const seasonal = Math.max(0, Number(row?.seasonal_fee_amount || 0) || 0);
    pushLine_(baseLabel, Math.round(base * factor * 100) / 100);
    pushLine_("駐車料金", Math.round(parking * factor * 100) / 100);
    pushLine_("出張料金", Math.round(travel * factor * 100) / 100);
    pushLine_("繁忙期加算", Math.round(seasonal * factor * 100) / 100);
  });
  const lines = Array.from(lineMap.entries()).map(([label, v]) => {
    const count = Math.max(1, Number(v?.count || 0) || 1);
    const amount = Math.max(0, Number(v?.amount || 0) || 0);
    return `${label} × ${count} = ${formatMoney_(amount)}円`;
  });
  const autoMemo = lines.length ? `キャンセル料内訳: ${lines.join(" / ")}` : "";
  const baseMemo = String(p.memo || "").trim();
  return [autoMemo, baseMemo].filter(Boolean).join("\n");
}

function buildCancellationCreatePayload_(payload, cancellationRate) {
  const p = payload || {};
  const rate = Math.max(0, Number(cancellationRate || 0) || 0);
  return {
    ...p,
    cancellation_rate: rate,
    visit_overrides: Array.isArray(p.visit_overrides) ? p.visit_overrides : [],
    extra_lines: Array.isArray(p.extra_lines) ? p.extra_lines : [],
    cancellation_base_amount: Math.max(0, Number(p.cancellation_base_amount || 0) || 0),
    memo: buildCancellationMemo_(p, rate),
  };
}

function buildSourceBatchCancellationPreset_(detail, cancelledVisitIds, remainingVisitIds) {
  const d = (detail && typeof detail === "object") ? detail : {};
  const batch = (d.batch && typeof d.batch === "object") ? d.batch : {};
  const activeItems = Array.isArray(d.invoice_items)
    ? d.invoice_items.filter((x) => x && x.is_cancelled !== true)
    : [];
  const lineById = {};
  (Array.isArray(d.invoice_line_items) ? d.invoice_line_items : []).forEach((line) => {
    const lid = String(line?.id || "").trim();
    if (!lid) return;
    lineById[lid] = line;
  });
  const cancelledSet = new Set((Array.isArray(cancelledVisitIds) ? cancelledVisitIds : []).map((x) => String(x || "").trim()).filter(Boolean));
  const remainingSetFromOpt = new Set((Array.isArray(remainingVisitIds) ? remainingVisitIds : []).map((x) => String(x || "").trim()).filter(Boolean));
  const batchActiveVisitIds = Array.from(new Set(activeItems.map((x) => String(x?.visit_id || "").trim()).filter(Boolean)));
  const remainingSet = remainingSetFromOpt.size
    ? remainingSetFromOpt
    : new Set(batchActiveVisitIds.filter((id) => !cancelledSet.has(id)));
  const fullCancel = remainingSet.size === 0;
  const activeLineIds = new Set(activeItems
    .map((x) => String(x?.invoice_line_item_id || "").trim())
    .filter(Boolean));
  const priceRuleById = {};
  (Array.isArray(d.price_rules) ? d.price_rules : []).forEach((r) => {
    const rid = String(r?.price_rule_id || "").trim();
    if (!rid) return;
    priceRuleById[rid] = r;
  });
  const shouldIncludeCancellationBaseLine_ = (line) => {
    const rid = String(line?.price_rule_id || "").trim();
    const itemType = String(priceRuleById[rid]?.item_type || "").trim();
    const label = String(line?.label || "").trim();
    if (itemType === "visit_base" || itemType === "seasonal_fee") return true;
    if (itemType === "parking_fee" || itemType === "travel_fee") return false;
    if (itemType === "key_pickup_fee" || itemType === "key_return_fee") return false;
    if (itemType === "cancellation_fee") return false;
    if (label.includes("駐車") || label.includes("出張") || label.includes("鍵")) return false;
    return true;
  };
  const activeLines = (Array.isArray(d.invoice_line_items) ? d.invoice_line_items : []).filter((line) => {
    const lid = String(line?.id || "").trim();
    if (!activeLineIds.size) return true;
    return !!lid && activeLineIds.has(lid);
  });
  const subtotal = activeLines.reduce((acc, line) => {
    if (!shouldIncludeCancellationBaseLine_(line)) return acc;
    const qty = Math.max(1, Number(line?.quantity || 1) || 1);
    const unit = Math.max(0, Number(line?.unit_price_snapshot || 0) || 0);
    return acc + (qty * unit);
  }, 0);
  const discount = Math.max(0, Number(batch?.discount_amount || d?.discount_amount || 0) || 0);
  const cancellationBaseAmount = Math.max(0, subtotal - discount);
  const targetVisitId = Array.from(cancelledSet)[0] || Array.from(remainingSet)[0] || "";
  const group = new Map();
  activeItems.forEach((item) => {
    const vid = String(item?.visit_id || "").trim();
    if (!vid || !remainingSet.has(vid)) return;
    const lineId = String(item?.invoice_line_item_id || "").trim();
    const line = lineById[lineId] || {};
    const label = String(line?.label || "").trim();
    const unit = Math.max(0, Number(line?.unit_price_snapshot || 0) || 0);
    if (!label || !(unit > 0)) return;
    const key = `${label}__${unit}`;
    const cur = group.get(key) || {
      visit_id: targetVisitId,
      label,
      quantity: 0,
      unit_price: unit,
      price_rule_id: String(line?.price_rule_id || "").trim(),
    };
    cur.quantity += 1;
    group.set(key, cur);
  });
  return {
    full_cancel: fullCancel,
    cancellation_base_amount: cancellationBaseAmount,
    residual_extra_lines: Array.from(group.values()),
    remaining_visit_ids: Array.from(remainingSet),
  };
}

function buildResidualVisitSections_(detail, remainingVisitIds, feeContext = {}) {
  const d = (detail && typeof detail === "object") ? detail : {};
  const remainSet = new Set((Array.isArray(remainingVisitIds) ? remainingVisitIds : []).map((x) => String(x || "").trim()).filter(Boolean));
  if (!remainSet.size) return [];
  const baseRuleIds = new Set((Array.isArray(feeContext?.visit_base_rules) ? feeContext.visit_base_rules : []).map((x) => String(x?.price_rule_id || "").trim()).filter(Boolean));
  const parkingRuleIds = new Set((Array.isArray(feeContext?.parking_options) ? feeContext.parking_options : []).map((x) => String(x?.price_rule_id || "").trim()).filter(Boolean));
  const travelRuleIds = new Set((Array.isArray(feeContext?.travel_options) ? feeContext.travel_options : []).map((x) => String(x?.price_rule_id || "").trim()).filter(Boolean));
  const seasonalRuleIds = new Set((Array.isArray(feeContext?.seasonal_options) ? feeContext.seasonal_options : []).map((x) => String(x?.price_rule_id || "").trim()).filter(Boolean));
  const linkByVisitId = {};
  (Array.isArray(d.links) ? d.links : []).forEach((link, idx) => {
    const vid = String(link?.visit_id || "").trim();
    if (!vid) return;
    linkByVisitId[vid] = { link, idx };
  });
  const sectionByVisitId = new Map();
  const ensureSection_ = (vid) => {
    if (sectionByVisitId.has(vid)) return sectionByVisitId.get(vid);
    const linkInfo = linkByVisitId[vid] || {};
    const visit = linkInfo.link?.visit || {};
    const title = String(visit?.title || "").trim() || vid || "(無題)";
    const sec = {
      visit_id: vid,
      title,
      start_time: String(visit?.start_time || "").trim(),
      order_index: Number.isFinite(Number(linkInfo.idx)) ? Number(linkInfo.idx) : 999999,
      base_fee_label: "",
      base_fee_amount: 0,
      base_price_rule_id: "",
      parking_fee_amount: 0,
      parking_price_rule_id: "",
      travel_fee_amount: 0,
      travel_price_rule_id: "",
      seasonal_fee_amount: 0,
      seasonal_price_rule_id: "",
    };
    sectionByVisitId.set(vid, sec);
    return sec;
  };
  remainSet.forEach((vid) => { ensureSection_(vid); });
  const activeItems = Array.isArray(d.invoice_items)
    ? d.invoice_items.filter((x) => x && x.is_cancelled !== true)
    : [];
  activeItems.forEach((item) => {
    const vid = String(item?.visit_id || "").trim();
    if (!vid || !remainSet.has(vid)) return;
    const label = String(item?.label || "").trim();
    const unit = Math.max(0, Number(item?.unit_price_snapshot || 0) || 0);
    const priceRuleId = String(item?.price_rule_id || "").trim();
    if (!label || !(unit > 0)) return;
    const sec = ensureSection_(vid);
    const normalizedLabel = label.replace(/\s+/g, "");
    const isParking = parkingRuleIds.has(priceRuleId) || normalizedLabel.includes("駐車料金");
    const isTravel = travelRuleIds.has(priceRuleId) || normalizedLabel.includes("出張料金");
    const isSeasonal = seasonalRuleIds.has(priceRuleId) || normalizedLabel.includes("繁忙期加算");
    const isBase = baseRuleIds.has(priceRuleId);
    if (isParking) {
      sec.parking_fee_amount += unit;
      if (!sec.parking_price_rule_id && priceRuleId) sec.parking_price_rule_id = priceRuleId;
      return;
    }
    if (isTravel) {
      sec.travel_fee_amount += unit;
      if (!sec.travel_price_rule_id && priceRuleId) sec.travel_price_rule_id = priceRuleId;
      return;
    }
    if (isSeasonal) {
      sec.seasonal_fee_amount += unit;
      if (!sec.seasonal_price_rule_id && priceRuleId) sec.seasonal_price_rule_id = priceRuleId;
      return;
    }
    if (isBase || !sec.base_fee_label) {
      sec.base_fee_amount += unit;
      sec.base_fee_label = sec.base_fee_label || label;
      if (!sec.base_price_rule_id && priceRuleId) sec.base_price_rule_id = priceRuleId;
      return;
    }
    sec.base_fee_amount += unit;
  });
  return Array.from(sectionByVisitId.values())
    .map((sec) => ({
      visit_id: sec.visit_id,
      title: sec.title,
      start_time: sec.start_time,
      order_index: sec.order_index,
      base_fee_label: sec.base_fee_label || "商品未設定",
      base_fee_amount: Math.max(0, Number(sec.base_fee_amount || 0) || 0),
      base_price_rule_id: String(sec.base_price_rule_id || "").trim(),
      parking_fee_amount: Math.max(0, Number(sec.parking_fee_amount || 0) || 0),
      parking_price_rule_id: String(sec.parking_price_rule_id || "").trim(),
      travel_fee_amount: Math.max(0, Number(sec.travel_fee_amount || 0) || 0),
      travel_price_rule_id: String(sec.travel_price_rule_id || "").trim(),
      seasonal_fee_amount: Math.max(0, Number(sec.seasonal_fee_amount || 0) || 0),
      seasonal_price_rule_id: String(sec.seasonal_price_rule_id || "").trim(),
      subtotal: Math.max(0, Number(sec.base_fee_amount || 0) || 0)
        + Math.max(0, Number(sec.parking_fee_amount || 0) || 0)
        + Math.max(0, Number(sec.travel_fee_amount || 0) || 0)
        + Math.max(0, Number(sec.seasonal_fee_amount || 0) || 0),
    }))
    .sort((a, b) => {
      const at = Date.parse(String(a?.start_time || "")) || 0;
      const bt = Date.parse(String(b?.start_time || "")) || 0;
      if (at !== bt) return at - bt;
      const ai = Number.isFinite(Number(a?.order_index)) ? Number(a.order_index) : 999999;
      const bi = Number.isFinite(Number(b?.order_index)) ? Number(b.order_index) : 999999;
      if (ai !== bi) return ai - bi;
      return String(a?.title || "").localeCompare(String(b?.title || ""), "ja");
    });
}

function dateYmdJstFromIso_(iso) {
  const t = Date.parse(String(iso || "").trim());
  if (isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(t));
}

function buildSquareInvoiceDraftHints_(selected) {
  const list = Array.isArray(selected) ? selected : [];
  const baseMap = new Map();
  let parkingCount = 0;
  let travelCount = 0;
  let seasonalCount = 0;

  list.forEach((v) => {
    const product = String(v?.product_name || v?.service_name || "").trim();
    const variant = String(v?.variant_name || "").trim();
    const baseLabel = [product, variant].filter(Boolean).join(" ").trim() || "訪問サービス";
    baseMap.set(baseLabel, (baseMap.get(baseLabel) || 0) + 1);
    if ((Number(v?.parking_fee_amount || 0) || 0) > 0) parkingCount += 1;
    if ((Number(v?.travel_fee_amount || 0) || 0) > 0) travelCount += 1;
    if ((Number(v?.seasonal_fee_amount || 0) || 0) > 0) seasonalCount += 1;
  });

  const lines = [];
  Array.from(baseMap.entries()).forEach(([label, count]) => {
    lines.push(`${label} × ${count}`);
  });
  if (travelCount > 0) lines.push(`出張料 × ${travelCount}`);
  if (parkingCount > 0) lines.push(`駐車料金 × ${parkingCount}`);
  if (seasonalCount > 0) lines.push(`繁忙期加算 × ${seasonalCount}`);

  const keyReturnFeeRule = String(list[0]?.key_return_fee_rule || "").trim().toLowerCase();
  if (keyReturnFeeRule === "paid") lines.push("鍵返却料金 × 1");

  const dateSet = new Set();
  list.forEach((v) => {
    const d = dateYmdJstFromIso_(v?.start_time);
    if (d) dateSet.add(d);
  });
  const periodDates = Array.from(dateSet.values());
  const periodText = periodDates.length ? periodDates.join(", ") : "-";

  return { lines, periodText, visitCount: list.length };
}

function buildSquareInvoiceGuideHtml_(selected, _guide) {
  const list = Array.isArray(selected) ? selected : [];
  const count = list.length;

  return `
    <div class="p" style="margin-bottom:10px;">
      Square側で生成された下書き請求書の内容を確認して送信してください。
    </div>
    <div class="p" style="margin-bottom:8px;">
      対象予約: <strong>${escapeHtml(String(count))}件</strong>
    </div>
    <div class="p" style="opacity:.9;">
      金額・明細を編集したい場合は、Square側ではなく本アプリ側で予約/請求設定を修正し、請求ドラフトを作り直してください。
    </div>
  `;
}

function buildInvoiceDraftPayload_(customerId, selected, formValues, additionalFeeRules, merchandiseRules) {
  const fv = formValues || {};
  const rules = Array.isArray(additionalFeeRules) ? additionalFeeRules : [];
  const goods = Array.isArray(merchandiseRules) ? merchandiseRules : [];
  const discountAmount = Number(fv.discount_amount || 0) || 0;
  const adjustments = [];
  const additionalFeeLines = [];
  if (discountAmount > 0) {
    adjustments.push({
      label: String(fv.discount_label || "割引"),
      amount: -Math.abs(discountAmount),
      discount_type: "fixed",
      discount_value: Math.abs(discountAmount),
      reason: "manual_discount"
    });
  }
  rules.forEach((rule) => {
    const rid = String(rule?.price_rule_id || "").trim();
    if (!rid || !fv[`additional_fee_on_${rid}`]) return;
    const overrideAmount = Number(fv[`additional_fee_amount_${rid}`] || 0) || 0;
    const amount = overrideAmount > 0 ? overrideAmount : (Number(rule.amount || 0) || 0);
    if (!(amount > 0)) return;
    additionalFeeLines.push({
      price_rule_id: rid,
      label: String(rule.label || "追加料金"),
      line_type: "additional_fee",
      amount
    });
  });
  goods.forEach((rule) => {
    const rid = String(rule?.price_rule_id || "").trim();
    if (!rid || !fv[`merchandise_on_${rid}`]) return;
    const overrideAmount = Number(fv[`merchandise_amount_${rid}`] || 0) || 0;
    const amount = overrideAmount > 0 ? overrideAmount : (Number(rule.amount || 0) || 0);
    if (!(amount > 0)) return;
    additionalFeeLines.push({
      price_rule_id: rid,
      label: String(rule.label || "一般商品"),
      line_type: "merchandise",
      amount
    });
  });
  return {
    customer_id: customerId,
    visit_ids: selected.map(v => String(v.visit_id || "").trim()).filter(Boolean),
    key_pickup_fee_rule: String(fv.key_pickup_fee_rule || "").trim(),
    key_return_fee_rule: String(fv.key_return_fee_rule || "").trim(),
    adjustments,
    additional_fee_lines: additionalFeeLines
  };
}

function applyVisitTypeBadges_(rootEl) {
  return rootEl || document;
}

// ===== bulk edit helpers =====
function pickBillingStatus_(v) {
  return String(v?.billing_status || "").trim() || "unbilled";
}

function pickIsActive_(v) {
  return isActive_(v);
}

function cardHtml(v) {
  // v のスキーマ差分に合わせる（不足項目は安全にフォールバック）
  const startRaw = v.start_time || "";
  const start = fmtDateTimeJst(startRaw);
  const title = v.title || "(無題)";
  const customer = v.customer_name || "";
  const productName = String(v.product_name || v.service_name || "").trim();
  const variantName = String(v.variant_name || "").trim();
  const vid = v.visit_id || "";
  const done = isDone_(v);
  const billingStatus = String(v.billing_status || "").trim() || "unbilled";
  const refundDetected = !!v.refund_detected;
  const refundKind = String(v.refund_kind || "").trim().toLowerCase();
  const refundLabel = refundKind === "partial" ? "返金検知（一部）" : "返金検知（全額）";
  const isActive = !(v.is_active === false || String(v.is_active || "").toLowerCase() === "false");
  const cancellationFeeAmount = Math.max(0, Number(v.cancellation_fee_amount || 0) || 0);
  const cancellationFeeRate = Math.max(0, Number(v.cancellation_fee_rate || 0) || 0);
  const hasCancellationFee = !isActive && cancellationFeeAmount > 0 && billingStatus === "billed";
  const vid2 = String(vid || "").trim();

  return `
    <div class="card"
      data-visit-id="${escapeHtml(vid)}"
      data-done="${done ? "1" : "0"}"
      data-billing-status="${escapeHtml(String(billingStatus))}"
      data-is-active="${isActive ? "1" : "0"}"
      data-price-rule-id="${escapeHtml(String(v.price_rule_id || ""))}"
    >
      <div class="card-bulk-check"
        data-role="bulk-check-wrap"
        style="margin-bottom:8px;"
      >
        <label class="row" style="gap:8px; align-items:center;">
          <input type="checkbox" data-role="bulk-check" data-visit-id="${escapeHtml(vid2)}" />
          <span class="p" style="margin:0;">選択</span>
        </label>
      </div>
      <div class="card-title">
        <div>${escapeHtml(displayOrDash(start))}</div>
        <div>${escapeHtml(displayOrDash(vid))}</div>
      </div>
      <div class="card-sub">
        <div><strong>${escapeHtml(displayOrDash(customer))}</strong></div>
        <div>${escapeHtml(displayOrDash(title))}</div>
      </div>
      <div class="badges" data-role="badges">
        <span class="badge badge-visit-type"
          data-action="change-price-rule"
          style="cursor:pointer;"
          title="タップで訪問基本料金を変更"
          data-role="visit-type-badge">
          ${escapeHtml(productBadgeLabel_(v))}
        </span>
        ${variantName ? `
        <span class="badge">
          ${escapeHtml(variantName)}
        </span>
        ` : ``}
        <span class="badge badge-billing-status"
        >
          ${escapeHtml(displayOrDash(fmt(billingStatusLabel_(billingStatus)), "未請求"))}
        </span>
        ${refundDetected ? `<span class="badge badge-danger">${escapeHtml(refundLabel)}</span>` : ``}
        ${hasCancellationFee ? `<span class="badge badge-danger">キャンセル料: ${escapeHtml(formatMoney_(cancellationFeeAmount))}円（${escapeHtml(String(cancellationFeeRate))}%）</span>` : ``}
        <span class="badge badge-done ${done ? "badge-ok is-done" : "is-not-done"}"
          data-action="toggle-done"
          style="cursor:pointer;"
          title="タップで完了/未完了を切り替え"
        >
           ${done ? "完了" : "未完了"}
        </span>
        <span class="badge badge-active ${isActive ? "is-active" : "badge-danger is-inactive"}"
          data-action="toggle-active"
          style="cursor:pointer;"
          title="タップで有効/削除済を切り替え"
        >
          ${isActive ? "有効" : "削除済"}
        </span>
      </div>
      <div class="row" style="justify-content:flex-end; margin-top:10px;">
        <button class="btn btn-ghost" type="button" data-action="open">詳細</button>
      </div>
    </div>
  `;
}

export async function renderVisitsList(appEl, query) {
  // ===== state =====
  const init = defaultRange();
  const saved = (() => { try { return loadState_(); } catch (_) { return null; } })();

  // ===== bulk edit ui state (in-memory) =====
  let bulkSelected = new Set();       // Set<visit_id>
  let visibleVisitIds = [];           // 現在表示中の visit_id
  let bulkAction = "bulk-run";        // bulk-run | bulk-create-invoice-draft
  let pendingCancelDraft = consumePendingCancelDraft_();

  let state = {
    date_from: (saved && saved.date_from) ? String(saved.date_from) : init.date_from,
    date_to_ymd: (saved && saved.date_to_ymd) ? String(saved.date_to_ymd) : init.date_to.slice(0, 10),
    keyword: (saved && typeof saved.keyword === "string") ? saved.keyword : "",
    sort_order: (saved && saved.sort_order) ? String(saved.sort_order) : "asc", // 近い順（運用上、次の予定が見やすい）
    done_filter: (saved && saved.done_filter) ? String(saved.done_filter) : "open_first", // open_first | open_only | done_only | all
    active_filter: (saved && saved.active_filter) ? String(saved.active_filter) : "active_only", // active_only | include_deleted
   };
  saveState_(state);

  render(appEl, `
    <section class="section">
      <h1 class="h1">予約一覧</h1>
      <p class="p">絞り込み機能を有効活用しましょう！</p>
      <div class="hr"></div>
      <details id="vfDetails" style="border:1px solid var(--line); border-radius: var(--radius); padding: 10px; background: rgba(255,255,255,0.02);">
        <summary class="row" style="cursor:pointer; user-select:none; list-style:none;">
          <div style="font-weight:900;">フィルタ / ソート</div>
          <span id="vfToggleState" class="badge">開く</span>
        </summary>
        <div id="visitsFilters" style="margin-top: 10px;">
          <div class="row">
            <div style="flex:1; min-width:140px;">
              <div class="p" style="margin-bottom:6px;">期間（from）</div>
              <input id="vfFrom" class="input" type="date" />
            </div>
            <div style="flex:1; min-width:140px;">
              <div class="p" style="margin-bottom:6px;">期間（to）</div>
              <input id="vfTo" class="input" type="date" />
            </div>
          </div>
          <div class="row">
            <button class="btn" type="button" data-action="apply-range">期間を適用</button>
            <button class="btn btn-ghost" type="button" data-action="reset">リセット</button>
          </div>
          <div class="hr"></div>
          <div class="row">
            <input id="vfKeyword" class="input" type="text" inputmode="search" placeholder="検索（顧客名 / タイトル / visit_id …）" />
            <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
          </div>
          <div class="row">
            <div class="p">完了状態</div>
            <select id="vfDoneFilter" class="select">
              <option value="open_first">すべて（未完了優先）</option>
              <option value="open_only">未完了のみ</option>
              <option value="done_only">完了のみ</option>
              <option value="all">すべて</option>
            </select>
          </div>
          <div class="row">
            <div class="p">削除済み</div>
            <select id="vfActiveFilter" class="select">
              <option value="active_only">除外（デフォルト）</option>
              <option value="include_deleted">含める</option>
            </select>
          </div>
          <div class="row">
            <div class="p">並び順</div>
            <select id="vfSortOrder" class="select">
              <option value="asc">日時：近い順</option>
              <option value="desc">日時：新しい順</option>
            </select>
          </div>
        </div>
      </details>
      <div class="row" id="bulkBar" style="margin-top: 10px; display:none; gap:8px; align-items:center; flex-wrap:wrap;">
      </div>
      <div class="hr"></div>
      <div id="visitsList"></div>
    </section>
  `);

  const listEl = appEl.querySelector("#visitsList");
  if (!listEl) return;

  const detailsEl = appEl.querySelector("#vfDetails");
  const toggleStateEl = appEl.querySelector("#vfToggleState");
  const filtersEl = appEl.querySelector("#visitsFilters");
  const fromEl = appEl.querySelector("#vfFrom");
  const toEl = appEl.querySelector("#vfTo");
  const kwEl = appEl.querySelector("#vfKeyword");
  const doneEl = appEl.querySelector("#vfDoneFilter");
  const activeEl = appEl.querySelector("#vfActiveFilter");
  const sortEl = appEl.querySelector("#vfSortOrder");
  const bulkBarEl = appEl.querySelector("#bulkBar");

  if (fromEl) fromEl.value = state.date_from;
  if (toEl) toEl.value = state.date_to_ymd;
  if (kwEl) kwEl.value = state.keyword;
  if (doneEl) doneEl.value = state.done_filter;
  if (activeEl) activeEl.value = state.active_filter;
  if (sortEl) sortEl.value = state.sort_order;

  // ===== 一覧state =====
  // - visitsAll: 直近取得したサーバ結果（期間はサーバ側で絞っている）
  // - 画面表示は keyword / sort をクライアント側で適用
  let visitsAll = [];

  // ===== スクロール復元（詳細→一覧の体感改善）=====
  // - applyAndRender_ は「再描画しても現在の位置を維持」する実装が既にあるため、ここでは
  //   「一覧に戻ってきた直後（初回）だけ」保存値へ復元する。
  const restoreScrollOnce_ = () => {
    let y = 0;
    try {
      const raw = sessionStorage.getItem(KEY_VLIST_SCROLL_Y);
      y = Number(raw || "0") || 0;
    } catch (_) { y = 0; }
    // 1回だけ実行（連続描画やフィルタ操作で勝手に戻らないようにする）
    try { sessionStorage.removeItem(KEY_VLIST_SCROLL_RESTORE_ONCE); } catch (_) {}
    if (y > 0) window.scrollTo(0, y);
  };

  const markRestoreOnce_ = () => {
    try { sessionStorage.setItem(KEY_VLIST_SCROLL_RESTORE_ONCE, "1"); } catch (_) {}
  };

  const shouldRestoreOnce_ = () => {
    try { return sessionStorage.getItem(KEY_VLIST_SCROLL_RESTORE_ONCE) === "1"; } catch (_) { return false; }
  };

  // renderVisitsList が呼ばれたタイミングで「復元フラグ」が立っていれば、描画後に復元する
  // ※ DOM差し替え後に行う必要があるため、最後に setTimeout(0) で実行する
  if (shouldRestoreOnce_()) {
    setTimeout(() => restoreScrollOnce_(), 0);
  }

  // ===== 開閉状態（スマホでの表示領域最適化）=====
  const KEY_VF_OPEN = "mf_vf_open";
  const applyDetailsUi_ = (isOpen) => {
    if (!detailsEl) return;
    detailsEl.open = !!isOpen;
    if (toggleStateEl) toggleStateEl.textContent = detailsEl.open ? "閉じる" : "開く";
  };
  try {
    const saved = sessionStorage.getItem(KEY_VF_OPEN);
    applyDetailsUi_(saved === "1");
  } catch (_) {}
  detailsEl?.addEventListener("toggle", () => {
    if (toggleStateEl) toggleStateEl.textContent = detailsEl.open ? "閉じる" : "開く";
    try { sessionStorage.setItem(KEY_VF_OPEN, detailsEl.open ? "1" : "0"); } catch (_) {}
  });

  // ===== bulk edit UI =====
  const updateBulkBar_ = () => {
    if (!bulkBarEl) return;
    const count = bulkSelected.size;
    const canInvoice = isAdminUser_();
    if (!canInvoice && bulkAction === "bulk-create-invoice-draft") bulkAction = "bulk-run";
    const selected = selectedVisits_(visitsAll, Array.from(bulkSelected || []));
    const nonDraftableCount = selected.filter(v => pickBillingStatus_(v) !== "unbilled").length;
    const canCreateDraft = count > 0 && nonDraftableCount === 0;
    const allVisibleCount = visibleVisitIds.length;
    const selectedVisibleCount = visibleVisitIds.filter((id) => bulkSelected.has(id)).length;
    const allVisibleSelected = allVisibleCount > 0 && selectedVisibleCount === allVisibleCount;
    const executeDisabled = count === 0
      || (bulkAction === "bulk-create-invoice-draft" && (!canInvoice || !canCreateDraft));
    bulkBarEl.style.display = "flex";
    bulkBarEl.innerHTML = [
      `<label class="row" style="gap:8px; align-items:center; margin-right:4px;">
        <input type="checkbox" data-action="bulk-select-all" ${allVisibleSelected ? "checked" : ""} ${allVisibleCount ? "" : "disabled"} />
        <span class="p" style="margin:0;">全選択</span>
      </label>`,
      `<span class="badge">選択: ${escapeHtml(String(count))}件</span>`,
      (count > 0 && nonDraftableCount > 0) ? `<span class="badge">請求ドラフト対象外: ${escapeHtml(String(nonDraftableCount))}件</span>` : ``,
      `<select class="select" data-role="bulk-action" style="min-width:190px;">
        <option value="bulk-run">一括変更</option>
        ${canInvoice ? `<option value="bulk-create-invoice-draft">請求書生成</option>` : ``}
      </select>`,
      `<button class="btn" type="button" data-action="bulk-execute" ${executeDisabled ? "disabled" : ""}>実行</button>`,
      `<button class="btn btn-ghost" type="button" data-action="bulk-clear" ${count ? "" : "disabled"}>全解除</button>`,
    ].join("");
    const actionSel = bulkBarEl.querySelector('select[data-role="bulk-action"]');
    if (actionSel) actionSel.value = bulkAction;
    const master = bulkBarEl.querySelector('input[data-action="bulk-select-all"]');
    if (master) master.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < allVisibleCount;
  };

  const applyBulkModeToDom_ = () => {
    if (!listEl) return;
    // 既存選択をチェックへ反映
    const checks = listEl.querySelectorAll('input[data-role="bulk-check"]');
    checks.forEach((ch) => {
      const vid = String(ch?.dataset?.visitId || ch?.getAttribute("data-visit-id") || ch?.closest("[data-visit-id]")?.dataset?.visitId || "").trim();
      // data-visit-id は input ではなく dataset に入るケースもあるので getAttribute も見る
      const vid2 = String(ch.getAttribute("data-visit-id") || ch.dataset.visitId || "").trim();
      const id = vid2 || vid;
      ch.checked = id ? bulkSelected.has(id) : false;
    });
    updateBulkBar_();
  };

  const clearBulkSelection_ = () => {
    bulkSelected = new Set();
    applyBulkModeToDom_();
  };

  const updateVisitWithCalendarRetry_ = async (payload, idToken2) => {
    const res1 = await callUpdateVisitPolicy(payload, idToken2);
    const err1 = Array.isArray(res1?.sync_errors) ? res1.sync_errors : [];
    if (!err1.length) return res1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res2 = await callUpdateVisitPolicy(payload, idToken2);
    const err2 = Array.isArray(res2?.sync_errors) ? res2.sync_errors : [];
    if (err2.length) {
      throw new Error("予約更新は完了しましたが、カレンダー同期に失敗しました。");
    }
    return res2;
  };

  const runCreateInvoiceDraft_ = async (options = {}) => {
    const ids = Array.isArray(options.ids) ? options.ids.map((x) => String(x || "").trim()).filter(Boolean) : Array.from(bulkSelected || []);
    if (!ids.length) return;
    const cancellationRate = Math.max(0, Number(options.cancellation_rate || 0) || 0);
    const cancellationMode = cancellationRate === 50 || cancellationRate === 100;
    const openBatchDetail = options.open_batch_detail === true;
    const sourceBatchId = String(options.source_batch_id || "").trim();
    const remainingVisitIdsOpt = Array.isArray(options.remaining_visit_ids)
      ? options.remaining_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const canceledVisitIdsOpt = Array.isArray(options.canceled_visit_ids)
      ? options.canceled_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const cancellationFeeByVisitOpt = (options.cancellation_fee_by_visit && typeof options.cancellation_fee_by_visit === "object")
      ? Object.fromEntries(
        Object.entries(options.cancellation_fee_by_visit)
          .map(([k, v]) => [String(k || "").trim(), Number(v || 0) || 0])
          .filter(([k]) => !!k)
      )
      : {};
    const idToken2 = getIdToken();
    if (!idToken2) {
      toast({ title: "未ログイン", message: "再ログインしてください。" });
      return;
    }
    if (!isAdminUser_()) {
      toast({ title: "権限不足", message: "管理者のみ実行できます。" });
      return;
    }

    const selected = selectedVisits_(visitsAll, ids);
    if (!selected.length) {
      toast({ title: "対象なし", message: "対象予約を取得できませんでした。" });
      return;
    }
    const nonDraftable = selected.filter(v => pickBillingStatus_(v) !== "unbilled");
    if (!options.allow_non_unbilled && nonDraftable.length) {
      toast({
        title: "対象外あり",
        message: `未請求以外の予約はドラフト作成できません（${nonDraftable.length}件）。`
      });
      return;
    }

    const customerIds = Array.from(new Set(selected.map(v => String(v?.customer_id || "").trim()).filter(Boolean)));
    if (customerIds.length !== 1) {
      toast({ title: "顧客混在", message: "同一顧客の予約だけを選択してください。" });
      return;
    }

    const activeSelected = selected.filter(v => isActive_(v));
    if (!options.allow_inactive && activeSelected.length !== selected.length) {
      toast({ title: "対象外あり", message: "削除済み予約は Square請求ドラフト対象にできません。" });
      return;
    }

    let feeDefaults = {};
    let customerDefaults = {};
    try {
      const r = await listBillingPriceRules_(idToken2, true);
      const rules = Array.isArray(r?.results) ? r.results : (Array.isArray(r) ? r : []);
      feeDefaults = makeBillingFeeContext_(rules);
    } catch (_) {
      feeDefaults = {};
    }
    try {
      const firstVisitId = String(selected[0]?.visit_id || "").trim();
      const cRes = firstVisitId
        ? await fetchVisitDetailPolicy(firstVisitId, idToken2, { include_customer_detail: true })
        : null;
      const c = cRes?.customer || cRes?.result?.customer || cRes?.customer_detail?.customer || {};
      customerDefaults = {
        parking_fee_amount: Math.max(0, Number(c?.parking_fee_amount || c?.parkingFeeAmount || 0) || 0),
        travel_fee_amount: Math.max(0, Number(c?.travel_fee_amount || c?.travelFeeAmount || 0) || 0),
        key_pickup_fee_rule: String(c?.key_pickup_fee_rule || c?.keyPickupFeeRule || "").trim(),
        key_return_fee_rule: String(c?.key_return_fee_rule || c?.keyReturnFeeRule || "").trim(),
      };
    } catch (_) {
      customerDefaults = {};
    }

    let formValues = null;
    let payload = null;
    let sourceBatchDetail = null;
    let sourceCancellationPreset = null;
    let sourceBatchType = "";
    let effectiveCancellationPreset = null;
    let residualVisitSections = [];
    if (sourceBatchId) {
      try {
        const detailRes = await getBillingBatchDetail_(sourceBatchId, idToken2);
        const detail = (detailRes && detailRes.result && typeof detailRes.result === "object") ? detailRes.result : detailRes;
        sourceBatchDetail = detail;
        const batch = (detail && detail.batch && typeof detail.batch === "object") ? detail.batch : {};
        sourceBatchType = String(batch.batch_type || "").trim().toLowerCase();
        const discountAmount = Math.max(0, Number(batch.discount_amount || detail?.discount_amount || 0) || 0);
        const discountLabel = String(batch.discount_label || detail?.discount_label || "割引").trim() || "割引";
        const priceRules = Array.isArray(detail?.price_rules) ? detail.price_rules : [];
        const ruleById = {};
        priceRules.forEach((r) => {
          const rid = String(r?.price_rule_id || "").trim();
          if (!rid) return;
          ruleById[rid] = r;
        });
        const lineItems = Array.isArray(detail?.invoice_line_items) ? detail.invoice_line_items : [];
        let keyPickupFeeAmount = null;
        let keyReturnFeeAmount = null;
        let keyPickupPriceRuleId = "";
        let keyReturnPriceRuleId = "";
        lineItems.forEach((line) => {
          const rid = String(line?.price_rule_id || "").trim();
          const rule = ruleById[rid] || null;
          const itemType = String(rule?.item_type || "").trim();
          const label = String(line?.label || "").trim();
          const qty = Math.max(1, Number(line?.quantity || 1) || 1);
          const unit = Math.max(0, Number(line?.unit_price_snapshot || 0) || 0);
          const amount = Math.max(0, qty * unit);
          if (!(amount > 0)) return;
          if (itemType === "key_pickup_fee" || label.includes("鍵預かり")) {
            keyPickupFeeAmount = amount;
            if (rid) keyPickupPriceRuleId = rid;
          }
          if (itemType === "key_return_fee" || label.includes("鍵返却")) {
            keyReturnFeeAmount = amount;
            if (rid) keyReturnPriceRuleId = rid;
          }
        });
        formValues = {
          discount_amount: String(discountAmount),
          discount_label: discountLabel,
          ...(keyPickupFeeAmount != null ? { key_pickup_fee_amount: String(keyPickupFeeAmount) } : {}),
          ...(keyReturnFeeAmount != null ? { key_return_fee_amount: String(keyReturnFeeAmount) } : {}),
          ...(keyPickupPriceRuleId ? { key_pickup_price_rule_id: keyPickupPriceRuleId } : {}),
          ...(keyReturnPriceRuleId ? { key_return_price_rule_id: keyReturnPriceRuleId } : {}),
        };
        if (cancellationMode && sourceBatchType !== "cancellation") {
          sourceCancellationPreset = buildSourceBatchCancellationPreset_(
            sourceBatchDetail,
            ids,
            remainingVisitIdsOpt
          );
          if (sourceCancellationPreset) {
            effectiveCancellationPreset = Object.assign({}, sourceCancellationPreset, {
              // キャンセル料は対象予約側の計算値をそのまま使う（残存費目だけプリセット維持）
              cancellation_base_amount: 0,
            });
            residualVisitSections = buildResidualVisitSections_(
              sourceBatchDetail,
              sourceCancellationPreset.remaining_visit_ids,
              feeDefaults
            );
          }
        }
      } catch (_) {}
    }
    if (!effectiveCancellationPreset) effectiveCancellationPreset = sourceCancellationPreset;
    while (true) {
      formValues = await showFormModal({
        title: cancellationMode ? "キャンセル請求編集モード" : "請求書ドラフト設定",
        bodyHtml: buildBillingBatchFormHtml_(selected, feeDefaults, customerDefaults, {
          cancellation_rate: cancellationRate,
          cancellation_preset: effectiveCancellationPreset,
          residual_visit_sections: residualVisitSections,
        }),
        okText: "確認へ",
        cancelText: "キャンセル",
        formSelector: '[data-el="billingBatchForm"]',
        onOpen: (host) => {
          const wired = wireBillingBatchFormInteractions_(host, selected, feeDefaults, {
            cancellation_rate: cancellationRate,
            cancellation_preset: effectiveCancellationPreset,
          });
          if (formValues && typeof formValues === "object") {
            Object.keys(formValues).forEach((k) => {
              const el = host.querySelector(`[name="${k}"]`);
              if (el) el.value = String(formValues[k] == null ? "" : formValues[k]);
            });
            if (wired && typeof wired.refresh === "function") wired.refresh();
          }
        }
      });
      if (formValues == null) return;
      payload = buildBillingBatchPayload_(customerIds[0], selected, formValues);
      if (cancellationMode && effectiveCancellationPreset) {
        const residualLines = effectiveCancellationPreset.full_cancel
          ? []
          : ((Array.isArray(payload.extra_lines) && payload.extra_lines.length)
            ? payload.extra_lines
            : (Array.isArray(effectiveCancellationPreset.residual_extra_lines) ? effectiveCancellationPreset.residual_extra_lines : []));
        payload = Object.assign({}, payload, {
          extra_lines: residualLines,
          cancellation_base_amount: Math.max(0, Number(effectiveCancellationPreset.cancellation_base_amount || 0) || 0),
        });
      }
      const payloadForPreview = cancellationMode
        ? Object.assign({}, payload, { memo: buildCancellationMemo_(payload, cancellationRate) })
        : payload;
      const ok = await showModal({
        title: cancellationMode ? "キャンセル請求ドラフト確認" : "請求書ドラフト確認",
        bodyHtml: buildBillingBatchPreviewHtml_(selected, payloadForPreview, feeDefaults, {
          cancellation_rate: cancellationRate,
        }),
        okText: cancellationMode ? "キャンセル請求ドラフト作成" : "請求書ドラフト作成",
        cancelText: "設定に戻る"
      });
      if (ok) break;
    }
    const feeByVisitForCancellation = cancellationMode
      ? buildCancellationVisitAmounts_(selected, payload, cancellationRate)
      : null;
    if (cancellationMode) {
      const totalCancellationFee = Object.values(feeByVisitForCancellation || {}).reduce((acc, x) => acc + (Math.max(0, Number(x || 0) || 0)), 0);
      if (!(totalCancellationFee > 0)) {
        toast({
          title: "作成失敗",
          message: "キャンセル料が0円のためキャンセル請求書を作成できません。訪問系料金（訪問/繁忙期）を確認してください。"
        });
        return;
      }
    }

    const prevById = {};
    selected.forEach((v) => {
      const vid = String(v?.visit_id || "").trim();
      if (!vid) return;
      prevById[vid] = {
        billing_status: pickBillingStatus_(v),
        latest_invoice_id: String(v?.latest_invoice_id || ""),
        latest_invoice_line_id: String(v?.latest_invoice_line_id || "")
      };
    });

    let createCommitted = false;
    try {
      selected.forEach((v) => {
        const vid = String(v?.visit_id || "").trim();
        if (!vid) return;
        const mm = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: "billed" });
        visitsAll = mm.list;
      });
      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();

      const created = await runWithBlocking_(
        {
          title: "請求書ドラフトを作成しています",
          bodyHtml: "予約と請求連携情報を保存しています。",
          busyText: "作成中..."
        },
        async () => {
          if (sourceBatchId) {
            await revertBillingBatchToUnbilled_(sourceBatchId, idToken2);
          }
          const payloadForCreate = cancellationMode
            ? buildCancellationCreatePayload_(payload, cancellationRate)
            : payload;
          const res = await createBillingBatch_(payloadForCreate, idToken2);
          return (res && res.result && typeof res.result === "object") ? res.result : res;
        }
      );
      createCommitted = true;

      const batchId = String(created?.batch_id || "");
      selected.forEach((v) => {
        const vid = String(v?.visit_id || "").trim();
        if (!vid) return;
        const mm = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: "billed" });
        visitsAll = mm.list;
      });
      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();
      const targetDeactivateIds = Array.from(new Set(
        (canceledVisitIdsOpt.length
          ? canceledVisitIdsOpt
          : (cancellationMode ? selected.map((v) => String(v?.visit_id || "").trim()) : [])
        )
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      ));
      if (targetDeactivateIds.length) {
        const feeByVisit = cancellationMode
          ? (feeByVisitForCancellation || buildCancellationVisitAmounts_(selected, payload, cancellationRate))
          : {};
        const nextBillingStatus = cancellationRate > 0 ? "billed" : "unbilled";
        let syncWarnCount = 0;
        for (const vid of targetDeactivateIds) {
          const fee = Math.max(0, Number(
            Object.prototype.hasOwnProperty.call(cancellationFeeByVisitOpt, vid)
              ? cancellationFeeByVisitOpt[vid]
              : feeByVisit[vid]
          ) || 0);
          try {
            await updateVisitWithCalendarRetry_({
              origin: "portal",
              source: "portal",
              sync_calendar: true,
              allow_lifecycle_commit: true,
              visit_id: vid,
              fields: {
                is_active: false,
                deleted_at: new Date().toISOString(),
                deleted_source: "portal",
                delete_reason: "cancelled",
                billing_status: nextBillingStatus,
                cancellation_fee_rate: cancellationRate,
                cancellation_fee_amount: fee,
              },
            }, idToken2);
          } catch (_) {
            syncWarnCount += 1;
          }
          const mm = mergeVisitById(visitsAll, vid, {
            visit_id: vid,
            is_active: false,
            billing_status: nextBillingStatus,
            cancellation_fee_rate: cancellationRate,
            cancellation_fee_amount: fee,
          });
          visitsAll = mm.list;
        }
        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        if (syncWarnCount > 0) {
          toast({
            title: "カレンダー同期警告",
            message: "請求書作成は完了しましたが、一部予約のカレンダー同期に失敗しました。"
          });
        }
      }
      markDirty_();
      toast({ title: "作成完了", message: `${cancellationMode ? "キャンセル請求" : "請求書"}ドラフト連携バッチを作成しました。${batchId || ""}`.trim() });
      await showModal({
        title: "Square請求書 編集ヒント",
        bodyHtml: buildSquareInvoiceGuideHtml_(selected, created?.square_draft_guide),
        okText: "閉じる",
        cancelText: null
      });
      if (openBatchDetail && batchId) {
        clearBulkSelection_();
        location.hash = `#/invoices?id=${encodeURIComponent(batchId)}`;
        return;
      }
      clearBulkSelection_();
    } catch (err) {
      if (!createCommitted) {
        try {
          selected.forEach((v) => {
            const vid = String(v?.visit_id || "").trim();
            const prev = prevById[vid];
            if (!vid || !prev) return;
            const mm = mergeVisitById(visitsAll, vid, {
              visit_id: vid,
              billing_status: prev.billing_status,
              latest_invoice_id: prev.latest_invoice_id,
              latest_invoice_line_id: prev.latest_invoice_line_id
            });
            visitsAll = mm.list;
          });
          saveCache_(cacheKey_(state), visitsAll);
          applyAndRender_();
        } catch (_) {}
      } else {
        markDirty_();
      }
      const raw = String(err?.message || err || "");
      const msg = createCommitted
        ? "請求書作成は完了しましたが、画面反映に失敗しました。再読み込みしてください。"
        : raw.includes("square invoice line items resolved to empty")
        ? "請求明細を自動組み立てできませんでした。対象予約の料金設定（price_rule_id / product_name / variant_name / base_fee）を確認してください。"
        : raw.includes("cancellation fee resolved to zero")
          ? "キャンセル料が0円のためキャンセル請求書を作成できません。訪問系料金（訪問/繁忙期）を確認してください。"
        : raw;
      toast({ title: createCommitted ? "画面反映警告" : "作成失敗", message: msg });
    }
  };

  // bulk 実行（Optimistic + server bulk-update）
  const runBulkEdit_ = async () => {
    const ids = Array.from(bulkSelected || []);
    if (!ids.length) return;

    const idToken2 = getIdToken();
    if (!idToken2) {
      toast({ title: "未ログイン", message: "再ログインしてください。" });
      return;
    }

    // ===== 対象項目選択 =====
    const itemSelectId = "mBulkItemSelect";
    const itemBodyHtml = `
      <div class="p" style="margin-bottom:8px;">一括変更する項目を選択してください。</div>
      <select id="${escapeHtml(itemSelectId)}" class="select" style="width:100%;">
        <option value="done">完了状態</option>
        <option value="is_active">有効/削除済</option>
      </select>
      <div class="p" style="margin-top:8px; opacity:0.8;">
        対象：<strong>${escapeHtml(String(ids.length))}件</strong>
      </div>
    `;
    const pickedItem = await showSelectModal({
      title: "一括編集",
      bodyHtml: itemBodyHtml,
      okText: "次へ",
      cancelText: "キャンセル",
      selectId: itemSelectId,
    });
    if (pickedItem == null) return;
    const item = String(pickedItem || "").trim();

    // ===== 変更値選択 =====
    let fields = null;
    let confirmText = "";
    let cancellationRateForBulk = 0;

    if (item === "billing_status") {
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK_ };
      const ordered = (opt && Array.isArray(opt.order) && opt.order.length) ? opt.order : Object.keys(map);

      const selectId2 = "mBulkBillingSelect";
      const optionsHtml = ordered.map(k => {
        const label = String(map[k] || billingStatusLabel_(k));
        return `<option value="${escapeHtml(String(k))}">${escapeHtml(label)}（${escapeHtml(String(k))}）</option>`;
      }).join("");
      const body2 = `
        <div class="p" style="margin-bottom:8px;">請求ステータス（変更後）を選択してください。</div>
        <select id="${escapeHtml(selectId2)}" class="select" style="width:100%;">${optionsHtml}</select>
        <div class="p" style="margin-top:8px; opacity:0.8;">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
      `;
      const picked2 = await showSelectModal({
        title: "一括編集（請求ステータス）",
        bodyHtml: body2,
        okText: "確認へ",
        cancelText: "キャンセル",
        selectId: selectId2,
      });
      if (picked2 == null) return;
      const nextKey = String(picked2 || "").trim() || "unbilled";
      fields = { billing_status: nextKey };
      confirmText = `請求ステータスを「${billingStatusLabel_(nextKey)}」に変更`;
    } else if (item === "done") {
      const selectId2 = "mBulkDoneSelect";
      const body2 = `
        <div class="p" style="margin-bottom:8px;">完了状態（変更後）を選択してください。</div>
        <select id="${escapeHtml(selectId2)}" class="select" style="width:100%;">
          <option value="done">完了</option>
          <option value="open">未完了</option>
        </select>
        <div class="p" style="margin-top:8px; opacity:0.8;">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
      `;
      const picked2 = await showSelectModal({
        title: "一括編集（完了状態）",
        bodyHtml: body2,
        okText: "確認へ",
        cancelText: "キャンセル",
        selectId: selectId2,
      });
      if (picked2 == null) return;
      const nextDone = (String(picked2) === "done");
      fields = { is_done: nextDone, done: nextDone };
      confirmText = `完了状態を「${nextDone ? "完了" : "未完了"}」に変更`;
    } else if (item === "is_active") {
      const selectId2 = "mBulkActiveSelect";
      const body2 = `
        <div class="p" style="margin-bottom:8px;">有効/削除済（変更後）を選択してください。</div>
        <select id="${escapeHtml(selectId2)}" class="select" style="width:100%;">
          <option value="active">有効</option>
          <option value="inactive">削除済</option>
        </select>
        <div class="p" style="margin-top:8px; opacity:0.8;">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
      `;
      const picked2 = await showSelectModal({
        title: "一括編集（有効/削除済）",
        bodyHtml: body2,
        okText: "確認へ",
        cancelText: "キャンセル",
        selectId: selectId2,
      });
      if (picked2 == null) return;
      const nextActive = (String(picked2) === "active");
      fields = { is_active: nextActive };
      confirmText = `有効ステータスを「${nextActive ? "有効" : "削除済"}」に変更`;
      if (!nextActive) {
        const pickedRate = await pickCancellationFeeRate_();
        if (pickedRate == null) return;
        cancellationRateForBulk = pickedRate;
      }
    } else {
      toast({ title: "対象外", message: "この項目は未対応です。" });
      return;
    }

    if (item === "is_active" && fields && fields.is_active === false) {
      const selected = selectedVisits_(visitsAll, ids);
      const doneVisitIds = selected
        .filter((v) => isDone_(v))
        .map((v) => String(v?.visit_id || "").trim())
        .filter(Boolean);
      if (doneVisitIds.length) {
        toast({ title: "変更不可", message: "完了済みの予約は削除済みにできません。未完了に戻してから実行してください。" });
        return;
      }
      const useDraftFlow = (cancellationRateForBulk === 50 || cancellationRateForBulk === 100);
      const policyIds = selected
        .map((v) => String(v?.visit_id || "").trim())
        .filter(Boolean);
      if (!policyIds.length) return;

      const idToken3 = getIdToken();
      if (!idToken3) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }
      const previewByVisitId = {};
      const selectedVisitIdsByBatch = {};
      for (const vid of policyIds) {
        const preview = await fetchCancelVisitPreview_(vid, idToken3, {
          source: "portal",
          cancellation_rate: cancellationRateForBulk,
        });
        previewByVisitId[vid] = preview;
        const batchId = String(preview?.source_batch_id || "").trim();
        if (batchId) {
          if (!selectedVisitIdsByBatch[batchId]) selectedVisitIdsByBatch[batchId] = new Set();
          selectedVisitIdsByBatch[batchId].add(vid);
        }
      }
      if (useDraftFlow) {
        const billedBatchIds = new Set();
        for (const vid of policyIds) {
          const preview = previewByVisitId[vid] || {};
          const status = normalizeCancelBillingStatus_(preview?.billing_status);
          const batchId = String(preview?.source_batch_id || "").trim();
          if (status === "billed" && batchId) billedBatchIds.add(batchId);
        }
        if (billedBatchIds.size > 1) {
          toast({
            title: "対象外あり",
            message: "請求元が異なる予約が含まれるため一括再発行できません。請求単位ごとに実行してください。"
          });
          return;
        }
      }

      const draftRequests = [];
      const confirmedFullBatchZeroCancelKeys = new Set();

      for (const vid of policyIds) {
        const preview = previewByVisitId[vid] || {};
        const previewStatus = normalizeCancelBillingStatus_(preview?.billing_status);
        const batchId = String(preview?.source_batch_id || "").trim();
        const selectedSet = batchId ? (selectedVisitIdsByBatch[batchId] || new Set()) : new Set();
        const activeVisitIds = Array.isArray(preview?.batch_active_visit_ids)
          ? preview.batch_active_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const isFullBatchCancel = !!batchId
          && activeVisitIds.length > 0
          && activeVisitIds.every((id) => selectedSet.has(id));

        if (cancellationRateForBulk === 0 && previewStatus === "billed" && isFullBatchCancel) {
          const confirmKey = batchId || `visit:${vid}`;
          if (!confirmedFullBatchZeroCancelKeys.has(confirmKey)) {
            const confirmed = await confirmCancelPreview_(
              preview,
              "予約キャンセルに伴い、発行済み請求書を削除し、未請求に変更します。"
            );
            if (!confirmed) return;
            confirmedFullBatchZeroCancelKeys.add(confirmKey);
          }
        }

        let discountDecision = null;
        if (useDraftFlow && previewStatus === "unbilled") {
          discountDecision = {
            discount_mode: "keep",
            discount_amount: 0,
          };
        } else if (isFullBatchCancel) {
          discountDecision = {
            discount_mode: "keep",
            discount_amount: Math.max(0, Number(preview?.current_discount_amount || 0) || 0),
          };
        } else {
          const msg = buildCancelPolicyMessage_(preview);
          discountDecision = await confirmCancelPreview_(preview, msg);
          if (!discountDecision) continue;
        }

        const flow = await runCancelVisitFlow_(vid, idToken3, {
          source: "portal",
          cancellation_rate: cancellationRateForBulk,
          current_billing_status: previewStatus,
          preview_override: preview,
          discount_decision: discountDecision,
          defer_invoice_draft: previewStatus !== "paid"
            && !(cancellationRateForBulk === 0 && isFullBatchCancel),
        });
        if (flow?.skipped) continue;
        const done = flow?.done || {};
        const syncErrors = Array.isArray(flow?.sync_errors) ? flow.sync_errors : [];
        const deferredCommit = done?.deferred_commit === true;
        const mm = mergeVisitById(visitsAll, vid, deferredCommit ? {
          visit_id: vid,
        } : {
          visit_id: vid,
          is_active: false,
          cancellation_fee_rate: Number(done.cancellation_fee_rate || cancellationRateForBulk) || 0,
          cancellation_fee_amount: Number(done.cancellation_fee_amount || 0) || 0,
          billing_status: String(done?.updated?.billing_status || (previewStatus === "billed" ? "unbilled" : previewStatus) || "").trim() || undefined,
        });
        visitsAll = mm.list;
        if (syncErrors.length) {
          toast({ title: "カレンダー同期警告", message: "予約更新は完了しましたが、カレンダー同期に失敗しました。再実行してください。" });
        }
        const skipDraftForFullBatchZero = cancellationRateForBulk === 0 && isFullBatchCancel;
        if (!skipDraftForFullBatchZero && previewStatus !== "paid" && done?.next_action === "create_cancellation_invoice") {
          const sourceId = String(done?.source_batch_id || preview?.source_batch_id || "").trim();
          const remainingIds = Array.isArray(done?.remaining_active_visit_ids)
            ? done.remaining_active_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
            : [];
          if (cancellationRateForBulk === 0) {
            draftRequests.push({
              ids: remainingIds.length ? remainingIds : [vid],
              cancellation_rate: 0,
              source_batch_id: sourceId,
              remaining_visit_ids: remainingIds,
              canceled_visit_ids: [vid],
              cancellation_fee_by_visit: { [vid]: Number(done?.cancellation_fee_amount || 0) || 0 },
            });
          } else {
            draftRequests.push({
              ids: [vid],
              cancellation_rate: cancellationRateForBulk,
              source_batch_id: sourceId,
              remaining_visit_ids: activeVisitIds.filter((id) => !selectedSet.has(id)),
              canceled_visit_ids: [vid],
              cancellation_fee_by_visit: { [vid]: Number(done?.cancellation_fee_amount || 0) || 0 },
            });
          }
        }
      }

      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();
      if (draftRequests.length) {
        const sourceBatchIds = Array.from(new Set(draftRequests.map((x) => String(x?.source_batch_id || "").trim()).filter(Boolean)));
        const sourceBatchId = sourceBatchIds[0] || "";
        const isZeroRateDraft = draftRequests.every((x) => Number(x?.cancellation_rate || 0) === 0);
        const draftIds = Array.from(new Set(
          draftRequests.flatMap((x) => (Array.isArray(x?.ids) ? x.ids : [])).map((x) => String(x || "").trim()).filter(Boolean)
        ));
        const remainingIds = Array.from(new Set(
          draftRequests.flatMap((x) => (Array.isArray(x?.remaining_visit_ids) ? x.remaining_visit_ids : [])).map((x) => String(x || "").trim()).filter(Boolean)
        ));
        const canceledIds = Array.from(new Set(
          draftRequests.flatMap((x) => (Array.isArray(x?.canceled_visit_ids) ? x.canceled_visit_ids : [])).map((x) => String(x || "").trim()).filter(Boolean)
        ));
        const cancellationFeeByVisit = {};
        draftRequests.forEach((x) => {
          const map = (x?.cancellation_fee_by_visit && typeof x.cancellation_fee_by_visit === "object")
            ? x.cancellation_fee_by_visit
            : {};
          Object.keys(map).forEach((k) => {
            const key = String(k || "").trim();
            if (!key) return;
            cancellationFeeByVisit[key] = Number(map[k] || 0) || 0;
          });
        });
        await runCreateInvoiceDraft_({
          ids: draftIds,
          cancellation_rate: isZeroRateDraft ? 0 : cancellationRateForBulk,
          open_batch_detail: true,
          allow_non_unbilled: true,
          allow_inactive: true,
          source_batch_id: sourceBatchId,
          remaining_visit_ids: remainingIds,
          canceled_visit_ids: canceledIds,
          cancellation_fee_by_visit: cancellationFeeByVisit,
        });
      }
      return;
    }

    if (item === "is_active" && fields && fields.is_active === true) {
      const selected = selectedVisits_(visitsAll, ids);
      const policyIds = selected
        .map((v) => String(v?.visit_id || "").trim())
        .filter(Boolean);
      if (!policyIds.length) return;

      const idToken3 = getIdToken();
      if (!idToken3) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      const previewByVisitId = {};
      for (const vid of policyIds) {
        const preview = await fetchReactivateVisitPreview_(vid, idToken3, {
          source: "portal",
          reactivate_visit_ids: policyIds,
        });
        previewByVisitId[vid] = preview;
        if (preview?.blocked === true) {
          toast({
            title: "再有効化不可",
            message: String(preview?.message || "この予約は再有効化できません。").trim(),
          });
          return;
        }
      }

      const requireConfirm = policyIds.some((vid) => previewByVisitId[vid]?.require_confirm === true);
      if (requireConfirm) {
        const ok2 = await showModal({
          title: "確認",
          bodyHtml: `
            <p class="p"><strong>有効ステータスを「有効」に変更</strong>します。</p>
            <div class="p" style="opacity:0.9; margin-top:8px;">
              対象：<strong>${escapeHtml(String(policyIds.length))}件</strong><br/>
              キャンセル請求書がある予約は請求書を取り消してから再有効化します。
            </div>
          `,
          okText: "実行",
          cancelText: "キャンセル",
          danger: false,
        });
        if (!ok2) return;
      }

      const failedRows = [];
      for (const vid of policyIds) {
        try {
          const flow = await runReactivateVisitFlow_(vid, idToken3, {
            source: "portal",
            preview_override: previewByVisitId[vid] || {},
            skip_confirm: true,
            show_blocked_modal: false,
            reactivate_visit_ids: policyIds,
          });
          if (flow?.skipped) {
            failedRows.push({
              visit_id: vid,
              error: String(flow?.preview?.message || "再有効化できません。"),
            });
            continue;
          }
          const done = flow?.done || {};
          const updated = (done && typeof done.updated === "object") ? done.updated : {};
          const mm = mergeVisitById(visitsAll, vid, Object.assign({ visit_id: vid }, updated));
          visitsAll = mm.list;
          const syncErrors = Array.isArray(done?.sync_errors) ? done.sync_errors : [];
          if (syncErrors.length) {
            toast({ title: "カレンダー同期警告", message: "予約更新は完了しましたが、カレンダー同期に失敗しました。再実行してください。" });
          }
        } catch (e) {
          failedRows.push({
            visit_id: vid,
            error: e?.message || "失敗",
          });
        }
      }

      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();
      if (failedRows.length) {
        const msg = failedRows
          .slice(0, 3)
          .map(r => `${String(r?.visit_id || "")}: ${String(r?.error || "失敗")}`)
          .join("\n");
        toast({ title: "一部失敗", message: msg || `失敗: ${failedRows.length}件` });
      } else {
        toast({ title: "更新完了", message: `一括更新しました（${policyIds.length}件）。` });
      }
      clearBulkSelection_();
      return;
    }

    // ===== 最終確認 =====
    const ok = await showModal({
      title: "確認",
      bodyHtml: `
        <p class="p"><strong>${escapeHtml(confirmText)}</strong>します。</p>
        <div class="p" style="opacity:0.9; margin-top:8px;">
          対象：<strong>${escapeHtml(String(ids.length))}件</strong><br/>
          期間：${escapeHtml(state.date_from)} → ${escapeHtml(state.date_to_ymd)}<br/>
          ※手動選択した予約のみが対象です
        </div>
      `,
      okText: "実行",
      cancelText: "キャンセル",
      danger: (item === "is_active" && fields && fields.is_active === false),
    });
    if (!ok) return;
    if (item === "done" && fields && fields.is_done === true) {
      const selected = selectedVisits_(visitsAll, ids);
      const inactiveIds = selected
        .filter((v) => !pickIsActive_(v))
        .map((v) => String(v?.visit_id || "").trim())
        .filter(Boolean);
      if (inactiveIds.length) {
        toast({ title: "更新不可", message: "削除済みの予約は完了にできません。" });
        return;
      }
      const canProceed = await confirmKeyLocationBeforeBulkDone({ visitIds: ids });
      if (!canProceed) return;
    }

    // ===== 事前スナップショット（rollback用）=====
    const prevById = {};
    for (const id of ids) {
      const m = visitsAll.find(v => String(v.visit_id || v.id || "") === String(id));
      if (m) prevById[id] = {
        billing_status: pickBillingStatus_(m),
        done: isDone_(m),
        is_active: pickIsActive_(m),
      };
    }

    // ===== Optimistic: visitsAll + cache + render =====
    try {
      for (const id of ids) {
        const patch = { visit_id: id, ...fields };
        const mm = mergeVisitById(visitsAll, id, patch);
        visitsAll = mm.list;
      }
      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();
    } catch (_) {}

    // ===== Server: bulk-update =====
    try {
      const failedRows = await runWithBlocking_(
        {
          title: "一括更新を実行しています",
          bodyHtml: "選択した予約へ変更内容を反映しています。",
          busyText: "更新中...",
        },
        async (blocker) => {
          const normalizeBulkFields_ = (fields0, item0) => {
            const f = fields0 || {};
            if (item0 === "done") {
              return { is_done: !!(f.is_done ?? f.done) };
            }
            if (item0 === "is_active") {
              return { is_active: !!f.is_active };
            }
            if (item0 === "billing_status") {
              return { billing_status: String(f.billing_status || "").trim() || "unbilled" };
            }
            return f;
          };

          const fieldsForBulk = normalizeBulkFields_(fields, item);
          const updates = ids.map((id) => ({
            visit_id: String(id || "").trim(),
            fields: { ...(fieldsForBulk || {}) },
          })).filter(x => x.visit_id);

          const up = await bulkUpdateVisits_(updates, idToken2);

          const u = (up && typeof up === "object" && up.result && typeof up.result === "object") ? up.result : up;
          if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");
          const rs = (u && Array.isArray(u.results)) ? u.results : [];

          const successRows = rs.filter(r => String(r?.status || "") === "success");
          const failedRows0  = rs.filter(r => String(r?.status || "") === "failed");
          const failedIds = new Set(failedRows0.map(r => String(r?.visit_id || "").trim()).filter(Boolean));

          blocker.setBusyText("画面へ反映しています...");
          for (const r of successRows) {
            const id = String(r?.visit_id || "").trim();
            if (!id) continue;
            const uu = (r && r.updated && typeof r.updated === "object") ? r.updated : null;
            if (!uu) continue;
            const patch = { visit_id: id, ...uu };
            const mm = mergeVisitById(visitsAll, id, patch);
            visitsAll = mm.list;
          }

          for (const id of failedIds) {
            const prev = prevById[id];
            if (!prev) continue;
            const rollbackPatch = {
              visit_id: id,
              ...(item === "billing_status" ? { billing_status: prev.billing_status } : {}),
              ...(item === "done" ? { is_done: prev.done, done: prev.done } : {}),
              ...(item === "is_active" ? { is_active: prev.is_active } : {}),
            };
            const mm = mergeVisitById(visitsAll, id, rollbackPatch);
            visitsAll = mm.list;
          }

          saveCache_(cacheKey_(state), visitsAll);
          applyAndRender_();
          return failedRows0;
        }
      );

      if (failedRows.length) {
        const msg = failedRows
          .slice(0, 3)
          .map(r => `${String(r?.visit_id || "")}: ${String(r?.error || "失敗")}`)
          .join("\n");
        toast({ title: "一部失敗", message: msg || `失敗: ${failedRows.length}件` });
      } else {
        toast({ title: "更新完了", message: `一括更新しました（${ids.length}件）。` });
      }

      clearBulkSelection_();
    } catch (err) {
      // ===== rollback（全対象）=====
      try {
        for (const id of ids) {
          const prev = prevById[id];
          if (!prev) continue;
          const rollbackPatch = {
            visit_id: id,
            ...(item === "billing_status" ? { billing_status: prev.billing_status } : {}),
            ...(item === "done" ? { is_done: prev.done, done: prev.done } : {}),
            ...(item === "is_active" ? { is_active: prev.is_active } : {}),
          };
          const mm = mergeVisitById(visitsAll, id, rollbackPatch);
          visitsAll = mm.list;
        }
        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
      } catch (_) {}
      toast({ title: "更新失敗", message: err?.message || String(err || "") });
    }
  };

  const applyAndRender_ = () => {
    const kw = normalizeKeyword_(state.keyword);
    let base = (state.active_filter === "active_only")
      ? visitsAll.filter(v => isActive_(v))
      : visitsAll.slice();

    let filtered = (kw ? base.filter(v => keywordHit_(v, kw)) : base.slice());
    
    // 完了状態フィルタ
    if (state.done_filter === "open_only") {
      filtered = filtered.filter(v => !isDone_(v));
    } else if (state.done_filter === "done_only") {
      filtered = filtered.filter(v => isDone_(v));
    }

    // 並び（未完了優先は open_first のときのみ）
    const sortMode = (state.done_filter === "all") ? "all" : "open_first";
    const sorted = sortVisits_(filtered, state.sort_order, sortMode);

    if (!sorted.length) {
      listEl.innerHTML = `<p class="p">条件に一致する予約がありません。</p>`;
      visibleVisitIds = [];
      applyBulkModeToDom_();
      return;
    }

    // 再描画（並び順の整合性を優先）
    const y = window.scrollY;
    listEl.innerHTML = sorted.map(cardHtml).join("");
    window.scrollTo(0, y);
    applyVisitTypeBadges_(listEl);
    visibleVisitIds = sorted.map((v) => String(v?.visit_id || "").trim()).filter(Boolean);
    applyBulkModeToDom_();
  };

  const fetchAndRender_ = async ({ force = false } = {}) => {
    listEl.innerHTML = `<p class="p">読み込み中...</p>`;

    // ===== 詳細ページ等で更新が起きたら一覧キャッシュを捨てる =====
    // - dirty が立っていれば、キャッシュを破棄して必ずサーバ再取得する
    if (consumeDirty_()) {
      invalidateCache_();
      force = true;
    }

    const idToken = getIdToken();
    if (!idToken) {
      listEl.innerHTML = `<p class="p">ログインしてください。</p>`;
      return;
    }

    // 訪問種別ラベルの先読みは廃止（price_ruleベース表示へ移行）
    Promise.resolve()
      .then(() => { applyVisitTypeBadges_(appEl); })
      .catch(() => {});

    // 請求ステータス候補（失敗してもフォールバック）
    ensureBillingStatusLabelMap_(idToken).catch(() => {});

    // ===== cache（同一期間なら短時間は再取得しない）=====
    const ck = cacheKey_(state);
    if (!force) {
      const cached = loadCache_(ck);
      if (cached) {
        visitsAll = cached;
        // ラベル読み込み済みなら表示・フィルタをラベルで整える
        applyVisitTypeBadges_(appEl);
        applyAndRender_();
        if (pendingCancelDraft) {
          const req = pendingCancelDraft;
          pendingCancelDraft = null;
          await runCreateInvoiceDraft_({
            ids: Array.isArray(req.visit_ids) ? req.visit_ids : [req.visit_id],
            cancellation_rate: req.cancellation_rate,
            open_batch_detail: req.open_batch_detail !== false,
            allow_non_unbilled: req.allow_non_unbilled === true,
            allow_inactive: req.allow_inactive === true,
            source_batch_id: req.source_batch_id,
            remaining_visit_ids: Array.isArray(req.remaining_visit_ids) ? req.remaining_visit_ids : [],
            canceled_visit_ids: Array.isArray(req.canceled_visit_ids) ? req.canceled_visit_ids : [],
            cancellation_fee_by_visit: (req.cancellation_fee_by_visit && typeof req.cancellation_fee_by_visit === "object") ? req.cancellation_fee_by_visit : {},
          });
        }
        return;
      }
    }

    let res;
    try {
      res = await portalVisitsList_(idToken, {
        date_from: state.date_from,
        date_to: state.date_to_ymd + " 23:59:59",
      });
    } catch (err) {
      const msg = err?.message || String(err || "");
      // API側で認証エラー（Invalid id_token）は ApiError 化＋token破棄済み
      if (msg.includes("認証の有効期限が切れました") || msg.includes("再ログインしてください")) {
        toast({ title: "ログイン期限切れ", message: "再ログインしてください。" });
        listEl.innerHTML = `<p class="p">ログイン期限が切れました。再ログインしてください。</p>`;
        return;
      }
      toast({ title: "取得失敗", message: msg });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
      return;
    }

    const { results: visits } = unwrapResults(res);

    // 返却が配列パターン / オブジェクトパターン両対応
    if (!Array.isArray(visits) || visits.length === 0) {
      listEl.innerHTML = `<p class="p">対象期間の予約がありません。</p>`;
      visitsAll = [];
      visibleVisitIds = [];
      applyBulkModeToDom_();
      return;
    }

    visitsAll = visits;
    saveCache_(cacheKey_(state), visitsAll);

    // 旧訪問種別ロジックは廃止済み

    applyAndRender_();
    if (pendingCancelDraft) {
      const req = pendingCancelDraft;
      pendingCancelDraft = null;
      await runCreateInvoiceDraft_({
        ids: Array.isArray(req.visit_ids) ? req.visit_ids : [req.visit_id],
        cancellation_rate: req.cancellation_rate,
        open_batch_detail: req.open_batch_detail !== false,
        allow_non_unbilled: req.allow_non_unbilled === true,
        allow_inactive: req.allow_inactive === true,
        source_batch_id: req.source_batch_id,
        remaining_visit_ids: Array.isArray(req.remaining_visit_ids) ? req.remaining_visit_ids : [],
        canceled_visit_ids: Array.isArray(req.canceled_visit_ids) ? req.canceled_visit_ids : [],
        cancellation_fee_by_visit: (req.cancellation_fee_by_visit && typeof req.cancellation_fee_by_visit === "object") ? req.cancellation_fee_by_visit : {},
      });
    }
  };

  await fetchAndRender_({ force: !!pendingCancelDraft });

  // 初期表示（bulk bar）
  updateBulkBar_();

  // ===== フィルタUI =====
  const resetToDefault_ = async () => {
    const d = defaultRange();
    state = {
      ...state,
      date_from: d.date_from,
      date_to_ymd: d.date_to.slice(0, 10),
      keyword: "",
      sort_order: "asc",
      done_filter: "open_first",
      active_filter: "active_only",
    };
    if (fromEl) fromEl.value = state.date_from;
    if (toEl) toEl.value = state.date_to_ymd;
    if (kwEl) kwEl.value = state.keyword;
    if (doneEl) doneEl.value = state.done_filter;
    if (activeEl) activeEl.value = state.active_filter;
    if (sortEl) sortEl.value = state.sort_order;
    saveState_(state);
    await fetchAndRender_({ force: true });
  };

  // 入力（keyword / sort）は即時反映
  kwEl?.addEventListener("input", () => {
    state.keyword = kwEl.value || "";
    saveState_(state);
    applyAndRender_();
  });

  doneEl?.addEventListener("change", () => {
    state.done_filter = doneEl.value || "open_first";
    saveState_(state);
    applyAndRender_();
  });

  activeEl?.addEventListener("change", () => {
    state.active_filter = activeEl.value || "active_only";
    saveState_(state);
    applyAndRender_();
  });
  
  sortEl?.addEventListener("change", () => {
    state.sort_order = sortEl.value || "asc";
    saveState_(state);
    applyAndRender_();
  });

  // 期間はサーバ取得の範囲に影響するので「適用」で再取得
  filtersEl?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const a = btn.dataset.action;
    if (a === "clear-keyword") {
      if (kwEl) kwEl.value = "";
      state.keyword = "";
      saveState_(state);
      applyAndRender_();
      return;
    }

    if (a === "reset") {
      await resetToDefault_();
      return;
    }

    if (a === "apply-range") {
      const nextFrom = String(fromEl?.value || "").trim();
      const nextTo = String(toEl?.value || "").trim();
      if (!nextFrom || !nextTo) {
        toast({ title: "入力不足", message: "期間（from/to）を入力してください。" });
        return;
      }
      if (nextFrom > nextTo) {
        toast({ title: "期間エラー", message: "from が to より後になっています。" });
        return;
      }
      state.date_from = nextFrom;
      state.date_to_ymd = nextTo;
      saveState_(state);
      await fetchAndRender_({ force: true });
      return;
    }
  });

  // ===== bulk bar actions =====
  bulkBarEl?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === "bulk-clear") {
      clearBulkSelection_();
      return;
    }

    if (a === "bulk-execute") {
      if (!bulkSelected.size) return;
      if (bulkAction === "bulk-create-invoice-draft") await runCreateInvoiceDraft_();
      else await runBulkEdit_();
      return;
    }
  });

  bulkBarEl?.addEventListener("change", (e) => {
    const sel = e.target.closest('select[data-role="bulk-action"]');
    if (sel) {
      bulkAction = String(sel.value || "bulk-run").trim();
      updateBulkBar_();
      return;
    }
    const master = e.target.closest('input[data-action="bulk-select-all"]');
    if (!master) return;
    if (master.checked) {
      visibleVisitIds.forEach((id) => bulkSelected.add(id));
    } else {
      visibleVisitIds.forEach((id) => bulkSelected.delete(id));
    }
    applyBulkModeToDom_();
  });

  // bulk checkbox change
  listEl.addEventListener("change", (e) => {
    const ch = e.target.closest('input[data-role="bulk-check"]');
    if (!ch) return;
    const vid = String(ch.getAttribute("data-visit-id") || ch.dataset.visitId || "").trim();
    if (!vid) return;
    if (ch.checked) bulkSelected.add(vid);
    else bulkSelected.delete(vid);
    updateBulkBar_();
  });

  // カード内アクション（詳細 / 完了切替）
  listEl.addEventListener("click", async (e) => {
    const actEl = e.target.closest("[data-action]");
    if (!actEl) return;

    const card = e.target.closest(".card");
    const vid = card?.dataset?.visitId;
    if (!vid) return;

    const action = actEl.dataset.action;

    if (action === "open") {
      // 詳細へ遷移する直前にスクロール位置を保存し、戻ったら復元する
      try {
        sessionStorage.setItem(KEY_VLIST_SCROLL_Y, String(window.scrollY || 0));
        markRestoreOnce_();
      } catch (_) {}
      location.hash = `#/visits?id=${encodeURIComponent(vid)}&return_to=${encodeURIComponent(location.hash || "#/visits")}`;
      return;
    }

    if (action === "toggle-active") {
      if (actEl.dataset.busy === "1") return;

      const currentActive = (card?.dataset?.isActive === "1");
      const nextActive = !currentActive;
      const currentDone = (card?.dataset?.done === "1");
      if (!nextActive && currentDone) {
        toast({ title: "変更不可", message: "完了済みの予約は削除済みにできません。未完了に戻してから実行してください。" });
        return;
      }
      const currentBillingStatus = normalizeCancelBillingStatus_(card?.dataset?.billingStatus || "");

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevIsActive = (card?.dataset?.isActive === "1");
      const prevClasses = {
        isActive: actEl.classList.contains("is-active"),
        badgeDanger: actEl.classList.contains("badge-danger"),
        isInactive: actEl.classList.contains("is-inactive"),
      };

      try {
        const idToken2 = getIdToken();
        if (!idToken2) {
          toast({ title: "未ログイン", message: "再ログインしてください。" });
          return;
        }

        let patch = { visit_id: vid, is_active: nextActive };
        if (!nextActive) {
          const pickedRate = await pickCancellationFeeRate_();
          if (pickedRate == null) return;
          const flow = await runCancelVisitFlow_(vid, idToken2, {
            source: "portal",
            cancellation_rate: pickedRate,
            current_billing_status: currentBillingStatus,
          });
          if (flow?.skipped) return;
          const done = flow?.done || {};
          const syncErrors = Array.isArray(flow?.sync_errors) ? flow.sync_errors : [];
          if (flow?.needs_draft && flow?.draft_payload) {
            const draftIds = Array.isArray(flow.draft_payload.ids) ? flow.draft_payload.ids : [vid];
            await runCreateInvoiceDraft_({
              ids: draftIds,
              cancellation_rate: Number(flow.draft_payload.cancellation_rate || 0) || 0,
              open_batch_detail: true,
              allow_non_unbilled: true,
              source_batch_id: String(flow.draft_payload.source_batch_id || "").trim(),
              remaining_visit_ids: Array.isArray(flow.draft_payload.remaining_visit_ids) ? flow.draft_payload.remaining_visit_ids : [],
              canceled_visit_ids: Array.isArray(flow.draft_payload.canceled_visit_ids) ? flow.draft_payload.canceled_visit_ids : [vid],
              cancellation_fee_by_visit: (flow.draft_payload.cancellation_fee_by_visit && typeof flow.draft_payload.cancellation_fee_by_visit === "object")
                ? flow.draft_payload.cancellation_fee_by_visit
                : { [vid]: Number(done?.cancellation_fee_amount || 0) || 0 },
            });
            return;
          }

          patch = {
            visit_id: vid,
            is_active: false,
            cancellation_fee_rate: Number(done.cancellation_fee_rate || pickedRate) || 0,
            cancellation_fee_amount: Number(done.cancellation_fee_amount || 0) || 0,
            billing_status: currentBillingStatus,
          };
          const toastMessage = done.square_action === "manual_refund_required"
            ? "キャンセルしました。Squareで返金処理を行ってください。"
            : (done.next_action === "create_cancellation_invoice"
              ? "キャンセルしました。キャンセル料の請求書作成が必要です。"
              : "キャンセル処理が完了しました。");
          toast({ title: "更新完了", message: toastMessage });
          if (syncErrors.length) {
            toast({ title: "カレンダー同期警告", message: "予約更新は完了しましたが、カレンダー同期に失敗しました。再実行してください。" });
          }
        } else {
          const flow = await runReactivateVisitFlow_(vid, idToken2, { source: "portal" });
          if (flow?.skipped) return;
          const done = flow?.done || {};
          const syncErrors = Array.isArray(done?.sync_errors) ? done.sync_errors : [];
          const uu = (done && done.updated && typeof done.updated === "object") ? done.updated : null;
          patch = Object.assign({}, patch, {
            billing_status: String(uu?.billing_status || "unbilled").trim() || "unbilled",
            cancellation_fee_rate: Math.max(0, Number(uu?.cancellation_fee_rate || 0) || 0),
            cancellation_fee_amount: Math.max(0, Number(uu?.cancellation_fee_amount || 0) || 0),
            latest_invoice_id: String(uu?.latest_invoice_id || ""),
            latest_invoice_line_id: String(uu?.latest_invoice_line_id || ""),
          });
          toast({ title: "更新完了", message: String(done?.message || "有効ステータスを更新しました。") });
          if (syncErrors.length) {
            toast({ title: "カレンダー同期警告", message: "再有効化は完了しましたが、カレンダー同期に失敗しました。再実行してください。" });
          }
        }

        const m = mergeVisitById(visitsAll, vid, patch);
        visitsAll = m.list;
        if (m.idx < 0) { await fetchAndRender_({ force: true }); return; }

        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (card) card.dataset.isActive = prevIsActive ? "1" : "0";
        actEl.textContent = prevText;
        actEl.classList.toggle("is-active", prevClasses.isActive);
        actEl.classList.toggle("badge-danger", prevClasses.badgeDanger);
        actEl.classList.toggle("is-inactive", prevClasses.isInactive);

        // state rollback（並び/フィルタの整合性のため）
        try {
          const m2 = mergeVisitById(visitsAll, vid, { visit_id: vid, is_active: prevIsActive });
          visitsAll = m2.list;
          saveCache_(cacheKey_(state), visitsAll);
          applyAndRender_();
        } catch (_) {}
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "change-billing-status") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      // 候補（API優先、失敗時fallback）
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK_ };
      const ordered = (opt && Array.isArray(opt.order) && opt.order.length) ? opt.order : Object.keys(map);

      const currentKey = String(card?.dataset?.billingStatus || "").trim() || "unbilled";
      const selectId = "mBillingStatusSelect";

      const optionsHtml = ordered.map(k => {
        const label = String(map[k] || billingStatusLabel_(k));
        const sel = (String(k) === String(currentKey)) ? " selected" : "";
        return `<option value="${escapeHtml(String(k))}"${sel}>${escapeHtml(label)}（${escapeHtml(String(k))}）</option>`;
      }).join("");

      const bodyHtml = `
        <div class="p" style="margin-bottom:8px;">請求ステータスを選択してください。</div>
        <select id="${escapeHtml(selectId)}" class="select" style="width:100%;">
          ${optionsHtml}
        </select>
        <div class="p" style="margin-top:8px; opacity:0.8;">
          現在：<strong>${escapeHtml(billingStatusLabel_(currentKey))}</strong>
        </div>
      `;

      const picked = await showSelectModal({
        title: "請求ステータス変更",
        bodyHtml,
        okText: "変更",
        cancelText: "キャンセル",
        selectId,
      });
      if (picked == null) return; // cancel

      const nextKey = String(picked || "").trim() || "unbilled";
      if (nextKey === currentKey) return; // 変更なし

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevKey = currentKey;

      // ===== Optimistic UI（即時反映）=====
      if (card) card.dataset.billingStatus = nextKey;
      actEl.textContent = billingStatusLabel_(nextKey);

      try {
        const up = await callUpdateVisitPolicy({
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { billing_status: nextKey },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        const patch = { visit_id: vid, billing_status: nextKey };
        const m = mergeVisitById(visitsAll, vid, patch);
        visitsAll = m.list;
        if (m.idx < 0) { await fetchAndRender_({ force: true }); return; }

        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        toast({ title: "更新完了", message: "請求ステータスを更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (card) card.dataset.billingStatus = prevKey;
        actEl.textContent = prevText;

        // state rollback
        try {
          const m2 = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: prevKey });
          visitsAll = m2.list;
          saveCache_(cacheKey_(state), visitsAll);
          applyAndRender_();
        } catch (_) {}
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "change-parking-fee-rule") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      const currentKey = String(card?.dataset?.parkingFeeRule || "").trim();
      const nextKey = await pickParkingFeeRule(currentKey, { title: "駐車料金区分変更", selectId: "mParkingFeeRuleSelect" });
      if (nextKey == null) return;
      if (nextKey === currentKey) return;

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevKey = currentKey;

      if (card) card.dataset.parkingFeeRule = nextKey;
      actEl.textContent = parkingFeeRuleLabel(nextKey);

      try {
        const up = await callUpdateVisitPolicy({
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { parking_fee_rule: nextKey },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        const patch = { visit_id: vid, parking_fee_rule: nextKey };
        const m = mergeVisitById(visitsAll, vid, patch);
        visitsAll = m.list;
        if (m.idx < 0) { await fetchAndRender_({ force: true }); return; }

        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        toast({ title: "更新完了", message: "駐車料金区分を更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (card) card.dataset.parkingFeeRule = prevKey;
        actEl.textContent = prevText;
        try {
          const m2 = mergeVisitById(visitsAll, vid, { visit_id: vid, parking_fee_rule: prevKey });
          visitsAll = m2.list;
          saveCache_(cacheKey_(state), visitsAll);
          applyAndRender_();
        } catch (_) {}
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "change-price-rule") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      actEl.dataset.busy = "1";

      const prevRuleId = String(card?.dataset?.priceRuleId || v?.price_rule_id || "").trim();
      const prevText = actEl.textContent;

      const titleEl = card?.querySelector(".card-sub div:nth-child(2)");
      const prevTitleText = titleEl ? titleEl.textContent : "";

      try {
        const normalizedStatus = normalizeBillingStatusForPriceRuleEdit_(card?.dataset?.billingStatus || v?.billing_status || "");
        if (normalizedStatus === "paid") {
          toast({ title: "変更不可", message: "支払済みの予約は訪問基本料金を変更できません。" });
          return;
        }
        if (normalizedStatus === "billed") {
          const ok = await showModal({
            title: "確認",
            bodyHtml: `<p class="p">この予約は請求作成済みです。訪問基本料金を変更すると請求書側の再調整が必要です。続行しますか？</p>`,
            okText: "続行",
            cancelText: "キャンセル"
          });
          if (!ok) return;
        }

        const chosen = await pickVisitBasePriceRuleShared_(idToken2, prevRuleId, { selectId: "visitBasePriceRuleSelect" });
        if (!chosen) return;
        const nextRuleId = String(chosen.price_rule_id || "").trim();
        if (!nextRuleId || nextRuleId === prevRuleId) return;

        if (card) card.dataset.priceRuleId = nextRuleId;
        actEl.textContent = String(chosen.label || nextRuleId);

        const up = await callUpdateVisitPolicy({
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { price_rule_id: nextRuleId },
        }, idToken2);
        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        const uu = (u && u.updated && typeof u.updated === "object") ? u.updated : u;
        if (uu?.title && titleEl) titleEl.textContent = String(uu.title);

        const patch = {
          visit_id: vid,
          price_rule_id: nextRuleId,
          price_rule_label: String(chosen.label || nextRuleId),
          ...(uu?.title ? { title: uu.title } : {}),
        };
        const m2 = mergeVisitById(visitsAll, vid, patch);
        visitsAll = m2.list;
        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        toast({ title: "更新完了", message: "訪問基本料金を更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (card) card.dataset.priceRuleId = prevRuleId;
        actEl.textContent = prevText;
        if (titleEl) titleEl.textContent = prevTitleText;
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "toggle-done") {
      // 二重送信防止（spanでも動くよう dataset で統一）
      if (actEl.dataset.busy === "1") return;

      const currentActive = (card?.dataset?.isActive === "1");
      if (!currentActive) {
        toast({ title: "更新不可", message: "削除済みの予約は完了状態を変更できません。" });
        return;
      }
      const currentDone = card?.dataset?.done === "1";
      const nextDone = !currentDone;

      // ===== 確認（キャンセル時は何もしない）=====
      const ok = await showModal({
        title: "確認",
        bodyHtml: `<p class="p">予約 <strong>${escapeHtml(vid)}</strong> を「${nextDone ? "完了" : "未完了"}」に変更します。よろしいですか？</p>`,
        okText: nextDone ? "完了にする" : "未完了に戻す",
        cancelText: "キャンセル",
        danger: false,
      });
      if (!ok) return;
      if (nextDone) {
        const canProceed = await confirmKeyLocationBeforeDone({ visitId: vid });
        if (!canProceed) return;
      }

      actEl.dataset.busy = "1";
      const prevDone = !!currentDone;
      const prevIsDoneText = actEl.textContent;
      const prevClasses = {
        badgeOk: actEl.classList.contains("badge-ok"),
        isDone: actEl.classList.contains("is-done"),
        isNotDone: actEl.classList.contains("is-not-done"),
      };

      try {
        // ===== Optimistic UI（即時反映）=====
        if (card) card.dataset.done = nextDone ? "1" : "0";
        actEl.textContent = nextDone ? "完了" : "未完了";
        actEl.classList.toggle("badge-ok", nextDone);
        actEl.classList.toggle("is-done", nextDone);
        actEl.classList.toggle("is-not-done", !nextDone);

        // ===== state も即時更新（並び替えに効かせる）=====
        const optimisticPatch = { visit_id: vid, is_done: nextDone, done: nextDone };
        const m0 = mergeVisitById(visitsAll, vid, optimisticPatch);
        visitsAll = m0.list;
        if (m0.idx < 0) { await fetchAndRender_({ force: true }); return; }
        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();

        // ===== サーバ更新（失敗したら rollback）=====
        const r = await updateVisitDone({ visitId: vid, nextDone });
        if (!r.ok) throw new Error(r.error || "更新に失敗しました。");

        // returned 差分があれば上書き（安全に吸収）
        const patch = {
          ...(r.returned && typeof r.returned === "object" ? r.returned : {}),
          visit_id: vid,
          is_done: nextDone,
          done: nextDone,
        };
        const m = mergeVisitById(visitsAll, vid, patch);
        visitsAll = m.list;
        if (m.idx < 0) { await fetchAndRender_({ force: true }); return; }
        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        toast({ title: "更新完了", message: `「${nextDone ? "完了" : "未完了"}」に更新しました。` });
      } catch (err) {
        // ===== rollback（DOM + state + cache）=====
        try {
          if (card) card.dataset.done = prevDone ? "1" : "0";
          actEl.textContent = prevIsDoneText;
          actEl.classList.toggle("badge-ok", prevClasses.badgeOk);
          actEl.classList.toggle("is-done", prevClasses.isDone);
          actEl.classList.toggle("is-not-done", prevClasses.isNotDone);
        } catch (_) {}

        try {
          const rollbackPatch = { visit_id: vid, is_done: prevDone, done: prevDone };
          const mr = mergeVisitById(visitsAll, vid, rollbackPatch);
          visitsAll = mr.list;
          saveCache_(cacheKey_(state), visitsAll);
          applyAndRender_();
        } catch (_) {}

        toast({
          title: "更新失敗",
          message: (err && err.message) ? err.message : String(err || ""),
        });
      } finally {
        actEl.dataset.busy = "0";
      }
    }
  });
}


