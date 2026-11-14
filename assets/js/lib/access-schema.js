/* ============================================================
   access-schema.js — 支部模組權限矩陣的純資料規則
   ------------------------------------------------------------
   呢個檔不讀 session、localStorage 或 DOM，讓瀏覽器資料遷移、權限介面及
   測試共用完全相同的正規化規則，而不會造成 store ↔ access 循環依賴。
   ============================================================ */

import {
  ACCESS_DIMENSIONS, ACTIVE_BRANCH_SCHEMA_ID, BRANCH_SCHEMA_VERSION,
  SIDEBAR_MODULES, defaultModuleGrant, rolesAscending
} from './branch-config.js';

export const ACCESS_SCHEMA_VERSION = 1;
const bool = value => value === true;

export function blankAccessControl() {
  const modules = {};
  SIDEBAR_MODULES.forEach(module => {
    modules[module.id] = {};
    rolesAscending().forEach(role => {
      modules[module.id][role.id] = defaultModuleGrant(module, role);
    });
  });
  return {
    schema: ACCESS_SCHEMA_VERSION,
    branchSchema: ACTIVE_BRANCH_SCHEMA_ID,
    branchSchemaVersion: BRANCH_SCHEMA_VERSION,
    modules
  };
}

export function normalizeModuleRow(module, saved = {}) {
  const row = {};
  const roles = rolesAscending();
  roles.forEach(role => {
    const fallback = defaultModuleGrant(module, role);
    const source = saved && typeof saved[role.id] === 'object' ? saved[role.id] : {};
    row[role.id] = {
      show: source.show === undefined ? fallback.show : bool(source.show),
      read: source.read === undefined ? fallback.read : bool(source.read),
      edit: source.edit === undefined ? fallback.edit : bool(source.edit)
    };
    if (row[role.id].edit) row[role.id].read = true;
  });

  /* 由低至高傳遞 true，保證高身份永遠包含低身份。 */
  ACCESS_DIMENSIONS.forEach(dimension => {
    let inherited = false;
    roles.forEach(role => {
      inherited = inherited || row[role.id][dimension] === true;
      if (inherited) row[role.id][dimension] = true;
    });
  });
  /* edit 傳遞後再補一次 read（正常化必須係冪等）。 */
  roles.forEach(role => { if (row[role.id].edit) row[role.id].read = true; });
  return row;
}

/** 回傳完整、已正規化副本；不會因為純讀取而改資料庫。 */
export function normalizedAccessControl(db = null) {
  const source = db?.accessControl && typeof db.accessControl === 'object' ? db.accessControl : {};
  const out = blankAccessControl();
  SIDEBAR_MODULES.forEach(module => {
    out.modules[module.id] = normalizeModuleRow(module, source.modules?.[module.id]);
  });
  return out;
}

/** 開機資料遷移：補上 schema，同時刪除已不存在的模組／角色欄。 */
export function migrateAccessControl(db) {
  if (!db || typeof db !== 'object') return false;
  const next = normalizedAccessControl(db);
  const before = JSON.stringify(db.accessControl || null);
  const after = JSON.stringify(next);
  if (before === after) return false;
  db.accessControl = next;
  return true;
}

/** 純函數測試／後端契約用：驗證矩陣是否符合向上繼承及 edit=>read。 */
export function accessInvariantErrors(accessControl) {
  const matrix = normalizedAccessControl({ accessControl });
  const errors = [];
  const roles = rolesAscending();
  SIDEBAR_MODULES.forEach(module => {
    const row = matrix.modules[module.id];
    roles.forEach((role, index) => {
      if (row[role.id].edit && !row[role.id].read) errors.push(`${module.id}.${role.id}: edit without read`);
      if (!index) return;
      const lower = roles[index - 1];
      ACCESS_DIMENSIONS.forEach(dimension => {
        if (row[lower.id][dimension] && !row[role.id][dimension]) {
          errors.push(`${module.id}.${dimension}: ${lower.id} > ${role.id}`);
        }
      });
    });
  });
  return errors;
}
