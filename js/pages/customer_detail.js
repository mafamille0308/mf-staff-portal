// js/pages/customer_detail.js
import { render, escapeHtml, toast, showModal, fmt, displayOrDash, fmtDateTimeJst, fmtDateJst, fmtAgeFromBirthdateJst } from "../ui.js";
import { callGas, unwrapOne } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

const KEY_CD_CACHE_PREFIX = "mf:customer_detail:cache:v1:";
const CD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分

// ===== UIラベル（単一ソース）=====
const FIELD_LABELS_JA = {
  customer_id: "顧客ID",
  name: "顧客名",
  phone: "電話",
  emergency_phone: "緊急連絡先",
  email: "メール",
  billing_email: "請求先メール",
  postal_code: "郵便番号",
  address_full: "住所",
  parking_info: "駐車場",
  parking_fee_rule: "駐車料金区分",
  key_pickup_rule: "鍵預かりルール",
  key_pickup_rule_other: "鍵預かりルール（その他）",
  key_pickup_fee_rule: "鍵預かり料金区分",
  key_return_rule: "鍵返却ルール",
  key_return_rule_other: "鍵返却ルール（その他）",
  key_return_fee_rule: "鍵返却料金区分",
  key_location: "鍵の所在",
  lock_no: "ロック番号",
  notes: "メモ",
  stage: "ステージ",
  registered_date: "登録日",
  updated_at: "更新日時",

  // edit用（既存表示に合わせて文言はそのまま）
  name_ro: "顧客名（表示専用）",
  surname: "姓",
  given: "名",
  surname_kana: "姓かな",
  given_kana: "名かな",

  // address parts
  address_full_ro: "住所（表示専用）",
  prefecture: "都道府県",
  city: "市区町村",
  address_line1: "町域・番地",
  address_line2: "建物・部屋",

  // key
  key_pickup_rule_other_detail: "鍵受取ルール（その他詳細）",
  key_return_rule_other_detail: "鍵返却ルール（その他詳細）",
};

// ===== 顧客情報編集時の選択肢 =====
const KEY_PICKUP_RULE_OPTIONS = ["継続保管", "郵送預かり", "メールボックス預かり", "鍵なし", "その他"];
const KEY_RETURN_RULE_OPTIONS = ["継続保管", "ポスト返却", "メールボックス返却", "郵送返却", "鍵なし", "その他"];
const KEY_LOCATION_OPTIONS    = ["顧客", "本部", "担当者", "鍵なし"];

// ===== ペット用 UIラベル（単一ソース）=====
const PET_FIELD_LABELS_JA = {
  pet_id: "ペットID",
  customer_id: "顧客ID",
  name: "ペット名",
  species: "種類",
  breed: "品種",
  gender: "性別",
  birthdate: "誕生日",
  age: "年齢",
  weight_kg: "体重(kg)",
  rabies_vaccine_at: "狂犬病予防注射",
  combo_vaccine_at: "混合ワクチン",
  health: "健康",
  notes: "メモ",
  hospital: "病院",
  hospital_phone: "病院電話",
  registered_date: "登録日",
  updated_at: "更新日時",
  is_active: "ステータス",
};

// ===== ペット情報編集時の選択肢 =====
const KEY_SPECIES_OPTIONS = ["犬", "猫", "小動物"];
const KEY_GENDER_OPTIONS  = ["オス", "オス（去勢）", "メス", "メス（避妊）", "不明"];

function normStr_(v) {
  const s = fmt(v);
  return (s == null) ? "" : String(s).trim();
}

// ===== ブロッキング表示（保存中など）=====
// ui.js の showModal は「確認」に使い、保存中はこの軽量オーバーレイで統一（入力DOMを壊さない）
function openBlockingOverlay_({ title, bodyHtml, busyText = "保存中..." } = {}) {
 const el = document.createElement("div");
  el.setAttribute("data-el", "mfBlockingOverlay");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.zIndex = "9999";
  el.style.background = "rgba(0,0,0,.35)";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.padding = "16px";

  // 既存UIのclassを流用（card/p/btn）し、見た目は馴染ませる
  el.innerHTML = `
    <div class="card" style="max-width:520px; width:100%; box-shadow:0 10px 30px rgba(0,0,0,.2);">
      <div class="p">
        <div class="p" style="margin:0 0 8px 0;"><strong>${escapeHtml(title || "")}</strong></div>
        <div class="p" style="opacity:.9; margin:0 0 10px 0;">${bodyHtml || ""}</div>
        <div class="hr"></div>
        <div class="p" style="display:flex; gap:10px; align-items:center; opacity:.85;">
          <span class="spinner" aria-hidden="true"></span>
          <span data-el="busyText">${escapeHtml(busyText || "処理中...")}</span>
        </div>
      </div>
    </div>
  `;

  // 簡易スピナー（CSS未依存）
  const sp = el.querySelector(".spinner");
  if (sp) {
    sp.style.width = "16px";
    sp.style.height = "16px";
    sp.style.border = "2px solid rgba(0,0,0,.2)";
    sp.style.borderTopColor = "rgba(0,0,0,.6)";
    sp.style.borderRadius = "50%";
    sp.style.animation = "mfSpin .9s linear infinite";
    if (!document.getElementById("mfSpinStyle")) {
      const st = document.createElement("style");
      st.id = "mfSpinStyle";
      st.textContent = `
        @keyframes mfSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `;
      document.head.appendChild(st);
    }
  }

  document.body.appendChild(el);

  return {
    setBusyText(text) {
      const t = el.querySelector('[data-el="busyText"]');
      if (t) t.textContent = String(text || "");
    },
    close() {
      try { el.remove(); } catch (_) {}
    }
  };
}

function inputDateRow_(label, name, value, { help = "", readonly = false } = {}) {
  // GAS 側は normalizeDateKeyJst を通す想定なので、yyyy-mm-dd を渡せばOK
  const v = normStr_(value); // すでに date key で来る前提（buildPetObjFromRow）
  return inputRow_(label, name, v, { type: "date", placeholder: "", help, readonly });
}

function pickFirst_(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    const s = normStr_(v);
    if (s) return s;
  }
  return "";
}

function lineBlock_(label, text) {
  const s = normStr_(text);
  if (!s) return "";
  return `
    <div class="hr"></div>
    <div class="p"><strong>${escapeHtml(label)}</strong></div>
    <div class="card">
      <div class="p" style="white-space:pre-wrap;">${escapeHtml(s)}</div>
    </div>
  `;
}

function rawToggle_(rawText) {
  const s = normStr_(rawText);
  if (!s) return "";
  return `
    <div class="hr"></div>
    <details class="details">
      <summary class="p" style="cursor:pointer; user-select:none;">
        <strong>カルテ原本（OCR）</strong>（タップで表示）
      </summary>
      <div class="card" style="margin-top:8px;">
        <div class="p" style="white-space:pre-wrap;">${escapeHtml(s)}</div>
      </div>
    </details>
  `;
}

function customerKanaHtml_(c) {
  const sk = (c?.surname_kana || c?.surnameKana || "").trim();
  const gk = (c?.given_kana || c?.givenKana || "").trim();
  const kk = (sk + gk).trim();
  return kk ? ` <span style="opacity:.75;">(${escapeHtml(kk)})</span>` : "";
}

function renderCareProfile_(cp) {
  if (!cp || typeof cp !== "object") return `<p class="p">お世話情報がありません。</p>`;

  // 互換吸収（段階移行を許容）
  const warnings = pickFirst_(cp, ["warnings", "注意事項"]);
  const raw      = pickFirst_(cp, ["content_raw", "内容原本"]);
  const content  = pickFirst_(cp, ["content", "内容"]);
  const food     = pickFirst_(cp, ["food_care", "ごはん", "ごはんのお世話"]);
  const toilet   = pickFirst_(cp, ["toilet_care", "トイレ", "トイレのお世話"]);
  const walk     = pickFirst_(cp, ["walk_care", "散歩", "散歩のお世話"]);
  const play     = pickFirst_(cp, ["play_care", "遊び", "遊び・お散歩のお世話"]);
  const other    = pickFirst_(cp, ["other_care", "その他", "室内環境・その他", "environment_other"]);

  // どれも無い場合は、旧データの content だけでも表示
  const any = warnings || raw || content || food || toilet || walk || play || other;
  if (!any) return `<p class="p">お世話情報がありません。</p>`;

  // content（要約）は「なくてもいい」方針に合わせ、表示しない（必要になったら復帰可能）
  return `
    ${lineBlock_("注意事項", warnings)}
    ${lineBlock_("ごはん", food)}
    ${lineBlock_("トイレ", toilet)}
    ${lineBlock_("散歩", walk)}
    ${lineBlock_("遊び", play)}
    ${lineBlock_("その他", other)}
    ${rawToggle_(raw)}
  `;
}

function section(title, bodyHtml, actionsHtml) {
  return `
    <div class="hr"></div>
    <div class="row row-between">
      <h2 class="h2">${escapeHtml(title)}</h2>
      <div>${actionsHtml || ""}</div>
    </div>
    <div class="p">${bodyHtml || ""}</div>
  `;
}

function extractCustomerDetail_(obj) {
  if (!obj) return null;

  // 1) まず「本体が直置き」パターン（getCustomerDetail の想定）
  if (obj.customer || obj.pets || obj.careProfile || obj.care_profile) {
    return {
      customer: obj.customer || null,
      pets: Array.isArray(obj.pets) ? obj.pets : [],
      careProfile: obj.careProfile || obj.care_profile || null,
    };
  }

  // 2) 次に「customer_detail の箱」パターン（他API互換）
  const d = obj.customer_detail || obj.customerDetail || obj.result || null;
  if (!d) return null;

  return {
    customer: d.customer || null,
    pets: Array.isArray(d.pets) ? d.pets : [],
    careProfile: d.careProfile || d.care_profile || null,
  };
}

function normalizeChoice_(val, options) {
  const s = normStr_(val);
  if (!s) return "";
  if (options.includes(s)) return s;

  // 代表的な表記揺れ吸収（最小限）
  const n = s.replace(/\s+/g, "");
  for (const opt of options) {
    if (n === opt.replace(/\s+/g, "")) return opt;
  }

  // 末尾/先頭の付帯（例: "継続保管（本部）"）は含む一致で寄せる
  for (const opt of options) {
    if (n.includes(opt.replace(/\s+/g, ""))) return opt;
  }
  return "その他";
}

function parkingFeeRuleLabel_(v) {
  const s = normStr_(v).toLowerCase();
  if (s === "free" || s === "無料") return "無料";
  if (s === "paid" || s === "有料") return "有料";
  if (s === "unknown" || s === "不明") return "不明";
  return "";
}

function keyFeeRuleLabel_(v) {
  const s = normStr_(v).toLowerCase();
  if (s === "free" || s === "無料") return "無料";
  if (s === "paid" || s === "有料") return "有料";
  if (s === "unknown" || s === "不明") return "不明";
  return "";
}

function inputRow_(label, name, value, { type = "text", placeholder = "", help = "", readonly = false } = {}) {
  const ro = readonly ? "readonly" : "";
  return `
    <div class="p" style="margin-bottom:10px;">
      <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(label)}</strong></div>
      <input class="input" type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(normStr_(value))}" placeholder="${escapeHtml(placeholder)}" ${ro}/>
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
        ${options.map(opt => `<option value="${escapeHtml(opt)}" ${cur === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
      </select>
      ${help ? `<div class="p text-sm" style="opacity:.75; margin-top:4px;">${escapeHtml(help)}</div>` : ""}
    </div>
  `;
}

function getFormValue_(formEl, name) {
  const el = formEl?.querySelector(`[name="${CSS.escape(name)}"]`);
  if (!el) return null;
  return normStr_(el.value);
}

export async function renderCustomerDetail(appEl, query) {
  const customerId = query.get("id") || "";
  if (!customerId) {
    render(appEl, `<section class="section"><h1 class="h1">顧客詳細</h1><p class="p">customer_id が指定されていません。</p></section>`);
    return;
  }

  // ===== local state（このページ内だけ）=====
  let _mode = "view"; // "view" | "edit"
  let _busy = false;
  let _detail = null; // { customer, pets, careProfile }

  // ===== pets local state（ペットは個別編集）=====
  let _petEditId = "";   // 現在編集中の pet_id
  let _petBusy = false;  // ペット保存中
  let _petAdd = false;   // ペット追加中
  let _showInactivePets = false; // デフォルトは有効のみ表示

  // ===== 再取得（単一ソース）=====
  async function refetchDetail_() {
    const res = await callGas({
      action: "getCustomerDetail",
      customer_id: customerId,
      include_pets: true,
      include_care_profile: true,
    }, idToken);
    if (!res || res.success === false) throw new Error((res && (res.error || res.message)) || "getCustomerDetail failed");
    if (res.ctx) setUser(res.ctx);
    const detail =
      (res.customer || res.pets || res.careProfile || res.care_profile)
        ? { customer: res.customer || null, pets: Array.isArray(res.pets) ? res.pets : [], careProfile: res.careProfile || res.care_profile || null }
        : extractCustomerDetail_(unwrapOne(res) || res);
    if (!detail || !detail.customer) throw new Error("再取得に失敗しました（detail.customer が空）");
    return detail;
  }

  render(appEl, `
    <section class="section">
      <div class="row row-between">
        <h1 class="h1">顧客詳細</h1>
        <a class="btn btn-ghost" href="#/customers" id="btnBackCustomers">一覧に戻る</a>
      </div>
      <div class="hr"></div>
      <div data-el="host"><p class="p">読み込み中...</p></div>
    </section>
  `);

  // 履歴があれば back 優先
  const backBtn = appEl.querySelector("#btnBackCustomers");
  backBtn?.addEventListener("click", (e) => {
    if (window.history && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
  });

  const host = appEl.querySelector('[data-el="host"]');
  const idToken = getIdToken();
  if (!idToken) {
    host.innerHTML = `<p class="p">ログインしてください。</p>`;
    return;
  }

  // ===== events（イベント委譲）=====
  host.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const a = btn.getAttribute("data-action");

    if (a === "cd:save") {
      if (_busy) return;
      if (!_detail || !_detail.customer) return;

      const formEl = host.querySelector('form[data-el="customerEditForm"]');
      if (!formEl) return;

      // 変更差分（パッチ）：GAS upsertCustomer は undefined をスキップする
      const c0 = _detail.customer || {};
      const patch = { action: "upsertCustomer", customer: { customer_id: (c0.id || c0.customer_id || customerId) } };

      // 氏名（surname/given が来ていれば GAS 側で name を再構成）
      const surname = getFormValue_(formEl, "surname");
      const given   = getFormValue_(formEl, "given");
      const surnameKana = getFormValue_(formEl, "surname_kana");
      const givenKana   = getFormValue_(formEl, "given_kana");

      // 顧客名はGAS側で surname/given から組み立てるため、ここでは surname/given を必須に寄せる
      if (!(surname || given)) {
        toast({ title: "入力不足", message: "姓または名を入力してください（顧客名は自動生成されます）。" });
        return;
      }

      // 元値と比較して差分のみ送る
      const valOrNull_ = (v) => {
        // クリアを許可：空欄は null として送る（GAS側で上書き）
        // ※入力欄が存在しない/取得できない場合のみ null を返さず「未指定」を維持する
        if (v == null) return undefined; // ← field not found 等は未指定扱い（送らない）
        const s = normStr_(v);
        return (s === "") ? null : s;
      };

      const curNorm_ = (v) => {
        // 比較用：null/undefined/""
        const s = normStr_(v);
        return (s === "") ? "" : s;
      };

      const setIfChanged = (key, nextRaw, curRaw) => {
        const next = valOrNull_(nextRaw);     // undefined | null | "text"
        if (next === undefined) return;       // 取得不可＝未指定＝維持
        const cur = curNorm_(curRaw);         // "" | "text"
        const ncmp = (next === null) ? "" : String(next);
        if (ncmp !== cur) patch.customer[key] = next; // null は「クリア」
      };

      setIfChanged("surname", surname, (c0.surname || ""));
      setIfChanged("given", given, (c0.given || ""));
      setIfChanged("surname_kana", surnameKana, (c0.surname_kana || c0.surnameKana || ""));
      setIfChanged("given_kana", givenKana, (c0.given_kana || c0.givenKana || ""));

      setIfChanged("phone", getFormValue_(formEl, "phone"), (c0.phone || ""));
      setIfChanged("emergency_phone", getFormValue_(formEl, "emergency_phone"), (c0.emergency_phone || c0.emergencyPhone || ""));
      setIfChanged("email", getFormValue_(formEl, "email"), (c0.email || ""));
      setIfChanged("billing_email", getFormValue_(formEl, "billing_email"), (c0.billing_email || c0.billingEmail || ""));
      setIfChanged("parking_info", getFormValue_(formEl, "parking_info"), (c0.parking_info || c0.parkingInfo || ""));

      // 駐車料金区分：UI=無料/有料（表示のみ unknown 対応）、保存=free/paid（未選択は誤消し防止で送らない）
      const nextPfr = getFormValue_(formEl, "parking_fee_rule"); // "free" | "paid" | ""
      const curPfrRaw = (c0.parking_fee_rule || c0.parkingFeeRule || "");
      const curPfr = (() => {
        const s = normStr_(curPfrRaw).toLowerCase();
        if (s === "free" || normStr_(curPfrRaw) === "無料") return "free";
        if (s === "paid" || normStr_(curPfrRaw) === "有料") return "paid";
        return "";
      })();
      // ここは選択UIなので「未選択」はクリア扱いにしない（誤消し防止）
      if (nextPfr && nextPfr !== curPfr) patch.customer.parking_fee_rule = nextPfr;
      setIfChanged("lock_no", getFormValue_(formEl, "lock_no"), (c0.lock_no || c0.lockNo || ""));
      setIfChanged("notes", getFormValue_(formEl, "notes"), (c0.notes || ""));

      // 鍵料金区分：UI=無料/有料（表示のみ unknown 対応）、保存=free/paid（未選択は誤消し防止で送らない）
      const nextKpfr = getFormValue_(formEl, "key_pickup_fee_rule"); // "free" | "paid" | ""
      const nextKrfr = getFormValue_(formEl, "key_return_fee_rule"); // "free" | "paid" | ""
      const curKpfrRaw = (c0.key_pickup_fee_rule || c0.keyPickupFeeRule || "");
      const curKrfrRaw = (c0.key_return_fee_rule || c0.keyReturnFeeRule || "");

      const normKeyFeeRule_ = (raw) => {
        const s = normStr_(raw).toLowerCase();
        if (s === "free" || normStr_(raw) === "無料") return "free";
        if (s === "paid" || normStr_(raw) === "有料") return "paid";
        return "";
      };
      const curKpfr = normKeyFeeRule_(curKpfrRaw);
      const curKrfr = normKeyFeeRule_(curKrfrRaw);

      if (nextKpfr && nextKpfr !== curKpfr) patch.customer.key_pickup_fee_rule = nextKpfr;
      if (nextKrfr && nextKrfr !== curKrfr) patch.customer.key_return_fee_rule = nextKrfr;

      // 住所：分割のみ編集。address_full はUIで編集しないが、parts変更時はGASが自動更新する。
      const apPostal = getFormValue_(formEl, "postal_code");
      const apPref   = getFormValue_(formEl, "prefecture");
      const apCity   = getFormValue_(formEl, "city");
      const apL1     = getFormValue_(formEl, "address_line1");
      const apL2     = getFormValue_(formEl, "address_line2");

      // 差分があるフィールドのみ送る（空欄は null で「クリア」）
      setIfChanged("postal_code", apPostal, (c0.postal_code || (c0.address_parts && c0.address_parts.postal_code) || ""));
      setIfChanged("prefecture", apPref, (c0.prefecture || (c0.address_parts && c0.address_parts.prefecture) || ""));
      setIfChanged("city", apCity, (c0.city || (c0.address_parts && c0.address_parts.city) || ""));
      setIfChanged("address_line1", apL1, (c0.address_line1 || (c0.address_parts && c0.address_parts.address_line1) || ""));
      setIfChanged("address_line2", apL2, (c0.address_line2 || (c0.address_parts && c0.address_parts.address_line2) || ""));

      // 鍵：選択肢統一＋ゆらぎ吸収
      const nextPickup = getFormValue_(formEl, "key_pickup_rule");
      const nextReturn = getFormValue_(formEl, "key_return_rule");
      const nextLoc    = getFormValue_(formEl, "key_location");
      const normPickup = nextPickup ? normalizeChoice_(nextPickup, KEY_PICKUP_RULE_OPTIONS) : "";
      const normReturn = nextReturn ? normalizeChoice_(nextReturn, KEY_RETURN_RULE_OPTIONS) : "";
      const normLoc    = nextLoc    ? normalizeChoice_(nextLoc,    KEY_LOCATION_OPTIONS)    : "";

      // 選択済みの時だけ差分送信
      if (normPickup && normPickup !== normStr_(c0.key_pickup_rule || c0.keyPickupRule)) patch.customer.key_pickup_rule = normPickup;
      if (normReturn && normReturn !== normStr_(c0.key_return_rule || c0.keyReturnRule)) patch.customer.key_return_rule = normReturn;
      if (normLoc    && normLoc    !== normStr_(c0.key_location || c0.keyLocation))       patch.customer.key_location = normLoc;

      // 「その他」詳細：その他選択時のみ送る（パッチセマンティクスを維持）
      const nextPickupOther = getFormValue_(formEl, "key_pickup_rule_other");
      const nextReturnOther = getFormValue_(formEl, "key_return_rule_other");
      const curPickupOther = (c0.key_pickup_rule_other || c0.keyPickupRuleOther || "");
      const curReturnOther = (c0.key_return_rule_other || c0.keyReturnRuleOther || "");
      if (normPickup === "その他") {
        setIfChanged("key_pickup_rule_other", nextPickupOther, curPickupOther);
      }
      if (normReturn === "その他") {
        setIfChanged("key_return_rule_other", nextReturnOther, curReturnOther);
      }
      // 「その他」以外に戻した場合は、その他詳細をクリアして整合性維持（UX自然）
      if (normPickup && normPickup !== "その他") {
        setIfChanged("key_pickup_rule_other", "", curPickupOther);
      }
      if (normReturn && normReturn !== "その他") {
        setIfChanged("key_return_rule_other", "", curReturnOther);
      }

      const patchKeys = Object.keys(patch.customer).filter(k => k !== "customer_id" && k !== "id");
      if (patchKeys.length === 0) {
        toast({ title: "変更なし", message: "保存する変更がありません。" });
        return;
      }

      const patchLabelsHtml = patchKeys
        .map(k => escapeHtml(FIELD_LABELS_JA[k] || k))
        .join("<br>");

      const ok = await showModal({
        title: "顧客情報を保存",
        bodyHtml: `
          <div class="p">変更を保存します。よろしいですか？</div>
          <div class="hr"></div>
          <div class="p text-sm" style="opacity:.75;">
            <div style="margin-bottom:4px;">変更項目：</div>
            <div style="padding-left:8px; line-height:1.6;">${patchLabelsHtml}</div>
          </div>
          <div class="p text-sm" style="opacity:.75;">空欄にした項目は「削除（クリア）」として保存されます。</div>
        `,
        okText: "保存",
        cancelText: "キャンセル",
      });
      if (!ok) return;

      // 保存開始で render しない（入力DOMを壊さない）
      const blocker = openBlockingOverlay_({
        title: "顧客情報を保存",
        bodyHtml: `<div class="p">保存しています。完了するまでそのままお待ちください。</div>`,
        busyText: "保存中...",
      });

      try {
        _busy = true;
        const resUp = await callGas(patch, idToken);
        if (!resUp || resUp.ok === false) throw new Error((resUp && (resUp.error || resUp.message)) || "upsertCustomer failed");
        if (resUp.ctx) setUser(resUp.ctx);

        // 再取得→反映
        const detail = await refetchDetail_();
        _detail = detail;
        _mode = "view";
        renderHost_(detail);

        // cache 更新
        try { sessionStorage.setItem(KEY_CD_CACHE_PREFIX + String(customerId), JSON.stringify({ ts: Date.now(), detail })); } catch (_) {}

        toast({ title: "保存完了", message: "顧客情報を更新しました。" });
      } catch (err) {
        toast({ title: "保存失敗", message: err?.message || String(err) });
      } finally {
        _busy = false;
        blocker.close();
        // 失敗時は編集状態を維持し、入力DOMも維持されている（renderしない）
      }
    }

    // ===== 顧客：編集開始 =====
    if (a === "cd:enter-edit") {
      if (_busy) return;
      _mode = "edit";
      if (_detail) renderHost_(_detail);
      return;
    }

    // ===== 顧客：キャンセル =====
    if (a === "cd:cancel-edit") {
      if (_busy) return;
      _mode = "view";
      if (_detail) renderHost_(_detail);
      return;
    }

    // ===== ペット：編集開始 =====
    if (a === "pet:enter-edit") {
      if (_petBusy) return;
      const pid = btn.getAttribute("data-pet-id") || "";
      if (!pid) return;
      _petEditId = pid;
      if (_detail) renderHost_(_detail);
      return;
    }

    // ===== ペット：キャンセル =====
    if (a === "pet:cancel-edit") {
      if (_petBusy) return;
      _petEditId = "";
      if (_detail) renderHost_(_detail);
      return;
    }

   // ===== ペット：保存 =====
   if (a === "pet:save") {
      if (_petBusy) return;
      if (!_detail || !_detail.customer) return;
      const pid = btn.getAttribute("data-pet-id") || "";
      if (!pid) return;

      const formEl = host.querySelector(`form[data-el="petEditForm"][data-pet-id="${CSS.escape(pid)}"]`);
      if (!formEl) return;

      const pets = Array.isArray(_detail.pets) ? _detail.pets : [];
      const p0 = pets.find(x => String(x?.id || x?.pet_id || "") === String(pid)) || {};

      const valOrNull_ = (v) => {
        if (v == null) return undefined; // 取得不可＝未指定
        const s = normStr_(v);
        return (s === "") ? null : s;    // 空欄＝クリア
      };
      const curNorm_ = (v) => {
        const s = normStr_(v);
        return (s === "") ? "" : s;
      };
      const setIfChanged = (key, nextRaw, curRaw) => {
        const next = valOrNull_(nextRaw); // undefined | null | "text"
        if (next === undefined) return;
        const cur = curNorm_(curRaw);
        const ncmp = (next === null) ? "" : String(next);
        if (ncmp !== cur) patchPet[key] = next; // null は「クリア」
      };

      // upsertPets: undefined は既存保持 / null はクリア
      const patchPet = { pet_id: (p0.id || p0.pet_id || pid) };

      // 必須：ペット名（GAS側も name 無いとスキップする）
      const nextName = getFormValue_(formEl, "name");
      if (!nextName) {
        toast({ title: "入力不足", message: "ペット名を入力してください。" });
        return;
      }

      setIfChanged("name", nextName, (p0.name || p0.pet_name || ""));
      setIfChanged("species", getFormValue_(formEl, "species"), (p0.species || p0.type || p0.pet_type || ""));
      setIfChanged("breed", getFormValue_(formEl, "breed"), (p0.breed || ""));
      setIfChanged("gender", getFormValue_(formEl, "gender"), (p0.gender || p0.sex || ""));

      // 日付：date picker → yyyy-mm-dd を送る
      setIfChanged("birthdate", getFormValue_(formEl, "birthdate"), (p0.birthdate || ""));
      setIfChanged("rabies_vaccine_at", getFormValue_(formEl, "rabies_vaccine_at"), (p0.rabies_vaccine_at || ""));
      setIfChanged("combo_vaccine_at", getFormValue_(formEl, "combo_vaccine_at"), (p0.combo_vaccine_at || ""));

      // 数値は文字列で送ってOK（GAS側はシートにそのまま入る）
      setIfChanged("weight_kg", getFormValue_(formEl, "weight_kg"), (p0.weight_kg || ""));

      // テキスト
      setIfChanged("health", getFormValue_(formEl, "health"), (p0.health || ""));
      setIfChanged("notes", getFormValue_(formEl, "notes"), (p0.notes || p0.memo || ""));
      setIfChanged("hospital", getFormValue_(formEl, "hospital"), (p0.hospital || ""));
      setIfChanged("hospital_phone", getFormValue_(formEl, "hospital_phone"), (p0.hospital_phone || ""));

      // is_active（チェックボックス）
      {
        const el = formEl.querySelector('input[name="is_active"]');
        if (el) {
          const next = el.checked;
          const cur = (p0.is_active === "" || p0.is_active == null) ? true : !!p0.is_active;
          if (next !== cur) patchPet.is_active = next;
        }
      }

      const patchKeys = Object.keys(patchPet).filter(k => k !== "pet_id" && k !== "id");
      if (patchKeys.length === 0) {
        toast({ title: "変更なし", message: "保存する変更がありません。" });
        _petEditId = "";
        renderHost_(_detail);
        return;
      }

      const patchLabelsHtml = patchKeys
        .map(k => escapeHtml(PET_FIELD_LABELS_JA[k] || k))
        .join("<br>");

      const ok = await showModal({
        title: "ペット情報を保存",
        bodyHtml: `
          <div class="p">変更を保存します。よろしいですか？</div>
          <div class="hr"></div>
          <div class="p text-sm" style="opacity:.75;">
            <div style="margin-bottom:4px;">変更項目：</div>
            <div style="padding-left:8px; line-height:1.6;">${patchLabelsHtml}</div>
          </div>
          <div class="p text-sm" style="opacity:.75;">空欄にした項目は「削除（クリア）」として保存されます。</div>
        `,
        okText: "保存",
        cancelText: "キャンセル",
      });
      if (!ok) return;

      // 保存開始で render しない（編集中フォームを壊さない）
      const blocker = openBlockingOverlay_({
        title: "ペット情報を保存",
        bodyHtml: `<div class="p">保存しています。完了するまでそのままお待ちください。</div>`,
        busyText: "保存中...",
      });

      try {
        _petBusy = true;
        const resUp0 = await callGas({
          action: "upsertPets",
          pets: {
            customer_id: customerId,
            pets: [patchPet],
          }
        }, idToken);
        const resUp = unwrapOne(resUp0) || resUp0; // envelope吸収
        if (!resUp || resUp.success === false) throw new Error((resUp && (resUp.error || resUp.message)) || "upsertPets failed");
        if (resUp.ok !== true) throw new Error((resUp && (resUp.error || resUp.message)) || "upsertPets failed (ok!=true)");
        if (resUp.ctx) setUser(resUp.ctx);

        const detail = await refetchDetail_();
        _detail = detail;
        _petEditId = "";
        renderHost_(detail);

        // cache 更新
        try { sessionStorage.setItem(KEY_CD_CACHE_PREFIX + String(customerId), JSON.stringify({ ts: Date.now(), detail })); } catch (_) {}

        toast({ title: "保存完了", message: "ペット情報を更新しました。" });
      } catch (err) {
        toast({ title: "保存失敗", message: err?.message || String(err) });
      } finally {
        _petBusy = false;
        blocker.close();
        // 失敗時：編集フォームは維持（renderしない）
      }
      return;
    }

    // ===== ペット：追加開始 =====
    if (a === "pet:add:open") {
      if (_petBusy) return;
      _petAdd = true;
      _petEditId = "";
      renderHost_(_detail);
      return;
    }

    // ===== ペット：追加キャンセル =====
    if (a === "pet:add:cancel") {
      if (_petBusy) return;
      _petAdd = false;
      renderHost_(_detail);
      return;
    }

    // ===== ペット：追加保存 =====
    if (a === "pet:add:save") {
      if (_petBusy) return;
      const formEl = host.querySelector('form[data-el="petAddForm"]');
      if (!formEl) return;

      const name = getFormValue_(formEl, "name");
      if (!name) {
        toast({ title: "入力不足", message: "ペット名を入力してください。" });
        return;
      }

      const valOrNull_ = (v) => {
        if (v == null) return undefined;
        const s = normStr_(v);
        return (s === "") ? null : s;
      };

      const pet = {
        name,
        species: valOrNull_(getFormValue_(formEl, "species")),
        breed: valOrNull_(getFormValue_(formEl, "breed")),
        gender: valOrNull_(getFormValue_(formEl, "gender")),
        birthdate: valOrNull_(getFormValue_(formEl, "birthdate")),
        weight_kg: valOrNull_(getFormValue_(formEl, "weight_kg")),
        rabies_vaccine_at: valOrNull_(getFormValue_(formEl, "rabies_vaccine_at")),
        combo_vaccine_at: valOrNull_(getFormValue_(formEl, "combo_vaccine_at")),
        health: valOrNull_(getFormValue_(formEl, "health")),
        notes: valOrNull_(getFormValue_(formEl, "notes")),
        hospital: valOrNull_(getFormValue_(formEl, "hospital")),
        hospital_phone: valOrNull_(getFormValue_(formEl, "hospital_phone")),
        is_active: true,
      };

      // 追加も確認→保存中ブロック（保存開始render禁止）
      const ok = await showModal({
        title: "ペットを追加",
        bodyHtml: `<div class="p">この内容で追加します。よろしいですか？</div>`,
        okText: "追加",
        cancelText: "キャンセル",
      });
      if (!ok) return;

      const blocker = openBlockingOverlay_({
        title: "ペットを追加",
        bodyHtml: `<div class="p">追加しています。完了するまでそのままお待ちください。</div>`,
        busyText: "追加中...",
      });

      try {
        _petBusy = true;
        const resUp0 = await callGas({
          action: "upsertPets",
          pets: {
            customer_id: customerId,
            create_only: true, // 新規追加モード
            pets: [pet],
          }
        }, idToken);
        const resUp = unwrapOne(resUp0) || resUp0; // envelope吸収
        if (!resUp || resUp.success === false) throw new Error((resUp && (resUp.error || resUp.message)) || "upsertPets failed");
        if (resUp.ok !== true) throw new Error((resUp && (resUp.error || resUp.message)) || "upsertPets failed (ok!=true)");
        if (resUp.ctx) setUser(resUp.ctx);

        const detail = await refetchDetail_();
        _detail = detail;
        _petAdd = false;
        renderHost_(detail);

        try { sessionStorage.setItem(KEY_CD_CACHE_PREFIX + String(customerId), JSON.stringify({ ts: Date.now(), detail })); } catch (_) {}

        toast({ title: "追加完了", message: "ペットを追加しました。" });
      } catch (err) {
        toast({ title: "追加失敗", message: err?.message || String(err) });
      } finally {
        _petBusy = false;
        blocker.close();
      }
      return;
    }
  });

  // select の変更に追従して「その他詳細」欄を有効化
  host.addEventListener("change", (e) => {
    // ===== ペット表示オプション =====
    if (e.target && e.target.matches('input[name="show_inactive_pets"]')) {
      _showInactivePets = !!e.target.checked;
      if (_detail) renderHost_(_detail);
      return;
    }

    if (_mode !== "edit") return;
    const t = e.target;
    if (!t) return;
    if (t.matches('select[name="key_pickup_rule"]')) {
      const formEl = host.querySelector('form[data-el="customerEditForm"]');
      const otherEl = formEl?.querySelector('input[name="key_pickup_rule_other"]');
      if (otherEl) otherEl.disabled = (normStr_(t.value) !== "その他");
    }
    if (t.matches('select[name="key_return_rule"]')) {
      const formEl = host.querySelector('form[data-el="customerEditForm"]');
      const otherEl = formEl?.querySelector('input[name="key_return_rule_other"]');
      if (otherEl) otherEl.disabled = (normStr_(t.value) !== "その他");
    }
  });

  // ===== 顧客表示：カード本文のみ（堅牢版）=====
  function renderCustomerViewBodyHtml_(c) {
    return `
      <div class="p">
        <div><strong>${escapeHtml(FIELD_LABELS_JA.customer_id)}</strong>：${escapeHtml(displayOrDash(c.id || c.customer_id || customerId))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.phone)}</strong>：${escapeHtml(displayOrDash(c.phone))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.emergency_phone)}</strong>：${escapeHtml(displayOrDash(c.emergency_phone || c.emergencyPhone))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.email)}</strong>：${escapeHtml(displayOrDash(c.email))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.billing_email)}</strong>：${escapeHtml(displayOrDash(c.billing_email || c.billingEmail))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.postal_code)}</strong>：${escapeHtml(displayOrDash(c.postal_code || (c.address_parts && c.address_parts.postal_code)))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.address_full)}</strong>：${escapeHtml(displayOrDash(c.address_full || c.addressFull || c.address))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.parking_info)}</strong>：${escapeHtml(displayOrDash(c.parking_info || c.parkingInfo))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.parking_fee_rule)}</strong>：${escapeHtml(displayOrDash(parkingFeeRuleLabel_(c.parking_fee_rule || c.parkingFeeRule)))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_pickup_rule)}</strong>：${escapeHtml(displayOrDash(c.key_pickup_rule || c.keyPickupRule))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_pickup_rule_other)}</strong>：${escapeHtml(displayOrDash(c.key_pickup_rule_other || c.keyPickupRuleOther))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_pickup_fee_rule)}</strong>：${escapeHtml(displayOrDash(keyFeeRuleLabel_(c.key_pickup_fee_rule || c.keyPickupFeeRule)))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_return_rule)}</strong>：${escapeHtml(displayOrDash(c.key_return_rule || c.keyReturnRule))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_return_rule_other)}</strong>：${escapeHtml(displayOrDash(c.key_return_rule_other || c.keyReturnRuleOther))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_return_fee_rule)}</strong>：${escapeHtml(displayOrDash(keyFeeRuleLabel_(c.key_return_fee_rule || c.keyReturnFeeRule)))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.key_location)}</strong>：${escapeHtml(displayOrDash(c.key_location || c.keyLocation))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.lock_no)}</strong>：${escapeHtml(displayOrDash(c.lock_no || c.lockNo))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.notes)}</strong>：${escapeHtml(displayOrDash(c.notes))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.stage)}</strong>：${escapeHtml(displayOrDash(c.stage))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.registered_date)}</strong>：${escapeHtml(displayOrDash(fmtDateJst(c.registered_date || c.registeredDate)))}</div>
        <div><strong>${escapeHtml(FIELD_LABELS_JA.updated_at)}</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(c.updated_at || c.updatedAt)))}</div>
      </div>
    `;
  }

  function renderCustomerEditHtml_(c) {
    const ap = c.address_parts || {};
    const pickup = normalizeChoice_(c.key_pickup_rule || c.keyPickupRule, KEY_PICKUP_RULE_OPTIONS);
    const ret    = normalizeChoice_(c.key_return_rule || c.keyReturnRule, KEY_RETURN_RULE_OPTIONS);
    const loc    = normalizeChoice_(c.key_location || c.keyLocation, KEY_LOCATION_OPTIONS);
    const kpfr   = normStr_(c.key_pickup_fee_rule || c.keyPickupFeeRule).toLowerCase();
    const krfr   = normStr_(c.key_return_fee_rule || c.keyReturnFeeRule).toLowerCase();

    return `
      <form data-el="customerEditForm">
        <div class="card" style="margin-top:12px;">
          <div class="row row-between">
            <div class="p"><strong>${escapeHtml(displayOrDash(c.name))}</strong>${customerKanaHtml_(c)}</div>
            <div>
              <button class="btn btn-ghost" type="button" data-action="cd:cancel-edit" ${_busy ? "disabled" : ""}>キャンセル</button>
              <button class="btn" type="button" data-action="cd:save" ${_busy ? "disabled" : ""}>保存</button>
            </div>
          </div>
          <div class="p">
            ${inputRow_(FIELD_LABELS_JA.name_ro, "name_ro", c.name || "", { readonly: true, help: "編集は姓・名で行ってください。" })}
            ${inputRow_(FIELD_LABELS_JA.surname, "surname", c.surname || "", { placeholder: "例：佐藤" })}
            ${inputRow_(FIELD_LABELS_JA.given, "given", c.given || "", { placeholder: "例：花子" })}
            ${inputRow_(FIELD_LABELS_JA.surname_kana, "surname_kana", c.surname_kana || c.surnameKana || "", { placeholder: "例：さとう" })}
            ${inputRow_(FIELD_LABELS_JA.given_kana, "given_kana", c.given_kana || c.givenKana || "", { placeholder: "例：はなこ" })}
            ${inputRow_(FIELD_LABELS_JA.phone, "phone", c.phone || "", { placeholder: "例：09012345678" })}
            ${inputRow_(FIELD_LABELS_JA.emergency_phone, "emergency_phone", c.emergency_phone || c.emergencyPhone || "", { placeholder: "例：09012345678" })}
            ${inputRow_(FIELD_LABELS_JA.email, "email", c.email || "", { type: "email", placeholder: "例：xxx@gmail.com" })}
            ${inputRow_(FIELD_LABELS_JA.billing_email, "billing_email", c.billing_email || c.billingEmail || "", { type: "email", placeholder: "例：billing@gmail.com" })}

            <div class="hr"></div>
            <div class="p"><strong>住所（分割編集）</strong></div>
            ${inputRow_(FIELD_LABELS_JA.address_full_ro, "address_full_ro", (c.address_full || c.addressFull || c.address || ""), { readonly: true })}
            ${inputRow_(FIELD_LABELS_JA.postal_code, "postal_code", (c.postal_code || ap.postal_code || ""), { placeholder: "例：9800000" })}
            ${inputRow_(FIELD_LABELS_JA.prefecture, "prefecture", (c.prefecture || ap.prefecture || ""), { placeholder: "例：宮城県" })}
            ${inputRow_(FIELD_LABELS_JA.city, "city", (c.city || ap.city || ""), { placeholder: "例：仙台市青葉区" })}
            ${inputRow_(FIELD_LABELS_JA.address_line1, "address_line1", (c.address_line1 || ap.address_line1 || ""), { placeholder: "例：一番町1-2-3" })}
            ${inputRow_(FIELD_LABELS_JA.address_line2, "address_line2", (c.address_line2 || ap.address_line2 || ""), { placeholder: "例：ma familleビル 101" })}

            <div class="hr"></div>
            <div class="p"><strong>鍵</strong></div>
            ${selectRow_(FIELD_LABELS_JA.key_pickup_rule, "key_pickup_rule", pickup, KEY_PICKUP_RULE_OPTIONS, { help: (pickup === "その他" && (c.key_pickup_rule || c.keyPickupRule) && !KEY_PICKUP_RULE_OPTIONS.includes(c.key_pickup_rule || c.keyPickupRule)) ? `現行値：${String(c.key_pickup_rule || c.keyPickupRule)}` : "" })}
            ${inputRow_(FIELD_LABELS_JA.key_pickup_rule_other_detail, "key_pickup_rule_other", c.key_pickup_rule_other || c.keyPickupRuleOther || "", { placeholder: "例：庭の鉢植えの下", help: "「その他」選択時のみ入力してください。", readonly: false })}
            <div class="p" style="margin-bottom:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.key_pickup_fee_rule)}</strong></div>
              <select class="input" name="key_pickup_fee_rule">
                <option value="">—</option>
                <option value="free" ${(kpfr === "free" || normStr_(c.key_pickup_fee_rule || c.keyPickupFeeRule) === "無料") ? "selected" : ""}>無料</option>
                <option value="paid" ${(kpfr === "paid" || normStr_(c.key_pickup_fee_rule || c.keyPickupFeeRule) === "有料") ? "selected" : ""}>有料</option>
              </select>
            </div>    
            ${selectRow_(FIELD_LABELS_JA.key_return_rule, "key_return_rule", ret, KEY_RETURN_RULE_OPTIONS, { help: (ret === "その他" && (c.key_return_rule || c.keyReturnRule) && !KEY_RETURN_RULE_OPTIONS.includes(c.key_return_rule || c.keyReturnRule)) ? `現行値：${String(c.key_return_rule || c.keyReturnRule)}` : "" })}
            ${inputRow_(FIELD_LABELS_JA.key_return_rule_other_detail, "key_return_rule_other", c.key_return_rule_other || c.keyReturnRuleOther || "", { placeholder: "例：外の物置内、保存容器の中", help: "「その他」選択時のみ入力してください。", readonly: false })}
            <div class="p" style="margin-bottom:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.key_return_fee_rule)}</strong></div>
              <select class="input" name="key_return_fee_rule">
                <option value="">—</option>
                <option value="free" ${(krfr === "free" || normStr_(c.key_return_fee_rule || c.keyReturnFeeRule) === "無料") ? "selected" : ""}>無料</option>
                <option value="paid" ${(krfr === "paid" || normStr_(c.key_return_fee_rule || c.keyReturnFeeRule) === "有料") ? "selected" : ""}>有料</option>
              </select>
            </div>
            ${selectRow_(FIELD_LABELS_JA.key_location, "key_location", loc, KEY_LOCATION_OPTIONS)}
            ${inputRow_(FIELD_LABELS_JA.lock_no, "lock_no", c.lock_no || c.lockNo || "", { placeholder: "例：1234" })}

            <div class="hr"></div>
            ${inputRow_(FIELD_LABELS_JA.parking_info, "parking_info", c.parking_info || c.parkingInfo || "", { placeholder: "例：敷地内 1台分あり" })}
            <div class="p" style="margin-bottom:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.parking_fee_rule)}</strong></div>
              <select class="input" name="parking_fee_rule">
                <option value="">—</option>
                <option value="free" ${(normStr_(c.parking_fee_rule || c.parkingFeeRule).toLowerCase() === "free" || normStr_(c.parking_fee_rule || c.parkingFeeRule) === "無料") ? "selected" : ""}>無料</option>
                <option value="paid" ${(normStr_(c.parking_fee_rule || c.parkingFeeRule).toLowerCase() === "paid" || normStr_(c.parking_fee_rule || c.parkingFeeRule) === "有料") ? "selected" : ""}>有料</option>
              </select>
            </div>
            <div class="p" style="margin-bottom:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.notes)}</strong></div>
              <textarea class="input" name="notes" rows="5" placeholder="引継ぎや注意点など">${escapeHtml(normStr_(c.notes || ""))}</textarea>
            </div>
          </div>
        </div>
      </form>
    `;
  }

  // ペット active 判定ヘルパ  
  function isPetActive_(p) {
    const v = p?.is_active;
    if (v === false) return false;
    if (v == null || v === "") return true; // 未設定は有効扱い
    const s = String(v).toLowerCase();
    if (s === "false") return false;
    return true;
  }

  function renderHost_(detail) {
    const c = detail.customer || {};
    const petsAll = Array.isArray(detail.pets) ? detail.pets : [];
    const pets = _showInactivePets ? petsAll : petsAll.filter(isPetActive_);
    const cp = detail.careProfile || null;

    const customerHtml =
      (_mode === "edit")
        ? renderCustomerEditHtml_(c)
        : `
            <div style="margin-top:12px;">
              <div class="card">
                <div class="row row-between">
                  <div class="p"><strong>${escapeHtml(displayOrDash(c.name))}</strong>${customerKanaHtml_(c)}</div>
                  <div><button class="btn" type="button" data-action="cd:enter-edit" ${_busy ? "disabled" : ""}>編集</button></div>
                </div>
                ${renderCustomerViewBodyHtml_(c)}
              </div>
            </div>
          `;

    // ===== ペット =====
    function renderPetView_(p) {
      const pid = String(p?.id || p?.pet_id || "");
      const inactive = !_showInactivePets ? false : !isPetActive_(p);
      const cardStyle = inactive ? ' style="opacity:.55;"' : "";
      return `
        <div class="card"${cardStyle}>
          <div class="row row-between">
            <div class="p"><strong>${escapeHtml(displayOrDash(p.name || p.pet_name))}</strong></div>
            <div>
              <button class="btn" type="button" data-action="pet:enter-edit" data-pet-id="${escapeHtml(pid)}" ${_petBusy ? "disabled" : ""}>編集</button>
            </div>
          </div>
          <div class="p">
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.pet_id)}</strong>：${escapeHtml(displayOrDash(p.id || p.pet_id))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.customer_id)}</strong>：${escapeHtml(displayOrDash(p.customer_id || customerId))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.species)}</strong>：${escapeHtml(displayOrDash(p.species || p.type || p.pet_type))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.breed)}</strong>：${escapeHtml(displayOrDash(p.breed))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.gender)}</strong>：${escapeHtml(displayOrDash(p.gender))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.birthdate)}</strong>：${escapeHtml(displayOrDash(fmtDateJst(p.birthdate || "")))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.age)}</strong>：${escapeHtml(displayOrDash(fmtAgeFromBirthdateJst(p.birthdate || "")))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.weight_kg)}</strong>：${escapeHtml(displayOrDash(p.weight_kg))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.health)}</strong>：${escapeHtml(displayOrDash(p.health))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.notes)}</strong>：${escapeHtml(displayOrDash(p.notes || p.memo))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.hospital)}</strong>：${escapeHtml(displayOrDash(p.hospital))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.hospital_phone)}</strong>：${escapeHtml(displayOrDash(p.hospital_phone))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.rabies_vaccine_at)}</strong>：${escapeHtml(displayOrDash(fmtDateJst(p.rabies_vaccine_at)))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.combo_vaccine_at)}</strong>：${escapeHtml(displayOrDash(fmtDateJst(p.combo_vaccine_at)))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.is_active)}</strong>：${escapeHtml((p.is_active === false || String(p.is_active).toLowerCase() === "false") ? "無効" : "有効")}</div>
           <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.registered_date)}</strong>：${escapeHtml(displayOrDash(fmtDateJst(p.registered_date)))}</div>
            <div><strong>${escapeHtml(PET_FIELD_LABELS_JA.updated_at)}</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(p.updated_at)))}</div>
          </div>
        </div>
      `;
    }

    function renderPetEdit_(p) {
      const pid = String(p?.id || p?.pet_id || "");
      const species = normalizeChoice_(p.species || p.type || p.pet_type, KEY_SPECIES_OPTIONS);
      const gender  = normalizeChoice_(p.gender || p.sex, KEY_GENDER_OPTIONS);
      const isActiveCur = (p.is_active === "" || p.is_active == null) ? true : !!p.is_active;
      const inactive = !_showInactivePets ? false : !isPetActive_(p);
      const cardStyle = inactive ? ' style="margin-top:12px; opacity:.55;"' : ' style="margin-top:12px;"';

      return `
        <form data-el="petEditForm" data-pet-id="${escapeHtml(pid)}">
         <div class="card"${cardStyle}>
            <div class="row row-between">
              <div class="p"><strong>${escapeHtml(displayOrDash(p.name || p.pet_name))}</strong></div>
              <div>
                <button class="btn btn-ghost" type="button" data-action="pet:cancel-edit" data-pet-id="${escapeHtml(pid)}" ${_petBusy ? "disabled" : ""}>キャンセル</button>
                <button class="btn" type="button" data-action="pet:save" data-pet-id="${escapeHtml(pid)}" ${_petBusy ? "disabled" : ""}>保存</button>
              </div>
            </div>
            <div class="p">
              ${inputRow_(PET_FIELD_LABELS_JA.pet_id, "pet_id_ro", (p.id || p.pet_id || ""), { readonly: true })}
              ${inputRow_(PET_FIELD_LABELS_JA.name, "name", (p.name || p.pet_name || ""), { placeholder: "例：ゆべし" })}
              ${selectRow_(PET_FIELD_LABELS_JA.species, "species", species, KEY_SPECIES_OPTIONS)}
              ${inputRow_(PET_FIELD_LABELS_JA.breed, "breed", (p.breed || ""), { placeholder: "例：柴犬 / 雑種" })}
              ${selectRow_(PET_FIELD_LABELS_JA.gender, "gender", gender, KEY_GENDER_OPTIONS)}
              ${inputDateRow_(PET_FIELD_LABELS_JA.birthdate, "birthdate", (p.birthdate || ""), { help: "未設定の場合は空欄でOK" })}
              ${inputRow_(PET_FIELD_LABELS_JA.weight_kg, "weight_kg", (p.weight_kg || ""), { placeholder: "例：4.2" })}

              <div class="hr"></div>
              ${inputDateRow_(PET_FIELD_LABELS_JA.rabies_vaccine_at, "rabies_vaccine_at", (p.rabies_vaccine_at || ""), { help: "yyyy-mm-dd" })}
              ${inputDateRow_(PET_FIELD_LABELS_JA.combo_vaccine_at, "combo_vaccine_at", (p.combo_vaccine_at || ""), { help: "yyyy-mm-dd" })}

              <div class="hr"></div>
              ${inputRow_(PET_FIELD_LABELS_JA.health, "health", (p.health || ""), { placeholder: "健康上の注意など" })}
              <div class="p" style="margin-bottom:10px;">
                <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(PET_FIELD_LABELS_JA.notes)}</strong></div>
                <textarea class="input" name="notes" rows="4" placeholder="メモ">${escapeHtml(normStr_(p.notes || p.memo || ""))}</textarea>
              </div>
              ${inputRow_(PET_FIELD_LABELS_JA.hospital, "hospital", (p.hospital || ""), { placeholder: "例：○○動物病院" })}
              ${inputRow_(PET_FIELD_LABELS_JA.hospital_phone, "hospital_phone", (p.hospital_phone || ""), { placeholder: "例：0221234567" })}

              <div class="hr"></div>
              <div class="p"><strong>${escapeHtml(PET_FIELD_LABELS_JA.is_active)}</strong></div>
              <label class="p" style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                <input type="checkbox" name="is_active" ${isActiveCur ? "checked" : ""}/>
                <span>チェックオンで有効</span>
              </label>
            </div>
          </div>
        </form>
      `;
    }

    function renderPetAdd_() {
      return `
        <form data-el="petAddForm">
          <div class="card card-warning" style="margin-top:12px;">
            <div class="row row-between">
              <div class="p"><strong>ペットを追加</strong></div>
              <div>
                <button class="btn btn-ghost" type="button" data-action="pet:add:cancel">キャンセル</button>
                <button class="btn" type="button" data-action="pet:add:save">追加</button>
              </div>
            </div>
            <div class="p">
              ${inputRow_(PET_FIELD_LABELS_JA.name, "name", "", { placeholder: "例：ゆべし" })}
              ${selectRow_(PET_FIELD_LABELS_JA.species, "species", "", KEY_SPECIES_OPTIONS)}
              ${inputRow_(PET_FIELD_LABELS_JA.breed, "breed", "", { placeholder: "例：柴犬" })}
              ${selectRow_(PET_FIELD_LABELS_JA.gender, "gender", "", KEY_GENDER_OPTIONS)}
              ${inputDateRow_(PET_FIELD_LABELS_JA.birthdate, "birthdate", "")}
              ${inputRow_(PET_FIELD_LABELS_JA.weight_kg, "weight_kg", "", { placeholder: "例：4.2（kg）" })}

              <div class="hr"></div>
              ${inputDateRow_(PET_FIELD_LABELS_JA.rabies_vaccine_at, "rabies_vaccine_at", "")}
              ${inputDateRow_(PET_FIELD_LABELS_JA.combo_vaccine_at, "combo_vaccine_at", "")}

              <div class="hr"></div>
              ${inputRow_(PET_FIELD_LABELS_JA.health, "health", "")}
              <div class="p">
                <div style="opacity:.85;"><strong>${escapeHtml(PET_FIELD_LABELS_JA.notes)}</strong></div>
                <textarea class="input" name="notes" rows="3"></textarea>
              </div>
              ${inputRow_(PET_FIELD_LABELS_JA.hospital, "hospital", "")}
              ${inputRow_(PET_FIELD_LABELS_JA.hospital_phone, "hospital_phone", "")}
            </div>
          </div>
        </form>
      `;
    }

    const petsHtml = `
      ${pets.map((p, i) => {
        const pid = String(p?.id || p?.pet_id || "");
        const inner = (pid && _petEditId === pid) ? renderPetEdit_(p) : renderPetView_(p);
        // view/edit どちらでもブロック間の余白を統一
        const mt = (i === 0) ? 0 : 12;
        return `<div style="margin-top:${mt}px;">${inner}</div>`;
      }).join("")}
      ${_petAdd ? renderPetAdd_() : `
        <div class="p" style="margin-top:12px;">
          <button class="btn" type="button" data-action="pet:add:open">＋ ペットを追加</button>
        </div>
      `}
    `;

    const petActionsHtml = `
      <label class="p text-sm" style="display:flex; gap:8px; align-items:center; margin:0;">
        <input type="checkbox" name="show_inactive_pets" ${_showInactivePets ? "checked" : ""}/>
        <span>無効も表示</span>
      </label>
    `;

    const careHtml = cp ? `${renderCareProfile_(cp)}` : `<p class="p">お世話情報がありません。</p>`;

    host.innerHTML = `
      ${section("顧客情報", customerHtml, "")}
      ${section("ペット情報", petsHtml, petActionsHtml)}
      ${section("お世話情報", careHtml, "")}
    `;

    // 編集モード初期状態：その他詳細欄の有効/無効を反映
    if (_mode === "edit") {
      const formEl = host.querySelector('form[data-el="customerEditForm"]');
      const pickupSel = formEl?.querySelector('select[name="key_pickup_rule"]');
      const pickupOther = formEl?.querySelector('input[name="key_pickup_rule_other"]');
      if (pickupOther) pickupOther.disabled = (normStr_(pickupSel?.value) !== "その他");
      const returnSel = formEl?.querySelector('select[name="key_return_rule"]');
      const returnOther = formEl?.querySelector('input[name="key_return_rule_other"]');
      if (returnOther) returnOther.disabled = (normStr_(returnSel?.value) !== "その他");
    }
  }

  // ===== cache（直近に開いた詳細は即表示）=====
  const cacheKey = KEY_CD_CACHE_PREFIX + String(customerId);

  try {
    // cache があれば先に利用（任意：体感改善）
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj.ts && (Date.now() - Number(obj.ts)) <= CD_CACHE_TTL_MS && obj.detail) {
          // ここで即表示したい場合は obj.detail を使って描画しても良い（現状は未使用でOK）
        }
      }
    } catch (_) {}

    const res = await callGas({
      action: "getCustomerDetail",
      customer_id: customerId,
      include_pets: true,
      include_care_profile: true,
    }, idToken);

    if (!res || res.success === false) {
      throw new Error((res && (res.error || res.message)) || "getCustomerDetail failed");
    }
    if (res.ctx) setUser(res.ctx);

    // getCustomerDetail は「直置き」返却を最優先で読む（visit_detail の “unwrap → 本体” の思想を踏襲）
    // 互換：results/result/customer_detail などが来ても吸収
    const detail =
      (res.customer || res.pets || res.careProfile || res.care_profile)
        ? {
            customer: res.customer || null,
            pets: Array.isArray(res.pets) ? res.pets : [],
            careProfile: res.careProfile || res.care_profile || null,
          }
        : extractCustomerDetail_(unwrapOne(res) || res);

    if (!detail || !detail.customer) {
      // 切り分け用：どのキーが存在するかをメッセージに含める
      const keys = res ? Object.keys(res).slice(0, 50).join(", ") : "(no res)";
      throw new Error(`顧客詳細が空です。res keys=[${keys}]`);
    }

    _detail = detail;
    _mode = "view";
    renderHost_(detail);

    // cache 保存
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), detail }));
    } catch (_) {}
  } catch (e) {
    const msg = e?.message || String(e);
    toast({ title: "取得失敗", message: e?.message || String(e) });
    host.innerHTML = `
      <p class="p">取得に失敗しました。</p>
      <div class="hr"></div>
      <div class="p text-sm">customer_id=${escapeHtml(customerId)}</div>
      <div class="p text-sm">action=getCustomerDetail</div>
      <div class="hr"></div>
      <details class="details">
      <summary class="p" style="cursor:pointer;">debug（エラー内容）</summary>
      <div class="card"><div class="p" style="white-space:pre-wrap;">${escapeHtml(msg)}</div></div>
      </details>
    `;
  }
}
