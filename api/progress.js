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
   考核項目固定讀 app 內建 data/progress/items.json，不接受 remote override。

   後端網址／API Key：固定使用同一旅團 Registry 的 TROOP_<旅團>_BACKEND／APIKEY。
   瀏覽器傳入 backend／apikey 會被忽略，不能把進度改送另一支 GAS。

   安全：
     1. 只准 https://script.google.com/macros/s/…/exec（擋 open proxy；可用 V82_PROXY_TEST=1 放行本機 mock）
     2. payload ≤ 1 MB；上游 45 秒逾時
     3. log 只記 metadata：唔記 API Key、唔記 payload 內容、唔記完整後端網址
   ============================================================ */

import crypto from 'node:crypto';
import { isTrustedExecUrl, getProgressRegistryEntry, getTrustedUnit } from './_registry.js';
import { verifySuperSession } from './_super-session.js';

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
   有嗰條 SHEET KEY（＝TROOP_<id>_APIKEY）就出到同一款簽名，
   直接 POST 到同一 Unified GAS /exec 就入得。
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

// 旅團後端（Code.gs）支援嘅 action（唔會放寬）
const ACTIONS = new Set(['load', 'save', 'saveOtherBadge', 'reviewRequest', 'reviewLogRequest',
  /* 團員入口只可走個人 bridge：由 server session 對出 YMIS，再叫後端只回／寫本人。 */
  'myProgress', 'addRequest', 'myRequests',
  /* Unified 支部本地入口：getLinkState 讀狀態；現階段 setLocalLogin 只准
     allow:true 開返，防止未有中央旅系統時把正常登入入口鎖死。GAS 保留未來
     上游簽名控制能力，但第 4 階段旅系統會直接 server-to-server 呼叫。 */
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

/** 閂咗直接入口時，用同一套 link signature 做 server-to-server 請求。 */
async function signedUpstream(url, action, payload, key) {
  const bodyOnly = { ...(payload || {}), action };
  const inner = makeLinkSig(action, JSON.stringify(bodyOnly), key);
  const outgoing = { ...bodyOnly, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  const raw = JSON.stringify(outgoing);
  if (raw.length > LINK_SIG_MAX_BODY) return { tooBig: raw.length };
  const outer = makeLinkSig(action, raw, key);
  const qs = new URLSearchParams({ sig: outer.sig, sts: outer.ts, snonce: outer.nonce });
  return { resp: await upstream(url + (url.includes('?') ? '&' : '?') + qs, { method: 'POST', payload: outgoing }) };
}

const STAFF_ROLES = new Set(['chief', 'leader', 'admin', 'exco', 'super']);
const PERSONAL_ACTIONS = new Set(['myProgress', 'addRequest', 'myRequests']);

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
  const portalToken = firstStr(body.portalToken);
  if (!sessionToken && !portalToken) {
    return { ok: false, status: 401, reason: 'session_required', error: '登入狀態已失效，請重新登入' };
  }
  const payload = {
    action: 'authWhoAmI', unit: unit.code, apiKey: unit.apiKey,
    ...(portalToken ? { portalToken } : { sessionToken })
  };
  let check = await upstream(unit.gasUrl, { method: 'POST', payload });
  if (check.json?.upstream_only && canSign(unit.apiKey)) {
    const signed = await signedUpstream(unit.gasUrl, 'authWhoAmI', {
      unit: unit.code, ...(portalToken ? { portalToken } : { sessionToken })
    }, unit.apiKey);
    if (signed.tooBig) return { ok: false, status: 413, reason: 'auth_request_too_big', error: '登入核對請求太大' };
    check = signed.resp;
  }
  const account = check.json?.account;
  if (!check.json?.ok || !account) {
    return { ok: false, status: 401, reason: 'session_invalid', error: check.json?.error || '登入狀態已失效，請重新登入' };
  }
  return {
    ok: true,
    role: String(account.role || 'member').toLowerCase(),
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

  /* 第 3 階段沒有中央旅系統，關閉支部唯一正常登入入口永遠不是有效操作。
     在 session 核對（本身亦會打 Unified GAS）之前拒絕，確保這類請求不會向
     GAS 發出任何流量，更不可能因下游／驗證流程改動而意外關門。 */
  if (action === 'setLocalLogin') {
    const requested = String(data.allow ?? '').trim().toLowerCase();
    if (['0', 'false', 'no', 'off', 'close', 'closed'].indexOf(requested) >= 0) {
      return sendJson(res, 409, { ok: false, reason: 'phase3_local_login_required',
        error: '現階段未有中央旅系統，支部本地入口必須保持開啟。' });
    }
  }

  /* 除上述無條件拒絕的危險操作外，所有進度 action 都要先由 server session 對回可信身份。 */
  let actor = null;
  if (!unit) return sendJson(res, 400, { ok: false, reason: 'unit_required', error: '缺少旅團編號' });
  try { actor = await authenticate(unit, body); }
  catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return sendJson(res, timeout ? 504 : 502, { ok: false, reason: 'auth_unavailable', error: timeout ? '登入核對逾時' : '暫時無法核對登入狀態' });
  }
  if (!actor.ok) return sendJson(res, actor.status || 401, { ok: false, reason: actor.reason, error: actor.error });
  if (PERSONAL_ACTIONS.has(action)) {
    if (!actor.ymis) return sendJson(res, 403, { ok: false, reason: 'member_ymis_missing', error: '登入帳戶未綁定 YMIS，無法讀取個人進度' });
  } else if (!STAFF_ROLES.has(actor.role)) {
    return sendJson(res, 403, { ok: false, reason: 'staff_required', error: '你沒有權限管理進度' });
  }

  // ---- 1. 後端網址／API Key：只用同一旅團嘅 server Registry ----
  const reg = getProgressRegistryEntry(unit);
  const backend = String(reg.backend || '').trim();
  const apiKey = String(reg.apiKey || '').trim();

  const usingServerSide = !!(reg.backend && reg.apiKey);
  /* 簽名根密鑰＝同一 Unified GAS 的 API_KEY。Browser 提交的 backend／apikey
     不參與選路或驗證；有條 ≥8 字元 KEY，收到 upstream_only 就兜去簽名。 */

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


  try {
    let up;
    let sentVia = 'api';
    let targetAction = action;
    let safeData = data;
    if (action === 'myProgress') {
      targetAction = 'loadMine';
      safeData = { ymis: actor.ymis };
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
    }
    /* 純簽名 POST：閂咗直接入口嘅 vsbadge 後端 doPost 會喺「直接入口」掣之前先驗簽名。
       簽名完全照 vsbadge callDownstream：body 一組（digest 綁去 sig 欄位後嘅 body）、
       query 一組（digest 綁成支原始 body），驗收時 query 優先，兩粒 nonce 一齊消耗。 */
    const signReady = canSign(apiKey);
    /* @param targetAction 落喺 body 嘅 action（簽名 canonical 同 body 都用佢） */
    /* @param payload      除 action 外嘅業務欄位（setLocalLogin 用 {allow:true|false}） */
    const signedPost = async (signedAction = targetAction, payload = safeData) => {
      const bodyOnly = { ...payload, action: signedAction };
      const rows = JSON.stringify(bodyOnly);
      const inner = makeLinkSig(signedAction, rows, apiKey);
      const out = { ...bodyOnly, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
      const rawOutgoing = JSON.stringify(out);
      /* vsbadge 驗 rawBody 長度（連 sig 欄位）, 照樣以最終 body 為準 */
      if (rawOutgoing.length > LINK_SIG_MAX_BODY) {
        safeLog({ result: 'sig_body_too_big', action: signedAction, bytes: rawOutgoing.length, ms: Date.now() - t0 });
        return { tooBig: rawOutgoing.length };
      }
      const outer = makeLinkSig(signedAction, rawOutgoing, apiKey);
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
      up = signed.resp; sentVia = 'link';
    } else if (action === 'getLinkState' || action === 'setLocalLogin') {
      /* 支部本地入口狀態／復原。兩個 action 都要 server-side link signature；
         第 3 階段只容許查狀態或 allow:true 開返，不容許由支部 browser 關閉。
         第 4 階段旅系統建立後，才由真正上游直接簽名控制 GAS。 */
      if (!signReady) {
        return sendJson(res, 400, { ok: false, reason: 'no_sign_key',
          error: '未設定 Unified GAS API Key，無法讀取或復原支部本地入口。' });
      }
      if (action === 'setLocalLogin') {
        const raw = String(data.allow ?? '').trim().toLowerCase();
        const allow = ['1', 'true', 'yes', 'on', 'open'].indexOf(raw) >= 0;
        if (!allow && ['0', 'false', 'no', 'off', 'close', 'closed'].indexOf(raw) < 0) {
          return sendJson(res, 400, { ok: false, reason: 'bad_allow',
            error: '開關值唔正確（現階段只接受 allow: true 開返本地入口）。' });
        }
        /* 第 3 階段未有中央旅系統：本地帳戶係正常主入口。支部 UI/API
           不可把自己鎖死；第 4 階段完成 SSO staging 後，旅系統會直接以
           上游簽名控制 GAS，而不是由 browser 經呢條路關門。 */
        if (!allow) {
          return sendJson(res, 409, { ok: false, reason: 'phase3_local_login_required',
            error: '現階段未有中央旅系統，支部本地入口必須保持開啟。' });
        }
      }
      const signed = await signedPost(action, action === 'setLocalLogin' ? { allow: 'true' } : {});
      if (signed.tooBig) {
        return sendJson(res, 413, { ok: false, reason: 'sig_body_too_big', error: '資料太大，簽唔到去 VSBADGE 後端' });
      }
      up = signed.resp; sentVia = 'link';
    } else {
      const payload = { ...safeData, action: targetAction };
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
