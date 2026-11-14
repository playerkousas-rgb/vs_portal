/* Finance authorization regressions: direct routes, stale DOM handlers, imports, and global settings. */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><main id="root"></main></body>', {
  url: 'https://example.test/?u=0099#/finance', pretendToBeVisual: true
});
const { window } = dom;
window.scrollTo = () => {};
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
  'CustomEvent', 'Event', 'MouseEvent', 'Node', 'File', 'Blob', 'URL', 'URLSearchParams']) {
  if (window[k] === undefined) continue;
  Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
}
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* jsdom */ }
// This suite starts from the store's safe blank database; no static seed/network is needed.
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const store = await import('../assets/js/lib/store.js');
const auth = await import('../assets/js/lib/auth.js');
const finance = await import('../assets/js/views/finance.js');
await store.init({ unit: '0099' });

const db = store.load();
db.profile = { ...(db.profile || {}), name: '權限測試旅團' };
db.settings = {
  ...(db.settings || {}), scoutFYStartMonth: 4, scoutFYStartDay: 1,
  openingBalance: 0, openingBalances: { '2026-27': 1000 }, feePerYear: 360
};
db.transactions = [
  { id: 'tx-own', date: '2026-09-01', type: 'income', amount: 100, item: '自己建立', createdBy: 'exco-a' },
  { id: 'tx-other', date: '2026-09-02', type: 'expense', amount: 40, item: '領袖建立', createdBy: 'leader-a' }
];
db.reference = {
  openingBalance: 8800, sheetLabel: '舊帳', check: { closing: 8900 },
  transactions: [{ id: 'ref-1', date: '2025-12-01', type: 'income', amount: 100, item: '舊帳收入', period: '2025-26' }]
};
store.commitMeta();

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? `  → ${extra}` : '')); }
}
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const root = document.getElementById('root');
function session(role, username = `${role}-a`) {
  store.setSession({ role, username, name: username, accountId: `member:${username}`, at: Date.now(), via: 'legacy-local-test' });
}
function show(params) {
  root.innerHTML = finance.render({ query: {}, ...params });
  return root;
}
function closeTopModal() {
  const overlay = document.querySelector('.overlay');
  overlay?.querySelector('[data-act="0"]')?.click();
}

console.log('\n▌Finance 多身份授權迴歸');

session('exco', 'exco-a');
ok('執委 finance.edit 只適用自己建立嘅帳目',
  auth.can('finance.edit', db.transactions[0]) && !auth.can('finance.edit', db.transactions[1]) && !auth.can('finance.edit'));
ok('執委直接開自己帳目編輯網址會有表單',
  !!show({ id: 'edit', action: 'tx-own' }).querySelector('[data-act="save-tx"]'));
ok('執委直接開別人帳目編輯網址會 fail closed',
  !show({ id: 'edit', action: 'tx-other' }).querySelector('[data-act="save-tx"]') && /冇權限/.test(root.textContent));
ok('執委可以直接開新增帳目網址',
  !!show({ id: 'new', action: '' }).querySelector('[data-act="save-tx"]'));

show({ id: 'ledger', action: '' });
ok('執委帳目清單只顯示自己嗰筆嘅編輯掣，而且冇刪除掣',
  !!root.querySelector('[data-edit="tx-own"]') && !root.querySelector('[data-edit="tx-other"]') && !root.querySelector('[data-del]'));

db.transactions.push({ id: 'tx-nonfinite', date: '2026-09-03', type: 'income', amount: '1e309',
  item: '非有限金額', category: '邊界', createdBy: 'exco-a' });
show({ id: 'ledger', action: '' });
const categoryWidths = [...root.querySelectorAll('.bar > span')].map(el => el.getAttribute('style') || '');
ok('財務分類 bar 將非有限／越界比例夾返安全百分比',
  categoryWidths.length > 0 && categoryWidths.every(style => /^width:(?:100|\d{1,2}(?:\.\d+)?)%$/.test(style)),
  JSON.stringify(categoryWidths));
db.transactions = db.transactions.filter(t => t.id !== 'tx-nonfinite');

for (const [role, username] of [['leader', 'leader-a'], ['chief', 'chief-a'], ['super', '']]) {
  session(role, username);
  const editAllowed = !!show({ id: 'edit', action: 'tx-other' }).querySelector('[data-act="save-tx"]');
  const settingsAllowed = !!show({ id: 'settings', action: '' }).querySelector('[data-act="save-settings-page"]');
  ok(`${role} 可以編輯其他人帳目同全團財務設定`, editAllowed && settingsAllowed);
}

session('exco', 'exco-a');
window.location.hash = '#/finance/settings';
show({ id: 'settings', action: '' });
ok('執委設定頁係唯讀，冇年度輸入或儲存掣',
  !root.querySelector('[data-open-year]') && !root.querySelector('[data-act="save-settings-page"]')
    && /設定摘要（唯讀）/.test(root.textContent));
ok('執委仍可使用交易匯入工具，但唔等於可改全團設定',
  !!root.querySelector('#imp-text') && !!root.querySelector('[data-act="do-import"]'));

// The QR is now only an authenticated member-login route. No role can configure an
// anonymous collection destination from this dialog.
const entrySettingsBefore = JSON.stringify(db.settings?.publicEntry || {});
const syncSettingsBefore = JSON.stringify(db.sync || {});
let shareDialog = finance.entryShareDialog();
await wait();
let overlay = document.querySelector('.overlay');
const excoHubUrl = overlay?.querySelector('input[readonly]')?.value || '';
ok('執委可以分享 authenticated 團員入口 QR，而且沒有匿名送出目的地設定',
  !!overlay?.querySelector('.qr-box') && /members\.html/.test(excoHubUrl)
    && !overlay?.querySelector('#es-submit') && !overlay?.querySelector('[data-act="1"]'),
  JSON.stringify({ overlay: !!overlay, qrBox: !!overlay?.querySelector('.qr-box'),
    url: excoHubUrl, save: !!overlay?.querySelector('[data-act="1"]'), role: auth.current()?.role }));
overlay?.querySelector('[data-act="0"]')?.click();
await shareDialog;
await wait();

session('leader', 'leader-a');
shareDialog = finance.entryShareDialog();
await wait();
overlay = document.querySelector('.overlay');
const leaderHubUrl = overlay?.querySelector('input[readonly]')?.value || '';
ok('領袖見到同一條 session-gated hub，亦無權復活 publicEntry／改送出網址',
  /members\.html/.test(leaderHubUrl) && !overlay?.querySelector('#es-submit')
    && !overlay?.querySelector('#es-samelink') && !overlay?.querySelector('[data-act="1"]'));
overlay?.querySelector('[data-act="0"]')?.click();
await shareDialog;
await wait();
ok('分享登入 QR 不會改 publicEntry 或同步設定',
  JSON.stringify(db.settings?.publicEntry || {}) === entrySettingsBefore
    && JSON.stringify(db.sync || {}) === syncSettingsBefore);

// A form rendered while authorized must not mutate after the active role changes.
session('exco', 'exco-a');
show({ id: 'edit', action: 'tx-own' });
finance.mount(root, { id: 'edit', action: 'tx-own', query: {} });
root.querySelector('#t-item').value = '不應寫入';
session('exco', 'exco-b');
root.querySelector('[data-act="save-tx"]').click();
await wait();
ok('帳目 save handler 會重新核對目前身份，舊表單唔可越權寫入',
  store.find('transactions', 'tx-own').item === '自己建立', store.find('transactions', 'tx-own').item);

session('exco', 'exco-a');
show({ id: 'new', action: '' });
finance.mount(root, { id: 'new', action: '', query: {} });
root.querySelector('#t-item').value = '不應新增';
root.querySelector('#t-amount').value = '99';
const txCount = db.transactions.length;
session('member', 'member-a');
root.querySelector('[data-act="save-tx"]').click();
await wait();
ok('新增 handler 同樣 fail closed，角色轉低後唔會靠 stale DOM 新增', db.transactions.length === txCount);

session('leader', 'leader-a');
window.location.hash = '#/finance/settings';
show({ id: 'settings', action: '' });
finance.mount(root, { id: 'settings', action: '', query: {} });
const settingsBefore = JSON.stringify(db.settings);
const currentOpening = root.querySelector('[data-open-year="2026-27"]');
if (currentOpening) currentOpening.value = '999999';
session('exco', 'exco-a');
root.querySelector('[data-act="save-settings-page"]').click();
await wait();
ok('全團設定 save handler 重新核權，執委唔可提交領袖遺留表單', JSON.stringify(db.settings) === settingsBefore);

// Crafted/stale controls for the other Finance mutation families must also fail closed.
db.members.push({ id: 'member-fee', name: '團費測試員', identity: 'member', status: 'active' });
db.fees.push({ id: 'fee-stale', memberId: 'member-fee', period: '2026-27', label: '2026-27 團費',
  amount: 360, due: '2026-09-30', paid: false });
session('exco', 'exco-a');
show({ id: 'fees', action: '', query: { period: '2026-27' } });
finance.mount(root, { id: 'fees', action: '', query: { period: '2026-27' } });
const staleFeeButton = root.querySelector('[data-mark="fee-stale"]');
session('member', 'member-a');
staleFeeButton?.click();
await wait();
ok('團費 stale handler 重新核權，角色轉低後唔會標記收款或彈可提交 modal',
  !!staleFeeButton && store.find('fees', 'fee-stale')?.paid === false && !document.querySelector('.overlay'));

const budgetCount = db.budgets.length;
session('leader', 'leader-a');
show({ id: 'budgets', action: '' });
finance.mount(root, { id: 'budgets', action: '', query: {} });
const staleBudgetButton = root.querySelector('[data-act="new-budget"]');
session('exco', 'exco-a');
staleBudgetButton?.click();
await wait();
ok('活動預算 stale handler 用全域 finance.edit 重新核權，執委唔可開提交 modal',
  !!staleBudgetButton && db.budgets.length === budgetCount && !document.querySelector('.overlay'));

db.claims.push({ id: 'claim-stale', date: '2026-09-08', type: 'expense', category: '活動',
  item: '待批申報', amount: 88, byName: '申報人', requestedBy: 'exco-a', status: 'pending' });
const claimTxCount = db.transactions.length;
session('exco', 'exco-a');
show({ id: 'claims', action: '' });
finance.mount(root, { id: 'claims', action: '', query: {} });
const staleClaimButton = root.querySelector('[data-claim="approve"][data-id="claim-stale"]');
session('member', 'member-a');
staleClaimButton?.click();
await wait();
ok('申報批准 stale handler 重新核權，角色轉低後唔會入帳或改狀態',
  !!staleClaimButton && store.find('claims', 'claim-stale')?.status === 'pending'
    && db.transactions.length === claimTxCount);

// CSV preview: exco may import transactions, but annual opening controls must not exist.
const openingCsv = [
  '時間戳記,日期,收入或支出,收入項目,支出項目,收入,支出,結餘',
  ',2025/10/11,支出,,場地,,100,8700',
  ',,,上年度結餘,,8800,,'
].join('\n');
ok('測試匯入資料確實帶期初結餘', finance.parsePasted(openingCsv).openingBalance === 8800);

session('exco', 'exco-a');
window.location.hash = '#/finance/import';
show({ id: 'import', action: '' });
finance.mount(root, { id: 'import', action: '', query: {} });
root.querySelector('#imp-text').value = openingCsv;
root.querySelector('[data-act="do-import"]').click();
ok('執委匯入預覽只可新增交易，唔會取得年度期初 checkbox',
  !root.querySelector('#imp-open') && /冇修改年度設定權限/.test(root.textContent));

session('leader', 'leader-a');
show({ id: 'import', action: '' });
finance.mount(root, { id: 'import', action: '', query: {} });
root.querySelector('#imp-text').value = openingCsv;
root.querySelector('[data-act="do-import"]').click();
ok('領袖匯入預覽可以選擇寫入對應年度期初', !!root.querySelector('#imp-open'));

// The older bundled reference-ledger path follows the same rule.
session('exco', 'exco-a');
show({ id: 'settings', action: '' });
finance.mount(root, { id: 'settings', action: '', query: {} });
root.querySelector('[data-act="import-ref"]').click();
await wait();
overlay = document.querySelector('.overlay');
ok('執委舊帳參考匯入 modal 冇期初／結轉控制',
  !!overlay && !overlay.querySelector('#ir-open') && !overlay.querySelector('#ir-carry')
    && /只會匯入帳目/.test(overlay.textContent));
closeTopModal();
await wait();

session('leader', 'leader-a');
show({ id: 'settings', action: '' });
finance.mount(root, { id: 'settings', action: '', query: {} });
root.querySelector('[data-act="import-ref"]').click();
await wait();
overlay = document.querySelector('.overlay');
ok('領袖舊帳參考匯入 modal 先有期初／結轉控制',
  !!overlay?.querySelector('#ir-open') && !!overlay?.querySelector('#ir-carry'));
closeTopModal();
await wait();

store.setSession(null);
console.log(`\n${fail === 0 ? '✅' : '❌'} Finance 授權：${pass} 過 / ${fail} 唔過`);
process.exit(fail === 0 ? 0 : 1);
