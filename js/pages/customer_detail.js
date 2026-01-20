// js/pages/customer_detail.js
import { render, escapeHtml, toast, showModal, fmt, displayOrDash, fmtDateTimeJst, fmtDateJst, fmtAgeFromBirthdateJst } from "../ui.js";
import { callGas, unwrapOne } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

const KEY_CD_CACHE_PREFIX = "mf:customer_detail:cache:v1:";
const CD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分

// ===== 顧客情報編集時の選択肢（申し込みフォームと統一）=====
const KEY_PICKUP_RULE_OPTIONS = ["継続保管", "郵送預かり", "メールボックス預かり", "鍵なし", "その他"];
const KEY_RETURN_RULE_OPTIONS = ["継続保管", "ポスト返却", "メールボックス返却", "郵送返却", "鍵なし", "その他"];
const KEY_LOCATION_OPTIONS    = ["顧客", "本部", "担当者", "鍵なし"];

function normStr_(v) {
  const s = fmt(v);
  return (s == null) ? "" : String(s).trim();
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

    if (a === "cd:enter-edit") {
      if (_busy) return;
      _mode = "edit";
      if (_detail) renderHost_(_detail);
      return;
    }
    if (a === "cd:cancel-edit") {
      if (_busy) return;
      _mode = "view";
      if (_detail) renderHost_(_detail);
      return;
    }
    if (a === "cd:save") {
      if (_busy) return;
      if (!_detail || !_detail.customer) return;

      const formEl = host.querySelector('form[data-el="customerEditForm"]');
      if (!formEl) return;

      // 変更差分（パッチ）：GAS upsertCustomer は undefined をスキップする
      const c0 = _detail.customer || {};
      const patch = { action: "upsertCustomer", customer_id: (c0.id || c0.customer_id || customerId) };

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
      const setIfChanged = (key, next, cur) => {
        const n = normStr_(next);
        const c = normStr_(cur);
        if (n && n !== c) patch[key] = n;
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
      setIfChanged("lock_no", getFormValue_(formEl, "lock_no"), (c0.lock_no || c0.lockNo || ""));
      setIfChanged("notes", getFormValue_(formEl, "notes"), (c0.notes || ""));

      // 住所：分割のみ編集。address_full はUIで編集しないが、parts変更時はGASが自動更新する。
      const apPostal = getFormValue_(formEl, "postal_code");
      const apPref   = getFormValue_(formEl, "prefecture");
      const apCity   = getFormValue_(formEl, "city");
      const apL1     = getFormValue_(formEl, "address_line1");
      const apL2     = getFormValue_(formEl, "address_line2");

      // 差分があるフィールドのみ送る（空欄は「維持」）
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
      if (normPickup && normPickup !== normStr_(c0.key_pickup_rule || c0.keyPickupRule)) patch.key_pickup_rule = normPickup;
      if (normReturn && normReturn !== normStr_(c0.key_return_rule || c0.keyReturnRule)) patch.key_return_rule = normReturn;
      if (normLoc    && normLoc    !== normStr_(c0.key_location || c0.keyLocation))       patch.key_location = normLoc;

      const patchKeys = Object.keys(patch).filter(k => k !== "action" && k !== "customer_id");
      if (patchKeys.length === 0) {
        toast({ title: "変更なし", message: "保存する変更がありません。" });
        return;
      }

      const ok = await showModal({
        title: "顧客情報を保存",
        bodyHtml: `
          <div class="p">変更を保存します。よろしいですか？</div>
          <div class="hr"></div>
          <div class="p text-sm" style="opacity:.75;">変更項目：${escapeHtml(patchKeys.join(", "))}</div>
          <div class="p text-sm" style="opacity:.75;">空欄の項目は既存値を維持します（このステップではクリアはしません）。</div>
        `,
        okText: "保存",
        cancelText: "キャンセル",
      });
      if (!ok) return;

      try {
        _busy = true;
        renderHost_(_detail); // ボタンdisabled反映

        const resUp = await callGas(patch, idToken);
        if (!resUp || resUp.ok === false) throw new Error((resUp && (resUp.error || resUp.message)) || "upsertCustomer failed");
        if (resUp.ctx) setUser(resUp.ctx);

        toast({ title: "保存完了", message: "顧客情報を更新しました。" });

        // 再取得して表示＆cache更新（単一ソース：getCustomerDetail）
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
            ? {
                customer: res.customer || null,
                pets: Array.isArray(res.pets) ? res.pets : [],
                careProfile: res.careProfile || res.care_profile || null,
              }
            : extractCustomerDetail_(unwrapOne(res) || res);

        if (!detail || !detail.customer) throw new Error("再取得に失敗しました（detail.customer が空）");
        _detail = detail;
        _mode = "view";
        renderHost_(detail);

        try {
          const cacheKey = KEY_CD_CACHE_PREFIX + String(customerId);
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), detail }));
        } catch (_) {}
      } catch (err) {
        toast({ title: "保存失敗", message: err?.message || String(err) });
      } finally {
        _busy = false;
        if (_detail) renderHost_(_detail);
      }
    }
  });

  function renderHeaderActions_() {
    if (_mode === "view") {
      return `<button class="btn" type="button" data-action="cd:enter-edit" ${_busy ? "disabled" : ""}>編集</button>`;
    }
    return `
      <button class="btn btn-ghost" type="button" data-action="cd:cancel-edit" ${_busy ? "disabled" : ""}>キャンセル</button>
      <button class="btn" type="button" data-action="cd:save" ${_busy ? "disabled" : ""}>保存</button>
    `;
  }

  function renderCustomerViewHtml_(c) {
    return `
      <div class="card">
        <div class="p">
          <div><strong>顧客ID</strong>：${escapeHtml(displayOrDash(c.id || c.customer_id || customerId))}</div>
          <div><strong>顧客名</strong>：${
            escapeHtml(displayOrDash(c.name))
          }${
            (() => {
              const sk = (c.surname_kana || c.surnameKana || "").trim();
              const gk = (c.given_kana || c.givenKana || "").trim();
              const kk = (sk + gk).trim();
              return kk ? ` <span style="opacity:.75;">(${escapeHtml(kk)})</span>` : "";
            })()
          }</div>
          <div><strong>電話</strong>：${escapeHtml(displayOrDash(c.phone))}</div>
          <div><strong>緊急連絡先</strong>：${escapeHtml(displayOrDash(c.emergency_phone || c.emergencyPhone))}</div>
          <div><strong>メール</strong>：${escapeHtml(displayOrDash(c.email))}</div>
          <div><strong>請求先メール</strong>：${escapeHtml(displayOrDash(c.billing_email || c.billingEmail))}</div>
          <div><strong>郵便番号</strong>：${escapeHtml(displayOrDash(c.postal_code || (c.address_parts && c.address_parts.postal_code)))}</div>
          <div><strong>住所</strong>：${escapeHtml(displayOrDash(c.address_full || c.addressFull || c.address))}</div>
          <div><strong>駐車場</strong>：${escapeHtml(displayOrDash(c.parking_info || c.parkingInfo))}</div>
          <div><strong>鍵受取ルール</strong>：${escapeHtml(displayOrDash(c.key_pickup_rule || c.keyPickupRule))}</div>
          <div><strong>鍵返却ルール</strong>：${escapeHtml(displayOrDash(c.key_return_rule || c.keyReturnRule))}</div>
          <div><strong>鍵の所在</strong>：${escapeHtml(displayOrDash(c.key_location || c.keyLocation))}</div>
          <div><strong>ロック番号</strong>：${escapeHtml(displayOrDash(c.lock_no || c.lockNo))}</div>
          <div><strong>メモ</strong>：${escapeHtml(displayOrDash(c.notes))}</div>
          <div><strong>ステージ</strong>：${escapeHtml(displayOrDash(c.stage))}</div>
          <div><strong>登録日</strong>：${escapeHtml(displayOrDash(fmtDateJst(c.registered_date || c.registeredDate)))}</div>
          <div><strong>更新日時</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(c.updated_at || c.updatedAt)))}</div>
        </div>
      </div>
    `;
  }

  function renderCustomerEditHtml_(c) {
    const ap = c.address_parts || {};
    const pickup = normalizeChoice_(c.key_pickup_rule || c.keyPickupRule, KEY_PICKUP_RULE_OPTIONS);
    const ret    = normalizeChoice_(c.key_return_rule || c.keyReturnRule, KEY_RETURN_RULE_OPTIONS);
    const loc    = normalizeChoice_(c.key_location || c.keyLocation, KEY_LOCATION_OPTIONS);

    return `
      <form data-el="customerEditForm">
        <div class="card">
          <div class="p">
            ${inputRow_("顧客名（表示専用）", "name_ro", c.name || "", { readonly: true, help: "編集は姓・名で行ってください。" })}
            ${inputRow_("姓（surname）", "surname", c.surname || "", { placeholder: "例：佐藤" })}
            ${inputRow_("名（given）", "given", c.given || "", { placeholder: "例：花子" })}
            ${inputRow_("姓かな", "surname_kana", c.surname_kana || c.surnameKana || "", { placeholder: "例：さとう" })}
            ${inputRow_("名かな", "given_kana", c.given_kana || c.givenKana || "", { placeholder: "例：はなこ" })}
            ${inputRow_("電話", "phone", c.phone || "", { placeholder: "例：09012345678" })}
            ${inputRow_("緊急連絡先", "emergency_phone", c.emergency_phone || c.emergencyPhone || "", { placeholder: "例：09012345678" })}
            ${inputRow_("メール", "email", c.email || "", { type: "email", placeholder: "例：xxx@gmail.com" })}
            ${inputRow_("請求先メール", "billing_email", c.billing_email || c.billingEmail || "", { type: "email", placeholder: "例：billing@gmail.com" })}

            <div class="hr"></div>
            <div class="p"><strong>住所（分割編集）</strong></div>
            ${inputRow_("統合住所（表示のみ）", "address_full_ro", (c.address_full || c.addressFull || c.address || ""), { readonly: true })}
            ${inputRow_("郵便番号", "postal_code", (c.postal_code || ap.postal_code || ""), { placeholder: "例：9800000" })}
            ${inputRow_("都道府県", "prefecture", (c.prefecture || ap.prefecture || ""), { placeholder: "例：宮城県" })}
            ${inputRow_("市区町村", "city", (c.city || ap.city || ""), { placeholder: "例：仙台市青葉区" })}
            ${inputRow_("町域・番地", "address_line1", (c.address_line1 || ap.address_line1 || ""), { placeholder: "例：一番町1-2-3" })}
            ${inputRow_("建物名など", "address_line2", (c.address_line2 || ap.address_line2 || ""), { placeholder: "例：ma familleビル 101" })}
            <div class="p text-sm" style="opacity:.75;">住所パーツを変更すると、GAS側で address_full が自動再生成されます（統合住所は直接編集しません）。</div>

            <div class="hr"></div>
            <div class="p"><strong>鍵</strong></div>
            ${selectRow_("鍵受取ルール", "key_pickup_rule", pickup, KEY_PICKUP_RULE_OPTIONS, { help: (pickup === "その他" && (c.key_pickup_rule || c.keyPickupRule) && !KEY_PICKUP_RULE_OPTIONS.includes(c.key_pickup_rule || c.keyPickupRule)) ? `現行値：${String(c.key_pickup_rule || c.keyPickupRule)}` : "" })}
            ${selectRow_("鍵返却ルール", "key_return_rule", ret, KEY_RETURN_RULE_OPTIONS, { help: (ret === "その他" && (c.key_return_rule || c.keyReturnRule) && !KEY_RETURN_RULE_OPTIONS.includes(c.key_return_rule || c.keyReturnRule)) ? `現行値：${String(c.key_return_rule || c.keyReturnRule)}` : "" })}
            ${selectRow_("鍵の所在", "key_location", loc, KEY_LOCATION_OPTIONS)}
            ${inputRow_("ロック番号", "lock_no", c.lock_no || c.lockNo || "", { placeholder: "例：1234" })}

            <div class="hr"></div>
            ${inputRow_("駐車場", "parking_info", c.parking_info || c.parkingInfo || "", { placeholder: "例：敷地内 1台分あり" })}
            <div class="p" style="margin-bottom:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>メモ</strong></div>
              <textarea class="input" name="notes" rows="5" placeholder="引継ぎや注意点など">${escapeHtml(normStr_(c.notes || ""))}</textarea>
            </div>

            <div class="p text-sm" style="opacity:.75;">
              ステージ／登録日／顧客ID は編集対象外です（表示のみ）。
            </div>
          </div>
        </div>
      </form>
    `;
  }

  function renderHost_(detail) {
    const c = detail.customer || {};
    const pets = Array.isArray(detail.pets) ? detail.pets : [];
    const cp = detail.careProfile || null;

    const customerHtml = (_mode === "edit") ? renderCustomerEditHtml_(c) : renderCustomerViewHtml_(c);

    // ===== ペット =====（Step3で編集・追加）
    const petsHtml = pets.length
      ? `
        ${pets.map(p => `
          <div class="card">
            <div class="p">
              <div><strong>${escapeHtml(displayOrDash(p.name || p.pet_name))}</strong></div>
              <div><strong>ペットID</strong>：${escapeHtml(displayOrDash(p.id || p.pet_id))}</div>
              <div><strong>顧客ID</strong>：${escapeHtml(displayOrDash(p.customer_id || customerId))}</div>
              <div><strong>種類</strong>：${escapeHtml(displayOrDash(p.species || p.type || p.pet_type))}</div>
              <div><strong>品種</strong>：${escapeHtml(displayOrDash(p.breed))}</div>
              <div><strong>性別</strong>：${escapeHtml(displayOrDash(p.gender))}</div>
              <div><strong>誕生日</strong>：${escapeHtml(displayOrDash(fmtDateJst(p.birthdate || "")))}</div>
              <div><strong>年齢</strong>：${escapeHtml(displayOrDash(fmtAgeFromBirthdateJst(p.birthdate || "")))}</div>
              <div><strong>健康</strong>：${escapeHtml(displayOrDash(p.health))}</div>
              <div><strong>メモ</strong>：${escapeHtml(displayOrDash(p.notes || p.memo))}</div>
              <div><strong>病院</strong>：${escapeHtml(displayOrDash(p.hospital))}</div>
              <div><strong>病院電話</strong>：${escapeHtml(displayOrDash(p.hospital_phone))}</div>
              <div><strong>登録日</strong>：${escapeHtml(displayOrDash(fmtDateJst(p.registered_date)))}</div>
              <div><strong>更新日時</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(p.updated_at)))}</div>
            </div>
          </div>
        `).join("")}
      `
      : `<p class="p">ペット情報がありません。</p>`;

    const careHtml = cp ? `${renderCareProfile_(cp)}` : `<p class="p">お世話情報がありません。</p>`;

    host.innerHTML = `
      ${section("顧客情報", customerHtml, renderHeaderActions_())}
      ${section("ペット情報", petsHtml, "")}
      ${section("お世話情報", careHtml, "")}
    `;
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
