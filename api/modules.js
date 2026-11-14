// GET /api/modules?u=0082&role=leader
// 只回本支部 schema 的預設 capability metadata，不回實際 DB 權限、GAS URL、API key
// 或任何資料。有效權限只可由 GAS 按 authenticated session + db.accessControl 決定。
import { getTrustedUnit } from './_registry.js';
import { BRANCH_SCHEMA_ID, moduleState } from './_modules.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  const q = req.query || {};
  const unit = getTrustedUnit(String(q.u || q.unit || ''));
  if (!unit) return res.status(200).json({ ok: false, reason: 'unit_not_registered' });
  const role = String(q.role || '').trim().toLowerCase();
  return res.status(200).json({ ok: true, unit: unit.code, branchSchema: BRANCH_SCHEMA_ID,
    authoritative: false, modules: moduleState(unit, role) });
}
