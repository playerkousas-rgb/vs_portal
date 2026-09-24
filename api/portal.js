// 上游旅系統 → 支部入口驗證；只回公開授權結果，不回 Registry 敏感資料。
import crypto from 'node:crypto';
import { getTrustedUnit } from './_registry.js';

function originOf(value) {
  try { return new URL(String(value || '')).origin; } catch { return ''; }
}

function b64(value) { return Buffer.from(value).toString('base64url'); }
function portalToken(unit, role, source) {
  const secret = String(process.env.PORTAL_SESSION_SECRET || '');
  if (!secret) return '';
  const payload = { u: unit, role, src: source, exp: Date.now() + 10 * 60 * 1000, jti: crypto.randomUUID() };
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  const q = req.query || {};
  const unit = getTrustedUnit(String(q.u || q.unit || ''));
  if (!unit?.portalOrigin) return res.status(200).json({ ok: false, reason: 'troop_not_portal_enabled' });
  const source = originOf(q.src || req.headers?.origin || req.headers?.referer);
  if (!source || source !== originOf(unit.portalOrigin)) return res.status(200).json({ ok: false, reason: 'origin_not_allowed' });
  const role = String(q.role || '').trim().toLowerCase();
  const allowed = unit.portalRoles?.length ? unit.portalRoles : ['leader', 'admin', 'exco'];
  if (!allowed.includes(role)) return res.status(200).json({ ok: false, reason: 'role_not_allowed' });
  const token = portalToken(unit.code, role, source);
  if (!token) return res.status(200).json({ ok: false, reason: 'portal_secret_not_configured' });
  return res.status(200).json({ ok: true, role, unit: unit.code, portalToken: token, expiresIn: 600 });
}
