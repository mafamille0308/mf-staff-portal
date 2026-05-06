// js/pages/settings.js
import { render, toast, escapeHtml, qs, qsa, showChoiceModal, fmtDateTimeJst } from "../ui.js";
import { getIdToken, getUser } from "../auth.js";
import {
  listBillingPriceRulesForSettings_,
  listBillingBatchesForSettings_,
  batchUpsertBillingPriceRulesForSettings_,
  toggleBillingPriceRuleForSettings_,
  getBillingBatchDetailForSettings_,
} from "./settings_billing_policy.js";
import {
  searchStaffsForSettings_,
  adminCreateStaffForSettings_,
  getMyStaffProfileForSettings_,
  updateMyStaffProfileForSettings_,
  getStaffProfileByIdForSettings_,
  updateStaffProfileByIdForSettings_,
  retireStaffPreviewForSettings_,
  retireStaffFlowForSettings_,
} from "./settings_staff_policy.js";
import {
  retryNotifyQueueForSettings_,
  readinessNotifyQueueForSettings_,
} from "./settings_notify_policy.js";
import {
  getOrganizationForSettings_,
  updateOrganizationForSettings_,
  getStoreForSettings_,
  updateStoreForSettings_,
  getSquareIntegrationStatusForSettings_,
  listSquareLocationsForSettings_,
  updateStoreSquareLocationForSettings_,
  startSquareOAuthForSettings_,
  disconnectSquareForSettings_,
} from "./settings_saas_policy.js";
import { runWithBlocking_ } from "./page_async_helpers.js";
import { formatMoney_ } from "./page_format_helpers.js";

function getRole_() {
  const u = getUser() || {};
  return String(u.role || "").toLowerCase();
}

function isAdmin_() {
  return getRole_() === "admin";
}

function val_(sel) {
  return String(qs(sel)?.value || "").trim();
}

function nextRequestId_() {
  return `web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toDateInputValue_(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function toRetireIso_(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00+09:00`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00+09:00`;
  return s;
}

function setInputValue_(sel, v) {
  const el = qs(sel);
  if (el) el.value = String(v || "");
}

// バックエンドの error_code 契約に対応する運営者向けガイド。
const STAFF_ERROR_GUIDE = Object.freeze({
  GOOGLE_OAUTH_FAILED: ["Cloud Run env GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN", "Check Cloud Run oauth logs"],
  GOOGLE_CALENDAR_INSERT_FAILED: ["Enable Calendar API and check quota", "Check calendars.insert response in Cloud Run logs"],
  GOOGLE_CALENDAR_ACL_FAILED: ["Check login_email input", "Check calendar sharing permissions"],
  GOOGLE_WATCH_FAILED: ["Check PUBLIC_BASE_URL and webhook route", "Check Google push setup"],
  SUPABASE_QUERY_FAILED: ["Check SUPABASE_URL / SERVICE_ROLE_KEY", "Check watch_channels permissions"],
  SUPABASE_UPSERT_FAILED: ["Check SUPABASE_URL / SERVICE_ROLE_KEY", "Check watch_channels upsert constraints"],
  CLOUDRUN_HTTP_ERROR: ["Check /staff/provision response code/body", "Check WATCH_ADMIN_KEY and Cloud Run logs"],
  CLOUDRUN_FETCH_ERROR: ["Check CALENDAR_WEBHOOK_URL / WATCH_ADMIN_KEY", "Check network and Cloud Run service health"],
});

function renderErrorGuideHtml_(code) {
  const c = String(code || "").trim();
  if (!c) return "";
  const steps = STAFF_ERROR_GUIDE[c] || ["Check Cloud Run logs", "Check API keys and URLs"];
  return `
    <div class="card settings-card-md settings-card-danger">
      <div class="p"><b>error_code</b>: ${escapeHtml(c)}</div>
      <ol class="settings-list">${steps.map((s) => `<li>${escapeHtml(String(s))}</li>`).join("")}</ol>
    </div>
  `;
}

// top-level と provision 内の追加エラー項目を同一形式に正規化する。
function normalizeErrorMeta_(obj) {
  const src = obj || {};
  const refs = Array.isArray(src.refs) ? src.refs : [];
  return {
    stage: String(src.stage || "").trim(),
    retryable: (typeof src.retryable === "boolean") ? src.retryable : null,
    operator_hint: String(src.operator_hint || "").trim(),
    refs,
  };
}

// 既存レイアウトを崩さず stage/retryable/hint/refs を表示する。
function renderErrorMetaHtml_(meta) {
  const m = meta || {};
  const stage = String(m.stage || "").trim();
  const retryable = (typeof m.retryable === "boolean") ? (m.retryable ? "true" : "false") : "";
  const hint = String(m.operator_hint || "").trim();
  const refs = Array.isArray(m.refs) ? m.refs : [];
  if (!stage && !retryable && !hint && !refs.length) return "";
  return `
    <div class="card settings-card-md">
      <div class="hint-row"><div class="muted">stage</div><div>${escapeHtml(stage || "-")}</div></div>
      <div class="hint-row"><div class="muted">retryable</div><div>${escapeHtml(retryable || "-")}</div></div>
      <div class="hint-row"><div class="muted">operator_hint</div><div>${escapeHtml(hint || "-")}</div></div>
      <div class="hint-row"><div class="muted">refs</div><div>${escapeHtml(refs.length ? refs.join(", ") : "-")}</div></div>
    </div>
  `;
}

function renderRetirePreviewHtml_(preview) {
  const p = preview || {};
  const visits = Array.isArray(p.future_visits) ? p.future_visits : [];
  const visitRows = visits.length
    ? `<div class="card settings-card-md"><div class="p"><b>未来予約</b></div><div class="settings-stack-6">${visits.slice(0, 10).map((v) => `<div class="hint-row"><div class="muted">${escapeHtml(String(v.start_time || "").replace("T", " ").replace("+09:00", ""))}</div><div>${escapeHtml(`${String(v.title || v.visit_id || "")} / ${String(v.customer_id || "")}`)}</div></div>`).join("")}${visits.length > 10 ? `<div class="p">ほか ${visits.length - 10} 件</div>` : ""}</div></div>`
    : "";
  return `
    <div class="card">
      <div class="hint-row"><div class="muted">退職日時</div><div>${escapeHtml(String(p.retire_at || "-"))}</div></div>
      <div class="hint-row"><div class="muted">未来予約</div><div>${escapeHtml(String(p.future_visit_count || 0))} 件</div></div>
      <div class="hint-row"><div class="muted">対象顧客</div><div>${escapeHtml(String(p.future_customer_count || 0))} 名</div></div>
      <div class="hint-row"><div class="muted">有効担当</div><div>${escapeHtml(String(p.active_assignment_count || 0))} 件</div></div>
      <div class="hint-row"><div class="muted">引継ぎ必須</div><div>${p.requires_handover ? "はい" : "いいえ"}</div></div>
    </div>
    ${visitRows}
  `;
}

function billingRuleItemTypeLabel_(itemType) {
  const s = String(itemType || "").trim();
  if (s === "visit_base") return "訪問基本料金";
  if (s === "parking_fee") return "駐車料金";
  if (s === "overtime_fee") return "延長料金";
  if (s === "reimbursement") return "立替金";
  if (s === "travel_fee") return "出張料金";
  if (s === "seasonal_fee") return "繁忙期加算";
  if (s === "key_pickup_fee") return "鍵預かり料金";
  if (s === "key_return_fee") return "鍵返却料金";
  if (s === "discount") return "割引テンプレート";
  if (s === "merchandise") return "一般商品";
  return s || "-";
}

function billingRuleRowHtml_(rule) {
  const r = rule || {};
  const priceRuleId = String(r.price_rule_id || "");
  const active = !!r.is_active;
  const visitBits = [r.product_name || r.label, r.duration_minutes ? `${r.duration_minutes}分` : ""].filter(Boolean).join(" / ");
  return `
    <div class="card settings-card-sm">
      <div class="p">
        <div class="row row-between settings-row-top">
          <div>
            <div><strong>${escapeHtml(String(r.label || "-"))}</strong> <span class="badge">${escapeHtml(billingRuleItemTypeLabel_(r.item_type))}</span> ${active ? `<span class="badge badge-ok">有効</span>` : `<span class="badge badge-danger">無効</span>`}</div>
            <div class="settings-subtext">${escapeHtml(visitBits || "-")}</div>
            <div class="settings-subtext">金額: ${escapeHtml(formatMoney_(r.amount))}円 / 商品ID: ${escapeHtml(priceRuleId || "-")}</div>
          </div>
          <div class="settings-btn-row">
            <button class="btn btn-ghost" type="button" data-action="billing-rule-edit" data-price-rule-id="${escapeHtml(priceRuleId)}">読込</button>
            <button class="btn btn-ghost" type="button" data-action="billing-rule-toggle" data-price-rule-id="${escapeHtml(priceRuleId)}" data-next-active="${active ? "false" : "true"}">${active ? "無効化" : "有効化"}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function billingRuleGroupHtml_(group) {
  const g = group || {};
  const rules = Array.isArray(g.rules) ? g.rules : [];
  const head = rules[0] || {};
  const active = rules.some((x) => !!x.is_active);
  return `
    <div class="card settings-card-sm">
      <div class="p">
        <div class="row row-between settings-row-top">
          <div>
            <div><strong>${escapeHtml(String(g.product_name || head.label || "-"))}</strong> <span class="badge">${escapeHtml(billingRuleItemTypeLabel_(g.item_type || head.item_type))}</span> ${active ? `<span class="badge badge-ok">有効</span>` : `<span class="badge badge-danger">無効</span>`}</div>
            <div class="settings-subtext">商品グループID: ${escapeHtml(String(g.product_group_id || head.price_rule_id || "-"))}</div>
            <div class="settings-subtext-grid">
              ${rules.map((r) => {
                const seasonalRange = (r.seasonal_start_mmdd && r.seasonal_end_mmdd)
                  ? ` / ${String(r.seasonal_start_mmdd)}〜${String(r.seasonal_end_mmdd)}`
                  : "";
                return `<div>${escapeHtml(String(r.variant_name || (r.duration_minutes ? `${r.duration_minutes}分` : r.label || "-")))} / ${escapeHtml(formatMoney_(r.amount))}円${r.duration_minutes ? ` / ${escapeHtml(String(r.duration_minutes))}分` : ``}${escapeHtml(seasonalRange)}</div>`;
              }).join("")}
            </div>
          </div>
          <div class="settings-btn-row">
            <button class="btn btn-ghost" type="button" data-action="billing-rule-group-edit" data-price-rule-id="${escapeHtml(String(g.product_group_id || head.price_rule_id || ""))}">読込</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function invoiceStatusLabel_(status) {
  const s = String(status || "").trim();
  if (s === "draft" || s === "invoice_draft") return "請求ドラフト";
  if (s === "sent") return "送付済";
  if (s === "paid") return "支払済";
  if (s === "canceled") return "取消";
  if (s === "voided") return "Void";
  if (s === "refunded") return "返金済";
  return s || "-";
}

function invoiceStatusBadgeClass_(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") return "badge badge-success";
  if (s === "sent" || s === "draft" || s === "invoice_draft") return "badge badge-warning";
  if (s === "canceled" || s === "voided" || s === "refunded") return "badge badge-danger";
  return "badge badge-info";
}

function invoiceRowHtml_(invoice) {
  const x = invoice || {};
  return `
    <div class="card settings-card-sm">
      <div class="p">
        <div class="row row-between settings-row-top">
          <div>
            <div><strong>${escapeHtml(String(x.batch_id || "-"))}</strong> <span class="${escapeHtml(invoiceStatusBadgeClass_(x.batch_status))}">${escapeHtml(invoiceStatusLabel_(x.batch_status))}</span></div>
            <div class="settings-subtext">${escapeHtml(String(x.customer_name || "-"))}</div>
            <div class="settings-subtext">Square: ${escapeHtml(String(x.square_invoice_status || x.square_invoice_id || "-"))}</div>
            <div class="settings-subtext">${escapeHtml(String(x.memo || "-"))}</div>
          </div>
          <div class="settings-btn-row">
            <button class="btn btn-ghost" type="button" data-action="invoice-detail" data-invoice-id="${escapeHtml(String(x.batch_id || ""))}">詳細</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function invoiceDetailHtml_(detail) {
  const d = detail || {};
  const invoice = d.batch || {};
  const lines = Array.isArray(d.links) ? d.links : [];
  return `
    <div class="card">
      <div class="p">
        <div><strong>${escapeHtml(String(invoice.batch_id || "-"))}</strong> / ${escapeHtml(invoiceStatusLabel_(invoice.batch_status))}</div>
        <div class="settings-subtext">顧客: ${escapeHtml(String(invoice.customer_name || "-"))}</div>
        <div class="settings-subtext">Square Invoice ID: ${escapeHtml(String(invoice.square_invoice_id || "-"))}</div>
        <div class="settings-subtext">Square Status: ${escapeHtml(String(invoice.square_invoice_status || "-"))}</div>
        <div class="settings-subtext">メモ: ${escapeHtml(String(invoice.memo || "-"))}</div>
      </div>
    </div>
    <div class="card settings-card-sm">
      <div class="p">
        <div><strong>対象予約</strong></div>
        <div class="settings-stack-8">
          ${lines.map((line) => `
            <div class="hint-row">
              <div>${escapeHtml(String(line.visit_id || "-"))} / ${escapeHtml(String(line.square_invoice_status || line.square_invoice_id || "-"))}</div>
              <div>${escapeHtml(formatMoney_(line.estimated_amount || 0))}円</div>
            </div>
          `).join("") || `<div>対象予約がありません。</div>`}
        </div>
      </div>
    </div>
  `;
}

function notifyQueueReadinessHtml_(data) {
  const d = data || {};
  const rows = Array.isArray(d.pending_sample) ? d.pending_sample : [];
  return `
    <div class="card">
      <div class="p">
        <div class="hint-row"><div class="muted">total</div><div>${escapeHtml(String(d.total || 0))}</div></div>
        <div class="hint-row"><div class="muted">pending</div><div>${escapeHtml(String(d.pending_count || 0))}</div></div>
        <div class="hint-row"><div class="muted">sent</div><div>${escapeHtml(String(d.sent_count || 0))}</div></div>
        <div class="hint-row"><div class="muted">retry_exceeded</div><div>${escapeHtml(String(d.retry_exceeded_count || 0))}</div></div>
        <div class="hint-row"><div class="muted">oldest_pending_at</div><div>${escapeHtml(String(d.oldest_pending_at || "-"))}</div></div>
      </div>
    </div>
    <div class="card settings-card-sm">
      <div class="p">
        <div><strong>pending sample</strong></div>
        <div class="settings-stack-8">
          ${rows.map((row) => `
            <div class="hint-row">
              <div>${escapeHtml(String(row.queue_id || "-"))} / try:${escapeHtml(String(row.try_count || 0))}</div>
              <div>${escapeHtml(String(row.last_error || row.status || "-"))}</div>
            </div>
          `).join("") || `<div>pending はありません。</div>`}
        </div>
      </div>
    </div>
  `;
}

function settingsIconSvg_(name) {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if (name === "back") {
    return `<svg ${common}><path d="M15 18l-6-6 6-6"></path><path d="M21 12H9"></path></svg>`;
  }
  return `<svg ${common}><circle cx="12" cy="12" r="9"></circle></svg>`;
}

export async function renderSettings(app, query) {
  const role = getRole_();
  const isAdmin = role === "admin";
  const areaRaw = String(query && query.get ? query.get("area") : "").trim().toLowerCase();
  const pageRaw = String(query && query.get ? query.get("page") : "").trim().toLowerCase();
  const storeIdRaw = String(query && query.get ? query.get("store_id") : "").trim();
  const settingsArea = (areaRaw === "personal" || areaRaw === "business")
    ? areaRaw
    : (isAdmin ? "business" : "personal");
  const isPersonalArea = settingsArea === "personal";
  const isBusinessArea = settingsArea === "business";
  const businessPage = (pageRaw === "store" || pageRaw === "operations" || pageRaw === "store_detail")
    ? "store_detail"
    : "business_home";
  const roInputClass = "settings-readonly";
  let _adminStaffList = [];
  if (!role) {
    render(app, `
      <section class="section">
        <h1 class="h1">設定</h1>
        <p class="p">このページを表示する権限がありません。</p>
      </section>
    `);
    return;
  }

  render(app, `
    <section class="section">
      <h1 class="h1">設定</h1>
      <p class="p">${isAdmin ? "個人情報と組織運用設定を管理します。" : "個人情報を管理します。"}</p>
      <div class="settings-tabnav" role="tablist" aria-label="設定カテゴリ">
        <a class="settings-tab ${isPersonalArea ? "is-active" : ""}" href="#/settings?area=personal">個人情報</a>
        ${isAdmin ? `<a class="settings-tab ${isBusinessArea ? "is-active" : ""}" href="#/settings?area=business">事業情報</a>` : ""}
      </div>

      <div class="hr"></div>

      ${isPersonalArea ? `<details class="settings-block" open>
        <summary class="p settings-summary">プロフィール設定</summary>
        <p class="p">自分の登録情報を編集できます。</p>
        <div class="grid settings-grid">
          <label class="field">
            <div class="label">氏名</div>
            <input id="myName" class="input ${roInputClass}" type="text" disabled />
          </label>
          <label class="field">
            <div class="label">通知メール（email）</div>
            <input id="myEmail" class="input ${roInputClass}" type="email" disabled />
          </label>
          <label class="field">
            <div class="label">ログイン/共有メール（login_email）</div>
            <input id="myLoginEmail" class="input ${roInputClass}" type="email" disabled />
          </label>
          <label class="field">
            <div class="label">電話（任意）</div>
            <input id="myPhone" class="input" type="tel" />
          </label>
          <label class="field">
            <div class="label">誕生日（任意）</div>
            <input id="myBirthdate" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">資格（任意）</div>
            <input id="myQualifications" class="input" type="text" />
          </label>
          ${isAdmin ? "" : `
          <label class="field">
            <div class="label">契約日</div>
            <input id="myContractStartDate" class="input ${roInputClass}" type="date" disabled />
          </label>
          <label class="field">
            <div class="label">契約更新日</div>
            <input id="myContractRenewalDate" class="input ${roInputClass}" type="date" disabled />
          </label>
          `}
        </div>
        <div class="settings-actions">
          <button id="btnSaveMyProfile" class="btn" type="button">保存</button>
        </div>
        <div id="myProfileResult" class="settings-result"></div>
      </details>` : ""}

      ${isAdmin && isBusinessArea && businessPage === "store_detail" ? `<details id="staffAddSection" class="settings-block">
        <summary class="p settings-summary">スタッフ追加</summary>
        <p class="p">新規スタッフ作成、スタッフ用カレンダー作成・共有を実行します。</p>

        <div class="grid settings-grid">
          <label class="field">
            <div class="label">氏名 *</div>
            <input id="stName" class="input" type="text" />
          </label>

          <label class="field">
            <div class="label">通知メール（email） *</div>
            <input id="stEmail" class="input" type="email" placeholder="example@gmail.com" />
          </label>

          <label class="field">
            <div class="label">ログイン/共有メール（login_email） *</div>
            <input id="stLoginEmail" class="input" type="email" placeholder="example@gmail.com" />
          </label>

          <label class="field">
            <div class="label">電話（任意）</div>
            <input id="stPhone" class="input" type="tel" />
          </label>

          <label class="field">
            <div class="label">誕生日（任意）</div>
            <input id="stBirthdate" class="input" type="date" />
          </label>

          <label class="field">
            <div class="label">契約日（任意）</div>
            <input id="stContractStartDate" class="input" type="date" />
          </label>

          <label class="field">
            <div class="label">契約更新日（任意）</div>
            <input id="stContractRenewalDate" class="input" type="date" />
          </label>

          <label class="field">
            <div class="label">役職（任意）</div>
            <input id="stPosition" class="input" type="text" />
          </label>

          <label class="field">
            <div class="label">資格（任意）</div>
            <input id="stQualifications" class="input" type="text" />
          </label>
        </div>

        <div class="settings-actions">
          <button id="btnCreateStaff" class="btn" type="button">スタッフを追加</button>
        </div>

        <div id="staffCreateResult" class="settings-result"></div>
      </details>` : ""}

      ${isAdmin && isBusinessArea && businessPage === "store_detail" ? `<details id="staffEditSection" class="settings-block">
        <summary class="p settings-summary">スタッフ情報閲覧・編集</summary>
        <p class="p">スタッフの登録情報閲覧と編集ができます。</p>
        <div class="grid settings-grid">
          <label class="field">
            <div class="label">スタッフ</div>
            <select id="adminEditStaffId" class="select"></select>
          </label>
          <label class="field">
            <div class="label">ログイン/共有メール（login_email）</div>
            <input id="adminEditLoginEmail" class="input" type="email" />
          </label>
          <label class="field">
            <div class="label">電話（任意）</div>
            <input id="adminEditPhone" class="input" type="tel" />
          </label>
          <label class="field">
            <div class="label">誕生日（任意）</div>
            <input id="adminEditBirthdate" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">契約日（任意）</div>
            <input id="adminEditContractStartDate" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">契約更新日（任意）</div>
            <input id="adminEditContractRenewalDate" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">契約解除日（任意）</div>
            <input id="adminEditContractEndDate" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">役職（任意）</div>
            <input id="adminEditPosition" class="input" type="text" />
          </label>
          <label class="field">
            <div class="label">資格（任意）</div>
            <input id="adminEditQualifications" class="input" type="text" />
          </label>
        </div>
        <div class="settings-actions">
          <button id="btnSaveAdminStaffProfile" class="btn" type="button">保存</button>
        </div>
        <div id="adminStaffProfileResult" class="settings-result"></div>

        <div class="hr"></div>
        <details class="settings-subdetail">
          <summary class="p settings-summary">退職処理</summary>
          <p class="p">退職前に、未来予約と担当関係の引継ぎ状況を確認します。</p>
          <div class="grid settings-grid">
            <label class="field">
              <div class="label">退職日</div>
              <input id="adminRetireAt" class="input" type="date" />
            </label>
            <label class="field">
              <div class="label">引継ぎ先スタッフ（引継ぎ時のみ）</div>
              <select id="adminRetireToStaffId" class="select"></select>
            </label>
          </div>
          <div class="settings-actions">
            <button id="btnRetireStaff" class="btn" type="button">退職を確定</button>
          </div>
          <div id="adminRetireResult" class="settings-result"></div>
        </details>
      </details>` : ""}

      ${isAdmin && isBusinessArea && businessPage === "store_detail" ? `<details id="pricingSection" class="settings-block">
        <summary class="p settings-summary">料金マスタ管理</summary>
        <p class="p">請求計算に使う商品を管理します。</p>
        <div class="grid settings-grid">
          <label class="field">
            <div class="label">商品ID</div>
            <input id="billingRuleId" class="input ${roInputClass}" type="text" disabled />
          </label>
          <label class="field">
            <div class="label">商品グループID</div>
            <input id="billingRuleGroupId" class="input ${roInputClass}" type="text" disabled />
          </label>
          <label class="field">
            <div class="label">商品名 *</div>
            <input id="billingRuleLabel" class="input" type="text" />
          </label>
          <label class="field">
            <div class="label">料金区分 *</div>
            <select id="billingRuleItemType" class="select">
              <option value="visit_base">訪問基本料金</option>
              <option value="parking_fee">駐車料金</option>
              <option value="overtime_fee">延長料金</option>
              <option value="reimbursement">立替金</option>
              <option value="travel_fee">出張料金</option>
              <option value="seasonal_fee">繁忙期加算</option>
              <option value="key_pickup_fee">鍵預かり料金</option>
              <option value="key_return_fee">鍵返却料金</option>
              <option value="discount">割引テンプレート</option>
              <option value="merchandise">一般商品</option>
            </select>
          </label>
          <label class="field">
            <div class="label">バリエーション</div>
            <div id="billingRuleVariants" class="settings-grid-8"></div>
            <div class="settings-mt-8">
              <button id="btnAddBillingVariant" class="btn btn-ghost" type="button">+ バリエーション追加</button>
            </div>
          </label>
          <label class="field">
            <div class="label">適用開始日</div>
            <input id="billingRuleEffectiveFrom" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">適用終了日</div>
            <input id="billingRuleEffectiveTo" class="input" type="date" />
          </label>
          <label class="field">
            <div class="label">備考</div>
            <input id="billingRuleNote" class="input" type="text" />
          </label>
        </div>
        <div class="settings-actions">
          <button id="btnSaveBillingRule" class="btn" type="button">保存</button>
          <button id="btnResetBillingRuleForm" class="btn btn-ghost" type="button">入力をクリア</button>
          <button id="btnReloadBillingRules" class="btn btn-ghost" type="button">再読み込み</button>
        </div>
        <div id="billingRulesResult" class="settings-result"></div>
        <div id="billingRulesList" class="settings-result"></div>
      </details>` : ""}

      ${isAdmin && isBusinessArea && businessPage === "business_home" ? `<details class="settings-block" open>
        <summary class="p settings-summary">組織設定</summary>
        <p class="p">組織プロフィールを管理します。</p>
        <div class="grid settings-grid">
          <label class="field">
            <div class="label">組織名（会社名・屋号） *</div>
            <input id="saasOrgName" class="input" type="text" />
          </label>
          <label class="field">
            <div class="label">代表者名</div>
            <input id="saasRepresentativeName" class="input" type="text" />
          </label>
          <label class="field">
            <div class="label">オーナーログインメール</div>
            <input id="saasOwnerLoginEmail" class="input settings-readonly" type="text" readonly />
          </label>
        </div>
        <div class="settings-actions">
          <button id="btnSaasReloadProfile" class="btn btn-ghost" type="button">再読み込み</button>
          <button id="btnSaasSaveProfile" class="btn" type="button">保存</button>
        </div>
        <div id="saasProfileResult" class="settings-result"></div>
        <div class="hr"></div>
        <p class="p">Square連携状態</p>
        <div class="settings-actions">
          <button id="btnReloadSquareStatus" class="btn btn-ghost" type="button">再読み込み</button>
        </div>
        <div id="squareStatusResult" class="settings-result"></div>
      </details>` : ""}

      ${isAdmin && isBusinessArea && businessPage === "business_home" ? `<details class="settings-block" open>
        <summary class="p settings-summary">店舗</summary>
        <p class="p">店舗を選択して、店舗設定・スタッフ・料金マスタを管理します。</p>
        <div id="businessStoreList" class="settings-result">
          <p class="p">店舗一覧を読み込み中…</p>
        </div>
        <div class="settings-actions settings-actions-left">
          <button id="btnAddStoreComingSoon" class="btn-linklike" type="button">+ 店舗を新規追加</button>
        </div>
        <div id="businessStoreListResult" class="settings-result"></div>
      </details>` : ""}

      ${isAdmin && isBusinessArea && businessPage === "store_detail" ? `<section id="storeDetailSection" class="settings-block">
        <div class="settings-actions">
          <a class="btn btn-icon-action" href="#/settings?area=business" title="店舗一覧に戻る" aria-label="店舗一覧に戻る">${settingsIconSvg_("back")}</a>
        </div>
        <div class="p settings-summary">店舗設定</div>
        <p class="p">店舗プロフィールと運用設定を管理します。</p>
        <div class="grid settings-grid">
          <label class="field">
            <div class="label">店舗名 *</div>
            <input id="saasStoreName" class="input" type="text" />
          </label>
          <label class="field">
            <div class="label">通知元メールアドレス</div>
            <input id="saasNotificationFromEmail" class="input" type="email" />
          </label>
        </div>
        <div class="settings-actions">
          <button id="btnSaasReloadProfile" class="btn btn-ghost" type="button">再読み込み</button>
          <button id="btnSaasSaveProfile" class="btn" type="button">保存</button>
        </div>
        <div class="hr"></div>
        <p class="p">Square利用店舗</p>
        <label class="field">
          <div class="label">Square Location</div>
          <select id="saasSquareLocationSelect" class="select"></select>
        </label>
        <div class="settings-actions">
          <button id="btnReloadSquareLocations" class="btn btn-ghost" type="button">再読み込み</button>
          <button id="btnSaveSquareLocation" class="btn" type="button">保存</button>
        </div>
        <div id="saasSquareLocationResult" class="settings-result"></div>
        <p class="p settings-note-muted">現在は単一店舗運用のため、設定画面での店舗追加は無効化しています。</p>
        <div id="saasProfileResult" class="settings-result"></div>
      </section>` : ""}
    </section>
  `);

  qs("#btnCreateStaff")?.addEventListener("click", async () => {
    const name = val_("#stName");
    const email = val_("#stEmail").toLowerCase();
    const login_email = val_("#stLoginEmail").toLowerCase();
    const phone = val_("#stPhone");
    const birthdate = val_("#stBirthdate");
    const contract_start_date = val_("#stContractStartDate");
    const contract_renewal_date = val_("#stContractRenewalDate");
    const position = val_("#stPosition");
    const qualifications = val_("#stQualifications");
    const user = getUser() || {};
    const tenant_id = String(user.tenant_id || "").trim() || "TENANT_LEGACY";
    const store_id = String(user.store_id || user.org_id || "").trim();
    const role = "staff";

    if (!name || !email || !login_email) {
      toast({ title: "入力不足", message: "必須項目（氏名 / email / login_email）を入力してください。" });
      return;
    }
    if (!store_id) {
      toast({ title: "設定不足", message: "ログイン中管理者の store_id/org_id が取得できません。再ログイン後に再実行してください。" });
      return;
    }

    const btn = qs("#btnCreateStaff");
    if (btn) btn.disabled = true;

    const host = qs("#staffCreateResult");
    if (host) host.innerHTML = `<p class="p">作成中…</p>`;

    try {
      const res = await runWithBlocking_(
        {
          title: "スタッフを追加しています",
          bodyHtml: "スタッフ登録とカレンダー作成・共有を実行しています。",
          busyText: "作成中...",
        },
        async () => {
          const idToken = getIdToken();
          return await adminCreateStaffForSettings_(idToken, {
            name,
            email,
            login_email,
            phone,
            birthdate,
            contract_start_date,
            contract_renewal_date,
            position,
            qualifications,
            tenant_id,
            store_id,
            org_id: store_id,
            role,
          });
        }
      );

      const staffId = escapeHtml(res.staff_id || "");
      const calId = escapeHtml(res.calendar_id || "");
      const errorCode = String(
        (res && (res.error_code || (res.provision && res.provision.error_code))) || ""
      ).trim();
      const operatorMessage = String(
        (res && (res.operator_message || (res.provision && res.provision.operator_message))) || ""
      ).trim();
      const isSuccess = (!errorCode && (res && res.staff_id) && (res && res.calendar_id));
      const staffName = String(name || "").trim();
      const errorGuideHtml = errorCode ? renderErrorGuideHtml_(errorCode) : "";
      const errorMeta = errorCode ? normalizeErrorMeta_(Object.assign({}, res || {}, (res && res.provision) || {})) : null;
      const errorMetaHtml = errorCode ? renderErrorMetaHtml_(errorMeta) : "";
      const warning = res.warning
        ? `<div class="card settings-card-md"><div class="p"><b>注意</b><br>${escapeHtml(String(res.warning))}</div></div>`
        : "";

      if (host) {
        if (isSuccess) {
          host.innerHTML = `
            <div class="card">
              <div class="p"><b>作成完了</b></div>
              <ol class="settings-list-flow">
                <li>スタッフ登録が完了しました。</li>
                <li>Googleカレンダーで {店舗名} - ${escapeHtml(staffName)} を作成・共有しました。</li>
                <li>予約登録を実施して、動作を確認してください。</li>
              </ol>
            </div>
            ${warning}
          `;
        } else {
          host.innerHTML = `
            <div class="card">
              <div class="p"><b>作成完了</b></div>
              <div class="hint-row"><div class="muted">staff_id</div><div>${staffId || "-"}</div></div>
              <div class="hint-row"><div class="muted">calendar_id</div><div>${calId || "-"}</div></div>
              <div class="hint-row"><div class="muted">operator_message</div><div>${escapeHtml(operatorMessage || "-")}</div></div>
              ${errorCode ? `<div class="hint-row"><div class="muted">error_code</div><div>${escapeHtml(errorCode)}</div></div>` : ""}
            </div>
            ${errorMetaHtml}
            ${errorGuideHtml}
            ${warning}
          `;
        }
      }

      toast({ title: "完了", message: `スタッフを追加しました（${res.staff_id || ""}）` });
    } catch (e) {
      // backend から operator_message が返る場合は最優先で表示する。
      const code = String(
        (e && (e.error_code || (e.detail && e.detail.response && e.detail.response.error_code))) || ""
      ).trim();
      const operatorMessage = String(
        (e && e.detail && e.detail.response && e.detail.response.operator_message) || ""
      ).trim();
      const meta = normalizeErrorMeta_(e && e.detail && e.detail.response);
      const metaHtml = renderErrorMetaHtml_(meta);
      const guideHtml = code ? renderErrorGuideHtml_(code) : "";
      if (host) host.innerHTML = `${metaHtml}${guideHtml}`;
      toast({ title: "作成失敗", message: operatorMessage || e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  let _saasScope = { tenant_id: "", store_id: "" };
  let _saasPermissions = {
    can_update_organization_name: false,
    can_update_representative_name: false,
    can_update_store_name: false,
    can_update_notification_from_email: false,
    can_update_any: false,
  };
  let _saasProfileSnapshot = {
    tenant_id: "",
    store_id: "",
    organization_name: "",
    store_name: "",
  };

  function renderBusinessStoreList_() {
    const host = qs("#businessStoreList");
    if (!host) return;
    const storeId = String(_saasProfileSnapshot.store_id || _saasScope.store_id || "").trim();
    const storeName = String(_saasProfileSnapshot.store_name || "").trim() || "店舗名未設定";
    if (!storeId) {
      host.innerHTML = `<div class="card"><div class="p">表示可能な店舗がありません。</div></div>`;
      return;
    }
    const href = `#/settings?area=business&page=store_detail&store_id=${encodeURIComponent(storeId)}`;
    host.innerHTML = `
      <ul class="settings-link-list">
        <li>
          <a class="settings-list-link" href="${href}">${escapeHtml(storeName)}</a>
        </li>
      </ul>
    `;
  }

  function renderSquareStatusHtml_(status) {
    const s = status && typeof status === "object" ? status : {};
    const tenantConn = (s.tenant_connection && typeof s.tenant_connection === "object") ? s.tenant_connection : {};
    const storeLink = (s.store_link && typeof s.store_link === "object") ? s.store_link : {};
    const connectionStatus = String(tenantConn.connection_status || "").trim().toLowerCase();
    const isConnected = connectionStatus === "connected";
    const statusLabel = isConnected ? "接続済み" : "未接続";
    const merchantName = String(tenantConn.merchant_name || "").trim();
    const connectedAt = fmtDateTimeJst(tenantConn.connected_at);
    const updatedAt = fmtDateTimeJst(tenantConn.updated_at || storeLink.updated_at);
    const hasStoreLocation = !!storeLink.has_store_location_override;
    const storeLocationWarning = isConnected && !hasStoreLocation
      ? `<div class="p settings-warning">店舗ページからSquare利用店舗の設定が必要です。</div>`
      : "";
    const actionButtons = isConnected
      ? `
        <div class="settings-actions">
          <button id="btnSquareReconnect" class="btn btn-ghost" type="button">再連携</button>
          <button id="btnSquareDisconnect" class="btn" type="button">連携解除</button>
        </div>
      `
      : `
        <div class="settings-actions">
          <button id="btnSquareConnect" class="btn" type="button">連携する</button>
        </div>
      `;
    return `
      <div class="hint-row"><div class="muted">連携状態</div><div>${escapeHtml(statusLabel)}</div></div>
      <div class="hint-row"><div class="muted">事業者名</div><div>${escapeHtml(merchantName || "-")}</div></div>
      <div class="hint-row"><div class="muted">連携日時</div><div>${escapeHtml(connectedAt || "-")}</div></div>
      <div class="hint-row"><div class="muted">最終更新</div><div>${escapeHtml(updatedAt || "-")}</div></div>
      ${storeLocationWarning}
      ${actionButtons}
    `;
  }

  let _squareLocationOptions = [];
  function renderSquareLocationOptions_(selectedId = "") {
    const host = qs("#saasSquareLocationSelect");
    if (!host) return;
    const selected = String(selectedId || "").trim();
    const rows = Array.isArray(_squareLocationOptions) ? _squareLocationOptions : [];
    const opts = [`<option value="">未設定</option>`];
    rows.forEach((x) => {
      const id = String(x && x.id || "").trim();
      if (!id) return;
      const name = String(x && x.name || id).trim();
      const isSel = selected && selected === id;
      opts.push(`<option value="${escapeHtml(id)}" ${isSel ? "selected" : ""}>${escapeHtml(`${name} (${id})`)}</option>`);
    });
    host.innerHTML = opts.join("");
  }

  function applySaasProfilePermissions_() {
    const canOrg = !!_saasPermissions.can_update_organization_name;
    const canStore = !!_saasPermissions.can_update_store_name;
    const canStoreNotify = !!_saasPermissions.can_update_notification_from_email;
    const canRep = !!_saasPermissions.can_update_representative_name;
    const canAny = !!_saasPermissions.can_update_any;
    const orgInput = qs("#saasOrgName");
    const storeInput = qs("#saasStoreName");
    const storeNotifyInput = qs("#saasNotificationFromEmail");
    const repInput = qs("#saasRepresentativeName");
    const saveBtn = qs("#btnSaasSaveProfile");
    if (orgInput) orgInput.disabled = !canOrg;
    if (storeInput) storeInput.disabled = !canStore;
    if (storeNotifyInput) storeNotifyInput.disabled = !canStoreNotify;
    if (repInput) repInput.disabled = !canRep;
    if (saveBtn) saveBtn.disabled = !canAny;
  }

  async function loadOrganizationStoreProfile_(opts = {}) {
    if (!isAdmin) return;
    const host = qs("#saasProfileResult");
    if (host && opts.silent !== true) host.innerHTML = `<p class="p">組織・店舗情報を読み込み中…</p>`;
    try {
      const idToken = getIdToken();
      const res = await runWithBlocking_(
        {
          title: "組織・店舗情報を読み込んでいます",
          bodyHtml: "現在の設定情報を取得しています。",
          busyText: "読み込み中...",
        },
        async () => {
          const organizationRes = await getOrganizationForSettings_(idToken, {
            get_organization: { tenant_id: _saasScope.tenant_id },
          });
          const org = (organizationRes && organizationRes.organization && typeof organizationRes.organization === "object")
            ? organizationRes.organization
            : {};
          const orgPermissions = (organizationRes && organizationRes.permissions && typeof organizationRes.permissions === "object")
            ? organizationRes.permissions
            : {};
          const tenantId = String(org.tenant_id || _saasScope.tenant_id || "").trim();
          const storeRes = await getStoreForSettings_(idToken, {
            get_store: { tenant_id: tenantId, store_id: _saasScope.store_id },
          });
          const store = (storeRes && storeRes.store && typeof storeRes.store === "object")
            ? storeRes.store
            : {};
          const storePermissions = (storeRes && storeRes.permissions && typeof storeRes.permissions === "object")
            ? storeRes.permissions
            : {};
          return {
            profile: {
              tenant_id: tenantId,
              store_id: String(store.store_id || _saasScope.store_id || "").trim(),
              organization_name: String(org.organization_name || "").trim(),
              store_name: String(store.store_name || "").trim(),
              notification_from_email: String(store.notification_from_email || "").trim(),
              square_location_id: String(store.square_location_id || "").trim(),
              representative_name: String(org.representative_name || "").trim(),
              owner_login_email: String(org.owner_login_email || "").trim(),
            },
            permissions: {
              can_update_organization_name: !!orgPermissions.can_update_organization_name,
              can_update_representative_name: !!orgPermissions.can_update_representative_name,
              can_update_store_name: !!storePermissions.can_update_store_name,
              can_update_notification_from_email: !!storePermissions.can_update_notification_from_email,
              can_update_any: !!(
                orgPermissions.can_update_any ||
                storePermissions.can_update_any
              ),
            },
          };
        }
      );
      const profile = (res && res.profile && typeof res.profile === "object") ? res.profile : {};
      const permissions = (res && res.permissions && typeof res.permissions === "object") ? res.permissions : {};
      _saasScope = {
        tenant_id: String(profile.tenant_id || _saasScope.tenant_id || "").trim(),
        store_id: String(profile.store_id || _saasScope.store_id || "").trim(),
      };
      _saasPermissions = {
        can_update_organization_name: !!permissions.can_update_organization_name,
        can_update_representative_name: !!permissions.can_update_representative_name,
        can_update_store_name: !!permissions.can_update_store_name,
        can_update_notification_from_email: !!permissions.can_update_notification_from_email,
        can_update_any: !!permissions.can_update_any,
      };
      _saasProfileSnapshot = {
        tenant_id: String(profile.tenant_id || "").trim(),
        store_id: String(profile.store_id || "").trim(),
        organization_name: String(profile.organization_name || "").trim(),
        store_name: String(profile.store_name || "").trim(),
      };
      setInputValue_("#saasOrgName", String(profile.organization_name || "").trim());
      setInputValue_("#saasStoreName", String(profile.store_name || "").trim());
      setInputValue_("#saasNotificationFromEmail", String(profile.notification_from_email || "").trim());
      setInputValue_("#saasSquareLocationSelect", String(profile.square_location_id || "").trim());
      setInputValue_("#saasRepresentativeName", String(profile.representative_name || "").trim());
      setInputValue_("#saasOwnerLoginEmail", String(profile.owner_login_email || "").trim());
      applySaasProfilePermissions_();
      renderBusinessStoreList_();
      if (host) host.innerHTML = "";
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">組織・店舗情報の取得に失敗しました。</div></div>`;
      toast({ title: "取得失敗", message: e?.message || String(e) });
    }
  }

  async function loadSquareIntegrationStatus_(opts = {}) {
    if (!isAdmin || !isBusinessArea || businessPage !== "business_home") return;
    const host = qs("#squareStatusResult");
    if (host && opts.silent !== true) host.innerHTML = `<p class="p">Square連携状態を読み込み中…</p>`;
    try {
      const idToken = getIdToken();
      const res = await getSquareIntegrationStatusForSettings_(idToken, {
        get_square_integration_status: {
          tenant_id: _saasScope.tenant_id,
          store_id: _saasScope.store_id,
        },
      });
      const status = (res && res.square_integration && typeof res.square_integration === "object")
        ? res.square_integration
        : {};
      if (host) host.innerHTML = `<div class="card">${renderSquareStatusHtml_(status)}</div>`;
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">Square連携状態の取得に失敗しました。</div></div>`;
      toast({ title: "取得失敗", message: e?.message || String(e) });
    }
  }

  async function loadSquareLocations_(opts = {}) {
    if (!isAdmin || !isBusinessArea || businessPage !== "store_detail") return;
    const host = qs("#saasSquareLocationResult");
    if (host && opts.silent !== true) host.innerHTML = `<p class="p">Square Location一覧を読み込み中…</p>`;
    try {
      const idToken = getIdToken();
      const res = await listSquareLocationsForSettings_(idToken, {
        list_square_locations: {
          tenant_id: _saasScope.tenant_id,
          store_id: _saasScope.store_id,
        },
      });
      _squareLocationOptions = Array.isArray(res && res.locations) ? res.locations : [];
      const current = val_("#saasSquareLocationSelect");
      renderSquareLocationOptions_(current);
      if (host) host.innerHTML = `<div class="card"><div class="p">Square Locationを読み込みました（${_squareLocationOptions.length}件）。</div></div>`;
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">Square Location一覧の取得に失敗しました。</div></div>`;
      toast({ title: "取得失敗", message: e?.message || String(e) });
    }
  }

  const saasUser = getUser() || {};
  _saasScope = {
    tenant_id: String(saasUser.tenant_id || "").trim() || "TENANT_LEGACY",
    store_id: String(saasUser.store_id || saasUser.org_id || "").trim(),
  };
  if (isAdmin && isBusinessArea && businessPage === "store_detail" && storeIdRaw) {
    _saasScope.store_id = storeIdRaw;
  }
  setInputValue_("#saasOwnerLoginEmail", String(saasUser.login_email || saasUser.email || "").trim().toLowerCase());
  applySaasProfilePermissions_();

  qs("#btnAddStoreComingSoon")?.addEventListener("click", () => {
    const host = qs("#businessStoreListResult");
    if (host) host.innerHTML = `<div class="card"><div class="p">現在は店舗追加機能は未実装です。</div></div>`;
    toast({ title: "未実装", message: "現在は店舗追加機能は未実装です。" });
  });

  qs("#btnSaasReloadProfile")?.addEventListener("click", async () => {
    await loadOrganizationStoreProfile_();
    await loadSquareIntegrationStatus_({ silent: true });
    await loadSquareLocations_({ silent: true });
  });

  qs("#btnReloadSquareStatus")?.addEventListener("click", async () => {
    await loadSquareIntegrationStatus_();
  });

  qs("#squareStatusResult")?.addEventListener("click", async (ev) => {
    const connectBtn = ev.target.closest("#btnSquareConnect");
    const reconnectBtn = ev.target.closest("#btnSquareReconnect");
    const disconnectBtn = ev.target.closest("#btnSquareDisconnect");
    if (connectBtn || reconnectBtn) {
      try {
        const idToken = getIdToken();
        const res = await startSquareOAuthForSettings_(idToken, {
          start_square_oauth: {
            tenant_id: _saasScope.tenant_id,
            store_id: _saasScope.store_id,
          },
        });
        const url = String(res?.oauth?.authorize_url || "").trim();
        if (!url) throw new Error("Square連携URLを取得できませんでした。");
        window.location.href = url;
      } catch (e) {
        toast({ title: "連携開始失敗", message: e?.message || String(e) });
      }
    }
    if (disconnectBtn) {
      try {
        const idToken = getIdToken();
        const requestId = nextRequestId_();
        await disconnectSquareForSettings_(idToken, {
          request_id: requestId,
          disconnect_square: {
            request_id: requestId,
            tenant_id: _saasScope.tenant_id,
          },
        });
        toast({ title: "完了", message: "Square連携を解除しました。" });
        await loadSquareIntegrationStatus_({ silent: true });
        await loadSquareLocations_({ silent: true });
      } catch (e) {
        toast({ title: "連携解除失敗", message: e?.message || String(e) });
      }
    }
  });

  qs("#btnReloadSquareLocations")?.addEventListener("click", async () => {
    await loadSquareLocations_();
  });

  qs("#btnSaveSquareLocation")?.addEventListener("click", async () => {
    const locationId = val_("#saasSquareLocationSelect");
    const host = qs("#saasSquareLocationResult");
    const btn = qs("#btnSaveSquareLocation");
    if (btn) btn.disabled = true;
    if (host) host.innerHTML = `<p class="p">保存中…</p>`;
    try {
      const idToken = getIdToken();
      const selected = (Array.isArray(_squareLocationOptions) ? _squareLocationOptions : [])
        .find((x) => String(x && x.id || "").trim() === locationId);
      const res = await updateStoreSquareLocationForSettings_(idToken, {
        request_id: nextRequestId_(),
        update_square_location: {
          request_id: nextRequestId_(),
          tenant_id: _saasScope.tenant_id,
          store_id: _saasScope.store_id,
          square_location_id: locationId,
          location_name: selected ? String(selected.name || "").trim() : "",
        },
      });
      if (host) host.innerHTML = `<div class="card"><div class="p">Square Locationを保存しました。</div></div>`;
      toast({ title: "完了", message: "Square Locationを保存しました。" });
      const savedId = String(res?.store_square_link?.square_location_id || "").trim();
      renderSquareLocationOptions_(savedId);
      await loadSquareIntegrationStatus_({ silent: true });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">Square Locationの保存に失敗しました。</div></div>`;
      toast({ title: "保存失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  qs("#btnSaasSaveProfile")?.addEventListener("click", async () => {
    const orgName = val_("#saasOrgName");
    const storeName = val_("#saasStoreName");
    const notificationFromEmail = val_("#saasNotificationFromEmail");
    const representativeName = val_("#saasRepresentativeName");
    const hasOrgForm = !!qs("#saasOrgName");
    const hasStoreForm = !!qs("#saasStoreName");
    const host = qs("#saasProfileResult");
    const btn = qs("#btnSaasSaveProfile");
    if (!_saasPermissions.can_update_any) {
      toast({ title: "権限不足", message: "この設定を編集する権限がありません。" });
      return;
    }
    if (hasOrgForm && _saasPermissions.can_update_organization_name && (!orgName || !_saasScope.tenant_id)) {
      toast({ title: "入力不足", message: "組織名を入力してください。" });
      return;
    }
    if (hasStoreForm && _saasPermissions.can_update_store_name && _saasScope.store_id && !storeName) {
      toast({ title: "入力不足", message: "店舗名を入力してください。" });
      return;
    }
    if (hasStoreForm && _saasPermissions.can_update_notification_from_email && notificationFromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationFromEmail)) {
      toast({ title: "入力エラー", message: "通知元メールアドレスの形式を確認してください。" });
      return;
    }
    if (btn) btn.disabled = true;
    if (host) host.innerHTML = `<p class="p">保存中…</p>`;
    try {
      const idToken = getIdToken();
      const outcome = await runWithBlocking_(
        {
          title: "組織・店舗情報を保存しています",
          bodyHtml: "プロフィール設定を更新しています。",
          busyText: "保存中...",
        },
        async () => {
          const summary = {
            organization: "未実行",
            store: "未実行",
            has_error: false,
          };
          if (hasOrgForm && (_saasPermissions.can_update_organization_name || _saasPermissions.can_update_representative_name)) {
            try {
              const orgRes = await updateOrganizationForSettings_(idToken, {
                request_id: nextRequestId_(),
                update_organization: {
                  request_id: nextRequestId_(),
                  tenant_id: _saasScope.tenant_id,
                  organization_name: _saasPermissions.can_update_organization_name ? orgName : "",
                  representative_name: _saasPermissions.can_update_representative_name ? representativeName : "",
                },
              });
              summary.organization = orgRes && orgRes.no_op ? "変更なし" : "更新完了";
            } catch (orgErr) {
              summary.organization = `失敗: ${String(orgErr?.message || orgErr)}`;
              summary.has_error = true;
            }
          } else {
            summary.organization = hasOrgForm ? "権限なしのため未実行" : "画面未表示のため未実行";
          }
          if (hasStoreForm && _saasScope.store_id && (_saasPermissions.can_update_store_name || _saasPermissions.can_update_notification_from_email)) {
            try {
              const storeRes = await updateStoreForSettings_(idToken, {
                request_id: nextRequestId_(),
                update_store: {
                  request_id: nextRequestId_(),
                  tenant_id: _saasScope.tenant_id,
                  store_id: _saasScope.store_id,
                  store_name: _saasPermissions.can_update_store_name ? storeName : "",
                  notification_from_email: _saasPermissions.can_update_notification_from_email ? notificationFromEmail : "",
                },
              });
              summary.store = storeRes && storeRes.no_op ? "変更なし" : "更新完了";
            } catch (storeErr) {
              summary.store = `失敗: ${String(storeErr?.message || storeErr)}`;
              summary.has_error = true;
            }
          } else if (!hasStoreForm) {
            summary.store = "画面未表示のため未実行";
          } else if (!_saasScope.store_id) {
            summary.store = "store_id未解決のため未実行";
          } else {
            summary.store = "権限なしのため未実行";
          }
          if (summary.has_error) {
            const e = new Error("一部の更新に失敗しました。");
            e.save_summary = summary;
            throw e;
          }
          return summary;
        }
      );
      if (host) host.innerHTML = `
        <div class="card">
          <div class="p">組織・店舗情報を保存しました。</div>
          <div class="hint-row"><div class="muted">組織</div><div>${escapeHtml(String(outcome?.organization || "-"))}</div></div>
          <div class="hint-row"><div class="muted">店舗</div><div>${escapeHtml(String(outcome?.store || "-"))}</div></div>
        </div>
      `;
      toast({ title: "完了", message: "組織・店舗情報を保存しました。" });
      await loadOrganizationStoreProfile_({ silent: true });
    } catch (e) {
      const summary = e && e.save_summary ? e.save_summary : null;
      if (host) host.innerHTML = `
        <div class="card">
          <div class="p">組織・店舗情報の保存に失敗しました。</div>
          ${summary ? `<div class="hint-row"><div class="muted">組織</div><div>${escapeHtml(String(summary.organization || "-"))}</div></div>` : ""}
          ${summary ? `<div class="hint-row"><div class="muted">店舗</div><div>${escapeHtml(String(summary.store || "-"))}</div></div>` : ""}
        </div>
      `;
      toast({ title: "保存失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  if (isAdmin && isBusinessArea) {
    loadOrganizationStoreProfile_({ silent: true });
    loadSquareIntegrationStatus_({ silent: true });
    loadSquareLocations_({ silent: true });
  }

  function setMyProfileForm_(p) {
    const profile = p || {};
    if (qs("#myName")) qs("#myName").value = String(profile.name || "");
    if (qs("#myEmail")) qs("#myEmail").value = String(profile.email || "");
    if (qs("#myLoginEmail")) qs("#myLoginEmail").value = String(profile.login_email || "");
    if (qs("#myPhone")) qs("#myPhone").value = String(profile.phone || "");
    if (qs("#myBirthdate")) qs("#myBirthdate").value = toDateInputValue_(profile.birthdate);
    if (qs("#myQualifications")) qs("#myQualifications").value = String(profile.qualifications || "");
    if (qs("#myContractStartDate")) qs("#myContractStartDate").value = toDateInputValue_(profile.contract_start_date);
    if (qs("#myContractRenewalDate")) qs("#myContractRenewalDate").value = toDateInputValue_(profile.contract_renewal_date);
  }

  async function loadMyProfile_(opts = {}) {
    const host = qs("#myProfileResult");
    if (host) host.innerHTML = `<p class="p">プロフィールを読み込み中…</p>`;
    try {
      const runner = async () => {
        const idToken = getIdToken();
        return await getMyStaffProfileForSettings_(idToken);
      };
      const res = opts.blocking === false
        ? await runner()
        : await runWithBlocking_(
            {
              title: "プロフィールを読み込んでいます",
              bodyHtml: "設定情報を取得しています。",
              busyText: "読み込み中...",
            },
            runner
          );
      setMyProfileForm_(res && res.profile ? res.profile : {});
      if (host) host.innerHTML = "";
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">プロフィール取得に失敗しました。</div></div>`;
    }
  }

  qs("#btnSaveMyProfile")?.addEventListener("click", async () => {
    const idToken = getIdToken();
    const host = qs("#myProfileResult");
    const btn = qs("#btnSaveMyProfile");
    if (btn) btn.disabled = true;
    if (host) host.innerHTML = `<p class="p">保存中…</p>`;
    try {
      await runWithBlocking_(
        {
          title: "プロフィールを更新しています",
          bodyHtml: "プロフィール設定を保存しています。",
          busyText: "保存中...",
        },
        async () => {
          await updateMyStaffProfileForSettings_(idToken, {
            phone: val_("#myPhone"),
            birthdate: val_("#myBirthdate"),
            qualifications: val_("#myQualifications"),
          });
          await loadMyProfile_({ blocking: false });
        }
      );
      if (host) host.innerHTML = `<div class="card"><div class="p">プロフィールを保存しました。</div></div>`;
      toast({ title: "完了", message: "プロフィールを保存しました。" });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">プロフィール保存に失敗しました。</div></div>`;
      toast({ title: "保存失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  if (isPersonalArea) {
    loadMyProfile_();
  }

  let _billingRules = [];

  function makeBillingVariant_(src = {}) {
    return {
      price_rule_id: String(src.price_rule_id || ""),
      variant_name: String(src.variant_name || ""),
      duration_minutes: Number(src.duration_minutes || 0) || 0,
      amount: Number(src.amount || 0) || 0,
      seasonal_start_mmdd: String(src.seasonal_start_mmdd || ""),
      seasonal_end_mmdd: String(src.seasonal_end_mmdd || ""),
      display_order: Number(src.display_order || 0) || 0,
      is_active: src.is_active !== false
    };
  }

  function isMmdd_(v) {
    return /^\d{2}-\d{2}$/.test(String(v || "").trim());
  }

  function renderBillingVariants_(variants) {
    const host = qs("#billingRuleVariants");
    if (!host) return;
    const list = Array.isArray(variants) && variants.length ? variants : [makeBillingVariant_({ display_order: 100 })];
    host.innerHTML = list.map((v, idx) => `
      <div class="card settings-variant-card" data-variant-index="${idx}">
        <input type="hidden" data-field="price_rule_id" value="${escapeHtml(String(v.price_rule_id || ""))}" />
        <label class="field">
          <div class="label">バリエーション名</div>
          <input class="input" data-field="variant_name" type="text" value="${escapeHtml(String(v.variant_name || ""))}" placeholder="例：30分 / チキン味3kg" />
        </label>
        <label class="field">
          <div class="label">提供時間（分）</div>
          <input class="input" data-field="duration_minutes" type="number" min="0" step="1" value="${escapeHtml(String(v.duration_minutes || ""))}" />
        </label>
        <label class="field">
          <div class="label">金額 *</div>
          <input class="input" data-field="amount" type="number" min="0" step="1" value="${escapeHtml(String(v.amount || 0))}" />
        </label>
        <label class="field seasonal-range-field">
          <div class="label">繁忙期開始（MM-DD）</div>
          <input class="input" data-field="seasonal_start_mmdd" type="text" value="${escapeHtml(String(v.seasonal_start_mmdd || ""))}" placeholder="例：12-26" />
        </label>
        <label class="field seasonal-range-field">
          <div class="label">繁忙期終了（MM-DD）</div>
          <input class="input" data-field="seasonal_end_mmdd" type="text" value="${escapeHtml(String(v.seasonal_end_mmdd || ""))}" placeholder="例：01-04" />
        </label>
        <label class="field">
          <div class="label">表示順</div>
          <input class="input" data-field="display_order" type="number" min="0" step="1" value="${escapeHtml(String(v.display_order || 0))}" />
        </label>
        <div>
          <button class="btn btn-ghost" type="button" data-action="remove-billing-variant">この行を削除</button>
        </div>
      </div>
    `).join("");
    applyBillingRuleItemTypeState_();
  }

  function collectBillingVariants_() {
    const host = qs("#billingRuleVariants");
    if (!host) return [];
    return Array.from(host.querySelectorAll("[data-variant-index]")).map((row) => ({
      price_rule_id: String(row.querySelector('[data-field="price_rule_id"]')?.value || "").trim(),
      variant_name: String(row.querySelector('[data-field="variant_name"]')?.value || "").trim(),
      duration_minutes: Number(row.querySelector('[data-field="duration_minutes"]')?.value || 0) || 0,
      amount: Number(row.querySelector('[data-field="amount"]')?.value || 0) || 0,
      seasonal_start_mmdd: String(row.querySelector('[data-field="seasonal_start_mmdd"]')?.value || "").trim(),
      seasonal_end_mmdd: String(row.querySelector('[data-field="seasonal_end_mmdd"]')?.value || "").trim(),
      display_order: Number(row.querySelector('[data-field="display_order"]')?.value || 0) || 0,
      is_active: true
    }));
  }

  function groupBillingRules_(rules) {
    const map = new Map();
    (Array.isArray(rules) ? rules : []).forEach((rule) => {
      const groupId = String(rule?.product_group_id || rule?.price_rule_id || "").trim();
      if (!groupId) return;
      if (!map.has(groupId)) {
        map.set(groupId, {
          product_group_id: groupId,
          item_type: String(rule?.item_type || ""),
          product_name: String(rule?.product_name || rule?.label || ""),
          rules: []
        });
      }
      map.get(groupId).rules.push(rule);
    });
    return Array.from(map.values()).map((group) => {
      group.rules.sort((a, b) => (Number(a.display_order || 0) || 0) - (Number(b.display_order || 0) || 0));
      return group;
    }).sort((a, b) => String(a.product_name || "").localeCompare(String(b.product_name || ""), "ja"));
  }

  function setBillingRuleForm_(rule) {
    const r = rule || {};
    if (qs("#billingRuleId")) qs("#billingRuleId").value = String(r.price_rule_id || "");
    if (qs("#billingRuleGroupId")) qs("#billingRuleGroupId").value = String(r.product_group_id || "");
    if (qs("#billingRuleLabel")) qs("#billingRuleLabel").value = String(r.product_name || r.label || "");
    if (qs("#billingRuleItemType")) qs("#billingRuleItemType").value = String(r.item_type || "visit_base");
    if (qs("#billingRuleEffectiveFrom")) qs("#billingRuleEffectiveFrom").value = toDateInputValue_(r.effective_from);
    if (qs("#billingRuleEffectiveTo")) qs("#billingRuleEffectiveTo").value = toDateInputValue_(r.effective_to);
    if (qs("#billingRuleNote")) qs("#billingRuleNote").value = String(r.note || "");
    renderBillingVariants_([makeBillingVariant_(r)]);
  }

  function setBillingRuleGroupForm_(group) {
    const g = group || {};
    const head = Array.isArray(g.rules) && g.rules.length ? g.rules[0] : {};
    if (qs("#billingRuleId")) qs("#billingRuleId").value = "";
    if (qs("#billingRuleGroupId")) qs("#billingRuleGroupId").value = String(g.product_group_id || head.product_group_id || "");
    if (qs("#billingRuleLabel")) qs("#billingRuleLabel").value = String(g.product_name || head.product_name || head.label || "");
    if (qs("#billingRuleItemType")) qs("#billingRuleItemType").value = String(g.item_type || head.item_type || "visit_base");
    if (qs("#billingRuleEffectiveFrom")) qs("#billingRuleEffectiveFrom").value = toDateInputValue_(head.effective_from);
    if (qs("#billingRuleEffectiveTo")) qs("#billingRuleEffectiveTo").value = toDateInputValue_(head.effective_to);
    if (qs("#billingRuleNote")) qs("#billingRuleNote").value = String(head.note || "");
    renderBillingVariants_((g.rules || []).map(makeBillingVariant_));
  }

  function clearBillingRuleForm_() {
    if (qs("#billingRuleId")) qs("#billingRuleId").value = "";
    if (qs("#billingRuleGroupId")) qs("#billingRuleGroupId").value = "";
    if (qs("#billingRuleLabel")) qs("#billingRuleLabel").value = "";
    if (qs("#billingRuleItemType")) qs("#billingRuleItemType").value = "visit_base";
    if (qs("#billingRuleEffectiveFrom")) qs("#billingRuleEffectiveFrom").value = "";
    if (qs("#billingRuleEffectiveTo")) qs("#billingRuleEffectiveTo").value = "";
    if (qs("#billingRuleNote")) qs("#billingRuleNote").value = "";
    renderBillingVariants_([makeBillingVariant_({ display_order: 100 })]);
  }

  function applyBillingRuleItemTypeState_() {
    const itemType = val_("#billingRuleItemType");
    const isVisitBase = itemType === "visit_base";
    const isSeasonal = itemType === "seasonal_fee";
    qsa('#billingRuleVariants [data-field="duration_minutes"]').forEach((el) => {
      el.disabled = !isVisitBase;
      if (!isVisitBase) el.value = "";
    });
    qsa("#billingRuleVariants .seasonal-range-field").forEach((el) => {
      el.style.display = isSeasonal ? "" : "none";
    });
    qsa('#billingRuleVariants [data-field="seasonal_start_mmdd"], #billingRuleVariants [data-field="seasonal_end_mmdd"]').forEach((el) => {
      el.disabled = !isSeasonal;
      if (!isSeasonal) el.value = "";
    });
  }

  function renderBillingRulesList_() {
    const host = qs("#billingRulesList");
    if (!host) return;
    if (!_billingRules.length) {
      host.innerHTML = `<p class="p">料金ルールがありません。</p>`;
      return;
    }
    host.innerHTML = groupBillingRules_(_billingRules).map(billingRuleGroupHtml_).join("");
  }

  async function loadBillingRules_(opts = {}) {
    if (!isAdmin) return;
    const host = qs("#billingRulesResult");
    if (host && opts.silent !== true) host.innerHTML = `<p class="p">料金ルールを読み込み中…</p>`;
    try {
      const runner = async () => {
        const idToken = getIdToken();
        const res = await listBillingPriceRulesForSettings_(idToken, false);
        const results = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
        return results.slice().sort((a, b) => (Number(a.display_order || 0) || 0) - (Number(b.display_order || 0) || 0));
      };
      _billingRules = opts.blocking === false
        ? await runner()
        : await runWithBlocking_(
            {
              title: "料金ルールを読み込んでいます",
              bodyHtml: "BillingPriceRules の一覧を取得しています。",
              busyText: "読み込み中..."
            },
            runner
          );
      renderBillingRulesList_();
      if (host) host.innerHTML = "";
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">料金ルールの取得に失敗しました。</div></div>`;
    }
  }

  let _invoices = [];

  function renderInvoiceList_() {
    const host = qs("#invoiceList");
    if (!host) return;
    if (!_invoices.length) {
      host.innerHTML = `<p class="p">請求書がありません。</p>`;
      return;
    }
    host.innerHTML = _invoices.map(invoiceRowHtml_).join("");
  }

  async function loadInvoices_(opts = {}) {
    if (!isAdmin) return;
    const host = qs("#invoiceListResult");
    if (host && opts.silent !== true) host.innerHTML = `<p class="p">請求書を読み込み中…</p>`;
    try {
      const runner = async () => {
        const idToken = getIdToken();
        const res = await listBillingBatchesForSettings_(idToken);
        const results = Array.isArray(res?.batches) ? res.batches : (Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []));
        return results;
      };
      _invoices = opts.blocking === false
        ? await runner()
        : await runWithBlocking_(
            {
              title: "請求書を読み込んでいます",
              bodyHtml: "請求一覧を取得しています。",
              busyText: "読み込み中..."
            },
            runner
          );
      renderInvoiceList_();
      if (host) host.innerHTML = "";
    } catch (_) {
      if (host) host.innerHTML = `<div class="card"><div class="p">請求一覧の取得に失敗しました。</div></div>`;
    }
  }

  function setAdminStaffProfileForm_(p) {
    const profile = p || {};
    if (qs("#adminEditLoginEmail")) qs("#adminEditLoginEmail").value = String(profile.login_email || "");
    if (qs("#adminEditPhone")) qs("#adminEditPhone").value = String(profile.phone || "");
    if (qs("#adminEditBirthdate")) qs("#adminEditBirthdate").value = toDateInputValue_(profile.birthdate);
    if (qs("#adminEditContractStartDate")) qs("#adminEditContractStartDate").value = toDateInputValue_(profile.contract_start_date);
    if (qs("#adminEditContractRenewalDate")) qs("#adminEditContractRenewalDate").value = toDateInputValue_(profile.contract_renewal_date);
    if (qs("#adminEditContractEndDate")) qs("#adminEditContractEndDate").value = toDateInputValue_(profile.contract_end_date);
    if (qs("#adminEditPosition")) qs("#adminEditPosition").value = String(profile.position || "");
    if (qs("#adminEditQualifications")) qs("#adminEditQualifications").value = String(profile.qualifications || "");
  }

  function renderRetireResult_(html) {
    const host = qs("#adminRetireResult");
    if (host) host.innerHTML = html || "";
  }

  function fillRetireSuccessorOptions_(selectedStaffId) {
    const select = qs("#adminRetireToStaffId");
    if (!select) return;
    const sid = String(selectedStaffId || "").trim();
    const opts = ['<option value="">引継ぎ先を選択</option>'];
    _adminStaffList.forEach((s) => {
      const id = String((s && (s.staff_id || s.id)) || "").trim();
      const name = String((s && s.name) || id);
      if (!id || id === sid) return;
      opts.push(`<option value="${escapeHtml(id)}">${escapeHtml(`${name} (${id})`)}</option>`);
    });
    select.innerHTML = opts.join("");
  }

  async function loadAdminStaffList_() {
    const select = qs("#adminEditStaffId");
    if (!isAdmin || !select) return;
    try {
      const idToken = getIdToken();
      const staffs = await searchStaffsForSettings_(idToken);
      const list = Array.isArray(staffs) ? staffs : [];
      _adminStaffList = list;
      const opts = ['<option value="">スタッフを選択</option>'];
      list.forEach((s) => {
        const sid = String((s && (s.staff_id || s.id)) || "").trim();
        const sname = String((s && s.name) || sid);
        if (!sid) return;
        opts.push(`<option value="${escapeHtml(sid)}">${escapeHtml(`${sname} (${sid})`)}</option>`);
      });
      select.innerHTML = opts.join("");
      fillRetireSuccessorOptions_("");
    } catch (_) {}
  }

  async function loadAdminStaffProfile_(staffId, opts = {}) {
    const sid = String(staffId || "").trim();
    if (!sid) return;
    const host = qs("#adminStaffProfileResult");
    if (host) host.innerHTML = `<p class="p">スタッフ情報を読み込み中…</p>`;
    try {
      const runner = async () => {
        const idToken = getIdToken();
        return await getStaffProfileByIdForSettings_(idToken, sid);
      };
      const res = opts.blocking === false
        ? await runner()
        : await runWithBlocking_(
            {
              title: "スタッフ情報を読み込んでいます",
              bodyHtml: "選択したスタッフの設定情報を取得しています。",
              busyText: "読み込み中...",
            },
            runner
          );
      setAdminStaffProfileForm_(res && res.profile ? res.profile : {});
      if (host) host.innerHTML = "";
    } catch (_) {
      if (host) host.innerHTML = `<div class="card"><div class="p">スタッフ情報の取得に失敗しました。</div></div>`;
    }
  }

  qs("#adminEditStaffId")?.addEventListener("change", (ev) => {
    const sid = String(ev && ev.target && ev.target.value || "").trim();
    renderRetireResult_("");
    fillRetireSuccessorOptions_(sid);
    loadAdminStaffProfile_(sid);
  });

  qs("#btnSaveAdminStaffProfile")?.addEventListener("click", async () => {
    const sid = val_("#adminEditStaffId");
    const host = qs("#adminStaffProfileResult");
    const btn = qs("#btnSaveAdminStaffProfile");
    if (!sid) {
      toast({ title: "入力不足", message: "スタッフを選択してください。" });
      return;
    }
    if (btn) btn.disabled = true;
    if (host) host.innerHTML = `<p class="p">保存中…</p>`;
    try {
      const res = await runWithBlocking_(
        {
          title: "スタッフ情報を更新しています",
          bodyHtml: "選択したスタッフの設定情報を保存しています。",
          busyText: "保存中...",
        },
        async () => {
          const idToken = getIdToken();
          return await updateStaffProfileByIdForSettings_(idToken, {
            staff_id: sid,
            login_email: val_("#adminEditLoginEmail"),
            phone: val_("#adminEditPhone"),
            birthdate: val_("#adminEditBirthdate"),
            contract_start_date: val_("#adminEditContractStartDate"),
            contract_renewal_date: val_("#adminEditContractRenewalDate"),
            contract_end_date: val_("#adminEditContractEndDate"),
            position: val_("#adminEditPosition"),
            qualifications: val_("#adminEditQualifications"),
          });
        }
      );
      await loadAdminStaffProfile_(sid, { blocking: false });
      const warning = String((res && res.warning) || '').trim();
      if (host) host.innerHTML = `<div class="card"><div class="p">スタッフ情報を保存しました。</div>${warning ? `<div class="p settings-warning">${escapeHtml(warning)}</div>` : ''}</div>`;
      toast({ title: warning ? "保存完了(要確認)" : "完了", message: warning || "スタッフ情報を保存しました。" });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">スタッフ情報の保存に失敗しました。</div></div>`;
      toast({ title: "保存失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  qs("#btnResetBillingRuleForm")?.addEventListener("click", () => {
    clearBillingRuleForm_();
    applyBillingRuleItemTypeState_();
    const host = qs("#billingRulesResult");
    if (host) host.innerHTML = "";
  });

  qs("#billingRuleItemType")?.addEventListener("change", () => {
    applyBillingRuleItemTypeState_();
  });

  qs("#btnAddBillingVariant")?.addEventListener("click", () => {
    const variants = collectBillingVariants_();
    const nextOrder = variants.length ? Math.max(...variants.map((x) => Number(x.display_order || 0) || 0)) + 10 : 100;
    variants.push(makeBillingVariant_({ display_order: nextOrder }));
    renderBillingVariants_(variants);
  });

  qs("#billingRuleVariants")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest('button[data-action="remove-billing-variant"]');
    if (!btn) return;
    const row = btn.closest("[data-variant-index]");
    const idx = Number(row?.dataset?.variantIndex || -1);
    const variants = collectBillingVariants_();
    if (variants.length <= 1) {
      renderBillingVariants_([makeBillingVariant_({ display_order: 100 })]);
      return;
    }
    renderBillingVariants_(variants.filter((_, i) => i !== idx));
  });

  qs("#btnReloadBillingRules")?.addEventListener("click", async () => {
    await loadBillingRules_();
  });

  qs("#btnSaveBillingRule")?.addEventListener("click", async () => {
    const host = qs("#billingRulesResult");
    const btn = qs("#btnSaveBillingRule");
    const itemType = val_("#billingRuleItemType");
    const isVisitBase = itemType === "visit_base";
    const isSeasonal = itemType === "seasonal_fee";
    const variations = collectBillingVariants_().filter((x) => {
      if (itemType === "discount") return true;
      return x.variant_name || x.duration_minutes || x.amount;
    });
    const payload = {
      product_group_id: val_("#billingRuleGroupId"),
      product_name: val_("#billingRuleLabel"),
      item_type: itemType,
      variations: variations.map((x, idx) => ({
        price_rule_id: x.price_rule_id,
        variant_name: x.variant_name,
        duration_minutes: isVisitBase ? x.duration_minutes : 0,
        amount: x.amount,
        seasonal_start_mmdd: isSeasonal ? x.seasonal_start_mmdd : "",
        seasonal_end_mmdd: isSeasonal ? x.seasonal_end_mmdd : "",
        display_order: x.display_order || ((idx + 1) * 10),
        is_active: true
      })),
      unit: (itemType === "key_pickup_fee" || itemType === "key_return_fee" || itemType === "discount") ? "invoice" : "visit",
      apply_scope: (itemType === "key_pickup_fee" || itemType === "key_return_fee" || itemType === "discount") ? "invoice" : "visit",
      effective_from: val_("#billingRuleEffectiveFrom"),
      effective_to: val_("#billingRuleEffectiveTo"),
      note: val_("#billingRuleNote")
    };
    if (!payload.product_name || !payload.item_type) {
      toast({ title: "入力不足", message: "商品名と料金区分は必須です。" });
      return;
    }
    if (!payload.variations.length) {
      toast({ title: "入力不足", message: "少なくとも1つのバリエーションを入力してください。" });
      return;
    }
    if (payload.variations.some((x) => !(Number(x.amount || 0) >= 0))) {
      toast({ title: "入力不足", message: "金額を確認してください。" });
      return;
    }
    if (isVisitBase && payload.variations.some((x) => !(Number(x.duration_minutes || 0) > 0))) {
      toast({ title: "入力不足", message: "訪問基本料金では各バリエーションに提供時間を入力してください。" });
      return;
    }
    if (!isVisitBase && !isSeasonal && itemType !== "discount" && payload.variations.some((x) => !String(x.variant_name || "").trim())) {
      toast({ title: "入力不足", message: "訪問基本料金以外では各バリエーション名を入力してください。" });
      return;
    }
    if (isSeasonal && payload.variations.some((x) => !isMmdd_(x.seasonal_start_mmdd) || !isMmdd_(x.seasonal_end_mmdd))) {
      toast({ title: "入力不足", message: "繁忙期加算では各行に開始/終了（MM-DD）を入力してください。" });
      return;
    }
    if (btn) btn.disabled = true;
    if (host) host.innerHTML = `<p class="p">保存中…</p>`;
    try {
      const res = await runWithBlocking_(
        {
          title: "料金ルールを保存しています",
          bodyHtml: "BillingPriceRules を更新しています。",
          busyText: "保存中..."
        },
        async () => {
          const idToken = getIdToken();
          return await batchUpsertBillingPriceRulesForSettings_(idToken, payload);
        }
      );
      const savedRules = Array.isArray(res?.rules) ? res.rules : [];
      if (!savedRules.length) {
        throw new Error("保存対象の料金ルールがありません。入力内容を確認してください。");
      }
      clearBillingRuleForm_();
      applyBillingRuleItemTypeState_();
      await loadBillingRules_({ blocking: false, silent: true });
      if (host) host.innerHTML = `<div class="card"><div class="p">商品を保存しました。</div></div>`;
      toast({ title: "完了", message: `商品を保存しました。${String(res?.product_group_id || "")}`.trim() });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">商品の保存に失敗しました。</div></div>`;
      toast({ title: "保存失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  qs("#billingRulesList")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const action = String(btn.dataset.action || "");
    const priceRuleId = String(btn.dataset.priceRuleId || "").trim();
    if (!priceRuleId) return;

    if (action === "billing-rule-group-edit") {
      const group = groupBillingRules_(_billingRules).find((x) => String(x?.product_group_id || x?.rules?.[0]?.price_rule_id || "") === priceRuleId);
      if (group) {
        setBillingRuleGroupForm_(group);
        applyBillingRuleItemTypeState_();
      }
      return;
    }

    if (action === "billing-rule-toggle") {
      const host = qs("#billingRulesResult");
      try {
        const idToken = getIdToken();
        await runWithBlocking_(
          {
            title: "商品を更新しています",
            bodyHtml: "有効/無効を切り替えています。",
            busyText: "更新中..."
          },
          async () => {
            await toggleBillingPriceRuleForSettings_(idToken, {
              price_rule_id: priceRuleId,
              is_active: String(btn.dataset.nextActive || "") === "true"
            });
          }
        );
        await loadBillingRules_({ blocking: false, silent: true });
        if (host) host.innerHTML = `<div class="card"><div class="p">商品を更新しました。</div></div>`;
        toast({ title: "完了", message: "商品を更新しました。" });
      } catch (e) {
        if (host) host.innerHTML = `<div class="card"><div class="p">商品の更新に失敗しました。</div></div>`;
        toast({ title: "更新失敗", message: e?.message || String(e) });
      }
    }
  });

  qs("#btnReloadInvoices")?.addEventListener("click", async () => {
    await loadInvoices_();
  });

  qs("#invoiceList")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest('button[data-action="invoice-detail"]');
    if (!btn) return;
    const invoiceId = String(btn.dataset.invoiceId || "").trim();
    if (!invoiceId) return;
    const host = qs("#invoiceDetail");
    if (host) host.innerHTML = `<p class="p">請求書詳細を読み込み中…</p>`;
    try {
      const detail = await runWithBlocking_(
        {
          title: "請求書詳細を読み込んでいます",
          bodyHtml: "請求書の詳細を取得しています。",
          busyText: "読み込み中..."
        },
        async () => {
          const idToken = getIdToken();
          return await getBillingBatchDetailForSettings_(idToken, invoiceId);
        }
      );
      if (host) host.innerHTML = invoiceDetailHtml_(detail);
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">請求書詳細の取得に失敗しました。</div></div>`;
      toast({ title: "取得失敗", message: e?.message || String(e) });
    }
  });

  async function loadRetirePreview_(sid, retireAt) {
    renderRetireResult_(`<p class="p">退職影響を確認中…</p>`);
    const res = await runWithBlocking_(
      {
        title: "退職影響を確認しています",
        bodyHtml: "未来予約と担当関係を確認しています。",
        busyText: "確認中...",
      },
      async () => {
        const idToken = getIdToken();
        return await retireStaffPreviewForSettings_(idToken, { staff_id: sid, retire_at: retireAt });
      }
    );
    renderRetireResult_(renderRetirePreviewHtml_(res));
    return res;
  }

  qs("#btnRetireStaff")?.addEventListener("click", async () => {
    const sid = val_("#adminEditStaffId");
    const retireAt = toRetireIso_(val_("#adminRetireAt"));
    if (!sid || !retireAt) {
      toast({ title: "入力不足", message: "スタッフと退職日時を確認してください。" });
      return;
    }
    try {
      const preview = await loadRetirePreview_(sid, retireAt);
      let futureVisitAction = "";
      let toStaffId = "";
      if ((preview && preview.future_visit_count) > 0) {
        const choice = await showChoiceModal({
          title: "未来予約の対応確認",
          bodyHtml: `
            <div>退職日時以降の未来予約が <b>${escapeHtml(String(preview.future_visit_count || 0))} 件</b>あります。</div>
            <div class="settings-mt-8">引き継ぎますか？</div>
            <div class="settings-note-muted">「いいえ」を選ぶと、該当未来予約はキャンセルされます。</div>
          `,
          choices: [
            { value: "handover", label: "はい" },
            { value: "cancel", label: "いいえ", danger: true },
            { value: "abort", label: "中止", ghost: true }
          ]
        });
        if (choice === "abort" || !choice) return;
        if (choice === "handover") {
          toStaffId = val_("#adminRetireToStaffId");
          if (!toStaffId) {
            toast({ title: "入力不足", message: "引継ぎ先スタッフを選択してください。" });
            return;
          }
          futureVisitAction = "handover";
        } else {
          futureVisitAction = "cancel";
        }
      }
      await runWithBlocking_(
        {
          title: "退職処理を実行しています",
          bodyHtml: "退職影響確認、必要な引継ぎまたはキャンセル、ログイン停止を順に実行しています。",
          busyText: "退職処理中...",
        },
        async () => {
          const idToken = getIdToken();
          return await retireStaffFlowForSettings_(idToken, {
            staff_id: sid,
            retire_at: retireAt,
            future_visit_action: futureVisitAction,
            to_staff_id: toStaffId
          });
        }
      );
      renderRetireResult_(`<div class="card"><div class="p">退職処理が完了しました。</div></div>`);
      toast({ title: "完了", message: "退職処理が完了しました。" });
      await loadAdminStaffList_();
      const select = qs("#adminEditStaffId");
      if (select) select.value = "";
      setAdminStaffProfileForm_({});
    } catch (e) {
      const response = e && e.detail && e.detail.response;
      const preview = (response && response.preview) || (e && e.detail && e.detail.preview);
      if (preview && preview.future_visit_count > 0) {
        renderRetireResult_(renderRetirePreviewHtml_(preview));
      }
      const rollbackStatus = response && response.rollback_status;
      const msg = rollbackStatus === "completed"
        ? "途中失敗しましたが、変更はロールバックしました。"
        : (e?.message || String(e));
      toast({ title: "退職失敗", message: msg });
    }
  });

  async function loadNotifyQueueReadiness_(opts = {}) {
    if (!isAdmin) return;
    const host = qs("#notifyQueueResult");
    const btnReadiness = qs("#btnNotifyQueueReadiness");
    const btnRetry = qs("#btnNotifyQueueRetry");
    if (btnReadiness) btnReadiness.disabled = true;
    if (btnRetry) btnRetry.disabled = true;
    if (host && opts.silent !== true) host.innerHTML = `<p class="p">通知キュー状態を確認中…</p>`;
    try {
      const result = await runWithBlocking_(
        {
          title: "通知キュー状態を確認しています",
          bodyHtml: "pending/sent 件数を取得しています。",
          busyText: "確認中...",
        },
        async () => {
          const idToken = getIdToken();
          return await readinessNotifyQueueForSettings_(idToken, { limit: 30 });
        }
      );
      if (host) host.innerHTML = notifyQueueReadinessHtml_(result);
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">通知キュー状態の取得に失敗しました。</div></div>`;
      toast({ title: "取得失敗", message: e?.message || String(e) });
    } finally {
      if (btnReadiness) btnReadiness.disabled = false;
      if (btnRetry) btnRetry.disabled = false;
    }
  }

  qs("#btnNotifyQueueReadiness")?.addEventListener("click", async () => {
    await loadNotifyQueueReadiness_();
  });

  qs("#btnNotifyQueueRetry")?.addEventListener("click", async () => {
    const host = qs("#notifyQueueResult");
    const btnReadiness = qs("#btnNotifyQueueReadiness");
    const btnRetry = qs("#btnNotifyQueueRetry");
    const queueId = val_("#notifyQueueId");
    const rawLimit = Number(val_("#notifyQueueRetryLimit") || 10);
    const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 10));
    if (btnReadiness) btnReadiness.disabled = true;
    if (btnRetry) btnRetry.disabled = true;
    if (host) host.innerHTML = `<p class="p">通知再送を実行中…</p>`;
    try {
      const result = await runWithBlocking_(
        {
          title: "通知再送を実行しています",
          bodyHtml: queueId ? "指定 queue_id を再送しています。" : "pending 通知を再送しています。",
          busyText: "再送中...",
        },
        async () => {
          const idToken = getIdToken();
          return await retryNotifyQueueForSettings_(idToken, queueId ? { queue_id: queueId } : { limit });
        }
      );
      const processed = Number(result && result.processed || 0) || 0;
      const failed = Number(result && result.failed || 0) || 0;
      const retried = Number(result && result.retried || 0) || 0;
      if (host) host.innerHTML = `<div class="card"><div class="p">再送完了: processed=${escapeHtml(String(processed))} / retried=${escapeHtml(String(retried))} / failed=${escapeHtml(String(failed))}</div></div>`;
      toast({ title: failed ? "一部失敗" : "完了", message: failed ? `再送失敗が ${failed} 件あります。` : "通知再送が完了しました。" });
      await loadNotifyQueueReadiness_({ silent: true });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">通知再送に失敗しました。</div></div>`;
      toast({ title: "再送失敗", message: e?.message || String(e) });
    } finally {
      if (btnReadiness) btnReadiness.disabled = false;
      if (btnRetry) btnRetry.disabled = false;
    }
  });

  if (isAdmin && isBusinessArea && businessPage === "store_detail") {
    const storeDetail = qs("#storeDetailSection");
    const staffAdd = qs("#staffAddSection");
    const staffEdit = qs("#staffEditSection");
    const pricing = qs("#pricingSection");
    if (storeDetail && staffAdd) {
      const parent = storeDetail.parentElement;
      if (parent) {
        parent.insertBefore(storeDetail, staffAdd);
        if (staffEdit) parent.insertBefore(staffEdit, pricing || null);
      }
    }
    loadAdminStaffList_();
    clearBillingRuleForm_();
    applyBillingRuleItemTypeState_();
    loadBillingRules_({ blocking: false, silent: true });
  }
}
