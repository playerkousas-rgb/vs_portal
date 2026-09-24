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

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ success: false, error: '此 API 只接受 GET 請求' });
  }
  const units = listPublicUnits();
  const diag = /^1|true|yes$/i.test(String(req.query?.diag || '')) ||
    /[?&]diag=(1|true|yes)/i.test(String(req.url || ''));

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
