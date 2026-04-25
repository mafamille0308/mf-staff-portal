// js/auth.js
import { CONFIG } from "./config.js";
import { toast } from "./ui.js";

let _idToken = "";
let _user = null; // { email, role, staff_id, name? } をAPI応答のctxに合わせて保持
let _gisInitialized = false;
let _gisOnLogin = null;
let _passkeyAutoLoginTried = false;

/**
 * id_token / ctx を sessionStorage に保存・復元
 */
const KEY_ID_TOKEN = "mf_id_token";
const KEY_USER = "mf_user_ctx";

// JWT(exp)を読み、有効期限切れを判定する
function _parseJwtPayload(idToken) {
  try {
    const s = String(idToken || "");
    const parts = s.split(".");
    if (parts.length < 2) return null;
    // base64url -> base64
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    // padding
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const json = atob(b64 + pad);
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function _isExpiredIdToken(idToken, skewSeconds = 60) {
  const s = String(idToken || "");
  const parts = s.split(".");
  if (parts.length !== 3) return false; // portal session token (passkey) はサーバー401で失効判定
  const p = _parseJwtPayload(idToken);
  const exp = p && Number(p.exp);
  if (!exp) return true; // expが読めないtokenは安全側で失効扱い
  const now = Math.floor(Date.now() / 1000);
  return exp <= (now + skewSeconds);
}

// GIS (Google Identity Services) のロード待ち
function _waitForGisReady({ timeoutMs = 8000, intervalMs = 50 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const ok = !!(window.google && window.google.accounts && window.google.accounts.id);
      if (ok) return resolve(true);
      if ((Date.now() - t0) >= timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function setIdToken(idToken) {
  const t = String(idToken || "").trim();
  if (!t) return;
  _idToken = t;
  sessionStorage.setItem(KEY_ID_TOKEN, t);
  // ログイン状態変化を通知（router / pages 側の再描画トリガー）
  window.dispatchEvent(new CustomEvent("mf:auth:changed", { detail: { authed: true } }));
}

export function getIdToken() {
  const t = String(sessionStorage.getItem(KEY_ID_TOKEN) || "").trim();
  if (!t) return "";
  // 期限切れ（または期限間近）なら破棄して未ログイン扱いにする
  if (_isExpiredIdToken(t, 60)) {
    clearIdToken();
    return "";
  }
  if (t && !_idToken) _idToken = t; // 復元時にメモリも同期
  return t;
}

export function clearIdToken() {
  _idToken = "";
  sessionStorage.removeItem(KEY_ID_TOKEN);
  _user = null;
  sessionStorage.removeItem(KEY_USER);
  _passkeyAutoLoginTried = false;
  // ログイン状態変化を通知
  window.dispatchEvent(new CustomEvent("mf:auth:changed", { detail: { authed: false } }));
}

export function getUser() {
  if (_user) return _user;
  try {
    const raw = sessionStorage.getItem(KEY_USER);
    if (!raw) return null;
    _user = JSON.parse(raw);
    return _user;
  } catch (e) {
    return null;
  }
}

export function isAuthed() {
  return !!getIdToken();
}

function _toBase64urlFromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf || new ArrayBuffer(0));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function _toArrayBufferFromBase64url(b64url) {
  const s = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const binary = atob(s + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

function _normalizeCreationOptions_(options) {
  const next = Object.assign({}, options || {});
  next.challenge = _toArrayBufferFromBase64url(next.challenge);
  if (next.user && next.user.id) next.user.id = _toArrayBufferFromBase64url(next.user.id);
  const excludes = Array.isArray(next.excludeCredentials) ? next.excludeCredentials : [];
  next.excludeCredentials = excludes.map((cred) => {
    const item = Object.assign({}, cred || {});
    item.id = _toArrayBufferFromBase64url(item.id);
    return item;
  });
  return next;
}

function _normalizeRequestOptions_(options) {
  const next = Object.assign({}, options || {});
  next.challenge = _toArrayBufferFromBase64url(next.challenge);
  const allows = Array.isArray(next.allowCredentials) ? next.allowCredentials : [];
  next.allowCredentials = allows.map((cred) => {
    const item = Object.assign({}, cred || {});
    item.id = _toArrayBufferFromBase64url(item.id);
    return item;
  });
  return next;
}

function _serializeCredential_(credential) {
  if (!credential) return null;
  const c = credential;
  return {
    id: String(c.id || ""),
    rawId: _toBase64urlFromArrayBuffer(c.rawId),
    type: String(c.type || "public-key"),
    response: {
      clientDataJSON: _toBase64urlFromArrayBuffer(c.response?.clientDataJSON),
      attestationObject: c.response?.attestationObject
        ? _toBase64urlFromArrayBuffer(c.response.attestationObject)
        : undefined,
      authenticatorData: c.response?.authenticatorData
        ? _toBase64urlFromArrayBuffer(c.response.authenticatorData)
        : undefined,
      signature: c.response?.signature
        ? _toBase64urlFromArrayBuffer(c.response.signature)
        : undefined,
      userHandle: c.response?.userHandle
        ? _toBase64urlFromArrayBuffer(c.response.userHandle)
        : undefined,
      transports: typeof c.response?.getTransports === "function" ? c.response.getTransports() : undefined,
    },
    clientExtensionResults: typeof c.getClientExtensionResults === "function"
      ? c.getClientExtensionResults()
      : {},
    authenticatorAttachment: c.authenticatorAttachment || undefined,
  };
}

function _escapeAttr_(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function _sendPasskeyClientLog_(idToken, payload) {
  try {
    const mod = await import("./pages/portal_api.js");
    const fn = mod && mod.portalPasskeyClientLog_;
    if (typeof fn !== "function") return;
    await fn(idToken || "", payload || {});
  } catch (_) {
  }
}

function _authClientLogMeta_() {
  return {
    user_agent: String(navigator.userAgent || ""),
    href: String(location.href || ""),
    origin: String(location.origin || ""),
    google_client_id: String(CONFIG.GOOGLE_CLIENT_ID || ""),
    is_secure_context: !!window.isSecureContext,
    has_focus: !!document.hasFocus(),
    hidden: !!document.hidden,
  };
}

function _logGisClientEvent_(phase, meta = {}, errorName = "", errorMessage = "") {
  _sendPasskeyClientLog_("", {
    phase: String(phase || "gis_unknown"),
    error_name: String(errorName || ""),
    error_message: String(errorMessage || ""),
    meta: Object.assign({}, _authClientLogMeta_(), meta || {}),
  });
}

async function _waitForDocumentFocus_({ timeoutMs = 4000 } = {}) {
  if (!document.hidden && document.hasFocus()) return true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      window.removeEventListener("focus", onFocus, true);
      document.removeEventListener("visibilitychange", onVisibility, true);
      if (timer) clearTimeout(timer);
      resolve(!!ok);
    };
    const onFocus = () => {
      if (!document.hidden && document.hasFocus()) finish(true);
    };
    const onVisibility = () => {
      if (!document.hidden && document.hasFocus()) finish(true);
    };
    const timer = setTimeout(() => finish(false), Math.max(500, Number(timeoutMs || 0)));
    window.addEventListener("focus", onFocus, true);
    document.addEventListener("visibilitychange", onVisibility, true);
  });
}

async function _ensurePasskeyRegistered_(authToken, meRes, opts = {}) {
  const force = !!(opts && opts.force);
  const ctx = meRes && meRes.ctx ? meRes.ctx : null;
  const hasPasskey = !!(ctx && ctx.passkey_registered);
  if (hasPasskey && !force) return;
  if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) return;
  const shouldRegister = window.confirm("この端末にパスキーを登録しますか？\n次回から顔/指紋/PINでログインできます。");
  if (!shouldRegister) return;
  const mod = await import("./pages/portal_api.js");
  const getOptions = mod && mod.portalPasskeyRegisterOptions_;
  const verify = mod && mod.portalPasskeyRegisterVerify_;
  if (typeof getOptions !== "function" || typeof verify !== "function") {
    throw new Error("passkey registration api unavailable");
  }
  const optionsRes = await getOptions(authToken);
  const challengeId = String(optionsRes?.challenge_id || "").trim();
  const options = optionsRes && optionsRes.options;
  if (!challengeId || !options) throw new Error("passkey register options invalid");
  const publicKey = _normalizeCreationOptions_(options);
  const focused = await _waitForDocumentFocus_({ timeoutMs: 5000 });
  if (!focused) {
    await _sendPasskeyClientLog_(authToken, {
      phase: "register_focus_precheck",
      error_name: "NotFocusedBeforeCreate",
      error_message: "The document is not focused before passkey create.",
      meta: {
        is_secure_context: !!window.isSecureContext,
        has_focus: !!document.hasFocus(),
        hidden: !!document.hidden,
      },
    });
  }
  let created = null;
  try {
    created = await navigator.credentials.create({ publicKey });
  } catch (e) {
    const errName = String(e?.name || "Error").trim();
    const errMsg = String(e?.message || "").trim();
    const shouldRetryFocus = errName === "NotAllowedError" && /not focused/i.test(errMsg);
    if (shouldRetryFocus) {
      const regained = await _waitForDocumentFocus_({ timeoutMs: 5000 });
      if (regained) {
        try {
          created = await navigator.credentials.create({ publicKey });
        } catch (retryErr) {
          const rn = String(retryErr?.name || "Error").trim();
          const rm = String(retryErr?.message || "").trim();
          await _sendPasskeyClientLog_(authToken, {
            phase: "register_create_retry",
            error_name: rn,
            error_message: rm,
            meta: {
              is_secure_context: !!window.isSecureContext,
              has_focus: !!document.hasFocus(),
              hidden: !!document.hidden,
            },
          });
          throw new Error(`${rn}${rm ? `: ${rm}` : ""}`);
        }
      }
    }
    if (created) {
      // retry 成功時は以降の処理へ進む
    } else {
    await _sendPasskeyClientLog_(authToken, {
      phase: "register_create",
      error_name: errName,
      error_message: errMsg,
      meta: {
        is_secure_context: !!window.isSecureContext,
        has_focus: !!document.hasFocus(),
        hidden: !!document.hidden,
        user_agent: String(navigator.userAgent || ""),
      },
    });
    throw new Error(`${errName}${errMsg ? `: ${errMsg}` : ""}`);
    }
  }
  if (!created) throw new Error("passkey create canceled");
  const credential = _serializeCredential_(created);
  const verifyRes = await verify(authToken, { challenge_id: challengeId, credential });
  if (!verifyRes || verifyRes.success === false) {
    await _sendPasskeyClientLog_(authToken, {
      phase: "register_verify",
      error_name: "VerifyFailed",
      error_message: String((verifyRes && (verifyRes.error || verifyRes.message)) || "passkey registration failed"),
      meta: {
        challenge_id: challengeId,
      },
    });
    throw new Error("passkey registration failed");
  }
  toast({ title: "登録完了", message: "この端末のパスキーを登録しました。" });
}

async function _ensurePasskeyRegisteredWithTap_(authToken, meRes, container) {
  const ctx = meRes && meRes.ctx ? meRes.ctx : null;
  const alreadyRegistered = !!(ctx && ctx.passkey_registered);
  const host = container || document.getElementById("app");
  if (!host) {
    await _ensurePasskeyRegistered_(authToken, meRes, { force: alreadyRegistered });
    return;
  }
  const guideText = alreadyRegistered
    ? "この端末にもパスキーを追加登録できます。"
    : "この端末にパスキーを登録してください。";
  const setupLabel = alreadyRegistered
    ? "この端末でパスキーを追加登録"
    : "この端末でパスキーを作成";
  const appNameAttr = _escapeAttr_(String(CONFIG.APP_NAME || "MF Staff Portal"));
  host.innerHTML = `
    <section class="section">
      <div style="position:relative;min-height:58vh;">
        <div id="postGisBrandIcon" style="width:min(72vw,280px);height:92px;margin:8px auto 0;display:flex;align-items:center;justify-content:center;">
          <img src="./assets/images/auth/recovery-logo.png" alt="${appNameAttr}" style="max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;" />
        </div>
        <div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;">
          <p class="p" style="text-align:center;margin:0;">${guideText}</p>
          <button id="btnPasskeySetup" class="btn" type="button">${setupLabel}</button>
          <button id="btnPasskeySkip" class="btn btn-ghost" type="button">あとで登録</button>
        </div>
      </div>
    </section>
  `;
  await new Promise((resolve) => {
    const setupBtn = document.getElementById("btnPasskeySetup");
    const skipBtn = document.getElementById("btnPasskeySkip");
    const finish = () => resolve();
    if (setupBtn) {
      setupBtn.addEventListener("click", async () => {
        try {
          await _ensurePasskeyRegistered_(authToken, meRes, { force: alreadyRegistered });
        } catch (e) {
          console.error("[passkey/register/tap] failed", e);
          const msg = String(e?.message || e || "").trim();
          toast({ title: "パスキー登録未完了", message: msg || "パスキー登録に失敗しました。" });
        } finally {
          finish();
        }
      }, { once: true });
    }
    if (skipBtn) {
      skipBtn.addEventListener("click", finish, { once: true });
    }
  });
}

async function _loginWithPasskey_() {
  if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) {
    throw new Error("この端末ではパスキーを利用できません。");
  }
  const mod = await import("./pages/portal_api.js");
  const getOptions = mod && mod.portalPasskeyLoginOptions_;
  const verify = mod && mod.portalPasskeyLoginVerify_;
  if (typeof getOptions !== "function" || typeof verify !== "function") {
    throw new Error("passkey login api unavailable");
  }
  const optionsRes = await getOptions();
  const challengeId = String(optionsRes?.challenge_id || "").trim();
  const options = optionsRes && optionsRes.options;
  if (!challengeId || !options) throw new Error("passkey options invalid");
  const publicKey = _normalizeRequestOptions_(options);
  const assertion = await navigator.credentials.get({ publicKey });
  if (!assertion) throw new Error("passkey assertion canceled");
  const credential = _serializeCredential_(assertion);
  const verifyRes = await verify({ challenge_id: challengeId, credential });
  if (!verifyRes || verifyRes.success === false || !verifyRes.token) {
    throw new Error((verifyRes && (verifyRes.error || verifyRes.message)) || "passkey verify failed");
  }
  setIdToken(String(verifyRes.token));
  if (verifyRes.ctx) setUser(verifyRes.ctx);
  toast({ title: "ログイン完了", message: "パスキーでログインしました。" });
  if (typeof _gisOnLogin === "function") _gisOnLogin(String(verifyRes.token));
}

/**
 * パスキー優先 + GIS回復ログイン画面を描画
 * note: ボタンは任意のcontainerへ描画
 */
export function initGoogleLogin({ containerId = "app", onLogin } = {}) {
  if (!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.includes("PUT_YOUR_")) {
    toast({ title: "設定不足", message: "GOOGLE_CLIENT_ID が未設定です。config.js を確認してください。" });
    return;
  }
  _gisOnLogin = onLogin;

  const container = document.getElementById(containerId);
  if (!container) return;

  const btnHostId = "gisBtnHost";
  const AUTO_PASSKEY_TIMEOUT_MS = 20000;

  function renderAutoPasskeyScreen_() {
    container.innerHTML = `
      <section class="section">
        <div style="display:flex;justify-content:center;align-items:center;width:88px;height:88px;margin:8px auto 12px;border-radius:999px;background:#f2f4f7;font-size:36px;">🔐</div>
        <h1 class="h1" style="text-align:center;">ログイン中</h1>
        <p class="p" style="text-align:center;">パスキー認証を開始しています…</p>
      </section>
    `;
  }

  async function renderGisRecoveryScreen_() {
    const appNameAttr = _escapeAttr_(String(CONFIG.APP_NAME || "MF Staff Portal"));
    container.innerHTML = `
      <section class="section">
        <div style="position:relative;min-height:58vh;">
          <div id="recoveryBrandIcon" style="width:min(72vw,280px);height:92px;margin:8px auto 0;display:flex;align-items:center;justify-content:center;">
            <img src="./assets/images/auth/recovery-logo.png" alt="${appNameAttr}" style="max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;" />
          </div>
          <div id="${btnHostId}" style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;justify-content:center;width:100%;"></div>
        </div>
      </section>
    `;

    const ready = await _waitForGisReady({ timeoutMs: 8000, intervalMs: 50 });
    if (!ready) {
      _logGisClientEvent_("gis_load_timeout");
      toast({ title: "ログイン準備中", message: "ログイン機能の読み込みに失敗しました。更新して再試行してください。" });
      return;
    }

    if (!_gisInitialized) {
      // GIS の初期化はページライフサイクルで1回だけ行う
      try {
        window.google.accounts.id.initialize({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          callback: (resp) => {
            const token = resp && resp.credential;
            if (!token) {
              _logGisClientEvent_("gis_callback_missing_credential", {
                select_by: String(resp?.select_by || ""),
              });
              toast({ title: "ログイン失敗", message: "credential が取得できませんでした。" });
              return;
            }

            // NOTE: ここでは token を保存しない（= ログイン成立させない）。
            // API側で Staffs.login_email に登録済みか（在籍/有効か）を確認し、
            // OK のときだけ setIdToken する。
            toast({ title: "認可確認中", message: "アカウント権限を確認しています…" });

            (async () => {
              try {
                // 循環import回避（api.js は auth.js を参照しているため動的import）
                const mod = await import("./pages/portal_api.js");
                const portalMe_ = mod && mod.portalMe_;
                if (typeof portalMe_ !== "function") throw new Error("portalMe_ is not available");

                const res = await portalMe_(token);
                if (!res || res.success === false) {
                  throw new Error((res && (res.error || res.message)) || "Not authorized");
                }

                await _ensurePasskeyRegisteredWithTap_(token, res, container);
                // OK：パスキー案内表示後にログイン確定
                setIdToken(token);
                if (res && res.ctx) setUser(res.ctx);
                toast({ title: "ログイン完了", message: "ログインしました。" });
                if (typeof _gisOnLogin === "function") _gisOnLogin(token);
              } catch (e) {
                let detailMsg = "";
                try {
                  const d = e && e.detail;
                  const r = d && d.response;
                  detailMsg = String((r && (r.error || r.operator_message || r.message)) || e?.message || "").trim();
                } catch (_) {}
                _logGisClientEvent_("gis_portal_me_failed", {}, String(e?.name || "Error"), String(detailMsg || e?.message || ""));
                // NG：保存しない（= 未ログインのまま）
                try { clearIdToken(); } catch (_) {}
                toast({
                  title: "ログイン不可",
                  message: detailMsg || "このアカウントは利用許可がありません。"
                });
              }
            })();
          },
        });
        _gisInitialized = true;
      } catch (e) {
        _logGisClientEvent_("gis_initialize_failed", {}, String(e?.name || "Error"), String(e?.message || ""));
        toast({ title: "ログイン準備中", message: "Googleログインの初期化に失敗しました。" });
        return;
      }
    }

    try {
      window.google.accounts.id.renderButton(
        document.getElementById(btnHostId),
        {
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
          width: 320,
        }
      );
    } catch (e) {
      _logGisClientEvent_("gis_render_primary_failed", {}, String(e?.name || "Error"), String(e?.message || ""));
      try {
        window.google.accounts.id.renderButton(
          document.getElementById(btnHostId),
          {
            theme: "filled_blue",
            size: "large",
            text: "signin",
            shape: "rectangular",
          }
        );
      } catch (fallbackErr) {
        _logGisClientEvent_("gis_render_fallback_failed", {}, String(fallbackErr?.name || "Error"), String(fallbackErr?.message || ""));
      }
    }
    try {
      window.google.accounts.id.prompt((notification) => {
        const isNotDisplayed = !!(notification && typeof notification.isNotDisplayed === "function" && notification.isNotDisplayed());
        const isSkipped = !!(notification && typeof notification.isSkippedMoment === "function" && notification.isSkippedMoment());
        const isDismissed = !!(notification && typeof notification.isDismissedMoment === "function" && notification.isDismissedMoment());
        if (!isNotDisplayed && !isSkipped && !isDismissed) return;
        let reason = "";
        let moment = "";
        if (isNotDisplayed) {
          moment = "not_displayed";
          reason = notification && typeof notification.getNotDisplayedReason === "function"
            ? String(notification.getNotDisplayedReason() || "")
            : "";
        } else if (isSkipped) {
          moment = "skipped";
          reason = notification && typeof notification.getSkippedReason === "function"
            ? String(notification.getSkippedReason() || "")
            : "";
        } else if (isDismissed) {
          moment = "dismissed";
          reason = notification && typeof notification.getDismissedReason === "function"
            ? String(notification.getDismissedReason() || "")
            : "";
        }
        _logGisClientEvent_("gis_prompt_moment", { moment }, reason || "GISPromptMoment", "");
      });
    } catch (promptErr) {
      _logGisClientEvent_("gis_prompt_failed", {}, String(promptErr?.name || "Error"), String(promptErr?.message || ""));
    }
  }

  (async () => {
    if (_passkeyAutoLoginTried) {
      await renderGisRecoveryScreen_();
      return;
    }
    renderAutoPasskeyScreen_();
    _passkeyAutoLoginTried = true;
    const autoRun = _loginWithPasskey_();
    const timeoutRun = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("passkey auto timeout")), AUTO_PASSKEY_TIMEOUT_MS);
    });
    try {
      await Promise.race([autoRun, timeoutRun]);
    } catch (_) {
      await renderGisRecoveryScreen_();
    }
    autoRun.catch((e) => {
      console.info("[passkey/auto-login] completed after fallback", e);
    });
  })();
}

/**
 * API側が返す ctx などでユーザー表示を更新する用途
 * @param {object} user
 */
export function setUser(user) {
  _user = user || null;
  try {
    if (_user) sessionStorage.setItem(KEY_USER, JSON.stringify(_user));
    else sessionStorage.removeItem(KEY_USER);
  } catch (e) {
  }
}
