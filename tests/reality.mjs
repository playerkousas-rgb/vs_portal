/* ============================================================
   tests/reality.mjs — 「後端實況」：答團長嗰條問題
   ------------------------------------------------------------
   團長 2026-09-24：
     「最大的問題還是我的資料同步不到，我完全不知道他能不能寫進後端，
       要是能寫進為什麼讀不到。」

   呢個測試釘死兩件嘢（全部行真實 HTTP ＋ 假 GAS）：

     ① verifyAgainstBackend(v) 只讀核對，要分得出三種狀態：
         · 改咗嘢但未撳掣  → 對唔上（後端係空／筆數唔夾）
         · 撳咗掣          → matched = true，每表笔數同本機一樣
         · 後端連唔到／Key 錯 → ok = false，講到出原因同修復提示

     ② 第二部機（全新本機環境）由後端載入之後，會見到同一份資料。

   2026-11-12 重整：原本仲驗 backendReality()（人話結論）同 syncProbe()
   （寫記號一寫一讀）。兩個前端函數喺 2026-09-26 拆 UI 之後已經冇人呼叫，
   所以連函數一齊刪走。呢個 suite 改用仍然 live 嘅 verifyAgainstBackend()
   （syncdialog.js 用緊）去答同一條問題，覆蓋唔會薄咗：
   「寫唔寫得入」由 syncNow ＋ matched 驗，「讀唔讀得返」由第二部機 load 驗。

   用法：node tests/reality.mjs
   ============================================================ */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? `  → ${extra}` : '')); }
}
function section(t) { console.log('\n▌' + t); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const waitPort = async (port, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const up = await new Promise(r => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (up) return true;
    await wait(120);
  }
  return false;
};

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

const runDevice = (plan, url = BASE) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), url, JSON.stringify(plan)],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; });
  p.stderr.on('data', d => { err += d; });
  const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（90 秒）' }), 90000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});

const stepOf = (r, op, nth = 0) => (r?.steps || []).filter(s => s.op === op)[nth] || {};

try {
  spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)], {
    /* 要驗 API Key —— 先至測到「status 通、但讀寫被拒」呢個真實死因 */
    FAKEGAS_APIKEY: 'test_key_0082'
  });
  spawnBg([path.join(ROOT, 'dev-server.mjs')], {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_0082',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT),
    SUPER_KEY: 'super_secret_test'
  });
  ok('測試用假後端＋dev-server 已啟動', (await waitPort(GAS_PORT)) && (await waitPort(WEB_PORT)));

  /* ============================================================
     機 A：由零開始 → 開三個人 → 未撳掣（後端應該對唔上）→ 撳掣 → 對得上
     ============================================================ */
  section('機 A：開咗人但未撳掣 —— 核對要話我知對唔上');
  const A = await runDevice({ steps: [
    { op: 'wipe' },
    { op: 'load' },                                    // 開機先由後端載入（＝基準），後端而家係空
    { op: 'addMember', name: '陳大文', ymis: '2026000001' },
    { op: 'addMember', name: '李小龍', ymis: '2026000002' },
    { op: 'addMember', name: '王小明', ymis: '2026000003' },
    { op: 'verify', version: '__none__' },             // ← 未撳掣（冇寫入版本可對）
    { op: 'syncNow' },                                 // ← 撳頂部「儲存到後端」
    { op: 'verify' }                                   // ← 撳完即刻核對
  ] });
  ok('機 A 全程冇爆', A.ok === true, A.error || '');

  const before = stepOf(A, 'verify', 0);
  console.log('  · 未撳掣嘅核對：' + JSON.stringify(before).slice(0, 400));
  ok('★ 核對連到後端（ok）', before.ok === true, JSON.stringify(before));
  ok('★ 未撳掣 → 對唔上（matched = false）', before.matched === false,
    `matched=${before.matched}`);
  ok('★ 未撳掣 → 後端係空（found = false），對數表把後端顯示做「冇資料」',
    before.found === false
    && (before.local?.members || 0) === 3
    && (before.rows || []).find(r => r.key === 'members')?.backend === null,
    JSON.stringify(before.rows));

  const pushed = stepOf(A, 'syncNow');
  ok('撳「儲存到後端」成功', pushed.ok === true && pushed.pushed === true, JSON.stringify(pushed));

  const vf = stepOf(A, 'verify', 1);
  console.log('  · 撳完掣嘅核對：' + JSON.stringify(vf).slice(0, 400));
  ok('★ 撳完掣：核對成功（matched）', vf.matched === true, JSON.stringify(vf));
  ok('★ 核對到版本（後端版本 ＝ 寫入嗰陣後端畀嘅版本）',
    !!vf.version && vf.version === vf.expectedVersion && vf.versionOk === true,
    `version=${vf.version} expected=${vf.expectedVersion}`);
  ok('★ 核對到筆數（後端 3 位用戶 ＝ 本機 3 位）',
    vf.countsOk === true && (vf.rows || []).find(r => r.key === 'members')?.backend === 3,
    JSON.stringify(vf.rows));
  ok('★ 每表都對得上（本機 ＝ 後端）',
    (vf.rows || []).length > 0 && vf.rows.every(r => r.same !== false),
    JSON.stringify(vf.rows));

  /* ============================================================
     ② 第二部機：全新本機環境，由後端載入 → 見到同一份
     ============================================================ */
  section('第二部機：由後端載入之後要見到同一份資料');
  const B = await runDevice({ steps: [
    { op: 'wipe' },
    { op: 'load' },                 // 由後端載入（機 A 已經寫咗 3 個人）
    { op: 'verify' }
  ] });
  ok('機 B 全程冇爆', B.ok === true, B.error || '');
  const bLoad = stepOf(B, 'load');
  const bVerify = stepOf(B, 'verify');
  console.log('  · 第二部機核對：' + JSON.stringify(bVerify).slice(0, 400));
  ok('★ 第二部機讀得返後端資料（3 位用戶）',
    (bVerify.local?.members || 0) === 3, JSON.stringify({ load: bLoad, local: bVerify.local }));
  ok('★ 第二部機同後端對得上（matched）', bVerify.matched === true, JSON.stringify(bVerify));

  /* ============================================================
     ③ Key 唔啱：要拒絕，而且唔可以盲寫
     ============================================================ */
  section('本機過期 Key 不影響代理；伺服器端 Key 錯誤才拒絕');
  const C = await runDevice({ steps: [{ op: 'load' }, { op: 'verify' }], badKey: true });
  ok('★ 本機過期 Key 不阻止代理用伺服器 Key 讀取', stepOf(C, 'verify').ok === true);

  const badPort = await freePort();
  spawnBg([path.join(ROOT, 'dev-server.mjs')], {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'wrong_server_key',
    V82_PROXY_TEST: '1', PORT: String(badPort)
  });
  ok('錯誤伺服器 Key 測試代理啟動', await waitPort(badPort));
  const D = await runDevice({ steps: [{ op: 'verify' }, { op: 'syncNow' }] }, `http://127.0.0.1:${badPort}`);
  const cVerify = stepOf(D, 'verify');
  ok('★ 伺服器端 Key 不符時讀寫被拒', cVerify.ok === false, JSON.stringify(cVerify).slice(0, 300));
  ok('★ 講得出原因（唔係靜靜失敗）', !!cVerify.error, cVerify.error);
  ok('★ 顯示修復提示', !!cVerify.hint, cVerify.hint);
  ok('★ 伺服器端 Key 錯誤時儲存不會盲寫', stepOf(D, 'syncNow').ok === false);

  console.log(`\n──────── 後端實況測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('測試爆咗：', e);
  process.exitCode = 1;
} finally {
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
}
