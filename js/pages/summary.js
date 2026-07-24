import { getIdToken, getUser } from "../auth.js";
import { escapeHtml, render, showModal, toast } from "../ui.js";
import { portalSearchStaffs_, portalSummaryAdminMonthly_, portalSummaryMonthly_, portalSummaryMonthlyBulk_, portalSummaryMonthlyDetail_ } from "./portal_api.js";
import { formatMoney_ as formatRawMoney_ } from "./page_format_helpers.js";
import { runWithLoading_ } from "./page_async_helpers.js";

const DEFAULT_TIERS_ = [
  { min_count: 0, max_count: 99, rate_percent: 55, display_order: 10 },
  { min_count: 100, max_count: 149, rate_percent: 60, display_order: 20 },
  { min_count: 150, max_count: 199, rate_percent: 65, display_order: 30 },
  { min_count: 200, max_count: null, rate_percent: 70, display_order: 40 },
];
const SUMMARY_STORE_TARGET_ = "__store__";

function formatMoney_(value) {
  const n = Number(value || 0);
  return formatRawMoney_(Math.round(Number.isFinite(n) ? n : 0));
}

function currentYearMonthJst_() {
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).format(now);
}

function parseYm_(ym) {
  const m = String(ym || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

function toYm_(year, month) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function shiftYm_(ym, deltaMonths) {
  const p = parseYm_(ym);
  if (!p) return currentYearMonthJst_();
  const d = new Date(Date.UTC(p.year, p.month - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + Number(deltaMonths || 0));
  return toYm_(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

function monthKeys_(anchorYm, len) {
  const n = Math.max(1, Number(len || 12));
  const keys = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    keys.push(shiftYm_(anchorYm, -i));
  }
  return keys;
}

function formatYmJp_(ym) {
  const p = parseYm_(ym);
  if (!p) return "";
  return `${p.year}年${p.month}月`;
}

function formatDateTimeJstShort_(value) {
  const d = new Date(value || "");
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const pick = (type) => String(parts.find((p) => p.type === type)?.value || "");
  return `${pick("month")}/${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function normalizeTiers_(tiers) {
  const src = Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_TIERS_;
  return src.map((t) => ({
    min_count: Math.max(0, Number(t?.min_count || 0)),
    max_count: t?.max_count == null ? null : Number(t.max_count),
    rate_percent: Number(t?.rate_percent || 0) || 0,
    display_order: Number(t?.display_order || 0),
  })).sort((a, b) => {
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return a.min_count - b.min_count;
  });
}

function resolveTierProgress_(count, tiers) {
  const n = Math.max(0, Number(count || 0));
  const list = normalizeTiers_(tiers);
  let currentIndex = 0;
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const inMin = n >= row.min_count;
    const inMax = row.max_count == null || n <= row.max_count;
    if (inMin && inMax) {
      currentIndex = i;
      break;
    }
    if (n >= row.min_count) currentIndex = i;
  }
  const currentTier = list[currentIndex] || null;
  const nextTier = currentIndex < list.length - 1 ? list[currentIndex + 1] : null;
  const remainingToNext = nextTier ? Math.max(0, nextTier.min_count - n) : 0;
  let ratio = 1;
  if (nextTier && currentTier) {
    const from = Math.max(0, currentTier.min_count);
    const to = Math.max(from + 1, nextTier.min_count);
    ratio = Math.max(0, Math.min(1, (n - from) / (to - from)));
  }
  return { list, currentTier, nextTier, remainingToNext, ratio };
}

function donutGradientByTier_(tiers, count) {
  const list = Array.isArray(tiers) ? tiers : [];
  // Goal is the entry count of the highest tier (e.g. 200).
  const sortedMins = list
    .map((t) => Number(t?.min_count || 0))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const goalCount = sortedMins.length ? Math.max(1, sortedMins[sortedMins.length - 1]) : 200;
  const n = Math.max(0, Number(count || 0));
  const filled = Math.max(0, Math.min(100, (n / goalCount) * 100));

  const boundaries = sortedMins
    .filter((v) => v > 0 && v < goalCount)
    .map((v) => (v / goalCount) * 100);
  const fillColor = "#1a90d0";
  const bgColor = "#dbe8f4";
  const parts = [];
  if (filled > 0) parts.push(`${fillColor} 0% ${filled}%`);
  if (filled < 100) parts.push(`${bgColor} ${filled}% 100%`);
  return `conic-gradient(${parts.join(", ")})`;
}

function tierBoundaryAngles_(tiers) {
  const list = Array.isArray(tiers) ? tiers : [];
  const sortedMins = list
    .map((t) => Number(t?.min_count || 0))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const goalCount = sortedMins.length ? Math.max(1, sortedMins[sortedMins.length - 1]) : 200;
  const boundaries = sortedMins.filter((v) => v > 0 && v < goalCount);
  return boundaries.map((v) => ((v / goalCount) * 360) - 90);
}

function buildAdminStaffOptionsHtml_(staffOptions, selectedStaffId, actorStaffId) {
  const sid = String(selectedStaffId || "").trim();
  const me = String(actorStaffId || "").trim();
  const options = [
    `<option value="${escapeHtml(SUMMARY_STORE_TARGET_)}"${sid === SUMMARY_STORE_TARGET_ ? " selected" : ""}>店舗データ</option>`,
    me ? `<option value="${escapeHtml(me)}"${sid === me ? " selected" : ""}>自分のデータ</option>` : "",
  ].filter(Boolean);
  const list = Array.isArray(staffOptions) ? staffOptions : [];
  list.forEach((row) => {
    const id = String((row && (row.staff_id || row.id)) || "").trim();
    const name = String((row && row.name) || id).trim();
    if (!id || id === me) return;
    const selected = id === sid ? " selected" : "";
    options.push(`<option value="${escapeHtml(id)}"${selected}>${escapeHtml(`${name} (${id})`)}</option>`);
  });
  return options.join("");
}

function totalEstimatedReward_(summary) {
  const paidReward = Number(summary?.estimated_reward || 0) || 0;
  const uncollectedReward = Number(summary?.uncollected_estimated_reward || 0) || 0;
  return Number(summary?.estimated_total_reward ?? (paidReward + uncollectedReward)) || 0;
}

function summaryDetailLinesText_(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return list.map((line) => {
    const label = String(line?.label || "(名称未設定)").trim();
    const amount = Number(line?.unit_price_snapshot || 0) || 0;
    return `${label} ${formatMoney_(amount)}円`;
  }).join(" / ");
}

function renderSummaryDetailModalBody_(detail) {
  const rows = Array.isArray(detail?.rows) ? detail.rows : [];
  const tableRows = rows.map((row, idx) => {
    const markers = row?.markers || {};
    const notes = [
      markers.invoice_discount_not_allocated ? "請求書全体割引あり" : "",
      markers.refund_detected ? "返金検知" : "",
      markers.no_invoice_lines ? "明細なし" : "",
    ].filter(Boolean).join(" / ");
    return `
      <tr>
        <td class="nowrap text-right">${escapeHtml(String(idx + 1))}</td>
        <td class="nowrap">${escapeHtml(formatDateTimeJstShort_(row?.start_time))}</td>
        <td class="summary-detail-customer">${escapeHtml(String(row?.customer_name || "-"))}</td>
        <td class="nowrap">${escapeHtml(String(row?.billing_status || "-"))}</td>
        <td class="text-right nowrap">${escapeHtml(formatMoney_(Number(row?.base_amount_reference || 0) || 0))}円</td>
        <td class="text-right nowrap">${escapeHtml(formatMoney_(Number(row?.estimated_reward || 0) || 0))}円</td>
        <td class="summary-detail-lines">${escapeHtml(summaryDetailLinesText_(row?.lines) || "-")}</td>
        <td class="summary-detail-note">${escapeHtml(notes || "-")}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="summary-detail-modal">
      <div class="summary-detail-note-box">
        表示額は稼働サマリの計算根拠です。請求書全体割引の按分、最低保証、個別補填はここでは反映していません。
      </div>
      <div class="summary-detail-table-wrap" tabindex="0" aria-label="報酬計算内訳">
        <table class="summary-detail-table">
          <thead>
            <tr>
              <th>No</th>
              <th>日時</th>
              <th>顧客</th>
              <th>請求</th>
              <th>売上ベース</th>
              <th>報酬額</th>
              <th>商品内訳</th>
              <th>注意</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || `<tr><td colspan="8">対象データがありません。</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function heroHtml_(summary, opts = {}) {
  if (!summary) return `<div class="card"><p class="p">データがありません。</p></div>`;
  const count = Number(summary.completed_active_count ?? summary.done_paid_active_count ?? 0) || 0;
  const rate = Number(summary.applied_rate_percent || 0) || 0;
  const paidReward = Number(summary.estimated_reward || 0) || 0;
  const uncollectedReward = Number(summary.uncollected_estimated_reward || 0) || 0;
  const totalReward = totalEstimatedReward_(summary);
  const unpricedCount = Number(summary.uncollected_unpriced_count || 0) || 0;
  const pastDueIncompleteCount = Number(summary.past_due_incomplete_count || 0) || 0;
  const unpricedNote = unpricedCount > 0 ? `金額未確定 ${formatMoney_(unpricedCount)}件` : "";
  const { list: tiers, nextTier, remainingToNext: remaining } = resolveTierProgress_(count, summary?.tiers);
  const motivation = nextTier ? `報酬率アップまであと${remaining}件` : "現在は最高料率帯です";
  const donutGradient = donutGradientByTier_(tiers, count);
  const boundaryAngles = tierBoundaryAngles_(tiers);
  const showAdminStaffSelect = !!opts.showAdminStaffSelect;
  const canOpenDetail = opts.canOpenDetail !== false;
  const selectedStaffId = String(opts.selectedStaffId || "").trim();
  const actorStaffId = String(opts.actorStaffId || "").trim();
  const staffOptionsHtml = buildAdminStaffOptionsHtml_(opts.staffOptions, selectedStaffId, actorStaffId);
  return `
    <div class="card summary-hero">
      <div class="summary-hero-top">
        <span class="summary-pill">${escapeHtml(String(summary.year_month || ""))}</span>
        ${showAdminStaffSelect ? `
          <label class="summary-admin-staff-picker">
            <span class="summary-admin-staff-label">表示スタッフ</span>
            <select id="summaryAdminStaffSelect" class="summary-admin-staff-select">
              ${staffOptionsHtml}
            </select>
          </label>
        ` : ""}
      </div>
      <div class="summary-hero-main">
        <div class="summary-rate-wrap">
          <div class="summary-rate-donut" style="--summary-rate-gradient:${escapeHtml(donutGradient)};">
            ${boundaryAngles.map((angle) => `<span class="summary-rate-mark" style="--summary-rate-mark-angle:${escapeHtml(String(angle))};"></span>`).join("")}
            <div class="summary-rate-center">
              <span class="summary-rate-value">報酬率<span class="summary-rate-number">${escapeHtml(String(Math.round(rate)))}</span>%</span>
            </div>
          </div>
          <p class="summary-hero-sub">${escapeHtml(motivation)}</p>
        </div>
        <div class="summary-hero-metrics">
          <div class="summary-hero-metric">
            <span class="summary-hero-metric-label">稼働件数</span>
            <strong class="summary-hero-metric-value">${escapeHtml(String(count))}<span class="summary-hero-metric-unit">件</span></strong>
          </div>
          <div class="summary-hero-metric">
            <span class="summary-hero-metric-label">回収済み報酬額</span>
            <strong class="summary-hero-metric-value">${escapeHtml(formatMoney_(paidReward))}<span class="summary-hero-metric-unit">円</span></strong>
          </div>
          <div class="summary-hero-metric">
            <span class="summary-hero-metric-label">未回収稼働分 報酬見込${unpricedNote ? `<span class="summary-hero-metric-note">${escapeHtml(unpricedNote)}</span>` : ""}</span>
            <strong class="summary-hero-metric-value">${escapeHtml(formatMoney_(uncollectedReward))}<span class="summary-hero-metric-unit">円</span></strong>
          </div>
          <div class="summary-hero-metric">
            <span class="summary-hero-metric-label">当月概算報酬額</span>
            <strong class="summary-hero-metric-value">${escapeHtml(formatMoney_(totalReward))}<span class="summary-hero-metric-unit">円</span></strong>
          </div>
          <div class="summary-hero-metric summary-hero-metric-alert">
            <span class="summary-hero-metric-label">過日未完了件数</span>
            <strong class="summary-hero-metric-value">${escapeHtml(formatMoney_(pastDueIncompleteCount))}<span class="summary-hero-metric-unit">件</span></strong>
          </div>
        </div>
      </div>
      ${canOpenDetail ? `<div class="summary-hero-actions">
        <button type="button" class="btn btn-ghost summary-detail-open" data-summary-detail-open="1">内訳を表示</button>
      </div>` : ""}
    </div>
  `;
}

function tierRowsHtml_(summary) {
  const count = Number(summary?.completed_active_count ?? summary?.done_paid_active_count ?? 0) || 0;
  const { list: tiers, currentTier, nextTier } = resolveTierProgress_(count, summary?.tiers);
  return tiers.map((t) => {
    const min = Number(t?.min_count || 0);
    const max = t?.max_count == null ? null : Number(t?.max_count);
    const tierRate = Number(t?.rate_percent || 0);
    const isCurrent = currentTier && Number(currentTier.min_count) === min;
    const isNext = nextTier && Number(nextTier.min_count) === min;
    const statusLabel = isCurrent ? "適用中" : (isNext ? "次の料率" : "");
    const statusClass = isCurrent ? "is-current" : (isNext ? "is-next" : "");
    return `
      <div class="summary-tier-row ${statusClass}">
        <span class="summary-tier-range">${escapeHtml(max == null ? `${min}件〜` : `${min}〜${max}件`)}</span>
        <div class="summary-tier-rate-wrap">
          <strong class="summary-tier-rate">${escapeHtml(tierRate.toFixed(2))}%</strong>
          ${statusLabel ? `<span class="summary-tier-status ${statusClass}">${escapeHtml(statusLabel)}</span>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function toMonthlyPoint_(summary, ym) {
  const parsed = parseYm_(ym);
  const month = parsed ? parsed.month : 0;
  const year = parsed ? parsed.year : 0;
  const count = Number(summary?.completed_active_count ?? summary?.done_paid_active_count ?? 0) || 0;
  const reward = totalEstimatedReward_(summary);
  const showYear = month === 1;
  return {
    key: ym,
    label: `${month}月`,
    subLabel: showYear ? String(year) : "",
    periodLabel: formatYmJp_(ym),
    count,
    reward,
    summary,
    latestYm: ym,
  };
}

function aggregateYearly_(monthlyPoints) {
  const map = new Map();
  monthlyPoints.forEach((p) => {
    const parsed = parseYm_(p.key);
    if (!parsed) return;
    const y = String(parsed.year);
    const cur = map.get(y) || { key: y, label: String(parsed.year), subLabel: "", periodLabel: `${parsed.year}年`, count: 0, reward: 0, latestYm: "" };
    cur.count += Number(p.count || 0);
    cur.reward += Number(p.reward || 0);
    if (!cur.latestYm || p.key > cur.latestYm) cur.latestYm = p.key;
    map.set(y, cur);
  });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function barHeightPercent_(value, maxValue) {
  const v = Number(value || 0);
  const max = Math.max(1, Number(maxValue || 0));
  if (v <= 0) return 0;
  return Math.max(6, Math.min(100, Math.round((v / max) * 100)));
}

function axisMaxByStep_(maxValue, step) {
  const s = Math.max(1, Number(step || 50000));
  const m = Math.max(0, Number(maxValue || 0));
  return Math.max(s, Math.ceil(m / s) * s);
}

function formatYTickLabel_(value) {
  const n = Math.max(0, Number(value || 0));
  if (n === 0) return "0円";
  if (n % 10000 === 0) return `${n / 10000}万円`;
  return `${formatMoney_(n)}円`;
}

function firstVisibleBarKey_(viewportEl, barsEl) {
  const items = Array.from(barsEl.querySelectorAll(".summary-trend-bar"));
  if (!items.length) return "";
  const vpRect = viewportEl.getBoundingClientRect();
  const leftEdge = vpRect.left + 1;
  for (let i = 0; i < items.length; i += 1) {
    const el = items[i];
    const r = el.getBoundingClientRect();
    if (r.right >= leftEdge) return String(el.dataset.key || "");
  }
  return String(items[items.length - 1].dataset.key || "");
}

function barOffsetLeft_(viewportEl, barsEl, key) {
  const selector = `.summary-trend-bar[data-key="${CSS.escape(String(key || ""))}"]`;
  const barEl = barsEl.querySelector(selector);
  if (!barEl) return null;
  const vpRect = viewportEl.getBoundingClientRect();
  const barRect = barEl.getBoundingClientRect();
  return barRect.left - vpRect.left;
}

function shouldShowMonthlyLabel_(monthNumber) {
  const month = Number(monthNumber || 0);
  if (month <= 0) return false;
  return month === 1 || (month % 2 === 1);
}

function setActiveBar_(host, key) {
  const items = Array.from(host.querySelectorAll(".summary-trend-bar"));
  items.forEach((el) => {
    const active = String(el.dataset.key || "") === key;
    el.classList.toggle("is-active", active);
    if (active) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
  });
}

function selectedStaffId_() {
  const user = getUser() || {};
  const fromCtx = String(user.staff_id || "").trim();
  const role = String(user.role || "").toLowerCase();
  let fromHash = "";
  try {
    const hash = String(location.hash || "");
    const queryPart = hash.includes("?") ? hash.split("?")[1] : "";
    const q = new URLSearchParams(queryPart || "");
    fromHash = String(q.get("staff_id") || "").trim();
  } catch (_) {
    fromHash = "";
  }
  if (role === "staff") return fromCtx;
  if (role === "admin") return fromHash || SUMMARY_STORE_TARGET_;
  return fromCtx || fromHash;
}

function updateSummaryHashStaffId_(staffId) {
  const hashRaw = String(location.hash || "#/summary");
  const [pathRaw, queryRaw = ""] = hashRaw.replace(/^#/, "").split("?");
  const path = pathRaw || "/summary";
  const q = new URLSearchParams(queryRaw || "");
  const sid = String(staffId || "").trim();
  if (sid) q.set("staff_id", sid);
  else q.delete("staff_id");
  const next = `#${path}${q.toString() ? `?${q.toString()}` : ""}`;
  if (next !== hashRaw) location.hash = next;
}

async function fetchMonthlySummaries_(idToken, keys, staffId) {
  const yms = Array.isArray(keys) ? keys.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!yms.length) return { byYm: {}, errorCount: 0 };
  const byYm = {};
  let errorCount = 0;
  try {
    const payload = { year_months: yms };
    if (staffId) payload.staff_id = staffId;
    const bulk = await portalSummaryMonthlyBulk_(idToken, payload);
    const rows = Array.isArray(bulk?.rows) ? bulk.rows : [];
    rows.forEach((row) => {
      const ym = String(row?.year_month || "").trim();
      if (!ym) return;
      byYm[ym] = row;
    });
    yms.forEach((ym) => {
      if (Object.prototype.hasOwnProperty.call(byYm, ym)) return;
      errorCount += 1;
      byYm[ym] = null;
    });
  } catch (_) {
    errorCount = 0;
    const tasks = yms.map(async (ym) => {
      try {
        const payload = { year_month: ym };
        if (staffId) payload.staff_id = staffId;
        const res = await portalSummaryMonthly_(idToken, payload);
        return { ym, summary: res || null };
      } catch (e) {
        errorCount += 1;
        return { ym, summary: null, error: e };
      }
    });
    const rows = await Promise.all(tasks);
    rows.forEach((r) => {
      byYm[r.ym] = r.summary || null;
    });
  }
  yms.forEach((ym) => {
    byYm[ym] = byYm[ym] || {
      ok: true,
      year_month: ym,
      done_paid_active_count: 0,
      completed_active_count: 0,
      reservation_active_count: 0,
      past_due_incomplete_count: 0,
      estimated_reward: 0,
      uncollected_estimated_reward: 0,
      estimated_total_reward: 0,
      uncollected_unpriced_count: 0,
      applied_rate_percent: 55,
      tiers: DEFAULT_TIERS_,
      applied_plan: { name: "デフォルト料率" },
      refund_markers: {
        refund_detected_count: 0,
        partial_refund_count: 0,
        full_refund_count: 0,
      },
    };
  });
  return { byYm, errorCount };
}

function toStaffLabel_(row, fallbackId = "") {
  const id = String((row && (row.staff_id || row.id)) || fallbackId || "").trim();
  const name = String((row && row.name) || "").trim();
  return name || id || "-";
}

function storeSummaryHtml_(storeSummary, staffRows, opts = {}) {
  const yearMonth = String(storeSummary?.year_month || "").trim();
  const reservationCount = Number(storeSummary?.reservation_count || 0) || 0;
  const completionRate = Number(storeSummary?.completion_rate_percent || 0) || 0;
  const paidSalesAmount = Number(storeSummary?.paid_sales_amount || 0) || 0;
  const uncollectedAmount = Number(storeSummary?.uncollected_amount || 0) || 0;
  const showAdminStaffSelect = !!opts.showAdminStaffSelect;
  const selectedStaffId = String(opts.selectedStaffId || "").trim();
  const actorStaffId = String(opts.actorStaffId || "").trim();
  const staffOptionsHtml = buildAdminStaffOptionsHtml_(opts.staffOptions, selectedStaffId, actorStaffId);
  return `
    <section class="section">
      <h1 class="h1">稼働サマリ</h1>
      <div class="card summary-hero mt-10">
        <div class="summary-hero-top">
          <span class="summary-pill">${escapeHtml(yearMonth)}</span>
          ${showAdminStaffSelect ? `
            <label class="summary-admin-staff-picker">
              <span class="summary-admin-staff-label">表示スタッフ</span>
              <select id="summaryAdminStaffSelect" class="summary-admin-staff-select">
                ${staffOptionsHtml}
              </select>
            </label>
          ` : ""}
        </div>
        <div class="summary-kpi-grid">
          <div class="summary-kpi-item"><span class="summary-kpi-label">予約件数</span><strong class="summary-kpi-value">${escapeHtml(formatMoney_(reservationCount))}件</strong></div>
          <div class="summary-kpi-item"><span class="summary-kpi-label">予約完了率</span><strong class="summary-kpi-value">${escapeHtml(String(Math.round(completionRate)))}%</strong></div>
          <div class="summary-kpi-item"><span class="summary-kpi-label">売上：完了/入金済み予約</span><strong class="summary-kpi-value">${escapeHtml(formatMoney_(paidSalesAmount))}円</strong></div>
          <div class="summary-kpi-item"><span class="summary-kpi-label">未収金</span><strong class="summary-kpi-value">${escapeHtml(formatMoney_(uncollectedAmount))}円</strong></div>
        </div>
      </div>
      <div class="card mt-10">
        <div class="row"><strong>現場オペ（スタッフ別）</strong></div>
        <div class="summary-ops-table">
          <div class="summary-ops-head">
            <span>スタッフ</span><span class="text-right">稼働件数</span><span class="text-right">適用率</span><span class="text-right">当月概算報酬額</span>
          </div>
          ${(Array.isArray(staffRows) ? staffRows : []).map((row) => `
            <div class="summary-ops-row">
              <span>${escapeHtml(toStaffLabel_(row, row.staff_id))}</span>
              <span class="text-right">${escapeHtml(formatMoney_(row.completed_active_count ?? row.done_paid_active_count ?? 0))}件</span>
              <span class="text-right">${escapeHtml(String(Math.round(Number(row.applied_rate_percent || 0))))}%</span>
              <span class="text-right">${escapeHtml(formatMoney_(totalEstimatedReward_(row)))}円</span>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

export async function renderSummaryPage(appEl) {
  const idToken = getIdToken();
  if (!idToken) {
    render(appEl, `<section class="section"><h1 class="h1">稼働サマリ</h1><div class="card"><p class="p">ログイン情報がありません。再ログインしてください。</p></div></section>`);
    return;
  }

  const user = getUser() || {};
  const role = String(user.role || "").toLowerCase();
  const isAdmin = role === "admin";
  const actorStaffId = String(user.staff_id || "").trim();
  const staffId = selectedStaffId_();
  const anchorYm = currentYearMonthJst_();
  const INITIAL_MONTHS = 12;
  const monthKeys = monthKeys_(anchorYm, INITIAL_MONTHS);
  let adminStaffOptions = [];
  if (isAdmin) {
    try {
      const staffs = await portalSearchStaffs_(idToken);
      adminStaffOptions = Array.isArray(staffs) ? staffs : [];
    } catch (_) {
      adminStaffOptions = [];
    }
  }
  if (isAdmin && staffId === SUMMARY_STORE_TARGET_) {
    let storeSummary = null;
    try {
      storeSummary = await portalSummaryAdminMonthly_(idToken, { year_month: anchorYm });
    } catch (_) {
      storeSummary = {
        ok: true,
        year_month: anchorYm,
        reservation_count: 0,
        completion_rate_percent: 0,
        paid_sales_amount: 0,
        uncollected_amount: 0,
      };
    }
    const staffRows = (await Promise.all((adminStaffOptions || []).map(async (row) => {
      const sid = String((row && (row.staff_id || row.id)) || "").trim();
      if (!sid) return null;
      try {
        const summary = await portalSummaryMonthly_(idToken, { year_month: anchorYm, staff_id: sid });
        const normalized = Object.assign({}, summary || {}, { staff_id: sid, name: toStaffLabel_(row, sid) });
        if (actorStaffId && sid === actorStaffId) {
          normalized.applied_rate_percent = 100;
          normalized.estimated_reward = Number(normalized.base_amount_reference || 0) || 0;
          normalized.uncollected_estimated_reward = Number(normalized.uncollected_base_amount_reference || 0) || 0;
          normalized.estimated_total_reward = normalized.estimated_reward + normalized.uncollected_estimated_reward;
        }
        return normalized;
      } catch (_) {
        return {
          staff_id: sid,
          name: toStaffLabel_(row, sid),
          done_paid_active_count: 0,
          completed_active_count: 0,
          applied_rate_percent: 0,
          estimated_reward: 0,
          uncollected_estimated_reward: 0,
          estimated_total_reward: 0,
        };
      }
    })))
      .filter(Boolean)
      .sort((a, b) => {
        const bc = Number(b.completed_active_count ?? b.done_paid_active_count ?? 0);
        const ac = Number(a.completed_active_count ?? a.done_paid_active_count ?? 0);
        const c = bc - ac;
        if (c !== 0) return c;
        return totalEstimatedReward_(b) - totalEstimatedReward_(a);
      });
    render(appEl, storeSummaryHtml_(storeSummary, staffRows, {
      showAdminStaffSelect: true,
      selectedStaffId: staffId,
      actorStaffId,
      staffOptions: adminStaffOptions,
    }));
    const selectEl = appEl.querySelector("#summaryAdminStaffSelect");
    if (selectEl) {
      selectEl.addEventListener("change", () => {
        updateSummaryHashStaffId_(String(selectEl.value || "").trim());
      });
    }
    return;
  }
  render(appEl, `
    <section class="section">
      <h1 class="h1">稼働サマリ</h1>
      <div id="summaryHeroHost" class="mt-10"><div class="card"><p class="p">読み込み中...</p></div></div>
      <div class="card summary-trend-card mt-10">
        <div class="summary-trend-head">
          <h2 id="summaryTrendPeriod" class="summary-trend-period">-</h2>
          <div class="summary-trend-kpi">
            <div class="summary-trend-kpi-item">
              <span class="summary-trend-kpi-label">稼働件数</span>
              <strong id="summaryTrendCount" class="summary-trend-kpi-value">0件</strong>
            </div>
            <div class="summary-trend-kpi-item">
              <span class="summary-trend-kpi-label">当月概算報酬額</span>
              <strong id="summaryTrendReward" class="summary-trend-kpi-value text-right">0円</strong>
            </div>
          </div>
        </div>
        <div class="summary-trend-tabs" role="tablist" aria-label="推移表示単位">
          <button id="summaryModeMonthly" type="button" class="summary-trend-tab is-active" role="tab" aria-selected="true">月次</button>
          <button id="summaryModeYearly" type="button" class="summary-trend-tab" role="tab" aria-selected="false">年次</button>
        </div>
        <div class="summary-trend-plot">
          <div id="summaryTrendYAxis" class="summary-trend-y-axis"></div>
          <div class="summary-trend-chart-wrap">
            <div id="summaryTrendGrid" class="summary-trend-grid"></div>
            <div id="summaryTrendViewport" class="summary-trend-viewport">
              <div id="summaryTrendBars" class="summary-trend-bars"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="card grid-8">
        <div class="row"><strong>返金マーカー（参考）</strong></div>
        <div class="row"><span class="muted minw-140">返金検知</span><strong id="summaryRefundDetected">0件</strong></div>
        <div class="row"><span class="muted minw-140">一部返金</span><strong id="summaryRefundPartial">0件</strong></div>
        <div class="row"><span class="muted minw-140">全額返金</span><strong id="summaryRefundFull">0件</strong></div>
      </div>
      <div class="card card-warning">
        <p class="p">本画面の報酬は参考値です。品質評価による料率調整、および外部管理データによる再調整は反映していません。</p>
      </div>
    </section>
  `);

  const heroHost = appEl.querySelector("#summaryHeroHost");
  const periodEl = appEl.querySelector("#summaryTrendPeriod");
  const countEl = appEl.querySelector("#summaryTrendCount");
  const rewardEl = appEl.querySelector("#summaryTrendReward");
  const monthTabEl = appEl.querySelector("#summaryModeMonthly");
  const yearTabEl = appEl.querySelector("#summaryModeYearly");
  const yAxisEl = appEl.querySelector("#summaryTrendYAxis");
  const viewportEl = appEl.querySelector("#summaryTrendViewport");
  const gridEl = appEl.querySelector("#summaryTrendGrid");
  const barsEl = appEl.querySelector("#summaryTrendBars");
  const refundDetectedEl = appEl.querySelector("#summaryRefundDetected");
  const refundPartialEl = appEl.querySelector("#summaryRefundPartial");
  const refundFullEl = appEl.querySelector("#summaryRefundFull");
  if (!heroHost || !periodEl || !countEl || !rewardEl || !monthTabEl || !yearTabEl || !yAxisEl || !viewportEl || !gridEl || !barsEl || !refundDetectedEl || !refundPartialEl || !refundFullEl) return;

  const trendBundle = await fetchMonthlySummaries_(idToken, monthKeys, staffId);
  const byYm = trendBundle.byYm || {};
  if (isAdmin && actorStaffId && staffId === actorStaffId) {
    Object.keys(byYm).forEach((ym) => {
      const row = byYm[ym];
      if (!row || typeof row !== "object") return;
      row.applied_rate_percent = 100;
      row.estimated_reward = Number(row.base_amount_reference || 0) || 0;
      row.uncollected_estimated_reward = Number(row.uncollected_base_amount_reference || 0) || 0;
      row.estimated_total_reward = row.estimated_reward + row.uncollected_estimated_reward;
      row.applied_plan = Object.assign({}, row.applied_plan || {}, { name: "管理者本人（売上表示）" });
    });
  }
  const monthlyPoints = monthKeys.map((ym) => toMonthlyPoint_(byYm[ym], ym));
  const yearlyPoints = aggregateYearly_(monthlyPoints);
  const state = {
    mode: "monthly",
    monthlyKeys: monthKeys.slice(),
    monthlyPoints,
    yearlyPoints,
    selectedKey: anchorYm,
  };
  const LOAD_MONTH_CHUNK = 12;
  const LEFT_EDGE_THRESHOLD = 12;
  let loadingOlder = false;
  let pendingOlderLoad = false;

  const summaryByPoint_ = (point) => {
    if (!point) return null;
    const ym = state.mode === "monthly" ? point.key : point.latestYm;
    return byYm[ym] || null;
  };

  const currentPoints_ = () => state.mode === "yearly" ? state.yearlyPoints : state.monthlyPoints;

  const rebuildMonthlySeries_ = () => {
    state.monthlyPoints = state.monthlyKeys.map((ym) => toMonthlyPoint_(byYm[ym], ym));
    state.yearlyPoints = aggregateYearly_(state.monthlyPoints);
  };

  const openSummaryDetail_ = async (summary) => {
    const ym = String(summary?.year_month || "").trim();
    if (!ym || !staffId || staffId === SUMMARY_STORE_TARGET_) return;
    try {
      const detail = await runWithLoading_({
        title: "内訳を取得しています",
        busyText: "計算根拠を読み込み中...",
      }, () => portalSummaryMonthlyDetail_(idToken, { year_month: ym, staff_id: staffId }));
      await showModal({
        title: "当月概算報酬額の内訳",
        bodyHtml: renderSummaryDetailModalBody_(detail),
        okText: "閉じる",
        cancelText: "",
      });
    } catch (e) {
      console.error(e);
      toast({ title: "取得失敗", message: "報酬内訳を取得できませんでした。", tone: "danger" });
    }
  };

  const updateDetail_ = () => {
    const points = currentPoints_();
    const selected = points.find((p) => p.key === state.selectedKey) || points[points.length - 1] || null;
    if (!selected) return;
    state.selectedKey = selected.key;
    const summary = summaryByPoint_(selected);
    heroHost.innerHTML = heroHtml_(summary, {
      showAdminStaffSelect: isAdmin,
      selectedStaffId: staffId,
      actorStaffId,
      staffOptions: adminStaffOptions,
      canOpenDetail: !!summary && staffId !== SUMMARY_STORE_TARGET_,
    });
    if (isAdmin) {
      const selectEl = heroHost.querySelector("#summaryAdminStaffSelect");
      if (selectEl && !selectEl.dataset.bound) {
        selectEl.dataset.bound = "1";
        selectEl.addEventListener("change", () => {
          const nextStaffId = String(selectEl.value || "").trim();
          updateSummaryHashStaffId_(nextStaffId);
        });
      }
    }
    const detailBtn = heroHost.querySelector("[data-summary-detail-open]");
    if (detailBtn && !detailBtn.dataset.bound) {
      detailBtn.dataset.bound = "1";
      detailBtn.addEventListener("click", () => {
        void openSummaryDetail_(summary);
      });
    }
    periodEl.textContent = selected.periodLabel;
    countEl.textContent = `${formatMoney_(selected.count)}件`;
    rewardEl.textContent = `${formatMoney_(selected.reward)}円`;
    setActiveBar_(barsEl, state.selectedKey);
    const markers = summary?.refund_markers || {};
    refundDetectedEl.textContent = `${formatMoney_(Number(markers.refund_detected_count || 0) || 0)}件`;
    refundPartialEl.textContent = `${formatMoney_(Number(markers.partial_refund_count || 0) || 0)}件`;
    refundFullEl.textContent = `${formatMoney_(Number(markers.full_refund_count || 0) || 0)}件`;
  };

  const renderBars_ = () => {
    const step = state.mode === "yearly" ? 500000 : 50000;
    const points = currentPoints_();
    const maxReward = Math.max(1, ...points.map((p) => Number(p.reward || 0)));
    const hasReward = points.some((p) => Number(p.reward || 0) > 0);
    const axisMax = axisMaxByStep_(maxReward, step);
    const ticks = [];
    for (let v = axisMax; v >= 0; v -= step) ticks.push(v);
    yAxisEl.innerHTML = ticks.map((v) => `<span class="summary-trend-y-tick">${escapeHtml(formatYTickLabel_(v))}</span>`).join("");
    const gridStep = ticks.length > 1 ? (100 / (ticks.length - 1)) : 100;
    gridEl.style.setProperty("--trend-grid-step", `${gridStep}%`);
    viewportEl.setAttribute("data-empty", hasReward ? "false" : "true");
    viewportEl.classList.toggle("is-monthly", state.mode === "monthly");
    viewportEl.classList.toggle("is-yearly", state.mode === "yearly");
    barsEl.classList.toggle("is-monthly", state.mode === "monthly");
    barsEl.classList.toggle("is-yearly", state.mode === "yearly");
    barsEl.style.setProperty("--bar-count", String(points.length || 0));
    if (state.mode === "monthly") {
      const viewportWidth = Math.max(180, Number(viewportEl.clientWidth || 0));
      const computedGap = Number.parseFloat(getComputedStyle(barsEl).getPropertyValue("--monthly-gap"));
      const gapPx = Number.isFinite(computedGap) ? computedGap : 4;
      const colPx = Math.max(18, Math.floor((viewportWidth - (11 * gapPx)) / 12));
      const totalWidth = (Math.max(1, points.length) * colPx) + (Math.max(0, points.length - 1) * gapPx);
      const totalWidthPx = `${Math.round(totalWidth)}px`;
      barsEl.style.setProperty("--monthly-col-px", `${colPx}px`);
      barsEl.style.setProperty("--monthly-total-width", totalWidthPx);
      barsEl.style.minWidth = totalWidthPx;
      barsEl.style.width = totalWidthPx;
    } else {
      barsEl.style.removeProperty("--monthly-col-px");
      barsEl.style.removeProperty("--monthly-total-width");
      barsEl.style.removeProperty("min-width");
      barsEl.style.removeProperty("width");
    }
    barsEl.innerHTML = points.map((p) => {
      const active = p.key === state.selectedKey ? " is-active" : "";
      const h = barHeightPercent_(p.reward, axisMax);
      const monthPart = parseYm_(p.key)?.month || 0;
      const showMonthLabel = state.mode !== "monthly" || shouldShowMonthlyLabel_(monthPart);
      const monthLabel = showMonthLabel ? p.label : "";
      const fillStyle = h > 0
        ? `height:${escapeHtml(String(h))}%;`
        : "height:0%;border-width:0;background:transparent;";
      return `
        <div class="summary-trend-bar${active}" data-key="${escapeHtml(p.key)}" role="button" tabindex="0" aria-label="${escapeHtml(p.periodLabel)}">
          <span class="summary-trend-bar-fill" style="${fillStyle}"></span>
          <span class="summary-trend-bar-label">${escapeHtml(monthLabel)}</span>
          <span class="summary-trend-bar-sub">${escapeHtml(p.subLabel)}</span>
        </div>
      `;
    }).join("");
  };

  const loadOlderMonths_ = async () => {
    if (loadingOlder) {
      pendingOlderLoad = true;
      return;
    }
    if (state.mode !== "monthly") return;
    const oldestYm = state.monthlyKeys[0];
    if (!oldestYm) return;
    loadingOlder = true;
    pendingOlderLoad = false;
    const anchorVisibleKey = firstVisibleBarKey_(viewportEl, barsEl);
    const anchorOffsetBefore = barOffsetLeft_(viewportEl, barsEl, anchorVisibleKey);
    const prevScrollWidth = barsEl.scrollWidth;
    const anchorOlderYm = shiftYm_(oldestYm, -1);
    const olderKeys = monthKeys_(anchorOlderYm, LOAD_MONTH_CHUNK);
    const missingKeys = olderKeys.filter((ym) => !Object.prototype.hasOwnProperty.call(byYm, ym));
    try {
      if (missingKeys.length) {
        const bundle = await fetchMonthlySummaries_(idToken, missingKeys, staffId);
        Object.assign(byYm, bundle.byYm || {});
        if (Number(bundle.errorCount || 0) > 0) {
          toast({ title: "一部取得失敗", message: "一部の月の集計取得に失敗したため、0件で表示しています。" });
        }
      }
      state.monthlyKeys = [...olderKeys, ...state.monthlyKeys];
      rebuildMonthlySeries_();
      renderBars_();
      updateDetail_();
      requestAnimationFrame(() => {
        const anchorOffsetAfter = barOffsetLeft_(viewportEl, barsEl, anchorVisibleKey);
        if (anchorOffsetBefore != null && anchorOffsetAfter != null) {
          viewportEl.scrollLeft += (anchorOffsetAfter - anchorOffsetBefore);
          return;
        }
        const delta = barsEl.scrollWidth - prevScrollWidth;
        if (delta > 0) viewportEl.scrollLeft += delta;
      });
    } finally {
      loadingOlder = false;
      if (pendingOlderLoad && viewportEl.scrollLeft <= LEFT_EDGE_THRESHOLD) {
        pendingOlderLoad = false;
        void loadOlderMonths_();
      }
    }
  };

  const switchMode_ = (mode) => {
    const prevMode = state.mode;
    state.mode = mode === "yearly" ? "yearly" : "monthly";
    const points = currentPoints_();
    if (!points.find((p) => p.key === state.selectedKey)) {
      const fallback = points[points.length - 1] || null;
      state.selectedKey = fallback ? fallback.key : "";
    }
    monthTabEl.classList.toggle("is-active", state.mode === "monthly");
    yearTabEl.classList.toggle("is-active", state.mode === "yearly");
    monthTabEl.setAttribute("aria-selected", state.mode === "monthly" ? "true" : "false");
    yearTabEl.setAttribute("aria-selected", state.mode === "yearly" ? "true" : "false");
    renderBars_();
    updateDetail_();
    if (state.mode === "monthly" && prevMode !== "monthly") {
      requestAnimationFrame(async () => {
        if (viewportEl.scrollWidth <= (viewportEl.clientWidth + 2)) {
          await loadOlderMonths_();
        }
        viewportEl.scrollLeft = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
      });
    }
  };

  let ignoreNextBarClick = false;
  barsEl.addEventListener("click", (ev) => {
    if (ignoreNextBarClick) {
      ignoreNextBarClick = false;
      return;
    }
    const btn = ev.target instanceof Element ? ev.target.closest(".summary-trend-bar") : null;
    if (!btn) return;
    state.selectedKey = String(btn.getAttribute("data-key") || "");
    updateDetail_();
  });
  barsEl.addEventListener("keydown", (ev) => {
    if (!(ev.target instanceof Element)) return;
    const bar = ev.target.closest(".summary-trend-bar");
    if (!bar) return;
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    state.selectedKey = String(bar.getAttribute("data-key") || "");
    updateDetail_();
  });

  viewportEl.addEventListener("scroll", () => {
    if (state.mode === "monthly" && viewportEl.scrollLeft <= LEFT_EDGE_THRESHOLD) {
      void loadOlderMonths_();
    }
  }, { passive: true });

  viewportEl.addEventListener("wheel", (ev) => {
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
    viewportEl.scrollLeft += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });

  if (matchMedia("(pointer:fine)").matches) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startLeft = 0;
    viewportEl.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      moved = false;
      startX = ev.clientX;
      startLeft = viewportEl.scrollLeft;
    });
    addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) >= 3) moved = true;
      viewportEl.scrollLeft = startLeft - dx;
    });
    addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      if (moved) ignoreNextBarClick = true;
    });
  }

  monthTabEl.addEventListener("click", () => switchMode_("monthly"));
  yearTabEl.addEventListener("click", () => switchMode_("yearly"));

  switchMode_("monthly");
  requestAnimationFrame(async () => {
    if (state.mode === "monthly" && viewportEl.scrollWidth <= (viewportEl.clientWidth + 2)) {
      await loadOlderMonths_();
    }
    viewportEl.scrollLeft = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
  });

  addEventListener("resize", () => {
    renderBars_();
    updateDetail_();
  });

  if (Number(trendBundle.errorCount || 0) >= monthKeys.length) {
    toast({
      title: "集計取得に失敗",
      message: staffId
        ? "集計データを取得できませんでした。再読み込みしてください。"
        : "staff_id が取得できません。再ログインするか、URLに staff_id を指定してください。",
    });
  } else if (Number(trendBundle.errorCount || 0) > 0) {
    toast({ title: "一部取得失敗", message: "一部の月の集計取得に失敗したため、0件で表示しています。" });
  }
}

// Backward-compatible export for older router bundles.
export async function renderSummaryPlaceholder(appEl) {
  return renderSummaryPage(appEl);
}
