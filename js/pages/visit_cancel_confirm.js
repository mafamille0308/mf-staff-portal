import { escapeHtml, showModal } from "../ui.js";

export async function confirmCancelPreview_(preview, messageText, options = {}) {
  void options;
  const currentDiscount = Math.max(0, Number(preview?.current_discount_amount || 0) || 0);
  const statusRaw = String(preview?.billing_status || "").trim().toLowerCase();
  const isDraftStatus = ["draft", "invoice_draft", "pending", "unpaid"].includes(statusRaw);
  const isBilledStatus = ["billed", "invoicing", "invoiced", "sent", "scheduled", "partially_paid", "published"].includes(statusRaw);
  const modalMessage = String(messageText || "").trim()
    || "予約キャンセルに伴い、発行済み請求書から当該予約を除いた内容で請求書を作成し、差し替えます。";
  const title = isDraftStatus
    ? "下書き更新の確認"
    : (isBilledStatus ? "送付済み請求の再発行確認" : "キャンセル内容の確認");
  const okText = isDraftStatus
    ? "下書きを更新"
    : (isBilledStatus ? "再発行して続行" : "確定");
  const ok = await showModal({
    title,
    bodyHtml: `<p class="p">${escapeHtml(modalMessage)}</p>`,
    okText,
    cancelText: "戻る",
  });
  if (!ok) return null;
  return { discount_mode: "keep", discount_amount: currentDiscount };
}
