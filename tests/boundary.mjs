/* ============================================================
   tests/boundary.mjs — 系統樹連結邊界守門（SCOPE.md §1）
   ------------------------------------------------------------
   用戶定案（2026-11-12）：

     施工次序 = 4 本 BOOK → 4 套 BADGE → 5 個支部系統 → 最後旅系統。
     現在係第 3 階段，未有中央旅系統；支部必須可以獨立運作。
     Progress 是支部內部功能，只經同源 proxy 對本支部 Unified backend 執行業務 action。
     未來方向是旅系統 → 單向讀取支部後端。
     BOOK 可讀 BADGE 正式資料，亦可提交待批匯入；只有領袖確認後先算正式錄入。
     **支部之間冇 direct link，旅系統 reader 方向亦不可倒轉。**

   ★ 用戶澄清（最重要，唔好誤解）：
     「其實佢地所謂既連係因為有旅係同接通兩者，再係旅係統表現出來的，
       所以嚴格來說不算連上」

     → 即使 VS 同 ROVER 同時由旅系統讀取，佢哋之間**依然冇 direct link**。
       係旅系統以獨立 reader 分別讀兩邊，再喺旅層聚合呈現。星形，唔係網狀。

   所以本 repo（支部級）永遠唔准：
     ① 有另一個支部嘅 backend URL / API key 設定槽（env 或 registry 欄位）
     ② 主動 request 另一個支部或旅系統
     ③ 在 Progress 加登入閘門／旅系統 action、狀態或第二 backend
     ④ 出現跨支部聚合功能（嗰啲屬旅系統）

   呢個係靜態守門：掃原始碼，唔准出現橫向連結嘅入口。
   用法：node tests/boundary.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 其他支部系統／BADGE host —— 本 repo 唔准直接 request 任何一個。
   本支部 Progress 只會呼叫 Registry 指定的同一 Unified backend。 */
const SIBLING_BRANCH_HOSTS = [
  'roverbadge', 'scoutbadge', 'cubsbadge',
  'roverportal', 'scoutportal', 'cubsportal', 'rover_portal', 'scout_portal', 'cubs_portal',
];
/* 橫向連結嘅 env／欄位命名（一出現即代表有人開咗跨支部槽） */
const CROSS_BRANCH_FIELD = /\b(?:ROVER|SCOUTBRANCH|CUBS|SIBLING|CROSS_BRANCH|PEER_BRANCH)[A-Z_]*(?:BACKEND|APIKEY|URL|EXEC|KEY)\b/;

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(abs, name);
    if (fs.statSync(p).isDirectory()) walk(path.relative(ROOT, p), out);
    else out.push(path.relative(ROOT, p));
  }
  return out;
}

console.log('\n▌① 執行期程式碼唔准指向另一個支部');
{
  /* 只掃真正會跑嘅程式（api / assets / data registry），
     唔掃 docs／tests —— 文件要可以講解邊界，測試要可以寫負例。 */
  const runtime = [
    ...walk('api'), ...walk('assets/js'), 'data/units.json',
  ].filter(f => /\.(js|mjs|json)$/.test(f));

  const offenders = [];
  for (const f of runtime) {
    const txt = read(f);
    for (const host of SIBLING_BRANCH_HOSTS) {
      /* 只算「當成 URL / host 用」嘅引用（例 roverbadge.vercel.app），
         唔算純註解提及 —— 但執行期程式本來就唔應該提到人哋個 host。 */
      if (new RegExp(host + '\\.vercel\\.app|//' + host + '\\b', 'i').test(txt)) {
        offenders.push(`${f} → ${host}`);
      }
    }
  }
  ok('冇任何指向其他支部主機嘅 URL', offenders.length === 0, offenders.join(', '));
  ok('已掃足夠嘅執行期檔案（避免假綠）', runtime.length >= 40, String(runtime.length));
}

console.log('\n▌② Registry 唔准有跨支部連結欄位');
{
  const reg = read('api/_registry.js');
  /* 抽出 FIELD_ALIASES 區塊：呢度就係「可以登記邊啲連結」嘅唯一真理 */
  const m = reg.match(/const FIELD_ALIASES = \{[\s\S]*?\n\};/);
  ok('搵到 FIELD_ALIASES（連結欄位唯一來源）', !!m);
  const block = m ? m[0] : '';

  ok('冇跨支部／兄弟支部嘅 backend/key 欄位', !CROSS_BRANCH_FIELD.test(block),
    (block.match(CROSS_BRANCH_FIELD) || [''])[0]);

  /* 統一版進度固定沿用支部主 BACKEND／APIKEY，不可另開第二條資料路線。 */
  ok('Registry 保留唯一主 BACKEND／APIKEY', /\bBACKEND:/.test(block) && /\bAPIKEY:/.test(block));
  ok('Registry 不再接受任何 PROGRESS* 第二套設定', !/PROGRESS[A-Z_]*:/.test(block));

  /* 冇「另一个支部」嘅概念欄位 */
  ok('冇 peer / sibling / crossBranch 欄位別名',
    !/\b(?:PEER|SIBLING|CROSSBRANCH|CROSS_BRANCH)\b/i.test(block));
}

console.log('\n▌③ 前端唔准開「連去另一個支部」嘅設定入口');
{
  const files = [...walk('assets/js')].filter(f => /\.js$/.test(f));
  const bad = [];
  for (const f of files) {
    const txt = read(f);
    if (CROSS_BRANCH_FIELD.test(txt)) bad.push(f);
  }
  ok('前端冇跨支部 backend/key 設定槽', bad.length === 0, bad.join(', '));

  const progressApi = read('api/progress.js');
  const actionSet = progressApi.match(/const ACTIONS = new Set\(\[[\s\S]*?\]\);/)?.[0] || '';
  ok('Progress API action set 只保留業務操作',
    !!actionSet && !/getLinkState|setLocalLogin|portal|travel/i.test(actionSet), actionSet);
  const progressClient = read('assets/js/lib/progress.js');
  ok('Progress client 冇入口狀態／控制 helper',
    !/export\s+(?:async\s+)?function\s+(?:getLinkState|setLocalLogin)\b/.test(progressClient));
  ok('Progress client／API 只接受支部 session，不接 auth fixture portalToken',
    !/portalToken/.test(progressClient)
      && !/(?:body|payload)\.portalToken|firstStr\([^)]*portalToken/.test(progressApi)
      && /'portalToken'/.test(progressApi));
  const progressView = read('assets/js/views/progress.js');
  ok('Progress view 冇發出入口／旅系統 action',
    !/action\s*:\s*['"](?:getLinkState|setLocalLogin)['"]/.test(progressView));
}

console.log('\n▌④ 執行期只准本支部 Registry 後端及固定 ADMIN 端點');
{
  const proxy = read('api/proxy.js');
  /* ADMIN 收件匣係固定受信端點，唔係由前端傳入。 */
  ok('ADMIN 端點係伺服器端常數', /const SCOUT_ADMIN_API\s*=/.test(proxy));
  ok('ADMIN 端點要過 trusted exec URL 檢查', /isTrustedExecUrl\(SCOUT_ADMIN_API\)/.test(proxy));
  /* 後端請求目標只可以來自 registry（自己旅團）或伺服器端常數，
     唔可以由 request body 決定「打去邊」。
     ⚠️ 唔好淨係 grep `body.scriptUrl` 就當違規：submitRegistration 嘅
        body.scriptUrl 係「新旅團填自己嘅 /exec 交畀 ADMIN」**資料欄位**，
        唔係請求目標；真正目的地係寫死嘅 SCOUT_ADMIN_API。 */
  ok('代理唔會用前端傳入嘅值做請求目標',
    !/callUpstream\(\s*(?:body|payload|req)\./.test(proxy)
    && !/fetch\(\s*body\./.test(proxy),
    (proxy.match(/callUpstream\(\s*body\.[A-Za-z]+/) || [''])[0]);
  ok('submitRegistration 嘅目的地係固定 ADMIN 常數（唔係 body）',
    /callUpstream\(SCOUT_ADMIN_API,\s*regPayload\)/.test(proxy));
}

console.log('\n▌⑤ 邊界文件存在而且寫明「唔算連上」');
{
  const scope = read('SCOPE.md');
  ok('SCOPE 有系統樹邊界章節', /系統樹同連結邊界/.test(scope));
  ok('SCOPE 明確禁止 支部 ↔ 支部', /支部 ↔ 支部/.test(scope));
  ok('SCOPE 記錄咗用戶「唔算連上」澄清', /不算連上/.test(scope));
  ok('SCOPE 講明係星形（旅為中心）', /星形/.test(scope));
  ok('SCOPE 講明跨支部聚合屬旅系統', /屬\*\*旅系統\*\*|屬旅系統/.test(scope));
  ok('SCOPE 固定由下而上施工次序（BOOK → BADGE → 支部 → 旅）',
    /BOOK[\s\S]{0,120}BADGE[\s\S]{0,160}5 個支部系統[\s\S]{0,160}旅系統/.test(scope));
  ok('SCOPE 講明現在未有中央旅系統', /現在沒有中央旅系統/.test(scope));
  ok('SCOPE 規定本地登入保持正常可用',
    /ALLOW_LOCAL_LOGIN[\s\S]{0,80}保持 `true`/.test(scope));
  ok('SCOPE 定義 Progress 為支部內部功能', /Progress 是支部系統內部功能/.test(scope));
  ok('SCOPE 固定未來方向為旅系統單向讀取支部後端',
    /旅系統[^\n]{0,40}單向讀取各支部後端/.test(scope));
  ok('SCOPE 固定 BOOK 可讀正式資料及提交待批匯入',
    /BOOK[^\n]{0,50}讀取[^\n]{0,80}BADGE/.test(scope)
      && /BOOK[^\n]{0,50}提交匯入候選/.test(scope));
  ok('SCOPE 固定 BOOK 匯入要領袖確認先成正式紀錄',
    /只有領袖確認後才寫入正式紀錄/.test(scope)
      && /BOOK 匯入直接成為正式紀錄，或繞過領袖確認/.test(scope));
  const agents = read('AGENTS.md');
  ok('AGENTS 有施工級別（BRANCH）', /BRANCH（支部）/.test(agents));
  ok('AGENTS 禁止主動連另一個支部', /主動連另一個支部/.test(agents));
  ok('AGENTS 守住 BOOK 待批匯入邊界',
    /BOOK 可讀正式資料及提交待批匯入/.test(agents)
      && /只有領袖確認後先可寫入正式紀錄/.test(agents));
}

console.log('\n▌⑥ 初始化保全鐵律有文件 + 有測試守');
{
  const scope = read('SCOPE.md');
  const agents = read('AGENTS.md');
  ok('SCOPE 寫明初始化只補唔改', /只補.*缺失分頁/.test(scope));
  ok('SCOPE 寫明 API_KEY 絕不更換', /絕不.*更換現有/.test(scope));
  ok('SCOPE 寫明 idempotent', /idempotent/.test(scope));
  ok('AGENTS 指明改 Code.gs 要跑保全測試', /tests\/init-preserve\.mjs/.test(agents));
  ok('保全測試檔真實存在', fs.existsSync(path.join(ROOT, 'tests/init-preserve.mjs')));
}

console.log(`\n──────── 系統樹邊界測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
