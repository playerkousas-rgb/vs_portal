/* ============================================================
   api/progress.js — 功能完整版支部前端內的 Progress 同源轉發層
   ------------------------------------------------------------
   旅團只有一個完整後端：Google Sheet ＋一支 Unified Apps Script（/exec），
   具備身份、行政、Progress、獎章、履歷及申報能力。vs_portal 係功能完整版前端，
   vsbadge 係輕量前端；呢度只會代 vs_portal browser 執行 allowlist 內的本支部
   Progress 業務 action，直接讀寫同一 Sheet 的指定分頁。

   讀：browser POST { action:'load', unit, sessionToken } → server GET Unified ?action=load
   寫：browser POST { action:'save' | 'saveOtherBadge', unit, sessionToken, data }
       → server POST 同一 Unified /exec
   批：POST { action:'reviewRequest' | 'reviewLogRequest', … }
        → 審批中心：批／拒團員申報（待批完成／待批履歷），批准會寫入進度／活動履歷
   考核項目固定讀 app 內建 data/progress/items.json，不接受 remote override。

   後端網址／API Key：固定使用同一旅團 Registry 的 TROOP_<旅團>_BACKEND／APIKEY。
   瀏覽器傳入 backend／apikey 會被忽略，不能把進度改送另一支 GAS。

   安全：
     1. 只准 https://script.google.com/macros/s/…/exec（擋 open proxy；可用 V82_PROXY_TEST=1 放行本機 mock）
     2. 前端／proxy allowlist 只係第一層；Unified GS 仍驗 server-issued session、role、scope
     3. payload ≤ 1 MB；上游 45 秒逾時
     4. log 只記 metadata：唔記 API Key、唔記 payload 內容、唔記完整後端網址
   ============================================================ */

import crypto from 'node:crypto';
import { isTrustedExecUrl, getProgressRegistryEntry, getTrustedUnit } from './_registry.js';
import { verifySuperSession } from './_super-session.js';
import { canonicalRole, roleLevel } from '../assets/js/lib/branch-config.js';

export const config = { maxDuration: 60 };

/* ============================================================
   Unified GAS server-signature transport
   ------------------------------------------------------------
   Progress 永遠只讀寫本支部同一支 Unified GAS。若 GAS 要求 server-signed
   request，proxy 會用 Registry 的同一 API_KEY 派生用途分隔 HMAC，再向同一
   /exec 重送同一 action；呢個只係 server authentication transport，與
   其他前端的狀態或旅系統整合無關。

   簽名公式與 Unified GAS verifyLinkSig 一致：
     linkSigKey = hex( HMAC-SHA256( message = "vsbadge-troop-sig-v1", key = SHEET_KEY ) )
     canonical  = action + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(rawBody))
     sig        = hex( HMAC-SHA256( canonical, linkSigKey ) )
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
const BODY_TOO_LARGE = Symbol('BODY_TOO_LARGE');

// Progress 業務 action；旅系統、登入閘門及其他整合不屬於呢個 API。
const ACTIONS = new Set(['load', 'save', 'saveOtherBadge', 'reviewRequest', 'reviewLogRequest',
  /* 一次 browser request、一個 Unified handler；絕不由 browser 逐列 loop 寫入。 */
  'bulkReviewRequests', 'operationStatus',
  /* 團員入口只可走個人 bridge：由 server session 對出 YMIS，再叫後端只回／寫本人。 */
  'myProgress', 'addRequest', 'myRequests']);
const WRITE_ACTIONS = new Set(['save', 'saveOtherBadge', 'reviewRequest', 'reviewLogRequest', 'bulkReviewRequests', 'addRequest']);
const OPERATION_ID_RE = /^[A-Za-z0-9_.:-]{12,120}$/;

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

/* Unified GAS may still carry legacy transport or entrance metadata.  None of it is
   part of the Progress business contract, so remove it before replying to browser code. */
const INTERNAL_STATE_FIELDS = new Set([
  'linked', 'upstream_only', 'allow_local_login', 'local_login', 'link_flag_set',
  'link_state', 'link_status', 'link_mode', 'integration_state', 'integration_status',
  'connection_state', 'connection_status', 'server_side_key',
  'serverSideKey', 'allowLocalLogin', 'localLogin', 'linkFlagSet', 'linkState', 'linkStatus', 'linkMode',
  'integrationState', 'integrationStatus', 'connectionState', 'connectionStatus',
  'apiKey', 'apikey', 'api_key', 'backend', 'gasUrl', 'gas_url', 'portalToken', 'portal_token', 'secret'
]);
function progressBusinessData(value) {
  if (Array.isArray(value)) return value.map(progressBusinessData);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (!INTERNAL_STATE_FIELDS.has(key)) clean[key] = progressBusinessData(child);
  }
  return clean;
}

async function readRawBody(req) {
  const declared = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(declared) && declared > MAX_DATA_BYTES) return BODY_TOO_LARGE;
  if (req.body && typeof req.body === 'object') {
    try { return Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_DATA_BYTES ? BODY_TOO_LARGE : req.body; }
    catch { return null; }
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_DATA_BYTES) return BODY_TOO_LARGE;
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DATA_BYTES) return BODY_TOO_LARGE;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
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

/** 用 Unified GAS 協定的用途分隔 HMAC 做 server-to-server 請求。 */
async function signedUpstream(url, action, payload, key) {
  const bodyOnly = { ...(payload || {}), action };
  const inner = makeLinkSig(action, JSON.stringify(bodyOnly), key);
  const outgoing = { ...bodyOnly, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  const raw = JSON.stringify(outgoing);
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes > LINK_SIG_MAX_BODY) return { tooBig: rawBytes };
  const outer = makeLinkSig(action, raw, key);
  const qs = new URLSearchParams({ sig: outer.sig, sts: outer.ts, snonce: outer.nonce });
  return { resp: await upstream(url + (url.includes('?') ? '&' : '?') + qs, { method: 'POST', payload: outgoing }) };
}

const STAFF_LEVEL = roleLevel('exco');
const PERSONAL_ACTIONS = new Set(['myProgress', 'addRequest', 'myRequests']);
const SIGNED_REVIEW_ACTIONS = new Set(['reviewRequest', 'reviewLogRequest', 'bulkReviewRequests']);

/**
 * 將瀏覽器交來嘅 opaque session 對返旅團後端身份。
 * client 傳嘅 role／YMIS／name 一律唔信；個人 action 只會用呢度回出嘅 subject。
 */
async function authenticate(unitCode, body) {
  const superSession = verifySuperSession(body.sessionToken);
  if (superSession) return { ok: true, role: 'super', subject: superSession.subject, ymis: '', name: '系統管理員', super: true };

  const unit = getTrustedUnit(unitCode);
  if (!unit?.gasUrl || !unit?.apiKey) {
    return { ok: false, status: 503, reason: 'auth_backend_not_configured', error: '旅團登入後端未設定' };
  }
  const sessionToken = firstStr(body.sessionToken);
  if (!sessionToken) {
    return { ok: false, status: 401, reason: 'session_required', error: '登入狀態已失效，請重新登入' };
  }
  const payload = {
    action: 'authWhoAmI', unit: unit.code, apiKey: unit.apiKey, sessionToken
  };
  let check = await upstream(unit.gasUrl, { method: 'POST', payload });
  if (check.json?.upstream_only && canSign(unit.apiKey)) {
    const signed = await signedUpstream(unit.gasUrl, 'authWhoAmI', {
      unit: unit.code, sessionToken
    }, unit.apiKey);
    if (signed.tooBig) return { ok: false, status: 413, reason: 'auth_request_too_big', error: '登入核對請求太大' };
    check = signed.resp;
  }
  if (check.status < 200 || check.status >= 300) {
    return { ok: false, status: 502, reason: 'auth_unavailable', error: '支部登入核對回應異常' };
  }
  const account = check.json?.account;
  if (!check.json?.ok || !account) {
    return { ok: false, status: 401, reason: 'session_invalid', error: '登入狀態已失效，請重新登入' };
  }
  return {
    ok: true,
    role: canonicalRole(account.role || 'member'),
    subject: String(account.memberId || account.id || ''),
    ymis: String(account.ymis || '').trim(),
    name: String(account.name || '').trim()
  };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: '此 API 只接受 POST 請求' });
  }

  const body = await readRawBody(req);
  if (body === BODY_TOO_LARGE) {
    return sendJson(res, 413, { ok: false, reason: 'request_too_large', outcome: 'not_sent',
      mayHaveApplied: false, error: '進度請求內容超出 1MB 安全上限' });
  }
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
  if (unit && !/^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/.test(unit)) {
    return sendJson(res, 400, { ok: false, error: '旅團編號格式不正確' });
  }

  /* 所有 Progress action 都要先由 server session 對回可信身份。 */
  let actor = null;
  if (!unit) return sendJson(res, 400, { ok: false, reason: 'unit_required', error: '缺少旅團編號' });
  try { actor = await authenticate(unit, body); }
  catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return sendJson(res, timeout ? 504 : 502, { ok: false, reason: 'auth_unavailable', error: timeout ? '登入核對逾時' : '暫時無法核對登入狀態' });
  }
  if (!actor.ok) return sendJson(res, actor.status || 401, { ok: false, reason: actor.reason, error: actor.error });
  if (!roleLevel(actor.role)) {
    return sendJson(res, 403, { ok: false, reason: 'branch_identity_required', error: '登入帳戶不屬於本支部身份 schema' });
  }
  if (PERSONAL_ACTIONS.has(action)) {
    if (!actor.ymis) return sendJson(res, 403, { ok: false, reason: 'member_ymis_missing', error: '登入帳戶未綁定 YMIS，無法讀取個人進度' });
  } else if (roleLevel(actor.role) < STAFF_LEVEL) {
    return sendJson(res, 403, { ok: false, reason: 'staff_required', error: '你沒有權限管理進度' });
  }

  // ---- 1. 後端網址／API Key：只用同一旅團嘅 server Registry ----
  const reg = getProgressRegistryEntry(unit);
  const backend = String(reg.backend || '').trim();
  const apiKey = String(reg.apiKey || '').trim();

  /* 簽名根密鑰＝同一 Unified GAS 的 API_KEY。Browser 提交的 backend／apikey
     不參與選路或驗證；如標準 transport 要求 server signature，就向同一 /exec
     重送同一個業務 action。 */

  // ---- 2. 旅團後端（GAS /exec）驗證 ----
  if (!backend) {
    return sendJson(res, 503, { ok: false, reason: 'backend_missing',
      error: '旅團未在伺服器登記 TROOP_<編號>_BACKEND' });
  }
  if (!apiKey) {
    return sendJson(res, 503, { ok: false, reason: 'api_key_missing',
      error: '旅團未在伺服器登記 TROOP_<編號>_APIKEY' });
  }
  if (!isTrustedExecUrl(backend)) {
    safeLog({ result: 'bad_backend', unit: unit.slice(0, 32), ms: Date.now() - t0 });
    return sendJson(res, 400, { ok: false, reason: 'backend_not_allowed',
      error: '後端網址格式唔正確（要係 https://script.google.com/macros/s/…/exec）' });
  }

  let operationId = '';
  if (WRITE_ACTIONS.has(action)) {
    const supplied = String(body.operationId || body.operation_id || '').trim();
    if (supplied && !OPERATION_ID_RE.test(supplied)) {
      return sendJson(res, 400, { ok: false, reason: 'invalid_operation_id', outcome: 'not_applied', error: '操作編號格式錯誤' });
    }
    operationId = supplied || `${action}:${Date.now().toString(36)}:${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  } else if (action === 'operationStatus') {
    operationId = String(data.operationId || data.operation_id || body.operationId || '').trim();
    if (!OPERATION_ID_RE.test(operationId)) {
      return sendJson(res, 400, { ok: false, reason: 'invalid_operation_id', error: '操作編號格式錯誤' });
    }
  }

  try {
    let up;
    let usedSignature = false;
    let targetAction = action;
    let safeData = data;
    if (action === 'myProgress') {
      targetAction = 'loadMine';
      safeData = { ymis: actor.ymis };
    } else if (action === 'operationStatus') {
      safeData = { operationId, operation_id: operationId, unit: reg.unit || unit };
    } else if (action === 'myRequests') {
      safeData = { ymis: actor.ymis };
    } else if (action === 'addRequest') {
      /* 身份欄由 authWhoAmI 固定；client 偽造 ymis／name 會被丟棄。 */
      safeData = {
        ymis: actor.ymis, name: actor.name,
        item_id: String(data.item_id || '').slice(0, 160),
        item_name: String(data.item_name || '').slice(0, 240),
        requested_date: String(data.requested_date || '').slice(0, 20),
        evidence: String(data.evidence || '').slice(0, 2000)
      };
    } else if (action === 'bulkReviewRequests') {
      const selected = Array.isArray(data.requests) ? data.requests : [];
      if (!selected.length) {
        return sendJson(res, 400, { ok: false, reason: 'no_selection', error: '請先選擇要批准的申請' });
      }
      if (selected.length > 100) {
        return sendJson(res, 400, { ok: false, reason: 'too_many_requests', error: '每次最多批准 100 項' });
      }
      const seen = new Set();
      const requests = [];
      for (const row of selected) {
        const kind = String(row?.kind || '');
        const requestId = String(row?.request_id || row?.id || '').trim();
        const key = `${kind}:${requestId}`;
        if (!['req', 'log'].includes(kind) || !requestId || requestId.length > 160 || seen.has(key)) {
          return sendJson(res, 400, { ok: false, reason: 'invalid_selection', error: '選取項目格式不正確或有重複' });
        }
        seen.add(key);
        requests.push({ kind, request_id: requestId });
      }
      const confirmedDate = String(data.confirmed_date || '').trim();
      if (confirmedDate && !/^\d{4}-\d{2}-\d{2}$/.test(confirmedDate)) {
        return sendJson(res, 400, { ok: false, reason: 'invalid_date', error: '確認日期格式不正確' });
      }
      safeData = { requests, decision: 'approved', confirmed_date: confirmedDate,
        review_note: String(data.review_note || '').slice(0, 500) };
    } else if (SIGNED_REVIEW_ACTIONS.has(action)) {
      const requestId = String(data.request_id || '').trim();
      const decision = String(data.decision || '');
      if (!requestId || requestId.length > 160 || !['approved', 'rejected'].includes(decision)) {
        return sendJson(res, 400, { ok: false, reason: 'invalid_review', error: '審批資料不完整' });
      }
      const confirmedDate = String(data.confirmed_date || '').trim();
      if (confirmedDate && !/^\d{4}-\d{2}-\d{2}$/.test(confirmedDate)) {
        return sendJson(res, 400, { ok: false, reason: 'invalid_date', error: '確認日期格式不正確' });
      }
      safeData = { request_id: requestId, decision,
        review_note: String(data.review_note || '').slice(0, 500), confirmed_date: confirmedDate };
    }
    if (WRITE_ACTIONS.has(action)) {
      safeData = { ...safeData, operationId, operation_id: operationId };
    }
    /* Server-signed POST：同一 action、同一 /exec，只改用用途分隔 HMAC 驗證。
       body 同 query 各有一組簽名，兼容 GAS 302 redirect；兩粒 nonce 都由 GAS 消耗。 */
    const signReady = canSign(apiKey);
    /* @param targetAction 落喺 body 嘅 action（簽名 canonical 同 body 都用佢） */
    /* @param payload      除 action 外嘅業務欄位 */
    const signedPost = async (signedAction = targetAction, payload = safeData) => {
      const bodyOnly = { ...payload, action: signedAction };
      const rows = JSON.stringify(bodyOnly);
      const inner = makeLinkSig(signedAction, rows, apiKey);
      const out = { ...bodyOnly, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
      const rawOutgoing = JSON.stringify(out);
      const outgoingBytes = Buffer.byteLength(rawOutgoing, 'utf8');
      /* vsbadge 驗 rawBody 長度（連 sig 欄位）, 照樣以最終 UTF-8 bytes 為準 */
      if (outgoingBytes > LINK_SIG_MAX_BODY) {
        safeLog({ result: 'sig_body_too_big', action: signedAction, bytes: outgoingBytes, ms: Date.now() - t0 });
        return { tooBig: outgoingBytes };
      }
      const outer = makeLinkSig(signedAction, rawOutgoing, apiKey);
      const q = new URLSearchParams({ sig: outer.sig, sts: outer.ts, snonce: outer.nonce });
      const resp = await upstream(backend + (backend.includes('?') ? '&' : '?') + q.toString(), { method: 'POST', payload: out });
      return { resp };
    };

    if (action === 'load') {
      /* 先用同一 GAS 的標準 GET action；如部署要求 server signature，再向同一 /exec 重送。 */
      let qs = new URLSearchParams({ action: 'load' });
      if (apiKey) qs.set('apikey', apiKey);
      up = await upstream(backend + (backend.includes('?') ? '&' : '?') + qs.toString(), { method: 'GET' });
      if (up.json && up.json.upstream_only && signReady) {
        const signed = await signedPost();
        if (signed.tooBig) {
          return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '資料太大，簽唔到去進度後端' });
        }
        up = signed.resp; usedSignature = true;
      }
    } else if (PERSONAL_ACTIONS.has(action)) {
      /* 個人 bridge 不可用 API Key 代替身份。上面已由 server session 固定 YMIS；
         呢度再用支部 Key 簽 server-to-server request，GAS 只接受被簽住的 YMIS。 */
      if (!signReady) {
        return sendJson(res, 503, { ok: false, reason: 'no_sign_key', error: '伺服器未設定支部簽名 Key' });
      }
      const signed = await signedPost();
      if (signed.tooBig) {
        return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '個人進度請求太大' });
      }
      up = signed.resp; usedSignature = true;
    } else if (SIGNED_REVIEW_ACTIONS.has(action) || action === 'operationStatus') {
      /* Review/status is never authorised by API Key alone.  The HMAC protects this exact
         request in transit, while Unified independently resolves the opaque user
         session and checks progress:manage before touching any row. */
      if (!signReady) {
        return sendJson(res, 503, { ok: false, reason: 'no_sign_key', error: '伺服器未設定支部簽名 Key' });
      }
      const reviewerAuth = actor.super
        ? { unified_super: true, on_behalf: 'sheep' }
        : { sessionToken: firstStr(body.sessionToken) };
      const signed = await signedPost(targetAction, { ...safeData, ...reviewerAuth });
      if (signed.tooBig) {
        return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '審批請求太大' });
      }
      up = signed.resp; usedSignature = true;
    } else {
      const payload = { ...safeData, action: targetAction };
      if (apiKey) payload.apikey = apiKey;
      up = await upstream(backend, { method: 'POST', payload });
      if (up.json && up.json.upstream_only && signReady) {
        const signed = await signedPost();
        if (signed.tooBig) {
          return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '資料太大，簽唔到去進度後端' });
        }
        up = signed.resp; usedSignature = true;
      }
    }

    if (!up.json) {
      safeLog({ result: 'upstream_bad_response', action, status: up.status, ms: Date.now() - t0 });
      const hint = up.status >= 400
        ? `進度系統後端暫時無法使用（HTTP ${up.status}）`
        : '進度系統後端回應格式異常 —— 請確認 /exec 網址係「任何人可存取」嘅正式部署';
      return sendJson(res, 502, { ok: false, reason: 'upstream_bad_response', error: hint,
        ...(WRITE_ACTIONS.has(action) ? {
          operationId, outcome: 'unknown', mayHaveApplied: true,
          operation: { id: operationId, state: 'unknown', outcome: 'unknown' }
        } : {}) });
    }

    // GAS 業務錯誤（success:false）要照樣俾前端睇到；寫入必須有明確 receipt。
    const signatureRequired = up.json.upstream_only === true;
    const explicitOutcome = String(up.json.outcome || up.json.operation?.outcome || up.json.operation?.state || '').toLowerCase();
    const upstreamOk = up.status >= 200 && up.status < 300;
    const positive = up.json.success === true || up.json.ok === true || up.json.status === 'success';
    const negative = up.json.success === false || up.json.ok === false || up.json.status === 'error';
    let ok = false;
    let outcome = '';
    let mayHaveApplied = false;
    if (WRITE_ACTIONS.has(action)) {
      if (explicitOutcome === 'applied' || explicitOutcome === 'completed') {
        ok = true; outcome = 'applied'; mayHaveApplied = true;
      } else if (explicitOutcome === 'unknown' || explicitOutcome === 'processing') {
        outcome = 'unknown'; mayHaveApplied = true;
      } else if (explicitOutcome === 'not_sent' || explicitOutcome === 'not_applied'
          || explicitOutcome === 'failed' || explicitOutcome === 'rejected' || negative) {
        outcome = explicitOutcome === 'not_sent' ? 'not_sent' : 'not_applied';
      } else if (upstreamOk && positive && !signatureRequired) {
        ok = true; outcome = 'applied'; mayHaveApplied = true;
      } else {
        outcome = 'unknown'; mayHaveApplied = true;
      }
    } else {
      /* operationStatus is a read: its outcome describes the original write, not
         whether this status request itself succeeded. */
      ok = upstreamOk && positive && !signatureRequired;
      outcome = String(up.json.outcome || '');
      mayHaveApplied = up.json.mayHaveApplied === true;
    }
    const receiptMissing = WRITE_ACTIONS.has(action) && outcome === 'unknown'
      && !['unknown', 'processing'].includes(explicitOutcome);
    safeLog({ result: ok ? 'ok' : (signatureRequired ? 'signature_required' : receiptMissing ? 'receipt_missing' : 'gas_error'),
      action, signed: usedSignature, status: up.status, ms: Date.now() - t0 });
    return sendJson(res, 200, {
      ok,
      action,
      operationId: String(up.json.operationId || operationId || ''),
      outcome,
      mayHaveApplied,
      operation: progressBusinessData(up.json.operation || null),
      error: ok ? undefined : (signatureRequired
        ? 'Unified GAS 拒絕咗呢個 Progress action；請管理員核對 Registry APIKEY 同正式 deployment。'
        : receiptMissing ? `Unified GAS 冇提供明確寫入結果（HTTP ${up.status}）；系統冇重送`
          : (up.json.error || 'Unified GAS 拒絕咗呢個 Progress action')),
      data: progressBusinessData(up.json)
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', action, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, {
      ok: false,
      reason: timeout ? 'upstream_timeout' : 'network',
      error: timeout ? '進度系統後端回應逾時；唔代表寫入失敗' : '同進度後端斷線；未能確定寫入結果',
      ...(WRITE_ACTIONS.has(action) ? {
        operationId, outcome: 'unknown', mayHaveApplied: true,
        operation: { id: operationId, state: 'unknown', outcome: 'unknown' }
      } : {})
    });
  }
}
