/* 團員喺呢部瀏覽器記住嘅名（免登入）。
   Identity is unit-scoped: a browser may open links for several troops, and a
   remembered member ID/name from one troop must never prefill another troop. */
const KEY = 'v82.hub.me';

function unitKey(unit = '') {
  const value = String(unit || '').trim();
  const safe = /^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/.test(value) ? value : 'unselected';
  return `${KEY}.${safe}`;
}

export function loadMe(unit = '') {
  try {
    const raw = localStorage.getItem(unitKey(unit));
    if (!raw) return { id: '', name: '' };
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return { id: String(o.id || ''), name: String(o.name || '') };
    return { id: '', name: String(raw) };
  } catch { return { id: '', name: '' }; }
}

export function saveMe({ id = '', name = '' } = {}, unit = '') {
  try { localStorage.setItem(unitKey(unit), JSON.stringify({ id: String(id || ''), name: String(name || '').trim() })); }
  catch { /* */ }
}

export function displayMe(unit = '') {
  const m = loadMe(unit);
  return m.name || '';
}

/** 交卷／回覆時：有名冊 id 用 id，否則用自由填名 */
export function identityForSubmit(roster = [], unit = '') {
  const m = loadMe(unit);
  if (m.id && roster.some(x => x.id === m.id)) {
    const hit = roster.find(x => x.id === m.id);
    return { id: m.id, name: hit?.name || m.name };
  }
  if (m.name) {
    const hit = roster.find(x => x.name === m.name);
    return { id: hit?.id || ('guest:' + m.name), name: m.name };
  }
  return { id: '', name: '' };
}
