/* ============================================================
   constitution.js — 團章（內建 · 中英雙語 · 可改 · 可輸出 · QR）
   • 語言：中文 / English / 對照（分頁切換）
   • 編輯：序言、章節、條文、子項，可增刪
   • 發布：版本記錄、輸出 Word / PDF / Markdown / 單一 HTML / JSON
   • QR Code：指向已登入團員入口內的團章路線
   ============================================================ */

import { load, commit, collection, add, update, remove, audit } from '../lib/store.js';
import { constitution, articleCount, profile, memberName, publicPageUrl } from '../lib/model.js';
import { todayISO } from '../lib/dates.js';
import {
  esc, icon, uid, modal, confirmDlg, toast, copyText, fmtDate, nf
} from '../lib/util.js';
import { toWord, printDoc, toMarkdown, qrSvg, downloadQrSvg, download as dlFile, stamp, docCss } from '../lib/exporter.js';
import { go, parse } from '../lib/router.js';
import { can, current, displayName, isSuper } from '../lib/auth.js';
import { pageHead, tabs, empty, noteBoxHtml, kvHtml } from './ui.js';
import { confirmBulkOperation, createSafetySnapshot, undoable } from '../lib/guard.js';

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
        ${LANG_TABS.map(([k, l]) => `<button role="tab" data-lang="${esc(k)}" aria-selected="${esc(lang === k)}">${l}</button>`).join('')}
      </div>
      <div class="seg" role="tablist">
        <button role="tab" data-mode="view" aria-selected="${esc(mode === 'view')}">${icon('eye', 15)} 閱讀</button>
        <button role="tab" data-mode="edit" aria-selected="${esc(mode === 'edit')}" ${can('constitution.edit') ? '' : 'disabled'}>${icon('edit', 15)} 編輯</button>
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
          <button class="btn btn-block" data-act="copy-link">${icon('link', 16)} 複製登入連結</button>
          ${can('constitution.publish') ? `<button class="btn btn-block" data-act="exp-json">${icon('save', 16)} 下載 JSON 備份（純備份用 —— 發布唔使上載任何檔案）</button>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">已登入閱讀</div>
          <div class="card-sub">QR 只帶成員去團員入口；後端核實身份後先回已發布團章</div></div></div>
        <div style="padding:14px 16px">
          <div class="field"><label class="label">團員入口內的團章路線</label>
            <input class="input" id="pubUrl" value="${esc(pubUrl)}" readonly>
            <div class="hint mt-4">未登入者只會見到登入畫面；QR 本身唔係閱讀憑證。</div></div>
          <div class="mt-12 center">
            <div class="qr-box" style="width:150px;margin:0 auto"><div id="pubQr">${qrSvg(pubUrl, 4, 1)}</div></div>
            <div class="xs faint mt-8">掃描 → 登入 → 閱讀已發布團章</div>
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
          <div class="step"><div><div class="sm semibold">等同步存到後端</div><div class="xs muted">右上角「已存到後端」之後，團員入口安全投影即刻顯示新版 —— 唔使人手上載檔案</div></div></div>
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
          <button class="btn btn-xs btn-ghost" data-edit-item="${esc(a.id)}" data-ch="${esc(chId)}" data-item="${esc(i.id)}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-ghost" data-del-item="${esc(a.id)}" data-ch="${esc(chId)}" data-item="${esc(i.id)}">${icon('trash', 12)}</button></span>` : ''}
      </div>`).join('')}</div>` : '');

    return `<div class="art" id="${esc(a.id)}">
      <div class="bi-pair ${lang === 'both' ? '' : 'single'}">
        ${lang !== 'en' ? `<div>${esc(zh)}</div>` : ''}
        ${lang !== 'zh' ? `<div class="bi-en">${esc(en)}</div>` : ''}
      </div>
      ${itemBlock}
      ${editing ? `<div class="row gap-4 no-print mt-4">
        <button class="btn btn-xs" data-edit-art="${esc(a.id)}" data-ch="${esc(chId)}">${icon('edit', 12)} 改條文</button>
        <button class="btn btn-xs" data-del-art="${esc(a.id)}" data-ch="${esc(chId)}">${icon('trash', 12)} 刪除</button>
        <button class="btn btn-xs" data-add-item="${esc(a.id)}" data-ch="${esc(chId)}">${icon('plus', 12)} 加子項</button>
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
          <button class="btn btn-xs btn-ghost" data-edit-ch="${esc(ch.id)}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-ghost" data-add-art="${esc(ch.id)}">${icon('plus', 12)} 加條文</button>
          <button class="btn btn-xs btn-ghost" data-del-ch="${esc(ch.id)}">${icon('trash', 12)}</button>
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
          <button class="btn btn-xs btn-ghost" data-edit-ch="${esc(ap.id)}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-ghost" data-add-block="${esc(ap.id)}">${icon('plus', 12)} 加段落</button>
          <button class="btn btn-xs btn-ghost" data-del-ch="${esc(ap.id)}">${icon('trash', 12)}</button></span>` : ''}
      </h2>
      ${(ap.blocks || []).map(b => `<div class="art">
        <div class="bi-pair ${lang === 'both' ? '' : 'single'}">
          ${lang !== 'en' ? `<div>${esc(b.zh || '')}</div>` : ''}
          ${lang !== 'zh' ? `<div class="bi-en">${esc(b.en || '')}</div>` : ''}
        </div>
        ${editing ? `<div class="row gap-4 no-print mt-4">
          <button class="btn btn-xs" data-edit-block="${esc(ap.id)}" data-block="${esc(b.id)}">${icon('edit', 12)}</button>
          <button class="btn btn-xs" data-del-block="${esc(ap.id)}" data-block="${esc(b.id)}">${icon('trash', 12)}</button></div>` : ''}
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
    <button class="btn btn-sm btn-primary" data-act="import-doc">${icon('upload', 15)} 由 Google Docs／Word 搬入</button>
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
    trustedBodyHtml: `<div class="grid g-2" style="gap:12px">
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
    trustedBodyHtml: `<div class="field"><label class="label">標題（中）</label><input class="input" id="q-zh" value="${esc(ch?.heading?.zh || '')}"></div>
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
    trustedBodyHtml: `<div class="field"><label class="label">中文</label>
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
    trustedBodyHtml: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:80px"></textarea></div>
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
    trustedBodyHtml: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:70px"></textarea></div>
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
    trustedBodyHtml: `<div class="field"><label class="label">標題（中）</label><input class="input" id="q-zh" value="${esc(n)}. "></div>
      <div class="field mt-12"><label class="label">標題（英）</label><input class="input" id="q-en" value="${esc(n)}. "></div>`,
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
    trustedBodyHtml: `<div class="field"><label class="label">標題（中）</label><input class="input" id="q-zh" placeholder="附件 A"></div>
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
    trustedBodyHtml: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:80px">${esc(b?.zh || '')}</textarea></div>
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

function countImported(c) {
  const chapters = (c?.chapters || []).length;
  const articles = (c?.chapters || []).reduce((n, ch) => n + (ch.articles || []).length, 0);
  const items = (c?.chapters || []).reduce((n, ch) => n + (ch.articles || []).reduce((m, a) => m + (a.items || []).length, 0), 0);
  const appendices = (c?.appendices || []).length;
  return { chapters, articles, items, appendices };
}

function freshImportIds(parsed) {
  const copy = JSON.parse(JSON.stringify(parsed));
  (copy.chapters || []).forEach(ch => {
    ch.id = uid('c');
    (ch.articles || []).forEach(a => {
      a.id = uid('a');
      (a.items || []).forEach(i => { i.id = uid('i'); });
    });
  });
  (copy.appendices || []).forEach(ap => {
    ap.id = uid('apx');
    (ap.blocks || []).forEach(b => { b.id = uid('b'); });
  });
  return copy;
}

async function importConstitutionDocument() {
  const { readDocx, textToBlocks, classifyConstitutionBlock, parseConstitutionBlocks, applyConstitutionImport } = await import('../lib/doc-import.js');
  const source = await modal({
    title: '由 Google Docs／Word 搬入團章',
    sub: 'Google Docs：檔案 → 下載 → Microsoft Word (.docx)；亦可以全選複製再貼文字',
    wide: true,
    trustedBodyHtml: `
      <div class="migration-steps mb-12">
        <div class="migration-step"><b>1. 本機讀文件</b><span class="xs muted">只讀文字同標題層級；唔執行巨集、圖片、公式或外部連結。</span></div>
        <div class="migration-step"><b>2. 逐段分類</b><span class="xs muted">每段可以改做標題、章、條、子項、附件或略過。</span></div>
        <div class="migration-step"><b>3. 預覽再合併</b><span class="xs muted">預設附加；取代會顯示詳細 diff、備份同二次確認。</span></div>
      </div>
      <div class="field"><label class="label">Word／文字檔</label>
        <input class="input" type="file" id="doc-file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,text/plain,text/markdown"></div>
      <div class="field mt-12"><label class="label">或者直接貼 Google Docs 文字／Markdown</label>
        <textarea class="textarea" id="doc-text" style="min-height:150px" placeholder="# 團章\n## 第一章 總則\n第一條 …"></textarea></div>
      <div class="grid g-2 mt-12" style="gap:12px">
        <div class="field"><label class="label">來源語言</label><select class="select" id="doc-lang">
          <option value="zh">主要中文</option><option value="en">Mainly English</option><option value="auto">中英混合（按每段字種）</option></select></div>
        <div class="field"><label class="label">自動辨認方法</label><select class="select" id="doc-mode">
          <option value="auto">自動（編號＋標題樣式）</option><option value="styles">優先用 Heading 樣式</option><option value="numbering">只按第 X 章／第 X 條編號</option></select></div>
      </div>`,
    actions: [{ label: '取消', class: 'btn', value: null }, { label: '讀取並逐段對應', class: 'btn-primary', onClick: el => {
      const file = el.querySelector('#doc-file').files?.[0] || null;
      const text = el.querySelector('#doc-text').value.trim();
      if (!file && !text) { el.querySelector('#doc-text').focus(); return false; }
      return { file, text, language: el.querySelector('#doc-lang').value, mode: el.querySelector('#doc-mode').value };
    } }]
  });
  if (!source) return;
  if (source.file && Number(source.file.size || 0) > 12 * 1024 * 1024) return toast('文件大過 12MB；請另存淨文字，或者分開匯入', 'err');

  let blocks;
  try {
    if (source.file && /\.docx$/i.test(source.file.name || '')) blocks = (await readDocx(await source.file.arrayBuffer())).blocks;
    else if (source.file) blocks = textToBlocks(await source.file.text());
    else blocks = textToBlocks(source.text);
  } catch (e) { toast(`讀取文件失敗：${e.message || e}`, 'err'); return; }
  if (!blocks.length) return toast('文件入面搵唔到可讀文字', 'err');
  if (blocks.length > 800) return toast(`文件有 ${blocks.length} 段，為免手機瀏覽器失去反應，請先分成每份 800 段以下再匯入`, 'err');

  const roleLabels = [
    ['title', '團章標題'], ['preamble-heading', '序言標題'], ['chapter', '章節標題'], ['article', '條文'],
    ['item', '條文子項'], ['appendix', '附件標題'], ['paragraph', '普通段落（按上文保留）'], ['ignore', '略過呢段']
  ];
  const initialRoles = blocks.map(b => classifyConstitutionBlock(b, { mode: source.mode }));
  const classified = await modal({
    title: `逐段分類（${blocks.length} 段）`,
    sub: '呢一步只係 mapping；請特別核對章／條／子項。所有未略過文字都會保留。',
    wide: true,
    trustedBodyHtml: `<div class="note-box info mb-12"><div>自動辨認只係建議。你可以逐段改；灰字會顯示 Word 樣式／標題層級。</div></div>
      <div class="bulk-diff scroll-x">${blocks.map((b, i) => `<div class="source-map" style="padding:9px 11px">
        <div class="sm"><b>${i + 1}. ${esc(String(b.text).slice(0, 180))}</b>
          <div class="xs faint">${esc(b.style || '普通段落')}${b.level ? ` · Heading ${esc(b.level)}` : ''}${b.list ? ' · 清單' : ''}</div></div>
        <select class="select" data-doc-role="${esc(i)}">${roleLabels.map(([key, label]) => `<option value="${esc(key)}" ${initialRoles[i] === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
      </div>`).join('')}</div>`,
    actions: [{ label: '返回（唔改資料）', class: 'btn', value: null }, { label: '套用分類並預覽', class: 'btn-primary', onClick: el => ({
      roles: [...el.querySelectorAll('[data-doc-role]')].map(s => s.value)
    }) }]
  });
  if (!classified) return;

  let parsed = parseConstitutionBlocks(blocks, { mode: source.mode, language: source.language, roles: classified.roles });
  parsed = freshImportIds(parsed);
  const incoming = countImported(parsed);
  const currentCounts = countImported(constitution());
  const preview = await modal({
    title: '團章遷移預覽', sub: '仍然未改資料；預設「附加」最安全', wide: true,
    trustedBodyHtml: `<div class="grid g-4">
        <div class="stat"><div class="stat-label">章</div><div class="stat-value">${incoming.chapters}</div></div>
        <div class="stat"><div class="stat-label">條</div><div class="stat-value">${incoming.articles}</div></div>
        <div class="stat"><div class="stat-label">子項</div><div class="stat-value">${incoming.items}</div></div>
        <div class="stat"><div class="stat-label">附件</div><div class="stat-value">${incoming.appendices}</div></div>
      </div>
      <div class="field mt-12"><label class="label">匯入策略</label><select class="select" id="doc-strategy">
        <option value="append">附加到現有團章（預設；保留現有章節）</option>
        <option value="replace">取代現有團章正文（會先建立完整安全快照）</option></select></div>
      ${parsed.warnings.length ? `<div class="note-box warn mt-12"><div><b>要留意：</b><br>${parsed.warnings.slice(0, 20).map(esc).join('<br>')}</div></div>` : ''}
      <div class="scroll-x bulk-diff mt-12"><table class="table table-compact"><thead><tr><th>層級</th><th>內容</th><th class="right">數量</th></tr></thead><tbody>
        ${(parsed.chapters || []).map(ch => `<tr><td>章</td><td><b>${esc(ch.heading?.zh || ch.heading?.en || '（無標題）')}</b><div class="xs faint">${(ch.articles || []).slice(0, 3).map(a => esc(a.zh || a.en || '')).join(' ｜ ')}</div></td><td class="right">${(ch.articles || []).length} 條</td></tr>`).join('')}
        ${(parsed.appendices || []).map(ap => `<tr><td>附件</td><td><b>${esc(ap.heading?.zh || ap.heading?.en || '（無標題）')}</b></td><td class="right">${(ap.blocks || []).length} 段</td></tr>`).join('')}
      </tbody></table></div>`,
    actions: [{ label: '取消（唔改資料）', class: 'btn', value: null }, { label: '進入最後確認', class: 'btn-primary', onClick: el => ({ strategy: el.querySelector('#doc-strategy').value }) }]
  });
  if (!preview) return;

  const replace = preview.strategy === 'replace';
  const afterCounts = replace ? incoming : {
    chapters: currentCounts.chapters + incoming.chapters, articles: currentCounts.articles + incoming.articles,
    items: currentCounts.items + incoming.items, appendices: currentCounts.appendices + incoming.appendices
  };
  const ok = await confirmBulkOperation({
    title: `最後確認：${replace ? '取代' : '附加'}團章`, actionLabel: replace ? '確認取代正文' : '確認附加內容',
    count: parsed.sourceCount, scope: `${profile().name || '現時旅團'}／團章／${replace ? '取代' : '附加'}`,
    requireText: replace ? `取代 ${currentCounts.chapters}` : `確認 ${parsed.sourceCount}`, danger: replace,
    changes: [
      { label: '章', before: currentCounts.chapters, after: afterCounts.chapters },
      { label: '條', before: currentCounts.articles, after: afterCounts.articles },
      { label: '子項', before: currentCounts.items, after: afterCounts.items },
      { label: '附件', before: currentCounts.appendices, after: afterCounts.appendices }
    ],
    preview: (parsed.chapters || []).map(ch => ({ label: ch.heading?.zh || ch.heading?.en || '無標題章節', before: replace ? '現有正文會被取代' : '（附加）', after: `${(ch.articles || []).length} 條` })),
    warnings: replace ? ['取代會更換現有標題、序言、所有章節同附件；版本歷史及其他設定會保留。'] : [],
    backupText: '會先保存完整現有團章（包括正文、附件、版本資料）本機快照。',
    rollbackText: '完成後可即時還原到搬入前嘅完整團章。', readbackText: '會重新讀取章／條／子項／附件數量核對。'
  });
  if (!ok) return;

  const before = JSON.parse(JSON.stringify(load().constitution || constitution()));
  const snapshot = createSafetySnapshot('團章遷移前', before, { kind: 'constitution-import', strategy: preview.strategy, paragraphs: parsed.sourceCount });
  if (!snapshot.ok) return toast(`${snapshot.error}；為安全起見已取消搬入`, 'err');
  const db = load();
  db.constitution = applyConstitutionImport(before, parsed, { strategy: preview.strategy });
  commit();
  const actual = countImported(constitution());
  if (actual.chapters !== afterCounts.chapters || actual.articles !== afterCounts.articles || actual.appendices !== afterCounts.appendices) {
    db.constitution = before; commit();
    toast('搬入後核對唔一致，已自動還原；安全快照仍然保留', 'err'); return;
  }
  mode = 'edit';
  await undoable(`已搬入並核對 ${parsed.sourceCount} 段（仍未儲存到後端）`, () => {
    const currentDb = load(); currentDb.constitution = JSON.parse(JSON.stringify(before)); commit(); refresh();
    toast('已還原搬入前團章', 'ok');
  });
  refresh();
}

/* ============================================================
   發布
   ============================================================ */
async function publish() {
  const c = constitution();
  const guess = nextVersion(c.version);
  const r = await modal({
    title: '發布新版本', sub: '會記錄版本號、日期、修改人同摘要',
    trustedBodyHtml: `<div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">版本號</label><input class="input" id="q-ver" value="${esc(guess)}"></div>
        <div class="field"><label class="label">日期</label><input class="input" id="q-date" value="${esc(todayISO())}"></div>
      </div>
      <div class="field mt-12"><label class="label">修訂摘要</label>
        <input class="input" id="q-note" placeholder="例：修訂第 8 條團費金額、新增附件 B"></div>
      <div class="hint mt-12">「發布」會先更新呢部機嘅版本資料，<b>唔會背景寫後端</b>。核對後請撳頂部「儲存到後端」；成功 readback 後，團員入口同 QR 路線先會顯示新版。</div>`,
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

  /* 發布只係本機版本動作。後端寫入永遠由頂部「儲存到後端」明確觸發；
     呢度唔會暗中 save、唔會因逾時自動重送，亦唔會再彈 JSON 叫人手上載。 */
  toast(`已喺本機發布 v${r.version}；核對後請撳頂部「儲存到後端」，成功後團員入口先更新`, 'ok');
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
    trustedBodyHtml: htmlFor('both')
  });
  toast('已輸出 Word（.doc）', 'ok');
}
function exportPdf() {
  const c = constitution();
  const body = htmlFor('both') + `<div class="foot"><span>${esc(profile().name || '')}</span><span>版本 v${esc(c.version || '')}</span><span>${todayISO()}</span></div>`;
  printDoc({ title: '團章', org: profile().name, trustedBodyHtml: body });
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

/** 單一 HTML：內建語言切換 + 列印，可離線睇、只供離線備份（唔應上載公開） */
function standaloneNonce() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function standaloneHtml(cIn = constitution()) {
  const c = cIn;
  const p = profile();
  const nonce = standaloneNonce();
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data: blob:`;
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
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
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
  <button data-print>列印 / 存 PDF</button>
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
<script nonce="${esc(nonce)}">
document.querySelector('[data-print]').addEventListener('click',function(){window.print();});
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
  toast(`已下載 ${name}（純備份。發布唔使上載任何檔案 —— 團員入口由後端安全投影讀最新版）`, 'ok');
}

function publicUrl() {
  return `${publicPageUrl('members.html', { u: load().unitCode })}#/constitution`;
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
    if (act === 'copy-link') {
      if (await copyText(publicUrl())) toast('已複製登入連結', 'ok'); else toast('複製失敗', 'err');
      return;
    }
    if (act === 'qr') {
      const url = publicUrl();
      await modal({
        title: '團章 QR Code', sub: '團員掃描後要登入',
        trustedBodyHtml: `<div class="center">
            <div class="qr-box" style="width:280px"><div id="qrHost">${qrSvg(url, 7, 2)}</div></div>
            <div class="sm muted mt-12" style="word-break:break-all">${esc(url)}</div>
            <div class="row gap-8 mt-16" style="justify-content:center">
              <button class="btn btn-sm" data-dl-svg>${icon('download', 15)} 下載 SVG</button>
              <button class="btn btn-sm" data-dl-html>${icon('download', 15)} 下載單一 HTML</button>
            </div>
            <div class="hint mt-12">QR 固定指向本團登入入口，唔可以改去匿名頁。</div>
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
        trustedBodyHtml: `<div class="col gap-8">
          <button class="btn btn-block" data-exp="word">${icon('download', 16)} Word（.doc）</button>
          <button class="btn btn-block" data-exp="pdf">${icon('print', 16)} PDF / 列印</button>
          <button class="btn btn-block" data-exp="md">${icon('download', 16)} Markdown</button>
          <button class="btn btn-block" data-exp="html">${icon('download', 16)} 單一 HTML（可上載／離線）</button>
          <button class="btn btn-block" data-exp="json">${icon('save', 16)} JSON 備份（唔使上載 —— 團員入口由後端安全投影讀）</button>
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

    if (act === 'import-doc') return importConstitutionDocument();
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
    if (await confirmDlg({ title: '刪除' + (isApx ? '附件' : '章節'), danger: true, okText: '確定刪除',
      message: `會刪除呢個${isApx ? '附件同全部段落' : '章節、條文同子項'}；系統會先建立安全快照，完成後可以即時還原。` })) {
      const db = load();
      const before = JSON.parse(JSON.stringify(db.constitution));
      const snapshot = createSafetySnapshot(`刪除團章${isApx ? '附件' : '章節'}前`, before, { kind: 'constitution-delete', id });
      if (!snapshot.ok) { toast(`${snapshot.error}；已取消刪除`, 'err'); return; }
      if (isApx) db.constitution.appendices = db.constitution.appendices.filter(a => a.id !== id);
      else db.constitution.chapters = db.constitution.chapters.filter(c => c.id !== id);
      commit();
      await undoable('已刪除；仍未儲存到後端', () => { const d = load(); d.constitution = JSON.parse(JSON.stringify(before)); commit(); refresh(); });
      refresh();
    }
  }));
  root.querySelectorAll('[data-add-art]').forEach(b => b.addEventListener('click', () => addArticle(b.dataset.addArt)));
  root.querySelectorAll('[data-edit-art]').forEach(b => b.addEventListener('click', () => editArticle(b.dataset.ch, b.dataset.editArt)));
  root.querySelectorAll('[data-del-art]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除條文', danger: true, okText: '確定刪除', message: '會連同子項刪除；完成後可以即時還原。' })) {
      const db = load();
      const before = JSON.parse(JSON.stringify(db.constitution));
      const snapshot = createSafetySnapshot('刪除團章條文前', before, { kind: 'constitution-delete-article', id: b.dataset.delArt });
      if (!snapshot.ok) { toast(`${snapshot.error}；已取消刪除`, 'err'); return; }
      const ch = db.constitution.chapters.find(c => c.id === b.dataset.ch);
      if (ch) ch.articles = ch.articles.filter(a => a.id !== b.dataset.delArt);
      commit();
      await undoable('已刪除條文；仍未儲存到後端', () => { const d = load(); d.constitution = JSON.parse(JSON.stringify(before)); commit(); refresh(); });
      refresh();
    }
  }));
  root.querySelectorAll('[data-add-item]').forEach(b => b.addEventListener('click', () => addItem(b.dataset.ch, b.dataset.addItem)));
  root.querySelectorAll('[data-edit-item]').forEach(b => b.addEventListener('click', () => editArticle(b.dataset.ch, b.dataset.editItem, b.dataset.item)));
  root.querySelectorAll('[data-del-item]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除子項', danger: true, okText: '確定刪除', message: '確定刪除此子項？完成後可以即時還原。' })) {
      const db = load();
      const before = JSON.parse(JSON.stringify(db.constitution));
      const snapshot = createSafetySnapshot('刪除團章子項前', before, { kind: 'constitution-delete-item', id: b.dataset.item });
      if (!snapshot.ok) { toast(`${snapshot.error}；已取消刪除`, 'err'); return; }
      const ch = db.constitution.chapters.find(c => c.id === b.dataset.ch);
      const art = ch?.articles.find(a => a.id === b.dataset.editItem);
      if (art) art.items = (art.items || []).filter(i => i.id !== b.dataset.item);
      commit();
      await undoable('已刪除子項；仍未儲存到後端', () => { const d = load(); d.constitution = JSON.parse(JSON.stringify(before)); commit(); refresh(); });
      refresh();
    }
  }));
  root.querySelectorAll('[data-add-block]').forEach(b => b.addEventListener('click', async () => {
    const apxId = b.dataset.addBlock;
    const r = await modal({ title: '新增段落', wide: true,
      trustedBodyHtml: `<div class="field"><label class="label">中文</label><textarea class="textarea" id="q-zh" style="min-height:80px"></textarea></div>
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
    if (await confirmDlg({ title: '刪除段落', danger: true, okText: '確定刪除', message: '確定刪除此段落？完成後可以即時還原。' })) {
      const db = load();
      const before = JSON.parse(JSON.stringify(db.constitution));
      const snapshot = createSafetySnapshot('刪除團章段落前', before, { kind: 'constitution-delete-block', id: b.dataset.block });
      if (!snapshot.ok) { toast(`${snapshot.error}；已取消刪除`, 'err'); return; }
      const apx = db.constitution.appendices.find(a => a.id === b.dataset.editBlock);
      if (apx) apx.blocks = (apx.blocks || []).filter(x => x.id !== b.dataset.block);
      commit();
      await undoable('已刪除段落；仍未儲存到後端', () => { const d = load(); d.constitution = JSON.parse(JSON.stringify(before)); commit(); refresh(); });
      refresh();
    }
  }));
}

/** 管理介面文件渲染器 */
export function renderStandalone(c) { return standaloneHtml(c); }

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
