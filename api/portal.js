// 中央旅系統 → 支部入口驗證。
//
// 正式拓撲只有每旅既有的 NAME／BACKEND／APIKEY。中央旅系統像 BOOK／BADGE
// 一樣，使用已登記的同一支部 APIKEY；不需要另一組 Vercel／中央環境變數。
// API Key 只作 server-side HMAC 根密鑰，絕不交給 browser，也不直接代表身份。
//
// 安全規則：
//   · GET／網址 query 絕不可以憑 role／subject 產生登入票據。
//   · assertion 最長 90 秒，綁定固定 issuer、用途 audience 及支部，並有 jti。
//   · Vercel 再簽 60 秒 exchange token；支部 GAS 由同一 APIKEY 派生另一用途 key，
//     兌換成 opaque branch session 後立即丟棄 exchange token。
//   · assertion 重送會產生同一個 exchange jti；即使落到另一個 serverless instance，
//     支部 GAS 的 ScriptLock＋ScriptCache 仍只准第一次兌換成功。
//
// Assertion：base64url(JSON).base64url(HMAC-SHA256(body, assertionKey))
// assertionKey = hex(HMAC-SHA256("vs-portal-central-assertion-v1", APIKEY))
// payload：{ typ:'central-sso-assertion', iss:'central-travel-system',
//            aud:'vs-portal:branch:<unit>', u, role, sub, name?, iat, exp, jti }
import crypto from 'node:crypto';
import { getTrustedUnit } from './_registry.js';

const ASSERTION_MAX_AGE_MS = 90 * 1000;
const CLOCK_SKEW_MS = 15 * 1000;
const MAX_ASSERTION_LENGTH = 8192;
const MAX_LOCAL_REPLAY_MARKERS = 5000;
const CENTRAL_ASSERTION_PURPOSE = 'vs-portal-central-assertion-v1';
const BRANCH_EXCHANGE_PURPOSE = 'vs-portal-branch-exchange-v1';
const EXCHANGE_JTI_PURPOSE = 'vs-portal-branch-exchange-jti-v1';
const CENTRAL_ASSERTION_TYPE = 'central-sso-assertion';
const CENTRAL_ISSUER = 'central-travel-system';
const CENTRAL_AUDIENCE_PREFIX = 'vs-portal:branch:';
const EXCHANGE_TYPE = 'central-sso-exchange';
const EXCHANGE_ISSUER = 'vs-portal';
const EXCHANGE_AUDIENCE_PREFIX = 'unified-gas:branch:';
const ALLOWED_ROLES = ['member', 'exco', 'leader', 'chief', 'admin'];
/* Process-local fast rejection only. End-to-end one-use enforcement lives in GAS
   and uses the deterministic exchange jti, so correctness does not depend on this Map. */
const redeemed = new Map();

function b64(value) { return Buffer.from(value).toString('base64url'); }
function fromB64(value) {
  try { return Buffer.from(String(value || ''), 'base64url').toString('utf8'); } catch { return ''; }
}
function equalText(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function unixMs(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 10_000_000_000 ? n * 1000 : n;
}
function purposeKey(apiKey, purpose) {
  return crypto.createHmac('sha256', String(apiKey || '')).update(String(purpose || '')).digest('hex');
}
function tokenSignature(body, apiKey, purpose) {
  return crypto.createHmac('sha256', purposeKey(apiKey, purpose)).update(String(body || '')).digest('base64url');
}
function exchangeJti(unit, assertionJti, apiKey) {
  return crypto.createHmac('sha256', purposeKey(apiKey, EXCHANGE_JTI_PURPOSE))
    .update(`${unit}\n${assertionJti}`).digest('base64url');
}
function cleanupRedeemed(now = Date.now()) {
  for (const [key, exp] of redeemed) if (exp <= now) redeemed.delete(key);
  while (redeemed.size >= MAX_LOCAL_REPLAY_MARKERS) redeemed.delete(redeemed.keys().next().value);
}
function scopesForRole(role) {
  const scopes = ['identity:read', 'branch:read', 'progress:self'];
  if (['exco', 'leader', 'chief', 'admin'].includes(role)) scopes.push('branch:write', 'progress:manage');
  if (['leader', 'chief', 'admin'].includes(role)) scopes.push('identity:manage', 'branch:repair');
  return scopes;
}

/* One-use purpose token for immediate GAS exchange. It is never the app session. */
function portalToken(verified) {
  const { unit, role, subject, name, assertionJti } = verified;
  if (!unit?.apiKey) return '';
  const now = Date.now();
  const payload = {
    typ: EXCHANGE_TYPE,
    u: unit.code,
    role,
    src: CENTRAL_ISSUER,
    iss: EXCHANGE_ISSUER,
    aud: EXCHANGE_AUDIENCE_PREFIX + unit.code,
    sub: subject,
    name,
    scope: scopesForRole(role),
    iat: now,
    exp: now + 60 * 1000,
    jti: exchangeJti(unit.code, assertionJti, unit.apiKey)
  };
  const body = b64(JSON.stringify(payload));
  return body + '.' + tokenSignature(body, unit.apiKey, BRANCH_EXCHANGE_PURPOSE);
}

function verifyAssertion(raw) {
  raw = String(raw || '');
  if (!raw || raw.length > MAX_ASSERTION_LENGTH) return { ok: false, reason: 'assertion_invalid' };
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'assertion_invalid' };

  let payload = null;
  try { payload = JSON.parse(fromB64(parts[0])); } catch { payload = null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || String(payload.typ || '') !== CENTRAL_ASSERTION_TYPE) {
    return { ok: false, reason: 'assertion_invalid' };
  }

  const unit = getTrustedUnit(String(payload.u || ''));
  if (!unit?.apiKey) return { ok: false, reason: 'troop_backend_not_configured' };
  const expected = tokenSignature(parts[0], unit.apiKey, CENTRAL_ASSERTION_PURPOSE);
  if (!equalText(parts[1], expected)) return { ok: false, reason: 'assertion_invalid' };

  const now = Date.now();
  const iat = unixMs(payload.iat);
  const exp = unixMs(payload.exp);
  if (!iat || !exp || exp <= now - CLOCK_SKEW_MS || iat > now + CLOCK_SKEW_MS
      || exp <= iat || exp - iat > ASSERTION_MAX_AGE_MS) {
    return { ok: false, reason: 'assertion_expired' };
  }
  if (String(payload.iss || '') !== CENTRAL_ISSUER) return { ok: false, reason: 'issuer_not_allowed' };
  if (String(payload.aud || '') !== CENTRAL_AUDIENCE_PREFIX + unit.code) {
    return { ok: false, reason: 'audience_not_allowed' };
  }

  const role = String(payload.role || '').trim().toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) return { ok: false, reason: 'role_not_allowed' };
  const subject = String(payload.sub || '').trim();
  const assertionJti = String(payload.jti || '').trim();
  if (!subject || subject.length > 160 || !assertionJti || assertionJti.length > 160) {
    return { ok: false, reason: 'assertion_invalid' };
  }

  cleanupRedeemed(now);
  const replayKey = crypto.createHash('sha256').update(`${unit.code}\n${assertionJti}`).digest('hex');
  if (redeemed.has(replayKey)) return { ok: false, reason: 'assertion_replayed' };
  redeemed.set(replayKey, exp + CLOCK_SKEW_MS);

  return {
    ok: true,
    unit,
    role,
    subject,
    name: String(payload.name || '').slice(0, 160),
    assertionJti
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  }
  let input = req.body;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const verified = verifyAssertion(input.assertion);
  if (!verified.ok) return res.status(403).json(verified);

  const token = portalToken(verified);
  if (!token) return res.status(503).json({ ok: false, reason: 'troop_backend_not_configured' });
  return res.status(200).json({
    ok: true,
    role: verified.role,
    unit: verified.unit.code,
    subject: verified.subject,
    name: verified.name,
    portalToken: token,
    exchangeRequired: true,
    expiresIn: 60
  });
}
