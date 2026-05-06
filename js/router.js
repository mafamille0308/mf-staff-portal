// js/router.js
import { qs, render, setActiveNav, toast, showChoiceModal } from "./ui.js";
import { initGoogleLogin, isAuthed, getUser, getIdToken, setUser, clearIdToken, setActiveStoreContext_ } from "./auth.js";
import { portalMe_ } from "./pages/portal_api.js";

import { renderVisitsList } from "./pages/visits_list.js";
import { renderVisitDetail } from "./pages/visit_detail.js";
import { renderCustomersList } from "./pages/customers_list.js";
import { renderCustomerDetail } from "./pages/customer_detail.js";
import { renderSummaryPlaceholder } from "./pages/summary.js";
import { renderRegisterTab } from "./pages/register.js";
import { renderSettings } from "./pages/settings.js";
import { renderMeetingCustomerForm } from "./pages/meeting_customer_form.js";
import { renderInvoicesPage } from "./pages/invoices.js";

const KEY_RETURN_TO_HASH = "mf_return_to_hash";

function syncBottomNavForRole_() {
  const nav = qs(".bottom-nav");
  if (!nav) return;
  const user = getUser() || {};
  const role = String(user.role || "").toLowerCase();
  const isStaff = role === "staff";
  const invoicesTab = nav.querySelector('.nav-item[data-route="invoices"]');
  if (invoicesTab) invoicesTab.classList.toggle("is-hidden", isStaff);
  const visibleCount = nav.querySelectorAll(".nav-item:not(.is-hidden)").length || 1;
  nav.style.setProperty("--nav-count", String(visibleCount));
}

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
  const name = user.staff_name || user.name || user.email || user.staff_id || "user";
  const displayName = String(name || "").trim();
  const displayNameWithHonorific = displayName.endsWith("さん")
    ? displayName.replace(/ ?さん$/, " さん")
    : `${displayName} さん`;
  const activeStoreName = String(user.store_name || "").trim();
  badge.textContent = activeStoreName
    ? `${displayNameWithHonorific} / ${activeStoreName}`
    : displayNameWithHonorific;
  badge.title = badge.textContent;
  badge.classList.remove("is-hidden");
}

function storeChoicesFromUser_(user) {
  const u = user && typeof user === "object" ? user : {};
  const out = [];
  const seen = new Set();
  const memberships = Array.isArray(u?.authz?.memberships) ? u.authz.memberships : [];
  memberships.forEach((m) => {
    if (!m || m.is_active === false) return;
    const storeId = String(m.store_id || "").trim();
    if (!storeId || seen.has(storeId)) return;
    seen.add(storeId);
    const name = String(m.store_name || m.store_id || "").trim() || storeId;
    out.push({ store_id: storeId, store_name: name });
  });
  const fallbackStoreId = String(u.store_id || u.org_id || "").trim();
  if (fallbackStoreId && !seen.has(fallbackStoreId)) {
    out.push({
      store_id: fallbackStoreId,
      store_name: String(u.store_name || fallbackStoreId).trim() || fallbackStoreId,
    });
  }
  return out;
}

async function openStoreSwitchModal_() {
  const user = getUser() || {};
  const choices = storeChoicesFromUser_(user);
  if (choices.length <= 1) {
    toast({ title: "店舗切替", message: "切替可能な店舗がありません。" });
    return;
  }
  const currentStoreId = String(user.store_id || user.org_id || "").trim();
  const choice = await showChoiceModal({
    title: "店舗を切り替える",
    bodyHtml: '<p class="p">利用する店舗を選択してください。</p>',
    choices: choices.map((x) => ({
      value: x.store_id,
      label: x.store_id === currentStoreId ? `現在: ${x.store_name}` : x.store_name,
      ghost: x.store_id !== currentStoreId,
    })),
  });
  if (!choice || choice === currentStoreId) return;
  const selected = choices.find((x) => x.store_id === choice);
  setActiveStoreContext_(choice, selected ? selected.store_name : choice);
  toast({ title: "完了", message: "現在店舗を切り替えました。" });
}

async function route() {
  const app = qs("#app");
  if (!app) return;

  const { path, query } = parseRoute();
  syncBottomNavForRole_();

  // ナビ活性
  if (path.startsWith("/visits")) setActiveNav("visits");
  else if (path.startsWith("/customers")) setActiveNav("customers");
  else if (path.startsWith("/summary")) setActiveNav("summary");
  else if (path.startsWith("/invoices")) setActiveNav("invoices");
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
        const me = await portalMe_(token);
        if (!me || me.success === false || !me.ctx) throw new Error("ctx unavailable");
        setUser(me.ctx);
        syncBottomNavForRole_();
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
    } else if (path === "/invoices") {
      await renderInvoicesPage(app, query);
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
  qs("#userBadge")?.addEventListener("click", async () => {
    if (!isAuthed()) return;
    await openStoreSwitchModal_();
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("mf:auth:changed", route);
  route();
}
