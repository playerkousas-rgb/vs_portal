// ============================================================
// VS unified branch backend — isolated test extension
//
// Composition:
//   1. exact vsbadge GS v9.6 baseline (identity, progress, badges, logs)
//   2. namespaced VS Portal v2.8.8 administrative storage compatibility
//   3. this router (isolated auth fixture, action scopes, canonical identity projection)
//
// The generated GS is the complete branch capability superset: identity, branch
// administration, progress, badges, logs, and submissions. vs_portal is the
// full-featured frontend; vsbadge is a lightweight frontend over the same backend,
// not a second reduced GS. Each client still needs an allowed action and the router
// still enforces server-side session, role, and scope authorization.
//
// This file is test-only in vs_portal.  Its assertion/exchange route is a security
// fixture, not a Progress or future travel-system contract.  The formal future
// direction is travel-system server → branch backend reader.  It is not published
// to vsbadge and does not deploy itself.  Build with: npm run build:gas:unified
// ============================================================

var UNIFIED_GS_VERSION = 'v9.6-u1-test';
var UNIFIED_INITIALIZED_PROP = 'UNIFIED_GS_INITIALIZED_VERSION';
var UNIFIED_PORTAL_TOKEN_MAX_MS = 2 * 60 * 1000;
var UNIFIED_SSO_SESSION_MS = 8 * 60 * 60 * 1000;
/* API_KEY is only a server-side root. Purpose separation prevents a routing
   signature, central assertion, and branch exchange token being interchangeable. */
var UNIFIED_PORTAL_EXCHANGE_PURPOSE = 'vs-portal-branch-exchange-v1';
var UNIFIED_PORTAL_EXCHANGE_ISSUER = 'vs-portal';
var UNIFIED_PORTAL_EXCHANGE_AUDIENCE = 'unified-gas:branch:';
var UNIFIED_PORTAL_CENTRAL_SOURCE = 'central-travel-system';
/* Pinned baseline keeps its 900 KB limit; unified administrative signatures need the
   same bounded 4 MiB envelope as /api/proxy for legitimate saveTables payloads. */
var UNIFIED_ADMIN_SIGNED_MAX_BYTES = 4 * 1024 * 1024;

var UNIFIED_PUBLIC_PORTAL_ACTIONS = {
  ping: 1, test: 1, status: 1, notices: 1, constitution: 1,
  noticeSignup: 1, loan: 1, claim: 1
};
var UNIFIED_ADMIN_READ_ACTIONS = {
  dbInfo: 1, loadDb: 1, loadDbPart: 1, loadTables: 1, loadTablesPart: 1,
  syncCheck: 1
};
var UNIFIED_ADMIN_WRITE_ACTIONS = {
  saveDb: 1, saveDbPart: 1, saveDbCommit: 1, saveTables: 1, sync: 1,
  uploadPhotos: 1
};
var UNIFIED_ADMIN_DANGEROUS_ACTIONS = {
  repairDb: 1, saveDbForce: 1, verifySetupKey: 1
};
var UNIFIED_PORTAL_AUTH_ACTIONS = {
  authLogin: 1, authWhoAmI: 1, authPortalExchange: 1, authChangePassword: 1,
  authResetPassword: 1, authDeleteAccount: 1, authRestoreAccount: 1,
  authCreateAccount: 1, authForgotPassword: 1, authCompletePasswordReset: 1
};
var UNIFIED_ACCOUNT_ADMIN_ACTIONS = {
  authResetPassword: 1, authDeleteAccount: 1, authRestoreAccount: 1, authCreateAccount: 1
};
var UNIFIED_PERSONAL_PROGRESS_ACTIONS = {
  loadMine: 1, myRequests: 1, addRequest: 1
};
var UNIFIED_MEMBER_HUB_ACTIONS = {
  hubLoad: 1, hubRsvp: 1, hubQuiz: 1, hubAbsence: 1
};

function unifiedJson_(obj) { return jsonResponse(obj); }

function unifiedBody_(e) {
  var raw = String((e && e.postData && e.postData.contents) || '{}');
  var body = null;
  try { body = JSON.parse(raw || '{}'); } catch (err) { body = null; }
  return { raw: raw, body: body };
}

function unifiedOutputObject_(out) {
  if (!out) return null;
  if (typeof out === 'object' && typeof out.getContent !== 'function') return out;
  try { return JSON.parse(out.getContent()); } catch (err) { return null; }
}

function unifiedOutput_(obj) {
  return unifiedJson_(obj || { success: false, ok: false, error: '後端回應格式異常' });
}

function unifiedRoleFromBackend_(role) {
  var r = String(role || '').toLowerCase();
  if (r === 'super_admin') return 'super';
  if (r === 'admin' || r === 'group_leader') return 'chief';
  if (r === 'branch_leader') return 'leader';
  if (r === 'exec_committee') return 'exco';
  return 'member';
}

function unifiedRoleToBackend_(role) {
  var r = String(role || '').toLowerCase();
  if (r === 'super') return 'admin';
  if (r === 'chief' || r === 'admin' || r === 'group_leader') return 'group_leader';
  if (r === 'leader' || r === 'branch_leader') return 'branch_leader';
  if (r === 'exco' || r === 'exec_committee') return 'exec_committee';
  return 'member';
}

function unifiedRoleRank_(role) {
  var r = String(role || '').toLowerCase();
  return { member: 0, exco: 20, exec_committee: 20, leader: 40, branch_leader: 40,
    chief: 60, group_leader: 60, admin: 80, super: 100, super_admin: 100 }[r] || 0;
}

function unifiedScopesForRole_(role) {
  var scopes = ['identity:read', 'branch:read', 'progress:self'];
  if (unifiedRoleRank_(role) >= unifiedRoleRank_('exco')) scopes.push('branch:write', 'progress:manage');
  if (unifiedRoleRank_(role) >= unifiedRoleRank_('leader')) scopes.push('identity:manage', 'branch:repair');
  return scopes;
}

function unifiedEffectiveScopes_(role, assertedScopes) {
  var ceiling = unifiedScopesForRole_(role);
  var claimed = Array.isArray(assertedScopes) ? assertedScopes.map(String) : [];
  return ceiling.filter(function (scope) { return claimed.indexOf(scope) >= 0; });
}

function unifiedEffectiveRole_(localBackendRole, assertedPortalRole) {
  var localPortal = unifiedRoleFromBackend_(localBackendRole);
  var asserted = String(assertedPortalRole || '').toLowerCase();
  if (['member', 'exco', 'leader', 'chief', 'admin', 'super'].indexOf(asserted) < 0) asserted = 'member';
  // The isolated auth fixture proves identity and membership, while the branch Users
  // row remains the action-scope ceiling. A stale/forged high role can never elevate.
  return unifiedRoleRank_(localPortal) <= unifiedRoleRank_(asserted) ? localPortal : asserted;
}

function unifiedB64UrlEncode_(bytes) {
  return String(Utilities.base64EncodeWebSafe(bytes) || '').replace(/=+$/, '');
}

function unifiedDecodePortalPayload_(part) {
  try {
    var bytes = Utilities.base64DecodeWebSafe(String(part || ''));
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString());
  } catch (err) { return null; }
}

function unifiedVerifyPortalToken_(token, unit) {
  /* No separate Portal secret is configured. The exact same API_KEY already used
     by BADGE is the root, while this fixed purpose derives a non-interchangeable
     exchange key. API_KEY by itself is never accepted as user identity. */
  var apiKey = String(getApiKey() || '');
  if (!apiKey) return { ok: false, code: 'SSO_NOT_CONFIGURED', error: '隔離 auth fixture 尚未設定' };
  var secret = hmacSha256Hex(UNIFIED_PORTAL_EXCHANGE_PURPOSE, apiKey);
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據無效' };
  }
  var expected = unifiedB64UrlEncode_(Utilities.computeHmacSha256Signature(parts[0], secret));
  if (!safeEqualText(expected, String(parts[1]).replace(/=+$/, ''))) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據無效' };
  }
  var payload = unifiedDecodePortalPayload_(parts[0]);
  if (!payload || String(payload.typ || '') !== 'central-sso-exchange') {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據格式不正確' };
  }
  var nowMs = Date.now();
  var iat = Number(payload.iat || 0);
  var exp = Number(payload.exp || 0);
  if (!iat || !exp || iat > nowMs + 15000 || exp <= nowMs - 15000 || exp <= iat || exp - iat > UNIFIED_PORTAL_TOKEN_MAX_MS) {
    return { ok: false, code: 'SSO_TOKEN_EXPIRED', error: '隔離 auth fixture 票據已過期，請重新產生測試票據' };
  }
  if (String(payload.u || '') !== String(unit || '')) {
    return { ok: false, code: 'SSO_UNIT_MISMATCH', error: '隔離 auth fixture 票據不屬於此支部' };
  }
  if (String(payload.iss || '') !== UNIFIED_PORTAL_EXCHANGE_ISSUER
      || String(payload.aud || '') !== UNIFIED_PORTAL_EXCHANGE_AUDIENCE + String(unit || '')
      || String(payload.src || '') !== UNIFIED_PORTAL_CENTRAL_SOURCE) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據用途不正確' };
  }
  var subject = String(payload.sub || '').trim();
  var role = String(payload.role || '').trim().toLowerCase();
  if (!subject || subject.length > 160 || ['member', 'exco', 'leader', 'chief', 'admin'].indexOf(role) < 0) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 身份資料不完整' };
  }
  var jti = String(payload.jti || '').trim();
  if (!jti || jti.length > 160) return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據缺少識別碼' };
  var scopes = Array.isArray(payload.scope) ? payload.scope.map(String) : [];
  return { ok: true, subject: subject, role: role, name: safeSheetText(payload.name, 100), scopes: scopes,
    issuer: String(payload.iss || ''), jti: jti };
}

function unifiedConsumePortalJti_(verified) {
  // CacheService provides the shared replay marker; ScriptLock makes the
  // get-then-put atomic when two tabs try to redeem the same jti together.
  // Fail closed if either service is unavailable.
  var lock = null;
  var locked = false;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
    locked = true;
    var cache = CacheService.getScriptCache();
    var key = 'unified-sso-jti:' + sha256Hex(String(verified && verified.jti || '')).substring(0, 40);
    if (cache.get(key)) return false;
    cache.put(key, '1', 180);
    return true;
  } catch (err) {
    return false;
  } finally {
    if (locked && lock) {
      try { lock.releaseLock(); } catch (ignore) { /* fail closed above */ }
    }
  }
}

// The pinned vsbadge allow-list deliberately knows nothing about Portal-only
// actions (loadMine/saveTables/repairDb).  Verify the exact same HMAC contract
// here, but only for the explicit unified action map supplied by the caller.
function unifiedVerifyLinkSig_(e, body, rawBody, allowedActions) {
  var lock = null;
  var locked = false;
  try {
    var action = String(body && body.action || '');
    if (!allowedActions || !allowedActions[action]) return false;
    var signed = readLinkSig(e, body, rawBody);
    if (!signed || String(rawBody || '').length > UNIFIED_ADMIN_SIGNED_MAX_BYTES) return false;
    if (!LINK_SIG_HEX_RE.test(String(signed.sig)) || !LINK_NONCE_RE.test(String(signed.nonce))) return false;
    var ts = parseInt(signed.ts, 10);
    if (!isFinite(ts) || Math.abs(Date.now() - ts) > LINK_SIG_WINDOW_MS) return false;
    var expected = hmacSha256Hex(linkCanonical(action, signed.ts, signed.nonce, signed.digest), linkSigKey());
    if (!safeEqualText(expected, signed.sig)) return false;

    var nonces = [String(signed.nonce)];
    var queryNonce = String(((e && e.parameter) || {}).snonce || '');
    var bodyNonce = String((body && body.sig_nonce) || '');
    [queryNonce, bodyNonce].forEach(function (nonce) {
      if (LINK_NONCE_RE.test(nonce) && nonces.indexOf(nonce) < 0) nonces.push(nonce);
    });
    var keys = nonces.map(function (nonce) {
      return 'link-nonce:' + sha256Hex(nonce).substring(0, 40);
    });
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
    locked = true;
    var cache = CacheService.getScriptCache();
    for (var i = 0; i < keys.length; i++) if (cache.get(keys[i])) return false;
    for (var j = 0; j < keys.length; j++) cache.put(keys[j], '1', LINK_SIG_NONCE_TTL);
    return true;
  } catch (err) {
    return false;
  } finally {
    if (locked && lock) {
      try { lock.releaseLock(); } catch (ignore) { /* fail closed above */ }
    }
  }
}

function unifiedFindMemberBySubject_(subject) {
  var wanted = String(subject || '').trim().toLowerCase();
  if (!wanted) return null;
  var sheet = getSheet().getSheetByName('成員名單');
  if (!sheet) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var ymis = String(rows[i][0] || '').trim();
    var contact = String(rows[i][4] || '').trim();
    if (ymis.toLowerCase() === wanted || contact.toLowerCase() === wanted) {
      return { row: i + 1, sheet: sheet, ymis: ymis, name: String(rows[i][1] || ''),
        branch: String(rows[i][3] || ''), contact: contact };
    }
  }
  return null;
}

function unifiedEnsureCentralUser_(member, assertedRole) {
  if (!member || !member.ymis) return null;
  var existing = getUser(member.ymis) || (member.contact ? getUserByEmail(member.contact) : null);
  if (existing) return existing;
  var sheet = getSheet().getSheetByName('Users');
  if (!sheet) {
    sheet = getSheet().insertSheet('Users');
    sheet.appendRow(USER_HEADERS);
  }
  var map = ensureUserColumns(sheet);
  var width = Math.max(sheet.getLastColumn(), USER_HEADERS.length);
  var row = new Array(width).fill('');
  row[map.ymis] = safeSheetText(member.ymis, 40);
  row[map.name] = safeSheetText(member.name || member.ymis, 100);
  row[map.email] = isEmail(member.contact) ? String(member.contact).trim() : '';
  row[map.role] = unifiedRoleToBackend_(assertedRole);
  row[map.password_hash] = ''; // Deliberately passwordless: the isolated fixture is the credential source.
  row[map.branch] = safeSheetText(member.branch, 100);
  row[map.can_tick] = unifiedRoleRank_(assertedRole) >= unifiedRoleRank_('exco');
  row[map.auth_by] = 'central-sso';
  row[map.auth_date] = now();
  row[map.created_at] = now();
  row[map.status] = 'active';
  row[map.allowed_badges] = defaultAllowedBadges(row[map.role]);
  row[map.force_change_password] = false;
  sheet.appendRow(row);
  writeAudit('central-sso', 'sso_user_mirror', member.ymis, '由隔離 auth fixture 建立無密碼授權鏡像');
  return getUser(member.ymis);
}

function unifiedRefreshCentralMirror_(user, assertedRole) {
  var rec = user && findUserRecord(user.ymis);
  if (!rec) return user;
  var hash = rec.map.password_hash === undefined ? '' : String(rec.data[rec.map.password_hash] || '');
  var source = rec.map.auth_by === undefined ? '' : String(rec.data[rec.map.auth_by] || '');
  // Only passwordless rows created by the isolated fixture follow fixture membership
  // role changes automatically. Existing local accounts keep their branch
  // authorization ceiling and can never be elevated by an assertion alone.
  if (!hash && source === 'central-sso') {
    var wanted = unifiedRoleToBackend_(assertedRole);
    if (rec.map.role !== undefined && String(rec.data[rec.map.role] || '') !== wanted) {
      rec.sheet.getRange(rec.row, rec.map.role + 1).setValue(wanted);
      if (rec.map.can_tick !== undefined) rec.sheet.getRange(rec.row, rec.map.can_tick + 1).setValue(unifiedRoleRank_(assertedRole) >= unifiedRoleRank_('exco'));
      if (rec.map.auth_date !== undefined) rec.sheet.getRange(rec.row, rec.map.auth_date + 1).setValue(now());
      writeAudit('central-sso', 'sso_role_sync', user.ymis, '隔離 fixture 角色同步為 ' + wanted);
      return getUser(user.ymis) || user;
    }
  }
  return user;
}

function unifiedResolvePortalIdentity_(verified) {
  var user = getUser(verified.subject) || getUserByEmail(verified.subject);
  var member = unifiedFindMemberBySubject_(verified.subject);
  if (!user && member) user = unifiedEnsureCentralUser_(member, verified.role);
  if (user) user = unifiedRefreshCentralMirror_(user, verified.role);
  if (!user) {
    return { ok: false, code: 'SSO_MEMBERSHIP_NOT_FOUND',
      error: '隔離 auth fixture 身份未對應此支部名冊' };
  }
  var effectiveRole = unifiedEffectiveRole_(user.role, verified.role);
  return { ok: true, ymis: String(user.ymis || ''), user: user, member: member,
    role: effectiveRole, assertedRole: verified.role,
    scopes: unifiedEffectiveScopes_(effectiveRole, verified.scopes) };
}

function unifiedIssueSsoToken_(ymis, role, scopes) {
  var sheet = getSheet().getSheetByName('Tokens');
  if (!sheet) {
    sheet = getSheet().insertSheet('Tokens');
    sheet.appendRow(['token', 'ymis', 'created_at', 'expires_at', 'source', 'role_scope', 'action_scopes']);
  } else {
    if (sheet.getLastColumn() < 5 || !sheet.getRange(1, 5).getValue()) sheet.getRange(1, 5).setValue('source');
    if (sheet.getLastColumn() < 6 || !sheet.getRange(1, 6).getValue()) sheet.getRange(1, 6).setValue('role_scope');
    if (sheet.getLastColumn() < 7 || !sheet.getRange(1, 7).getValue()) sheet.getRange(1, 7).setValue('action_scopes');
  }
  var token = 'sso_' + generateToken() + generateToken();
  var expiry = new Date(Date.now() + UNIFIED_SSO_SESSION_MS);
  sheet.appendRow([token, ymis, now(), Utilities.formatDate(expiry, 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss'),
    'central-sso', role, (scopes || []).join(' ')]);
  return { token: token, expiresAt: expiry.getTime() };
}

function unifiedTokenMeta_(token) {
  var sheet = getSheet().getSheetByName('Tokens');
  if (!sheet || !token) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') === String(token)) {
      return { ymis: String(rows[i][1] || ''), expires: rows[i][3], source: String(rows[i][4] || 'local'),
        role: String(rows[i][5] || ''), scopes: String(rows[i][6] || '').split(/\s+/).filter(function (x) { return !!x; }) };
    }
  }
  return null;
}

function unifiedAccountPayload_(identity) {
  var user = identity.user || {};
  var member = identity.member || unifiedFindMemberBySubject_(identity.ymis || user.ymis);
  return {
    id: String(user.ymis || identity.ymis || ''),
    username: String(user.email || user.ymis || identity.ymis || ''),
    email: String(user.email || ''),
    name: String(user.name || (member && member.name) || ''),
    role: String(identity.role || unifiedRoleFromBackend_(user.role)),
    backendRole: String(user.role || ''),
    kind: 'central-user',
    memberId: String((member && member.ymis) || user.ymis || ''),
    ymis: String(user.ymis || identity.ymis || ''),
    scopes: Array.isArray(identity.scopes) ? identity.scopes.slice() : unifiedScopesForRole_(identity.role)
  };
}

function unifiedPortalExchange_(body) {
  var verified = unifiedVerifyPortalToken_(body.portalToken, body.unit);
  if (!verified.ok) return unifiedJson_({ ok: false, success: false, code: verified.code, error: verified.error });
  if (!unifiedConsumePortalJti_(verified)) {
    return unifiedJson_({ ok: false, success: false, code: 'SSO_TOKEN_REPLAYED', error: '隔離 auth fixture 兌換票據已使用' });
  }
  var identity = unifiedResolvePortalIdentity_(verified);
  if (!identity.ok) return unifiedJson_({ ok: false, success: false, code: identity.code, error: identity.error });
  var session = unifiedIssueSsoToken_(identity.ymis, identity.role, identity.scopes);
  writeAudit(identity.ymis, 'central_sso_login', identity.ymis, '隔離 auth fixture 登入；有效角色 ' + identity.role);
  return unifiedJson_({ ok: true, success: true, sessionToken: session.token,
    sessionExpiresAt: session.expiresAt, account: unifiedAccountPayload_(identity),
    mustChangePw: false, centralSso: true, unifiedGsVersion: UNIFIED_GS_VERSION });
}

function unifiedResolveActor_(body, allowPortalExchangeToken) {
  body = body || {};
  if (body.portalToken && allowPortalExchangeToken) {
    var verified = unifiedVerifyPortalToken_(body.portalToken, body.unit);
    if (!verified.ok) return verified;
    if (!unifiedConsumePortalJti_(verified)) return { ok: false, code: 'SSO_TOKEN_REPLAYED', error: '隔離 auth fixture 兌換票據已使用' };
    return unifiedResolvePortalIdentity_(verified);
  }
  var token = String(body.sessionToken || body.token || '');
  var ymis = validateToken(token);
  if (!ymis) return { ok: false, code: 'SESSION_REQUIRED', error: '登入狀態已失效，請重新登入' };
  var user = getUser(ymis);
  if (!user) return { ok: false, code: 'SESSION_ACCOUNT_MISSING', error: '登入帳戶已停用或不存在' };
  var meta = unifiedTokenMeta_(token);
  if (!localLoginAllowed() && (!meta || meta.source !== 'central-sso')) {
    return { ok: false, code: 'CENTRAL_SSO_REQUIRED',
      error: '隔離 fixture 的 legacy 入口旗標已關閉；正式支部請重新執行 initializeSheets()' };
  }
  var role = meta && meta.role ? String(meta.role) : unifiedRoleFromBackend_(user.role);
  return { ok: true, ymis: String(user.ymis || ymis), user: user,
    member: unifiedFindMemberBySubject_(user.ymis), role: role,
    scopes: meta && meta.scopes && meta.scopes.length ? meta.scopes : unifiedScopesForRole_(role),
    source: meta ? meta.source : 'local' };
}

function unifiedWhoAmI_(body) {
  var actor = unifiedResolveActor_(body, true);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  return unifiedJson_({ ok: true, success: true, account: unifiedAccountPayload_(actor),
    centralSso: actor.source === 'central-sso' || !!body.portalToken, unifiedGsVersion: UNIFIED_GS_VERSION });
}

function unifiedLocalLogin_(body) {
  if (!localLoginAllowed()) return unifiedJson_(linkClosedResponse());
  var out = unifiedOutputObject_(handleLogin(body.username || body.email || body.ymis || body.login_id, body.password));
  if (!out || !out.success) return unifiedJson_({ ok: false, success: false, code: 'AUTH_INVALID',
    error: (out && out.error) || '帳號或密碼不正確' });
  var user = out.user || {};
  var role = unifiedRoleFromBackend_(user.role);
  return unifiedJson_({ ok: true, success: true, sessionToken: out.token,
    sessionExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    account: unifiedAccountPayload_({ user: user, ymis: user.ymis, role: role }),
    mustChangePw: !!out.force_change_password, localLogin: true, unifiedGsVersion: UNIFIED_GS_VERSION });
}

function unifiedAuthAlias_(action, body) {
  if (action === 'authPortalExchange') return unifiedPortalExchange_(body);
  if (action === 'authWhoAmI') return unifiedWhoAmI_(body);
  if (action === 'authLogin') return unifiedLocalLogin_(body);
  if (action === 'authForgotPassword') {
    if (!localLoginAllowed()) return unifiedJson_(linkClosedResponse());
    var requested = unifiedOutputObject_(handleRequestPasswordReset(body.email || body.username || body.login_id || body.ymis))
      || { success: false, error: '暫時未能提交' };
    requested.ok = requested.success === true;
    requested.resetMode = 'code';
    return unifiedJson_(requested);
  }
  if (action === 'authCompletePasswordReset') {
    if (!localLoginAllowed()) return unifiedJson_(linkClosedResponse());
    var completed = unifiedOutputObject_(handleCompletePasswordReset(
      body.email || body.username || body.login_id || body.ymis, body.code, body.newPassword))
      || { success: false, error: '暫時未能重設密碼' };
    completed.ok = completed.success === true;
    return unifiedJson_(completed);
  }
  var actor = unifiedResolveActor_(body, false);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  if (actor.source === 'central-sso') {
    return unifiedJson_({ ok: false, success: false, code: 'CENTRAL_IDENTITY_MANAGED',
      error: '隔離 auth fixture 身份不設支部本地密碼或帳戶 mutation' });
  }
  if (action === 'authChangePassword') {
    var changed = unifiedOutputObject_(handleChangePassword(actor.ymis, body.oldPassword, body.newPassword, body.sessionToken));
    if (!changed) changed = { success: false, error: '改密碼失敗' };
    changed.ok = changed.success === true;
    if (changed.success) {
      changed.sessionToken = body.sessionToken;
      var meta = unifiedTokenMeta_(body.sessionToken);
      changed.sessionExpiresAt = meta && meta.expires ? new Date(meta.expires).getTime() : 0;
      changed.mustChangePw = false;
    }
    return unifiedJson_(changed);
  }
  // Account creation/deletion/reset through the old Portal aliases would create
  // a second identity source. Branch accounts are managed by the pinned BADGE Users
  // actions; these legacy aliases therefore remain disabled.
  return unifiedJson_({ ok: false, success: false, code: 'BRANCH_IDENTITY_MANAGED',
    error: '支部帳戶由 BADGE Users 管理；請使用支部帳戶管理功能' });
}

function unifiedActorCan_(actor, action) {
  if (!actor || !actor.ok) return false;
  var scopes = Array.isArray(actor.scopes) ? actor.scopes : unifiedScopesForRole_(actor.role);
  if (UNIFIED_ADMIN_READ_ACTIONS[action]) return scopes.indexOf('branch:read') >= 0 && unifiedRoleRank_(actor.role) >= unifiedRoleRank_('exco');
  if (UNIFIED_ADMIN_WRITE_ACTIONS[action]) return scopes.indexOf('branch:write') >= 0 && unifiedRoleRank_(actor.role) >= unifiedRoleRank_('exco');
  if (UNIFIED_ADMIN_DANGEROUS_ACTIONS[action]) return scopes.indexOf('branch:repair') >= 0 && unifiedRoleRank_(actor.role) >= unifiedRoleRank_('leader');
  return false;
}

function unifiedCanonicalMembers_(existing) {
  var old = Array.isArray(existing) ? existing : [];
  var byYmis = {};
  old.forEach(function (m) {
    var key = String(m && m.ymis || '').trim().toLowerCase();
    if (key && !byYmis[key]) byYmis[key] = m;
  });
  var users = {};
  getAllUsers().forEach(function (u) { users[String(u.ymis || '').trim().toLowerCase()] = u; });
  var out = [];
  var seen = {};
  var sheet = getSheet().getSheetByName('成員名單');
  var rows = sheet ? sheet.getDataRange().getValues() : [];
  for (var i = 1; i < rows.length; i++) {
    var ymis = String(rows[i][0] || '').trim();
    if (!ymis || isSuperAdminId(ymis)) continue;
    var key = ymis.toLowerCase();
    var prior = byYmis[key] || {};
    var user = users[key] || {};
    var merged = {};
    for (var p in prior) if (Object.prototype.hasOwnProperty.call(prior, p)) merged[p] = prior[p];
    merged.id = String(prior.id || ('member_' + sha256Hex(ymis).substring(0, 12)));
    merged.ymis = ymis;
    /* Build the prospective canonical row in memory. Incoming ordinary roster
       fields may change, but identity always comes from Users; no Sheet is
       mutated until the compatibility save has actually succeeded. */
    merged.name = safeSheetText(prior.name, 100) || String(rows[i][1] || user.name || '');
    merged.branch = safeSheetText(prior.branch, 100) || String(rows[i][3] || user.branch || '');
    merged.email = isEmail(prior.email) ? String(prior.email).trim()
      : String(user.email || (isEmail(rows[i][4]) ? rows[i][4] : ''));
    merged.phone = safeSheetText(prior.phone, 80)
      || (isEmail(rows[i][4]) ? '' : String(rows[i][4] || ''));
    merged.identity = unifiedRoleFromBackend_(user.role || 'member');
    merged.status = user.status === 'inactive' ? 'inactive' : (prior.status || 'active');
    delete merged.pw; delete merged.hubPw; delete merged.password; delete merged.hubPassword;
    out.push(merged); seen[key] = true;
  }
  // Never silently delete legacy Portal records merely because an older Sheet
  // has not yet mirrored them.  They remain visible and will be additively
  // inserted into 成員名單 on the next authorised save.
  old.forEach(function (m) {
    var key = String(m && m.ymis || '').trim().toLowerCase();
    if (!key || seen[key]) return;
    var kept = {};
    for (var p in m) if (Object.prototype.hasOwnProperty.call(m, p)) kept[p] = m[p];
    kept.name = safeSheetText(kept.name, 100);
    kept.branch = safeSheetText(kept.branch, 100);
    kept.email = isEmail(kept.email) ? String(kept.email).trim() : '';
    kept.phone = safeSheetText(kept.phone, 80);
    /* A newly submitted roster row has no Users authority yet and therefore
       starts as member. Role changes only arrive through authoritative branch Users data. */
    kept.identity = users[key] ? unifiedRoleFromBackend_(users[key].role || 'member') : 'member';
    delete kept.pw; delete kept.hubPw; delete kept.password; delete kept.hubPassword;
    out.push(kept); seen[key] = true;
  });
  return out;
}

function unifiedAuthoritativeIdentityMap_() {
  var out = {};
  getAllUsers().forEach(function (user) {
    var key = String(user && user.ymis || '').trim().toLowerCase();
    if (key && !isSuperAdminId(key)) out[key] = unifiedRoleFromBackend_(user.role || 'member');
  });
  return out;
}

function unifiedAccountProjection_(members) {
  var memberByYmis = {};
  (members || []).forEach(function (m) { memberByYmis[String(m.ymis || '').trim().toLowerCase()] = m; });
  return getAllUsers().filter(function (u) { return u && u.status !== 'deleted' && !isSuperAdminId(u.ymis); }).map(function (u) {
    var member = memberByYmis[String(u.ymis || '').trim().toLowerCase()] || {};
    return {
      id: 'central:' + String(u.ymis || ''), memberId: String(member.id || u.ymis || ''),
      username: String(u.email || u.ymis || ''), email: String(u.email || ''), name: String(u.name || member.name || ''),
      role: unifiedRoleFromBackend_(u.role), active: u.status === 'active', source: 'central-or-rescue'
    };
  });
}

function unifiedUpsertRoster_(members) {
  if (!Array.isArray(members)) return;
  var sheet = getSheet().getSheetByName('成員名單');
  if (!sheet) {
    sheet = getSheet().insertSheet('成員名單');
    sheet.appendRow(['YMIS', '姓名', '加入日期', '支部', '聯絡']);
  }
  var rows = sheet.getDataRange().getValues();
  var rowByYmis = {};
  for (var i = 1; i < rows.length; i++) rowByYmis[String(rows[i][0] || '').trim().toLowerCase()] = i + 1;
  members.forEach(function (m) {
    var ymis = safeSheetText(m && m.ymis, 40);
    var name = safeSheetText(m && m.name, 100);
    if (!ymis || !name || isSuperAdminId(ymis)) return;
    var branch = safeSheetText(m.branch, 100);
    var contact = safeSheetText(m.email || m.phone, 160);
    var row = rowByYmis[ymis.toLowerCase()];
    if (row) {
      sheet.getRange(row, 2).setValue(name);
      if (branch) sheet.getRange(row, 4).setValue(branch);
      if (contact) sheet.getRange(row, 5).setValue(contact);
    } else {
      sheet.appendRow([ymis, name, new Date(), branch, contact]);
      rowByYmis[ymis.toLowerCase()] = sheet.getLastRow();
    }
    var rec = findUserRecord(ymis);
    if (rec) {
      if (rec.map.name !== undefined) rec.sheet.getRange(rec.row, rec.map.name + 1).setValue(name);
      if (contact && isEmail(contact) && rec.map.email !== undefined) rec.sheet.getRange(rec.row, rec.map.email + 1).setValue(contact);
      if (branch && rec.map.branch !== undefined) rec.sheet.getRange(rec.row, rec.map.branch + 1).setValue(branch);
      /* Users.role is the central authorization mirror. Administrative roster
         saves may update contact fields, never role; SSO refresh owns role sync. */
    }
  });
}

function unifiedPrepareAdminDb_(db) {
  db = db && typeof db === 'object' && !Array.isArray(db) ? db : {};
  db.members = unifiedCanonicalMembers_(db.members || []);
  db.accounts = unifiedAccountProjection_(db.members);
  return db;
}

function unifiedPortalEvent_(e, body) {
  var clone = {};
  for (var k in (e || {})) if (Object.prototype.hasOwnProperty.call(e, k)) clone[k] = e[k];
  clone.postData = { contents: JSON.stringify(body) };
  return clone;
}

function unifiedPortalAdmin_(e, body, signedActor) {
  var action = String(body.action || '');
  if (UNIFIED_PUBLIC_PORTAL_ACTIONS[action]) {
    return PortalAdminCompat_.dispatchBody(e, body);
  }
  var actor = signedActor || unifiedResolveActor_(body, false);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  if (!unifiedActorCan_(actor, action)) {
    return unifiedJson_({ ok: false, success: false, code: 'ACTION_SCOPE_DENIED', error: '你的身份不可以執行此操作' });
  }
  // The compatibility module still checks API_KEY and its own session gate internally.
  // This router has already resolved the baseline/central actor and enforced scope, so
  // inject a server-only marker here. Incoming clients cannot set it (doPost strips it).
  body.apiKey = getApiKey();
  delete body.apikey;
  body.__serverSigned = true;
  /* Compatibility 仍要逐欄核對普通 exco／leader 的 identity 寫入。marker 只在
     unified router 驗完 opaque actor 後記憶體注入；platform-super 保留完整 bypass。 */
  if (actor.source !== 'server-super') {
    body.__serverActorRole = String(actor.role || 'member');
    body.__serverActorSubject = String(actor.ymis || '');
  }
  /* Keep the requested roster for a post-confirmation mirror update. Calling
     unifiedUpsertRoster_ before compatibility validation used to mutate 成員名單
     and Users even when a stale version or protected-field request was rejected. */
  var rosterAfterSuccess = null;
  if (action === 'saveDb' || action === 'saveDbForce') {
    rosterAfterSuccess = body.db && Array.isArray(body.db.members) ? body.db.members : null;
    body.db = unifiedPrepareAdminDb_(body.db);
  } else if (action === 'saveTables') {
    body.tables = body.tables && typeof body.tables === 'object' ? body.tables : {};
    if (Object.prototype.hasOwnProperty.call(body.tables, 'members')) {
      rosterAfterSuccess = Array.isArray(body.tables.members) ? body.tables.members : null;
      body.tables.members = unifiedCanonicalMembers_(body.tables.members);
    }
    if (Object.prototype.hasOwnProperty.call(body.tables, 'accounts')) {
      body.tables.accounts = unifiedAccountProjection_(unifiedCanonicalMembers_(body.tables.members || []));
    }
  }
  if (actor.source !== 'server-super') body.__serverIdentityMap = unifiedAuthoritativeIdentityMap_();
  var out = PortalAdminCompat_.dispatchBody(unifiedPortalEvent_(e, body), body);
  var parsed = unifiedOutputObject_(out);
  if (!parsed) return out;
  if (parsed.success === true) {
    if (action === 'saveDbCommit') {
      var committed = PortalAdminCompat_.loadDb(String(body.unit || ''));
      rosterAfterSuccess = committed && committed.success && committed.db && Array.isArray(committed.db.members)
        ? committed.db.members : null;
    }
    if (rosterAfterSuccess) {
      try { unifiedUpsertRoster_(rosterAfterSuccess); }
      catch (rosterErr) {
        /* The compatibility DB is already confirmed. Report a recoverable mirror
           warning instead of claiming the rejected request changed nothing or
           falsely changing success into a total failure. A retry is idempotent. */
        parsed.rosterSyncPending = true;
        parsed.warning = '行政資料已儲存，但中央名冊鏡像未完成；請重試同步';
      }
    }
  }
  if (parsed.db && (action === 'loadDb' || action === 'loadTables')) {
    parsed.db = unifiedPrepareAdminDb_(parsed.db);
  }
  if (action === 'loadTablesPart' && parsed.found) {
    if (parsed.name === 'members') parsed.value = unifiedCanonicalMembers_(parsed.value || []);
    if (parsed.name === 'accounts') parsed.value = unifiedAccountProjection_(unifiedCanonicalMembers_([]));
  }
  parsed.unifiedGsVersion = UNIFIED_GS_VERSION;
  return unifiedOutput_(parsed);
}

function unifiedLoadMine_(ymis) {
  var all = unifiedOutputObject_(handleLoad()) || {};
  var member = null;
  (all.members || []).some(function (m) {
    if (String(m.ymis || '') === String(ymis || '')) { member = m; return true; }
    return false;
  });
  var progress = {}; progress[ymis] = (all.progress && all.progress[ymis]) || {};
  var flat = {}; flat[ymis] = (all.flatProgress && all.flatProgress[ymis]) || {};
  var other = {}; other[ymis] = (all.otherBadges && all.otherBadges[ymis]) || {};
  return { success: true, ok: true, member: member, members: member ? [member] : [],
    progress: progress, flatProgress: flat, otherBadges: other,
    logs: (all.logs || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    logRequests: (all.logRequests || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    requests: (all.pendingRequests || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    unifiedGsVersion: UNIFIED_GS_VERSION };
}

function unifiedPersonalProgress_(e, body, raw) {
  var action = String(body.action || '');
  var signed = unifiedVerifyLinkSig_(e, body, raw, UNIFIED_PERSONAL_PROGRESS_ACTIONS);
  var actor = null;
  if (!signed) {
    actor = unifiedResolveActor_(body, false);
    if (!actor.ok) return unifiedJson_({ success: false, ok: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  }
  var ymis = String((signed ? body.ymis : actor.ymis) || '').trim();
  if (!ymis) return unifiedJson_({ success: false, ok: false, error: '登入帳戶未綁定 YMIS' });
  if (action === 'loadMine') return unifiedJson_(unifiedLoadMine_(ymis));
  if (action === 'myRequests') {
    var all = unifiedOutputObject_(handleGetPendingRequests()) || {};
    return unifiedJson_({ success: true, ok: true,
      requests: (all.requests || []).filter(function (r) { return String(r.ymis || '') === ymis; }),
      unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  if (action === 'addRequest') {
    var result = handleRequestComplete({
      itemId: body.item_id || body.itemId, itemName: body.item_name || body.itemName,
      requested_date: body.requested_date, evidence: body.evidence,
      items: body.items
    }, ymis);
    return result;
  }
  return unifiedJson_({ success: false, ok: false, error: 'Unknown personal progress action' });
}

// Member hub uses a deliberately separate contract from administrative loadDb:
// one opaque session, one roster identity, one visibility-filtered projection.
// Client memberId/role fields are never authoritative.
function unifiedHubClone_(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (err) { return null; }
}
// Positive output schemas: future admin columns remain private until explicitly listed.
function unifiedHubRsvp_(row) {
  if (!row || typeof row !== 'object') return null;
  return { status: String(row.status || row || ''), at: String(row.at || ''), name: String(row.name || ''),
    time: String(row.time || ''), reason: String(row.reason || '') };
}
function unifiedHubQuestion_(row) {
  row = row || {};
  return { id: String(row.id || ''), prompt: String(row.prompt || ''), type: String(row.type || 'short'),
    options: (Array.isArray(row.options) ? row.options : []).map(String), required: !!row.required };
}
function unifiedHubAnswers_(raw, questions) {
  var out = {}; raw = raw && typeof raw === 'object' ? raw : {};
  (questions || []).forEach(function (question) {
    var id = String(question && question.id || ''); if (!id) return;
    var value = raw[id];
    out[id] = question.type === 'multi'
      ? (Array.isArray(value) ? value : []).map(String)
      : String(value === undefined || value === null ? '' : value);
  });
  return out;
}
function unifiedHubEvent_(row, memberId) {
  row = row || {};
  var out = { id: String(row.id || ''), title: String(row.title || ''), date: String(row.date || ''),
    dateEnd: String(row.dateEnd || ''), time: String(row.time || ''), venue: String(row.venue || ''),
    detail: String(row.detail || ''), status: String(row.status || ''), vis: String(row.vis || ''),
    visibility: String(row.visibility || ''), rsvp: {} };
  var mine = row.rsvp && row.rsvp[memberId];
  if (mine !== undefined) out.rsvp[memberId] = unifiedHubRsvp_(mine);
  return out;
}
function unifiedHubQuiz_(row, memberId) {
  row = row || {};
  var questions = (Array.isArray(row.questions) ? row.questions : []).map(unifiedHubQuestion_);
  var out = { id: String(row.id || ''), title: String(row.title || ''), note: String(row.note || ''),
    status: String(row.status || ''), vis: String(row.vis || ''), questions: questions, responses: {} };
  var mine = row.responses && row.responses[memberId];
  if (mine !== undefined) out.responses[memberId] = { name: String(mine && mine.name || ''),
    at: String(mine && mine.at || ''), answers: unifiedHubAnswers_(mine && mine.answers, questions) };
  return out;
}
function unifiedHubNotice_(row) {
  row = row || {};
  var title = row.title && typeof row.title === 'object'
    ? { zh: String(row.title.zh || ''), en: String(row.title.en || '') }
    : { zh: String(row.title || ''), en: '' };
  return { id: String(row.id || ''), title: title, status: String(row.status || ''), vis: String(row.vis || ''),
    type: String(row.type || ''), eventDate: String(row.eventDate || ''), deadline: String(row.deadline || ''),
    needSignup: !!row.needSignup, publishAt: String(row.publishAt || '') };
}
function unifiedHubAbsence_(row) {
  row = row || {};
  return { id: String(row.id || ''), at: String(row.at || ''), unit: String(row.unit || ''),
    memberId: String(row.memberId || ''), ymis: String(row.ymis || ''), date: String(row.date || ''),
    slot: String(row.slot || ''), reason: String(row.reason || ''), plan: String(row.plan || ''),
    status: String(row.status || ''), reviewedBy: String(row.reviewedBy || ''),
    reviewedAt: String(row.reviewedAt || ''), reviewNote: String(row.reviewNote || '') };
}
function unifiedHubRank_(role) {
  var r = String(role || '').toLowerCase();
  if (r === 'super' || r === 'chief' || r === 'admin' || r === 'group_leader' || r === 'super_admin') return 5;
  if (r === 'leader' || r === 'branch_leader') return 4;
  if (r === 'exco' || r === 'exec_committee') return 3;
  return r === 'member' ? 2 : 0;
}
function unifiedHubVisRank_(vis, fallback) {
  var v = String(vis || fallback || 'member').toLowerCase();
  return v === 'other' ? 1 : v === 'member' ? 2 : v === 'exco' ? 3 : v === 'leader' ? 4 : v === 'chief' ? 5 : 2;
}
function unifiedHubVisible_(record, kind, role) {
  var fallback = kind === 'notice' ? 'other' : 'member';
  if (kind === 'event' && record && record.visibility === 'exco') fallback = 'exco';
  return unifiedHubVisRank_(record && record.vis, fallback) <= unifiedHubRank_(role);
}
function unifiedHubContext_(loaded, actor) {
  if (!loaded || loaded.success !== true || !loaded.db) return { ok: false, error: loaded && loaded.error || '後端未有資料庫' };
  var db = loaded.db;
  db.members = unifiedCanonicalMembers_(db.members || []);
  var wanted = String(actor.ymis || '').trim().toLowerCase();
  var member = null;
  db.members.some(function (row) {
    if (row && row.status !== 'alumni' && String(row.ymis || '').trim().toLowerCase() === wanted) { member = row; return true; }
    return false;
  });
  if (!member) return { ok: false, code: 'SESSION_ACCOUNT_MISSING', error: '登入帳戶未綁定有效名冊成員' };
  return { ok: true, db: db, member: member, role: actor.role, version: loaded.version || '', at: loaded.at || '' };
}
function unifiedHubPublic_(profile, role) {
  var src = profile && typeof profile === 'object' ? profile : {};
  var socials = Array.isArray(src.socials) ? src.socials : [];
  var albums = Array.isArray(src.albums) ? src.albums : [];
  var links = Array.isArray(src.links) ? src.links : [];
  var managed = {};
  socials.forEach(function (item) {
    var kind = String(item && item.kind || '').toLowerCase();
    if (item && item.url && (kind === 'instagram' || kind === 'facebook' || kind === 'whatsapp')) managed[kind] = true;
  });
  if (albums.some(function (item) { return !!(item && item.url); })) managed.album = true;
  if (src.site && src.site.url) managed.website = true;
  function list(rows) {
    return rows.filter(function (item) { return item && item.url && unifiedHubVisible_(item, 'profile', role); })
      .map(unifiedHubClone_);
  }
  return { socials: list(socials), albums: list(albums), links: list(links),
    site: src.site && src.site.url && unifiedHubVisible_(src.site, 'profile', role) ? unifiedHubClone_(src.site) : { url: '', vis: 'member' },
    about: src.about && src.about.text && unifiedHubVisible_(src.about, 'profile', role) ? unifiedHubClone_(src.about) : { text: '', vis: 'member' },
    managedSlots: Object.keys(managed) };
}
function unifiedHubProjection_(ctx) {
  var db = ctx.db;
  var member = ctx.member;
  var memberId = String(member.id || '');
  var ymis = String(member.ymis || '');
  var role = ctx.role;
  var unit = db.unit || {};
  var profile = db.profile || unit;
  var events = (db.events || []).filter(function (row) {
    return row && row.status !== 'cancelled' && unifiedHubVisible_(row, 'event', role);
  }).map(function (row) { return unifiedHubEvent_(row, memberId); });
  var quizzes = (db.quizzes || []).filter(function (row) {
    return row && row.status !== 'closed' && unifiedHubVisible_(row, 'quiz', role);
  }).map(function (row) { return unifiedHubQuiz_(row, memberId); });
  var notices = (db.notices || []).filter(function (row) {
    return row && row.status === 'published' && unifiedHubVisible_(row, 'notice', role);
  }).map(unifiedHubNotice_);
  return { schema: db.schema || 2, kind: 'real', unitCode: String(db.unitCode || ''),
    unit: { code: String(unit.code || db.unitCode || ''), name: String(unit.name || ''), nameEn: String(unit.nameEn || ''), short: String(unit.short || ''), theme: unifiedHubClone_(unit.theme || {}) },
    profile: { code: String(profile.code || db.unitCode || ''), name: String(profile.name || unit.name || ''), nameEn: String(profile.nameEn || unit.nameEn || ''), short: String(profile.short || unit.short || ''), theme: unifiedHubClone_(profile.theme || unit.theme || {}) },
    settings: { troopLinks: unifiedHubClone_(db.settings && db.settings.troopLinks || {}),
      publicLinks: unifiedHubClone_(db.settings && db.settings.publicLinks || {}),
      publicBaseUrl: String(db.settings && db.settings.publicBaseUrl || '') },
    publicProfile: unifiedHubPublic_(db.publicProfile, role),
    members: [{ id: memberId, ymis: ymis, name: String(member.name || ''), email: String(member.email || ''),
      identity: String(role || 'member'), status: String(member.status || 'active') }], accounts: [],
    events: events, quizzes: quizzes, notices: notices,
    absences: (db.absences || []).filter(function (row) {
      return row && ((memberId && String(row.memberId || '') === memberId) || (ymis && String(row.ymis || '') === ymis));
    }).map(unifiedHubAbsence_),
    meta: { updatedAt: String(db.meta && db.meta.updatedAt || ''), hubView: true } };
}
function unifiedHubEmpty_(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}
function unifiedHubMutate_(ctx, body) {
  var db = ctx.db;
  var member = ctx.member;
  var memberId = String(member.id || '');
  var action = String(body.action || '');
  if (action === 'hubRsvp') {
    var event = (db.events || []).filter(function (row) { return row && String(row.id || '') === String(body.eventId || ''); })[0];
    if (!event || event.status === 'cancelled' || !unifiedHubVisible_(event, 'event', ctx.role)) return { ok: false, error: '搵唔到可回覆嘅活動' };
    var end = String(event.dateEnd || event.date || '').slice(0, 10);
    if (end && end < new Date().toISOString().slice(0, 10)) return { ok: false, error: '活動已經完結' };
    var status = String(body.status || '').toLowerCase();
    if (['present', 'absent', 'late', 'early'].indexOf(status) < 0) return { ok: false, error: '出席狀態唔正確' };
    var reason = String(body.reason || '').trim().slice(0, 500);
    var time = String(body.time || '').trim();
    if (status === 'absent' && !reason) return { ok: false, error: '不出席要填原因' };
    if ((status === 'late' || status === 'early') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: '時間格式唔正確' };
    event.rsvp = event.rsvp && typeof event.rsvp === 'object' ? event.rsvp : {};
    event.rsvp[memberId] = { status: status, at: new Date().toISOString().slice(0, 10), name: String(member.name || ''),
      time: status === 'late' || status === 'early' ? time : '', reason: reason };
    return { ok: true };
  }
  if (action === 'hubQuiz') {
    var quiz = (db.quizzes || []).filter(function (row) { return row && String(row.id || '') === String(body.quizId || ''); })[0];
    if (!quiz || quiz.status === 'closed' || !unifiedHubVisible_(quiz, 'quiz', ctx.role)) return { ok: false, error: '搵唔到可提交嘅試卷' };
    var supplied = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    if (JSON.stringify(supplied).length > 50000) return { ok: false, error: '答卷太大' };
    var answers = {};
    (quiz.questions || []).forEach(function (question) {
      var qid = String(question && question.id || '');
      if (!qid) return;
      var value = supplied[qid];
      if (question.type === 'multi') {
        var options = (question.options || []).map(String);
        value = (Array.isArray(value) ? value : []).map(String).filter(function (answer) { return options.indexOf(answer) >= 0; }).slice(0, 50);
      } else if (question.type === 'single') {
        var choices = (question.options || []).map(String);
        value = String(value || ''); if (choices.indexOf(value) < 0) value = '';
      } else value = String(value || '').slice(0, question.type === 'para' ? 5000 : 1000);
      if (question.required && unifiedHubEmpty_(value)) throw new Error('請填：' + String(question.prompt || ''));
      answers[qid] = value;
    });
    quiz.responses = quiz.responses && typeof quiz.responses === 'object' ? quiz.responses : {};
    quiz.responses[memberId] = { name: String(member.name || ''), at: new Date().toISOString().slice(0, 10), answers: answers };
    return { ok: true };
  }
  if (action === 'hubAbsence') {
    db.absences = Array.isArray(db.absences) ? db.absences : [];
    if (body.op === 'withdraw') {
      var index = -1;
      for (var i = 0; i < db.absences.length; i++) if (String(db.absences[i] && db.absences[i].id || '') === String(body.id || '')) { index = i; break; }
      var existing = index >= 0 ? db.absences[index] : null;
      if (!existing) return { ok: true, idempotent: true };
      if (String(existing.memberId || '') !== memberId && String(existing.ymis || '') !== String(member.ymis || '')) return { ok: false, error: '呢張唔係你嘅請假單' };
      if (existing.status !== 'pending') return { ok: false, error: '已經處理咗，唔可以撤回' };
      db.absences.splice(index, 1); return { ok: true };
    }
    if (body.op !== 'create') return { ok: false, error: '請假操作唔正確' };
    var date = String(body.date || '').trim();
    var reasonA = String(body.reason || '').trim();
    var slot = String(body.slot || 'full');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < new Date().toISOString().slice(0, 10)) return { ok: false, error: '請揀今日或之後嘅日子' };
    if (!reasonA || reasonA.length > 2000) return { ok: false, error: '請寫 1 至 2000 字原因' };
    if (['full', 'am', 'pm', 'evening'].indexOf(slot) < 0) slot = 'full';
    var id = String(body.id || '');
    var planA = String(body.plan || '').trim().slice(0, 500);
    if (!/^ab_[A-Za-z0-9_-]{1,80}$/.test(id)) id = 'ab_' + Utilities.getUuid().replace(/-/g, '');
    var duplicate = null;
    db.absences.some(function (row) { if (String(row && row.id || '') === id) { duplicate = row; return true; } return false; });
    if (duplicate) {
      var sameOwner = String(duplicate.memberId || '') === memberId || String(duplicate.ymis || '') === String(member.ymis || '');
      var sameBody = String(duplicate.date || '') === date && String(duplicate.slot || '') === slot &&
        String(duplicate.reason || '') === reasonA && String(duplicate.plan || '') === planA;
      return sameOwner && sameBody ? { ok: true, id: id, idempotent: true } : { ok: false, error: '請假單編號重複' };
    }
    db.absences.push({ id: id, at: new Date().toISOString(), unit: String(db.unitCode || ''), memberId: memberId,
      ymis: String(member.ymis || ''), date: date, slot: slot, reason: reasonA, plan: planA,
      status: 'pending', reviewedBy: '', reviewedAt: '', reviewNote: '' });
    return { ok: true, id: id };
  }
  return { ok: false, error: '未知團員入口操作' };
}
function unifiedHubSave_(unit, ctx) {
  /* unifiedMemberHub_ has already fixed the actor and mutation to one member. The
     compatibility save gate therefore receives only this in-memory trusted marker. */
  var body = { action: 'saveDb', unit: unit, apiKey: getApiKey(), __serverSigned: true, db: ctx.db,
    baseVersion: ctx.version || '', refreshReports: false };
  return unifiedOutputObject_(PortalAdminCompat_.dispatchBody(unifiedPortalEvent_(null, body), body)) || { success: false, error: '儲存失敗' };
}
function unifiedMemberHub_(body) {
  var actor = unifiedResolveActor_(body, false);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  var unit = String(body.unit || '');
  if (body.action === 'hubLoad') {
    var read = unifiedHubContext_(PortalAdminCompat_.loadDb(unit), actor);
    if (!read.ok) return unifiedJson_({ ok: false, success: false, code: read.code || '', error: read.error });
    return unifiedJson_({ ok: true, success: true, found: true, db: unifiedHubProjection_(read),
      version: read.version, at: read.at, role: read.role, unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  for (var attempt = 0; attempt < 2; attempt++) {
    var ctx = unifiedHubContext_(PortalAdminCompat_.loadDb(unit), actor);
    if (!ctx.ok) return unifiedJson_({ ok: false, success: false, code: ctx.code || '', error: ctx.error });
    var applied;
    try { applied = unifiedHubMutate_(ctx, body); }
    catch (err) { applied = { ok: false, error: String(err && err.message || err) }; }
    if (!applied.ok) return unifiedJson_({ ok: false, success: false, error: applied.error });
    var saved = unifiedHubSave_(unit, ctx);
    if (saved.success === true) {
      return unifiedJson_({ ok: true, success: true, id: applied.id || '', version: saved.version || '',
        db: unifiedHubProjection_(ctx), unifiedGsVersion: UNIFIED_GS_VERSION });
    }
    if (!saved.conflict) return unifiedJson_({ ok: false, success: false, error: saved.error || '儲存失敗' });
  }
  return unifiedJson_({ ok: false, success: false, code: 'WRITE_CONFLICT', error: '資料已更新，請再試一次' });
}

function initializeSheets() {
  var badge = badgeInitializeSheets_();
  var admin = null;
  try { admin = PortalAdminCompat_.initializeSheets(); }
  catch (err) {
    return { success: false, badge: badge, admin: null,
      error: '進度基線已初始化，但行政分頁增補失敗：' + String(err && err.message || err),
      unifiedGsVersion: UNIFIED_GS_VERSION };
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ALLOW_LOCAL_LOGIN', 'true');
  props.setProperty(UNIFIED_INITIALIZED_PROP, UNIFIED_GS_VERSION);
  return { success: true, badge: badge, admin: admin, preservedExistingData: true,
    unifiedGsVersion: UNIFIED_GS_VERSION };
}

/* 支部本地帳戶／session 是正常登入，Sheet 選單不可關閉。Pinned BADGE
   baseline 的 legacy helpers 只為來源兼容保留；Progress client 與 API 不路由入口控制。 */
function menuLocalLoginOff() {
  var message = '支部本地帳戶／session 係正常登入來源，必須保持開啟。';
  try { SpreadsheetApp.getUi().alert('不可關閉支部本地入口', message, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  try { setLocalLoginAllowed(true, 'unified-branch-login-guard'); } catch (e2) {}
  try { Logger.log(message); } catch (e3) {}
  return { success: false, code: 'BRANCH_LOCAL_LOGIN_REQUIRED', error: message,
    allow_local_login: localLoginAllowed() };
}

function onOpen() {
  /* Branch deployment exposes only branch-safe owner operations. Pinned baseline
     legacy controls are not a Progress contract and never appear in this Sheet menu. */
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🔗 支部系統')
      .addItem('🔧 初始化／更新（執行 initializeSheets）', 'menuInitializeSheets')
      .addItem('⏱️ 密碼 KDF 速度測試', 'menuBenchmarkPasswordKdf')
      .addSeparator()
      .addItem('📤 匯出支部帳戶 JSON（含 hash）', 'menuExportUsersJson')
      .addItem('📥 匯入支部帳戶 JSON', 'menuImportUsersJson')
      .addSeparator()
      .addItem('🔑 顯示 API KEY（交 APP ADMIN）', 'menuShowLinkCredentials')
      .addItem('🔓 開啟／復原本地登入', 'menuLocalLoginOn')
      .addToUi();
  } catch (e) { /* headless */ }
}

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || '');
  if (action === 'notices' || action === 'constitution' || action === 'status' || action === 'ping' || action === 'test') {
    return PortalAdminCompat_.doGet(e);
  }
  return badgeDoGet_(e);
}

function doPost(e) {
  var parsed = unifiedBody_(e);
  var body = parsed.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return unifiedJson_({ success: false, ok: false, error: '請求格式錯誤' });
  }
  if (Object.prototype.hasOwnProperty.call(body, '__serverSigned')) delete body.__serverSigned;
  if (Object.prototype.hasOwnProperty.call(body, '__serverActorRole')) delete body.__serverActorRole;
  if (Object.prototype.hasOwnProperty.call(body, '__serverActorSubject')) delete body.__serverActorSubject;
  if (Object.prototype.hasOwnProperty.call(body, '__serverIdentityMap')) delete body.__serverIdentityMap;
  var action = String(body.action || '');
  /* Pinned BADGE keeps these historical handlers internally, but the Unified public
     router never exposes an entrance-state or entrance-control contract. Invoking an
     old action restores the required local-login flag and fails closed. */
  if (action === 'getLinkState' || action === 'setLocalLogin') {
    PropertiesService.getScriptProperties().setProperty('ALLOW_LOCAL_LOGIN', 'true');
    return unifiedJson_({ ok: false, success: false, code: 'BRANCH_LOCAL_LOGIN_REQUIRED',
      error: '支部本地登入必須保持開啟；Unified 不提供入口狀態或控制 action' });
  }
  try {
    if (UNIFIED_PORTAL_AUTH_ACTIONS[action]) {
      // authWhoAmI may be wrapped in the pinned baseline's server signature
      // transport. Verify/consume it, but identity still comes from the opaque
      // user session — a transport signature never becomes a user login.
      if (body.sig || (e && e.parameter && e.parameter.sig)) {
        var signedAuthActions = action === 'authWhoAmI' ? { authWhoAmI: 1 } : UNIFIED_ACCOUNT_ADMIN_ACTIONS;
        if (!unifiedVerifyLinkSig_(e, body, parsed.raw, signedAuthActions)) {
          return unifiedJson_({ success: false, ok: false, error: '簽名無效' });
        }
        /* Platform super 已由同源 API 驗證，但 Unified 帳戶權威係 pinned
           BADGE Users；不可藉舊 Portal alias 另建第二套身份。 */
        if (UNIFIED_ACCOUNT_ADMIN_ACTIONS[action] && body.unified_super === true
            && String(body.on_behalf || '') === 'sheep') {
          return unifiedJson_({ success: false, ok: false, code: 'BRANCH_IDENTITY_MANAGED',
            error: '支部帳戶由 BADGE Users 管理；請使用支部帳戶管理功能' });
        }
      }
      return unifiedAuthAlias_(action, body);
    }
    if (UNIFIED_PERSONAL_PROGRESS_ACTIONS[action]) return unifiedPersonalProgress_(e, body, parsed.raw);
    if (UNIFIED_MEMBER_HUB_ACTIONS[action]) return unifiedMemberHub_(body);
    if (UNIFIED_PUBLIC_PORTAL_ACTIONS[action] || UNIFIED_ADMIN_READ_ACTIONS[action] ||
        UNIFIED_ADMIN_WRITE_ACTIONS[action] || UNIFIED_ADMIN_DANGEROUS_ACTIONS[action]) {
      var signedActor = null;
      var unifiedAdminActions = {};
      var actionSet;
      [UNIFIED_ADMIN_READ_ACTIONS, UNIFIED_ADMIN_WRITE_ACTIONS, UNIFIED_ADMIN_DANGEROUS_ACTIONS].forEach(function (set) {
        for (actionSet in set) if (Object.prototype.hasOwnProperty.call(set, actionSet)) unifiedAdminActions[actionSet] = 1;
      });
      // Only the same-origin server sets these HMAC-covered flags after
      // verifying its own 8-hour platform super session.
      if (body.unified_super === true && String(body.on_behalf || '') === 'sheep' &&
          (body.sig || (e && e.parameter && e.parameter.sig)) &&
          unifiedVerifyLinkSig_(e, body, parsed.raw, unifiedAdminActions)) {
        signedActor = { ok: true, ymis: 'sheep', role: 'super', source: 'server-super',
          scopes: unifiedScopesForRole_('super'),
          user: { ymis: 'sheep', name: '系統管理員', role: 'super_admin' } };
      }
      return unifiedPortalAdmin_(e, body, signedActor);
    }
    return badgeDoPost_(e);
  } catch (err) {
    return unifiedJson_({ success: false, ok: false, error: String(err && err.message || err),
      unifiedGsVersion: UNIFIED_GS_VERSION });
  }
}
