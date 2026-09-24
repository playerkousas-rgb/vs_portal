/* ============================================================
   public.js — 團章公開閱讀頁（constitution.html）
   免登入、可獨立上載；由 constitution.html 以 <script type=module> 載入。
   ============================================================ */

import { esc, icon, toast } from './lib/util.js';
import { toWord, printDoc, toMarkdown } from './lib/exporter.js';
import { todayISO } from './lib/dates.js';
import { postBackend, beFromQuery, shortExec } from './lib/gateway.js';

const q = new URLSearchParams(location.search);
const app = document.getElementById('app');
let lang = q.get('lang') || localStorage.getItem('venture82.pub.lang') || 'both';
let unitCode = q.get('u') || '0082';
let c = null, meta = {}, search = '';

async function loadJson(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** 由旅團後端（Apps Script「資料庫」）讀已發布團章 —— 經同源 /api/proxy，
    免登入、唔使 API Key（後端只回 constitution，唔會漏其他資料）。
    呢個係 2026-09-18 嘅正路：以前公開頁淨係讀靜態檔
    data/units/<編號>/constitution.json —— 但旅團資料而家全部住喺
    旅團自己嘅 Google Sheet，領袖喺 APP 撳「發布」之後，靜態檔根本
    冇人幫佢更新（個網站係平台管理員先可以上載）→ 公開頁永遠 404。 */
let backendNote = '';      /* 讀唔到嘅真正原因（顯示用，唔好淨係話「未發布」） */
async function fetchBackendConstitution() {
  try {
    /* 兩條路：① 同源 /api/proxy（平台登記咗旅團）② 連結帶埋嘅 ?be=<旅團自己嘅 /exec>
       —— 平台未登記嗰陣，「成員連結」生成嘅連結會附 ?be，公開頁先至真係「公開」。 */
    const r = await postBackend({ action: 'constitution' }, { unit: unitCode, execUrl: beFromQuery() });
    if (r.json?.ok && r.json.found && r.json.constitution) return r.json;
    if (r.json?.ok && !r.json.found) backendNote = '後端未有已發布嘅團章';
    else backendNote = r.error || r.json?.error || (r.reason === 'not_registered'
      ? '平台未登記呢個旅團，連結亦冇帶後端網址（?be=）' : '讀唔到後端');
    return null;
  } catch (e) { backendNote = e?.message || String(e); return null; }
}

async function boot() {
  try {
    let registry = null;
    try { registry = await loadJson('data/units.json'); } catch (e) { /* ignore */ }
    if (registry?.units) {
      if (!q.get('u') && registry.defaultUnit) unitCode = registry.defaultUnit;
      meta = registry.units[unitCode] || {};
    }
    /* 伺服器 Registry（環境變數開嘅旅團）都要知個名 */
    if (!meta || !meta.name) {
      try {
        const srv = await loadJson('api/units');
        if (srv?.units?.[unitCode]) meta = { ...(srv.units[unitCode] || {}), ...(meta || {}) };
      } catch (e) { /* 靜態部署冇 API：略過 */ }
    }
    if (q.get('src')) {
      /* ?src= 直接指向任何一張 constitution.json（例如 GitHub raw） */
      c = await loadJson(q.get('src'));
    } else {
      /* ① 旅團後端（APP「發布」咗 + 已同步 → 即刻睇到最新版） */
      const fromBackend = await fetchBackendConstitution();
      if (fromBackend) {
        c = fromBackend.constitution;
        if (fromBackend.unitName) meta.name = fromBackend.unitName;
      }
      /* ② 後端冇 → 試靜態檔（data/units/<編號>/，舊式上載做法） */
      if (!c) {
        const src = meta.dataPath ? `${meta.dataPath}constitution.json` : `data/units/${unitCode}/constitution.json`;
        try { c = await loadJson(src); } catch (e) { c = null; }
      }
      if (!c) throw new Error('後端同靜態檔都讀唔到團章');
    }
    if (!meta.name && c.unitName) meta.name = c.unitName;
    document.title = `${(c.title && c.title.zh) || '團章'} · ${meta.name || unitCode}`;
    render();
  } catch (e) {
    app.innerHTML = `<div class="paper">
      <h1 style="font-size:20px">暫時讀唔到團章</h1>
      <p class="sm muted mt-8">可能係未發布，或者網址唔正確。技術訊息：<code>${esc(e.message)}</code></p>
      ${backendNote ? `<p class="sm mt-8"><b>後端回覆：</b><code>${esc(backendNote)}</code></p>` : ''}
      <p class="sm muted mt-12">管理人請檢查：① 喺系統「團章 → 發布新版本」；
        ② 右上角同步狀態係咪「已存到後端」（資料要同步咗上去，公開頁先讀到）；
        ③ 後端 Apps Script 要係 v2.5.0 或之後（帶「constitution」公開讀取）；
        ④ 呢條網址要由系統「成員連結」頁生成 —— 平台未登記旅團嗰陣，
        連結要帶 <code>?be=</code>（你自己嘅 /exec）先讀到後端${beFromQuery() ? `（而家帶住：<code>${esc(shortExec(beFromQuery()))}</code>）` : ''}。
        舊式做法（上載 <code>data/units/${esc(unitCode)}/constitution.json</code>）照樣支援。</p>
      <a class="btn btn-sm mt-16" href="./">返回系統</a>
    </div>`;
  }
}

function matches(s) {
  if (!search) return true;
  return String(s || '').toLowerCase().includes(search);
}

function chapterHtml() {
  const parts = [];
  (c.chapters || []).forEach(ch => {
    const chZh = ch.heading?.zh || '', chEn = ch.heading?.en || '';
    const arts = (ch.articles || []).filter(a => matches(a.zh) || matches(a.en) || (a.items || []).some(i => matches(i.zh) || matches(i.en)));
    if (search && !matches(chZh) && !matches(chEn) && !arts.length) return;
    parts.push(`<section style="margin-top:26px">
      <h2 style="color:var(--brand-700);border-bottom:2px solid var(--brand-100);padding-bottom:7px;font-size:19px">
        ${lang === 'en' ? esc(chEn) : lang === 'zh' ? esc(chZh) : esc(chZh) + (chEn ? ` <span style="font-weight:400;color:#8A6E74;font-size:14px">／ ${esc(chEn)}</span>` : '')}
      </h2>
      ${arts.map(a => `
        <div class="art">
          ${lang !== 'en' ? `<div>${esc(a.zh || '')}</div>` : ''}
          ${lang !== 'zh' ? `<div class="en">${esc(a.en || '')}</div>` : ''}
        </div>
        ${(a.items || []).filter(i => !search || matches(i.zh) || matches(i.en)).map(i => `
          <div class="art-item ${i.level === 2 ? 'sub' : ''}">
            ${lang !== 'en' ? `<div>${esc(i.zh || '')}</div>` : ''}
            ${lang !== 'zh' ? `<div class="en">${esc(i.en || '')}</div>` : ''}
          </div>`).join('')}
      `).join('')}
    </section>`);
  });
  (c.appendices || []).forEach(ap => {
    parts.push(`<section style="margin-top:26px">
      <h2 style="color:var(--brand-700);border-bottom:2px solid var(--brand-100);padding-bottom:7px;font-size:19px">
        ${lang === 'en' ? esc(ap.heading?.en || '') : esc(ap.heading?.zh || '')}${lang === 'both' && ap.heading?.en ? ` <span style="font-weight:400;color:#8A6E74;font-size:14px">／ ${esc(ap.heading.en)}</span>` : ''}
      </h2>
      ${(ap.blocks || []).map(b => `<div class="art">
        ${lang !== 'en' ? `<div>${esc(b.zh || '')}</div>` : ''}
        ${lang !== 'zh' ? `<div class="en">${esc(b.en || '')}</div>` : ''}
      </div>`).join('')}
    </section>`);
  });
  return parts.join('');
}

function rendered() {
  const title = c.title || {};
  const header = c.header || {};
  return `
    <div class="center" style="margin-bottom:14px">
      <div class="doc-org" style="font-size:12px;letter-spacing:.16em;color:var(--brand-700);font-weight:700">${esc((header.zh || [])[0] || '')}</div>
      <div class="xs faint">${esc((header.en || [])[0] || '')}</div>
      <h1 style="font-size:30px;letter-spacing:.22em;margin:8px 0 2px">${esc(title.zh || '團章')}</h1>
      <div class="sm muted" style="letter-spacing:.1em">${esc(title.en || 'Constitution')}</div>
      <div class="sm mt-8">${esc((header.zh || [])[2] || meta.name || '')}</div>
      <div class="xs faint">${esc((header.en || [])[2] || meta.nameEn || '')}</div>
    </div>
    <div style="height:3px;background:var(--brand-700);border-radius:99px;margin:12px 0 18px"></div>
    ${c.preamble?.zh || c.preamble?.en ? `
      <div style="background:var(--brand-50);border-left:4px solid var(--brand-600);padding:13px 16px;border-radius:0 12px 12px 0">
        <div class="semibold sm mb-6" style="color:var(--brand-800)">序言 · Preamble</div>
        ${lang !== 'en' ? `<div>${esc(c.preamble?.zh || '')}</div>` : ''}
        ${lang !== 'zh' ? `<div class="en" style="color:#54484C;font-size:13.5px">${esc(c.preamble?.en || '')}</div>` : ''}
      </div>` : ''}
    ${chapterHtml()}
    <div style="margin-top:26px;padding-top:12px;border-top:1px solid var(--line)" class="row-between wrap gap-8">
      <div class="xs faint">${esc(c.footer?.zh || '')}</div>
      <div class="xs faint">${esc(c.footer?.en || '')}</div>
    </div>
    <div class="xs faint mt-8">版本 v${esc(c.version || '')} · 更新 ${esc(c.updated || '')} · 由執委管理系統發布</div>`;
}

function render() {
  app.innerHTML = `
  <div class="pub-bar">
    <span class="ttl">${esc(meta.name || c.title?.zh || '團章')}</span>
    <div class="seg">
      <button data-lang="zh" aria-selected="${lang === 'zh'}">中文</button>
      <button data-lang="en" aria-selected="${lang === 'en'}">English</button>
      <button data-lang="both" aria-selected="${lang === 'both'}">對照</button>
    </div>
    <button class="btn btn-xs" data-act="print">${icon('print', 14)} PDF</button>
    <button class="btn btn-xs" data-act="word">${icon('download', 14)} Word</button>
    <button class="btn btn-xs" data-act="md">${icon('download', 14)} Markdown</button>
    <span class="sp">v${esc(c.version || '')} · ${esc(c.updated || '')}</span>
  </div>
  <div class="search-wrap mb-16 no-print" style="max-width:340px">
    <span class="ic">${icon('search', 15)}</span>
    <input class="input" id="pubSearch" placeholder="搜尋條文…" value="${esc(search)}">
  </div>
  <article class="paper" id="paper">${rendered()}</article>

  <div class="card mt-16 no-print" style="padding:14px 16px">
    <div class="row gap-10 wrap">
      <span class="stat-ic">${icon('qr', 16)}</span>
      <div class="grow sm">想睇最新版？掃描／分享：<span class="mono xs">${esc(location.href)}</span></div>
      <button class="btn btn-xs" data-act="copy">${icon('copy', 13)} 複製連結</button>
    </div>
  </div>
  <div class="center xs faint mt-16">© ${new Date().getFullYear()} ${esc(meta.name || '')} · 本頁免登入公開閱讀</div>`;

  app.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
    lang = b.dataset.lang;
    localStorage.setItem('venture82.pub.lang', lang);
    render();
  }));
  app.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.act;
    if (a === 'print') printDoc({ title: '團章', org: meta.name || '', bodyHtml: docForExport() });
    if (a === 'word') toWord({ filename: `團章_v${c.version || ''}.doc`, title: '團章', org: meta.name || '', bodyHtml: docForExport() });
    if (a === 'md') {
      const L = [`# ${c.title?.zh || '團章'} / ${c.title?.en || ''}`, '', `> ${meta.name || ''} · v${c.version || ''} · ${c.updated || ''}`, ''];
      (c.chapters || []).forEach(ch => {
        L.push(`## ${ch.heading?.zh || ''} / ${ch.heading?.en || ''}`, '');
        (ch.articles || []).forEach(x => {
          L.push(`- ${x.zh || ''}`, x.en ? `  - ${x.en}` : '');
          (x.items || []).forEach(i => L.push(`  ${i.level === 2 ? '    ' : '  '}- ${i.zh || ''}${i.en ? ` — ${i.en}` : ''}`));
        });
        L.push('');
      });
      toMarkdown({ filename: `團章_v${c.version || ''}.md`, md: L.join('\n') });
    }
    if (a === 'copy') {
      try { await navigator.clipboard.writeText(location.href); toast('已複製連結', 'ok'); } catch { toast('複製失敗', 'err'); }
    }
  }));
  const s = app.querySelector('#pubSearch');
  if (s) s.addEventListener('input', () => { search = s.value; clearTimeout(s._t); s._t = setTimeout(render, 250); });
}

/* 匯出用：中英對照排版（Word / PDF） */
function docForExport() {
  const title = c.title || {};
  const L = [];
  L.push(`<div class="doc-head"><div class="doc-org">${esc((c.header?.zh || [])[0] || '')}</div>
    <div class="doc-title">${esc(title.zh || '團章')}</div>
    <div class="doc-sub">${esc(title.en || '')} · ${esc(meta.name || '')}</div></div>`);
  L.push(`<div class="doc-meta"><span>版本 v${esc(c.version || '')}</span><span>更新 ${esc(c.updated || '')}</span><span>${esc(todayISO())}</span></div>`);
  if (c.preamble?.zh) L.push(`<p><b>序言 Preamble</b></p><p>${esc(c.preamble.zh)}</p><p class="en-block">${esc(c.preamble.en || '')}</p>`);
  (c.chapters || []).forEach(ch => {
    L.push(`<h2>${esc(ch.heading?.zh || '')} / ${esc(ch.heading?.en || '')}</h2>`);
    (ch.articles || []).forEach(a => {
      L.push(`<p class="art">${esc(a.zh || '')}<span class="en"><br>${esc(a.en || '')}</span></p>`);
      (a.items || []).forEach(i => L.push(`<p class="art-item ${i.level === 2 ? 'sub' : ''}">${esc(i.zh || '')}<span class="en"><br>${esc(i.en || '')}</span></p>`));
    });
  });
  (c.appendices || []).forEach(ap => {
    L.push(`<h2>${esc(ap.heading?.zh || '')} / ${esc(ap.heading?.en || '')}</h2>`);
    (ap.blocks || []).forEach(b => L.push(`<p>${esc(b.zh || '')}<span class="en"><br>${esc(b.en || '')}</span></p>`));
  });
  L.push(`<div class="foot"><span>${esc(c.footer?.zh || '')}</span><span>v${esc(c.version || '')}</span></div>`);
  return L.join('');
}

boot();
