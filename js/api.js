// js/api.js
import { CONFIG } from "./config.js";
import { setUser, clearIdToken } from "./auth.js";

function newRequestId() {
  return "web_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.request_id = (detail && detail.request_id) ? String(detail.request_id) : "";
  }
}

export async function callCloudRunPortal(path, payload, idToken) {
  if (!CONFIG.BILLING_CLOUDRUN_URL || CONFIG.BILLING_CLOUDRUN_URL.includes("PUT_YOUR_")) {
    throw new ApiError("BILLING_CLOUDRUN_URL が未設定です。config.js を確認してください。");
  }
  if (!idToken) {
    throw new ApiError("未ログインです（id_tokenがありません）。");
  }
  const rid = (payload && payload.request_id) ? String(payload.request_id) : newRequestId();
  const body = Object.assign({ request_id: rid, id_token: idToken }, payload || {});
  const resp = await fetch(`${String(CONFIG.BILLING_CLOUDRUN_URL || "").replace(/\/+$/, "")}${String(path || "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); }
  catch (_) {
    throw new ApiError("Cloud Run応答のJSON解析に失敗しました。", {
      status: resp.status,
      detail: { request_id: rid, raw_text: text },
    });
  }
  if (!resp.ok || (json && json.ok === false)) {
    const msg = String((json && (json.error || json.operator_message)) || `HTTP ${resp.status}`);
    if (msg.includes("id_token") || resp.status === 401) {
      clearIdToken();
      throw new ApiError("認証の有効期限が切れました。再ログインしてください。", {
        status: resp.status,
        detail: { request_id: rid, response: json },
      });
    }
    throw new ApiError(msg, {
      status: resp.status,
      detail: { request_id: rid, response: json },
    });
  }
  return json;
}

// API返却が「配列 or オブジェクト」どちらでも動かす
export function unwrapResults(res) {
  if (Array.isArray(res)) return { results: res, ctx: null, raw: res };
  const results = (res && (res.results || res.visits || res.data)) || [];
  const ctx = (res && res.ctx) || null;

  try {
    if (ctx) setUser(ctx);
  } catch (_) {}

  return { results, ctx, raw: res };
}

export function unwrapOne(res) {
  if (!res) return null;
  return res.visit || res.result || res.data || null;
}
