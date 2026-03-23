import { escapeHtml, showModal } from "../ui.js";
import { callReactivateVisitPolicy } from "./visits_policy.js";

function normalizeReactivateVisitIds_(visitId, rawIds) {
  const baseId = String(visitId || "").trim();
  const list = Array.isArray(rawIds)
    ? rawIds.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (baseId && !list.includes(baseId)) list.unshift(baseId);
  return Array.from(new Set(list));
}

export async function fetchReactivateVisitPreview_(visitId, idToken, options = {}) {
  const vid = String(visitId || "").trim();
  if (!vid) throw new Error("visit_id required");
  const source = String(options.source || "portal").trim() || "portal";
  const reactivateVisitIds = normalizeReactivateVisitIds_(vid, options.reactivate_visit_ids);
  const previewRes = await callReactivateVisitPolicy({
    source,
    visit_id: vid,
    preview_only: true,
    reactivate_visit_ids: reactivateVisitIds,
  }, idToken);
  return previewRes || {};
}

export async function runReactivateVisitFlow_(visitId, idToken, options = {}) {
  const vid = String(visitId || "").trim();
  if (!vid) throw new Error("visit_id required");
  const source = String(options.source || "portal").trim() || "portal";
  const reactivateVisitIds = normalizeReactivateVisitIds_(vid, options.reactivate_visit_ids);
  const preview = (options.preview_override && typeof options.preview_override === "object")
    ? options.preview_override
    : (await fetchReactivateVisitPreview_(vid, idToken, { source, reactivate_visit_ids: reactivateVisitIds }));
  const skipConfirm = options.skip_confirm === true;
  const showBlockedModal = options.show_blocked_modal !== false;
  const previewMessage = String(preview?.message || "").trim() || "この予約を再有効化します。よろしいですか？";

  if (preview?.blocked) {
    if (showBlockedModal) {
      await showModal({
        title: "再有効化できません",
        bodyHtml: `<p class="p">${escapeHtml(previewMessage)}</p>`,
        okText: "閉じる",
        cancelText: null,
      });
    }
    return { skipped: true, preview, done: null };
  }
  if (!skipConfirm && preview?.require_confirm) {
    const ok = await showModal({
      title: "確認",
      bodyHtml: `<p class="p">${escapeHtml(previewMessage)}</p>`,
      okText: "変更",
      cancelText: "キャンセル",
    });
    if (!ok) return { skipped: true, preview, done: null };
  }

  const doneRes = await callReactivateVisitPolicy({
    source,
    visit_id: vid,
    preview_only: false,
    reactivate_visit_ids: reactivateVisitIds,
  }, idToken);
  const done = doneRes || {};
  if (done && done.success === false) {
    throw new Error(done.error || done.message || "更新に失敗しました。");
  }
  return { skipped: false, preview, done };
}
