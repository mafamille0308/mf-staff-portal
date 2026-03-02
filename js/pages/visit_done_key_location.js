import { callGas } from "../api.js";
import { getIdToken } from "../auth.js";
import { showModal, showSelectModal, toast, openBlockingOverlay, escapeHtml } from "../ui.js";

const KEY_LOCATION_OPTIONS = ["顧客", "本部", "担当者", "鍵なし"];

async function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  try {
    return await task(blocker);
  } finally {
    blocker.close();
  }
}

export async function confirmKeyLocationBeforeDone({ visitId }) {
  const vid = String(visitId || "").trim();
  if (!vid) return false;

  const idToken = getIdToken();
  if (!idToken) {
    toast({ title: "未ログイン", message: "再ログインしてください。" });
    return false;
  }

  let detail = null;
  try {
    detail = await runWithBlocking_(
      {
        title: "鍵情報を確認しています",
        bodyHtml: "顧客情報を取得しています。",
        busyText: "読み込み中...",
      },
      async () => await callGas({
        action: "getVisitDetail",
        visit_id: vid,
        include_customer_detail: true,
      }, idToken)
    );
  } catch (e) {
    toast({ title: "取得失敗", message: e?.message || String(e || "") });
    return false;
  }

  if (!detail || detail.success === false) {
    toast({ title: "取得失敗", message: (detail && (detail.error || detail.message)) || "顧客情報の取得に失敗しました。" });
    return false;
  }

  const visit = detail.visit || {};
  const customer = (detail.customer_detail && detail.customer_detail.customer) ? detail.customer_detail.customer : {};
  const customerId = String(visit.customer_id || customer.customer_id || customer.id || "").trim();
  if (!customerId) {
    toast({ title: "更新不可", message: "顧客IDを特定できませんでした。" });
    return false;
  }
  const currentKeyLocation = String(customer.key_location || customer.keyLocation || "").trim();

  const changed = await showModal({
    title: "鍵の所在確認",
    bodyHtml: `
      <div class="p">完了にする前に、鍵の所在に変更があるか確認してください。</div>
      <div class="hr"></div>
      <div class="p">現在の鍵の所在：<strong>${escapeHtml(currentKeyLocation || "未設定")}</strong></div>
    `,
    okText: "変更あり",
    cancelText: "変更なし",
  });
  if (!changed) return { ok: true, key_location: currentKeyLocation };

  const nextKeyLocation = await showSelectModal({
    title: "鍵の所在を更新",
    bodyHtml: `
      <div class="p" style="margin-bottom:8px;">変更後の鍵の所在を選択してください。</div>
      <select id="mKeyLocationSelect" class="select" style="width:100%;">
        ${KEY_LOCATION_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${currentKeyLocation === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
      </select>
    `,
    okText: "更新して完了へ",
    cancelText: "キャンセル",
    selectId: "mKeyLocationSelect",
  });
  if (nextKeyLocation == null) return { ok: false };

  try {
    const res = await runWithBlocking_(
      {
        title: "鍵の所在を更新しています",
        bodyHtml: "顧客情報を保存しています。",
        busyText: "保存中...",
      },
      async () => await callGas({
        action: "upsertCustomer",
        customer: {
          customer_id: customerId,
          key_location: nextKeyLocation,
        }
      }, idToken)
    );
    if (!res || res.ok === false || res.success === false) {
      throw new Error((res && (res.error || res.message)) || "鍵の所在の更新に失敗しました。");
    }
    toast({ title: "更新完了", message: "鍵の所在を更新しました。" });
    return { ok: true, key_location: nextKeyLocation };
  } catch (e) {
    toast({ title: "更新失敗", message: e?.message || String(e || "") });
    return { ok: false };
  }
}

export async function confirmKeyLocationBeforeBulkDone({ visitIds }) {
  const ids = Array.isArray(visitIds) ? visitIds.map((v) => String(v || "").trim()).filter(Boolean) : [];
  if (!ids.length) return false;

  const idToken = getIdToken();
  if (!idToken) {
    toast({ title: "未ログイン", message: "再ログインしてください。" });
    return false;
  }

  let details = [];
  try {
    details = await runWithBlocking_(
      {
        title: "鍵情報を確認しています",
        bodyHtml: "対象予約の顧客情報を取得しています。",
        busyText: "読み込み中...",
      },
      async () => {
        const list = [];
        for (const id of ids) {
          const res = await callGas({
            action: "getVisitDetail",
            visit_id: id,
            include_customer_detail: true,
          }, idToken);
          list.push(res);
        }
        return list;
      }
    );
  } catch (e) {
    toast({ title: "取得失敗", message: e?.message || String(e || "") });
    return false;
  }

  const byCustomer = new Map();
  for (const detail of details) {
    if (!detail || detail.success === false) {
      toast({ title: "取得失敗", message: (detail && (detail.error || detail.message)) || "顧客情報の取得に失敗しました。" });
      return false;
    }
    const visit = detail.visit || {};
    const customer = (detail.customer_detail && detail.customer_detail.customer) ? detail.customer_detail.customer : {};
    const customerId = String(visit.customer_id || customer.customer_id || customer.id || "").trim();
    if (!customerId) {
      toast({ title: "更新不可", message: "顧客IDを特定できませんでした。" });
      return false;
    }
    if (!byCustomer.has(customerId)) {
      byCustomer.set(customerId, {
        customerId,
        customerName: String(customer.name || visit.customer_name || customerId).trim(),
        currentKeyLocation: String(customer.key_location || customer.keyLocation || "").trim(),
        count: 0,
      });
    }
    byCustomer.get(customerId).count += 1;
  }

  for (const item of byCustomer.values()) {
    const changed = await showModal({
      title: "鍵の所在確認",
      bodyHtml: `
        <div class="p">完了にする前に、鍵の所在に変更があるか確認してください。</div>
        <div class="hr"></div>
        <div class="p">顧客名：<strong>${escapeHtml(item.customerName)}</strong></div>
        <div class="p">対象予約：<strong>${escapeHtml(String(item.count))}件</strong></div>
        <div class="p">現在の鍵の所在：<strong>${escapeHtml(item.currentKeyLocation || "未設定")}</strong></div>
      `,
      okText: "変更あり",
      cancelText: "変更なし",
    });
    if (!changed) continue;

    const nextKeyLocation = await showSelectModal({
      title: "鍵の所在を更新",
      bodyHtml: `
        <div class="p" style="margin-bottom:8px;">${escapeHtml(item.customerName)} の変更後の鍵の所在を選択してください。</div>
        <select id="mKeyLocationSelect" class="select" style="width:100%;">
          ${KEY_LOCATION_OPTIONS.map((opt) => `<option value="${escapeHtml(opt)}" ${item.currentKeyLocation === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
        </select>
      `,
      okText: "更新して完了へ",
      cancelText: "キャンセル",
      selectId: "mKeyLocationSelect",
    });
    if (nextKeyLocation == null) return false;

    try {
      const res = await runWithBlocking_(
        {
          title: "鍵の所在を更新しています",
          bodyHtml: `${escapeHtml(item.customerName)} の顧客情報を保存しています。`,
          busyText: "保存中...",
        },
        async () => await callGas({
          action: "upsertCustomer",
          customer: {
            customer_id: item.customerId,
            key_location: nextKeyLocation,
          }
        }, idToken)
      );
      if (!res || res.ok === false || res.success === false) {
        throw new Error((res && (res.error || res.message)) || "鍵の所在の更新に失敗しました。");
      }
      toast({ title: "更新完了", message: `${item.customerName} の鍵の所在を更新しました。` });
    } catch (e) {
      toast({ title: "更新失敗", message: e?.message || String(e || "") });
      return false;
    }
  }

  return true;
}
