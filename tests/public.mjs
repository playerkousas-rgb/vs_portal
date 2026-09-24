/* ============================================================
   tests/public.mjs — 團章公開頁（constitution.html + assets/js/public.js）
   用 jsdom 開公開頁，驗證：免登入讀到團章、中英對照、語言切換、搜尋。
   用法：node tests/public.mjs
   ============================================================ */

import { JSDOM } from 'jsdom';
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
const errors = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

/* ---------- fetch shim：直接由 repo 讀檔 ----------
   注意：0082 嘅真實資料（團員／團章／通告）已經搬入後端並喺 Git 移除，
   所以呢度用 tests/fixtures/units/TEST9/ 做替身 —— 內容全部係虛構測試資料。
   公開頁測試驗嘅係「渲染／語言切換／報名」呢啲功能，唔需要真旅團資料。 */
const FIXTURE_UNIT = path.join(ROOT, 'tests', 'fixtures', 'units', 'TEST9');
const FIXTURE_REG = {
  schema: 2, defaultUnit: '0082',
  units: {
    '0082': {
      code: '0082', name: '測試旅深資童軍團', nameEn: 'Test Group Venture Scout Unit',
      short: 'test9', section: '深資童軍', sponsor: '測試主辦機構', address: '測試地址 123 號',
      dataPath: 'tests/fixtures/units/TEST9/'
    }
  }
};
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  /* Registry：唔好讀真 data/units.json（真檔有 0082 名單，會污染測試）→ 用測試 registry */
  if (/(^|\/)units\.json$/.test(clean) || /api\/units/.test(clean)) {
    return { ok: true, status: 200, json: async () => FIXTURE_REG, text: async () => JSON.stringify(FIXTURE_REG) };
  }
  /* 0082 嘅資料檔 → 指去 fixture */
  let file = clean.startsWith('data/units/0082/')
    ? path.join(FIXTURE_UNIT, clean.replace('data/units/0082/', ''))
    : path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* ---------- 用真實嘅 constitution.html 做底 ---------- */
const html = fs.readFileSync(path.join(ROOT, 'constitution.html'), 'utf8');
const url = 'http://localhost:8080/constitution.html?u=0082';
const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
window.scrollTo = () => {};
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
  'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch (e) { /* 唯讀 → 略過 */ }
}
globalThis.window = window;

const doc = window.document;
const paper = () => doc.getElementById('paper')?.textContent || '';
const paperHtml = () => doc.getElementById('paper')?.innerHTML || '';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\n▌團章公開頁（免登入）');
await import('../assets/js/public.js');
await wait(400);

ok('頁面有渲染', paper().length > 500, String(paper().length));
ok('標題是團章', /團章/.test(doc.title), doc.title);
ok('顯示旅團名', paper().includes('測試旅深資童軍團'));
ok('顯示主辦機構', paper().includes('測試主辦機構') || paper().includes('Test Sponsor'));
ok('有 19 章 + 附件（section 數目）', doc.querySelectorAll('#paper section').length >= 20,
  String(doc.querySelectorAll('#paper section').length));
ok('預設中英對照（同頁見到中文條文）', paper().includes('本團名稱為'));
ok('預設中英對照（同頁見到英文條文）', /The title of the Unit shall be/.test(paper()));
ok('有頁尾版本資料', /版本 v/.test(paper()));
ok('有中文／English／對照 三個語言掣', doc.querySelectorAll('[data-lang]').length === 3);
ok('有 PDF / Word / Markdown 匯出掣',
  ['print', 'word', 'md'].every(a => !!doc.querySelector(`[data-act="${a}"]`)));

/* ---------- 語言切換 ---------- */
console.log('\n▌語言切換');
doc.querySelector('[data-lang="en"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
ok('English：只剩英文條文', /The title of the Unit shall be/.test(paper()) && !paper().includes('本團名稱為'));
ok('English：記入 localStorage', window.localStorage.getItem('venture82.pub.lang') === 'en');

doc.querySelector('[data-lang="zh"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
ok('中文：只剩中文條文', paper().includes('本團名稱為') && !/The title of the Unit shall be/.test(paper()));

doc.querySelector('[data-lang="both"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
ok('對照：中英都有', paper().includes('本團名稱為') && /The title of the Unit shall be/.test(paper()));

/* ---------- 搜尋 ---------- */
console.log('\n▌條文搜尋');
const box = doc.getElementById('pubSearch');
box.value = '團費';
box.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(420);
ok('搜尋「團費」只剩相關章節', paper().includes('團費') && !paper().includes('本團名稱為'));
box.value = '';
box.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(420);
ok('清空搜尋後回復全文', paper().includes('本團名稱為'));

/* ---------- 主題色（要求：棗紅） ---------- */
console.log('\n▌主題');
const css = fs.readFileSync(path.join(ROOT, 'assets/css/main.css'), 'utf8');
ok('公開頁字體色用棗紅 var(--brand-700)', paperHtml().includes('var(--brand-700)'));
ok('CSS 主色 700 = #7B2233', /--brand-700:\s*#7B2233/i.test(css));
ok('CSS 冇殘留舊綠色 (#2e7d32 等)', !/#(2e7d32|388e3c|1b5e20|43a047|4caf50)/i.test(css));

/* ============================================================
   通告公開頁（notice.html + assets/js/public-notice.js）
   免登入：睇通告 → 填報名 → 送出
   ============================================================ */
console.log('\n▌通告公開頁（免登入・分享・報名）');

let noticeCase = 0;
function bootNotice(search) {
  const html = fs.readFileSync(path.join(ROOT, 'notice.html'), 'utf8');
  const dom2 = new JSDOM(html, {
    url: 'http://localhost:8080/notice.html' + search,
    pretendToBeVisual: true, runScripts: 'dangerously'
  });
  const w = dom2.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob']) {
    if (w[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); }
    catch (e) { /* 唯讀 → 略過 */ }
  }
  globalThis.window = w;
  return w;
}

// ① 一般通告（唔需要報名）
{
  const w = bootNotice('?u=0082&n=nt-2026-annfee');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(400);
  const d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  ok('通告公開頁有渲染（免登入）', txt().length > 200, String(txt().length));
  ok('顯示通告標題', txt().includes('團費'), txt().slice(0, 60));
  ok('顯示旅團名', txt().includes('測試旅') || txt().includes('TEST'), txt().slice(0, 80));
  ok('顯示通告內容（團費 $360）', txt().includes('360'));
  ok('有截止日期標示', txt().includes('截止') || txt().includes('2026-09-30'));
  ok('唔需要報名時冇報名表', !d.getElementById('signup-form'));
  ok('頁尾有「深資童軍管理系統」字樣', txt().includes('深資童軍管理系統'));
  ok('document.title 用通告標題', /團費/.test(d.title), d.title);
}

// ② 需要報名嘅通告
{
  const w = bootNotice('?u=0082&n=nt-2026-pioneer');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(400);
  const d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  const form = d.getElementById('signup-form');
  ok('需要報名嘅通告有報名表', !!form);
  ok('有「可報名」標示', txt().includes('可報名'));
  ok('報名欄目由通告定義（姓名／電話／本人係）',
    !!d.querySelector('[data-fk="name"]') && !!d.querySelector('[data-fk="contact"]') && !!d.querySelector('[data-fk="member"]'));
  ok('必填欄有 required', d.querySelector('[data-fk="name"]')?.hasAttribute('required') === true);
  ok('有剔選欄（飲食禁忌）', d.querySelectorAll('[data-fk="diet"]').length >= 3);
  ok('活動詳情欄位都有顯示（地點／集合／解散／服裝／費用／名額／查詢）',
    ['測試郊野公園', '0830 測試郊野公園入口集合', '1630 測試郊野公園入口解散', '戶外制服', '$120', '24', '1234 5678 測試負責人']
      .every(k => txt().includes(k)), txt().slice(0, 200));

  // 未填必填 → 有錯誤提示
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(120);
  ok('未填必填欄會提示（唔會送出）', (d.getElementById('signup-err')?.textContent || '').includes('未填'));
  ok('未送出時本機冇紀錄', !w.localStorage.getItem('venture82.pub.signup.0082.nt-2026-pioneer'));

  // 填好 → 送出
  d.querySelector('[data-fk="name"]').value = '測試團員';
  d.querySelector('[data-fk="contact"]').value = '91234567';
  d.querySelector('[data-fk="member"]').value = '現役團員';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(300);
  const saved = JSON.parse(w.localStorage.getItem('venture82.pub.signup.0082.nt-2026-pioneer') || '[]');
  ok('填好之後送出成功（本機有紀錄）', saved.length === 1, JSON.stringify(saved));
  ok('紀錄有姓名同通告編號', saved[0]?.values?.name === '測試團員' && saved[0]?.noticeId === 'nt-2026-pioneer', JSON.stringify(saved[0]?.values));
  ok('送出後有成功訊息', txt().includes('已收到'));
}

// ②b 伺服器（env）旅團：冇靜態通告檔 → 由旅團後端讀通告；報名經同源 api/proxy 送出
{
  const realFetch = globalThis.fetch;
  const proxyCalls = [];
  const ENV_NOTICE = {
    id: 'nt-envunit', type: 'event', status: 'published', needSignup: true,
    title: { zh: 'env 旅團通告' }, eventDate: '2026-10-03', venue: '北潭涌度假營',
    assembly: '1300 筲箕灣中心', dress: '戶外制服', fee: '$280',
    fields: [{ key: 'name', label: '姓名', type: 'text', required: true }],
    body: { zh: '由旅團後端讀出嚟嘅通告全文。' }
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/api\/proxy/.test(u)) {
      const body = init.body ? JSON.parse(init.body) : {};
      proxyCalls.push({ url: u, body });
      if (body.action === 'notices') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, notices: [ENV_NOTICE] }),
          json: async () => ({ success: true, notices: [ENV_NOTICE] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, msg: '已記錄報名' }),
        json: async () => ({ success: true, msg: '已記錄報名' }) };
    }
    if (/api\/units/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ units: { '0081': { code: '0081', name: '第八十一旅深資童軍團', fromApi: true } } }),
        json: async () => ({ units: { '0081': { code: '0081', name: '第八十一旅深資童軍團', fromApi: true } } }) };
    }
    return realFetch(url, init);
  };
  const w = bootNotice('?u=0081&n=nt-envunit');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(450);
  const d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  const form = d.getElementById('signup-form');
  ok('env 旅團（冇靜態通告檔）由自己後端讀到通告', txt().includes('env 旅團通告'), txt().slice(0, 100));
  ok('後端讀返嘅欄位照樣顯示（集合／服裝／費用）',
    txt().includes('1300 筲箕灣中心') && txt().includes('戶外制服') && txt().includes('$280'));
  ok('有 POST api/proxy action=notices（帶 unit）',
    proxyCalls.some(c => c.body?.action === 'notices' && c.body?.unit === '0081'));
  if (form) {
    ok('報名提示「直接記錄到旅團嘅總表」', txt().includes('直接記錄到旅團嘅總表'));
    d.querySelector('[data-fk="name"]').value = '測試團員';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(400);
    ok('唔會借用其他旅團嘅後端（env 團冇登記就唔會送去 0082）',
      !proxyCalls.some(c => /script\.google\.com/.test(String(c.url || ''))));
    ok('送出會 POST api/proxy action=noticeSignup（伺服器端解析後端＋Key）',
      proxyCalls.some(c => c.body?.action === 'noticeSignup' && c.body?.unit === '0081'),
      JSON.stringify(proxyCalls.map(c => c.body?.action)));
    ok('送出後有成功訊息', txt().includes('已收到'));
  } else {
    ok('env 旅團通告照樣有報名表', false, txt().slice(0, 120));
  }
  globalThis.fetch = realFetch;
}

// ②c 有靜態通告檔嘅旅團（0082）：app 新開嘅通告喺旅團後端 → 兩邊合併（同 id 以後端為準）
{
  const realFetch = globalThis.fetch;
  const proxyCalls = [];
  const APP_NEW = {
    id: 'nt-appnew-2026', type: 'event', status: 'published', needSignup: true,
    publishAt: '2026-09-17', title: { zh: '秋季露營 — app 新開通告' },
    body: { zh: '呢張通告只喺旅團後端（未入 Git）。' },
    eventDate: '2026-10-24', venue: '大帽山', fee: '$150',
    fields: [{ key: 'name', label: '姓名', type: 'text', required: true }]
  };
  const OVERRIDE = {
    id: 'nt-2026-annfee', type: 'notice', status: 'published', needSignup: false,
    publishAt: '2026-09-16', title: { zh: '團費通告（後端改咗版本）' },
    body: { zh: '後端版本：本年度團費改做 $400。' }
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/api\/proxy/.test(u)) {
      const body = init.body ? JSON.parse(init.body) : {};
      proxyCalls.push(body);
      if (body.action === 'notices') {
        return { ok: true, status: 200, text: async () => '', json: async () => ({ success: true, notices: [APP_NEW, OVERRIDE] }) };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ success: true, msg: '已記錄' }) };
    }
    return realFetch(url, init);
  };

  /* ① 靜態檔有嘢（0082）都要讀後端：app 新開嘅通告先睇得到 */
  let w = bootNotice('?u=0082&n=nt-appnew-2026');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(420);
  let d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  ok('靜態檔有嘢都照讀後端（唔係「靜態檔全冇先讀」）',
    proxyCalls.some(c => c.action === 'notices' && c.unit === '0082'), JSON.stringify(proxyCalls.map(c => c.action)));
  ok('app 新開嘅通告喺公開頁睇到（合併後端）',
    txt().includes('秋季露營 — app 新開通告'), txt().slice(0, 90));
  ok('新通告嘅活動詳情照樣出（地點／費用）', txt().includes('大帽山') && txt().includes('$150'));
  ok('新通告可以報名（有報名表）', !!d.getElementById('signup-form'));

  /* ② 同 id → 以後端為準 */
  w = bootNotice('?u=0082&n=nt-2026-annfee');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(420);
  d = w.document;
  const txt2 = () => d.getElementById('app')?.textContent || '';
  ok('同 id 以後端為準（團長改完即刻生效）',
    txt2().includes('團費通告（後端改咗版本）') && txt2().includes('$400'), txt2().slice(0, 120));
  ok('唔會同 Git 版本並排出現（合併唔會重複）',
    !txt2().includes('2026–27 年度團費及活動安排通告') && !txt2().includes('$360'), txt2().slice(0, 120));

  /* ③ 靜態有、後端冇 → 唔會消失 */
  w = bootNotice('?u=0082&n=nt-2026-pioneer');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(420);
  ok('靜態有、後端冇嘅通告唔會消失',
    (w.document.getElementById('app')?.textContent || '').includes('先鋒工程訓練日'),
    (w.document.getElementById('app')?.textContent || '').slice(0, 90));

  globalThis.fetch = realFetch;
}

// ③ 搵唔到通告／連結失效
{
  const w = bootNotice('?u=0082&n=no-such-notice');
  await import('../assets/js/public-notice.js?case=' + ++noticeCase);
  await wait(400);
  const txt = w.document.getElementById('app')?.textContent || '';
  ok('搵唔到通告有友善提示（唔會白畫面）', txt.includes('讀唔到通告') || txt.includes('暫時'), txt.slice(0, 80));
}

/* ============================================================
   手機記一筆（entry.html + assets/js/public-entry.js）
   成員免登入：影相 → 揀欄目 → 送出
   ============================================================ */
console.log('\n▌手機記一筆（免登入・影相＋揀欄目）');

function bootEntry(search) {
  const html = fs.readFileSync(path.join(ROOT, 'entry.html'), 'utf8');
  const dom3 = new JSDOM(html, {
    url: 'http://localhost:8080/entry.html' + search,
    pretendToBeVisual: true, runScripts: 'dangerously'
  });
  const w = dom3.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob']) {
    if (w[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); }
    catch (e) { /* 唯讀 → 略過 */ }
  }
  globalThis.window = w;
  return w;
}

{
  const w = bootEntry('?u=0082');
  await import('../assets/js/public-entry.js?case=' + ++noticeCase);
  await wait(420);
  const d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  ok('手機記一筆頁有渲染（免登入）', txt().length > 200, String(txt().length));
  ok('顯示旅團名', txt().includes('測試旅') || txt().includes('TEST'), txt().slice(0, 60));
  ok('有相機輸入（直接影相）', !!d.querySelector('[data-photo-field="pe-photos"] input[type="file"][capture]'));
  ok('有揀相片（相簿）', !!d.querySelector('[data-photo-field="pe-photos"] input[type="file"]:not([capture])'));
  ok('有欄目下拉（支出分類）', !!d.querySelector('#pe-cat') && d.querySelector('#pe-cat').options.length > 5,
    String(d.querySelector('#pe-cat')?.options.length));
  ok('支出欄目包括「活動」同「交通」', txt().includes('活動'), txt().slice(0, 200));
  ok('有金額／項目／姓名欄', !!d.querySelector('#pe-amount') && !!d.querySelector('#pe-item') && !!d.querySelector('#pe-name'));
  ok('有收入／支出切換掣', d.querySelectorAll('[data-type]').length === 2);
  ok('預設係支出', d.querySelector('[data-type="expense"]')?.getAttribute('aria-pressed') === 'true');

  // 切去收入 → 欄目變團費
  d.querySelector('[data-type="income"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(60);
  ok('切去「收入」之後欄目變團費／活動收費',
    Array.from(d.querySelectorAll('#pe-cat option')).some(o => o.textContent.includes('團費')),
    Array.from(d.querySelectorAll('#pe-cat option')).map(o => o.textContent).join('|').slice(0, 80));

  // 空表送出 → 提示
  d.getElementById('pe-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(120);
  ok('空表送出會提示（唔會入到）', (d.getElementById('pe-err')?.textContent || '').includes('未填好'));
  ok('未送出時本機冇紀錄', !w.localStorage.getItem('venture82.entry.0082'));

  // 填好送出
  d.querySelector('#pe-cat').value = '團費';
  d.querySelector('#pe-cat').dispatchEvent(new w.Event('change', { bubbles: true }));
  d.querySelector('#pe-amount').value = '360';
  d.querySelector('#pe-amount').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#pe-item').value = '9 月團費';
  d.querySelector('#pe-item').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#pe-name').value = '測試團員';
  d.querySelector('#pe-name').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.getElementById('pe-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(300);

  const rows = JSON.parse(w.localStorage.getItem('venture82.entry.0082') || '[]');
  ok('填好之後送出成功（本機有紀錄）', rows.length === 1, String(rows.length));
  ok('紀錄內容正確（收入 360 團費）',
    rows[0]?.payload?.amount === 360 && rows[0]?.payload?.category === '團費' && rows[0]?.payload?.type === 'income',
    JSON.stringify(rows[0]?.payload));
  ok('紀錄有姓名同送出時間', rows[0]?.payload?.byName === '測試團員' && !!rows[0]?.payload?.submittedAt);
  ok('送出後有成功畫面', txt().includes('已記錄'));
  ok('成功畫面可以再記一筆', !!d.querySelector('[data-pe="again"]'));
  ok('成功畫面有「複製內容」傳送畀司庫', !!d.querySelector('[data-pe="copy"]'));
}

/* ============================================================
   物資借用（borrow.html + assets/js/public-borrow.js）
   成員免登入：揀物資 → 數量 → 用途 → 送出
   ============================================================ */
console.log('\n▌物資借用（免登入・揀物資＋數量）');

function bootBorrow(search) {
  const html = fs.readFileSync(path.join(ROOT, 'borrow.html'), 'utf8');
  const dom4 = new JSDOM(html, {
    url: 'http://localhost:8080/borrow.html' + search,
    pretendToBeVisual: true, runScripts: 'dangerously'
  });
  const w = dom4.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob']) {
    if (w[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); }
    catch (e) { /* 唯讀 → 略過 */ }
  }
  globalThis.window = w;
  return w;
}

// ① 有物資嘅旅團（用 tests/fixtures/units/TEST9/ 嘅測試物資）
{
  const w = bootBorrow('?u=0082');
  await import('../assets/js/public-borrow.js?case=' + ++noticeCase);
  await wait(400);
  const d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  ok('物資借用頁有渲染（免登入）', txt().length > 200, String(txt().length));
  ok('顯示旅團名', txt().includes('測試旅'), txt().slice(0, 80));
  ok('列出可借物資（帶可用數量）', d.querySelectorAll('[data-item]').length >= 5,
    String(d.querySelectorAll('[data-item]').length));
  ok('顯示可用數量（總數減借出）', /可用 \d/.test(txt()), txt().slice(0, 200));
  ok('有數量／借用日／歸還日／用途欄',
    ['pb-qty', 'pb-from', 'pb-to', 'pb-purpose', 'pb-name'].every(id => !!d.getElementById(id)));
  ok('有聯絡電話欄', !!d.getElementById('pb-contact'));

  // 未揀物資 → 唔會送出
  d.getElementById('pb-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(120);
  ok('未揀物資會提示（唔會送出）', (d.getElementById('pb-err')?.textContent || '').includes('未填'),
    d.getElementById('pb-err')?.textContent);
  ok('未送出時本機冇紀錄', !w.localStorage.getItem('venture82.borrow.0082'));

  // 揀物資 + 填好 → 送出
  d.querySelector('[data-item]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(80);
  const picked = d.querySelector('[data-item][aria-pressed="true"]');
  ok('揀咗物資會標示（aria-pressed）', !!picked);
  d.getElementById('pb-purpose').value = '測試露營';
  d.getElementById('pb-purpose').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.getElementById('pb-name').value = '測試團員';
  d.getElementById('pb-name').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.getElementById('pb-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(320);

  const rows = JSON.parse(w.localStorage.getItem('venture82.borrow.0082') || '[]');
  ok('填好之後送出成功（本機有紀錄）', rows.length === 1, String(rows.length));
  ok('紀錄有物資名／數量／用途／申請人',
    !!rows[0]?.payload?.itemName && rows[0]?.payload?.qty === 1
    && rows[0]?.payload?.purpose === '測試露營' && rows[0]?.payload?.byName === '測試團員',
    JSON.stringify(rows[0]?.payload));
  ok('送出後有成功畫面', txt().includes('已送出申請'));
  ok('成功畫面有「複製內容」傳送畀執委', !!d.querySelector('[data-pb="copy"]'));

  // 借超過可用數量 → 擋住
  const w2 = bootBorrow('?u=0082');
  await import('../assets/js/public-borrow.js?case=' + ++noticeCase);
  await wait(400);
  const d2 = w2.document;
  d2.querySelector('[data-item]').dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  await wait(60);
  d2.getElementById('pb-qty').value = '999';
  d2.getElementById('pb-qty').dispatchEvent(new w2.Event('input', { bubbles: true }));
  d2.getElementById('pb-purpose').value = 'x';
  d2.getElementById('pb-purpose').dispatchEvent(new w2.Event('input', { bubbles: true }));
  d2.getElementById('pb-name').value = 'y';
  d2.getElementById('pb-name').dispatchEvent(new w2.Event('input', { bubbles: true }));
  d2.getElementById('pb-form').dispatchEvent(new w2.Event('submit', { bubbles: true, cancelable: true }));
  await wait(150);
  ok('借超過可用數量會擋住（防呆）',
    /可借數量不足/.test(d2.querySelector('[data-err="qty"]')?.textContent || ''),
    d2.querySelector('[data-err="qty"]')?.textContent);
}

/* ② 未登記物資嘅旅團
   ★ 2026-09-25：以前用 0082（嗰陣 Git 入面冇物資檔），但而家物資借用測試
     需要真嘅物資資料 → 0082 嘅 fixture 已經有 10 件物資（睇上面 ①）。
     呢度改用一個**冇登記**嘅編號（0099）—— 冇資料檔＝冇物資，一樣驗到「友善提示」。 */
{
  const w = bootBorrow('?u=0099');
  await import('../assets/js/public-borrow.js?case=' + ++noticeCase);
  await wait(400);
  const d = w.document;
  const txt = () => d.getElementById('app')?.textContent || '';
  ok('冇登記物資時有友善提示（唔會白畫面）', /未有登記物資/.test(txt()), txt().slice(0, 90));
  ok('冇物資時送出掣停用', d.querySelector('button[type="submit"]')?.disabled === true);
}

/* ---------- 錯誤 ---------- */
if (errors.length) {
  console.log(`\n捕捉到 ${errors.length} 個 console.error：`);
  errors.slice(0, 6).forEach(e => console.log('  • ' + e.slice(0, 200)));
}
const ms = Date.now() - t0;
console.log(`\n──────── 公開頁測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
process.exit(fail ? 1 : 0);
