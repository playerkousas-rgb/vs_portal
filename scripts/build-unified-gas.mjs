#!/usr/bin/env node
/* Build the single full shared GS from the hash-pinned BADGE v9.7 source.
 * Keep transformations explicit and fail if the upstream source drifts. Both
 * frontends must ultimately use the identical generated artifact, not forks. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'apps-script', 'unified-src');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
let output = fs.readFileSync(path.join(src, manifest.baseline.localPath), 'utf8');
if (sha256(output) !== manifest.baseline.sha256) throw new Error('BADGE shared source hash mismatch');
function replaceOne(before, after, label) {
  const count = output.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one occurrence, found ${count}`);
  output = output.replace(before, after);
}
replaceOne(`const VS_GS_VERSION = '${manifest.baseline.version}';`, `const VS_GS_VERSION = '${manifest.outputVersion}';`, 'shared version');
replaceOne(`var UNIFIED_GS_VERSION = '${manifest.baseline.version}';`, `var UNIFIED_GS_VERSION = '${manifest.outputVersion}';`, 'unified version');
replaceOne(`// ${manifest.baseline.version} adds a session-protected full BADGE roster projection; both clients retain the same backend.`,
  `// The ${manifest.baseline.version} baseline adds a session-protected full BADGE roster projection.`, 'historical version comment');
replaceOne('// VS unified branch backend — isolated test extension', '// VS unified branch backend — shared router', 'router title');
replaceOne('// This file is test-only in vs_portal.  Its assertion/exchange route is a security\n// fixture, not a Progress or future travel-system contract.  The formal future\n// direction is travel-system server → branch backend reader.  It is not published\n// to vsbadge and does not deploy itself.  Build with: npm run build:gas:unified',
  '// The assertion/exchange route is a security fixture, not a Progress or future\n// travel-system contract. This file does not deploy itself. Build in vs_portal\n// with: npm run build:gas:unified; next update starts from the latest full GS.', 'router provenance');
// Preserve existing troop history; reserved users and tokens remain rejected by
// runtime checks. This maintains the Portal upgrade's existing preservation contract.
for (const line of [
  'removeSuperAdminFromSheet(uSheet,userMap,uSheet.getDataRange().getValues());',
  'removeSuperAdminTokenRows(tSheet);', 'removeSuperAdminAuditRows(auditSheet);',
  'removeSuperAdminIdentityRows(pSheet,[0],[4]);', 'removeSuperAdminIdentityRows(mSheet,[0],[]);',
  'removeSuperAdminIdentityRows(aSheet,[1,3],[8]);', 'removeSuperAdminIdentityRows(prSheet,[1],[9]);',
  'removeSuperAdminIdentityRows(oSheet,[0],[]);', 'removeSuperAdminIdentityRows(lSheet,[2],[10]);',
  'removeSuperAdminIdentityRows(lrSheet,[4],[14]);',
  'if(pwResetSheetForCleanup) removeSuperAdminIdentityRows(pwResetSheetForCleanup,[1],[12]);',
  'removeSuperAdminIdentityRows(cfgSheet,[],[3]);'
]) replaceOne('  ' + line, '  // Existing historical rows are retained; runtime still rejects reserved credentials.', 'preserve history: ' + line);
replaceOne("  // Preserve the pinned BADGE v9.7 security migration: remove legacy reserved accounts and normalize actor labels.",
  '  // Do not implicitly delete existing Users history on upgrade.', 'Users migration comment');
replaceOne('  // Keep the pinned BADGE v9.7 cleanup behavior for reserved identity rows and actor labels.',
  '  // Do not implicitly delete or rewrite historical identity and actor cells.', 'history migration comment');
// Legacy reserved rows remain in the Sheet for data preservation, but never
// become local credentials or authorise old sessions, even under another YMIS.
replaceOne("  return rec && rec.user.status==='active' ? rec.user : null;",
  "  return rec && sheetIdentityAllowed_(rec.user) ? rec.user : null;", 'deny reserved sheet identity by YMIS');
replaceOne("    if(emailKey(user.email)===target && user.status==='active') return user;",
  "    if(emailKey(user.email)===target) return sheetIdentityAllowed_(user) ? user : null;", 'deny reserved sheet identity by email');
replaceOne('function getUser(ymis){',
  "function sheetIdentityAllowed_(user){\n  return !!user && user.status==='active' && !isSuperAdminReserved(user.ymis,user.email)\n    && String(user.role||'').trim().toLowerCase()!=='super_admin';\n}\nfunction getUser(ymis){", 'sheet identity guard');
replaceOne("      return data[i][1].toString();",
  "      const subject=String(data[i][1]||'');\n      return getUser(subject) ? subject : null;", 'reject invalid local session');
replaceOne("  if(sh){ const d=sh.getDataRange().getValues(); for(let i=Math.max(1,d.length-200);i<d.length;i++) out.push(d[i]); }",
  "  if(sh){ const d=sh.getDataRange().getValues(); for(let i=Math.max(1,d.length-200);i<d.length;i++){\n    const reserved=d[i].some(function(value){ const text=String(value||'').trim(); return isSuperAdminId(text) || text.indexOf(SUPER_TOKEN_PREFIX)===0; });\n    if(!reserved) out.push(d[i]);\n  } }", 'filter retained reserved audit rows without deleting them');
replaceOne("  if (!member || !member.ymis) return null;\n  var existing = getUser(member.ymis) || (member.contact ? getUserByEmail(member.contact) : null);",
  "  if (!member || !member.ymis || isSuperAdminReserved(member.ymis, member.contact)) return null;\n  // Never create a duplicate when a retained, disabled, or reserved row exists.\n  if (findUserRecord(member.ymis) && !getUser(member.ymis)) return null;\n  var existing = getUser(member.ymis) || (member.contact ? getUserByEmail(member.contact) : null);", 'block fixture resurrection of retained identities');
replaceOne("  if (existing) return existing;\n  var sheet = getSheet().getSheetByName('Users');\n  if (!sheet) {",
  "  if (existing) return existing;\n  var sheet = getSheet().getSheetByName('Users');\n  if (sheet && member.contact && isEmail(member.contact)) {\n    var contactMap = getHeaderMap(sheet);\n    var contactRows = sheet.getDataRange().getValues();\n    for (var ci = 1; ci < contactRows.length; ci++) {\n      var contactUser = userFromRow(contactRows[ci], contactMap);\n      if (emailKey(contactUser.email) === emailKey(member.contact)) return null;\n    }\n  }\n  if (!sheet) {", 'prevent fixture duplicating a retained email');
replaceOne("    if (String(body.apikey || body.apiKey || '') !== String(statusKey)) {",
  "    if (!statusKey || !safeEqualText(String(body.apikey || body.apiKey || ''), String(statusKey))) {", 'require configured status API key');
replaceOne('  try { Logger.log(message); } catch (ignoreLog) {}\n  result.apiKey = getApiKey();',
  "  try { Logger.log(result.success ? '共用後端初始化完成。' : message); } catch (ignoreLog) {}\n  if (result.success) result.apiKey = getApiKey();", 'do not log key or create one on failure');
const banner = [
  '// AUTO-GENERATED. DO NOT EDIT THIS FILE DIRECTLY.',
  '// Build: npm run build:gas:unified',
  `// Baseline: ${manifest.baseline.repository}@${manifest.baseline.commit} (${manifest.baseline.version})`,
  '// Architecture: complete Unified branch backend; vs_portal is the full-featured frontend',
  '// and vsbadge is the lightweight frontend. Client surface never replaces server authorization.',
  '// Both products must use this same complete shared backend artifact.',
  ''
].join('\n');
output = banner + output;
fs.writeFileSync(path.join(root, 'apps-script', 'UnifiedCode.gs'), output);
fs.writeFileSync(path.join(root, 'assets', 'js', 'lib', 'unifiedtemplate.generated.js'),
  '// AUTO-GENERATED by scripts/build-unified-gas.mjs. DO NOT EDIT.\n' +
  `export const UNIFIED_GAS_SHA256 = '${sha256(output)}';\n` +
  `export function unifiedGasTemplate() { return ${JSON.stringify(output)}; }\n`);
console.log(`apps-script/UnifiedCode.gs built (${Buffer.byteLength(output)} bytes, sha256 ${sha256(output)})`);
console.log('assets/js/lib/unifiedtemplate.generated.js updated for in-app download');
