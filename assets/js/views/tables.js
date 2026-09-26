/* ============================================================
   tables.js — 表格設計 · 插入自己嘅 Google Sheet · 總表同步

   三個概念：
   1) 表格設計：每個資料表（帳目 / 物資 / 團員 / 通告 / 會議）都可以
      改欄位名、加欄位、刪欄位、改類型 —— 好似內建一個 Google Sheet / Excel
   2) 插入自己嘅 Sheet：其他旅團可以貼自己 Sheet 連結，
      系統會讀欄位、同你對應（mapping），再匯入或定期同步
   3) 總表同步：所有內容可以一次過 POST 去你嘅 Apps Script，
      由 Script 寫入後端「總 Sheet」（一張 Sheet 統管整個 Venture）
   ============================================================ */

import { load, commit, commitMeta, collection, add, update, remove, find, getBase } from '../lib/store.js';
import { esc, icon, modal, confirmDlg, toast, uid, nf, todayISO, nowStamp, download, copyText } from '../lib/util.js';
import { toCSV, toWord, download as dlFile, stamp } from '../lib/exporter.js';
import { go, parse, setQuery } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { profile, settings } from '../lib/model.js';
import { remoteConfigured, backendStatus, syncState } from '../lib/remote.js';
import { pageHead, tabs, stat, empty, noteBox, kv, storageBar } from './ui.js';

let tab = 'design';
let mapState = null;        // 自己 Sheet 匯入狀態
let mapSource = null;       // 已載入嘅 sheet 資料

/* ============================================================
   預設表格定義（= app 內建欄位；可以改）
   ============================================================ */
export const DEFAULT_TABLES = {
  transactions: {
    label: '帳目（收支）', icon: 'wallet', collection: 'transactions',
    fields: [
      { key: 'date', label: '日期', type: 'date', required: true, core: true, show: true },
      { key: 'type', label: '類型', type: 'select', options: ['income', 'expense'], optionLabels: ['收入', '支出'], required: true, core: true, show: true },
      { key: 'item', label: '項目', type: 'text', required: true, core: true, show: true },
      { key: 'amount', label: '金額', type: 'number', required: true, core: true, show: true },
      { key: 'category', label: '分類', type: 'select', optionsFrom: 'categories', show: true },
      { key: 'method', label: '收付方式', type: 'select', optionsFrom: 'methods', show: true },
      { key: 'byName', label: '經手人', type: 'text', show: true },
      { key: 'ref', label: '單據號碼', type: 'text', show: true },
      { key: 'period', label: '年度', type: 'text', show: false },
      { key: 'note', label: '備註', type: 'textarea', show: false },
      { key: 'photos', label: '單據相片', type: 'photos', show: false }
    ]
  },
  invItems: {
    label: '物資', icon: 'grid', collection: 'invItems',
    fields: [
      { key: 'code', label: '編號', type: 'text', show: true },
      { key: 'name', label: '名稱', type: 'text', required: true, core: true, show: true },
      { key: 'category', label: '分類', type: 'select', optionsFrom: 'invCategories', show: true },
      { key: 'total', label: '總數量', type: 'number', core: true, show: true },
      { key: 'unit', label: '單位', type: 'text', show: true },
      { key: 'location', label: '存放位置', type: 'text', show: true },
      { key: 'condition', label: '狀況', type: 'select', options: ['良好', '可用', '待修', '損壞'], show: false },
      { key: 'note', label: '備註', type: 'textarea', show: false },
      { key: 'photos', label: '相片', type: 'photos', show: false }
    ]
  },
  invLoans: {
    label: '物資借用', icon: 'clock', collection: 'invLoans',
    fields: [
      { key: 'borrowerName', label: '借用人', type: 'text', required: true, core: true, show: true },
      { key: 'itemName', label: '物資', type: 'text', core: true, show: true },
      { key: 'qty', label: '數量', type: 'number', show: true },
      { key: 'outDate', label: '借用日', type: 'date', show: true },
      { key: 'dueDate', label: '應還日', type: 'date', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['requested', 'approved', 'out', 'returned', 'rejected', 'cancelled'], optionLabels: ['待批核', '已批核', '借出中', '已歸還', '已拒絕', '已取消'], show: true },
      { key: 'note', label: '備註', type: 'textarea', show: false }
    ]
  },
  members: {
    label: '用戶（領袖／執委／團員）', icon: 'users', collection: 'members',
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true, core: true, show: true },
      { key: 'eng', label: '英文名', type: 'text', show: false },
      { key: 'identity', label: '身份', type: 'select', options: ['chief', 'leader', 'exco', 'member'], optionLabels: ['團長', '領袖', '執委', '團員'], core: true, show: true },
      { key: 'birthday', label: '出生日期', type: 'date', core: true, show: true },
      { key: 'role', label: '職位', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['active', 'inactive', 'alumni'], optionLabels: ['現役', '休假', '舊團員'], show: true },
      { key: 'phone', label: '電話', type: 'tel', show: false },
      { key: 'email', label: '電郵', type: 'email', show: false },
      { key: 'join', label: '入團年份', type: 'text', show: false },
      { key: 'ymis', label: '會籍編號（YMIS）', type: 'text', show: true },
      { key: 'systemId', label: '系統 ID', type: 'text', show: false },
      { key: 'note', label: '備註', type: 'textarea', show: false }
    ]
  },
  claims: {
    label: '收支申報', icon: 'note', collection: 'claims',
    fields: [
      { key: 'date', label: '日期', type: 'date', show: true },
      { key: 'type', label: '類型', type: 'select', options: ['income', 'expense'], optionLabels: ['收入', '支出'], show: true },
      { key: 'item', label: '項目', type: 'text', required: true, show: true },
      { key: 'amount', label: '金額', type: 'number', required: true, show: true },
      { key: 'category', label: '分類', type: 'select', optionsFrom: 'categories', show: true },
      { key: 'byName', label: '申報人', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['pending', 'approved', 'rejected'], optionLabels: ['待批核', '已批核', '已拒絕'], show: true },
      { key: 'note', label: '備註', type: 'textarea', show: false },
      { key: 'photos', label: '單據相片', type: 'photos', show: true }
    ]
  },
  notices: {
    label: '通告', icon: 'megaphone', collection: 'notices',
    fields: [
      { key: 'title.zh', label: '標題（中文）', type: 'text', show: true },
      { key: 'title.en', label: 'Title (EN)', type: 'text', show: false },
      { key: 'type', label: '類型', type: 'text', show: true },
      { key: 'eventDate', label: '活動日期', type: 'date', show: true },
      { key: 'deadline', label: '截止日期', type: 'date', show: true },
      { key: 'venue', label: '活動地點', type: 'text', show: true },
      { key: 'assembly', label: '集合時間及地點', type: 'text', show: false },
      { key: 'dismissal', label: '解散時間及地點', type: 'text', show: false },
      { key: 'programme', label: '內容／程序', type: 'text', show: false },
      { key: 'dress', label: '服裝', type: 'text', show: false },
      { key: 'fee', label: '費用', type: 'text', show: true },
      { key: 'quota', label: '名額', type: 'number', show: false },
      { key: 'enquiry', label: '查詢', type: 'text', show: false },
      { key: 'status', label: '狀態', type: 'select', options: ['draft', 'published'], optionLabels: ['草稿', '已發布'], show: true },
      { key: 'body.zh', label: '內容', type: 'textarea', show: false }
    ]
  },
  meetings: {
    label: '會議', icon: 'calendar', collection: 'meetings',
    fields: [
      { key: 'date', label: '日期', type: 'date', show: true },
      { key: 'title', label: '主題', type: 'text', show: true },
      { key: 'venue', label: '地點', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'text', show: true },
      { key: 'note', label: '備註', type: 'textarea', show: false }
    ]
  }
};

const TYPE_LABEL = {
  text: '文字', textarea: '長文字', number: '數字', date: '日期', tel: '電話',
  email: '電郵', select: '下拉選單', photos: '相片', check: '剔選'
};

/* ---------- 取得（已合併自訂）表格定義 ---------- */
export function tableDefs() {
  const custom = load().tableSchema || {};
  const out = {};
  Object.entries(DEFAULT_TABLES).forEach(([k, def]) => {
    out[k] = { ...def, fields: custom[k]?.fields ? JSON.parse(JSON.stringify(custom[k].fields)) : JSON.parse(JSON.stringify(def.fields)) };
    if (custom[k]?.label) out[k].label = custom[k].label;
  });
  // 自訂表格（用戶自己開嘅表）
  Object.entries(custom).forEach(([k, def]) => {
    if (out[k] || !def.custom) return;
    out[k] = { label: def.label || k, icon: 'table', collection: def.collection || k, custom: true, fields: def.fields || [] };
  });
  return out;
}
export function tableDef(key) { return tableDefs()[key]; }

function saveDef(key, fields, label) {
  const db = load();
  db.tableSchema = { ...(db.tableSchema || {}) };
  db.tableSchema[key] = { ...(db.tableSchema[key] || {}), fields, label: label || db.tableSchema[key]?.label };
  commit();
}
function resetDef(key) {
  const db = load();
  if (db.tableSchema?.[key]) { delete db.tableSchema[key]; commit(); }
}

/* ---------- 讀值（支援 title.zh 呢種路徑） ---------- */
export function fieldValue(row, key) {
  if (key.includes('.')) return key.split('.').reduce((o, k) => (o ? o[k] : ''), row);
  return row?.[key];
}
function cellText(row, f) {
  const v = fieldValue(row, f.key);
  if (f.type === 'photos') return (v || []).length ? `${v.length} 張` : '';
  if (Array.isArray(v)) return v.join('、');
  if (f.type === 'select' && f.options && f.optionLabels) {
    const i = f.options.indexOf(v);
    return i >= 0 ? f.optionLabels[i] : (v ?? '');
  }
  if (v === true) return '✓';
  if (v === false) return '';
  return v === undefined || v === null ? '' : String(v);
}

/* ============================================================
   畫面
   ============================================================ */
export function title() { return '表格與同步'; }

/* ============================================================
   欄位設計（可以由**每個分頁**直接打開）
   ------------------------------------------------------------
   2026-09-16 團長要求：唔要一個獨立嘅「表格」分頁，
   而係要喺財務／物資／用戶／通告／會議各自嘅分頁直接改欄位。
   用法：任何元素加 data-fields="transactions"（main.js 有全域委派），
   或者直接呼叫 openFieldDesigner('transactions')。
   ============================================================ */
export function openFieldDesigner(key, { onSaved = null } = {}) {
  const def = tableDefs()[key];
  if (!def) { toast('搵唔到呢個表格', 'err'); return Promise.resolve(false); }
  const edit = can('table.design');
  const fields = JSON.parse(JSON.stringify(def.fields));
  const state = { listEl: null };

  const paint = () => {
    if (!state.listEl) return;
    state.listEl.innerHTML = fields.map((f, i) => fieldRow(f, i, edit)).join('');
    bindRows();
  };
  const save = () => { saveDef(key, fields, def.label); onSaved?.(); };
  const bindRows = () => {
    const list = state.listEl;
    if (!list) return;
    list.querySelectorAll('[data-field]').forEach(row => {
      const i = Number(row.dataset.field);
      row.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.k;
        if (k === 'required') fields[i].required = el.checked;
        else if (k === 'show') fields[i].show = el.checked;
        else if (k === 'options') fields[i].options = String(el.value).split(/[、,，]/).map(x => x.trim()).filter(Boolean);
        else fields[i][k] = el.value;
        save(); paint();
      }));
    });
    list.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.up); if (i <= 0) return;
      [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; save(); paint();
    }));
    list.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.down); if (i >= fields.length - 1) return;
      [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; save(); paint();
    }));
    list.querySelectorAll('[data-delf]').forEach(b => b.addEventListener('click', async () => {
      const i = Number(b.dataset.delf); const f = fields[i];
      if (!(await confirmDlg({ title: '刪除欄位', danger: true, okText: '確定刪除',
        message: `刪除「${esc(f.label)}」？（已存在嘅資料唔會刪，只係唔再顯示）` }))) return;
      fields.splice(i, 1); save(); paint();
    }));
  };

  return modal({
    title: `${def.label} · 欄位`,
    sub: '改欄位名／改類型／加欄位／排次序 —— 只影響顯示同輸入方式，資料唔會唔見',
    wide: true,
    body: `
      <div class="row-between wrap gap-8 mb-12">
        <div class="xs faint">欄位會跟旅團儲存；匯出 JSON 備份會一齊帶走。</div>
        ${edit ? `<div class="row gap-6">
          <button class="btn btn-sm" data-fd="add">${icon('plus', 15)} 加欄位</button>
          <button class="btn btn-sm" data-fd="reset">${icon('refresh', 15)} 還原預設</button>
        </div>` : '<span class="badge b-grey">唯讀（你冇改欄位權限）</span>'}
      </div>
      <div id="fd-list">${fields.map((f, i) => fieldRow(f, i, edit)).join('')}</div>
      <div class="hint mt-12">隱藏嘅欄位唔會刪資料，只係唔顯示；<b>核心</b>欄位唔可以刪。</div>`,
    actions: [{ label: '完成', class: 'btn-primary', value: true }],
    onMount: (el) => {
      state.listEl = el.querySelector('#fd-list');
      bindRows();
      el.querySelectorAll('[data-fd]').forEach(b => b.addEventListener('click', async ev => {
        ev.preventDefault(); ev.stopPropagation();
        const act = b.dataset.fd;
        if (act === 'add') {
          const r = await modal({
            title: '加欄位',
            body: `<div class="grid g-2" style="gap:12px">
              <div class="field"><label class="label">欄位名稱</label><input class="input" id="nf-label" placeholder="例：小隊 / 收據編號"></div>
              <div class="field"><label class="label">類型</label><select class="select" id="nf-type">
                ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
              <div class="field" style="grid-column:1/-1"><label class="label">選項（下拉用，用、分隔）</label>
                <input class="input" id="nf-options" placeholder="例：甲小隊、乙小隊"></div>
            </div>`,
            actions: [{ label: '取消', class: 'btn', value: null },
              { label: '加入', class: 'btn-primary', onClick: m => ({
                label: m.querySelector('#nf-label').value.trim(),
                type: m.querySelector('#nf-type').value,
                options: m.querySelector('#nf-options').value.split(/[、,，]/).map(x => x.trim()).filter(Boolean)
              }) }]
          });
          if (!r || !r.label) return;
          fields.push({ key: 'x' + Math.random().toString(36).slice(2, 7), label: r.label, type: r.type, options: r.options, show: true });
          save(); paint(); toast('已加欄位', 'ok');
        }
        if (act === 'reset') {
          if (!(await confirmDlg({ title: '還原預設欄位', danger: true, okText: '確定還原', message: '會還原成系統預設欄位（資料唔會刪）。' }))) return;
          resetDef(key);
          const fresh = tableDefs()[key].fields;
          fields.splice(0, fields.length, ...JSON.parse(JSON.stringify(fresh)));
          paint(); toast('已還原預設欄位', 'ok');
        }
      }));
    }
  });
}

/* ★ 2026-09-24 團長：「總表同步／表格與同步 太複雜」「我設定好他們就用，統一化前端會更好」
   → 呢一頁而家淨係三樣嘢（同「系統 → 資料管理」一樣）：
        ① 插入自己嘅 Sheet　② 總表同步　③ 儲存與備份
   逐個表嘅欄位設計已經搬去各自嘅分頁（財務／用戶／物資／通告／會議 都有「欄位」掣），
   呢度唔再重複列一次 —— 少咗十幾個分頁，就少咗十幾個撳錯嘅機會。 */
const DATA_TABS = [['sync', '總表同步'], ['source', '插入自己嘅 Sheet'], ['data', '儲存與備份']];

export function render(params) {
  if (params.id && DATA_TABS.some(([k]) => k === params.id)) tab = params.id;
  else if (!DATA_TABS.some(([k]) => k === tab)) tab = 'sync';

  return `
  ${pageHead({
    title: '資料管理',
    sub: '三樣嘢：總表同步、插入自己嘅 Sheet、儲存與備份',
    actions: `<button class="btn btn-sm" data-go="#/admin/data">${icon('chevronL', 15)} 返回系統</button>`
  })}

  ${tabs(DATA_TABS, tab)}

  ${tab === 'source' ? sourceView()
    : tab === 'sync' ? syncView()
    : dataView()}`;
}
/* ============================================================
   1. 表格設計
   ============================================================ */
function designView(key, def) {
  const edit = can('table.design');
  const db = load();
  const rows = db[def.collection] || [];
  const shown = def.fields.filter(f => f.show !== false);

  return `
  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">${esc(def.label)} · 欄位</div>
          <div class="card-sub">改欄位名／加欄位／改類型 —— 只影響顯示同輸入方式，資料唔會唔見</div></div>
          ${edit ? `<div class="row gap-6">
            <button class="btn btn-sm" data-act="add-field">${icon('plus', 15)} 加欄位</button>
            <button class="btn btn-sm" data-act="reset-fields">${icon('refresh', 15)} 還原預設</button>
          </div>` : ''}</div>
        <div style="padding:14px 18px" id="field-list">
          ${def.fields.map((f, i) => fieldRow(f, i, edit)).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">預覽（${rows.length} 筆）</div>
          <div class="card-sub">你設定嘅欄位會咁樣顯示</div></div>
          <div class="row gap-6">
            <button class="btn btn-sm" data-act="exp-table-csv">${icon('download', 15)} CSV</button>
            <button class="btn btn-sm" data-act="exp-table-word">${icon('download', 15)} Word</button>
          </div></div>
        ${rows.length ? `<div class="scroll-x"><table class="table table-compact">
          <thead><tr>${shown.map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, 12).map(r => `<tr>${shown.map(f => `<td class="sm">${esc(cellText(r, f))}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>${rows.length > 12 ? `<div class="hint" style="padding:8px 16px">（只顯示頭 12 筆）</div>` : ''}`
          : empty('table', '未有資料', '呢個表仲未有紀錄')}
      </div>
    </div>

    <div class="col gap-16">
      <div class="card"><div class="card-head"><div class="card-title">點用</div></div>
        <div style="padding:14px 18px" class="sm muted">
          <ul style="padding-left:18px;line-height:1.85">
            <li><b>改名</b>：例如「經手人」改成「負責人」，全 app 顯示都會跟</li>
            <li><b>加欄位</b>：自己開新欄（例：收據編號、小隊）</li>
            <li><b>隱藏</b>：唔用嘅欄位可以收埋，唔會刪資料</li>
            <li><b>還原</b>：隨時可以還原成預設</li>
          </ul>
          ${noteBox('欄位設計會跟旅團儲存（匯出 JSON 備份會一齊帶走）。', 'info')}
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">其他旅團可以用自己嘅 Sheet</div></div>
        <div style="padding:14px 18px" class="sm muted">
          貼上自己嘅 Google Sheet 連結（要有 <code>gid=</code>，設定為「知道連結嘅人都可以檢視」），
          系統會讀欄位、幫你對應，之後可以隨時再同步。
          <div class="mt-12"><button class="btn btn-sm btn-block" data-go="#/tables/source">${icon('link', 15)} 插入自己嘅 Sheet</button></div>
        </div>
      </div>
    </div>
  </div>`;
}

function fieldRow(f, i, edit) {
  return `<div class="schema-row" data-field="${i}">
    <input class="input" data-k="label" value="${esc(f.label || '')}" placeholder="欄位名稱" ${edit ? '' : 'disabled'} style="padding:7px 10px">
    <select class="select" data-k="type" ${edit ? '' : 'disabled'} style="padding:7px 10px">
      ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select>
    <div class="row gap-8 wrap">
      <input class="input" data-k="options" value="${esc((f.options || []).join('、'))}" placeholder="選項（用、分隔）"
        ${edit ? '' : 'disabled'} style="padding:7px 10px;${f.type === 'select' ? '' : 'display:none'}">
      <label class="check xs"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''} ${edit ? '' : 'disabled'}> 必填</label>
      <label class="check xs"><input type="checkbox" data-k="show" ${f.show === false ? '' : 'checked'} ${edit ? '' : 'disabled'}> 顯示</label>
      ${f.core ? '<span class="badge b-grey xs">核心</span>' : ''}
    </div>
    <div class="row gap-4">
      ${edit ? `<button class="btn btn-xs btn-ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-xs btn-ghost" data-down="${i}" ${i === 0 ? 'disabled' : ''}>↓</button>
        ${f.core ? '' : `<button class="btn btn-xs btn-ghost" data-delf="${i}">${icon('trash', 12)}</button>`}` : '<span class="xs faint">唯讀</span>'}
    </div>
  </div>`;
}

/* ============================================================
   2. 插入自己嘅 Sheet
   ============================================================ */
function sourceView() {
  const sources = load().tableSources || [];
  return `
  <div class="note-box mb-16">${icon('link', 15)}<div>
    其他旅團已經有自己嘅 Google Sheet 都唔怕：貼上連結 → 系統讀欄位 → 你話邊欄對應本系統邊個欄位 → 匯入或定時同步。
    <br><span class="xs">Sheet 要設定分享權限：<b>知道連結嘅任何人均可檢視</b>（因為係公開讀取；只會讀，唔會改你嘅表）。</span>
  </div></div>

  <div class="grid g-2-1">
    <div class="card"><div class="card-head"><div><div class="card-title">1. 貼上你嘅 Sheet 連結</div>
      <div class="card-sub">支援 Google Sheet / 任何 CSV 網址</div></div></div>
      <div style="padding:16px 18px">
        <div class="field"><label class="label">Sheet 網址</label>
          <input class="input" id="s-url" placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=123456#gid=123456"></div>
        <div class="grid g-2 mt-12" style="gap:12px">
          <div class="field"><label class="label">匯入到</label>
            <select class="select" id="s-target">
              ${Object.entries(tableDefs()).map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join('')}
            </select></div>
          <div class="field"><label class="label">工作表（分頁）名稱／gid</label>
            <input class="input" id="s-gid" placeholder="可留空（用連結內嘅 gid）"></div>
        </div>
        <div class="row gap-8 mt-12 wrap">
          <button class="btn btn-primary" data-act="load-sheet">${icon('download', 16)} 讀取欄位</button>
          <button class="btn" data-act="paste-csv">${icon('copy', 16)} 改為貼上 CSV</button>
        </div>
        <div id="sheet-preview" class="mt-16"></div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card"><div class="card-head"><div class="card-title">已儲存嘅來源</div></div>
        <div style="padding:8px 0">
          ${sources.length ? sources.map((s, i) => `
            <div class="list-item">
              <span class="stat-ic">${icon(s.kind === 'csv' ? 'note' : 'link', 15)}</span>
              <div class="li-main">
                <div class="li-t">${esc(tableDefs()[s.target]?.label || s.target)}</div>
                <div class="li-s" style="word-break:break-all">${esc(s.kind === 'csv' ? '（貼上嘅 CSV）' : (s.url || '').slice(0, 70))}</div>
              </div>
              <div class="row gap-4">
                <button class="btn btn-xs" data-reload="${i}">同步</button>
                <button class="btn btn-xs btn-ghost" data-delsrc="${i}">${icon('trash', 12)}</button>
              </div>
            </div>`).join('') : '<div style="padding:16px" class="sm faint">未加入任何來源</div>'}
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">對應唔到會點？</div></div>
        <div style="padding:14px 18px" class="sm muted">
          匯入前一定會有<b>對應表</b>同<b>預覽</b>：你話邊欄入邊欄，唔對應就唔會入。
          同名欄位會自動對好（例如「日期」「金額」「項目」「負責人」）。
          <div class="hint mt-8">如果對方嘅表同本系統完全唔同（例如一張「活動報名表」），
            你可以先「加自訂表」再當佢係獨立表格用。</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   3. 總表同步（Apps Script → 後端總 Sheet）
   ============================================================ */
function shortUrl(u) {
  if (!u) return '';
  return String(u).replace('https://script.google.com/macros/s/', '…/s/').slice(0, 46) + (String(u).length > 60 ? '…' : '');
}
function syncView() {
  const s = load().sync || {};
  const backend = load().backend || null;
  /* 「有冇接後端」唔可以再淨係睇 db.backend —— 佢只喺**前端** Registry 有 gasUrl
     嗰陣先會 set，而平台用 Vercel 環境變數登記嘅旅團（正路做法）永遠唔會有。
     結果：個頁話「未設定後端」，連「儲存到後端」「由後端還原資料」
     「睇後端有咩資料」「體積檢查」全部一齊收埋 —— 用家根本撳唔到
     文件叫佢撳嘅嗰啲掣（2026-09-19 團長回報「有嘢把解決方法封死」）。
     而家改用 remoteConfigured()（有同源代理＋旅團編號就算接得通）。 */
  const route = backendStatus();
  /* Vercel Registry／登入成功後嘅實際接線都係後端，唔可以因為本機冇填
     s.url 就畫成「未設定後端」。/exec＋API Key 只係純靜態部署嘅後備。 */
  const wired = !!backend || route.configured || route.verified;
  const log = s.log || [];
  const pending = Number(s.pending || 0);
  const lastPush = s.lastPushAt ? String(s.lastPushAt).slice(0, 19).replace('T', ' ') : '';
  const lastPull = s.lastPullAt ? String(s.lastPullAt).slice(0, 19).replace('T', ' ') : '';
  const base = getBase();
  const pendAcc = (s.pendingAccounts || 0);
  const baseAt = base?.at ? String(base.at).slice(0, 19).replace('T', ' ') : '';
  const baseVer = base ? (base.empty ? '（後端仲係空）' : String(base.version || '').slice(0, 19).replace('T', ' ')) : '';
  return `
  <div class="card mb-16"><div class="card-head">
    <div><div class="card-title">${icon('megaphone', 15)} 求救（回報問題）</div>
      <div class="card-sub">有咩大問題，直接 SEND 去問 ADMIN（當回報問題處理）</div></div>
  </div>
  <div style="padding:12px 16px" class="sm muted">
    錯手搞亂咗、個數據睇唔明、粒掣唔知點排…… 撳一下，寫兩句就送畀平台 ADMIN；
    佢收到會登記做問題回報，再轉寄去你 EMAIL 跟進。
    <div class="row gap-8 mt-12 wrap">
      <button class="btn" data-act="sos">${icon('megaphone', 15)} 求救 —— 回報問題畀 ADMIN</button>
    </div>
  </div></div>

  <div class="note-box mb-16">${icon('cloud', 15)}<div>
    <b>資料真正嘅家係你自己嘅 Google Sheet。寫入後端只有一條路：頂部嗰粒「儲存到後端」。</b>
    ① 登入嗰陣由後端攞成份資料（＝登入嗰一刻嘅後端，做基準）→
    ② 之後<b>任何改動都只係寫入呢部機</b>（頂部會顯示「N 項未寫入」）→
    ③ 撳頂部「<b>儲存到後端</b>」先至真正送出。送出前一定先核對後端版本，
    有人喺你登入後儲存過就<b>逐格</b>比對 —— 改同一格同一個值＝冇問題；改唔同嘅格＝一齊儲存；
    同一格唔同值（例如一個登記早走、一個登記遲到）＝嗰格<b>唔會</b>寫入，
    會列出嚟等你再確認，確認咗先蓋過去。<br>
    <span class="xs">「<b>重新載入</b>」＝由後端拉最新嗰份。另一個視窗改咗嘢會自動併入呢邊，唔使重新整理。<br>
    ${pendAcc ? `<b style="color:var(--danger)">⚠ 有 ${pendAcc} 個帳戶改動未寫入後端 —— 未撳頂部掣之前，佢哋喺其他裝置登唔到。</b><br>` : ''}
    其他分頁（帳目／團員／物資…）係攤平出嚟畀你自己睇同用公式嘅「報表」。
    同一個後端仲會處理 <b>成員手機記帳</b>（entry.html）同 <b>通告報名</b>（notice.html）。</span>
  </div></div>

  ${wired ? `<div class="card mb-16"><div class="card-head">
    <div><div class="card-title">${icon('shield', 15)} 儲存狀態</div>
      <div class="card-sub">資料有冇真係入咗後端</div></div>
    ${pending ? `<span class="badge ${pendAcc ? 'b-danger' : 'b-warn'}"><span class="dot"></span>${pending} 項改動未寫入後端${pendAcc ? `（包括 ${pendAcc} 個帳戶）` : ''}</span>`
      : `<span class="badge b-ok"><span class="dot"></span>全部已儲存</span>`}
  </div>
  <div style="padding:12px 16px" class="sm muted">
    <div class="kv-row"><span>登入時攞到嘅後端版本（基準）</span><span>${esc(baseVer ? `${baseVer}${baseAt ? `，攞於 ${baseAt}` : ''}` : '（未由後端載入過）')}</span></div>
    <div class="kv-row"><span>最後寫入後端</span><span>${esc(lastPush || '（未試過）')}</span></div>
    <div class="kv-row"><span>最後由後端讀取</span><span>${esc(lastPull || '（未試過）')}</span></div>
    ${s.lastError ? `<div class="kv-row"><span>上次狀態</span><span style="color:var(--danger)">${route.serverManaged ? '上次操作未完成，請稍後再試' : esc(String(s.lastError).slice(0, 120))}</span></div>` : ''}
    ${!route.serverManaged && /API ?Key|未授權/i.test(String(s.lastError || '')) ? `
    <div class="note-box err mt-8">${icon('alert', 15)}<div>
      <b>寫唔入係因為 API Key 未入伺服器端。</b>後端行過 <code>initializeSheets</code> 之後會自動生成一條 API Key，
      但平台伺服器端未有，所以後端拒絕寫入。<br>
      <b>正確做法係交畀平台管理員設定，唔係喺呢度打條 key：</b>
      喺 Apps Script 執行 <code>showApiKey()</code> 攞條 key → 喺 Vercel 加環境變數
      <code>TROOP_${esc(load().unitCode || '編號')}_APIKEY</code>（同埋確認
      <code>TROOP_${esc(load().unitCode || '編號')}_BACKEND</code> 係你個 <code>/exec</code>）→ 重新部署。
      咁條 key 淨係留喺伺服器端，瀏覽器完全唔會見到。
    </div></div>` : ''}
    <div class="note-box mt-12">${icon('alert', 15)}<div class="sm">
      <b>冇自動寫入。</b>改動一律先留喺呢部機，要撳<b>頂部「儲存到後端」</b>先至送出 ——
      全系統得呢一條寫入路，唔會有第二個地方偷偷地寫。
    </div></div>
    <div class="row gap-8 mt-12 wrap">
      <button class="btn btn-primary" data-act="push-db">${icon('cloud', 15)} 儲存到後端${pending ? `（${pending}）` : ''}</button>
      <button class="btn" data-act="pull-db">${icon('download', 15)} 由後端重新載入${pending ? '（會丟棄未儲存改動）' : ''}</button>
    </div>
    <div class="hint mt-8">「由後端重新載入」會<b>用後端嘅資料覆蓋呢部機</b>（換咗新手機／清咗 cache，或者想放棄未儲存嘅改動先用）。</div>
  </div></div>` : `
  <div class="note-box danger mb-16">${icon('alert', 15)}<div>
    <b>未有可用嘅後端接線。</b>
    你而家嘅資料淨係存喺呢部機嘅瀏覽器；清 cache／換手機可能會冇咗。
    試下：確認選中嘅旅團已經喺 Vercel 登記
    <code>TROOP_${esc(load().unitCode || '編號')}_BACKEND</code>／<code>_APIKEY</code>，再 Redeploy。
    儲存好設定之後，頂部「儲存到後端」就會用得。
  </div></div>`}

  ${(() => {
    /* 開機問唔到後端 —— 直接喺頁頂講清楚。
       最常見就係平台伺服器端未登記呢個旅團。 */
    const st = syncState();
    if (st.state !== 'unreachable') return '';
    if (route.serverManaged) {
      return `<div class="note-box danger mb-16">${icon('alert', 15)}<div>
        <b>暫時未能連線，請稍後再試。</b>
        <div class="xs mt-4">未儲存嘅改動仍然留喺呢部機，連線恢復後可以再儲存。</div>
      </div></div>`;
    }
    return `<div class="note-box danger mb-16">${icon('alert', 15)}<div>
      <b>而家連唔到旅團後端</b> —— 你嘅改動暫時淨係存喺呢部機嘅瀏覽器。
      <div class="xs mt-4">原因：<code>${esc(st.msg || '未知')}</code></div>
      <div class="xs mt-4">暫時未能連線，請稍後再試。</div>
    </div></div>`;
  })()}

  ${!route.serverManaged && backend ? `<div class="card mb-16"><div class="card-head">
    <div><div class="card-title">${icon('check', 15)} 後端已連接${backend.shared ? '（跟 Registry 共用）' : '（本旅團專用）'}</div>
      <div class="card-sub">${esc(backend.name)}${backend.updated ? ` · 更新 ${esc(backend.updated)}` : ''}</div></div>
    <span class="badge b-ok"><span class="dot"></span>已設定 Apps Script</span>
  </div>
  <div style="padding:12px 16px" class="sm muted">
    <div class="kv-row"><span>總表同步</span><code>${esc(shortUrl(backend.gasUrl))}</code></div>
    <div class="kv-row"><span>手機記帳送出</span><code>${esc(shortUrl(load().settings?.publicEntry?.submitUrl || '')) || '（未設定）'}</code></div>
    <div class="kv-row"><span>通告報名送出</span><code>${esc(shortUrl(load().settings?.notice?.submitUrl || '')) || '（未設定）'}</code></div>
  </div></div>` : (!route.serverManaged && wired ? `<div class="card mb-16"><div class="card-head">
    <div><div class="card-title">${icon('cloud', 15)} 後端接線方式</div>
      <div class="card-sub">呢個旅團經平台伺服器端接線（唔使喺瀏覽器打 Key）${route.verified ? ' · 登入／載入已實際核對成功' : ''}</div></div>
    <span class="badge ${route.verified ? 'b-ok' : 'b-info'}"><span class="dot"></span>${route.verified ? '已核對 · /api/proxy' : '經 /api/proxy'}</span>
  </div>
  <div style="padding:12px 16px" class="sm muted">
    平台用 Vercel 環境變數 <code>TROOP_${esc(load().unitCode || '編號')}_BACKEND</code>／
    <code>_APIKEY</code> 幫你接線 —— 條 Key 留喺伺服器，瀏覽器完全唔會見到，呢個係正路。
    <b>所以你唔需要再喺「同步設定」重複填 /exec 同 API Key。</b><br>
    <span class="xs">下面兩格只係純靜態部署（冇 <code>/api/proxy</code>）嘅後備路線；留空係正確。</span>
  </div></div>` : '')}

  <details class="mt-16" ${route.serverManaged ? 'style="display:none"' : ''}>
    <summary class="btn btn-xs">管理員／後備設定（一般不用）</summary>
  <div class="grid g-2-1 mt-8">
    <div class="card"><div class="card-head"><div><div class="card-title">自助後備設定 <span class="badge b-info xs">Vercel 接線時不用填</span></div>
      <div class="card-sub">只有純靜態部署冇 <code>/api/proxy</code> 時，先需要 Apps Script Web App 網址</div></div></div>
      <div style="padding:16px 18px">
        <div class="field"><label class="label">Apps Script 網址（/exec）</label>
          <input class="input" id="y-url" value="${esc(s.url || '')}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="grid g-2 mt-12" style="gap:12px">
          <div class="field"><label class="label">旅團編號</label>
            <input class="input" id="y-unit" value="${esc(s.unit || load().unitCode)}"></div>
          <div class="field"><label class="label">API Key <span class="faint">（通常唔使填）</span></label>
            <input class="input" id="y-key" value="${esc(s.apiKey || '')}" placeholder="由伺服器端提供"></div>
        </div>
        <div class="hint mt-6">
          ${icon('shield', 14)} API Key 同 <code>/exec</code> 正路係由平台管理員入喺
          <b>Vercel 環境變數</b>（<code>TROOP_${esc(load().unitCode || '編號')}_APIKEY</code> /
          <code>TROOP_${esc(load().unitCode || '編號')}_BACKEND</code>），由伺服器端注入，
          瀏覽器唔會見到。上面兩格<b>淨係</b>喺純靜態部署（冇 <code>/api/proxy</code>，例如 GitHub Pages）先需要填。
        </div>
        <div class="note-box info mt-12">${icon('shield', 15)}<div>
          <b>儲存方式：得一個，冇得揀</b><br>
          登入攞後端 → 改動暫存喺呢部機 → 撳頂部「<b>儲存到後端（N）</b>」先寫入。
          寫入之前先核對後端版本；有人喺你之後儲存過就逐格比對，撞嘅格會問你先。<br>
          <span class="faint">冇自動儲存、冇背景讀取、冇關視窗自動寫、冇「同步全部順便寫」——
          所以唔會再出現「兩部機互相蓋走對方資料」。</span>
        </div></div>
        ${pending ? `<div class="hint" style="color:var(--warn)">有 <b>${pending}</b> 次改動仲未寫入後端。</div>` : ''}
        <label class="check mt-6"><input type="checkbox" id="y-share" ${(load().settings?.publicEntry?.submitUrl || load().settings?.notice?.submitUrl) === s.url ? 'checked' : ''}> <b>同一條網址共用</b>畀「手機記帳」同「通告報名」</label>
        <div class="row gap-8 mt-12 wrap">
          <button class="btn btn-primary" data-act="save-sync">${icon('save', 16)} 儲存設定</button>
          <button class="btn" data-act="push-sync">${icon('table', 16)} 更新報表分頁</button>
        </div>
        <div class="hint mt-8">未設定網址都用得：所有資料仍然喺瀏覽器，可隨時匯出 CSV／JSON 手動上載去總表。</div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card"><div class="card-head"><div class="card-title">後端 Apps Script 範本</div></div>
        <div style="padding:14px 18px" class="sm muted">
          下載 <code>Code.gs</code> → 喺你嘅試算表「擴充功能 → Apps Script」貼上 → 部署為網頁應用程式（執行身分：我；存取權：任何人）。
          <div class="note-box warn mt-12"><div class="xs">
            <b>已經更新過都係「儲存唔到去後端／後端讀取唔到」？</b>
            好可能係舊版（v2.6.1 之前）留低咗一堆分件暫存垃圾行喺「資料庫」分頁 —— 每次大資料庫儲存都多留成份資料庫嘅複製品，
            分頁越嚟越大，最後讀寫一齊撞 Apps Script 執行時間上限。
            <br>救法：貼新版 <code>Code.gs</code> → 部署（版本揀「新版本」）→ 喺 Apps Script 編輯器揀 <code>cleanStaleStaging</code> 撳「執行」一次。
          </div></div>
          <div class="col gap-6 mt-12">
            <button class="btn btn-sm btn-block" data-act="dl-gas">${icon('download', 15)} 下載 Code.gs（Apps Script）</button>
            <button class="btn btn-sm btn-block" data-act="copy-gas">${icon('copy', 15)} 複製 Code.gs 原始碼</button>
            <button class="btn btn-sm btn-block" data-act="dl-schema">${icon('download', 15)} 下載欄位對應表（CSV）</button>
            <button class="btn btn-sm btn-block" data-act="copy-guide">${icon('copy', 15)} 複製部署步驟</button>
          </div>
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">同步紀錄</div></div>
        <div style="padding:14px 18px">
          ${log.length ? `<div class="sync-log">${log.slice(-12).reverse().map(l => `[${esc(l.at)}] ${esc(l.msg)}`).join('<br>')}</div>`
            : '<div class="sm faint">未有同步紀錄</div>'}
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">資料統計</div></div>
        <div style="padding:14px 18px">
          ${kv(Object.entries(tableDefs()).map(([k, d]) => [d.label, `${(load()[d.collection] || []).length} 筆`]))}
        </div>
      </div>
    </div>
  </div>

  <div class="card mt-16"><div class="card-head"><div><div class="card-title">送出格式（Payload）</div>
    <div class="card-sub">Apps Script 收到嘅 JSON 就係咁樣</div></div></div>
    <div style="padding:14px 18px">
      <pre class="code">${esc(JSON.stringify(payloadSample(), null, 2))}</pre>
    </div>
  </div>
  </details>`;
}

function payloadSample() {
  const db = load();
  return {
    action: 'sync',
    unit: db.unitCode,
    unitName: db.profile?.name || db.unit?.name || '',
    at: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(tableDefs()).map(([k, d]) => [d.collection, (db[d.collection] || []).length])),
    tables: Object.fromEntries(Object.entries(tableDefs()).map(([k, d]) => [d.collection, (db[d.collection] || []).slice(0, 2)])),
    schema: Object.fromEntries(Object.entries(tableDefs()).map(([k, d]) => [k, d.fields.map(f => f.label)]))
  };
}

/* ============================================================
   4. 儲存與備份
   ============================================================ */
function dataView() {
  return `
  <div class="grid g-2">
    <div class="card"><div class="card-head"><div><div class="card-title">瀏覽器儲存</div>
      <div class="card-sub">相片最佔位；可以喺下面壓縮、清理或匯出</div></div></div>
      <div style="padding:16px 18px">
        ${storageBar(load())}
        <div class="col gap-8 mt-12">
          <button class="btn btn-sm btn-block" data-act="strip-photos">${icon('trash', 15)} 清理已入帳嘅相片（保留記錄）</button>
          <button class="btn btn-sm btn-block" data-go="#/admin/data">${icon('shield', 15)} 去「資料管理」備份／還原</button>
        </div>
      </div>
    </div>
    <div class="card"><div class="card-head"><div><div class="card-title">全部表格（CSV）</div></div></div>
      <div style="padding:16px 18px" class="col gap-6">
        ${Object.entries(tableDefs()).map(([k, d]) => `<button class="btn btn-sm btn-block" data-exp-one="${k}">${icon('download', 15)} ${esc(d.label)}（${(load()[d.collection] || []).length} 筆）</button>`).join('')}
      </div>
    </div>
  </div>`;
}

/* ============================================================
   Sheet 讀取（gviz JSON）
   ============================================================ */
function parseSheetUrl(url) {
  const u = String(url || '').trim();
  const m = u.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const gidMatch = u.match(/[#&?]gid=([0-9]+)/);
  return { id: m[1], gid: gidMatch ? gidMatch[1] : '' };
}

async function fetchSheet(url, gid) {
  const parsed = parseSheetUrl(url);
  if (!parsed) throw new Error('唔似係 Google Sheet 網址');
  const g = gid || parsed.gid;
  const endpoint = `https://docs.google.com/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:json${g ? `&gid=${g}` : ''}`;
  const r = await fetch(endpoint, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + '（請確認已設定「知道連結嘅人都可以檢視」）');
  const txt = await r.text();
  return parseGviz(txt);
}

/** 解析 Google 嘅 gviz JSON（包住 /*O_o*\/ … google.visualization.Query.setResponse(...) ） */
export function parseGviz(text) {
  const m = String(text).match(/setResponse\(([\s\S]*)\);?\s*$/);
  const json = JSON.parse(m ? m[1] : text);
  const cols = (json.table?.cols || []).map(c => ({ id: c.id || '', label: c.label || c.id || '', type: c.type || 'string' }));
  const rows = (json.table?.rows || []).map(r => (r.c || []).map(c => {
    if (!c) return '';
    const v = c.f !== undefined && c.f !== null ? c.f : c.v;
    return v === null || v === undefined ? '' : String(v).trim();
  }));
  return { title: json.table?.title || '', cols, rows };
}

/** 自動對應：同名／相似名 */
export function autoMap(cols, fields) {
  const norm = s => String(s || '').toLowerCase().replace(/[\s_\-（）()【】\[\]]/g, '');
  const ALIAS = {
    date: ['日期', 'date', '時間', '日子'],
    type: ['類型', '收入或支出', '收支', 'type'],
    item: ['項目', 'item', '名稱', 'name', '內容', '收入項目', '支出項目'],
    amount: ['金額', 'amount', '收入', '支出', '銀碼', '價錢'],
    category: ['分類', 'category', '類別'],
    method: ['方式', 'method', '付款方式', '收付方式'],
    byName: ['經手人', '負責人', '付款人', '申報人', 'by', '姓名', 'name'],
    ref: ['單據', '單號', 'ref', '收據'],
    note: ['備註', 'note', 'remark', '說明'],
    code: ['編號', 'code'],
    total: ['數量', 'total', '總數'],
    unit: ['單位', 'unit'],
    location: ['位置', 'location', '存放'],
    name: ['姓名', 'name', '名稱'],
    birthday: ['生日', '出生日期', 'birthday', 'birth'],
    phone: ['電話', 'phone', '手機', '聯絡'],
    email: ['電郵', 'email', 'mail'],
    venue: ['地點', 'venue', '位置'],
    fee: ['費用', 'fee', '收費']
  };
  const map = {};
  cols.forEach((c, i) => {
    const labels = [c.label, c.id].map(norm).filter(Boolean);
    let hit = '';
    for (const f of fields) {
      const names = [norm(f.key), norm(f.label), ...(ALIAS[f.key] || []).map(norm)];
      if (labels.some(l => names.includes(l))) { hit = f.key; break; }
    }
    if (!hit) {
      outer: for (const f of fields) {
        const names = [norm(f.key), norm(f.label), ...(ALIAS[f.key] || []).map(norm)];
        for (const l of labels) {
          if (!l) continue;
          if (names.some(n => n && (n.includes(l) || l.includes(n)) && Math.min(n.length, l.length) >= 2)) { hit = f.key; break outer; }
        }
      }
    }
    map[i] = hit || '';
  });
  return map;
}

/* ============================================================
   匯入
   ============================================================ */
export function rowsFromSheet(sheet, map, fields) {
  const out = [];
  sheet.rows.forEach(r => {
    const row = {};
    let any = false;
    Object.entries(map).forEach(([ci, key]) => {
      if (!key) return;
      const f = fields.find(x => x.key === key);
      let v = r[Number(ci)];
      if (v === undefined) return;
      if (f?.type === 'number') { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); v = Number.isFinite(n) ? n : 0; }
      else if (f?.type === 'select' && f.options?.length) {
        const i = (f.optionLabels || []).indexOf(String(v));
        if (i >= 0) v = f.options[i];
      }
      if (v !== '' && v !== null) any = true;
      row[key] = v;
    });
    if (any) out.push(row);
  });
  return out;
}

/* ============================================================
   總表同步：送出
   ============================================================ */
export function buildPayload({ sample = false } = {}) {
  const db = load();
  const defs = tableDefs();
  const tables = {};
  Object.entries(defs).forEach(([k, d]) => {
    const rows = (db[d.collection] || []).map(r => {
      const o = { ...r };
      // 相片唔會送去 Sheet（只記數量）
      if (Array.isArray(o.photos)) { o.photos = o.photos.length; }
      if (Array.isArray(o.attachments)) { o.attachments = o.attachments.length; }
      if (Array.isArray(o.signups)) { o.signups = o.signups.length; }
      return o;
    });
    tables[d.collection] = sample ? rows.slice(0, 3) : rows;
  });
  const s = db.sync || {};
  const payload = {
    action: sample ? 'ping' : 'sync',
    unit: s.unit || db.unitCode,
    unitName: db.profile?.name || db.unit?.name || '',
    apiKey: s.apiKey || '',
    at: new Date().toISOString(),
    schema: Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.fields.map(f => ({ key: f.key, label: f.label, type: f.type }))])),
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    tables
  };
  /* 2026-09-20：報表同步**淨係**寫報表分頁（攤平嗰啲），**唔會**帶埋整個資料庫。
     整個資料庫只有一條路寫入 —— remote.saveToBackend()（核對版本 → 三方比對 → 問衝突）。
     以前呢度順便寫 db，正正係「幾個地方都會儲存、互相蓋」嘅其中一個源頭。 */
  if (!sample) payload.skipDb = true;
  return payload;
}

/* 有冇同源代理可以用（同 remote.js 一樣嘅判斷：http/https 先有 /api/proxy） */
function canUseProxy() {
  try { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol); }
  catch { return false; }
}

export async function pushToMaster({ silent = false } = {}) {
  const s = load().sync || {};
  const payload = buildPayload();
  /* 冇填本地 /exec？先試同源代理 —— Vercel 登記嘅旅團正路係咁：
     後端網址同 API Key 留喺伺服器端（TROOP_*），前端淨係送旅團編號。
     （2026-09-17 0082 事件：純環境變數開團嘅旅團呢度永遠「未設定網址」，
       連「測試連線」都撳唔到，明明經代理係寫得入嘅。） */
  let endpoint = (s.url || '').trim();
  let viaProxy = false;
  if (!endpoint) {
    if (canUseProxy()) { endpoint = 'api/proxy'; viaProxy = true; }
    else {
      const db = load();
      db.sync = {
        ...(db.sync || {}),
        log: [...((db.sync || {}).log || []), { at: new Date().toISOString().slice(0, 19).replace('T', ' '), msg: '✗ 未設定 Apps Script 網址（去「總表同步」填 /exec）' }].slice(-40)
      };
      commitMeta();
      if (!silent) toast('未設定 Apps Script 網址', 'err');
      return { ok: false, msg: '未設定網址' };
    }
  }
  /* 經代理就唔好送空 key —— 等伺服器端由 TROOP_* 注入（同 remote.js 一樣做法） */
  if (viaProxy && !payload.apiKey) delete payload.apiKey;
  /* 同步紀錄係簿記 —— commitMeta() 只寫本機，唔會計入「未儲存改動」 */
  const log = (msg) => {
    const db = load();
    db.sync = { ...(db.sync || {}), log: [...((db.sync || {}).log || []), { at: new Date().toISOString().slice(0, 19).replace('T', ' '), msg }].slice(-40), lastAt: new Date().toISOString() };
    commitMeta();
  };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': viaProxy ? 'application/json' : 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const txt = (await res.text()).slice(0, 2000);
    let json = null;
    try { json = JSON.parse(txt); } catch { /* 直接打 GAS 嗰陣成日唔係 JSON，唔出奇 */ }
    if (viaProxy && !json) {
      /* 同源根本冇呢個 API（純靜態部署）＋ 又冇填本地網址 → 同未設定一樣 */
      const msg = `連唔到同源代理（HTTP ${res.status}），又未設定後端網址`;
      log(`✗ ${msg}`);
      if (!silent) toast(msg, 'err');
      return { ok: false, msg, viaProxy };
    }
    /* 經代理一定讀到 JSON：唔好淨係睇 HTTP code —— GAS 就算拒絕
       （例如 API Key 唔啱）都係回 HTTP 200，要睇 ok／success 先知
       究竟寫入咗未。（直接打 GAS 嗰陣多數讀唔到回應，維持舊做法。） */
    const failed = viaProxy
      ? (!res.ok || !json || json.ok === false || json.success === false)
      : !res.ok;
    const ok = !failed;
    const detail = viaProxy ? String(json?.error || json?.msg || '').replace(/\s+/g, ' ').slice(0, 120) : '';
    /* 報表分頁同步唔會郁「資料庫」分頁，所以**唔會**清 pending —— 未儲存嘅改動仍然未儲存 */
    if (!ok && viaProxy && detail) {
      const d = load();
      d.sync = { ...(d.sync || {}), lastError: detail };
    }
    const total = payload.counts ? Object.values(payload.counts).reduce((a, b) => a + b, 0) : 0;
    log(`${ok ? '✓' : '✗'} 報表分頁 HTTP ${res.status}${viaProxy ? '（代理）' : ''} · ${total} 筆 · ${(detail || txt).replace(/\s+/g, ' ').slice(0, 80)}`);
    if (!silent) toast(ok ? '已更新總表嘅報表分頁（資料庫本身要撳「儲存到後端」）' : ('同步失敗：' + (detail || ('HTTP ' + res.status))), ok ? 'ok' : 'err');
    /* total ＝ 今次攤平咗幾多筆落報表分頁 —— 「儲存到後端」嘅成功訊息會用嚟
       話畀用家知「團員／帳目嗰啲分頁而家有嘢睇」，唔使再開張 Sheet 先知。 */
    return { ok, msg: detail || txt.slice(0, 300), viaProxy, total };
  } catch (e) {
    if (viaProxy) {
      /* 經代理唔會有「送咗但讀唔到」呢回事 —— 掟 exception 即係根本未送到 */
      const msg = /abort/i.test(e?.name || '') ? '連線逾時' : ('連唔到同源代理：' + (e.message || '網絡錯誤'));
      log(`✗ ${msg}`);
      if (!silent) toast(msg, 'err');
      return { ok: false, msg, viaProxy };
    }
    // 跨網域下瀏覽器可能唔畀讀回應（Apps Script 常見）→ 資料其實可能已經寫入
    const uncertain = /Failed to fetch|NetworkError|load failed|network/i.test(e.message || '');
    log(`${uncertain ? '⚠' : '✗'} ${uncertain ? '已送出，但讀唔到伺服器回應（Apps Script 可能已收到）' : e.message} · ${e.message}`);
    if (!silent) toast(uncertain ? '已送出（讀唔到回應，可能已寫入總表；睇同步紀錄）' : '同步失敗：' + e.message, uncertain ? 'warn' : 'err');
    return { ok: false, pending: uncertain, msg: e.message };
  }
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root, params) {
  const key = Object.keys(tableDefs()).includes(params.id) ? params.id : null;

  /* ---- 欄位設計 ---- */
  if (key) {
    const list = root.querySelector('#field-list');
    const def = tableDefs()[key];
    const fields = def.fields;

    const paint = () => { if (list) { list.innerHTML = fields.map((f, i) => fieldRow(f, i, can('table.design'))).join(''); bind(); } };

    const bind = () => {
      if (!list) return;
      list.querySelectorAll('[data-field]').forEach(row => {
        const i = Number(row.dataset.field);
        row.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
          const k = el.dataset.k;
          if (k === 'required') fields[i].required = el.checked;
          else if (k === 'show') fields[i].show = el.checked;
          else if (k === 'options') fields[i].options = String(el.value).split(/[、,，]/).map(x => x.trim()).filter(Boolean);
          else fields[i][k] = el.value;
          saveDef(key, fields);
          paint();
        }));
      });
      list.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.up); [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; saveDef(key, fields); paint();
      }));
      list.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.down); [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; saveDef(key, fields); paint();
      }));
      list.querySelectorAll('[data-delf]').forEach(b => b.addEventListener('click', () => {
        const f = fields[Number(b.dataset.delf)];
        confirmDlg({ title: '刪除欄位', danger: true, okText: '確定刪除', message: `刪除「${esc(f.label)}」？（已存在嘅資料唔會刪，只係唔再顯示）` })
          .then(ok => { if (!ok) return; fields.splice(Number(b.dataset.delf), 1); saveDef(key, fields); paint(); });
      }));
    };
    paint();

    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'add-field') {
        const r = await modal({
          title: '加欄位',
          body: `<div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">欄位名稱</label><input class="input" id="nf-label" placeholder="例：小隊 / 收據編號"></div>
            <div class="field"><label class="label">類型</label><select class="select" id="nf-type">
              ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
            <div class="field" style="grid-column:1/-1"><label class="label">選項（下拉用，用、分隔）</label>
              <input class="input" id="nf-options" placeholder="例：甲小隊、乙小隊"></div>
          </div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
            { label: '加入', class: 'btn-primary', onClick: el => ({
              label: el.querySelector('#nf-label').value.trim(),
              type: el.querySelector('#nf-type').value,
              options: el.querySelector('#nf-options').value.split(/[、,，]/).map(x => x.trim()).filter(Boolean)
            }) }]
        });
        if (!r || !r.label) return;
        const k = 'x' + Math.random().toString(36).slice(2, 7);
        fields.push({ key: k, label: r.label, type: r.type, options: r.options, show: true });
        saveDef(key, fields); paint(); toast('已加欄位', 'ok');
      }
      if (act === 'reset-fields') {
        if (!(await confirmDlg({ title: '還原預設欄位', danger: true, okText: '確定還原', message: '會還原成系統預設欄位（資料唔會刪）。' }))) return;
        resetDef(key); refresh();
      }
      if (act === 'exp-table-csv') {
        const shown = fields.filter(f => f.show !== false);
        toCSV({
          filename: `${def.label}_${stamp()}.csv`, headers: shown.map(f => f.label),
          rows: (load()[def.collection] || []).map(r => shown.map(f => cellText(r, f)))
        });
        toast('已匯出 CSV', 'ok');
      }
      if (act === 'exp-table-word') {
        const shown = fields.filter(f => f.show !== false);
        const rows = (load()[def.collection] || []).map(r => `<tr>${shown.map(f => `<td>${esc(cellText(r, f))}</td>`).join('')}</tr>`).join('');
        toWord({
          filename: `${def.label}_${stamp()}.doc`, title: def.label, org: profile().name,
          bodyHtml: `<div class="doc-head"><div class="doc-title">${esc(def.label)}</div>
            <div class="doc-sub">${esc(profile().name || '')} · ${esc(todayISO())}</div></div>
            <table><thead><tr>${shown.map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
        });
        toast('已輸出 Word', 'ok');
      }
      if (act === 'export-all-csv') {
        const defs = tableDefs();
        Object.entries(defs).forEach(([k, d], i) => setTimeout(() => {
          const shown = d.fields.filter(f => f.show !== false);
          toCSV({
            filename: `${d.label}_${stamp()}.csv`, headers: shown.map(f => f.label),
            rows: (load()[d.collection] || []).map(r => shown.map(f => cellText(r, f)))
          });
        }, i * 400));
        toast('正在逐個匯出（瀏覽器會逐個下載）', 'ok');
      }
    }));
  }

  /* ---- 插入自己嘅 Sheet ---- */
  if (params.id === 'source') {
    const preview = root.querySelector('#sheet-preview');

    const showMapping = (sheet) => {
      const target = root.querySelector('#s-target').value;
      const fields = tableDefs()[target].fields;
      const map = autoMap(sheet.cols, fields);
      mapState = { sheet, target, fields, map };
      preview.innerHTML = `
        <div class="note-box info mb-12">${icon('check', 15)}<div>讀到 <b>${sheet.rows.length}</b> 筆、${sheet.cols.length} 欄${sheet.title ? `（工作表：${esc(sheet.title)}）` : ''}。
          下面係自動對應，可以自己改。</div></div>
        <div class="card"><div class="card-head"><div><div class="card-title">欄位對應 → ${esc(tableDefs()[target].label)}</div>
          <div class="card-sub">左邊係你 Sheet 嘅欄，右邊揀本系統嘅欄位</div></div></div>
          <div style="padding:12px 16px">
            ${sheet.cols.map((c, i) => `
              <div class="map-row">
                <div class="sm"><b>${esc(c.label || c.id || `第 ${i + 1} 欄`)}</b>
                  <span class="xs faint">（例：${esc((sheet.rows[0]?.[i] || '').slice(0, 24))}）</span></div>
                <select class="select" data-map="${i}" style="padding:7px 10px">
                  <option value="">— 唔匯入 —</option>
                  ${fields.map(f => `<option value="${esc(f.key)}" ${map[i] === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
                </select>
              </div>`).join('')}
          </div>
          <div style="padding:0 16px 16px">
            <div class="scroll-x"><table class="table table-compact">
              <thead><tr>${sheet.cols.slice(0, 8).map(c => `<th>${esc(c.label || c.id)}</th>`).join('')}</tr></thead>
              <tbody>${sheet.rows.slice(0, 5).map(r => `<tr>${sheet.cols.slice(0, 8).map((c, i) => `<td class="sm">${esc(String(r[i] ?? '').slice(0, 20))}</td>`).join('')}</tr>`).join('')}</tbody>
            </table></div>
            <div class="row gap-8 mt-12 wrap">
              <button class="btn btn-primary" data-act="do-import">${icon('upload', 16)} 匯入到「${esc(tableDefs()[target].label)}」</button>
              <button class="btn" data-act="save-source">${icon('save', 16)} 儲存做同步來源</button>
              <label class="check"><input type="checkbox" id="s-clear" ${['transactions', 'invItems'].includes(target) ? 'checked' : ''}> 匯入前清空該表（避免重複）</label>
            </div>
          </div>
        </div>`;
      bindImport();
    };

    const bindImport = () => {
      preview.querySelectorAll('[data-map]').forEach(sel => sel.addEventListener('change', () => {
        mapState.map[Number(sel.dataset.map)] = sel.value;
      }));
      preview.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.act;
        const rows = rowsFromSheet(mapState.sheet, mapState.map, mapState.fields);
        if (!rows.length) { toast('冇任何對應到嘅資料', 'err'); return; }
        if (act === 'do-import') {
          const clear = root.querySelector('#s-clear')?.checked;
          if (!(await confirmDlg({
            title: '匯入資料', danger: clear, okText: '確定匯入',
            message: `會匯入 <b>${rows.length}</b> 筆到「${esc(tableDefs()[mapState.target].label)}」${clear ? '，並且<b>先清空該表</b>' : '（附加，唔會刪原有資料）'}。`
          }))) return;
          const col = tableDefs()[mapState.target].collection;
          if (clear) {
            const db = load();
            db[col] = [];
            commit();
          }
          let n = 0;
          rows.forEach(r => {
            const idKey = mapState.target === 'members' ? 'm' : mapState.target === 'invItems' ? 'g' : 'r';
            add(col, { id: uid(idKey), importedAt: nowStamp(), ...r });
            n++;
          });
          toast(`已匯入 ${n} 筆`, 'ok');
          refresh();
        }
        if (act === 'save-source') {
          const db = load();
          db.tableSources = [...(db.tableSources || []), {
            id: uid('src'), kind: 'sheet', url: root.querySelector('#s-url').value.trim(),
            gid: root.querySelector('#s-gid').value.trim(), target: mapState.target,
            map: mapState.map, at: nowStamp()
          }];
          commit(); toast('已儲存來源（可以隨時再同步）', 'ok'); refresh();
        }
      }));
    };

    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'load-sheet') {
        const url = root.querySelector('#s-url').value.trim();
        if (!url) { toast('請貼上 Sheet 網址', 'err'); return; }
        preview.innerHTML = '<div class="sm faint">讀取中…</div>';
        try {
          const sheet = await fetchSheet(url, root.querySelector('#s-gid').value.trim());
          if (!sheet.cols.length) throw new Error('讀唔到欄位（可能分頁唔存在或者未開放檢視）');
          showMapping(sheet);
        } catch (e) {
          preview.innerHTML = `<div class="note-box danger">${icon('alert', 15)}<div>讀取失敗：${esc(e.message)}
            <br><span class="xs">請設定 Sheet 分享權限為「知道連結嘅任何人均可檢視」，或者改用「貼上 CSV」。</span></div></div>`;
        }
      }
      if (act === 'paste-csv') {
        const r = await modal({
          title: '貼上 CSV / 表格', wide: true,
          body: `<div class="field"><label class="label">由 Google Sheet 複製（Tab 分隔都得）</label>
            <textarea class="textarea" id="pc-text" style="min-height:170px;font-family:var(--mono);font-size:12.5px"></textarea></div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
            { label: '讀取', class: 'btn-primary', onClick: el => el.querySelector('#pc-text').value }]
        });
        if (!r || !r.trim()) return;
        const { splitCsv } = await import('./finance.js');
        const isTab = (r.split('\n')[0] || '').includes('\t');
        const table = isTab ? r.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t')) : splitCsv(r);
        const head = table[0];
        const sheet = {
          title: '（貼上）',
          cols: head.map((h, i) => ({ id: 'c' + i, label: String(h).trim() || `第 ${i + 1} 欄`, type: 'string' })),
          rows: table.slice(1).map(r => head.map((_, i) => String(r[i] ?? '').trim()))
        };
        showMapping(sheet);
      }
    }));

    root.querySelectorAll('[data-reload]').forEach(b => b.addEventListener('click', async () => {
      const src = (load().tableSources || [])[Number(b.dataset.reload)];
      if (!src) return;
      if (src.kind !== 'sheet') { toast('貼上嘅來源要重新貼一次', 'warn'); return; }
      try {
        const sheet = await fetchSheet(src.url, src.gid);
        mapState = { sheet, target: src.target, fields: tableDefs()[src.target].fields, map: src.map || autoMap(sheet.cols, tableDefs()[src.target].fields) };
        showMapping(sheet);
        toast('已重新讀取，可以再匯入', 'ok');
      } catch (e) { toast('讀取失敗：' + e.message, 'err'); }
    }));
    root.querySelectorAll('[data-delsrc]').forEach(b => b.addEventListener('click', () => {
      const db = load();
      db.tableSources = (db.tableSources || []).filter((_, i) => i !== Number(b.dataset.delsrc));
      commit(); toast('已移除來源', 'ok'); refresh();
    }));
  }

  /* ---- 總表同步 ---- */
  if (params.id === 'sync') {
    /* ★ 2026-09-25 求救制：同頂部嗰粒同一條路（SEND 去 ADMIN，當回報問題處理） */
    root.querySelectorAll('[data-act="sos"]').forEach(b => b.addEventListener('click', async () => {
      const { openSOS } = await import('../main.js');
      openSOS();
    }));
    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'save-sync') {
        const db = load();
        const url = root.querySelector('#y-url').value.trim();
        db.sync = {
          ...(db.sync || {}),
          url,
          unit: root.querySelector('#y-unit').value.trim() || db.unitCode,
          apiKey: root.querySelector('#y-key').value.trim()
        };
        /* 舊遺留：auto／autoModel（自動寫入）、poll（會議模式背景讀）都已經冇呢啲路 */
        delete db.sync.auto;
        delete db.sync.autoModel;
        delete db.sync.poll;
        const share = root.querySelector('#y-share')?.checked;
        if (share && url) {
          db.settings = { ...(db.settings || {}) };
          db.settings.notice = { ...(db.settings.notice || {}), submitUrl: url };
          db.settings.publicEntry = { ...(db.settings.publicEntry || {}), submitUrl: url };
          db.backend = { ...(db.backend || {}), gasUrl: url, apiKey: db.sync.apiKey };
        }
        /* 連線設定係呢部機自己嘅嘢（唔會上後端），所以只寫本機、唔計入未儲存改動 */
        commitMeta();
        toast(share && url ? '已儲存，手機記帳／通告報名一齊用同一條網址'
          : '已儲存連線設定（資料寫入後端：撳頂部「儲存到後端」）', 'ok');
        refresh();
      }
      if (act === 'push-sync') {
        if (!(await confirmDlg({ title: '更新報表分頁', okText: '開始', message: '會將全部表格資料攤平送去你嘅 Google Sheet 嘅報表分頁（帳目／團員／物資…），畀你自己睇同用公式。<br><br><b>唔會</b>寫「資料庫」分頁 —— 資料庫本身由頂部「儲存到後端」處理。' }))) return;
        await pushToMaster(); refresh();
      }

      /* ---- 整個資料庫：即刻寫入／還原／檢視（真正嘅後端儲存） ---- */
      if (act === 'push-db') {
        const { saveWithDialog } = await import('./syncdialog.js');
        const old = b.innerHTML;
        b.disabled = true; b.textContent = '核對緊後端…';
        const r = await saveWithDialog({ silent: false, toastOk: true, receipt: true });
        b.disabled = false; b.innerHTML = old;
        if (r.ok) {
          /* toast 已由 saveWithDialog 出 */
        } else if (r.hint && r.reason !== 'no_base') {
          /* 有得救嘅死因（API Key 唔啱／未 re-deploy）：用對話框講清楚點解決，
             唔好淨係彈個 toast —— toast 一閃就冇，用家只會覺得「又係唔得」。 */
          await modal({
            title: r.reason === 'bad_key' ? '寫唔入後端：API Key 唔啱' : '寫唔入後端：個 /exec 仲係舊版',
            body: `<div class="note-box err">${icon('alert', 15)}<div><b>後端回覆：</b>${esc(r.error || '未知錯誤')}</div></div>
              <p class="sm mt-12">${esc(r.hint)}</p>
              <p class="sm muted mt-8">你部機啲資料仲喺度，一修好就會即刻寫得入 —— 唔會蝕咗。</p>`,
            actions: [{ label: '知道喇', class: 'btn-primary', value: true }]
          });
        }
        refresh();
      }
      if (act === 'pull-db') {
        const remote = await import('../lib/remote.js');
        const info = await remote.remoteInfo();
        if (!info?.ok) { toast('讀唔到後端：' + (info?.error || '未知錯誤'), 'err'); return; }
        if (!info.found) { toast('後端仲未有資料庫（請先撳頂部「儲存到後端」建立第一份）', 'warn'); return; }
        const c = info.counts || {};
        const pend = Number(load().sync?.pending || 0);
        const okGo = await confirmDlg({
          title: '由後端重新載入', danger: true, okText: pend ? '丟棄本機改動，用後端嗰份' : '用後端資料覆蓋本機',
          message: `後端最後更新：<b>${esc(String(info.at || info.version || '').slice(0, 19).replace('T', ' '))}</b><br>
            內容：團員 ${c.members ?? '?'} · 帳目 ${c.transactions ?? '?'} · 會議 ${c.meetings ?? '?'} · 通告 ${c.notices ?? '?'} · 物資 ${c.invItems ?? '?'}<br><br>
            <b>呢部機而家嘅資料會被覆蓋。</b>${pend ? `本機有 <b>${pend}</b> 項未儲存改動會<b>全部丟棄</b>；想保留就撳「取消」再撳「儲存到後端」。` : ''}`
        });
        if (!okGo) return;
        const { reloadFromBackend } = await import('./syncdialog.js');
        await reloadFromBackend({ force: true });
        refresh();
      }
      if (act === 'dl-gas') {
        const { gasTemplate } = await import('../lib/gastemplate.js');
        download('Code.gs', gasTemplate(), 'text/plain;charset=utf-8');
        toast('已下載 Code.gs', 'ok');
      }
      if (act === 'copy-gas') {
        const { gasTemplate } = await import('../lib/gastemplate.js');
        const ok = await copyText(gasTemplate());
        if (ok) toast('已複製 Code.gs 全部原始碼到剪貼簿', 'ok');
      }
      if (act === 'dl-schema') {
        const defs = tableDefs();
        toCSV({
          filename: `欄位對應表_${stamp()}.csv`, headers: ['表格', '欄位 key', '顯示名', '類型'],
          rows: Object.entries(defs).flatMap(([k, d]) => d.fields.map(f => [d.label, f.key, f.label, TYPE_LABEL[f.type] || f.type]))
        });
        toast('已下載欄位對應表', 'ok');
      }
      if (act === 'copy-guide') {
        const txt = `【總表同步設定】\n1. 開你嘅 Google Sheet → 擴充功能 → Apps Script\n2. 貼上下載嘅 Code.gs（或 app 內「下載 Code.gs」）\n3. 部署 → 新增部署作業 → 類型：網頁應用程式\n4. 執行身分：我；具有存取權的使用者：任何人\n5. 複製 /exec 網址，貼返「表格 → 總表同步 → Apps Script 網址」\n6. 儲存設定，之後就可以撳頂部「儲存到後端」\n第 7 步（可選）：設定 API Key 加強保護。`;
        if (await copyText(txt)) toast('已複製部署步驟', 'ok');
      }
    }));
  }

  /* ---- 儲存與備份 ---- */
  if (params.id === 'data') {
    root.querySelectorAll('[data-exp-one]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.expOne;
      const d = tableDefs()[k];
      const shown = d.fields.filter(f => f.show !== false);
      toCSV({
        filename: `${d.label}_${stamp()}.csv`, headers: shown.map(f => f.label),
        rows: (load()[d.collection] || []).map(r => shown.map(f => cellText(r, f)))
      });
      toast('已匯出', 'ok');
    }));
    root.querySelectorAll('[data-act="strip-photos"]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDlg({ title: '清理相片', danger: true, okText: '確定清理',
        message: '會移除<b>已入帳</b>嘅帳目相片（保留文字記錄同「有單據」標記）。未批核嘅申報相片唔會清。' }))) return;
      const db = load();
      let n = 0;
      (db.transactions || []).forEach(t => { if ((t.photos || []).length) { n += t.photos.length; t.photos = []; t.receipt = true; } });
      commit();
      toast(`已清理 ${n} 張相片`, 'ok'); refresh();
    }));
  }
}

export function refresh() {
  window.dispatchEvent(new CustomEvent('v82:refresh'));
}
