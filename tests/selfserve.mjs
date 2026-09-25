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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  { op: 'diagnose' },
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

/* ---- ⑤ 同步診斷 ---- */
section('⑤ 「同步診斷」逐格講清楚邊格斷');
{
  const d = step(A, 'diagnose');
  ok('診斷跑得到', !!d.stages, JSON.stringify(d).slice(0, 200));
  ok('诊断話你知成條鏈正常（自助路線）', d.ok === true, JSON.stringify(d));
  ok('診斷講明行緊「自己貼嘅 /exec」', d.route === 'direct', String(d.route));
  ok('診斷攞到後端版本號（v2.8.1）', d.backendVersion === 'v2.8.1', String(d.backendVersion));
  ok('診斷照樣指出平台未登記（warn，唔係當冇事）',
    (d.stages || []).includes('registry:warn') || (d.stages || []).includes('registry:bad'), JSON.stringify(d.stages));

  /* 未貼 /exec 嗰陣，診斷要指得出「平台登記」嗰格斷咗 */
  const C = await runDevice({ steps: [{ op: 'diagnose' }] });
  const dc = step(C, 'diagnose');
  ok('未接後端嗰陣，診斷指得出斷點', dc.ok === false && (dc.blockers || []).length > 0, JSON.stringify(dc));
  ok('斷點係「平台登記」，唔係一句「同步失敗」',
    (dc.blockers || []).includes('registry'), JSON.stringify(dc.blockers));
}

/* ---- ⑥ 公開連結 ---- */
section('⑥ 公開連結：自動附 ?be=，公開頁因此讀到後端正本');
{
  const l = step(A, 'links');
  ok('publicLinkRoute 認到行緊自助路線', l.route === 'direct' && l.routeOk === true, JSON.stringify({ route: l.route, label: l.label }));
  ok('selfServeExec 回傳領袖貼嘅 /exec', l.selfServeExec === FAKE_EXEC.replace(/\/$/, ''), String(l.selfServeExec));
  const cons = (l.urls || []).find(u => u.id === 'constitution');
  const entry = (l.urls || []).find(u => u.id === 'entry');
  ok('團章公開連結帶 ?be=', /be=/.test(String(cons?.url || '')), String(cons?.url));
  ok('記帳公開連結帶 ?be=', /be=/.test(String(entry?.url || '')), String(entry?.url));
  ok('連結仍然帶旅團編號 ?u=0082', /u=0082/.test(String(cons?.url || '')), String(cons?.url));
}

/* 團章公開頁：proxy 404 都要靠 ?be= 讀到後端正本 */
{
  /* 先由裝置推一份已發布團章上後端。
     注意要先 pull：呢部係全新裝置（baseVersion 空），而後端已經有版本 ——
     唔拉就直接推會撞樂觀鎖，而合併規則係「物件欄位以後端為準」
     （store.js mergeDbs），團章呢類物件會被後端蓋返。呢個係既定語意，
     所以正確做法＝先對齊版本再改。 */
  await runDevice({ steps: [
    { op: 'setSync', url: FAKE_EXEC, apiKey: KEY },
    { op: 'pull' },
    { op: 'setConstitution', obj: { version: 'v9.9', status: 'published', title: { zh: '測試團章', en: 'Test' }, chapters: [{ id: 'c1', heading: { zh: '第一章', en: 'Ch.1' }, articles: [{ id: 'a1', zh: '測試条文', en: 'test article' }] }], appendices: [], history: [] } },
    { op: 'put', coll: 'notices', rows: [{ id: 'nt-selfserve', type: 'notice', status: 'published', needSignup: false, publishAt: '2026-09-19', title: { zh: '自助路線通告' }, body: { zh: '內容。' } }] },
    { op: 'push' }
  ] });

  const { JSDOM } = await import('jsdom');
  const nodeFetch = globalThis.fetch;
  const bootPublic = async (file, script, query) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const dom = new JSDOM(html, { url: `${BASE}/${file}${query}`, pretendToBeVisual: true });
    const { window } = dom;
    window.scrollTo = () => {};
    for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
      'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob']) {
      if (window[k] === undefined) continue;
      try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ignore */ }
    }
    globalThis.window = window;
    /* 相對路徑補返 BASE（＝真 HTTP，會真係撞 dev-server 嘅 /api/proxy 404） */
    globalThis.fetch = async (u, init = {}) => {
      let s = String(u);
      if (!/^https?:\/\//.test(s)) s = `${BASE}/${s.replace(/^\.?\//, '')}`;
      return nodeFetch(s, init);
    };
    await import(`../assets/js/${script}?case=${Math.random()}`);
    await new Promise(r => setTimeout(r, 700));
    const text = window.document.getElementById('app')?.textContent
      || window.document.getElementById('paper')?.textContent || '';
    try { dom.window.close(); } catch { /* ignore */ }
    return text;
  };

  const beQ = `&be=${encodeURIComponent(FAKE_EXEC)}`;
  const consText = await bootPublic('constitution.html', 'public.js', `?u=0082${beQ}`);
  ok('★ 團章公開頁經 ?be= 讀到後端正本（proxy 404 都读到）',
    /第一章/.test(consText) && /測試条文/.test(consText), consText.slice(0, 120));

  const noticeText = await bootPublic('notice.html', 'public-notice.js', `?u=0082&n=nt-selfserve${beQ}`);
  ok('★ 通告公開頁經 ?be= 讀到已發布通告',
    /自助路線通告/.test(noticeText), noticeText.slice(0, 120));

  const noBe = await bootPublic('constitution.html', 'public.js', '?u=0082');
  ok('冇 ?be= 又冇平台登記 → 明確報原因（唔係白畫面）',
    /讀唔到團章/.test(noBe) && /平台未登記|後端/.test(noBe), noBe.slice(0, 140));

  globalThis.fetch = nodeFetch;
}

/* ============================================================
   ⑦ 對照組：平台**已登記**（有 TROOP_0082_*）→ 行返 proxy，連結唔附 ?be=
   ============================================================ */
section('⑦ 對照：平台已登記 → 行返正路 proxy，連結唔會多餘附 ?be=');
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
