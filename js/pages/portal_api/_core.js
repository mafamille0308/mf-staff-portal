import { callCloudRunPortal } from "../../api.js";

export function clonePayload_(payload) {
  return Object.assign({}, payload || {});
}

export function toTrimmed_(value) {
  return String(value || "").trim();
}

export async function portalCall_(path, payload, idToken) {
  return callCloudRunPortal(path, payload, idToken);
}
