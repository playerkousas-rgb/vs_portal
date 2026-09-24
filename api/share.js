// 公開分享連結產生器：只可產生 stateless、無密鑰的公開資源網址。
import { getTrustedUnit } from './_registry.js';

const KINDS = new Set(['notice', 'calendar', 'constitution', 'member-entry', 'borrow']);
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok:false, reason:'method_not_allowed' });
  const q = req.query || {};
  const unit = getTrustedUnit(String(q.u || q.unit || ''));
  const kind = String(q.kind || '').trim().toLowerCase();
  const id = String(q.id || '').trim();
  if (!unit) return res.status(200).json({ ok:false, reason:'unit_not_registered' });
  if (!KINDS.has(kind)) return res.status(200).json({ ok:false, reason:'share_kind_not_allowed' });
  if (kind !== 'member-entry' && kind !== 'borrow' && !ID_RE.test(id)) return res.status(200).json({ ok:false, reason:'share_id_invalid' });
  const base = String(process.env.PUBLIC_APP_ORIGIN || `${req.headers?.['x-forwarded-proto'] || 'https'}://${req.headers?.host || ''}`).replace(/\/$/, '');
  const pages = { notice:'notice.html', calendar:'members.html', constitution:'constitution.html', 'member-entry':'members.html', borrow:'borrow.html' };
  const params = new URLSearchParams({ u: unit.code });
  if (id) params.set(kind === 'notice' ? 'n' : 'id', id);
  const fragment = kind === 'calendar' ? '#calendar' : '';
  return res.status(200).json({ ok:true, kind, unit:unit.code, url:`${base}/${pages[kind]}?${params.toString()}${fragment}`, qrSafe:true });
}
