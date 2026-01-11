// js/pages/register.js
import { render, qs, toast, escapeHtml, showModal } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { CONFIG } from "../config.js";
import { getIdToken, getUser, setUser } from "../auth.js";

const VISIT_TYPE_LABELS = {
  sitting: "シッティング",
  training: "トレーニング",
  meeting_free: "打ち合わせ（無料）",
  meeting_paid: "打ち合わせ（有料）",
};

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

async function fetchInterpreterToken_() {
  const idToken = getIdToken();
  console.log("[register] has id_token =", !!idToken, "len=", idToken ? idToken.length : 0);
  if (!idToken) throw new Error("未ログインです！id_tokenがありません。ログインしてください。");
  const r = await callGas({ action: "issueInterpreterToken" }, idToken);
  console.log("[register] issueInterpreterToken response received =", !!r, "hasRaw=", !!(r && r.raw));

  const raw = r && r.raw ? r.raw : r;
  console.log("[register] issueInterpreterToken parsed =", {
    ok: !!(raw && raw.ok),
    hasToken: !!(raw && raw.token),
    tokenLen: raw && raw.token ? String(raw.token).length : 0,
    hasError: !!(raw && raw.error),
  });

  if (!raw || !raw.ok || !raw.token) {
    throw new Error(raw && raw.error ? raw.error : "token issuance failed");
  }

  if (raw && raw.ctx) setUser(raw.ctx);

  return raw.token;
}

async function callInterpreter_(token, emailText) {
  console.log("[register] CONFIG.INTERPRETER_URL =", CONFIG.INTERPRETER_URL);
  console.log("[register] callInterpreter_: enter", { hasToken: !!token, tokenLen: token ? String(token).length : 0, emailLen: emailText ? String(emailText).length : 0 });
  if (!CONFIG.INTERPRETER_URL || CONFIG.INTERPRETER_URL.includes("YOUR_CLOUD_RUN_URL")) {
    throw new Error("INTERPRETER_URL is not set");
  }

  console.log("[register] callInterpreter_: before getUser()");
  const user = getUser() || {};
  console.log("[register] callInterpreter_: after getUser()", { hasUser: !!user, hasStaffId: !!user.staff_id, role: user.role || "" });

  if (!user || !user.staff_id) {
    toast({ message: "スタッフ情報が取得できません。ログインしてください。" });
    throw new Error("staff missing");
  }
  const staffId = user.staff_id || "";
  const staffName = user.staff_name || user.name || "";
  const isAdmin = user.role === "admin";
  const adminAssignStaffName = (document.getElementById("reg_assign_staff_name")?.value || "").trim();

  console.log("[register] callInterpreter_: build body (meta only)");
  const body = {
    op: "interpret_register_visits_v1",
    email_text: emailText,
    now_iso: nowIsoJst_(),
    tz: "Asia/Tokyo",
    constraints: {
      latest_end_time: "19:00",
      slide_limit_unspecified: "18:30",
      slot_minutes: 15,
      // staffは「解釈対象」ではなく「実行制約」
      // admin は「登録先スタッフ」を指定した場合のみ constraints に渡す（未指定は主担当をGAS側で決定）
      staff_id: (!isAdmin) ? staffId : "",
      staff_name: (!isAdmin) ? staffName : adminAssignStaffName,
    },
  };

  console.log("[register] callInterpreter_: about to fetch", {
    url: CONFIG.INTERPRETER_URL,
    hasAuthHeader: !!token,
    op: body.op,
    tz: body.tz,
    now_iso: body.now_iso,
  });

  console.log("[register] about to POST /interpret", {
    url: CONFIG.INTERPRETER_URL,
    hasToken: !!token,
    tokenLen: token ? String(token).length : 0,
    op: body.op,
    tz: body.tz,
    now_iso: body.now_iso,
    emailLen: emailText ? String(emailText).length : 0,
    constraints: {
      latest_end_time: body.constraints.latest_end_time,
      slide_limit_unspecified: body.constraints.slide_limit_unspecified,
      slot_minutes: body.constraints.slot_minutes,
      // PIIになりにくい範囲でメタのみ（必要なら staff_id も外せます）
      staff_id_present: !!body.constraints.staff_id,
      staff_name_present: !!body.constraints.staff_name,
    },
  });

  const resp = await fetch(CONFIG.INTERPRETER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const contentType = resp.headers.get("content-type") || "";
  const text = await resp.text();
  console.log("[register] /interpret response meta", {
    status: resp.status,
    ok: resp.ok,
    contentType,
    bodyLen: text ? String(text).length : 0,
  });

  let data = {};
  try { data = JSON.parse(text); }
  catch (e) { data = {}; }

  if (!resp.ok) {
    const detail = (data && (data.detail || data.error || data.message)) ? (data.detail || data.error || data.message) : "";
    throw new Error(detail ? String(detail) : `Interpreter error (${resp.status})`);  }
  if (!data.ok || !data.draft) throw new Error(data.error || "invalid interpreter response");
  return data;
}

function prettyJson_(obj) {
  return JSON.stringify(obj, null, 2);
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

// ========= 診断（エラー時のみ表示＋コピー） =========
function safeJson_(v) {
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

async function copyToClipboard_(text) {
  const s = String(text || "");
  if (!s) return false;
  // Clipboard API（HTTPS / GitHub Pages 想定）
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) {}
  // fallback
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) {}
  return false;
}

async function showDiagnosticModal_({ title = "診断情報", diagText = "" } = {}) {
  const bodyHtml = `
    <p class="p text-sm text-muted" style="margin:0 0 8px 0;">
      以下をコピーして共有してください（個人情報を含めない設計です）。
    </p>
    <textarea class="textarea mono" rows="14" readonly style="font-size:12px;">${escapeHtml(diagText)}</textarea>
  `;
  const ok = await showModal({
    title,
    bodyHtml,
    okText: "コピー",
    cancelText: "閉じる",
  });
  if (!ok) return;
  const copied = await copyToClipboard_(diagText);
  toast({ title: copied ? "コピーしました" : "コピー失敗", message: copied ? "診断情報をクリップボードに保存しました。" : "手動でコピーしてください。" });
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
  return VISIT_TYPE_LABELS[type] || String(type || "");
}

export function renderRegisterTab(app) {
  render(app, `
    <section class="section">
      <h1 class="h1">予約登録</h1>
      <p class="p text-sm text-muted" style="margin-top:-8px; margin-bottom:24px;">依頼メールから予約候補を自動生成し、確認後に一括登録できます</p>

      <!-- メール入力 -->
      <div class="card" style="margin-bottom:20px;">
        <label class="label" style="margin-bottom:8px; display:block; font-weight:600;">メール本文</label>
        <textarea id="reg_email" class="textarea" rows="8" placeholder="顧客からの依頼メールを貼り付けてください&#x0a;例: 1月10日から12日まで、朝夕2回ずつシッティングをお願いします。"></textarea>
        
        <!-- 補足情報（折りたたみ可能に） -->
        <details style="margin-top:16px;">
          <summary style="cursor:pointer; font-weight:600; color:#666; padding:8px 0;">
            📝 補足情報を追加（タップで展開）
          </summary>
          <div style="margin-top:12px;">
            <p class="p text-sm text-muted" style="margin-bottom:12px;">補足情報を追加するとAIの解釈精度が向上します</p>
            
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">顧客名</label>
              <input id="reg_hint_customer" class="input" placeholder="例: 佐藤 花子" />
            </div>
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">顧客特定ヒント</label>
              <input id="reg_hint_customer_info" class="input" placeholder="例: 住所の一部 / マンション名 / ペット名" />
            </div>
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">訪問期間</label>
              <input id="reg_hint_date" class="input" placeholder="例: 1/1 から 1/5" />
            </div>
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">訪問回数</label>
              <input id="reg_hint_count" class="input" placeholder="例: 合計5回 / 初日と最終日は1回" />
            </div>
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">訪問時間</label>
              <input id="reg_hint_time" class="input" placeholder="例: 朝 / 夕方 / 14時 / 1/1は夜" />
            </div>
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">訪問タイプ</label>
              <input id="reg_hint_type" class="input" placeholder="例: シッティング / トレーニング / 打ち合わせ" />
            </div>
            <div class="hint-row" style="margin-bottom:10px;">
              <label class="hint-label" style="min-width:140px;">メモ</label>
              <textarea id="reg_hint_memo" class="textarea" rows="2" placeholder="例: 最終回：鍵はポスト返却。"></textarea>
            </div>
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

      <!-- 顧客候補 -->
      <div id="reg_customer_candidates" class="is-hidden" style="margin-bottom:20px;"></div>

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

  const emailEl = qs("#reg_email");
  const hintCustomerEl = qs("#reg_hint_customer");
  const hintCustomerInfoEl = qs("#reg_hint_customer_info");
  const hintDateEl = qs("#reg_hint_date");
  const hintCountEl = qs("#reg_hint_count");
  const hintTimeEl = qs("#reg_hint_time");
  const hintTypeEl = qs("#reg_hint_type");
  const hintMemoEl = qs("#reg_hint_memo");
  const assignWrapEl = qs("#reg_assign");
  const assignStaffNameEl = qs("#reg_assign_staff_name");
  const assignSummaryTextEl = qs("#reg_assign_summary_text");
  const interpretBtn = qs("#reg_interpret");
  const commitBtn = qs("#reg_commit");
  const resultEl = qs("#reg_result");
  const warningsEl = qs("#reg_warnings");
  const previewEl = qs("#reg_preview");
  const customerCandidatesEl = qs("#reg_customer_candidates");
  const customerSelectedEl = qs("#reg_customer_selected");
  const overlayEl = qs("#reg_overlay");
  const overlayTextEl = qs("#reg_overlay_text");

  let _busy = false;
  let _draftObj = null; // { visits:[], warnings:[] }
  let _selectedCustomer = null; // { customer_id, name, kana?, memo? }
  let _hardErrors = [];
  let _lastCommitSucceeded = false;
  let _customerLookupTimer = null;
  let _lastCommitHash = "";
  let _lastCommitRequestId = "";
  let _memoDebounceTimer = null;

  ensureCourseOptions_().then(() => { try { refreshUI_(); } catch (e) {} });

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

  function renderPreview_(draft) {
    if (!previewEl) return;
    const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
    if (!visits.length) {
      previewEl.classList.add("is-hidden");
      previewEl.innerHTML = "";
      return;
    }
    const html = visits.map((v, idx) => {
      const date = escapeHtml(v.date || "");
      const st = fmtHm_(v.start_time);
      const ed = fmtHm_(v.end_time);
      const timeRaw = [st, ed].filter(Boolean).join(" - ");
      const time = escapeHtml(timeRaw);
      const customer = escapeHtml(v.customer_name || "");
      const staff = escapeHtml(v.staff_name || v.staff_id || "");
      const type = escapeHtml(fmtVisitType_(v.visit_type));
      const course = escapeHtml(v.course || "");
      const memo = escapeHtml(v.memo || "");
      const hint = escapeHtml(v.time_hint || "");
      return `
        <div class="preview-row">
          <div class="preview-row-top">
            <div class="preview-title">#${idx + 1} ${customer || "（顧客名なし）"}</div>
            <div class="preview-date">${date} ${time}</div>
          </div>
          <div class="preview-meta">
            ${staff ? `<span class="badge">${staff}</span>` : ""}
            ${type ? `<span class="badge badge-visit-type">${type}</span>` : ""}
            ${course ? `<span class="badge">${course}</span>` : ""}
            ${hint ? `<span class="badge">${hint}</span>` : ""}
          </div>
          ${memo ? `<div class="preview-memo">${memo}</div>` : ""}
        </div>
      `;
    }).join("");
    previewEl.innerHTML = `
      <div class="card">
        <p class="p"><b>登録候補プレビュー</b>（ドラフトを確認してください）</p>
        <div class="preview-table">${html}</div>
      </div>
    `;
    previewEl.classList.remove("is-hidden");
  }

  function renderCustomerCandidates_(state) {
    if (!customerCandidatesEl) return;
    if (!state || !state.name) {
      customerCandidatesEl.classList.add("is-hidden");
      customerCandidatesEl.innerHTML = "";
      return;
    }
    const { status, results = [], error } = state;
    if (status === "loading") {
      customerCandidatesEl.innerHTML = `
        <div class="card">
          <p class="p">顧客候補を検索中：${escapeHtml(state.name)}</p>
        </div>
      `;
      customerCandidatesEl.classList.remove("is-hidden");
      return;
    }
    if (status === "error") {
      customerCandidatesEl.innerHTML = `
        <div class="card card-warning">
          <p class="p text-danger"><b>顧客候補の取得に失敗</b></p>
          <p class="p">${escapeHtml(error || "不明なエラーです")}</p>
        </div>
      `;
      customerCandidatesEl.classList.remove("is-hidden");
      return;
    }

    const count = Array.isArray(results) ? results.length : 0;
    const title = count > 1
      ? `顧客候補が複数あります（${count}件）`
      : count === 1
        ? "顧客候補が1件見つかりました"
        : "該当する顧客候補が見つかりませんでした";

    const list = (results || []).slice(0, 5).map((r, idx) => {
      const name = r.name || r.customer_name || r.display_name || "";
      const kana = r.kana || r.name_kana || "";
      const id = r.id || r.customer_id || "";
      const memo = r.memo || "";
      const address = r.address || "";
      const petNames = Array.isArray(r.pet_names) ? r.pet_names : [];
      const petsLine = petNames.length ? petNames.join("/") : "";

        const picked = 
          (_selectedCustomer &&
            _selectedCustomer.customer_id &&
            String(_selectedCustomer.customer_id) === String(id))
            ? "checked"
            : "";

        return `
          <label class="candidate-row candidate-pick">
            <div class="row" style="align-items:flex-start; gap:10px;">
              <input
                type="radio"
                name="reg_customer_pick"
                value="${escapeHtml(id)}"
                data-idx="${idx}"
                ${picked}
              />
              <div style="flex:1;">
                <div class="candidate-title">
                  #${idx + 1} ${escapeHtml(name || "(名称不明)")}
                </div>

                <div class="candidate-meta text-muted text-sm">
                  ${kana ? ` / ${escapeHtml(kana)}` : ""}
                </div>

                ${address
                  ? `<div class="candidate-meta text-sm">住所：${escapeHtml(address)}</div>`
                  : ""
                }

                ${petsLine
                  ? `<div class="candidate-meta text-sm">ペット：${escapeHtml(petsLine)}</div>`
                  : ""
                }

                ${memo
                  ? `<div class="candidate-memo text-sm">${escapeHtml(memo)}</div>`
                  : ""
                }
              </div>
            </div>
          </label>
        `;
      }).join("");

    customerCandidatesEl.innerHTML = `
      <div class="card ${count > 1 ? "card-warning" : ""}">
        <p class="p"><b>${escapeHtml(title)}</b></p>
        <p class="p text-sm text-muted">キー：${escapeHtml(state.name)}</p>
        ${list ? `<div class="candidate-list">${list}</div>` : ""}
      </div>
    `;
    customerCandidatesEl.classList.remove("is-hidden");

    const radios = customerCandidatesEl.querySelectorAll('input[name="reg_customer_pick"]');
    radios.forEach((el) => {
      el.addEventListener("change", () => {
        try {
          const i = Number(el.getAttribute("data-idx") || "0");
          const picked = results[i];
          applyCustomerToDraft_(picked);
          renderCustomerCandidates_({ ...state });
          refreshUI_();
        } catch (e) {
          toast({ message: (e && e.message) ? e.message : String(e) });
        }
      });
    });

    if (results.length === 1 && !_selectedCustomer) {
     applyCustomerToDraft_(results[0]);
     refreshUI_();
     renderCustomerCandidates_({ ...state });
    }
  }

  function renderCustomerSelected_() {
    if (!customerSelectedEl) return;
    if (!_selectedCustomer) {
      customerSelectedEl.classList.add("is-hidden");
      customerSelectedEl.innerHTML = "";
      return;
    }
    const name = _selectedCustomer.name || "";
    const id = _selectedCustomer.customer_id || "";
    customerSelectedEl.innerHTML = `
      <div class="card">
        <p class="p"><b>顧客確定</b>：${escapeHtml(name)} ${id ? `<span class="badge">ID:${escapeHtml(id)}</span>` : ""}</p>
        <p class="p text-sm text-muted">顧客を変更する場合は、顧客名を指定して再生成してください。</p>
      </div>
    `;
    customerSelectedEl.classList.remove("is-hidden");
  }

  function applyCustomerToDraft_(customer) {
    if (!customer || !_draftObj) return;
    const id = String(customer.customer_id || customer.id || "").trim();
    if (!id) return;

    _selectedCustomer = {
      customer_id: id,
      name: String(customer.name || customer.customer_name || "").trim() || String(customer.display_name || "").trim(),
      kana: String(customer.kana || "").trim(),
      memo: String(customer.memo || "").trim(),
    };

    const visits = Array.isArray(_draftObj.visits) ? _draftObj.visits : [];
    visits.forEach(v => {
      v.customer_id = id;
      v.customer_name = _selectedCustomer.name || v.customer_name || "";
    });
  }

  function computeHardErrors_(draft) {
    const errors = [];
    const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
    const seen = new Map(); // key -> [idx]
    visits.forEach((v, idx) => {
      const date = String(v.date || "").trim();
      const st = String(v.start_time || "").trim();
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

  function renderEditor_(draft) {
    if (!previewEl) return;
    const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
    if (!visits.length) {
      previewEl.classList.add("is-hidden");
      previewEl.innerHTML = "";
      return;
    }

    const locked = !_selectedCustomer;

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

      const typeOptions = Object.keys(VISIT_TYPE_LABELS).map(k => {
        const sel = (k === vt) ? "selected" : "";
        return `<option value="${escapeHtml(k)}" ${sel}>${escapeHtml(VISIT_TYPE_LABELS[k])}</option>`;
      }).join("");

      return `
        <div class="preview-card ${locked ? "is-locked" : ""}" data-idx="${idx}" style="padding:12px; margin-bottom:12px; border:1px solid #ddd; border-radius:8px;">
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
                    ${locked ? "disabled" : ""}
                    style="width: 160px; max-width: 60vw; font-size:14px;"
                  />
                </div>
              </div>
              <div style="display:flex; gap:6px; flex-shrink:0;">
                <button class="btn btn-sm" type="button" data-action="dup" ${locked ? "disabled" : ""} title="複製" style="padding:4px 8px; min-width:auto;">📋</button>
                <button class="btn btn-sm" type="button" data-action="del" ${locked ? "disabled" : ""} title="削除" style="padding:4px 8px; min-width:auto; color:#d32f2f;">🗑️</button>
              </div>
            </div>
            ${warnBadges ? `<div style="margin-top:6px;">${warnBadges}</div>` : ""}
          </div>

          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px; margin-bottom:10px;">
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">⏰ 開始</label>
              <input type="time" class="input mono" data-field="start_time" value="${escapeHtml(st || "09:00")}" ${locked ? "disabled" : ""} style="font-size:14px;" />
            </div>
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">⏱️ 終了</label>
              <input class="input mono" value="${escapeHtml(endHm)}" disabled style="font-size:14px;" />
            </div>
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">📦 コース</label>
              <select class="input" data-field="course" ${locked ? "disabled" : ""} style="font-size:14px;">
                ${courseSelectHtml_(course || "30min")}
              </select>
            </div>
            <div>
              <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">🏷️ タイプ</label>
              <select class="input" data-field="visit_type" ${locked ? "disabled" : ""} style="font-size:14px;">${typeOptions}</select>
            </div>
          </div>

          <div>
            <label class="label-sm" style="display:block; margin-bottom:4px; font-weight:600; color:#555; font-size:12px;">📝 メモ</label>
            <textarea class="textarea" rows="2" data-field="memo" ${locked ? "disabled" : ""} placeholder="この訪問に関するメモ（任意）" style="font-size:14px;">${escapeHtml(memo)}</textarea>
          </div>
        </div>
      `;
    }).join("");

    previewEl.innerHTML = `
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:16px;">
          <h2 style="font-size:16px; font-weight:600; margin:0 0 4px 0;">登録候補（${visits.length}件）</h2>
          <p class="p text-sm text-muted" style="margin:0;">
            ${locked 
              ? "⚠️ 先に上の顧客候補から選択してください" 
              : "⚠️ AIの解釈は正確とは限りません。必要に応じて修正してください。"}
          </p>
        </div>
        <div class="preview-wrap">${cards}</div>
      </div>
    `;
    previewEl.classList.remove("is-hidden");
  }

  function refreshUI_() {
    renderCustomerSelected_();
    _hardErrors = computeHardErrors_(_draftObj);

    let warnings = (_draftObj && Array.isArray(_draftObj.warnings)) ? _draftObj.warnings : [];
    // 顧客が確定しているなら、missing_customer_name は解消済み扱い（表示しない）
    if (_selectedCustomer && _selectedCustomer.customer_id) {
      warnings = warnings.filter(w => String(w && w.code || "") !== "missing_customer_name");
    }
    const hardAsWarnings = _hardErrors.map(e => ({ code: e.code, message: e.message, row_nums: [] }));
    renderWarnings_([ ...warnings, ...hardAsWarnings ]);

    renderEditor_(_draftObj);

    const hasDraft = !!(_draftObj && Array.isArray(_draftObj.visits) && _draftObj.visits.length);
    const hasCustomer = !!_selectedCustomer;
    const hasHardError = !!(_hardErrors && _hardErrors.length);
    commitBtn.disabled = _busy || !hasDraft || !hasCustomer || hasHardError;
  }

  function buildHintText_() {
    const hints = [
      { label: "顧客名", el: hintCustomerEl },
      { label: "訪問期間", el: hintDateEl },
      { label: "訪問回数", el: hintCountEl },
      { label: "訪問時間", el: hintTimeEl },
      { label: "訪問タイプ", el: hintTypeEl },
      { label: "メモ", el: hintMemoEl },
    ];

    const items = hints
      .map(({ label, el }) => ({ label, value: String(el?.value || "").trim() }))
      .filter(({ value }) => !!value);

    if (!items.length) return "";

    // GPTに「本文が曖昧ならこの補足を優先せよ」という意図を明確化
    const lines = items.map(({ label, value }) => `- ${label}: ${value}`);

    return [
      "【補足（解釈のための制約条件）】",
      "本文が曖昧な場合は、以下の補足を優先して解釈してください。",
      ...lines,
    ].join("\n");
  }

  if (previewEl) {
    previewEl.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-action]") : null;
      if (!btn) return;
      if (!_draftObj || !_selectedCustomer) return;
      const wrap = btn.closest("[data-idx]");
      const idx = wrap ? Number(wrap.getAttribute("data-idx") || "0") : -1;
      if (idx < 0) return;

      const action = btn.getAttribute("data-action");
      const visits = Array.isArray(_draftObj.visits) ? _draftObj.visits : [];

      if (action === "del") {
        visits.splice(idx, 1);
        refreshUI_();
        return;
      }
      if (action === "dup") {
        const src = visits[idx];
        if (!src) return;
        const maxRow = visits.reduce((m, v) => Math.max(m, Number(v.row_num || 0)), 0);
        const copy = { ...src, row_num: maxRow + 1 };
        visits.splice(idx + 1, 0, copy);
        refreshUI_();
        return;
      }
    });

    previewEl.addEventListener("input", (ev) => {
      const el = ev.target;
      if (!el || !_draftObj || !_selectedCustomer) return;
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

      } else if (field === "start_time") {
        // time入力は "HH:mm" なので、draft(JSON)はISO(+09:00)に戻して統一する
        const iso = isoFromDateAndHmJst_(v.date, el.value);
        if (!iso) {
          toast({ message: "開始時刻の形式が不正です。再入力してください。" });
          return;
        }
        v.start_time = iso;
        v.time_hint = "fixed";
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
          syncDraftTextarea_(); // JSONテキストエリアだけ更新
        }, 300);

        return; // UI全体の再描画は不要（入力モード維持のため）
      }
      // end_time は UI編集不可・payload送信不可：万一残っていてもここで破棄
      try { delete v.end_time; } catch (e) {}
      refreshUI_();
    });
  }

  function scheduleCustomerLookup_(draft) {
    if (_customerLookupTimer) window.clearTimeout(_customerLookupTimer);
    _customerLookupTimer = window.setTimeout(() => {
      fetchCustomerCandidates_(draft);
    }, 400);
  }

  async function fetchCustomerCandidates_(draft) {
    const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
    const first = visits[0] || {};

    // 顧客名（従来キー）
    const nameQuery = String(first.customer_name || "").trim();

    // 顧客特定ヒント（住所断片 / ペット名）
    const hintQuery = String(hintCustomerInfoEl?.value || "").trim();

    if (!nameQuery && !hintQuery) {
      renderCustomerCandidates_(null);
      return;
    }

    renderCustomerCandidates_({
      status: "loading",
      name: nameQuery || hintQuery,
    });

    try {
      const idToken = getIdToken();
      if (!idToken) throw new Error("未ログインです。ログインし直してください。");

     // 安全優先の検索順序：
     // - name がある：まず name のみ（hintは使わない）
     //   - 0件なら救済で name+hint
     //   - 複数なら hint がある場合のみ name+hint（絞り/再ランク）
     // - name がない：hint のみ

     async function call_(nq, hq) {
       const resp = await callGas({
         action: "searchCustomerCandidates",
         name_query: nq,
         hint_query: hq,
         limit: 20,
       }, idToken);
       const u = unwrapResults(resp) || {};
       return (u && Array.isArray(u.results)) ? u.results : [];
     }

     let results = [];
     if (nameQuery) {
       // 1st: name only
       results = await call_(nameQuery, "");

       if (results.length === 0 && hintQuery) {
         // fallback: name + hint
         results = await call_(nameQuery, hintQuery);
       } else if (results.length >= 2 && hintQuery) {
         // narrow/rerank with hint (if it helps)
         const r2 = await call_(nameQuery, hintQuery);
         if (r2.length > 0) results = r2;
       }
     } else {
       // name empty: hint only
       results = await call_("", hintQuery);
     }

     renderCustomerCandidates_({
       status: "loaded",
       name: nameQuery || hintQuery,
       results,
     });

    } catch (e) {
      renderCustomerCandidates_({
        status: "error",
        name: nameQuery || hintQuery,
        error: (e && e.message) ? e.message : String(e),
      });
    }
  }

  interpretBtn.addEventListener("click", async () => {
    console.log("[register] interpret button clicked");
    console.log("[register] emailEl exists =", !!emailEl);
    console.log("[register] email length =", emailEl && emailEl.value ? String(emailEl.value).length : 0);
    if (_busy) return;
    const emailText = String(emailEl.value || "").trim();
    if (!emailText) return toast({ message: "メール本文を貼り付けてください" });

    const hintText = buildHintText_();
    const mergedText = hintText ? `${emailText}\n\n${hintText}\n` : emailText;

    setBusy(true, "AIが解釈しています...");
    resultEl.innerHTML = "";
    renderWarnings_([]);
    renderPreview_(null);
    renderCustomerCandidates_(null);

    try {
      console.log("[register] step1: before fetchInterpreterToken_");
      const token = await fetchInterpreterToken_();
      console.log("[register] step2: token issued len=", String(token || "").length);

      console.log("[register] step3: before callInterpreter_");
      const adminAssignStaffName = (assignStaffNameEl && String(assignStaffNameEl.value || "").trim()) || "";
      const data = await callInterpreter_(token, mergedText, adminAssignStaffName);
      console.log("[register] step4: callInterpreter_ ok=", !!(data && data.ok));

      _draftObj = data.draft;
      _selectedCustomer = null;
      refreshUI_();
      scheduleCustomerLookup_(_draftObj);
      resultEl.innerHTML = `<div class="card"><p class="p">登録候補を生成しました。顧客を選択し、内容を確認して「登録実行」を押してください。</p></div>`;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      toast({ message: msg });
      // 診断情報（エラー時のみ）
      const user = getUser() || {};
      const diag = {
        client_time: nowIsoJst_(),
        page: "register",
        phase: "interpret",
        role: user.role || "",
        staff_id: user.staff_id || "",
        org_id: user.org_id || "",
        error_message: msg,
      };
      await showDiagnosticModal_({ title: "診断情報（解釈エラー）", diagText: safeJson_(diag) });
    } finally {
      setBusy(false);
    }
  });

  commitBtn.addEventListener("click", async () => {
    if (!_selectedCustomer) return toast({ message: "先に顧客を確定してください" });
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

      // 一部未完了/失敗のときだけ診断コピーを提示
      if (!sum.allSuccess) {
        try { setBusy(false); } catch (e) {}
        const metaRid = (resp && resp._meta && resp._meta.request_id) ? resp._meta.request_id : _lastCommitRequestId;
        const user = getUser() || {};
        const diag = {
          client_time: nowIsoJst_(),
          page: "register",
          phase: "commit",
          action: "bulkRegisterVisits",
          request_id: metaRid,
          content_hash: _lastCommitHash,
          role: user.role || "",
          staff_id: user.staff_id || "",
          org_id: user.org_id || "",
          commit_summary: sum,
        };
        await showDiagnosticModal_({ title: "診断情報（登録が一部未完了）", diagText: safeJson_(diag) });
      }
    } catch (e) {
      _lastCommitSucceeded = false;
      const msg = (e && e.message) ? e.message : String(e);
      toast({ message: msg });
      try { setBusy(false); } catch (e2) {}
      
      // ApiError なら request_id を拾う（GAS RequestLogs 追跡用）
      const rid = (e && (e.request_id || (e.detail && e.detail.request_id))) ? (e.request_id || e.detail.request_id) : _lastCommitRequestId;
      const user = getUser() || {};
      const diag = {
        client_time: nowIsoJst_(),
        page: "register",
        phase: "commit",
        action: "bulkRegisterVisits",
        request_id: rid,
        content_hash: _lastCommitHash,
        role: user.role || "",
        staff_id: user.staff_id || "",
        org_id: user.org_id || "",
        error_message: msg,
        error_detail: (e && e.detail) ? e.detail : null,
      };
      await showDiagnosticModal_({ title: "診断情報（登録エラー）", diagText: safeJson_(diag) });
    } finally {
      setBusy(false);
    }
  });
}
