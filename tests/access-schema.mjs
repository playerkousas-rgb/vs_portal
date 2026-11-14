#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ACTIVE_BRANCH_SCHEMA_ID, BRANCH_CONFIG, SIDEBAR_MODULES,
  canonicalRole, defaultModuleGrant, roleDef, roleLevel, rolesAscending
} from '../assets/js/lib/branch-config.js';
import {
  accessInvariantErrors, blankAccessControl, migrateAccessControl, normalizedAccessControl
} from '../assets/js/lib/access-schema.js';
import { gasTemplate } from '../assets/js/lib/gastemplate.js';

let passed = 0;
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('\nBranch access schema');
const roleIds = rolesAscending().map(role => role.id);
ok('Venture identities belong to the active branch schema',
  ACTIVE_BRANCH_SCHEMA_ID === 'venture-scout'
    && JSON.stringify(roleIds) === JSON.stringify(['member', 'exco', 'leader', 'chief', 'super']));
ok('legacy backend spellings canonicalize into branch identities rather than adding roles',
  canonicalRole('exec_committee') === 'exco'
    && canonicalRole('branch_leader') === 'leader'
    && canonicalRole('admin') === 'chief'
    && canonicalRole('generic-platform-admin') === ''
    && roleDef('generic-platform-admin') === null);
ok('roles and modules are schema-derived and levels are strictly ascending',
  BRANCH_CONFIG.roles.every((role, index, all) => !index || role.level > all[index - 1].level)
    && SIDEBAR_MODULES.length > 0 && roleLevel('super') > roleLevel('chief'));
const renderedGas = gasTemplate();
const gasRoleLevels = Object.fromEntries(BRANCH_CONFIG.roles.map(role => [role.id, role.level]));
const gasModuleDefaults = Object.fromEntries(BRANCH_CONFIG.modules.map(module => [
  module.id, [module.showFrom, module.readFrom, module.editFrom]
]));
ok('Portal GAS serializes roles and module thresholds from the same branch schema',
  renderedGas.includes(`var BRANCH_SCHEMA_ID_ = ${JSON.stringify(ACTIVE_BRANCH_SCHEMA_ID)};`)
    && renderedGas.includes(`var BRANCH_ROLE_LEVELS_ = ${JSON.stringify(gasRoleLevels)};`)
    && renderedGas.includes(`var BRANCH_MODULE_DEFAULTS_ = ${JSON.stringify(gasModuleDefaults)};`));

const defaults = blankAccessControl();
ok('default matrix is complete and invariant-safe',
  SIDEBAR_MODULES.every(module => roleIds.every(role => defaults.modules[module.id]?.[role]))
    && accessInvariantErrors(defaults).length === 0);

const custom = normalizedAccessControl({ accessControl: { modules: {
  finance: {
    member: { show: false, read: true, edit: true },
    exco: { show: false, read: false, edit: false },
    leader: { show: false, read: false, edit: false }
  }
} } });
ok('edit implies read and low-role grants inherit monotonically upward',
  roleIds.every(role => custom.modules.finance[role].read === true
    && custom.modules.finance[role].edit === true)
    && accessInvariantErrors(custom).length === 0);
ok('show remains independent from direct-route read access',
  custom.modules.finance.member.show === false && custom.modules.finance.member.read === true);
ok('unknown identities receive no default module grant',
  defaultModuleGrant(SIDEBAR_MODULES[0], 'generic-platform-admin').show === false
    && defaultModuleGrant(SIDEBAR_MODULES[0], 'generic-platform-admin').read === false
    && defaultModuleGrant(SIDEBAR_MODULES[0], 'generic-platform-admin').edit === false);

const legacy = { accessControl: { schema: 0, modules: {
  finance: { member: { show: true, read: false, edit: true }, ghost_role: { show: true } },
  ghost_module: { member: { show: true, read: true, edit: true } }
} } };
ok('migration removes unknown module/role columns and writes the branch schema', migrateAccessControl(legacy)
  && legacy.accessControl.branchSchema === ACTIVE_BRANCH_SCHEMA_ID
  && !legacy.accessControl.modules.ghost_module
  && !legacy.accessControl.modules.finance.ghost_role
  && legacy.accessControl.modules.finance.member.read === true);
ok('access migration is idempotent', migrateAccessControl(legacy) === false);

console.log(`\n${passed} passed, 0 failed\n`);
