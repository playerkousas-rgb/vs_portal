/* ============================================================
   remote.js — 後端儲存（資料真正寫入旅團自己嘅 Google Sheet）
   ------------------------------------------------------------
   ★ 2026-09-24 團長回報：「各按鈕亂設…究竟那個是那個超級混亂」、
     「用戶根本沒寫入後端，1 邊能用 email 登入 1 邊不能」。
   根因唔係按鈕多，係**寫入靠人記得撳掣**：唔撳就永遠留喺瀏覽器，
   另一部機／另一個分頁當然讀唔到 —— 而超管登入唔經旅團後端，
   所以淨係佢永遠入到，令問題睇落更加似「同步壞咗」。

   而家：**寫入依然只有一條路**（saveToBackend），但由系統自己行：
     ① 登入／開機      loadFromBackend()  由後端攞成份資料 → 本機工作副本 ＋ 基準快照
     ② 之後改乜        寫本機 → **自動排一次寫入**（一般 1.2 秒；帳戶級改動即刻）
     ③ saveToBackend() 先問後端版本：
          · 冇人喺我登入後儲存過          → 直接寫
          · 有人儲存過                    → 三方比對（lib/merge3.js）：
               佢改嘅同我改嘅一樣          → 冇問題
               改唔同嘅格                  → 一齊寫
               同一格唔同值（早走 vs 遲到）→ 嗰格**唔寫**，彈出嚟畀用家再確認；
                                             確認咗先至蓋過去
        寫入成功 → 本機 ＝ 後端 ＝ 新基準
     頂部「儲存到後端（N）」掣＝ 即寫，係**全系統唯一寫入後端嘅路**（團長 2026-09-24 定案）。

   同一個瀏覽器另一個分頁嘅改動由 store.bindCrossTabSync() 併入（見 store.js）。

   路線（優先次序；兩條都要行得通，見 lib/gateway.js）：
     ① 同源 /api/proxy  —— 冇 CORS、API Key 由伺服器端補上（最穩陣）
     ② 直接 POST 去 /exec —— 平台未登記旅團（或者純靜態部署）時嘅自助路線

   ============================================================ */

import {
  load, tryLoad, commitMeta, currentUnit, getBase, adoptRemote, setLocalMerged,
  commitSaved, applyChangesLocal, markBackendEmpty, normalizeRemote, stripForBase, exportForBackend,
  hasLocalContent, localChanges
} from './store.js';
import { unitEntry } from './units.js';
import { postBackend, isExecUrl } from './gateway.js';
import { threeWay, overridesFor, describeConflict, diffDb, applyChanges, SKIP_TOP } from './merge3.js';

/* ---------------- 狀態 ---------------- */
let inFlight = false;
/* ★ v2.8.0「簡單寫入」（學 VSBADGE）：後端識 saveTables／loadTables 就改行「逐表寫」。
   由後端自報（status／dbInfo 都會帶 simpleWrite:true）—— 舊 Code.gs 冇呢個欄位，
   simpleMode 就一直係 false，照行舊嘅整份 saveDb，所以升級唔使改設定、唔會斷。
   ★ 一定要由後端「自報」先開：未問過後端就盲試 loadTables，會令舊後端
     每次讀寫都白白多一個 400 請求，診斷畫面亦會多出冇意義嘅 action。 */
let simpleMode = false;
/* 「舊『資料庫』分頁睇落係空」嗰陣探過一次「資料表」分頁未（一個 session 一次就夠） */
let simpleProbed = false;
/** 而家係咪行緊「逐表寫」（界面上要話畀用家知用邊條路） */
export function simpleWriteMode() { return simpleMode === true; }
/** 人手切返舊嘅「整份寫入」（後端逐表寫出問題時嘅逃生門；重新載入就會再自動偵測） */
export function useBlobWriteMode() { simpleMode = false; simpleProbed = true; }
/* ★ v2.8.0「簡單寫入」（學 VSBADGE：一個請求淨係寫一個表嗰幾行）。
   null＝未知（未問過後端）／true＝後端識 saveTables／false＝後端唔識（行返舊嘅整份 saveDb）。
   點解要偵測而唔係硬轉：用家嘅 Code.gs 未必已經更新 —— 偵測唔到就自動跌返舊路，
   唔會令未升級嘅旅團即刻斷線。 */
let simpleWrite = null;
export function simpleWriteSupported() { return simpleWrite === true; }
let lastState = { state: 'idle', msg: '' };
let lastLoadAt = 0;                          // 上次成功由後端載入（ms）
/*
 * 這個係「實際連線結果」，同 remoteCfg() 嘅「有冇一條路可以試」分開。
 * Vercel 代理係同源嘅，瀏覽器唔應該要求用家再貼一次 /exec／API Key；
 * 登入／載入成功後，總表同步頁要沿用呢個事實，而唔係只睇本機 sync.url。
 */
let lastBackend = {
  verified: false, unit: '', route: '', version: '', at: 0, error: ''
};
/* 後端自報嘅試算表名 —— 團長問「如果真係寫咗，寫咗去邊？」，
   呢個名先至答得到（平台登記嘅 /exec 有可能指去另一張 Sheet）。 */
let lastSpreadsheet = '';

/** 目前同步狀態（畀介面畫個提示） */
export function syncState() { return { ...lastState }; }

/**
 * 後端接線狀態：
 *   configured ＝ 有一條可能行得通嘅路（未必已試過）
 *   verified   ＝ 今次頁面生命週期內，真正收到過後端有效回覆
 *   route      ＝ proxy／direct
 */
export function backendStatus() {
  const cfg = remoteCfg();
  return {
    configured: !!cfg.ok,
    verified: !!(lastBackend.verified && lastBackend.unit === cfg.unit),
    route: lastBackend.route || (cfg.serverManaged ? 'proxy' : (cfg.url ? 'direct' : (cfg.viaProxy ? 'proxy' : ''))),
    unit: cfg.unit || lastBackend.unit || '',
    version: lastBackend.version || '',
    /* 後端自報嘅試算表名 —— 「寫咗去邊」全靠呢個名 */
    spreadsheet: lastSpreadsheet || '',
    at: lastBackend.at || 0,
    error: lastBackend.error || ''
  };
}

/** 後端自報嘅試算表名（未連過／後端太舊 ＝ 空字串） */
export function backendSheetName() { return lastSpreadsheet || ''; }

function noteBackend(r, { version = '', error = '' } = {}) {
  if (r?.spreadsheet) lastSpreadsheet = String(r.spreadsheet);
  if (r?.via === 'proxy' || r?.via === 'direct') {
    lastBackend = {
      verified: !!r.ok,
      unit: remoteCfg().unit,
      route: r.via,
      version: String(version || r.json?.backendVersion || ''),
      at: Date.now(),
      error: r.ok ? '' : String(error || r.error || '')
    };
  }
}

function setState(state, msg = '') {
  lastState = { state, msg, at: Date.now() };
  try {
    window.dispatchEvent(new CustomEvent('v82:sync', { detail: lastState }));
  } catch { /* 非瀏覽器環境（測試）→ 冇所謂 */ }
}

/* ============================================================
   寫入模型（2026-09-24 團長定案 · 第五輪）
   ------------------------------------------------------------
   團長原話：「我只想要頂部 1 個儲到後端的制，其他任何時候都是暫儲在遊覽器」。

   所以：
     · **頂部「儲存到後端」＝唯一寫入路**（saveToBackend）
     · 其他一切改動 ＝ 淨係寫瀏覽器 localStorage（pending +1）
     · 每個分頁自己嘅「儲存」掣 ＝ 寫瀏覽器（唔掂後端）

   ⚠️ 但帳戶級改動（開人／設密碼／改身份）**未寫入後端之前，另一部機登唔到**
      —— 因為登入核對讀嘅係後端嗰份名冊（requireBackendForLogin）。
      技術上遲寫完全冇問題，只要喺對方登入之前寫到就得；
      以前壞係因為**根本冇人寫**。所以呢度唔自動寫，改為：
        ① pendingAccounts 計數 → 頂部明確講「N 項未寫入（包括 X 個帳戶）」
        ② 登出／閂頁 一律**擋住問**（見 main.js confirmLogout / beforeunload）
           —— 團長 2026-09-24 定案：問，但**永遠唔代你寫**。
           用戶撳「照登出（唔寫入）」＝ 放棄呢次機會，改動留喺本機；
           下次登入會同後端三方比對，下次登出**會再問多次**。
           要寫，唯一方法係撳右上角「儲存到後端（N）」。
   ============================================================ */

/** 由 store.persist() 掛住：本機有改動 → 更新頂部狀態（唔會寫後端） */
export function scheduleSave(info = {}) {
  if (!remoteCfg().ok) return;
  if (!hasPending()) return;
  const acc = pendingAccounts();
  setState('pending', acc
    ? `未寫入後端：${pendingCount()} 項（包括 ${acc} 個帳戶改動 —— 未寫入，佢哋喺其他裝置登唔到）`
    : `未寫入後端：${pendingCount()} 項改動暫存喺呢部機`);
}

function pendingCount() {
  return Number(tryLoad()?.sync?.pending || 0);
}

/** 未寫入後端嘅**帳戶級**改動數（開人／設密碼／改身份）。
 *  呢個數 > 0 ＝ 有其他裝置用嗰啲 email／YMIS 登唔到。 */
export function pendingAccounts() {
  return Number(tryLoad()?.sync?.pendingAccounts || 0);
}
/** 有冇改動仲未寫入後端 */
export function hasPending() {
  const db = tryLoad();
  return !!(db?.sync?.pending);
}

/* ---------------- 設定 ---------------- */
export function remoteCfg() {
  const db = tryLoad();
  if (!db) return { url: '', apiKey: '', unit: '', auto: true, ok: false, viaProxy: false };
  const s = db.sync || {};
  const url = s.url || db.backend?.gasUrl || '';
  const unit = s.unit || db.unitCode || currentUnit() || '';
  /* 部署喺 Vercel（有 /api/proxy）嗰陣，後端網址同 API Key 都係伺服器端
     由 TROOP_<編號>_BACKEND / TROOP_<編號>_APIKEY 解析 —— 前端唔應該、
     亦都唔需要知道。所以只要有旅團編號就當接得通，唔好再要求用家填 /exec。 */
  const viaProxy = canUseProxy();
  /* /api/units 只回公開欄位，但會帶 backendReady。呢個標記代表：
     選旅團本身已經同 Vercel Registry 接好，唔係要求用家再填一次 /exec。
     上次已經成功行過 proxy 都算 verified（即使部署名單 API 當刻讀唔到）。 */
  const entry = unit ? (unitEntry(unit) || {}) : {};
  const serverManaged = !!(
    entry.backendReady ||
    (lastBackend.verified && lastBackend.unit === unit && lastBackend.route === 'proxy')
  );
  const directReady = isExecUrl(url);
  return {
    url,
    apiKey: s.apiKey !== undefined ? s.apiKey : (db.backend?.apiKey || ''),
    unit,
    /* 有字串唔等於係有效後端：舊 cache 留低咗 /dev／錯網址時，唔可以畫綠燈。 */
    ok: directReady || (viaProxy && !!unit),
    viaProxy,
    directReady,
    serverManaged
  };
}

/** 後端有冇設定好（可以寫入） */
export function remoteConfigured() { return remoteCfg().ok; }

function notConfiguredMessage(cfg = remoteCfg()) {
  if (cfg.unit && cfg.viaProxy) {
    return '已選定旅團，但同源 Vercel 代理未能建立；唔需要再填第二個後端。請稍後再試，或者用「求救（回報問題）」通知平台。';
  }
  return '未設定後端網址（去「總表同步」填 /exec）';
}

/* ---------------- 呼叫後端 ---------------- */
function canUseProxy() {
  try {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
  } catch { return false; }
}

/**
 * 送一個 action 去旅團後端。
 *
 * 兩條路（完整解釋見 lib/gateway.js 頂部）：
 *   ① 同源 /api/proxy —— 平台伺服器端登記咗旅團（TROOP_<編號>_BACKEND/_APIKEY），
 *      API Key 留喺伺服器，瀏覽器唔會見到。
 *   ② 直接打領袖自己貼嘅 /exec —— 平台未登記嗰陣唯一嘅自助路線。
 *
 * 2026-09-19 修正（團長回報「填咗 /exec 都係同步唔到」）：
 * 以前 proxy 對未登記旅團回 HTTP 404 ＋ JSON，而舊 code 只在「回應唔係 JSON」
 * 嗰陣先肯跌落 ② —— 所以 ② 永遠行唔到，領袖自己貼嘅 /exec 形同虛設。
 * 而家統一由 gateway.postBackend() 路由：proxy 話「未登記」就跌落 ②。
 */
async function callBackend(payload, { timeoutMs = 60000 } = {}) {
  const cfg = remoteCfg();
  if (!cfg.unit) return { ok: false, reason: 'not_configured', error: '未知旅團編號' };
  if (!cfg.url && !cfg.viaProxy) {
    return { ok: false, reason: 'not_configured', error: notConfiguredMessage(cfg) };
  }

  const r = await postBackend(payload, {
    unit: cfg.unit, execUrl: cfg.url, apiKey: cfg.apiKey, timeoutMs
  });

  /* 兩條路都冇得行：講清楚係「平台未登記」定「自己都未填」。
     兩種都要有 hint —— 以前 not_configured 呢種回空 hint，
     用家淨係見到「未設定後端網址」五個字，完全唔知下一步做乜。 */
  if (r.via === 'none') {
    return {
      ok: false, reason: r.reason, error: r.error,
      hint: r.reason === 'not_registered' ? SELF_SERVE_HINT : NO_ROUTE_HINT
    };
  }
  if (!r.json) {
    noteBackend(r, { error: r.error || '連唔到旅團後端' });
    return { ok: false, reason: r.reason || 'network', error: r.error || '連唔到旅團後端', hint: r.reason === 'bad_url' ? URL_HINT : '', via: r.via };
  }
  const out = normalize(r.json);
  out.via = r.via;                       // 界面／診斷用：今次行咗邊條路
  /* ★ v2.8.0：後端自報識唔識「簡單寫入」（逐表）—— 見過一次就記住 */
  if (out.simpleWrite === true) simpleMode = true;
  /* ★ v2.8.0：後端自報「識唔識簡單寫入」。status／dbInfo 都會帶呢個欄位，
     所以開機第一次問後端就已經知 —— 唔使另外發一個請求。 */
  if (out.simpleWrite === true) simpleWrite = true;
  else if (out.simpleWrite === false) simpleWrite = false;
  if (!out.ok) out.hint = hintOf(out.error, r.via);
  noteBackend(out, { version: out.backendVersion, error: out.error });
  return out;
}

/* 「平台未登記」嗰陣嘅自助方法 —— 呢句一定要出到嚟，
   否則用家只見到「找不到此旅團」，完全唔知自己其實即刻救得返。 */
const SELF_SERVE_HINT =
  '平台伺服器端未登記你旅團嘅後端（TROOP_<旅團編號>_BACKEND / _APIKEY 未設定，或者變數名打錯）。'
  + '兩個選擇：① 叫平台管理員喺 Vercel 加返嗰兩個環境變數再 Redeploy；'
  + '② 自己即刻救返 —— 去「資料管理 → 總表同步 → 同步設定」，'
  + '貼你嘅 Apps Script /exec 網址＋API Key（喺 Apps Script 執行 showApiKey() 攞），撳「儲存設定」，'
  + '然後再試一次。';

/* 兩條路都行唔到：呢個部署根本冇 /api/proxy（純靜態），而用家又未貼 /exec。
   呢種情況以前只回「未設定後端網址」五個字、冇 hint —— 用家完全唔知下一步。 */
const NO_ROUTE_HINT =
  '呢個部署讀唔到同源代理（/api/proxy），而你自己都未貼 /exec，所以兩條路都行唔到。'
  + '兩個選擇：① 用正式部署（有 /api 嗰個），並確認平台管理員喺 Vercel 設咗 '
  + 'TROOP_<旅團編號>_BACKEND / _APIKEY；② 即刻自救 —— 去「資料管理 → '
  + '總表同步 → 同步設定」，貼你嘅 Apps Script /exec 網址＋API Key'
  + '（喺 Apps Script 執行 showApiKey() 攞），撳「儲存設定」。';

const URL_HINT =
  '後端網址一定要係 Apps Script「部署為網頁應用程式」之後嘅正式網址：'
  + 'https://script.google.com/macros/s/…/exec（唔接受 /dev，唔接受其他網域）。';

function normalize(j) {
  const ok = j.ok === true || j.success === true;
  const raw = j.error || (ok ? '' : (j.msg || '後端拒絕咗呢個請求'));
  return { ...j, ok, error: raw, reason: ok ? '' : reasonOf(raw), hint: ok ? '' : hintOf(raw, '') };
}

/* 後端回嘅錯誤字眼 → 分類，等介面可以講返「去邊度撳邊粒掣」 */
function reasonOf(err) {
  const s = String(err || '');
  if (/API ?Key|未授權|unauthor/i.test(s)) return 'bad_key';
  if (/未知 action|unknown action/i.test(s)) return 'old_deploy';
  return 'backend';
}

/* 呢兩個係最常見、又最難自己估到嘅死因，所以直接寫清楚點解決。
   `via` ＝ 今次行緊邊條路（'proxy' = 平台代理／'direct' = 自己貼嘅 /exec）——
   同一個「API Key 唔啱」，兩條路嘅救法完全唔同，提示一定要分開。
   （export 出嚟畀 tests/remote.mjs 做**行為**斷言，唔使再 grep 原始碼。） */
export function hintOf(err, via = '') {
  const r = reasonOf(err);
  if (r === 'bad_key') {
    /* 行緊自助路線（直接打 /exec）＝ 條 key 由瀏覽器帶，提示就唔應該
       淨係叫「搵平台管理員」—— 用家自己貼返條 key 就即刻得。 */
    if (via === 'direct') {
      return '你而家行緊「自己貼 /exec」路線，條 API Key 要跟住一齊貼。'
        + '喺 Apps Script 執行 showApiKey() 攞到嗰條（v82_…），貼入「總表同步 → 同步設定 → API Key」再儲存。'
        + '（正路仍然係交畀平台管理員入 Vercel 環境變數 TROOP_<旅團編號>_APIKEY，咁條 key 就唔會落瀏覽器。）';
    }
    /* 平台代理路線：條 key 應該留喺伺服器端 —— 呢度**唔會**叫用家自己打 key
       （2026-09-17 嘅決定，仍然有效）。自助路線嘅提示係另一條 branch。 */
    return '後端有設 API Key，但伺服器端未有。'
      + '請平台管理員喺 Vercel 加環境變數 TROOP_<旅團編號>_APIKEY（值＝喺 Apps Script 執行 showApiKey() 攞到嗰條），'
      + '同埋確認 TROOP_<旅團編號>_BACKEND 係你個 /exec 網址，然後重新部署。'
      + '咁條 key 就淨係留喺伺服器端，瀏覽器完全唔會見到。';
  }
  if (r === 'old_deploy') {
    return '你個 /exec 仲行緊舊版程式碼。喺 Apps Script 撳「部署 → 管理部署作業 → 編輯（鉛筆）→ 版本揀「新版本」→ 部署」，個 /exec 網址唔會變。';
  }
  return '';
}

/* ============================================================
   分段讀取（v2.6.0）—— 大資料庫讀得返
   ------------------------------------------------------------
   Vercel 代理單一回應有 4.5MB 硬上限。資料庫一大過呢個數，
   `loadDb` 一次過回成份 JSON 就會令 Vercel 回 500
   FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE（純文字，唔係 JSON）。
   舊 code 見到「唔係 JSON」就當「呢個部署冇 /api」→ 跌落自助路線 →
   對用家講「未設定後端網址」，明明後端登記得好哋。
   每部機於是讀唔到後端、各自儲存自己嗰份 —— 就係「無痕同普通視窗
   永遠對唔到料」。

   做法：後端 `loadDbPart` 每次只回一段純文字（約 1MB），呢度逐段拼返。
   每段都帶 version —— 讀緊嗰陣有人儲存咗（version 變咗）就由頭再讀，
   唔會拼出半新半舊嘅 JSON。
   ============================================================ */

/* Vercel 代理單一回應嘅硬上限 —— 爆咗佢唔會回 JSON，而係回純文字 500 */
export const VERCEL_RESPONSE_BYTES = 4.5 * 1024 * 1024;
/* 經同源代理時，資料庫大過呢個數就直接分段讀（留水位畀 4.5MB 硬上限） */
export const SEGMENT_ABOVE_BYTES = 3_000_000;
/* 後端要更新先有分段讀取 —— 呢段提示唔可以再講「未設定後端網址」（後端明明登記好） */
const UPDATE_GS_HINT =
  '後端仲行緊 v2.5.0 之前嘅版本，未支援分段讀取（loadDbPart）。'
  + '去「資料管理 → 總表同步 → 後端 Apps Script 範本」撳「下載 Code.gs」'
  + ' → 貼入 Apps Script（全部取代）→ 儲存 →「部署 → 管理部署作業 → 編輯（鉛筆）'
  + ' → 版本：新版本 → 部署」。/exec 網址唔會變，前端設定唔使改。';
/* 分段讀嘅安全閘：段數上限（防後端回錯 parts 令前端無限讀落去） */
const SEGMENT_MAX_PARTS = 400;
/* 讀緊嗰陣撞正有人儲存 → 由頭再讀，最多幾多次 */
const SEGMENT_MAX_RETRIES = 3;

/** 逐段讀返成份資料庫（v2.6.0；後端要係 v2.6.0 先有 loadDbPart） */
export async function pullDbSegmented({ onProgress } = {}) {
  for (let attempt = 1; attempt <= SEGMENT_MAX_RETRIES; attempt++) {
    const chunks = [];
    let version = '', at = '', total = 0, count = 0;
    let stale = false;

    for (let idx = 0; idx < SEGMENT_MAX_PARTS; idx++) {
      const r = await callBackend({ action: 'loadDbPart', partIdx: idx });
      /* 舊版後端（v2.5.0 之前）唔識 loadDbPart → 回「未知 action」。
         呢個一定要如實講：唔好扮「未設定後端網址」，亦唔好扮讀到。 */
      if (!r.ok) {
        return {
          ok: false, reason: r.reason || 'backend', error: r.error || '分段讀取失敗',
          hint: r.reason === 'old_deploy' || /未知 action|unknown action/i.test(String(r.error || ''))
            ? '後端仲行緊 v2.5.0 之前嘅版本，未支援分段讀取。去「總表同步 → 後端 Apps Script 範本」'
              + '撳「下載 Code.gs」→ 貼入 Apps Script → 部署（版本揀「新版本」，/exec 網址唔會變）。'
            : (r.hint || ''),
          segmented: true
        };
      }
      if (!r.found) {
        return { ok: true, found: false, db: null, bytes: 0, at: r.at || '', version: r.version || '', segmented: true };
      }
      if (idx === 0) {
        version = String(r.version || ''); at = String(r.at || '');
        total = Number(r.bytes) || 0; count = Number(r.parts) || 1;
        if (count > SEGMENT_MAX_PARTS) {
          return { ok: false, reason: 'too_large', segmented: true,
            error: `資料庫太大（${count} 段，超過分段讀取上限）—— 相片本應上 Drive 而唔係塞喺資料庫；請用「求救（回報問題）」通知平台跟進。` };
        }
      } else if (String(r.version || '') !== version) {
        /* 讀緊嗰陣有人儲存咗 —— 手上嗰幾段已經過時，由頭再讀 */
        stale = true; break;
      }
      chunks.push(String(r.part || ''));
      if (typeof onProgress === 'function') onProgress(idx + 1, count, total);
      if (chunks.length >= count) break;
    }
    if (stale) continue;

    const text = chunks.join('');
    try {
      return { ok: true, found: true, db: JSON.parse(text), bytes: text.length, at, version, segmented: true };
    } catch {
      return { ok: false, reason: 'corrupt', segmented: true,
        error: '分段讀返嘅內容砌唔成完整 JSON（讀緊嗰陣資料庫變咗）—— 請再試一次' };
    }
  }
  return { ok: false, reason: 'busy', segmented: true,
    error: `讀緊嗰陣不斷有人儲存（試咗 ${SEGMENT_MAX_RETRIES} 次）—— 請稍後再試` };
}

/** 逐表讀（一個表一個請求）—— 成份資料庫大過代理回應上限嗰陣用 */
async function pullTablesPart() {
  const db = {};
  let at = '', version = '', count = 0;
  const broken = new Set();
  for (let idx = 0; idx < 200; idx++) {
    const r = await callBackend({ action: 'loadTablesPart', idx }, { timeoutMs: 90000 });
    if (!r.ok) {
      if (/未知 action|unknown action/i.test(String(r.error || ''))) { simpleWrite = false; }
      return { ok: false, reason: r.reason || 'backend', error: r.error || '逐表讀取失敗', hint: r.hint || '', segmented: true };
    }
    if (Array.isArray(r.broken) && r.broken.length) return { ok: false, reason: 'broken_tables', error: '後端有損壞的表：' + r.broken.join('、') };
    if (!r.found) return { ok: true, found: false, db: null, bytes: 0, at: r.at || '', version: r.version || '', segmented: true };
    if (version && (r.version !== version || Number(r.count) !== count)) {
      return { ok: false, reason: 'changed_during_read', error: '讀取期間後端版本改變，請重新讀取' };
    }
    count = Number(r.count) || 0;
    if (r.name) db[String(r.name)] = r.value;
    /* 逐表讀都要如實報邊個表壞咗 —— 唔可以因為「一個表一個表攞」就扮冇事 */
    if (Array.isArray(r.broken)) r.broken.forEach((b) => broken.add(String(b)));
    at = r.at || at; version = r.version || version;
    if (idx + 1 >= count) break;
  }
  const text = JSON.stringify(db);
  return { ok: true, found: true, db, bytes: text.length, at, version, mode: 'simple',
    broken: [...broken], segmented: true };
}

/** 由後端讀返成個資料庫（唔會自動覆蓋本機 —— 交返畀呼叫者決定）
 *  @param {object} [opts]
 *    - bytes  已經知道嘅資料庫體積（例如啱啱 dbInfo 攞到）：
 *             大過 SEGMENT_ABOVE_BYTES 就唔使白撞一次 4.5MB 上限，直接分段讀。
 *             冇提供就先試單一讀，失敗先退去分段（慳一次 GAS 配額）。 */
export async function pullDb({ bytes: knownBytes } = {}) {
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: notConfiguredMessage(cfg) };
  setState('loading', '讀取緊後端資料…');

  const mb = (n) => `${(Number(n) / 1048576).toFixed(1)} MB`;

  /* ★ v2.8.0 逐表讀（VSBADGE 式）：某個表壞咗淨係唔要嗰個表（broken 會報出嚟），
     唔會好似舊路線咁「一段壞咗＝成份資料庫讀唔到」。
     後端仲未有「資料表」分頁（found:false）→ 自動跌返去讀舊嘅「資料庫」整份 blob，
     所以升級 Code.gs 之後、未做第一次儲存之前，舊資料照樣讀得到。 */
  if (simpleMode) {
    const t = await callBackend({ action: 'loadTables' }, { timeoutMs: 90000 });
    if (t.ok && Array.isArray(t.broken) && t.broken.length) {
      setState('error', '後端有損壞的表：' + t.broken.join('、'));
      return { ok: false, reason: 'broken_tables', error: '後端有損壞的表：' + t.broken.join('、'), broken: t.broken };
    }
    if (t.ok && t.found) {
      setState('idle');
      return { ...t, mode: 'simple' };
    }
    if (!(t.ok && !t.found)) {
      /* 讀得到但砌唔返／回應過大 → 一個表一個表攞（呢個先係逐表讀嘅好處） */
      const per = await pullTablesPart();
      if (per.ok) { setState('idle'); return per; }
      setState('error', t.error || '讀取失敗');
      return { ...t, fallback: { error: per.error || '', reason: per.reason || '' } };
    }
    /* t.ok 但 found:false → 後端「資料表」分頁仲未有嘢 → 讀返舊 blob（下面） */
  }

  /* 已經知道太大 → 直接分段（唔好白撞一次 4.5MB 上限） */
  if (Number(knownBytes) > SEGMENT_ABOVE_BYTES) {
    setState('loading', `資料庫 ${mb(knownBytes)} —— 分段讀取緊…`);
    const seg = await pullDbSegmented({ onProgress: (i, n) => setState('loading', `分段讀取 ${i}/${n}…`) });
    if (seg.ok) setState('idle'); else setState('error', seg.error || '讀取失敗');
    return seg;
  }

  const r = await callBackend({ action: 'loadDb' });
  if (r.ok && r.found) { setState('idle'); return r; }

  /* ★ 安全網（v2.8.0）：舊「資料庫」分頁睇落係空 —— 但升級之後嘅資料係寫喺
     「資料表」分頁。如果後端其實係新版而我哋未問過（simpleMode 仲係 false），
     呢度探一次。唔探嘅話，「升級咗 Code.gs、資料已經搬去資料表」會被誤判做
     「後端冇資料」，跟住一次儲存就會用本機嗰份蓋過去 —— 呢個正正係「洗紀錄」。 */
  if (r.ok && !r.found && !simpleProbed) {
    simpleProbed = true;
    const probe = await callBackend({ action: 'loadTables' }, { timeoutMs: 90000 });
    if (probe.ok && Array.isArray(probe.broken) && probe.broken.length) {
      return { ok: false, reason: 'broken_tables', error: '後端有損壞的表：' + probe.broken.join('、') };
    }
    if (probe.ok && probe.found) {
      simpleMode = true;
      setState('idle');
      return { ...probe, mode: 'simple' };
    }
  }
  if (r.ok) { setState('idle'); return r; }

  /* 單一讀失敗 —— 好可能就係「回應過大」（代理回 500 純文字）。
     退去分段讀再試一次：寧願慢，都好過靜靜地讀唔到、
     然後兩部機各睇自己嗰份（2026-09-20 事故）。 */
  setState('loading', '改用分段讀取…');
  const seg = await pullDbSegmented({ onProgress: (i, n) => setState('loading', `分段讀取 ${i}/${n}…`) });
  if (seg.ok) { setState('idle'); return seg; }

  /* 兩條路都唔得 —— 如實報單一讀嗰個錯（佢先係主因），
     但**唔可以**講「未設定後端網址」：後端明明答咗話，只係答唔晒。 */
  setState('error', r.error || seg.error || '讀取失敗');
  return { ...r, hint: r.hint || seg.hint || '', fallback: { error: seg.error || '', reason: seg.reason || '' } };
}

/** 只問後端有冇資料、幾時更新（開機比對用，唔會傳成份資料落嚟） */
export async function remoteInfo() {
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured' };
  const r = await callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
  /* 問唔到後端一定要出到嚟 —— 以前呢度靜靜雞回，右上角照樣顯示「已連後端」，
     用家完全唔知其實一直冇同步（2026-09-19 團長回報）。 */
  if (!r.ok) setState('unreachable', r.error || '連唔到後端');
  return r;
}

/* ============================================================
   分件儲存（v2.4.0 長壽命架構）
   資料庫大過單一請求上限（proxy/Vercel ~4MB）都存得到：
   把 db 頂層 key 貪心分組成 N 件（每件 JSON < maxBytes）；
   大過 maxBytes 嘅陣列（例如十年帳目）會自己再切件。
   後端 saveDbCommit 拼合：同 key 全部係陣列 → 接駁；否則後件覆蓋。
   ============================================================ */
export const PART_MAX_BYTES = 2_800_000;   // 每件安全上限（< proxy 4MB / Vercel 4.5MB）
export const CHUNKED_ABOVE = 2_800_000;    // db JSON 大過呢個數就自動行分件

/** 純函數：把 db 拆成部分 db 陣列（每件 < maxBytes）。第一件一定有 meta／schema／unitCode。 */
export function splitDbIntoParts(db, maxBytes = PART_MAX_BYTES) {
  const must = ['schema', 'kind', 'unitCode'];
  const keys = Object.keys(db || {}).filter(k => !must.includes(k));
  const parts = [];
  let cur = {};
  const sizeOf = v => { try { return JSON.stringify(v ?? null).length; } catch { return 0; } };
  const curSize = () => Object.keys(cur).reduce((a, k) => a + sizeOf(cur[k]) + k.length + 4, 2);

  /* 細 key 先裝入第一件 */
  keys.forEach(k => {
    const sz = sizeOf(db[k]);
    if (sz > maxBytes * 0.8) return;               // 大件遲啲處理
    if (curSize() + sz > maxBytes && Object.keys(cur).length) { parts.push(cur); cur = {}; }
    cur[k] = db[k];
  });
  if (Object.keys(cur).length) { parts.push(cur); cur = {}; }

  /* 大 key：陣列可以切片；物件就要成件（理論上唔會超，超就照送） */
  keys.forEach(k => {
    const v = db[k];
    const sz = sizeOf(v);
    if (sz <= maxBytes * 0.8) return;
    if (Array.isArray(v)) {
      const per = Math.max(1, Math.ceil(v.length / Math.ceil(sz / (maxBytes * 0.8))));
      for (let i = 0; i < v.length; i += per) parts.push({ [k]: v.slice(i, i + per) });
    } else {
      parts.push({ [k]: v });
    }
  });

  /* 第一件注入必要欄位 */
  const head = {};
  must.forEach(k => { if (db?.[k] !== undefined) head[k] = db[k]; });
  if (!parts.length) parts.push({});
  parts[0] = { ...head, ...parts[0] };
  return parts;
}

/**
 * 相片上 Drive（v2.3.0 體積治理）：
 * APP 內申報嘅單據相直接經後端存入 Drive，db 入面只留連結 ——
 * 以前 dataURL 會將整個資料庫 JSON 撐到爆（saveDb 9MB 上限，
 * 一到就成個同步寫唔入）。
 */
export async function uploadPhotos(photos = [], { id = '' } = {}) {
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: notConfiguredMessage(cfg), links: [] };
  /* 單據 Drive 資料夾：旅團設定（財務 → 設定／系統 都改到同一個欄） */
  const receiptDrive = String(tryLoad()?.settings?.receiptDrive || '').trim();
  const r = await callBackend({ action: 'uploadPhotos', payload: { id, photos }, folderId: receiptDrive }, { timeoutMs: 90000 });
  if (r?.ok && Array.isArray(r.links)) return { ok: true, links: r.links };
  return { ok: false, error: r?.error || '上載唔到', links: [] };
}

/* ============================================================
   ① 登入／開機：由後端攞資料（＝基準）
   ============================================================ */

/**
 * 由後端攞成份資料，做呢部機嘅工作副本＋基準。
 *
 * 本機有未儲存改動（上次未撳儲存就閂咗）→ 唔會丟：三方比對之後
 *   · 唔撞嘅改動保留喺本機（等你撳儲存）
 *   · 撞嘅格暫時用後端，衝突名單回傳畀介面問用家（policy:'ask'），
 *     或者直接用我嘅（policy:'mine'，團員入口交嘢用）
 *
 * @returns {Promise<{ok:boolean, found?:boolean, fresh?:boolean, merged?:boolean,
 *   mine?:number, theirs?:number, same?:number, conflicts?:Array, ctx?:object,
 *   version?:string, at?:string, error?:string, reason?:string, hint?:string}>}
 */
export async function loadFromBackend({ policy = 'ask' } = {}) {
  if (!remoteConfigured()) return { ok: false, reason: 'not_configured', error: notConfiguredMessage() };
  const got = await pullDb();
  if (!got.ok) {
    setState('unreachable', got.error || '連唔到後端');
    return { ok: false, error: got.error || '讀唔到後端', reason: got.reason || 'network', hint: got.hint || '' };
  }
  const version = String(got.version || '');
  const at = String(got.at || '');
  if (!got.found) {
    /* 新旅團：後端仲係空。本機（種子／未存嘅嘢）保留，基準＝空 → 之後儲存全部當我加嘅 */
    markBackendEmpty();
    lastLoadAt = Date.now();
    setState(hasPending() ? 'pending' : 'idle', hasPending() ? '後端仲係空 —— 撳「儲存到後端」建立第一份' : '後端仲未有資料');
    return { ok: true, found: false, version: '', at: '' };
  }
  if (!version) {
    /* 舊版 Code.gs（冇版本號）：版本對唔到，樂觀鎖亦冇用 —— 照載入，但要話人知 */
    setState('error', '後端係舊版 Code.gs（冇版本號）—— 請更新 Apps Script');
  }
  const local = tryLoad();
  const pending = Number(local?.sync?.pending || 0);
  const base = getBase();
  /* 「有冇未儲存改動」以 diff(基準, 本機) 為準（pending 只係次數提示）；
     冇基準嘅舊裝置先至睇 pending */
  const dirty = base?.db ? localChanges().length > 0 : (pending > 0 && hasLocalContent());

  if (!dirty) {
    adoptRemote(got.db, { version });
    lastLoadAt = Date.now();
    setState('idle', '已由後端載入');
    return { ok: true, found: true, fresh: true, version, at };
  }

  const remoteN = normalizeRemote(got.db);
  if (!base || !base.db) {
    /* 升級前留低嘅裝置：有未存改動但冇基準快照，分唔到「我改咗乜」。
       最穩陣：以後端為準，只把本機**多出嚟**嘅紀錄補入（唔刪、唔蓋任何格）。 */
    const merged = unionAdditions(remoteN, local);
    setLocalMerged(merged, remoteN, { version, pending });
    lastLoadAt = Date.now();
    setState(hasPending() ? 'pending' : 'idle');
    return { ok: true, found: true, merged: true, legacy: true, version, at };
  }

  const tw = threeWay(base.db, stripForBase(local), remoteN);
  let merged = tw.merged;
  let conflicts = tw.conflicts;
  if (policy === 'mine' && conflicts.length) {
    merged = JSON.parse(JSON.stringify(merged));
    applyChanges(merged, overridesFor(conflicts, true));
    conflicts = [];
  }
  setLocalMerged(merged, remoteN, { version, pending });
  lastLoadAt = Date.now();
  setState(hasPending() ? 'pending' : 'idle');
  return {
    ok: true, found: true, merged: true, version, at,
    mine: tw.mine.length, theirs: tw.theirs.length, same: tw.same.length,
    conflicts, ctx: { local: stripForBase(local), remote: remoteN }
  };
}

/* ============================================================
   核對「係咪真係寫咗入去」
   ------------------------------------------------------------
   團長 2026-09-24：「我完全不知道他能不能寫進後端，要是能寫進為什麼讀不到」。
   verifyAgainstBackend(v)（下面）就係答呢條問題嗰件：儲存之後即刻再問後端
   一次 —— 版本係唔係我啱啱寫嗰個？各表筆數同本機一唔一樣？
   介面喺 syncdialog.js 用佢，只讀，唔會改任何正式紀錄。

   2026-11-12 精簡：本來仲有 remoteDiagnose / backendHealth / repairBackend /
   forcePushBackend / backendReality / syncProbe / testConnection / testReadWrite
   八個前端函數。對應 UI 喺 2026-09-26 拆走之後全部變成屍體（只有測試夾具
   叫佢哋），所以刪走。後端逃生門 repairDb / saveDbForce / syncCheck 仍然喺
   Code.gs，照樣可以由人手 POST 救機 —— 部署指南有步驟。
   ============================================================ */

/** 拎嚟對數嘅表（dbInfo 有回呢幾樣 —— 唔使改 Code.gs 都用得到） */
export const REALITY_KEYS = [
  ['members', '用戶'],
  ['transactions', '帳目'],
  ['meetings', '會議'],
  ['notices', '通告'],
  ['invItems', '物資'],
  ['accounts', '舊版帳戶']
];

function localCounts() {
  const db = tryLoad() || {};
  const out = {};
  REALITY_KEYS.forEach(([k]) => { out[k] = Array.isArray(db[k]) ? db[k].length : 0; });
  return out;
}

/** 砌「本機 vs 後端」逐表對數（畀介面直接畫表） */
function realityRows(backendCounts, local) {
  const b = backendCounts || {};
  return REALITY_KEYS.map(([k, label]) => {
    const bv = b[k] === undefined || b[k] === null ? null : Number(b[k]);
    const lv = Number(local[k] || 0);
    return { key: k, label, local: lv, backend: bv, same: bv === null ? null : bv === lv };
  });
}

/**
 * ② 儲存之後即刻核對：後端版本係咪我啱啱寫嗰個？各表筆數同本機一唔一樣？
 * @param {string} expectedVersion  saveToBackend 成功回傳嘅版本號
 */
export async function verifyAgainstBackend(expectedVersion = '') {
  const local = localCounts();
  const out = {
    ok: false, matched: false, error: '', hint: '',
    version: '', expectedVersion: String(expectedVersion || ''),
    at: '', sheet: '', bytes: 0, local, backend: null, rows: []
  };
  const info = await callBackend({ action: 'dbInfo' }, { timeoutMs: 25000 });
  if (!info.ok) {
    out.error = info.error || '核對嗰陣讀唔到後端';
    out.hint = info.hint || '';
    return out;
  }
  out.ok = true;
  out.sheet = spreadsheetName();
  out.found = !!info.found;
  out.version = String(info.version || '');
  out.at = String(info.at || info.version || '').slice(0, 19).replace('T', ' ');
  out.bytes = Number(info.bytes || 0);
  out.backend = info.counts || null;
  /* ★ v2.8.1：收據真相欄位 —— 分得出「真係空」定「有行但讀唔到」 */
  out.route = String(info.via || '');
  out.unit = String(remoteCfg().unit || '');
  out.mode = String(info.mode || '');
  out.simpleRows = Number(info.simpleRows || 0);
  out.blobRows = Number(info.blobRows || 0);
  out.broken = Array.isArray(info.broken) ? info.broken.slice() : [];
  out.backendVersion = String(info.backendVersion || '');
  out.rows = realityRows(info.counts, local);
  const versionOk = !out.expectedVersion || out.version === out.expectedVersion;
  const countsOk = out.rows.every(r => r.same !== false);
  out.matched = !!info.found && versionOk && countsOk;
  out.versionOk = versionOk;
  out.countsOk = countsOk;
  return out;
}

function spreadsheetName() { return lastSpreadsheet; }

/** 冇基準嘅舊裝置專用：後端為準 ＋ 本機多出嚟嘅紀錄（有 id）補入。唔刪、唔蓋。 */
function unionAdditions(remote, local) {
  const out = JSON.parse(JSON.stringify(remote));
  Object.keys(local || {}).forEach(k => {
    if (['sync', 'meta', 'backend', 'unitCode', 'schema', 'kind'].includes(k)) return;
    const lv = local[k], rv = out[k];
    if (!Array.isArray(lv)) { if (rv === undefined && lv !== undefined) out[k] = lv; return; }
    if (rv === undefined) { out[k] = lv; return; }
    if (!Array.isArray(rv)) return;
    const ids = new Set(rv.map(x => (x && typeof x === 'object') ? String(x.id) : ''));
    lv.forEach(x => { if (x && typeof x === 'object' && x.id !== undefined && !ids.has(String(x.id))) rv.push(x); });
  });
  return out;
}

/** 上次成功由後端載入係幾耐之前（ms）；未載入過 ＝ Infinity */
export function loadedAgo() { return lastLoadAt ? Date.now() - lastLoadAt : Infinity; }

/**
 * 登入嗰一刻要係「後端嗰一刻」：登入頁擺咗好耐先撳登入 → 再攞一次。
 * 有未儲存改動就唔郁（唔會丟人哋嘢），交返畀之後嘅儲存流程核對。
 */
export async function ensureFresh({ maxAgeMs = 60000 } = {}) {
  if (!remoteConfigured()) return { ok: false, reason: 'not_configured' };
  if (loadedAgo() <= maxAgeMs) return { ok: true, fresh: false };
  if (hasPending()) return { ok: true, fresh: false, skipped: 'pending' };
  const info = await callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
  if (!info.ok) return { ok: false, error: info.error || '問唔到後端', reason: info.reason || 'network' };
  const base = getBase();
  if (info.found && base && String(info.version || '') === String(base.version || '')) {
    lastLoadAt = Date.now();
    return { ok: true, fresh: false, upToDate: true };
  }
  return loadFromBackend();
}

/* ============================================================
   ★ 登入硬閘（2026-09-20 團長定案）
   ------------------------------------------------------------
   團長原話：「由首頁登入旅團嗰頁，入到係正常嘅，因為喺 Vercel 登記咗；
   但能登入旅團內嘅主控頁就唔應該，因為嗰個係應該要帳戶同密碼同後端
   對上先至能進。既然都同後端對咗帳戶密碼，點可能入去之後話冇連上後端？」

   佢講得啱。以前 `login()` 係**純本機運算**（auth.js 成個函數零網絡請求）：
   佢只喺 localStorage 嘅 accounts[] 搵個 username，再比對一個隨 JS 一齊
   公開咗嘅 hash。而 accounts[] 就算後端一個字都讀唔返都會有 ——
   store.js 開機時 accounts 一空就塞 SEED_ACCOUNTS（leader／exco，defaultPw）。
   所以「登入成功」從來只代表「呢部機有一份帳戶名單」，同後端零關係。

   而家：後端答唔到 → 一律唔准入主控頁。
   ============================================================ */

/**
 * 登入前嘅硬核對。**一定要真係聯絡到後端**先至回 ok:true。
 *
 * ⚠️ 呢度刻意**唔用** `ensureFresh()`：佢喺「本機有未存改動」嗰陣會
 *    `return { ok:true, skipped:'pending' }` —— 完全冇聯絡後端。
 *    攞佢做登入閘等於冇核對過（2026-09-20 事故嘅其中一個隱藏版）。
 *
 * @returns {Promise<{ok:boolean, version?:string, at?:string,
 *                    empty?:boolean, accounts?:number, error?:string,
 *                    reason?:string, hint?:string}>}
 */
export async function requireBackendForLogin() {
  const cfg = remoteCfg();
  if (!cfg.ok) {
    return {
      ok: false, reason: 'not_configured',
      error: '未有後端設定 —— 帳戶冇辦法同後端核對，所以唔可以入主控頁',
      hint: cfg.viaProxy
        ? `平台伺服器端未登記呢個旅團（TROOP_${cfg.unit || '<編號>'}_BACKEND / _APIKEY）。`
          + '交畀平台管理員喺 Vercel 加返再 Redeploy；或者你自己去「總表同步 → 同步設定」貼 /exec ＋ API Key。'
        : '去「總表同步 → 同步設定」貼你嘅 Apps Script /exec 網址（＋ API Key）。'
    };
  }
  setState('loading', '登入前同後端核對帳戶…');
  const r = await loadFromBackend();
  if (!r.ok) {
    setState('unreachable', r.error || '連唔到後端');
    return {
      ok: false, reason: r.reason || 'network',
      error: r.error || '連唔到旅團後端 —— 帳戶無法核對，登入已封鎖',
      hint: r.hint || ''
    };
  }
  const acc = (tryLoad()?.accounts || []).filter(a => a?.active !== false);
  return {
    ok: true,
    version: String(r.version || ''),
    at: String(r.at || ''),
    /* found:false ＝ 後端真係仲未有資料庫（新旅團第一次設定）——
       呢種情況先至允許用本機種子帳戶，而且界面要講清楚。 */
    empty: r.found === false,
    accounts: acc.length
  };
}

/**
 * ★ 2026-09-24「切返呢個分頁」用：本機**冇**未存改動先至由後端拉新嗰份。
 * 唔會彈衝突框（有未存改動就乜都唔做，交返畀自動儲存處理）。
 * 呢個係「另一個視窗儲存咗 → 呢邊返嚟即刻見到」嗰條路。
 */
export async function refreshIfClean({ maxAgeMs = 20000 } = {}) {
  if (!remoteCfg().ok) return { ok: false, reason: 'not_configured' };
  if (inFlight) return { ok: false, reason: 'busy' };
  if (loadedAgo() < maxAgeMs) return { ok: false, reason: 'fresh' };
  const base = getBase();
  const dirty = base?.db ? localChanges().length > 0 : Number(tryLoad()?.sync?.pending || 0) > 0;
  if (dirty) return { ok: false, reason: 'pending' };
  const got = await pullDb();
  if (!got.ok) return { ok: false, reason: got.reason || 'network', error: got.error || '' };
  if (!got.found) return { ok: false, reason: 'empty' };
  if (String(got.version || '') === String(base?.version || '')) {
    lastLoadAt = Date.now();
    return { ok: true, fresh: true };
  }
  adoptRemote(got.db, { version: String(got.version || '') });
  lastLoadAt = Date.now();
  setState('idle', '已由後端載入（另一個視窗／裝置儲存咗新版本）');
  return { ok: true, updated: true, version: String(got.version || '') };
}

/** 「由後端重新載入」：**丟棄**本機未儲存改動，成份用返後端（介面要先確認） */
export async function discardAndReload() {
  const got = await pullDb();
  if (!got.ok) return { ok: false, error: got.error || '讀唔到後端', reason: got.reason, hint: got.hint };
  if (!got.found) return { ok: false, reason: 'empty', error: '後端仲未有資料庫' };
  adoptRemote(got.db, { version: String(got.version || '') });
  lastLoadAt = Date.now();
  setState('idle', '已由後端重新載入');
  return { ok: true, version: String(got.version || '') };
}

/* ============================================================
   ③ 儲存到後端（唯一寫入路）
   ============================================================ */

/**
 * 儲存到後端。
 *
 * @param policy   'ask'  → 撞嘅格暫時用後端、先寫其餘，然後交 resolver（介面）問用家
 *                 'mine' → 撞嘅格用我嘅（團員入口交自己嘅 RSVP 用）
 *                 'theirs' → 撞嘅格用後端，唔問
 * @param resolver async ({ conflicts, ctx, remoteAt, savedCount }) → { useMine: string[] } | null
 * @returns {Promise<{ok:boolean, pushed?:boolean, version?:string, remoteChanged?:boolean,
 *   mine?:number, theirs?:number, same?:number, applied?:number,
 *   conflicts?:Array, resolved?:number, kept?:number,
 *   error?:string, reason?:string, hint?:string, bytes?:number, parts?:number}>}
 */
/* ★ 2026-09-24：所有儲存排成一條隊。
   用家撳「儲存到後端」好容易撞正上一次未行完嗰次寫入 ——
   以前呢度直接回 `{ ok:false, reason:'busy' }`，用家見到「儲存失敗」，
   但其實乜都冇錯，只係撞咗 0.5 秒。而家排隊：等前一次完成先至行下一次。 */
let saveChain = Promise.resolve();
export function saveToBackend(opts = {}) {
  const run = saveChain.then(() => saveToBackendInner(opts), () => saveToBackendInner(opts));
  saveChain = run.then(() => undefined, () => undefined);
  return run;
}

async function saveToBackendInner({ policy = 'ask', resolver = null, silent = true, _attempt = 0 } = {}) {
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: notConfiguredMessage(cfg) };
  const local = tryLoad();
  if (!local) return { ok: false, reason: 'no_db', error: '資料庫未載入' };
  if (inFlight) return { ok: false, reason: 'busy', error: '上一次儲存仲未完成' };

  inFlight = true;
  setState('saving', silent ? '' : '核對緊後端版本…');
  try {
    /* ① 問後端而家係咩版本（平，唔使成份拉） */
    const info = await callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
    if (!info.ok) {
      setState('unreachable', info.error || '連唔到後端');
      logLocal(`✗ 未讀到後端版本，唔會寫（${info.error || '未知'}）`);
      return {
        ok: false, reason: info.reason || 'network', bytes: 0,
        error: `未讀到後端版本，唔會盲寫：${info.error || '連唔到後端'}`,
        hint: (info.hint ? info.hint + ' ' : '') + '你嘅改動冇蝕到，仲喺呢部機 —— 連返後端再撳「儲存到後端」。'
      };
    }
    const base = getBase();
    const baseVersion = String(base?.version || '');
    const remoteVersion = String(info.version || '');
    const remoteChanged = !!info.found && remoteVersion !== baseVersion;
    const localStripped = stripForBase(local);

    /* 未由後端載入過就撳儲存（例如開機時後端斷咗）：後端有嘢就一定要先載入，唔可以盲寫 */
    if (info.found && !base) {
      setState('pending', '未由後端載入過 —— 請先重新載入');
      return { ok: false, reason: 'no_base',
        error: '呢部機仲未由後端載入過資料（開機嗰陣連唔到後端）—— 唔會盲寫。請先撳「重新載入」。' };
    }

    /* ② 三方比對（只有「有人喺我登入後儲存過」先要拉成份） */
    let finalDb = localStripped;
    let mineN = 0, theirsN = 0, sameN = 0, appliedN = 0;
    let conflicts = [];
    let ctx = null;
    let remoteAt = String(info.at || '');
    if (remoteChanged) {
      const got = await pullDb();
      if (!got.ok || !got.found || !got.db) {
        setState('error', got.error || '拉唔到後端資料');
        return { ok: false, reason: got.reason || 'network', error: got.error || '後端有新版本但拉唔到 —— 改動仲喺呢部機' };
      }
      const remoteN = normalizeRemote(got.db);
      const tw = threeWay(base?.db || {}, localStripped, remoteN);
      mineN = tw.mine.length; theirsN = tw.theirs.length; sameN = tw.same.length; appliedN = tw.applied.length;
      conflicts = tw.conflicts;
      finalDb = tw.merged;
      ctx = { local: localStripped, remote: remoteN };
      remoteAt = String(got.at || remoteAt);
      if (conflicts.length && policy === 'mine') {
        applyChanges(finalDb, overridesFor(conflicts, true));
        conflicts = [];
      }
      /* 版本要用**啱啱拉嗰份**嘅（dbInfo 同 loadDb 之間都可能有人寫入） */
      if (got.version) info.version = got.version;
    } else {
      mineN = base?.db ? diffDb(base.db, localStripped).length : 0;
      appliedN = mineN;
    }

    /* ③ 寫入（樂觀鎖 baseVersion ＝ 我啱啱見到嘅後端版本） */
    const payload = exportForBackend({ ...local, ...finalDb });
    /* ★ v2.8.0 逐表寫用：正常只寫「基準 → 而家」有改過嗰幾個表。
       ★★ 但後端「資料表」分頁仲未有嘢嗰陣（info.mode 唔係 'simple'）
       **一定要寫齊所有表** —— 呢個係第一次寫入／由舊「資料庫」blob 搬過嚟嗰一次。
       如果呢度淨係寫改過嗰幾個表，另一部機讀「資料表」就會讀到一份缺晒嘅 db，
       缺咗嘅表被當做「空」—— 睇落就係「資料冇咗」。寧願第一次大啲，唔可以缺。 */
    const firstSimpleWrite = !base || String(info.mode || '') !== 'simple';
    const r = await pushPayload(payload, {
      baseVersion: String(info.version || ''), unit: cfg.unit, silent,
      tables: firstSimpleWrite ? null : changedTableNames(base?.db || null, finalDb)
    });
    if (r.conflict) {
      /* dbInfo → 寫入之間又有人寫咗（幾秒內撞正）→ 由頭核對多一次（唔會自動蓋） */
      if (_attempt < 2) {
        inFlight = false;
        logLocal('⚠ 寫入嗰一刻後端又有新版本 —— 重新核對');
        return saveToBackendInner({ policy, resolver, silent, _attempt: _attempt + 1 });
      }
      setState('conflict', '後端不停有人寫入 —— 請等一陣再儲存');
      /* ★ 2026-09-24 團長：「我完全不知道他能不能寫進後端」——
         撞版嗰陣要講得出「後端而家嗰個版本係乜」，唔可以淨係「請等一陣」。
         最常見嘅死因係後端「資料庫」分頁有舊版本段／空旅團欄嘅行，
         令「讀到嘅版本」同「寫入要對嘅版本」唔一致 —— 一睇到兩個版本對唔上就知。 */
      return {
        ok: false, reason: 'conflict',
        version: String(r.version || ''),
        error: '後端連續有人寫入，核對咗三次都撞版 —— 請等一陣再撳「儲存到後端」'
          + (r.version ? `（後端而家嗰個版本：${String(r.version).slice(0, 19).replace('T', ' ')}）` : ''),
        hint: '你嘅改動仲喺呢部機，冇蝕到 —— 等一陣再撳「儲存到後端」試一次；'
          + '如果次次都撞，用「求救（回報問題）」通知平台跟進。'
      };
    }
    if (!r.ok) {
      setState('error', r.error || '儲存失敗');
      logLocal(`✗ 儲存失敗：${r.error || '未知錯誤'}`);
      return { ok: false, reason: r.reason || 'backend', error: r.error || '儲存失敗', hint: r.hint || '',
        mode: r.mode || '', simpleRows: Number(r.simpleRows || 0) };
    }

    /* 網絡等待期間用戶仍可能繼續修改。只把已送出的快照標為已儲存；
       新改動合併回工作副本、保留 pending，不能 commitSaved() 一口氣清空。 */
    const duringSave = diffDb(localStripped, stripForBase(tryLoad()));
    if (duringSave.length) {
      const current = JSON.parse(JSON.stringify(finalDb));
      applyChanges(current, duringSave);
      setLocalMerged(current, finalDb, {
        version: String(r.version || ''), pending: Math.max(1, Number(tryLoad()?.sync?.pending || 1))
      });
    } else {
      commitSaved({ ...local, ...finalDb }, { version: String(r.version || ''), bytes: r.bytes || 0, parts: r.parts || 0 });
    }
    lastLoadAt = Date.now();
    if (remoteChanged) {
      logLocal(`ℹ 後端喺你登入後有人儲存過（${remoteAt.slice(0, 19).replace('T', ' ')}）：對方 ${theirsN} 項、你 ${mineN} 項、相同 ${sameN} 項、衝突 ${conflicts.length} 項`);
    }
    const out = {
      ok: true, pushed: true, version: String(r.version || ''), bytes: r.bytes || 0, parts: r.parts || 0,
      /* ★ v2.8.0：呢次儲存行咗邊條路 —— 'simple'（逐表寫）／''（舊嘅整份寫）。
         界面同「同步診斷」要話畀用家知，出事先追得到。 */
      mode: r.mode || '',
      remoteChanged, remoteAt, mine: mineN, theirs: theirsN, same: sameN, applied: appliedN,
      conflicts, ctx, resolved: 0, kept: conflicts.length,
      /* ★ v2.6.3 Code.gs 會喺寫完「資料庫」分頁之後**顺手刷新晒報表分頁**，
         並把結果放喺 reports。有呢個就不用再發第二個請求（慳一半 GAS 配額）；
         舊版 Code.gs 冇呢個欄位 → 前端會自己補撳「更新報表分頁」。 */
      reports: (r.reports && typeof r.reports === 'object') ? r.reports : null,
      /* ★ v2.8.1：後端自證結果（逐表寫先有；舊後端＝undefined） */
      confirmed: r.mode === 'simple' ? (r.confirmed ?? null) : null,
      simpleRows: Number(r.simpleRows || 0)
    };
    inFlight = false;

    /* ⑤ 有衝突 → 問用家（呢啲格已經用咗後端版本，未寫入我嘅）；佢確認咗先至再寫一次 */
    if (conflicts.length && policy === 'ask' && typeof resolver === 'function') {
      setState('conflict', `${conflicts.length} 項同後端唔同，未寫入 —— 等你確認`);
      let choice = null;
      try { choice = await resolver({ conflicts, ctx, remoteAt, savedCount: appliedN, mode: 'save' }); } catch { choice = null; }
      const keys = choice?.useMine === true ? true : (Array.isArray(choice?.useMine) ? choice.useMine : []);
      const ov = overridesFor(conflicts, keys);
      if (ov.length) {
        applyChangesLocal(ov);
        const again = await saveToBackendInner({ policy: 'ask', resolver: null, silent, _attempt: 0 });
        out.resolved = again.ok ? ov.length : 0;
        out.kept = conflicts.length - out.resolved;
        out.overrideOk = !!again.ok;
        if (!again.ok) out.overrideError = again.error || '';
        if (again.ok) { out.version = again.version; logLocal(`✓ 已按你確認蓋過 ${ov.length} 項`); }
      }
    }
    setState(hasPending() ? 'pending' : 'saved', hasPending() ? '仲有改動未儲存' : '已儲存到後端');
    return out;
  } finally {
    inFlight = false;
  }
}

/* ============================================================
   ★ v2.8.0 簡單寫入（學 VSBADGE）
   ------------------------------------------------------------
   VSBADGE 一路冇事，vs_portal 就係「寫入成功但讀唔到」—— 兩者最大分別：

     VSBADGE：一個請求淨係寫**一個表嗰幾行**（handleSave 改邊行改邊行）。
              冇鎖、冇分段暫存、冇「成份 serialize」。
     vs_portal（舊）：成份資料庫 → 一條大 JSON → 每段 45000 字 → 先刪晒舊段
              → 再寫晒新段 → 仲要對版本（樂觀鎖）→ 最後重刷全部報表分頁。
              任何一格出事，結果都係「成份資料庫讀唔到」。

   所以呢度照 VSBADGE 個思路改：**一個表一個表寫**。
     寫：saveTables  { tables:{ members:[…], transactions:[…] } }  ← 淨係有改過嗰幾個表
     讀：loadTables  → 逐表砌返；某個表壞咗淨係 skip 嗰個表，其餘照讀
   後端唔識（Code.gs 未更新）就自動跌返舊嘅整份 saveDb，唔會斷。
   ============================================================ */

/* 呢幾個一定要跟住每次寫入一齊上（體積細，但少咗讀返嚟就砌唔成一份完整 db） */
const ALWAYS_TABLES = ['meta', 'schema', 'kind', 'unitCode'];
/** 今次要寫邊幾個表（base → next 有改過嗰啲；base 冇＝第一次，全部都要寫） */
export function changedTableNames(baseDb, nextDb) {
  const names = new Set(ALWAYS_TABLES);
  try {
    if (!baseDb || typeof baseDb !== 'object') return null;      // null＝全部
    diffDb(baseDb, nextDb || {}).forEach(c => {
      const top = String(c?.path?.[0] || '');
      if (top && !SKIP_TOP.has(top)) names.add(top);
    });
  } catch { return null; }
  return [...names];
}

/** 由成份 payload 抽出要寫嘅表 */
function pickTables(payload, names) {
  const out = {};
  (names || Object.keys(payload || {})).forEach(k => { if (payload && k in payload) out[k] = payload[k]; });
  ALWAYS_TABLES.forEach(k => { if (payload && payload[k] !== undefined) out[k] = payload[k]; });
  return out;
}

/** 實際送出（★ v2.8.0 先試逐表寫；後端唔識先跌返單件 saveDb／大過閾值自動分件）
 *  回 { ok, conflict, version, bytes, parts, error } */
async function pushPayload(payload, { baseVersion, unit, silent, tables: changedNames }) {
  let text = '';
  try { text = JSON.stringify(payload); } catch { /* ignore */ }
  const bytes = text.length;
  if (bytes > 40000000) {
    return { ok: false, reason: 'too_big', error: `資料庫太大（${fmtBytes(bytes)}）`, hint: '去「資料管理 → 儲存與備份」撳「清理已入帳嘅相片（保留記錄）」減細體積，再試一次。' };
  }
  if (!silent) setState('saving', '寫入緊後端…');

  /* ★ v2.8.0 逐表寫（VSBADGE 式）—— 冇版本鎖、冇分段暫存、冇「成份 serialize」。
     只送有改過嗰幾個表，一次寫入通常幾 KB，撞唔到代理 4MB 上限；
     而且**先寫新、後刪舊**（後端嗰邊），中途斷都唔會乜都冇。 */
  if (simpleMode) {
    const tables = pickTables(payload, changedNames);
    /* full＝呢次送晒所有表（第一次寫入）→ 後端可以順手清走「已經冇咗嘅表」 */
    const sr = await callBackend({ action: 'saveTables', unit, tables, full: !changedNames, baseVersion }, { timeoutMs: 90000 });
    /* 舊版後端冇 confirmed；不可盲信 success，當場讀回每張剛寫的表。
       回應錯誤／有壞表／版本不同時保留 pending。 */
    if (sr.ok && sr.confirmed !== true) {
      const check = await callBackend({ action: 'loadTables' }, { timeoutMs: 90000 });
      if (check.ok && check.found && !(check.broken || []).length &&
          (!sr.version || check.version === sr.version) &&
          Object.keys(tables).every(name => JSON.stringify(check.db?.[name]) === JSON.stringify(tables[name]))) {
        sr.confirmed = true;
      }
    }
    /* 冇後端自證就靠上面讀回驗證；兩者都過唔到就保留 pending，絕不假成功。 */
    if (sr.ok && sr.confirmed !== true) {
      return {
        ok: false, reason: 'not_confirmed', mode: 'simple', bytes: 0, parts: 0, version: '',
        simpleRows: Number(sr.simpleRows || 0),
        error: '後端寫入後即刻讀返唔到（有多部機同時儲存／後端部署唔啱）—— 你嘅改動仲喺呢部機，冇蝕；請再撳一次「儲存到後端」',
        hint: '如果試幾次都係咁：① 睇下有冇另一部機／另一個分頁同時撳緊儲存；② 後端 Code.gs 可能太舊 —— 去「總表同步 → 後端 Apps Script 範本」撳「下載 Code.gs」，重貼 Code.gs、部署揀「新版本」再試。'
      };
    }
    if (sr.ok) return { ...sr, bytes: sr.bytes || bytes, parts: 0, mode: 'simple' };
    if (/未知 action|unknown action|不支援的操作/.test(String(sr.error || ''))) {
      /* 後端 Code.gs 未更新到 v2.8.0 —— 記低，今次跌返舊路，之後唔使再試 */
      simpleMode = false;
      logLocal('⚠ 後端未更新到 v2.8.0（唔識 saveTables）—— 今次改用整份寫入');
    } else {
      return { ...sr, bytes: 0, parts: 0, mode: 'simple' };
    }
  }

  if (bytes <= CHUNKED_ABOVE) {
    const r = await callBackend({ action: 'saveDb', db: payload, baseVersion });
    return { ...r, bytes: r.bytes || bytes, parts: 0 };
  }
  /* 自 v2.4.0 起 分件：拆件 → 逐件送（任何一件撞版即停）→ commit 拼合 */
  const parts = splitDbIntoParts(payload, PART_MAX_BYTES);
  const saveId = `${unit}-stg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  for (let i = 0; i < parts.length; i++) {
    setState('saving', `分件儲存中…（${i + 1}/${parts.length}）`);
    const pr = await callBackend({ action: 'saveDbPart', unit, data: parts[i], partIdx: i, parts: parts.length, saveId, baseVersion });
    if (!pr.ok && /未知 action/.test(String(pr.error || ''))) {
      /* 舊後端（未部署 v2.4.0）→ 退返單件 */
      logLocal('⚠ 後端仲係舊版（未部署分件儲存）—— 改用單一件儲存');
      const r = await callBackend({ action: 'saveDb', db: payload, baseVersion });
      return { ...r, bytes: r.bytes || bytes, parts: 0 };
    }
    if (!pr.ok) return { ...pr, bytes: 0, parts: parts.length };
  }
  setState('saving', `分件完成，拼合中…（${parts.length} 件）`);
  const r = await callBackend({ action: 'saveDbCommit', unit, saveId, parts: parts.length, baseVersion });
  return { ...r, bytes: r.bytes || bytes, parts: parts.length };
}

/** 衝突講成人話（畀介面／測試） */
export function describeConflicts(conflicts, ctx) {
  return (conflicts || []).map(c => ({ key: c.key, ...describeConflict(c, ctx || {}) }));
}

function logLocal(msg) {
  const db = tryLoad();
  if (!db) return;
  pushLog(db, msg);
  commitMeta();
}

/* ---------------- 小工具 ---------------- */
function pushLog(db, msg) {
  db.sync = db.sync || {};
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.sync.log = [...(db.sync.log || []), { at, msg }].slice(-40);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}

export { fmtBytes };
