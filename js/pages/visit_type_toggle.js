// js/pages/visit_type_toggle.js
import { callGas, unwrapResults } from "../api.js";
import { showSelectModal, escapeHtml } from "../ui.js";

/**
 * 訪問タイプ切替（共通）
 * - バッジタップ → モーダル選択 → Optimistic UI → updateVisit で確定
 *
 * NOTE:
 * - 既存の visit_done_toggle.js と同じ思想で「API呼び出しを薄く」しつつ、
 *   visits_list / visit_detail の UI 差異はコールバックで吸収する。
 */

const VISIT_TYPE_LABELS_FALLBACK = {
  sitting: "シッティング",
  training: "トレーニング",
  meeting_free: "打ち合わせ（無料）",
  meeting_paid: "打ち合わせ（有料）",
};

let _visitTypeOptionsCache = null; // [{ type, label }]
let _visitTypeLabelMapCache = null; // { [type]: label }

export function visitTypeLabel(key) {
  const k = String(key || "").trim();
  if (!k) return "訪問種別未設定";
  if (_visitTypeLabelMapCache && _visitTypeLabelMapCache[k]) return _visitTypeLabelMapCache[k];
  return VISIT_TYPE_LABELS_FALLBACK[k] || k;
}

export async function ensureVisitTypeOptions(idToken) {
  if (_visitTypeOptionsCache && _visitTypeLabelMapCache) {
    return { options: _visitTypeOptionsCache, labelMap: _visitTypeLabelMapCache };
  }
  try {
    const resp = await callGas({ action: "getVisitTypeOptions" }, idToken);
    const u = unwrapResults(resp);
    const results = (u && Array.isArray(u.results)) ? u.results : [];
    const options = [];
    const map = {};
    for (const x of results) {
      const kk = String(x?.type || x?.key || x?.value || "").trim();
      const ll = String(x?.label || x?.name || "").trim();
      if (!kk) continue;
      const label = ll || kk;
      options.push({ type: kk, label });
      map[kk] = label;
    }
    _visitTypeOptionsCache = options.length ? options : Object.keys(VISIT_TYPE_LABELS_FALLBACK).map((k) => ({ type: k, label: VISIT_TYPE_LABELS_FALLBACK[k] }));
    _visitTypeLabelMapCache = Object.keys(map).length ? map : { ...VISIT_TYPE_LABELS_FALLBACK };
  } catch (_) {
    _visitTypeOptionsCache = Object.keys(VISIT_TYPE_LABELS_FALLBACK).map((k) => ({ type: k, label: VISIT_TYPE_LABELS_FALLBACK[k] }));
    _visitTypeLabelMapCache = { ...VISIT_TYPE_LABELS_FALLBACK };
  }
  return { options: _visitTypeOptionsCache, labelMap: _visitTypeLabelMapCache };
}

export async function updateVisitType(idToken, visitId, visitType) {
  const resp = await callGas({
    action: "updateVisit",
    visit_id: visitId,
    fields: { visit_type: String(visitType || "").trim() || "sitting" }
  }, idToken);

  // updateVisit は { updated } を返すが、unwrap/中間層差異があり得るため安全に吸収する
  const raw = resp || {};
  const cand =
    raw.updated ||
    raw.result?.updated ||
    raw.result ||
    raw.visit ||
    raw;
  // さらに { success, updated:{...} } 形を吸収
  return (cand && cand.updated && typeof cand.updated === "object") ? cand.updated : cand;
}

async function selectVisitType_(idToken, currentType) {
  const { options } = await ensureVisitTypeOptions(idToken);
  const selectId = "visitTypeSelect";
  const optsHtml = (options || []).map((o) => {
    const t = String(o?.type || "").trim();
    const l = String(o?.label || t).trim();
    const sel = (String(currentType || "").trim() === t) ? " selected" : "";
    return `<option value="${escapeHtml(t)}"${sel}>${escapeHtml(l)}</option>`;
  }).join("");

  const bodyHtml = `
    <div style="display:flex; flex-direction:column; gap:8px;">
      <div style="opacity:0.85;">訪問タイプを選択してください。</div>
      <select id="${escapeHtml(selectId)}" class="input">
        ${optsHtml}
      </select>
    </div>
  `;

  const v = await showSelectModal({
    title: "訪問タイプ変更",
    bodyHtml,
    okText: "変更",
    cancelText: "キャンセル",
    selectId
  });

  return v ? String(v).trim() : null;
}

/**
 * 共通トグル実行（UI差分はコールバックで吸収）
 */
export async function toggleVisitType({
  idToken,
  visitId,
  currentType,
  applyOptimistic,
  applyFinal,
  revertOptimistic
}) {
  const next = await selectVisitType_(idToken, currentType);
  if (!next) return { ok: false, cancelled: true };
  if (String(next) === String(currentType || "")) return { ok: false, cancelled: true };

  const nextLabel = visitTypeLabel(next);
  try {
    applyOptimistic && applyOptimistic(next, nextLabel);

    const updated = await updateVisitType(idToken, visitId, next);
    applyFinal && applyFinal(updated);
    return { ok: true, updated };
  } catch (e) {
    try { revertOptimistic && revertOptimistic(); } catch (_) {}
    throw e;
  }
}