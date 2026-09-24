// 上游旅系統 → 支部入口驗證；只回公開授權結果，不回 Registry 敏感資料。
import { getTrustedUnit } from './_registry.js';

function originOf(value) {
  try { return new URL(String(value || '')).origin; } catch { return ''; }
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
  return res.status(200).json({ ok: true, role, unit: unit.code });
}
