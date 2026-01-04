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
      <h1 class="h1">予約登録（draft → commit）</h1>

      <label class="label">メール本文</label>
      <textarea id="reg_email" class="textarea" rows="10" placeholder="依頼文を貼りつけてください"></textarea>

      <div class="card" style="margin-top:12px;">
        <p class="p"><b>補足（任意）</b>：空欄は送信しません。</p>
        <div class="hint-row">
          <div class="hint-label">顧客名：</div>
          <input id="reg_hint_customer" class="input" placeholder="例：佐藤 花子" />
        </div>
        <div class="hint-row">
          <div class="hint-label">顧客特定ヒント：</div>
          <input id="reg_hint_customer_info" class="input" placeholder="例：青葉区○○ / ぽち / マンション名 / 電話末尾1234 など" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問期間：</div>
          <input id="reg_hint_date" class="input" placeholder="例：2026-01-01 - 2026-01-05（または 1/1 - 1/5）" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問回数：</div>
          <input id="reg_hint_count" class="input" placeholder="例：合計3回 / 1日2回" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問時間：</div>
          <input id="reg_hint_time" class="input" placeholder="例：朝 / 夕方 / 14時 / 1/1は夜 など" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問タイプ：</div>
          <input id="reg_hint_type" class="input" placeholder="例：シッティング / トレーニング / 打ち合わせ" />
        </div>
        <div class="hint-row">
          <div class="hint-label">メモ：</div>
          <textarea id="reg_hint_memo" class="textarea" rows="2" placeholder="例：鍵はポスト返却。給餌は1日2回。"></textarea>
        </div>
        <p class="p text-sm text-muted" style="margin-top:6px;">補足項目は入力がある場合のみ添付します。</p>
      </div>

      <div id="reg_assign" class="card is-hidden" style="margin-top:12px;">
        <p class="p"><b>登録先スタッフ（管理者のみ）</b></p>
        <div class="hint-row">
          <div class="hint-label">スタッフ名：</div>
          <input id="reg_assign_staff_name" class="input" placeholder="未入力の場合は「顧客の主担当」に登録します" />
        </div>
        <p class="p text-sm text-muted" style="margin-top:6px;">
          登録先は GAS 側で担当関係（CustomerStaffs）を確認します。担当関係がない場合は登録できません。
        </p>
      </div>

      <div id="reg_assign_summary" class="card" style="margin-top:12px;">
        <p class="p"><b>登録先</b>：<span id="reg_assign_summary_text">（未ログイン）</span></p>
      </div>

      <div class="row">
        <button id="reg_interpret" class="btn">解釈（draft生成）</button>
        <button id="reg_commit" class="btn btn-primary" disabled>登録実行（commit）</button>
      </div>

      <p class="p text-muted">手順：1) 解釈 → 2) 顧客確定 → 3) 候補を必要に応じて修正 → 4) 登録実行</p>

      <div id="reg_customer_selected" class="is-hidden"></div>
      <div id="reg_customer_candidates" class="is-hidden"></div>

      <div id="reg_warnings" class="is-hidden"></div>
      <div id="reg_preview" class="is-hidden"></div>

      <div class="card" style="margin-top:12px;">
        <div class="row row-between">
          <p class="p"><b>詳細（上級者向け）</b>：JSON を直接編集できます</p>
          <button id="reg_toggle_json" class="btn btn-sm" type="button">JSONを表示</button>
        </div>
        <textarea id="reg_draft" class="textarea mono is-hidden" rows="12" placeholder="解釈結果がここに入ります（上級者向け）。"></textarea>
      </div>

      <div id="reg_result" class="p"></div>
    </section>

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
  const draftEl = qs("#reg_draft");
  const interpretBtn = qs("#reg_interpret");
  const commitBtn = qs("#reg_commit");
  const resultEl = qs("#reg_result");
  const warningsEl = qs("#reg_warnings");
  const previewEl = qs("#reg_preview");
  const customerCandidatesEl = qs("#reg_customer_candidates");
  const customerSelectedEl = qs("#reg_customer_selected");
  const toggleJsonBtn = qs("#reg_toggle_json");
  const overlayEl = qs("#reg_overlay");
  const overlayTextEl = qs("#reg_overlay_text");

  let _busy = false;
  let _draftObj = null; // { visits:[], warnings:[] }
  let _selectedCustomer = null; // { customer_id, name, kana?, memo? }
  let _hardErrors = [];
  let _jsonVisible = false;
  let _lastCommitSucceeded = false;
  let _customerLookupTimer = null;
  let _lastCommitHash = "";
  let _lastCommitRequestId = "";

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
      commitBtn.disabled = b || !draftEl.value.trim();
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
        const picked = (_selectedCustomer && _selectedCustomer.customer_id && String(_selectedCustomer.customer_id) === String(id)) ? "checked" : "";
        return `
          <label class="candidate-row candidate-pick">
            <div class="row" style="align-items:flex-start; gap:10px;">
              <input type="radio" name="reg_customer_pick" value="${escapeHtml(id)}" data-idx="${idx}" ${picked} />
              <div style="flex:1;">
                <div class="candidate-title">#${idx + 1} ${escapeHtml(name || "(名称不明)")}</div>
                <div class="candidate-meta text-muted text-sm">
                  ${id ? `ID: ${escapeHtml(id)} ` : ""}
                  ${kana ? ` / ${escapeHtml(kana)}` : ""}
                </div>
                ${memo ? `<div class="candidate-memo text-sm">${escapeHtml(memo)}</div>` : ""}
              </div>
            </div>
          </label>
        `;
    }).join("");

    customerCandidatesEl.innerHTML = `
      <div class="card ${count > 1 ? "card-warning" : ""}">
        <p class="p"><b>${escapeHtml(title)}</b></p>
        <p class="p text-sm text-muted">キー：${escapeHtml(state.name)}（最終確定はGAS側で行われます）</p>
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
        <p class="p text-sm text-muted">顧客を変更する場合は「解釈」からやり直してください（誤登録防止のため）。</p>
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
    visits.forEach(v => { v.customer_id = id; });
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
      const st = String(v.start_time || "").trim();
      const et = String(v.end_time || "").trim();
      const course = String(v.course || "").trim();
      const vt = String(v.visit_type || "sitting").trim();
      const memo = String(v.memo || "");
      const timeHint = String(v.time_hint || "unspecified").trim();

      const warnBadges = [
        (timeHint === "unspecified") ? fmtWarnBadge_("時間は仮設定（必要に応じてカレンダーで調整）") : "",
        (!course) ? fmtWarnBadge_("コースは仮設定（30min）") : "",
      ].filter(Boolean).join(" ");

      const typeOptions = Object.keys(VISIT_TYPE_LABELS).map(k => {
        const sel = (k === vt) ? "selected" : "";
        return `<option value="${escapeHtml(k)}" ${sel}>${escapeHtml(VISIT_TYPE_LABELS[k])}</option>`;
      }).join("");

      return `
        <div class="preview-card ${locked ? "is-locked" : ""}" data-idx="${idx}">
          <div class="preview-row-top">
            <div>
              <div class="preview-title">#${escapeHtml(rowNum)} ${escapeHtml(date || "(日付不明)")}</div>
              <div class="preview-meta">
                ${warnBadges || ""}
              </div>
            </div>
            <div class="row" style="gap:8px;">
              <button class="btn btn-sm" type="button" data-action="dup" ${locked ? "disabled" : ""}>複製</button>
              <button class="btn btn-sm" type="button" data-action="del" ${locked ? "disabled" : ""}>削除</button>
            </div>
          </div>

          <div class="edit-grid">
            <div>
              <div class="label-sm">開始</div>
              <input class="input mono" data-field="start_time" value="${escapeHtml(st || "09:00")}" ${locked ? "disabled" : ""} />
            </div>
            <div>
              <div class="label-sm">終了</div>
              <input class="input mono" data-field="end_time" value="${escapeHtml(et)}" placeholder="任意" ${locked ? "disabled" : ""} />
            </div>
            <div>
              <div class="label-sm">コース</div>
              <input class="input" data-field="course" value="${escapeHtml(course || "30min")}" ${locked ? "disabled" : ""} />
            </div>
            <div>
              <div class="label-sm">タイプ</div>
              <select class="input" data-field="visit_type" ${locked ? "disabled" : ""}>${typeOptions}</select>
            </div>
          </div>

          <div style="margin-top:8px;">
            <div class="label-sm">メモ</div>
            <textarea class="textarea" rows="2" data-field="memo" ${locked ? "disabled" : ""}>${escapeHtml(memo)}</textarea>
          </div>
        </div>
      `;
    }).join("");

    previewEl.innerHTML = `
      <div class="card">
        <p class="p"><b>登録候補（修正可）</b></p>
        ${locked ? `<p class="p text-sm text-muted">先に顧客を確定してください（顧客未確定の間は編集できません）。</p>` : `<p class="p text-sm text-muted">必要に応じて修正してください（時間/コースの仮設定は黄色表示です）。</p>`}
        <div class="preview-wrap">${cards}</div>
      </div>
    `;
    previewEl.classList.remove("is-hidden");
  }

  function syncDraftTextarea_() {
    if (!draftEl) return;
    if (!_draftObj) { draftEl.value = ""; return; }
    draftEl.value = prettyJson_(_draftObj);
    // draftEl には draftそのものを入れる（現行互換）
  }

  function refreshUI_() {
    renderCustomerSelected_();
    _hardErrors = computeHardErrors_(_draftObj);

    const warnings = (_draftObj && Array.isArray(_draftObj.warnings)) ? _draftObj.warnings : [];
    const hardAsWarnings = _hardErrors.map(e => ({ code: e.code, message: e.message, row_nums: [] }));
    renderWarnings_([ ...warnings, ...hardAsWarnings ]);

    renderEditor_(_draftObj);

    const hasDraft = !!(_draftObj && Array.isArray(_draftObj.visits) && _draftObj.visits.length);
    const hasCustomer = !!_selectedCustomer;
    const hasHardError = !!(_hardErrors && _hardErrors.length);
    commitBtn.disabled = _busy || !hasDraft || !hasCustomer || hasHardError;

    syncDraftTextarea_();
  }

  function buildHintText_() {
    const hints = [
      { label: "顧客名", el: hintCustomerEl },
      { label: "ペット情報", el: hintCustomerInfoEl },
      { label: "訪問日時", el: hintDateEl },
      { label: "訪問回数", el: hintCountEl },
      { label: "訪問時間", el: hintTimeEl },
      { label: "訪問タイプ", el: hintTypeEl },
      { label: "メモ", el: hintMemoEl },
    ];
    const lines = hints
      .map(({ label, el }) => ({ label, value: String(el?.value || "").trim() }))
      .filter(({ value }) => !!value)
      .map(({ label, value }) => `${label}：${value}`);
    if (!lines.length) return "";
    return `補足が必要な場合\n${lines.join("\n")}`;
  }

  function parseDraftFromTextarea_() {
    const raw = String(draftEl.value || "").trim();
    if (!raw) return { draft: null, error: null };
    try {
      const draft = JSON.parse(raw);
      return { draft, error: null };
    } catch (e) {
      return { draft: null, error: e };
    }
  }

  function refreshFromDraftTextarea_() {
    if (!draftEl) return;
    const raw = String(draftEl.value || "").trim();
    if (!raw) {
      _draftObj = null;
      _selectedCustomer = null;
      renderWarnings_([]);
      renderCustomerCandidates_(null);
      renderCustomerSelected_();
      renderEditor_(null);
      commitBtn.disabled = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const draft = parsed && parsed.draft ? parsed.draft : parsed;
      _draftObj = draft;
      const visits = (draft && Array.isArray(draft.visits)) ? draft.visits : [];
      const cid = String((visits[0] && visits[0].customer_id) || "").trim();
      if (!cid) _selectedCustomer = null;
      refreshUI_();
      scheduleCustomerLookup_(draft);
    } catch (e) {
      commitBtn.disabled = true;
    }
  }

  draftEl.addEventListener("input", () => {
    refreshUI_();
    refreshFromDraftTextarea_();
  });

  if (toggleJsonBtn) {
    toggleJsonBtn.addEventListener("click", () => {
      _jsonVisible = !_jsonVisible;
      if (draftEl) draftEl.classList.toggle("is-hidden", !_jsonVisible);
      toggleJsonBtn.textContent = _jsonVisible ? "JSONを隠す" : "JSONを表示";
    });
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

      if (field === "start_time") {
        v.start_time = String(el.value || "").trim();
        v.time_hint = "fixed";
      } else if (field === "end_time") {
        v.end_time = String(el.value || "").trim();
      } else if (field === "course") {
        v.course = String(el.value || "").trim();
      } else if (field === "visit_type") {
        v.visit_type = String(el.value || "").trim();
      } else if (field === "memo") {
        v.memo = String(el.value || "");
      }
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
    const name = String(first.customer_name || "").trim();
    if (!name) {
      renderCustomerCandidates_(null);
      return;
    }
    renderCustomerCandidates_({ status: "loading", name });
    try {
      const idToken = getIdToken();
      if (!idToken) throw new Error("未ログインです。ログインし直してください。");
      const resp = await callGas({ action: "searchCustomers", query: name }, idToken);
      const { results } = unwrapResults(resp);
      let list = results || [];

      // 顧客特定ヒントがあれば、候補が複数のときだけ「一致度順」に並べ替える
      // 例: 住所の一部 / 建物名 / 電話末尾 など
      const hint = String(hintCustomerInfoEl?.value || "").trim();
      if (hint && Array.isArray(list) && list.length > 1) {
        const h = hint.toLowerCase();
        list = list
          .map((r) => {
            const addr = String(r.address_full || r.address || "").toLowerCase();
            const phone = String(r.phone || "").toLowerCase();
            const notes = String(r.notes || r.memo || "").toLowerCase();
            const score =
              (addr.includes(h) ? 3 : 0) +
              (phone.includes(h) ? 2 : 0) +
              (notes.includes(h) ? 1 : 0);
            return { r, score };
          })
          .sort((a, b) => (b.score - a.score))
          .map((x) => x.r);
      }

      renderCustomerCandidates_({ status: "loaded", name, results: list });
    } catch (e) {
      renderCustomerCandidates_({ status: "error", name, error: (e && e.message) ? e.message : String(e) });
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

    setBusy(true, "解釈しています...");
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
      _jsonVisible = false;
      if (draftEl) draftEl.classList.add("is-hidden");
      if (toggleJsonBtn) toggleJsonBtn.textContent = "JSONを表示";
      refreshUI_();
      scheduleCustomerLookup_(_draftObj);
      resultEl.innerHTML = `<div class="card"><p class="p">draftを生成しました。次に「顧客確定」を行い、必要に応じて候補を修正してから「登録実行」を押してください。</p></div>`;
    } catch (e) {
      toast({ message: (e && e.message) ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  });

  commitBtn.addEventListener("click", async () => {
    if (!_selectedCustomer) return toast({ message: "先に顧客を確定してください" });
    if (_busy) return;
    const raw = String(draftEl.value || "").trim();
    if (!raw) return;

    let draft;
    try {
      draft = JSON.parse(raw);
    } catch (e) {
      return toast({ message: "draft JSON が壊れています！JSONとして解析できません。" });
    }

    const visits = Array.isArray(draft.visits) ? draft.visits : [];
    if (!visits.length) return toast({ message: "登録候補が0件です" });

    // 二重送信防止：同一payloadの連続commitをブロック
    // ※ draftが手修正されればハッシュが変わるので再送可能
    const contentHash = await sha256Hex_(JSON.stringify({ visits }));
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
        visits: visits,
        source: "portal_register",
      }, idToken);

      const u = unwrapResults(resp);
      _lastCommitSucceeded = !!(u && u.success !== false);
      const summaryHtml = renderCommitSummary_(u);
      const msg = escapeHtml(prettyJson_(u));
      resultEl.innerHTML = `
        ${summaryHtml}
        <div class="card">
          <p class="p"><b>完了</b></p>
          <pre class="pre mono">${msg}</pre>
        </div>
      `;
      toast({ title: "完了", message: "登録処理が完了しました。結果を確認してください。" });
    } catch (e) {
      _lastCommitSucceeded = false;
      toast({ message: (e && e.message) ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  });
}
