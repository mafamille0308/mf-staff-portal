// js/pages/visits_list.js
import { render, toast, escapeHtml } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

function toYmd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate()); // today
  const to = new Date(now);
  to.setDate(to.getDate() + 14); // +14 days
  return { date_from: toYmd(from), date_to: toYmd(to) + " 23:59:59" };
}

function badgeHtml(text) {
  return `<span class="badge">${escapeHtml(text)}</span>`;
}

function statusBadge(status, done) {
  if (done === true) return `<span class="badge badge-ok">完了</span>`;
  if (status) return badgeHtml(status);
  return `<span class="badge">-</span>`;
}

function cardHtml(v) {
  // v のスキーマはGAS返却に合わせる（不足項目は安全にフォールバック）
  const start = v.start || v.start_iso || v.start_at || v.start_time || "";
  const title = v.title || v.course_name || v.course || v.summary || "(無題)";
  const customer = v.customer_name || v.customer || v.account_name || v.name || "";
  const vid = v.visit_id || v.id || "";
  const done = (v.done === true) || (String(v.is_done || "").toLowerCase() === "true");
  const status = v.status || v.visit_status || "";

  return `
    <div class="card" data-visit-id="${escapeHtml(vid)}">
      <div class="card-title">
        <div>${escapeHtml(start || "")}</div>
        <div>${escapeHtml(vid || "")}</div>
      </div>
      <div class="card-sub">
        <div><strong>${escapeHtml(customer || "(顧客未設定)")}</strong></div>
        <div>${escapeHtml(title)}</div>
      </div>
      <div class="badges">
        ${statusBadge(status, done)}
        ${v.is_active === false ? `<span class="badge badge-danger">削除</span>` : ``}
      </div>
      <div class="row" style="justify-content:flex-end; margin-top:10px;">
        <button class="btn btn-ghost" type="button" data-action="open">詳細（次）</button>
      </div>
    </div>
  `;
}

export async function renderVisitsList(appEl, query) {
  const { date_from, date_to } = defaultRange();
  const date_to_label = date_to.slice(0, 10);

  render(appEl, `
    <section class="section">
      <h1 class="h1">予約一覧</h1>
      <p class="p">まずは最小実装として、直近2週間を表示します（期間UIは次段で追加）。</p>
      <div class="hr"></div>
      <div class="row">
        <div class="badge">from: ${escapeHtml(date_from)}</div>
        <div class="badge">to: ${escapeHtml(date_to_label)}</div>
      </div>
     <div class="row" style="justify-content:flex-end;">
       <button class="btn btn-ghost" id="btnDebugSample" type="button">デバッグ: サンプル取得</button>
     </div>
      <div class="hr"></div>
      <div id="visitsList"></div>
    </section>
  `);

  const listEl = appEl.querySelector("#visitsList");
  if (!listEl) return;

  listEl.innerHTML = `<p class="p">読み込み中...</p>`;

  const btnDebug = appEl.querySelector("#btnDebugSample");
  btnDebug?.addEventListener("click", async () => {
    try {
      const dbg = await callGas({ action: "debugVisitsSample" }, idToken);
      console.log("debugVisitsSample:", dbg);
      // 見やすく表で確認
      if (dbg && dbg.sample) console.table(dbg.sample);
      toast({ title: "デバッグ取得", message: "consoleに sample を出力しました" });
    } catch (e) {
      console.error("debugVisitsSample error:", e);
      toast({ title: "デバッグ失敗", message: e?.message || String(e) });
    }
  });

  const idToken = getIdToken();

  // listVisits 呼び出し
  const res = await callGas({
    action: "listVisits",
    date_from: "",
    date_to: "",
  }, idToken);

  // GAS側の返却形（例：{ ok:true, ctx:{...}, results:[...] } を想定）
  if (res && res.ctx) setUser(res.ctx);

  const visits = (res && (res.results || res.visits || res.data)) || [];
  if (!Array.isArray(visits) || visits.length === 0) {
    listEl.innerHTML = `<p class="p">対象期間の予約がありません。</p>`;
    return;
  }

  listEl.innerHTML = visits.map(cardHtml).join("");

  // 詳細（次段で実装）
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='open']");
    if (!btn) return;
    const card = e.target.closest(".card");
    const vid = card?.dataset?.visitId;
    toast({ title: "未実装", message: `詳細画面は次段で追加します（visit_id=${vid || ""}）` });
  });
}
