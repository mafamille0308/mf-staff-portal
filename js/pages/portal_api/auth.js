// Endpoints:
// - /portal/me
import { portalCall_ } from "./core.js";

export async function portalMe_(idToken) {
  return portalCall_("/portal/me", {}, idToken);
}

export async function portalGoogleLogin_(idToken, payload = {}) {
  return portalCall_("/portal/auth/google/login", payload, idToken, { allowUnstoredToken: true });
}

export async function portalPasskeyRegisterOptions_(idToken) {
  return portalCall_("/portal/auth/passkey/register/options", {}, idToken, { allowUnstoredToken: true });
}

export async function portalPasskeyRegisterVerify_(idToken, payload) {
  return portalCall_("/portal/auth/passkey/register/verify", payload || {}, idToken, { allowUnstoredToken: true });
}

export async function portalPasskeyLoginOptions_(payload, signal) {
  return portalCall_("/portal/auth/passkey/login/options", payload || {}, "", { allowNoToken: true, signal });
}

export async function portalPasskeyLoginVerify_(payload, signal) {
  return portalCall_("/portal/auth/passkey/login/verify", payload || {}, "", { allowNoToken: true, signal });
}

export async function portalPasskeyClientLog_(idToken, payload) {
  return portalCall_("/portal/auth/passkey/client-log", payload || {}, idToken || "", { allowNoToken: true });
}
