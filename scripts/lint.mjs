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
for (const f of ALL.filter(f => /^assets\/js\//.test(rel(f)) && /\.js$/.test(f))) {
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

/** 白名單入面嘅 action 後端（Code.gs）真係識做 —— 唔好放行咗但後端冇 */
const gasSrc = fs.readFileSync(gas, 'utf8');
const gasHandles = new Set([...gasSrc.matchAll(/body\.action === '([a-zA-Z]+)'/g)].map(m => m[1]));
const ghost = [...PROXY_ALLOW].filter(a => !gasHandles.has(a) && !['submitRegistration', 'test', 'ping'].includes(a));
ok(ghost.length === 0, '白名單冇「放行咗但後端唔識」嘅 action', ghost.join(', '));

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

console.log(`\n──────── lint 結果：${checks - fails} 通過 / ${fails} 失敗 ────────`);
process.exit(fails ? 1 : 0);
