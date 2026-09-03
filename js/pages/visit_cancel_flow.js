import { confirmCancelPreview_ } from "./visit_cancel_confirm.js";
import { callCancelVisitPolicy } from "./visits_policy.js";
import { escapeHtml, showModal } from "../ui.js";

export async function fetchCancelVisitPreview_(visitId, idToken, options = {}) {
  const vid = String(visitId || "").trim();
  if (!vid) throw new Error("visit_id required");
  const source = String(options.source || "portal").trim() || "portal";
  const previewRes = await callCancelVisitPolicy({
    source,
    visit_id: vid,
    cancellation_fee_rate: 0,
    preview_only: true,
  }, idToken);
  return previewRes || {};
}

export async function runCancelVisitFlow_(visitId, idToken, options = {}) {
  const vid = String(visitId || "").trim();
  if (!vid) throw new Error("visit_id required");
  const source = String(options.source || "portal").trim() || "portal";

  const preview = (options.preview_override && typeof options.preview_override === "object")
    ? options.preview_override
    : (await fetchCancelVisitPreview_(vid, idToken, { source }));
  const showBlockedModal = options.show_blocked_modal !== false;
  if (preview?.blocked === true) {
    if (showBlockedModal) {
      await showModal({
        title: preview?.admin_required ? "管理者権限が必要です" : "キャンセルできません",
        bodyHtml: `<p class="p">${escapeHtml(String(preview?.message || "この操作は実行できません。"))}</p>`,
        okText: "閉じる",
        cancelText: null,
      });
    }
    return {
      skipped: true,
      blocked: true,
      message: String(preview?.message || "").trim(),
      preview,
      done: null,
      sync_errors: [],
    };
  }
  const discountDecisionFromOption = (options.discount_decision && typeof options.discount_decision === "object")
    ? options.discount_decision
    : null;
  let discountDecision = discountDecisionFromOption;
  if (!discountDecision) {
    const msg = "予約をキャンセルします。請求書やSquare請求書は変更されません。キャンセル料の請求が必要な場合は、店舗ルールに沿って管理者へ共有してください。";
    discountDecision = await confirmCancelPreview_(preview, msg);
  }
  if (!discountDecision) {
    return {
      skipped: true,
      preview,
      done: null,
      sync_errors: [],
    };
  }

  const doneRes = await callCancelVisitPolicy({
    source,
    visit_id: vid,
    cancellation_fee_rate: 0,
    delete_reason: String(discountDecision.delete_reason || options.delete_reason || "cancelled").trim() || "cancelled",
  }, idToken);
  const done = doneRes || {};
  const syncErrors = Array.isArray(done?.sync_errors) ? done.sync_errors : [];

  return {
    skipped: false,
    preview,
    done,
    sync_errors: syncErrors,
  };
}
