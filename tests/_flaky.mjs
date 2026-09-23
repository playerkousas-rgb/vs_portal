/* ============================================================
   tests/_flaky.mjs — 「讀得到寫，讀唔到讀」嘅故障注入後端
   ------------------------------------------------------------
   點解要呢個假後端：
   團長回報嘅死因係「**未讀後端就已經複寫**」。要釘死佢，測試必須要
   造出「**讀會失敗、但寫係得嘅**」呢個組合 —— 如果讀寫一齊死，
   咁舊版都一樣寫唔入，測試就證明唔到任何嘢。

   真實世界呢個組合好常見：
     · dbInfo 逾時（GAS 凍啟動 30–45 秒，前端 45 秒 timeout 差唔多撞正）
     · 網絡瞬斷／DNS 抖一下
     · 平台 proxy 一時 5xx
   而寫入嗰陣網絡啱返 —— 於是舊 code 就照寫，把另一部機嘅資料蓋走。

   用法：node tests/_flaky.mjs <listenPort> <upstreamPort>
   行為：頭 N 次 dbInfo（N = FAIL_INFO，default 3）回 503，之後先至轉發；
        其他 action（saveDb／saveDbPart／saveDbCommit／loadDb…）一律照轉發。
   ============================================================ */

import http from 'node:http';

const PORT = Number(process.argv[2] || 8901);
const UP = Number(process.argv[3] || 8799);
const FAIL_INFO = Number(process.env.FAIL_INFO || 3);

let infoHits = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let action = '';
    try { action = String(JSON.parse(body || '{}').action || ''); } catch { /* 唔係 JSON */ }

    if (action === 'dbInfo' && infoHits < FAIL_INFO) {
      infoHits++;
      /* 503 ＋ 純文字 —— 模擬「後端一時問唔到」。
         注意呢度刻意**唔係** JSON：舊 postJson 只會喺非 JSON 嗰陣 set noApi，
         所以要連呢種「最老實嘅失敗」都測試到。 */
      res.writeHead(503, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end('upstream busy (fault injection)');
      return;
    }

    const up = http.request({
      host: '127.0.0.1', port: UP, path: req.url, method: req.method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => {
      let out = '';
      r.on('data', (d) => { out += d; });
      r.on('end', () => {
        res.writeHead(r.statusCode, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end(out);
      });
    });
    up.on('error', () => { res.writeHead(502); res.end('upstream down'); });
    up.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[flaky] :${PORT} → upstream :${UP}（頭 ${FAIL_INFO} 次 dbInfo 會 503）\n`);
});
