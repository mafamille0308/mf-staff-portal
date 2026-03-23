// js/pages/settings.js
import { render, toast, escapeHtml, qs, qsa, showChoiceModal } from "../ui.js";
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
  syncCalendarOneForSettings_,
  syncCalendarAllForSettings_,
} from "./settings_staff_policy.js";
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
    <div class="card" style="margin-top:10px; border-color: rgba(255,92,92,0.35);">
      <div class="p"><b>error_code</b>: ${escapeHtml(c)}</div>
      <ol style="margin:8px 0 0 18px;">${steps.map((s) => `<li>${escapeHtml(String(s))}</li>`).join("")}</ol>
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
    <div class="card" style="margin-top:10px;">
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
    ? `<div class="card" style="margin-top:10px;"><div class="p"><b>未来予約</b></div><div style="margin-top:8px; display:grid; gap:6px;">${visits.slice(0, 10).map((v) => `<div class="hint-row"><div class="muted">${escapeHtml(String(v.start_time || "").replace("T", " ").replace("+09:00", ""))}</div><div>${escapeHtml(`${String(v.title || v.visit_id || "")} / ${String(v.customer_id || "")}`)}</div></div>`).join("")}${visits.length > 10 ? `<div class="p">ほか ${visits.length - 10} 件</div>` : ""}</div></div>`
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
    <div class="card" style="margin-top:8px;">
      <div class="p">
        <div class="row row-between" style="gap:12px; align-items:flex-start; flex-wrap:wrap;">
          <div>
            <div><strong>${escapeHtml(String(r.label || "-"))}</strong> <span class="badge">${escapeHtml(billingRuleItemTypeLabel_(r.item_type))}</span> ${active ? `<span class="badge badge-ok">有効</span>` : `<span class="badge badge-danger">無効</span>`}</div>
            <div style="opacity:.8; margin-top:4px;">${escapeHtml(visitBits || "-")}</div>
            <div style="opacity:.8; margin-top:4px;">金額: ${escapeHtml(formatMoney_(r.amount))}円 / 商品ID: ${escapeHtml(priceRuleId || "-")}</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
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
    <div class="card" style="margin-top:8px;">
      <div class="p">
        <div class="row row-between" style="gap:12px; align-items:flex-start; flex-wrap:wrap;">
          <div>
            <div><strong>${escapeHtml(String(g.product_name || head.label || "-"))}</strong> <span class="badge">${escapeHtml(billingRuleItemTypeLabel_(g.item_type || head.item_type))}</span> ${active ? `<span class="badge badge-ok">有効</span>` : `<span class="badge badge-danger">無効</span>`}</div>
            <div style="opacity:.8; margin-top:4px;">商品グループID: ${escapeHtml(String(g.product_group_id || head.price_rule_id || "-"))}</div>
            <div style="opacity:.8; margin-top:6px; display:grid; gap:4px;">
              ${rules.map((r) => {
                const seasonalRange = (r.seasonal_start_mmdd && r.seasonal_end_mmdd)
                  ? ` / ${String(r.seasonal_start_mmdd)}〜${String(r.seasonal_end_mmdd)}`
                  : "";
                return `<div>${escapeHtml(String(r.variant_name || (r.duration_minutes ? `${r.duration_minutes}分` : r.label || "-")))} / ${escapeHtml(formatMoney_(r.amount))}円${r.duration_minutes ? ` / ${escapeHtml(String(r.duration_minutes))}分` : ``}${escapeHtml(seasonalRange)}</div>`;
              }).join("")}
            </div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
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

function invoiceRowHtml_(invoice) {
  const x = invoice || {};
  return `
    <div class="card" style="margin-top:8px;">
      <div class="p">
        <div class="row row-between" style="gap:12px; align-items:flex-start; flex-wrap:wrap;">
          <div>
            <div><strong>${escapeHtml(String(x.batch_id || "-"))}</strong> <span class="badge">${escapeHtml(invoiceStatusLabel_(x.batch_status))}</span></div>
            <div style="opacity:.8; margin-top:4px;">${escapeHtml(String(x.customer_name || "-"))}</div>
            <div style="opacity:.8; margin-top:4px;">Square: ${escapeHtml(String(x.square_invoice_status || x.square_invoice_id || "-"))}</div>
            <div style="opacity:.8; margin-top:4px;">${escapeHtml(String(x.memo || "-"))}</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
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
        <div style="margin-top:6px;">顧客: ${escapeHtml(String(invoice.customer_name || "-"))}</div>
        <div style="margin-top:6px;">Square Invoice ID: ${escapeHtml(String(invoice.square_invoice_id || "-"))}</div>
        <div style="margin-top:6px;">Square Status: ${escapeHtml(String(invoice.square_invoice_status || "-"))}</div>
        <div style="margin-top:6px;">メモ: ${escapeHtml(String(invoice.memo || "-"))}</div>
      </div>
    </div>
    <div class="card" style="margin-top:8px;">
      <div class="p">
        <div><strong>対象予約</strong></div>
        <div style="margin-top:8px; display:grid; gap:8px;">
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

export async function renderSettings(app, query) {
  const role = getRole_();
  const isAdmin = role === "admin";
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
      <p class="p">${isAdmin ? "スタッフ管理とプロフィール設定を行います。" : "プロフィール設定を行います。"}</p>
      <style>
        .settings-grid { gap: 12px !important; }
        .settings-actions { margin-top: 14px !important; }
        .settings-grid .field { display: block; margin-bottom: 10px; }
        .settings-grid .label { display: block; margin-bottom: 6px; }
        .settings-readonly,
        .settings-readonly:disabled {
          background: #1a2538 !important;
          color: #9fb3cc !important;
          -webkit-text-fill-color: #9fb3cc !important;
          border-color: #2a3b56 !important;
          opacity: 1 !important;
          cursor: not-allowed !important;
        }
      </style>

      <div class="hr"></div>

      ${isAdmin ? `<details class="card">
        <summary class="p" style="cursor:pointer; font-weight:600;">スタッフ追加</summary>
        <p class="p">新規スタッフ作成、スタッフ用カレンダー作成・共有を実行します。</p>

        <div class="grid settings-grid" style="gap:12px;">
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

        <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button id="btnCreateStaff" class="btn" type="button">スタッフを追加</button>
        </div>

        <div id="staffCreateResult" style="margin-top:12px;"></div>
      </details>` : ""}

      <details class="card" style="margin-top:12px;" ${isAdmin ? "" : "open"}>
        <summary class="p" style="cursor:pointer; font-weight:600;">プロフィール設定</summary>
        <p class="p">自分の登録情報を編集できます。</p>
        <div class="grid settings-grid" style="gap:12px;">
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
        <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button id="btnSaveMyProfile" class="btn" type="button">プロフィールを更新</button>
        </div>
        <div id="myProfileResult" style="margin-top:12px;"></div>
      </details>

      ${isAdmin ? `<details class="card" style="margin-top:12px;">
        <summary class="p" style="cursor:pointer; font-weight:600;">スタッフ情報閲覧・編集</summary>
        <p class="p">スタッフの登録情報閲覧と編集ができます。</p>
        <div class="grid settings-grid" style="gap:12px;">
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
        <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button id="btnSaveAdminStaffProfile" class="btn" type="button">スタッフ情報を更新</button>
        </div>
        <div id="adminStaffProfileResult" style="margin-top:12px;"></div>

        <div class="hr"></div>
        <details style="margin-top:12px;">
          <summary class="p" style="cursor:pointer; font-weight:600;">退職処理</summary>
          <p class="p">退職前に、未来予約と担当関係の引継ぎ状況を確認します。</p>
          <div class="grid settings-grid" style="gap:12px;">
            <label class="field">
              <div class="label">退職日</div>
              <input id="adminRetireAt" class="input" type="date" />
            </label>
            <label class="field">
              <div class="label">引継ぎ先スタッフ（引継ぎ時のみ）</div>
              <select id="adminRetireToStaffId" class="select"></select>
            </label>
          </div>
          <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
            <button id="btnRetireStaff" class="btn" type="button">退職を確定</button>
          </div>
          <div id="adminRetireResult" style="margin-top:12px;"></div>
        </details>
      </details>` : ""}

      ${isAdmin ? `<details class="card" style="margin-top:12px;">
        <summary class="p" style="cursor:pointer; font-weight:600;">料金マスタ管理</summary>
        <p class="p">請求計算に使う商品を管理します。</p>
        <div class="grid settings-grid" style="gap:12px;">
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
            <div id="billingRuleVariants" style="display:grid; gap:8px;"></div>
            <div style="margin-top:8px;">
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
        <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button id="btnSaveBillingRule" class="btn" type="button">商品を保存</button>
          <button id="btnResetBillingRuleForm" class="btn btn-ghost" type="button">入力をクリア</button>
          <button id="btnReloadBillingRules" class="btn btn-ghost" type="button">一覧更新</button>
        </div>
        <div id="billingRulesResult" style="margin-top:12px;"></div>
        <div id="billingRulesList" style="margin-top:12px;"></div>
      </details>` : ""}

      ${isAdmin ? `<div class="card" style="margin-top:12px;">
        <div class="p"><strong>請求書</strong></div>
        <div class="p">請求書の状態を確認します。</div>
        <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <a class="btn" href="#/invoices">請求ページを開く</a>
        </div>
      </div>` : ""}

      ${isAdmin ? `<details class="card" style="margin-top:12px;">
        <summary class="p" style="cursor:pointer; font-weight:600;">カレンダー再同期</summary>
        <p class="p">Google Calendar と visits の差分を手動で同期します。</p>
        <div class="grid settings-grid" style="gap:12px;">
          <label class="field">
            <div class="label">visit_id（任意）</div>
            <input id="calendarSyncVisitId" class="input" type="text" placeholder="例: V000123" />
          </label>
          <label class="field">
            <div class="label">calendar_id（任意）</div>
            <input id="calendarSyncCalendarId" class="input" type="text" placeholder="例: xxxx@group.calendar.google.com" />
          </label>
        </div>
        <div class="settings-actions" style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button id="btnCalendarSyncOne" class="btn" type="button">単体再同期</button>
          <button id="btnCalendarSyncAll" class="btn btn-ghost" type="button">全体再同期</button>
        </div>
        <div id="calendarSyncResult" style="margin-top:12px;"></div>
      </details>` : ""}
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
    const org_id = String(user.org_id || "").trim();
    const role = "staff";

    if (!name || !email || !login_email) {
      toast({ title: "入力不足", message: "必須項目（氏名 / email / login_email）を入力してください。" });
      return;
    }
    if (!org_id) {
      toast({ title: "設定不足", message: "ログイン中管理者の org_id が取得できません。再ログイン後に再実行してください。" });
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
            org_id,
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
        ? `<div class="card" style="margin-top:10px;"><div class="p"><b>注意</b><br>${escapeHtml(String(res.warning))}</div></div>`
        : "";

      if (host) {
        if (isSuccess) {
          host.innerHTML = `
            <div class="card">
              <div class="p"><b>作成完了</b></div>
              <ol style="margin:8px 0 8px 0px;">
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

  loadMyProfile_();

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
      <div class="card" data-variant-index="${idx}" style="display:grid; gap:8px;">
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
      if (host) host.innerHTML = `<div class="card"><div class="p">スタッフ情報を保存しました。</div>${warning ? `<div class="p" style="color:var(--danger);">${escapeHtml(warning)}</div>` : ''}</div>`;
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
            <div style="margin-top:8px;">引き継ぎますか？</div>
            <div style="margin-top:8px; color: var(--muted);">「いいえ」を選ぶと、該当未来予約はキャンセルされます。</div>
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

  qs("#btnCalendarSyncOne")?.addEventListener("click", async () => {
    const host = qs("#calendarSyncResult");
    const btnOne = qs("#btnCalendarSyncOne");
    const btnAll = qs("#btnCalendarSyncAll");
    const visitId = val_("#calendarSyncVisitId");
    const calendarId = val_("#calendarSyncCalendarId");
    if (!visitId && !calendarId) {
      toast({ title: "入力不足", message: "visit_id または calendar_id を入力してください。" });
      return;
    }
    if (btnOne) btnOne.disabled = true;
    if (btnAll) btnAll.disabled = true;
    if (host) host.innerHTML = `<p class="p">再同期を実行中…</p>`;
    try {
      const out = await runWithBlocking_(
        {
          title: "カレンダー再同期を実行しています",
          bodyHtml: "指定対象の差分同期を実行しています。",
          busyText: "同期中...",
        },
        async () => {
          const idToken = getIdToken();
          return await syncCalendarOneForSettings_(idToken, {
            visit_id: visitId || undefined,
            calendar_id: calendarId || undefined,
          });
        }
      );
      const synced = Number(out && out.synced || 0) || 0;
      const failed = Number(out && out.failed || 0) || 0;
      if (host) host.innerHTML = `<div class="card"><div class="p">単体再同期が完了しました。成功: ${escapeHtml(String(synced))} / 失敗: ${escapeHtml(String(failed))}</div></div>`;
      toast({ title: failed ? "一部失敗" : "完了", message: failed ? `再同期で失敗が ${failed} 件あります。` : "再同期が完了しました。" });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">単体再同期に失敗しました。</div></div>`;
      toast({ title: "再同期失敗", message: e?.message || String(e) });
    } finally {
      if (btnOne) btnOne.disabled = false;
      if (btnAll) btnAll.disabled = false;
    }
  });

  qs("#btnCalendarSyncAll")?.addEventListener("click", async () => {
    const host = qs("#calendarSyncResult");
    const btnOne = qs("#btnCalendarSyncOne");
    const btnAll = qs("#btnCalendarSyncAll");
    if (btnOne) btnOne.disabled = true;
    if (btnAll) btnAll.disabled = true;
    if (host) host.innerHTML = `<p class="p">全体再同期を実行中…</p>`;
    try {
      const out = await runWithBlocking_(
        {
          title: "全体再同期を実行しています",
          bodyHtml: "active スタッフのカレンダーを順次同期しています。",
          busyText: "同期中...",
        },
        async () => {
          const idToken = getIdToken();
          return await syncCalendarAllForSettings_(idToken, {});
        }
      );
      const synced = Number(out && out.synced || 0) || 0;
      const failed = Number(out && out.failed || 0) || 0;
      const total = Number(out && out.total || 0) || 0;
      if (host) host.innerHTML = `<div class="card"><div class="p">全体再同期が完了しました。対象: ${escapeHtml(String(total))} / 成功: ${escapeHtml(String(synced))} / 失敗: ${escapeHtml(String(failed))}</div></div>`;
      toast({ title: failed ? "一部失敗" : "完了", message: failed ? `再同期で失敗が ${failed} 件あります。` : "全体再同期が完了しました。" });
    } catch (e) {
      if (host) host.innerHTML = `<div class="card"><div class="p">全体再同期に失敗しました。</div></div>`;
      toast({ title: "再同期失敗", message: e?.message || String(e) });
    } finally {
      if (btnOne) btnOne.disabled = false;
      if (btnAll) btnAll.disabled = false;
    }
  });

  loadAdminStaffList_();
  clearBillingRuleForm_();
  applyBillingRuleItemTypeState_();
  loadBillingRules_({ blocking: false, silent: true });
  loadInvoices_({ blocking: false, silent: true });
}
