/* ============================================================
   ui.js — 共用介面小元件（page head、tabs、stat、empty、kv）
   ============================================================ */

import { esc, icon, toast, safeImageSrc } from '../lib/util.js';
import { compressImage, formatBytes, storageUsage } from '../lib/files.js';

export function pageHead({ title, sub = '', actions = '', badge = '' }) {
  return `
  <div class="page-head">
    <div>
      <div class="page-title">${esc(title)} ${badge}</div>
      ${sub ? `<div class="page-sub">${esc(sub)}</div>` : ''}
    </div>
    ${actions ? `<div class="row gap-8 wrap no-print">${actions}</div>` : ''}
  </div>`;
}

/* 分頁列。
   個 <div> 有 data-tabnav 做記認 —— main.js 見到就會自動幫粒粒掣綁 click，
   撳親就去 #/<section>/<tab>，所以 view 唔使自己再綁一次（以前成日漏，
   一漏就成頁分頁死晒，撳極冇反應）。
   如果某個 view 想自己控制（例如淨係換 pane、唔想改 hash），
   唔好用呢個 helper，自己砌 <button data-tab> 就得（見 meetings.js）。 */
function safeDataAttr(value, fallback = 'data-tab') {
  const raw = String(value || '');
  return /^data-[a-z][a-z0-9-]*$/i.test(raw) ? raw : fallback;
}
export function tabs(items, active, attr = 'data-tab') {
  const dataAttr = safeDataAttr(attr);
  return `<div class="seg mb-16 no-print" role="tablist" data-tabnav>
    ${items.map(([id, label, count]) => `<button role="tab" ${dataAttr}="${esc(id)}" aria-selected="${esc(active === id)}">
      ${esc(label)}${count !== undefined && count !== null ? ` <span class="faint">${esc(count)}</span>` : ''}</button>`).join('')}
  </div>`;
}

export function stat(label, value, sub = '', tone = '') {
  return `<div class="stat ${esc(tone)}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value ${esc(tone)}">${esc(value)}</div>
    ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

export function empty(iconName, title, sub = '') {
  return `<div class="empty">${icon(iconName, 34)}
    <div class="empty-title">${esc(title)}</div>
    ${sub ? `<div class="sm muted mt-4">${esc(sub)}</div>` : ''}
  </div>`;
}

/** Application-authored action HTML only. Escape every dynamic fragment before passing it here. */
export function emptyWithAction(iconName, title, sub = '', actionHtml = '') {
  return `<div class="empty">${icon(iconName, 34)}
    <div class="empty-title">${esc(title)}</div>
    ${sub ? `<div class="sm muted mt-4">${esc(sub)}</div>` : ''}
    ${actionHtml ? `<div class="mt-16">${actionHtml}</div>` : ''}
  </div>`;
}

export function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

/** Application-authored HTML values only. Escape every dynamic fragment before passing it here. */
export function kvHtml(rows) {
  return `<dl class="kv">${rows.map(([k, valueHtml]) => `<dt>${esc(k)}</dt><dd>${valueHtml}</dd>`).join('')}</dl>`;
}

export function chipbar(items, active, attr) {
  const dataAttr = safeDataAttr(attr, 'data-chip');
  return `<div class="chipbar no-print">${items.map(([id, label, count]) => `<button class="chip" ${dataAttr}="${esc(id)}" aria-pressed="${esc(active === id)}">
    ${esc(label)}${count !== undefined && count !== null ? ` <span class="faint">${esc(count)}</span>` : ''}</button>`).join('')}</div>`;
}

export function boundedPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

export function progressBar(rate, tone = '') {
  const percent = boundedPercent(rate);
  const requestedTone = ['warn', 'danger'].includes(tone) ? tone : '';
  const t = requestedTone || (percent >= 80 ? '' : percent >= 50 ? 'warn' : 'danger');
  return `<div class="bar ${t}"><span style="width:${percent}%"></span></div>`;
}

export function noteBox(text, tone = 'brand') {
  return `<div class="note-box ${esc(tone)}">${icon(tone === 'warn' ? 'alert' : 'shield', 15)}<div>${esc(text)}</div></div>`;
}

/** Application-authored HTML only. Escape every dynamic fragment before passing it here. */
export function noteBoxHtml(html, tone = 'brand') {
  return `<div class="note-box ${esc(tone)}">${icon(tone === 'warn' ? 'alert' : 'shield', 15)}<div>${html}</div></div>`;
}

/* ============================================================
   相片／收據（手機影相）
   ============================================================ */
/**
 * 影相／揀相欄位。用法：
 *   ${photoPicker('c-photos', { label: '收據相片', hint: '…' })}
 * 之後喺 mount 用 bindPhotoPicker(root, 'c-photos', photosArray)
 */
function photoDomId(value) {
  const clean = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return /^[A-Za-z_]/.test(clean) ? clean : `photo_${clean || 'picker'}`;
}
export function photoPicker(id, { label = '相片 / 收據', hint = '', accept = 'image/*', capture = true } = {}) {
  const token = photoDomId(id);
  return `<div class="field" data-photo-field="${esc(token)}">
    ${label ? `<label class="label">${esc(label)}</label>` : ''}
    <div class="photo-actions">
      ${capture ? `<label class="btn btn-sm btn-primary photo-btn">${icon('camera', 16)} 影相
        <input type="file" id="${esc(token)}-cam" accept="${esc(accept)}" capture="environment" style="display:none"></label>` : ''}
      <label class="btn btn-sm photo-btn">${icon('upload', 16)} 揀相片
        <input type="file" id="${esc(token)}-file" accept="${esc(accept)}" multiple style="display:none"></label>
      <button class="btn btn-sm" type="button" id="${esc(token)}-clear">${icon('trash', 15)} 清空</button>
      <span class="xs faint" id="${esc(token)}-stat"></span>
    </div>
    <div class="photo-grid" id="${esc(token)}-grid"></div>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/** 相片縮圖牆（只讀） */
export function photoStrip(photos, { prefix = 'receipt', empty = '' } = {}) {
  const list = (photos || []).map((p, originalIndex) => ({ ...p, originalIndex, safeSrc: safeImageSrc(p?.dataUrl) }))
    .filter(p => p.safeSrc);
  if (!list.length) return empty ? `<div class="xs faint">${esc(empty)}</div>` : '';
  return `<div class="photo-grid">${list.map(p => `
    <button type="button" class="photo-thumb" data-photo="${esc(prefix)}" data-i="${esc(p.originalIndex)}" title="${esc(p.name || '')}">
      <img src="${esc(p.safeSrc)}" alt="${esc(p.name || '相片')}" loading="lazy">
    </button>`).join('')}</div>`;
}

/**
 * 綁定 photoPicker：相片會壓縮後放入 state.photos（陣列，可直接存 DB）
 * @param {HTMLElement} root
 * @param {string} id  photoPicker 嘅 id
 * @param {object} state  用 { photos: [] } 形式傳入（會被就地修改）
 */
export function bindPhotoPicker(root, id, state, { max = 6, onChange = null } = {}) {
  const token = photoDomId(id);
  const field = [...root.querySelectorAll('[data-photo-field]')].find(el => el.dataset.photoField === token);
  if (!field) return;
  state.photos = state.photos || [];
  const grid = field.querySelector(`#${token}-grid`);
  const stat = field.querySelector(`#${token}-stat`);

  const paint = () => {
    grid.innerHTML = state.photos.map((p, i) => {
      const src = safeImageSrc(p?.dataUrl);
      return `<div class="photo-thumb">
        ${src ? `<img src="${esc(src)}" alt="${esc(p.name || '')}" data-view="${esc(i)}" loading="lazy">` : '<span class="xs faint">無效相片</span>'}
        <button type="button" class="photo-x" data-del="${esc(i)}" aria-label="刪除">${icon('x', 13)}</button>
      </div>`;
    }).join('');
    const bytes = state.photos.reduce((a, p) => a + String(p.dataUrl || '').length, 0);
    stat.textContent = state.photos.length ? `${state.photos.length} 張 · ${formatBytes(bytes)}` : '';
    grid.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      state.photos.splice(Number(b.dataset.del), 1); paint(); onChange?.(state.photos);
    }));
    grid.querySelectorAll('[data-view]').forEach(img => img.addEventListener('click', async () => {
      const { photoViewer } = await import('../lib/util.js');
      photoViewer(state.photos, Number(img.dataset.view));
    }));
  };

  const handle = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (state.photos.length + list.length > max) { toast(`最多 ${max} 張`, 'err'); }
    for (const f of list.slice(0, Math.max(0, max - state.photos.length))) {
      try {
        const p = await compressImage(f);
        state.photos.push({ id: 'ph_' + Math.random().toString(36).slice(2, 9), name: p.name, type: p.type, size: p.size, dataUrl: p.dataUrl });
        if (p.unsupported) toast('呢張相格式瀏覽器唔支援壓縮（已原樣保存）', 'warn');
      } catch (e) { toast('讀相失敗：' + e.message, 'err'); }
    }
    paint(); onChange?.(state.photos);
  };

  field.querySelector(`#${token}-cam`)?.addEventListener('change', e => { handle(e.target.files); e.target.value = ''; });
  field.querySelector(`#${token}-file`)?.addEventListener('change', e => { handle(e.target.files); e.target.value = ''; });
  field.querySelector(`#${token}-clear`)?.addEventListener('click', () => { state.photos = []; paint(); onChange?.(state.photos); });
  paint();
}

/** 儲存用量提示（相片多嘅時候用） */
export function storageBar(db) {
  const u = storageUsage(db);
  const percent = boundedPercent(u.percent);
  const tone = percent >= 80 ? 'danger' : percent >= 50 ? 'warn' : '';
  return `<div class="storage-bar">
    <div class="row-between xs"><span>瀏覽器儲存用量（大約上限 5 MB）</span>
      <span>${formatBytes(u.total)} / 5 MB${u.photoCount ? `（相片 ${u.photoCount} 張 · ${formatBytes(u.photos)}）` : ''}</span></div>
    <div class="bar ${tone}"><span style="width:${percent}%"></span></div>
  </div>`;
}

/* ============================================================
   「邊個睇到」—— 可見範圍選擇器 ／ 標籤
   ------------------------------------------------------------
   只列本支部已登入身份；匿名／「對外公開」層已刪除。
   一項設成 N ＝ 該身份及更高身份登入後先見到。
   ============================================================ */
import { VIS_LEVELS, visName, viewerRank, visOf } from '../lib/content-visibility.js';
import { currentRole } from '../lib/auth.js';

/** 下拉：揀「邊個睇到」。第三個參數只接受一個靜態、安全 id；其他屬性一律丟棄。 */
export function visSelect(name, cur = 'member', extra = '') {
  const idMatch = /^\s*id="([A-Za-z][A-Za-z0-9_:.-]{0,79})"\s*$/.exec(String(extra || ''));
  const safeExtra = idMatch ? `id="${esc(idMatch[1])}"` : '';
  return `<select class="input input-sm" data-vis="${esc(name)}" ${safeExtra} style="min-width:132px">
    ${VIS_LEVELS.map(v => `<option value="${esc(v.id)}"${v.id === visOf({ vis: cur }) ? ' selected' : ''}>${icon(v.icon, 12)} ${esc(v.name)}以上</option>`).join('')}
  </select>`;
}

/** 標籤：呢項而家「邊個睇到」；如果**你自己**都睇唔到會標紅 */
export function visBadge(vis) {
  const v = VIS_LEVELS.find(x => x.id === visOf({ vis })) || VIS_LEVELS[0];
  const blind = v.rank > viewerRank(currentRole());
  return `<span class="badge ${blind ? 'b-danger' : 'b-info'}" title="${esc(v.desc)}">${icon(v.icon, 12)} ${esc(v.name)}以上${blind ? '（你睇唔到）' : ''}</span>`;
}

/** 只讀顯示（仍然只代表已登入身份層級） */
export function visLabel(vis) {
  return esc(visName(visOf({ vis })) + '以上');
}
