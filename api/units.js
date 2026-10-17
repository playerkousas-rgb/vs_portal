// Vercel Serverless Function — 旅團清單 API
// 資料來源：data/units.json + TROOP_{ID}_* 環境變數（＋可選 TROOPS_JSON）
// 安全：只回傳公開資訊，不外洩 gasUrl / apiKey
//
//   GET /api/units          → { units: { … } }
//   GET /api/units?diag=1   → 加埋伺服器端登記診斷（只有變數名，冇值）
//
// 診斷係為咗答「我明明加咗 TROOP_*，點解首頁見唔到旅團？」——
// 佢會列出伺服器認到嘅旅團、認到嘅變數名，同**疑似打錯嘅變數名**。

import { listPublicUnits, registryDiagnostics } from './_registry.js';

/* ★ Cache 策略（減少 Serverless Function 起動次數）
   ------------------------------------------------------------
   呢個 endpoint 淨係讀「環境變數（TROOP_*）＋ data/units.json」——
   要**重新部署**先會變，所以結果可以放心交畀 Edge CDN：
     · 瀏覽器 cache 5 分鐘（max-age=300）
     · Edge cache 1 小時（s-maxage=3600）＋過期後繼續 serve 舊嘅再背景更新 1 日（SWR 86400）
   → 同一個部署入面，幾百個使用者開頁都只會打到 CDN，唔會一人開一個 Function。

   ⚠️ 例外：`?diag=1` 會回傳**呢個請求嘅** host／VERCEL_ENV／認到嘅變數名，
      屬於「現場診斷」，CDN 快取咗會變成 A 環境嘅診斷派畀 B 環境，
      所以 diag 一律維持 no-store（見下面 send 嗰度）。 */
const CACHE_PUBLIC = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_PRIVATE = 'no-store, no-cache, must-revalidate';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', CACHE_PRIVATE);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ success: false, error: '此 API 只接受 GET 請求' });
  }
  const units = listPublicUnits();
  const diag = /^1|true|yes$/i.test(String(req.query?.diag || '')) ||
    /[?&]diag=(1|true|yes)/i.test(String(req.url || ''));
  /* 診斷＝即時環境資料，唔入 CDN */
  res.setHeader('Cache-Control', diag ? CACHE_PRIVATE : CACHE_PUBLIC);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const body = {
    units,
    count: Object.keys(units).length,
    _note: '82venture 多旅團 Registry，所有後端同步存取請經同源 /api/proxy'
  };
  if (diag) {
    body.diag = {
      ...registryDiagnostics(),
      /* 用家而家開緊邊個網址／邊個環境 —— 「變數只勾咗 Production，但開緊 Preview 網址」係最常見陷阱 */
      host: String(req.headers?.host || ''),
      requestEnv: process.env.VERCEL_ENV || (process.env.VERCEL ? 'vercel' : 'local')
    };
  }
  res.status(200).json(body);
}
