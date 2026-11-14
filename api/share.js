// 已登入入口連結產生器：只產生 stateless、無密鑰的路由網址；URL 本身
// 不授權任何內容，舊頁會先轉到 members.html 並由支部 session 驗證。
import { getTrustedUnit } from './_registry.js';

const KINDS = new Set(['notice', 'calendar', 'constitution', 'member-entry', 'borrow']);
const ROUTE_KINDS_REQUIRING_ID = new Set(['notice', 'calendar']);
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

function normalizedOrigin(value, { local = false, requireLocal = false } = {}) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try {
    const url = new URL(raw);
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    if (requireLocal && !localHost) return '';
    if (url.protocol !== 'https:' && !(local && localHost && url.protocol === 'http:')) return '';
    return url.origin;
  } catch { return ''; }
}
function publicOrigin(req) {
  const configured = normalizedOrigin(process.env.PUBLIC_APP_ORIGIN);
  if (configured) return configured;
  const vercel = normalizedOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL);
  if (vercel) return vercel;
  /* Never trust an arbitrary production Host header for a QR-safe URL. Localhost
     remains available for the development server only. */
  return normalizedOrigin(`${req.headers?.['x-forwarded-proto'] || 'http'}://${req.headers?.host || ''}`, { local: true, requireLocal: true });
}

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
  if (ROUTE_KINDS_REQUIRING_ID.has(kind) && !ID_RE.test(id)) {
    return res.status(200).json({ ok:false, reason:'share_id_invalid' });
  }
  const base = publicOrigin(req);
  if (!base) return res.status(503).json({ ok:false, reason:'public_origin_not_configured' });
  const routes = {
    notice: `/notice/${encodeURIComponent(id)}`,
    calendar: `/cal/${encodeURIComponent(id)}`,
    constitution: '/constitution',
    'member-entry': '/home',
    borrow: '/home'
  };
  const params = new URLSearchParams({ u: unit.code });
  return res.status(200).json({ ok:true, kind, unit:unit.code,
    url:`${base}/members.html?${params.toString()}#${routes[kind]}`,
    qrSafe:true, authenticated:true });
}
