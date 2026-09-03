import { escapeHtml } from "../ui.js";
import { formatMoney_ } from "./page_format_helpers.js";

export function openEditorModal_(opts) {
  const title = String(opts?.title || "編集");
  const bodyHtml = String(opts?.bodyHtml || "");
  const okText = String(opts?.okText || "確定");
  const cancelText = String(opts?.cancelText || "キャンセル");
  const onSubmit = typeof opts?.onSubmit === "function" ? opts.onSubmit : (() => null);
  const onOpen = typeof opts?.onOpen === "function" ? opts.onOpen : null;
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
  if (onOpen) {
    try { onOpen(root); } catch (_) {}
  }
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

export async function inputDiscountByModal_(current, options) {
  const opts = Array.isArray(options) ? options : [];
  const cur = current || {};
  const currentRuleId = String(cur.price_rule_id || "").trim();
  const currentAmount = Math.max(0, Number(cur.amount || 0) || 0);
  const currentLabel = String(cur.label || "割引").trim() || "割引";
  const hasSelectedRule = !!currentRuleId && opts.some((o) => String(o?.price_rule_id || "").trim() === currentRuleId);
  const initialMode = (hasSelectedRule || (opts.length > 0 && !(currentAmount > 0) && currentLabel === "割引")) ? "master" : "free";
  const optionHtml = opts.map((o) => {
    const rid = String(o?.price_rule_id || "").trim();
    const label = String(o?.label || rid).trim();
    const amount = Math.max(0, Number(o?.amount || 0) || 0);
    return `<option value="${escapeHtml(rid)}" data-amount="${escapeHtml(String(amount))}" data-label="${escapeHtml(label)}" ${rid === currentRuleId ? "selected" : ""}>${escapeHtml(label)}（${escapeHtml(formatMoney_(amount))}円）</option>`;
  }).join("");
  const out = await openEditorModal_({
    title: "割引",
    bodyHtml: `
      <div style="display:grid; gap:10px;">
        ${opts.length ? `
          <div>
            <div class="label-sm">追加方法</div>
            <select class="input" data-el="mode">
              <option value="master" ${initialMode === "master" ? "selected" : ""}>料金マスタから選択</option>
              <option value="free" ${initialMode === "free" ? "selected" : ""}>自由入力で追加</option>
            </select>
          </div>
          <div data-el="masterFields">
            <div class="label-sm">割引商品</div>
            <select class="input" data-el="ruleId">
              ${optionHtml}
            </select>
          </div>
        ` : `
          <input type="hidden" data-el="modeFree" value="free" />
          <div class="p">割引商品が未登録のため、自由入力で設定します。</div>
        `}
        <div data-el="freeFields">
          <div class="label-sm">表示名</div>
          <input class="input" data-el="label" type="text" value="${escapeHtml(currentLabel)}" placeholder="例：紹介割引" />
        </div>
        <div>
          <div class="label-sm">割引額</div>
          <div class="row gap-8">
            <input class="input text-right" data-el="amount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(currentAmount > 0 ? String(currentAmount) : "")}" placeholder="金額を入力" />
            <span>円</span>
          </div>
        </div>
      </div>
    `,
    onOpen: (root) => {
      const modeSelect = root.querySelector('[data-el="mode"]');
      const ruleSelect = root.querySelector('[data-el="ruleId"]');
      const masterFields = root.querySelector('[data-el="masterFields"]');
      const freeFields = root.querySelector('[data-el="freeFields"]');
      const amountInput = root.querySelector('[data-el="amount"]');
      const applyMode_ = () => {
        const master = String(modeSelect?.value || (opts.length ? "master" : "free")).trim() === "master";
        if (masterFields) masterFields.style.display = master ? "" : "none";
        if (freeFields) freeFields.style.display = master ? "none" : "";
      };
      const applyRule_ = () => {
        const opt = ruleSelect?.selectedOptions?.[0];
        const amount = String(opt?.dataset?.amount || "").trim();
        if (amountInput && amount) amountInput.value = amount;
      };
      modeSelect?.addEventListener("change", () => { applyMode_(); applyRule_(); });
      ruleSelect?.addEventListener("change", applyRule_);
      applyMode_();
      if (initialMode === "master" && !(currentAmount > 0)) applyRule_();
    },
    onSubmit: (root) => {
      const master = String(root.querySelector('[data-el="mode"]')?.value || "").trim() === "master";
      const amount = Math.max(0, Number(root.querySelector('[data-el="amount"]')?.value || 0) || 0);
      if (master) {
        const rid = String(root.querySelector('[data-el="ruleId"]')?.value || "").trim();
        const chosen = opts.find((o) => String(o?.price_rule_id || "").trim() === rid) || null;
        if (!chosen) return { price_rule_id: "", label: "割引", amount };
        return {
          price_rule_id: rid,
          label: String(chosen.label || "割引").trim() || "割引",
          amount,
        };
      }
      return {
        price_rule_id: "",
        label: String(root.querySelector('[data-el="label"]')?.value || "割引").trim() || "割引",
        amount,
      };
    }
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
