/* ============================================================
   tests/progress.mjs — 進度紀錄同源轉發 API 測試（一個後端、兩個前端）
   ------------------------------------------------------------
   驗證 /api/progress 嘅安全規則同轉發行為：
     · 只接受 POST、action 白名單、後端一定要係 GAS /exec
     · load 用 GET + apikey；save / saveOtherBadge 用 POST + apikey
     · catalog（自訂考核項目）只准公開 https（擋 localhost / 內網）
     · 審批中心：reviewRequest / reviewLogRequest 照樣帶 apikey 轉發，業務錯誤唔會當成功
     · 伺服器端 registry（TROOP_<id>_PROGRESS*）優先，API Key 唔使經前端
     · 唔會 log API Key
   ============================================================ */

import progressHandler from '../api/progress.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n▌進度紀錄 API 測試（讀／寫旅團自己嘅後端）');

const BACKEND = 'https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqBiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec';
const APikey = 'vs_testkey_should_never_be_logged';

/* ---------- mock res ---------- */
function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}

/* ---------- mock fetch（攔截上游 GAS） ---------- */
const calls = [];
let upstreamJson = { success: true, members: [{ ymis: '1234567890', name: '陳大文' }], progress: { 1234567890: { 'L1-ACT-01': { date: '2026-09-01', confirmer: '團長' } } }, pendingRequests: [], otherBadges: {}, logs: [], logRequests: [] };
let upstreamStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (target, init = {}) => {
  calls.push({ target: String(target), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  const text = typeof upstreamJson === 'string' ? upstreamJson : JSON.stringify(upstreamJson);
  return {
    status: upstreamStatus,
    async text() { return text; }
  };
};

const logLines = [];
const realLog = console.log;
console.log = (...a) => { logLines.push(a.join(' ')); };

async function call(payload, method = 'POST') {
  const res = mockRes();
  await progressHandler({ method, body: payload }, res);
  return res;
}

/* ---------- 1. 基本規則 ---------- */
ok('只接受 POST（GET 會 405）', (await call({ action: 'load' }, 'GET')).statusCode === 405);
ok('未知 action 會 400', (await call({ action: 'deleteEverything' })).statusCode === 400);
ok('舊嘅 items action 已經唔存在（唔再連去任何前端）', (await call({ action: 'items' })).statusCode === 400);
ok('冇後端網址 → 提示去設定', (await call({ action: 'load' })).body?.reason === 'backend_missing');
ok('非 GAS /exec 網址會被擋（唔會變成 open proxy）',
  (await call({ action: 'load', backend: 'https://evil.example.com/exec' })).body?.reason === 'backend_not_allowed');
ok('GAS /dev 網址都會被擋',
  (await call({ action: 'load', backend: BACKEND.replace('/exec', '/dev') })).body?.reason === 'backend_not_allowed');

/* ---------- 2. load（讀進度） ---------- */
{
  const r = await call({ action: 'load', unit: '0082', backend: BACKEND, apikey: APikey });
  ok('load 回 200 同 ok:true', r.statusCode === 200 && r.body.ok === true);
  const c = calls[calls.length - 1];
  ok('load 用 GET 打 ?action=load&apikey=…', c.method === 'GET' && c.target.includes('action=load') && c.target.includes('apikey=' + APikey), c.target.slice(0, 80));
  ok('回傳 members / progress 原樣（前端要嚟畫進度）',
    r.body.data?.members?.[0]?.name === '陳大文' && !!r.body.data?.progress?.['1234567890']?.['L1-ACT-01']);
}

/* ---------- 3. save（勾進度） ---------- */
{
  upstreamJson = { success: true, processed: 2 };
  const changes = [
    { ymis: '1234567890', itemId: 'L1-ACT-02', date: '2026-09-16', uncomplete: false, note: '' },
    { ymis: '1234567890', itemId: 'L1-ACT-03', date: '2026-09-16', uncomplete: true, note: '' }
  ];
  const r = await call({ action: 'save', unit: '0082', backend: BACKEND, apikey: APikey, data: { changes, confirmer: '執委會' } });
  const c = calls[calls.length - 1];
  ok('save 回 200 同 ok:true', r.statusCode === 200 && r.body.ok === true);
  ok('save 用 POST 送去 GAS，帶 action / apikey / changes',
    c.method === 'POST' && c.body?.action === 'save' && c.body?.apikey === APikey && c.body?.changes?.length === 2);
  ok('save 帶 confirmer 同 uncomplete（取消勾選）',
    c.body?.confirmer === '執委會' && c.body?.changes?.[1]?.uncomplete === true);
  ok('回傳 processed 俾前端交代', r.body.data?.processed === 2);
}

/* ---------- 4. saveOtherBadge ---------- */
{
  upstreamJson = { success: true };
  await call({ action: 'saveOtherBadge', unit: '0082', backend: BACKEND, apikey: APikey, data: { records: [{ ymis: '1', badgeId: 'SVC', name: '服務' }] } });
  const c = calls[calls.length - 1];
  ok('saveOtherBadge 帶 records 陣列', c.body?.action === 'saveOtherBadge' && Array.isArray(c.body?.records));
}

/* ---------- 4b. 審批中心（批／拒團員申報） ---------- */
{
  upstreamJson = { success: true, message: '已批准並寫入進度' };
  const r = await call({ action: 'reviewRequest', unit: '0082', backend: BACKEND, apikey: APikey,
    data: { request_id: 'RQ_1', decision: 'approved', review_note: '', reviewer: '陳團長', confirmed_date: '2026-09-16' } });
  const c = calls[calls.length - 1];
  ok('reviewRequest 用 POST 送去後端（帶 request_id／decision／reviewer）',
    r.statusCode === 200 && c.method === 'POST' && c.body?.action === 'reviewRequest'
    && c.body?.request_id === 'RQ_1' && c.body?.decision === 'approved' && c.body?.reviewer === '陳團長');
  ok('reviewRequest 帶埋 API Key（＝執委身份）', c.body?.apikey === APikey);

  upstreamJson = { success: true, message: '已批准並寫入活動履歷', record_id: 'LOG_X' };
  const r2 = await call({ action: 'reviewLogRequest', unit: '0082', backend: BACKEND, apikey: APikey,
    data: { request_id: 'LR_1', decision: 'approved', reviewer: '陳團長' } });
  const c2 = calls[calls.length - 1];
  ok('reviewLogRequest 一樣照轉發（批准會寫入活動履歷）',
    r2.statusCode === 200 && c2.body?.action === 'reviewLogRequest' && c2.body?.request_id === 'LR_1');

  ok('審批一樣擋非 GAS /exec 網址',
    (await call({ action: 'reviewRequest', backend: 'https://evil.example.com/exec', data: {} })).body?.reason === 'backend_not_allowed');
  upstreamJson = { success: false, error: '呢個申請已經處理過' };
  const r3 = await call({ action: 'reviewRequest', unit: '0082', backend: BACKEND, apikey: APikey, data: { request_id: 'RQ_1', decision: 'approved' } });
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

/* ---------- 6. catalog（自訂考核項目定義，可選） ---------- */
{
  upstreamJson = { meta: {}, badges: [{ id: 'L1', name: '會員章', segments: [{ code: 'L1-ACT', name: '活動', items: [{ id: 'L1-ACT-01', name: '參加六次團活動' }] }] }] };
  ok('冇填自訂定義 → 提示用內建（唔會亂 fetch）',
    (await call({ action: 'catalog', unit: '0082' })).body?.reason === 'catalog_missing');
  const r = await call({ action: 'catalog', unit: '0082', catalog: 'https://example.org/items.json' });
  ok('catalog 讀到 badges', r.statusCode === 200 && r.body.ok === true && r.body.data.badges.length === 1);
  const c = calls[calls.length - 1];
  ok('catalog 直接打自訂網址（app 內建唔需要經伺服器）', c.target === 'https://example.org/items.json', c.target);
  ok('catalog 擋 http（只准 https）', (await call({ action: 'catalog', catalog: 'http://example.org/items.json' })).statusCode === 400);
  ok('catalog 擋 localhost', (await call({ action: 'catalog', catalog: 'https://localhost/items.json' })).statusCode === 400);
  ok('catalog 擋內網 IP', (await call({ action: 'catalog', catalog: 'https://192.168.1.10/items.json' })).statusCode === 400);
  upstreamJson = { meta: {}, nope: [] };
  ok('catalog 冇 badges 會報錯', (await call({ action: 'catalog', catalog: 'https://example.org/x.json' })).body?.ok === false);
  upstreamJson = { success: true };
}

/* ---------- 7. 伺服器端 Registry（可選：唔使前端傳 key） ---------- */
{
  process.env.TROOP_0082_PROGRESSBACKEND = BACKEND;
  process.env.TROOP_0082_PROGRESSAPIKEY = 'server_side_secret_key';
  process.env.TROOP_0082_PROGRESSCATALOG = 'https://example.org/items.json';
  upstreamJson = { success: true, members: [], progress: {} };
  const r = await call({ action: 'load', unit: '0082' });     // 前端冇帶 backend/apikey
  const c = calls[calls.length - 1];
  ok('有設 env 就用伺服器端後端（前端可以完全唔填）', r.body.ok === true && c.target.startsWith(BACKEND));
  ok('用伺服器端 API Key（前端睇唔到 secret）', c.target.includes('server_side_secret_key'));
  ok('回覆標示 serverSideKey（前端可以交代「由管理員設定」）', r.body.serverSideKey === true);
  delete process.env.TROOP_0082_PROGRESSBACKEND;
  delete process.env.TROOP_0082_PROGRESSAPIKEY;
  delete process.env.TROOP_0082_PROGRESSCATALOG;
}

/* ---------- 8. 唔會漏 API Key 落 log ---------- */
{
  console.log = realLog;
  const joined = logLines.join('\n');
  console.log = (...a) => { logLines.push(a.join(' ')); };
  ok('log 唔會出現 API Key', !joined.includes(APikey) && !joined.includes('server_side_secret_key'), joined.slice(0, 200));
  ok('log 有記錄 ok / 錯誤類別（方便查問題）', /ecportal-progress/.test(joined));
  ok('log 唔會記錄後端完整網址', !joined.includes('/macros/s/AKfycb'));
}

console.log = realLog;
globalThis.fetch = realFetch;
/* 有失敗就一定要睇到（測試期間 log 被攔截，所以要喺呢度補印） */
if (fail) logLines.filter(l => l.includes('✗')).forEach(l => realLog(l));

console.log(`\n──────── 進度接駁 API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
