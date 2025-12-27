// js/pages/visits_list.js
import { render, toast, escapeHtml, showModal, fmt, displayOrDash, fmtDateTimeJst } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
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
  return `<span class="badge">未完了</span>`;
}

function toBool(v) {
  return v === true || String(v || "").toLowerCase() === "true";
}

function mergeVisitById(list, visitId, patch) {
  const id = String(visitId || "");
  const idx = list.findIndex(v => String(v.visit_id || v.id || "") === id);
  if (idx < 0) return { list, idx: -1, merged: null };
  const prev = list[idx] || {};
  const merged = { ...prev, ...patch };
  const next = list.slice();
  next[idx] = merged;
  return { list: next, idx, merged };
}

function cardHtml(v) {
  // v のスキーマはGAS返却に合わせる（不足項目は安全にフォールバック）
  const startRaw = v.start || v.start_iso || v.start_at || v.start_time || "";
  const start = fmtDateTimeJst(startRaw);
  const title = v.title || v.course_name || v.course || v.summary || "(無題)";
  const customer = v.customer_name || v.customer || v.account_name || v.name || "";
  const vid = v.visit_id || v.id || "";
  const done = (v.done === true) || (String(v.is_done || "").toLowerCase() === "true");
  const visitType = v.visit_type || v.type || ""; // 互換（正式は visit_type）
  const billingStatus = v.billing_status || v.request_status || ""; // 移行期間互換
  const isActive = !(v.is_active === false || String(v.is_active || "").toLowerCase() === "false");

  return `
    <div class="card" data-visit-id="${escapeHtml(vid)}" data-done="${done ? "1" : "0"}">
      <div class="card-title">
      <div>${escapeHtml(displayOrDash(start))}</div>
      <div>${escapeHtml(displayOrDash(vid))}</div>
      </div>
      <div class="card-sub">
      <div><strong>${escapeHtml(displayOrDash(customer))}</strong></div>
      <div>${escapeHtml(displayOrDash(title))}</div>
      </div>
      <div class="badges" data-role="badges">
      <span class="badge badge-visit-type">
        ${escapeHtml(displayOrDash(fmt(visitType), "訪問種別未設定"))}
      </span>
      <span class="badge badge-billing-status">
        ${escapeHtml(displayOrDash(fmt(billingStatus), "請求未確定"))}
      </span>
        <span class="badge badge-done ${done ? "badge-ok is-done" : "is-not-done"}">${done ? "完了" : "未完了"}</span>
        <span class="badge badge-active ${isActive ? "is-active" : "badge-danger is-inactive"}">${isActive ? "有効" : "削除済"}</span>
      </div>
      <div class="row" style="justify-content:flex-end; margin-top:10px;">
        <button class="btn" type="button" data-action="toggle-done">${done ? "未完了に戻す" : "完了にする"}</button>
        <button class="btn btn-ghost" type="button" data-action="open">詳細</button>
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
      <div class="hr"></div>
      <div id="visitsList"></div>
    </section>
  `);

  const listEl = appEl.querySelector("#visitsList");
  if (!listEl) return;

  // 一覧の最新データを保持（toggle後のマージ＆再描画に使う）
  let visitsState = [];

  const fetchAndRender_ = async () => {
    listEl.innerHTML = `<p class="p">読み込み中...</p>`;

    const idToken = getIdToken();
    if (!idToken) {
      listEl.innerHTML = `<p class="p">ログインしてください。</p>`;
      return;
    }

    let res;
    try {
      res = await callGas({
        action: "listVisits",
        date_from,
        date_to,
      }, idToken);
    } catch (err) {
      const msg = err?.message || String(err || "");
      toast({ title: "取得失敗", message: msg });
      listEl.innerHTML = `<p class="p">取得に失敗しました。</p>`;
      return;
    }

    // 配列/オブジェクト両対応で results と ctx を取り出す
    const { results: visits, ctx } = unwrapResults(res);

    // ctx があればログインユーザー情報を更新
    if (ctx) setUser(ctx);

    // 返却が配列パターン / オブジェクトパターン両対応
    if (!Array.isArray(visits) || visits.length === 0) {
      listEl.innerHTML = `<p class="p">対象期間の予約がありません。</p>`;
      return;
    }

    visitsState = visits;
    listEl.innerHTML = visits.map(cardHtml).join("");
  };

  await fetchAndRender_();

  // カード内アクション（詳細 / 完了切替）
  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const card = e.target.closest(".card");
    const vid = card?.dataset?.visitId;
    if (!vid) return;

    const action = btn.dataset.action;

    if (action === "open") {
      location.hash = `#/visits?id=${encodeURIComponent(vid)}`;
      return;
    }

    if (action === "toggle-done") {
      // 二重送信防止
      if (btn.disabled || btn.dataset.busy === "1") return;

      const currentDone = card?.dataset?.done === "1";
      const nextDone = !currentDone;

      const ok = await showModal({
        title: "確認",
        bodyHtml: `<p class="p">予約 <strong>${escapeHtml(vid)}</strong> を「${nextDone ? "完了" : "未完了"}」に変更します。よろしいですか？</p>`,
        okText: nextDone ? "完了にする" : "未完了に戻す",
        cancelText: "キャンセル",
        danger: false,
      });
      if (!ok) return;

      const prevText = btn.textContent;
      let finalText = prevText;
      let succeeded = false;
      btn.dataset.busy = "1";
      btn.disabled = true;
      btn.textContent = "更新中...";

      try {
        const idToken = getIdToken();
        if (!idToken) {
          toast({ title: "未ログイン", message: "再ログインしてください。" });
          return;
        }

        const res = await callGas({
          action: "updateVisit",
          source: "portal",
          origin: "portal",
          visit_id: vid,
          fields: { is_done: nextDone },
          // 既定どおり sync_calendar=true（doneはカレンダー側の表示にも反映したい）
        }, idToken);

        if (!res || res.success === false) {
          throw new Error((res && res.error) || "更新に失敗しました。");
        }

        toast({ title: "更新完了", message: `「${nextDone ? "完了" : "未完了"}」に更新しました。` });

        // ===== マージ方式で state を更新し、カードを cardHtml で再描画 =====
        // GAS返却が最小でもUIが壊れないよう、既存vに差分だけ上書きする
        const returned = res.visit || res.result || res.updated || null;
        const patch = {
          ...(returned && typeof returned === "object" ? returned : {}),
          visit_id: vid,
          is_done: nextDone,
          done: nextDone,
        };

        const r = mergeVisitById(visitsState, vid, patch);
        visitsState = r.list;
        const vMerged = r.merged || patch;

        // 成功時の最終ラベル（finallyで戻さない）
        finalText = nextDone ? "未完了に戻す" : "完了にする";
        succeeded = true;

        // カードを丸ごと差し替え（バッジ全体を維持）
        card.outerHTML = cardHtml(vMerged);
      } catch (err) {
        toast({ title: "更新失敗", message: (err && err.message) ? err.message : String(err || "") });
        succeeded = false;
        finalText = prevText;
      } finally {
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = finalText;
      }
    }
  });
}
