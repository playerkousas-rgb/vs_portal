/* ============================================================
   tests/pendinglogin.mjs — 「B 機有未儲存資料 → 入錯側、登唔到 A 機新開嘅帳戶」
   ------------------------------------------------------------
   團長 2026-09-25 回報：
     「A 機開咗帳戶寫入後端，B 機本身未有呢個帳戶。B 機有自己未傳後端嘅資料，
       因為唔係首先讀後端，B 就用咗本機嗰份，所以登入唔到 A 機開嘅帳戶。
       要等我用另一帳戶登入、同步咗後端、令本機都有呢個帳戶先登到。」

   要釘死嘅規則（同登入硬閘一致）：
     ① 登入／開機一定**由後端攞成份資料**做基準 —— 本機有未儲存改動，都係
       合併（後端 + 我嘅唔撞改動），**唔會**用本機資料蓋走後端。
     ② A 機開咗帳戶並寫入後端 → B 機（即使自己有未儲存改動）登入嗰陣就見到佢，
       可以直接用嗰個帳戶登入，唔使「用第二個帳戶登入再同步」。
     ③ 呢個唔係「要人識得撳掣」嘅嘢：登入嗰一步已經自動重拉後端（硬閘）。
   ============================================================ */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
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
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（60 秒）' }), 60000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});
const stepOf = (r, op, nth = 0) => (r?.steps || []).filter(s => s.op === op)[nth] || {};

const FILE = path.join(ROOT, 'tests', '.pendinglogin-state.json');
const A_EMAIL = 'leaderA@example.com';
const A_PW = 'scoutA2026';
const ANEW_EMAIL = 'leaderANew@example.com';
const ANEW_PW = 'scoutNew2026';
const BLOCAL_EMAIL = 'blocal@example.com';

try {
  spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
  spawnBg([path.join(ROOT, 'dev-server.mjs')], {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_0082',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT),
    SUPER_KEY: 'super_secret_test'
  });
  ok('測試用假後端＋dev-server 已啟動', (await waitPort(GAS_PORT)) && (await waitPort(WEB_PORT)));

  /* ============ 第一步：A 機開第一個帳戶並寫入後端 ============ */
  section('第一步：A 機開戶 → 寫入後端');
  const SETUP = await runDevice({ steps: [
    { op: 'load' },
    { op: 'addStaff', name: '團長A', email: A_EMAIL, ymis: '2026100001', identity: 'leader' },
    { op: 'setHubPw', id: '@last', pw: A_PW },
    { op: 'syncNow' },
    { op: 'backendHasLogin', login: A_EMAIL }
  ] });
  ok('A 機開戶＋寫入後端冇爆', SETUP.ok === true, SETUP.error || '');
  const setupHas = stepOf(SETUP, 'backendHasLogin');
  ok('A 機帳戶真係到到後端（有密碼）', setupHas.found === true && setupHas.withPw === true, JSON.stringify(setupHas));

  /* ============ 第二步：B 機載入後端 → 自己開一個未儲存帳戶 → 存檔（模擬 B 一直開住） ============ */
  section('第二步：B 機開咗一個「未寫入後端」嘅帳戶（仲未撳儲存）');
  const B1 = await runDevice({ steps: [
    { op: 'load' },                                             // 開機：由後端載入 A 機個帳戶
    { op: 'addStaff', name: 'B機未存', email: BLOCAL_EMAIL, ymis: '2026100002', identity: 'leader' },
    { op: 'setHubPw', id: '@last', pw: 'blocal9999' },
    { op: 'export', file: FILE }                                // 把本機狀態連基準快照存檔
  ] });
  ok('B 機第一次開機冇爆', B1.ok === true, B1.error || '');
  const b1add = stepOf(B1, 'addStaff');
  ok('B 機自己嗰個帳戶係 pending（未寫入後端）', Number(b1add.pending || 0) >= 1, JSON.stringify(b1add));

  /* ============ 第三步：A 機開第二個帳戶並寫入後端 ============ */
  section('第三步：A 機開第二個帳戶 → 寫入後端');
  const A2 = await runDevice({ steps: [
    { op: 'load' },
    { op: 'addStaff', name: 'A機新開', email: ANEW_EMAIL, ymis: '2026100003', identity: 'leader' },
    { op: 'setHubPw', id: '@last', pw: ANEW_PW },
    { op: 'syncNow' },
    { op: 'backendHasLogin', login: ANEW_EMAIL }
  ] });
  ok('A 機開第二個帳戶冇爆', A2.ok === true, A2.error || '');
  const a2has = stepOf(A2, 'backendHasLogin');
  ok('A 機第二個帳戶真係到到後端', a2has.found === true && a2has.withPw === true, JSON.stringify(a2has));

  /* ============ 第四步（關鍵）：B 機登入 —— 自己嗰個未存帳戶要留住，同時見到 A 機新帳戶 ============ */
  section('第四步（關鍵）：B 機登入（登入硬閘會重拉後端）');
  const B2 = await runDevice({ steps: [
    { op: 'import', file: FILE },                               // 回帶 B 機啱啱嗰刻（有未存帳戶）
    { op: 'load' },                                             // 登入硬閘：由後端載入＋合併
    { op: 'logins' },
    { op: 'login', login: BLOCAL_EMAIL, pw: 'blocal9999' },     // 自己未存帳戶仍應登到
    { op: 'login', login: ANEW_EMAIL, pw: ANEW_PW }             // ★ A 機新帳戶要即刻登到
  ] });
  ok('B 機登入流程冇爆', B2.ok === true, B2.error || '');
  const b2logins = stepOf(B2, 'logins');
  const emails = (b2logins.list || []).map(m => String(m.email || '')).filter(Boolean);
  console.log('  · B 機登入嗰陣見到嘅帳戶：' + JSON.stringify(b2logins.list || []));
  ok('★ 合併之後，B 機自己未存嘅帳戶留低咗（唔會因為拉後端而丟）',
    emails.includes(BLOCAL_EMAIL), emails.join(', ') || '(空)');
  ok('★ 合併之後，A 機新開嘅帳戶即刻見到（唔使入第二個帳戶先）',
    emails.includes(ANEW_EMAIL), emails.join(', ') || '(空)');

  const b2self = stepOf(B2, 'login', 0);
  const b2new = stepOf(B2, 'login', 1);
  console.log('  · B 機用自己未存帳戶登入：' + JSON.stringify(b2self));
  ok('B 機用自己未存帳戶仍可登入', b2self.ok === true, JSON.stringify(b2self));
  console.log('  · B 機用 A 機新帳戶登入：' + JSON.stringify(b2new));
  ok('★ B 機直接用 A 機新開帳戶登入成功（本機未存資料唔應該擋住）',
    b2new.ok === true, JSON.stringify(b2new));

  /* ============ 第五步（團員入口版）：A 機開個「團員」帳戶，B 機照登 ============
     團員入口（members.html）登入係 loginMember(YMIS, 密碼) ＝ loginIdentity 同一條路，
     syncBoot 一樣係 loadFromBackend（policy:'mine'，即係合併）。所以上述唔止適用
     喺領袖／執委入管理系統，團員用手機入團員入口都要同樣成立。 */
  section('第五步：A 機開個「團員」帳戶 → B 機（有未存資料）直接登入團員入口');
  const AMEM = '2026100004';
  const MPW = 'member1234';
  const A3 = await runDevice({ steps: [
    { op: 'load' },
    { op: 'addStaff', name: '新團員', ymis: AMEM, identity: 'member' },
    { op: 'setHubPw', id: '@last', pw: MPW },
    { op: 'syncNow' },
    { op: 'backendHasLogin', login: AMEM }
  ] });
  ok('A 機開團員帳戶冇爆', A3.ok === true, A3.error || '');
  const a3has = stepOf(A3, 'backendHasLogin');
  ok('團員帳戶真係到到後端（有密碼）', a3has.found === true && a3has.withPw === true, JSON.stringify(a3has));

  const B3 = await runDevice({ steps: [
    { op: 'import', file: FILE },                 // B 機嗰份未存資料（同上一個情境）
    { op: 'load' },                               // 團員入口 syncBoot 同呢個一樣：先拉後端合併
    { op: 'login', login: AMEM, pw: MPW }         // YMIS＋密碼（＝loginMember）
  ] });
  ok('B 機登入流程冇爆', B3.ok === true, B3.error || '');
  const b3lg = stepOf(B3, 'login');
  console.log('  · B 機用團員 YMIS 登入：' + JSON.stringify(b3lg));
  ok('★ B 機（有未存資料）直接用 A 機新開團員帳戶登入成功（團員入口版）',
    b3lg.ok === true && b3lg.role === 'member', JSON.stringify(b3lg));

  console.log(`\n──────── 未存資料登入測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('測試爆咗：', e);
  process.exitCode = 1;
} finally {
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  /* 清走中途存檔（唔會留低喺 repo） */
  try { (await import('node:fs')).default.rmSync(FILE, { force: true }); } catch { /* ignore */ }
}
