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
  to.setDate(to.getDate() + 7); // +7 days
  return { date_from: toYmd(from), date_to: toYmd(to) + " 23:59:59" };
}

function toBool(v) {
  return v === true || String(v || "").toLowerCase() === "true";
}

function isDone_(v) {
  return toBool(v.done) || toBool(v.is_done);
}

function pickVisitType_(v) {
  return String(v.visit_type || v.type || "").trim();
}

function collectVisitTypes_(list) {
  const set = new Set();
  (list || []).forEach(v => {
    const t = pickVisitType_(v);
    if (t) set.add(t);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "ja"));
}

function pickStartIso_(v) {
  return v.start || v.start_iso || v.start_at || v.start_time || "";
}

function epochMsSafe_(isoOrAny) {
  const s = String(isoOrAny || "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function normalizeKeyword_(s) {
  return String(s || "").trim().toLowerCase();
}

function keywordHit_(v, kw) {
  if (!kw) return true;
  const hay = [
    v.visit_id,
    v.id,
    v.customer_name,
    v.customer,
    v.account_name,
    v.name,
    v.title,
    v.course_name,
    v.course,
    v.summary,
    v.memo,
    v.notes,
  ].map(x => normalizeKeyword_(x)).join("\n");
  return hay.includes(kw);
}

function sortVisits_(list, sortOrder, mode) {
  // mode:
  // - "open_first": 未完了優先
  // - "all": 完了優先なし（日時のみ）
  const dir = (sortOrder === "desc") ? -1 : 1;
  return list.slice().sort((a, b) => {
    if (mode !== "all") {
      const ad = isDone_(a);
      const bd = isDone_(b);
      if (ad !== bd) return ad ? 1 : -1;
    }

    const at = epochMsSafe_(pickStartIso_(a));
    const bt = epochMsSafe_(pickStartIso_(b));
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    if (at === bt) return 0;
    return (at < bt ? -1 : 1) * dir;
  });
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
  const done = isDone_(v);
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
  // ===== state =====
  const init = defaultRange();
  let state = {
    date_from: init.date_from,
    date_to_ymd: init.date_to.slice(0, 10),
    keyword: "",
    sort_order: "asc", // 近い順（運用上、次の予定が見やすい）
    done_filter: "open_first", // open_first | open_only | done_only | all
    type_filter: "all", // all | <visit_type>
  };

  render(appEl, `
    <section class="section">
      <h1 class="h1">予約一覧</h1>
      <p class="p">絞り込み機能を有効活用しましょう！</p>
      <div class="hr"></div>
      <details id="vfDetails" style="border:1px solid var(--line); border-radius: var(--radius); padding: 10px; background: rgba(255,255,255,0.02);">
        <summary class="row" style="cursor:pointer; user-select:none; list-style:none;">
          <div style="font-weight:900;">フィルタ / ソート</div>
          <span id="vfToggleState" class="badge">開く</span>
        </summary>
        <div id="visitsFilters" style="margin-top: 10px;">
          <div class="row">
            <div style="flex:1; min-width:140px;">
              <div class="p" style="margin-bottom:6px;">期間（from）</div>
              <input id="vfFrom" class="input" type="date" />
            </div>
            <div style="flex:1; min-width:140px;">
              <div class="p" style="margin-bottom:6px;">期間（to）</div>
              <input id="vfTo" class="input" type="date" />
            </div>
          </div>
          <div class="row">
            <button class="btn" type="button" data-action="apply-range">期間を適用</button>
            <button class="btn btn-ghost" type="button" data-action="reset">リセット</button>
          </div>
          <div class="hr"></div>
          <div class="row">
            <input id="vfKeyword" class="input" type="text" inputmode="search" placeholder="検索（顧客名 / タイトル / visit_id …）" />
            <button class="btn btn-ghost" type="button" data-action="clear-keyword">クリア</button>
          </div>
          <div class="row">
            <div class="p">完了状態</div>
            <select id="vfDoneFilter" class="select">
              <option value="open_first">すべて（未完了優先）</option>
              <option value="open_only">未完了のみ</option>
              <option value="done_only">完了のみ</option>
              <option value="all">すべて</option>
            </select>
          </div>
          <div class="row">
            <div class="p">訪問種別</div>
            <select id="vfTypeFilter" class="select">
              <option value="all">すべて</option>
            </select>
          </div>
          <div class="row">
            <div class="p">並び順</div>
            <select id="vfSortOrder" class="select">
              <option value="asc">日時：近い順</option>
              <option value="desc">日時：新しい順</option>
            </select>
          </div>
        </div>
      </details>
      <div class="row" id="vfStatusBadges" style="margin-top: 10px;"></div>
      <div class="hr"></div>
      <div id="visitsList"></div>
    </section>
  `);

  const listEl = appEl.querySelector("#visitsList");
  if (!listEl) return;

  const detailsEl = appEl.querySelector("#vfDetails");
  const toggleStateEl = appEl.querySelector("#vfToggleState");
  const filtersEl = appEl.querySelector("#visitsFilters");
  const fromEl = appEl.querySelector("#vfFrom");
  const toEl = appEl.querySelector("#vfTo");
  const kwEl = appEl.querySelector("#vfKeyword");
  const doneEl = appEl.querySelector("#vfDoneFilter");
  const typeEl = appEl.querySelector("#vfTypeFilter");
  const sortEl = appEl.querySelector("#vfSortOrder");
  const badgesEl = appEl.querySelector("#vfStatusBadges");

  if (fromEl) fromEl.value = state.date_from;
  if (toEl) toEl.value = state.date_to_ymd;
  if (kwEl) kwEl.value = state.keyword;
  if (doneEl) doneEl.value = state.done_filter;
  if (typeEl) typeEl.value = state.type_filter;
  if (sortEl) sortEl.value = state.sort_order;

  // ===== 一覧state =====
  // - visitsAll: 直近取得したサーバ結果（期間はサーバ側で絞っている）
  // - 画面表示は keyword / sort をクライアント側で適用
  let visitsAll = [];

  // ===== 開閉状態（スマホでの表示領域最適化）=====
  const KEY_VF_OPEN = "mf_vf_open";
  const applyDetailsUi_ = (isOpen) => {
    if (!detailsEl) return;
    detailsEl.open = !!isOpen;
    if (toggleStateEl) toggleStateEl.textContent = detailsEl.open ? "閉じる" : "開く";
  };
  try {
    const saved = sessionStorage.getItem(KEY_VF_OPEN);
    applyDetailsUi_(saved === "1");
  } catch (_) {}
  detailsEl?.addEventListener("toggle", () => {
    if (toggleStateEl) toggleStateEl.textContent = detailsEl.open ? "閉じる" : "開く";
    try { sessionStorage.setItem(KEY_VF_OPEN, detailsEl.open ? "1" : "0"); } catch (_) {}
  });

  const updateStatusBadges_ = (countShown, countAll) => {
    if (!badgesEl) return;
    const kw = normalizeKeyword_(state.keyword);
    const doneLabel =
      state.done_filter === "open_only" ? "未完了のみ" :
      state.done_filter === "done_only" ? "完了のみ" :
      state.done_filter === "all" ? "すべて" :
      "未完了優先";
    const typeLabel = (state.type_filter && state.type_filter !== "all") ? state.type_filter : "すべて";    
    badgesEl.innerHTML = [
      `<span class="badge">期間: ${escapeHtml(state.date_from)} → ${escapeHtml(state.date_to_ymd)}</span>`,
      `<span class="badge">完了: ${escapeHtml(doneLabel)}</span>`,
      `<span class="badge">種別: ${escapeHtml(typeLabel)}</span>`,
      `<span class="badge">並び: ${escapeHtml(state.sort_order === "desc" ? "新しい順" : "近い順")}</span>`,
      `<span class="badge">検索: ${escapeHtml(kw ? state.keyword : "なし")}</span>`,
      `<span class="badge">表示: ${escapeHtml(String(countShown))}/${escapeHtml(String(countAll))}</span>`,
    ].join(" ");
  };

  const rebuildTypeOptions_ = () => {
    if (!typeEl) return;
    const types = collectVisitTypes_(visitsAll);
    const current = String(state.type_filter || "all");
    typeEl.innerHTML = [
      `<option value="all">すべて</option>`,
      ...types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
    ].join("");
    // 既存選択が無効なら all に戻す
    const exists = (current === "all") || types.includes(current);
    state.type_filter = exists ? current : "all";
    typeEl.value = state.type_filter;
  };

  const applyAndRender_ = () => {
    const kw = normalizeKeyword_(state.keyword);
    let filtered = (kw ? visitsAll.filter(v => keywordHit_(v, kw)) : visitsAll.slice());

    // 完了状態フィルタ
    if (state.done_filter === "open_only") {
      filtered = filtered.filter(v => !isDone_(v));
    } else if (state.done_filter === "done_only") {
      filtered = filtered.filter(v => isDone_(v));
    }

    // 訪問種別フィルタ
    if (state.type_filter && state.type_filter !== "all") {
      filtered = filtered.filter(v => pickVisitType_(v) === state.type_filter);
    }

    // 並び（未完了優先は open_first のときのみ）
    const sortMode = (state.done_filter === "all") ? "all" : "open_first";
    const sorted = sortVisits_(filtered, state.sort_order, sortMode);

    if (!sorted.length) {
      listEl.innerHTML = `<p class="p">条件に一致する予約がありません。</p>`;
      updateStatusBadges_(0, visitsAll.length);
      return;
    }

    // 再描画（並び順の整合性を優先）
    const y = window.scrollY;
    listEl.innerHTML = sorted.map(cardHtml).join("");
    window.scrollTo(0, y);
    updateStatusBadges_(sorted.length, visitsAll.length);
  };

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
        date_from: state.date_from,
        date_to: state.date_to_ymd + " 23:59:59",
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
      visitsAll = [];
      updateStatusBadges_(0, 0);
      return;
    }

    visitsAll = visits;
    rebuildTypeOptions_();
    applyAndRender_();
  };

  await fetchAndRender_();

  // ===== フィルタUI =====
  const resetToDefault_ = async () => {
    const d = defaultRange();
    state = {
      ...state,
      date_from: d.date_from,
      date_to_ymd: d.date_to.slice(0, 10),
      keyword: "",
      sort_order: "asc",
      done_filter: "open_first",
      type_filter: "all",
    };
    if (fromEl) fromEl.value = state.date_from;
    if (toEl) toEl.value = state.date_to_ymd;
    if (kwEl) kwEl.value = state.keyword;
    if (doneEl) doneEl.value = state.done_filter;
    if (typeEl) typeEl.value = state.type_filter;
    if (sortEl) sortEl.value = state.sort_order;
    await fetchAndRender_();
  };

  // 入力（keyword / sort）は即時反映
  kwEl?.addEventListener("input", () => {
    state.keyword = kwEl.value || "";
    applyAndRender_();
  });
  doneEl?.addEventListener("change", () => {
    state.done_filter = doneEl.value || "open_first";
    applyAndRender_();
  });
  typeEl?.addEventListener("change", () => {
    state.type_filter = typeEl.value || "all";
    applyAndRender_();
  });
  sortEl?.addEventListener("change", () => {
    state.sort_order = sortEl.value || "asc";
    applyAndRender_();
  });

  // 期間はサーバ取得の範囲に影響するので「適用」で再取得
  filtersEl?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const a = btn.dataset.action;
    if (a === "clear-keyword") {
      if (kwEl) kwEl.value = "";
      state.keyword = "";
      applyAndRender_();
      return;
    }

    if (a === "reset") {
      await resetToDefault_();
      return;
    }

    if (a === "apply-range") {
      const nextFrom = String(fromEl?.value || "").trim();
      const nextTo = String(toEl?.value || "").trim();
      if (!nextFrom || !nextTo) {
        toast({ title: "入力不足", message: "期間（from/to）を入力してください。" });
        return;
      }
      if (nextFrom > nextTo) {
        toast({ title: "期間エラー", message: "from が to より後になっています。" });
        return;
      }
      state.date_from = nextFrom;
      state.date_to_ymd = nextTo;
      await fetchAndRender_();
      return;
    }
  });

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

        const { results, ctx } = unwrapResults(raw);
        if (ctx) setUser(ctx);

        // 失敗の最小判定（ZIP側の仕様に合わせて後で精密化）
        if (!raw || raw.success === false) {
          throw new Error((raw && raw.error) || "更新に失敗しました。");
        }

        toast({ title: "更新完了", message: `「${nextDone ? "完了" : "未完了"}」に更新しました。` });

        // ===== マージ方式で state を更新し、カードを cardHtml で再描画 =====
        // GAS返却が最小でもUIが壊れないよう、既存vに差分だけ上書きする
        const returned =
          (raw && (raw.visit || raw.result || raw.updated)) ||
          (results && (results.visit || results.result || results.updated)) ||
          null;
        const patch = {
          ...(returned && typeof returned === "object" ? returned : {}),
          visit_id: vid,
          is_done: nextDone,
          done: nextDone,
        };

        const r = mergeVisitById(visitsAll, vid, patch);
        visitsAll = r.list;

        // 成功時の最終ラベル（finallyで戻さない）
        finalText = nextDone ? "未完了に戻す" : "完了にする";
        succeeded = true;

        // 並び順 / フィルタとの整合性を優先して、条件適用後に全体再描画
        applyAndRender_();
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
