// js/router.js
import { qs, render, setActiveNav, toast } from "./ui.js";
import { initGoogleLogin, isAuthed, getUser } from "./auth.js";

import { renderVisitsList } from "./pages/visits_list.js";
import { renderVisitDetail } from "./pages/visit_detail.js";
import { renderCustomersPlaceholder } from "./pages/customers_list.js";
import { renderSummaryPlaceholder } from "./pages/summary.js";
import { renderRegisterTab } from "./pages/register.js";

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
  else if (path.startsWith("/register")) setActiveNav("register");
  else setActiveNav("");

  // 未ログインはログイン画面
  if (!isAuthed()) {
    setActiveNav("");
    initGoogleLogin({
      containerId: "app",
      onLogin: () => {
        // ログイン後は予約一覧へ
        if (location.hash !== "#/visits") location.hash = "#/visits";
        route(); // hashchangeが発火しないケースでも再描画する
      },
    });
    updateHeaderUserBadge();
    return;
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
      renderCustomersPlaceholder(app);
    } else if (path === "/summary") {
      renderSummaryPlaceholder(app);
    } else if (path === "/register") {
      renderRegisterTab(app);
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
