/* ============================================================
   content-visibility.js — 已登入身份的內容可見範圍
   ------------------------------------------------------------
   呢個模組刻意冇匿名／「對外公開」層。`公開` 不再代表 Internet 或免登入；
   未來跨支部分享會走來源支部分享＋接收支部接收及本地身份授權的獨立契約。
   ============================================================ */

import { roleDef, roleLevel, rolesAscending } from './branch-config.js';

const ICON_BY_LEVEL = { 1: 'users', 2: 'check', 3: 'flag', 4: 'sparkle' };
export const VIS_LEVELS = Object.freeze(
  rolesAscending({ includeHidden: false }).map(role => Object.freeze({
    id: role.id,
    name: role.name,
    rank: role.level,
    icon: ICON_BY_LEVEL[role.level] || 'users',
    desc: `${role.name}同更高身份（必須先登入）`
  }))
);

const defaultRole = () => VIS_LEVELS[0]?.id || 'member';
export const visName = id => VIS_LEVELS.find(level => level.id === id)?.name || roleDef(defaultRole())?.name || '團員';

/** 舊匿名值 `other` 一律收窄到最低已登入身份，絕不延續匿名語義。 */
export function visOf(item, fallback = defaultRole()) {
  const value = String(item?.vis || '').trim();
  if (value === 'other') return fallback;
  return VIS_LEVELS.some(level => level.id === value) ? value : fallback;
}

export function viewerRank(role) { return roleLevel(role); }
export function visibleTo(vis, role) {
  const viewer = viewerRank(role);
  if (!viewer) return false;
  return roleLevel(visOf({ vis })) <= viewer;
}

export const CONTENT_DEFAULTS = Object.freeze({
  event: defaultRole(),
  notice: defaultRole(),
  quiz: defaultRole()
});

export function contentVis(record, kind) {
  const value = String(record?.vis || '').trim();
  if (value === 'other') return CONTENT_DEFAULTS[kind] || defaultRole();
  if (VIS_LEVELS.some(level => level.id === value)) return value;
  if (kind === 'event' && record?.visibility === 'exco') {
    return rolesAscending({ includeHidden: false }).find(role => role.level === 2)?.id || defaultRole();
  }
  return CONTENT_DEFAULTS[kind] || defaultRole();
}

/** 一條內容是否可由指定的已登入本支部身份閱讀。未知／未登入身份一律拒絕。 */
export function visibleContent(record, kind, role) {
  return visibleTo(contentVis(record, kind), role);
}
