// js/pages/settings.js
import { render, toast, escapeHtml, qs } from "../ui.js";
import { callGas } from "../api.js";
import { getIdToken, getUser } from "../auth.js";

function isAdmin_() {
  const u = getUser() || {};
  const role = String(u.role || "").toLowerCase();
  return role === "admin";
}

function val_(sel) {
  return String(qs(sel)?.value || "").trim();
}

export async function renderSettings(app, query) {
  // 管理者以外は閲覧不可（ナビは出るが中身で弾く：最小差分）
  if (!isAdmin_()) {
    render(app, `
      <section class="section">
        <h1 class="h1">設定</h1>
        <p class="p">このページを表示する権限がありません。</p>
      </section>
    `);
    return;
  }

  render(app, `
    <section class="section">
      <h1 class="h1">設定</h1>
      <p class="p">管理者向けの設定です。</p>

      <div class="hr"></div>

      <div class="card">
        <h2 class="h2">スタッフ追加</h2>
        <p class="p">Staffs へ追加し、スタッフ用カレンダーを作成します（共有はGoogleカレンダーUIで実施）。</p>

        <div class="grid" style="gap:10px;">
          <label class="field">
            <div class="label">氏名 *</div>
            <input id="stName" class="input" type="text" placeholder="例：推野 まどか" />
          </label>

          <label class="field">
            <div class="label">通知メール（email） *</div>
            <input id="stEmail" class="input" type="email" placeholder="example@..." />
          </label>

          <label class="field">
            <div class="label">ログイン/共有メール（login_email） *</div>
            <input id="stLoginEmail" class="input" type="email" placeholder="example@..." />
          </label>

          <label class="field">
            <div class="label">電話（任意）</div>
            <input id="stPhone" class="input" type="tel" />
          </label>

          <label class="field">
            <div class="label">org_id（任意）</div>
            <input id="stOrgId" class="input" type="text" />
          </label>

          <label class="field">
            <div class="label">role</div>
            <select id="stRole" class="select">
              <option value="staff">staff</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>

        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
          <button id="btnCreateStaff" class="btn" type="button">スタッフを追加</button>
          <button id="btnFillLogin" class="btn btn-ghost" type="button">login_email に email をコピー</button>
        </div>

        <div id="staffCreateResult" style="margin-top:12px;"></div>
      </div>
    </section>
  `);

  // UX: email -> login_email コピー
  qs("#btnFillLogin")?.addEventListener("click", () => {
    const e = qs("#stEmail");
    const le = qs("#stLoginEmail");
    if (!e || !le) return;
    if (!String(le.value || "").trim()) le.value = String(e.value || "").trim();
  });

  qs("#btnCreateStaff")?.addEventListener("click", async () => {
    const name = val_("#stName");
    const email = val_("#stEmail").toLowerCase();
    const login_email = val_("#stLoginEmail").toLowerCase();
    const phone = val_("#stPhone");
    const org_id = val_("#stOrgId");
    const role = val_("#stRole") || "staff";

    if (!name || !email || !login_email) {
      toast({ title: "入力不足", message: "必須項目（氏名 / email / login_email）を入力してください。" });
      return;
    }

    const btn = qs("#btnCreateStaff");
    if (btn) btn.disabled = true;

    const host = qs("#staffCreateResult");
    if (host) host.innerHTML = `<p class="p">作成中…</p>`;

    try {
      const idToken = getIdToken();
      const res = await callGas(
        {
          action: "adminCreateStaff",
          name,
          email,
          login_email,
          phone,
          org_id,
          role,
        },
        idToken
      );

      const staffId = escapeHtml(res.staff_id || "");
      const calId = escapeHtml(res.calendar_id || "");
      const warning = res.warning
        ? `<div class="card" style="margin-top:10px;"><div class="p"><b>注意</b><br>${escapeHtml(String(res.warning))}</div></div>`
        : "";

      const steps = Array.isArray(res.next_steps) ? res.next_steps : [];
      const stepsHtml = steps.length
        ? `<ol style="margin:8px 0 0 18px;">${steps
            .map((s) => `<li>${escapeHtml(String(s))}</li>`)
            .join("")}</ol>`
        : "";

      if (host) {
        host.innerHTML = `
          <div class="card">
            <div class="p"><b>作成完了</b></div>
            <div class="hint-row"><div class="muted">staff_id</div><div>${staffId || "-"}</div></div>
            <div class="hint-row"><div class="muted">calendar_id</div><div>${calId || "-"}</div></div>
            ${stepsHtml}
          </div>
          ${warning}
        `;
      }

      toast({ title: "完了", message: `スタッフを追加しました（${res.staff_id || ""}）` });
    } catch (e) {
      if (host) host.innerHTML = "";
      toast({ title: "作成失敗", message: e?.message || String(e) });
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}
