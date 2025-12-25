// js/pages/login.js
import { initGoogleLogin } from "../auth.js";

export async function renderLogin(appEl) {
  initGoogleLogin({
    containerId: "app",
    onLogin: () => {
      // tokenは auth.js 内で sessionStorage に保存済み
      location.hash = "#/visits";
    },
  });
}
