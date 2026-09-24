/* ============================================================
   auth.js — 身份、權限、密碼規則

   ★ 2026-09-24 團長定案：「所有嘢都以個人身份登入」
     · **身份即帳號**：團長 / 領袖 / 執委 / 團員 都係名冊（members）嘅人，
       登入代號 ＝ email → loginId → ymis（見 model.js loginIdOf）。
       **冇咗「領袖共用帳戶」同「執行委員會帳號」** ——
       要改權限＝改身份，唔係開多個帳戶（見 members.js「身份」欄）。
     · 團長（chief）：每個旅團**永遠只有一位**，權限最高，可以轉移。
       第一個設定嗰個（開團／開戶嗰位）就係團長。
     · super 超級管理員 —— 隱藏：唔會顯示喺任何名單，
       只可以用指定帳號／密碼登入（伺服器端核對），冇人可以改佢個密碼。

   密碼權限（依實際需要）：
     超管：可改任何人嘅密碼
     團長：可改自己、領袖、執委嘅密碼
     領袖：可改自己、執委嘅密碼
     執委：只可改自己嘅密碼
   ============================================================ */

import {
  load, tryLoad, commitCritical, collection, find, add, remove, getSession, setSession, audit, currentUnit
} from './store.js';
import { chief as chiefRecord, hasChief } from './model.js';

export const ROLES = {
  super: {
    id: 'super', name: '超級管理員', short: '超管', color: '#4A111C', level: 5, hidden: true,
    desc: '系統擁有者（隱藏帳戶）'
  },
  chief: {
    id: 'chief', name: '團長', short: '團長', color: '#B8892B', level: 4,
    desc: '團長（每團一位）—— 最高權限：設定／轉移身份、所有模組；第一個開戶嘅人預設係團長'
  },
  leader: {
    id: 'leader', name: '領袖', short: '領袖', color: '#7B2233', level: 3,
    desc: '團領袖／支部領袖 —— 管理團務、財務、團章、物資'
  },
  exco: {
    id: 'exco', name: '執委', short: '執委', color: '#A83A4E', level: 2,
    desc: '執委會成員 —— 日常團務：開會、點名、記帳、借用物資'
  },
  member: {
    id: 'member', name: '團員', short: '團員', color: '#8A6E75', level: 1,
    desc: '團員 —— 睇通告、報活動、自己的進度'
  }
};

/* 隱藏超級管理員。
 *
 * ★ 2026-09-20 改：呢度**唔再有任何密碼**。
 *   以前密碼寫死喺呢個檔，而呢個係靜態網站 —— 個檔會原原本本送到
 *   每個訪客嘅瀏覽器，repo 又係 public，等於密碼貼咗出街。
 *
 *   而家核對搬咗去伺服器端（api/auth.js），密碼只存喺 Vercel 嘅
 *   環境變數 `SUPER_KEY`。冇設 → 超管登入完全關閉（fail closed）。
 *
 *   ⚠️ 呢個做法保護到「密碼」，保護唔到「超管身份」本身 ——
 *      靜態網站嘅 `isSuper()` 淨係讀 localStorage，識開 DevTools 就改到。
 *      而家超管只 gate UI，所以冇實質損失；將來如果超管要做真正敏感嘅嘢，
 *      嗰個操作要放喺伺服器端，自己再核對一次 SUPER_KEY。
 *
 *   username 唔係秘密（`RESERVED_USERNAMES` 本來就公開咗佢），
 *   留喺呢度用嚟判斷「呢次登入係咪想入超管」；真正核對交畀伺服器。 */
const SUPER = {
  id: 'super',
  role: 'super',
  username: 'sheep',
  name: '系統管理員'
};

/** 叫伺服器端核對超管密碼（api/auth.js）。
 *  回 `{ok:true}` 或者 `{ok:false, error, disabled?}`。
 *  纯靜態部署（冇 /api）→ 當「已關閉」，唔會跌返去任何本機比對。 */
async function verifySuperServer(password) {
  try {
    const res = await fetch('api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: SUPER.username, password })
    });
    const j = await res.json().catch(() => null);
    if (j?.ok === true) return { ok: true };
    return {
      ok: false,
      disabled: !!(j?.disabled) || res.status === 404,
      error: j?.error || (res.status === 404 ? '呢個部署冇 /api/auth' : `核對失敗（HTTP ${res.status}）`),
      hint: j?.hint || ''
    };
  } catch (e) {
    return { ok: false, error: e?.message || '連唔到核對服務', hint: '' };
  }
}
export const RESERVED_USERNAMES = ['sheep', 'super', 'admin', 'system'];
/** 同進度追蹤（vsbadge）睇齊：新帳戶／團員初始密碼，首次登入強制改 */
export const TEMP_PASSWORD = '1234';
export function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}
export function validLoginId(s) {
  const u = String(s || '').trim();
  if (looksLikeEmail(u)) return true;
  return /^[A-Za-z0-9._-]{2,}$/.test(u);
}

/* ============================================================
   權限矩陣
   ============================================================ */
export const PERMS = {
  /* 會議 */
  'meeting.view':   { super: 1, leader: 1, exco: 1 },
  'meeting.create': { super: 1, leader: 1, exco: 1 },
  'meeting.edit':   { super: 1, leader: 1, exco: 'own' },
  'meeting.delete': { super: 1, leader: 1, exco: 0 },
  'meeting.minutes':{ super: 1, leader: 1, exco: 1 },
  'meeting.approve':{ super: 1, leader: 1, exco: 1 },

  /* 財務 */
  'finance.view':   { super: 1, leader: 1, exco: 1 },
  'finance.create': { super: 1, leader: 1, exco: 1 },
  'finance.edit':   { super: 1, leader: 1, exco: 'own' },
  'finance.delete': { super: 1, leader: 1, exco: 0 },
  'finance.report': { super: 1, leader: 1, exco: 1 },
  'finance.export': { super: 1, leader: 1, exco: 1 },
  'claim.submit':   { super: 1, leader: 1, exco: 1 },
  'claim.review':   { super: 1, leader: 1, exco: 1 },

  /* 團費 */
  'fee.view':       { super: 1, leader: 1, exco: 1 },
  'fee.mark':       { super: 1, leader: 1, exco: 1 },
  'fee.edit':       { super: 1, leader: 1, exco: 0 },

  /* 用戶（團長 / 領袖 / 執委 / 團員 名冊）—— 執委可以改資料，但改身份要有權 */
  'member.view':    { super: 1, leader: 1, exco: 1 },
  'member.create':  { super: 1, leader: 1, exco: 1 },
  'member.edit':    { super: 1, leader: 1, exco: 1 },
  'member.note':    { super: 1, leader: 1, exco: 1 },
  'member.delete':  { super: 1, leader: 1, exco: 0 },
  'member.export':  { super: 1, leader: 1, exco: 1 },

  /* 物資（能登入嘅都可以批核／借還） */
  'inv.view':       { super: 1, leader: 1, exco: 1 },
  'inv.manage':     { super: 1, leader: 1, exco: 1 },
  'inv.borrow':     { super: 1, leader: 1, exco: 1 },
  'inv.approve':    { super: 1, leader: 1, exco: 1 },
  'inv.audit':      { super: 1, leader: 1, exco: 1 },

  /* 行事曆／試卷 */
  'calendar.view':  { super: 1, leader: 1, exco: 1 },
  'calendar.edit':  { super: 1, leader: 1, exco: 1 },
  'quiz.view':      { super: 1, leader: 1, exco: 1 },
  'quiz.edit':      { super: 1, leader: 1, exco: 1 },

  /* 進度系統 */
  'progress.view':  { super: 1, leader: 1, exco: 1 },
  'progress.tick':  { super: 1, leader: 1, exco: 1 },   // 直接勾進度（寫入旅團自己嘅後端）
  'progress.config':{ super: 1, leader: 1, exco: 0 },

  /* 通告 */
  'notice.view':    { super: 1, leader: 1, exco: 1 },
  'notice.create':  { super: 1, leader: 1, exco: 1 },
  'notice.edit':    { super: 1, leader: 1, exco: 1 },
  'notice.publish': { super: 1, leader: 1, exco: 1 },
  'notice.signup':  { super: 1, leader: 1, exco: 1 },

  /* 表格設計 / 同步 */
  'table.view':     { super: 1, leader: 1, exco: 1 },
  'table.design':   { super: 1, leader: 1, exco: 0 },
  'table.sync':     { super: 1, leader: 1, exco: 0 },

  /* 團章 */
  'constitution.view':    { super: 1, leader: 1, exco: 1 },
  'constitution.edit':    { super: 1, leader: 1, exco: 0 },
  'constitution.publish': { super: 1, leader: 1, exco: 0 },

  /* 系統 */
  'admin.view':       { super: 1, leader: 1, exco: 1 },
  'admin.accounts':   { super: 1, leader: 1, exco: 0 },   // 開／刪帳戶
  'admin.pw.self':    { super: 1, leader: 1, exco: 1 },
  'admin.pw.leader':  { super: 1, leader: 'self', exco: 0 },
  'admin.pw.exco':    { super: 1, leader: 1, exco: 'self' },
  'admin.pw.super':   { super: 0, leader: 0, exco: 0 },   // 冇人可以改超管密碼
  'admin.data':       { super: 1, leader: 1, exco: 0 },
  'admin.units':      { super: 1, leader: 1, exco: 0 },
  'docs.view':        { super: 1, leader: 1, exco: 1 }
};

/* ============================================================
   ★ 團長（chief）權限 = 領袖嘅全部 ＋ 團長專屬
   ------------------------------------------------------------
   用「複製領袖」而唔係逐條抄一次，係因為漏一條就等於團長無故少一個權
   （而且將來加新權限都會自動跟到）。下面先複製，再用專屬規則覆蓋。
   ============================================================ */
Object.keys(PERMS).forEach(k => {
  if (PERMS[k].chief === undefined) PERMS[k].chief = PERMS[k].leader ?? 0;
});

/* ---- 團長專屬 / 覆蓋 ---- */
/** 轉移團長身份（只有現任團長同超管） */
PERMS['admin.chief'] = { super: 1, chief: 1, leader: 0, exco: 0 };
/** 改別人嘅身份（＝改權限）。2026-09-24 團長定案：靠改身份做權限變更，
 *  所以呢個權唔可以人人有 —— 團長／領袖先有，執委冇。 */
PERMS['member.identity'] = { super: 1, chief: 1, leader: 1, exco: 0 };
/** 團長可以改任何領袖／執委嘅密碼（同超管一樣，但改唔到超管） */
PERMS['admin.pw.leader'] = { super: 1, chief: 1, leader: 'self', exco: 0 };
PERMS['admin.accounts'] = { super: 1, chief: 1, leader: 1, exco: 0 };

export const PERM_GROUPS = [
  { title: '會議', items: [['meeting.view', '查看會議'], ['meeting.create', '新增會議'], ['meeting.edit', '編輯會議'], ['meeting.delete', '刪除會議'], ['meeting.minutes', '記錄 / 點名'], ['meeting.approve', '確認 / 通過']] },
  { title: '財務', items: [['finance.view', '查看帳目'], ['finance.create', '新增收支'], ['finance.edit', '編輯收支'], ['finance.delete', '刪除收支'], ['finance.report', '年結 / 月結報表'], ['finance.export', '輸出 Word / PDF / CSV'], ['claim.submit', '提交收支申報'], ['claim.review', '批核申報']] },
  { title: '團費', items: [['fee.view', '查看收費'], ['fee.mark', '標記收款'], ['fee.edit', '增刪收費項目']] },
  { title: '用戶（團長／領袖／執委／團員）', items: [['member.view', '查看用戶名冊'], ['member.create', '新增用戶'], ['member.edit', '編輯資料 / 生日'], ['member.identity', '改身份（＝改權限）'], ['member.note', '撰寫備註'], ['member.delete', '刪除用戶'], ['member.export', '輸出名冊及生日表'], ['admin.chief', '轉移團長身份（每團一位）']] },
  { title: '物資', items: [['inv.view', '查看物資'], ['inv.manage', '新增 / 修改物資'], ['inv.borrow', '申請借用'], ['inv.approve', '批核借用 / 歸還'], ['inv.audit', '盤點調整庫存']] },
  { title: '通告', items: [['notice.view', '查看通告'], ['notice.create', '開新通告'], ['notice.edit', '編輯通告'], ['notice.publish', '發布 / 分享'], ['notice.signup', '睇報名紀錄']] },
  { title: '欄位與同步', items: [['table.view', '查看欄位設計'], ['table.design', '改欄位 / 加欄位（各分頁「欄位」掣）'], ['table.sync', '設定總表同步（帳號與系統 → 資料管理）']] },
  { title: '行事曆／試卷', items: [['calendar.view', '查看活動行事曆'], ['calendar.edit', '新增／編輯活動同點名'], ['quiz.view', '查看試卷'], ['quiz.edit', '新設／匯入試卷']] },
  { title: '進度系統', items: [['progress.view', '睇團員進度（直接讀取）'], ['progress.tick', '勾選 / 取消進度'], ['progress.config', '設定後端網址同 API Key']] },
  { title: '團章', items: [['constitution.view', '閱讀團章'], ['constitution.edit', '編輯條文'], ['constitution.publish', '發布新版本 / 輸出']] },
  { title: '系統', items: [['admin.view', '開啟管理頁'], ['admin.accounts', '管理個人帳戶 / 設定密碼'], ['admin.pw.self', '改自己密碼'], ['admin.pw.leader', '改領袖密碼'], ['admin.pw.exco', '改執委密碼'], ['admin.pw.super', '改超管密碼（一律禁止）'], ['admin.data', '備份 / 還原資料'], ['admin.units', '旅團設定']] }
];

/* ============================================================
   密碼雜湊（SHA-256 + 鹽）
   ============================================================ */
export async function sha256Hex(text) {
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // 後備（非安全情境／舊瀏覽器）：簡單雜湊，唔會用嚟做真實加密
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'fallback' + (h >>> 0).toString(16).padStart(8, '0');
}
function makeSalt(role, username) {
  return 'v82:' + role + ':' + String(username).trim().toLowerCase() + ':' + Math.random().toString(36).slice(2, 8);
}
export async function hashPassword(password, salt) {
  return { algo: 'sha256', salt, hash: await sha256Hex(salt + '::' + String(password)) };
}
async function verifyPassword(acc, password) {
  if (!acc) return false;
  if (acc.pw?.hash) return (await sha256Hex(acc.pw.salt + '::' + String(password))) === acc.pw.hash;
  if (acc.password) {   // 舊格式（明文）：驗證成功後自動升級為雜湊
    if (String(acc.password) === String(password)) {
      acc.pw = await hashPassword(password, makeSalt(acc.role, acc.username));
      delete acc.password;
      commitCritical('auth');
      return true;
    }
    return false;
  }
  return false;
}

export function passwordProblem(pw, { min = 4, forbidTemp = false } = {}) {
  const s = String(pw || '');
  if (s.length < min) return `密碼至少需要 ${min} 個字元`;
  if (/^\s|\s$/.test(s)) return '密碼前後唔可以有空格';
  if (forbidTemp && s === TEMP_PASSWORD) return `唔可以繼續用預設密碼 ${TEMP_PASSWORD}，請設一個新密碼`;
  return '';
}

/* ============================================================
   登入 / 登出
   ============================================================ */
/* 註：呢度以前有個 `isSuperCredential(username, password)`，
   入面寫死咗超管密碼，而且**全 repo 一個 caller 都冇** —— 死碼兼後門。
   2026-09-20 已刪除。超管核對而家只有一條路：api/auth.js（伺服器端）。
   tests/api.mjs 會掃描成個 assets/ 確保冇任何超管秘密返嚟。 */

/**
 * 登入。role 為登入頁揀選嘅身份（leader / exco），
 * 但只要輸入超管帳號密碼，任何情況下都會直接進入超管。
 */
export async function verifyPwRecord(rec, password, { role = 'member', username = '' } = {}) {
  return verifyPassword({ pw: rec?.pw || rec?.hubPw, password: rec?.password || rec?.hubPassword, role, username }, password);
}

function memberByYmis(ymis) {
  const y = String(ymis || '').trim();
  return collection('members').find(x => String(x.ymis || '').trim() === y && x.status !== 'alumni') || null;
}

/* ============================================================
   ★ 個人身份登入（2026-09-24 團長定案）
   ------------------------------------------------------------
   一個入口：**打自己嘅登入代號 ＋ 密碼**。
     登入代號（同一條路，唔使揀身份）：
       電郵（團長／領袖）→ 自訂帳號 loginId → YMIS（執委／團員）
     入到去嘅權限＝佢喺名冊嘅身份（改身份＝改權限）。
     團員會去團員入口（members.html），其餘（團長／領袖／執委）入管理系統。
   ★ 冇「領袖共用帳戶」／「執行委員會帳號」：共用帳號＝冇人知邊個做過乜，
     而且呢個設計根本冇位放佢哋（見 store.js migrateSharedAccounts）。
   ============================================================ */

/** 登入代號 → 名冊紀錄（email／loginId／ymis 都認，大小寫唔拘） */
export function memberForLogin(id) {
  return membersByLogin(id);
}
function membersByLogin(id) {
  const k = String(id || '').trim().toLowerCase();
  if (!k) return null;
  return collection('members').find(m => m.status !== 'alumni' &&
    [m.email, m.loginId, m.ymis].some(v => String(v || '').trim().toLowerCase() === k)) || null;
}

/** 名冊身份 → session 角色（未知／空白一律當團員） */
function roleOfMember(m) {
  const k = m?.identity;
  return (k === 'chief' || k === 'leader' || k === 'exco') ? k : 'member';
}

/** 建立 session（團長／領袖／執委／團員共用；accountId 一律 'member:<id>'） */
function sessionForMember(m, { mustChangePw = false, via = 'roster' } = {}) {
  const role = roleOfMember(m);
  setSession({
    role,
    accountId: 'member:' + m.id,
    username: String(m.ymis || m.email || m.loginId || m.id).trim(),
    email: m.email || '', name: m.name, memberId: m.id, identity: role,
    at: Date.now(), mustChangePw, via
  });
  auditLogin(m.name || m.ymis || m.id, `${ROLES[role]?.name || role}（個人）登入`);
  return { ok: true, role, member: m, mustChangePw, dest: role === 'member' ? 'hub' : 'staff' };
}

/**
 * 個人登入：電郵／自訂帳號／YMIS ＋ 密碼。
 * 名冊有紀錄但未設密碼 → 首次用 1234 入（入去強制改）。
 */
export async function loginIdentity(id, password) {
  const raw = String(id || '').trim();
  const p = String(password || '');
  if (!raw) return { ok: false, msg: '請輸入電郵（團長／領袖）或 YMIS 會籍編號（執委／團員）' };
  if (!p) return { ok: false, msg: '請輸入密碼' };
  const m = membersByLogin(raw);
  if (!m) return { ok: false, msg: '電郵／YMIS 或密碼不正確', notFound: true };

  const role = roleOfMember(m);
  const isAdult = role === 'chief' || role === 'leader';
  const hasPw = !!(m.hubPw?.hash || m.hubPassword);
  if (!hasPw) {
    /* ★ 兩條路（安全考慮，唔可以一刀切）：
       · 團員／執委（青少年）：名冊有個名＝當已開戶，首次密碼 1234（同進度追蹤一致），入去強制改。
       · 團長／領袖（成人）：**唔可以**用 1234 自出自入（知道電郵就可以做領袖＝大漏洞），
         一定要由團長／領袖喺「用戶」頁幫佢設密碼。 */
    if (isAdult) {
      return { ok: false, msg: `呢位${ROLES[role]?.name || '領袖'}仲未設定密碼 —— 請團長／領袖喺「用戶與身份」幫佢設定登入密碼` };
    }
    if (p !== TEMP_PASSWORD) {
      return { ok: false, msg: `電郵／YMIS 或密碼不正確（未設定過密碼嘅話，首次密碼係 ${TEMP_PASSWORD}）` };
    }
    m.hubOpened = true;
    m.hubMustChangePw = true;
    commitCritical('auth');
  } else {
    const fake = { pw: m.hubPw, password: m.hubPassword, role, username: raw };
    if (!(await verifyPassword(fake, p))) return { ok: false, msg: '電郵／YMIS 或密碼不正確' };
    if (fake.pw && m.hubPassword) {
      m.hubPw = fake.pw;
      delete m.hubPassword;
      commitCritical('auth');
    }
  }
  const mustChangePw = !!m.hubMustChangePw || p === TEMP_PASSWORD;
  return sessionForMember(m, { mustChangePw, via: isAdult ? 'email' : 'ymis' });
}

/** 團員入口（members.html）用：一樣行個人身份登入 */
export async function loginMember(ymis, password) {
  return loginIdentity(ymis, password);
}

/* 團長查詢交畀 model.js（單一來源）：chief() / hasChief() */

/** 後台開戶（單個／批量）：設首次密碼 1234，要改 */
export async function openMemberAccount(memberId) {
  return setMemberHubPassword(memberId, TEMP_PASSWORD, { mustChange: true });
}

export function applyAccount({ ymis, name, email = '', note = '' }) {
  const y = String(ymis || '').trim();
  const n = String(name || '').trim();
  if (!/^\d{10}$/.test(y)) return { ok: false, msg: 'YMIS 須為 10 位數字' };
  if (!n) return { ok: false, msg: '請填姓名' };
  const roster = memberByYmis(y);
  if (roster && String(roster.name || '').replace(/\s/g, '') !== n.replace(/\s/g, '') &&
      String(roster.name || '') !== n) {
    /* 名冊有人但姓名唔對 —— 仍然收申請，批核時見到兩邊 */
  }
  if (roster?.hubOpened || roster?.hubPw?.hash) return { ok: false, msg: '呢個 YMIS 已經開咗戶，請直接登入' };
  if (collection('accountApps').some(a => a.ymis === y && a.status === 'pending')) {
    return { ok: false, msg: '已經有待批申請' };
  }
  add('accountApps', {
    ymis: y, name: n, email: String(email || '').trim(), note: String(note || '').trim(),
    rosterId: roster?.id || '', rosterName: roster?.name || '',
    status: 'pending', at: new Date().toISOString()
  });
  audit('申請開戶', y + ' ' + n);
  return { ok: true };
}

export async function reviewAccountApp(appId, { decision, reviewer = '' } = {}) {
  const rec = find('accountApps', appId);
  if (!rec || rec.status !== 'pending') return { ok: false, msg: '搵唔到待批申請' };
  rec.status = decision === 'approved' ? 'approved' : 'rejected';
  rec.reviewedAt = new Date().toISOString();
  rec.reviewedBy = reviewer;
  commitCritical('auth');
  if (rec.status !== 'approved') {
    audit('拒絕開戶申請', rec.ymis);
    return { ok: true };
  }
  let m = rec.rosterId ? find('members', rec.rosterId) : memberByYmis(rec.ymis);
  if (!m) {
    m = add('members', {
      name: rec.name, ymis: rec.ymis, email: rec.email || '', identity: 'member', status: 'active'
    });
  }
  const pw = await setMemberHubPassword(m.id, TEMP_PASSWORD, { mustChange: true });
  if (!pw.ok) return pw;
  audit('批准開戶', rec.ymis);
  return { ok: true, member: m, tempPassword: TEMP_PASSWORD };
}

/** 開團 KEY：由旅團 Apps Script 執行 issueSetupKey() 產生，72 小時有效 */
export async function loginSetupKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, msg: '請貼上開團 KEY' };
  const unit = (await import('./store.js')).currentUnit?.() || '';
  let json = null;
  try {
    const res = await fetch('./api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verifySetupKey', unit, key: k })
    });
    json = await res.json();
  } catch {
    return { ok: false, msg: '連唔到後端。請確認旅團已登記，同埋 Apps Script 已更新（有 issueSetupKey）' };
  }
  if (!(json?.ok || json?.success)) return { ok: false, msg: json?.error || 'KEY 無效或已過期' };
  setSession({
    role: 'leader', accountId: 'setup', username: '', name: '開團設定',
    at: Date.now(), setupKey: true, mustChangePw: false
  });
  auditLogin('setup-key', '開團 KEY 登入');
  return { ok: true, role: 'leader', setup: true };
}

export async function setMemberHubPassword(memberId, newPassword, { mustChange = null } = {}) {
  const m = find('members', memberId);
  if (!m) return { ok: false, msg: '搵唔到呢位用戶' };
  const force = mustChange == null ? (String(newPassword) === TEMP_PASSWORD) : !!mustChange;
  const bad = passwordProblem(newPassword, { forbidTemp: !force });
  if (bad) return { ok: false, msg: bad };
  m.hubPw = await hashPassword(newPassword, makeSalt('member', m.ymis || m.id));
  delete m.hubPassword;
  m.hubPwUpdatedAt = new Date().toISOString().slice(0, 10);
  m.hubMustChangePw = force;
  m.hubOpened = true;
  commitCritical('auth');
  audit('設定團員入口密碼', m.name || memberId);
  return { ok: true };
}

/** 團員自己改密碼（首次可以唔填舊密碼） */
export async function changeMemberOwnPassword(memberId, oldPw, newPw) {
  const m = find('members', memberId);
  if (!m) return { ok: false, msg: '搵唔到呢位用戶' };
  if (!m.hubMustChangePw) {
    if (!m.hubPw?.hash && !m.hubPassword) {
      if (String(oldPw) !== TEMP_PASSWORD) return { ok: false, msg: '舊密碼唔正確' };
    } else {
      const fake = { pw: m.hubPw, password: m.hubPassword, role: 'member', username: m.ymis };
      if (!(await verifyPassword(fake, oldPw))) return { ok: false, msg: '舊密碼唔正確' };
    }
  }
  return setMemberHubPassword(memberId, newPw, { mustChange: false });
}

/** 正式支部登入：密碼由 GAS server-side authLogin 核對，瀏覽器只保存安全身份資料。 */
export async function createAccountServer(payload) {
  const s = getSession();
  if (!s?.sessionToken) return { ok: false, msg: '登入狀態已失效，請重新登入' };
  const r = await fetch('./api/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'authCreateAccount', unit:currentUnit(), ...payload, ...(s.via === 'portal' ? { portalToken:s.portalToken, portalRole:s.portalRole, actorUsername:s.username } : { sessionToken:s.sessionToken }) }) });
  const data = await r.json().catch(() => ({}));
  return r.ok && data.success !== false ? { ok:true } : { ok:false, msg:data.error || '新增帳戶失敗' };
}

export async function restoreAccountServer(target, newPassword = '1234') {
  const s = getSession();
  if (!s?.sessionToken) return { ok: false, msg: '登入狀態已失效，請重新登入' };
  const r = await fetch('./api/proxy', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'authRestoreAccount', unit:currentUnit(), targetEmail:target?.email || target?.username || '', newPassword, ...(s.via === 'portal' ? { portalToken:s.portalToken, portalRole:s.portalRole, actorUsername:s.username } : { sessionToken:s.sessionToken }) }) });
  const data = await r.json().catch(() => ({}));
  return r.ok && data.success !== false ? { ok:true } : { ok:false, msg:data.error || '復原帳戶失敗' };
}

export async function resetAccountPasswordServer(target, newPassword) {
  const s = getSession();
  if (!s?.sessionToken) return { ok: false, msg: '登入狀態已失效，請重新登入' };
  const r = await fetch('./api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'authResetPassword', unit: currentUnit(), targetUsername: target?.username || target?.email || '', newPassword: String(newPassword || ''), ...(s.via === 'portal' ? { portalToken: s.portalToken, portalRole: s.portalRole, actorUsername: s.username } : { sessionToken: s.sessionToken }) }) });
  const data = await r.json().catch(() => ({}));
  return r.ok && data.success !== false ? { ok: true } : { ok: false, msg: data.error || '重設密碼失敗' };
}

export async function loginPortalFromUrl(params = new URLSearchParams(location.search)) {
  const unit = String(params.get('u') || params.get('unit') || '').trim();
  const role = String(params.get('role') || '').trim().toLowerCase();
  const src = String(params.get('src') || '').trim();
  const subject = String(params.get('ymis') || params.get('sub') || '').trim();
  if (params.get('from') !== 'portal' || !unit || !role || !src) return { ok: false, skipped: true };
  const r = await fetch(`./api/portal?u=${encodeURIComponent(unit)}&role=${encodeURIComponent(role)}&src=${encodeURIComponent(src)}&ymis=${encodeURIComponent(subject)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok || !data.portalToken) return { ok: false, msg: data.reason || '旅系統入口驗證失敗' };
  setSession({ role: role === 'admin' ? 'leader' : role === 'exco' ? 'exco' : role, accountId: `portal:${subject || role}`, username: subject || `PORTAL-${unit}-${role}`, name: params.get('name') || '旅系統使用者', at: Date.now(), via: 'portal', portalToken: data.portalToken, portalRole: role, portalUnit: unit, mustChangePw: false });
  return { ok: true };
}

export async function deleteAccountServer(target) {
  const s = getSession();
  if (!s?.sessionToken) return { ok: false, msg: '登入狀態已失效，請重新登入' };
  const r = await fetch('./api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'authDeleteAccount', unit: currentUnit(), targetUsername: target?.username || target?.email || '', ...(s.via === 'portal' ? { portalToken: s.portalToken, portalRole: s.portalRole, actorUsername: s.username } : { sessionToken: s.sessionToken }) }) });
  const data = await r.json().catch(() => ({}));
  return r.ok && data.success !== false ? { ok: true } : { ok: false, msg: data.error || '刪除帳戶失敗' };
}

export async function loginServer(role, username, password) {
  const unit = currentUnit();
  const r = await fetch('./api/proxy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authLogin', unit, username: String(username || ''), ymis: role === 'member' ? String(username || '') : undefined, password: String(password || '') })
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok || !data?.ok) {
    /* 舊支部尚未把本機帳戶同步到新 auth action：只在「找不到後端帳戶」時保留一次舊資料遷移後備；後端明確拒絕密碼時絕不 fallback。 */
    if (data?.code === 'AUTH_ACCOUNT_NOT_FOUND') return login(role, username, password);
    return { ok: false, msg: data?.error || '帳號或密碼不正確' };
  }
  const a = data.account || {};
  const accountRole = a.role || (role === 'member' ? 'member' : 'leader');
  const dest = accountRole === 'member' ? 'hub' : 'staff';
  setSession({ role: accountRole, accountId: a.id, username: a.username, email: a.email || '', name: a.name, at: Date.now(), mustChangePw: !!data.mustChangePw, sessionToken: data.sessionToken || '', sessionExpiresAt: data.sessionExpiresAt || 0, via: 'server' });
  auditLogin(a.username || username, 'GAS server-side 登入');
  return { ok: true, role: accountRole, mustChangePw: !!data.mustChangePw, dest, member: { id: a.id, name: a.name, ymis: a.username, email: a.email, identity: accountRole } };
}

/**
 * 登入（**一個入口**）。
 *
 * ★ 2026-09-24：唔再分「領袖入口／執委入口」，亦冇共用帳戶 ——
 *   打自己嘅電郵／自訂帳號／YMIS ＋ 密碼，權限跟名冊身份。
 *   `role` 參數保留只為向後兼容（呼叫者可能傳 'staff'），實際唔會用。
 *   只要輸入超管帳號密碼，任何情況下都會直接進入超管（伺服器端核對）。
 */
export async function login(role, username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u) return { ok: false, msg: '請輸入電郵（團長／領袖）或 YMIS 會籍編號（執委／團員）' };
  if (!p) return { ok: false, msg: '請輸入密碼' };

  /* 隱藏超管：唔理揀咗邊個身份都直接登入。
     ★ 核對喺**伺服器端**做（api/auth.js）—— 呢個函數入面已經冇任何
       密碼／salt／hash 可以比對，所以靜態部署或者環境變數未設嗰陣
       係「登唔到」，唔會靜靜地放行。 */
  if (u.toLowerCase() === SUPER.username) {
    const v = await verifySuperServer(p);
    if (!v.ok) {
      if (v.disabled) {
        return { ok: false, msg: `超級管理員登入未啟用 —— ${v.error}${v.hint ? `（${v.hint}）` : ''}` };
      }
      return { ok: false, msg: v.error || '帳號或密碼不正確' };
    }
    setSession({
      role: 'super', accountId: 'super', username: '', name: SUPER.name,
      at: Date.now(), hidden: true
    });
    auditLogin('super', '超級管理員登入（伺服器端核對）');
    return { ok: true, role: 'super' };
  }

  /* ① 個人身份（名冊）—— 團長／領袖／執委／團員同一條路 */
  const person = await loginIdentity(u, p);
  if (person.ok || !person.notFound) return person;

  /* ② 舊資料庫嘅個人帳戶（2026-09-24 之前開落嘅）—— 照樣入得，
        但唔會再有「共用帳戶」：store.js 開機已經清走咗種子帳戶。 */
  const ul = u.toLowerCase();
  const acc = collection('accounts').find(a => a.active !== false && (
    String(a.username || '').toLowerCase() === ul ||
    String(a.email || '').toLowerCase() === ul
  ));
  if (!acc) return { ok: false, msg: '電郵／YMIS 或密碼不正確' };
  if (!(await verifyPassword(acc, p))) return { ok: false, msg: '電郵／YMIS 或密碼不正確' };

  const mustChangePw = !!acc.mustChangePw || !!acc.defaultPw || p === TEMP_PASSWORD;
  setSession({
    role: acc.role, accountId: acc.id, username: acc.username, email: acc.email || '',
    name: acc.name, title: acc.title || '', at: Date.now(), mustChangePw
  });
  auditLogin(acc.username, '登入（舊個人帳戶）');
  return { ok: true, role: acc.role, mustChangePw };
}

function auditLogin(who, what) {
  try { audit(what, '', who); } catch { /* 稽核失敗唔影響登入 */ }
}

export function logout() { setSession(null); }
export function current() { return getSession(); }
export function currentRole() { return getSession()?.role || null; }
export function isSuper() { return currentRole() === 'super'; }
/* ★ 2026-09-24 團長：「刪除示範資料 (MOCK) 我都在用要MOCK 幹什麼」
   → 示範模式成個拆走，isMockSession() 亦都冇存在意義。 */
export function roleInfo(role = currentRole()) { return ROLES[role] || null; }

/** 介面上顯示嘅身份名稱（超管唔會顯示帳號） */
export function displayName() {
  const s = current();
  if (!s) return '';
  if (s.role === 'super') return s.name || '系統管理員';
  return s.name || s.username || '';
}
export function displaySub() {
  const s = current();
  if (!s) return '';
  const role = ROLES[s.role]?.name || s.role;
  return s.role === 'super' ? role : `${role} · ${s.username}`;
}

/* ============================================================
   權限總表（可編輯）—— 2026-09-24 團長：「權限總表要能編輯」
   ------------------------------------------------------------
   PERMS 係**出廠預設**（寫死喺呢個檔，跟版本走）。
   旅團自己改過嘅放喺 db.permOverrides —— 跟資料庫一齊同步、跟 JSON 備份走。
   讀嘅時候 override 優先；冇 override 就用預設。
   ============================================================ */
function permOverrides() {
  try { return tryLoad()?.permOverrides || {}; } catch { return {}; }
}
/** 某個功能對某個身份嘅**實際**值（override 優先，其次出廠預設） */
export function permValue(perm, role) {
  const ov = permOverrides()[perm];
  if (ov && Object.prototype.hasOwnProperty.call(ov, role)) return ov[role];
  return (PERMS[perm] || {})[role];
}
/** 呢格係咪被旅團改過（介面顯示「已改」用） */
export function permIsCustom(perm, role) {
  const ov = permOverrides()[perm];
  return !!(ov && Object.prototype.hasOwnProperty.call(ov, role));
}
/** 呢個功能嘅可循環值（出廠用咗『自己』／『自己建立』先至會出現在循環入面） */
export function permCycle(perm) {
  const base = PERMS[perm] || {};
  const vals = Object.values(base);
  const cycle = [1, 0];
  if (vals.includes('own')) cycle.splice(1, 0, 'own');
  if (vals.includes('self')) cycle.splice(1, 0, 'self');
  return cycle;
}
/** 改一格權限（跟旅團資料庫存；只有團長／超管可以改） */
export function setPerm(perm, role, value) {
  if (!canEditPerms()) return { ok: false, msg: '只有團長可以改權限總表' };
  if (!PERMS[perm]) return { ok: false, msg: '冇呢個功能' };
  const db = load();
  db.permOverrides = { ...(db.permOverrides || {}) };
  const cur = { ...(db.permOverrides[perm] || {}) };
  const base = (PERMS[perm] || {})[role];
  if (value === base || value === undefined) delete cur[role];   // 改返預設＝刪走 override
  else cur[role] = value;
  if (Object.keys(cur).length) db.permOverrides[perm] = cur; else delete db.permOverrides[perm];
  commitCritical('perm');
  audit('更改權限', `${perm} · ${ROLES[role]?.name || role} → ${value === 1 ? '可以' : value === 0 ? '不可以' : value}`);
  return { ok: true };
}
/** 還原成出廠預設（清走晒 override） */
export function resetPerms() {
  if (!canEditPerms()) return { ok: false, msg: '只有團長可以改權限總表' };
  const db = load();
  const n = Object.keys(db.permOverrides || {}).length;
  delete db.permOverrides;
  commitCritical('perm');
  audit('還原權限總表', `清走 ${n} 項自訂`);
  return { ok: true, cleared: n };
}
/** 邊個改到權限總表：團長（每團一位，最高權限）同超管 */
export function canEditPerms() {
  const r = currentRole();
  return r === 'chief' || r === 'super';
}

export function can(perm, ctx) {
  const s = getSession();
  if (!s) return false;
  if (!PERMS[perm]) return false;
  const v = permValue(perm, s.role);
  if (v === 1) return true;
  if (v === 0 || v == null) return false;
  if (v === 'self') {
    if (!ctx) return false;
    if (ctx.accountId && s.accountId) return ctx.accountId === s.accountId;
    if (ctx.createdBy && s.username) return ctx.createdBy === s.username;
    return false;
  }
  if (v === 'own') {
    return !!(ctx && ((ctx.createdBy && ctx.createdBy === s.username) || (ctx.chair && ctx.chair === s.username) || (ctx.requestedBy && ctx.requestedBy === s.username)));
  }
  return false;
}

/* ============================================================
   帳戶管理
   ============================================================ */
/** 所有可見帳戶（永遠唔包括超管） */
export function accounts({ role = null, active = null } = {}) {
  let list = collection('accounts').slice();
  if (role) list = list.filter(a => a.role === role);
  if (active !== null) list = list.filter(a => (a.active !== false) === active);
  return list.sort((a, b) => (ROLES[a.role]?.level || 0) - (ROLES[b.role]?.level || 0) || String(a.name).localeCompare(String(b.name)));
}
export function accountById(id) { return find('accounts', id); }

/** 我係唔係可以改呢個帳戶（密碼／帳號名）
 *  ★ 2026-09-24：而家「帳戶」＝名冊入面嘅個人紀錄（accountId = 'member:<id>'）。
 *    規則（見頂部註釋）：自己永遠改得；團長改得任何人（超管除外）；
 *    領袖改自己＋執委／團員；執委只改自己。舊個人帳戶（accounts）照樣行舊規則。 */
export function canChangePasswordOf(accountId) {
  const s = getSession();
  if (!s) return false;
  if (accountId === 'super') return false;                 // 超管密碼冇人改得
  const sid = String(accountId || '');
  const isSelf = s.accountId === accountId;
  if (s.role === 'super') return true;
  if (sid.startsWith('member:')) {
    const m = find('members', sid.slice('member:'.length));
    if (!m) return false;
    if (isSelf) return true;
    if (s.role === 'chief') return true;                   // 團長：全團都可以改（超管除外）
    if (s.role === 'leader') return m.identity !== 'chief' && m.identity !== 'leader';
    return false;
  }
  const acc = accountById(accountId);
  if (!acc) return false;
  if (s.role === 'chief') return true;
  if (s.role === 'leader') return isSelf || acc.role === 'exco';
  if (s.role === 'exco') return isSelf;                    // 執委只可改自己
  return false;
}

/* ============================================================
   ★ 身份（＝權限）管理（2026-09-24）
   ------------------------------------------------------------
   團長定案：「唔設執行委員會帳號，透過改身份嚟做權限變更」。
   所以身份一定要改得到，但唔可以亂改：
     · 團長／領袖／超管可以改身份（改人嘅身份 = 改人嘅權限）
     · 執委唔可以改身份（只可以改資料）
     · 「團長」唔可以用下拉改 —— 只可以由現任團長／超管**轉移**（每團一位）
     · 唔可以改自己嘅身份（免得自己鎖死自己）
   ============================================================ */

/** 可以改呢位用戶嘅身份嗎？（團長身份要另外用 admin.chief 權限轉移） */
export function canSetIdentityOf(target) {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'super' || s.role === 'chief') return true;
  if (s.role !== 'leader') return false;
  const ident = String(target?.identity || '');
  return ident !== 'chief';                 // 領袖改唔到團長
}

/** 改身份（＝改權限）。identity: chief | leader | exco | member */
export async function setMemberIdentity(memberId, identity) {
  const m = find('members', memberId);
  if (!m) return { ok: false, msg: '搵唔到呢位用戶' };
  const want = String(identity || '').trim();
  if (!['chief', 'leader', 'exco', 'member'].includes(want)) return { ok: false, msg: '身份唔正確' };
  const s = getSession();
  const before = m.identity || 'member';
  if (before === want) return { ok: true, member: m, unchanged: true };

  if (want === 'chief') {
    if (!can('admin.chief')) return { ok: false, msg: '團長身份只有現任團長（或者超管）可以轉移 —— 請現任團長交棒' };
    const cur = chiefRecord();
    if (cur && cur.id !== m.id) {
      cur.identity = 'leader';
      audit('轉移團長身份', `${cur.name} → ${m.name}`);
    } else {
      audit('設定團長身份', m.name || m.id);
    }
    m.identity = 'chief';
    m.chiefSince = new Date().toISOString().slice(0, 10);
  } else {
    if (m.identity === 'chief' && s?.role !== 'super') {
      return { ok: false, msg: '團長身份唔可以直接改低 —— 要先去交棒嗰位嘅用戶頁撳「設為團長（轉移）」，你嘅身份就會自動變返領袖' };
    }
    if (s?.memberId && s.memberId === m.id && s.role !== 'super') {
      return { ok: false, msg: '唔可以改自己嘅身份（免得自己鎖死自己）—— 請另一位領袖／團長幫你改' };
    }
    if (!canSetIdentityOf(m)) return { ok: false, msg: '你冇權限更改呢位用戶嘅身份' };
    m.identity = want;
    delete m.chiefSince;
    audit('更改身份', `${m.name || m.id}：${IDENTITY_LABEL[before] || before} → ${IDENTITY_LABEL[want] || want}`);
  }
  commitCritical('auth');
  /* 改嘅係自己（例如團長交棒畀人之後自己變領袖）→ 即刻更新 session，唔使重新登入 */
  if (s?.memberId && s.memberId === m.id) {
    setSession({ ...s, role: m.identity, identity: m.identity });
  }
  return { ok: true, member: m };
}

const IDENTITY_LABEL = { chief: '團長', leader: '領袖', exco: '執委', member: '團員' };

/** 轉移團長身份（現任團長交棒） */
export async function transferChief(toMemberId) {
  return setMemberIdentity(toMemberId, 'chief');
}

/* ---------- 開戶 = 第一個設定嗰位係團長 ---------- */

/** 而家可唔可以認領團長身份？（仲未有團長；而且係開團 KEY／超管／已登入嘅領袖） */
export function canClaimChief() {
  if (hasChief()) return false;
  const s = getSession();
  if (!s) return false;
  return s.role === 'super' || s.role === 'chief' || s.role === 'leader' || !!s.setupKey;
}

/**
 * 認領團長身份（開戶那個 = 團長）。
 * @param {{name?:string,email?:string,password?:string,ymis?:string,loginId?:string,role?:string}} info
 */
export async function claimChief(info = {}) {
  if (hasChief()) return { ok: false, msg: '已經有團長 —— 要換人請由現任團長用「設為團長（轉移）」' };
  if (!canClaimChief()) return { ok: false, msg: '要由團長／領袖（或者用開團 KEY）先可以設定團長' };
  const s = getSession();
  let m = s?.memberId ? find('members', s.memberId) : null;
  if (!m) {
    const name = String(info.name || '').trim();
    if (!name) return { ok: false, msg: '請填姓名' };
    m = add('members', {
      name, identity: 'chief', status: 'active',
      email: String(info.email || '').trim(),
      loginId: String(info.loginId || '').trim(),
      ymis: String(info.ymis || '').trim(),
      role: String(info.role || '團長').trim(),
      hubOpened: true
    });
  } else {
    m.identity = 'chief';
    if (info.email != null && String(info.email).trim()) m.email = String(info.email).trim();
    if (info.loginId != null && String(info.loginId).trim()) m.loginId = String(info.loginId).trim();
    if (info.ymis != null && String(info.ymis).trim()) m.ymis = String(info.ymis).trim();
    if (!m.role) m.role = '團長';
  }
  m.chiefSince = new Date().toISOString().slice(0, 10);
  if (info.password) {
    const pw = await setMemberHubPassword(m.id, String(info.password));
    if (!pw.ok) return pw;
  }
  commitCritical('auth');
  audit('設定團長身份', m.name || m.id);
  if (s && (!s.memberId || s.memberId === m.id)) {
    setSession({ ...s, role: 'chief', identity: 'chief', memberId: m.id, accountId: 'member:' + m.id, name: m.name, mustChangePw: false, setupKey: false });
  }
  return { ok: true, member: m };
}

/** 我係唔係可以開／刪呢個角色嘅帳戶 */
export function canManageRole(role) {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'super') return role === 'chief' || role === 'leader' || role === 'exco';
  if (s.role === 'chief') return role === 'leader' || role === 'exco';
  if (s.role === 'leader') return role === 'exco';
  return false;
}

export async function createAccount({ role, username, password, name, title = '', memberId = '', email = '' }) {
  if (!canManageRole(role)) return { ok: false, msg: '你冇權限新增呢個角色嘅帳戶' };
  const mail = String(email || (looksLikeEmail(username) ? username : '')).trim().toLowerCase();
  const u = String(username || mail || '').trim();
  if (u.length < 2) return { ok: false, msg: role === 'leader' ? '請填電郵' : '帳號至少 2 個字元' };
  if (!validLoginId(u)) return { ok: false, msg: '請用電郵，或英文／數字／. _ -' };
  if (RESERVED_USERNAMES.includes(u.toLowerCase())) return { ok: false, msg: '此帳號名稱已保留' };
  if (collection('accounts').some(a =>
    a.username.toLowerCase() === u.toLowerCase() ||
    (mail && String(a.email || '').toLowerCase() === mail))) {
    return { ok: false, msg: '此電郵／帳號已被使用' };
  }
  const pw = String(password || TEMP_PASSWORD);
  const bad = passwordProblem(pw);
  if (bad) return { ok: false, msg: bad };
  const salt = makeSalt(role, u);
  const rec = add('accounts', {
    role, username: u, email: mail, name: String(name || '').trim() || u, title: String(title || '').trim(),
    memberId, active: true, pw: await hashPassword(pw, salt),
    mustChangePw: pw === TEMP_PASSWORD,
    defaultPw: pw === TEMP_PASSWORD,
    pwUpdatedAt: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString().slice(0, 10),
    createdBy: getSession()?.username || 'super'
  });
  audit('新增帳戶', `${ROLES[role]?.name || role}：${u}`);
  return { ok: true, account: rec, tempPassword: pw === TEMP_PASSWORD ? TEMP_PASSWORD : '' };
}

export async function changePassword(accountId, newPassword) {
  if (accountId === 'super') return { ok: false, msg: '超級管理員密碼係固定嘅，任何人都唔可以更改' };
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canChangePasswordOf(accountId)) return { ok: false, msg: '你冇權限更改此帳戶嘅密碼' };
  const bad = passwordProblem(newPassword, { forbidTemp: true });
  if (bad) return { ok: false, msg: bad };
  acc.pw = await hashPassword(newPassword, makeSalt(acc.role, acc.username));
  delete acc.password;
  acc.defaultPw = false;
  acc.mustChangePw = false;
  acc.pwUpdatedAt = new Date().toISOString().slice(0, 10);
  commitCritical('auth');
  audit('更改密碼', `${ROLES[acc.role]?.name || acc.role}：${acc.username}`);
  if (getSession()?.accountId === accountId) {
    const s = getSession(); s.pwChangedAt = Date.now(); s.mustChangePw = false; setSession(s);
  }
  return { ok: true };
}

/** 改自己密碼（要輸入舊密碼） */
export async function changeOwnPassword(oldPw, newPw) {
  const s = getSession();
  if (!s || s.role === 'super') return { ok: false, msg: '超管密碼唔可以更改' };
  /* 名冊領袖（喺「用戶」頁開、用電郵入口入嚟）：密碼擺喺名冊 hubPw，唔喺 accounts */
  if (String(s.accountId || '').startsWith('member:')) {
    const m = find('members', String(s.accountId).slice('member:'.length));
    if (!m) return { ok: false, msg: '搵唔到帳戶' };
    if (!s.mustChangePw && !m.hubMustChangePw) {
      const fake = { pw: m.hubPw, password: m.hubPassword, role: 'leader', username: m.ymis || m.email };
      if (!(await verifyPassword(fake, oldPw))) return { ok: false, msg: '舊密碼唔正確' };
    }
    return setMemberHubPassword(m.id, newPw, { mustChange: false });
  }
  const acc = accountById(s.accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!s.mustChangePw && !acc.mustChangePw) {
    if (!(await verifyPassword(acc, oldPw))) return { ok: false, msg: '舊密碼唔正確' };
  }
  return changePassword(acc.id, newPw);
}

export function changeUsername(accountId, newUsername) {
  if (accountId === 'super') return { ok: false, msg: '超管帳號唔可以更改' };
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canChangePasswordOf(accountId)) return { ok: false, msg: '你冇權限更改此帳戶' };
  const u = String(newUsername || '').trim();
  if (u.length < 2) return { ok: false, msg: '帳號至少 2 個字元' };
  if (!validLoginId(u)) return { ok: false, msg: '請用電郵，或英文／數字／. _ -' };
  if (looksLikeEmail(u)) acc.email = u.toLowerCase();
  if (RESERVED_USERNAMES.includes(u.toLowerCase())) return { ok: false, msg: '此帳號名稱已保留' };
  if (collection('accounts').some(a => a.id !== accountId && a.username.toLowerCase() === u.toLowerCase())) {
    return { ok: false, msg: '此帳號名稱已被使用' };
  }
  acc.username = u;
  commitCritical('auth');
  if (getSession()?.accountId === accountId) { const s = getSession(); s.username = u; setSession(s); }
  audit('更改登入帳號', u);
  return { ok: true };
}

export function setAccountActive(accountId, active) {
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canChangePasswordOf(accountId)) return { ok: false, msg: '你冇權限' };
  if (getSession()?.accountId === accountId && !active) return { ok: false, msg: '唔可以停用自己嘅帳戶' };
  acc.active = !!active;
  commitCritical('auth');
  audit(active ? '啟用帳戶' : '停用帳戶', acc.username);
  return { ok: true };
}

export function deleteAccount(accountId) {
  if (accountId === 'super') return { ok: false, msg: '超管帳戶唔可以刪除' };
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canManageRole(acc.role)) return { ok: false, msg: '你冇權限刪除此帳戶' };
  if (getSession()?.accountId === accountId) return { ok: false, msg: '唔可以刪除自己嘅帳戶' };
  remove('accounts', accountId);
  audit('刪除帳戶', acc.username);
  return { ok: true };
}

/** 標示「我」係邊個帳戶（介面顯示用） */
export function isMe(accountId) { return getSession()?.accountId === accountId; }
