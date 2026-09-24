// GET /api/modules?u=0082&role=leader
// 只回 module capability，不回 GAS URL、API key 或任何資料庫內容。
import { getTrustedUnit } from './_registry.js';
import { moduleState } from './_modules.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  const q = req.query || {};
  const unit = getTrustedUnit(String(q.u || q.unit || ''));
  if (!unit) return res.status(200).json({ ok: false, reason: 'unit_not_registered' });
  const role = String(q.role || '').trim().toLowerCase();
  return res.status(200).json({ ok: true, unit: unit.code, modules: moduleState(unit, role) });
}
