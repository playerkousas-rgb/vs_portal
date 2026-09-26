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
import { toast, copyText, icon, esc, modal } from './util.js';

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
async function postViaProxy(payload, action, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch('api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
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
  const viaProxy = await postViaProxy(v.payload, 'submitRegistration', timeoutMs);
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

/* ============================================================
   求救／問題回報（2026-09-25 團長：「我想要加個求救制，有咩大問題
   SEND 去問 ADMIN，當回報問題處理」）—— 走同「開戶申請」同一條路，
   呢份報告**對正 Scout Admin 嘅「問題回報（TICK）」合約**（圖書館／
   各 APP 都係用同一條 TICK 管）：
      POST { type:'issue', sourceApp, title, desc, severity,
             troopId, name, contact }  →  admin GAS 寫入「問題回報」表
   匯報提交落 App 本機（跟「儲存到後端」一齊上、換機都要留得返），
   再經同源 proxy 嘅 submitIssue 送去中央 ADMIN 收件匣。收件匣同開戶
   一樣**唔會回執**（admin GAS 回 { status:'success'|'error' }），
   ADMIN 收到之後自己登記做問題回報＋轉寄返報告者 Email。
   ============================================================ */

import { load, commit } from './store.js';

/** TICK 嚴重度白名單（同 Scout Admin 一致：低／中／高／緊急） */
export const ISSUE_SEVERITIES = ['低', '中', '高', '緊急'];

/** 記低一份求救報告（寫入本機貯稿，跟正式同步走，唔會靜靜唔見）。 */
export function recordIssueReport(report = {}) {
  const rec = {
    id: 'issue_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    at: (report && report.at) || new Date().toISOString(),
    unit: (report && report.unit) || '',
    title: String((report && report.title) || '').trim().slice(0, 120),
    desc: String((report && report.desc) || '').trim().slice(0, 2000),
    severity: ISSUE_SEVERITIES.includes(report && report.severity) ? report.severity : '高',
    name: String((report && report.name) || '').trim().slice(0, 120),
    contact: String((report && report.contact) || '').trim().slice(0, 120),
    status: 'draft'
  };
  try {
    const db = load();
    if (!Array.isArray(db.issueReports)) db.issueReports = [];
    db.issueReports.unshift(rec);
    commit();
  } catch (e) { /* 未初始化（未揀旅團就唔可能入到嚟）—— 唔阻送出 */ }
  return rec;
}

/** 標記一份求救報告已送出（再儲一次，跟同步上後端）。 */
export function markIssueReportSent(reportId) {
  try {
    const list = load().issueReports || [];
    const rec = list.find(x => x && x.id === reportId);
    if (rec) { rec.status = 'sent'; rec.sentAt = new Date().toISOString(); }
    commit();
  } catch (e) { /* 未初始化：略過 */ }
}

/**
 * 驗證求救內容 —— 對正 Scout Admin「問題回報」合約：
 * 標題（≤120）＋問題詳情（≤2000）必填、嚴重度白名單。
 * @returns {{ok:boolean, errors:string[], payload:object}}
 */
export function validateIssue(input = {}) {
  const errors = [];
  const title = String(input.title || '').trim();
  const desc = String(input.desc || '').trim();
  const severity = ISSUE_SEVERITIES.includes(input.severity) ? input.severity : '高';
  if (!title) errors.push('請填一句標題（發生咩事）');
  else if (title.length > 120) errors.push('標題太長（最多 120 字）');
  if (!desc) errors.push('請寫低問題詳情，求救先知點幫你');
  if (desc.length > 2000) errors.push('問題詳情太長（最多 2000 字）');
  let issueUrl = '';
  try { issueUrl = globalThis.location?.href || ''; } catch (e) { issueUrl = ''; }
  const payload = {
    type: 'issue',
    sourceApp: APP_TYPE,
    appName: APP_NAME,
    troopId: String(input.troopId || input.unit || '').trim().substring(0, 32),
    title: title.substring(0, 120),
    desc: desc.substring(0, 2000),
    severity,
    name: String(input.name || input.who || '').trim().slice(0, 120),
    contact: String(input.contact || '').trim().slice(0, 120),
    from: String(input.from || '').trim().slice(0, 120),
    issueUrl: issueUrl.substring(0, 300),
    at: new Date().toISOString()
  };
  return { ok: errors.length === 0, errors, payload };
}

/** 送出求救報告 —— 同 submitApplication 一模一樣（先 proxy 後 direct）。 */
export async function submitIssue(input = {}, timeoutMs = 20000) {
  const v = validateIssue(input);
  if (!v.ok) return { ok: false, via: 'proxy', receipt: false, errors: v.errors, payload: v.payload };
  const box = adminInbox();
  if (!box.configured) {
    return { ok: false, via: 'proxy', receipt: false, errors: ['未設定管理員收件匣（data/units.json → admin.submitUrl）'], payload: v.payload };
  }
  const viaProxy = await postViaProxy(v.payload, 'submitIssue', timeoutMs);
  if (viaProxy.available && viaProxy.ok) {
    return { ok: true, via: 'proxy', receipt: false, ms: viaProxy.ms, payload: v.payload };
  }
  const direct = await postDirectToInbox(v.payload, timeoutMs);
  if (direct.ok) {
    return {
      ...direct,
      errors: viaProxy.available ? viaProxy.errors : undefined
    };
  }
  return {
    ok: false, via: direct.via, receipt: false,
    ms: (viaProxy.ms || 0) + (direct.ms || 0),
    payload: v.payload,
    errors: [...(viaProxy.available ? (viaProxy.errors || []) : []), ...(direct.errors || [])]
  };
}

/** 求救報告純文字版（送唔到時照樣有嘢可以 WhatsApp／電郵畀管理員）。 */
export function issueText(payload = {}) {
  const p = payload || {};
  return [
    '【問題回報（求救）· 深資童軍管理系統】',
    `標題：${p.title || '（無）'}　嚴重度：${p.severity || '高'}`,
    `旅團編號：${p.troopId || '（未填）'}　來源：${p.sourceApp || APP_TYPE}`,
    `回報人：${p.name || '（匿名）'}${p.contact ? `（聯絡：${p.contact}）` : ''}`,
    `發生位置：${p.issueUrl || '（未知）'}`,
    '',
    '問題詳情：',
    p.desc || '',
    '',
    `送出時間：${p.at || ''}`
  ].join('\n');
}

/**
 * 團員入口嘅求救 —— 同 admin 版 UI 唔同、但行同一條 sendIssue。
 * 團員喺 members.html 度撳「求救」，開框填 標題／嚴重度／問題詳情，送出。
 * @param {object} who 已知回報者 {name, contact}（contact＝Email，ADMIN 轉寄用）
 */
export async function openMemberSOS(who = {}) {
  const unit = String((who && who.troopId) || '').trim();
  const name = String((who && who.name) || '').trim();
  const contact = String((who && who.contact) || '').trim();
  let pageUrl = '';
  try { pageUrl = globalThis.location?.href || ''; } catch (e) { pageUrl = ''; }
  const r = await modal({
    title: '求救 —— 回報問題',
    wide: true,
    sub: '寫低閣下遇到嘅問題，我哋會經 ADMIN 收到＋轉寄返畀你 Email 跟進',
    body: `
      <div class="note-box mb-12">${icon('alert', 15)}<div>
        SEND 出去嘅嘢＝下面你填嘅嘢＋旅團編號／回報人／Email（幫 ADMIN 知邊個回報）：
        <div class="xs mono mt-4">旅團編號：${esc(unit || '（未揀）')}${name ? ` · 回報人：${esc(name)}` : ''}${contact ? ` · Email：${esc(contact)}` : ''}</div>
      </div></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">標題 <span class="req">*</span>（一句講晒）</label>
          <input class="input" id="msos-title" maxlength="120" placeholder="例：通告開唔到"></div>
        <div class="field"><label class="label">嚴重度</label>
          <select class="select" id="msos-severity">
            <option value="高" selected>🔴 高 —— 用唔到（成個功能死）</option>
            <option value="緊急">🛑 緊急 —— 即刻要救</option>
            <option value="中">🟠 中 —— 用得但一時時壞</option>
            <option value="低">🟢 低 —— 意見／想建議</option>
          </select></div>
      </div>
      <div class="field mt-12"><label class="label">問題詳情 <span class="req">*</span>（2000 字內）</label>
        <textarea class="input mono" id="msos-desc" rows="6" placeholder="發生咗咩事？撳咗邊度？想點樣？…"></textarea></div>
      <div class="hint mt-6">報告會送去 ADMIN（同圖書館問題回報同一張表），再轉寄返你 Email 跟進。ADMIN 唔會即時回覆。</div>`,
    actions: [
      { label: '取消', class: 'btn', value: false },
      {
        label: 'SEND 去 ADMIN', class: 'btn-primary',
        onClick: el => {
          const title = (el.querySelector('#msos-title')?.value || '').trim();
          const desc = (el.querySelector('#msos-desc')?.value || '').trim();
          const severity = el.querySelector('#msos-severity')?.value || '高';
          if (!title || !desc) {
            el.querySelector('.modal-body')?.insertAdjacentHTML('afterbegin',
              '<div class="note-box danger mb-8"><div class="sm">要填「標題」同「問題詳情」先送到畀 ADMIN。</div></div>');
            return false;
          }
          return { title, desc, severity };
        }
      }
    ]
  });
  if (!r) return false;   // 撳取消／閂框
  const input = {
    troopId: unit,
    name,
    contact,
    title: String((r && r.title) || '').trim(),
    desc: String((r && r.desc) || '').trim(),
    severity: String((r && r.severity) || '高'),
    from: '團員入口',
    issueUrl: pageUrl
  };
  const v = validateIssue(input);
  if (!v.ok) {
    toast(v.errors[0], 'err');
    return openMemberSOS(who);
  }
  toast('送出中…', 'info');
  const res = await submitIssue(input);
  if (res.ok) {
    await modal({
      title: '已送出畀 ADMIN',
      sub: `${res.payload.title} · ${res.payload.severity || '高'} · ${res.via === 'proxy' ? '經伺服器轉發' : '直接送出'}${res.ms != null ? ` · ${res.ms} ms` : ''}`,
      body: `
        <div class="note-box info mb-12">${icon('check', 15)}<div>
          你份問題回報已經入咗<b>ADMIN「問題回報」看板</b>。<br>
          <span class="xs">ADMIN 收到會登記跟進，再轉寄去你 Email。佢唔會即時覆你。</span>
        </div></div>`,
      actions: [{ label: '好', class: 'btn-primary', value: true }]
    });
    return true;
  }
  /* 送唔到：留返段字喺手，可複製 WhatsApp／電郵畀管理員 */
  const { copyText } = await import('./util.js');
  const sig = (res.errors || []).join(' · ') || '送出失敗';
  toast(sig, 'err');
  const action = await modal({
    title: '送唔到去 ADMIN',
    wide: true,
    sub: res.via === 'proxy' ? '（經伺服器轉發時失敗）' : '（直接送出時失敗）',
    body: `
      <div class="note-box danger mb-12">${icon('alert', 15)}<div>
        <b>${esc(sig)}</b><br>
        <span class="xs">你打嗰啲嘢仲喺下面 —— 複製落嚟，WhatsApp／電郵畀平台管理員都一樣跟進。</span>
      </div></div>
      <textarea class="input mono" rows="8" readonly style="font-size:12px">${esc(issueText(res.payload))}</textarea>`,
    actions: [
      { label: '關閉', class: 'btn', value: null },
      { label: '再試一次', class: 'btn', value: 'retry' },
      { label: '複製報告內容', class: 'btn-primary', value: 'copy' }
    ]
  });
  if (action === 'copy') {
    toast((await copyText(issueText(res.payload))) ? '已複製報告內容' : '複製唔到，請手動抄低', 'ok');
  }
  if (action === 'retry') return openMemberSOS(who);
  return false;
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

/** 貼落 Vercel 嘅逐步指示（同一個來源：教學頁同「系統」都用呢個） */
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
    '兩邊 deploy 一次，再由旅團喺「進度」開機就自動讀後端（見到團員同進度就成功）'
  ];
}
