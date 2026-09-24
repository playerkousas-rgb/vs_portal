/* ============================================================
   tests/_realgas.mjs — 把「真 Code.gs」包做一個 HTTP /exec
   ------------------------------------------------------------
   同 tests/_fakegas.mjs 嘅分別（呢個分別就係重點）：
     · _fakegas.mjs  ＝ 一份**重寫**嘅假後端（作者以為 Code.gs 點樣行）
     · _realgas.mjs  ＝ **真正執行** apps-script/Code.gs（vm 入面跑真 source）
   端到端測試打呢度，先至真的驗到「前端 → /api/proxy → 團長會部署嗰份
   Code.gs → Sheet」成條鏈。以前呢條鏈冇人端到端試過：分件儲存
   （saveDbPart／saveDbCommit）只有假後端版本嘅測試，真 Code.gs 嗰邊
   一直冇被驗 —— 而「儲存唔到去後端」正正係死喺呢一度。

   用法：node tests/_realgas.mjs <port>
   環境：REALGAS_APIKEY ＝ 設定 Script Properties 嘅 API_KEY
        （真站 initializeSheets() 會自動生成一條，所以要測「有 key」呢種情況）
   ============================================================ */

import http from 'node:http';
import { makeGas } from './_gasvm.mjs';

const PORT = Number(process.argv[2] || 8798);
const KEY = String(process.env.REALGAS_APIKEY || '');

/* 一個 VM ＝ 一個 Script（Script Properties 同 Sheet 都住喺呢度，
   所以 process 唔熄，資料就一路喺度 —— 同真 Spreadsheet 一樣有狀態）。 */
const gas = makeGas({ apiKey: KEY || null });

/* 真旅團張 Sheet 一定跑過 initializeSheets()（18 張分頁都建好）——
   模擬返呢個狀態，先至睇到「團長開張 Sheet 會見到乜」。
   （API_KEY 已經喺 makeGas 度設咗，initializeSheets 唔會另外生成一條。） */
if (process.env.REALGAS_INIT !== '0') {
  try { gas.sandbox.initializeSheets(); } catch (e) { console.error('[realgas] initializeSheets 失敗', e); }
}

function readBody(req) {
  // 記得讀過嘅內容：多個 handler 都想睇 body 時唔會把 stream 讀第二遍（會掛住）
  if (req._body !== undefined) return Promise.resolve(req._body);
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { req._body = Buffer.concat(chunks).toString('utf8'); resolve(req._body); });
    req.on('error', () => { req._body = ''; resolve(''); });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  /* 俾測試直接睇「資料庫」分頁而家真係有幾多行（唔信前端自己講） */
  if (u.pathname === '/_rows') {
    const sh = gas.sheets.get(u.searchParams.get('tab') || '資料庫');
    const rows = sh ? sh._rows : [];
    const brief = rows.map((r, i) => ({
      row: i + 1,
      unit: String(r[0] == null ? '' : r[0]).slice(0, 24),
      seq: Number(r[1]) || 0,
      chars: String(r[2] == null ? '' : r[2]).length,
      version: String(r[4] == null ? '' : r[4]).slice(0, 40),
      /* 頭 8 欄原樣 —— 報表分頁（團員／帳目…）冇「unit/seq」呢套欄位，
         冇 cells 就乜都斷言唔到（第一版模擬就係咁漏咗）。 */
      cells: r.slice(0, 8).map(c => String(c == null ? '' : c).slice(0, 40))
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ tab: u.searchParams.get('tab') || '資料庫', rows: brief }));
  }

  /* 俾測試睇成個 Spreadsheet 而家有邊啲分頁、每張幾多行（＝團長開張 Sheet 見到嘅嘢） */
  if (u.pathname === '/_tabs') {
    const out = [...gas.sheets.values()].map(sh => ({
      tab: sh.getName(),
      rows: Math.max(0, sh.getLastRow() - 1),
      first: (sh._rows[1] || []).map(c => String(c == null ? '' : c).slice(0, 28))
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ spreadsheet: gas.sandbox.SpreadsheetApp.getActiveSpreadsheet().getName(), tabs: out }));
  }

  /* ★ 2026-09-24（第三輪）：砌出「壞掉嘅後端」——
     一套好嘅段（現有）＋ 一套寫壞嘅較新段 ＋ N 行 __staging__ 垃圾。
     用嚟驗「無痕讀唔到 → 一鍵修復 → 讀得返」成條搶救路線。 */
  if (u.pathname === '/_seedBroken' && req.method === 'POST') {
    const body = await readBody(req);
    let reqBody = {};
    try { reqBody = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const unit = String(reqBody.unit || '0082');
    const dbTab = gas.sheets.get('資料庫');
    const out = { ok: false };
    if (dbTab) {
      const now = Date.now();
      dbTab.appendRow([unit, 1, String(reqBody.half || '{"broken":'), new Date(now), 'half-' + now]);
      for (let i = 0; i < Number(reqBody.junkRows || 2); i++) {
        dbTab.appendRow(['__staging__', i + 1, 'z'.repeat(4000), new Date(now), 'stg-' + now]);
      }
      const info = gas.sandbox.dbInfo(unit);
      out.ok = true;
      out.versions = Number(info.versions || 0);
      out.staleRows = Number(info.staleRows || 0);
      out.stagingRows = Number(info.stagingRows || 0);
      out.loadOk = false;
      try { out.loadOk = gas.sandbox.loadDb(unit).success === true; } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out));
  }

  /* 「舊版讀法」示範：v2.7.0 之前，loadDb 會把同一旅團**所有**段一齊拼
     （唔分版本）—— 呢度如實重做一次，等測試證明「有垃圾／兩套版本」時
     舊部署真係會讀唔到（＝無痕／新裝置讀唔到後端）。 */
  if (req.method === 'POST') {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    if (body.action === 'loadDb-OLD-STYLE') {
      const sh = gas.sheets.get('資料庫');
      const unit = String(body.unit || '');
      let text = '';
      if (sh) {
        for (let i = 1; i < sh._rows.length; i++) {
          const r = sh._rows[i] || [];
          if (String(r[0] == null ? '' : r[0]) !== unit) continue;
          text += String(r[2] == null ? '' : r[2]);
        }
      }
      let ok = false, error = '';
      try { JSON.parse(text); ok = true; } catch (e) { error = String(e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok, bytes: text.length, error }));
    }
  }

  /* 逃生門（v2.6.2）：直接叫後端嘅 cleanStaleStaging()，
     驗「舊版留低嘅垃圾行清得走、正式資料一行都冇甩」 */
  if (u.pathname === '/_clean') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(gas.sandbox.cleanStaleStaging()));
  }

  try {
    /* 直接叫 sandbox.doPost / doGet —— 原原本本回 Code.gs 嘅輸出字串
       （唔好經 gas.post() 嗰個 JSON.parse/stringify 往返：呢度要保留
       真實回應嘅**位元組數**，先至測得到 4.5MB 回應上限嗰類問題）。 */
    const params = Object.fromEntries(u.searchParams.entries());
    const out = req.method === 'GET'
      ? gas.sandbox.doGet({ parameter: params })
      : gas.sandbox.doPost({ postData: { contents: await readBody(req) }, parameter: params });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(out.getContent());
  } catch (e) {
    /* 真 GAS 撞正未捕捉例外會回一個錯誤頁；呢度回 500 ＋ 原因，
       測試先睇得到死因（唔係淨係「Empty reply」）。 */
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'realgas harness: ' + String(e && e.stack || e) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[realgas] 真 Code.gs（vm）listen :${PORT}${KEY ? '（已設 API_KEY）' : '（未設 API_KEY）'}`);
});
