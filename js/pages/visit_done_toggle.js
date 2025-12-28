// js/pages/visit_done_toggle.js
import { toast, escapeHtml, showModal } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

/**
 * done(完了/未完了) 切替の共通処理
 * - 確認モーダル → updateVisit → ctx反映 → 返却差分を返す
 * - GAS返却が最小でもUIを壊さない（呼び出し側でマージする前提）
 */
export async function toggleVisitDone({ visitId, currentDone }) {
  const vid = String(visitId || "").trim();
  if (!vid) return { ok: false, error: "visit_id が不正です。" };

  const nextDone = !currentDone;

  const ok = await showModal({
    title: "確認",
    bodyHtml: `<p class="p">予約 <strong>${escapeHtml(vid)}</strong> を「${nextDone ? "完了" : "未完了"}」に変更します。よろしいですか？</p>`,
    okText: nextDone ? "完了にする" : "未完了に戻す",
    cancelText: "キャンセル",
    danger: false,
  });
  if (!ok) return { ok: false, cancelled: true };

  const idToken = getIdToken();
  if (!idToken) {
    toast({ title: "未ログイン", message: "再ログインしてください。" });
    return { ok: false, error: "not authed" };
  }

  let raw;
  try {
    raw = await callGas({
      action: "updateVisit",
      source: "portal",
      origin: "portal",
      visit_id: vid,
      fields: { is_done: nextDone },
      // sync_calendar は既定true（doneのカレンダー反映を維持）
    }, idToken);
  } catch (e) {
    const msg = e?.message || String(e || "");
    toast({ title: "更新失敗", message: msg });
    return { ok: false, error: msg };
  }

  // 既存コードの慣例に合わせる（success=false は確実に失敗）
  if (!raw || raw.success === false) {
    const msg = (raw && (raw.error || raw.message)) || "更新に失敗しました。";
    toast({ title: "更新失敗", message: msg });
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

    toast({ title: "更新完了", message: `「${nextDone ? "完了" : "未完了"}」に更新しました。` });
    return { ok: true, nextDone, returned, raw };
  } catch (e) {
    // unwrap が失敗しても、更新自体は成功している可能性が高いので nextDone を返す
    toast({ title: "更新完了", message: `「${nextDone ? "完了" : "未完了"}」に更新しました。` });
    return { ok: true, nextDone, returned: null, raw };
  }
}
