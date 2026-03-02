import { render, toast, escapeHtml, fmt, displayOrDash, fmtDateTimeJst, showModal, openBlockingOverlay } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken } from "../auth.js";

const FIELD_LABELS_JA = {
  surname: "姓",
  given: "名",
  surname_kana: "姓かな",
  given_kana: "名かな",
  phone: "電話",
  emergency_phone: "緊急連絡先",
  email: "メール",
  billing_email: "請求先メール",
  postal_code: "郵便番号",
  prefecture: "都道府県",
  city: "市区町村",
  address_line1: "町域・番地",
  address_line2: "建物・部屋",
  parking_info: "駐車場",
  parking_fee_rule: "駐車料金区分",
  key_pickup_rule: "鍵預かりルール",
  key_pickup_rule_other_detail: "鍵預かりルール（その他詳細）",
  key_pickup_fee_rule: "鍵預かり料金区分",
  key_return_rule: "鍵返却ルール",
  key_return_rule_other_detail: "鍵返却ルール（その他詳細）",
  key_return_fee_rule: "鍵返却料金区分",
  key_location: "鍵の所在",
  lock_no: "ロック番号",
  notes: "メモ",
};

const KEY_PICKUP_RULE_OPTIONS = ["継続保管", "郵送預かり", "メールボックス預かり", "鍵なし", "その他"];
const KEY_RETURN_RULE_OPTIONS = ["継続保管", "ポスト返却", "メールボックス返却", "郵送返却", "鍵なし", "その他"];
const KEY_LOCATION_OPTIONS = ["顧客", "本部", "担当者", "鍵なし"];

function normStr_(v) {
  const s = fmt(v);
  return (s == null) ? "" : String(s).trim();
}

function inputRow_(label, name, value, { type = "text", placeholder = "", help = "" } = {}) {
  return `
    <div class="p" style="margin-bottom:10px;">
      <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(label)}</strong></div>
      <input class="input" type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(normStr_(value))}" placeholder="${escapeHtml(placeholder)}" />
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
        ${options.map((opt) => `<option value="${escapeHtml(opt)}" ${cur === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
      </select>
      ${help ? `<div class="p text-sm" style="opacity:.75; margin-top:4px;">${escapeHtml(help)}</div>` : ""}
    </div>
  `;
}

function getFormValue_(formEl, name) {
  const el = formEl?.querySelector(`[name="${CSS.escape(name)}"]`);
  if (!el) return "";
  return normStr_(el.value);
}

function normalizeChoice_(value, options) {
  const s = normStr_(value);
  if (!s) return "";
  return options.includes(s) ? s : "その他";
}

function keyFeeRuleValue_(value) {
  const s = normStr_(value).toLowerCase();
  if (s === "free" || normStr_(value) === "無料") return "free";
  if (s === "paid" || normStr_(value) === "有料") return "paid";
  return "";
}

async function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  try {
    return await task(blocker);
  } finally {
    blocker.close();
  }
}

export async function renderMeetingCustomerForm(appEl, query) {
  const visitId = String(query.get("visit_id") || "").trim();
  const backTo = String(query.get("back_to") || `#/visits?id=${encodeURIComponent(visitId)}`).trim();
  if (!visitId) {
    render(appEl, `<section class="section"><h1 class="h1">利用登録/更新</h1><p class="p">visit_id が指定されていません。</p></section>`);
    return;
  }

  render(appEl, `
    <section class="section">
      <div class="row row-between">
        <h1 class="h1">利用登録/更新</h1>
        <a class="btn btn-ghost" href="${escapeHtml(backTo)}">予約詳細に戻る</a>
      </div>
      <div class="hr"></div>
      <div data-el="host"><p class="p">読み込み中...</p></div>
    </section>
  `);

  const host = appEl.querySelector('[data-el="host"]');
  const idToken = getIdToken();
  if (!host) return;
  if (!idToken) {
    host.innerHTML = `<p class="p">ログインしてください。</p>`;
    return;
  }

  let detail = null;
  try {
    const res = await runWithBlocking_(
      {
        title: "打ち合わせ情報を読み込んでいます",
        bodyHtml: "顧客情報と予約情報を取得しています。",
        busyText: "読み込み中...",
      },
      async () => await callGas({ action: "getMeetingCustomerProfile", visit_id: visitId }, idToken)
    );
    if (!res || res.success === false) throw new Error((res && (res.error || res.message)) || "getMeetingCustomerProfile failed");
    detail = res;
  } catch (e) {
    host.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    toast({ title: "取得失敗", message: e?.message || String(e) });
    return;
  }

  const visit = detail.visit || {};
  const c = (detail.customer_detail && detail.customer_detail.customer) ? detail.customer_detail.customer : {};
  const ap = (c && c.address_parts && typeof c.address_parts === "object") ? c.address_parts : {};
  const pickup = normalizeChoice_(c.key_pickup_rule || c.keyPickupRule, KEY_PICKUP_RULE_OPTIONS);
  const ret = normalizeChoice_(c.key_return_rule || c.keyReturnRule, KEY_RETURN_RULE_OPTIONS);
  const loc = normalizeChoice_(c.key_location || c.keyLocation, KEY_LOCATION_OPTIONS);
  const kpfr = keyFeeRuleValue_(c.key_pickup_fee_rule || c.keyPickupFeeRule);
  const krfr = keyFeeRuleValue_(c.key_return_fee_rule || c.keyReturnFeeRule);
  const pfr = keyFeeRuleValue_(c.parking_fee_rule || c.parkingFeeRule);

  host.innerHTML = `
    <div class="card">
      <div class="p">
        <div><strong>予約ID</strong>：${escapeHtml(displayOrDash(visit.visit_id))}</div>
        <div><strong>訪問種別</strong>：${escapeHtml(displayOrDash(visit.visit_type))}</div>
        <div><strong>打ち合わせ日時</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(visit.start_time || "")))}</div>
        <div><strong>顧客名</strong>：${escapeHtml(displayOrDash(c.name || visit.customer_name))}</div>
        <div><strong>担当者</strong>：${escapeHtml(displayOrDash(visit.staff_name || visit.staff_id))}</div>
      </div>
    </div>
    <form data-el="meetingCustomerForm">
      <div class="card" style="margin-top:12px;">
        <div class="p"><strong>顧客情報</strong></div>
        <div class="p" style="margin-top:8px;">
          ${inputRow_(FIELD_LABELS_JA.surname, "surname", c.surname || "", { placeholder: "例：佐藤" })}
          ${inputRow_(FIELD_LABELS_JA.given, "given", c.given || "", { placeholder: "例：花子" })}
          ${inputRow_(FIELD_LABELS_JA.surname_kana, "surname_kana", c.surname_kana || c.surnameKana || "", { placeholder: "例：さとう" })}
          ${inputRow_(FIELD_LABELS_JA.given_kana, "given_kana", c.given_kana || c.givenKana || "", { placeholder: "例：はなこ" })}
          ${inputRow_(FIELD_LABELS_JA.phone, "phone", c.phone || "", { placeholder: "例：09012345678" })}
          ${inputRow_(FIELD_LABELS_JA.emergency_phone, "emergency_phone", c.emergency_phone || c.emergencyPhone || "", { placeholder: "例：09012345678" })}
          ${inputRow_(FIELD_LABELS_JA.email, "email", c.email || "", { type: "email", placeholder: "例：xxx@gmail.com" })}
          ${inputRow_(FIELD_LABELS_JA.billing_email, "billing_email", c.billing_email || c.billingEmail || "", { type: "email", placeholder: "例：billing@gmail.com" })}
          <div class="hr"></div>
          <div class="p"><strong>住所</strong></div>
          ${inputRow_(FIELD_LABELS_JA.postal_code, "postal_code", (c.postal_code || ap.postal_code || ""), { placeholder: "例：9800000" })}
          ${inputRow_(FIELD_LABELS_JA.prefecture, "prefecture", (c.prefecture || ap.prefecture || ""), { placeholder: "例：宮城県" })}
          ${inputRow_(FIELD_LABELS_JA.city, "city", (c.city || ap.city || ""), { placeholder: "例：仙台市青葉区" })}
          ${inputRow_(FIELD_LABELS_JA.address_line1, "address_line1", (c.address_line1 || ap.address_line1 || ""), { placeholder: "例：一番町1-2-3" })}
          ${inputRow_(FIELD_LABELS_JA.address_line2, "address_line2", (c.address_line2 || ap.address_line2 || ""), { placeholder: "例：ma familleビル 101" })}
          <div class="hr"></div>
          <div class="p"><strong>鍵</strong></div>
          ${selectRow_(FIELD_LABELS_JA.key_pickup_rule, "key_pickup_rule", pickup, KEY_PICKUP_RULE_OPTIONS)}
          ${inputRow_(FIELD_LABELS_JA.key_pickup_rule_other_detail, "key_pickup_rule_other", c.key_pickup_rule_other || c.keyPickupRuleOther || "", { placeholder: "例：庭の鉢植えの下", help: "「その他」選択時のみ入力してください。" })}
          <div class="p" style="margin-bottom:10px;">
            <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.key_pickup_fee_rule)}</strong></div>
            <select class="input" name="key_pickup_fee_rule">
              <option value="">—</option>
              <option value="free" ${kpfr === "free" ? "selected" : ""}>無料</option>
              <option value="paid" ${kpfr === "paid" ? "selected" : ""}>有料</option>
            </select>
          </div>
          ${selectRow_(FIELD_LABELS_JA.key_return_rule, "key_return_rule", ret, KEY_RETURN_RULE_OPTIONS)}
          ${inputRow_(FIELD_LABELS_JA.key_return_rule_other_detail, "key_return_rule_other", c.key_return_rule_other || c.keyReturnRuleOther || "", { placeholder: "例：外の物置内、保存容器の中", help: "「その他」選択時のみ入力してください。" })}
          <div class="p" style="margin-bottom:10px;">
            <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.key_return_fee_rule)}</strong></div>
            <select class="input" name="key_return_fee_rule">
              <option value="">—</option>
              <option value="free" ${krfr === "free" ? "selected" : ""}>無料</option>
              <option value="paid" ${krfr === "paid" ? "selected" : ""}>有料</option>
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
              <option value="free" ${pfr === "free" ? "selected" : ""}>無料</option>
              <option value="paid" ${pfr === "paid" ? "selected" : ""}>有料</option>
            </select>
          </div>
          <div class="p" style="margin-bottom:10px;">
            <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(FIELD_LABELS_JA.notes)}</strong></div>
            <textarea class="input" name="notes" rows="5" placeholder="引継ぎや注意点など">${escapeHtml(normStr_(c.notes || ""))}</textarea>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;">
        <label class="row" style="align-items:flex-start;">
          <input type="checkbox" name="terms_agreed" value="true" />
          <span class="p" style="color:var(--text);">利用規約・登録内容について顧客の同意を確認しました。</span>
        </label>
        <div class="p text-sm" style="margin-top:8px;">保存すると顧客情報を更新し、同意監査ログを記録します。</div>
      </div>
      <div class="row" style="justify-content:flex-end; margin-top:12px;">
        <button class="btn" type="button" id="btnSubmitMeetingCustomerProfile">保存</button>
      </div>
    </form>
  `;

  const formEl = host.querySelector('form[data-el="meetingCustomerForm"]');
  const saveBtn = host.querySelector("#btnSubmitMeetingCustomerProfile");
  saveBtn?.addEventListener("click", async () => {
    if (!formEl) return;
    const termsAgreed = !!formEl.querySelector('input[name="terms_agreed"]')?.checked;
    if (!termsAgreed) {
      toast({ title: "確認必須", message: "利用規約・登録内容の同意確認にチェックしてください。" });
      return;
    }

    const customer = {
      surname: getFormValue_(formEl, "surname"),
      given: getFormValue_(formEl, "given"),
      surname_kana: getFormValue_(formEl, "surname_kana"),
      given_kana: getFormValue_(formEl, "given_kana"),
      phone: getFormValue_(formEl, "phone"),
      emergency_phone: getFormValue_(formEl, "emergency_phone"),
      email: getFormValue_(formEl, "email"),
      billing_email: getFormValue_(formEl, "billing_email"),
      postal_code: getFormValue_(formEl, "postal_code"),
      prefecture: getFormValue_(formEl, "prefecture"),
      city: getFormValue_(formEl, "city"),
      address_line1: getFormValue_(formEl, "address_line1"),
      address_line2: getFormValue_(formEl, "address_line2"),
      key_pickup_rule: getFormValue_(formEl, "key_pickup_rule"),
      key_pickup_rule_other: getFormValue_(formEl, "key_pickup_rule_other"),
      key_pickup_fee_rule: getFormValue_(formEl, "key_pickup_fee_rule"),
      key_return_rule: getFormValue_(formEl, "key_return_rule"),
      key_return_rule_other: getFormValue_(formEl, "key_return_rule_other"),
      key_return_fee_rule: getFormValue_(formEl, "key_return_fee_rule"),
      key_location: getFormValue_(formEl, "key_location"),
      lock_no: getFormValue_(formEl, "lock_no"),
      parking_info: getFormValue_(formEl, "parking_info"),
      parking_fee_rule: getFormValue_(formEl, "parking_fee_rule"),
      notes: getFormValue_(formEl, "notes"),
    };

    if (!(customer.surname || customer.given)) {
      toast({ title: "入力不足", message: "姓または名を入力してください。" });
      return;
    }

    const ok = await showModal({
      title: "顧客情報を保存",
      bodyHtml: `
        <div class="p">打ち合わせで確認した内容を保存します。よろしいですか？</div>
        <div class="hr"></div>
        <div class="p text-sm" style="opacity:.75;">保存後、顧客情報を更新し、顧客/スタッフ向け通知処理を実行します。</div>
      `,
      okText: "保存",
      cancelText: "キャンセル",
    });
    if (!ok) return;

    try {
      if (saveBtn) saveBtn.disabled = true;
      const res = await runWithBlocking_(
        {
          title: "顧客情報を保存しています",
          bodyHtml: "保存と通知処理を実行しています。",
          busyText: "保存中...",
        },
        async () => await callGas({
          action: "submitMeetingCustomerProfile",
          visit_id: visitId,
          customer,
          terms_agreed: true,
        }, idToken)
      );
      if (!res || res.success === false) throw new Error((res && (res.error || res.message)) || "submitMeetingCustomerProfile failed");
      toast({ title: "保存完了", message: "顧客情報を更新しました。" });
      location.hash = backTo || `#/visits?id=${encodeURIComponent(visitId)}`;
    } catch (e) {
      toast({ title: "保存失敗", message: e?.message || String(e) });
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });
}
