// js/pages/visit_detail.js
import { render, toast, escapeHtml, showModal, showSelectModal, showFormModal, fmt, displayOrDash, fmtDateTimeJst, fmtDateJst, fmtAgeFromBirthdateJst } from "../ui.js";
import { getIdToken, setUser } from "../auth.js";
import { updateVisitDone } from "./visit_done_toggle.js";
import { parkingFeeRuleLabel, pickParkingFeeRule } from "./parking_fee_toggle.js";
import { confirmKeyLocationBeforeDone } from "./visit_done_key_location.js";
import { fetchVisitDetailPolicy, callUpdateVisitPolicy } from "./visits_policy.js";
import { BILLING_STATUS_LABELS_FALLBACK_, billingStatusLabel_, ensureBillingStatusLabelMap_ } from "./visit_billing_status.js";
import { normalizeCancelBillingStatus_, pickCancellationFeeRate_ } from "./visit_cancel_policy.js";
import { pickVisitBasePriceRule_ as pickVisitBasePriceRuleShared_ } from "./visit_base_price_rule_picker.js";
import { normalizeBillingStatusForPriceRuleEdit_, productBadgeLabel_ } from "./visit_common_helpers.js";
import { formatMoney_, runWithBlocking_ } from "./visit_ui_helpers.js";
import { listBillingPriceRulesForVisit_ as listBillingPriceRules_ } from "./visits_billing_policy.js";
import { runReactivateVisitFlow_ } from "./visit_reactivate_flow.js";
import { runCancelVisitFlow_ } from "./visit_cancel_flow.js";

const KEY_VD_CACHE_PREFIX = "mf:visit_detail:cache:v1:";
const VD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分（体感改善）

const KEY_VLIST_DIRTY = "mf:visits_list:dirty:v1";
const KEY_PENDING_CANCEL_DRAFT = "mf:pending_cancel_draft:v1";

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

async function fetchVisitDetail_(visitId, idToken, options = {}) {
  return fetchVisitDetailPolicy(visitId, idToken, options);
}

function renderCareProfile_(cp) {
  if (!cp || typeof cp !== "object") return `<p class="p">お世話情報がありません。</p>`;

  // 互換吸収（段階移行を許容）
  const warnings = pickFirst_(cp, ["warnings", "注意事項"]);
  const food     = pickFirst_(cp, ["food_care", "ごはん", "ごはんのお世話"]);
  const toilet   = pickFirst_(cp, ["toilet_care", "トイレ", "トイレのお世話"]);
  const walk     = pickFirst_(cp, ["walk_care", "散歩", "散歩のお世話"]);
  const play     = pickFirst_(cp, ["play_care", "遊び", "遊び・お散歩のお世話"]);
  const other    = pickFirst_(cp, ["other_care", "その他", "室内環境・その他", "environment_other"]);

  const any = warnings || food || toilet || walk || play || other;
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
  const label = String((visit && (visit.price_rule_label || visit.product_name || visit.service_name || visit.title || visit.price_rule_id)) || "").toLowerCase();
  return (label.indexOf("カウンセリング") >= 0 || label.indexOf("打ち合わせ") >= 0);
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
    res = await fetchVisitDetail_(visitId, idToken, { include_customer_detail: false });
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

  let visit = res.visit;

  if (!visit) {
    host.innerHTML = `<p class="p">対象の予約が見つかりません。</p>`;
    return;
  }

  const done = (visit.is_done === true);
  const isActive = (visit.is_active === true);

  const billingStatus = String(visit.billing_status || "").trim() || "unbilled";
  const refundDetected = !!visit.refund_detected;
  const refundKind = String(visit.refund_kind || "").trim().toLowerCase();
  const refundLabel = refundKind === "partial" ? "返金検知（一部）" : "返金検知（全額）";
  const cancellationFeeAmount = Math.max(0, Number(visit.cancellation_fee_amount || 0) || 0);
  const cancellationFeeRate = Math.max(0, Number(visit.cancellation_fee_rate || 0) || 0);
  const hasCancellationFee = !isActive && cancellationFeeAmount > 0 && billingStatus === "billed";

  const startDisp = fmtDateTimeJst(visit.start_time || "");
  const endDisp   = fmtDateTimeJst(visit.end_time || "");

  const staffName = fmt(visit.staff_name || "").trim();
  const customerName = fmt(visit.customer_name || "").trim();

  const visitHtml = `
    <div class="card"
      data-visit-id="${escapeHtml(String(visitId))}"
      data-done="${done ? "1" : "0"}"
      data-billing-status="${escapeHtml(String(billingStatus))}"
      data-is-active="${isActive ? "1" : "0"}"
      data-price-rule-id="${escapeHtml(String(visit.price_rule_id || ""))}"
    >
      <div class="card-title">
      <div class="visit-title">${escapeHtml(displayOrDash(fmt(visit.title)))}</div>
      <div>${escapeHtml(displayOrDash(fmt(visit.visit_id || "")))}</div>
      </div>
      <div class="row card-meta" style="gap:8px; flex-wrap:wrap;">
      <span class="badge badge-visit-type" id="vdVisitTypeBadge"
        data-action="change-price-rule"
        style="cursor:pointer;"
        title="タップで訪問基本料金を変更"
        data-role="visit-type-badge">
        ${escapeHtml(productBadgeLabel_(visit))}
      </span>
      ${String(visit.variant_name || "").trim() ? `
      <span class="badge">${escapeHtml(String(visit.variant_name || "").trim())}</span>
      ` : ``}
      <span class="badge badge-billing-status"
      >
        ${escapeHtml(displayOrDash(fmt(billingStatusLabel_(billingStatus)), "未請求"))}
      </span>
      ${refundDetected ? `<span class="badge badge-danger">${escapeHtml(refundLabel)}</span>` : ``}
      ${hasCancellationFee ? `<span class="badge badge-danger">キャンセル料: ${escapeHtml(formatMoney_(cancellationFeeAmount))}円（${escapeHtml(String(cancellationFeeRate))}%）</span>` : ``}
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
      <div><strong>開始</strong>：<span id="vdStartTimeText">${escapeHtml(displayOrDash(startDisp))}</span></div>
      <div><strong>終了</strong>：<span id="vdEndTimeText">${escapeHtml(displayOrDash(endDisp))}</span></div>
        <div class="field field-staff"><strong>担当者</strong>：${escapeHtml(staffName || displayOrDash(visit.staff_id))}</div>
        <div class="field field-customer"><strong>顧客名</strong>：${escapeHtml(customerName || displayOrDash(visit.customer_id))}</div>
        <div class="field field-memo"><strong>メモ</strong>：<span id="memoText" class="memo-text">${escapeHtml(displayOrDash(visit.memo))}</span></div>
        <div class="row" style="gap:8px; margin-top:8px;">
          <button class="btn btn-ghost" type="button" id="btnEditMemo">メモを編集</button>
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

  const badgeEl = host.querySelector("#vdVisitTypeBadge");
  if (badgeEl) badgeEl.textContent = productBadgeLabel_(visit);

  const meetingBtn = host.querySelector("#btnMeetingCustomer");
  meetingBtn?.addEventListener("click", () => {
    location.hash = `#/meeting-customer?visit_id=${encodeURIComponent(String(visitId))}&back_to=${encodeURIComponent(location.hash || (`#/visits?id=${encodeURIComponent(String(visitId))}`))}`;
  });

  // ===== 後段で顧客詳細を取得して差し替え =====
  try {
    const res2 = await fetchVisitDetail_(visitId, idToken, { include_customer_detail: true });
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
      const currentDone = (rootCard?.dataset?.done === "1");
      if (!nextActive && currentDone) {
        toast({ title: "変更不可", message: "完了済みの予約は削除済みにできません。未完了に戻してから実行してください。" });
        return;
      }

      actEl.dataset.busy = "1";
      const prevText = actEl.textContent;
      const prevIsActive = (rootCard?.dataset?.isActive === "1");
      const prevClasses = {
        isActive: actEl.classList.contains("is-active"),
        badgeDanger: actEl.classList.contains("badge-danger"),
        isInactive: actEl.classList.contains("is-inactive"),
      };

      try {
        const idToken2 = getIdToken();
        if (!idToken2) {
          toast({ title: "未ログイン", message: "再ログインしてください。" });
          return;
        }

        if (!nextActive) {
          const pickedRate = await pickCancellationFeeRate_();
          if (pickedRate == null) return;
          const flow = await runCancelVisitFlow_(vid, idToken2, {
            source: "portal",
            cancellation_rate: pickedRate,
            current_billing_status: currentBillingStatus,
          });
          if (flow?.skipped) return;
          const done = flow?.done || {};
          const syncErrors = Array.isArray(flow?.sync_errors) ? flow.sync_errors : [];
          if (flow?.needs_draft && flow?.draft_payload) {
            try {
              sessionStorage.setItem(KEY_PENDING_CANCEL_DRAFT, JSON.stringify({
                visit_id: String(vid || "").trim(),
                cancellation_rate: Number(flow.draft_payload.cancellation_rate || 0) || 0,
                allow_non_unbilled: true,
                source_batch_id: String(flow.draft_payload.source_batch_id || "").trim(),
                remaining_visit_ids: Array.isArray(flow.draft_payload.remaining_visit_ids) ? flow.draft_payload.remaining_visit_ids : [],
                canceled_visit_ids: Array.isArray(flow.draft_payload.canceled_visit_ids) ? flow.draft_payload.canceled_visit_ids : [String(vid || "").trim()],
                cancellation_fee_by_visit: (flow.draft_payload.cancellation_fee_by_visit && typeof flow.draft_payload.cancellation_fee_by_visit === "object")
                  ? flow.draft_payload.cancellation_fee_by_visit
                  : { [String(vid || "").trim()]: Number(done?.cancellation_fee_amount || 0) || 0 },
              }));
            } catch (_) {}
            markVisitsListDirty_();
            location.hash = "#/visits";
            return;
          }
          toast({
            title: "更新完了",
            message: done.square_action === "manual_refund_required"
              ? "キャンセルしました。Squareで返金処理を行ってください。"
              : "キャンセル処理が完了しました。"
          });
          if (syncErrors.length) {
            toast({ title: "カレンダー同期警告", message: "予約更新は完了しましたが、カレンダー同期に失敗しました。再実行してください。" });
          }
        } else {
          const flow = await runReactivateVisitFlow_(vid, idToken2, { source: "portal" });
          if (flow?.skipped) return;
          const done = flow?.done || {};
          const syncErrors = Array.isArray(done?.sync_errors) ? done.sync_errors : [];
          toast({ title: "更新完了", message: String(done?.message || "有効ステータスを更新しました。") });
          if (syncErrors.length) {
            toast({ title: "カレンダー同期警告", message: "再有効化は完了しましたが、カレンダー同期に失敗しました。再実行してください。" });
          }
        }

        // 一覧キャッシュ無効化
        markVisitsListDirty_();

        location.reload();
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

    if (action === "change-price-rule") {
      if (actEl.dataset.busy === "1") return;

      const idToken2 = getIdToken();
      if (!idToken2) {
        toast({ title: "未ログイン", message: "再ログインしてください。" });
        return;
      }

      actEl.dataset.busy = "1";

      const prevRuleId = String(rootCard?.dataset?.priceRuleId || visit?.price_rule_id || "").trim();
      const prevText = actEl.textContent;

      // タイトル要素（visit.detail のタイトル）
      const titleEl = rootCard?.querySelector(".visit-title");
      const prevTitleText = titleEl ? titleEl.textContent : "";
      const startTimeEl = rootCard?.querySelector("#vdStartTimeText");
      const endTimeEl = rootCard?.querySelector("#vdEndTimeText");

      try {
        const normalizedStatus = normalizeBillingStatusForPriceRuleEdit_(rootCard?.dataset?.billingStatus || visit?.billing_status || "");
        if (normalizedStatus === "paid") {
          toast({ title: "変更不可", message: "支払済みの予約は訪問基本料金を変更できません。" });
          return;
        }
        if (normalizedStatus === "billed") {
          const ok = await showModal({
            title: "確認",
            bodyHtml: `<p class="p">この予約は請求作成済みです。訪問基本料金を変更すると請求書側の再調整が必要です。続行しますか？</p>`,
            okText: "続行",
            cancelText: "キャンセル"
          });
          if (!ok) return;
        }

        const chosen = await pickVisitBasePriceRuleShared_(idToken2, prevRuleId, { selectId: "vdVisitBasePriceRuleSelect" });
        if (!chosen) return;
        const nextRuleId = String(chosen.price_rule_id || "").trim();
        if (!nextRuleId || nextRuleId === prevRuleId) return;

        if (rootCard) rootCard.dataset.priceRuleId = nextRuleId;
        actEl.textContent = String(chosen.label || nextRuleId);

        const up = await callUpdateVisitPolicy({
          origin: "portal",
          source: "portal",
          visit_id: vid,
          fields: { price_rule_id: nextRuleId },
        }, idToken2);

        const u = unwrapResults(up);
        if (u && u.success === false) throw new Error(u.error || u.message || "更新に失敗しました。");

        const uu = (u && u.updated && typeof u.updated === "object") ? u.updated : u;
        if (uu?.title && titleEl) titleEl.textContent = String(uu.title);
        if (uu?.start_time && startTimeEl) startTimeEl.textContent = displayOrDash(fmtDateTimeJst(uu.start_time || ""));
        if (uu?.end_time && endTimeEl) endTimeEl.textContent = displayOrDash(fmtDateTimeJst(uu.end_time || ""));
        visit = Object.assign({}, visit, {
          price_rule_id: nextRuleId,
          price_rule_label: String(chosen.label || nextRuleId),
          ...(uu?.title ? { title: uu.title } : {}),
          ...(uu?.start_time ? { start_time: uu.start_time } : {}),
          ...(uu?.end_time ? { end_time: uu.end_time } : {}),
          ...(uu?.duration_minutes != null ? { duration_minutes: uu.duration_minutes } : {})
        });
        actEl.textContent = productBadgeLabel_(visit);
        markVisitsListDirty_();
        toast({ title: "更新完了", message: "訪問基本料金を更新しました。" });
      } catch (err) {
        toast({ title: "更新失敗", message: err?.message || String(err || "") });
        if (rootCard) rootCard.dataset.priceRuleId = prevRuleId;
        actEl.textContent = prevText;
        if (titleEl) titleEl.textContent = prevTitleText;
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

      // 候補（API優先、失敗時fallback）
      let opt = null;
      try { opt = await ensureBillingStatusLabelMap_(idToken2); } catch (_) { opt = null; }
      const map = (opt && opt.map && typeof opt.map === "object") ? opt.map : { ...BILLING_STATUS_LABELS_FALLBACK_ };
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
        const up = await callUpdateVisitPolicy({
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

      const currentActive = (rootCard?.dataset?.isActive === "1");
      if (!currentActive) {
        toast({ title: "更新不可", message: "削除済みの予約は完了状態を変更できません。" });
        return;
      }
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
        const up = await callUpdateVisitPolicy({
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
          const up = await callUpdateVisitPolicy({
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

          const up = await callUpdateVisitPolicy({
            origin: "portal",
            source: "portal",
            visit_id: visitId,
            fields: { memo: nextMemo },
          }, idToken2);

          if (!up || up.success === false) {
            throw new Error((up && (up.error || up.message)) || "更新に失敗しました。");
          }

          blocker.setBusyText("最新情報を確認しています...");
          const re = await fetchVisitDetail_(visitId, idToken2, { include_customer_detail: true });

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
