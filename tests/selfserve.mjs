/* Regression for retired browser-selected troop backends. A real HTTP fixture checks
   unregistered fail-closed routing, preserved pending changes and safe member links.
   Other registered, two-device synchronization paths remain covered by remote.mjs. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_SUPER_PASSWORD } from './_authstub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SUPER_KEY = TEST_SUPER_PASSWORD;
const t0 = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const { spawn } = await import('node:child_process');
const net0 = await import('node:net');
const freePort = () => new Promise((resolve, reject) => {
  const srv = net0.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const waitPort = async (port, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const up = await new Promise(r => {
      const s = net0.connect(port, '127.0.0.1');
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
const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;
const KEY = 'v82_selfserve_test_key';

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
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（40 秒）' }), 40000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-800) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});
const step = (r, op) => (r?.steps || []).find(s => s.op === op) || {};

const cleanup = () => procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
process.on('exit', cleanup);

/* Browser-provided route metadata must never override server Registry. */
section('未登記：本機 URL／Key 不可繞過 Registry');
spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)], { FAKEGAS_APIKEY: KEY });
spawnBg([path.join(ROOT, 'dev-server.mjs')], { PORT: String(WEB_PORT), V82_PROXY_TEST: '1', TROOP_0082_BACKEND: '', TROOP_0082_APIKEY: '' });
ok('假後端啟動', await waitPort(GAS_PORT));
ok('未登記代理啟動', await waitPort(WEB_PORT));
const blocked = await runDevice({ steps: [
  { op: 'setSync', url: FAKE_EXEC, apiKey: KEY },
  { op: 'addMember', name: '不可直送', ymis: '2026000001' },
  { op: 'push' }, { op: 'info' }, { op: 'links' }
] });
ok('測試裝置正常執行', blocked.ok === true, blocked.error);
ok('未登記時讀寫皆失敗，不使用 browser URL／Key',
  !step(blocked, 'push').ok && !step(blocked, 'info').ok && step(blocked, 'info').reason === 'not_registered', JSON.stringify(blocked.steps));
ok('未儲存改動保留本機', Number(step(blocked, 'push').pending || 0) > 0, JSON.stringify(step(blocked, 'push')));
const probe = await fetch(FAKE_EXEC, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ action: 'dbInfo', unit: '0082', apiKey: KEY }) }).then(r => r.json());
ok('未登記時假後端沒有收到資料庫', probe.found === false, JSON.stringify(probe));
const link = step(blocked, 'links').urls?.[0]?.url || '';
ok('團員入口保留旅團編號但沒有 be／API Key', /[?&]u=0082/.test(link) && !/[?&]be=|apikey/i.test(link), link);
const redirects = ['public.js', 'public-notice.js', 'public-entry.js', 'public-borrow.js'];
ok('舊頁只轉往登入入口，不再轉送 be 或匿名 fetch', redirects.every(file => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8');
  return src.includes("new URL('./members.html'") && src.includes('location.replace')
    && !/searchParams\.set\('be'/.test(src) && !/\bfetch\s*\(/.test(src);
}));
console.log(`\n結果：${pass} 通過 / ${fail} 失敗（${Date.now() - t0}ms）`);
process.exit(fail ? 1 : 0);
