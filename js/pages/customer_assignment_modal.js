import { escapeHtml, toast } from "../ui.js";
import { getUser } from "../auth.js";
import { runWithBlocking_ } from "./page_async_helpers.js";
import {
  searchStaffsForAssignmentPolicy_,
  listCustomerAssignmentsForAssignmentPolicy_,
  linkCustomerAssignmentPolicy_,
} from "./assignments_policy.js";

function todayLocalDateValue_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function asDateKey_(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

export function canManageCustomerAssignments_(userArg = null) {
  const user = userArg || getUser() || {};
  const role = String(user.role || "").trim().toLowerCase();
  if (role === "admin" || role === "owner" || role === "tenant_admin" || role === "store_admin" || role === "manager") return true;
  const memberships = Array.isArray(user?.authz?.memberships) ? user.authz.memberships : [];
  return memberships.some((m) => {
    if (!m || m.is_active === false) return false;
    const r = String(m.role || "").trim().toLowerCase();
    return r === "admin" || r === "owner" || r === "tenant_admin" || r === "store_admin" || r === "manager";
  });
}

export async function openCustomerAssignmentModal({ customerId, customerName, idToken } = {}) {
  const modalHost = document.querySelector("#modalHost");
  if (!modalHost || !idToken || !customerId) return false;
  if (!canManageCustomerAssignments_()) {
    toast({ title: "権限不足", message: "担当追加/終了は店舗管理者以上のみ実行できます。" });
    return false;
  }

  let assignments = [];
  let staffs = [];
  let changed = false;
  let busy = false;
  let endingStaffId = "";
  const user = getUser() || {};
  const tenantId = String(user.tenant_id || "").trim() || "TENANT_LEGACY";
  const storeId = String(user.store_id || user.org_id || "").trim();

  const staffIdOf_ = (s) => String((s && (s.staff_id || s.id)) || "").trim();
  const staffNameOf_ = (sid) => {
    const hit = staffs.find((s) => staffIdOf_(s) === sid);
    return String((hit && hit.name) || sid);
  };
  const activeStaffIds_ = () => new Set(assignments.map((x) => String((x && x.staff_id) || "").trim()).filter(Boolean));

  const load_ = async () => {
    const [aRes, sRes] = await Promise.all([
      listCustomerAssignmentsForAssignmentPolicy_(idToken, {
        customer_id: customerId,
        only_active: true,
        role: "all",
      }),
      searchStaffsForAssignmentPolicy_(idToken),
    ]);
    assignments = Array.isArray(aRes && aRes.assignments) ? aRes.assignments : [];
    staffs = Array.isArray(sRes) ? sRes : [];
  };

  const render_ = () => {
    const assignedIds = activeStaffIds_();
    const endingAssignment = endingStaffId
      ? (assignments.find((a) => String((a && a.staff_id) || "").trim() === endingStaffId) || null)
      : null;
    const endingStartDate = asDateKey_(endingAssignment && endingAssignment.start_date);
    const endConfirmHtml = endingAssignment ? `
      <div class="hr"></div>
      <div class="p" style="margin-bottom:10px;">
        <strong>終了確認</strong><br>
        ${escapeHtml(String((endingAssignment && endingAssignment.staff_name) || staffNameOf_(endingStaffId)))} (${escapeHtml(endingStaffId)}) の担当を終了します。
      </div>
      <label class="field" style="display:block; margin-bottom:10px;">
        <div class="label">担当終了日</div>
        <input id="customerAssignmentEndDate" class="input" type="date" value="${escapeHtml(todayLocalDateValue_())}" />
      </label>
      ${endingStartDate ? `<div class="text-sm text-muted" style="margin-bottom:10px;">開始日: ${escapeHtml(endingStartDate)}</div>` : ``}
      <div class="row row-end gap-8">
        <button class="btn btn-ghost" id="customerAssignmentEndCancel" type="button">戻る</button>
        <button class="btn btn-danger" id="customerAssignmentEndConfirm" type="button">終了する</button>
      </div>
    ` : "";
    const rowsHtml = assignments.length
      ? assignments.map((a, idx) => {
          const sid = String((a && a.staff_id) || "").trim();
          const name = String((a && a.staff_name) || staffNameOf_(sid));
          const start = asDateKey_(a && a.start_date) || "-";
          const ending = sid && sid === endingStaffId;
          const rowBorder = idx < assignments.length - 1 ? " border-bottom:1px solid rgba(148,163,184,.25);" : "";
          return `
            <div class="row row-between gap-8" style="padding:8px 0;${rowBorder}">
              <div>
                <div><strong>${escapeHtml(name)}</strong> <span class="text-sm text-muted">(${escapeHtml(sid)})</span></div>
                <div class="text-sm text-muted">開始日: ${escapeHtml(start)}</div>
              </div>
              <button class="btn btn-ghost" type="button" data-action="assignment-end" data-staff-id="${escapeHtml(sid)}"${ending ? " disabled" : ""}>終了</button>
            </div>
          `;
        }).join("")
      : `<p class="p text-muted">現在の担当スタッフはいません。</p>`;
    const options = staffs
      .map((s) => {
        const sid = staffIdOf_(s);
        if (!sid || assignedIds.has(sid)) return "";
        const label = `${String((s && s.name) || sid)} (${sid})`;
        return `<option value="${escapeHtml(sid)}">${escapeHtml(label)}</option>`;
      })
      .filter(Boolean);
    const addDisabled = options.length ? "" : " disabled";
    modalHost.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="m-title">担当スタッフ</div>
        <div class="m-body">
          <div class="p" style="margin-bottom:10px;"><strong>顧客</strong>: ${escapeHtml(customerName || customerId)}</div>
          <div style="margin-bottom:14px;">${rowsHtml}</div>
          ${endConfirmHtml}
          ${endingAssignment ? "" : `
            <div class="hr"></div>
            <label class="field" style="display:block; margin-bottom:10px;">
              <div class="label">追加スタッフ</div>
              <select id="customerAssignmentStaffSelect" class="input"${addDisabled}>
                ${options.length ? options.join("") : `<option value="">追加できるスタッフがいません</option>`}
              </select>
            </label>
            <label class="field" style="display:block;">
              <div class="label">担当開始日</div>
              <input id="customerAssignmentStartDate" class="input" type="date" value="${escapeHtml(todayLocalDateValue_())}" />
            </label>
          `}
        </div>
        <div class="m-actions">
          <button class="btn btn-ghost" id="customerAssignmentClose" type="button">閉じる</button>
          ${endingAssignment ? "" : `<button class="btn" id="customerAssignmentAdd" type="button"${addDisabled}>追加</button>`}
        </div>
      </div>
    `;
  };

  const setBusy_ = (next) => {
    busy = !!next;
    if (busy) modalHost.querySelectorAll("button,select,input").forEach((el) => { el.disabled = true; });
  };

  try {
    await runWithBlocking_({
      title: "担当スタッフを取得しています",
      bodyHtml: "現在の担当とスタッフ一覧を取得しています。",
      busyText: "読み込み中...",
    }, load_);
  } catch (e) {
    toast({ title: "取得失敗", message: e?.message || String(e) });
    return false;
  }

  modalHost.classList.remove("is-hidden");
  modalHost.setAttribute("aria-hidden", "false");
  render_();

  return new Promise((resolve) => {
    const cleanup = () => {
      modalHost.classList.add("is-hidden");
      modalHost.setAttribute("aria-hidden", "true");
      modalHost.onclick = null;
      modalHost.innerHTML = "";
    };
    const reloadAndRender_ = async () => {
      await load_();
      render_();
    };
    modalHost.onclick = async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!btn) {
        if (ev.target === modalHost) { cleanup(); resolve(changed); }
        return;
      }
      if (busy) return;
      if (btn.id === "customerAssignmentClose") {
        cleanup();
        resolve(changed);
        return;
      }
      if (btn.id === "customerAssignmentAdd") {
        const staffId = String(modalHost.querySelector("#customerAssignmentStaffSelect")?.value || "").trim();
        const startDate = String(modalHost.querySelector("#customerAssignmentStartDate")?.value || "").trim();
        if (!staffId || !startDate) {
          toast({ title: "入力不足", message: "追加スタッフと担当開始日を入力してください。" });
          return;
        }
        try {
          setBusy_(true);
          const res = await linkCustomerAssignmentPolicy_(idToken, {
            customer_id: customerId,
            staff_id: staffId,
            role: "sub",
            start_date: startDate,
            tenant_id: tenantId,
            store_id: storeId,
            org_id: storeId,
          });
          if (!res || res.success === false) throw new Error((res && (res.operator_message || res.error || res.message)) || "担当追加に失敗しました。");
          changed = true;
          endingStaffId = "";
          toast({ title: "追加完了", message: "担当スタッフを追加しました。" });
          await reloadAndRender_();
        } catch (e) {
          toast({ title: "追加失敗", message: e?.message || String(e) });
          render_();
        } finally {
          setBusy_(false);
        }
        return;
      }
      if (btn.id === "customerAssignmentEndCancel") {
        endingStaffId = "";
        render_();
        return;
      }
      if (btn.id === "customerAssignmentEndConfirm") {
        const staffId = endingStaffId;
        const endDate = String(modalHost.querySelector("#customerAssignmentEndDate")?.value || "").trim();
        const current = assignments.find((a) => String((a && a.staff_id) || "").trim() === staffId) || {};
        const startDate = asDateKey_(current.start_date) || todayLocalDateValue_();
        if (!staffId || !endDate) {
          toast({ title: "入力不足", message: "担当終了日を入力してください。" });
          return;
        }
        if (startDate && endDate < startDate) {
          toast({ title: "日付確認", message: "担当終了日は開始日以降にしてください。" });
          return;
        }
        try {
          setBusy_(true);
          const res = await linkCustomerAssignmentPolicy_(idToken, {
            customer_id: customerId,
            staff_id: staffId,
            role: String(current.role || "sub").trim() || "sub",
            start_date: startDate,
            end_date: endDate,
            tenant_id: String(current.tenant_id || tenantId || "").trim(),
            store_id: String(current.store_id || storeId || "").trim(),
            org_id: String(current.store_id || storeId || "").trim(),
          });
          if (!res || res.success === false) throw new Error((res && (res.operator_message || res.error || res.message)) || "担当終了に失敗しました。");
          changed = true;
          endingStaffId = "";
          toast({ title: "終了完了", message: "担当スタッフを終了しました。" });
          await reloadAndRender_();
        } catch (e) {
          toast({ title: "終了失敗", message: e?.message || String(e) });
          render_();
        } finally {
          setBusy_(false);
        }
        return;
      }
      if (btn.dataset.action === "assignment-end") {
        const staffId = String(btn.dataset.staffId || "").trim();
        if (!staffId) return;
        endingStaffId = staffId;
        render_();
      }
    };
  });
}
