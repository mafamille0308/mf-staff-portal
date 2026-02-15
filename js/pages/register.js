// js/pages/register.js
import { render, qs, toast, escapeHtml, showModal } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { CONFIG } from "../config.js";
import { getIdToken, getUser } from "../auth.js";

let _fixedCustomerId = "";
let _fixedCustomerLabel = "";

function getFixedCustomerIdFromHash_() {
  const hash = String(location.hash || "");
  const q = hash.includes("?") ? hash.split("?")[1] : "";
  return String(new URLSearchParams(q).get("customer_id") || "").trim();
}

function getFixedCustomerLabelFromHash_() {
  const hash = String(location.hash || "");
  const q = hash.includes("?") ? hash.split("?")[1] : "";
  // 表示専用。無ければ空でOK
  return String(new URLSearchParams(q).get("customer_label") || "").trim();
}

const VISIT_TYPE_LABELS = {
  sitting: "シッティング",
  training: "トレーニング",
  meeting_free: "打ち合わせ（無料）",
  meeting_paid: "打ち合わせ（有料）",
};

// visit_type options（GAS取得 + フォールバック）
let _visitTypeOptionsCache = null; // [{ key, label }]

function fallbackVisitTypeOptions_() {
  return Object.keys(VISIT_TYPE_LABELS).map((k) => ({ key: k, label: VISIT_TYPE_LABELS[k] }));
}

async function ensureVisitTypeOptions_() {
  if (_visitTypeOptionsCache && _visitTypeOptionsCache.length) return _visitTypeOptionsCache;
  try {
    const idToken = getIdToken();
    if (!idToken) throw new Error("未ログインです。ログインし直してください。");
    const resp = await callGas({ action: "getVisitTypeOptions" }, idToken);
    const u = unwrapResults(resp);
    const results = (u && Array.isArray(u.results)) ? u.results : [];
    const list = results
      .map((x) => ({
        key: String(x.key || x.type || x.value || "").trim(),
        label: String(x.label || x.name || "").trim(),
      }))
      .filter((x) => !!x.key);
    _visitTypeOptionsCache = list.length ? list : fallbackVisitTypeOptions_();
  } catch (e) {
    _visitTypeOptionsCache = fallbackVisitTypeOptions_();
  }
  return _visitTypeOptionsCache;
}

function visitTypeSelectHtml_(currentKey) {
  const cur = String(currentKey || "").trim() || "sitting";
  const opts = (_visitTypeOptionsCache && _visitTypeOptionsCache.length) ? _visitTypeOptionsCache : fallbackVisitTypeOptions_();
  const has = opts.some((o) => String(o.key) === cur);
  const all = has ? opts : [{ key: cur, label: cur }, ...opts]; // 互換用：未知キーでも落とさない
  return all.map((o) => {
    const k = String(o.key);
    const sel = (k === cur) ? "selected" : "";
    return `<option value="${escapeHtml(k)}" ${sel}>${escapeHtml(o.label || k)}</option>`;
  }).join("");
}

function nowIsoJst_() {
  const d = new Date();
  // “表示用”でOK。厳密TZ変換は後回し！EVP優先！
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

function pad2_(n) {
  return String(n).padStart(2, "0");
}

function isYmd_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
}

/**
 * start_time/end_time の表示用（HH:mm）
 * - "09:00" のような時刻文字列はそのまま採用
 * - "2026-01-02T09:00:00+09:00" のようなISOは Date で解釈し HH:mm にする
 * - 変換不能なら空文字
 */
function fmtHm_(t) {
  const s = String(t || "").trim();
  if (!s) return "";
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    // "9:00" も "09:00" に寄せる
    const [h, m] = s.split(":");
    return `${pad2_(h)}:${m}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return `${pad2_(d.getHours())}:${pad2_(d.getMinutes())}`;
}

/**
 * "YYYY-MM-DD" + "HH:mm" -> "YYYY-MM-DDTHH:mm:00+09:00"
 * - draft JSON を ISO で統一するために使用
 */
function isoFromDateAndHmJst_(dateYmd, hm) {
  const date = String(dateYmd || "").trim();
  const t = fmtHm_(hm); // "09:00" に正規化
  if (!date || !t) return "";
  return `${date}T${t}:00+09:00`;
}

/**
 * コース選択肢（UI用）
 * - GAS側 CONFIG.COURSE_MINUTES があればそれを使って minutes 昇順に整列
 * - ない場合は最低限の固定候補を用意（30/60/90）
 * - 返すのは [{ key, minutes }] の配列
 */
let _courseOptionsCache = null; // [{ course, minutes }]

function fallbackCourseOptions_() {
  return [
    { course: "30min", minutes: 30 },
    { course: "60min", minutes: 60 },
    { course: "90min", minutes: 90 },
  ];
}

async function ensureCourseOptions_() {
  if (_courseOptionsCache && _courseOptionsCache.length) return _courseOptionsCache;
  try {
    const idToken = getIdToken();
    if (!idToken) throw new Error("未ログインです。ログインし直してください。");
    const resp = await callGas({ action: "getCourseOptions" }, idToken);
    const u = unwrapResults(resp);
    const results = (u && Array.isArray(u.results)) ? u.results : [];
    const list = results
      .map((x) => ({ course: String(x.course || "").trim(), minutes: Number(x.minutes) || 0 }))
      .filter((x) => !!x.course);
    _courseOptionsCache = list.length ? list : fallbackCourseOptions_();
  } catch (e) {
    // 取得失敗時もUIは動かす（登録導線停止を避ける）
    _courseOptionsCache = fallbackCourseOptions_();
  }
  return _courseOptionsCache;
}

function courseSelectHtml_(currentCourse) {
  const cur = String(currentCourse || "").trim() || "30min";
  const opts = (_courseOptionsCache && _courseOptionsCache.length) ? _courseOptionsCache : fallbackCourseOptions_();
  const has = opts.some((o) => String(o.course) === cur);
  const all = has ? opts : [{ course: cur, minutes: 0 }, ...opts]; // 互換用
  return all.map((o) => {
    const k = String(o.course);
    const sel = (k === cur) ? "selected" : "";
    return `<option value="${escapeHtml(k)}" ${sel}>${escapeHtml(k)}</option>`;
  }).join("");
}

/**
 * course から minutes を推定（UI表示用）
 * - "30min" / "60min" / "90min" のような形式は数値抽出
 * - "30" のような数値文字列も許可
 * - CONFIG.COURSE_MINUTES があればそれを優先
 * - それ以外は 30 にフォールバック
 *
 * ※SaaS化で course が汎用キーになっても、CONFIG.COURSE_MINUTES 経由で表示可能。
 */
function minutesFromCourse_(course) {
  const c = String(course || "").trim();
  // CONFIG 側の定義があれば最優先
  try {
    const map = CONFIG && CONFIG.COURSE_MINUTES ? CONFIG.COURSE_MINUTES : null;
    if (map && c && map[c] != null) {
      const n = Number(map[c]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (e) {}

  if (!c) return 30;
  // "30min" / "30 min" / "30mins" のような表現
  const m1 = c.match(/^(\d+)\s*min/i);
  if (m1) {
    const n = Number(m1[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // "30" のような数値
  const m2 = c.match(/^(\d+)$/);
  if (m2) {
    const n = Number(m2[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30;
}

/**
 * "HH:mm" の start_time と course から end_time(HH:mm) を算出（UI表示用）
 * - 変換できない場合は空文字
 * - slot_minutes 等の丸めは UIではやらない（GASが最終確定）
 */
function calcEndHmFromStartAndCourse_(startTime, course) {
  const st = fmtHm_(startTime);
  if (!st) return "";
  const [h, m] = st.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const mins = minutesFromCourse_(course);
  const total = h * 60 + m + mins;
  const eh = Math.floor((total % (24 * 60)) / 60);
  const em = total % 60;
  return `${pad2_(eh)}:${pad2_(em)}`;
}

function renderCommitSummary_(u) {
  // 可能な範囲で人間向けに要点だけ表示（詳細はJSONを参照）
  if (!u) return "";

  const results = Array.isArray(u.results) ? u.results : [];
  if (!results.length) return "";

  const items = results
    .filter(r => r && (r.status === "failed" || r.status === "skipped"))
    .map(r => {
      const code = escapeHtml(r.code || r.status || "");
      const row = (r.row != null) ? `#${escapeHtml(String(r.row))}` : "";
      const reason = escapeHtml(r.reason || "");
      return `<li style="margin:4px 0;"><b>${code}</b> ${row} ${reason}</li>`;
    })
    .join("");

  if (!items) return "";

  return `
    <div class="card card-warning" style="margin-bottom:12px;">
      <p class="p text-danger"><b>登録できなかった行があります</b></p>
      <ul style="margin:6px 0 0 18px; padding:0;">${items}</ul>
    </div>
  `;
}

/**
 * bulkRegisterVisits の結果を UI 用に要約
 * - “完了” 表示にするのは「全件成功」のときだけ
 * - failed / skipped が1件でもあれば「一部未完了」
 * - 成功0件かつ失敗/スキップがあるなら「失敗」
 */
function summarizeCommit_(u) {
  const stats = (u && u.stats) ? u.stats : {};
  const s = Number(stats.success || 0);
  const f = Number(stats.failed || 0);
  const k = Number(stats.skipped || 0);
  const total = s + f + k;

  // フォールバック：stats が無い場合は results から推定
  if (!total) {
    const rs = Array.isArray(u && u.results) ? u.results : [];
    let ss = 0, ff = 0, kk = 0;
    rs.forEach(r => {
      const st = String(r && r.status || "");
      if (st === "success") ss++;
      else if (st === "failed") ff++;
      else if (st === "skipped") kk++;
    });
    const tt = ss + ff + kk;
    return { success: ss, failed: ff, skipped: kk, total: tt, allSuccess: (tt > 0 && ff === 0 && kk === 0), hasAnyFailure: (ff > 0 || kk > 0) };
  }

  return { success: s, failed: f, skipped: k, total, allSuccess: (total > 0 && f === 0 && k === 0), hasAnyFailure: (f > 0 || k > 0) };
}

function commitTitleAndToast_(sum) {
  // sum.total が 0 のケースは異常系として “結果要確認”
  if (!sum || !sum.total) {
    return { title: "結果要確認", toastTitle: "結果要確認", toastMsg: "登録結果を確認してください（件数が取得できません）。" };
  }
  if (sum.allSuccess) {
    return { title: "完了", toastTitle: "完了", toastMsg: `登録が完了しました（${sum.success}件）。` };
  }
  if (sum.success > 0 && sum.hasAnyFailure) {
    return { title: "一部未完了", toastTitle: "一部未完了", toastMsg: `登録は一部完了です（成功${sum.success} / 失敗${sum.failed} / スキップ${sum.skipped}）。` };
  }
  // 成功0で失敗/スキップがある場合
  return { title: "失敗", toastTitle: "失敗", toastMsg: `登録できませんでした（失敗${sum.failed} / スキップ${sum.skipped}）。` };
}

async function sha256Hex_(text) {
  // Web Crypto API：https環境 / GitHub PagesでOK
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  const bytes = Array.from(new Uint8Array(buf));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newRequestId_() {
  // GAS側 RequestLogs / 冪等設計に乗せる（再送も同一request_idを使う）
  const rid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  return `portal_register_${rid}`;
}

function fmtVisitType_(type) {
  const k = String(type || "").trim();
  // 取得済みoptionsがあればそれを優先
  try {
    const opts = (_visitTypeOptionsCache && _visitTypeOptionsCache.length) ? _visitTypeOptionsCache : null;
    if (opts) {
      const hit = opts.find((o) => String(o.key) === k);
      if (hit && hit.label) return hit.label;
    }
  } catch (e) {}
  return VISIT_TYPE_LABELS[k] || k;
}

export function renderRegisterTab(app) {
  render(app, `
    <section class="section">
      <h1 class="h1">予約登録</h1>

      <!-- 予約候補の一括生成（AIなし） -->
      <div class="card" style="margin-bottom:20px;">
        <p class="p" style="margin:0 0 12px 0;"><b>予約候補の一括生成</b></p>

        <div class="hint-row" style="margin-bottom:10px;">
          <label class="hint-label" style="min-width:140px;">顧客名</label>
          <div style="display:flex; align-items:center; flex-wrap:wrap;">
            <span id="reg_customer_label" class="p" style="margin:0;"></span>
          </div>
        </div>

       <div class="hint-row" style="margin-bottom:10px;">
          <label class="hint-label" style="min-width:140px;">期間</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <input id="reg_from" type="date" class="input mono" style="width: 160px;" />
            <span style="color:#666;">〜</span>
            <input id="reg_to" type="date" class="input mono" style="width: 160px;" />
          </div>
        </div>

        <div class="hint-row" style="margin-bottom:10px;">
          <label class="hint-label" style="min-width:140px;">間隔</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <select id="reg_every_n" class="input" style="width: 160px;">
              <option value="1">毎日</option>
              <option value="2">隔日</option>
              <option value="3">2日おき</option>
            </select>
          </div>
        </div>

        <div class="hint-row" style="margin-bottom:10px;">
          <label class="hint-label" style="min-width:140px;">時刻スロット</label>
          <div style="display:flex; flex-direction:column; gap:8px; width:100%;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <input id="reg_time_add" type="time" class="input mono" style="width:160px;" />
              <button id="reg_time_add_btn" class="btn btn-sm" type="button" style="min-width:auto;">＋追加</button>
            </div>
            <div id="reg_times_chips" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
            <!-- 互換用（ロジックの最低差分のため残す・非表示） -->
            <textarea id="reg_times" class="textarea mono is-hidden" rows="2" aria-hidden="true"></textarea>
          </div>
        </div>

        <div id="reg_edge_once_row" class="hint-row is-hidden" style="margin-bottom:10px;">
          <label class="hint-label" style="min-width:140px;">便利設定</label>
          <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
            <label style="display:flex; align-items:center; gap:6px;">
              <input id="reg_first_day_once" type="checkbox" />
              <span>初日だけ1回</span>
            </label>
            <label style="display:flex; align-items:center; gap:6px;">
              <input id="reg_last_day_once" type="checkbox" />
              <span>最終日だけ1回</span>
            </label>
          </div>
        </div>

        <div class="hint-row" style="margin-bottom:10px;">
          <label class="hint-label" style="min-width:140px;">共通設定</label>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <select id="reg_common_course" class="input" style="width: 160px;"></select>
            <select id="reg_common_type" class="input" style="width: 160px;"></select>
          </div>
        </div>

        <div class="hint-row" style="margin-bottom:0;">
          <label class="hint-label" style="min-width:140px;">共通メモ</label>
          <textarea id="reg_common_memo" class="textarea" rows="2" placeholder="すべての予約メモに一括で書き込みます。各予約に個別でメモを書き込む場合、予約候補を生成後に個別に入力できます。"></textarea>
        </div>

        <details style="margin-top:14px;">
          <summary style="cursor:pointer; font-weight:600; color:#666; padding:8px 0;">
            除外日
          </summary>
          <div style="margin-top:10px;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
              <input id="reg_exclude_add" type="date" class="input mono" style="width: 160px;" />
              <button id="reg_exclude_add_btn" class="btn btn-sm" type="button" style="min-width:auto;">＋追加</button>
            </div>
            <div id="reg_exclude_chips" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px;"></div>
          </div>
        </details>
      </div>

      <!-- 登録先スタッフ（管理者のみ） -->
      <div id="reg_assign" class="card is-hidden" style="margin-bottom:20px;">
        <p class="p" style="margin-bottom:12px;"><b>登録先スタッフの指定（管理者のみ）</b></p>
        <div class="hint-row" style="margin-bottom:8px;">
          <label class="hint-label" style="min-width:140px;">スタッフ名</label>
          <input id="reg_assign_staff_name" class="input" placeholder="未入力の場合は顧客の主担当に登録" />
        </div>
        <p class="p text-sm text-muted" style="margin:0;">
          ※ 担当関係（CustomerStaffs）がない場合は登録できません
        </p>
      </div>

      <!-- 登録先サマリー -->
      <div id="reg_assign_summary" class="card" style="margin-bottom:20px;">
        <p class="p" style="margin:0;"><b>登録先：</b><span id="reg_assign_summary_text">（未ログイン）</span></p>
      </div>

      <!-- AI解釈ボタン -->
      <div style="margin-bottom:24px;">
        <button id="reg_interpret" class="btn" style="width:100%;">
          🔍 予約候補を生成
        </button>
      </div>

      <!-- 警告エリア -->
      <div id="reg_warnings" class="is-hidden" style="margin-bottom:20px;"></div>

      <!-- プレビュー/編集エリア -->
      <div id="reg_preview" class="is-hidden" style="margin-bottom:20px;"></div>

      <!-- 登録実行ボタン -->
      <div style="margin-bottom:24px;">
        <button id="reg_commit" class="btn btn-primary" disabled style="width:100%;">
          ✅ 登録実行
        </button>
      </div>

      <!-- 実行結果 -->
      <div id="reg_result" class="p"></div>
    </section>

    <!-- ローディングオーバーレイ -->
    <div id="reg_overlay" class="overlay is-hidden" aria-hidden="true">
      <div class="overlay-inner">
        <div class="spinner"></div>
        <div id="reg_overlay_text" class="overlay-text">処理中...</div>
      </div>
    </div>
  `);

  const fromEl = qs("#reg_from");
  const toEl = qs("#reg_to");
  const everyNEl = qs("#reg_every_n");
  const timesEl = qs("#reg_times");
  const timeAddEl = qs("#reg_time_add");
  const timeAddBtn = qs("#reg_time_add_btn");
  const timesChipsEl = qs("#reg_times_chips");
  const edgeOnceRowEl = qs("#reg_edge_once_row");
  const firstDayOnceEl = qs("#reg_first_day_once");
  const lastDayOnceEl = qs("#reg_last_day_once");
  const commonCourseEl = qs("#reg_common_course");
  const commonTypeEl = qs("#reg_common_type");
  const commonMemoEl = qs("#reg_common_memo");
  const customerLabelEl = qs("#reg_customer_label");
  const excludeAddEl = qs("#reg_exclude_add");
  const excludeAddBtn = qs("#reg_exclude_add_btn");
  const excludeChipsEl = qs("#reg_exclude_chips");  
  const assignWrapEl = qs("#reg_assign");
  const assignStaffNameEl = qs("#reg_assign_staff_name");
  const assignSummaryTextEl = qs("#reg_assign_summary_text");
  const interpretBtn = qs("#reg_interpret");
  const commitBtn = qs("#reg_commit");
  const resultEl = qs("#reg_result");
  const warningsEl = qs("#reg_warnings");
  const previewEl = qs("#reg_preview");
  const overlayEl = qs("#reg_overlay");
  const overlayTextEl = qs("#reg_overlay_text");

  let _busy = false;
  let _draftObj = null; // { visits:[], warnings:[] }

  let _timeSlots = [];      // ["09:00", "17:00"]
  let _excludeDates = [];   // ["2026-02-20", ...]

  _fixedCustomerId = getFixedCustomerIdFromHash_();
  _fixedCustomerLabel = getFixedCustomerLabelFromHash_();

  if (!_fixedCustomerId) {
    toast({ message: "customer_id がありません。顧客詳細から予約登録を開いてください。" });
    return;
  }

  // 対象（顧客名）表示：label が無ければ customer_id を表示
  if (customerLabelEl) {
    const label = String(_fixedCustomerLabel || "").trim();
    const cid = String(_fixedCustomerId || "").trim();
    customerLabelEl.textContent = label ? label : cid;
  }

  try { refreshUI_(); } catch (e) {}

  let _hardErrors = [];
  let _lastCommitSucceeded = false;
  let _lastCommitHash = "";
  let _lastCommitRequestId = "";
  let _memoDebounceTimer = null;

  function populateCommonCourseOptions_() {
    if (!commonCourseEl) return;
    // courseOptions のキャッシュを使って select を構築
    const cur = String(commonCourseEl.value || "30min").trim() || "30min";
    commonCourseEl.innerHTML = courseSelectHtml_(cur);
  }

  function populateCommonTypeOptions_() {
    if (!commonTypeEl) return;
    const cur = String(commonTypeEl.value || "sitting").trim() || "sitting";
    commonTypeEl.innerHTML = visitTypeSelectHtml_(cur);
  }

  ensureCourseOptions_().then(() => { try { populateCommonCourseOptions_(); refreshUI_(); } catch (e) {} });
  ensureVisitTypeOptions_().then(() => { try { populateCommonTypeOptions_(); refreshUI_(); } catch (e) {} });
  try { populateCommonCourseOptions_(); } catch (e) {}
  try { populateCommonTypeOptions_(); } catch (e) {}

  updateAssignUi_();
  window.addEventListener("mf:auth:changed", updateAssignUi_);
  if (assignStaffNameEl) assignStaffNameEl.addEventListener("input", updateAssignUi_);

  function updateAssignUi_() {
    const user = getUser() || {};
    const role = String(user.role || "").toLowerCase();
    const me = (user.name || user.staff_id || "自分");
    const isAdmin = role === "admin";

    if (assignWrapEl) {
      if (isAdmin) assignWrapEl.classList.remove("is-hidden");
      else assignWrapEl.classList.add("is-hidden");
    }

    const selectedName = (assignStaffNameEl && String(assignStaffNameEl.value || "").trim()) || "";
    let label = "";
    if (!role) label = "（未ログイン）";
    else if (isAdmin) label = selectedName ? `${selectedName} に登録（担当関係がある場合のみ）` : "顧客の主担当に登録（GASで決定）";
    else label = `自分に登録（${me}）`;
    if (assignSummaryTextEl) assignSummaryTextEl.textContent = label;
  }

  function setBusy(b, overlayText = "") {
    _busy = b;
    interpretBtn.disabled = b;
    if (commitBtn) {
      // commit の有効/無効は refreshUI_() が責務を持つ（顧客確定/重複エラー等）
      // busy の間だけ強制的に無効化し、解除後は refreshUI_() に戻す
      if (b) commitBtn.disabled = true;
    }
    if (overlayEl) {
      overlayEl.classList.toggle("is-hidden", !b);
      overlayEl.setAttribute("aria-hidden", b ? "false" : "true");
    }
    if (overlayTextEl && overlayText) {
      overlayTextEl.textContent = overlayText;
    } else if (overlayTextEl && !overlayText) {
      overlayTextEl.textContent = "処理中...";
    }
    if (!b) { try { refreshUI_(); } catch (e) {} }
  }

  function renderWarnings_(warnings = []) {
    if (!warningsEl) return;
    if (!warnings || !warnings.length) {
      warningsEl.classList.add("is-hidden");
      warningsEl.innerHTML = "";
      return;
    }
    const html = warnings.map((w) => {
      const rows = Array.isArray(w.row_nums) && w.row_nums.length ? `行: ${escapeHtml(w.row_nums.join(", "))}` : "";
      return `
        <div class="card card-warning">
          <p class="p text-danger"><b>${escapeHtml(w.code || "warning")}</b></p>
          <p class="p">${escapeHtml(w.message || "")}</p>
          ${rows ? `<p class="p text-sm text-muted">${rows}</p>` : ""}
        </div>
      `;
    }).join("");
    warningsEl.innerHTML = `<div class="card"><p class="p text-danger"><b>注意</b>（GAS登録前に確認してください）</p>${html}</div>`;
    warningsEl.classList.remove("is-hidden");
  }

  function sortAndRenumberDraft_() {
    if (!_draftObj || !Array.isArray(_draftObj.visits)) return;
    const visits = _draftObj.visits;
    visits.sort((a, b) => {
      const ad = String(a.date || "");
      const bd = String(b.date || "");
      if (ad !== bd) return ad < bd ? -1 : 1;
      const as = fmtHm_(a.start_time);
      const bs = fmtHm_(b.start_time);
      if (as !== bs) return as < bs ? -1 : 1;
      return 0;
    });
    visits.forEach((v, i) => { v.row_num = i + 1; });
  }

  function syncTimeTextarea_() {
    if (!timesEl) return;
    timesEl.value = _timeSlots.join("\n");
  }

  function isValidYmd_(s) {
    const v = String(s || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v);
  }

  function diffDaysJst_(fromYmd, toYmd) {
    // JST(+09:00) 固定で “日” 差を計算
    if (!isValidYmd_(fromYmd) || !isValidYmd_(toYmd)) return 0;
    const a = new Date(`${fromYmd}T00:00:00+09:00`);
    const b = new Date(`${toYmd}T00:00:00+09:00`);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
    const ms = b.getTime() - a.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }

  function refreshEdgeOnceVisibility_() {
    if (!edgeOnceRowEl) return;
    const fromYmd = String(fromEl?.value || "").trim();
    const toYmd = String(toEl?.value || "").trim();

    // 条件：
    // - 期間が2日以上（差分が1日以上）
    // - 時刻スロットが2つ以上
    const daysDiff = diffDaysJst_(fromYmd, toYmd);
    const hasRange2plus = (daysDiff >= 1); // 例: 2/01〜2/02 で 1
    const hasTwoSlots = Array.isArray(_timeSlots) && _timeSlots.length >= 2;
    const shouldShow = !!(hasRange2plus && hasTwoSlots);

    edgeOnceRowEl.classList.toggle("is-hidden", !shouldShow);
    if (!shouldShow) {
      // 非表示になったら安全のため OFF（生成ロジックへの影響を確実に遮断）
      if (firstDayOnceEl) firstDayOnceEl.checked = false;
      if (lastDayOnceEl) lastDayOnceEl.checked = false;
    }
  }

  function computeHardErrors_(draft) {
    const errors = [];
    const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
    const seen = new Map(); // key -> [idx]
    visits.forEach((v, idx) => {
      const date = String(v.date || "").trim();
      const stRaw = String(v.start_time || "").trim();
      const st = fmtHm_(stRaw);
      if (!date || !st) return;
      const key = `${date}__${st}`;
      const arr = seen.get(key) || [];
      arr.push(idx);
      seen.set(key, arr);
    });
    for (const [key, idxs] of seen.entries()) {
      if (idxs.length <= 1) continue;
      const [date, st] = key.split("__");
      errors.push({ code: "DUPLICATE_START_TIME", message: `同一日付・同一開始時刻が重複しています：${date} ${st}`, idxs });
    }
    return errors;
  }

  function fmtWarnBadge_(label) {
    return `<span class="badge badge-warn">⚠ ${escapeHtml(label)}</span>`;
  }

  function renderTimeChips_() {
    if (!timesChipsEl) return;
    const uniq = [];
    const seen = new Set();
    _timeSlots.map(t => fmtHm_(t)).filter(Boolean).forEach(t => {
      if (seen.has(t)) return;
      seen.add(t);
      uniq.push(t);
    });
   _timeSlots = uniq;
   syncTimeTextarea_();
   refreshEdgeOnceVisibility_();
   const html = _timeSlots.map((t) => {
      return `
        <button type="button" class="btn btn-sm" data-chip="time" data-value="${escapeHtml(t)}"
          style="min-width:auto; padding:6px 10px; border-radius:999px;">
          ${escapeHtml(t)} <span style="margin-left:6px; opacity:.7;">×</span>
        </button>
      `;
    }).join("");
    timesChipsEl.innerHTML = html || `<span class="text-sm text-muted">時刻を選択・追加してください（複数追加可）</span>`;
  }

  function renderExcludeChips_() {
    if (!excludeChipsEl) return;
    const uniq = Array.from(new Set(_excludeDates)).filter(isYmd_).sort();
    _excludeDates = uniq;
    const html = uniq.map((d) => {
      return `
        <button type="button" class="btn btn-sm" data-chip="exclude" data-value="${escapeHtml(d)}"
          style="min-width:auto; padding:6px 10px; border-radius:999px;">
          ${escapeHtml(d)} <span style="margin-left:6px; opacity:.7;">×</span>
        </button>
      `;
    }).join("");
    excludeChipsEl.innerHTML = html || `<span class="text-sm text-muted">除外日を選択・追加してください（複数追加可）</span>`;
  }

  // chips クリックで削除
  if (timesChipsEl) {
    timesChipsEl.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-chip="time"]') : null;
      if (!btn) return;
      const v = String(btn.getAttribute("data-value") || "");
      _timeSlots = _timeSlots.filter(t => fmtHm_(t) !== fmtHm_(v));
      renderTimeChips_();
    });
  }
  if (excludeChipsEl) {
    excludeChipsEl.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-chip="exclude"]') : null;
      if (!btn) return;
      const v = String(btn.getAttribute("data-value") || "");
      _excludeDates = _excludeDates.filter(d => String(d) !== v);
      renderExcludeChips_();
    });
  }

  if (timeAddBtn) {
    timeAddBtn.addEventListener("click", () => {
      const t = fmtHm_(timeAddEl?.value);
      if (!t) return toast({ message: "時刻を選択してください（例: 09:00）" });
      _timeSlots.push(t);
      renderTimeChips_();
    });
  }
  if (excludeAddBtn) {
    excludeAddBtn.addEventListener("click", () => {
      const d = String(excludeAddEl?.value || "").trim();
      if (!isYmd_(d)) return toast({ message: "除外日を選択してください" });
      _excludeDates.push(d);
      renderExcludeChips_();
    });
  }

  if (fromEl) {
    fromEl.addEventListener("change", refreshEdgeOnceVisibility_);
    fromEl.addEventListener("input", refreshEdgeOnceVisibility_);
  }
  if (toEl) {
    toEl.addEventListener("change", refreshEdgeOnceVisibility_);
    toEl.addEventListener("input", refreshEdgeOnceVisibility_);
  }

  function renderEditor_(draft) {
    if (!previewEl) return;
    const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
    if (!visits.length) {
      previewEl.classList.add("is-hidden");
      previewEl.innerHTML = "";
      return;
    }

    const cards = visits.map((v, idx) => {
      const rowNum = v.row_num != null ? String(v.row_num) : String(idx + 1);
      const date = String(v.date || "").trim();
      const st = fmtHm_(v.start_time); // HH:mm形式に変換
      const course = String(v.course || "").trim();
      const vt = String(v.visit_type || "sitting").trim();
      const memo = String(v.memo || "");
      const timeHint = String(v.time_hint || "unspecified").trim();
      const endHm = calcEndHmFromStartAndCourse_(st || "09:00", course || "30min");

      const warnBadges = [
        (timeHint === "unspecified") ? fmtWarnBadge_("時間は仮設定") : "",
        (!course) ? fmtWarnBadge_("コース仮設定") : "",
      ].filter(Boolean).join(" ");

      const typeOptions = visitTypeSelectHtml_(vt);

      return `
        <div class="preview-card" data-idx="${idx}" style="padding:12px; margin-bottom:12px; border:1px solid #ddd; border-radius:8px;">
          <!-- ヘッダー部分：スマホで縦並び -->
          <div style="margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #eee;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px;">
              <div style="font-size:15px; font-weight:600; flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:45vw;">
                    📅 #${escapeHtml(rowNum)}
                  </div>
                  <input type="date"
                    inputmode="numeric"
                    class="input mono"
                    data-field="date"
                    value="${escapeHtml(date || "")}"
                    style="width: 160px; max-width: 60vw; font-size:14px;"
                  />
                </div>
              </div>
              <div style="display:flex; gap:6px; flex-shrink:0;">
                <button class="btn btn-sm" type="button" data-action="dup" title="複製" style="padding:4px 8px; min-width:auto;">📋</button>
                <button class="btn btn-sm" type="button" data-action="del" title="削除" style="padding:4px 8px; min-width:auto; color:#d32f2f;">🗑️</button>
              </div>
            </div>
            ${warnBadges ? `<div style="margin-top:6px;">${warnBadges}</div>` : ""}
          </div>

          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px; margin-bottom:10px;">
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">⏰ 開始</label>
              <input type="time" class="input mono" data-field="start_time" value="${escapeHtml(st || "09:00")}" style="font-size:14px;" />
            </div>
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">⏱️ 終了</label>
              <input class="input mono" value="${escapeHtml(endHm)}" disabled style="font-size:14px;" />
            </div>
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">📦 コース</label>
              <select class="input" data-field="course" style="font-size:14px;">
                ${courseSelectHtml_(course || "30min")}
              </select>
            </div>
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">🏷️ タイプ</label>
              <select class="input" data-field="visit_type" style="font-size:14px;">${typeOptions}</select>
            </div>
          </div>

          <div>
            <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">📝 メモ</label>
            <textarea class="textarea" rows="2" data-field="memo" placeholder="この訪問に関するメモ（任意）" style="font-size:14px;">${escapeHtml(memo)}</textarea>
          </div>
        </div>
      `;
    }).join("");

    previewEl.innerHTML = `
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:16px;">
          <h2 style="font-size:16px; font-weight:600; margin:0 0 4px 0;">登録候補（${visits.length}件）</h2>
          <p class="p text-sm text-muted" style="margin:0;">
            <b>顧客：</b>${escapeHtml(_fixedCustomerLabel || _fixedCustomerId || "（不明）")}
          </p>
        </div>
        <div class="preview-wrap">${cards}</div>
      </div>
    `;
    previewEl.classList.remove("is-hidden");
  }

  function refreshUI_() {
    try { sortAndRenumberDraft_(); } catch (e) {}
    _hardErrors = computeHardErrors_(_draftObj);

    let warnings = (_draftObj && Array.isArray(_draftObj.warnings)) ? _draftObj.warnings : [];
    warnings = warnings.filter(w => String(w && w.code || "") !== "missing_customer_name");
    const hardAsWarnings = _hardErrors.map(e => ({ code: e.code, message: e.message, row_nums: [] }));
    renderWarnings_([ ...warnings, ...hardAsWarnings ]);

    renderEditor_(_draftObj);

    const hasDraft = !!(_draftObj && Array.isArray(_draftObj.visits) && _draftObj.visits.length);
    const hasHardError = !!(_hardErrors && _hardErrors.length);
    commitBtn.disabled = _busy || !hasDraft || hasHardError;
  }

  if (previewEl) {
    previewEl.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-action]") : null;
      if (!btn) return;
      if (!_draftObj) return;
      const wrap = btn.closest("[data-idx]");
      const idx = wrap ? Number(wrap.getAttribute("data-idx") || "0") : -1;
      if (idx < 0) return;

      const action = btn.getAttribute("data-action");
      const visits = Array.isArray(_draftObj.visits) ? _draftObj.visits : [];

      if (action === "del") {
        visits.splice(idx, 1);
        sortAndRenumberDraft_();
        refreshUI_();
        return;
      }
      if (action === "dup") {
        const src = visits[idx];
        if (!src) return;
        const copy = { ...src };
        visits.splice(idx + 1, 0, copy);
        sortAndRenumberDraft_();
        refreshUI_();
        return;
      }
    });

    previewEl.addEventListener("input", (ev) => {
      const el = ev.target;
      if (!el || !_draftObj) return;
      const field = el.getAttribute("data-field");
      if (!field) return;
      const wrap = el.closest("[data-idx]");
      const idx = wrap ? Number(wrap.getAttribute("data-idx") || "0") : -1;
      if (idx < 0) return;
      const visits = Array.isArray(_draftObj.visits) ? _draftObj.visits : [];
      const v = visits[idx];
      if (!v) return;

      if (field === "date") {
        // date変更時は start_time の日付部分も必ず追従させる
        const ymd = String(el.value || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
          toast({ message: "日付の形式が不正です。再入力してください。" });
          return;
        }
        v.date = ymd;

        // start_time があれば HH:mm を保持して ISO を再生成
        const hm = fmtHm_(v.start_time) || "09:00";
        const iso = isoFromDateAndHmJst_(ymd, hm);
        if (!iso) {
          toast({ message: "開始時刻の再計算に失敗しました。" });
          return;
        }
        v.start_time = iso;
        v.time_hint = "fixed";
        sortAndRenumberDraft_();

      } else if (field === "start_time") {
        // time入力は "HH:mm" なので、draft(JSON)はISO(+09:00)に戻して統一する
        const iso = isoFromDateAndHmJst_(v.date, el.value);
        if (!iso) {
          toast({ message: "開始時刻の形式が不正です。再入力してください。" });
          return;
        }
        v.start_time = iso;
        v.time_hint = "fixed";
        sortAndRenumberDraft_();
      } else if (field === "course") {
        v.course = String(el.value || "").trim();
      } else if (field === "visit_type") {
        v.visit_type = String(el.value || "").trim();
      } else if (field === "memo") {
        // メモは即座にデータに反映するが、UI更新はデバウンス
        v.memo = String(el.value || "");

        if (_memoDebounceTimer) {
          clearTimeout(_memoDebounceTimer);
        }
        _memoDebounceTimer = setTimeout(() => {
          if (typeof syncDraftTextarea_ === "function") syncDraftTextarea_();
        }, 300);

        return; // UI全体の再描画は不要（入力モード維持のため）
      }
      // end_time は UI編集不可・payload送信不可：万一残っていてもここで破棄
      try { delete v.end_time; } catch (e) {}
      refreshUI_();
    });
  }

  function parseExcludeDateSet_() {
    // チップUI
    const set = new Set();
    (_excludeDates || []).forEach(d => { if (isYmd_(d)) set.add(String(d)); });
    return set;
  }

  function parseTimeSlots_() {
    // チップUI（優先） + textarea（互換）
    const list = [];
    (_timeSlots || []).forEach(t => { const hm = fmtHm_(t); if (hm) list.push(hm); });
    const raw = String(timesEl?.value || "");
    raw.split(/[\s,、]+/).forEach(s => { const hm = fmtHm_(s); if (hm) list.push(hm); });
    // 重複排除（入力順を維持）
    const out = [];
    const seen = new Set();
    list.forEach((t) => { if (!seen.has(t)) { seen.add(t); out.push(t); } });
    return out;
  }

  function normalizeDateInput_(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  }

  function ymdToDateJst_(ymd) {
    // input[type=date] はローカルTZで解釈されるが、念のため +09:00 固定で生成
   return new Date(`${ymd}T00:00:00+09:00`);
  }

  function toYmd_(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function generateDraftFromUi_() {
    const fromYmd = normalizeDateInput_(fromEl?.value) || toYmd_(new Date());
    const toYmd = normalizeDateInput_(toEl?.value) || fromYmd;
    const fromD = ymdToDateJst_(fromYmd);
    const toD = ymdToDateJst_(toYmd);
    if (isNaN(fromD.getTime()) || isNaN(toD.getTime())) throw new Error('期間の日付が不正です');
    if (fromD.getTime() > toD.getTime()) throw new Error('期間の from/to が逆です');

    const everyN = Math.max(1, Number(everyNEl?.value || 1) || 1);
    const excludeSet = parseExcludeDateSet_();
    const times = parseTimeSlots_();
    if (!times.length) throw new Error('時刻スロットを1つ以上入力してください（例: 09:00）');
    const firstDayOnce = !!(firstDayOnceEl && firstDayOnceEl.checked);
    const lastDayOnce  = !!(lastDayOnceEl && lastDayOnceEl.checked);

    const course = String(commonCourseEl?.value || '30min').trim() || '30min';
    const visitType = String(commonTypeEl?.value || 'sitting').trim() || 'sitting';
    const memo = String(commonMemoEl?.value || '');

    const visits = [];
    let rowNum = 1;
    const firstYmd = fromYmd;
    const lastYmd = toYmd;
    for (let d = new Date(fromD); d.getTime() <= toD.getTime(); d.setDate(d.getDate() + everyN)) {
      const ymd = toYmd_(d);
      if (excludeSet.has(ymd)) continue;
      let slotList = times;
      // 初日だけ1回：初日は「最後の時刻のみ」
      if (firstDayOnce && times.length >= 2 && ymd === firstYmd) {
        slotList = [times[times.length - 1]];
      }
      // 最終日だけ1回：最終日は「最初の時刻のみ」
      if (lastDayOnce && times.length >= 2 && ymd === lastYmd) {
        slotList = [times[0]];
      }

      slotList.forEach((hm) => {
        const iso = isoFromDateAndHmJst_(ymd, hm);
        if (!iso) return;
        visits.push({
          row_num: rowNum++,
          customer_id: String(_fixedCustomerId || '').trim(),
          date: ymd,
          start_time: iso,
          course: course,
          visit_type: visitType,
          memo: memo,
          time_hint: 'fixed'
        });
      });
    }

    // 同日・同開始時刻の重複は生成段階で潰す（commit前ハードエラーも維持）
    const keySet = new Set();
    const uniq = [];
    visits.forEach(v => {
      const k = `${v.date}__${v.start_time}`;
      if (keySet.has(k)) return;
      keySet.add(k);
      uniq.push(v);
    });
    return { visits: uniq, warnings: [] };
  }

  try { renderTimeChips_(); } catch (e) {}
  try { renderExcludeChips_(); } catch (e) {}
  try { syncTimeTextarea_(); } catch (e) {}
  try { refreshEdgeOnceVisibility_(); } catch (e) {}

  if (interpretBtn) interpretBtn.addEventListener("click", async () => {
    console.log("[register] generate button clicked");
    if (_busy) return;
    try {
      setBusy(true, "候補を生成しています...");
      resultEl.innerHTML = "";
      renderWarnings_([]);

      const draft = generateDraftFromUi_();
      const visits = Array.isArray(draft && draft.visits) ? draft.visits : [];
      if (!visits.length) {
        toast({ message: "条件に一致する候補が0件です（期間/曜日/除外日を確認してください）" });
        _draftObj = null;
        refreshUI_();
        return;
      }

      _draftObj = draft;
      // 登録事故防止：customer_id は固定注入
      visits.forEach(v => { v.customer_id = _fixedCustomerId; });
      sortAndRenumberDraft_();
      refreshUI_();
      resultEl.innerHTML = `<div class="card"><p class="p">登録候補を生成しました。顧客を選択し、内容を確認して「登録実行」を押してください。</p></div>`;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      toast({ message: msg });
    } finally {
      setBusy(false);
    }
  });

  if (commitBtn) commitBtn.addEventListener("click", async () => {
    const customerId = String(_fixedCustomerId || "").trim();
    if (!customerId) return toast({ message: "customer_id がありません。顧客詳細から予約登録を開いてください。" });
    if (_busy) return;
    const draft = _draftObj;
    const visits = Array.isArray(draft && draft.visits) ? draft.visits : [];
    if (!visits.length) return toast({ message: "登録候補が0件です" });

    // commit payload：end_time は送らない（GASで start_time + course から再計算）
    const visitsForCommit = visits.map((v) => {
      const nv = { ...v };
      // UIでは end_time を扱わない。存在しても送らない。
      try { delete nv.end_time; } catch (e) {}
      // ついでに "表示専用" の可能性があるフィールドも将来整理しやすいようにここで固定
      // 顧客は UI で確定済み。登録事故防止のため customer_id を強制注入する
      nv.customer_id = customerId;
      return nv;
    });

    // 二重送信防止：同一payloadの連続commitをブロック
    // ※ draftが手修正されればハッシュが変わるので再送可能
    const contentHash = await sha256Hex_(JSON.stringify({ visits: visitsForCommit }));
    if (_lastCommitSucceeded && _lastCommitHash && _lastCommitHash === contentHash) {
      return toast({ message: "同じ内容の登録はすでに実行済みです（二重送信防止）" });
    }

    // confirm modal：誤操作防止
    const ok = await showModal({
      title: "登録実行の確認",
      bodyHtml: `この内容で ${visits.length} 件を登録します。実行してよいですか？`,
      okText: "実行",
      cancelText: "キャンセル",
    });
    if (!ok) return;

    setBusy(true, "登録しています...");
    resultEl.innerHTML = "";

    try {
      // 再送：通信失敗時などでも同一 request_id を維持する
      if (!_lastCommitRequestId || _lastCommitHash !== contentHash) {
        _lastCommitRequestId = newRequestId_();
      }
      _lastCommitHash = contentHash;

      const idToken = getIdToken();
      if (!idToken) throw new Error("未ログインです。ログインし直してください。");

      const resp = await callGas({
        action: "bulkRegisterVisits",
        request_id: _lastCommitRequestId,
        content_hash: _lastCommitHash,
        strict_customer_id: true,
        customer_id: customerId,
        visits: visitsForCommit,
        source: "portal_register",
      }, idToken);

      const u = unwrapResults(resp);
      const sum = summarizeCommit_(u);
      _lastCommitSucceeded = !!(sum && sum.allSuccess); // 全件成功のみ true（部分失敗は “成功扱い” にしない）
      const ui = commitTitleAndToast_(sum);
      // 成功時は JSON を出さない（要約のみ）
      const summaryHtml = renderCommitSummary_(u);
      resultEl.innerHTML = `
        ${summaryHtml}
        <div class="card">
          <p class="p"><b>${escapeHtml(ui.title)}</b></p>
          <p class="p text-sm text-muted" style="margin:0;">
            成功 ${sum.success} / 失敗 ${sum.failed} / スキップ ${sum.skipped}
          </p>
        </div>
      `;
      toast({ title: ui.toastTitle, message: ui.toastMsg });

      if (!sum.allSuccess) {
        const metaRid = (resp && resp._meta && resp._meta.request_id) ? resp._meta.request_id : _lastCommitRequestId;
        resultEl.innerHTML += `<div class="card card-warning"><p class="p text-sm">追跡ID: <b>${escapeHtml(String(metaRid || ""))}</b></p></div>`;
      }
    } catch (e) {
      _lastCommitSucceeded = false;
      const msg = (e && e.message) ? e.message : String(e);
      toast({ message: msg });
      try { setBusy(false); } catch (e2) {}

      // request_id が取れるなら画面にだけ出す（RequestLogs追跡用）
      const rid = (e && (e.request_id || (e.detail && e.detail.request_id))) ? (e.request_id || e.detail.request_id) : _lastCommitRequestId;
      if (rid) {
        resultEl.innerHTML = `<div class="card card-warning"><p class="p">登録エラー</p><p class="p text-sm">追跡ID: <b>${escapeHtml(String(rid))}</b></p></div>`;
      } else {
        resultEl.innerHTML = `<div class="card card-warning"><p class="p">登録エラー</p></div>`;
      }
    } finally {
      setBusy(false);
    }
  });
}
