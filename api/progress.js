/* ============================================================
   api/progress.js — 進度紀錄同源轉發層（一個後端、兩個前端）
   ------------------------------------------------------------
   旅團只有一個後端：Google Sheet ＋ 一支 Apps Script（/exec）。
   深資童軍管理系統同進度前端都係前端，讀寫同一份資料 —— 所以呢度只係
   「代瀏覽器讀／寫旅團自己嘅後端」，唔會連去任何其他系統。

   讀：POST { action:'load', unit, backend, apikey }  → GET 後端 ?action=load
   寫：POST { action:'save' | 'saveOtherBadge', … }   → POST 後端 action=save
   批：POST { action:'reviewRequest' | 'reviewLogRequest', … }
        → 審批中心：批／拒團員申報（待批完成／待批履歷），批准會寫入進度／活動履歷
   可選：POST { action:'catalog', catalog }            → 自訂考核項目定義（公開 https）
        （預設唔用：app 內建 data/progress/items.json，離線都讀得）

   後端網址／API Key：**預設用前端傳上嚟嘅**（「進度 → 設定」填 /exec ＋ API Key，存喺旅團自己嘅資料）。
   伺服器端 env（TROOP_<旅團>_PROGRESSBACKEND / _PROGRESSAPIKEY）係可選覆蓋，設咗就優先。

   安全：
     1. 只准 https://script.google.com/macros/s/…/exec（擋 open proxy；可用 V82_PROXY_TEST=1 放行本機 mock）
     2. payload ≤ 1 MB；上游 45 秒逾時
     3. log 只記 metadata：唔記 API Key、唔記 payload 內容、唔記完整後端網址
     4. catalog 只准公開 https（擋 localhost／內網，防 SSRF）
   ============================================================ */

import crypto from 'node:crypto';
import { isTrustedExecUrl, getProgressRegistryEntry } from './_registry.js';

export const config = { maxDuration: 60 };

/* ============================================================
   ★ VSBADGE 旅系統接駁（2026-09-25）
   ------------------------------------------------------------
   進度前端（VSBADGE）升級做「旅 > 團 > 進度」之後，進度嗰支 GAS 若果
   「閂咗直接入口（ALLOW_LOCAL_LOGIN=false）」，舊式 apikey 讀寫會俾佢
   拒（回 success:false, upstream_only:true, error:「此後端的直接入口已閂…」）
   —— 呢個正正係「VSBADGE 連唔上」（以前經 ECPORTAL／apikey 直連嗰陣通）。
   
   閂咗口嘅後端**只收簽名**（sig）。而簽名用嘅根密鑰就係**呢支進度後端
   自己**嘅 API_KEY（vsbadge Code.gs：linkSigKey() = HMAC-SHA256(
   "vsbadge-troop-sig-v1", getApiKey())；verifyLinkSig 用同一條 API_KEY 驗，
   doPost 喺「直接入口」掣**之前**先路由簽名請求）。所以我哋（Vercel 伺服器）
   有嗰條 SHEET KEY（＝PROGRESSAPIKEY／TROOP_<id>_APIKEY）就出到同一款簽名，
   唔使經旅／團中間嗰支 GAS，直接 POST 到進度後端 /exec 就入得。
   key 唔落瀏覽器，仲硬淨過舊式 apikey，亦唔會再撞「閂咗口」。

   簽名公式（同 vsbadge Code.gs makeLinkSig / verifyLinkSig 完全一致）：
     linkSigKey = hex( HMAC-SHA256( message = "vsbadge-troop-sig-v1", key = SHEET_KEY ) )
     canonical  = action + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(rawBody))
     sig        = hex( HMAC-SHA256( canonical, linkSigKey ) )
   傳送：POST 到後端 /exec；body 帶 {…服務參數, sig, sig_ts, sig_nonce}
   （digest 綁「去掉三個 sig 欄位後嘅 body」；query 都帶多一組 sig，
   因為 GAS 302 轉址有機會甩咗 query —— 同 vsbadge callDownstream 一樣）。
   讀（load）都係經 signed POST 垂詢，唔使 GET（閂咗口嘅 doGet 一律拒）。
   ============================================================ */
const LINK_SIG_PURPOSE = 'vsbadge-troop-sig-v1';
const LINK_SIG_MAX_BODY = 900000;   // sig 請求 body 上限（同 vsbadge 一樣）

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex');
}
function hmacHex(message, key) {
  return crypto.createHmac('sha256', String(key)).update(String(message)).digest('hex');
}
function linkNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}
/* 有冇齊簽名用嘅嘢：條 KEY 一定要係進度後端自己嗰條（≥8 字元先合理） */
function canSign(apiKey) {
  return !!(apiKey && apiKey.length >= 8);
}
/* 生成同 vsbadge 一樣嘅 sig（用邊條 KEY 由 caller 決定） */
function makeLinkSig(action, rawPayload, key) {
  const ts = String(Date.now());
  const nonce = linkNonce();
  const digest = sha256Hex(String(rawPayload || ''));
  const canonical = [String(action || ''), ts, nonce, digest].join('\n');
  const sigKey = hmacHex(LINK_SIG_PURPOSE, String(key || ''));
  return { sig: hmacHex(canonical, sigKey), ts, nonce };
}

const UPSTREAM_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.V82_PROGRESS_TIMEOUT_MS || '45000', 10);
  if (Number.isNaN(v)) return 45000;
  return Math.max(1000, Math.min(55000, v));
})();
const MAX_DATA_BYTES = 1024 * 1024;        // 前端送上去嘅資料上限 1MB
const MAX_ITEMS_BYTES = 2 * 1024 * 1024;   // items.json 上限 2MB

// 旅團後端（Code.gs）支援嘅 action（唔會放寬）
const ACTIONS = new Set(['load', 'save', 'saveOtherBadge', 'catalog', 'reviewRequest', 'reviewLogRequest',
  /* 團員入口自助進度：申報完成（寫入「待批完成」）／查自己嘅申報狀態（v2.2.0） */
  'addRequest', 'myRequests',
  /* ★ 2026-09-24：「人讀到、但個個都冇進度」自查 —— 見下面 diag 分支 */
  'diag',
  /* ★ 2026-09-25 VSBADGE 開關掣：本系統（VS-PORTAL）代旅團閂／開 VSBADGE 後端嘅「直接入口」。
     閂嘅係 VSBADGE 嗰邊（淨係佢自己支 GAS 嘅 Script Properties），唔會掂本系統自己。
     getLinkState 讀話；setLocalLogin 用下面 signedPost 嗰款簽名（要 SHEET KEY＝進度後端自己嘅 API_KEY）。 */
  'getLinkState', 'setLocalLogin']);

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function safeLog(fields) {
  // 只記錄 metadata —— 絕不記錄 apikey / backend / payload
  try { console.log(JSON.stringify({ svc: 'ecportal-progress', ...fields })); } catch (e) { /* ignore */ }
}

function firstStr(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
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

/** 只准公開 https 位址（自訂考核項目定義用）——擋 localhost / 內網 / 非 https */
function isSafePublicUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (host === '0.0.0.0' || host === '[::1]' || host === '::1') return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (!host.includes('.')) return false;   // 要真域名
    return true;
  } catch (e) { return false; }
}

async function upstream(url, { method = 'POST', payload = null } = {}) {
  const init = { method, redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  if (method === 'POST') {
    init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    init.body = JSON.stringify(payload || {});
  }
  const up = await fetch(url, init);
  const text = await up.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON（Apps Script 錯誤頁） */ }
  return { status: up.status, json, raw: text };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: '此 API 只接受 POST 請求' });
  }

  const body = await readRawBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, error: '請求格式錯誤' });
  }

  const unit = String(body.unit || '').trim();
  const action = String(body.action || '').trim();
  const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};

  if (!ACTIONS.has(action)) {
    safeLog({ result: 'bad_action', action: action.slice(0, 40), ms: Date.now() - t0 });
    return sendJson(res, 400, { ok: false, error: '不支援的操作' });
  }
  if (unit && !/^[0-9A-Za-z_-]{1,32}$/.test(unit)) {
    return sendJson(res, 400, { ok: false, error: '旅團編號格式不正確' });
  }

  // ---- 1. 後端網址 / API Key / 前端網址：伺服器端 registry 優先，其次用前端填嘅 ----
  const reg = unit ? getProgressRegistryEntry(unit) : { backend: '', apiKey: '', catalog: '' };
  const backend = String(reg.backend || body.backend || '').trim();
  const apiKey = String(reg.apiKey || body.apikey || '').trim();
  const catalogUrl = String(reg.catalog || body.catalog || '').trim();

  const usingServerSide = !!(reg.backend || reg.apiKey);
  /* 簽名根密鑰＝進度後端自己條 API_KEY（呢度嘅 apiKey 已經係 server-side 優先、
     其次先係瀏覽器貼嘅）。有條 ≥8 字元嘅 KEY，收到 upstream_only 就兜去簽名。 */

  if (action === 'catalog') {
    /* 可選：旅團想用自己嘅考核項目定義（預設用 app 內建 data/progress/items.json，唔需要呢個） */
    let target = catalogUrl || String(body.url || '').trim();
    if (target && !isSafePublicUrl(target)) {
      return sendJson(res, 400, { ok: false, reason: 'catalog_not_allowed',
        error: '自訂考核項目網址唔安全（只准公開 https 網址，唔准 localhost／內網）' });
    }
    if (!target) return sendJson(res, 400, { ok: false, reason: 'catalog_missing', error: '未填自訂考核項目網址（app 內建已經可以直接用）' });
    try {
      const up = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const text = await up.text();
      if (text.length > MAX_ITEMS_BYTES) return sendJson(res, 502, { ok: false, error: '考核項目檔太大' });
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* ignore */ }
      if (!json || !Array.isArray(json.badges)) {
        safeLog({ result: 'catalog_bad_response', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { ok: false, error: '讀唔到考核項目定義（要有 badges 陣列）' });
      }
      safeLog({ result: 'catalog_ok', status: up.status, ms: Date.now() - t0 });
      return sendJson(res, 200, { ok: true, data: json });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      safeLog({ result: timeout ? 'catalog_timeout' : 'catalog_fetch_error', ms: Date.now() - t0 });
      return sendJson(res, timeout ? 504 : 502, { ok: false, error: timeout ? '讀取逾時' : '無法讀取自訂考核項目' });
    }
  }

  // ---- 2. 旅團後端（GAS /exec）驗證 ----
  if (!backend) {
    return sendJson(res, 400, { ok: false, reason: 'backend_missing',
      error: '未設定後端網址 —— 去「進度 → 設定」填入旅團自己嘅 Apps Script /exec 網址（或者喺 data/units.json 登記）' });
  }
  if (!isTrustedExecUrl(backend)) {
    safeLog({ result: 'bad_backend', unit: unit.slice(0, 32), ms: Date.now() - t0 });
    return sendJson(res, 400, { ok: false, reason: 'backend_not_allowed',
      error: '後端網址格式唔正確（要係 https://script.google.com/macros/s/…/exec）' });
  }

  /* ★ 2026-09-24：後端自查（diag）——
     症狀「人係讀到，但係個個都冇進度」有幾個完全唔同嘅成因（見下面註解），
     所以一次過問後端三件事，等 app 可以直情講出係邊一個：
       ① GET 根網址（唔使 Key）：呢支 /exec 係邊個、係邊張 Sheet
       ② GET ?action=diag（要 Key）：認唔認得 diag（＝係唔係呢個管理系統嘅後端）
       ③ diag 內容：有邊啲分頁、每張幾多行、進度追蹤有幾個 YMIS／項目
     （冇一個問題係可以喺前端解決嘅 —— 資料係喺旅團自己張 Sheet。） */
  if (action === 'diag') {
    try {
      const self = await upstream(backend, { method: 'GET' });
      const qs = new URLSearchParams({ action: 'diag' });
      if (apiKey) qs.set('apikey', apiKey);
      if (unit) qs.set('unit', unit);
      const d = await upstream(backend + (backend.includes('?') ? '&' : '?') + qs.toString(), { method: 'GET' });
      const detail = (d.json && typeof d.json === 'object') ? d.json : null;
      const recognized = !!(detail && detail.ok === true && detail.progress);
      const selfJson = (self.json && typeof self.json === 'object') ? self.json : null;
      safeLog({ result: 'diag', recognized: recognized, ms: Date.now() - t0 });
      return sendJson(res, 200, {
        ok: true, action: 'diag', serverSideKey: usingServerSide,
        data: {
          recognized: recognized,
          self: selfJson, selfStatus: self.status,
          detail: detail, detailStatus: d.status,
          apiKeyUsed: !!apiKey
        }
      });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      safeLog({ result: timeout ? 'diag_timeout' : 'diag_fetch_error', ms: Date.now() - t0 });
      return sendJson(res, timeout ? 504 : 502, {
        ok: false, error: timeout ? '後端自查逾時' : '連接唔到後端（自查失敗）'
      });
    }
  }

  try {
    let up;
    let sentVia = 'api';
    /* 純簽名 POST：閂咗直接入口嘅 vsbadge 後端 doPost 會喺「直接入口」掣之前先驗簽名。
       簽名完全照 vsbadge callDownstream：body 一組（digest 綁去 sig 欄位後嘅 body）、
       query 一組（digest 綁成支原始 body），驗收時 query 優先，兩粒 nonce 一齊消耗。 */
    const signReady = canSign(apiKey);
    /* @param targetAction 落喺 body 嘅 action（簽名 canonical 同 body 都用佢） */
    /* @param payload      除 action 外嘅業務欄位（setLocalLogin 用 {allow:true|false}） */
    const signedPost = async (targetAction = action, payload = {}) => {
      const bodyOnly = { ...payload, action: targetAction };
      const rows = JSON.stringify(bodyOnly);
      const inner = makeLinkSig(targetAction, rows, apiKey);
      const out = { ...bodyOnly, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
      const rawOutgoing = JSON.stringify(out);
      /* vsbadge 驗 rawBody 長度（連 sig 欄位）, 照樣以最終 body 為準 */
      if (rawOutgoing.length > LINK_SIG_MAX_BODY) {
        safeLog({ result: 'sig_body_too_big', action: targetAction, bytes: rawOutgoing.length, ms: Date.now() - t0 });
        return { tooBig: rawOutgoing.length };
      }
      const outer = makeLinkSig(targetAction, rawOutgoing, apiKey);
      const q = new URLSearchParams({ sig: outer.sig, sts: outer.ts, snonce: outer.nonce });
      const resp = await upstream(backend + (backend.includes('?') ? '&' : '?') + q.toString(), { method: 'POST', payload: out });
      return { resp };
    };

    if (action === 'load') {
      /* 舊路（快、唔使簽名）：讀多數用 GET + apikey；收到 upstream_only 先至兜去簽名 POST */
      let qs = new URLSearchParams({ action: 'load' });
      if (apiKey) qs.set('apikey', apiKey);
      up = await upstream(backend + (backend.includes('?') ? '&' : '?') + qs.toString(), { method: 'GET' });
      if (up.json && up.json.upstream_only && signReady) {
        const signed = await signedPost();
        if (signed.tooBig) {
          return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '資料太大，簽唔到去進度後端' });
        }
        up = signed.resp; sentVia = 'link';
      }
    } else if (action === 'getLinkState' || action === 'setLocalLogin') {
      /* ★ VSBADGE 開關掣（本系統代旅團閂／開 VSBADGE 後端嘅「直接入口」）。
         兩個 action 都喺 vsbadge 簽名白名單（read／write），一定要簽名先入得 ——
         冇簽名而閂咗口嗰陣就係 upstream_only；所以呢度**一律用簽名 POST**，唔行 apikey 舊路。
         授權 = 邊個有嗰條 SHEET KEY（＝進度後端自己嘅 API_KEY）。 */
      if (!signReady) {
        return sendJson(res, 400, { ok: false, reason: 'no_sign_key',
          error: '未設定 API Key（＝進度後端嘅 SHEET KEY），冇得閂／開 VSBADGE 後端嘅直接入口。' });
      }
      if (action === 'setLocalLogin') {
        const raw = String(data.allow ?? '').trim().toLowerCase();
        const allow = ['1', 'true', 'yes', 'on', 'open'].indexOf(raw) >= 0;
        if (!allow && ['0', 'false', 'no', 'off', 'close', 'closed'].indexOf(raw) < 0) {
          return sendJson(res, 400, { ok: false, reason: 'bad_allow',
            error: '開關值唔正確（要 allow: true 開、false 閂）。' });
        }
      }
      const signed = await signedPost(action, action === 'setLocalLogin' ? { allow: String(data.allow) } : {});
      if (signed.tooBig) {
        return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '資料太大，簽唔到去 VSBADGE 後端' });
      }
      up = signed.resp; sentVia = 'link';
    } else {
      const payload = { ...data, action };
      if (apiKey) payload.apikey = apiKey;
      up = await upstream(backend, { method: 'POST', payload });
      if (up.json && up.json.upstream_only && signReady) {
        const signed = await signedPost();
        if (signed.tooBig) {
          return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '資料太大，簽唔到去進度後端' });
        }
        up = signed.resp; sentVia = 'link';
      }
    }

    if (!up.json) {
      safeLog({ result: 'upstream_bad_response', action, status: up.status, ms: Date.now() - t0 });
      const hint = up.status >= 400
        ? `進度系統後端暫時無法使用（HTTP ${up.status}）`
        : '進度系統後端回應格式異常 —— 請確認 /exec 網址係「任何人可存取」嘅正式部署';
      return sendJson(res, 502, { ok: false, reason: 'upstream_bad_response', error: hint });
    }

    // GAS 業務錯誤（success:false）要照樣俾前端睇到（例：Invalid API Key／閂咗直接入口）
    const closed = up.json.upstream_only === true;
    const ok = closed ? false : up.json.success !== false;
    const fellBack = sentVia === 'link';
    safeLog({ result: ok ? 'ok' : (closed ? 'upstream_only' : 'gas_error'), action, fellBack, status: up.status, ms: Date.now() - t0 });
    return sendJson(res, 200, {
      ok,
      action,
      serverSideKey: usingServerSide,
      upstream_only: closed,
      linked: fellBack,
      error: ok ? undefined : (closed
        ? (up.json.error || '進度後端閂咗「直接入口」——請核對 API Key，或者喺 Vercel 更新 KEY 再 Redeploy。')
        : (up.json.error || '進度系統拒絕咗呢個要求')),
      data: up.json
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', action, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, {
      ok: false,
      error: timeout ? '進度系統後端回應逾時' : '無法連接進度系統後端，請稍後重試'
    });
  }
}
