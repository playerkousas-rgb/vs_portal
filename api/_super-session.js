// 短期超管 session：密碼只用嚟登入一次；之後敏感 API 核對呢張 HMAC 票據。
// 改 SUPER_KEY / Redeploy 會令舊票據即時失效。
import crypto from 'node:crypto';

const PREFIX = 'v82s';
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 15 * 1000;

function secret() {
  const value = String(process.env.SUPER_KEY || '');
  return value.length >= 16 ? value : '';
}
function b64(value) { return Buffer.from(value).toString('base64url'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function issueSuperSession(subject = 'sheep') {
  const key = secret();
  if (!key) return null;
  const now = Date.now();
  const payload = {
    typ: 'super', sub: String(subject || 'sheep'), role: 'super',
    iat: now, exp: now + MAX_AGE_MS, jti: crypto.randomUUID()
  };
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', key).update(`${PREFIX}.${body}`).digest('base64url');
  return { token: `${PREFIX}.${body}.${sig}`, expiresAt: payload.exp };
}

export function verifySuperSession(token) {
  const key = secret();
  const parts = String(token || '').split('.');
  if (!key || parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
  const expected = crypto.createHmac('sha256', key).update(`${PREFIX}.${parts[1]}`).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  const now = Date.now();
  if (!payload || payload.typ !== 'super' || payload.role !== 'super' || !payload.sub ||
      !Number.isFinite(Number(payload.iat)) || !Number.isFinite(Number(payload.exp)) ||
      Number(payload.iat) > now + CLOCK_SKEW_MS || Number(payload.exp) <= now ||
      Number(payload.exp) - Number(payload.iat) > MAX_AGE_MS) return null;
  return { role: 'super', subject: String(payload.sub), expiresAt: Number(payload.exp) };
}
