/* ============================================================
   onboard.js — 新旅團申請接入與部署協助（全前端 App 內完成，毋須存取 Git）
   流程（旅團嗰邊）：
     1. 登入前直接喺 App 內下載或複製 Code.gs（毋須登入、毋須 Git）
     2. 建自己嘅 Google Sheet → 執行 initializeSheets → 複製 API Key
     3. 部署做 Web App（執行身分：我；存取權：任何人）
     4. 喺 App 內填寫「申請接入」自動送出，管理員於系統後台／Vercel 登記後即時生效
   ============================================================ */

import { registry } from './units.js';
import { gasTemplate } from './gastemplate.js';
import { download } from './exporter.js';
import { toast, copyText, icon } from './util.js';

export const APP_TYPE = '82venture';       // 中央收件匣用 appType 分辨來源（同 VSBADGE 共用收件匣）
export const APP_NAME = '深資童軍管理系統';        // 全名，方便管理員喺 ADMIN 系統睇到係邊個 app

/** 登入前／任何時候直接在 App 內下載 Code.gs */
export function downloadCodeGs() {
  download('Code.gs', gasTemplate(), 'text/plain;charset=utf-8');
  toast('已下載 Code.gs（Apps Script 後端程式碼）', 'ok');
}

/** 登入前／任何時候直接複製 Code.gs 原始碼到剪貼簿（方便手機／平板使用） */
export async function copyCodeGs() {
  const code = gasTemplate();
  const ok = await copyText(code);
  if (ok) toast('已複製 Code.gs 全部原始碼到剪貼簿！', 'ok');
  else toast('未能複製，請使用「下載 Code.gs」', 'err');
}

/* 內建嘅中央管理員收件匣（同 api/proxy.js 嘅 SCOUT_ADMIN_API 同一個；同 VSBADGE 共用，
   用 appType 分辨）。data/units.json 有設定就用設定值。 */
export const DEFAULT_ADMIN_INBOX =
  'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';

/** 管理員收件匣（Apps Script /exec） */
export function adminInbox() {
  const a = registry()?.admin || {};
  const url = String(a.submitUrl || '').trim() || DEFAULT_ADMIN_INBOX;
  return {
    name: a.name || '平台管理員收件匣',
    url,
    configured: /^https:\/\/script\.google\.com\/macros\/s\//i.test(url),
    builtin: !String(a.submitUrl || '').trim()
  };
}

const EXEC_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;
const ID_RE = /^[0-9A-Za-z_-]{1,32}$/;

/**
 * 驗證申請內容。
 * @returns {{ok:boolean, errors:string[], payload:object}}
 */
export function validateApplication(input = {}) {
  const errors = [];
  const troopId = String(input.troopId || '').trim();
  const troopName = String(input.troopName || '').trim();
  const scriptUrl = String(input.scriptUrl || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  const contact = String(input.contact || '').trim();
  const note = String(input.note || '').trim();

  if (!troopId) errors.push('請填旅團編號（例：0100）');
  else if (!ID_RE.test(troopId)) errors.push('旅團編號只可以用英數／-_，最長 32 字');
  if (!troopName) errors.push('請填旅團名稱');
  if (!scriptUrl) errors.push('請填你嘅 Apps Script /exec 網址');
  else if (!EXEC_RE.test(scriptUrl)) errors.push('後端網址要係 Google Apps Script 嘅 /exec 正式部署網址（https://script.google.com/macros/s/…/exec）');

  let mainSystemUrl = '';
  try { mainSystemUrl = globalThis.location?.origin || ''; } catch (e) { mainSystemUrl = ''; }

  const payload = {
    troopId: troopId.substring(0, 32),
    troopName: troopName.substring(0, 100),
    scriptUrl: scriptUrl.substring(0, 300),
    apiKey: apiKey.substring(0, 120),
    appType: APP_TYPE,
    appName: APP_NAME,
    mainSystemUrl,
    contact: contact.substring(0, 120),
    note: note.substring(0, 500),
    at: new Date().toISOString()
  };
  return { ok: errors.length === 0, errors, payload };
}

/**
 * 把申請送去中央管理員收件匣 —— 同 VSBADGE 一樣行同源 proxy：
 *   瀏覽器 ──POST /api/proxy (action=submitRegistration)──▶ Vercel ──▶ 管理員收件匣 GAS
 * 目的地固定喺伺服器端（前端改唔到）。
 * 注意：收件匣**唔會回執**（ADMIN 收到之後自己轉寄畀團長，開團後 email 通知旅團），
 * 所以 App 只可以知道「送出去咗」——ADMIN 系統收到就 OK。
 * 冇 /api/proxy（淨靜態部署、GitHub Pages）就 fallback 直接 POST。
 * @returns {{ok:boolean, via:'proxy'|'direct', receipt:boolean, ms:number, payload:object, errors?:string[]}}
 */
async function postViaProxy(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch('api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submitRegistration', ...payload }),
      signal: ctrl.signal
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || typeof j !== 'object') {
      /* 同源冇 /api（靜態部署）→ 話畀呼叫者知，改用直接 POST */
      return { available: false, ms: Date.now() - t0 };
    }
    if (j.success !== false) return { available: true, ok: true, ms: Date.now() - t0 };
    return { available: true, ok: false, ms: Date.now() - t0, errors: [j.error || '管理員收件匣話送唔到'] };
  } catch (e) {
    return { available: false, ms: Date.now() - t0, errors: [e?.name === 'AbortError' ? '逾時' : (e?.message || String(e))] };
  } finally { clearTimeout(timer); }
}

/** 後備：直接 POST 去收件匣（no-cors，瀏覽器唔會畀回執） */
async function postDirectToInbox(payload, timeoutMs) {
  const box = adminInbox();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    await fetch(box.url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    return { ok: true, via: 'direct', receipt: false, ms: Date.now() - t0, payload };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return {
      ok: false, via: 'direct', receipt: false, ms: Date.now() - t0,
      errors: [aborted ? `提交逾時（${Math.round(timeoutMs / 1000)} 秒冇回應）` : (e?.message || String(e))],
      payload
    };
  }
}

/**
 * 送出申請：先經同源 proxy，唔得就自己直接送多一次。
 * 兩條路都只可以確認「送出去咗」——收件匣唔回執（ADMIN 收到就 OK）。
 * @returns {{ok:boolean, via:'proxy'|'direct', receipt:boolean, ms:number, payload:object, errors?:string[]}}
 */
export async function submitApplication(input = {}, timeoutMs = 20000) {
  const v = validateApplication(input);
  if (!v.ok) return { ok: false, via: 'proxy', receipt: false, errors: v.errors, payload: v.payload };
  const box = adminInbox();
  if (!box.configured) {
    return { ok: false, via: 'proxy', receipt: false, errors: ['未設定管理員收件匣（data/units.json → admin.submitUrl）'], payload: v.payload };
  }
  const viaProxy = await postViaProxy(v.payload, timeoutMs);
  if (viaProxy.available && viaProxy.ok) {
    return { ok: true, via: 'proxy', receipt: false, ms: viaProxy.ms, payload: v.payload };
  }
  /* 伺服器路線送唔到（或者根本冇 /api/proxy）→ 自己直接送多一次，
     寧願管理員收到兩次，都好過收唔到（兩條路都唔會有回執，App 只會話「已送出」）。 */
  const direct = await postDirectToInbox(v.payload, timeoutMs);
  if (direct.ok) {
    return {
      ...direct,
      errors: viaProxy.available ? viaProxy.errors : undefined   /* 伺服器路線嘅錯誤，用嚟提示 */
    };
  }
  return {
    ok: false, via: direct.via, receipt: false,
    ms: (viaProxy.ms || 0) + (direct.ms || 0),
    payload: v.payload,
    errors: [...(viaProxy.available ? (viaProxy.errors || []) : []), ...(direct.errors || [])]
  };
}

/** 申請內容純文字版（送唔到時可以 WhatsApp／電郵畀管理員） */
export function applicationText(payload = {}) {
  const p = payload || {};
  return [
    '【新旅團申請接入 · 深資童軍管理系統】',
    `旅團編號：${p.troopId || ''}`,
    `旅團名稱：${p.troopName || ''}`,
    `後端 /exec：${p.scriptUrl || ''}`,
    `API Key：${p.apiKey || '（未填）'}`,
    `聯絡人：${p.contact || '（未填）'}`,
    `主系統網址：${p.mainSystemUrl || ''}`,
    `備註：${p.note || '（無）'}`,
    `送出時間：${p.at || ''}`,
    `appType：${p.appType || APP_TYPE} · app：${p.appName || APP_NAME}`
  ].join('\n');
}

/** 管理員收到申請之後要做嘅嘢（用嚟顯示／複製） */
/**
 * 開新旅團（方法 B：Vercel 環境變數）—— 產生可以直接複製嘅設定
 * @param {string} code 旅團編號（例如 0081）
 * @param {string} name 旅團名稱（可選）
 * @param {string} execUrl 旅團嘅 Apps Script /exec 網址（可選）
 * @param {string} apiKey 旅團嘅 API Key（可選）
 */
export function envUnitTemplate(code = '<編號>', name = '', execUrl = '', apiKey = '') {
  const c = String(code || '<編號>').trim() || '<編號>';
  const url = String(execUrl || '').trim() || 'https://script.google.com/macros/s/AKfy…/exec';
  const key = String(apiKey || '').trim() || '<佢畀你嘅 API Key>';
  const nm = String(name || '').trim() || `第 ${c} 旅深資童軍團`;
  return [
    `TROOP_${c}_BACKEND         = ${url}`,
    `TROOP_${c}_APIKEY          = ${key}`,
    `TROOP_${c}_NAME            = ${nm}`,
    `TROOP_${c}_PROGRESSBACKEND = ${url}`,
    `TROOP_${c}_PROGRESSAPIKEY  = ${key}`
  ].join('\n');
}

/** 貼落 Vercel 嘅逐步指示（同一個來源：教學頁同「帳號與系統」都用呢個） */
export function envUnitSteps(code = '<編號>') {
  return [
    `Vercel → 你嘅專案 → Settings → Environment Variables`,
    `逐個新增上面 5 個變數（Production / Preview / Development 都勾）`,
    `儲存後撳 Deployments → 最新嗰個 → … → Redeploy（環境變數要重新部署先生效）`,
    `部署完打開系統 → 旅團清單應該出現 ${code}`,
    `通知旅團更新 Apps Script 嘅 Code.gs（「資料管理 → 總表同步」下載）＋ 執行一次 initializeSheets`
  ];
}

export function adminChecklist(troopId = '<編號>') {
  return [
    `深資童軍管理系統 → data/units.json：喺 units 加 "${troopId}" entry（code／name／section 等公開資料；唔好放 backend／apiKey 落 Git，亦唔使起資料夾 —— 新旅團由空白開始）`,
    `深資童軍管理系統 → Vercel 環境變數：加 TROOP_${troopId}_BACKEND（旅團嘅 /exec）同 TROOP_${troopId}_APIKEY，再 Redeploy（名單即現身，後端經伺服器端轉發）`,
    `（進度）一個後端、兩個前端：旅團自己嘅後端 /exec 就係進度資料所在；團員用嘅進度前端讀同一個後端`,
    `通知旅團：登入後去「進度 → 設定」填自己嘅 /exec 網址 + API Key，就可以喺執委系統直接讀寫進度`,
    '兩邊 deploy 一次，再由旅團喺「進度」撳「測試連線」實測（讀得到團員同進度就成功）'
  ];
}
