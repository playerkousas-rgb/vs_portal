/* ============================================================
   tests/hub.mjs — 團員入口（members.html）端到端測試
   ------------------------------------------------------------
   對應團長 2026-09-18 回報嘅問題：
     ① 公開連結（IG／FB／網頁）→ 團員入口要顯示到（資料喺後端）
     ② 團員報出席：登入咗就知係邊個，唔可以再叫佢「填自己個名」
        （以前 needName 條路係壞嘅 —— 個名欄根本冇 render，次次都彈提示）
     ③ 登入要保持（localStorage，唔係 sessionStorage）
     ⑤ 截止咗報名嘅通告／過去嘅活動要由清單消失
     ⑥ 新裝置（無痕）開團員入口：由後端拉資料 → 登入得 → RSVP 寫得返上去
   環境：假 GAS（tests/_fakegas.mjs）＋ dev-server（/api/proxy），
   兩個獨立「裝置」：A＝執委（種資料＋推後端）、B＝團員手機（全新）。
   用法：node tests/hub.mjs
   ============================================================ */

import { JSDOM } from 'jsdom';
import http from 'node:http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
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

async function proxyCall(payload) {
  const r = await fetch(`${BASE}/api/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

const runDevice = (plan) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; });
  p.stderr.on('data', d => { err += d; });
  const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（30 秒）' }), 30000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});

try {
  spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
  spawnBg([path.join(ROOT, 'dev-server.mjs')], {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_0082',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT)
  });
  const gasUp = await waitPort(GAS_PORT);
  const webUp = await waitPort(WEB_PORT);
  ok('測試用假後端＋dev-server 已啟動', gasUp && webUp);

  /* ============ 裝置 A（執委）：種團員入口要嘅資料 → 推後端 ============ */
  section('裝置 A（執委）：種資料並推上後端');
  const A = await runDevice({ steps: [
    { op: 'wipe' },
    { op: 'addMember', name: '陳大文', ymis: '2026000001', identity: 'member' },
    { op: 'addMember', name: '李小美', ymis: '2026000002', identity: 'member' },
    { op: 'patchSettings', patch: {
      troopLinks: { instagram: 'https://instagram.com/test82', facebook: 'https://facebook.com/test82', website: 'https://example.com' }
    } },
    { op: 'put', coll: 'events', rows: [
      { id: 'ev_future', title: '秋季露營', date: '2026-12-19', dateEnd: '2026-12-20', time: '09:00', venue: '營地', visibility: 'all', status: 'confirmed', rsvp: {} },
      { id: 'ev_past', title: '舊年活動', date: '2026-01-05', dateEnd: '', time: '', venue: '', visibility: 'all', status: 'confirmed', rsvp: {} }
    ] },
    { op: 'put', coll: 'notices', rows: [
      { id: 'n_open', title: { zh: '開放報名通告' }, status: 'published', needSignup: true, deadline: '2026-12-01', eventDate: '2026-12-19', signups: [] },
      { id: 'n_closed', title: { zh: '已截止報名通告' }, status: 'published', needSignup: true, deadline: '2026-09-01', eventDate: '2026-09-20', signups: [] },
      { id: 'n_plain', title: { zh: '普通通告' }, status: 'published', needSignup: false, signups: [] },
      { id: 'n_draft', title: { zh: '草稿通告' }, status: 'draft', needSignup: true, signups: [] }
    ] },
    { op: 'put', coll: 'quizzes', rows: [
      { id: 'qz1', title: '測驗卷', status: 'open', questions: [{ id: 'qq1', prompt: '1+1=', type: 'single', options: ['1', '2'], required: false }], responses: {} }
    ] },
    { op: 'setConstitution', obj: { version: '3.1', status: 'published', title: { zh: '團章', en: 'Constitution' },
      chapters: [{ heading: { zh: '第一章 總則', en: 'Chapter 1' }, articles: [{ zh: '第 1 條 本團名為測試旅深資童軍團。', en: 'Article 1.', items: [] }] }], appendices: [], history: [] } },
    { op: 'push' }
  ] });
  ok('裝置 A 推後端成功', A.steps?.find(s => s.op === 'push')?.ok === true, JSON.stringify(A.steps?.find(s => s.op === 'push')));

  /* ============ 裝置 B（團員手機，全新）：members.html ============ */
  section('裝置 B（全新團員手機）：團員入口');
  const html = fs.readFileSync(path.join(ROOT, 'members.html'), 'utf8');
  const dom = new JSDOM(html, { url: `${BASE}/members.html?u=0082`, pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  window.scrollTo = () => {};
  try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
  for (const k of ['document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'TextEncoder']) {
    if (window[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ignore */ }
  }
  globalThis.window = window;

  const nodeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let u = String(url);
    if (!/^https?:\/\//.test(u)) u = `${BASE}/${u.replace(/^\.?\//, '')}`;
    return nodeFetch(u, init);
  };

  const doc = window.document;
  await import('../assets/js/public-hub.js');
  await wait(300);

  ok('開機顯示登入閘（YMIS＋密碼）', !!doc.querySelector('#hubLogin'));
  ok('登入閘有同步狀態指示（等團員／領袖知資料係咪最新）', !!doc.querySelector('#hubSync'));

  /* 等開機拉後端完成（登入掣解鎖） */
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await wait(100);
    const b = doc.querySelector('#hubLogin button[type="submit"]');
    ready = !!b && !b.disabled;
  }
  ok('後端名冊拉完之後登入掣解鎖', ready);

  /* 登入：陳大文（首次 1234）—— 名冊只存在於後端，裝置 B 本機係空嘅 */
  doc.querySelector('#hYmis').value = '2026000001';
  doc.querySelector('#hPass').value = '1234';
  doc.querySelector('#hubLogin').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  let logged = false;
  for (let i = 0; i < 100 && !logged; i++) {
    await wait(100);
    logged = !!doc.querySelector('#hubLogout');
  }
  ok('全新裝置用 YMIS＋1234 登入成功（資料係由後端拉返嚟）', logged);
  ok('登入後有強制改密碼彈窗（首次 1234）', !!doc.querySelector('.overlay'));

  /* 收起強制改密碼彈窗（撳「稍後」），睇主頁內容 */
  const later = [...doc.querySelectorAll('.overlay button')].find(b => /稍後/.test(b.textContent || ''));
  later?.click();
  await wait(200);

  const pageTxt = () => doc.getElementById('app').textContent || '';

  section('主頁內容（全部嚟自後端資料）');
  ok('顯示登入團員名（陳大文）', pageTxt().includes('陳大文'));
  ok('旅團連結：IG 有得撳（後台填嘅資料經後端同步過嚟）',
    !!doc.querySelector('a[href*="instagram.com/test82"]'), pageTxt().slice(0, 120));
  ok('旅團連結：FB 有得撳', !!doc.querySelector('a[href*="facebook.com/test82"]'));
  ok('旅團連結：網頁有得撳', !!doc.querySelector('a[href*="example.com"]'));
  ok('活動行事曆：顯示未來活動（秋季露營）', pageTxt().includes('秋季露營'));
  ok('活動行事曆：過去嘅活動唔會排先做提醒',
    pageTxt().indexOf('舊年活動') > pageTxt().indexOf('過往活動'), '');
  ok('過往活動：內容照顯示（已完結）—— 報咗名／遲咗想跟進都搵得返',
    /過往活動[\s\S]*?舊年活動[\s\S]*?已完結/.test(pageTxt()), pageTxt().slice(0, 200));
  ok('通告：未截止嘅報名通告顯示到', pageTxt().includes('開放報名通告'));
  ok('通告：已截止嘅照顯示（標「已截止」＋教人搵領袖／執委）',
    /已截止報名通告[\s\S]*?已截止[\s\S]*?搵領袖/.test(pageTxt()), pageTxt().slice(0, 200));
  ok('通告：截止嘅排喺未截止嘅後面（提醒價值優先）',
    pageTxt().indexOf('開放報名通告') < pageTxt().indexOf('已截止報名通告'));
  ok('通告：冇截止嘅普通通告照顯示', pageTxt().includes('普通通告'));
  ok('通告：草稿唔會出街', !pageTxt().includes('草稿通告'));
  ok('唔會再叫團員「填自己個名」（登入咗就知係邊個）',
    !/我叫咩名|自己打|記住喺呢部機/.test(pageTxt()), pageTxt().slice(0, 200));

  section('回覆出席（RSVP）—— 登入身份，唔使填名');
  /* 入活動詳情 */
  const evBtn = [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/cal/ev_future');
  ok('活動有得入詳情', !!evBtn);
  evBtn?.click();
  await wait(150);
  const rsvpBtn = doc.querySelector('[data-rsvp="present"]');
  ok('詳情頁有「出席」掣', !!rsvpBtn);
  rsvpBtn?.click();
  await wait(300);
  ok('撳「出席」唔會再彈「請填名」（以前係必彈）', !/請喺上面填/.test(pageTxt()));
  ok('即時顯示「已回覆：出席」', /已回覆：出席/.test(pageTxt()), pageTxt().slice(0, 300));
  const toasts = [...doc.querySelectorAll('.toast')].map(t => t.textContent);
  ok('有成功提示', toasts.some(t => /已回覆/.test(t)), toasts.join(' | '));

  section('登入狀態保持（唔會退返系統又要登過）');
  const authKey = 'v82.hub.auth.0082';
  ok('登入狀態寫咗入 localStorage（重開都仲喺度）', !!window.localStorage.getItem(authKey));
  ok('登入狀態唔會再用 sessionStorage（以前收 tab 就冇）', window.sessionStorage.getItem(authKey) === null);

  /* 等 debounce（2.5s）＋ push → 後端要有陳大文嘅 RSVP */
  section('RSVP 自動同步返後端（執委另一部機會見到）');
  let rsvpSeen = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const r = await proxyCall({ action: 'loadDb', unit: '0082' });
    const ev = (r.db?.events || []).find(e => e.id === 'ev_future');
    const mem = (r.db?.members || []).find(m => m.ymis === '2026000001');
    if (ev?.rsvp && mem && ev.rsvp[mem.id]) { rsvpSeen = ev.rsvp[mem.id]; break; }
  }
  ok('後端收到陳大文嘅「出席」回覆（以團員 id 記錄）', rsvpSeen?.status === 'present', JSON.stringify(rsvpSeen));

  /* ---- 交卷都一樣要即刻入後端 ----
     2026-09-19 團長問：「除咗交卷之外，報出席同交單唔係都會係即刻寫咩？」
     係。出席同交卷兩樣都係入站資料（團員部機交完就關，永遠唔會有人撳「立即同步」），
     所以兩樣都即刻寫。之前呢度**淨係測到出席**，交卷係冇驗證嘅 —— 補返。 */
  section('交卷即刻寫返後端（同出席一樣，唔會困喺團員部機）');
  /* 而家仲喺活動詳情頁（RSVP 嗰下入咗去）—— 先撳「返回」返首頁，
     再撳試卷卡。兩下都係用返 app 自己嘅 data-open 導航（會 hash ＋ paint）。 */
  const backBtn = [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/home');
  ok('詳情頁有「返回」掣', !!backBtn);
  backBtn?.click();
  await wait(200);
  const qzBtn = [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/quiz/qz1');
  ok('首頁有試卷卡', !!qzBtn);
  qzBtn?.click();
  await wait(200);
  /* 注意：type='single' 渲染出嚟係 **radio**（data-ans ＋ value），
     submitQuiz() 讀嘅係 `[data-ans]:checked`。所以要「剔選」嗰個選項，
     唔係改 input.value（改 value 唔會令佢變 checked → 讀返嚟係空）。 */
  const radios = [...doc.querySelectorAll('[data-ans="qq1"]')];
  ok('試卷頁有得答（single 題出到選項）', radios.length === 2, String(radios.length));
  const pick = radios.find(r => r.value === '2');
  ok('有「2」呢個選項', !!pick);
  if (pick) pick.checked = true;
  const quizSubmit = doc.querySelector('[data-quiz-submit]');
  ok('有「交卷」掣', !!quizSubmit);
  quizSubmit?.click();
  let quizSeen = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const r = await proxyCall({ action: 'loadDb', unit: '0082' });
    const q = (r.db?.quizzes || []).find(x => x.id === 'qz1');
    const mem = (r.db?.members || []).find(m => m.ymis === '2026000001');
    if (q?.responses && mem && q.responses[mem.id]) { quizSeen = q.responses[mem.id]; break; }
  }
  ok('★ 後端收到陳大文嘅答卷（以團員 id 記錄）',
    !!quizSeen && quizSeen?.answers?.qq1 === '2', JSON.stringify(quizSeen));

  /* ============ 我的進度（團員登入後做齊進度追蹤）＋ 兩個系統寫入衝突模擬 ============ */
  section('我的進度（登入後自己申報 —— 唔使分兩個 APP）');
  {
    const progCall = async (action, data = {}) => (await (await fetch(`${BASE}/api/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit: '0082', action, data })
    })).json());

    /* 主頁「我的進度」入口 → 自己嘅獎章項目（同一個後端、零設定接通） */
    const homeBtn = [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/home');
    homeBtn?.click();
    await wait(150);
    const progBtn = [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/progress');
    ok('主頁有「我的進度」入口', !!progBtn);
    progBtn?.click();
    let progTxt = '';
    for (let i = 0; i < 30; i++) {
      await wait(200);
      progTxt = doc.getElementById('progressBody')?.textContent || '';
      if (/我的進度/.test(progTxt) && doc.querySelector('[data-claim]')) break;
    }
    ok('進度頁睇到自己嘅獎章項目（env 旅團零設定接通同一個後端）',
      /我的進度/.test(progTxt) && !!doc.querySelector('[data-claim]'), progTxt.slice(0, 120));

    /* 申報完成 → 寫入後端「待批完成」（免 API Key） */
    const claimBtn = doc.querySelector('[data-claim]');
    const claimItemId = String(claimBtn?.dataset.claim || '');
    claimBtn?.click();
    await wait(250);
    const sendBtn = [...doc.querySelectorAll('.overlay button')].find(b => /送出申報/.test(b.textContent || ''));
    ok('申報對話框有得送出', !!sendBtn);
    sendBtn?.click();
    await wait(400);
    let mine = null;
    for (let i = 0; i < 20; i++) {
      const r = await progCall('myRequests', { ymis: '2026000001' });
      if ((r?.data?.requests || []).length) { mine = r.data.requests[0]; break; }
      await wait(250);
    }
    ok('申報記錄咗入後端（pending，等執委批）',
      mine?.status === 'pending' && mine?.item_id === claimItemId, JSON.stringify(mine));

    /* ===== 衝突模擬 ①：團員啱啱申報，執委同時推新版成個資料庫 ===== */
    const cur = await proxyCall({ action: 'loadDb', unit: '0082' });
    const db2 = cur.db;
    db2.members.push({ id: 'm_new01', name: '新團員', ymis: '2026000003', identity: 'member', status: 'active' });
    const sv = await proxyCall({ action: 'saveDb', unit: '0082', db: db2, baseVersion: String(cur.version || '') });
    ok('衝突模擬：執委推新版資料庫（saveDb 全份覆寫）成功', sv.ok === true, JSON.stringify(sv).slice(0, 100));
    const mine2 = await progCall('myRequests', { ymis: '2026000001' });
    ok('★ 資料庫覆寫之後，團員嘅申報一條都冇甩（進度寫「待批完成」分頁，db 寫「資料庫」分頁，互唔相撞）',
      (mine2?.data?.requests || []).some(r => r.request_id === mine?.request_id), JSON.stringify((mine2?.data?.requests || []).length));
    const loadAfter = await progCall('load', {});
    ok('★ 進度照讀得到，名冊仲同步埋新增團員（saveDb 會更新「成員名單」分頁）',
      (loadAfter?.data?.members || []).length >= 3 && loadAfter?.ok === true,
      JSON.stringify({ n: (loadAfter?.data?.members || []).length, err: loadAfter?.error }));

    /* ===== 衝突模擬 ②：執委直接喺進度前端勾另一項（直接寫「進度追蹤」）===== */
    const tick = await progCall('save', { changes: [{ ymis: '2026000002', itemId: claimItemId, date: '2026-09-01' }], confirmer: '陳領袖' });
    ok('衝突模擬：進度前端直接勾另一項（執委身份）', tick?.ok === true, JSON.stringify(tick).slice(0, 100));

    /* ===== 執委批核團員嘅申報 → 寫入「進度追蹤」 ===== */
    const rv = await progCall('reviewRequest', { request_id: mine?.request_id, decision: 'approved', review_note: '測試批核', reviewer: '陳領袖', confirmed_date: '2026-09-19' });
    ok('執委批核成功（批准＝寫入進度追蹤，兩個前端即刻見到）', rv?.ok === true, JSON.stringify(rv).slice(0, 120));

    /* 團員再入進度頁 → 見到自己嗰項已完成＋申請紀錄「已批准」 */
    const backBtn = [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/home');
    backBtn?.click();
    await wait(150);
    [...doc.querySelectorAll('[data-open]')].find(b => b.dataset.open === '#/progress')?.click();
    let progTxt2 = '';
    for (let i = 0; i < 30; i++) {
      await wait(200);
      progTxt2 = doc.getElementById('progressBody')?.textContent || '';
      if (/已完成 1 項/.test(progTxt2) || /已批准/.test(progTxt2)) break;
    }
    ok('團員再入進度頁：自己嗰項變咗「已完成」（有批核人）',
      /已完成 1 項/.test(progTxt2) && progTxt2.includes('陳領袖'), progTxt2.slice(0, 160));
    ok('申請紀錄顯示「已批准」（團員自己睇到進度）', /已批准/.test(progTxt2));
    const mine3 = await progCall('myRequests', { ymis: '2026000002' });
    ok('myRequests 只回自己嘅紀錄（李小美見唔到陳大文嘅申請）',
      (mine3?.data?.requests || []).length === 0, JSON.stringify((mine3?.data?.requests || []).length));
  }

  /* 登出 */
  section('登出');
  doc.querySelector('#hubLogout')?.click();
  await wait(150);
  ok('登出後返登入閘', !!doc.querySelector('#hubLogin'));
  ok('登出後 localStorage 狀態清走', window.localStorage.getItem(authKey) === null);

  /* ============ 公開頁：通告（後端正本）＋ 團章（後端 constitution） ============ */
  section('公開頁：通告由後端正本讀（新發布即刻見到）');
  {
    const r = await proxyCall({ action: 'notices', unit: '0082' });
    const ids = (r.notices || []).map(n => n.id).sort();
    ok('免登入讀到已發布通告（只有 published）', JSON.stringify(ids) === JSON.stringify(['n_closed', 'n_open', 'n_plain']), JSON.stringify(ids));
  }

  section('公開頁：團章由後端讀（發布＋同步即刻見到）');
  {
    const r = await proxyCall({ action: 'constitution', unit: '0082' });
    ok('免登入讀到已發布團章', r.ok === true && r.found === true && !!r.constitution?.chapters?.length, JSON.stringify(r).slice(0, 120));
    ok('團章版本正確（v3.1）', r.constitution?.version === '3.1');
    ok('只回 constitution，唔會漏名冊／帳目（安全）', r.db === undefined && !JSON.stringify(r).includes('hubPw'));
  }

  /* constitution.html 真頁面（jsdom）：fetch 行真 HTTP 經 dev-server */
  {
    const cHtml = fs.readFileSync(path.join(ROOT, 'constitution.html'), 'utf8');
    const dom2 = new JSDOM(cHtml, { url: `${BASE}/constitution.html?u=0082`, pretendToBeVisual: true, runScripts: 'dangerously' });
    const w2 = dom2.window;
    for (const k of ['document', 'navigator', 'localStorage', 'location', 'HTMLElement',
      'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
      if (w2[k] === undefined) continue;
      try { Object.defineProperty(globalThis, k, { value: w2[k], configurable: true, writable: true }); } catch { /* ignore */ }
    }
    globalThis.window = w2;
    await import('../assets/js/public.js');
    let paperTxt = '';
    for (let i = 0; i < 60; i++) {
      await wait(100);
      paperTxt = w2.document.getElementById('paper')?.textContent || '';
      if (paperTxt.includes('總則')) break;
    }
    ok('團章公開頁顯示到後端最新版（以前只會 404）', paperTxt.includes('第一章') && paperTxt.includes('本團名為測試旅深資童軍團'), paperTxt.slice(0, 120));
    ok('公開頁顯示版本號 v3.1', (w2.document.getElementById('app')?.textContent || '').includes('3.1'));
  }
} catch (e) {
  fail++;
  console.log('  ✗ 測試流程爆咗：' + (e?.stack || e));
} finally {
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
}

console.log(`\n──────── 團員入口測試結果：${pass} 通過 / ${fail} 失敗（${Math.round((Date.now() - t0) / 1000)} ms）────────`);
process.exit(fail ? 1 : 0);
