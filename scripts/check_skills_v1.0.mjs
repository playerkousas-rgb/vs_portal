#!/usr/bin/env node
/* 檢查 skills/ 入面每份 SKILL.md 嘅 frontmatter。零第三方依賴（S 規則）。
   概念借自 Leonxlnx/taste-skill 嘅 tests/frontmatter.mjs：
   Claude Code / Codex 用 strict YAML parser，frontmatter 一 parser 錯就靜靜 drop 成個 skill。
   用法： node scripts/check_skills_v1.0.mjs <repo-path> [--json]
*/
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const VERSION = 'v1.0';
const root = path.resolve(process.argv[2] || '.');
const asJson = process.argv.includes('--json');
const errors = [];
const found = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function frontmatter(src, where) {
  const lines = src.split(/\r?\n/);
  if (lines[0] !== '---') { errors.push(`${where}: 第一行唔係 --- frontmatter`); return null; }
  const end = lines.indexOf('---', 1);
  if (end < 0) { errors.push(`${where}: 搵唔到結尾 ---`); return null; }
  const fm = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (!m) {
      if (/^\s+\S/.test(line)) continue;                 // 縮排續行（folded block）
      errors.push(`${where}: 唔識嘅 frontmatter 行 ${i + 2}: ${line.slice(0, 60)}`);
      continue;
    }
    const key = m[1];
    let val = m[2].trim();
    if (key in fm) errors.push(`${where}: key 重複 ${key}`);
    if (val === '>-' || val === '|' || val === '>') {
      const parts = [];
      while (i + 1 < body.length && /^\s+\S/.test(body[i + 1])) { parts.push(body[++i].trim()); }
      val = parts.join(' ');
    } else if (/^['"]/.test(val)) {
      val = val.replace(/^['"]|['"]$/g, '');
    } else if (/\S:\s/.test(val)) {
      errors.push(`${where}: ${key} 入面有未 quote 嘅 "word: word"，strict YAML 會出事`);
    }
    fm[key] = val;
  }
  return fm;
}

// 全倉搵 SKILL.md：唔假設一定喺 skills/（我哋 answer repo 用單數 skill/）。
// 2026-11-02 改：起手包 skills/promoted/ 放咗兩份**真正**嘅 SKILL.md，要一齊驗，唔好再跳過 templates/。
for (const p of walk(root)) {
  if (path.basename(p) !== 'SKILL.md') continue;
  const where = path.relative(root, p).replace(/\\/g, '/');
  const src = readFileSync(p, 'utf8');
  const fm = frontmatter(src, where);
  if (!fm) continue;
  const name = fm.name;
  if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64)
    errors.push(`${where}: name 要 kebab-case、≤64 字（現時 ${JSON.stringify(name)}）`);
  if (!fm.description || typeof fm.description !== 'string')
    errors.push(`${where}: description 要非空字串`);
  else if (fm.description.length > 1024)
    errors.push(`${where}: description ${fm.description.length} 字 > 1024`);
  if ('disable-model-invocation' in fm && !/^(true|false)$/.test(fm['disable-model-invocation']))
    errors.push(`${where}: disable-model-invocation 要 true/false`);
  if (name) {
    const dup = found.find((f) => f.name === name);
    if (dup) errors.push(`${where}: name "${name}" 同 ${dup.where} 撞名`);
    else found.push({ name, where });
  }
}

// manifest 入面列出嘅 skill 路徑要真係存在
for (const rel of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'skills/manifest.json']) {
  const p = path.join(root, rel);
  if (!existsSync(p)) continue;
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { errors.push(`${rel}: JSON 唔合法 (${e.message})`); continue; }
  const plugins = j.plugins || (j.name ? [j] : []);
  for (const plugin of plugins) {
    for (const s of [].concat(plugin.skills || [])) {
      if (typeof s === 'string' && !existsSync(path.join(root, s, 'SKILL.md')))
        errors.push(`${rel}: plugin "${plugin.name || j.name}" 列咗 ${s}，但冇 SKILL.md`);
    }
  }
}

// 2026-11-02：如果 repo 有 skills/CATALOG.md，每份 SKILL.md 都要入咗目錄（name + 完整相對路徑）。
// 冇 catalog 嘅舊 repo 唔扮有，照舊 PASS（向後兼容，例如單數 skill/ 嘅 repo）。
const catalogPath = path.join(root, 'skills', 'CATALOG.md');
if (existsSync(catalogPath)) {
  const cat = readFileSync(catalogPath, 'utf8');
  for (const f of found) {
    if (!cat.includes(f.name)) errors.push(`skills/CATALOG.md: 缺 skill「${f.name}」嘅目錄行`);
    else if (!cat.includes(f.where)) errors.push(`skills/CATALOG.md: 「${f.name}」缺完整路徑 ${f.where}`);
  }
}

const result = { tool: 'check_skills', version: VERSION, repo: root, skills: found.length, catalog: existsSync(catalogPath), errors, ok: errors.length === 0 };
if (asJson) console.log(JSON.stringify(result, null, 2));
else if (errors.length) {
  console.error(`FAIL — ${errors.length} 個問題：`);
  for (const e of errors) console.error('  - ' + e);
} else console.log(`PASS — ${found.length} 份 SKILL.md frontmatter 合格`);
process.exit(errors.length ? 1 : 0);
