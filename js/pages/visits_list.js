// js/pages/visits_list.js
import { render, toast, escapeHtml, showModal, showSelectModal, fmt, displayOrDash, fmtDateTimeJst } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken } from "../auth.js";
import { updateVisitDone } from "./visit_done_toggle.js";
import { toggleVisitType, visitTypeLabel, ensureVisitTypeOptions } from "./visit_type_toggle.js";

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

function applyVisitTypeBadges_(rootEl) {
  const root = rootEl || document;
  const nodes = root.querySelectorAll('[data-role="visit-type-badge"]');
  nodes.forEach((el) => {
    const key = el?.dataset?.visitType || "";
    el.textContent = visitTypeLabel(key);
  });
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
  const vid = v.visit_id || "";
  const done = isDone_(v);
  const visitType = v.visit_type || "";
  const billingStatus = String(v.billing_status || "").trim() || "unbilled";
  const isActive = !(v.is_active === false || String(v.is_active || "").toLowerCase() === "false");
  const vid2 = String(vid || "").trim();

  return `
    <div class="card"
      data-visit-id="${escapeHtml(vid)}"
      data-done="${done ? "1" : "0"}"
      data-billing-status="${escapeHtml(String(billingStatus))}"
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
    bulkBarEl.style.display = "flex";
    bulkBarEl.innerHTML = [
      `<button class="btn" type="button" data-action="bulk-toggle">一括編集: ${bulkMode ? "ON" : "OFF"}</button>`,
      `<span class="badge">選択: ${escapeHtml(String(count))}件</span>`,
      `<button class="btn btn-ghost" type="button" data-action="bulk-clear" ${count ? "" : "disabled"}>全解除</button>`,
      `<button class="btn" type="button" data-action="bulk-run" ${count ? "" : "disabled"}>一括変更</button>`,
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
      const normalizeBulkFields_ = (fields0, item0) => {
        const f = fields0 || {};
        if (item0 === "done") {
          // done/is_done 両方持っていても is_done のみ送る
          return { is_done: !!(f.is_done ?? f.done) };
        }
        if (item0 === "is_active") {
          return { is_active: !!f.is_active };
        }
        if (item0 === "billing_status") {
          return { billing_status: String(f.billing_status || "").trim() || "unbilled" };
        }
        // 念のため（ここには来ない想定）
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
      const failedRows  = rs.filter(r => String(r?.status || "") === "failed");
      const failedIds = new Set(failedRows.map(r => String(r?.visit_id || "").trim()).filter(Boolean));

      // 成功分はサーバ返却 updated を最終反映（無ければ現状維持）
      for (const r of successRows) {
        const id = String(r?.visit_id || "").trim();
        if (!id) continue;
        const uu = (r && r.updated && typeof r.updated === "object") ? r.updated : null;
        if (!uu) continue;
        const patch = { visit_id: id, ...uu };
        const mm = mergeVisitById(visitsAll, id, patch);
        visitsAll = mm.list;
      }

      // 失敗分のみ rollback
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

      if (failedIds.size) {
        const msg = failedRows
          .slice(0, 3)
          .map(r => `${String(r?.visit_id || "")}: ${String(r?.error || "失敗")}`)
          .join("\n");
        toast({ title: "一部失敗", message: msg || `失敗: ${failedIds.size}件` });
      } else {
        toast({ title: "更新完了", message: `一括更新しました（${ids.length}件）。` });
      }

      // 実行後はOFF（事故防止）
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
      location.hash = `#/visits?id=${encodeURIComponent(vid)}`;
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
