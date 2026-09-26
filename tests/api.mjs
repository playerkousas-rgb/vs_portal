/* ============================================================
   tests/api.mjs — 測試 Vercel Serverless Function API
   驗證 Registry、Units 清單、Proxy 轉發與安全規則。
   ============================================================ */

import { getRegistry, getTrustedUnit, listPublicUnits, isTrustedExecUrl } from '../api/_registry.js';
import unitsHandler from '../api/units.js';
import proxyHandler from '../api/proxy.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n▌Serverless API & Registry 測試');

// 1. isTrustedExecUrl
ok('驗證正常 GAS /exec URL', isTrustedExecUrl('https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/exec'));
ok('擋住非 GAS URL', !isTrustedExecUrl('https://evil.com/exec'));
ok('擋住 GAS /dev URL', !isTrustedExecUrl('https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/dev'));

// 2. getRegistry & getTrustedUnit
/* 注意：data/units.json 而家得個 0082 名單（公開資料，冇後端冇 Key）。
   呢度再用環境變數開一個虛構旅團 TEST9 做 fixture，驗 env 嗰邊同合併。 */
const TEST_GAS = 'https://script.google.com/macros/s/AKfycbTESTonlyFixtureNotARealDeploymentId000000000/exec';
process.env.TROOP_TEST9_BACKEND = TEST_GAS;
process.env.TROOP_TEST9_APIKEY = 'test9_secret_key';
process.env.TROOP_TEST9_NAME = '測試旅深資童軍團';

const reg = getRegistry();
ok('Registry 讀取到環境變數登記嘅旅團', !!reg.TEST9, Object.keys(reg).join(','));
ok('旅團包含 code 與名稱', reg.TEST9?.code === 'TEST9' && reg.TEST9?.name === '測試旅深資童軍團');
ok('檔案嘅 0082 只係公開名單（冇後端冇 Key）',
  !!reg['0082'] && !reg['0082'].backend?.gasUrl && !reg['0082'].backend?.apiKey, Object.keys(reg).join(','));

const trusted = getTrustedUnit('TEST9');
ok('getTrustedUnit 取得可信後端', !!trusted && !!trusted.gasUrl);
ok('getTrustedUnit 帶埋伺服器端 API Key', trusted?.apiKey === 'test9_secret_key');
ok('非白名單旅團回傳 null', getTrustedUnit('9999') === null);
ok('0082 冇登記就攞唔到後端（唔會再借用舊旅團）', getTrustedUnit('0082') === null);

// 代理憑證來源：瀏覽器以前保存的 Key 不可蓋過伺服器端的新 Key。
{
  const originalFetch = globalThis.fetch;
  let forwarded = null;
  globalThis.fetch = async (_url, init) => {
    forwarded = JSON.parse(init.body);
    return { status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  try {
    const response = { setHeader() { return this; }, status() { return this; }, json(v) { this.body = v; return this; } };
    await proxyHandler({ method: 'POST', body: { action: 'saveTables', unit: 'TEST9', apiKey: 'outdated', apikey: 'outdated', tables: { members: [] } } }, response);
    ok('舊瀏覽器 Key 不會蓋過 Registry Key', response.body?.success === true && forwarded?.apiKey === 'test9_secret_key' && !forwarded?.apikey);
  } finally { globalThis.fetch = originalFetch; }
}

// 正式站的 backendReady 必須有網址 *及* API Key；單靠 status 不能寫入。
process.env.TROOP_NOKEY_BACKEND = TEST_GAS;
ok('有 /exec 但未設 API Key 不顯示「可同步」', listPublicUnits().NOKEY?.backendReady === false);
delete process.env.TROOP_NOKEY_BACKEND;

// 3. listPublicUnits
const pub = listPublicUnits();
ok('公開清單包含登記咗嘅旅團', !!pub.TEST9);
ok('公開清單絕不外洩 gasUrl / apiKey', pub.TEST9.gasUrl === undefined && pub.TEST9.apiKey === undefined);

// 4. unitsHandler
let resStatus = 0;
let resHeaders = {};
let resJson = null;
const mockRes = {
  setHeader(k, v) { resHeaders[k] = v; return this; },
  status(s) { resStatus = s; return this; },
  json(obj) { resJson = obj; return this; }
};
unitsHandler({ method: 'GET' }, mockRes);
ok('unitsHandler 回傳 HTTP 200', resStatus === 200);
ok('unitsHandler 回傳 units 物件', !!resJson?.units?.TEST9);

// 5. 純環境變數開新旅團（唔改 Git 都開得）
{
  const GAS = 'https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec';
  process.env.TROOP_0081_BACKEND = GAS;
  process.env.TROOP_0081_APIKEY = 'troop_key_81';
  process.env.TROOP_0081_NAME = '第八十一旅深資童軍團';
  process.env.TROOP_0081_NOTICE = GAS;
  process.env.TROOP_0081_PROGRESSBACKEND = GAS;
  process.env.TROOP_0081_PROGRESSAPIKEY = 'progress_key_81';

  const envPub = listPublicUnits();
  ok('淨係設 env 都開到新旅團（0081 出現喺公開清單）', !!envPub['0081'], Object.keys(envPub).join(','));
  ok('旅團名由 TROOP_<id>_NAME 讀（冇填就「第 0081 旅」）', envPub['0081'].name === '第八十一旅深資童軍團', envPub['0081'].name);
  ok('公開清單一樣唔外洩 gasUrl / apiKey / progress key',
    envPub['0081'].gasUrl === undefined && envPub['0081'].apiKey === undefined && envPub['0081'].progressApiKey === undefined);
  ok('公開清單標示「伺服器端已備妥進度後端」（前端唔使填）', envPub['0081'].progressServerSide === true);
  ok('公開清單標示通告可以直接送去總表', envPub['0081'].noticeReady === true);
  ok('env 旅團一樣通過白名單驗證（proxy 用得到）', !!getTrustedUnit('0081')?.gasUrl);

  delete process.env.TROOP_0081_BACKEND;
  delete process.env.TROOP_0081_APIKEY;
  delete process.env.TROOP_0081_NAME;
  delete process.env.TROOP_0081_NOTICE;
  delete process.env.TROOP_0081_PROGRESSBACKEND;
  delete process.env.TROOP_0081_PROGRESSAPIKEY;
  ok('刪走 env 之後就唔再出現（唔會殘留）', !listPublicUnits()['0081']);
}

// 6. 新旅團申請 → 經 proxy 送去 ADMIN 系統（中央收件匣）
{
  const ADMIN = 'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';
  const proxyRes = () => {
    const r = { statusCode: 0, headers: {}, body: null };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (o) => { r.body = o; return r; };
    return r;
  };
  const calls = [];
  let upstreamJson = { success: true, message: '申請已提交' };
  let upstreamRaw = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    calls.push({ target: String(target), init });
    const text = upstreamRaw !== null ? upstreamRaw : JSON.stringify(upstreamJson);
    return {
      ok: true, status: 200,
      text: async () => text,
      json: async () => JSON.parse(text)
    };
  };
  const post = async (body) => {
    const res = proxyRes();
    await proxyHandler({ method: 'POST', body }, res);
    return res;
  };

  const good = await post({
    action: 'submitRegistration', troopId: '0100', troopName: '第一百旅深資童軍團',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec',
    apiKey: 'K1', contact: 'a@b.hk', note: '想埋進度', mainSystemUrl: 'https://ecportal.vercel.app'
  });
  const sent = JSON.parse(calls[0]?.init?.body || '{}');
  ok('提交申請 → 用同源 proxy 轉發（申請人唔使直接打 GAS）', calls.length === 1 && calls[0].target === ADMIN, calls[0]?.target);
  ok('收件匣目的地由伺服器端固定（前端改唔到）',
    (await post({ action: 'submitRegistration', troopId: '0100', adminUrl: 'https://evil.example.com/exec',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }))
      && calls[calls.length - 1].target === ADMIN);
  ok('轉發 payload 帶 appType=82venture ＋ appName（同 VSBADGE 共用收件匣，可以分辨）',
    sent.appType === '82venture' && sent.appName === '深資童軍管理系統', JSON.stringify({ appType: sent.appType, appName: sent.appName }));
  ok('轉發 payload 帶齊旅團編號／名稱／後端／API Key／聯絡人／主系統網址',
    sent.troopId === '0100' && sent.troopName === '第一百旅深資童軍團'
    && /\/exec$/.test(sent.scriptUrl) && sent.apiKey === 'K1' && sent.contact === 'a@b.hk'
    && sent.mainSystemUrl === 'https://ecportal.vercel.app' && /^\d{4}-\d{2}-\d{2}T/.test(sent.at || ''));
  ok('收件匣回 JSON → proxy 當送到（success:true，唔聲稱有回執）',
    good.statusCode === 200 && good.body?.success === true && good.body?.receipt === false);
  /* 收件匣唔會回執：回 HTML／空白都要當送到（ADMIN 系統收到就 OK） */
  const htmlPage = await (upstreamRaw = '<html>已收到</html>', post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣唔回 JSON（HTML／空白）→ 照當送到（唔會誤報失敗）',
    htmlPage.statusCode === 200 && htmlPage.body?.success === true, JSON.stringify(htmlPage.body));
  const blank = await (upstreamRaw = ' ', post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣回空白 → 同樣當送到', blank.statusCode === 200 && blank.body?.success === true);
  /* 但收件匣真係話收唔到，就照當失敗 */
  upstreamRaw = null;
  const refused = await (upstreamJson = { success: false, error: '唔收呢類申請' },
    post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣明確回 success:false → 當失敗（唔會呃申請人）',
    refused.statusCode === 502 && /唔收呢類申請/.test(refused.body?.error || ''), JSON.stringify(refused.body));
  upstreamJson = { success: true, message: '申請已提交' };

  /* ★ 2026-09-25 團長：「加個求救制，有咩大問題 SEND 去問 ADMIN，當回報問題處理」—— 同 submitRegistration 一條路 */
  const issue = await post({
    action: 'submitIssue', troopId: '0082', title: '同步啲掣唔知點排', desc: '成頁啲掣好亂，唔知邊個打邊個',
    severity: '高', name: '團長', contact: 'leader@example.hk',
    from: '管理系統', issueUrl: 'https://example.com/app#/tables/sync', at: '2026-09-25T10:00:00.000Z'
  });
  const issuePayload = JSON.parse(calls[calls.length - 1]?.init?.body || '{}');
  ok('submitIssue → 送同一個中央收件匣（目的地固定）', calls[calls.length - 1]?.target === ADMIN, calls[calls.length - 1]?.target);
  ok('求救 payload 對正 ADMIN「問題回報」合約（type=issue ＋ sourceApp=82venture）',
    issuePayload.type === 'issue' && issuePayload.sourceApp === '82venture', JSON.stringify({ type: issuePayload.type, sourceApp: issuePayload.sourceApp }));
  ok('求救 payload 帶齊標題／詳情／嚴重度／旅團號／姓名／Email（轉寄用）', issuePayload.title === '同步啲掣唔知點排'
    && issuePayload.desc === '成頁啲掣好亂，唔知邊個打邊個' && issuePayload.severity === '高'
    && issuePayload.troopId === '0082' && issuePayload.name === '團長'
    && issuePayload.contact === 'leader@example.hk', JSON.stringify(issuePayload));
  ok('求救收件匣回 JSON → proxy 當送到（success:true）', issue.statusCode === 200 && issue.body?.success === true, JSON.stringify(issue.body));

  /* 連線唔通 → 失敗 */
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('boom'); e.name = 'TimeoutError'; throw e; };
  const down = await post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' });
  ok('連線／逾時 → 回 504（呢個先算送唔到）', down.statusCode === 504, JSON.stringify(down.body));
  globalThis.fetch = realFetch2;
  ok('proxy 只接受 POST', (await (async () => {
    const r = proxyRes(); await proxyHandler({ method: 'GET' }, r); return r;
  })()).statusCode === 405);
  ok('唔喺白名單嘅 action 會被擋',
    (await post({ action: 'deleteEverything', troopId: '0082' })).statusCode === 400);
  globalThis.fetch = realFetch;
}

/* ============================================================
   4. api/auth.js —— 超管核對搬上伺服器端（2026-09-20）
   ------------------------------------------------------------
   以前密碼寫死喺 assets/js/lib/auth.js，而呢個係靜態網站 ——
   個檔會原原本本送到每個訪客嘅瀏覽器，repo 又係 public。
   而家：核對喺伺服器端做，密碼只存喺 Vercel 嘅 SUPER_KEY。
   ============================================================ */
console.log('\n▌超管核對（api/auth.js：SUPER_KEY、fail closed）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const authHandler = (await import('../api/auth.js')).default;

  const res4 = () => {
    const r = { statusCode: 0, headers: {}, body: null };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (o) => { r.body = o; return r; };
    return r;
  };
  const realLog = console.log;
  const call = async (body, method = 'POST') => {
    const r = res4();
    console.log = () => {};
    try { await authHandler({ method, body }, r); } finally { console.log = realLog; }
    return r;
  };

  const PW = 'test-super-pw-2026';

  /* ---- 原始碼守門：前端唔可以再有任何超管秘密 ---- */
  const authSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/auth.js'), 'utf8');

  /* 舊後門嘅形狀：「密碼變數直接同一個寫死嘅純數字字串比對」，
     例如 `p === <四位數>` 或者 `String(password) === <四位數>`。
     `\\)*` 係要吞埋 `String(password)` 嗰個收掣括號。

     呢條 regex 淨係認**寫死嘅數字字面量**，所以唔會誤傷
     `|| p === TEMP_PASSWORD`（嗰個係變數，係正常嘅「初始密碼要強制改」邏輯）。

     ⚠️ 刻意用「形狀」而唔係用真密碼做斷言 —— 真密碼**唔應該出現喺 repo
     任何地方，連測試檔都唔應該有**。之前呢個 repo 就係咁樣漏咗。 */
  const BACKDOOR_RE = /(?:\bp\b|\bpassword\b)\s*\)*\s*===\s*'\d{3,8}'/;

  /* 先驗條 regex 本身認唔認得出後門 —— 一條永遠 pass 嘅掃描等於冇掃描。 */
  ok('掃描用嘅 regex 認得出舊後門（唔係一條永遠 pass 嘅假斷言）',
    BACKDOOR_RE.test("|| p === '0000';") && BACKDOOR_RE.test("String(password) === '0000'"));
  ok('掃描用嘅 regex 唔會誤傷合法嘅 TEMP_PASSWORD 比對',
    !BACKDOOR_RE.test('p === TEMP_PASSWORD') && !BACKDOOR_RE.test('String(password) === TEMP_PASSWORD'));

  ok('★ auth.js 已經冇寫死嘅後門密碼', !BACKDOOR_RE.test(authSrc));
  ok('★ auth.js 已經冇寫死嘅超管 hash', !/652debbfdc29dd091325028855c281a08a50f91fcd0eb269444ff4eb5338645e/.test(authSrc));
  ok('★ auth.js 冇任何 salt／hash 欄位留低', !/SUPER\s*=\s*\{[^}]*\b(salt|hash)\b/s.test(authSrc));
  ok('auth.js 改為叫伺服器端核對', /fetch\('api\/auth'/.test(authSrc) && /verifySuperServer/.test(authSrc));

  /* ★ 掃描範圍係**成個 repo**，唔淨止 assets/。
     原因：改嘢嗰陣真密碼一度由 auth.js 搬咗去 tests/_authstub.mjs ——
     如果只掃 assets/ 就會「綠燈通過」而密碼照樣留喺公開 repo。 */
  const SCAN_SKIP = new Set(['.git', 'node_modules', '.vercel', 'dist', 'build']);
  const repoFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SCAN_SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|gs|json|md|html)$/.test(e.name)) repoFiles.push(p);
    }
  })(ROOT);

  /* 掃描器自己要豁免：呢個檔入面有「後門長成點」嘅樣本字串。 */
  const SELF = path.join(ROOT, 'tests/api.mjs');
  ok('★ 成個 repo（唔淨止 assets/）都搵唔到寫死嘅後門密碼', (() => {
    const hits = repoFiles.filter(f => f !== SELF && BACKDOOR_RE.test(fs.readFileSync(f, 'utf8')));
    if (hits.length) console.log('      漏咗喺：' + hits.map(f => path.relative(ROOT, f)).join(', '));
    return hits.length === 0;
  })(), `掃咗 ${repoFiles.length - 1} 個檔（掃描器自己豁免）`);

  ok('★ 成個 repo 都搵唔到舊嗰個超管 hash', (() => {
    const OLD_HASH = '652debbf' + 'dc29dd091325028855c281a08a50f91fcd0eb269444ff4eb5338645e';
    const hits = repoFiles.filter(f => f !== SELF && fs.readFileSync(f, 'utf8').includes(OLD_HASH));
    if (hits.length) console.log('      漏咗喺：' + hits.map(f => path.relative(ROOT, f)).join(', '));
    return hits.length === 0;
  })());

  ok('★ 測試 fixture 都唔用返真密碼（秘密唔應該喺 repo 任何地方）', (() => {
    const stub = fs.readFileSync(path.join(ROOT, 'tests/_authstub.mjs'), 'utf8');
    return /TEST_SUPER_PASSWORD\s*=\s*'[^']*'/.test(stub) && !/'\d{3,8}'/.test(stub);
  })());

  /* ---- fail closed：SUPER_KEY 冇設 → 成條路關閉 ---- */
  delete process.env.SUPER_KEY;
  const off = await call({ user: 'sheep', password: PW });
  ok('★ 未設 SUPER_KEY → 503 ＋ disabled（fail closed，唔會靜靜地放行）',
    off.statusCode === 503 && off.body?.disabled === true && off.body?.ok === false, JSON.stringify(off.body));
  ok('關閉嗰陣嘅提示教管理員點做（講明 SUPER_KEY）',
    /SUPER_KEY/.test(String(off.body?.hint || '')));

  /* ---- 正常核對：一個環境變數，填明文密碼 ---- */
  process.env.SUPER_KEY = PW;
  const good = await call({ user: 'sheep', password: PW });
  ok('★ SUPER_KEY = 密碼，密碼啱 → 200', good.statusCode === 200 && good.body?.ok === true,
    JSON.stringify(good.body));
  ok('★ 回應唔會洩漏密碼', !JSON.stringify(good.body).includes(PW), JSON.stringify(good.body));

  const bad = await call({ user: 'sheep', password: 'wrong-password' });
  ok('密碼錯 → 401', bad.statusCode === 401 && bad.body?.ok === false, JSON.stringify(bad.body));

  const wrongUser = await call({ user: 'not-sheep', password: PW });
  ok('用戶名錯 → 401（同一句訊息，唔會確認邊個 username 存在）',
    wrongUser.statusCode === 401 && String(wrongUser.body?.error) === String(bad.body?.error));

  /* BUILD §2：同一帳號連續 5 次失敗後鎖 15 分鐘；鎖定訊息唔暴露帳號是否存在。 */
  for (let i = 0; i < 5; i++) await call({ user: 'attacker', password: 'wrong-password' });
  const locked = await call({ user: 'attacker', password: 'wrong-password' });
  ok('連續 5 次失敗後帳號鎖定', locked.statusCode === 423 && /15 分鐘/.test(locked.body?.error || ''), JSON.stringify(locked.body));

  /* 改密碼 = 改個環境變數值，即刻生效 */
  process.env.SUPER_KEY = 'a-brand-new-password';
  ok('★ 改咗 SUPER_KEY → 舊密碼即刻入唔到',
    (await call({ user: 'sheep', password: PW })).statusCode === 401);
  ok('★ 改咗 SUPER_KEY → 新密碼即刻入到',
    (await call({ user: 'sheep', password: 'a-brand-new-password' })).statusCode === 200);

  /* sheep 係品牌固定隱藏超管，不接受 SUPER_USER 改名或另造入口。 */
  process.env.SUPER_USER = 'myboss';
  ok('隱藏超管帳戶固定係 sheep',
    (await call({ user: 'myboss', password: 'a-brand-new-password' })).statusCode === 401
    && (await call({ user: 'sheep', password: 'a-brand-new-password' })).statusCode === 200);
  delete process.env.SUPER_USER;

  ok('GET 唔接受（只接受 POST）', (await call({}, 'GET')).statusCode === 405);

  delete process.env.SUPER_KEY;
}

console.log(`\n──────── API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
