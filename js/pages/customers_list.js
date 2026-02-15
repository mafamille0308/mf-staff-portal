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

// ===== kana normalize（ひらがな検索対応）=====
// - 濁点等はそのまま
// - カタカナ→ひらがな
// - 空白除去（姓/名の間の揺れ対策）
function toHiragana_(s) {
  const str = String(s || "");
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Katakana: U+30A1..U+30F6 → Hiragana: U+3041..U+3096 （-0x60）
    if (code >= 0x30A1 && code <= 0x30F6) out += String.fromCharCode(code - 0x60);
    else out += str[i];
  }
  return out;
}
function normKana_(v) {
  return toHiragana_(String(v || "")).trim().toLowerCase().replace(/\s+/g, "");
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
  const nkq = normKana_(q);
  if (!nq) return list;

  return list.filter(c => {
    const name = norm_(c.name);
    const nameKana = normKana_(c.name_kana || c.kana || "");
    const surnameKana = normKana_(c.surname_kana || "");
    const givenKana = normKana_(c.given_kana || "");
    const fullKana = (surnameKana + givenKana).trim();
    const addr = norm_(c.address);
    const phone = norm_(c.phone);
    const pets = Array.isArray(c.pet_names) ? c.pet_names.map(norm_).join(" ") : "";
    const cid = norm_(c.customer_id);
    return (
      name.includes(nq) ||
      addr.includes(nq) ||
      phone.includes(nq) ||
      pets.includes(nq) ||
      cid.includes(nq) ||
      // ひらがな/かな検索（DBにかながある前提）
      (nkq && (nameKana.includes(nkq) || fullKana.includes(nkq) || surnameKana.includes(nkq) || givenKana.includes(nkq)))
    );
  });
}

function renderPetsBadges_(petNames) {
  const pets = Array.isArray(petNames) ? petNames : [];
  if (!pets.length) return `<div class="p text-sm">ペット：—</div>`;
  return `<div class="badges">${pets.map(n => `<span class="badge">${escapeHtml(fmt(n))}</span>`).join("")}</div>`;
}

function cardHtml(c) {
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
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:10px;">
        <button class="btn btn-primary" type="button" data-action="register">予約登録</button>
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
    // かな（姓名）: GAS側が返していれば拾う。未返却でも落ちない。
    surname_kana: String(x.surname_kana || x.surnameKana || "").trim(),
    given_kana: String(x.given_kana || x.givenKana || "").trim(),
    // 一体かな（もしあれば）
    name_kana: String(x.name_kana || x.nameKana || "").trim(),
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
        <button class="btn btn-ghost" type="button" data-action="list">担当顧客一覧</button>
      </div>

      <div class="row" style="margin-top:10px;">
        <input id="cfKeyword" class="input" type="text" inputmode="search"
          placeholder="検索（顧客名/住所/電話/ペット/ID）" />
          <button class="btn" type="button" data-action="search">検索</button>
        <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
      </div>

      <div class="hr"></div>
      <div id="customersList">
        <p class="p" style="opacity:.85;">
          顧客名を検索してください（ひらがな可）。<br>
          一覧が必要な場合は「担当顧客一覧」を押してください。
        </p>
      </div>
    </section>
  `);

  const listEl = appEl.querySelector("#customersList");
  const kwEl = appEl.querySelector("#cfKeyword");
  const listBtn = appEl.querySelector('[data-action="list"]');
  const searchBtn = appEl.querySelector('[data-action="search"]');

  if (!listEl) return;
  if (kwEl) kwEl.value = state.keyword;

  let customersAll = [];
  let _fetched = false;      // 一度でも listMyCustomers を叩いたか
  let _hasSearched = false;  // 検索操作をしたか（空画面回避/文言制御）

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
    // 未検索・未一覧の初期状態はガイドを維持
    if (!_fetched && !_hasSearched) {
      listEl.innerHTML = `
        <p class="p" style="opacity:.85;">
          まずは検索してください（かな：ひらがな入力でもヒットします）。<br>
          一覧が必要な場合は「担当顧客一覧」を押してください。
        </p>
      `;
      return;
    }

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
        _fetched = true;
        applyAndRender_();
        return;
      }
    }

    try {
      if (listBtn) listBtn.disabled = true;
      if (searchBtn) searchBtn.disabled = true;
      customersAll = await fetchCustomers_(state, query);
      saveCache_(ck, customersAll);
      _fetched = true;
      applyAndRender_();
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    } finally {
      if (listBtn) listBtn.disabled = false;
      if (searchBtn) searchBtn.disabled = false;
    }
  };

  // 「戻った直後（初回）だけ」保存値へ復元（DOM差し替え後に実行）
  if (shouldRestoreOnce_()) {
    setTimeout(() => restoreScrollOnce_(), 0);
  }

  // 初期表示では一覧取得しない
  // await fetchAndRender_({ force: false });

  // Enter で検索実行（スマホUX）
  kwEl?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    _hasSearched = true;
    state.keyword = kwEl.value || "";
    saveState_(state);
    if (!_fetched) await fetchAndRender_({ force: false }); // 初回は取得してからフィルタ
    else applyAndRender_();
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

    if (a === "list") {
      // 一覧取得: 担当関係のある顧客を全件取得して表示
      _hasSearched = false; // 一覧ボタンでの表示として扱う（文言制御のみ）
      await fetchAndRender_({ force: true });
      return;
    }

    if (a === "search") {
      _hasSearched = true;
      state.keyword = (kwEl && kwEl.value) ? kwEl.value : (state.keyword || "");
      saveState_(state);
      // 初回検索はサーバから一覧取得→クライアント側でフィルタ（GAS側に検索APIが無い前提でも成立）
      if (!_fetched) await fetchAndRender_({ force: false });
      else applyAndRender_();
      return;
    }
  });

  // ===== カード内アクション（詳細/登録へ）=====
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

    if (action === "register") {
      // 顧客を確定した状態で予約登録画面へ
    const c = (customersAll || []).find(x => String(x.customer_id || "") === String(cid)) || {};
    const label = String(c.name || "").trim();
    const base = `#/register?customer_id=${encodeURIComponent(cid)}`;
    location.hash = label ? `${base}&customer_label=${encodeURIComponent(label)}` : base;
      return;
    }
  });
}