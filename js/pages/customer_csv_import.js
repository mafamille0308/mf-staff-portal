import { getIdToken, getUser, setActiveStoreContext_ } from "../auth.js";
import { escapeHtml, render, toast } from "../ui.js";
import { portalCustomersCsvImportCommit_, portalCustomersCsvImportDryRun_ } from "./portal_api.js";
import { runWithBlocking_ } from "./page_async_helpers.js";

const CSV_HEADERS_ = [
  "姓", "名", "姓かな", "名かな", "電話", "緊急連絡先", "メール", "請求先メール",
  "郵便番号", "都道府県", "市区町村", "町域・番地", "建物・部屋", "駐車場", "メモ", "登録日",
];

function requestId_() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `csv_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function downloadTemplate_() {
  const csv = `\uFEFF${CSV_HEADERS_.join(",")}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "customer_import_template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

async function fileToBase64_(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function statusLabel_(status) {
  return ({ ready: "登録可能", warning: "確認必要", error: "登録不可", imported: "登録済み", failed: "失敗" })[status] || status;
}

function resultTable_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  return `<div class="csv-import-results mt-14">
    <div class="csv-import-result-head" aria-hidden="true">
      <span>対象</span><span>行</span><span>氏名</span><span>電話</span><span>メール</span><span>判定</span><span>内容</span>
    </div>
    ${list.map((row) => {
      const customer = row.customer || {};
      const status = row.status || row.result_status || "";
      const reasons = []
        .concat(Array.isArray(row.errors) ? row.errors : [])
        .concat(Array.isArray(row.warnings) ? row.warnings : [])
        .concat(Array.isArray(row.reasons_json) ? row.reasons_json : []);
      const canSelect = status === "ready" || status === "warning";
      const rowNumber = Number(row.row_number) || "";
      return `<div class="csv-import-result-row">
        <div class="csv-import-select">${canSelect ? `<input type="checkbox" data-row-select="${rowNumber}" ${status === "ready" ? "checked" : ""} aria-label="${rowNumber}行目を登録">` : "-"}</div>
        <div class="csv-import-line"><span class="csv-import-mobile-label">行</span>${rowNumber}</div>
        <div class="csv-import-name"><span class="csv-import-mobile-label">氏名</span>${escapeHtml(`${customer.surname || ""} ${customer.given || ""}`.trim())}</div>
        <div class="csv-import-phone"><span class="csv-import-mobile-label">電話</span>${escapeHtml(customer.phone || "-")}</div>
        <div class="csv-import-email"><span class="csv-import-mobile-label">メール</span>${escapeHtml(customer.email || "-")}</div>
        <div class="csv-import-status" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel_(status))}</div>
        <div class="csv-import-reasons"><span class="csv-import-mobile-label">内容</span>${escapeHtml(reasons.join(" / ") || "-")}</div>
      </div>`;
    }).join("")}
  </div>`;
}

export async function renderCustomerCsvImport(appEl, query = new URLSearchParams()) {
  const user = getUser() || {};
  if (String(user.role || "").toLowerCase() !== "admin") {
    render(appEl, `<section class="section"><h1 class="h1">顧客CSV取込</h1><p class="p">管理者のみ利用できます。</p></section>`);
    return;
  }
  const accessibleStores = Array.isArray(user?.authz?.accessible_stores) ? user.authz.accessible_stores : [];
  const requestedStoreId = String(query.get("store_id") || user.store_id || "").trim();
  const targetStore = accessibleStores.find((store) => String(store?.store_id || "").trim() === requestedStoreId)
    || (requestedStoreId === String(user.store_id || "").trim() ? { store_id: requestedStoreId, store_name: user.store_name } : null);
  if (!requestedStoreId || !targetStore) {
    render(appEl, `<section class="section"><h1 class="h1">顧客CSV取込</h1><p class="p">対象店舗を確認できません。店舗設定から開き直してください。</p></section>`);
    return;
  }
  const targetStoreName = String(targetStore.store_name || targetStore.name || requestedStoreId).trim();
  if (requestedStoreId !== String(user.store_id || "").trim()) {
    setActiveStoreContext_(requestedStoreId, targetStoreName);
    return;
  }
  const settingsHref = `#/settings?area=business&page=store_detail&store_id=${encodeURIComponent(requestedStoreId)}`;
  let selectedFile = null;
  let fileBase64 = "";
  let dryRun = null;
  let selectedStage = "本登録";
  let committed = false;

  const draw_ = () => {
    const counts = dryRun?.counts || {};
    render(appEl, `<section class="section csv-import-page">
      <div class="row row-between csv-import-page-head"><h1 class="h1">顧客CSV取込</h1><a class="btn btn-ghost" href="${settingsHref}">店舗設定に戻る</a></div>
      <p class="p">対象店舗: <strong>${escapeHtml(targetStoreName)}</strong></p>
      <div class="row mt-10">
        <button class="btn btn-ghost" type="button" data-action="download-template">テンプレートをダウンロード</button>
      </div>
      <div class="hr"></div>
      <div class="p"><strong>登録ステージ</strong></div>
      <div class="row mt-8" role="group" aria-label="登録ステージ">
        <label><input type="radio" name="csv-stage" value="本登録" ${selectedStage === "本登録" ? "checked" : ""} ${dryRun ? "disabled" : ""}> 本登録</label>
        <label><input type="radio" name="csv-stage" value="仮登録" ${selectedStage === "仮登録" ? "checked" : ""} ${dryRun ? "disabled" : ""}> 仮登録</label>
      </div>
      <div class="p mt-14"><strong>CSVファイル</strong></div>
      <div class="row mt-8 csv-import-file-row">
        <input class="input" type="file" accept=".csv,text/csv" data-role="csv-file" ${dryRun ? "disabled" : ""}>
        <button class="btn" type="button" data-action="dry-run" ${dryRun ? "disabled" : ""}>内容を確認</button>
      </div>
      ${dryRun ? `<div class="hr"></div>
        <div class="row csv-import-counts"><strong>確認結果</strong><span>登録可能 ${Number(counts.ready || 0)}件</span><span>確認必要 ${Number(counts.warning || 0)}件</span><span>登録不可 ${Number(counts.error || 0)}件</span></div>
        ${resultTable_(dryRun.rows)}
        <div class="row row-between mt-14 csv-import-actions">
          <button class="btn btn-ghost" type="button" data-action="reset">やり直す</button>
          ${committed ? `<a class="btn" href="#/customers">顧客一覧へ</a>` : `<button class="btn" type="button" data-action="commit">選択した顧客を登録</button>`}
        </div>` : ""}
    </section>`);
    bind_();
  };

  const bind_ = () => {
    appEl.querySelector('[data-action="download-template"]')?.addEventListener("click", downloadTemplate_);
    appEl.querySelector('[data-role="csv-file"]')?.addEventListener("change", async (event) => {
      selectedFile = event.target.files?.[0] || null;
      fileBase64 = selectedFile ? await fileToBase64_(selectedFile) : "";
      dryRun = null;
    });
    appEl.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
      selectedFile = null;
      fileBase64 = "";
      dryRun = null;
      committed = false;
      draw_();
    });
    appEl.querySelector('[data-action="dry-run"]')?.addEventListener("click", async () => {
      if (!selectedFile || !fileBase64) {
        toast({ title: "ファイル未選択", message: "CSVファイルを選択してください。" });
        return;
      }
      selectedStage = appEl.querySelector('input[name="csv-stage"]:checked')?.value || "本登録";
      try {
        dryRun = await runWithBlocking_(
          { title: "CSVを確認しています", bodyHtml: "入力内容と重複を確認しています。", busyText: "確認中..." },
          () => portalCustomersCsvImportDryRun_(getIdToken(), {
            request_id: requestId_(), file_name: selectedFile.name, file_base64: fileBase64, stage: selectedStage,
          })
        );
        if (!dryRun || dryRun.ok === false || dryRun.success === false) throw new Error(dryRun?.error || "CSVの確認に失敗しました。");
        draw_();
      } catch (error) {
        toast({ title: "確認失敗", message: error?.message || String(error) });
      }
    });
    appEl.querySelector('[data-action="commit"]')?.addEventListener("click", async () => {
      const selectedRows = Array.from(appEl.querySelectorAll("[data-row-select]:checked")).map((el) => Number(el.dataset.rowSelect));
      if (!selectedRows.length) {
        toast({ title: "対象未選択", message: "登録する顧客を選択してください。" });
        return;
      }
      const warningRows = new Set((dryRun?.rows || []).filter((row) => row.status === "warning").map((row) => Number(row.row_number)));
      const acceptedWarnings = selectedRows.filter((rowNumber) => warningRows.has(rowNumber));
      try {
        const result = await runWithBlocking_(
          { title: "顧客を登録しています", bodyHtml: "選択した顧客を登録しています。", busyText: "登録中..." },
          () => portalCustomersCsvImportCommit_(getIdToken(), {
            request_id: requestId_(), import_id: dryRun.import_id, file_name: selectedFile.name,
            file_base64: fileBase64, selected_rows: selectedRows, accepted_name_match_rows: acceptedWarnings,
          })
        );
        if (!result || result.ok === false || result.success === false) throw new Error(result?.error || "CSV取込に失敗しました。");
        const originalByRow = new Map((dryRun?.rows || []).map((row) => [Number(row.row_number), row]));
        const mergedRows = (result.rows || []).map((row) => Object.assign({}, originalByRow.get(Number(row.row_number)) || {}, row, {
          status: row.result_status,
        }));
        dryRun = Object.assign({}, dryRun, { rows: mergedRows, counts: { ready: result.imported_rows || 0, warning: 0, error: result.failed_rows || 0 } });
        committed = true;
        draw_();
        toast({ title: "取込完了", message: `登録 ${Number(result.imported_rows || 0)}件 / 失敗 ${Number(result.failed_rows || 0)}件` });
      } catch (error) {
        toast({ title: "取込失敗", message: error?.message || String(error) });
      }
    });
  };

  draw_();
}
