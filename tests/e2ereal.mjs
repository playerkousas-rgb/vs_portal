/* ============================================================
   tests/e2ereal.mjs — 端到端：真前端 ← /api/proxy ← **真 Code.gs**
   ------------------------------------------------------------
   團長 2026-09-20：「都係唔得 …… 一直都係儲存唔到去後端／後端讀取唔到，
   我只能用 JSON SAVE。能登入就是找到後端 …… 一定是中間有什麼擋了。」

   佢嘅推理冇錯，錯嘅係我哋嘅測試：以前所有端到端測試都打
   tests/_fakegas.mjs —— 一份**重寫**嘅假後端。假後端行得通，唔代表
   團長真正部署嗰份 apps-script/Code.gs 行得通。呢個檔把成條鏈
   換成真嘢：

       真前端（assets/js/lib/*.js，jsdom）
         ↓ 真 HTTP
       dev-server（api/proxy.js，同 Vercel 同一份 source）
         ↓ 真 HTTP
       tests/_realgas.mjs（vm 入面**真正執行** Code.gs）

   釘死：
     ① 小資料庫：儲存 → 換一部新機讀返 → 資料一樣
     ② 大資料庫（>2.8MB，行分件 saveDbPart/saveDbCommit）：儲存成功、
        後端真係收到晒、另一部機分段讀返晒（冇甩一個團員）
     ③ 分件儲存之後再一次普通儲存 → 仲讀得返（「資料庫」分頁冇被搞亂）
     ④ 「同步診斷」喺成條鏈正常時一定要全綠（唔好成日話人設定錯）
   用法：node tests/e2ereal.mjs
   ============================================================ */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { TEST_SUPER_PASSWORD } from './_authstub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const KEY = 'v82_e2e_real_key';
const SUPER_PASSWORD = TEST_SUPER_PASSWORD;
const UNIT = '0082';
let platformSessionToken = '';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const waitPort = async (port, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const up = await new Promise(r => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
};

const GAS_PORT = await freePort();
const WEB_PORT = await freePort();
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const REAL_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;

const procs = [];
const spawnBg = (args, env = {}) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
process.on('exit', () => procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }));

const runDevice = (plan) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; });
  p.stderr.on('data', d => { err += d; });
  const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); }
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（90 秒）' }), 90000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-900) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});
const step = (r, op) => (r?.steps || []).find(s => s.op === op) || {};

/* 唔信前端自己講 —— 直接問真後端而家真係有咩 */
const backendTruth = async () => {
  const r = await fetch(REAL_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'dbInfo', unit: UNIT, apiKey: KEY })
  });
  const j = await r.json().catch(() => ({}));
  return {
    http: r.status, ok: !!j.ok, found: !!j.found, error: String(j.error || ''),
    members: Number(j.counts?.members || 0), bytes: Number(j.bytes || 0),
    /* 自 v2.6.2 起 起 dbInfo 會報「舊版留低嘅暫存垃圾行」（app 嘅同步診斷靠佢） */
    stagingRows: Number(j.stagingRows || 0), stagingBytes: Number(j.stagingBytes || 0),
    version: String(j.version || '')
  };
};
/* 「資料庫」分頁而家嘅行結構（驗分件暫存有冇清乾淨） */
const sheetRows = async () => {
  const r = await fetch(`http://127.0.0.1:${GAS_PORT}/_rows?tab=${encodeURIComponent('資料庫')}`);
  const j = await r.json().catch(() => ({ rows: [] }));
  return j.rows || [];
};
/* ★ v2.8.0「資料表」分頁（逐表寫嘅正本）：一行一段 [旅團, 表名, 段號, 內容, 時間, 版本] */
const simpleRows = async () => {
  const r = await fetch(`http://127.0.0.1:${GAS_PORT}/_rows?tab=${encodeURIComponent('資料表')}`);
  const j = await r.json().catch(() => ({ rows: [] }));
  return j.rows || [];
};
/* 舊版留低嘅垃圾行，用後端嘅逃生門 cleanStaleStaging() 清 */
const cleanStaleStaging = async () => {
  const r = await fetch(`http://127.0.0.1:${GAS_PORT}/_clean`, { method: 'POST' });
  return r.json().catch(() => ({}));
};

section('起真後端（vm 執行 Code.gs）＋ dev-server（/api/proxy）');
spawnBg([path.join(ROOT, 'tests', '_realgas.mjs'), String(GAS_PORT)], { REALGAS_APIKEY: KEY });
spawnBg([path.join(ROOT, 'dev-server.mjs')], {
  PORT: String(WEB_PORT),
  V82_PROXY_TEST: '1',
  TROOP_0082_BACKEND: REAL_EXEC,
  TROOP_0082_APIKEY: KEY,
  SUPER_KEY: SUPER_PASSWORD
});
ok('真 Code.gs 後端已啟動', await waitPort(GAS_PORT));
ok('dev-server（同源 /api/proxy）已啟動', await waitPort(WEB_PORT));
{
  const st = await (await fetch(REAL_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'status', unit: UNIT, apiKey: KEY })
  })).json();
  ok('後端答到 status（有版本號）', st.ok === true && !!st.backendVersion, JSON.stringify(st).slice(0, 160));
}

section('無帳戶／無資料：兩部裝置都以伺服器 API Key 做讀寫測試');
{
  const A = await runDevice({ steps: [{ op: 'checkReadWrite' }] });
  const B = await runDevice({ steps: [{ op: 'checkReadWrite' }] });
  ok('A 經同源代理用 API Key 寫入並讀回', step(A, 'checkReadWrite').ok === true &&
    step(A, 'checkReadWrite').via === 'proxy', JSON.stringify(step(A, 'checkReadWrite')));
  ok('B 用全新本機環境同樣可寫入及讀回', step(B, 'checkReadWrite').ok === true,
    JSON.stringify(step(B, 'checkReadWrite')));
  ok('兩部機連到同一試算表', !!step(A, 'checkReadWrite').sheet &&
    step(A, 'checkReadWrite').sheet === step(B, 'checkReadWrite').sheet);
  const rows = await sheetRows();
  ok('無資料仍可測試，資料庫只有表頭沒有正式資料', rows.length === 1);
  const checkRows = await fetch(`http://127.0.0.1:${GAS_PORT}/_rows?tab=${encodeURIComponent('連線測試')}`).then(r => r.json());
  ok('測試記號讀回後已清走（連線測試分頁只剩表頭）', checkRows.rows?.length === 1);
}

/* ============================================================
   ① 小資料庫：寫入 → 換機讀返
   ============================================================ */
section('① 真後端：寫入 → 另一部機讀返');
{
  const A = await runDevice({ steps: [
    { op: 'load' },
    { op: 'wipe' },
    { op: 'addMember', name: '陳大文', ymis: '2026000001' },
    { op: 'addMember', name: '李小明', ymis: '2026000002' },
    { op: 'addTx', date: '2026-03-01', type: 'income', item: '團費', amount: 1200 },
    { op: 'push' }
  ] });
  ok('裝置 A 開到機（經 proxy 打到真後端）', A.ok === true, A.error || '');
  ok('A 儲存成功（真 Code.gs 收貨）', step(A, 'push').ok === true, JSON.stringify(step(A, 'push')).slice(0, 300));
  const truth = await backendTruth();
  ok('後端真係有 2 個團員＋1 筆帳', truth.found && truth.members === 2, JSON.stringify(truth));

  const B = await runDevice({ steps: [{ op: 'load' }] });
  ok('裝置 B（全新機）讀返同一份資料', step(B, 'load').ok === true && step(B, 'load').members === 2,
    JSON.stringify(step(B, 'load')).slice(0, 240));
  ok('B 見到嘅名同 A 一樣', JSON.stringify(step(B, 'load').names) === JSON.stringify(['李小明', '陳大文']),
    JSON.stringify(step(B, 'load').names));
}

/* ============================================================
   ② ★ 大資料庫（分件儲存 saveDbPart / saveDbCommit）
   ------------------------------------------------------------
   呢個先係用家撞到嘅情況：db 大過 2.8MB 就會行分件。
   以前呢條路只有假後端嘅測試 —— 真 Code.gs 一次都未端到端試過。
   ============================================================ */
section('② ★ 大資料庫（>2.8MB）分件儲存：真 Code.gs 收唔收到');
const BULK = 1600;      // 每個 ~2KB → 約 3.3MB（過分件閾值 2.8MB，亦過分段讀閾值 3MB）
let bulkTotal = 0;
{
  const A = await runDevice({ steps: [
    { op: 'load' },
    { op: 'bulkMembers', count: BULK, kb: 2, prefix: '團員' },
    { op: 'push' }
  ] });
  ok('裝置 A 開到機', A.ok === true, A.error || '');
  const bulk = step(A, 'bulkMembers');
  bulkTotal = bulk.total || 0;
  ok(`前提：db 已谷大過分件閾值（${bulk.total} 個團員 ≈ ${(Number(bulk.bytes || 0) / 1048576).toFixed(2)} MB）`,
    Number(bulk.bytes || 0) > 2_800_000, JSON.stringify(bulk).slice(0, 160));
  const p = step(A, 'push');
  ok('★ 分件儲存成功（真 Code.gs 嘅 saveDbPart＋saveDbCommit）',
    p.ok === true, JSON.stringify(p).slice(0, 500));
  /* ★ v2.8.0：3.3MB 都係**一次逐表寫** —— 一個表一個請求，所以唔使再分件，
     亦都撞唔到代理 4MB 上限。舊嘅分件路（saveDbPart／saveDbCommit）保留做後備，
     下面 ⑥b 另外驗佢仲行得。 */
  ok('★ 新路線：3.3MB 一次逐表寫（唔使分件、唔會撞代理上限）',
    p.mode === 'simple' && Number(p.parts || 0) === 0, JSON.stringify({ mode: p.mode, parts: p.parts }));

  const truth = await backendTruth();
  ok(`★★ 後端真係收到晒 ${bulkTotal} 個團員（唔係淨係收到第一件）`,
    truth.found && truth.members === bulkTotal, JSON.stringify(truth));
  const rows = await sheetRows();
  ok('分件暫存行已清走（唔會留低 __staging__ 垃圾）',
    !rows.some(r => r.unit === '__staging__'), JSON.stringify(rows.filter(r => r.unit === '__staging__').slice(0, 4)));
}

/* ============================================================
   ③ 另一部機分段讀返（loadDbPart）
   ============================================================ */
section('③ 換機：大資料庫分段讀返（loadDbPart）');
{
  const C = await runDevice({ steps: [{ op: 'load' }] });
  const l = step(C, 'load');
  ok('裝置 C 讀得返（冇話「讀唔到後端」）', l.ok === true, JSON.stringify(l).slice(0, 400));
  ok(`★★ 讀返晒 ${bulkTotal} 個團員（甩一個都算唔合格）`, l.members === bulkTotal,
    `讀到 ${l.members}，後端有 ${bulkTotal}`);
  const truth = await backendTruth();
  ok('C 嘅基準版本 ＝ 後端版本', l.version === truth.version, `${l.version} vs ${truth.version}`);
}

/* ============================================================
   ④ 分件儲存之後再一次普通儲存 —— 「資料庫」分頁唔可以被搞亂
   ============================================================ */
section('④ 大存過再一次普通儲存：仲讀得返');
{
  const D = await runDevice({ steps: [
    { op: 'load' },
    { op: 'addMember', name: '黃小美', ymis: '2026000003' },
    { op: 'push' }
  ] });
  ok('D 讀到基準', step(D, 'load').ok === true, JSON.stringify(step(D, 'load')).slice(0, 200));
  const p = step(D, 'push');
  ok('D 儲存成功', p.ok === true, JSON.stringify(p).slice(0, 400));
  const truth = await backendTruth();
  ok(`後端 = ${bulkTotal + 1} 個團員（舊嘅一個都冇甩）`, truth.members === bulkTotal + 1, JSON.stringify(truth));

  const E = await runDevice({ steps: [{ op: 'load' }] });
  ok('E 讀返最新一份（JSON 冇壞）', step(E, 'load').ok === true && step(E, 'load').members === bulkTotal + 1,
    JSON.stringify(step(E, 'load')).slice(0, 400));
}

/* ============================================================
   ⑤ 正常鏈：後端資訊要答得齊，唔好成日話人設定錯
   ------------------------------------------------------------
   2026-11-12：remoteDiagnose() 已刪（UI 喺 2026-09-26 拆走）。
   改用 live 嘅 remoteInfo() ＋ verifyAgainstBackend() 驗同一件事：
   成條鏈正常嗰陣，經平台代理讀後端要成功、對得上、冇錯誤。
   ============================================================ */
section('⑤ 正常鏈：後端資訊答得齊、核對對得上');
{
  const F = await runDevice({ steps: [{ op: 'load' }, { op: 'info' }, { op: 'verify' }] });
  const d = step(F, 'info');
  ok('後端資訊 ok', d.ok === true, JSON.stringify(d).slice(0, 400));
  ok('後端資訊冇錯誤訊息', !d.error, String(d.error));
  ok('讀得到後端內容（found）', d.found === true, JSON.stringify(d));
  const v = step(F, 'verify');
  ok('正常鏈核對「對得上」（matched）', v.matched === true, JSON.stringify(v).slice(0, 300));
  ok('每表筆數同本機一致', v.countsOk === true, JSON.stringify(v.rows));
}

/* ============================================================
   ⑥ ★ 連續分件儲存：「資料庫」分頁唔會越存越大
   ------------------------------------------------------------
   呢格係 2026-09-20 團長回報嗰單嘅**真正死因**：
   舊 cleanStaging 一梳連續行只刪到一行 → 每次分件儲存留低
   成份資料庫嘅複製品（每行 45000 字）喺「資料庫」分頁 →
   Sheet 越嚟越大 → getValues() 越來越慢 → 最後讀寫一齊撞 GAS 上限。
   ============================================================ */
section('⑥ ★ 連續分件儲存：分頁唔會越存越大');
{
  const before = await sheetRows();
  for (let n = 0; n < 3; n++) {
    const D = await runDevice({ steps: [
      { op: 'load' },
      { op: 'bulkMembers', count: 40, kb: 2, prefix: '新團員' + n },
      { op: 'push' }
    ] });
    ok(`第 ${n + 1} 次分件儲存成功`, step(D, 'push').ok === true, JSON.stringify(step(D, 'push')).slice(0, 300));
  }
  const after = await sheetRows();
  const junk = after.filter(r => r.unit === '__staging__');
  ok('★★ 三次儲存之後冇留低暫存垃圾行', junk.length === 0, `${junk.length} 行垃圾`);
  /* ★ v2.8.0：正本已經搬去「資料表」分頁（逐表寫）——
     驗嘅嘢一樣：儲存多次都唔可以越存越大（舊版每存一次就多留一份資料庫）。 */
  const sRows = await simpleRows();
  const sJunk = sRows.filter(r => String(r.unit) === '__staging__');
  ok('★★「資料表」分頁冇暫存垃圾行（逐表寫根本唔用暫存）', sJunk.length === 0, `${sJunk.length} 行`);
  const perTable = {};
  sRows.forEach(r => { const t = String(r.table ?? r.seq ?? ''); perTable[t] = (perTable[t] || 0) + 1; });
  const truth = await backendTruth();
  ok('★★「資料表」分頁行數 ＝ 各表段數之和（冇重複、冇殘留舊段）',
    sRows.length === Object.values(perTable).reduce((a, b) => a + b, 0) && sRows.length > 1,
    `rows=${sRows.length} tables=${Object.keys(perTable).length}`);
  ok('分頁冇比開頭脹大（舊「資料庫」分頁行數應該係啱啱鏡像嗰一份）',
    after.length <= before.length + Math.ceil(truth.bytes / 45000) + 2,
    `${before.length} → ${after.length}`);
}

/* ============================================================
   ⑦ 逃生門 cleanStaleStaging()：已經中招嘅 Sheet 救得返
   ============================================================ */
section('⑦ 逃生門：舊版留低嘅垃圾行清得走（正式資料唔會甩）');
{
  const truth0 = await backendTruth();
  /* 砌一個「舊版死咗一半」嘅情況：分件送上咗但冇 commit（＝斷線／閂視窗） */
  const saveId = '0082-stg-escapehatch-1';
  const part = await (await fetch(REAL_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'saveDbPart', unit: UNIT, apiKey: KEY, saveId, partIdx: 0, parts: 9,
      baseVersion: truth0.version, data: { junk: 'x'.repeat(120000) }
    })
  })).json();
  ok('前提：孤兒分件真係寫咗入「資料庫」分頁', part.ok === true, JSON.stringify(part).slice(0, 200));
  const withJunk = await sheetRows();
  ok('前提：而家真係有 __staging__ 行', withJunk.some(r => r.unit === '__staging__'));
  const peek = await backendTruth();
  ok('★ dbInfo 會報「暫存垃圾行」數（app 嘅同步診斷先至警告得到）',
    peek.stagingRows >= 1 && peek.stagingBytes > 0, JSON.stringify(peek));
  const dataBefore = withJunk.filter(r => r.unit === UNIT).length;

  const cleaned = await cleanStaleStaging();
  const afterClean = await sheetRows();
  ok('★ cleanStaleStaging() 清走晒暫存行',
    Number(cleaned.removed) >= 1 && !afterClean.some(r => r.unit === '__staging__'), JSON.stringify(cleaned));
  ok('★ 正式資料一行都冇甩',
    afterClean.filter(r => r.unit === UNIT).length === dataBefore,
    `${dataBefore} → ${afterClean.filter(r => r.unit === UNIT).length}`);
  const truth1 = await backendTruth();
  ok('清完之後後端仲讀得到（版本冇變）',
    truth1.found && truth1.version === truth0.version, JSON.stringify(truth1));
  ok('清完之後 dbInfo 報返 0 行垃圾（診斷唔會再嗌）',
    truth1.stagingRows === 0, JSON.stringify(truth1));
}

/* ============================================================
   ⑧ ★ 進度讀寫 + 後端自查（真 /api/progress → 真 Code.gs）
   ------------------------------------------------------------
   團長 2026-09-24 第二輪：「無痕讀取不了後端／入咗 URL API Key
   都睇唔到進度，人係讀到但係個個都冇進度」。
   呢一節釘死：真後端收到進度之後，/api/progress 讀得返，
   而且直接打開張 Sheet 就對得到：邊張 Spreadsheet、有幾多行、
   進度同名冊對唔對得上。
   （2026-11-12：本來靠 GAS `diag` action 自查，UI 喺 2026-09-26 已經拆走，
     所以連 action 一齊刪。改成直接讀 Sheet ＋ status —— 唔再信後端自己
     報告，而係驗證真正寫咗落去資料，覆蓋比之前更硬。）
   ============================================================ */
section('⑧ ★ 進度讀寫 ＋ 直接對 Sheet（/api/progress）');
{
  /* 敏感進度 action 而家必須有可信 session。用真 /api/auth 簽發超管 HMAC 票據，
     唔再將「知道 Sheet API Key」當成 browser 身份。 */
  const authRes = await fetch(`${BASE}/api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'sheep', password: SUPER_PASSWORD })
  }).then(r => r.json());
  ok('前提：真 /api/auth 簽發短期超管 session', authRes.ok === true && !!authRes.sessionToken,
    JSON.stringify(authRes).slice(0, 180));
  platformSessionToken = String(authRes.sessionToken || '');
  const post = (payload) => fetch(`${BASE}/api/progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, sessionToken: authRes.sessionToken })
  }).then(r => r.json());

  /* 先確保名冊有 YMIS（成員名單由 saveDb 嘅報表刷新寫入）。
     留意：呢個後端已經有資料，saveDb 行樂觀鎖 —— 要先讀返現行版本做 baseVersion。 */
  const info = await (await fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dbInfo', unit: UNIT, sessionToken: platformSessionToken })
  })).json();
  const push = await (await fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'saveDb', unit: UNIT, sessionToken: platformSessionToken,
      baseVersion: String(info.version || ''), db: {
      profile: { name: '第八十二旅' },
      members: [
        { id: 'pm1', name: '進度團員甲', ymis: '8202000001', identity: 'member', status: 'active' },
        { id: 'pm2', name: '進度團員乙', ymis: '8202000002', identity: 'member', status: 'active' }
      ], transactions: []
    } })
  })).json();
  ok('前提：真後端收到資料庫（成員名單會跟住寫）', push.ok === true, JSON.stringify(push).slice(0, 160));

  /* 用管理進度前端一樣嘅路徑寫入兩格進度（server session＝可信管理身份）。 */
  const save = await post({ action: 'save', unit: UNIT, backend: REAL_EXEC, apikey: KEY,
    data: { changes: [
      { ymis: '8202000001', itemId: 'L1-ACT-01', date: '2026-09-10', note: '' },
      { ymis: '8202000001', itemId: 'L1-UND-02', date: '2026-09-11', note: '' }
    ], confirmer: '團長' } });
  ok('經 /api/progress 寫入進度成功（真 Code.gs 收貨）', save.ok === true && Number(save.data?.processed) === 2,
    JSON.stringify(save).slice(0, 200));

  const load = await post({ action: 'load', unit: UNIT, backend: REAL_EXEC, apikey: KEY });
  ok('讀返：2 位成員、1 位有進度、2 格項目（另一個前端見到同一份）',
    Array.isArray(load.data?.members) && Object.keys(load.data?.progress || {}).length === 1
      && Object.keys(load.data.progress['8202000001'] || {}).length === 2,
    JSON.stringify({ members: (load.data?.members || []).length, p: load.data?.progress }));

  /* 直接開張 Sheet 對數（唔經後端自我報告）——「人讀到但冇進度」嘅唯一真相。
     留意：status 係管理系統 action，行 /api/proxy（唔係 /api/progress，
     後者只放行進度 leaf 嗰幾個 action）。 */
  const st = await (await fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status', unit: UNIT })
  })).json();
  ok('status：認得係管理系統嘅後端（有 backendVersion）',
    st.ok === true && !!st.backendVersion, JSON.stringify(st).slice(0, 200));
  const truth = await fetch(`http://127.0.0.1:${GAS_PORT}/_tabs`).then(r => r.json());
  const tabOf = (name) => (truth.tabs || []).filter(t => t.tab === name)[0];
  ok('status 報嘅 Spreadsheet 同真正嗰張一樣（唔使人自己猜邊張）',
    !!st.spreadsheet && st.spreadsheet === truth.spreadsheet,
    JSON.stringify({ reported: st.spreadsheet, actual: truth.spreadsheet }));
  ok('「進度追蹤」實際 2 行、1 個 YMIS、2 個項目',
    tabOf('進度追蹤')?.rows === 2 && Object.keys(load.data?.progress || {}).length === 1
      && Object.keys(load.data.progress['8202000001'] || {}).length === 2,
    JSON.stringify({ rows: tabOf('進度追蹤')?.rows, progress: load.data?.progress }));
  ok('進度同名冊對得上（「成員名單」2 行，YMIS 喺名冊入面）',
    tabOf('成員名單')?.rows >= 2 && !!(load.data?.members || []).filter(m => m.ymis === '8202000001')[0],
    JSON.stringify({ memberList: tabOf('成員名單')?.rows, members: (load.data?.members || []).length }));
  const EXPECT_TABS = ['資料庫', '資料表', '成員名單', '進度追蹤', '待批完成'];
  const missing = EXPECT_TABS.filter(t => !tabOf(t));
  ok('分頁齊（重點分頁全部存在）', missing.length === 0, JSON.stringify({ missing: missing }));

  /* 錯 Key 唔可以幫你睇到嘢（喺呢個部署，伺服器端 Key 會蓋過前端填嘅） */
  const badKey = await post({ action: 'load', unit: UNIT, backend: REAL_EXEC, apikey: 'wrong_key_xxx' });

  /* 呢個部署有設伺服器端 Key（TROOP_0082_APIKEY）→ 前端填乜都唔會蓋過佢：
     load 一樣由伺服器 key 認證（錯 key 唔會漏資料出去）。 */
  ok('伺服器端有 Key：前端亂填都唔會用（serverSideKey:true）',
    badKey.ok === true && badKey.serverSideKey === true,
    JSON.stringify({ ok: badKey.ok, srv: badKey.serverSideKey }));
}

/* ============================================================
   ⑨ ★ 搶救路線（團長 2026-09-24 第三輪）
   ------------------------------------------------------------
   「無痕讀取不了後端 ＝ 所有人都睇唔到，資料綁死喺我本機遊覽器」。
   呢一節就係模擬呢個實況（真 Code.gs ＋ 真代理）：
     ① 砌出壞掉嘅後端：好嘅一套段 ＋ 寫壞咗嘅較新一套 ＋ 暫存垃圾行
     ② 新裝置（無痕）讀 → 應該失敗（重現用家見到嘅症狀）
     ③ 經 /api/proxy 叫 repairDb（＝app 登入閘嗰粒「修復後端」）
     ④ 同一部新裝置再讀 → 今次讀得到（資料係後端嘅，唔再困喺某一部機）
     ⑤ 拎住資料嗰部機用 saveDbForce 強制覆蓋（＝「用呢部機嘅資料上載」）
     ⑥ 又一部全新裝置讀 → 見到覆蓋後嘅版本
   ============================================================ */
section('⑨ ★ 搶救：後端讀唔到 → 修復 → 新裝置讀到（真 Code.gs）');
{
  const post = (payload) => fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, sessionToken: platformSessionToken })
  }).then(r => r.json());

  /* ① 砌出壞掉嘅後端（直接寫「資料庫」分頁，模擬舊版漏刪／寫到一半死咗） */
  const goodDb = { profile: { name: '第八十二旅' }, members: [{ id: 'rm1', name: '原有團員', ymis: '8202000009', identity: 'member' }], transactions: [] };
  const seed = await (await fetch(REAL_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'saveDbForce', unit: UNIT, apiKey: KEY, db: goodDb })
  })).json();
  ok('（前置）先用 force 寫入一份好嘅資料庫', seed.success === true, JSON.stringify(seed).slice(0, 120));
  const goodVersion = String(seed.version || '');

  /* 之後：加一套「較新但寫壞」嘅段 ＋ 兩行暫存垃圾（＝當時真實症狀） */
  const junk = await (await fetch(`http://127.0.0.1:${GAS_PORT}/_seedBroken`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ unit: UNIT, half: '{"members":[{"id":"x-half', junkRows: 2 })
  })).json();
  ok('（前置）後端而家有「好嘅一套 ＋ 壞嘅較新一套 ＋ 垃圾行」',
    junk.ok === true && junk.versions === 2 && junk.stagingRows === 2, JSON.stringify(junk));

  /* ② 用「舊版讀法」示範用家見到嘅症狀：舊版會把同一旅團**所有**段一齊拼。
     呢度如實照做一次 —— 砌唔返 JSON ＝ 舊部署嘅新裝置／無痕一定讀唔到。 */
  const oldStyle = await (await fetch(`${REAL_EXEC}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'loadDb-OLD-STYLE', unit: UNIT, apiKey: KEY })
  })).json();
  ok('★ 舊版讀法（全部段一齊拼）砌唔返 JSON ＝ 舊部署嘅無痕／新裝置讀唔到（用家見到嘅症狀）',
    oldStyle.ok === false && /JSON|parse|壞/i.test(String(oldStyle.error || '')), JSON.stringify(oldStyle).slice(0, 200));

  const inc1 = await runDevice({ steps: [{ op: 'load' }] });
  ok('★ 已部署 v2.7.x 嘅後端有免疫：按版本分組讀，所以新裝置仍然讀得到（1 位舊團員）',
    step(inc1, 'load').ok === true && step(inc1, 'load').members >= 1,
    JSON.stringify(step(inc1, 'load')).slice(0, 220));

  /* ③ 修復（app 登入閘嗰粒掣 → /api/proxy → repairDb） */
  const fix = await post({ action: 'repairDb', unit: UNIT });
  ok('★ 一鍵修復成功（唔使入 Apps Script）', fix.ok === true, JSON.stringify(fix).slice(0, 200));
  ok('★ 清走垃圾行同壞嘅舊段', Number(fix.repaired?.removedStaging) === 2 && Number(fix.repaired?.removedOldVersions) >= 1,
    JSON.stringify({ staging: fix.repaired?.removedStaging, old: fix.repaired?.removedOldVersions }));
  ok('★ 修復之後後端讀得返（好嘅一套完好無缺）',
    fix.repaired?.loadOk === true && Number(fix.repaired?.members) >= 1, JSON.stringify(fix.repaired).slice(0, 200));

  /* ④ 同一部「無痕」裝置再讀 → 今次讀得到 */
  const inc2 = await runDevice({ steps: [{ op: 'load' }] });
  const inc2load = step(inc2, 'load');
  ok('★★ 無痕裝置而家讀到後端資料（同一個後端，唔再綁死喺某一部機）',
    inc2load.ok === true && inc2load.members >= 1, JSON.stringify(inc2load).slice(0, 240));

  /* ⑤ 守住資料嗰部機：強制覆蓋（＝「用呢部機嘅資料上載到後端」） */
  const forceDb = { profile: { name: '第八十二旅' }, members: [
    { id: 'rm1', name: '原有團員', ymis: '8202000009', identity: 'member' },
    { id: 'rm2', name: '搶救後加入', ymis: '8202000010', identity: 'member' }
  ], transactions: [] };
  const forced = await post({ action: 'saveDbForce', unit: UNIT, db: forceDb });
  ok('★ 強制覆蓋成功（回報覆蓋咗邊個舊版本）',
    forced.success === true && forced.forced === true && !!forced.overwroteVersion,
    JSON.stringify(forced).slice(0, 200));

  /* ⑥ 又一部全新裝置 → 見到覆蓋後嘅版本 */
  const inc3 = await runDevice({ steps: [{ op: 'load' }] });
  const inc3load = step(inc3, 'load');
  ok('★★ 又一部全新裝置見到覆蓋後嘅資料（2 位、含新加入嘅）',
    inc3load.ok === true && inc3load.members === 2 && inc3load.names.includes('搶救後加入'),
    JSON.stringify(inc3load).slice(0, 240));

  /* ⑦ 人手檢查用嘅兩個動作（status／dbInfo）全部答得到 —— 部署指南嘅逃生門靠佢 */
  const st = await post({ action: 'status', unit: UNIT });
  const info = await post({ action: 'dbInfo', unit: UNIT });
  ok('★ 後端檢查答得到：邊支腳本／邊張 Sheet／版本',
    st.ok === true && !!st.backendVersion && !!st.spreadsheet, JSON.stringify({ v: st.backendVersion, sheet: st.spreadsheet }));
  ok('★ 後端檢查答得到：修復後乾淨（1 套版本、0 垃圾、0 舊段）',
    Number(info.versions) === 1 && Number(info.stagingRows) === 0 && Number(info.staleRows) === 0,
    JSON.stringify({ v: info.versions, staging: info.stagingRows, stale: info.staleRows }));
}

section('多人驗收：新建個人身份 → 專用 server 密碼 action → 新裝置登入 → 第二人寫入');
{
  const A = await runDevice({ steps: [
    { op: 'load' },
    { op: 'addStaff', name: '甲領袖', email: 'leader-a@example.com' },
    { op: 'setHubPw', id: '@last', pw: 'test-pw-a' },
    { op: 'push' }
  ] });
  ok('甲建立帳號、設定密碼、頂部儲存到真 Sheet',
    step(A, 'setHubPw').ok && step(A, 'push').ok, JSON.stringify(A.steps).slice(0, 500));
  const B = await runDevice({ steps: [
    { op: 'login', login: 'leader-a@example.com', pw: 'test-pw-a' },
    { op: 'load' },
    { op: 'addStaff', name: '乙執委', email: 'leader-b@example.com', identity: 'exco' },
    { op: 'setHubPw', id: '@last', pw: 'test-pw-b' },
    { op: 'push' }
  ] });
  ok('全新裝置乙用甲的帳號經真後端登入', step(B, 'login').ok && step(B, 'login').gateOk,
    JSON.stringify(step(B, 'login')));
  ok('乙讀到甲的資料，按層級建立較低權限執委並以專用 action 設密碼',
    step(B, 'load').members === 3 && step(B, 'setHubPw').ok && step(B, 'push').ok,
    JSON.stringify(B.steps).slice(0, 500));
  const C = await runDevice({ steps: [
    { op: 'login', login: 'leader-b@example.com', pw: 'test-pw-b' },
    { op: 'load' }
  ] });
  ok('第三部全新裝置以乙的獨立執委身份可登入，讀到四人資料',
    step(C, 'login').ok && step(C, 'load').members === 4,
    JSON.stringify(C.steps).slice(0, 500));
}

console.log(`\n${fail ? '❌' : '✅'} 端到端（真 Code.gs）：${pass} 過 / ${fail} 唔過（${Date.now() - START}ms）`);
process.exit(fail ? 1 : 0);
