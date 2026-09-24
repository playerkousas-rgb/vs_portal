/* ============================================================
   tests/login.mjs — 登入流程測試（純 Node，唔使 jsdom）
   ------------------------------------------------------------
   2026-09-18 團長回報兩件事：
     ① 「開咗新領袖用戶、有電郵有密碼，但登入唔到」
        → 名冊領袖（用戶頁加嘅）而家可以用電郵＋入口密碼由「領袖」入口入
     ② 「名冊有登記但冇設定密碼，係咪用 1234 入到？」
        → 係：首次用 1234 自動開戶，入去即刻強制改密碼
   驗證：
     - 名冊領袖：電郵門（大小寫唔拘）、錯密碼拒絕、未設密碼有明確提示、
       1234 首登強制改、改密碼（changeOwnPassword 名冊路線）、新密碼生效
     - 名冊團員／執委：1234 自動開戶；錯密碼拒絕
     - 舊路線（accounts 帳戶）一樣行得：開戶、登入、改自己密碼
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
section('3. 名冊團員／執委：名冊有個名＝1234 自動開戶（團長嘅問題）');
const mem = store.add('members', {
  name: '測試團員', identity: 'member', ymis: '1000000999', status: 'active'
});
const wrong = await auth.loginMember('1000000999', '9999');
ok('未設過密碼＋錯密碼：提示首次密碼', !wrong.ok && /首次密碼/.test(wrong.msg || ''), JSON.stringify(wrong));
const m1 = await auth.loginMember('1000000999', '1234');
ok('1234 就入到（自動開戶）', m1.ok === true && m1.mustChangePw === true, JSON.stringify(m1));
ok('自動開戶有標記', (() => { const x = store.find('members', mem.id); return !!x.hubOpened && !!x.hubMustChangePw; })());

const exco = store.add('members', {
  name: '測試執委', identity: 'exco', ymis: '1000000888', status: 'active'
});
const e1 = await auth.loginMember('1000000888', '1234');
ok('執委都係 1234 自動開戶入管理系統', e1.ok === true && e1.dest === 'staff' && e1.role === 'exco', JSON.stringify(e1));

const leaderDoor = await auth.loginMember(String(leader.ymis || ''), 'x');
/* 領袖唔可以行 YMIS 門（leader 無 ymis → 會籍編號不正確） */
ok('領袖YMIS門照樣擋（無 YMIS 對不上）', !leaderDoor.ok, JSON.stringify(leaderDoor));

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

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
