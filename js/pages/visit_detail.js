// js/pages/visit_detail.js
import { render, toast, escapeHtml, showModal, fmt, displayOrDash, fmtDateTimeJst, fmtDateJst, fmtAgeFromBirthdateJst } from "../ui.js";
import { callGas, unwrapOne, unwrapResults } from "../api.js";
import { getIdToken, setUser } from "../auth.js";
import { toggleVisitDone } from "./visit_done_toggle.js";

const VISIT_TYPE_LABELS_FALLBACK = {
  sitting: "シッティング",
  training: "トレーニング",
  meeting_free: "打ち合わせ（無料）",
  meeting_paid: "打ち合わせ（有料）",
};

let _visitTypeLabelMapCache = null; // { [key]: label }

function visitTypeLabel_(key) {
  const k = String(key || "").trim();
  if (!k) return "訪問種別未設定";
  if (_visitTypeLabelMapCache && _visitTypeLabelMapCache[k]) return _visitTypeLabelMapCache[k];
  return VISIT_TYPE_LABELS_FALLBACK[k] || k;
}

async function ensureVisitTypeLabelMap_(idToken) {
  if (_visitTypeLabelMapCache) return _visitTypeLabelMapCache;
  try {
    const resp = await callGas({ action: "getVisitTypeOptions" }, idToken);
    const u = unwrapResults(resp);
    const results = (u && Array.isArray(u.results)) ? u.results : [];
    const map = {};
    for (const x of results) {
      const kk = String(x?.key || x?.type || x?.value || "").trim();
      const ll = String(x?.label || x?.name || "").trim();
      if (kk) map[kk] = ll || kk;
    }
    _visitTypeLabelMapCache = Object.keys(map).length ? map : { ...VISIT_TYPE_LABELS_FALLBACK };
  } catch (_) {
    _visitTypeLabelMapCache = { ...VISIT_TYPE_LABELS_FALLBACK };
  }
  return _visitTypeLabelMapCache;
}

const KEY_VD_CACHE_PREFIX = "mf:visit_detail:cache:v1:";
const VD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善）

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

function lineBlock_(label, text) {
  const s = normStr_(text);
  if (!s) return "";
  return `
    <div class="hr"></div>
    <div class="p"><strong>${escapeHtml(label)}</strong></div>
    <div class="card">
      <div class="p" style="white-space:pre-wrap;">${escapeHtml(s)}</div>
    </div>
  `;
}

function rawToggle_(rawText) {
  const s = normStr_(rawText);
  if (!s) return "";
  return `
    <div style="margin-top:14px;">
      <details class="details">
        <summary class="p" style="cursor:pointer; user-select:none; margin:0;">
          <strong>カルテ原本（OCR）</strong>（必要時のみ確認）
        </summary>
        <div class="card" style="margin-top:8px;">
          <div class="p" style="white-space:pre-wrap;">${escapeHtml(s)}</div>
        </div>
      </details>
    </div>
  `;
}

function renderCareProfile_(cp) {
  if (!cp || typeof cp !== "object") return `<p class="p">お世話情報がありません。</p>`;

  // 互換吸収（段階移行を許容）
  const warnings = pickFirst_(cp, ["warnings", "注意事項"]);
  const raw      = pickFirst_(cp, ["content_raw", "内容原本"]);
  const content  = pickFirst_(cp, ["content", "内容"]);
  const food     = pickFirst_(cp, ["food_care", "ごはん", "ごはんのお世話"]);
  const toilet   = pickFirst_(cp, ["toilet_care", "トイレ", "トイレのお世話"]);
  const walk     = pickFirst_(cp, ["walk_care", "散歩", "散歩のお世話"]);
  const play     = pickFirst_(cp, ["play_care", "遊び", "遊び・お散歩のお世話"]);
  const other    = pickFirst_(cp, ["other_care", "その他", "室内環境・その他", "environment_other"]);

  const any = warnings || raw || content || food || toilet || walk || play || other;
  if (!any) return `<p class="p">お世話情報がありません。</p>`;

  const anyStructured = warnings || content || food || toilet || walk || play || other;

  const block_ = (label, text) => {
    const s = normStr_(text);
    if (!s) return "";
    return `
      <div style="margin-top:12px;">
        <div style="opacity:.85; margin-bottom:4px;"><strong>${escapeHtml(label)}</strong></div>
        <div style="white-space:pre-wrap;">${escapeHtml(s)}</div>
      </div>
    `;
  };

  return `
    <div class="card">
      <div class="p">
        ${block_("注意事項", warnings)}
        ${block_("ごはん", food)}
        ${block_("トイレ", toilet)}
        ${block_("散歩", walk)}
        ${block_("遊び", play)}
        ${block_("その他", other)}
        ${(!anyStructured && raw) ? rawToggle_(raw) : (raw ? rawToggle_(raw) : "")}
      </div>
    </div>
  `;
}

function section(title, bodyHtml, actionsHtml) {
  return `
    <div style="margin-top:18px;"></div>
    <div class="row row-between">
      <h2 class="h2">${escapeHtml(title)}</h2>
      <div>${actionsHtml || ""}</div>
    </div>
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
        <a class="btn btn-ghost" href="#/visits" id="btnBackToList">一覧に戻る</a>
      </div>
      <div class="hr"></div>
      <div id="visitDetailHost"><p class="p">読み込み中...</p></div>
    </section>
  `);

  const backBtn = appEl.querySelector("#btnBackToList");
  backBtn?.addEventListener("click", (e) => {
    // 履歴があれば back を優先（一覧のスクロール/体感が良い）
    if (window.history && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
  });

  const host = appEl.querySelector("#visitDetailHost");
  if (!host) return;

  const idToken = getIdToken();
  if (!idToken) {
    host.innerHTML = `<p class="p">ログインしてください。</p>`;
    return;
  }

  // ===== cache（任意：直近に開いた詳細は即表示）=====
  const cacheKey = KEY_VD_CACHE_PREFIX + String(visitId);
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.ts && (Date.now() - Number(obj.ts)) <= VD_CACHE_TTL_MS && obj.visit) {
        // キャッシュがあれば先に描画（後で最新取得に置き換える）
        host.innerHTML = `<p class="p">読み込み中...</p>`;
      }
    }
  } catch (_) {}

  let res;
  try {
    // まず「予約情報のみ」を先に出す（体感優先）
    res = await callGas({
      action: "getVisitDetail",
      visit_id: visitId,
      include_customer_detail: false,
    }, idToken);
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

  const visit = unwrapOne(res);

  if (!visit) {
    host.innerHTML = `<p class="p">対象の予約が見つかりません。</p>`;
    return;
  }

  const done = (visit.done === true) || (String(visit.is_done || "").toLowerCase() === "true");
  const isActive = !(visit.is_active === false || String(visit.is_active || "").toLowerCase() === "false");

  const startDisp = fmtDateTimeJst(visit.start_time || visit.start || "");
  const endDisp   = fmtDateTimeJst(visit.end_time || visit.end || "");

  // 名前表示を優先（GAS側で付与する想定）
  const staffName = fmt(visit.staff_name || visit.staffName || "").trim();
  const customerName = fmt(visit.customer_name || visit.customerName || "").trim();

  const visitHtml = `
    <div class="card">
      <div class="card-title">
      <div class="visit-title">${escapeHtml(displayOrDash(fmt(visit.title)))}</div>
      <div>${escapeHtml(displayOrDash(fmt(visit.visit_id || "")))}</div>
      </div>
      <div class="row card-meta" style="gap:8px; flex-wrap:wrap;">
      <span class="badge badge-visit-type" id="vdVisitTypeBadge">
        ${escapeHtml(visitTypeLabel_(visit.visit_type || ""))}
      </span>
      <span class="badge badge-billing-status">
        ${escapeHtml(displayOrDash(fmt((visit.billing_status || visit.request_status) || ""), "請求未確定"))}
      </span>
        <span class="badge badge-done ${done ? "badge-ok is-done" : "is-not-done"}"
          data-action="toggle-done"
          style="cursor:pointer;"
          title="タップで完了/未完了を切り替え"
        >${done ? "完了" : "未完了"}</span>
        <span class="badge badge-active ${isActive ? "is-active" : "badge-danger is-inactive"}">${isActive ? "有効" : "削除済"}</span>
      </div>
      <div class="hr"></div>
      <div class="p">
      <div><strong>開始</strong>：${escapeHtml(displayOrDash(startDisp))}</div>
      <div><strong>終了</strong>：${escapeHtml(displayOrDash(endDisp))}</div>
        <div class="field field-course"><strong>コース</strong>：${escapeHtml(displayOrDash(visit.course))}</div>
        <div class="field field-staff"><strong>担当者</strong>：${escapeHtml(staffName || displayOrDash(visit.staff_id))}</div>
        <div class="field field-customer"><strong>顧客名</strong>：${escapeHtml(customerName || displayOrDash(visit.customer_id))}</div>
        <div class="field field-memo"><strong>メモ</strong>：<span id="memoText" class="memo-text">${escapeHtml(displayOrDash(visit.memo))}</span></div>
        <div class="row" style="gap:8px; margin-top:8px;">
          <button class="btn btn-ghost" type="button" id="btnEditMemo">メモを編集</button>
        </div>
        <div id="memoEditBox" class="is-hidden" style="margin-top:10px;">
          <textarea id="memoInput" rows="5" style="width:100%;"></textarea>
          <div class="row" style="gap:8px; justify-content:flex-end; margin-top:8px;">
            <button class="btn btn-ghost" type="button" id="btnCancelMemo">キャンセル</button>
            <button class="btn" type="button" id="btnSaveMemo">保存</button>
          </div>
          <div class="p" style="margin-top:6px; opacity:0.75;">空欄で保存するとメモは空になります。</div>
        </div>
      </div>
    </div>
  `;

  host.innerHTML = `
    ${section("予約情報", visitHtml, "")}
    ${section("顧客情報", `<p class="p" id="vdCustomerLoading">顧客情報を読み込み中...</p>`, "")}
    ${section("ペット情報", `<p class="p" id="vdPetsLoading">ペット情報を読み込み中...</p>`, "")}
    ${section("お世話情報", `<p class="p" id="vdCareLoading">お世話情報を読み込み中...</p>`, "")}
  `;

  // ===== 訪問タイプの日本語ラベル取得（失敗してもフォールバック表示）=====
  ensureVisitTypeLabelMap_(idToken)
    .then(() => {
      const b = host.querySelector("#vdVisitTypeBadge");
      if (b) b.textContent = visitTypeLabel_(visit.visit_type || "");
    })
    .catch(() => {});

  // ===== 後段で顧客詳細を取得して差し替え =====
  try {
    const res2 = await callGas({
      action: "getVisitDetail",
      visit_id: visitId,
      include_customer_detail: true,
    }, idToken);
    if (res2 && res2.ctx) setUser(res2.ctx);
    if (!res2 || res2.success === false) throw new Error((res2 && (res2.error || res2.message)) || "getVisitDetail failed");

    const customerDetail = res2.customer_detail || res2.customerDetail || null;

    let customerInfoHtml = `<p class="p">（顧客情報は未取得）</p>`;
    let petsHtml = `<p class="p">（ペット情報は未取得）</p>`;
    let careHtml = `<p class="p">（お世話情報は未取得）</p>`;

    if (customerDetail && customerDetail.customer) {
      const c = customerDetail.customer;
      const pets = Array.isArray(customerDetail.pets) ? customerDetail.pets : [];
      const cp = customerDetail.careProfile || customerDetail.care_profile || null;

      const customerId2 = String(visit.customer_id || visit.customerId || c.id || c.customer_id || "").trim();
      const customerLabel2 = String(c.name || customerName || "").trim();

      const customerDetailHref = customerId2
        ? `#/customers?id=${encodeURIComponent(customerId2)}`
        : "";

      customerInfoHtml = `
        <div class="card">
          <div class="row row-between">
            <div class="p"><strong>${escapeHtml(displayOrDash(customerLabel2))}</strong></div>
            <div>
              ${customerDetailHref ? `<a class="btn" href="${customerDetailHref}">顧客詳細へ</a>` : ``}
            </div>
          </div>
          <div class="hr"></div>
          <div class="p">
            <div><strong>電話</strong>：${escapeHtml(displayOrDash(fmt(c.phone || "")))}</div>
            <div><strong>住所</strong>：${escapeHtml(displayOrDash(fmt(c.address_full || c.address || "")))}</div>
            <div><strong>鍵</strong>：${escapeHtml(displayOrDash(fmt(c.key_location || c.keyLocation || "")))}</div>
          </div>
        </div>
      `;

      petsHtml = pets.length
        ? pets.map(p => `
            <div class="card">
              <div class="p">
                <div><strong>${escapeHtml(fmt(p.name || p.pet_name || ""))}</strong></div>
                <div>種類：${escapeHtml(displayOrDash(fmt(p.species || p.type || p.pet_type || "")))}</div>
                <div>品種：${escapeHtml(displayOrDash(fmt(p.breed || "")))}</div>
                <div>誕生日：${escapeHtml(displayOrDash(fmtDateJst(p.birthdate || "")))}</div>
                <div>年齢：${escapeHtml(displayOrDash(fmtAgeFromBirthdateJst(p.birthdate || "")))}</div>
                <div>メモ：${escapeHtml(displayOrDash(fmt(p.notes || p.memo || "")))}</div>
                <div>病院：${escapeHtml(displayOrDash(fmt(p.hospital || "")))}</div>
                <div>病院電話：${escapeHtml(displayOrDash(fmt(p.hospital_phone || "")))}</div>
              </div>
            </div>
          `).join("")
        : `<p class="p">ペット情報がありません。</p>`;

      careHtml = cp ? renderCareProfile_(cp) : `<p class="p">お世話情報がありません。</p>`;
    }

    // 差し替え（各セクションのみ）
    const secC = host.querySelector("#vdCustomerLoading");
    if (secC) secC.outerHTML = customerInfoHtml;
    const secP = host.querySelector("#vdPetsLoading");
    if (secP) secP.outerHTML = petsHtml;
    const secCp = host.querySelector("#vdCareLoading");
    if (secCp) secCp.outerHTML = careHtml;

    // cache 保存
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), visit: visit, customer_detail: customerDetail }));
    } catch (_) {}
  } catch (e) {
    // 顧客詳細が落ちても予約情報は見せる（体感優先）
    const secC = host.querySelector("#vdCustomerLoading");
    if (secC) secC.outerHTML = `<p class="p">顧客情報の取得に失敗しました。</p>`;
    const secP = host.querySelector("#vdPetsLoading");
    if (secP) secP.outerHTML = `<p class="p">ペット情報の取得に失敗しました。</p>`;
    const secCp = host.querySelector("#vdCareLoading");
    if (secCp) secCp.outerHTML = `<p class="p">お世話情報の取得に失敗しました。</p>`;
  }

  // ===== done 切替（バッジタップ）=====
  host.addEventListener("click", async (e) => {
    const actEl = e.target.closest('[data-action="toggle-done"]');
    if (!actEl) return;
    if (actEl.dataset.busy === "1") return;

    const currentDone = actEl.classList.contains("is-done");
    actEl.dataset.busy = "1";
    const prevText = actEl.textContent;
    actEl.textContent = "更新中...";

    try {
      const r = await toggleVisitDone({ visitId, currentDone });
      if (!r.ok) {
        actEl.textContent = prevText;
        return;
      }

      // 表示だけ更新（再取得は後回し：性能最適化フェーズで検討）
      const nextDone = !!r.nextDone;
      actEl.textContent = nextDone ? "完了" : "未完了";
      actEl.classList.toggle("badge-ok", nextDone);
      actEl.classList.toggle("is-done", nextDone);
      actEl.classList.toggle("is-not-done", !nextDone);
    } catch (err) {
      toast({ title: "更新失敗", message: (err && err.message) ? err.message : String(err || "") });
      actEl.textContent = prevText;
    } finally {
      actEl.dataset.busy = "0";
    }
  });

  // ===== memo 編集 =====
  const btnEdit = host.querySelector("#btnEditMemo");
  const btnCancel = host.querySelector("#btnCancelMemo");
  const btnSave = host.querySelector("#btnSaveMemo");
  const editBox = host.querySelector("#memoEditBox");
  const memoInput = host.querySelector("#memoInput");
  const memoText = host.querySelector("#memoText");

  let currentMemo = fmt(visit.memo || "");
  if (memoInput) memoInput.value = currentMemo;

  const setEditMode = (on) => {
    if (!editBox) return;
    editBox.classList.toggle("is-hidden", !on);
    if (on && memoInput) memoInput.focus();
  };

  if (btnEdit) btnEdit.addEventListener("click", () => setEditMode(true));
  if (btnCancel) btnCancel.addEventListener("click", () => {
    if (memoInput) memoInput.value = currentMemo;
    setEditMode(false);
  });

  if (btnSave) btnSave.addEventListener("click", async () => {
    if (!memoInput) return;
    if (btnSave.disabled || btnSave.dataset.busy === "1") return;

    const nextMemo = String(memoInput.value || "");
    // 任意：過剰入力ガード（上限は運用に合わせて調整）
    if (nextMemo.length > 2000) {
      toast({ title: "入力エラー", message: "メモが長すぎます（最大2000文字）。" });
      return;
    }

    const ok = await showModal({
      title: "確認",
      bodyHtml: `<p class="p">メモを保存します。よろしいですか？</p>`,
      okText: "保存",
      cancelText: "キャンセル",
    });
    if (!ok) return;

    btnSave.dataset.busy = "1";
    btnSave.disabled = true;
    const prevText = btnSave.textContent;
    btnSave.textContent = "保存中...";

    try {
      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      const up = await callGas({
        action: "updateVisit",
        origin: "portal",
        source: "portal",
        visit_id: visitId,
        fields: { memo: nextMemo },
      }, idToken2);

      if (!up || up.success === false) {
        throw new Error((up && (up.error || up.message)) || "更新に失敗しました。");
      }

      // 取り違え防止：保存後に必ず最新を取り直す（visit の memo を更新）
      const re = await callGas({
        action: "getVisitDetail",
        visit_id: visitId,
        include_customer_detail: true,
      }, idToken2);

      if (!re || re.success === false) {
        throw new Error((re && (re.error || re.message)) || "再取得に失敗しました。");
      }
      if (re.ctx) setUser(re.ctx);

      const v2 = unwrapOne(re);
      const freshMemo = fmt(v2 && v2.memo).trim();

      if (memoText) memoText.textContent = freshMemo ? freshMemo : "—";
      currentMemo = freshMemo;
      if (memoInput) memoInput.value = currentMemo;
      setEditMode(false);

      toast({ title: "保存完了", message: "メモを更新しました。" });
    } catch (err) {
      toast({ title: "保存失敗", message: (err && err.message) ? err.message : String(err || "") });
    } finally {
      btnSave.dataset.busy = "0";
      btnSave.disabled = false;
      btnSave.textContent = prevText;
    }
  });
}
