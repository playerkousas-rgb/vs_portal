// 支部模組註冊：只作 server-side capability discovery；真正資料 action 仍須由 GAS 驗證 session/role。
export const MODULES = Object.freeze({
  notices: { id: 'notices', label: '通告', defaultEnabled: true, roles: ['leader', 'admin', 'exco', 'member'] },
  calendar: { id: 'calendar', label: '行事曆', defaultEnabled: true, roles: ['leader', 'admin', 'exco', 'member'] },
  inventory: { id: 'inventory', label: '物資', defaultEnabled: true, roles: ['leader', 'admin', 'exco', 'member'] },
  finance: { id: 'finance', label: '財務', defaultEnabled: true, roles: ['leader', 'admin', 'exco'] },
  members: { id: 'members', label: '團員及帳戶', defaultEnabled: true, roles: ['leader', 'admin', 'exco'] },
  progress: { id: 'progress', label: '進度', defaultEnabled: true, roles: ['leader', 'admin', 'exco', 'member'] }
});

function list(value) {
  return String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

export function moduleState(unit, role) {
  const disabled = new Set(list(unit?.disabledModules || process.env[`TROOP_${String(unit?.code || '').toUpperCase()}_DISABLEDMODULES`]));
  const enabled = new Set(list(unit?.enabledModules || process.env[`TROOP_${String(unit?.code || '').toUpperCase()}_MODULES`]));
  return Object.values(MODULES).map(m => ({
    ...m,
    enabled: disabled.has(m.id) ? false : (enabled.size ? enabled.has(m.id) : m.defaultEnabled),
    allowed: (m.roles || []).includes(String(role || '').toLowerCase())
  }));
}

export function isModuleAllowed(unit, role, id) {
  const item = moduleState(unit, role).find(m => m.id === String(id || '').toLowerCase());
  return !!item?.enabled && !!item?.allowed;
}
