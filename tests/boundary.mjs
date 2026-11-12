/* ============================================================
   tests/boundary.mjs — 系統樹連結邊界守門（SCOPE.md §1）
   ------------------------------------------------------------
   用戶定案（2026-11-12）：

     整個系統樹 = 旅系統 ＋ 5 個支部系統 ＋ 4 套進度追蹤 ＋ 4 本 BOOK。
     可以分開連結（例：旅＋進度；進度＋BOOK）。
     **但冇跨支部連結。**

   ★ 用戶澄清（最重要，唔好誤解）：
     「其實佢地所謂既連係因為有旅係同接通兩者，再係旅係統表現出來的，
       所以嚴格來說不算連上」

     → 即使 VS 同 ROVER 掛喺同一個旅下面，佢哋之間**依然冇 direct link**。
       係旅系統「分別」接通兩邊，再喺旅層聚合呈現。星形，唔係網狀。

   所以本 repo（支部級）永遠唔准：
     ① 有另一個支部嘅 backend URL / API key 設定槽（env 或 registry 欄位）
     ② 主動 request 另一個支部嘅 /exec
     ③ 出現跨支部聚合功能（嗰啲屬旅系統）

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

/* 其他支部系統／佢哋嘅進度 leaf —— 本 repo 唔准直接連任何一個。
   註：vsbadge 係「深資自己嘅進度 leaf」（合法下游），所以唔列入禁區。 */
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

  /* 允許嘅下游：進度（PROGRESS*）。呢個係合法「支部 → 進度」連線。 */
  ok('保留合法下游欄位 PROGRESSBACKEND', /PROGRESSBACKEND/.test(block));
  ok('保留合法下游欄位 PROGRESSAPIKEY', /PROGRESSAPIKEY/.test(block));

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
}

console.log('\n▌④ 只准向上游／自己下游連線（白名單存在）');
{
  const proxy = read('api/proxy.js');
  /* ADMIN 收件匣係固定受信端點（向上），唔係由前端傳入 */
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
  const agents = read('AGENTS.md');
  ok('AGENTS 有施工級別（BRANCH）', /BRANCH（支部）/.test(agents));
  ok('AGENTS 禁止主動連另一個支部', /主動連另一個支部/.test(agents));
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
