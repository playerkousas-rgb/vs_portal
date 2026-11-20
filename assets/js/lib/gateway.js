import { beginOperation, operationResult } from './operations.js';

/* ============================================================
   gateway.js — Portal → 既有 BADGE Registry proxy 的唯一入口
   ------------------------------------------------------------
   所有 Portal action 只送同源 /api/proxy；Vercel server Registry 才能選出
   旅團目前使用的 BADGE /exec 並注入 API Key。Browser URL／Key、舊 localStorage
   backend 設定及 ?be= query 一律不能改寫 upstream。沒有 Registry／proxy 時 fail closed，
   不提供領袖自助貼 URL／Key 的第二條路。

   Admin 只可在正式共用 action contract 完成並由真 Apps Script staging 驗收後
   登記既有 BADGE URL／Key。Registry、proxy allowlist 或單次 action 回應都不是
   共用已通過的證據。
   ============================================================ */

/** Legacy URL validation helper for imports/tests only. Runtime routing never accepts a browser-supplied /exec. */
export const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

export function isExecUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || s.length > 300) return false;
  if (EXEC_URL_RE.test(s)) return true;
  /* 本機開發／測試例外：**頁面本身**就係喺 localhost 度開嗰陣，
     先至准打本機後端（同 api/_registry.js 嘅 V82_PROXY_TEST 同一個用意）。
     正式站（https://….vercel.app）永遠過唔到呢條 —— 唔會變成開放中繼。 */
  try {
    const host = typeof location !== 'undefined' ? String(location.hostname || '').toLowerCase() : '';
    const onLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';
    if (onLocal && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/[A-Za-z0-9._~\-/?=&%]*$/i.test(s)) return true;
  } catch { /* ignore */ }
  return false;
}

/** 正規化（去空白／尾 slash） */
export function normExecUrl(u) {
  const s = String(u || '').trim();
  return s.replace(/\/+$/, '');
}

/* Proxy 明確回報尚未登記；Portal 不會因此直連 browser 提交的 /exec，必須 fail closed。 */
export const UNREGISTERED_RE = /找不到此旅團|後端網址未設定|unknown unit|not registered|no backend/i;

/** 有冇同源 /api/proxy 可以用（http/https 先有；file:// 冇） */
export function proxyUsable() {
  try { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol); }
  catch { return false; }
}

/**
 * @deprecated `?be=` was a browser-selected direct backend route. Runtime now uses only
 * the trusted server Registry; ignore stale query parameters so a copied link cannot
 * select a second data source.
 */
export function beFromQuery(_search) { return ''; }

/* Vercel 代理單一回應上限 4.5MB。爆咗嗰陣 Vercel 唔會回 JSON，
   而係回一段純文字（例如 FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE）。
   前端一定要認得出呢種情況 —— 佢嘅救法（分段讀／瘦身）同「後端壞咗」完全唔同。 */
export const PAYLOAD_TOO_LARGE_RE = /PAYLOAD_TOO_LARGE|response.{0,20}too large|body.{0,20}too large|payload.{0,20}exceed/i;

/* 重要寫入一定帶不可預測 operation ID。讀取、登入同狀態查詢唔會建立寫入紀錄。 */
export const CRITICAL_WRITE_ACTIONS = new Set([
  'saveDb', 'saveDbPart', 'saveDbCommit', 'saveTables', 'sync', 'uploadPhotos', 'repairDb', 'saveDbForce',
  'authChangePassword', 'authResetPassword', 'authDeleteAccount', 'authRestoreAccount', 'authCreateAccount', 'authOpenAccounts',
  'authForgotPassword', 'authResetByToken', 'authCompletePasswordReset', 'hubRsvp', 'hubQuiz', 'hubAbsence', 'hubNoticeSignup',
  'submitRegistration', 'submitIssue'
]);

/** 回應過大嗰陣嘅人話解釋（唔會再講「未設定後端網址」） */
function tooLargeError(status, text) {
  if (PAYLOAD_TOO_LARGE_RE.test(text)) {
    return 'Portal proxy 回應超出 Vercel 代理上限（4.5MB）。請停止重試並聯絡 Admin 核對正式 BADGE compatibility contract；不要建立新 Sheet／GAS、貼測試 Code.gs 或自行重新部署。';
  }
  return `後端回應格式異常（HTTP ${status}）`;
}

async function postJson(endpoint, body, timeoutMs, plain) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      /* text/plain 避免 CORS preflight（Apps Script 唔支援 OPTIONS） */
      headers: { 'Content-Type': plain ? 'text/plain;charset=utf-8' : 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); }
    catch {
      /* 文字唔係 JSON：有啲環境（測試 stub／某啲代理）只暴露 res.json()。
         瀏覽器度呢度會拋「body already used」—— 照樣當「唔係 JSON」處理。 */
      try { if (typeof res.json === 'function') json = await res.json(); } catch { /* 真係唔係 JSON */ }
    }
    if (!json) {
      return {
        ok: false, json: null, status: res.status,
        /* 只可喺伺服器明確話 endpoint 不存在／方法不支援時改走直連。
           502/503 HTML 錯誤頁可能係 proxy 已經把寫入送上游之後先崩潰；
           若把「任何 HTML」都當 noApi 再送一次，就會製造重複寫入。 */
        noApi: res.status === 404 || res.status === 405,
        /* 回應過大（Vercel 4.5MB 硬上限）要**講真話**：呢個唔係「後端壞」，
           更唔係「未設定後端網址」—— 係資料庫大過單一回應上限，要分段讀。
           2026-09-20 事故：呢度淨係回「回應格式異常」，用家完全估唔到死因。 */
        tooLarge: PAYLOAD_TOO_LARGE_RE.test(text),
        error: tooLargeError(res.status, text), reason: PAYLOAD_TOO_LARGE_RE.test(text) ? 'too_large' : 'bad_response'
      };
    }
    return { ok: res.ok, json, status: res.status, noApi: false, tooLarge: false, error: '', reason: '' };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, json: null, status: 0, noApi: false, tooLarge: false, error: aborted ? '連線逾時' : (e?.message || '網絡錯誤'), reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Send an action through the same-origin Portal proxy only.
 * `execUrl`, `apiKey` and `preferDirect` remain accepted for source compatibility,
 * but are intentionally ignored so neither browser state nor `?be=` can select an
 * upstream or expose a service key.
 */
export async function postBackend(payload, { unit, timeoutMs = 60000 } = {}) {
  const action = String(payload?.action || '');
  const operation = CRITICAL_WRITE_ACTIONS.has(action)
    ? beginOperation(action, { operationId: payload?.operationId || payload?.operation_id, unit, label: action })
    : null;
  const body = { ...payload, unit };
  delete body.backend; delete body.gasUrl; delete body.apiKey; delete body.apikey;
  if (operation) {
    body.operationId = operation.id;
    body.operation_id = operation.id;
  }
  const done = (result, { sent = true } = {}) => {
    if (!operation) return result;
    const j = result?.json && typeof result.json === 'object' ? result.json : {};
    const classified = operationResult({
      ...j,
      ok: result?.ok === true && j.ok !== false && j.success !== false,
      reason: j.reason || j.code || result?.reason || '',
      error: j.error || result?.error || '',
      mayHaveApplied: j.mayHaveApplied === true || (sent && !result?.json && ['timeout', 'network', 'bad_response'].includes(String(result?.reason || '')))
    }, operation, { sent });
    return { ...result, ...classified, ok: classified.outcome === 'applied',
      operationId: classified.operationId || operation.id };
  };

  if (!proxyUsable()) {
    return done({ ok: false, json: null, via: 'none', unregistered: false,
      reason: 'proxy_required', error: 'Portal 必須經同源 Registry proxy 使用既有 BADGE backend；不接受 browser /exec 或 API Key。請使用正式 Portal 網址並聯絡 Admin。' }, { sent: false });
  }

  const r = await postJson('api/proxy', body, timeoutMs, false);
  const errText = String(r.json?.error || '');
  const proxySaysUnregistered = !!r.json && r.status === 404
    && (r.json.reason === 'not_registered' || UNREGISTERED_RE.test(errText));

  if (r.json) {
    return done({ ok: r.ok, json: r.json, status: r.status, via: 'proxy',
      error: r.ok ? '' : (errText || r.error || 'Portal proxy 拒絕請求'),
      reason: proxySaysUnregistered ? 'not_registered' : (r.json.reason || r.reason || ''),
      unregistered: proxySaysUnregistered, tooLarge: false });
  }
  if (r.noApi) {
    return done({ ok: false, json: null, via: 'none', unregistered: false,
      reason: 'proxy_required', error: '此網站沒有 Portal 同源 API proxy；不會改用 browser 直連或貼入第二個 backend。請使用正式 Portal 網址並聯絡 Admin。' }, { sent: false });
  }
  return done({ ok: false, json: null, via: 'proxy', unregistered: false,
    error: r.error || 'Portal proxy 回應異常', reason: r.tooLarge ? 'too_large' : (r.reason || 'network'),
    tooLarge: !!r.tooLarge });
}

/** 短網址（顯示用） */
export function shortExec(u) {
  const s = String(u || '');
  if (!s) return '';
  const m = /\/macros\/s\/([A-Za-z0-9_-]+)/.exec(s);
  return m ? `script.google.com/…/${m[1].slice(0, 8)}…/exec` : s.slice(0, 48);
}
