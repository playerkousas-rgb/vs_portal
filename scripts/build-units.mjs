// scripts/build-units.mjs — 把 Vercel 環境變數登記嘅旅團名單「焗」入靜態檔
//
// 背景（2026-09-18 真實事件）：有用戶喺唔同機、唔同網絡、唔同 browser
// fetch('api/units') 一律 HTTP 404，但網址列直接開同一個 URL 就 200。
// 伺服器 code 證實唔會回 404（GET 閒閒哋都係 200），兇手喺我哋控制範圍之外；
// 但教每個用戶逐部機搞設定係冇意思嘅 —— 所以名單唔再淨係靠 runtime function：
// Vercel build 嗰陣（嗰陣讀到同一個環境嘅 TROOP_*）就生成一份公開名單靜態檔
// data/units.generated.json；閘面攞靜態行先，/api 留做後備＋診斷。
//
// 部署接線：vercel.json → "buildCommand": "node scripts/build-units.mjs"
// 加 "outputDirectory": "."（個站係根目錄靜態、冇 public/；有 buildCommand
// 冇 outputDirectory 的話 Vercel 會去搵 public/ 並紅燈 missing-public-directory）。
// 加／改環境變數之後照舊 Redeploy —— 新部署會重新焗過份名單。
//
// 安全：只會寫入 listPublicUnits() 嘅公開欄位 —— 永遠唔會有 gasUrl／apiKey。
// 穩陣：焗嘅過程任何數據問題（冇變數、JSON 壞咗）都唔會擲錯、唔會令 build 失敗
// （最差都係寫一份空名單，閘面會如常 fallback 去 /api/units，行為同以前一模一樣）。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listPublicUnits, registryDiagnostics } from '../api/_registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'data', 'units.generated.json');

/** 焗名單。成功／空名單都回 { ok:true }；淨係寫檔失敗先回 ok:false（都唔擲錯）。 */
export function bakeUnits({ outPath = OUT } = {}) {
  let units = {};
  let diag = null;
  let bakeError = '';
  try {
    units = listPublicUnits() || {};
    const d = registryDiagnostics() || {};
    diag = {
      recognizedNames: d.recognizedNames || [],
      suspicious: d.suspicious || [],
      withKey: d.withKey || [],
      trusted: d.trusted || [],
      withName: d.withName || []
    };
  } catch (e) {
    bakeError = e?.message || String(e);
    units = {};
  }
  const ids = Object.keys(units).sort();
  const payload = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    vercelEnv: process.env.VERCEL_ENV || (process.env.VERCEL ? 'vercel' : 'local'),
    units,
    count: ids.length,
    diagNames: diag || { recognizedNames: [], suspicious: [], withKey: [], trusted: [], withName: [] }
  };
  if (bakeError) payload.bakeError = bakeError;
  try {
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    /* 連寫檔都唔得（唯讀環境）—— 唔好拖冧成個 build，閘面會 fallback 去 /api/units */
    console.warn('[build-units] 寫檔失敗（閘面會 fallback 去 /api/units）：', e?.message || e);
    return { ok: false, outPath, count: 0, error: e?.message || String(e) };
  }
  console.log(`[build-units] ${outPath} ids=[${ids.join(',')}] count=${ids.length}` +
    (diag?.suspicious?.length ? ` suspicious=[${diag.suspicious.join(',')}]` : '') +
    (bakeError ? ` BAKE-ERROR=${bakeError}` : ''));
  return { ok: true, outPath, count: ids.length, ids };
}

const invokedDirectly = (() => {
  try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) bakeUnits();
