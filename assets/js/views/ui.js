/* ============================================================
   ui.js — 共用介面小元件（page head、tabs、stat、empty、kv）
   ============================================================ */

import { esc, icon, toast } from '../lib/util.js';
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
export function tabs(items, active, attr = 'data-tab') {
  return `<div class="seg mb-16 no-print" role="tablist" data-tabnav>
    ${items.map(([id, label, count]) => `<button role="tab" ${attr}="${id}" aria-selected="${active === id}">
      ${esc(label)}${count !== undefined && count !== null ? ` <span class="faint">${count}</span>` : ''}</button>`).join('')}
  </div>`;
}

export function stat(label, value, sub = '', tone = '') {
  return `<div class="stat ${tone}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value ${tone}">${typeof value === 'string' && value.startsWith('<') ? value : esc(value)}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

export function empty(iconName, title, sub = '', action = '') {
  return `<div class="empty">${icon(iconName, 34)}
    <div class="empty-title">${esc(title)}</div>
    ${sub ? `<div class="sm muted mt-4">${sub}</div>` : ''}
    ${action ? `<div class="mt-16">${action}</div>` : ''}
  </div>`;
}

export function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

export function chipbar(items, active, attr) {
  return `<div class="chipbar no-print">${items.map(([id, label, count]) => `<button class="chip" ${attr}="${id}" aria-pressed="${active === id}">
    ${esc(label)}${count !== undefined && count !== null ? ` <span class="faint">${count}</span>` : ''}</button>`).join('')}</div>`;
}

export function progressBar(rate, tone = '') {
  const t = tone || (rate >= 80 ? '' : rate >= 50 ? 'warn' : 'danger');
  return `<div class="bar ${t}"><span style="width:${Math.max(0, Math.min(100, rate))}%"></span></div>`;
}

export function noteBox(text, tone = 'brand') {
  return `<div class="note-box ${tone}">${icon(tone === 'warn' ? 'alert' : 'shield', 15)}<div>${text}</div></div>`;
}

/* ============================================================
   相片／收據（手機影相）
   ============================================================ */
/**
 * 影相／揀相欄位。用法：
 *   ${photoPicker('c-photos', { label: '收據相片', hint: '…' })}
 * 之後喺 mount 用 bindPhotoPicker(root, '#c-photos', photosArray)
 */
export function photoPicker(id, { label = '相片 / 收據', hint = '', accept = 'image/*', capture = true } = {}) {
  return `<div class="field" data-photo-field="${id}">
    ${label ? `<label class="label">${esc(label)}</label>` : ''}
    <div class="photo-actions">
      ${capture ? `<label class="btn btn-sm btn-primary photo-btn">${icon('camera', 16)} 影相
        <input type="file" id="${id}-cam" accept="${accept}" capture="environment" style="display:none"></label>` : ''}
      <label class="btn btn-sm photo-btn">${icon('upload', 16)} 揀相片
        <input type="file" id="${id}-file" accept="${accept}" multiple style="display:none"></label>
      <button class="btn btn-sm" type="button" id="${id}-clear">${icon('trash', 15)} 清空</button>
      <span class="xs faint" id="${id}-stat"></span>
    </div>
    <div class="photo-grid" id="${id}-grid"></div>
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;
}

/** 相片縮圖牆（只讀） */
export function photoStrip(photos, { prefix = 'receipt', empty = '' } = {}) {
  const list = photos || [];
  if (!list.length) return empty ? `<div class="xs faint">${esc(empty)}</div>` : '';
  return `<div class="photo-grid">${list.map((p, i) => `
    <button type="button" class="photo-thumb" data-photo="${prefix}" data-i="${i}" title="${esc(p.name || '')}">
      <img src="${p.dataUrl}" alt="${esc(p.name || '相片')}" loading="lazy">
    </button>`).join('')}</div>`;
}

/**
 * 綁定 photoPicker：相片會壓縮後放入 state.photos（陣列，可直接存 DB）
 * @param {HTMLElement} root
 * @param {string} id  photoPicker 嘅 id
 * @param {object} state  用 { photos: [] } 形式傳入（會被就地修改）
 */
export function bindPhotoPicker(root, id, state, { max = 6, onChange = null } = {}) {
  const field = root.querySelector(`[data-photo-field="${id}"]`);
  if (!field) return;
  state.photos = state.photos || [];
  const grid = field.querySelector(`#${id}-grid`);
  const stat = field.querySelector(`#${id}-stat`);

  const paint = () => {
    grid.innerHTML = state.photos.map((p, i) => `
      <div class="photo-thumb">
        <img src="${p.dataUrl}" alt="${esc(p.name || '')}" data-view="${i}" loading="lazy">
        <button type="button" class="photo-x" data-del="${i}" aria-label="刪除">${icon('x', 13)}</button>
      </div>`).join('');
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

  field.querySelector(`#${id}-cam`)?.addEventListener('change', e => { handle(e.target.files); e.target.value = ''; });
  field.querySelector(`#${id}-file`)?.addEventListener('change', e => { handle(e.target.files); e.target.value = ''; });
  field.querySelector(`#${id}-clear`)?.addEventListener('click', () => { state.photos = []; paint(); onChange?.(state.photos); });
  paint();
}

/** 儲存用量提示（相片多嘅時候用） */
export function storageBar(db) {
  const u = storageUsage(db);
  const tone = u.percent >= 80 ? 'danger' : u.percent >= 50 ? 'warn' : '';
  return `<div class="storage-bar">
    <div class="row-between xs"><span>瀏覽器儲存用量（大約上限 5 MB）</span>
      <span>${formatBytes(u.total)} / 5 MB${u.photoCount ? `（相片 ${u.photoCount} 張 · ${formatBytes(u.photos)}）` : ''}</span></div>
    <div class="bar ${tone}"><span style="width:${u.percent}%"></span></div>
  </div>`;
}

/* ============================================================
   「邊個睇到」—— 可見範圍選擇器 ／ 標籤
   ------------------------------------------------------------
   ★ 2026-09-24 團長：「權限總表要能編輯，TICK 很直觀，多點一下就變 X」
     可見範圍層級（由最開放到最收緊）：
       對外公開(1) < 團員(2) < 執委(3) < 領袖(4) < 團長(5)
     一項設成 N ＝ 「權限 N 或以上」先見到。
   放喺 ui.js 係因為「公開資料一覽表」同「旅團設定（填嘢位）」都要用。
   ============================================================ */
import { VIS_LEVELS, visName, viewerRank, visOf } from '../lib/public-profile.js';
import { currentRole } from '../lib/auth.js';

/** 下拉：揀「邊個睇到」 */
export function visSelect(name, cur = 'member', extra = '') {
  return `<select class="input input-sm" data-vis="${esc(name)}" ${extra} style="min-width:132px">
    ${VIS_LEVELS.map(v => `<option value="${v.id}"${v.id === visOf({ vis: cur }) ? ' selected' : ''}>${icon(v.icon, 12)} ${esc(v.name)}以上</option>`).join('')}
  </select>`;
}

/** 標籤：呢項而家「邊個睇到」；如果**你自己**都睇唔到會標紅 */
export function visBadge(vis) {
  const v = VIS_LEVELS.find(x => x.id === visOf({ vis })) || VIS_LEVELS[1];
  const blind = v.rank > viewerRank(currentRole());
  return `<span class="badge ${blind ? 'b-danger' : 'b-info'}" title="${esc(v.desc)}">${icon(v.icon, 12)} ${esc(v.name)}以上${blind ? '（你睇唔到）' : ''}</span>`;
}

/** 只讀顯示（免登入公開頁用 —— 嗰度冇 currentRole） */
export function visLabel(vis) {
  return esc(visName(visOf({ vis })) + '以上');
}
