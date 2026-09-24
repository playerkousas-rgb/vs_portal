/* ============================================================
   links.js — 公開資料
   ------------------------------------------------------------
   ★ 2026-09-25 團長：「『成員連結』改名為『公開資料』，授權人員喺呢分頁
      可以編輯公開乜嘢俾邊個睇」「加入我團的社交媒體帳戶、相簿、網站等等」。
   四類內容：
     ① 團員入口 + 系統連結（原有）
     ② 社交媒體帳戶
     ③ 相簿
     ④ 網站與其他有用連結
   每一項都可以設「邊個睇到」：其他團 → 團員 → 執委 → 領袖 → 團長。
   規則：設成 N ＝ 權限 N 或以上先見到（見 lib/public-profile.js）。
   ============================================================ */

import { load, commit } from '../lib/store.js';
import { esc, icon, modal, toast, copyText, qrSvg, confirmDlg } from '../lib/util.js';
import { toWord, printDoc, downloadQrSvg, stamp } from '../lib/exporter.js';
import { profile, settings, memberLinks, publicPageUrl, findLegacyPublicUrls, migrateLegacyPublicUrls, isLegacyUrl, publicLinkRoute } from '../lib/model.js';
import { pageHead, tabs, empty, noteBox } from './ui.js';
import { can, currentRole } from '../lib/auth.js';
import {
  VIS_LEVELS, visName, viewerRank, visibleTo,
  publicProfile, savePublicProfile,
  SOCIAL_KINDS, socialName, socialIcon, SUGGESTED_LINKS,
  socials, albums, otherLinks,
  saveSocial, removeSocial, saveAlbum, removeAlbum, saveLink, removeLink, addSuggestedLinks
} from '../lib/public-profile.js';

let tab = 'hub';

export function title() { return '公開資料'; }

export function render(params = {}) {
  /* 冇帶分頁（純 #/links）＝返「團員入口」呢個主頁。
     唔可以「留返上次嗰個分頁」—— tab 係模組級變數，去過 #/links/link 之後
     再撳側邊欄「公開資料」就會跌入連結頁，用家會以為成頁壞咗。 */
  if (['hub', 'social', 'album', 'link'].includes(params.id)) tab = params.id;
  else if (!params.id) tab = 'hub';
  return `
  ${pageHead({
    title: '公開資料',
    sub: '公開乜嘢俾邊個睇 —— 團員入口、社交媒體、相簿、網站',
    actions: `<button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 公開頁網址</button>`
  })}
  ${tabs([
    ['hub', '團員入口'],
    ['social', '社交媒體', socials().length],
    ['album', '相簿', albums().length],
    ['link', '網站與連結', otherLinks().length]
  ], tab)}
  ${tab === 'social' ? socialView()
    : tab === 'album' ? albumView()
    : tab === 'link' ? linkView()
    : hubView()}`;
}

/* ============================================================
   可見範圍選擇器
   ============================================================ */
function visSelect(name, cur, extra = '') {
  return `<select class="input input-sm" data-vis="${name}" ${extra} style="min-width:120px">
    ${VIS_LEVELS.map(v => `<option value="${v.id}"${v.id === (cur || 'member') ? ' selected' : ''}>${icon(v.icon, 12)} ${v.name}以上</option>`).join('')}
  </select>`;
}
function visBadge(vis) {
  const v = VIS_LEVELS.find(x => x.id === (vis || 'member')) || VIS_LEVELS[1];
  const mine = viewerRank(currentRole());
  const blind = v.rank > mine;
  return `<span class="badge ${blind ? 'b-danger' : 'b-info'}" title="${esc(v.desc)}">${icon(v.icon, 12)} ${v.name}以上${blind ? '（你睇唔到）' : ''}</span>`;
}
/** 編輯一項公開資料（社交／相簿／連結共用） */
async function editDialog(kind, item) {
  const kinds = {
    social: { title: '社交媒體帳戶', fields: true },
    album: { title: '相簿' },
    link: { title: '連結' }
  }[kind];
  const it = item || {};
  const r = await modal({
    title: (item ? '編輯' : '新增') + kinds.title, wide: true,
    body: `
      <div class="grid g-2" style="gap:12px">
        ${kind === 'social' ? `<div class="field" style="grid-column:1/-1"><label class="label">平台</label>
          <select class="input" id="pp-kind">${SOCIAL_KINDS.map(k => `<option value="${k.id}"${k.id === (it.kind || 'instagram') ? ' selected' : ''}>${k.name}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label class="label">名稱</label>
          <input class="input" id="pp-title" value="${esc(it.title || it.label || '')}" placeholder="${kind === 'social' ? '例：82 旅 Instagram' : '例：2026 夏季營相簿'}"></div>
        <div class="field"><label class="label">網址</label>
          <input class="input" id="pp-url" value="${esc(it.url || '')}" placeholder="https://…"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">說明（可留空）</label>
          <input class="input" id="pp-desc" value="${esc(it.desc || '')}" placeholder="一句話講呢個係乜"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">邊個睇到？</label>
          ${visSelect('dlg', it.vis || 'member', 'id="pp-vis"')}
          <div class="hint mt-4">${VIS_LEVELS.map(v => `${v.name}(${v.rank})`).join(' < ')} —— 設成某一級，<b>該級同更高權限</b>先見到。</div></div>
      </div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        kind: el.querySelector('#pp-kind')?.value || it.kind || 'other',
        title: el.querySelector('#pp-title').value.trim(),
        label: el.querySelector('#pp-title').value.trim(),
        url: el.querySelector('#pp-url').value.trim(),
        desc: el.querySelector('#pp-desc').value.trim(),
        vis: el.querySelector('#pp-vis').value,
        ...(it.id ? { id: it.id } : {})
      }) }]
  });
  if (!r) return;
  if (!r.title || !r.url) { toast('名稱同網址都要填', 'err'); return; }
  const fn = kind === 'social' ? saveSocial : kind === 'album' ? saveAlbum : saveLink;
  fn(r);
  toast('已儲存（暫存喺呢部機 —— 撳頂部「儲存到後端」先至會寫入）', 'ok');
  refresh();
}

/* ============================================================
   ② 社交媒體
   ============================================================ */
function socialView() {
  const list = socials();
  const mine = viewerRank(currentRole());
  return `
  ${noteBox(`<b>公開乜嘢俾邊個睇。</b>
    每一項都可以設可見範圍：${VIS_LEVELS.map(v => `<b>${v.name}</b>(${v.rank})`).join(' &lt; ')}。
    <div class="xs mt-4">規則：設成某一級 ＝ <b>該級同更高權限</b>先見到。例如設「執委」，團員就睇唔到，領袖／團長就見到。</div>
    <div class="xs mt-4">「其他團」係最外一層 —— 之後有<b>旅系統</b>包圍住呢個團時，其他分團嘅登記用戶就係呢一層。</div>`, 'brand')}
  <div class="card">
    <div class="card-head"><div><div class="card-title">社交媒體帳戶</div>
      <div class="card-sub">Instagram、Facebook、YouTube、WhatsApp 頻道…</div></div>
      <button class="btn btn-sm btn-primary" data-act="add-social">${icon('plus', 15)} 新增</button></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${list.length ? list.map(x => `<div class="link-card">
        <span class="ic">${icon(socialIcon(x.kind), 18)}</span>
        <div class="grow" style="min-width:0">
          <div class="semibold sm">${esc(x.title || socialName(x.kind))} ${visBadge(x.vis)}</div>
          <div class="xs muted mt-4">${esc(x.desc || socialName(x.kind))}</div>
          <div class="u mt-6">${esc(x.url)}</div>
        </div>
        <div class="row gap-6 wrap no-print" style="justify-content:flex-end">
          <button class="btn btn-xs" data-copy="${esc(x.url)}">${icon('copy', 13)} 複製</button>
          <button class="btn btn-xs" data-qr="${esc(x.url)}" data-qrt="${esc(x.title || socialName(x.kind))}">${icon('qr', 13)} QR</button>
          <button class="btn btn-xs" data-open="${esc(x.url)}">${icon('external', 13)}</button>
          <button class="btn btn-xs" data-edit-social="${esc(x.id)}">${icon('edit', 13)}</button>
          <button class="btn btn-xs btn-ghost" data-del-social="${esc(x.id)}">${icon('trash', 13)}</button>
        </div>
      </div>`).join('') : empty('share', '未有社交媒體帳戶', '撳右上「新增」加入你團嘅 Instagram / Facebook / YouTube 等等')}
    </div>
  </div>
  <div class="xs faint mt-8">你而家嘅身份可見到 rank ${mine} 或以下嘅項目。</div>`;
}

/* ============================================================
   ③ 相簿
   ============================================================ */
function albumView() {
  const list = albums();
  return `
  ${noteBox(`<b>活動相簿。</b>Google Photos、相簿網址、或者任何可以睇相嘅連結。
    <div class="xs mt-4">每本相簿可以設「邊個睇到」—— 例如內部活動相片設「團員」，公開宣傳相設「其他團」。</div>`, 'brand')}
  <div class="card">
    <div class="card-head"><div><div class="card-title">相簿</div>
      <div class="card-sub">活動相片、營火晚會、旅行…</div></div>
      <button class="btn btn-sm btn-primary" data-act="add-album">${icon('plus', 15)} 新增相簿</button></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${list.length ? list.map(x => `<div class="link-card">
        <span class="ic">${icon('image', 18)}</span>
        <div class="grow" style="min-width:0">
          <div class="semibold sm">${esc(x.title)} ${visBadge(x.vis)}</div>
          <div class="xs muted mt-4">${esc(x.desc || '')}</div>
          <div class="u mt-6">${esc(x.url)}</div>
        </div>
        <div class="row gap-6 wrap no-print" style="justify-content:flex-end">
          <button class="btn btn-xs" data-copy="${esc(x.url)}">${icon('copy', 13)} 複製</button>
          <button class="btn btn-xs" data-qr="${esc(x.url)}" data-qrt="${esc(x.title)}">${icon('qr', 13)} QR</button>
          <button class="btn btn-xs" data-open="${esc(x.url)}">${icon('external', 13)}</button>
          <button class="btn btn-xs" data-edit-album="${esc(x.id)}">${icon('edit', 13)}</button>
          <button class="btn btn-xs btn-ghost" data-del-album="${esc(x.id)}">${icon('trash', 13)}</button>
        </div>
      </div>`).join('') : empty('image', '未有相簿', '撳右上「新增相簿」，貼 Google Photos / 相簿網址')}
    </div>
  </div>`;
}

/* ============================================================
   ④ 網站與其他連結
   ============================================================ */
function linkView() {
  const p = publicProfile();
  const list = otherLinks();
  return `
  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">旅團網站</div>
      <div class="card-sub">你團自己嘅網頁（學校網頁空間 / 自訂網域）</div></div></div>
    <div style="padding:14px 16px" class="row gap-8 wrap" >
      <input class="input grow" id="pp-site" value="${esc(p.site?.url || '')}" placeholder="https://…" style="min-width:240px">
      ${visSelect('site', p.site?.vis || 'member')}
      <button class="btn btn-sm btn-primary" data-act="save-site">${icon('save', 15)} 儲存</button>
    </div>
  </div>
  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">旅團簡介（公開）</div>
      <div class="card-sub">一段文字，會出現喺團員入口</div></div></div>
    <div style="padding:14px 16px" class="col gap-8">
      <textarea class="input" id="pp-about" rows="3" placeholder="例：82 旅成立於 1978 年，每周五晚七時喺…">${esc(p.about?.text || '')}</textarea>
      <div class="row gap-8 wrap">${visSelect('about', p.about?.vis || 'member')}
        <button class="btn btn-sm btn-primary" data-act="save-about">${icon('save', 15)} 儲存簡介</button></div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div><div class="card-title">其他有用連結</div>
      <div class="card-sub">總會、YMIS、物品供應社…或者任何你覺得團員用得到嘅</div></div>
      <div class="row gap-6">
        <button class="btn btn-sm" data-act="add-suggested" title="一次過加入 ${SUGGESTED_LINKS.length} 條常用連結">${icon('plus', 15)} 加入常用連結</button>
        <button class="btn btn-sm btn-primary" data-act="add-link">${icon('plus', 15)} 新增</button></div></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${list.length ? list.map(x => `<div class="link-card">
        <span class="ic">${icon('link', 18)}</span>
        <div class="grow" style="min-width:0">
          <div class="semibold sm">${esc(x.title)} ${visBadge(x.vis)}</div>
          <div class="xs muted mt-4">${esc(x.desc || '')}</div>
          <div class="u mt-6">${esc(x.url)}</div>
        </div>
        <div class="row gap-6 wrap no-print" style="justify-content:flex-end">
          <button class="btn btn-xs" data-copy="${esc(x.url)}">${icon('copy', 13)} 複製</button>
          <button class="btn btn-xs" data-qr="${esc(x.url)}" data-qrt="${esc(x.title)}">${icon('qr', 13)} QR</button>
          <button class="btn btn-xs" data-open="${esc(x.url)}">${icon('external', 13)}</button>
          <button class="btn btn-xs" data-edit-link="${esc(x.id)}">${icon('edit', 13)}</button>
          <button class="btn btn-xs btn-ghost" data-del-link="${esc(x.id)}">${icon('trash', 13)}</button>
        </div>
      </div>`).join('') : empty('link', '未有其他連結', '撳「加入常用連結」一次過加入總會／YMIS／物品供應社')}
    </div>
  </div>`;
}

/* ============================================================
   ① 團員入口（原有內容）
   ============================================================ */
function hubView() {
  const list = memberLinks();
  const hub = list.find(l => l.id === 'hub');
  const core = list.filter(l => l.id !== 'hub' && !l.id.startsWith('notice:'));
  const noticesList = list.filter(l => l.id.startsWith('notice:'));
  const backend = load().backend;
  const s = settings().publicLinks || {};

  return `
  <div class="row gap-8 wrap mb-16 no-print">
    <button class="btn btn-sm" data-act="print-hub">${icon('print', 15)} 列印團員 QR</button>
    <button class="btn btn-sm" data-act="copy-hub">${icon('copy', 15)} 複製團員入口</button>
  </div>

  ${noteBox(`<b>掃一次就齊。</b>WhatsApp／海報只派<b>團員入口</b>（members.html）。
    入去之後影單據、借物資、睇團章、通告、行事曆回覆、試卷全部喺同一頁。
    團員可以登記自己叫咩名（瀏覽器記住），唔填都得，入去先打。${backend
      ? '<br><span class="xs">已連接總表：成員一送出就會寫入你嘅 Google Sheet（待批核）。</span>'
      : ''}`, 'brand')}

  ${(() => {
    /* 公開連結到底行唔行得通，領袖要**即刻睇到** ——
       以前呢頁乜都冇講，派咗出去先至發現團員開唔到（2026-09-19）。 */
    const r = publicLinkRoute();
    const tone = r.ok ? 'info' : 'warn';
    return noteBox(
      `<b>呢啲連結行邊條路：${esc(r.label)}</b><div class="xs mt-4">${esc(r.detail)}</div>`
      + (r.ok ? '' : '<div class="xs mt-4">修好之後<b>重新複製／列印一次</b>下面嘅連結同 QR（舊嘅冇帶後端網址）。</div>'),
      tone);
  })()}

  ${hub ? `<div class="card mb-16">
    <div class="card-head"><div><div class="card-title">團員入口 QR（請只派呢一張）</div>
      <div class="card-sub">${esc(hub.url)}</div></div></div>
    <div class="center" style="padding:18px">
      <div class="qr-box" style="width:220px;margin:0 auto">${qrSvg(hub.url, 6, 2)}</div>
      <div class="row gap-8 wrap center mt-12" style="justify-content:center">
        <button class="btn btn-sm" data-copy="${esc(hub.url)}">${icon('copy', 14)} 複製</button>
        <button class="btn btn-sm btn-primary" data-act="print-poster">${icon('print', 14)} 列印海報</button>
        <button class="btn btn-sm" data-open="${esc(hub.url)}">${icon('external', 14)} 預覽</button>
      </div>
    </div>
  </div>` : ''}
  <div class="mb-16"></div>

  ${legacyBanner()}

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">已包喺團員入口入面</div>
      <div class="card-sub">唔使再分開派 QR —— 下面只係方便核對</div></div></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${core.map(linkCard).join('')}
    </div>
  </div>

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">通告報名連結</div>
      <div class="card-sub">亦會出現喺團員入口；獨立連結只係備用</div></div>
      <button class="btn btn-sm" data-go="#/notices/new">${icon('plus', 14)} 開新通告</button></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${noticesList.length ? noticesList.map(linkCard).join('')
        : empty('megaphone', '未有已發布嘅通告', '去「通告」頁開一張，發布之後呢度就會出現連結')}
    </div>
  </div>

  <div class="grid g-2">
    <div class="card">
      <div class="card-head"><div class="card-title">點樣派畀團員？</div></div>
      <div style="padding:16px 18px" class="sm muted">
        <ol style="padding-left:18px;line-height:1.95;margin:0">
          <li><b>WhatsApp / Signal 群</b>：撳「複製連結」貼入群，或者撳「複製 QR＋文字」連圖一齊發</li>
          <li><b>旅部當眼處</b>：撳「列印海報」，A4 印出嚟貼低，團員掃 QR 即用</li>
          <li><b>通告紙本</b>：通告頁撳「輸出」→「QR 海報」，連通告內容一齊印</li>
          <li><b>家長</b>：通告連結免登入，家長可以直接代填回覆出席與否</li>
        </ol>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">收到之後去邊睇？</div></div>
      <div style="padding:14px 16px" class="col gap-8">
        <button class="btn btn-sm btn-block btn-soft" data-go="#/finance/claims">${icon('note', 15)} 收支申報（批核）</button>
        <button class="btn btn-sm btn-block btn-soft" data-go="#/inventory/loans">${icon('grid', 15)} 物資借用（批核）</button>
        <button class="btn btn-sm btn-block btn-soft" data-go="#/notices/signups">${icon('megaphone', 15)} 通告報名 / 出席回覆</button>
        <div class="hint mt-4">批核之後：申報自動入帳、借用自動扣庫存。</div>
      </div>
    </div>
  </div>`;
}

/* 舊站遷移橫額：資料庫入面仲有公開網址指去 82venture 就彈出嚟，
   等領袖／執委一鍵搬返去而家呢個站（唔搬嘅話嗰啲 QR／連結退役之後會死）。 */
function legacyBanner() {
  const bad = findLegacyPublicUrls();
  if (!bad.length) return '';
  let host = '';
  try { host = location.host || ''; } catch { host = ''; }
  return `<div class="mb-16">${noteBox(`<b>⚠ 有 ${bad.length} 個公開網址仲指去舊系統（82venture.vercel.app）。</b>
    舊站退役之後，呢啲連結／QR 會死晒，團員掃唔到嘢。<br>
    <span class="xs mono">${bad.map(b => esc(b.label + '：' + b.url)).join('<br>')}</span><br>
    <button class="btn btn-sm btn-primary mt-8" data-act="migrate-urls">${icon('refresh', 14)} 一鍵轉去而家呢個網址${host ? `（${esc(host)}）` : ''}</button>
    <div class="xs faint mt-4">轉完之後要<b>重新下載 QR／重印海報</b>，舊嗰啲已經派出街嘅要重新派過。</div>`, 'danger')}</div>`;
}

function linkCard(l) {
  const legacy = isLegacyUrl(l.url);
  return `<div class="link-card">
    <span class="ic">${icon(l.icon, 18)}</span>
    <div class="grow" style="min-width:0">
      <div class="semibold sm">${esc(l.label)}</div>
      <div class="xs muted mt-4">${esc(l.desc)}</div>
      <div class="u mt-6">${esc(l.url)}</div>
      ${legacy ? `<div class="xs mt-4" style="color:var(--danger)">⚠ 呢條連結指去舊系統（退役之後會死）—— 撳上面嗰個「一鍵轉去而家呢個網址」搬返佢。</div>` : ''}
    </div>
    <div class="row gap-6 wrap no-print" style="justify-content:flex-end">
      <button class="btn btn-xs" data-copy="${esc(l.url)}">${icon('copy', 13)} 複製</button>
      <button class="btn btn-xs" data-qr="${esc(l.url)}" data-qrt="${esc(l.label)}">${icon('qr', 13)} QR</button>
      <button class="btn btn-xs" data-poster="${esc(l.url)}" data-qrt="${esc(l.label)}">${icon('print', 13)} 海報</button>
      <button class="btn btn-xs" data-open="${esc(l.url)}">${icon('external', 13)}</button>
    </div>
  </div>`;
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
    location.hash = el.dataset.go;
  }));
  /* 分頁掣唔使自己綁 —— main.js 已經全域統一處理 [data-tabnav] [data-tab]
     （再綁一次會撳一次跳兩次，tests/tabs.mjs 會釘死呢點）。 */

  root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    if (await copyText(b.dataset.copy)) toast('已複製連結', 'ok'); else toast('複製失敗', 'err');
  }));
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    window.open(b.dataset.open, '_blank', 'noopener');
  }));
  root.querySelectorAll('[data-qr]').forEach(b => b.addEventListener('click', async () => {
    const url = b.dataset.qr;
    await modal({
      title: b.dataset.qrt || 'QR Code', wide: true,
      body: `<div class="center">
          <div class="qr-box" style="width:250px;margin:0 auto">${qrSvg(url, 6, 2)}</div>
          <div class="sm muted mt-12" style="word-break:break-all">${esc(url)}</div>
        </div>`,
      actions: [
        { label: '下載 SVG', class: 'btn', onClick: () => { downloadQrSvg(url, `QR_${stamp()}.svg`, 8, 3); return false; } },
        { label: '複製連結', class: 'btn', onClick: async () => { await copyText(url); toast('已複製', 'ok'); return false; } },
        { label: '關閉', class: 'btn-primary', value: null }
      ]
    });
  }));
  root.querySelectorAll('[data-poster]').forEach(b => b.addEventListener('click', () => poster(b.dataset.poster, b.dataset.qrt)));

  const hubUrl = memberLinks().find(l => l.id === 'hub')?.url;
  root.querySelector('[data-act="copy-hub"]')?.addEventListener('click', async () => {
    if (hubUrl && await copyText(`【${profile().name || ''}】團員入口（掃一次齊晒）
${hubUrl}`)) toast('已複製團員入口', 'ok');
  });
  root.querySelectorAll('[data-act="print-hub"], [data-act="print-poster"]').forEach(b =>
    b.addEventListener('click', () => hubUrl && poster(hubUrl, '團員入口（掃一次齊晒）')));
  root.querySelector('[data-act="settings"]')?.addEventListener('click', () => settingsDialog());

  /* ---- 公開資料：社交媒體 / 相簿 / 連結 ---- */
  const findIn = (arr, id) => arr.find(x => x.id === id);
  root.querySelector('[data-act="add-social"]')?.addEventListener('click', () => editDialog('social', null));
  root.querySelector('[data-act="add-album"]')?.addEventListener('click', () => editDialog('album', null));
  root.querySelector('[data-act="add-link"]')?.addEventListener('click', () => editDialog('link', null));
  root.querySelectorAll('[data-edit-social]').forEach(b => b.addEventListener('click', () => editDialog('social', findIn(socials(), b.dataset.editSocial))));
  root.querySelectorAll('[data-edit-album]').forEach(b => b.addEventListener('click', () => editDialog('album', findIn(albums(), b.dataset.editAlbum))));
  root.querySelectorAll('[data-edit-link]').forEach(b => b.addEventListener('click', () => editDialog('link', findIn(otherLinks(), b.dataset.editLink))));
  root.querySelectorAll('[data-del-social]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmDlg({ title: '刪除社交媒體帳戶', okText: '確定刪除', danger: true, message: '確定刪除呢個帳戶連結？' }))) return;
    removeSocial(b.dataset.delSocial); toast('已刪除', 'ok'); refresh();
  }));
  root.querySelectorAll('[data-del-album]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmDlg({ title: '刪除相簿', okText: '確定刪除', danger: true, message: '確定刪除呢本相簿？' }))) return;
    removeAlbum(b.dataset.delAlbum); toast('已刪除', 'ok'); refresh();
  }));
  root.querySelectorAll('[data-del-link]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmDlg({ title: '刪除連結', okText: '確定刪除', danger: true, message: '確定刪除呢條連結？' }))) return;
    removeLink(b.dataset.delLink); toast('已刪除', 'ok'); refresh();
  }));
  root.querySelector('[data-act="add-suggested"]')?.addEventListener('click', () => {
    const r = addSuggestedLinks('member');
    toast(r.added ? `已加入 ${r.added} 條常用連結` : '常用連結已經全部加咗', r.added ? 'ok' : 'info');
    refresh();
  });
  root.querySelector('[data-act="save-site"]')?.addEventListener('click', () => {
    const url = root.querySelector('#pp-site')?.value.trim() || '';
    const vis = root.querySelector('[data-vis="site"]')?.value || 'member';
    savePublicProfile({ site: { url, vis } });
    toast('已儲存旅團網站', 'ok'); refresh();
  });
  root.querySelector('[data-act="save-about"]')?.addEventListener('click', () => {
    const text = root.querySelector('#pp-about')?.value.trim() || '';
    const vis = root.querySelector('[data-vis="about"]')?.value || 'member';
    savePublicProfile({ about: { text, vis } });
    toast('已儲存旅團簡介', 'ok'); refresh();
  });
  root.querySelector('[data-act="migrate-urls"]')?.addEventListener('click', () => {
    const n = migrateLegacyPublicUrls();
    if (n > 0) {
      toast(`已轉移 ${n} 個網址去而家呢個站 —— 記得重新下載 QR／重印海報`, 'ok');
      refresh();
    } else {
      toast('已經冇指去舊站嘅網址', 'info');
    }
  });
}

function poster(url, label) {
  printDoc({
    title: label || '公開資料', org: profile().name,
    bodyHtml: `<div style="text-align:center">
      <div class="doc-org" style="letter-spacing:.2em">${esc(profile().name || '')}</div>
      <div class="doc-title" style="font-size:19pt;letter-spacing:.14em;margin:8pt 0 4pt">${esc(label || '')}</div>
      <div style="margin:16pt auto;width:240px">${qrSvg(url, 7, 2)}</div>
      <p style="font-size:12pt">用手機掃描上面嘅 QR Code 即用（<b>免登入</b>）。</p>
      <p class="mono" style="font-size:9pt;word-break:break-all">${esc(url)}</p>
    </div>`
  });
}

function printAllPosters() {
  const list = memberLinks();
  printDoc({
    title: '公開資料 QR 一覽', org: profile().name,
    bodyHtml: `<div class="doc-head"><div class="doc-title" style="font-size:17pt">公開資料 QR 一覽</div>
        <div class="doc-sub">${esc(profile().name || '')} · ${esc(new Date().toISOString().slice(0, 10))}</div></div>
      <table><tbody>
        ${list.map(l => `<tr><td style="width:44%">
            <div style="font-weight:700">${esc(l.label)}</div>
            <div class="mono" style="font-size:8pt;word-break:break-all">${esc(l.url)}</div>
          </td><td style="width:56%;text-align:center">${qrSvg(l.url, 5, 2)}</td></tr>`).join('')}
      </tbody></table>`
  });
}

async function settingsDialog() {
  const s = settings().publicLinks || {};
  const { modal: m } = await import('../lib/util.js');
  const r = await m({
    title: '公開頁網址', sub: '留空就用本網站嘅相對位置', wide: true,
    body: `
      <div class="grid g-2" style="gap:12px">
        <div class="field" style="grid-column:1/-1"><label class="label">基礎網址（可留空）</label>
          <input class="input" id="pl-base" value="${esc(s.base || '')}" placeholder="例：https://82.example.com/">
          <div class="hint">如果你把公開頁上載去另一個位置（學校網頁空間 / GitHub Pages），填呢度。</div></div>
        <div class="field"><label class="label">entry.html（收支申報）</label>
          <input class="input" id="pl-entry" value="${esc(s['entry.html'] || '')}"></div>
        <div class="field"><label class="label">borrow.html（物資借用）</label>
          <input class="input" id="pl-borrow" value="${esc(s['borrow.html'] || '')}"></div>
        <div class="field"><label class="label">notice.html（通告）</label>
          <input class="input" id="pl-notice" value="${esc(s['notice.html'] || '')}"></div>
        <div class="field"><label class="label">constitution.html（團章）</label>
          <input class="input" id="pl-cons" value="${esc(s['constitution.html'] || '')}"></div>
      </div>
      <div class="hint mt-8">現時用緊：<code>${esc(publicPageUrl('entry.html', { u: load().unitCode }))}</code></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        base: el.querySelector('#pl-base').value.trim(),
        'entry.html': el.querySelector('#pl-entry').value.trim(),
        'borrow.html': el.querySelector('#pl-borrow').value.trim(),
        'notice.html': el.querySelector('#pl-notice').value.trim(),
        'constitution.html': el.querySelector('#pl-cons').value.trim()
      }) }]
  });
  if (!r) return;
  const db = load();
  db.settings = { ...db.settings, publicLinks: { ...(db.settings.publicLinks || {}), ...r } };
  commit();
  toast('已儲存公開頁網址', 'ok');
  window.dispatchEvent(new CustomEvent('v82:refresh'));
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
