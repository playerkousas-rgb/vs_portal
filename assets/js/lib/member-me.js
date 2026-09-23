/* 團員喺呢部瀏覽器記住嘅名（免登入） */
const KEY = 'v82.hub.me';

export function loadMe() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { id: '', name: '' };
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return { id: String(o.id || ''), name: String(o.name || '') };
    return { id: '', name: String(raw) };
  } catch { return { id: '', name: '' }; }
}

export function saveMe({ id = '', name = '' } = {}) {
  try { localStorage.setItem(KEY, JSON.stringify({ id: String(id || ''), name: String(name || '').trim() })); }
  catch { /* */ }
}

export function displayMe() {
  const m = loadMe();
  return m.name || '';
}

/** 交卷／回覆時：有名冊 id 用 id，否則用自由填名 */
export function identityForSubmit(roster = []) {
  const m = loadMe();
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
