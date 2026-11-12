#!/usr/bin/env node
/**
 * guard.mjs — 自動防呆檢查（S12 / F14 / F16 / A1 / W1 / W6 / V6）
 *
 * 設計目標：本機同 CI 跑**同一條命令**，零 dependency（S1）。
 *   node scripts/guard.mjs            # 全部檢查
 *   node scripts/guard.mjs --assets   # 只查資源體積（npm run slim:dead 用）
 *   node scripts/guard.mjs --ci       # CI（同一套）
 *
 * 守：必需檔 / 疑似 secret（含注入版）/ 大檔 / 垃圾檔 / 圖同 dist 體積 /
 *     .vercelignore / Markdown 內部連結 + 錨點 /
 *     A1/W6 build bundle key leak / vite loadEnv 空前綴 / client URL ?key= /
 *     W1 版權標示 / W2 水印常數 / W6 注入版唔入 repo /
 *     V1 檔名+內文雙版號 / V4 部署拷貝同步 / V6 contract fileVersion /
 *     F16 PLAYBOOK 規則 ID 同步 / as-built 案例留存 + docs/19 案例隔離 / docs/23 設計資源索引 /
 *     A16 Actions pin SHA（workflow + templates/github 範本）。
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const ASSETS_ONLY = ARGS.has('--assets');
const CI = ARGS.has('--ci');

const SKIP_DIRS = new Set([
  '.git', '.github', 'node_modules', 'dist', 'build', 'out', '.vercel', '.cache',
  'coverage', '.nyc_output', '.arena', '.venv', '__pycache__', 'Unselected files',
]);
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.gs', '.html', '.css', '.yml', '.yaml', '.sql', '.toml', '.sh', '.py',
  '.env', '.example', '.gitignore', '.vercelignore', '',
]);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg']);
const BANNED_EXT = new Set(['.bak', '.tmp', '.old', '.orig', '.log', '.zip', '.tar', '.gz', '.7z', '.psd', '.mp4', '.mov', '.dmg', '.exe']);
const INJECTED_NAME = /(_local_|_injected|\.keyed\.|_keyed)/i;

const errors = [];
const warns = [];
const checks = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);
const ok = (m) => checks.push(m);
const rel = (p) => path.relative(ROOT, p) || '.';

function walk(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push({ p, size: st.size, ext: path.extname(name).toLowerCase(), name });
  }
  return out;
}

const files = walk();
const isTruthRepo = existsSync(path.join(ROOT, 'PLAYBOOK.md'));
const read = (r) => readFileSync(path.join(ROOT, r), 'utf8');

/* ---------- 1. 必需檔 ---------- */
function requireFiles(list, label) {
  const missing = list.filter((f) => !existsSync(path.join(ROOT, f)));
  if (missing.length) err(`${label} 缺檔：${missing.join(', ')}`);
  else ok(`${label} 必需檔齊（${list.length}）`);
}

if (!ASSETS_ONLY) {
  if (isTruthRepo) {
    requireFiles([
      'README.md', 'PLAYBOOK.md', 'AGENTS.md', 'BUILD.md', 'EXTERNAL.md',
      '進度追蹤旅系統升級版.md',
      'docs/00-quickcard.md', 'docs/01-slim.md', 'docs/02-foolproof.md', 'docs/03-security.md',
      'docs/04-settings-super.md', 'docs/05-git.md', 'docs/06-vercel.md',
      'docs/07-apps-script.md', 'docs/08-supabase.md', 'docs/09-gemini-canvas.md',
      'docs/10-checklists.md', 'docs/11-incidents.md',
      'docs/12-copyright-scout-system.md', 'docs/13-versioning.md', 'docs/14-api-key-injection.md',
      'docs/15-resource-index.md', 'docs/16-canvas-case-scout-comic.md',
      'docs/17-final-check-and-tutorial.md', 'docs/18-as-built-gap-audit.md',
      'docs/19-ecportal-troop-case.md', 'docs/20-repo-health-audit.md',
      'docs/21-fix-plans.md', 'docs/22-scout-circulars-agent-handoff.md',
      'docs/23-design-resources.md',
      'scripts/audit_single_html_v1.0.mjs', 'scripts/refresh_resources_v1.0.mjs',
      'scripts/final_check_v1.0.mjs',
      'templates/README.md', 'templates/watermark/README.md',
      'templates/watermark/drawscout_decoder_v1.0.html',
      'templates/watermark/scout_watermark_codec_v1.0.mjs',
      'templates/watermark/scout_generator_v1.0.html',
      'templates/watermark/inject_key_v1.0.mjs',
      'templates/watermark/watermark.test.mjs',
      'templates/canvas/brain_v1.0.gs', 'templates/canvas/shell_v1.0.html',
      'templates/canvas/contract_v1.0.json', 'templates/canvas/sync_canvas_v1.0.mjs',
      'templates/canvas/brain.test.mjs',
      '.github/workflows/guard.yml',
    ], '真理倉');
  } else {
    const base = ['README.md', '.gitignore'];
    if (existsSync(path.join(ROOT, 'package.json'))) base.push('.env.example', '.vercelignore', 'vercel.json');
    requireFiles(base, 'App repo');
  }
}

/* ---------- 2. .vercelignore（S2） ---------- */
function checkVercelIgnore() {
  const candidates = ['.vercelignore', 'templates/vercel/vercelignore'];
  const found = candidates.find((c) => existsSync(path.join(ROOT, c)));
  if (!found) { err('S2：搵唔到 .vercelignore（或 templates/vercel/vercelignore）'); return; }
  const txt = read(found);
  const need = ['node_modules/', '.git/', '.cache/', '*.bak', '*.log', 'docs/'];
  const miss = need.filter((n) => !txt.includes(n));
  if (miss.length) err(`S2：${found} 欠 ${miss.join(', ')}`);
  else ok(`S2：${found} 內容完整`);
}

/* ---------- 3. 垃圾檔 / 大檔 / 圖片 / 注入版（S5/S6/S10/W6） ---------- */
function checkHygiene() {
  for (const f of files) {
    const r = rel(f.p);
    if (BANNED_EXT.has(f.ext)) err(`S5：垃圾檔 ${r}（${f.size} B）— 用 Git 歷史保存舊版`);
    if (INJECTED_NAME.test(f.name)) err(`W6/A1：注入版 ${r} 唔可以喺 repo — 本機用完即刻刪（docs/14-api-key-injection.md）`);
    // C13-g：單一 HTML / Gemini Canvas app 唔經 Vercel、唔使瘦身；硬上限 5MB。
    // 其他檔案先至用 S10 嘅 < 1MB 原則。
    if (f.ext === '.html') {
      if (f.size > 5 * 1024 * 1024)
        err(`C13-g：單一 HTML ${r}（${(f.size / 1024 / 1024).toFixed(2)} MB）> 5MB Gemini Canvas 上限 — 減 base64／外置圖`);
    } else if (f.size > 1024 * 1024) {
      err(`S10：大檔 ${r}（${(f.size / 1024 / 1024).toFixed(2)} MB）— 用 LFS 或移走`);
    }
    if (IMG_EXT.has(f.ext) && f.size > 500 * 1024) err(`S6：圖 ${r}（${Math.round(f.size / 1024)} KB）> 500KB`);
  }
  ok(`S5/S6/S10/W6/C13-g：掃咗 ${files.length} 個檔（HTML 5MB 例外）`);
}

/* ---------- 4. dist 體積（S7） ---------- */
function checkDist() {
  const d = path.join(ROOT, 'dist');
  if (!existsSync(d)) { ok('S7：無 dist（跳過，CI build 後會再驗）'); return; }
  let total = 0, biggest = 0;
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of readdirSync(cur)) {
      const p = path.join(cur, n), st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else { total += st.size; biggest = Math.max(biggest, st.size); }
    }
  }
  if (total >= 5 * 1024 * 1024) err(`S7：dist ${(total / 1024 / 1024).toFixed(2)} MB >= 5MB`);
  else ok(`S7：dist ${(total / 1024 / 1024).toFixed(2)} MB < 5MB`);
  if (biggest >= 2 * 1024 * 1024) err(`S7：單一 bundle ${(biggest / 1024 / 1024).toFixed(2)} MB >= 2MB`);
}

/* ---------- 5. 疑似 secret（A1/W6） ---------- */
const SECRET_PATTERNS = [
  { name: 'Gemini API key', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'OpenAI key', re: /sk-(live|proj)-[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/ },
];

function checkSecrets() {
  let scanned = 0, envLocal = 0;
  for (const f of files) {
    if (!TEXT_EXT.has(f.ext) && !f.name.startsWith('.env')) continue;
    // C13-g：單一 HTML 可以去到 5MB，唔可以用舊嘅 2MB 上限跳過 secret scan
    const limit = f.ext === '.html' ? 5 * 1024 * 1024 : 2 * 1024 * 1024;
    if (f.size > limit) { warn(`A1：${rel(f.p)} 太大（${f.size} B），跳過文字 scan — 人手確認`); continue; }
    let txt;
    try { txt = readFileSync(f.p, 'utf8'); } catch { continue; }
    scanned++;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(txt)) err(`A1：疑似 ${p.name} 喺 ${rel(f.p)} — 即刻 rotate（docs/11-incidents.md）`);
    }
    // .env.local / .env.production 等係本機正常檔；重點係 .gitignore 要擋（下面 checkEnvIgnore）
    if (/^\.env(\.|$)/.test(f.name) && !f.name.endsWith('.example')) envLocal++;
  }
  ok(`A1：scan 咗 ${scanned} 個文字檔（含 5MB HTML；${envLocal} 個本機 .env* 交畀 .gitignore 管）`);
}

/* ---------- 5d. 本機 .env* 一定要被 gitignore 擋（A1） ---------- */
function checkEnvIgnore() {
  const gi = ['.gitignore', 'templates/git/gitignore'].find((c) => existsSync(path.join(ROOT, c)));
  if (!gi) { err('A1：搵唔到 .gitignore'); return; }
  const txt = read(gi);
  if (!/\.env/.test(txt)) err(`A1：${gi} 無 .env 規則 — 本機 secret 會誤入 Git`);
  else ok(`A1：${gi} 有擋 .env*`);
}

/* ---------- 5b. build bundle key leak（A1/W6，docs/14 §3） ---------- */
function checkBundleLeak() {
  const d = path.join(ROOT, 'dist');
  if (!existsSync(d)) { ok('A1/W6：無 dist（build 後會再 scan bundle key）'); return; }
  let n = 0;
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const p = path.join(cur, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!/\.(js|mjs|cjs|ts|tsx|jsx|html|css|json|map)$/.test(name)) continue;
      if (st.size > 5 * 1024 * 1024) continue;
      n++;
      const txt = readFileSync(p, 'utf8');
      for (const s of SECRET_PATTERNS) {
        if (s.re.test(txt)) err(`A1/W6：build bundle ${rel(p)} 有疑似 ${s.name} — AI Studio export inline key 事件（docs/14 §3）`);
      }
    }
  }
  ok(`A1/W6：scan 咗 dist ${n} 個檔（bundle key leak）`);
}

/* ---------- 5c. Vite 空前綴 + key 落 URL（A1/W6） ---------- */
function checkEnvLeakPattern() {
  let vite = 0, urlKey = 0;
  for (const f of files) {
    if (!TEXT_EXT.has(f.ext) && !f.name.startsWith('.env')) continue;
    if (f.size > (f.ext === '.html' ? 5 * 1024 * 1024 : 2 * 1024 * 1024)) continue;
    const txt = readFileSync(f.p, 'utf8');
    const r = rel(f.p);
    if (/^vite\.config\./.test(f.name)) {
      vite++;
      if (/loadEnv\s*\([^)]*,\s*(['"])\1\s*\)/.test(txt))
        err(`A1：${r} 用咗 loadEnv(..., '') 空前綴 — 會 inline 晒所有 env 入 client bundle（docs/14 §3）`);
      if (/define\s*:[^;]{0,400}process\.env\.(?:GEMINI_)?API_KEY/.test(txt))
        err(`A1：${r} 用 define 將 API_KEY 字面替換入 client bundle（docs/14 §3）`);
    }
    // client-facing 檔（交付 HTML／前端源碼）唔准將 key 放 URL query；
    // .gs / api/ 係 server-side，scripts/ 係工具（本身會有 regex），兩者豁免
    const frontSrc = /(^|\/)(src|public|app|pages|assets|components|lib)\//.test(r);
    const client = f.ext === '.html' ||
      (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(f.ext) && frontSrc && !/(^|\/)api\//.test(r));
    // 只捉真 code（?key=${...} / 字串串接 / 寫死 key）；註解同說明文字唔算
    const urlKeyCode = /\?key\s*=\s*(?:\$\{|['"][^'"]*['"]?\s*\+|['"]?AIza[0-9A-Za-z_-]{20,})/.test(txt);
    if (client && urlKeyCode) {
      urlKey++;
      err(`A1/W6：${r} 將 key 放喺 URL query（?key=...）— 改用 x-goog-api-key header 或 server route`);
    }
  }
  ok(`A1/W6：vite.config ${vite} 份、client URL key ${urlKey} 個（空前綴／URL key 檢查）`);
}

/* ---------- 6. Markdown 內部連結（G10） ---------- */
function checkLinks() {
  const mds = files.filter((f) => f.ext === '.md');
  let links = 0;
  for (const f of mds) {
    const txt = readFileSync(f.p, 'utf8');
    const re = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(txt))) {
      let target = m[1];
      if (/^(https?:|mailto:|data:|#)/.test(target)) continue;
      links++;
      target = target.split('#')[0].split('?')[0];
      if (!target) continue;
      try { target = decodeURIComponent(target); } catch { /* 保留原樣 */ }
      if (!existsSync(path.resolve(path.dirname(f.p), target))) err(`G10：壞連結 ${rel(f.p)} → ${target}`);
    }
  }
  ok(`G10：驗咗 ${mds.length} 份 MD 嘅 ${links} 條內部連結`);
}

/* ---------- 6b. Markdown 錨點（G10） ---------- */
function mdSlug(h) {
  return h.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')   // GitHub 式：去標點、留中英文／數字／連字符
    .replace(/ /g, '-');
}

function checkAnchors() {
  const mds = files.filter((f) => f.ext === '.md');
  const anchors = new Map();
  for (const f of mds) {
    const set = new Set();
    let fence = false;
    for (const line of readFileSync(f.p, 'utf8').split('\n')) {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }   // 唔好將 code 入面嘅 # 當標題
      if (fence) continue;
      const m = /^#{1,6}\s+(.+)$/.exec(line);
      if (m) set.add(mdSlug(m[1]));
    }
    anchors.set(path.resolve(f.p), set);
  }
  let n = 0;
  for (const f of mds) {
    const txt = readFileSync(f.p, 'utf8');
    const re = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(txt))) {
      const t = m[1];
      if (/^(https?:|mailto:|data:)/.test(t) || !t.includes('#')) continue;
      const [p, a] = t.split('#');
      if (!a) continue;
      const target = path.resolve(path.dirname(f.p), p || path.basename(f.p));
      const set = anchors.get(target);
      if (!set) continue;                        // 缺檔由 checkLinks 負責
      n++;
      if (!set.has(a)) err(`G10：壞錨點 ${rel(f.p)} → ${t}（目標檔冇 #${a}）`);
    }
  }
  ok(`G10：驗咗 ${n} 條 Markdown 錨點`);
}

/* ---------- 7. 雙版號（V1/V2/V4/V6） ---------- */
const VERSIONED = /_v(\d+\.\d+(?:\.\d+)?)(?=[._-]|$)/;

function checkVersionSync() {
  let n = 0;
  for (const f of files) {
    const m = f.name.match(VERSIONED);
    if (!m) continue;
    n++;
    const tag = `v${m[1]}`;
    if (!TEXT_EXT.has(f.ext)) continue;
    const txt = readFileSync(f.p, 'utf8');
    if (!txt.includes(tag)) { err(`V1：${rel(f.p)} 檔名有 ${tag} 但內文冇 — 要同步改`); continue; }
    const others = [...new Set(txt.match(/v\d+\.\d+(?:\.\d+)?/g) || [])].filter((v) => v !== tag);
    if (others.length) err(`V1：${rel(f.p)} 內文版號唔一致：${others.join(',')} vs ${tag}（V3 五步）`);
  }
  ok(`V1/V3：${n} 個版本化檔嘅檔名版號 = 內文版號`);

  // contract fileVersion
  const contract = files.find((f) => f.name.startsWith('contract_v') && f.ext === '.json');
  if (contract) {
    const tag = `v${contract.name.match(VERSIONED)[1]}`;
    const j = JSON.parse(readFileSync(contract.p, 'utf8'));
    if (j.fileVersion !== tag) err(`V6：${rel(contract.p)} 嘅 fileVersion(${j.fileVersion}) != 檔名 ${tag}`);
    else ok(`V6：contract fileVersion = ${tag}`);
  }

  // Type C 部署拷貝必須由版本化源檔 sync 產生
  const canvas = path.join(ROOT, 'templates', 'canvas');
  if (existsSync(canvas)) {
    const sources = files.filter((f) => f.p.startsWith(canvas) && VERSIONED.test(f.name));
    const brain = sources.find((f) => f.name.startsWith('brain_v'));
    const shell = sources.find((f) => f.name.startsWith('shell_v'));
    for (const [src, out] of [[brain, 'Code.gs'], [shell, 'index.html']]) {
      if (!src) continue;
      const tag = `v${src.name.match(VERSIONED)[1]}`;
      const outPath = path.join(canvas, out);
      if (!existsSync(outPath)) { err(`V4：缺部署拷貝 templates/canvas/${out} — 跑 sync_canvas_v1.0.mjs`); continue; }
      const txt = readFileSync(outPath, 'utf8');
      if (!txt.includes(`GENERATED from ${src.name} (${tag})`)) err(`V4：${out} 檔頭標記同 ${src.name} (${tag}) 唔夾 — 跑 sync_canvas_v1.0.mjs`);
      if (!txt.includes(tag)) err(`V4：${out} 內文冇 ${tag}`);
    }
    ok('V4：Type C 部署拷貝同源檔版號一致');
  }

  // 散裝版號註解（F15）：code 檔唔好寫 // vX.X
  let code = 0;
  for (const f of files) {
    if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.gs'].includes(f.ext)) continue;
    code++;
    if (/(\/\/|\/\*|\*)\s*v\d+\.\d+(\.\d+)?\b/.test(readFileSync(f.p, 'utf8')))
      err(`F15：${rel(f.p)} 有散裝版號註解 — 用 APP_VERSION 常數 + 檔頭（docs/13-versioning.md）`);
  }
  ok(`F15：scan 咗 ${code} 個 code 檔嘅散裝版號註解`);
}

/* ---------- 8. COPYRIGHT SCOUT SYSTEM（W1/W2/W6） ---------- */
function checkCopyright() {
  const htmls = files.filter((f) => f.ext === '.html' && f.p.includes(`${path.sep}templates${path.sep}`));
  for (const f of htmls) {
    const txt = readFileSync(f.p, 'utf8');
    if (!txt.includes('© SCOUT SYSTEM')) err(`W1：${rel(f.p)} 無 © SCOUT SYSTEM 版權標示`);
    if (!txt.includes('COPYRIGHT SCOUT SYSTEM') && !txt.includes('meta name="copyright"'))
      err(`W1：${rel(f.p)} 無 COPYRIGHT SCOUT SYSTEM 字串／meta`);
    if (!/<meta name="app-version" content="v\d+\.\d+">/.test(txt)) err(`V2/W1：${rel(f.p)} 無 app-version meta`);
    if (!/APP_VERSION\s*=\s*['"]v\d+\.\d+['"]/.test(txt)) err(`V2：${rel(f.p)} 無 APP_VERSION 常數`);
  }
  ok(`W1/V2：${htmls.length} 個交付 HTML 有版權 + 雙版號`);

  // W2/W3 只喺「有出圖」嘅 repo 先至硬性要求；普通 Vercel app 無圖就唔應該被判缺檔
  // 有「獨立 decoder/codec 檔」先至要求兩者齊；單一 HTML 內嵌解碼器唔使另外擺兩份檔。
  const needsWatermark = isTruthRepo || files.some((f) =>
    f.name.startsWith('drawscout_decoder_v') || f.name.startsWith('scout_watermark_codec_v'));
  if (!needsWatermark) {
    ok('W2/W3：此 app 無出圖，跳過水印常數檢查（出圖先至需要）');
  } else {
    const decoder = files.find((f) => f.name.startsWith('drawscout_decoder_v'));
    const codec = files.find((f) => f.name.startsWith('scout_watermark_codec_v'));
    for (const [f, label] of [[decoder, 'W2/W3 解碼器'], [codec, 'W2 codec']]) {
      if (!f) { err(`W2：缺 ${label}`); continue; }
      const txt = readFileSync(f.p, 'utf8');
      for (const token of ['DRAWSCOUT|v1', 'SCOUTSYSTEM|v2|', 'STEP = 32']) {
        if (!txt.includes(token)) err(`${label}：${rel(f.p)} 缺常數 ${token}（要同 codec 對照）`);
      }
    }
    ok('W2/W3：水印常數（v1/v2 payload + STEP）對照');
  }
}

/* ---------- 8b. Actions pin SHA（A16 / G） ---------- */
// workflow 嘅 `uses:` 要釘 40-hex commit SHA：tag／branch 可以被人移位（供應鏈）。
// 本機 action（./path）唔使 SHA；docker:// 要 @sha256: digest。
function checkActionsPin() {
  const targets = [];
  const wfDir = path.join(ROOT, '.github', 'workflows');
  if (existsSync(wfDir)) {
    for (const n of readdirSync(wfDir)) if (/\.ya?ml$/.test(n)) targets.push(path.join(wfDir, n));
  }
  // 真理倉：範本都要釘，否則新 repo 一抄出去就帶住浮動 tag
  const tplDir = path.join(ROOT, 'templates', 'github');
  if (isTruthRepo && existsSync(tplDir)) {
    for (const n of readdirSync(tplDir)) if (/\.ya?ml$/.test(n)) targets.push(path.join(tplDir, n));
  }
  if (!targets.length) { ok('A16：無 workflow（跳過 Actions pin SHA 檢查）'); return; }

  let uses = 0;
  let bad = 0;
  for (const p of targets) {
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /^\s*-?\s*uses:\s*['"]?([^'"\s#]+)/.exec(line);
      if (!m) return;
      const ref = m[1];
      if (ref.startsWith('./') || ref.startsWith('../')) return;        // 本機 composite action
      uses++;
      const okRef = ref.startsWith('docker://')
        ? /@sha256:[0-9a-f]{64}$/.test(ref)
        : /@[0-9a-f]{40}$/.test(ref);
      if (!okRef) {
        bad++;
        err(`A16：${rel(p)}:${i + 1} uses ${ref} 未釘 commit SHA — tag／branch 可以移位，改 @<40-hex SHA> + 版號註解（docs/03-security.md A16）`);
      }
    });
  }
  if (!bad) ok(`A16：${targets.length} 個 workflow／範本嘅 ${uses} 個外部 action 全部釘 SHA`);
}

/* ---------- 9. 規則文件同步（F16） ---------- */
function checkRuleSync() {
  if (!isTruthRepo) { ok('F16：app repo，跳過規則同步檢查'); return; }
  const pb = read('PLAYBOOK.md');
  const need = ['S1', 'S7', 'S12', 'F4', 'F14', 'F15', 'F16', 'A1', 'A7', 'A14',
                'W1', 'W6', 'V1', 'V6', 'G1', 'G11', 'VL1', 'X1', 'U1', 'C1', 'C12', 'C13',
                'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  const miss = need.filter((id) => !pb.includes(id));
  if (miss.length) err(`F16：PLAYBOOK.md 缺規則 ID ${miss.join(', ')}`);
  else ok(`F16：PLAYBOOK.md 規則 ID 齊（${need.length} 個抽樣）`);
  if (!/5MB/.test(pb)) err('F16/C13-g：PLAYBOOK.md 要寫明單一 HTML 嘅 5MB 上限（唔適用 S7/S10）');

  const readme = read('README.md');
  // G11：9 個圖標檔名要喺唯一來源出現。2026-11-02 起完整標準搬到 docs/33，
  //       README §9 只留原則 + 指針；冇 docs/33 嘅舊／新 repo 仍然可以靠 README 過（向後兼容）。
  const iconDoc = 'docs/33-icon-standard.md';
  const iconSrc = readme + (existsSync(path.join(ROOT, iconDoc)) ? read(iconDoc) : '');
  const icons = ['favicon.ico', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png',
                 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png',
                 'icon-maskable-512.png', 'og-image.png'];
  const missIcon = icons.filter((n) => !iconSrc.includes(n));
  if (missIcon.length) err(`F16/G11：圖標標準缺 ${missIcon.join(', ')}`);
  else ok(`F16/G11：圖標 9 個檔齊（PNG／ICO；README §9 或 docs/33）`);
  for (const d of ['docs/01-slim.md', 'docs/04-settings-super.md', 'docs/09-gemini-canvas.md',
                   'docs/10-checklists.md', 'docs/12-copyright-scout-system.md', 'docs/13-versioning.md',
                   'docs/14-api-key-injection.md', 'docs/15-resource-index.md',
                   'docs/18-as-built-gap-audit.md',
                   'docs/19-ecportal-troop-case.md', 'docs/20-repo-health-audit.md',
                   'docs/21-fix-plans.md',
                   'docs/22-scout-circulars-agent-handoff.md',
                   'docs/23-design-resources.md']) {
    if (!readme.includes(d)) err(`F16：README.md 未指向 ${d}`);
  }

  // L1–L6 雙語介面（2026-11-08 定案）：規則／詳情／範本／檢查器／checklist 要齊。
  // 只驗「真理倉有冇把規則寫齊」，唔驗任何 app 有冇英文 —— L 係預設要做・可豁免，
  // 豁免同字串量係人手判斷，guard 唔可以硬擋（docs/44 L6）。
  const lDoc = 'docs/44-bilingual-ui.md';
  const lTpl = 'templates/i18n/lang_toggle_v1.0.js';
  const lChk = 'scripts/i18n_check_v1.0.mjs';
  for (const f of [lDoc, lTpl, lChk]) {
    if (!existsSync(path.join(ROOT, f))) err(`F16/L：缺 ${f}（雙語介面規則要詳情 + 範本 + 檢查器）`);
  }
  const cl = existsSync(path.join(ROOT, 'docs/10-checklists.md')) ? read('docs/10-checklists.md') : '';
  const pbTxt = read('PLAYBOOK.md');
  if (!readme.includes(lDoc)) err(`F16/L：README.md 未指向 ${lDoc}`);
  if (!cl.includes('L1')) err('F16/L：docs/10-checklists.md 未登記 L1 雙閘判定／豁免');
  // 雙閘同豁免格式唔可以喺搬字途中消失
  for (const k of ['300', 'EXCEPTION: L1']) {
    if (!pbTxt.includes(k)) err(`F16/L：PLAYBOOK.md 雙語規則缺「${k}」（雙閘門檻／豁免格式）`);
  }
  if (!/可豁免/.test(pbTxt)) err('F16/L：PLAYBOOK.md 要寫明 L 係「可豁免」，唔係硬鐵律');
  if (existsSync(path.join(ROOT, lDoc)) && existsSync(path.join(ROOT, lTpl)) && existsSync(path.join(ROOT, lChk))
      && readme.includes(lDoc) && cl.includes('L1')) {
    ok('F16/L：雙語介面 L1–L6 四處同步（PLAYBOOK + docs/44 + 範本 + 檢查器 + checklist）');
  }
}

/* ---------- 10. as-built 案例留存（R2 / G10 / F16） ---------- */
function checkAsBuilt() {
  if (!isTruthRepo) { ok('案例隔離：app repo，跳過 as-built 案例檢查'); return; }
  const cases = ['BUILD.md', 'AGENTS.md', 'EXTERNAL.md', '進度追蹤旅系統升級版.md'];
  const missing = cases.filter((f) => !existsSync(path.join(ROOT, f)));
  const readme = read('README.md');
  const unlinked = cases.filter((f) => !readme.includes(f));
  const caseDoc = existsSync(path.join(ROOT, 'docs/19-ecportal-troop-case.md')) ? read('docs/19-ecportal-troop-case.md') : '';
  const missR = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'].filter((id) => !caseDoc.includes(id));
  const separated = read('PLAYBOOK.md').includes('docs/19-ecportal-troop-case.md') && caseDoc.includes('唔係通用底線');
  const health = ['docs/20-repo-health-audit.md', 'docs/21-fix-plans.md',
                   'docs/22-scout-circulars-agent-handoff.md'].every((f) => existsSync(path.join(ROOT, f)));
  if (missing.length) err(`F16/G10：as-built 案例缺檔 ${missing.join(', ')}`);
  if (unlinked.length) err(`F16/G10：README.md 未引用 as-built 案例 ${unlinked.join(', ')}`);
  if (missR.length || !caseDoc) err(`F16：docs/19 專案案例缺 R 系列可選模式 ${missR.join(', ')}`);
  if (!separated) err('F16：通用 PLAYBOOK 未指向 docs/19，專案案例同通用規則未分離');
  if (!health) err('F16：缺 docs/20／21／22 其中一份');
  if (!missing.length && !unlinked.length && !missR.length && separated && health) {
    ok('F16：as-built 4 份 + 19 案例隔離 + 20 審計 + 21 修復 + 22 AGENT handoff 齊');
  }
}

/* ---------- 執行 ---------- */
if (ASSETS_ONLY) {
  checkHygiene(); checkDist();
} else {
  checkVercelIgnore(); checkHygiene(); checkDist(); checkSecrets();
  checkBundleLeak(); checkEnvLeakPattern(); checkEnvIgnore();
  checkLinks(); checkAnchors(); checkVersionSync(); checkCopyright(); checkActionsPin(); checkRuleSync(); checkAsBuilt();
}

for (const c of checks) console.log(`  ✓ ${c}`);
for (const w of warns) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
console.log('');
if (errors.length) {
  console.log(`GUARD FAIL — ${errors.length} 項要修（見 PLAYBOOK.md / docs/10-checklists.md）`);
  process.exit(1);
}
console.log(`${CI ? 'GUARD PASS' : '✅ GUARD PASS'} — ${checks.length} 項檢查全綠${warns.length ? `（${warns.length} 個警告）` : ''}`);
