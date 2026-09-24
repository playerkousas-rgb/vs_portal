/* ============================================================
   tests/gate-env.mjs — 多旅團「Vercel 環境變數登記」＋ 示範模式逃生門
   ------------------------------------------------------------
   呢個檔係為咗兩個 2026-09-17 團長回報嘅真實問題寫嘅：

   ① 「旅團後端／API Key 全用 Vercel 環境變數登記，但首頁揀唔到自己旅團」
      - 旅團清單真係有出現（regression：/api/units → 閘）
      - 去過 MOCK 之後再揀真旅團，一定要真係入真實模式
        （以前 localStorage 嘅 mode=mock 會蓋過 URL 嘅 ?u=0082
          → 資料庫 key 變咗示範空間、又唔會同步後端）
      - 清單讀唔到時要有得「直接輸入編號」入去 + 診斷

   ② 「入咗 MOCK 之後好難離開」
      - 示範唔會再自動記住（下次由普通網址開一定返旅團選擇閘）
      - ?u=MOCK（冇 mock=1）唔會變咗一個「真旅團 MOCK」空殼
      - 離開示範清晒 mode／unit／已揀記錄／session
      - 有「返 <真實旅團>」一撳返自己團

   用法：node tests/gate-env.mjs
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import unitsHandler from '../api/units.js';
import { getRegistry, getTrustedUnit, listPublicUnits, registryDiagnostics } from '../api/_registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
let pass = 0, fail = 0;
const errors = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const GAS_81 = 'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';
const GAS_82 = 'https://script.google.com/macros/s/AKfycbTEST82FixtureOnlyNotRealDeployment00000000000/exec';

/* 真旅團（Vercel 環境變數登記）—— 同生產完全一樣嘅登記方式 */
process.env.TROOP_0081_BACKEND = GAS_81;
process.env.TROOP_0081_APIKEY = 'troop_81_secret_should_never_reach_browser';
process.env.TROOP_0081_NAME = '第八十一旅深資童軍團';

/* ============================================================
   fetch：/api/units 行**真**嘅 Vercel handler，其他檔案由 repo 讀
   ============================================================ */
function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
function callUnitsApi(url, headers = {}) {
  const q = String(url).split('?')[1] || '';
  const res = mockRes();
  unitsHandler({
    method: 'GET', url: String(url), headers,
    query: Object.fromEntries(new URLSearchParams(q))
  }, res);
  return res;
}

globalThis.fetch = async (url) => {
  const raw = String(url);
  const clean = raw.split('?')[0].replace(/^\.?\//, '');
  if (/^api\/units$/.test(clean)) {
    const res = callUnitsApi(raw);
    return { ok: res.statusCode === 200, status: res.statusCode, json: async () => res.body, text: async () => JSON.stringify(res.body) };
  }
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* ============================================================
   一部「瀏覽器」
   ============================================================ */
function makeBrowser(url, prefill = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url, pretendToBeVisual: true, runScripts: 'dangerously'
  });
  const { window } = dom;
  window.scrollTo = () => {};
  try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }

  /* 捕捉「轉頁」：jsdom 唔會真係轉，用 Proxy 接住 location.href = …
     （一定要喺掛 globalThis.location 之前換，否則 module 拎到嘅係原本嗰個） */
  const nav = { href: '' };
  const locProxy = new Proxy(window.location, {
    set(t, k, v) { if (k === 'href') nav.href = String(v); return true; },
    get(t, k) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
  });
  try { Object.defineProperty(window, 'location', { configurable: true, value: locProxy }); } catch { /* jsdom 唔畀換 window.location */ }

  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
    if (window[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
    catch { /* 唯讀 → 略過 */ }
  }
  /* app 嘅 module 用嘅係全域 location —— 一定要換成 proxy 先捕捉到轉頁 */
  try { Object.defineProperty(globalThis, 'location', { value: locProxy, configurable: true, writable: true }); } catch { /* ignore */ }
  globalThis.window = window;
  for (const [k, v] of Object.entries(prefill)) window.localStorage.setItem(k, v);
  return { dom, window, nav };
}

/* ============================================================
   ① 首頁旅團閘：Vercel 登記嘅旅團要出現
   ============================================================ */
section('首頁旅團閘（Vercel 環境變數登記）');
{
  const { window, nav } = makeBrowser('http://localhost:8080/');
  await import('../assets/js/main.js?gateenv1=1');
  await wait(600);

  const doc = window.document;
  const text = () => (doc.getElementById('app')?.textContent || '').replace(/\s+/g, ' ');
  ok('第一步仍然係旅團選擇閘', /揀你嘅旅團/.test(text()));
  ok('★ 環境變數登記嘅 0081 出現在清單', !!doc.querySelector('[data-pick="0081"]'),
    [...doc.querySelectorAll('[data-pick]')].map(b => b.dataset.pick).join(','));
  ok('旅團名由 TROOP_0081_NAME 讀到', /第八十一旅深資童軍團/.test(text()));
  ok('檔案登記嘅 0082 同場出現', !!doc.querySelector('[data-pick="0082"]'));
  ok('標示「Vercel 登記」', /Vercel 登記/.test(text()));
  ok('閘面顯示伺服器登記狀態（0081 環境變數＋0082 檔案＝2 個旅團）',
    /伺服器登記（Vercel 環境變數）：/.test(text()) && /2 個旅團/.test(text()), text().slice(0, 120));
  ok('有「重新載入清單」同「診斷伺服器登記」入口',
    !!doc.querySelector('[data-act="reload"]') && !!doc.querySelector('[data-act="diag"]'));
  ok('清單冇外洩 API Key', !text().includes('troop_81_secret_should_never_reach_browser'));

  /* 就算清單因為任何原因見唔到（未 redeploy／環境變數打錯名），
     管理員都可以直接輸入編號入去 —— 唔會再完全冇路走 */
  const input = doc.getElementById('gateCode');
  ok('有「直接輸入旅團編號」欄位', !!input);
  input.value = '0082';
  doc.querySelector('[data-act="goto-code"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(50);
  ok('★ 直接輸入編號一樣入得去（?u=0082 冇 mock=1）',
    /[?&]u=0082/.test(nav.href) && !/mock=1/.test(nav.href), nav.href || '（冇捕捉到轉頁）');
  ok('入真實旅團時一齊清走 mock 記錄',
    window.localStorage.getItem('venture82.mode.v2') === 'real',
    String(window.localStorage.getItem('venture82.mode.v2')));
}

/* ============================================================
   ② 示範模式唔會自動記住（唔會困死）
   ============================================================ */
section('示範模式唔會自動記住（重新開網站一定見到旅團閘）');
{
  const { window } = makeBrowser('http://localhost:8080/', {
    'venture82.unitChosen.v2': 'MOCK',
    'venture82.mode.v2': 'mock',
    'venture82.currentUnit.v2': 'MOCK'
  });
  await import('../assets/js/main.js?gateenv2=1');
  await wait(600);
  const doc = window.document;
  const text = () => (doc.getElementById('app')?.textContent || '').replace(/\s+/g, ' ');
  ok('★ 之前撳過 MOCK，今次開首頁都要回到旅團選擇閘', /揀你嘅旅團/.test(text()), text().slice(0, 80));
  ok('唔會自動入返示範', !/示範模式（MOCK）中/.test(text()));
  ok('MOCK 選項仍然喺度（想再試就撳）', !!doc.querySelector('[data-pick="MOCK"]'));
}

/* ============================================================
   ③ 由 MOCK 揀返真旅團 → 真實模式（核心 regression）
   ============================================================ */
section('去過 MOCK 之後，揀返 Vercel 登記嘅旅團');
{
  const { window } = makeBrowser('http://localhost:8080/?mock=1&u=MOCK');
  const store = await import('../assets/js/lib/store.js');
  const units = await import('../assets/js/lib/units.js');
  await units.loadRegistry(true);

  await store.init();
  ok('第一步：真係入咗示範模式', store.isMock() === true && store.currentUnit() === 'MOCK',
    `${store.currentMode()}/${store.currentUnit()}`);

  /* 用家返旅團閘，揀 0081（＝URL ?u=0081、冇 mock=1） */
  window.history.replaceState({}, '', '/?u=0081');
  window.localStorage.setItem('venture82.unitChosen.v2', '0081');
  await store.init();
  ok('★ 揀真旅團之後 ＝ 真實模式（唔再被 localStorage 嘅 mode=mock 蓋住）',
    store.isMock() === false, `實際：${store.currentMode()}`);
  ok('★ 旅團編號正確', String(store.currentUnit()) === '0081', String(store.currentUnit()));
  ok('真實模式記錄寫返正確', window.localStorage.getItem('venture82.mode.v2') === 'real',
    String(window.localStorage.getItem('venture82.mode.v2')));
  ok('記住咗最後一個真實旅團（離開示範時用）', store.lastRealUnit() === '0081', store.lastRealUnit());

  /* 之後開普通網址（冇 u=）都應該仍然係真實 0081，唔會彈返示範 */
  window.history.replaceState({}, '', '/');
  await store.init();
  ok('之後開首頁仍然係真實 0081', store.isMock() === false && String(store.currentUnit()) === '0081',
    `${store.currentMode()}/${store.currentUnit()}`);
}

/* ============================================================
   ④ ?u=MOCK／?mock=1 嘅寫法都唔會整出「空殼旅團」
   ============================================================ */
section('示範模式網址嘅各種寫法');
{
  const { window } = makeBrowser('http://localhost:8080/?u=MOCK');
  const store = await import('../assets/js/lib/store.js');

  await store.init();
  ok('★ ?u=MOCK（冇 mock=1）＝ 示範模式（唔會變成「真旅團 MOCK」空殼）',
    store.isMock() === true, `${store.currentMode()}/${store.currentUnit()}`);
  ok('唔會報「讀唔到資料檔」', store.seedInfo().failed === false, JSON.stringify(store.seedInfo()));

  window.history.replaceState({}, '', '/?mock=1&u=0081');
  await store.init();
  ok('?mock=1 就算夾住 ?u=0081 都係入示範（唔會攪亂真旅團資料）',
    store.isMock() === true && String(store.currentUnit()) === 'MOCK',
    `${store.currentMode()}/${store.currentUnit()}`);
}

/* ============================================================
   ⑤ 離開示範：清得乾淨 ＋ 一撳返真實旅團
   ============================================================ */
section('離開示範唔可以困死用家');
{
  const { window, nav } = makeBrowser('http://localhost:8080/?mock=1&u=MOCK');
  const store = await import('../assets/js/lib/store.js');
  const auth = await import('../assets/js/lib/auth.js');
  await store.init();
  auth.loginAsMock('leader');
  window.localStorage.setItem('venture82.unitChosen.v2', 'MOCK');
  window.history.replaceState({}, '', '/?u=0081');
  await store.init();                       /* 建立 lastReal=0081 之後再返示範 */
  window.history.replaceState({}, '', '/?mock=1&u=MOCK');
  await store.init();

  ok('離開之前：示範 session', auth.current()?.mock === true);
  store.exitMock();
  ok('★ 清走 mode 記錄', window.localStorage.getItem('venture82.mode.v2') === null);
  ok('★ 清走旅團記錄', window.localStorage.getItem('venture82.currentUnit.v2') === null);
  ok('★ 清走「已揀旅團」記錄', window.localStorage.getItem('venture82.unitChosen.v2') === null);
  ok('★ 清走示範 session（唔會用示範身份碰真資料）', auth.current() === null);
  ok('重載網址冇 mock=1 亦冇 u=', !/mock=1/.test(nav.href) && !/[?&]u=/.test(nav.href), nav.href);

  /* 「返真實旅團」 */
  const b2 = makeBrowser('http://localhost:8080/?mock=1&u=MOCK', {
    'venture82.lastRealUnit.v2': '0081'
  });
  const store2 = await import('../assets/js/lib/store.js');
  await store2.init();
  ok('示範模式記得住最後一個真實旅團', store2.lastRealUnit() === '0081', store2.lastRealUnit());
  store2.exitMockToUnit();
  ok('★「返真實旅團」會帶 ?u=0081 而冇 mock=1',
    /[?&]u=0081/.test(b2.nav.href) && !/mock=1/.test(b2.nav.href), b2.nav.href);
  ok('示範痕跡一樣清晒', b2.window.localStorage.getItem('venture82.mode.v2') === null
    && b2.window.localStorage.getItem('venture82.unitChosen.v2') === null);
}

/* ============================================================
   ⑥ 示範模式裡面：離開示範嘅掣要周圍都有（唔會搵唔到）
   ============================================================ */
section('示範模式裡面嘅逃生門');
{
  const { window, nav } = makeBrowser('http://localhost:8080/?mock=1&u=MOCK', {
    'venture82.lastRealUnit.v2': '0082'
  });
  await import('../assets/js/main.js?gateenv3=1');
  await wait(700);
  const doc = window.document;
  const store = await import('../assets/js/lib/store.js');
  ok('示範模式已經啟動', store.isMock() === true);
  ok('★ 黃色橫額有「離開示範」', !!doc.getElementById('mockExit'));
  ok('★ 橫額仲有「返 0082（真實）」', !!doc.getElementById('mockBackReal'));
  ok('★ 頂部 bar 亦有「離開示範」（唔使搵橫額都撳到）', !!doc.getElementById('topMockExit'));
  /* ★ 2026-09-25 團長：「進入旅團後,旁邊選單第二行"選擇旅團"沒有用，都進入了還選什麼？
     只須要下方登出」。→ 側邊欄唔應該再有旅團切換掣，但底部登出必須仲喺度。 */
  ok('★ 側邊欄已經冇「選擇旅團」掣', !doc.getElementById('unitSwitch'));
  ok('★ 底部「登出」仍然喺度', !!doc.getElementById('btnLogout'));

  /* 手機「更多」選單：示範模式應該係「離開示範」，唔係淨係「登出」 */
  doc.querySelector('[data-nav="more"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  const moreText = [...doc.querySelectorAll('[data-more]')].map(b => b.textContent.trim()).join('|');
  ok('★ 「更多」選單寫住「離開示範」（唔係登出之後困喺登入畫面）',
    /離開示範/.test(moreText), moreText || '（搵唔到選單）');

  /* 撳頂部嗰粒：一定要清晒示範痕跡再轉頁 */
  doc.getElementById('topMockExit')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(80);
  ok('★ 撳頂部「離開示範」即刻清走示範記錄',
    window.localStorage.getItem('venture82.mode.v2') === null
    && window.localStorage.getItem('venture82.unitChosen.v2') === null);
  ok('轉頁之後唔會再帶 mock=1／u=', !/mock=1/.test(nav.href) && !/[?&]u=/.test(nav.href), nav.href);
}

/* ============================================================
   ⑦ 伺服器端 Registry：變數名寫法同診斷
   ============================================================ */
section('Vercel 環境變數登記（彈性寫法）');
{
  ok('TROOP_<編號>_BACKEND 認得', !!getRegistry()['0081']);
  ok('TROOP_<編號>_APIKEY 唔會出現在公開清單',
    listPublicUnits()['0081'].apiKey === undefined && listPublicUnits()['0081'].gasUrl === undefined);
  ok('公開清單講清楚後端已驗證', listPublicUnits()['0081'].backendReady === true);
  ok('getTrustedUnit 拎到後端＋伺服器端 Key', getTrustedUnit('0081')?.apiKey === 'troop_81_secret_should_never_reach_browser');

  /* 常見打錯／另一種寫法 */
  process.env.TROOP_82_URL = GAS_82;                     // 用 URL 代替 BACKEND
  process.env.TROOP_0099_BACKEND_URL = GAS_82;           // 用 BACKEND_URL
  process.env.TROOP_0100_GASURL = GAS_82;                // 用 GASURL（舊名）
  process.env.TROOP_0101_KEY = 'k101';                   // 用 KEY 代替 APIKEY
  process.env.TROOP0082_BACKEND = GAS_82;                // 打錯名（少一個 _）
  process.env.TROOP_82_BACKENDXD = 'oops';               // 打錯名（多咗字）

  const reg = getRegistry();
  ok('TROOP_82_URL 都認得（唔一定要叫 BACKEND）', !!reg['82'] && reg['82'].backendTrusted);
  ok('TROOP_0099_BACKEND_URL 都認得', !!reg['0099'] && reg['0099'].backendTrusted);
  ok('TROOP_0100_GASURL 都認得', !!reg['0100'] && reg['0100'].backendTrusted);
  ok('TROOP_0101_KEY 當 API Key 用', reg['0101']?.backend?.apiKey === 'k101');

  /* 前導零：TROOP_82_* 同 TROOP_0082_* 要互通 */
  ok('TROOP_82_URL 亦可以當 0082 用', !!reg['0082'] || !!reg['82']);

  /* 同一旅多個獨立團：只有 Vercel 變數 ID 加數字後綴，唔改 GAS URL／Key 配對。 */
  process.env.TROOP_0082_1_BACKEND = GAS_82;
  process.env.TROOP_0082_1_APIKEY = 'troop_82_1_secret_should_never_reach_browser';
  process.env.TROOP_0082_1_NAME = '第八十二旅第一團';
  const suffixed = getRegistry();
  ok('TROOP_0082_1_* 可作獨立 Registry ID', suffixed['0082_1']?.backend?.gasUrl === GAS_82);
  ok('後綴 Registry 仍讀到自己的 API Key', suffixed['0082_1']?.backend?.apiKey === 'troop_82_1_secret_should_never_reach_browser');
  ok('後綴 Registry 對外仍只公開 NAME',
    listPublicUnits()['0082_1']?.name === '第八十二旅第一團' &&
    listPublicUnits()['0082_1']?.apiKey === undefined &&
    listPublicUnits()['0082_1']?.gasUrl === undefined);

  const d = registryDiagnostics();
  ok('診斷列出認到嘅旅團', d.ids.includes('0081') && d.count >= 1, JSON.stringify(d.ids));
  ok('★ 診斷會指出打錯名嘅變數（可能就係旅團唔出現嘅原因）',
    d.suspicious.includes('TROOP0082_BACKEND') && d.suspicious.includes('TROOP_82_BACKENDXD'),
    JSON.stringify(d.suspicious));
  ok('診斷列出有 Key 嘅旅團（只有名）', d.withKey.includes('0081'));
  ok('★ 診斷永遠唔會洩漏 Key 值',
    !JSON.stringify(d).includes('troop_81_secret_should_never_reach_browser'));
  ok('診斷會講明 /exec 白名單要求', /script\.google\.com/.test(d.notice));

  /* 簡寫：TROOP_0095 = <exec URL> */
  process.env.TROOP_0095 = GAS_82;
  ok('簡寫 TROOP_0095 = /exec 都認得', getRegistry()['0095']?.backendTrusted === true);
  ok('簡寫都唔會被當成打錯名', registryDiagnostics().recognizedNames.includes('TROOP_0095'));
  process.env.TROOP_0094 = 'https://evil.example.com/exec';
  ok('簡寫但唔係 GAS /exec → 唔會當後端（安全）', !getRegistry()['0094']?.backendTrusted);

  /* 唔合法嘅後端 URL 要當「未設定」（唔可以變成攻擊入口） */
  process.env.TROOP_0097_BACKEND = 'http://evil.example.com/exec';
  const reg2 = getRegistry();
  ok('非 GAS /exec 嘅 URL 唔會被信任', reg2['0097']?.backendTrusted === false);
  ok('唔信任嘅旅團攞唔到後端', getTrustedUnit('0097') === null);
  ok('但公開清單會照列出嚟（畀管理員見到未設定好）',
    listPublicUnits()['0097']?.backendReady === false);

  /* /api/units?diag=1 */
  const res = callUnitsApi('api/units?diag=1');
  ok('★ /api/units?diag=1 回傳診斷', res.statusCode === 200 && !!res.body?.diag);
  ok('診斷唔會帶任何值落 public units', !JSON.stringify(res.body.units).includes('troop_81_secret'));
  const resNoDiag = callUnitsApi('api/units');
  ok('冇 diag 就唔會多送診斷資料', resNoDiag.body.diag === undefined);
  ok('清單回 count', resNoDiag.body.count === Object.keys(resNoDiag.body.units).length);

  /* TROOPS_JSON：一次過登記（應急用） */
  process.env.TROOPS_JSON = JSON.stringify({ '0096': { backend: GAS_82, name: '第九十六旅' } });
  ok('TROOPS_JSON 都開得旅團', !!getRegistry()['0096']);
  ok('TROOPS_JSON 唔會被列做「打錯名」', !registryDiagnostics().suspicious.includes('TROOPS_JSON'));
  process.env.TROOPS_JSON = '唔係 JSON';
  ok('TROOPS_JSON 壞咗唔會拖冧 Registry', typeof getRegistry() === 'object');
  delete process.env.TROOPS_JSON;

  for (const k of ['TROOP_82_URL', 'TROOP_0099_BACKEND_URL', 'TROOP_0100_GASURL', 'TROOP_0101_KEY',
    'TROOP0082_BACKEND', 'TROOP_82_BACKENDXD', 'TROOP_0097_BACKEND', 'TROOP_0095', 'TROOP_0094',
    'TROOP_0082_1_BACKEND', 'TROOP_0082_1_APIKEY', 'TROOP_0082_1_NAME']) delete process.env[k];
}

/* ============================================================
   ⑧ 「Production 變數 + Preview 網址」情境（真 Vercel 最常見陷阱）
   ------------------------------------------------------------
   變數只勾 Production，用家開 Preview／臨時網址 → process.env 一個都冇。
   呢個時候診斷一定要講得出「而家係咩環境／開緊邊個 host」＋ 點做。
   ============================================================ */
section('部署環境對唔上（變數只勾 Production）');
{
  /* 模擬 Preview 部署：冇晒 TROOP_*，但有 VERCEL_ENV=preview */
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (/^TROOP/i.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  const savedVercel = process.env.VERCEL_ENV;
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_REGION = 'hkg1';

  const res = callUnitsApi('https://ecportal-git-abc123.vercel.app/api/units?diag=1',
    { host: 'ecportal-git-abc123.vercel.app' });
  ok('★ Preview 環境認唔到任何 TROOP_* 變數', res.body.diag.recognizedNames.length === 0,
    JSON.stringify(res.body.diag.recognizedNames));
  ok('檔案登記嘅 0082 照出現（名單唔依賴環境變數）',
    res.body.count === 1 && !!res.body.units['0082'], String(res.body.count));
  ok('★ 診斷講清楚而家嘅部署環境', res.body.diag.vercelEnv === 'preview', JSON.stringify(res.body.diag.vercelEnv));
  ok('★ 診斷帶埋用家開緊嘅 host（畀管理員核對係唔係正式網域）',
    res.body.diag.host === 'ecportal-git-abc123.vercel.app', res.body.diag.host);
  ok('診斷照樣唔會洩漏任何值', !JSON.stringify(res.body.diag).includes('troop_81_secret'));

  /* 閘面要真係顯示呢個提示（唔止 API 有） */
  const { window } = makeBrowser('http://localhost:8080/');
  const units = await import('../assets/js/lib/units.js?preview=1');
  await units.loadRegistry(true);
  ok('前端狀態列記得住「讀到，檔案嘅 0082」', units.serverUnitsStatus().ok === true
    && units.serverUnitsStatus().count === 1, JSON.stringify(units.serverUnitsStatus()));
  ok('前端照樣揀到 0082', units.unitList().some(u => String(u.code) === '0082'));

  process.env.VERCEL_ENV = savedVercel;
  delete process.env.VERCEL;
  delete process.env.VERCEL_REGION;
  if (savedVercel === undefined) delete process.env.VERCEL_ENV;
  Object.assign(process.env, saved);
  ok('還原之後 0081 返嚟', !!getRegistry()['0081']);
}

/* ============================================================
   ⑨ 伺服器一時讀唔到（例如部署緊／網絡 blip）：唔可以洗走記住咗嘅旅團
   ------------------------------------------------------------
   2026-09-17 0082 事件：data/units.json 本身係空但讀得到，
   /api/units 一時 404 → 合併結果係空 → 記住咗嘅 0082 被洗走，
   成個閘變空。而家：讀唔齊嗰陣用上次記住嘅頂住。
   ============================================================ */
section('伺服器一時讀唔到：舊清單要頂住（唔可以洗走旅團）');
{
  const { window } = makeBrowser('http://localhost:8080/', {
    'venture82.units.cache.v2': JSON.stringify({ schema: 2, defaultUnit: '', units: {
      '0082': { code: '0082', name: '第八十二旅深資童軍團', server: true, fromApi: true, backendReady: true }
    } })
  });
  const memFetch = globalThis.fetch;

  /* 情況一：靜態檔讀到但係空 ＋ /api/units 一時 404 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (/^api\/units/.test(clean)) {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '<h1>404</h1>' };
    }
    /* ★ 一定要 stub 埋焗名單：呢三個 case 驗嘅係「冇焗名單」嗰陣嘅行為。
       以前呢度漏咗 stub，跌去 memFetch 讀 repo 真檔 —— 而
       data/units.generated.json 係 `npm run build`／Vercel build 生成嘅，
       所以「跑過 build 之後再跑 test」就會假紅燈（2026-09-20 先至暴露）。 */
    if (clean === 'data/units.generated.json') {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    if (clean === 'data/units.json') {
      /* 呢個 case 要驗「檔讀到但係空」—— 唔讀真檔（真檔而家有 0082 名單） */
      const body = { schema: 2, defaultUnit: '', units: {} };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return memFetch(url);
  };
  const units = await import('../assets/js/lib/units.js?stale1=1');
  await units.loadRegistry(true);
  globalThis.fetch = memFetch;
  ok('★ /api 404 都唔會洗走記住咗嘅 0082',
    units.unitList().some(u => String(u.code) === '0082'),
    units.unitList().map(u => u.code).join(',') || '（空）');
  ok('會標示而家係舊清單', units.registryStale() === true);
  ok('localStorage 嗰份好嘅唔會被空殼覆蓋',
    (JSON.parse(window.localStorage.getItem('venture82.units.cache.v2') || '{}').units || {})['0082'] !== undefined);

  /* 情況二：伺服器正常回覆「0 個旅團」→ 係真・冇登記，舊嘅要清走 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (/^api\/units/.test(clean)) {
      const body = { units: {}, count: 0 };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    /* 同上：焗名單都要 stub 走，否則跑過 build 之後呢個 case 會假紅燈 */
    if (clean === 'data/units.generated.json') {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    if (clean === 'data/units.json') {
      /* 呢個 case 要驗「真係一個都未登記」—— 唔讀真檔（真檔而家有 0082 名單） */
      const body = { schema: 2, defaultUnit: '', units: {} };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return memFetch(url);
  };
  const units2 = await import('../assets/js/lib/units.js?stale2=1');
  await units2.loadRegistry(true);
  globalThis.fetch = memFetch;
  ok('伺服器正常回 0 個旅團 → 清單真係空（舊嘅唔會陰魂不散）',
    units2.unitList().length === 0, units2.unitList().map(u => u.code).join(','));
  ok('正常清空唔會標 stale', units2.registryStale() === false);

  /* 情況三：檔案嗰邊有貨、/api 嗰邊 500 → 兩邊加埋，唔可以唔見咗一邊 */
  window.localStorage.setItem('venture82.units.cache.v2', JSON.stringify({ schema: 2, defaultUnit: '', units: {
    '0082': { code: '0082', name: '第八十二旅深資童軍團', server: true, fromApi: true, backendReady: true }
  } }));
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (/^api\/units/.test(clean)) {
      return { ok: false, status: 500, json: async () => { throw new Error('500'); }, text: async () => 'error' };
    }
    /* 同上：焗名單都要 stub 走 */
    if (clean === 'data/units.generated.json') {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    if (clean === 'data/units.json') {
      const body = { schema: 2, defaultUnit: '', units: { '0100': { code: '0100', name: '第一百旅' } } };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return memFetch(url);
  };
  const units3 = await import('../assets/js/lib/units.js?stale3=1');
  await units3.loadRegistry(true);
  globalThis.fetch = memFetch;
  const codes3 = units3.unitList().map(u => String(u.code)).sort();
  ok('★ 檔案嘅 0100 照見到', codes3.includes('0100'), codes3.join(','));
  ok('★ 記住咗嘅 0082 補得返', codes3.includes('0082'), codes3.join(','));
  ok('合併咗舊貨會標 stale', units3.registryStale() === true);
}

/* ============================================================
   ⑩ 舊系統退役截停（喺 82venture.vercel.app 開會見到搬遷提示）
   ------------------------------------------------------------
   舊站係冇後端嘅空站（/api 全部 404），喺嗰度開工只會
   「揀唔到旅團、儲存唔到」。如果新 code 喺舊 host 度跑，
   boot 第一時間就要截停，指去新系統。
   ============================================================ */
section('舊系統退役截停');
{
  const { window } = makeBrowser('https://82venture.vercel.app/');
  await import('../assets/js/main.js?legacy1=1');
  await wait(400);
  const doc = window.document;
  const text = () => (doc.getElementById('app')?.textContent || '').replace(/\s+/g, ' ');
  ok('★ 舊站會截停並顯示搬遷提示', /已經搬遷/.test(text()), text().slice(0, 100));
  ok('有去新系統嘅連結', !!doc.querySelector('a[href*="ecportal.vercel.app"]'));
  ok('唔會出現旅團閘（唔畀人喺空站開工）', !/揀你嘅旅團/.test(text()));
}
{
  /* 正常 host 唔受影響 */
  const { window } = makeBrowser('http://localhost:8080/');
  await import('../assets/js/main.js?legacy2=1');
  await wait(600);
  const text = () => (window.document.getElementById('app')?.textContent || '').replace(/\s+/g, ' ');
  ok('正常網址唔會被截停（照見旅團閘）', /揀你嘅旅團/.test(text()), text().slice(0, 80));
  ok('正常網址唔會彈搬遷提示', !/已經搬遷/.test(text()));
}

/* ============================================================
   ⑪ 部署時焗好嘅名單（靜態 data/units.generated.json 行先）
   ------------------------------------------------------------
   2026-09-18 真實事件：有用戶 fetch('api/units') 一律 HTTP 404
   （唔同機、唔同網絡、唔同 browser 都係），但網址列直接開就 200。
   教每個用戶搞設定係冇意思嘅 —— 名單改為 build 嗰陣焗入靜態檔，
   閘面攞靜態行先，/api 留做後備＋診斷。
   ============================================================ */
section('部署名單（靜態檔行先，/api 404 都照有得揀）');
{
  const BAKED_82 = { schema: 2, generatedAt: '2026-09-18T00:00:00.000Z', vercelEnv: 'production',
    units: { '0082': { code: '0082', name: '第八十二旅深資童軍團', nameEn: '', short: '0082venture',
      section: '深資童軍', region: '', sponsor: '', address: '', theme: null,
      progressServerSide: false, noticeReady: true, server: true, backendReady: true } }, count: 1,
    diagNames: { recognizedNames: ['TROOP_0082_BACKEND'], suspicious: [], withKey: ['0082'], trusted: ['0082'], withName: ['0082'] } };
  const memFetch11 = globalThis.fetch;

  /* 情況一：用戶嘅真實情況 —— 靜態焗名單有 0082，/api/units 404 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'data/units.generated.json') {
      return { ok: true, status: 200, json: async () => BAKED_82, text: async () => JSON.stringify(BAKED_82) };
    }
    if (/^api\/units/.test(clean)) {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    return memFetch11(url);
  };
  const units = await import('../assets/js/lib/units.js?bake1=1');
  await units.loadRegistry(true);
  ok('★ /api 404，但焗名單嘅 0082 照出現', units.unitList().some(u => String(u.code) === '0082'),
    units.unitList().map(u => u.code).join(',') || '（空）');
  ok('焗名單狀態記得住（1 個旅團）', units.bakedUnitsStatus().ok === true && units.bakedUnitsStatus().count === 1,
    JSON.stringify(units.bakedUnitsStatus()));
  ok('即時 API 狀態照樣誠實記錄失敗', units.serverUnitsStatus().ok === false);
  ok('有第一手名單就唔標 stale', units.registryStale() === false);
  ok('焗名單嘅旅團一樣標示 server（閘面會寫 Vercel 登記）',
    units.unitEntry('0082')?.server === true);
  ok('焗名單嘅旅團唔會被當成有資料夾（由空白開始）', units.dataPathOf('0082') === null);

  /* 閘面：初次 render 用嘅係 shared cache（§1 留低嘅 0081）唔會 fetch ——
     撳「重新載入清單」先會用而家嘅 fetch（焗名單 0082＋/api 404）重載，
     呢個正正就係真實用戶撳嗰粒掣嘅流程 */
  const { window } = makeBrowser('http://localhost:8080/');
  await import('../assets/js/main.js?bake1=1');
  await wait(600);
  const doc = window.document;
  const text = () => (doc.getElementById('app')?.textContent || '').replace(/\s+/g, ' ');
  doc.querySelector('[data-act="reload"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);
  ok('★ 撳「重新載入清單」之後閘面有 0082 揀', !!doc.querySelector('[data-pick="0082"]'));
  ok('閘面顯示「部署名單」而唔係紅色錯誤', /部署名單/.test(text()) && !/讀唔到伺服器登記清單/.test(text()),
    text().slice(0, 120));
  globalThis.fetch = memFetch11;

  /* 情況二：舊部署（冇焗名單檔）＋ /api 正常 —— 行為同以前一模一樣 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'data/units.generated.json') {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    return memFetch11(url);   // api/units 行真 handler（TROOP_0081_*），data/units.json 讀 repo 檔
  };
  const units2 = await import('../assets/js/lib/units.js?bake2=1');
  await units2.loadRegistry(true);
  ok('冇焗名單檔：/api 嘅 0081 照出現（向後兼容）',
    units2.unitList().some(u => String(u.code) === '0081'),
    units2.unitList().map(u => u.code).join(',') || '（空）');
  ok('冇焗名單檔：焗狀態係「冇」而唔係錯', units2.bakedUnitsStatus().ok === false && units2.bakedUnitsStatus().at !== '');
  globalThis.fetch = memFetch11;

  /* 情況三：兩邊都有 —— 合併，唔會唔見咗一邊 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'data/units.generated.json') {
      return { ok: true, status: 200, json: async () => BAKED_82, text: async () => JSON.stringify(BAKED_82) };
    }
    return memFetch11(url);
  };
  const units3 = await import('../assets/js/lib/units.js?bake3=1');
  await units3.loadRegistry(true);
  globalThis.fetch = memFetch11;
  const codes3 = units3.unitList().map(u => String(u.code));
  ok('★ 焗名單嘅 0082 同 /api 嘅 0081 兩邊都見到',
    codes3.includes('0082') && codes3.includes('0081'), codes3.join(','));
}

/* ============================================================
   ⑫ 檔案名單（Git JSON：/api 同焗名單死晒都照有得揀）
   ------------------------------------------------------------
   2026-09-18 之後嘅主流程：名單返嚟 Git 靜態檔，唔再淨係靠
   runtime /api。呢度讀 repo 真檔（唔係 fixture），驗端到端。
   ============================================================ */
section('檔案名單（淨靠 Git JSON 都入到閘）');
{
  const memFetch12 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (/^api\/units/.test(clean) || clean === 'data/units.generated.json') {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    return memFetch12(url);   // data/units.json 讀 repo 真檔
  };
  const units = await import('../assets/js/lib/units.js?filefirst=1');
  await units.loadRegistry(true);
  const e82 = units.unitEntry('0082') || {};
  ok('★ /api 同焗名單死晒，檔案嘅 0082 照出現',
    units.unitList().some(u => String(u.code) === '0082'),
    units.unitList().map(u => u.code).join(',') || '（空）');
  ok('檔案名正確', e82.name === '第八十二旅深資童軍團', e82.name);
  ok('★ 檔案 entry 冇後端冇 Key（密鑰唔落 Git）',
    e82.backend === undefined && e82.apiKey === undefined && !JSON.stringify(e82).includes('script.google'));
  ok('未配後端 ＝ backendOf 係 null（唔會借用人哋張 Sheet）', units.backendOf('0082') === null);

  /* 閘面端到端：撳「重新載入清單」→ 0082 照揀得（兩條伺服器路會如實顯示紅字） */
  const { window } = makeBrowser('http://localhost:8080/');
  await import('../assets/js/main.js?filefirst=1');
  await wait(600);
  const doc = window.document;
  const text = () => (doc.getElementById('app')?.textContent || '').replace(/\s+/g, ' ');
  doc.querySelector('[data-act="reload"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);
  ok('★ 閘面有 0082 揀（淨靠檔案）', !!doc.querySelector('[data-pick="0082"]'));
  ok('兩條伺服器路死晒會如實顯示紅字（但唔阻揀旅團）', /讀唔到伺服器登記清單/.test(text()));
  globalThis.fetch = memFetch12;
}

/* ============================================================
   ⑬ 兩條路並行：閘面分得清邊個旅團嚟自邊條路
   ------------------------------------------------------------
   檔案（0082）＋ 即時 API（0033 fixture）同時跑 —— 閘面 subline
   同診斷 modal 要睇得出邊個嚟自邊條路（唔可以撈埋一齊）。
   ============================================================ */
section('兩條路並行：閘面分得清邊個旅團嚟自邊條路');
{
  const memFetch13 = globalThis.fetch;
  const API_0033 = { units: { '0033': { code: '0033', name: '第三十三旅深資童軍團' } }, count: 1 };
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (/^api\/units/.test(clean)) {
      return { ok: true, status: 200, json: async () => API_0033, text: async () => JSON.stringify(API_0033) };
    }
    if (clean === 'data/units.generated.json') {
      return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
    }
    return memFetch13(url);   // data/units.json 讀 repo 真檔（0082）
  };
  const units = await import('../assets/js/lib/units.js?file13=1');
  await units.loadRegistry(true);
  ok('檔案狀態記得住（0082）', units.fileUnitsStatus().ok === true && units.fileUnitsStatus().count === 1,
    JSON.stringify(units.fileUnitsStatus()));
  ok('即時 API 狀態記得住（0033）', units.serverUnitsStatus().ok === true && units.serverUnitsStatus().count === 1);
  ok('0082 打住檔案旗（冇 Vercel 旗）',
    units.unitEntry('0082')?.fromFile === true && !units.unitEntry('0082')?.fromApi && !units.unitEntry('0082')?.server);
  ok('0033 打住 Vercel 旗（冇檔案旗）',
    units.unitEntry('0033')?.fromApi === true && !units.unitEntry('0033')?.fromFile);

  /* 閘面：subline 標籤分得清 */
  const { window } = makeBrowser('http://localhost:8080/');
  await import('../assets/js/main.js?file13=1');
  await wait(600);
  const doc = window.document;
  doc.querySelector('[data-act="reload"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);
  const sub = (code) => doc.querySelector(`[data-pick="${code}"] .xs.faint`)?.textContent || '';
  ok('★ 0082 標「檔案」唔標 Vercel', /檔案/.test(sub('0082')) && !/Vercel/.test(sub('0082')), sub('0082'));
  ok('★ 0033 標「Vercel 登記」唔標檔案', /Vercel 登記/.test(sub('0033')) && !/檔案/.test(sub('0033')), sub('0033'));

  /* 診斷 modal：三行對照表 */
  const shared = await import('../assets/js/lib/units.js');
  ok('閘面用緊嘅 shared 狀態：檔案 OK', shared.fileUnitsStatus().ok === true);
  doc.querySelector('[data-act="diag"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(400);
  const modalText = doc.querySelector('.overlay .modal')?.textContent.replace(/\s+/g, ' ') || '';
  ok('★ 診斷有「檔案名單」行', /檔案名單/.test(modalText), modalText.slice(0, 100));
  ok('★ 診斷有齊三條路對照', /檔案名單/.test(modalText) && /瀏覽器讀/.test(modalText) && /部署時名單/.test(modalText));
  globalThis.fetch = memFetch13;
}

if (errors.length) {
  console.log(`\n捕捉到 ${errors.length} 個 console.error：`);
  errors.slice(0, 6).forEach(e => console.log('  • ' + e.slice(0, 200)));
}
const ms = Date.now() - t0;
console.log(`\n──────── 旅團登記／示範模式測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
process.exit(fail ? 1 : 0);
