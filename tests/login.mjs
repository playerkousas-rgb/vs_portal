/* ============================================================
   tests/login.mjs — 登入流程測試（純 Node，唔使 jsdom）
   ------------------------------------------------------------
   2026-09-18 團長回報兩件事：
     ① 「開咗新領袖用戶、有電郵有密碼，但登入唔到」
        → 名冊領袖（用戶頁加嘅）而家可以用電郵＋入口密碼由「領袖」入口入
     ② 團員／執委正式入口唔可以再靠瀏覽器本機名冊核對密碼
        → 一律交 GAS authLogin，成功先保存有 expiry 嘅 opaque session
   驗證：
     - 名冊領袖本機 helper：電郵門（大小寫唔拘）、錯密碼拒絕、首次密碼強制改
     - 正式團員／執委入口：GAS 拒絕就 fail closed；成功保存 token／expiry／可信身份
     - 舊路線（accounts 帳戶） helper 一樣行得：開戶、登入、改自己密碼
     - 所有 session reader 都清走過期／畸形 server session
   ============================================================ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- Node 環境 shim（等 store/auth 當自己喺瀏覽器度行） ---------- */
globalThis.window = globalThis;                     // auth.js 用 window.crypto.subtle
globalThis.location = new URL('http://localhost:8080/?u=0082');
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const section = t => console.log('\n▌' + t);

/* ---------- 開機 ----------
   ★ 2026-09-24：示範（MOCK）模式已經拆走。呢個測試自己會 store.add('members', …)
     建測試用嘅人，唔需要任何種子資料 —— 所以用一個真實旅團編號（0082）就得。 */
const store = await import('../assets/js/lib/store.js');
const auth = await import('../assets/js/lib/auth.js');
await store.init({ unit: '0082' });
ok('store 初始化完成', store.ready() && String(store.currentUnit()) === '0082', String(store.currentUnit()));

/* ============================================================ */
section('1. 名冊領袖：用戶頁加嘅領袖用電郵＋入口密碼登入（團長回報嘅死路）');
const leader = store.add('members', {
  name: '測試領袖', identity: 'leader', email: 'Leader@Test.com', status: 'active', ymis: ''
});
const set1 = await auth.setMemberHubPassword(leader.id, 'abcd1234');
ok('喺用戶頁路線設定到入口密碼', set1.ok, set1.msg || '');

const bad1 = await auth.login('staff', 'leader@test.com', 'wrongpw');
ok('錯密碼被拒', !bad1.ok, JSON.stringify(bad1));

const ok1 = await auth.login('staff', 'leader@test.com', 'abcd1234');
ok('電郵（細寫）＋密碼＝登入成功', ok1.ok === true && ok1.role === 'leader', JSON.stringify(ok1));
ok('Session 指向名冊紀錄', String(auth.current()?.accountId || '').startsWith('member:'), JSON.stringify(auth.current()));
ok('Session 帶電郵同名', auth.current()?.email === 'Leader@Test.com' && auth.current()?.name === '測試領袖', JSON.stringify(auth.current()));

const ok2 = await auth.login('staff', 'LEADER@TEST.COM', 'abcd1234');
ok('電郵（大寫）都入到', ok2.ok === true, JSON.stringify(ok2));

const noEmail = await auth.login('staff', 'nobody@test.com', 'abcd1234');
ok('電郵對不上任何領袖＝一般錯誤訊息', !noEmail.ok && /不正確/.test(noEmail.msg), JSON.stringify(noEmail));

const noPwLeader = store.add('members', {
  name: '未設密碼領袖', identity: 'leader', email: 'nopw@test.com', status: 'active', ymis: ''
});
const r3 = await auth.login('staff', 'nopw@test.com', '1234');
ok('領袖未設密碼：有明確提示（唔係一句「不正確」就算）', !r3.ok && /未設定密碼/.test(r3.msg || ''), JSON.stringify(r3));

/* ============================================================ */
section('2. 名冊領袖：首次密碼 1234 → 強制改 → 新密碼生效');
const leader2 = store.add('members', {
  name: '測試領袖二', identity: 'leader', email: 'leader2@test.com', status: 'active', ymis: ''
});
await auth.setMemberHubPassword(leader2.id, '1234');           // 開戶路線：預設 1234
const f1 = await auth.login('staff', 'leader2@test.com', '1234');
ok('1234 入到，但要強制改密碼', f1.ok === true && f1.mustChangePw === true, JSON.stringify(f1));

const ch1 = await auth.changeOwnPassword('', 'newpass9');       // 首登唔使填舊密碼
ok('名冊領袖路線改到自己密碼', ch1.ok === true, JSON.stringify(ch1));
const f2 = await auth.login('staff', 'leader2@test.com', '1234');
ok('改完之後 1234 唔再入到', !f2.ok, JSON.stringify(f2));
const f3 = await auth.login('staff', 'leader2@test.com', 'newpass9');
ok('新密碼入到', f3.ok === true && f3.mustChangePw !== true, JSON.stringify(f3));

/* ============================================================ */
section('3. 團員／執委入口：密碼只由 GAS 核對，成功必須取得短期 server session');
const browserFetch = globalThis.fetch;
const loginCalls = [];
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).includes('api/proxy')) return browserFetch(url, init);
  const body = JSON.parse(init.body || '{}');
  loginCalls.push(body);
  const expires = Date.now() + 8 * 3600 * 1000;
  let response;
  if (body.action === 'authChangePassword') {
    const valid = body.sessionToken === 'opaque-exco-session' && body.oldPassword === '1234' && body.newPassword === 'newpass8';
    response = valid
      ? { ok: true, success: true, sessionToken: 'opaque-exco-session-2', sessionExpiresAt: expires }
      : { ok: false, success: false, error: '目前密碼不正確' };
  } else if (body.action !== 'authLogin' || body.password !== '1234') {
    response = { ok: false, success: false, error: '帳號或密碼不正確' };
  } else {
    const isExco = body.ymis === '1000000888';
    response = {
      ok: true, success: true, mustChangePw: true,
      sessionToken: isExco ? 'opaque-exco-session' : 'opaque-member-session', sessionExpiresAt: expires,
      account: {
        id: isExco ? 'm-exco' : 'm-member', memberId: isExco ? 'm-exco' : 'm-member',
        username: body.ymis, ymis: body.ymis, name: isExco ? '測試執委' : '測試團員',
        role: isExco ? 'exco' : 'member', kind: 'member'
      }
    };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(response), json: async () => response };
};

const wrong = await auth.loginMember('1000000999', '9999');
ok('錯密碼由後端拒絕，唔會跌返本機名冊驗證', !wrong.ok && /不正確/.test(wrong.msg || ''), JSON.stringify(wrong));
const m1 = await auth.loginMember('1000000999', '1234');
ok('團員由 GAS 登入成功並強制改首次密碼', m1.ok === true && m1.mustChangePw === true && m1.dest === 'hub', JSON.stringify(m1));
ok('團員 session 保存 opaque token、expiry 同可信 YMIS',
  auth.current()?.sessionToken === 'opaque-member-session' && auth.current()?.ymis === '1000000999'
    && auth.current()?.sessionExpiresAt > Date.now(), JSON.stringify(auth.current()));

const e1 = await auth.loginMember('1000000888', '1234');
ok('執委由 server 身份決定進管理系統（唔信登入頁自報角色）',
  e1.ok === true && e1.dest === 'staff' && e1.role === 'exco' && auth.currentRole() === 'exco', JSON.stringify(e1));
ok('authLogin 請求只傳憑證，身份結果由後端 account 回覆',
  loginCalls.filter(c => c.action === 'authLogin').every(c => c.unit === '0082')
    && loginCalls.filter(c => c.action === 'authLogin').at(-1)?.ymis === '1000000888');
const serverPw = await auth.changeOwnPassword('1234', 'newpass8');
ok('正式一般改密碼由 GAS session 固定本人、核對目前密碼並換新票', serverPw.ok === true
  && loginCalls.some(c => c.action === 'authChangePassword' && c.oldPassword === '1234' && c.newPassword === 'newpass8')
  && auth.current()?.sessionToken === 'opaque-exco-session-2', JSON.stringify(serverPw));
globalThis.fetch = browserFetch;

/* ============================================================ */
section('3b. 未登記旅團：所有支部帳戶流程會由 proxy 404 跌落已設定 /exec');
{
  const directExec = 'http://localhost:9191/branch/exec';
  const oldSync = store.load().sync ? JSON.parse(JSON.stringify(store.load().sync)) : null;
  store.load().sync = { ...(store.load().sync || {}), unit: '0082', url: directExec, apiKey: 'direct-route-key' };
  store.commitMeta();
  const transportCalls = [];
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body), json: async () => body });
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    const call = { url: String(url), body, contentType: init.headers?.['Content-Type'] || '' };
    transportCalls.push(call);
    if (String(url).includes('api/proxy')) {
      return response({ ok: false, success: false, error: '找不到此旅團或後端網址未設定' }, 404);
    }
    if (String(url) !== directExec) return response({ ok: false, error: 'unexpected route' }, 404);
    const expires = Date.now() + 3600_000;
    if (body.action === 'authLogin') return response({ ok: true, success: true,
      sessionToken: 'direct-session-1', sessionExpiresAt: expires,
      account: { id: 'direct-leader', username: 'direct@example.test', email: 'direct@example.test',
        name: '自助領袖', role: 'leader', kind: 'account' } });
    if (body.action === 'authChangePassword') return response({ ok: true, success: true,
      sessionToken: 'direct-session-2', sessionExpiresAt: expires });
    if (body.action === 'verifySetupKey') return response({ ok: true, success: true,
      sessionToken: 'direct-setup-session', sessionExpiresAt: expires });
    if (body.action === 'authForgotPassword') return response({ ok: true, success: true,
      message: '如果電郵已登記，重設連結會寄出。' });
    if (['authCreateAccount', 'authRestoreAccount', 'authResetPassword', 'authDeleteAccount', 'authCompletePasswordReset'].includes(body.action)) {
      return response({ ok: true, success: true });
    }
    return response({ ok: false, success: false, error: '測試略過重新載入' });
  };

  const directLogin = await auth.loginServer('staff', 'direct@example.test', 'direct-pass');
  ok('支部登入先試同源 proxy；未登記後改用 /exec 並取得 opaque session',
    directLogin.ok === true && auth.current()?.sessionToken === 'direct-session-1'
      && transportCalls.some(c => c.url.includes('api/proxy') && c.body.action === 'authLogin')
      && transportCalls.some(c => c.url === directExec && c.body.action === 'authLogin'), JSON.stringify(directLogin));
  const directCreate = await auth.createAccountServer({ role: 'exco', username: 'new@example.test',
    email: 'new@example.test', name: '新人', memberId: 'm-new', password: '1234' });
  const directRestore = await auth.restoreAccountServer({ email: 'old@example.test' });
  const directReset = await auth.resetAccountPasswordServer({ username: 'member@example.test' }, '5678');
  const directDelete = await auth.deleteAccountServer({ username: 'old@example.test' });
  ok('新增／復原／重設／刪除帳戶全部共用 gateway 自助路線',
    [directCreate, directRestore, directReset, directDelete].every(r => r.ok === true)
      && ['authCreateAccount', 'authRestoreAccount', 'authResetPassword', 'authDeleteAccount']
        .every(action => transportCalls.some(c => c.url === directExec && c.body.action === action)));
  const directChanged = await auth.changeOwnPassword('direct-pass', 'direct-new-pass');
  ok('本人改密碼亦經 /exec，成功後換新 session', directChanged.ok === true
    && auth.current()?.sessionToken === 'direct-session-2'
    && transportCalls.some(c => c.url === directExec && c.body.action === 'authChangePassword'));
  const directForgot = await auth.requestPasswordReset('direct@example.test', 'https://portal.example/reset-password.html');
  const directComplete = await auth.completePasswordReset('direct@example.test', '12345678', 'direct-new-pass-2');
  ok('忘記密碼／統一版重設碼完成流程同樣保留自助 /exec fallback', directForgot.ok === true && directComplete.ok === true
    && transportCalls.some(c => c.url === directExec && c.body.action === 'authForgotPassword')
    && transportCalls.some(c => c.url === directExec && c.body.action === 'authCompletePasswordReset'));
  const directBodies = transportCalls.filter(c => c.url === directExec);
  ok('直連只用 text/plain 避免 CORS preflight，並帶本機 routing API Key（不當身份）',
    directBodies.length > 0 && directBodies.every(c => c.contentType.startsWith('text/plain'))
      && directBodies.every(c => c.body.apiKey === 'direct-route-key' && c.body.apikey === 'direct-route-key'));
  const setupLogin = await auth.loginSetupKey('EC72-DIRECT-TEST');
  ok('開團 KEY 驗證亦可經自助 /exec 並取得 setup session', setupLogin.ok === true
    && auth.current()?.sessionToken === 'direct-setup-session'
    && transportCalls.some(c => c.url === directExec && c.body.action === 'verifySetupKey'));

  globalThis.fetch = browserFetch;
  if (oldSync) store.load().sync = oldSync; else delete store.load().sync;
  store.setSession(null);
  store.commitMeta();
}

/* ============================================================ */
section('4. 舊路線（帳號與系統 → 帳戶）唔可以壞');
store.setSession({ role: 'super', accountId: 'super', username: '', name: '超管', at: Date.now() });
const created = await auth.createAccount({ role: 'exco', username: 'testclerk', password: 'secret1', name: '測試書記' });
ok('超管開到執委帳戶', created.ok === true, created.msg || '');
store.setSession(null);
const a1 = await auth.login('staff', 'testclerk', 'secret1');
ok('accounts 帳戶照樣登入', a1.ok === true && String(a1.mustChangePw) !== 'undefined' ? a1.ok : false, JSON.stringify(a1));
ok('Session 指向真正帳戶（唔係 member:）', !String(auth.current()?.accountId || '').startsWith('member:'), JSON.stringify(auth.current()));
const a2 = await auth.changeOwnPassword('secret1', 'secret2');
ok('帳戶路線改自己密碼（要舊密碼）', a2.ok === true, JSON.stringify(a2));
const a3 = await auth.login('staff', 'testclerk', 'secret2');
ok('新密碼生效', a3.ok === true, JSON.stringify(a3));
const a4 = await auth.login('staff', 'testclerk', 'secret1');
ok('舊密碼失效', !a4.ok, JSON.stringify(a4));

/* ============================================================ */
section('5. 所有 session reader 統一執行 expiry（currentRole／can 都唔可讀過期身份）');
store.setSession({ role: 'leader', accountId: 'server-user', via: 'server', sessionToken: 'opaque',
  sessionExpiresAt: Date.now() + 60_000 });
ok('未過期 server session 仍可讀', auth.currentRole() === 'leader' && auth.current()?.accountId === 'server-user');
store.setSession({ role: 'super', accountId: 'super', via: 'super-server', sessionToken: 'expired',
  sessionExpiresAt: Date.now() - 1 });
ok('★ currentRole 不會保留過期超管身份', auth.currentRole() === null && auth.isSuper() === false);
ok('★ 底層 getSession 同步清走過期票據', store.getSession() === null);
store.setSession({ role: 'leader', accountId: 'malformed', via: 'server', sessionToken: 'no-expiry' });
ok('★ 有 server token 但冇有效 expiry 一律 fail closed', auth.current() === null && store.getSession() === null);

/* ============================================================ */
section('6. 團員入口獨立 session 同樣 fail closed');
const hubStorage = new Map();
globalThis.localStorage = {
  getItem: k => hubStorage.has(k) ? hubStorage.get(k) : null,
  setItem: (k, v) => hubStorage.set(k, String(v)),
  removeItem: k => hubStorage.delete(k)
};
const hubSession = await import('../assets/js/lib/hub-session.js');
hubSession.saveHubAuth('0082', { id: 'm1', ymis: '1000000999', sessionToken: 'hub-token',
  sessionExpiresAt: Date.now() + 60_000 });
ok('未過期團員 session 可讀', hubSession.loadHubAuth('0082')?.ymis === '1000000999');
hubStorage.set('v82.hub.auth.0082', JSON.stringify({ id: 'm1', ymis: '1000000999', sessionToken: 'hub-token', at: Date.now() }));
ok('★ 團員 token 冇 expiry 即時清走', hubSession.loadHubAuth('0082') === null && !hubStorage.has('v82.hub.auth.0082'));
hubStorage.set('v82.hub.auth.0082', JSON.stringify({ id: 'm1', ymis: '1000000999', sessionToken: 'hub-token',
  sessionExpiresAt: Date.now() - 1, at: Date.now() }));
ok('★ 過期團員 token 即時清走', hubSession.loadHubAuth('0082') === null && !hubStorage.has('v82.hub.auth.0082'));

/* ============================================================ */
section('7. 中央 SSO purpose token 必須即時兌換，瀏覽器只保存支部 opaque session');
const ssoCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  ssoCalls.push({ url: String(url), body });
  if (String(url).includes('api/portal')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, unit: '0082', role: 'leader',
      subject: '9000000002', name: '中央領袖', portalToken: 'one-use-purpose-token', exchangeRequired: true, expiresIn: 60 }) };
  }
  if (String(url).includes('api/proxy') && body.action === 'authPortalExchange') {
    return { ok: true, status: 200, json: async () => ({ ok: true, success: true,
      sessionToken: 'branch-opaque-session', sessionExpiresAt: Date.now() + 8 * 3600 * 1000,
      account: { id: '9000000002', ymis: '9000000002', memberId: '9000000002', username: 'leader@example.test',
        name: '中央領袖', email: 'leader@example.test', role: 'leader' } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const portalLogin = await auth.loginPortalFromUrl(new URLSearchParams('from=portal&assertion=signed.central.assertion'));
const centralSession = auth.current();
ok('中央 assertion 先由 /api/portal 驗證，再向同一支部 GS 兌換', portalLogin.ok === true
  && ssoCalls[0]?.body.assertion === 'signed.central.assertion'
  && ssoCalls[1]?.body.action === 'authPortalExchange' && ssoCalls[1]?.body.portalToken === 'one-use-purpose-token');
ok('瀏覽器只保存支部 opaque session，不保存 purpose token', centralSession?.sessionToken === 'branch-opaque-session'
  && centralSession?.centralSso === true && !centralSession?.portalToken && centralSession?.ymis === '9000000002', JSON.stringify(centralSession));
globalThis.fetch = browserFetch;

/* ============================================================ */
section('8. 團員入口無快取／舊污染快取只建立安全空殼');
{
  const hubKey = store.hubDbKey('0082');
  hubStorage.set(hubKey, JSON.stringify({ schema: 2, unitCode: '0082',
    members: [{ id: 'private-member', name: '不應出現' }],
    transactions: [{ id: 'private-money', amount: 999 }],
    meta: { seedSource: '舊完整 seed' } }));
  let staticFetches = 0;
  globalThis.fetch = async (...args) => { staticFetches++; return browserFetch(...args); };
  await store.init({ mode: 'hub', scope: 'hub', unit: '0082', backendUrl: 'http://localhost:9191/branch/exec' });
  const shell = store.load();
  ok('舊 hub key 若非明確安全投影會被丟棄，不保留名冊／帳目',
    shell.meta?.hubShell === true && shell.members.length === 0 && shell.transactions.length === 0,
    JSON.stringify({ meta: shell.meta, members: shell.members.length, transactions: shell.transactions.length }));
  ok('安全空殼不會 fetch members／finance 等靜態行政 seed', staticFetches === 0, String(staticFetches));
  ok('?be= 經白名單後只保存 routing metadata，不會令空殼加入行政資料',
    shell.sync?.url === 'http://localhost:9191/branch/exec' && shell.sync?.apiKey === ''
      && shell.backend?.gasUrl === 'http://localhost:9191/branch/exec');
  globalThis.fetch = browserFetch;
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
