// js/pages/customers_list.js
import { render, escapeHtml, toast, fmt } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken } from "../auth.js";

function norm_(v) {
  return String(v || "").trim().toLowerCase();
}

function filter_(list, q) {
  const nq = norm_(q);
  if (!nq) return list;

  return list.filter(c => {
    const name = norm_(c.name);
    const addr = norm_(c.address);
    const phone = norm_(c.phone);
    const pets = Array.isArray(c.pet_names) ? c.pet_names.map(norm_).join(" ") : "";
    const cid = norm_(c.customer_id);
    return name.includes(nq) || addr.includes(nq) || phone.includes(nq) || pets.includes(nq) || cid.includes(nq);
  });
}

function renderPetsBadges_(petNames) {
  const pets = Array.isArray(petNames) ? petNames : [];
  if (!pets.length) return `<div class="p text-sm">ペット：—</div>`;
  return `<div class="badges">${pets.map(n => `<span class="badge">${escapeHtml(fmt(n))}</span>`).join("")}</div>`;
}

function card_(c) {
  const cid = String(c.customer_id || "").trim();
  return `
    <div class="card">
      <div class="card-title">
        <div>
          ${escapeHtml(fmt(c.name || "（名称未設定）"))}
          <span class="badge">${escapeHtml(cid)}</span>
        </div>
      </div>
      <div class="card-sub">
        <div>${escapeHtml(fmt(c.address || "—"))}</div>
        <div>電話：${escapeHtml(fmt(c.phone || "—"))}</div>
      </div>
      <div class="pets-badges">
        ${renderPetsBadges_(c.pet_names)}
      </div>
      <div class="row row-between">
        <button class="btn" type="button" data-act="open" data-cid="${escapeHtml(cid)}">顧客詳細</button>
        <button class="btn btn-ghost" type="button" data-act="care" data-cid="${escapeHtml(cid)}">お世話情報</button>
      </div>
    </div>
  `;
}

async function fetch_(query) {
  const idToken = getIdToken();
  if (!idToken) throw new Error("未ログインです。");

  // listMyCustomers_ 側は data.as_of を受けるので、必要なら query から渡せる
  const asOf = query?.get?.("as_of") || ""; // 使わないなら空でOK
  const limit = query?.get?.("limit") || ""; // 同上

  const payload = { action: "listMyCustomers" };
  if (asOf) payload.as_of = asOf;
  if (limit) payload.limit = limit;

  const res = await callGas(payload, idToken);
  if (!res || res.success === false) {
    throw new Error((res && (res.error || res.message)) || "listMyCustomers failed");
  }

  const data = unwrapResults(res);
  const list = (data && Array.isArray(data.results)) ? data.results : [];
  // 防御的に整形
  return list.map(x => ({
    customer_id: String(x.customer_id || "").trim(),
    name: String(x.name || "").trim(),
    phone: String(x.phone || "").trim(),
    address: String(x.address || "").trim(),
    pet_names: Array.isArray(x.pet_names) ? x.pet_names : [],
  })).filter(x => x.customer_id);
}

export async function renderCustomersList(appEl, query) {
  // state は将来 sessionStorage に寄せられる（一覧復帰ストレス対策と整合）
  let q = "";

  render(appEl, `
    <section class="section">
      <div class="row row-between">
        <h1 class="h1">担当顧客一覧</h1>
        <button class="btn btn-ghost" type="button" data-act="refresh">更新</button>
      </div>

      <div class="row">
        <input class="input" data-el="q" placeholder="検索（顧客名/住所/電話/ペット/ID）" value="" />
      </div>

      <div class="hr"></div>
      <div data-el="list"><p class="p">読み込み中...</p></div>
    </section>
  `);

  const listEl = appEl.querySelector('[data-el="list"]');
  const qEl = appEl.querySelector('[data-el="q"]');
  const refreshBtn = appEl.querySelector('[data-act="refresh"]');

  let all = [];
  const redraw = () => {
    const filtered = filter_(all, q);
    listEl.innerHTML = filtered.length
      ? filtered.map(card_).join("")
      : `<p class="p">該当する顧客がありません。</p>`;
  };

  const load = async () => {
    try {
      if (refreshBtn) refreshBtn.disabled = true;
      listEl.innerHTML = `<p class="p">読み込み中...</p>`;
      all = await fetch_(query);
      redraw();
    } catch (e) {
      toast({ title: "取得失敗", message: e?.message || String(e) });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  qEl?.addEventListener("input", () => {
    q = qEl.value || "";
    redraw();
  });

  refreshBtn?.addEventListener("click", load);

  appEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    const cid = btn.getAttribute("data-cid") || "";
    if (!cid) return;

    if (act === "open") {
      location.hash = `#/customers?id=${encodeURIComponent(cid)}`;
    } else if (act === "care") {
      // 次段：care 編集導線ができたら、ここを専用ルートにしても良い
      location.hash = `#/customers?id=${encodeURIComponent(cid)}&tab=care`;
    }
  });

  await load();
}
