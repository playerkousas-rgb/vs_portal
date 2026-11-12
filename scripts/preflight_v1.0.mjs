#!/usr/bin/env node
/* 開局前閘門（AGENT gate）：一次過行晒 L0 檢查，FAIL 就 exit 1，AGENT 唔好開工。
   零第三方依賴；邏輯全部複用真理倉四支 script，呢支只係 orchestrator，唔複製第二份規則。
   用法： node scripts/preflight_v1.0.mjs <repo-path> [--json] [--allow-placeholders]
   --allow-placeholders 只用於驗「真理倉／起手包範本」本身（範本本來就有 placeholder）。
*/
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = 'v1.0';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const allowPlaceholders = args.includes('--allow-placeholders');
const root = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const checks = [];
const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 400) });

if (!existsSync(root) || !statSync(root).isDirectory()) {
  const r = { tool: 'preflight', version: VERSION, repo: root, ok: false,
    checks: [{ id: 'target', ok: false, detail: '目標路徑唔存在／唔係資料夾' }] };
  console.log(asJson ? JSON.stringify(r, null, 2) : 'FAIL — 目標路徑唔存在／唔係資料夾');
  process.exit(1);
}

/* 1. AGENT 未抄齊 scripts/ 就唔好開工（呢個係最常見嘅「以為 set 好」錯誤） */
const NEED = ['guard.mjs', 'final_check_v1.0.mjs', 'repo_health_v1.0.mjs', 'check_skills_v1.0.mjs'];
const scriptsDir = path.join(root, 'scripts');
const missing = NEED.filter((n) => !existsSync(path.join(scriptsDir, n)));
add('scripts', missing.length === 0, missing.length
  ? `未由真理倉抄齊 scripts/：${missing.join(', ')}（見 docs/27 §5）`
  : `4 支真理 script 齊（${NEED.join(', ')}）`);
const canRun = missing.length === 0;

/* 2. 行一次檔案清單 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(root);
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const TEXT = /\.(md|txt|json|yml|yaml|html|css|js|mjs|cjs|ts|tsx|gs)$/i;
const textFiles = files.filter((p) => TEXT.test(p));
const isTemplate = (p) => /(^|\/)(templates|repo-starter)\//.test(rel(p)) || rel(p).includes('repo-starter');

/* 3. Placeholder：交付 repo 要零；範本先可以用 --allow-placeholders */
const ph = [];
for (const p of textFiles) {
  if (isTemplate(p) || rel(p).includes('LICENSE-MIT')) continue;
  try { if (/\{\{[A-Z_]+\}\}/.test(readFileSync(p, 'utf8'))) ph.push(rel(p)); } catch { /* binary */ }
}
add('placeholders', allowPlaceholders || ph.length === 0,
  allowPlaceholders ? `範本模式：略過 placeholder（${ph.length} 個檔有，屬正常）`
    : ph.length ? `未填 placeholder：${ph.slice(0, 6).join(', ')}${ph.length > 6 ? ' …' : ''}` : '無未填 placeholder');

/* 4. UTF-8 無雙重編碼／壞字（對應 taste-skill 嘅 check-skills.yml，但零依賴）
   用 \u escape 寫，避免 checker 自己個 regex 變成「壞字」例子，自己中自己。 */
const MOJIBAKE = new RegExp('[\\u00C3\\u00C2][\\u00A9\\u00A8\\u00AA\\u00B0\\u00BC\\u00BD\\u00BE].');
const badUtf8 = [];
for (const p of textFiles) {
  try {
    const t = readFileSync(p, 'utf8');
    if (t.includes('\uFFFD') || MOJIBAKE.test(t)) badUtf8.push(rel(p));
  } catch { /* skip */ }
}
add('utf8', badUtf8.length === 0, badUtf8.length
  ? `雙重編碼／壞 UTF-8：${badUtf8.slice(0, 5).join(', ')}` : `${textFiles.length} 個文字檔 UTF-8 clean`);

/* 5. 所有 .mjs 都 parse 到 */
const mjs = files.filter((p) => p.endsWith('.mjs'));
const badSyntax = [];
for (const p of mjs) {
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status !== 0) badSyntax.push(rel(p));
}
add('syntax', badSyntax.length === 0, badSyntax.length
  ? `node --check 失敗：${badSyntax.join(', ')}` : `${mjs.length} 個 .mjs parse 到`);

/* 6–9. 複用四支真理 script（全部零依賴） */
function run(name, extra = [], parseJson = false) {
  const script = path.join(scriptsDir, name);
  if (!existsSync(script)) return { ok: false, detail: `搵唔到 scripts/${name}` };
  const r = spawnSync(process.execPath, [script, ...extra], { cwd: root, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (parseJson) {
    try {
      const j = JSON.parse(r.stdout);
      if (j.ok === true && r.status === 0) return { ok: true, detail: 'ok: true', json: j };
      const bad = []
        .concat((j.results || []).filter((x) => x.ok === false).map((x) => `${x.id}: ${x.detail}`))
        .concat((j.checks || []).filter((x) => x.level === 'FAIL').map((x) => `${x.id}: ${x.detail}`))
        .concat(j.errors || []);
      return { ok: false, detail: bad.length ? bad.slice(0, 4).join(' | ') : out.slice(-200) };
    } catch { return { ok: false, detail: '輸出唔到 JSON：' + out.slice(-160) }; }
  }
  const errLines = out.split('\n').filter((l) => /^\s*[✗❌]/.test(l)).slice(0, 4);
  return { ok: r.status === 0,
    detail: r.status === 0
      ? (out.trim().split('\n').filter(Boolean).pop() || '無輸出').slice(0, 200)
      : (errLines.length ? errLines.join(' | ') : out.slice(-200)) };
}
if (canRun) {
  let r = run('guard.mjs');
  add('guard', r.ok, r.ok ? `G10／A1／S 全綠 — ${r.detail}` : r.detail);
  r = run('final_check_v1.0.mjs', ['--json'], true);
  add('final_check', r.ok, r.ok ? '六角度 ok: true' : r.detail);
  r = run('repo_health_v1.0.mjs', [root, '--json'], true);
  add('repo_health', r.ok, r.ok ? '無 FAIL（WARN 入 backlog，唔阻塞）' : r.detail);
  r = run('check_skills_v1.0.mjs', [root, '--json'], true);
  add('check_skills', r.ok, r.ok
    ? (r.json && r.json.skills ? `${r.json.skills} 份 SKILL.md frontmatter 合格` : '無 SKILL.md')
    : r.detail);
} else {
  for (const id of ['guard', 'final_check', 'repo_health', 'check_skills'])
    add(id, false, '略過：scripts/ 未抄齊');
}

const failed = checks.filter((c) => !c.ok);
const result = {
  tool: 'preflight', version: VERSION, repo: root,
  ok: failed.length === 0,
  mode: allowPlaceholders ? 'template-source' : 'target-repo',
  counts: { pass: checks.length - failed.length, fail: failed.length },
  checks,
};
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id.padEnd(14)} ${c.detail}`);
  console.log(failed.length
    ? `\n❌ PREFLIGHT FAIL — ${failed.length} 項未過，AGENT 唔好設定／commit 呢個 repo`
    : `\n✅ PREFLIGHT PASS — ${checks.length}/${checks.length} 項過，AGENT 可以開工`);
}
process.exit(failed.length ? 1 : 0);
