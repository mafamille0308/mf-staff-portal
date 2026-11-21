export function retirementFailureMessage_(payload) {
  const rows = retirementResults_(payload);
  return rows.some((row) => row.syncPending)
    ? "予約の変更は完了しましたが、カレンダーへの反映を確認できません。対象予約を確認してください。"
    : "退職処理中に問題が発生しました。対象予約とスタッフの状態を確認してください。";
}

export function retirementResults_(payload) {
  const rows = Array.isArray(payload?.visit_results) ? payload.visit_results
    : Array.isArray(payload?.detail?.visit_results) ? payload.detail.visit_results : [];
  return rows.map((row) => {
    const syncPending = Array.isArray(row?.sync_errors) && row.sync_errors.length > 0;
    const action = row?.action || payload?.future_visit_action;
    const completedLabel = action === "handover" ? "引継ぎ済み" : action === "cancel" ? "取消済み" : "変更済み";
    return {
      visitId: String(row?.visit_id || "").trim(),
      syncPending,
      label: syncPending ? `${completedLabel}・カレンダー同期要確認`
        : row?.status === "success" ? completedLabel
        : row?.status === "failed" ? "処理失敗・保存状態を確認" : "状態を確認",
      warning: String(row?.warning || "").trim(),
    };
  }).filter((row) => row.visitId);
}
