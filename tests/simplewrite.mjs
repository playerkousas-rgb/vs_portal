/* ============================================================
   tests/simplewrite.mjs — ★ v2.8.0「簡單寫入」（逐表寫／逐表讀）
   ------------------------------------------------------------
   團長 2026-09-24／25 回報：「我完全唔知佢寫唔寫得入後端；寫得入又點解讀唔到。」
   診斷結果：條鏈全部正常（連到 v2.7.2、API Key 過到），但兩部機嘅
   「後端版本」都係**空** —— 即係成份資料庫從來冇成功落到後端。

   根因係舊寫入路太「一鋪過」：
     成份 db → 一條大 JSON → 每段 45000 字 → 先刪晒舊段 → 再寫晒新段
     → 對版本（樂觀鎖）→ 再重刷全部報表分頁。
   任何一格出事（GAS 執行時間／代理 4MB／版本對唔上／寫到一半斷），
   結果都係同一個：**成份資料庫讀唔到**。

   VSBADGE（同一個團用緊、一路冇事）嘅做法係「一個請求淨係寫一個表嗰幾行」。
   呢個測試就係驗證照抄呢個思路之後：
     ① 寫入真係落到後端（另一部機讀得返同一份）
     ② 只寫「有改過」嗰幾個表（冇改嘅表一行都唔會掂）
     ③ 某個表壞咗 → 淨係唔要嗰個表，其餘照讀（唔會成份讀唔到）
     ④ 後端仲係舊版（唔識 saveTables）→ 自動跌返舊路，唔會斷
   用法：node tests/simplewrite.mjs
   ============================================================ */

import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const waitPort = async (port, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
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

/** 直接問假後端（測試專用 action：__simpleRows／__corrupt） */
async function gas(gasPort, body) {
  const r = await fetch(`http://127.0.0.1:${gasPort}/exec`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ apiKey: 'test_key_0082', ...body })
  });
  return r.json().catch(() => ({}));
}

/** 起一套「假後端 ＋ dev-server」，回 { base, gasPort, stop } */
async function bootStack({ noSimple = false } = {}) {
  const gasPort = await freePort();
  const webPort = await freePort();
  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    return p;
  };
  spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(gasPort)],
    { FAKEGAS_APIKEY: 'test_key_0082', ...(noSimple ? { FAKEGAS_NO_SIMPLE: '1' } : {}) });
  spawnBg([path.join(ROOT, 'dev-server.mjs')], {
    TROOP_0082_BACKEND: `http://127.0.0.1:${gasPort}/exec`,
    TROOP_0082_APIKEY: 'test_key_0082',
    V82_PROXY_TEST: '1',
    PORT: String(webPort)
  });
  const up = (await waitPort(gasPort)) && (await waitPort(webPort));
  const stop = () => procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  return { base: `http://127.0.0.1:${webPort}`, gasPort, up, stop };
}

/** 行一個「裝置」（全新 process ＝ 全新 localStorage ＝ 真正嘅另一部機） */
function runDevice(base, plan, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), base, JSON.stringify(plan)],
      { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { err += d; });
    const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
    const guard = setTimeout(() => done({ ok: false, error: '裝置逾時' }), timeoutMs);
    p.on('close', () => {
      clearTimeout(guard);
      const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
      if (!m) return resolve({ ok: false, error: (err || buf).slice(-800) });
      try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
    });
  });
}

const stepOf = (r, op) => (r?.steps || []).find(s => s.op === op) || null;
const tmpFile = () => path.join(os.tmpdir(), `v82-sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

/* ============================================================
   ① 新後端（v2.8.0）：逐表寫 → 另一部機讀得返
   ============================================================ */
section('① 寫入真係落到後端（另一部機讀得返同一份）');
const stack = await bootStack({});
ok('假後端（v2.8.0）＋ dev-server 已啟動', stack.up === true);

try {
  /* ---- 裝置 A：開機（後端空）→ 加 2 個團員 ＋ 1 筆帳 → 撳儲存 ---- */
  const A = await runDevice(stack.base, { steps: [
    { op: 'load' },
    { op: 'wipe' },
    { op: 'addMember', name: '陳大文', ymis: '2026000001' },
    { op: 'addMember', name: '李四', ymis: '2026000002' },
    { op: 'addTx', date: '2026-09-25', type: 'income', item: '團費', amount: 360 },
    { op: 'push' },
    { op: 'backendKeys' }
  ] });
  ok('裝置 A 開得機', A.ok === true, (A.error || '').slice(0, 200));
  const pushA = stepOf(A, 'push');
  ok('★ 撳「儲存到後端」成功', pushA?.ok === true, JSON.stringify(pushA).slice(0, 240));
  ok('★ 行嘅係新嘅「逐表寫」（唔係舊嘅整份 blob）', pushA?.mode === 'simple', JSON.stringify({ mode: pushA?.mode }));
  ok('★ 寫入後 pending 清零（介面顯示「已存到後端」）', pushA?.pending === 0, String(pushA?.pending));

  const keysA = stepOf(A, 'backendKeys');
  ok('★ 後端真係收到嘢（「資料表」分頁有料）', keysA?.ok === true && keysA?.via === 'simple',
    JSON.stringify({ ok: keysA?.ok, via: keysA?.via }));
  ok('★ 收到嘅內容有團員同帳目', (keysA?.keys || []).includes('members') && (keysA?.keys || []).includes('transactions'),
    JSON.stringify(keysA?.keys));
  ok('★ 連線設定（sync／backend／API Key）冇經 Sheet 傳出去',
    !(keysA?.keys || []).includes('sync') && !(keysA?.keys || []).includes('backend'),
    JSON.stringify(keysA?.keys));

  /* ---- 裝置 B：全新一部機（另一個 process、另一份 localStorage） ---- */
  const B = await runDevice(stack.base, { steps: [{ op: 'info' }, { op: 'simplePull' }] });
  const infoB = stepOf(B, 'info');
  ok('★ 第二部機問後端：有資料', infoB?.ok === true && infoB?.found === true, JSON.stringify(infoB));
  ok('★ 第二部機見到啱數（2 個團員、1 筆帳目）',
    infoB?.counts?.members === 2 && infoB?.counts?.transactions === 1, JSON.stringify(infoB?.counts));
  const pullB = stepOf(B, 'simplePull');
  ok('★ 第二部機讀得返成份資料（逐表讀）',
    pullB?.ok === true && pullB?.found === true && pullB?.mode === 'simple', JSON.stringify(pullB).slice(0, 240));
  ok('★ 讀返嚟嘅團員名同裝置 A 寫嘅一樣',
    (pullB?.names || []).includes('陳大文') && (pullB?.names || []).includes('李四'), JSON.stringify(pullB?.names));

  /* ============================================================
     ② 只寫「有改過」嗰幾個表
     ============================================================ */
  section('② 只寫改過嗰幾個表（冇改嘅表一行都唔會掂）');
  const rowsBefore = await gas(stack.gasPort, { action: '__simpleRows', unit: '0082' });
  ok('「資料表」分頁有嘢（攞到基線）', rowsBefore.ok === true && rowsBefore.total > 0, JSON.stringify(rowsBefore).slice(0, 200));
  const verTxBefore = rowsBefore.versions?.transactions || '';
  const verMemBefore = rowsBefore.versions?.members || '';
  ok('基線：members 同 transactions 各有自己嘅版本', !!verTxBefore && !!verMemBefore,
    JSON.stringify({ m: verMemBefore, t: verTxBefore }));

  /* 裝置 A 走開再返嚟（保留本機 db ＋ 基準）→ 淨係加一個團員 → 再儲存 */
  const keep = tmpFile();
  const A2 = await runDevice(stack.base, { steps: [
    { op: 'load' },
    { op: 'export', file: keep }
  ] });
  ok('裝置 A 狀態已存檔（模擬同一部機走開再返嚟）', stepOf(A2, 'export')?.members === 2, JSON.stringify(stepOf(A2, 'export')));

  const A3 = await runDevice(stack.base, { steps: [
    { op: 'import', file: keep },
    { op: 'addMember', name: '王五', ymis: '2026000003' },
    { op: 'push' }
  ] });
  const pushA3 = stepOf(A3, 'push');
  ok('★ 只改團員 → 儲存成功', pushA3?.ok === true, JSON.stringify(pushA3).slice(0, 240));
  ok('★ 呢次只係「有改過」嗰幾個表（唔係成份重寫）',
    pushA3?.mode === 'simple' && pushA3?.mine === 1, JSON.stringify({ mode: pushA3?.mode, mine: pushA3?.mine }));

  const rowsAfter = await gas(stack.gasPort, { action: '__simpleRows', unit: '0082' });
  ok('★ 帳目表冇被掂過（版本號同之前一樣）',
    rowsAfter.versions?.transactions === verTxBefore, JSON.stringify({ before: verTxBefore, after: rowsAfter.versions?.transactions }));
  ok('★ 團員表寫咗新版本', rowsAfter.versions?.members !== verMemBefore,
    JSON.stringify({ before: verMemBefore, after: rowsAfter.versions?.members }));
  ok('★ 「先寫新、後刪舊」冇留低重複行（行數同基線一樣）',
    rowsAfter.total === rowsBefore.total, JSON.stringify({ before: rowsBefore.total, after: rowsAfter.total }));

  const C = await runDevice(stack.base, { steps: [{ op: 'simplePull' }] });
  const pullC = stepOf(C, 'simplePull');
  ok('★ 第三部機讀到 3 個團員（新加嗰個有到）',
    pullC?.members === 3 && (pullC?.names || []).includes('王五'), JSON.stringify({ n: pullC?.members, names: pullC?.names }));
  ok('★ 帳目照舊讀得到（冇因為「只寫團員」而消失）', pullC?.transactions === 1, String(pullC?.transactions));

  /* ============================================================
     ③ 某個表壞咗 → 淨係唔要嗰個表（唔會成份讀唔到）
     ============================================================ */
  section('③ 一個表壞咗 → 其餘照讀（呢個先係同舊路線最大分別）');
  const cor = await gas(stack.gasPort, { action: '__corrupt', unit: '0082', table: 'transactions' });
  ok('已把「帳目」表弄壞（模擬寫到一半斷）', cor.ok === true && cor.corrupted >= 1, JSON.stringify(cor));

  const D = await runDevice(stack.base, { steps: [{ op: 'simplePull' }] });
  const pullD = stepOf(D, 'simplePull');
  ok('★ 壞咗一個表，成份資料庫照樣讀到（唔係「讀唔到」）',
    pullD?.ok === true && pullD?.found === true, JSON.stringify(pullD).slice(0, 240));
  ok('★ 團員一個唔少（3 個）', pullD?.members === 3, String(pullD?.members));
  ok('★ 如實報出邊個表壞咗（唔會靜靜地當冇事）',
    (pullD?.broken || []).includes('transactions'), JSON.stringify(pullD?.broken));

  /* 修返佢：裝置 A 再儲存一次帳目表就蓋返好嘅上去 */
  const A4 = await runDevice(stack.base, { steps: [
    { op: 'load' },
    { op: 'addTx', date: '2026-09-26', type: 'expense', item: '場地', amount: 800 },
    { op: 'push' }
  ] });
  ok('★ 再儲存一次就蓋返好嘅上去', stepOf(A4, 'push')?.ok === true, JSON.stringify(stepOf(A4, 'push')).slice(0, 200));
  const E = await runDevice(stack.base, { steps: [{ op: 'simplePull' }] });
  const pullE = stepOf(E, 'simplePull');
  /* 如實講：壞咗嗰套內容係**救唔返**嘅（後端讀唔到就係讀唔到）——
     但關鍵分別係：舊路線一壞就**成份資料庫**讀唔到（所有人乜都睇唔到），
     而家淨係嗰一個表要由「仲有資料嗰部機」或者 JSON 備份還原。 */
  ok('★ 帳目表重新寫得入、讀得返，冇表再壞', pullE?.transactions === 1 && (pullE?.broken || []).length === 0,
    JSON.stringify({ tx: pullE?.transactions, broken: pullE?.broken }));
  ok('★ 團員表完全冇受影響（壞帳目嗰陣都係 3 個）', pullE?.members === 3, String(pullE?.members));
} finally {
  stack.stop();
}

/* ============================================================
   ④ 後端仲係舊版（未更新 Code.gs）→ 自動跌返舊路，唔會斷
   ============================================================ */
section('④ 後端未升級（唔識 saveTables）→ 自動用返舊嘅整份寫入');
const old = await bootStack({ noSimple: true });
ok('假「舊後端」（v2.7.2，冇 simpleWrite）已啟動', old.up === true);
try {
  const O1 = await runDevice(old.base, { steps: [
    { op: 'load' },
    { op: 'wipe' },
    { op: 'addMember', name: '陳大文', ymis: '2026000001' },
    { op: 'push' },
    { op: 'backendKeys' }
  ] });
  const pushO = stepOf(O1, 'push');
  ok('★ 舊後端都儲存成功（自動跌返 saveDb）', pushO?.ok === true, JSON.stringify(pushO).slice(0, 240));
  ok('★ 行嘅係舊嘅整份寫入（mode 唔係 simple）', pushO?.mode !== 'simple', JSON.stringify({ mode: pushO?.mode }));
  /* 舊路線（saveDb）寫完「資料庫」之後會**鏡像**去「資料表」——
     因為讀取一律以「資料表」为先，唔鏡像嘅話兩邊就會各睇各嘅。
     所以呢度驗嘅係「兩邊都有」，而唔係「淨係舊分頁有」。 */
  const okKeys = stepOf(O1, 'backendKeys');
  ok('★ 資料真係落到後端（舊路線寫「資料庫」＋鏡像「資料表」，兩邊都有）',
    okKeys?.ok === true && (okKeys?.keys || []).includes('members'), JSON.stringify(okKeys?.keys));

  const O2 = await runDevice(old.base, { steps: [{ op: 'info' }, { op: 'simplePull' }] });
  ok('★ 舊後端：第二部機照樣讀得返', stepOf(O2, 'simplePull')?.members === 1,
    JSON.stringify(stepOf(O2, 'simplePull')).slice(0, 200));
  ok('★ 舊後端：dbInfo 報返啱數（1 個團員）', stepOf(O2, 'info')?.counts?.members === 1,
    JSON.stringify(stepOf(O2, 'info')?.counts));
} finally {
  old.stop();
}

/* ============================================================
   ⑤ 靜態守門：新 action 一定要喺代理白名單 ＋ Code.gs 識做
   ============================================================ */
section('⑤ 靜態守門（唔會重演「action 漏咗喺白名單」嗰單事故）');
{
  const proxSrc = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');
  const gasSrc = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const remoteSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'lib', 'remote.js'), 'utf8');
  ['saveTables', 'loadTables', 'loadTablesPart'].forEach(a => {
    ok(`★ 代理白名單放行 ${a}`, proxSrc.includes(`'${a}'`));
    ok(`★ Code.gs 真係識做 ${a}`, gasSrc.includes(`body.action === '${a}'`));
  });
  ok('★ Code.gs 有「資料表」分頁（同舊「資料庫」分頁分開，舊資料一行都唔會掂）',
    /var SIMPLE_TAB = '資料表'/.test(gasSrc) && /var DB_TAB = '資料庫'/.test(gasSrc));
  ok('★ 寫入次序係「先寫新、後刪舊」（中途斷都唔會乜都冇）',
    gasSrc.indexOf('① 先寫新') > 0 && gasSrc.indexOf('① 先寫新') < gasSrc.indexOf('② 後刪舊'));
  ok('★ 逐表寫冇用樂觀鎖（唔會再出現「版本對唔上 → 永遠存唔入」）',
    !/baseVersion/.test(gasSrc.slice(gasSrc.indexOf('function saveTables'), gasSrc.indexOf('function loadTables'))));
  /* 補底一定要**三份對稱**（基準／本機／後端），否則「後端有 []、基準連 key 都冇」
     會被當成一個改動 —— 三方比對就會無端端話「有人喺我之後改過嘢」。 */
  const storeSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'lib', 'store.js'), 'utf8');
  ok('★ 基準快照同後端回傳用同一套補底（COLLECTION_KEYS）',
    /export const COLLECTION_KEYS =/.test(storeSrc)
    && /return fillCollections\(_clone\(out\)\);/.test(storeSrc)
    && /const db = fillCollections\(_clone\(remoteDb \|\| \{\}\)\);/.test(storeSrc));
  ok('★ 第一次寫入一定寫齊所有表（唔會寫一份缺晒嘅 db 上後端）',
    /firstSimpleWrite/.test(remoteSrc) && /info\.mode/.test(remoteSrc));
  ok('★ 仍然得一個寫入口（頂部「儲存到後端」）—— 冇加自動寫入',
    !/debounce|setInterval\([^)]*saveToBackend|autoSave/i.test(remoteSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log(`\n──────── 簡單寫入測試結果：${pass} 通過 / ${fail} 失敗（${Date.now() - t0} ms）────────\n`);
process.exit(fail ? 1 : 0);
