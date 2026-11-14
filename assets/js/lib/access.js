/* ============================================================
   access.js — 支部側欄「顯示／閱讀／編輯」權限
   ------------------------------------------------------------
   規則：
     1. 每個側欄項目都有三個獨立開關：show / read / edit。
     2. edit 必定包含 read；show 可獨立關閉（可讀但不在側欄出現）。
     3. 權限單調向上：低身份有的權限，高身份一定有。
     4. 操作者只可查看自己及較低身份；只可修改嚴格較低身份。

   db.accessControl 會跟支部資料庫同步。角色定義來自 branch-config.js，
   因此「執委」只屬目前深資童軍 schema，不是全平台硬編碼角色。
   ============================================================ */

import { load, tryLoad, commitCritical, getSession, audit } from './store.js';
import {
  ACCESS_DIMENSIONS, SIDEBAR_MODULES, canonicalRole, moduleDef, roleDef, roleLevel, rolesAscending
} from './branch-config.js';
import {
  ACCESS_SCHEMA_VERSION, accessInvariantErrors, blankAccessControl,
  migrateAccessControl, normalizeModuleRow, normalizedAccessControl as normalizeAccessControl
} from './access-schema.js';

const copy = value => JSON.parse(JSON.stringify(value));

/** 回傳完整、已正規化副本；不會因為純讀取而改資料庫。 */
export function normalizedAccessControl(db = tryLoad()) {
  return normalizeAccessControl(db);
}

export function moduleGrant(moduleId, role = getSession()?.role, db = tryLoad()) {
  const identity = canonicalRole(role);
  if (!moduleDef(moduleId) || !identity) return { show: false, read: false, edit: false };
  const matrix = normalizedAccessControl(db);
  return { ...matrix.modules[moduleId][identity] };
}

export function canModule(moduleId, dimension = 'read', role = getSession()?.role, db = tryLoad()) {
  if (!ACCESS_DIMENSIONS.includes(dimension)) return false;
  return moduleGrant(moduleId, role, db)[dimension] === true;
}

/** 自己＋較低身份可見；高身份欄完全不回傳畀權限介面。 */
export function visibleAccessRoles(actorRole = getSession()?.role) {
  const canonical = canonicalRole(actorRole);
  const actor = roleDef(canonical);
  if (!actor) return [];
  return rolesAscending({ includeHidden: canonical === 'super' })
    .filter(role => role.level <= actor.level)
    .sort((a, b) => b.level - a.level);
}

/** 嚴格只可改較低身份；自己一欄只供檢視繼承結果。 */
export function canManageAccessRole(targetRole, actorRole = getSession()?.role) {
  const actor = roleDef(actorRole);
  const target = roleDef(targetRole);
  return !!(actor && target && target.level < actor.level);
}

function clearAtOrBelow(row, targetLevel, dimension) {
  rolesAscending().forEach(role => {
    if (role.level <= targetLevel) row[role.id][dimension] = false;
  });
}

/**
 * 改一個側欄開關。開啟低身份時會自動向上包含；關閉某身份時會一併關閉
 * 所有較低身份，避免製造「低有、高冇」的逆序矩陣。
 */
export function setModuleGrant(moduleId, targetRole, dimension, enabled) {
  const actorRole = canonicalRole(getSession()?.role);
  targetRole = canonicalRole(targetRole);
  if (!moduleDef(moduleId)) return { ok: false, msg: '冇呢個側欄項目' };
  if (!ACCESS_DIMENSIONS.includes(dimension)) return { ok: false, msg: '權限欄位唔正確' };
  if (!canManageAccessRole(targetRole, actorRole)) {
    return { ok: false, msg: '只可以更改比自己低級的身份權限' };
  }
  const target = roleDef(targetRole);
  const db = load();
  const matrix = normalizedAccessControl(db);
  const row = matrix.modules[moduleId];
  const next = enabled === true;

  if (next) {
    row[targetRole][dimension] = true;
    if (dimension === 'edit') row[targetRole].read = true;
  } else {
    clearAtOrBelow(row, target.level, dimension);
    if (dimension === 'read') clearAtOrBelow(row, target.level, 'edit');
  }
  matrix.modules[moduleId] = normalizeModuleRow(moduleDef(moduleId), row);
  db.accessControl = matrix;
  commitCritical('perm');
  const module = moduleDef(moduleId);
  const labels = { show: '顯示欄目', read: '閱讀', edit: '編輯' };
  audit('更改側欄權限', `${module.label} · ${target.name} · ${labels[dimension]} → ${next ? '開' : '關'}`);
  return { ok: true, accessControl: copy(matrix) };
}

/** 只還原操作者可管理（較低身份）的格；自己與更高身份保持原值。 */
export function resetModuleGrants() {
  const actorRole = canonicalRole(getSession()?.role);
  const actor = roleDef(actorRole);
  if (!actor) return { ok: false, msg: '未登入' };
  const db = load();
  const current = normalizedAccessControl(db);
  const defaults = blankAccessControl();
  SIDEBAR_MODULES.forEach(module => {
    rolesAscending().forEach(role => {
      if (role.level < actor.level) current.modules[module.id][role.id] = { ...defaults.modules[module.id][role.id] };
    });
    current.modules[module.id] = normalizeModuleRow(module, current.modules[module.id]);
  });
  db.accessControl = current;
  commitCritical('perm');
  audit('還原側欄權限', `還原 ${actor.name} 可管理的較低身份`);
  return { ok: true };
}

/** Server projection metadata helper：前端只應顯示到 actor 自己，唔估高身份設定。 */
export function accessProjectionForRole(actorRole, db = tryLoad()) {
  const full = normalizedAccessControl(db);
  const identity = canonicalRole(actorRole);
  const allowed = new Set(visibleAccessRoles(identity).map(role => role.id));
  const projected = { ...full, projectedFor: identity, modules: {} };
  SIDEBAR_MODULES.forEach(module => {
    projected.modules[module.id] = {};
    Object.entries(full.modules[module.id]).forEach(([role, grant]) => {
      if (allowed.has(role)) projected.modules[module.id][role] = { ...grant };
    });
  });
  return projected;
}

export {
  ACCESS_SCHEMA_VERSION, ACCESS_DIMENSIONS, SIDEBAR_MODULES, accessInvariantErrors,
  migrateAccessControl, roleLevel
};
