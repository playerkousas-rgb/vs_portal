#!/usr/bin/env node
/**
 * final_check_v1.0.mjs — 交付前「六角度最終實測」一條命令
 *
 * 用法：
 *   node scripts/final_check_v1.0.mjs                 # 全部自動檢查 + 印六角度報告
 *   node scripts/final_check_v1.0.mjs --html a.html  # 額外審計指定單一 HTML
 *   node scripts/final_check_v1.0.mjs --json         # machine-readable（AI agent 用）
 *
 * 六個角度：Vercel 官方 / Git 官方 / 程序員 / 系統架構師 / AI Agent / 一般用戶。
 * 只跑自動化部分；人手實測（開瀏覽器、手機、斷網）印出清單畀人跟。
 * 零 dependency（S1）。退出碼：0 = 全綠；1 = 有 FAIL。
 * 對照：docs/17-final-check-and-tutorial.md
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = 'v1.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => path.join(ROOT, p);

export const ANGLES = [
  { id: 'vercel', name: 'Vercel 官方', care: 'build 到、env 唔漏、region／header 啱' },
  { id: 'git', name: 'Git 官方', care: '無 secret、無大檔、.env 被 ignore、CI 會跑' },
  { id: 'dev', name: '程序員', care: 'guard / test / sync 全部綠' },
  { id: 'arch', name: '系統架構師', care: '單一真理：版號、contract、部署拷貝' },
  { id: 'agent', name: 'AI Agent', care: '文件可解析、無矛盾、入口清晰' },
  { id: 'user', name: '一般用戶', care: '開到、無 key、版權版號見到、圖解到碼' },
];

/** 跑一條 node 命令，唔拋 exception，回傳 {ok, out} */
function runNode(args) {
  try {
    const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: (out || '').trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || e.message}`.trim() };
  }
}
const tail = (s, n = 1) => s.split('\n').filter(Boolean).slice(-n).join(' | ');

export function collect(extraHtml = []) {
  const results = [];
  const add = (id, ok, detail) => results.push({ id, ok, detail });
  // 同一條命令喺「真理倉」同「新 app repo」都用得；無嘅元件自動跳過，唔判 FAIL。
  const TRUTH = existsSync(R('PLAYBOOK.md'));
  const vjson = TRUTH ? 'templates/vercel/vercel.json' : 'vercel.json';
  const envp = TRUTH ? 'templates/vercel/env.example' : '.env.example';

  /* ---------- 1. Vercel 官方 ---------- */
  if (!existsSync(R(vjson))) {
    add('vercel', true, '此 app 無 vercel.json（單一 HTML / 非 Vercel），跳過');
  } else try {
    const vj = JSON.parse(readFileSync(R(vjson), 'utf8'));
    const inst = vj.installCommand || '';
    add('vercel', inst.includes('--include=dev') && !inst.includes('--omit=dev') && vj.outputDirectory === 'dist' && Array.isArray(vj.regions),
      `installCommand=${inst} · outputDirectory=${vj.outputDirectory} · regions=${(vj.regions || []).join(',')}`);
  } catch (e) { add('vercel', false, `vercel.json 讀唔到／唔合法：${e.message}`); }
  if (existsSync(R(envp))) {
    const envEx = readFileSync(R(envp), 'utf8');
    add('vercel', !/AIza[0-9A-Za-z_-]{30,}|sk-(live|proj)-/.test(envEx),
      '.env.example 只有 key 名，無真值');
  }

  /* ---------- 2. Git 官方 ---------- */
  if (!existsSync(R('.gitignore'))) add('git', true, '此 app 無 .gitignore（單一 HTML），跳過');
  else {
    const gi = readFileSync(R('.gitignore'), 'utf8');
    add('git', /\.env/.test(gi), '.gitignore 有擋 .env*');
  }
  add('git', existsSync(R('.github/workflows/guard.yml')) || !TRUTH,
    'CI workflow 存在（或 app repo 自行決定）');

  /* ---------- 3. 程序員 ---------- */
  const guard = existsSync(R('scripts/guard.mjs')) ? runNode(['scripts/guard.mjs', '--ci']) : { ok: true, out: '無 guard.mjs（單一 HTML app 只需 audit）' };
  add('dev', guard.ok, tail(guard.out) || 'guard 無輸出');
  const tests = runNode(['--test']);
  const m = tests.out.match(/# pass (\d+)/);
  const f = tests.out.match(/# fail (\d+)/);
  add('dev', tests.ok && f && f[1] === '0', `node --test：pass ${m ? m[1] : '?'} / fail ${f ? f[1] : '?'}`);

  /* ---------- 4. 系統架構師 ---------- */
  if (!existsSync(R('templates/canvas/contract_v1.0.json'))) {
    add('arch', true, '此 app 無 Type C 腦殼分離，跳過 sync/contract 檢查');
  } else {
  const sync1 = runNode(['templates/canvas/sync_canvas_v1.0.mjs']);
  const before = ['templates/canvas/Code.gs', 'templates/canvas/index.html'].map((p) => readFileSync(R(p), 'utf8'));
  const sync2 = runNode(['templates/canvas/sync_canvas_v1.0.mjs']);
  const after = ['templates/canvas/Code.gs', 'templates/canvas/index.html'].map((p) => readFileSync(R(p), 'utf8'));
  add('arch', sync1.ok && sync2.ok && before.every((v, i) => v === after[i]), '部署拷貝 sync 兩次結果一致（冪等，V4）');
  const contract = JSON.parse(readFileSync(R('templates/canvas/contract_v1.0.json'), 'utf8'));
  add('arch', contract.fileVersion === 'v1.0' && contract.copyright === '© SCOUT SYSTEM',
    `contract fileVersion=${contract.fileVersion} · copyright=${contract.copyright}`);
  }
  if (TRUTH) {
    const cases = ['BUILD.md', 'AGENTS.md', 'EXTERNAL.md', '進度追蹤旅系統升級版.md'];
    const readme = readFileSync(R('README.md'), 'utf8');
    const there = cases.filter((f) => existsSync(R(f)));
    const linked = cases.filter((f) => readme.includes(f));
    const caseFiles = ['docs/18-as-built-gap-audit.md', 'docs/19-ecportal-troop-case.md',
                        'docs/20-repo-health-audit.md', 'docs/21-fix-plans.md',
                        'docs/22-scout-circulars-agent-handoff.md'];
    const cf = caseFiles.filter((f) => existsSync(R(f)));
    add('arch', there.length === 4 && linked.length === 4 && cf.length === 5,
      `as-built 案例 ${there.length}/4 存在 · README 引用 ${linked.length}/4 · 隔離檔 18/19/20/21/22 ${cf.length}/5（案例同通用規則分離）`);
  }

  /* ---------- 5. AI Agent ---------- */
  if (TRUTH) {
    const boot = ['README.md', 'PLAYBOOK.md', 'AGENTS.md', 'docs/00-quickcard.md', 'docs/17-final-check-and-tutorial.md'];
    add('agent', boot.every((p) => existsSync(R(p))), `入口檔齊（${boot.length}）`);
    const pb = readFileSync(R('PLAYBOOK.md'), 'utf8');
    add('agent', ['S1', 'F1', 'A1', 'W1', 'V1', 'C13', '5MB'].every((k) => pb.includes(k)), 'PLAYBOOK 規則 ID + 5MB 上限齊');
    const caseDoc = existsSync(R('docs/19-ecportal-troop-case.md')) ? readFileSync(R('docs/19-ecportal-troop-case.md'), 'utf8') : '';
    add('agent', pb.includes('docs/19-ecportal-troop-case.md') && caseDoc.includes('R1') && caseDoc.includes('R8') && caseDoc.includes('唔係通用底線'),
      '通用 PLAYBOOK 只留指針；R1–R8 可選模式喺 19 專案案例（案例隔離）');
  } else {
    add('agent', existsSync(R('README.md')), 'app repo 有 README.md 入口');
    add('agent', true, '真理倉規則由 readme repo 管理，app repo 唔使重複');
  }

  /* ---------- 6. 一般用戶 ---------- */
  const htmlDirs = TRUTH ? ['templates/watermark', 'templates/canvas'] : ['.', 'public', 'dist'];
  const htmls = htmlDirs.filter((d) => existsSync(R(d)))
    .flatMap((d) => readdirSync(R(d)).filter((n) => n.endsWith('.html')).map((n) => (d === '.' ? n : `${d}/${n}`)));
  for (const h of [...htmls, ...extraHtml]) {
    const abs = path.isAbsolute(h) ? h : R(h);
    if (!existsSync(abs)) { add('user', false, `搵唔到 ${h}`); continue; }
    const a = runNode(['scripts/audit_single_html_v1.0.mjs', abs]);
    // audit 對合格檔 exit 0；warn 唔算 fail
    add('user', a.ok, `${h} → ${tail(a.out, 2)}`);
  }

  return { version: VERSION, mode: TRUTH ? 'truth-repo' : 'app-repo', results, ok: results.every((r) => r.ok) };
}

/** 人手一定要做，機器代唔到 */
export const MANUAL = [
  '普通用戶：開 index.html（file://）同部署 URL 各一次，睇頁尾 © SCOUT SYSTEM + 版號',
  '普通用戶：用手機開一次（版面、撳鈕、上載圖）＋ clear cache 再開一次',
  '普通用戶：斷網開一次（零 key 路徑應該仍然用到）',
  '普通用戶：成品圖放入 drawscout_decoder_v1.0.html，應該讀到水印 payload',
  'Vercel：Preview deployment 開一次；Production 開一次；F12 Console 無 error',
  'Git：PR 頁面睇 CI 全部綠，先至 merge；merge 後睇 deployment log',
  '系統架構師／19 案例教訓：本地回歸綠唔算完成 —— 新部署要真機跑一次（GAS 302 轉址／Drive 權限／Script Properties 配額／onOpen 選單授權）',
];

/* ---- CLI ---- */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const extra = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--html') extra.push(process.argv[++i]);
  const r = collect(extra.filter(Boolean));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\n最終實測 ${VERSION} — 六角度報告（${r.mode}）\n${'='.repeat(52)}`);
    for (const a of ANGLES) {
      const rs = r.results.filter((x) => x.id === a.id);
      const ok = rs.every((x) => x.ok);
      console.log(`\n${ok ? '✅' : '❌'} [${a.id}] ${a.name} — ${a.care}`);
      for (const x of rs) console.log(`   ${x.ok ? '✓' : '✗'} ${x.detail}`);
    }
    console.log(`\n人手實測（機器代唔到）：`);
    MANUAL.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    console.log(`\n${r.ok ? '✅ FINAL CHECK PASS — 可以交付' : '❌ FINAL CHECK FAIL — 唔好交付'}`);
    console.log('教學：docs/17-final-check-and-tutorial.md\n');
  }
  process.exit(r.ok ? 0 : 1);
}
