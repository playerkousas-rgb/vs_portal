/* ============================================================
   tests/reality.mjs — 「後端實況」：答團長嗰條問題
   ------------------------------------------------------------
   團長 2026-09-24：
     「最大的問題還是我的資料同步不到，我完全不知道他能不能寫進後端，
       要是能寫進為什麼讀不到。」

   呢個測試釘死三件嘢（全部行真實 HTTP ＋ 假 GAS）：

     ① backendReality()（只讀）要分得出三種狀態：
         · 改咗嘢但未撳掣  →「要處理」＋ 逐表對數顯示後端少咗
         · 撳咗掣          →「對得上」＋ 每表都 ✓
         · 後端連唔到      →「斷咗」＋ 講到出原因

     ② verifyAgainstBackend(v) 撳完掣之後要核對到：
         版本 ＝ 後端啱啱畀嗰個、筆數同本機一樣 → matched = true

     ③ syncProbe() 一寫一讀：寫個記號 → 讀返出嚟對 nonce → 對得上，
         而且完咗要清走個記號（後端唔會留低垃圾）

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

const runDevice = (plan) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
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
  section('機 A：開咗人但未撳掣 —— 「後端實況」要話我知對唔上');
  const A = await runDevice({ steps: [
    { op: 'wipe' },
    { op: 'load' },                                    // 開機先由後端載入（＝基準），後端而家係空
    { op: 'addMember', name: '陳大文', ymis: '2026000001' },
    { op: 'addMember', name: '李小龍', ymis: '2026000002' },
    { op: 'addMember', name: '王小明', ymis: '2026000003' },
    { op: 'reality' },                                 // ← 未撳掣
    { op: 'syncNow' },                                 // ← 撳頂部「儲存到後端」
    { op: 'verify' },                                  // ← 撳完即刻核對
    { op: 'reality' }                                  // ← 撳完再睇實況
  ] });
  ok('機 A 全程冇爆', A.ok === true, A.error || '');

  const before = stepOf(A, 'reality', 0);
  console.log('  · 未撳掣嘅後端實況：' + JSON.stringify(before).slice(0, 400));
  ok('★ 後端實況連到後端（ok）', before.ok === true, JSON.stringify(before));
  ok('★ 未撳掣 → 結論係「要處理」（warn），唔係「對得上」',
    before.level === 'warn', `level=${before.level} title=${before.title}`);
  ok('★ 結論講明有幾多項未寫入', /未寫入/.test(before.title || ''), before.title);
  ok('★ 未撳掣 → 後端係空（found = false），對數表把後端顯示做「冇資料」',
    before.found === false
    && (before.local?.members || 0) === 3
    && (before.rows || []).find(r => r.key === 'members')?.backend === null,
    JSON.stringify(before.rows));

  const pushed = stepOf(A, 'syncNow');
  ok('撳「儲存到後端」成功', pushed.ok === true && pushed.pushed === true, JSON.stringify(pushed));

  const vf = stepOf(A, 'verify');
  console.log('  · 撳完掣嘅核對：' + JSON.stringify(vf).slice(0, 400));
  ok('★ 撳完掣：核對成功（matched）', vf.matched === true, JSON.stringify(vf));
  ok('★ 核對到版本（後端版本 ＝ 寫入嗰陣後端畀嘅版本）',
    !!vf.version && vf.version === vf.expectedVersion && vf.versionOk === true,
    `version=${vf.version} expected=${vf.expectedVersion}`);
  ok('★ 核對到筆數（後端 3 位用戶 ＝ 本機 3 位）',
    vf.countsOk === true && (vf.rows || []).find(r => r.key === 'members')?.backend === 3,
    JSON.stringify(vf.rows));

  const after = stepOf(A, 'reality', 1);
  console.log('  · 撳完掣嘅後端實況：' + JSON.stringify(after).slice(0, 400));
  ok('★ 撳完掣 → 結論變「對得上」（ok）', after.level === 'ok', `level=${after.level} title=${after.title}`);
  ok('★ 每表都 ✓（本機 ＝ 後端）',
    (after.rows || []).length > 0 && after.rows.every(r => r.same !== false),
    JSON.stringify(after.rows));
  ok('★ 結論講明「第二部機會見到呢一份」', /第二部機|無痕/.test(after.detail || ''), after.detail);

  /* ============================================================
     ③ 一寫一讀驗證
     ============================================================ */
  section('一寫一讀驗證：寫個記號落後端再讀返出嚟對');
  const B = await runDevice({ steps: [
    { op: 'load' },                 // 由後端載入（機 A 已經寫咗 3 個人）
    { op: 'probe' },                // ← 寫記號 → 送出 → 讀返 → 清走
    { op: 'reality' }
  ] });
  ok('機 B 全程冇爆', B.ok === true, B.error || '');
  const pb = stepOf(B, 'probe');
  console.log('  · 一寫一讀驗證：' + JSON.stringify(pb));
  ok('★ 一寫一讀驗證成功（matched ＝ 寫入同讀取都通）', pb.matched === true, JSON.stringify(pb));
  ok('★ 後端讀返嘅記號同寫出去嗰個一樣', !!pb.seen && pb.seen === pb.nonce, JSON.stringify(pb));
  ok('★ 寫入冇報錯', !pb.error, pb.error);
  ok('★ 完咗自動清走記號（後端唔會留低垃圾）', pb.cleanedUp === true && !pb.cleanupError, JSON.stringify(pb));

  const bReality = stepOf(B, 'reality');
  ok('★ 第二部機睇到同一份資料（3 位用戶，對得上）',
    bReality.level === 'ok' && (bReality.local?.members || 0) === 3,
    JSON.stringify({ level: bReality.level, local: bReality.local }));

  /* 後端唔應該留低 probe 記號 */
  const raw = await fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'loadDb', unit: '0082' })
  }).then(r => r.json()).catch(() => ({}));
  ok('★ 後端資料庫冇留低驗證記號', !raw?.db?.meta?.probe, JSON.stringify(raw?.db?.meta?.probe || ''));

  /* ============================================================
     ④ 後端斷咗：要講得出「斷咗」而唔係扮「對得上」
     ============================================================ */
  section('後端連唔到：要老實講「斷咗」，唔可以扮冇事');
  const C = await runDevice({
    steps: [{ op: 'reality' }, { op: 'syncNow' }],
    badKey: true                               // ← 模擬 API Key 唔啱（status 通、讀寫被拒）
  });
  const cReality = stepOf(C, 'reality');
  console.log('  · API Key 唔啱嘅後端實況：' + JSON.stringify(cReality).slice(0, 400));
  ok('★ 讀寫被拒 → ok = false（唔會扮讀到）', cReality.ok === false, JSON.stringify(cReality));
  ok('★ 結論係「斷咗」', cReality.level === 'bad', `level=${cReality.level}`);
  ok('★ 結論直指 API Key（唔係淨係「同步失敗」四個字）',
    /API Key|讀／寫被拒/.test((cReality.title || '') + (cReality.error || '')),
    `${cReality.title} / ${cReality.error}`);
  ok('★ 有 hint 教下一步點做', !!cReality.hint, cReality.hint);

  const cPush = stepOf(C, 'syncNow');
  ok('★（對照）API Key 唔啱嗰陣「儲存到後端」會失敗，而且唔會盲寫',
    cPush.ok === false, JSON.stringify(cPush));

  console.log(`\n──────── 後端實況測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('測試爆咗：', e);
  process.exitCode = 1;
} finally {
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
}
