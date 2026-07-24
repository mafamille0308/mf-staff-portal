import { render, qs, escapeHtml, toast, showFormModal } from "../ui.js";
import { getIdToken, getUser } from "../auth.js";
import { portalVisitsList_ } from "./portal_api.js";
import {
  fetchBillingBatchesPolicy_,
  fetchBillingBatchDetailPolicy_,
  revertBillingBatchToUnbilledPolicy_,
  setBillingBatchRefundFollowupPolicy_,
  fetchPricePreviewPolicy_,
  fetchAllPriceRulesPolicy_,
  updateBillingBatchItemsPolicy_,
} from "./invoices_policy.js";
import { isSelectablePriceRule_ } from "./billing_price_rules_policy.js";
import { runWithBlocking_ } from "./page_async_helpers.js";
import { formatMoney_ } from "./page_format_helpers.js";
import {
  openEditorModal_,
  confirmByModal_,
  pickRuleByModal_,
  inputAmountByModal_,
  pickMerchandiseByModal_,
} from "./invoices_editor_modal.js";

const BILLING_STATUS_KEYS = ["unbilled", "draft", "billed", "paid"];
const KEY_PENDING_INVOICE_REBUILD = "mf:pending_invoice_rebuild:v1";
const KEY_VF_STATE = "mf:visits_list:state:v1";

function withIdToken_(fn) {
  return fn(getIdToken());
}

function billingStatusLabel_(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "unbilled") return "未請求";
  if (s === "draft" || s === "invoice_draft" || s === "pending" || s === "unpaid") return "下書き";
  if (s === "billed" || s === "invoicing" || s === "invoiced" || s === "sent" || s === "scheduled") return "請求済";
  if (s === "paid") return "入金済";
  return s || "-";
}

function billingStatusBadgeClass_(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") return "badge badge-success";
  if (s === "draft" || s === "invoice_draft" || s === "pending" || s === "unpaid") return "badge badge-info";
  if (s === "billed" || s === "invoicing" || s === "invoiced" || s === "sent" || s === "scheduled") return "badge badge-warning";
  return "badge badge-info";
}

function withCustomerHonorific_(name) {
  const s = String(name || "").trim();
  if (!s || s === "-" || s === "—") return "";
  if (/\s*様$/.test(s)) return s;
  return `${s} 様`;
}

function actionIconSvg_(name) {
  if (name === "back") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  }
  return "";
}

function normalizeRefundFollowupStatus_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (["required", "not_required", "refunded_partial", "refunded_full"].includes(s)) return s;
  return "";
}

function deriveRefundFollowupStatus_(batch, options = {}) {
  const b = batch || {};
  const explicit = normalizeRefundFollowupStatus_(b.refund_followup_status || b.refund_state);
  if (explicit) return explicit;
  const squareStatus = String(b.square_invoice_status || "").trim().toLowerCase();
  const refundDetectedByStatus = (squareStatus === "refunded" || squareStatus === "partially_refunded");
  const refundDetected = !!b.refund_detected || refundDetectedByStatus;
  const refundKindRaw = String(b.refund_kind || "").trim().toLowerCase();
  const refundKind = refundKindRaw || (squareStatus === "partially_refunded" ? "partial" : (squareStatus === "refunded" ? "full" : ""));
  if (refundDetected) return refundKind === "partial" ? "refunded_partial" : "refunded_full";
  const billingStatus = String(b.billing_status || b.invoice_status || "").trim().toLowerCase();
  const hasInactiveLinkedVisit = options.hasInactiveLinkedVisit === true || options.has_inactive_linked_visit === true;
  if (billingStatus === "paid" && hasInactiveLinkedVisit) return "required";
  return "";
}

function refundFollowupLabel_(status) {
  const s = normalizeRefundFollowupStatus_(status);
  if (s === "required") return "要返金確認";
  if (s === "not_required") return "返金不要（確認済み）";
  if (s === "refunded_partial") return "一部返金済み";
  if (s === "refunded_full") return "全額返金済み";
  return "";
}

function refundFollowupBadgeClass_(status) {
  const s = normalizeRefundFollowupStatus_(status);
  if (s === "required") return "badge badge-danger";
  if (s === "refunded_partial") return "badge badge-warning";
  if (s === "refunded_full") return "badge badge-success";
  if (s === "not_required") return "badge badge-info";
  return "badge badge-info";
}

function isSquareDraftLikeStatus_(value) {
  const s = String(value || "").trim().toLowerCase();
  return s === "draft" || s === "pending" || s === "unpaid";
}

function canDeleteBillingBatch_(batch) {
  const b = batch || {};
  const billingStatus = String(b.billing_status || b.invoice_status || "").trim().toLowerCase();
  const squareStatus = String(b.square_invoice_status || "").trim().toLowerCase();
  if (billingStatus === "paid" || ["paid", "partially_paid", "refunded", "partially_refunded"].includes(squareStatus)) return false;
  return ["draft", "billed"].includes(billingStatus)
    || ["draft", "pending", "unpaid", "sent", "scheduled", "invoicing", "invoiced", "published"].includes(squareStatus);
}

function formatVisitSummaryDate_(startTime, visitDate) {
  const raw = String(startTime || visitDate || "").trim();
  if (!raw) return "-";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ms));
  const pick = (type) => (parts.find((x) => x.type === type) || {}).value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")}（${pick("weekday")}）${pick("hour")}:${pick("minute")}`;
}

function formatVisitDetailDateTime_(v) {
  const raw = String(v || "").trim();
  if (!raw) return "-";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ms));
  const pick = (type) => (parts.find((x) => x.type === type) || {}).value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function formatDateYmd_(v) {
  const raw = String(v || "").trim();
  if (!raw) return "-";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(ms));
  const pick = (type) => (parts.find((x) => x.type === type) || {}).value || "";
  return `${pick("year")}/${pick("month")}/${pick("day")}`;
}

function toYmd_(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeVisitBillingStatus_(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "unbilled";
  if (s === "unbilled" || s === "cancelled" || s === "canceled" || s === "voided" || s === "refunded") return "unbilled";
  if (s === "paid") return "paid";
  if (s === "draft" || s === "invoice_draft" || s === "pending" || s === "unpaid") return "draft";
  return "billed";
}

async function fetchAttachableVisits_(customerId, linkedVisitIds) {
  const cid = String(customerId || "").trim();
  if (!cid) return [];
  const linkedSet = new Set((Array.isArray(linkedVisitIds) ? linkedVisitIds : []).map((x) => String(x || "").trim()).filter(Boolean));
  const res = await withIdToken_((token) => portalVisitsList_(token, {
    customer_id: cid,
    only_active: true,
    with_badges: false,
  }));
  const rows = Array.isArray(res?.visits)
    ? res.visits
    : (Array.isArray(res?.results) ? res.results : []);
  return rows
    .filter((row) => {
      const vid = String(row?.visit_id || "").trim();
      if (!vid || linkedSet.has(vid)) return false;
      if (String(row?.customer_id || "").trim() !== cid) return false;
      if (row?.is_active === false) return false;
      return normalizeVisitBillingStatus_(row?.billing_status) === "unbilled";
    })
    .sort((a, b) => {
      const at = Date.parse(String(a?.start_time || "")) || 0;
      const bt = Date.parse(String(b?.start_time || "")) || 0;
      if (at !== bt) return at - bt;
      return String(a?.visit_id || "").localeCompare(String(b?.visit_id || ""));
    });
}

function buildAttachVisitPickerHtml_(visits) {
  const rows = Array.isArray(visits) ? visits : [];
  return `
    <form data-el="attachVisitsForm">
      <p class="p">既存請求書に追加する未請求予約を選択してください。</p>
      <div style="max-height:42vh; overflow:auto; margin-top:8px; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:8px;">
        ${rows.map((row) => {
          const vid = String(row?.visit_id || "").trim();
          const title = String(row?.title || vid || "-").trim();
          const start = formatVisitSummaryDate_(row?.start_time, row?.start_time);
          return `
            <label style="display:flex; gap:8px; align-items:flex-start; padding:8px 4px; border-bottom:1px solid rgba(255,255,255,0.06);">
              <input type="checkbox" name="attach__${escapeHtml(vid)}" />
              <span>
                <strong>${escapeHtml(title)}</strong>
                <div style="opacity:.82; margin-top:2px;">${escapeHtml(start)} / ${escapeHtml(vid)}</div>
              </span>
            </label>
          `;
        }).join("")}
      </div>
    </form>
  `;
}

async function fetchBillingBatches_(filters) {
  return withIdToken_((token) => fetchBillingBatchesPolicy_(token, filters));
}

async function fetchBillingBatchDetail_(batchId) {
  return withIdToken_((token) => fetchBillingBatchDetailPolicy_(token, batchId));
}

async function revertBillingBatchToUnbilled_(batchId) {
  return withIdToken_((token) => revertBillingBatchToUnbilledPolicy_(token, batchId));
}

async function setBillingBatchRefundFollowup_(payload) {
  return withIdToken_((token) => setBillingBatchRefundFollowupPolicy_(token, payload));
}

function enqueuePendingInvoiceRebuild_(payload) {
  try {
    sessionStorage.setItem(KEY_PENDING_INVOICE_REBUILD, JSON.stringify(payload || {}));
  } catch (_) {}
}

async function fetchPricePreview_(priceRuleId, visitDate) {
  return withIdToken_((token) => fetchPricePreviewPolicy_(token, priceRuleId, visitDate));
}

async function fetchAllPriceRules_() {
  return withIdToken_((token) => fetchAllPriceRulesPolicy_(token));
}

async function updateBillingBatchItems_(payload) {
  return withIdToken_((token) => updateBillingBatchItemsPolicy_(token, payload));
}

function renderBillingListCard_(b) {
  const x = b || {};
  const periodStart = x.period_start ? formatDateYmd_(x.period_start) : "-";
  const periodEnd = x.period_end ? formatDateYmd_(x.period_end) : "-";
  const customerLabel = withCustomerHonorific_(x.customer_name);
  const refundFollowupStatus = deriveRefundFollowupStatus_(x, {
    has_inactive_linked_visit: x.has_inactive_linked_visit === true,
  });
  const refundFollowupLabel = refundFollowupLabel_(refundFollowupStatus);
  const hasInactiveLinkedVisit = x.has_inactive_linked_visit === true || String(x.has_inactive_linked_visit || "").toLowerCase() === "true";
  const hasPaidTimeChangedVisit = x.has_paid_time_changed_visit === true || String(x.has_paid_time_changed_visit || "").toLowerCase() === "true";
  const showDeleteButton = canDeleteBillingBatch_(x);
  return `
    <div class="card invoice-batch-row">
      <div class="p invoice-batch-body">
        <div class="row row-between" style="gap:8px;">
          <strong class="invoice-batch-customer">${escapeHtml(customerLabel || "-")}</strong>
          <div class="row" style="gap:6px;">
            <span class="${escapeHtml(billingStatusBadgeClass_(x.billing_status))}">${escapeHtml(billingStatusLabel_(x.billing_status))}</span>
            ${hasInactiveLinkedVisit ? `<span class="badge badge-warning">キャンセル済み予約あり</span>` : ``}
            ${hasPaidTimeChangedVisit ? `<span class="badge badge-warning">支払後日時変更あり</span>` : ``}
            ${refundFollowupLabel ? `<span class="${refundFollowupBadgeClass_(refundFollowupStatus)}">${escapeHtml(refundFollowupLabel)}</span>` : ``}
          </div>
        </div>
        <div class="invoice-batch-meta" style="opacity:.85; margin-top:6px;">請求期間: ${escapeHtml(periodStart)} 〜 ${escapeHtml(periodEnd)}（${escapeHtml(String(x.visit_count || 0))}回）</div>
        <div class="invoice-batch-meta" style="opacity:.85; margin-top:6px;">合計金額: ${escapeHtml(formatMoney_(x.total_amount || 0))}円</div>
        <div class="invoice-batch-meta" style="opacity:.85; margin-top:6px;">Square請求書ID: ${escapeHtml(String(x.square_invoice_id || "-"))}</div>
        <div class="row" style="gap:8px; margin-top:10px; justify-content:flex-end;">
          <button class="btn btn-ghost" type="button" data-action="open-detail" data-batch-id="${escapeHtml(String(x.batch_id || ""))}">詳細</button>
          ${showDeleteButton ? `<button class="btn btn-ghost" type="button" data-action="revert-unbilled" data-batch-id="${escapeHtml(String(x.batch_id || ""))}">削除</button>` : ``}
        </div>
      </div>
    </div>
  `;
}

async function renderInvoicesListPage_(app, query) {
  let billingStatus = String(query.get("status") || "").trim().toLowerCase();
  if (!BILLING_STATUS_KEYS.includes(billingStatus)) billingStatus = "";
  let keyword = String(query.get("q") || "").trim();
  let keywordTimer = null;
  let rows = [];
  render(app, `<section class="section"><p class="p">請求一覧を読み込み中…</p></section>`);
  try {
    rows = await runWithBlocking_(
      { title: "請求一覧を読み込んでいます", bodyHtml: "一覧を取得しています。", busyText: "読み込み中..." },
      async () => fetchBillingBatches_({ billing_status: billingStatus, query: keyword })
    );
  } catch (e) {
    render(app, `<section class="section"><h1 class="h1">請求一覧</h1><p class="p">${escapeHtml(e?.message || String(e))}</p></section>`);
    return;
  }

  async function deleteBillingBatchFromList_(batchId) {
    const ok = await confirmByModal_(
      "請求書を削除",
      "この請求を削除し、対象予約の請求状態を更新します。この操作は、Square請求書の削除を実行しますが、予約自体はキャンセルされません。",
      "削除する",
      "キャンセル"
    );
    if (!ok) return;
    await runWithBlocking_(
      { title: "請求書を削除しています", bodyHtml: "Square請求書とポータル側の請求データを更新しています...", busyText: "削除中..." },
      async () => revertBillingBatchToUnbilled_(batchId)
    );
    rows = await fetchBillingBatches_({ billing_status: billingStatus, query: keyword });
    toast({ title: "完了", message: "請求書を削除しました。" });
    renderPage_();
  }

  function getFilteredRows_() {
    return rows.filter((x) => {
      const text = [
        String(x?.customer_name || ""),
        String(x?.square_invoice_id || ""),
        String(x?.memo || "")
      ].join(" ").toLowerCase();
      return !keyword || text.includes(keyword.toLowerCase());
    });
  }

  function renderFilteredList_() {
    const filtered = getFilteredRows_();
    const countEl = qs("#invoiceBatchCount");
    if (countEl) countEl.textContent = `表示件数: ${String(filtered.length)}`;
    const listEl = qs("#invoiceBatchList");
    if (listEl) listEl.innerHTML = filtered.map(renderBillingListCard_).join("") || `<div class="p">条件に一致する請求書がありません。</div>`;
  }

  async function refetchAndRenderList_() {
    rows = await fetchBillingBatches_({ billing_status: billingStatus, query: keyword });
    renderFilteredList_();
  }

  function renderPage_() {
    const filtered = getFilteredRows_();
    render(app, `
      <section class="section">
        <h1 class="h1">請求一覧</h1>
        <div class="edit-grid" style="margin-top:10px;">
          <label>
            <div class="label-sm">検索</div>
            <input id="invoiceFilterKeyword" class="input" type="text" value="${escapeHtml(keyword)}" placeholder="顧客名 / Square請求書ID" />
          </label>
          <label>
            <div class="label-sm">ステータス</div>
            <select id="invoiceFilterStatus" class="input">
              <option value="" ${billingStatus ? "" : "selected"}>すべて</option>
              <option value="unbilled" ${billingStatus === "unbilled" ? "selected" : ""}>未請求</option>
              <option value="draft" ${billingStatus === "draft" ? "selected" : ""}>下書き</option>
              <option value="billed" ${billingStatus === "billed" ? "selected" : ""}>請求済</option>
              <option value="paid" ${billingStatus === "paid" ? "selected" : ""}>入金済</option>
            </select>
          </label>
        </div>
        <div id="invoiceBatchCount" class="p" style="margin-top:8px;">表示件数: ${escapeHtml(String(filtered.length))}</div>
        <div id="invoiceBatchList" style="margin-top:10px;">${filtered.map(renderBillingListCard_).join("") || `<div class="p">条件に一致する請求書がありません。</div>`}</div>
      </section>
    `);
    qs("#invoiceFilterKeyword")?.addEventListener("input", (ev) => {
      keyword = String(ev?.target?.value || "");
      if (keywordTimer) clearTimeout(keywordTimer);
      keywordTimer = setTimeout(() => {
        refetchAndRenderList_().catch((e) => {
          toast({ title: "取得失敗", message: e?.message || String(e) });
        });
      }, 250);
    });
    qs("#invoiceFilterStatus")?.addEventListener("change", async (ev) => {
      billingStatus = String(ev?.target?.value || "").trim();
      const u = new URL(window.location.href);
      if (billingStatus) u.hash = `#/invoices?status=${encodeURIComponent(billingStatus)}`;
      else u.hash = "#/invoices";
      rows = await fetchBillingBatches_({ billing_status: billingStatus, query: keyword });
      renderPage_();
    });
    qs("#invoiceBatchList")?.addEventListener("click", (ev) => {
      const deleteBtn = ev.target.closest('[data-action="revert-unbilled"]');
      if (deleteBtn) {
        const batchId = String(deleteBtn.dataset.batchId || "").trim();
        if (!batchId) return;
        deleteBillingBatchFromList_(batchId).catch((e) => {
          toast({ title: "削除失敗", message: e?.message || String(e) });
        });
        return;
      }
      const btn = ev.target.closest('[data-action="open-detail"]');
      if (!btn) return;
      const batchId = String(btn.dataset.batchId || "").trim();
      if (!batchId) return;
      window.location.hash = `#/invoices?id=${encodeURIComponent(batchId)}`;
    });
  }
  renderPage_();
}

function cloneEditorItem_(x) {
  const row = x || {};
  return {
    id: String(row.id || ""),
    visit_id: String(row.visit_id || ""),
    price_rule_id: String(row.price_rule_id || ""),
    is_cancelled: !!row.is_cancelled,
    is_booking_level: !!row.is_booking_level,
    label: String(row.label || ""),
    unit_price_snapshot: Number(row.unit_price_snapshot || 0) || 0,
    invoice_line_item_id: String(row.invoice_line_item_id || ""),
    line_item_index: Number(row.line_item_index || 9999) || 9999,
    _deleted: !!row.is_cancelled,
    _isNew: false
  };
}

function buildDetailReadonlyHtml_(detail) {
  const batch = detail?.batch || {};
  const legacyMode = detail?.legacy_mode === true;
  const legacyCutoffDate = String(detail?.legacy_cutoff_date || "").trim();
  const customerLabel = withCustomerHonorific_(batch.customer_name);
  const links = (Array.isArray(detail?.links) ? detail.links : []).slice().sort((a, b) => {
    const at = Date.parse(String((a?.visit || {}).start_time || "")) || 0;
    const bt = Date.parse(String((b?.visit || {}).start_time || "")) || 0;
    if (at !== bt) return at - bt;
    return String(a?.visit_id || "").localeCompare(String(b?.visit_id || ""));
  });
  const lines = Array.isArray(detail?.invoice_line_items) ? detail.invoice_line_items : [];
  const discountAmount = Math.max(0, Number(batch?.discount_amount || 0) || 0);
  const discountLabel = String(batch?.discount_label || "割引");
  const periodStart = batch.period_start ? formatDateYmd_(batch.period_start) : "-";
  const periodEnd = batch.period_end ? formatDateYmd_(batch.period_end) : "-";
  const hasInactiveLinkedVisit = links.some((x) => x && x.visit && x.visit.is_active === false);
  const paidTimeChangedVisitCount = Math.max(0, Number(batch.paid_time_changed_visit_count || 0) || 0)
    || links.filter((x) => x?.paid_time_change_detected === true || String(x?.paid_time_change_detected || "").toLowerCase() === "true").length;
  const inactiveLinkedVisitCount = Math.max(0, Number(batch.inactive_linked_visit_count || 0) || 0) || links.filter((x) => x && x.visit && x.visit.is_active === false).length;
  const refundFollowupStatus = deriveRefundFollowupStatus_(batch, { hasInactiveLinkedVisit });
  const refundFollowupLabel = refundFollowupLabel_(refundFollowupStatus);
  const canMarkRefundNotRequired = refundFollowupStatus === "required";
  const showDeleteButton = canDeleteBillingBatch_(batch);
  const refundNotice = (refundFollowupStatus === "refunded_partial" || refundFollowupStatus === "refunded_full")
    ? "返金が検知されました。関連予約がキャンセルになっていることを確認してください。再請求が必要な場合は、新規で請求書を作成してください。"
    : "";
  const reconcileNotice = hasInactiveLinkedVisit
    ? [
      inactiveLinkedVisitCount > 0 ? `キャンセル済み予約が${inactiveLinkedVisitCount}件含まれます。` : "",
      "必要に応じてこの請求を削除または編集してください。"
    ].filter(Boolean).join("")
    : "";
  const paidTimeChangeNotice = paidTimeChangedVisitCount > 0
    ? `対象予約にお支払い後の日時変更履歴が${paidTimeChangedVisitCount}件あります。Square請求書の記載日時と現在の予約日時が異なる可能性があります。`
    : "";
  return `
    <div class="card" style="margin-top:10px;">
      <div class="p">
        <div class="row row-between">
          <div>
            <div><strong>${escapeHtml(customerLabel || "-")}</strong></div>
            <div style="opacity:.85; margin-top:4px;">請求期間: ${escapeHtml(periodStart)} 〜 ${escapeHtml(periodEnd)}（${escapeHtml(String(batch.visit_count || 0))}回）</div>
            <div style="opacity:.85; margin-top:4px;">合計金額: ${escapeHtml(formatMoney_(batch.total_amount || 0))}円</div>
            ${discountAmount > 0 ? `<div style="opacity:.85; margin-top:4px;">${escapeHtml(discountLabel)}: -${escapeHtml(formatMoney_(discountAmount))}円</div>` : ``}
            <div style="opacity:.85; margin-top:4px;">
              ステータス:
              <span class="${escapeHtml(billingStatusBadgeClass_(batch.billing_status))}">${escapeHtml(billingStatusLabel_(batch.billing_status))}</span>
              ${refundFollowupLabel ? `<span class="${refundFollowupBadgeClass_(refundFollowupStatus)} badge-inline">${escapeHtml(refundFollowupLabel)}</span>` : ``}
            </div>
            <div style="opacity:.85; margin-top:4px;">Square状態: ${escapeHtml(String(batch.square_invoice_status || "-"))}</div>
            <div style="opacity:.85; margin-top:4px;">バッチID: ${escapeHtml(String(batch.batch_id || "-"))}</div>
            ${legacyMode ? `<div style="margin-top:8px;"><span class="badge badge-warning">旧料金モード${legacyCutoffDate ? `（〜${escapeHtml(legacyCutoffDate)}）` : ""}</span></div>` : ``}
            ${refundNotice ? `<div style="margin-top:8px; color:var(--state-warn-fg);">${escapeHtml(refundNotice)}</div>` : ``}
            ${reconcileNotice ? `<div style="margin-top:8px; color:var(--state-warn-fg);">${escapeHtml(reconcileNotice)}</div>` : ``}
            ${paidTimeChangeNotice ? `<div style="margin-top:8px; color:var(--state-warn-fg);">${escapeHtml(paidTimeChangeNotice)}</div>` : ``}
          </div>
          <div>
            ${batch.square_invoice_url ? `<a class="btn btn-ghost" target="_blank" rel="noopener noreferrer" href="${escapeHtml(String(batch.square_invoice_url || ""))}">Square請求書を開く ↗</a>` : ``}
            ${canMarkRefundNotRequired ? `<button class="btn btn-ghost" type="button" data-action="mark-refund-not-required" data-batch-id="${escapeHtml(String(batch.batch_id || ""))}" style="margin-top:8px;">返金不要として確定</button>` : ``}
            ${showDeleteButton ? `<button class="btn btn-ghost" type="button" data-action="revert-unbilled" data-batch-id="${escapeHtml(String(batch.batch_id || ""))}" style="margin-top:8px;">削除</button>` : ``}
          </div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:10px;">
      <div class="p">
        <strong>請求明細</strong>
        <div style="display:grid; gap:8px; margin-top:8px;">
          ${lines.map((line) => {
            const qty = Math.max(0, Number(line?.quantity || 0) || 0);
            const unit = Math.max(0, Number(line?.unit_price_snapshot || 0) || 0);
            return `
              <div class="row row-between" style="gap:12px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
                <div>
                  <strong>${escapeHtml(String(line?.label || "-"))}</strong>
                  <div style="opacity:.85; margin-top:4px;">${escapeHtml(String(qty))} × ${escapeHtml(formatMoney_(unit))}円</div>
                </div>
                <div>${escapeHtml(formatMoney_(qty * unit))}円</div>
              </div>
            `;
          }).join("") || `<div class="p">明細がありません。</div>`}
          ${discountAmount > 0 ? `
            <div class="row row-between" style="gap:12px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
              <div><strong>${escapeHtml(discountLabel)}</strong><div style="opacity:.85; margin-top:4px;">値引き</div></div>
              <div>-${escapeHtml(formatMoney_(discountAmount))}円</div>
            </div>
          ` : ``}
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:10px;">
      <div class="p">
        <strong>対象訪問</strong>
        <div style="display:grid; gap:8px; margin-top:8px;">
          ${links.map((link) => {
            const visit = link?.visit || {};
            const isActive = link?.is_active === false || visit.is_active === false ? false : true;
            const paidTimeChanged = link?.paid_time_change_detected === true || String(link?.paid_time_change_detected || "").toLowerCase() === "true";
            const paidTimeChangeBefore = [
              formatVisitDetailDateTime_(link?.paid_time_change_before_start_time),
              formatVisitDetailDateTime_(link?.paid_time_change_before_end_time)
            ].filter((x) => x && x !== "-").join(" - ");
            return `
              <div style="border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
                <div>
                  <strong>${escapeHtml(String(link?.visit_id || "-"))}</strong>
                  <span class="${isActive ? "badge badge-success" : "badge badge-warning"} badge-inline">${isActive ? "有効" : "キャンセル済み"}</span>
                  <span class="${escapeHtml(billingStatusBadgeClass_(link?.billing_status || visit.billing_status))} badge-inline">${escapeHtml(billingStatusLabel_(link?.billing_status || visit.billing_status))}</span>
                  ${paidTimeChanged ? `<span class="badge badge-warning badge-inline">支払後日時変更あり</span>` : ``}
                </div>
                <div class="row row-between" style="gap:12px; margin-top:4px;">
                  <div style="opacity:.85;">${escapeHtml(formatVisitSummaryDate_(visit?.start_time, visit?.start_time))}</div>
                  <div style="white-space:nowrap;">${escapeHtml(formatMoney_(link?.subtotal || 0))}円</div>
                </div>
                ${paidTimeChanged ? `<div style="color:var(--state-warn-fg); margin-top:4px;">変更前：${escapeHtml(paidTimeChangeBefore || "変更前日時不明")}</div>` : ``}
                <div style="opacity:.85; margin-top:4px;">${escapeHtml(String(visit?.title || "-"))}</div>
              </div>
            `;
          }).join("") || `<div class="p">対象訪問がありません。</div>`}
        </div>
      </div>
    </div>
  `;
}

function buildEditSectionHtml_(opts) {
  const title = String(opts?.title || "");
  const visitId = String(opts?.visit_id || "");
  const subtotal = Number(opts?.subtotal || 0) || 0;
  const rows = Array.isArray(opts?.rows) ? opts.rows : [];
  const addForm = opts?.addForm || null;
  const ruleOptions = Array.isArray(opts?.ruleOptions) ? opts.ruleOptions : [];
  const sectionKey = visitId || "__booking_level__";
  return `
    <div style="margin-top:10px;">
      <div class="row row-between">
        <strong>${escapeHtml(title)}</strong>
        <strong>${escapeHtml(formatMoney_(subtotal))}円</strong>
      </div>
      <div style="display:grid; gap:8px; margin-top:8px;">
          ${rows.map((row) => {
            const isDeleted = !!row._deleted;
            return `
              <div class="row row-between ${isDeleted ? "is-locked" : ""}" style="gap:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px; padding-bottom:6px;">
                <div style="${isDeleted ? "text-decoration:line-through;" : ""}">
                  <div><strong>🔄️ ${escapeHtml(String(row.label || row.price_rule_id || "-"))}</strong> ${escapeHtml(formatMoney_(row.unit_price_snapshot || 0))}円</div>
                  <div style="margin-top:6px;">
                    <div class="label-sm">商品変更</div>
                    <select class="input" data-action="change-item-rule" data-item-id="${escapeHtml(String(row.id || ""))}" ${isDeleted ? "disabled" : ""}>
                      ${ruleOptions.map((o) => `<option value="${escapeHtml(String(o.value || ""))}" ${String(o.value || "") === String(row.price_rule_id || "") ? "selected" : ""}>${escapeHtml(String(o.label || ""))}</option>`).join("")}
                    </select>
                  </div>
                </div>
                <div>
                  ${isDeleted
                    ? `<button class="btn btn-ghost" type="button" data-action="undo-delete-item" data-item-id="${escapeHtml(String(row.id || ""))}">取り消し</button>`
                    : `<button class="btn btn-ghost" type="button" data-action="mark-delete-item" data-item-id="${escapeHtml(String(row.id || ""))}">削除</button>`}
                </div>
              </div>
            `;
          }).join("") || `<div class="p">費目がありません。</div>`}
          <button class="btn btn-ghost" type="button" data-action="start-add-item" data-visit-id="${escapeHtml(visitId)}">➕ ${visitId ? "商品追加" : "全体費目を追加"}</button>
          ${addForm && addForm.scope_key === sectionKey ? `
            <div class="card" style="border-style:dashed;">
              <div class="p" style="display:grid; gap:8px;">
                <label>
                  <div class="label-sm">商品</div>
                  <select class="input" data-action="select-add-rule">
                    <option value="">商品を選択</option>
                    ${ruleOptions.map((o) => `<option value="${escapeHtml(String(o.value || ""))}" ${o.value === addForm.price_rule_id ? "selected" : ""}>${escapeHtml(String(o.label || ""))}</option>`).join("")}
                  </select>
                </label>
                <div class="p">単価プレビュー: ${addForm.loading ? "読み込み中..." : `${escapeHtml(formatMoney_(addForm.unit_price || 0))}円`} ${addForm.label ? `(${escapeHtml(addForm.label)})` : ""}</div>
                ${addForm.error ? `<div class="p" style="color:#ffc1c1;">${escapeHtml(addForm.error)}</div>` : ``}
                <div class="row">
                  <button class="btn" type="button" data-action="confirm-add-item" ${addForm.unit_price > 0 && addForm.price_rule_id ? "" : "disabled"}>確定</button>
                  <button class="btn btn-ghost" type="button" data-action="cancel-add-item">キャンセル</button>
                </div>
              </div>
            </div>
          ` : ``}
      </div>
    </div>
  `;
}

function buildRuleCatalog_(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const byId = {};
  const byType = {};
  list.forEach((r) => {
    const rid = String(r?.price_rule_id || "").trim();
    if (!rid) return;
    const itemType = String(r?.item_type || "").trim();
    const label = String(r?.label || "").trim()
      || [String(r?.product_name || "").trim(), String(r?.variant_name || "").trim()].filter(Boolean).join(" ").trim()
      || rid;
    const amount = Math.max(0, Number(r?.amount || 0) || 0);
    const row = { price_rule_id: rid, item_type: itemType, label, amount, display_order: Number(r?.display_order || 0) || 0 };
    byId[rid] = row;
    if (!isSelectablePriceRule_(r)) return;
    if (!byType[itemType]) byType[itemType] = [];
    byType[itemType].push(row);
  });
  Object.keys(byType).forEach((k) => {
    byType[k].sort((a, b) => {
      if (a.display_order !== b.display_order) return a.display_order - b.display_order;
      return String(a.price_rule_id || "").localeCompare(String(b.price_rule_id || ""));
    });
  });
  return { byId, byType };
}

function asItemType_(row, ruleCatalog) {
  const rid = String(row?.price_rule_id || "").trim();
  if (rid === "manual:cancellation_fee") return "cancellation_fee";
  const direct = String((ruleCatalog?.byId?.[rid] || {}).item_type || "").trim();
  if (direct) return direct;
  const label = String(row?.label || "").trim();
  if (label.includes("鍵預かり")) return "key_pickup_fee";
  if (label.includes("鍵返却")) return "key_return_fee";
  if (label.includes("駐車")) return "parking_fee";
  if (label.includes("出張")) return "travel_fee";
  if (label.includes("繁忙")) return "seasonal_fee";
  if (isCancellationFeeLabel_(label)) return "cancellation_fee";
  return "custom";
}

function normalizeLegacyLabelKey_(value) {
  return String(value || "").trim().replace(/\s+/g, "").replace(/／/g, "/").toLowerCase();
}

function isLegacyHeadcountLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("頭数追加");
}

function isLegacyTravelLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("交通費");
}

function isLegacyToppingLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("遊び/ケア");
}

function isCancellationFeeLabel_(label) {
  const key = normalizeLegacyLabelKey_(label);
  return key.includes("キャンセル料") || key.includes("キャンセル料金");
}

function amountTextInline_(n, empty = "未設定") {
  const v = Math.max(0, Number(n || 0) || 0);
  return v > 0 ? `${formatMoney_(v)}円` : empty;
}

function editorExtraLinesTotal_(visit) {
  const lines = Array.isArray(visit?.extra_lines) ? visit.extra_lines : [];
  return lines.reduce((sum, line) => {
    const qty = Math.max(1, Number(line?.qty || 1) || 1);
    const amount = Math.max(0, Number(line?.amount || 0) || 0);
    return sum + (qty * amount);
  }, 0);
}

function editorInvoiceExtraLinesTotal_(model) {
  const lines = Array.isArray(model?.invoice_extra_lines) ? model.invoice_extra_lines : [];
  return lines.reduce((sum, line) => {
    const qty = Math.max(1, Number(line?.qty || 1) || 1);
    const amount = Math.max(0, Number(line?.amount || 0) || 0);
    return sum + (qty * amount);
  }, 0);
}

function formatEditorLineAmount_(amount, qty) {
  const unit = Math.max(0, Number(amount || 0) || 0);
  const count = Math.max(1, Number(qty || 1) || 1);
  if (!(unit > 0)) return "未設定";
  return count > 1 ? `${formatMoney_(unit * count)}円（${formatMoney_(unit)}円 × ${count}）` : `${formatMoney_(unit)}円`;
}

async function inputCancellationFeeByModal_(current = {}) {
  const label = String(current?.label || "キャンセル料金").trim() || "キャンセル料金";
  const amount = Math.max(0, Number(current?.amount || 0) || 0);
  const qty = Math.max(1, Number(current?.qty || 1) || 1);
  const out = await openEditorModal_({
    title: "キャンセル料金",
    bodyHtml: `
      <div style="display:grid; gap:8px;">
        <div>
          <div class="label-sm">表示名</div>
          <input class="input" data-el="label" type="text" value="${escapeHtml(label)}" />
        </div>
        <div>
          <div class="label-sm">単価</div>
          <input class="input" data-el="amount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(String(amount || ""))}" />
        </div>
        <div>
          <div class="label-sm">数量</div>
          <input class="input" data-el="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(String(qty))}" />
        </div>
        <div class="p opacity-8">単価を0にするとキャンセル料金行を削除します。</div>
      </div>
    `,
    onSubmit: (root) => {
      const nextLabel = String(root.querySelector('[data-el="label"]')?.value || "").trim() || "キャンセル料金";
      const nextAmount = Math.max(0, Number(root.querySelector('[data-el="amount"]')?.value || 0) || 0);
      const nextQty = Math.max(1, Number(root.querySelector('[data-el="qty"]')?.value || 1) || 1);
      return { label: nextLabel, amount: nextAmount, qty: nextQty };
    }
  });
  return out == null ? null : out;
}

async function inputExtraLineByModal_(current = {}) {
  const label = String(current?.label || "").trim();
  const amount = Math.max(0, Number(current?.amount || 0) || 0);
  const qty = Math.max(1, Number(current?.qty || 1) || 1);
  const out = await openEditorModal_({
    title: "明細追加",
    bodyHtml: `
      <div style="display:grid; gap:8px;">
        <div>
          <div class="label-sm">表示名</div>
          <input class="input" data-el="label" type="text" placeholder="例：フード購入代" value="${escapeHtml(label)}" />
        </div>
        <div>
          <div class="label-sm">単価</div>
          <input class="input" data-el="amount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(String(amount || ""))}" />
        </div>
        <div>
          <div class="label-sm">数量</div>
          <input class="input" data-el="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(String(qty))}" />
        </div>
        <div class="p opacity-8">単価を0にすると明細行を削除します。</div>
      </div>
    `,
    onSubmit: (root) => {
      const nextLabel = String(root.querySelector('[data-el="label"]')?.value || "").trim();
      const nextAmount = Math.max(0, Number(root.querySelector('[data-el="amount"]')?.value || 0) || 0);
      const nextQty = Math.max(1, Number(root.querySelector('[data-el="qty"]')?.value || 1) || 1);
      if (!nextLabel && nextAmount > 0) return null;
      return { label: nextLabel, amount: nextAmount, qty: nextQty };
    }
  });
  return out == null ? null : out;
}

async function pickKeyFeeByModal_(title, options, current = {}) {
  const list = Array.isArray(options) ? options : [];
  const currentRuleId = String(current?.price_rule_id || "").trim();
  const currentQty = Math.max(1, Number(current?.qty || 1) || 1);
  const out = await openEditorModal_({
    title,
    bodyHtml: `
      <div style="display:grid; gap:8px;">
        <label>
          <div class="label-sm">料金</div>
          <select class="input" data-el="rule">
            <option value="">適用しない</option>
            ${list.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}" ${String(o.price_rule_id || "") === currentRuleId ? "selected" : ""}>${escapeHtml(String(o.label || o.price_rule_id || ""))}（${escapeHtml(formatMoney_(o.amount || 0))}円）</option>`).join("")}
          </select>
        </label>
        <label>
          <div class="label-sm">数量</div>
          <input class="input" data-el="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(String(currentQty))}" />
        </label>
      </div>
    `,
    onSubmit: (root) => {
      const rid = String(root.querySelector('[data-el="rule"]')?.value || "").trim();
      const qty = Math.max(1, Number(root.querySelector('[data-el="qty"]')?.value || 1) || 1);
      if (!rid) return { price_rule_id: "", amount: 0, qty: 1 };
      const picked = list.find((x) => String(x?.price_rule_id || "").trim() === rid) || {};
      return {
        price_rule_id: rid,
        label: String(picked.label || rid).trim(),
        amount: Math.max(0, Number(picked.amount || 0) || 0),
        qty
      };
    }
  });
  return out == null ? null : out;
}

function groupEditorItemRows_(rows) {
  const groups = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const rid = String(row?.price_rule_id || "").trim();
    const lineId = String(row?.invoice_line_item_id || "").trim();
    const label = String(row?.label || "").trim();
    const amount = Math.max(0, Number(row?.unit_price_snapshot || 0) || 0);
    const key = lineId || `${rid}@@${label}@@${amount}`;
    if (!key) return;
    if (!groups[key]) {
      groups[key] = {
        rule_id: rid,
        line_item_id: lineId,
        label,
        amount,
        qty: 0,
      };
    }
    groups[key].qty += 1;
  });
  return Object.keys(groups).map((k) => groups[k]);
}

function buildEditorModel_(detail, links, ruleCatalog, options = {}) {
  const legacyMode = options?.legacy_mode === true;
  const sourceRows = (Array.isArray(detail?.invoice_items) ? detail.invoice_items : []).filter((x) => !x?.is_cancelled);
  const visitRows = links.map((link) => {
    const vid = String(link?.visit_id || "").trim();
    const title = String(link?.visit?.title || vid || "").trim();
    const byVisit = sourceRows.filter((x) => String(x?.visit_id || "").trim() === vid);
    const pickType_ = (t) => byVisit.find((x) => asItemType_(x, ruleCatalog) === t) || null;
    const base = pickType_("visit_base");
    const parking = pickType_("parking_fee");
    const travel = pickType_("travel_fee");
    const seasonal = pickType_("seasonal_fee");
    const extras = byVisit.filter((x) => !["visit_base", "parking_fee", "travel_fee", "seasonal_fee"].includes(asItemType_(x, ruleCatalog)));
    const cancellationFeeRows = extras.filter((x) => asItemType_(x, ruleCatalog) === "cancellation_fee");
    const legacyHeadcountRows = extras.filter((x) => isLegacyHeadcountLabel_(x?.label));
    const legacyTravelRows = extras.filter((x) => isLegacyTravelLabel_(x?.label));
    const legacyToppingRows = extras.filter((x) => isLegacyToppingLabel_(x?.label));
    const cancellationFee = cancellationFeeRows[0] || null;
    const legacyHeadcount = legacyHeadcountRows[0] || null;
    const legacyTravel = legacyTravelRows[0] || null;
    const legacyTopping = legacyToppingRows[0] || null;
    const extraLines = extras.filter((x) => {
      if (asItemType_(x, ruleCatalog) === "cancellation_fee") return false;
      if (isLegacyHeadcountLabel_(x?.label) || isLegacyTravelLabel_(x?.label) || isLegacyToppingLabel_(x?.label)) return false;
      return true;
    });
    const extra = extraLines[0] || null;
    return {
      visit_id: vid,
      title,
      start_time: String((link?.visit || {}).start_time || ""),
      base_rule_id: String(base?.price_rule_id || "").trim(),
      base_label: String(base?.label || (ruleCatalog?.byId?.[String(base?.price_rule_id || "").trim()] || {}).label || "").trim(),
      base_amount: Math.max(0, Number(base?.unit_price_snapshot || 0) || 0),
      parking_rule_id: String(parking?.price_rule_id || ((ruleCatalog?.byType?.parking_fee || [])[0] || {}).price_rule_id || "").trim(),
      parking_amount: Math.max(0, Number(parking?.unit_price_snapshot || 0) || 0),
      travel_rule_id: String(travel?.price_rule_id || "").trim(),
      travel_amount: Math.max(0, Number(travel?.unit_price_snapshot || 0) || 0),
      seasonal_rule_id: String(seasonal?.price_rule_id || "").trim(),
      seasonal_amount: Math.max(0, Number(seasonal?.unit_price_snapshot || 0) || 0),
      cancellation_fee_rule_id: String(cancellationFee?.price_rule_id || "").trim(),
      cancellation_fee_line_item_id: String(cancellationFee?.invoice_line_item_id || "").trim(),
      cancellation_fee_label: String(cancellationFee?.label || "").trim() || "キャンセル料金",
      cancellation_fee_amount: Math.max(0, Number(cancellationFee?.unit_price_snapshot || 0) || 0),
      cancellation_fee_qty: Math.max(1, cancellationFeeRows.length || 1),
      extra_rule_id: String(extra?.price_rule_id || "").trim(),
      extra_line_item_id: String(extra?.invoice_line_item_id || "").trim(),
      extra_label: String(extra?.label || "").trim(),
      extra_amount: Math.max(0, Number(extra?.unit_price_snapshot || 0) || 0),
      extra_qty: 1,
      extra_lines: groupEditorItemRows_(extraLines),
      legacy_headcount_rule_id: String(legacyHeadcount?.price_rule_id || "").trim(),
      legacy_headcount_label: String(legacyHeadcount?.label || "").trim(),
      legacy_headcount_amount: Math.max(0, Number(legacyHeadcount?.unit_price_snapshot || 0) || 0),
      legacy_headcount_qty: Math.max(1, legacyHeadcountRows.length || 1),
      legacy_travel_rule_id: String(legacyTravel?.price_rule_id || "").trim(),
      legacy_travel_label: String(legacyTravel?.label || "").trim() || "交通費（往復）",
      legacy_travel_amount: Math.max(0, Number(legacyTravel?.unit_price_snapshot || 0) || 0),
      legacy_topping_rule_id: String(legacyTopping?.price_rule_id || "").trim(),
      legacy_topping_label: String(legacyTopping?.label || "").trim(),
      legacy_topping_amount: Math.max(0, Number(legacyTopping?.unit_price_snapshot || 0) || 0),
      legacy_topping_qty: Math.max(1, legacyToppingRows.length || 1),
      legacy_mode: legacyMode,
      excluded: false,
    };
  });
  const bookingRows = sourceRows.filter((x) => !String(x?.visit_id || "").trim());
  const keyPickupRows = bookingRows.filter((x) => asItemType_(x, ruleCatalog) === "key_pickup_fee");
  const keyReturnRows = bookingRows.filter((x) => asItemType_(x, ruleCatalog) === "key_return_fee");
  const keyPickup = keyPickupRows[0] || null;
  const keyReturn = keyReturnRows[0] || null;
  const invoiceExtraLines = groupEditorItemRows_(bookingRows.filter((x) => {
    const t = asItemType_(x, ruleCatalog);
    return t !== "key_pickup_fee" && t !== "key_return_fee";
  }));
  const discountAmount = Math.max(0, Number(detail?.batch?.discount_amount || 0) || 0);
  const discountOptions = Array.isArray(ruleCatalog?.byType?.discount) ? ruleCatalog.byType.discount : [];
  const discountPriceRuleId = String(
    (discountOptions.find((x) => Math.max(0, Number(x?.amount || 0) || 0) === discountAmount) || discountOptions[0] || {}).price_rule_id || ""
  ).trim();
  return {
    visits: visitRows,
    key_pickup_rule_id: String(keyPickup?.price_rule_id || "").trim(),
    key_pickup_amount: Math.max(0, Number(keyPickup?.unit_price_snapshot || 0) || 0),
    key_pickup_qty: Math.max(1, keyPickupRows.length || 1),
    key_return_rule_id: String(keyReturn?.price_rule_id || "").trim(),
    key_return_amount: Math.max(0, Number(keyReturn?.unit_price_snapshot || 0) || 0),
    key_return_qty: Math.max(1, keyReturnRows.length || 1),
    invoice_extra_lines: invoiceExtraLines,
    discount_amount: discountAmount,
    discount_label: String(detail?.batch?.discount_label || "割引").trim() || "割引",
    discount_price_rule_id: discountPriceRuleId
  };
}

function buildEditorPayloadFromModel_(model, ruleCatalog, options = {}) {
  const legacyMode = options?.legacy_mode === true;
  const m = model || {};
  const visits = Array.isArray(m.visits) ? m.visits : [];
  const items = [];
  const lineMap = {};
  const pushItemCopies_ = (item, qty) => {
    const count = Math.max(1, Number(qty || 1) || 1);
    for (let i = 0; i < count; i += 1) {
      items.push(Object.assign({}, item));
    }
  };
  const addLine_ = (priceRuleId, label, unitPrice, qty, options = {}) => {
    const rid = String(priceRuleId || "").trim();
    const lb = String(label || "").trim() || rid;
    const unit = Math.max(0, Number(unitPrice || 0) || 0);
    const quantity = Math.max(0, Number(qty || 0) || 0);
    if (!lb || !(unit > 0) || !(quantity > 0)) return;
    const key = `${rid}@@${lb}@@${unit}`;
    if (!lineMap[key]) {
      lineMap[key] = {
        id: String(options?.id || "").trim(),
        square_line_item_uid: "",
        price_rule_id: rid,
        label: lb,
        quantity: 0,
        unit_price_snapshot: unit
      };
    }
    lineMap[key].quantity += quantity;
  };
  visits.forEach((v) => {
    const vid = String(v?.visit_id || "").trim();
    if (!vid) return;
    if (v.excluded === true) return;
    if (v.base_rule_id && Number(v.base_amount || 0) > 0) {
      items.push({ id: "", visit_id: vid, price_rule_id: v.base_rule_id, invoice_line_item_id: "", is_cancelled: false });
      addLine_(v.base_rule_id, v.base_label || ((ruleCatalog?.byId?.[v.base_rule_id] || {}).label || ""), v.base_amount, 1);
    }
    if (Number(v.parking_amount || 0) > 0) {
      const rid = String(v.parking_rule_id || ((ruleCatalog?.byType?.parking_fee || [])[0] || {}).price_rule_id || "").trim();
      const lb = ((ruleCatalog?.byId?.[rid] || {}).label || "駐車料金");
      items.push({ id: "", visit_id: vid, price_rule_id: rid, invoice_line_item_id: "", is_cancelled: false });
      addLine_(rid, lb, v.parking_amount, 1);
    }
    if (v.travel_rule_id && Number(v.travel_amount || 0) > 0) {
      const lb = (ruleCatalog?.byId?.[v.travel_rule_id] || {}).label || "出張料金";
      items.push({ id: "", visit_id: vid, price_rule_id: v.travel_rule_id, invoice_line_item_id: "", is_cancelled: false });
      addLine_(v.travel_rule_id, lb, v.travel_amount, 1);
    }
    if (v.seasonal_rule_id && Number(v.seasonal_amount || 0) > 0) {
      const lb = (ruleCatalog?.byId?.[v.seasonal_rule_id] || {}).label || "繁忙期加算";
      items.push({ id: "", visit_id: vid, price_rule_id: v.seasonal_rule_id, invoice_line_item_id: "", is_cancelled: false });
      addLine_(v.seasonal_rule_id, lb, v.seasonal_amount, 1);
    }
    if (legacyMode) {
      if (v.legacy_headcount_rule_id && Number(v.legacy_headcount_amount || 0) > 0) {
        const qty = Math.max(1, Number(v.legacy_headcount_qty || 1) || 1);
        const lb = String(v.legacy_headcount_label || (ruleCatalog?.byId?.[v.legacy_headcount_rule_id] || {}).label || "頭数追加").trim();
        pushItemCopies_({ id: "", visit_id: vid, price_rule_id: v.legacy_headcount_rule_id, invoice_line_item_id: "", is_cancelled: false }, qty);
        addLine_(v.legacy_headcount_rule_id, lb, v.legacy_headcount_amount, qty);
      }
      if (v.legacy_travel_rule_id && Number(v.legacy_travel_amount || 0) > 0) {
        const lb = String(v.legacy_travel_label || (ruleCatalog?.byId?.[v.legacy_travel_rule_id] || {}).label || "交通費（往復）").trim();
        items.push({ id: "", visit_id: vid, price_rule_id: v.legacy_travel_rule_id, invoice_line_item_id: "", is_cancelled: false });
        addLine_(v.legacy_travel_rule_id, lb, v.legacy_travel_amount, 1);
      }
      if (v.legacy_topping_rule_id && Number(v.legacy_topping_amount || 0) > 0) {
        const qty = Math.max(1, Number(v.legacy_topping_qty || 1) || 1);
        const lb = String(v.legacy_topping_label || (ruleCatalog?.byId?.[v.legacy_topping_rule_id] || {}).label || "遊び / ケア").trim();
        pushItemCopies_({ id: "", visit_id: vid, price_rule_id: v.legacy_topping_rule_id, invoice_line_item_id: "", is_cancelled: false }, qty);
        addLine_(v.legacy_topping_rule_id, lb, v.legacy_topping_amount, qty);
      }
    } else {
      if (Number(v.cancellation_fee_amount || 0) > 0) {
        const qty = Math.max(1, Number(v.cancellation_fee_qty || 1) || 1);
        const lb = String(v.cancellation_fee_label || "キャンセル料金").trim() || "キャンセル料金";
        const rid = String(v.cancellation_fee_rule_id || "").trim() || "manual:cancellation_fee";
        pushItemCopies_({
          id: "",
          visit_id: vid,
          price_rule_id: rid,
          invoice_line_item_id: "",
          is_cancelled: false,
          allow_empty_price_rule: true
        }, qty);
        addLine_(rid, lb, v.cancellation_fee_amount, qty, { id: String(v.cancellation_fee_line_item_id || "").trim() });
      }
      const extraLines = Array.isArray(v.extra_lines) ? v.extra_lines : [];
      extraLines.forEach((line) => {
        if (!String(line?.label || "").trim() || !(Number(line?.amount || 0) > 0)) return;
        const qty = Math.max(1, Number(line?.qty || 1) || 1);
        const lb = String(line.label || "明細").trim();
        const rid = String(line.rule_id || "").trim() || "manual:custom";
        const lineItemId = String(line.line_item_id || "").trim();
        pushItemCopies_({ id: "", visit_id: vid, price_rule_id: rid, invoice_line_item_id: lineItemId, is_cancelled: false }, qty);
        addLine_(rid, lb, line.amount, qty, { id: lineItemId });
      });
    }
  });
  if (m.key_pickup_rule_id && Number(m.key_pickup_amount || 0) > 0) {
    const qty = Math.max(1, Number(m.key_pickup_qty || 1) || 1);
    const lb = (ruleCatalog?.byId?.[m.key_pickup_rule_id] || {}).label || "鍵預かり料金";
    pushItemCopies_({ id: "", visit_id: "", price_rule_id: m.key_pickup_rule_id, invoice_line_item_id: "", is_cancelled: false }, qty);
    addLine_(m.key_pickup_rule_id, lb, m.key_pickup_amount, qty);
  }
  if (m.key_return_rule_id && Number(m.key_return_amount || 0) > 0) {
    const qty = Math.max(1, Number(m.key_return_qty || 1) || 1);
    const lb = (ruleCatalog?.byId?.[m.key_return_rule_id] || {}).label || "鍵返却料金";
    pushItemCopies_({ id: "", visit_id: "", price_rule_id: m.key_return_rule_id, invoice_line_item_id: "", is_cancelled: false }, qty);
    addLine_(m.key_return_rule_id, lb, m.key_return_amount, qty);
  }
  (Array.isArray(m.invoice_extra_lines) ? m.invoice_extra_lines : []).forEach((line) => {
    if (!String(line?.label || "").trim() || !(Number(line?.amount || 0) > 0)) return;
    const qty = Math.max(1, Number(line?.qty || 1) || 1);
    const lb = String(line.label || "明細").trim();
    const rid = String(line.rule_id || "").trim() || "manual:custom";
    const lineItemId = String(line.line_item_id || "").trim();
    pushItemCopies_({ id: "", visit_id: "", price_rule_id: rid, invoice_line_item_id: lineItemId, is_cancelled: false }, qty);
    addLine_(rid, lb, line.amount, qty, { id: lineItemId });
  });
  const discountAmount = Math.max(0, Number(m.discount_amount || 0) || 0);
  const discountOptions = Array.isArray(ruleCatalog?.byType?.discount) ? ruleCatalog.byType.discount : [];
  let discountPriceRuleId = String(m.discount_price_rule_id || "").trim();
  if (!discountPriceRuleId) {
    discountPriceRuleId = String(
      (discountOptions.find((x) => Math.max(0, Number(x?.amount || 0) || 0) === discountAmount) || discountOptions[0] || {}).price_rule_id || ""
    ).trim();
  }
  return {
    items,
    desired_lines: Object.keys(lineMap).map((k) => lineMap[k]),
    discount_amount: discountAmount,
    discount_label: String(m.discount_label || "割引").trim() || "割引",
    discount_price_rule_id: discountPriceRuleId
  };
}

async function renderInvoicesDetailPage_(app, batchId) {
  let detail = null;
  let editing = false;
  let workingItems = [];
  let addForm = null;
  let allRules = [];
  let editorModel = null;
  let ruleCatalog = { byId: {}, byType: {} };
  let editingDiscountAmount = 0;
  let editingDiscountLabel = "割引";
  let initialDiscountAmount = 0;
  let initialDiscountLabel = "割引";
  const openEditorVisitIds = new Set();
  render(app, `<section class="section"><p class="p">請求書詳細を読み込み中…</p></section>`);
  try {
    detail = await runWithBlocking_(
      { title: "請求書詳細を読み込んでいます", bodyHtml: "詳細情報を取得しています。", busyText: "読み込み中..." },
      async () => fetchBillingBatchDetail_(batchId)
    );
  } catch (e) {
    render(app, `<section class="section"><h1 class="h1">請求書詳細</h1><p class="p">${escapeHtml(e?.message || String(e))}</p></section>`);
    return;
  }
  if (!detail?.batch) {
    render(app, `<section class="section"><h1 class="h1">請求書詳細</h1><p class="p">対象データが見つかりません。</p></section>`);
    return;
  }

  const ruleOptions = (Array.isArray(detail?.price_rules) ? detail.price_rules : [])
    .map((r) => ({
      value: String(r?.price_rule_id || "").trim(),
      label: String(r?.label || "").trim() || [String(r?.product_name || "").trim(), String(r?.variant_name || "").trim()].filter(Boolean).join(" ").trim() || String(r?.price_rule_id || "").trim()
    }))
    .filter((x) => x.value);
  try {
    const all = await fetchAllPriceRules_();
    if (Array.isArray(all) && all.length) allRules = all;
  } catch (_) {
    allRules = [];
  }
  const mergedRuleOptions = (() => {
    const map = {};
    ruleOptions.forEach((x) => { map[x.value] = x; });
    allRules.forEach((r) => {
      const value = String(r?.price_rule_id || "").trim();
      if (!value) return;
      if (map[value]) return;
      const label = String(r?.label || "").trim()
        || [String(r?.product_name || "").trim(), String(r?.variant_name || "").trim()].filter(Boolean).join(" ").trim()
        || value;
      map[value] = { value, label };
    });
    return Object.keys(map).sort().map((k) => map[k]);
  })();
  ruleCatalog = buildRuleCatalog_(allRules.length ? allRules : (Array.isArray(detail?.price_rules) ? detail.price_rules : []));

  const refreshDetail_ = async () => {
    detail = await fetchBillingBatchDetail_(batchId);
  };

  function renderPage_() {
    const links = (Array.isArray(detail?.links) ? detail.links : []).slice().sort((a, b) => {
      const at = Date.parse(String((a?.visit || {}).start_time || "")) || 0;
      const bt = Date.parse(String((b?.visit || {}).start_time || "")) || 0;
      if (at !== bt) return at - bt;
      return String(a?.visit_id || "").localeCompare(String(b?.visit_id || ""));
    });
    const batch = detail?.batch || {};
    const legacyMode = detail?.legacy_mode === true;
    const legacyCutoffDate = String(detail?.legacy_cutoff_date || "").trim();
    const customerLabel = withCustomerHonorific_(batch.customer_name);
    const normalizedBatchStatus = String(batch?.billing_status || "").trim().toLowerCase();
    const canEditBatch = normalizedBatchStatus === "billed" || normalizedBatchStatus === "draft";
    const hasInactiveLinkedVisit = links.some((x) => x && x.visit && x.visit.is_active === false);
    const discountAmount = Math.max(0, Number(batch?.discount_amount || 0) || 0);
    const discountLabel = String(batch?.discount_label || "割引");
    const visitDateById = {};
    links.forEach((link) => {
      const vid = String(link?.visit_id || "").trim();
      const st = String((link?.visit || {}).start_time || "");
      if (vid && st) visitDateById[vid] = st;
    });
    const ruleLabelById = {};
    ruleOptions.forEach((o) => { ruleLabelById[String(o.value || "")] = String(o.label || ""); });
    const visitSections = links.map((link) => {
      const vid = String(link?.visit_id || "").trim();
      const visit = link?.visit || {};
      return {
        key: vid,
        visit_id: vid,
        title: `${formatVisitSummaryDate_(visit?.start_time, visit?.start_time)} ${String(visit?.title || vid || "").trim()}`,
        subtotal: Number(link?.subtotal || 0) || 0,
        start_time_ms: Date.parse(String(visit?.start_time || "")) || 0
      };
    }).sort((a, b) => {
      if (a.start_time_ms !== b.start_time_ms) return a.start_time_ms - b.start_time_ms;
      return String(a.visit_id || "").localeCompare(String(b.visit_id || ""));
    });

    const sourceRows = editing ? workingItems : (Array.isArray(detail?.invoice_items) ? detail.invoice_items.map(cloneEditorItem_) : []);
    const editingTotal = editing
      ? (Array.isArray(editorModel?.visits) ? editorModel.visits.reduce((sum, v) => {
          if (v.excluded === true) return sum;
          const sub = Math.max(0, Number(v.base_amount || 0) || 0)
            + Math.max(0, Number(v.parking_amount || 0) || 0)
            + Math.max(0, Number(v.travel_amount || 0) || 0)
            + Math.max(0, Number(v.seasonal_amount || 0) || 0)
            + (legacyMode
              ? ((Math.max(1, Number(v.legacy_headcount_qty || 1) || 1) * Math.max(0, Number(v.legacy_headcount_amount || 0) || 0))
                + Math.max(0, Number(v.legacy_travel_amount || 0) || 0)
                + (Math.max(1, Number(v.legacy_topping_qty || 1) || 1) * Math.max(0, Number(v.legacy_topping_amount || 0) || 0)))
              : ((Math.max(1, Number(v.cancellation_fee_qty || 1) || 1) * Math.max(0, Number(v.cancellation_fee_amount || 0) || 0))
                + editorExtraLinesTotal_(v)));
          return sum + sub;
        }, 0) : 0)
        + (Math.max(1, Number(editorModel?.key_pickup_qty || 1) || 1) * Math.max(0, Number(editorModel?.key_pickup_amount || 0) || 0))
        + (Math.max(1, Number(editorModel?.key_return_qty || 1) || 1) * Math.max(0, Number(editorModel?.key_return_amount || 0) || 0))
        + editorInvoiceExtraLinesTotal_(editorModel)
      : sourceRows.filter((r) => !r._deleted).reduce((sum, r) => sum + (Number(r.unit_price_snapshot || 0) || 0), 0);
    const activeDiscountAmount = editing ? editingDiscountAmount : discountAmount;
    const activeDiscountLabel = editing ? editingDiscountLabel : discountLabel;
    const editingGrand = Math.max(0, editingTotal - activeDiscountAmount);
    const editorRowsHtml = editing ? (Array.isArray(editorModel?.visits) ? editorModel.visits.map((v) => {
      const isExcluded = v.excluded === true;
      const subtotal = Math.max(0, Number(v.base_amount || 0) || 0)
        + Math.max(0, Number(v.parking_amount || 0) || 0)
        + Math.max(0, Number(v.travel_amount || 0) || 0)
        + Math.max(0, Number(v.seasonal_amount || 0) || 0)
        + (legacyMode
          ? ((Math.max(1, Number(v.legacy_headcount_qty || 1) || 1) * Math.max(0, Number(v.legacy_headcount_amount || 0) || 0))
            + Math.max(0, Number(v.legacy_travel_amount || 0) || 0)
            + (Math.max(1, Number(v.legacy_topping_qty || 1) || 1) * Math.max(0, Number(v.legacy_topping_amount || 0) || 0)))
          : ((Math.max(1, Number(v.cancellation_fee_qty || 1) || 1) * Math.max(0, Number(v.cancellation_fee_amount || 0) || 0))
            + editorExtraLinesTotal_(v)));
      const travelLabel = v.travel_rule_id ? (((ruleCatalog.byId[v.travel_rule_id] || {}).label || "出張料金")) : "出張料金";
      const seasonalLabel = v.seasonal_rule_id ? (((ruleCatalog.byId[v.seasonal_rule_id] || {}).label || "繁忙期加算")) : "繁忙期加算";
      const visitId = String(v.visit_id || "").trim();
      const openAttr = openEditorVisitIds.has(visitId) ? " open" : "";
      return `
        <details class="details-compact invoice-edit-details" data-visit-id="${escapeHtml(visitId)}"${openAttr}>
          <summary class="summary-lite">
            <span class="summary-line">
              <span class="fw-600">${escapeHtml(String(v.title || v.visit_id || "-"))}</span>
              <span class="summary-amount">${isExcluded ? "除外予定" : `${escapeHtml(formatMoney_(subtotal))}円`}</span>
            </span>
          </summary>
          <div style="display:grid; gap:8px; margin-top:8px; padding-left:2px;">
            ${isExcluded ? `
            <div class="p" style="color:var(--state-warn-fg);">この回は保存時に請求から除外されます。予約自体はキャンセルされません。</div>
            <button class="btn btn-ghost" data-action="restore-visit-from-invoice" data-visit-id="${escapeHtml(v.visit_id)}" type="button">除外を取り消す</button>
            ` : `
            <div data-action="edit-base" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
              <span>🔄️ ${escapeHtml(String(v.base_label || "訪問サービス"))}</span>
              <strong>${escapeHtml(amountTextInline_(v.base_amount, "未設定"))}</strong>
            </div>
            <div data-action="edit-parking" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
              <span>🔄️ 駐車料金</span>
              <strong>${escapeHtml(amountTextInline_(v.parking_amount, "未設定"))}</strong>
            </div>
            <div data-action="edit-travel" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
              <span>🔄️ ${escapeHtml(travelLabel)}</span>
              <strong>${escapeHtml(amountTextInline_(v.travel_amount, "未選択"))}</strong>
            </div>
            <div data-action="edit-seasonal" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
              <span>🔄️ ${escapeHtml(seasonalLabel)}</span>
              <strong>${escapeHtml(amountTextInline_(v.seasonal_amount, "未選択"))}</strong>
            </div>
            ${legacyMode ? `
              <div data-action="edit-legacy-headcount" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 頭数追加</span>
                <strong>${escapeHtml(v.legacy_headcount_amount > 0 ? `${formatMoney_(v.legacy_headcount_amount)}円` : "未設定")}</strong>
              </div>
              <div data-action="edit-legacy-travel" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 交通費（往復）</span>
                <strong>${escapeHtml(v.legacy_travel_amount > 0 ? `${formatMoney_(v.legacy_travel_amount)}円` : "未設定")}</strong>
              </div>
              <div data-action="edit-legacy-topping" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ トッピング（遊び / ケア）</span>
                <strong>${escapeHtml(v.legacy_topping_amount > 0 ? `${formatMoney_(v.legacy_topping_amount)}円` : "未設定")}</strong>
              </div>
            ` : `
              <div data-action="edit-cancellation-fee" data-visit-id="${escapeHtml(v.visit_id)}" style="display:${Math.max(0, Number(v.cancellation_fee_amount || 0) || 0) > 0 ? "none" : "flex"}; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>➕ キャンセル料金</span>
                <strong>${escapeHtml(v.cancellation_fee_amount > 0 ? `${formatMoney_(v.cancellation_fee_amount)}円` : "未設定")}</strong>
              </div>
              ${Math.max(0, Number(v.cancellation_fee_amount || 0) || 0) > 0 ? `
              <div data-action="edit-cancellation-fee" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ ${escapeHtml(String(v.cancellation_fee_label || "キャンセル料金"))}</span>
                <strong>${escapeHtml(formatEditorLineAmount_(v.cancellation_fee_amount || 0, v.cancellation_fee_qty || 1))}</strong>
              </div>
              ` : ``}
              ${(Array.isArray(v.extra_lines) ? v.extra_lines : []).map((line, idx) => `
              <div data-action="edit-extra" data-visit-id="${escapeHtml(v.visit_id)}" data-extra-index="${escapeHtml(String(idx))}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ ${escapeHtml(String(line?.label || "明細"))}</span>
                <strong>${escapeHtml(formatEditorLineAmount_(line?.amount || 0, line?.qty || 1))}</strong>
              </div>
              `).join("")}
              <div data-action="add-extra" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>➕ 明細追加</span>
                <strong>未設定</strong>
              </div>
            `}
            <button class="btn btn-danger" data-action="exclude-visit-from-invoice" data-visit-id="${escapeHtml(v.visit_id)}" type="button">この回を請求から除外</button>
            `}
          </div>
        </details>
      `;
    }).join("") : "") : "";

    render(app, `
      <section class="section">
        <div class="row" style="justify-content:flex-end;">
          <button class="btn btn-icon-action" id="btnBackToInvoices" type="button" title="一覧に戻る" aria-label="一覧に戻る">${actionIconSvg_("back")}</button>
          <div class="row">
            ${editing
              ? `<button class="btn" id="btnSaveItemsInline" type="button">保存</button><button class="btn btn-ghost" id="btnCancelItemsInline" type="button">キャンセル</button>`
              : `<button class="btn btn-ghost" id="btnCreateAdjustmentFromBatch" type="button">追加請求</button>${canEditBatch ? `<button class="btn btn-ghost" id="btnStartItemsInline" type="button">請求構成を編集</button>` : ``}`}
          </div>
        </div>
        ${editing ? `
          <div class="card" style="margin-top:10px;">
            <div class="p">
              <strong>${escapeHtml(customerLabel || "-")}</strong>
              <div style="opacity:.85; margin-top:4px;">請求期間: ${escapeHtml(formatDateYmd_(batch.period_start))} 〜 ${escapeHtml(formatDateYmd_(batch.period_end))}（${escapeHtml(String(batch.visit_count || 0))}回）</div>
              <div style="opacity:.85; margin-top:4px;">現在の確定合計: ${escapeHtml(formatMoney_(batch.total_amount || 0))}円</div>
              ${legacyMode ? `<div style="margin-top:8px;"><span class="badge badge-warning">旧料金モード${legacyCutoffDate ? `（〜${escapeHtml(legacyCutoffDate)}）` : ""}</span></div>` : ``}
              ${discountAmount > 0 ? `<div style="opacity:.85; margin-top:4px;">${escapeHtml(discountLabel)}: -${escapeHtml(formatMoney_(discountAmount))}円</div>` : ``}
            </div>
          </div>
          <div style="margin-top:10px;">
            ${editorRowsHtml}
            <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
              <div data-action="edit-key-pickup" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 鍵預かり料金</span>
                <strong>${escapeHtml(formatEditorLineAmount_(editorModel?.key_pickup_amount || 0, editorModel?.key_pickup_qty || 1))}</strong>
              </div>
              <div data-action="edit-key-return" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 鍵返却料金</span>
                <strong>${escapeHtml(formatEditorLineAmount_(editorModel?.key_return_amount || 0, editorModel?.key_return_qty || 1))}</strong>
              </div>
              ${(Array.isArray(editorModel?.invoice_extra_lines) ? editorModel.invoice_extra_lines : []).map((line, idx) => `
              <div data-action="edit-invoice-extra" data-extra-index="${escapeHtml(String(idx))}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ ${escapeHtml(String(line?.label || "明細"))}</span>
                <strong>${escapeHtml(formatEditorLineAmount_(line?.amount || 0, line?.qty || 1))}</strong>
              </div>
              `).join("")}
              <div data-action="add-invoice-extra" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>➕ 明細追加</span>
                <strong>未設定</strong>
              </div>
              <div data-action="edit-discount" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 割引</span>
                <strong>${activeDiscountAmount > 0 ? `${escapeHtml(formatMoney_(activeDiscountAmount))}円` : "未設定"}</strong>
              </div>
            </div>
          </div>
          <div class="card" style="margin-top:10px;">
            <div class="p row row-between">
              <strong>合計</strong>
              <strong>${escapeHtml(formatMoney_(editingGrand))}円</strong>
            </div>
            ${activeDiscountAmount > 0 ? `<div class="p" style="opacity:.85; margin-top:4px;">（明細小計 ${escapeHtml(formatMoney_(editingTotal))}円 - ${escapeHtml(activeDiscountLabel)} ${escapeHtml(formatMoney_(activeDiscountAmount))}円）</div>` : ``}
          </div>
        ` : buildDetailReadonlyHtml_(detail)}
      </section>
    `);

    qs("#btnBackToInvoices")?.addEventListener("click", () => {
      window.location.hash = "#/invoices";
    });

    qs("#btnStartItemsInline")?.addEventListener("click", () => {
      const currentStatus = String((detail?.batch || {}).billing_status || "").trim().toLowerCase();
      if (currentStatus === "paid") {
        toast({ title: "編集不可", message: "入金済みのため変更できません。返金後に「未請求に戻す」を実行してください。" });
        return;
      }
      editing = true;
      addForm = null;
      openEditorVisitIds.clear();
      editingDiscountAmount = Math.max(0, Number((detail?.batch || {}).discount_amount || 0) || 0);
      editingDiscountLabel = String((detail?.batch || {}).discount_label || "割引");
      initialDiscountAmount = editingDiscountAmount;
      initialDiscountLabel = String(editingDiscountLabel || "割引").trim() || "割引";
      workingItems = (Array.isArray(detail?.invoice_items) ? detail.invoice_items : []).map(cloneEditorItem_);
      editorModel = buildEditorModel_(detail, links, ruleCatalog, { legacy_mode: legacyMode });
      renderPage_();
    });
    qs("#btnCreateAdjustmentFromBatch")?.addEventListener("click", async () => {
      const linkedVisitIds = links.map((x) => String(x?.visit_id || "").trim()).filter(Boolean);
      if (!linkedVisitIds.length) {
        toast({ title: "対象なし", message: "追加請求の参照元にできる予約がありません。" });
        return;
      }
      enqueuePendingInvoiceRebuild_({
        visit_ids: linkedVisitIds,
        open_batch_detail: true,
        allow_non_unbilled: true,
        allow_inactive: false,
        billing_mode: "adjustment",
        source_batch_id: batchId,
      });
      try {
        const periodStart = String((detail?.batch || {})?.period_start || "").slice(0, 10);
        const periodEnd = String((detail?.batch || {})?.period_end || "").slice(0, 10);
        if (periodStart && periodEnd) {
          sessionStorage.setItem(KEY_VF_STATE, JSON.stringify({
            date_from: periodStart,
            date_to_ymd: periodEnd,
            keyword: "",
            sort_order: "asc",
            done_filter: "open_first",
            active_filter: "active_only",
          }));
        }
      } catch (_) {}
      window.location.hash = "#/visits";
    });
    qs("#btnAttachVisits")?.addEventListener("click", async () => {
      const currentBatch = detail?.batch || {};
      const customerId = String(currentBatch?.customer_id || "").trim();
      const linkedVisitIds = links.map((x) => String(x?.visit_id || "").trim()).filter(Boolean);
      if (!customerId) {
        toast({ title: "対象なし", message: "顧客情報を取得できませんでした。" });
        return;
      }
      let candidates = [];
      try {
        candidates = await runWithBlocking_(
          {
            title: "追加可能な予約を取得しています",
            bodyHtml: "未請求の予約を検索しています。",
            busyText: "取得中..."
          },
          async () => fetchAttachableVisits_(customerId, linkedVisitIds)
        );
      } catch (e) {
        toast({ title: "取得失敗", message: e?.message || String(e) });
        return;
      }
      if (!Array.isArray(candidates) || !candidates.length) {
        toast({ title: "対象なし", message: "紐づけ可能な未請求予約がありません。" });
        return;
      }
      const picked = await showFormModal({
        title: "予約を請求書に紐づけ",
        bodyHtml: buildAttachVisitPickerHtml_(candidates),
        okText: "再構成へ",
        cancelText: "キャンセル",
        formSelector: '[data-el="attachVisitsForm"]',
      });
      if (!picked) return;
      const attachIds = candidates
        .map((row) => String(row?.visit_id || "").trim())
        .filter((vid) => !!vid && String(picked[`attach__${vid}`] || "").toLowerCase() === "on");
      if (!attachIds.length) {
        toast({ title: "未選択", message: "追加する予約を選択してください。" });
        return;
      }
      const nextVisitIds = Array.from(new Set(linkedVisitIds.concat(attachIds)));
      enqueuePendingInvoiceRebuild_({
        visit_ids: nextVisitIds,
        open_batch_detail: true,
        allow_non_unbilled: true,
        allow_inactive: false,
        source_batch_id: batchId,
      });
      await confirmByModal_(
        "再構成準備完了",
        "予約画面で内容を確認して請求書を再作成してください。",
        "予約画面へ",
        "閉じる"
      );
      try {
        const periodStart = String(currentBatch?.period_start || "").slice(0, 10);
        const periodEnd = String(currentBatch?.period_end || "").slice(0, 10);
        if (periodStart && periodEnd) {
          sessionStorage.setItem(KEY_VF_STATE, JSON.stringify({
            date_from: periodStart,
            date_to_ymd: periodEnd,
            keyword: "",
            sort_order: "asc",
            done_filter: "open_first",
            active_filter: "active_only",
          }));
        }
      } catch (_) {}
      window.location.hash = "#/visits";
    });
    qs("#btnCancelItemsInline")?.addEventListener("click", () => {
      editing = false;
      addForm = null;
      openEditorVisitIds.clear();
      workingItems = [];
      renderPage_();
    });
    qs("#btnSaveItemsInline")?.addEventListener("click", async () => {
      const built = buildEditorPayloadFromModel_(editorModel, ruleCatalog, { legacy_mode: legacyMode });
      const payloadItems = Array.isArray(built.items) ? built.items : [];
      if (!payloadItems.length) {
        toast({ title: "入力不足", message: "明細行がありません。すべて除外する場合は、この請求を削除してください。" });
        return;
      }
      const prevDiscount = Math.max(0, Number(initialDiscountAmount || 0) || 0);
      const nextDiscount = Math.max(0, Number(built.discount_amount || 0) || 0);
      const prevDiscountLabel = String(initialDiscountLabel || "割引").trim() || "割引";
      const nextDiscountLabel = String(built.discount_label || "割引").trim() || "割引";
      if (prevDiscount !== nextDiscount || prevDiscountLabel !== nextDiscountLabel) {
        const okReissue = await confirmByModal_(
          "再作成の確認",
          "割引の変更を保存すると、Square側で請求書IDが切り替わります。よろしいですか？",
          "再作成して保存",
          "戻る"
        );
        if (!okReissue) return;
      }
      const currentBillingStatus = String((detail?.batch || {}).billing_status || "").trim().toLowerCase();
      const currentSquareStatus = String((detail?.batch || {}).square_invoice_status || "").trim().toLowerCase();
      if (currentBillingStatus !== "paid" && currentSquareStatus && !isSquareDraftLikeStatus_(currentSquareStatus)) {
        const okPublishedReissue = await confirmByModal_(
          "再発行の確認",
          "送信済みの請求書をキャンセルして再発行します。本当によろしいですか？",
          "再発行して保存",
          "戻る"
        );
        if (!okPublishedReissue) return;
      }
      try {
        await runWithBlocking_(
          {
            title: "請求構成を更新しています",
            bodyHtml: "請求構成を更新しています / Square下書きへ反映中...",
            busyText: "更新中..."
          },
          async () => updateBillingBatchItems_({
            batch_id: batchId,
            items: payloadItems,
            desired_lines: built.desired_lines,
            discount_amount: built.discount_amount,
            discount_label: built.discount_label,
            discount_price_rule_id: built.discount_price_rule_id
          })
        );
        await refreshDetail_();
        editing = false;
        addForm = null;
        openEditorVisitIds.clear();
        workingItems = [];
        editorModel = null;
        toast({ title: "完了", message: "請求構成を更新しました。" });
        renderPage_();
      } catch (e) {
        toast({ title: "更新失敗", message: e?.message || String(e) });
      }
    });

    app.querySelectorAll('[data-action="revert-unbilled"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bid = String(btn.getAttribute("data-batch-id") || "").trim();
        if (!bid) return;
        const ok = await confirmByModal_(
          "請求書を削除",
          "この請求を削除し、対象予約の請求状態を更新します。この操作は、Square請求書の削除を実行しますが、予約自体はキャンセルされません。",
          "削除する",
          "キャンセル"
        );
        if (!ok) return;
        try {
          await runWithBlocking_(
            { title: "請求書を削除しています", bodyHtml: "Square請求書とポータル側の請求データを更新しています...", busyText: "削除中..." },
            async () => revertBillingBatchToUnbilled_(bid)
          );
          await refreshDetail_();
          toast({ title: "完了", message: "請求書を削除しました。" });
          renderPage_();
        } catch (e) {
          toast({ title: "削除失敗", message: e?.message || String(e) });
        }
      });
    });
    app.querySelectorAll('[data-action="mark-refund-not-required"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bid = String(btn.getAttribute("data-batch-id") || "").trim();
        if (!bid) return;
        const ok = await confirmByModal_(
          "返金不要の確認",
          "この請求バッチを「返金不要（確認済み）」にします。よろしいですか？",
          "確定する",
          "キャンセル"
        );
        if (!ok) return;
        try {
          await runWithBlocking_(
            { title: "状態を更新しています", bodyHtml: "返金フォロー状態を更新しています...", busyText: "更新中..." },
            async () => setBillingBatchRefundFollowup_({ batch_id: bid, refund_followup_status: "not_required" })
          );
          await refreshDetail_();
          toast({ title: "完了", message: "返金不要（確認済み）に更新しました。" });
          renderPage_();
        } catch (e) {
          toast({ title: "更新失敗", message: e?.message || String(e) });
        }
      });
    });

    if (!editing) return;
    app.querySelectorAll(".invoice-edit-details").forEach((detailsEl) => {
      detailsEl.addEventListener("toggle", () => {
        const visitId = String(detailsEl.getAttribute("data-visit-id") || "").trim();
        if (!visitId) return;
        if (detailsEl.open) openEditorVisitIds.add(visitId);
        else openEditorVisitIds.delete(visitId);
      });
    });
    app.querySelectorAll('[data-action="edit-base"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const options = ruleCatalog?.byType?.visit_base || [];
        const chosen = await pickRuleByModal_("訪問基本料金を選択", options, "適用しない");
        if (chosen == null || !chosen.price_rule_id) return;
        if (!chosen) return;
        visit.base_rule_id = chosen.price_rule_id;
        visit.base_label = chosen.label;
        visit.base_amount = chosen.amount;
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="exclude-visit-from-invoice"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const ok = await confirmByModal_(
          "この回を除外します",
          "この回に紐づく請求明細を保存時に削除します。予約自体はキャンセルされません。",
          "除外する",
          "戻る"
        );
        if (!ok) return;
        visit.excluded = true;
        openEditorVisitIds.add(vid);
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="restore-visit-from-invoice"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        visit.excluded = false;
        openEditorVisitIds.add(vid);
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-parking"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const amount = await inputAmountByModal_("駐車料金（円 / 0で解除）", visit.parking_amount || 0);
        if (amount == null) return;
        visit.parking_amount = Math.max(0, Number(amount || 0) || 0);
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-travel"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const options = ruleCatalog?.byType?.travel_fee || [];
        const chosen = await pickRuleByModal_("出張料金を選択", options, "適用しない");
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          visit.travel_rule_id = "";
          visit.travel_amount = 0;
        } else {
          visit.travel_rule_id = chosen.price_rule_id;
          visit.travel_amount = chosen.amount;
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-seasonal"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const options = ruleCatalog?.byType?.seasonal_fee || [];
        const chosen = await pickRuleByModal_("繁忙期加算を選択", options, "適用しない");
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          visit.seasonal_rule_id = "";
          visit.seasonal_amount = 0;
        } else {
          visit.seasonal_rule_id = chosen.price_rule_id;
          visit.seasonal_amount = chosen.amount;
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-legacy-headcount"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const options = (ruleCatalog?.byType?.merchandise || []).filter((x) => isLegacyHeadcountLabel_(x?.label));
        const chosen = await pickMerchandiseByModal_(options, visit.legacy_headcount_qty || 1);
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          visit.legacy_headcount_rule_id = "";
          visit.legacy_headcount_label = "";
          visit.legacy_headcount_amount = 0;
          visit.legacy_headcount_qty = 1;
        } else {
          visit.legacy_headcount_rule_id = chosen.price_rule_id;
          visit.legacy_headcount_label = chosen.label;
          visit.legacy_headcount_amount = chosen.amount;
          visit.legacy_headcount_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-legacy-travel"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const amount = await inputAmountByModal_("交通費（往復）（円 / 0で解除）", visit.legacy_travel_amount || 0);
        if (amount == null) return;
        const rid = String(visit.legacy_travel_rule_id || "").trim()
          || String(((ruleCatalog?.byType?.merchandise || []).find((x) => isLegacyTravelLabel_(x?.label)) || {}).price_rule_id || "").trim();
        const label = String(visit.legacy_travel_label || "").trim()
          || String(((ruleCatalog?.byType?.merchandise || []).find((x) => isLegacyTravelLabel_(x?.label)) || {}).label || "交通費（往復）");
        visit.legacy_travel_rule_id = rid;
        visit.legacy_travel_label = label;
        visit.legacy_travel_amount = Math.max(0, Number(amount || 0) || 0);
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-legacy-topping"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const options = (ruleCatalog?.byType?.merchandise || []).filter((x) => isLegacyToppingLabel_(x?.label));
        const chosen = await pickMerchandiseByModal_(options, visit.legacy_topping_qty || 1);
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          visit.legacy_topping_rule_id = "";
          visit.legacy_topping_label = "";
          visit.legacy_topping_amount = 0;
          visit.legacy_topping_qty = 1;
        } else {
          visit.legacy_topping_rule_id = chosen.price_rule_id;
          visit.legacy_topping_label = chosen.label;
          visit.legacy_topping_amount = chosen.amount;
          visit.legacy_topping_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-cancellation-fee"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const chosen = await inputCancellationFeeByModal_({
          label: visit.cancellation_fee_label || "キャンセル料金",
          amount: visit.cancellation_fee_amount || 0,
          qty: visit.cancellation_fee_qty || 1,
        });
        if (chosen == null) return;
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        if (!(amount > 0)) {
          visit.cancellation_fee_rule_id = "";
          visit.cancellation_fee_line_item_id = "";
          visit.cancellation_fee_label = "キャンセル料金";
          visit.cancellation_fee_amount = 0;
          visit.cancellation_fee_qty = 1;
        } else {
          visit.cancellation_fee_rule_id = String(visit.cancellation_fee_rule_id || "").trim();
          visit.cancellation_fee_label = String(chosen.label || "キャンセル料金").trim() || "キャンセル料金";
          visit.cancellation_fee_amount = amount;
          visit.cancellation_fee_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-extra"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const index = Math.max(0, Number(btn.getAttribute("data-extra-index") || 0) || 0);
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const lines = Array.isArray(visit.extra_lines) ? visit.extra_lines : [];
        const current = lines[index] || {};
        const chosen = await inputExtraLineByModal_({
          label: current.label || "",
          amount: current.amount || 0,
          qty: current.qty || 1,
        });
        if (chosen == null) return;
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        if (!(amount > 0)) {
          lines.splice(index, 1);
        } else {
          lines[index] = {
            rule_id: String(current.rule_id || "").trim(),
            line_item_id: String(current.line_item_id || "").trim(),
            label: String(chosen.label || "").trim(),
            amount,
            qty: Math.max(1, Number(chosen.qty || 1) || 1),
          };
        }
        visit.extra_lines = lines;
        const first = lines[0] || {};
        visit.extra_rule_id = String(first.rule_id || "").trim();
        visit.extra_line_item_id = String(first.line_item_id || "").trim();
        visit.extra_label = String(first.label || "").trim();
        visit.extra_amount = Math.max(0, Number(first.amount || 0) || 0);
        visit.extra_qty = Math.max(1, Number(first.qty || 1) || 1);
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="add-extra"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const chosen = await inputExtraLineByModal_({ label: "", amount: 0, qty: 1 });
        if (chosen == null) return;
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        const label = String(chosen.label || "").trim();
        if (!label || !(amount > 0)) return;
        const lines = Array.isArray(visit.extra_lines) ? visit.extra_lines : [];
        lines.push({
          rule_id: "manual:custom",
          line_item_id: "",
          label,
          amount,
          qty: Math.max(1, Number(chosen.qty || 1) || 1),
        });
        visit.extra_lines = lines;
        if (lines.length === 1) {
          visit.extra_rule_id = "manual:custom";
          visit.extra_line_item_id = "";
          visit.extra_label = label;
          visit.extra_amount = amount;
          visit.extra_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-invoice-extra"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const index = Math.max(0, Number(btn.getAttribute("data-extra-index") || 0) || 0);
        const lines = Array.isArray(editorModel?.invoice_extra_lines) ? editorModel.invoice_extra_lines : [];
        const current = lines[index] || {};
        const chosen = await inputExtraLineByModal_({
          label: current.label || "",
          amount: current.amount || 0,
          qty: current.qty || 1,
        });
        if (chosen == null) return;
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        if (!(amount > 0)) {
          lines.splice(index, 1);
        } else {
          lines[index] = {
            rule_id: String(current.rule_id || "").trim(),
            line_item_id: String(current.line_item_id || "").trim(),
            label: String(chosen.label || "").trim(),
            amount,
            qty: Math.max(1, Number(chosen.qty || 1) || 1),
          };
        }
        editorModel.invoice_extra_lines = lines;
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="add-invoice-extra"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const chosen = await inputExtraLineByModal_({ label: "", amount: 0, qty: 1 });
        if (chosen == null) return;
        const amount = Math.max(0, Number(chosen.amount || 0) || 0);
        const label = String(chosen.label || "").trim();
        if (!label || !(amount > 0)) return;
        const lines = Array.isArray(editorModel?.invoice_extra_lines) ? editorModel.invoice_extra_lines : [];
        lines.push({
          rule_id: "manual:custom",
          line_item_id: "",
          label,
          amount,
          qty: Math.max(1, Number(chosen.qty || 1) || 1),
        });
        editorModel.invoice_extra_lines = lines;
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-key-pickup"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const options = ruleCatalog?.byType?.key_pickup_fee || [];
        const chosen = await pickKeyFeeByModal_("鍵預かり料金を選択", options, {
          price_rule_id: editorModel?.key_pickup_rule_id || "",
          qty: editorModel?.key_pickup_qty || 1,
        });
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          editorModel.key_pickup_rule_id = "";
          editorModel.key_pickup_amount = 0;
          editorModel.key_pickup_qty = 1;
        } else {
          editorModel.key_pickup_rule_id = chosen.price_rule_id;
          editorModel.key_pickup_amount = chosen.amount;
          editorModel.key_pickup_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-key-return"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const options = ruleCatalog?.byType?.key_return_fee || [];
        const chosen = await pickKeyFeeByModal_("鍵返却料金を選択", options, {
          price_rule_id: editorModel?.key_return_rule_id || "",
          qty: editorModel?.key_return_qty || 1,
        });
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          editorModel.key_return_rule_id = "";
          editorModel.key_return_amount = 0;
          editorModel.key_return_qty = 1;
        } else {
          editorModel.key_return_rule_id = chosen.price_rule_id;
          editorModel.key_return_amount = chosen.amount;
          editorModel.key_return_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-discount"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const out = await openEditorModal_({
          title: "割引を設定",
          bodyHtml: `
            <div style="display:grid; gap:8px;">
              <label>
                <div class="label-sm">割引額（円）</div>
                <input class="input" data-el="amount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(String((editorModel && editorModel.discount_amount) || editingDiscountAmount || 0))}" />
              </label>
            </div>
          `,
          onSubmit: (root) => {
            const rawAmount = String(root.querySelector('[data-el="amount"]')?.value || "").trim();
            return {
              amount: rawAmount ? Math.max(0, Number(rawAmount) || 0) : 0,
            };
          }
        });
        if (!out) return;
        editingDiscountLabel = "割引";
        const amount = Math.max(0, Number(out.amount || 0) || 0);
        const discountOptions = Array.isArray(ruleCatalog?.byType?.discount) ? ruleCatalog.byType.discount : [];
        const discountPriceRuleId = String(
          (discountOptions.find((x) => Math.max(0, Number(x?.amount || 0) || 0) === amount) || discountOptions[0] || {}).price_rule_id || ""
        ).trim();
        editingDiscountAmount = amount;
        if (editorModel) {
          editorModel.discount_label = editingDiscountLabel;
          editorModel.discount_amount = editingDiscountAmount;
          editorModel.discount_price_rule_id = discountPriceRuleId;
        }
        renderPage_();
      });
    });
  }

  renderPage_();
}

export async function renderInvoicesPage(app, query) {
  const user = getUser() || {};
  const role = String(user.role || "").toLowerCase();
  if (role !== "admin") {
    render(app, `<section class="section"><h1 class="h1">請求書</h1><p class="p">管理者のみ利用できます。</p></section>`);
    return;
  }
  const batchId = String(query.get("id") || "").trim();
  if (batchId) return renderInvoicesDetailPage_(app, batchId);
  return renderInvoicesListPage_(app, query);
}
