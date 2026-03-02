// js/router.js
import { qs, render, setActiveNav, toast } from "./ui.js";
import { initGoogleLogin, isAuthed, getUser, getIdToken, setUser, clearIdToken } from "./auth.js";
import { callGas } from "./api.js";

import { renderVisitsList } from "./pages/visits_list.js";
import { renderVisitDetail } from "./pages/visit_detail.js";
import { renderCustomersList } from "./pages/customers_list.js";
import { renderCustomerDetail } from "./pages/customer_detail.js";
import { renderSummaryPlaceholder } from "./pages/summary.js";
import { renderRegisterTab } from "./pages/register.js";
import { renderSettings } from "./pages/settings.js";
import { renderMeetingCustomerForm } from "./pages/meeting_customer_form.js";

const KEY_RETURN_TO_HASH = "mf_return_to_hash";

function parseRoute() {
  const hash = location.hash || "#/visits";
  const [pathPart, queryPart] = hash.slice(1).split("?");
  const path = pathPart || "/visits";
  const query = new URLSearchParams(queryPart || "");
  return { path, query };
}

function updateHeaderUserBadge() {
  const badge = qs("#userBadge");
  if (!badge) return;
  const user = getUser();

  if (!user) {
    badge.classList.add("is-hidden");
    badge.textContent = "";
    return;
  }
  const role = user.role ? String(user.role) : "unknown";
  const name = user.name || user.email || user.staff_id || "user";
  badge.textContent = `${name} (${role})`;
  badge.classList.remove("is-hidden");
}

async function route() {
  const app = qs("#app");
  if (!app) return;

  const { path, query } = parseRoute();

  // ナビ活性
  if (path.startsWith("/visits")) setActiveNav("visits");
  else if (path.startsWith("/customers")) setActiveNav("customers");
  else if (path.startsWith("/summary")) setActiveNav("summary");
  else if (path.startsWith("/settings")) setActiveNav("settings");
  else if (path.startsWith("/register")) setActiveNav("");
  else if (path.startsWith("/meeting-customer")) setActiveNav("");
  else setActiveNav("");

  // 未ログインはログイン画面
  if (!isAuthed()) {
    // 操作中の画面（hash）を退避して、ログイン後に復帰できるようにする
    const currentHash = location.hash || "#/visits";
    try { sessionStorage.setItem(KEY_RETURN_TO_HASH, currentHash); } catch (_) {}
    setActiveNav("");
    initGoogleLogin({
      containerId: "app",
      onLogin: () => {
        // ログイン後は「直前に見ていた画面」へ戻す（なければ /visits）
        let nextHash = "";
        try {
          nextHash = String(sessionStorage.getItem(KEY_RETURN_TO_HASH) || "").trim();
          sessionStorage.removeItem(KEY_RETURN_TO_HASH);
        } catch (_) {}

        if (!nextHash || !nextHash.startsWith("#/")) nextHash = "#/visits";
        if (location.hash !== nextHash) location.hash = nextHash;
        route(); // hashchangeが発火しないケースでも再描画する
      },
    });
    updateHeaderUserBadge();
    return;
  }

  if (!getUser()) {
    try {
      const token = getIdToken();
      if (!token) throw new Error("id_token missing");
      const me = await callGas({ action: "getMe" }, token);
      if (!me || me.success === false || !me.ctx) throw new Error("ctx unavailable");
      setUser(me.ctx);
    } catch (e) {
      clearIdToken();
      setActiveNav("");
      initGoogleLogin({ containerId: "app", onLogin: route });
      updateHeaderUserBadge();
      return;
    }
  }

  // ルート分岐（まずは visits のみ実装）
  try {
    if (path === "/visits") {
      const vid = query.get("id");
      if (vid) {
        await renderVisitDetail(app, query);
      } else {
        await renderVisitsList(app, query);
      }
    } else if (path === "/customers") {
      const cid = query.get("id");
      if (cid) {
        await renderCustomerDetail(app, query);
      } else {
        await renderCustomersList(app, query);
      }
    } else if (path === "/summary") {
      renderSummaryPlaceholder(app);
    } else if (path === "/settings") {
      await renderSettings(app, query);
    } else if (path === "/register") {
      renderRegisterTab(app, query);
    } else if (path === "/meeting-customer") {
      await renderMeetingCustomerForm(app, query);
    } else {
      render(app, `<section class="section"><h1 class="h1">Not Found</h1><p class="p">${path}</p></section>`);
    }
  } catch (e) {
    toast({ title: "画面エラー", message: e?.message || String(e) });
    render(app, `
      <section class="section">
        <h1 class="h1">画面エラー</h1>
        <p class="p">${(e && e.message) ? e.message : String(e)}</p>
      </section>
    `);
  } finally {
    updateHeaderUserBadge();
  }
}

export function initApp() {
  // 手動更新ボタン
  qs("#btnRefresh")?.addEventListener("click", () => {
    route();
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("mf:auth:changed", route);
  route();
}
