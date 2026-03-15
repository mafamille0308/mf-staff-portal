import { escapeHtml, toast, openBlockingOverlay } from "../ui.js";
import { callGas } from "../api.js";

function nowLocalDateTimeValue_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nowLocalDateValue_() {
  return String(nowLocalDateTimeValue_()).slice(0, 10);
}

function toJstIsoFromLocal_(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return `${v}:00+09:00`;
}

export async function openAssignModalForRegister({ customerId, customerName, idToken }) {
  const modalHost = document.querySelector("#modalHost");
  if (!modalHost) return null;
  if (!idToken) return null;

  let selectedStaffId = "";
  let pendingNewStaffId = "";
  let step = "select";
  let assignments = [];
  let staffs = [];

  const fetchBlocker = openBlockingOverlay({
    title: "担当スタッフを準備しています",
    bodyHtml: "担当状況とスタッフ一覧を取得しています。",
    busyText: "読み込み中...",
  });
  try {
    const [aRes, sRes] = await Promise.all([
      callGas({
        action: "listCustomerAssignments",
        list_customer_assignments: {
          customer_id: customerId,
          only_active: true,
          role: "all"
        }
      }, idToken),
      callGas({ action: "searchStaffs", query: "", allow_empty: true }, idToken),
    ]);
    assignments = Array.isArray(aRes && aRes.assignments) ? aRes.assignments : [];
    staffs = Array.isArray(sRes) ? sRes : [];
  } catch (e) {
    toast({ title: "取得失敗", message: e?.message || String(e) });
    return null;
  } finally {
    fetchBlocker.close();
  }

  if (!selectedStaffId && assignments.length) {
    selectedStaffId = String((assignments[0] && assignments[0].staff_id) || "").trim();
  }

  const assignedIds_ = () => new Set(assignments.map((x) => String((x && x.staff_id) || "").trim()).filter(Boolean));
  const getStaffName_ = (sid) => {
    const hit = staffs.find((s) => String((s && (s.staff_id || s.id)) || "").trim() === sid);
    return String((hit && hit.name) || sid);
  };
  const renderSelectBody_ = () => {
    const assignedIds = assignedIds_();
    const options = ['<option value="">担当スタッフを選択</option>'];
    staffs.forEach((s) => {
      const sid = String((s && (s.staff_id || s.id)) || "").trim();
      if (!sid) return;
      const sname = String((s && s.name) || sid);
      const linked = assignedIds.has(sid);
      const label = linked ? `${sname} (${sid})` : `+ ${sname} (${sid}) [未担当]`;
      const sel = (selectedStaffId === sid) ? "selected" : "";
      const style = linked ? "" : ' style="color:#7f8ea3;"';
      options.push(`<option value="${escapeHtml(sid)}" ${sel}${style}>${escapeHtml(label)}</option>`);
    });
    return `
      <div class="p">
        <div style="margin-bottom:8px;"><strong>顧客</strong>：${escapeHtml(customerName || customerId)}</div>
        <label class="field" style="margin-bottom:10px;">
          <div class="label">担当スタッフ</div>
          <select id="assignStaffSelect" class="input">${options.join("")}</select>
        </label>
        <div class="text-sm text-muted">未担当は先頭に「+」が付きます。</div>
        <div class="text-sm text-muted">担当開始日を予約日前に設定してください。</div>
      </div>
    `;
  };
  const renderLinkConfirmBody_ = () => {
    const sid = pendingNewStaffId;
    return `
      <div class="p">
        <div style="margin-bottom:8px;"><strong>顧客</strong>：${escapeHtml(customerName || customerId)}</div>
        <div style="margin-bottom:8px;"><strong>追加スタッフ</strong>：${escapeHtml(getStaffName_(sid))} (${escapeHtml(sid)})</div>
        <label class="field" style="display:block; margin-top:8px;">
          <div class="label">担当開始日（必須）</div>
          <input id="assignStartAtConfirm" class="input" type="date" value="${escapeHtml(nowLocalDateValue_())}" />
        </label>
        <div class="text-sm text-muted" style="margin-top:8px;">担当開始日を予約日前に設定してください。</div>
      </div>
    `;
  };

  modalHost.classList.remove("is-hidden");
  modalHost.setAttribute("aria-hidden", "false");
  modalHost.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-title">予約登録前に担当スタッフを選択</div>
      <div class="m-body" id="assignModalBody">${renderSelectBody_()}</div>
      <div class="m-actions">
        <button class="btn btn-ghost" id="assignCancel" type="button">キャンセル</button>
        <button class="btn" id="assignProceed" type="button">予約登録へ進む</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    const cleanup = () => {
      modalHost.classList.add("is-hidden");
      modalHost.setAttribute("aria-hidden", "true");
      modalHost.onclick = null;
      modalHost.onchange = null;
      modalHost.innerHTML = "";
    };
    const setStep_ = (nextStep) => {
      step = nextStep;
      const bodyEl = modalHost.querySelector("#assignModalBody");
      const cancelBtn = modalHost.querySelector("#assignCancel");
      const proceedBtn = modalHost.querySelector("#assignProceed");
      if (!bodyEl || !cancelBtn || !proceedBtn) return;
      if (step === "confirm-link") {
        bodyEl.innerHTML = renderLinkConfirmBody_();
        cancelBtn.textContent = "戻る";
        proceedBtn.textContent = "追加して進む";
        return;
      }
      bodyEl.innerHTML = renderSelectBody_();
      cancelBtn.textContent = "キャンセル";
      proceedBtn.textContent = "予約登録へ進む";
    };

    modalHost.onclick = async (ev) => {
      const target = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!target) {
        if (ev.target === modalHost) { cleanup(); resolve(null); }
        return;
      }
      if (target.id === "assignCancel") {
        if (step === "confirm-link") {
          setStep_("select");
          return;
        }
        cleanup();
        resolve(null);
        return;
      }
      if (target.id === "assignProceed") {
        if (step === "confirm-link") {
          const dt = modalHost.querySelector("#assignStartAtConfirm");
          const startAt = String((dt && dt.value) || "").trim();
          if (!startAt) {
            toast({ title: "入力不足", message: "担当開始日を入力してください。" });
            return;
          }
          const linkBlocker = openBlockingOverlay({
            title: "担当関係を追加しています",
            bodyHtml: "担当登録の反映を確認しています。",
            busyText: "追加中...",
          });
          try {
            const res = await callGas({
              action: "linkCustomerStaff",
              link_customer_staff: {
                customer_id: customerId,
                staff_id: pendingNewStaffId,
                role: "sub",
                start_date: toJstIsoFromLocal_(startAt),
              }
            }, idToken);
            if (!res || res.success === false) {
              throw new Error((res && (res.operator_message || res.error || res.message)) || "linkCustomerStaff failed");
            }
            linkBlocker.setBusyText("反映を確認しています...");
            const verify = await callGas({
              action: "listCustomerAssignments",
              list_customer_assignments: {
                customer_id: customerId,
                only_active: true,
                as_of: String(startAt || "").slice(0, 10),
                role: "all"
              }
            }, idToken);
            const items = Array.isArray(verify && verify.assignments) ? verify.assignments : [];
            const linked = items.some((x) => String((x && x.staff_id) || "").trim() === pendingNewStaffId);
            if (!linked) {
              throw new Error("担当関係の反映確認に失敗しました。再度実行してください。");
            }
          } catch (e) {
            toast({ title: "追加失敗", message: e?.message || String(e) });
            return;
          } finally {
            linkBlocker.close();
          }
          cleanup();
          resolve(pendingNewStaffId);
          return;
        }
        const sel = modalHost.querySelector("#assignStaffSelect");
        const sid = String((sel && sel.value) || "").trim();
        if (!sid) {
          toast({ title: "選択必須", message: "登録先スタッフを選択してください。" });
          return;
        }
        if (!assignedIds_().has(sid)) {
          pendingNewStaffId = sid;
          setStep_("confirm-link");
          return;
        }
        cleanup();
        resolve(sid);
      }
    };
    modalHost.onchange = (ev) => {
      const sel = ev.target && ev.target.id === "assignStaffSelect" ? ev.target : null;
      if (!sel) return;
      selectedStaffId = String(sel.value || "").trim();
    };
  });
}
