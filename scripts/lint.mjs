#!/usr/bin/env node
/* ============================================================
   lint.mjs — 零依賴靜態檢查（`npm run lint`）
   ------------------------------------------------------------
   呢個 project 刻意保持零執行期依賴（jsdom 只係 devDependency），
   所以唔裝 ESLint —— 呢個 script 用 Node 內建能力做真正會捉到錯嘅檢查：

   ① 語法：對每個 .js/.mjs 跑 `node --check`（Code.gs 複製做 .js 先 check）
   ② JSON：每個 .json 都要 parse 得到
   ③ HTML 引用：每個 <script src> / <link href> 指到嘅檔一定要存在
   ④ ★ proxy 白名單：前端經同源代理送出去嘅每個 action，
      一定要喺 api/proxy.js 嘅 ALLOWED_ACTIONS 入面
      —— 呢條規則係 2026-09-20 事故嘅守門：`uploadPhotos` 曾經漏咗入白名單，
      代理一律回 400「不支援的操作」，單據相片於是跌返落 db JSON（base64），
      把「資料庫」分頁撐過 4.5MB，令所有裝置都讀唔返後端。
   ⑤ 部署清單：`.vercelignore` 唔准 exclude 到運行時要嘅檔；
      順便印出「今次部署會上傳乜／幾多 byte」

   用法：node scripts/lint.mjs
   ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let fails = 0;
let checks = 0;

const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) { console.log(`  ✓ ${label}`); return true; }
  fails++;
  console.log(`  ✗ ${label}${detail ? `\n      → ${detail}` : ''}`);
  return false;
};
const section = (t) => console.log(`\n▌${t}`);

/** 遞迴列檔（跳過 node_modules/.git） */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.vercel') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const ALL = walk(ROOT);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/* ============================================================
   ① 語法
   ============================================================ */
section('① 語法檢查（node --check）');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecportal-lint-'));
const jsFiles = ALL.filter(f => /\.m?js$/.test(f));
let syntaxBad = [];
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { syntaxBad.push(`${rel(f)}: ${String(e.stderr || e.message).split('\n')[0]}`); }
}
/* Code.gs 係 Apps Script（ES5），副檔名 node 唔認 → 複製做 .js 先 check */
const gas = path.join(ROOT, 'apps-script', 'Code.gs');
if (fs.existsSync(gas)) {
  const t = path.join(tmpDir, 'Code.gs.js');
  fs.writeFileSync(t, fs.readFileSync(gas, 'utf8'));
  try { execFileSync(process.execPath, ['--check', t], { stdio: 'pipe' }); }
  catch (e) { syntaxBad.push(`apps-script/Code.gs: ${String(e.stderr || e.message).split('\n')[0]}`); }
}
ok(syntaxBad.length === 0, `${jsFiles.length + 1} 個 JS 檔語法正確`, syntaxBad.join('\n      '));

/* ============================================================
   ② JSON
   ============================================================ */
section('② JSON 可解析');
const jsonBad = [];
const jsonFiles = ALL.filter(f => f.endsWith('.json'));
for (const f of jsonFiles) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { jsonBad.push(`${rel(f)}: ${e.message}`); }
}
ok(jsonBad.length === 0, `${jsonFiles.length} 個 JSON 檔格式正確`, jsonBad.join('\n      '));

/* ============================================================
   ③ HTML 引用嘅本地資源一定要存在
   ============================================================ */
section('③ HTML 引用嘅本地檔案存在');
const htmlFiles = ALL.filter(f => f.endsWith('.html'));
const missingRefs = [];
for (const f of htmlFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const refs = [...src.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)].map(m => m[1]);
  for (const r of refs) {
    const abs = path.resolve(path.dirname(f), r);
    if (!fs.existsSync(abs)) missingRefs.push(`${rel(f)} → ${r}`);
  }
}
ok(missingRefs.length === 0, `${htmlFiles.length} 個 HTML 嘅本地引用全部存在`, missingRefs.join('\n      '));

/* ============================================================
   ④ ★ proxy 白名單 vs 前端真係會送嘅 action
   ------------------------------------------------------------
   前端有兩條去後端嘅路：
     · lib/gateway.js postBackend → api/proxy.js（同源代理，有白名單）
     · lib/progress.js callApi   → api/progress.js（進度專用，另一個白名單）
   兩個白名單都要覆蓋到，漏一個就係「靜靜地 400」。 */
section('④ 後端 action 白名單覆蓋（2026-09-20 事故守門）');
const proxySrc = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');
const progSrc = fs.readFileSync(path.join(ROOT, 'api', 'progress.js'), 'utf8');
/* 直接由 Set／Array 字面量抽，避免誤抽其他字串 */
function setLiteral(src, varName) {
  let i = src.indexOf(`${varName} = new Set([`);
  let close = '])';
  if (i < 0) { i = src.indexOf(`${varName} = [`); close = ']'; }
  if (i < 0) return new Set();
  const j = src.indexOf(close, i);
  return new Set([...src.slice(i, j).matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]));
}
const PROXY_ALLOW = setLiteral(proxySrc, 'ALLOWED_ACTIONS');
const PROG_ALLOW = setLiteral(progSrc, 'ACTIONS');
ok(PROXY_ALLOW.size > 0, `讀到 api/proxy.js ALLOWED_ACTIONS（${PROXY_ALLOW.size} 個）`);
ok(PROG_ALLOW.size > 0, `讀到 api/progress.js ACTIONS（${PROG_ALLOW.size} 個）`);

/** 前端經 gateway（callBackend／postBackend）送嘅 action —— 即係 proxy 要放行嗰啲 */
const viaGateway = [];
for (const f of ALL.filter(f => (/^assets\/js\//.test(rel(f)) && /\.js$/.test(f)) || rel(f) === 'reset-password.html')) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/(?:callBackend|postBackend)\(\s*\{[^}]*?action:\s*'([a-zA-Z]+)'/gs)) {
    viaGateway.push({ action: m[1], file: rel(f) });
  }
}
/* 公開頁直接 fetch api/proxy 嘅（public*.js） */
for (const f of ALL.filter(f => /^assets\/js\/public/.test(rel(f)))) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/action:\s*'([a-zA-Z]+)'/g)) {
    viaGateway.push({ action: m[1], file: rel(f) });
  }
}
const needProxy = [...new Set(viaGateway.map(x => x.action))];
const notAllowed = needProxy.filter(a => !PROXY_ALLOW.has(a));
ok(notAllowed.length === 0,
  `前端經同源代理送嘅 ${needProxy.length} 個 action 全部喺白名單（${needProxy.sort().join(', ')}）`,
  `代理會回 400「不支援的操作」：${notAllowed.join(', ')}\n      來源：${
    viaGateway.filter(x => notAllowed.includes(x.action)).map(x => `${x.file}(${x.action})`).join(', ')}`);

/** 進度用嘅 action 要喺 api/progress.js 白名單 */
const progSrcFe = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'lib', 'progress.js'), 'utf8');
const needProg = [...new Set([...progSrcFe.matchAll(/action:\s*'([a-zA-Z]+)'/g)].map(m => m[1]))];
const progMissing = needProg.filter(a => !PROG_ALLOW.has(a));
ok(progMissing.length === 0, `進度前端嘅 ${needProg.length} 個 action 全部喺 /api/progress 白名單`,
  progMissing.join(', '));

/** 白名單入面嘅 action 後端真係識做 —— 唔好放行咗但後端冇。
    正式 Code.gs 暫時保持原 Portal build；中央兌換、server 密碼及批量開戶只屬
    UnifiedCode.gs。這些例外必須在 unified extension 的 action map 真實存在。 */
const gasSrc = fs.readFileSync(gas, 'utf8');
const gasHandles = new Set([...gasSrc.matchAll(/body\.action === '([a-zA-Z]+)'/g)].map(m => m[1]));
const unifiedExtension = fs.readFileSync(path.join(ROOT, 'apps-script', 'unified-src', 'unified-extension.gs'), 'utf8');
const unifiedOnlyProxyActions = new Set([
  'authPortalExchange', 'authChangePassword', 'authCompletePasswordReset', 'authOpenAccounts'
]);
const missingUnifiedHandlers = [...unifiedOnlyProxyActions].filter(action =>
  !(new RegExp(`\\b${action}:\\s*1\\b`).test(unifiedExtension)));
ok(missingUnifiedHandlers.length === 0,
  '隔離 Unified GS 有處理 proxy 放行的統一版專用 action', missingUnifiedHandlers.join(', '));
const ghost = [...PROXY_ALLOW].filter(a => !gasHandles.has(a)
  && !unifiedOnlyProxyActions.has(a)
  && !['submitRegistration', 'submitIssue', 'test', 'ping'].includes(a));
ok(ghost.length === 0, '白名單冇「放行咗但所有後端都唔識」嘅 action', ghost.join(', '));

/** Code.gs 嘅 SUPPORTED_ACTIONS（回提示用）要同真正處理緊嘅 action 一模一樣。
    以前呢句係手寫死嘅字串，一直漏咗 constitution —— 用家撞到「未知 action」
    嗰陣見到嘅清單本身就係錯嘅。 */
const declared = setLiteral(gasSrc, 'SUPPORTED_ACTIONS');
const handledOnly = [...gasHandles].filter(a => !declared.has(a));
const declaredOnly = [...declared].filter(a => !gasHandles.has(a));
ok(declared.size > 0 && handledOnly.length === 0 && declaredOnly.length === 0,
  `Code.gs SUPPORTED_ACTIONS 同真正處理緊嘅 ${gasHandles.size} 個 action 一模一樣`,
  `漏咗：${handledOnly.join(', ') || '—'}　多咗：${declaredOnly.join(', ') || '—'}`);

/* ============================================================
   ⑤ .vercelignore 審計 ＋ 部署清單
   ============================================================ */
section('⑤ .vercelignore 審計 ＋ 部署清單');
const ignoreFile = path.join(ROOT, '.vercelignore');
ok(fs.existsSync(ignoreFile), '根目錄有 .vercelignore');

/** 極簡 gitignore 比對（呢個檔只用咗：目錄名、檔名、*.ext） */
function ignoreMatchers() {
  if (!fs.existsSync(ignoreFile)) return [];
  return fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/)
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(l => l && !l.startsWith('!'))
    .map(pat => {
      const dirOnly = pat.endsWith('/');
      const base = pat.replace(/\/$/, '');
      const isGlob = base.includes('*');
      const re = isGlob
        ? new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
        : null;
      return { pat, base, dirOnly, re };
    });
}
const MATCHERS = ignoreMatchers();
function isIgnored(relPath) {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1];
  for (const m of MATCHERS) {
    if (m.re) { if (m.re.test(name)) return m.pat; continue; }
    /* 目錄名匹配（任何層）或者路徑開頭匹配 */
    if (parts.slice(0, -1).includes(m.base)) return m.pat;
    if (name === m.base && !m.dirOnly) return m.pat;
    if (parts[0] === m.base) return m.pat;
  }
  return '';
}

/* 運行時一定要喺部署度嘅檔（HTML 引用緊／JS fetch 緊） */
const RUNTIME_MUST = new Set();
for (const f of htmlFiles) {
  RUNTIME_MUST.add(rel(f));
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)) {
    RUNTIME_MUST.add(rel(path.resolve(path.dirname(f), m[1])));
  }
}
/* 前端 fetch 嘅靜態 JSON（data/**） */
for (const f of ALL.filter(f => /\.(js|mjs|html)$/.test(f) && !/^tests\//.test(rel(f)))) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/['"`](data\/[A-Za-z0-9._\-/]+\.json)['"`]/g)) RUNTIME_MUST.add(m[1]);
}
/* build 同 serverless 需要 */
for (const must of ['package.json', 'package-lock.json', 'vercel.json', '.vercelignore',
  'scripts/build-units.mjs', 'api/_registry.js', 'api/proxy.js', 'api/units.js', 'api/progress.js']) {
  RUNTIME_MUST.add(must);
}
/* api/ 全部（serverless）＋ apps-script/Code.gs 例外（生成物，APP 內即時生成） */
for (const f of ALL.filter(f => /^api\//.test(rel(f)))) RUNTIME_MUST.add(rel(f));

const wronglyIgnored = [...RUNTIME_MUST].filter(p => p && isIgnored(p) && !p.startsWith('apps-script/'));
ok(wronglyIgnored.length === 0, '.vercelignore 冇 exclude 到運行時／建置必要嘅檔',
  wronglyIgnored.join(', '));

/* 部署清單（= 會上傳嘅 tracked 檔；用 git ls-files 排除 .gitignore 嘅嘢） */
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
} catch { tracked = ALL.map(rel); }
const deployed = tracked.filter(p => !isIgnored(p));
const skipped = tracked.filter(p => isIgnored(p));
const bytes = (list) => list.reduce((n, p) => n + (fs.existsSync(path.join(ROOT, p)) ? fs.statSync(path.join(ROOT, p)).size : 0), 0);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`  · 部署上傳：${deployed.length} 個檔 · ${kb(bytes(deployed))}`);
console.log(`  · 已排除：  ${skipped.length} 個檔 · ${kb(bytes(skipped))}`);
const byTop = {};
for (const p of skipped) { const t = p.split('/')[0]; byTop[t] = (byTop[t] || 0) + fs.statSync(path.join(ROOT, p)).size; }
for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1] - a[1])) console.log(`      - ${k}: ${kb(v)}`);

/* 死重檔案唔准入 repo */
const junk = tracked.filter(p => /\.(bak|tmp|old|orig|rej|log|swp)$|~$/.test(p) || p === '|');
ok(junk.length === 0, 'repo 冇備份／暫存／日誌檔（*.bak／*.tmp／*.old／*.log）', junk.join(', '));

/* package.json：執行期依賴必須為空（零依賴原則） */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies || {});
ok(deps.length === 0, 'package.json 冇執行期 dependencies（零依賴原則）', deps.join(', '));
const buildTools = ['vite', 'tailwindcss', 'esbuild', 'webpack', 'rollup', 'typescript'];
ok(buildTools.every(t => !(pkg.dependencies || {})[t]), '建構工具冇混入 dependencies');

/* ============================================================
   ⑥ 版號單一來源（V1／F15）
   ------------------------------------------------------------
   version.js 嘅註解一直聲稱「lint 會擋住唔一致」，但其實冇呢個檢查 ——
   於是 Code.gs 檔頭可以同 BACKEND_VERSION 唔同（2026-11-12 升到 v2.8.5 嗰陣
   就係咁樣紅咗 tests/remote.mjs）。而家補返真正嘅閘門。
   ============================================================ */
section('⑥ 版號一致性（前後端同步發版）');
{
  const verSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/version.js'), 'utf8');
  const appVer = (verSrc.match(/APP_VERSION\s*=\s*'(v\d+\.\d+\.\d+)'/) || [])[1] || '';
  ok(!!appVer, 'version.js 有 APP_VERSION 常數', verSrc.slice(0, 80));

  const gen = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const backendVer = (gen.match(/var BACKEND_VERSION = '(v\d+\.\d+\.\d+)'/) || [])[1] || '';
  const headerVer = (gen.match(/\*\s*版本：(v\d+\.\d+\.\d+)/) || [])[1] || '';
  ok(!!backendVer && backendVer === appVer,
    'Code.gs BACKEND_VERSION = 前端 APP_VERSION', `backend=${backendVer} app=${appVer}`);
  ok(!!headerVer && headerVer === appVer,
    'Code.gs 檔頭版號 = APP_VERSION（唔准獨立寫死）', `header=${headerVer} app=${appVer}`);

  /* 生成檔必須同範本一致（V4：唔准人手改生成檔） */
  const tplSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/gastemplate.js'), 'utf8');
  ok(/版本：\$\{APP_VERSION\}/.test(tplSrc) && /var BACKEND_VERSION = '\$\{APP_VERSION\}'/.test(tplSrc),
    '範本由 APP_VERSION 推導版號（單一來源，冇第二處可以寫漏）');
}

/* ============================================================
   ⑦ ★ 孤兒 action 守門（2026-11-12 精簡之後加）
   ------------------------------------------------------------
   上面 ④ 守住嘅係「前端有 call → 白名單／後端一定要有」，
   方向係前端 → 後端。但腫脹係另一個方向積出嚟嘅：
   後端有 handler、白名單又放行，但係前端根本冇人 call。
   呢啲「孤兒 action」唔會令任何測試紅燈，所以可以一直靜靜雞累積。

   2026-11-12 實測：咁樣積咗 6 個孤兒（claimDecision／loanDecision／
   noticeSubscribe／noticeSubscriptions／authChangePassword／
   authResetByToken）＋ 一個 diag 自查鏈，合共約 250 行 GS 死碼。
   全部刪走之後加呢個守門：新孤兒一出現就紅燈，要嘛接返前端，
   要嘛喺下面登記做「刻意向後兼容／人手逃生門」並寫低原因。
   ============================================================ */
section('⑦ 孤兒 action 守門（後端有、前端冇人 call ＝ 死碼）');
{
  /* 刻意保留嘅冇前端呼叫者 action —— 每個都要有原因，唔准就咁加個名落去。
     ping／status／test：部署同 CI 探活（dev-server、tests、人手 GET /exec）。
     repairDb／saveDbForce：DEPLOY_GUIDE_FOR_TROOPS.md 嘅人手搶救步驟。
     syncCheck：後端自證「寫得入＋讀得返」能力，tests/e2ereal.mjs 直接經 proxy 驗。 */
  const INTENTIONAL_NO_CALLER = new Map([
    ['ping', '部署探活（人手 GET /exec、CI）'],
    ['status', '部署探活＋初始化狀態（人手／CI）'],
    ['test', 'status 別名（舊部署相容）'],
    ['repairDb', '人手搶救：清暫存垃圾＋舊版本段（部署指南）'],
    ['saveDbForce', '人手搶救：用留住資料嗰部機強制覆蓋（部署指南）'],
    ['syncCheck', '後端寫入＋讀回自證（tests/e2ereal.mjs 經 proxy 驗）'],
    ['authWhoAmI', '/api/progress server-to-server 核對 opaque session；唔由瀏覽器直接 call'],
    ['loadMine', '/api/progress 將 myProgress 改寫成只回本人嘅 server-to-server action'],
    ['getLinkState', '現行非 Unified Code.gs 的 legacy 簽名兼容；Progress client/API 明確不路由，待正式遷移後刪除'],
    ['setLocalLogin', '現行非 Unified Code.gs 的 legacy 簽名兼容；Progress client/API 明確不路由，待正式遷移後刪除']
  ]);
  const feActions = new Set();
  for (const f of ALL.filter(f => (/^assets\/js\//.test(rel(f)) && /\.js$/.test(f)) || rel(f) === 'reset-password.html')) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/action:\s*'([a-zA-Z]+)'/g)) feActions.add(m[1]);
  }
  const orphans = [...gasHandles].filter(a => !feActions.has(a)).sort();
  const unregistered = orphans.filter(a => !INTENTIONAL_NO_CALLER.has(a));
  ok(unregistered.length === 0,
    `冇未登記嘅孤兒 action（後端 ${gasHandles.size} 個 handler，${orphans.length} 個冇前端呼叫者但已登記）`,
    `呢啲 action 後端有 handler 但前端冇人 call：${unregistered.join(', ')}\n`
    + '      要嘛接返前端 UI，要嘛刪除 handler＋白名單，\n'
    + '      要嘛喺 scripts/lint.mjs ⑦ INTENTIONAL_NO_CALLER 登記並寫低原因。');
  /* 登記冊本身都唔可以腫：登記咗但已經不存在／已經有前端呼叫者 → 要清走 */
  const staleEntries = [...INTENTIONAL_NO_CALLER.keys()].filter(a => !orphans.includes(a));
  ok(staleEntries.length === 0, '孤兒登記冊冇過期項目（已刪或已接返前端嘅要移除）',
    staleEntries.join(', '));
}

/* ============================================================
   ⑧ 導覽文字唔可以指去唔存在嘅路（★ 2026-11-12 UI 簡化）
   ------------------------------------------------------------
   背景：用家「東指西指」。「資料管理」本來係「系統」底下嘅中轉分頁，
   於是全個 repo 有 40+ 處教人「系統 → 資料管理 → …」。
   2026-11-12 把「資料管理」升做側欄獨立入口之後，呢啲指示全部變咗錯。
   第一輪改咗 48 處 JS；發佈前反查再發現 README 同現行操作手冊仲有舊路，
   所以守門要同時掃 app 文案同現行 Markdown（歷史記錄除外）。
   ============================================================ */
section('⑧ 導覽指示唔可以指去已拆走嘅路');
{
  const STALE_TEXT = [
    ['系統 → 資料管理', '「資料管理」已經係側欄獨立入口，唔再喺「系統」入面'],
    ['系統→資料管理', '同上（冇空格寫法）'],
    ['管理 → 資料管理', '舊「管理」指路已拆；而家直接去「資料管理」'],
    ['財務 → 財政年度報告', '年度報告分頁已拆（重複入口）；而家係「財務 → 年結報告」頂欄掣'],
    ['財務 → 匯入舊帳', '匯入工具已併入「財務 → 設定 → 匯入舊帳」'],
    ['表格與同步', '舊主項目已改名「資料管理」'],
    ['系統 → 帳戶', '帳戶已搬到「用戶與身份 → 身份與帳號」'],
    ['財務 → 年度設定', '分頁而家叫「財務 → 設定」'],
    ['用戶 → 生日', '主項目同分頁而家叫「用戶與身份 → 生日表」'],
    ['通告 → 所有報名', '分頁而家叫「通告 → 報名紀錄」'],
    ['立即儲存到後端', '按鈕而家叫「儲存到後端」']
  ];
  const STALE_CODE = [
    ...STALE_TEXT,
    ['data-go="#/admin/data"', '內部按鈕要直去 #/tables；舊 hash 只留畀外部書籤轉址'],
    ['href="#/admin/data"', '內部連結要直去 #/tables；舊 hash 只留畀外部書籤轉址']
  ];
  const bad = [];
  const scan = (f, stale) => {
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const [needle, why] of stale) {
        if (line.includes(needle)) bad.push(`${rel(f)}:${i + 1}  「${needle}」 —— ${why}`);
      }
    });
  };
  for (const f of ALL.filter(f => /^assets\/js\//.test(rel(f)) && /\.js$/.test(f))) scan(f, STALE_CODE);
  /* 現行操作文件要守；歷史更新、CHANGELOG 同審核報告會刻意記低舊路，唔應該假紅。 */
  const currentDocs = ALL.filter(f => {
    const r = rel(f);
    return /\.md$/.test(r)
      && r !== 'CHANGELOG.md'
      && r !== 'UI_AUDIT_2026-11-12.md'
      && !/^docs\/UPDATES_/.test(r);
  });
  currentDocs.forEach(f => scan(f, STALE_TEXT));
  ok(bad.length === 0, 'app 文案同現行手冊冇指去已拆走嘅導覽路徑', bad.slice(0, 12).join('\n      '));
}

console.log(`\n──────── lint 結果：${checks - fails} 通過 / ${fails} 失敗 ────────`);
process.exit(fails ? 1 : 0);
