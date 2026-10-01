// js/config.js
const DEFAULT_CONFIG = {
  // テスト："https://calendar-webhook-721404541012.asia-northeast1.run.app"
  // 本番："https://mf-portal-api-prod-721404541012.asia-northeast1.run.app"
  BILLING_CLOUDRUN_URL: "https://mf-portal-api-prod-721404541012.asia-northeast1.run.app",

  // GIS クライアントID（Webアプリ）
  GOOGLE_CLIENT_ID: "721404541012-sdsefklaglk2801a7qai38ooslon2gj3.apps.googleusercontent.com",

  // 画面表示用（必要なら）
  APP_NAME: "PET SITTER APP",
};

export const CONFIG = { ...DEFAULT_CONFIG };

let _runtimeConfigReady = false;

function toStr_(v) {
  return String(v == null ? "" : v).trim();
}

function asRecord_(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function mergeConfig_(src) {
  const raw = asRecord_(src);
  const o = raw.config && typeof raw.config === "object" ? asRecord_(raw.config) : raw;
  const nextBaseUrl = toStr_(o.BILLING_CLOUDRUN_URL || o.api_base_url);
  const nextGoogleClientId = toStr_(o.GOOGLE_CLIENT_ID || o.google_client_id);
  const nextAppName = toStr_(o.APP_NAME || o.app_name);
  if (nextBaseUrl) CONFIG.BILLING_CLOUDRUN_URL = nextBaseUrl;
  if (nextGoogleClientId) CONFIG.GOOGLE_CLIENT_ID = nextGoogleClientId;
  if (nextAppName) CONFIG.APP_NAME = nextAppName;
}

async function tryLoadJson_(path) {
  try {
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

function apiBaseCandidates_() {
  const base = toStr_(CONFIG.BILLING_CLOUDRUN_URL).replace(/\/+$/, "");
  const withBase = base ? `${base}/portal/public-config` : "";
  const direct = "/portal/public-config";
  return Array.from(new Set([withBase, direct].filter(Boolean)));
}

async function tryLoadPublicConfigFromApi_() {
  const candidates = apiBaseCandidates_();
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) continue;
      return await resp.json();
    } catch (_) {
    }
  }
  return null;
}

function hashQueryParams_() {
  try {
    const raw = String(location.hash || "");
    const queryPart = raw.includes("?") ? raw.split("?")[1] : "";
    return new URLSearchParams(queryPart || "");
  } catch (_) {
    return new URLSearchParams("");
  }
}

function isLocalHost_() {
  const host = toStr_(location.hostname).toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

export async function initRuntimeConfig_() {
  if (_runtimeConfigReady) return CONFIG;

  mergeConfig_(window.__APP_CONFIG__);
  const apiConfig = await tryLoadPublicConfigFromApi_();
  if (apiConfig) {
    mergeConfig_(apiConfig);
  } else {
    mergeConfig_(await tryLoadJson_("./public-config.json"));
  }

  if (isLocalHost_()) {
    mergeConfig_(await tryLoadJson_("./public-config.local.json"));
  }

  const searchQ = new URLSearchParams(location.search || "");
  const hashQ = hashQueryParams_();
  const clearFlag = toStr_(searchQ.get("clear_api_base_url") || hashQ.get("clear_api_base_url"));
  if (clearFlag === "1") {
    try { localStorage.removeItem("mf:api_base_url"); } catch (_) {}
  }

  const queryBaseUrl = toStr_(searchQ.get("api_base_url") || hashQ.get("api_base_url"));
  if (queryBaseUrl) {
    CONFIG.BILLING_CLOUDRUN_URL = queryBaseUrl;
    try { localStorage.setItem("mf:api_base_url", queryBaseUrl); } catch (_) {}
  } else {
    try {
      const stored = toStr_(localStorage.getItem("mf:api_base_url"));
      if (stored) CONFIG.BILLING_CLOUDRUN_URL = stored;
    } catch (_) {}
  }

  _runtimeConfigReady = true;
  return CONFIG;
}
