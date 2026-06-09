import { buildCancelPolicyMessage_ } from "./visit_cancel_policy.js";
import { confirmCancelPreview_ } from "./visit_cancel_confirm.js";
import { callCancelVisitPolicy } from "./visits_policy.js";
import { escapeHtml, showModal } from "../ui.js";

export async function fetchCancelVisitPreview_(visitId, idToken, options = {}) {
  const vid = String(visitId || "").trim();
  if (!vid) throw new Error("visit_id required");
  const source = String(options.source || "portal").trim() || "portal";
  const cancellationRate = Math.max(0, Number(options.cancellation_rate || 0) || 0);
  if (![0, 50, 100].includes(cancellationRate)) {
    throw new Error("cancellation_rate must be 0/50/100");
  }
  const previewRes = await callCancelVisitPolicy({
    source,
    visit_id: vid,
    cancellation_fee_rate: cancellationRate,
    preview_only: true,
  }, idToken);
  return previewRes || {};
}

export async function runCancelVisitFlow_(visitId, idToken, options = {}) {
  const vid = String(visitId || "").trim();
  if (!vid) throw new Error("visit_id required");
  const source = String(options.source || "portal").trim() || "portal";
  const cancellationRate = Math.max(0, Number(options.cancellation_rate || 0) || 0);
  const currentBillingStatus = String(options.current_billing_status || "unbilled").trim().toLowerCase() || "unbilled";
  if (![0, 50, 100].includes(cancellationRate)) {
    throw new Error("cancellation_rate must be 0/50/100");
  }

  const preview = (options.preview_override && typeof options.preview_override === "object")
    ? options.preview_override
    : (await fetchCancelVisitPreview_(vid, idToken, { source, cancellation_rate: cancellationRate }));
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
      needs_draft: false,
      draft_payload: null,
    };
  }
  const discountDecisionFromOption = (options.discount_decision && typeof options.discount_decision === "object")
    ? options.discount_decision
    : null;
  let discountDecision = discountDecisionFromOption;
  if (!discountDecision) {
    const msg = buildCancelPolicyMessage_(preview);
    discountDecision = await confirmCancelPreview_(preview, msg);
  }
  if (!discountDecision) {
    return {
      skipped: true,
      preview,
      done: null,
      sync_errors: [],
      needs_draft: false,
      draft_payload: null,
    };
  }
  const hasDeferOverride = Object.prototype.hasOwnProperty.call(options, "defer_invoice_draft");
  const deferInvoiceDraft = hasDeferOverride
    ? options.defer_invoice_draft === true
    : (currentBillingStatus !== "paid");

  const doneRes = await callCancelVisitPolicy({
    source,
    visit_id: vid,
    cancellation_fee_rate: cancellationRate,
    defer_invoice_draft: deferInvoiceDraft,
    discount_mode: discountDecision.discount_mode,
    discount_amount: discountDecision.discount_amount,
  }, idToken);
  const done = doneRes || {};
  const syncErrors = Array.isArray(done?.sync_errors) ? done.sync_errors : [];
  const needsDraft = done?.next_action === "create_cancellation_invoice" && currentBillingStatus !== "paid";
  const remainingIds = Array.isArray(done?.remaining_active_visit_ids)
    ? done.remaining_active_visit_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const draftRate = (cancellationRate === 50 || cancellationRate === 100) ? cancellationRate : 0;
  const draftPayload = needsDraft
    ? {
      ids: draftRate > 0 ? [vid] : (remainingIds.length ? remainingIds : [vid]),
      cancellation_rate: draftRate,
      allow_non_unbilled: true,
      allow_inactive: true,
      source_batch_id: String(done?.source_batch_id || preview?.source_batch_id || "").trim(),
      remaining_visit_ids: remainingIds,
      canceled_visit_ids: [vid],
      cancellation_fee_by_visit: { [vid]: Number(done?.cancellation_fee_amount || 0) || 0 },
    }
    : null;

  return {
    skipped: false,
    preview,
    done,
    sync_errors: syncErrors,
    needs_draft: needsDraft,
    draft_payload: draftPayload,
  };
}
