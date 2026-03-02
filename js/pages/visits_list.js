// js/pages/visits_list.js
import { render, toast, escapeHtml, showModal, showSelectModal, showFormModal, fmt, displayOrDash, fmtDateTimeJst, openBlockingOverlay } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken, getUser } from "../auth.js";
import { updateVisitDone } from "./visit_done_toggle.js";
import { toggleVisitType, visitTypeLabel, ensureVisitTypeOptions } from "./visit_type_toggle.js";
import { parkingFeeRuleLabel, pickParkingFeeRule } from "./parking_fee_toggle.js";
import { confirmKeyLocationBeforeBulkDone, confirmKeyLocationBeforeDone } from "./visit_done_key_location.js";

const BILLING_STATUS_LABELS_FALLBACK = {
  unbilled:   "未請求",
  invoicing: "請求中",
  paid:      "支払済",
  cancelled: "キャンセル",
  refunded:  "返金済",
  failed:    "支払失敗",
  voided:    "請求取消",
};

let _billingStatusLabelMapCache = null; // { [key]: label }
let _billingStatusOrderCache = null;    // string[]（GAS results の順序）

function billingStatusLabel_(key) {
  const k0 = String(key || "").trim();
  // 仕様：初期値は unbilled。空や欠損はUI上 unbilled 扱い（DB更新はしない）
  const k = k0 ? k0 : "unbilled";
  if (_billingStatusLabelMapCache && _billingStatusLabelMapCache[k]) return _billingStatusLabelMapCache[k];
  return BILLING_STATUS_LABELS_FALLBACK[k] || k;
}

async function ensureBillingStatusLabelMap_(idToken) {
  if (_billingStatusLabelMapCache && Array.isArray(_billingStatusOrderCache)) {
    return { map: _billingStatusLabelMapCache, order: _billingStatusOrderCache };
  }
  try {
    const resp = await callGas({ action: "getBillingStatusOptions" }, idToken);
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
    if (!map.unbilled) map.unbilled = BILLING_STATUS_LABELS_FALLBACK.unbilled || "未請求";
    if (!order.includes("unbilled")) order.unshift("unbilled");

    _billingStatusLabelMapCache = Object.keys(map).length ? map : { ...BILLING_STATUS_LABELS_FALLBACK };
    _billingStatusOrderCache = order;
  } catch (_) {
    _billingStatusLabelMapCache = { ...BILLING_STATUS_LABELS_FALLBACK };
    _billingStatusOrderCache = Object.keys(_billingStatusLabelMapCache);
  }
  return { map: _billingStatusLabelMapCache, order: _billingStatusOrderCache };
}

// ===== sessionStorage keys =====
const KEY_VF_STATE = "mf:visits_list:state:v1";
const KEY_VF_CACHE = "mf:visits_list:cache:v1";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善目的）

const KEY_VLIST_SCROLL_Y = "mf:visits_list:scroll_y:v1";
const KEY_VLIST_SCROLL_RESTORE_ONCE = "mf:visits_list:scroll_restore_once:v1";
const KEY_VLIST_DIRTY = "mf:visits_list:dirty:v1";

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

function pickVisitType_(v) {
  return String(v?.visit_type || "").trim();
}

function collectVisitTypes_(list) {
  const set = new Set();
  (list || []).forEach(v => {
    const t = pickVisitType_(v);
    if (t) set.add(t);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "ja"));
}

function pickStartIso_(v) {
  return v?.start_time || "";
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
  const next = list.slice();
  next[idx] = merged;
  return { list: next, idx, merged };
}

function isAdminUser_() {
  const user = getUser() || {};
  return String(user.role || "").toLowerCase() === "admin";
}

function formatMoney_(n) {
  const v = Number(n || 0) || 0;
  return v.toLocaleString("ja-JP");
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
      作成すると選択した予約の請求ステータスは「請求中」に更新されます。
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
  const root = rootEl || document;
  const nodes = root.querySelectorAll('[data-role="visit-type-badge"]');
  nodes.forEach((el) => {
    const key = el?.dataset?.visitType || "";
    el.textContent = visitTypeLabel(key);
  });
}

async function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  try {
    return await task(blocker);
  } finally {
    blocker.close();
  }
}

// ===== bulk edit helpers =====
function pickBillingStatus_(v) {
  return String(v?.billing_status || "").trim() || "unbilled";
}

function pickIsActive_(v) {
  return isActive_(v);
}

function cardHtml(v) {
  // v のスキーマはGAS返却に合わせる（不足項目は安全にフォールバック）
  const startRaw = v.start_time || "";
  const start = fmtDateTimeJst(startRaw);
  const title = v.title || "(無題)";
  const customer = v.customer_name || "";
  const productName = String(v.product_name || v.service_name || "").trim();
  const variantName = String(v.variant_name || "").trim();
  const vid = v.visit_id || "";
  const done = isDone_(v);
  const visitType = v.visit_type || "";
  const billingStatus = String(v.billing_status || "").trim() || "unbilled";
  const parkingFeeRule = String(v.parking_fee_rule || "").trim();
  const isActive = !(v.is_active === false || String(v.is_active || "").toLowerCase() === "false");
  const vid2 = String(vid || "").trim();

  return `
    <div class="card"
      data-visit-id="${escapeHtml(vid)}"
      data-done="${done ? "1" : "0"}"
      data-billing-status="${escapeHtml(String(billingStatus))}"
      data-parking-fee-rule="${escapeHtml(String(parkingFeeRule))}"
      data-is-active="${isActive ? "1" : "0"}"
    >
      <div class="card-bulk-check"
        data-role="bulk-check-wrap"
        style="display:none;
        margin-bottom:8px;"
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
        ${productName ? `<div>${escapeHtml(productName)}</div>` : ``}
        ${variantName ? `<div>${escapeHtml(variantName)}</div>` : ``}
      </div>
      <div class="badges" data-role="badges">
        <span class="badge badge-visit-type"
          data-action="change-visit-type"
          style="cursor:pointer;"
          title="タップで訪問タイプを変更"
          data-role="visit-type-badge"
          data-visit-type="${escapeHtml(String(visitType || ""))}">
          ${escapeHtml(visitTypeLabel(visitType))}
        </span>
        <span class="badge badge-billing-status"
          data-action="change-billing-status"
          style="cursor:pointer;"
          title="タップで請求ステータスを変更"
        >
          ${escapeHtml(displayOrDash(fmt(billingStatusLabel_(billingStatus)), "未請求"))}
        </span>
        <span class="badge"
          data-action="change-parking-fee-rule"
          style="cursor:pointer;"
          title="タップで駐車料金区分を変更"
        >
          ${escapeHtml(parkingFeeRuleLabel(parkingFeeRule))}
        </span>
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
  let bulkMode = false;               // ON/OFF（一覧内のみ）
  let bulkSelected = new Set();       // Set<visit_id>

  let state = {
    date_from: (saved && saved.date_from) ? String(saved.date_from) : init.date_from,
    date_to_ymd: (saved && saved.date_to_ymd) ? String(saved.date_to_ymd) : init.date_to.slice(0, 10),
    keyword: (saved && typeof saved.keyword === "string") ? saved.keyword : "",
    sort_order: (saved && saved.sort_order) ? String(saved.sort_order) : "asc", // 近い順（運用上、次の予定が見やすい）
    done_filter: (saved && saved.done_filter) ? String(saved.done_filter) : "open_first", // open_first | open_only | done_only | all
    type_filter: (saved && saved.type_filter) ? String(saved.type_filter) : "all", // all | <visit_type>
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
            <div class="p">訪問種別</div>
            <select id="vfTypeFilter" class="select">
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
      <div class="row" id="vfStatusBadges" style="margin-top: 10px;"></div>
      <div class="row" id="bulkBar" style="margin-top: 10px; display:none; gap:8px; align-items:center; flex-wrap:wrap;">
        <button class="btn" type="button" data-action="bulk-toggle">一括編集: OFF</button>
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
  const typeEl = appEl.querySelector("#vfTypeFilter");
  const activeEl = appEl.querySelector("#vfActiveFilter");
  const sortEl = appEl.querySelector("#vfSortOrder");
  const badgesEl = appEl.querySelector("#vfStatusBadges");
  const bulkBarEl = appEl.querySelector("#bulkBar");

  if (fromEl) fromEl.value = state.date_from;
  if (toEl) toEl.value = state.date_to_ymd;
  if (kwEl) kwEl.value = state.keyword;
  if (doneEl) doneEl.value = state.done_filter;
  if (typeEl) typeEl.value = state.type_filter;
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

  const updateStatusBadges_ = (countShown, countAll) => {
    if (!badgesEl) return;
    const kw = normalizeKeyword_(state.keyword);
    const doneLabel =
      state.done_filter === "open_only" ? "未完了のみ" :
      state.done_filter === "done_only" ? "完了のみ" :
      state.done_filter === "all" ? "すべて" :
      "未完了優先";
    const typeLabel =
      (state.type_filter && state.type_filter !== "all")
        ? visitTypeLabel(state.type_filter)
        : "すべて";
    const activeLabel = (state.active_filter === "include_deleted") ? "含める" : "除外";
    badgesEl.innerHTML = [
      `<span class="badge">期間: ${escapeHtml(state.date_from)} → ${escapeHtml(state.date_to_ymd)}</span>`,
      `<span class="badge">完了状態: ${escapeHtml(doneLabel)}</span>`,
      `<span class="badge">種別: ${escapeHtml(typeLabel)}</span>`,
      `<span class="badge">削除済み: ${escapeHtml(activeLabel)}</span>`,
      `<span class="badge">並び: ${escapeHtml(state.sort_order === "desc" ? "新しい順" : "近い順")}</span>`,
      `<span class="badge">検索: ${escapeHtml(kw ? state.keyword : "なし")}</span>`,
      `<span class="badge">表示: ${escapeHtml(String(countShown))}/${escapeHtml(String(countAll))}</span>`,
    ].join(" ");
  };

  // ===== bulk edit UI =====
  const updateBulkBar_ = () => {
    if (!bulkBarEl) return;
    const count = bulkSelected.size;
    const canInvoice = isAdminUser_();
    bulkBarEl.style.display = "flex";
    bulkBarEl.innerHTML = [
      `<button class="btn" type="button" data-action="bulk-toggle">一括編集: ${bulkMode ? "ON" : "OFF"}</button>`,
      `<span class="badge">選択: ${escapeHtml(String(count))}件</span>`,
      `<button class="btn btn-ghost" type="button" data-action="bulk-clear" ${count ? "" : "disabled"}>全解除</button>`,
      `<button class="btn" type="button" data-action="bulk-run" ${count ? "" : "disabled"}>一括変更</button>`,
      canInvoice ? `<button class="btn" type="button" data-action="bulk-create-invoice-draft" ${count ? "" : "disabled"}>請求ドラフト作成</button>` : ``,
    ].join("");
  };

  const applyBulkModeToDom_ = () => {
    if (!listEl) return;
    const wraps = listEl.querySelectorAll('[data-role="bulk-check-wrap"]');
    wraps.forEach(el => { el.style.display = bulkMode ? "block" : "none"; });
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

  const setBulkMode_ = (next) => {
    bulkMode = !!next;
    if (!bulkMode) {
      // OFFにしたら選択もクリア（事故防止）
      bulkSelected = new Set();
    }
    applyBulkModeToDom_();
  };

  const clearBulkSelection_ = () => {
    bulkSelected = new Set();
    applyBulkModeToDom_();
  };

  const runCreateInvoiceDraft_ = async () => {
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

    const customerIds = Array.from(new Set(selected.map(v => String(v?.customer_id || "").trim()).filter(Boolean)));
    if (customerIds.length !== 1) {
      toast({ title: "顧客混在", message: "同一顧客の予約だけを選択してください。" });
      return;
    }

    const activeSelected = selected.filter(v => isActive_(v));
    if (activeSelected.length !== selected.length) {
      toast({ title: "対象外あり", message: "削除済み予約は請求ドラフト対象にできません。" });
      return;
    }

    const feeRuleGroups = await runWithBlocking_(
      {
        title: "商品を読み込んでいます",
        bodyHtml: "BillingPriceRules から追加料金と一般商品を取得しています。",
        busyText: "読み込み中..."
      },
      async () => {
        const res = await callGas({ action: "listBillingPriceRules", only_active: true }, idToken2);
        const results = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
        return {
          additionalFeeRules: results.filter((rule) => String(rule?.item_type || "").trim() === "additional_fee"),
          merchandiseRules: results.filter((rule) => String(rule?.item_type || "").trim() === "merchandise")
        };
      }
    );
    const additionalFeeRules = Array.isArray(feeRuleGroups?.additionalFeeRules) ? feeRuleGroups.additionalFeeRules : [];
    const merchandiseRules = Array.isArray(feeRuleGroups?.merchandiseRules) ? feeRuleGroups.merchandiseRules : [];

    const formValues = await showFormModal({
      title: "請求ドラフト設定",
      bodyHtml: buildInvoiceDraftFormHtml_(additionalFeeRules, merchandiseRules),
      okText: "明細確認へ",
      cancelText: "キャンセル",
      formSelector: '[data-el="invoiceDraftForm"]'
    });
    if (formValues == null) return;

    const payload = buildInvoiceDraftPayload_(customerIds[0], selected, formValues, additionalFeeRules, merchandiseRules);

    const preview = await runWithBlocking_(
      {
        title: "請求ドラフトを計算しています",
        bodyHtml: "選択した予約の請求明細を作成しています。",
        busyText: "計算中..."
      },
      async () => {
        const res = await callGas({ action: "previewInvoiceDraft", ...payload }, idToken2);
        return (res && res.result && typeof res.result === "object") ? res.result : res;
      }
    );

    const ok = await showModal({
      title: "請求ドラフト確認",
      bodyHtml: buildInvoicePreviewHtml_(preview, selected),
      okText: "作成",
      cancelText: "キャンセル"
    });
    if (!ok) return;

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

    try {
      selected.forEach((v) => {
        const vid = String(v?.visit_id || "").trim();
        if (!vid) return;
        const mm = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: "invoicing" });
        visitsAll = mm.list;
      });
      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();

      const created = await runWithBlocking_(
        {
          title: "請求ドラフトを作成しています",
          bodyHtml: "Invoices / InvoiceLines / Visits へ反映しています。",
          busyText: "作成中..."
        },
        async () => {
          const res = await callGas({ action: "createInvoiceDraft", ...payload }, idToken2);
          return (res && res.result && typeof res.result === "object") ? res.result : res;
        }
      );

      const invoiceId = String(created?.invoice_id || "");
      selected.forEach((v) => {
        const vid = String(v?.visit_id || "").trim();
        if (!vid) return;
        const mm = mergeVisitById(visitsAll, vid, { visit_id: vid, billing_status: "invoicing", latest_invoice_id: invoiceId });
        visitsAll = mm.list;
      });
      saveCache_(cacheKey_(state), visitsAll);
      applyAndRender_();
      toast({ title: "作成完了", message: `請求ドラフトを作成しました。${invoiceId || ""}`.trim() });
      setBulkMode_(false);
    } catch (err) {
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
      toast({ title: "作成失敗", message: err?.message || String(err || "") });
    }
  };

  // bulk 実行（Optimistic + GAS bulkUpdateVisits）
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
        <option value="billing_status">請求ステータス</option>
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

    if (item === "billing_status") {
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK };
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
    } else {
      toast({ title: "対象外", message: "この項目は未対応です。" });
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

    // ===== Server: GAS bulkUpdateVisits =====
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

          const up = await callGas({
            action: "bulkUpdateVisits",
            origin: "portal",
            source: "portal",
            updates,
          }, idToken2);

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

      setBulkMode_(false);
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

  const rebuildTypeOptions_ = () => {
    if (!typeEl) return;
    const base = (state.active_filter === "active_only")
      ? visitsAll.filter(v => isActive_(v))
      : visitsAll;
    const types = collectVisitTypes_(base);
    const current = String(state.type_filter || "all");
    typeEl.innerHTML = [
      `<option value="all">すべて</option>`,
      ...types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(visitTypeLabel(t))}</option>`)
    ].join("");
    // 既存選択が無効なら all に戻す
    const exists = (current === "all") || types.includes(current);
    state.type_filter = exists ? current : "all";
    typeEl.value = state.type_filter;
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

    // 訪問種別フィルタ
    if (state.type_filter && state.type_filter !== "all") {
      filtered = filtered.filter(v => pickVisitType_(v) === state.type_filter);
    }

    // 並び（未完了優先は open_first のときのみ）
    const sortMode = (state.done_filter === "all") ? "all" : "open_first";
    const sorted = sortVisits_(filtered, state.sort_order, sortMode);

    if (!sorted.length) {
      listEl.innerHTML = `<p class="p">条件に一致する予約がありません。</p>`;
      // 表示母数は「削除済みフィルタ」適用後の base を優先
      const baseCount = (state.active_filter === "active_only") ? base.length : visitsAll.length;
      updateStatusBadges_(0, baseCount);
      return;
    }

    // 再描画（並び順の整合性を優先）
    const y = window.scrollY;
    listEl.innerHTML = sorted.map(cardHtml).join("");
    window.scrollTo(0, y);
    applyVisitTypeBadges_(listEl);
    applyBulkModeToDom_();
    updateStatusBadges_(sorted.length, base.length);
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

    // 訪問種別ラベル（失敗してもフォールバック）
    ensureVisitTypeOptions(idToken)
      .then(() => { applyVisitTypeBadges_(appEl); rebuildTypeOptions_(); updateStatusBadges_(0, 0); })
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
        rebuildTypeOptions_();
        applyAndRender_();
        return;
      }
    }

    let res;
    try {
      res = await callGas({
        action: "listVisits",
        date_from: state.date_from,
        date_to: state.date_to_ymd + " 23:59:59",
      }, idToken);
    } catch (err) {
      const msg = err?.message || String(err || "");
      // callGas 側で認証エラー（Invalid id_token）は ApiError 化＋token破棄済み
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
      updateStatusBadges_(0, 0);
      return;
    }

    visitsAll = visits;
    saveCache_(cacheKey_(state), visitsAll);

    // ラベル取得後に種別フィルタの表示文字列も更新したいので、ここで待つ（失敗しても進む）
    try {
      await ensureVisitTypeOptions(idToken);
    } catch (_) {}

    rebuildTypeOptions_();
    applyAndRender_();
  };

  await fetchAndRender_({ force: false });

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
      type_filter: "all",
      active_filter: "active_only",
    };
    if (fromEl) fromEl.value = state.date_from;
    if (toEl) toEl.value = state.date_to_ymd;
    if (kwEl) kwEl.value = state.keyword;
    if (doneEl) doneEl.value = state.done_filter;
    if (typeEl) typeEl.value = state.type_filter;
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

  typeEl?.addEventListener("change", () => {
    state.type_filter = typeEl.value || "all";
    saveState_(state);
    applyAndRender_();
  });

  activeEl?.addEventListener("change", () => {
    state.active_filter = activeEl.value || "active_only";
    // 削除済み表示切替で「種別」候補も変わりうるため再構築
    rebuildTypeOptions_();
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
    if (a === "bulk-toggle") {
      setBulkMode_(!bulkMode);
      return;
    }

    if (a === "bulk-clear") {
      clearBulkSelection_();
      return;
    }

    if (a === "bulk-run") {
      if (!bulkSelected.size) return;
      await runBulkEdit_();
      return;
    }

    if (a === "bulk-create-invoice-draft") {
      if (!bulkSelected.size) return;
      await runCreateInvoiceDraft_();
      return;
    }
  });

  // bulk checkbox change
  listEl.addEventListener("change", (e) => {
    const ch = e.target.closest('input[data-role="bulk-check"]');
    if (!ch) return;
    if (!bulkMode) return;
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

    // bulk mode: badge誤操作防止（チェック操作は許可）
    if (bulkMode) {
      // 「詳細」だけは許可しない（選択中に遷移事故を防止）→必要なら後でONに
      if (actEl.dataset.action === "open") {
        toast({ title: "一括編集モード", message: "一括編集をOFFにしてから詳細を開いてください。" });
        return;
      }
    }

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

    // bulk mode: バッジ操作を無効化（事故防止）
    if (bulkMode) {
      if (action === "toggle-active" || action === "change-billing-status" || action === "change-visit-type" || action === "toggle-done") {
        toast({ title: "一括編集モード", message: "個別編集は一括編集をOFFにしてから行ってください。" });
        return;
      }
    }

    if (action === "toggle-active") {
      if (actEl.dataset.busy === "1") return;

      const currentActive = (card?.dataset?.isActive === "1");
      const nextActive = !currentActive;

      const ok = await showModal({
        title: "確認",
        bodyHtml: `<p class="p">この予約を「${escapeHtml(nextActive ? "有効" : "削除済")}」に変更します。よろしいですか？</p>`,
        okText: "変更",
        cancelText: "キャンセル",
      });
      if (!ok) return;

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevIsActive = (card?.dataset?.isActive === "1");
      const prevClasses = {
        isActive: actEl.classList.contains("is-active"),
        badgeDanger: actEl.classList.contains("badge-danger"),
        isInactive: actEl.classList.contains("is-inactive"),
      };

      // ===== Optimistic UI（即時反映）=====
      if (card) card.dataset.isActive = nextActive ? "1" : "0";
      actEl.textContent = (nextActive ? "有効" : "削除済");
      actEl.classList.toggle("is-active", nextActive);
      actEl.classList.toggle("badge-danger", !nextActive);
      actEl.classList.toggle("is-inactive", !nextActive);

      try {
        const idToken2 = getIdToken();
        if (!idToken2) {
          toast({ title: "未ログイン", message: "再ログインしてください。" });
          actEl.textContent = prevText;
          if (card) card.dataset.isActive = prevIsActive ? "1" : "0";
          actEl.textContent = prevText;
          actEl.classList.toggle("is-active", prevClasses.isActive);
          actEl.classList.toggle("badge-danger", prevClasses.badgeDanger);
          actEl.classList.toggle("is-inactive", prevClasses.isInactive);
          return;
        }

        const up = await callGas({
          action: "updateVisit",
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { is_active: nextActive },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        const patch = { visit_id: vid, is_active: nextActive };
        const m = mergeVisitById(visitsAll, vid, patch);
        visitsAll = m.list;
        if (m.idx < 0) { await fetchAndRender_({ force: true }); return; }

        saveCache_(cacheKey_(state), visitsAll);
        applyAndRender_();
        toast({ title: "更新完了", message: "有効ステータスを更新しました。" });
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

      // 候補（GAS優先、失敗時fallback）
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK };
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
        const up = await callGas({
          action: "updateVisit",
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
        const up = await callGas({
          action: "updateVisit",
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

    if (action === "change-visit-type") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      actEl.dataset.busy = "1";

      const prevType = String(actEl.dataset.visitType || "").trim();
      const prevText = actEl.textContent;

      const titleEl = card?.querySelector(".card-sub div:nth-child(2)");
      const prevTitleText = titleEl ? titleEl.textContent : "";

      // ===== Optimistic UI（即時反映）=====
      const applyOptimistic = (nextType, nextLabel) => {
        actEl.dataset.visitType = String(nextType || "").trim();
        actEl.textContent = nextLabel;
        if (card) card.dataset.visitType = String(nextType || "").trim();
      };

      const revertOptimistic = () => {
        actEl.dataset.visitType = prevType;
        actEl.textContent = prevText;
        if (card) card.dataset.visitType = prevType;
        if (titleEl) titleEl.textContent = prevTitleText;
      };

      const applyFinal = (u) => {
        const uu = (u && u.updated && typeof u.updated === "object") ? u.updated : u;
        const vt = String(uu?.visit_type || uu?.visitType || actEl.dataset.visitType || "").trim();
        if (vt) {
          actEl.dataset.visitType = vt;
          actEl.textContent = visitTypeLabel(vt);
          if (card) card.dataset.visitType = vt;
        }
        if (uu?.title && titleEl) titleEl.textContent = String(uu.title);
      };

      try {
        await ensureVisitTypeOptions(idToken2);
        const r = await toggleVisitType({
          idToken: idToken2,
          visitId: vid,
          currentType: prevType,
          applyOptimistic,
          applyFinal,
          revertOptimistic
        });

        if (r && r.ok && r.updated) {
          // state 反映（並び/フィルタの整合性のため）
          try {
            const uu = (r.updated && r.updated.updated && typeof r.updated.updated === "object") ? r.updated.updated : r.updated;
            const patch = {
              visit_id: vid,
              ...(uu?.visit_type ? { visit_type: uu.visit_type } : {}),
              ...(uu?.title ? { title: uu.title } : {}),
            };
            const m2 = mergeVisitById(visitsAll, vid, patch);
            visitsAll = m2.list;
            saveCache_(cacheKey_(state), visitsAll);
            applyAndRender_();
          } catch (_) {}
        }
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        try { revertOptimistic(); } catch (_) {}
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "toggle-done") {
      // 二重送信防止（spanでも動くよう dataset で統一）
      if (actEl.dataset.busy === "1") return;

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

