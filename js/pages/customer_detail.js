// js/pages/customer_detail.js
import { render, escapeHtml, toast, fmt } from "../ui.js";
import { callGas, unwrapOne } from "../api.js";
import { getIdToken } from "../auth.js";

export async function renderCustomerDetail(appEl, query) {
  const customerId = query.get("id") || "";
  if (!customerId) {
    render(appEl, `<section class="section"><h1 class="h1">顧客詳細</h1><p class="p">customer_id が指定されていません。</p></section>`);
    return;
  }

  render(appEl, `
    <section class="section">
      <div class="row row-between">
        <h1 class="h1">顧客詳細</h1>
        <a class="btn btn-ghost" href="#/customers" id="btnBackCustomers">一覧に戻る</a>
      </div>
      <div class="hr"></div>
      <div data-el="host"><p class="p">読み込み中...</p></div>
    </section>
  `);

  // visits と同様：履歴があれば back 優先
  const backBtn = appEl.querySelector("#btnBackCustomers");
  backBtn?.addEventListener("click", (e) => {
    if (window.history && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
  });

  const host = appEl.querySelector('[data-el="host"]');
  const idToken = getIdToken();
  if (!idToken) {
    host.innerHTML = `<p class="p">ログインしてください。</p>`;
    return;
  }

  try {
    const res = await callGas({ action: "getCustomerDetail", customer_id: customerId }, idToken);
    if (!res || res.success === false) throw new Error((res && (res.error || res.message)) || "getCustomerDetail failed");

    const detail = unwrapOne(res) || res.result || res.customer_detail || res.customerDetail || null;

    // いったん最小表示（後で care 編集導線へ拡張）
    const c = detail && (detail.customer || detail) ? (detail.customer || detail) : null;
    const pets = detail && Array.isArray(detail.pets) ? detail.pets : [];

    host.innerHTML = `
      <div class="card">
        <div class="p">
          <div><strong>顧客ID</strong>：${escapeHtml(customerId)}</div>
          <div><strong>顧客名</strong>：${escapeHtml(fmt(c && c.name))}</div>
          <div><strong>電話</strong>：${escapeHtml(fmt(c && c.phone))}</div>
          <div><strong>住所</strong>：${escapeHtml(fmt((c && (c.address_full || c.address)) || ""))}</div>
        </div>
      </div>

      <div class="hr"></div>
      <div class="p"><strong>ペット</strong></div>
      ${
        pets.length
          ? pets.map(p => `
              <div class="card">
                <div class="p">
                  <div><strong>${escapeHtml(fmt(p.name || p.pet_name || ""))}</strong></div>
                  <div>病院：${escapeHtml(fmt(p.hospital || ""))}</div>
                  <div>病院電話：${escapeHtml(fmt(p.hospital_phone || ""))}</div>
                </div>
              </div>
            `).join("")
          : `<p class="p">ペット情報がありません。</p>`
      }
    `;
  } catch (e) {
    toast({ title: "取得失敗", message: e?.message || String(e) });
    host.innerHTML = `<p class="p">取得に失敗しました。</p>`;
  }
}
