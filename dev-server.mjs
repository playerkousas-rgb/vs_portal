#!/usr/bin/env node
/* ============================================================
   dev-server.mjs — 本機開發伺服器（零依賴）
   ------------------------------------------------------------
   本系統係純靜態網站（HTML + JS），本來用 `python3 -m http.server` 就夠。
   但「進度系統直接接駁」需要一個同源嘅伺服器端 API（Vercel 上係 /api/progress），
   所以呢個 script 會：
     1) 當普通靜態伺服器serve 成個 repo
     2) 將 /api/<name> 交俾 api/<name>.js（同 Vercel Serverless Function 一樣嘅 handler）

   用法：
     node dev-server.mjs            # http://localhost:8000
     PORT=3000 node dev-server.mjs
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

/** 載入 .env.local / .env（如果有）—— 本地預覽都可以同 Vercel 一樣有 TROOP_* 旅團登記。
    唔會覆蓋已經存在嘅環境變數（真正 env 優先）；值只可一行，自動去引號。
    呢啲檔有 API Key —— .gitignore 已經排除，唔好 commit。 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword'
};

/** Vercel 代理單一回應硬上限（4.5MB）。
 *  本機 dev server 一律模擬呢個上限 —— 爆咗就回 500 ＋ 純文字
 *  FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE，同 Vercel 一模一樣。
 *  2026-09-20 事故：資料庫大過 4.5MB 時 loadDb 喺 Vercel 實爆，
 *  但本機 python3 -m http.server / dev-server 冇呢個限制，
 *  所以本機點測都「正常」，一上線先至死 —— 而家本機就會先發現到。 */
const VERCEL_RESPONSE_LIMIT = 4.5 * 1024 * 1024;
const canSimulate = String(process.env.V82_NO_RESPONSE_LIMIT || '') !== '1';

/** 將 Node 嘅 res 包成 Vercel 風格（res.status().json()） */
function wrapRes(res) {
  let statusCode = 200;
  res.status = (code) => { statusCode = code; return res; };
  /** 爆咗 4.5MB → 學 Vercel 咁回純文字 500（唔係 JSON，正正係前端要認得出嘅情況） */
  const tooLarge = (bodyText) => {
    if (!canSimulate || Buffer.byteLength(bodyText, 'utf8') <= VERCEL_RESPONSE_LIMIT) return false;
    console.error(`[dev-server] 回應 ${Buffer.byteLength(bodyText, 'utf8')} bytes 大過 Vercel 4.5MB 上限 → 模擬 500 FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); }
    res.end('FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE');
    return true;
  };
  res.json = (obj) => {
    const text = JSON.stringify(obj);
    if (tooLarge(text)) return res;
    if (!res.headersSent) res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(text);
    return res;
  };
  res.send = (body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (tooLarge(text)) return res;
    if (!res.headersSent) res.statusCode = statusCode;
    res.end(text);
    return res;
  };
  return res;
}

/* ---------- API module cache ----------
   Node 會 cache ES module，所以改完 api/*.js（例如 _registry.js）如果照舊 import，
   再開網頁都仲係行緊舊 code —— 好容易令人以為「改極都唔 work」。
   做法：每次 api/ 有改動，就複製一份去 temp 目錄（新 generation），
   再由嗰度 import。相對 import（./_registry.js）就會用返同一份新 code。
   process.cwd() 冇變，所以 data/units.json 之類嘅檔案照讀得到。 */
const API_DIR = path.join(ROOT, 'api');
const API_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ecportal-api-'));
let apiGen = -1;
let apiStamp = '';

function apiFilesChanged() {
  try {
    const files = fs.readdirSync(API_DIR).filter(f => f.endsWith('.js')).sort();
    const stamp = files.map(f => `${f}:${fs.statSync(path.join(API_DIR, f)).mtimeMs}`).join('|');
    if (stamp === apiStamp) return false;
    apiStamp = stamp;
    return true;
  } catch (e) { return false; }
}

function apiGenDir() {
  if (apiFilesChanged() || apiGen < 0) {
    apiGen++;
    const dir = path.join(API_TMP, 'g' + apiGen);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(API_DIR)) {
      if (f.endsWith('.js')) fs.copyFileSync(path.join(API_DIR, f), path.join(dir, f));
    }
    return dir;
  }
  return path.join(API_TMP, 'g' + apiGen);
}

async function handleApi(req, res, name) {
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!file.startsWith(path.join(ROOT, 'api')) || !fs.existsSync(file)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: `冇呢個 API：${name}` }));
    return;
  }
  const qIdx = req.url.indexOf('?');
  req.query = Object.fromEntries(new URLSearchParams(qIdx >= 0 ? req.url.slice(qIdx + 1) : '').entries());
  try {
    const live = path.join(apiGenDir(), `${name}.js`);
    const mod = await import(url.pathToFileURL(live).href + `?t=${Date.now()}`);
    const handler = mod.default;
    if (typeof handler !== 'function') throw new Error(`${name}.js 冇 default handler`);
    await handler(req, wrapRes(res));
  } catch (e) {
    console.error(`[api/${name}] error:`, e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ ok: false, error: '伺服器內部錯誤：' + (e?.message || String(e)) }));
  }
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (pathname === '/') pathname = '/index.html';
  let file = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end('Forbidden'); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file = file + '.html';   // 對應 vercel cleanUrls
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<h1>404</h1><p>搵唔到檔案。</p>');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace(/^\/api\//, '').replace(/\/+$/, '').replace(/\.js$/, '');
    return handleApi(req, res, name || 'index');
  }
  return serveStatic(req, res);
}).listen(PORT, HOST, () => {
  const envTroops = [...new Set(Object.keys(process.env)
    .filter(k => /^TROOP_[0-9A-Za-z]+_(BACKEND|GASURL|APIKEY)$/i.test(k))
    .map(k => k.split('_')[1]))];
  if (envTroops.length) console.log(`環境變數旅團（.env.local／env）：${envTroops.join(', ')}`);
  else console.log('（未載入任何 TROOP_* 環境變數 → 旅團選擇閘只會有 MOCK；想本地預覽有真實旅團，喺項目加 .env.local，見 docs/ADD_NEW_UNIT.md）');
  console.log(`深資童軍管理系統（本機）→ http://localhost:${PORT}/?u=0082`);
  console.log(`示範資料 → http://localhost:${PORT}/?mock=1`);
  console.log(`API（進度接駁）→ http://localhost:${PORT}/api/progress`);
});
