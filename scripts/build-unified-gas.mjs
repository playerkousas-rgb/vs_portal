#!/usr/bin/env node
/*
 * Build the isolated unified Apps Script test artifact.
 *
 * Source order is intentional:
 *   - exact vsbadge v9.6 is the executable global baseline;
 *   - the old Portal backend is enclosed in an IIFE, so none of its 89 global
 *     names can shadow the baseline;
 *   - unified-extension.gs owns only the public entry points.
 *
 * The composed artifact is the complete branch capability superset. vs_portal is
 * the full-featured frontend and vsbadge is the lightweight frontend; the baseline
 * source order does not create a separate or reduced BADGE backend. Both clients
 * remain constrained by action allowlists and server-side session/role/scope checks.
 *
 * This script never writes apps-script/Code.gs. It writes the isolated GS artifact
 * plus a generated browser module so the private test UI downloads that exact build;
 * existing Apps Script deployments remain untouched until somebody deploys it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps-script', 'unified-src');
const OUT = path.join(ROOT, 'apps-script', 'UnifiedCode.gs');
const BROWSER_OUT = path.join(ROOT, 'assets', 'js', 'lib', 'unifiedtemplate.generated.js');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

function read(name) { return fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\r\n/g, '\n'); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function replaceOne(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one occurrence, found ${count}`);
  return source.replace(needle, replacement);
}

let baseline = read('vsbadge-v9.6.gs');
let portal = read('portal-admin-v2.8.8.gs');
const extension = read('unified-extension.gs');

if (sha256(baseline) !== manifest.baseline.sha256) {
  throw new Error('vsbadge baseline hash mismatch; refresh manifest deliberately instead of silently drifting');
}
if (sha256(portal) !== manifest.portalCompatibility.sha256) {
  throw new Error('Portal compatibility hash mismatch; it must stay a known generated artifact');
}
if (!baseline.includes(`const VS_GS_VERSION = '${manifest.baseline.version}';`)) {
  throw new Error('manifest baseline version does not match the vendored source');
}
/* The vendored checkpoint remains byte-exact; only normalize historical EOL spaces
 * in the generated artifact so repository whitespace checks stay actionable. */
baseline = baseline.replace(/[ \t]+$/gm, '');

/* This deliberately refreshed compatibility checkpoint is generated from the same
 * hardened Portal source as apps-script/Code.gs. Branch projection, module ACLs and
 * forged-write checks therefore stay identical before Unified adds its identity
 * router; the source hash above prevents either artifact drifting silently. */

// Keep all baseline helpers global, but hand the four public entry points to the
// unified router.  Internal menu callbacks that call initializeSheets() now
// deliberately call the unified additive initializer.
baseline = replaceOne(baseline, 'function initializeSheets() {', 'function badgeInitializeSheets_() {', 'initializeSheets');
baseline = replaceOne(baseline, 'function doGet(e){', 'function badgeDoGet_(e){', 'doGet');
baseline = replaceOne(baseline, 'function doPost(e){', 'function badgeDoPost_(e){', 'doPost');
baseline = replaceOne(baseline, 'function onOpen(){', 'function badgeOnOpen_(){', 'onOpen');
/* These native roster/account mutations lacked a script lock. Give them the
 * same lock as Portal saves so the roster revision check and update cannot race. */
for (const [name, params] of [
  ['handleAddMember', 'ymis,name,branch,actor'],
  ['handleUpdateUserRole', 'targetYmis,newRole,canTick,managerYmis,allowedBadges'],
  ['handleSetUserStatus', 'targetYmis,status,manager']
]) {
  baseline = replaceOne(baseline, `function ${name}(${params}){`, `function ${name}Unlocked_(${params}){`, 'lock ' + name);
}

/* Existing BADGE deployments are the upgrade base, not fresh Sheets. The pinned
 * initializer also performs historical reserved-account cleanup and modifies
 * existing default-password flags. Those mutations are not appropriate as an
 * implicit Portal upgrade. Keep the baseline file byte-exact and make these
 * explicit, checked changes only in the composed candidate. Token validation
 * still rejects legacy reserved-account tokens; retaining rows does not revive them. */
baseline = replaceOne(baseline,
  "    if(pSheet.getLastColumn()<6){\n      pSheet.getRange(1,5).setValue('確認者'); pSheet.getRange(1,6).setValue('備註');\n    }",
  "    if(pSheet.getLastRow()===0) {\n      pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);\n    } else {\n      if(pSheet.getLastColumn()<5) pSheet.getRange(1,5).setValue('確認者');\n      if(pSheet.getLastColumn()<6) pSheet.getRange(1,6).setValue('備註');\n    }",
  'preserve existing progress header');
baseline = replaceOne(baseline,
  "  let uSheet = ss.getSheetByName('Users');\n  if(!uSheet){",
  "  let uSheet = ss.getSheetByName('Users');\n  const hadUsersSheet = !!uSheet;\n  if(!uSheet){",
  'detect existing Users sheet');
baseline = replaceOne(baseline,
  "  removeSuperAdminFromSheet(uSheet,userMap,uSheet.getDataRange().getValues());",
  "  // Upgrade preserves existing Users rows; reserved identities remain excluded by runtime checks.",
  'preserve Users rows');
baseline = replaceOne(baseline,
  "  ensureSeedAccount(uSheet,userMap,userRows,{ymis:ADMIN_YMIS,name:ADMIN_NAME,email:ADMIN_EMAIL,role:'admin',password:ADMIN_PASS,branch:'b4',can_tick:true,force_change_password:true});",
  "  if(!hadUsersSheet) ensureSeedAccount(uSheet,userMap,userRows,{ymis:ADMIN_YMIS,name:ADMIN_NAME,email:ADMIN_EMAIL,role:'admin',password:ADMIN_PASS,branch:'b4',can_tick:true,force_change_password:true});",
  'seed only newly created Users sheet');
const legacyDefaultFlag = `  // 舊版本會自動補上新欄，不需手動改 Sheet；仍使用預設密碼的舊帳號（舊單次 SHA-256 格式可在此直接比對）會被要求立即更改。
  // 新格式帳號在建立時已設 force_change_password；登入時亦會對預設密碼再作判斷，毋須在此逐個做 KDF 比對。
  const legacyDefaultHash=hashPassword(ADMIN_PASS);
  for(let i=1;i<userRows.length;i++){
    const storedHash=String(userRows[i][userMap.password_hash]||'');
    if(isLegacyPasswordHash_(storedHash) && safeEqualText(storedHash,legacyDefaultHash)) uSheet.getRange(i+1,userMap.force_change_password+1).setValue(true);
  }`;
baseline = replaceOne(baseline, legacyDefaultFlag,
  '  // Existing flags are not rewritten; handleLogin still requires default passwords to be changed.',
  'preserve existing password flags');
baseline = replaceOne(baseline,
  '    // 帳戶採安全刪除：Users 列保留為 tombstone，確保相同 YMIS / Email 永遠不會被開成另一帳戶。',
  '    unifiedRememberRosterRemoval_(targetYmis);\n    // 帳戶採安全刪除：Users 列保留為 tombstone，確保相同 YMIS / Email 永遠不會被開成另一帳戶。',
  'record roster-only deletion under the BADGE lock');
baseline = replaceOne(baseline,
  "    if(ui){\n      // 生成 API Key 不需要旅團編號；由用戶在 ADMIN FORM 填寫，不新增 GS 設定步驟。",
  "    if(false && ui){\n      // Unified initializer reports only after all stages complete.",
  'suppress premature BADGE initialization success');
portal = replaceOne(portal,
  '  if (ui) {\n    var detail = widened.length',
  '  if (false && ui) {\n    var detail = widened.length',
  'suppress premature Portal initialization success');
portal = replaceOne(portal,
  "    initProps.setProperty(LINK_FLAG, 'true');",
  '    // Preserve the existing BADGE local-login setting.',
  'preserve BADGE local-login flag');
portal = replaceOne(portal,
  "  Logger.log('深資童軍管理系統 ' + BACKEND_VERSION + ' initialized. ' + summary + ' API Key: ' + apiKey);",
  "  Logger.log('深資童軍管理系統 ' + BACKEND_VERSION + ' initialization stage complete.');",
  'avoid logging API key');
/* Unified revisions cover both the admin store and the shared BADGE roster.
 * Verify and translate the revision inside the existing script lock. */
portal = replaceOne(portal,
  '        var stx = withLock(function () {\n          var preparedTables',
  '        var stx = withLock(function () {\n          var revisionGuard = unifiedGuardAdminVersion_(body);\n          if (!revisionGuard.success) return revisionGuard;\n          var preparedTables',
  'guard table save revision');
portal = replaceOne(portal,
  '        var sv = withLock(function () {\n          var preparedDb',
  '        var sv = withLock(function () {\n          var revisionGuard = unifiedGuardAdminVersion_(body);\n          if (!revisionGuard.success) return revisionGuard;\n          var preparedDb',
  'guard db save revision');
portal = replaceOne(portal,
  `  if (!loaded.success || !loaded.db) {
    return writeAuth && (writeAuth.setup || writeAuth.serverSigned) ? { success: true, db: incoming }
      : staffWriteDenied_('未能讀取目前資料，已拒絕寫入');
  }
  var current = loaded.db;`,
  `  if (!loaded.success) return staffWriteDenied_('未能讀取目前資料，已拒絕寫入');
  if (!loaded.db && writeAuth && (writeAuth.setup || (writeAuth.serverSigned && !writeAuth.delegated))) {
    return { success: true, db: incoming };
  }
  var current = loaded.db || {};
  if (writeAuth && writeAuth.delegated) {
    current.members = unifiedCanonicalMembers_(current.members || [], true);
    current.accounts = unifiedAccountProjection_(current.members);
  }`,
  'authorize delegated writes against the existing shared roster even before the first Portal save');
portal = replaceOne(portal,
  '        var sp = withLock(function () { return saveDbPart(body); });',
  '        var sp = withLock(function () { var guard = unifiedGuardAdminVersion_(body); return guard.success ? saveDbPart(body) : guard; });',
  'guard staged part revision');
portal = replaceOne(portal,
  '        var sc = withLock(function () { return saveDbCommit(body, dbSession); });',
  '        var sc = withLock(function () { var guard = unifiedGuardAdminVersion_(body); return guard.success ? saveDbCommit(body, dbSession) : guard; });',
  'guard staged commit revision');
portal = replaceOne(portal,
  '  if (protectedCommit.success !== true) return protectedCommit;\n  var text = JSON.stringify(merged);',
  '  if (protectedCommit.success !== true) return protectedCommit;\n  merged = unifiedPrepareAdminDb_(merged);\n  var text = JSON.stringify(merged);',
  'canonicalize staged identities after authorization and before persistence');

portal = replaceOne(portal,
  '          return tableGuard.success === true ? saveTables(body) : tableGuard;',
  '          return tableGuard.success === true ? unifiedFinishRosterWrite_(saveTables(body), body.tables.members, body.unit) : tableGuard;',
  'update roster under table save lock');
portal = replaceOne(portal,
  '          return dbGuard.success === true ? saveDb(body) : dbGuard;',
  '          return dbGuard.success === true ? unifiedFinishRosterWrite_(saveDb(body), body.db.members, body.unit) : dbGuard;',
  'update roster under db save lock');
portal = replaceOne(portal,
  '  return { success: true, chunks: chunks.length, bytes: text.length, at: now, version: outVersion2,\n    blobVersion: version, parts: parts, reports: reports2 };',
  '  return unifiedFinishRosterWrite_({ success: true, chunks: chunks.length, bytes: text.length, at: now, version: outVersion2,\n    blobVersion: version, parts: parts, reports: reports2 }, merged.members, unit);',
  'update roster under staged commit lock');
portal = replaceOne(portal,
  '          missingTables: stx.missingTables || [],',
  "          missingTables: stx.missingTables || [], rosterSyncPending: stx.rosterSyncPending === true, revisionPending: stx.revisionPending === true, writePending: stx.writePending === true, warning: stx.warning || '',",
  'report table roster warnings');
portal = replaceOne(portal,
  '          reports: sv.reports || null });',
  "          reports: sv.reports || null, rosterSyncPending: sv.rosterSyncPending === true, revisionPending: sv.revisionPending === true, writePending: sv.writePending === true, warning: sv.warning || '' });",
  'report db roster warnings');
portal = replaceOne(portal,
  '          reports: sc.reports || null });',
  "          reports: sc.reports || null, rosterSyncPending: sc.rosterSyncPending === true, revisionPending: sc.revisionPending === true, writePending: sc.writePending === true, warning: sc.warning || '' });",
  'report staged roster warnings');
for (const mirror of ['mirrored', 'mirrored2']) {
  const message = "'資料庫已寫入，但資料表鏡像失敗；請勿清除本機資料：' + (" + mirror + " && " + mirror + ".error || '後端異常')";
  portal = replaceOne(portal,
    'return { success: false, error: ' + message + ' };',
    'return { success: false, writePending: true, error: ' + message + ' };',
    'report uncertain committed blob ' + mirror);
}
portal = replaceOne(portal,
  "      error: '後端寫入後即刻讀返唔到呢次寫嘅行（有多部機同時儲存／部署唔啱）—— 冇嘢俾人蓋走，請再儲存一次' };",
  "      writePending: true, error: '後端已嘗試寫入但未能核對，請重新讀取核實，勿盲目重送' };",
  'report unconfirmed table writes as uncertain');
portal = replaceOne(portal,
  "    if (body.action === 'sync') {\n      var syncAuth = requireAuth(expectedKey, key);",
  "    if (body.action === 'sync') {\n      if (body.db && typeof body.db === 'object') return json({ ok:false, success:false, error:'請先使用 saveDb 或 saveTables 儲存資料，再同步報表' });\n      var syncAuth = requireAuth(expectedKey, key);",
  'prevent legacy combined report sync from bypassing the shared revision and roster write lock');
portal = replaceOne(portal,
  "          ? saveDb({ unit: textOf(body.unit), db: body.db, baseVersion: '', force: true })\n          : forceGuard;",
  "          ? unifiedFinishRosterWrite_(saveDb({ unit: textOf(body.unit), db: body.db, baseVersion: '', force: true }), body.db.members, body.unit)\n          : forceGuard;",
  'update force-repair roster under the same lock');

/* Report refresh receives a potentially partial projection. It must not rewrite
 * BADGE's authoritative roster or delete arbitrary legacy suffixed sheets. The
 * unified router applies authorised roster edits only after the DB write succeeds. */
portal = replaceOne(portal,
  "  counts['memberList'] = writeMemberList(ss, tables.members || []);",
  "  counts['memberList'] = 0; // reports do not update the authoritative BADGE roster",
  'preserve BADGE roster on report refresh');
portal = replaceOne(portal,
  '  removeSuffixedTabs(ss, unit);',
  '  // Never delete existing suffixed tabs as an implicit side effect of report refresh.',
  'preserve existing suffixed tabs');
/* Reports are destructive projections (clear and rebuild), so do not assume an
 * old same-named sheet belongs to Portal. Record ownership only when this upgrade
 * creates a report tab, and bind it to its sheet ID, not just its name. */
portal = replaceOne(portal,
  '    report.push(ensureSheetStructure_(ss, cfg, brandColor, headerColor));',
  `    var structure = ensureSheetStructure_(ss, cfg, brandColor, headerColor);
    report.push(structure);
    if (structure.created && unifiedReportNames_().indexOf(cfg.name) >= 0) {
      unifiedRememberReport_(ss.getSheetByName(cfg.name));
    }`,
  'mark only newly created report tabs');
portal = replaceOne(portal,
  'function syncAll(body) {\n  var ss = SpreadsheetApp.getActiveSpreadsheet();',
  `function unifiedReportNames_() {
  return ['帳目', '收支申報', '物資', '團員', '通告', '通告全文', '報名', '物資借用', '會議'];
}
function unifiedRememberReport_(sheet) {
  PropertiesService.getScriptProperties().setProperty('UNIFIED_REPORT_SHEET_' + sheet.getName(), String(sheet.getSheetId()));
}
function unifiedCheckReportOwnership_(ss) {
  var props = PropertiesService.getScriptProperties();
  var names = unifiedReportNames_();
  // Check every existing tab before touching any report, avoiding partial clears.
  names.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && props.getProperty('UNIFIED_REPORT_SHEET_' + name) !== String(sh.getSheetId())) {
      throw new Error('已有報表分頁「' + name + '」未獲確認，已停止刷新以保留原有資料');
    }
  });
  names.forEach(function (name) {
    if (!ss.getSheetByName(name)) unifiedRememberReport_(ss.insertSheet(name));
  });
}
function syncAll(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  unifiedCheckReportOwnership_(ss);`,
  'guard destructive report refresh');
portal = replaceOne(portal,
  '    if (logRows > 550) log.deleteRows(2, logRows - 501);',
  '    // Preserve all pre-existing and future sync log rows.',
  'preserve sync history');
for (const call of [
  'removeSuperAdminTokenRows(tSheet);',
  'removeSuperAdminAuditRows(auditSheet);',
  'removeSuperAdminIdentityRows(pSheet,[0],[4]);',
  'removeSuperAdminIdentityRows(mSheet,[0],[]);',
  'removeSuperAdminIdentityRows(aSheet,[1,3],[8]);',
  'removeSuperAdminIdentityRows(prSheet,[1],[9]);',
  'removeSuperAdminIdentityRows(oSheet,[0],[]);',
  'removeSuperAdminIdentityRows(lSheet,[2],[10]);',
  'removeSuperAdminIdentityRows(lrSheet,[4],[14]);',
  'if(pwResetSheetForCleanup) removeSuperAdminIdentityRows(pwResetSheetForCleanup,[1],[12]);',
  'removeSuperAdminIdentityRows(cfgSheet,[],[3]);'
]) baseline = replaceOne(baseline, '  ' + call,
  '  // Upgrade leaves historical rows untouched: ' + call, 'preserve historical rows: ' + call);

baseline = replaceOne(baseline,
  '// 旅系統（旅 > 團 > 進度）：上游登記下游 URL 及 SHEET KEY，經 sig 讀寫下游；下游 ALLOW_LOCAL_LOGIN 閂口後只收 sig；\n//   選單「🔗 旅系統」提供匯出 JSON（含 hash）／匯入（upsertUser）／登記下游／直接入口掣',
  '// 支部獨立後端：正常身份來自支部 Users，本地登入保持開啟。\n// Progress 只執行同一 Unified Sheet 的業務 action；簽名 helper 只作同一 /exec 的 server authentication transport。',
  'architecture header');
baseline = replaceOne(baseline,
  '// 接入資料：initializeSheets／showApiKey 及旅系統選單只顯示 API Key；部署 URL 由 Google 部署視窗提供，旅團編號在 ADMIN FORM 填寫。',
  '// 接入資料：initializeSheets／showApiKey 及支部系統選單只顯示 API Key；部署 URL 由 Google 部署視窗提供，旅團編號在 ADMIN FORM 填寫。',
  'registration menu header');
baseline = replaceOne(baseline,
  '// ===== 旅系統：上下游接駁（旅 > 團 > 進度）=====',
  '// ===== Pinned baseline signature compatibility helpers（not a Progress integration contract）=====',
  'legacy signature section heading');
baseline = replaceOne(baseline,
  '// ===== 旅系統：Sheet 選單（匯出／匯入／登記下游／直接入口掣）=====',
  '// ===== Pinned baseline legacy menu implementation（Unified onOpen is overridden below）=====',
  'legacy menu section heading');

const wrappedPortal = [
  '// ===== Namespaced legacy administrative compatibility module =====',
  'var PortalAdminCompat_ = (function () {',
  portal,
  'return {',
  '  initializeSheets: initializeSheets,',
  '  dispatchBody: dispatchBody,',
  '  doGet: doGet,',
  '  doPost: doPost,',
  '  loadDb: loadDb,',
  '  loadTables: loadTables,',
  '  staffActorFromAuth: staffActorFromAuth_,',
  '  staffSafeDb: staffSafeDb_,',
  '  dbStats: dbStats,',
  '  dbInfo: dbInfo,',
  '  canAccountAdmin: staffCanAccountAdmin_,',
  '  canonicalRole: branchCanonicalRole_,',
  '  roleLevel: branchRoleLevel_,',
  '  visibleRoles: BRANCH_VISIBLE_ROLES_.slice(),',
  '};',
  '})();',
  ''
].join('\n');

const banner = [
  '// AUTO-GENERATED. DO NOT EDIT THIS FILE DIRECTLY.',
  '// Build: npm run build:gas:unified',
  `// Baseline: playerkousas-rgb/vsbadge@${manifest.baseline.commit} (${manifest.baseline.version})`,
  `// Portal source: ${manifest.portalCompatibility.repository}@${manifest.portalCompatibility.sourceCommit} (${manifest.portalCompatibility.version})`,
  '// Architecture: complete Unified branch backend; vs_portal is the full-featured frontend',
  '// and vsbadge is the lightweight frontend. Client surface never replaces server authorization.',
  '// Release channel: isolated test only; not deployed and not copied to vsbadge.',
  ''
].join('\n');

const output = `${banner}${baseline.trimEnd()}\n\n${wrappedPortal}${extension.trimEnd()}\n`;
fs.writeFileSync(OUT, output, 'utf8');
const browserModule = [
  '// AUTO-GENERATED by scripts/build-unified-gas.mjs. DO NOT EDIT.',
  `export const UNIFIED_GAS_SHA256 = ${JSON.stringify(sha256(output))};`,
  `export function unifiedGasTemplate() { return ${JSON.stringify(output)}; }`,
  ''
].join('\n');
fs.writeFileSync(BROWSER_OUT, browserModule, 'utf8');
console.log(`apps-script/UnifiedCode.gs built (${Buffer.byteLength(output)} bytes, sha256 ${sha256(output)})`);
console.log('assets/js/lib/unifiedtemplate.generated.js updated for in-app download');
