/* ============================================================
   tests/public.mjs — 匿名公開層退役／authenticated hub 契約
   ============================================================ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  VIS_LEVELS, contentVis, visOf, visibleContent, visibleTo
} from '../assets/js/lib/content-visibility.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(name, condition, extra = '') {
  if (condition) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

console.log('\n▌內容可見範圍只屬已登入本支部身份');
ok('可見層由支部 schema 產生，沒有 anonymous／public／other 身份',
  VIS_LEVELS.map(level => level.id).join(',') === 'member,exco,leader,chief',
  VIS_LEVELS.map(level => level.id).join(','));
ok('每層說明都明確要求登入', VIS_LEVELS.every(level => /必須先登入/.test(level.desc)));
ok('舊 other 安全收窄到最低本地身份 member', visOf({ vis: 'other' }) === 'member');
ok('未知舊值同樣 fail-safe 收窄到 member', visOf({ vis: 'internet-public' }) === 'member');
ok('未登入／未知身份永遠睇唔到最低層內容',
  visibleTo('member', '') === false && visibleTo('member', 'anonymous') === false);
ok('已登入身份單調向上閱讀',
  visibleTo('member', 'member') && visibleTo('member', 'chief')
    && !visibleTo('leader', 'member') && visibleTo('leader', 'chief'));
ok('event 舊 visibility=exco 只由 exco 或以上閱讀',
  contentVis({ visibility: 'exco' }, 'event') === 'exco'
    && !visibleContent({ visibility: 'exco' }, 'event', 'member')
    && visibleContent({ visibility: 'exco' }, 'event', 'leader'));

console.log('\n▌舊公開 URL 只保留安全相容轉向');
const redirectCases = [
  ['constitution', 'constitution.html', 'assets/js/public.js', "target.hash = '/constitution'"],
  ['notice', 'notice.html', 'assets/js/public-notice.js', "target.hash = notice ? `/notice/"],
  ['entry', 'entry.html', 'assets/js/public-entry.js', "target.hash = '/home'"],
  ['borrow', 'borrow.html', 'assets/js/public-borrow.js', "target.hash = '/home'"]
];
for (const [name, htmlFile, scriptFile, route] of redirectCases) {
  const html = read(htmlFile);
  const script = read(scriptFile);
  ok(`${htmlFile} 仍載入相容 script`, html.includes(scriptFile.replace('assets/js/', './assets/js/')));
  ok(`${name} 相容 script 只轉向 members.html`,
    script.includes("new URL('./members.html'") && script.includes('location.replace') && script.includes(route));
  ok(`${name} 相容 script 不讀匿名資料`,
    !/\bfetch\s*\(/.test(script) && !/loadPublic|noticeSignup|appendClaim|appendLoan/.test(script));
  ok(`${name} 相容 script 不會把 API Key 放入網址`, !/apiKey|API_KEY|searchParams\.set\(['\"]key/i.test(script));
}

console.log('\n▌members.html 係唯一團員內容入口');
const memberHtml = read('members.html');
const hub = read('assets/js/public-hub.js');
const remote = read('assets/js/lib/remote.js');
ok('members.html 載入 authenticated member hub', memberHtml.includes('./assets/js/public-hub.js'));
ok('hub 使用持久 opaque session helper',
  /loadHubAuth/.test(hub) && /saveHubAuth/.test(hub) && /clearHubAuth/.test(hub));
ok('hub 登入經支部後端核對，不從 query 接受角色',
  /loginMember/.test(hub) && /sessionToken/.test(hub) && !/q\.get\(['\"]role/.test(hub));
ok('hub 讀取與 mutation 使用專用 remote action',
  ['hubLoad', 'hubRsvp', 'hubQuiz', 'hubAbsence', 'hubNoticeSignup']
    .every(action => remote.includes(`action: '${action}'`))
    && /loadHubView|saveHubRsvp|saveHubQuiz|saveHubNoticeSignup|saveHubAbsence/.test(hub));
ok('hub 內容再按 authenticated 本地身份判斷',
  /visibleTo/.test(hub) && /contentVis/.test(hub));

console.log('\n▌Edge／GAS dispatch 沒有匿名內容 action');
const proxy = read('api/proxy.js');
const gas = read('apps-script/Code.gs');
const removedActions = ['claim', 'loan', 'noticeSignup', 'notices', 'constitution'];
ok('Edge allowlist 沒有舊匿名 actions',
  removedActions.every(action => !new RegExp(`['\"]${action}['\"]`).test(
    proxy.match(/const ALLOWED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '')));
ok('Edge 只允許 session-bound hub actions',
  ['hubLoad', 'hubRsvp', 'hubQuiz', 'hubAbsence', 'hubNoticeSignup']
    .every(action => proxy.includes(`'${action}'`)));
ok('Portal GAS dispatcher 沒有舊匿名 actions',
  removedActions.every(action => !gas.includes(`body.action === '${action}'`)));
ok('Portal GAS 已刪除舊匿名 reader／writer helper，不只係藏起 dispatcher',
  ['loadPublicNotices', 'publicConstitution', 'appendClaim', 'appendLoan', 'appendSignup']
    .every(name => !new RegExp(`function\\s+${name}\\s*\\(`).test(gas)));
ok('Portal GAS hub load 先核實 session 再回安全投影',
  /body\.action === 'hubLoad'/.test(gas) && /requireAuthSession/.test(gas) && /hubSafeDb_/.test(gas));
ok('Portal GAS hub mutation 固定由 session actor 執行',
  /hubApplyMutation_/.test(gas) && /adminFindActor_|hubFindActor_/.test(gas));

console.log(`\n──────── Authenticated hub：${pass} 通過 / ${fail} 失敗 ────────`);
if (fail) process.exit(1);
