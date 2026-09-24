/* ============================================================
   store.js — 資料層（多旅團 · 真實／示範完全分離）

   命名空間（key）：
     真實旅團   venture82.unit.<旅團編號>.db.v2
     示範資料   venture82.mock.db.v2          ← 同真實資料完全隔離，唔會互相污染
     旅團清單   venture82.units.cache.v2 / venture82.units.local.v2
     登入狀態   venture82.session.v2
     目前模式   venture82.mode.v2

   真實資料由 data/units/<編號>/*.json 首次載入時種入本機，
   之後所有改動都寫入上面嘅獨立 key，唔會再寫返 data/ 檔案。
   ============================================================ */

import { todayISO, nowStamp } from './dates.js';
import { canonicalUnitCode } from './units.js';
import {
  registry, unitEntry, backendOf, dataPathOf, fetchUnitData, fetchMockData, defaultUnitCode, localUnits
} from './units.js';
import { scoutFYLabel } from './fiscal.js';
import { SKIP_TOP, diffDb as _diffDb, applyChanges as _applyChanges, clone as _clone } from './merge3.js';

export const SCHEMA = 2;

const K = {
  session: 'venture82.session.v2',
  mode: 'venture82.mode.v2',
  unit: 'venture82.currentUnit.v2',
  /* 最後一個**真實**旅團 —— 「離開示範」之後可以一撳就返去自己旅團，
     唔使喺清單再揀一次。示範模式永遠唔會寫呢個 key。 */
  lastReal: 'venture82.lastRealUnit.v2'
};
export const dbKey = (mode, code) => mode === 'mock' ? `venture82.mock.db.v${SCHEMA}` : `venture82.unit.${code}.db.v${SCHEMA}`;

/* ---------------- 預設帳戶 ----------------
   超管係隱藏帳戶（見 auth.js），唔會出現在呢個名單，亦唔會匯出。 */
export const SEED_ACCOUNTS = [
  {
    id: 'acc_leader', role: 'leader', username: 'leader', name: '團領袖', title: '領袖',
    pw: { algo: 'sha256', salt: 'v82:leader:leader', hash: '1bee77ce443f65f937002876e9b00d2ef2fb5c6fe25fa148c3a32ecebfcad385' },
    pwUpdatedAt: '2026-09-14', seeded: true, defaultPw: true
  },
  {
    id: 'acc_exco', role: 'exco', username: 'exco', name: '執行委員會', title: '執委會',
    pw: { algo: 'sha256', salt: 'v82:exco:exco', hash: 'e70573909c932516077cd2b339499e2d93b0232cf15f518b370403b65b800a32' },
    pwUpdatedAt: '2026-09-14', seeded: true, defaultPw: true
  }
];

export const SEED_ACCOUNTS_MOCK = [
  { id: 'mock_leader', role: 'leader', username: 'demo-leader', name: '示範領袖', title: '團領袖', pw: null, demo: true },
  { id: 'mock_exco', role: 'exco', username: 'demo-exco', name: '示範執委', title: '文書', pw: null, demo: true }
];

/* ---------------- 狀態 ---------------- */
const state = {
  mode: 'real',
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
const IDENTITY_KEYS = ['leader', 'exco', 'member'];
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
function blankDb(mode, code, entry = {}) {
  return {
    schema: SCHEMA,
    kind: mode,
    unitCode: code,
    unit: { code, name: entry.name || code, nameEn: entry.nameEn || '', short: entry.short || code, theme: entry.theme || {} },
    settings: {
      currency: 'HK$', feePerYear: 360, feePeriodLabel: '', subsidyPercent: 30, subsidyCap: 70,
      openingBalance: 0, openingBalanceDate: todayISO().slice(0, 4) + '-04-01',
      scoutFYStartMonth: 4, scoutFYStartDay: 1,
      agmDates: [{ year: new Date().getFullYear(), date: '', note: '未設定' }],
      publicBaseUrl: ''
    },
    accounts: mode === 'mock' ? SEED_ACCOUNTS_MOCK : SEED_ACCOUNTS,
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
    meta: { createdAt: nowStamp(), updatedAt: nowStamp(), seedSource: mode === 'mock' ? 'data/mock/' : (entry.local ? '（本地旅團：空白資料）' : (entry.fromApi ? '（伺服器 Registry：由空白資料庫開始）' : (dataPathOf(code) || ''))), real: mode === 'real' }
  };
}

async function buildSeed(mode, code) {
  const entry = unitEntry(code) || {};
  const db = blankDb(mode, code, entry);
  const pick = (mode === 'mock') ? fetchMockData : ((f) => fetchUnitData(code, f));

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
  seedBackend(db, mode, code);
  return db;
}

/* ---------------- 後端（Apps Script 總表）：所有流出資料都用同一條 /exec ----------------
   優先次序：unit.json settings.sync / tables.json → 旅團 registry backend → Registry 共用 backend */
function seedBackend(db, mode, code) {
  if (mode === 'mock') return;                     // 示範資料永遠唔會送出街
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
/** 由網址／記錄決定「而家係邊個模式、邊個旅團」。
 *
 * 【為咩要咁寫】2026-09 團長回報「去過 MOCK 之後，喺首頁揀返 Vercel 登記嘅旅團，
 * 入到去仍然係 MOCK，資料又冇同後端同步」。
 * 原因：`state.mode = lsGet(K.mode) || 'real'` —— mode 一寫入 localStorage 就
 * **永遠**贏，之後就算網址係 `?u=0081`（真人真旅團、冇 mock=1）都照樣當示範模式，
 * 於是：資料庫 key 變咗 mock 空間、MOCK 橫額照出、syncBoot() 又第一時間 return，
 * 用家嘅感覺就係「我揀咗自己旅團但入唔到」。
 *
 * 正確嘅優先次序（網址永遠最權威）：
 *   1. init({ mode, unit }) —— 程式內部指定（測試、公開頁）
 *   2. ?mock=1 或者 ?u=MOCK  → 示範
 *   3. ?u=<真實編號>         → 真實（就算 localStorage 仲寫住 mock）
 *   4. localStorage 記錄
 *   5. 'real'
 */
function resolveTarget(opts = {}, url = new URLSearchParams(location.search)) {
  const urlUnitRaw = String(url.get('u') || '').trim();
  const isMockCode = urlUnitRaw.toUpperCase() === 'MOCK';
  const urlMock = url.get('mock') === '1';

  let mode;
  if (opts.mode) mode = opts.mode;
  else if (urlMock || isMockCode) mode = 'mock';
  else if (urlUnitRaw) mode = 'real';
  else mode = lsGet(K.mode) || 'real';

  let code;
  if (opts.unit) code = String(opts.unit);
  else if (mode === 'mock') code = 'MOCK';                  // 示範永遠用自己嘅命名空間
  else code = urlUnitRaw || lsGet(K.unit) || defaultUnitCode();

  /* 記錄最後一個真實旅團（唔好記錄 MOCK／空） */
  if (mode === 'real' && code && code.toUpperCase() !== 'MOCK') lsSet(K.lastReal, code);
  return { mode, code };
}

export async function init(opts = {}) {
  const { mode, code } = resolveTarget(opts);
  state.mode = mode;
  state.unitCode = code;

  const key = dbKey(state.mode, code);
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
    state.db = await buildSeed(state.mode, code);
    state.seedFailed = !!state.db.meta?.seedFailed;
    state.seedSource = state.db.meta?.seedSource || '';
    persistLocalOnly();
  }
  /* 開機升級（帳戶名單／身份／systemId／期初結餘／後端設定）全部只寫本機 ——
     佢哋唔係用家嘅改動，唔應該令 pending 由 0 變 1（否則一開機就話「未儲存」）。 */
  if (!Array.isArray(state.db.accounts) || !state.db.accounts.length) {
    state.db.accounts = state.mode === 'mock' ? SEED_ACCOUNTS_MOCK : SEED_ACCOUNTS;
    persistLocalOnly();
  }
  // 用戶名冊升級：舊資料冇「身份」欄 → 由職位／標籤推算（領袖 / 執委 / 團員）
  if (migrateIdentities(state.db)) persistLocalOnly();
  // 跨系統身份 key（進度追蹤等外部系統要靠呢個對人）
  if (migrateMemberKeys(state.db)) persistLocalOnly();
  // 期初結餘：舊嘅全域數字如果係上年度嘅期初，自動搬返去對應年度（見 migrateOpeningBalances）
  if (migrateOpeningBalances(state.db)) persistLocalOnly();
  // 後端設定升級：舊資料庫（未有 sync 設定）自動補上 Registry / unit.json 嘅 Apps Script 網址
  if (state.mode === 'real') {
    const before = JSON.stringify([state.db.sync?.url || '', state.db.settings?.notice?.submitUrl || '', state.db.settings?.publicEntry?.submitUrl || '', state.db.settings?.publicBorrow?.submitUrl || '']);
    if (state.db.sync?.url !== undefined || !state.db.backend) seedBackend(state.db, state.mode, code);
    const after = JSON.stringify([state.db.sync?.url || '', state.db.settings?.notice?.submitUrl || '', state.db.settings?.publicEntry?.submitUrl || '', state.db.settings?.publicBorrow?.submitUrl || '']);
    if (before !== after) persistLocalOnly();
  }
  lsSet(K.unit, code);
  lsSet(K.mode, state.mode);
  /* 舊版（2026-09-19 之前）留低嘅指紋基準已經冇用 —— 而家用成份基準快照（getBase） */
  if (state.db.sync?.baseObjHash) { delete state.db.sync.baseObjHash; persistLocalOnly(); }
  state.ready = true;
  return state.db;
}

export function ready() { return state.ready; }
export function isMock() { return state.mode === 'mock'; }
export function currentMode() { return state.mode; }
export function currentUnit() { return state.unitCode; }
export function unitProfile() { return load().profile || load().unit; }
export function seedInfo() { return { source: state.seedSource || load()?.meta?.seedSource || '', failed: state.seedFailed, real: !isMock() }; }

export function setMode(mode) { lsSet(K.mode, mode); }
/* ★ 旅團編號一律用 Registry 登記咗嗰個（82 → 0082）。
   團長喺閘度打「82」係最自然嘅做法，但 db.unitCode 一旦係「82」，
   寫落 Google Sheet 嘅旅團欄、讀返嘅 filter、報表分頁就會同「0082」對唔上
   —— 同一張表出現兩套資料庫，症狀就係「寫咗但讀唔到」。 */
export function setUnitCode(code) { lsSet(K.unit, canonicalUnitCode(code) || code); }

/** 切換旅團（重載頁面，確保所有模組用新資料） */
export function switchUnit(code) {
  const isMockCode = String(code || '').toUpperCase() === 'MOCK';
  lsSet(K.unit, isMockCode ? code : (canonicalUnitCode(code) || code));
  lsSet(K.mode, isMockCode ? 'mock' : 'real');       // 由示範切去真旅團 = 一定要離開示範
  const u = new URL(location.href);
  u.searchParams.set('u', code);
  if (isMockCode) u.searchParams.set('mock', '1');
  else u.searchParams.delete('mock');
  u.hash = '#/dashboard';
  location.href = u.toString();
}
/* 「已揀咗旅團」記錄（main.js 嘅旅團選擇閘共用同一個 key）。
   離開示範／重置選擇時要一齊清，否則下一次開機會由呢度直接跳返入去。 */
export const CHOSEN_UNIT_KEY = 'venture82.unitChosen.v2';

/** 最後一個用過嘅真實旅團（示範模式唔會覆蓋佢） */
export function lastRealUnit() {
  const c = lsGet(K.lastReal);
  return c && c.toUpperCase() !== 'MOCK' ? c : '';
}

export function enterMock() {
  const u = new URL(location.href);
  u.searchParams.set('mock', '1');
  u.searchParams.set('u', 'MOCK');       // ⬅️ 一定要帶 u=MOCK，否則 ?mock=1 會被當成
  u.hash = '';                           //    「真旅團 MOCK」→ 冇橫額、出唔返嚟（2026-09 真實 bug）
  location.href = u.toString();
}

/**
 * 清晒所有「示範／已揀旅團」嘅痕跡，重載返去旅團選擇閘。
 *
 * 以前 exitMock 只係由 URL 刪走 mock=1 —— 但 localStorage 仲留緊
 * mode=mock、unit=MOCK，URL 又有 u=MOCK，下次 boot 照樣入返示範，
 * 用家撳「離開示範」永遠出唔到（2026-09 真實 bug：被困喺 MOCK）。
 *
 * 2026-09 追加：連登入 session 都要清 —— 示範 session（mock leader）唔應該
 * 帶到真實旅團，否則登入身份會係「示範領袖」。
 */
export function resetToGate() {
  lsDel(K.mode);
  lsDel(K.unit);
  lsDel(CHOSEN_UNIT_KEY);
  try { setSession(null); } catch { /* 未初始化都冇問題 */ }
  const u = new URL(location.href);
  u.searchParams.delete('mock');
  u.searchParams.delete('u');
  u.hash = '';
  location.href = u.toString();
}

/** 離開示範 → 旅團選擇閘（清晒示範痕跡） */
export function exitMock() { resetToGate(); }

/**
 * 離開示範 → 直接返最後一個真實旅團（冇用過真實旅團就返閘）。
 * 畀「試完 MOCK，想即刻返自己旅團」用家一撳返去。
 */
export function exitMockToUnit() {
  const back = lastRealUnit();
  if (!back) return resetToGate();
  lsDel(K.mode);
  lsDel(K.unit);
  lsDel(CHOSEN_UNIT_KEY);
  try { setSession(null); } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.delete('mock');
  u.searchParams.set('u', back);
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
   冇掛住（例如測試、公開頁）就淨係寫本機，行為同以前一樣。 */
let saveHook = null;
export function setSaveHook(fn) { saveHook = typeof fn === 'function' ? fn : null; }

function persist({ remote = true } = {}) {
  if (!state.db) return;
  state.db.meta = state.db.meta || {};
  state.db.meta.updatedAt = nowStamp();
  /* pending ＝「仲未寫入後端嘅改動次數」（介面提示用；真正要寫乜係 diff(基準, 本機)）。
     要**先**加、**後**寫 localStorage —— 以前掉轉次序，localStorage 入面嘅 pending
     永遠差一次，閂咗視窗再開就以為冇嘢未存。示範模式永遠唔計。 */
  const bump = state.mode !== 'mock' && remote;
  if (bump) {
    state.db.sync = state.db.sync || {};
    state.db.sync.pending = Number(state.db.sync.pending || 0) + 1;
  }
  lsSet(dbKey(state.mode, state.unitCode), JSON.stringify(state.db));
  /* 本機寫完 → 通知介面（頂部出「儲存到後端（N）」）。唔會寫後端。 */
  if (bump && saveHook) {
    try { saveHook(); } catch (e) { console.warn('[store] 儲存狀態通知失敗', e); }
  }
}

/** 只寫本機，唔會觸發後端儲存（由後端拉落嚟嘅資料用，免得again寫返上去） */
function persistLocalOnly() { persist({ remote: false }); }

export function commit() { persist(); return state.db; }
export const save = commit;

/**
 * 淨係寫低「同步簿記」（pending／lastPushAt／log）——
 * **唔會**動 meta.updatedAt、**唔會**加 pending、**唔會**再觸發後端儲存。
 * 如果用普通 commit() 去記錄「已儲存」，就會即刻又標記成「有改動要儲存」，
 * 變成無限迴圈（存完又存）。所以簿記一定要行呢條路。
 */
export function commitMeta() {
  if (!state.db) return state.db;
  lsSet(dbKey(state.mode, state.unitCode), JSON.stringify(state.db));
  return state.db;
}

export function collection(name) {
  const db = load();
  if (!Array.isArray(db[name])) db[name] = [];
  return db[name];
}
export function find(name, id) { return collection(name).find(x => x.id === id) || null; }
export function add(name, obj) {
  const id = obj.id || (name.slice(0, 2) + '_' + Math.random().toString(36).slice(2, 8));
  const rec = { ...obj, id };
  collection(name).push(rec);
  persist();
  return rec;
}
export function update(name, id, patch) {
  const rec = find(name, id);
  if (!rec) return null;
  Object.assign(rec, patch, { id });
  persist();
  return rec;
}
export function remove(name, id) {
  const list = collection(name);
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  persist();
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
  db.auditLog.unshift({ id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), at: nowStamp(), action, detail, by: who || '' });
  if (db.auditLog.length > 400) db.auditLog.length = 400;
  /* 操作紀錄係簿記：只寫本機、唔計入「未儲存改動」（否則一登入就話有嘢未存）。
     佢會跟下一次真正嘅儲存一齊上後端（三方合併：紀錄係併集，永遠唔會撞）。 */
  persistLocalOnly();
}

/* ---------------- 備份 / 還原 / 重設 ---------------- */
export function exportAll({ includeMock = false } = {}) {
  const db = load();
  if (isMock() && !includeMock) {
    // 示範資料要另外匯出，唔可以當成真資料備份
    return JSON.stringify({ ...db, _exportedFrom: 'mock' }, null, 2);
  }
  return JSON.stringify({ ...db, _exportedFrom: isMock() ? 'mock' : 'real', _exportedAt: nowStamp() }, null, 2);
}

export function importAll(jsonText, { allowMockIntoReal = false } = {}) {
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { throw new Error('JSON 格式錯誤'); }
  if (!obj || typeof obj !== 'object' || !obj.schema) throw new Error('唔似係本系統嘅備份檔（缺少 schema）');
  if (obj.schema !== SCHEMA) throw new Error(`備份版本（schema ${obj.schema}）同現時版本（${SCHEMA}）唔一致`);
  const from = obj._exportedFrom || obj.kind;
  if (from === 'mock' && !isMock() && !allowMockIntoReal) {
    throw new Error('呢個係示範（MOCK）備份，唔可以匯入真實資料庫（保護真實資料）');
  }
  delete obj._exportedFrom;
  delete obj._exportedAt;
  /* 備份檔入面嘅 sync／backend 係**嗰部機**嘅連線設定 —— 呢部機自己嗰份要保留 */
  const keepSync = state.db?.sync ? { ...state.db.sync } : null;
  const keepBackend = state.db?.backend ? { ...state.db.backend } : null;
  state.db = obj;
  state.db.accounts = Array.isArray(obj.accounts) && obj.accounts.length ? obj.accounts : SEED_ACCOUNTS;
  if (keepSync) state.db.sync = { ...keepSync, pending: Number(keepSync.pending || 0) };
  if (keepBackend) state.db.backend = keepBackend;
  state.db.unitCode = state.unitCode;
  state.db.kind = state.mode;
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

const baseKey = (mode, code) => mode === 'mock' ? `venture82.mock.base.v${SCHEMA}` : `venture82.unit.${code}.base.v${SCHEMA}`;
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
  const raw = lsGet(baseKey(state.mode, state.unitCode));
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    return b && typeof b === 'object' && b.db ? b : null;
  } catch { return null; }
}

/** 記低基準快照（db ＝ 呢一刻同後端一致嘅內容；version ＝ 後端版本字串） */
export function setBase(db, version = '') {
  const rec = { version: String(version || ''), at: nowStamp(), db: stripForBase(db) };
  const key = baseKey(state.mode, state.unitCode);
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
  lsDel(baseKey(state.mode, state.unitCode));
}

/** 後端拉返嚟嘅 db 先過一次同本機一樣嘅升級（identity／systemId／帳戶），
    咁基準、本機、後端三份先至係同一個形狀，唔會生出幻影改動。 */
export function normalizeRemote(remoteDb) {
  const db = _clone(remoteDb || {});
  if (!Array.isArray(db.accounts) || !db.accounts.length) db.accounts = _clone(SEED_ACCOUNTS);
  migrateIdentities(db);
  migrateMemberKeys(db);
  return db;
}

/* 本機嘅連線設定／簿記唔可以因為換咗資料而斷（部機連緊邊個後端係部機自己嘅事） */
function keepLocalWiring(next, local) {
  next.schema = SCHEMA;
  next.kind = state.mode;
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
  out.kind = state.mode;
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
  if (isMock()) throw new Error('示範模式唔會採用後端資料');
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
  if (isMock()) throw new Error('示範模式唔會採用後端資料');
  const local = state.db;
  const remoteN = normalizeRemote(remoteDb);
  const next = keepLocalWiring(normalizeRemote(mergedDb), local);
  state.db = next;
  state.db.sync = { ...(state.db.sync || {}), lastPullAt: nowStamp(), lastError: '' };
  syncLog(state.db, '⇩ 已由後端載入，並保留呢部機未儲存嘅改動（撳「儲存到後端」先寫）');
  /* 基準 ＝ 後端而家（唔係合併結果）—— 咁我嘅改動先至仍然睇得出 */
  const rec = { version: String(version || ''), at: nowStamp(), db: stripForBase(remoteN) };
  try { localStorage.setItem(baseKey(state.mode, state.unitCode), JSON.stringify(rec)); baseMem = undefined; }
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
  state.db.sync = { ...(state.db.sync || {}), pending: 0, lastPushAt: nowStamp(), lastError: '' };
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
  try { localStorage.setItem(baseKey(state.mode, state.unitCode), JSON.stringify(rec)); baseMem = undefined; }
  catch { baseMem = rec; }
  state.db.sync = { ...(state.db.sync || {}), lastSyncedVersion: '', baseAt: rec.at, lastPullAt: nowStamp() };
  if (hasLocalContent()) state.db.sync.pending = Math.max(1, Number(state.db.sync.pending || 0));
  persistLocalOnly();
}

/** 由 localStorage 重新讀返本機 db（測試／另一個視窗改咗 localStorage 之後用） */
export function reloadFromStorage() {
  const raw = lsGet(dbKey(state.mode, state.unitCode));
  if (!raw) return state.db;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schema === SCHEMA) state.db = parsed;
  } catch { /* ignore */ }
  baseMem = undefined;
  return state.db;
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
  state.db = await buildSeed(state.mode, state.unitCode);
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
  state.db = blankDb(state.mode, state.unitCode, unitEntry(state.unitCode) || {});
  if (state.mode === 'real') {
    state.db.meta.seedFailed = false;
    if (keepSync) state.db.sync = keepSync;
    if (keepBackend) state.db.backend = keepBackend;
    /* 冇原本設定就用返 Registry 登記嘅後端 */
    if (!state.db.sync?.url) seedBackend(state.db, state.mode, state.unitCode);
  }
  persist();
  return state.db;
}

/** 清除示範資料（唔會影響真實資料） */
export function clearMockData() {
  lsDel(dbKey('mock', state.unitCode));
  lsDel(baseKey('mock', state.unitCode));
  if (isMock()) {
    try { localStorage.removeItem('venture82.mock.db.v' + SCHEMA); } catch { /* ignore */ }
    baseMem = undefined;
  }
}

/* ---------------- session（登入狀態） ---------------- */
export function getSession() {
  try { const raw = lsGet(K.session); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function setSession(s) {
  if (!s) lsDel(K.session); else lsSet(K.session, JSON.stringify(s));
}
export const SESSION_KEY = K.session;
