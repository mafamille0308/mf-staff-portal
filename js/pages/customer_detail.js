// js/pages/customer_detail.js
import { render, escapeHtml, toast, fmt } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

const KEY_CD_CACHE_PREFIX = "mf:customer_detail:cache:v1:";
const CD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分

function normStr_(v) {
  const s = fmt(v);
  return (s == null) ? "" : String(s).trim();
}

function pickFirst_(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    const s = normStr_(v);
    if (s) return s;
  }
  return "";
}

function extractCustomerDetail_(res) {
  if (!res) return null;

  // 代表的な形状を広く吸収
  // - { customer_detail: {...} }
  // - { result: {...} }
  // - { results: [ {...} ] }  ※ list系の名残
  // - { customer: {...}, pets:[...] }  ※ 直置き
  const d =
    res.customer_detail ||
    res.customerDetail ||
    res.result ||
    (Array.isArray(res.results) ? res.results[0] : null) ||
    null;

  if (!d) return null;

  // customer は d.customer 優先、なければ d 自体
  const customer = d.customer || d.Customer || d;
  const pets = Array.isArray(d.pets) ? d.pets : (Array.isArray(d.Pets) ? d.Pets : []);
  const careProfile = d.careProfile || d.care_profile || d.care || null;

  return { customer, pets, careProfile };
}

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

  // ===== cache（任意：直近に開いた詳細は即表示）=====
  const cacheKey = KEY_CD_CACHE_PREFIX + String(customerId);
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.ts && (Date.now() - Number(obj.ts)) <= CD_CACHE_TTL_MS && obj.detail) {
        // ここでは “先に即表示” しても良いが、まずは読み込み中のままでもOK
        // host.innerHTML = obj.html || `<p class="p">読み込み中...</p>`;
      }
    }
  } catch (_) {}

  try {
    const res = await callGas({
      action: "getCustomerDetail",
      customer_id: customerId,
      // GASが未対応でも無視される想定（互換目的）
      include_pets: true,
      include_care_profile: true,
    }, idToken);
    if (!res || res.success === false) throw new Error((res && (res.error || res.message)) || "getCustomerDetail failed");

    if (res.ctx) setUser(res.ctx);
    const detail = extractCustomerDetail_(res);
    if (!detail || !detail.customer) throw new Error("顧客詳細が空です（レスポンス形状を確認してください）。");

    // いったん最小表示（後で care 編集導線へ拡張）
    const c = detail.customer;
    const pets = Array.isArray(detail.pets) ? detail.pets : [];

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

    // cache 保存
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), detail }));
    } catch (_) {}
  } catch (e) {
    toast({ title: "取得失敗", message: e?.message || String(e) });
    // 切り分けを早くするため、最低限の情報だけ表示
    host.innerHTML = `
      <p class="p">取得に失敗しました。</p>
      <div class="hr"></div>
      <div class="p text-sm">customer_id=${escapeHtml(customerId)}</div>
      <div class="p text-sm">action=getCustomerDetail</div>
    `;
  }
}
