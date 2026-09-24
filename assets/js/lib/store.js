/* ============================================================
   store.js — 資料層（多旅團）

   ★ 2026-09-25 團長：「刪除示範資料 (MOCK) 我都在用要MOCK 幹什麼」
     → 示範模式成個拆走：冇再分「真實／示範」兩個命名空間，
       只有一個旅團資料庫。唔會有「改咗示範資料」呢回事。

   命名空間（key）：
     旅團資料庫   venture82.unit.<旅團編號>.db.v2
     旅團清單     venture82.units.cache.v2 / venture82.units.local.v2
     登入狀態     venture82.session.v2

   資料由 data/units/<編號>/*.json 首次載入時種入本機，
   之後所有改動都寫入上面嘅 key，唔會再寫返 data/ 檔案。
   ============================================================ */

import { todayISO, nowStamp } from './dates.js';
import { canonicalUnitCode } from './units.js';
import {
  registry, unitEntry, backendOf, dataPathOf, fetchUnitData, defaultUnitCode, localUnits
} from './units.js';
import { scoutFYLabel } from './fiscal.js';
import {
  SKIP_TOP, diffDb as _diffDb, applyChanges as _applyChanges, clone as _clone,
  threeWay as _threeWay, overridesFor as _overridesFor
} from './merge3.js';

export const SCHEMA = 2;

const K = {
  session: 'venture82.session.v2',
  unit: 'venture82.currentUnit.v2',
  /* 最後一個**真實**旅團 —— 「離開示範」之後可以一撳就返去自己旅團，
     唔使喺清單再揀一次。示範模式永遠唔會寫呢個 key。 */
  lastReal: 'venture82.lastRealUnit.v2'
};
export const dbKey = (code) => `venture82.unit.${code}.db.v${SCHEMA}`;

/* ---------------- 帳戶名單（**已取消共用帳戶**） ----------------
   ★ 2026-09-24 團長定案：「唔好再設執行委員會帳號／領袖共用帳戶」。
     全系統行「**身份即帳號**」：每一個人（團長／領袖／執委／團員）都係
     名冊（members）入面嘅一條紀錄，密碼擺喺佢自己身上（hubPw），
     登入代號＝ email → loginId → ymis（見 model.js loginIdOf()）。
     db.accounts 淨係留返舊資料庫已經開咗嘅**個人**帳戶（向下兼容），
     唔會再自動生成任何共用帳戶。

   舊版本喺每個新資料庫塞兩個共用帳戶：
     acc_leader（leader／密碼 8202）、acc_exco（exco／密碼 8203）
   —— 呢兩個一定唔可以留：多人共用一個帳號＝冇人知邊個做過乜，
   而且「改身份」呢個設計根本冇位放佢哋。下面 migrateSharedAccounts()
   會喺開機／由後端載入嗰陣清走佢哋（只認種子紀錄，唔會誤刪真人帳戶）。 */
export const LEGACY_SHARED_ACCOUNTS = ['acc_leader', 'acc_exco'];
export const LEGACY_SHARED_USERNAMES = ['leader', 'exco'];

/** 清走舊版種落嘅共用帳戶（領袖／執行委員會）。@returns {boolean} 有冇改動 */
export function migrateSharedAccounts(db) {
  if (!db || !Array.isArray(db.accounts) || !db.accounts.length) return false;
  const before = db.accounts.length;
  db.accounts = db.accounts.filter(a => {
    if (!a) return false;
    if (LEGACY_SHARED_ACCOUNTS.includes(a.id)) return false;
    /* 只有「冇綁名冊紀錄」＋「帳號名就係 leader／exco」＋「種子標記」先當共用帳戶，
       真人自己開嘅個人帳戶（有 memberId／有電郵）一律保留。 */
    const un = String(a.username || '').toLowerCase();
    const shared = !a.memberId && LEGACY_SHARED_USERNAMES.includes(un) &&
      (a.seeded === true || !String(a.email || '').trim());
    return !shared;
  });
  return db.accounts.length !== before;
}

/* ---------------- 狀態 ---------------- */
const state = {
  unitCode: null,
  db: null,
  seedSource: '',
  seedFailed: false,
  ready: false
};
let memoryStore = {};   // localStorage 不可用時嘅後備

/* ---------------- storage 包裝 ---------------- */
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return memoryStore[key] ?? null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch { memoryStore[key] = val; }
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch { delete memoryStore[key]; }
}

/* ---------------- 升級：用戶身份（領袖 / 執委 / 團員） ----------------
   舊資料庫嘅團員紀錄冇 identity 欄。呢度由職位／標籤推算一次，
   之後喺「用戶」頁可以隨時改。回傳 true = 有改動（要 persist）。 */
const IDENTITY_KEYS = ['chief', 'leader', 'exco', 'member'];
export function migrateIdentities(db) {
  if (!db || !Array.isArray(db.members)) return false;
  let changed = false;
  db.members.forEach(m => {
    if (IDENTITY_KEYS.includes(m.identity)) return;
    const t = `${m.role || ''} ${(m.tags || []).join(' ')}`.toLowerCase();
    m.identity = /(團長|領袖|leader|scouter)/.test(t) ? 'leader'
      : /(執委|執行委員會|exco|committee|主席|司庫|文書)/.test(t) ? 'exco'
        : 'member';
    changed = true;
  });
  return changed;
}

/**
 * 期初結餘遷移：舊版本得一個**全域** settings.openingBalance，
 * 但期初結餘其實係**逐年**嘅 —— 8,803.28 係 2025-26 嘅期初，
 * 唔係 2026-27 嘅期初（2026-27 嘅期初應該係 2025-26 嘅期末 7,846.64）。
 *
 * 如果舊嘅全域數字啱好等於舊帳參考嘅「上年度結餘」，即係用錯咗年度，
 * 呢度會搬返佢去對應年度，並把期末結轉去下一個年度。
 * @returns {boolean} 有冇改動
 */
export function migrateOpeningBalances(db) {
  if (!db || !db.settings) return false;
  const s = db.settings;
  const legacy = Number(s.openingBalance || 0);
  if (!legacy) return false;
  if (s.openingBalances && Object.keys(s.openingBalances).length) return false;  // 已經逐年設定過
  const ref = db.reference || {};
  const refOpen = Number(ref.openingBalance || 0);
  if (!refOpen || Math.abs(refOpen - legacy) > 0.005) return false;               // 唔係同一個數 → 唔亂搬
  const dates = (ref.transactions || []).map(t => String(t.date || '').slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return false;
  const startMonth = Number(s.scoutFYStartMonth || 4);
  const year = scoutFYLabel(dates[dates.length - 1], startMonth);                 // 由帳目日期推年度
  const y = Number(year.split('-')[0]) + 1;
  const nextYear = `${y}-${String(y + 1).slice(-2)}`;
  const inc = (ref.transactions || []).filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount || 0), 0);
  const exp = (ref.transactions || []).filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount || 0), 0);
  const closing = Math.round((ref.check?.closing ?? (refOpen + inc - exp)) * 100) / 100;
  s.openingBalances = { [year]: refOpen, [nextYear]: closing };
  s.openingBalance = 0;                                                            // 全域欄位還原做「第一筆帳目之前嘅底數」
  s.openingMigratedFrom = { at: nowStamp(), year, nextYear, amount: refOpen, closing };
  return true;
}

/* ---------------- 跨系統身份（federation L1） ----------------
   進度資料喺旅團自己嘅後端（一個後端、兩個前端）。要對得上同一個人，就要一個共同 key：
     ymis      會籍編號／YMIS —— **權威** key（人手填，同對面系統一樣）
     systemId  本系統派嘅穩定 ID —— 冇 YMIS 時嘅 fallback（一旦產生就唔會再改）
   冇呢兩個 key，任何同步都只可以靠姓名配對（會撞名、會漏）。 */

/**
 * 產生穩定嘅系統 ID。
 * **必須係確定性嘅** —— 如果用隨機值，每部裝置都會產生唔同嘅 ID，
 * 咁呢個 key 就永遠對唔上，做唔到跨系統配對。所以用「旅團編號-用戶 id」推斷；
 * 兩樣都冇先至退返去隨機（只適用於即時新增、仲未同步嘅紀錄）。
 */
export function newSystemId(unitCode = state.unitCode, memberId = '') {
  if (unitCode && memberId) return `${unitCode}-${memberId}`;
  const c = globalThis.crypto;
  if (c?.randomUUID) return String(c.randomUUID());
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${Date.now().toString(16)}-${r()}-${r()}-${r()}`;
}

/**
 * 為所有用戶補上 systemId / ymis（已有就唔會改）。
 * @returns {boolean} 有冇改動
 */
export function migrateMemberKeys(db) {
  if (!db || !Array.isArray(db.members)) return false;
  let changed = false;
  db.members.forEach(m => {
    if (!m.systemId) { m.systemId = newSystemId(db.unitCode, m.id); changed = true; }
    if (m.ymis === undefined) { m.ymis = ''; changed = true; }
  });
  return changed;
}

/* ---------------- 種子資料 ---------------- */
function blankDb(code, entry = {}) {
  return {
    schema: SCHEMA,
    kind: 'real',
    unitCode: code,
    unit: { code, name: entry.name || code, nameEn: entry.nameEn || '', short: entry.short || code, theme: entry.theme || {} },
    settings: {
      currency: 'HK$', feePerYear: 360, feePeriodLabel: '', subsidyPercent: 30, subsidyCap: 70,
      openingBalance: 0, openingBalanceDate: todayISO().slice(0, 4) + '-04-01',
      scoutFYStartMonth: 4, scoutFYStartDay: 1,
      agmDates: [{ year: new Date().getFullYear(), date: '', note: '未設定' }],
      publicBaseUrl: ''
    },
    accounts: [],                       // 冇共用帳戶：身份即帳號（見上面 migrateSharedAccounts）
    constitution: { version: '0.1', status: 'draft', title: { zh: '團章', en: 'Constitution' }, preamble: { zh: '', en: '' }, chapters: [], appendices: [], history: [] },
    members: [], meetings: [], notices: [], events: [], quizzes: [],
    tableSchema: {}, tableSources: [], sync: null, backend: null,
    transactions: [], claims: [], fees: [], budgets: [],
    categories: {
      income: ['團費', '活動費', '資助', '捐款', '售賣物品', '利息', '其他收入'],
      expense: ['場地', '活動', '物資', '文書', '交通', '膳食', '訓練', '服務', '雜項']
    },
    methods: ['現金', '轉數快 FPS', '銀行轉賬', '自動扣賬', '支票', 'PayMe', '其他'],
    invItems: [], invLoans: [], invAudits: [], invNextCode: 'G-001',
    auditLog: [],
    meta: { createdAt: nowStamp(), updatedAt: nowStamp(), seedSource: entry.local ? '（本地旅團：空白資料）' : (entry.fromApi ? '（伺服器 Registry：由空白資料庫開始）' : (dataPathOf(code) || '')), real: true }
  };
}

async function buildSeed(code) {
  const entry = unitEntry(code) || {};
  const db = blankDb(code, entry);
  const pick = (f) => fetchUnitData(code, f);

  const [unit, cons, members, finance, inventory, meetings, finRef, notices, tables] = await Promise.all([
    pick('unit.json'), pick('constitution.json'), pick('members.json'),
    pick('finance.json'), pick('inventory.json'), pick('meetings.json'),
    pick('finance.reference.json'), pick('notices.json'), pick('tables.json')
  ]);
  const got = [unit, cons, members, finance, inventory, meetings, finRef, notices, tables].filter(Boolean).length;
  if (!got) {
    /* 伺服器旅團（純環境變數開）本身冇靜態資料檔 —— 由空白資料庫開始，唔算失敗 */
    if (entry.fromApi) { db.meta.seedSource = '（伺服器 Registry：由空白資料庫開始）'; return db; }
    db.meta.seedFailed = true; return db;
  }

  if (unit) {
    db.unit = { ...db.unit, ...unit };
    if (unit.settings) db.settings = { ...db.settings, ...unit.settings };
    db.profile = { ...(unit || {}) };
  } else { db.profile = db.unit; }
  if (cons && Array.isArray(cons.chapters)) db.constitution = cons;
  if (members && Array.isArray(members.members)) db.members = members.members;
  if (finance) {
    db.transactions = finance.transactions || [];
    db.claims = finance.claims || [];
    db.fees = finance.fees || [];
    db.budgets = finance.budgets || [];
    if (finance.categories) db.categories = finance.categories;
    if (finance.methods) db.methods = finance.methods;
  }
  /* 參考資料（舊帳）只放入 db.reference，永遠唔會自動寫入 db.transactions */
  const refSrc = (finRef && Array.isArray(finRef.transactions)) ? finRef
               : (finance && finance.reference ? finance : null);
  if (refSrc) {
    db.reference = {
      openingBalance: Number(refSrc.openingBalance || finance?.openingBalance || 0),
      source: refSrc.source || finance?.source || '',
      sheetLabel: refSrc.sheetLabel || '',
      columns: refSrc.sheetColumns || '',
      check: refSrc.check || null,
      feeRecords: refSrc.feeRecords || [],
      note: refSrc.noteBalance || refSrc._comment || '',
      transactions: refSrc.transactions || []
    };
  }
  if (inventory) {
    db.invItems = inventory.items || [];
    db.invLoans = inventory.loans || [];
    db.invAudits = inventory.audits || [];
    db.invNextCode = inventory.nextCode || 'G-001';
  }
  if (meetings && Array.isArray(meetings.meetings)) db.meetings = meetings.meetings;
  if (notices && Array.isArray(notices.notices)) db.notices = notices.notices;
  if (tables) {
    if (tables.schemaDefs) db.tableSchema = tables.schemaDefs;
    if (tables.sources) db.tableSources = tables.sources;
    if (tables.sync) db.sync = tables.sync;
  }
  seedBackend(db, code);
  return db;
}

/* ---------------- 後端（Apps Script 總表）：所有流出資料都用同一條 /exec ----------------
   優先次序：unit.json settings.sync / tables.json → 旅團 registry backend → Registry 共用 backend */
function seedBackend(db, code) {
  const be = backendOf(code);
  const s = db.settings || {};
  const unitSync = s.sync || {};
  const url = unitSync.url || be?.gasUrl || '';
  if (!url) return;
  db.backend = {
    gasUrl: url,
    apiKey: unitSync.apiKey !== undefined ? unitSync.apiKey : (be?.apiKey || ''),
    name: be?.name || '總表（Apps Script）',
    shared: !unitSync.url,
    noticeSubmitUrl: s.notice?.submitUrl || be?.noticeSubmitUrl || url,
    updated: be?.updated || ''
  };
  db.sync = { ...(db.sync || {}), url: db.sync?.url || url, unit: db.sync?.unit || unitSync.unit || code, apiKey: db.sync?.apiKey ?? (unitSync.apiKey ?? ''), log: db.sync?.log || [] };
  db.settings = { ...s };
  db.settings.notice = { ...(s.notice || {}), submitUrl: s.notice?.submitUrl || url };
  db.settings.publicEntry = { ...(s.publicEntry || {}), submitUrl: s.publicEntry?.submitUrl || url };
  db.settings.publicBorrow = { ...(s.publicBorrow || {}), submitUrl: s.publicBorrow?.submitUrl || url };
}

/* ---------------- 初始化 ---------------- */
/** 由網址／記錄決定「而家係邊個旅團」。
 *
 * 優先次序（網址永遠最權威）：
 *   1. init({ unit }) —— 程式內部指定（測試、公開頁）
 *   2. ?u=<旅團編號>
 *   3. localStorage 記錄
 *   4. Registry 預設旅團
 *
 * ★ 2026-09-25：以前呢度仲有「真實／示範（MOCK）」兩個模式，團長話
 *   「我都在用要MOCK 幹什麼」→ 拆走。而家只有一個旅團資料庫，
 *   唔會再出現「入錯示範空間、資料冇同步」呢類 bug。 */
function resolveTarget(opts = {}, url = new URLSearchParams(location.search)) {
  const urlUnitRaw = String(url.get('u') || '').trim();
  let code;
  if (opts.unit) code = String(opts.unit);
  else code = urlUnitRaw || lsGet(K.unit) || defaultUnitCode();
  if (code) lsSet(K.lastReal, code);
  return { code };
}

export async function init(opts = {}) {
  const { code } = resolveTarget(opts);
  state.unitCode = code;

  const key = dbKey(code);
  const raw = lsGet(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === SCHEMA) {
        state.db = parsed;
        state.seedSource = parsed.meta?.seedSource || '';
      }
    } catch (e) { console.warn('DB 解析失敗，重新種入種子資料', e); }
  }
  if (!state.db) {
    state.db = await buildSeed(code);
    state.seedFailed = !!state.db.meta?.seedFailed;
    state.seedSource = state.db.meta?.seedSource || '';
    persistLocalOnly();
  }
  /* 開機升級（帳戶名單／身份／systemId／期初結餘／後端設定）全部只寫本機 ——
     佢哋唔係用家嘅改動，唔應該令 pending 由 0 變 1（否則一開機就話「未儲存」）。 */
  if (!Array.isArray(state.db.accounts)) { state.db.accounts = []; persistLocalOnly(); }
  /* 清走舊版嘅共用帳戶（領袖／執行委員會）—— 2026-09-24「身份即帳號」 */
  if (migrateSharedAccounts(state.db)) persistLocalOnly();
  // 用戶名冊升級：舊資料冇「身份」欄 → 由職位／標籤推算（領袖 / 執委 / 團員）
  if (migrateIdentities(state.db)) persistLocalOnly();
  // 跨系統身份 key（進度追蹤等外部系統要靠呢個對人）
  if (migrateMemberKeys(state.db)) persistLocalOnly();
  // 期初結餘：舊嘅全域數字如果係上年度嘅期初，自動搬返去對應年度（見 migrateOpeningBalances）
  if (migrateOpeningBalances(state.db)) persistLocalOnly();
  // 後端設定升級：舊資料庫（未有 sync 設定）自動補上 Registry / unit.json 嘅 Apps Script 網址
  {
    const before = JSON.stringify([state.db.sync?.url || '', state.db.settings?.notice?.submitUrl || '', state.db.settings?.publicEntry?.submitUrl || '', state.db.settings?.publicBorrow?.submitUrl || '']);
    if (state.db.sync?.url !== undefined || !state.db.backend) seedBackend(state.db, code);
    const after = JSON.stringify([state.db.sync?.url || '', state.db.settings?.notice?.submitUrl || '', state.db.settings?.publicEntry?.submitUrl || '', state.db.settings?.publicBorrow?.submitUrl || '']);
    if (before !== after) persistLocalOnly();
  }
  lsSet(K.unit, code);
  /* 舊版（2026-09-19 之前）留低嘅指紋基準已經冇用 —— 而家用成份基準快照（getBase） */
  if (state.db.sync?.baseObjHash) { delete state.db.sync.baseObjHash; persistLocalOnly(); }
  /* ★ 2026-09-24 同一個瀏覽器另一個分頁改咗嘢 → 併入本機（唔使重新整理）。
     綁喺 init() 呢度：所有入口（主控頁／團員入口／公開頁）都自動有呢個行為。
     介面想知道就聽 window 嘅 `v82:external` event。 */
  bindCrossTabSync();
  state.ready = true;
  return state.db;
}

export function ready() { return state.ready; }
export function currentUnit() { return state.unitCode; }
export function unitProfile() { return load().profile || load().unit; }
export function seedInfo() { return { source: state.seedSource || load()?.meta?.seedSource || '', failed: state.seedFailed, real: true }; }

/* ★ 旅團編號一律用 Registry 登記咗嗰個（82 → 0082）。
   團長喺閘度打「82」係最自然嘅做法，但 db.unitCode 一旦係「82」，
   寫落 Google Sheet 嘅旅團欄、讀返嘅 filter、報表分頁就會同「0082」對唔上
   —— 同一張表出現兩套資料庫，症狀就係「寫咗但讀唔到」。 */
export function setUnitCode(code) { lsSet(K.unit, canonicalUnitCode(code) || code); }

/** 切換旅團（重載頁面，確保所有模組用新資料） */
export function switchUnit(code) {
  lsSet(K.unit, canonicalUnitCode(code) || code);
  const u = new URL(location.href);
  u.searchParams.set('u', code);
  u.hash = '#/dashboard';
  location.href = u.toString();
}
/* 「已揀咗旅團」記錄（main.js 嘅旅團選擇閘共用同一個 key）。
   離開示範／重置選擇時要一齊清，否則下一次開機會由呢度直接跳返入去。 */
export const CHOSEN_UNIT_KEY = 'venture82.unitChosen.v2';

/** 最後一個用過嘅真實旅團（示範模式唔會覆蓋佢） */
export function lastRealUnit() {
  return lsGet(K.lastReal) || '';
}

/** 清晒「已揀旅團」嘅痕跡，重載返去旅團選擇閘（登出一併做）。 */
export function resetToGate() {
  lsDel(K.unit);
  lsDel(CHOSEN_UNIT_KEY);
  try { setSession(null); } catch { /* 未初始化都冇問題 */ }
  const u = new URL(location.href);
  u.searchParams.delete('u');
  u.hash = '';
  location.href = u.toString();
}

/* ---------------- 讀寫 ---------------- */
export function load() {
  if (!state.db) throw new Error('資料庫未初始化（要先 await init()）');
  return state.db;
}
export function tryLoad() { return state.db; }

/* 後端自動儲存 hook（由 remote.js 喺開機時掛上；避免 store ↔ remote 循環 import）。
   冇掛住（例如測試、公開頁）就淨係寫本機，行為同以前一樣。

   ★ 2026-09-24（團長：「用戶根本沒寫入後端」）：hook 而家會收到
      { critical, reason } —— critical＝呢次改動係「另一部機要即刻見到」嘅嘢
      （開人／設密碼／改身份／批開戶），remote.js 會即刻寫後端，唔等 debounce。 */
let saveHook = null;
export function setSaveHook(fn) { saveHook = typeof fn === 'function' ? fn : null; }

function persist({ remote = true, critical = false, reason = '' } = {}) {
  if (!state.db) return;
  state.db.meta = state.db.meta || {};
  state.db.meta.updatedAt = nowStamp();
  /* pending ＝「仲未寫入後端嘅改動次數」（介面提示用；真正要寫乜係 diff(基準, 本機)）。
     要**先**加、**後**寫 localStorage —— 以前掉轉次序，localStorage 入面嘅 pending
     永遠差一次，閂咗視窗再開就以為冇嘢未存。示範模式永遠唔計。 */
  const bump = !!remote;
  if (bump) {
    state.db.sync = state.db.sync || {};
    state.db.sync.pending = Number(state.db.sync.pending || 0) + 1;
    /* ★ 帳戶級改動另外計數：呢啲未寫入後端之前，另一部機用嗰個 email／YMIS 登唔到
       （登入核對讀嘅係後端嗰份名冊）。頂部會明確講出嚟，登出／閂頁會擋住問。 */
    if (critical) state.db.sync.pendingAccounts = Number(state.db.sync.pendingAccounts || 0) + 1;
  }
  lsSet(dbKey(state.unitCode), JSON.stringify(state.db));
  /* 本機寫完 → 通知介面／後端儲存排程 */
  if (bump && saveHook) {
    try { saveHook({ critical: !!critical, reason: String(reason || '') }); }
    catch (e) { console.warn('[store] 儲存狀態通知失敗', e); }
  }
}

/** 只寫本機，唔會觸發後端儲存（由後端拉落嚟嘅資料用，免得again寫返上去） */
function persistLocalOnly() { persist({ remote: false }); }

export function commit() { persist(); return state.db; }
export const save = commit;

/**
 * ★ 帳戶級寫入（2026-09-24）。
 *
 * 「身份即帳號」之後，**名冊紀錄本身就係登入帳戶**：開人、設密碼、改身份、
 * 批開戶 —— 呢啲改動如果淨係留喺本機瀏覽器，另一部機（甚至同一個瀏覽器
 * 另一個分頁）就用嗰個 email 登唔到。團長 2026-09-24 原話：
 *   「1 邊能用 email 登入、1 邊不能，那＝用戶根本沒寫入後端。」
 *
 * 所以呢啲改動寫完本機之後，會叫 remote.js **即刻**寫後端（唔等 debounce）。
 * 寫唔成功唔會靜靜地吞：頂部狀態會轉做「未儲存」，改動仍然留喺本機。
 */
export function commitCritical(reason = '') { persist({ critical: true, reason }); return state.db; }

/**
 * 淨係寫低「同步簿記」（pending／lastPushAt／log）——
 * **唔會**動 meta.updatedAt、**唔會**加 pending、**唔會**再觸發後端儲存。
 * 如果用普通 commit() 去記錄「已儲存」，就會即刻又標記成「有改動要儲存」，
 * 變成無限迴圈（存完又存）。所以簿記一定要行呢條路。
 */
export function commitMeta() {
  if (!state.db) return state.db;
  lsSet(dbKey(state.unitCode), JSON.stringify(state.db));
  return state.db;
}

export function collection(name) {
  const db = load();
  if (!Array.isArray(db[name])) db[name] = [];
  return db[name];
}
export function find(name, id) { return collection(name).find(x => x.id === id) || null; }

/* ★ 2026-09-24：呢三個 collection 就係「登入帳戶」本身（身份即帳號）。
   任何改動都當**帳戶級**處理 —— 即刻寫後端，唔好困喺呢部機嘅瀏覽器。
   以前淨係 pending +1，結果：團長開完人、設完密碼，另一部機／另一個分頁
   用嗰個 email 登唔到（後端嗰份名冊根本冇呢個人）。 */
export const IDENTITY_COLLECTIONS = new Set(['members', 'accounts', 'accountApps']);
function criticalFor(name, opts) { return !!opts?.critical || IDENTITY_COLLECTIONS.has(String(name || '')); }

export function add(name, obj, opts) {
  const id = obj.id || (name.slice(0, 2) + '_' + Math.random().toString(36).slice(2, 8));
  const rec = { ...obj, id };
  collection(name).push(rec);
  persist({ critical: criticalFor(name, opts), reason: `add:${name}` });
  return rec;
}
export function update(name, id, patch, opts) {
  const rec = find(name, id);
  if (!rec) return null;
  Object.assign(rec, patch, { id });
  persist({ critical: criticalFor(name, opts), reason: `update:${name}` });
  return rec;
}
export function remove(name, id, opts) {
  const list = collection(name);
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  persist({ critical: criticalFor(name, opts), reason: `remove:${name}` });
  return true;
}
export function setSetting(patch) {
  const db = load();
  db.settings = { ...db.settings, ...patch };
  persist();
  return db.settings;
}
export function setUnitProfile(patch) {
  const db = load();
  db.unit = { ...db.unit, ...patch };
  persist();
  return db.unit;
}

/* ---------------- 稽核紀錄 ---------------- */
export function audit(action, detail = '', who = null) {
  const db = load();
  db.auditLog = db.auditLog || [];
  /* ★ 2026-09-25 團長：「操作紀錄不顯示超級管理員的紀錄」。
     要濾得到就要記低操作者身份 —— 由 session 攞（audit() 唔可以 import auth.js，會循環）。 */
  const sess = getSession();
  db.auditLog.unshift({
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    at: nowStamp(), action, detail, by: who || '',
    role: sess?.role || ''
  });
  if (db.auditLog.length > 400) db.auditLog.length = 400;
  /* 操作紀錄係簿記：只寫本機、唔計入「未儲存改動」（否則一登入就話有嘢未存）。
     佢會跟下一次真正嘅儲存一齊上後端（三方合併：紀錄係併集，永遠唔會撞）。 */
  persistLocalOnly();
}

/* ---------------- 備份 / 還原 / 重設 ---------------- */
export function exportAll() {
  const db = load();
  return JSON.stringify({ ...db, _exportedFrom: 'real', _exportedAt: nowStamp() }, null, 2);
}

export function importAll(jsonText) {
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { throw new Error('JSON 格式錯誤'); }
  if (!obj || typeof obj !== 'object' || !obj.schema) throw new Error('唔似係本系統嘅備份檔（缺少 schema）');
  if (obj.schema !== SCHEMA) throw new Error(`備份版本（schema ${obj.schema}）同現時版本（${SCHEMA}）唔一致`);
  delete obj._exportedFrom;
  delete obj._exportedAt;
  /* 備份檔入面嘅 sync／backend 係**嗰部機**嘅連線設定 —— 呢部機自己嗰份要保留 */
  const keepSync = state.db?.sync ? { ...state.db.sync } : null;
  const keepBackend = state.db?.backend ? { ...state.db.backend } : null;
  state.db = obj;
  state.db.accounts = Array.isArray(obj.accounts) ? obj.accounts : [];
  migrateSharedAccounts(state.db);
  if (keepSync) state.db.sync = { ...keepSync, pending: Number(keepSync.pending || 0) };
  if (keepBackend) state.db.backend = keepBackend;
  state.db.unitCode = state.unitCode;
  state.db.kind = 'real';
  /* 還原備份 ＝ 一次改動（相對登入時嘅基準）—— 撳「儲存到後端」先會寫入，撞嘅格照樣會問 */
  persist();
  return state.db;
}

/* ============================================================
   後端資料 —— 「一個方式」（2026-09-20 團長定案）
   ------------------------------------------------------------
     登入／開機  → 由後端攞成份資料 ＝ 本機工作副本，同時記低一份**基準快照（base）**
     之後改乜    → 淨係寫本機（pending +1）
     撳「儲存」  → remote.saveToBackend()：diff(base, 本機) vs diff(base, 後端而家)
                   → 唔撞就一齊寫；撞嘅格保持後端、彈出嚟畀用家再確認（見 lib/merge3.js）
     儲存成功    → 本機 ＝ 後端 ＝ 新基準，pending 歸零

   基準快照另外存一個 key（venture82.unit.<編號>.base.v2），內容係剝走
   sync／meta／backend 之後嘅 db。冇佢就分唔到「我改咗乜」同「對方改咗乜」。
   ============================================================ */

const baseKey = (code) => `venture82.unit.${code}.base.v${SCHEMA}`;
let baseMem = undefined;           // localStorage 寫唔入（配額）嗰陣嘅後備

/** 剝走簿記／連線設定 —— 基準快照同比對都用呢個形狀 */
export function stripForBase(db) {
  const out = {};
  Object.keys(db || {}).forEach(k => { if (!SKIP_TOP.has(k)) out[k] = db[k]; });
  return _clone(out);
}

/** 而家嘅基準快照：{ version, at, db } ；未有就 null */
export function getBase() {
  if (baseMem !== undefined) return baseMem;
  const raw = lsGet(baseKey(state.unitCode));
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    return b && typeof b === 'object' && b.db ? b : null;
  } catch { return null; }
}

/** 記低基準快照（db ＝ 呢一刻同後端一致嘅內容；version ＝ 後端版本字串） */
export function setBase(db, version = '') {
  const rec = { version: String(version || ''), at: nowStamp(), db: stripForBase(db) };
  const key = baseKey(state.unitCode);
  try {
    localStorage.setItem(key, JSON.stringify(rec));
    baseMem = undefined;
  } catch {
    /* 配額爆／私隱模式 → 留喺記憶體（重新載入就會再由後端攞，唔會蝕資料） */
    baseMem = rec;
  }
  state.db.sync = { ...(state.db.sync || {}), lastSyncedVersion: rec.version, baseAt: rec.at };
  return rec;
}

export function clearBase() {
  baseMem = undefined;
  lsDel(baseKey(state.unitCode));
}

/** 後端拉返嚟嘅 db 先過一次同本機一樣嘅升級（identity／systemId／帳戶），
    咁基準、本機、後端三份先至係同一個形狀，唔會生出幻影改動。 */
export function normalizeRemote(remoteDb) {
  const db = _clone(remoteDb || {});
  if (!Array.isArray(db.accounts)) db.accounts = [];
  migrateSharedAccounts(db);
  migrateIdentities(db);
  migrateMemberKeys(db);
  return db;
}

/* 本機嘅連線設定／簿記唔可以因為換咗資料而斷（部機連緊邊個後端係部機自己嘅事） */
function keepLocalWiring(next, local) {
  next.schema = SCHEMA;
  next.kind = 'real';
  next.unitCode = state.unitCode;
  /* sync／backend 係**呢部機**連緊邊個後端、有幾多未存 —— 永遠用本機嗰份，
     唔會由後端資料帶入（另一部機貼嘅 /exec／API Key 唔應該經 Sheet 傳嚟傳去） */
  next.sync = { ...(local?.sync || {}) };
  if (local?.backend) next.backend = local.backend; else delete next.backend;
  next.meta = { ...(next.meta || {}), ...(local?.meta || {}) };
  return next;
}

/** 要寫上後端嘅內容：資料本身＋meta，**唔包括** sync／backend（每部機自己嘅連線設定） */
export function exportForBackend(db = state.db) {
  const out = {};
  Object.keys(db || {}).forEach(k => { if (k !== 'sync' && k !== 'backend') out[k] = db[k]; });
  out.schema = SCHEMA;
  out.kind = 'real';
  out.unitCode = state.unitCode;
  out.meta = { ...(out.meta || {}), updatedAt: nowStamp() };
  return out;
}

function syncLog(db, msg) {
  db.sync = db.sync || {};
  db.sync.log = [...(db.sync.log || []), { at: nowStamp().slice(0, 19).replace('T', ' '), msg }].slice(-40);
}

/**
 * 登入／開機：採用後端呢一刻嘅資料做工作副本 ＋ 基準。
 * 本機所有未儲存改動會被**丟棄**（呼叫者要自己先判斷 pending；有 pending 應該行 setLocalMerged）。
 */
export function adoptRemote(remoteDb, { version = '' } = {}) {
  if (!remoteDb || typeof remoteDb !== 'object') throw new Error('後端資料格式唔啱');
  if (remoteDb.schema && remoteDb.schema !== SCHEMA) {
    throw new Error(`後端資料版本（schema ${remoteDb.schema}）同現時版本（${SCHEMA}）唔一致`);
  }
  const local = state.db;
  const next = keepLocalWiring(normalizeRemote(remoteDb), local);
  state.db = next;
  state.db.sync = { ...(state.db.sync || {}), pending: 0, lastPullAt: nowStamp(), lastError: '' };
  syncLog(state.db, '⇩ 已由後端載入（呢一刻嘅後端 ＝ 呢部機嘅基準）');
  setBase(state.db, version);
  state.seedFailed = false;
  state.seedSource = '（後端：旅團自己嘅 Google Sheet）';
  state.db.meta = { ...(state.db.meta || {}), seedSource: state.seedSource };
  persistLocalOnly();
  return state.db;
}

/**
 * 登入時本機仲有未儲存改動：本機 ← 合併結果（後端 ＋ 我嘅唔撞改動），基準 ← 後端而家。
 * 我嘅改動因此仍然係「基準 → 本機」嘅 diff，之後撳儲存先寫。
 */
export function setLocalMerged(mergedDb, remoteDb, { version = '', pending = 0 } = {}) {
  const local = state.db;
  const remoteN = normalizeRemote(remoteDb);
  const next = keepLocalWiring(normalizeRemote(mergedDb), local);
  state.db = next;
  state.db.sync = { ...(state.db.sync || {}), lastPullAt: nowStamp(), lastError: '' };
  syncLog(state.db, '⇩ 已由後端載入，並保留呢部機未儲存嘅改動（撳「儲存到後端」先寫）');
  /* 基準 ＝ 後端而家（唔係合併結果）—— 咁我嘅改動先至仍然睇得出 */
  const rec = { version: String(version || ''), at: nowStamp(), db: stripForBase(remoteN) };
  try { localStorage.setItem(baseKey(state.unitCode), JSON.stringify(rec)); baseMem = undefined; }
  catch { baseMem = rec; }
  state.db.sync.lastSyncedVersion = rec.version;
  state.db.sync.baseAt = rec.at;
  const stillMine = _diffDb(rec.db, stripForBase(state.db)).length;
  state.db.sync.pending = stillMine ? Math.max(1, Number(pending || local?.sync?.pending || 1)) : 0;
  state.seedFailed = false;
  state.seedSource = '（後端＋本機未儲存改動）';
  state.db.meta = { ...(state.db.meta || {}), seedSource: state.seedSource };
  persistLocalOnly();
  return state.db;
}

/** 儲存成功：本機 ＝ 後端 ＝ 新基準 */
export function commitSaved(finalDb, { version = '', bytes = 0, parts = 0 } = {}) {
  const local = state.db;
  const next = keepLocalWiring(normalizeRemote(finalDb), local);
  state.db = next;
  state.db.sync = { ...(state.db.sync || {}), pending: 0, pendingAccounts: 0, lastPushAt: nowStamp(), lastError: '' };
  setBase(state.db, version);
  syncLog(state.db, `✓ 已儲存到後端${bytes ? `（${(bytes / 1024).toFixed(0)} KB${parts ? `，分 ${parts} 件` : ''}）` : ''}`);
  state.db.meta = { ...(state.db.meta || {}), seedSource: '（後端：旅團自己嘅 Google Sheet）' };
  persistLocalOnly();
  return state.db;
}

/** 把一批改動（例如用家揀「用我嘅」嘅衝突）套落本機，當成一次新改動（pending +1） */
export function applyChangesLocal(changes) {
  if (!state.db || !changes?.length) return state.db;
  _applyChanges(state.db, changes);
  persist();
  return state.db;
}

/** 本機相對基準而家有幾多個改動（真數；pending 只係次數） */
export function localChanges() {
  const b = getBase();
  if (!b || !state.db) return [];
  return _diffDb(b.db, stripForBase(state.db));
}

/** 把「後端仲未有資料庫」記做基準（新旅團第一次）：基準＝空，之後儲存＝全部當我加嘅 */
export function markBackendEmpty() {
  if (!state.db) return;
  const rec = { version: '', at: nowStamp(), db: {}, empty: true };
  try { localStorage.setItem(baseKey(state.unitCode), JSON.stringify(rec)); baseMem = undefined; }
  catch { baseMem = rec; }
  state.db.sync = { ...(state.db.sync || {}), lastSyncedVersion: '', baseAt: rec.at, lastPullAt: nowStamp() };
  if (hasLocalContent()) state.db.sync.pending = Math.max(1, Number(state.db.sync.pending || 0));
  persistLocalOnly();
}

/** 由 localStorage 重新讀返本機 db（測試／另一個視窗改咗 localStorage 之後用） */
export function reloadFromStorage() {
  const raw = lsGet(dbKey(state.unitCode));
  if (!raw) return state.db;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schema === SCHEMA) state.db = parsed;
  } catch { /* ignore */ }
  baseMem = undefined;
  return state.db;
}

/* ============================================================
   ★ 2026-09-24 同一個瀏覽器、另一個分頁（團長：「不同視窗開的又不同步」）
   ------------------------------------------------------------
   問題：db 開機讀一次之後就一直住喺記憶體（state.db）。另一個分頁開咗人、
   設咗密碼，呢邊個記憶體副本完全唔知 —— 除非重新整理。所以出現
   「1 邊登到、1 邊登唔到」，用家完全冇辦法自己估到原因。

   做法：聽瀏覽器嘅 `storage` event（**只有其他分頁**寫先會派，自己寫唔會派，
   所以唔會自己咬自己尾），用同一套三方比對（lib/merge3.js）併入：
     · 我未改過嘢      → 直接採用佢嗰份
     · 我都改咗嘢      → 三方併合：佢嘅改動併入，我改過嗰幾格保留我嘅值
   併完之後派 `v82:external` event，介面自己 re-render。
   ============================================================ */
let crossTabBound = false;
let crossTabCallback = null;

/**
 * 把另一個分頁寫入 localStorage 嘅 db 併入本機。
 * @returns {{ok:boolean, took?:'theirs'|'merge'|'same', applied?:number, conflicts?:number, reason?:string}}
 */
export function mergeFromOtherTab(otherDb) {
  if (!state.db) return { ok: false, reason: 'no_db' };
  if (!otherDb || typeof otherDb !== 'object') return { ok: false, reason: 'bad' };
  if (otherDb.schema && otherDb.schema !== SCHEMA) return { ok: false, reason: 'schema' };
  const other = normalizeRemote(_clone(otherDb));
  const localStripped = stripForBase(state.db);
  const otherStripped = stripForBase(other);
  if (JSON.stringify(localStripped) === JSON.stringify(otherStripped)) return { ok: false, reason: 'same' };

  const dirty = localChanges().length > 0;
  const base = getBase();

  if (!dirty || !base?.db) {
    /* 我冇未存改動（或者冇基準快照分唔到邊個改咗乜）→ 採用佢嗰份，
       但呢部機自己嘅連線設定／簿記要保留。 */
    if (dirty) return { ok: false, reason: 'no_base_dirty' };
    state.db = keepLocalWiring(other, state.db);
    commitMeta();
    return { ok: true, took: 'theirs' };
  }

  const tw = _threeWay(base.db, localStripped, otherStripped);
  /* merged ＝ 佢嗰份 ＋ 我冇撞嘅改動；撞咗嗰幾格暫時係佢嘅值 ——
     同一個瀏覽器入面，我啱啱打嘅嘢唔應該靜靜地消失，所以即刻用返我嘅，
     然後照常寫後端（撞嘅部分由後端儲存嗰步再正式核對）。 */
  const next = keepLocalWiring(normalizeRemote(tw.merged), state.db);
  const ov = _overridesFor(tw.conflicts, true);
  if (ov.length) _applyChanges(next, ov);
  state.db = next;
  commitMeta();
  return { ok: true, took: 'merge', applied: tw.theirs?.length || 0, conflicts: tw.conflicts?.length || 0 };
}

/**
 * 掛上「另一個分頁改咗嘢」嘅監聽（一個頁面只掛一次）。
 * @param {(info:{kind:'db'|'session', result?:object})=>void} [onChange]
 */
export function bindCrossTabSync(onChange) {
  if (typeof onChange === 'function') crossTabCallback = onChange;
  if (crossTabBound) return false;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return false;
  crossTabBound = true;
  const fire = (info) => {
    try { window.dispatchEvent(new CustomEvent('v82:external', { detail: info })); } catch { /* ignore */ }
    if (typeof crossTabCallback === 'function') {
      try { crossTabCallback(info); } catch (e) { console.warn('[store] 跨分頁回調失敗', e); }
    }
  };
  window.addEventListener('storage', (ev) => {
    const key = ev?.key || '';
    if (!key) return;
    if (key === SESSION_KEY) { fire({ kind: 'session' }); return; }
    if (key !== dbKey(state.unitCode) || !ev.newValue) return;
    let other = null;
    try { other = JSON.parse(ev.newValue); } catch { return; }
    const r = mergeFromOtherTab(other);
    if (r.ok) fire({ kind: 'db', result: r });
  });
  return true;
}

/** 本機已知嘅「後端版本」（上次 pull／push 成功嗰個）—— 只係顯示用；樂觀鎖用 getBase().version */
export function lastSyncedVersion() {
  return String(state.db?.sync?.lastSyncedVersion || '');
}

/** 本機資料庫嘅「最後改動時間」（同後端比新舊用） */
export function localUpdatedAt() { return state.db?.meta?.updatedAt || ''; }

/** 本機有冇實質內容（用嚟判斷係咪全新裝置） */
export function hasLocalContent() {
  const db = state.db;
  if (!db) return false;
  return !!(
    (db.members || []).length || (db.transactions || []).length ||
    (db.meetings || []).length || (db.notices || []).length ||
    (db.invItems || []).length || (db.fees || []).length ||
    (db.events || []).length || (db.quizzes || []).length ||
    (db.constitution?.chapters || []).length
  );
}

/** 由 data/ 檔案重新種入（清走本機改動） */
export async function resetToSeed() {
  state.db = await buildSeed(state.unitCode);
  state.seedFailed = !!state.db.meta?.seedFailed;
  persist();
  return state.db;
}

/** 完全清空呢個旅團（真實資料）。
    注意：**後端連線設定會保留** —— 清資料唔應該連埋「連去邊個 Sheet」都清走，
    否則清完之後 app 就再冇後端，改動又變返淨係存喺瀏覽器。 */
export function wipe() {
  const keepSync = state.db?.sync ? { ...state.db.sync, pending: 0, log: [] } : null;
  const keepBackend = state.db?.backend ? { ...state.db.backend } : null;
  state.db = blankDb(state.unitCode, unitEntry(state.unitCode) || {});
  state.db.meta.seedFailed = false;
  if (keepSync) state.db.sync = keepSync;
  if (keepBackend) state.db.backend = keepBackend;
  /* 冇原本設定就用返 Registry 登記嘅後端 */
  if (!state.db.sync?.url) seedBackend(state.db, state.unitCode);
  persist();
  return state.db;
}

/* ---------------- session（登入狀態） ---------------- */
export function getSession() {
  try { const raw = lsGet(K.session); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function setSession(s) {
  if (!s) lsDel(K.session); else lsSet(K.session, JSON.stringify(s));
}
export const SESSION_KEY = K.session;
