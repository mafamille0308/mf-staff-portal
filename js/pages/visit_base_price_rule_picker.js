import { unwrapResults } from "../api.js";
import { escapeHtml, showSelectModal } from "../ui.js";
import { portalListBillingPriceRules_ } from "./portal_api.js";

export async function pickVisitBasePriceRule_(idToken, currentRuleId, options = {}) {
  const selectId = String(options.selectId || "visitBasePriceRuleSelect").trim() || "visitBasePriceRuleSelect";
  const resp = await portalListBillingPriceRules_(idToken, true);
  const u = unwrapResults(resp);
  const rows = Array.isArray(u?.results) ? u.results : [];
  const list = rows
    .filter((r) => String(r?.item_type || "").trim() === "visit_base")
    .map((r) => ({
      price_rule_id: String(r?.price_rule_id || "").trim(),
      label: String(r?.label || r?.price_rule_id || "").trim(),
      display_order: Number(r?.display_order || 0) || 0
    }))
    .filter((r) => r.price_rule_id);
  list.sort((a, b) => {
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return String(a.label || "").localeCompare(String(b.label || ""), "ja");
  });
  if (!list.length) throw new Error("訪問基本料金の商品が見つかりません。");

  const optionsHtml = list.map((o) => {
    const selected = (String(o.price_rule_id) === String(currentRuleId || "")) ? " selected" : "";
    return `<option value="${escapeHtml(o.price_rule_id)}"${selected}>${escapeHtml(o.label)}（${escapeHtml(o.price_rule_id)}）</option>`;
  }).join("");

  const picked = await showSelectModal({
    title: "訪問基本料金の変更",
    bodyHtml: `
      <div class="p" style="margin-bottom:8px;">適用する商品を選択してください。</div>
      <select id="${escapeHtml(selectId)}" class="select" style="width:100%;">
        ${optionsHtml}
      </select>
    `,
    okText: "変更",
    cancelText: "キャンセル",
    selectId
  });
  if (picked == null) return null;
  const hit = list.find((o) => String(o.price_rule_id) === String(picked));
  return hit || null;
}
