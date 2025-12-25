// js/api.js
import { CONFIG } from "./config.js";

function newRequestId() {
  return "web_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * GAS WebApp にJSON POST
 * @param {object} payload
 * @param {string} idToken
 */
export async function callGas(payload, idToken) {
  if (!CONFIG.GAS_WEBAPP_URL || CONFIG.GAS_WEBAPP_URL.includes("PUT_YOUR_")) {
    throw new ApiError("GAS_WEBAPP_URL が未設定です。config.js を確認してください。");
  }
  if (!idToken) {
    throw new ApiError("未ログインです（id_tokenがありません）。");
  }

  const body = {
    request_id: newRequestId(),
    id_token: idToken,
    ...payload,
  };

  const resp = await fetch(CONFIG.GAS_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  let json = null;
  try { json = JSON.parse(text); }
  catch (e) {
    throw new ApiError("GAS応答のJSON解析に失敗しました。", { status: resp.status, detail: text });
  }

  if (!resp.ok) {
    throw new ApiError(`HTTP ${resp.status}`, { status: resp.status, detail: json });
  }
  if (json && json.ok === false) {
    throw new ApiError(json.error || "GASでエラーが発生しました。", { status: resp.status, detail: json });
  }

  return json;
}

// callGas の返却が「配列 or オブジェクト」どちらでも動かす
export function unwrapResults(res) {
  if (Array.isArray(res)) return { results: res, ctx: null, raw: res };
  const results = (res && (res.results || res.visits || res.data)) || [];
  const ctx = (res && res.ctx) || null;
  return { results, ctx, raw: res };
}
