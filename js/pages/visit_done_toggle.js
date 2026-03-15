// js/pages/visit_done_toggle.js
import { callGas, unwrapResults } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

/**
 * done(完了/未完了) 更新の共通処理（UIなし）
 * - updateVisit を叩いて ctx 反映 → 返却差分を返す
 * - toast / modal / optimistic は呼び出し側で扱う
 */
export async function updateVisitDone({ visitId, nextDone }) {
  const vid = String(visitId || "").trim();
  if (!vid) return { ok: false, error: "visit_id が不正です。" };

  const idToken = getIdToken();
  if (!idToken) return { ok: false, error: "not authed" };

  let raw;
  try {
    raw = await callGas({
      action: "updateVisit",
      source: "portal",
      origin: "portal",
      visit_id: vid,
      fields: { is_done: !!nextDone },
      // sync_calendar は既定true（doneのカレンダー反映を維持）
    }, idToken);
  } catch (e) {
    return { ok: false, error: (e?.message || String(e || "")) };
  }

  // 既存コードの慣例に合わせる（success=false は確実に失敗）
  if (!raw || raw.success === false) {
    const msg = (raw && (raw.error || raw.message)) || "更新に失敗しました。";
    return { ok: false, error: msg };
  }

  // ctx があれば反映（一覧/詳細の挙動を揃える）
  try {
    const { results, ctx } = unwrapResults(raw);
    if (ctx) setUser(ctx);
    // returned差分（どのキーで来ても拾えるように薄く吸収）
    const returned =
      (raw && (raw.visit || raw.result || raw.updated)) ||
      (results && (results.visit || results.result || results.updated)) ||
      null;
    return { ok: true, returned, raw };
  } catch (e) {
    // unwrap が失敗しても、更新自体は成功している可能性が高い
    return { ok: true, returned: null, raw };
  }
}