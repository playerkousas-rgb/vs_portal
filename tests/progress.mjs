/* ============================================================
   tests/progress.mjs — Progress 同源轉發 API 測試（一個 Unified 後端、多個 client）
   ------------------------------------------------------------
   驗證 /api/progress 嘅安全規則同轉發行為：
     · 只接受 POST、action 白名單、後端一定要係 GAS /exec
     · load 用 GET + apikey；save / saveOtherBadge 用 POST + apikey
     · 考核項目固定用 app 內建靜態檔；API 不接受 remote catalog proxy
     · 審批中心：reviewRequest / reviewLogRequest 照樣帶 apikey 轉發，業務錯誤唔會當成功
     · 只用同一旅團 TROOP_<id>_BACKEND／APIKEY；browser backend／apikey 被忽略
     · 已移除嘅 action（diag）唔可以再放行 —— 白名單唔留死表面
     · 唔會 log API Key
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import progressHandler from '../api/progress.js';
import { issueSuperSession } from '../api/_super-session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n▌進度紀錄 API 測試（讀／寫旅團自己嘅後端）');

const BACKEND = 'https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqBiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec';
const API_KEY = 'vs_testkey_should_never_be_logged';
const STAFF_TOKEN = 'staff-session-token';
const MEMBER_TOKEN = 'member-session-token';
const MEMBER_YMIS = '1234567890';
const MEMBER_NAME = '陳大文';

/* 身份、行政與進度固定使用同一 Registry 後端／Key。 */
const previousTroopsJson = process.env.TROOPS_JSON;
process.env.TROOPS_JSON = JSON.stringify({
  '0082': { backend: BACKEND, apiKey: API_KEY, name: '測試旅' }
});

/* ---------- mock res ---------- */
function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}

/* ---------- mock fetch（攔截身份 GAS ＋進度 GAS） ---------- */
const calls = [];
let upstreamJson = { success: true, members: [{ ymis: MEMBER_YMIS, name: MEMBER_NAME }], progress: { [MEMBER_YMIS]: { 'L1-ACT-01': { date: '2026-09-01', confirmer: '團長' } } }, pendingRequests: [], otherBadges: {}, logs: [], logRequests: [] };
let upstreamStatus = 200;
const realFetch = globalThis.fetch;

function jsonResponse(value, status = 200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { status, async text() { return text; } };
}
function authResult(body = {}) {
  const token = String(body.sessionToken || '');
  if (token === STAFF_TOKEN) {
    return { ok: true, success: true, account: { id: 'staff-1', memberId: 'member-staff-1', ymis: 'STAFF-9001', name: '可信領袖', role: 'leader' } };
  }
  if (token === MEMBER_TOKEN) {
    return { ok: true, success: true, account: { id: 'member-1', memberId: 'member-1', ymis: MEMBER_YMIS, name: MEMBER_NAME, role: 'member' } };
  }
  return { ok: false, success: false, error: '登入狀態已失效' };
}
async function defaultMockFetch(target, init = {}) {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ target: String(target), method: init.method || 'GET', body });
  if (body?.action === 'authWhoAmI') return jsonResponse(authResult(body));
  return jsonResponse(upstreamJson, upstreamStatus);
}
globalThis.fetch = defaultMockFetch;

const logLines = [];
const realLog = console.log;
console.log = (...a) => { logLines.push(a.join(' ')); };

async function call(payload, method = 'POST') {
  const body = { ...(payload || {}) };
  if (method === 'POST') {
    if (!Object.prototype.hasOwnProperty.call(body, 'unit')) body.unit = '0082';
    if (!Object.prototype.hasOwnProperty.call(body, 'sessionToken')) body.sessionToken = STAFF_TOKEN;
  }
  const res = mockRes();
  await progressHandler({ method, body }, res);
  return res;
}

/* ---------- 1. 基本規則 ---------- */
ok('只接受 POST（GET 會 405）', (await call({ action: 'load' }, 'GET')).statusCode === 405);
ok('未知 action 會 400', (await call({ action: 'deleteEverything' })).statusCode === 400);
ok('舊嘅 items action 已經唔存在（唔再連去任何前端）', (await call({ action: 'items' })).statusCode === 400);
ok('未登記旅團 fail closed',
  (await call({ action: 'load', unit: '0099', backend: BACKEND, apikey: API_KEY })).body?.reason === 'auth_backend_not_configured');
const forgedRoute = await call({ action: 'load', backend: 'https://evil.example.com/exec', apikey: 'attacker-key' });
const forgedRouteCall = calls[calls.length - 1];
ok('browser backend／apikey 被忽略，唔會變成 open proxy',
  forgedRoute.body?.ok === true && forgedRouteCall.target.startsWith(BACKEND)
    && forgedRouteCall.target.includes('apikey=' + API_KEY), forgedRouteCall.target);
const forgedDev = await call({ action: 'load', backend: BACKEND.replace('/exec', '/dev'), apikey: 'wrong' });
ok('browser 亦不可把同一 GAS 改成 /dev',
  forgedDev.body?.ok === true && calls[calls.length - 1].target.startsWith(BACKEND));

/* ---------- 1b. 身份邊界：冇 session、團員完整 load、偽造 YMIS、超管票據 ---------- */
{
  const beforeNoSession = calls.length;
  const none = await call({ action: 'load', backend: BACKEND, apikey: API_KEY, sessionToken: '' });
  ok('★ 冇 session → 401，唔會碰身份／進度後端',
    none.statusCode === 401 && none.body?.reason === 'session_required' && calls.length === beforeNoSession,
    JSON.stringify(none.body));

  const invalid = await call({ action: 'load', backend: BACKEND, apikey: API_KEY, sessionToken: 'forged-session' });
  ok('★ 偽造／失效 session → 401', invalid.statusCode === 401 && invalid.body?.reason === 'session_invalid', JSON.stringify(invalid.body));

  const beforeMemberLoad = calls.length;
  const full = await call({ action: 'load', backend: BACKEND, apikey: API_KEY, sessionToken: MEMBER_TOKEN });
  ok('★ 團員不可下載完整全團 load payload',
    full.statusCode === 403 && full.body?.reason === 'staff_required' && calls.length === beforeMemberLoad + 1,
    JSON.stringify(full.body));

  upstreamJson = {
    success: true,
    members: [{ ymis: MEMBER_YMIS, name: MEMBER_NAME }],
    progress: { [MEMBER_YMIS]: { MINE: { date: '2026-11-12' } } },
    requests: []
  };
  const mine = await call({ action: 'myProgress', backend: BACKEND, apikey: API_KEY,
    sessionToken: MEMBER_TOKEN, data: { ymis: 'VICTIM-9999', name: '冒認者' } });
  const mineCall = calls[calls.length - 1];
  ok('★ myProgress 轉成 loadMine，而且 YMIS 只取 server 核對身份',
    mine.statusCode === 200 && mine.body?.ok === true && mineCall.body?.action === 'loadMine'
      && mineCall.body?.ymis === MEMBER_YMIS && !JSON.stringify(mineCall.body).includes('VICTIM-9999'),
    JSON.stringify(mineCall.body));

  upstreamJson = { success: true, request_id: 'REQ-safe' };
  const add = await call({ action: 'addRequest', backend: BACKEND, apikey: API_KEY,
    sessionToken: MEMBER_TOKEN,
    data: { ymis: 'VICTIM-9999', name: '冒認者', item_id: 'VS-C1', item_name: '測試', requested_date: '2026-11-12', evidence: '證明' } });
  const addCall = calls[calls.length - 1];
  ok('★ addRequest 丟棄 client 偽造身份，以 server 本人 YMIS／姓名寫入',
    add.body?.ok === true && addCall.body?.ymis === MEMBER_YMIS && addCall.body?.name === MEMBER_NAME
      && !JSON.stringify(addCall.body).includes('VICTIM-9999') && !JSON.stringify(addCall.body).includes('冒認者'),
    JSON.stringify(addCall.body));

  const beforePortalOnly = calls.length;
  const portalOnly = await call({ action: 'myRequests', backend: BACKEND, apikey: API_KEY,
    sessionToken: '', portalToken: 'legacy-portal-token', data: { ymis: 'OTHER-0001' } });
  ok('★ Progress 不接受 auth fixture／舊 portalToken 代替支部 session',
    portalOnly.statusCode === 401 && portalOnly.body?.reason === 'session_required'
      && calls.length === beforePortalOnly, JSON.stringify(portalOnly.body));

  upstreamJson = { success: true, requests: [] };
  await call({ action: 'myRequests', backend: BACKEND, apikey: API_KEY,
    sessionToken: MEMBER_TOKEN, data: { ymis: 'OTHER-0001' } });
  const requestCall = calls[calls.length - 1];
  ok('★ myRequests 同樣忽略跨人 YMIS，只讀支部 session 本人',
    requestCall.body?.action === 'myRequests' && requestCall.body?.ymis === MEMBER_YMIS
      && !JSON.stringify(requestCall.body).includes('OTHER-0001'), JSON.stringify(requestCall.body));

  const oldSuperKey = process.env.SUPER_KEY;
  process.env.SUPER_KEY = 'progress-super-session-test-key';
  const ticket = issueSuperSession('sheep');
  upstreamJson = { success: true, members: [], progress: {} };
  const beforeSuper = calls.length;
  const superLoad = await call({ action: 'load', backend: BACKEND, apikey: API_KEY, sessionToken: ticket.token });
  const superCalls = calls.slice(beforeSuper);
  ok('★ 有效超管 HMAC session 可管理進度，且唔會交 GAS authWhoAmI',
    superLoad.statusCode === 200 && superLoad.body?.ok === true
      && !superCalls.some(c => c.body?.action === 'authWhoAmI'), JSON.stringify(superLoad.body));
  if (oldSuperKey === undefined) delete process.env.SUPER_KEY; else process.env.SUPER_KEY = oldSuperKey;

  upstreamJson = { success: true, members: [{ ymis: MEMBER_YMIS, name: MEMBER_NAME }], progress: { [MEMBER_YMIS]: { 'L1-ACT-01': { date: '2026-09-01', confirmer: '團長' } } }, pendingRequests: [], otherBadges: {}, logs: [], logRequests: [] };
}

/* ---------- 2. load（讀進度） ---------- */
{
  const r = await call({ action: 'load', unit: '0082', backend: BACKEND, apikey: API_KEY });
  ok('load 回 200 同 ok:true', r.statusCode === 200 && r.body.ok === true);
  const c = calls[calls.length - 1];
  ok('load 用 GET 打 ?action=load&apikey=…', c.method === 'GET' && c.target.includes('action=load') && c.target.includes('apikey=' + API_KEY), c.target.slice(0, 80));
  ok('回傳 members / progress 原樣（前端要嚟畫進度）',
    r.body.data?.members?.[0]?.name === '陳大文' && !!r.body.data?.progress?.['1234567890']?.['L1-ACT-01']);

  /* Response normalization must preserve a successful, header-only Progress tab. */
  upstreamJson = {
    success: true,
    members: [{ ymis: MEMBER_YMIS, name: MEMBER_NAME }],
    progress: {}, flatProgress: {}, pendingRequests: [], otherBadges: {}, logs: [], logRequests: []
  };
  const empty = await call({ action: 'load', unit: '0082' });
  ok('同一後端有正常成員但進度分頁為空，proxy 仍回 ok:true',
    empty.statusCode === 200 && empty.body?.ok === true
      && empty.body?.data?.members?.[0]?.ymis === MEMBER_YMIS
      && Object.keys(empty.body?.data?.progress || {}).length === 0,
    JSON.stringify(empty.body));
  upstreamJson = {
    success: true,
    members: [{ ymis: MEMBER_YMIS, name: MEMBER_NAME }],
    progress: { [MEMBER_YMIS]: { 'L1-ACT-01': { date: '2026-09-01', confirmer: '團長' } } },
    pendingRequests: [], otherBadges: {}, logs: [], logRequests: []
  };
}

/* ---------- 3. save（勾進度） ---------- */
{
  upstreamJson = { success: true, processed: 2 };
  const changes = [
    { ymis: '1234567890', itemId: 'L1-ACT-02', date: '2026-09-16', uncomplete: false, note: '' },
    { ymis: '1234567890', itemId: 'L1-ACT-03', date: '2026-09-16', uncomplete: true, note: '' }
  ];
  const r = await call({ action: 'save', unit: '0082', backend: BACKEND, apikey: API_KEY, data: { changes, confirmer: '執委會' } });
  const c = calls[calls.length - 1];
  ok('save 回 200 同 ok:true', r.statusCode === 200 && r.body.ok === true);
  ok('save 用 POST 送去 GAS，帶 action / apikey / changes',
    c.method === 'POST' && c.body?.action === 'save' && c.body?.apikey === API_KEY && c.body?.changes?.length === 2);
  ok('save 帶 confirmer 同 uncomplete（取消勾選）',
    c.body?.confirmer === '執委會' && c.body?.changes?.[1]?.uncomplete === true);
  ok('回傳 processed 俾前端交代', r.body.data?.processed === 2);
}

/* ---------- 4. saveOtherBadge ---------- */
{
  upstreamJson = { success: true };
  await call({ action: 'saveOtherBadge', unit: '0082', backend: BACKEND, apikey: API_KEY, data: { records: [{ ymis: '1', badgeId: 'SVC', name: '服務' }] } });
  const c = calls[calls.length - 1];
  ok('saveOtherBadge 帶 records 陣列', c.body?.action === 'saveOtherBadge' && Array.isArray(c.body?.records));
}

/* ---------- 4a2. Progress API 邊界：登入閘門／旅系統 action 不屬於此處 ---------- */
{
  const before = calls.length;
  const state = await call({ action: 'getLinkState', unit: '0082' });
  const toggle = await call({ action: 'setLocalLogin', unit: '0082', data: { allow: 'true' } });
  ok('Progress API 拒絕入口狀態 action', state.statusCode === 400 && state.body?.ok === false);
  ok('Progress API 拒絕入口控制 action', toggle.statusCode === 400 && toggle.body?.ok === false);
  ok('被拒 action 不會核對 session 或碰 Unified GAS', calls.length === before);
}

/* ---------- 4b. 審批中心（批／拒團員申報） ---------- */
{
  upstreamJson = { success: true, message: '已批准並寫入進度' };
  const r = await call({ action: 'reviewRequest', unit: '0082', backend: BACKEND, apikey: API_KEY,
    data: { request_id: 'RQ_1', decision: 'approved', review_note: '', reviewer: '陳團長', confirmed_date: '2026-09-16' } });
  const c = calls[calls.length - 1];
  ok('reviewRequest 用 POST 送去後端（帶 request_id／decision／reviewer）',
    r.statusCode === 200 && c.method === 'POST' && c.body?.action === 'reviewRequest'
    && c.body?.request_id === 'RQ_1' && c.body?.decision === 'approved' && c.body?.reviewer === '陳團長');
  ok('reviewRequest 由 server 注入同一 API Key（身份仍由 session 決定）', c.body?.apikey === API_KEY);

  upstreamJson = { success: true, message: '已批准並寫入活動履歷', record_id: 'LOG_X' };
  const r2 = await call({ action: 'reviewLogRequest', unit: '0082', backend: BACKEND, apikey: API_KEY,
    data: { request_id: 'LR_1', decision: 'approved', reviewer: '陳團長' } });
  const c2 = calls[calls.length - 1];
  ok('reviewLogRequest 一樣照轉發（批准會寫入活動履歷）',
    r2.statusCode === 200 && c2.body?.action === 'reviewLogRequest' && c2.body?.request_id === 'LR_1');

  const forgedReviewRoute = await call({ action: 'reviewRequest', backend: 'https://evil.example.com/exec',
    apikey: 'attacker', data: { request_id: 'RQ-safe', decision: 'approved' } });
  ok('審批同樣忽略 browser 後端／Key，只送 Registry Unified GAS',
    forgedReviewRoute.body?.ok === true && calls[calls.length - 1].target === BACKEND
      && calls[calls.length - 1].body?.apikey === API_KEY);
  upstreamJson = { success: false, error: '呢個申請已經處理過' };
  const r3 = await call({ action: 'reviewRequest', unit: '0082', backend: BACKEND, apikey: API_KEY, data: { request_id: 'RQ_1', decision: 'approved' } });
  ok('後端話已處理過 → 前端睇到錯誤（唔會當成功）',
    r3.body?.ok === false && /已經處理過/.test(r3.body?.error || ''), JSON.stringify(r3.body));
  upstreamJson = { success: true };
}

/* ---------- 5. GAS 業務錯誤（例：API Key 錯）---------- */
{
  upstreamJson = { success: false, error: 'Invalid API Key' };
  const r = await call({ action: 'load', unit: '0082', backend: BACKEND, apikey: 'wrong' });
  ok('GAS 回 success:false → ok:false 同帶錯誤訊息',
    r.statusCode === 200 && r.body.ok === false && /API Key/.test(r.body.error || ''), JSON.stringify(r.body));
}

/* ---------- 6. catalog 固定內建；API 不做 remote proxy ---------- */
{
  upstreamJson = { success: true, members: [], progress: {} };
  const before = calls.length;
  const denied = await call({ action: 'catalog', catalog: 'https://example.org/items.json' });
  ok('remote catalog action 已移出白名單', denied.statusCode === 400 && denied.body?.ok === false);
  ok('remote catalog 被拒時不會發出任何上游請求', calls.length === before);
  const normal = await call({ action: 'load', catalog: 'https://evil.example/items.json' });
  ok('browser catalog 欄不影響正常讀取，仍只連 Registry Unified GAS',
    normal.body?.ok === true && calls[calls.length - 1].target.startsWith(BACKEND));
}

/* ---------- 7. 同一主 Registry（前端完全不傳 key；舊進度 env 被忽略） ---------- */
{
  process.env.TROOP_0082_PROGRESSBACKEND = 'https://script.google.com/macros/s/AKfycbOLDSEPARATEBACKENDMUSTBEIGNORED000000/exec';
  process.env.TROOP_0082_PROGRESSAPIKEY = 'old_separate_key_must_be_ignored';
  upstreamJson = { success: true, members: [], progress: {} };
  const r = await call({ action: 'load', unit: '0082' });
  const c = calls[calls.length - 1];
  ok('只用主 Registry 後端（前端可以完全唔填）', r.body.ok === true && c.target.startsWith(BACKEND));
  ok('只用與 BADGE 相同的主 API Key，舊 PROGRESS* 不可改路',
    c.target.includes(API_KEY) && !c.target.includes('old_separate_key'));
  ok('回覆只含 action 結果，不公開 Registry readiness',
    !Object.prototype.hasOwnProperty.call(r.body, 'serverSideKey'));
  delete process.env.TROOP_0082_PROGRESSBACKEND;
  delete process.env.TROOP_0082_PROGRESSAPIKEY;
}

/* ---------- 7b. ★ 已移除嘅 diag 唔可以再放行 ----------
   2026-11-12：GAS `diag` action 連 diagnoseBackendTabs() 一齊刪走
   （對應 UI 喺 2026-09-26 已經拆咗，得返測試夾具叫佢）。
   白名單如果仲放行 diag，等於留咗個冇 handler 嘅死表面 —— 呢度釘死佢。
   （原本呢節驗嘅兩條網址守衛：backend_missing／backend_not_allowed，
     喺上面第 65–69 行已經用 live 嘅 load 驗過，覆蓋冇減少。） */
{
  const gone = await call({ action: 'diag', unit: '0082', backend: BACKEND, apikey: API_KEY });
  ok('★ diag 已移除 → 代理拒绝（400 bad_action），唔會轉發去後端',
    gone.statusCode === 400, JSON.stringify({ status: gone.statusCode, body: gone.body }).slice(0, 140));
  const src = fs.readFileSync(path.join(ROOT, 'api', 'progress.js'), 'utf8');
  ok('★ 進度代理白名單冇留低 diag', !/'diag'/.test(src));
}

/* ---------- 7c. ★ 同一 Unified GAS 的 server-signature transport ---------- */
{
  /* 如果標準 action 回應要求 server signature，proxy 以 Registry 的同一 API Key
     向同一 /exec 重送同一 action。呢個只係 transport authentication，與旅系統無關。 */

  /* 預先計定 vsbadge 簽名要用嘅嘢，嚟驗證 helpers 出嚟嘅 sig */
  const crypto = await import('node:crypto');
  const sd = 'serve-side-sheet-key-0082';   // server-side 嗰條（＝進度後端自己嘅 API_KEY）
  const hm = (m, k) => crypto.createHmac('sha256', String(k)).update(String(m)).digest('hex');
  const gift = (k) => hm('vsbadge-troop-sig-v1', k);

  const sigCalls = [];   // 揸住每個經上游嘅 (target, init, body)
  globalThis.fetch = async (target, init = {}) => {
    const url = String(target);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    sigCalls.push({ target: url, method, body });
    if (body?.action === 'authWhoAmI') return jsonResponse(authResult(body));
    const isSignedPost = method === 'POST' && url.includes('sig=') && url.includes('snonce=');
    if (isSignedPost) {
      /* 驗正簽名（跟 vsbadge verifyLinkSig 一樣），再扮成功 */
      const parsed = new URL(url);
      const sig = parsed.searchParams.get('sig');
      const ts = parsed.searchParams.get('sts');
      const nonce = parsed.searchParams.get('snonce');
      const digest = crypto.createHash('sha256').update(String(init.body || '')).digest('hex');
      const canonical = ['load', ts, nonce, digest].join('\n');
      const expect = hm(canonical, gift(sd));
      sigCheckOk = (sig === expect);
      return { status: 200, async text() { return JSON.stringify({
        success: true,
        members: [{ ymis: '1', name: '簽名成功', integration_status: 'legacy', connectionState: 'old' }],
        progress: {}, linked: true, allow_local_login: false, serverSideKey: true,
        transport: { upstream_only: false, link_flag_set: 'false', integrationStatus: 'legacy',
          connection_status: 'old', server_side_key: true, apiKey: 'must-not-leak',
          backend: 'https://secret.example/exec', portalToken: 'must-not-leak' }
      }); } };
    }
    /* 標準 GET 要求改用 server signature。 */
    return { status: 200, async text() { return JSON.stringify({ success: false, upstream_only: true, error: 'server signature required' }); } };
  };
  let sigCheckOk = false;

  const registryBeforeSigned = process.env.TROOPS_JSON;
  process.env.TROOPS_JSON = JSON.stringify({ '0082': { backend: BACKEND, apiKey: sd, name: '測試旅' } });
  const r = await call({ action: 'load', unit: '0082' });   // 冇帶 backend/apikey（server-side）
  process.env.TROOPS_JSON = registryBeforeSigned;

  ok('⑦ 同一 /exec 要求 server signature 時仍可完成 load action',
    r.statusCode === 200 && r.body.ok === true && r.body.data?.members?.[0]?.name === '簽名成功',
    JSON.stringify({ code: r.statusCode, ok: r.body.ok, d: r.body.data }));
  ok('⑦ server signature 對得上 sha256(body)', sigCheckOk === true, String(sigCheckOk));
  ok('⑦ response 只交代 action 結果，不暴露 Registry／整合／入口狀態欄', (() => {
    const serialized = JSON.stringify(r.body);
    return !Object.prototype.hasOwnProperty.call(r.body, 'serverSideKey')
      && !/linked|upstream_only|allow_local_login|link_flag_set|integration_status|integrationStatus|connectionState|connection_status|serverSideKey|server_side_key|must-not-leak|secret\.example/.test(serialized);
  })(), JSON.stringify(r.body));

  /* 主 Registry 冇 Key 時，browser 不可補一條 Key 繞過 server 設定。 */
  {
    const registryBeforeNoKey = process.env.TROOPS_JSON;
    process.env.TROOPS_JSON = JSON.stringify({ '0082': { backend: BACKEND, name: '測試旅' } });
    const r2 = await call({ action: 'load', unit: '0082', backend: BACKEND, apikey: sd });
    process.env.TROOPS_JSON = registryBeforeNoKey;
    ok('⑦ Registry 冇 API Key → fail closed；browser 提供 Key 亦無效',
      r2.statusCode === 503 && r2.body.reason === 'auth_backend_not_configured',
      JSON.stringify(r2.body).slice(0, 200));
  }
  /* reset 返成支 fetch，唔好影響後邊（第 8 節之後） */
  globalThis.fetch = realFetch;
}

/* ---------- 8. 唔會漏 API Key 落 log ---------- */
{
  console.log = realLog;
  const joined = logLines.join('\n');
  console.log = (...a) => { logLines.push(a.join(' ')); };
  ok('log 唔會出現 API Key', !joined.includes(API_KEY) && !joined.includes('old_separate_key'), joined.slice(0, 200));
  ok('log 有記錄 ok / 錯誤類別（方便查問題）', /ecportal-progress/.test(joined));
  ok('log 唔會記錄後端完整網址', !joined.includes('/macros/s/AKfycb'));
}

/* ---------- 9. 顯示用：遮 /exec 部署 ID（maskBackendUrl，純函數） ---------- */
{
  const { maskBackendUrl } = await import('../assets/js/lib/progress.js');

  ok('遮網址：唔會成條部署 ID 擺上螢幕',
    maskBackendUrl('https://script.google.com/macros/s/AKfycbxqQ3J/exec') === 'https://script.google.com/macros/s/…/exec');
}

console.log = realLog;
globalThis.fetch = realFetch;
if (previousTroopsJson === undefined) delete process.env.TROOPS_JSON;
else process.env.TROOPS_JSON = previousTroopsJson;
/* 有失敗就一定要睇到（測試期間 log 被攔截，所以要喺呢度補印） */
if (fail) logLines.filter(l => l.includes('✗')).forEach(l => realLog(l));

console.log(`\n──────── Progress action API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
