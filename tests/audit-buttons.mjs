/* ============================================================
   tests/audit-buttons.mjs — 全 APP 按鈕審計（driver）
   -----------------------------------------------------------
   走遍 角色(leader/exco/chief/super) × 11 個分頁，
   真撳每個 button / 表單 / 連結 / onclick 元素，偵測：
     exception（撳完出錯＝壞）／dead（撳完完全冇反應＝壞）／
     modal、toast、dom、state、navigate、download、print、clipboard（有反應＝正常）
   用法：
     node tests/audit-buttons.mjs            # 全部 44 個組合
     FILTER=real/leader/dashboard node tests/audit-buttons.mjs   # 只跑部分
   ============================================================ */

import { spawn } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'tests', '_audit-run.mjs');
/* ★ 2026-09-25：示範（MOCK）模式已經拆走 → 審計只跑真實模式（44 個組合） */
const MODES = ['real'];
/* ★ 2026-09-24：加埋團長（最高權限，每個旅團一位）一齊審 */
const ROLES = ['leader', 'exco', 'chief', 'super'];
const SECTIONS = ['dashboard', 'meetings', 'finance', 'members', 'inventory',
  'progress', 'notices', 'links', 'constitution', 'docs', 'admin'];
const CONCURRENCY = 3;
const RUN_TIMEOUT_MS = 150_000;

const filter = (process.env.FILTER || '').split('/').filter(Boolean);
const combos = [];
for (const mode of MODES) {
  for (const role of ROLES) {
    for (const section of SECTIONS) {
      if (filter.length && !filter.includes(filter[0] + '/' + (filter[1] || '') + '/' + (filter[2] || ''))) {
        if (!(filter.length === 1 && mode === filter[0])
          && !(filter.length === 2 && mode === filter[0] && role === filter[1])
          && !(filter.length === 3 && mode === filter[0] && role === filter[1] && section === filter[2])) continue;
      }
      combos.push([mode, role, section]);
    }
  }
}

function runOne([mode, role, section]) {
  return new Promise((resolve) => {
    const p = spawn('node', [WORKER, mode, role, section], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), RUN_TIMEOUT_MS);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', (code) => {
      clearTimeout(t);
      let report = null;
      try { report = JSON.parse(out.trim() || 'null'); }
      catch (e) {
        /* worker 崩潰前可能打咗嘢落 stdout：撈最後一段 JSON 嘗試 */
        const m = out.match(/\{[\s\S]*\}\s*$/);
        if (m) { try { report = JSON.parse(m[0]); } catch { /* ignore */ } }
      }
      resolve({ mode, role, section, code, report, stderr: err.slice(-800) });
    });
  });
}

const t0 = Date.now();
const queue = [...combos];
const results = [];
const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) {
    const combo = queue.shift();
    results.push(await runOne(combo));
  }
});
await Promise.all(workers);

/* ---------- 報告 ---------- */
const okRuns = results.filter(r => r.report);
const crashed = results.filter(r => !r.report);
const allProblems = [];
for (const r of okRuns) {
  for (const p of r.report.problems || []) {
    allProblems.push({ mode: r.mode, role: r.role, section: r.section, ctx: p.ctx, label: p.label, key: p.key, effect: p.effect, errors: p.errors });
  }
}

let totalTested = 0, totalGood = 0;
for (const r of okRuns) {
  const t = r.report.totals || {};
  totalTested += t.tested || 0;
  totalGood += (t.modal || 0) + (t.effect || 0) + (t.toast || 0) + (t.dom || 0) + (t.state || 0)
    + (t.navigate || 0) + (t.closed || 0) + (t.download || 0) + (t.print || 0)
    + (t.clipboard || 0) + (t.link || 0) + (t.skip || 0) + (t.activeNoop || 0) + (t.envOk || 0) + (t.printdoc || 0);
}

console.log(`\n════════ 按鈕審計報告（${((Date.now() - t0) / 1000).toFixed(0)}s）════════`);
console.log(`組合：${okRuns.length}/${results.length} 個 run 成功`);
console.log(`測試嘅元素：${totalTested}，正常（有反應）：${totalGood}，問題：${allProblems.length}`);
for (const r of crashed) {
  console.log(`\n✗✗ RUN 崩潰：${r.mode}/${r.role}/${r.section}（exit ${r.code}）`);
  if (r.stderr) console.log(r.stderr);
}
if (allProblems.length) {
  console.log(`\n▌問題列表（${allProblems.length}）`);
  for (const p of allProblems) {
    const line = `  [${p.effect}] ${p.mode}/${p.role} · ${p.section} · ${p.ctx} · 「${p.label || '(無文字)'}」`;
    console.log(line);
    for (const e of (p.errors || [])) console.log('      ↳ ' + String(e).slice(0, 200));
  }
}
console.log('\n════════');
process.exit(allProblems.length || crashed.length ? 1 : 0);
