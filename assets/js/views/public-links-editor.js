/* ============================================================
   public-links-editor.js — 公開資料**填嘢嘅位**
   ------------------------------------------------------------
   ★ 2026-09-24 團長（重要定位修正）：
     「公開資料其實**唔係要填嘢嘅**，係方便了解有乜嘢而家正喺度公開。」

   所以呢個模組係**填嘢嘅位**，畀「帳號與系統 → 旅團設定」用；
   「公開資料」（#/links）嗰頁係**只讀一覽表**（見 links.js）。

   填嘅嘢全部存落 `db.publicProfile`（跟同步、跟備份走）：
     關於我團 / 旅團網站 / 社交媒體 / 相簿 / 其他連結
   每項都可以設「邊個睇到」：對外公開(1) < 團員(2) < 執委(3) < 領袖(4) < 團長(5)
   ============================================================ */

import { esc, icon, modal, toast, confirmDlg } from '../lib/util.js';
import { can } from '../lib/auth.js';
import { empty, visSelect, visBadge } from './ui.js';
import {
  VIS_LEVELS, SOCIAL_KINDS, socialName, socialIcon, SUGGESTED_LINKS,
  publicProfile, savePublicProfile,
  socials, albums, otherLinks,
  saveSocial, removeSocial, saveAlbum, removeAlbum, saveLink, removeLink, addSuggestedLinks
} from '../lib/public-profile.js';

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

/* ============================================================
   render
   ============================================================ */
export function renderPublicLinksEditor() {
  const p = publicProfile();
  const s = socials(), a = albums(), l = otherLinks();
  const dis = can('admin.units') ? '' : 'disabled';

  return `
  <div class="card mb-16">
    <div class="card-head"><div>
      <div class="card-title">旅團網站 · 關於我團</div>
      <div class="card-sub">會出現喺團員入口同對外專頁</div></div></div>
    <div style="padding:14px 16px" class="col gap-10">
      <div class="row gap-8 wrap">
        <input class="input grow" id="pp-site" value="${esc(p.site?.url || '')}" placeholder="https://…" style="min-width:220px">
        ${visSelect('site', p.site?.vis || 'member')}
        <button class="btn btn-sm btn-primary" data-act="save-site" ${dis}>${icon('save', 15)} 儲存網站</button>
      </div>
      <textarea class="input" id="pp-about" rows="3" placeholder="例：82 旅成立於 1978 年，每周五晚七時喺…">${esc(p.about?.text || '')}</textarea>
      <div class="row gap-8 wrap">
        ${visSelect('about', p.about?.vis || 'member')}
        <button class="btn btn-sm btn-primary" data-act="save-about" ${dis}>${icon('save', 15)} 儲存簡介</button>
      </div>
    </div>
  </div>

  <div class="card mb-16">
    <div class="card-head"><div>
      <div class="card-title">社交媒體</div>
      <div class="card-sub">Instagram、Facebook、YouTube、WhatsApp 頻道、Telegram、電郵…</div></div>
      <button class="btn btn-sm btn-primary" data-act="add-social" ${dis}>${icon('plus', 15)} 新增</button></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${s.length ? s.map(x => rowOf('social', socialIcon(x.kind))(x)).join('') : empty('share', '未有社交媒體帳戶', '撳右上「新增」加入你團嘅 Instagram / Facebook / YouTube')}
    </div>
  </div>

  <div class="card mb-16">
    <div class="card-head"><div>
      <div class="card-title">相簿</div>
      <div class="card-sub">Google Photos、活動相簿 —— 設「對外公開」就可以畀外人睇宣傳相</div></div>
      <button class="btn btn-sm btn-primary" data-act="add-album" ${dis}>${icon('plus', 15)} 新增相簿</button></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${a.length ? a.map(rowOf('album', 'image')).join('') : empty('image', '未有相簿', '撳右上「新增相簿」，貼 Google Photos 網址')}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div>
      <div class="card-title">其他有用連結</div>
      <div class="card-sub">總會、YMIS、物品供應社…或者任何你覺得團員用得到嘅</div></div>
      <div class="row gap-6">
        <button class="btn btn-sm" data-act="add-suggested" ${dis} title="一次過加入 ${SUGGESTED_LINKS.length} 條常用連結">${icon('plus', 15)} 加入常用連結</button>
        <button class="btn btn-sm btn-primary" data-act="add-link" ${dis}>${icon('plus', 15)} 新增</button></div></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${l.length ? l.map(rowOf('link', 'link')).join('') : empty('link', '未有其他連結', '撳「加入常用連結」一次過加入總會／YMIS／物品供應社')}
    </div>
  </div>

  <div class="hint mt-12">${icon('globe', 13)} 可見範圍：${VIS_LEVELS.map(v => `<b>${esc(v.name)}</b>(${v.rank})`).join(' &lt; ')} —— 設成 N ＝ <b>N 同更高權限</b>先見到。「對外公開」＝ 免登入都睇到。</div>
  <div class="hint mt-8">改完只係暫存喺呢部機 —— 要撳右上角「儲存到後端」先至會寫入旅團 Google Sheet。睇「而家公開緊啲乜」去側邊欄<b>公開資料</b>。</div>`;
}

/** 一項（社交／相簿／連結共用同一款卡）。
 *  `k` ＝ 呢項屬於邊個 list，用嚟俾掣知道要 edit／del 邊條。 */
function rowOf(k, ic) {
  return (x) => `<div class="link-card">
    <span class="ic">${icon(ic, 18)}</span>
    <div class="grow" style="min-width:0">
      <div class="semibold sm">${esc(x.title || socialName(x.kind))} ${visBadge(x.vis)}</div>
      <div class="xs muted mt-4">${esc(x.desc || '')}</div>
      <div class="u mt-6">${esc(x.url)}</div>
    </div>
    <div class="row gap-6 wrap no-print" style="justify-content:flex-end">
      <button class="btn btn-xs" data-open="${esc(x.url)}">${icon('external', 13)}</button>
      <button class="btn btn-xs" data-edit="${k}:${esc(x.id)}">${icon('edit', 13)}</button>
      <button class="btn btn-xs btn-ghost" data-del="${k}:${esc(x.id)}">${icon('trash', 13)}</button>
    </div>
  </div>`;
}

/* ============================================================
   mount
   ============================================================ */
export function mountPublicLinksEditor(root) {
  const findIn = (k, id) => (k === 'social' ? socials() : k === 'album' ? albums() : otherLinks()).find(x => x.id === id);
  const save = { social: saveSocial, album: saveAlbum, link: saveLink };
  const drop = { social: removeSocial, album: removeAlbum, link: removeLink };
  const label = { social: '社交媒體帳戶', album: '相簿', link: '連結' };

  root.querySelector('[data-act="add-social"]')?.addEventListener('click', () => editDialog('social', null));
  root.querySelector('[data-act="add-album"]')?.addEventListener('click', () => editDialog('album', null));
  root.querySelector('[data-act="add-link"]')?.addEventListener('click', () => editDialog('link', null));

  root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const [k, id] = String(b.dataset.edit).split(':');
    editDialog(k, findIn(k, id));
  }));
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const [k, id] = String(b.dataset.del).split(':');
    if (!(await confirmDlg({ title: `刪除${label[k]}`, okText: '確定刪除', danger: true, message: `確定刪除呢個${label[k]}？` }))) return;
    drop[k](id); toast('已刪除', 'ok'); refresh();
  }));
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    window.open(b.dataset.open, '_blank', 'noopener');
  }));

  root.querySelector('[data-act="add-suggested"]')?.addEventListener('click', () => {
    const r = addSuggestedLinks('member');
    toast(r.added ? `已加入 ${r.added} 條常用連結` : '常用連結已經全部加咗', r.added ? 'ok' : 'info');
    refresh();
  });
  root.querySelector('[data-act="save-site"]')?.addEventListener('click', () => {
    const url = root.querySelector('#pp-site')?.value.trim() || '';
    const vis = root.querySelector('[data-vis="site"]')?.value || 'member';
    savePublicProfile({ site: { ...(publicProfile().site || {}), url, vis } });
    toast('已儲存旅團網站', 'ok'); refresh();
  });
  root.querySelector('[data-act="save-about"]')?.addEventListener('click', () => {
    const text = root.querySelector('#pp-about')?.value.trim() || '';
    const vis = root.querySelector('[data-vis="about"]')?.value || 'member';
    savePublicProfile({ about: { ...(publicProfile().about || {}), text, vis } });
    toast('已儲存旅團簡介', 'ok'); refresh();
  });
}

/* ============================================================
   新增／編輯對話框（社交／相簿／連結共用）
   ============================================================ */
async function editDialog(kind, item) {
  const meta = {
    social: { title: '社交媒體帳戶', fields: true },
    album: { title: '相簿' },
    link: { title: '連結' }
  }[kind];
  const it = item || {};
  const r = await modal({
    title: (item ? '編輯' : '新增') + meta.title, wide: true,
    body: `
      <div class="grid g-2" style="gap:12px">
        ${kind === 'social' ? `<div class="field" style="grid-column:1/-1"><label class="label">平台</label>
          <select class="input" id="pp-kind">${SOCIAL_KINDS
        .map(k => `<option value="${k.id}"${k.id === (it.kind || 'instagram') ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label class="label">名稱</label>
          <input class="input" id="pp-title" value="${esc(it.title || it.label || '')}" placeholder="${kind === 'social' ? '例：82 旅 Instagram' : '例：2026 夏季營相簿'}"></div>
        <div class="field"><label class="label">網址</label>
          <input class="input" id="pp-url" value="${esc(it.url || '')}" placeholder="https://…"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">說明（可留空）</label>
          <input class="input" id="pp-desc" value="${esc(it.desc || '')}" placeholder="一句話講呢個係乜"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">邊個睇到？</label>
          ${visSelect('dlg', it.vis || 'member', 'id="pp-vis"')}
          <div class="hint mt-4">${VIS_LEVELS.map(v => `${esc(v.name)}(${v.rank})`).join(' < ')} —— 設成某一級，<b>該級同更高權限</b>先見到。「對外公開」＝ 免登入都睇到。</div></div>
      </div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
    {
      label: '儲存', class: 'btn-primary', onClick: el => ({
        kind: el.querySelector('#pp-kind')?.value || it.kind || 'other',
        title: el.querySelector('#pp-title').value.trim(),
        label: el.querySelector('#pp-title').value.trim(),
        url: el.querySelector('#pp-url').value.trim(),
        desc: el.querySelector('#pp-desc').value.trim(),
        vis: el.querySelector('#pp-vis').value,
        ...(it.id ? { id: it.id } : {})
      })
    }]
  });
  if (!r) return;
  if (!r.title || !r.url) { toast('名稱同網址都要填', 'err'); return; }
  const fn = kind === 'social' ? saveSocial : kind === 'album' ? saveAlbum : saveLink;
  fn(r);
  toast('已儲存（暫存喺呢部機 —— 撳頂部「儲存到後端」先至會寫入）', 'ok');
  refresh();
}
