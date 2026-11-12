/* ============================================================
   tests/ui-ia.mjs — 介面架構（IA）＋「無權就唔准入」
   -----------------------------------------------------------
   背景（2026-11-12 用家：「我在APP 內看到太多重複的東西了，東指西指，
   又有很多副標題」）。審計報告：UI_AUDIT_2026-11-12.md。
   用家定案：① 全面簡化　② 執委無權就唔准入（唔係唯讀）
   　　　　　③ 財政分頁收斂到 6 個。

   呢個檔鎖住三類唔可以再退回嘅嘢：
     ① F3 一個功能一個入口：NAV 係唯一登記冊；「資料管理」唔可以再
        變返做「系統」底下嘅指路分頁；舊 hash 一定要轉址唔可以斷。
     ② 分頁數量：財政 6 粒；系統 2 粒；深度唔超過 2 層。
     ③ 權限：執委入唔到 系統／資料管理（側欄冇、直入 URL 有告示），
        而且 save-sync 呢個 handler 自己要 fail-closed；
        但「改自己密碼」一定要照開到（admin.pw.self 人人有）。

   用法：node tests/ui-ia.mjs
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

const { installSuperAuth } = await import('./_authstub.mjs');
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
const { seedRosterRoles } = await import('./_roles.mjs');
await seedRosterRoles(store, auth);

const doc = window.document;
const view = () => doc.getElementById('view');
const vtext = () => (view()?.textContent || '').replace(/\s+/g, ' ');
const sideItems = () => [...doc.querySelectorAll('.sidebar [data-nav]')].map(b => b.dataset.nav);
const tabIds = () => [...doc.querySelectorAll('#view [data-tabnav] [data-tab]')].map(b => b.dataset.tab);

async function goTo(hash) { window.location.hash = hash; await wait(250); }
async function loginAs(role) {
  auth.logout();
  const r = await auth.login(role, role, role === 'chief' ? '8201' : role === 'leader' ? '8202' : '8203');
  await goTo('#/dashboard');
  /* auth.login() 本身唔會發 refresh（真實登入畫面係自己 call render）。
     如果上一個身份已經喺 #/dashboard，設同一個 hash 唔會觸發 hashchange
     → 側欄會留返上一手身份嘅 DOM。呢度補發 refresh，模擬登入畫面嘅行為。 */
  window.dispatchEvent(new window.CustomEvent('v82:refresh'));
  await wait(200);
  return r;
}

/* ============================================================
   ① NAV 登記冊：一個功能一個入口（F3）
   ============================================================ */
section('① NAV 登記冊（F3：未登記＝唔存在）');
await loginAs('leader');
{
  const items = sideItems();
  ok('側欄有「資料管理」（唔再係孤兒 route）', items.includes('tables'), JSON.stringify(items));
  ok('側欄有「系統」', items.includes('admin'));
  ok('教學唔再佔側欄一格（已搬頂欄）', !items.includes('docs'), JSON.stringify(items));
  ok('頂欄有「教學」掣（執委都搵得到說明）', !!doc.querySelector('.topbar [data-go="#/docs"], .topbar [data-nav="docs"]'));
  ok('側欄冇重複項目', new Set(items).size === items.length);
  await goTo('#/tables');
  ok('資料管理頂欄同側欄同名（唔再殘留舊名「表格與同步」)',
    (doc.querySelector('.topbar .tb-title')?.textContent || '').trim() === '資料管理',
    doc.querySelector('.topbar .tb-title')?.textContent || '');
}

/* ============================================================
   ② 舊連結一定要轉址，唔可以變空白頁
   ============================================================ */
section('② 舊書籤轉址');
{
  await goTo('#/admin/data');
  ok('舊 #/admin/data → #/tables', window.location.hash.startsWith('#/tables'), window.location.hash);
  ok('轉址後真係出到資料管理內容', /總表同步|儲存與備份|插入自己/.test(vtext()), vtext().slice(0, 90));

  await goTo('#/admin/accounts');
  ok('舊 #/admin/accounts → #/members/accounts（本來就有，唔可以整爛）',
    window.location.hash === '#/members/accounts', window.location.hash);
}

/* ============================================================
   ③ 分頁收斂：系統 2 粒、財政 6 粒
   ============================================================ */
section('③ 分頁數量（深度 ≤ 2 層）');
{
  await goTo('#/admin');
  const t = tabIds();
  ok('系統：得返 旅團設定／操作紀錄 兩粒', t.length === 2 && t.includes('unit') && t.includes('audit'), JSON.stringify(t));
  ok('系統冇咗「資料管理」指路分頁', !t.includes('data'), JSON.stringify(t));

  await goTo('#/finance');
  const f = tabIds();
  ok('財政：收斂到 6 粒', f.length === 6, JSON.stringify(f));
  ok('財政冇咗獨立「匯入舊帳」分頁', !f.includes('import'), JSON.stringify(f));
  ok('「年度報告」唔再同時有分頁（只留頂部掣）', !f.includes('reports')
    && !!doc.querySelector('#view [data-go="#/finance/reports"]'), JSON.stringify(f));

  await goTo('#/finance/settings');
  ok('匯入舊帳併入設定：仲有輸入框', !!doc.querySelector('#imp-text'));
  ok('匯入舊帳併入設定：仲有「匯入」掣', !!doc.querySelector('[data-act="do-import"]'));
  ok('整旅團備份入口直去真正嘅「儲存與備份」（唔再兜返已拆指路頁）',
    !!doc.querySelector('#fin-import [data-go="#/tables/data"]'));
  ok('設定頁嘅匯入區預設收埋（唔阻日常畫面）',
    !!doc.querySelector('#fin-import') && !doc.querySelector('#fin-import').hasAttribute('open'));

  await goTo('#/finance/import');
  ok('舊 #/finance/import 唔會斷（落設定頁）', !!doc.querySelector('#imp-text'), window.location.hash);
  ok('舊 #/finance/import 自動展開匯入區', !!doc.querySelector('#fin-import')?.hasAttribute('open'));

  await goTo('#/finance/reports');
  ok('頂部「年結報告」掣仍然去得到報告', /報告|年度/.test(vtext()), vtext().slice(0, 80));
}

/* ============================================================
   ④ 執委：無權就唔准入（用家定案）
   ============================================================ */
section('④ 執委（exco）：無權就唔准入');
{
  const r = await loginAs('exco');
  ok('執委登入到', r.ok === true, JSON.stringify(r));

  const items = sideItems();
  ok('執委側欄冇「系統」', !items.includes('admin'), JSON.stringify(items));
  ok('執委側欄冇「資料管理」', !items.includes('tables'), JSON.stringify(items));
  ok('執委仍然搵得到「教學」（docs.view 有權）',
    !!doc.querySelector('.topbar [data-go="#/docs"], .topbar [data-nav="docs"]'));

  await goTo('#/tables/sync');
  ok('執委直入 #/tables/sync → 有清楚告示（唔係空白／假畫面）',
    /權限|領袖/.test(vtext()), vtext().slice(0, 100));
  ok('執委睇唔到 API-Key 輸入欄（唔會打得到字但其實冇權）',
    !doc.querySelector('#view input[type="password"], #view #sy-key'));
  ok('告示頁有路走（返儀表板）', !!doc.querySelector('#view [data-go="#/dashboard"]'));
  ok('告示頁講咗「求救」就真係有粒求救掣（唔可以講咗冇）', !!doc.querySelector('#view #btnSOS'));

  await goTo('#/admin/unit');
  ok('執委直入 #/admin/unit → 同樣有告示', /權限|領袖/.test(vtext()), vtext().slice(0, 100));

  /* handler 自己要 fail-closed：就算有人塞粒掣入 DOM 都寫唔到 */
  const tables = await import('../assets/js/views/tables.js');
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  /* 俾齊真嘅輸入欄：咁樣如果 gate 冇咗，handler 會正常行完成並且**寫入**，
     下面「冇寫到任何嘢」就會乾淨地 ✗（唔係炒咗斷 suite）。 */
  host.innerHTML = `<input id="y-url" value="https://evil.test/exec">
    <input id="y-unit" value="9999"><input id="y-key" value="INJECTED">
    <button data-act="save-sync">x</button>`;
  tables.mount(host, { id: 'sync', query: {} });
  const before = JSON.stringify(store.load().sync || {});
  host.querySelector('[data-act="save-sync"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  ok('save-sync 對執委 fail-closed：冇寫到任何連線設定',
    JSON.stringify(store.load().sync || {}) === before,
    JSON.stringify(store.load().sync || {}).slice(0, 120));
  host.remove();

  /* 但改自己密碼一定要照開到 —— 之前 #btnPw 係 go('#/admin/data')，
     一旦封咗系統頁就會連自己密碼都改唔到（回歸陷阱） */
  await goTo('#/dashboard');
  const pwBtn = doc.querySelector('#btnPw, #btnPw2');
  ok('頂欄有「改密碼」掣', !!pwBtn);
  if (pwBtn) {
    pwBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(250);
    const dlgTxt = (doc.body.textContent || '').replace(/\s+/g, ' ');
    ok('執委撳「改密碼」開到真正嘅密碼彈窗（唔係跳去被禁嘅頁）',
      /目前密碼/.test(dlgTxt) && !!doc.querySelector('#q-old'), window.location.hash);
    ok('撳改密碼之後 hash 冇跳去 #/admin/data',
      !window.location.hash.startsWith('#/admin'), window.location.hash);
    doc.querySelector('.modal-mask, .modal-backdrop, [data-close]')?.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
  }
}

/* ============================================================
   ⑤ 領袖／團長：簡化唔可以收走佢哋嘅功能
   ============================================================ */
section('⑤ 領袖／團長：功能冇被收走');
for (const role of ['leader', 'chief']) {
  const r = await loginAs(role);
  ok(role + ' 登入到', r.ok === true, JSON.stringify(r));
  const items = sideItems();
  ok(role + '：側欄有 系統 ＋ 資料管理', items.includes('admin') && items.includes('tables'), JSON.stringify(items));
  await goTo('#/tables/sync');
  ok(role + '：總表同步開得到（有輸入欄）', !!doc.querySelector('#view input'), vtext().slice(0, 80));
  if (role === 'leader') {
    await goTo('#/tables/data');
    const backupActs = ['export-json', 'import-json', 'reset-seed', 'wipe'];
    ok('刪指路頁冇刪真功能：JSON 備份／匯入／重設／清空四粒掣齊晒',
      backupActs.every(a => !!doc.querySelector(`#view [data-act="${a}"]`)),
      backupActs.filter(a => !doc.querySelector(`#view [data-act="${a}"]`)).join(', '));
    doc.querySelector('#view [data-act="export-json"]')?.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
    ok('「匯出全部（JSON）」唔係死掣：撳完有成功回覆',
      [...doc.querySelectorAll('.toast')].some(t => /已匯出備份/.test(t.textContent || '')));
  }
  await goTo('#/admin/unit');
  ok(role + '：旅團設定開得到', /旅團編號|本旅團資料/.test(vtext()), vtext().slice(0, 80));
}

/* ============================================================
   ⑥ 副標題：唔可以再「把分頁名讀一次」
   ============================================================ */
section('⑥ 副標題瘦身');
{
  await loginAs('leader');
  await goTo('#/tables');
  const sub = doc.querySelector('#view .page-sub')?.textContent || '';
  ok('資料管理冇咗「三樣嘢：…」重複副標', !/三樣嘢/.test(sub), sub);
  await goTo('#/admin');
  const asub = doc.querySelector('#view .page-sub')?.textContent || '';
  ok('系統副標題唔再讀一次分頁名', !/旅團設定／資料管理／操作紀錄/.test(asub), asub);
}

section('全程健康');
ok('全程冇 console.error', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${fail === 0 ? '✅' : '❌'} ui-ia：${pass} 過 / ${fail} 唔過（${Date.now() - t0}ms）`);
process.exit(fail === 0 ? 0 : 1);
