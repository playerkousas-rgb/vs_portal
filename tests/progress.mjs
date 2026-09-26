/* ============================================================
   tests/progress.mjs — 進度紀錄同源轉發 API 測試（一個後端、兩個前端）
   ------------------------------------------------------------
   驗證 /api/progress 嘅安全規則同轉發行為：
     · 只接受 POST、action 白名單、後端一定要係 GAS /exec
     · load 用 GET + apikey；save / saveOtherBadge 用 POST + apikey
     · catalog（自訂考核項目）只准公開 https（擋 localhost / 內網）
     · 審批中心：reviewRequest / reviewLogRequest 照樣帶 apikey 轉發，業務錯誤唔會當成功
     · 伺服器端 registry（TROOP_<id>_PROGRESS*）優先，API Key 唔使經前端
     · 後端自查 diag（★ 2026-09-24「人讀到、但個個都冇進度」）：一次過問
       根網址（邊張 Sheet）＋ ?action=diag（認唔認得／分頁同行數）
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
const API_KEY = 'vs_testkey_should_never_be_logged';

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
  const r = await call({ action: 'load', unit: '0082', backend: BACKEND, apikey: API_KEY });
  ok('load 回 200 同 ok:true', r.statusCode === 200 && r.body.ok === true);
  const c = calls[calls.length - 1];
  ok('load 用 GET 打 ?action=load&apikey=…', c.method === 'GET' && c.target.includes('action=load') && c.target.includes('apikey=' + API_KEY), c.target.slice(0, 80));
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

/* ---------- 4a2. ★ VSBADGE 開關掣（getLinkState / setLocalLogin：閂人哋唔閂自己） ---------- */
{
  const crypto = await import('node:crypto');
  const sd = 'vbadge-sheet-key-0082';     // ＝進度後端（VSBADGE）自己嗰條 SHEET KEY
  const hm = (m, k) => crypto.createHmac('sha256', String(k)).update(String(m)).digest('hex');
  const gift = (k) => hm('vsbadge-troop-sig-v1', k);
  const linkCalls = [];
  const savedFetch = globalThis.fetch;

  /* 後端/KEY 用瀏覽器傳上嚟（未用 server-side env）：照樣得 —— key 會由伺服器簽名，唔落 VSBADGE 網址 */
  globalThis.fetch = async (target, init = {}) => {
    const url = String(target);
    const method = init.method || 'GET';
    linkCalls.push({ target: url, method, body: init.body ? JSON.parse(init.body) : null });
    const parsed = new URL(url);
    if (method === 'POST' && parsed.searchParams.get('sig') && parsed.searchParams.get('snonce')) {
      /* 驗正簽名（免費）只能由抵得上嘅 code 做到 */
      const sig = parsed.searchParams.get('sig');
      const ts = parsed.searchParams.get('sts');
      const nonce = parsed.searchParams.get('snonce');
      const action = linkCalls[linkCalls.length - 1].body?.action || '';
      const digest = crypto.createHash('sha256').update(String(init.body || '')).digest('hex');
      const canonical = [action, ts, nonce, digest].join('\n');
      ok(`⑦door 簽名（query）對得上（action=${action}）`, sig === hm(canonical, gift(sd)), String(sig).slice(0, 12));
      if (action === 'getLinkState') {
        return { status: 200, async text() { return JSON.stringify({ success: true, node: '0082', allow_local_login: true, link_flag_set: '（未設定＝開啟）' }); } };
      }
      if (action === 'setLocalLogin') {
        return { status: 200, async text() { return JSON.stringify({ success: true, allow_local_login: false, message: '直接入口已閂，只收上游 sig' }); } };
      }
    }
    /* 未簽名嘅一律當閂咗口（呢啲 action 仲未行 apikey 舊路） */
    return { status: 200, async text() { return JSON.stringify({ success: false, upstream_only: true, error: '此後端的直接入口已閂' }); } };
  };

  const ok_bad_allow = await call({ action: 'setLocalLogin', unit: '0082', backend: BACKEND, apikey: sd, data: { allow: 'maybe' } });
  ok('門口 allow 唔正 → 400 bad_allow（唔放大錯誤）', ok_bad_allow.statusCode === 400 && ok_bad_allow.body?.reason === 'bad_allow');

  const e_bad = await call({ action: 'getLinkState', unit: '0082', backend: BACKEND, apikey: '' });
  ok('冇 key 讀門 → 400 no_sign_key（教我話）', e_bad.statusCode === 400 && e_bad.body?.reason === 'no_sign_key');

  const st = await call({ action: 'getLinkState', unit: '0082', backend: BACKEND, apikey: sd });
  ok('getLinkState → ok、allow_local_login:true、linked:true', st.statusCode === 200 && st.body?.ok === true && st.body?.data?.allow_local_login === true && st.body.linked === true, JSON.stringify(st.body).slice(0, 160));
  {
    const c1 = linkCalls[linkCalls.length - 1];
    ok('getLinkState 用簽名 POST（唔係 GET+apikey）', c1.method === 'POST' && c1.body?.action === 'getLinkState' && !c1.target.includes('apikey='), c1.target.slice(-40));
    ok('getLinkState body 唔漏任何 key 去 VSBADGE（sig 之外冇 apikey）', c1.body?.apikey === undefined && c1.body?.sig && c1.body?.sig_ts && c1.body?.sig_nonce);
  }

  const cl = await call({ action: 'setLocalLogin', unit: '0082', backend: BACKEND, apikey: sd, data: { allow: 'false' } });
  ok('setLocalLogin 閂 → ok、allow_local_login:false', cl.statusCode === 200 && cl.body?.ok === true && cl.body?.data?.allow_local_login === false, JSON.stringify(cl.body).slice(0, 160));
  {
    const c2 = linkCalls[linkCalls.length - 1];
    ok('setLocalLogin 用簽名 POST、帶 allow:false', c2.method === 'POST' && c2.body?.action === 'setLocalLogin' && c2.body?.allow === 'false', JSON.stringify(c2.body).slice(0, 120));
    ok('setLocalLogin body 唔漏 apikey', c2.body?.apikey === undefined);
  }

  const cl2 = await call({ action: 'setLocalLogin', unit: '0082', backend: BACKEND, apikey: sd, data: { allow: 'true' } });
  ok('setLocalLogin 開返 → ok（掣可以閂亦可以開）', cl2.statusCode === 200 && cl2.body?.ok === true);

  globalThis.fetch = savedFetch;
  upstreamJson = { success: true, members: [], progress: {} };
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
  ok('reviewRequest 帶埋 API Key（＝執委身份）', c.body?.apikey === API_KEY);

  upstreamJson = { success: true, message: '已批准並寫入活動履歷', record_id: 'LOG_X' };
  const r2 = await call({ action: 'reviewLogRequest', unit: '0082', backend: BACKEND, apikey: API_KEY,
    data: { request_id: 'LR_1', decision: 'approved', reviewer: '陳團長' } });
  const c2 = calls[calls.length - 1];
  ok('reviewLogRequest 一樣照轉發（批准會寫入活動履歷）',
    r2.statusCode === 200 && c2.body?.action === 'reviewLogRequest' && c2.body?.request_id === 'LR_1');

  ok('審批一樣擋非 GAS /exec 網址',
    (await call({ action: 'reviewRequest', backend: 'https://evil.example.com/exec', data: {} })).body?.reason === 'backend_not_allowed');
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

/* ---------- 7b. ★ 後端自查 diag（「人讀到、但個個都冇進度」） ---------- */
{
  /* diag 會問後端兩次：① 根網址（唔使 Key）→ 睇下係邊支腳本／邊張 Sheet；
     ② ?action=diag（要 Key）→ 分頁、行數、YMIS。上游按 URL 分野回應。 */
  const upstreamByUrl = {
    root: { ok: true, msg: '深資童軍管理系統 後端正常', spreadsheet: '第82旅總表', backendVersion: 'v2.7.1' },
    diag: { ok: true, success: true, spreadsheet: '第82旅總表', version: 'v2.7.1',
      progress: { rows: 3, ymis: 1, items: 3, blank: 0, matchedWithMemberList: 1, notInMemberList: 0,
        sample: [{ ymis: '1234567890', item: 'L1-ACT-01', date: '2026-09-01', confirmer: '團長' }] },
      memberList: { rows: 1, ymis: 1, sample: [{ ymis: '1234567890', name: '陳大文' }] },
      tabs: [{ name: '進度追蹤', rows: 3 }, { name: '成員名單', rows: 1 }], missingTabs: [] }
  };
  globalThis.fetch = async (target, init = {}) => {
    const url = String(target);
    calls.push({ target: url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const payload = url.includes('action=diag') ? upstreamByUrl.diag : upstreamByUrl.root;
    return { status: 200, async text() { return JSON.stringify(payload); } };
  };

  const noBackend = await call({ action: 'diag' });
  ok('diag 冇後端網址 → 提示去設定（唔會亂連）', noBackend.body?.reason === 'backend_missing');
  ok('diag 一樣擋非 GAS 網址', (await call({ action: 'diag', backend: 'https://evil.example.com/exec' })).body?.reason === 'backend_not_allowed');

  const r = await call({ action: 'diag', unit: '0082', backend: BACKEND, apikey: API_KEY });
  ok('diag 回 200 同 ok:true', r.statusCode === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  ok('diag 認得「管理系統嘅後端」（detail 有 progress）', r.body.data?.recognized === true, JSON.stringify(r.body.data?.recognized));
  ok('diag 帶埋自報（邊張 Sheet）同分頁／行數',
    r.body.data?.detail?.spreadsheet === '第82旅總表' && r.body.data?.detail?.progress?.rows === 3,
    JSON.stringify(r.body.data?.detail?.progress));
  ok('diag 帶埋「進度同名冊對唔對得上」', r.body.data?.detail?.progress?.matchedWithMemberList === 1);
  const dCalls = calls.slice(-2);
  ok('diag 先問根網址、再問 ?action=diag（唔會改任何嘢）',
    dCalls[0].method === 'GET' && !dCalls[0].target.includes('action=')
    && dCalls[1].method === 'GET' && dCalls[1].target.includes('action=diag') && dCalls[1].target.includes('apikey='),
    dCalls.map(c => c.target.slice(-40)).join(' | '));

  /* 另一種情況：後端唔認得 diag（＝唔係管理系統嘅後端，例如舊版／進度前端自己嗰支） */
  upstreamByUrl.diag = { success: false, error: 'Unknown action' };
  const r2 = await call({ action: 'diag', unit: '0082', backend: BACKEND, apikey: API_KEY });
  ok('後端唔認得 diag → recognized:false（app 會講「呢支 /exec 唔係管理系統嘅後端」）',
    r2.statusCode === 200 && r2.body.ok === true && r2.body.data?.recognized === false, JSON.stringify(r2.body.data?.recognized));
  ok('就算唔認得，仍然回晒自報資料俾 app 交代',
    r2.body.data?.self?.msg === '深資童軍管理系統 後端正常' && r2.body.data?.detail?.error === 'Unknown action');
  upstreamJson = { success: true, members: [], progress: {} };
}

/* ---------- 7c. ★ VSBADGE 旅系統接駁（閂咗直接入口 → 轉簽名 POST） ---------- */
{
  /* vsbadge 閂咗口（ALLOW_LOCAL_LOGIN=false）嗰陣，doGet ?action=load 同 apikey save
     會回 { success:false, upstream_only:true, error:'此後端的直接入口已閂…' }。
     vs_portal 伺服器端有嗰條 SHEET KEY，就要自動轉去簽名 POST（同 vsbadge
     callDownstream 一樣嘅 sig），而唔係淨係回個 error 就算。 */

  /* 預先計定 vsbadge 簽名要用嘅嘢，嚟驗證 helpers 出嚟嘅 sig */
  const crypto = await import('node:crypto');
  const sd = 'serve-side-sheet-key-0082';   // server-side 嗰條（＝進度後端自己嘅 API_KEY）
  const hm = (m, k) => crypto.createHmac('sha256', String(k)).update(String(m)).digest('hex');
  const gift = (k) => hm('vsbadge-troop-sig-v1', k);

  const sigCalls = [];   // 揸住每個經上游嘅 (target, init, body)
  globalThis.fetch = async (target, init = {}) => {
    const url = String(target);
    const method = init.method || 'GET';
    sigCalls.push({ target: url, method, body: init.body ? JSON.parse(init.body) : null });
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
      return { status: 200, async text() { return JSON.stringify({ success: true, members: [{ ymis: '1', name: '簽名成功' }], progress: {} }); } };
    }
    /* 未簽名（apikey）→ 扮閂咗口 */
    return { status: 200, async text() { return JSON.stringify({ success: false, upstream_only: true, error: '此後端的直接入口已閂（ALLOW_LOCAL_LOGIN=false），只接受上游簽名（sig）請求' }); } };
  };
  let sigCheckOk = false;

  process.env.TROOP_0082_PROGRESSBACKEND = BACKEND;
  process.env.TROOP_0082_PROGRESSAPIKEY = sd;
  const r = await call({ action: 'load', unit: '0082' });   // 冇帶 backend/apikey（server-side）
  delete process.env.TROOP_0082_PROGRESSBACKEND;
  delete process.env.TROOP_0082_PROGRESSAPIKEY;

  ok('⑦ 閂口後端＋server-side key → 自動兜去簽名 POST 並讀成功',
    r.statusCode === 200 && r.body.ok === true && r.body.data?.members?.[0]?.name === '簽名成功',
    JSON.stringify({ code: r.statusCode, ok: r.body.ok, d: r.body.data }));
  ok('⑦ 兜出去嗰支簽名係啱嘅（query sig 對得上砍正嘅 sha256(body)）', sigCheckOk === true, String(sigCheckOk));
  ok('⑦ 回覆標示 linked:true（前端知得到用咗旅系統接駁）', r.body.linked === true, JSON.stringify(r.body.linked));

  /* 冇可用 key 嗰陣唔簽得住，但要如實講「閂咗直接入口」+ 教路 */
  let fallbackMsg = null;
  {
    const r2 = await call({ action: 'load', unit: '0082', backend: BACKEND, apikey: '' });
    fallbackMsg = r2.body;
    ok('⑦ 冇 API Key（閂口後端）→ upstream_only 照回、附人話提示',
      r2.statusCode === 200 && r2.body.ok === false && r2.body.upstream_only === true
      && /直接入口|簽名/.test(r2.body.error || ''), JSON.stringify(r2.body).slice(0, 200));
  }
  /* reset 返成支 fetch，唔好影響後邊（第 8 節之後） */
  globalThis.fetch = realFetch;
}

/* ---------- 8. 唔會漏 API Key 落 log ---------- */
{
  console.log = realLog;
  const joined = logLines.join('\n');
  console.log = (...a) => { logLines.push(a.join(' ')); };
  ok('log 唔會出現 API Key', !joined.includes(API_KEY) && !joined.includes('server_side_secret_key'), joined.slice(0, 200));
  ok('log 有記錄 ok / 錯誤類別（方便查問題）', /ecportal-progress/.test(joined));
  ok('log 唔會記錄後端完整網址', !joined.includes('/macros/s/AKfycb'));
}

/* ---------- 9. 自查結果 → 用家睇到嘅結論（diagVerdict，純函數） ---------- */
{
  const { diagVerdict, maskBackendUrl } = await import('../assets/js/lib/progress.js');

  ok('遮網址：唔會成條部署 ID 擺上螢幕',
    maskBackendUrl('https://script.google.com/macros/s/AKfycbxqQ3J/exec') === 'https://script.google.com/macros/s/…/exec');

  const base = { recognized: true, self: { ok: true, msg: '深資童軍管理系統 後端正常' },
    detail: { spreadsheet: '第82旅總表', progress: { rows: 3, ymis: 1, items: 3, matchedWithMemberList: 1, notInMemberList: 0 },
      memberList: { rows: 1, ymis: 1 }, tabs: [{ name: '進度追蹤', rows: 3 }], missingTabs: [] } };

  const ok1 = diagVerdict(base, { memberCount: 1, withProgress: 1 });
  ok('正常：結論係 ok、有講讀到幾多人／幾多人有進度',
    ok1.level === 'ok' && /1 位成員/.test(ok1.title), JSON.stringify(ok1.title));

  const empty = diagVerdict({ ...base, detail: { ...base.detail, progress: { rows: 0, ymis: 0, items: 0, matchedWithMemberList: 0, notInMemberList: 0 } } },
    { memberCount: 12, withProgress: 0 });
  ok('「進度追蹤」空：結論 bad、明講分頁冇紀錄、有教 initializeSheets＋版本記錄還原',
    empty.level === 'bad' && /進度追蹤/.test(empty.title) && empty.steps.join(' ').includes('initializeSheets')
      && empty.steps.join(' ').includes('版本記錄'), JSON.stringify(empty.title));

  const unmatched = diagVerdict({ ...base, detail: { ...base.detail, progress: { rows: 5, ymis: 3, items: 2, matchedWithMemberList: 0, notInMemberList: 3 } } },
    { memberCount: 12, withProgress: 3 });
  ok('有進度但 YMIS 對唔上：結論 warn、教去對 YMIS',
    unmatched.level === 'warn' && /YMIS/.test(unmatched.title) && unmatched.steps.join(' ').includes('用戶名冊'),
    JSON.stringify(unmatched.title));

  const notOurs = diagVerdict({ recognized: false, self: { success: false, error: 'Unknown action' }, detail: { success: false, error: 'Unknown action' } },
    { memberCount: 12, withProgress: 0 });
  ok('唔係管理系統嘅後端：結論 warn、教睇下係唔係另一張 Sheet／舊版',
    notOurs.level === 'warn' && /唔係/.test(notOurs.title) && notOurs.steps.join(' ').includes('設定'),
    JSON.stringify(notOurs.title));
}

console.log = realLog;
globalThis.fetch = realFetch;
/* 有失敗就一定要睇到（測試期間 log 被攔截，所以要喺呢度補印） */
if (fail) logLines.filter(l => l.includes('✗')).forEach(l => realLog(l));

console.log(`\n──────── 進度接駁 API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
