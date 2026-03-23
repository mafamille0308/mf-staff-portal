import { escapeHtml, showModal } from "../ui.js";

export async function confirmCancelPreview_(preview, messageText, options = {}) {
  void options;
  const currentDiscount = Math.max(0, Number(preview?.current_discount_amount || 0) || 0);
  const modalMessage = String(messageText || "").trim()
    || "予約キャンセルに伴い、発行済み請求書から当該予約を除いた内容で請求書を作成し、差し替えます。";
  const ok = await showModal({
    title: "キャンセル内容の確認",
    bodyHtml: `<p class="p">${escapeHtml(modalMessage)}</p>`,
    okText: "確定",
    cancelText: "戻る",
  });
  if (!ok) return null;
  return { discount_mode: "keep", discount_amount: currentDiscount };
}
