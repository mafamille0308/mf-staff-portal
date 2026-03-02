// js/auth.js
import { CONFIG } from "./config.js";
import { toast } from "./ui.js";

let _idToken = "";
let _user = null; // { email, role, staff_id, name? } をGASから返す想定に対応

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

/**
 * GIS 初期化：ログインボタンを描画し、id_token を取得
 * note: ボタンは任意のcontainerへ描画
 */
export function initGoogleLogin({ containerId = "app", onLogin } = {}) {
  if (!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.includes("PUT_YOUR_")) {
    toast({ title: "設定不足", message: "GOOGLE_CLIENT_ID が未設定です。config.js を確認してください。" });
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) return;

  // ボタン描画（都度再描画してOK）
  const btnHostId = "gisBtnHost";
  container.innerHTML = `
    <section class="section">
      <h1 class="h1">ログイン</h1>
      <p class="p">Googleアカウントでログインしてください。</p>
      <div class="hr"></div>
      <div id="${btnHostId}"></div>
    </section>
  `;

  (async () => {
    const ready = await _waitForGisReady({ timeoutMs: 8000, intervalMs: 50 });
    if (!ready) {
      toast({ title: "ログイン準備中", message: "ログイン機能の読み込みに失敗しました。更新して再試行してください。" });
      return;
    }

    // GIS の初期化
    window.google.accounts.id.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      callback: (resp) => {
        const token = resp && resp.credential;
        if (!token) {
          toast({ title: "ログイン失敗", message: "credential が取得できませんでした。" });
          return;
        }

        // NOTE: ここでは token を保存しない（= ログイン成立させない）。
        // GAS側で Staffs.login_email に登録済みか（在籍/有効か）を確認し、
        // OK のときだけ setIdToken する。
        toast({ title: "認可確認中", message: "アカウント権限を確認しています…" });

        (async () => {
          try {
            // 循環import回避（api.js は auth.js を参照しているため動的import）
            const mod = await import("./api.js");
            const callGas = mod && mod.callGas;
            if (typeof callGas !== "function") throw new Error("callGas is not available");

            const res = await callGas({ action: "getMe" }, token);
            if (!res || res.success === false) {
              throw new Error((res && (res.error || res.message)) || "Not authorized");
            }

            // OK：ここで初めてログイン確定
            setIdToken(token);
            toast({ title: "ログイン完了", message: "ログインしました。" });
            if (typeof onLogin === "function") onLogin(token);
          } catch (e) {
            // NG：保存しない（= 未ログインのまま）
            try { clearIdToken(); } catch (_) {}
            toast({
              title: "ログイン不可",
              message: "このアカウントは利用許可がありません。"
            });
          }
        })();
      },
    });

    // ボタン描画
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
      window.google.accounts.id.renderButton(
        document.getElementById(btnHostId),
        {
          theme: "filled_blue",
          size: "large",
          text: "signin",
          shape: "rectangular",
        }
      );
    }
  })();
}

/**
 * GAS側が返す ctx などでユーザー表示を更新する用途
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
