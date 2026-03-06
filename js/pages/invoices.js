// js/pages/invoices.js
import { render, qs, escapeHtml, toast, openBlockingOverlay, showFormModal } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken, getUser } from "../auth.js";

let _billingRules = [];

async function fetchBillingBatchesPageData_(batchId) {
  const token = getIdToken();
  const batchesRes = await callGas({ action: "listBillingBatches" }, token);
  const batches = Array.isArray(batchesRes?.results) ? batchesRes.results : (Array.isArray(batchesRes) ? batchesRes : []);
  let detail = null;
  if (String(batchId || "").trim()) {
    detail = await callGas({ action: "getBillingBatchDetail", batch_id: String(batchId || "").trim() }, token);
  }
  return { batches, detail };
}

function batchStatusLabel_(status) {
  const s = String(status || "").trim();
  if (s === "invoice_draft" || s === "draft") return "請求ドラフト";
  if (s === "sent") return "送信済";
  if (s === "paid") return "支払済";
  if (s === "canceled") return "取消";
  if (s === "voided") return "Void";
  if (s === "refunded") return "返金済";
  return s || "-";
}

function billingBatchRowHtml_(batch) {
  const x = batch || {};
  return `
    <button class="card" type="button" data-action="batch-detail" data-batch-id="${escapeHtml(String(x.batch_id || ""))}" style="margin-top:8px; width:100%; text-align:left;">
      <div class="p">
        <div><strong>${escapeHtml(String(x.batch_id || "-"))}</strong> <span class="badge">${escapeHtml(batchStatusLabel_(x.batch_status))}</span></div>
        <div style="opacity:.8; margin-top:4px;">${escapeHtml(String(x.customer_name || "-"))}</div>
        <div style="opacity:.8; margin-top:4px;">Square: ${escapeHtml(String(x.square_invoice_status || x.square_invoice_id || "-"))}</div>
        <div style="opacity:.8; margin-top:4px;">${escapeHtml(String(x.memo || "-"))}</div>
      </div>
    </button>
  `;
}

function billingBatchDetailHtml_(detail) {
  const batch = detail?.batch || {};
  const links = Array.isArray(detail?.links) ? detail.links : [];
  return `
    <div class="card">
      <div class="p">
        <div class="row row-between" style="gap:12px; align-items:flex-start;">
          <div>
            <div><strong>${escapeHtml(String(batch.batch_id || "-"))}</strong> <span class="badge">${escapeHtml(batchStatusLabel_(batch.batch_status))}</span></div>
            <div style="opacity:.8; margin-top:4px;">${escapeHtml(String(batch.customer_name || "-"))}</div>
            <div style="opacity:.8; margin-top:4px;">Square Invoice ID: ${escapeHtml(String(batch.square_invoice_id || "-"))}</div>
            <div style="opacity:.8; margin-top:4px;">Square Status: ${escapeHtml(String(batch.square_invoice_status || "-"))}</div>
          </div>
          <button class="btn" type="button" data-action="update-square-state" data-batch-id="${escapeHtml(String(batch.batch_id || ""))}">Square状態更新</button>
        </div>
        <div style="margin-top:12px;"><strong>メモ</strong></div>
        <div style="opacity:.9; white-space:pre-wrap;">${escapeHtml(String(batch.memo || "-"))}</div>
        <div style="margin-top:12px;"><strong>対象予約</strong></div>
        <div style="display:grid; gap:8px; margin-top:8px;">
          ${links.map((link) => {
            const visit = link?.visit || {};
            const amount = Number(link?.estimated_amount || visit?.invoice_line_amount || 0) || 0;
            return `
              <div class="row row-between" style="gap:12px; padding:8px 0; border-top:1px solid rgba(255,255,255,0.08);">
                <div>
                  <div><strong>${escapeHtml(String(link?.visit_id || "-"))}</strong> <span class="badge">${escapeHtml(batchStatusLabel_(link?.billing_status))}</span></div>
                  <div style="opacity:.8; margin-top:4px;">${escapeHtml(formatVisitSummaryDate_(visit?.start_time, visit?.start_time || visit?.visit_date))}</div>
                  <div style="opacity:.8; margin-top:4px;">${escapeHtml(String(visit?.product_name || visit?.service_name || "-"))}</div>
                </div>
                <div>${escapeHtml(formatMoney_(amount))}円</div>
              </div>
            `;
          }).join("") || `<div>対象予約がありません。</div>`}
        </div>
      </div>
    </div>
  `;
}

async function renderBillingBatchesPage_(app, query) {
  const batchIdFromQuery = String(query.get("id") || "").trim();
  let batches = [];
  let detail = null;
  render(app, `<section class="section"><p class="p">請求バッチを読み込み中…</p></section>`);
  try {
    const initialData = await runWithBlocking_(
      {
        title: "請求バッチを読み込んでいます",
        bodyHtml: "Square連携用の請求バッチ情報を取得しています。",
        busyText: "読み込み中..."
      },
      async () => fetchBillingBatchesPageData_(batchIdFromQuery)
    );
    batches = initialData.batches;
    detail = initialData.detail;
  } catch (e) {
    render(app, `<section class="section"><h1 class="h1">請求書</h1><p class="p">${escapeHtml(e?.message || String(e))}</p></section>`);
    return;
  }

  function renderPage_() {
    render(app, `
      <section class="section">
        <div class="row row-between" style="align-items:center;">
          <h1 class="h1">請求バッチ</h1>
          <button id="btnReloadInvoicesPage" class="btn btn-ghost" type="button">一覧更新</button>
        </div>
        <div id="invoicePageList" style="margin-top:12px;">${batches.map(billingBatchRowHtml_).join("") || `<p class="p">請求バッチがありません。</p>`}</div>
        <div id="invoicePageDetail" style="margin-top:12px;">${detail ? billingBatchDetailHtml_(detail) : `<div class="card"><div class="p">一覧から請求バッチを選択してください。</div></div>`}</div>
      </section>
    `);

    qs("#btnReloadInvoicesPage")?.addEventListener("click", async () => {
      const next = await fetchBillingBatchesPageData_(detail?.batch?.batch_id || "");
      batches = next.batches;
      detail = next.detail;
      renderPage_();
    });

    qs("#invoicePageList")?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest('[data-action="batch-detail"]');
      if (!btn) return;
      const batchId = String(btn.dataset.batchId || "").trim();
      if (!batchId) return;
      try {
        detail = await runWithBlocking_(
          {
            title: "請求バッチを読み込んでいます",
            bodyHtml: "Square連携用の請求バッチ詳細を取得しています。",
            busyText: "読み込み中..."
          },
          async () => callGas({ action: "getBillingBatchDetail", batch_id: batchId }, getIdToken())
        );
        history.replaceState(null, "", `#/invoices?id=${encodeURIComponent(batchId)}`);
        renderPage_();
      } catch (e) {
        toast({ title: "読込失敗", message: e?.message || String(e) });
      }
    });

    qs("#invoicePageDetail")?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest('[data-action="update-square-state"]');
      if (!btn) return;
      const batchId = String(btn.dataset.batchId || "").trim();
      if (!batchId) return;
      const formValues = await showFormModal({
        title: "Square状態更新",
        bodyHtml: `
          <form data-el="billingBatchSquareStateForm">
            <label>
              <div style="opacity:.85; margin-bottom:4px;"><strong>Square Invoice ID</strong></div>
              <input class="input" type="text" name="square_invoice_id" value="${escapeHtml(String(detail?.batch?.square_invoice_id || ""))}" />
            </label>
            <label style="display:block; margin-top:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>Square Status</strong></div>
              <input class="input" type="text" name="square_invoice_status" value="${escapeHtml(String(detail?.batch?.square_invoice_status || ""))}" placeholder="draft / sent / paid ..." />
            </label>
            <label style="display:block; margin-top:10px;">
              <div style="opacity:.85; margin-bottom:4px;"><strong>Square URL</strong></div>
              <input class="input" type="text" name="square_invoice_url" value="${escapeHtml(String(detail?.batch?.square_invoice_url || ""))}" />
            </label>
          </form>
        `,
        okText: "更新",
        cancelText: "キャンセル",
        formSelector: '[data-el="billingBatchSquareStateForm"]'
      });
      if (formValues == null) return;
      try {
        detail = await runWithBlocking_(
          {
            title: "Square状態を更新しています",
            bodyHtml: "請求バッチと予約の請求ステータスを更新しています。",
            busyText: "更新中..."
          },
          async () => callGas({ action: "updateBillingBatchSquareState", batch_id: batchId, ...formValues }, getIdToken())
        );
        const next = await fetchBillingBatchesPageData_(batchId);
        batches = next.batches;
        detail = next.detail;
        toast({ title: "完了", message: "Square状態を更新しました。" });
        renderPage_();
      } catch (e) {
        toast({ title: "更新失敗", message: e?.message || String(e) });
      }
    });
  }

  renderPage_();
}
function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  return Promise.resolve()
    .then(() => task(blocker))
    .finally(() => blocker.close());
}

function formatMoney_(n) {
  const v = Number(n || 0) || 0;
  return v.toLocaleString("ja-JP");
}

function formatDateTimeYmdHm_(v) {
  if (!v) return "-";
  const s = String(v || "").trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const timeMs = Date.parse(s);
  if (!Number.isNaN(timeMs)) {
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date(timeMs));
    const pick = (type) => (parts.find((x) => x.type === type) || {}).value || "";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
  }
  return s || "-";
}

function formatVisitSummaryDate_(startTime, visitDate) {
  const s = String(startTime || "").trim();
  if (s) return formatDateTimeYmdHm_(s);
  const d = String(visitDate || "").trim();
  return d ? formatDateTimeYmdHm_(d) : "-";
}
export async function renderInvoicesPage(app, query) {
  const user = getUser() || {};
  const role = String(user.role || "").toLowerCase();
  if (role !== "admin") {
    render(app, `<section class="section"><h1 class="h1">請求書</h1><p class="p">管理者のみ利用できます。</p></section>`);
    return;
  }
  return renderBillingBatchesPage_(app, query);
}


