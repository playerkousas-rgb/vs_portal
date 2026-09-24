/* ============================================================
   public-entry.js — 成員手機快速記一筆（entry.html）
   取代原本嘅 Google Form：
     開連結 → 影相 → 揀欄目（分類） → 打金額 → 送出
   送出目的地（依序）：
     1. 旅團設定嘅 Apps Script（settings.publicEntry.submitUrl）
        → 由 Script 寫入總表「待批申報」分頁
     2. 冇設定 → 存喺本機（同一部裝置）＋「複製內容／WhatsApp 傳送」
   ============================================================ */

import { esc, icon, uid, todayISO, toast, copyText } from './lib/util.js';
import { photoPicker, bindPhotoPicker } from './views/ui.js';
import { loadMe, saveMe } from './lib/member-me.js';
import { postBackend, beFromQuery, proxyUsable } from './lib/gateway.js';

/* 「送唔送到總表」唔可以再淨係睇 settings.publicEntry.submitUrl ——
   平台用 Vercel 環境變數登記嘅旅團，公開頁讀唔到任何設定檔，
   嗰格永遠係空，於是明明經 /api/proxy（或者連結帶嘅 ?be=）送得到，
   個頁都係話「會存喺你呢部裝置」。 */
const connected = () => !!(cfg.submitUrl || beFromQuery() || proxyUsable());

const q = new URLSearchParams(location.search);
const app = document.getElementById('app');
let unitCode = q.get('u') || '0082';
let meta = {};
let cfg = {};

const DEFAULT_CATS = {
  expense: ['活動', '交通', '膳食', '物資 / 器材', '場地', '器材維修', '行政 / 印刷', '津貼', '其他'],
  income: ['團費', '活動收費', '捐款 / 贊助', '物資收入', '其他']
};

const state = {
  type: 'expense',
  category: '',
  date: todayISO(),
  amount: '',
  item: '',
  byName: (new URLSearchParams(location.search).get('name') || loadMe().name || ''),
  note: '',
  photos: []
};

const localKey = () => `venture82.entry.${unitCode}`;
const localRows = () => { try { return JSON.parse(localStorage.getItem(localKey()) || '[]'); } catch (e) { return []; } };

async function loadJson(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function boot() {
  try {
    let registry = null, unit = null;
    try { registry = await loadJson('data/units.json'); } catch (e) { /* ignore */ }
    if (registry?.units) {
      if (!q.get('u') && registry.defaultUnit) unitCode = registry.defaultUnit;
      meta = registry.units[unitCode] || {};
    }
    const path = meta.dataPath || `data/units/${unitCode}/`;
    try { unit = await loadJson(path + 'unit.json'); } catch (e) { /* 用 registry 資料 */ }
    if (unit) {
      meta = { ...meta, name: unit.name || meta.name, short: unit.short || meta.short, sponsor: unit.sponsor || meta.sponsor };
      const s = unit.settings || {};
      cfg = {
        submitUrl: s.publicEntry?.submitUrl || s.notice?.submitUrl || registry?.backend?.gasUrl || '',
        cats: s.publicEntry?.categories || null,
        hero: s.publicEntry?.title || '',
        note: s.publicEntry?.note || ''
      };
      if (unitCode !== '0082') { /* 其他旅團用自己嘅設定 */ }
    }
    document.title = `影相記一筆 · ${meta.name || unitCode}`;
    render();
  } catch (e) {
    app.innerHTML = `<div class="pe-wrap"><div class="pe-card">
      <h1 style="font-size:19px">暫時開唔到</h1>
      <p class="sm muted mt-8">技術訊息：<code>${esc(e.message)}</code></p></div></div>`;
  }
}

function cats(type) {
  if (cfg.cats && cfg.cats[type]?.length) return cfg.cats[type];
  return DEFAULT_CATS[type];
}

function render() {
  app.innerHTML = `
  <div class="pe-top">
    <div class="row gap-10">
      <div class="logo">${esc((meta.short || unitCode).slice(0, 3))}</div>
      <div class="grow"><div style="font-weight:800;font-size:16px">${esc(meta.name || unitCode)}</div>
        <div class="xs" style="color:#EBC6CE">${cfg.hero || '手機記一筆 · 影相＋揀欄目就交得'}</div></div>
      ${connected() ? '<span class="badge b-grey" title="已連接旅團總表">已連接總表</span>' : ''}
    </div>
  </div>

  <div class="pe-wrap">
    <form class="pe-card" id="pe-form" novalidate>
      <div class="pe-field">
        <label>① 呢筆係咩？</label>
        <div class="seg-big">
          <button type="button" data-type="expense" aria-pressed="${state.type === 'expense'}">💸 支出（我墊支）</button>
          <button type="button" data-type="income" aria-pressed="${state.type === 'income'}">💰 收入（代收）</button>
        </div>
      </div>

      <div class="pe-field">
        <label>② 影相（單據 / 收據）</label>
        ${photoPicker('pe-photos', { label: '', hint: '手機可以直接影相，相片會自動壓縮。最多 6 張。' })}
      </div>

      <div class="pe-field">
        <label>③ 揀欄目 <span class="req">*</span></label>
        <select class="select" id="pe-cat">
          <option value="">— 請選擇 —</option>
          ${cats(state.type).map(c => `<option ${state.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <div class="pe-err" data-err="category">請揀一個欄目</div>
      </div>

      <div class="row gap-10" style="align-items:flex-start">
        <div class="pe-field grow">
          <label>④ 金額（HK$） <span class="req">*</span></label>
          <input class="input" id="pe-amount" type="number" step="0.01" inputmode="decimal" placeholder="0.00" value="${esc(state.amount)}">
          <div class="pe-err" data-err="amount">請填金額</div>
        </div>
        <div class="pe-field grow">
          <label>日期</label>
          <input class="input" id="pe-date" type="date" value="${esc(state.date)}">
        </div>
      </div>

      <div class="pe-field">
        <label>⑤ 項目內容 <span class="req">*</span></label>
        <input class="input" id="pe-item" placeholder="例：10 月露營場地訂金" value="${esc(state.item)}">
        <div class="pe-err" data-err="item">請簡單寫低係咩費用</div>
      </div>

      <div class="row gap-10" style="align-items:flex-start">
        <div class="pe-field grow">
          <label>你嘅姓名（可喺團員入口先登記） <span class="req">*</span></label>
          <input class="input" id="pe-name" placeholder="例：陳大文" value="${esc(state.byName)}">
          <div class="pe-err" data-err="byName">請填姓名（方便司庫跟進）</div>
        </div>
        <div class="pe-field grow">
          <label>備註（可留空）</label>
          <input class="input" id="pe-note" placeholder="例：$20 為車費" value="${esc(state.note)}">
        </div>
      </div>

      <div class="pe-err" id="pe-err"></div>
      <button class="btn btn-primary pe-big-btn" type="submit">${icon('send', 18)} 送出畀司庫</button>
      <div class="hint mt-10">${connected()
        ? '送出後會<b>直接記錄到旅團總表</b>（待批核），司庫批准就自動入帳。'
        : '送出後會存喺你呢部裝置；按「複製內容」就可以傳送畀司庫。'}</div>
    </form>

    <div class="pe-card no-print">
      <div class="card-title mb-8">${icon('check', 15)} 本機已送出嘅紀錄</div>
      <div id="pe-local" class="sm muted">…</div>
    </div>

    <div class="center xs faint mt-16">公開收集頁 · 由 ${esc(meta.name || '')} 深資童軍管理系統提供</div>
  </div>`;

  bindPhotoPicker(app, 'pe-photos', state, { max: 6 });

  app.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    state.type = b.dataset.type;
    if (!cats(state.type).includes(state.category)) state.category = '';
    render();
  }));

  ['category', 'amount', 'date', 'item', 'byName', 'note'].forEach(k => {
    const el = app.querySelector(k === 'category' ? '#pe-cat' : `#pe-${k === 'byName' ? 'name' : k}`);
    if (!el) return;
    const ev = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(ev, () => {
      state[k] = el.value;
      if (k === 'category' || k === 'item' || k === 'amount' || k === 'byName') {
        el.removeAttribute('aria-invalid');
        const box = app.querySelector(`[data-err="${k}"]`);
        if (box) box.style.display = 'none';
      }
    });
  });

  app.querySelector('#pe-form').addEventListener('submit', submit);
  paintLocal();
}

function paintLocal() {
  const box = app.querySelector('#pe-local');
  if (!box) return;
  const rows = localRows();
  box.innerHTML = rows.length
    ? rows.slice(-5).reverse().map(r => `<div class="row-between" style="padding:6px 0;border-bottom:1px dashed var(--line-2)">
        <span>${esc(r.payload.date)} · ${esc(r.payload.category)} · ${esc(r.payload.item)}</span>
        <span class="money">${esc('HK$' + Number(r.payload.amount || 0).toFixed(2))}</span></div>`).join('')
      + (rows.length > 5 ? `<div class="xs faint mt-6">（另有 ${rows.length - 5} 筆）</div>` : '')
    : '<div class="xs faint">仲未有紀錄。</div>';
}

function validate() {
  const bad = [];
  if (!state.category) bad.push('category');
  if (!(Number(state.amount) > 0)) bad.push('amount');
  if (!String(state.item).trim()) bad.push('item');
  if (!String(state.byName).trim()) bad.push('byName');
  app.querySelectorAll('[data-err]').forEach(el => { el.style.display = 'none'; });
  bad.forEach(k => {
    const box = app.querySelector(`[data-err="${k}"]`);
    if (box) box.style.display = 'block';
    const el = app.querySelector(k === 'category' ? '#pe-cat' : `#pe-${k === 'byName' ? 'name' : k}`);
    el?.setAttribute('aria-invalid', 'true');
  });
  const err = app.querySelector('#pe-err');
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

  const payload = {
    id: uid('pe'),
    type: state.type,
    category: state.category,
    item: String(state.item).trim(),
    amount: Number(state.amount),
    date: state.date || todayISO(),
    byName: String(state.byName).trim(),
    memberId: loadMe().id || q.get('mid') || '',
    note: String(state.note).trim(),
    photos: state.photos.map(p => ({ name: p.name, type: p.type, dataUrl: p.dataUrl })),
    receipt: state.photos.length > 0,
    submittedAt: new Date().toISOString(),
    device: (navigator.userAgent || '').slice(0, 60)
  };

  let delivered = false, uncertain = false, msg = '';
  if (cfg.submitUrl) {
    try {
      const res = await fetch(cfg.submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 避免 CORS preflight
        body: JSON.stringify({ action: 'claim', unit: unitCode, source: '82venture', payload })
      });
      delivered = res.ok;
      msg = (await res.text()).slice(0, 120);
    } catch (err) {
      delivered = false;
      uncertain = true;      // 送出咗，但瀏覽器唔畀讀回應（Apps Script 常見）
      msg = err.message;
    }
  } else {
    /* 冇明確設定嘅送出網址 → 行統一入口（lib/gateway.js）：
       ① 同源 /api/proxy（平台伺服器端登記咗旅團）
       ② 連結帶嘅 ?be=<旅團自己嘅 /exec>（平台未登記時嘅自助路線）
       兩條都唔得先至真的「淨係存喺本機」。 */
    try {
      const r = await postBackend({ action: 'claim', source: '82venture', payload },
        { unit: unitCode, execUrl: beFromQuery(), timeoutMs: 60000 });
      delivered = !!r.ok && r.json?.ok !== false && r.json?.success !== false;
      msg = String(r.error || r.json?.error || '').slice(0, 120);
      if (!delivered && r.via === 'direct') uncertain = true;   // 直打 GAS：可能已收到但讀唔到回應
    } catch (err) {
      delivered = false; uncertain = true; msg = err.message;
    }
  }
  const rows = localRows();
  rows.push({ at: new Date().toISOString(), delivered, uncertain, payload });
  try { localStorage.setItem(localKey(), JSON.stringify(rows.slice(-50))); } catch (err) { /* 相片太大就只記文字 */ }

  done(payload, delivered, msg, uncertain);
}

function done(p, delivered, msg, uncertain = false) {
  const text = `【${meta.name || unitCode} 記帳】\n類型：${p.type === 'expense' ? '支出' : '收入'}\n欄目：${p.category}\n日期：${p.date}\n金額：HK$${p.amount.toFixed(2)}\n項目：${p.item}\n付款人：${p.byName}${p.note ? `\n備註：${p.note}` : ''}${p.photos.length ? `\n（附 ${p.photos.length} 張單據相片）` : ''}`;

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
      <div style="font-weight:800;font-size:18px">已記錄！</div>
      <div class="sm muted mt-6">${delivered
        ? '已直接送到旅團嘅總表，等司庫／領袖批核。'
        : uncertain
          ? '訊息已送出。如果總表冇見到紀錄，請按「複製內容」傳送畀司庫（WhatsApp／Signal 都可以）。'
          : '已存喺你呢部裝置。如果旅團未設定線上總表，請按下面「複製內容」傳送畀司庫（WhatsApp／Signal 都可以）。'}</div>
      <div class="mt-16" style="text-align:left;background:var(--brand-50);border-radius:12px;padding:12px">
        <div class="row-between sm"><span class="muted">${p.type === 'expense' ? '支出' : '收入'} · ${esc(p.category)}</span><span class="money semibold">HK$${p.amount.toFixed(2)}</span></div>
        <div class="xs faint mt-6">${esc(p.date)} · ${esc(p.item)} · ${esc(p.byName)}${p.photos.length ? ` · ${p.photos.length} 張相` : ''}</div>
      </div>
      <div class="pe-actions">
        <button class="btn btn-primary" data-pe="again">${icon('plus', 16)} 再記一筆</button>
        <button class="btn" data-pe="copy">${icon('copy', 16)} 複製內容（傳送畀司庫）</button>
        <button class="btn btn-ghost" data-pe="print">${icon('print', 16)} 列印 / 儲存 PDF</button>
      </div>
      ${msg ? `<div class="xs faint mt-12">伺服器回應：${esc(msg)}</div>` : ''}
    </div>
    <div class="center xs faint mt-16">多謝！單據相片已包含喺紀錄內。</div>
  </div>`;

  app.querySelector('[data-pe="again"]')?.addEventListener('click', () => {
    state.category = ''; state.amount = ''; state.item = ''; state.note = ''; state.photos = [];
    render();
  });
  app.querySelector('[data-pe="copy"]')?.addEventListener('click', async () => {
    if (await copyText(text)) toast('已複製，貼落 WhatsApp 就得', 'ok');
  });
  app.querySelector('[data-pe="print"]')?.addEventListener('click', () => window.print());

  window.scrollTo(0, 0);
}

boot();
