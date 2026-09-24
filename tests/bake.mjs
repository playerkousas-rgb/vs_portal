/* ============================================================
   tests/bake.mjs — 部署時焗名單（scripts/build-units.mjs）
   ------------------------------------------------------------
   2026-09-18：有真實用戶 fetch('api/units') 一律 404，
   名單改為 build 嗰陣由 TROOP_* 焗入 data/units.generated.json，
   閘面攞靜態行先。呢度測焗嘅過程：形狀啱、唔洩密、點都唔會拖冧 build。
   用法：node tests/bake.mjs
   ============================================================ */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { bakeUnits } from '../scripts/build-units.mjs';

const t0 = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GAS_91 = 'https://script.google.com/macros/s/AKfycbTEST91FixtureOnlyNotRealDeployment00000000000/exec';
const SECRET_91 = 'bake_secret_91_must_never_reach_browser';
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bake-')), 'units.generated.json');

section('焗名單：形狀同內容');
{
  process.env.TROOP_0091_BACKEND = GAS_91;
  process.env.TROOP_0091_APIKEY = SECRET_91;
  process.env.TROOP_0091_NAME = '第九十一旅深資童軍團';
  const out = tmpFile();
  const r = bakeUnits({ outPath: out });
  ok('bake 成功（檔案 0082＋環境 0091 合併）',
    r.ok === true && r.count === 2 && r.ids.includes('0091') && r.ids.includes('0082'), JSON.stringify(r));
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok('schema／count／generatedAt 齊全', j.schema === 2 && j.count === 2 && typeof j.generatedAt === 'string',
    JSON.stringify({ schema: j.schema, count: j.count }));
  ok('旅團名由 TROOP_0091_NAME 讀到', j.units?.['0091']?.name === '第九十一旅深資童軍團');
  ok('backendReady 照計（白名單過咗）', j.units?.['0091']?.backendReady === true);
  ok('★ 焗出嚟嘅檔冇 API Key', !JSON.stringify(j).includes(SECRET_91));
  ok('★ 焗出嚟嘅檔冇完整 /exec 網址', !JSON.stringify(j).includes(GAS_91));
  ok('diagNames 認到變數名（只有名）',
    (j.diagNames?.recognizedNames || []).includes('TROOP_0091_BACKEND'),
    JSON.stringify(j.diagNames?.recognizedNames));

  /* 打錯名嘅變數要出現喺 suspicious（畀管理員對） */
  process.env.TROOP0091_BACKEND = GAS_91;
  bakeUnits({ outPath: out });
  const j2 = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok('打錯名嘅變數會列入 suspicious', (j2.diagNames?.suspicious || []).includes('TROOP0091_BACKEND'));
  delete process.env.TROOP0091_BACKEND;
  delete process.env.TROOP_0091_BACKEND;
  delete process.env.TROOP_0091_APIKEY;
  delete process.env.TROOP_0091_NAME;
}

section('焗名單：點都唔會拖冧 build');
{
  /* 冇任何 TROOP_*（全新／Preview 部署常見）→ 剩檔案名單，有效 JSON */
  const out = tmpFile();
  const r = bakeUnits({ outPath: out });
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok('冇變數都照成功（剩檔案嘅 0082）',
    r.ok === true && j.count === 1 && !!j.units['0082'] && typeof j.units === 'object');

  /* TROOPS_JSON 壞咗 → 照成功 */
  process.env.TROOPS_JSON = '唔係 JSON {{{';
  const out2 = tmpFile();
  const r2 = bakeUnits({ outPath: out2 });
  const j3 = JSON.parse(fs.readFileSync(out2, 'utf8'));
  ok('TROOPS_JSON 壞咗都照成功', r2.ok === true && typeof j3.units === 'object');
  delete process.env.TROOPS_JSON;

  /* 寫檔失敗（路徑唔存在）→ 回 ok:false，但唔擲錯 */
  let threw = false, r3 = null;
  try { r3 = bakeUnits({ outPath: path.join(os.tmpdir(), '唔存在嘅目錄-xyz', 'x.json') }); }
  catch (e) { threw = true; }
  ok('寫檔失敗都唔擲錯', threw === false && r3?.ok === false);
}

section('部署接線（regression：唔可以整甩）');
{
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  ok('★ vercel.json 有 buildCommand 焗名單',
    typeof v.buildCommand === 'string' && v.buildCommand.includes('build-units.mjs'),
    v.buildCommand || '（冇）');
  ok('★ vercel.json outputDirectory 係根目錄（冇 public/，唔寫就會紅燈 missing-public-directory）',
    v.outputDirectory === '.',
    v.outputDirectory === undefined ? '（冇寫）' : String(v.outputDirectory));
  ok('★ vercel.json 冇 routes（舊式 routes 會將 /api/* 指去靜態源碼檔，function 唔會執行）',
    !('routes' in v),
    'routes' in v ? JSON.stringify(v.routes) : '（冇 routes，行 Vercel 預設 /api/* 直達 function）');
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ok('★ 焗出嚟嘅檔唔入 Git（免得有份過期嘅喺 repo 誤導人）',
    gi.includes('data/units.generated.json'));
}

const ms = Date.now() - t0;
console.log(`\n──────── 焗名單測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
process.exit(fail ? 1 : 0);
