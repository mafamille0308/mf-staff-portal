// js/pages/visits_list.js
import { render, toast, escapeHtml, showModal, showSelectModal, showFormModal, fmt, displayOrDash, fmtDateTimeJst } from "../ui.js";
import { unwrapResults } from "../api.js";
import { getIdToken, getUser } from "../auth.js";
import { updateVisitDone } from "./visit_done_toggle.js";
import { parkingFeeRuleLabel, pickParkingFeeRule } from "./parking_fee_toggle.js";
import { confirmKeyLocationBeforeBulkDone, confirmKeyLocationBeforeDone } from "./visit_done_key_location.js";
import { callReassignVisitsPolicy, callUpdateVisitPolicy, fetchVisitDetailPolicy } from "./visits_policy.js";
import {
  portalVisitsList_,
  portalMeetingNotificationManualStatusUpdate_,
  portalCustomersPetNames_,
  portalLinkCustomerAssignment_,
  portalListCustomerAssignments_,
  portalSearchStaffs_,
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
  listBillingBatchesForVisit_ as listBillingBatches_,
  revertBillingBatchToUnbilledForVisit_ as revertBillingBatchToUnbilled_,
  getBillingBatchDetailForVisit_ as getBillingBatchDetail_,
  bulkUpdateVisitsForVisit_ as bulkUpdateVisits_,
} from "./visits_billing_policy.js";

// ===== sessionStorage keys =====
const KEY_VF_STATE = "mf:visits_list:state:v1";
const KEY_VF_CACHE = "mf:visits_list:cache:v2";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善目的）
const PAID_CANCEL_CACHE_TTL_MS = 15 * 1000; // 返金追従を優先

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
  return `${String(state.date_from || "")}__${String(state.date_to_ymd || "")}__${String(state.staff_filter || "")}`;
}

function hasPaidCancelledVisit_(visits) {
  return Array.isArray(visits) && visits.some((v) =>
    normalizeCancelBillingStatus_(v?.billing_status) === "paid" && v?.is_active === false
  );
}

function loadCache_(key) {
  const obj = safeParseJson_(sessionStorage.getItem(KEY_VF_CACHE));
  if (!obj || typeof obj !== "object") return null;
  if (obj.key !== key) return null;
  if (!Array.isArray(obj.visits)) return null;
  const ttlMs = hasPaidCancelledVisit_(obj.visits) ? PAID_CANCEL_CACHE_TTL_MS : CACHE_TTL_MS;
  if (!obj.ts || (Date.now() - Number(obj.ts)) > ttlMs) return null;
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

function toStaffLabel_(row) {
  const id = String((row && (row.staff_id || row.id)) || "").trim();
  const name = String((row && row.name) || "").trim();
  return name ? `${name} (${id})` : id;
}

function updateVisitsHashStaffId_(staffId) {
  const hashRaw = String(location.hash || "#/visits");
  const [pathRaw, queryRaw = ""] = hashRaw.replace(/^#/, "").split("?");
  const path = pathRaw || "/visits";
  const q = new URLSearchParams(queryRaw || "");
  const sid = String(staffId || "").trim();
  if (sid) q.set("staff_id", sid);
  else q.delete("staff_id");
  const next = `#${path}${q.toString() ? `?${q.toString()}` : ""}`;
  if (next !== hashRaw) {
    location.hash = next;
    return true;
  }
  return false;
}

function normalizeBillingBatchTypeKey_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "cancellation" || s === "cancellation_only") return "cancellation_only";
  if (s === "invoice_with_cancellation") return "invoice_with_cancellation";
  return "invoice";
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

function filterBillingStatusOptionsByRole_(ordered, map, isAdmin) {
  const orderList = Array.isArray(ordered) ? ordered : [];
  return orderList.filter((k) => {
    const key = String(k || "").trim();
    if (!key) return false;
    if (key === "no_billing_required" && !isAdmin) return false;
    return Object.prototype.hasOwnProperty.call(map || {}, key);
  });
}

async function showCancelAdminOnlyModal_() {
  await showModal({
    title: "管理者操作",
    bodyHtml: `<p class="p">キャンセル操作は管理者に依頼してください。</p>`,
    okText: "閉じる",
    cancelText: null,
  });
}

function amountText_(n, options = {}) {
  const v = Math.max(0, Number(n || 0) || 0);
  if (v > 0) return `${formatMoney_(v)}円`;
  // zero円が正しい選択値の場合のみ 0円 表示を許可する
  // （駐車/出張/繁忙期など未設定扱いにしたい項目には適用しない）
  if (options?.zero_as_amount === true) return "0円";
  return "未設定";
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
  const matchLabel_ = (row, keyword) => String(row?.label || "").includes(keyword);
  const overtimeOptions = list
    .filter((r) => r?.is_active !== false)
    .filter((r) => {
      const t = String(r?.item_type || "").trim();
      return t === "overtime_fee" || (t === "merchandise" && matchLabel_(r, "延長"));
    })
    .sort((a, b) => (Number(a?.display_order || 0) || 0) - (Number(b?.display_order || 0) || 0))
    .map((r) => {
      const rid = String(r?.price_rule_id || "").trim();
      const label = String(r?.label || rid).trim() || rid;
      const amount = Math.max(0, Number(r?.amount || 0) || 0);
      const displayOrder = Number(r?.display_order || 0) || 0;
      return { price_rule_id: rid, label, amount, display_order: displayOrder };
    });
  const reimbursementOptions = list
    .filter((r) => r?.is_active !== false)
    .filter((r) => {
      const t = String(r?.item_type || "").trim();
      return t === "reimbursement" || (t === "merchandise" && matchLabel_(r, "立替"));
    })
    .sort((a, b) => (Number(a?.display_order || 0) || 0) - (Number(b?.display_order || 0) || 0))
    .map((r) => {
      const rid = String(r?.price_rule_id || "").trim();
      const label = String(r?.label || rid).trim() || rid;
      const amount = Math.max(0, Number(r?.amount || 0) || 0);
      const displayOrder = Number(r?.display_order || 0) || 0;
      return { price_rule_id: rid, label, amount, display_order: displayOrder };
    });
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
    overtime_options: overtimeOptions,
    reimbursement_options: reimbursementOptions,
    visit_base_rules: visitBaseRules,
  };
}

function resolveVisitBaseAmount_(visit, feeContext) {
  const v = visit || {};
  const rules = Array.isArray(feeContext?.visit_base_rules) ? feeContext.visit_base_rules : [];
  const baseRuleId = String(v?.price_rule_id || "").trim();
  const byRuleId = rules.find((r) => String(r?.price_rule_id || "").trim() === baseRuleId);
  if (byRuleId) {
    const n = Number(byRuleId?.amount || 0) || 0;
    if (n >= 0) return Math.max(0, n);
  }
  const direct = Math.max(0, Number(v?.base_fee_amount || 0) || 0);
  if (direct > 0) return direct;
  if (baseRuleId) return 0;
  const product = String(v?.product_name || v?.service_name || "").trim();
  const variant = String(v?.variant_name || "").trim();
  const duration = Number(v?.duration_minutes || 0) || 0;
  if (product && variant) {
    const hitByLabel = rules.find((r) => {
      const rp = String(r?.product_name || "").trim();
      const rv = String(r?.variant_name || "").trim();
      return rp === product && rv === variant;
    });
    if (hitByLabel) return Math.max(0, Number(hitByLabel?.amount || 0) || 0);
    return 0;
  }
  if (!product && !variant && duration > 0) {
    const byDuration = rules.filter((r) => (Number(r?.duration_minutes || 0) || 0) === duration);
    if (byDuration.length === 1) return Math.max(0, Number(byDuration[0]?.amount || 0) || 0);
  }
  return 0;
}

function resolveVisitServiceLabel_(visit, feeContext) {
  const v = visit || {};
  const explicitLabel = String(v?.price_rule_label || "").trim();
  if (explicitLabel) return explicitLabel;
  const product = String(v?.product_name || "").trim();
  const variant = String(v?.variant_name || "").trim();
  const direct = [product, variant].filter(Boolean).join(" ").trim();
  const rules = Array.isArray(feeContext?.visit_base_rules) ? feeContext.visit_base_rules : [];
  const byRuleId = rules.find((r) => String(r?.price_rule_id || "").trim() === String(v?.price_rule_id || "").trim());
  if (byRuleId) {
    const fallback = String(byRuleId?.label || "").trim();
    if (fallback) return fallback;
    const rp = String(byRuleId?.product_name || "").trim();
    const rv = String(byRuleId?.variant_name || "").trim();
    const fromRule = [rp, rv].filter(Boolean).join(" ").trim();
    if (fromRule) return fromRule;
  }
  if (direct) return direct;
  const serviceName = String(v?.service_name || "").trim();
  if (serviceName && serviceName !== "訪問サービス") return serviceName;
  return "商品未設定";
}

function selectedVisits_(visitsAll, ids) {
  const set = new Set((ids || []).map(x => String(x || "").trim()).filter(Boolean));
  return (visitsAll || []).filter(v => set.has(String(v?.visit_id || "").trim()));
}

function withCustomerHonorific_(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  if (s.endsWith("様")) return s;
  return `${s} 様`;
}

function renderPetsBadges_(petNames) {
  const pets = Array.isArray(petNames) ? petNames : [];
  if (!pets.length) return `<div class="p text-sm">ペット：—</div>`;
  return `<div class="badges">${pets.map((name) => `<span class="badge">${escapeHtml(fmt(name))}</span>`).join("")}</div>`;
}

function buildInvoicePreviewHtml_(preview, selected) {
  const p = preview || {};
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const totals = p.totals || {};
  const customer = p.customer || {};
  const selectedCount = Array.isArray(selected) ? selected.length : 0;
  return `
    <div class="p mb-8">
      顧客：<strong>${escapeHtml(String(customer.customer_name || "-"))}</strong><br/>
      請求先メール：${escapeHtml(String(customer.billing_email || "-"))}<br/>
      対象予約：<strong>${escapeHtml(String(selectedCount))}件</strong>
    </div>
    <div class="card card-scroll-280">
      <div class="p">
        ${lines.map(line => `
          <div class="row row-between row-top-start-lg">
            <div>
              <div><strong>${escapeHtml(String(line.label || line.line_type || ""))}</strong>${line.line_type === "additional_fee" ? ` <span class="badge">追加料金</span>` : ``}${line.line_type === "merchandise" ? ` <span class="badge">一般商品</span>` : ``}</div>
              <div class="opacity-8">${escapeHtml(String(line.description || line.visit_date || ""))}</div>
            </div>
            <div class="nowrap">${escapeHtml(formatMoney_(line.amount))}円</div>
          </div>
        `).join("") || `<div>明細がありません。</div>`}
      </div>
    </div>
    <div class="p mt-10">
      小計：<strong>${escapeHtml(formatMoney_(totals.subtotal_amount))}円</strong><br/>
      追加料金：${escapeHtml(formatMoney_(totals.additional_fee_total))}円<br/>
      鍵料金：${escapeHtml(formatMoney_(totals.key_fee_total))}円<br/>
      調整：${escapeHtml(formatMoney_(totals.adjustment_total))}円<br/>
      合計：<strong>${escapeHtml(formatMoney_(totals.grand_total))}円</strong>
    </div>
    <div class="p mt-8 opacity-8">
      作成すると選択した予約の請求ステータスは「請求ドラフト」に更新されます。
    </div>
  `;
}

function buildInvoiceDraftFormHtml_(additionalFeeRules, merchandiseRules) {
  const additionalRules = Array.isArray(additionalFeeRules) ? additionalFeeRules : [];
  const merchandiseList = Array.isArray(merchandiseRules) ? merchandiseRules : [];
  return `
    <form data-el="invoiceDraftForm">
      <div class="p mb-8">今回の請求ドラフトにだけ適用する上書きです。未指定なら顧客既定値を使います。</div>
      <div class="mb-10">
        <div class="label-strong"><strong>鍵預かり料金区分</strong></div>
        <select class="input" name="key_pickup_fee_rule">
          <option value="">顧客既定値を使う</option>
          <option value="free">無料</option>
          <option value="paid">有料</option>
        </select>
      </div>
      <div class="mb-10">
        <div class="label-strong"><strong>鍵返却料金区分</strong></div>
        <select class="input" name="key_return_fee_rule">
          <option value="">顧客既定値を使う</option>
          <option value="free">無料</option>
          <option value="paid">有料</option>
        </select>
      </div>
      <div>
        <div class="label-strong"><strong>割引額</strong></div>
        <input class="input" type="number" name="discount_amount" min="0" step="1" inputmode="numeric" placeholder="例：500" />
        <div class="p mt-6 opacity-8">入力時は固定額の値引きとして適用します。</div>
      </div>
      ${additionalRules.length ? `
      <div class="mt-12">
        <div class="label-strong mb-6"><strong>追加料金</strong></div>
        <div class="p mb-6 opacity-8">必要な商品だけ選択してください。金額は空欄なら商品マスタの金額を使います。</div>
        <div class="grid-8">
          ${additionalRules.map((rule) => {
            const rid = String(rule.price_rule_id || "").trim();
            return `
              <label class="card grid-6">
                <div class="row gap-8">
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
      <div class="mt-12">
        <div class="label-strong mb-6"><strong>一般商品</strong></div>
        <div class="p mb-6 opacity-8">予約に紐づかない請求明細を追加します。金額は空欄なら商品マスタの金額を使います。</div>
        <div class="grid-8">
          ${merchandiseList.map((rule) => {
            const rid = String(rule.price_rule_id || "").trim();
            return `
              <label class="card grid-6">
                <div class="row gap-8">
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
  const adjustmentMode = options?.adjustment_mode === true;
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
  const overtimeOptions = Array.isArray(fd.overtime_options) ? fd.overtime_options : [];
  const reimbursementOptions = Array.isArray(fd.reimbursement_options) ? fd.reimbursement_options : [];
  const legacyMode = options?.legacy_mode === true;
  const legacyBuckets = buildLegacyMerchandiseBuckets_(merchandiseOptions);
  const legacyHeadcountOptions = legacyBuckets.headcount;
  const legacyTravelOptions = legacyBuckets.travel;
  const legacyToppingOptions = legacyBuckets.topping;
  const keyPickupOptions = Array.isArray(fd.key_pickup_options) ? fd.key_pickup_options : [];
  const keyReturnOptions = Array.isArray(fd.key_return_options) ? fd.key_return_options : [];
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
  registerDisplayOrder_(overtimeOptions);
  registerDisplayOrder_(reimbursementOptions);
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
      const basePriceRuleId = String(v?.price_rule_id || "").trim();
      const base = resolveVisitBaseAmount_(v, fd);
      const travelRaw = cancellationMode
        ? 0
        : adjustmentMode
          ? 0
          : Math.max(0, Number(cd?.travel_fee_amount || 0) || 0);
      const seasonalRaw = adjustmentMode ? 0 : (Number(v?.seasonal_fee_amount || 0) || 0);
      const parkingRaw = cancellationMode
        ? 0
        : adjustmentMode
          ? 0
          : Math.max(0, Number(cd?.parking_fee_amount || 0) || 0);
      const travelRuleId = findRuleForAmount_(travelOptions, travelRaw);
      const seasonalRuleId = findRuleForAmount_(seasonalOptions, seasonalRaw);
      const parkingRuleId = findRuleForAmount_(parkingOptions, parkingRaw) || String(parkingOptions[0]?.price_rule_id || "").trim();
      const parking = parkingRaw;
      const travelAmount = parseOptionAmount_(`${travelRuleId}|${travelRaw}`);
      const seasonalAmount = parseOptionAmount_(`${seasonalRuleId}|${seasonalRaw}`);
      const rowSubtotal = adjustmentMode
        ? Math.max(0, parking)
        : Math.max(0, base + parking + travelAmount + seasonalAmount);
      const hasBaseSelection = !!basePriceRuleId;
      const overtimeDefaultLabel = String(overtimeOptions[0]?.label || "延長料金").trim() || "延長料金";
      const overtimeDefaultRuleId = String(overtimeOptions[0]?.price_rule_id || "").trim();
      const reimbursementDefaultLabel = String(reimbursementOptions[0]?.label || "立替金").trim() || "立替金";
      const reimbursementDefaultRuleId = String(reimbursementOptions[0]?.price_rule_id || "").trim();
      return `
        <details class="details-compact">
          <summary class="summary-lite">
            <span class="summary-line">
              <span class="fw-600">${escapeHtml(title)}</span>
              <span class="summary-amount" data-el="subtotal_${escapeHtml(vid)}">${escapeHtml(rowSubtotal > 0 ? `${formatMoney_(rowSubtotal)}円` : (hasBaseSelection ? "0円" : "未設定"))}</span>
            </span>
          </summary>
          <div class="section-grid-pl2">
            ${adjustmentMode ? `` : `
            <button type="button" data-edit="base" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ ${escapeHtml(productLabel)}</span>
              <strong data-el="base_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(base, { zero_as_amount: hasBaseSelection }))}</strong>
            </button>
            `}
            <input type="hidden" name="base_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(adjustmentMode ? 0 : base))}" />
            <input type="hidden" name="base_fee_label_${escapeHtml(vid)}" value="${escapeHtml(productLabel)}" />
            <input type="hidden" name="base_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(adjustmentMode ? "" : basePriceRuleId)}" />

            <button type="button" data-edit="parking" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 駐車料金</span>
              <strong data-el="parking_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(parking))}</strong>
            </button>
            <input type="hidden" name="parking_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(parking))}" />
            <input type="hidden" name="parking_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(parkingRuleId)}" />

            ${adjustmentMode ? `` : `
            <button type="button" data-edit="travel" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 出張料金</span>
              <strong data-el="travel_amount_${escapeHtml(vid)}">${travelAmount > 0 ? `${escapeHtml(formatMoney_(travelAmount))}円` : "未選択"}</strong>
            </button>
            `}
            <input type="hidden" name="travel_option_${escapeHtml(vid)}" value="${escapeHtml(adjustmentMode ? "" : (travelRuleId && travelRaw > 0 ? `${travelRuleId}|${travelRaw}` : ""))}" />

            ${adjustmentMode ? `` : `
            <button type="button" data-edit="seasonal" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 繁忙期加算</span>
              <strong data-el="seasonal_amount_${escapeHtml(vid)}">${seasonalAmount > 0 ? `${escapeHtml(formatMoney_(seasonalAmount))}円` : "未選択"}</strong>
            </button>
            `}
            <input type="hidden" name="seasonal_option_${escapeHtml(vid)}" value="${escapeHtml(adjustmentMode ? "" : (seasonalRuleId && seasonalRaw > 0 ? `${seasonalRuleId}|${seasonalRaw}` : ""))}" />

            ${adjustmentMode ? `
            <button type="button" data-edit="adjustment_overtime" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 延長料金</span>
              <strong data-el="adjustment_overtime_${escapeHtml(vid)}">未設定</strong>
            </button>
            <button type="button" data-edit="adjustment_reimbursement" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 立替金</span>
              <strong data-el="adjustment_reimbursement_${escapeHtml(vid)}">未設定</strong>
            </button>
            ` : (cancellationMode ? `` : (legacyMode ? `
            <button type="button" data-edit="legacy_headcount" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 頭数追加</span>
              <strong data-el="legacy_headcount_${escapeHtml(vid)}">未設定</strong>
            </button>
            <button type="button" data-edit="legacy_travel" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 交通費（往復）</span>
              <strong data-el="legacy_travel_${escapeHtml(vid)}">未設定</strong>
            </button>
            <button type="button" data-edit="legacy_topping" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ トッピング（遊び / ケア）</span>
              <strong data-el="legacy_topping_${escapeHtml(vid)}">未設定</strong>
            </button>
            ` : `
            <button type="button" data-edit="extra" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>➕ 商品追加</span>
              <strong data-el="extra_label_${escapeHtml(vid)}">未設定</strong>
            </button>
            `))}
            <input type="hidden" name="extra_label_${escapeHtml(vid)}" value="" />
            <input type="hidden" name="extra_qty_${escapeHtml(vid)}" value="1" />
            <input type="hidden" name="extra_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="extra_price_rule_id_${escapeHtml(vid)}" value="" />
            <input type="hidden" name="adjustment_overtime_label_${escapeHtml(vid)}" value="${escapeHtml(overtimeDefaultLabel)}" />
            <input type="hidden" name="adjustment_overtime_qty_${escapeHtml(vid)}" value="1" />
            <input type="hidden" name="adjustment_overtime_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="adjustment_overtime_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(overtimeDefaultRuleId)}" />
            <input type="hidden" name="adjustment_reimbursement_label_${escapeHtml(vid)}" value="${escapeHtml(reimbursementDefaultLabel)}" />
            <input type="hidden" name="adjustment_reimbursement_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="adjustment_reimbursement_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(reimbursementDefaultRuleId)}" />
            <input type="hidden" name="legacy_headcount_label_${escapeHtml(vid)}" value="" />
            <input type="hidden" name="legacy_headcount_qty_${escapeHtml(vid)}" value="1" />
            <input type="hidden" name="legacy_headcount_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="legacy_headcount_price_rule_id_${escapeHtml(vid)}" value="" />
            <input type="hidden" name="legacy_travel_label_${escapeHtml(vid)}" value="${escapeHtml(String(legacyTravelOptions[0]?.label || "交通費（往復）"))}" />
            <input type="hidden" name="legacy_travel_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="legacy_travel_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(String(legacyTravelOptions[0]?.price_rule_id || ""))}" />
            <input type="hidden" name="legacy_topping_label_${escapeHtml(vid)}" value="" />
            <input type="hidden" name="legacy_topping_qty_${escapeHtml(vid)}" value="1" />
            <input type="hidden" name="legacy_topping_amount_${escapeHtml(vid)}" value="0" />
            <input type="hidden" name="legacy_topping_price_rule_id_${escapeHtml(vid)}" value="" />
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
      const hasResidualBaseSelection = !!basePriceRuleId;
      return `
        <details class="details-compact">
          <summary class="summary-lite">
            <span class="summary-line">
              <span class="fw-600">${escapeHtml(title)}</span>
              <span class="summary-amount" data-el="residual_subtotal_${escapeHtml(vid)}">${escapeHtml(sectionSubtotal > 0 ? `${formatMoney_(sectionSubtotal)}円` : (hasResidualBaseSelection ? "0円" : "未設定"))}</span>
            </span>
          </summary>
          <div class="section-grid-pl2">
            <button type="button" data-edit="residual_base" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ <span data-el="residual_base_label_${escapeHtml(vid)}">${escapeHtml(baseLabel)}</span></span>
              <strong data-el="residual_base_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(baseAmount, { zero_as_amount: hasResidualBaseSelection }))}</strong>
            </button>
            <input type="hidden" name="residual_visit_id_${escapeHtml(vid)}" value="${escapeHtml(vid)}" />
            <input type="hidden" name="residual_base_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(baseAmount))}" />
            <input type="hidden" name="residual_base_fee_label_${escapeHtml(vid)}" value="${escapeHtml(baseLabel)}" />
            <input type="hidden" name="residual_base_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(basePriceRuleId)}" />

            <button type="button" data-edit="residual_parking" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 駐車料金</span>
              <strong data-el="residual_parking_amount_${escapeHtml(vid)}">${escapeHtml(amountText_(parkingAmount))}</strong>
            </button>
            <input type="hidden" name="residual_parking_fee_amount_${escapeHtml(vid)}" value="${escapeHtml(String(parkingAmount))}" />
            <input type="hidden" name="residual_parking_price_rule_id_${escapeHtml(vid)}" value="${escapeHtml(parkingPriceRuleId)}" />

            <button type="button" data-edit="residual_travel" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
              <span>🔄️ 出張料金</span>
              <strong data-el="residual_travel_amount_${escapeHtml(vid)}">${travelAmount > 0 ? `${escapeHtml(formatMoney_(travelAmount))}円` : "未選択"}</strong>
            </button>
            <input type="hidden" name="residual_travel_option_${escapeHtml(vid)}" value="${escapeHtml(travelOption)}" />

            <button type="button" data-edit="residual_seasonal" data-visit-id="${escapeHtml(vid)}" class="fee-edit-btn">
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
  const discountDefaultRuleId = String(discountOptions[0]?.price_rule_id || "").trim();
  const summaryBase = list.reduce((acc, v) => {
    if (adjustmentMode) return acc;
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
      <div class="scroll-70vh">
        <div class="mb-10"><strong>対象予約: ${escapeHtml(String(targetVisitCount))}件</strong></div>
        <div class="mb-10">${rowsHtml}${residualRowsHtml}</div>
      <div class="grid-8 mb-12">
        <button type="button" data-edit="key_pickup" class="fee-edit-btn">
          <span>🔄️ 鍵預かり料金</span>
          <strong data-el="key_pickup_amount">${escapeHtml(amountText_(keyPickupDefault))}</strong>
        </button>
        <button type="button" data-edit="key_return" class="fee-edit-btn">
          <span>🔄️ 鍵返却料金</span>
          <strong data-el="key_return_amount">${escapeHtml(amountText_(keyReturnDefault))}</strong>
        </button>
        <input type="hidden" name="key_pickup_fee_amount" value="${escapeHtml(String(keyPickupDefault))}" />
        <input type="hidden" name="key_return_fee_amount" value="${escapeHtml(String(keyReturnDefault))}" />
        <input type="hidden" name="key_pickup_price_rule_id" value="${escapeHtml(keyPickupDefaultRuleId)}" />
        <input type="hidden" name="key_return_price_rule_id" value="${escapeHtml(keyReturnDefaultRuleId)}" />
      </div>
      ${adjustmentMode ? `` : `<div class="mb-12">
        <button type="button" data-edit="discount" class="fee-edit-btn">
          <span>🔄️ 割引</span>
          <strong data-el="discount_amount">未設定</strong>
        </button>
        <input type="hidden" name="discount_label" value="割引" />
        <input type="hidden" name="discount_amount" value="0" />
        <input type="hidden" name="discount_price_rule_id" value="${escapeHtml(discountDefaultRuleId)}" />
      </div>`}
      <div class="mb-12">
        <div><strong>${cancellationMode ? "キャンセル料明細" : "明細"}</strong></div>
        <div class="row row-between mt-6">
          <span>請求総額</span><strong class="text-right" data-el="summary_total">${escapeHtml(formatMoney_(defaultTotal))}円</strong>
        </div>
        <div class="summary-lines" data-el="summary_lines">
          ${summaryLines.map((x) => {
            const rowText = `${x.label} ×${x.qty}`;
            return `<div class="row row-between"><span>${escapeHtml(rowText)}</span><span class="text-right minw-90">${escapeHtml(formatMoney_(x.amount))}円</span></div>`;
          }).join("") || `<div>-</div>`}
        </div>
      </div>
      <div>
        <div class="label-strong"><strong>メモ</strong></div>
        <textarea class="input" name="memo" rows="4" placeholder="備考（任意）"></textarea>
      </div>
      <input type="hidden" name="cancellation_rate" value="${escapeHtml(String(cancellationRate))}" />
      <input type="hidden" name="billing_mode" value="${escapeHtml(adjustmentMode ? "adjustment" : "standard")}" />
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

function normalizeLegacyLabelKey_(value) {
  return String(value || "").trim().replace(/\s+/g, "").replace(/／/g, "/").toLowerCase();
}

function isLegacyHeadcountLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("頭数追加");
}

function isLegacyTravelLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("交通費");
}

function isLegacyToppingLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("遊び/ケア");
}

function buildLegacyMerchandiseBuckets_(options) {
  const rows = Array.isArray(options) ? options : [];
  return {
    headcount: rows.filter((x) => isLegacyHeadcountLabel_(x && x.label)),
    travel: rows.filter((x) => isLegacyTravelLabel_(x && x.label)),
    topping: rows.filter((x) => isLegacyToppingLabel_(x && x.label)),
  };
}

function isLegacyModeForVisits_(selected, cutoffYmd = "2026-05-31") {
  const cutoff = String(cutoffYmd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return false;
  const list = Array.isArray(selected) ? selected : [];
  return list.some((v) => {
    const ms = Date.parse(String(v?.start_time || "").trim());
    if (Number.isNaN(ms)) return false;
    const ymd = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms)).replace(/\//g, "-");
    return ymd <= cutoff;
  });
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
  const overtimeOptions = Array.isArray(fd.overtime_options) ? fd.overtime_options : [];
  const reimbursementOptions = Array.isArray(fd.reimbursement_options) ? fd.reimbursement_options : [];
  const adjustmentMode = options?.adjustment_mode === true;
  const legacyMode = options?.legacy_mode === true;
  const legacyBuckets = buildLegacyMerchandiseBuckets_(merchandiseOptions);
  const legacyHeadcountOptions = legacyBuckets.headcount;
  const legacyTravelOptions = legacyBuckets.travel;
  const legacyToppingOptions = legacyBuckets.topping;
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
  registerDisplayOrder_(overtimeOptions);
  registerDisplayOrder_(reimbursementOptions);
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
      <div class="editor-modal-card">
        <div class="editor-modal-title">${escapeHtml(title || "")}</div>
        <div class="editor-modal-body">${bodyHtml || ""}</div>
        <div class="editor-modal-actions">
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
        <div class="row gap-8">
          <input
            class="input text-right"
            data-el="num"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            placeholder="金額を入力"
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
      <select class="select w-100" data-el="opt">
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
      <div class="grid-8">
        <div>
          <div class="label-strong">商品</div>
          <select class="select w-100" data-el="opt">
            ${merchandiseOptions.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}">${escapeHtml(String(o.label || ""))} (${escapeHtml(formatMoney_(o.amount))}円)</option>`).join("")}
          </select>
        </div>
        <div>
          <div class="label-strong">数量</div>
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
  const pickScopedMerchandiseByModal_ = async (title, scopedOptions, qtyCur = 1) => {
    if (!scopedOptions.length) {
      window.alert("選択肢がありません。設定画面で旧料金商品を登録してください。");
      return null;
    }
    const html = `
      <div class="grid-8">
        <div>
          <div class="label-strong">商品</div>
          <select class="select w-100" data-el="opt">
            ${scopedOptions.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}">${escapeHtml(String(o.label || ""))} (${escapeHtml(formatMoney_(o.amount))}円)</option>`).join("")}
          </select>
        </div>
        <div>
          <div class="label-strong">数量</div>
          <input class="input" data-el="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(String(qtyCur))}" />
        </div>
      </div>
    `;
    return openEditor_({
      title,
      bodyHtml: html,
      onSubmit: (root) => {
        const rid = String(root.querySelector('[data-el="opt"]')?.value || "").trim();
        const qty = Math.max(1, Number(root.querySelector('[data-el="qty"]')?.value || 1) || 1);
        const chosen = scopedOptions.find((o) => String(o?.price_rule_id || "").trim() === rid);
        if (!chosen) return null;
        return {
          price_rule_id: rid,
          label: String(chosen.label || "").trim(),
          amount: Math.max(0, Number(chosen.amount || 0) || 0),
          qty
        };
      }
    });
  };

  const pickRuleOptionByModal_ = async (title, options) => {
    if (!options.length) {
      window.alert("選択肢がありません。設定画面で料金マスタを作成してください。");
      return null;
    }
    const html = `
      <select class="select w-100" data-el="opt">
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
    const addLine_ = (label, amount, quantity = 1, priceRuleId = "", options = {}) => {
      const q = Math.max(0, Number(quantity || 0) || 0);
      const a = Math.max(0, Number(amount || 0) || 0);
      if (!(q > 0)) return;
      const includeZero = options?.include_zero === true;
      if (!(a > 0) && !includeZero) return;
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
      const adjustmentOvertimeQty = Math.max(1, Number(host.querySelector(`[name="adjustment_overtime_qty_${vid}"]`)?.value || 1) || 1);
      const adjustmentOvertimeAmount = Math.max(0, Number(host.querySelector(`[name="adjustment_overtime_amount_${vid}"]`)?.value || 0) || 0);
      const adjustmentOvertimeLabel = String(host.querySelector(`[name="adjustment_overtime_label_${vid}"]`)?.value || "").trim() || "延長料金";
      const adjustmentReimbursementAmount = Math.max(0, Number(host.querySelector(`[name="adjustment_reimbursement_amount_${vid}"]`)?.value || 0) || 0);
      const adjustmentReimbursementLabel = String(host.querySelector(`[name="adjustment_reimbursement_label_${vid}"]`)?.value || "").trim() || "立替金";
      const legacyHeadcountQty = Math.max(1, Number(host.querySelector(`[name="legacy_headcount_qty_${vid}"]`)?.value || 1) || 1);
      const legacyHeadcountAmount = Math.max(0, Number(host.querySelector(`[name="legacy_headcount_amount_${vid}"]`)?.value || 0) || 0);
      const legacyHeadcountLabel = String(host.querySelector(`[name="legacy_headcount_label_${vid}"]`)?.value || "").trim();
      const legacyTravelAmount = Math.max(0, Number(host.querySelector(`[name="legacy_travel_amount_${vid}"]`)?.value || 0) || 0);
      const legacyTravelLabel = String(host.querySelector(`[name="legacy_travel_label_${vid}"]`)?.value || "").trim() || "交通費（往復）";
      const legacyToppingQty = Math.max(1, Number(host.querySelector(`[name="legacy_topping_qty_${vid}"]`)?.value || 1) || 1);
      const legacyToppingAmount = Math.max(0, Number(host.querySelector(`[name="legacy_topping_amount_${vid}"]`)?.value || 0) || 0);
      const legacyToppingLabel = String(host.querySelector(`[name="legacy_topping_label_${vid}"]`)?.value || "").trim();
      const rateFactor = cancellationMode ? (cancellationRate / 100) : 1;
      const subtotal = cancellationMode
        ? Math.max(0, Math.round((base + parking + travel + seasonal) * rateFactor * 100) / 100)
        : adjustmentMode
          ? (parking + (adjustmentOvertimeQty * adjustmentOvertimeAmount) + adjustmentReimbursementAmount)
          : (base + parking + travel + seasonal
          + (extraQty * extraAmount)
          + (legacyHeadcountQty * legacyHeadcountAmount)
          + legacyTravelAmount
          + (legacyToppingQty * legacyToppingAmount));
      const target = base + parking + travel + seasonal;
      const subtotalEl = host.querySelector(`[data-el="subtotal_${vid}"]`);
      const basePriceRuleId = String(host.querySelector(`[name="base_price_rule_id_${vid}"]`)?.value || "").trim();
      const hasBaseSelection = !!basePriceRuleId;
      if (subtotalEl) subtotalEl.textContent = subtotal > 0 ? `${formatMoney_(subtotal)}円` : (hasBaseSelection ? "0円" : "未設定");
      grand += subtotal;
      targetSubtotal += target;

      const parkingRuleId = resolveParkingRuleId_(vid, parking);
      const travelRuleId = parseOptionRuleIdLocal_(host.querySelector(`[name="travel_option_${vid}"]`)?.value || "");
      const seasonalRuleId = parseOptionRuleIdLocal_(host.querySelector(`[name="seasonal_option_${vid}"]`)?.value || "");
      const extraPriceRuleId = String(host.querySelector(`[name="extra_price_rule_id_${vid}"]`)?.value || "").trim();
      const legacyHeadcountRuleId = String(host.querySelector(`[name="legacy_headcount_price_rule_id_${vid}"]`)?.value || "").trim();
      const legacyTravelRuleId = String(host.querySelector(`[name="legacy_travel_price_rule_id_${vid}"]`)?.value || "").trim();
      const legacyToppingRuleId = String(host.querySelector(`[name="legacy_topping_price_rule_id_${vid}"]`)?.value || "").trim();
      const adjustmentOvertimeRuleId = String(host.querySelector(`[name="adjustment_overtime_price_rule_id_${vid}"]`)?.value || "").trim();
      const adjustmentReimbursementRuleId = String(host.querySelector(`[name="adjustment_reimbursement_price_rule_id_${vid}"]`)?.value || "").trim();
      if (!useCancellationPreset) {
        addLine_(
          productLabel,
          cancellationMode ? Math.max(0, Math.round(base * rateFactor * 100) / 100) : base,
          1,
          basePriceRuleId,
          { include_zero: hasBaseSelection }
        );
        addLine_("駐車料金", cancellationMode ? Math.max(0, Math.round(parking * rateFactor * 100) / 100) : parking, 1, parkingRuleId);
        addLine_("出張料金", cancellationMode ? Math.max(0, Math.round(travel * rateFactor * 100) / 100) : travel, 1, travelRuleId);
        addLine_("繁忙期加算", cancellationMode ? Math.max(0, Math.round(seasonal * rateFactor * 100) / 100) : seasonal, 1, seasonalRuleId);
      }
      if (!cancellationMode && extraLabel && extraAmount > 0) addLine_(extraLabel, extraQty * extraAmount, extraQty, extraPriceRuleId);
      if (!cancellationMode && adjustmentMode && adjustmentOvertimeLabel && adjustmentOvertimeAmount > 0) {
        addLine_(adjustmentOvertimeLabel, adjustmentOvertimeQty * adjustmentOvertimeAmount, adjustmentOvertimeQty, adjustmentOvertimeRuleId);
      }
      if (!cancellationMode && adjustmentMode && adjustmentReimbursementLabel && adjustmentReimbursementAmount > 0) {
        addLine_(adjustmentReimbursementLabel, adjustmentReimbursementAmount, 1, adjustmentReimbursementRuleId);
      }
      if (!cancellationMode && legacyMode && legacyHeadcountLabel && legacyHeadcountAmount > 0) {
        addLine_(legacyHeadcountLabel, legacyHeadcountQty * legacyHeadcountAmount, legacyHeadcountQty, legacyHeadcountRuleId);
      }
      if (!cancellationMode && legacyMode && legacyTravelLabel && legacyTravelAmount > 0) {
        addLine_(legacyTravelLabel, legacyTravelAmount, 1, legacyTravelRuleId);
      }
      if (!cancellationMode && legacyMode && legacyToppingLabel && legacyToppingAmount > 0) {
        addLine_(legacyToppingLabel, legacyToppingQty * legacyToppingAmount, legacyToppingQty, legacyToppingRuleId);
      }
    });

    const keyPickup = Math.max(0, Number(host.querySelector('[name="key_pickup_fee_amount"]')?.value || 0) || 0);
    const keyReturn = Math.max(0, Number(host.querySelector('[name="key_return_fee_amount"]')?.value || 0) || 0);
    const discount = adjustmentMode ? 0 : Math.max(0, Number(host.querySelector('[name="discount_amount"]')?.value || 0) || 0);
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
    if (!adjustmentMode && discountOptions.length) {
      let discountRuleId = String(host.querySelector('[name="discount_price_rule_id"]')?.value || "").trim();
      if (!discountRuleId) {
        discountRuleId = findRuleForAmountLocal_(discountOptions, discount) || String(discountOptions[0]?.price_rule_id || "").trim();
      }
      if (discountRuleId) setValue_("discount_price_rule_id", discountRuleId);
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
        .map((x) => `<div class="row row-between"><span>${escapeHtml(`${x.label} ×${x.qty}`)}</span><span class="text-right minw-90">${escapeHtml(formatMoney_(x.amount))}円</span></div>`)
        .join("");
      const discountRow = discount > 0 ? `<div class="row row-between"><span>${escapeHtml(String(host.querySelector('[name="discount_label"]')?.value || "割引"))}</span><span class="text-right minw-90">-${escapeHtml(formatMoney_(discount))}円</span></div>` : ``;
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
      const legacyHeadcountQty = Math.max(1, Number(host.querySelector(`[name="legacy_headcount_qty_${vid}"]`)?.value || 1) || 1);
      const legacyHeadcountAmount = Math.max(0, Number(host.querySelector(`[name="legacy_headcount_amount_${vid}"]`)?.value || 0) || 0);
      const legacyHeadcountLabel = String(host.querySelector(`[name="legacy_headcount_label_${vid}"]`)?.value || "").trim();
      const legacyTravelAmount = Math.max(0, Number(host.querySelector(`[name="legacy_travel_amount_${vid}"]`)?.value || 0) || 0);
      const legacyTravelLabel = String(host.querySelector(`[name="legacy_travel_label_${vid}"]`)?.value || "").trim() || "交通費（往復）";
      const legacyToppingQty = Math.max(1, Number(host.querySelector(`[name="legacy_topping_qty_${vid}"]`)?.value || 1) || 1);
      const legacyToppingAmount = Math.max(0, Number(host.querySelector(`[name="legacy_topping_amount_${vid}"]`)?.value || 0) || 0);
      const legacyToppingLabel = String(host.querySelector(`[name="legacy_topping_label_${vid}"]`)?.value || "").trim();
      setText_(`parking_amount_${vid}`, amountText_(parking));
      setText_(`travel_amount_${vid}`, travel > 0 ? `${formatMoney_(travel)}円` : "未選択");
      setText_(`seasonal_amount_${vid}`, seasonal > 0 ? `${formatMoney_(seasonal)}円` : "未選択");
      setText_(`extra_label_${vid}`, (extraLabel && extraAmount > 0) ? `${extraLabel} × ${extraQty} (${formatMoney_(extraAmount)}円)` : "未設定");
      setText_(`adjustment_overtime_${vid}`, (adjustmentOvertimeLabel && adjustmentOvertimeAmount > 0) ? `${adjustmentOvertimeLabel} × ${adjustmentOvertimeQty} (${formatMoney_(adjustmentOvertimeAmount)}円)` : "未設定");
      setText_(`adjustment_reimbursement_${vid}`, adjustmentReimbursementAmount > 0 ? `${adjustmentReimbursementLabel} (${formatMoney_(adjustmentReimbursementAmount)}円)` : "未設定");
      setText_(`legacy_headcount_${vid}`, (legacyHeadcountLabel && legacyHeadcountAmount > 0) ? `${legacyHeadcountLabel} × ${legacyHeadcountQty} (${formatMoney_(legacyHeadcountAmount)}円)` : "未設定");
      setText_(`legacy_travel_${vid}`, legacyTravelAmount > 0 ? `${legacyTravelLabel} (${formatMoney_(legacyTravelAmount)}円)` : "未設定");
      setText_(`legacy_topping_${vid}`, (legacyToppingLabel && legacyToppingAmount > 0) ? `${legacyToppingLabel} × ${legacyToppingQty} (${formatMoney_(legacyToppingAmount)}円)` : "未設定");
    });
    const residualVidSet = new Set();
    host.querySelectorAll('input[name^="residual_visit_id_"]').forEach((visitInput) => {
      const vid = String(visitInput?.value || "").trim();
      if (vid) residualVidSet.add(vid);
    });
    Array.from(residualVidSet).forEach((vid) => {
      const baseLabel = String(host.querySelector(`[name="residual_base_fee_label_${vid}"]`)?.value || "").trim() || "商品未設定";
      const baseAmount = Math.max(0, Number(host.querySelector(`[name="residual_base_fee_amount_${vid}"]`)?.value || 0) || 0);
      const basePriceRuleId = String(host.querySelector(`[name="residual_base_price_rule_id_${vid}"]`)?.value || "").trim();
      const parkingAmount = Math.max(0, Number(host.querySelector(`[name="residual_parking_fee_amount_${vid}"]`)?.value || 0) || 0);
      const travelAmount = parseOptionAmount_(host.querySelector(`[name="residual_travel_option_${vid}"]`)?.value || "");
      const seasonalAmount = parseOptionAmount_(host.querySelector(`[name="residual_seasonal_option_${vid}"]`)?.value || "");
      setText_(`residual_base_label_${vid}`, baseLabel);
      setText_(`residual_base_amount_${vid}`, amountText_(baseAmount, {
        zero_as_amount: !!basePriceRuleId,
      }));
      setText_(`residual_parking_amount_${vid}`, amountText_(parkingAmount));
      setText_(`residual_travel_amount_${vid}`, travelAmount > 0 ? `${formatMoney_(travelAmount)}円` : "未選択");
      setText_(`residual_seasonal_amount_${vid}`, seasonalAmount > 0 ? `${formatMoney_(seasonalAmount)}円` : "未選択");
      setText_(`residual_subtotal_${vid}`, (baseAmount + parkingAmount + travelAmount + seasonalAmount) > 0
        ? `${formatMoney_(baseAmount + parkingAmount + travelAmount + seasonalAmount)}円`
        : (basePriceRuleId ? "0円" : "未設定"));
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

    if (!adjustmentMode) {
      const discount = Math.max(0, Number(host.querySelector('[name="discount_amount"]')?.value || 0) || 0);
      setText_("discount_amount", discount > 0 ? `${formatMoney_(discount)}円` : "未設定");
    }
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
        setText_(`base_amount_${vid}`, amountText_(amount, { zero_as_amount: !!rid }));
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
      if (type === "adjustment_overtime" && vid) {
        const qtyCur = Math.max(1, Number(host.querySelector(`[name="adjustment_overtime_qty_${vid}"]`)?.value || 1) || 1);
        const chosen = await pickScopedMerchandiseByModal_("延長料金", overtimeOptions, qtyCur);
        if (!chosen) return;
        const qty = Math.max(1, Number(chosen.qty || 1) || 1);
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        const label = String(chosen.label || "").trim() || "延長料金";
        setValue_(`adjustment_overtime_label_${vid}`, label);
        setValue_(`adjustment_overtime_qty_${vid}`, qty);
        setValue_(`adjustment_overtime_amount_${vid}`, amount);
        setValue_(`adjustment_overtime_price_rule_id_${vid}`, String(chosen.price_rule_id || ""));
        setText_(`adjustment_overtime_${vid}`, (label && amount > 0) ? `${label} × ${qty} (${formatMoney_(amount)}円)` : "未設定");
        updateTotals_();
        return;
      }
      if (type === "adjustment_reimbursement" && vid) {
        if (!reimbursementOptions.length) {
          window.alert("立替金の選択肢がありません。設定画面で item_type=reimbursement を登録してください。");
          return;
        }
        const chosen = await pickScopedMerchandiseByModal_("立替金", reimbursementOptions, 1);
        if (!chosen) return;
        const cur = Math.max(0, Number(host.querySelector(`[name="adjustment_reimbursement_amount_${vid}"]`)?.value || 0) || 0);
        const label = String(chosen.label || "").trim() || "立替金";
        const amount = await promptNumber_(label, cur);
        if (amount == null) return;
        const rid = String(chosen.price_rule_id || "").trim();
        setValue_(`adjustment_reimbursement_amount_${vid}`, amount);
        setValue_(`adjustment_reimbursement_price_rule_id_${vid}`, rid);
        setValue_(`adjustment_reimbursement_label_${vid}`, label);
        setText_(`adjustment_reimbursement_${vid}`, amount > 0 ? `${label} (${formatMoney_(amount)}円)` : "未設定");
        updateTotals_();
        return;
      }
      if (type === "legacy_headcount" && vid) {
        const qtyCur = Math.max(1, Number(host.querySelector(`[name="legacy_headcount_qty_${vid}"]`)?.value || 1) || 1);
        const chosen = await pickScopedMerchandiseByModal_("頭数追加", legacyHeadcountOptions, qtyCur);
        if (!chosen) return;
        const qty = Math.max(1, Number(chosen.qty || 1) || 1);
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        const label = String(chosen.label || "").trim();
        setValue_(`legacy_headcount_label_${vid}`, label);
        setValue_(`legacy_headcount_qty_${vid}`, qty);
        setValue_(`legacy_headcount_amount_${vid}`, amount);
        setValue_(`legacy_headcount_price_rule_id_${vid}`, String(chosen.price_rule_id || ""));
        setText_(`legacy_headcount_${vid}`, (label && amount > 0) ? `${label} × ${qty} (${formatMoney_(amount)}円)` : "未設定");
        updateTotals_();
        return;
      }
      if (type === "legacy_travel" && vid) {
        const cur = Math.max(0, Number(host.querySelector(`[name="legacy_travel_amount_${vid}"]`)?.value || 0) || 0);
        const amount = await promptNumber_("交通費（往復）", cur);
        if (amount == null) return;
        const rid = String(host.querySelector(`[name="legacy_travel_price_rule_id_${vid}"]`)?.value || "").trim()
          || String(legacyTravelOptions[0]?.price_rule_id || "").trim();
        const label = String(host.querySelector(`[name="legacy_travel_label_${vid}"]`)?.value || "").trim()
          || String(legacyTravelOptions[0]?.label || "交通費（往復）");
        setValue_(`legacy_travel_amount_${vid}`, amount);
        setValue_(`legacy_travel_price_rule_id_${vid}`, rid);
        setValue_(`legacy_travel_label_${vid}`, label);
        setText_(`legacy_travel_${vid}`, amount > 0 ? `${label} (${formatMoney_(amount)}円)` : "未設定");
        updateTotals_();
        return;
      }
      if (type === "legacy_topping" && vid) {
        const qtyCur = Math.max(1, Number(host.querySelector(`[name="legacy_topping_qty_${vid}"]`)?.value || 1) || 1);
        const chosen = await pickScopedMerchandiseByModal_("トッピング（遊び / ケア）", legacyToppingOptions, qtyCur);
        if (!chosen) return;
        const qty = Math.max(1, Number(chosen.qty || 1) || 1);
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        const label = String(chosen.label || "").trim();
        setValue_(`legacy_topping_label_${vid}`, label);
        setValue_(`legacy_topping_qty_${vid}`, qty);
        setValue_(`legacy_topping_amount_${vid}`, amount);
        setValue_(`legacy_topping_price_rule_id_${vid}`, String(chosen.price_rule_id || ""));
        setText_(`legacy_topping_${vid}`, (label && amount > 0) ? `${label} × ${qty} (${formatMoney_(amount)}円)` : "未設定");
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
        setText_(`residual_base_amount_${vid}`, amountText_(amount, { zero_as_amount: !!rid }));
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
        const curAmount = Math.max(0, Number(host.querySelector('[name="discount_amount"]')?.value || 0) || 0);
        const out = await openEditor_({
          title: "割引",
          bodyHtml: `
            <div class="grid-8">
              <div>
                <div class="label-strong">割引額</div>
                <div class="row gap-8">
                  <input
                    class="input text-right"
                    data-el="amount"
                    type="number"
                    min="0"
                    step="1"
                    inputmode="numeric"
                    placeholder="金額を入力"
                    value="${escapeHtml(curAmount > 0 ? String(curAmount) : "")}"
                  />
                  <span>円</span>
                </div>
              </div>
            </div>
          `,
          onSubmit: (root) => {
            const rawAmount = String(root.querySelector('[data-el="amount"]')?.value || "").trim();
            return {
              amount: rawAmount ? Math.max(0, Number(rawAmount) || 0) : 0
            };
          }
        });
        if (!out) return;
        const amount = Math.max(0, Number(out.amount || 0) || 0);
        const discountRuleId = findRuleForAmountLocal_(discountOptions, amount) || String(discountOptions[0]?.price_rule_id || "").trim();
        setValue_("discount_label", "割引");
        setValue_("discount_amount", amount);
        setValue_("discount_price_rule_id", discountRuleId);
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
  const targetVisitIdSet = new Set(selectedVisitIdSet);
  extraLines.forEach((x) => {
    const vid = String(x?.visit_id || "").trim();
    if (vid) targetVisitIdSet.add(vid);
  });
  const targetVisitCount = targetVisitIdSet.size > 0 ? targetVisitIdSet.size : list.length;
  extraLines.forEach((x) => {
    const vid = String(x?.visit_id || "").trim();
    if (!vid) return;
    if (!extraByVisit.has(vid)) extraByVisit.set(vid, []);
    extraByVisit.get(vid).push(x);
  });
  const lineMap = new Map();
  let targetSubtotal = 0;
  let cancelLineRuleId = "";
  const addLine_ = (name, unitPrice, quantity, priceRuleId = "", options = {}) => {
    const n = String(name || "").trim();
    const up = Math.max(0, Number(unitPrice || 0) || 0);
    const qty = Math.max(0, Number(quantity || 0) || 0);
    if (!n || !(qty > 0)) return;
    const includeZero = options?.include_zero === true;
    if (!(up > 0) && !includeZero) return;
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
      addLine_(baseLabel, base, 1, String(ov?.price_rule_id || ""), {
        include_zero: !!String(ov?.price_rule_id || "").trim(),
      });
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
    <div class="scroll-70vh">
      <div class="p mb-8">
        顧客: <strong>${escapeHtml(String(list[0]?.customer_name || "-"))}</strong><br/>
        対象予約: <strong>${escapeHtml(String(targetVisitCount))}件</strong>
      </div>
      <div class="mb-6"><strong>請求明細</strong></div>
      <div class="grid-8">
        ${rows.map((x) => `
          <div class="row row-between row-top-start">
            <div>
              <div><strong>${escapeHtml(x.name)}</strong></div>
              <div class="opacity-8">${escapeHtml(`×${x.quantity} (${formatMoney_(x.unit_price)}円)`)}</div>
            </div>
            <div class="nowrap text-right">${escapeHtml(formatMoney_(x.line_total))}円</div>
          </div>
        `).join("") || `<div>-</div>`}
        ${discountAmount > 0 ? `
          <div class="row row-between row-top-start">
            <div>
              <div><strong>${escapeHtml(discountLabel)}</strong></div>
              <div class="opacity-8">値引き</div>
            </div>
            <div class="nowrap text-right">-${escapeHtml(formatMoney_(discountAmount))}円</div>
          </div>
        ` : ``}
      </div>
      <div class="mt-10">
        <div><strong>メモ</strong></div>
        <div class="mt-6">${escapeHtml(String(p.memo || "-"))}</div>
      </div>
      <div class="mt-10">
        <div class="row row-between"><span>小計</span><strong>${escapeHtml(formatMoney_(subtotal))}円</strong></div>
        <div class="row row-between"><span>割引</span><strong>${escapeHtml(discountAmount > 0 ? `-${formatMoney_(discountAmount)}円` : "0円")}</strong></div>
        <div class="row row-between divider-top"><span><strong>合計</strong></span><strong>${escapeHtml(formatMoney_(grand))}円</strong></div>
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

function buildBillingBatchPayload_(customerId, selected, formValues, options = {}) {
  const list = Array.isArray(selected) ? selected : [];
  const fv = formValues || {};
  const adjustmentMode = options?.adjustment_mode === true || String(fv?.billing_mode || "").trim() === "adjustment";
  const visitIds = list.map((v) => String(v?.visit_id || "").trim()).filter(Boolean);
  const parseOptionRuleId_ = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return "";
    const parts = s.split("|");
    return String(parts[0] || "").trim();
  };
  const visitOverrides = adjustmentMode ? [] : list.map((v) => {
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
  const adjustmentLines = adjustmentMode ? list.flatMap((v) => {
    const vid = String(v?.visit_id || "").trim();
    if (!vid) return [];
    const rows = [];
    const parkingAmount = Math.max(0, Number(fv[`parking_fee_amount_${vid}`] || 0) || 0);
    const parkingRuleId = String(fv[`parking_price_rule_id_${vid}`] || "").trim();
    if (parkingAmount > 0) {
      rows.push({ visit_id: vid, label: "駐車料金", quantity: 1, unit_price: parkingAmount, price_rule_id: parkingRuleId });
    }
    const overtimeLabel = String(fv[`adjustment_overtime_label_${vid}`] || "").trim() || "延長料金";
    const overtimeQty = Math.max(1, Number(fv[`adjustment_overtime_qty_${vid}`] || 1) || 1);
    const overtimeAmount = Math.max(0, Number(fv[`adjustment_overtime_amount_${vid}`] || 0) || 0);
    const overtimeRuleId = String(fv[`adjustment_overtime_price_rule_id_${vid}`] || "").trim();
    if (overtimeAmount > 0) {
      rows.push({ visit_id: vid, label: overtimeLabel, quantity: overtimeQty, unit_price: overtimeAmount, price_rule_id: overtimeRuleId });
    }
    const reimbursementLabel = String(fv[`adjustment_reimbursement_label_${vid}`] || "").trim() || "立替金";
    const reimbursementAmount = Math.max(0, Number(fv[`adjustment_reimbursement_amount_${vid}`] || 0) || 0);
    const reimbursementRuleId = String(fv[`adjustment_reimbursement_price_rule_id_${vid}`] || "").trim();
    if (reimbursementAmount > 0) {
      if (!reimbursementRuleId) {
        throw new Error(`visit ${vid}: reimbursement rule is not configured`);
      }
      rows.push({ visit_id: vid, label: reimbursementLabel, quantity: 1, unit_price: reimbursementAmount, price_rule_id: reimbursementRuleId });
    }
    return rows;
  }) : [];
  const legacyFixedLines = list.flatMap((v) => {
    const vid = String(v?.visit_id || "").trim();
    const rows = [];
    const pushRow_ = (labelKey, qtyKey, amountKey, ruleIdKey) => {
      const label = String(fv[labelKey] || "").trim();
      const qty = Math.max(1, Number(fv[qtyKey] || 1) || 1);
      const amount = Math.max(0, Number(fv[amountKey] || 0) || 0);
      const priceRuleId = String(fv[ruleIdKey] || "").trim();
      if (!label || !(amount > 0)) return;
      rows.push({
        visit_id: vid,
        label,
        quantity: qty,
        unit_price: amount,
        price_rule_id: priceRuleId,
      });
    };
    pushRow_(`legacy_headcount_label_${vid}`, `legacy_headcount_qty_${vid}`, `legacy_headcount_amount_${vid}`, `legacy_headcount_price_rule_id_${vid}`);
    pushRow_(`legacy_travel_label_${vid}`, `legacy_travel_qty_${vid}`, `legacy_travel_amount_${vid}`, `legacy_travel_price_rule_id_${vid}`);
    pushRow_(`legacy_topping_label_${vid}`, `legacy_topping_qty_${vid}`, `legacy_topping_amount_${vid}`, `legacy_topping_price_rule_id_${vid}`);
    return rows;
  });
  const residualExtraLines = collectResidualExtraLinesFromFormValues_(fv);
  const memo = String(fv.memo || "").trim();
  const discountAmount = Number(fv.discount_amount || 0) || 0;
  const discountLabel = String(fv.discount_label || "").trim() || "割引";
  return {
    customer_id: String(customerId || "").trim(),
    visit_ids: visitIds,
    memo,
    visit_overrides: visitOverrides,
    extra_lines: adjustmentMode
      ? adjustmentLines
      : extraLines.concat(legacyFixedLines, residualExtraLines),
    billing_mode: adjustmentMode ? "adjustment" : "standard",
    key_pickup_fee_amount: Math.max(0, Number(fv.key_pickup_fee_amount || 0) || 0),
    key_return_fee_amount: Math.max(0, Number(fv.key_return_fee_amount || 0) || 0),
    key_pickup_price_rule_id: String(fv.key_pickup_price_rule_id || "").trim(),
    key_return_price_rule_id: String(fv.key_return_price_rule_id || "").trim(),
    discount_price_rule_id: String(fv.discount_price_rule_id || "").trim(),
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
    const seasonal = Math.max(0, Number(row?.seasonal_fee_amount || 0) || 0);
    const targetSubtotal = base + seasonal;
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

function buildCancellationCreatePayload_(payload, cancellationRate, options = {}) {
  const p = payload || {};
  const rate = Math.max(0, Number(cancellationRate || 0) || 0);
  const normalizedBatchType = normalizeBillingBatchTypeKey_(options?.batch_type || "cancellation_only");
  const batchType = normalizedBatchType === "invoice_with_cancellation" ? "invoice_with_cancellation" : "cancellation_only";
  return {
    ...p,
    batch_type: batchType,
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
  const group = new Map();
  activeItems.forEach((item) => {
    const vid = String(item?.visit_id || "").trim();
    if (!vid || !remainingSet.has(vid)) return;
    const lineId = String(item?.invoice_line_item_id || "").trim();
    const line = lineById[lineId] || {};
    const label = String(line?.label || "").trim();
    const unit = Math.max(0, Number(line?.unit_price_snapshot || 0) || 0);
    if (!label || !(unit > 0)) return;
    const key = `${vid}__${label}__${unit}`;
    const cur = group.get(key) || {
      visit_id: vid,
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
  const guide = (_guide && typeof _guide === "object") ? _guide : {};
  const guideVisitCount = Number(guide.visit_count || 0) || 0;
  const count = guideVisitCount > 0 ? Math.max(0, Math.floor(guideVisitCount)) : list.length;

  return `
    <div class="p mb-10">
      Square側で生成された下書き請求書の内容を確認して送信してください。
    </div>
    <div class="p mb-8">
      対象予約: <strong>${escapeHtml(String(count))}件</strong>
    </div>
    <div class="p opacity-9">
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

function normalizeBillingStatusFilterKey_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["no_billing_required", "no_billing", "billing_not_required"].includes(s)) return "no_billing_required";
  if (!s || s === "unbilled" || s === "cancelled" || s === "canceled" || s === "voided" || s === "refunded") return "unbilled";
  if (s === "paid" || s === "completed") return "paid";
  if (s === "draft" || s === "invoice_draft" || s === "pending" || s === "unpaid") return "draft";
  if (s === "billed" || s === "invoicing" || s === "invoiced" || s === "sent" || s === "scheduled" || s === "published" || s === "partially_paid") return "billed";
  return "unbilled";
}

function normalizeBatchBillingStatus_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "no_billing_required" || s === "no_billing" || s === "billing_not_required") return "unbilled";
  if (!s || s === "unbilled" || s === "cancelled" || s === "canceled" || s === "voided" || s === "refunded") return "unbilled";
  if (s === "paid") return "paid";
  return "billed";
}

function billingStatusStageClass_(value) {
  const s = normalizeCancelBillingStatus_(value);
  if (s === "paid") return "badge-billing-status-paid";
  if (s === "billed") return "badge-billing-status-billed";
  return "badge-billing-status-unbilled";
}

function applyBillingStatusStageClass_(el, value) {
  if (!el) return;
  el.classList.remove(
    "badge-billing-status-unbilled",
    "badge-billing-status-billed",
    "badge-billing-status-paid"
  );
  el.classList.add(billingStatusStageClass_(value));
}

function normalizeRefundFollowupStatus_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["required", "not_required", "refunded_partial", "refunded_full"].includes(s)) return s;
  return "";
}

function deriveRefundFollowupStatus_(v, billingStatus, isActive) {
  const explicit = normalizeRefundFollowupStatus_(v?.refund_followup_status || v?.refund_state);
  if (explicit) return explicit;
  const refundDetected = !!v?.refund_detected;
  if (refundDetected) {
    const kind = String(v?.refund_kind || "").trim().toLowerCase();
    return kind === "partial" ? "refunded_partial" : "refunded_full";
  }
  if (String(billingStatus || "").trim().toLowerCase() === "paid" && isActive === false) return "required";
  return "";
}

function refundFollowupBadgeLabel_(status) {
  const s = normalizeRefundFollowupStatus_(status);
  if (s === "required") return "要返金確認";
  if (s === "not_required") return "返金不要（確認済み）";
  if (s === "refunded_partial") return "一部返金済み";
  if (s === "refunded_full") return "全額返金済み";
  return "";
}

function refundFollowupBadgeClass_(status) {
  const s = normalizeRefundFollowupStatus_(status);
  if (s === "required") return "badge badge-danger";
  return "badge";
}

function normalizeMeetingNotifyStatus_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "manual_send_required" || s === "manual_sent") return s;
  return "";
}

function meetingNotifyBadgeLabel_(status) {
  const s = normalizeMeetingNotifyStatus_(status);
  if (s === "manual_send_required") return "面談通知: 手動送信要";
  if (s === "manual_sent") return "面談通知: 送信済み";
  return "";
}

function meetingNotifyBadgeClass_(status) {
  const s = normalizeMeetingNotifyStatus_(status);
  if (s === "manual_send_required") return "badge badge-danger";
  if (s === "manual_sent") return "badge badge-ok";
  return "badge";
}

function pickIsActive_(v) {
  return isActive_(v);
}

function actionIconSvg_(name) {
  const common = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (name === "detail") {
    return `<svg ${common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M16 13H8"></path><path d="M16 17H8"></path><path d="M10 9H8"></path></svg>`;
  }
  return "";
}

function cardHtml(v) {
  // v のスキーマ差分に合わせる（不足項目は安全にフォールバック）
  const startRaw = v.start_time || "";
  const start = fmtDateTimeJst(startRaw);
  const title = v.title || "(無題)";
  const customer = withCustomerHonorific_(v.customer_name);
  const productName = String(v.product_name || v.service_name || "").trim();
  const variantName = String(v.variant_name || "").trim();
  const vid = v.visit_id || "";
  const done = isDone_(v);
  const billingStatus = String(v.billing_status || "").trim() || "unbilled";
  const isActive = !(v.is_active === false || String(v.is_active || "").toLowerCase() === "false");
  const refundFollowupStatus = deriveRefundFollowupStatus_(v, billingStatus, isActive);
  const refundLabel = refundFollowupBadgeLabel_(refundFollowupStatus);
  const refundBadgeClass = refundFollowupBadgeClass_(refundFollowupStatus);
  const cancellationFeeAmount = Math.max(0, Number(v.cancellation_fee_amount || 0) || 0);
  const cancellationFeeRate = Math.max(0, Number(v.cancellation_fee_rate || 0) || 0);
  const hasCancellationFee = !isActive && cancellationFeeAmount > 0 && normalizeCancelBillingStatus_(billingStatus) === "billed";
  const meetingNotifyStatus = normalizeMeetingNotifyStatus_(v.meeting_notify_status);
  const meetingNotifyLabel = meetingNotifyBadgeLabel_(meetingNotifyStatus);
  const invoiceReconcileRequired = v.invoice_reconcile_required === true || String(v.invoice_reconcile_required || "").toLowerCase() === "true";
  const petNames = Array.isArray(v.pet_names) ? v.pet_names : [];
  const vid2 = String(vid || "").trim();
  const staffLabel = String(v.staff_name || v.staff_id || "").trim();
  const showStaffBadge = isAdminUser_() && !!staffLabel;

  return `
    <div class="card visit-card"
      data-visit-id="${escapeHtml(vid)}"
      data-done="${done ? "1" : "0"}"
      data-billing-status="${escapeHtml(String(billingStatus))}"
      data-is-active="${isActive ? "1" : "0"}"
      data-price-rule-id="${escapeHtml(String(v.price_rule_id || ""))}"
      data-meeting-notify-status="${escapeHtml(String(meetingNotifyStatus))}"
    >
      <div class="card-bulk-check mb-8" data-role="bulk-check-wrap">
        <label class="row gap-8">
          <input type="checkbox" data-role="bulk-check" data-visit-id="${escapeHtml(vid2)}" />
          <span class="p m-0">選択</span>
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
      <div class="pets-badges">
        ${renderPetsBadges_(petNames)}
      </div>
      <div class="badges" data-role="badges">
        <span class="badge badge-visit-type is-clickable"
          data-action="change-price-rule"
          title="タップで訪問基本料金を変更"
          data-role="visit-type-badge">
          ${escapeHtml(productBadgeLabel_(v))}
        </span>
        ${variantName ? `
        <span class="badge">
          ${escapeHtml(variantName)}
        </span>
        ` : ``}
        <span class="badge badge-billing-status is-clickable ${billingStatusStageClass_(billingStatus)}"
          data-action="change-billing-status"
          title="タップで請求ステータスを変更"
        >
          ${escapeHtml(displayOrDash(fmt(billingStatusLabel_(billingStatus)), "未請求"))}
        </span>
        ${invoiceReconcileRequired ? `<span class="badge badge-danger">請求書再調整要</span>` : ``}
        ${refundLabel ? `<span class="${refundBadgeClass}">${escapeHtml(refundLabel)}</span>` : ``}
        ${hasCancellationFee ? `<span class="badge badge-danger">キャンセル料: ${escapeHtml(formatMoney_(cancellationFeeAmount))}円（${escapeHtml(String(cancellationFeeRate))}%）</span>` : ``}
        ${meetingNotifyLabel ? `<span class="${meetingNotifyBadgeClass_(meetingNotifyStatus)} is-clickable" data-action="toggle-meeting-notify" title="タップで通知確認ステータスを切り替え">${escapeHtml(meetingNotifyLabel)}</span>` : ``}
        <span class="badge badge-done is-clickable ${done ? "badge-ok is-done" : "is-not-done"}"
          data-action="toggle-done"
          title="タップで完了/未完了を切り替え"
        >
           ${done ? "完了" : "未完了"}
        </span>
        <span class="badge badge-active is-clickable ${isActive ? "is-active" : "badge-danger is-inactive"}"
          data-action="toggle-active"
          title="タップで有効/キャンセルを切り替え"
        >
          ${isActive ? "有効" : "キャンセル"}
        </span>
      </div>
      <div class="row row-end mt-10">
        ${showStaffBadge ? `
        <span class="badge is-clickable"
          data-action="reassign-staff"
          title="タップで担当者を変更"
          style="margin-right:auto;"
        >
          担当: ${escapeHtml(staffLabel)}
        </span>
        ` : ``}
        <button class="btn btn-icon-action" type="button" data-action="open" title="詳細" aria-label="詳細">${actionIconSvg_("detail")}</button>
      </div>
    </div>
  `;
}

export async function renderVisitsList(appEl, query) {
  const isAdmin = isAdminUser_();
  const queryStaffId = String(query?.get?.("staff_id") || "").trim();
  // ===== state =====
  const init = defaultRange();
  const saved = (() => { try { return loadState_(); } catch (_) { return null; } })();

  // ===== bulk edit ui state (in-memory) =====
  let bulkSelected = new Set();       // Set<visit_id>
  let visibleVisitIds = [];           // 現在表示中の visit_id
  let bulkAction = "bulk-edit-done";        // bulk-edit-done | bulk-edit-active | bulk-create-invoice-draft | bulk-attach-to-invoice
  let pendingCancelDraft = consumePendingCancelDraft_();

  let state = {
    date_from: (saved && saved.date_from) ? String(saved.date_from) : init.date_from,
    date_to_ymd: (saved && saved.date_to_ymd) ? String(saved.date_to_ymd) : init.date_to.slice(0, 10),
    keyword: (saved && typeof saved.keyword === "string") ? saved.keyword : "",
    sort_order: (saved && saved.sort_order) ? String(saved.sort_order) : "asc", // 近い順（運用上、次の予定が見やすい）
    done_filter: (saved && saved.done_filter) ? String(saved.done_filter) : "open_first", // open_first | open_only | done_only | all
    active_filter: (saved && saved.active_filter) ? String(saved.active_filter) : "active_only", // active_only | include_deleted
    billing_filter: (saved && saved.billing_filter) ? String(saved.billing_filter) : "", // "" | unbilled | no_billing_required | draft | billed | paid
    staff_filter: isAdmin ? (queryStaffId || ((saved && saved.staff_filter) ? String(saved.staff_filter) : "")) : "",
   };
  saveState_(state);

  render(appEl, `
    <section class="section">
      <h1 class="h1">予約一覧</h1>
      <p class="p">${isAdmin ? "期間・状態で絞り込み、保存・請求・キャンセル・再有効化を行います。" : "期間・状態で絞り込み、担当予約の状態確認と更新を行います。"}</p>
      <div class="hr"></div>
      <details id="vfDetails" class="panel-soft">
        <summary class="row summary-plain">
          <div class="fw-900">フィルタ / ソート</div>
          <span id="vfToggleState" class="badge">開く</span>
        </summary>
        <div id="visitsFilters" class="mt-10">
          <div class="row vf-range-row">
            <div class="flex-1 vf-range-col">
              <div class="p mb-6">期間（from）</div>
              <input id="vfFrom" class="input" type="date" />
            </div>
            <div class="flex-1 vf-range-col">
              <div class="p mb-6">期間（to）</div>
              <input id="vfTo" class="input" type="date" />
            </div>
          </div>
          <div class="row">
            <button class="btn" type="button" data-action="apply-range">実行</button>
            <button class="btn btn-ghost" type="button" data-action="reset">初期化</button>
          </div>
          <div class="hr"></div>
          <div class="row">
            <input id="vfKeyword" class="input" type="text" inputmode="search" placeholder="検索（顧客名 / タイトル / visit_id …）" />
            <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
          </div>
          <div class="row vf-field-row">
            <div class="p vf-field-label">完了状態</div>
            <select id="vfDoneFilter" class="select vf-field-select">
              <option value="open_first">すべて（未完了優先）</option>
              <option value="open_only">未完了のみ</option>
              <option value="done_only">完了のみ</option>
              <option value="all">すべて</option>
            </select>
          </div>
          <div class="row vf-field-row">
            <div class="p vf-field-label">キャンセル</div>
            <select id="vfActiveFilter" class="select vf-field-select">
              <option value="active_only">除外（デフォルト）</option>
              <option value="include_deleted">含める</option>
            </select>
          </div>
          <div class="row vf-field-row">
            <div class="p vf-field-label">請求状態</div>
            <select id="vfBillingFilter" class="select vf-field-select">
              <option value="">すべて</option>
              <option value="unbilled">未請求</option>
              <option value="no_billing_required">請求不要</option>
              <option value="draft">下書き</option>
              <option value="billed">請求済</option>
              <option value="paid">支払済</option>
            </select>
          </div>
          <div class="row vf-field-row">
            <div class="p vf-field-label">並び順</div>
            <select id="vfSortOrder" class="select vf-field-select">
              <option value="asc">日時：近い順</option>
              <option value="desc">日時：新しい順</option>
            </select>
          </div>
          ${isAdmin ? `
          <div class="row vf-field-row">
            <div class="p vf-field-label">表示スタッフ</div>
            <select id="vfStaffFilter" class="select vf-field-select">
              <option value="">全スタッフ</option>
            </select>
          </div>
          ` : ""}
        </div>
      </details>
      <div class="row bulk-toolbar" id="bulkBar">
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
  const billingEl = appEl.querySelector("#vfBillingFilter");
  const sortEl = appEl.querySelector("#vfSortOrder");
  const staffEl = appEl.querySelector("#vfStaffFilter");
  const bulkBarEl = appEl.querySelector("#bulkBar");

  if (fromEl) fromEl.value = state.date_from;
  if (toEl) toEl.value = state.date_to_ymd;
  if (kwEl) kwEl.value = state.keyword;
  if (doneEl) doneEl.value = state.done_filter;
  if (activeEl) activeEl.value = state.active_filter;
  if (billingEl) billingEl.value = state.billing_filter;
  if (sortEl) sortEl.value = state.sort_order;
  if (staffEl) staffEl.value = state.staff_filter;

  // ===== 一覧state =====
  // - visitsAll: 直近取得したサーバ結果（期間はサーバ側で絞っている）
  // - 画面表示は keyword / sort をクライアント側で適用
  let visitsAll = [];

  const enrichVisitsPetNames_ = async (idToken, visits) => {
    const list = Array.isArray(visits) ? visits : [];
    if (!idToken || !list.length) return list;
    const needsFetch = list.some((v) => {
      if (!Array.isArray(v?.pet_names)) return true;
      return v.pet_names.length === 0;
    });
    if (!needsFetch) return list;
    const customerIds = Array.from(new Set(list.map((v) => String(v?.customer_id || "").trim()).filter(Boolean)));
    if (!customerIds.length) return list;
    try {
      const res = await portalCustomersPetNames_(idToken, customerIds);
      const u = unwrapResults(res);
      const map = (u && u.results && typeof u.results === "object") ? u.results : {};
      if (!map || typeof map !== "object") return list;
      return list.map((v) => {
        const cid = String(v?.customer_id || "").trim();
        const petNames = Array.isArray(map[cid]) ? map[cid] : (Array.isArray(v?.pet_names) ? v.pet_names : []);
        return Object.assign({}, v, { pet_names: petNames });
      });
    } catch (_) {
      return list;
    }
  };

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
    if (!canInvoice && (bulkAction === "bulk-create-invoice-draft" || bulkAction === "bulk-create-adjustment-draft" || bulkAction === "bulk-attach-to-invoice")) bulkAction = "bulk-edit-done";
    const selected = selectedVisits_(visitsAll, Array.from(bulkSelected || []));
    const nonDraftableCount = selected.filter(v => pickBillingStatus_(v) !== "unbilled").length;
    const canCreateDraft = count > 0 && nonDraftableCount === 0;
    const allVisibleCount = visibleVisitIds.length;
    const selectedVisibleCount = visibleVisitIds.filter((id) => bulkSelected.has(id)).length;
    const allVisibleSelected = allVisibleCount > 0 && selectedVisibleCount === allVisibleCount;
    const executeDisabled = count === 0
      || (bulkAction === "bulk-create-invoice-draft" && (!canInvoice || !canCreateDraft))
      || (bulkAction === "bulk-attach-to-invoice" && !canInvoice)
      || (bulkAction === "bulk-create-adjustment-draft" && !canInvoice);
    bulkBarEl.style.display = "flex";
    bulkBarEl.innerHTML = [
      `<label class="row gap-8 mr-4">
        <input type="checkbox" data-action="bulk-select-all" ${allVisibleSelected ? "checked" : ""} ${allVisibleCount ? "" : "disabled"} />
        <span class="p m-0">全選択</span>
      </label>`,
      `<span class="badge">選択: ${escapeHtml(String(count))}件</span>`,
      (count > 0 && nonDraftableCount > 0) ? `<span class="badge">請求ドラフト対象外: ${escapeHtml(String(nonDraftableCount))}件</span>` : ``,
      `<select class="select minw-190" data-role="bulk-action">
        <option value="bulk-edit-done">完了 / 未完了</option>
        <option value="bulk-edit-active">有効 / キャンセル</option>
        ${canInvoice ? `<option value="bulk-create-invoice-draft">請求書生成</option>` : ``}
        ${canInvoice ? `<option value="bulk-create-adjustment-draft">追加請求</option>` : ``}
        ${canInvoice ? `<option value="bulk-attach-to-invoice">既存請求書に紐づけ</option>` : ``}
        ${canInvoice ? `<option value="bulk-reassign-staff">担当者変更</option>` : ``}
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
    const billingMode = String(options?.billing_mode || "standard").trim() === "adjustment" ? "adjustment" : "standard";
    const adjustmentMode = billingMode === "adjustment";
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
    if (!adjustmentMode && !options.allow_non_unbilled && nonDraftable.length) {
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
      toast({ title: "対象外あり", message: "キャンセル済み予約は Square請求ドラフト対象にできません。" });
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
        sourceBatchType = normalizeBillingBatchTypeKey_(batch.batch_type);
        const discountAmount = Math.max(0, Number(batch.discount_amount || detail?.discount_amount || 0) || 0);
        const discountLabel = String(batch.discount_label || detail?.discount_label || "割引").trim() || "割引";
        const discountOptions = Array.isArray(feeDefaults?.discount_options) ? feeDefaults.discount_options : [];
        const discountPriceRuleId = String(
          (discountOptions.find((x) => (Math.max(0, Number(x?.amount || 0) || 0) === discountAmount))
            || discountOptions[0]
            || {}
          ).price_rule_id || ""
        ).trim();
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
          ...(discountPriceRuleId ? { discount_price_rule_id: discountPriceRuleId } : {}),
          ...(keyPickupFeeAmount != null ? { key_pickup_fee_amount: String(keyPickupFeeAmount) } : {}),
          ...(keyReturnFeeAmount != null ? { key_return_fee_amount: String(keyReturnFeeAmount) } : {}),
          ...(keyPickupPriceRuleId ? { key_pickup_price_rule_id: keyPickupPriceRuleId } : {}),
          ...(keyReturnPriceRuleId ? { key_return_price_rule_id: keyReturnPriceRuleId } : {}),
        };
        const shouldPresetInactiveCancellationRows = !cancellationMode
          && (sourceBatchType === "invoice_with_cancellation" || sourceBatchType === "cancellation_only");
        if (shouldPresetInactiveCancellationRows) {
          selected.forEach((v) => {
            const vid = String(v?.visit_id || "").trim();
            if (!vid || isActive_(v)) return;
            const cancelFee = Math.max(0, Number(v?.cancellation_fee_amount || 0) || 0);
            if (!(cancelFee > 0)) return;
            formValues[`base_fee_amount_${vid}`] = String(cancelFee);
            formValues[`base_fee_label_${vid}`] = "キャンセル料";
            formValues[`parking_fee_amount_${vid}`] = "0";
            formValues[`parking_price_rule_id_${vid}`] = "";
            formValues[`travel_option_${vid}`] = "";
            formValues[`seasonal_option_${vid}`] = "";
            formValues[`extra_label_${vid}`] = "";
            formValues[`extra_qty_${vid}`] = "1";
            formValues[`extra_amount_${vid}`] = "0";
            formValues[`extra_price_rule_id_${vid}`] = "";
            formValues[`legacy_headcount_label_${vid}`] = "";
            formValues[`legacy_headcount_qty_${vid}`] = "1";
            formValues[`legacy_headcount_amount_${vid}`] = "0";
            formValues[`legacy_headcount_price_rule_id_${vid}`] = "";
            formValues[`legacy_travel_amount_${vid}`] = "0";
            formValues[`legacy_travel_price_rule_id_${vid}`] = "";
            formValues[`legacy_topping_label_${vid}`] = "";
            formValues[`legacy_topping_qty_${vid}`] = "1";
            formValues[`legacy_topping_amount_${vid}`] = "0";
            formValues[`legacy_topping_price_rule_id_${vid}`] = "";
          });
        }
        if (cancellationMode && sourceBatchType !== "cancellation_only") {
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
      const legacyMode = isLegacyModeForVisits_(selected, "2026-05-31");
      formValues = await showFormModal({
        title: cancellationMode ? "キャンセル請求編集モード" : (adjustmentMode ? "追加請求ドラフト設定" : "請求書ドラフト設定"),
        bodyHtml: buildBillingBatchFormHtml_(selected, feeDefaults, customerDefaults, {
          legacy_mode: legacyMode,
          adjustment_mode: adjustmentMode,
          cancellation_rate: cancellationRate,
          cancellation_preset: effectiveCancellationPreset,
          residual_visit_sections: residualVisitSections,
        }),
        okText: "確認へ",
        cancelText: "キャンセル",
        formSelector: '[data-el="billingBatchForm"]',
        onOpen: (host) => {
          const wired = wireBillingBatchFormInteractions_(host, selected, feeDefaults, {
            legacy_mode: legacyMode,
            adjustment_mode: adjustmentMode,
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
      payload = buildBillingBatchPayload_(customerIds[0], selected, formValues, { adjustment_mode: adjustmentMode });
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
      if (!cancellationMode && sourceBatchId && (sourceBatchType === "invoice_with_cancellation" || sourceBatchType === "cancellation_only")) {
        const allSelectedInactive = selected.length > 0 && selected.every((v) => !isActive_(v));
        const hasCancellationFeeSelected = selected.some((v) => Math.max(0, Number(v?.cancellation_fee_amount || 0) || 0) > 0);
        if (allSelectedInactive && hasCancellationFeeSelected) {
          payload = Object.assign({}, payload, { batch_type: "cancellation_only" });
        }
      }
      const payloadForPreview = cancellationMode
        ? Object.assign({}, payload, { memo: buildCancellationMemo_(payload, cancellationRate) })
        : payload;
      const ok = await showModal({
        title: cancellationMode ? "キャンセル請求ドラフト確認" : (adjustmentMode ? "追加請求ドラフト確認" : "請求書ドラフト確認"),
        bodyHtml: buildBillingBatchPreviewHtml_(selected, payloadForPreview, feeDefaults, {
          cancellation_rate: cancellationRate,
        }),
        okText: cancellationMode ? "キャンセル請求ドラフト作成" : (adjustmentMode ? "追加請求ドラフト作成" : "請求書ドラフト作成"),
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
        // キャッシュ描画後もAPI再取得して表示差分を同期する
      }
    }

    const prevById = {};
    selected.forEach((v) => {
      const vid = String(v?.visit_id || "").trim();
      if (!vid) return;
      prevById[vid] = {
        billing_status: pickBillingStatus_(v)
      };
    });

    let createCommitted = false;
    const cancellationCreateBatchType = (() => {
      if (!cancellationMode) return "invoice";
      const sourceType = normalizeBillingBatchTypeKey_(sourceBatchType || "invoice");
      const hasRemainingIds = remainingVisitIdsOpt.length > 0
        || (Array.isArray(effectiveCancellationPreset?.remaining_visit_ids) && effectiveCancellationPreset.remaining_visit_ids.length > 0);
      if (sourceBatchId && sourceType !== "cancellation_only" && hasRemainingIds) {
        return "invoice_with_cancellation";
      }
      return "cancellation_only";
    })();
    try {
      selected.forEach((v) => {
        const vid = String(v?.visit_id || "").trim();
        if (!vid) return;
        const mm = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: "draft" });
        visitsAll = mm.list;
      });
      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();

      const created = await runWithBlocking_(
        {
          title: adjustmentMode ? "追加請求ドラフトを作成しています" : "請求書ドラフトを作成しています",
          bodyHtml: "予約と請求連携情報を保存しています。",
          busyText: "作成中..."
        },
        async () => {
          if (sourceBatchId) {
            await revertBillingBatchToUnbilled_(sourceBatchId, idToken2);
          }
          const payloadForCreate = cancellationMode
            ? buildCancellationCreatePayload_(payload, cancellationRate, { batch_type: cancellationCreateBatchType })
            : payload;
          const res = await createBillingBatch_(payloadForCreate, idToken2);
          return (res && res.result && typeof res.result === "object") ? res.result : res;
        }
      );
      createCommitted = true;
      const createdCancellationFeeByVisit = (created && typeof created.cancellation_fee_by_visit === "object" && !Array.isArray(created.cancellation_fee_by_visit))
        ? Object.fromEntries(
          Object.entries(created.cancellation_fee_by_visit)
            .map(([k, v]) => [String(k || "").trim(), Math.max(0, Number(v || 0) || 0)])
            .filter(([k]) => !!k)
        )
        : {};
      const createdCancellationFeeTotal = Math.max(0, Number(created?.cancellation_fee_total_amount || 0) || 0);

      const batchId = String(created?.batch_id || "");
      const linkedVisitIds = Array.from(new Set(
        (Array.isArray(created?.visit_ids) ? created.visit_ids : [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .concat(selected.map((v) => String(v?.visit_id || "").trim()).filter(Boolean))
          .concat(remainingVisitIdsOpt)
      ));
      linkedVisitIds.forEach((vid) => {
        if (!vid) return;
        const mm = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: "draft" });
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
        const nextBillingStatus = cancellationRate > 0 ? "draft" : "unbilled";
        let syncWarnCount = 0;
        const cancelCommitFailures = [];
        for (const vid of targetDeactivateIds) {
          const hasCreatedFee = Object.prototype.hasOwnProperty.call(createdCancellationFeeByVisit, vid);
          const hasOptionFee = Object.prototype.hasOwnProperty.call(cancellationFeeByVisitOpt, vid);
          const hasFallbackFee = Object.prototype.hasOwnProperty.call(feeByVisit, vid);
          let fee = hasCreatedFee
            ? createdCancellationFeeByVisit[vid]
            : (hasOptionFee ? cancellationFeeByVisitOpt[vid] : (hasFallbackFee ? feeByVisit[vid] : 0));
          if (!(fee > 0) && targetDeactivateIds.length === 1 && createdCancellationFeeTotal > 0) {
            fee = createdCancellationFeeTotal;
          }
          fee = Math.max(0, Number(fee || 0) || 0);
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
            const mm = mergeVisitById(visitsAll, vid, {
              visit_id: vid,
              is_active: false,
              billing_status: nextBillingStatus,
              cancellation_fee_rate: cancellationRate,
              cancellation_fee_amount: fee,
            });
            visitsAll = mm.list;
          } catch (e) {
            syncWarnCount += 1;
            cancelCommitFailures.push({
              visit_id: vid,
              error: String(e?.message || e || "cancel commit failed"),
            });
          }
        }
        if (cancelCommitFailures.length) {
          const failedIds = cancelCommitFailures
            .map((x) => String(x?.visit_id || "").trim())
            .filter(Boolean);
          toast({
            title: "予約キャンセル確定に失敗",
            message: `${cancelCommitFailures.length}件失敗: ${failedIds.join(", ")}`,
            action: String(cancelCommitFailures[0]?.error || "詳細はログを確認してください。"),
          });
        }
        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        if (syncWarnCount > 0) {
          toast({
            title: "カレンダー同期警告",
            message: "請求書作成は完了しましたが、一部予約のカレンダー同期に失敗しました。",
            action: "設定タブの再同期を実行してから、対象予約を再確認してください。"
          });
        }
      }
      markDirty_();
      toast({ title: "作成完了", message: `${cancellationMode ? "キャンセル請求" : (adjustmentMode ? "追加請求" : "請求書")}ドラフト連携バッチを作成しました。${batchId || ""}`.trim() });
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
              billing_status: prev.billing_status
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
      toast({
        title: createCommitted ? "画面反映警告" : "作成失敗",
        message: msg,
        action: createCommitted
          ? "請求一覧を再読み込みして、作成済みバッチを確認してください。"
          : "料金設定と請求対象を確認後、再実行してください。"
      });
    }
  };

  const runAttachVisitsToInvoice_ = async () => {
    const ids = Array.from(bulkSelected || []);
    if (!ids.length) return;
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
    const inactiveCount = selected.filter((v) => !pickIsActive_(v)).length;
    if (inactiveCount > 0) {
      toast({ title: "対象外あり", message: "キャンセル済み予約は紐づけできません。" });
      return;
    }
    const nonUnbilledCount = selected.filter((v) => pickBillingStatus_(v) !== "unbilled").length;
    if (nonUnbilledCount > 0) {
      toast({ title: "対象外あり", message: "未請求の予約のみ紐づけできます。" });
      return;
    }
    const customerIds = Array.from(new Set(selected.map((v) => String(v?.customer_id || "").trim()).filter(Boolean)));
    if (customerIds.length !== 1) {
      toast({ title: "顧客混在", message: "同一顧客の予約だけを選択してください。" });
      return;
    }
    const customerId = customerIds[0];

    let candidates = [];
    try {
      const listRes = await runWithBlocking_(
        {
          title: "請求書候補を取得しています",
          bodyHtml: "同一顧客の請求書を検索しています。",
          busyText: "取得中..."
        },
        async () => listBillingBatches_({ customer_id: customerId }, idToken2)
      );
      const rows = Array.isArray(listRes?.batches)
        ? listRes.batches
        : (Array.isArray(listRes?.results) ? listRes.results : (Array.isArray(listRes) ? listRes : []));
      candidates = rows.filter((row) => {
        const bid = String(row?.batch_id || "").trim();
        if (!bid) return false;
        const status = normalizeBatchBillingStatus_(row?.billing_status || row?.invoice_status || row?.square_invoice_status);
        if (status !== "billed") return false;
        const batchType = normalizeBillingBatchTypeKey_(row?.batch_type || "invoice");
        return batchType === "invoice" || batchType === "invoice_with_cancellation";
      });
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      return;
    }
    if (!candidates.length) {
      toast({ title: "対象なし", message: "紐づけ可能な請求書がありません。" });
      return;
    }
    const selectId = "mAttachInvoiceSelect";
    const defaultCustomerName = String(selected[0]?.customer_name || "").trim();
    const optionsHtml = candidates.map((row) => {
      const bid = String(row?.batch_id || "").trim();
      const periodStart = String(row?.period_start || "").slice(0, 10).replace(/-/g, "/");
      const periodEnd = String(row?.period_end || "").slice(0, 10).replace(/-/g, "/");
      const periodText = periodStart
        ? `${periodStart}${periodEnd && periodEnd !== periodStart ? `〜${periodEnd}` : ""}`
        : "-";
      const customerName = String(row?.customer_name || defaultCustomerName || "").trim() || "-";
      return `<option value="${escapeHtml(bid)}">${escapeHtml(`${customerName} / ${periodText}`)}</option>`;
    }).join("");
    const pickedBatchId = await showSelectModal({
      title: "紐づけ先の請求書を選択",
      bodyHtml: `
        <div class="p mb-8">選択予約（${escapeHtml(String(ids.length))}件）を既存請求書に追加して再構成します。対象の請求書を選択してください。</div>
        <select id="${escapeHtml(selectId)}" class="select w-100">${optionsHtml}</select>
      `,
      okText: "次へ",
      cancelText: "キャンセル",
      selectId,
    });
    const batchId = String(pickedBatchId || "").trim();
    if (!batchId) return;

    let linkedVisitIds = [];
    try {
      const detailRes = await runWithBlocking_(
        {
          title: "請求書構成を取得しています",
          bodyHtml: "既存請求書の対象予約を読み込んでいます。",
          busyText: "取得中..."
        },
        async () => getBillingBatchDetail_(batchId, idToken2)
      );
      const detail = (detailRes && detailRes.result && typeof detailRes.result === "object") ? detailRes.result : detailRes;
      const links = Array.isArray(detail?.links) ? detail.links : [];
      linkedVisitIds = links
        .filter((x) => {
          if (!x || typeof x !== "object") return false;
          const visit = (x.visit && typeof x.visit === "object") ? x.visit : null;
          if (!visit) return true;
          return visit.is_active !== false;
        })
        .map((x) => String(x?.visit_id || "").trim())
        .filter(Boolean);
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      return;
    }
    if (!linkedVisitIds.length) {
      toast({ title: "対象なし", message: "請求書の対象予約を取得できませんでした。" });
      return;
    }

    const nextVisitIds = Array.from(new Set(linkedVisitIds.concat(ids)));
    await runCreateInvoiceDraft_({
      ids: nextVisitIds,
      cancellation_rate: 0,
      open_batch_detail: true,
      allow_non_unbilled: true,
      allow_inactive: false,
      source_batch_id: batchId,
    });
  };

  // bulk 実行（Optimistic + server bulk-update）
  const runBulkEdit_ = async (pickedItemOpt = "", idsOverride = null) => {
    const ids = Array.isArray(idsOverride)
      ? Array.from(new Set(idsOverride.map((x) => String(x || "").trim()).filter(Boolean)))
      : Array.from(bulkSelected || []);
    if (!ids.length) return;

    const idToken2 = getIdToken();
    if (!idToken2) {
      toast({ title: "未ログイン", message: "再ログインしてください。" });
      return;
    }

    let item = String(pickedItemOpt || "").trim();
    if (!item) {
      const itemSelectId = "mBulkItemSelect";
      const itemBodyHtml = `
        <div class="p mb-8">一括変更する項目を選択してください。</div>
        <select id="${escapeHtml(itemSelectId)}" class="select w-100">
          <option value="done">完了 / 未完了</option>
          <option value="is_active">有効 / キャンセル</option>
          ${isAdminUser_() ? `<option value="reassign_staff">担当者変更</option>` : ``}
        </select>
        <div class="p mt-8 opacity-8">
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
      item = String(pickedItem || "").trim();
    }

    // ===== 変更値選択 =====
    let fields = null;
    let confirmText = "";
    let cancellationRateForBulk = 0;

    if (item === "reassign_staff") {
      if (!isAdminUser_()) {
        await showCancelAdminOnlyModal_();
        return;
      }
      const selected = selectedVisits_(visitsAll, ids);
      const customerIds = Array.from(new Set(
        selected
          .map((v) => String(v?.customer_id || "").trim())
          .filter(Boolean)
      ));
      if (!customerIds.length) {
        toast({ title: "対象外", message: "顧客情報がない予約は担当者変更できません。" });
        return;
      }
      let staffRows = [];
      let assignmentRows = [];
      try {
        const [rows, assignmentResList] = await Promise.all([
          portalSearchStaffs_(idToken2),
          Promise.all(customerIds.map((cid) => portalListCustomerAssignments_(idToken2, {
            customer_id: cid,
            only_active: true,
            role: "all",
          }))),
        ]);
        staffRows = Array.isArray(rows) ? rows : [];
        assignmentRows = assignmentResList.flatMap((x) => (Array.isArray(x?.assignments) ? x.assignments : []));
      } catch (e) {
        toast({ title: "取得失敗", message: e?.message || "スタッフ一覧の取得に失敗しました。" });
        return;
      }
      const assignedStaffIdsByCustomer = {};
      customerIds.forEach((cid) => { assignedStaffIdsByCustomer[cid] = new Set(); });
      assignmentRows.forEach((row) => {
        const cid = String(row?.customer_id || "").trim();
        const sid = String(row?.staff_id || "").trim();
        if (!cid || !sid || !assignedStaffIdsByCustomer[cid]) return;
        assignedStaffIdsByCustomer[cid].add(sid);
      });
      const isAssignedForAllCustomers_ = (staffId) => (
        customerIds.every((cid) => assignedStaffIdsByCustomer[cid] && assignedStaffIdsByCustomer[cid].has(staffId))
      );
      const options = staffRows
        .map((row) => {
          const sid = String((row && (row.staff_id || row.id)) || "").trim();
          if (!sid) return null;
          const sname = String((row && row.name) || sid).trim();
          const linked = isAssignedForAllCustomers_(sid);
          const label = linked ? `${sname} (${sid})` : `+ ${sname} (${sid}) [未担当]`;
          const style = linked ? "" : ' style="color:#7f8ea3;"';
          return `<option value="${escapeHtml(sid)}"${style}>${escapeHtml(label)}</option>`;
        })
        .filter(Boolean);
      if (!options.length) {
        toast({ title: "対象なし", message: "変更先スタッフが取得できませんでした。" });
        return;
      }
      const selectId2 = "mBulkReassignStaffSelect";
      const picked2 = await showSelectModal({
        title: "担当者変更",
        bodyHtml: `
          <div class="p mb-8">変更先スタッフを選択してください。</div>
          <select id="${escapeHtml(selectId2)}" class="select w-100">${options.join("")}</select>
          <div class="p mt-8 opacity-8">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
        `,
        okText: "確認へ",
        cancelText: "キャンセル",
        selectId: selectId2,
      });
      if (picked2 == null) return;
      const nextStaffId = String(picked2 || "").trim();
      if (!nextStaffId) {
        toast({ title: "入力不足", message: "変更先スタッフを選択してください。" });
        return;
      }
      const nextStaff = staffRows.find((row) => String((row && (row.staff_id || row.id)) || "").trim() === nextStaffId) || null;
      const nextStaffLabel = String((nextStaff && nextStaff.name) || nextStaffId).trim();
      const runDry_ = async () => {
        const dry = await callReassignVisitsPolicy({
          visit_ids: ids,
          to_staff_id: nextStaffId,
          reason: "portal_bulk_reassign",
          dry_run: true,
        }, idToken2);
        return (dry && typeof dry === "object" && dry.result && typeof dry.result === "object") ? dry.result : dry;
      };
      let dryPayload = await runDry_();
      let dryPreview = Array.isArray(dryPayload?.preview) ? dryPayload.preview : [];
      let blockedRows = dryPreview.filter((row) => row && row.blocked === true);
      let blockedCompleted = blockedRows.filter((row) => String(row?.blocked_reason || "").trim() === "completed_visit_not_allowed");
      let blockedAssignment = blockedRows.filter((row) => String(row?.blocked_reason || "").trim() === "assignment_not_allowed");
      if (blockedCompleted.length) {
        const listHtml = blockedCompleted
          .slice(0, 20)
          .map((row) => `<li>${escapeHtml(String(row?.visit_id || ""))}</li>`)
          .join("");
        await showModal({
          title: "変更不可",
          bodyHtml: `
            <p class="p">完了済み予約が含まれるため、担当者変更を実行できません。</p>
            <div class="p mt-8">対象ID</div>
            <ul class="settings-list-flow">${listHtml}${blockedCompleted.length > 20 ? `<li>ほか ${escapeHtml(String(blockedCompleted.length - 20))}件</li>` : ``}</ul>
          `,
          okText: "閉じる",
          cancelText: "",
          danger: false,
        });
        return;
      }
      if (blockedAssignment.length) {
        const missingCustomerIds = Array.from(new Set(
          blockedAssignment
            .map((row) => String(row?.customer_id || "").trim())
            .filter(Boolean)
        ));
        const today = new Date();
        const yyyy = String(today.getFullYear());
        const mm = String(today.getMonth() + 1).padStart(2, "0");
        const dd = String(today.getDate()).padStart(2, "0");
        const defaultDate = `${yyyy}-${mm}-${dd}`;
        const form = await showFormModal({
          title: "担当関係の追加",
          bodyHtml: `
            <form data-el="reassignLinkForm">
              <div class="p mb-8">選択スタッフは未担当の顧客があるため、担当関係を作成してから変更します。</div>
              <div class="p mb-8">対象顧客: <strong>${escapeHtml(String(missingCustomerIds.length))}件</strong></div>
              <label class="field" style="display:block;">
                <div class="label">担当開始日（必須）</div>
                <input class="input" type="date" name="start_date" value="${escapeHtml(defaultDate)}" />
              </label>
              <div class="text-sm text-muted" style="margin-top:8px;">担当開始日を予約日時点より前にしてください。</div>
            </form>
          `,
          okText: "追加して続行",
          cancelText: "キャンセル",
          formSelector: '[data-el="reassignLinkForm"]',
        });
        if (!form) return;
        const startDate = String(form.start_date || "").trim();
        const user = getUser() || {};
        const tenantId = String(user.tenant_id || "").trim() || "TENANT_LEGACY";
        const storeId = String(user.store_id || user.org_id || "").trim();
        if (!startDate) {
          toast({ title: "入力不足", message: "担当開始日を入力してください。" });
          return;
        }
        try {
          await runWithBlocking_(
            {
              title: "担当関係を追加しています",
              bodyHtml: "顧客ごとに担当関係を作成しています。",
              busyText: "追加中...",
            },
            async () => {
              for (const customerId of missingCustomerIds) {
                const res = await portalLinkCustomerAssignment_(idToken2, {
                  customer_id: customerId,
                  staff_id: nextStaffId,
                  role: "sub",
                  start_date: `${startDate}T00:00:00+09:00`,
                  tenant_id: tenantId,
                  store_id: storeId,
                  org_id: storeId,
                });
                if (!res || res.success === false) {
                  throw new Error((res && (res.operator_message || res.error || res.message)) || `customer assignment link failed: ${customerId}`);
                }
              }
            }
          );
        } catch (e) {
          toast({ title: "追加失敗", message: e?.message || String(e || "") });
          return;
        }
        dryPayload = await runDry_();
        dryPreview = Array.isArray(dryPayload?.preview) ? dryPayload.preview : [];
        blockedRows = dryPreview.filter((row) => row && row.blocked === true);
        blockedCompleted = blockedRows.filter((row) => String(row?.blocked_reason || "").trim() === "completed_visit_not_allowed");
        blockedAssignment = blockedRows.filter((row) => String(row?.blocked_reason || "").trim() === "assignment_not_allowed");
        if (blockedCompleted.length || blockedAssignment.length) {
          const rows = blockedRows.slice(0, 20);
          const listHtml = rows
            .map((row) => `<li>${escapeHtml(String(row?.visit_id || ""))} : ${escapeHtml(String(row?.blocked_reason || ""))}</li>`)
            .join("");
          await showModal({
            title: "変更不可",
            bodyHtml: `
              <p class="p">担当者変更の事前チェックでブロックされました。</p>
              <ul class="settings-list-flow">${listHtml}${blockedRows.length > 20 ? `<li>ほか ${escapeHtml(String(blockedRows.length - 20))}件</li>` : ``}</ul>
            `,
            okText: "閉じる",
            cancelText: "",
            danger: false,
          });
          return;
        }
      }
      const unchangedCount = dryPreview.filter((row) => row && row.unchanged === true).length;
      const executableCount = Math.max(0, ids.length - unchangedCount);
      const okReassign = await showModal({
        title: "担当者変更の確認",
        bodyHtml: `
          <p class="p">担当者を <strong>${escapeHtml(nextStaffLabel)}</strong> に変更します。</p>
          <div class="p opacity-9 mt-8">対象：${escapeHtml(String(ids.length))}件</div>
          <div class="p opacity-9">実行対象：${escapeHtml(String(executableCount))}件</div>
          ${unchangedCount > 0 ? `<div class="p opacity-9">変更不要：${escapeHtml(String(unchangedCount))}件</div>` : ``}
        `,
        okText: "実行",
        cancelText: "キャンセル",
        danger: false,
      });
      if (!okReassign) return;
      try {
        const failedRows = await runWithBlocking_(
          {
            title: "担当者変更を実行しています",
            bodyHtml: "予約更新とカレンダー同期を順に実行しています。",
            busyText: "更新中...",
          },
          async () => {
            const out = await callReassignVisitsPolicy({
              visit_ids: ids,
              to_staff_id: nextStaffId,
              reason: "portal_bulk_reassign",
              dry_run: false,
            }, idToken2);
            const result = (out && typeof out === "object" && out.result && typeof out.result === "object") ? out.result : out;
            if (result && result.success === false && !Array.isArray(result.results)) {
              throw new Error(result.error || result.message || "担当者付け替えに失敗しました。");
            }
            const rows = Array.isArray(result?.results) ? result.results : [];
            const failedRows0 = rows.filter((r) => String(r?.status || "") === "failed");
            rows
              .filter((r) => String(r?.status || "") === "success")
              .forEach((r) => {
                const vid = String(r?.visit_id || "").trim();
                const updated = (r && r.updated && typeof r.updated === "object") ? r.updated : null;
                if (!vid || !updated) return;
                const mm = mergeVisitById(visitsAll, vid, Object.assign({ visit_id: vid }, updated));
                visitsAll = mm.list;
              });
            saveCache_(cacheKey_(state), visitsAll);
            applyAndRender_();
            return failedRows0;
          }
        );
        if (failedRows.length) {
          const msg = failedRows
            .slice(0, 3)
            .map((r) => `${String(r?.visit_id || "")}: ${String(r?.error || "失敗")}`)
            .join("\n");
          toast({ title: "一部失敗", message: msg || `失敗: ${failedRows.length}件` });
        } else {
          toast({ title: "更新完了", message: `担当者を変更しました（${ids.length}件）。` });
        }
        clearBulkSelection_();
      } catch (e) {
        toast({ title: "更新失敗", message: e?.message || String(e || "") });
      }
      return;
    } else if (item === "billing_status") {
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK_ };
      const orderedRaw = (opt && Array.isArray(opt.order) && opt.order.length) ? opt.order : Object.keys(map);
      const ordered = filterBillingStatusOptionsByRole_(orderedRaw, map, isAdminUser_());

      const selectId2 = "mBulkBillingSelect";
      const optionsHtml = ordered.map(k => {
        const label = String(map[k] || billingStatusLabel_(k));
        return `<option value="${escapeHtml(String(k))}">${escapeHtml(label)}（${escapeHtml(String(k))}）</option>`;
      }).join("");
      const body2 = `
        <div class="p mb-8">請求ステータス（変更後）を選択してください。</div>
        <select id="${escapeHtml(selectId2)}" class="select w-100">${optionsHtml}</select>
        <div class="p mt-8 opacity-8">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
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
        <div class="p mb-8">完了状態（変更後）を選択してください。</div>
        <select id="${escapeHtml(selectId2)}" class="select w-100">
          <option value="done">完了</option>
          <option value="open">未完了</option>
        </select>
        <div class="p mt-8 opacity-8">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
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
      if (!isAdminUser_()) {
        await showCancelAdminOnlyModal_();
        return;
      }
      const selectId2 = "mBulkActiveSelect";
      const body2 = `
        <div class="p mb-8">有効/キャンセル（変更後）を選択してください。</div>
        <select id="${escapeHtml(selectId2)}" class="select w-100">
          <option value="active">有効</option>
          <option value="inactive">キャンセル</option>
        </select>
        <div class="p mt-8 opacity-8">対象：<strong>${escapeHtml(String(ids.length))}件</strong></div>
      `;
      const picked2 = await showSelectModal({
        title: "一括編集（有効/キャンセル）",
        bodyHtml: body2,
        okText: "確認へ",
        cancelText: "キャンセル",
        selectId: selectId2,
      });
      if (picked2 == null) return;
      const nextActive = (String(picked2) === "active");
      fields = { is_active: nextActive };
      confirmText = `有効ステータスを「${nextActive ? "有効" : "キャンセル"}」に変更`;
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
        toast({ title: "変更不可", message: "完了済みの予約はキャンセルにできません。未完了に戻してから実行してください。" });
        return;
      }
      const useDraftFlow = (cancellationRateForBulk === 50 || cancellationRateForBulk === 100);
      const policyIds = Array.from(new Set(
        ids.map((x) => String(x || "").trim()).filter(Boolean)
      ));
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
        if (preview?.blocked === true) {
          toast({
            title: preview?.admin_required ? "管理者権限が必要です" : "キャンセル不可",
            message: String(preview?.message || "この予約はキャンセルできません。").trim(),
          });
          return;
        }
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
      const failedRows = [];
      let succeededRows = 0;
      let manualRefundRequiredCount = 0;
      let cancellationInvoiceRequiredCount = 0;
      const confirmedFullBatchZeroCancelKeys = new Set();
      const draftConfirmDecisionByBatch = new Map();
      const fullBatchPaidConfirmDecisionByKey = new Map();
      const cancellationPlans = [];

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
          if (previewStatus === "paid") {
            const confirmKey = batchId || `visit:${vid}`;
            if (fullBatchPaidConfirmDecisionByKey.has(confirmKey)) {
              discountDecision = fullBatchPaidConfirmDecisionByKey.get(confirmKey);
              if (!discountDecision) return;
            } else {
              const msg = buildCancelPolicyMessage_(preview);
              discountDecision = await confirmCancelPreview_(preview, msg);
              fullBatchPaidConfirmDecisionByKey.set(confirmKey, discountDecision || null);
              if (!discountDecision) return;
            }
          } else {
            discountDecision = {
              discount_mode: "keep",
              discount_amount: Math.max(0, Number(preview?.current_discount_amount || 0) || 0),
            };
          }
        } else {
          const shouldReuseDraftConfirm = useDraftFlow
            && previewStatus === "billed"
            && !!batchId
            && !isFullBatchCancel;
          if (shouldReuseDraftConfirm && draftConfirmDecisionByBatch.has(batchId)) {
            discountDecision = draftConfirmDecisionByBatch.get(batchId);
            if (!discountDecision) return;
          } else {
            const msg = buildCancelPolicyMessage_(preview);
            discountDecision = await confirmCancelPreview_(preview, msg);
            if (shouldReuseDraftConfirm) draftConfirmDecisionByBatch.set(batchId, discountDecision || null);
            if (!discountDecision) return;
          }
        }
        cancellationPlans.push({
          vid,
          preview,
          previewStatus,
          selectedSet,
          activeVisitIds,
          isFullBatchCancel,
          discountDecision,
        });
      }

      for (const plan of cancellationPlans) {
        const {
          vid,
          preview,
          previewStatus,
          selectedSet,
          activeVisitIds,
          isFullBatchCancel,
          discountDecision,
        } = plan;
        try {
          const flow = await runCancelVisitFlow_(vid, idToken3, {
            source: "portal",
            cancellation_rate: cancellationRateForBulk,
            current_billing_status: previewStatus,
            preview_override: preview,
            discount_decision: discountDecision,
            defer_invoice_draft: previewStatus !== "paid"
              && !(cancellationRateForBulk === 0 && isFullBatchCancel),
            show_blocked_modal: false,
          });
          if (flow?.skipped) {
            if (flow?.blocked) {
              failedRows.push({
                visit_id: vid,
                error: String(flow?.message || flow?.preview?.message || "この操作は実行できません。"),
              });
            }
            continue;
          }
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
          succeededRows += 1;
          if (done?.square_action === "manual_refund_required") manualRefundRequiredCount += 1;
          if (done?.next_action === "create_cancellation_invoice") cancellationInvoiceRequiredCount += 1;
        } catch (e) {
          failedRows.push({
            visit_id: vid,
            error: e?.message || "失敗",
          });
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
      if (!failedRows.length && succeededRows > 0 && !draftRequests.length) {
        let msg = `一括キャンセルしました（${succeededRows}件）。`;
        if (manualRefundRequiredCount > 0) {
          msg += ` Squareで返金処理が必要です（${manualRefundRequiredCount}件）。`;
        } else if (cancellationInvoiceRequiredCount > 0) {
          msg += ` キャンセル料の請求書作成が必要です（${cancellationInvoiceRequiredCount}件）。`;
        }
        toast({ title: "更新完了", message: msg });
      }
      if (failedRows.length) {
        const msg = failedRows
          .slice(0, 3)
          .map((r) => `${String(r?.visit_id || "")}: ${String(r?.error || "失敗")}`)
          .join("\n");
        toast({ title: "一部失敗", message: msg || `失敗: ${failedRows.length}件` });
      }
      return;
    }

    if (item === "is_active" && fields && fields.is_active === true) {
      const policyIds = Array.from(new Set(
        ids.map((x) => String(x || "").trim()).filter(Boolean)
      ));
      if (!policyIds.length) return;

      const idToken3 = getIdToken();
      if (!idToken3) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      const previewByVisitId = {};
      const previewFailedRows = [];
      for (const vid of policyIds) {
        try {
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
        } catch (e) {
          previewFailedRows.push({
            visit_id: vid,
            error: e?.message || "失敗",
          });
        }
      }
      if (previewFailedRows.length) {
        const msg = previewFailedRows
          .slice(0, 3)
          .map((r) => `${String(r?.visit_id || "")}: ${String(r?.error || "失敗")}`)
          .join("\n");
        toast({ title: "再有効化準備失敗", message: msg || `失敗: ${previewFailedRows.length}件` });
        return;
      }

      const requireConfirm = policyIds.some((vid) => previewByVisitId[vid]?.require_confirm === true);
      if (requireConfirm) {
        const hasBilledConfirm = policyIds.some((vid) => {
          const s = String(previewByVisitId[vid]?.billing_status || previewByVisitId[vid]?.visit_billing_status || "").trim().toLowerCase();
          return ["billed", "invoicing", "invoiced", "sent", "scheduled", "partially_paid", "published"].includes(s);
        });
        const hasDraftConfirm = !hasBilledConfirm && policyIds.some((vid) => {
          const s = String(previewByVisitId[vid]?.billing_status || previewByVisitId[vid]?.visit_billing_status || "").trim().toLowerCase();
          return ["draft", "invoice_draft", "pending", "unpaid"].includes(s);
        });
        const ok2 = await showModal({
          title: hasBilledConfirm
            ? "送付済み請求の再発行確認"
            : (hasDraftConfirm ? "下書き更新の確認" : "確認"),
          bodyHtml: `
            <p class="p">${hasBilledConfirm ? "有効ステータスを「有効」に変更し、送付済み請求書を再発行します。" : "有効ステータスを「有効」に変更します。"}</p>
            <div class="p opacity-9 mt-8">
              対象：${escapeHtml(String(policyIds.length))}件<br/>
              ${hasDraftConfirm ? "下書き請求書がある予約は下書きを更新して再有効化します。" : "キャンセル請求書がある予約は請求書を取り消してから再有効化します。"}
            </div>
          `,
          okText: hasBilledConfirm ? "再発行して実行" : (hasDraftConfirm ? "下書きを更新して実行" : "実行"),
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
    const selectedForConfirm = selectedVisits_(visitsAll, ids);
    const selectedByIdForConfirm = new Map(
      selectedForConfirm.map((v) => [String(v?.visit_id || "").trim(), v])
    );
    const confirmTitleRows = ids.map((id) => {
      const vid = String(id || "").trim();
      const vv = selectedByIdForConfirm.get(vid) || null;
      const title = String(vv?.title || "").trim() || "（無題）";
      return `<li>${escapeHtml(title)}</li>`;
    });
    const confirmTitleRowsMax = 20;
    const confirmTitleRowsVisible = confirmTitleRows.slice(0, confirmTitleRowsMax);
    const confirmTitleHiddenCount = Math.max(0, confirmTitleRows.length - confirmTitleRowsVisible.length);
    const confirmTitleListHtml = (item === "done")
      ? `
        <div class="p mt-8">対象予約</div>
        <ul class="settings-list-flow">
          ${confirmTitleRowsVisible.join("")}
          ${confirmTitleHiddenCount > 0 ? `<li>ほか ${escapeHtml(String(confirmTitleHiddenCount))}件</li>` : ``}
        </ul>
      `
      : "";
    const ok = await showModal({
      title: "確認",
      bodyHtml: `
        <p class="p">${escapeHtml(confirmText)}します。</p>
        <div class="p opacity-9 mt-8">
          対象：${escapeHtml(String(ids.length))}件
        </div>
        ${confirmTitleListHtml}
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
        toast({ title: "更新不可", message: "キャンセル済みの予約は完了にできません。" });
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
    if (state.billing_filter) {
      filtered = filtered.filter((v) => normalizeBillingStatusFilterKey_(v?.billing_status) === state.billing_filter);
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
        visitsAll = await enrichVisitsPetNames_(idToken, cached);
        saveCache_(ck, visitsAll);
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
        // キャッシュ描画後もAPI再取得して表示差分を同期する
      }
    }

    let res;
    try {
      const payload = {
        date_from: state.date_from,
        date_to: state.date_to_ymd + " 23:59:59",
      };
      if (isAdmin && state.staff_filter) payload.staff_id = state.staff_filter;
      res = await portalVisitsList_(idToken, payload);
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

    visitsAll = await enrichVisitsPetNames_(idToken, visits);
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
      billing_filter: "",
      staff_filter: isAdmin ? "" : state.staff_filter,
    };
    if (fromEl) fromEl.value = state.date_from;
    if (toEl) toEl.value = state.date_to_ymd;
    if (kwEl) kwEl.value = state.keyword;
    if (doneEl) doneEl.value = state.done_filter;
    if (activeEl) activeEl.value = state.active_filter;
    if (billingEl) billingEl.value = state.billing_filter;
    if (sortEl) sortEl.value = state.sort_order;
    if (staffEl) staffEl.value = state.staff_filter;
    if (isAdmin) updateVisitsHashStaffId_(state.staff_filter);
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

  billingEl?.addEventListener("change", () => {
    state.billing_filter = String(billingEl.value || "").trim();
    saveState_(state);
    applyAndRender_();
  });
  
  sortEl?.addEventListener("change", () => {
    state.sort_order = sortEl.value || "asc";
    saveState_(state);
    applyAndRender_();
  });

  if (isAdmin && staffEl) {
    const idToken = getIdToken();
    if (idToken) {
      try {
        const rows = await portalSearchStaffs_(idToken);
        const list = Array.isArray(rows) ? rows : [];
        const current = String(state.staff_filter || "").trim();
        const options = [`<option value="">全スタッフ</option>`];
        let hasCurrent = !current;
        list.forEach((row) => {
          const sid = String((row && (row.staff_id || row.id)) || "").trim();
          if (!sid) return;
          const selected = sid === current ? " selected" : "";
          if (selected) hasCurrent = true;
          options.push(`<option value="${escapeHtml(sid)}"${selected}>${escapeHtml(toStaffLabel_(row))}</option>`);
        });
        if (current && !hasCurrent) {
          options.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
        }
        staffEl.innerHTML = options.join("");
        staffEl.value = current;
      } catch (_) {
      }
    }
    staffEl.addEventListener("change", async () => {
      state.staff_filter = String(staffEl.value || "").trim();
      saveState_(state);
      const hashChanged = updateVisitsHashStaffId_(state.staff_filter);
      if (hashChanged) return;
      await fetchAndRender_({ force: true });
    });
  }

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
      else if (bulkAction === "bulk-create-adjustment-draft") await runCreateInvoiceDraft_({ billing_mode: "adjustment", allow_non_unbilled: true, allow_inactive: false, open_batch_detail: true });
      else if (bulkAction === "bulk-attach-to-invoice") await runAttachVisitsToInvoice_();
      else if (bulkAction === "bulk-edit-active") await runBulkEdit_("is_active");
      else if (bulkAction === "bulk-reassign-staff") await runBulkEdit_("reassign_staff");
      else await runBulkEdit_("done");
      return;
    }
  });

  bulkBarEl?.addEventListener("change", (e) => {
    const sel = e.target.closest('select[data-role="bulk-action"]');
    if (sel) {
      bulkAction = String(sel.value || "bulk-edit-done").trim();
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

    if (action === "reassign-staff") {
      await runBulkEdit_("reassign_staff", [vid]);
      return;
    }

    if (action === "toggle-meeting-notify") {
      if (actEl.dataset.busy === "1") return;
      const currentStatus = normalizeMeetingNotifyStatus_(card?.dataset?.meetingNotifyStatus || "");
      if (!currentStatus) return;
      const nextStatus = currentStatus === "manual_sent" ? "manual_send_required" : "manual_sent";
      const ok = await showModal({
        title: "通知確認ステータス",
        bodyHtml: `<p class="p">「${escapeHtml(meetingNotifyBadgeLabel_(currentStatus))}」を「${escapeHtml(meetingNotifyBadgeLabel_(nextStatus))}」に変更します。よろしいですか？</p>`,
        okText: "変更",
        cancelText: "キャンセル",
      });
      if (!ok) return;
      actEl.dataset.busy = "1";
      const prevStatus = currentStatus;
      const prevText = actEl.textContent;
      const prevClassName = actEl.className;
      try {
        const idToken2 = getIdToken();
        if (!idToken2) {
          toast({ title: "未ログイン", message: "再ログインしてください。" });
          return;
        }
        const out = await portalMeetingNotificationManualStatusUpdate_(idToken2, {
          visit_id: vid,
          status: nextStatus,
        });
        const u = unwrapResults(out);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");
        if (card) card.dataset.meetingNotifyStatus = nextStatus;
        actEl.textContent = meetingNotifyBadgeLabel_(nextStatus);
        actEl.className = `${meetingNotifyBadgeClass_(nextStatus)} is-clickable`;
        toast({ title: "更新完了", message: "通知確認ステータスを更新しました。" });
      } catch (err) {
        if (card) card.dataset.meetingNotifyStatus = prevStatus;
        actEl.textContent = prevText;
        actEl.className = prevClassName;
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "toggle-active") {
      if (actEl.dataset.busy === "1") return;
      if (!isAdminUser_()) {
        await showCancelAdminOnlyModal_();
        return;
      }

      const currentActive = (card?.dataset?.isActive === "1");
      const nextActive = !currentActive;
      const currentDone = (card?.dataset?.done === "1");
      const currentBillingStatus = normalizeCancelBillingStatus_(card?.dataset?.billingStatus || "");
      if (!nextActive && currentDone) {
        toast({ title: "変更不可", message: "完了済みの予約はキャンセルにできません。未完了に戻してから実行してください。" });
        return;
      }

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
              allow_inactive: true,
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
            billing_status: String(done?.updated?.billing_status || currentBillingStatus).trim() || currentBillingStatus,
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
        // キャンセル/再有効化は同一請求バッチ内の他予約バッジにも影響し得るため、即時に一覧を再取得する。
        await fetchAndRender_({ force: true });
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
      if (!isAdminUser_()) {
        await showCancelAdminOnlyModal_();
        return;
      }

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }
      const currentKey = String(card?.dataset?.billingStatus || "").trim() || "unbilled";
      let nextKey = "";
      let confirmBody = "";
      let confirmOkText = "変更";
      if (currentKey === "unbilled") {
        nextKey = "no_billing_required";
        confirmBody = `<p class="p">この予約を「請求不要」に変更します。よろしいですか？</p>`;
      } else if (currentKey === "no_billing_required") {
        nextKey = "unbilled";
        confirmOkText = "ロールバック";
        confirmBody = `<p class="p">この予約を「未請求」にロールバックします。よろしいですか？</p>`;
      } else {
        toast({ title: "変更不可", message: "このステータスからは請求不要へ変更できません。" });
        return;
      }

      const confirmed = await showModal({
        title: "請求ステータス変更",
        bodyHtml: confirmBody,
        okText: confirmOkText,
        cancelText: "キャンセル",
      });
      if (!confirmed) return;

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevKey = currentKey;

      // ===== Optimistic UI（即時反映）=====
      if (card) card.dataset.billingStatus = nextKey;
      actEl.textContent = billingStatusLabel_(nextKey);
      applyBillingStatusStageClass_(actEl, nextKey);

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
        applyBillingStatusStageClass_(actEl, prevKey);

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
        const isDone = card?.dataset?.done === "1";
        if (isDone) {
          toast({ title: "変更不可", message: "完了済みの予約は訪問基本料金を変更できません。" });
          return;
        }
        const normalizedStatus = normalizeBillingStatusForPriceRuleEdit_(card?.dataset?.billingStatus || v?.billing_status || "");
        if (normalizedStatus === "paid") {
          toast({ title: "変更不可", message: "支払済みの予約は訪問基本料金を変更できません。" });
          return;
        }
        if (normalizedStatus === "billed") {
          if (!isAdminUser_()) {
            toast({ title: "変更不可", message: "請求作成済みの予約の商品変更は管理者のみ可能です。" });
            return;
          }
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
        const nextDuration = Number(chosen.duration_minutes || 0) || 0;
        if (!nextRuleId || nextRuleId === prevRuleId) return;

        if (card) card.dataset.priceRuleId = nextRuleId;
        actEl.textContent = String(chosen.label || nextRuleId);

        const up = await callUpdateVisitPolicy({
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: Object.assign(
            { price_rule_id: nextRuleId },
            nextDuration > 0 ? { duration_minutes: nextDuration } : {}
          ),
        }, idToken2);
        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        const uu = (u && u.updated && typeof u.updated === "object") ? u.updated : u;
        if (uu?.title && titleEl) titleEl.textContent = String(uu.title);

        const patch = {
          visit_id: vid,
          price_rule_id: nextRuleId,
          price_rule_label: String(chosen.label || nextRuleId),
          ...(nextDuration > 0 ? { duration_minutes: nextDuration } : {}),
          ...(uu?.title ? { title: uu.title } : {}),
          ...(uu?.duration_minutes != null ? { duration_minutes: uu.duration_minutes } : {}),
          ...(uu?.invoice_reconcile_required != null ? { invoice_reconcile_required: uu.invoice_reconcile_required } : {}),
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
        toast({ title: "更新不可", message: "キャンセル済みの予約は完了状態を変更できません。" });
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


