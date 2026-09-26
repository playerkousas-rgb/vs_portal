/* ============================================================
   finance.js — 財務系統
   帳目 · 雙財政年度報告（旅年度 AGM–AGM ／ 童軍年度 4/1–3/31）
   團費追蹤 · 收支申報（取代 Google Form）· 活動預算 · 匯入舊帳
   ============================================================ */

import { collection, add, update, remove, commit, load, find } from '../lib/store.js';
import {
  tx, claims, fees, budgets, categories, methods, money, sumBy, balance, balanceAt,
  feeSummary, overdueFees, pendingClaims, monthStats, allMonths, memberName, member,
  activeMembers, members, settings, profile, publicPageUrl, listYears, scoutFYRange, unitFYRange, unitFYOf,
  summarize, openingBalance, currentBalance, balanceBreakdown, currency, agmIsDefault, setAgmDate, lastSaturdayOfAugust,
  openingOf, openingBalances, legacyOpening, currentFY, currentFYRange, prevFYKey, yearRange, refYearKey, carriedForward,
  feePeriodOf, feePeriods, feeOf, feeGrid, feeStats, matchMemberByName,
  standardFee, overseasFee, defaultFeeDue, feeForYear,
  inRange, fyMonths, fyMonthStats, monthText, categoryBreakdown, feeExempt, feeExemptList, identityOf
} from '../lib/model.js';
import { todayISO, nowStamp } from '../lib/dates.js';
import { esc, icon, fmtDate, modal, confirmDlg, toast, uid, nf, copyText, avatar, download, qrSvg } from '../lib/util.js';
import { toCSV, toWord, printDoc, downloadQrSvg, download as dlFile, stamp } from '../lib/exporter.js';
import { go, parse, setQuery } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, kv, chipbar, noteBox, photoPicker, photoStrip, bindPhotoPicker } from './ui.js';
import { compressImage, formatBytes, downloadPhotos } from '../lib/files.js';
import { bindDraftAutosave, readDraft, applyDraft, saveDraft, clearDraft, draftBanner } from '../lib/guard.js';

let tab = 'ledger';
let fMonth = '';
let ledgerMode = 'overview';   // 帳目（本年度）：'overview' 總覽 ／ 'month' 按月
let histYear = '';             // 過往紀錄：年度
let histMonth = '';            // 過往紀錄：'' = 全年，其他 = 'YYYY-MM'
let fType = 'all';
let fCat = 'all';
let fKw = '';
let scoutPick = null;
let unitPick = null;
let feePeriod = '';
let claimFilter = 'pending';

export function title() { return '財務'; }

export function render(params) {
  const id = params.id;
  if (id === 'new') return txPage(null);
  if (id === 'edit') return txPage(params.action);
  if (['reports', 'fees', 'claims', 'budgets', 'import', 'settings', 'history'].includes(id)) tab = id;
  else if (id !== 'new' && id !== 'edit') tab = params?.query?.tab || 'ledger';
  if (params.query?.period) feePeriod = params.query.period;

  const fy = currentFY();
  const header = pageHead({
    title: '財務',
    sub: `${profile().name || ''} · ${fy} 年度 · 現在結餘 ${money(currentBalance())}（期初 ${money(openingBalance().amount)} ＋ 收入 ${money(sumBy(tx(), 'income'))} − 支出 ${money(sumBy(tx(), 'expense'))}）`,
    actions: `
      ${can('finance.create') ? `<button class="btn btn-sm btn-primary" data-act="add">${icon('plus', 15)} 新增收支</button>` : ''}
      <button class="btn btn-sm" data-go="#/finance/reports">${icon('chart', 15)} 年結報告</button>
      <button class="btn btn-sm" data-go="#/finance/claims">${icon('note', 15)} 申報${pendingClaims().length ? `（${pendingClaims().length}）` : ''}</button>`
  });

  return `${header}
  ${tabs([
    ['ledger', `帳目（${fy}）`, txInYear(fy).length],
    ['history', '過往紀錄'],
    ['reports', '財政年度報告'],
    ['fees', '團費', feeStats().unpaidCount],
    ['claims', '收支申報', pendingClaims().length],
    ['budgets', '活動預算', budgets().length],
    ['import', '匯入舊帳'],
    ['settings', '設定']
  ], tab)}
  ${tab === 'reports' ? reportsView()
    : tab === 'fees' ? feesView()
    : tab === 'claims' ? claimsView()
    : tab === 'budgets' ? budgetsView()
    : tab === 'import' ? importView()
    : tab === 'settings' ? settingsView()
    : tab === 'history' ? historyView()
    : ledgerView()}`;
}

/* ============================================================
   1. 帳目（**本年度**紀錄；可以睇總覽，亦可以按月睇）
   ------------------------------------------------------------
   2026-09-16 團長要求：
     · 呢一頁只睇「本年度」帳目，唔會同上年度混在一起
     · 可以睇總覽（12 個月一覽），亦可以只睇某一個月
     · **冇紀錄嘅月份都要揀得到**（月份清單由年度砌出，唔係由帳目反推）
   ============================================================ */
/** 本年度帳目 */
function txInYear(yearKey = currentFY()) {
  const r = yearRange(yearKey);
  return tx().filter(t => inRange(t.date, r.start, r.end));
}

function applyFilters(list) {
  let out = list.slice();
  if (fType !== 'all') out = out.filter(t => t.type === fType);
  if (fCat !== 'all') out = out.filter(t => t.category === fCat);
  if (fKw) {
    const k = fKw.toLowerCase();
    out = out.filter(t => (t.item + ' ' + (t.category || '') + ' ' + (t.byName || '') + ' ' + (t.ref || '') + ' ' + (t.note || '')).toLowerCase().includes(k));
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
}

function filterBar({ withMonth = false, monthValue = '', monthOptions = [], monthAttr = 'data-month', withMode = false } = {}) {
  const cats = categories('income').concat(categories('expense'));
  return `
  <div class="row-between wrap gap-12 mb-16 no-print">
    <div class="toolbar">
      ${withMode ? `<div class="seg" style="margin:0">
        <button data-ledger-mode="overview" aria-selected="${ledgerMode === 'overview'}">總覽</button>
        <button data-ledger-mode="month" aria-selected="${ledgerMode === 'month'}">按月</button>
      </div>` : ''}
      ${withMonth ? `<select class="select" id="${monthAttr === 'data-hist-month' ? 'histMonth' : 'fMonth'}" style="width:auto">
        ${monthOptions.map(([v, label]) => `<option value="${v}" ${monthValue === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>` : ''}
      <select class="select" id="fType" style="width:auto">
        <option value="all">全部類型</option>
        <option value="income" ${fType === 'income' ? 'selected' : ''}>收入</option>
        <option value="expense" ${fType === 'expense' ? 'selected' : ''}>支出</option>
      </select>
      <select class="select" id="fCat" style="width:auto">
        <option value="all">全部分類</option>
        ${[...new Set(cats)].map(c => `<option value="${esc(c)}" ${fCat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <div class="search-wrap"><span class="ic">${icon('search', 15)}</span>
        <input class="input" id="fKw" placeholder="搜尋項目／經手人／單據" value="${esc(fKw)}"></div>
    </div>
    <div class="row gap-8 wrap">
      <button class="btn btn-sm" data-fields="transactions" title="改名／加欄位（例：收據編號）">${icon('table', 15)} 欄位</button>
      <button class="btn btn-sm" data-act="exp-csv">${icon('download', 15)} CSV</button>
      <button class="btn btn-sm" data-act="exp-word">${icon('download', 15)} Word</button>
      <button class="btn btn-sm" data-act="exp-pdf">${icon('print', 15)} PDF</button>
    </div>
  </div>`;
}

function ledgerTable(list) {
  const inc = sumBy(list, 'income'), exp = sumBy(list, 'expense');
  if (!list.length) return empty('wallet', '呢個範圍未有帳目', '可以按「新增收支」記一筆，或者去「匯入舊帳」');
  return `<div class="scroll-x"><table class="table">
    <thead><tr><th style="width:96px">日期</th><th>項目</th><th>分類</th><th>方式 / 經手</th>
      <th class="right">收入</th><th class="right">支出</th><th></th></tr></thead>
    <tbody>${list.map(t => `<tr data-open="${t.id}" style="cursor:pointer">
      <td class="mono sm">${esc(String(t.date).slice(5))}</td>
      <td><div class="semibold">${esc(t.item)}</div>
        ${t.note || t.ref ? `<div class="xs faint">${esc(t.ref || '')}${t.ref && t.note ? ' · ' : ''}${esc(t.note || '')}</div>` : ''}</td>
      <td><span class="tag">${esc(t.category || '其他')}</span></td>
      <td class="sm">${esc(t.method || '')}${t.byName || t.by ? `<div class="xs faint">${esc(t.byName || memberName(t.by))}</div>` : ''}
        ${t.receipt ? '<div class="xs" style="color:var(--ok)">✓ 有單據</div>' : '<div class="xs faint">未收單據</div>'}</td>
      <td class="money income">${t.type === 'income' ? money(t.amount) : ''}</td>
      <td class="money expense">${t.type === 'expense' ? money(t.amount) : ''}</td>
      <td class="right"><div class="row-actions">
        ${can('finance.edit', t) ? `<button class="btn btn-xs btn-ghost" data-edit="${t.id}">${icon('edit', 13)}</button>` : ''}
        ${can('finance.delete') ? `<button class="btn btn-xs btn-ghost" data-del="${t.id}">${icon('trash', 13)}</button>` : ''}
      </div></td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4" class="right">合計</td><td class="money income">${money(inc)}</td>
      <td class="money expense">${money(exp)}</td><td></td></tr>
      <tr><td colspan="4" class="right">淨額</td><td colspan="2" class="money" style="color:${inc - exp >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(inc - exp)}</td><td></td></tr></tfoot>
  </table></div>`;
}

/** 12 個月一覽（包括冇紀錄嘅月份，每行都可以撳入去睇） */
function monthOverview(yearKey, { attr = 'data-fy-month' } = {}) {
  const rows = fyMonthStats(yearKey);
  const total = rows.reduce((a, r) => ({ income: a.income + r.income, expense: a.expense + r.expense, count: a.count + r.count }), { income: 0, expense: 0, count: 0 });
  return `<div class="scroll-x"><table class="table table-compact">
    <thead><tr><th>月份</th><th class="right">筆數</th><th class="right">收入</th><th class="right">支出</th><th class="right">淨額</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="sm ${r.count ? 'semibold' : 'faint'}">${esc(r.label)}</td>
      <td class="right sm ${r.count ? '' : 'faint'}">${r.count || '—'}</td>
      <td class="money income">${r.income ? money(r.income) : ''}</td>
      <td class="money expense">${r.expense ? money(r.expense) : ''}</td>
      <td class="money" style="color:${r.net > 0 ? 'var(--ok)' : r.net < 0 ? 'var(--danger)' : 'inherit'}">${r.count ? money(r.net) : ''}</td>
      <td class="right"><button class="btn btn-xs ${r.count ? '' : 'btn-ghost'}" ${attr}="${r.month}">${r.count ? '查看' : '冇紀錄'}</button></td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td>全年合計</td><td class="right">${total.count} 筆</td>
      <td class="money income">${money(total.income)}</td><td class="money expense">${money(total.expense)}</td>
      <td class="money">${money(total.income - total.expense)}</td><td></td></tr></tfoot>
  </table></div>`;
}

function categoryPanel(list) {
  const inc = sumBy(list, 'income'), exp = sumBy(list, 'expense');
  const incCats = categoryBreakdown(list, 'income');
  const expCats = categoryBreakdown(list, 'expense');
  return `<div class="grid g-2 mt-16" style="gap:14px">
    <div>
      <div class="sm semibold mb-8">收入分類</div>
      ${incCats.length ? incCats.map(([c, v]) => catRow(c, v, inc, 'ok')).join('') : '<div class="faint sm">冇收入</div>'}
    </div>
    <div>
      <div class="sm semibold mb-8">支出分類</div>
      ${expCats.length ? expCats.map(([c, v]) => catRow(c, v, exp, 'danger')).join('') : '<div class="faint sm">冇支出</div>'}
    </div>
  </div>`;
}

function ledgerView() {
  const fy = currentFY();
  const range = yearRange(fy);
  const yearTx = txInYear(fy);
  const opening = openingOf(fy, range);
  const months = fyMonths(fy);
  const monthKeys = new Set(yearTx.map(t => String(t.date).slice(0, 7)));
  if (ledgerMode === 'month' && (!fMonth || !months.includes(fMonth))) {
    fMonth = months.filter(m => monthKeys.has(m)).pop() || months[0];
  }
  const list = ledgerMode === 'month' ? applyFilters(yearTx.filter(t => String(t.date).slice(0, 7) === fMonth)) : applyFilters(yearTx);
  const inc = sumBy(list, 'income'), exp = sumBy(list, 'expense');
  const yInc = sumBy(yearTx, 'income'), yExp = sumBy(yearTx, 'expense');

  return `
  <div class="grid g-5 mb-16">
    ${stat('期初結餘', money(opening.amount), `${esc(fy)} 年度開始時嘅結餘（上年度結轉，唔計入收入）`)}
    ${stat(`${ledgerMode === 'month' ? monthText(fMonth) : fy + ' 年度'}收入`, money(inc), `${list.filter(t => t.type === 'income').length} 筆`, 'ok')}
    ${stat('支出', money(exp), `${list.filter(t => t.type === 'expense').length} 筆`, 'danger')}
    ${stat('淨額', money(inc - exp), '所選範圍', inc - exp >= 0 ? 'ok' : 'danger')}
    ${stat('現在結餘', money(opening.amount + yInc - yExp), `期初 ${money(opening.amount)} ＋ 本年度收入 ${money(yInc)} − 本年度支出 ${money(yExp)} · 全年 ${yearTx.length} 筆`, opening.amount + yInc - yExp < 0 ? 'danger' : '')}
  </div>

  <div class="note-box mb-16">${icon('wallet', 15)}<div>
    <b>呢一頁只係 ${esc(fy)} 年度（${esc(range.start)} 至 ${esc(range.end)}）嘅紀錄</b>，上年度數唔會混入嚟。
    期初結餘 ${money(opening.amount)} 係<b>上年度結轉</b>，屬於「已有嘅錢」，<b>唔計入收入</b> ——
    收入只計呢一年真正收到嘅錢，所以睇年結報告唔會覺得「收入好多但錢唔見咗」。<br>
    <span class="xs">想睇以前年度：去「<b>過往紀錄</b>」揀年度再揀月份。</span>
  </div></div>

  ${filterBar({
    withMode: true,
    withMonth: ledgerMode === 'month',
    monthValue: fMonth,
    monthOptions: [['', '（揀月份）']].concat(months.map(m => [m, `${monthText(m)}${monthKeys.has(m) ? `（${yearTx.filter(t => String(t.date).slice(0, 7) === m).length} 筆）` : '（冇紀錄）'} `]))
  })}

  ${ledgerMode === 'month' ? `
    <div class="card mb-16">
      <div class="card-head"><div><div class="card-title">${esc(monthText(fMonth))} 帳目</div>
        <div class="card-sub">${list.length} 筆 · 收入 ${money(inc)} · 支出 ${money(exp)} · 淨額 ${money(inc - exp)}</div></div>
        <button class="btn btn-sm" data-ledger-mode="overview">${icon('chevronL', 15)} 返總覽</button></div>
      ${ledgerTable(list)}
    </div>
    ${categoryPanel(list)}`
  : `
    <div class="card mb-16">
      <div class="card-head"><div><div class="card-title">${esc(fy)} 年度 · 逐月總覽</div>
        <div class="card-sub">12 個月（包括冇紀錄嘅月份）都可以撳入去睇</div></div>
        <div class="row gap-8"><span class="badge b-grey">全年 ${yearTx.length} 筆</span></div></div>
      ${monthOverview(fy)}
    </div>
    ${categoryPanel(yearTx)}
    <div class="card mt-16">
      <div class="card-head"><div><div class="card-title">${esc(fy)} 年度全部帳目${fType !== 'all' || fCat !== 'all' || fKw ? '（已篩選）' : ''}</div>
        <div class="card-sub">${list.length} 筆</div></div></div>
      ${ledgerTable(list)}
    </div>`}`;
}

/* ============================================================
   1b. 過往紀錄（先揀年度 → 再揀月份）
   ============================================================ */
function historyView() {
  const years = listYears(tx(), settings()).scout;
  const keys = years.map(y => y.key);
  if (!histYear || !keys.includes(histYear)) {
    // 預設：上一個年度；如果冇就用最舊嘅一個
    histYear = keys[1] || keys[0];
  }
  const range = yearRange(histYear);
  const months = fyMonths(histYear);
  const yearTx = tx().filter(t => inRange(t.date, range.start, range.end));
  const monthKeys = new Set(yearTx.map(t => String(t.date).slice(0, 7)));
  const inMonth = histMonth ? yearTx.filter(t => String(t.date).slice(0, 7) === histMonth) : yearTx;
  const list = applyFilters(inMonth);
  const inc = sumBy(list, 'income'), exp = sumBy(list, 'expense');
  const yInc = sumBy(yearTx, 'income'), yExp = sumBy(yearTx, 'expense');
  const opening = openingOf(histYear, range);

  return `
  <div class="note-box mb-16">${icon('clock', 15)}<div>
    <b>過往紀錄</b>：先揀<b>年度</b>，再揀<b>月份</b>（月份可以係冇紀錄嘅，照樣揀得到）。
    呢度係<b>唯讀</b>嘅歷史查閱；要改資料可以撳入去任何一筆帳目。
  </div></div>

  <div class="row-between wrap gap-12 mb-16 no-print">
    <div class="toolbar">
      <select class="select" id="histYear" style="width:auto">
        ${years.map(y => `<option value="${esc(y.key)}" ${histYear === y.key ? 'selected' : ''}>${esc(y.key)}（${esc(y.start)} 至 ${esc(y.end)}）</option>`).join('')}
      </select>
      <select class="select" id="histMonth" style="width:auto">
        <option value="">全年度（12 個月）</option>
        ${months.map(m => `<option value="${m}" ${histMonth === m ? 'selected' : ''}>${esc(monthText(m))}${monthKeys.has(m) ? `（${yearTx.filter(t => String(t.date).slice(0, 7) === m).length} 筆）` : '（冇紀錄）'}</option>`).join('')}
      </select>
      <button class="btn btn-sm" data-hist-jump="cur">${icon('refresh', 15)} 返本年度</button>
    </div>
    <div class="row gap-8 wrap">
      <button class="btn btn-sm" data-act="exp-csv">${icon('download', 15)} CSV</button>
      <button class="btn btn-sm" data-act="exp-word">${icon('download', 15)} Word</button>
      <button class="btn btn-sm" data-act="exp-pdf">${icon('print', 15)} PDF</button>
    </div>
  </div>

  <div class="grid g-4 mb-16">
    ${stat('期初結餘', money(opening.amount), '上年度結轉（唔計入收入）')}
    ${stat('收入', money(yInc), `${yearTx.filter(t => t.type === 'income').length} 筆 · 全年`, 'ok')}
    ${stat('支出', money(yExp), `${yearTx.filter(t => t.type === 'expense').length} 筆 · 全年`, 'danger')}
    ${stat('期末結餘', money(opening.amount + yInc - yExp), `${histYear} 年度`, opening.amount + yInc - yExp < 0 ? 'danger' : '')}
  </div>

  ${filterBar({ withMonth: false })}

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">${esc(histYear)} 年度 · 逐月一覽</div>
      <div class="card-sub">全年 ${yearTx.length} 筆</div></div></div>
    ${monthOverview(histYear, { attr: 'data-hist-month' })}
  </div>

  <div class="card">
    <div class="card-head"><div><div class="card-title">${histMonth ? esc(monthText(histMonth)) : `${esc(histYear)} 年度全部`} 帳目</div>
      <div class="card-sub">${list.length} 筆 · 收入 ${money(inc)} · 支出 ${money(exp)} · 淨額 ${money(inc - exp)}</div></div></div>
    ${ledgerTable(list)}
  </div>`;
}


/* ---------- 新增 / 編輯收支 ---------- */
function txPage(id) {
  const t = id ? find('transactions', id) : null;
  return `
  ${pageHead({ title: t ? '編輯帳目' : '新增收支', sub: t ? `${t.date} · ${t.item}` : '記一筆收入或支出',
    actions: `<button class="btn btn-sm" data-go="#/finance">${icon('chevronL', 15)} 返回</button>` })}
  <div class="card" style="max-width:720px"><div style="padding:20px">
    <div class="grid g-2" style="gap:14px">
      <div class="field"><label class="label">類型 <span class="req">*</span></label>
        <select class="select" id="t-type">
          <option value="income" ${t?.type === 'income' ? 'selected' : ''}>收入</option>
          <option value="expense" ${t?.type === 'expense' ? 'selected' : ''}>支出</option>
        </select></div>
      <div class="field"><label class="label">金額 <span class="req">*</span></label>
        <input class="input" id="t-amount" type="number" step="0.01" min="0" value="${t?.amount ?? ''}" placeholder="0.00"></div>
      <div class="field"><label class="label">日期 <span class="req">*</span></label>
        <input class="input" id="t-date" value="${esc(t?.date || todayISO())}"></div>
      <div class="field"><label class="label">分類</label>
        <select class="select" id="t-cat"></select></div>
      <div class="field" style="grid-column:1/-1"><label class="label">項目 <span class="req">*</span></label>
        <input class="input" id="t-item" value="${esc(t?.item || '')}" placeholder="例：團費 / 場地租金"></div>
      <div class="field"><label class="label">收付方式</label>
        <select class="select" id="t-method">
          ${methods().map(m => `<option ${t?.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select></div>
      <div class="field"><label class="label">相關團員 / 經手人</label>
        <select class="select" id="t-member">
          <option value="">—</option>
          ${members().map(m => `<option value="${m.id}" ${t?.by === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label class="label">單據號碼</label>
        <input class="input" id="t-ref" value="${esc(t?.ref || '')}" placeholder="例：FPS-001"></div>
      <div class="field"><label class="label">有單據？</label>
        <label class="check" style="height:38px"><input type="checkbox" id="t-receipt" ${t?.receipt ? 'checked' : ''}> 已收到單據 / 收據</label></div>
      <div class="field" style="grid-column:1/-1"><label class="label">備註</label>
        <input class="input" id="t-note" value="${esc(t?.note || '')}"></div>
    </div>
    <div id="t-err" class="err mt-8"></div>
    <button class="btn btn-primary mt-16" data-act="save-tx" data-id="${id || ''}">${icon('save', 16)} ${t ? '儲存' : '新增帳目'}</button>
  </div></div>`;
}

function fillCats(root, type, selected) {
  const sel = root.querySelector('#t-cat');
  if (!sel) return;
  sel.innerHTML = categories(type).map(c => `<option ${selected === c ? 'selected' : ''}>${esc(c)}</option>`).join('') +
    `<option value="其他" ${selected === '其他' ? 'selected' : ''}>其他</option>`;
}

/* ============================================================
   2. 財政年度報告（兩條數）
   ============================================================ */
function reportsView() {
  const years = listYears(tx(), settings());
  const s = settings();
  const scout = scoutPick ? scoutFYRange(scoutPick, Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1))
    : scoutFYRange(years.scout[0].key, Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1));
  const unit = unitPick ? unitFYRange(unitPick, s.agmDates) : unitFYRange(years.unit[0].key, s.agmDates);
  const sSum = summarize(tx(), scout);
  const uSum = summarize(tx(), unit);
  const sOpen = openingOf(scout.key, scout).amount, uOpen = openingOf(unit.key, unit).amount;

  const agmYear = Number(unit.key.split('-')[0]);
  const agmUnconfirmed = agmIsDefault(agmYear, s.agmDates);

  return `
  ${agmUnconfirmed && can('finance.edit') ? `
  <div class="banner warn mb-16 no-print">${icon('alert', 16)}
    <div class="grow"><b>${agmYear} 年 AGM 日期仲未確認</b>（現時用 ${esc(unit.start)}，即「8 月最後一個星期六」推算）。
      旅年度報告會用呢個日期起計，請按實際 AGM 日期更新。</div>
    <button class="btn btn-sm" data-act="agm">${icon('calendar', 15)} 逐年輸入 AGM 日期</button>
  </div>` : ''}

  <div class="note-box mb-16">${icon('chart', 15)}<div>
    <b>本系統特色：兩條數。</b>旅團（童軍）財政年度係 <b>每年 4 月 1 日至 3 月 31 日</b>；
    但本團屬自務自治，旅嘅財政年度由<b>當年 AGM 起計</b>到下屆 AGM 前一日。所以同一批帳目會有兩個結論，
    下面兩份報告可以分別輸出，亦可以合併成一份 Word／PDF。</div></div>

  <div class="grid g-2-1">
    <div class="col gap-16">
      ${reportBlock({
        kind: '旅財政年度（AGM 起計）', range: unit, sum: uSum, open: uOpen,
        picker: years.unit.map(r => [r.key, `${r.key}（AGM ${r.start}）`]), pick: unit.key, attr: 'data-unit-year'
      })}
      ${reportBlock({
        kind: '童軍（旅團）財政年度（4/1–3/31）', range: scout, sum: sSum, open: sOpen,
        picker: years.scout.map(r => [r.key, `${r.key}（${r.start} 至 ${r.end}）`]), pick: scout.key, attr: 'data-scout-year'
      })}
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">兩條數對照</div></div>
        <div style="padding:16px 18px">
          <div class="scroll-x"><table class="table table-compact">
            <thead><tr><th>項目</th><th class="right">旅年度</th><th class="right">童軍年度</th></tr></thead>
            <tbody>
              <tr class="row-sep"><td class="sm"><b>上年度結餘</b>（期初）<div class="xs faint">唔計入收入</div></td>
                <td class="money">${money(uOpen)}</td><td class="money">${money(sOpen)}</td></tr>
              <tr><td class="sm">本年度收入</td><td class="money income">${money(uSum.income)}</td><td class="money income">${money(sSum.income)}</td></tr>
              <tr><td class="sm">本年度支出</td><td class="money expense">${money(uSum.expense)}</td><td class="money expense">${money(sSum.expense)}</td></tr>
              <tr><td class="sm semibold">本年度淨額</td><td class="money">${money(uSum.net)}</td><td class="money">${money(sSum.net)}</td></tr>
              <tr class="row-sep"><td class="sm semibold">期末結餘</td><td class="money">${money(uOpen + uSum.net)}</td><td class="money">${money(sOpen + sSum.net)}</td></tr>
              <tr><td class="sm">帳目筆數</td><td class="money">${uSum.count}</td><td class="money">${sSum.count}</td></tr>
            </tbody>
          </table></div>
          <div class="xs faint mt-8">＊上年度結餘同收入<b>分開列</b>（上年度嘅錢已經係「袋住嘅錢」，唔係本年度收入）。<br>
            ＊兩段期間可能重疊（AGM 之後到 3 月 31 日），所以同一筆帳目可以同時出現在兩份報告。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">輸出</div></div>
        <div style="padding:14px 16px" class="col gap-8">
          <button class="btn btn-primary btn-block" data-act="exp-report-word">${icon('download', 16)} Word（兩份報告一份文件）</button>
          <button class="btn btn-block" data-act="exp-report-pdf">${icon('print', 16)} PDF / 列印</button>
          <button class="btn btn-block" data-act="exp-report-csv">${icon('download', 16)} CSV（逐筆帳目）</button>
          <button class="btn btn-block" data-act="exp-report-unit">${icon('download', 16)} 只輸出旅年度報告</button>
          <button class="btn btn-block" data-act="exp-report-scout">${icon('download', 16)} 只輸出童軍年度報告</button>
          <button class="btn btn-block" data-act="exp-all-csv">${icon('download', 16)} 匯出全部帳目 CSV</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">設定</div></div>
        <div style="padding:16px 18px">
          ${kv([
            ['期初結餘', money(openingBalance().amount) + (openingBalance().date ? ` <span class="faint xs">(${esc(openingBalance().date)})</span>` : '')],
            ['童軍年度', `${s.scoutFYStartMonth || 4} 月 ${s.scoutFYStartDay || 1} 日 開始`],
            ['AGM 日期', (s.agmDates || []).filter(a => a.date).map(a => `<span class="tag">${esc(a.date)}</span>`).join(' ') || '<span class="faint">未設定</span>']
          ])}
          ${can('finance.edit') ? `<button class="btn btn-sm btn-block mt-12" data-act="agm">${icon('calendar', 15)} 逐年輸入 AGM 日期</button>
            <button class="btn btn-sm btn-block mt-8" data-act="settings">${icon('settings', 15)} 修改設定（期初／團費／單據 Drive）</button>` : ''}
        </div>
      </div>
    </div>
  </div>`;
}

function reportBlock({ kind, range, sum, open, picker, pick, attr }) {
  const close = open + sum.net;
  return `
  <div class="card">
    <div class="card-head">
      <div><div class="card-title">${esc(kind)}</div>
        <div class="card-sub">${esc(range.title)} · ${esc(range.sub)}</div></div>
      <select class="select" ${attr} style="width:auto">
        ${picker.map(([k, label]) => `<option value="${k}" ${pick === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
    </div>
    <div style="padding:16px 18px">
      <div class="scroll-x"><table class="table table-compact">
        <tbody>
          <tr class="row-sep"><td class="sm"><b>上年度結餘（期初）</b></td>
            <td class="money" style="width:150px"><b>${money(open)}</b></td>
            <td class="xs faint" style="width:190px">上年度結轉過嚟嘅錢 —— <b>唔計入收入</b></td></tr>
          <tr><td class="sm" style="padding-left:22px">本年度收入</td>
            <td class="money income">${money(sum.income)}</td>
            <td class="xs faint">${sum.rows.filter(t => t.type === 'income').length} 筆</td></tr>
          <tr><td class="sm" style="padding-left:22px">本年度支出</td>
            <td class="money expense">${money(sum.expense)}</td>
            <td class="xs faint">${sum.rows.filter(t => t.type === 'expense').length} 筆</td></tr>
          <tr><td class="sm"><b>本年度淨額</b>（收入 − 支出）</td>
            <td class="money" style="color:${sum.net >= 0 ? 'var(--ok)' : 'var(--danger)'}"><b>${money(sum.net)}</b></td>
            <td class="xs faint">未計上年度結餘</td></tr>
          <tr class="row-sep"><td class="sm"><b>期末結餘</b></td>
            <td class="money" style="color:var(--brand-700)"><b>${money(close)}</b></td>
            <td class="xs faint">＝ 期初 ${money(open)} ＋ 淨額 ${money(sum.net)}</td></tr>
        </tbody>
      </table></div>
      <div class="xs faint mt-8">
        ＊上年度結餘同收入<b>分開列</b>，唔會混在一起：收入只計呢段期間真正收到嘅錢。
      </div>

      <div class="grid g-2 mt-16" style="gap:14px">
        <div>
          <div class="sm semibold mb-8">收入分類</div>
          ${sum.byCategory('income').length ? sum.byCategory('income').map(([c, v]) => catRow(c, v, sum.income, 'ok')).join('') : '<div class="faint sm">冇收入</div>'}
        </div>
        <div>
          <div class="sm semibold mb-8">支出分類</div>
          ${sum.byCategory('expense').length ? sum.byCategory('expense').map(([c, v]) => catRow(c, v, sum.expense, 'danger')).join('') : '<div class="faint sm">冇支出</div>'}
        </div>
      </div>

      ${sum.byMonth.length ? `<div class="mt-16">
        <div class="sm semibold mb-8">逐月</div>
        <div class="scroll-x"><table class="table table-compact">
          <thead><tr><th>月份</th><th class="right">收入</th><th class="right">支出</th><th class="right">淨額</th></tr></thead>
          <tbody>${sum.byMonth.map(m => `<tr><td class="mono sm">${esc(m.month)}</td>
            <td class="money income">${money(m.income)}</td><td class="money expense">${money(m.expense)}</td>
            <td class="money" style="color:${m.net >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(m.net)}</td></tr>`).join('')}</tbody>
        </table></div></div>` : ''}
    </div>
  </div>`;
}

function catRow(c, v, total, tone) {
  const p = total ? Math.round(v / total * 100) : 0;
  return `<div style="margin-bottom:9px">
    <div class="row-between xs"><span>${esc(c)}</span><span class="mono">${money(v)} · ${p}%</span></div>
    <div class="bar ${tone === 'danger' ? 'danger' : ''}"><span style="width:${p}%"></span></div>
  </div>`;
}

/* ============================================================
   3. 團費
   ============================================================ */
function feesView() {
  const period = feePeriod || feePeriodOf(todayISO());
  const st = feeStats(period);
  const rows = st.rows;
  const periods = feePeriods();
  const exempt = feeExemptList();     // 免收團費（領袖等）

  return `
  <div class="grid g-4 mb-16">
    ${stat('應收團費', money(st.expected), `${st.total} 位團員 · 標準 ${money(standardFee(period))}／年${overseasFee() !== standardFee(period) ? `（海外 ${money(overseasFee())}）` : ''}`)}
    ${stat('已收', money(st.collected), `${st.paidCount} / ${st.total} 人（${st.rate}%）`, 'ok')}
    ${stat('未收', money(st.outstanding), `${st.unpaidCount} 人未交`, st.unpaidCount ? 'warn' : 'ok')}
    ${stat('逾期', String(st.overdue), st.noRecord ? `另有 ${st.noRecord} 人未建立紀錄` : (st.overdue ? '需要追收' : '冇逾期'), st.overdue ? 'danger' : 'ok')}
  </div>

  <div class="row-between wrap gap-12 mb-16 no-print">
    <div class="toolbar">
      <select class="select" id="feePeriod" style="width:auto">
        ${periods.map(p => `<option value="${esc(p)}" ${period === p ? 'selected' : ''}>${esc(p)} 年度</option>`).join('')}
      </select>
      ${can('fee.edit') ? `<button class="btn btn-sm" data-act="fee-settings">${icon('settings', 15)} 團費金額設定</button>` : ''}
      ${can('fee.edit') ? `<button class="btn btn-sm" data-act="gen-fees">${icon('plus', 15)} 開新年度團費</button>` : ''}
      ${can('fee.mark') ? `<button class="btn btn-sm" data-act="mark-all-paid">${icon('check', 15)} 一鍵全部標記已收</button>` : ''}
    </div>
    <div class="row gap-8 wrap">
      <button class="btn btn-sm" data-act="copy-unpaid">${icon('copy', 15)} 複製催繳名單</button>
      <button class="btn btn-sm" data-act="exp-fee-word">${icon('download', 15)} Word</button>
      <button class="btn btn-sm" data-act="exp-fee-csv">${icon('download', 15)} CSV</button>
    </div>
  </div>

  <div class="note-box mb-16">${icon('wallet', 15)}<div>
    團費<b>每年每人 ${money(standardFee())}</b>${overseasFee() !== standardFee() ? `（海外／優惠 ${money(overseasFee())}）` : ''}
    —— <b>銀碼唔係寫死</b>，可以喺「團費金額設定」改，亦可以逐個團員改（新入團按月、海外團員 1/4 等）。
    喺下面按「未收」→ 改「已收」就會自動喺帳目加一筆收入（同一日、分類「團費」），
    唔使再入兩次；按錯可以「取消收款」，相關帳目會一齊撤銷。
    ${exempt.length ? `<div class="xs mt-4" style="color:var(--ok)">✓ <b>領袖免收團費</b>：${esc(exempt.map(m => m.name).join('、'))} —— 已經自動排除喺收費表之外，唔會再有逾期提示。</div>` : ''}</div></div>

  <div class="card">
    <div class="card-head"><div>
      <div class="card-title">${esc(period)} 年度團費收款表</div>
      <div class="card-sub">${st.paidCount} / ${st.total} 人已交 · 已收 ${money(st.collected)} · 未收 ${money(st.outstanding)}</div></div>
    </div>
    <div class="scroll-x"><table class="table">
      <thead><tr><th>團員</th><th class="right">金額</th><th>狀態</th><th>繳費日期</th><th>方式</th><th>收據 / 單號</th><th>入帳</th><th></th></tr></thead>
      <tbody>${rows.map(r => {
        const late = !r.paid && r.due && r.due < todayISO();
        const linked = r.txId && tx().some(t => t.id === r.txId);
        return `<tr>
          <td><div class="row gap-10">${avatar(r.member.name)}
            <div><div class="semibold sm">${esc(r.member.name)}</div>
            ${r.member.role ? `<div class="xs faint">${esc(r.member.role)}</div>` : ''}</div></div></td>
          <td class="money">${money(r.amount)}
            ${can('fee.edit') ? `<button class="btn btn-xs btn-ghost" data-editfee="${r.member.id}" title="改金額">${icon('edit', 12)}</button>` : ''}</td>
          <td>${r.paid
            ? '<span class="badge b-ok"><span class="dot"></span>已收</span>'
            : (!r.exists ? '<span class="badge b-info"><span class="dot"></span>未建立紀錄</span>'
              : late ? '<span class="badge b-danger"><span class="dot"></span>逾期未收</span>'
                : '<span class="badge b-warn"><span class="dot"></span>未收</span>')}</td>
          <td class="mono sm">${esc(r.paidDate || '—')}</td>
          <td class="sm">${esc(r.method || '')}</td>
          <td class="sm">${esc(r.ref || '')}</td>
          <td class="sm">${r.paid
            ? (linked ? `<span class="xs" style="color:var(--ok)">✓ 已入帳</span>`
              : `<button class="btn btn-xs" data-link-fee="${r.id}">補入帳</button>`)
            : (linked ? '<span class="xs faint">已入帳但未標記</span>' : '')}</td>
          <td class="right"><div class="row-actions">
            ${!r.exists && can('fee.edit') ? `<button class="btn btn-xs" data-new-fee="${r.member.id}">建立紀錄</button>` : ''}
            ${r.exists && can('fee.mark') ? (r.paid
              ? `<button class="btn btn-xs" data-unmark="${r.id}">取消收款</button>`
              : `<button class="btn btn-xs btn-primary" data-mark="${r.id}">標記已收</button>`) : ''}
            ${r.exists ? `<button class="btn btn-xs btn-ghost" data-receipt="${r.id}" title="收據">${icon('print', 13)}</button>` : ''}
            ${r.exists && can('fee.edit') ? `<button class="btn btn-xs btn-ghost" data-delfee="${r.id}" title="刪除">${icon('trash', 13)}</button>` : ''}
          </div></td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td class="right">合計（${st.total} 人）</td><td class="money">${money(st.expected)}</td>
        <td colspan="3">已收 ${money(st.collected)}</td><td colspan="3" class="money">未收 ${money(st.outstanding)}</td></tr></tfoot>
    </table></div>
    ${!rows.length ? empty('wallet', '名冊未有現役團員', '先去「團員」加入團員') : ''}
  </div>

  <div class="grid g-2 mt-16">
    <div class="card"><div class="card-head"><div class="card-title">未交名單（${esc(period)}）</div></div>
      <div style="padding:8px 0">
        ${rows.filter(r => !r.paid).length ? rows.filter(r => !r.paid).map(r => `
          <div class="list-item"><span class="stat-ic">${icon('user', 15)}</span>
            <div class="li-main"><div class="li-t">${esc(r.member.name)}</div>
              <div class="li-s">${money(r.amount)}${r.due ? ` · 到期 ${esc(r.due)}` : ''}${r.due && r.due < todayISO() ? ' · ⚠ 已逾期' : ''}</div></div>
          </div>`).join('') : '<div style="padding:16px" class="sm faint">全部收齊 🎉</div>'}
      </div>
    </div>
    <div class="card"><div class="card-head"><div class="card-title">點樣用</div></div>
      <div style="padding:16px 18px" class="sm muted">
        <ol style="padding-left:18px;line-height:1.9">
          <li>新一年度：按「<b>開新年度團費</b>」→ 一次過為所有現役團員建立 $${standardFee()} 紀錄（金額＝該年度設定，冇設定就跟上年）</li>
          <li>有人交錢：喺佢一行按「<b>標記已收</b>」→ 自動入帳（可以揀日期／方式）</li>
          <li>追人：按「<b>複製催繳名單</b>」→ 直接貼落 WhatsApp 群</li>
          <li>要收據：按 🖨 → 即刻列印／存 PDF</li>
          <li>年結：去「財政年度報告」出兩條數（旅年度 ＋ 童軍年度）</li>
        </ol>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   4. 收支申報（取代 Google Form）
   ============================================================ */
function claimsView() {
  const all = claims().slice().sort((a, b) => String(b.requestedAt || b.date).localeCompare(String(a.requestedAt || a.date)));
  const list = claimFilter === 'all' ? all : all.filter(c => (c.status || 'pending') === claimFilter);

  return `
  <div class="note-box mb-16">${icon('note', 15)}<div>
    呢個「收支申報」取代原本嘅 Google Form：團員／執委喺呢度填墊支或收入，
    司庫或領袖批核後<b>自動寫入帳目</b>，唔使再 copy 資料。<br>
    <span class="xs">成員唔想登入？派<b>團員入口</b> QR（掃一次齊晒）。按右上「<b>畀成員自己填（QR）</b>」會顯示團員入口。</span></div></div>

  <div class="row-between wrap gap-12 mb-16">
    ${chipbar([['pending', '待批核', all.filter(c => (c.status || 'pending') === 'pending').length],
      ['approved', '已批核', all.filter(c => c.status === 'approved').length],
      ['rejected', '已拒絕', all.filter(c => c.status === 'rejected').length],
      ['all', '全部', all.length]], claimFilter, 'data-cf')}
    <div class="row gap-6 wrap">
      <button class="btn btn-sm" data-act="entry-share">${icon('share', 15)} 畀成員自己填（QR）</button>
      ${can('claim.submit') ? `<button class="btn btn-sm btn-primary" data-act="new-claim">${icon('plus', 15)} 我要申報</button>` : ''}
    </div>
  </div>

  <div class="card">
    ${list.length ? `<div class="scroll-x"><table class="table">
      <thead><tr><th>日期</th><th>類型</th><th>項目</th><th>申報人</th><th class="right">金額</th><th>單據</th><th>狀態</th><th></th></tr></thead>
      <tbody>${list.map(c => `<tr>
        <td class="mono sm">${esc(c.date)}</td>
        <td><span class="badge ${c.type === 'income' ? 'b-ok' : 'b-danger'}">${c.type === 'income' ? '收入' : '支出'}</span></td>
        <td><div class="sm semibold">${esc(c.item)}</div><div class="xs faint">${esc(c.category || '')}${c.note ? ` · ${esc(c.note)}` : ''}</div></td>
        <td class="sm">${esc(c.byName || memberName(c.memberId))}</td>
        <td class="money">${money(c.amount)}</td>
        <td class="center">${c.receipt ? `<span style="color:var(--ok)">${icon('check', 15)}</span>` : '<span class="faint xs">—</span>'}</td>
        <td>${c.status === 'approved' ? '<span class="badge b-ok"><span class="dot"></span>已批核</span>'
          : c.status === 'rejected' ? '<span class="badge b-danger"><span class="dot"></span>已拒絕</span>'
          : '<span class="badge b-warn"><span class="dot"></span>待批核</span>'}</td>
        <td class="right"><div class="row-actions">
          ${(c.status || 'pending') === 'pending' && can('claim.review') ? `
            <button class="btn btn-xs btn-primary" data-claim="approve" data-id="${c.id}">批准並入帳</button>
            <button class="btn btn-xs" data-claim="reject" data-id="${c.id}">拒絕</button>` : ''}
          ${(c.status || 'pending') === 'pending' && c.requestedBy === current()?.username ? `<button class="btn btn-xs btn-ghost" data-claim="del" data-id="${c.id}">${icon('trash', 13)}</button>` : ''}
        </div></td></tr>`).join('')}</tbody>
    </table></div>` : empty('note', '冇申報紀錄')}
  </div>`;
}

/* ============================================================
   5. 活動預算
   ============================================================ */
function budgetsView() {
  const list = budgets();
  return `
  <div class="row-between mb-16">
    <div class="sm muted">預算 vs 實際，自動計差異</div>
    ${can('finance.edit') ? `<button class="btn btn-sm btn-primary" data-act="new-budget">${icon('plus', 15)} 新增預算</button>` : ''}
  </div>
  <div class="col gap-16">
    ${list.length ? list.map(b => {
      const planned = (b.items || []).reduce((s, i) => s + Number(i.planned || 0), 0);
      const actual = (b.items || []).reduce((s, i) => s + Number(i.actual || 0), 0);
      const income = Number(b.incomePlanned || 0);
      const diff = planned - actual;
      const net = income - (actual || planned);
      return `<div class="card">
        <div class="card-head">
          <div><div class="card-title">${esc(b.activity)}</div>
            <div class="card-sub">${esc(b.date || '')} ${b.note ? `· ${esc(b.note)}` : ''}</div></div>
          <div class="row gap-8">
            <span class="badge ${net >= 0 ? 'b-ok' : 'b-danger'}">${net >= 0 ? '盈餘' : '虧損'} ${money(Math.abs(net))}</span>
            ${can('finance.edit') ? `<button class="btn btn-xs" data-editbudget="${b.id}">${icon('edit', 13)}</button>
            <button class="btn btn-xs btn-ghost" data-delbudget="${b.id}">${icon('trash', 13)}</button>` : ''}
          </div>
        </div>
        <div class="scroll-x"><table class="table table-compact">
          <thead><tr><th>項目</th><th class="right">預算</th><th class="right">實際</th><th class="right">差異</th></tr></thead>
          <tbody>${(b.items || []).map(i => `<tr><td class="sm">${esc(i.name)}</td>
            <td class="money">${money(i.planned)}</td><td class="money">${money(i.actual)}</td>
            <td class="money" style="color:${Number(i.planned) - Number(i.actual) >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(Number(i.planned) - Number(i.actual))}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>支出合計</td><td class="money">${money(planned)}</td><td class="money">${money(actual)}</td>
            <td class="money">${money(diff)}</td></tr>
            <tr><td>預計收入</td><td class="money">${money(income)}</td><td colspan="2"></td></tr></tfoot>
        </table></div>
      </div>`;
    }).join('') : empty('target', '未有活動預算')}
  </div>`;
}

/* ============================================================
   5b. 設定（期初結餘 · 年度起點 · 團費逐年 · 單據 Drive）
   ============================================================ */
/** 由設定頁欄位收集（儲存同暫存共用） */
function collectSettings(root) {
  const v = k => root.querySelector(k)?.value ?? '';
  /* 期初結餘逐年收集：每個 [data-open-year] 欄位對應一個年度。
     留空 = 唔明確設定，由系統自動結轉（上年度期末） */
  const map = {};
  root.querySelectorAll('[data-open-year]').forEach(el => {
    const y = el.dataset.openYear;
    const raw = String(el.value ?? '').trim();
    if (raw === '') { delete map[y]; return; }
    map[y] = Number(raw);
  });
  /* 逐年團費：留空＝用返「同上年」，唔會入 map */
  const feeMap = {};
  root.querySelectorAll('[data-fee-year]').forEach(el => {
    const y = el.dataset.feeYear;
    const raw = String(el.value ?? '').trim();
    if (raw === '') return;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) feeMap[y] = n;
  });
  return {
    openingBalances: map,
    openingBalance: Number(v('#set-open-legacy')) || 0,   // 第一筆帳目之前嘅底數
    openingBalanceDate: String(v('#set-opendate')).trim(),
    scoutFYStartMonth: Number(v('#set-fym')) || 4,
    scoutFYStartDay: Number(v('#set-fyd')) || 1,
    feePerYear: Number(v('#set-fee')) || 0,
    feeOverseas: Number(v('#set-feeovs')) || 0,
    feePerYearMap: feeMap,
    receiptDrive: String(v('#set-receipt')).trim()
  };
}

/** 設定頁要列出邊幾年（有帳目嘅年度 + 已設定嘅年度 + 本年度） */
function openingYearList() {
  const s = settings();
  const keys = new Set();
  (listYears().scout || []).forEach(y => keys.add(y.key));
  Object.keys(s.openingBalances || {}).forEach(k => keys.add(k));
  const refY = refYearKey();
  if (refY) keys.add(refY);
  keys.add(currentFY());
  keys.add(prevFYKey(currentFY()));   // 上年度一定要列出：先睇到「上年度期末 → 本年度期初」
  return Array.from(keys).sort().reverse().slice(0, 8);
}

function settingsView() {
  const s = settings();
  const bal = balanceBreakdown();
  /* 逐年團費（v2.4.0）：feePerYearMap；draft 恢復；留空顯示「同上年」 */
  const feeMap = s.feePerYearMap || {};
  const rec2 = readDraft('fin-settings', load().unitCode);
  const collectedFee = {};
  if (rec2?.data) Object.keys(rec2.data).forEach(k => {
    const m2 = /^feeyear:(.+)$/.exec(k);
    if (m2) collectedFee[m2[1]] = rec2.data[k];
  });
  const prevFeeOf = (y) => {
    const m2 = /^(\d{4})/.exec(String(y));
    if (m2) {
      const y0 = Number(m2[1]);
      for (let i = 1; i <= 15; i++) {
        const yy = `${y0 - i}-${String(y0 - i + 1).slice(-2)}`;
        if (feeMap[yy] != null && feeMap[yy] !== '') return Number(feeMap[yy]);
      }
    }
    return Number(s.feePerYear ?? 360);
  };
  /* 草稿（本機暫存）入面嘅逐年期初要先顯示返，唔會因為 refresh 而失去 */
  const rec = readDraft('fin-settings', load().unitCode);
  const collected = {};
  if (rec?.data) Object.keys(rec.data).forEach(k => {
    const m = /^open:(.+)$/.exec(k);
    if (m) collected[m[1]] = rec.data[k];
  });
  return `
  ${bal.now < 0 ? noteBox(
    `<b>而家結餘係負數（${money(bal.now)}）。</b>最常見原因：<b>期初結餘未填</b>。${
      bal.referenceOpening ? `你嘅舊帳顯示上年度結餘 <b>${money(bal.referenceOpening)}</b>，填入去就會返正數。` : '請喺下面填返旅團嘅底數。'
    }`, 'warn') + '<div class="mb-16"></div>' : ''}

  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">期初結餘（逐年）</div>
          <div class="card-sub">每個財政年度各有自己嘅期初 ＝ 上年度期末；現在結餘 ＝ <b>本年度</b>期初 ＋ 本年度收入 − 本年度支出</div></div></div>
        <div style="padding:18px 20px">
          ${openingYearList().map(y => {
            const o = openingOf(y, yearRange(y));
            const r = yearRange(y);
            const sum = summarize(tx(), r);
            const isCur = y === bal.year;
            const isPrev = y === bal.prevYear;
            const carry = Number(carriedForward(r.start));
            const filled = String(collected[y] ?? (o.explicit ? o.amount : ''));
            return `
            <div class="row gap-10 wrap open-row${isCur ? ' is-current' : ''}" style="align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)">
              <div style="min-width:150px">
                <div class="semibold">${esc(y)} 年度</div>
                <div class="xs faint">${esc(r.start)} → ${esc(r.end)}</div>
                ${isCur ? '<span class="tag brand">本年度</span>' : ''}${isPrev ? '<span class="tag">上年度</span>' : ''}
              </div>
              <div style="min-width:150px">
                <label class="label">期初結餘（HK$）</label>
                <input class="input" type="number" step="0.01" data-open-year="${esc(y)}" data-draft="open:${esc(y)}"
                  value="${esc(filled)}" placeholder="${carry ? String(carry) : '0'}">
                <div class="hint">${o.explicit
                  ? '已明確設定'
                  : (carry ? `未填 → 自動結轉 <b>${money(carry)}</b>` : '未填 → 當 0')}</div>
              </div>
              <div style="min-width:170px" class="xs">
                ${sum.count ? `收入 ${money(sum.income)} ／ 支出 ${money(sum.expense)}<br>
                  <span class="faint">${sum.count} 筆 · 期末 <b class="money">${money(o.amount + sum.net)}</b></span>`
                  : '<span class="faint">未有帳目</span>'}
              </div>
              <div style="min-width:130px">
                <label class="label">團費（該年度）</label>
                <input class="input" type="number" step="0.01" data-fee-year="${esc(y)}" data-draft="feeyear:${esc(y)}"
                  value="${esc(collectedFee[y] ?? (feeMap[y] ?? ''))}" placeholder="${esc(prevFeeOf(y))}">
                <div class="hint">${feeMap[y] != null ? '已個別設定' : `留空 → 用 <b>${money(prevFeeOf(y))}</b>（同上年）`}</div>
              </div>
              <div style="min-width:110px">
                ${y !== openingYearList()[0] ? '' : ''}
                <button class="btn btn-xs" data-carry-year="${esc(y)}">${icon('refresh', 14)} 由上年度期末結轉</button>
              </div>
            </div>`;
          }).join('')}
          <div class="grid g-2 mt-12" style="gap:12px">
            <div class="field"><label class="label">期初日期（本年度）</label>
              <input class="input" id="set-opendate" data-draft="openingBalanceDate" value="${esc(s.openingBalanceDate || '')}" placeholder="${esc(bal.openingDate || 'YYYY-MM-DD')}">
              <div class="hint">留空就用年度第一日（${esc(bal.openingDate)}）</div></div>
            <div class="field"><label class="label">起始底數（第一筆帳目之前）</label>
              <input class="input" id="set-open-legacy" type="number" step="0.01" data-draft="openingBalance" value="${s.openingBalance || 0}">
              <div class="hint">只有喺最早一筆帳目<b>之前</b>先有底數時先要填（例：旅團開戶餘額）。<b>唔好</b>把上年度結餘填喺度。</div></div>
          </div>
          <div class="row gap-8 wrap mt-12">
            ${bal.referenceOpening
              ? `<button class="btn btn-sm" data-act="use-ref-opening">${icon('check', 15)} 用舊帳嘅數字填返（${esc(bal.referenceYear || '')} 期初 ${money(bal.referenceOpening)}${bal.referenceClosing != null ? ` → 下年度期初 ${money(bal.referenceClosing)}` : ''}）</button>` : ''}
            <button class="btn btn-sm" data-act="carry-all">${icon('refresh', 15)} 全部由上年度期末自動結轉</button>
            <button class="btn btn-sm" data-go="#/finance/import">${icon('upload', 15)} 匯入舊帳（會一併設定期初）</button>
          </div>
          ${bal.openingMismatch ? noteBox(
            `<b>${esc(bal.year)} 期初（${money(bal.opening)}）同上年度期末（${money(bal.prevClosing)}）唔吻合。</b>
             正常情況本年度期初應該等於上年度期末；如果上年有帳目未入，請先補返。`, 'warn') : ''}
          <div class="hint mt-8" data-draft-stamp></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">年度起點</div>
          <div class="card-sub">童軍年度 4/1–3/31；旅年度由 AGM 起計</div></div>
          <button class="btn btn-sm" data-act="agm">${icon('calendar', 15)} 逐年輸入 AGM 日期</button></div>
        <div style="padding:18px 20px">
          <div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">童軍年度起始月</label>
              <input class="input" id="set-fym" type="number" min="1" max="12" data-draft="scoutFYStartMonth" value="${s.scoutFYStartMonth || 4}"></div>
            <div class="field"><label class="label">童軍年度起始日</label>
              <input class="input" id="set-fyd" type="number" min="1" max="31" data-draft="scoutFYStartDay" value="${s.scoutFYStartDay || 1}"></div>
          </div>
          <div class="hint">已設定嘅 AGM 日期：${(s.agmDates || []).filter(a => a.date).map(a => `<span class="tag">${esc(String(a.year))} · ${esc(a.date)}${agmIsDefault(a.year, s.agmDates) ? '（未確認）' : ''}</span>`).join(' ') || '<span class="faint">未設定</span>'}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">團費預設</div>
          <div class="card-sub">逐年喺上面表入就得；呢個係「本年度」快速欄（可以逐個團員改）</div></div></div>
        <div style="padding:18px 20px">
          <div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">標準團費（本年度）</label>
              <input class="input" id="set-fee" type="number" step="0.01" data-draft="feePerYear" value="${standardFee()}"></div>
            <div class="field"><label class="label">海外／優惠團費</label>
              <input class="input" id="set-feeovs" type="number" step="0.01" data-draft="feeOverseas" value="${overseasFee()}"></div>
          </div>
          <div class="hint mt-8">每年幾多錢喺<b>上面「期初結餘」同一張表嘅「團費（該年度）」欄</b>逐年度填；留空＝自動同上一個年度一樣。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">單據相片 Drive 資料夾</div>
          <div class="card-sub">申報相片存邊度 —— 同「系統 → 旅團設定」係<b>同一個設定</b></div></div>
        <div style="padding:18px 20px">
          <div class="field"><label class="label">Drive 資料夾連結（或 ID）</label>
            <input class="input" id="set-receipt" data-draft="receiptDrive" value="${esc(s.receiptDrive || '')}" placeholder="https://drive.google.com/drive/folders/…"></div>
          <div class="hint mt-8">貼資料夾連結就得（會自動抽出 ID）。留空＝用旅團後端 Apps Script 預設嘅資料夾。<br>
            呢個係<b>收單據相</b>嘅資料夾，同「團員睇到嘅公開連結」嗰個旅團 Drive 係兩樣嘢。</div>
        </div>
      </div>

      <div class="row gap-8 wrap no-print">
        <button class="btn btn-primary" data-act="save-settings-page">${icon('save', 16)} 儲存設定</button>
        <span class="xs faint">改動會先暫存喺呢部裝置，撳「儲存」先寫入。</span>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">結餘點計？</div></div>
        <div style="padding:16px 18px">
          ${kv([
            [`${esc(bal.year)} 期初結餘`, money(bal.opening) + (bal.openingExplicit ? '' : ' <span class="faint xs">(自動結轉)</span>')],
            [`＋ ${esc(bal.year)} 收入`, money(bal.income)],
            [`− ${esc(bal.year)} 支出`, money(bal.expense)],
            ['＝ 現在結餘', `<b style="color:${bal.now < 0 ? 'var(--danger)' : 'var(--brand-700)'}">${money(bal.now)}</b>`]
          ])}
          ${bal.prevYear ? kv([
            [`${esc(bal.prevYear)} 期初`, money(bal.prevOpening)],
            [`${esc(bal.prevYear)} 期末`, money(bal.prevClosing)]
          ]) : ''}
          <div class="hint mt-12">「現在結餘」只計<b>本年度</b>（${esc(bal.year)}）嘅帳目，同儀表板一樣。財政年度報告會再按期間（AGM 旅年度 / 童軍年度）拆開計。</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   6. 匯入舊帳
   ============================================================ */
function importView() {
  const ref = load().reference || {};
  return `
  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">由舊 Google Sheet 貼上匯入</div>
          <div class="card-sub">複製儲存格，直接貼落下面就得（支援 Tab / 逗號分隔）</div></div></div>
        <div style="padding:16px 18px">
          <div class="field"><label class="label">貼上資料</label>
            <textarea class="textarea" id="imp-text" style="min-height:160px;font-family:var(--mono);font-size:12.5px"
              placeholder="日期&#9;類型&#9;項目&#9;金額&#9;負責人&#10;2025-12-07&#9;收入&#9;12/7 partyroom event&#9;190&#9;嘉詠"></textarea>
            <div class="hint">欄位可以係：日期 / 類型（收入、支出、income、expense）/ 項目 / 金額 / 分類 / 方式 / 經手人（負責人）/ 年度 / <b>團費</b> / 備註。
              冇日期就當今日；「團費」欄打 ✓（或寫團員名）就會<b>順便喺團費收款表標記已收</b>。</div></div>
          <div class="row gap-8 mt-12 wrap">
            <button class="btn btn-primary" data-act="do-import">${icon('upload', 16)} 匯入（會顯示預覽）</button>
            <label class="btn" style="cursor:pointer">${icon('download', 16)} 上載 CSV 檔
              <input type="file" id="imp-file" accept=".csv,.tsv,.txt,text/csv" style="display:none">
            </label>
            ${can('finance.export') ? `<button class="btn" data-act="exp-template">${icon('download', 16)} 下載空白範本 CSV</button>` : ''}
          </div>
          <div class="hint mt-8">Google Sheet：<b>檔案 → 下載 → 逗號分隔值 (.csv)</b>，再用上面嘅「上載 CSV 檔」，
            或者喺 Sheet 選取範圍複製再貼落上面個格。</div>
          <div id="imp-open-wrap" class="mt-12"></div>
          <div id="imp-preview" class="mt-8"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">由本系統備份還原</div>
          <div class="card-sub">管理 → 資料管理 → 匯入備份</div></div></div>
        <div style="padding:16px 18px">
          <p class="sm muted">如果想還原整個旅團嘅資料（包括會議、物資、團章），請去「管理」頁。</p>
          <button class="btn btn-sm mt-8" data-go="#/admin">${icon('shield', 15)} 去管理頁</button>
        </div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">參考：你現行 Google Sheet 紀錄</div>
          <div class="card-sub">${ref.transactions?.length ? `${esc(ref.sheetLabel || '')} · ${ref.transactions.length} 筆（只作參考，未入帳）` : '冇參考資料'}</div></div></div>
        ${(ref.transactions || []).length ? `<div style="padding:12px 16px;border-bottom:1px solid var(--line-2)" class="sm">
          <div class="row-between wrap gap-8">
            <span>收入 <b class="income">${money(ref.transactions.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount || 0), 0))}</b></span>
            <span>支出 <b class="expense">${money(ref.transactions.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount || 0), 0))}</b></span>
            ${ref.openingBalance ? `<span>期初 <b>${money(ref.openingBalance)}</b></span>` : ''}
          </div>
          ${ref.check ? `<div class="xs faint mt-6">對數：期初 ＋ 收入 − 支出 = <b>${money(ref.check.closing)}</b>（同原表總結一致）</div>` : ''}
          ${ref.source ? `<a class="xs" href="${esc(ref.source)}" target="_blank" rel="noopener">開啟原表 ↗</a>` : ''}
        </div>` : ''}
        <div>
          ${(ref.transactions || []).length ? ref.transactions.slice(0, 8).map(t => `
            <div class="list-item">
              <span class="stat-ic" style="background:${t.type === 'income' ? 'var(--ok-bg)' : 'var(--danger-bg)'};color:${t.type === 'income' ? 'var(--ok)' : 'var(--danger)'}">${icon(t.type === 'income' ? 'arrowUp' : 'arrowDown', 15)}</span>
              <div class="li-main"><div class="li-t">${esc(t.item)}</div>
                <div class="li-s">${esc(t.date || '')} · ${esc(t.category || '')} · ${esc(t.byName || '')}${t.note ? ` · ${esc(t.note)}` : ''}</div></div>
              <span class="mono sm">${money(t.amount)}</span>
            </div>`).join('') : '<div style="padding:16px" class="sm faint">呢個旅團未設定參考資料。可以喺 <code>data/units/&lt;編號&gt;/finance.reference.json</code> 加入。</div>'}
          ${(ref.transactions || []).length > 8 ? `<div style="padding:10px 16px" class="xs faint">… 另有 ${ref.transactions.length - 8} 筆（按「一鍵匯入」會全部加入）</div>` : ''}
        </div>
        ${(ref.transactions || []).length && can('finance.create') ? `<div style="padding:12px 16px;border-top:1px solid var(--line-2)">
          <button class="btn btn-sm btn-block" data-act="import-ref">${icon('upload', 15)} 一鍵匯入呢 ${ref.transactions.length} 筆做起始帳目</button>
          ${ref.openingBalance ? `<div class="hint mt-8">參考結餘 ${money(ref.openingBalance)}：可喺「年度設定」填落期初結餘。</div>` : ''}
        </div>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">匯入貼士</div></div>
        <div style="padding:16px 18px">
          <ul class="sm muted" style="padding-left:18px;line-height:1.9">
            <li>先喺 Google Sheet 選取範圍 → Ctrl/Cmd + C → 貼落左邊格</li>
            <li>第一行可以係標題（會自動辨認）</li>
            <li>金額唔要加 <code>HK$</code> 都可以（會自動清除）</li>
            <li>匯入後可以去「帳目」逐筆核對，再刪走唔要嘅</li>
          </ul>
        </div>
      </div>
    </div>
  </div>`;
}

/** 解析貼上嘅表格 */
/** 由檔案讀入（CSV / TSV / TXT） */
export function readImportFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('讀取檔案失敗'));
    fr.onload = () => resolve(String(fr.result || '').replace(/^\ufeff/, ''));
    fr.readAsText(file, 'UTF-8');
  });
}

/** 真正 CSV 解析（RFC4180：支援引號欄位、欄位內嘅逗號／換行） */
export function splitCsv(text, sep = ',') {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

export function parsePasted(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const isTab = (raw.split(/\r?\n/)[0] || '').includes('\t');
  const table = isTab
    ? raw.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t'))
    : splitCsv(raw, ',');
  const lines = table.map(r => r.map(c => String(c ?? '').trim())).filter(r => r.some(c => c !== ''));
  if (!lines.length) return [];
  const split = r => r;
  const head = split(lines[0]).map(s => s.trim());
  const known = ['日期', 'date', '類型', 'type', '項目', 'item', '名稱', '金額', 'amount', '分類', 'category', '方式', 'method', '經手', '負責', '備註', 'note', '年度', 'year'];
  const hasHeader = head.some(h => known.some(k => h.toLowerCase().includes(k)));
  // Google Sheet 有時第一行係標題（例如「BAD deb」），只有一格 → 跳過
  const titleRow = !hasHeader && lines.length > 1 && lines[0].filter(c => c !== '').length <= 1;
  const rows = hasHeader ? lines.slice(1) : lines.slice(titleRow ? 1 : 0);
  const find = (re, not = null) => head.findIndex(h => re.test(h) && (!not || !not.test(h)));
  const idx = {
    date: hasHeader ? find(/日期|date/i) : 0,
    type: hasHeader ? find(/類型|type|收支|收入或支出/i) : 1,
    item: hasHeader ? find(/項目|item|名稱|name/i) : 2,
    amount: hasHeader ? find(/金額|amount|銀/i) : 3,
    category: hasHeader ? find(/分類|category/i) : -1,
    method: hasHeader ? find(/方式|method/i) : -1,
    byName: hasHeader ? find(/經手|負責|付款|by|人/i, /金額|收入|支出|日期/) : -1,
    note: hasHeader ? find(/備註|note|remark/i) : -1,
    period: hasHeader ? find(/年度|期數|period|year/i, /結餘/) : -1,
    fee: hasHeader ? find(/團費/) : -1,
    // Google Form 式：收入項目 / 支出項目、收入 / 支出 各自一欄
    itemIn: hasHeader ? find(/收入\s*項目|收入項目|收入內容/) : -1,
    itemOut: hasHeader ? find(/支出\s*項目|支出項目|支出內容/) : -1,
    amountIn: hasHeader ? find(/^\s*收入\s*$|收入金額|收入\s*\(/) : -1,
    amountOut: hasHeader ? find(/^\s*支出\s*$|支出金額|支出\s*\(/) : -1,
    balance: hasHeader ? find(/結餘|balance/) : -1,
    receipt: hasHeader ? find(/單據|收據|receipt|上載|證明/) : -1,
    timestamp: hasHeader ? find(/時間戳|timestamp/i) : -1
  };
  // 「項目」「金額」如果係合併欄，就用收入／支出分開嘅欄
  if (idx.itemIn >= 0 && (idx.item === idx.itemIn || idx.item < 0)) idx.item = idx.itemIn;
  if (idx.amountIn >= 0 && (idx.amount === idx.amountIn || idx.amount < 0)) idx.amount = idx.amountIn;
  /** 「團費」欄係打勾／已交／名字 */
  const isTicked = v => /^(y|yes|✓|✔|√|v|o|1|true|已交|已收|交了|交了團費|已繳|paid)$/i.test(String(v || '').trim());
  const get = (r, i) => (i >= 0 && r[i] !== undefined ? String(r[i]).trim() : '');
  const normDate = s => {
    const t = String(s || '').replace(/[年月]/g, '-').replace(/日/g, '').replace(/[./]/g, '-').trim();
    let m;
    if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    if ((m = t.match(/^(\d{1,2})-(\d{1,2})$/))) return `${new Date().getFullYear()}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    return '';
  };
  const out = [];
  let openingBalance = null;
  let sheetBalance = null;
  let summary = null;
  rows.forEach(r => {
    const rawType = get(r, idx.type);
    const amtRaw = get(r, idx.amount), amtIn = get(r, idx.amountIn), amtOut = get(r, idx.amountOut);
    const num = v => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.abs(n) : 0; };
    let amount = num(amtRaw), side = '';
    if (!amount && amtIn && num(amtIn)) { amount = num(amtIn); side = 'income'; }
    if (!amount && amtOut && num(amtOut)) { amount = num(amtOut); side = 'expense'; }
    const itemRaw = get(r, idx.itemIn) || get(r, idx.itemOut) || get(r, idx.item);
    const hasDate = !!get(r, idx.date);

    // 期初結餘（例：「2024年度結餘」）→ 唔當交易，回報做期初結餘建議
    if (/年度結餘|上年結餘|期初結餘/.test(itemRaw) && !hasDate) {
      if (amount) openingBalance = amount;
      return;
    }
    // 表底嘅總結行（上年度結餘 / 本年度收入 / 總計支出 / 結餘 …）→ 攞嚟對數，唔當交易
    if (!hasDate && /^(上年度結餘|上年結餘|本年度收入|總計支出|結餘|收入合計|支出合計|盈餘)/.test(itemRaw)) {
      const v = amount || (idx.balance >= 0 ? num(get(r, idx.balance)) : 0);
      if (!summary) summary = {};
      const isClosingRow = /^結餘/.test(itemRaw) || /^盈餘/.test(itemRaw);
      const balV = idx.balance >= 0 ? num(get(r, idx.balance)) : 0;
      // 只取第一組總結（原表可能有幾組對照數字，第一組先係實際年度數）
      if (isClosingRow && balV && summary.closing === undefined) summary.closing = balV;
      else if (/收入/.test(itemRaw) && !/結餘/.test(itemRaw)) { if (summary.income === undefined) summary.income = v; }
      else if (/支出/.test(itemRaw)) { if (summary.expense === undefined) summary.expense = v; }
      else if (/上年度結餘|上年結餘/.test(itemRaw) && v && summary.opening === undefined) summary.opening = v;
      return;
    }
    if (idx.balance >= 0 && hasDate) { const b = num(get(r, idx.balance)); if (b) sheetBalance = b; }
    if (!amount) return;

    const type = /支|expense|out|付/i.test(rawType) ? 'expense'
      : /收|income|in/i.test(rawType) ? 'income'
        : (side || 'income');
    const item = side === 'income' && idx.itemIn >= 0 && !get(r, idx.itemIn) ? (get(r, idx.itemOut) || '（未命名）')
      : (get(r, side === 'expense' ? idx.itemOut : idx.itemIn) || itemRaw || '（未命名）');
    // 「團費」欄：打勾 或 寫住團員名（例：曉莉）
    const feeRaw = idx.fee >= 0 ? get(r, idx.fee) : '';
    const feeName = feeRaw && !isTicked(feeRaw) ? feeRaw : '';
    const feePaid = !!feeRaw && (isTicked(feeRaw) || !!matchMemberByName(feeRaw) || /團費/.test(item));
    const who = get(r, idx.byName) || feeName;
    const m = matchMemberByName(who) || matchMemberByName(item) || null;
    const receiptLink = idx.receipt >= 0 ? get(r, idx.receipt) : '';
    out.push({
      date: normDate(get(r, idx.date)) || todayISO(),
      type, item, amount: Math.abs(amount),
      receiptLink: /^https?:/i.test(receiptLink) ? receiptLink : '',
      receipt: !!receiptLink,
      category: get(r, idx.category) || (type === 'income' ? '其他收入' : '雜項'),
      method: get(r, idx.method) || '現金',
      byName: who, by: m?.id || '',
      period: get(r, idx.period) || '',
      feePaid: feePaid || (/團費/.test(item) && !!m),
      memberId: m?.id || '',
      note: get(r, idx.note) || ''
    });
  });
  if (openingBalance !== null) out.openingBalance = openingBalance;
  if (sheetBalance !== null) out.sheetBalance = sheetBalance;
  if (summary) out.summary = summary;
  return out;
}

/* ============================================================
   AGM 日期逐年輸入（旅財政年度起點）
   ============================================================ */
async function agmDialog() {
  const s = settings();
  const curYear = new Date().getFullYear();
  const years = [];
  for (let y = curYear - 3; y <= curYear + 2; y++) years.push(y);
  const rowFor = y => {
    const hit = (s.agmDates || []).find(a => Number(a.year) === y && a.date);
    const def = lastSaturdayOfAugust(y);
    const isDef = agmIsDefault(y, s.agmDates);
    return `<tr>
      <td class="semibold">${y}</td>
      <td><input class="input" type="date" data-year="${y}" data-def="${def}" data-touched="0" value="${esc(hit?.date || '')}"></td>
      <td class="xs faint">預設 ${def}<button class="btn btn-xs ml-8" type="button" data-usdef="${y}">用預設</button></td>
      <td>${!hit ? '<span class="badge b-warn">未填</span>' : (isDef ? '<span class="badge b-warn">未確認</span>' : '<span class="badge b-ok">已確認</span>')}</td>
    </tr>`;
  };
  const r = await modal({
    title: '逐年輸入 AGM 日期',
    sub: '旅財政年度由每年 AGM 起計 —— 每年日期都唔同，請逐格填實際日期',
    body: `
      <div class="note-box info mb-12">${icon('calendar', 15)}<div>唔記得實際日期？可以按「用預設」用<b>8 月最後一個星期六</b>，
        之後再改。填過嘅年份會標示「已確認」，報告亦會有提示。</div></div>
      <div class="scroll-x"><table class="table table-compact">
        <thead><tr><th>年份</th><th>AGM 日期</th><th>建議</th><th>狀態</th></tr></thead>
        <tbody>${years.map(rowFor).join('')}</tbody>
      </table></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => {
        let list = [];
        el.querySelectorAll('input[data-year]').forEach(inp => {
          const v = String(inp.value || '').trim();
          if (!v) return;
          const isDef = v === inp.dataset.def && inp.dataset.touched !== '1';
          list = setAgmDate(list, Number(inp.dataset.year), v, { isDefault: isDef });
        });
        return { agmDates: list };
      } }],
    onMount: el => {
      el.querySelectorAll('input[data-year]').forEach(inp => {
        inp.addEventListener('input', () => { inp.dataset.touched = '1'; });
      });
      el.querySelectorAll('[data-usdef]').forEach(b => b.addEventListener('click', () => {
        const inp = el.querySelector(`input[data-year="${b.dataset.usdef}"]`);
        if (inp) { inp.value = inp.dataset.def; inp.dataset.touched = '0'; }
      }));
    }
  });
  if (!r) return;
  const db = load();
  db.settings = { ...db.settings, ...r };
  commit(); toast('已更新 AGM 日期', 'ok'); refresh();
}

/** 匯入預覽（貼上或上載 CSV 都用呢個） */
function showImportPreview(root) {
  const rows = parsePasted(root.querySelector('#imp-text').value);
  const box = root.querySelector('#imp-preview');
  if (!rows.length) { box.innerHTML = `<div class="note-box danger">讀唔到任何資料，請檢查格式（需要日期／類型／項目／金額）。</div>`; return; }
  const inc = rows.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
  const exp = rows.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  const feeRows = rows.filter(r => r.feePaid && r.memberId && r.type === 'income');
  const openBal = rows.openingBalance ?? null;
  const sheetBal = rows.sheetBalance ?? null;
  const withReceipt = rows.filter(r => r.receiptLink).length;
  const sum = rows.summary || null;
  const computed = (Number(openBal) || 0) + inc - exp;
  let diff = null, diffVs = '';
  if (sum) {
    diff = Math.round((inc - Number(sum.income ?? inc)) * 100) / 100 || Math.round((exp - Number(sum.expense ?? exp)) * 100) / 100
      || Math.round((computed - Number(sum.closing ?? computed)) * 100) / 100;
    diffVs = '原表總結';
  } else if (sheetBal !== null) {
    diff = Math.round((computed - sheetBal) * 100) / 100;
    diffVs = '原表最後一格結餘';
  }
  const sumLine = sum
    ? `<br>對數（同原表總結比較）：收入 ${money(inc)}${sum.income ? ` / 表 ${money(sum.income)}` : ''}、支出 ${money(exp)}${sum.expense ? ` / 表 ${money(sum.expense)}` : ''}、期末 ${money(computed)}${sum.closing ? ` / 表 ${money(sum.closing)}` : ''}`
    : '';
  box.innerHTML = `<div class="note-box info"><div>讀到 <b>${rows.length}</b> 筆：收入 ${money(inc)}、支出 ${money(exp)}${withReceipt ? `、有單據連結 ${withReceipt} 筆` : ''}。
    ${feeRows.length ? `<br>其中 <b>${feeRows.length}</b> 筆認得出係團費（團員：${[...new Set(feeRows.map(r => matchMemberByName(r.byName || r.item)?.name).filter(Boolean))].join('、')}）
      —— 確認匯入時會<b>順便喺「團費」收款表標記已收</b>。` : ''}
    ${openBal !== null ? `<br>期初結餘：<b>${money(openBal)}</b>（表內「年度結餘」行，可以一併寫入「年度設定」）` : ''}
    ${(sum || sheetBal !== null) ? `${sumLine}${sum ? '' : `<br>對數：期初 ＋ 收入 − 支出 = <b>${money(computed)}</b>；${diffVs} <b>${money(sheetBal)}</b>`}
      ${diff !== null && Math.abs(diff) < 0.01 ? ' <span class="badge b-ok">✓ 對得啱</span>' : diff !== null ? ` <span class="badge b-warn">相差 ${money(diff)}</span>` : ''}` : ''}
    <br>按下面確認就會寫入帳目（之後可以逐筆核對或刪除）。</div></div>
    <div class="scroll-x mt-12"><table class="table table-compact"><thead><tr><th>日期</th><th>類型</th><th>項目</th><th class="right">金額</th></tr></thead>
    <tbody>${rows.slice(0, 40).map(r => `<tr><td class="mono sm">${esc(r.date)}</td>
      <td><span class="badge ${r.type === 'income' ? 'b-ok' : 'b-danger'}">${r.type === 'income' ? '收入' : '支出'}</span></td>
      <td class="sm">${esc(r.item)}</td><td class="money">${money(r.amount)}</td></tr>`).join('')}</tbody></table></div>
    ${rows.length > 40 ? `<div class="hint mt-8">（只顯示頭 40 筆，全部會匯入）</div>` : ''}
    <button class="btn btn-primary mt-12" data-confirm-import>${icon('check', 16)} 確認匯入 ${rows.length} 筆</button>`;
  const openWrap = document.getElementById('imp-open-wrap');
  if (openWrap) openWrap.innerHTML = openBal !== null
    ? `<label class="check mb-8"><input type="checkbox" id="imp-open" checked> 同時將期初結餘設為 ${money(openBal)}</label>` : '';
  box.querySelector('[data-confirm-import]').addEventListener('click', () => {
    let feeN = 0;
    rows.forEach(r => {
      const payload = { ...r };
      delete payload.feePaid; delete payload.memberId;
      const t = add('transactions', { id: uid('t'), ...payload, createdBy: current()?.username || '', imported: true });
      // 團費：同步喺收款表標記（唔會重複建立）
      if (r.feePaid && r.memberId) {
        const period = r.period || feePeriodOf(r.date);
        let f = feeOf(r.memberId, period);
        if (!f) {
          f = add('fees', { id: uid('f'), memberId: r.memberId, period, label: `${period} 團費`,
            amount: Number(r.amount) || standardFee(period), due: `${period.slice(0, 4)}-09-30`, paid: false });
        }
        if (f && !f.paid) {
          update('fees', f.id, { paid: true, paidDate: r.date, method: r.method, txId: t?.id || '', receivedBy: r.byName || '' });
          feeN++;
        } else if (f && !f.txId) {
          update('fees', f.id, { txId: t?.id || '' });
        }
      }
    });
    const openBox = document.getElementById('imp-open');
    if (openBox?.checked && openBal !== null) {
      const db = load();
      db.settings = { ...db.settings, openingBalance: Number(openBal), openingBalanceDate: '' };
      commit();
    }
    toast(`已匯入 ${rows.length} 筆帳目${feeN ? `，並標記 ${feeN} 人團費已收` : ''}${openBox?.checked && openBal !== null ? '，期初結餘已更新' : ''}`, 'ok');
    go('#/finance');
  });
}

/* ============================================================
   輸出：報告
   ============================================================ */
function reportHtml(title, range, sum, open, { withRows = true } = {}) {
  const close = open + sum.net;
  const rows = sum.rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(t => `<tr>
    <td>${esc(t.date)}</td><td>${esc(t.item)}</td><td>${esc(t.category || '')}</td>
    <td>${esc(t.method || '')}</td><td>${esc(t.byName || (t.by ? memberName(t.by) : ''))}</td>
    <td class="num">${t.type === 'income' ? nf(t.amount, 2) : ''}</td>
    <td class="num">${t.type === 'expense' ? nf(t.amount, 2) : ''}</td></tr>`).join('');
  return `
  <h2>${esc(title)}</h2>
  <p class="en-block">${esc(range.title)} · ${esc(range.sub)}</p>
  <table>
    <thead><tr><th style="width:44%">項目</th><th class="num">金額</th><th>備註</th></tr></thead>
    <tbody>
      <tr><td><b>上年度結餘（期初）</b></td><td class="num">${currency()}${nf(open, 2)}</td>
        <td>上年度結轉，<b>不計入本年度收入</b></td></tr>
      <tr><td>本年度收入</td><td class="num">${currency()}${nf(sum.income, 2)}</td><td>本期間真正收到嘅錢</td></tr>
      <tr><td>本年度支出</td><td class="num">${currency()}${nf(sum.expense, 2)}</td><td></td></tr>
      <tr><td><b>本年度淨額</b>（收入 − 支出）</td><td class="num">${currency()}${nf(sum.net, 2)}</td><td>未計上年度結餘</td></tr>
      <tr><td><b>期末結餘</b></td><td class="num">${currency()}${nf(close, 2)}</td>
        <td>期初 ${currency()}${nf(open, 2)} ＋ 淨額 ${currency()}${nf(sum.net, 2)}</td></tr>
    </tbody>
  </table>
  <p class="note">＊上年度結餘與本年度收入分開列示，避免「收入」數字被上年度結餘放大。</p>
  <table>
    <thead><tr><th>分類</th><th class="num">收入</th><th class="num">支出</th></tr></thead>
    <tbody>
      ${[...new Set([...sum.byCategory('income').map(c => c[0]), ...sum.byCategory('expense').map(c => c[0])])].map(c => {
        const i = sum.byCategory('income').find(x => x[0] === c);
        const e = sum.byCategory('expense').find(x => x[0] === c);
        return `<tr><td>${esc(c)}</td><td class="num">${i ? nf(i[1], 2) : ''}</td><td class="num">${e ? nf(e[1], 2) : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="3">（此期間冇帳目）</td></tr>'}
    </tbody>
    <tfoot><tr><td>合計</td><td class="num">${nf(sum.income, 2)}</td><td class="num">${nf(sum.expense, 2)}</td></tr></tfoot>
  </table>
  ${withRows && sum.rows.length ? `<h3>逐筆帳目</h3>
  <table><thead><tr><th>日期</th><th>項目</th><th>分類</th><th>方式</th><th>經手人</th><th class="num">收入</th><th class="num">支出</th></tr></thead>
  <tbody>${rows}</tbody></table>` : ''}`;
}

function currentRanges() {
  const years = listYears(tx(), settings());
  const s = settings();
  const scout = scoutFYRange(scoutPick || years.scout[0].key, Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1));
  const unit = unitFYRange(unitPick || years.unit[0].key, s.agmDates);
  return {
    scout, unit,
    sSum: summarize(tx(), scout), uSum: summarize(tx(), unit),
    sOpen: openingOf(scout.key, scout).amount, uOpen: openingOf(unit.key, unit).amount
  };
}

function reportMeta() {
  const p = profile();
  return `${p.name || ''} · 列印日期 ${todayISO()} · 由深資童軍管理系統輸出`;
}

function exportReportWord(both = true, which = 'unit') {
  const r = currentRanges();
  const head = `<div class="doc-head">
      <div class="doc-org">${esc(profile().name || '')}</div>
      <div class="doc-title">財務報告</div>
      <div class="doc-sub">${both ? '雙財政年度報告（旅年度 AGM 起計 ＋ 童軍年度 4/1–3/31）' : esc(which === 'unit' ? r.unit.title : r.scout.title)}</div>
    </div>`;
  const body = head +
    (both || which === 'unit' ? reportHtml(`一、${r.unit.title}（旅年度：AGM 起計）`, r.unit, r.uSum, r.uOpen) : '') +
    (both || which === 'scout' ? reportHtml(`二、${r.scout.title}（旅團／童軍年度：4 月 1 日至 3 月 31 日）`, r.scout, r.sSum, r.sOpen) : '') +
    `<p class="note">備註：本團為自務自治深資童軍團，旅財政年度由每年 AGM 起計；童軍總會財政年度則為每年 4 月 1 日至 3 月 31 日。兩段期間可能重疊，屬正常情況。</p>
     <div class="foot"><span>${esc(profile().name || '')}</span><span>司庫簽署：________________</span><span>${todayISO()}</span></div>`;
  toWord({ filename: `財務報告_${both ? '雙年度' : which}_${stamp()}.doc`, title: '財務報告', org: profile().name, bodyHtml: body });
}

function exportReportPdf(both = true, which = 'unit') {
  const r = currentRanges();
  const body = `<div class="doc-head"><div class="doc-title">財務報告</div>
      <div class="doc-sub">${esc(profile().name || '')} · ${todayISO()}</div></div>` +
    (both || which === 'unit' ? reportHtml(`一、${r.unit.title}`, r.unit, r.uSum, r.uOpen) : '') +
    (both || which === 'scout' ? reportHtml(`二、${r.scout.title}`, r.scout, r.sSum, r.sOpen) : '') +
    `<div class="foot"><span>司庫簽署：____________</span><span>主席簽署：____________</span><span>${todayISO()}</span></div>`;
  printDoc({ title: '財務報告', org: profile().name, bodyHtml: body });
}

/** 而家睇緊嘅範圍（帳目 / 過往紀錄 兩個分頁都用同一個匯出） */
function currentSelection() {
  if (tab === 'history') {
    const range = yearRange(histYear);
    const yearTx = tx().filter(t => inRange(t.date, range.start, range.end));
    const list = histMonth ? yearTx.filter(t => String(t.date).slice(0, 7) === histMonth) : yearTx;
    return {
      list: applyFilters(list),
      label: histMonth ? `${histYear} ${monthText(histMonth)}` : `${histYear} 年度`,
      year: histYear, month: histMonth || '', opening: openingOf(histYear, range).amount
    };
  }
  if (tab === 'ledger') {
    const fy = currentFY();
    const range = yearRange(fy);
    const yearTx = txInYear(fy);
    const month = ledgerMode === 'month' ? fMonth : '';
    const list = month ? yearTx.filter(t => String(t.date).slice(0, 7) === month) : yearTx;
    return {
      list: applyFilters(list),
      label: month ? `${fy} ${monthText(month)}` : `${fy} 年度`,
      year: fy, month, opening: openingOf(fy, range).amount
    };
  }
  return { list: applyFilters(tx()), label: '全部帳目', year: '', month: '', opening: null };
}

function exportLedgerCsv(sel = currentSelection()) {
  const rows = sel.list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(t => [
    t.date, t.type === 'income' ? '收入' : '支出', t.item, t.amount, t.category || '', t.method || '',
    t.byName || (t.by ? memberName(t.by) : ''), t.ref || '', t.receipt ? '有' : '', t.note || '',
    unitFYOf(t.date, settings().agmDates).key
  ]);
  toCSV({
    filename: `帳目_${sel.label.replace(/\s/g, '')}_${stamp()}.csv`,
    headers: ['日期', '類型', '項目', '金額', '分類', '方式', '經手人', '單據號', '單據', '備註', '旅年度'],
    rows
  });
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  /* 分頁掣由 main.js 統一綁（ui.js tabs() → [data-tabnav]），呢度唔使再綁 */
  root.querySelectorAll('[data-cf]').forEach(b => b.addEventListener('click', () => { claimFilter = b.dataset.cf; refresh(); }));
  root.querySelectorAll('[data-act="entry-share"]').forEach(b => b.addEventListener('click', () => entryShareDialog()));

  /* 帳目（本年度）：總覽 / 按月 */
  root.querySelectorAll('[data-ledger-mode]').forEach(b => b.addEventListener('click', () => {
    ledgerMode = b.dataset.ledgerMode;
    if (ledgerMode === 'month' && !fMonth) {
      const months = fyMonths(currentFY());
      const has = txInYear(currentFY()).map(t => String(t.date).slice(0, 7));
      fMonth = months.filter(m => has.includes(m)).pop() || months[0];
    }
    go('#/finance/ledger');
    refresh();
  }));
  /* 12 個月一覽：撳任何一個月（包括冇紀錄）都可以入去 */
  root.querySelectorAll('[data-fy-month]').forEach(b => b.addEventListener('click', () => {
    fMonth = b.dataset.fyMonth; ledgerMode = 'month'; refresh();
  }));

  /* 過往紀錄：年度 → 月份 */
  const histYearSel = root.querySelector('#histYear');
  if (histYearSel) histYearSel.addEventListener('change', () => { histYear = histYearSel.value; histMonth = ''; refresh(); });
  const histMonthSel = root.querySelector('#histMonth');
  if (histMonthSel) histMonthSel.addEventListener('change', () => { histMonth = histMonthSel.value; refresh(); });
  root.querySelectorAll('[data-hist-month]').forEach(b => b.addEventListener('click', () => { histMonth = b.dataset.histMonth; refresh(); }));
  root.querySelector('[data-hist-jump]')?.addEventListener('click', () => {
    ledgerMode = 'overview'; histMonth = ''; tab = 'ledger'; go('#/finance/ledger'); refresh();
  });

  /* 年度設定頁：輸入先暫存喺瀏覽器，撳「儲存」先寫入（防呆） */
  if (tab === 'settings') {
    const autosave = bindDraftAutosave(root, 'fin-settings', load().unitCode);
    const rec = readDraft('fin-settings', load().unitCode);
    if (rec) {
      applyDraft(root, 'fin-settings', load().unitCode);
      autosave.markDirty();   // 回填入版前舊草稿＝有內容，唔係「一隻未掂過嘅分頁」
    }
    /* 用舊帳嘅數字填返**對應年度**：8,803.28 係 2025-26 嘅期初，
       佢嘅期末 7,846.64 先係 2026-27 嘅期初 —— 唔會再填錯年度 */
    root.querySelector('[data-act="use-ref-opening"]')?.addEventListener('click', () => {
      const ref = load().reference || {};
      const open0 = Number(ref.openingBalance || 0);
      if (!open0) { toast('舊帳冇期初結餘', 'err'); return; }
      const bal = balanceBreakdown();
      const refY = bal.referenceYear;
      if (!refY) { toast('舊帳冇日期，推唔到年度', 'err'); return; }
      const close0 = bal.referenceClosing;
      const y = Number(refY.split('-')[0]) + 1;
      const nextY = `${y}-${String(y + 1).slice(-2)}`;
      const a = root.querySelector(`[data-open-year="${refY}"]`);
      const b = root.querySelector(`[data-open-year="${nextY}"]`);
      if (!a && !b) { toast(`搵唔到 ${refY} / ${nextY} 嘅欄位`, 'err'); return; }
      if (a) a.value = String(open0);
      if (b) b.value = String(Math.round(close0 * 100) / 100);
      saveDraft('fin-settings', load().unitCode, collectSettings(root));
      toast(`已填 ${refY} 期初 ${money(open0)}${b ? `，${nextY} 期初 ${money(close0)}` : ''}（撳「儲存」生效）`, 'ok');
    });

    /* 逐年 / 一鍵結轉：本年度期初 = 上年度期末 */
    const fillCarry = yearKey => {
      const prev = prevFYKey(yearKey);
      const pr = yearRange(prev);
      const prevRows = tx().filter(t => inRange(t.date, pr.start, pr.end));
      const val = Math.round((openingOf(prev, pr).amount + balance(prevRows)) * 100) / 100;
      const el = root.querySelector(`[data-open-year="${yearKey}"]`);
      if (!el) return null;
      el.value = String(val);
      return val;
    };
    root.querySelectorAll('[data-carry-year]').forEach(b => b.addEventListener('click', () => {
      const v = fillCarry(b.dataset.carryYear);
      if (v === null) return;
      saveDraft('fin-settings', load().unitCode, collectSettings(root));
      toast(`${b.dataset.carryYear} 期初已結轉為 ${money(v)}（撳「儲存」生效）`, 'ok');
    }));
    root.querySelector('[data-act="carry-all"]')?.addEventListener('click', () => {
      const done = [];
      openingYearList().slice().reverse().forEach(y => {
        const v = fillCarry(y);
        if (v !== null) done.push(`${y} ${money(v)}`);
      });
      saveDraft('fin-settings', load().unitCode, collectSettings(root));
      toast(done.length ? `已按年度結轉：${done.join(' · ')}（撳「儲存」生效）` : '冇可結轉嘅年度', done.length ? 'ok' : 'err');
    });
  }

  const sel = {
    month: root.querySelector('#fMonth'), type: root.querySelector('#fType'),
    cat: root.querySelector('#fCat'), kw: root.querySelector('#fKw'),
    period: root.querySelector('#feePeriod')
  };
  if (sel.month) sel.month.addEventListener('change', () => { fMonth = sel.month.value; ledgerMode = 'month'; refresh(); });
  if (sel.type) sel.type.addEventListener('change', () => { fType = sel.type.value; refresh(); });
  if (sel.cat) sel.cat.addEventListener('change', () => { fCat = sel.cat.value; refresh(); });
  if (sel.kw) sel.kw.addEventListener('input', () => { fKw = sel.kw.value; clearTimeout(sel.kw._t); sel.kw._t = setTimeout(refresh, 220); });
  if (sel.period) sel.period.addEventListener('change', () => {
    feePeriod = sel.period.value;
    setQuery({ period: feePeriod });
    refresh();
  });

  root.querySelectorAll('[data-unit-year]').forEach(s => s.addEventListener('change', () => { unitPick = s.value; refresh(); }));
  root.querySelectorAll('[data-scout-year]').forEach(s => s.addEventListener('change', () => { scoutPick = s.value; refresh(); }));

  root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); go('#/finance/edit/' + b.dataset.edit); }));
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const t = find('transactions', b.dataset.del);
    if (await confirmDlg({ title: '刪除帳目', danger: true, okText: '確定刪除', message: `確定刪除「${esc(t?.item || '')}」${money(t?.amount)}？` })) {
      remove('transactions', b.dataset.del); toast('已刪除', 'ok'); refresh();
    }
  }));

  root.querySelectorAll('[data-mark]').forEach(b => b.addEventListener('click', () => markFee(b.dataset.mark, true)));
  root.querySelectorAll('[data-unmark]').forEach(b => b.addEventListener('click', () => markFee(b.dataset.unmark, false)));
  // 即場為單一團員建立本年度團費（金額跟標準設定）
  root.querySelectorAll('[data-new-fee]').forEach(b => b.addEventListener('click', () => {
    const period = feePeriod || feePeriodOf(todayISO());
    add('fees', {
      id: uid('f'), memberId: b.dataset.newFee, period, label: `${period} 團費`,
      amount: standardFee(period), due: defaultFeeDue(period), paid: false
    });
    toast('已建立團費紀錄', 'ok'); refresh();
  }));
  // 逐個團員改金額（未建立都會即場建立）
  root.querySelectorAll('[data-editfee]').forEach(b => b.addEventListener('click', () => editFeeAmount(b.dataset.editfee)));
  // 已有紀錄但未入帳 → 補一筆收入
  root.querySelectorAll('[data-link-fee]').forEach(b => b.addEventListener('click', () => {
    const f = find('fees', b.dataset.linkFee);
    if (!f || !can('finance.create')) return;
    const t = add('transactions', {
      id: uid('t'), type: 'income', date: f.paidDate || todayISO(), amount: Number(f.amount) || 0,
      category: '團費', item: `${memberName(f.memberId)} 團費${f.period ? `（${f.period}）` : ''}`,
      method: f.method || '現金', by: f.memberId, byName: memberName(f.memberId), ref: f.ref || '',
      note: '由「團費」收款表補入帳', feeId: f.id, createdBy: current()?.username || ''
    });
    update('fees', f.id, { txId: t?.id || '' });
    toast('已補入帳', 'ok'); refresh();
  }));
  root.querySelectorAll('[data-receipt]').forEach(b => b.addEventListener('click', () => feeReceipt(b.dataset.receipt)));
  root.querySelectorAll('[data-delfee]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除收費項目', danger: true, okText: '確定刪除', message: '確定刪除此收費項目？' })) {
      remove('fees', b.dataset.delfee); toast('已刪除', 'ok'); refresh();
    }
  }));

  root.querySelectorAll('[data-editbudget]').forEach(b => b.addEventListener('click', () => budgetForm(find('budgets', b.dataset.editbudget))));
  root.querySelectorAll('[data-delbudget]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除預算', danger: true, okText: '確定刪除', message: '確定刪除此活動預算？' })) {
      remove('budgets', b.dataset.delbudget); toast('已刪除', 'ok'); refresh();
    }
  }));

  root.querySelectorAll('[data-claim]').forEach(b => b.addEventListener('click', () => claimAction(b.dataset.claim, b.dataset.id)));

  // 帳目表單
  const typeSel = root.querySelector('#t-type');
  if (typeSel) {
    fillCats(root, typeSel.value, find('transactions', params.action)?.category);
    typeSel.addEventListener('change', () => fillCats(root, typeSel.value, null));
  }

  const impFile = root.querySelector('#imp-file');
  if (impFile) impFile.addEventListener('change', async () => {
    const f = impFile.files && impFile.files[0];
    if (!f) return;
    try {
      const text = await readImportFile(f);
      root.querySelector('#imp-text').value = text;
      toast(`已讀取 ${f.name}（${text.split(/\r?\n/).length} 行）`, 'ok');
      showImportPreview(root);
    } catch (e) { toast(e.message || '讀取失敗', 'err'); }
    impFile.value = '';
  });

  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;

    if (act === 'add') return go('#/finance/new');
    if (act === 'exp-csv') { const s = currentSelection(); exportLedgerCsv(s); toast(`已匯出 CSV（${s.label}）`, 'ok'); }
    if (act === 'exp-all-csv') { exportLedgerCsv({ list: applyFilters(tx()), label: '全部帳目', year: '', month: '', opening: null }); toast('已匯出全部帳目 CSV', 'ok'); }
    if (act === 'exp-word') { const s = currentSelection(); exportRangeWord(s); toast(`已輸出 Word（${s.label}）`, 'ok'); }
    if (act === 'exp-pdf') { exportRangePdf(currentSelection()); }
    if (act === 'exp-report-word') { exportReportWord(true); toast('已輸出雙年度報告（Word）', 'ok'); }
    if (act === 'exp-report-pdf') { exportReportPdf(true); }
    if (act === 'exp-report-unit') { exportReportWord(false, 'unit'); toast('已輸出旅年度報告', 'ok'); }
    if (act === 'exp-report-scout') { exportReportWord(false, 'scout'); toast('已輸出童軍年度報告', 'ok'); }
    if (act === 'exp-report-csv') { exportLedgerCsv(); toast('已匯出逐筆帳目 CSV', 'ok'); }

    if (act === 'save-tx') {
      const v = k => root.querySelector(k)?.value.trim() || '';
      const amount = Number(v('#t-amount'));
      const err = root.querySelector('#t-err');
      if (!v('#t-item')) { err.textContent = '請填項目名稱'; err.style.display = 'block'; return; }
      if (!(amount > 0)) { err.textContent = '金額要係 0 以上'; err.style.display = 'block'; return; }
      const memberId = v('#t-member');
      const patch = {
        type: root.querySelector('#t-type').value,
        amount, date: v('#t-date') || todayISO(),
        category: root.querySelector('#t-cat').value,
        item: v('#t-item'), method: root.querySelector('#t-method').value,
        by: memberId, byName: memberId ? memberName(memberId) : (find('transactions', b.dataset.id)?.byName || ''),
        ref: v('#t-ref'), receipt: root.querySelector('#t-receipt').checked, note: v('#t-note')
      };
      if (b.dataset.id) { update('transactions', b.dataset.id, patch); toast('已更新帳目', 'ok'); }
      else { add('transactions', { id: uid('t'), ...patch, createdBy: current()?.username || 'super' }); toast('已新增帳目', 'ok'); }
      go('#/finance');
    }

    if (act === 'save-settings-page') {
      const patch = collectSettings(root);
      const negY = Object.keys(patch.openingBalances).find(y => patch.openingBalances[y] < 0);
      if (negY) {
        if (!(await confirmDlg({
          title: '期初結餘係負數？', okText: '確定用負數',
          message: `你把 <b>${esc(negY)} 年度</b>嘅期初結餘填咗 <b>${money(patch.openingBalances[negY])}</b>。如果旅團本身有底數，通常應該填正數（＝上年度期末）。`
        }))) return;
      }
      const curY = currentFY();
      if (patch.openingBalances[curY] === undefined && !Object.keys(patch.openingBalances).length) {
        if (!(await confirmDlg({
          title: '全部年度嘅期初都留空？', okText: '確定留空',
          message: `留空即係由系統自動結轉（${esc(curY)} 年度會用 ${esc(prevFYKey(curY))} 嘅期末）。如果上年度帳目未入齊，結餘會唔準。`
        }))) return;
      }
      const db = load();
      db.settings = { ...db.settings, ...patch };
      commit();
      clearDraft('fin-settings', load().unitCode);
      toast('已儲存設定', 'ok');
      refresh();
      return;
    }

    if (act === 'settings') {
      const s = settings();
      const r = await modal({
        title: '設定', sub: '期初結餘、AGM 日期、收費預設',
        body: `
          <div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">期初結餘</label>
              <input class="input" id="s-open" type="number" value="${s.openingBalance || 0}"></div>
            <div class="field"><label class="label">期初日期</label>
              <input class="input" id="s-opendate" value="${esc(s.openingBalanceDate || '')}" placeholder="YYYY-MM-DD"></div>
            <div class="field"><label class="label">童軍年度起始月</label>
              <input class="input" id="s-fym" type="number" min="1" max="12" value="${s.scoutFYStartMonth || 4}"></div>
            <div class="field"><label class="label">童軍年度起始日</label>
              <input class="input" id="s-fyd" type="number" min="1" max="31" value="${s.scoutFYStartDay || 1}"></div>
            <div class="field"><label class="label">團費（每位每年）</label>
              <input class="input" id="s-fee" type="number" step="0.01" value="${standardFee()}"></div>
            <div class="field"><label class="label">海外／優惠團費</label>
              <input class="input" id="s-feeovs" type="number" step="0.01" value="${overseasFee()}"></div>
          </div>
          <div class="field mt-12"><label class="label">AGM 日期（每年唔同）</label>
            <div class="card" style="padding:10px 12px">
              <div class="sm">${(s.agmDates || []).filter(a => a.date).map(a => `<span class="tag">${esc(a.year)} · ${esc(a.date)}${agmIsDefault(a.year, s.agmDates) ? '（未確認）' : ''}</span>`).join(' ') || '<span class="faint">未設定</span>'}</div>
            </div>
            <div class="hint">旅財政年度由 AGM 起計到下一年 AGM 前一日。呢度唔改住都得，返「財政年度報告」頁可以逐年輸入。</div></div>`,
        actions: [{ label: '取消', class: 'btn', value: null },
          { label: '儲存', class: 'btn-primary', onClick: el => ({
            openingBalance: Number(el.querySelector('#s-open').value) || 0,
            openingBalanceDate: el.querySelector('#s-opendate').value.trim(),
            scoutFYStartMonth: Number(el.querySelector('#s-fym').value) || 4,
            scoutFYStartDay: Number(el.querySelector('#s-fyd').value) || 1,
            feePerYear: Number(el.querySelector('#s-fee').value) || 0,
            feeOverseas: Number(el.querySelector('#s-feeovs').value) || 0,
            agmDates: s.agmDates || []
          }) }]
      });
      if (r) {
        const db = load();
        db.settings = { ...db.settings, ...r };
        commit(); toast('已儲存設定', 'ok'); refresh();
      }
    }

    if (act === 'agm') return agmDialog();

    if (act === 'fee-settings') return feeSettings();
    if (act === 'gen-fees') return genFees();
    if (act === 'add-fee') return addFee();
    if (act === 'copy-unpaid') {
      const period = feePeriod || feePeriodOf(todayISO());
      const unpaid = feeStats(period).rows.filter(r => !r.paid);
      const text = `【${profile().name || ''}】${period} 年度團費催繳\n`
        + (unpaid.length
          ? unpaid.map(r => `${r.member.name}：${money(r.amount)}（到期 ${r.due || '—'}）`).join('\n')
          : '全部已收，多謝！')
        + `\n未收合計 ${money(unpaid.reduce((a, r) => a + r.amount, 0))} · ${unpaid.length} 人`;
      if (await copyText(text)) toast('已複製催繳名單', 'ok'); else toast('複製失敗', 'err');
    }
    if (act === 'mark-all-paid') {
      const period = feePeriod || feePeriodOf(todayISO());
      const rows = feeStats(period).rows.filter(r => !r.paid);
      if (!rows.length) { toast('全部都已收', 'ok'); return; }
      if (!(await confirmDlg({ title: '一鍵全部標記已收', danger: true, okText: '確定',
        message: `會將 <b>${esc(period)}</b> 年度未收嘅 <b>${rows.length}</b> 位團員全部標記為今日已收，
          並自動入帳合計 <b>${money(rows.reduce((a, r) => a + r.amount, 0))}</b>。` }))) return;
      let n = 0;
      rows.forEach(r => {
        let id = r.id;
        if (!id) {
          id = add('fees', {
            id: uid('f'), memberId: r.member.id, period, label: `${period} 團費`,
            amount: r.amount, due: `${period.slice(0, 4)}-09-30`, paid: false
          })?.id;
        }
        const t = can('finance.create') ? add('transactions', {
          id: uid('t'), type: 'income', date: todayISO(), amount: r.amount,
          category: '團費', item: `${r.member.name} 團費（${period}）`,
          method: '現金', by: r.member.id, byName: r.member.name,
          note: '由「團費」收款表一鍵入帳', feeId: id, createdBy: current()?.username || ''
        }) : null;
        update('fees', id, { paid: true, paidDate: todayISO(), method: '現金', txId: t?.id || '' });
        n++;
      });
      toast(`已標記 ${n} 人已收並入帳`, 'ok'); refresh();
    }
    if (act === 'exp-fee-word') { exportFeesWord(); toast('已輸出 Word', 'ok'); }
    if (act === 'exp-fee-csv') {
      const period = feePeriod || feePeriodOf(todayISO());
      const g = feeStats(period);
      toCSV({
        filename: `團費收款表_${period}_${stamp()}.csv`,
        headers: ['期數', '團員', '金額', '狀態', '收款日', '方式', '收據/單號', '經手人', '已入帳'],
        rows: g.rows.map(r => [period, r.member.name, r.amount, r.paid ? '已收' : '未收', r.paidDate || '', r.method || '',
          r.ref || '', r.member.role || '', r.txId ? '是' : '否'])
      });
      toast('已匯出團費收款表 CSV', 'ok');
    }

    if (act === 'new-claim') return claimForm();
    if (act === 'new-budget') return budgetForm(null);

    if (act === 'do-import') {
      showImportPreview(root);
    }

    if (act === 'import-ref') {
      const ref = load().reference || {};
      if (!(ref.transactions || []).length) return;
      const feeRows = ref.transactions.filter(t => t.type === 'income' && /團費/.test(t.item || '') && matchMemberByName(t.byName || ''));
      const inc = ref.transactions.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount || 0), 0);
      const exp = ref.transactions.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount || 0), 0);
      const refYear = refYearKey(ref);
      const refClose = Number(ref.check?.closing ?? ((Number(ref.openingBalance) || 0) + inc - exp));
      // 下一個年度 key：短年份要用**結束年**（2025-26 → 2026-27，唔係 2026-26）
      const nextYear = (() => {
        if (!refYear) return '';
        const y = Number(refYear.split('-')[0]) + 1;   // 新年度起始年
        return `${y}-${String(y + 1).slice(-2)}`;      // 2026-27
      })();
      const r = await modal({
        title: '匯入舊帳（參考資料）', sub: esc(ref.sheetLabel || 'Google Sheet'),
        body: `
          <div class="kpi">
            <div><div class="k">帳目</div><div class="v">${ref.transactions.length} 筆</div></div>
            <div><div class="k">收入</div><div class="v">${money(inc)}</div></div>
            <div><div class="k">支出</div><div class="v">${money(exp)}</div></div>
            <div><div class="k">期末</div><div class="v">${money(refClose)}</div></div>
          </div>
          ${refYear ? `<div class="note-box mb-12">${icon('alert', 15)}<div>
            呢張分頁係 <b>${esc(refYear)} 年度</b>（帳目由 ${esc(String((ref.transactions.map(t => t.date).sort()[0] || '').slice(0, 10)))} 至 ${esc(String((ref.transactions.map(t => t.date).sort().slice(-1)[0] || '').slice(0, 10)))}）。<br>
            <b>${money(ref.openingBalance || 0)}</b> 係 <b>${esc(refYear)}</b> 嘅<b>期初</b>；
            <b>${money(refClose)}</b> 係 ${esc(refYear)} 嘅<b>期末</b>，會結轉做 <b>${esc(nextYear)}</b> 嘅期初。</div></div>` : ''}
          <label class="check mt-12"><input type="checkbox" id="ir-open" ${ref.openingBalance ? 'checked' : ''}>
            <b>${esc(refYear || '該年度')}</b> 期初結餘設為 <b>${money(ref.openingBalance || 0)}</b>（原表「上年度結餘」）</label>
          <label class="check mt-8"><input type="checkbox" id="ir-carry" ${nextYear ? 'checked' : ''} ${nextYear ? '' : 'disabled'}>
            <b>${esc(nextYear)}</b> 期初結餘設為 <b>${money(refClose)}</b>（＝${esc(refYear || '上年度')} 期末，自動結轉）</label>
          <label class="check mt-8"><input type="checkbox" id="ir-fee" ${feeRows.length ? 'checked' : ''} ${feeRows.length ? '' : 'disabled'}>
            順便喺團費收款表標記已收（認得出 ${feeRows.length} 筆）</label>
          <label class="check mt-8"><input type="checkbox" id="ir-receipt" checked>保留單據連結（Google Drive）</label>
          <div class="hint mt-8">唔會刪除現有資料；匯入後可以逐筆核對、修改或刪除。</div>`,
        actions: [{ label: '取消', class: 'btn', value: null },
          { label: '確認匯入', class: 'btn-primary', onClick: el => ({
            open: el.querySelector('#ir-open').checked,
            carry: el.querySelector('#ir-carry').checked,
            fee: el.querySelector('#ir-fee').checked,
            receipt: el.querySelector('#ir-receipt').checked
          }) }]
      });
      if (!r) return;

      let feeN = 0;
      ref.transactions.forEach(t => {
        const m = matchMemberByName(t.byName || '') || matchMemberByName(t.item || '');
        const tx = add('transactions', {
          id: uid('t'), date: t.date || todayISO(), type: t.type, category: t.category || '其他',
          item: t.item, amount: Number(t.amount) || 0, method: t.method || '現金',
          by: m?.id || '', byName: t.byName || '', note: t.note || '',
          receipt: !!(r.receipt && t.receiptLink), receiptLink: r.receipt ? (t.receiptLink || '') : '',
          period: t.period || '', reference: true, createdBy: current()?.username || ''
        });
        if (r.fee && t.type === 'income' && /團費/.test(t.item || '') && m) {
          const period = t.period || feePeriodOf(t.date);
          let f = feeOf(m.id, period);
          if (!f) f = add('fees', { id: uid('f'), memberId: m.id, period, label: `${period} 團費`,
            amount: Number(t.amount) || standardFee(), due: defaultFeeDue(period), paid: false });
          if (f && !f.paid) {
            update('fees', f.id, { paid: true, amount: Number(t.amount) || f.amount, paidDate: t.date,
              method: t.method || '現金', receivedBy: t.byName || '', txId: tx?.id || '' });
            feeN++;
          }
        }
      });
      /* 期初結餘要**逐年**寫入：呢張分頁嘅年度用原表「上年度結餘」，
         下一個年度用「期末」結轉過去（例：2025-26 期初 8,803.28 → 期末 7,846.64 → 2026-27 期初 7,846.64） */
      if (r.open && ref.openingBalance && refYear) {
        const db = load();
        const map = { ...(db.settings.openingBalances || {}) };
        map[refYear] = Number(ref.openingBalance);
        if (r.carry && nextYear) map[nextYear] = Math.round(refClose * 100) / 100;
        db.settings = { ...db.settings, openingBalances: map };
        commit();
      }
      toast(`已匯入 ${ref.transactions.length} 筆${feeN ? `，並標記 ${feeN} 人團費已收` : ''}${
        r.open && refYear ? `，${refYear} 期初 ${money(ref.openingBalance || 0)}${r.carry && nextYear ? ` → ${nextYear} 期初 ${money(refClose)}` : ''}` : ''}`, 'ok');
      refresh();
    }

    if (act === 'exp-template') {
      toCSV({
        filename: '82venture_記帳範本.csv',
        headers: ['日期', '類型', '項目', '金額', '分類', '方式', '經手人', '年度', '團費', '備註'],
        rows: [
          ['2026-09-01', '收入', '團費', '360', '團費', '現金', '陳大文', '2026-27', '✓', '例：打 ✓ 系統會順便標記團費已收'],
          ['2026-09-05', '支出', '場地租金', '600', '場地', '轉數快 FPS', '司庫', '2026-27', '', '例：可刪'],
          ['2026-09-12', '收入', '賣旗籌款', '1250.50', '捐款', '現金', '嘉詠', '2026-27', '', '']
        ]
      });
      toast('已下載記帳範本（含團費欄）', 'ok');
    }
  }));
}

/* ---------- 動作 ---------- */
/** 標記收款（順便自動入帳，唔使再入一次） */
async function markFee(id, paid) {
  const f = find('fees', id);
  if (!f) return;
  if (!paid) {
    // 取消收款：連相關入帳一齊撤銷（如果未刪）
    const linked = f.txId ? find('transactions', f.txId) : null;
    if (linked && !(await confirmDlg({ title: '取消收款', danger: true, okText: '確定取消',
      message: `會將 <b>${esc(memberName(f.memberId))}</b> 嘅 ${esc(f.period || '')} 團費改回「未收」，
        並撤銷相關帳目（${esc(linked.item)} ${money(linked.amount)}）。` }))) return;
    update('fees', id, { paid: false, paidDate: '', method: '' });
    if (linked) { remove('transactions', linked.id); }
    update('fees', id, { txId: '' });
    toast('已取消收款' + (linked ? '（相關帳目已撤銷）' : ''), 'ok');
    refresh();
    return;
  }

  const r = await modal({
    title: '標記團費已收', sub: `${memberName(f.memberId)} · ${f.period || ''}`,
    body: `
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">收到金額</label>
          <input class="input" id="m-amount" type="number" step="0.01" value="${Number(f.amount) || 0}"></div>
        <div class="field"><label class="label">收款日期</label>
          <input class="input" id="m-date" type="date" value="${todayISO()}"></div>
        <div class="field"><label class="label">方式</label>
          <select class="select" id="m-method">${methods().map(m => `<option ${m === (f.method || '現金') ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
        <div class="field"><label class="label">收據 / 單號</label>
          <input class="input" id="m-ref" value="${esc(f.ref || '')}" placeholder="例：FPS-2026-001"></div>
        <div class="field"><label class="label">經手人</label>
          <input class="input" id="m-by" value="${esc(f.receivedBy || current()?.name || '')}"></div>
      </div>
      <label class="check mt-12"><input type="checkbox" id="m-post" ${(!f.txId && can('finance.create')) ? 'checked' : ''}>
        同時自動入帳（喺「帳目」加一筆收入）</label>
      <div class="hint mt-8">已經有相關帳目嘅話，就唔會重複入帳。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '確認已收', class: 'btn-primary', onClick: el => ({
        amount: Number(el.querySelector('#m-amount').value) || 0,
        date: el.querySelector('#m-date').value || todayISO(),
        method: el.querySelector('#m-method').value,
        ref: el.querySelector('#m-ref').value.trim(),
        receivedBy: el.querySelector('#m-by').value.trim(),
        post: el.querySelector('#m-post').checked
      }) }]
  });
  if (!r) return;

  let txId = f.txId || '';
  const existing = txId ? find('transactions', txId) : null;
  const amount = Number(r.amount) || Number(f.amount) || 0;
  if (existing && Number(existing.amount) !== amount) update('transactions', existing.id, { amount });
  if (r.post && !existing && can('finance.create')) {
    const t = add('transactions', {
      id: uid('t'), type: 'income', date: r.date, amount,
      category: '團費', item: `${memberName(f.memberId)} 團費${f.period ? `（${f.period}）` : ''}`,
      method: r.method, by: f.memberId, byName: memberName(f.memberId), ref: r.ref,
      note: `由「團費」收款表自動入帳`, feeId: f.id, createdBy: current()?.username || ''
    });
    txId = t?.id || '';
  }
  update('fees', f.id, {
    paid: true, amount, paidDate: r.date, method: r.method, ref: r.ref, receivedBy: r.receivedBy, txId,
    linkedAt: new Date().toISOString()
  });
  toast(`已標記收款${r.post && !existing ? '（已自動入帳）' : ''}`, 'ok');
  refresh();
}

async function genFees() {
  const s = settings();
  const period = feePeriod || feePeriodOf(todayISO());
  const std = standardFee();
  const ovs = overseasFee();
  /* 領袖（＋任何剔咗「免收團費」嘅人）唔會出現在團費名單 */
  const exempt = feeExemptList();
  const list = members().filter(m => m.status !== 'alumni' && !feeExempt(m)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'));
  const r = await modal({
    title: '開新年度團費', sub: '每人金額可以逐個改（新入團按月、海外團員 1/4 …）', wide: true,
    body: `
      <div class="grid g-3" style="gap:12px">
        <div class="field"><label class="label">期數標籤</label>
          <input class="input" id="g-period" value="${esc(period)}"></div>
        <div class="field"><label class="label">到期日</label>
          <input class="input" id="g-due" type="date" value="${esc(defaultFeeDue(period))}"></div>
        <div class="field"><label class="label">快速套用</label>
          <div class="row gap-6">
            <button class="btn btn-sm" type="button" data-fill="${std}">全部 ${money(std)}</button>
            <button class="btn btn-sm" type="button" data-fill="${ovs}">全部 ${money(ovs)}</button>
          </div></div>
      </div>
      <div class="hint mt-8">金額之後都可以喺收款表逐個再改。已經有紀錄嘅團員會顯示「已建立」。</div>
      <div class="scroll-x mt-12" style="max-height:46vh;overflow:auto">
        <table class="table table-compact"><thead><tr><th style="width:44%">團員</th><th style="width:26%">金額</th><th>狀態</th></tr></thead>
        <tbody>${list.map(m => {
          const has = fees().some(f => f.memberId === m.id && f.period === period);
          return `<tr>
            <td><label class="check" style="font-weight:400"><input type="checkbox" data-m="${m.id}" ${has ? 'disabled' : 'checked'}> ${esc(m.name)}</label></td>
            <td><input class="input" type="number" data-amt="${m.id}" value="${std}" ${has ? 'disabled' : ''}></td>
            <td class="xs">${has ? '<span class="badge b-ok">已建立</span>' : '<span class="badge b-warn">未建立</span>'}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '建立', class: 'btn-primary', onClick: el => {
        const period2 = el.querySelector('#g-period').value.trim() || period;
        const due = el.querySelector('#g-due').value || defaultFeeDue(period2);
        const items = [];
        el.querySelectorAll('input[data-m]').forEach(cb => {
          if (!cb.checked || cb.disabled) return;
          const amt = Number(el.querySelector(`input[data-amt="${cb.dataset.m}"]`).value) || 0;
          items.push({ memberId: cb.dataset.m, amount: amt });
        });
        return { period: period2, due, items };
      } }],
    onMount: el => {
      el.querySelectorAll('[data-fill]').forEach(b => b.addEventListener('click', () => {
        el.querySelectorAll('input[data-amt]').forEach(i => { if (!i.disabled) i.value = b.dataset.fill; });
      }));
    }
  });
  if (!r) return;
  let n = 0;
  r.items.forEach(it => {
    if (fees().some(f => f.memberId === it.memberId && f.period === r.period)) return;
    add('fees', {
      id: uid('f'), memberId: it.memberId, period: r.period, label: `${r.period} 團費`,
      amount: it.amount, due: r.due, paid: false
    });
    n++;
  });
  feePeriod = r.period;
  setQuery({ period: feePeriod });
  toast(`已建立 ${n} 筆團費（${r.period}）`, 'ok');
  refresh();
}

/* ---------- 團費金額設定（唔係寫死） ---------- */
async function feeSettings() {
  const s = settings();
  const r = await modal({
    title: '團費金額設定', sub: '改完之後，新建立嘅紀錄、未建立嘅團員都會用新金額（舊紀錄唔會自動改）',
    body: `
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">標準團費（每位團員每年）</label>
          <input class="input" id="f-std" type="number" step="0.01" value="${standardFee(feePeriod)}"></div>
        <div class="field"><label class="label">海外／優惠團費</label>
          <input class="input" id="f-ovs" type="number" step="0.01" value="${overseasFee()}"></div>
        <div class="field"><label class="label">預設到期日</label>
          <input class="input" id="f-due" value="${esc(s.feeDueTemplate || '{y}-09-30')}" placeholder="{y}-09-30"></div>
        <div class="field"><label class="label">年度標籤（顯示用）</label>
          <input class="input" id="f-label" value="${esc(s.feePeriodLabel || '')}" placeholder="例：2026–27 年度團費"></div>
      </div>
      <label class="check mt-12"><input type="checkbox" id="f-apply" checked>
        同時更新「未收」紀錄嘅金額（已收嘅保持不變）</label>
      <div class="hint mt-8">{y} 會自動換成年度首年（例：2026）。團章第 8 條：每年 $360、新入團按月、海外 1/4 —— 數目有變就喺呢度改。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        feePerYear: Number(el.querySelector('#f-std').value) || 0,
        feeOverseas: Number(el.querySelector('#f-ovs').value) || 0,
        feeDueTemplate: el.querySelector('#f-due').value.trim() || '{y}-09-30',
        feePeriodLabel: el.querySelector('#f-label').value.trim(),
        apply: el.querySelector('#f-apply').checked
      }) }]
  });
  if (!r) return;
  const { apply, ...settingsPatch } = r;
  const db = load();
  db.settings = { ...db.settings, ...settingsPatch };
  /* v2.4.0：呢個 modal 係針對某一期（period）改團費 → 寫入逐年 map（默認同上年嘅機制用） */
  const per = feePeriod || feePeriodOf(todayISO());
  db.settings.feePerYearMap = { ...(db.settings.feePerYearMap || {}), [per]: Number(settingsPatch.feePerYear) || 0 };
  commit();
  if (apply) {
    const period = feePeriod || feePeriodOf(todayISO());
    let n = 0;
    fees().filter(f => f.period === period && !f.paid).forEach(f => {
      if (Number(f.amount) !== Number(r.feePerYear)) { update('fees', f.id, { amount: Number(r.feePerYear) }); n++; }
    });
    if (n) toast(`已更新標準團費，並重設 ${n} 筆未收紀錄`, 'ok');
    else toast('已儲存團費金額設定', 'ok');
  } else {
    toast('已儲存團費金額設定', 'ok');
  }
  refresh();
}

/** 改單一團員嘅團費金額（未建立 → 即場建立；已收 → 連帳目一齊更新） */
async function editFeeAmount(memberId) {
  const period = feePeriod || feePeriodOf(todayISO());
  const f = feeOf(memberId, period);
  const m = member(memberId) || {};
  const std = standardFee(), ovs = overseasFee();
  const r = await modal({
    title: '團費金額', sub: `${m.name || ''} · ${period}`,
    body: `
      <div class="row gap-6 wrap mb-12">
        <button class="btn btn-sm" type="button" data-quick="${std}">標準 ${money(std)}</button>
        ${ovs !== std ? `<button class="btn btn-sm" type="button" data-quick="${ovs}">海外 ${money(ovs)}</button>` : ''}
        <button class="btn btn-sm" type="button" data-quick="${Math.round(std / 12)}">按月 ${money(Math.round(std / 12))}</button>
        <button class="btn btn-sm" type="button" data-quick="${Math.round(std / 2)}">半年 ${money(Math.round(std / 2))}</button>
      </div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">金額</label>
          <input class="input" id="ef-amt" type="number" step="0.01" value="${f ? f.amount : std}"></div>
        <div class="field"><label class="label">到期日</label>
          <input class="input" id="ef-due" type="date" value="${esc(f?.due || defaultFeeDue(period))}"></div>
      </div>
      <div class="field mt-12"><label class="label">備註（例：海外團員 / 6 月入團按月）</label>
        <input class="input" id="ef-note" value="${esc(f?.note || '')}"></div>
      ${f?.paid ? `<div class="note-box warn mt-12">${icon('alert', 15)}<div>呢筆已經標記「已收」，儲存時會<b>一併更新相關帳目嘅金額</b>。</div></div>` : ''}`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        amount: Number(el.querySelector('#ef-amt').value) || 0,
        due: el.querySelector('#ef-due').value,
        note: el.querySelector('#ef-note').value.trim()
      }) }],
    onMount: el => el.querySelectorAll('[data-quick]').forEach(b =>
      b.addEventListener('click', () => { el.querySelector('#ef-amt').value = b.dataset.quick; }))
  });
  if (!r) return;
  let id = f?.id;
  if (!id) {
    const created = add('fees', {
      id: uid('f'), memberId, period, label: `${period} 團費`,
      amount: r.amount, due: r.due, note: r.note, paid: false
    });
    id = created?.id;
  } else {
    update('fees', id, { amount: r.amount, due: r.due, note: r.note });
  }
  // 已收 → 連帳目一齊改
  const cur = find('fees', id);
  if (cur?.paid && cur.txId) {
    const t = find('transactions', cur.txId);
    if (t) update('transactions', t.id, { amount: r.amount, item: `${memberName(memberId)} 團費（${period}）` });
  }
  toast('已更新團費金額' + (cur?.paid && cur.txId ? '（帳目已同步）' : ''), 'ok');
  refresh();
}

async function addFee() {
  const r = await modal({
    title: '新增收費項目',
    body: `<div class="field"><label class="label">團員</label><select class="select" id="a-member">
        ${members().map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
      <div class="grid g-2 mt-12" style="gap:12px">
        <div class="field"><label class="label">項目名稱</label><input class="input" id="a-label" value="${esc(feePeriodOf(todayISO()))} 團費" placeholder="例：2026-27 團費"></div>
        <div class="field"><label class="label">金額</label><input class="input" id="a-amount" type="number" value="${settings().feePerYear || 360}"></div>
        <div class="field"><label class="label">期數</label><input class="input" id="a-period" value="${esc(feePeriodOf(todayISO()))}" placeholder="2026-27"></div>
        <div class="field"><label class="label">到期日</label><input class="input" id="a-due" value="${todayISO()}"></div>
      </div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '新增', class: 'btn-primary', onClick: el => ({
        memberId: el.querySelector('#a-member').value,
        label: el.querySelector('#a-label').value.trim() || '收費',
        amount: Number(el.querySelector('#a-amount').value) || 0,
        period: el.querySelector('#a-period').value.trim(),
        due: el.querySelector('#a-due').value
      }) }]
  });
  if (r) { add('fees', { id: uid('f'), ...r, paid: false }); toast('已新增收費項目', 'ok'); refresh(); }
}

/** 手機快速記帳：公開收集頁連結 + QR + 送出網址設定 */
export async function entryShareDialog() {
  const db = load();
  const code = db.unitCode;
  const cur = db.settings?.publicEntry?.submitUrl || db.sync?.url || '';
  const url = publicPageUrl('members.html', { u: code });

  const r = await modal({
    title: '團員入口（掃一次齊晒）',
    sub: '請只派呢一條。入去可以影單據、借物資、睇通告／行事曆／試卷',
    wide: true,
    body: `
      <div class="grid g-2" style="gap:16px">
        <div class="center">
          <div class="qr-box" style="width:210px;margin:0 auto">${qrSvg(url, 5, 2)}</div>
          <div class="xs faint mt-8">印出嚟貼喺團址／WhatsApp 群，成員掃 QR 就填得</div>
        </div>
        <div class="col gap-10">
          <div class="field"><label class="label">公開收集頁網址</label>
            <input class="input" id="es-url" value="${esc(url)}" readonly></div>
          <button class="btn btn-sm btn-block" data-es="copy">${icon('copy', 15)} 複製網址</button>
          <button class="btn btn-sm btn-block" data-es="svg">${icon('download', 15)} 下載 QR Code（SVG）</button>
          <button class="btn btn-sm btn-block" data-es="print">${icon('print', 15)} 列印 QR 海報</button>
          <div class="divider"></div>
          <div class="field"><label class="label">送出目的地（Apps Script /exec 網址，可留空）</label>
            <input class="input" id="es-submit" value="${esc(cur)}" placeholder="https://script.google.com/macros/s/…/exec">
            <div class="hint">填咗：成員一送出就直接寫入你嘅總 Sheet（「待批申報」分頁）。
              留空：紀錄只會存喺成員自己部手機，要佢按「複製內容」傳送畀司庫。</div></div>
          <label class="check sm"><input type="checkbox" id="es-samelink" checked> 同「總表同步」共用同一個 Apps Script</label>
        </div>
      </div>`,
    actions: [{ label: '關閉', class: 'btn', value: null },
      { label: '儲存設定', class: 'btn-primary', onClick: el => ({ submit: el.querySelector('#es-submit').value.trim(), same: el.querySelector('#es-samelink').checked }) }],
    onMount: el => {
      el.querySelectorAll('[data-es]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.es;
        if (a === 'copy') { if (await copyText(url)) toast('已複製網址', 'ok'); }
        if (a === 'svg') { downloadQrSvg(url, `手機記一筆QR_${code}.svg`); toast('已下載 QR Code', 'ok'); }
        if (a === 'print') {
          printDoc({
            title: '手機記一筆', org: profile().name,
            bodyHtml: `<div class="doc-head"><div class="doc-title">用手機記一筆</div>
              <div class="doc-sub">${esc(profile().name || '')}</div></div>
              <div class="center" style="margin:18px 0">${qrSvg(url, 6, 3)}</div>
              <p class="center">用手機相機掃上面嘅 QR Code，就可以影低單據、揀欄目，直接交畀司庫。</p>
              <p class="center xs">${esc(url)}</p>`
          });
        }
      }));
    }
  });
  if (!r) return;
  const d2 = load();
  d2.settings = { ...(d2.settings || {}), publicEntry: { ...(d2.settings?.publicEntry || {}), submitUrl: r.submit } };
  if (r.same && r.submit) d2.sync = { ...(d2.sync || {}), url: r.submit };
  commit();
  toast('已儲存公開收集設定', 'ok');
  refresh();
}

export async function claimForm(preset = null) {
  const state = { photos: [] };
  const r = await modal({
    title: '收支申報', sub: '取代 Google Form：影低單據、揀欄目就交得，等批核自動入帳', wide: true,
    body: `<div class="grid g-2" style="gap:12px">
        <div class="field" style="grid-column:1/-1">
          ${photoPicker('c-photos', { label: '單據相片（手機可以直接影相）', hint: '相片會自動壓縮（最長邊 1400px）。可以影多張：收據正本、單據、付款截圖都得。' })}
        </div>
        <div class="field"><label class="label">類型 <span class="req">*</span></label>
          <select class="select" id="c-type"><option value="expense">支出（我墊支 / 已付）</option><option value="income">收入（代收 / 賣物）</option></select></div>
        <div class="field"><label class="label">金額 <span class="req">*</span></label>
          <input class="input" id="c-amount" type="number" step="0.01" placeholder="0.00"></div>
        <div class="field"><label class="label">日期</label><input class="input" id="c-date" value="${todayISO()}"></div>
        <div class="field"><label class="label">分類</label><select class="select" id="c-cat">
          ${categories('expense').map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field" style="grid-column:1/-1"><label class="label">項目 <span class="req">*</span></label>
          <input class="input" id="c-item" placeholder="例：團購物資運輸費"></div>
        <div class="field"><label class="label">申報人</label>
          <select class="select" id="c-member"><option value="">— 我（${esc(current()?.name || '')}）—</option>
            ${members().map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label class="label">單據</label>
          <label class="check" style="height:38px"><input type="checkbox" id="c-receipt"> 我有收據（會後補交）</label></div>
        <div class="field" style="grid-column:1/-1"><label class="label">備註</label><input class="input" id="c-note"></div>
      </div>
      <div id="c-err" class="err mt-8"></div>
      <div class="hint">送出之後：司庫／領袖喺「收支申報」按「批准並入帳」就會自動加入帳目。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '提交申報', class: 'btn-primary', onClick: el => {
        const amount = Number(el.querySelector('#c-amount').value);
        if (!(amount > 0)) { el.querySelector('#c-err').textContent = '請填金額'; el.querySelector('#c-err').style.display = 'block'; return false; }
        if (!el.querySelector('#c-item').value.trim()) { el.querySelector('#c-err').textContent = '請填項目'; el.querySelector('#c-err').style.display = 'block'; return false; }
        return {
          type: el.querySelector('#c-type').value, amount,
          date: el.querySelector('#c-date').value || todayISO(),
          category: el.querySelector('#c-cat').value,
          item: el.querySelector('#c-item').value.trim(),
          memberId: el.querySelector('#c-member').value,
          receipt: el.querySelector('#c-receipt').checked || state.photos.length > 0,
          photos: state.photos,
          note: el.querySelector('#c-note').value.trim()
        };
      } }],
    onMount: el => bindPhotoPicker(el, 'c-photos', state, { max: 6 })
  });
  if (!r) return;
  /* 相片唔好入 db JSON（v2.3.0 體積治理）：第一時間經後端上 Drive，
     db 入面淨係留連結。以前 dataURL（每張可達 300KB+）會將「資料庫」
     分頁撐爆 9MB，成個同步寫唔入。
     上載唔到（離線／未接後端）→ 照舊本地存（唔會蝕資料），
     遲啲喺「資料管理 → 儲存與備份」撳「清理已入帳嘅相片」可以再瘦身。 */
  let photos = r.photos || [];
  let photosOnDrive = false;
  const cid = uid('c');
  if (photos.length) {
    try {
      const remote = await import('../lib/remote.js');
      if (remote.remoteConfigured?.()) {
        const up = await remote.uploadPhotos(photos, { id: cid });
        if (up?.ok) {
          photos = photos.map((p, i) => ({ name: p.name || '', type: p.type || 'image/jpeg', link: (up.links || [])[i] || '' }));
          photosOnDrive = true;
        }
      }
    } catch { /* 本地存做後備 */ }
  }
  add('claims', {
    id: cid, ...r, photos,
    photosOnDrive,
    byName: r.memberId ? memberName(r.memberId) : (current()?.name || ''),
    status: 'pending', requestedBy: current()?.username || 'super', requestedAt: nowStamp()
  });
  toast(`已提交申報${photos.length ? `（連 ${photos.length} 張單據${photosOnDrive ? '，已存 Drive' : '，暫存本機'}）` : ''}，等批核`, 'ok');
  claimFilter = 'all';
  refresh();
}

async function claimAction(action, id) {
  const c = find('claims', id);
  if (!c) return;
  if (action === 'approve') {
    if (!can('claim.review')) { toast('你冇批核權限', 'err'); return; }
    add('transactions', {
      id: uid('t'), date: c.date, type: c.type, category: c.category || '其他', item: c.item,
      amount: c.amount, method: c.method || '現金', by: c.memberId, byName: c.byName,
      receipt: !!c.receipt, note: (c.note ? c.note + ' · ' : '') + '（由申報批核）',
      createdBy: current()?.username || 'super'
    });
    update('claims', id, { status: 'approved', reviewedBy: current()?.username || 'super', reviewedAt: nowStamp() });
    toast('已批核並自動入帳', 'ok'); refresh();
  }
  if (action === 'reject') {
    const r = await modal({ title: '拒絕申報', body: `<div class="field"><label class="label">原因</label>
      <input class="input" id="q-note" placeholder="例：單據不足"></div>`,
      actions: [{ label: '取消', class: 'btn', value: null }, { label: '確定拒絕', class: 'btn-danger', onClick: el => el.querySelector('#q-note').value }] });
    if (r !== null && r !== undefined) {
      update('claims', id, { status: 'rejected', note: (c.note ? c.note + ' · ' : '') + (r || '已拒絕'), reviewedBy: current()?.username || '', reviewedAt: nowStamp() });
      toast('已拒絕', 'ok'); refresh();
    }
  }
  if (action === 'del') {
    if (await confirmDlg({ title: '刪除申報', danger: true, okText: '確定刪除', message: '確定刪除此申報？' })) {
      remove('claims', id); toast('已刪除', 'ok'); refresh();
    }
  }
}

async function budgetForm(b) {
  const r = await modal({
    title: b ? '編輯活動預算' : '新增活動預算', wide: true,
    body: `<div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">活動名稱 <span class="req">*</span></label>
          <input class="input" id="b-activity" value="${esc(b?.activity || '')}"></div>
        <div class="field"><label class="label">活動日期</label><input class="input" id="b-date" value="${esc(b?.date || '')}"></div>
        <div class="field"><label class="label">預計收入</label><input class="input" id="b-income" type="number" value="${b?.incomePlanned ?? 0}"></div>
        <div class="field"><label class="label">備註</label><input class="input" id="b-note" value="${esc(b?.note || '')}"></div>
      </div>
      <div class="field mt-12"><label class="label">支出項目（每行：名稱, 預算, 實際）</label>
        <textarea class="textarea" id="b-items" style="font-family:var(--mono);font-size:12.5px">${(b?.items || []).map(i => `${i.name}, ${i.planned}, ${i.actual}`).join('\n') || '營地費用, 1800, 0\n交通, 600, 0\n膳食, 1500, 0'}</textarea></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => {
        if (!el.querySelector('#b-activity').value.trim()) return false;
        return {
          activity: el.querySelector('#b-activity').value.trim(),
          date: el.querySelector('#b-date').value,
          incomePlanned: Number(el.querySelector('#b-income').value) || 0,
          note: el.querySelector('#b-note').value.trim(),
          items: el.querySelector('#b-items').value.split('\n').map(l => l.split(',').map(x => x.trim())).filter(a => a[0])
            .map(([name, planned, actual]) => ({ name, planned: Number(planned) || 0, actual: Number(actual) || 0 }))
        };
      } }]
  });
  if (!r) return;
  if (b) update('budgets', b.id, r); else add('budgets', { id: uid('b'), ...r });
  toast('已儲存預算', 'ok'); refresh();
}

function exportFeesWord() {
  const period = feePeriod || feePeriodOf(todayISO());
  const g = feeStats(period);
  const rows = g.rows.map(r => `<tr><td>${esc(r.member.name)}</td>
    <td class="num">${nf(r.amount, 2)}</td>
    <td>${r.paid ? '已收 ' + esc(r.paidDate || '') : (r.due && r.due < todayISO() ? '逾期未收' : '未收')}</td>
    <td>${esc(r.method || '')}</td><td>${esc(r.ref || '')}</td></tr>`).join('');
  toWord({
    filename: `團費收款表_${period}_${stamp()}.doc`, title: `團費收款表 ${period}`, org: profile().name,
    bodyHtml: `<div class="doc-head"><div class="doc-title">團費收款表</div>
      <div class="doc-sub">${esc(profile().name || '')} · ${esc(period)} 年度 · 每人 ${nf(standardFee(period), 2)} 元 · 列印日期 ${esc(todayISO())}</div></div>
      <div class="kpi">
        <div><div class="k">應收</div><div class="v">${nf(g.expected, 2)}</div></div>
        <div><div class="k">已收</div><div class="v">${nf(g.collected, 2)}</div></div>
        <div><div class="k">未收</div><div class="v">${nf(g.outstanding, 2)}</div></div>
        <div><div class="k">已交人數</div><div class="v">${g.paidCount} / ${g.total}</div></div>
      </div>
      <table><thead><tr><th>團員</th><th class="num">金額</th><th>狀態</th><th>方式</th><th>收據 / 單號</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td>合計</td><td class="num">${nf(g.expected, 2)}</td><td colspan="3">已收 ${nf(g.collected, 2)} · 未收 ${nf(g.outstanding, 2)}</td></tr></tfoot></table>`
  });
}

/** 團員團費收據（可列印／存 PDF） */
function feeReceipt(id) {
  const f = find('fees', id);
  if (!f) return;
  const m = member(f.memberId) || {};
  const p = profile();
  printDoc({
    title: `團費收據 ${m.name || ''}`, org: p.name || '',
    bodyHtml: `
      <div class="doc-head"><div class="doc-org">${esc(p.name || '')}</div>
        <div class="doc-title">團費收據</div>
        <div class="doc-sub">Receipt for Membership Fee</div></div>
      <div class="doc-meta"><span>收據編號：${esc(f.ref || f.id)}</span><span>日期：${esc(f.paidDate || todayISO())}</span></div>
      <p>茲收到 <b>${esc(m.name || '')}</b> 繳交 <b>${esc(f.period || '')}</b> 年度團費
        <b>港幣 ${nf(f.amount, 2)} 元正</b>（${esc(f.method || '現金')}）。</p>
      <table><tbody>
        <tr><th style="width:32%">團員</th><td>${esc(m.name || '')}</td></tr>
        <tr><th>期數</th><td>${esc(f.period || '')}</td></tr>
        <tr><th>金額</th><td>港幣 ${nf(f.amount, 2)} 元</td></tr>
        <tr><th>收款日期</th><td>${esc(f.paidDate || '')}</td></tr>
        <tr><th>收付方式</th><td>${esc(f.method || '')}</td></tr>
        <tr><th>經手人</th><td>${esc(f.receivedBy || current()?.name || '')}</td></tr>
      </tbody></table>
      <p class="en-block">Received with thanks. This receipt is issued by the Unit Executive Committee.</p>
      <div style="margin-top:36pt" class="row-between"><div>司庫簽署：____________________</div><div>${esc(p.short || '')}</div></div>`
  });
}

/** 帳目紀錄文件（Word／PDF 共用）—— 期初結餘同收入分開列 */
function ledgerDocBody(sel, { withMethod = true } = {}) {
  const list = sel.list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const inc = sumBy(list, 'income'), exp = sumBy(list, 'expense');
  const head = `<div class="doc-head"><div class="doc-org">${esc(profile().name || '')}</div>
    <div class="doc-title">帳目紀錄</div>
    <div class="doc-sub">${esc(sel.label)} · 列印日期 ${esc(todayISO())}</div></div>`;
  const acc = `<table>
      <tbody>
        ${sel.opening === null || sel.opening === undefined ? '' :
          `<tr class="row-sep"><td><b>上年度結餘（期初，唔計入收入）</b></td><td class="num">${nf(sel.opening, 2)}</td></tr>`}
        <tr><td>收入合計</td><td class="num">${nf(inc, 2)}</td></tr>
        <tr><td>支出合計</td><td class="num">${nf(exp, 2)}</td></tr>
        <tr><td><b>淨額</b>（收入 − 支出）</td><td class="num">${nf(inc - exp, 2)}</td></tr>
        ${sel.opening === null || sel.opening === undefined ? '' :
          `<tr class="row-sep"><td><b>期末結餘</b></td><td class="num">${nf(Number(sel.opening) + inc - exp, 2)}</td></tr>`}
      </tbody></table>`;
  const rows = list.map(t => `<tr><td>${esc(t.date)}</td><td>${esc(t.item)}</td><td>${esc(t.category || '')}</td>
      ${withMethod ? `<td>${esc(t.method || '')}</td><td>${esc(t.byName || (t.by ? memberName(t.by) : ''))}</td>` : ''}
      <td class="num">${t.type === 'income' ? nf(t.amount, 2) : ''}</td>
      <td class="num">${t.type === 'expense' ? nf(t.amount, 2) : ''}</td></tr>`).join('');
  return {
    head, acc, inc, exp, count: list.length,
    body: `${head}${acc}<table>
      <thead><tr><th>日期</th><th>項目</th><th>分類</th>${withMethod ? '<th>方式</th><th>經手人</th>' : ''}<th class="num">收入</th><th class="num">支出</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${withMethod ? 7 : 5}">（此期間冇帳目）</td></tr>`}</tbody>
      <tfoot><tr><td colspan="${withMethod ? 5 : 3}">合計</td><td class="num">${nf(inc, 2)}</td><td class="num">${nf(exp, 2)}</td></tr></tfoot></table>`
  };
}

function exportRangeWord(sel = currentSelection()) {
  const d = ledgerDocBody(sel);
  toWord({
    filename: `帳目_${sel.label.replace(/\s/g, '')}_${stamp()}.doc`, title: '帳目紀錄', org: profile().name,
    bodyHtml: d.body
  });
}
function exportRangePdf(sel = currentSelection()) {
  const d = ledgerDocBody(sel, { withMethod: false });
  printDoc({
    title: '帳目紀錄', org: profile().name,
    bodyHtml: d.body + `<div class="foot"><span>司庫簽署：____________</span><span>${todayISO()}</span></div>`
  });
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
