/* ============================================================
   auth.js — 身份、權限、密碼規則

   登入身份只有兩種（＋一個隱藏帳戶）：
     leader  領袖
     exco    執行委員會
     super   超級管理員 —— 隱藏：唔會顯示喺任何名單，
             只可以用指定帳號／密碼登入，任何人（包括超管自己）
             都唔可以改佢個密碼。

   密碼權限（依實際需要）：
     超管：可改領袖、執委嘅密碼
     領袖：可改自己、執委嘅密碼
     執委：只可改自己嘅密碼
   ============================================================ */

import {
  load, commit, collection, find, add, remove, getSession, setSession, audit, isMock, currentUnit
} from './store.js';

export const ROLES = {
  super: {
    id: 'super', name: '超級管理員', short: '超管', color: '#4A111C', level: 3, hidden: true,
    desc: '系統擁有者（隱藏帳戶）'
  },
  leader: {
    id: 'leader', name: '領袖', short: '領袖', color: '#7B2233', level: 2,
    desc: '團領袖／支部領袖 —— 管理團務、財務、團章、物資'
  },
  exco: {
    id: 'exco', name: '執行委員會', short: '執委', color: '#A83A4E', level: 1,
    desc: '執委會成員 —— 日常團務：開會、點名、記帳、借用物資'
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

  /* 用戶（領袖 / 執委 / 團員 名冊）—— 執委都可以改資料同身份 */
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

export const PERM_GROUPS = [
  { title: '會議', items: [['meeting.view', '查看會議'], ['meeting.create', '新增會議'], ['meeting.edit', '編輯會議'], ['meeting.delete', '刪除會議'], ['meeting.minutes', '記錄 / 點名'], ['meeting.approve', '確認 / 通過']] },
  { title: '財務', items: [['finance.view', '查看帳目'], ['finance.create', '新增收支'], ['finance.edit', '編輯收支'], ['finance.delete', '刪除收支'], ['finance.report', '年結 / 月結報表'], ['finance.export', '輸出 Word / PDF / CSV'], ['claim.submit', '提交收支申報'], ['claim.review', '批核申報']] },
  { title: '團費', items: [['fee.view', '查看收費'], ['fee.mark', '標記收款'], ['fee.edit', '增刪收費項目']] },
  { title: '用戶（領袖／執委／團員）', items: [['member.view', '查看用戶名冊'], ['member.create', '新增用戶'], ['member.edit', '編輯資料 / 身份 / 生日'], ['member.note', '撰寫備註'], ['member.delete', '刪除用戶'], ['member.export', '輸出名冊及生日表']] },
  { title: '物資', items: [['inv.view', '查看物資'], ['inv.manage', '新增 / 修改物資'], ['inv.borrow', '申請借用'], ['inv.approve', '批核借用 / 歸還'], ['inv.audit', '盤點調整庫存']] },
  { title: '通告', items: [['notice.view', '查看通告'], ['notice.create', '開新通告'], ['notice.edit', '編輯通告'], ['notice.publish', '發布 / 分享'], ['notice.signup', '睇報名紀錄']] },
  { title: '欄位與同步', items: [['table.view', '查看欄位設計'], ['table.design', '改欄位 / 加欄位（各分頁「欄位」掣）'], ['table.sync', '設定總表同步（帳號與系統 → 資料管理）']] },
  { title: '行事曆／試卷', items: [['calendar.view', '查看活動行事曆'], ['calendar.edit', '新增／編輯活動同點名'], ['quiz.view', '查看試卷'], ['quiz.edit', '新設／匯入試卷']] },
  { title: '進度系統', items: [['progress.view', '睇團員進度（直接讀取）'], ['progress.tick', '勾選 / 取消進度'], ['progress.config', '設定後端網址同 API Key']] },
  { title: '團章', items: [['constitution.view', '閱讀團章'], ['constitution.edit', '編輯條文'], ['constitution.publish', '發布新版本 / 輸出']] },
  { title: '系統', items: [['admin.view', '開啟管理頁'], ['admin.accounts', '新增 / 刪除帳戶'], ['admin.pw.self', '改自己密碼'], ['admin.pw.leader', '改領袖密碼'], ['admin.pw.exco', '改執委密碼'], ['admin.pw.super', '改超管密碼（一律禁止）'], ['admin.data', '備份 / 還原資料'], ['admin.units', '旅團設定']] }
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
      commit();
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

/**
 * 團員／執委同一個入口：YMIS＋密碼。
 * 權限只跟名冊 identity（換屆改名冊就換權限），唔跟獨立「執委帳戶」。
 * 領袖請用電郵入口。
 */
export async function loginMember(ymis, password) {
  const y = String(ymis || '').trim();
  const p = String(password || '');
  if (!y) return { ok: false, msg: '請輸入 YMIS 會籍編號' };
  if (!p) return { ok: false, msg: '請輸入密碼' };
  const m = memberByYmis(y);
  if (!m) return { ok: false, msg: '會籍編號或密碼不正確' };
  const ident = m.identity === 'leader' ? 'leader' : (m.identity === 'exco' ? 'exco' : 'member');
  if (ident === 'leader') {
    return { ok: false, msg: '領袖請用「領袖」入口（電郵＋密碼）登入' };
  }
  const hasPw = !!(m.hubPw?.hash || m.hubPassword);
  if (!hasPw) {
    /* 2026-09-18 團長確認：名冊有個名＝當已開戶 —— 首次用 1234 就入到
      （自動開戶，入去即刻強制改密碼）。以前要先喺後台撳「開戶」，呢步容易卡死人。 */
    if (p !== TEMP_PASSWORD) {
      return { ok: false, msg: `會籍編號或密碼不正確（未設定過密碼嘅話，首次密碼係 ${TEMP_PASSWORD}）` };
    }
    m.hubOpened = true;
    m.hubMustChangePw = true;
    commit();
  } else {
    const fake = { pw: m.hubPw, password: m.hubPassword, role: 'member', username: y };
    if (!(await verifyPassword(fake, p))) return { ok: false, msg: '會籍編號或密碼不正確' };
    if (fake.pw && m.hubPassword) {
      m.hubPw = fake.pw;
      delete m.hubPassword;
      commit();
    }
  }
  const mustChangePw = !!m.hubMustChangePw || p === TEMP_PASSWORD;
  if (ident === 'exco') {
    setSession({
      role: 'exco', accountId: 'member:' + m.id, username: m.ymis, name: m.name,
      memberId: m.id, via: 'ymis', at: Date.now(), mustChangePw
    });
    auditLogin(m.ymis, '執委（YMIS）登入');
    return { ok: true, member: m, mustChangePw, dest: 'staff', role: 'exco' };
  }
  return { ok: true, member: m, mustChangePw, dest: 'hub', role: 'member' };
}

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
  commit();
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
  commit();
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
export async function deleteAccountServer(target) {
  const s = getSession();
  if (!s?.sessionToken) return { ok: false, msg: '登入狀態已失效，請重新登入' };
  const r = await fetch('./api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'authDeleteAccount', unit: currentUnit(), targetUsername: target?.username || target?.email || '', sessionToken: s.sessionToken }) });
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

export async function login(role, username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u) return { ok: false, msg: '請輸入電郵（領袖）或登入帳號' };
  if (!p) return { ok: false, msg: '請輸入密碼' };

  /* 隱藏超管：唔理揀咗邊個身份都直接登入。
     ★ 核對喺**伺服器端**做（api/auth.js）—— 呢個函數入面已經冇任何
       密碼／salt／hash 可以比對，所以靜態部署或者環境變數未設嗰陣
       係「登唔到」，唔會靜靜地放行。 */
  if (u.toLowerCase() === SUPER.username) {
    const v = await verifySuperServer(p);
    if (!v.ok) {
      /* 「帳號或密碼不正確」同「服務未設定」要分開講 ——
         後者係管理員要去做嘢，用家再試一萬次都唔會得。 */
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

  const ul = u.toLowerCase();
  const acc = collection('accounts').find(a => a.active !== false && (
    String(a.username || '').toLowerCase() === ul ||
    String(a.email || '').toLowerCase() === ul
  ));
  if (!acc) {
    /* 2026-09-18 團長回報「開咗新領袖用戶、有電郵有密碼，但登入唔到」：
       「用戶」頁加嘅領袖只係名冊紀錄，以前一定要再喺「帳號與系統 → 帳戶」
       另開一個電郵帳戶（仲要超管先開到）—— 等於死路。
       而家：名冊入面 identity=leader、電郵對得上的，用「用戶」頁設嗰個
       入口密碼就直接入得（唔使再開第二個帳戶）。 */
    const lm = collection('members').find(x =>
      x.identity === 'leader' && x.status !== 'alumni' &&
      String(x.email || '').trim().toLowerCase() === ul);
    if (!lm) return { ok: false, msg: '電郵／帳號或密碼不正確' };
    if (!lm.hubPw?.hash && !lm.hubPassword) {
      return { ok: false, msg: '呢位領袖仲未設定密碼 —— 請喺「用戶」幫佢設定入口密碼' };
    }
    const lfake = { pw: lm.hubPw, password: lm.hubPassword, role: 'leader', username: lm.email };
    if (!(await verifyPassword(lfake, p))) return { ok: false, msg: '電郵／帳號或密碼不正確' };
    if (lfake.pw && lm.hubPassword) {
      lm.hubPw = lfake.pw;
      delete lm.hubPassword;
      commit();
    }
    const leaderMustChange = !!lm.hubMustChangePw || p === TEMP_PASSWORD;
    setSession({
      role: 'leader', accountId: 'member:' + lm.id, username: lm.email || lm.ymis || lm.id,
      email: lm.email || '', name: lm.name, memberId: lm.id, via: 'email', at: Date.now(),
      mustChangePw: leaderMustChange
    });
    auditLogin(lm.email || lm.name, '領袖（名冊）登入');
    return { ok: true, role: 'leader', mustChangePw: leaderMustChange };
  }
  /* 領袖／執委同一個入口：唔再強制揀身份，以帳戶本身角色為準 */
  if (role && role !== 'staff' && acc.role !== role) {
    return { ok: false, msg: `此帳號屬於「${ROLES[acc.role]?.name || acc.role}」，請用正確入口` };
  }
  if (!(await verifyPassword(acc, p))) return { ok: false, msg: '電郵／帳號或密碼不正確' };

  const mustChangePw = !!acc.mustChangePw || !!acc.defaultPw || p === TEMP_PASSWORD;
  setSession({
    role: acc.role, accountId: acc.id, username: acc.username, email: acc.email || '',
    name: acc.name, title: acc.title || '', at: Date.now(), mustChangePw
  });
  auditLogin(acc.username, '登入');
  return { ok: true, role: acc.role, mustChangePw };
}

function auditLogin(who, what) {
  try { audit(what, '', who); } catch { /* 稽核失敗唔影響登入 */ }
}

export function loginAsMock(role = 'leader') {
  setSession({ role, accountId: 'mock_' + role, username: 'demo-' + role, name: '示範' + (ROLES[role]?.short || ''), at: Date.now(), mock: true });
}

export function logout() { setSession(null); }
export function current() { return getSession(); }
export function currentRole() { return getSession()?.role || null; }
export function isSuper() { return currentRole() === 'super'; }
export function isMockSession() { return !!getSession()?.mock || isMock(); }
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

export function can(perm, ctx) {
  const s = getSession();
  if (!s) return false;
  const rule = PERMS[perm];
  if (!rule) return false;
  const v = rule[s.role];
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

/** 我係唔係可以改呢個帳戶（密碼／帳號名） */
export function canChangePasswordOf(accountId) {
  const s = getSession();
  if (!s) return false;
  if (accountId === 'super') return false;                 // 超管密碼冇人改得
  const acc = accountById(accountId);
  if (!acc) return false;
  if (s.role === 'super') return true;
  const isSelf = s.accountId === accountId;
  if (s.role === 'leader') return isSelf || acc.role === 'exco';
  if (s.role === 'exco') return isSelf;                    // 執委只可改自己
  return false;
}

/** 我係唔係可以開／刪呢個角色嘅帳戶 */
export function canManageRole(role) {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'super') return role === 'leader' || role === 'exco';
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
  commit();
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
  commit();
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
  commit();
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
