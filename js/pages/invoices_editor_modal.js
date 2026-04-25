import { escapeHtml } from "../ui.js";
import { formatMoney_ } from "./page_format_helpers.js";

export function openEditorModal_(opts) {
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

export async function confirmByModal_(title, message, okText = "実行", cancelText = "キャンセル") {
  const out = await openEditorModal_({
    title: String(title || "確認"),
    bodyHtml: `<div class="p">${escapeHtml(String(message || ""))}</div>`,
    okText: String(okText || "実行"),
    cancelText: String(cancelText || "キャンセル"),
    onSubmit: () => true
  });
  return out === true;
}

export async function pickRuleByModal_(title, options, noneLabel) {
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

export async function inputAmountByModal_(title, current) {
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

export async function pickMerchandiseByModal_(options, currentQty) {
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
