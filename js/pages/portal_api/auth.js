// Endpoints:
// - /portal/me
import { portalCall_ } from "./core.js";

export async function portalMe_(idToken) {
  return portalCall_("/portal/me", {}, idToken);
}

export async function portalPasskeyRegisterOptions_(idToken) {
  return portalCall_("/portal/auth/passkey/register/options", {}, idToken);
}

export async function portalPasskeyRegisterVerify_(idToken, payload) {
  return portalCall_("/portal/auth/passkey/register/verify", payload || {}, idToken);
}

export async function portalPasskeyLoginOptions_() {
  return portalCall_("/portal/auth/passkey/login/options", {}, "", { allowNoToken: true });
}

export async function portalPasskeyLoginVerify_(payload) {
  return portalCall_("/portal/auth/passkey/login/verify", payload || {}, "", { allowNoToken: true });
}

export async function portalPasskeyClientLog_(idToken, payload) {
  return portalCall_("/portal/auth/passkey/client-log", payload || {}, idToken || "", { allowNoToken: true });
}
