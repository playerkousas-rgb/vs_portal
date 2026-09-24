/* ============================================================
   public-profile.js — 公開資料（社交媒體、相簿、網站、其他連結）
   ------------------------------------------------------------
   ★ 2026-09-25 團長：
     「『成員連結』改名為『公開資料』，授權人員喺呢分頁可以編輯公開乜嘢俾邊個睇。
       規則：低權限嘅人只見到設定佢權限或者比佢權限低嘅人，
             比佢權限高嘅人則一定見到。」
     「加入我團的社交媒體帳戶、相簿、網站等等…或者你認為有幫助的連結」

   可見範圍（由最開放到最收緊）：
     其他團(1) → 團員(2) → 執委(3) → 領袖(4) → 團長(5)
   一條資料設成 N ＝ 「權限 N 或以上」先見到。
   即係：團員見到「其他團」同「團員」嘅嘢；領袖見到「其他團／團員／執委／領袖」嘅嘢。
   ────────────────────────────────────────────────────────────
   「其他團」而家係最外一層 —— 之後會有**旅系統**包圍住呢個團，
   到時其他分團嘅登記用戶就係呢一層。而家呢一層對「已登記團員」開放。
   ============================================================ */

import { load, commit } from './store.js';

export const VIS_LEVELS = [
  { id: 'other',  name: '其他團', rank: 1, icon: 'globe',    desc: '最外層 —— 已登記嘅其他分團用戶（日後旅系統）；而家對團員開放' },
  { id: 'member', name: '團員',   rank: 2, icon: 'users',    desc: '本團團員（掃團員入口入到嚟嘅人）' },
  { id: 'exco',   name: '執委',   rank: 3, icon: 'check',    desc: '執委同以上' },
  { id: 'leader', name: '領袖',   rank: 4, icon: 'flag',     desc: '領袖同以上' },
  { id: 'chief',  name: '團長',   rank: 5, icon: 'sparkle',  desc: '只有團長睇到' }
];
const rankOf = id => VIS_LEVELS.find(v => v.id === id)?.rank || 2;
export const visName = id => VIS_LEVELS.find(v => v.id === id)?.name || '團員';

/** 身份 → 可見 rank（super 等同團長，見到晒） */
export function viewerRank(role) {
  if (role === 'super' || role === 'chief') return 5;
  if (role === 'leader') return 4;
  if (role === 'exco') return 3;
  if (role === 'member') return 2;
  return 0;                                   // 未登記／冇身份 → 乜都唔見
}

/** 一條資料嘅可見 rank 係咪 ≤ 睇嘅人 */
export function visibleTo(vis, role) {
  return rankOf(vis) <= viewerRank(role);
}

/* ---------------- 資料 ---------------- */
const DEFAULTS = () => ({ socials: [], albums: [], site: { url: '', vis: 'member' }, about: { text: '', vis: 'member' }, links: [] });

export function publicProfile() {
  const db = load();
  if (!db.publicProfile) db.publicProfile = DEFAULTS();
  const p = db.publicProfile;
  p.socials = Array.isArray(p.socials) ? p.socials : [];
  p.albums = Array.isArray(p.albums) ? p.albums : [];
  p.links = Array.isArray(p.links) ? p.links : [];
  p.site = p.site || { url: '', vis: 'member' };
  p.about = p.about || { text: '', vis: 'member' };
  return p;
}
export function savePublicProfile(patch, label = '') {
  const db = load();
  db.publicProfile = { ...publicProfile(), ...patch };
  commit('public-profile');
  return { ok: true, label };
}

/* ---------------- 社交媒體 ---------------- */
export const SOCIAL_KINDS = [
  { id: 'instagram', name: 'Instagram', icon: 'camera',   ph: 'instagram.com/yourtroop' },
  { id: 'facebook',  name: 'Facebook',  icon: 'share',    ph: 'facebook.com/yourtroop' },
  { id: 'youtube',   name: 'YouTube',   icon: 'camera',   ph: 'youtube.com/@yourtroop' },
  { id: 'whatsapp',  name: 'WhatsApp 頻道', icon: 'whatsapp', ph: 'https://chat.whatsapp.com/…' },
  { id: 'telegram',  name: 'Telegram',  icon: 'send',     ph: 't.me/yourtroop' },
  { id: 'email',     name: '電郵',      icon: 'mail',     ph: 'mailto:troop@example.org' },
  { id: 'phone',     name: '電話',      icon: 'phone',    ph: 'tel:+85212345678' },
  { id: 'other',     name: '其他',      icon: 'external', ph: 'https://…' }
];
export const socialName = id => SOCIAL_KINDS.find(s => s.id === id)?.name || '連結';
export const socialIcon = id => SOCIAL_KINDS.find(s => s.id === id)?.icon || 'external';

/** 建議加入嘅常用連結（團長揀咗先至會加） */
export const SUGGESTED_LINKS = [
  { title: '香港童軍總會', url: 'https://www.scout.org.hk', desc: '總會通告、訓練、獎章制度' },
  { title: 'YMIS 會員系統', url: 'https://ymis.scout.org.hk', desc: '成員資料、活動報名' },
  { title: '童軍物品供應社', url: 'https://www.scoutshop.org.hk', desc: '制服、徽章、裝備' },
  { title: '國際童軍運動', url: 'https://www.scout.org', desc: '世界童軍組織' }
];

/* ---------------- 存取 ---------------- */
function list(kind) { return publicProfile()[kind] || []; }
export const socials = () => list('socials');
export const albums = () => list('albums');
export const otherLinks = () => list('links');

function upsert(kind, item) {
  const p = publicProfile();
  const arr = (p[kind] || []).slice();
  const i = arr.findIndex(x => x.id === item.id);
  if (i >= 0) arr[i] = { ...arr[i], ...item }; else arr.push({ id: `pp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...item });
  savePublicProfile({ [kind]: arr });
  return { ok: true };
}
function drop(kind, id) {
  const p = publicProfile();
  savePublicProfile({ [kind]: (p[kind] || []).filter(x => x.id !== id) });
  return { ok: true };
}
export const saveSocial = it => upsert('socials', it);
export const removeSocial = id => drop('socials', id);
export const saveAlbum = it => upsert('albums', it);
export const removeAlbum = id => drop('albums', id);
export const saveLink = it => upsert('links', it);
export const removeLink = id => drop('links', id);

/** 一鍵加入建議連結（已經有同一個網址就跳過） */
export function addSuggestedLinks(vis = 'member') {
  const p = publicProfile();
  const have = new Set([...p.links, ...p.socials].map(x => String(x.url || '').replace(/\/$/, '')));
  const arr = p.links.slice();
  let added = 0;
  SUGGESTED_LINKS.forEach(s => {
    const u = String(s.url).replace(/\/$/, '');
    if (have.has(u)) return;
    have.add(u);
    arr.push({ id: `pp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, title: s.title, url: s.url, desc: s.desc, vis });
    added++;
  });
  if (added) savePublicProfile({ links: arr });
  return { ok: true, added };
}
