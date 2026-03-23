import { showSelectModal } from "../ui.js";

export function normalizeCancelBillingStatus_(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["paid", "completed"].includes(s)) return "paid";
  if (["billed", "invoicing", "invoiced", "sent", "scheduled", "partially_paid"].includes(s)) return "billed";
  return "unbilled";
}

export async function pickCancellationFeeRate_() {
  const picked = await showSelectModal({
    title: "キャンセルポリシー",
    bodyHtml: `
      <p class="p">キャンセルポリシーを選択してください。</p>
      <select id="cancelFeeRateSelect" class="input">
        <option value="0">キャンセル料なし（0%）</option>
        <option value="50">キャンセル料あり（50%）</option>
        <option value="100">キャンセル料あり（100%）</option>
      </select>
    `,
    okText: "次へ",
    cancelText: "キャンセル",
    selectId: "cancelFeeRateSelect"
  });
  if (picked == null) return null;
  const rate = Number(picked);
  if (![0, 50, 100].includes(rate)) return null;
  return rate;
}

function formatMoneyDefault_(n) {
  const v = Number(n || 0) || 0;
  return v.toLocaleString("ja-JP");
}

export function buildCancelPolicyMessage_(preview, options = {}) {
  const formatMoney = (typeof options.formatMoney === "function") ? options.formatMoney : formatMoneyDefault_;
  const status = normalizeCancelBillingStatus_(preview?.billing_status);
  const rate = Number(preview?.cancellation_fee_rate || 0);
  const feeAmount = Math.max(0, Number(preview?.cancellation_fee_amount || 0) || 0);
  const refundAmount = Math.max(0, Number(preview?.refund_amount || 0) || 0);
  const remainingVisitCount = Array.isArray(preview?.remaining_active_visit_ids)
    ? preview.remaining_active_visit_ids.map((x) => String(x || "").trim()).filter(Boolean).length
    : Math.max(0, Number(preview?.remaining_item_count || 0) || 0);
  if (status === "billed" && remainingVisitCount > 0 && (rate === 50 || rate === 100)) {
    return "予約キャンセルに伴い、キャンセル料+残存予約で請求書を作成し、発行済み請求書を差し替えます。";
  }
  if (status === "unbilled" && rate === 0) return "予約を無効にします。請求書はありません。";
  if (status === "unbilled" && rate > 0) return `予約を無効にし、キャンセル料 ${formatMoney(feeAmount)}円 を初期値としてキャンセル請求ドラフト作成へ進みます。`;
  if (status === "billed" && rate === 100) return `旧請求書をキャンセルして、キャンセル料 ${formatMoney(feeAmount)}円 のキャンセル請求ドラフト作成へ進みます。`;
  if (status === "billed" && rate === 50) return `旧請求書をキャンセルして、キャンセル料 ${formatMoney(feeAmount)}円 を含むキャンセル請求ドラフト作成へ進みます。`;
  if (status === "billed" && rate === 0) return remainingVisitCount > 0
    ? "旧請求書をキャンセルして、残存費目の請求ドラフト作成へ進みます。"
    : "Square側の請求書をキャンセルします（未送信ドラフトは削除）。";
  if (status === "paid" && rate === 100) return "支払済みのため返金不要です。キャンセル料として受領済みとして処理します。";
  if (status === "paid" && (rate === 50 || rate === 0)) return `Square側で返金処理が必要です。返金額: ${formatMoney(refundAmount)}円。Square Dashboardで返金後、ポータルに反映されます。`;
  return "予約を無効にします。";
}
