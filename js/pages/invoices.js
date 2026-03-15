import { render, qs, escapeHtml, toast, openBlockingOverlay } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken, getUser } from "../auth.js";

const BILLING_STATUS_KEYS = ["unbilled", "billed", "paid"];

function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  return Promise.resolve()
    .then(() => task(blocker))
    .finally(() => blocker.close());
}

function billingStatusLabel_(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "unbilled") return "未請求";
  if (s === "billed" || s === "invoicing" || s === "invoiced" || s === "sent" || s === "scheduled") return "請求済";
  if (s === "paid") return "入金済";
  return s || "-";
}

function formatMoney_(n) {
  const v = Number(n || 0) || 0;
  return v.toLocaleString("ja-JP");
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

async function fetchBillingBatches_(filters) {
  const token = getIdToken();
  const payload = {
    action: "listBillingBatches",
    billing_status: String(filters?.billing_status || "").trim()
  };
  const res = await callGas(payload, token);
  return Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
}

async function fetchBillingBatchDetail_(batchId) {
  const token = getIdToken();
  return callGas({ action: "getBillingBatchDetail", batch_id: String(batchId || "").trim() }, token);
}

async function revertBillingBatchToUnbilled_(batchId) {
  const token = getIdToken();
  return callGas({ action: "revertBillingBatchToUnbilled", batch_id: String(batchId || "").trim() }, token);
}

async function fetchPricePreview_(priceRuleId, visitDate) {
  const token = getIdToken();
  return callGas({
    action: "getBillingPricePreview",
    price_rule_id: String(priceRuleId || "").trim(),
    visit_date: String(visitDate || "").trim()
  }, token);
}

async function fetchAllPriceRules_() {
  const token = getIdToken();
  const res = await callGas({ action: "listBillingPriceRules", only_active: false }, token);
  return Array.isArray(res?.results) ? res.results : [];
}

function renderBillingListCard_(b) {
  const x = b || {};
  const periodStart = x.period_start ? formatDateYmd_(x.period_start) : "-";
  const periodEnd = x.period_end ? formatDateYmd_(x.period_end) : "-";
  return `
    <button class="card invoice-batch-row" type="button" data-action="open-detail" data-batch-id="${escapeHtml(String(x.batch_id || ""))}">
      <div class="p">
        <div class="row row-between" style="gap:8px;">
          <strong>${escapeHtml(String(x.customer_name || "-"))}</strong>
          <span class="badge">${escapeHtml(billingStatusLabel_(x.billing_status))}</span>
        </div>
        <div style="opacity:.85; margin-top:6px;">請求期間: ${escapeHtml(periodStart)} 〜 ${escapeHtml(periodEnd)}（${escapeHtml(String(x.visit_count || 0))}回）</div>
        <div style="opacity:.85; margin-top:6px;">合計金額: ${escapeHtml(formatMoney_(x.total_amount || 0))}円</div>
        <div style="opacity:.85; margin-top:6px;">Square請求書ID: ${escapeHtml(String(x.square_invoice_id || "-"))}</div>
      </div>
    </button>
  `;
}

async function renderInvoicesListPage_(app, query) {
  let billingStatus = String(query.get("status") || "").trim().toLowerCase();
  if (!BILLING_STATUS_KEYS.includes(billingStatus)) billingStatus = "";
  let keyword = String(query.get("q") || "").trim();
  let rows = [];
  render(app, `<section class="section"><p class="p">請求バッチを読み込み中…</p></section>`);
  try {
    rows = await runWithBlocking_(
      { title: "請求バッチを読み込んでいます", bodyHtml: "一覧を取得しています。", busyText: "読み込み中..." },
      async () => fetchBillingBatches_({ billing_status: billingStatus })
    );
  } catch (e) {
    render(app, `<section class="section"><h1 class="h1">請求バッチ</h1><p class="p">${escapeHtml(e?.message || String(e))}</p></section>`);
    return;
  }

  function renderPage_() {
    const filtered = rows.filter((x) => {
      const text = [
        String(x?.customer_name || ""),
        String(x?.square_invoice_id || ""),
        String(x?.memo || "")
      ].join(" ").toLowerCase();
      return !keyword || text.includes(keyword.toLowerCase());
    });
    render(app, `
      <section class="section">
        <div class="row row-between">
          <h1 class="h1">請求バッチ一覧</h1>
          <button id="btnReloadInvoices" class="btn btn-ghost" type="button">更新</button>
        </div>
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
              <option value="billed" ${billingStatus === "billed" ? "selected" : ""}>請求済</option>
              <option value="paid" ${billingStatus === "paid" ? "selected" : ""}>入金済</option>
            </select>
          </label>
        </div>
        <div class="p" style="margin-top:8px;">表示件数: ${escapeHtml(String(filtered.length))}</div>
        <div id="invoiceBatchList" style="margin-top:10px;">${filtered.map(renderBillingListCard_).join("") || `<div class="p">条件に一致する請求バッチがありません。</div>`}</div>
      </section>
    `);
    qs("#btnReloadInvoices")?.addEventListener("click", async () => {
      rows = await fetchBillingBatches_({ billing_status: billingStatus });
      renderPage_();
    });
    qs("#invoiceFilterKeyword")?.addEventListener("input", (ev) => {
      keyword = String(ev?.target?.value || "");
      renderPage_();
    });
    qs("#invoiceFilterStatus")?.addEventListener("change", async (ev) => {
      billingStatus = String(ev?.target?.value || "").trim();
      const u = new URL(window.location.href);
      if (billingStatus) u.hash = `#/invoices?status=${encodeURIComponent(billingStatus)}`;
      else u.hash = "#/invoices";
      rows = await fetchBillingBatches_({ billing_status: billingStatus });
      renderPage_();
    });
    qs("#invoiceBatchList")?.addEventListener("click", (ev) => {
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
  const squareStatus = String(batch?.square_invoice_status || "").trim().toLowerCase();
  const refundDetectedByStatus = (squareStatus === "refunded" || squareStatus === "partially_refunded");
  const refundDetected = !!batch?.refund_detected || refundDetectedByStatus;
  const refundKindRaw = String(batch?.refund_kind || "").trim().toLowerCase();
  const refundKind = refundKindRaw || (squareStatus === "partially_refunded" ? "partial" : (squareStatus === "refunded" ? "full" : ""));
  const showRevertButton = refundDetected && refundKind === "full";
  const refundNotice = refundDetected
    ? (refundKind === "partial"
      ? "一部返金が検知されました。Square側で確認してください。"
      : "全額返金が検知されました。再請求が必要な場合は未請求に戻してください。予約キャンセルの場合は、予約を無効に変更してください。")
    : "";
  return `
    <div class="card">
      <div class="p">
        <div class="row row-between">
          <div>
            <div><strong>${escapeHtml(String(batch.customer_name || "-"))}</strong></div>
            <div style="opacity:.85; margin-top:4px;">請求期間: ${escapeHtml(periodStart)} 〜 ${escapeHtml(periodEnd)}（${escapeHtml(String(batch.visit_count || 0))}回）</div>
            <div style="opacity:.85; margin-top:4px;">合計金額: ${escapeHtml(formatMoney_(batch.total_amount || 0))}円</div>
            ${discountAmount > 0 ? `<div style="opacity:.85; margin-top:4px;">${escapeHtml(discountLabel)}: -${escapeHtml(formatMoney_(discountAmount))}円</div>` : ``}
            <div style="opacity:.85; margin-top:4px;">ステータス: <span class="badge">${escapeHtml(billingStatusLabel_(batch.billing_status))}</span></div>
            <div style="opacity:.85; margin-top:4px;">Square状態: ${escapeHtml(String(batch.square_invoice_status || "-"))}</div>
            <div style="opacity:.85; margin-top:4px;">バッチID: ${escapeHtml(String(batch.batch_id || "-"))}</div>
            ${refundDetected ? `<div style="margin-top:8px; color:#ffd4a3;">${escapeHtml(refundNotice)}</div>` : ``}
          </div>
          <div>
            ${batch.square_invoice_url ? `<a class="btn btn-ghost" target="_blank" rel="noopener noreferrer" href="${escapeHtml(String(batch.square_invoice_url || ""))}">Square請求書を開く ↗</a>` : ``}
            ${showRevertButton ? `<button class="btn btn-ghost" type="button" data-action="revert-unbilled" data-batch-id="${escapeHtml(String(batch.batch_id || ""))}" style="margin-top:8px;">未請求に戻す</button>` : ``}
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
            return `
              <div class="row row-between" style="gap:12px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
                <div>
                  <div><strong>${escapeHtml(String(link?.visit_id || "-"))}</strong></div>
                  <div style="opacity:.85; margin-top:4px;">${escapeHtml(formatVisitSummaryDate_(visit?.start_time, visit?.start_time))}</div>
                  <div style="opacity:.85; margin-top:4px;">${escapeHtml(String(visit?.title || "-"))}</div>
                </div>
                <div>${escapeHtml(formatMoney_(link?.subtotal || 0))}円</div>
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
  const direct = String((ruleCatalog?.byId?.[rid] || {}).item_type || "").trim();
  if (direct) return direct;
  const label = String(row?.label || "").trim();
  if (label.includes("鍵預かり")) return "key_pickup_fee";
  if (label.includes("鍵返却")) return "key_return_fee";
  if (label.includes("駐車")) return "parking_fee";
  if (label.includes("出張")) return "travel_fee";
  if (label.includes("繁忙")) return "seasonal_fee";
  return "custom";
}

function amountTextInline_(n, empty = "未設定") {
  const v = Math.max(0, Number(n || 0) || 0);
  return v > 0 ? `${formatMoney_(v)}円` : empty;
}

function openEditorModal_(opts) {
  const title = String(opts?.title || "編集");
  const bodyHtml = String(opts?.bodyHtml || "");
  const okText = String(opts?.okText || "確定");
  const cancelText = String(opts?.cancelText || "キャンセル");
  const onSubmit = typeof opts?.onSubmit === "function" ? opts.onSubmit : (() => null);
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "1300";
  root.style.background = "rgba(0,0,0,.45)";
  root.style.display = "grid";
  root.style.placeItems = "center";
  root.innerHTML = `
    <div class="card" style="width:min(560px,92vw); max-height:80vh; overflow:auto;">
      <div class="p">
        <div style="margin-bottom:8px;"><strong>${escapeHtml(title)}</strong></div>
        ${bodyHtml}
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:10px;">
          <button type="button" class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn" data-act="ok">${escapeHtml(okText)}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  return new Promise((resolve) => {
    const close_ = (v) => {
      try { root.remove(); } catch (_) {}
      resolve(v);
    };
    root.querySelector('[data-act="cancel"]')?.addEventListener("click", () => close_(null));
    root.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
      try { close_(onSubmit(root)); } catch (_) { close_(null); }
    });
    root.addEventListener("click", (e) => { if (e.target === root) close_(null); });
  });
}

async function confirmByModal_(title, message, okText = "実行", cancelText = "キャンセル") {
  const out = await openEditorModal_({
    title: String(title || "確認"),
    bodyHtml: `<div class="p">${escapeHtml(String(message || ""))}</div>`,
    okText: String(okText || "実行"),
    cancelText: String(cancelText || "キャンセル"),
    onSubmit: () => true
  });
  return out === true;
}

async function pickRuleByModal_(title, options, noneLabel) {
  const opts = Array.isArray(options) ? options : [];
  const html = `
    <select class="input" data-el="opt" style="width:100%;">
      <option value="">${escapeHtml(String(noneLabel || "適用しない"))}</option>
      ${opts.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}">${escapeHtml(String(o.label || ""))}（${escapeHtml(formatMoney_(o.amount || 0))}円）</option>`).join("")}
    </select>
  `;
  const pickedId = await openEditorModal_({
    title,
    bodyHtml: html,
    onSubmit: (root) => String(root.querySelector('[data-el="opt"]')?.value || "").trim()
  });
  if (pickedId == null) return null;
  const chosen = opts.find((o) => String(o?.price_rule_id || "").trim() === String(pickedId || "").trim()) || null;
  return chosen || { price_rule_id: "", label: "", amount: 0 };
}

async function inputAmountByModal_(title, current) {
  const out = await openEditorModal_({
    title,
    bodyHtml: `
      <div style="display:flex; align-items:center; gap:8px;">
        <input class="input" data-el="amount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(String(Math.max(0, Number(current || 0) || 0)))}" />
        <span>円</span>
      </div>
    `,
    onSubmit: (root) => Math.max(0, Number(root.querySelector('[data-el="amount"]')?.value || 0) || 0)
  });
  return out == null ? null : out;
}

async function pickMerchandiseByModal_(options, currentQty) {
  const opts = Array.isArray(options) ? options : [];
  const out = await openEditorModal_({
    title: "一般商品を選択",
    bodyHtml: `
      <div style="display:grid; gap:8px;">
        <div>
          <div class="label-sm">商品</div>
          <select class="input" data-el="opt">
            <option value="">適用しない</option>
            ${opts.map((o) => `<option value="${escapeHtml(String(o.price_rule_id || ""))}">${escapeHtml(String(o.label || ""))}（${escapeHtml(formatMoney_(o.amount || 0))}円）</option>`).join("")}
          </select>
        </div>
        <div>
          <div class="label-sm">数量</div>
          <input class="input" data-el="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(String(Math.max(1, Number(currentQty || 1) || 1)))}" />
        </div>
      </div>
    `,
    onSubmit: (root) => {
      const rid = String(root.querySelector('[data-el="opt"]')?.value || "").trim();
      if (!rid) return { price_rule_id: "", label: "", amount: 0, qty: 1 };
      const chosen = opts.find((o) => String(o?.price_rule_id || "").trim() === rid) || null;
      if (!chosen) return null;
      return {
        price_rule_id: rid,
        label: String(chosen.label || "").trim(),
        amount: Math.max(0, Number(chosen.amount || 0) || 0),
        qty: Math.max(1, Number(root.querySelector('[data-el="qty"]')?.value || 1) || 1)
      };
    }
  });
  return out == null ? null : out;
}

function buildEditorModel_(detail, links, ruleCatalog) {
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
    const extra = byVisit.find((x) => !["visit_base", "parking_fee", "travel_fee", "seasonal_fee"].includes(asItemType_(x, ruleCatalog))) || null;
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
      extra_rule_id: String(extra?.price_rule_id || "").trim(),
      extra_label: String(extra?.label || "").trim(),
      extra_amount: Math.max(0, Number(extra?.unit_price_snapshot || 0) || 0),
      extra_qty: 1
    };
  });
  const bookingRows = sourceRows.filter((x) => !String(x?.visit_id || "").trim());
  const keyPickup = bookingRows.find((x) => asItemType_(x, ruleCatalog) === "key_pickup_fee") || null;
  const keyReturn = bookingRows.find((x) => asItemType_(x, ruleCatalog) === "key_return_fee") || null;
  return {
    visits: visitRows,
    key_pickup_rule_id: String(keyPickup?.price_rule_id || "").trim(),
    key_pickup_amount: Math.max(0, Number(keyPickup?.unit_price_snapshot || 0) || 0),
    key_return_rule_id: String(keyReturn?.price_rule_id || "").trim(),
    key_return_amount: Math.max(0, Number(keyReturn?.unit_price_snapshot || 0) || 0),
    discount_amount: Math.max(0, Number(detail?.batch?.discount_amount || 0) || 0),
    discount_label: String(detail?.batch?.discount_label || "割引").trim() || "割引"
  };
}

function buildEditorPayloadFromModel_(model, ruleCatalog) {
  const m = model || {};
  const visits = Array.isArray(m.visits) ? m.visits : [];
  const items = [];
  const lineMap = {};
  const addLine_ = (priceRuleId, label, unitPrice, qty) => {
    const rid = String(priceRuleId || "").trim();
    const lb = String(label || "").trim() || rid;
    const unit = Math.max(0, Number(unitPrice || 0) || 0);
    const quantity = Math.max(0, Number(qty || 0) || 0);
    if (!lb || !(unit > 0) || !(quantity > 0)) return;
    const key = `${rid}@@${lb}@@${unit}`;
    if (!lineMap[key]) {
      lineMap[key] = { id: "", square_line_item_uid: "", price_rule_id: rid, label: lb, quantity: 0, unit_price_snapshot: unit };
    }
    lineMap[key].quantity += quantity;
  };
  visits.forEach((v) => {
    const vid = String(v?.visit_id || "").trim();
    if (!vid) return;
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
    if (v.extra_rule_id && Number(v.extra_amount || 0) > 0) {
      const qty = Math.max(1, Number(v.extra_qty || 1) || 1);
      const lb = String(v.extra_label || (ruleCatalog?.byId?.[v.extra_rule_id] || {}).label || "商品").trim();
      items.push({ id: "", visit_id: vid, price_rule_id: v.extra_rule_id, invoice_line_item_id: "", is_cancelled: false });
      addLine_(v.extra_rule_id, lb, v.extra_amount, qty);
    }
  });
  if (m.key_pickup_rule_id && Number(m.key_pickup_amount || 0) > 0) {
    const lb = (ruleCatalog?.byId?.[m.key_pickup_rule_id] || {}).label || "鍵預かり料金";
    items.push({ id: "", visit_id: "", price_rule_id: m.key_pickup_rule_id, invoice_line_item_id: "", is_cancelled: false });
    addLine_(m.key_pickup_rule_id, lb, m.key_pickup_amount, 1);
  }
  if (m.key_return_rule_id && Number(m.key_return_amount || 0) > 0) {
    const lb = (ruleCatalog?.byId?.[m.key_return_rule_id] || {}).label || "鍵返却料金";
    items.push({ id: "", visit_id: "", price_rule_id: m.key_return_rule_id, invoice_line_item_id: "", is_cancelled: false });
    addLine_(m.key_return_rule_id, lb, m.key_return_amount, 1);
  }
  return {
    items,
    desired_lines: Object.keys(lineMap).map((k) => lineMap[k]),
    discount_amount: Math.max(0, Number(m.discount_amount || 0) || 0),
    discount_label: String(m.discount_label || "割引").trim() || "割引"
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
  render(app, `<section class="section"><p class="p">請求バッチ詳細を読み込み中…</p></section>`);
  try {
    detail = await runWithBlocking_(
      { title: "請求バッチ詳細を読み込んでいます", bodyHtml: "詳細情報を取得しています。", busyText: "読み込み中..." },
      async () => fetchBillingBatchDetail_(batchId)
    );
  } catch (e) {
    render(app, `<section class="section"><h1 class="h1">請求バッチ詳細</h1><p class="p">${escapeHtml(e?.message || String(e))}</p></section>`);
    return;
  }
  if (!detail?.batch) {
    render(app, `<section class="section"><h1 class="h1">請求バッチ詳細</h1><p class="p">対象データが見つかりません。</p></section>`);
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
          const sub = Math.max(0, Number(v.base_amount || 0) || 0)
            + Math.max(0, Number(v.parking_amount || 0) || 0)
            + Math.max(0, Number(v.travel_amount || 0) || 0)
            + Math.max(0, Number(v.seasonal_amount || 0) || 0)
            + (Math.max(1, Number(v.extra_qty || 1) || 1) * Math.max(0, Number(v.extra_amount || 0) || 0));
          return sum + sub;
        }, 0) : 0)
        + Math.max(0, Number(editorModel?.key_pickup_amount || 0) || 0)
        + Math.max(0, Number(editorModel?.key_return_amount || 0) || 0)
      : sourceRows.filter((r) => !r._deleted).reduce((sum, r) => sum + (Number(r.unit_price_snapshot || 0) || 0), 0);
    const activeDiscountAmount = editing ? editingDiscountAmount : discountAmount;
    const activeDiscountLabel = editing ? editingDiscountLabel : discountLabel;
    const editingGrand = Math.max(0, editingTotal - activeDiscountAmount);
    const editorRowsHtml = editing ? (Array.isArray(editorModel?.visits) ? editorModel.visits.map((v) => {
      const subtotal = Math.max(0, Number(v.base_amount || 0) || 0)
        + Math.max(0, Number(v.parking_amount || 0) || 0)
        + Math.max(0, Number(v.travel_amount || 0) || 0)
        + Math.max(0, Number(v.seasonal_amount || 0) || 0)
        + (Math.max(1, Number(v.extra_qty || 1) || 1) * Math.max(0, Number(v.extra_amount || 0) || 0));
      const travelLabel = v.travel_rule_id ? (((ruleCatalog.byId[v.travel_rule_id] || {}).label || "出張料金")) : "出張料金";
      const seasonalLabel = v.seasonal_rule_id ? (((ruleCatalog.byId[v.seasonal_rule_id] || {}).label || "繁忙期加算")) : "繁忙期加算";
      return `
        <div style="margin-top:8px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
          <div style="font-weight:700;">${escapeHtml(String(v.title || v.visit_id || "-"))} ${escapeHtml(formatMoney_(subtotal))}円</div>
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
          <div data-action="edit-extra" data-visit-id="${escapeHtml(v.visit_id)}" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
            <span>➕ 商品追加</span>
            <strong>${escapeHtml(v.extra_amount > 0 ? `${formatMoney_(v.extra_amount)}円` : "未設定")}</strong>
          </div>
        </div>
      `;
    }).join("") : "") : "";

    render(app, `
      <section class="section">
        <div class="row row-between">
          <button class="btn btn-ghost" id="btnBackToInvoices" type="button">← 一覧に戻る</button>
          <div class="row">
            ${editing
              ? `<button class="btn" id="btnSaveItemsInline" type="button">保存</button><button class="btn btn-ghost" id="btnCancelItemsInline" type="button">キャンセル</button>`
              : `<button class="btn btn-ghost" id="btnStartItemsInline" type="button">請求構成を編集</button>`}
          </div>
        </div>
        ${editing ? `
          <div class="card" style="margin-top:10px;">
            <div class="p">
              <strong>${escapeHtml(String(batch.customer_name || "-"))}</strong>
              <div style="opacity:.85; margin-top:4px;">請求期間: ${escapeHtml(formatDateYmd_(batch.period_start))} 〜 ${escapeHtml(formatDateYmd_(batch.period_end))}（${escapeHtml(String(batch.visit_count || 0))}回）</div>
              <div style="opacity:.85; margin-top:4px;">現在の確定合計: ${escapeHtml(formatMoney_(batch.total_amount || 0))}円</div>
              ${discountAmount > 0 ? `<div style="opacity:.85; margin-top:4px;">${escapeHtml(discountLabel)}: -${escapeHtml(formatMoney_(discountAmount))}円</div>` : ``}
            </div>
          </div>
          <div style="margin-top:10px;">
            ${editorRowsHtml}
            <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
              <div data-action="edit-key-pickup" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 鍵預かり料金</span>
                <strong>${escapeHtml(amountTextInline_(editorModel?.key_pickup_amount || 0, "未設定"))}</strong>
              </div>
              <div data-action="edit-key-return" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 0; cursor:pointer;">
                <span>🔄️ 鍵返却料金</span>
                <strong>${escapeHtml(amountTextInline_(editorModel?.key_return_amount || 0, "未設定"))}</strong>
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
      editingDiscountAmount = Math.max(0, Number((detail?.batch || {}).discount_amount || 0) || 0);
      editingDiscountLabel = String((detail?.batch || {}).discount_label || "割引");
      initialDiscountAmount = editingDiscountAmount;
      initialDiscountLabel = String(editingDiscountLabel || "割引").trim() || "割引";
      workingItems = (Array.isArray(detail?.invoice_items) ? detail.invoice_items : []).map(cloneEditorItem_);
      editorModel = buildEditorModel_(detail, links, ruleCatalog);
      renderPage_();
    });
    qs("#btnCancelItemsInline")?.addEventListener("click", () => {
      editing = false;
      addForm = null;
      workingItems = [];
      renderPage_();
    });
    qs("#btnSaveItemsInline")?.addEventListener("click", async () => {
      const built = buildEditorPayloadFromModel_(editorModel, ruleCatalog);
      const payloadItems = Array.isArray(built.items) ? built.items : [];
      if (!payloadItems.length) {
        toast({ title: "入力不足", message: "明細行がありません。" });
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
      try {
        await runWithBlocking_(
          {
            title: "請求構成を更新しています",
            bodyHtml: "請求構成を更新しています / Square下書きへ反映中...",
            busyText: "更新中..."
          },
          async () => callGas({
            action: "updateBillingBatchItems",
            batch_id: batchId,
            items: payloadItems,
            desired_lines: built.desired_lines,
            discount_amount: built.discount_amount,
            discount_label: built.discount_label
          }, getIdToken())
        );
        await refreshDetail_();
        editing = false;
        addForm = null;
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
          "未請求に戻す確認",
          "この請求を未請求に戻します。よろしいですか？",
          "未請求に戻す",
          "キャンセル"
        );
        if (!ok) return;
        try {
          await runWithBlocking_(
            { title: "未請求に戻しています", bodyHtml: "請求データをリセットしています...", busyText: "更新中..." },
            async () => revertBillingBatchToUnbilled_(bid)
          );
          await refreshDetail_();
          toast({ title: "完了", message: "未請求に戻しました。" });
          renderPage_();
        } catch (e) {
          toast({ title: "失敗", message: e?.message || String(e) });
        }
      });
    });

    if (!editing) return;
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
    app.querySelectorAll('[data-action="edit-extra"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const vid = String(btn.getAttribute("data-visit-id") || "").trim();
        const visit = (editorModel?.visits || []).find((x) => String(x.visit_id || "") === vid);
        if (!visit) return;
        const options = ruleCatalog?.byType?.merchandise || [];
        const chosen = await pickMerchandiseByModal_(options, visit.extra_qty || 1);
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          visit.extra_rule_id = "";
          visit.extra_label = "";
          visit.extra_amount = 0;
          visit.extra_qty = 1;
        } else {
          visit.extra_rule_id = chosen.price_rule_id;
          visit.extra_label = chosen.label;
          visit.extra_amount = chosen.amount;
          visit.extra_qty = Math.max(1, Number(chosen.qty || 1) || 1);
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-key-pickup"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const options = ruleCatalog?.byType?.key_pickup_fee || [];
        const chosen = await pickRuleByModal_("鍵預かり料金を選択", options, "適用しない");
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          editorModel.key_pickup_rule_id = "";
          editorModel.key_pickup_amount = 0;
        } else {
          editorModel.key_pickup_rule_id = chosen.price_rule_id;
          editorModel.key_pickup_amount = chosen.amount;
        }
        renderPage_();
      });
    });
    app.querySelectorAll('[data-action="edit-key-return"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const options = ruleCatalog?.byType?.key_return_fee || [];
        const chosen = await pickRuleByModal_("鍵返却料金を選択", options, "適用しない");
        if (chosen == null) return;
        if (!chosen.price_rule_id) {
          editorModel.key_return_rule_id = "";
          editorModel.key_return_amount = 0;
        } else {
          editorModel.key_return_rule_id = chosen.price_rule_id;
          editorModel.key_return_amount = chosen.amount;
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
                <div class="label-sm">割引名</div>
                <input class="input" data-el="label" type="text" value="${escapeHtml(String((editorModel && editorModel.discount_label) || editingDiscountLabel || "割引"))}" />
              </label>
              <label>
                <div class="label-sm">割引額（円）</div>
                <input class="input" data-el="amount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(String((editorModel && editorModel.discount_amount) || editingDiscountAmount || 0))}" />
              </label>
            </div>
          `,
          onSubmit: (root) => ({
            label: String(root.querySelector('[data-el="label"]')?.value || "割引").trim() || "割引",
            amount: Math.max(0, Number(root.querySelector('[data-el="amount"]')?.value || 0) || 0),
          })
        });
        if (!out) return;
        editingDiscountLabel = String(out.label || "割引").trim() || "割引";
        const amount = Math.max(0, Number(out.amount || 0) || 0);
        editingDiscountAmount = amount;
        if (editorModel) {
          editorModel.discount_label = editingDiscountLabel;
          editorModel.discount_amount = editingDiscountAmount;
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
