/* ============================================================
   router.js — hash 路由（不含 view，避免循環依賴）
   ============================================================ */

export function go(hash) {
  const target = String(hash).startsWith('#') ? hash : '#' + hash;
  if (location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

export function parse(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const query = {};
  if (queryPart) {
    new URLSearchParams(queryPart).forEach((v, k) => { query[k] = v; });
  }
  const segs = pathPart.split('/').filter(Boolean);
  return {
    section: segs[0] || 'dashboard',
    id: segs[1] || null,
    action: segs[2] || null,
    query,
    full: raw
  };
}

/** 更新網址的 query 而不觸發整頁重繪 */
export function setQuery(patch, replace = true) {
  const h = parse();
  const q = new URLSearchParams();
  Object.entries({ ...h.query, ...patch }).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') q.set(k, v);
  });
  const qs = q.toString();
  const url = '#/' + [h.section, h.id, h.action].filter(Boolean).join('/') + (qs ? '?' + qs : '');
  if (replace) history.replaceState(null, '', url);
  else location.hash = url;
}
