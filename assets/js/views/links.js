/* ============================================================
   links.js — 公開資料（**只讀一覽表**）
   ------------------------------------------------------------
   ★ 2026-09-24 團長（重要定位修正）：
     「公開資料其實**唔係要填嘢嘅**，係方便了解有乜嘢而家正喺度公開。」

   所以呢頁**冇任何輸入位** —— 佢淨係答一個問題：
     「我團而家公開緊啲乜？每樣嘢邊個睇到？」

   聚合範圍（lib/public-profile.js 嘅 publicOverview()）：
     ① 關於我團      ② 旅團網站    ③ 社交媒體   ④ 相簿
     ⑤ 其他連結      ⑥ 行事曆      ⑦ 通告       ⑧ 試卷
   每項一個「邊個睇到」標籤 ＋ 一個「去改」掣 → 跳去真正填嘢嗰個位：
     · ①②③④⑤ → 旅團設定（#/admin/settings，見 public-links-editor.js）
     · ⑥ → 行事曆（#/calendar）　⑦ → 通告（#/notices）　⑧ → 試卷（#/quizzes）
     「邊個睇到」係喺**各自嘅編輯器**設（團長揀咗 in_editor），唔喺呢度設。

   另一個分頁「團員入口」＝ 派得出去嗰條連結／QR（分享用，一樣唔係填嘢位）。
   ============================================================ */

import { load, commit } from '../lib/store.js';
import { esc, icon, modal, toast, copyText, qrSvg, confirmDlg } from '../lib/util.js';
import { toWord, printDoc, downloadQrSvg, stamp } from '../lib/exporter.js';
import { profile, settings, memberLinks, publicPageUrl, findLegacyPublicUrls, migrateLegacyPublicUrls, isLegacyUrl, publicLinkRoute } from '../lib/model.js';
import { pageHead, tabs, stat, empty, noteBox, visBadge } from './ui.js';
import { can, currentRole } from '../lib/auth.js';
import { VIS_LEVELS, visibleTo, publicOverview, overviewCounts, visOf, publicPageHtml, publicGroupsFor } from '../lib/public-profile.js';

let tab = 'overview';

export function title() { return '公開資料'; }

export function render(params = {}) {
  /* 冇帶分頁（純 #/links）＝ 返「一覽」呢個主頁（★ 團長：公開資料係睇嘢嘅位）。
     唔可以「留返上次嗰個分頁」—— tab 係模組級變數，去過 #/links/hub 之後
     再撳側邊欄「公開資料」就會跌入第二個分頁，用家會以為成頁壞咗。 */
  if (['overview', 'hub'].includes(params.id)) tab = params.id;
  else if (!params.id) tab = 'overview';
  return `
  ${pageHead({
    title: '公開資料',
    sub: '而家公開緊啲乜 —— 邊個睇得到，一覽就知（要改去「旅團設定」或各自嘅頁）',
    actions: `<button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 公開頁網址</button>
      <button class="btn btn-sm btn-primary" data-act="preview">${icon('external', 15)} 預覽對外專頁</button>`
  })}
  ${legacyBanner()}
  ${tabs([
    ['overview', '一覽'],
    ['hub', '團員入口（分享）']
  ], tab)}
  ${tab === 'hub' ? hubView() : overviewView()}`;
}

/* ============================================================
   一覽：而家公開緊啲乜？（只讀）
   ============================================================ */
function overviewView() {
  const groups = publicOverview();
  const c = overviewCounts(groups);
  const mine = currentRole();

  return `
  ${noteBox(`<b>呢頁係一覽表 —— 只係話你知「而家公開緊啲乜」。</b>
    要<b>改</b>：①②③④⑤ 去 <b>「系統 → 旅團設定」</b>；
    行事曆／通告／試卷嘅「邊個睇到」喺<b>各自嘅編輯器</b>設（撳下面每組右上「去改」就得）。
    <div class="xs mt-4">層級：${VIS_LEVELS.map(v => `<b>${esc(v.name)}</b>(${v.rank})`).join(' &lt; ')} —— 設成 N ＝ <b>N 同更高權限</b>先見到。</div>`, 'brand')}

  <div class="stat-grid mb-16">
    ${stat('公開緊', c.total, '總共幾多項')}
    ${stat('對外公開（免登入）', c.public, '登入頁／對外專頁睇到', c.public ? 'ok' : '')}
    ${stat('要團員登入', c.byLevel.member || 0, '團員同以上')}
    ${stat('執委以上', (c.byLevel.exco || 0) + (c.byLevel.leader || 0) + (c.byLevel.chief || 0), '收窄咗嘅內容')}
  </div>

  ${groups.length ? groups.map(overviewGroup).join('')
    : empty('globe', '而家乜都未公開', '去「系統 → 旅團設定」加入旅團網站／社交媒體／相簿，或者去「通告」開一張通告')}

  <div class="xs faint mt-12">你而家嘅身份：<b>${esc(mine || '—')}</b> —— 上面標紅「（你睇唔到）」嘅，即係權限高過你，你自己都睇唔到。</div>`;
}

function overviewGroup(g) {
  const vis = currentRole();
  return `
  <div class="card mb-16">
    <div class="card-head"><div>
      <div class="card-title">${icon(g.icon, 16)} ${esc(g.title)} <span class="faint">· ${g.items.length}</span></div>
      <div class="card-sub">${esc(GROUP_HINT[g.kind] || '')}</div></div>
      <button class="btn btn-sm" data-go="${esc(g.editHash)}">${icon('edit', 14)} 去改</button></div>
    <div>
      ${g.items.map(it => {
        const see = visibleTo(it.vis, vis);
        return `<div class="list-item">
          <span class="stat-ic">${icon(g.icon, 15)}</span>
          <div class="li-main">
            <div class="li-t">${esc(it.title)} ${visBadge(it.vis)}</div>
            <div class="li-s xs faint">${esc(it.desc || '')}${it.url ? ` · ${esc(it.url)}` : ''}</div>
          </div>
          ${it.url ? `<button class="btn btn-xs" data-open="${esc(it.url)}">${icon('external', 13)}</button>` : ''}
          ${!see ? `<span class="badge b-grey">你睇唔到</span>` : ''}
          ${it.url && isLegacyUrl(it.url) ? `<span class="badge b-danger">⚠ 指去舊系統（退役之後會死）</span>` : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

const GROUP_HINT = {
  about: '一段文字，出喺團員入口同對外專頁',
  site: '旅團自己嘅網頁',
  social: 'IG／FB／YouTube／WhatsApp 頻道…',
  album: '活動相、宣傳相',
  link: '總會、YMIS、物品供應社…',
  event: '行事曆 —— 設「對外公開」就可以畀非團員睇活動',
  notice: '通告 —— 預設「對外公開」（同而家 notice.html 一樣，免登入睇到）',
  quiz: '試卷 —— 團員登入先填到'
};

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
  root.querySelector('[data-act="preview"]')?.addEventListener('click', () => previewPublicPage());

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

/** 「預覽對外專頁」—— 免登入嗰份（淨係 show「對外公開」嘅嘢） */
function previewPublicPage() {
  const g = publicGroupsFor('other');
  modal({
    title: '對外專頁（免登入）', wide: true,
    sub: g.length ? '呢度就係未登入嘅人喺登入頁會見到嘅嘢' : '仲未有對外公開嘅內容',
    body: publicPageHtml({ unitName: profile().name }),
    actions: [{ label: '關閉', class: 'btn-primary', value: null }]
  });
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
