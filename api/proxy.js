// Vercel 同源 Proxy — 82venture 多旅團 GAS 安全轉發層
//
// 架構：
//   瀏覽器 ──同源 POST──▶ /api/proxy ──伺服器端──▶ 已登記旅團的 GAS /exec ──▶ Google Sheet
//
// 安全原則：
//   1. 前端可提交 unitCode，由伺服器端 Registry 安全解析真實 GAS URL
//   2. 只接受白名單 action (ping, status, sync, claim, loan, noticeSignup, notices, submitRegistration)
//   3. 永不在 log 記錄密碼／apiKey／payload 機密
//
// 同時兼容前端直接打 GAS 或透過同源 proxy 轉發。

import crypto from 'node:crypto';
import { getTrustedUnit, isTrustedExecUrl } from './_registry.js';
import { verifySuperSession } from './_super-session.js';

export const config = { maxDuration: 60 };

const UPSTREAM_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.V82_PROXY_TIMEOUT_MS || process.env.VSBADGE_PROXY_TIMEOUT_MS || '45000', 10);
  if (Number.isNaN(v)) return 45000;
  return Math.max(1000, Math.min(55000, v));
})();
/* 單次請求上限 4MB —— 留水位畀 Vercel 自己嘅 4.5MB 請求上限。
   呢個上限**一體適用**：saveDb／saveDbPart／sync 夾帶成份資料庫、
   uploadPhotos 夾帶相片 base64，都係同一條 4MB 線。
   （以前呢度有個 BIG_BODY_ACTIONS 集合諗住「大 action 放寬啲」，
    但 readRawBody 喺未 parse 之前根本未知 action 係乜，
    所以嗰個集合由頭到尾冇被讀過 —— 死碼，已刪。） */
const MAX_DATA_BYTES = 4 * 1024 * 1024;

// 中央管理員收件匣（新旅團接入申請）—— 目的地係伺服器端常數，前端改唔到。
// 呢個收件匣同 VSBADGE 共用（用 appType 分辨：82venture / vsbadge）。
// 注意：收件匣**唔會回執** —— 申請人 App 唔會知 ADMIN 收唔收到，
// 所以只要 POST 過得去（有回應）就當送到，只有連線／逾時先當失敗。
const SCOUT_ADMIN_API = process.env.SCOUT_ADMIN_API ||
  'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';

const ALLOWED_ACTIONS = new Set([
  'ping', 'status', 'test', 'authLogin', 'authWhoAmI', 'authPortalExchange', 'authChangePassword', 'authResetPassword', 'authDeleteAccount', 'authRestoreAccount', 'authCreateAccount', 'authForgotPassword', 'authResetByToken', 'authCompletePasswordReset',
  /* 團員入口：全部由支部 GAS 用 opaque session 對回本人；hubLoad 只回安全投影，
     其餘三個 action 只可改本人 RSVP／答卷／請假，唔經行政整庫同步。 */
  'hubLoad', 'hubRsvp', 'hubQuiz', 'hubAbsence',
  'sync', 'claim', 'loan', 'noticeSignup',
  /* 整份資料庫讀／寫 —— app 嘅真正儲存（換機／清 cache 都唔會冇咗）。
     saveDbPart／saveDbCommit ＝ v2.4.0 分件儲存（大資料庫拆件上，冇硬天花板）
     loadDbPart            ＝ v2.6.0 分段讀取（大資料庫分段落，唔會撞 Vercel 4.5MB 回應上限） */
  'saveDb', 'loadDb', 'loadDbPart', 'dbInfo', 'verifySetupKey', 'saveDbPart', 'saveDbCommit',
  /* ★ v2.8.0「簡單寫入」（學 VSBADGE：一個請求淨係寫一個表嗰幾行）。
     saveTables＝逐表寫、loadTables＝逐表讀、loadTablesPart＝成份太大嗰陣一個表一個表攞。
     舊嘅 saveDb／loadDb 照樣放行做後備（後端 Code.gs 未升級就自動跌返去用）。 */
  'saveTables', 'loadTables', 'loadTablesPart', 'syncCheck',
  /* ★ v2.7.2：搶救路線 —— repairDb（清垃圾同舊版本段）／
     saveDbForce（強制用呢部機嘅資料覆蓋後端）。兩個都要後端 API Key（由本代理注入），
     前端唔會見到 Key。用途：後端資料讀唔到、所有人都入唔到嘅時候，由留住資料嗰部機救返。
     （diag 已於 2026-11-12 移除：對應 UI 喺 2026-09-26 拆走，後端再冇 handler。） */
  'repairDb', 'saveDbForce',
  /* 單據相片直上 Drive（v2.3.0 體積治理）—— db 入面只留連結。
     ★ 2026-09-20 事故：呢個 action 一直漏咗喺白名單，代理一律回 400
     「不支援的操作」，前端 finance.js 於是跌返落「本地存做後備」，
     每張單據相都以 base64 dataURL 寫入 db.claims[].photos[].dataUrl，
     把「資料庫」分頁撐過 4.5MB → loadDb 回應過大 → 所有裝置讀唔返後端
     → 「無痕同普通視窗對唔到料」。scripts/lint.mjs 而家會擋住再漏。 */
  'uploadPhotos',
  /* 公開通告：免登入讀旅團自己後端嘅「通告全文」（只回已發布） */
  'notices',
  /* 公開團章（v2.5.0）：免登入讀旅團後端「資料庫」入面已發布嘅 constitution */
  'constitution',
  'submitRegistration',
  /* ★ 2026-09-25 團長：「加個求救制，有咩大問題 SEND 去問 ADMIN，當回報問題處理」
     同 submitRegistration 一條路，送去中央 ADMIN 收件匣（appType 照係 82venture），
     ADMIN 收到登記做「問題回報」再轉寄返報告者 Email。 */
  'submitIssue'
]);

/* 行政資料唔可以再靠「代理識得 API Key」當登入。正常用戶先由同一支 GS
   authWhoAmI 對回身份；平台超管則由本 API 驗 HMAC session 後再簽 server request。 */
const ADMIN_READ_ACTIONS = new Set(['dbInfo', 'loadDb', 'loadDbPart', 'loadTables', 'loadTablesPart', 'syncCheck']);
const ADMIN_WRITE_ACTIONS = new Set(['saveDb', 'saveDbPart', 'saveDbCommit', 'saveTables', 'sync', 'uploadPhotos']);
const ADMIN_DANGEROUS_ACTIONS = new Set(['repairDb', 'saveDbForce']);
const ADMIN_ACTIONS = new Set([...ADMIN_READ_ACTIONS, ...ADMIN_WRITE_ACTIONS, ...ADMIN_DANGEROUS_ACTIONS]);
/* 支部 session 由 GAS 自己核對；只有已由 /api/auth 驗證的 platform super
   需要轉成 HMAC＋nonce server request，API Key 本身仍不會成為身份。 */
const ACCOUNT_ADMIN_ACTIONS = new Set(['authResetPassword', 'authDeleteAccount', 'authRestoreAccount', 'authCreateAccount']);
const ROLE_RANK = { member: 0, exco: 20, exec_committee: 20, leader: 40, branch_leader: 40,
  chief: 60, group_leader: 60, admin: 80, super: 100, super_admin: 100 };
const LINK_SIG_PURPOSE = 'vsbadge-troop-sig-v1';

function roleRank(role) { return ROLE_RANK[String(role || '').toLowerCase()] || 0; }
function sha256Hex(text) { return crypto.createHash('sha256').update(String(text ?? '')).digest('hex'); }
function hmacHex(message, key) { return crypto.createHmac('sha256', String(key)).update(String(message)).digest('hex'); }
function linkSignature(action, raw, key) {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const canonical = [action, ts, nonce, sha256Hex(raw)].join('\n');
  return { sig: hmacHex(canonical, hmacHex(LINK_SIG_PURPOSE, key)), ts, nonce };
}
function signedServerRequest(action, payload, key) {
  const body = { ...payload, action };
  delete body.sig; delete body.sig_ts; delete body.sig_nonce;
  const inner = linkSignature(action, JSON.stringify(body), key);
  const outgoing = { ...body, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  const raw = JSON.stringify(outgoing);
  const outer = linkSignature(action, raw, key);
  return { payload: outgoing, query: new URLSearchParams({ sig: outer.sig, sts: outer.ts, snonce: outer.nonce }).toString() };
}

/* 呢啲 action 會夾帶資料庫／相片 base64 上去，body 可以幾 MB ——
   全部一律行上面同一條 4MB 線（見 MAX_DATA_BYTES 註解）。 */

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function safeLog(fields) {
  try { console.log(JSON.stringify({ svc: 'ecportal-proxy', ...fields })); } catch (e) { /* ignore */ }
}

async function readRawBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DATA_BYTES + 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

async function callUpstream(url, payload) {
  const init = {
    method: 'POST',
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload || {})
  };
  const up = await fetch(url, init);
  const text = await up.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: up.status, json, raw: text };
}

async function authorizeAdminAction(unit, body, action) {
  const superSession = verifySuperSession(String(body.sessionToken || ''));
  if (superSession) return { ok: true, role: 'super', subject: superSession.subject, super: true };
  const sessionToken = String(body.sessionToken || '');
  const portalToken = String(body.portalToken || '');
  if (!sessionToken && !portalToken) {
    return { ok: false, status: 401, error: '要先登入才可讀寫支部資料', code: 'session_required' };
  }
  const probe = {
    action: 'authWhoAmI', unit: unit.code, apiKey: unit.apiKey,
    ...(sessionToken ? { sessionToken } : { portalToken })
  };
  let checked;
  try { checked = await callUpstream(unit.gasUrl, probe); }
  catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, status: timeout ? 504 : 502,
      error: timeout ? '登入核對逾時' : '暫時無法核對登入狀態', code: 'auth_unavailable' };
  }
  const account = checked.json?.account;
  if (!checked.json?.ok || !account) {
    return { ok: false, status: 401, error: checked.json?.error || '登入狀態已失效，請重新登入', code: 'session_invalid' };
  }
  const isSetup = checked.json?.setup === true && account.id === 'setup';
  /* setup session 只係首次建立資料庫用：可讀／一般寫入，但永遠不可 repair／force。 */
  if (isSetup && ADMIN_DANGEROUS_ACTIONS.has(action)) {
    return { ok: false, status: 403, error: '開團身份不可以執行修復或強制覆寫', code: 'action_scope_denied' };
  }
  const rank = isSetup ? 40 : roleRank(account.role || account.backendRole);
  const needed = ADMIN_DANGEROUS_ACTIONS.has(action) ? 40 : 20;
  if (rank < needed) return { ok: false, status: 403, error: '你的身份不可以執行此操作', code: 'action_scope_denied' };
  return { ok: true, role: String(account.role || ''), subject: String(account.ymis || account.id || '') };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { success: false, error: '此 API 只接受 POST 請求' });
  }

  const body = await readRawBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { success: false, error: '請求格式錯誤' });
  }

  const action = String(body.action || (body.tables ? 'sync' : ''));
  const unitCode = String(body.unit || body.troopId || '').trim();

  if (!ALLOWED_ACTIONS.has(action)) {
    safeLog({ result: 'bad_action', action: action.slice(0, 40), ms: Date.now() - t0 });
    return sendJson(res, 400, { success: false, error: '不支援的操作' });
  }

  // ===== 特殊：新旅團接入申請（轉發去中央管理員收件匣）=====
  if (action === 'submitRegistration') {
    if (!isTrustedExecUrl(SCOUT_ADMIN_API)) {
      safeLog({ result: 'admin_api_misconfig', ms: Date.now() - t0 });
      return sendJson(res, 500, { success: false, error: '伺服器設定錯誤，請聯絡管理員' });
    }
    const troopId = String(body.troopId || body.unit || '').trim();
    const troopName = String(body.troopName || '').trim();
    const scriptUrl = String(body.scriptUrl || '').trim();
    const apiKey = String(body.apiKey || '').trim();
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(troopId) || !troopName || !isTrustedExecUrl(scriptUrl) || !apiKey) {
      safeLog({ result: 'registration_invalid', ms: Date.now() - t0 });
      return sendJson(res, 400, { success: false, reason: 'registration_invalid',
        error: '申請必須包含旅團編號、名稱、Unified GAS /exec 及 API Key' });
    }
    const regPayload = {
      troopId: troopId.substring(0, 32),
      troopName: troopName.substring(0, 100),
      scriptUrl: scriptUrl.substring(0, 300),
      apiKey: apiKey.substring(0, 120),
      appType: '82venture',
      appName: '深資童軍管理系統',
      contact: String(body.contact || '').substring(0, 120),
      mainSystemUrl: String(body.mainSystemUrl || '').substring(0, 300),
      note: String(body.note || '').substring(0, 500),
      at: new Date().toISOString()
    };
    try {
      const up = await callUpstream(SCOUT_ADMIN_API, regPayload);
      /* 收件匣冇回執機制：POST 過得去就當送到（ADMIN 系統收到就 OK）。
         唯一例外：收件匣真係回咗 JSON 而且話 success:false，就照當失敗。 */
      const said = (up.json && typeof up.json === 'object') ? up.json : null;
      if (said && said.success === false) {
        safeLog({ result: 'admin_upstream_refused', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, error: said.error || '管理員收件匣話收唔到呢張申請' });
      }
      safeLog({ result: 'registration_sent', status: up.status, json: !!up.json, ms: Date.now() - t0 });
      return sendJson(res, 200, { success: true, message: '申請已提交', delivered: 'sent', receipt: false });
    } catch (e) {
      const timeout = e && e.name === 'TimeoutError';
      return sendJson(res, timeout ? 504 : 502, { success: false, error: timeout ? '提交逾時，請稍後重試' : '申請未能送達管理員' });
    }
  }

  // ===== 特殊：求救／問題回報（同新旅團申請一樣，送中央管理員收件匣）=====
  // ★ 對正 Scout Admin「問題回報（TICK）」合約：admin GAS 嘅 doPost 只認
  //   type:'issue' 先會寫入「問題回報」工作表（圖書館同各 APP 都係用呢張）。
  if (action === 'submitIssue') {
    if (!isTrustedExecUrl(SCOUT_ADMIN_API)) {
      safeLog({ result: 'admin_api_misconfig', ms: Date.now() - t0 });
      return sendJson(res, 500, { success: false, error: '伺服器設定錯誤，請聯絡管理員' });
    }
    const issuePayload = {
      type: 'issue',
      sourceApp: '82venture',
      title: String(body.title || '').substring(0, 120),
      desc: String(body.desc || '').substring(0, 2000),
      severity: ['低', '中', '高', '緊急'].includes(body.severity) ? body.severity : '高',
      troopId: String(body.troopId || body.unit || '').substring(0, 32),
      name: String(body.name || '').substring(0, 120),
      contact: String(body.contact || '').substring(0, 120)
    };
    try {
      const up = await callUpstream(SCOUT_ADMIN_API, issuePayload);
      const said = (up.json && typeof up.json === 'object') ? up.json : null;
      if (said && said.status === 'error') {
        safeLog({ result: 'admin_upstream_refused', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, error: said.message || '管理員收件匣話收唔到呢份報告' });
      }
      safeLog({ result: 'issue_sent', status: up.status, json: !!up.json, ms: Date.now() - t0 });
      return sendJson(res, 200, { success: true, message: '報告已提交', delivered: 'sent', receipt: false });
    } catch (e) {
      const timeout = e && e.name === 'TimeoutError';
      return sendJson(res, timeout ? 504 : 502, { success: false, error: timeout ? '提交逾時，請稍後重試' : '報告未能送達管理員' });
    }
  }

  // ===== 一般旅團 action =====
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(unitCode)) {
    return sendJson(res, 400, { success: false, error: '旅團編號格式不正確' });
  }

  const unit = getTrustedUnit(unitCode);
  if (!unit) {
    safeLog({ result: 'unknown_unit', unitCode, ms: Date.now() - t0 });
    return sendJson(res, 404, { success: false, error: '找不到此旅團或後端網址未設定' });
  }

  const payload = { ...body, action };
  /* ★ 旅團編號一律校正做 Registry 登記咗嗰個（例如「82」→「0082」）。
     唔校正嘅話，團長喺閘度打「82」入到去，寫落 Google Sheet 嘅旅團欄就會係「82」，
     讀嘅時候用「0082」又搵唔到 —— 同一張表入面出現兩套資料庫，兩邊永遠對唔到料，
     對用家睇就係「寫咗但讀唔到」。 */
  const canonUnit = unit.code && unit.code !== unitCode ? unit.code : '';
  if (canonUnit) {
    payload.unit = unit.code;
    if (payload.troopId !== undefined) payload.troopId = unit.code;
    /* 成份資料庫入面都記咗自己嘅編號（db.unitCode）—— 一齊校正，
       否則存落後端嘅 JSON 會繼續話自己係「82」，下次讀返又再分裂一次。 */
    if (payload.db && typeof payload.db === 'object' && payload.db.unitCode) payload.db.unitCode = unit.code;
    if (typeof payload.baseUnitCode === 'string' && payload.baseUnitCode) payload.baseUnitCode = unit.code;
  }
  // Proxy 的憑證只能由伺服器 Registry 決定；舊瀏覽器保存的過期 Key 不可蓋過它。
  delete payload.apiKey;
  delete payload.apikey;
  if (!unit.apiKey && action === 'syncCheck') {
    return sendJson(res, 503, { success: false, error: '伺服器未設定此旅團的 API Key（TROOP_<編號>_APIKEY）' });
  }
  if (unit.apiKey) payload.apiKey = unit.apiKey;

  let upstreamUrl = unit.gasUrl;
  let upstreamPayload = payload;
  if (ADMIN_ACTIONS.has(action)) {
    const auth = await authorizeAdminAction(unit, body, action);
    if (!auth.ok) {
      safeLog({ result: auth.code || 'admin_auth_denied', unitCode, action, ms: Date.now() - t0 });
      return sendJson(res, auth.status || 401, { success: false, ok: false, code: auth.code, error: auth.error });
    }
    if (auth.super) {
      if (!unit.apiKey) return sendJson(res, 503, { success: false, error: '伺服器未設定此支部 API Key' });
      delete upstreamPayload.sessionToken;
      delete upstreamPayload.portalToken;
      upstreamPayload.unified_super = true;
      upstreamPayload.on_behalf = 'sheep';
      const signed = signedServerRequest(action, upstreamPayload, unit.apiKey);
      upstreamPayload = signed.payload;
      upstreamUrl += (upstreamUrl.includes('?') ? '&' : '?') + signed.query;
    }
  } else if (ACCOUNT_ADMIN_ACTIONS.has(action)) {
    const platformSuper = verifySuperSession(String(body.sessionToken || ''));
    if (platformSuper) {
      if (!unit.apiKey) return sendJson(res, 503, { success: false, error: '伺服器未設定此支部 API Key' });
      delete upstreamPayload.sessionToken;
      delete upstreamPayload.portalToken;
      upstreamPayload.unified_super = true;
      upstreamPayload.on_behalf = platformSuper.subject || 'sheep';
      const signed = signedServerRequest(action, upstreamPayload, unit.apiKey);
      upstreamPayload = signed.payload;
      upstreamUrl += (upstreamUrl.includes('?') ? '&' : '?') + signed.query;
    }
  }

  try {
    const up = await callUpstream(upstreamUrl, upstreamPayload);
    if (!up.json) {
      safeLog({ result: 'upstream_bad_response', unitCode, action, status: up.status, ms: Date.now() - t0 });
      const msg = up.status >= 400
        ? `旅團後端暫時無法使用（HTTP ${up.status}）`
        : '旅團後端回應格式異常，請檢查 Apps Script 部署';
      return sendJson(res, 502, { success: false, error: msg });
    }

    safeLog({ result: 'ok', unitCode, canonUnit: canonUnit || undefined, action, status: up.status, ms: Date.now() - t0 });
    return sendJson(res, 200, up.json);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', unitCode, action, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, {
      success: false,
      error: timeout ? '旅團後端回應逾時' : '無法連接旅團後端，請稍後重試'
    });
  }
}
