#!/usr/bin/env node
/* 單一 repo 體檢：L0 開局 / L1 每次 commit / L2 每季全倉，見 docs/30。
   零第三方依賴（S 規則）。用法：
     node scripts/repo_health_v1.0.mjs <repo-path> [--json]
     node scripts/repo_health_v1.0.mjs . --json > health.json
   exit 1 = 有 FAIL（CI 用）；--json stdout 只有一份 JSON。
*/
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const VERSION = 'v1.0';
const root = path.resolve(process.argv[2] || '.');
const asJson = process.argv.includes('--json');
const checks = [];
const add = (id, level, detail) => checks.push({ id, level, detail });
const rel = (p) => path.relative(root, p).replace(/\\/g, '/') || '.';

const IGNORE_DIR = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.vercel', '.cache', 'coverage', '__pycache__', '.venv']);
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.gs', '.html', '.css', '.sh', '.bat', '.sql', '.csv', '.env', '.example', '']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIR.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else out.push({ p, size: st.size });
  }
  return out;
}

const all = walk(root);
const textFiles = all.filter((f) => {
  const ext = path.extname(f.p).toLowerCase();
  return TEXT_EXT.has(ext) && f.size < 2 * 1024 * 1024;
});
const names = new Set(all.map((f) => path.basename(f.p).toLowerCase()));
const has = (n) => names.has(n.toLowerCase());

function git(...args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

/* 1. Git 狀態 */
const isRepo = existsSync(path.join(root, '.git'));
const branch = isRepo ? git('rev-parse', '--abbrev-ref', 'HEAD') : '';
const dirty = isRepo ? git('status', '--porcelain').split('\n').filter(Boolean).length : 0;
const last = isRepo ? git('log', '-1', '--format=%h %ad', '--date=short') : '';
add('git', isRepo ? 'PASS' : 'WARN', isRepo ? `${branch} · ${dirty} 個未提交改動 · last ${last || 'n/a'}` : '唔係 git repo（或 .git 喺上一層）');

/* 2. 起手包 12 樣（docs/27） */
const REQUIRED = [
  ['R', 'README.md', 'README'], ['L', 'LICENSE', 'LICENSE*'], ['A', 'AGENTS.md', 'AGENTS.md'],
  ['O', 'SCOPE.md', 'SCOPE.md'], ['Y', 'GLOSSARY.md', 'GLOSSARY.md'], ['C', 'CONTRIBUTING.md', 'CONTRIBUTING.md'],
  ['H', 'CHANGELOG.md', 'CHANGELOG.md'], ['G', '.gitignore', '.gitignore'], ['D', 'docs/', 'docs/'],
  ['S', 'scripts/', 'scripts/'], ['T', 'tests/', 'tests/'], ['W', '.github/workflows/', '.github/workflows/'],
];
const missing = [];
for (const [code, label, hint] of REQUIRED) {
  let ok;
  if (label.endsWith('/')) ok = existsSync(path.join(root, label));
  else if (label === 'LICENSE*') ok = all.some((f) => /^licen[cs]e/i.test(path.basename(f.p)) && rel(f.p) === path.basename(f.p));
  else if (label === '.github/workflows/') ok = walk(path.join(root, '.github', 'workflows')).some((f) => /\.ya?ml$/.test(f.p));
  else ok = existsSync(path.join(root, label));
  if (!ok) missing.push(`${code}:${hint}`);
}
add('starter', missing.length ? 'WARN' : 'PASS', missing.length ? `缺 ${missing.join(', ')}` : '12 樣齊');
if (!names.has('license')) add('license', 'WARN', '無 LICENSE：公開 repo 預設版權保留（docs/20 低風險項）');

/* 3. Secret / .env / 注入版（A1/W6） */
const SECRETS = [
  ['OpenAI key', /sk-(live|proj)-[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Bearer token 字面值', /Bearer\s+[A-Za-z0-9._-]{24,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
];
const leaks = [];
const envFiles = [];
const placeholders = [];
for (const f of textFiles) {
  const r = rel(f.p);
  if (/^\.env($|\.)/.test(path.basename(r)) && !/\.example$/.test(r)) envFiles.push(r);
  let txt;
  try { txt = readFileSync(f.p, 'utf8'); } catch { continue; }
  if (/\{\{[A-Z_]+\}\}/.test(txt) && !r.startsWith('templates/') && !r.includes('repo-starter') && !r.includes('LICENSE-MIT')) placeholders.push(r);
  for (const [name, re] of SECRETS) if (re.test(txt)) leaks.push(`${r} (${name})`);
}
add('secrets', leaks.length ? 'FAIL' : 'PASS', leaks.length ? `疑似真 key：${leaks.join(', ')}` : `scan 咗 ${textFiles.length} 個文字檔，無疑似 secret`);
add('env', envFiles.length ? 'FAIL' : 'PASS', envFiles.length ? `.env 入咗 repo：${envFiles.join(', ')}` : '無本機 .env 檔');
add('placeholders', placeholders.length ? 'WARN' : 'PASS', placeholders.length ? `未填 {{...}}：${placeholders.slice(0, 5).join(', ')}` : '無未填 placeholder');

/* 4. 體積 / 大檔（S） */
const total = all.reduce((s, f) => s + f.size, 0);
const big = all.filter((f) => f.size > 5 * 1024 * 1024).sort((a, b) => b.size - a.size).slice(0, 5);
const distDir = existsSync(path.join(root, 'dist')) || existsSync(path.join(root, 'build'));
add('size', big.length || distDir ? 'WARN' : 'PASS',
  `${(total / 1024 / 1024).toFixed(1)} MB · ${all.length} 檔` +
  (big.length ? ` · >5MB: ${big.map((f) => `${rel(f.p)}(${(f.size / 1024 / 1024).toFixed(1)}MB)`).join(', ')}` : '') +
  (distDir ? ' · dist/build 存在（唔好 commit）' : ''));

/* 5. Markdown 內部連結（G10） */
const mds = textFiles.filter((f) => f.p.endsWith('.md'));
const broken = [];
const linkRe = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
for (const f of mds) {
  let txt;
  try { txt = readFileSync(f.p, 'utf8'); } catch { continue; }
  let fence = false;
  for (const line of txt.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;                       // code block 入面嘅 [...]() 唔係連結
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(line))) {
      let t = m[1];
      if (/^(https?:|mailto:|data:|#)/.test(t)) continue;
      t = t.split('#')[0].split('?')[0];
      if (!t) continue;
      if (!existsSync(path.resolve(path.dirname(f.p), t))) broken.push(`${rel(f.p)} → ${t}`);
    }
  }
}
add('links', broken.length ? 'FAIL' : 'PASS', broken.length ? `壞連結 ${broken.length} 條：${broken.slice(0, 4).join(', ')}` : `驗咗 ${mds.length} 份 MD 嘅內部連結`);

/* 6. 未改嘅 scaffold README / 空 repo */
const readme = existsSync(path.join(root, 'README.md')) ? readFileSync(path.join(root, 'README.md'), 'utf8') : '';
const scaffold = /bootstrapped with \[`create-next-app`\]|This template provides a minimal setup to get React working in Vite/i.test(readme);
add('scaffold', scaffold ? 'WARN' : 'PASS', scaffold ? 'README 仲係 create-next-app / Vite 預設文' : all.length < 3 ? '檔案極少，可能係空殼／預留 repo' : 'README 似已填');

/* 7. Cron + git commit（docs/20 教訓） */
const wf = walk(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f.p));
const cronCommit = [];
for (const f of wf) {
  const t = readFileSync(f.p, 'utf8');
  if (/schedule:/.test(t) && /git\s+(add|commit|push)/.test(t)) cronCommit.push(rel(f.p));
}
add('cron-data', cronCommit.length ? 'WARN' : 'PASS', cronCommit.length ? `定時 workflow 會 commit 資料：${cronCommit.join(', ')}；改用 data 分支快照／artifact（docs/20/21）` : wf.length ? `${wf.length} 個 workflow，無 cron+commit 模式` : '無 workflow');

/* 8. Skills frontmatter（有 skills/ 先跑） */
const csPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'check_skills_v1.0.mjs');
if (all.some((f) => path.basename(f.p) === 'SKILL.md')) {
  if (existsSync(csPath)) {
    const r = spawnSync(process.execPath, [csPath, root, '--json'], { encoding: 'utf8' });
    try {
      const j = JSON.parse(r.stdout);
      add('skills', j.ok ? 'PASS' : 'FAIL', j.ok ? `${j.skills} 份 SKILL.md 合格` : j.errors.slice(0, 4).join(' | '));
    } catch { add('skills', 'WARN', 'frontmatter checker 輸出唔到 JSON'); }
  } else add('skills', 'WARN', '有 skills/ 但搵唔到 check_skills 腳本');
}

const counts = checks.reduce((o, c) => (o[c.level] = (o[c.level] || 0) + 1, o), {});
const ok = !counts.FAIL;
const hktDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // Asia/Hong_Kong = UTC+8
const result = {
  tool: 'repo_health', version: VERSION, repo: root, date: hktDate,
  ok, counts, files: all.length, size_mb: +(total / 1024 / 1024).toFixed(2),
  git: { branch, dirty, last }, checks,
};
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`REPO HEALTH — ${rel(root) || root} (${result.date})`);
  for (const c of checks) console.log(`  ${c.level.padEnd(4)} ${c.id.padEnd(12)} ${c.detail}`);
  console.log(`  => ${ok ? 'PASS' : 'FAIL'}  (PASS ${counts.PASS || 0} / WARN ${counts.WARN || 0} / FAIL ${counts.FAIL || 0})`);
}
process.exit(ok ? 0 : 1);
