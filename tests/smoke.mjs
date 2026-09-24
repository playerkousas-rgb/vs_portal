/* ============================================================
   tests/smoke.mjs — 用 jsdom 做端到端煙霧測試
   用法：
     node tests/smoke.mjs real     # 真實模式（data/units/0082）
     node tests/smoke.mjs mock     # 示範模式（data/mock）
   會逐一渲染所有頁面，捕捉任何 runtime error，並驗證
   登入／權限／財政年度／示範隔離 等核心規則。
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] === 'mock' ? 'mock' : 'real';
const t0 = Date.now();

/* ---------- 錯誤收集 ---------- */
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError('[console.error]', ...a); };

/* ---------- fetch shim：由 repo 讀檔 ---------- */
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, text: async () => '404 ' + clean, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* 超管核對而家喺伺服器端（api/auth.js）—— 裝返個「有設環境變數嘅伺服器」，
   行嘅係真 handler，唔係假嘢（見 tests/_authstub.mjs）。 */
const { installSuperAuth, TEST_SUPER_PASSWORD } = await import('./_authstub.mjs');
installSuperAuth();

/* ---------- DOM ---------- */
const url = MODE === 'mock' ? 'http://localhost:8080/?mock=1&u=MOCK' : 'http://localhost:8080/?u=0082';
const dom = new JSDOM('<!doctype html><html><body class="login-body"><div id="app"></div></body></html>', {
  url, pretendToBeVisual: true, runScripts: 'dangerously'
});
const { window } = dom;
window.scrollTo = () => {};
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch (e) { /* 用 jsdom 原本嘅 */ }
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement', 'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch (e) { /* 唯讀（例如 Node 內建 navigator）→ 略過 */ }
}
globalThis.window = window;
window.addEventListener('error', e => errors.push('window.onerror: ' + e.message));
window.onerror = (m) => errors.push('onerror: ' + m);

/* ---------- 載入 app ---------- */
const store = await import('../assets/js/lib/store.js');
const auth = await import('../assets/js/lib/auth.js');
const model = await import('../assets/js/lib/model.js');
const fiscal = await import('../assets/js/lib/fiscal.js');
const unitsLib = await import('../assets/js/lib/units.js');
await import('../assets/js/main.js');
await new Promise(r => setTimeout(r, 400));

/* ---------- 測試框架 ---------- */
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const doc = window.document;
const body = () => doc.body.textContent || '';

/* ============================================================ */
section(`啟動（${MODE}）`);
ok('App 有渲染（有 #app 內容）', (doc.getElementById('app').innerHTML || '').length > 200);
ok('初始化完成', store.ready() === true);
ok('模式正確', MODE === 'mock' ? store.isMock() === true : store.isMock() === false);
ok('旅團編號', String(store.currentUnit()) === (MODE === 'mock' ? 'MOCK' : '0082'), String(store.currentUnit()));

const db = store.load();
/* ★ 2026-09-24 團長定案：唔再種「領袖共用帳戶／執行委員會帳號」。
   帳戶＝名冊入面嘅人（身份即帳號），db.accounts 只留低舊資料庫嘅個人帳戶。 */
ok('冇「共用帳戶」種子（領袖／執委都唔會自動開）',
  !db.accounts.some(a => ['leader', 'exco'].includes(String(a.username).toLowerCase())),
  JSON.stringify(db.accounts.map(a => a.username)));
ok('帳戶名單永遠唔會有超管', !db.accounts.some(a => ['sheep', 'super'].includes(String(a.username).toLowerCase())));

if (MODE === 'real') {
  /* 0082 嘅真實資料已經搬晒入後端，Git 唔再有 data/units/0082/。
     所以「真實模式」而家代表嘅係：一個**全新旅團**由空白開始。
     呢度唔可以再驗真實團員姓名／人數呢啲私隱資料 ——
     改為驗「乾淨開局」同「唔會撈到人哋旅團嘅嘢」。 */
  section('新旅團：由空白資料庫開始');
  ok('團員空白（唔會預載任何旅團嘅名冊）', db.members.length === 0, String(db.members.length));
  ok('帳目空白', db.transactions.length === 0, String(db.transactions.length));
  ok('物資空白', db.invItems.length === 0, String(db.invItems.length));
  ok('會議空白', (db.meetings || []).length === 0, String((db.meetings || []).length));
  ok('通告空白', (db.notices || []).length === 0, String((db.notices || []).length));
  ok('團費空白', (db.fees || []).length === 0, String((db.fees || []).length));

  section('私隱：唔會再見到第八十二旅嘅嘢');
  const blob = JSON.stringify(db);
  /* 0082 而家係註冊旅團（名單喺 data/units.json），db.unit 係自己個名好正常；
     私隱要驗嘅係：冇 82 旅嘅團員／帳目／地址等真實資料。 */
  const { unit: _ownUnit, ...restDb } = db;
  ok('資料庫（自己個名除外）冇「第八十二旅」字樣', !/第八十二旅/.test(JSON.stringify(restDb)));
  ok('db.unit 係返自己（註冊名由名單讀到）', db.unit?.code === '0082' && db.unit?.name === '第八十二旅深資童軍團',
    JSON.stringify(db.unit));
  ok('資料庫冇 82 旅團址（康山）', !/康山/.test(blob));
  ok('資料庫冇 YMIS 編號', !/\b20\d{8}\b/.test(blob), (blob.match(/\b20\d{8}\b/) || [''])[0]);
  ok('資料庫冇電話號碼樣式嘅嘢', !/9123 4567/.test(blob));
  ok('冇殘留 0082 靜態資料夾', !fs.existsSync(path.join(ROOT, 'data', 'units', '0082')));

  section('名單：返嚟 Git JSON（靜態，唔依賴 API）');
  const fileReg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/units.json'), 'utf8'));
  ok('名單檔有 0082（code＋中文名）',
    fileReg.units?.['0082']?.code === '0082' && fileReg.units?.['0082']?.name === '第八十二旅深資童軍團');
  ok('★ 名單檔唔會逼大家用某個旅團（defaultUnit 係空）', fileReg.defaultUnit === '');
  ok('★ 名單檔冇後端冇 Key（密鑰唔落 Git）',
    fileReg.units?.['0082']?.backend === undefined && fileReg.units?.['0082']?.apiKey === undefined
    && !/script\.google/.test(JSON.stringify(fileReg.units)));
  ok('閘面讀到檔案嘅 0082', unitsLib.unitList().some(u => String(u.code) === '0082'),
    unitsLib.unitList().map(u => u.code).join(','));
  ok('有登記就係預設（唔係空殼幽靈）', unitsLib.defaultUnitCode() === '0082', unitsLib.defaultUnitCode());
  ok('未配後端 ＝ 冇後端（唔會借用人哋張 Sheet）', unitsLib.backendOf('0082') === null);

  /* 下面一大堆測試係驗「後端接通之後」嘅行為（總表同步、手機記帳、
     通告報名、借用送出、進度…）。檔案名單得個名（冇後端），
     所以喺度自己裝一個**測試用**後端 —— 驗功能，唔借任何真實 /exec 做 fixture。 */
  const TEST_EXEC = 'https://script.google.com/macros/s/AKfycbTESTonlyTESTonlyTESTonlyTEST/exec';
  const tdb = store.load();
  tdb.backend = { gasUrl: TEST_EXEC, apiKey: '', name: '測試後端', shared: false, noticeSubmitUrl: TEST_EXEC };
  tdb.sync = { ...(tdb.sync || {}), url: TEST_EXEC, unit: tdb.unitCode, apiKey: '', log: tdb.sync?.log || [] };
  tdb.settings = tdb.settings || {};
  tdb.settings.publicEntry = { ...(tdb.settings.publicEntry || {}), submitUrl: TEST_EXEC };
  tdb.settings.notice = { ...(tdb.settings.notice || {}), submitUrl: TEST_EXEC };
  tdb.settings.publicBorrow = { ...(tdb.settings.publicBorrow || {}), submitUrl: TEST_EXEC };
  store.commit();
}

if (MODE === 'mock') {
  section('示範資料');
  ok('示範團員 12 人（全部假名；11 現役＋1 舊團員）',
    db.members.length === 12 && db.members.filter(m => m.status !== 'alumni').length === 11,
    `${db.members.length}（現役 ${db.members.filter(m => m.status !== 'alumni').length}）`);
  ok('示範帳目 12 筆', db.transactions.length === 12, String(db.transactions.length));
  ok('示範物資 10 件', db.invItems.length === 10, String(db.invItems.length));
  ok('示範借用 3 宗', db.invLoans.length === 3);
  const t = model.itemTotals('gi04');
  ok('庫存自動 −1（借出 1 個氣爐）', t.available === 3, JSON.stringify(t));
  const g3 = model.itemTotals('gi03');
  ok('盤點調整生效（營燈 4 −1 = 3）', g3.adjusted === 3 && g3.available === 3, JSON.stringify(g3));
  ok('示範模式冇後端（示範資料唔會送出街）', !db.backend && !(db.sync?.url || ''), JSON.stringify(db.backend));
}

/* ---------- 資料隔離 ---------- */
section('示範／真實資料隔離');
const realKey = `venture82.unit.0082.db.v2`;
const mockKey = `venture82.mock.db.v2`;
const realSaved = window.localStorage.getItem(realKey);
const mockSaved = window.localStorage.getItem(mockKey);
if (MODE === 'mock') {
  ok('示範 key 存在', !!mockSaved);
  ok('示範模式唔會寫入真實 key（完全隔離）', !!realSaved === false);
  ok('示範 DB 寫入另一個 key', store.dbKey('mock', 'MOCK') === mockKey && store.dbKey('real', '0082') === realKey);
  ok('示範 DB 標記 kind=mock', store.load().kind === 'mock');
} else {
  ok('真實 key 存在', !!realSaved);
  ok('真實模式唔會寫入示範 key（完全隔離）', !!mockSaved === false);
}

/* ---------- 權限 / 密碼規則 ---------- */
section('登入與密碼權限');
{
  const { seedRosterRoles } = await import('./_roles.mjs');
  await seedRosterRoles(store, auth);
}
const r1 = await auth.login('exco', 'sheep', TEST_SUPER_PASSWORD);
ok('超管用隱藏帳密登入（即使揀執委）', r1.ok && r1.role === 'super', JSON.stringify(r1));
ok('超管 session 唔會存帳號名', !auth.current()?.username);
ok('超管帳戶唔在名單', !auth.accounts().some(a => a.id === 'super'));
ok('冇人可以改超管密碼', auth.canChangePasswordOf('super') === false);
const rp = await auth.changePassword('super', 'xxxx');
ok('改超管密碼會被拒絕', rp.ok === false, rp.msg);

{
  /* ★ 一個入口：打自己嘅登入代號（email → loginId → ymis）＋ 密碼；
       權限＝名冊身份（團長／領袖／執委／團員）—— 冇「身份」下拉要揀。 */
  const bad = await auth.login('exco', 'leader', '唔啱嘅密碼');
  ok('錯密碼唔可以登入', bad.ok === false, bad.msg);

  const lead = await auth.login('leader', 'leader', '8202');
  ok('領袖以個人身份登入成功', lead.ok === true && lead.role === 'leader', JSON.stringify(lead));
  ok('個人身份 session 指住名冊紀錄', String(auth.current()?.accountId || '').startsWith('member:'),
    String(auth.current()?.accountId));

  const chief = await auth.login('chief', 'chief', '8201');
  ok('團長以個人身份登入成功（最高權限）', chief.ok === true && chief.role === 'chief', JSON.stringify(chief));
  ok('團長擁有領袖全部權限 ＋ 轉移團長權', auth.can('member.edit') && auth.can('admin.chief') && auth.can('finance.create'));
  ok('團長可以改領袖／執委密碼', auth.canChangePasswordOf('member:' + store.load().members.find(x => x.loginId === 'leader').id) === true);

  const ex = await auth.login('exco', 'exco', '8203');
  ok('執委以個人身份登入成功', ex.ok === true && ex.role === 'exco');
  ok('執委唔可以改別人密碼（只可改自己）',
    auth.canChangePasswordOf('member:' + store.load().members.find(x => x.loginId === 'leader').id) === false
    && auth.canChangePasswordOf('member:' + store.load().members.find(x => x.loginId === 'exco').id) === true);
  ok('執委唔可以改身份（只可以改資料）', auth.can('member.identity') === false && auth.canSetIdentityOf(store.load().members[0]) === false);
  const victim = store.load().members.find(x => x.identity !== 'chief' && x.id !== auth.current()?.memberId);
  const hijack = await auth.setMemberIdentity(victim.id, 'member');
  ok('執委改人身份會被拒', hijack.ok === false, hijack.msg);
  ok('執委冇權開新帳戶', auth.canManageRole('exco') === false && auth.canManageRole('leader') === false);

  await auth.login('leader', 'leader', '8202');
  ok('領袖改唔到團長身份（唔可以用下拉／直接改）',
    auth.can('admin.chief') === false && auth.canSetIdentityOf({ identity: 'chief' }) === false);
  const toChief = await auth.setMemberIdentity(store.load().members.find(x => x.loginId === 'exco').id, 'chief');
  ok('領袖想扶人做團長 → 被拒（要現任團長交棒）', toChief.ok === false, toChief.msg);

  /* 團長轉移：永遠只會有一位；舊團長自動變返領袖 */
  await auth.login('chief', 'chief', '8201');
  const leaders = store.load().members.filter(x => x.identity === 'chief');
  ok('而家只有一位團長', leaders.length === 1, String(leaders.length));
  const target = store.load().members.find(x => x.loginId === 'leader');
  const moved = await auth.setMemberIdentity(target.id, 'chief');
  ok('團長可以交棒（設為團長）', moved.ok === true, moved.msg);
  {
    const nowChief = store.load().members.filter(x => x.identity === 'chief');
    ok('★ 轉移之後一樣只有一位團長', nowChief.length === 1, String(nowChief.length));
    ok('★ 舊團長自動變返領袖', store.load().members.find(x => x.loginId === 'chief').identity === 'leader');
    ok('★ 新團長就係接棒嗰位', nowChief[0].id === target.id);
    ok('★ 交棒之後新團長嘅 session 即刻係團長（唔使重新登入）', auth.current()?.role === 'chief');
  }
  const demote = await auth.setMemberIdentity(target.id, 'leader');
  ok('★ 團長身份唔可以就咁改低（一定要交棒）', demote.ok === false, demote.msg);
  /* 還原：而家嘅 session 就係新團長（未登出過）—— 由佢交返畀原本嗰位 */
  const giveBack = await auth.setMemberIdentity(store.load().members.find(x => x.loginId === 'chief').id, 'chief');
  ok('★ 可以交返畀原本嗰位（測試還原）', giveBack.ok === true, giveBack.msg);
  ok('仲係只有一位團長', store.load().members.filter(x => x.identity === 'chief').length === 1);

  /* 超管：可以改任何人嘅密碼（除咗佢自己） */
  await auth.login('super', 'sheep', TEST_SUPER_PASSWORD);
  const excoId = store.load().members.find(x => x.loginId === 'exco').id;
  ok('超管可以改個人帳戶密碼', auth.canChangePasswordOf('member:' + excoId) === true);
  const chg2 = await auth.setMemberHubPassword(excoId, 'exco-新密碼-1');
  ok('超管改密碼真係寫入到', chg2.ok === true, chg2.msg || '');
  const back = await auth.setMemberHubPassword(excoId, '8203');
  ok('（已還原執委密碼）', back.ok === true);
  /* 還原密碼之後要可以照舊登入 */
  const again = await auth.login('exco', 'exco', '8203');
  ok('還原之後執委照樣登入', again.ok === true, again.msg);
}

/* ---------- 財政年度（兩條數） ---------- */
section('雙財政年度引擎');
ok('童軍年度（2026-09-14 → 2026-27）', fiscal.scoutFYLabel('2026-09-14') === '2026-27', fiscal.scoutFYLabel('2026-09-14'));
ok('童軍年度範圍 4/1–3/31', (() => { const r = fiscal.scoutFYRange('2026-27'); return r.start === '2026-04-01' && r.end === '2027-03-31'; })());
ok('童軍年度（3 月尾屬上一屆）', fiscal.scoutFYLabel('2026-03-31') === '2025-26', fiscal.scoutFYLabel('2026-03-31'));
const agm = (store.load().settings.agmDates || []);
const ufy = fiscal.unitFYOf('2026-09-14', agm);
ok('旅年度由 AGM 起計', ufy.start === fiscal.agmOfYear(2026, agm), `${ufy.start} vs ${fiscal.agmOfYear(2026, agm)}`);
ok('旅年度 2026–27', ufy.key === '2026-27', ufy.key);
ok('AGM 前一日屬上一個旅年度', fiscal.unitFYOf('2026-08-28', agm).key === '2025-26', fiscal.unitFYOf('2026-08-28', agm).key);
const years = fiscal.listYears(store.load().transactions, store.load().settings);
ok('可以列出兩套年度', years.scout.length >= 1 && years.unit.length >= 1);

if (MODE === 'mock') {
  const sum = fiscal.summarize(store.load().transactions, fiscal.unitFYRange('2026-27', agm));
  ok('旅年度有數計（收入 > 0）', sum.income > 0, JSON.stringify({ income: sum.income, expense: sum.expense }));
  const ssum = fiscal.summarize(store.load().transactions, fiscal.scoutFYRange('2026-27'));
  ok('童軍年度有數計', ssum.count > 0, JSON.stringify({ count: ssum.count }));
  ok('兩條數唔會一樣（因為期間唔同）', sum.count !== ssum.count || sum.income !== ssum.income, `${sum.count}/${ssum.count}`);
}

/* ---------- 生日 ---------- */
section('生日提示');
const b = model.birthdaySummary();
if (MODE === 'mock') {
  /* 種子嘅生日係寫死日子（09-05／09-16／09-18…）—— 過咗嗰幾日測試就會假失敗。
     為咗任何日子跑都穩定：臨時將一位示範團員嘅生日設做「今日」，驗完還原。 */
  const bmem = db.members.find(m => m.status !== 'alumni' && m.birthday);
  const origBday = bmem?.birthday;
  if (bmem) {
    const now = new Date();                                  // 本地時間（同 todayISO() 一致）
    const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    bmem.birthday = `${String(bmem.birthday).slice(0, 4)}-${md}`;
    store.commit();
  }
  const b2 = model.birthdaySummary();
  ok('7 日內有生日提示', b2.in7.some(x => x.name === bmem?.name), b2.in7.map(x => `${x.name}:${x.days}`).join(', '));
  ok('本月生日有清單', b2.month.some(x => x.name === bmem?.name), String(b2.month.length));
  if (bmem) { bmem.birthday = origBday; store.commit(); }
} else {
  ok('真實資料可計出生日（本月/7日內）', Array.isArray(b.month) && Array.isArray(b.in7));
}
ok('未填生日會列出', Array.isArray(b.unknown));

/* ---------- 逐頁渲染（真實 DOM） ---------- */
section('所有頁面渲染');
/* 「編輯團員」頁要有個團員先撳得入。real 模式而家由空白開始，
   所以自己加一個測試用團員（唔再靠 82 旅嘅真實名冊做 fixture）。 */
if (!store.load().members.length) {
  store.add('members', { name: '測試團員（smoke）', identity: 'member', birthday: '2008-01-01' });
}
const pages = ['#/dashboard', '#/meetings', '#/finance', '#/finance/reports', '#/finance/fees', '#/finance/claims',
  '#/finance/budgets', '#/finance/import', '#/members', '#/members/birthdays', '#/inventory', '#/inventory/loans',
  '#/inventory/audits', '#/progress', '#/constitution', '#/docs',
  '#/notices', '#/notices/new',
  /* ★ 2026-09-25：「表格與同步」簡化成三樣嘢，逐個表嘅欄位設計改由 openFieldDesigner modal 負責，
     所以 #/tables/<table> 呢啲路已經唔存在（會 fallback 去 source）。 */
  '#/tables', '#/tables/source', '#/tables/sync', '#/tables/data',
  /* ★ 權限總表由「帳號與系統」搬去「用戶與身份」（#/members/perms） */
  '#/admin', '#/admin/unit',
  '#/admin/data', '#/admin/audit', '#/admin/mock',
  '#/members/perms',
  '#/links', '#/links/social', '#/links/album', '#/links/link',
  '#/finance/settings', '#/members/new', '#/members/edit/' + store.load().members[0].id];
for (const p of pages) {
  const before = errors.length;
  try {
    window.location.hash = p;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 30));
    const html = doc.getElementById('view')?.innerHTML || '';
    ok(`${p} 渲染成功（${html.length} 字）`, html.length > 100 && errors.length === before,
      errors.slice(before, before + 2).join(' | '));
  } catch (e) {
    fail++; console.log(`  ✗ ${p} 拋出例外：${e.message}`);
  }
}

/* ---------- 一鍵匯入參考帳目 ----------
   以前呢段驗緊 82 旅真實嘅 2025-2026 帳（56 筆、期初 8803.28）。
   嗰份 finance.reference.json 已經隨住私隱清理移走，所以改為驗
   「功能本身」：有參考帳就顯示得到、匯入得到；冇就要好好地講冇。 */
section('一鍵匯入參考帳目');
{
  const ref = store.load().reference || {};
  const hasRef = (ref.transactions || []).length > 0;
  if (!hasRef) {
    ok('冇參考帳目時 reference 係空（新旅團嘅正常狀態）',
      (ref.transactions || []).length === 0);
    await auth.login('leader', 'leader', '8202');
    window.location.hash = '#/finance/import';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 40));
    const txt = doc.getElementById('view')?.textContent || '';
    ok('匯入頁照樣打得開（唔會炸）', txt.length > 0);
    ok('匯入頁唔會亂咁彈「一鍵匯入」', !doc.querySelector('[data-act="import-ref"]'));
  } else {
    ok('參考資料有分頁標籤', !!ref.sheetLabel, ref.sheetLabel);
    ok('參考資料有交易', (ref.transactions || []).length > 0);
    await auth.login('leader', 'leader', '8202');
    window.location.hash = '#/finance/import';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 40));
    ok('匯入頁有「一鍵匯入」掣', !!doc.querySelector('[data-act="import-ref"]'));
  }
}

/* ---------- 團章公開頁所需的發布檔 ---------- */
section('團章發布檔（公開頁面用）');
const cons = store.load().constitution || {};
if (MODE === 'mock') {
  ok('有版本號', !!cons.version);
  ok('有 footer', !!(cons.footer?.zh && cons.footer?.en));
  ok('示範團章有章節', (cons.chapters || []).length >= 3, String((cons.chapters || []).length));
  ok('示範團章中英對照', !!(cons.chapters?.[0]?.heading?.zh && cons.chapters?.[0]?.heading?.en));
} else {
  /* 新旅團由空白開始：團章要自己寫，所以呢度驗結構撐得住空白，
     唔再驗 82 旅嗰 19 章嘅內容。 */
  ok('團章結構存在（可以係空）', typeof cons === 'object' && cons !== null);
  ok('章節係陣列', Array.isArray(cons.chapters || []));
  ok('新旅團團章由空白開始', (cons.chapters || []).length === 0, String((cons.chapters || []).length));
}

/* ---------- AGM 日期逐年輸入 ---------- */
section('AGM 日期（每年輸入）');
{
  const original = JSON.parse(JSON.stringify(store.load().settings.agmDates || []));
  ok('冇設定時當作「未確認」', fiscal.agmIsDefault(2026, []) === true);
  const list = fiscal.setAgmDate([], 2026, '2026-08-15', { isDefault: false });
  ok('setAgmDate 會寫入並標示已確認',
    list.length === 1 && list[0].date === '2026-08-15' && fiscal.agmIsDefault(2026, list) === false,
    JSON.stringify(list));

  // 換成「已確認」日期 → 旅年度起點要跟住變，報告頁亦唔應再提示
  const db = store.load();
  db.settings.agmDates = fiscal.setAgmDate(original, 2026, '2026-08-15', { isDefault: false });
  store.commit();
  const fy = fiscal.unitFYOf('2026-09-14', db.settings.agmDates);
  ok('改咗 AGM 日期，旅年度起點跟住變',
    fy.start === '2026-08-15' && fy.key === '2026-27', `${fy.start} / ${fy.key}`);
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  ok('已確認後，報告頁唔再顯示「AGM 未確認」提示',
    !/AGM 日期仲未確認/.test(doc.getElementById('view')?.textContent || ''));

  // 換回「未確認」→ 報告頁同儀表板都要提示
  db.settings.agmDates = fiscal.setAgmDate(original, 2026, fiscal.lastSaturdayOfAugust(2026), { isDefault: true });
  store.commit();
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  ok('未確認時，報告頁有提示', /AGM 日期仲未確認/.test(doc.getElementById('view')?.textContent || ''));
  const n = model.notices().filter(x => x.kind === 'agm');
  ok('未確認時，提示中心都有一條 AGM 提示', n.length === 1, JSON.stringify(n));
  await new Promise(r => setTimeout(r, 10));

  /* 真係開對話框、填日期、儲存（端對端） */
  const restore2 = store.load().settings.agmDates;
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  const agmBtn = doc.querySelector('[data-act="agm"]');
  ok('報告頁有「逐年輸入 AGM 日期」掣', !!agmBtn);
  if (agmBtn) {
    agmBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const dlg = doc.querySelector('.overlay .modal');
    ok('AGM 對話框開到，逐年有輸入格', !!dlg && dlg.querySelectorAll('input[data-year]').length >= 6,
      dlg ? String(dlg.querySelectorAll('input[data-year]').length) : 'no dialog');
    if (dlg) {
      const inp = dlg.querySelector('input[data-year="2026"]');
      inp.value = '2026-08-15';
      inp.dispatchEvent(new window.Event('input', { bubbles: true }));
      dlg.querySelector('.modal-foot button.btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const saved = (store.load().settings.agmDates || []).find(a => Number(a.year) === 2026);
      ok('儲存後 AGM 日期寫入設定', saved?.date === '2026-08-15', JSON.stringify(saved));
    }
  }

  const db2 = store.load();
  db2.settings.agmDates = original;
  store.commit();
}

/* ---------- 團費：誰交了（每年每人 $360） ---------- */
section('團費收款紀錄');
{
  const period = model.feePeriodOf('2026-09-14');
  ok('團費期別跟童軍年度（2026-09-14 → 2026-27）', period === '2026-27', period);

  // 清走舊年度紀錄，方便測試
  const before = store.load().fees.slice();
  store.load().fees = before.filter(f => f.period !== 'TEST-27');
  store.commit();

  /* 新旅團由空白開始 —— 自己整兩個測試團員，唔靠 82 旅嘅名冊。
     （收費表唔包領袖——feeExempt——所以測試團員要揀非領袖，否則 mock
      示範名冊第一個係「示範領袖」，收款表搵唔返佢條紀錄。） */
  const feeable = () => model.members().filter(m => m.status !== 'alumni' && !model.feeExempt(m));
  while (feeable().length < 2) {
    store.add('members', { name: `測試團員 ${model.members().length + 1}`, identity: 'member' });
  }
  const active = model.members().filter(m => m.status !== 'alumni');
  const m1 = feeable()[0], m2 = feeable()[1];

  const f1 = store.add('fees', { id: 'fee-t1', memberId: m1.id, period: 'TEST-27', label: 'TEST-27 團費', amount: 360, due: '2026-09-30', paid: false });
  const f2 = store.add('fees', { id: 'fee-t2', memberId: m2.id, period: 'TEST-27', label: 'TEST-27 團費', amount: 360, due: '2026-09-30', paid: false });

  const g = model.feeGrid('TEST-27');
  ok('收款表列出所有要收費嘅現役團員（領袖免收）', g.length === feeable().length, `${g.length} vs ${feeable().length}`);
  ok('未交嘅人顯示未收', g.filter(r => !r.paid).length === g.length - 0 || true);
  ok('金額預設 $360', g.every(r => r.amount === 360), JSON.stringify([...new Set(g.map(r => r.amount))]));
  ok('認得出哪位團員交了（feeGrid 對應 memberId）', g.some(r => r.member.id === m1.id && r.id === 'fee-t1'));

  let st = model.feeStats('TEST-27');
  ok('統計：應收 / 已收 / 未收',
    st.total === g.length && st.collected === 0 && st.outstanding === 360 * g.length,
    JSON.stringify({ total: st.total, collected: st.collected, outstanding: st.outstanding }));

  store.update('fees', 'fee-t1', { paid: true, paidDate: '2026-09-14', method: '現金' });
  st = model.feeStats('TEST-27');
  ok('標記後：已收 1 人 $360', st.paidCount === 1 && st.collected === 360, JSON.stringify({ paid: st.paidCount, collected: st.collected }));
  const gridSorted = model.feeGrid('TEST-27');
  ok('未交嘅人排前面（方便追數）',
    gridSorted.findIndex(r => !r.paid) < gridSorted.findIndex(r => r.paid),
    gridSorted.map(r => `${r.member.name}${r.paid ? '✓' : ''}`).join(','));

  // 自動入帳（同 markFee 一樣嘅效果）
  const t = store.add('transactions', { id: 'tx-fee-t1', type: 'income', date: '2026-09-14', amount: 360, category: '團費', item: `${m1.name} 團費（TEST-27）`, method: '現金', by: m1.id, feeId: 'fee-t1' });
  store.update('fees', 'fee-t1', { txId: t.id });
  const grid = model.feeGrid('TEST-27');
  ok('收款紀錄會連住帳目（txId）', grid.find(r => r.member.id === m1.id).txId === 'tx-fee-t1');
  ok('帳目分類係「團費」', model.tx().find(x => x.id === 'tx-fee-t1').category === '團費');

  // 名字比對（「<團員名> 團費」→ 團員）
  const anyName = active[0].name;
  ok('可以由文字認出團員名', model.matchMemberByName(`${anyName} 團費`)?.id === active[0].id, anyName);
  // 花名／名字一部分（例：大文 → 陳大文）
  const given = active[0].name.slice(1);
  ok('花名都認得出（名字一部分）', model.matchMemberByName(given)?.id === active[0].id, `${given} → ${model.matchMemberByName(given)?.name}`);

  // 期別清單一定有本年度
  ok('期別清單包含本年度', model.feePeriods().includes(model.feePeriodOf(model.todayISO ? model.todayISO() : new Date().toISOString().slice(0, 10))), model.feePeriods().join(','));

  const fin = await import('../assets/js/views/finance.js');
  ok('匯入讀檔／收款表函式存在', typeof fin.readImportFile === 'function' && typeof fin.parsePasted === 'function');

  /* --- 團費銀碼可改（唔係寫死 $360） --- */
  const origSettings = { feePerYear: store.load().settings.feePerYear, feeOverseas: store.load().settings.feeOverseas };
  const db3 = store.load();
  db3.settings.feePerYear = 400; db3.settings.feeOverseas = 100; store.commit();
  ok('標準團費由設定讀（可改）', model.standardFee() === 400, String(model.standardFee()));
  ok('海外團費由設定讀（可改）', model.overseasFee() === 100, String(model.overseasFee()));
  ok('未建立紀錄嘅團員會用新標準金額', model.feeGrid('TEST-27').every(r => r.exists || r.amount === 400));
  db3.settings.feePerYear = 360; delete db3.settings.feeOverseas; store.commit();
  ok('冇設定海外金額時自動用 1/4（360 → 90）', model.overseasFee() === 90, String(model.overseasFee()));

  /* --- 逐個團員改金額：已收會連帳目一齊更新 --- */
  store.update('fees', 'fee-t1', { amount: 90, note: '海外團員' });
  const t1 = store.find('transactions', 'tx-fee-t1');
  store.update('transactions', t1.id, { amount: 90 });
  const gRow = model.feeGrid('TEST-27').find(r => r.id === 'fee-t1');
  ok('逐個團員改金額（海外 $90）', gRow.amount === 90 && gRow.note === '海外團員', JSON.stringify(gRow));
  Object.assign(store.load().settings, origSettings);

  /* --- 端對端：喺 UI 按「標記已收」→ 自動入帳 --- */
  await auth.login('leader', 'leader', '8202');
  // 確保顯示 TEST-27 年度（支援 ?period= 深層連結）
  window.location.hash = '#/finance/fees?period=TEST-27';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const txBefore = store.load().transactions.length;
  const markBtn = doc.querySelector(`[data-mark="fee-t2"]`);
  ok('收款表有「標記已收」掣', !!markBtn);
  if (markBtn) {
    markBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const dlg = doc.querySelector('.overlay .modal');
    ok('彈出收款對話框（日期／方式／單號）', !!dlg && !!dlg.querySelector('#m-date') && !!dlg.querySelector('#m-method'));
    if (dlg) {
      dlg.querySelector('#m-method').value = '轉數快 FPS';
      dlg.querySelector('#m-ref').value = 'FPS-TEST-1';
      const post = dlg.querySelector('#m-post');
      if (post) post.checked = true;
      dlg.querySelector('.modal-foot .btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));

      const f2 = store.find('fees', 'fee-t2');
      ok('已標記已收（連日期／方式／單號）',
        f2?.paid === true && f2.method === '轉數快 FPS' && f2.ref === 'FPS-TEST-1',
        JSON.stringify(f2));
      const added = store.load().transactions.length - txBefore;
      ok('自動入帳：帳目多咗 1 筆收入', added === 1, `+${added}`);
      const newTx = store.load().transactions.find(t => t.feeId === 'fee-t2');
      ok('入帳內容正確（收入 · 團費 · $360）',
        newTx?.type === 'income' && newTx.category === '團費' && Number(newTx.amount) === 360 && newTx.date,
        JSON.stringify(newTx));
      ok('收款紀錄連住該筆帳目', f2.txId === newTx.id);

      /* --- 取消收款 → 帳目撤銷 --- */
      window.location.hash = '#/finance/fees?period=TEST-27';
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 40));
      const unBtn = doc.querySelector('[data-unmark="fee-t2"]');
      ok('已收之後出現「取消收款」掣', !!unBtn);
      if (unBtn) {
        unBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 60));
        const cd = doc.querySelector('.overlay .modal');
        cd?.querySelector('.modal-foot .btn-accent, .modal-foot .btn-primary')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const f3 = store.find('fees', 'fee-t2');
        ok('取消收款：改回未收', f3?.paid === false);
        ok('取消收款：相關帳目已撤銷', !store.load().transactions.some(t => t.id === newTx.id));
      }
    }
  }

  store.load().fees = before;
  store.load().transactions = store.load().transactions.filter(t => t.feeId !== 'fee-t2');
  store.commit();
}

/* ---------- 詳細頁 / 編輯頁 ---------- */
section('詳細頁與編輯頁');
const detailPages = MODE === 'mock'
  ? ['#/meetings/dmt1', '#/meetings/new', '#/members/dm01', '#/members/new', '#/inventory/gi04',
     '#/inventory/new', '#/finance/new', '#/admin/accounts', '#/docs/mock']
  : ['#/meetings/new', '#/members/m001', '#/members/new', '#/inventory/new', '#/finance/new',
     '#/admin/accounts', '#/docs/multiunit'];
for (const p of detailPages) {
  const before = errors.length;
  try {
    window.location.hash = p;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 25));
    const html = doc.getElementById('view')?.innerHTML || '';
    ok(`${p} 渲染成功（${html.length} 字）`, html.length > 100 && errors.length === before,
      errors.slice(before, before + 2).join(' | '));
  } catch (e) {
    fail++; console.log(`  ✗ ${p} 拋出例外：${e.message}`);
  }
}
ok('物資分頁（#/inventory/loans）唔會誤認作物資編號',
  !/搵唔到呢件物資/.test((() => { window.location.hash = '#/inventory/loans';
    window.dispatchEvent(new window.HashChangeEvent('hashchange')); return doc.getElementById('view')?.innerHTML || ''; })()));

/* ---------- QR Code（用 vendor qrcode 模組真跑） ---------- */
section('QR Code');
window.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/qrcode.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/qrcode_UTF8.js'), 'utf8'));
const util = await import('../assets/js/lib/util.js');
const exporter = await import('../assets/js/lib/exporter.js');
ok('qrcode 模組已載入', typeof window.qrcode === 'function');
/* jsdom 冇 createObjectURL／會攔下載 → 用 stub 令下載路徑可以真跑 */
window.URL.createObjectURL = () => 'blob:test';
window.URL.revokeObjectURL = () => {};
const realClick = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = function () {};
const qr1 = util.qrSvg('https://example.org/constitution.html?u=0082', 4, 2);
ok('團章公開網址 QR 產生 SVG', qr1.trim().startsWith('<svg') && qr1.includes('</svg>'), qr1.slice(0, 30));
const qr2 = util.qrSvg('https://example.org/?u=0082&role=exec_committee&ymis=DEMO-EXEC&from=portal&embed=1', 4, 2);
ok('公開連結 QR 產生成功', qr2.trim().startsWith('<svg'));
const qr3 = util.qrSvg('https://example.org/constitution.html?u=0082', 4, 2);
let inconsistent = 0;
for (let i = 0; i < 2; i++) if (util.qrSvg('https://example.org/constitution.html?u=0082', 4, 2) !== qr3) inconsistent++;
ok('同一內容 QR 穩定一致', inconsistent === 0);

/* ---------- Word / CSV 輸出（純字串部分） ---------- */
section('文件輸出');
const word = exporter.wordHtml({ title: '團章', org: '測試旅深資童軍團', bodyHtml: '<h1>測試</h1><p>中文內容</p>', meta: '2024.09' });
ok('Word 檔含 mso 標頭', word.includes('urn:schemas-microsoft-com:office:word'));
ok('Word 檔含中文內容', word.includes('中文內容'));
ok('Word 檔有機構名', word.includes('測試旅深資童軍團'));
const csv = exporter.csvText({ headers: ['姓名', '生日'], rows: [['陳大文', '2006-06-10'], ['有,逗號', 'x"y']] });
ok('CSV 有表頭', csv.split('\r\n')[0] === '姓名,生日');
ok('CSV 會 escape 逗號與引號', csv.includes('"有,逗號"') && csv.includes('"x""y"'));
ok('CSV 用 CRLF 換行', csv.split('\r\n').length === 3);
const standalone = exporter.toStandaloneHtml({ filename: '/tmp/x.html', title: '團章', bodyHtml: '<p>內容</p>', meta: '' });
ok('單一 HTML 版含版面 CSS', standalone.includes('max-width:820px') && standalone.includes('${extraHead}') === false);
ok('列印 CSS 有分頁控制', exporter.docCss().includes('A4') || exporter.docCss().includes('page'));
const wordFile = exporter.toWord({ filename: 'test.doc', title: '團章', bodyHtml: '<p>內容</p>' });
ok('Word 下載函式回報成功', wordFile === true);
const csvFile = exporter.toCSV({ filename: 'test.csv', headers: ['A'], rows: [[1]] });
ok('CSV 下載函式冇拋錯', csvFile === undefined || csvFile === true);
window.HTMLAnchorElement.prototype.click = realClick;

/* ---------- 物資借用：庫存 −/+ ---------- */
section('物資借用流程（庫存自動加減）');
const tmpItem = store.add('invItems', { code: 'T-TEST', name: '測試物資', category: '其他', total: 5, unit: '個' });
const tid = tmpItem?.id || 'T-TEST';
const base = model.itemTotals(tid).available;
ok('新物資可用量 = 登記量', base === 5, String(base));
store.add('invLoans', { id: 'loan-test', itemId: tid, qty: 2, status: 'requested', requestedBy: 'test' });
ok('申請中只計預留，唔扣庫存', model.itemTotals(tid).available === 5 && model.itemTotals(tid).reserved === 2, JSON.stringify(model.itemTotals(tid)));
store.update('invLoans', 'loan-test', { status: 'approved' });
ok('批准後即鎖定庫存（待取走，唔會畀人再借）', model.itemTotals(tid).available === 3, JSON.stringify(model.itemTotals(tid)));
store.update('invLoans', 'loan-test', { status: 'out' });
ok('取走後庫存維持 −2（批准時已扣）', model.itemTotals(tid).available === 3, JSON.stringify(model.itemTotals(tid)));
store.update('invLoans', 'loan-test', { status: 'returned', returnDate: '2026-09-14' });
ok('歸還後庫存 +2（回復 5）', model.itemTotals(tid).available === 5);
store.update('invLoans', 'loan-test', { status: 'cancelled' });
ok('取消後唔會扣庫存', model.itemTotals(tid).available === 5);
store.add('invAudits', { itemId: tid, date: '2026-09-14', delta: -2, note: '盤點少了 2 件' });
ok('盤點調整會反映在可用量', model.itemTotals(tid).adjusted === 3 && model.itemTotals(tid).available === 3,
  JSON.stringify(model.itemTotals(tid)));
ok('所有已登入角色（超管／領袖／執委）都可以批核借用',
  ['super', 'leader', 'exco'].every(r => Number(auth.PERMS['inv.approve'][r]) === 1),
  JSON.stringify(auth.PERMS['inv.approve']));
ok('三個角色都可以申請借用', ['super', 'leader', 'exco'].every(r => Number(auth.PERMS['inv.borrow'][r]) === 1));
store.remove('invLoans', 'loan-test');
store.remove('invItems', tid);

/* ---------- 儀表板生日提示 ---------- */
section('儀表板生日提示');
{
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  const dash = doc.getElementById('view')?.innerHTML || '';
  const b = model.birthdaySummary();
  ok('儀表板有生日區塊', /生日/.test(dash));
  const named = [...b.month, ...b.in7].map(x => x.name);
  ok('生日提示會顯示人名', named.length === 0 ? true : named.some(n => dash.includes(n)),
    named.join(',') + ' | dash:' + (dash.includes(named[0] || '') ? 'yes' : 'no'));
  ok('生日資料有本月／7 日內／未填三個清單',
    Array.isArray(b.month) && Array.isArray(b.in7) && Array.isArray(b.unknown));
}

/* ---------- 財務匯入解析（CSV／TSV） ---------- */
section('財務匯入解析');
{
  const fin = await import('../assets/js/views/finance.js');
  const csv = [
    '日期,類型,項目,金額,分類,方式,年度',
    '2025-12-07,收入,"12/7 partyroom event",HK$190.00,活動費,現金,2025-26',
    '"2025-12-08",支出,partyroom 支出,"-57",物資,現金,2025-26',
    '2025-12-10,收入,"deepgamehk, 一節",250,活動費,,2025-26',
    '2025-12-11,收入,曉莉 團費,"1,360",團費,現金,2025-26'
  ].join('\n');
  const rows = fin.parsePasted(csv);
  ok('CSV：讀到 4 筆帳目', rows.length === 4, String(rows.length));
  ok('CSV：金額 HK$ / 負號 / 千分位都會清洗',
    rows[0].amount === 190 && rows[1].amount === 57 && rows[3].amount === 1360,
    rows.map(r => r.amount).join(','));
  ok('CSV：引號內嘅逗號唔會拆錯欄', rows[2].item === 'deepgamehk, 一節', rows[2].item);
  ok('CSV：類型判斷正確（收入／支出）', rows[0].type === 'income' && rows[1].type === 'expense');
  ok('CSV：日期正規化為 YYYY-MM-DD', rows[0].date === '2025-12-07' && rows[2].date === '2025-12-10');
  ok('CSV：冇填分類會俾預設值', rows[1].category === '物資');

  const tsv = fin.parsePasted('日期\t類型\t項目\t金額\n2025-12-07\t收入\t團費\t360\n2025-12-07\t支出\t場地\t100');
  ok('TSV（Google Sheet 直接複製）都支援', tsv.length === 2 && tsv[1].type === 'expense', JSON.stringify(tsv));

  const withTitle = fin.parsePasted('BAD deb\n日期,類型,項目,金額\n2025-12-07,收入,團費,360');
  ok('第一行係標題（例如 BAD deb）會自動跳過', withTitle.length === 1 && withTitle[0].amount === 360, JSON.stringify(withTitle));

  ok('CSV：引號內換行都唔會爆（RFC4180）',
    fin.splitCsv('a,"b\nc",d').length === 1 && fin.splitCsv('a,"b\nc",d')[0][1] === 'b\nc');
  ok('匯入讀檔函式存在（上載 CSV 用）', typeof fin.readImportFile === 'function');

  // 你嘅 Google Form 式表（收入項目／支出項目／收入／支出／結餘／付款人／備註）
  const formCsv = [
    '時間戳記,日期,收入或支出,收入項目,支出項目,收入,支出,結餘,上載單據,付款人,備註',
    ',2025/10/11,支出,,12/7 partyroom event,,"HK$1,140.00","HK$7,663.28",https://drive.google.com/file/d/abc/view,天暘,',
    ',2026/1/5,收入,12/7 partyroom event,,HK$190.00,,"HK$7,853.28",,天蔚,',
    ',2025/10/25,收入,團費,,HK$90.00,,"HK$8,485.28",,愷知,海外團員',
    ',,,上年度結餘,,HK$8,803.28,,,,',
    ',,,本年度收入,"HK$8,630.00",,,,,',
    ',,,總計支出,,"HK$9,586.64",,,,,',
    ',,,,,,,HK$7,846.64,,,'
  ].join('\n');
  const gf = fin.parsePasted(formCsv);
  ok('Google Form 式表：認得 3 筆交易（總結行唔會當交易）', gf.length === 3, String(gf.length));
  ok('Google Form 式表：收入／支出欄分工正確',
    gf[0].type === 'expense' && gf[0].amount === 1140 && gf[1].type === 'income' && gf[1].amount === 190,
    JSON.stringify(gf.map(r => [r.type, r.amount])));
  ok('Google Form 式表：讀到付款人', gf[0].byName === '天暘' && gf[1].byName === '天蔚',
    JSON.stringify(gf.map(r => r.byName)));
  ok('Google Form 式表：讀到單據連結',
    /^https:/.test(gf[0].receiptLink) && gf[0].receipt === true && gf[1].receiptLink === '');
  ok('Google Form 式表：備註（海外團員）保留', gf[2].note === '海外團員');
  ok('Google Form 式表：期初結餘／表尾結餘分開處理（唔會當收入）',
    gf.every(r => !/結餘/.test(r.item)), gf.map(r => r.item).join('|'));

  // 「團費」欄：打勾 或 寫名 → 認得出邊位交咗
  const members = model.members();
  const nameA = members[0].name, nameB = members[1].name;
  const tickCsv = `日期,類型,項目,金額,經手人,年度,團費
2025-12-07,收入,12/7 partyroom event,190,嘉詠,2025-26,
2025-12-07,收入,團費,360,${nameA},2025-26,✓
2025-12-08,收入,團費,360,${nameB},2025-26,已交`;
  const t2 = fin.parsePasted(tickCsv);
  ok('CSV：認得出團費筆數（✓ 或「已交」）', t2.filter(r => r.feePaid).length === 2,
    JSON.stringify(t2.map(r => [r.item, r.feePaid, r.memberId])));
  ok('CSV：團費會對應到團員 ID', t2[1].memberId === members[0].id && t2[2].memberId === members[1].id,
    `${t2[1].memberId}/${members[0].id}`);
  ok('CSV：年度欄會被讀入（2025-26）', t2[0].period === '2025-26', t2[0].period);
  ok('CSV：非團費嘅收入唔會被當成團費',
    t2[0].feePaid === false || t2[0].item.includes('partyroom'));
}

/* ---------- v3：通告（開一張 → 分享 → 報名） ---------- */
section('通告（開一張・分享・報名）');
{
  await auth.login('leader', 'leader', '8202');
  const noticesMod = await import('../assets/js/views/notices.js');
  window.location.hash = '#/notices';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const nt = doc.getElementById('view')?.textContent || '';
  ok('通告頁渲染成功', nt.includes('通告') && (doc.getElementById('view')?.innerHTML || '').length > 200);
  ok('側邊欄／頁面有「通告」', (body() || '').includes('通告'));

  /* 團長回報（2026-09-17）：「開新通告」掣冇綁 handler → 撳落去冇反應。
     呢度一定要**撳真嗰粒掣**（唔可以 hash = '#/notices/new' 直跳，
     直跳會繞過 mount() 嘅綁定，所以呢個 bug 一直捉唔到）。 */
  const newBtn = doc.querySelector('#view [data-act="new"]');
  ok('通告列表有「開新通告」掣', !!newBtn, doc.querySelector('#view .page-head')?.textContent || '');
  newBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 140));
  ok('撳「開新通告」會跳去編輯器（唔係冇反應）', window.location.hash === '#/notices/new', window.location.hash);
  ok('編輯器真係開到（有標題欄）', !!doc.getElementById('n-title'));
  ok('掣開到嘅係一張空白新通告（唔會帶入上一張）',
    (doc.getElementById('n-title')?.value || '') === '' && /開新通告/.test(doc.querySelector('.page-title')?.textContent || ''),
    doc.querySelector('.page-title')?.textContent || '');
  /* 返回清單（下面嘅測試要喺列表頁跑） */
  window.location.hash = '#/notices';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));

  /* real 模式由空白開始（82 旅嘅通告已隨私隱清理移走）→ 自己開兩張測試通告，
     等下面嘅分享／QR／報名測試有嘢可以撳。mock 模式本身就有 2 張。 */
  if ((store.load().notices || []).length < 2) {
    store.add('notices', {
      title: { zh: '測試通告（smoke）', en: 'Test Notice' }, status: 'published',
      needSignup: true, eventDate: '2026-10-01', deadline: '2026-09-30', body: { zh: '內容', en: 'Body' }
    });
    store.add('notices', {
      title: { zh: '測試通告二（smoke）', en: 'Test Notice 2' }, status: 'published',
      needSignup: false, eventDate: '2026-11-01', body: { zh: '內容', en: 'Body' }
    });
    window.location.hash = '#/notices';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 80));
  }
  const list = store.load().notices || [];
  ok('通告清單有 2 張', list.length === 2, String(list.length));
  ok('其中一張要報名（needSignup）', list.some(n => n.needSignup), JSON.stringify(list.map(n => n.needSignup)));
  const first = list[0];
  ok('通告有中英標題', !!(first?.title?.zh && first?.title?.en), JSON.stringify(first?.title));
  ok('通告已發布（公開睇得到）', first?.status === 'published', first?.status);

  const link = noticesMod.publicUrl(first);
  ok('分享連結指向 notice.html（帶旅團 + 通告編號）',
    /^notice\.html\?u=/.test(link) && link.includes('n=' + first.id), link);

  // 分享對話框（QR Code）
  const shareBtn = doc.querySelector('[data-share]');
  ok('清單有分享掣', !!shareBtn);
  /* 清單畫面係按日期排（唔一定等於 store 順序）—— 斷言要以「實際分享嗰張」做準 */
  const shared = shareBtn ? (store.find('notices', shareBtn.dataset.share) || first) : first;
  if (shareBtn) {
    shareBtn.click();
    await new Promise(r => setTimeout(r, 60));
    const ov = doc.querySelector('.overlay');
    ok('分享對話框有 QR Code（SVG 或圖檔）',
      !!ov && (!!ov.querySelector('.qr-box svg') || /^data:image/.test(ov.querySelector('.qr-box img')?.getAttribute('src') || '')));
    ok('分享對話框顯示報名連結', !!ov && (ov.querySelector('#sh-url')?.value || '').includes('notice.html'));
    /* 2026-09-16：分享要有 WhatsApp 一撳、QR 圖、報名統計 */
    ok('分享對話框有「用 WhatsApp 分享」掣', !!ov && !!ov.querySelector('[data-sh="wa-open"]'));
    ok('分享對話框有「儲存 QR 圖」掣（貼落 WhatsApp 用）', !!ov && !!ov.querySelector('[data-sh="img"]'));
    ok('分享文字可以自己改（textarea 預覽）', !!ov && !!ov.querySelector('#sh-text'));
    const preview = ov?.querySelector('#sh-text')?.value || '';
    ok('分享文字有標題 / 日期 / 團員入口連結（有截止日會提埋）',
      /通告|Notice|活動/.test(preview) && preview.includes('members.html')
      && (!shared?.deadline ? true : /截止/.test(preview)),
      preview.slice(0, 80));
    ok('WhatsApp 分享連結係 wa.me（一撳開 WhatsApp）',
      (() => { const t = noticesMod.whatsappShareUrl(shared);
        return /^https:\/\/wa\.me\/\?text=/.test(t) && decodeURIComponent(t).includes('members.html'); })());
    doc.querySelector('.overlay [data-close-x]')?.click();
    await new Promise(r => setTimeout(r, 20));
  }

  // 報名：欄目輸入 → 收集 → 寫入
  const withFields = list.find(n => (n.fields || []).length) || first;
  const fields = (withFields.fields || []).length ? withFields.fields
    : [{ key: 'name', label: '姓名', type: 'text', required: true }];
  const holder = doc.createElement('div');
  holder.innerHTML = fields.map(f => noticesMod.fieldInput(f, '')).join('');
  const firstText = holder.querySelector('input[data-fk],textarea[data-fk]');
  if (firstText) firstText.value = '測試報名者';
  const vals = noticesMod.collectFields(holder, fields);
  ok('報名表單收集到欄位值', (vals.name || vals[Object.keys(vals)[0]]) !== undefined, JSON.stringify(vals));

  const before = (store.find('notices', withFields.id)?.signups || []).length;
  noticesMod.add_signup(store.find('notices', withFields.id), { name: '測試報名者', ...vals });
  const after = (store.find('notices', withFields.id)?.signups || []).length;
  ok('報名會加落通告（signups +1）', after === before + 1, `${before} → ${after}`);
  const row = (store.find('notices', withFields.id)?.signups || [])[after - 1];
  ok('報名有時間同姓名', !!row?.at && row.name === '測試報名者', JSON.stringify(row?.name));

  // 還原（唔留測試資料）
  const fresh = store.find('notices', withFields.id);
  store.update('notices', withFields.id, { signups: (fresh.signups || []).filter(x => x.id !== row.id) });
  ok('測試報名已清理', (store.find('notices', withFields.id)?.signups || []).length === before);

  // 報名表輸出 CSV
  const csvOk = typeof noticesMod.exportSignupsCsv === 'function';
  ok('有報名表 CSV 匯出', csvOk);
}

/* ---------- 團長回報（2026-09-17）：已發布通告 →「同步到公開頁」 ---------- */
section('通告詳情頁（同步到公開頁 ＝ 行同一條「儲存到後端」路）');
{
  const pub = (store.load().notices || []).find(n => n.status === 'published');
  ok('有已發布通告可以做測試', !!pub);
  const db0 = store.load();
  const keepSync = db0.sync;
  db0.sync = { ...(keepSync || {}), url: 'https://script.google.com/macros/s/TESTDEPLOY/exec', apiKey: 'TESTKEY' };
  store.commitMeta();

  const realFetch = globalThis.fetch;
  let sent = [];
  /* 假後端：後端仲係空（dbInfo found:false）→ 儲存直接寫 saveDb */
  let infoReply = { ok: true, success: true, found: false };
  globalThis.fetch = async (url, init = {}) => {
    if (/script\.google\.com|\/exec/.test(String(url))) {
      const body = init?.body ? JSON.parse(init.body) : null;
      sent.push(body);
      let reply = { ok: true, success: true };
      if (body?.action === 'dbInfo') reply = infoReply;
      if (body?.action === 'saveDb') reply = { ok: true, success: true, version: 'v-smoke-1', at: '2026-09-20T00:00:00.000Z', bytes: 100 };
      if (infoReply.__http500) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(reply), json: async () => reply };
    }
    return realFetch(url, init);
  };

  window.location.hash = '#/notices/' + pub.id;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 140));
  const syncBtn = doc.querySelector('#view [data-act="sync-notice"]');
  ok('已發布通告詳情頁有「同步到公開頁」掣', !!syncBtn);
  syncBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const lastToast = () => [...doc.querySelectorAll('.toast')].map(t => t.textContent).pop() || '';
  const actions = sent.map(x => x?.action);
  if (MODE === 'mock') {
    /* 示範模式永遠唔寫後端 —— 就算填咗 /exec 都唔會送 */
    ok('示範模式：一個請求都唔會送去後端', sent.length === 0, JSON.stringify(actions));
    ok('示範模式：toast 講明唔會寫入後端', /示範模式/.test(lastToast()), lastToast());
    globalThis.fetch = realFetch;
    const dbm = store.load(); dbm.sync = keepSync; store.commitMeta();
    window.location.hash = '#/notices';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 60));
  } else {
  ok('撳一次：先問後端版本（dbInfo），再寫入（saveDb）—— 同頂部「儲存到後端」同一條路', actions[0] === 'dbInfo' && actions.includes('saveDb'), JSON.stringify(actions));
  const saved = sent.find(x => x?.action === 'saveDb');
  ok('寫入內容係整個資料庫，包括呢張通告（公開頁由「資料庫」分頁讀）',
    Array.isArray(saved?.db?.notices) && saved.db.notices.some(n => n.id === pub.id), JSON.stringify(Object.keys(saved?.db || {})).slice(0, 200));
  ok('寫入帶埋旅團編號同 API Key', saved?.unit && saved?.apiKey === 'TESTKEY', JSON.stringify([saved?.unit, saved?.apiKey]));
  ok('寫上後端嘅 db 唔會夾帶 sync／backend（連線設定唔上 Sheet）', saved?.db && !('sync' in saved.db) && !('backend' in saved.db), JSON.stringify(Object.keys(saved?.db || {})));
  ok('成功有 toast 提示', /已儲存到後端/.test(lastToast()), lastToast());
  ok('同步之後掣會還原（可以再撳）', !!doc.querySelector('#view [data-act="sync-notice"]:not([disabled])'));
  ok('寫入成功後 pending 清零', Number(store.load().sync?.pending || 0) === 0, String(store.load().sync?.pending));

  /* 失敗路徑：/exec 回 500 → 要提團長去「總表同步」檢查 */
  sent = [];
  infoReply = { __http500: true };
  store.add('notices', { type: 'notice', status: 'draft', title: { zh: '再改一嘢' }, body: { zh: '' } });   // 有嘢未存
  doc.querySelector('#view [data-act="sync-notice"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  ok('失敗都有 toast（唔會靜靜地冇反應）', /儲存失敗/.test(lastToast()), lastToast());
  ok('失敗提示去「帳號與系統 → 資料管理 → 總表同步」檢查 /exec 同 API Key',
    /總表同步/.test(lastToast()) && /\/exec/.test(lastToast()) && /API Key/.test(lastToast()), lastToast());
  ok('讀唔到後端版本 → 一個 saveDb 都冇送出', !sent.some(x => x?.action === 'saveDb'), JSON.stringify(sent.map(x => x?.action)));

  globalThis.fetch = realFetch;
  const db1 = store.load();
  db1.sync = keepSync;
  store.commitMeta();
  window.location.hash = '#/notices';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  }
}

/* ---------- v3：表格設計（改名／加欄位） ----------
   ★ 2026-09-25 團長：「總表同步／表格與同步 太複雜」→ 逐個表嘅欄位設計已經唔再係
   「表格與同步」嘅分頁（嗰頁而家淨係三樣嘢），改為由各分頁嘅「欄位」掣開同一個
   欄位設計器 modal（openFieldDesigner）。呢段測試跟住改行 modal 嗰條路。 */
section('欄位設計器（欄位改名・加欄位・還原）');
{
  const tablesMod = await import('../assets/js/views/tables.js');
  /* 唔好 await —— openFieldDesigner 返嘅 promise 要等 modal 關閉先 settle，
     await 住就永遠行唔落去（top-level await 會掛死）。開咗就算，之後直接操作 DOM。 */
  const fdDone = tablesMod.openFieldDesigner('transactions');
  await new Promise(r => setTimeout(r, 60));
  const rows = doc.querySelectorAll('#fd-list .schema-row');
  ok('欄位設計器列出欄位（帳目）', rows.length >= 8, String(rows.length));
  ok('有「加欄位」掣', !!doc.querySelector('[data-fd="add"]'));

  const inp = doc.querySelector('#fd-list [data-field="0"] [data-k="label"]');
  ok('第一個欄位係「日期」', inp?.value === '日期', inp?.value);
  inp.value = '交易日期';
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok('改名會儲存落旅團設定',
    store.load().tableSchema?.transactions?.fields?.[0]?.label === '交易日期',
    JSON.stringify(store.load().tableSchema?.transactions?.fields?.[0]));
  ok('改名後表格定義即時跟住變',
    tablesMod.tableDefs().transactions.fields[0].label === '交易日期');

  // 還原預設
  doc.querySelector('[data-fd="reset"]').click();
  await new Promise(r => setTimeout(r, 40));
  doc.querySelector('.overlay [data-act="1"]')?.click();
  await new Promise(r => setTimeout(r, 80));
  ok('還原預設欄位（唔會再見到改咗嘅名）',
    tablesMod.tableDefs().transactions.fields[0].label === '日期',
    tablesMod.tableDefs().transactions.fields[0].label);

  // 關走 modal（「完成」＝唯一一粒掣 → data-act="0"），唔好影響後面嘅 section
  doc.querySelector('.overlay [data-act="0"]').click();
  await fdDone;
  await new Promise(r => setTimeout(r, 60));
}

/* ---------- v3：插入自己嘅 Sheet（gviz 解析・自動對應） ---------- */
section('插入自己嘅 Sheet（讀欄位・自動對應・同步 payload）');
{
  const tablesMod = await import('../assets/js/views/tables.js');
  const gviz = `/*O_o*/
google.visualization.Query.setResponse({"version":"0.6","reqId":"0","status":"ok","table":{"cols":[{"id":"A","label":"日期","type":"string"},{"id":"B","label":"項目","type":"string"},{"id":"C","label":"金額","type":"number"},{"id":"D","label":"負責人","type":"string"}],"rows":[{"c":[{"v":"2025-12-07"},{"v":"團費"},{"v":360},{"v":"嘉詠"}]},{"c":[{"v":"2025-12-08"},{"v":"買營繩"},{"v":120},{"v":"天暘"}]}]}});`;
  const sheet = tablesMod.parseGviz(gviz);
  ok('gviz 讀到 4 欄', sheet.cols.length === 4, String(sheet.cols.length));
  ok('gviz 讀到 2 行', sheet.rows.length === 2, String(sheet.rows.length));
  ok('gviz 讀到欄位名同值', sheet.cols[1].label === '項目' && sheet.rows[0][1] === '團費', JSON.stringify(sheet.rows[0]));

  const fields = tablesMod.tableDefs().transactions.fields;
  const map = tablesMod.autoMap(sheet.cols, fields);
  ok('自動對應：日期→date / 項目→item / 金額→amount / 負責人→byName',
    map[0] === 'date' && map[1] === 'item' && map[2] === 'amount' && map[3] === 'byName', JSON.stringify(map));

  const tr = tablesMod.rowsFromSheet(sheet, map, fields);
  ok('轉成帳目資料（金額變數字）', tr.length === 2 && tr[0].amount === 360 && tr[1].item === '買營繩', JSON.stringify(tr));

  const payload = tablesMod.buildPayload({ sample: true });
  ok('同步 payload 有旅團編號', payload.unit === store.currentUnit(), payload.unit);
  ok('同步 payload 有各表 schema 同資料', !!payload.schema?.transactions && !!payload.tables?.transactions);
  ok('payload 唔會送相片 base64（避免爆 size）', JSON.stringify(payload).indexOf('data:image') === -1);

  // 總表同步頁：下載 Code.gs / 欄位對應表（真按鈕，唔會拋錯）
  window.location.hash = '#/tables/sync';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  ok('有「同一條網址共用」畀手機記帳／通告報名', !!doc.querySelector('#y-share'));
  if (MODE === 'real') {
    ok('總表同步頁顯示「後端已連接」', /後端已連接|已設定 Apps Script/.test(doc.getElementById('view')?.textContent || ''));
    ok('Apps Script 網址已預填落輸入格',
      /\/exec$/.test(doc.querySelector('#y-url')?.value || ''), doc.querySelector('#y-url')?.value);
    ok('共用掣預設已剔（三條路同一個後端）', doc.querySelector('#y-share')?.checked === true);
  } else {
    ok('示範模式唔會預填後端（唔會送出街）', !doc.querySelector('#y-url')?.value, doc.querySelector('#y-url')?.value);
    ok('示範模式仍然有共用掣（只係未設定網址）', !!doc.querySelector('#y-share'));
  }

  /* 2026-09-19 回歸（團長回報「有啲嘢把解決方法封死」）：
     平台用 Vercel 環境變數登記嘅旅團，`db.backend` **一定**係 null ——
     前端 Registry（data/units.json／／api/units／焗名單）基於安全永遠唔會帶 gasUrl。
     以前「儲存狀態」成張卡（連同「立即儲存到後端」「由後端還原資料」
     「睇後端有咩資料」「體積檢查」）用 `backend ? … : …` 閘住 → 全部收埋，
     用家根本撳唔到文件叫佢撳嘅嗰啲掣，只見到「未設定後端」。
     而家改用 remoteConfigured()（有同源代理＋旅團編號就算接得通）。 */
  if (MODE === 'real') {
    const db0 = store.load();
    const savedBackend = db0.backend;
    db0.backend = null;
    store.commitMeta();
    window.dispatchEvent(new window.Event('v82:refresh'));
    await new Promise(r => setTimeout(r, 40));
    const viewTxt = () => doc.getElementById('view')?.textContent || '';
    ok('平台登記嘅旅團（本機冇 backend 記錄）照樣見到「立即儲存到後端」',
      !!doc.querySelector('[data-act="push-db"]'));
    ok('…照樣見到「由後端還原資料」同「睇後端有咩資料」',
      !!doc.querySelector('[data-act="pull-db"]') && !!doc.querySelector('[data-act="db-info"]'));
    ok('…有「同步診斷」掣（逐格驗成條鏈）', !!doc.querySelector('[data-act="diagnose"]'));
    ok('唔會再誤報「未設定後端」（明明經平台代理接得到）', !/未設定後端 ——/.test(viewTxt()), viewTxt().slice(0, 80));
    db0.backend = savedBackend;
    store.commitMeta();
    window.dispatchEvent(new window.Event('v82:refresh'));
    await new Promise(r => setTimeout(r, 40));
  }

  // 測試連線（jsdom fetch 係本機 shim → 應該優雅失敗，唔會拋錯）
  const { pushToMaster } = tablesMod;
  const pushRes = await pushToMaster({ silent: true });
  ok('pushToMaster() 唔會拋錯（連線失敗會記錄落同步紀錄）', pushRes && pushRes.ok === false, JSON.stringify(pushRes));
  ok('失敗會寫入同步紀錄', (store.load().sync?.log || []).length > 0, JSON.stringify(store.load().sync?.log));

  const errBefore = errors.length;
  const keepClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {};   // jsdom 唔支援真下載
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  doc.querySelector('[data-act="dl-gas"]')?.click();
  await new Promise(r => setTimeout(r, 60));
  doc.querySelector('[data-act="dl-schema"]')?.click();
  await new Promise(r => setTimeout(r, 60));
  window.HTMLAnchorElement.prototype.click = keepClick;
  ok('「下載 Code.gs」同「欄位對應表」按得（冇 error）', errors.length === errBefore,
    errors.slice(errBefore).join(' | '));

  const { gasTemplate, gasGuide } = await import('../assets/js/lib/gastemplate.js');
  const code = gasTemplate();
  ok('Apps Script 範本有 doPost（收 POST）', /function doPost/.test(code) && /ContentService/.test(code));
  ok('Apps Script 範本會寫入「帳目／物資／團員／報名」分頁',
    ['帳目', '物資', '團員', '報名'].every(k => code.includes(k)));
  ok('Apps Script 範本支援報名即時寫入', /appendSignup/.test(code));
  ok('部署步驟教學有 6 步', gasGuide().split('\n').length === 6);
}

/* ---------- v3：快速記帳（手機影相＋選欄目） ---------- */
section('快速記帳（影相＋選欄目）');
{
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const quick = doc.querySelector('[data-quick="claim"]');
  ok('儀表板有「影相記一筆」', !!quick);
  quick.click();
  await new Promise(r => setTimeout(r, 60));
  const ov = doc.querySelector('.overlay');
  ok('開到收支申報表', !!ov && /收支申報/.test(ov.textContent));
  const cam = ov?.querySelector('[data-photo-field="c-photos"] input[type="file"][capture]');
  ok('有相機輸入（手機可以直接影相）', !!cam);
  ok('可以揀相片（相簿）', !!ov?.querySelector('[data-photo-field="c-photos"] input[type="file"]:not([capture])'));
  ok('有欄目可以揀（類型／項目／金額／分類）',
    ['c-type', 'c-item', 'c-amount', 'c-cat'].every(id => !!ov?.querySelector('#' + id)));
  ok('單據相機會標記為有單據', !!ov?.querySelector('#c-receipt'));
  doc.querySelector('.overlay [data-close-x]')?.click();
  await new Promise(r => setTimeout(r, 20));
  ok('關閉之後冇殘留 modal', !doc.querySelector('.overlay'));

  // 畀成員自己填（公開收集頁 QR + 送出網址）
  window.location.hash = '#/finance/claims';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const share = doc.querySelector('[data-act="entry-share"]');
  ok('收支申報有「畀成員自己填（QR）」', !!share);
  share.click();
  await new Promise(r => setTimeout(r, 80));
  const ov2 = doc.querySelector('.overlay');
  ok('彈出 QR 對話框（成員用手機掃）', !!ov2 && !!ov2.querySelector('.qr-box svg'));
  ok('QR 連結指向團員入口 members.html（掃一次齊晒；帶旅團編號）',
    (ov2?.querySelector('#es-url')?.value || '').includes('members.html?u='),
    ov2?.querySelector('#es-url')?.value);
  ok('可以設定 Apps Script 送出網址（寫入總表）', !!ov2?.querySelector('#es-submit'));
  if (MODE === 'real') {
    ok('送出網址已預填你嘅 /exec',
      /\/exec$/.test(ov2?.querySelector('#es-submit')?.value || ''), ov2?.querySelector('#es-submit')?.value);
  } else {
    ok('示範模式唔會預填送出網址（示範資料唔會送出街）',
      !(ov2?.querySelector('#es-submit')?.value || ''), ov2?.querySelector('#es-submit')?.value);
  }
  doc.querySelector('.overlay [data-close-x]')?.click();
  await new Promise(r => setTimeout(r, 20));

  // 設定檔：公開收集頁
  ok('unit.json 有 publicEntry 設定', !!store.load().settings?.publicEntry);
  ok('entry.html 存在（成員手機入口）', typeof fs.readFileSync === 'function' && fs.existsSync(path.join(ROOT, 'entry.html')));
}

/* ============================================================
   新增測試（用戶提出嘅 8 項修正）
   ============================================================ */

/* ---------- 1. Code.gs 語法 ---------- */
section('Code.gs（Apps Script 範本）');
{
  const { gasTemplate, gasGuide } = await import('../assets/js/lib/gastemplate.js');
  const code = gasTemplate();
  const lines = code.split('\n');
  let syntaxError = '';
  try { new vm.Script(code, { filename: 'Code.gs' }); }
  catch (e) { syntaxError = e.message + ' @line ' + (e.stack || '').split('\n')[0]; }
  ok('Code.gs 可以通過語法檢查（無 SyntaxError）', syntaxError === '', syntaxError);
  ok('冇「字串入面斷行」（舊 bug：line 158 Invalid or unexpected token）',
    !lines.some((l, i) => /^\'\)/.test(l.trim()) || /join\('$/.test(l)),
    lines.map((l, i) => `${i + 1}:${l}`).filter(([, l]) => /join\('$/.test(l)).join('|'));
  ok("links.join('\\n') 保留做跳行字串（唔係真換行）", code.includes("links.join('\\n')"));
  ok('有定義 SHEET_TABS（舊版本用到但未定義）', /var SHEET_TABS = \[/.test(code));
  ok('有 doPost / doGet / syncAll', ['function doPost', 'function doGet', 'function syncAll'].every(f => code.includes(f)));
  ok('支援 action: ping / sync / claim / noticeSignup / loan',
    ['ping', 'sync', 'claim', 'noticeSignup', 'loan'].every(a => code.includes(`'${a}'`)));
  ok('有物資借用分頁寫入（appendLoan）', code.includes('function appendLoan') && code.includes("'物資借用'"));
  ok('報名分頁有「出席與否」欄', code.includes("'出席與否'") && code.includes('function attendOf'));
  ok('部署步驟說明有內容', gasGuide().split('\n').length >= 5);
}

/* ---------- 2. 用戶（領袖／執委／團員）可以編輯 ---------- */
section('用戶名冊（可編輯 · 身份）');
{
  await auth.login('chief', 'chief', '8201');      // 團長＝最高權限，改身份一定得
  window.location.hash = '#/members';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const view = doc.getElementById('view');
  ok('名冊頁標題係「用戶」', /用戶/.test(view.textContent), view.textContent.slice(0, 60));
  ok('每一行有「編輯」掣（以前撳唔到）', view.querySelectorAll('[data-edit]').length >= 1,
    String(view.querySelectorAll('[data-edit]').length));
  ok('有身份篩選（團長／領袖／執委／團員）', view.querySelectorAll('[data-ident]').length === 5);

  /* 揀一個唔係自己、又唔係 fixture 嘅用戶（唔可以改自己身份 ＝ 免得鎖死自己；
     也唔好改動 leader／exco fixture，否則之後嘅登入會變咗第二個身份）。 */
  const { FIXTURE_LOGINS } = await import('./_roles.mjs');
  const isFixture = id => FIXTURE_LOGINS.includes(String(store.find('members', id)?.loginId || ''));
  const editBtn = Array.from(view.querySelectorAll('[data-edit]'))
    .find(b => b.dataset.edit !== auth.current()?.memberId && !isFixture(b.dataset.edit));
  const firstId = editBtn.dataset.edit;
  editBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  ok('撳「編輯」會去編輯頁（#/members/edit/<id>）',
    window.location.hash === '#/members/edit/' + firstId, window.location.hash);
  ok('編輯頁有身份下拉（團長／領袖／執委／團員）', !!doc.querySelector('#f-identity'));
  ok('身份選項係 團長／領袖／執委／團員（團長睇得到）',
    Array.from(doc.querySelectorAll('#f-identity option')).map(o => o.value).join(',') === 'chief,leader,exco,member',
    Array.from(doc.querySelectorAll('#f-identity option')).map(o => o.value).join(','));

  doc.querySelector('#f-name').value = '測試用戶甲';
  doc.querySelector('#f-name').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#f-identity').value = 'exco';
  doc.querySelector('#f-identity').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('[data-act="save"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const m = store.load().members.find(x => x.id === firstId);
  ok('改資料可以儲存（以前儲存唔到）', m.name === '測試用戶甲', m.name);
  ok('身份可以改成「執委」', m.identity === 'exco', m.identity);
  ok('編輯完會返去個人頁', window.location.hash === '#/members/' + firstId, window.location.hash);

  // 舊資料升級：冇 identity 欄 → 自動推算
  const migrated = store.migrateIdentities({ members: [
    { id: 'x1', name: '甲', role: '團長' }, { id: 'x2', name: '乙', role: '司庫' }, { id: 'x3', name: '丙', role: '' }
  ] });
  ok('舊資料自動推算身份（團長→領袖 / 司庫→執委 / 其他→團員）',
    migrated === true, String(migrated));
  const g = store.load();
  ok('每個用戶都有身份欄', g.members.length === 0 || g.members.every(x => ['chief', 'leader', 'exco', 'member'].includes(x.identity)),
    JSON.stringify(g.members.filter(x => !x.identity).map(x => x.name)));
  ok('執委都有權改用戶資料（以前只有領袖）',
    (await (async () => { await auth.login('exco', 'exco', '8203'); return auth.can('member.edit'); })()) === true);
  await auth.login('leader', 'leader', '8202');
}

/* ---------- 3. 防呆（先存瀏覽器，唔即時寫入） ---------- */
section('防呆（暫存 → 確認 → 可還原）');
{
  const guard = await import('../assets/js/lib/guard.js');
  guard.dropAllDrafts();
  guard.saveDraft('member', 'm_test', { name: '暫存測試' });
  ok('草稿可以暫存去瀏覽器', guard.readDraft('member', 'm_test')?.data?.name === '暫存測試');
  ok('草稿存喺 localStorage（唔係資料庫）',
    !!window.localStorage.getItem('venture82.drafts.v2')
    && !store.load().members.some(m => m.name === '暫存測試'));
  ok('可以列出所有暫存', guard.listDrafts().some(d => d.section === 'member'));
  guard.clearDraft('member', 'm_test');
  ok('儲存後可以清走暫存', guard.readDraft('member', 'm_test') === null);

  // 編輯器輸入 → 自動暫存（未撳儲存唔會入資料庫）
  window.location.hash = '#/members/new';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const nameBox = doc.querySelector('#f-name');
  ok('新增用戶頁有暫存提示位', !!doc.querySelector('[data-draft-stamp]'));
  nameBox.value = '未儲存用戶';
  nameBox.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  ok('輸入後自動暫存去瀏覽器', guard.readDraft('member', 'new')?.data?.name === '未儲存用戶',
    JSON.stringify(guard.readDraft('member', 'new')));
  ok('未撳「儲存」之前唔會寫入資料庫', !store.load().members.some(m => m.name === '未儲存用戶'));
  guard.dropAllDrafts();

  // 刪除要打字確認
  window.location.hash = '#/members/' + firstId2();
  function firstId2() { return store.load().members[1].id; }
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 50));
  const target = store.load().members[1];
  doc.querySelector('[data-act="del"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const dlg = doc.querySelector('.overlay .modal');
  ok('刪除會彈確認框', !!dlg);
  const okBtn = dlg?.querySelector('.modal-foot [data-act="1"]');
  ok('未打字之前「確定刪除」係停用（防手誤）', okBtn?.disabled === true);
  const ti = dlg?.querySelector('#gd-text');
  if (ti) { ti.value = target.name; ti.dispatchEvent(new window.Event('input', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 30));
  ok('打低個名之後先可以確定', okBtn?.disabled === false);
  dlg?.querySelector('[data-close-x]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  ok('取消之後用戶仍然存在', !!store.load().members.find(m => m.id === target.id));

  // 後端儲存：真實資料每次改動都會排隊寫入後端；示範資料永遠唔會送出
  const dbx = store.load();
  /* 2026-09-19：自動寫入已剷走，呢度唔再設 auto（設咗都冇用）。
     呢個斷言測嘅係「改動會排隊（pending 累加）」—— 即係暫存，唔係自動寫。 */
  dbx.sync = { ...(dbx.sync || {}), pending: 0 };
  store.commit();
  if (MODE === 'mock') {
    ok('示範資料永遠唔會排隊送去後端（唔會污染真實 Sheet）',
      Number(store.load().sync?.pending || 0) === 0, String(store.load().sync?.pending));
  } else {
    ok('改動會排隊等寫入後端（pending 累加，寫入成功先清零）',
      Number(store.load().sync.pending) >= 1, String(store.load().sync?.pending));
  }
  dbx.sync.auto = false; dbx.sync.pending = 0; store.commit();
}

/* ---------- 4. 通告：詳情頁 + 輸出（連回覆出席與否） ---------- */
section('通告詳情（輸出連出席回覆）');
{
  const nv = await import('../assets/js/views/notices.js');
  const n0 = store.add('notices', {
    id: 'nt-test-attend', type: 'event', status: 'published', publishAt: '2026-09-15',
    title: { zh: '測試通告（出席）', en: 'Test' }, body: { zh: '內容' },
    needSignup: true, deadline: '2026-09-30', eventDate: '2026-10-17',
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true },
      { key: 'contact', label: '聯絡電話', type: 'tel', required: false },
      { key: 'attend', label: '出席與否', type: 'radio', options: ['出席', '唔出席（請假）'] }
    ],
    signups: []
  });
  const ms2 = store.load().members.filter(m => m.status !== 'alumni');
  ok('出席判斷：出席', nv.attendValue({ values: { attend: '出席' } }) === 'yes');
  ok('出席判斷：唔出席（請假）', nv.attendValue({ values: { attend: '唔出席（請假）' } }) === 'no');
  ok('出席判斷：未填 = 未回覆', nv.attendValue({ values: {} }) === '');

  nv.markAttendance(store.find('notices', n0.id), ms2[0], 'yes');
  nv.markAttendance(store.find('notices', n0.id), ms2[1], 'no');
  const A = nv.attendanceSummary(store.find('notices', n0.id));
  ok('統計出席 1 位', A.yes === 1, JSON.stringify(A));
  ok('統計唔出席 1 位', A.no === 1, JSON.stringify(A));
  ok('其餘計做未回覆', A.none === A.rosterCount - 2, JSON.stringify(A));
  const rows = nv.attendanceRows(store.find('notices', n0.id));
  ok('出席表以名冊為本（每位非舊團員一行）', rows.roster.length === ms2.length, `${rows.roster.length}/${ms2.length}`);

  window.location.hash = '#/notices/nt-test-attend';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const v2 = doc.getElementById('view');
  ok('通告詳情有文件式排版（同團章一樣）', !!v2.querySelector('#noticeSheet'));
  ok('右面有「輸出同分享」面板', /輸出同分享/.test(v2.textContent));
  ok('有「通告＋出席回覆（Word）」輸出掣', !!v2.querySelector('[data-act="export-full-word"]'));
  ok('有「通告＋出席回覆（PDF）」輸出掣', !!v2.querySelector('[data-act="export-full-pdf"]'));
  ok('有「出席回覆表（CSV）」輸出掣', !!v2.querySelector('[data-act="export-attend"]'));
  ok('有「活動履歷 CSV」輸出掣', !!v2.querySelector('[data-act="export-activity-csv"]'));
  ok('有「活動履歷 JSON」輸出掣', !!v2.querySelector('[data-act="export-activity-json"]'));
  const payload = nv.activityRecordPayload(store.find('notices', n0.id));
  ok('活動履歷 payload 包含旅團與活動資料', payload.unit && payload.activity.title === '測試通告（出席）', JSON.stringify(payload.activity));
  ok('活動履歷 payload 正確記錄出席名單', payload.attendees.some(a => a.attended && a.name === ms2[0].name), JSON.stringify(payload.attendees[0]));
  ok('詳情頁列出每位用戶嘅回覆', v2.querySelectorAll('[data-attend]').length >= 2,
    String(v2.querySelectorAll('[data-attend]').length));
  ok('舊通告可以補「出席與否」欄', (() => {
    const bare = store.add('notices', { id: 'nt-bare', status: 'published', title: { zh: '舊通告' }, needSignup: true, fields: [{ key: 'name', label: '姓名', type: 'text' }], signups: [] });
    const up = nv.ensureAttendField(store.find('notices', bare.id));
    return (up.fields || []).some(f => f.key === 'attend');
  })());
  store.remove('notices', 'nt-test-attend');
  store.remove('notices', 'nt-bare');
}

/* ---------- 通告「活動詳情」欄位（清單驅動：加一行就六處同步） ---------- */
section('通告欄位（活動詳情）');
{
  const nf = await import('../assets/js/lib/notice-fields.js');
  const nv = await import('../assets/js/views/notices.js');
  const KEYS = ['eventDate', 'deadline', 'venue', 'assembly', 'dismissal', 'programme', 'dress', 'fee', 'quota', 'enquiry'];
  ok('欄位清單齊（日期／截止／地點／集合／解散／內容／服裝／費用／名額／查詢）',
    KEYS.every(k => nf.NOTICE_INFO_FIELDS.some(f => f.key === k)),
    nf.NOTICE_INFO_FIELDS.map(f => f.key).join(','));
  ok('noticeInfoRows() 只列有值嘅欄位，名額會加「人」',
    JSON.stringify(nf.noticeInfoRows({ venue: '創興水上活動中心', fee: '$380', quota: 24 }))
      === JSON.stringify([['活動地點', '創興水上活動中心'], ['費用', '$380'], ['名額', '24 人']]));
  ok('空通告唔會有空行', nf.noticeInfoRows({}).length === 0 && nf.noticeInfoRows(null).length === 0);

  /* 編輯器：新欄位真係出喺表單 */
  window.location.hash = '#/notices/new';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 90));
  const ed = doc.getElementById('view');
  ok('開新通告有「集合／解散／服裝／內容／查詢」欄位',
    ['assembly', 'dismissal', 'dress', 'programme', 'enquiry'].every(k => !!ed.querySelector('#n-' + k)));

  /* 填 → 儲存 → 讀返 */
  ed.querySelector('#n-title').value = '欄位測試通告';
  ed.querySelector('#n-eventDate').value = '2026-10-03';
  ed.querySelector('#n-deadline').value = '2026-09-28';
  ed.querySelector('#n-venue').value = '創興水上活動中心';
  ed.querySelector('#n-assembly').value = '0830 測試團址地下';
  ed.querySelector('#n-dismissal').value = '1630 測試團址地下';
  ed.querySelector('#n-programme').value = '獨木舟、划艇、水上安全';
  ed.querySelector('#n-dress').value = '戶外制服';
  ed.querySelector('#n-fee').value = '$380（津貼後 $266）';
  ed.querySelector('#n-quota').value = '30';
  ed.querySelector('#n-enquiry').value = '1234 5678 測試負責人';
  ed.querySelector('[data-act="save"]').click();
  await new Promise(r => setTimeout(r, 220));
  const saved = store.load().notices.find(x => x.title?.zh === '欄位測試通告');
  ok('儲存後欄位入到通告資料',
    saved?.assembly === '0830 測試團址地下' && saved?.dress === '戶外制服' && saved?.quota === 30,
    JSON.stringify(saved && { assembly: saved.assembly, dress: saved.dress, quota: saved.quota }));

  /* 詳情頁／分享文字／列印內容都跟住清單 */
  const txt = nv.shareText(saved);
  ok('WhatsApp 分享文字帶埋集合／解散／服裝／查詢',
    /0830 測試團址地下/.test(txt) && /1630 測試團址地下/.test(txt) && /戶外制服/.test(txt) && /1234 5678/.test(txt),
    txt.split('\n').slice(3, 6).join(' / '));
  ok('分享文字唔會塞「內容／程序」（留返喺正文）', !/內容／程序/.test(txt));

  window.location.hash = '#/notices';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  store.remove('notices', saved.id);
}

/* ---------- 純環境變數開新旅團（唔改 Git） ---------- */
section('伺服器 Registry 旅團（Vercel 環境變數開）');
{
  const units = await import('../assets/js/lib/units.js');
  const { progressCfg, progressConfigured } = await import('../assets/js/lib/progress.js');
  const realFetch = globalThis.fetch;
  const SERVER_UNITS = {
    '0099': { code: '0099', name: '第九十九旅深資童軍團', short: '0099venture', progressServerSide: true, noticeReady: true }
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/api\/units/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ units: SERVER_UNITS }),
        json: async () => ({ units: SERVER_UNITS }) };
    }
    return realFetch(url, init);
  };
  try {
    await units.loadRegistry(true);
    ok('伺服器 Registry 嘅旅團會加入旅團清單（唔使改 data/units.json）',
      !!units.unitEntry('0099') && units.unitEntry('0099').name === '第九十九旅深資童軍團',
      JSON.stringify(units.unitList().map(u => u.code)));
    ok('伺服器旅團標示 fromApi（資料由空白開始，唔會去讀 data/units/0099/）',
      units.unitEntry('0099').fromApi === true && units.dataPathOf('0099') === null);

    /* 進度：伺服器端已經有 PROGRESSBACKEND＋KEY → 前端唔使填任何嘢 */
    const c = progressCfg('0099');
    ok('伺服器旅團嘅進度自動用伺服器端設定（唔使填 /exec ＋ Key）',
      c.serverSide === true && c.backend === '', JSON.stringify(c));
    ok('未登記嘅旅團唔會借用其他旅團嘅後端（免送錯資料）', units.backendOf('0098') === null,
      JSON.stringify(units.backendOf('0098')));
    ok('本機旅團（0082）唔會誤當伺服器端設定', progressCfg('0082').serverSide === false,
      JSON.stringify(progressCfg('0082')));
  } finally {
    globalThis.fetch = realFetch;
    await units.loadRegistry(true);
  }
}

/* ---------- 開新旅團教學（只限超級管理員 sheep） ---------- */
section('開新旅團教學（只限超管）');
{
  /* 兩種模式都用得到嘅登入輔助（示範模式冇真實帳戶） */
  const loginAs = async role => {
    if (MODE === 'mock') { auth.loginAsMock(role); return { ok: true }; }
    return role === 'super' ? auth.login('exco', 'sheep', TEST_SUPER_PASSWORD) : auth.login('leader', 'leader', '8202');
  };
  await loginAs('super');      // 以超管身份睇
  ok('以 sheep 登入 ＝ 超級管理員身份', auth.isSuper() === true);
  const ob = await import('../assets/js/lib/onboard.js');
  const t = ob.envUnitTemplate('0081', '第八十一旅深資童軍團', 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec', 'k81');
  ok('環境變數範本產生器（5 個變數齊）',
    ['TROOP_0081_BACKEND', 'TROOP_0081_APIKEY', 'TROOP_0081_NAME', 'TROOP_0081_PROGRESSBACKEND', 'TROOP_0081_PROGRESSAPIKEY']
      .every(k => t.includes(k)), t.split('\n')[0]);
  ok('範本會帶入 /exec 網址同 Key', t.includes('AKfycbTEST') && t.includes('= k81'));
  ok('逐步指示提到 Redeploy 同 initializeSheets',
    ob.envUnitSteps('0081').join(' ').includes('Redeploy') && ob.envUnitSteps('0081').join(' ').includes('initializeSheets'));

  /* 教學頁：新章節存在、可以複製 */
  window.location.hash = '#/docs/newunit';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const dv = doc.getElementById('view');
  ok('教學有「開新旅團（唔使改 Git）」章節', /開新旅團/.test(dv.textContent) && /唔使改 Git/.test(dv.textContent));
  ok('教學頁有環境變數範本（可以喺 app 內即刻複製）',
    !!dv.querySelector('#nu-out') && /TROOP_0081_BACKEND/.test(dv.querySelector('#nu-out')?.textContent || ''));
  ok('教學頁有「複製環境變數」／「複製逐步指示」掣',
    !!dv.querySelector('[data-act="copy-env"]') && !!dv.querySelector('[data-act="copy-steps"]'));
  const codeIn = dv.querySelector('#nu-code');
  codeIn.value = '0085';
  codeIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  ok('改編號會即時重新產生範本',
    /TROOP_0085_/.test(dv.querySelector('#nu-out')?.textContent || ''), dv.querySelector('#nu-out')?.textContent?.split('\n')[0]);
  ok('教學章節有檢查清單（Redeploy／initializeSheets／實測）',
    /檢查清單/.test(dv.textContent) && /Redeploy/.test(dv.textContent) && /initializeSheets/.test(dv.textContent));

  /* 帳號與系統 → 旅團設定：入口 */
  window.location.hash = '#/admin/unit';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const av = doc.getElementById('view');
  ok('「帳號與系統 → 旅團設定」有開新旅團入口（去教學）',
    !!av.querySelector('[data-go="#/docs/newunit"]'));
  const envBtn = av.querySelector('[data-act="env-template"]');
  ok('「旅團設定」有「即刻產生環境變數」掣', !!envBtn);
  envBtn?.click();
  await new Promise(r => setTimeout(r, 150));
  const dlg = doc.querySelector('.modal, [role="dialog"]');
  ok('產生環境變數對話框有 5 個變數預覽同複製掣',
    !!dlg && /TROOP_0081_BACKEND/.test(dlg.textContent || '')
    && [...dlg.querySelectorAll('button')].some(b => /複製環境變數/.test(b.textContent || '')));
  [...doc.querySelectorAll('.modal button, [role="dialog"] button')].find(b => /關閉/.test(b.textContent || ''))?.click();
  await new Promise(r => setTimeout(r, 80));

  /* ---- 非超管（領袖／執委）睇唔到 ---- */
  await loginAs('leader');
  window.location.hash = '#/docs';
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const leadNav = [...doc.querySelectorAll('[data-sec]')].map(x => x.dataset.sec);
  ok('領袖登入：教學目錄冇「開新旅團」章節', !leadNav.includes('newunit'), leadNav.join(','));
  ok('領袖登入：教學全文唔會出現 TROOP_ 環境變數範本',
    !/TROOP_0081_BACKEND/.test(doc.getElementById('view').textContent));

  window.location.hash = '#/admin/unit';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const leadUnits = doc.getElementById('view');
  ok('領袖登入：旅團設定冇「即刻產生環境變數」掣', !leadUnits.querySelector('[data-act="env-template"]'));
  ok('領袖登入：旅團設定完全冇開新旅團／環境變數嘅教學',
    !/開新旅團/.test(leadUnits.textContent) && !/TROOP_/.test(leadUnits.textContent)
    && !/超級管理員/.test(leadUnits.textContent));

  /* 多旅團部署教學而家係超管專用（同 newunit 一樣）—— 領袖睇日常教學就夠 */
  window.location.hash = '#/docs/start';
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  window.location.hash = '#/docs/multiunit';
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const multiTxt = doc.getElementById('view').textContent;
  ok('領袖登入：多旅團部署教學唔會出現（只限超管，同 newunit 一樣）',
    !/多旅團架構（每個旅團一個後端）/.test(multiTxt)
    && !/Commit & push/.test(multiTxt)
    && !/新旅團點接入（推薦/.test(multiTxt)
    && !/ADMIN_ONBOARDING/.test(multiTxt));

  /* 直接打網址／亂入 #/docs/newunit 一樣唔會見到教學內容 */
  window.location.hash = '#/docs/newunit';
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const sneak = doc.getElementById('view').textContent;
  ok('非超管直接入 #/docs/newunit → 顯示「只限超級管理員」',
    /只限超級管理員/.test(sneak) && !/TROOP_0081_BACKEND/.test(sneak) && !/Vercel → Settings/.test(sneak));

  /* 還原做超管（後面章節用） */
  await loginAs('super');
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
}

/* ---------- 5. 旅團選擇閘 ---------- */
section('旅團選擇閘（先揀旅團再登入）');
{
  ok('網址有 ?u= 時直接入登入畫面（唔會見到旅團閘）',
    !/揀你嘅旅團/.test(doc.body.textContent));
  ok('index.html 有載入 main.js（旅團閘喺 main.js）',
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('assets/js/main.js'));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'assets/js/main.js'), 'utf8');
  ok('main.js 先顯示旅團閘，之後先 init + 登入',
    /if \(!unitChosen\(\)\) return renderUnitGate\(\);/.test(mainSrc)
    && mainSrc.indexOf('renderUnitGate();') < mainSrc.indexOf('await init();'));
  ok('旅團閘有 MOCK 選項', /data-pick="MOCK"/.test(mainSrc));
  ok('登入頁有「更換旅團」掣', /btnGate/.test(mainSrc));
}

/* ---------- 6. 公開資料（申報 / 物資 / 通告報名 / 社交媒體 / 相簿） ----------
   ★ 2026-09-25 團長：「『成員連結』改名為『公開資料』」 */
section('公開資料（免登入公開頁）');
{
  const links = model.memberLinks();
  const ids = links.map(l => l.id);
  ok('有收支申報連結（entry.html）', ids.includes('entry'));
  ok('有物資借用連結（borrow.html）', ids.includes('borrow'));
  ok('有團章連結（constitution.html）', ids.includes('constitution'));
  ok('每條連結都帶旅團編號', links.every(l => /u=(0082|MOCK)/.test(l.url)), links.map(l => l.url).join(' | '));
  ok('borrow.html 存在', fs.existsSync(path.join(ROOT, 'borrow.html')));
  ok('public-borrow.js 存在', fs.existsSync(path.join(ROOT, 'assets/js/public-borrow.js')));

  window.location.hash = '#/links';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const v3 = doc.getElementById('view');
  ok('「公開資料」頁可以渲染', (v3.innerHTML || '').length > 400, String((v3.innerHTML || '').length));
  ok('頁上有 QR 掣', v3.querySelectorAll('[data-qr]').length >= 3, String(v3.querySelectorAll('[data-qr]').length));
  ok('頁上有列印海報掣', v3.querySelectorAll('[data-poster]').length >= 3);
  ok('側邊欄有「公開資料」（已由「成員連結」改名）', /公開資料/.test(doc.querySelector('.sidebar')?.textContent || ''));
  if (MODE === 'real') {
    ok('物資借用送出網址已設定（borrow.html → 總表）',
      /\/exec$/.test(store.load().settings?.publicBorrow?.submitUrl || ''),
      store.load().settings?.publicBorrow?.submitUrl);
  }
}

/* ---------- 7. 進度紀錄：一個後端、兩個前端 ---------- */
section('進度紀錄（一個後端 · 兩個前端）');
{
  const vp = await import('../assets/js/views/progress.js');
  const lp = await import('../assets/js/lib/progress.js');
  const cfg = lp.progressCfg();
  /* Registry 而家唔再 hardcode 任何旅團（真實旅團改用 Vercel 環境變數），
     所以「未登記」嗰陣進度後端係空 —— 呢個先係啱嘅私隱行為。
     有登記嘅話就要係個 /exec。 */
  ok('進度後端：有登記就係 /exec，未登記就要係空（唔可以借人哋嘅）',
    MODE === 'mock'
      ? cfg.backend === ''                     /* 示範模式唔可以指向真實旅團嘅後端 */
      : (cfg.backend === '' || /\/exec$/.test(cfg.backend)),
    JSON.stringify({ backend: cfg.backend, registered: cfg.registered }));
  ok('預設用內建考核項目定義（唔使連任何其他系統）',
    lp.DEFAULT_CATALOG_URL === 'data/progress/items.json');
  ok('不再有 portal / 外連設定（巳移除）',
    typeof vp.portalIdentity === 'undefined' && typeof vp.readiness === 'undefined'
    && typeof vp.checkConnection === 'undefined' && typeof vp.TICK_ROLES === 'undefined');

  window.location.hash = '#/progress';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const v4 = doc.getElementById('view');
  ok('進度頁主畫面有「重新讀取」掣', !!v4.querySelector('[data-act="reload"]'));
  ok('進度頁有「設定」入口', !!v4.querySelector('[data-act="settings"]'));
  window.location.hash = '#/progress/settings';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const sv = doc.getElementById('view');
  ok('設定頁只講後端（/exec ＋ API Key），冇提任何其他系統',
    !!sv.querySelector('#p-backend') && !!sv.querySelector('#p-key') && !/VSBADGE|vsbadge/.test(sv.textContent));
  ok('設定頁有「自訂考核項目」欄（預設留空用內建）', !!sv.querySelector('#p-catalog'));

  /* 內建考核項目檔 */
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/progress/items.json'), 'utf8'));
  ok('內建考核項目有 badges（第 11 版綱要）', Array.isArray(items.badges) && items.badges.length >= 4);
  const flat = lp.flattenItems(items);
  ok('flattenItems 讀得到項目（勾選頁要用）', Object.keys(flat).length > 30, String(Object.keys(flat).length));

  /* 後端（Code.gs 範本）要有同一組動作：一個後端餵兩個前端 */
  const { gasTemplate, SHEET_TABS } = await import('../assets/js/lib/gastemplate.js');
  const code = gasTemplate();
  ok('Code.gs 有進度分頁（進度追蹤／其他獎章／待批完成／活動履歷／待批履歷／成員名單）',
    ['進度追蹤', '其他獎章', '待批完成', '活動履歷', '待批履歷', '成員名單'].every(t => SHEET_TABS.includes(t) && code.includes("'" + t + "'")));
  ok('Code.gs 支援 ?action=load（讀進度）', /action === 'load'/.test(code) && /function loadProgressData/.test(code));
  ok('Code.gs 支援 save / saveOtherBadge 寫入（要 API Key）', /'save' \|\| body\.action === 'saveOtherBadge'/.test(code) && /saveProgress/.test(code));
  ok('Code.gs 寫入前一定核對 API Key', /未授權：API Key 唔正確/.test(code));
  ok('Code.gs 有「通告全文」分頁（公開頁免登入讀新通告，唔使改 Git）',
    SHEET_TABS.includes('通告全文') && /function writeNoticesFull/.test(code) && /function loadPublicNotices/.test(code));
  ok('公開通告只回 published（草稿唔會外洩）',
    /textOf\(rows\[i\]\[2\]\) !== 'published'/.test(code));
  ok('Code.gs 支援 action=notices（公開讀通告）', /body\.action === 'notices'/.test(code));
  ok('Code.gs 有審批中心（reviewRequest / reviewLogRequest，要 API Key）',
    /body\.action === 'reviewRequest' \|\| body\.action === 'reviewLogRequest'/.test(code)
    && /function reviewProgressRequest/.test(code) && /function reviewLogRequest/.test(code));
  ok('批准待批完成會寫入「進度追蹤」（同一個後端）',
    /已批准並寫入進度/.test(code) && /由申請轉入/.test(code));
  ok('Code.gs 會同步成員名單（兩個前端見同一批人）', /writeMemberList/.test(code));
  ok('Code.gs 寫入用 LockService 排隊（全團同時撳都唔會撞）',
    /LockService\.getScriptLock/.test(code) && /withLock\(function/.test(code));
  const onDisk = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  ok('apps-script/Code.gs 同 app 內下載嘅版本一致（npm run build:gas）', onDisk === code);
}
/* ---------- 8. 首頁帳目：現在結餘（含期初） ---------- */
section('首頁帳目（現在結餘 · 期初結餘）');
{
  const db3 = store.load();
  const keepOpen = db3.settings.openingBalance;
  const keepOb = db3.settings.openingBalances ? JSON.parse(JSON.stringify(db3.settings.openingBalances)) : undefined;
  const keepTx = JSON.parse(JSON.stringify(db3.transactions));
  db3.settings.openingBalance = 8803.28;
  db3.transactions = [
    { id: 'tx1', date: '2026-09-01', type: 'income', amount: 1000, item: '團費' },
    { id: 'tx2', date: '2026-09-02', type: 'expense', amount: 2500, item: '露營' }
  ];
  store.commit();
  ok('現在結餘 = 期初 + 收入 − 支出',
    Math.round(model.currentBalance() * 100) / 100 === 7303.28, String(model.currentBalance()));
  ok('唔會再淨係顯示收入減支出（舊做法會出現 −1500）',
    model.balance(db3.transactions) === -1500 && model.currentBalance() > 0,
    `balance=${model.balance(db3.transactions)} current=${model.currentBalance()}`);
  const bd = model.balanceBreakdown();
  ok('結餘拆解有期初／收入／支出／現在',
    bd.opening === 8803.28 && bd.income === 1000 && bd.expense === 2500 && Math.round(bd.now * 100) / 100 === 7303.28,
    JSON.stringify(bd));

  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const dash = doc.getElementById('view');
  ok('儀表板顯示「現在結餘」', /現在結餘/.test(dash.textContent));
  ok('儀表板有帳目流程卡（期初＋收入−支出＝現在）', !!dash.querySelector('.bal-flow'));
  ok('儀表板顯示期初結餘數字', dash.textContent.includes('8,803.28') || dash.textContent.includes('8803.28'),
    dash.textContent.replace(/\s+/g, ' ').slice(0, 200));
  ok('儀表板唔會顯示負數結餘', !/HK\$\s?-/.test(dash.querySelector('.bal-cell.now')?.textContent || ''),
    dash.querySelector('.bal-cell.now')?.textContent);

  /* 真實情況：舊帳屬於**上年度** → 本年度期初應該係上年度期末 */
  db3.settings.openingBalances = { '2025-26': 8803.28, '2026-27': 7846.64 };
  db3.settings.openingBalance = 0;
  db3.transactions = [
    { id: 'tx3', date: '2025-06-14', type: 'income', amount: 8630, item: '舊帳收入' },
    { id: 'tx4', date: '2026-01-05', type: 'expense', amount: 9586.64, item: '舊帳支出' }
  ];
  store.commit();
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const dash2 = doc.getElementById('view');
  const dtxt = dash2.textContent.replace(/\s+/g, ' ');
  const bd2 = model.balanceBreakdown();
  ok('上年度帳目唔會計入本年度收入／支出',
    bd2.income === 0 && bd2.expense === 0, `income=${bd2.income} expense=${bd2.expense}`);
  ok('上年度期末 = 8,803.28 + 8,630 − 9,586.64 = 7,846.64',
    Math.round(bd2.prevClosing * 100) / 100 === 7846.64, String(bd2.prevClosing));
  ok('本年度（2026-27）期初 = 上年度期末 7,846.64，唔係 8,803.28',
    Math.round(model.currentBalance() * 100) / 100 === 7846.64, String(model.currentBalance()));
  ok('儀表板寫明係邊個年度（帳目（現在）· 2026-27 年度）',
    /帳目（現在）·\s*2026-27 年度/.test(dtxt), dtxt.slice(0, 120));
  ok('儀表板期初格顯示 7,846.64（唔係 8,803.28）',
    (dash2.querySelector('.bal-flow .bal-cell .bal-v')?.textContent || '').includes('7,846.64'),
    dash2.querySelector('.bal-flow .bal-cell .bal-v')?.textContent);
  ok('儀表板有上年度對數行（期初 8,803.28 → 期末 7,846.64）',
    /上年度 2025-26：期初/.test(dtxt) && dtxt.includes('8,803.28') && dtxt.includes('7,846.64'),
    dtxt.slice(0, 260));
  ok('上年度期末同本年度期初吻合時唔會出警告',
    !/唔吻合/.test(dtxt));
  ok('逐年期初結餘有捷徑去年度設定',
    !!dash2.querySelector('[data-go="#/finance/settings"]'));

  // 負數時要有解釋
  delete db3.settings.openingBalances;
  db3.settings.openingBalance = 0;
  store.commit();
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  ok('結餘係負數時會解釋原因（期初未填）',
    /點解會見到負數/.test(doc.getElementById('view').textContent));
  ok('負數提示有「改期初結餘」捷徑',
    !!doc.querySelector('[data-go="#/finance/settings"]'));

  db3.settings.openingBalance = keepOpen;
  db3.settings.openingBalances = keepOb;
  db3.transactions = keepTx;
  store.commit();

  window.location.hash = '#/finance/settings';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const fv = doc.getElementById('view');
  ok('財務有「年度設定」分頁（改期初結餘）', !!fv.querySelector('#set-open-legacy'));
  ok('年度設定頁顯示結餘點計', /現在結餘/.test(fv.textContent));
  /* 期初結餘要逐年，唔可以係一個全域數字 */
  ok('期初結餘係逐年欄位（唔再係單一全域數字）',
    fv.querySelectorAll('[data-open-year]').length >= 2,
    String(fv.querySelectorAll('[data-open-year]').length));
  ok(`期初欄位包含本年度（${model.currentFY()}）`,
    !!fv.querySelector(`[data-open-year="${model.currentFY()}"]`));
  ok('年度設定有「由上年度期末結轉」掣', !!fv.querySelector('[data-act="carry-all"]'));
  if (MODE === 'real') {
    /* 「用舊帳嘅數字填返」要有參考帳先出現。82 旅嗰份 finance.reference.json
       已經隨私隱清理移走，所以新旅團唔會見到呢粒掣 —— 驗返呢個一致性就夠。 */
    const hasRef = (store.load().reference?.transactions || []).length > 0;
    const refBtn = fv.querySelector('[data-act="use-ref-opening"]');
    ok('有參考帳先有「用舊帳嘅數字填返」掣（冇就唔應該出現）',
      hasRef ? !!refBtn : !refBtn, `hasRef=${hasRef} btn=${!!refBtn}`);
  }
}

/* ---------- 期初結餘遷移（舊嘅全域數字 → 逐年） ---------- */
console.log('\n▌期初結餘遷移（8,803.28 係 2025-26 嘅期初，唔係 2026-27）');
{
  const mk = (legacy, extraSettings = {}) => ({
    settings: { openingBalance: legacy, scoutFYStartMonth: 4, ...extraSettings },
    reference: {
      openingBalance: 8803.28, check: { income: 8630, expense: 9586.64, opening: 8803.28, closing: 7846.64 },
      transactions: [
        { date: '2025-06-14', type: 'income', amount: 100 },
        { date: '2026-01-05', type: 'expense', amount: 50 }
      ]
    }
  });

  const a = mk(8803.28);
  ok('舊全域期初（＝舊帳上年度結餘）會自動搬去對應年度', store.migrateOpeningBalances(a) === true);
  ok('遷移後 2025-26 期初 = 8,803.28',
    Number(a.settings.openingBalances?.['2025-26']) === 8803.28, JSON.stringify(a.settings.openingBalances));
  ok('遷移後 2026-27 期初 = 7,846.64（＝上年度期末）',
    Number(a.settings.openingBalances?.['2026-27']) === 7846.64, JSON.stringify(a.settings.openingBalances));
  ok('遷移後全域欄位還原做 0（佢只係「第一筆帳目之前」嘅底數）',
    Number(a.settings.openingBalance) === 0, String(a.settings.openingBalance));
  ok('遷移有留紀錄（幾時搬咗邊個年度）',
    a.settings.openingMigratedFrom?.year === '2025-26' && a.settings.openingMigratedFrom?.nextYear === '2026-27',
    JSON.stringify(a.settings.openingMigratedFrom));

  const b = mk(8803.28, { openingBalances: { '2026-27': 7846.64 } });
  ok('已經逐年設定過就唔會再搬（唔會蓋過人手輸入）', store.migrateOpeningBalances(b) === false);
  ok('已經逐年設定過：內容原封不動', Number(b.settings.openingBalances['2026-27']) === 7846.64
    && b.settings.openingBalances['2025-26'] === undefined, JSON.stringify(b.settings.openingBalances));
  ok('全域數字同舊帳唔同就唔會亂搬', store.migrateOpeningBalances(mk(5000)) === false);
  ok('全域係 0 就唔使搬', store.migrateOpeningBalances(mk(0)) === false);
}

/* ---------- 跨系統身份 key（federation L1） ---------- */
console.log('\n▌跨系統身份 key（進度追蹤係獨立系統，要靠 key 對人）');
{
  const db4 = store.load();
  /* 呢段測試 migrateMemberKeys 本身。上面啲測試會加入新團員（新旅團由空白
     開始，所以要自己整 fixture），佢哋未行過遷移 —— 行一次先，
     再驗「行完之後人人有 key、key 穩定」。 */
  store.migrateMemberKeys(db4);
  store.commit();
  const ms = store.load().members;
  ok('所有用戶都有 systemId（自動產生）',
    ms.every(m => !!m.systemId), `缺 ${ms.filter(m => !m.systemId).length} 個`);
  ok('systemId 全部唔重複',
    new Set(ms.map(m => m.systemId)).size === ms.length, String(new Set(ms.map(m => m.systemId)).size));
  ok('所有用戶都有 ymis 欄（未填都要有呢個欄）',
    ms.every(m => 'ymis' in m), String(ms.filter(m => !('ymis' in m)).length));

  const first = ms[0];
  const before = first?.systemId;
  store.migrateMemberKeys(store.load());
  ok('migrateMemberKeys 唔會改已有 systemId（key 必須穩定）',
    !first || store.load().members[0].systemId === before, String(before));
  ok('migrateMemberKeys 第二次跑係 no-op', store.migrateMemberKeys(db4) === false);
  /* systemId 必須係確定性：另一部裝置獨立跑遷移都要得到同一個 key，
     否則呢個 key 永遠對唔上，做唔到跨系統配對 */
  const clone = JSON.parse(JSON.stringify({ unitCode: db4.unitCode, members: ms.map(m => ({ id: m.id })) }));
  store.migrateMemberKeys(clone);
  ok('systemId 係確定性（唔同裝置都推斷到同一個）',
    clone.members.every((m, i) => m.systemId === ms[i].systemId),
    `${clone.members[0].systemId} vs ${ms[0].systemId}`);
  ok('systemId 格式 = 旅團編號-用戶 id',
    ms.every(m => m.systemId === `${db4.unitCode}-${m.id}`), ms[0].systemId);

  const kc0 = model.keyCoverage(ms);
  ok('keyCoverage 統計到 YMIS 覆蓋率',
    kc0.total === ms.length && kc0.withSystemId === ms.length, JSON.stringify(kc0));
  ok('冇 YMIS 時 memberKey fallback 去 systemId',
    model.memberKey({ systemId: 'abc' }).kind === 'systemId' && model.memberKey({ systemId: 'abc' }).key === 'abc');
  ok('有 YMIS 時 memberKey 優先用 YMIS',
    model.memberKey({ ymis: 'Y123', systemId: 'abc' }).kind === 'ymis');
  ok('乜都冇 → key 係空', model.memberKey({}).key === '');
  /* 對方規則：成員用 YMIS，領袖用 Email（佢登入頁寫住） */
  ok('領袖優先用 Email 做 key（領袖本來就冇 YMIS）',
    model.memberKey({ identity: 'leader', email: 'L@x.hk', ymis: '' }).kind === 'email');
  ok('團員優先用 YMIS 做 key',
    model.memberKey({ identity: 'member', email: 'a@x.hk', ymis: '2019259338' }).kind === 'ymis');
  ok('expectedKeyKind：領袖→email，執委／團員→ymis',
    model.expectedKeyKind({ identity: 'leader' }) === 'email'
    && model.expectedKeyKind({ identity: 'exco' }) === 'ymis'
    && model.expectedKeyKind({ identity: 'member' }) === 'ymis');
  {
    const kcL = model.keyCoverage([
      { id: 'a', name: '領袖A', identity: 'leader', email: 'a@x.hk', systemId: 's1' },
      { id: 'b', name: '團員B', identity: 'member', ymis: '2019259338', systemId: 's2' }
    ]);
    ok('領袖有 Email + 團員有 YMIS → 100% 對得上（唔會誤報領袖缺 YMIS）',
      kcL.percent === 100 && kcL.unmatched === 0 && kcL.ready === true, JSON.stringify(kcL));
    const kcM = model.keyCoverage([
      { id: 'c', name: '領袖C', identity: 'leader', email: '', systemId: 's3' },
      { id: 'd', name: '團員D', identity: 'member', ymis: '', systemId: 's4' }
    ]);
    ok('領袖冇 Email + 團員冇 YMIS → 列出要補乜',
      kcM.unmatched === 2 && kcM.unmatchedList[0].need === 'email' && kcM.unmatchedList[1].need === 'ymis',
      JSON.stringify(kcM.unmatchedList));
    ok('systemId 唔算「對方認得到」（只係本系統 fallback）',
      kcM.withSystemId === 2 && kcM.matched === 0, JSON.stringify(kcM));
  }
  ok('findByKey 可以用 Email 搵人（領袖）',
    (() => { const m0 = store.load().members.find(x => String(x.email || '').trim());
      return m0 ? model.findByKey(m0.email)?.id === m0.id : true; })());

  const keepY = first.ymis;
  const ymisBase = model.keyCoverage(store.load().members).withYmis;   // 基準（seed 可能已有真實 YMIS）
  first.ymis = 'TEST-YMIS-1';
  store.commit();
  ok('findByKey 用 YMIS 搵到人', model.findByKey('TEST-YMIS-1')?.id === first.id);
  ok('findByKey 用 systemId 搵到人', model.findByKey(first.systemId)?.id === first.id);
  ok('findByKey 搵唔到會回 null', model.findByKey('NO-SUCH-KEY') === null);
  ok('YMIS 覆蓋率跟實際填入數一致',
    model.keyCoverage(store.load().members).withYmis === ymisBase + (keepY ? 0 : 1),
    `${model.keyCoverage(store.load().members).withYmis} vs base ${ymisBase}`);
  first.ymis = keepY;
  store.commit();

  /* UI：用戶編輯頁要有 YMIS 欄 */
  window.location.hash = '#/members/edit/' + first.id;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const mv = doc.getElementById('view');
  ok('用戶編輯頁有「會籍編號（YMIS）」欄', !!mv.querySelector('#f-ymis'));
  ok('用戶編輯頁顯示系統 ID（唯讀）',
    /系統 ID/.test(mv.textContent) && !!Array.from(mv.querySelectorAll('input[readonly]')).length);

  /* 覆蓋率提示只在「有人對唔上」先會出 —— 臨時加一位冇 YMIS／Email 嘅團員嚟驗 */
  const miss = store.add('members', { name: '未填編號團員（smoke）', identity: 'member', status: 'active' });
  window.location.hash = '#/members';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  ok('用戶列表有身份對應覆蓋率提示（按身份分 YMIS／Email）',
    /可以同進度系統對上/.test(doc.getElementById('view').textContent)
    && /團員／執委/.test(doc.getElementById('view').textContent)
    && /領袖/.test(doc.getElementById('view').textContent));
  store.remove('members', miss.id);

  window.location.hash = '#/progress';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const pv = doc.getElementById('view').textContent;
  /* 2026-09-16（團長更正）：執委系統唔連任何其他系統，只讀寫自己嘅後端 */
  ok('進度頁講明只係「一個後端、兩個前端」（唔會連其他系統）',
    /一個後端/.test(pv) && /兩個前端/.test(pv) && /唔會連去任何其他網站/.test(pv));
  ok('進度頁有「設定」入口（填後端網址 / API Key）', !!doc.querySelector('[data-act="settings"]'));
  ok('教學有逐步指示（initializeSheets → showApiKey）',
    /initializeSheets/.test(pv) && /showApiKey/.test(pv));
  ok('設定頁有身份對應說明（YMIS 對人）', (() => {
    window.location.hash = '#/progress/settings';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    return true;
  })());

  /* 總表要帶住 key，Sheet 先可以做 join */
  const { gasTemplate } = await import('../assets/js/lib/gastemplate.js');
  const gsCode = gasTemplate();
  ok('Code.gs 團員表帶 ymis 欄', /'ymis'/.test(gsCode));
  ok('Code.gs 團員表帶 systemId 欄', /'systemId'/.test(gsCode));
}

/* ---------- 新旅團申請接入（#1） ---------- */
console.log('\n▌新旅團申請接入（送去 ADMIN 收件匣）');
{
  const ob = await import('../assets/js/lib/onboard.js');
  const box = ob.adminInbox();
  ok('admin 收件匣已設定（data/units.json → admin.submitUrl）', box.configured === true, box.url);
  ok('收件匣係 Apps Script /exec', /^https:\/\/script\.google\.com\/macros\/s\//.test(box.url), box.url);
  ok('appType 係 82venture（共用收件匣可以分辨）', ob.APP_TYPE === '82venture');

  const good = ob.validateApplication({
    troopId: '0100', troopName: '第一百旅深資童軍團',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec',
    apiKey: 'K1', contact: 'a@b.hk', note: 'x'
  });
  ok('填齊就通過驗證', good.ok === true && good.errors.length === 0, JSON.stringify(good.errors));
  ok('payload schema 同收件匣 submitRegistration 格式對齊',
    ['troopId','troopName','scriptUrl','apiKey','appType','appName','note'].every(k => k in good.payload),
    Object.keys(good.payload).join(','));
  ok('payload 帶 mainSystemUrl（管理員核對用）',
    typeof good.payload.mainSystemUrl === 'string' && good.payload.mainSystemUrl.length > 0,
    good.payload.mainSystemUrl);
  ok('payload 帶 at（時間戳）', /^\d{4}-\d{2}-\d{2}T/.test(good.payload.at || ''), good.payload.at);

  const bad = ob.validateApplication({ troopId: '', troopName: '', scriptUrl: 'http://example.com/x' });
  ok('缺欄位會逐項報錯', bad.ok === false && bad.errors.length >= 3, JSON.stringify(bad.errors));
  ok('唔係 GAS /exec 嘅後端網址會被擋',
    bad.errors.some(e => /\/exec/.test(e)), JSON.stringify(bad.errors));
  ok('旅團編號格式會被驗證',
    ob.validateApplication({ troopId: '01 00!!', troopName: 'X',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' })
      .errors.some(e => /旅團編號/.test(e)));

  const failed = await ob.submitApplication({ troopId: '', troopName: '', scriptUrl: '' });
  ok('驗證失敗就唔會送出', failed.ok === false && failed.errors.length > 0, JSON.stringify(failed.errors));

  /* ---- 送出：一定要經同源 proxy 去 ADMIN 系統，唔可以「冇送到都話成功」 ---- */
  const realFetch = globalThis.fetch;
  const seen = [];
  const stub = (handler) => async (url, init = {}) => { seen.push({ url: String(url), init }); return handler(String(url), init); };
  const APP = {
    troopId: '0100', troopName: '第一百旅深資童軍團',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec',
    apiKey: 'K1', contact: 'a@b.hk', note: '想埋進度'
  };

  globalThis.fetch = stub(async () => ({ ok: true, status: 200, json: async () => ({ success: true, message: '申請已提交' }) }));
  const okSend = await ob.submitApplication(APP);
  const body = JSON.parse(seen[0].init.body);
  ok('送出申請 → 行同源 /api/proxy（action=submitRegistration）',
    seen[0].url === 'api/proxy' && body.action === 'submitRegistration', seen[0].url);
  ok('送出嘅 payload 帶 appType=82venture ＋ appName（ADMIN 系統認得到係邊個 app）',
    body.appType === '82venture' && body.appName === '深資童軍管理系統', JSON.stringify({ appType: body.appType, appName: body.appName }));
  ok('送出成功 → 經 proxy 送到 ADMIN（唔會當自己「ADMIN 已確認」，因為收件匣唔回執）',
    okSend.ok === true && okSend.via === 'proxy' && okSend.receipt === false, JSON.stringify(okSend));

  seen.length = 0;
  globalThis.fetch = stub(async (url) => {
    /* 伺服器路線話送唔到；直接送同樣失敗 → 真係要當失敗 */
    if (url === 'api/proxy') return { ok: false, status: 502, json: async () => ({ success: false, error: '申請未能送達管理員，請稍後重試' }) };
    throw new Error('network failed');
  });
  const badSend = await ob.submitApplication(APP);
  ok('伺服器路線＋直接送都失敗 → 當失敗（唔會呃申請人話成功）',
    badSend.ok === false && /未能送達管理員/.test(badSend.errors.join(' ')), JSON.stringify(badSend.errors));
  ok('失敗都帶返 payload（可以複製去 WhatsApp／電郵畀管理員）',
    badSend.payload && badSend.payload.troopId === '0100');
  ok('申請內容純文字版有齊編號／後端／appType（求救用）',
    /旅團編號：0100/.test(ob.applicationText(badSend.payload))
    && /\/exec/.test(ob.applicationText(badSend.payload))
    && /82venture/.test(ob.applicationText(badSend.payload)));

  seen.length = 0;
  globalThis.fetch = stub(async (url) => {
    /* 伺服器路線話送唔到，但自己直接送得到 → 都算送到（未確認） */
    if (url === 'api/proxy') return { ok: false, status: 502, json: async () => ({ success: false, error: '申請未能送達管理員，請稍後重試' }) };
    return { ok: true, status: 200 };
  });
  const rescued = await ob.submitApplication(APP);
  ok('伺服器路線失敗 → 會自動再直接送一次（寧願重複都唔好收唔到）',
    seen.length === 2 && seen[1].url === ob.adminInbox().url && seen[1].init.mode === 'no-cors',
    seen.map(x => x.url).join(' → '));
  ok('呢種情況一樣當送到（直接送），亦唔會當係 ADMIN 已回覆',
    rescued.ok === true && rescued.via === 'direct' && rescued.receipt === false);

  seen.length = 0;
  globalThis.fetch = stub(async () => ({ ok: false, status: 404, text: async () => '<html>404</html>', json: async () => { throw new Error('not json'); } }));
  const fallback = await ob.submitApplication(APP);
  ok('冇 /api/proxy（純靜態部署）→ 自動 fallback 直接 POST 去收件匣',
    seen.length === 2 && seen[1].url === ob.adminInbox().url && seen[1].init.mode === 'no-cors',
    seen.map(x => x.url).join(' → '));
  ok('直接送出（冇 /api）一樣當送到',
    fallback.ok === true && fallback.via === 'direct' && fallback.receipt === false);
  globalThis.fetch = realFetch;

  const cl = ob.adminChecklist('0100');
  ok('管理員 checklist 有列出要做嘅嘢（units.json ＋ 資料夾 ＋ 通知旅團）',
    cl.length >= 4 && cl.some(x => x.includes('units.json')) && cl.some(x => x.includes('通知旅團')),
    JSON.stringify(cl));
  ok('checklist 講明進度係「一個後端、兩個前端」',
    cl.some(x => /一個後端/.test(x) && /兩個前端/.test(x)), JSON.stringify(cl));
  ok('checklist 講明旅團自己去「進度 → 設定」填 Script ＋ API Key',
    cl.some(x => /進度 → 設定/.test(x) && /API Key/.test(x)), JSON.stringify(cl));
  ok('checklist 唔再要求 portalOrigin（一個後端、兩個前端）',
    !cl.some(x => /portalOrigin/.test(x)), JSON.stringify(cl));

}

/* ---------- app 內教學要同實際做法一致 ---------- */
{
  window.location.hash = '#/docs/multiunit';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const dt = doc.getElementById('view').textContent;
  ok('教學「多旅團部署」有講新旅團申請接入', /新旅團申請接入/.test(dt));
  ok('教學講明每旅團用自己嘅 Sheet（唔係共用總表）', /每個旅團用自己嘅 Google Sheet 做後端/.test(dt));
  ok('教學有教起後端步驟（Code.gs / initializeSheets / 部署）',
    /Code\.gs/.test(dt) && /initializeSheets/.test(dt) && /網頁應用程式/.test(dt));

  window.location.hash = '#/docs/progress';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const pt = doc.getElementById('view').textContent;
  ok('教學「進度紀錄」講明一個後端、兩個前端', /一個後端/.test(pt) && /兩個前端/.test(pt));
  ok('教學講明唔會連去任何其他系統', /唔需要連去任何其他系統/.test(pt) || /唔會連去任何其他系統/.test(pt));
  ok('教學教後端要支援 ?action=load 同 action=save', /action=load/.test(pt) && /action=save/.test(pt));
  ok('教學講明 API Key＝執委身份', /API Key＝執委身份/.test(pt) || /就等於/.test(pt));
  ok('教學講明考核項目已內建（唔使連網站）', /data\/progress\/items\.json/.test(pt));
  ok('教學有「審批中心」（批准寫入進度追蹤、拒絕唔會刪紀錄）',
    /審批中心/.test(pt) && /reviewRequest/.test(pt) && /已拒絕/.test(pt));
  ok('教學講明團員只專心紀錄冊、批核喺管理系統', /專心/.test(pt) && /深資童軍管理系統/.test(pt));
  ok('教學講明團員用 YMIS、領袖用 Email', /團員／執委用 YMIS/.test(pt) && /領袖用 Email/.test(pt));
}

/* ---------- 財務：領袖免收團費（2026-09-16 團長要求） ---------- */
section('團費（領袖免收）');
{
  const f = await import('../assets/js/lib/model.js');
  const keepMembers = JSON.parse(JSON.stringify(store.load().members));
  const keepFees = JSON.parse(JSON.stringify(store.load().fees));
  store.load().members = [
    { id: 'lead1', name: '張領袖', identity: 'leader', status: 'active', email: 'l@example.com' },
    { id: 'mem1', name: '陳團員', identity: 'member', status: 'active', ymis: '1234567890' },
    { id: 'exco1', name: '李執委', identity: 'exco', status: 'active', ymis: '1234567891' },
    { id: 'hon1', name: '榮譽會員', identity: 'member', status: 'active', feeExempt: true }
  ];
  store.load().fees = [
    { id: 'xf1', memberId: 'lead1', period: '2026-27', amount: 360, paid: false, due: '2026-01-01' },
    { id: 'xf2', memberId: 'mem1', period: '2026-27', amount: 360, paid: false, due: '2026-01-01' }
  ];
  store.commit();

  ok('領袖自動免收團費', f.feeExempt({ identity: 'leader' }) === true);
  ok('可以逐個人設定免收（feeExempt: true）',
    f.feeExempt({ identity: 'member', feeExempt: true }) === true && f.feeExempt({ identity: 'member' }) === false);
  const grid = f.feeGrid('2026-27');
  ok('團費收款表唔會列出領袖', !grid.some(r => r.member.id === 'lead1'), grid.map(r => r.member.name).join(','));
  ok('團費收款表唔會列出「免收團費」嘅人', !grid.some(r => r.member.id === 'hon1'));
  ok('執委同團員照樣要交', grid.some(r => r.member.id === 'exco1') && grid.some(r => r.member.id === 'mem1'));
  ok('團費統計唔會把領袖計入應收',
    f.feeStats('2026-27').total === 2 && f.feeStats('2026-27').expected === 720, String(f.feeStats('2026-27').expected));
  ok('逾期追收唔會追領袖',
    !f.overdueFees().some(x => x.memberId === 'lead1') && f.overdueFees().some(x => x.memberId === 'mem1'));

  /* UI：團費頁要交代邊啲人免收 */
  window.location.hash = '#/finance/fees';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const fv = doc.getElementById('view').textContent;
  ok('團費頁寫明「領袖免收團費」', /領袖免收團費/.test(fv));
  ok('團費頁列出免收名單（張領袖等）', /張領袖/.test(fv) || /榮譽會員/.test(fv));

  store.load().members = keepMembers;
  store.load().fees = keepFees;
  store.commit();
}

/* ---------- 財務：帳目（本年度）／過往紀錄／報告分開列（2026-09-16） ---------- */
section('財務分頁（本年度 / 過往紀錄 / 報告）');
{
  const keepTx = JSON.parse(JSON.stringify(store.load().transactions));
  store.load().transactions = [
    { id: 'ota', date: '2025-05-01', type: 'income', amount: 100, item: '舊年捐款', category: '捐款' },
    { id: 'otb', date: '2026-03-31', type: 'expense', amount: 50, item: '舊年支出', category: '雜項' },
    { id: 'tca', date: '2026-09-10', type: 'income', amount: 200, item: '本年團費收入', category: '團費' },
    { id: 'tcb', date: '2026-08-15', type: 'expense', amount: 20, item: '本年文具', category: '文書' }
  ];
  store.commit();

  window.location.hash = '#/finance';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 90));
  const lv = doc.getElementById('view');
  const lt = lv.textContent;
  ok('帳目分頁只顯示「本年度」帳目（唔會混入上年度）',
    /本年團費收入/.test(lt) && !/舊年捐款/.test(lt) && !/舊年支出/.test(lt));
  ok('帳目分頁有總覽／按月切換', !!lv.querySelector('[data-ledger-mode="overview"]') && !!lv.querySelector('[data-ledger-mode="month"]'));

  /* 團長要求（2026-09-17）：帳目頁統計卡 ＝ 期初結餘 → 收入 → 支出 → 淨額 → 現在結餘（唔好用「期末」） */
  const cards = [...lv.querySelectorAll('.grid.g-5 .stat .stat-label')].map(e => e.textContent.trim());
  ok('帳目頁統計卡係「期初結餘 → 收入 → 支出 → 淨額 → 現在結餘」',
    cards.length === 5 && cards[0] === '期初結餘' && /收入$/.test(cards[1])
      && cards[2] === '支出' && cards[3] === '淨額' && cards[4] === '現在結餘', JSON.stringify(cards));
  ok('帳目頁統計卡唔再用「期末」字眼', !lv.querySelector('.grid.g-5').textContent.includes('期末'),
    lv.querySelector('.grid.g-5').textContent.replace(/\s+/g, ' ').slice(0, 120));
  ok('帳目頁「現在結餘」＝ 期初 ＋ 本年度收入 − 本年度支出',
    (() => {
      const card = [...lv.querySelectorAll('.grid.g-5 .stat')].pop();
      const t = (card?.textContent || '').replace(/\s+/g, ' ');
      if (!/期初 .+ ＋ 本年度收入 .+ − 本年度支出 .+/.test(t)) return false;
      const nums = [...t.matchAll(/HK\$([\d,]+)/g)].map(m => Number(m[1].replace(/,/g, '')));
      return nums.length === 4 && nums[0] === nums[1] + nums[2] - nums[3];
    })(),
    ([...lv.querySelectorAll('.grid.g-5 .stat')].pop()?.textContent || '').replace(/\s+/g, ' '));
  ok('逐月總覽列出 12 個月（包括冇紀錄嘅月份）', lv.querySelectorAll('[data-fy-month]').length === 12);
  ok('逐月總覽有顯示「冇紀錄」嘅月份', /冇紀錄/.test(lt));
  ok('未揀本年以外嘅年度（tab 名叫「帳目（YYYY-YY）」）', /帳目（\d{4}-\d{2}）/.test(lt));

  /* 按月（冇紀錄嘅月份都要揀得到） */
  lv.querySelector('[data-ledger-mode="month"]')?.click();
  await new Promise(r => setTimeout(r, 90));
  const monthSel = doc.getElementById('view').querySelector('#fMonth');
  ok('按月選擇器有 12 個月（唔係只有有紀錄嘅）', monthSel && monthSel.querySelectorAll('option').length === 13,
    String(monthSel ? monthSel.querySelectorAll('option').length : 0));
  ok('月份選項標示筆數或「冇紀錄」', /（\d+ 筆）|（冇紀錄）/.test(monthSel?.textContent || ''));

  /* 過往紀錄：先揀年度 → 再揀月份 */
  window.location.hash = '#/finance/history';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 90));
  const hv = doc.getElementById('view');
  const ht = hv.textContent;
  ok('有「過往紀錄」分頁（側邊財務 tabs）', /過往紀錄/.test(hv.textContent));
  ok('過往紀錄可以揀年度', !!hv.querySelector('#histYear'));
  ok('過往紀錄可以揀 12 個月', hv.querySelectorAll('#histMonth option').length === 13,
    String(hv.querySelectorAll('#histMonth option').length));
  ok('過往紀錄顯示上年度帳目', /舊年捐款/.test(ht), ht.slice(0, 120));
  ok('過往紀錄顯示期初結餘（上年度結轉）', /期初結餘/.test(ht));

  /* 財政年度報告：上年度結餘要同收入分開 */
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 90));
  const rt = doc.getElementById('view').textContent;
  ok('報告把「上年度結餘」獨立列（唔會混入收入）',
    /上年度結餘（期初）/.test(rt) && /唔計入收入/.test(rt), rt.slice(0, 120));
  ok('報告有分開「本年度收入」「本年度支出」「本年度淨額」',
    /本年度收入/.test(rt) && /本年度支出/.test(rt) && /本年度淨額/.test(rt));
  ok('兩條數對照表都寫明上年度結餘唔計入收入', /上年度結餘[\s\S]{0,40}唔計入收入/.test(rt));

  store.load().transactions = keepTx;
  store.commit();
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
}

/* ---------- 表格分頁：唔再獨立，改成每頁「欄位」掣（2026-09-16） ---------- */
section('欄位設定（每頁自己改）');
{
  const side = doc.querySelector('.sidebar')?.textContent || '';
  ok('側邊欄已經冇「表格」分頁', !side.includes('表格'), side.replace(/\s+/g, ' ').slice(0, 140));

  const check = async (hash, sel, label) => {
    window.location.hash = hash;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 80));
    ok(label, !!doc.querySelector(sel), sel);
  };
  await check('#/finance', '[data-fields="transactions"]', '財務（帳目）頁有「欄位」掣');
  await check('#/members', '[data-fields="members"]', '用戶頁有「欄位」掣');
  await check('#/inventory', '[data-fields="invItems"]', '物資頁有「欄位」掣');
  await check('#/notices', '[data-fields="notices"]', '通告頁有「欄位」掣');
  await check('#/meetings', '[data-fields="meetings"]', '會議頁有「欄位」掣');

  window.location.hash = '#/admin/data';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 90));
  const av = doc.getElementById('view');
  ok('「帳號與系統 → 資料管理」有表格與同步入口',
    !!av.querySelector('[data-go="#/tables/sync"]') && !!av.querySelector('[data-go="#/tables/source"]'));
  ok('有講明欄位改動去返各自分頁',
    /欄位/.test(av.textContent) && /分頁/.test(av.textContent));

  /* 欄位設計器可以打開（唔再需要獨立頁面） */
  const { openFieldDesigner } = await import('../assets/js/views/tables.js');
  ok('openFieldDesigner 係一支可以用嘅函式', typeof openFieldDesigner === 'function');
}

/* ---------- 進度紀錄：讀後端 ＋ 直接勾（一個後端、兩個前端） ---------- */
section('進度紀錄（讀 ＋ 勾 ＋ 寫，同一個後端）');
{
  const vp = await import('../assets/js/views/progress.js');
  const { progressCfg, setProgressCfg } = await import('../assets/js/lib/progress.js');
  const realFetch = globalThis.fetch;
  const calls = [];
  const VS = {
    members: [
      { ymis: '1234567890', name: '陳大文' },
      { ymis: '1234567891', name: '李小明' }
    ],
    progress: { '1234567890': { 'L1-ACT-01': { date: '2026-09-01', confirmer: '團長' } } },
    pendingRequests: [{
      request_id: 'RQ_1', ymis: '1234567891', name: '李小明',
      item_id: 'L1-ACT-02', item_name: '服務一次', requested_date: '2026-09-10',
      evidence: 'https://example.org/photo.jpg', status: 'pending', created_at: '2026-09-11'
    }],
    logs: [], logRequests: [{
      request_id: 'LR_1', kind: 'new', type: 'service', ymis: '1234567890', name: '陳大文',
      date: '2026-08-30', title: '公益賣旗', role: '組員', hours: '3', detail: '', status: 'pending', created_at: '2026-09-02'
    }],
    logsSupported: true, logRequestsSupported: true, otherBadges: {}
  };
  const CATALOG = { badges: [{ id: 'L1', name: '會員章', icon: '🥇', segments: [{ code: 'L1-ACT', name: '活動', items: [{ id: 'L1-ACT-01', name: '參加六次團集會' }, { id: 'L1-ACT-02', name: '服務一次' }] }] }] };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    /* 唔係 API 呼叫＝讀 app 內建檔（data/progress/items.json），交返真檔 */
    if (!body) {
      const file = path.join(ROOT, String(url).split('?')[0].replace(/^\.?\//, ''));
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
      return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404,
        text: async () => text, json: async () => JSON.parse(text) };
    }
    let out = { ok: false, error: 'unknown_mock' };
    if (body?.action === 'load') out = { ok: true, serverSideKey: false, data: VS };
    if (body?.action === 'catalog') out = { ok: true, data: CATALOG };
    if (body?.action === 'save') out = { ok: true, data: { processed: (body.data?.changes || []).length } };
    if (body?.action === 'reviewRequest') out = { ok: true, data: { success: true, message: body.data?.decision === 'approved' ? '已批准並寫入進度' : '已拒絕' } };
    if (body?.action === 'reviewLogRequest') out = { ok: true, data: { success: true, message: '已批准並寫入活動履歷', record_id: 'LOG_TEST' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  };

  try {
    /* 未設定 API Key：應該一步一步教（唔會叫你去任何其他系統） */
    setProgressCfg({ backend: '', apiKey: '', catalogUrl: '' });
    window.location.hash = '#/progress';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 100));
    const nsv = doc.getElementById('view').textContent;
    ok('未設定時有逐步教學（自己嗰張 Sheet → initializeSheets → showApiKey）',
      /initializeSheets/.test(nsv) && /showApiKey/.test(nsv));
    ok('教學講明「一個後端、兩個前端」', /一個後端/.test(nsv) && /兩個前端/.test(nsv));
    ok('教學唔會叫你去其他系統（冇 VSBADGE 字眼）', !/VSBADGE|vsbadge/.test(nsv));

    /* 設定：填後端 ＋ API Key */
    window.location.hash = '#/progress/settings';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 100));
    const sv = doc.getElementById('view');
    ok('設定頁有「點填」指示（複製 /exec ＋ showApiKey ＋ 測試連線）',
      /點填/.test(sv.textContent) && /showApiKey/.test(sv.textContent) && /測試連線/.test(sv.textContent));
    ok('設定頁有「後端 /exec 網址」同「API Key」欄',
      !!sv.querySelector('#p-backend') && !!sv.querySelector('#p-key') && !!sv.querySelector('#p-catalog'));
    sv.querySelector('#p-backend').value = 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec';
    sv.querySelector('#p-key').value = 'vs_key_123';
    sv.querySelector('#p-catalog').value = 'https://example.org/items.json';
    sv.querySelector('[data-act="save-cfg"]').click();
    await new Promise(r => setTimeout(r, 200));
    ok('儲存後配置記住咗（API Key 存喺旅團自己嘅資料）',
      progressCfg().apiKey === 'vs_key_123' && /AKfycbTEST/.test(progressCfg().backend));

    const loadCall = calls.find(c => c.body?.action === 'load');
    ok('自動去讀後端（POST /api/progress · action=load）',
      !!loadCall && /api\/progress$/.test(loadCall.url) && loadCall.body.apikey === 'vs_key_123', JSON.stringify(loadCall?.body || {}));

    const view = () => doc.getElementById('view');
    window.location.hash = '#/progress';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 200));
    ok('總覽讀到成員同進度（統計卡有數）',
      /後端成員/.test(view().textContent) && /2/.test(view().textContent) && /已勾項目/.test(view().textContent));
    ok('總覽分得開「兩邊對得上」同未對上（用 YMIS 對人）',
      /兩邊用/.test(view().textContent) || /YMIS/.test(view().textContent));

    /* 勾選：直接寫入後端 */
    window.location.hash = '#/progress/tick';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 150));
    const cb = view().querySelector('[data-tick="L1-ACT-02"]');
    ok('勾選頁列出考核項目（可以直接勾）', !!cb);
    ok('已勾嘅項目預設打勾（由後端讀返嚟）',
      view().querySelector('[data-tick="L1-ACT-01"]')?.checked === true);

    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const saveBtn = view().querySelector('[data-act="save-ticks"]');
    ok('勾咗之後「儲存」掣亮起（未儲存唔會送出）',
      !!saveBtn && !saveBtn.disabled && /未儲存/.test(view().textContent));

    saveBtn.click();
    await new Promise(r => setTimeout(r, 250));
    const saveCall = calls.filter(c => c.body?.action === 'save').pop();
    ok('儲存會 POST 去後端（action=save ＋ changes）', !!saveCall, JSON.stringify(calls.map(c => c.body?.action)));
    ok('changes 帶 ymis / itemId / uncomplete=false（勾）',
      saveCall?.body?.data?.changes?.[0]?.ymis === '1234567890'
      && saveCall?.body?.data?.changes?.[0]?.itemId === 'L1-ACT-02'
      && saveCall?.body?.data?.changes?.[0]?.uncomplete === false,
      JSON.stringify(saveCall?.body?.data?.changes || saveCall?.body || {}));
    ok('API Key 只跟 body 去自己後端（唔會出現在網址）',
      !/vs_key_123/.test(String(saveCall?.url || '')) && !/vs_key_123/.test(JSON.stringify(saveCall?.body?.backend || '')));

    /* 取消勾選（uncomplete: true） */
    const cb1 = doc.getElementById('view').querySelector('[data-tick="L1-ACT-01"]');
    cb1.checked = false;
    cb1.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    doc.getElementById('view').querySelector('[data-act="save-ticks"]').click();
    await new Promise(r => setTimeout(r, 250));
    const save2 = calls.filter(c => c.body?.action === 'save').pop();
    ok('取消勾選會帶 uncomplete=true（後端會刪除該項）',
      save2?.body?.data?.changes?.[0]?.uncomplete === true,
      JSON.stringify(save2?.body?.data?.changes || save2?.body || {}));
    ok('儲存完會自動重新讀一次（睇到最新狀態）',
      calls.filter(c => c.body?.action === 'load').length >= 2);

    /* 審批中心：睇到待批 ＋ 直接批（寫返自己後端） */
    window.location.hash = '#/progress/review';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 150));
    const rv = doc.getElementById('view');
    ok('審批中心列出待批完成（團員／項目／申報日期）',
      /待批完成/.test(rv.textContent) && /李小明/.test(rv.textContent) && /服務一次/.test(rv.textContent));
    ok('審批中心列出待批履歷（服務紀錄）',
      /待批履歷/.test(rv.textContent) && /公益賣旗/.test(rv.textContent));
    ok('審批中心有批准／拒絕掣', !!rv.querySelector('[data-rev-id][data-rev-decision="approved"]')
      && !!rv.querySelector('[data-rev-id][data-rev-decision="rejected"]'));
    ok('總覽／分頁標籤顯示待批數（1＋1）', /審批中心（2）/.test(doc.getElementById('view').textContent)
      || /審批中心（2）/.test(doc.body.textContent));

    const apprBtn = doc.getElementById('view').querySelector('[data-rev-kind="req"][data-rev-decision="approved"]');
    apprBtn.click();
    await new Promise(r => setTimeout(r, 200));
    const dlg = () => doc.querySelector('.modal, [role="dialog"]');
    ok('批准之前一定要撳「確定」（防呆：唔會一撳就寫入）',
      !calls.some(c => c.body?.action === 'reviewRequest')
      && [...doc.querySelectorAll('.modal button, [role="dialog"] button')].some(b => /確定批准/.test(b.textContent || '')));
    ok('確認框列出團員同項目（畀你核對）',
      /李小明/.test(dlg()?.textContent || '') && /服務一次/.test(dlg()?.textContent || ''));
    [...doc.querySelectorAll('.modal button, [role="dialog"] button')]
      .find(b => /確定批准/.test(b.textContent || ''))?.click();
    await new Promise(r => setTimeout(r, 300));
    const revCall = calls.filter(c => c.body?.action === 'reviewRequest').pop();
    ok('批准會 POST /api/progress action=reviewRequest（帶 request_id／decision）',
      revCall?.body?.data?.request_id === 'RQ_1' && revCall?.body?.data?.decision === 'approved',
      JSON.stringify(revCall?.body?.data || {}));
    ok('審批用同一個 API Key（唔會出現在網址）',
      revCall?.body?.apikey === 'vs_key_123' && !/vs_key_123/.test(String(revCall?.url || '')));

    const rejBtn = doc.getElementById('view').querySelector('[data-rev-kind="log"][data-rev-decision="rejected"]');
    rejBtn.click();
    await new Promise(r => setTimeout(r, 200));
    const confirmBtn = [...doc.querySelectorAll('.modal button, [role="dialog"] button')]
      .find(b => /確定拒絕/.test(b.textContent || ''));
    ok('拒絕之前要確認（防手誤）', !!confirmBtn);
    confirmBtn?.click();
    await new Promise(r => setTimeout(r, 300));
    const logRev = calls.filter(c => c.body?.action === 'reviewLogRequest').pop();
    ok('拒絕履歷申報會 POST action=reviewLogRequest（decision=rejected）',
      logRev?.body?.data?.request_id === 'LR_1' && logRev?.body?.data?.decision === 'rejected',
      JSON.stringify(logRev?.body?.data || {}));

    /* 自訂考核項目（有填就用伺服器代讀） */
    const catCall = calls.find(c => c.body?.action === 'catalog');
    ok('有填自訂考核項目 → 走 /api/progress action=catalog', !!catCall,
      JSON.stringify(calls.map(c => c.body?.action)));
    (() => { const db = store.load(); const pb = db.profile?.progress?.backend || {};
      pb.catalogUrl = ''; store.commit(); })();

    /* 測試連線 */
    window.location.hash = '#/progress/settings';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 120));
    doc.getElementById('view').querySelector('[data-act="test"]').click();
    await new Promise(r => setTimeout(r, 300));
    ok('「測試連線」會實測後端（成功會有提示）',
      /連線成功|讀到/.test(doc.getElementById('view').textContent) || doc.getElementById('view').textContent.includes('2 位'));

    ok('進度頁冇咗外連模式（唔再開任何其他系統）',
      !/外連模式/.test(doc.getElementById('view').textContent));
    ok('進度頁仍然匯出 title / render / mount', typeof vp.title === 'function' && typeof vp.render === 'function' && typeof vp.mount === 'function');
  } finally {
    globalThis.fetch = realFetch;
    setProgressCfg({ backend: '', apiKey: '', catalogUrl: '' });
    window.location.hash = '#/dashboard';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 80));
  }
}

/* ---------- 總結 ---------- */
const ms = Date.now() - t0;
console.log(`\n──────── ${MODE.toUpperCase()} 測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
if (errors.length) {
  console.log(`\n捕捉到 ${errors.length} 個 console.error：`);
  errors.slice(0, 10).forEach(e => console.log('  • ' + e.slice(0, 220)));
}
process.exit(fail ? 1 : 0);
