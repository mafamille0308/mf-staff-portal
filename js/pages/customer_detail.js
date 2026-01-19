// js/pages/customer_detail.js
import { render, escapeHtml, toast, fmt, displayOrDash, fmtDateTimeJst } from "../ui.js";
import { callGas, unwrapOne } from "../api.js";
import { getIdToken, setUser } from "../auth.js";

const KEY_CD_CACHE_PREFIX = "mf:customer_detail:cache:v1:";
const CD_CACHE_TTL_MS = 2 * 60 * 1000; // 2分

function normStr_(v) {
  const s = fmt(v);
  return (s == null) ? "" : String(s).trim();
}

function pickFirst_(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    const s = normStr_(v);
    if (s) return s;
  }
  return "";
}

function lineBlock_(label, text) {
  const s = normStr_(text);
  if (!s) return "";
  return `
    <div class="hr"></div>
    <div class="p"><strong>${escapeHtml(label)}</strong></div>
    <div class="card">
      <div class="p" style="white-space:pre-wrap;">${escapeHtml(s)}</div>
    </div>
  `;
}

function rawToggle_(rawText) {
  const s = normStr_(rawText);
  if (!s) return "";
  return `
    <div class="hr"></div>
    <details class="details">
      <summary class="p" style="cursor:pointer; user-select:none;">
        <strong>カルテ原本（OCR）</strong>（タップで表示）
      </summary>
      <div class="card" style="margin-top:8px;">
        <div class="p" style="white-space:pre-wrap;">${escapeHtml(s)}</div>
      </div>
    </details>
  `;
}

function renderCareProfile_(cp) {
  if (!cp || typeof cp !== "object") return `<p class="p">お世話情報がありません。</p>`;

  // 互換吸収（段階移行を許容）
  const warnings = pickFirst_(cp, ["warnings", "注意事項"]);
  const raw      = pickFirst_(cp, ["content_raw", "内容原本"]);
  const content  = pickFirst_(cp, ["content", "内容"]);
  const food     = pickFirst_(cp, ["food_care", "ごはん", "ごはんのお世話"]);
  const toilet   = pickFirst_(cp, ["toilet_care", "トイレ", "トイレのお世話"]);
  const walk     = pickFirst_(cp, ["walk_care", "散歩", "散歩のお世話"]);
  const play     = pickFirst_(cp, ["play_care", "遊び", "遊び・お散歩のお世話"]);
  const other    = pickFirst_(cp, ["other_care", "その他", "室内環境・その他", "environment_other"]);

  // どれも無い場合は、旧データの content だけでも表示
  const any = warnings || raw || content || food || toilet || walk || play || other;
  if (!any) return `<p class="p">お世話情報がありません。</p>`;

  // content（要約）は「なくてもいい」方針に合わせ、表示しない（必要になったら復帰可能）
  return `
    ${lineBlock_("注意事項", warnings)}
    ${lineBlock_("ごはん", food)}
    ${lineBlock_("トイレ", toilet)}
    ${lineBlock_("散歩", walk)}
    ${lineBlock_("遊び", play)}
    ${lineBlock_("その他", other)}
    ${rawToggle_(raw)}
  `;
}

function section(title, bodyHtml) {
  return `
    <div class="hr"></div>
    <h2 class="h2">${escapeHtml(title)}</h2>
    <div class="p">${bodyHtml || ""}</div>
  `;
}

function extractCustomerDetail_(obj) {
  if (!obj) return null;

  // 1) まず「本体が直置き」パターン（getCustomerDetail の想定）
  if (obj.customer || obj.pets || obj.careProfile || obj.care_profile) {
    return {
      customer: obj.customer || null,
      pets: Array.isArray(obj.pets) ? obj.pets : [],
      careProfile: obj.careProfile || obj.care_profile || null,
    };
  }

  // 2) 次に「customer_detail の箱」パターン（他API互換）
  const d = obj.customer_detail || obj.customerDetail || obj.result || null;
  if (!d) return null;

  return {
    customer: d.customer || null,
    pets: Array.isArray(d.pets) ? d.pets : [],
    careProfile: d.careProfile || d.care_profile || null,
  };
}

export async function renderCustomerDetail(appEl, query) {
  const customerId = query.get("id") || "";
  if (!customerId) {
    render(appEl, `<section class="section"><h1 class="h1">顧客詳細</h1><p class="p">customer_id が指定されていません。</p></section>`);
    return;
  }

  render(appEl, `
    <section class="section">
      <div class="row row-between">
        <h1 class="h1">顧客詳細</h1>
        <a class="btn btn-ghost" href="#/customers" id="btnBackCustomers">一覧に戻る</a>
      </div>
      <div class="hr"></div>
      <div data-el="host"><p class="p">読み込み中...</p></div>
    </section>
  `);

  // 履歴があれば back 優先
  const backBtn = appEl.querySelector("#btnBackCustomers");
  backBtn?.addEventListener("click", (e) => {
    if (window.history && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
  });

  const host = appEl.querySelector('[data-el="host"]');
  const idToken = getIdToken();
  if (!idToken) {
    host.innerHTML = `<p class="p">ログインしてください。</p>`;
    return;
  }

  // ===== cache（直近に開いた詳細は即表示）=====
  const cacheKey = KEY_CD_CACHE_PREFIX + String(customerId);

  try {
    // cache があれば先に利用（任意：体感改善）
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj.ts && (Date.now() - Number(obj.ts)) <= CD_CACHE_TTL_MS && obj.detail) {
          // ここで即表示したい場合は obj.detail を使って描画しても良い（現状は未使用でOK）
        }
      }
    } catch (_) {}

    const res = await callGas({
      action: "getCustomerDetail",
      customer_id: customerId,
      include_pets: true,
      include_care_profile: true,
    }, idToken);

    if (!res || res.success === false) {
      throw new Error((res && (res.error || res.message)) || "getCustomerDetail failed");
    }
    if (res.ctx) setUser(res.ctx);

    // getCustomerDetail は「直置き」返却を最優先で読む（visit_detail の “unwrap → 本体” の思想を踏襲）
    // 互換：results/result/customer_detail などが来ても吸収
    const detail =
      (res.customer || res.pets || res.careProfile || res.care_profile)
        ? {
            customer: res.customer || null,
            pets: Array.isArray(res.pets) ? res.pets : [],
            careProfile: res.careProfile || res.care_profile || null,
          }
        : extractCustomerDetail_(unwrapOne(res) || res);

    if (!detail || !detail.customer) {
      // 切り分け用：どのキーが存在するかをメッセージに含める
      const keys = res ? Object.keys(res).slice(0, 50).join(", ") : "(no res)";
      throw new Error(`顧客詳細が空です。res keys=[${keys}]`);
    }

    const c = detail.customer;
    const pets = Array.isArray(detail.pets) ? detail.pets : [];
    const cp = detail.careProfile || null;

    // ===== 顧客 =====
    const customerHtml = `
      <div class="card">
        <div class="p">
          <div><strong>顧客ID</strong>：${escapeHtml(displayOrDash(c.id || c.customer_id || customerId))}</div>
          <div><strong>顧客名</strong>：${
            escapeHtml(displayOrDash(c.name))
          }${
            (() => {
              const sk = (c.surname_kana || c.surnameKana || "").trim();
              const gk = (c.given_kana || c.givenKana || "").trim();
              const kk = (sk + gk).trim();
              return kk ? ` <span style="opacity:.75;">(${escapeHtml(kk)})</span>` : "";
            })()
          }</div>
          <div><strong>電話</strong>：${escapeHtml(displayOrDash(c.phone))}</div>
          <div><strong>緊急連絡先</strong>：${escapeHtml(displayOrDash(c.emergency_phone || c.emergencyPhone))}</div>
          <div><strong>メール</strong>：${escapeHtml(displayOrDash(c.email))}</div>
          <div><strong>請求先メール</strong>：${escapeHtml(displayOrDash(c.billing_email || c.billingEmail))}</div>
          <div><strong>郵便番号</strong>：${escapeHtml(displayOrDash(c.postal_code || (c.address_parts && c.address_parts.postal_code)))}</div>
          <div><strong>住所</strong>：${escapeHtml(displayOrDash(c.address_full || c.addressFull || c.address))}</div>
          <div><strong>駐車場</strong>：${escapeHtml(displayOrDash(c.parking_info || c.parkingInfo))}</div>
          <div><strong>鍵受取ルール</strong>：${escapeHtml(displayOrDash(c.key_pickup_rule || c.keyPickupRule))}</div>
          <div><strong>鍵返却ルール</strong>：${escapeHtml(displayOrDash(c.key_return_rule || c.keyReturnRule))}</div>
          <div><strong>鍵の所在</strong>：${escapeHtml(displayOrDash(c.key_location || c.keyLocation))}</div>
          <div><strong>ロック番号</strong>：${escapeHtml(displayOrDash(c.lock_no || c.lockNo))}</div>
          <div><strong>メモ</strong>：${escapeHtml(displayOrDash(c.notes))}</div>
          <div><strong>ステージ</strong>：${escapeHtml(displayOrDash(c.stage))}</div>
          <div><strong>登録日</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(c.registered_date || c.registeredDate)))}</div>
          <div><strong>更新日時</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(c.updated_at || c.updatedAt)))}</div>
        </div>
      </div>
    `;

    // ===== ペット =====
    const petsHtml = pets.length
      ? `
        ${pets.map(p => `
          <div class="card">
            <div class="p">
              <div><strong>${escapeHtml(displayOrDash(p.name || p.pet_name))}</strong></div>
              <div><strong>ペットID</strong>：${escapeHtml(displayOrDash(p.id || p.pet_id))}</div>
              <div><strong>顧客ID</strong>：${escapeHtml(displayOrDash(p.customer_id || customerId))}</div>
              <div><strong>種類</strong>：${escapeHtml(displayOrDash(p.species || p.type || p.pet_type))}</div>
              <div><strong>品種</strong>：${escapeHtml(displayOrDash(p.breed))}</div>
              <div><strong>性別</strong>：${escapeHtml(displayOrDash(p.gender))}</div>
              <div><strong>誕生日</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(p.birthdate)))}</div>
              <div><strong>年齢</strong>：${escapeHtml(displayOrDash(p.age))}</div>
              <div><strong>健康</strong>：${escapeHtml(displayOrDash(p.health))}</div>
              <div><strong>メモ</strong>：${escapeHtml(displayOrDash(p.notes || p.memo))}</div>
              <div><strong>病院</strong>：${escapeHtml(displayOrDash(p.hospital))}</div>
              <div><strong>病院電話</strong>：${escapeHtml(displayOrDash(p.hospital_phone))}</div>
              <div><strong>写真URL</strong>：${escapeHtml(displayOrDash(p.photo_url))}</div>
              <div><strong>登録日</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(p.registered_date)))}</div>
              <div><strong>更新日時</strong>：${escapeHtml(displayOrDash(fmtDateTimeJst(p.updated_at)))}</div>
            </div>
          </div>
        `).join("")}
      `
      : `<p class="p">ペット情報がありません。</p>`;

    // ===== お世話情報 =====
    const careHtml = cp
      ? `${renderCareProfile_(cp)}`
      : `<p class="p">お世話情報がありません。</p>`;

    host.innerHTML = `
      ${section("顧客情報", customerHtml)}
      ${section("ペット情報", petsHtml)}
      ${section("お世話情報", careHtml)}
    `;

    // cache 保存
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), detail }));
    } catch (_) {}
  } catch (e) {
    const msg = e?.message || String(e);
    toast({ title: "取得失敗", message: e?.message || String(e) });
    host.innerHTML = `
      <p class="p">取得に失敗しました。</p>
      <div class="hr"></div>
      <div class="p text-sm">customer_id=${escapeHtml(customerId)}</div>
      <div class="p text-sm">action=getCustomerDetail</div>
      <div class="hr"></div>
      <details class="details">
      <summary class="p" style="cursor:pointer;">debug（エラー内容）</summary>
      <div class="card"><div class="p" style="white-space:pre-wrap;">${escapeHtml(msg)}</div></div>
      </details>
    `;
  }
}
