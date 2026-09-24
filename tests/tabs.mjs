/* ============================================================
   tests/tabs.mjs — 分頁掣（tab）真係撳得到？
   -----------------------------------------------------------
   背景（2026-09 真實 bug）：
   ui.js 個 tabs() 只係吐 <button data-tab="…">，唔會自己綁 click。
   以前要每個 view 喺 mount() 自己 querySelectorAll('[data-tab]') 綁一次；
   accounts.js / notices.js / tables.js 三個 view 漏咗 →
   「帳號與系統」六個分頁一個都撳唔到，用家見到嘅係「所有掣都壞咗」。

   舊測試全部係直接 `location.hash = '#/admin/perms'` 去測 render，
   所以完全捉唔到「撳個掣冇反應」呢類 bug。呢個檔專門補呢個窿：
   真係 dispatch MouseEvent click，再睇個 hash 有冇變。

   用法：node tests/tabs.mjs
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
let pass = 0, fail = 0;

const errors = [];
const origError = console.error;
console.error = (...a) => {
  const msg = a.map(String).join(' ');
  if (/Not implemented: navigation|Could not parse CSS/.test(msg)) return;
  errors.push(msg); origError('[console.error]', ...a);
};

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- fetch shim：由 repo 讀檔 ---------- */
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* 超管核對而家喺伺服器端（api/auth.js）—— 裝返個有設環境變數嘅「伺服器」 */
const { installSuperAuth, TEST_SUPER_PASSWORD } = await import('./_authstub.mjs');
installSuperAuth();

/* ---------- DOM ---------- */
const dom = new JSDOM('<!doctype html><html><body class="login-body"><div id="app"></div></body></html>', {
  url: 'http://localhost:8080/?u=0082', pretendToBeVisual: true, runScripts: 'dangerously'
});
const { window } = dom;
window.scrollTo = () => {};
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
  'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader',
  'MouseEvent', 'history']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch { /* 唯讀 → 略過 */ }
}
globalThis.window = window;
/* jsdom 冇呢兩樣（唔係 app 嘅問題）：router.js go() 要 HashChangeEvent，
   匯出 CSV／JSON 要 createObjectURL。補返，唔好當成 runtime error。 */
if (typeof window.HashChangeEvent === 'undefined') {
  window.HashChangeEvent = window.Event;
  globalThis.HashChangeEvent = window.Event;
}
window.URL.createObjectURL = () => 'blob:test';
window.URL.revokeObjectURL = () => {};
window.addEventListener('error', e => errors.push('window.onerror: ' + e.message));

const auth = await import('../assets/js/lib/auth.js');
const store = await import('../assets/js/lib/store.js');
await import('../assets/js/main.js');
await wait(400);
/* ★ 2026-09-24：冇共用帳戶 —— 用測試 helper 種「個人身份」再做登入 */
const { seedRosterRoles } = await import('./_roles.mjs');
await seedRosterRoles(store, auth);
await auth.login('leader', 'leader', '8202');
await wait(300);

const doc = window.document;

async function goTo(hash) {
  window.location.hash = hash;
  await wait(250);
}

/* 撳一粒分頁掣，回報個 hash 變咗做乜 */
async function clickTab(tabId) {
  const btn = doc.querySelector(`#view [data-tab="${tabId}"]`);
  if (!btn) return { found: false, hash: window.location.hash };
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(250);
  return { found: true, hash: window.location.hash };
}

/* ============================================================
   ① 每個有分頁列嘅 section，逐粒掣真係撳落去
   ============================================================ */
const SUITES = [
  /* 「mock」分頁係 super 限定（下面特登驗：leader 見唔到、super 見到）
     ★ 2026-09-24 團長：「權限總表由身份與帳號 移去 用戶與身份」→ perms 唔再喺 #/admin */
  { name: '帳號與系統', home: '#/admin', tabs: ['unit', 'data', 'audit'] },
  { name: '通告', home: '#/notices', tabs: ['signups', 'settings'] },
  { name: '資料管理（原表格與同步）', home: '#/tables', tabs: ['source', 'sync', 'data'] },
  { name: '公開資料（原成員連結）', home: '#/links', tabs: ['social', 'album', 'link'] },
  { name: '財政', home: '#/finance', tabs: ['reports', 'fees', 'claims', 'budgets', 'import'] },
  { name: '物資', home: '#/inventory', tabs: ['loans', 'audits'] }
];

for (const s of SUITES) {
  section(`${s.name}：撳分頁掣（唔係改 hash）`);
  for (const tab of s.tabs) {
    await goTo(s.home);
    const r = await clickTab(tab);
    ok(`撳「${tab}」→ 去到 ${s.home}/${tab}`,
      r.found && r.hash === `${s.home}/${tab}`,
      r.found ? `個 hash 仲係 ${r.hash}（個掣冇反應）` : '搵唔到粒掣');
  }
}

/* ============================================================
   ② 撳完之後真係 render 到嗰版（唔淨係改 hash）
   ============================================================ */
section('撳完分頁，畫面真係換咗');
const RENDER = [
  ['#/admin', 'unit', '旅團'],
  ['#/admin', 'data', '備份'],
  ['#/tables', 'sync', '總表同步'],
  ['#/links', 'social', '社交媒體'],
  ['#/links', 'album', '相簿'],
  ['#/notices', 'signups', '報名']
];
for (const [home, tab, needle] of RENDER) {
  await goTo(home);
  await clickTab(tab);
  const txt = doc.getElementById('view')?.textContent || '';
  ok(`撳完 ${home}/${tab} 見到「${needle}」`, txt.includes(needle),
    txt.replace(/\s+/g, ' ').slice(0, 90));
}

/* ============================================================
   ②b 冇咗「示範資料（MOCK）」分頁
      ★ 2026-09-24 團長：「刪除示範資料 (MOCK) 我都在用要MOCK 幹什麼」
      → 連 super 都唔應該再見到呢個分頁，#/admin/mock 亦唔可以 render 到嘢。
   ============================================================ */
section('★ MOCK 分頁已經拆走');
{
  await goTo('#/admin');
  ok('leader 見唔到 mock 分頁', !doc.querySelector('#view [data-tab="mock"]'));

  auth.logout();
  const r = await auth.login('super', 'sheep', TEST_SUPER_PASSWORD);
  ok('super 登入到', r.ok === true, JSON.stringify(r));
  await goTo('#/');
  await goTo('#/admin');
  ok('★ super 都見唔到 mock 分頁（已經拆走）', !doc.querySelector('#view [data-tab="mock"]'));
  ok('★ 分頁列得返身份與帳號／旅團設定／資料管理／操作紀錄',
    ['accounts', 'unit', 'data', 'audit'].every(t => !!doc.querySelector(`#view [data-tab="${t}"]`))
    && !doc.querySelector('#view [data-tab="mock"]'));
  auth.logout();
  await auth.login('leader', 'leader', '8202');
}

/* ============================================================
   ③ 靜態防呆：任何 view 只要用 tabs()，就要撳得郁
       —— 由 main.js 統一綁 [data-tab]，所以驗返呢個保險掣仲喺度
   ============================================================ */
section('防呆：main.js 有全域 [data-tab] handler');
const mainSrc = fs.readFileSync(path.join(ROOT, 'assets/js/main.js'), 'utf8');
const viewsDirEarly = path.join(ROOT, 'assets/js/views');
ok('main.js 綁咗 [data-tabnav] [data-tab] 嘅 click',
  /querySelectorAll\(\s*['"]#view \[data-tabnav\] \[data-tab\]['"]\s*\)/.test(mainSrc)
  && /addEventListener\(\s*['"]click['"]/.test(mainSrc));
ok('全域 handler 經 tabHash() 計個目的地', /go\(\s*tabHash\(/.test(mainSrc) && /function tabHash/.test(mainSrc));
/* ui.js 一定要繼續吐 data-tabnav，否則全域 handler 會全部失效（即係原本個 bug） */
const uiSrc = fs.readFileSync(path.join(ROOT, 'assets/js/views/ui.js'), 'utf8');
ok('ui.js tabs() 吐 data-tabnav 做記認', /role="tablist" data-tabnav/.test(uiSrc));
/* 唔應該再有 view 自己綁 [data-tab]（除咗 meetings.js 嘅 local 分頁） */
const dupes = fs.readdirSync(viewsDirEarly)
  .filter(f => f.endsWith('.js') && f !== 'meetings.js')
  .filter(f => /querySelectorAll\(\s*['"]\[data-tab\]['"]\s*\)/.test(fs.readFileSync(path.join(viewsDirEarly, f), 'utf8')));
ok('冇 view 重複綁 [data-tab]（會撳一次跳兩次）', dupes.length === 0, dupes.join(','));

/* 每個用 tabs() 嘅 view，喺渲染之後都要有真 <button data-tab> */
section('每個用 tabs() 嘅 view 都真係出到分頁掣');
const viewsDir = path.join(ROOT, 'assets/js/views');
const usesTabs = fs.readdirSync(viewsDir)
  .filter(f => f.endsWith('.js'))
  .filter(f => /\btabs\(\[/.test(fs.readFileSync(path.join(viewsDir, f), 'utf8')))
  .map(f => f.replace(/\.js$/, ''));
ok('搵到用 tabs() 嘅 view', usesTabs.length >= 3, usesTabs.join(','));
const SECTION_OF = { accounts: '#/admin', notices: '#/notices', tables: '#/tables', finance: '#/finance', inventory: '#/inventory', progress: '#/progress' };
for (const v of usesTabs) {
  const home = SECTION_OF[v];
  if (!home) { console.log(`  · ${v}（唔知對應邊個 hash，略過）`); continue; }
  await goTo(home);
  const btns = [...doc.querySelectorAll('#view [data-tab]')];
  ok(`${v} 渲染到 ${btns.length} 粒分頁掣`, btns.length > 0);
  if (!btns.length) continue;
  /* 隨便撳第二粒（第一粒通常係而家嗰版）*/
  /* 揀一粒唔係而家嗰版嘅掣嚟撳 */
  const target = btns.find(b => b.getAttribute('aria-selected') !== 'true') || btns[0];
  const id = target.dataset.tab;
  /* 有啲 view 嘅預設分頁住喺「淨係 section」嘅 hash（例如 #/inventory ＝ 物資清單） */
  const TAB_AT_ROOT = { '#/inventory': 'items' };
  const expect = TAB_AT_ROOT[home] === id ? home : `${home}/${id}`;
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(250);
  ok(`${v} 粒「${id}」撳得郁`, window.location.hash === expect,
    `而家 ${window.location.hash}，預期 ${expect}`);
}

/* ============================================================
   ③b 全域 handler 唔可以搶 view 自己手砌嘅 local 分頁
       meetings.js 會議詳情啲分頁係換 pane ＋ setQuery({tab})，
       唔應該變成 #/meetings/agenda（咁會走去開一個叫 agenda 嘅會議）
   ============================================================ */
section('唔好搶：meetings 詳情頁嘅 local 分頁');
{
  const store = await import('../assets/js/lib/store.js');
  let mt = (store.load().meetings || [])[0];
  /* 冇會議就開一個，否則呢個防迴歸檢查會靜靜雞略過 */
  if (!mt) {
    try {
      store.add('meetings', { title: '測試會議（tabs.mjs）', date: '2026-01-01', status: 'draft' });
      mt = (store.load().meetings || [])[0];
    } catch (e) { console.log('  · 開唔到測試會議：' + e.message); }
  }
  if (!mt) { console.log('  · 冇會議資料，略過'); }
  else {
    await goTo(`#/meetings/${mt.id}`);
    const localTabs = [...doc.querySelectorAll('#view [data-tab]')];
    ok('會議詳情有 local 分頁掣', localTabs.length > 0);
    ok('會議詳情啲分頁唔帶 data-tabnav（唔會被全域 handler 搶）',
      [...doc.querySelectorAll('#view [data-tabnav] [data-tab]')].length === 0);
    const att = localTabs.find(b => b.dataset.tab === 'attend');
    if (att) {
      att.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(250);
      ok('撳「出席」之後仲留喺同一個會議（唔會跳去 #/meetings/attend）',
        window.location.hash.startsWith(`#/meetings/${mt.id}`),
        `而家 ${window.location.hash}`);
    }
  }
}

/* ============================================================
   ④ 分頁入面啲掣冇 runtime error
   ============================================================ */
section('帳號與系統：每版嘅掣都撳得，冇 runtime error');
for (const [hash, label] of [['#/admin/accounts', '帳戶'], ['#/admin/unit', '旅團設定'], ['#/admin/data', '資料管理']]) {
  await goTo(hash);
  const before = errors.length;
  const btns = [...doc.querySelectorAll('#view [data-act]')]
    .filter(b => !/wipe|reset-seed|import-json/.test(b.dataset.act));
  for (const b of btns) {
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
    /* 有對話框就閂返，免得層層疊 */
    const ov = [...doc.querySelectorAll('.overlay')].pop();
    if (ov) {
      const cancel = [...ov.querySelectorAll('button')].find(x => /取消|閂|關閉/.test(x.textContent || ''));
      (cancel || ov.querySelector('[data-close-x]'))?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(80);
    }
  }
  ok(`${label}：撳晒 ${btns.length} 粒掣都冇 error`, errors.length === before,
    errors.slice(before, before + 1).join(' ').slice(0, 120));
}

/* ---------- 埋數 ---------- */
ok('全程冇 console.error', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));
console.log(`\n${fail === 0 ? '✅' : '❌'} tabs：${pass} 過 / ${fail} 唔過（${Date.now() - t0}ms）`);
process.exit(fail === 0 ? 0 : 1);
