// js/ui.js
export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function setActiveNav(routeKey) {
  qsa(".nav-item").forEach(a => {
    a.classList.toggle("is-active", a.dataset.route === routeKey);
  });
}

export function render(el, html) {
  el.innerHTML = html;
}

export function toast({ title = "通知", message = "", ms = 2400 } = {}) {
  const host = qs("#toastHost");
  if (!host) return;

  const div = document.createElement("div");
  div.className = "toast";
  div.innerHTML = `
    <div class="t-title">${escapeHtml(title)}</div>
    <div class="t-msg">${escapeHtml(message)}</div>
  `;
  host.appendChild(div);

  window.setTimeout(() => {
    div.remove();
  }, ms);
}

export function showModal({ title, bodyHtml, okText = "OK", cancelText = "キャンセル", danger = false } = {}) {
  const host = qs("#modalHost");
  if (!host) return Promise.resolve(false);

  host.classList.remove("is-hidden");
  host.setAttribute("aria-hidden", "false");

  host.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-title">${escapeHtml(title || "")}</div>
      <div class="m-body">${bodyHtml || ""}</div>
      <div class="m-actions">
        <button class="btn btn-ghost" id="mCancel" type="button">${escapeHtml(cancelText)}</button>
        <button class="btn" id="mOk" type="button" ${danger ? 'style="border-color: rgba(255,92,92,0.35); color: #ffc1c1;"' : ""}>${escapeHtml(okText)}</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    const cleanup = () => {
      host.classList.add("is-hidden");
      host.setAttribute("aria-hidden", "true");
      host.innerHTML = "";
    };
    qs("#mCancel", host)?.addEventListener("click", () => { cleanup(); resolve(false); });
    qs("#mOk", host)?.addEventListener("click", () => { cleanup(); resolve(true); });
    host.addEventListener("click", (e) => {
      if (e.target === host) { cleanup(); resolve(false); }
    }, { once: true });
  });
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// 安全な文字列化（null / undefined / 数値 / boolean 対応）
export function fmt(v) {
  if (v == null) return "";
  return String(v);
}

// 空値の場合はダッシュ表示（表示用）
export function displayOrDash(v, dash = "—") {
  const s = fmt(v).trim();
  return s ? s : dash;
}

// JST 日時を人間向けに表示（詳細画面基準）
// 例: 2025/01/12 14:00
export function fmtDateTimeJst(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return fmt(v);

  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "/" +
    pad(d.getMonth() + 1) +
    "/" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}