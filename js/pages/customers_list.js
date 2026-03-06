// js/pages/customers_list.js
import { render, escapeHtml, toast, fmt, openBlockingOverlay } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken, getUser } from "../auth.js";
import { openAssignModalForRegister } from "./assign_staff_modal.js";

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

function sortByKana_(list) {
  const toKey = (c) => {
    const sk = normKana_(c.surname_kana || "");
    const gk = normKana_(c.given_kana || "");
    const nk = normKana_(c.name_kana || "");
    if (sk || gk) return sk + gk;
    if (nk) return nk;
    return normKana_(c.name || "");
  };

  return [...list].sort((a, b) =>
    toKey(a).localeCompare(toKey(b), "ja")
  );
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

async function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  try {
    return await task(blocker);
  } finally {
    blocker.close();
  }
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
  const prevController = appEl.__customersListAbortController;
  if (prevController && typeof prevController.abort === "function") {
    try { prevController.abort(); } catch (_) {}
  }
  const eventController = new AbortController();
  appEl.__customersListAbortController = eventController;

  const user = getUser() || {};
  const role = String(user.role || "").toLowerCase();
  const isAdmin = role === "admin";
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
      </div>

      <div class="row" style="margin-top:10px;">
        <input id="cfKeyword" class="input" type="text" inputmode="search"
          placeholder="検索（顧客名/住所/電話/ペット名）" />
          <button class="btn" type="button" data-action="search">検索</button>
        <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
      </div>

      <details id="cfImportWrap" class="${isAdmin ? "" : "is-hidden"}" style="margin-top:14px; border:1px solid var(--line); border-radius: var(--radius); padding: 10px; background: rgba(255,255,255,0.02);">
        <summary class="row" style="cursor:pointer; user-select:none; list-style:none;">
          <div style="font-weight:900;">顧客JSON登録（管理者のみ）</div>
        </summary>
        <div style="margin-top:10px;">
          <textarea id="cfImportJson" class="textarea mono" rows="14" style="min-height:280px; resize:vertical;" placeholder='{"action":"upsertCustomer","customer":{"name":"...","phone":"..."}}'></textarea>
          <div class="row" style="margin-top:8px; justify-content:flex-end;">
            <button class="btn" type="button" data-action="import-json-customer">JSONを登録</button>
          </div>
          <div id="cfImportResult" class="p text-sm" style="margin-top:8px; opacity:.85;"></div>
        </div>
      </details>

      <div class="hr"></div>
      <div id="customersList">
        <p class="p">読み込み中...</p>
      </div>
    </section>
  `);

  const listEl = appEl.querySelector("#customersList");
  const kwEl = appEl.querySelector("#cfKeyword");
  const searchBtn = appEl.querySelector('[data-action="search"]');
  const importJsonEl = appEl.querySelector("#cfImportJson");
  const importResultEl = appEl.querySelector("#cfImportResult");

  if (!listEl) return;
  if (kwEl) kwEl.value = state.keyword;

  let customersAll = [];
  let _fetched = false;      // 一度でも listMyCustomers を叩いたか
  let _hasSearched = false;  // 検索操作をしたか（空画面回避/文言制御）
  let _petReqSeq = 0;

  function parseCustomerImportPayload_(raw) {
    const obj = safeParseJson_(raw);
    if (!obj || typeof obj !== "object") throw new Error("JSON形式が不正です。");
    let customer = null;
    const action = String(obj.action || "").trim();
    if (action === "upsertCustomer" && obj.customer && typeof obj.customer === "object") {
      customer = obj.customer;
    } else if (obj.customer && typeof obj.customer === "object") {
      customer = obj.customer;
    } else {
      customer = obj;
    }
    if (!customer || typeof customer !== "object") throw new Error("customer オブジェクトを解釈できません。");
    return customer;
  }

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

    // ペット名バッジは後追いで埋める（UX維持＆Pets全走査を別軸化）
    fetchAndApplyPetNames_(filtered).catch(() => {});
  };

  async function fetchAndApplyPetNames_(filtered) {
    if (!Array.isArray(filtered) || filtered.length === 0) return;
    if (!_fetched) return; // 一覧データ未取得の初期ガイド状態では呼ばない

    const mySeq = ++_petReqSeq;
    const ids = filtered.map(x => String(x.customer_id || '').trim()).filter(Boolean);
    if (ids.length === 0) return;

    const idToken = getIdToken();
    if (!idToken) return;

    const res = await callGas({ action: "getPetNamesByCustomerIds", customer_ids: ids }, idToken);
    if (mySeq !== _petReqSeq) return; // 古いレスポンスは捨てる
    if (!res || res.success === false) return;

    const data = unwrapResults(res);
    const map = (data && data.results && typeof data.results === "object") ? data.results : {};

    // customersAll 側も更新（検索で pet_names を使えるようにする）
    for (let i = 0; i < customersAll.length; i++) {
      const cid = String(customersAll[i].customer_id || "").trim();
      if (!cid) continue;
      const names = Array.isArray(map[cid]) ? map[cid] : null;
      if (names) customersAll[i].pet_names = names;
    }

    // DOM部分更新（カード全再描画はしない）
    for (let i = 0; i < ids.length; i++) {
      const cid = ids[i];
      const card = listEl.querySelector(`.card[data-customer-id="${CSS.escape(cid)}"]`);
      if (!card) continue;
      const wrap = card.querySelector(".pets-badges");
      if (!wrap) continue;
      const names = Array.isArray(map[cid]) ? map[cid] : [];
      wrap.innerHTML = renderPetsBadges_(names);
    }
  }

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
      if (searchBtn) searchBtn.disabled = true;
      customersAll = sortByKana_(await fetchCustomers_(state, query));
      saveCache_(ck, customersAll);
      _fetched = true;
      applyAndRender_();
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    } finally {
      if (searchBtn) searchBtn.disabled = false;
    }
  };

  // 「戻った直後（初回）だけ」保存値へ復元（DOM差し替え後に実行）
  if (shouldRestoreOnce_()) {
    setTimeout(() => restoreScrollOnce_(), 0);
  }

  // 初期表示で全件取得して表示（staff:担当のみ / admin:全件 or staff_id指定時のみ）
  await fetchAndRender_({ force: false });

  // Enter で検索実行（スマホUX）
  kwEl?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    _hasSearched = true;
    state.keyword = kwEl.value || "";
    saveState_(state);
    if (!_fetched) await fetchAndRender_({ force: false }); // 初回は取得してからフィルタ
    else applyAndRender_();
  }, { signal: eventController.signal });

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

    if (a === "search") {
      _hasSearched = true;
      state.keyword = (kwEl && kwEl.value) ? kwEl.value : (state.keyword || "");
      saveState_(state);
      // 初回検索はサーバから一覧取得→クライアント側でフィルタ（GAS側に検索APIが無い前提でも成立）
      if (!_fetched) await fetchAndRender_({ force: false });
      else applyAndRender_();
      return;
    }

    if (a === "import-json-customer") {
      if (!isAdmin) {
        toast({ title: "権限なし", message: "管理者のみ実行できます。" });
        return;
      }
      const idToken = getIdToken();
      if (!idToken) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }
      const raw = String((importJsonEl && importJsonEl.value) || "").trim();
      if (!raw) {
        toast({ title: "入力不足", message: "登録用JSONを貼り付けてください。" });
        return;
      }
      try {
        const customer = parseCustomerImportPayload_(raw);
        if (!customer.updated_by) customer.updated_by = String(user.email || user.staff_id || "admin_json_import");
        const customerId = await runWithBlocking_(
          {
            title: "顧客情報を登録しています",
            bodyHtml: "JSONの内容を保存して一覧を更新しています。",
            busyText: "登録中...",
          },
          async (blocker) => {
            const res = await callGas({ action: "upsertCustomer", customer }, idToken);
            if (!res || res.success === false || res.ok === false) {
              throw new Error((res && (res.error || res.message || res.operator_message)) || "upsertCustomer failed");
            }
            const nextCustomerId = String((res && res.customer_id) || (res && res.customer && (res.customer.customer_id || res.customer.id)) || "").trim();
            blocker.setBusyText("一覧を更新しています...");
            await fetchAndRender_({ force: true });
            return nextCustomerId;
          }
        );
        if (importResultEl) importResultEl.textContent = customerId ? `登録完了: ${customerId}` : "登録完了";
        toast({ title: "登録完了", message: customerId ? `顧客ID: ${customerId}` : "顧客を登録しました。" });
      } catch (e) {
        if (importResultEl) importResultEl.textContent = `登録失敗: ${e?.message || String(e)}`;
        toast({ title: "登録失敗", message: e?.message || String(e) });
      }
      return;
    }
  }, { signal: eventController.signal });

  // ===== カード内アクション（詳細/登録へ）=====
  async function openAssignModalForRegister_({ customerId, customerName }) {
    const idToken = getIdToken();
    return openAssignModalForRegister({ customerId, customerName, idToken });
  }

  listEl.addEventListener("click", async (e) => {
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
      const user = getUser() || {};
      const role = String(user.role || "").toLowerCase();
      if (role !== "admin") {
        location.hash = label ? `${base}&customer_label=${encodeURIComponent(label)}` : base;
        return;
      }
      const selectedStaffId = await openAssignModalForRegister_({ customerId: cid, customerName: label });
      if (!selectedStaffId) return;
      const withLabel = label ? `${base}&customer_label=${encodeURIComponent(label)}` : base;
      location.hash = `${withLabel}&assign_staff_id=${encodeURIComponent(selectedStaffId)}`;
      return;
    }
  }, { signal: eventController.signal });
}
