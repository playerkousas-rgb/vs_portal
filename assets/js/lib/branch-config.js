/* ============================================================
   branch-config.js — 本支部的身份與側欄模組定義
   ------------------------------------------------------------
   呢個檔係「支部層」設定，不係全平台共用角色清單。之後複製本系統去
   另一支部時，應建立該支部自己的 schema；唔可以把深資童軍的「執委」
   當成所有支部都有的身份。

   身份 level 由低至高。權限引擎會保證每一個高 level 至少包含所有低
   level 權限；hidden 只代表一般介面不列出（例如平台超管），不改變層級。
   ============================================================ */

export const BRANCH_SCHEMA_VERSION = 1;
export const ACTIVE_BRANCH_SCHEMA_ID = 'venture-scout';

export const BRANCH_CONFIG = Object.freeze({
  id: ACTIVE_BRANCH_SCHEMA_ID,
  section: '深資童軍',
  productName: '深資童軍管理系統',
  roles: Object.freeze([
    Object.freeze({
      id: 'member', name: '團員', short: '團員', color: '#8A6E75', level: 1,
      desc: '團員 —— 睇通告、報活動、自己的進度'
    }),
    Object.freeze({
      id: 'exco', name: '執委', short: '執委', color: '#A83A4E', level: 2,
      desc: '深資童軍執委會成員 —— 日常團務'
    }),
    Object.freeze({
      id: 'leader', name: '領袖', short: '領袖', color: '#7B2233', level: 3,
      desc: '團領袖／支部領袖 —— 管理團務、財務、團章、物資'
    }),
    Object.freeze({
      id: 'chief', name: '團長', short: '團長', color: '#B8892B', level: 4,
      singleton: true,
      desc: '團長（每團一位）—— 本支部最高管理身份'
    }),
    Object.freeze({
      id: 'super', name: '超級管理員', short: '超管', color: '#4A111C', level: 5,
      hidden: true, platform: true,
      desc: '平台擁有者（隱藏帳戶）'
    })
  ]),
  modules: Object.freeze([
    Object.freeze({ id: 'dashboard', label: '儀表板', icon: 'home', showFrom: 2, readFrom: 2, editFrom: 99 }),
    Object.freeze({ id: 'calendar', label: '行事曆', icon: 'calendar', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'quizzes', label: '試卷', icon: 'note', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'meetings', label: '會議', icon: 'clock', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'finance', label: '財務', icon: 'wallet', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'members', label: '用戶與身份', icon: 'users', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'inventory', label: '物資', icon: 'grid', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'progress', label: '進度', icon: 'chart', showFrom: 2, readFrom: 2, editFrom: 2 }),
    Object.freeze({ id: 'notices', label: '通告', icon: 'megaphone', showFrom: 2, readFrom: 2, editFrom: 2 }),
    /* 呢個係已登入團員入口／QR 管理，唔係匿名「公開資料」。 */
    Object.freeze({ id: 'links', label: '團員入口', icon: 'share', showFrom: 2, readFrom: 2, editFrom: 3 }),
    Object.freeze({ id: 'constitution', label: '團章', icon: 'book', showFrom: 2, readFrom: 2, editFrom: 3 }),
    Object.freeze({ id: 'tables', label: '資料管理', icon: 'cloud', showFrom: 3, readFrom: 3, editFrom: 3 }),
    Object.freeze({ id: 'admin', label: '系統', icon: 'shield', showFrom: 3, readFrom: 3, editFrom: 3 })
  ])
});

export const ROLE_DEFS = Object.freeze(Object.fromEntries(
  BRANCH_CONFIG.roles.map(role => [role.id, role])
));

/* Legacy/backend spellings are adapters into this branch schema, not additional
   platform identities. Every API boundary canonicalizes through this map first. */
export const BRANCH_ROLE_ALIASES = Object.freeze({
  exec_committee: 'exco',
  branch_leader: 'leader',
  group_leader: 'chief',
  admin: 'chief',
  super_admin: 'super'
});

export const SIDEBAR_MODULES = BRANCH_CONFIG.modules;
export const ACCESS_DIMENSIONS = Object.freeze(['show', 'read', 'edit']);

export function canonicalRole(role) {
  const value = String(role || '').trim().toLowerCase();
  const canonical = BRANCH_ROLE_ALIASES[value] || value;
  return ROLE_DEFS[canonical] ? canonical : '';
}
export function roleDef(role) { return ROLE_DEFS[canonicalRole(role)] || null; }
export function roleLevel(role) { return Number(roleDef(role)?.level || 0); }
export function rolesAscending({ includeHidden = true } = {}) {
  return BRANCH_CONFIG.roles
    .filter(role => includeHidden || !role.hidden)
    .slice()
    .sort((a, b) => a.level - b.level);
}
export function rolesDescending(opts) { return rolesAscending(opts).reverse(); }
export function branchIdentityIds({ includeHidden = false } = {}) {
  return rolesAscending({ includeHidden }).map(role => role.id);
}
export function moduleDef(moduleId) {
  return SIDEBAR_MODULES.find(module => module.id === String(moduleId || '')) || null;
}

/** 出廠側欄權限。數值只係本支部 schema 的預設，實際設定存於 db.accessControl。 */
export function defaultModuleGrant(module, role) {
  const def = typeof module === 'string' ? moduleDef(module) : module;
  const level = roleLevel(typeof role === 'string' ? role : role?.id);
  if (!def || !level) return { show: false, read: false, edit: false };
  return {
    show: level >= Number(def.showFrom || 99),
    read: level >= Number(def.readFrom || 99),
    edit: level >= Number(def.editFrom || 99)
  };
}

/**
 * 舊細項權限屬於邊個側欄模組。側欄 read/edit 係外層硬閘；細項權限仍可
 * 再收窄「只限本人／不可刪除」等操作。
 */
export function permissionModule(permission) {
  const p = String(permission || '');
  if (/^meeting\./.test(p)) return 'meetings';
  if (/^(finance|claim|fee)\./.test(p)) return 'finance';
  if (/^member\./.test(p) || p === 'admin.chief' || p === 'admin.accounts') return 'members';
  if (/^inv\./.test(p)) return 'inventory';
  if (/^calendar\./.test(p)) return 'calendar';
  if (/^quiz\./.test(p)) return 'quizzes';
  if (/^progress\./.test(p)) return 'progress';
  if (/^notice\./.test(p)) return 'notices';
  if (/^constitution\./.test(p)) return 'constitution';
  if (/^table\./.test(p) || p === 'admin.data') return 'tables';
  if (p === 'admin.view' || p === 'admin.units') return 'admin';
  return '';
}

export function permissionNeedsEdit(permission) {
  const p = String(permission || '');
  return !/\.(view|report|export)$/.test(p)
    && p !== 'notice.signup'
    && p !== 'table.view'
    && p !== 'progress.view';
}
