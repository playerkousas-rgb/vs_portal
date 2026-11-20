#!/usr/bin/env node
/* Isolated unified GS contract tests.  No deployment or network access. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { unifiedGasTemplate, UNIFIED_GAS_SHA256 } from '../assets/js/lib/unifiedtemplate.generated.js';

const SOURCE = fs.readFileSync(new URL('../apps-script/UnifiedCode.gs', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../apps-script/unified-src/manifest.json', import.meta.url), 'utf8'));
let passed = 0;
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

function signedBytes(buffer) { return Array.from(buffer, b => b > 127 ? b - 256 : b); }
function bytes(value) {
  if (Array.isArray(value)) return Buffer.from(value.map(v => v & 255));
  return Buffer.from(String(value ?? ''), 'utf8');
}

let nextSheetId = 1;
function makeSheet(name, initial = []) {
  const sheetId = nextSheetId++;
  const rows = initial.map(r => Array.from(r));
  const formats = new Map();
  const setCell = (r, c, value) => {
    while (rows.length < r) rows.push([]);
    while (rows[r - 1].length < c) rows[r - 1].push('');
    rows[r - 1][c - 1] = value;
  };
  const cell = (r, c) => (rows[r - 1] && rows[r - 1][c - 1] !== undefined ? rows[r - 1][c - 1] : '');
  function range(r, c, nr = 1, nc = 1) {
    const api = {
      getValue: () => cell(r, c),
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      setValue(value) { setCell(r, c, value); return api; },
      setValues(values) { values.forEach((line, i) => line.forEach((value, j) => setCell(r + i, c + j, value))); return api; },
      setFontWeight: () => api, setBackground: () => api, setFontColor: () => api,
      setWrap: () => api, setHorizontalAlignment: () => api, setFontSize: () => api,
      setBorder: () => api, setFontFamily: () => api,
      setNumberFormat(fmt) {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) formats.set(`${r + i}:${c + j}`, fmt);
        return api;
      },
      clearContent() {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) setCell(r + i, c + j, '');
        return api;
      }
    };
    return api;
  }
  const sheet = {
    _rows: rows,
    getName: () => name,
    appendRow(values) { rows.push(Array.from(values)); return sheet; },
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => range(1, 1, Math.max(rows.length, 1), Math.max(sheet.getLastColumn(), 1)),
    getRange: (r, c, nr, nc) => range(r, c, nr || 1, nc || 1),
    deleteRow(row) { rows.splice(row - 1, 1); },
    deleteRows(row, count) { rows.splice(row - 1, count); },
    clear() { rows.length = 0; return sheet; },
    clearContents() { rows.length = 0; return sheet; },
    setFrozenRows: () => sheet, setColumnWidth: () => sheet, autoResizeColumn: () => sheet,
    hideSheet: () => sheet, showSheet: () => sheet, setTabColor: () => sheet,
    getFilter: () => null, getSheetId: () => sheetId
  };
  return sheet;
}

function makeNode() {
  const sheets = new Map();
  const props = new Map([
    ['API_KEY', 'existing-api-key-do-not-change']
  ]);
  const cache = new Map();
  const cacheWrites = [];
  const mail = [];
  const lockStats = { waits: 0, releases: 0, held: false };
  const spreadsheet = {
    getName: () => 'Unified test branch sheet', getId: () => 'unified-test-sheet',
    getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) { const sheet = makeSheet(name); sheets.set(name, sheet); return sheet; },
    getSheets: () => [...sheets.values()], deleteSheet: sheet => sheets.delete(sheet.getName()),
    setSpreadsheetTimeZone: () => spreadsheet, getSpreadsheetTimeZone: () => 'Asia/Hong_Kong'
  };
  const scriptProps = {
    getProperty: key => (props.has(String(key)) ? props.get(String(key)) : null),
    setProperty: (key, value) => { props.set(String(key), String(value)); },
    deleteProperty: key => { props.delete(String(key)); },
    getProperties: () => Object.fromEntries(props)
  };
  let uuidCounter = 0;
  const content = text => ({
    _text: String(text), setMimeType() { return this; }, getContent() { return this._text; }
  });
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi: () => null, flush: () => {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(String(key)) || null,
      put: (key, value, ttl) => {
        cache.set(String(key), String(value));
        cacheWrites.push({ key: String(key), value: String(value), ttl: Number(ttl || 0) });
      },
      remove: key => cache.delete(String(key))
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { lockStats.waits++; if (lockStats.held) return false; lockStats.held = true; return true; },
      waitLock: () => { lockStats.waits++; if (lockStats.held) throw new Error('nested script lock'); lockStats.held = true; },
      releaseLock: () => {
        if (!lockStats.held) throw new Error('unlock without lock');
        lockStats.releases++; lockStats.held = false;
        if (lockStats.onRelease) lockStats.onRelease();
      }
    }) },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => signedBytes(crypto.createHash('sha256').update(bytes(value)).digest()),
      computeHmacSha256Signature: (value, key) => signedBytes(crypto.createHmac('sha256', bytes(key)).update(bytes(value)).digest()),
      base64EncodeWebSafe: value => bytes(value).toString('base64url'),
      base64DecodeWebSafe: value => signedBytes(Buffer.from(String(value), 'base64url')),
      base64Encode: value => bytes(value).toString('base64'),
      base64Decode: value => signedBytes(Buffer.from(String(value), 'base64')),
      newBlob: value => ({
        getBytes: () => signedBytes(bytes(value)),
        getDataAsString: () => bytes(value).toString('utf8'),
        setName() { return this; }
      }),
      formatDate: value => new Date(value).toISOString().replace('T', ' ').slice(0, 19),
      sleep: () => {}
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: content },
    Logger: { log: () => {} },
    MailApp: { sendEmail: (...args) => { mail.push(args); } },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.test' }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/UNIFIED_TEST_123/exec' }) },
    DriveApp: {
      getRootFolder: () => ({ createFile: () => ({ getId: () => 'file', getUrl: () => 'https://drive.test/file' }) }),
      getFileById: () => ({ getParents: () => ({ hasNext: () => false }), getBlob: () => ({ getDataAsString: () => '{}' }) })
    },
    UrlFetchApp: { fetch: () => { throw new Error('network disabled in unified test'); } },
    console, JSON, Date, Math, String, Number, Object, Array, Boolean,
    isFinite, isNaN, parseInt, parseFloat, RegExp, Error, encodeURIComponent, decodeURIComponent
  });
  vm.runInContext(SOURCE, context, { filename: 'UnifiedCode.gs' });
  function post(body, parameter = {}) {
    const out = context.doPost({ parameter, postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.getContent());
  }
  return { context, post, props, sheets, spreadsheet, cache, cacheWrites, mail, lockStats };
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function ssoToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function exchangeToken(payload, apiKey = 'existing-api-key-do-not-change') {
  const key = crypto.createHmac('sha256', apiKey).update('vs-portal-branch-exchange-v1').digest('hex');
  return ssoToken(key, payload);
}
function assertion(unit, subject, role, name, scopes = null) {
  const now = Date.now();
  return exchangeToken({
    typ: 'central-sso-exchange', u: unit, sub: subject, role, name,
    scope: scopes || ['identity:read', 'branch:read', ...(role === 'member' ? [] : ['branch:write']),
      ...(['leader', 'chief', 'admin'].includes(role) ? ['branch:repair', 'identity:manage'] : [])],
    src: 'central-travel-system', iss: 'vs-portal', aud: `unified-gas:branch:${unit}`,
    iat: now, exp: now + 60_000, jti: crypto.randomUUID()
  });
}
function signedRequest(action, payload, key = 'existing-api-key-do-not-change') {
  const signKey = crypto.createHmac('sha256', key).update('vsbadge-troop-sig-v1').digest('hex');
  const make = (raw) => {
    const ts = String(Date.now());
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const digest = sha256(raw);
    const canonical = [action, ts, nonce, digest].join('\n');
    return { sig: crypto.createHmac('sha256', signKey).update(canonical).digest('hex'), ts, nonce };
  };
  const unsigned = { action, ...payload };
  const inner = make(JSON.stringify(unsigned));
  const body = { ...unsigned, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  const outer = make(JSON.stringify(body));
  return { body, parameter: { sig: outer.sig, sts: outer.ts, snonce: outer.nonce } };
}

console.log('\nUnified GS');
ok('in-app download is byte-for-byte the generated UnifiedCode.gs', unifiedGasTemplate() === SOURCE);
ok('in-app download publishes the generated artifact SHA-256', UNIFIED_GAS_SHA256 === sha256(SOURCE));
ok('composed artifact contains no legacy PORTAL_SESSION_SECRET dependency', !SOURCE.includes('PORTAL_SESSION_SECRET'));
ok('build includes exact pinned vsbadge commit provenance', SOURCE.includes(MANIFEST.baseline.commit));
ok('generated artifact declares complete backend with full-featured and lightweight frontends',
  SOURCE.includes('complete Unified branch backend')
    && SOURCE.includes('vs_portal is the full-featured frontend')
    && SOURCE.includes('vsbadge is the lightweight frontend'));
ok('generated architecture keeps client surface separate from server authorization',
  SOURCE.includes('Client surface never replaces server authorization')
    && SOURCE.includes('complete branch capability superset')
    && SOURCE.includes('not a second reduced GS')
    && SOURCE.includes('allowed action')
    && SOURCE.includes('session, role, and scope authorization'));
ok('shared backend uses the next version after BADGE v9.7', SOURCE.includes("const VS_GS_VERSION = 'v9.8';"));
ok('legacy Portal is namespaced instead of shadowing baseline globals', SOURCE.includes('var PortalAdminCompat_ = (function () {'));
ok('pinned legacy menu source remains available for compatibility', SOURCE.includes(".addItem('🔒 閂口（只收 sig）','menuLocalLoginOff')"));
const activeMenuSource = SOURCE.slice(SOURCE.lastIndexOf('function onOpen()'), SOURCE.lastIndexOf('function doGet(e)'));
ok('active Sheet menu exposes only branch-safe controls',
  activeMenuSource.includes("createMenu('🔗 支部系統')")
    && activeMenuSource.includes("'menuLocalLoginOn'")
    && !activeMenuSource.includes('menuLocalLoginOff')
    && !activeMenuSource.includes('menuRegisterDownstream')
    && !activeMenuSource.includes('badgeOnOpen_'));
ok('unfinished legacy authChangePassword is not an exposed compatibility route', !/PortalAdminCompat_\.authChangePassword/.test(SOURCE));

const statusNode = makeNode();
statusNode.props.delete('API_KEY');
ok('ecStatus fails closed without a configured API key and does not create one',
  statusNode.post({ action: 'ecStatus' }).success === false && !statusNode.props.has('API_KEY'));
statusNode.props.set('API_KEY', 'status-test-key');
const versionStatus = statusNode.post({ action: 'ecStatus', apikey: 'status-test-key' });
ok('ecStatus requires the real key and reports the shared version and acceptance channel',
  statusNode.post({ action: 'ecStatus', apikey: 'wrong' }).success === false
    && versionStatus.success === true && versionStatus.gsVersion === 'v9.8'
    && versionStatus.channel === 'portal-acceptance' && versionStatus.gsInitializationCurrent === false);
const initLogNode = makeNode();
const initLogs = [];
initLogNode.context.Logger.log = value => initLogs.push(String(value));
const initForLogs = initLogNode.context.initializeSheets();
ok('successful initialization does not log its API key', initForLogs.success === true
  && !initLogs.join(' ').includes('existing-api-key-do-not-change'));
const failNoKeyNode = makeNode();
failNoKeyNode.props.delete('API_KEY');
failNoKeyNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [['錯誤表頭', 'existing']]));
const failNoKey = failNoKeyNode.context.initializeSheets();
ok('failed preflight does not create or return a missing API key', failNoKey.success === false
  && !failNoKeyNode.props.has('API_KEY') && !Object.hasOwn(failNoKey, 'apiKey'));

const node = makeNode();
const USER_HEADERS = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','force_change_password'];

/* Fresh troop: the Sheet creates the same first administrator used by both
   clients. This is not a second Portal account or a pre-existing BADGE setup. */
const freshNode = makeNode();
const freshInit = freshNode.context.initializeSheets();
const freshUsers = freshNode.sheets.get('Users')._rows;
ok('new troop initializes exactly one shared administrator in Users',
  freshInit.success === true && freshUsers.length === 2
    && freshUsers[1][0] === '1111111111' && freshUsers[1][3] === 'admin');
const freshBadgeLogin = freshNode.post({ action: 'login', login_id: '1111111111', password: 'changeme' });
const freshPortalLogin = freshNode.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changeme' });
ok('BADGE and Portal login use the same freshly initialized administrator and require a password change',
  freshBadgeLogin.success === true && freshPortalLogin.success === true
    && freshBadgeLogin.user?.ymis === freshPortalLogin.account?.ymis
    && freshBadgeLogin.force_change_password === true && freshPortalLogin.mustChangePw === true,
  JSON.stringify({ badge: freshBadgeLogin, portal: freshPortalLogin }));
const freshPasswordChange = freshNode.post({ action: 'authChangePassword', unit: '0082',
  sessionToken: freshPortalLogin.sessionToken, oldPassword: 'changeme', newPassword: 'freshpass99' });
const freshBadgeAfterChange = freshNode.post({ action: 'login', login_id: '1111111111', password: 'freshpass99' });
const freshPortalAfterChange = freshNode.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'freshpass99' });
ok('first administrator password changed through Portal works through both frontends',
  freshPasswordChange.success === true && freshBadgeAfterChange.success === true && freshPortalAfterChange.success === true,
  JSON.stringify({ changed: freshPasswordChange, badge: freshBadgeAfterChange, portal: freshPortalAfterChange }));
const freshUsersBeforeRepeat = JSON.stringify(freshUsers);
const freshRepeat = freshNode.context.initializeSheets();
ok('reinitializing a new troop preserves the first administrator without duplicating or resetting it',
  freshRepeat.success === true && JSON.stringify(freshUsers) === freshUsersBeforeRepeat);
const freshRoster = freshNode.sheets.get('成員名單');
freshRoster.appendRow(['9000000077', '原名字', '2026-01-01', 'VS', '']);
const beforePartial = freshNode.post({ action: 'loadTables', unit: '0082', sessionToken: freshPortalAfterChange.sessionToken });
const savedRange = freshRoster.getRange;
freshRoster.getRange = (row, col, nr, nc) => {
  const range = savedRange(row, col, nr, nc);
  if (row === 2 && col === 2) range.setValue = () => { throw new Error('simulated roster write failure'); };
  return range;
};
const failedRosterMirror = freshNode.post({ action: 'saveTables', unit: '0082', sessionToken: freshPortalAfterChange.sessionToken,
  baseVersion: beforePartial.version, refreshReports: false, operationId: 'partial-roster-123456789012345',
  tables: { members: beforePartial.db.members.map(m => ({ ...m, name: '欲更改名字' })) } });
freshRoster.getRange = savedRange;
ok('a confirmed administrative save reports a failed shared roster update instead of claiming full success',
  failedRosterMirror.success === true && failedRosterMirror.rosterSyncPending === true
    && /名冊/.test(failedRosterMirror.warning || '') && freshRoster._rows[1][1] === '原名字',
  JSON.stringify(failedRosterMirror));
const partialReceipt = freshNode.post({ action: 'operationStatus', operationId: 'partial-roster-123456789012345' });
ok('partial roster update is recorded as unknown, never as a fully applied operation',
  failedRosterMirror.outcome === 'unknown' && failedRosterMirror.mayHaveApplied === true
    && partialReceipt.outcome === 'unknown', JSON.stringify({ result: failedRosterMirror, receipt: partialReceipt }));

const revisionNode = makeNode();
revisionNode.context.initializeSheets();
const revisionAdmin = revisionNode.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changeme' });
const revisionBefore = revisionNode.post({ action: 'loadTables', unit: '0082', sessionToken: revisionAdmin.sessionToken });
const realSnapshot = revisionNode.context.unifiedAdminSnapshot_;
let snapshotCalls = 0;
revisionNode.context.unifiedAdminSnapshot_ = (...args) => {
  snapshotCalls++;
  return snapshotCalls === 2 ? { success: false, error: 'simulated revision read failure' } : realSnapshot(...args);
};
const revisionFailure = revisionNode.post({ action: 'saveTables', unit: '0082', sessionToken: revisionAdmin.sessionToken,
  baseVersion: revisionBefore.version, refreshReports: false, operationId: 'revision-failure-1234567890', tables: { notices: [] } });
revisionNode.context.unifiedAdminSnapshot_ = realSnapshot;
const revisionReceipt = revisionNode.post({ action: 'operationStatus', operationId: 'revision-failure-1234567890' });
ok('a committed save with a failed revision read stays unknown in the operation journal',
  revisionFailure.success === true && revisionFailure.revisionPending === true
    && revisionFailure.outcome === 'unknown' && revisionReceipt.outcome === 'unknown',
  JSON.stringify({ result: revisionFailure, receipt: revisionReceipt }));

const mirrorNode = makeNode();
mirrorNode.context.initializeSheets();
const mirrorAdmin = mirrorNode.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changeme' });
const mirrorBefore = mirrorNode.post({ action: 'loadDb', unit: '0082', sessionToken: mirrorAdmin.sessionToken });
const simpleSheet = mirrorNode.sheets.get('資料表');
const simpleRange = simpleSheet.getRange;
simpleSheet.getRange = (row, col, nr, nc) => {
  const range = simpleRange(row, col, nr, nc);
  if (row > 1 && col === 1) range.setValues = () => { throw new Error('simulated simple mirror failure'); };
  return range;
};
const mirrorFailure = mirrorNode.post({ action: 'saveDb', unit: '0082', sessionToken: mirrorAdmin.sessionToken,
  operationId: 'blob-mirror-failure-123456789', baseVersion: mirrorBefore.version, refreshReports: false,
  db: { ...mirrorBefore.db, notices: [{ id: 'saved-in-blob' }] } });
simpleSheet.getRange = simpleRange;
const mirrorReceipt = mirrorNode.post({ action: 'operationStatus', operationId: 'blob-mirror-failure-123456789' });
ok('blob committed but table mirror failed is unknown rather than falsely not applied',
  mirrorFailure.success === false && mirrorFailure.writePending === true && mirrorFailure.outcome === 'unknown'
    && mirrorReceipt.outcome === 'unknown' && JSON.stringify(mirrorNode.sheets.get('資料庫')._rows).includes('saved-in-blob'),
  JSON.stringify({ result: mirrorFailure, receipt: mirrorReceipt }));

/* Delegated staff must not inherit an unrestricted server write simply because
   Portal-only tables have never been saved. The shared Users/roster already exist. */
const firstDelegated = makeNode();
firstDelegated.context.initializeSheets();
firstDelegated.sheets.get('成員名單').appendRow(['9000000066', '執委', '2026-01-01', 'VS', 'exco@example.test']);
firstDelegated.sheets.get('Users').appendRow(['9000000066', '執委', 'exco@example.test', 'exec_committee',
  sha256('excosecret9'), 'VS', false, 'existing', '2026-01-01', '2026-01-01', '', 'active', '', false]);
const firstExco = firstDelegated.post({ action: 'authLogin', unit: '0082', username: 'exco@example.test', password: 'excosecret9' });
const firstView = firstDelegated.post({ action: 'loadTables', unit: '0082', sessionToken: firstExco.sessionToken });
const firstForbidden = firstDelegated.post({ action: 'saveTables', unit: '0082', sessionToken: firstExco.sessionToken,
  baseVersion: firstView.version, refreshReports: false, tables: { permOverrides: { 'member.create': { exco: 1 } } } });
ok('first delegated write cannot bypass permission checks on an empty Portal store',
  firstExco.success === true && firstView.success === true && firstForbidden.success === false,
  JSON.stringify({ login: firstExco, view: firstView, write: firstForbidden }));

const directNode = makeNode();
directNode.context.initializeSheets();
directNode.sheets.get('成員名單').appendRow(['9000000088', '已有 BADGE 團員', '2025-01-01', 'VS', '']);
const directAdmin = directNode.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changeme' });
const directBefore = directNode.post({ action: 'loadTables', unit: '0082', sessionToken: directAdmin.sessionToken });
for (const invalidVersion of ['', 'legacy-version', 'U-not-a-digest']) {
  const denied = directNode.post({ action: 'saveTables', unit: '0082', sessionToken: directAdmin.sessionToken,
    baseVersion: invalidVersion, refreshReports: false,
    tables: { members: directBefore.db.members.map(m => ({ ...m, name: '不得寫入' })) } });
  ok('normal write rejects missing or invalid shared revision: ' + JSON.stringify(invalidVersion),
    denied.success === false && denied.conflict === true && denied.code === 'SHARED_REVISION_REQUIRED'
      && directNode.sheets.get('成員名單')._rows[1][1] === '已有 BADGE 團員', JSON.stringify(denied));
}
for (const [action, extra] of [
  ['saveDb', { db: directBefore.db }],
  ['saveDbPart', { saveId: '0082-stg-no-revision', partIdx: 0, parts: 1, data: directBefore.db }],
  ['saveDbCommit', { saveId: '0082-stg-no-revision', parts: 1 }]
]) {
  const denied = directNode.post({ action, unit: '0082', sessionToken: directAdmin.sessionToken,
    baseVersion: '', refreshReports: false, ...extra });
  ok(action + ' cannot bypass the required shared revision', denied.success === false && denied.conflict === true,
    JSON.stringify(denied));
}
const directSave = directNode.post({ action: 'saveTables', unit: '0082', sessionToken: directAdmin.sessionToken,
  baseVersion: directBefore.version, refreshReports: false,
  tables: { members: directBefore.db.members.map(m => ({ ...m, name: 'Portal 已更新' })) } });
const directAfter = directNode.post({ action: 'loadTables', unit: '0082', sessionToken: directAdmin.sessionToken });
const directBadge = directNode.post({ action: 'getMembers', token: directAdmin.sessionToken });
ok('Portal can save against the shared revision and BADGE immediately reads the same updated roster',
  directSave.success === true && directSave.confirmed === true
    && directSave.version === directAfter.version
    && directAfter.db.members.some(m => m.ymis === '9000000088' && m.name === 'Portal 已更新')
    && directBadge.members?.some(m => m.ymis === '9000000088' && m.name === 'Portal 已更新'),
  JSON.stringify({ saved: directSave, badge: directBadge }));
/* Simulate another BADGE writer immediately after the administrative lock is
   released. The save's revision must not claim that unseen newer state. */
directNode.lockStats.onRelease = () => {
  if (directNode.sheets.get('成員名單')._rows[1][1] !== 'Portal 本次儲存') return;
  directNode.lockStats.onRelease = null;
  directNode.sheets.get('成員名單').getRange(2, 2).setValue('另一寫入');
};
const racingSave = directNode.post({ action: 'saveTables', unit: '0082', sessionToken: directAdmin.sessionToken,
  baseVersion: directAfter.version, refreshReports: false,
  tables: { members: directAfter.db.members.map(m => ({ ...m, name: 'Portal 本次儲存' })) } });
directNode.lockStats.onRelease = null;
const racingRead = directNode.post({ action: 'loadTables', unit: '0082', sessionToken: directAdmin.sessionToken });
ok('write revision represents the state inside its lock, not an unseen subsequent BADGE edit',
  racingSave.success === true && racingSave.version.startsWith('U-')
    && racingRead.db.members.some(m => m.name === '另一寫入') && racingSave.version !== racingRead.version,
  JSON.stringify({ saved: racingSave, read: racingRead }));
const unsafeSync = directNode.post({ action: 'sync', unit: '0082', sessionToken: directAdmin.sessionToken,
  db: directAfter.db, baseVersion: directAfter.version });
ok('legacy combined report sync cannot write a stale administrative database',
  unsafeSync.success === false && /saveDb|saveTables/.test(unsafeSync.error || '')
    && directNode.sheets.get('成員名單')._rows[1][1] === '另一寫入', JSON.stringify(unsafeSync));
const stagedDb = { ...racingRead.db, accounts: [{ id: 'evil', username: 'not-real', password: 'do-not-store' }] };
const goodPart = directNode.post({ action: 'saveDbPart', unit: '0082', sessionToken: directAdmin.sessionToken,
  baseVersion: racingRead.version, saveId: '0082-stg-valid-shared', partIdx: 0, parts: 1, data: stagedDb });
const goodCommit = directNode.post({ action: 'saveDbCommit', unit: '0082', sessionToken: directAdmin.sessionToken,
  baseVersion: racingRead.version, saveId: '0082-stg-valid-shared', parts: 1, refreshReports: false });
const afterStaged = directNode.post({ action: 'loadDb', unit: '0082', sessionToken: directAdmin.sessionToken });
ok('staged shared-revision commit succeeds and never persists a second client-supplied account or password',
  goodPart.success === true && goodCommit.success === true && goodCommit.version === afterStaged.version
    && !JSON.stringify(directNode.sheets.get('資料表')._rows).includes('do-not-store')
    && !JSON.stringify(directNode.sheets.get('資料庫')._rows).includes('do-not-store')
    && !afterStaged.db.accounts.some(a => a.username === 'not-real'), JSON.stringify({ goodPart, goodCommit }));
const directDelete = directNode.post({ action: 'deleteUser', token: directAdmin.sessionToken, target_ymis: '9000000088' });
const directAfterDelete = directNode.post({ action: 'loadTables', unit: '0082', sessionToken: directAdmin.sessionToken });
const directSaveAfterDelete = directNode.post({ action: 'saveTables', unit: '0082', sessionToken: directAdmin.sessionToken,
  baseVersion: directAfterDelete.version, refreshReports: false, tables: { members: directAfterDelete.db.members } });
ok('BADGE deletion of a roster-only member is not revived by an older administrative copy',
  directDelete.success === true && directAfterDelete.success === true
    && !directAfterDelete.db.members.some(m => m.ymis === '9000000088')
    && directSaveAfterDelete.success === true
    && !directNode.sheets.get('成員名單')._rows.some(r => String(r[0]) === '9000000088'),
  JSON.stringify({ deleted: directDelete, saved: directSaveAfterDelete }));
const directReadd = directNode.post({ action: 'addMember', token: directAdmin.sessionToken,
  ymis: '9000000088', name: '再次新增', branch: 'VS' });
const directAfterReadd = directNode.post({ action: 'loadTables', unit: '0082', sessionToken: directAdmin.sessionToken });
ok('an explicit BADGE re-add is visible again through Portal', directReadd.success === true
  && directAfterReadd.db.members.some(m => m.ymis === '9000000088' && m.name === '再次新增'));

/* Schema observed in the user-provided test Sheet, with synthetic data only:
   BADGE has additional squad columns which an in-place upgrade must preserve. */
const squadNode = makeNode();
const squadHeaders = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date',
  'created_at','last_login','status','allowed_badges','squad','squad_role','force_change_password'];
squadNode.sheets.set('Users', makeSheet('Users', [squadHeaders,
  ['1111111111','測試管理員','admin@example.com','admin',sha256('changeme'),'b4',true,'system','','','','active','*','行政','主管',false],
  ['9000000055','測試成員','member55@example.test','member',sha256('memberpass9'),'VS',false,'system','','','','active','','獵鷹','隊員',false]
]));
squadNode.sheets.set('成員名單', makeSheet('成員名單', [
  ['YMIS','姓名','加入日期','支部','聯絡','小隊'], ['9000000055','測試成員','2025-01-01','VS','member55@example.test','獵鷹']
]));
squadNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [['YMIS','項目 ID','完成日期','更新時間','確認者','備註']]));
const squadUsersBefore = JSON.stringify(squadNode.sheets.get('Users')._rows);
const squadRosterBefore = JSON.stringify(squadNode.sheets.get('成員名單')._rows);
const squadInit = squadNode.context.initializeSheets();
ok('observed extra squad columns and all existing synthetic cells survive initialization', squadInit.success === true
  && JSON.stringify(squadNode.sheets.get('Users')._rows) === squadUsersBefore
  && JSON.stringify(squadNode.sheets.get('成員名單')._rows) === squadRosterBefore, JSON.stringify(squadInit));
const squadAdmin = squadNode.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changeme' });
const squadRead = squadNode.post({ action: 'loadTables', unit: '0082', sessionToken: squadAdmin.sessionToken });
const squadSave = squadNode.post({ action: 'saveTables', unit: '0082', sessionToken: squadAdmin.sessionToken,
  baseVersion: squadRead.version, refreshReports: false,
  tables: { members: squadRead.db.members.map(m => ({ ...m, name: '修改姓名' })) } });
const squadMemberRow = squadNode.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000055');
ok('Portal roster update leaves extra BADGE squad and squad-role cells untouched', squadSave.success === true
  && squadNode.sheets.get('成員名單')._rows[1][5] === '獵鷹' && squadMemberRow[13] === '獵鷹'
  && squadMemberRow[14] === '隊員' && squadMemberRow[15] === false, JSON.stringify(squadSave));

/* Upgrade an existing BADGE Sheet, including history which the upstream v9.6
   initializer normally cleans up. Runtime rejection of reserved legacy tokens
   remains in force even though the historical cells are not deleted. */
const upgradeNode = makeNode();
upgradeNode.sheets.set('Users', makeSheet('Users', [USER_HEADERS,
  ['1234567890', '原有團員', 'member@example.test', 'member', sha256('changeme'), 'b4', false, 'sheep', '2025', '2025', '', 'active', '', false],
  ['sheep', '舊保留列', 'sheep@vsbadge.local', 'super_admin', 'old-hash', 'b4', true, 'sheep', '', '', '', 'active', '*', false]
]));
upgradeNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [
  ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者'],
  ['1234567890', 'OLD-1', '2025', '2025', 'sheep'],
  ['sheep', 'OLD-2', '2025', '2025', 'leader']
]));
upgradeNode.sheets.set('成員名單', makeSheet('成員名單', [
  ['YMIS','姓名','加入日期','支部','聯絡'], ['sheep','歷史資料','2025','VS','']
]));
upgradeNode.sheets.set('Tokens', makeSheet('Tokens', [
  ['token','ymis','created_at','expires_at'], ['legacy-reserved-token','sheep','2025','2099-01-01']
]));
upgradeNode.sheets.set('操作紀錄', makeSheet('操作紀錄', [
  ['時間','操作者','操作','對象','詳情'], ['2025','sheep','old-action','1234567890','keep']
]));
const beforeUpgrade = new Map([...upgradeNode.sheets].map(([name, sheet]) =>
  [name, sheet._rows.map(row => Array.from(row))]));
const upgradeResult = upgradeNode.context.initializeSheets();
ok('existing BADGE upgrade succeeds without a separate Sheet', upgradeResult.success === true, JSON.stringify(upgradeResult));
ok('upgrade preserves every pre-existing cell including historical audit and reserved rows',
  [...beforeUpgrade].every(([name, rows]) => rows.every((row, i) =>
    row.every((value, j) => upgradeNode.sheets.get(name)._rows[i]?.[j] === value))));
ok('upgrade appends missing progress header without overwriting the existing fifth column',
  upgradeNode.sheets.get('進度追蹤')._rows[0][4] === '確認者'
    && upgradeNode.sheets.get('進度追蹤')._rows[0][5] === '備註');
ok('upgrade does not seed another account into an existing Users sheet',
  upgradeNode.sheets.get('Users')._rows.length === beforeUpgrade.get('Users').length);
ok('preserved legacy reserved token remains invalid', upgradeNode.context.validateToken('legacy-reserved-token') === null);
upgradeNode.sheets.get('操作紀錄').appendRow(['2025', 'normal-user', 'normal-action', '1234567890', 'ordinary']);
const auditView = JSON.parse(upgradeNode.context.handleGetAuditLog().getContent());
ok('retained reserved audit rows stay hidden without deleting ordinary or historical rows',
  auditView.records.some(row => row[2] === 'normal-action')
    && !auditView.records.some(row => row[2] === 'old-action')
    && upgradeNode.sheets.get('操作紀錄')._rows.some(row => row[2] === 'old-action'));
const reservedNode = makeNode();
reservedNode.context.initializeSheets();
reservedNode.sheets.get('Users').appendRow([
  '7777777777', '舊角色列', 'legacy-role@example.test', 'super_admin', sha256('oldsecret'), 'b4', true, 'old', '', '', '', 'active', '*', false
]);
reservedNode.sheets.get('Users').appendRow([
  '8888888888', '舊電郵列', 'sheep@vsbadge.local', 'admin', sha256('oldsecret'), 'b4', true, 'old', '', '', '', 'active', '*', false
]);
reservedNode.sheets.get('Tokens').appendRow(['old-role-token', '7777777777', '', '2099-01-01']);
reservedNode.sheets.get('Tokens').appendRow(['old-email-token', '8888888888', '', '2099-01-01']);
ok('retained reserved role and reserved email rows cannot authenticate by YMIS through either frontend',
  ['7777777777', '8888888888'].every(id =>
    reservedNode.post({ action: 'login', login_id: id, password: 'oldsecret' }).success === false
    && reservedNode.post({ action: 'authLogin', unit: '0082', username: id, password: 'oldsecret' }).success === false));
ok('retained reserved role and email rows cannot authorise existing local sessions or writes',
  ['old-role-token', 'old-email-token'].every(token =>
    reservedNode.context.validateToken(token) === null
    && reservedNode.post({ action: 'requestComplete', token, items: [{ itemId: 'no-write' }] }).success === false));
const reservedRowsBeforeMirror = reservedNode.sheets.get('Users')._rows.length;
ok('isolated assertion fixture cannot resurrect or duplicate a retained reserved account',
  reservedNode.context.unifiedEnsureCentralUser_({ ymis: '7777777777', name: 'old', contact: 'legacy-role@example.test' }, 'leader') === null
    && reservedNode.context.unifiedEnsureCentralUser_({ ymis: '8888888888', name: 'old', contact: 'sheep@vsbadge.local' }, 'leader') === null
    && reservedNode.context.unifiedEnsureCentralUser_({ ymis: '9999999999', name: 'old', contact: 'legacy-role@example.test' }, 'leader') === null
    && reservedNode.sheets.get('Users')._rows.length === reservedRowsBeforeMirror);
ok('upgrade preserves the existing key', upgradeNode.props.get('API_KEY') === 'existing-api-key-do-not-change');
const unchangedUsers = JSON.stringify(upgradeNode.sheets.get('Users')._rows);
const repeatUpgrade = upgradeNode.context.initializeSheets();
ok('repeated upgrade preserves existing account rows', repeatUpgrade.success === true
  && JSON.stringify(upgradeNode.sheets.get('Users')._rows) === unchangedUsers);
const defaultLogin = upgradeNode.post({ action: 'login', login_id: '1234567890', password: 'changeme' });
ok('default password still requires a change at login without rewriting flags during upgrade',
  defaultLogin.success === true && defaultLogin.force_change_password === true, JSON.stringify(defaultLogin));

const malformedNode = makeNode();
malformedNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [['錯誤表頭', 'existing'], ['do-not-touch', 'value']]));
malformedNode.props.set('UNIFIED_GS_INITIALIZED_VERSION', 'v9.8');
const malformedBefore = JSON.stringify(malformedNode.sheets.get('進度追蹤')._rows);
const malformedResult = malformedNode.context.initializeSheets();
ok('unexpected BADGE progress headers fail preflight before adding or changing any sheets',
  malformedResult.success === false && /表頭/.test(malformedResult.error || '')
    && malformedNode.sheets.size === 1 && JSON.stringify(malformedNode.sheets.get('進度追蹤')._rows) === malformedBefore
    && !malformedNode.props.has('UNIFIED_GS_INITIALIZED_VERSION'));
const customHeaderNode = makeNode();
customHeaderNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [
  ['YMIS','項目 ID','完成日期','更新時間','自訂確認者'], ['1234567890','OLD','2025','2025','keep']
]));
const customHeaderBefore = JSON.stringify(customHeaderNode.sheets.get('進度追蹤')._rows);
const customHeaderResult = customHeaderNode.context.initializeSheets();
ok('custom progress column is never overwritten or silently treated as BADGE schema',
  customHeaderResult.success === false && customHeaderNode.sheets.size === 1
    && JSON.stringify(customHeaderNode.sheets.get('進度追蹤')._rows) === customHeaderBefore);
const malformedUsersNode = makeNode();
malformedUsersNode.sheets.set('Users', makeSheet('Users', [['unexpected'], ['keep']]));
const malformedUsersResult = malformedUsersNode.context.initializeSheets();
ok('unrecognized Users headers fail preflight before changes', malformedUsersResult.success === false
  && /Users/.test(malformedUsersResult.error || '') && malformedUsersNode.sheets.size === 1);
const skippedNode = makeNode();
const upgradeAlerts = [], upgradeLogs = [];
skippedNode.context.SpreadsheetApp.getUi = () => ({ ButtonSet: { OK: 'OK' },
  alert: (...args) => upgradeAlerts.push(args) });
skippedNode.context.Logger.log = value => upgradeLogs.push(String(value));
skippedNode.sheets.set('帳目', makeSheet('帳目', [['custom header'], ['keep']]));
skippedNode.props.set('UNIFIED_GS_INITIALIZED_VERSION', 'v9.8');
const skippedResult = skippedNode.context.initializeSheets();
ok('unrecognized administrative sheet is reported as partial, not marked complete',
  skippedResult.success === false && skippedResult.partial === true && /帳目/.test(skippedResult.error || '')
    && !skippedNode.props.has('UNIFIED_GS_INITIALIZED_VERSION')
    && skippedNode.sheets.get('帳目')._rows[1][0] === 'keep', JSON.stringify(skippedResult));
ok('partial initialization displays one failure, not premature success messages',
  upgradeAlerts.length === 1 && /未完成/.test(upgradeAlerts[0][0]) && /帳目/.test(upgradeAlerts[0][1]),
  JSON.stringify(upgradeAlerts));
ok('candidate initialization does not log the existing API key',
  !upgradeLogs.join(' ').includes('existing-api-key-do-not-change'));

node.sheets.set('Users', makeSheet('Users', [
  USER_HEADERS,
  ['1111111111', '既有管理員', 'admin@example.com', 'admin', sha256('changeme'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', true]
]));
node.sheets.set('進度追蹤', makeSheet('進度追蹤', [
  ['YMIS','項目 ID','完成日期','更新時間','確認者','備註'],
  ['9000000001', 'L1-KEEP', '2026-01-01', '2026-01-01', 'leader', 'must survive']
]));
node.sheets.set('成員名單', makeSheet('成員名單', [
  ['YMIS','姓名','加入日期','支部','聯絡'],
  ['9000000001', '中央團員', '2025-01-01', 'VS', 'member@example.test'],
  ['9000000002', '中央領袖', '2025-01-01', 'VS', 'leader@example.test']
]));

const initialized = node.context.initializeSheets();
ok('combined initializer succeeds', initialized.success === true, JSON.stringify(initialized));
ok('initializer preserves existing API key', node.props.get('API_KEY') === 'existing-api-key-do-not-change');
ok('initializer does not create or require a separate PORTAL_SESSION_SECRET', !node.props.has('PORTAL_SESSION_SECRET'));
ok('initializer preserves an unset BADGE local-login flag', !node.props.has('ALLOW_LOCAL_LOGIN'));
const closedFlagNode = makeNode();
closedFlagNode.props.set('ALLOW_LOCAL_LOGIN', 'false');
const closedFlagInit = closedFlagNode.context.initializeSheets();
ok('initializer preserves an explicitly closed BADGE local-login flag',
  closedFlagInit.success === true && closedFlagNode.props.get('ALLOW_LOCAL_LOGIN') === 'false');
ok('initializer preserves existing progress row', node.sheets.get('進度追蹤')._rows.some(r => r[1] === 'L1-KEEP' && r[5] === 'must survive'));
ok('initializer records isolated unified version', node.props.get('UNIFIED_GS_INITIALIZED_VERSION') === 'v9.8');
ok('initializer adds administrative tabs without replacing progress baseline', node.sheets.has('資料表') && node.sheets.has('Users') && node.sheets.has('活動履歷'));

/* One action dispatcher reads the different Progress tabs from this same active Sheet. */
node.sheets.get('其他獎章').appendRow(['9000000001', 'OB-1', '急救章', '2026-02-01', 'CERT-1', '', '2026-02-01']);
node.sheets.get('待批完成').appendRow(['REQ-1', '9000000002', '中央領袖', 'L1-PENDING', '待批項目', '2026-02-02', '', 'pending', '2026-02-03']);
node.sheets.get('活動履歷').appendRow(['LOG-1', 'service', '9000000001', '中央團員', '2026-02-04', '社區服務', '組員', '2', '', '', 'leader', '2026-02-05', '2026-02-05']);
node.sheets.get('待批履歷').appendRow(['LOGREQ-1', 'new', '', 'service', '9000000002', '中央領袖', '2026-02-06', '待批服務', '組員', '1', '', '', 'pending', '2026-02-07', '', '', '']);
const unifiedLoadRequest = signedRequest('load', { unit: '0082' });
const unifiedLoad = node.post(unifiedLoadRequest.body, unifiedLoadRequest.parameter);
ok('one Unified load action returns normal members and progress from the same active Sheet',
  unifiedLoad.success === true
    && unifiedLoad.members.some(member => member.ymis === '9000000001')
    && unifiedLoad.progress['9000000001']?.['L1-KEEP']?.note === 'must survive',
  JSON.stringify(unifiedLoad));
ok('the same Unified load action reads each Progress tab instead of treating tabs as separate backends',
  unifiedLoad.otherBadges['9000000001']?.['OB-1']?.name === '急救章'
    && unifiedLoad.pendingRequests.some(request => request.request_id === 'REQ-1')
    && unifiedLoad.logs.some(log => log.record_id === 'LOG-1')
    && unifiedLoad.logRequests.some(request => request.request_id === 'LOGREQ-1'),
  JSON.stringify(unifiedLoad));

/* BOOK may submit import candidates, but requestComplete must stop in the pending tab.
   Only a real branch leader/admin review may turn that candidate into an official record. */
const bookImportRequest = signedRequest('requestComplete', {
  on_behalf: '9000000001', on_behalf_role: 'member', on_behalf_name: 'VSBOOK',
  items: [{ itemId: 'L1-BOOK-IMPORT', itemName: 'BOOK 匯入候選',
    requested_date: '2026-02-08', evidence: 'book-import-test' }]
});
const bookImport = node.post(bookImportRequest.body, bookImportRequest.parameter);
const bookPendingRow = node.sheets.get('待批完成')._rows.find(row => String(row[0]) === String(bookImport.request_id));
ok('BOOK import is accepted only as a pending candidate, not an official progress record',
  bookImport.success === true && bookPendingRow?.[7] === 'pending'
    && !node.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001' && row[1] === 'L1-BOOK-IMPORT'),
  JSON.stringify(bookImport));
const bookReviewerYmis = '2222222222';
node.sheets.get('Users').appendRow([
  bookReviewerYmis, 'BOOK 匯入確認領袖', 'book-reviewer@example.test', 'branch_leader',
  sha256('bookleader9'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', false
]);
const bookReviewerLogin = node.post({ action: 'login', login_id: bookReviewerYmis, password: 'bookleader9' });
const troopRead = node.post({ action: 'progressAll', token: bookReviewerLogin.token });
ok('BADGE progressAll returns the full same-Sheet projection to an authenticated leader',
  troopRead.success === true && troopRead.viewScope === 'troop' && troopRead.gsVersion === 'v9.8'
    && troopRead.progress?.['9000000001']?.['L1-KEEP']?.note === 'must survive'
    && troopRead.pendingRequests.some(item => item.request_id === 'REQ-1'));
ok('BADGE progressAll denies anonymous and forged sessions',
  node.post({ action: 'progressAll' }).success === false
    && node.post({ action: 'progressAll', token: 'forged' }).success === false);
node.sheets.get('Users').appendRow([
  '3333333333', '測試成員', 'member333@example.test', 'member', sha256('member333'), 'b4', false,
  'existing', '2026-01-01', '2026-01-01', '', 'active', '', false
]);
const troopMember = node.post({ action: 'login', login_id: '3333333333', password: 'member333' });
const deniedTroopRead = node.post({ action: 'progressAll', token: troopMember.token });
ok('BADGE progressAll denies member by default', troopMember.success === true
  && deniedTroopRead.success === false && deniedTroopRead.code === 'TROOP_VIEW_DENIED');
const allowRow = node.sheets.get('SystemConfig')._rows.findIndex(row => row[0] === 'allow_member_view_others');
node.sheets.get('SystemConfig').getRange(allowRow + 1, 2).setValue('true');
const allowedTroopRead = node.post({ action: 'progressAll', token: troopMember.token });
ok('BADGE progressAll honors the explicit member-view-others configuration',
  allowedTroopRead.success === true && allowedTroopRead.viewScope === 'troop'
    && allowedTroopRead.progress?.['9000000001']?.['L1-KEEP']?.note === 'must survive');
node.sheets.get('SystemConfig').getRange(allowRow + 1, 2).setValue('false');
node.context.destroyToken(troopMember.token);
node.sheets.get('Users').deleteRow(node.sheets.get('Users')._rows.findIndex(row => row[0] === '3333333333') + 1);
const bookReview = node.post({ action: 'reviewRequest', token: bookReviewerLogin.token,
  request_id: bookImport.request_id, decision: 'approved', review_note: '領袖確認 BOOK 匯入',
  confirmed_date: '2026-02-09' });
ok('BOOK import becomes official only after an authenticated branch leader review',
  bookReviewerLogin.success === true && bookReviewerLogin.user?.role === 'branch_leader'
    && bookReview.success === true
    && node.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001'
      && row[1] === 'L1-BOOK-IMPORT' && row[2] === '2026-02-09'),
  JSON.stringify(bookReview));

/* Full frontend bulk approval is one signed action.  It may contain normal Progress
   and activity-log rows, but validates the complete selection before the first write. */
node.sheets.get('待批完成').appendRow([
  'REQ-BULK-1', '9000000001', '中央團員', 'L1-BULK', '批量進度', '2026-02-10', '', 'pending', '2026-02-10', '', '', '', ''
]);
const bulkReviewRequest = signedRequest('bulkReviewRequests', {
  unit: '0082', sessionToken: bookReviewerLogin.token,
  requests: [
    { kind: 'req', request_id: 'REQ-BULK-1' },
    { kind: 'log', request_id: 'LOGREQ-1' }
  ], decision: 'approved', confirmed_date: '2026-02-11'
});
const bulkReview = node.post(bulkReviewRequest.body, bulkReviewRequest.parameter);
ok('one signed bulkReviewRequests action approves mixed Progress and log selections',
  bulkReview.success === true && bulkReview.processed === 2
    && bulkReview.progressRequests === 1 && bulkReview.logRequests === 1,
  JSON.stringify(bulkReview));
ok('bulk approval writes both destinations and closes both pending rows',
  node.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001'
    && row[1] === 'L1-BULK' && row[2] === '2026-02-11')
  && node.sheets.get('活動履歷')._rows.some(row => row[5] === '待批服務')
  && node.sheets.get('待批完成')._rows.find(row => row[0] === 'REQ-BULK-1')?.[7] === 'approved'
  && node.sheets.get('待批履歷')._rows.find(row => row[0] === 'LOGREQ-1')?.[12] === 'approved');
const emptyBulkRequest = signedRequest('bulkReviewRequests', {
  unit: '0082', sessionToken: bookReviewerLogin.token, requests: [], decision: 'approved'
});
const emptyBulk = node.post(emptyBulkRequest.body, emptyBulkRequest.parameter);
ok('bulk approval rejects an empty selection before writing',
  emptyBulk.success === false && emptyBulk.code === 'NO_SELECTION');
node.context.destroyToken(bookReviewerLogin.token);
const bookReviewerRow = node.sheets.get('Users')._rows.findIndex(row => row[0] === bookReviewerYmis);
if (bookReviewerRow >= 0) node.sheets.get('Users').deleteRow(bookReviewerRow + 1);

node.props.set('ALLOW_LOCAL_LOGIN', 'true');
const unsignedState = node.post({ action: 'getLinkState' });
const unsignedToggle = node.post({ action: 'setLocalLogin', allow: false });
ok('BADGE entrance state and controls are unavailable to unsigned callers', unsignedState.success !== true
  && unsignedToggle.success !== true && node.props.get('ALLOW_LOCAL_LOGIN') === 'true');
const toggleRequest = signedRequest('setLocalLogin', { allow: false });
const toggle = node.post(toggleRequest.body, toggleRequest.parameter);
const replayToggle = node.post(toggleRequest.body, toggleRequest.parameter);
ok('valid BADGE signed entrance control works and rejects a replay',
  toggle.success === true && replayToggle.success !== true && node.props.get('ALLOW_LOCAL_LOGIN') === 'false', JSON.stringify(toggle));
const stateRequest = signedRequest('getLinkState', {});
const state = node.post(stateRequest.body, stateRequest.parameter);
ok('valid BADGE signature can inspect the existing entrance state',
  state.success === true && state.allow_local_login === false, JSON.stringify(state));
const rescueToken = node.context.superAdminSessionToken();
const rescueLoad = JSON.parse(node.context.doGet({ parameter: { action: 'load', token: rescueToken } }).getContent());
const fakeRescue = JSON.parse(node.context.doGet({ parameter: { action: 'load', token: rescueToken + 'bad' } }).getContent());
ok('valid BADGE stateless rescue session can load while closed; a forged token cannot',
  rescueLoad.success === true && fakeRescue.success === false, JSON.stringify({ rescueLoad, fakeRescue }));
const reopenRequest = signedRequest('setLocalLogin', { allow: true });
const reopened = node.post(reopenRequest.body, reopenRequest.parameter);
ok('valid signed BADGE control reopens the same shared login gate', reopened.success === true
  && node.props.get('ALLOW_LOCAL_LOGIN') === 'true');

/* A header-only progress tab is a successful zero-record action result. */
const emptyProgressNode = makeNode();
const emptyInitialized = emptyProgressNode.context.initializeSheets();
emptyProgressNode.sheets.get('成員名單').appendRow(['9000000099', '空進度團員', '2026-01-01', 'VS', 'empty@example.test']);
const emptyLoadRequest = signedRequest('load', { unit: '0082' });
const emptyLoad = emptyProgressNode.post(emptyLoadRequest.body, emptyLoadRequest.parameter);
ok('header-only progress tab returns success, a normal member, and zero progress records',
  emptyInitialized.success === true && emptyLoad.success === true
    && emptyLoad.members.some(member => member.ymis === '9000000099')
    && Object.keys(emptyLoad.progress || {}).length === 0,
  JSON.stringify(emptyLoad));
ok('Progress load response contains business data only, not integration or entrance state',
  !Object.prototype.hasOwnProperty.call(emptyLoad, 'allow_local_login')
    && !Object.prototype.hasOwnProperty.call(emptyLoad, 'link_flag_set')
    && !Object.prototype.hasOwnProperty.call(emptyLoad, 'upstream_only'),
  JSON.stringify(emptyLoad));

const forgot = node.post({ action: 'authForgotPassword', unit: '0082', email: 'admin@example.com' });
const forgotMailBody = String(node.mail[0]?.[0]?.body || '');
const forgotCode = (/重設碼：(\d{8})/.exec(forgotMailBody) || [])[1] || '';
ok('unified forgot-password uses pinned baseline code flow and tells Portal to show code form',
  forgot.success === true && forgot.resetMode === 'code' && !!forgotCode, JSON.stringify(forgot));
const completedForgot = node.post({ action: 'authCompletePasswordReset', unit: '0082',
  email: 'admin@example.com', code: forgotCode, newPassword: 'changed99' });
ok('unified code completion resets baseline credential without exposing legacy Portal token flow',
  completedForgot.success === true && completedForgot.ok === true, JSON.stringify(completedForgot));
const completedForgotReplay = node.post({ action: 'authCompletePasswordReset', unit: '0082',
  email: 'admin@example.com', code: forgotCode, newPassword: 'changed98' });
ok('unified password-reset code is single-use', completedForgotReplay.success === false);

/* The full branch frontend account aliases write pinned BADGE Users directly; no
   Portal accounts/password collection is created. */
const accountAdmin = node.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changed99' });
/* An empty administrative store must not hide roster and Users already present
   in the same BADGE Sheet; reads are a projection, not an account copy. */
const rosterBeforeReadDiagnostic = JSON.stringify(node.sheets.get('成員名單')._rows);
const usersBeforeReadDiagnostic = JSON.stringify(node.sheets.get('Users')._rows);
const emptyAdministrativeRead = node.post({ action: 'loadTables', unit: '0082', sessionToken: accountAdmin.sessionToken });
const emptyBlobRead = node.post({ action: 'loadDb', unit: '0082', sessionToken: accountAdmin.sessionToken });
ok('empty administrative storage still reads the existing BADGE roster from the same backend',
  emptyAdministrativeRead.success === true && emptyAdministrativeRead.found === true
    && emptyAdministrativeRead.db?.members?.some(m => m.ymis === '9000000001')
    && emptyAdministrativeRead.db?.accounts?.some(a => a.ymis === '1111111111'), JSON.stringify(emptyAdministrativeRead));
ok('whole-DB read and table read expose the same existing backend data and revision',
  emptyBlobRead.success === true && emptyBlobRead.found === true
    && emptyBlobRead.version === emptyAdministrativeRead.version
    && JSON.stringify(emptyBlobRead.db) === JSON.stringify(emptyAdministrativeRead.db), JSON.stringify(emptyBlobRead));
ok('diagnostic administrative reads do not alter the existing roster or Users',
  JSON.stringify(node.sheets.get('成員名單')._rows) === rosterBeforeReadDiagnostic
    && JSON.stringify(node.sheets.get('Users')._rows) === usersBeforeReadDiagnostic);
const initialInfo = node.post({ action: 'dbInfo', unit: '0082', sessionToken: accountAdmin.sessionToken });
const initialPart = node.post({ action: 'loadDbPart', unit: '0082', partIdx: 0, sessionToken: accountAdmin.sessionToken });
const firstTablePart = node.post({ action: 'loadTablesPart', unit: '0082', idx: 0, sessionToken: accountAdmin.sessionToken });
ok('dbInfo, segmented read and direct reads share the same revision', initialInfo.found === true
  && initialInfo.version === emptyBlobRead.version && initialPart.version === initialInfo.version
  && firstTablePart.version === initialInfo.version && firstTablePart.found === true
  && JSON.parse(initialPart.part).members.some(m => m.ymis === '9000000001'));
node.sheets.get('成員名單').getRange(2, 2).setValue('BADGE 新名字');
const newerRead = node.post({ action: 'loadTables', unit: '0082', sessionToken: accountAdmin.sessionToken });
const staleFirstSave = node.post({ action: 'saveTables', unit: '0082', sessionToken: accountAdmin.sessionToken,
  baseVersion: emptyBlobRead.version, tables: { members: emptyBlobRead.db.members }, refreshReports: false });
ok('BADGE roster changes appear directly and alter the shared revision',
  newerRead.db?.members?.some(m => m.ymis === '9000000001' && m.name === 'BADGE 新名字')
    && newerRead.version !== emptyBlobRead.version, JSON.stringify(newerRead));
ok('stale Portal write after a BADGE roster change is rejected before any database or roster write',
  staleFirstSave.success === false && staleFirstSave.conflict === true
    && node.sheets.get('成員名單')._rows[1][1] === 'BADGE 新名字'
    && node.sheets.get('資料表')._rows.length === 1, JSON.stringify(staleFirstSave));
node.sheets.get('成員名單').getRange(2, 2).setValue('中央團員');
const rosterBeforeReports = JSON.stringify(node.sheets.get('成員名單')._rows);
node.sheets.set('私人紀錄·0082', makeSheet('私人紀錄·0082', [['keep'], ['historic']]));
const reportSync = node.post({ action: 'sync', unit: '0082', sessionToken: accountAdmin.sessionToken,
  tables: { members: [{ ymis: '9000000001', name: '被錯誤改寫', join: '', role: 'wrong', phone: '' }] } });
ok('report-only sync cannot rewrite the authoritative BADGE member roster',
  (reportSync.success === true || reportSync.ok === true)
    && JSON.stringify(node.sheets.get('成員名單')._rows) === rosterBeforeReports,
  JSON.stringify(reportSync));
ok('report-only sync does not delete pre-existing suffixed worksheets',
  node.sheets.get('私人紀錄·0082')?._rows[1]?.[0] === 'historic');
const ownedReport = node.sheets.get('團員');
const unrelatedReport = makeSheet('團員', [['historical user data'], ['never clear']]);
node.sheets.set('團員', unrelatedReport);
const reportBeforeCollision = JSON.stringify(node.sheets.get('帳目')._rows);
const collisionSync = node.post({ action: 'sync', unit: '0082', sessionToken: accountAdmin.sessionToken,
  tables: { members: [] } });
ok('report sync rejects a replaced, unowned same-name sheet before clearing any report',
  collisionSync.success !== true && collisionSync.ok !== true
    && unrelatedReport._rows[1]?.[0] === 'never clear'
    && JSON.stringify(node.sheets.get('帳目')._rows) === reportBeforeCollision,
  JSON.stringify(collisionSync));
node.sheets.set('團員', ownedReport);
node.sheets.get('成員名單').appendRow(['9000000010', '支部直接開戶', '2026-02-12', 'VS', '']);
const openedAccounts = node.post({
  action: 'authOpenAccounts', unit: '0082', sessionToken: accountAdmin.sessionToken,
  users: [{ ymis: '9000000010', name: '支部直接開戶', role: 'member', password: '1234', branch: 'VS' }]
});
const openedUserRow = node.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000010');
ok('branch leader/admin can directly open an account in pinned Unified Users',
  accountAdmin.success === true && openedAccounts.success === true && openedAccounts.created === 1
    && openedUserRow?.[11] === 'active' && openedUserRow?.[13] === true,
  JSON.stringify(openedAccounts));
const openedLogin = node.post({ action: 'authLogin', unit: '0082', username: '9000000010', password: '1234' });
ok('directly opened account immediately logs in through the normal branch authority',
  openedLogin.success === true && openedLogin.account?.ymis === '9000000010');
const nativeOpenedLogin = node.post({ action: 'login', login_id: '9000000010', password: '1234' });
ok('account created by Portal can also log in using the native BADGE action',
  nativeOpenedLogin.success === true && nativeOpenedLogin.user?.ymis === '9000000010');
const badgeCreated = node.post({ action: 'addUser', token: accountAdmin.sessionToken,
  ymis: '9000000011', name: 'BADGE 新帳戶', email: 'badge-new@example.test',
  role: 'member', password: '3456', branch: 'VS' });
const portalBadgeLogin = node.post({ action: 'authLogin', unit: '0082',
  username: 'badge-new@example.test', password: '3456' });
ok('account created using native BADGE action also logs in through Portal',
  badgeCreated.success === true && portalBadgeLogin.success === true
    && portalBadgeLogin.account?.ymis === '9000000011', JSON.stringify({ badgeCreated, portalBadgeLogin }));
const badgeWho = node.post({ action: 'authWhoAmI', unit: '0082', sessionToken: nativeOpenedLogin.token });
ok('Portal identity action resolves a native BADGE session from the same Users',
  badgeWho.success === true && badgeWho.account?.ymis === '9000000010', JSON.stringify(badgeWho));
const portalChange = node.post({ action: 'authChangePassword', unit: '0082', sessionToken: openedLogin.sessionToken,
  oldPassword: '1234', newPassword: '4321' });
const nativeAfterPortalChange = node.post({ action: 'login', login_id: '9000000010', password: '4321' });
ok('password changed through Portal is immediately accepted by native BADGE login',
  portalChange.success === true && nativeAfterPortalChange.success === true, JSON.stringify(portalChange));
const badgeChange = node.post({ action: 'changePassword', token: portalBadgeLogin.sessionToken,
  old_password: '3456', new_password: '6543' });
const portalAfterBadgeChange = node.post({ action: 'authLogin', unit: '0082', username: '9000000011', password: '6543' });
ok('password changed through native BADGE action is accepted by Portal login',
  badgeChange.success === true && portalAfterBadgeChange.success === true, JSON.stringify(badgeChange));
openedUserRow[3] = 'generic-platform-admin';
const foreignRoleLogin = node.post({ action: 'authLogin', unit: '0082', username: '9000000010', password: '4321' });
ok('unknown backend role fails closed instead of silently becoming member',
  foreignRoleLogin.success === false && foreignRoleLogin.code === 'ROLE_NOT_ALLOWED', JSON.stringify(foreignRoleLogin));
openedUserRow[3] = 'member';
const resetOpened = node.post({ action: 'authResetPassword', unit: '0082',
  sessionToken: accountAdmin.sessionToken, targetYmis: '9000000010', newPassword: '5678' });
ok('full frontend password reset delegates to pinned Users handler', resetOpened.success === true, JSON.stringify(resetOpened));
const disabledOpened = node.post({ action: 'authDeleteAccount', unit: '0082',
  sessionToken: accountAdmin.sessionToken, targetYmis: '9000000010' });
ok('full frontend account removal revokes login but preserves the Users/roster identity',
  disabledOpened.success === true
    && node.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000010')?.[11] === 'inactive'
    && node.sheets.get('成員名單')._rows.some(row => String(row[0]) === '9000000010'),
  JSON.stringify(disabledOpened));
const restoredOpened = node.post({ action: 'authRestoreAccount', unit: '0082',
  sessionToken: accountAdmin.sessionToken, targetYmis: '9000000010', newPassword: '1234' });
ok('full frontend can restore the same Unified Users account with a new temporary password',
  restoredOpened.success === true
    && node.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000010')?.[11] === 'active',
  JSON.stringify(restoredOpened));

const forgedServerSuper = node.post({ action: 'loadTables', unit: '0082', unified_super: true, on_behalf: 'sheep' });
ok('client cannot claim the platform-super server path without a valid branch signature',
  forgedServerSuper.success === false && forgedServerSuper.code === 'SESSION_REQUIRED');
const forgedInternalMarker = node.post({ action: 'loadTables', unit: '0082', __serverSigned: true });
ok('client-supplied compatibility marker is stripped before unified routing',
  forgedInternalMarker.success === false && forgedInternalMarker.code === 'SESSION_REQUIRED');
const serverReadRequest = signedRequest('loadTables', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep'
});
const serverRead = node.post(serverReadRequest.body, serverReadRequest.parameter);
ok('platform super server signature reaches Portal administrative compatibility routes',
  serverRead.success === true && serverRead.unifiedGsVersion === 'v9.8', JSON.stringify(serverRead));
const replayedServerRead = node.post(serverReadRequest.body, serverReadRequest.parameter);
ok('platform super server signature rejects nonce replay', replayedServerRead.success === false);
const largeServerReadRequest = signedRequest('loadTables', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep',
  signedEnvelopeProbe: 'x'.repeat(950000)
});
const largeServerRead = node.post(largeServerReadRequest.body, largeServerReadRequest.parameter);
ok('unified server signature accepts legitimate admin payloads above pinned baseline 900 KB limit', largeServerRead.success === true);
const signedLegacyAccount = signedRequest('authCreateAccount', { unit: '0082', apiKey: 'existing-api-key-do-not-change',
  unified_super: true, on_behalf: 'sheep', role: 'exco', username: 'shadow@example.test', memberId: '9000000001' });
const rejectedLegacyAccount = node.post(signedLegacyAccount.body, signedLegacyAccount.parameter);
ok('platform super signature cannot create a second Portal identity source in unified mode',
  rejectedLegacyAccount.success === false && rejectedLegacyAccount.code === 'BRANCH_IDENTITY_MANAGED');

const personalReadRequest = signedRequest('loadMine', { unit: '0082', ymis: '9000000001' });
const personalRead = node.post(personalReadRequest.body, personalReadRequest.parameter);
ok('signed personal bridge accepts unified-only loadMine and fixes identity to one YMIS',
  personalRead.success === true && Object.keys(personalRead.progress || {}).length === 1
    && Object.prototype.hasOwnProperty.call(personalRead.progress || {}, '9000000001'));

const wrongPurposeNow = Date.now();
const oldSeparateSecretToken = ssoToken('central-sso-session-secret-at-least-32-chars', {
  typ: 'central-sso-exchange', u: '0082', sub: '9000000001', role: 'member', name: '中央團員',
  scope: ['identity:read', 'branch:read', 'progress:self'], src: 'central-travel-system',
  iss: 'vs-portal', aud: 'unified-gas:branch:0082', iat: wrongPurposeNow,
  exp: wrongPurposeNow + 60_000, jti: crypto.randomUUID()
});
const rejectedOldSecret = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: oldSeparateSecretToken });
ok('branch GS rejects the removed standalone Portal secret and derives exchange key from API_KEY purpose',
  rejectedOldSecret.code === 'SSO_TOKEN_INVALID');

const wrongUnitToken = assertion('0099', '9000000001', 'member', '中央團員');
const wrongUnitExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: wrongUnitToken });
ok('branch GS rejects a purpose token issued for another unit', wrongUnitExchange.code === 'SSO_UNIT_MISMATCH');
const expiredNow = Date.now();
const expiredToken = exchangeToken({
  typ: 'central-sso-exchange', u: '0082', sub: '9000000001', role: 'member', name: '中央團員',
  scope: ['identity:read', 'branch:read', 'progress:self'], src: 'central-travel-system',
  iss: 'vs-portal', aud: 'unified-gas:branch:0082',
  iat: expiredNow - 80_000, exp: expiredNow - 20_000, jti: crypto.randomUUID()
});
const expiredExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: expiredToken });
ok('branch GS rejects an expired purpose token before creating a session', expiredExchange.code === 'SSO_TOKEN_EXPIRED');

const memberPurposeToken = assertion('0082', '9000000001', 'member', '中央團員');
const memberExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: memberPurposeToken });
ok('isolated auth fixture exchanges a short assertion for an opaque branch session', memberExchange.success === true && /^sso_/.test(memberExchange.sessionToken || ''));
const replayedExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: memberPurposeToken });
ok('branch GS rejects replay of the one-use SSO exchange token', replayedExchange.code === 'SSO_TOKEN_REPLAYED');
ok('replay protection uses shared Script Cache under an atomic Script Lock',
  node.cacheWrites.some(write => write.key.startsWith('unified-sso-jti:') && write.ttl === 180)
    && node.lockStats.waits >= 2 && node.lockStats.waits === node.lockStats.releases);
ok('isolated auth fixture creates only a passwordless authorization mirror', (() => {
  const row = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001');
  return row && row[4] === '' && row[3] === 'member';
})());
const memberWho = node.post({ action: 'authWhoAmI', unit: '0082', sessionToken: memberExchange.sessionToken });
ok('authWhoAmI derives identity from server session, not client role', memberWho.success === true && memberWho.account.role === 'member');
const memberWrite = node.post({ action: 'saveTables', unit: '0082', sessionToken: memberExchange.sessionToken,
  __serverSigned: true, __serverActorRole: 'super', __serverActorSubject: 'sheep',
  tables: { notices: [] }, refreshReports: false });
ok('member session is denied administrative write scope and cannot forge internal actor markers',
  memberWrite.code === 'ACTION_SCOPE_DENIED');
const promoted = node.post({ action: 'authPortalExchange', unit: '0082',
  portalToken: assertion('0082', '9000000001', 'exco', '中央團員') });
ok('fixture role changes update only the passwordless authorization mirror', promoted.success === true
  && promoted.account.role === 'exco' && node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001')?.[4] === '');

const leaderExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: assertion('0082', 'leader@example.test', 'leader', '中央領袖') });
ok('isolated auth fixture maps an e-mail subject to the branch roster', leaderExchange.success === true && leaderExchange.account.ymis === '9000000002', JSON.stringify(leaderExchange));
ok('leader mirror has branch-leader ceiling and no local credential', (() => {
  const row = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000002');
  return row && row[3] === 'branch_leader' && row[4] === '';
})());
const readOnlyLeader = node.post({ action: 'authPortalExchange', unit: '0082',
  portalToken: assertion('0082', '9000000002', 'leader', '中央領袖', ['identity:read', 'branch:read']) });
const readOnlyWrite = node.post({ action: 'saveTables', unit: '0082', sessionToken: readOnlyLeader.sessionToken,
  tables: { notices: [] }, refreshReports: false });
ok('action scope is enforced independently of role label', readOnlyLeader.success === true && readOnlyWrite.code === 'ACTION_SCOPE_DENIED');

const leaderBeforeSave = node.post({ action: 'loadTables', unit: '0082', sessionToken: leaderExchange.sessionToken });
const saved = node.post({
  action: 'saveTables', unit: '0082', sessionToken: leaderExchange.sessionToken, baseVersion: leaderBeforeSave.version, refreshReports: false,
  tables: {
    members: [
      { id: 'm1', ymis: '9000000001', name: '中央團員（更新）', identity: 'member', email: 'member@example.test' },
      { id: 'm2', ymis: '9000000002', name: '中央領袖', identity: 'leader', email: 'leader@example.test' }
    ],
    accounts: [{ id: 'evil', username: 'shadow', pw: { hash: 'must-not-persist' }, role: 'super' }],
    notices: []
  }
});
ok('authorised leader can write administrative tables', saved.success === true && saved.confirmed === true, JSON.stringify(saved));
const loaded = node.post({ action: 'loadTables', unit: '0082', sessionToken: leaderExchange.sessionToken });
ok('all clients read one administrative data copy', loaded.success === true && Array.isArray(loaded.db?.members));
ok('canonical roster overlays Portal member identity fields', loaded.db.members.some(m => m.ymis === '9000000001' && m.name === '中央團員（更新）'));
ok('legacy account payload is replaced by safe pinned Users projection', loaded.db.accounts.every(a => !a.pw && !a.password && a.source === 'unified-users'));
ok('no client-supplied shadow account survives', !loaded.db.accounts.some(a => a.username === 'shadow'));
const originalNameAfterSave = node.sheets.get('成員名單')._rows[1][1];
node.sheets.get('成員名單').getRange(2, 2).setValue('BADGE 已更新名字');
const rereadAfterBadgeEdit = node.post({ action: 'loadTables', unit: '0082', sessionToken: accountAdmin.sessionToken });
const staleSavedDb = node.post({ action: 'saveDb', unit: '0082', sessionToken: accountAdmin.sessionToken,
  db: loaded.db, baseVersion: loaded.version, refreshReports: false });
ok('after administrative data exists, reads use the latest authoritative BADGE roster',
  rereadAfterBadgeEdit.success === true && rereadAfterBadgeEdit.version !== loaded.version
    && rereadAfterBadgeEdit.db.members.some(m => m.ymis === '9000000001' && m.name === 'BADGE 已更新名字'));
ok('stale whole-db write cannot overwrite a later BADGE roster change',
  staleSavedDb.success === false && staleSavedDb.conflict === true
    && node.sheets.get('成員名單')._rows[1][1] === 'BADGE 已更新名字', JSON.stringify(staleSavedDb));
node.sheets.get('成員名單').getRange(2, 2).setValue(originalNameAfterSave);
const rosterBeforeSaveRefresh = JSON.stringify(node.sheets.get('成員名單')._rows);
node.sheets.set('團員', unrelatedReport);
const beforeCollisionSave = node.post({ action: 'dbInfo', unit: '0082', sessionToken: accountAdmin.sessionToken });
const collisionSave = node.post({ action: 'saveTables', unit: '0082', sessionToken: accountAdmin.sessionToken,
  baseVersion: beforeCollisionSave.version, tables: { notices: [] }, refreshReports: true });
ok('save-triggered refresh reports a collision without clearing the unowned sheet',
  collisionSave.success === true && collisionSave.reports?.ok === false
    && unrelatedReport._rows[1]?.[0] === 'never clear', JSON.stringify(collisionSave));
node.sheets.set('團員', ownedReport);
const refreshSave = node.post({ action: 'saveTables', unit: '0082', sessionToken: accountAdmin.sessionToken,
  baseVersion: collisionSave.version, tables: { notices: [] }, refreshReports: true });
ok('save-triggered report refresh preserves BADGE roster and historical suffixed tabs',
  refreshSave.success === true && refreshSave.reports?.ok === true
    && JSON.stringify(node.sheets.get('成員名單')._rows) === rosterBeforeSaveRefresh
    && node.sheets.get('私人紀錄·0082')?._rows[1]?.[0] === 'historic', JSON.stringify(refreshSave));

/* A compatibility rejection must be side-effect free. Historically the unified
   router updated 成員名單／Users before the stale-version check ran. */
const rejectedRosterDb = JSON.parse(JSON.stringify(loaded.db));
rejectedRosterDb.members.find(m => m.ymis === '9000000001').name = '拒絕請求不可先改名';
rejectedRosterDb.members.find(m => m.ymis === '9000000001').email = 'rejected@example.test';
const rosterNameBeforeReject = node.sheets.get('成員名單')._rows.find(r => String(r[0]) === '9000000001')?.[1];
const userBeforeReject = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001')?.slice();
const rejectedRosterSave = node.post({ action: 'saveDb', unit: '0082', sessionToken: leaderExchange.sessionToken,
  db: rejectedRosterDb, baseVersion: 'definitely-stale-version', refreshReports: false });
const rosterAfterReject = node.sheets.get('成員名單')._rows.find(r => String(r[0]) === '9000000001');
const userAfterReject = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001');
ok('stale compatibility save is rejected before any roster or Users mirror side effect',
  rejectedRosterSave.success === false && rosterAfterReject?.[1] === rosterNameBeforeReject
    && JSON.stringify(userAfterReject) === JSON.stringify(userBeforeReject), JSON.stringify(rejectedRosterSave));

/* Unified account aliases bypass Portal's ordinary save dispatcher, but must still
   obey this branch DB's admin.accounts ACL after the compatibility DB exists. */
const aclReadRequest = signedRequest('loadTables', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep'
});
const aclFull = node.post(aclReadRequest.body, aclReadRequest.parameter);
const aclDeniedDb = JSON.parse(JSON.stringify(aclFull.db));
aclDeniedDb.permOverrides = aclDeniedDb.permOverrides || {};
aclDeniedDb.permOverrides['admin.accounts'] = {
  ...(aclDeniedDb.permOverrides['admin.accounts'] || {}),
  member: 0, exco: 0, leader: 0, chief: 0
};
aclDeniedDb.permOverrides['member.create'] = {
  ...(aclDeniedDb.permOverrides['member.create'] || {}), member: 0, exco: 0
};
const aclSaveRequest = signedRequest('saveDb', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep',
  db: aclDeniedDb, baseVersion: aclFull.version, refreshReports: false
});
const aclSaved = node.post(aclSaveRequest.body, aclSaveRequest.parameter);
const unifiedAclDenied = [
  node.post({ action: 'authResetPassword', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000010', newPassword: '9999' }),
  node.post({ action: 'authDeleteAccount', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000010' }),
  node.post({ action: 'authRestoreAccount', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000010' }),
  node.post({ action: 'authCreateAccount', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000001', role: 'member', password: '1234' })
];
ok('Unified reset/delete/restore/create aliases obey branch admin.accounts ACL',
  aclSaved.success === true
    && unifiedAclDenied.every(result => result.success === false && result.code === 'ACTION_SCOPE_DENIED'),
  JSON.stringify({ aclSaved, unifiedAclDenied }));
const loadedAfterAcl = node.post({ action: 'loadTables', unit: '0082', sessionToken: leaderExchange.sessionToken });

/* Confidential identities omitted by a projection are restored before validation;
   that restoration must never be confused with a genuinely client-invented row. */
const excoProjectedAfterAcl = node.post({ action: 'loadTables', unit: '0082', sessionToken: promoted.sessionToken });
const inventedUnifiedMembers = JSON.parse(JSON.stringify(excoProjectedAfterAcl.db.members));
inventedUnifiedMembers.push({ id: 'forged-unified-member', ymis: '9999999998',
  name: '偽造 Unified 成員', identity: 'member' });
const deniedUnifiedProjectedCreate = node.post({ action: 'saveTables', unit: '0082',
  sessionToken: promoted.sessionToken, baseVersion: excoProjectedAfterAcl.version, refreshReports: false,
  tables: { members: inventedUnifiedMembers } });
ok('unified projected rows cannot bypass a denied member.create permission',
  excoProjectedAfterAcl.success === true && deniedUnifiedProjectedCreate.success === false
    && deniedUnifiedProjectedCreate.code === 'ACTION_SCOPE_DENIED', JSON.stringify(deniedUnifiedProjectedCreate));
ok('generated Unified compatibility checkpoint contains no missing-projection create bypass',
  !SOURCE.includes('__allowMissingProjectedRows'));

const stagedIdentityDb = JSON.parse(JSON.stringify(loadedAfterAcl.db));
stagedIdentityDb.members.find(m => m.ymis === '9000000001').identity = 'chief';
const stagedIdentitySaveId = '0082-stg-unified-identity-guard';
const stagedIdentityPart = node.post({ action: 'saveDbPart', unit: '0082', sessionToken: promoted.sessionToken,
  saveId: stagedIdentitySaveId, partIdx: 0, parts: 1, data: stagedIdentityDb, baseVersion: loadedAfterAcl.version });
const stagedIdentityCommit = node.post({ action: 'saveDbCommit', unit: '0082', sessionToken: promoted.sessionToken,
  saveId: stagedIdentitySaveId, parts: 1, baseVersion: loadedAfterAcl.version, refreshReports: false });
ok('unified delegated exco cannot use staged saveDbCommit to bypass identity field authorization',
  stagedIdentityPart.success === true && stagedIdentityCommit.success === false
    && stagedIdentityCommit.code === 'PROTECTED_AUTH_FIELD', JSON.stringify(stagedIdentityCommit));

/* 團員入口唔再用行政 loadDb/saveDb：有效 session 只收本人安全投影，

   RSVP／答卷／請假亦由 GS 固定 memberId，client 偽造身份冇作用。 */
const hubDb = JSON.parse(JSON.stringify(loadedAfterAcl.db));
hubDb.schema = 2;
hubDb.settings = { troopLinks: { facebook: 'https://facebook.example/member' }, publicLinks: {} };
hubDb.publicProfile = {
  about: { text: '團員可見簡介', vis: 'member' }, site: { url: '', vis: 'member' },
  socials: [
    { id: 'social-member', kind: 'instagram', title: '團員 IG', url: 'https://instagram.example/member', vis: 'member' },
    { id: 'social-leader', kind: 'whatsapp', title: '領袖秘密群', url: 'https://chat.example/leaders', vis: 'leader' }
  ], albums: [], links: []
};
hubDb.events = [
  { id: 'event-member', title: '團員活動', date: '2099-12-01', status: 'confirmed', vis: 'member', adminSecret: 'EVENT-SECRET',
    rsvp: { m2: { status: 'present', name: '中央領袖', auditSecret: 'RSVP-SECRET' } }, rollcall: { m2: { status: 'present' } } },
  { id: 'event-leader', title: '領袖秘密活動', date: '2099-12-02', status: 'confirmed', vis: 'leader', rsvp: {} }
];
hubDb.quizzes = [
  { id: 'quiz-member', title: '團員試卷', status: 'open', vis: 'member', gradingSecret: 'QUIZ-SECRET',
    questions: [{ id: 'q1', prompt: '一加一', type: 'single', options: ['1', '2'], required: true, answerKey: 'QUESTION-SECRET' }],
    responses: { m2: { name: '中央領袖', answers: { q1: '2' }, markerNote: 'RESPONSE-SECRET' } } },
  { id: 'quiz-leader', title: '領袖試卷', status: 'open', vis: 'leader', questions: [], responses: {} }
];
hubDb.notices = [
  { id: 'notice-member', title: { zh: '團員通告' }, status: 'published', vis: 'member', internalRecipients: 'NOTICE-SECRET', signups: [{ memberId: 'm2', name: '中央領袖' }] },
  { id: 'notice-leader', title: { zh: '領袖通告' }, status: 'published', vis: 'leader', signups: [] }
];
hubDb.absences = [
  { id: 'absence-mine', memberId: 'm1', ymis: '9000000001', date: '2099-11-01', status: 'approved', reason: '本人原因' },
  { id: 'absence-other', memberId: 'm2', ymis: '9000000002', date: '2099-11-01', status: 'approved', reason: '他人私隱' }
];
const hubSeed = node.post({ action: 'saveDb', unit: '0082', sessionToken: leaderExchange.sessionToken,
  db: hubDb, baseVersion: loadedAfterAcl.version, refreshReports: false });
ok('leader seeds member-hub administrative source through the normal authorised route', hubSeed.success === true, JSON.stringify(hubSeed));
const anonymousHub = node.post({ action: 'hubLoad', unit: '0082' });
ok('member hub rejects a client without an opaque branch session', anonymousHub.code === 'SESSION_REQUIRED');
const memberHub = node.post({ action: 'hubLoad', unit: '0082', sessionToken: memberExchange.sessionToken,
  role: 'chief', memberId: 'm2' });
ok('member hub returns one canonical self and no account/password collection', memberHub.success === true
  && memberHub.db.members.length === 1 && memberHub.db.members[0].id === 'm1'
  && memberHub.db.members[0].identity === 'member' && memberHub.db.accounts.length === 0
  && !/password|password_hash|hubPw|他人私隱/.test(JSON.stringify(memberHub.db)), JSON.stringify(memberHub));
ok('member hub filters leader-only content and every other member response server-side',
  memberHub.db.events.length === 1 && memberHub.db.events[0].id === 'event-member'
  && Object.keys(memberHub.db.events[0].rsvp).length === 0 && !memberHub.db.events[0].rollcall
  && memberHub.db.quizzes.length === 1 && Object.keys(memberHub.db.quizzes[0].responses).length === 0
  && memberHub.db.notices.length === 1 && memberHub.db.absences.length === 1
  && !JSON.stringify(memberHub.db).includes('領袖秘密'));
ok('unified event/quiz/notice projection is a positive field allowlist',
  !/EVENT-SECRET|RSVP-SECRET|QUIZ-SECRET|QUESTION-SECRET|RESPONSE-SECRET|NOTICE-SECRET/.test(JSON.stringify(memberHub.db)));
const memberRsvp = node.post({ action: 'hubRsvp', unit: '0082', sessionToken: memberExchange.sessionToken,
  eventId: 'event-member', status: 'late', time: '19:30', memberId: 'm2', role: 'chief' });
ok('member RSVP ignores forged memberId/role and writes only the session actor', memberRsvp.success === true
  && memberRsvp.db.events[0].rsvp.m1?.status === 'late' && !memberRsvp.db.events[0].rsvp.m2,
  JSON.stringify(memberRsvp));
const publicReceipt = node.post({ action: 'operationStatus', unit: '0082', operationId: memberRsvp.operationId });
ok('unpredictable operation ID is a read-only capability receipt (no session, metadata only)',
  publicReceipt.ok === true && publicReceipt.found === true && publicReceipt.outcome === 'applied'
    && publicReceipt.operation?.id === memberRsvp.operationId
    && !Object.prototype.hasOwnProperty.call(publicReceipt.operation || {}, 'resultJson'),
  JSON.stringify(publicReceipt));
const replayWithoutSession = node.post({ action: 'hubRsvp', unit: '0082', operationId: memberRsvp.operationId,
  eventId: 'event-member', status: 'late' });
ok('operation ID alone cannot replay a private member projection', replayWithoutSession.success === false
  && replayWithoutSession.deduplicated === true && replayWithoutSession.outcome === 'applied'
  && !replayWithoutSession.db && !JSON.stringify(replayWithoutSession).includes('19:30'), JSON.stringify(replayWithoutSession));
const operationRow = node.sheets.get('_Operations')._rows.find(row => row[0] === memberRsvp.operationId);
ok('operation journal does not persist full member projections', !!operationRow
  && !String(operationRow[7]).includes('event-member') && !String(operationRow[7]).includes('19:30'));
const hiddenRsvp = node.post({ action: 'hubRsvp', unit: '0082', sessionToken: memberExchange.sessionToken,
  eventId: 'event-leader', status: 'present' });
ok('member cannot write a leader-only event by guessing its id', hiddenRsvp.success === false);
const memberQuiz = node.post({ action: 'hubQuiz', unit: '0082', sessionToken: memberExchange.sessionToken,
  quizId: 'quiz-member', answers: { q1: '2', injected: 'must-drop' }, memberId: 'm2' });
ok('member quiz keeps only defined answers under the session actor', memberQuiz.success === true
  && memberQuiz.db.quizzes[0].responses.m1?.answers?.q1 === '2'
  && memberQuiz.db.quizzes[0].responses.m1?.answers?.injected === undefined);
const memberAbsencePayload = { action: 'hubAbsence', unit: '0082', sessionToken: memberExchange.sessionToken,
  op: 'create', id: 'ab_member_test', date: '2099-12-03', slot: 'pm', reason: '測試請假', memberId: 'm2' };
const memberAbsence = node.post(memberAbsencePayload);
ok('member absence is fixed to the session actor and still hides every other absence', memberAbsence.success === true
  && memberAbsence.db.absences.some(a => a.id === 'ab_member_test' && a.memberId === 'm1' && a.ymis === '9000000001')
  && !memberAbsence.db.absences.some(a => a.id === 'absence-other'));
const memberAbsenceRetry = node.post(memberAbsencePayload);
ok('unified absence create retry is idempotent', memberAbsenceRetry.success === true
  && memberAbsenceRetry.db.absences.filter(a => a.id === 'ab_member_test').length === 1);
const memberWithdraw = node.post({ action: 'hubAbsence', unit: '0082', sessionToken: memberExchange.sessionToken,
  op: 'withdraw', id: 'ab_member_test' });
const memberWithdrawRetry = node.post({ action: 'hubAbsence', unit: '0082', sessionToken: memberExchange.sessionToken,
  op: 'withdraw', id: 'ab_member_test' });
ok('unified absence withdraw retry is idempotent', memberWithdraw.success === true && memberWithdrawRetry.success === true
  && !memberWithdrawRetry.db.absences.some(a => a.id === 'ab_member_test'));
const adminAfterHub = node.post({ action: 'loadDb', unit: '0082', sessionToken: leaderExchange.sessionToken });
ok('administrative copy receives member writes without losing other members data', adminAfterHub.success === true
  && adminAfterHub.db.events.find(e => e.id === 'event-member')?.rsvp?.m1?.status === 'late'
  && adminAfterHub.db.events.find(e => e.id === 'event-member')?.rsvp?.m2?.status === 'present'
  && adminAfterHub.db.quizzes.find(q => q.id === 'quiz-member')?.responses?.m2
  && adminAfterHub.db.absences.some(a => a.id === 'absence-other'));

const centralPassword = node.post({ action: 'authChangePassword', unit: '0082', sessionToken: leaderExchange.sessionToken,
  oldPassword: 'x', newPassword: 'y1234' });
ok('auth-fixture session cannot create a second local password', centralPassword.code === 'CENTRAL_IDENTITY_MANAGED');

const localNormal = node.post({ action: 'authLogin', unit: '0082', username: '1111111111', password: 'changed99' });
ok('local branch account is the normal login source', localNormal.success === true
  && typeof localNormal.sessionToken === 'string' && localNormal.sessionToken.length > 10
  && localNormal.localLogin === true, JSON.stringify(localNormal));
ok('BADGE Sheet menu callback remains available for the owner',
  typeof node.context.menuLocalLoginOff === 'function');

/* Isolated auth-fixture regression only: directly exercise pinned compatibility code.
   This is not a deployment state or a future travel-system contract. */
node.context.setLocalLoginAllowed(false, 'test-isolated-auth-fixture');
const localClosed = node.post({ action: 'authLogin', unit: '0082', username: '1111111111', password: 'changeme' });
ok('auth fixture can exercise the legacy closed-gate branch', localClosed.success === false
  && /本地入口|旅團入口/.test(localClosed.error || ''), JSON.stringify(localClosed));
const centralStillWorks = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: assertion('0082', '9000000002', 'leader', '中央領袖') });
ok('isolated exchange fixture still exercises its dedicated token path', centralStillWorks.success === true);
node.context.setLocalLoginAllowed(true, 'test-fixture-cleanup');

const beforeRows = node.sheets.get('進度追蹤')._rows.map(r => JSON.stringify(r));
const again = node.context.initializeSheets();
ok('unified initializer is safely repeatable', again.success === true);
ok('repeat initialization does not rewrite progress', JSON.stringify(node.sheets.get('進度追蹤')._rows.map(r => JSON.stringify(r))) === JSON.stringify(beforeRows));
ok('repeat initialization still preserves API key', node.props.get('API_KEY') === 'existing-api-key-do-not-change');

/* Keep the latest BADGE account/permission update intact inside the full Unified build. */
const repairNode = makeNode();
repairNode.sheets.set('Users', makeSheet('Users', [
  USER_HEADERS,
  ['1111111111', '既有管理員', 'admin@example.com', 'admin', sha256('changeme'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', true],
  ['L9000000001', '支部領袖', 'leader@example.test', 'branch_leader', sha256('leaderpass9'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', false],
  ['9000000001', '團員甲', 'member@example.test', 'member', sha256('memberpass9'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', false]
]));
repairNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [
  ['YMIS','項目 ID','完成日期','更新時間','確認者','備註'],
  ['L9000000001','L1-LEADER','2026-01-01','2026-01-01','admin','leader-only'],
  ['9000000001','L1-MEMBER','2026-01-02','2026-01-02','leader','member-only']
]));
repairNode.sheets.set('成員名單', makeSheet('成員名單', [
  ['YMIS','姓名','加入日期','支部','聯絡'],
  ['L9000000001', '支部領袖', '2025-01-01', 'VS', 'leader@example.test'],
  ['9000000001', '團員甲', '2025-01-01', 'VS', 'member@example.test']
]));
repairNode.context.initializeSheets();
const repairAdmin = repairNode.post({ action: 'login', login_id: '1111111111', password: 'changeme' });
const repairLeader = repairNode.post({ action: 'login', login_id: 'LEADER@example.test', password: 'leaderpass9' });
const scopeOnly = repairNode.post({ action: 'updatePermissions', token: repairAdmin.token,
  target_ymis: 'L9000000001', allowed_badges: 'L1,L2' });
ok('scope-only permission updates preserve role and can_tick',
  repairAdmin.success === true && scopeOnly.success === true
    && scopeOnly.role === 'branch_leader' && scopeOnly.can_tick === true
    && repairNode.context.findUserRecord('L9000000001').user.allowed_badges === 'L1,L2',
  JSON.stringify(scopeOnly));
const repairLoadOut = repairNode.context.doGet({ parameter: {
  action: 'load', token: repairLeader.token, apikey: 'existing-api-key-do-not-change'
} });
const repairLoad = JSON.parse(repairLoadOut.getContent());
ok('authenticated GET load returns current session permissions without identity identifiers',
  repairLoad.success === true && repairLoad.me?.role === 'branch_leader'
    && repairLoad.me?.can_tick === true && repairLoad.me?.allowed_badges === 'L1,L2'
    && repairLoad.me?.ymis === undefined && repairLoad.me?.email === undefined,
  JSON.stringify(repairLoad.me));
const repairMemberLogin = repairNode.post({ action: 'login', login_id: 'member@example.test', password: 'memberpass9' });
const deniedMemberWrite = repairNode.post({ action: 'save', token: repairMemberLogin.token,
  changes: [{ ymis: '9000000001', itemId: 'L1', date: '2026-11-20' }] });
ok('member progress writes remain denied even when can_tick is true',
  repairMemberLogin.success === true && deniedMemberWrite.success === false
    && /沒有直接寫入進度權限/.test(deniedMemberWrite.error || '')
    && !repairNode.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001' && row[1] === 'L1'),
  JSON.stringify(deniedMemberWrite));
const anonymousLoadOut = repairNode.context.doGet({ parameter: { action: 'load' } });
const anonymousLoad = JSON.parse(anonymousLoadOut.getContent());
ok('anonymous GET load exposes no member or progress data',
  anonymousLoad.success === false && anonymousLoad.code === 'SIGNATURE_REQUIRED'
    && anonymousLoad.upstream_only === true
    && anonymousLoad.members === undefined && anonymousLoad.progress === undefined,
  JSON.stringify(anonymousLoad));
const memberLoadOut = repairNode.context.doGet({ parameter: { action: 'load', token: repairMemberLogin.token } });
const memberLoad = JSON.parse(memberLoadOut.getContent());
ok('member GET load is restricted to that member’s own roster and progress projection',
  memberLoad.success === true && memberLoad.members.length === 1
    && memberLoad.members[0].ymis === '9000000001'
    && Object.keys(memberLoad.progress).length === 1
    && !!memberLoad.progress['9000000001']?.['L1-MEMBER']
    && !Object.prototype.hasOwnProperty.call(memberLoad.progress, 'L9000000001')
    && memberLoad.me?.ymis === undefined && memberLoad.me?.email === undefined,
  JSON.stringify(memberLoad));
const signedLoadRequest = signedRequest('load', { unit: '0082', apiKey: 'existing-api-key-do-not-change',
  unified_super: true, on_behalf: 'sheep' });
const signedLoad = repairNode.post(signedLoadRequest.body, signedLoadRequest.parameter);
ok('server-signed load remains available to the authenticated same-origin proxy',
  signedLoad.success === true && Array.isArray(signedLoad.members)
    && signedLoad.members.some(member => member.ymis === '9000000001'), JSON.stringify(signedLoad));

console.log(`\n${passed} passed, 0 failed\n`);
