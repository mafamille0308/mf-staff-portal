// js/pages/visit_detail.js
import { render, toast, escapeHtml, showModal, showSelectModal, showFormModal, fmt, displayOrDash, fmtDateTimeJst, fmtDateJst, fmtAgeFromBirthdateJst, openBlockingOverlay } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { getIdToken, setUser } from "../auth.js";
import { updateVisitDone } from "./visit_done_toggle.js";
import { toggleVisitType, visitTypeLabel, ensureVisitTypeOptions } from "./visit_type_toggle.js";
import { parkingFeeRuleLabel, pickParkingFeeRule } from "./parking_fee_toggle.js";
import { confirmKeyLocationBeforeDone } from "./visit_done_key_location.js";

const BILLING_STATUS_LABELS_FALLBACK = {
  unbilled:   "未請求",
  invoicing: "請求中",
  paid:      "支払済",
  cancelled: "キャンセル",
  refunded:  "返金済",
  failed:    "支払失敗",
  voided:    "請求取消",
};

let _billingStatusLabelMapCache = null; // { [key]: label }
let _billingStatusOrderCache = null;    // string[]（GAS results の順序）

function billingStatusLabel_(key) {
  const k0 = String(key || "").trim();
  // 仕様：初期値は unbilled。空や欠損はUI上 unbilled 扱い（DB更新はしない）
  const k = k0 ? k0 : "unbilled";
  if (_billingStatusLabelMapCache && _billingStatusLabelMapCache[k]) return _billingStatusLabelMapCache[k];
  return BILLING_STATUS_LABELS_FALLBACK[k] || k;
}

async function ensureBillingStatusLabelMap_(idToken) {
  if (_billingStatusLabelMapCache && Array.isArray(_billingStatusOrderCache)) {
    return { map: _billingStatusLabelMapCache, order: _billingStatusOrderCache };
  }
  try {
    const resp = await callGas({ action: "getBillingStatusOptions" }, idToken);
    const u = unwrapResults(resp);
    const results = (u && Array.isArray(u.results)) ? u.results : [];
    const map = {};
    const order = [];

    for (const x of results) {
      const kk = String(x?.key || x?.status || x?.value || "").trim();
      const ll = String(x?.label || x?.name || "").trim();
      if (!kk || !ll) continue;
      map[kk] = ll;
      order.push(kk);
    }
    // 安全策：unbilled は必ず存在させる（最悪フォールバック）
    if (!map.unbilled) map.unbilled = BILLING_STATUS_LABELS_FALLBACK.unbilled || "未請求";
    if (!order.includes("unbilled")) order.unshift("unbilled");

    _billingStatusLabelMapCache = Object.keys(map).length ? map : { ...BILLING_STATUS_LABELS_FALLBACK };
    _billingStatusOrderCache = order;
  } catch (_) {
    _billingStatusLabelMapCache = { ...BILLING_STATUS_LABELS_FALLBACK };
    _billingStatusOrderCache = Object.keys(_billingStatusLabelMapCache);
  }
  return { map: _billingStatusLabelMapCache, order: _billingStatusOrderCache };
}

const KEY_VD_CACHE_PREFIX = "mf:visit_detail:cache:v1:";
const VD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善）

const KEY_VLIST_DIRTY = "mf:visits_list:dirty:v1";

function markVisitsListDirty_() {
  try { sessionStorage.setItem(KEY_VLIST_DIRTY, "1"); } catch (_) {}
}

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

function formatMoney_(n) {
  const v = Number(n || 0) || 0;
  return v.toLocaleString("ja-JP");
}

function renderCareProfile_(cp) {
  if (!cp || typeof cp !== "object") return `<p class="p">お世話情報がありません。</p>`;

  // 互換吸収（段階移行を許容）
  const warnings = pickFirst_(cp, ["warnings", "注意事項"]);
  const content  = pickFirst_(cp, ["content", "内容"]);
  const food     = pickFirst_(cp, ["food_care", "ごはん", "ごはんのお世話"]);
  const toilet   = pickFirst_(cp, ["toilet_care", "トイレ", "トイレのお世話"]);
  const walk     = pickFirst_(cp, ["walk_care", "散歩", "散歩のお世話"]);
  const play     = pickFirst_(cp, ["play_care", "遊び", "遊び・お散歩のお世話"]);
  const other    = pickFirst_(cp, ["other_care", "その他", "室内環境・その他", "environment_other"]);

  const any = warnings || content || food || toilet || walk || play || other;
  if (!any) return `<p class="p">お世話情報がありません。</p>`;

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

function isMeetingVisit_(visit) {
  const t = String((visit && visit.visit_type) || "").toLowerCase();
  return (t === "meeting_free" || t === "meeting_paid" || t === "meeting");
}

async function runWithBlocking_(opts, task) {
  const blocker = openBlockingOverlay(opts || {});
  try {
    return await task(blocker);
  } finally {
    blocker.close();
  }
}

export async function renderVisitDetail(appEl, query) {
  const visitId = query.get("id") || "";
  const returnTo = String(query.get("return_to") || "").trim();
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
    if (returnTo) {
      e.preventDefault();
      location.hash = returnTo;
      return;
    }
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

  // 請求ステータス候補（失敗してもフォールバック）
  ensureBillingStatusLabelMap_(idToken).catch(() => {});

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

  const visit = res.visit;

  if (!visit) {
    host.innerHTML = `<p class="p">対象の予約が見つかりません。</p>`;
    return;
  }

  const done = (visit.is_done === true);
  const isActive = (visit.is_active === true);

  const billingStatus = String(visit.billing_status || "").trim() || "unbilled";
  const parkingFeeRule = String(visit.parking_fee_rule || "").trim();

  const startDisp = fmtDateTimeJst(visit.start_time || "");
  const endDisp   = fmtDateTimeJst(visit.end_time || "");

  const staffName = fmt(visit.staff_name || "").trim();
  const customerName = fmt(visit.customer_name || "").trim();

  const visitHtml = `
    <div class="card"
      data-visit-id="${escapeHtml(String(visitId))}"
      data-done="${done ? "1" : "0"}"
      data-billing-status="${escapeHtml(String(billingStatus))}"
      data-parking-fee-rule="${escapeHtml(String(parkingFeeRule))}"
      data-is-active="${isActive ? "1" : "0"}"
    >
      <div class="card-title">
      <div class="visit-title">${escapeHtml(displayOrDash(fmt(visit.title)))}</div>
      <div>${escapeHtml(displayOrDash(fmt(visit.visit_id || "")))}</div>
      </div>
      <div class="row card-meta" style="gap:8px; flex-wrap:wrap;">
      <span class="badge badge-visit-type" id="vdVisitTypeBadge"
        data-action="change-visit-type"
        style="cursor:pointer;"
        title="タップで訪問タイプを変更"
        data-role="visit-type-badge"
        data-visit-type="${escapeHtml(String(visit.visit_type || ""))}">
        ${escapeHtml(visitTypeLabel(visit.visit_type || ""))}
      </span>
      <span class="badge badge-billing-status"
        data-action="change-billing-status"
        style="cursor:pointer;"
        title="タップで請求ステータスを変更"
      >
        ${escapeHtml(displayOrDash(fmt(billingStatusLabel_(billingStatus)), "未請求"))}
      </span>
      <span class="badge"
        data-action="change-parking-fee-rule"
        style="cursor:pointer;"
        title="タップで駐車料金区分を変更"
      >
        ${escapeHtml(parkingFeeRuleLabel(parkingFeeRule))}
      </span>
        <span class="badge badge-done ${done ? "badge-ok is-done" : "is-not-done"}"
          data-action="toggle-done"
          style="cursor:pointer;"
          title="タップで完了/未完了を切り替え"
        >${done ? "完了" : "未完了"}</span>
        <span class="badge badge-active ${isActive ? "is-active" : "badge-danger is-inactive"}"
          data-action="toggle-active"
          style="cursor:pointer;"
          title="タップで有効/削除済を切り替え"
        >${isActive ? "有効" : "削除済"}</span>
      </div>
      <div class="hr"></div>
      <div class="p">
      <div><strong>開始</strong>：${escapeHtml(displayOrDash(startDisp))}</div>
      <div><strong>終了</strong>：${escapeHtml(displayOrDash(endDisp))}</div>
        <div class="field field-course"><strong>コース</strong>：${escapeHtml(displayOrDash(visit.course))}</div>
        <div class="field field-product"><strong>商品名</strong>：${escapeHtml(displayOrDash(visit.product_name || visit.service_name || ""))}</div>
        <div class="field field-product"><strong>バリエーション</strong>：${escapeHtml(displayOrDash(visit.variant_name || ""))}</div>
        <div class="field"><strong>駐車料金</strong>：${escapeHtml(formatMoney_(visit.parking_fee_amount || 0))}円</div>
        <div class="field"><strong>出張料金</strong>：${escapeHtml(formatMoney_(visit.travel_fee_amount || 0))}円</div>
        <div class="field"><strong>繁忙期加算</strong>：${escapeHtml(formatMoney_(visit.seasonal_fee_amount || 0))}円</div>
        <div class="field field-staff"><strong>担当者</strong>：${escapeHtml(staffName || displayOrDash(visit.staff_id))}</div>
        <div class="field field-customer"><strong>顧客名</strong>：${escapeHtml(customerName || displayOrDash(visit.customer_id))}</div>
        <div class="field field-memo"><strong>メモ</strong>：<span id="memoText" class="memo-text">${escapeHtml(displayOrDash(visit.memo))}</span></div>
        <div class="row" style="gap:8px; margin-top:8px;">
          <button class="btn btn-ghost" type="button" id="btnEditMemo">メモを編集</button>
          <button class="btn btn-ghost" type="button" id="btnEditFees">料金を編集</button>
          ${isMeetingVisit_(visit) ? `<button class="btn" type="button" id="btnMeetingCustomer">利用登録/更新</button>` : ``}
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
  ensureVisitTypeOptions(idToken)
    .then(() => {
      const b = host.querySelector("#vdVisitTypeBadge");
      if (b) b.textContent = visitTypeLabel(visit.visit_type || "");
    })
    .catch(() => {});

  const meetingBtn = host.querySelector("#btnMeetingCustomer");
  meetingBtn?.addEventListener("click", () => {
    location.hash = `#/meeting-customer?visit_id=${encodeURIComponent(String(visitId))}&back_to=${encodeURIComponent(location.hash || (`#/visits?id=${encodeURIComponent(String(visitId))}`))}`;
  });

  // ===== 後段で顧客詳細を取得して差し替え =====
  try {
    const res2 = await callGas({
      action: "getVisitDetail",
      visit_id: visitId,
      include_customer_detail: true,
    }, idToken);
    if (res2 && res2.ctx) setUser(res2.ctx);
    if (!res2 || res2.success === false) throw new Error((res2 && (res2.error || res2.message)) || "getVisitDetail failed");

    const customerDetail = res2.customer_detail || null;

    let customerInfoHtml = `<p class="p">（顧客情報は未取得）</p>`;
    let petsHtml = `<p class="p">（ペット情報は未取得）</p>`;
    let careHtml = `<p class="p">（お世話情報は未取得）</p>`;

    if (customerDetail && customerDetail.customer) {
      const c = customerDetail.customer;
      const pets = Array.isArray(customerDetail.pets) ? customerDetail.pets : [];
      const cp = customerDetail.careProfile || customerDetail.care_profile || null;

      const customerId2 = String(visit.customer_id || c.id || "").trim();
      const customerLabel2 = String(c.name || customerName || "").trim();

      const customerDetailHref = customerId2
        ? `#/customers?id=${encodeURIComponent(customerId2)}`
        : "";

      const keyPickupRule = fmt(c.keyPickupRule || "").trim();
      const keyPickupRuleOther = fmt(c.keyPickupRuleOther || "").trim();
      const keyReturnRule = fmt(c.keyReturnRule || "").trim();
      const keyReturnRuleOther = fmt(c.keyReturnRuleOther || "").trim();
      const keyPickupDisp = keyPickupRule
        ? (keyPickupRuleOther ? `${keyPickupRule}（${keyPickupRuleOther}）` : keyPickupRule)
        : "";
      const keyReturnDisp = keyReturnRule
        ? (keyReturnRuleOther ? `${keyReturnRule}（${keyReturnRuleOther}）` : keyReturnRule)
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
            <div><strong>鍵所在</strong>：${escapeHtml(displayOrDash(fmt(c.key_location || c.keyLocation || "")))}</div>
            <div><strong>鍵受取</strong>：${escapeHtml(displayOrDash(keyPickupDisp))}</div>
            <div><strong>鍵返却</strong>：${escapeHtml(displayOrDash(keyReturnDisp))}</div>
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

  // ===== billing / active / done 切替（バッジタップ）=====
  host.addEventListener("click", async (e) => {
    const actEl = e.target.closest("[data-action]");
    if (!actEl) return;

    const action = actEl.dataset.action;
    if (!action) return;

    // 予約情報カード（data-* の保管先）
    const rootCard = host.querySelector('.card[data-visit-id]');
    const vid = rootCard?.dataset?.visitId || visitId;

    // 二重送信防止（バッジ単位）
    if (actEl.dataset.busy === "1") return;

    if (action === "toggle-active") {
      const currentActive = (rootCard?.dataset?.isActive === "1");
      const nextActive = !currentActive;

      const ok = await showModal({
        title: "確認",
        bodyHtml: `<p class="p">この予約を「${escapeHtml(nextActive ? "有効" : "削除済")}」に変更します。よろしいですか？</p>`,
        okText: "変更",
        cancelText: "キャンセル",
      });
      if (!ok) return;

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevIsActive = (rootCard?.dataset?.isActive === "1");
      const prevClasses = {
        isActive: actEl.classList.contains("is-active"),
        badgeDanger: actEl.classList.contains("badge-danger"),
        isInactive: actEl.classList.contains("is-inactive"),
      };

      // ===== Optimistic UI（即時反映）=====
      if (rootCard) rootCard.dataset.isActive = nextActive ? "1" : "0";
      actEl.textContent = (nextActive ? "有効" : "削除済");
      actEl.classList.toggle("is-active", nextActive);
      actEl.classList.toggle("badge-danger", !nextActive);
      actEl.classList.toggle("is-inactive", !nextActive);

      try {
        const idToken2 = getIdToken();
        if (!idToken2) {
          toast({ title: "未ログイン", message: "再ログインしてください。" });
          if (rootCard) rootCard.dataset.isActive = prevIsActive ? "1" : "0";
          actEl.textContent = prevText;
          actEl.classList.toggle("is-active", prevClasses.isActive);
          actEl.classList.toggle("badge-danger", prevClasses.badgeDanger);
          actEl.classList.toggle("is-inactive", prevClasses.isInactive);
          return;
        }

        const up = await callGas({
          action: "updateVisit",
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { is_active: nextActive },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        actEl.classList.toggle("is-inactive", !nextActive);

        // 一覧キャッシュ無効化
        markVisitsListDirty_();

        toast({ title: "更新完了", message: "有効ステータスを更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (rootCard) rootCard.dataset.isActive = prevIsActive ? "1" : "0";
        actEl.textContent = prevText;
        actEl.classList.toggle("is-active", prevClasses.isActive);
        actEl.classList.toggle("badge-danger", prevClasses.badgeDanger);
        actEl.classList.toggle("is-inactive", prevClasses.isInactive);
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "change-visit-type") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      actEl.dataset.busy = "1";

      const prevType = String(actEl.dataset.visitType || "").trim();
      const prevText = actEl.textContent;

      // タイトル要素（visit.detail のタイトル）
      const titleEl = rootCard?.querySelector(".visit-title");
      const prevTitleText = titleEl ? titleEl.textContent : "";

      // ===== Optimistic UI（即時反映）=====
      const applyOptimistic = (nextType, nextLabel) => {
        actEl.dataset.visitType = String(nextType || "").trim();
        actEl.textContent = nextLabel;
      };

      const revertOptimistic = () => {
        actEl.dataset.visitType = prevType;
        actEl.textContent = prevText;
        if (titleEl) titleEl.textContent = prevTitleText;
      };

      const applyFinal = (u) => {
        const uu = (u && u.updated && typeof u.updated === "object") ? u.updated : u;
        const vt = String(uu?.visit_type || uu?.visitType || actEl.dataset.visitType || "").trim();
        if (vt) {
          actEl.dataset.visitType = vt;
          actEl.textContent = visitTypeLabel(vt);
        }
        if (uu?.title && titleEl) titleEl.textContent = String(uu.title);
      };

      try {
        await ensureVisitTypeOptions(idToken2);
        await toggleVisitType({
          idToken: idToken2,
          visitId: visitId,
          currentType: prevType,
          applyOptimistic,
          applyFinal,
          revertOptimistic
        });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        try { revertOptimistic(); } catch (_) {}
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "change-billing-status") {
      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      // 候補（GAS優先、失敗時fallback）
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK };
      const ordered = (opt && Array.isArray(opt.order) && opt.order.length) ? opt.order : Object.keys(map);

      const currentKey = String(rootCard?.dataset?.billingStatus || "").trim() || "unbilled";
      const selectId = "vdBillingStatusSelect";

      const optionsHtml = ordered.map(k => {
        const label = String(map[k] || billingStatusLabel_(k));
        const sel = (String(k) === String(currentKey)) ? " selected" : "";
        return `<option value="${escapeHtml(String(k))}"${sel}>${escapeHtml(label)}（${escapeHtml(String(k))}）</option>`;
      }).join("");

      const bodyHtml = `
        <div class="p" style="margin-bottom:8px;">請求ステータスを選択してください。</div>
        <select id="${escapeHtml(selectId)}" class="select" style="width:100%;">
          ${optionsHtml}
        </select>
        <div class="p" style="margin-top:8px; opacity:0.8;">
          現在：<strong>${escapeHtml(billingStatusLabel_(currentKey))}</strong>
        </div>
      `;

      const picked = await showSelectModal({
        title: "請求ステータス変更",
        bodyHtml,
        okText: "変更",
        cancelText: "キャンセル",
        selectId,
      });
      if (picked == null) return; // cancel

      const nextKey = String(picked || "").trim() || "unbilled";
      if (nextKey === currentKey) return; // 変更なし

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevKey = currentKey;

      // ===== Optimistic UI（即時反映）=====
      if (rootCard) rootCard.dataset.billingStatus = nextKey;
      actEl.textContent = billingStatusLabel_(nextKey);

      try {
        const up = await callGas({
          action: "updateVisit",
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { billing_status: nextKey },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        actEl.textContent = billingStatusLabel_(nextKey);

        // 一覧キャッシュ無効化
        markVisitsListDirty_();

        toast({ title: "更新完了", message: "請求ステータスを更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (rootCard) rootCard.dataset.billingStatus = prevKey;
        actEl.textContent = prevText;
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "toggle-done") {
        if (actEl.dataset.busy === "1") return;

      const currentDone = actEl.classList.contains("is-done");
      const nextDone = !currentDone;

      // ===== 確認（キャンセル時は何もしない）=====
      const ok = await showModal({
        title: "確認",
        bodyHtml: `<p class="p">予約 <strong>${escapeHtml(vid)}</strong> を「${nextDone ? "完了" : "未完了"}」に変更します。よろしいですか？</p>`,
        okText: nextDone ? "完了にする" : "未完了に戻す",
        cancelText: "キャンセル",
        danger: false,
      });
      if (!ok) return;
      if (nextDone) {
        const keyResult = await confirmKeyLocationBeforeDone({ visitId: vid });
        if (!keyResult || keyResult.ok !== true) return;
        try {
          const raw = sessionStorage.getItem(cacheKey);
          if (raw) {
            const obj = JSON.parse(raw);
            if (obj && obj.customer_detail && obj.customer_detail.customer && typeof obj.customer_detail.customer === "object") {
              obj.customer_detail.customer.key_location = keyResult.key_location || "";
              obj.customer_detail.customer.keyLocation = keyResult.key_location || "";
              obj.ts = Date.now();
              sessionStorage.setItem(cacheKey, JSON.stringify(obj));
            }
          }
        } catch (_) {}
        try {
          const customerCards = host.querySelectorAll(".card");
          if (customerCards && customerCards.length >= 2) {
            const labels = customerCards[1].querySelectorAll("div");
            labels.forEach((el) => {
              if (el.textContent && el.textContent.indexOf("鍵所在") === 0) {
                el.innerHTML = `<strong>鍵所在</strong>：${escapeHtml(displayOrDash(fmt(keyResult.key_location || "")))}`;
              }
            });
          }
        } catch (_) {}
      }

      actEl.dataset.busy = "1";

      const prevText = actEl.textContent;
      const prevRootDone = (rootCard?.dataset?.done === "1");
      const prevClasses = {
        badgeOk: actEl.classList.contains("badge-ok"),
        isDone: actEl.classList.contains("is-done"),
        isNotDone: actEl.classList.contains("is-not-done"),
      };

      try {
        // ===== Optimistic UI（即時反映）=====
        actEl.textContent = nextDone ? "完了" : "未完了";
        actEl.classList.toggle("badge-ok", nextDone);
        actEl.classList.toggle("is-done", nextDone);
        actEl.classList.toggle("is-not-done", !nextDone);

        // detail の rootCard にも状態保持（将来の判定/保険）
        try { if (rootCard) rootCard.dataset.done = nextDone ? "1" : "0"; } catch (_) {}

        // ===== サーバ更新（失敗なら rollback）=====
        const r = await updateVisitDone({ visitId: vid, nextDone });
        if (!r.ok) throw new Error(r.error || "更新に失敗しました。");

        // ===== 詳細キャッシュへ done 書き戻し（要件）=====
        try {
          const raw = sessionStorage.getItem(cacheKey);
          if (raw) {
            const obj = JSON.parse(raw);
            if (obj && obj.visit && typeof obj.visit === "object") {
              obj.visit.is_done = !!nextDone;
              obj.visit.done = !!nextDone;
              obj.ts = Date.now(); // 表示整合性のため更新扱い
              sessionStorage.setItem(cacheKey, JSON.stringify(obj));
            }
          }
        } catch (_) {}

        // 一覧キャッシュ無効化（戻ったときに反映されるように）
        markVisitsListDirty_();
        toast({ title: "更新完了", message: `「${nextDone ? "完了" : "未完了"}」に更新しました。` });
      } catch (err) {
        toast({ title: "更新失敗", message: (err && err.message) ? err.message : String(err || "") });
        // rollback
        try {
          actEl.textContent = prevText;
          actEl.classList.toggle("badge-ok", prevClasses.badgeOk);
          actEl.classList.toggle("is-done", prevClasses.isDone);
          actEl.classList.toggle("is-not-done", prevClasses.isNotDone);
        } catch (_) {}
        try { if (rootCard) rootCard.dataset.done = prevRootDone ? "1" : "0"; } catch (_) {}
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }

    if (action === "change-parking-fee-rule") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      const currentKey = String(rootCard?.dataset?.parkingFeeRule || "").trim();
      const nextKey = await pickParkingFeeRule(currentKey, { title: "駐車料金区分変更", selectId: "vdParkingFeeRuleSelect" });
      if (nextKey == null) return;
      if (nextKey === currentKey) return;

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevKey = currentKey;

      if (rootCard) rootCard.dataset.parkingFeeRule = nextKey;
      actEl.textContent = parkingFeeRuleLabel(nextKey);

      try {
        const up = await callGas({
          action: "updateVisit",
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { parking_fee_rule: nextKey },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        markVisitsListDirty_();
        toast({ title: "更新完了", message: "駐車料金区分を更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (rootCard) rootCard.dataset.parkingFeeRule = prevKey;
        actEl.textContent = prevText;
      } finally {
        actEl.dataset.busy = "0";
      }
      return;
    }
  });

  // ===== memo 編集 =====
  const btnEdit = host.querySelector("#btnEditMemo");
  const btnEditFees = host.querySelector("#btnEditFees");
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
  if (btnEditFees) btnEditFees.addEventListener("click", async () => {
    const formValues = await showFormModal({
      title: "料金を編集",
      bodyHtml: `
        <form data-el="visitFeeForm">
          <div style="display:grid; gap:10px;">
            <label>
              <div style="opacity:.85; margin-bottom:4px;"><strong>駐車料金</strong></div>
              <input class="input" type="number" name="parking_fee_amount" min="0" step="1" inputmode="numeric" value="${escapeHtml(String(Number(visit.parking_fee_amount || 0) || 0))}" />
            </label>
            <label>
              <div style="opacity:.85; margin-bottom:4px;"><strong>出張料金</strong></div>
              <input class="input" type="number" name="travel_fee_amount" min="0" step="1" inputmode="numeric" value="${escapeHtml(String(Number(visit.travel_fee_amount || 0) || 0))}" />
            </label>
            <label>
              <div style="opacity:.85; margin-bottom:4px;"><strong>繁忙期加算</strong></div>
              <input class="input" type="number" name="seasonal_fee_amount" min="0" step="1" inputmode="numeric" value="${escapeHtml(String(Number(visit.seasonal_fee_amount || 0) || 0))}" />
            </label>
          </div>
        </form>
      `,
      okText: "保存",
      cancelText: "キャンセル",
      formSelector: '[data-el="visitFeeForm"]'
    });
    if (formValues == null) return;
    try {
      const idToken2 = getIdToken();
      if (!idToken2) throw new Error("再ログインしてください。");
      await runWithBlocking_(
        {
          title: "料金を保存しています",
          bodyHtml: "予約の請求用金額を更新しています。",
          busyText: "保存中...",
        },
        async () => {
          const up = await callGas({
            action: "updateVisit",
            origin: "portal",
            source: "portal",
            visit_id: visitId,
            fields: {
              parking_fee_amount: Number(formValues.parking_fee_amount || 0) || 0,
              travel_fee_amount: Number(formValues.travel_fee_amount || 0) || 0,
              seasonal_fee_amount: Number(formValues.seasonal_fee_amount || 0) || 0,
            },
          }, idToken2);
          const u = unwrapResults(up);
          if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");
        }
      );
      markVisitsListDirty_();
      toast({ title: "更新完了", message: "料金を更新しました。" });
      location.reload();
    } catch (err) {
      toast({ title: "更新失敗", message: err?.message || String(err || "") });
    }
  });
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
      const freshMemo = await runWithBlocking_(
        {
          title: "メモを保存しています",
          bodyHtml: "最新の予約情報を再取得しています。",
          busyText: "保存中...",
        },
        async (blocker) => {
          const idToken2 = getIdToken();
          if (!idToken2) {
            toast({ title: "未ログイン", message: "再ログインしてください。" });
            return null;
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

          blocker.setBusyText("最新情報を確認しています...");
          const re = await callGas({
            action: "getVisitDetail",
            visit_id: visitId,
            include_customer_detail: true,
          }, idToken2);

          if (!re || re.success === false) {
            throw new Error((re && (re.error || re.message)) || "再取得に失敗しました。");
          }
          if (re.ctx) setUser(re.ctx);

          const v2 = re.visit;
          return fmt(v2 && v2.memo).trim();
        }
      );
      if (freshMemo == null) return;

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
