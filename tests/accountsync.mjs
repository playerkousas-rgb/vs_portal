/* ============================================================
   tests/accountsync.mjs — 「帳戶／身份」一定要即刻寫到後端
   ------------------------------------------------------------
   團長 2026-09-24 回報：
     「不同視窗開的又不同步，最簡單就是 1 邊能用 email 登入、1 邊不能，
       那＝用戶根本沒寫入後端，唯一能登入的是我的超管，因為不經後端。」

   ★ 2026-09-24 團長第五輪定案（呢個測試跟住改）：
     「我只想要頂部1個儲到後端的制,其他任何時候都是暫儲在遊覽器」
     → 2026-09-24 為咗救呢個問題加過自動寫入，團長明確否決，自動寫入已經拆走。
     所以而家釘死嘅係**兩件事一齊成立**：
       ① 未撳頂部掣 ＝ 後端一個字都冇（改動只喺瀏覽器），而且頂部要**鬧醒**用家
          有幾多個帳戶未寫入（pendingAccounts）—— 唔可以再靜靜地漏
       ② 撳咗頂部「儲存到後端」＝ 帳戶一定到到後端，另一部機即刻用嗰個 email 登到
   每個 process ＝ 一部全新嘅機，行真實 HTTP：
     機 A（團長）：開一個領袖 ＋ 設密碼 → 驗證未撳掣之前後端冇嘢 ＋ 有鬧醒
                   → 撳頂部「儲存到後端」→ 再問後端
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

  /* ============ 機 A：開人 → 設密碼 →（未撳掣）→ 撳頂部「儲存到後端」 ============ */
  section('機 A（團長）：開領袖＋設密碼 → 未撳掣之前後端冇嘢 → 撳頂部掣');
  const A = await runDevice({ steps: [
    { op: 'wipe' },
    { op: 'load' },                                        // 真 app 開機一定先由後端載入（＝基準）
    { op: 'addStaff', name: '新領袖', email: EMAIL, ymis: YMIS, identity: 'leader' },
    { op: 'setHubPw', id: '@last', pw: PW },
    { op: 'wait', ms: 3000 },                              // 等足 3 秒：證明冇自動寫入
    { op: 'backendHasLogin', login: EMAIL },               // ← 未撳掣
    { op: 'otherTabWrite', name: '另一分頁開嘅人' },
    { op: 'syncNow' },                                     // ← 撳頂部「儲存到後端」（唯一寫入路）
    { op: 'backendHasLogin', login: EMAIL }                // ← 撳完
  ] });
  ok('機 A 全程冇爆', A.ok === true, A.error || '');
  const pwStep = stepOf(A, 'setHubPw');
  console.log('  · 設密碼：' + JSON.stringify(pwStep));
  ok('設密碼成功', pwStep.ok === true, JSON.stringify(pwStep));

  /* ---- ① 未撳掣：改動一定仲喺瀏覽器，而且頂部要鬧醒 ---- */
  ok('★ 帳戶改動計入「未寫入」（pending ≥ 1）', Number(pwStep.pending || 0) >= 1, JSON.stringify(pwStep));
  ok('★ 帳戶改動另外計數（pendingAccounts ≥ 1）—— 頂部用嚟轉紅鬧醒',
    Number(pwStep.pendingAccounts || 0) >= 1, JSON.stringify(pwStep));
  ok('★ 狀態文字講明「未寫入」同埋有幾個帳戶（唔會靜靜地漏）',
    pwStep.state === 'pending' && /包括 \d+ 個帳戶/.test(pwStep.statusMsg || ''), pwStep.statusMsg);

  const bes = (A.steps || []).filter(x => x.op === 'backendHasLogin');
  const [be0, be1] = [bes[0] || {}, bes[1] || {}];
  console.log('  · 未撳掣之前問後端：' + JSON.stringify(be0));
  ok('★ 未撳頂部掣 → 後端仲未有呢個人（改動只喺瀏覽器，冇偷偷地寫）',
    be0.found === false, JSON.stringify(be0));

  const otherTab = stepOf(A, 'otherTabWrite');
  console.log('  · 另一分頁寫入：' + JSON.stringify(otherTab));
  ok('★ 同一個瀏覽器另一個分頁開咗人，呢邊即刻見到（唔使重新整理）',
    otherTab.seesName === true, JSON.stringify(otherTab));

  /* ---- ② 撳咗頂部掣：帳戶一定到到後端 ---- */
  const sn = stepOf(A, 'syncNow');
  console.log('  · 撳「儲存到後端」：' + JSON.stringify(sn));
  ok('★ 撳頂部「儲存到後端」成功', sn.ok === true && sn.pushed === true, JSON.stringify(sn));
  ok('★ 寫完 pending 清零', Number(sn.pending || 0) === 0, JSON.stringify(sn));
  console.log('  · 撳完之後問後端：' + JSON.stringify(be1));
  ok('★ 後端嗰份名冊已經有呢個人＋有密碼',
    be1.found === true && be1.withPw === true, JSON.stringify(be1));

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
    { op: 'syncNow' },   // ← 「成員名單」分頁係喺寫入後端嗰陣先至更新，所以要撳頂部掣
    { op: 'progressLoad' },
    { op: 'progressTick', ymis: '2026000888', itemId: 'vs_a1' },
    { op: 'progressLoad' }
  ] });
  const pls = (P.steps || []).filter(x => x.op === 'progressLoad');
  console.log('  · 撳完「儲存到後端」之後問進度後端：' + JSON.stringify(pls[0]));
  ok('★ 撳完頂部掣之後，後端「成員名單」已經有呢個 YMIS（進度頁先至有人揀）',
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
