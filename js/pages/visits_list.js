// js/pages/visits_list.js
import { render, toast, escapeHtml, showModal } from "../ui.js";
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

function cardHtml(v) {
  // v のスキーマはGAS返却に合わせる（不足項目は安全にフォールバック）
  const start = v.start || v.start_iso || v.start_at || v.start_time || "";
  const title = v.title || v.course_name || v.course || v.summary || "(無題)";
  const customer = v.customer_name || v.customer || v.account_name || v.name || "";
  const vid = v.visit_id || v.id || "";
  const done = (v.done === true) || (String(v.is_done || "").toLowerCase() === "true");
  const status = v.status || v.visit_status || "";

  return `
    <div class="card" data-visit-id="${escapeHtml(vid)}" data-done="${done ? "1" : "0"}">
      <div class="card-title">
        <div>${escapeHtml(start || "")}</div>
        <div>${escapeHtml(vid || "")}</div>
      </div>
      <div class="card-sub">
        <div><strong>${escapeHtml(customer || "(顧客未設定)")}</strong></div>
        <div>${escapeHtml(title)}</div>
      </div>
      <div class="badges" data-role="badges">
        ${statusBadge(status, done)}
        ${v.is_active === false ? `<span class="badge badge-danger">削除済</span>` : ``}
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

        // 対象カードだけ更新
        card.dataset.done = nextDone ? "1" : "0";
        // 成功時の文言を最終確定値にする（finallyで戻さない）
        btn.textContent = nextDone ? "未完了に戻す" : "完了にする";

        // badgesを差し替え（statusはカードDOMからは取れないので、既存表示を温存しつつ完了バッジだけ反映）
        // シンプルに badges 全体を statusBadge + (削除済は残す) で再構築する
        const badgesEl = card.querySelector('[data-role="badges"]');
        if (badgesEl) {
          const isDeleted = badgesEl.querySelector(".badge-danger") ? true : false;
          // いま表示中の status テキストを拾う（完了バッジ以外の先頭badgeをstatus扱い）
          const firstBadgeText = badgesEl.querySelector(".badge")?.textContent || "";
          // 完了なら status より完了を優先する既存ロジックに合わせ、status文字列は firstBadgeText を使う
          badgesEl.innerHTML = `
            ${statusBadge(firstBadgeText, nextDone)}
            ${isDeleted ? `<span class="badge badge-danger">削除済</span>` : ``}
          `;
        }
      } catch (err) {
        toast({ title: "更新失敗", message: (err && err.message) ? err.message : String(err || "") });
        // 失敗時だけ元の文言に戻す
        btn.textContent = prevText;
      } finally {
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = prevText;
      }
    }
  });
}
