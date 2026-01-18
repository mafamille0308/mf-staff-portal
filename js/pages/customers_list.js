// js/pages/customers_list.js
import { render, escapeHtml, toast, fmt } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken } from "../auth.js";

// ===== sessionStorage keys =====
const KEY_CF_STATE = "mf:customers_list:state:v1";
const KEY_CF_CACHE = "mf:customers_list:cache:v1";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善目的）

const KEY_CLIST_SCROLL_Y = "mf:customers_list:scroll_y:v1";
const KEY_CLIST_SCROLL_RESTORE_ONCE = "mf:customers_list:scroll_restore_once:v1";

function norm_(v) {
  return String(v || "").trim().toLowerCase();
}

function safeParseJson_(s) {
  try { return JSON.parse(String(s || "")); } catch (_) { return null; }
}

function loadState_() {
  const obj = safeParseJson_(sessionStorage.getItem(KEY_CF_STATE));
  return (obj && typeof obj === "object") ? obj : null;
}

function saveState_(state) {
  try { sessionStorage.setItem(KEY_CF_STATE, JSON.stringify(state)); } catch (_) {}
}

function cacheKey_(state) {
  // 今は query/as_of/limit を実用上ほぼ使わない想定なので、将来拡張できる形だけ揃える
  const asOf = String(state.as_of || "");
  const limit = String(state.limit || "");
  return `${asOf}__${limit}`;
}

function loadCache_(key) {
  const obj = safeParseJson_(sessionStorage.getItem(KEY_CF_CACHE));
  if (!obj || typeof obj !== "object") return null;
  if (obj.key !== key) return null;
  if (!obj.ts || (Date.now() - Number(obj.ts)) > CACHE_TTL_MS) return null;
  if (!Array.isArray(obj.customers)) return null;
  return obj.customers;
}

function saveCache_(key, customers) {
  try { sessionStorage.setItem(KEY_CF_CACHE, JSON.stringify({ key, ts: Date.now(), customers })); } catch (_) {}
}

function filter_(list, q) {
  const nq = norm_(q);
  if (!nq) return list;

  return list.filter(c => {
    const name = norm_(c.name);
    const addr = norm_(c.address);
    const phone = norm_(c.phone);
    const pets = Array.isArray(c.pet_names) ? c.pet_names.map(norm_).join(" ") : "";
    const cid = norm_(c.customer_id);
    return name.includes(nq) || addr.includes(nq) || phone.includes(nq) || pets.includes(nq) || cid.includes(nq);
  });
}

function renderPetsBadges_(petNames) {
  const pets = Array.isArray(petNames) ? petNames : [];
  if (!pets.length) return `<div class="p text-sm">ペット：—</div>`;
  return `<div class="badges">${pets.map(n => `<span class="badge">${escapeHtml(fmt(n))}</span>`).join("")}</div>`;
}

function card_(c) {
  const cid = String(c.customer_id || "").trim();
  return `
    <div class="card" data-customer-id="${escapeHtml(cid)}">
      <div class="card-title">
        <div>
          ${escapeHtml(fmt(c.name || "（名称未設定）"))}
          <span class="badge">${escapeHtml(cid)}</span>
        </div>
      </div>
      <div class="card-sub">
        <div>${escapeHtml(fmt(c.address || "—"))}</div>
        <div>電話：${escapeHtml(fmt(c.phone || "—"))}</div>
      </div>
      <div class="pets-badges">
        ${renderPetsBadges_(c.pet_names)}
      </div>
      <div class="row" style="justify-content:flex-end; margin-top:10px;">
        <button class="btn" type="button" data-action="open">顧客詳細</button>
      </div>
    </div>
  `;
}

async function fetchCustomers_(state, query) {
  const idToken = getIdToken();
  if (!idToken) throw new Error("ログインしてください。");

  // listMyCustomers_ は as_of / limit を受ける（使わないなら空でOK）
  const asOf = String(state.as_of || query?.get?.("as_of") || "").trim();
  const limit = String(state.limit || query?.get?.("limit") || "").trim();

  const payload = { action: "listMyCustomers" };
  if (asOf) payload.as_of = asOf;
  if (limit) payload.limit = limit;

  const res = await callGas(payload, idToken);
  if (!res || res.success === false) {
    throw new Error((res && (res.error || res.message)) || "listMyCustomers failed");
  }

  const data = unwrapResults(res);
  const list = (data && Array.isArray(data.results)) ? data.results : [];

  // 防御的に整形
  return list.map(x => ({
    customer_id: String(x.customer_id || "").trim(),
    name: String(x.name || "").trim(),
    phone: String(x.phone || "").trim(),
    address: String(x.address || "").trim(),
    pet_names: Array.isArray(x.pet_names) ? x.pet_names : [],
  })).filter(x => x.customer_id);
}

export async function renderCustomersList(appEl, query) {
  // ===== state（visits_list.js 踏襲）=====
  const saved = (() => { try { return loadState_(); } catch (_) { return null; } })();
  let state = {
    keyword: (saved && typeof saved.keyword === "string") ? saved.keyword : "",
    // 将来の拡張用（必要なときだけ UI 化）
    as_of: (saved && typeof saved.as_of === "string") ? saved.as_of : "",
    limit: (saved && typeof saved.limit === "string") ? saved.limit : "",
  };
  saveState_(state);

  render(appEl, `
    <section class="section">
      <div class="row row-between">
        <h1 class="h1">担当顧客一覧</h1>
        <button class="btn btn-ghost" type="button" data-action="refresh">更新</button>
      </div>

      <div class="row" style="margin-top:10px;">
        <input id="cfKeyword" class="input" type="text" inputmode="search"
          placeholder="検索（顧客名/住所/電話/ペット/ID）" />
        <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
      </div>

      <div class="hr"></div>
      <div id="customersList"><p class="p">読み込み中...</p></div>
    </section>
  `);

  const listEl = appEl.querySelector("#customersList");
  const kwEl = appEl.querySelector("#cfKeyword");
  const refreshBtn = appEl.querySelector('[data-action="refresh"]');

  if (!listEl) return;
  if (kwEl) kwEl.value = state.keyword;

  let customersAll = [];

  // ===== スクロール復元（詳細→一覧の体感改善）=====
  const restoreScrollOnce_ = () => {
    let y = 0;
    try {
      const raw = sessionStorage.getItem(KEY_CLIST_SCROLL_Y);
      y = Number(raw || "0") || 0;
    } catch (_) { y = 0; }
    try { sessionStorage.removeItem(KEY_CLIST_SCROLL_RESTORE_ONCE); } catch (_) {}
    if (y > 0) window.scrollTo(0, y);
  };

  const markRestoreOnce_ = () => {
    try { sessionStorage.setItem(KEY_CLIST_SCROLL_RESTORE_ONCE, "1"); } catch (_) {}
  };

  const shouldRestoreOnce_ = () => {
    try { return sessionStorage.getItem(KEY_CLIST_SCROLL_RESTORE_ONCE) === "1"; } catch (_) { return false; }
  };

  const applyAndRender_ = () => {
    const filtered = filter_(customersAll, state.keyword);

    if (!filtered.length) {
      listEl.innerHTML = `<p class="p">該当する顧客がありません。</p>`;
      return;
    }

    // visits_list.js と同様、再描画で現在位置を維持
    const y = window.scrollY;
    listEl.innerHTML = filtered.map(cardHtml).join("");
    window.scrollTo(0, y);
  };

  const fetchAndRender_ = async ({ force = false } = {}) => {
    listEl.innerHTML = `<p class="p">読み込み中...</p>`;

    // ===== cache（同一keyなら短時間は再取得しない）=====
    const ck = cacheKey_(state);
    if (!force) {
      const cached = loadCache_(ck);
      if (cached) {
        customersAll = cached;
        applyAndRender_();
        return;
      }
    }

    try {
      if (refreshBtn) refreshBtn.disabled = true;
      customersAll = await fetchCustomers_(state, query);
      saveCache_(ck, customersAll);
      applyAndRender_();
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  // 「戻った直後（初回）だけ」保存値へ復元（DOM差し替え後に実行）
  if (shouldRestoreOnce_()) {
    setTimeout(() => restoreScrollOnce_(), 0);
  }

  await fetchAndRender_({ force: false });

  // ===== フィルタUI（keyword は即時反映）=====
  kwEl?.addEventListener("input", () => {
    state.keyword = kwEl.value || "";
    saveState_(state);
    applyAndRender_();
  });

  // ボタン類（clear / refresh）
  appEl.addEventListener("click", async (e) => {
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

    if (a === "refresh") {
      await fetchAndRender_({ force: true });
      return;
    }
  });

  // ===== カード内アクション（詳細へ）=====
  listEl.addEventListener("click", (e) => {
    const actEl = e.target.closest("[data-action]");
    if (!actEl) return;

    const card = e.target.closest(".card");
    const cid = card?.dataset?.customerId;
    if (!cid) return;

    const action = actEl.dataset.action;

    if (action === "open") {
      // 詳細へ遷移する直前にスクロール位置を保存し、戻ったら復元する
      try {
        sessionStorage.setItem(KEY_CLIST_SCROLL_Y, String(window.scrollY || 0));
        markRestoreOnce_();
      } catch (_) {}
      location.hash = `#/customers?id=${encodeURIComponent(cid)}`;
      return;
    }
  });
}