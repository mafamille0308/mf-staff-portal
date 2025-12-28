// js/pages/visit_detail.js
import { render, toast, escapeHtml, showModal, fmt, displayOrDash, fmtDateTimeJst } from "../ui.js";
import { callGas, unwrapOne } from "../api.js";
import { getIdToken, setUser } from "../auth.js";
import { toggleVisitDone } from "./visit_done_toggle.js";

// function fmtDateTimeJst(v) {
//   const s = fmt(v).trim();
//   if (!s) return "";
//   const d = new Date(s);
//   if (isNaN(d.getTime())) return s; // パースできない場合は原文
//   try {
//     return new Intl.DateTimeFormat("ja-JP", {
//       timeZone: "Asia/Tokyo",
//       year: "numeric",
//       month: "2-digit",
//       day: "2-digit",
//       hour: "2-digit",
//       minute: "2-digit",
//       hour12: false,
//     }).format(d).replaceAll("-", "/");
//   } catch {
//     // Intl が使えない環境向けフォールバック（通常は不要）
//     const pad = (n) => String(n).padStart(2, "0");
//     return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
//   }
// }

// function displayOrDash(v) {
//   const s = fmt(v).trim();
//   return s ? s : "—";
// }

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
      visit_id: visitId,
      include_customer_detail: true,
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
  const customerDetail = res.customer_detail || res.customerDetail || null;

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
      <span class="badge badge-visit-type">
        ${escapeHtml(displayOrDash(fmt(visit.visit_type || ""), "訪問種別未設定"))}
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
    ${section("予約情報", visitHtml)}
    ${section("顧客・ペット・お世話情報", customerHtml)}
  `;

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

  const currentMemo = fmt(visit.memo || "");
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

      const v2 = re.visit || re.result || null;
      const freshMemo = fmt(v2 && v2.memo);

      if (memoText) memoText.textContent = freshMemo.trim() ? freshMemo : "—";
      // currentMemo の更新（キャンセル時の復元用）
      // ※ const を変えないため、入力欄も更新して edit を閉じる
      if (memoInput) memoInput.value = freshMemo;
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
