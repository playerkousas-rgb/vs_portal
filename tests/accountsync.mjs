/* ============================================================
   tests/accountsync.mjs — 「帳戶／身份」一定要即刻寫到後端
   ------------------------------------------------------------
   團長 2026-09-24 回報：
     「不同視窗開的又不同步，最簡單就是 1 邊能用 email 登入、1 邊不能，
       那＝用戶根本沒寫入後端，唯一能登入的是我的超管，因為不經後端。」

   呢個測試唔講道理，直接開機行真實 HTTP（每個 process ＝ 一部全新嘅機）：
     機 A（團長）：喺「用戶與身份」開一個領袖 ＋ 設密碼
                   → **唔撳**「儲存到後端」（因為用戶根本唔知道要撳）
                   → 即刻直接問後端：嗰個人存唔存在？有冇密碼？
     機 B（全新）：用嗰個 email 登入 —— 應該入到
     機 A        ：另一個分頁（同機同瀏覽器）開咗個人 —— 呢邊應該即刻見到
   環境：假 GAS（tests/_fakegas.mjs）＋ dev-server（/api/proxy）
   用法：node tests/accountsync.mjs
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

const EMAIL = 'leader2@example.com';
const PW = 'scout2026';
const YMIS = '2026000777';

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

  /* ============ 機 A：同一部機上「開人 → 設密碼」，全程冇撳「儲存到後端」 ============ */
  section('機 A（團長）：開領袖＋設密碼，全程冇撳「儲存到後端」');
  const A = await runDevice({ steps: [
    { op: 'wipe' },
    { op: 'addStaff', name: '新領袖', email: EMAIL, ymis: YMIS, identity: 'leader' },
    { op: 'setHubPw', id: '@last', pw: PW },
    { op: 'wait', ms: 3000 },
    { op: 'backendHasLogin', login: EMAIL },
    { op: 'otherTabWrite', name: '另一分頁開嘅人' }
  ] });
  ok('機 A 全程冇爆', A.ok === true, A.error || '');
  const pwStep = stepOf(A, 'setHubPw');
  console.log('  · 設密碼：' + JSON.stringify(pwStep));
  ok('設密碼成功', pwStep.ok === true, JSON.stringify(pwStep));

  const be = stepOf(A, 'backendHasLogin');
  console.log('  · 開完人之後直接問後端：' + JSON.stringify(be));
  ok('★ 開完人＋設完密碼，後端嗰份名冊已經有呢個人（唔使撳任何掣）',
    be.found === true && be.withPw === true, JSON.stringify(be));

  const otherTab = stepOf(A, 'otherTabWrite');
  console.log('  · 另一分頁寫入：' + JSON.stringify(otherTab));
  ok('★ 同一個瀏覽器另一個分頁開咗人，呢邊即刻見到（唔使重新整理）',
    otherTab.seesName === true, JSON.stringify(otherTab));

  /* ============ 機 B（全新）：用嗰個 email 登入 ============ */
  section('機 B（全新裝置）：用啱啱開嘅 email 登入');
  const B = await runDevice({ steps: [{ op: 'login', login: EMAIL, pw: PW }] });
  const lg = stepOf(B, 'login');
  console.log('  · 機 B 登入結果：' + JSON.stringify(lg));
  ok('★ 機 B 用 email 登入成功（帳戶真係喺後端）', lg.ok === true, JSON.stringify(lg));
  ok('登入之後 session 角色＝領袖', lg.role === 'leader', JSON.stringify(lg));

  /* ============ 進度追蹤：名冊要真係到到後端「成員名單」，否則個個顯示 0 ============ */
  section('進度追蹤：名冊到咗後端，進度頁先至有人（唔係「0 紀錄」）');
  const P = await runDevice({ steps: [
    { op: 'load' },      // 真 app 開機一定先由後端載入（＝基準）；唔係就唔准盲寫
    { op: 'addStaff', name: '進度團員', email: 'youth@example.com', ymis: '2026000888', identity: 'member' },
    { op: 'wait', ms: 3000 },
    { op: 'progressLoad' },
    { op: 'progressTick', ymis: '2026000888', itemId: 'vs_a1' },
    { op: 'progressLoad' }
  ] });
  const pls = (P.steps || []).filter(x => x.op === 'progressLoad');
  console.log('  · 開完人之後問進度後端：' + JSON.stringify(pls[0]));
  ok('★ 開完人之後，後端「成員名單」已經有呢個 YMIS（進度頁先至有人揀）',
    (pls[0]?.memberList || 0) >= 1 && (pls[0]?.ymis || []).includes('2026000888'), JSON.stringify(pls[0]));
  const tick = (P.steps || []).find(x => x.op === 'progressTick');
  ok('勾一項進度寫得入後端', tick?.ok === true, JSON.stringify(tick));
  console.log('  · 勾完之後問進度後端：' + JSON.stringify(pls[1]));
  ok('★ 進度後端讀返到嗰一格（唔係「0 紀錄」）',
    (pls[1]?.progressPeople || 0) >= 1 && (pls[1]?.ticks || 0) >= 1, JSON.stringify(pls[1]));

  /* ============ 對照組：超管登入完全唔經旅團後端 ============ */
  section('對照：超管登入完全唔經旅團後端（所以佢永遠入到）');
  const sup = await fetch(`${BASE}/api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'sheep', password: 'super_secret_test' })
  }).then(x => x.json()).catch(e => ({ error: String(e) }));
  ok('超管核對由伺服器端做（同旅團後端無關）', sup?.ok === true, JSON.stringify(sup));

  console.log(`\n──────── 帳戶同步測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('測試爆咗：', e);
  process.exitCode = 1;
} finally {
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
}
