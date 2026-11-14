// Branch-schema capability discovery only. Effective grants live in the branch DB and
// are always rechecked by GAS against a verified session; this metadata is never an
// authorization decision and does not define platform-global identities.
import {
  ACTIVE_BRANCH_SCHEMA_ID, SIDEBAR_MODULES, defaultModuleGrant, roleDef
} from '../assets/js/lib/branch-config.js';

export const BRANCH_SCHEMA_ID = ACTIVE_BRANCH_SCHEMA_ID;
export const MODULES = Object.freeze(Object.fromEntries(
  SIDEBAR_MODULES.map(module => [module.id, Object.freeze({
    id: module.id, label: module.label, defaultEnabled: true
  })])
));

function list(value) {
  return String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

/**
 * Return branch-local defaults for discovery/backward compatibility. The caller's
 * role is intentionally resolved through this branch schema rather than a universal
 * role array. db.accessControl from authenticated GAS remains authoritative.
 */
export function moduleState(unit, role) {
  const disabled = new Set(list(unit?.disabledModules || process.env[`TROOP_${String(unit?.code || '').toUpperCase()}_DISABLEDMODULES`]));
  const enabled = new Set(list(unit?.enabledModules || process.env[`TROOP_${String(unit?.code || '').toUpperCase()}_MODULES`]));
  const identity = roleDef(role);
  return SIDEBAR_MODULES.map(module => {
    const configured = disabled.has(module.id) ? false : (enabled.size ? enabled.has(module.id) : true);
    const grant = identity ? defaultModuleGrant(module, identity) : { show: false, read: false, edit: false };
    return {
      ...MODULES[module.id],
      branchSchema: ACTIVE_BRANCH_SCHEMA_ID,
      enabled: configured,
      grant,
      /* Compatibility field for old discovery clients; not an authorization result. */
      allowed: configured && grant.read === true
    };
  });
}

export function isModuleAllowed(unit, role, id) {
  const item = moduleState(unit, role).find(module => module.id === String(id || '').toLowerCase());
  return !!item?.enabled && item.grant?.read === true;
}
