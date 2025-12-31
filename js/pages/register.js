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
  const staffName = user.name || "";
  const isAdmin = user.role === "admin";

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
      staff_id: isAdmin ? "" : staffId,
      staff_name: isAdmin ? "" : staffName,
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
          <div class="hint-label">ペット情報：</div>
          <input id="reg_hint_pet" class="input" placeholder="例：犬（柴） / ぽち / 8kg" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問日時：</div>
          <input id="reg_hint_date" class="input" placeholder="例：3/2 午前 / 3/3 14:00 など" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問回数：</div>
          <input id="reg_hint_count" class="input" placeholder="例：合計3回 / 1日2回" />
        </div>
        <div class="hint-row">
          <div class="hint-label">訪問時間：</div>
          <input id="reg_hint_time" class="input" placeholder="例：朝 / 夕方 / 14時など" />
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

      <div class="row">
        <button id="reg_interpret" class="btn">解釈（draft生成）</button>
        <button id="reg_commit" class="btn btn-primary" disabled>登録実行（commit）</button>
      </div>

      <p class="p text-muted">解釈結果は draft JSON とプレビューで確認できます。</p>
      <textarea id="reg_draft" class="textarea mono" rows="12" placeholder="解釈結果がここに入ります。不要なら手で修正できます。"></textarea>

      <div id="reg_warnings" class="is-hidden"></div>
      <div id="reg_preview" class="is-hidden"></div>
      <div id="reg_customer_candidates" class="is-hidden"></div>

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
  const hintPetEl = qs("#reg_hint_pet");
  const hintDateEl = qs("#reg_hint_date");
  const hintCountEl = qs("#reg_hint_count");
  const hintTimeEl = qs("#reg_hint_time");
  const hintTypeEl = qs("#reg_hint_type");
  const hintMemoEl = qs("#reg_hint_memo");
  const draftEl = qs("#reg_draft");
  const interpretBtn = qs("#reg_interpret");
  const commitBtn = qs("#reg_commit");
  const resultEl = qs("#reg_result");
  const warningsEl = qs("#reg_warnings");
  const previewEl = qs("#reg_preview");
  const customerCandidatesEl = qs("#reg_customer_candidates");
  const overlayEl = qs("#reg_overlay");
  const overlayTextEl = qs("#reg_overlay_text");

  let _busy = false;
  let _customerLookupTimer = null;

  let _lastCommitHash = "";
  let _lastCommitRequestId = "";
  let _lastCommitSucceeded = false;

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
      const time = escapeHtml([v.start_time || "", v.end_time || ""].filter(Boolean).join(" - "));
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
      return `
        <div class="candidate-row">
          <div class="candidate-title">#${idx + 1} ${escapeHtml(name || "(名称不明)")}</div>
          <div class="candidate-meta text-muted text-sm">
            ${id ? `ID: ${escapeHtml(id)} ` : ""}
            ${kana ? ` / ${escapeHtml(kana)}` : ""}
          </div>
          ${memo ? `<div class="candidate-memo text-sm">${escapeHtml(memo)}</div>` : ""}
        </div>
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
  }

  function buildHintText_() {
    const hints = [
      { label: "顧客名", el: hintCustomerEl },
      { label: "ペット情報", el: hintPetEl },
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
    return `▼補足が必要な場合▼\n${lines.join("\n")}`;
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
    const { draft, error } = parseDraftFromTextarea_();
    if (error) {
      renderPreview_(null);
      renderWarnings_([]);
      renderCustomerCandidates_(null);
      return;
    }
    renderWarnings_(draft?.warnings || []);
    renderPreview_(draft);
    scheduleCustomerLookup_(draft);
  }

  draftEl.addEventListener("input", () => {
    commitBtn.disabled = _busy || !draftEl.value.trim();
    refreshFromDraftTextarea_();
  });

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
      renderCustomerCandidates_({ status: "loaded", name, results: results || [] });
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
      const data = await callInterpreter_(token, mergedText);
      console.log("[register] step4: callInterpreter_ ok=", !!(data && data.ok));

      draftEl.value = prettyJson_(data.draft);

      const warnings = (data.draft && data.draft.warnings) || [];
      renderWarnings_(warnings);
      renderPreview_(data.draft);
      scheduleCustomerLookup_(data.draft);
      resultEl.innerHTML = `<div class="card"><p class="p">draftを生成しました。不要なら修正してから「登録実行」を押してください。</p></div>`;
      commitBtn.disabled = false;
    } catch (e) {
      toast({ message: (e && e.message) ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  });

  commitBtn.addEventListener("click", async () => {
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
      const msg = escapeHtml(prettyJson_(u));
      resultEl.innerHTML = `
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
