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

export function showSelectModal({ title, bodyHtml, okText = "変更", cancelText = "キャンセル", selectId }) {
  const host = document.querySelector("#modalHost");
  if (!host) return Promise.resolve(null);

  host.classList.remove("is-hidden");
  host.setAttribute("aria-hidden", "false");

  host.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-title">${escapeHtml(title || "")}</div>
      <div class="m-body">${bodyHtml || ""}</div>
      <div class="m-actions">
        <button class="btn btn-ghost" id="mCancel" type="button">${escapeHtml(cancelText)}</button>
        <button class="btn" id="mOk" type="button">${escapeHtml(okText)}</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    const cleanup = () => {
      host.classList.add("is-hidden");
      host.setAttribute("aria-hidden", "true");
      host.innerHTML = "";
    };
    host.querySelector("#mCancel")?.addEventListener("click", () => { cleanup(); resolve(null); });
    host.querySelector("#mOk")?.addEventListener("click", () => {
      const sel = host.querySelector(`#${selectId}`);
      const v = sel ? String(sel.value || "") : "";
      cleanup();
      resolve(v);
    });
    host.addEventListener("click", (e) => {
      if (e.target === host) { cleanup(); resolve(null); }
    }, { once: true });
  });
}

export function showFormModal({ title, bodyHtml, okText = "OK", cancelText = "キャンセル", formSelector = "form" } = {}) {
  const host = qs("#modalHost");
  if (!host) return Promise.resolve(null);

  host.classList.remove("is-hidden");
  host.setAttribute("aria-hidden", "false");

  host.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-title">${escapeHtml(title || "")}</div>
      <div class="m-body">${bodyHtml || ""}</div>
      <div class="m-actions">
        <button class="btn btn-ghost" id="mCancel" type="button">${escapeHtml(cancelText)}</button>
        <button class="btn" id="mOk" type="button">${escapeHtml(okText)}</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    const cleanup = () => {
      host.classList.add("is-hidden");
      host.setAttribute("aria-hidden", "true");
      host.innerHTML = "";
    };
    qs("#mCancel", host)?.addEventListener("click", () => { cleanup(); resolve(null); });
    qs("#mOk", host)?.addEventListener("click", () => {
      const form = host.querySelector(formSelector);
      const out = {};
      if (form) {
        const fd = new FormData(form);
        for (const [k, v] of fd.entries()) out[String(k)] = String(v == null ? "" : v);
      }
      cleanup();
      resolve(out);
    });
    host.addEventListener("click", (e) => {
      if (e.target === host) { cleanup(); resolve(null); }
    }, { once: true });
  });
}

export function showChoiceModal({ title, bodyHtml, choices = [] } = {}) {
  const host = qs("#modalHost");
  if (!host) return Promise.resolve("");

  const safeChoices = Array.isArray(choices) ? choices.filter((x) => x && x.value) : [];
  host.classList.remove("is-hidden");
  host.setAttribute("aria-hidden", "false");

  host.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-title">${escapeHtml(title || "")}</div>
      <div class="m-body">${bodyHtml || ""}</div>
      <div class="m-actions">
        ${safeChoices.map((x) => `<button class="btn ${x.ghost ? "btn-ghost" : ""}" data-choice="${escapeHtml(String(x.value || ""))}" type="button"${x.danger ? ' style="border-color: rgba(255,92,92,0.35); color: #ffc1c1;"' : ""}>${escapeHtml(String(x.label || x.value || ""))}</button>`).join("")}
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    const cleanup = () => {
      host.classList.add("is-hidden");
      host.setAttribute("aria-hidden", "true");
      host.innerHTML = "";
    };
    safeChoices.forEach((x) => {
      qs(`[data-choice="${String(x.value || "")}"]`, host)?.addEventListener("click", () => {
        cleanup();
        resolve(String(x.value || ""));
      });
    });
    host.addEventListener("click", (e) => {
      if (e.target === host) {
        cleanup();
        resolve("");
      }
    }, { once: true });
  });
}

export function openBlockingOverlay({ title = "", bodyHtml = "", busyText = "処理中..." } = {}) {
  const el = document.createElement("div");
  el.setAttribute("data-el", "mfBlockingOverlay");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.zIndex = "9999";
  el.style.background = "rgba(0,0,0,.35)";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.padding = "16px";
  el.innerHTML = `
    <div class="card" style="max-width:520px; width:100%; box-shadow:0 10px 30px rgba(0,0,0,.2);">
      <div class="p">
        <div class="p" style="margin:0 0 8px 0;"><strong>${escapeHtml(title || "")}</strong></div>
        <div class="p" style="opacity:.9; margin:0 0 10px 0;">${bodyHtml || ""}</div>
        <div class="hr"></div>
        <div class="p" style="display:flex; gap:10px; align-items:center; opacity:.85;">
          <span class="spinner" aria-hidden="true"></span>
          <span data-el="busyText">${escapeHtml(busyText || "処理中...")}</span>
        </div>
      </div>
    </div>
  `;
  const sp = el.querySelector(".spinner");
  if (sp) {
    sp.style.width = "16px";
    sp.style.height = "16px";
    sp.style.border = "2px solid rgba(0,0,0,.2)";
    sp.style.borderTopColor = "rgba(0,0,0,.6)";
    sp.style.borderRadius = "50%";
    sp.style.animation = "mfSpin .9s linear infinite";
    if (!document.getElementById("mfSpinStyle")) {
      const st = document.createElement("style");
      st.id = "mfSpinStyle";
      st.textContent = `
        @keyframes mfSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `;
      document.head.appendChild(st);
    }
  }
  document.body.appendChild(el);
  return {
    setBusyText(text) {
      const t = el.querySelector('[data-el="busyText"]');
      if (t) t.textContent = String(text || "");
    },
    close() {
      try { el.remove(); } catch (_) {}
    }
  };
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

// JST 日付のみを人間向けに表示
// 例: 2025/01/12
export function fmtDateJst(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return fmt(v);

  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "/" +
    pad(d.getMonth() + 1) +
    "/" +
    pad(d.getDate())
  );
}

// birthdate から年齢表示を生成（JST基準）
// 返り値例: "3歳(2ヶ月)" / "3歳" / ""（birthdate無効）
export function fmtAgeFromBirthdateJst(birthdate, now = new Date()) {
  const bd = toValidDate_(birthdate);
  if (!bd) return "";

  // JSTの「日付」比較に寄せる（時刻でズレないように）
  const today = new Date(now);
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const today0 = new Date(y, m, d, 0, 0, 0, 0);

  const by = bd.getFullYear();
  const bm = bd.getMonth();
  const bdDay = bd.getDate();
  const bd0 = new Date(by, bm, bdDay, 0, 0, 0, 0);

  // 未来日・同日などのガード
  if (bd0 > today0) return "";

  let years = y - by;
  // 今年の誕生日がまだ来ていないなら -1
  const hasHadBirthdayThisYear =
    (m > bm) || (m === bm && d >= bdDay);
  if (!hasHadBirthdayThisYear) years -= 1;
  if (years < 0) years = 0;

  // 月齢（年を除いた残り月）
  // まず「最終誕生日（年齢years到達日）」を作り、そこから today までの月差を出す
  const lastBirthdayYear = by + years;
  const lastBirthday = new Date(lastBirthdayYear, bm, bdDay, 0, 0, 0, 0);

  let months = (y - lastBirthday.getFullYear()) * 12 + (m - lastBirthday.getMonth());
  if (d < bdDay) months -= 1;
  if (months < 0) months = 0;
  // 0-11に丸める（理屈上は超えにくいが保険）
  months = months % 12;

  // 表示形式
  if (years === 0 && months === 0) return "0歳";
  if (months === 0) return `${years}歳`;
  return `${years}歳(${months}ヶ月)`;
}

// 入力の Date/文字列を Date に正規化（失敗は null）
function toValidDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

  const s = String(v).trim();
  if (!s) return null;

  // "YYYY/MM/DD" を "YYYY-MM-DD" に寄せる
  const normalized = s.replace(/\//g, "-");

  const d = new Date(normalized);
  if (!isNaN(d.getTime())) return d;

  // それでも駄目ならそのまま最後に試す
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}
