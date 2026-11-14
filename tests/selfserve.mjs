/* ============================================================
   tests/selfserve.mjs — 自助路線（平台未登記旅團後端嗰陣）
   ------------------------------------------------------------
   2026-09-19 團長回報：
     「無痕同普通 Chrome 都同步唔到；之前嗰啲公開連結都冇 FIX。
       懷疑唔係修唔到，而係有啲嘢把解決方法封死。」
   懷疑係啱嘅。舊 remote.js：

       const r = await postJson('api/proxy', body, timeoutMs);
       if (r.ok && r.json) return normalize(r.json);
       if (!r.noApi) { if (r.json) return normalize(r.json); ... }

   proxy 對「未登記旅團」回 **HTTP 404 ＋ JSON**，而 `noApi` 只在回應
   **唔係 JSON** 嗰陣先 set —— 所以函數永遠喺 proxy 嗰步 return，
   「直接打用家自己貼嘅 /exec」嗰條路一行都未行過。
   後果：Vercel 環境變數一日未設定好，領袖自己貼 /exec 都係死；
   而「叫平台管理員加環境變數」又唔係領袖自己做得到 → 兩邊死鎖。
   公開頁同一個病：淨係打 api/proxy，404 就當「未發布」。

   呢個檔用**真 HTTP**（假 GAS ← dev-server ← 兩個獨立 process ＝ 兩部機）
   釘死以下行為，防止再退返去：
     ① 平台未登記 ＋ 用家乜都未填 → 如實回 not_registered ＋ 教佢自救
     ② 平台未登記 ＋ 用家貼咗 /exec＋Key → 讀寫都通（以前一定失敗）
     ③ 無痕視窗（全新 process）貼同一個 /exec → 拉返普通視窗推上去嘅資料
     ④ 貼錯網址（唔係 Apps Script /exec）→ 拒送（唔會把資料送去奇怪地方）
     ⑤ 「同步診斷」逐格講清楚邊格斷
     ⑥ 公開連結自動附 ?be=，團章／通告公開頁因此讀到後端正本
     ⑦ 平台已登記嗰陣 → 行返 proxy，連結唔會多餘附 ?be=
   用法：node tests/selfserve.mjs
   ============================================================ */

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

/* ============================================================
   ① — ⑥：平台**未登記** 0082（dev-server 冇 TROOP_0082_* 環境變數）
   ============================================================ */
section('平台未登記旅團後端（Vercel 環境變數未設定）');

spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)], { FAKEGAS_APIKEY: KEY });
/* 關鍵：**冇** TROOP_0082_BACKEND / TROOP_0082_APIKEY ——
   proxy 對 0082 一律回 404「找不到此旅團或後端網址未設定」。 */
spawnBg([path.join(ROOT, 'dev-server.mjs')], { PORT: String(WEB_PORT), V82_PROXY_TEST: '1' });
ok('假後端已啟動', await waitPort(GAS_PORT));
ok('dev-server 已啟動（但平台未登記 0082）', await waitPort(WEB_PORT));

/* 先確認前提：proxy 真係 404（唔係測試本身設定錯） */
{
  const r = await fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dbInfo', unit: '0082' })
  });
  const j = await r.json().catch(() => null);
  ok('前提成立：proxy 對未登記旅團回 404 ＋ JSON', r.status === 404 && /找不到此旅團/.test(String(j?.error || '')),
    `HTTP ${r.status} ${JSON.stringify(j)}`);
}

/* ---- ① 用家乜都未填：如實報「平台未登記」＋教佢自救 ---- */
section('① 未填 /exec：如實報告＋教你自救（唔係淨係「同步失敗」）');
{
  const A = await runDevice({ steps: [{ op: 'info' }, { op: 'push' }] });
  ok('裝置開到機', A.ok === true, A.error || '');
  const i = step(A, 'info');
  ok('remoteInfo 如實回 not_registered（唔係扮「未設定後端」）',
    i.ok === false && i.reason === 'not_registered', JSON.stringify(i));
  const p = step(A, 'push');
  ok('pushDb 同一個原因（唔會靜靜雞寫去錯地方）',
    p.ok === false && p.reason === 'not_registered', JSON.stringify(p));
  ok('錯誤訊息教用家自己貼 /exec（自救方法冇被封死）',
    /同步設定/.test(String(p.hint || '')) && /showApiKey/.test(String(p.hint || '')), String(p.hint || '').slice(0, 100));
}

/* ---- ④ 貼錯網址：拒送 ---- */
section('④ 貼錯後端網址（唔係 Apps Script /exec）→ 拒送');
{
  const A = await runDevice({ steps: [
    { op: 'setSync', url: 'https://evil.example.com/collect', apiKey: KEY },
    { op: 'info' }
  ] });
  const i = step(A, 'info');
  ok('唔合格嘅網址會擋住（資料唔會送去第三個網域）',
    i.ok === false && i.reason === 'bad_url', JSON.stringify(i));
}

/* ---- ② 貼啱 /exec＋Key：讀寫即刻通 ---- */
section('② 領袖自己貼 /exec ＋ API Key（自助路線）');
const A = await runDevice({ steps: [
  { op: 'setSync', url: FAKE_EXEC, apiKey: KEY },
  { op: 'addMember', name: '陳大文', ymis: '2026000001' },
  { op: 'addTx', date: '2026-09-19', type: 'income', item: '團費', amount: 360 },
  { op: 'push' },
  { op: 'info' },
  { op: 'links' }
] });
{
  ok('裝置 A 開到機', A.ok === true, A.error || '');
  ok('自助後端已記入設定', step(A, 'setSync').hasKey === true, JSON.stringify(step(A, 'setSync')));
  const p = step(A, 'push');
  ok('★ 貼咗 /exec 之後 pushDb 成功（舊版呢度一定失敗）',
    p.ok === true, JSON.stringify(p));
  ok('寫入後 pending 已清', p.pending === 0, JSON.stringify(p));

  /* 後端真係收到（唔係前端自己講得） */
  const direct = await fetch(FAKE_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'dbInfo', unit: '0082', apiKey: KEY })
  });
  const dj = await direct.json();
  ok('★ 假後端真係收到成個資料庫（團員 1 · 帳目 1）',
    dj.ok === true && dj.found === true && dj.counts?.members === 1 && dj.counts?.transactions === 1,
    JSON.stringify(dj.counts || dj));
}

/* ---- ③ 無痕視窗（全新 process）拉返普通視窗推上去嘅資料 ---- */
section('③ 無痕視窗（全新 process／全新 localStorage）拉到同一份資料');
{
  const B = await runDevice({ steps: [
    { op: 'snapshot' },
    { op: 'setSync', url: FAKE_EXEC, apiKey: KEY },
    { op: 'pull' },
    { op: 'snapshot' }
  ] });
  const snaps = (B.steps || []).filter(s => s.op === 'snapshot');
  ok('無痕視窗開機時本機係空白（真係另一部機）',
    snaps[0]?.members === 0 && snaps[0]?.lastSyncedVersion === '', JSON.stringify(snaps[0]));
  const pull = step(B, 'pull');
  ok('★ 拉後端成功', pull.ok === true && pull.found === true, JSON.stringify(pull));
  ok('★ 見到普通視窗推上去嘅團員（陳大文）',
    (snaps[1]?.names || []).includes('陳大文'), JSON.stringify(snaps[1]?.names));
  ok('拉到之後記低咗後端版本（之後 push 先至過到樂觀鎖）',
    !!snaps[1]?.lastSyncedVersion, JSON.stringify(snaps[1]));
}

/* ---- ⑤ 後端資訊（自助路線仍然讀得到） ---- */
section('⑤ 「後端資訊」自助路線照樣問得到後端');
{
  /* 2026-11-12：remoteDiagnose() 已刪（UI 喺 2026-09-26 拆走，只剩測試叫佢）。
     改用仍然 live 嘅 remoteInfo()：驗同一件事 —— 自己貼 /exec 之後，
     唔經平台登記都問得到後端；未貼嗰陣要辨得出「未設定」而唔係訛稱成功。 */
  const d = step(A, 'info');
  ok('★ 自助路線問得到後端（ok）', d.ok === true, JSON.stringify(d).slice(0, 200));
  ok('★ 攞到後端版本號', !!d.backendVersion, String(d.backendVersion));
  ok('★ 讀得到後端實際內容（found）', d.found === true, JSON.stringify(d));

  /* 未貼 /exec 嗰陣，要指得出「未設定」，唔可以扮連到 */
  const C = await runDevice({ steps: [{ op: 'info' }] });
  const dc = step(C, 'info');
  /* 未登記嘅真正 reason 係 not_registered（平台冇該旅團後端，連結亦冇帶網址）——
     同原本診斷指「registry 斷咗」係同一件事，而且更精確。 */
  ok('★ 未接後端嗰陣，指得出係「平台未登記」而唔係扮連到',
    dc.ok === false && dc.reason === 'not_registered', JSON.stringify(dc));
}

/* ---- ⑥ authenticated 團員入口 ---- */
section('⑥ 團員登入連結：自助 routing 可附 ?be=，但絕不免登入');
{
  const l = step(A, 'links');
  ok('publicLinkRoute 認到行緊自助路線', l.route === 'direct' && l.routeOk === true,
    JSON.stringify({ route: l.route, label: l.label }));
  ok('selfServeExec 回傳領袖貼嘅 /exec', l.selfServeExec === FAKE_EXEC.replace(/\/$/, ''), String(l.selfServeExec));
  const hub = (l.urls || []).find(u => u.id === 'hub');
  ok('只派一條 members.html 團員登入入口',
    (l.urls || []).length === 1 && /members\.html/.test(String(hub?.url || '')), JSON.stringify(l.urls));
  ok('自助入口帶 ?be= 作 routing，同時保留旅團編號',
    /[?&]be=/.test(String(hub?.url || '')) && /[?&]u=0082(?:&|$)/.test(String(hub?.url || '')),
    String(hub?.url));
  ok('入口網址不帶 API Key、role 或任何閱讀憑證',
    !/(apiKey|apikey|[?&]key=|[?&]role=)/i.test(String(hub?.url || '')), String(hub?.url));

  const redirectFiles = ['public.js', 'public-notice.js', 'public-entry.js', 'public-borrow.js'];
  ok('四個舊 URL script 只保留 members.html 相容轉向並傳遞 be routing',
    redirectFiles.every(file => {
      const src = fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8');
      return src.includes("new URL('./members.html'") && src.includes('location.replace')
        && src.includes("searchParams.set('be'") && !/\bfetch\s*\(/.test(src);
    }));
  const hubSource = fs.readFileSync(path.join(ROOT, 'assets/js', 'public-hub.js'), 'utf8');
  ok('members.html 仍要 opaque session：先 loginMember／loadHubAuth，再 loadHubView',
    /loginMember/.test(hubSource) && /loadHubAuth/.test(hubSource)
      && /loadHubView/.test(hubSource) && /sessionToken/.test(hubSource));
  ok('?be= 只係後端 routing，不會復活匿名團章／通告 renderer',
    redirectFiles.every(file => !/loadPublic|noticeSignup|appendClaim|appendLoan/.test(
      fs.readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'))));
}

/* ============================================================
   ⑦ 對照組：平台**已登記**（有 TROOP_0082_*）→ 行返受保護 proxy
   ============================================================ */
section('⑦ 對照：平台已登記 → 行返受保護 proxy');
{
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  procs.length = 0;
  const WEB2 = await freePort();
  const GAS2 = await freePort();
  const BASE2 = `http://127.0.0.1:${WEB2}`;
  spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS2)], { FAKEGAS_APIKEY: KEY });
  spawnBg([path.join(ROOT, 'dev-server.mjs')], {
    PORT: String(WEB2), V82_PROXY_TEST: '1',
    TROOP_0082_BACKEND: `http://127.0.0.1:${GAS2}/exec`,
    TROOP_0082_APIKEY: KEY
  });
  ok('對照組伺服器已啟動', await waitPort(GAS2) && await waitPort(WEB2));

  /* runDevice 用死咗 BASE —— 呢度直接打 proxy 驗登記狀態 */
  const r = await fetch(`${BASE2}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status', unit: '0082' })
  });
  const j = await r.json().catch(() => null);
  ok('平台登記咗就經 proxy 通到後端', r.status === 200 && j?.ok === true && j?.backendVersion === 'v2.8.1',
    `HTTP ${r.status} ${JSON.stringify(j)}`);

  const reg = await (await fetch(`${BASE2}/api/units?diag=1`)).json();
  ok('Registry 報告 0082 已登記＋有 Key（診斷依據）',
    (reg.diag?.trusted || []).includes('0082') && (reg.diag?.withKey || []).includes('0082'),
    JSON.stringify({ trusted: reg.diag?.trusted, withKey: reg.diag?.withKey }));
  /* 診斷只回變數名同布林值 —— 唔可以洩露條 Key，亦唔可以洩露真正嘅 /exec 網址。
     （`notice` 欄入面嗰句教學文字本身有「/exec」四個字，嗰個唔算洩露；
       要驗嘅係**呢個旅團嗰條**網址有冇出現。） */
  const regText = JSON.stringify(reg);
  ok('診斷 API 唔會回傳 API Key', !regText.includes(KEY), '有洩露 Key');
  ok('診斷 API 唔會回傳旅團真正嘅 /exec 網址',
    !regText.includes(`127.0.0.1:${GAS2}`), '有洩露後端網址');
  ok('診斷 API 只回變數**名**（recognised／suspicious），唔回值',
    (reg.diag?.recognizedNames || []).includes('TROOP_0082_APIKEY') && !regText.includes(KEY),
    JSON.stringify(reg.diag?.recognizedNames));
}

procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
console.log(`\n──────── 自助路線測試結果：${pass} 通過 / ${fail} 失敗（${Date.now() - t0} ms）────────`);
process.exit(fail ? 1 : 0);
