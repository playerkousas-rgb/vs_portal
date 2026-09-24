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

import { getTrustedUnit, isTrustedExecUrl } from './_registry.js';

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
  'ping', 'status', 'test', 'authLogin', 'sync', 'claim', 'loan', 'noticeSignup',
  /* 整份資料庫讀／寫 —— app 嘅真正儲存（換機／清 cache 都唔會冇咗）。
     saveDbPart／saveDbCommit ＝ v2.4.0 分件儲存（大資料庫拆件上，冇硬天花板）
     loadDbPart            ＝ v2.6.0 分段讀取（大資料庫分段落，唔會撞 Vercel 4.5MB 回應上限） */
  'saveDb', 'loadDb', 'loadDbPart', 'dbInfo', 'verifySetupKey', 'saveDbPart', 'saveDbCommit',
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
  'submitRegistration'
]);

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
    const regPayload = {
      troopId: String(body.troopId || body.unit || '').substring(0, 32),
      troopName: String(body.troopName || '').substring(0, 100),
      scriptUrl: String(body.scriptUrl || '').substring(0, 300),
      apiKey: String(body.apiKey || '').substring(0, 120),
      appType: '82venture',
      appName: '執委管理系統',
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
  if (unit.apiKey && !payload.apiKey) payload.apiKey = unit.apiKey;

  try {
    const up = await callUpstream(unit.gasUrl, payload);
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
