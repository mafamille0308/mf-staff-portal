import { escapeHtml, showModal } from "../ui.js";

function showCancelReasonModal_({ title, bodyHtml, okText, cancelText } = {}) {
  const host = document.querySelector("#modalHost");
  if (!host) return Promise.resolve(null);
  host.classList.remove("is-hidden");
  host.setAttribute("aria-hidden", "false");
  host.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-title">${escapeHtml(title || "")}</div>
      <div class="m-body">
        ${bodyHtml || ""}
        <label style="display:block; margin-top:12px;">
          <div class="label-sm">キャンセル理由</div>
          <textarea class="input" data-el="deleteReason" rows="3" placeholder="例：お客様都合、日程変更、体調不良など"></textarea>
        </label>
      </div>
      <div class="m-actions">
        <button class="btn btn-ghost" id="mCancel" type="button">${escapeHtml(cancelText || "戻る")}</button>
        <button class="btn btn-danger" id="mOk" type="button">${escapeHtml(okText || "予約をキャンセル")}</button>
      </div>
    </div>
  `;
  return new Promise((resolve) => {
    const cleanup = () => {
      host.classList.add("is-hidden");
      host.setAttribute("aria-hidden", "true");
      host.innerHTML = "";
    };
    host.querySelector("#mCancel")?.addEventListener("click", () => { cleanup(); resolve(null); });
    host.querySelector("#mOk")?.addEventListener("click", () => {
      const reason = String(host.querySelector('[data-el="deleteReason"]')?.value || "").trim();
      cleanup();
      resolve({ delete_reason: reason || "cancelled" });
    });
    host.addEventListener("click", (e) => {
      if (e.target === host) { cleanup(); resolve(null); }
    }, { once: true });
  });
}

export async function confirmCancelPreview_(preview, messageText, options = {}) {
  const currentDiscount = Math.max(0, Number(preview?.current_discount_amount || 0) || 0);
  const modalMessage = String(messageText || "").trim()
    || "予約をキャンセルします。請求書やSquare請求書は変更されません。キャンセル料の請求が必要な場合は、店舗ルールに沿って管理者へ共有してください。";
  const title = "予約キャンセルの確認";
  const okText = "予約をキャンセル";
  if (options?.with_reason === false) {
    const ok = await showModal({
      title,
      bodyHtml: `<p class="p">${escapeHtml(modalMessage)}</p>`,
      okText,
      cancelText: "戻る",
      danger: true,
    });
    if (!ok) return null;
    return { discount_mode: "keep", discount_amount: currentDiscount, delete_reason: "cancelled" };
  }
  const res = await showCancelReasonModal_({
    title,
    bodyHtml: `<p class="p">${escapeHtml(modalMessage)}</p>`,
    okText,
    cancelText: "戻る",
  });
  if (!res) return null;
  return { discount_mode: "keep", discount_amount: currentDiscount, delete_reason: res.delete_reason || "cancelled" };
}
