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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const KEY = 'v82_e2e_real_key';
const UNIT = '0082';

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
    /* v2.6.2 起 dbInfo 會報「舊版留低嘅暫存垃圾行」（app 嘅同步診斷靠佢） */
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
  TROOP_0082_APIKEY: KEY
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
  ok('★ 真係行咗分件（parts > 0，唔係靜靜地退返單件）', Number(p.parts || 0) > 0, JSON.stringify(p).slice(0, 200));

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
   ⑤ 「同步診斷」喺成條鏈正常時一定要全綠
   ============================================================ */
section('⑤ 同步診斷：正常鏈應該全綠（唔好成日話人設定錯）');
{
  const F = await runDevice({ steps: [{ op: 'load' }, { op: 'diagnose' }] });
  const d = step(F, 'diagnose');
  ok('診斷結論 ok', d.ok === true, JSON.stringify(d).slice(0, 400));
  ok('診斷冇 blocker', (d.blockers || []).length === 0, JSON.stringify(d.blockers));
  ok('診斷行緊平台代理（同正式站一樣）', d.route === 'proxy', String(d.route));
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
  ok('★★ 三次分件儲存之後冇留低暫存垃圾行', junk.length === 0, `${junk.length} 行垃圾`);
  const truth = await backendTruth();
  const expected = Math.ceil(truth.bytes / 45000) + 1;   // +1 = 標題列
  ok(`「資料庫」分頁行數 ＝ 正式段數（${after.length} 行，應該係 ${expected}）`,
    after.length === expected, `actual=${after.length} expected=${expected} bytes=${truth.bytes}`);
  ok('分頁冇比開頭脹大（舊版每存一次就多留一份資料庫）',
    after.length <= before.length + 40, `${before.length} → ${after.length}`);
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

console.log(`\n${fail ? '❌' : '✅'} 端到端（真 Code.gs）：${pass} 過 / ${fail} 唔過（${Date.now() - START}ms）`);
process.exit(fail ? 1 : 0);
