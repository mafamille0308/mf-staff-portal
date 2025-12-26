// js/auth.js
import { CONFIG } from "./config.js";
import { toast } from "./ui.js";

let _idToken = "";
let _user = null; // { email, role, staff_id, name? } をGASから返す想定に対応

/**
 * id_token を sessionStorage に保存・復元
 */
const KEY_ID_TOKEN = "mf_id_token";

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

export function setIdToken(idToken) {
  const t = String(idToken || "").trim();
  if (!t) return;
  _idToken = t;
  sessionStorage.setItem(KEY_ID_TOKEN, t);
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
}

export function getUser() { return _user; }

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

  // GIS の初期化
  window.google?.accounts?.id?.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    callback: (resp) => {
      const token = resp && resp.credential;
      if (!token) {
        toast({ title: "ログイン失敗", message: "credential が取得できませんでした。" });
        return;
      }

      setIdToken(token); // 永続化

      toast({ title: "ログイン完了", message: "認証トークンを取得しました。" });
      if (typeof onLogin === "function") onLogin(token);
    },
  });

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

  window.google?.accounts?.id?.renderButton(
    document.getElementById(btnHostId),
    {
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
      width: 320,
    }
  );
}

/**
 * GAS側が返す ctx などでユーザー表示を更新する用途
 * @param {object} user
 */
export function setUser(user) {
  _user = user || null;
}
