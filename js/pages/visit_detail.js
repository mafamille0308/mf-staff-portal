// js/pages/visit_detail.js
import { render, toast, escapeHtml } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

function fmt(v) {
  if (v == null) return "";
  return String(v);
}

function section(title, bodyHtml) {
  return `
    <div class="hr"></div>
    <h2 class="h2">${escapeHtml(title)}</h2>
    <div class="p">${bodyHtml || ""}</div>
  `;
}

export async function renderVisitDetail(appEl, query) {
  const visitId = query.get("id") || "";
  if (!visitId) {
    render(appEl, `<p class="p">visit_id が指定されていません。</p>`);
    return;
  }

  render(appEl, `
    <section class="section">
      <div class="row" style="justify-content:space-between; align-items:center;">
        <h1 class="h1">予約詳細</h1>
        <a class="btn btn-ghost" href="#/visits">一覧に戻る</a>
      </div>
      <div class="hr"></div>
      <div id="visitDetailHost"><p class="p">読み込み中...</p></div>
    </section>
  `);

  const host = appEl.querySelector("#visitDetailHost");
  if (!host) return;

  const idToken = getIdToken();
  if (!idToken) {
    host.innerHTML = `<p class="p">ログインしてください。</p>`;
    return;
  }

  let res;
  try {
    res = await callGas({
      action: "getVisitDetail",
      id_token: idToken,
      visit_id: visitId,
      include_customer_detail: true,
    });
  } catch (err) {
    const msg = err?.message || String(err || "");
    toast({ title: "取得失敗", message: msg });
    host.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    return;
  }

  if (!res || res.success === false) {
    const msg = (res && (res.error || res.message)) || "getVisitDetail failed";
    toast({ title: "取得失敗", message: msg });
    host.innerHTML = `<p class="p">取得に失敗しました：${escapeHtml(msg)}</p>`;
    return;
  }

  if (res.ctx) setUser(res.ctx);

  const visit = res.visit || res.result || null;
  const customerDetail = res.customer_detail || res.customerDetail || null;

  if (!visit) {
    host.innerHTML = `<p class="p">対象の予約が見つかりません。</p>`;
    return;
  }

  const done = (visit.done === true) || (String(visit.is_done || "").toLowerCase() === "true");
  const isActive = !(visit.is_active === false || String(visit.is_active || "").toLowerCase() === "false");

  const visitHtml = `
    <div class="card">
      <div class="card-title">
        <div>${escapeHtml(fmt(visit.start_time || visit.start || ""))}</div>
        <div>${escapeHtml(fmt(visit.visit_id || ""))}</div>
      </div>
      <div class="row" style="gap:8px; flex-wrap:wrap;">
        <span class="badge">${escapeHtml(fmt(visit.status || visit.visit_status || "")) || "未設定"}</span>
        <span class="badge ${done ? "badge-ok" : ""}">${done ? "完了" : "未完了"}</span>
        <span class="badge ${isActive ? "" : "badge-danger"}">${isActive ? "有効" : "削除済"}</span>
      </div>
      <div class="hr"></div>
      <div class="p">
        <div><strong>開始</strong>：${escapeHtml(fmt(visit.start_time || visit.start || ""))}</div>
        <div><strong>終了</strong>：${escapeHtml(fmt(visit.end_time || visit.end || ""))}</div>
        <div><strong>staff</strong>：${escapeHtml(fmt(visit.staff_name || ""))} (${escapeHtml(fmt(visit.staff_id || ""))})</div>
        <div><strong>customer</strong>：${escapeHtml(fmt(visit.customer_name || ""))} (${escapeHtml(fmt(visit.customer_id || ""))})</div>
      </div>
    </div>
  `;

  let customerHtml = `<p class="p">（顧客詳細は未取得）</p>`;
  if (customerDetail && customerDetail.customer) {
    const c = customerDetail.customer;
    const pets = Array.isArray(customerDetail.pets) ? customerDetail.pets : [];
    const cp = customerDetail.careProfile || customerDetail.care_profile || null;

    customerHtml = `
      <div class="card">
        <div class="p">
          <div><strong>顧客名</strong>：${escapeHtml(fmt(c.name || ""))}</div>
          <div><strong>電話</strong>：${escapeHtml(fmt(c.phone || ""))}</div>
          <div><strong>住所</strong>：${escapeHtml(fmt(c.address_full || c.address || ""))}</div>
          <div><strong>鍵</strong>：${escapeHtml(fmt(c.key_location || c.keyLocation || ""))}</div>
        </div>
      </div>

      ${pets.length ? `
        <div class="hr"></div>
        <div class="p"><strong>ペット</strong></div>
        ${pets.map(p => `
          <div class="card">
            <div class="p">
              <div><strong>${escapeHtml(fmt(p.name || p.pet_name || ""))}</strong></div>
              <div>種別：${escapeHtml(fmt(p.type || p.pet_type || ""))}　品種：${escapeHtml(fmt(p.breed || ""))}</div>
              <div>年齢：${escapeHtml(fmt(p.age || ""))}</div>
              <div>メモ：${escapeHtml(fmt(p.notes || p.memo || ""))}</div>
            </div>
          </div>
        `).join("")}
      ` : `<p class="p">ペット情報がありません。</p>`}

      ${cp ? `
        <div class="hr"></div>
        <div class="p"><strong>お世話情報</strong></div>
        <div class="card">
          <div class="p">
            <pre class="pre" style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(cp, null, 2))}</pre>
          </div>
        </div>
      ` : `<p class="p">お世話情報がありません。</p>`}
    `;
  }

  host.innerHTML = `
    ${section("予約", visitHtml)}
    ${section("顧客・ペット・お世話情報", customerHtml)}
  `;
}
