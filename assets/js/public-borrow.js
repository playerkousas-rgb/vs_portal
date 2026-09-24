/* ============================================================
   public-borrow.js — 物資借用申請（borrow.html）
   成員免登入就可以申請借物資（唔使執委帳戶）：
     揀物資 → 數量 → 借用／歸還日期 → 用途 → 姓名／聯絡 → 送出
   送出目的地（依序）：
     1. 旅團設定嘅 Apps Script（settings.publicBorrow.submitUrl，
        未填就用 publicEntry / notice / Registry backend 嗰條 /exec）
        → Script 寫入總表「物資借用」分頁（待批核）
     2. 冇設定 → 存喺本機 ＋「複製內容」傳畀執委
   ============================================================ */

import { esc, icon, uid, todayISO, toast, copyText } from './lib/util.js';
import { loadMe, saveMe } from './lib/member-me.js';
import { postBackend, beFromQuery, proxyUsable } from './lib/gateway.js';

/* 「送唔送到總表」唔可以再淨係睇 settings.publicBorrow.submitUrl ——
   平台用 Vercel 環境變數登記嘅旅團，公開頁讀唔到任何設定檔，嗰格永遠係空，
   於是明明經 /api/proxy（或者連結帶嘅 ?be=）送得到，個頁都係話「會存喺你呢部裝置」。 */
const connected = () => !!(cfg.submitUrl || beFromQuery() || proxyUsable());

const q = new URLSearchParams(location.search);
const app = document.getElementById('app');
let unitCode = q.get('u') || '0082';
let meta = {};
let cfg = {};
let items = [];
let loans = [];
let audits = [];

const OPEN = ['approved', 'out'];
const state = {
  itemId: '', qty: 1, fromDate: todayISO(), toDate: '', purpose: '',
  byName: (new URLSearchParams(location.search).get('name') || loadMe().name || ''), contact: ''
};

const localKey = () => `venture82.borrow.${unitCode}`;
const localRows = () => { try { return JSON.parse(localStorage.getItem(localKey()) || '[]'); } catch { return []; } };

async function loadJson(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* 可用數量 = 總數量 + 盤點調整 − 借出中（同 app 內 itemTotals 一樣嘅算法） */
function available(item) {
  const adjusted = Number(item.total || 0) + audits
    .filter(a => a.itemId === item.id)
    .reduce((s, a) => s + Number(a.delta || 0), 0);
  const out = loans
    .filter(l => l.itemId === item.id && OPEN.includes(l.status))
    .reduce((s, l) => s + Number(l.qty || 0), 0);
  return { adjusted, out, available: adjusted - out };
}

async function boot() {
  try {
    let registry = null, unit = null, inv = null;
    try { registry = await loadJson('data/units.json'); } catch { /* ignore */ }
    if (registry?.units) {
      if (!q.get('u') && registry.defaultUnit) unitCode = registry.defaultUnit;
      meta = registry.units[unitCode] || {};
    }
    const path = meta.dataPath || `data/units/${unitCode}/`;
    try { unit = await loadJson(path + 'unit.json'); } catch { /* 用 registry 資料 */ }
    try { inv = await loadJson(path + 'inventory.json'); } catch { /* 未登記物資 */ }
    if (unit) {
      meta = { ...meta, name: unit.name || meta.name, short: unit.short || meta.short };
      const s = unit.settings || {};
      cfg = {
        submitUrl: s.publicBorrow?.submitUrl || s.publicEntry?.submitUrl || s.notice?.submitUrl
          || registry?.backend?.gasUrl || '',
        title: s.publicBorrow?.title || '',
        note: s.publicBorrow?.note || '',
        allowCategories: s.publicBorrow?.categories || null
      };
    }
    items = (inv?.items || []).filter(i => !cfg.allowCategories || cfg.allowCategories.includes(i.category));
    loans = inv?.loans || [];
    audits = inv?.audits || [];
    document.title = `物資借用 · ${meta.name || unitCode}`;
    render();
  } catch (e) {
    app.innerHTML = `<div class="pe-wrap"><div class="pe-card">
      <h1 style="font-size:19px">暫時開唔到</h1>
      <p class="sm muted mt-8">技術訊息：<code>${esc(e.message)}</code></p></div></div>`;
  }
}

function render() {
  const chosen = items.find(i => i.id === state.itemId);
  const avail = chosen ? available(chosen) : null;

  app.innerHTML = `
  <div class="pe-top">
    <div class="row gap-10">
      <div class="logo">${esc((meta.short || unitCode).slice(0, 3))}</div>
      <div class="grow"><div style="font-weight:800;font-size:16px">${esc(meta.name || unitCode)}</div>
        <div class="xs" style="color:#EBC6CE">${cfg.title || '物資借用申請 · 免登入'}</div></div>
      ${connected() ? '<span class="badge b-grey" title="已連接旅團總表">已連接總表</span>' : ''}
    </div>
  </div>

  <div class="pe-wrap">
    ${cfg.note ? `<div class="pe-card"><div class="sm muted">${esc(cfg.note)}</div></div>` : ''}

    <form class="pe-card" id="pb-form" novalidate>
      <div class="pe-field">
        <label>① 揀物資 <span class="req">*</span></label>
        ${items.length ? items.map(i => {
          const a = available(i);
          const picked = state.itemId === i.id;
          return `<button type="button" class="item-row" data-item="${esc(i.id)}" aria-pressed="${picked}">
            <span class="grow" style="text-align:left">
              <span style="display:block;font-weight:700;font-size:14.5px">${esc(i.name)}</span>
              <span class="xs faint">${esc(i.code || '')}${i.category ? ' · ' + esc(i.category) : ''}${i.location ? ' · ' + esc(i.location) : ''}</span>
            </span>
            <span class="stock" style="color:${a.available > 0 ? 'var(--ok)' : 'var(--danger)'}">
              ${a.available > 0 ? `可用 ${a.available}${i.unit ? ' ' + esc(i.unit) : ''}` : '暫借完'}</span>
          </button>`;
        }).join('') : `<div class="sm muted">旅團未有登記物資（或者未開放線上借用）。請直接聯絡執委。</div>`}
        <div class="pe-err" data-err="itemId">請揀一樣物資</div>
      </div>

      <div class="row gap-10" style="align-items:flex-start">
        <div class="pe-field grow">
          <label>② 數量 <span class="req">*</span></label>
          <input class="input" id="pb-qty" type="number" min="1" step="1" value="${esc(String(state.qty))}">
          ${avail ? `<div class="hint">最多可借 ${Math.max(0, avail.available)}${chosen?.unit ? ' ' + esc(chosen.unit) : ''}</div>` : ''}
          <div class="pe-err" data-err="qty">請填數量</div>
        </div>
        <div class="pe-field grow">
          <label>③ 借用日</label>
          <input class="input" id="pb-from" type="date" value="${esc(state.fromDate)}">
        </div>
        <div class="pe-field grow">
          <label>④ 歸還日</label>
          <input class="input" id="pb-to" type="date" value="${esc(state.toDate)}">
        </div>
      </div>

      <div class="pe-field">
        <label>⑤ 用途 <span class="req">*</span></label>
        <input class="input" id="pb-purpose" placeholder="例：10 月露營先鋒工程" value="${esc(state.purpose)}">
        <div class="pe-err" data-err="purpose">請寫低用途（方便批核）</div>
      </div>

      <div class="row gap-10" style="align-items:flex-start">
        <div class="pe-field grow">
          <label>你嘅姓名 <span class="req">*</span></label>
          <input class="input" id="pb-name" placeholder="例：陳大文" value="${esc(state.byName)}">
          <div class="pe-err" data-err="byName">請填姓名</div>
        </div>
        <div class="pe-field grow">
          <label>聯絡電話</label>
          <input class="input" id="pb-contact" type="tel" placeholder="9xxx xxxx" value="${esc(state.contact)}">
        </div>
      </div>

      <div class="pe-err" id="pb-err"></div>
      <button class="btn btn-primary pe-big-btn" type="submit" ${items.length ? '' : 'disabled'}>${icon('send', 18)} 送出借用申請</button>
      <div class="hint mt-10">${connected()
        ? '送出後會<b>直接記錄到旅團總表</b>（待批核），執委批准之後就可以攞。'
        : '送出後會存喺你呢部裝置；按「複製內容」就可以傳送畀執委。'}</div>
    </form>

    <div class="pe-card no-print">
      <div class="card-title mb-8">${icon('check', 15)} 本機已送出嘅申請</div>
      <div id="pb-local" class="sm muted">…</div>
    </div>

    <div class="center xs faint mt-16">公開申請頁 · 由 ${esc(meta.name || '')} 深資童軍管理系統提供</div>
  </div>`;

  app.querySelectorAll('[data-item]').forEach(b => b.addEventListener('click', () => {
    state.itemId = b.dataset.item;
    render();
  }));

  const bind = (sel, key, ev = 'input') => {
    const el = app.querySelector(sel);
    if (!el) return;
    el.addEventListener(ev, () => {
      state[key] = key === 'qty' ? Number(el.value) || 1 : el.value;
      el.removeAttribute('aria-invalid');
      const box = app.querySelector(`[data-err="${key}"]`);
      if (box) box.style.display = 'none';
    });
  };
  bind('#pb-qty', 'qty');
  bind('#pb-from', 'fromDate');
  bind('#pb-to', 'toDate');
  bind('#pb-purpose', 'purpose');
  bind('#pb-name', 'byName');
  bind('#pb-contact', 'contact');

  app.querySelector('#pb-form')?.addEventListener('submit', submit);
  paintLocal();
}

function paintLocal() {
  const box = app.querySelector('#pb-local');
  if (!box) return;
  const rows = localRows();
  box.innerHTML = rows.length
    ? rows.slice(-5).reverse().map(r => `<div class="row-between" style="padding:6px 0;border-bottom:1px dashed var(--line-2)">
        <span>${esc(r.payload.itemName)} ×${esc(String(r.payload.qty))} · ${esc(r.payload.fromDate || '')}</span>
        <span class="badge ${r.delivered ? 'b-ok' : 'b-grey'}">${r.delivered ? '已送總表' : '存本機'}</span></div>`).join('')
      + (rows.length > 5 ? `<div class="xs faint mt-6">（另有 ${rows.length - 5} 筆）</div>` : '')
    : '<div class="xs faint">仲未有申請。</div>';
}

function validate() {
  const bad = [];
  if (!state.itemId) bad.push('itemId');
  if (!(Number(state.qty) > 0)) bad.push('qty');
  if (!String(state.purpose).trim()) bad.push('purpose');
  if (!String(state.byName).trim()) bad.push('byName');
  const item = items.find(i => i.id === state.itemId);
  if (item) {
    const a = available(item);
    if (Number(state.qty) > Math.max(0, a.available)) bad.push('qty');
  }
  app.querySelectorAll('[data-err]').forEach(el => { el.style.display = 'none'; });
  bad.forEach(k => {
    const box = app.querySelector(`[data-err="${k}"]`);
    if (box) {
      box.style.display = 'block';
      if (k === 'qty' && item) box.textContent = `可借數量不足（可用 ${Math.max(0, available(item).available)}）`;
    }
  });
  const err = app.querySelector('#pb-err');
  if (bad.length) { err.textContent = '仲有欄位未填好，請檢查上面。'; err.style.display = 'block'; }
  else { err.textContent = ''; err.style.display = 'none'; }
  return !bad.length;
}

async function submit(e) {
  e.preventDefault();
  if (!validate()) return;
  saveMe({ id: loadMe().id || q.get('mid') || '', name: String(state.byName).trim() });
  const btn = app.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = '送出中…';

  const item = items.find(i => i.id === state.itemId) || {};
  const payload = {
    id: uid('pb'),
    itemCode: item.code || '', itemName: item.name || '', itemId: item.id || '',
    qty: Number(state.qty) || 1,
    fromDate: state.fromDate || todayISO(), toDate: state.toDate || '',
    purpose: String(state.purpose).trim(),
    byName: String(state.byName).trim(), contact: String(state.contact).trim(),
    submittedAt: new Date().toISOString()
  };

  let delivered = false, uncertain = false, msg = '';
  if (cfg.submitUrl) {
    try {
      const res = await fetch(cfg.submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'loan', unit: unitCode, source: '82venture', payload })
      });
      delivered = res.ok;
      msg = (await res.text()).slice(0, 120);
    } catch (err) {
      uncertain = true;
      msg = err.message;
    }
  } else {
    /* 冇明確設定嘅送出網址 → 行統一入口（lib/gateway.js）：
       ① 同源 /api/proxy ② 連結帶嘅 ?be=<旅團自己嘅 /exec> */
    try {
      const r = await postBackend({ action: 'loan', source: '82venture', payload },
        { unit: unitCode, execUrl: beFromQuery(), timeoutMs: 60000 });
      delivered = !!r.ok && r.json?.ok !== false && r.json?.success !== false;
      msg = String(r.error || r.json?.error || '').slice(0, 120);
      if (!delivered && r.via === 'direct') uncertain = true;
    } catch (err) {
      uncertain = true; msg = err.message;
    }
  }
  const rows = localRows();
  rows.push({ at: new Date().toISOString(), delivered, uncertain, payload });
  try { localStorage.setItem(localKey(), JSON.stringify(rows.slice(-50))); } catch { /* ignore */ }

  done(payload, delivered, msg, uncertain);
}

function done(p, delivered, msg, uncertain = false) {
  const text = `【${meta.name || unitCode} 物資借用】\n物資：${p.itemName}（${p.itemCode}）\n數量：${p.qty}\n借用：${p.fromDate}${p.toDate ? ` → ${p.toDate}` : ''}\n用途：${p.purpose}\n申請人：${p.byName}${p.contact ? `（${p.contact}）` : ''}`;

  app.innerHTML = `
  <div class="pe-top no-print">
    <div class="row gap-10">
      <div class="logo">${esc((meta.short || unitCode).slice(0, 3))}</div>
      <div class="grow"><div style="font-weight:800">${esc(meta.name || unitCode)}</div>
        <div class="xs" style="color:#EBC6CE">已送出</div></div>
    </div>
  </div>
  <div class="pe-wrap">
    <div class="pe-card pe-done">
      <div class="tick">${icon('check', 34)}</div>
      <div style="font-weight:800;font-size:18px">已送出申請！</div>
      <div class="sm muted mt-6">${delivered
        ? '已直接送到旅團總表，等執委／領袖批核。'
        : uncertain
          ? '訊息已送出。如果總表冇見到紀錄，請按「複製內容」傳送畀執委。'
          : '已存喺你呢部裝置。請按下面「複製內容」傳送畀執委（WhatsApp / Signal 都可以）。'}</div>
      <div class="mt-16" style="text-align:left;background:var(--brand-50);border-radius:12px;padding:12px">
        <div class="row-between sm"><span class="muted">${esc(p.itemName)}</span><span class="semibold">×${p.qty}</span></div>
        <div class="xs faint mt-6">${esc(p.fromDate)}${p.toDate ? ` → ${esc(p.toDate)}` : ''} · ${esc(p.purpose)} · ${esc(p.byName)}</div>
      </div>
      <div class="pe-actions">
        <button class="btn btn-primary" data-pb="again">${icon('plus', 16)} 再申請一樣</button>
        <button class="btn" data-pb="copy">${icon('copy', 16)} 複製內容（傳送畀執委）</button>
        <button class="btn btn-ghost" data-pb="print">${icon('print', 16)} 列印 / 儲存 PDF</button>
      </div>
      ${msg ? `<div class="xs faint mt-12">伺服器回應：${esc(msg)}</div>` : ''}
    </div>
  </div>`;

  app.querySelector('[data-pb="again"]')?.addEventListener('click', () => {
    state.itemId = ''; state.qty = 1; state.purpose = ''; state.toDate = '';
    render();
  });
  app.querySelector('[data-pb="copy"]')?.addEventListener('click', async () => {
    if (await copyText(text)) toast('已複製，貼落 WhatsApp 就得', 'ok');
  });
  app.querySelector('[data-pb="print"]')?.addEventListener('click', () => window.print());
  window.scrollTo(0, 0);
}

boot();
