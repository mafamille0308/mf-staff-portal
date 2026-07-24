// js/pages/customers_list.js
import { render, escapeHtml, toast, fmt } from "../ui.js";
import { unwrapResults } from "../api.js";
import { getIdToken, getUser } from "../auth.js";
import { openAssignModalForRegister } from "./assign_staff_modal.js";
import { listBillingPriceRulesPolicy_ } from "./billing_price_rules_policy.js";
import { canManageCustomerAssignments_, openCustomerAssignmentModal } from "./customer_assignment_modal.js";
import { portalCustomersImportFromMail_, portalCustomersListMy_, portalCustomersPetNames_, portalCustomersUpsert_ } from "./portal_api.js";
import { runWithBlocking_ } from "./page_async_helpers.js";

// ===== sessionStorage keys =====
const KEY_CF_STATE = "mf:customers_list:state:v1";
const KEY_CF_CACHE = "mf:customers_list:cache:v1";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善目的）
const DEFAULT_CUSTOMERS_LIMIT = 500;

const KEY_CLIST_SCROLL_Y = "mf:customers_list:scroll_y:v1";
const KEY_CLIST_SCROLL_RESTORE_ONCE = "mf:customers_list:scroll_restore_once:v1";
const KEY_PICKUP_RULE_OPTIONS = ["継続保管", "郵送預かり", "メールボックス預かり", "鍵なし", "その他"];
const KEY_RETURN_RULE_OPTIONS = ["継続保管", "ポスト返却", "メールボックス返却", "郵送返却", "鍵なし", "その他"];
const KEY_LOCATION_OPTIONS = ["顧客", "本部", "担当者", "鍵なし"];

function norm_(v) {
  return String(v || "").trim().toLowerCase();
}

function promptMailImportAmbiguousAction_(out) {
  const pending = (Array.isArray(out?.results) ? out.results : []).filter((r) => r && r.pending_confirmation);
  if (!pending.length) return Promise.resolve("");
  const modalHost = document.querySelector("#modalHost");
  if (!modalHost) return Promise.resolve("");
  const rowsHtml = pending.slice(0, 5).map((r) => {
    const incoming = r.incoming_customer || {};
    const existing = r.existing_candidate || {};
    return `
      <div class="panel-soft mt-10">
        <div class="fw-900">${escapeHtml(incoming.name || r.customer_name || "")}</div>
        <div class="small">取込: ${escapeHtml(incoming.email || r.customer_email || "")} / ${escapeHtml(incoming.phone || "")}</div>
        <div class="small">既存候補: ${escapeHtml(existing.customer_id || "")} ${escapeHtml(existing.name || "")} / ${escapeHtml(existing.email || "")} / ${escapeHtml(existing.phone || "")}</div>
      </div>
    `;
  }).join("");
  return new Promise((resolve) => {
    const cleanup = (value) => {
      modalHost.classList.add("is-hidden");
      modalHost.setAttribute("aria-hidden", "true");
      modalHost.onclick = null;
      modalHost.innerHTML = "";
      resolve(value || "");
    };
    modalHost.classList.remove("is-hidden");
    modalHost.setAttribute("aria-hidden", "false");
    modalHost.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="modal-title">同名の既存顧客を確認</div>
          <button class="icon-btn" type="button" data-action="mail-conflict-cancel" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">
          <p class="p">メールまたは電話の一方だけが既存顧客と一致しています。保存方法を選択してください。</p>
          ${rowsHtml}
        </div>
        <div class="editor-modal-actions">
          <button class="btn btn-ghost" type="button" data-action="mail-conflict-cancel">キャンセル</button>
          <button class="btn" type="button" data-action="mail-conflict-create">新規顧客として登録</button>
          <button class="btn btn-danger" type="button" data-action="mail-conflict-update">既存顧客を上書き</button>
        </div>
      </div>
    `;
    modalHost.onclick = (ev) => {
      const action = ev.target?.dataset?.action || "";
      if (ev.target === modalHost || action === "mail-conflict-cancel") cleanup("");
      if (action === "mail-conflict-create") cleanup("create_new");
      if (action === "mail-conflict-update") cleanup("update_existing");
    };
  });
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
  // query/as_of/limit 単位で、初回ページだけ短時間キャッシュする
  const keyword = String(state.keyword || "");
  const asOf = String(state.as_of || "");
  const limit = String(state.limit || "");
  return `${keyword}__${asOf}__${limit}`;
}

function loadCache_(key) {
  const obj = safeParseJson_(sessionStorage.getItem(KEY_CF_CACHE));
  if (!obj || typeof obj !== "object") return null;
  if (obj.key !== key) return null;
  if (!obj.ts || (Date.now() - Number(obj.ts)) > CACHE_TTL_MS) return null;
  if (!Array.isArray(obj.customers)) return null;
  return obj;
}

function saveCache_(key, customers, meta = {}) {
  try { sessionStorage.setItem(KEY_CF_CACHE, JSON.stringify({ key, ts: Date.now(), customers, meta })); } catch (_) {}
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

function withCustomerHonorific_(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  if (s.endsWith("様")) return s;
  return `${s} 様`;
}

function actionIconSvg_(name) {
  const common = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (name === "register") {
    return `<svg ${common}><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h18"></path><path d="M12 13v6"></path><path d="M9 16h6"></path></svg>`;
  }
  if (name === "customer") {
    return `<svg ${common}><circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 0 0-16 0"></path></svg>`;
  }
  if (name === "visits") {
    return `<svg ${common}><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h18"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path></svg>`;
  }
  if (name === "assign") {
    return `<svg ${common}><path d="M2 21a8 8 0 0 1 13.3-6"></path><circle cx="10" cy="8" r="5"></circle><path d="M19 16v6"></path><path d="M22 19h-6"></path></svg>`;
  }
  return "";
}

function normStr_(v) {
  const s = fmt(v);
  return (s == null) ? "" : String(s).trim();
}

function inputRow_(label, name, value, { type = "text", placeholder = "", help = "", min = "", step = "" } = {}) {
  const minAttr = (min === "" || min == null) ? "" : `min="${escapeHtml(String(min))}"`;
  const stepAttr = (step === "" || step == null) ? "" : `step="${escapeHtml(String(step))}"`;
  const inputmodeAttr = type === "number" ? `inputmode="numeric"` : "";
  return `
    <div class="p" style="margin-bottom:10px;">
      <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(label)}</strong></div>
      <input class="input" type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(normStr_(value))}" placeholder="${escapeHtml(placeholder)}" ${minAttr} ${stepAttr} ${inputmodeAttr}/>
      ${help ? `<div class="p text-sm" style="opacity:.75; margin-top:4px;">${escapeHtml(help)}</div>` : ""}
    </div>
  `;
}

function selectRow_(label, name, value, options, { help = "" } = {}) {
  const cur = normStr_(value);
  return `
    <div class="p" style="margin-bottom:10px;">
      <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(label)}</strong></div>
      <select class="input" name="${escapeHtml(name)}">
        <option value="">—</option>
        ${(Array.isArray(options) ? options : []).map((opt) => `<option value="${escapeHtml(opt)}" ${cur === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
      </select>
      ${help ? `<div class="p text-sm" style="opacity:.75; margin-top:4px;">${escapeHtml(help)}</div>` : ""}
    </div>
  `;
}

function normalizeTravelFeeRuleOptions_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((r) => String(r?.item_type || "").trim() === "travel_fee" && r?.is_active !== false)
    .sort((a, b) => (Number(a?.display_order || 0) || 0) - (Number(b?.display_order || 0) || 0))
    .map((r) => {
      const rid = String(r?.price_rule_id || "").trim();
      const label = String(r?.label || [String(r?.product_name || "").trim(), String(r?.variant_name || "").trim()].filter(Boolean).join(" ").trim() || rid).trim() || rid;
      const amount = Math.max(0, Number(r?.amount || 0) || 0);
      return { price_rule_id: rid, label, amount };
    })
    .filter((x) => x.price_rule_id);
}

function travelFeeRuleSelectHtml_(travelFeeOptions) {
  return `
    <div class="p" style="margin-bottom:10px;">
      <div style="opacity:.85; margin-bottom:4px;"><strong>出張料金（円）</strong></div>
      <select class="input" name="travel_fee_rule_pick">
        <option value="">請求しない（0円）</option>
        ${(Array.isArray(travelFeeOptions) ? travelFeeOptions : []).map((o) => {
          const v = `${String(o.price_rule_id || "").trim()}|${Math.max(0, Number(o.amount || 0) || 0)}`;
          return `<option value="${escapeHtml(v)}">${escapeHtml(String(o.label || ""))}（${escapeHtml(Number(o.amount || 0).toLocaleString("ja-JP"))}円）</option>`;
        }).join("")}
      </select>
      <div class="p text-sm" style="opacity:.75; margin-top:4px;">料金マスタ（travel_fee）から選択します。</div>
    </div>
  `;
}

function getFormValue_(formEl, name) {
  const el = formEl?.querySelector(`[name="${CSS.escape(name)}"]`);
  if (!el) return null;
  return normStr_(el.value);
}

function normalizeChoice_(val, options) {
  const s = normStr_(val);
  if (!s) return "";
  if (options.includes(s)) return s;
  const n = s.replace(/\s+/g, "");
  for (const opt of options) {
    if (n === opt.replace(/\s+/g, "")) return opt;
  }
  for (const opt of options) {
    if (n.includes(opt.replace(/\s+/g, ""))) return opt;
  }
  return "その他";
}

function syncOtherRuleInputState_(formEl, selectName, otherName) {
  const sel = formEl?.querySelector(`[name="${CSS.escape(selectName)}"]`);
  const other = formEl?.querySelector(`[name="${CSS.escape(otherName)}"]`);
  if (!sel || !other) return;
  const enable = normStr_(sel.value) === "その他";
  other.disabled = !enable;
  if (!enable) other.value = "";
}

function buildCustomerCreatePayload_(formEl, user) {
  const customer = {};
  const setText_ = (key) => {
    const v = getFormValue_(formEl, key);
    if (v == null) return;
    const s = normStr_(v);
    if (s) customer[key] = s;
  };
  const setNumber_ = (key) => {
    const v = getFormValue_(formEl, key);
    if (v == null || v === "") return;
    customer[key] = Math.max(0, Number(v) || 0);
  };

  ["surname", "given", "surname_kana", "given_kana", "phone", "emergency_phone", "email", "billing_email",
    "postal_code", "prefecture", "city", "address_line1", "address_line2",
    "parking_info", "lock_no", "notes"].forEach(setText_);
  const stage = normStr_(getFormValue_(formEl, "stage"));
  if (stage === "仮登録" || stage === "本登録") customer.stage = stage;
  const registeredDate = normStr_(getFormValue_(formEl, "registered_date"));
  if (registeredDate) customer.registered_date = registeredDate;

  setNumber_("parking_fee_amount");
  const travelPickRaw = getFormValue_(formEl, "travel_fee_rule_pick");
  if (travelPickRaw != null) {
    const travelParts = String(travelPickRaw || "").split("|");
    customer.travel_fee_amount = Math.max(0, Number(travelParts[1] || 0) || 0);
  }

  const pickupRule = normalizeChoice_(getFormValue_(formEl, "key_pickup_rule"), KEY_PICKUP_RULE_OPTIONS);
  const returnRule = normalizeChoice_(getFormValue_(formEl, "key_return_rule"), KEY_RETURN_RULE_OPTIONS);
  const locationRule = normalizeChoice_(getFormValue_(formEl, "key_location"), KEY_LOCATION_OPTIONS);
  if (pickupRule) customer.key_pickup_rule = pickupRule;
  if (returnRule) customer.key_return_rule = returnRule;
  if (locationRule) customer.key_location = locationRule;
  if (pickupRule === "その他") {
    const pickupOther = normStr_(getFormValue_(formEl, "key_pickup_rule_other"));
    if (pickupOther) customer.key_pickup_rule_other = pickupOther;
  }
  if (returnRule === "その他") {
    const returnOther = normStr_(getFormValue_(formEl, "key_return_rule_other"));
    if (returnOther) customer.key_return_rule_other = returnOther;
  }

  const pickupFeeRule = normStr_(getFormValue_(formEl, "key_pickup_fee_rule"));
  const returnFeeRule = normStr_(getFormValue_(formEl, "key_return_fee_rule"));
  if (pickupFeeRule === "free" || pickupFeeRule === "paid") customer.key_pickup_fee_rule = pickupFeeRule;
  if (returnFeeRule === "free" || returnFeeRule === "paid") customer.key_return_fee_rule = returnFeeRule;

  customer.updated_by = String(user.email || user.staff_id || "admin_customer_form");
  return customer;
}

function cardHtml(c, canManageAssignments = false) {
  const cid = String(c.customer_id || "").trim();
  const customerName = String(c.name || "").trim();
  const customerLabel = customerName ? withCustomerHonorific_(customerName) : "（名称未設定）";
  return `
    <div class="card customer-card" data-customer-id="${escapeHtml(cid)}">
      <div class="card-title">
        <div>
          ${escapeHtml(fmt(customerLabel))}
        </div>
      </div>
      <div class="card-sub">
        <div>${escapeHtml(fmt(c.address || "—"))}</div>
        <div>電話：${escapeHtml(fmt(c.phone || "—"))}</div>
      </div>
      <div class="pets-badges">
        ${renderPetsBadges_(c.pet_names)}
      </div>
      <div class="row row-end gap-8 mt-10">
        ${canManageAssignments ? `<button class="btn btn-icon-action" type="button" data-action="assignments" title="担当追加/終了" aria-label="担当追加/終了">${actionIconSvg_("assign")}</button>` : ``}
        <button class="btn btn-icon-action" type="button" data-action="register" title="予約登録" aria-label="予約登録">${actionIconSvg_("register")}</button>
        <button class="btn btn-icon-action" type="button" data-action="visits" title="予約一覧へ" aria-label="予約一覧へ">${actionIconSvg_("visits")}</button>
        <button class="btn btn-icon-action" type="button" data-action="open" title="顧客詳細" aria-label="顧客詳細">${actionIconSvg_("customer")}</button>
      </div>
    </div>
  `;
}

async function fetchCustomers_(state, query, { offset = 0 } = {}) {
  const idToken = getIdToken();
  if (!idToken) throw new Error("ログインしてください。");

  // listMyCustomers_ は as_of / limit を受ける（使わないなら空でOK）
  const asOf = String(state.as_of || query?.get?.("as_of") || "").trim();
  const limit = String(state.limit || query?.get?.("limit") || DEFAULT_CUSTOMERS_LIMIT).trim();
  const keyword = String(state.keyword || "").trim();

  const payload = {};
  if (asOf) payload.as_of = asOf;
  if (limit) payload.limit = limit;
  if (offset) payload.offset = offset;
  if (keyword) payload.query = keyword;

  const res = await portalCustomersListMy_(idToken, payload);
  if (!res || res.success === false) {
    throw new Error((res && (res.error || res.message)) || "listMyCustomers failed");
  }

  const data = unwrapResults(res);
  const list = (data && Array.isArray(data.results)) ? data.results : [];

  // 防御的に整形
  const customers = list.map(x => ({
    customer_id: String(x.customer_id || "").trim(),
    name: String(x.name || "").trim(),
    // かな（姓名）: API側が返していれば拾う。未返却でも落ちない。
    surname_kana: String(x.surname_kana || x.surnameKana || "").trim(),
    given_kana: String(x.given_kana || x.givenKana || "").trim(),
    // 一体かな（もしあれば）
    name_kana: String(x.name_kana || x.nameKana || "").trim(),
    phone: String(x.phone || "").trim(),
    address: String(x.address || "").trim(),
    pet_names: Array.isArray(x.pet_names) ? x.pet_names : [],
  })).filter(x => x.customer_id);
  return {
    customers,
    has_more: !!(data && data.has_more),
    next_offset: Number(data && data.next_offset) || (offset + customers.length),
  };
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
  let travelFeeOptions = [];
  if (isAdmin) {
    try {
      const idToken = getIdToken();
      if (idToken) {
        const rr = await listBillingPriceRulesPolicy_(idToken, true);
        const rules = Array.isArray(rr?.results) ? rr.results : (Array.isArray(rr) ? rr : []);
        travelFeeOptions = normalizeTravelFeeRuleOptions_(rules);
      }
    } catch (_) {
      travelFeeOptions = [];
    }
  }
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
      <p class="p">${isAdmin ? "顧客検索と登録導線の管理をこの画面で操作します。" : "担当顧客の検索と予約登録導線をこの画面で操作します。"}</p>

      <div class="row mt-10">
        <input id="cfKeyword" class="input" type="text" inputmode="search"
          placeholder="検索（顧客名/住所/電話/ペット名）" />
          <button class="btn" type="button" data-action="search">検索</button>
        <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
      </div>
      <div class="row mt-8 ${isAdmin ? "" : "is-hidden"}">
        <button class="btn" type="button" data-action="import-from-mail">メール取込を実行</button>
      </div>

      <details id="cfImportWrap" class="panel-soft mt-14 ${isAdmin ? "" : "is-hidden"}">
        <summary class="row summary-plain">
          <div class="fw-900">顧客登録フォーム</div>
        </summary>
        <form id="cfCreateForm" class="mt-10">
          ${inputRow_("姓", "surname", "", { placeholder: "例：山田" })}
          ${inputRow_("名", "given", "", { placeholder: "例：太郎" })}
          ${inputRow_("姓かな", "surname_kana", "", { placeholder: "例：やまだ" })}
          ${inputRow_("名かな", "given_kana", "", { placeholder: "例：たろう" })}

          <div class="hr"></div>
          ${inputRow_("電話", "phone", "", { placeholder: "例：09012345678" })}
          ${inputRow_("緊急連絡先", "emergency_phone", "", { placeholder: "例：08012345678" })}
          ${inputRow_("メール", "email", "", { placeholder: "例：example@example.com" })}
          ${inputRow_("請求先メール", "billing_email", "", { placeholder: "未入力時はメールを利用" })}

          <div class="hr"></div>
          ${inputRow_("郵便番号", "postal_code", "", { placeholder: "例：9800014" })}
          ${inputRow_("都道府県", "prefecture", "", { placeholder: "例：宮城県" })}
          ${inputRow_("市区町村", "city", "", { placeholder: "例：仙台市青葉区" })}
          ${inputRow_("町域・番地", "address_line1", "", { placeholder: "例：本町1-2-3" })}
          ${inputRow_("建物・部屋", "address_line2", "", { placeholder: "例：サンプルマンション101" })}

          <div class="hr"></div>
          ${selectRow_("鍵預かりルール", "key_pickup_rule", "", KEY_PICKUP_RULE_OPTIONS)}
          ${inputRow_("鍵預かりルール（その他詳細）", "key_pickup_rule_other", "", { placeholder: "例：外の物置内、保存容器の中", help: "「その他」選択時のみ入力してください。" })}
          <div class="p" style="margin-bottom:10px;">
            <div style="opacity:.85; margin-bottom:4px;"><strong>鍵預かり料金区分</strong></div>
            <select class="input" name="key_pickup_fee_rule">
              <option value="">—</option>
              <option value="free">無料</option>
              <option value="paid">有料</option>
            </select>
          </div>
          ${selectRow_("鍵返却ルール", "key_return_rule", "", KEY_RETURN_RULE_OPTIONS)}
          ${inputRow_("鍵返却ルール（その他詳細）", "key_return_rule_other", "", { placeholder: "例：外の物置内、保存容器の中", help: "「その他」選択時のみ入力してください。" })}
          <div class="p" style="margin-bottom:10px;">
            <div style="opacity:.85; margin-bottom:4px;"><strong>鍵返却料金区分</strong></div>
            <select class="input" name="key_return_fee_rule">
              <option value="">—</option>
              <option value="free">無料</option>
              <option value="paid">有料</option>
            </select>
          </div>
          ${selectRow_("鍵の所在", "key_location", "", KEY_LOCATION_OPTIONS)}
          ${inputRow_("ロック番号", "lock_no", "", { placeholder: "例：1234" })}

          <div class="hr"></div>
          ${inputRow_("駐車場", "parking_info", "", { placeholder: "例：敷地内 1台分あり" })}
          ${inputRow_("駐車料金（円）", "parking_fee_amount", "", { type: "number", min: "0", step: "1", placeholder: "例：0" })}
          ${travelFeeRuleSelectHtml_(travelFeeOptions)}
          <div class="p" style="margin-bottom:10px;">
            <div style="opacity:.85; margin-bottom:4px;"><strong>メモ</strong></div>
            <textarea class="input" name="notes" rows="4" placeholder="引継ぎや注意点など"></textarea>
          </div>
          ${selectRow_("ステージ", "stage", "", ["仮登録", "本登録"], { help: "登録日を入力する場合は必ず選択してください。" })}
          ${inputRow_("登録日", "registered_date", "", { type: "date" })}
          <div class="row row-end mt-8">
            <button class="btn" type="button" data-action="create-customer">登録</button>
          </div>
        </form>
        <div id="cfImportResult" class="p text-sm mt-8 opacity-85"></div>
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
  const createFormEl = appEl.querySelector("#cfCreateForm");
  const importResultEl = appEl.querySelector("#cfImportResult");

  if (!listEl) return;
  if (kwEl) kwEl.value = state.keyword;

  let customersAll = [];
  let _fetched = false;      // 一度でも listMyCustomers を叩いたか
  let _hasSearched = false;  // 検索操作をしたか（空画面回避/文言制御）
  let _petReqSeq = 0;
  let _hasMore = false;
  let _nextOffset = 0;

  if (createFormEl) {
    syncOtherRuleInputState_(createFormEl, "key_pickup_rule", "key_pickup_rule_other");
    syncOtherRuleInputState_(createFormEl, "key_return_rule", "key_return_rule_other");
    createFormEl.addEventListener("change", (e) => {
      const name = String(e?.target?.name || "");
      if (name === "key_pickup_rule") syncOtherRuleInputState_(createFormEl, "key_pickup_rule", "key_pickup_rule_other");
      if (name === "key_return_rule") syncOtherRuleInputState_(createFormEl, "key_return_rule", "key_return_rule_other");
    }, { signal: eventController.signal });
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
    const moreHtml = _hasMore
      ? `<div class="row row-center mt-14"><button class="btn btn-ghost" type="button" data-action="load-more-customers">さらに読み込む</button></div>`
      : ``;
    listEl.innerHTML = `${filtered.map((c) => cardHtml(c, canManageCustomerAssignments_())).join("")}${moreHtml}`;
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

    const res = await portalCustomersPetNames_(idToken, ids);
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
        customersAll = Array.isArray(cached.customers) ? cached.customers : [];
        _hasMore = !!(cached.meta && cached.meta.has_more);
        _nextOffset = Number(cached.meta && cached.meta.next_offset) || customersAll.length;
        _fetched = true;
        applyAndRender_();
        return;
      }
    }

    try {
      if (searchBtn) searchBtn.disabled = true;
      const page = await fetchCustomers_(state, query, { offset: 0 });
      customersAll = sortByKana_(page.customers);
      _hasMore = !!page.has_more;
      _nextOffset = Number(page.next_offset) || customersAll.length;
      saveCache_(ck, customersAll, { has_more: _hasMore, next_offset: _nextOffset });
      _fetched = true;
      applyAndRender_();
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    } finally {
      if (searchBtn) searchBtn.disabled = false;
    }
  };

  const loadMore_ = async () => {
    if (!_hasMore) return;
    const btn = listEl.querySelector('[data-action="load-more-customers"]');
    try {
      if (btn) btn.disabled = true;
      const page = await fetchCustomers_(state, query, { offset: _nextOffset });
      const seen = new Set(customersAll.map((x) => String(x.customer_id || "").trim()).filter(Boolean));
      const additions = page.customers.filter((x) => {
        const id = String(x.customer_id || "").trim();
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      customersAll = sortByKana_(customersAll.concat(additions));
      _hasMore = !!page.has_more;
      _nextOffset = Number(page.next_offset) || (_nextOffset + additions.length);
      saveCache_(cacheKey_(state), customersAll, { has_more: _hasMore, next_offset: _nextOffset });
      applyAndRender_();
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
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
    await fetchAndRender_({ force: true });
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
      await fetchAndRender_({ force: true });
      return;
    }

    if (a === "search") {
      _hasSearched = true;
      state.keyword = (kwEl && kwEl.value) ? kwEl.value : (state.keyword || "");
      saveState_(state);
      await fetchAndRender_({ force: true });
      return;
    }

    if (a === "load-more-customers") {
      await loadMore_();
      return;
    }

    if (a === "create-customer") {
      if (!isAdmin) {
        toast({ title: "権限なし", message: "管理者のみ実行できます。" });
        return;
      }
      const idToken = getIdToken();
      if (!idToken) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }
      if (!createFormEl) {
        toast({ title: "フォーム未検出", message: "ページを再読み込みして再度お試しください。" });
        return;
      }
      const surname = normStr_(getFormValue_(createFormEl, "surname"));
      const given = normStr_(getFormValue_(createFormEl, "given"));
      if (!(surname || given)) {
        toast({ title: "入力不足", message: "姓または名を入力してください（顧客名は自動生成されます）。" });
        return;
      }
      try {
        const customer = buildCustomerCreatePayload_(createFormEl, user);
        if (customer.registered_date && !customer.stage) {
          toast({ title: "入力不足", message: "登録日を入力する場合はステージ（仮登録/本登録）を選択してください。" });
          return;
        }
        const customerId = await runWithBlocking_(
          {
            title: "顧客情報を登録しています",
            bodyHtml: "入力内容を保存して一覧を更新しています。",
            busyText: "登録中...",
          },
          async (blocker) => {
            const res = await portalCustomersUpsert_(idToken, { action: "createCustomer", customer });
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
        try { createFormEl.reset(); } catch (_) {}
        syncOtherRuleInputState_(createFormEl, "key_pickup_rule", "key_pickup_rule_other");
        syncOtherRuleInputState_(createFormEl, "key_return_rule", "key_return_rule_other");
        toast({ title: "登録完了", message: customerId ? `顧客ID: ${customerId}` : "顧客を登録しました。" });
      } catch (e) {
        if (importResultEl) importResultEl.textContent = `登録失敗: ${e?.message || String(e)}`;
        toast({ title: "登録失敗", message: e?.message || String(e) });
      }
      return;
    }

    if (a === "import-from-mail") {
      if (!isAdmin) {
        toast({ title: "権限なし", message: "管理者のみ実行できます。" });
        return;
      }
      const idToken = getIdToken();
      if (!idToken) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }
      try {
        let importPayload = {};
        const out = await runWithBlocking_(
          {
            title: "メール取込を実行しています",
            bodyHtml: "問い合わせメールを解析して、顧客へ反映します。",
            busyText: "取込中...",
          },
          async (blocker) => {
            const res = await portalCustomersImportFromMail_(idToken, importPayload);
            if (!res || res.ok === false || res.success === false) {
              throw new Error((res && (res.error || res.message || res.operator_message)) || "import-from-mail failed");
            }
            blocker.setBusyText("一覧を更新しています...");
            await fetchAndRender_({ force: true });
            return res;
          }
        );
        const processed = Number(out?.processed || 0);
        const skipped = Number(out?.skipped || 0);
        const failed = Number(out?.failed || 0);
        const pending = Number(out?.pending_confirmation || 0);
        toast({ title: "取込完了", message: `処理:${processed} / 確認待ち:${pending} / スキップ:${skipped} / 失敗:${failed}` });
        if (pending > 0) {
          const action = await promptMailImportAmbiguousAction_(out);
          if (!action) return;
          importPayload = { ambiguous_match_action: action };
          const confirmedOut = await runWithBlocking_(
            {
              title: "メール取込を反映しています",
              bodyHtml: action === "create_new" ? "確認済みメールを新規顧客として登録します。" : "確認済みメールで既存顧客を上書きします。",
              busyText: "反映中...",
            },
            async (blocker) => {
              const res = await portalCustomersImportFromMail_(idToken, importPayload);
              if (!res || res.ok === false || res.success === false) {
                throw new Error((res && (res.error || res.message || res.operator_message)) || "import-from-mail failed");
              }
              blocker.setBusyText("一覧を更新しています...");
              await fetchAndRender_({ force: true });
              return res;
            }
          );
          toast({
            title: "反映完了",
            message: `処理:${Number(confirmedOut?.processed || 0)} / 確認待ち:${Number(confirmedOut?.pending_confirmation || 0)} / 失敗:${Number(confirmedOut?.failed || 0)}`,
          });
        }
      } catch (e) {
        toast({ title: "取込失敗", message: e?.message || String(e) });
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

    if (action === "visits") {
      const c = (customersAll || []).find(x => String(x.customer_id || "") === String(cid)) || {};
      const label = String(c.name || "").trim();
      const params = new URLSearchParams();
      params.set("customer_id", cid);
      if (label) params.set("customer_label", label);
      params.set("scope", "future");
      params.set("back_to", location.hash || "#/customers");
      location.hash = `#/visits?${params.toString()}`;
      return;
    }

    if (action === "assignments") {
      const c = (customersAll || []).find(x => String(x.customer_id || "") === String(cid)) || {};
      const label = String(c.name || "").trim();
      await openCustomerAssignmentModal({ customerId: cid, customerName: label, idToken: getIdToken() });
      return;
    }
  }, { signal: eventController.signal });
}
