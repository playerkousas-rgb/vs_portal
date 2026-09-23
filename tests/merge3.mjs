/* ============================================================
   tests/merge3.mjs — 三方比對規則（團長 2026-09-20 定案）
   ------------------------------------------------------------
   「登入嗰刻攞到嘅資料 ＝ 基準。之後改嘅都喺自己瀏覽器。撳儲存先核對：
     有人喺我讀完之後儲存過 → 話畀我知；
     佢改嘅同我改嘅一樣 → 冇問題；
     改唔同嘅嘢、唔相對 → 都儲存得；
     一個登記早走、一個登記遲到 → 嗰一點唔儲存，警告用戶再確認；
     再確認先至蓋過去。」
   用法：node tests/merge3.mjs
   ============================================================ */
import {
  diffDb, threeWay, applyChanges, overridesFor, describeConflict, pathKey, deepEqual, summarize
} from '../assets/js/lib/merge3.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/* 登入嗰一刻嘅快照（基準） */
const BASE = {
  schema: 2, kind: 'real', unitCode: '0082',
  settings: { feePerYear: 360, troopLinks: { instagram: '', facebook: '' } },
  members: [
    { id: 'm1', name: '陳大文', phone: '9111 1111', identity: 'member' },
    { id: 'm2', name: '李小明', phone: '9222 2222', identity: 'member' },
    { id: 'm3', name: '張家俊', phone: '9333 3333', identity: 'exco' }
  ],
  events: [
    { id: 'ev1', title: '九月露營', date: '2026-09-26', rollcall: { m1: 'present', m2: 'present' }, updatedAt: '2026-09-20 10:00' }
  ],
  meetings: [
    { id: 'mt1', title: '九月例會', attendance: { m1: 'present' }, agenda: [{ id: 'ag1', text: '通過上次會議記錄' }], updatedAt: '2026-09-20 10:00' }
  ],
  transactions: [
    { id: 't1', date: '2026-09-01', type: 'income', item: '團費', amount: 360 }
  ],
  auditLog: [{ id: 'log1', at: '2026-09-20 10:00', action: '登入' }],
  sync: { pending: 0, url: 'x' }, meta: { updatedAt: '2026-09-20T10:00' }
};

/* ============================================================ */
section('diff：基準 → 而家，改咗乜');
{
  const cur = clone(BASE);
  cur.events[0].rollcall.m1 = 'early';                   // 改一格
  cur.members.push({ id: 'm4', name: '新人', identity: 'member' }); // 加一條
  cur.transactions = [];                                 // 刪一條
  cur.settings.troopLinks.instagram = 'https://instagram.com/x';
  cur.sync.pending = 5; cur.meta.updatedAt = 'later';    // 簿記：唔應該出現
  const d = diffDb(BASE, cur);
  const keys = d.map(c => pathKey(c.path));
  ok('改一格：events/[ev1]/rollcall/m1', keys.includes('events/[ev1]/rollcall/m1'), J(keys));
  ok('加一條：members/[m4]（add）', d.some(c => pathKey(c.path) === 'members/[m4]' && c.kind === 'add'));
  ok('刪一條：transactions/[t1]（del）', d.some(c => pathKey(c.path) === 'transactions/[t1]' && c.kind === 'del'));
  ok('物件入面一格：settings/troopLinks/instagram', keys.includes('settings/troopLinks/instagram'));
  ok('sync／meta 呢啲簿記永遠唔入 diff', !keys.some(k => /^sync|^meta/.test(k)), J(keys));
  ok('總共 4 個改動（唔多唔少）', d.length === 4, J(keys));
  ok('冇改 → 冇 diff', diffDb(BASE, clone(BASE)).length === 0);
  ok('key 次序唔同都唔算改動', deepEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
}

section('apply：把改動套返落去 ＝ 一模一樣');
{
  const cur = clone(BASE);
  cur.events[0].rollcall.m1 = 'early';
  cur.members.push({ id: 'm4', name: '新人', identity: 'member' });
  cur.transactions = [];
  cur.members[1].phone = '9999 9999';
  delete cur.members[2].phone;
  const d = diffDb(BASE, cur);
  const rebuilt = applyChanges(clone(BASE), d);
  ok('套完之後同「而家」完全一樣（簿記除外）', diffDb(rebuilt, cur).length === 0, J(diffDb(rebuilt, cur)));
  ok('刪 key（phone）都套得返', rebuilt.members.find(m => m.id === 'm3').phone === undefined);
}

/* ============================================================ */
section('★ 團長劇本 ①：一個登記早走、一個登記遲到 → 衝突，嗰一格唔會自動寫');
{
  const mine = clone(BASE);   mine.events[0].rollcall.m1 = 'early';    mine.events[0].updatedAt = '2026-09-20 11:00';
  const theirs = clone(BASE); theirs.events[0].rollcall.m1 = 'late';   theirs.events[0].updatedAt = '2026-09-20 10:30';
  const r = threeWay(BASE, mine, theirs);
  ok('偵測到 1 個衝突', r.conflicts.length === 1, J(r.conflicts.map(c => c.key)));
  ok('衝突就係嗰一格：events/[ev1]/rollcall/m1', r.conflicts[0]?.key === 'events/[ev1]/rollcall/m1');
  ok('合併結果嗰一格**保持後端**（遲到）—— 未確認就唔蓋', r.merged.events[0].rollcall.m1 === 'late');
  ok('updatedAt 呢類時間戳唔算衝突（靜靜地用我嘅）',
    !r.conflicts.some(c => /updatedAt/.test(c.key)) && r.merged.events[0].updatedAt === '2026-09-20 11:00');
  const d = describeConflict(r.conflicts[0], { local: mine, remote: theirs });
  ok('人話：講到係邊個活動、邊個人', /九月露營/.test(d.where) && /陳大文/.test(d.where), d.where);
  ok('人話：我＝早走、後端＝遲到', d.mineText === '早走' && d.theirsText === '遲到', J(d));
  /* 用家再確認 → 用我嘅蓋過去 */
  const ov = overridesFor(r.conflicts, [r.conflicts[0].key]);
  const final = applyChanges(clone(r.merged), ov);
  ok('確認之後先至變成早走', final.events[0].rollcall.m1 === 'early');
  ok('overridesFor(conflicts, true) ＝ 全部用我嘅', overridesFor(r.conflicts, true).length === 1);
  ok('overridesFor(conflicts, []) ＝ 一個都唔蓋', overridesFor(r.conflicts, []).length === 0);
}

section('★ 團長劇本 ②：大家都改成同一樣嘢 → 冇問題，唔會嘈');
{
  const mine = clone(BASE);   mine.events[0].rollcall.m1 = 'late';
  const theirs = clone(BASE); theirs.events[0].rollcall.m1 = 'late';
  const r = threeWay(BASE, mine, theirs);
  ok('冇衝突', r.conflicts.length === 0, J(r.conflicts));
  ok('計入「相同」1 項', r.same.length === 1);
  ok('合併結果係遲到', r.merged.events[0].rollcall.m1 === 'late');
}

section('★ 團長劇本 ③：改唔同嘅嘢（唔相對）→ 兩邊都保留，一齊儲存');
{
  const mine = clone(BASE);
  mine.events[0].rollcall.m1 = 'early';                       // 我：陳大文早走
  mine.members.push({ id: 'm9', name: '我加嘅新人', identity: 'member' });
  mine.settings.troopLinks.instagram = 'https://instagram.com/troop';
  const theirs = clone(BASE);
  theirs.events[0].rollcall.m2 = 'late';                      // 佢：李小明遲到（同一個活動、唔同人）
  theirs.transactions.push({ id: 't2', date: '2026-09-19', type: 'expense', item: '營地', amount: 800 });
  theirs.settings.troopLinks.facebook = 'https://facebook.com/troop';
  theirs.members[2].phone = '9000 0000';                      // 佢改張家俊電話
  const r = threeWay(BASE, mine, theirs);
  ok('冇衝突', r.conflicts.length === 0, J(r.conflicts.map(c => c.key)));
  ok('同一個活動兩個人嘅點名都喺度（早走＋遲到）',
    r.merged.events[0].rollcall.m1 === 'early' && r.merged.events[0].rollcall.m2 === 'late', J(r.merged.events[0].rollcall));
  ok('我加嘅新人＋佢加嘅帳目都喺度',
    r.merged.members.some(m => m.id === 'm9') && r.merged.transactions.some(t => t.id === 't2'));
  ok('IG（我）＋ FB（佢）都喺度',
    r.merged.settings.troopLinks.instagram === 'https://instagram.com/troop' && r.merged.settings.troopLinks.facebook === 'https://facebook.com/troop');
  ok('佢改嘅電話保留', r.merged.members.find(m => m.id === 'm3').phone === '9000 0000');
  ok('我嘅 3 個改動全部套咗', r.applied.length === 3, J(r.applied.map(c => pathKey(c.path))));
  ok('summarize 出到人話', /行事曆 1/.test(summarize(r.applied)) && /用戶 1/.test(summarize(r.applied)), summarize(r.applied));
}

section('★ 團長劇本 ④：有人喺我讀完之後儲存過，但同我改嘅完全冇關 → 照儲存');
{
  const mine = clone(BASE);   mine.members[0].phone = '9555 5555';
  const theirs = clone(BASE); theirs.meetings[0].attendance.m2 = 'apology';
  const r = threeWay(BASE, mine, theirs);
  ok('theirs 有 1 個改動、mine 有 1 個改動、0 衝突', r.theirs.length === 1 && r.mine.length === 1 && r.conflicts.length === 0);
  ok('兩邊都入咗', r.merged.members[0].phone === '9555 5555' && r.merged.meetings[0].attendance.m2 === 'apology');
}

/* ============================================================ */
section('刪除 vs 修改（都要問，唔可以靜靜雞）');
{
  /* 我刪咗成條、佢改咗入面一格 */
  const mine = clone(BASE);   mine.members = mine.members.filter(m => m.id !== 'm2');
  const theirs = clone(BASE); theirs.members[1].phone = '9888 8888';
  const r = threeWay(BASE, mine, theirs);
  ok('我刪／佢改 → 衝突 1 個', r.conflicts.length === 1, J(r.conflicts.map(c => c.key)));
  ok('未確認：後端嗰條（連佢嘅新電話）保留', r.merged.members.some(m => m.id === 'm2' && m.phone === '9888 8888'));
  const final = applyChanges(clone(r.merged), overridesFor(r.conflicts, true));
  ok('確認用我嘅 → 真係刪走', !final.members.some(m => m.id === 'm2'));
  const d = describeConflict(r.conflicts[0], { local: mine, remote: theirs });
  ok('人話：我＝刪除咗呢筆', /刪除/.test(d.mineText) && /李小明/.test(d.where), J(d));

  /* 佢刪咗成條、我改咗入面一格 */
  const mine2 = clone(BASE);   mine2.members[1].phone = '9777 7777';
  const theirs2 = clone(BASE); theirs2.members = theirs2.members.filter(m => m.id !== 'm2');
  const r2 = threeWay(BASE, mine2, theirs2);
  ok('佢刪／我改 → 衝突 1 個', r2.conflicts.length === 1, J(r2.conflicts.map(c => c.key)));
  ok('未確認：後端贏（條紀錄冇咗）', !r2.merged.members.some(m => m.id === 'm2'));
  const final2 = applyChanges(clone(r2.merged), overridesFor(r2.conflicts, true));
  ok('確認用我嘅 → 我嗰條（連新電話）成條放返', final2.members.some(m => m.id === 'm2' && m.phone === '9777 7777'));

  /* 兩邊都刪同一條 → 一樣，冇衝突 */
  const both1 = clone(BASE); both1.members = both1.members.filter(m => m.id !== 'm1');
  const both2 = clone(BASE); both2.members = both2.members.filter(m => m.id !== 'm1');
  const r3 = threeWay(BASE, both1, both2);
  ok('兩邊都刪同一條 → 冇衝突、條紀錄冇咗', r3.conflicts.length === 0 && !r3.merged.members.some(m => m.id === 'm1'));
}

section('巢狀有 id 嘅陣列（議程／章節）逐條比，唔會成舊當一格');
{
  const mine = clone(BASE);   mine.meetings[0].agenda.push({ id: 'ag2', text: '我加嘅議程' });
  const theirs = clone(BASE); theirs.meetings[0].agenda[0].text = '通過上次會議記錄（已修訂）';
  const r = threeWay(BASE, mine, theirs);
  ok('冇衝突', r.conflicts.length === 0, J(r.conflicts.map(c => c.key)));
  ok('兩條議程都喺度、佢嘅修訂保留',
    r.merged.meetings[0].agenda.length === 2 && r.merged.meetings[0].agenda[0].text.includes('已修訂'));
}

section('基準係空（新旅團第一次儲存）：全部當「我加嘅」，冇嘢撞');
{
  const r = threeWay({}, BASE, {});
  ok('冇衝突', r.conflicts.length === 0);
  ok('合併結果有齊團員／活動', r.merged.members.length === 3 && r.merged.events.length === 1);
  ok('簿記 key（sync／meta）唔會被搬入去', r.merged.sync === undefined && r.merged.meta === undefined);
}

section('操作紀錄（auditLog）：兩邊各自登入 → 併集，永遠唔會衝突');
{
  const mine = clone(BASE);   mine.auditLog.unshift({ id: 'logA', at: '2026-09-20 12:00', action: '登入', by: 'A' });
  const theirs = clone(BASE); theirs.auditLog.unshift({ id: 'logB', at: '2026-09-20 11:30', action: '登入', by: 'B' });
  const r = threeWay(BASE, mine, theirs);
  ok('冇衝突', r.conflicts.length === 0);
  ok('三條都喺度、最新喺頂', r.merged.auditLog.length === 3 && r.merged.auditLog[0].id === 'logA', J(r.merged.auditLog.map(l => l.id)));
}

section('冇 id 嘅陣列（預算項目）當一格：兩邊各改 → 衝突（唔會靜靜雞蝕一邊）');
{
  const B = { budgets: [{ id: 'b1', items: [{ name: '營地', planned: 1000 }] }] };
  const mine = clone(B);   mine.budgets[0].items[0].planned = 1200;
  const theirs = clone(B); theirs.budgets[0].items[0].planned = 900;
  const r = threeWay(B, mine, theirs);
  ok('衝突 1 個（成個 items 陣列）', r.conflicts.length === 1 && r.conflicts[0].key === 'budgets/[b1]/items');
  ok('未確認保持後端（900）', r.merged.budgets[0].items[0].planned === 900);
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
