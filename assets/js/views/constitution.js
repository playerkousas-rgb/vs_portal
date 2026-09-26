/* ============================================================
   constitution.js — 團章（內建 · 中英雙語 · 可改 · 可輸出 · QR）
   • 語言：中文 / English / 對照（分頁切換）
   • 編輯：序言、章節、條文、子項，可增刪
   • 發布：版本記錄、輸出 Word / PDF / Markdown / 單一 HTML / JSON
   • QR Code：指向公開閱讀頁（constitution.html?u=編號）
   ============================================================ */

import { load, commit, collection, add, update, remove, setSetting, audit } from '../lib/store.js';
import { constitution, articleCount, profile, settings, memberName, isLegacyUrl } from '../lib/model.js';
import { todayISO } from '../lib/dates.js';
import {
  esc, icon, uid, modal, confirmDlg, toast, copyText, fmtDate, nf
} from '../lib/util.js';
import { toWord, printDoc, toMarkdown, qrSvg, downloadQrSvg, download as dlFile, stamp, docCss } from '../lib/exporter.js';
import { go, parse } from '../lib/router.js';
import { can, current, displayName, isSuper } from '../lib/auth.js';
import { pageHead, tabs, empty, noteBox, kv } from './ui.js';

let lang = 'zh';          // zh | en | both
let mode = 'view';        // view | edit
let search = '';

export function title() { return '團章'; }

const LANG_TABS = [['zh', '中文'], ['en', 'English'], ['both', '中英對照']];

export function render(params) {
  const c = constitution();
  const pubUrl = publicUrl();

  return `
  ${pageHead({
    title: '團章',
    sub: `${profile().name || ''} · 版本 ${c.version || '—'} · 更新 ${c.updated || '—'} · 共 ${c.chapters?.length || 0} 章 / ${articleCount(c)} 條`,
    actions: `
      <div class="seg" role="tablist">
        ${LANG_TABS.map(([k, l]) => `<button role="tab" data-lang="${k}" aria-selected="${lang === k}">${l}</button>`).join('')}
      </div>
      <div class="seg" role="tablist">
        <button role="tab" data-mode="view" aria-selected="${mode === 'view'}">${icon('eye', 15)} 閱讀</button>
        <button role="tab" data-mode="edit" aria-selected="${mode === 'edit'}" ${can('constitution.edit') ? '' : 'disabled'}>${icon('edit', 15)} 編輯</button>
      </div>
      <button class="btn btn-sm" data-act="export">${icon('download', 15)} 輸出</button>
      <button class="btn btn-sm" data-act="qr">${icon('qr', 15)} QR Code</button>
      <button class="btn btn-sm" data-act="print">${icon('print', 15)} PDF</button>
      ${can('constitution.publish') ? `<button class="btn btn-sm btn-primary" data-act="publish">${icon('save', 15)} 發布新版本</button>` : ''}`
  })}

  <div class="grid g-2-1">
    <div>
      ${mode === 'edit' ? editorBar(c) : ''}
      <div class="doc" id="docSheet" style="padding:26px 30px">
        ${docBody(c, mode === 'edit')}
      </div>
    </div>

    <div class="col gap-16 no-print">
      <div class="card">
        <div class="card-head"><div class="card-title">輸出同分享</div></div>
        <div style="padding:14px 16px" class="col gap-8">
          <button class="btn btn-block" data-act="exp-word">${icon('download', 16)} Word（.doc）</button>
          <button class="btn btn-block" data-act="exp-pdf">${icon('print', 16)} PDF / 列印</button>
          <button class="btn btn-block" data-act="exp-md">${icon('download', 16)} Markdown</button>
          <button class="btn btn-block" data-act="exp-html">${icon('download', 16)} 單一 HTML（可離線／可上載）</button>
          <button class="btn btn-block" data-act="qr">${icon('qr', 16)} QR Code（畀團員掃）</button>
          <button class="btn btn-block" data-act="copy-link">${icon('link', 16)} 複製公開連結</button>
          ${can('constitution.publish') ? `<button class="btn btn-block" data-act="exp-json">${icon('save', 16)} 下載 JSON 備份（純備份用 —— 發布唔使上載任何檔案）</button>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">公開閱讀頁</div>
          <div class="card-sub">QR Code 會指向呢個網址，團員免登入都睇到</div></div></div>
        <div style="padding:14px 16px">
          <div class="field">
            <label class="label">公開網址</label>
            <input class="input" id="pubUrl" value="${esc(pubUrl)}">
            ${isLegacyUrl(pubUrl) ? `<div class="xs mt-4" style="color:var(--danger)">⚠ 呢個網址指去舊系統（82venture.vercel.app）——去「<b>公開資料</b>」可以一鍵搬晒所有舊連結去而家呢個站，之後記得重新下載 QR。</div>` : ''}
            <div class="hint mt-4">預設用本網站嘅 <code>constitution.html?u=${esc(load().unitCode)}</code>。如你放喺其他位置，可以改成自己嘅網址。</div>
          </div>
          <button class="btn btn-sm btn-block mt-12" data-act="save-url" ${can('constitution.publish') ? '' : 'disabled'}>${icon('save', 15)} 儲存網址</button>
          <div class="mt-12 center">
            <div class="qr-box" style="width:150px;margin:0 auto"><div id="pubQr">${qrSvg(pubUrl, 4, 1)}</div></div>
            <div class="xs faint mt-8">掃描即睇團章（免登入）</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">版本記錄</div>
          <div class="card-sub">${(c.history || []).length} 個版本</div></div>
        <div style="padding:14px 16px">
          <div class="timeline">
            ${(c.history || []).map(h => `
              <div class="tl-item ${h.version === c.version ? 'done' : ''}">
                <div class="tl-date mono">${esc(h.date || '')}</div>
                <div class="sm semibold">v${esc(h.version)} <span class="faint">· ${esc(h.by || '')}</span></div>
                <div class="xs muted">${esc(h.note || '')}</div>
              </div>`).join('') || '<div class="faint sm">未有版本記錄</div>'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">發布流程</div></div>
        <div style="padding:16px 18px" class="steps">
          <div class="step"><div><div class="sm semibold">編輯條文</div><div class="xs muted">切換到「編輯」改內容</div></div></div>
          <div class="step"><div><div class="sm semibold">發布新版本</div><div class="xs muted">輸入版本號同修改摘要</div></div></div>
          <div class="step"><div><div class="sm semibold">等同步存到後端</div><div class="xs muted">右上角「已存到後端」之後，公開閱讀頁（constitution.html）即刻顯示新版 —— 唔使人手上載檔案</div></div></div>
          <div class="step"><div><div class="sm semibold">派 QR Code</div><div class="xs muted">團員掃描即睇最新版</div></div></div>
        </div>
        <div style="padding:0 18px 16px"><div class="hint">${icon('info', 13)} 舊式做法（下載 constitution.json 叫管理員上載 <code>data/units/</code>）仍然支援，但已經唔需要 —— 只要後端 Apps Script 係 <b>v2.5.0</b> 或之後就得。</div></div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   文件內容
   ============================================================ */
function docBody(c, editing) {
  const q = search.trim().toLowerCase();
  const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
  const header = c.header || {};
  const titleZh = c.title?.zh || '團章';
  const titleEn = c.title?.en || 'Constitution';

  const articleHtml = (a, chId) => {
    const zh = a.zh || '', en = a.en || '';
    if (!editing && q && !hit(zh) && !hit(en) && !(a.items || []).some(i => hit(i.zh) || hit(i.en))) return '';
    const items = (a.items || []).filter(i => !q || hit(i.zh) || hit(i.en));
    const itemBlock = (items.length ? `<div class="art-items">${items.map(i => `
      <div class="art-item ${i.level === 2 ? 'level2' : ''}">
        ${lang !== 'en' ? `<div>${esc(i.zh || '')}</div>` : ''}
        ${lang !== 'zh' ? `<div class="bi-en">${esc(i.en || '')}</div>` : ''}
        ${editing ? `<span class="no-print row gap-4" style="margin-left:6px">
          <button class="btn btn-xs btn-ghost" data-edit-item="${a.id}" data-ch="${chId}" data-item="${i.id}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-ghost" data-del-item="${a.id}" data-ch="${chId}" data-item="${i.id}">${icon('trash', 12)}</button></span>` : ''}
      </div>`).join('')}</div>` : '');

    return `<div class="art" id="${a.id}">
      <div class="bi-pair ${lang === 'both' ? '' : 'single'}">
        ${lang !== 'en' ? `<div>${esc(zh)}</div>` : ''}
        ${lang !== 'zh' ? `<div class="bi-en">${esc(en)}</div>` : ''}
      </div>
      ${itemBlock}
      ${editing ? `<div class="row gap-4 no-print mt-4">
        <button class="btn btn-xs" data-edit-art="${a.id}" data-ch="${chId}">${icon('edit', 12)} 改條文</button>
        <button class="btn btn-xs" data-del-art="${a.id}" data-ch="${chId}">${icon('trash', 12)} 刪除</button>
        <button class="btn btn-xs" data-add-item="${a.id}" data-ch="${chId}">${icon('plus', 12)} 加子項</button>
      </div>` : ''}
    </div>`;
  };

  return `
  <div class="center mb-16">
    <div class="doc-org">${esc((header.zh || [])[0] || '')}</div>
    <div class="xs faint">${esc((header.en || [])[0] || '')}</div>
    <div class="doc-h1">${esc(titleZh)}</div>
    <div class="doc-h2">${esc(titleEn)}</div>
    <div class="sm muted mt-8">${esc((header.zh || [])[2] || profile().name || '')}</div>
    <div class="xs faint">${esc((header.en || [])[2] || profile().nameEn || '')}</div>
    <div class="xs faint">${esc((header.zh || [])[3] || '')}</div>
  </div>
  <div class="rule"></div>

  ${(c.preamble && (c.preamble.zh || c.preamble.en)) ? `
    <div style="background:var(--brand-50);border-left:4px solid var(--brand-600);padding:13px 16px;border-radius:0 12px 12px 0;margin-bottom:18px">
      <div class="semibold sm mb-6" style="color:var(--brand-800)">序言 · Preamble</div>
      ${lang !== 'en' && c.preamble.zh ? `<div style="white-space:pre-wrap">${esc(c.preamble.zh)}</div>` : ''}
      ${lang !== 'zh' && c.preamble.en ? `<div class="bi-en" style="white-space:pre-wrap;margin-top:${lang === 'both' ? '8px' : '0'}">${esc(c.preamble.en)}</div>` : ''}
      ${editing ? `<button class="btn btn-xs no-print mt-8" data-edit-pre="1">${icon('edit', 12)} 改序言</button>` : ''}
    </div>` : ''}

  ${(c.chapters || []).map(ch => {
    const chZh = ch.heading?.zh || '', chEn = ch.heading?.en || '';
    if (!editing && q && !hit(chZh) && !hit(chEn) && !(ch.articles || []).some(a => hit(a.zh) || hit(a.en))) return '';
    return `<div class="chapter">
      <h2 style="display:flex;align-items:center;gap:8px">
        <span>${esc(lang === 'en' ? chEn : lang === 'both' && chEn && chEn !== chZh ? `${chZh} ／ ${chEn}` : chZh)}</span>
        ${editing ? `<span class="no-print row gap-4">
          <button class="btn btn-xs btn-ghost" data-edit-ch="${ch.id}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-ghost" data-add-art="${ch.id}">${icon('plus', 12)} 加條文</button>
          <button class="btn btn-xs btn-ghost" data-del-ch="${ch.id}">${icon('trash', 12)}</button>
        </span>` : ''}
      </h2>
      <div>${(ch.articles || []).map(a => articleHtml(a, ch.id)).join('') || '<div class="faint sm">（本章暫無條文）</div>'}</div>
    </div>`;
  }).join('')}

  ${(c.appendices || []).length ? (c.appendices || []).map(ap => `
    <div class="chapter">
      <h2 style="display:flex;align-items:center;gap:8px">
        <span>${esc(lang === 'en' ? (ap.heading?.en || '') : (ap.heading?.zh || ''))}${lang === 'both' && ap.heading?.en ? ` ／ ${esc(ap.heading.en)}` : ''}</span>
        ${editing ? `<span class="no-print row gap-4">
          <button class="btn btn-xs btn-ghost" data-edit-ch="${ap.id}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-ghost" data-add-block="${ap.id}">${icon('plus', 12)} 加段落</button>
          <button class="btn btn-xs btn-ghost" data-del-ch="${ap.id}">${icon('trash', 12)}</button></span>` : ''}
      </h2>
      ${(ap.blocks || []).map(b => `<div class="art">
        <div class="bi-pair ${lang === 'both' ? '' : 'single'}">
          ${lang !== 'en' ? `<div>${esc(b.zh || '')}</div>` : ''}
          ${lang !== 'zh' ? `<div class="bi-en">${esc(b.en || '')}</div>` : ''}
        </div>
        ${editing ? `<div class="row gap-4 no-print mt-4">
          <button class="btn btn-xs" data-edit-block="${ap.id}" data-block="${b.id}">${icon('edit', 12)}</button>
          <button class="btn btn-xs" data-del-block="${ap.id}" data-block="${b.id}">${icon('trash', 12)}</button></div>` : ''}
      </div>`).join('')}
    </div>`).join('') : ''}

  <div style="margin-top:26px;padding-top:12px;border-top:1px solid var(--line)" class="row-between wrap gap-8">
    <div class="xs faint">${esc(c.footer?.zh || '')}</div>
    <div class="xs faint">${esc(c.footer?.en || '')}</div>
  </div>
  <div class="xs faint mt-8">版本 v${esc(c.version || '—')} · 更新日期 ${esc(c.updated || '')} · 由深資童軍管理系統輸出</div>`;
}

function editorBar(c) {
  return `
  <div class="row gap-8 wrap mb-12 no-print">
    <button class="btn btn-sm" data-act="edit-meta">${icon('edit', 15)} 改標題 / 版本 / 序言</button>
    <button class="btn btn-sm" data-act="add-ch">${icon('plus', 15)} 新增章節</button>
    <button class="btn btn-sm" data-act="add-apx">${icon('plus', 15)} 新增附件</button>
    <div class="search-wrap grow"><span class="ic">${icon('search', 15)}</span>
      <input class="input" id="cSearch" placeholder="搜尋條文…" value="${esc(search)}"></div>
  </div>`;
}

/* ============================================================
   編輯動作
   ============================================================ */
function chapterOf(id) { return (constitution().chapters || []).find(c => c.id === id); }
function appendixOf(id) { return (constitution().appendices || []).find(a => a.id === id); }

async function editMeta() {
  const c = constitution();
  const r = await modal({
    title: '編輯團章基本資料', wide: true,
    body: `<div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">標題（中）</label><input class="input" id="m-tzh" value="${esc(c.title?.zh || '')}"></div>
        <div class="field"><label class="label">標題（英）</label><input class="input" id="m-ten" value="${esc(c.title?.en || '')}"></div>
        <div class="field"><label class="label">版本</label><input class="input" id="m-ver" value="${esc(c.version || '')}"></div>
        <div class="field"><label class="label">更新日期</label><input class="input" id="m-date" value="${esc(c.updated || todayISO())}"></div>
      </div>
      <div class="field mt-12"><label class="label">序言（中）</label>
        <textarea class="textarea" id="m-pzh" style="min-height:90px">${esc(c.preamble?.zh || '')}</textarea></div>
      <div class="field mt-12"><label class="label">序言（English）</label>
        <textarea class="textarea" id="m-pen" style="min-height:90px">${esc(c.preamble?.en || '')}</textarea></div>
      <div class="field mt-12"><label class="label">頁腳（中）</label><input class="input" id="m-fzh" value="${esc(c.footer?.zh || '')}"></div>
      <div class="field mt-12"><label class="label">頁腳（English）</label><input class="input" id="m-fen" value="${esc(c.footer?.en || '')}"></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        title: { zh: el.querySelector('#m-tzh').value.trim(), en: el.querySelector('#m-ten').value.trim() },
        version: el.querySelector('#m-ver').value.trim(),
        updated: el.querySelector('#m-date').value.trim(),
        preamble: { zh: el.querySelector('#m-pzh').value, en: el.querySelector('#m-pen').value },
        footer: { zh: el.querySelector('#m-fzh').value.trim(), en: el.querySelector('#m-fen').value.trim() }
      }) }]
  });
  if (!r) return;
  const db = load();
  db.constitution = { ...db.constitution, ...r };
  commit(); toast('已更新', 'ok'); refresh();
}

async function editChapter(id, isApx = false) {
  const ch = isApx ? appendixOf(id) : chapterOf(id);
  const r = await modal({
    title: isApx ? '編輯附件標題' : '編輯章節標題',
    body: `<div class="field"><label class="label">標題（中）</label><input class="input" id="q-zh" value="${esc(ch?.heading?.zh || '')}"></div>
      <div class="field mt-12"><label class="label">標題（英）</label><input class="input" id="q-en" value="${esc(ch?.heading?.en || '')}"></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value.trim(), en: el.querySelector('#q-en').value.trim() }) }]
  });
  if (!r) return;
  const db = load();
  const target = isApx ? (db.constitution.appendices || []).find(a => a.id === id) : (db.constitution.chapters || []).find(c => c.id === id);
  if (target) { target.heading = r; commit(); toast('已更新', 'ok'); refresh(); }
}

async function editArticle(chId, artId, itemId) {
  const ch = chapterOf(chId);
  const art = (ch?.articles || []).find(a => a.id === artId);
  const item = itemId ? (art?.items || []).find(i => i.id === itemId) : null;
  const target = item || art;
  const r = await modal({
    title: item ? '編輯子項' : '編輯條文', wide: true,
    body: `<div class="field"><label class="label">中文</label>
        <textarea class="textarea" id="q-zh" style="min-height:90px">${esc(target?.zh || '')}</textarea></div>
      <div class="field mt-12"><label class="label">English</label>
        <textarea class="textarea" id="q-en" style="min-height:90px">${esc(target?.en || '')}</textarea></div>
      ${item ? '<div class="field mt-12"><label class="label">縮排層級</label><select class="select" id="q-level"><option value="1">一般</option><option value="2" ' + (item.level === 2 ? 'selected' : '') + '>次級（縮排）</option></select></div>' : ''}`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        zh: el.querySelector('#q-zh').value, en: el.querySelector('#q-en').value,
        level: item ? Number(el.querySelector('#q-level').value) : undefined
      }) }]
  });
  if (!r) return;
  const db = load();
  const c2 = db.constitution.chapters.find(c => c.id === chId);
  const a2 = (c2?.articles || []).find(a => a.id === artId);
  if (!a2) return;
  if (item) {
    const i2 = (a2.items || []).find(i => i.id === itemId);
    if (i2) { i2.zh = r.zh; i2.en = r.en; if (r.level) i2.level = r.level; }
  } else { a2.zh = r.zh; a2.en = r.en; }
  commit(); toast('已更新條文', 'ok'); refresh();
}

async function addArticle(chId) {
  const r = await modal({
    title: '新增條文', wide: true,
    body: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:80px"></textarea></div>
      <div class="field mt-12"><label class="label">English</label><textarea class="textarea" id="q-en" style="min-height:80px"></textarea></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '新增', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value, en: el.querySelector('#q-en').value }) }]
  });
  if (!r || (!r.zh && !r.en)) return;
  const db = load();
  const ch = db.constitution.chapters.find(c => c.id === chId);
  ch.articles = ch.articles || [];
  ch.articles.push({ id: uid('a'), ...r });
  commit(); toast('已新增條文', 'ok'); refresh();
}

async function addItem(chId, artId) {
  const r = await modal({
    title: '新增子項（例：甲 / 乙 / (i)）', wide: true,
    body: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:70px"></textarea></div>
      <div class="field mt-12"><label class="label">English</label><textarea class="textarea" id="q-en" style="min-height:70px"></textarea></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '新增', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value, en: el.querySelector('#q-en').value }) }]
  });
  if (!r || (!r.zh && !r.en)) return;
  const db = load();
  const ch = db.constitution.chapters.find(c => c.id === chId);
  const art = ch.articles.find(a => a.id === artId);
  art.items = art.items || [];
  art.items.push({ id: uid('i'), ...r });
  commit(); toast('已新增子項', 'ok'); refresh();
}

async function addChapter() {
  const n = (constitution().chapters || []).length + 1;
  const r = await modal({
    title: '新增章節',
    body: `<div class="field"><label class="label">標題（中）</label><input class="input" id="q-zh" value="${n}. "></div>
      <div class="field mt-12"><label class="label">標題（英）</label><input class="input" id="q-en" value="${n}. "></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '新增', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value.trim(), en: el.querySelector('#q-en').value.trim() }) }]
  });
  if (!r) return;
  const db = load();
  db.constitution.chapters = db.constitution.chapters || [];
  db.constitution.chapters.push({ id: uid('c'), heading: r, articles: [] });
  commit(); toast('已新增章節', 'ok'); refresh();
}

async function addAppendix() {
  const r = await modal({
    title: '新增附件',
    body: `<div class="field"><label class="label">標題（中）</label><input class="input" id="q-zh" placeholder="附件 A"></div>
      <div class="field mt-12"><label class="label">標題（英）</label><input class="input" id="q-en" placeholder="Appendix A"></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '新增', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value.trim(), en: el.querySelector('#q-en').value.trim() }) }]
  });
  if (!r) return;
  const db = load();
  db.constitution.appendices = db.constitution.appendices || [];
  db.constitution.appendices.push({ id: uid('apx'), heading: r, blocks: [] });
  commit(); toast('已新增附件', 'ok'); refresh();
}

async function editBlock(apxId, blockId) {
  const b = (appendixOf(apxId)?.blocks || []).find(x => x.id === blockId);
  const r = await modal({
    title: '編輯段落', wide: true,
    body: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:80px">${esc(b?.zh || '')}</textarea></div>
      <div class="field mt-12"><label class="label">English</label><textarea class="textarea" id="q-en" style="min-height:80px">${esc(b?.en || '')}</textarea></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value, en: el.querySelector('#q-en').value }) }]
  });
  if (!r) return;
  const db = load();
  const apx = db.constitution.appendices.find(a => a.id === apxId);
  const blk = (apx.blocks || []).find(x => x.id === blockId);
  if (blk) { blk.zh = r.zh; blk.en = r.en; commit(); toast('已更新', 'ok'); refresh(); }
}

/* ============================================================
   發布
   ============================================================ */
async function publish() {
  const c = constitution();
  const guess = nextVersion(c.version);
  const r = await modal({
    title: '發布新版本', sub: '會記錄版本號、日期、修改人同摘要',
    body: `<div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">版本號</label><input class="input" id="q-ver" value="${esc(guess)}"></div>
        <div class="field"><label class="label">日期</label><input class="input" id="q-date" value="${todayISO()}"></div>
      </div>
      <div class="field mt-12"><label class="label">修訂摘要</label>
        <input class="input" id="q-note" placeholder="例：修訂第 8 條團費金額、新增附件 B"></div>
      <div class="hint mt-12">發布之後等右上角同步狀態變「已存到後端」，公開閱讀頁（constitution.html）同 QR Code 就會即刻顯示新版 —— 唔使再人手上載檔案（後端 Apps Script v2.5.0+）。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '發布', class: 'btn-primary', onClick: el => ({
        version: el.querySelector('#q-ver').value.trim(),
        date: el.querySelector('#q-date').value.trim(),
        note: el.querySelector('#q-note').value.trim()
      }) }]
  });
  if (!r || !r.version) return;
  const db = load();
  db.constitution.version = r.version;
  db.constitution.updated = r.date;
  db.constitution.status = 'published';
  db.constitution.history = [{ version: r.version, date: r.date, by: displayName(), note: r.note }, ...(db.constitution.history || [])];
  commit();
  audit('發布團章', `v${r.version} ${r.note}`);
  refresh();

  /* 2026-09-19 團長回報：「團章我都一直 POST 唔到出尼，我按出 JSON 佢會變
     JSON 俾我，但要我再上傳番去唔知邊？唔係應該我按 PUSH ＝ 出番去公開
     俾所有團員睇到？要我下載個檔再上傳？」

     佢講得啱，舊流程係壞嘅，而且壞喺兩處：
     ① 呢度 `setTimeout(() => exportJson(true), 400)` —— 發布完**自動彈一個
        constitution.json 落載**。嗰個係 v2.5.0 之前「人手上載去公開頁」嘅遺物；
        而家公開頁（constitution.html）係直接由後端讀，根本唔使上載任何檔案。
        淨低個下載淨係令人以為「仲要做啲乜」—— 已經攞走。
     ② 發布只係 commit() 去本機。手動同步之下，改動會一直留喺呢部機，
        公開頁永遠睇唔到新版 —— 正正係「POST 唔到出尼」。
        「發布」本身就係「我要而家出街」嘅明確指令，所以即刻寫後端。 */
  /* 2026-09-20：發布 ＝ 行**同一條**儲存路（saveWithDialog：核對版本 → 三方比對 → 撞就問），
     冇另一條「順便寫後端」嘅路。 */
  const remote = await import('../lib/remote.js').catch(() => null);
  if (remote?.remoteConfigured?.()) {
    toast(`已發布 v${r.version} —— 正在儲存到後端…`, 'ok');
    const { saveWithDialog } = await import('./syncdialog.js');
    const res = await saveWithDialog({ silent: true, toastOk: false });
    toast(res?.ok
      ? `已發布 v${r.version} ✓ 公開閱讀頁同 QR Code 而家已經係新版`
      : `已發布 v${r.version}，但暫時寫唔入後端（${res?.error || '未知'}）—— 撳頂部「儲存到後端」再試`,
      res?.ok ? 'ok' : 'warn');
  } else {
    toast(`已發布 v${r.version}（呢部機未接後端 —— 公開頁要接咗後端先至睇到）`, 'warn');
  }
  refresh();
}

function nextVersion(v) {
  const m = String(v || '1.0').match(/^(\d+)\.(\d+)$/);
  if (!m) return String(v || '1.0');
  return `${m[1]}.${Number(m[2]) + 1}`;
}

/* ============================================================
   輸出
   ============================================================ */
function htmlFor(kind) {
  const c = constitution();
  const p = profile();
  const zhOnly = kind === 'zh', enOnly = kind === 'en';
  const chapterHtml = (c.chapters || []).map(ch => `
    <h2>${esc(ch.heading?.zh || '')}${!enOnly && ch.heading?.en ? ` <span style="font-weight:400;color:#666;font-size:11pt">／ ${esc(ch.heading.en)}</span>` : enOnly ? esc(ch.heading?.en || '') : ''}</h2>
    ${(ch.articles || []).map(a => `
      <p class="art">${enOnly ? '' : esc(a.zh || '')}${!enOnly && !zhOnly && a.en ? `<span class="en"><br>${esc(a.en)}</span>` : zhOnly ? '' : (enOnly ? esc(a.en || '') : '')}</p>
      ${(a.items || []).length ? (a.items || []).map(i => `<p class="art-item ${i.level === 2 ? 'sub' : ''}">
        ${enOnly ? '' : esc(i.zh || '')}${!enOnly && !zhOnly && i.en ? `<span class="en"><br>${esc(i.en)}</span>` : ''}</p>`).join('') : ''}
    `).join('')}`).join('');
  const apxHtml = (c.appendices || []).map(ap => `
    <h2>${esc(ap.heading?.zh || '')}${ap.heading?.en ? ` <span style="font-weight:400;color:#666;font-size:11pt">／ ${esc(ap.heading.en)}</span>` : ''}</h2>
    ${(ap.blocks || []).map(b => `<p>${enOnly ? '' : esc(b.zh || '')}${b.en ? `<span class="en"><br>${esc(b.en)}</span>` : ''}</p>`).join('')}`).join('');

  return `
  <div class="doc-head">
    <div class="doc-org">${esc((c.header?.zh || [])[0] || '')} · ${esc((c.header?.en || [])[0] || '')}</div>
    <div class="doc-title">${esc(c.title?.zh || '團章')} / ${esc(c.title?.en || 'Constitution')}</div>
    <div class="doc-sub">${esc(p.name || '')} · ${esc(p.nameEn || '')}</div>
  </div>
  <div class="doc-meta"><span>版本 v${esc(c.version || '')}</span><span>更新日期 ${esc(c.updated || '')}</span><span>共 ${(c.chapters || []).length} 章</span></div>
  ${c.preamble?.zh ? `<p><b>序言</b></p><p>${esc(c.preamble.zh)}</p>${c.preamble.en ? `<p class="en-block">${esc(c.preamble.en)}</p>` : ''}` : ''}
  ${chapterHtml}
  ${apxHtml}
  <div class="foot"><span>${esc(c.footer?.zh || '')}</span><span>v${esc(c.version || '')} · ${esc(c.updated || '')}</span></div>`;
}

function exportWord() {
  const c = constitution();
  toWord({
    filename: `團章_v${c.version || ''}_${stamp()}.doc`,
    title: '團章',
    org: profile().name,
    bodyHtml: htmlFor('both')
  });
  toast('已輸出 Word（.doc）', 'ok');
}
function exportPdf() {
  const c = constitution();
  const body = htmlFor('both') + `<div class="foot"><span>${esc(profile().name || '')}</span><span>版本 v${esc(c.version || '')}</span><span>${todayISO()}</span></div>`;
  printDoc({ title: '團章', org: profile().name, bodyHtml: body });
  toast('已開啟列印，可另存為 PDF', 'ok');
}
function exportMarkdown() {
  const c = constitution();
  const L = [];
  L.push(`# ${c.title?.zh || '團章'} / ${c.title?.en || 'Constitution'}`, '');
  L.push(`> ${profile().name || ''} · 版本 v${c.version || ''} · 更新 ${c.updated || ''}`, '');
  if (c.preamble?.zh) L.push('## 序言 Preamble', '', c.preamble.zh, '', c.preamble.en || '', '');
  (c.chapters || []).forEach(ch => {
    L.push(`## ${ch.heading?.zh || ''} / ${ch.heading?.en || ''}`, '');
    (ch.articles || []).forEach(a => {
      L.push(`- ${a.zh || ''}`, a.en ? `  - ${a.en}` : '');
      (a.items || []).forEach(i => L.push(`  ${i.level === 2 ? '    ' : '  '}- ${i.zh || ''}${i.en ? ` — ${i.en}` : ''}`));
    });
    L.push('');
  });
  (c.appendices || []).forEach(ap => {
    L.push(`## ${ap.heading?.zh || ''} / ${ap.heading?.en || ''}`, '');
    (ap.blocks || []).forEach(b => L.push(b.zh || '', '', b.en || '', ''));
  });
  L.push('---', '', c.footer?.zh || '', c.footer?.en || '');
  toMarkdown({ filename: `團章_v${c.version || ''}_${stamp()}.md`, md: L.join('\n') });
  toast('已輸出 Markdown', 'ok');
}

/** 單一 HTML：內建語言切換 + 列印，可離線睇、可上載做公開頁 */
function standaloneHtml(cIn = constitution()) {
  const c = cIn;
  const p = profile();
  const chapterHtml = (c.chapters || []).map((ch, i) => `
    <section class="chapter">
      <h2 data-zh="${esc(ch.heading?.zh || '')}" data-en="${esc(ch.heading?.en || '')}">${esc(ch.heading?.zh || '')}</h2>
      ${(ch.articles || []).map(a => `
        <p class="art"><span class="zh">${esc(a.zh || '')}</span><span class="en">${esc(a.en || '')}</span></p>
        ${(a.items || []).map(it => `<p class="art-item ${it.level === 2 ? 'sub' : ''}"><span class="zh">${esc(it.zh || '')}</span><span class="en">${esc(it.en || '')}</span></p>`).join('')}
      `).join('')}
    </section>`).join('');
  const apxHtml = (c.appendices || []).map(ap => `
    <section class="chapter">
      <h2 data-zh="${esc(ap.heading?.zh || '')}" data-en="${esc(ap.heading?.en || '')}">${esc(ap.heading?.zh || '')}</h2>
      ${(ap.blocks || []).map(b => `<p class="art"><span class="zh">${esc(b.zh || '')}</span><span class="en">${esc(b.en || '')}</span></p>`).join('')}
    </section>`).join('');

  return `<!doctype html><html lang="zh-Hant-HK"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name || '')} 團章 v${esc(c.version || '')}</title>
<style>${docCss()}
:root{--maroon:#7B2233}
body{max-width:860px;margin:0 auto;padding:20px 18px 70px;background:#fff}
.toolbar{position:sticky;top:0;background:rgba(255,255,255,.96);backdrop-filter:blur(6px);border-bottom:1px solid #eee;padding:10px 0 12px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;z-index:5}
.toolbar button{font:inherit;padding:7px 13px;border:1px solid #ddc9ce;border-radius:9px;background:#fff;cursor:pointer}
.toolbar button.on{background:var(--maroon);color:#fff;border-color:var(--maroon)}
.toolbar .sp{margin-left:auto;font-size:12px;color:#888}
h2{color:var(--maroon)}
.art{margin-bottom:7px}
.art .en{display:block;color:#555;font-size:10.5pt}
.art-item{margin-left:18px}
.art-item.sub{margin-left:36px}
body.lang-zh .en{display:none} body.lang-en .zh{display:none}
body.lang-both .zh{display:block} body.lang-both .en{display:block}
@media print{.toolbar{display:none} body{padding:0}}
</style></head>
<body class="lang-zh">
<div class="toolbar">
  <button data-lang="zh" class="on">中文</button>
  <button data-lang="en">English</button>
  <button data-lang="both">中英對照</button>
  <button onclick="window.print()">列印 / 存 PDF</button>
  <span class="sp">版本 v${esc(c.version || '')} · 更新 ${esc(c.updated || '')}</span>
</div>
<div class="doc-head">
  <div class="doc-org">${esc((c.header?.zh || [])[0] || '')}</div>
  <div class="doc-title">${esc(c.title?.zh || '團章')} / ${esc(c.title?.en || 'Constitution')}</div>
  <div class="doc-sub">${esc(p.name || '')} · ${esc(p.nameEn || '')}</div>
</div>
${c.preamble?.zh ? `<p><b>序言 Preamble</b></p><p class="art"><span class="zh">${esc(c.preamble.zh)}</span><span class="en">${esc(c.preamble.en || '')}</span></p>` : ''}
${chapterHtml}
${apxHtml}
<div class="foot"><span>${esc(c.footer?.zh || '')}</span><span>${esc(c.footer?.en || '')}</span><span>v${esc(c.version || '')}</span></div>
<script>
document.querySelectorAll('[data-lang]').forEach(function(b){
  b.addEventListener('click',function(){
    var l=b.dataset.lang;
    document.body.className='lang-'+l;
    document.querySelectorAll('[data-lang]').forEach(function(x){x.classList.toggle('on',x===b);});
    document.querySelectorAll('h2[data-zh]').forEach(function(h){
      h.textContent = l==='en' ? (h.dataset.en||h.dataset.zh) : (l==='both' ? (h.dataset.zh||'')+(h.dataset.en?' ／ '+h.dataset.en:'') : (h.dataset.zh||''));
    });
  });
});
<\/script>
</body></html>`;
}

function exportStandalone() {
  const c = constitution();
  dlFile(`${(profile().short || 'unit')}_團章_v${c.version || ''}.html`, standaloneHtml(), 'text/html;charset=utf-8');
  toast('已輸出單一 HTML（可直接上載／離線睇）', 'ok');
}

function exportJson(auto = false) {
  const c = constitution();
  const out = { ...c, unitCode: load().unitCode, exportedAt: new Date().toISOString() };
  const name = `constitution.json`;
  dlFile(name, JSON.stringify(out, null, 2), 'application/json');
  toast(`已下載 ${name}（純備份。發布唔使上載任何檔案 —— 公開頁由後端自動讀最新版）`, 'ok');
}

function publicUrl() {
  const s = settings();
  if (s.publicBaseUrl) {
    return s.publicBaseUrl.includes('{u}')
      ? s.publicBaseUrl.replace('{u}', load().unitCode)
      : s.publicBaseUrl;
  }
  const base = location.href.split('#')[0].replace(/index\.html$/, '');
  return `${base}constitution.html?u=${encodeURIComponent(load().unitCode)}`;
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root) {
  root.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; refresh(); }));
  root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    mode = b.dataset.mode; refresh();
  }));
  const s = root.querySelector('#cSearch');
  if (s) s.addEventListener('input', () => { search = s.value; clearTimeout(s._t); s._t = setTimeout(refresh, 250); });

  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'print' || act === 'exp-pdf') return exportPdf();
    if (act === 'exp-word') return exportWord();
    if (act === 'exp-md') return exportMarkdown();
    if (act === 'exp-html') return exportStandalone();
    if (act === 'exp-json') return exportJson();
    if (act === 'publish') return publish();
    if (act === 'save-url') {
      setSetting({ publicBaseUrl: root.querySelector('#pubUrl').value.trim() });
      toast('已儲存公開網址', 'ok'); refresh(); return;
    }
    if (act === 'copy-link') {
      if (await copyText(publicUrl())) toast('已複製公開連結', 'ok'); else toast('複製失敗', 'err');
      return;
    }
    if (act === 'qr') {
      const url = publicUrl();
      await modal({
        title: '團章 QR Code', sub: '團員掃描即睇（免登入）',
        body: `<div class="center">
            <div class="qr-box" style="width:280px"><div id="qrHost">${qrSvg(url, 7, 2)}</div></div>
            <div class="sm muted mt-12" style="word-break:break-all">${esc(url)}</div>
            <div class="row gap-8 mt-16" style="justify-content:center">
              <button class="btn btn-sm" data-dl-svg>${icon('download', 15)} 下載 SVG</button>
              <button class="btn btn-sm" data-dl-html>${icon('download', 15)} 下載單一 HTML</button>
            </div>
            <div class="hint mt-12">如果 QR 想指向其他網址（例如你上載咗單一 HTML 去自己網站），可以喺右邊改「公開網址」。</div>
          </div>`,
        actions: [{ label: '關閉', class: 'btn', value: null }],
        onMount: el => {
          el.querySelector('[data-dl-svg]')?.addEventListener('click', () => {
            downloadQrSvg(url, `團章QR_v${constitution().version || ''}.svg`, 8, 3);
            toast('已下載 QR SVG', 'ok');
          });
          el.querySelector('[data-dl-html]')?.addEventListener('click', () => exportStandalone());
        }
      });
      return;
    }
    if (act === 'export') {
      await modal({
        title: '輸出團章',
        body: `<div class="col gap-8">
          <button class="btn btn-block" data-exp="word">${icon('download', 16)} Word（.doc）</button>
          <button class="btn btn-block" data-exp="pdf">${icon('print', 16)} PDF / 列印</button>
          <button class="btn btn-block" data-exp="md">${icon('download', 16)} Markdown</button>
          <button class="btn btn-block" data-exp="html">${icon('download', 16)} 單一 HTML（可上載／離線）</button>
          <button class="btn btn-block" data-exp="json">${icon('save', 16)} JSON 備份（唔使上載 —— 公開頁由後端自動讀）</button>
        </div>`,
        actions: [{ label: '關閉', class: 'btn', value: null }],
        onMount: el => {
          el.querySelectorAll('[data-exp]').forEach(x => x.addEventListener('click', async () => {
            const { closeModal } = await import('../lib/util.js');
            closeModal(null);
            const k = x.dataset.exp;
            if (k === 'word') exportWord();
            if (k === 'pdf') exportPdf();
            if (k === 'md') exportMarkdown();
            if (k === 'html') exportStandalone();
            if (k === 'json') exportJson();
          }));
        }
      });
      return;
    }

    if (act === 'edit-meta') return editMeta();
    if (act === 'add-ch') return addChapter();
    if (act === 'add-apx') return addAppendix();
  }));

  root.querySelectorAll('[data-edit-pre]').forEach(b => b.addEventListener('click', () => editMeta()));
  root.querySelectorAll('[data-edit-ch]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.editCh;
    editChapter(id, !!appendixOf(id));
  }));
  root.querySelectorAll('[data-del-ch]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.delCh;
    const isApx = !!appendixOf(id);
    if (await confirmDlg({ title: '刪除' + (isApx ? '附件' : '章節'), danger: true, okText: '確定刪除', message: '刪除後無法復原（可重新匯入發布檔）。' })) {
      const db = load();
      if (isApx) db.constitution.appendices = db.constitution.appendices.filter(a => a.id !== id);
      else db.constitution.chapters = db.constitution.chapters.filter(c => c.id !== id);
      commit(); toast('已刪除', 'ok'); refresh();
    }
  }));
  root.querySelectorAll('[data-add-art]').forEach(b => b.addEventListener('click', () => addArticle(b.dataset.addArt)));
  root.querySelectorAll('[data-edit-art]').forEach(b => b.addEventListener('click', () => editArticle(b.dataset.ch, b.dataset.editArt)));
  root.querySelectorAll('[data-del-art]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除條文', danger: true, okText: '確定刪除', message: '確定刪除此條文？' })) {
      const db = load();
      const ch = db.constitution.chapters.find(c => c.id === b.dataset.ch);
      if (ch) ch.articles = ch.articles.filter(a => a.id !== b.dataset.delArt);
      commit(); toast('已刪除', 'ok'); refresh();
    }
  }));
  root.querySelectorAll('[data-add-item]').forEach(b => b.addEventListener('click', () => addItem(b.dataset.ch, b.dataset.addItem)));
  root.querySelectorAll('[data-edit-item]').forEach(b => b.addEventListener('click', () => editArticle(b.dataset.ch, b.dataset.editItem, b.dataset.item)));
  root.querySelectorAll('[data-del-item]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除子項', danger: true, okText: '確定刪除', message: '確定刪除此子項？' })) {
      const db = load();
      const ch = db.constitution.chapters.find(c => c.id === b.dataset.ch);
      const art = ch?.articles.find(a => a.id === b.dataset.editItem);
      if (art) art.items = (art.items || []).filter(i => i.id !== b.dataset.item);
      commit(); toast('已刪除', 'ok'); refresh();
    }
  }));
  root.querySelectorAll('[data-add-block]').forEach(b => b.addEventListener('click', async () => {
    const apxId = b.dataset.addBlock;
    const r = await modal({ title: '新增段落', wide: true,
      body: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:80px"></textarea></div>
        <div class="field mt-12"><label class="label">English</label><textarea class="textarea" id="q-en" style="min-height:80px"></textarea></div>`,
      actions: [{ label: '取消', class: 'btn', value: null },
        { label: '新增', class: 'btn-primary', onClick: el => ({ zh: el.querySelector('#q-zh').value, en: el.querySelector('#q-en').value }) }] });
    if (!r) return;
    const db = load();
    const apx = db.constitution.appendices.find(a => a.id === apxId);
    apx.blocks = apx.blocks || [];
    apx.blocks.push({ id: uid('b'), ...r });
    commit(); toast('已新增段落', 'ok'); refresh();
  }));
  root.querySelectorAll('[data-edit-block]').forEach(b => b.addEventListener('click', () => editBlock(b.dataset.editBlock, b.dataset.block)));
  root.querySelectorAll('[data-del-block]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除段落', danger: true, okText: '確定刪除', message: '確定刪除此段落？' })) {
      const db = load();
      const apx = db.constitution.appendices.find(a => a.id === b.dataset.editBlock);
      if (apx) apx.blocks = (apx.blocks || []).filter(x => x.id !== b.dataset.block);
      commit(); toast('已刪除', 'ok'); refresh();
    }
  }));
}

/** 公開閱讀頁都係用同一個渲染器 */
export function renderStandalone(c) { return standaloneHtml(c); }

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
