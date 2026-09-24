/* ============================================================
   units.js — 旅團 Registry（多旅團）
   正式旅團：data/units.json + data/units/<編號>/*.json（Git Registry 管理）
   伺服器旅團：由 Vercel 環境變數 TROOP_<編號>_* 定義（/api/units 回傳；
               唔使改 Git 都開得新旅團，資料由空白開始）
   本地旅團：只存喺呢部機嘅 localStorage（測試用，標示「本地」）
   ============================================================ */

const REG_URL = 'data/units.json';
/* 部署時焗好嘅名單（Vercel build 由 TROOP_* 環境變數生成，見 scripts/build-units.mjs）。
   2026-09-18 起行先：有真實用戶 fetch('api/units') 一律 404（function 證實唔會回 404，
   兇手喺控制範圍之外），靜態檔反而人人攞到 —— 名單唔可以淨係靠 runtime function。 */
const GEN_URL = 'data/units.generated.json';
const REG_CACHE = 'venture82.units.cache.v2';
const LOCAL_KEY = 'venture82.units.local.v2';

let cache = null;

/* 連線唔到 Registry（/api/units 同 data/units.json 都讀唔到）嗰陣嘅最後備案。
   **唔可以** hardcode 任何一個真實旅團 —— 以前呢度寫死咗 0082（連名、連
   dataPath），結果任何人一開 app、Registry 一讀唔到，就會見到第八十二旅，
   甚至讀到佢個資料夾。而家留空：讀唔到 Registry ＝ 冇旅團可揀，
   畫面會叫用家申請接入，唔會洩露任何旅團嘅資料。 */
const BUILTIN = {
  schema: 2,
  defaultUnit: '',
  units: {}
};

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') || {}; } catch { return {}; }
}
function writeLocal(obj) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

/** 同步取得 Registry（第一次要先 await loadRegistry()） */
export function registry() {
  return cache || (() => {
    try {
      const raw = localStorage.getItem(REG_CACHE);
      if (raw) { cache = JSON.parse(raw); return cache; }
    } catch { /* ignore */ }
    cache = BUILTIN;
    return cache;
  })();
}

/* Registry 到底讀唔讀到？（分開「讀唔到檔」同「讀到但一個旅團都未登記」）
   ——  兩種情況個提示要唔同：前者叫人開 HTTP 伺服器，後者叫人申請接入。 */
let regReachable = false;
export function registryReachable() { return regReachable; }

/* 而家用緊嘅係咪「上次記住嘅舊清單」？
   （伺服器／檔案一時讀唔到嗰陣，loadRegistry 會用舊嘅頂住，
     等個閘唔會一時變空 —— 見下面，2026-09-17 0082 事件。） */
let staleCache = false;
export function registryStale() { return staleCache; }

/* ---------------- 伺服器端 Registry（Vercel 環境變數）狀態 ----------------
   2026-09 團長回報「喺 Vercel 加咗 TROOP_*，但首頁揀唔到旅團」。
   以前 /api/units 一失敗（未 redeploy、環境變數名打錯、函數 500…）
   前端就靜靜雞當「冇旅團」，得一句「暫時未有旅團登記」—— 完全查唔到原因。
   而家每次讀完都留低狀態，旅團閘可以照計出嚟畀管理員睇。 */
let serverStatus = { ok: false, status: 0, count: 0, error: '', at: '' };
export function serverUnitsStatus() { return { ...serverStatus }; }

/* 部署時焗好嘅名單讀成點？（同 serverStatus 分開記：即時 API 讀唔到，
   但焗名單有貨，個閘照樣有得揀 —— 唔可以當「讀唔到伺服器清單」。） */
let bakedStatus = { ok: false, count: 0, generatedAt: '', vercelEnv: '', at: '' };
export function bakedUnitsStatus() { return { ...bakedStatus }; }

/* 檔案名單（data/units.json）讀成點？（2026-09-18 起係主流程，
   閘面同診斷要分得清「邊條路」俾嘅旅團。） */
let fileStatus = { ok: false, count: 0, error: '', at: '' };
export function fileUnitsStatus() { return { ...fileStatus }; }

const API_UNITS_URL = 'api/units';
const API_DIAG_URL = 'api/units?diag=1';

/** 由部署時焗好嘅靜態檔攞名單；舊部署／未經正常 build 就冇呢個檔（回傳空物件） */
async function fetchBakedUnits() {
  const fail = () => {
    bakedStatus = { ok: false, count: 0, generatedAt: '', vercelEnv: '', at: new Date().toISOString() };
    return {};
  };
  try {
    const r = await fetch(GEN_URL + '?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fail();
    const j = await r.json();
    const units = (j && j.units && typeof j.units === 'object') ? j.units : {};
    bakedStatus = {
      ok: true, count: Object.keys(units).length,
      generatedAt: String(j?.generatedAt || ''), vercelEnv: String(j?.vercelEnv || ''),
      at: new Date().toISOString()
    };
    return units;
  } catch (e) { return fail(); }
}

/** 由 /api/units 攞伺服器端（環境變數）定義嘅旅團；靜態部署／未設定就回傳空物件 */
async function fetchServerUnits() {
  const url = API_UNITS_URL + '?_=' + Date.now();
  let lastErr = '';
  let lastCode = 0;
  for (let attempt = 0; attempt < 2; attempt++) {          // 一次重試：redeploy 中／冷啟動
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const units = (j && j.units && typeof j.units === 'object') ? j.units : {};
        serverStatus = { ok: true, status: r.status, count: Object.keys(units).length, error: '', at: new Date().toISOString() };
        return units;
      }
      lastErr = `HTTP ${r.status}`; lastCode = r.status;
      /* 404／405 ＝ 呢個部署根本冇呢個 API（純靜態網頁），重試都冇用 */
      if (r.status === 404 || r.status === 405 || r.status === 501) break;
    } catch (e) {
      lastErr = e?.message || String(e); lastCode = 0;
    }
    if (attempt === 0) await sleep(200);
  }
  /* 記住係「讀唔到」，畀旅團閘顯示（連 HTTP code）—— 好過靜靜雞當冇旅團 */
  serverStatus = { ok: false, status: lastCode, count: 0, error: lastErr, at: new Date().toISOString() };
  return {};
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 伺服器端 Registry 診斷（只喺旅團閘撳「診斷」時叫）。
 * 回傳嘅係**變數名同布林值**，永遠唔會回傳 API Key／完整 /exec 網址。
 */
export async function fetchRegistryDiag() {
  try {
    const r = await fetch(API_DIAG_URL + '&_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, status: r.status };
    const j = await r.json();
    /* /api/units?diag=1 回 { units, diag }；唔支援 diag 嘅舊部署只回 { units } */
    if (!j || !j.diag) {
      return { ok: false, server: true, error: '呢個部署嘅 /api/units 未支援診斷（請重新部署最新版本）', count: Object.keys(j?.units || {}).length };
    }
    return { ok: true, ...j.diag };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function loadRegistry(force = false) {
  if (cache && !force) return cache;

  /* 上次記住嘅清單 —— 下面讀失敗嗰陣嘅救生艇。
     （2026-09-17 0082 事件：data/units.json 本身係空但讀得到，
       /api/units 一時 404 → 合併結果係空 → 好好地記住咗嘅 0082
       就咁被洗走，成個閘變空。所以讀唔齊嗰陣唔可以用空殼覆蓋。） */
  const prevUnits = (() => {
    try {
      if (cache && cache.units && Object.keys(cache.units).length) return { ...cache.units };
      const raw = localStorage.getItem(REG_CACHE);
      const j = raw ? JSON.parse(raw) : null;
      if (j && j.units && Object.keys(j.units).length) return { ...j.units };
    } catch { /* ignore */ }
    return {};
  })();

  /* 部署時焗好嘅名單（靜態檔，行先 —— 同一次部署嘅環境，同 /api 睇到嘅一樣） */
  const fromBaked = await fetchBakedUnits();
  if (Object.keys(fromBaked).length) regReachable = true;

  let fromFile = null;
  let fileFailed = false;
  try {
    const r = await fetch(REG_URL + '?_=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      fromFile = await r.json();
      regReachable = true;
      const n = (fromFile && fromFile.units && typeof fromFile.units === 'object')
        ? Object.keys(fromFile.units).length : 0;
      fileStatus = { ok: true, count: n, error: '', at: new Date().toISOString() };
    } else {
      fileFailed = true;
      fileStatus = { ok: false, count: 0, error: `HTTP ${r.status}`, at: new Date().toISOString() };
    }
  } catch (e) {
    fileFailed = true; /* 可能係 file:// 或者未部署 */
    fileStatus = { ok: false, count: 0, error: e?.message || String(e), at: new Date().toISOString() };
  }

  /* 伺服器 Registry：Vercel 環境變數定義嘅旅團（冇 /api 就自動略過） */
  const fromApi = await fetchServerUnits();
  if (Object.keys(fromApi).length) regReachable = true;

  /* 今次新讀到嘅（未寫入住 —— 要經過下面嘅「讀唔齊」檢查先作準） */
  let fresh = null;
  if (fromFile && fromFile.units) {
    fresh = { ...fromFile, units: {} };
    Object.entries(fromFile.units).forEach(([code, u]) => {
      /* 記住呢個旅團嚟自檔案（閘面會標「檔案」，同 Vercel 路分開睇） */
      fresh.units[code] = { ...(u || {}), fromFile: true };
    });
    Object.entries(fromBaked).forEach(([code, u]) => {
      fresh.units[code] = { ...(fresh.units[code] || {}), ...u, baked: true, server: true };
    });
    Object.entries(fromApi).forEach(([code, u]) => {
      fresh.units[code] = { ...(fresh.units[code] || {}), ...u, fromApi: true, server: true };
    });
  } else if (Object.keys(fromApi).length || Object.keys(fromBaked).length) {
    /* 讀唔到 data/units.json（例如 Vercel 唔會 bundle 呢個檔）但伺服器 Registry 有嘢
       → 直接用伺服器嗰份，唔好白白當冇旅團 */
    fresh = { schema: 2, defaultUnit: '', units: {} };
    Object.entries(fromBaked).forEach(([code, u]) => {
      fresh.units[code] = { ...u, baked: true, server: true };
    });
    Object.entries(fromApi).forEach(([code, u]) => {
      fresh.units[code] = { ...(fresh.units[code] || {}), ...u, fromApi: true, server: true };
    });
    regReachable = true;
  }

  /* 讀唔齊（/api 或者檔案其中一邊失敗），但上次記住嘅仲有嘢：
     用「新讀到嘅為主、上次記住嘅補返」合併，唔好用個唔齊嘅結果
     洗走記住咗嘅旅團。注意：真係「一個都未登記」嗰陣 serverStatus.ok
     係 true、fileFailed 係 false，唔會入呢度 —— 管理員啱啱取消登記嘅
     旅團仍然會即刻消失，唔會陰魂不散。 */
  /* 2026-09-18：焗好嘅名單都係第一手（同一次部署嘅環境），佢有貨就唔當「讀唔齊」。
     （舊部署冇焗名單檔 → bakedStatus.ok 係 false → 同以前一模一樣。） */
  const fetchFailed = fileFailed || (!serverStatus.ok && !bakedStatus.ok);
  if (fetchFailed && Object.keys(prevUnits).length) {
    const base = fresh
      ? { ...fresh, units: { ...fresh.units } }
      : { schema: 2, defaultUnit: '', units: {} };
    let filled = 0;
    for (const [code, u] of Object.entries(prevUnits)) {
      if (!base.units[code]) { base.units[code] = { ...u }; filled++; }
    }
    if (filled > 0 || !fresh) {
      base._stale = true;
      staleCache = true;
      cache = base;
      regReachable = true;   // 有份可用嘅（舊）清單 —— 照計係「讀到」
      return cache;          // 唔覆蓋 localStorage —— 留返上次好嘅嗰份喺度
    }
  }

  staleCache = false;
  if (fresh) {
    cache = fresh;
    try { localStorage.setItem(REG_CACHE, JSON.stringify(fresh)); } catch { /* ignore */ }
  } else {
    registry(); // 用快取或內建
  }
  return cache;
}

export function localUnits() { return readLocal(); }

/** 全部旅團（正式 + 本地） */
export function allUnits() {
  const reg = registry();
  const out = { ...(reg.units || {}) };
  Object.entries(readLocal()).forEach(([code, u]) => { out[code] = { ...u, local: true }; });
  return out;
}

export function unitList() {
  const all = allUnits();
  return Object.values(all).sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

/* ★ 旅團編號寫法統一（2026-09-21）：82／082／0082 一律當同一個旅團。
   團長喺旅團選擇閘打「82」（第八十二旅，個 logo 都係顯示 82）係最自然嘅做法，
   但 Registry 嘅 key 係「0082」。以前呢度同 api/_registry.js 一樣，淨係試
   『原樣』同『搣走前導零』兩種寫法，永遠砌唔出「0082」→ 代理回 404 →
   前端對用家講「未能連接旅團後端」＝「無後端」。讀寫兩邊一齊死。 */
function matchUnitKey(code, all) {
  const raw = String(code == null ? '' : code).trim();
  if (!raw) return '';
  if (all[raw]) return raw;
  const bare = raw.replace(/^0+/, '');
  if (!bare || !/^\d+$/.test(bare)) return '';
  return Object.keys(all).find(k => /^\d+$/.test(k) && k.replace(/^0+/, '') === bare) || '';
}

/** 任意寫法 → Registry 登記咗嗰個 key；搵唔到回 '' */
export function canonicalUnitKey(code) { return matchUnitKey(code, allUnits()); }

/** 任意寫法 → 登記咗嘅旅團編號（例如 82 → 0082）；Registry 冇呢個旅團就原樣回 */
export function canonicalUnitCode(code) {
  const all = allUnits();
  const key = matchUnitKey(code, all);
  return key ? String(all[key].code || key) : String(code == null ? '' : code).trim();
}

export function unitEntry(code) {
  const all = allUnits();
  const key = matchUnitKey(code, all);
  return key ? all[key] : null;
}

/**
 * 旅團嘅後端設定（Apps Script /exec）。
 *
 * 【嚴格隔離】每個旅團**只可以**用自己 entry 入面登記嘅後端。
 * 以前呢度會 fallback 去 registry 頂層嘅共用 `backend`，
 * 後果係：新開嘅旅團一登入就會讀／寫**第八十二旅嘅 Google Sheet**
 * （即係見到人哋嘅團員、帳目，自己嘅資料又寫咗入人哋張表）。
 * 所以任何情況都唔再借用共用後端 —— 冇自己嘅 /exec 就當未開戶（回 null）。
 */
export function backendOf(code) {
  const entry = unitEntry(code) || {};
  /* 安全：唔喺 Registry 嘅旅團（連本地都唔係）＝未開戶 */
  if (!Object.keys(entry).length) return null;
  const val = entry.backend || {};
  const gasUrl = val.gasUrl || '';
  if (!gasUrl) return null;          // ← 冇自己嘅後端就係冇，唔會借用其他旅團嘅
  return {
    name: val.name || '總表（Apps Script）',
    gasUrl,
    apiKey: val.apiKey !== undefined ? val.apiKey : '',
    shared: false,                   // 永遠唔會再共用
    noticeSubmitUrl: entry.notice?.submitUrl || val.noticeSubmitUrl || gasUrl,
    updated: val.updated || ''
  };
}

export function defaultUnitCode() {
  const reg = registry();
  const units = allUnits();
  /* 冇旅團就回空字串 —— 唔好 fallback 落任何真實旅團編號。
     以前呢度寫死 '0082'，即係 Registry 一有冷場就會靜靜雞當你係 82 旅。 */
  return reg.defaultUnit && units[reg.defaultUnit] ? reg.defaultUnit : (Object.keys(units)[0] || '');
}

export function dataPathOf(code) {
  const u = unitEntry(code);
  if (u?.dataPath) return u.dataPath;
  if (u?.local) return null;                    // 本地旅團冇資料檔案
  if (u?.fromApi || u?.baked) return null;                  // 伺服器旅團：由空白資料庫開始（資料喺自己後端）
  return `data/units/${code}/`;
}

export function saveLocalUnit(unit) {
  const all = readLocal();
  all[unit.code] = { ...(all[unit.code] || {}), ...unit, local: true };
  writeLocal(all);
  return all[unit.code];
}

export function removeLocalUnit(code) {
  const all = readLocal();
  delete all[code];
  writeLocal(all);
}

export function isLocalUnit(code) { return !!readLocal()[code]; }

export async function fetchUnitData(code, file) {
  const base = dataPathOf(code);
  if (!base) return null;
  try {
    const r = await fetch(`${base}${file}?_=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
