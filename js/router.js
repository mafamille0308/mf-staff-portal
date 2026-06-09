// js/router.js
import { qs, render, setActiveNav, toast, escapeHtml } from "./ui.js";
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
import { runWithLoading_ } from "./pages/page_async_helpers.js";

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
  badge.textContent = displayNameWithHonorific;
  badge.title = badge.textContent;
  badge.classList.remove("is-hidden");
}

function resolveActiveStoreName_(user) {
  const u = user && typeof user === "object" ? user : {};
  const direct = String(u.store_name || "").trim();
  if (direct) return direct;
  const activeStoreId = String(u.store_id || u.org_id || "").trim();
  if (!activeStoreId) return "";
  const memberships = Array.isArray(u?.authz?.memberships) ? u.authz.memberships : [];
  const matched = memberships.find((m) => {
    if (!m || m.is_active === false) return false;
    return String(m.store_id || "").trim() === activeStoreId;
  });
  return String((matched && matched.store_name) || "").trim();
}

function storeChoicesFromUser_(user) {
  const u = user && typeof user === "object" ? user : {};
  const out = [];
  const seen = new Set();
  const currentStoreId = String(u.store_id || u.org_id || "").trim();
  const currentStoreName = resolveActiveStoreName_(u);
  const memberships = Array.isArray(u?.authz?.memberships) ? u.authz.memberships : [];
  memberships.forEach((m) => {
    if (!m || m.is_active === false) return;
    const storeId = String(m.store_id || "").trim();
    if (!storeId || seen.has(storeId)) return;
    seen.add(storeId);
    const name = String(m.store_name || "").trim() || (storeId === currentStoreId ? currentStoreName : "") || "店舗名未設定";
    out.push({ store_id: storeId, store_name: name });
  });
  const fallbackStoreId = String(u.store_id || u.org_id || "").trim();
  if (fallbackStoreId && !seen.has(fallbackStoreId)) {
    out.push({
      store_id: fallbackStoreId,
      store_name: String(u.store_name || "").trim() || currentStoreName || "店舗名未設定",
    });
  }
  return out;
}

function canSwitchStore_(user) {
  const u = user && typeof user === "object" ? user : {};
  const globalRole = String(u.role || "").trim().toLowerCase();
  if (globalRole === "admin") return true;
  const memberships = Array.isArray(u?.authz?.memberships) ? u.authz.memberships : [];
  return memberships.some((m) => {
    if (!m || m.is_active === false) return false;
    const role = String(m.role || "").trim().toLowerCase();
    return role === "owner" || role === "tenant_admin" || role === "store_admin" || role === "admin";
  });
}

async function openStoreSwitchModal_() {
  const user = getUser() || {};
  if (!canSwitchStore_(user)) {
    return;
  }
  const choices = storeChoicesFromUser_(user);
  const currentStoreId = String(user.store_id || user.org_id || "").trim();
  const picker = qs("#storePicker");
  if (!picker) return;
  const rows = choices.length ? choices : [{
    store_id: currentStoreId,
    store_name: resolveActiveStoreName_(user) || String(currentStoreId || "店舗未設定"),
  }];
  picker.innerHTML = rows.map((x) => {
    const isCurrent = String(x.store_id || "").trim() === currentStoreId;
    return `<button class="store-picker-item" type="button" data-store-id="${escapeHtml(String(x.store_id || "").trim())}"><span class="store-picker-check">${isCurrent ? "✓" : ""}</span><span class="store-picker-name">${escapeHtml(String(x.store_name || ""))}</span></button>`;
  }).join("");
  picker.classList.toggle("is-hidden");
  picker.setAttribute("aria-hidden", picker.classList.contains("is-hidden") ? "true" : "false");
}

function closeStorePicker_() {
  const picker = qs("#storePicker");
  if (!picker) return;
  picker.classList.add("is-hidden");
  picker.setAttribute("aria-hidden", "true");
}

async function renderTabWithLoading_(title, task) {
  return runWithLoading_(
    {
      title: title || "画面を準備しています",
      bodyHtml: "表示に必要なデータを確認しています。",
    },
    async () => task()
  );
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
        await renderTabWithLoading_("予約詳細を読み込んでいます", () => renderVisitDetail(app, query));
      } else {
        await renderTabWithLoading_("予約を読み込んでいます", () => renderVisitsList(app, query));
      }
    } else if (path === "/customers") {
      const cid = query.get("id");
      if (cid) {
        await renderTabWithLoading_("顧客詳細を読み込んでいます", () => renderCustomerDetail(app, query));
      } else {
        await renderTabWithLoading_("顧客を読み込んでいます", () => renderCustomersList(app, query));
      }
    } else if (path === "/summary") {
      await renderTabWithLoading_("集計を読み込んでいます", () => renderSummaryPlaceholder(app));
    } else if (path === "/settings") {
      await renderTabWithLoading_("設定を読み込んでいます", () => renderSettings(app, query));
    } else if (path === "/invoices") {
      await renderTabWithLoading_("請求を読み込んでいます", () => renderInvoicesPage(app, query));
    } else if (path === "/register") {
      await renderTabWithLoading_("登録画面を準備しています", () => renderRegisterTab(app, query));
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
  qs("#storePicker")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".store-picker-item");
    if (!btn) return;
    const user = getUser() || {};
    const currentStoreId = String(user.store_id || user.org_id || "").trim();
    const nextStoreId = String(btn.getAttribute("data-store-id") || "").trim();
    if (!nextStoreId || nextStoreId === currentStoreId) {
      closeStorePicker_();
      return;
    }
    const choices = storeChoicesFromUser_(user);
    const selected = choices.find((x) => x.store_id === nextStoreId);
    setActiveStoreContext_(nextStoreId, selected ? selected.store_name : "");
    closeStorePicker_();
  });
  document.addEventListener("click", (ev) => {
    const target = ev.target;
    const picker = qs("#storePicker");
    const badge = qs("#userBadge");
    if (!picker || !badge) return;
    if (picker.classList.contains("is-hidden")) return;
    if (picker.contains(target) || badge.contains(target)) return;
    closeStorePicker_();
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("mf:auth:changed", route);
  route();
}
