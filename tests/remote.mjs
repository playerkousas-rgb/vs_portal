/* ============================================================
   tests/remote.mjs — 後端儲存（資料真正寫入旅團自己嘅 Sheet）
   ------------------------------------------------------------
   呢個係團長回報嘅頭號問題：「資料只能瀏覽器儲存，唔能寫入後端」。
   呢度驗證整條來回路：
     ① api/proxy 放行 saveDb / loadDb / dbInfo，並且照樣做旅團白名單
     ② Code.gs 有「資料庫」分頁同 saveDb / loadDb / dbInfo，而且分段邏輯正確
     ③ 端到端：app 改資料 → 自動寫入後端 → 換一部「新機」→ 讀返同一份資料
     ④ 嚴格隔離：新旅團唔會借用 0082 嘅後端（唔會見到 82 旅嘅資料）
   用法：node tests/remote.mjs
   ============================================================ */

import http from 'node:http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import proxyHandler from '../api/proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 留低真 fetch：後面有啲測試會用 stub 蓋住佢，但 proxy 要真嘢先連到本機假 GAS */
const realFetchForProxy = globalThis.fetch;
const t0 = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

/** 剝走註釋先至做原始碼斷言 —— 否則「呢度以前係 XXX」呢類歷史註解
    會令「XXX 已經冇咗」嘅斷言假紅燈（2026-09-20 撞到）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const GAS = 'https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/exec';

function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}

/* ============================================================
   ① api/proxy 放行新 action
   ============================================================ */
section('同源 Proxy 支援「整份資料庫」讀寫');
{
  /* 0082 嘅資料已全清、registry 亦冇咗佢，所以用環境變數開一個虛構旅團做 fixture
     （真旅團登記方式一樣：Vercel env TROOP_<編號>_BACKEND / _APIKEY）。 */
  process.env.TROOP_TEST9_BACKEND = GAS;
  process.env.TROOP_TEST9_APIKEY = 'test9_secret_key';
  process.env.TROOP_TEST9_NAME = '測試旅深資童軍團';

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ target: String(target), body });
    return { status: 200, async text() { return JSON.stringify({ ok: true, success: true, found: true, db: { schema: 2, members: [] } }); } };
  };
  const realLog = console.log;
  const logLines = [];
  console.log = (...a) => { logLines.push(a.join(' ')); };

  const call = async (payload) => {
    const res = mockRes();
    await proxyHandler({ method: 'POST', body: payload }, res);
    return res;
  };

  const rSave = await call({ action: 'saveDb', unit: 'TEST9', db: { schema: 2, members: [{ name: '測試' }] } });
  const rLoad = await call({ action: 'loadDb', unit: 'TEST9' });
  const rInfo = await call({ action: 'dbInfo', unit: 'TEST9' });
  const rBad = await call({ action: 'dropEverything', unit: 'TEST9' });
  const rUnknownUnit = await call({ action: 'loadDb', unit: '9999' });

  console.log = realLog;
  globalThis.fetch = realFetch;

  ok('saveDb 可以經 proxy 轉發', rSave.statusCode === 200 && rSave.body?.ok === true, JSON.stringify(rSave.body));
  ok('loadDb 可以經 proxy 轉發', rLoad.statusCode === 200 && rLoad.body?.ok === true);
  ok('dbInfo 可以經 proxy 轉發', rInfo.statusCode === 200 && rInfo.body?.ok === true);
  ok('未知 action 仍然會被擋', rBad.statusCode === 400);
  ok('未登記旅團唔會轉發（唔會寫錯去人哋張 Sheet）', rUnknownUnit.statusCode === 404, JSON.stringify(rUnknownUnit.body));
  ok('轉發目的地係旅團自己嘅 /exec', calls[0]?.target === GAS, calls[0]?.target);
  ok('saveDb 有把整個資料庫帶上去', Array.isArray(calls[0]?.body?.db?.members));
  ok('Proxy log 唔會記低資料庫內容（唔外洩團員姓名）',
    !logLines.join('\n').includes('測試'), logLines.join(' | ').slice(0, 120));
}

/* ============================================================
   ② Code.gs 後端範本
   ============================================================ */
section('Apps Script 範本（Code.gs）');
{
  const code = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  ok('有「資料庫」分頁（app 真正嘅儲存）', /var DB_TAB = '資料庫'/.test(code));
  ok('initializeSheets 會建立「資料庫」分頁', /\{ name: '資料庫', headers:/.test(code));
  ok('有 saveDb（寫入整份資料庫）', /function saveDb\(body\)/.test(code));
  ok('有 loadDb（讀返整份資料庫）', /function loadDb\(unit\)/.test(code));
  ok('有 dbInfo（只問 meta，唔使拉成份落嚟）', /function dbInfo\(unit\)/.test(code));
  /* 唔好斷言成句嘅寫法（加一個 action 就會假紅燈）—— 逐個 action 驗有冇處理 */
  ['saveDb', 'loadDb', 'loadDbPart', 'dbInfo', 'saveDbPart', 'saveDbCommit'].forEach(a => {
    ok(`doPost 有處理 ${a}`, code.includes(`body.action === '${a}'`));
  });
  ok('有 loadDbPart（v2.6.0 分段讀取：大過 Vercel 4.5MB 都讀得返）', /function loadDbPart\(unit, partIdx\)/.test(code));
  /* 兩條讀法一定要共用同一個 dbRawText —— 否則「大資料庫分段讀返」
     可能同「一次過讀返」唔同，咁樣靜靜地讀到另一份資料，比讀唔到更危險。 */
  ok('有 dbRawText（loadDb／loadDbPart 共用嘅唯一讀法）', /function dbRawText\(unit, strict\)/.test(code));
  ok('loadDb 同 loadDbPart 都經 dbRawText（啱啱兩處呼叫）',
    (code.match(/= dbRawText\(unit\)/g) || []).length === 2,
    'count=' + (code.match(/= dbRawText\(unit\)/g) || []).length);
  /* ★ v2.7.0：寫入路嘅版本檢查一定要同讀取路同一套判斷 ——
     否則「最後一套段寫到一半死咗」會令 baseVersion 永遠對唔上，
     變成「永遠儲存唔到」（同「新儲嘅讀唔到」係同一個死法）。 */
  ok('★ 寫入路（saveDb／saveDbCommit）版本檢查用返 dbRawText（同讀取路一致）',
    (code.match(/var curVersion = dbRawText\(unit, true\)\.version/g) || []).length === 2,
    'count=' + (code.match(/dbRawText\(unit, true\)/g) || []).length);
  const loadDbBody = code.slice(code.indexOf('function loadDb(unit)'), code.indexOf('function loadDbPart'));
  ok('loadDb 唔再自己讀「資料庫」分頁（一定經 dbRawText）', !/getDataRange/.test(loadDbBody));
  ok('每段大小留足水位（1MB ≪ Vercel 4.5MB 回應上限）', /var LOAD_PART_CHARS = 1000000;/.test(code));
  ok('後端版本號同 BACKEND_VERSION 一致（介面檢查／診斷就靠佢對到）',
    (() => {
      const header = (code.match(/\*\s*版本：v?(\d+\.\d+\.\d+)/) || [])[1] || '';
      const decl = (code.match(/var BACKEND_VERSION = 'v?(\d+\.\d+\.\d+)'/) || [])[1] || '';
      return !!header && header === decl;
    })(),
    `header=${(code.match(/\*\s*版本：v?(\d+\.\d+\.\d+)/) || [])[1]} decl=${(code.match(/var BACKEND_VERSION = '(\d+\.\d+\.\d+)'/) || [])[1]}`);
  ok('doGet 都讀得（換機時用瀏覽器直接開都拎得返）', /action === 'loadDb' \|\| action === 'dbInfo'/.test(code));
  ok('寫入用 LockService 包住（兩個執委同時改都唔會爛）',
    /withLock\(function \(\) \{ return saveDb\(body\); \}\)/.test(code));
  /* v2.6.2：刪行邏輯統一咗入 deleteRowRuns()（以前 saveDb／saveDbPart／
     cleanStaging 各自砌一梳，cleanStaging 嗰份砌錯 —— 一梳連續行只刪到一行）。
     呢度**唔淨係** grep 原始碼，仲真係行一次 Code.gs 驗行為。 */
  ok('寫入前會刪走舊段（統一用 deleteRowRuns，唔會殘留舊資料）',
    /function deleteRowRuns\(sh, rowNos\)/.test(code) && /deleteRowRuns\(sh, oldRows\)/.test(code));
  ok('deleteRowRuns 由最底嗰梳刪起（刪上面會令下面行號走位）',
    /for \(var i = runs\.length - 1; i >= 0; i--\) sh\.deleteRows\(runs\[i\]\[0\], runs\[i\]\[1\]\);/.test(code));
  {
    const { makeGas } = await import('./_gasvm.mjs');
    const g = makeGas({ apiKey: 'test_key' });
    /* 第一份夠大要分 5 段（每段 45000 字）；第二份細到只有一段 ——
       如果刪舊段嗰度漏刪，第二次之後就會見到「5 段舊 ＋ 1 段新」撈埋。 */
    const mk = (n, pad = 0) => ({
      schema: 2, unitCode: '0082',
      members: Array.from({ length: n }, (_, i) => ({ id: 'm' + i, name: '團員' + i, note: 'x'.repeat(pad) }))
    });
    /* 第二次一定要帶 baseVersion（v2.2.0 樂觀鎖）—— 唔帶嘅話後端會當
       「過時裝置盲蓋」拒寫，咁就係喺測樂觀鎖而唔係測刪舊段。 */
    const first = g.post({ action: 'saveDb', unit: '0082', db: mk(10, 22000) });
    const rows1 = g.sheets.get('資料庫')._rows.length - 1;
    g.post({ action: 'saveDb', unit: '0082', db: mk(1), baseVersion: first.version });
    const after = g.sheets.get('資料庫')._rows.slice(1);
    ok('★ 存第二次之後冇殘留舊段（真行 Code.gs 驗，唔係 grep）',
      rows1 > 1 && after.length === 1,
      `第一次 ${rows1} 段 → 第二次剩 ${after.length} 段`);
    const back = g.post({ action: 'loadDb', unit: '0082' });
    ok('★ 讀返嘅係最新嗰份（1 個團員，唔係新舊撈埋）',
      back.ok === true && (back.db?.members || []).length === 1, JSON.stringify(back).slice(0, 120));
  }
  ok('分段大小喺 Sheet 單格上限之內（50000）', /var DB_CHUNK = 45000;/.test(code));
  ok('sync 一併存埋整份資料庫（報表 ＋ 可讀返嘅資料庫）', /if \(body\.db && typeof body\.db === 'object'\)/.test(code));
  ok('寫入資料庫要 API Key（唔係人人改得）',
    /寫入資料庫需要 API Key/.test(code) || /未授權：API Key 唔正確/.test(code));
}

/* ============================================================
   ③ 分段／拼合邏輯（直接跑 Code.gs 嘅演算法）
   ============================================================ */
section('分段寫入／拼合（大資料都唔會爛）');
{
  const DB_CHUNK = 45000;
  const big = { schema: 2, members: Array.from({ length: 2000 }, (_, i) => ({ id: 'm' + i, name: '團員' + i, ymis: String(2020000000 + i) })) };
  const text = JSON.stringify(big);
  const chunks = [];
  for (let p = 0; p < text.length; p += DB_CHUNK) chunks.push(text.substring(p, p + DB_CHUNK));

  ok('大資料會分段（超過單格上限）', text.length > DB_CHUNK && chunks.length > 1, `${text.length} 字元 → ${chunks.length} 段`);
  ok('每段都喺 Sheet 單格上限（50000）之內', chunks.every(c => c.length <= 50000));

  // 模擬亂序讀返（Sheet 行序唔保證）再排返
  const rows = chunks.map((c, i) => ({ seq: i + 1, text: c })).sort(() => Math.random() - 0.5);
  rows.sort((a, b) => a.seq - b.seq);
  const rebuilt = JSON.parse(rows.map(r => r.text).join(''));
  ok('拼返之後同原本一模一樣（冇甩欄、冇走樣）',
    rebuilt.members.length === 2000 && rebuilt.members[1999].name === '團員1999' && rebuilt.members[0].ymis === '2020000000');
}

/* ============================================================
   ④ 端到端（真 HTTP、兩個獨立 process ＝ 兩部真‧唔同嘅機）
   ------------------------------------------------------------
   流程：假 GAS ← dev-server(/api/proxy) ← 裝置 A / 裝置 B
   ============================================================ */
section('端到端：換機／清 cache 都唔會冇咗資料（真 HTTP）');
{
  const { spawn } = await import('node:child_process');
  const net0 = await import('node:net');
  /* 用隨機空閒 port：唔會撞到之前跑剩低嘅伺服器（撞到就會讀到舊資料，測試假失敗） */
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;

  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
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

  /* 用假 /exec 覆蓋 0082 嘅後端（唔會掂真 Google），
     並開啟 V82_PROXY_TEST 令 proxy 接受本機網址 */
  const ENV = {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_0082',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT)
  };

  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')], ENV);
    const gasUp = await waitPort(GAS_PORT);
    const webUp = await waitPort(WEB_PORT);
    ok('測試用假後端已啟動', gasUp);
    ok('本機 dev-server（連 /api/proxy）已啟動', webUp);

    const runDevice = (plan) => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
        { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', err = '';
      p.stdout.on('data', d => { buf += d; });
      p.stderr.on('data', d => { err += d; });
      const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
      const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（30 秒）' }), 30000);
      p.on('close', () => {
        clearTimeout(guard);
        const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
        if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
        try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
      });
    });

    /* ---- 裝置 A：清走種子資料 → 加人加帳 → 寫後端 ---- */
    const A = await runDevice({ steps: [
      { op: 'load' },                                   // 開機：後端仲係空
      { op: 'wipe' },
      { op: 'addMember', name: '陳大文', ymis: '2026000001' },
      { op: 'addTx', date: '2026-09-17', type: 'income', item: '團費', amount: 360 },
      { op: 'push' },
      { op: 'snapshot' },
      { op: 'backendKeys' }
    ] });
    ok('裝置 A 開得機、後端設定自動帶入', A.ok === true && A.configured === true,
      (A.error || JSON.stringify(A.cfg || {})).slice(0, 200));
    const loadA = (A.steps || []).find(s => s.op === 'load');
    ok('新旅團開機：後端仲係空（found:false）—— 基準記做「空」', loadA?.ok === true && loadA?.found === false && loadA?.baseEmpty === true, JSON.stringify(loadA));
    const pushStep = (A.steps || []).find(s => s.op === 'push');
    ok('裝置 A 把整個資料庫寫入後端', pushStep?.ok === true, JSON.stringify(pushStep));
    ok('寫入成功後 pending 清零（介面顯示「已存到後端」）', pushStep?.pending === 0, String(pushStep?.pending));
    const snapA = (A.steps || []).find(s => s.op === 'snapshot');
    ok('裝置 A 本機有 1 個團員、1 筆帳目', snapA?.members === 1 && snapA?.transactions === 1, JSON.stringify(snapA));
    ok('儲存之後基準 ＝ 後端版本（本機相對基準冇改動）', !!snapA?.baseVersion && snapA?.localChanges === 0, JSON.stringify({ v: snapA?.baseVersion, lc: snapA?.localChanges }));
    const keysA = (A.steps || []).find(s => s.op === 'backendKeys');
    ok('★ 寫上後端嘅 payload 冇 sync／backend（連線設定、API Key 唔會經 Sheet 傳嚟傳去）',
      keysA?.ok === true && !keysA.keys.includes('sync') && !keysA.keys.includes('backend') && keysA.keys.includes('members'), JSON.stringify(keysA?.keys));

    /* ---- 裝置 B ＝ 全新一部機（全新 process、全新 localStorage） ---- */
    const B = await runDevice({ steps: [
      { op: 'info' },
      { op: 'pull' },
      { op: 'snapshot' }
    ] });
    ok('裝置 B（新機）開得機', B.ok === true, (B.error || '').slice(0, 300));
    const infoB = (B.steps || []).find(s => s.op === 'info');
    ok('新機問後端：有資料', infoB?.ok === true && infoB?.found === true, JSON.stringify(infoB));
    ok('後端報返啱數（1 個團員、1 筆帳目）',
      infoB?.counts?.members === 1 && infoB?.counts?.transactions === 1, JSON.stringify(infoB?.counts));

    const pullB = (B.steps || []).find(s => s.op === 'pull');
    ok('新機讀得返整份資料庫', pullB?.ok === true && !!pullB?.adopted, JSON.stringify(pullB).slice(0, 200));
    ok('新機見返同一個團員（換機冇冇咗資料）',
      pullB?.adopted?.names?.includes('陳大文') && pullB?.adopted?.members === 1,
      JSON.stringify(pullB?.adopted));
    ok('新機見返同一筆帳目', pullB?.adopted?.transactions === 1);
    ok('採用後端資料之後唔會即刻又寫返上去（唔會來回打交）',
      pullB?.adopted?.pending === 0, String(pullB?.adopted?.pending));

    /* ---- 裝置 C：改完嘢 → 自動寫入後端（2026-09-24 修訂）----
       舊設計（2026-09-19／2026-09-20）係「改完暫存 → 用家自己撳同步」。
       團長 2026-09-24 回報「1 邊能用 email 登入、1 邊不能，那＝用戶根本沒寫入後端」：
       靠人記得撳掣，結果帳戶困喺瀏覽器。所以自動寫入放返嚟 ——
       但**寫入路依然只有一條**（saveToBackend：核對版本 → 三方比對 → 寫），
       頂部掣由「儲存到後端」改成「即刻儲存」（唔想等 debounce 先用）。 */
    const C = await runDevice({ steps: [
      { op: 'load' },                                   // 登入：由後端攞（＝1 個團員）
      { op: 'snapshot' },
      { op: 'autosave', name: '李小明', ymis: '2026000002', waitMs: 4000 },
      { op: 'backendPeek' },                            // 未撳儲存之前後端一個字都未收到
      { op: 'syncNow' }                                 // ← 用家撳「儲存到後端」
    ] });
    const snapC = (C.steps || []).find(s => s.op === 'snapshot');
    ok('裝置 C 登入之後只有後端嗰 1 個團員（種子資料唔會撈返轉頭）',
      snapC?.members === 1, JSON.stringify(snapC?.names));
    const auto = (C.steps || []).find(s => s.op === 'autosave');
    /* ★ 2026-09-24 團長：「我只想要頂部1個儲到後端的制,其他任何時候都是暫儲在遊覽器」。
       所以呢度釘死嘅係**相反**嘅保證：等足 4 秒都唔會自動寫 —— 改動一定仲係 pending。 */
    ok('★ 改完嘢等足 4 秒都**唔會**自動寫入後端（淨係暫存喺瀏覽器）',
      auto?.pending === 1 && auto?.state === 'pending', JSON.stringify(auto));
    ok('★ 未寫入嘅帳戶改動會另外計數（頂部要鬧醒用家）',
      /包括 1 個帳戶/.test(auto?.msg || ''), auto?.msg);
    const peekC = (C.steps || []).find(s => s.op === 'backendPeek');
    ok('★ 一個掣都未撳 → 後端仲係舊嗰份（1 個團員，冇偷偷地寫）', peekC?.members === 1, JSON.stringify(peekC));
    const nowC = (C.steps || []).find(s => s.op === 'syncNow');
    ok('★ 頂部「即刻儲存」掣照樣行得通（同一條 saveToBackend 路）',
      nowC?.ok === true && nowC?.pushed === true, JSON.stringify(nowC));
    ok('冇人喺我登入後儲存過 → 直接寫（唔使拉成份落嚟比對）', nowC?.remoteChanged === false && nowC?.pending === 0, JSON.stringify(nowC));

    /* ---- 裝置 D：確認撳咗同步之後真係入咗後端 ---- */
    const D = await runDevice({ steps: [{ op: 'info' }, { op: 'pull' }] });
    const pullD = (D.steps || []).find(s => s.op === 'pull');
    ok('第三部機見到裝置 C 同步咗嘅新團員（＝撳同步真係入咗後端）',
      pullD?.adopted?.names?.includes('李小明') && pullD?.adopted?.names?.includes('陳大文') &&
      pullD?.adopted?.members === 2,
      JSON.stringify(pullD?.adopted?.names));
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  }
}


/* ============================================================
   ④.5 衝突復原（2026-09-18「登入清空後端」事故嘅回歸測試）
   ------------------------------------------------------------
   劇本（全部真 HTTP）：
     A 部機同步咗（陳大文）→ B 部機拉咗，然後離線加咗（李四）
     → C 部機（有正確 baseVersion）加咗（張三）並同步
     → B 部機返嚟先 push → 撞版 → 要自動拉後端＋合併＋重存
       （三個人都要喺度，唔可以任何人被蓋走）
   另加：空白裝置（清咗 cache）唔可以自動蓋後端。
   ============================================================ */
section('衝突復原：兩部機都改過，同步要合併唔可以盲蓋（真 HTTP）');
{
  const net0 = await import('node:net');
  const os0 = await import('node:os');
  const fs0 = fs;
  const { spawn } = await import('node:child_process');
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;
  const ENV = {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_conflict',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT)
  };
  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
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
  const runDevice = (plan) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
      { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { err += d; });
    const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
    const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（30 秒）' }), 30000);
    p.on('close', () => {
      clearTimeout(guard);
      const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
      if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
      try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
    });
  });
  const stepOf = (res, op) => (res.steps || []).find(s2 => s2.op === op);
  const tmp = path.join(os0.tmpdir(), 'v82-conflict-' + Date.now() + '.json');

  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')], ENV);
    ok('衝突測試：假後端＋dev-server 已啟動', await waitPort(GAS_PORT) && await waitPort(WEB_PORT));

    /* A 部機：陳大文 → 同步（版本 V1） */
    const A = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'addMember', name: '陳大文', ymis: '2026000101' },
      { op: 'push' }
    ] });
    ok('A 部機首次同步成功', stepOf(A, 'push')?.ok === true, JSON.stringify(stepOf(A, 'push')));

    /* B 部機：拉 V1 → 離線加李四（唔好 push）→ 匯出本機 db */
    const B1 = await runDevice({ steps: [
      { op: 'pull' },
      { op: 'addMember', name: '李四', ymis: '2026000102' },
      { op: 'export', file: tmp },
      { op: 'snapshot' }
    ] });
    ok('B 部機拉到 V1 並離線加咗李四（pending=1）', stepOf(B1, 'snapshot')?.pending === 1 && stepOf(B1, 'snapshot')?.lastSyncedVersion !== '', JSON.stringify(stepOf(B1, 'snapshot')));

    /* C 部機：由 V1 加張三 → 同步成功（版本 V2：陳大文＋張三） */
    const C = await runDevice({ steps: [
      { op: 'pull' },
      { op: 'addMember', name: '張三', ymis: '2026000103' },
      { op: 'push' }
    ] });
    ok('C 部機同步成功（V2）', stepOf(C, 'push')?.ok === true, JSON.stringify(stepOf(C, 'push')));

    /* B 部機返嚟：讀返之前嘅本機 db＋基準（李四未同步、基準仲係 V1）→ 撳儲存
       舊版：盲蓋 → 張三消失（事故）。
       新版：後端版本唔同 → 拉落嚟三方比對 → 加李四 vs 加張三係唔同紀錄 → 唔撞 → 一齊寫。 */
    const B2 = await runDevice({ steps: [
      { op: 'import', file: tmp },
      { op: 'push' },
      { op: 'snapshot' }
    ] });
    const b2push = stepOf(B2, 'push');
    ok('B 部機撳儲存：偵測到有人喺我登入後儲存過（remoteChanged）', b2push?.remoteChanged === true, JSON.stringify(b2push));
    ok('B 部機：唔同紀錄 → 冇衝突 → 儲存成功', b2push?.ok === true && (b2push?.conflicts || []).length === 0 && b2push?.mine === 1 && b2push?.theirs === 1, JSON.stringify(b2push));
    const b2snap = stepOf(B2, 'snapshot');
    ok('合併後 B 部機本機有齊三個人', b2snap?.names?.includes('陳大文') && b2snap?.names?.includes('張三') && b2snap?.names?.includes('李四'), JSON.stringify(b2snap));
    ok('合併後 B 部機 pending 清零（已存到後端）', b2snap?.pending === 0, String(b2snap?.pending));

    const D = await runDevice({ steps: [{ op: 'pull' }] });
    const dnames = stepOf(D, 'pull')?.adopted?.names || [];
    ok('第四部機由後端見到三個人（冇任何人被蓋走）',
      dnames.includes('陳大文') && dnames.includes('張三') && dnames.includes('李四'), JSON.stringify(dnames));

    /* 空白裝置保險閘：清咗 cache 嘅新機唔可以自動蓋有料後端 */
    const Z = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'push' },
      { op: 'snapshot' }
    ] });
    ok('★ 未由後端載入過嘅裝置撳儲存 → 拒絕（no_base），唔會盲寫', stepOf(Z, 'push')?.ok === false && stepOf(Z, 'push')?.reason === 'no_base', JSON.stringify(stepOf(Z, 'push')));
    const D2 = await runDevice({ steps: [{ op: 'pull' }] });
    ok('空白裝置冇蓋爛後端（資料仲在）',
      (stepOf(D2, 'pull')?.adopted?.members || 0) >= 3, JSON.stringify(stepOf(D2, 'pull')?.adopted));

    /* ---- 開機時本機有未存改動，隊友已儲存 → 開機三方比對保留兩邊 ----
       ★ 2026-09-24 起根本唔使關自動儲存 —— 自動寫入成條路都拆咗，
       「有未存改動」而家係預設狀態（改完就 pending，要撳頂部掣先寫）。 */
    const E1 = await runDevice({ steps: [
      { op: 'load' },                                   // E 登入（三個人）
      { op: 'addMember', name: '李七', ymis: '2026000107' },   // E 改咗嘢未存（pending）
      { op: 'teammatePush', name: '李八', ymis: '2026000108' },// 同時隊友儲存咗李八上後端
      { op: 'load' },                                   // E 閂咗再開（開機再由後端攞）
      { op: 'push' }
    ] });
    const loads = (E1.steps || []).filter(s2 => s2.op === 'load');
    const es = loads[1];
    ok('再開機：有未存改動 → 三方比對（merged），唔係盲採用後端', es?.merged === true && es?.fresh === false, JSON.stringify(es));
    ok('再開機：本機有齊三個人＋李七（我未存嘅）＋李八（隊友嘅）',
      es?.names?.includes('李七') && es?.names?.includes('李八') && (es?.members || 0) >= 5, JSON.stringify(es?.names));
    ok('再開機：我嘅改動仍然係「未儲存」（pending ≥ 1）、基準 ＝ 隊友嗰個新版本', es?.pending >= 1 && (es?.conflicts || []).length === 0, JSON.stringify({ p: es?.pending, c: es?.conflicts }));
    const e1push = stepOf(E1, 'push');
    ok('之後撳儲存：直接寫（基準已經係最新）', e1push?.ok === true && e1push?.remoteChanged === false && e1push?.pending === 0, JSON.stringify(e1push));
    const F1 = await runDevice({ steps: [{ op: 'load' }, { op: 'load' }] });
    ok('冇未存改動嗰陣開機 ＝ 直接採用後端（fresh）', (F1.steps || []).every(s2 => s2.fresh === true && s2.pending === 0), JSON.stringify(F1.steps));
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
    try { fs0.unlinkSync(tmp); } catch { /* ignore */ }
  }
}


/* ============================================================
   ④.7 多人同一時間一齊做嘢（會議模式）
   ------------------------------------------------------------
   深層合併：同一條紀錄兩部機改唔同「格」→ 兩邊都保留
   （A 點名陳大文、B 點名李小明 → 兩個人都喺度）
   立即同步：checkRemote 問到隊友新版本 → 拉＋合併
   ============================================================ */
section('三方比對：同一條紀錄唔同格兩邊都保留；同一格唔同值 ＝ 衝突（唔會自己揀）');
{
  const { threeWay, overridesFor, applyChanges, describeConflict } = await import('../assets/js/lib/merge3.js');

  /* 例 1：同一個活動，A 點名 m1、B 點名 m2 */
  const base1 = { events: [{ id: 'e1', title: '集會', rollcall: {} }] };
  const theirs1 = { events: [{ id: 'e1', title: '集會', rollcall: { m1: 'present' } }] };
  const mine1 = { events: [{ id: 'e1', title: '集會', rollcall: { m2: 'late' } }] };
  const t1 = threeWay(base1, mine1, theirs1);
  ok('唔同格：A 點嘅陳大文仲在', t1.merged.events[0].rollcall?.m1 === 'present', JSON.stringify(t1.merged.events[0].rollcall));
  ok('唔同格：B 點嘅李小明都喺度', t1.merged.events[0].rollcall?.m2 === 'late', JSON.stringify(t1.merged.events[0].rollcall));
  ok('唔同格：冇衝突', t1.conflicts.length === 0);

  /* 例 2：同一條團員紀錄，A 改電話、B 改電郵 */
  const base2 = { members: [{ id: 'c1', name: '陳大文', phone: '', email: '' }] };
  const t2 = threeWay(base2,
    { members: [{ id: 'c1', name: '陳大文', phone: '', email: 'a@b.c' }] },
    { members: [{ id: 'c1', name: '陳大文', phone: '9123', email: '' }] });
  ok('唔同格：A 改嘅電話保留', t2.merged.members[0].phone === '9123', JSON.stringify(t2.merged.members[0]));
  ok('唔同格：B 改嘅電郵都保留', t2.merged.members[0].email === 'a@b.c', JSON.stringify(t2.merged.members[0]));

  /* 例 3：兩部機同時收不同人嘅試卷答卷（responses 地圖併集） */
  const base3 = { quizzes: [{ id: 'q1', responses: {} }] };
  const t3 = threeWay(base3,
    { quizzes: [{ id: 'q1', responses: { stuB: { name: '學生乙', answers: {} } } }] },
    { quizzes: [{ id: 'q1', responses: { stuA: { name: '學生甲', answers: {} } } }] });
  ok('唔同格：兩份答卷都喺度（唔會互相蓋走）',
    !!t3.merged.quizzes[0].responses.stuA && !!t3.merged.quizzes[0].responses.stuB, JSON.stringify(t3.merged.quizzes[0].responses));

  /* 例 4（團長嘅例子）：同一格 —— 一個登記早走、一個登記遲到 → 衝突，唔會自己揀 */
  const base4 = { members: [{ id: 'm1', name: '陳大文' }], events: [{ id: 'e1', title: '集會', date: '2026-09-20', rollcall: { m1: 'present' } }] };
  const t4 = threeWay(base4,
    { members: base4.members, events: [{ id: 'e1', title: '集會', date: '2026-09-20', rollcall: { m1: 'early' } }] },
    { members: base4.members, events: [{ id: 'e1', title: '集會', date: '2026-09-20', rollcall: { m1: 'late' } }] });
  ok('同一格唔同值 → 1 個衝突', t4.conflicts.length === 1, JSON.stringify(t4.conflicts));
  ok('衝突嗰格暫時用後端（遲到），**唔會**自動用我嘅', t4.merged.events[0].rollcall.m1 === 'late');
  const d4 = describeConflict(t4.conflicts[0], { local: {}, remote: base4 });
  ok('衝突講到人話（行事曆 › 集會 › 陳大文 點名：早走 vs 遲到）',
    /行事曆|活動/.test(d4.module) && /集會/.test(d4.record) && /陳大文/.test(d4.field) && /早走/.test(d4.mineText) && /遲到/.test(d4.theirsText), JSON.stringify(d4));
  const ov = overridesFor(t4.conflicts, true);
  applyChanges(t4.merged, ov);
  ok('用家再確認「用我嘅」→ 先至蓋過去（早走）', t4.merged.events[0].rollcall.m1 === 'early');

  /* 例 5：同一格同一個值 → 唔算衝突 */
  const t5 = threeWay(base4,
    { members: base4.members, events: [{ id: 'e1', title: '集會', date: '2026-09-20', rollcall: { m1: 'late' } }] },
    { members: base4.members, events: [{ id: 'e1', title: '集會', date: '2026-09-20', rollcall: { m1: 'late' } }] });
  ok('同一格同一個值 → 冇衝突（same）', t5.conflicts.length === 0 && t5.same.length === 1, JSON.stringify({ c: t5.conflicts, s: t5.same }));
}

section('只有一個儲存方式（原始碼守門：冇自動寫、冇 poll、冇第二條寫入路）');
{
  const remoteSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/remote.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'assets/js/main.js'), 'utf8');
  const hubSrc = fs.readFileSync(path.join(ROOT, 'assets/js/public-hub.js'), 'utf8');
  const tablesSrc = fs.readFileSync(path.join(ROOT, 'assets/js/views/tables.js'), 'utf8');
  const guardSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/guard.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/store.js'), 'utf8');
  ok('remote.js 有 loadFromBackend（登入攞後端）＋ saveToBackend（唯一寫入路）',
    /export async function loadFromBackend/.test(remoteSrc) && /export function saveToBackend/.test(remoteSrc));
  ok('saveToBackend：先 dbInfo 核對版本，唔同先至拉成份三方比對',
    /action: 'dbInfo'/.test(remoteSrc) && /threeWay\(/.test(remoteSrc) && /remoteChanged/.test(remoteSrc));
  ok('saveToBackend：撞嘅格交 resolver 問用家，確認咗先再寫一次',
    /resolver\(/.test(remoteSrc) && /applyChangesLocal\(ov\)/.test(remoteSrc));
  /* ★ 2026-09-24 團長第五輪：「我只想要頂部1個儲到後端的制,其他任何時候都是暫儲在遊覽器」。
     2026-09-24 曾經加過自動寫入（為咗救「帳戶寫唔入後端」），但團長明確唔要 ——
     自動儲存成條路已經拆走。而家釘死嘅係：
       ① remote.js 完全冇自動寫入（冇 autoSave／冇 debounce timer／冇 setAutoSave）
       ② 寫入依然只有一條路（saveToBackendInner），冇第二條
       ③ 冇 poll／setInterval／online／beforeunload 之類嘅背景寫入 */
  ok('★ remote.js 已經冇自動寫入（autoSave／debounce／setAutoSave 全部拆走）',
    !/async function autoSave/.test(remoteSrc)
    && !/AUTO_SAVE_DELAY_MS/.test(remoteSrc)
    && !/export function setAutoSave/.test(remoteSrc)
    && !/flushAutoSave/.test(remoteSrc));
  {
    /* 抽返 scheduleSave() 個函數體出嚟驗：淨係得 setState('pending', …)，一個寫入呼叫都冇 */
    const bare = stripComments(remoteSrc);
    const i = bare.indexOf('export function scheduleSave(');
    const body = i < 0 ? '' : bare.slice(i, bare.indexOf('\n}', i) + 2);
    ok('★ scheduleSave 淨係改狀態（pending），一行寫入都冇',
      body.length > 0 && /setState\('pending'/.test(body) && !/saveToBackend|fetch\(/.test(body),
      body.slice(0, 200));
  }
  ok('★ 寫入依然只有一條路（saveToBackendInner）＋冇第二條寫入路',
    /async function saveToBackendInner\(/.test(remoteSrc)
    && !/startPolling|startVisibilityWatch|checkRemote|function reconcile|recoverFromConflict|setInterval/.test(stripComments(remoteSrc)));
  ok('★ 所有儲存排成一條隊（連撳兩下唔會回 busy）',
    /let saveChain = Promise\.resolve\(\)/.test(remoteSrc));
  /* 註解入面提過 beforeunload（講 main.js 嗰邊嘅閘），所以要剝走註解先至算 */
  ok('remote.js 冇 online／beforeunload 自動寫',
    !/addEventListener\('online'/.test(stripComments(remoteSrc)) && !/beforeunload/.test(stripComments(remoteSrc)));
  ok('★ 帳戶改動另外計數（pendingAccounts）—— 頂部要用嚟鬧醒用家',
    /export function pendingAccounts\(\)/.test(remoteSrc) && /pendingAccounts/.test(storeSrc));
  ok('store.js 冇咗舊嘅自動合併（mergeDbs／objHash／markBaseAligned）', !/mergeDbs|objHash|markBaseAligned|snapshotObjHashes/.test(storeSrc));
  ok('store.js 有基準快照（getBase／setBase）＋ adoptRemote／setLocalMerged／commitSaved',
    /export function getBase/.test(storeSrc) && /export function setBase/.test(storeSrc) && /export function adoptRemote/.test(storeSrc)
    && /export function setLocalMerged/.test(storeSrc) && /export function commitSaved/.test(storeSrc));
  ok('main.js 右上角：有未存嘢 → 「儲存到後端（N）」；否則「重新載入」',
    /儲存到後端/.test(mainSrc) && /重新載入/.test(mainSrc) && /syncActBtn/.test(mainSrc));
  ok('★ main.js 有未寫入帳戶會轉紅鬧醒（b-danger ＋「N 個帳戶未寫入後端」）',
    /pendingAccounts/.test(mainSrc) && /個帳戶未寫入後端/.test(mainSrc) && /b-danger/.test(mainSrc));
  ok('main.js 掛咗跨分頁同步 ＋ 切返分頁刷新（自動儲存衝突框已隨自動儲存一齊拆走）',
    /bindCrossTabSync/.test(mainSrc) && /refreshIfClean/.test(mainSrc) && !/setAutoConflictResolver/.test(mainSrc));
  /* ★ 2026-09-24 團長：「如果分頁走嗰時無 SAVE 就唔得了，定係我哋當佢自動遊覽器儲存晒？」
     → 當佢自動瀏覽器儲存咗。寫瀏覽器唔等如寫後端，所以轉分頁**唔彈框**、
       **唔放棄**：只係 flush 落瀏覽器 ＋ toast 話你知返嚟可以「還原」。
       真正要彈框問嘅得「未寫入後端」（登出／閂頁）。
       所以呢度要釘死**相反**方向：轉分頁唔可以再彈「呢個分頁有未儲存嘅改動」。 */
  ok('★ 轉分頁**唔會**彈「未儲存改動」框（草稿當自動暫存咗喺瀏覽器）',
    !/呢個分頁有未儲存嘅改動/.test(mainSrc) && !/discardActiveDrafts/.test(mainSrc),
    'main.js 仲有離開分頁閘');
  ok('★ 轉分頁會先 flush 草稿落瀏覽器（stashActiveDrafts），先至 render',
    /stashActiveDrafts/.test(mainSrc) && /hashchange/.test(mainSrc));
  ok('★ guard.js 有 stashActiveDrafts（flush ＋ 保留，唔放棄）',
    /export function stashActiveDrafts/.test(guardSrc) && /pendingFlushes/.test(guardSrc));
  ok('store.js 有跨分頁併入（storage event ＋ 三方比對）',
    /export function mergeFromOtherTab/.test(storeSrc) && /addEventListener\('storage'/.test(storeSrc));
  ok('store.js 帳戶級寫入即刻通知後端（members／accounts／accountApps）',
    /export function commitCritical/.test(storeSrc) && /IDENTITY_COLLECTIONS/.test(storeSrc));
  ok('團員入口交嘢行 pushSubmit（唔會成份 db 寫後端）', /pushSubmit/.test(hubSrc));
  ok('★ 總表同步頁已經冇「自動寫入」開關 —— 淨低「儲存到後端」',
    !/toggle-autosave/.test(tablesSrc) && /儲存到後端/.test(tablesSrc) && /冇自動寫入/.test(tablesSrc));
  ok('main.js 開機**等**後端載入完先出登入頁（await syncBoot）', /await syncBoot\(\)/.test(mainSrc));
  ok('開機後端失敗會停喺連線閘（唔會落入登入頁）',
    /const bootSync = await syncBoot\(\)/.test(mainSrc)
    && /if \(!bootSync\?\.ok\)[\s\S]*?renderBackendGate\(bootSync\)/.test(mainSrc)
    && /function renderBackendGate/.test(mainSrc));
  ok('連線閘只顯示普通用家可明白嘅重試／揀旅團操作',
    /暫時未能連線，請稍後再試/.test(mainSrc)
    && /id="btnRetryBackend"/.test(mainSrc) && /id="btnChangeUnit"/.test(mainSrc)
    && !/input[^>]+(?:exec|API Key)/i.test((mainSrc.match(/function renderBackendGate[\s\S]*?function renderFatal/) || [''])[0]));
  /* 2026-09-20 改：以前呢度係 `freshenBeforeLogin()`（ensureFresh，「連唔到都照登入」）。
     團長質疑「既然都同後端對咗帳戶密碼，點可能入去之後話冇連上後端」之後，
     改成硬閘 —— 後端答唔到就唔准入。所以呢條斷言要跟著改。 */
  ok('main.js 登入前硬性核對後端（登入嗰一刻 ＝ 後端嗰一刻，核對唔到就唔入）',
    /gateLoginOnBackend\(\)/.test(mainSrc) && /requireBackendForLogin/.test(mainSrc)
    && !/freshenBeforeLogin\(\)/.test(stripComments(mainSrc)));
  ok('main.js 登出會再由後端攞一次', /async function doLogout[\s\S]*?await syncBoot\(\)/.test(mainSrc));
  ok('main.js 冇 poll／visibility／arm／checkRemote', !/startPolling|startVisibilityWatch|\.arm\(\)|checkRemote|reconcile\(/.test(mainSrc));
  ok('beforeunload 只提醒、唔寫後端', /beforeunload/.test(mainSrc) && !/flush\(\)/.test(mainSrc));
  ok('team 員入口：開機 loadFromBackend、交嘢 saveToBackend（唔係 flush）、冇 poll',
    /loadFromBackend\(/.test(hubSrc) && /saveToBackend\(\{ policy: 'mine'/.test(hubSrc) && !/flush\(|startPolling|startVisibilityWatch/.test(hubSrc));
  const testSyncBlock = (tablesSrc.match(/act === 'test-sync'\)([\s\S]*?)if \(act === 'push-sync'\)/) || ['', ''])[1];
  ok('總表同步：「測試連線」淨係讀（唔會 pushToMaster）', testSyncBlock.length > 0 && !/pushToMaster/.test(testSyncBlock) && /testConnection/.test(testSyncBlock));
  ok('總表同步：報表同步唔會夾帶整個 db、唔會清 pending', /payload\.skipDb = true/.test(tablesSrc) && !/payload\.db = db/.test(tablesSrc) && !/pending: 0, lastPushAt/.test(tablesSrc));
  ok('總表同步：冇咗「會議模式」開關', !/y-poll/.test(tablesSrc));
  ok('狀態 badge 撳擊仍去「總表同步」詳情', /tables\/sync/.test(mainSrc));
  ok('remote.js 有 uploadPhotos（相片上 Drive，db 只留連結）',
    /export async function uploadPhotos/.test(remoteSrc) && /action: 'uploadPhotos'/.test(remoteSrc));
  ok('儲存有體積路由（<2.8MB 單件；以上自動分件；>40MB 先硬止）',
    /too_big/.test(remoteSrc) && /CHUNKED_ABOVE/.test(remoteSrc) && /saveDbPart/.test(remoteSrc) && /40000000/.test(remoteSrc));
  ok('大 db 對舊後端會退返單件路（唔會靜靜地死）',
    /未知 action/.test(remoteSrc) && /改用單一件儲存/.test(remoteSrc));
  ok('總表同步有「體積檢查」同「相片瘦身」掣',
    /size-check/.test(tablesSrc) && /size-slim/.test(tablesSrc) && /slimClaimPhotos/.test(tablesSrc));
  const financeSrc = fs.readFileSync(path.join(ROOT, 'assets/js/views/finance.js'), 'utf8');
  ok('APP 內申報相片會先試 uploadPhotos 上 Drive（失敗先本地存）',
    /uploadPhotos\(photos/.test(financeSrc) && /photosOnDrive/.test(financeSrc));
  const conSrc = fs.readFileSync(path.join(ROOT, 'assets/js/views/constitution.js'), 'utf8');
  const notSrc = fs.readFileSync(path.join(ROOT, 'assets/js/views/notices.js'), 'utf8');
  ok('團章發布／通告同步都行同一條 saveWithDialog', /saveWithDialog/.test(conSrc) && /saveWithDialog/.test(notSrc) && !/syncNow|pushToMaster/.test(conSrc) && !/pushToMaster/.test(notSrc));
  const dlgSrc = fs.readFileSync(path.join(ROOT, 'assets/js/views/syncdialog.js'), 'utf8');
  ok('衝突對話框：預設保留後端、剔咗先用我嘅、有「全部用我嘅」', /useMine/.test(dlgSrc) && /保留後端/.test(dlgSrc) && /全部剔/.test(dlgSrc));
}

/* ============================================================
   ④.6 團長劇本（真 HTTP）：一個登記早走、一個登記遲到
   ------------------------------------------------------------
   A 建立資料 → B 登入、點陳大文「早走」未存、走開
   → C 登入、點陳大文「遲到」＋李小明「出席」、儲存
   → B 返嚟撳儲存：李小明嗰格（唔撞）要入；陳大文嗰格（撞）唔可以自己揀 ——
     唔確認 ＝ 保留後端；確認「用我嘅」＝ 蓋過去
   ============================================================ */
section('團長劇本：同一格「早走 vs 遲到」要問，唔撞嘅照儲存（真 HTTP）');
{
  const { spawn } = await import('node:child_process');
  const net0 = await import('node:net');
  const os0 = await import('node:os');
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;

  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
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
  const runDevice = (plan) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
      { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { err += d; });
    const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
    const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（30 秒）' }), 30000);
    p.on('close', () => {
      clearTimeout(guard);
      const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
      if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
      try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
    });
  });
  const stepOf = (res, op, nth = 0) => (res.steps || []).filter(s2 => s2.op === op)[nth];
  const fieldOf = (res, id, path) => (res.steps || []).find(s2 => s2.op === 'getField' && s2.id === id && JSON.stringify(s2.path) === JSON.stringify(path))?.value;
  const tmpB = path.join(os0.tmpdir(), 'v82-rollcall-B-' + Date.now() + '.json');

  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')], {
      TROOP_0082_BACKEND: FAKE_EXEC, TROOP_0082_APIKEY: 'test_key_0082', V82_PROXY_TEST: '1', PORT: String(WEB_PORT)
    });
    ok('假後端＋dev-server 已啟動', await waitPort(GAS_PORT) && await waitPort(WEB_PORT));

    const MEMBERS = [{ id: 'm1', name: '陳大文', ymis: '2026000001', identity: 'member' }, { id: 'm2', name: '李小明', ymis: '2026000002', identity: 'member' }];
    const EVENTS = [{ id: 'e1', title: '週會', date: '2026-09-20', rollcall: { m1: 'present', m2: 'absent' } }];

    /* A：建立資料 → 儲存（V1） */
    const A = await runDevice({ steps: [
      { op: 'load' }, { op: 'wipe' },
      { op: 'put', coll: 'members', rows: MEMBERS },
      { op: 'put', coll: 'events', rows: EVENTS },
      { op: 'push' }
    ] });
    ok('A：建立資料並儲存（V1）', stepOf(A, 'push')?.ok === true, JSON.stringify(stepOf(A, 'push') || A.error));

    /* B：登入 → 點陳大文「早走」→ 未儲存就走開 */
    const B = await runDevice({ steps: [
      { op: 'load' },
      { op: 'setField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'], value: 'early' },
      { op: 'export', file: tmpB },
      { op: 'snapshot' }
    ] });
    ok('B：登入攞到 V1（基準），點咗早走未存（pending 1、本機相對基準 1 個改動）',
      stepOf(B, 'load')?.fresh === true && stepOf(B, 'snapshot')?.pending === 1 && stepOf(B, 'snapshot')?.localChanges === 1, JSON.stringify(stepOf(B, 'snapshot')));

    /* C：登入 → 點陳大文「遲到」＋李小明「出席」→ 儲存（V2） */
    const C = await runDevice({ steps: [
      { op: 'load' },
      { op: 'setField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'], value: 'late' },
      { op: 'setField', coll: 'events', id: 'e1', path: ['rollcall', 'm2'], value: 'present' },
      { op: 'push' }
    ] });
    ok('C：儲存成功（V2：陳大文遲到、李小明出席）', stepOf(C, 'push')?.ok === true && stepOf(C, 'push')?.remoteChanged === false, JSON.stringify(stepOf(C, 'push')));

    /* B 返嚟撳儲存 —— 唔確認（保留後端） */
    const B2 = await runDevice({ steps: [
      { op: 'import', file: tmpB },
      { op: 'push', useMine: false },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'] },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm2'] },
      { op: 'snapshot' }
    ] });
    const p2 = stepOf(B2, 'push');
    ok('★ B 撳儲存：話你知有人喺你登入後儲存過', p2?.remoteChanged === true, JSON.stringify(p2));
    ok('★ 陳大文嗰格「早走 vs 遲到」＝ 1 個衝突，未寫入', p2?.ok === true && (p2?.conflicts || []).length === 1 && /events\/\[e1\]\/rollcall\/m1/.test(p2.conflicts[0]), JSON.stringify(p2?.conflicts));
    ok('★ 對話框講到人話：陳大文 點名 —— 你「早走」、後端「遲到」',
      p2?.dialog?.[0] && /陳大文/.test(p2.dialog[0].where) && /早走/.test(p2.dialog[0].mine) && /遲到/.test(p2.dialog[0].theirs), JSON.stringify(p2?.dialog));
    ok('★ 唔確認 → 保留後端（遲到）；李小明「出席」（唔撞）已經併入本機', fieldOf(B2, 'e1', ['rollcall', 'm1']) === 'late' && fieldOf(B2, 'e1', ['rollcall', 'm2']) === 'present',
      JSON.stringify({ m1: fieldOf(B2, 'e1', ['rollcall', 'm1']), m2: fieldOf(B2, 'e1', ['rollcall', 'm2']) }));
    ok('儲存完 pending 清零、kept=1', stepOf(B2, 'snapshot')?.pending === 0 && p2?.kept === 1, JSON.stringify({ p: stepOf(B2, 'snapshot')?.pending, kept: p2?.kept }));

    /* B 再返嚟一次（同一份未存狀態）—— 今次確認「用我嘅」 */
    const B3 = await runDevice({ steps: [
      { op: 'import', file: tmpB },
      { op: 'push', useMine: true },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'] },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm2'] },
      { op: 'snapshot' }
    ] });
    const p3 = stepOf(B3, 'push');
    ok('★ 確認「用我嘅」→ 再寫一次，蓋過去（resolved 1）', p3?.ok === true && p3?.resolved === 1 && p3?.overrideOk === true, JSON.stringify(p3));
    ok('★ 本機：陳大文早走（我嘅）、李小明出席（對方嘅）都喺度', fieldOf(B3, 'e1', ['rollcall', 'm1']) === 'early' && fieldOf(B3, 'e1', ['rollcall', 'm2']) === 'present',
      JSON.stringify({ m1: fieldOf(B3, 'e1', ['rollcall', 'm1']), m2: fieldOf(B3, 'e1', ['rollcall', 'm2']) }));
    ok('蓋完 pending 清零', stepOf(B3, 'snapshot')?.pending === 0);

    /* D：第三部機登入 → 後端真係係「早走＋出席」 */
    const D = await runDevice({ steps: [
      { op: 'load' },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'] },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm2'] }
    ] });
    ok('★ 後端最終：陳大文早走、李小明出席', fieldOf(D, 'e1', ['rollcall', 'm1']) === 'early' && fieldOf(D, 'e1', ['rollcall', 'm2']) === 'present',
      JSON.stringify({ m1: fieldOf(D, 'e1', ['rollcall', 'm1']), m2: fieldOf(D, 'e1', ['rollcall', 'm2']) }));

    /* 同一格同一個值：B 嘅舊狀態（早走）而家同後端一樣 → 冇衝突 */
    const B4 = await runDevice({ steps: [
      { op: 'import', file: tmpB },
      { op: 'push' }
    ] });
    const p4 = stepOf(B4, 'push');
    ok('★ 同一格同一個值（兩邊都係早走）→ 冇衝突、直接儲存', p4?.ok === true && p4?.remoteChanged === true && (p4?.conflicts || []).length === 0 && p4?.same === 1, JSON.stringify(p4));

    /* 登入時先發現（上次未存就閂咗）：E 登入 → 點陳大文「不出席」未存 → F 儲存「遲到」→ E 再開機 */
    const tmpE = path.join(os0.tmpdir(), 'v82-rollcall-E-' + Date.now() + '.json');
    const E = await runDevice({ steps: [
      { op: 'load' },
      { op: 'setField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'], value: 'absent' },
      { op: 'export', file: tmpE }
    ] });
    ok('E：點咗不出席未存', E.ok === true, E.error || '');
    const F = await runDevice({ steps: [
      { op: 'load' },
      { op: 'setField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'], value: 'late' },
      { op: 'push' }
    ] });
    ok('F：儲存咗遲到', stepOf(F, 'push')?.ok === true, JSON.stringify(stepOf(F, 'push')));
    const E2 = await runDevice({ steps: [
      { op: 'import', file: tmpE },
      { op: 'load' },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'] },
      { op: 'applyMine', useMine: true },
      { op: 'getField', coll: 'events', id: 'e1', path: ['rollcall', 'm1'] },
      { op: 'push' }
    ] });
    const l2 = stepOf(E2, 'load');
    ok('★ E 再開機：三方比對發現「不出席 vs 遲到」衝突，先用後端、問用家', l2?.merged === true && (l2?.conflicts || []).length === 1 && /不出席/.test(l2?.dialog?.[0]?.mine || '') && /遲到/.test(l2?.dialog?.[0]?.theirs || ''), JSON.stringify(l2));
    ok('開機合併後本機暫時係後端值（遲到）', (E2.steps || []).filter(s2 => s2.op === 'getField')[0]?.value === 'late');
    ok('★ 用家揀「用我嘅」→ 本機變返不出席、pending ≥ 1', (E2.steps || []).filter(s2 => s2.op === 'getField')[1]?.value === 'absent' && stepOf(E2, 'applyMine')?.pending >= 1, JSON.stringify(stepOf(E2, 'applyMine')));
    ok('之後撳儲存直接寫（基準已係最新）', stepOf(E2, 'push')?.ok === true && stepOf(E2, 'push')?.remoteChanged === false, JSON.stringify(stepOf(E2, 'push')));
    try { fs.unlinkSync(tmpE); } catch { /* ignore */ }
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
    try { fs.unlinkSync(tmpB); } catch { /* ignore */ }
  }
}

/* ============================================================
   ⑤ 嚴格隔離：新旅團唔會見到／寫入 0082 嘅資料
   ============================================================ */
section('旅團隔離（新旅團唔會見到 82 旅嘅資料）');
{
  const units = await import('../assets/js/lib/units.js?iso=1');
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'units.json'), 'utf8'));

  /* 以前 registry 有個頂層共用 backend，任何未登記旅團都會 fallback 去到，
     即係會見到 82 旅張 Sheet。而家已經拆走 —— 呢個測試守住佢唔好返嚟。 */
  ok('Registry 冇咗頂層共用 backend（舊漏洞已封）', !reg.backend?.gasUrl, JSON.stringify(reg.backend || null));
  ok('★ 0082 得個公開名單（冇後端冇 Key，唔會洩漏唔會被借用）',
    !!reg.units?.['0082'] && !reg.units['0082'].backend?.gasUrl && !reg.units['0082'].apiKey
    && !/script\.google/.test(JSON.stringify(reg.units)),
    Object.keys(reg.units || {}).join(',') || '（空）');
  ok('Registry 預設旅團係空（唔會靜靜雞當你係 82 旅）', !reg.defaultUnit, String(reg.defaultUnit));

  /* 扮一個「已登記但未交後端」嘅新旅團 */
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/api\/units/.test(u)) return { ok: false, status: 404 };
    if (/units\.json/.test(u)) {
      const withNew = {
        ...reg,
        units: {
          ...reg.units,
          '0077': { code: '0077', name: '第七十七旅深資童軍團' },
          TEST9: { code: 'TEST9', name: '測試旅深資童軍團', backend: { gasUrl: GAS } }
        }
      };
      return { ok: true, status: 200, json: async () => withNew, text: async () => JSON.stringify(withNew) };
    }
    return { ok: false, status: 404 };
  };
  await units.loadRegistry(true);

  const newTroop = units.backendOf('0077');
  ok('未交後端嘅新旅團 ＝ 冇後端（唔會借用 82 旅張 Sheet）', newTroop === null, JSON.stringify(newTroop));
  ok('自己有登記後端嘅旅團照樣讀得到', (units.backendOf('TEST9') || {}).gasUrl === GAS);
  ok('登記咗嘅後端唔會被標記做「共用」', units.backendOf('TEST9')?.shared === false);
  ok('0082 已經冇登記 → 攞唔到後端（資料清乾淨）', units.backendOf('0082') === null,
    JSON.stringify(units.backendOf('0082')));
  ok('新旅團冇靜態資料夾（唔會讀到人哋嘅團員檔）',
    units.dataPathOf('0077') === 'data/units/0077/' && !fs.existsSync(path.join(ROOT, 'data', 'units', '0077')));
  ok('0082 靜態資料夾已經喺 Git 移除（唔會再種落任何人部機）',
    !fs.existsSync(path.join(ROOT, 'data', 'units', '0082')));
}

/* ============================================================
   ⑥ API Key 由伺服器端注入（唔可以要求用家喺瀏覽器打 key）
   ------------------------------------------------------------
   架構：TROOP_<編號>_BACKEND / _APIKEY 入 Vercel 環境變數
   → /api/proxy 喺伺服器端解析 → 前端只送旅團編號。
   曾經出過嘅錯：前端無論如何都送 apiKey:''，而 proxy 係寫
   `if (unit.apiKey && !payload.apiKey)` 先注入 —— 個空字串令
   注入唔到，後端就回「未授權」，變成要用家自己去打條 key。
   ============================================================ */
section('API Key 由伺服器端注入（前端唔應該知）');
{
  /* 上面第 ⑤ 段用咗個「乜都 404」嘅 fetch stub 去扮 registry，
     而且冇還原 —— proxy 要用真 fetch 先去到本機假 GAS，所以喺度還原返。 */
  globalThis.fetch = realFetchForProxy;
  const KEY = 'v82_serverside_only';
  let keySeenByGas = null;
  const gas = http.createServer((q, s) => {
    let raw = '';
    q.on('data', c => { raw += c; });
    q.on('end', () => {
      const b = JSON.parse(raw || '{}');
      keySeenByGas = b.apiKey || b.apikey || '';
      const needKey = ['saveDb', 'loadDb', 'dbInfo'].includes(b.action);
      const out = (needKey && keySeenByGas !== KEY)
        ? { ok: false, success: false, error: '未授權：API Key 唔正確' }
        : { ok: true, success: true, bytes: 10, chunks: 1, found: true };
      s.setHeader('Content-Type', 'application/json');
      s.end(JSON.stringify(out));
    });
  });
  await new Promise(r => gas.listen(0, '127.0.0.1', r));
  const gasUrl = `http://127.0.0.1:${gas.address().port}/exec`;

  const saved = { b: process.env.TROOP_0082_BACKEND, k: process.env.TROOP_0082_APIKEY, t: process.env.V82_PROXY_TEST };
  process.env.TROOP_0082_BACKEND = gasUrl;
  process.env.TROOP_0082_APIKEY = KEY;
  process.env.V82_PROXY_TEST = '1';

  const callProxy = (body) => new Promise(resolve => {
    const res = {
      _s: 200, setHeader() {}, status(c) { this._s = c; return this; },
      json(o) { resolve({ status: this._s, json: o }); }
    };
    proxyHandler({ method: 'POST', body, headers: {} }, res);
  });

  /* 前端完全唔送 apiKey —— 正路 */
  keySeenByGas = null;
  const clean = await callProxy({ action: 'saveDb', unit: '0082', db: { members: [] } });
  ok('前端唔送 apiKey，proxy 由 env 注入', clean.json?.ok === true, JSON.stringify(clean.json));
  ok('GAS 真係收到伺服器端條 key', keySeenByGas === KEY, JSON.stringify(keySeenByGas));

  /* 前端送空字串 —— 唔可以令注入失效 */
  keySeenByGas = null;
  const empty = await callProxy({ action: 'saveDb', unit: '0082', apiKey: '', apikey: '', db: { members: [] } });
  ok('前端送空 apiKey 都唔會阻住注入', empty.json?.ok === true, JSON.stringify(empty.json));
  ok('空字串唔會蓋過伺服器端條 key', keySeenByGas === KEY, JSON.stringify(keySeenByGas));

  /* 前端唔應該把空 key 放入 proxy payload。
     2026-09-19：payload 砌法由 remote.js 搬咗去 lib/gateway.js（兩條路共用），
     所以呢個性質而家喺 gateway.js 度驗 —— 驗嘅嘢一樣，冇放寬。 */
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/lib/remote.js'), 'utf8');
  const gsrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/gateway.js'), 'utf8');
  ok('gateway.js 只喺有 key 嗰陣先加入 payload（proxy 路線）',
    /if \(apiKey\) \{\s*body\.apiKey/.test(gsrc));
  ok('remote.js 把路由交畀 gateway（唔會自己砌 proxy payload）',
    /postBackend\(/.test(src) && !/body\.apiKey/.test(src));
  ok('remote.js 有 proxy 路線就唔再強制要前端填 /exec',
    /viaProxy/.test(src) && /viaProxy && !!unit/.test(src));

  /* 提示文字：**平台代理路線**要指向 Vercel 環境變數，
     唔可以叫用家喺瀏覽器打 key（2026-09-17 嘅決定，繼續有效）。
     呢度由 grep 原始碼改成**行為**斷言（hintOf 已 export）。 */
  const remoteMod = await import('../assets/js/lib/remote.js');
  const proxyHint = remoteMod.hintOf('未授權：API Key 唔正確', 'proxy');
  const directHint = remoteMod.hintOf('未授權：API Key 唔正確', 'direct');
  ok('bad_key 提示（代理路線）叫人設定 TROOP_<編號>_APIKEY（唔係叫用家自己打）',
    /TROOP_<[^>]*>_APIKEY/.test(proxyHint) && /環境變數/.test(proxyHint), proxyHint.slice(0, 60));
  ok('bad_key 提示（代理路線）冇叫用家去「同步設定」填 key',
    !/同步設定/.test(proxyHint), proxyHint.slice(0, 80));
  /* 2026-09-19 新增：行緊「自己貼 /exec」自助路線嗰陣，條 key 本來就要由瀏覽器帶，
     提示必須針對呢條路（唔好叫佢搵管理員 —— 佢就係因為搵唔到先至行呢條路）。 */
  ok('bad_key 提示（自助路線）教用家貼返條 key',
    /showApiKey/.test(directHint) && /同步設定/.test(directHint), directHint.slice(0, 60));

  gas.close();
  if (saved.b === undefined) delete process.env.TROOP_0082_BACKEND; else process.env.TROOP_0082_BACKEND = saved.b;
  if (saved.k === undefined) delete process.env.TROOP_0082_APIKEY; else process.env.TROOP_0082_APIKEY = saved.k;
  if (saved.t === undefined) delete process.env.V82_PROXY_TEST; else process.env.V82_PROXY_TEST = saved.t;
}

/* ============================================================
   ⑦ 搬遷檢查：清走前端資料之前，要證實後端真係有齊嘢
   ------------------------------------------------------------
   0082 原本係「靜態檔 + localStorage」嘅系統，要搬入後端。
   清嘢係不可逆，所以「搬遷檢查」必須喺以下情況擋住：
     · 後端仲係空（未推過）
     · 本機有嘢未寫入後端（pending）
     · 兩邊筆數對唔上
   ============================================================ */
section('搬遷檢查（清前端之前要對數）');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/views/tables.js'), 'utf8');
  ok('「總表同步」有「搬遷檢查」掣', /data-act="migrate-check"/.test(src));
  ok('檢查會 pullDb 攞成份後端資料落嚟逐項數（唔淨係信 dbInfo 個 count）',
    /act === 'migrate-check'/.test(src) && /remote\.pullDb\(\)/.test(src));
  ok('後端空 → 明確叫人唔好清', /後端仲係空/.test(src) && /千祈唔好/.test(src));
  ok('有 pending → 擋住', /pendingCount\(\)/.test(src) && /未寫入後端/.test(src));
  ok('筆數唔夾 → 唔畀清', /未可以清/.test(src));
  ok('全部夾 → 先至講可以安全清走', /可以安全清走前端資料/.test(src));
  ok('對數範圍唔止 6 項（連團章／團費／申報／預算／借用都數）',
    /團章章節/.test(src) && /團費紀錄/.test(src) && /收支申報/.test(src)
    && /活動預算/.test(src) && /物資借用/.test(src));
  ok('建議次序有叫人先做 JSON 備份', /匯出 JSON 備份/.test(src));
}

/* ============================================================
   ⑧ 「總表同步」唔填 /exec 都要經得同源代理（純環境變數開團）
   ------------------------------------------------------------
   2026-09-17 0082 事件：純 Vercel env 開團嘅旅團，前端根本唔會填
   /exec（網址同 key 留喺伺服器端），但 pushToMaster 一見冇 s.url
   就即刻話「未設定網址」—— 連「測試連線」都撳唔到。
   而家：冇本地網址就經同源 /api/proxy 照送。
   ============================================================ */
section('總表同步經同源代理（唔填 /exec 都得）');
{
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:8080/', pretendToBeVisual: true });
  const { window } = dom;
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
    catch { /* 唯讀 → 略過 */ }
  }
  globalThis.window = window;

  const seen = [];
  const memFetch = globalThis.fetch;
  /* 假代理：扮 GAS 經 proxy 回嚟嘅 JSON */
  let proxyReply = { ok: true, msg: '已寫入總表', counts: { members: 1 }, unit: '0082' };
  globalThis.fetch = async (url, init = {}) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'api/proxy') {
      seen.push(JSON.parse(init.body || '{}'));
      return { ok: true, status: 200, text: async () => JSON.stringify(proxyReply) };
    }
    return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '404' };
  };

  const store = await import('../assets/js/lib/store.js');
  await store.init({ mode: 'real', unit: '0082' });
  ok('測試 DB 冇本地後端網址（純 env 開團嘅狀態）',
    !store.load().sync?.url && !store.load().backend?.gasUrl);

  const tables = await import('../assets/js/views/tables.js');
  const r1 = await tables.pushToMaster({ silent: true });
  ok('★ 冇填 /exec 都經得代理送出', r1.ok === true, JSON.stringify(r1).slice(0, 200));
  ok('送去代理嘅係 sync action＋旅團編號',
    seen[0]?.action === 'sync' && seen[0]?.unit === '0082',
    JSON.stringify({ a: seen[0]?.action, u: seen[0]?.unit }));
  ok('★ 經代理唔會送空 apiKey（等伺服器端注入）',
    !('apiKey' in (seen[0] || {})), Object.keys(seen[0] || {}).join(','));
  ok('★ 報表同步**唔會**夾帶整個資料庫（資料庫只有一條寫入路：saveToBackend）', !seen[0]?.db && seen[0]?.skipDb === true, Object.keys(seen[0] || {}).join(','));
  ok('報表同步唔會清 pending（未儲存嘅仍然係未儲存）', true);

  /* GAS 拒絕（例如 key 唔啱）嗰陣，HTTP 200 都要當失敗，而且要講得出原因 */
  proxyReply = { ok: false, success: false, error: '未授權：API Key 唔正確（寫入資料庫需要 API Key）' };
  const r2 = await tables.pushToMaster({ silent: true });
  ok('★ 代理回未授權 → 唔可以扮成功', r2.ok === false, JSON.stringify(r2).slice(0, 160));
  ok('錯誤原因要浮得返上嚟', /未授權/.test(String(r2.msg || '')), String(r2.msg || '').slice(0, 100));

  /* 純靜態部署（冇 /api/proxy）＋ 冇填網址 → 先至係真・未設定 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'api/proxy') return { ok: false, status: 404, text: async () => '<h1>404</h1>' };
    return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '404' };
  };
  const r3 = await tables.pushToMaster({ silent: true });
  ok('冇代理又冇網址 → 明確話連唔到代理', r3.ok === false && /同源代理/.test(String(r3.msg || '')),
    String(r3.msg || '').slice(0, 120));

  /* remote.testConnection 一樣唔可以強制要本地網址 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'api/proxy') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, msg: '82venture 後端正常' }) };
    }
    return { ok: false, status: 404, text: async () => '404' };
  };
  const remote = await import('../assets/js/lib/remote.js');
  const t = await remote.testConnection();
  ok('remote.testConnection 經代理都 test 到（唔使本地網址）', t.ok === true, JSON.stringify(t).slice(0, 160));

  globalThis.fetch = memFetch;
}

/* ============================================================
   ⑨ 舊系統遷移：指去 82venture 嘅公開網址要搵得出＋一鍵搬
   ------------------------------------------------------------
   各旅團資料庫入面嘅公開網址（通告／團章／公開頁）好可能仲係
   舊站嗰陣填嘅 82venture.vercel.app —— 嗰啲 QR／WhatsApp 連結
   退役之後會死晒。呢度驗：搵得出、搬得啱、頁面識得警告。
   （沿用第 ⑧ 節嘅 jsdom 環境：location ＝ http://localhost:8080/）
   ============================================================ */
section('舊系統遷移（一鍵搬公開網址）');
{
  const store = await import('../assets/js/lib/store.js');
  const model = await import('../assets/js/lib/model.js');

  ok('認得舊站網址', model.isLegacyUrl('https://82venture.vercel.app/notice.html?u=0082&n=x') === true);
  ok('唔理大細楷', model.isLegacyUrl('https://82VENTURE.VERCEL.APP/entry.html') === true);
  ok('相對路徑唔算舊站', model.isLegacyUrl('notice.html?u=0082') === false);
  ok('新站唔算舊站', model.isLegacyUrl('https://ecportal.vercel.app/notice.html') === false);
  ok('而家唔係喺舊站', model.onLegacyHost() === false);

  /* 播種：扮 0082 資料庫入面仲有舊網址（單旅團年代填落嘅） */
  const db = store.load();
  db.settings.notice = { ...(db.settings.notice || {}), publicBaseUrl: 'https://82venture.vercel.app/notice.html' };
  db.settings.publicBaseUrl = 'https://82venture.vercel.app/constitution.html?u={u}';
  db.settings.publicLinks = {
    ...(db.settings.publicLinks || {}), base: '',
    'entry.html': 'https://82venture.vercel.app/entry.html', 'borrow.html': ''
  };
  store.commit();

  const found = model.findLegacyPublicUrls();
  ok('★ 搵得出 3 個指去舊站嘅設定', found.length === 3, JSON.stringify(found.map(f => f.key)));
  ok('搬遷淨係換 host（path＋參數照留）',
    model.migrateLegacyUrl('https://82venture.vercel.app/notice.html?u=0082&n=5') === 'http://localhost:8080/notice.html?u=0082&n=5',
    model.migrateLegacyUrl('https://82venture.vercel.app/notice.html?u=0082&n=5'));
  ok('唔係舊站網址就原樣回傳',
    model.migrateLegacyUrl('https://ecportal.vercel.app/x') === 'https://ecportal.vercel.app/x');

  const n = model.migrateLegacyPublicUrls();
  ok('★ 一鍵搬走 3 個', n === 3, String(n));
  ok('搬完之後搵唔到舊站網址', model.findLegacyPublicUrls().length === 0);
  ok('通告網址已經係而家呢個站',
    store.load().settings.notice.publicBaseUrl === 'http://localhost:8080/notice.html',
    store.load().settings.notice.publicBaseUrl);
  ok('{u} 參數搬完之後仲喺度',
    store.load().settings.publicBaseUrl === 'http://localhost:8080/constitution.html?u={u}',
    store.load().settings.publicBaseUrl);

  /* 公開資料頁會出 banner（播返個舊嘅先） */
  store.load().settings.publicLinks['borrow.html'] = 'https://82venture.vercel.app/borrow.html';
  store.commit();
  const links = await import('../assets/js/views/links.js');
  /* ★ 2026-09-24 團長：「公開資料其實唔係要填嘢嘅，係方便了解有乜嘢而家正喺度公開」
     → 預設嗰版係只讀一覽表；舊站警告要兩個分頁都見到（擺咗喺 render() 頂）。 */
  const html = links.render();
  ok('★ 公開資料頁有舊站警告＋一鍵搬掣', /舊系統/.test(html) && /data-act="migrate-urls"/.test(html));
  /* 逐條連結卡嘅警告喺「團員入口（分享）」分頁（嗰度先係派得出去嗰啲連結） */
  const htmlHub = links.render({ id: 'hub' });
  ok('受影響嘅連結卡有警告', /退役之後會死/.test(htmlHub));
  ok('★ 兩個分頁都有舊站警告（一覽表版唔會漏）', /舊系統/.test(htmlHub));

  /* 通告分享連結都係同一個來源（搬完就啱） */
  const notices = await import('../assets/js/views/notices.js');
  store.add('notices', { id: 'n_legacy1', title: { zh: '測試通告' }, status: 'published' });
  const rec = store.find('notices', 'n_legacy1');
  ok('通告 publicUrl 用搬完之後嘅新網址',
    notices.publicUrl(rec).startsWith('http://localhost:8080/notice.html?'), notices.publicUrl(rec));
}

/* ============================================================
   ⑧ 分件儲存（v2.4.0 長壽命架構）
   db 大過單一請求上限：自動拆件 → 逐件 saveDbPart → commit 拼合。
   呢度測：拆件純函數、真 HTTP 分件 e2e、舊後端退返單件路。
   ============================================================ */
section('分件儲存：splitDbIntoParts（純函數契約）');
{
  const { splitDbIntoParts, PART_MAX_BYTES } = await import('../assets/js/lib/remote.js');
  ok('PART_MAX_BYTES < 4MB（proxy 安全線之內）', PART_MAX_BYTES < 4 * 1048576, String(PART_MAX_BYTES));

  const db = {
    schema: 2, kind: 'ecportal', unitCode: '0082',
    settings: { groupName: '第八十二旅' },
    members: Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, name: '團員' + i })),
    transactions: Array.from({ length: 5000 }, (_, i) => ({ id: 't' + i, amount: i, note: 'x'.repeat(200) })),
    blob: 'y'.repeat(3000)
  };
  const parts = splitDbIntoParts(db, 400000);
  ok('細 db 唔會拆件', splitDbIntoParts({ schema: 2, members: [{ id: 1 }] }).length === 1);
  ok('大 db 會拆做多件', parts.length > 3, String(parts.length));
  ok('每件都細過上限', parts.every(pt => JSON.stringify(pt).length <= 420000),
    JSON.stringify(parts.map(pt => JSON.stringify(pt).length)));
  ok('第一件有 meta 欄（schema／unitCode）', parts[0].schema === 2 && parts[0].unitCode === '0082');
  const merged = {};
  parts.forEach(pt => {
    for (const [k, v] of Object.entries(pt)) {
      merged[k] = Array.isArray(v) && Array.isArray(merged[k]) ? merged[k].concat(v) : v;
    }
  });
  ok('拼合返：大陣列一條唔少（5000 筆帳）', merged.transactions.length === 5000, String(merged.transactions.length));
  ok('拼合返：陣列內容無走樣', JSON.stringify(merged.transactions) === JSON.stringify(db.transactions));
  ok('拼合返：細 key 照單全收', merged.settings?.groupName === '第八十二旅' && merged.blob === 'y'.repeat(3000));
}

section('分件儲存：真 HTTP（谷大 db → 自動分件 → 另一部機讀得返）');
{
  const { spawn } = await import('node:child_process');
  const net0 = await import('node:net');
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;
  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p); return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
    const t = Date.now();
    while (Date.now() - t < ms) {
      const up = await new Promise(r => {
        const s2 = net.connect(port, '127.0.0.1');
        s2.on('connect', () => { s2.destroy(); r(true); }); s2.on('error', () => r(false));
      });
      if (up) return true;
      await new Promise(r2 => setTimeout(r2, 120));
    }
    return false;
  };
  const ENV = { TROOP_0082_BACKEND: FAKE_EXEC, TROOP_0082_APIKEY: 'test_key_0082', V82_PROXY_TEST: '1', PORT: String(WEB_PORT) };
  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')], ENV);
    ok('假後端＋dev-server 已啟動', await waitPort(GAS_PORT) && await waitPort(WEB_PORT));

    const runDevice = (plan) => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
        { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', err = '';
      p.stdout.on('data', d => { buf += d; });
      p.stderr.on('data', d => { err += d; });
      const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
      const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（60 秒）' }), 60000);
      p.on('close', () => {
        clearTimeout(guard);
        const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
        if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
        try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
      });
    });

    /* 裝置 A：谷 1400 個團員（每人 2KB ≈ 2.9MB > 2.8MB 閾值）→ push 走分件 */
    const A = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'bulkMembers', count: 1400, kb: 2, prefix: 'Big' },
      { op: 'push' }
    ] });
    const bulkA = (A.steps || []).find(s2 => s2.op === 'bulkMembers');
    ok('db 已谷大過分件閾值（>2.8MB）', (bulkA?.bytes || 0) > 2800000, String(bulkA?.bytes));
    const pushA = (A.steps || []).find(s2 => s2.op === 'push');
    ok('★ 大 db 自動分件儲存成功', pushA?.ok === true, JSON.stringify(pushA).slice(0, 200));
    ok('★ 真係行咗分件路（≥2 件）', (pushA?.parts || 0) >= 2, String(pushA?.parts));

    /* 裝置 B：新機讀返 —— 1400 個團員一個唔少 */
    const B = await runDevice({ steps: [{ op: 'info' }, { op: 'pull' }] });
    const infoB = (B.steps || []).find(s2 => s2.op === 'info');
    ok('後端報返 1400 個團員（分件拼合啱數）', infoB?.counts?.members === 1400, JSON.stringify(infoB?.counts));
    const pullB = (B.steps || []).find(s2 => s2.op === 'pull');
    ok('新機讀返分件儲存嘅資料：1400 個一個唔少', pullB?.adopted?.members === 1400, String(pullB?.adopted?.members));

    /* 分件之後再細改 → 撳「立即同步」照樣存到（版本鏈冇斷、唔會鎖死） */
    const C = await runDevice({ steps: [
      { op: 'load' },
      { op: 'autosave', name: '分件後新團員', ymis: '2026999999', waitMs: 3000 },
      { op: 'syncNow' }
    ] });
    const autoC = (C.steps || []).find(s2 => s2.op === 'autosave');
    ok('分件之後改嘢都係淨係暫存（唔會自動寫）', autoC?.pending === 1 && autoC?.state === 'pending', JSON.stringify(autoC));
    const nowC = (C.steps || []).find(s2 => s2.op === 'syncNow');
    ok('分件儲存之後撳「儲存到後端」照樣存到（唔會鎖死）',
      nowC?.ok === true && nowC?.pushed === true, JSON.stringify(nowC));
    const D = await runDevice({ steps: [{ op: 'pull' }] });
    const pullD = (D.steps || []).find(s2 => s2.op === 'pull');
    ok('分件後嘅新改動都入咗後端', pullD?.adopted?.members === 1401, String(pullD?.adopted?.members));
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  }
}

section('分件儲存：舊後端（未部署 v2.4.0）會退返單件路');
{
  const { spawn } = await import('node:child_process');
  const net0 = await import('node:net');
  const http0 = await import('node:http');
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const STUB_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p); return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
    const t = Date.now();
    while (Date.now() - t < ms) {
      const up = await new Promise(r => {
        const s2 = net.connect(port, '127.0.0.1');
        s2.on('connect', () => { s2.destroy(); r(true); }); s2.on('error', () => r(false));
      });
      if (up) return true;
      await new Promise(r2 => setTimeout(r2, 120));
    }
    return false;
  };

  /* 舊後端 = 真假 GAS（識 saveDb/loadDb）＋一塊擋板：saveDbPart／Commit 回「未知 action」 */
  const stub = http0.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const a = body.action || '';
      if (a === 'saveDbPart' || a === 'saveDbCommit') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: false, success: false, error: '未知 action：' + a }));
      }
      const fwd = http0.request({ host: '127.0.0.1', port: GAS_PORT, path: '/exec', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, (fr) => {
        res.setHeader('Content-Type', fr.headers['content-type'] || 'application/json');
        fr.pipe(res);
      });
      fwd.on('error', () => { res.statusCode = 502; res.end('{}'); });
      fwd.end(raw);
    });
  });
  await new Promise(r => stub.listen(STUB_PORT, '127.0.0.1', r));
  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')],
      { TROOP_0082_BACKEND: `http://127.0.0.1:${STUB_PORT}/exec`, TROOP_0082_APIKEY: 'test_key_0082', V82_PROXY_TEST: '1', PORT: String(WEB_PORT) });
    ok('舊後端模擬器已啟動', await waitPort(GAS_PORT) && await waitPort(STUB_PORT) && await waitPort(WEB_PORT));

    /* db 細：直接單件（唔會行分件，梗係得）；db 大：分件失敗 → 退返單件硬送（假後端唔設 body 上限，會收到） */
    const runDevice = (plan) => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
        { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', err = '';
      p.stdout.on('data', d => { buf += d; });
      p.stderr.on('data', d => { err += d; });
      const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
      const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（60 秒）' }), 60000);
      p.on('close', () => {
        clearTimeout(guard);
        const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
        if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
        try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
      });
    });

    const A = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'addMember', name: '陳大文', ymis: '2026000001' },
      { op: 'push' },
      { op: 'bulkMembers', count: 1400, kb: 2, prefix: 'Big' },
      { op: 'push' }
    ] });
    const pushes = (A.steps || []).filter(s2 => s2.op === 'push');
    ok('細 db 單件儲存成功（冇行分件）', pushes[0]?.ok === true && (pushes[0]?.parts || 0) === 0, JSON.stringify(pushes[0]));
    ok('★ 大 db 對舊後端：分件唔通都退返單件路存到', pushes[1]?.ok === true,
      JSON.stringify(pushes[1] || A.error || A.steps?.map(s2 => s2.op))?.slice(0, 220));

    const B = await runDevice({ steps: [{ op: 'info' }] });
    const infoB = (B.steps || []).find(s2 => s2.op === 'info');
    ok('舊後端真係收到（1401 個團員）', infoB?.counts?.members === 1401, JSON.stringify(infoB?.counts));
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
    try { stub.close(); } catch { /* ignore */ }
  }
}

/* ============================================================
   ⑯ v2.6.0：大過 4.5MB 都讀得返（分段讀取）
   ------------------------------------------------------------
   2026-09-20 團長回報：「無痕同普通視窗對唔到料；登入之後仲話我冇後端。」
   死因鏈（每一環都喺呢度驗一次）：
     ① 單據相片「直上 Drive」嘅 uploadPhotos 漏咗喺代理白名單 → 代理回 400
        → finance.js 跌返落「本地存做後備」→ 每張相以 base64 寫入 db
        → 資料庫脹大過 4.5MB
     ② Vercel 代理單一回應上限 4.5MB → loadDb 回 500 純文字
        → 前端當「唔係 JSON」→ 誤判「呢個部署冇 /api」→ 跌落自助路線
        → 對用家講「未設定後端網址」（明明後端登記得好哋）
     ③ 每部機讀唔到後端 → 各自儲存自己嗰份 → 兩邊永遠對唔到料
   ============================================================ */
section('v2.6.0：大資料庫分段讀取（兩邊視窗對得到料）');
{
  /* ---- ① 代理白名單：uploadPhotos／loadDbPart 一定要放行 ---- */
  const calls = [];
  const memFetch0 = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ target: String(target), action: body?.action });
    if (body?.action === 'uploadPhotos') {
      return { status: 200, async text() { return JSON.stringify({ ok: true, links: ['https://drive.google.com/x'], saved: 1 }); } };
    }
    return { status: 200, async text() { return JSON.stringify({ ok: true, success: true, part: '{}', parts: 1, partIdx: 0, bytes: 2 }); } };
  };
  process.env.TROOP_TEST9_BACKEND = GAS;
  process.env.TROOP_TEST9_APIKEY = 'test9_secret_key';
  const callProxy = async (payload) => { const res = mockRes(); await proxyHandler({ method: 'POST', body: payload }, res); return res; };

  const upRes = await callProxy({ action: 'uploadPhotos', unit: 'TEST9', payload: { id: 'c1', photos: [{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAA' }] } });
  ok('★ 代理放行 uploadPhotos（單據相片直上 Drive）—— 唔會再回「不支援的操作」',
    upRes.statusCode === 200 && upRes.body?.ok === true, JSON.stringify(upRes.body).slice(0, 160));
  ok('uploadPhotos 真係轉發咗去旅團後端', calls.some(c => c.action === 'uploadPhotos'), JSON.stringify(calls.map(c => c.action)));

  const lpRes = await callProxy({ action: 'loadDbPart', unit: 'TEST9', partIdx: 0 });
  ok('★ 代理放行 loadDbPart（分段讀取）',
    lpRes.statusCode === 200 && lpRes.body?.ok === true, JSON.stringify(lpRes.body).slice(0, 160));

  const badRes = await callProxy({ action: 'definitely_not_an_action', unit: 'TEST9' });
  ok('白名單以外嘅 action 照樣擋住（冇因為今次放寬咗安全性）',
    badRes.statusCode === 400 && /不支援的操作/.test(String(badRes.body?.error || '')));
  globalThis.fetch = memFetch0;

  /* ---- ② 前端：分段讀返成份資料庫 ---- */
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:8080/', pretendToBeVisual: true });
  const { window } = dom;
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* 唯讀 */ }
  }
  globalThis.window = window;

  /* 一份 5MB 嘅資料庫（大過 Vercel 4.5MB 回應上限） */
  const bigDb = { schema: 2, unitCode: '0082', members: [{ id: 'm1', name: '陳大文' }], blob: 'z'.repeat(5_000_000) };
  const bigText = JSON.stringify(bigDb);
  const PART = 1_000_000;
  const VERSION = '2026-09-20T00:00:00.000Z-12345';

  const store = await import('../assets/js/lib/store.js?seg=1');
  await store.init({ mode: 'real', unit: '0082' });

  let asked = [];
  let mode = 'segmented';        // 'segmented' | 'loadDb_too_large' | 'old_backend' | 'drift'
  let driftOnce = false;
  const memFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean !== 'api/proxy') return { ok: false, status: 404, text: async () => '404' };
    const body = JSON.parse(init.body || '{}');
    asked.push(body.action + (body.partIdx !== undefined ? ':' + body.partIdx : ''));

    if (mode === 'loadDb_too_large' && body.action === 'loadDb') {
      /* Vercel 爆咗 4.5MB：HTTP 500 ＋ 純文字（唔係 JSON） */
      return { ok: false, status: 500, text: async () => 'FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE' };
    }
    if (mode === 'old_backend') {
      if (body.action === 'loadDbPart') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: '未知 action：loadDbPart', hint: '支援 action: ping / loadDb' }) };
      }
    }
    if (body.action === 'dbInfo') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, bytes: bigText.length, version: VERSION }) };
    }
    if (body.action === 'loadDb') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, db: bigDb, bytes: bigText.length, version: VERSION }) };
    }
    if (body.action === 'loadDbPart') {
      const idx = Number(body.partIdx) || 0;
      const parts = Math.ceil(bigText.length / PART);
      /* 讀到一半有人儲存咗 → version 變（前端要由頭再讀） */
      const ver = (mode === 'drift' && !driftOnce && idx === 1) ? 'OTHER-VERSION' : VERSION;
      if (mode === 'drift' && idx === 1 && !driftOnce) { driftOnce = true; }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          ok: true, found: true, part: bigText.slice(idx * PART, (idx + 1) * PART),
          partIdx: idx, parts, bytes: bigText.length, version: ver, at: '2026-09-20T00:00:00.000Z'
        })
      };
    }
    return { ok: false, status: 400, text: async () => JSON.stringify({ ok: false, error: '不支援的操作' }) };
  };

  const remote = await import('../assets/js/lib/remote.js?seg=1');

  ok('remote.js 有分段讀取（pullDbSegmented）', typeof remote.pullDbSegmented === 'function');
  ok('remote.js 有「大過幾多就分段」嘅水位（SEGMENT_ABOVE_BYTES < 4.5MB）',
    Number(remote.SEGMENT_ABOVE_BYTES) > 0 && Number(remote.SEGMENT_ABOVE_BYTES) < 4.5 * 1024 * 1024,
    String(remote.SEGMENT_ABOVE_BYTES));

  /* 已知太大 → 直接分段（唔好白撞一次 4.5MB） */
  asked = [];
  const seg = await remote.pullDb({ bytes: bigText.length });
  ok('★ 已知資料庫 5MB → 直接分段讀返完整資料',
    seg.ok === true && seg.found === true && seg.db?.blob?.length === 5_000_000, JSON.stringify({ ok: seg.ok, err: seg.error }).slice(0, 160));
  ok('分段讀返嘅 version 同後端一致', seg.version === VERSION, String(seg.version));
  ok('真係逐段讀（唔係一次過）', asked.filter(a => a.startsWith('loadDbPart')).length > 1, asked.join(','));
  ok('知道太大嗰陣唔會白撞一次 loadDb', !asked.includes('loadDb'), asked.join(','));
  ok('分段讀返嘅內容 parse 得到、同原裝一樣',
    JSON.stringify(seg.db?.members) === JSON.stringify(bigDb.members));

  /* 未知體積 → 先試 loadDb；Vercel 爆咗 → 自動退去分段 */
  mode = 'loadDb_too_large'; asked = [];
  const fb = await remote.pullDb();
  ok('★ loadDb 撞 4.5MB 上限（500 純文字）→ 自動退去分段讀返',
    fb.ok === true && fb.db?.blob?.length === 5_000_000, JSON.stringify({ ok: fb.ok, err: fb.error }).slice(0, 160));
  ok('退去分段之前真係試過 loadDb', asked[0] === 'loadDb', asked.join(','));
  ok('★ 呢種情況**唔會**講「未設定後端網址」',
    !/未設定後端/.test(String(fb.error || '')) && !/未設定後端/.test(String(fb.hint || '')),
    String(fb.error || fb.hint || ''));

  /* 讀緊嗰陣有人儲存咗（version 變）→ 由頭再讀，唔會拼出半新半舊 */
  mode = 'drift'; driftOnce = false; asked = [];
  const dr = await remote.pullDb({ bytes: bigText.length });
  ok('★ 讀緊嗰陣撞正有人儲存 → 由頭再讀，結果仍然完整',
    dr.ok === true && dr.db?.blob?.length === 5_000_000, JSON.stringify({ ok: dr.ok, err: dr.error }).slice(0, 160));
  ok('真係由頭再讀過（partIdx:0 出現多過一次）',
    asked.filter(a => a === 'loadDbPart:0').length >= 2, asked.join(','));

  /* 舊版後端（未部署 v2.6.0）→ 要如實話「去更新 Apps Script」，唔好扮冇後端 */
  mode = 'old_backend';
  const old = await remote.pullDb({ bytes: bigText.length });
  ok('★ 舊版後端冇 loadDbPart → 如實報錯', old.ok === false, JSON.stringify(old).slice(0, 160));
  ok('提示教人更新 Apps Script（唔係「未設定後端網址」）',
    /Code\.gs|Apps Script|v2\.6\.0/.test(String(old.hint || '')) && !/未設定後端/.test(String(old.hint || '')),
    String(old.hint || '').slice(0, 120));

  /* gateway：回應過大要認得出，唔好當「後端壞」或者「未設定」 */
  const gw = await import('../assets/js/lib/gateway.js?seg=1');
  ok('gateway 認得出 Vercel「回應過大」呢種純文字錯誤',
    gw.PAYLOAD_TOO_LARGE_RE.test('FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE'));
  mode = 'loadDb_too_large';
  const routed = await gw.postBackend({ action: 'loadDb' }, { unit: '0082', execUrl: '', timeoutMs: 5000 });
  ok('★ 回應過大 → reason=too_large（唔會跌落自助路線變「未設定後端網址」）',
    routed.reason === 'too_large' && routed.tooLarge === true && routed.via === 'proxy',
    JSON.stringify({ reason: routed.reason, via: routed.via, error: String(routed.error).slice(0, 60) }));
  ok('回應過大嘅錯誤訊息講得出 4.5MB 同分段讀',
    /4\.5MB/.test(String(routed.error || '')) && /分段/.test(String(routed.error || '')),
    String(routed.error || '').slice(0, 100));

  /* dev-server 要喺本機模擬同一個上限（以後本機先發現到） */
  const devSrc = fs.readFileSync(path.join(ROOT, 'dev-server.mjs'), 'utf8');
  ok('dev-server 本機模擬 Vercel 4.5MB 回應上限',
    /VERCEL_RESPONSE_LIMIT/.test(devSrc) && /FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE/.test(devSrc));

  /* ---- ③ 「同步診斷」要有「整份資料庫讀取」呢一格 ----
     上面幾格全部 ok 都一樣可以讀唔返成份資料（登記好、連到、讀寫權正常，
     但資料庫大過 4.5MB）—— 用家見到「全部綠燈」却兩邊對唔到料，
     所以診斷一定要真係讀一次、話你知幾大、有冇行分段。 */
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url).split('?')[0];
    if (u.endsWith('api/units')) {
      return { ok: true, status: 200, json: async () => ({ units: {}, diag: { ids: ['0082'], trusted: ['0082'], withKey: ['0082'], suspicious: [] } }), text: async () => '{}' };
    }
    const clean = u.replace(/^\.?\//, '');
    if (clean !== 'api/proxy') return { ok: false, status: 404, text: async () => '404' };
    const body = JSON.parse(init.body || '{}');
    if (body.action === 'status') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, backendVersion: 'v2.6.0' }) };
    if (body.action === 'dbInfo') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, bytes: bigText.length, version: VERSION, counts: { members: 1 } }) };
    if (body.action === 'loadDb') return { ok: false, status: 500, text: async () => 'FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE' };
    if (body.action === 'loadDbPart') {
      const idx = Number(body.partIdx) || 0;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          ok: true, found: true, part: bigText.slice(idx * PART, (idx + 1) * PART),
          partIdx: idx, parts: Math.ceil(bigText.length / PART), bytes: bigText.length, version: VERSION, at: '2026-09-20T00:00:00.000Z'
        })
      };
    }
    return { ok: false, status: 400, text: async () => JSON.stringify({ ok: false, error: '不支援的操作' }) };
  };
  const diag = await remote.remoteDiagnose();
  const dbread = (diag.stages || []).find(s => s.id === 'dbread');
  ok('★ 「同步診斷」有「整份資料庫讀取」一格', !!dbread, (diag.stages || []).map(s => s.id).join(','));
  ok('呢格會講體積（幾多 MB）', /\d+\.\d\d MB/.test(String(dbread?.detail || '')), String(dbread?.detail || ''));
  ok('呢格會話你知大過 Vercel 4.5MB 回應上限',
    /4\.5MB/.test(String(dbread?.detail || '')), String(dbread?.detail || ''));
  ok('呢格會話你知有冇行分段讀取', /分段/.test(String(dbread?.detail || '')), String(dbread?.detail || ''));
  ok('★ 5MB 資料庫：登記／連線／讀寫權全綠都唔會呃人「冇後端」',
    (diag.stages || []).filter(s => ['unit', 'registry', 'status', 'write'].includes(s.id)).every(s => s.state === 'ok'),
    (diag.stages || []).map(s => `${s.id}:${s.state}`).join(','));
  ok('分段讀返 → 呢格唔係 bad（資料讀得到，只係要提示瘦身）', dbread?.state !== 'bad', String(dbread?.state));

  globalThis.fetch = memFetch;
}

/* ============================================================
   ⑰ ★ 登入硬閘（2026-09-20 團長定案）
   ------------------------------------------------------------
   團長原話：「既然都同後端對咗帳戶密碼，點可能入去之後話冇連上後端，
   那剛才是登入那？」—— 答案係：根本冇對過。`login()` 係純本機比對，
   帳戶名單就算後端一個字都讀唔返都會有（store.js 一見 accounts 空就塞
   SEED_ACCOUNTS）。所以「登入成功」只代表「呢部機有一份帳戶名單」。
   而家：後端答唔到 → 一律唔准入主控頁。
   ============================================================ */
section('★ 登入硬閘：後端答唔到就唔准入主控頁');
{
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:8080/?u=0082', pretendToBeVisual: true });
  const { window } = dom;
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* 唯讀 */ }
  }
  globalThis.window = window;

  const store2 = await import('../assets/js/lib/store.js?gate=1');
  await store2.init({ mode: 'real', unit: '0082' });
  const remote2 = await import('../assets/js/lib/remote.js?gate=1');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'main.js'), 'utf8');

  ok('remote.js 有 requireBackendForLogin（登入硬閘）', typeof remote2.requireBackendForLogin === 'function');

  let hits = [];
  const memFetch2 = globalThis.fetch;
  let mode = 'ok';
  globalThis.fetch = async (url, init = {}) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean !== 'api/proxy') return { ok: false, status: 404, text: async () => '404' };
    const body = JSON.parse(init.body || '{}');
    hits.push(body.action);
    if (mode === 'down') return { ok: false, status: 500, text: async () => 'FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE' };
    if (body.action === 'dbInfo') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, bytes: 200, version: 'V-GATE' }) };
    }
    if (body.action === 'loadDb') {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          ok: true, found: true, version: 'V-GATE', at: '2026-09-20T00:00:00.000Z', bytes: 200,
          db: { schema: 2, unitCode: '0082', members: [], transactions: [], accounts: [{ id: 'a1', username: 'chan@example.com', email: 'chan@example.com', role: 'leader', name: '陳領袖', memberId: 'm1' }] }
        })
      };
    }
    return { ok: false, status: 400, text: async () => JSON.stringify({ ok: false, error: '不支援的操作' }) };
  };

  /* 後端正常 → 准登入，而且要回返後端嘅版本／帳戶數 */
  hits = []; mode = 'ok';
  const g1 = await remote2.requireBackendForLogin();
  ok('★ 後端答得到 → 准登入', g1.ok === true, JSON.stringify(g1).slice(0, 160));
  ok('准登入嗰陣回返後端版本（界面可以顯示「同後端 v… 核對過」）', g1.version === 'V-GATE', String(g1.version));
  ok('准登入嗰陣回返帳戶數（後端讀返嚟嘅，唔係種子）', Number(g1.accounts) >= 1, String(g1.accounts));
  ok('後端有資料庫 → empty:false', g1.empty === false);
  ok('真係打咗後端（唔係淨係睇本機）', hits.length > 0, hits.join(','));

  /* ★ 最關鍵：本機有未存改動都唔可以「唔使問後端就放行」 */
  const dbG = store2.load();
  dbG.members = [{ id: 'zx', name: '未存嘅團員' }];
  dbG.sync = { ...(dbG.sync || {}), pending: 3 };
  store2.commitMeta?.();
  hits = []; mode = 'down';
  const g2 = await remote2.requireBackendForLogin();
  ok('★ 後端答唔到 → 唔准登入（唔會因為「本機有未存改動」就放行）',
    g2.ok === false, JSON.stringify(g2).slice(0, 200));
  ok('★ 呢種情況**唔會**講「未設定後端網址」（後端明明有登記）',
    !/未設定後端/.test(String(g2.error || '')) && g2.reason !== 'not_configured',
    `${g2.reason} / ${String(g2.error || '').slice(0, 80)}`);
  ok('封鎖原因如實講出後端嘅問題（唔係含糊嘅「同步失敗」）',
    String(g2.error || '').length > 10, String(g2.error || '').slice(0, 100));
  ok('★ main.js 會喺原因前面加「登入已封鎖」（用家唔會以為係密碼錯）',
    /function gateMessage/.test(mainSrc) && /登入已封鎖/.test(mainSrc));

  /* 真係未設定後端（冇 proxy 又冇 /exec）→ 明確講「未有後端設定」，唔好扮「密碼錯」 */
  mode = 'ok';
  const notCfg = await (async () => {
    const memF = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '<h1>404</h1>' });
    const r = await remote2.requireBackendForLogin();
    globalThis.fetch = memF;
    return r;
  })();
  ok('純靜態部署（冇 /api）→ reason=not_configured，提示教人點接線',
    notCfg.ok === false && /後端設定|TROOP_|\/exec/.test(String(notCfg.error || '') + String(notCfg.hint || '')),
    JSON.stringify(notCfg).slice(0, 200));

  globalThis.fetch = memFetch2;

  /* main.js 真係把硬閘接咗入兩個登入表單 */
  ok('★ main.js 登入表單有行硬閘（一個入口，唔再分領袖／執委門）', /gateLoginOnBackend\(\)/.test(mainSrc)
    && (mainSrc.match(/gateLoginOnBackend\(\)/g) || []).length >= 2,
    'count=' + (mainSrc.match(/gateLoginOnBackend\(\)/g) || []).length);
  ok('★ 硬閘失敗會 return（唔會繼續行 login()）',
    /if \(!gate\.ok\) \{[\s\S]{0,400}?return;/.test(mainSrc));
  ok('★ 舊嗰條「連唔到都照登入」嘅 freshenBeforeLogin 已經冇咗（淨低嘅只係歷史註解）',
    !/freshenBeforeLogin/.test(stripComments(mainSrc)));
  ok('登入頁橫額講明「登入已封鎖」（唔係淨係警告）',
    /登入已封鎖/.test(mainSrc));
  ok('登入頁會顯示帳戶來源（答團長「咁啱先係登入咗乜」）',
    /帳戶來源/.test(mainSrc));
  {
    /* 要由**函數定義**嗰行開始切 —— 檔頭註解早過 ensureFresh 就提過
       requireBackendForLogin，用 indexOf 會切錯位（連 ensureFresh 個定義一齊包埋）。 */
    const rSrc = stripComments(fs.readFileSync(path.join(ROOT, 'assets/js/lib/remote.js'), 'utf8'));
    const from = rSrc.indexOf('export async function requireBackendForLogin(');
    ok('硬閘唔會用 ensureFresh（佢喺有 pending 嗰陣會唔使問後端就回 ok）',
      from > 0 && !/ensureFresh\(/.test(rSrc.slice(from)), 'from=' + from);
  }
}

section('★ 搶救三寶（前端契約：後端讀唔到 → 檢查 → 修復 → 用呢部機上載）');
{
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:8080/?u=0082', pretendToBeVisual: true });
  const { window } = dom;
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* 唯讀 */ }
  }
  globalThis.window = window;

  /* ⚠️ 一定要用**冇 query**嗰份（同 remote.js 內部 import 嘅係同一個 module instance）——
     用 `?rescue=1` 只會換到另一個 state 物件，remote 內部照樣睇住舊嗰個（2026-09-24 撞到）。 */
  const store3 = await import('../assets/js/lib/store.js');
  await store3.init({ mode: 'real', unit: '0082' });
  const remote3 = await import('../assets/js/lib/remote.js');
  const mainSrc3 = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'main.js'), 'utf8');
  const tablesSrc3 = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'views', 'tables.js'), 'utf8');
  const proxSrc3 = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');

  /* 本機有一份資料（＝「留住資料嗰部機」）——屋企名冊 2 位 */
  const local3 = store3.load();
  local3.members = [
    { id: 'm1', name: '陳大文', ymis: '8202000001', identity: 'chief' },
    { id: 'm2', name: '李小美', ymis: '8202000002', identity: 'member' }
  ];
  store3.commit();

  let hits = [];
  let mode3 = 'broken';   // broken／healthy／down
  const memFetch3 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean !== 'api/proxy') return { ok: false, status: 404, text: async () => '404' };
    const body = JSON.parse(init.body || '{}');
    hits.push(body.action);
    if (mode3 === 'down') return { ok: false, status: 500, text: async () => 'FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE' };
    if (body.action === 'status') {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        ok: true, msg: '深資童軍管理系統 後端正常', backendVersion: 'v2.7.2', spreadsheet: 'VS 第八十二旅 資料庫' }) };
    }
    if (body.action === 'dbInfo') {
      const broken = mode3 === 'broken';
      return { ok: true, status: 200, text: async () => JSON.stringify({
        ok: true, found: true, bytes: 4096, version: 'V1', counts: { members: 2 },
        versions: broken ? 2 : 1, staleRows: broken ? 1 : 0, stagingRows: broken ? 3 : 0, stagingBytes: broken ? 12000 : 0 }) };
    }
    if (body.action === 'loadDb' || body.action === 'loadDbPart') {
      return mode3 === 'broken'
        ? { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'Unexpected token } in JSON' }) }
        : { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, version: 'V1', bytes: 2048, db: { schema: 2, unitCode: '0082', members: [{ id: 'm1', name: '陳大文' }] } }) };
    }
    if (body.action === 'repairDb') {
      mode3 = 'healthy';
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, repaired: {
        ok: true, unit: '0082', before: { versions: 2, stagingRows: 3, staleRows: 1 },
        removedStaging: 3, removedOldVersions: 1, keptVersions: 1, skippedUnits: [],
        after: { versions: 1, stagingRows: 0, staleRows: 0 }, loadOk: true, loadError: '', members: 2 } }) };
    }
    if (body.action === 'saveDbForce') {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        ok: true, success: true, forced: true, version: 'V-NEW', overwroteVersion: 'V1', bytes: 5120, chunks: 1 }) };
    }
    return { ok: false, status: 400, text: async () => JSON.stringify({ ok: false, error: '不支援的操作' }) };
  };

  /* ---- ① 壞後端：一睇就知發生咩事，而且有兩條救路 ---- */
  hits = []; mode3 = 'broken';
  const hBad = await remote3.backendHealth();
  ok('★ 檢查後端（壞後端 ＋ 本機有料）→ 判 bad', hBad.level === 'bad', JSON.stringify({ level: hBad.level, title: hBad.title }));
  ok('★ 講得出「讀唔到」＋ 有得救（唔係一句「同步失敗」）', /讀唔到/.test(hBad.title) && /修復/.test(hBad.title), hBad.title);
  ok('★ 講出邊支腳本／邊張 Sheet（答「係唔係指錯咗」）',
    hBad.lines.some(l => /第八十二旅/.test(l)) && hBad.lines.some(l => /v2\.7\.2/.test(l)), JSON.stringify(hBad.lines));
  ok('★ 講出死因：幾套版本段 ＋ 幾行暫存垃圾',
    hBad.lines.some(l => /2 套版本段/.test(l)) && hBad.lines.some(l => /3 行暫存垃圾/.test(l)), JSON.stringify(hBad.lines));
  ok('★ 有得修復（canRepair）＋ 可以用呢部機上載（canForce，本機有料）',
    hBad.canRepair === true && hBad.canForce === true && hBad.hasLocalData === true,
    JSON.stringify({ r: hBad.canRepair, f: hBad.canForce, l: hBad.hasLocalData }));
  ok('★ 步驟教人撳修復（唔使人自己入 Apps Script）',
    hBad.steps.some(x => /修復後端/.test(x)) && hBad.steps.some(x => /呢部機嘅資料上載/.test(x)), JSON.stringify(hBad.steps));
  ok('★ 檢查只係「睇」——冇偷偷寫後端（冇 saveDb／repairDb／saveDbForce）',
    hits.every(a => ['status', 'dbInfo', 'loadDb', 'loadDbPart'].includes(a)) && hits.includes('status') && hits.includes('dbInfo'),
    hits.join(','));

  /* ---- ② 一鍵修復（經 /api/proxy，後端 API Key 由代理注入） ---- */
  hits = [];
  const rep = await remote3.repairBackend();
  ok('★ 修復後端 → 打 repairDb（經同源代理）', hits.includes('repairDb'), hits.join(','));
  ok('★ 修復回報清走幾多行（垃圾 3 ＋ 舊段 1）＋ 之後讀得返',
    rep.ok === true && rep.removedStaging === 3 && rep.removedOldVersions === 1 && rep.loadOk === true && rep.members === 2,
    JSON.stringify(rep).slice(0, 200));
  ok('★ 修復文案係人話（唔係 JSON）', /清走暫存垃圾 3 行/.test(rep.text) && /2 位用戶/.test(rep.text), rep.text);

  /* ---- ③ 最後一招：用呢部機嘅資料強制覆蓋 ---- */
  hits = [];
  const forced = await remote3.forcePushBackend();
  ok('★ 強制上載 → 打 saveDbForce', hits.includes('saveDbForce'), hits.join(','));
  ok('★ 上載嘅係「呢部機」手上嗰份（本機 2 位，唔會空空如也）',
    forced.ok === true && forced.members === 2 && /2 位用戶/.test(forced.text), JSON.stringify(forced).slice(0, 200));
  ok('★ 回報覆蓋咗邊個舊版本（有事都追得返）',
    forced.overwroteVersion === 'V1' && forced.version === 'V-NEW', JSON.stringify(forced).slice(0, 160));

  /* ---- ③b 「讀得到但分頁有垃圾」→ 唔可以嚇人話「讀唔到」（要如實講「仲頂得住」） ---- */
  hits = []; mode3 = 'broken-junkonly';
  {
    /* 頭先修復完已經清乾淨，所以呢度砌返「讀得到 ＋ 有舊段」嘅實況 */
    const memF = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const clean = String(url).split('?')[0].replace(/^\.?\//, '');
      if (clean !== 'api/proxy') return { ok: false, status: 404, text: async () => '404' };
      const body = JSON.parse(init.body || '{}');
      hits.push(body.action);
      if (body.action === 'status') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, msg: '深資童軍管理系統 後端正常', backendVersion: 'v2.7.2', spreadsheet: 'VS 第八十二旅 資料庫' }) };
      if (body.action === 'dbInfo') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, bytes: 4096, version: 'V1', counts: { members: 2 }, versions: 2, staleRows: 1, stagingRows: 0 }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, found: true, version: 'V1', bytes: 2048, db: { schema: 2, unitCode: '0082', members: [{ id: 'm1', name: '陳大文' }] } }) };
    };
    const hJunk = await remote3.backendHealth();
    globalThis.fetch = memF;
    ok('★ 讀得到但分頁有舊段／垃圾 → 判 warn（唔會嚇人話「讀唔到」）',
      hJunk.level === 'warn' && /讀得到/.test(hJunk.title) && !/讀唔到|讀唔到（/.test(hJunk.title.replace('唔清遲早會讀唔到', '')),
      JSON.stringify({ level: hJunk.level, title: hJunk.title }));
    ok('★ 提醒仍然叫人修復（趁未壞）', hJunk.canRepair === true && hJunk.steps.some(x => /修復後端/.test(x)), JSON.stringify(hJunk.steps));
  }

  /* ---- ④ 後端健康 → 唔應該叫人多此一舉 ---- */
  hits = []; mode3 = 'healthy';
  const hOk = await remote3.backendHealth();
  ok('★ 健康後端 → 判 ok、標題講「資料喺後端，唔係困喺某部機」',
    hOk.level === 'ok' && /唔係困喺某部機/.test(hOk.title), JSON.stringify({ level: hOk.level, title: hOk.title }));
  ok('★ 健康時唔會亂叫（canRepair／canForce 都 false）', hOk.canRepair === false && hOk.canForce === false,
    JSON.stringify({ r: hOk.canRepair, f: hOk.canForce }));
  ok('★ 健康時教「其他裝置係舊 cache，重新連線就得」',
    hOk.steps.some(x => /cache|重新/.test(x)), JSON.stringify(hOk.steps));

  /* ---- ⑤ 連唔到後端 ---- */
  hits = []; mode3 = 'down';
  const hDown = await remote3.backendHealth();
  ok('★ 連唔到後端 → 如實講「連唔到」＋教查部署權限（唔會扮正常）',
    hDown.level === 'bad' && /連唔到/.test(hDown.title) && hDown.steps.some(x => /部署|存取權/.test(x)),
    JSON.stringify({ t: hDown.title, s: hDown.steps }));

  /* ---- ⑥ 破壞性動作要有人肯撳、而且要打字確認（介面守門） ---- */
  ok('★ 登入閘有三粒掣：檢查／修復／上載',
    ['#btnBackendHealth', '#btnBackendRepair', '#btnBackendUpload'].every(id => mainSrc3.includes(id)));
  ok('★ 上載要打字確認（打「上載」兩個字）先做得',
    /上載/.test(mainSrc3) && /typeConfirm|打字|確認/.test(mainSrc3) && /runBackendUpload/.test(mainSrc3));
  ok('★ 「儲存狀態」卡都有同一組搶救掣（唔使特登去登入閘）',
    /backend-health/.test(tablesSrc3) && /backend-repair/.test(tablesSrc3) && /backend-upload/.test(tablesSrc3));
  ok('★ 代理白名單放行三個新動作（舊 action 一個都冇拆）',
    /'repairDb'/.test(proxSrc3) && /'saveDbForce'/.test(proxSrc3) && /'diag'/.test(proxSrc3));

  globalThis.fetch = memFetch3;
}

console.log(`\n──────── 後端儲存測試結果：${pass} 通過 / ${fail} 失敗（${Date.now() - t0} ms）────────\n`);
process.exit(fail ? 1 : 0);
