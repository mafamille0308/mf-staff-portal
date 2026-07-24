import { escapeHtml, showSelectModal } from "../ui.js";

const PARKING_FEE_RULE_LABELS = {
  free: "駐車無料",
  paid: "駐車有料",
  unknown: "駐車未設定",
};

function normalizeParkingFeeRule_(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "無料") return "free";
  if (s === "有料") return "paid";
  if (s === "free" || s === "paid") return s;
  return "";
}

export function parkingFeeRuleLabel(key) {
  const k = normalizeParkingFeeRule_(key);
  if (!k) return PARKING_FEE_RULE_LABELS.unknown;
  return PARKING_FEE_RULE_LABELS[k] || PARKING_FEE_RULE_LABELS.unknown;
}

export async function pickParkingFeeRule(currentKey, { title = "駐車料金区分変更", selectId = "mParkingFeeRuleSelect" } = {}) {
  const current = normalizeParkingFeeRule_(currentKey) || "";
  const options = [
    { key: "free", label: "無料" },
    { key: "paid", label: "有料" },
  ];
  const optionsHtml = options.map((o) => {
    const sel = (o.key === current) ? " selected" : "";
    return `<option value="${escapeHtml(o.key)}"${sel}>${escapeHtml(o.label)}（${escapeHtml(o.key)}）</option>`;
  }).join("");
  const bodyHtml = `
    <div class="p" style="margin-bottom:8px;">駐車料金区分を選択してください。</div>
    <select id="${escapeHtml(selectId)}" class="select" style="width:100%;">
      ${optionsHtml}
    </select>
    <div class="p" style="margin-top:8px; opacity:0.8;">
      現在：<strong>${escapeHtml(parkingFeeRuleLabel(current))}</strong>
    </div>
  `;
  const picked = await showSelectModal({
    title,
    bodyHtml,
    okText: "変更",
    cancelText: "キャンセル",
    selectId,
  });
  if (picked == null) return null;
  const next = normalizeParkingFeeRule_(picked);
  return next || "";
}
