// js/pages/register.js
import { render, qs, toast, escapeHtml, showModal } from "../ui.js";
import { callGas, unwrapResults } from "../api.js";
import { CONFIG } from "../config.js";
import { getIdToken, getUser } from "../auth.js";

function nowIsoJst_() {
  const d = new Date();
  // “表示用”でOK。厳密なTZ変換は後回し（MVP優先）
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
  if (!idToken) throw new Error("未ログインです（id_tokenがありません）。再ログインしてください。");
  const r = await callGas({ action: "issueInterpreterToken" }, idToken);
  console.log("[register] issueInterpreterToken raw response =", r);

  const raw = r && r.raw ? r.raw : r;
  console.log("[register] issueInterpreterToken =", raw);

  if (!raw || !raw.ok || !raw.token) {
    throw new Error(raw && raw.error ? raw.error : "token issuance failed");
  }

  return raw.token;
}

async function callInterpreter_(token, emailText) {
  console.log("[register] CONFIG.INTERPRETER_URL =", CONFIG.INTERPRETER_URL);
  if (!CONFIG.INTERPRETER_URL || CONFIG.INTERPRETER_URL.includes("YOUR_CLOUD_RUN_URL")) {
    throw new Error("INTERPRETER_URL is not set");
  }

  const user = getUser() || {};
  if (!user || !user.staff_id) {
    toast("スタッフ情報が取得できません。再ログインしてください。");
    return;
  }
  const staffId = user.staff_id || "";
  const staffName = user.name || "";
  const isAdmin = user.role === "admin";

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

  console.log("[register] about to POST /interpret", {
    url: CONFIG.INTERPRETER_URL,
    hasToken: !!token,
    bodyPreview: body,
  });

  const resp = await fetch(CONFIG.INTERPRETER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data && data.detail) ? data.detail : `Interpreter error (${resp.status})`);
  }
  if (!data.ok || !data.draft) throw new Error(data.error || "invalid interpreter response");
  return data;
}

function prettyJson_(obj) {
  return JSON.stringify(obj, null, 2);
}

async function sha256Hex_(text) {
  // Web Crypto API（https環境前提 / GitHub PagesでOK）
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  const bytes = Array.from(new Uint8Array(buf));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newRequestId_() {
  // GAS側 RequestLogs / 冪等設計に乗せる（再送は同一request_idを使う）
  const rid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  return `portal_register_${rid}`;
}

export function renderRegisterTab(app) {
  render(app, `
    <section class="section">
      <h1 class="h1">予約登録（draft → commit）</h1>

      <label class="label">メール本文</label>
      <textarea id="reg_email" class="textarea" rows="10" placeholder="依頼文を貼りつけ"></textarea>

      <label class="label" style="margin-top:12px;">補足（任意）</label>
      <textarea id="reg_hint" class="textarea" rows="7"
        placeholder="例：訪問日時：（12/31〜1/2）
例：訪問回数：（合計5回 / 1日2回）
例：訪問時間：（朝 / 夜 / 14時）
例：訪問タイプ：（シッティング / トレーニング / 打ち合わせ / 有料打ち合わせ）
例：メモ：（12/31：鍵はポスト返却）"
      >▼補足が必要な場合▼
顧客名：
担当者名：
訪問日時：
訪問回数：
訪問時間：
訪問タイプ：
メモ：
      </textarea>

      <div class="row">
        <button id="reg_interpret" class="btn">解釈（draft生成）</button>
        <button id="reg_commit" class="btn btn-primary" disabled>登録実行（commit）</button>
      </div>

      <p class="p text-muted">解釈結果（draft JSON）</p>
      <textarea id="reg_draft" class="textarea mono" rows="12" placeholder="解釈結果がここに入ります。必要なら手で修正できます。"></textarea>

      <div id="reg_result" class="p"></div>
    </section>
  `);

  const emailEl = qs("#reg_email");
  const hintEl  = qs("#reg_hint");
  const draftEl = qs("#reg_draft");
  const interpretBtn = qs("#reg_interpret");
  const commitBtn = qs("#reg_commit");
  const resultEl = qs("#reg_result");

  let _busy = false;

  let _lastCommitHash = "";
  let _lastCommitRequestId = "";
  let _lastCommitSucceeded = false;

  function setBusy(b) {
    _busy = b;
    interpretBtn.disabled = b;
    if (commitBtn) {
      commitBtn.disabled = b || !draftEl.value.trim();
    }
  }

  draftEl.addEventListener("input", () => {
    commitBtn.disabled = _busy || !draftEl.value.trim();
  });

  interpretBtn.addEventListener("click", async () => {
    console.log("[register] interpret button clicked");
    console.log("[register] emailEl exists =", !!emailEl);
    console.log("[register] emailEl value =", emailEl && emailEl.value);
    if (_busy) return;
    const emailText = String(emailEl.value || "").trim();
    if (!emailText) return toast({ message: "メール本文を貼り付けてください" });

    const hintText = hintEl ? String(hintEl.value || "").trim() : "";
    // 補足は「ラベルだけ」でも送る設計（あなたの狙いどおり）
    // ただし、完全空なら送らない（ユーザーが全消しした場合）
    const mergedText = hintText
      ? `${emailText}\n\n${hintText}\n`
      : emailText;

    setBusy(true);
    resultEl.innerHTML = "";

    try {
      console.log("[register] step1: before fetchInterpreterToken_");
      const token = await fetchInterpreterToken_();
      console.log("[register] step2: token issued len=", String(token || "").length);

      console.log("[register] step3: before callInterpreter_");
      const data = await callInterpreter_(token, mergedText);
      console.log("[register] step4: callInterpreter_ ok=", !!(data && data.ok));

      draftEl.value = prettyJson_(data.draft);

      const warnings = (data.draft && data.draft.warnings) || [];
      if (warnings.length) {
        const w = escapeHtml(prettyJson_(warnings));
        resultEl.innerHTML = `<div class="card"><p class="p text-danger">注意</p><pre class="pre mono">${w}</pre></div>`;
      } else {
        resultEl.innerHTML = `<div class="card"><p class="p">draftを生成しました。必要なら修正してから「登録実行」を押してください。</p></div>`;
      }

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
      return toast({ message: "draft JSON が壊れています（JSONとして解析できません）" });
    }

    const visits = Array.isArray(draft.visits) ? draft.visits : [];
    if (!visits.length) return toast({ message: "登録候補が0件です" });

    // 二重送信防止（同一payloadの連続commitをブロック）
    // ※ draftが手修正されればハッシュが変わるので再送可能
    const contentHash = await sha256Hex_(JSON.stringify({ visits }));
    if (_lastCommitSucceeded && _lastCommitHash && _lastCommitHash === contentHash) {
      return toast({ message: "同じ内容の登録はすでに実行済みです（二重送信防止）" });
    }

    // confirm modal（誤操作防止）
    const ok = await showModal({
      title: "登録実行の確認",
      body: `この内容で ${visits.length} 件を登録します。実行してよいですか？`,
      okText: "実行",
      cancelText: "キャンセル",
    });
    if (!ok) return;

    setBusy(true);
    resultEl.innerHTML = "";

    try {
      // 再送（通信失敗時など）は同一 request_id を維持する
      if (!_lastCommitRequestId || _lastCommitHash !== contentHash) {
        _lastCommitRequestId = newRequestId_();
      }
      _lastCommitHash = contentHash;

      const resp = await callGas({
        action: "bulkRegisterVisits",
        request_id: _lastCommitRequestId,
        content_hash: _lastCommitHash,
        visits: visits,
        source: "portal_register",
      });

      const u = unwrapResults(resp);
      _lastCommitSucceeded = !!(u && u.success !== false);
      const msg = escapeHtml(prettyJson_(u));
      resultEl.innerHTML = `
        <div class="card">
          <p class="p"><b>完了</b></p>
          <pre class="pre mono">${msg}</pre>
        </div>
      `;
      toast({ title: "完了", message: "登録処理が完了しました（結果を確認してください）" });
    } catch (e) {
      _lastCommitSucceeded = false;
      toast({ message: (e && e.message) ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  });
}

