/* ============================================================
   public-profile.js — 公開資料（社交媒體、相簿、網站、其他連結）
   ------------------------------------------------------------
   ★ 2026-09-24 團長：
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
  { id: 'other',  name: '對外公開', rank: 1, icon: 'globe',   desc: '最外層 —— **免登入**都睇到（登入頁「公開資料」／對外專頁）。日後旅系統包住呢個團，就變成「其他分團嘅登記用戶」先睇到' },
  { id: 'member', name: '團員',     rank: 2, icon: 'users',   desc: '本團團員（掃團員入口 YMIS＋密碼入到嚟嘅人）同以上' },
  { id: 'exco',   name: '執委',     rank: 3, icon: 'check',   desc: '執委同以上' },
  { id: 'leader', name: '領袖',     rank: 4, icon: 'flag',    desc: '領袖同以上' },
  { id: 'chief',  name: '團長',     rank: 5, icon: 'sparkle', desc: '只有團長睇到' }
];
const rankOf = id => VIS_LEVELS.find(v => v.id === id)?.rank || 2;
export const visName = id => VIS_LEVELS.find(v => v.id === id)?.name || '團員';
/** 一項資料嘅可見範圍（冇設／設錯就當團員級） */
export function visOf(it, fallback = 'member') {
  const v = String(it?.vis || '').trim();
  return VIS_LEVELS.some(x => x.id === v) ? v : fallback;
}

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

/* ============================================================
   APP 內內容（行事曆／通告／試卷）嘅可見範圍
   ------------------------------------------------------------
   ★ 團長 2026-09-24：「公開資料我係指行事曆、通告、試卷呢類有機會想
     告知非團員嘅內容（嗰種 APP 內可以分享出去嗰種）」。
   ★ 但「邊個睇到」要設喺**各自嘅編輯器**（團長揀咗 in_editor）——
     公開資料嗰頁淨係顯示總覽，唔喺嗰度改。
   預設一定要同而家嘅行為一致，唔可以一改就唔見咗嘢。
   ============================================================ */
export const CONTENT_DEFAULTS = {
  event: 'member',   // 行事曆：本來淨係團員入口見到
  notice: 'other',   // 通告：本來 published 就係免登入公開（notice.html）
  quiz: 'member'     // 試卷：本來淨係團員入口見到
};
/** 一項 APP 內內容嘅可見範圍（冇設就用預設；行事曆嘅舊 exco 標記都認） */
export function contentVis(rec, kind) {
  const v = String(rec?.vis || '').trim();
  if (VIS_LEVELS.some(x => x.id === v)) return v;
  if (kind === 'event') return rec?.visibility === 'exco' ? 'exco' : CONTENT_DEFAULTS.event;
  return CONTENT_DEFAULTS[kind] || 'member';
}

/* ============================================================
   公開資料一覽表
   ------------------------------------------------------------
   ★ 團長 2026-09-24（重要定位）：
     「公開資料其實**唔係要填嘢嘅**，係方便了解有乜嘢而家正喺度公開。」

   所以呢度**只讀**：把所有「公開緊」嘅嘢（連結 ＋ APP 內內容）聚合埋一齊，
   每項標明「邊個睇到」，再俾個「去改」掣跳去真正填嘢嗰個位
   （旅團設定／行事曆／通告／試卷）。
   ============================================================ */
export function publicOverview() {
  const db = load() || {};
  const p = publicProfile();
  const u = (x) => String(x?.url || '').trim();
  const groups = [];
  const add = (kind, title, icon, editHash, items) => {
    const list = items.filter(Boolean);
    if (list.length) groups.push({ kind, title, icon, editHash, items: list });
  };
  const item = (id, title, desc, url, vis) => ({ id, title, desc, url, vis });

  const aboutTx = String(p.about?.text || '').trim();
  add('about', '關於我團', 'note', '#/admin/settings',
    aboutTx ? [item('about', '旅團簡介', aboutTx, '', visOf(p.about))] : []);

  add('site', '旅團網站', 'globe', '#/admin/settings',
    u(p.site) ? [item('site', p.site.title || '旅團網站', p.site.desc || '', u(p.site), visOf(p.site))] : []);

  add('social', '社交媒體', 'share', '#/admin/settings',
    (p.socials || []).filter(x => u(x)).map(x =>
      item(x.id, x.title || socialName(x.kind), x.desc || socialName(x.kind), u(x), visOf(x))));

  add('album', '相簿', 'image', '#/admin/settings',
    (p.albums || []).filter(x => u(x)).map(x =>
      item(x.id, x.title || '相簿', x.desc || '', u(x), visOf(x))));

  add('link', '其他連結', 'link', '#/admin/settings',
    (p.links || []).filter(x => u(x)).map(x =>
      item(x.id, x.title || '連結', x.desc || '', u(x), visOf(x))));

  /* ---- APP 內內容（團員入口／公開頁分享得出去嘅嘢）---- */
  add('event', '行事曆', 'calendar', '#/calendar',
    (db.events || []).filter(e => e && e.status !== 'cancelled').map(e =>
      item(e.id, e.title || '活動',
        [e.date, e.dateEnd && e.dateEnd !== e.date ? '至 ' + e.dateEnd : '', e.venue].filter(Boolean).join(' · '),
        '', contentVis(e, 'event'))));

  add('notice', '通告', 'megaphone', '#/notices',
    (db.notices || []).filter(n => n && n.status === 'published').map(n =>
      item(n.id, n.title?.zh || n.title || '通告', n.eventDate || '', '', contentVis(n, 'notice'))));

  add('quiz', '試卷', 'note', '#/quizzes',
    (db.quizzes || []).filter(q => q && q.status !== 'closed').map(q =>
      item(q.id, q.title || '試卷', `${(q.questions || []).length} 題`, '', contentVis(q, 'quiz'))));

  return groups;
}

/** 一覽表統計：每個可見層級有幾多項公開緊 */
export function overviewCounts(groups = publicOverview()) {
  const out = { total: 0, byLevel: {}, public: 0 };
  VIS_LEVELS.forEach(v => { out.byLevel[v.id] = 0; });
  groups.forEach(g => g.items.forEach(it => {
    out.total++;
    out.byLevel[it.vis] = (out.byLevel[it.vis] || 0) + 1;
    if (it.vis === 'other') out.public++;
  }));
  return out;
}

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

/* ============================================================
   對外專頁（免登入）
   ------------------------------------------------------------
   ★ 團長 2026-09-24：「各團嘅公開資料，應該係喺<b>登入帳戶嗰個版面</b>睇到；
     未來就係登入咗旅系統之後，喺選擇支部進入前應該會睇到。」

   所以呢度整一份「對外專頁」HTML —— **免登入**都睇得，淨係 show
   可見範圍 ＝ 「對外公開」（rank 1）嘅嘢。兩個入口都用同一份：
     ① 後台「公開資料」頁嘅「預覽對外專頁」掣
     ② 登入頁／旅團閘嘅「公開資料」掣
   ============================================================ */
import { esc, icon } from './util.js';

/** 淨係攞「對外公開」嗰啲（免登入睇到） */
export function publicGroupsFor(level = 'other') {
  return publicOverview()
    .map(g => ({ ...g, items: g.items.filter(it => rankOf(it.vis) <= rankOf(level)) }))
    .filter(g => g.items.length);
}

/** 對外專頁 HTML（免登入；`rank` 可以俾將來「已登入旅系統」嗰陣放寬） */
export function publicPageHtml({ unitName = '', rank = 'other' } = {}) {
  const groups = publicGroupsFor(rank);
  if (!groups.length) {
    return `<div class="center" style="padding:36px 20px">
      <div style="opacity:.5">${icon('globe', 40)}</div>
      <div class="semibold mt-12">${esc(unitName || '呢個旅團')}仲未公開任何資料</div>
      <div class="xs muted mt-6">執委／團長可以去「公開資料」設定公開乜嘢。</div>
    </div>`;
  }
  return groups.map(g => `
    <div class="card mb-16">
      <div class="card-head"><div><div class="card-title">${icon(g.icon, 16)} ${esc(g.title)}</div></div></div>
      <div>
        ${g.items.map(it => `<div class="list-item">
          <span class="stat-ic">${icon(g.icon, 15)}</span>
          <div class="li-main">
            <div class="li-t">${esc(it.title)}</div>
            ${it.desc ? `<div class="li-s xs faint">${esc(it.desc)}</div>` : ''}
            ${it.url ? `<div class="li-s xs"><a href="${esc(/^(https?:|mailto:|tel:)/i.test(it.url) ? it.url : 'https://' + it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.url)}</a></div>` : ''}
          </div>
        </div>`).join('')}
      </div>
    </div>`).join('');
}
