/* ============================================================
   inventory.js — 物資紀錄 + 借用面版
   • 登記旅團物資（總數量／存放位置／狀態）
   • 團員或執委申請借用 → 任何已登入帳戶都可以批核
   • 批核／借出會自動 −庫存，歸還自動 ＋庫存（數字由紀錄推算，唔會計錯）
   • 可輸出物資清單、借用紀錄、借用單（Word / PDF / CSV / QR）
   ============================================================ */

import { collection, add, update, remove, commit, load, find } from '../lib/store.js';
import {
  invItems, invItem, invLoans, invAudits, invCategories, itemTotals, nextItemCode,
  loanStatus, stockSummary, members, memberName, activeMembers, money, settings, profile
} from '../lib/model.js';
import { todayISO, nowStamp } from '../lib/dates.js';
import { esc, icon, modal, confirmDlg, toast, uid, fmtDate, daysUntil, nf, avatar, copyText } from '../lib/util.js';
import { toCSV, toWord, printDoc, qrSvg, download as dlFile, stamp } from '../lib/exporter.js';
import { go, parse } from '../lib/router.js';
import { can, current, isSuper } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, kv, chipbar, noteBox } from './ui.js';

let tab = 'items';
let loanFilter = 'open';
let kw = '';
let catFilter = 'all';

export function title() { return '物資'; }

const TAB_IDS = ['items', 'loans', 'audits'];

export function render(params) {
  const id = params.id;
  if (id === 'new') return itemEditor(null);
  if (TAB_IDS.includes(id)) { tab = id; return mainView(params); }
  if (!id) {
    tab = TAB_IDS.includes(params.query?.tab) ? params.query.tab : 'items';
    return mainView(params);
  }
  return itemDetail(id);
}

function mainView(params) {
  const st = stockSummary();
  const openNew = params.query?.new === '1';
  return `
  ${pageHead({
    title: '物資紀錄',
    sub: `${st.kinds} 種物資 · 共 ${st.units} 件 · 借出中 ${st.out} 件`,
    actions: `
      ${can('inv.borrow') ? `<button class="btn btn-sm btn-primary" data-act="new-loan">${icon('plus', 15)} 申請借用</button>` : ''}
      ${can('inv.manage') ? `<button class="btn btn-sm" data-act="new-item">${icon('plus', 15)} 新增物資</button>` : ''}
      <button class="btn btn-sm" data-fields="invItems">${icon('table', 15)} 欄位（物資）</button>
      <button class="btn btn-sm" data-fields="invLoans">${icon('table', 15)} 欄位（借用）</button>
      <button class="btn btn-sm" data-go="#/links">${icon('share', 15)} 團員入口 QR（借用已包喺入面）</button>
      <button class="btn btn-sm" data-act="export-word">${icon('download', 15)} 輸出 Word</button>`
  })}

  <div class="grid g-3 mb-16">
    ${stat('物資種類／總數', `${st.kinds} / ${st.units}`, '全部登記物資')}
    ${stat('借出中', String(st.out), `${st.pending} 宗待批核`, st.pending ? 'warn' : '')}
    ${stat('逾期未還', String(st.overdue), st.overdue ? '需要跟進' : '全部準時', st.overdue ? 'danger' : 'ok')}
  </div>

  ${tabs([['items', '物資清單'], ['loans', '借用與批核', invLoans().filter(l => l.status === 'requested').length],
    ['audits', '盤點紀錄']], tab, 'data-tab')}

  ${tab === 'loans' ? loansView() : tab === 'audits' ? auditsView() : itemsView()}`;
}

/* ============================================================
   物資清單
   ============================================================ */
function itemsView() {
  const cats = invCategories();
  let list = invItems();
  if (catFilter !== 'all') list = list.filter(i => i.category === catFilter);
  if (kw) { const k = kw.toLowerCase(); list = list.filter(i => (i.name + ' ' + (i.code || '') + ' ' + (i.location || '')).toLowerCase().includes(k)); }

  return `
  <div class="row-between wrap gap-12 mb-16 no-print">
    ${chipbar([['all', '全部', invItems().length], ...cats.map(c => [c, c, invItems().filter(i => i.category === c).length])], catFilter, 'data-cat')}
    <div class="search-wrap"><span class="ic">${icon('search', 15)}</span>
      <input class="input" id="iSearch" placeholder="搜尋物資／編號／存放位置" value="${esc(kw)}"></div>
  </div>

  <div class="card">
    ${list.length ? `<div class="scroll-x"><table class="table">
      <thead><tr><th>編號</th><th>物資</th><th>分類</th><th class="center">總數</th><th class="center">借出</th>
        <th class="center">可用</th><th class="center">待批</th><th>存放位置</th><th>狀況</th><th></th></tr></thead>
      <tbody>${list.map(i => {
        const t = itemTotals(i.id);
        const low = t.available <= 0;
        return `<tr style="cursor:pointer" data-open="${i.id}">
          <td class="mono sm">${esc(i.code || '')}</td>
          <td><div class="semibold">${esc(i.name)}</div>${i.note ? `<div class="xs faint">${esc(i.note)}</div>` : ''}</td>
          <td><span class="tag">${esc(i.category || '其他')}</span></td>
          <td class="center mono">${t.adjusted}${t.adjusted !== t.total ? ` <span class="faint xs">(${t.total})</span>` : ''} ${esc(i.unit || '')}</td>
          <td class="center mono">${t.out || ''}</td>
          <td class="center mono" style="color:${low ? 'var(--danger)' : 'var(--ok)'};font-weight:700">${t.available}</td>
          <td class="center mono">${t.reserved || ''}</td>
          <td class="sm">${esc(i.location || '—')}</td>
          <td><span class="badge ${i.condition === '良好' || i.condition === '全新' ? 'b-ok' : 'b-warn'}">${esc(i.condition || '—')}</span></td>
          <td class="right">${icon('chevronR', 15)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : empty('grid', '未登記物資', '按「新增物資」開始登記旅團物資')}
  </div>`;
}

function itemDetail(id) {
  const i = invItem(id);
  if (!i) return `<div class="card">${empty('grid', '搵唔到呢件物資')}</div>`;
  const t = itemTotals(id);
  const loans = invLoans().filter(l => l.itemId === id).sort((a, b) => String(b.outDate).localeCompare(String(a.outDate)));
  const audits = invAudits().filter(a => a.itemId === id);
  const open = loans.filter(l => ['approved', 'out'].includes(l.status));

  return `
  ${pageHead({
    title: i.name, sub: `${i.code || ''} · ${i.category || ''} · 存放：${i.location || '—'}`,
    actions: `
      <button class="btn btn-sm" data-act="back">${icon('chevronL', 15)} 返回</button>
      ${can('inv.borrow') ? `<button class="btn btn-sm btn-primary" data-act="new-loan" data-item="${i.id}">${icon('plus', 15)} 申請借用</button>` : ''}
      ${can('inv.audit') ? `<button class="btn btn-sm" data-act="adjust" data-id="${i.id}">${icon('edit', 15)} 盤點調整</button>` : ''}
      ${can('inv.manage') ? `<button class="btn btn-sm" data-act="edit-item" data-id="${i.id}">${icon('edit', 15)} 編輯資料</button>` : ''}`
  })}

  <div class="grid g-4 mb-16">
    ${stat('總數量', `${t.adjusted} ${i.unit || ''}`, t.adjusted !== t.total ? `登記值 ${t.total}（已含盤點調整）` : '')}
    ${stat('借出中', String(t.out), `${open.length} 宗未歸還`)}
    ${stat('可用', String(t.available), t.available < 0 ? '數量異常，請盤點' : '可以借出', t.available <= 0 ? 'danger' : 'ok')}
    ${stat('待批核', String(t.reserved), t.reserved ? '有申請等你批' : '冇待批申請', t.reserved ? 'warn' : '')}
  </div>

  <div class="grid g-2-1">
    <div class="card">
      <div class="card-head"><div class="card-title">借用紀錄</div>
        <div class="card-sub">${loans.length} 宗</div></div>
      <div>${loans.length ? loans.map(l => loanRow(l, true)).join('') : empty('grid', '未有借用紀錄')}</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">物資資料</div></div>
      <div style="padding:16px 18px">
        ${kv([
          ['編號', esc(i.code || '—')],
          ['分類', esc(i.category || '—')],
          ['單位', esc(i.unit || '—')],
          ['存放位置', esc(i.location || '—')],
          ['狀況', esc(i.condition || '—')],
          ['備註', esc(i.note || '—')]
        ])}
        ${audits.length ? `<div class="mt-16"><div class="sm semibold mb-8">盤點調整</div>
          ${audits.map(a => `<div class="row-between sm" style="padding:6px 0;border-bottom:1px solid var(--line-2)">
            <span>${esc(a.date)} · ${esc(a.reason || '')}</span>
            <span class="mono" style="color:${Number(a.delta) < 0 ? 'var(--danger)' : 'var(--ok)'}">${Number(a.delta) > 0 ? '+' : ''}${a.delta}</span>
          </div>`).join('')}</div>` : ''}
        ${can('inv.manage') ? `<button class="btn btn-sm btn-danger btn-block mt-16" data-act="del-item" data-id="${i.id}">${icon('trash', 15)} 刪除此物資</button>` : ''}
      </div>
    </div>
  </div>`;
}

/* ============================================================
   借用與批核
   ============================================================ */
function loansView() {
  const S = loanStatus();
  const all = invLoans();
  const t = todayISO();
  const groups = {
    pending: all.filter(l => l.status === 'requested'),
    open: all.filter(l => ['approved', 'out'].includes(l.status)),
    overdue: all.filter(l => ['approved', 'out'].includes(l.status) && l.dueDate && l.dueDate < t),
    done: all.filter(l => ['returned', 'rejected', 'cancelled'].includes(l.status)),
    all
  };
  const list = (groups[loanFilter] || all).slice().sort((a, b) => String(b.requestedAt || b.outDate).localeCompare(String(a.requestedAt || a.outDate)));

  return `
  <div class="grid g-4 mb-16">
    ${stat('待批核', String(groups.pending.length), '所有登入帳戶都可批核', groups.pending.length ? 'warn' : '')}
    ${stat('借出中', String(groups.open.length), '未歸還')}
    ${stat('逾期未還', String(groups.overdue.length), groups.overdue.length ? '請盡快跟進' : '冇逾期', groups.overdue.length ? 'danger' : 'ok')}
    ${stat('已完成', String(groups.done.length), '已歸還／已拒絕')}
  </div>

  <div class="row-between wrap gap-12 mb-16 no-print">
    ${chipbar([['pending', '待批核', groups.pending.length], ['open', '借出中', groups.open.length],
      ['overdue', '逾期', groups.overdue.length], ['done', '已完成', groups.done.length], ['all', '全部', all.length]], loanFilter, 'data-lf')}
    <div class="row gap-8">
      <button class="btn btn-sm" data-act="export-loans">${icon('download', 15)} 借用紀錄 Word</button>
      <button class="btn btn-sm" data-act="print-blank">${icon('print', 15)} 空白借用單</button>
    </div>
  </div>

  <div class="col gap-12">
    ${list.length ? list.map(l => loanRow(l)).join('') : empty('grid', '冇紀錄', '可以按「申請借用」登記')}
  </div>`;
}

function loanRow(l, compact = false) {
  const S = loanStatus()[l.status] || { l: l.status, c: 'b-grey' };
  const item = invItem(l.itemId);
  const t = todayISO();
  const overdue = ['approved', 'out'].includes(l.status) && l.dueDate && l.dueDate < t;
  const mine = current()?.accountId && (l.requestedByAccountId === current().accountId);
  return `
  <div class="loan-card ${l.status === 'requested' ? 'pending' : overdue ? 'overdue' : ['approved', 'out'].includes(l.status) ? 'out' : 'returned'}">
    <div class="row-between wrap gap-10 mb-8">
      <div class="row gap-10">
        <span class="stat-ic">${icon('grid', 16)}</span>
        <div>
          <div class="semibold">${esc(item?.name || '（物資已刪除）')} <span class="faint sm mono">×${l.qty} ${esc(item?.unit || '')}</span></div>
          <div class="xs faint">${esc(l.borrowerName || memberName(l.borrowerId) || '')}${l.purpose ? ` · ${esc(l.purpose)}` : ''}</div>
        </div>
      </div>
      <div class="row gap-6">
        ${overdue ? '<span class="badge b-danger"><span class="dot"></span>逾期未還</span>' : ''}
        <span class="badge ${S.c}"><span class="dot"></span>${S.l}</span>
      </div>
    </div>

    <div class="row gap-16 wrap xs muted" style="margin-left:46px">
      <span>借出：<b class="mono">${esc(l.outDate || '—')}</b></span>
      <span>應還：<b class="mono" style="color:${overdue ? 'var(--danger)' : 'inherit'}">${esc(l.dueDate || '—')}</b></span>
      ${l.returnDate ? `<span>已還：<b class="mono">${esc(l.returnDate)}</b></span>` : ''}
      ${l.approvedBy ? `<span>批核：${esc(l.approvedBy)}${l.approvedAt ? `（${esc(l.approvedAt)}）` : ''}</span>` : ''}
      ${l.note ? `<span>備註：${esc(l.note)}</span>` : ''}
    </div>

    ${compact ? '' : `<div class="row gap-8 wrap mt-12 no-print" style="margin-left:46px">
      ${l.status === 'requested' && can('inv.approve') ? `
        <button class="btn btn-xs btn-primary" data-loan="approve" data-id="${l.id}">${icon('check', 14)} 批准</button>
        <button class="btn btn-xs" data-loan="reject" data-id="${l.id}">${icon('x', 14)} 拒絕</button>` : ''}
      ${l.status === 'approved' ? `<button class="btn btn-xs btn-primary" data-loan="checkout" data-id="${l.id}">${icon('arrowUp', 14)} 已取走（−庫存）</button>` : ''}
      ${l.status === 'out' ? `<button class="btn btn-xs btn-primary" data-loan="return" data-id="${l.id}">${icon('arrowDown', 14)} 已歸還（＋庫存）</button>` : ''}
      ${['requested', 'approved'].includes(l.status) && (mine || isSuper() || can('inv.manage')) ? `<button class="btn btn-xs" data-loan="cancel" data-id="${l.id}">取消</button>` : ''}
      <button class="btn btn-xs" data-loan="slip" data-id="${l.id}">${icon('print', 14)} 借用單</button>
      ${can('inv.manage') ? `<button class="btn btn-xs btn-danger" data-loan="del" data-id="${l.id}">${icon('trash', 14)}</button>` : ''}
    </div>`}
  </div>`;
}

function auditsView() {
  const audits = invAudits().slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return `
  <div class="grid g-2-1">
    <div class="card">
      <div class="card-head"><div><div class="card-title">盤點紀錄</div>
        <div class="card-sub">盤點調整會直接影響可用數量</div></div>
        ${can('inv.audit') ? `<button class="btn btn-sm" data-act="adjust">${icon('plus', 15)} 新增盤點</button>` : ''}</div>
      <div>${audits.length ? `<div class="scroll-x"><table class="table table-compact">
        <thead><tr><th>日期</th><th>物資</th><th class="center">調整</th><th>原因</th><th>記錄人</th></tr></thead>
        <tbody>${audits.map(a => `<tr>
          <td class="mono sm">${esc(a.date)}</td>
          <td>${esc(invItem(a.itemId)?.name || '—')}</td>
          <td class="center mono" style="color:${Number(a.delta) < 0 ? 'var(--danger)' : 'var(--ok)'};font-weight:700">${Number(a.delta) > 0 ? '+' : ''}${a.delta}</td>
          <td class="sm">${esc(a.reason || '')}</td>
          <td class="sm">${esc(a.by || '')}</td></tr>`).join('')}</tbody>
      </table></div>` : empty('history', '未有盤點紀錄')}</div>
    </div>
    <div class="card">
      <div style="padding:16px 18px">
        ${noteBox('庫存數字係由「物資登記 + 盤點調整 − 未歸還借用」即時計算，所以批核借用會自動 <b>−庫存</b>，歸還會自動 <b>＋庫存</b>，唔會計錯數。')}
        <div class="mt-16 sm muted">小提示：每次活動前後做一次盤點，記錄損耗或遺失，庫存就長期準確。</div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   編輯物資
   ============================================================ */
function itemEditor(id) {
  const i = id ? invItem(id) : null;
  return `
  ${pageHead({ title: i ? `編輯：${i.name}` : '新增物資',
    actions: `<button class="btn btn-sm" data-act="back">${icon('chevronL', 15)} 返回</button>` })}
  <div class="card" style="max-width:720px">
    <div style="padding:20px">
      <div class="grid g-2" style="gap:14px">
        <div class="field"><label class="label">物資名稱 <span class="req">*</span></label>
          <input class="input" id="f-name" value="${esc(i?.name || '')}" placeholder="例：4 人營幕"></div>
        <div class="field"><label class="label">編號</label>
          <input class="input" id="f-code" value="${esc(i?.code || nextItemCode())}"></div>
        <div class="field"><label class="label">分類</label>
          <select class="select" id="f-cat">
            ${invCategories().map(c => `<option ${i?.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select></div>
        <div class="field"><label class="label">總數量 <span class="req">*</span></label>
          <input class="input" id="f-total" type="number" min="0" value="${i?.total ?? 1}"></div>
        <div class="field"><label class="label">單位</label>
          <input class="input" id="f-unit" value="${esc(i?.unit || '個')}" placeholder="個 / 張 / 套"></div>
        <div class="field"><label class="label">存放位置</label>
          <input class="input" id="f-loc" value="${esc(i?.location || '')}" placeholder="例：旅部倉 A 架"></div>
        <div class="field"><label class="label">狀況</label>
          <input class="input" id="f-cond" value="${esc(i?.condition || '良好')}" placeholder="良好 / 一般 / 需維修"></div>
      </div>
      <div class="field mt-16"><label class="label">備註</label>
        <textarea class="textarea" id="f-note">${esc(i?.note || '')}</textarea></div>
      <div id="f-err" class="err mt-8"></div>
      <button class="btn btn-primary mt-16" data-act="save-item" data-id="${id || ''}">${icon('save', 16)} ${i ? '儲存' : '新增物資'}</button>
    </div>
  </div>`;
}

/* ============================================================
   輸出
   ============================================================ */
function exportItemsWord() {
  const rows = invItems().map(i => {
    const t = itemTotals(i.id);
    return `<tr><td>${esc(i.code || '')}</td><td>${esc(i.name)}</td><td>${esc(i.category || '')}</td>
      <td class="num">${t.adjusted}</td><td class="num">${t.out}</td><td class="num">${t.available}</td>
      <td>${esc(i.location || '')}</td><td>${esc(i.condition || '')}</td></tr>`;
  }).join('');
  toWord({
    filename: `物資清單_${stamp()}.doc`, title: '旅團物資清單', org: profile().name,
    bodyHtml: `<div class="doc-head"><div class="doc-title">物資清單</div>
      <div class="doc-sub">${esc(profile().name || '')} · 共 ${invItems().length} 種 · ${todayISO()}</div></div>
      <table><thead><tr><th>編號</th><th>物資</th><th>分類</th><th class="num">總數</th><th class="num">借出</th>
        <th class="num">可用</th><th>存放</th><th>狀況</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">可用數量 = 總數量（含盤點調整）− 未歸還借用。</p>`
  });
}

function exportLoansWord() {
  const rows = invLoans().slice().sort((a, b) => String(b.outDate).localeCompare(String(a.outDate))).map(l => `<tr>
    <td>${esc(invItem(l.itemId)?.name || '')}</td><td class="num">${l.qty}</td>
    <td>${esc(l.borrowerName || memberName(l.borrowerId) || '')}</td><td>${esc(l.purpose || '')}</td>
    <td>${esc(l.outDate || '')}</td><td>${esc(l.dueDate || '')}</td><td>${esc(l.returnDate || '')}</td>
    <td>${esc((loanStatus()[l.status] || {}).l || l.status)}</td><td>${esc(l.approvedBy || '')}</td></tr>`).join('');
  toWord({
    filename: `物資借用紀錄_${stamp()}.doc`, title: '物資借用紀錄', org: profile().name,
    bodyHtml: `<div class="doc-head"><div class="doc-title">物資借用紀錄</div>
      <div class="doc-sub">${esc(profile().name || '')} · 列印日期 ${todayISO()}</div></div>
      <table><thead><tr><th>物資</th><th class="num">數量</th><th>借用人</th><th>用途</th>
        <th>借出日</th><th>應還日</th><th>歸還日</th><th>狀態</th><th>批核人</th></tr></thead><tbody>${rows}</tbody></table>`
  });
}

/** 借用單（可以印出嚟簽名） */
function loanSlip(loan) {
  const item = invItem(loan.itemId);
  const borrowUrl = location.href.split('#')[0] + '#/inventory/loans?new=1';
  const html = `
  <div class="doc-head"><div class="doc-title">物資借用單</div>
    <div class="doc-sub">${esc(profile().name || '')} · 單號 ${esc(loan.id)}</div></div>
  <table>
    <tr><th style="width:110pt">借用人</th><td>${esc(loan.borrowerName || memberName(loan.borrowerId) || '')}</td>
        <th style="width:110pt">聯絡</th><td>${esc(member(loan.borrowerId)?.phone || '')}</td></tr>
    <tr><th>物資</th><td>${esc(item?.name || '')}（${esc(item?.code || '')}）</td><th>數量</th><td>${loan.qty} ${esc(item?.unit || '')}</td></tr>
    <tr><th>借出日期</th><td>${esc(loan.outDate || '')}</td><th>應還日期</th><td>${esc(loan.dueDate || '')}</td></tr>
    <tr><th>用途</th><td colspan="3">${esc(loan.purpose || '')}</td></tr>
    <tr><th>備註</th><td colspan="3">${esc(loan.note || '')}</td></tr>
  </table>
  <table>
    <tr><th>借用人簽署</th><td style="height:52pt"></td><th>批核人簽署</th><td style="height:52pt">${esc(loan.approvedBy || '')}</td></tr>
    <tr><th>歸還日期</th><td>${esc(loan.returnDate || '')}</td><th>接收人</th><td>${esc(loan.receivedBy || '')}</td></tr>
  </table>
  <p class="note">借用規則：請於應還日期或之前歸還，如有損壞或遺失請即時通知執委會。可用數量會於批核時自動 −1，歸還時自動 +1。</p>
  <div style="text-align:center;margin-top:10pt">${qrSvg(location.href.split('#')[0] + '#/inventory/loans', 4, 2)}</div>`;
  printDoc({ title: `借用單 ${loan.id}`, org: profile().name, bodyHtml: html });
}

function printBlankSlip() {
  const borrowUrl = location.href.split('#')[0] + '#/inventory/loans?new=1';
  const html = `
  <div class="doc-head"><div class="doc-title">物資借用單（空白）</div>
    <div class="doc-sub">${esc(profile().name || '')}</div></div>
  <table>
    <tr><th style="width:110pt">借用人</th><td></td><th style="width:110pt">聯絡</th><td></td></tr>
    <tr><th>物資及數量</th><td colspan="3" style="height:70pt"></td></tr>
    <tr><th>借出日期</th><td></td><th>應還日期</th><td></td></tr>
    <tr><th>用途</th><td colspan="3"></td></tr>
  </table>
  <table>
    <tr><th>借用人簽署</th><td style="height:52pt"></td><th>批核人簽署</th><td style="height:52pt"></td></tr>
    <tr><th>歸還日期</th><td></td><th>接收人</th><td></td></tr>
  </table>
  <p class="note">線上申請：掃描 QR Code 直接開借用面版（需登入帳戶），批核後庫存自動更新。</p>
  <div style="text-align:center;margin-top:10pt">${qrSvg(borrowUrl, 4, 2)}</div>`;
  printDoc({ title: '空白借用單', org: profile().name, bodyHtml: html });
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  /* 分頁掣由 main.js 統一綁（ui.js tabs() → [data-tabnav]），呢度唔使再綁 */
  root.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { catFilter = b.dataset.cat; refresh(); }));
  root.querySelectorAll('[data-lf]').forEach(b => b.addEventListener('click', () => { loanFilter = b.dataset.lf; refresh(); }));
  const s = root.querySelector('#iSearch');
  if (s) s.addEventListener('input', () => { kw = s.value; clearTimeout(s._t); s._t = setTimeout(refresh, 220); });
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => go('#/inventory/' + el.dataset.open)));

  root.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', async () => {
    const act = el.dataset.act;
    const id = el.dataset.id;

    if (act === 'back') return go('#/inventory');
    if (act === 'new-item' || act === 'edit-item') return go('#/inventory/' + (id || 'new'));
    if (act === 'export-word') { exportItemsWord(); toast('已輸出物資清單（Word）', 'ok'); }
    if (act === 'export-loans') { exportLoansWord(); toast('已輸出借用紀錄（Word）', 'ok'); }
    if (act === 'print-blank') { printBlankSlip(); }

    if (act === 'save-item') {
      const v = k => root.querySelector(k)?.value.trim() || '';
      const total = Number(v('#f-total'));
      if (!v('#f-name')) { toast('請填物資名稱', 'err'); return; }
      if (!(total >= 0)) { toast('總數量要係 0 或以上', 'err'); return; }
      const patch = {
        name: v('#f-name'), code: v('#f-code'), category: root.querySelector('#f-cat').value,
        total, unit: v('#f-unit'), location: v('#f-loc'), condition: v('#f-cond'), note: v('#f-note')
      };
      if (id) { update('invItems', id, patch); toast('已更新物資', 'ok'); }
      else { add('invItems', { id: uid('gi'), ...patch }); toast('已新增物資', 'ok'); }
      go('#/inventory');
    }

    if (act === 'del-item') {
      const i = invItem(id);
      if (invLoans().some(l => l.itemId === id && ['approved', 'out', 'requested'].includes(l.status))) {
        toast('呢件物資仍有未完成嘅借用紀錄，唔可以刪除', 'err'); return;
      }
      if (await confirmDlg({ title: '刪除物資', danger: true, okText: '確定刪除', message: `確定刪除 <b>${esc(i?.name || '')}</b>？` })) {
        remove('invItems', id); toast('已刪除', 'ok'); go('#/inventory');
      }
    }

    if (act === 'adjust') {
      const item = id ? invItem(id) : null;
      const r = await modal({
        title: '盤點調整', sub: item ? item.name : '選擇物資',
        body: `
          <div class="field"><label class="label">物資 <span class="req">*</span></label>
            <select class="select" id="q-item" ${item ? 'disabled' : ''}>
              ${invItems().map(i => `<option value="${i.id}" ${item?.id === i.id ? 'selected' : ''}>${esc(i.code || '')} ${esc(i.name)}（可用 ${itemTotals(i.id).available}）</option>`).join('')}
            </select></div>
          <div class="field mt-12"><label class="label">調整數量（加減） <span class="req">*</span></label>
            <input class="input" id="q-delta" type="number" value="-1" placeholder="例：-1 報廢、+2 新購">
            <div class="hint">負數＝減少（損耗／遺失），正數＝增加（新購／找回）。</div></div>
          <div class="field mt-12"><label class="label">原因 <span class="req">*</span></label>
            <input class="input" id="q-reason" placeholder="例：盤點發現電池損壞報廢"></div>
          <div id="q-err" class="err mt-8"></div>`,
        actions: [{ label: '取消', class: 'btn', value: null },
          { label: '儲存', class: 'btn-primary', onClick: el => {
            const itemId = el.querySelector('#q-item').value;
            const delta = Number(el.querySelector('#q-delta').value);
            const reason = el.querySelector('#q-reason').value.trim();
            if (!delta) { el.querySelector('#q-err').textContent = '請填調整數量（唔可以係 0）'; el.querySelector('#q-err').style.display = 'block'; return false; }
            if (!reason) { el.querySelector('#q-err').textContent = '請填原因'; el.querySelector('#q-err').style.display = 'block'; return false; }
            return { itemId, delta, reason };
          } }]
      });
      if (r) {
        add('invAudits', { id: uid('au'), date: todayISO(), itemId: r.itemId, delta: r.delta, reason: r.reason, by: current()?.username || 'super', at: nowStamp() });
        toast('已記錄盤點調整', 'ok'); refresh();
      }
    }

    if (act === 'new-loan') {
      openLoanForm(root, el.dataset.item || null);
    }
  }));

  root.querySelectorAll('[data-loan]').forEach(b => b.addEventListener('click', async () => {
    const loan = find('invLoans', b.dataset.id);
    if (!loan) return;
    const action = b.dataset.loan;
    const item = invItem(loan.itemId);

    if (action === 'approve') {
      if (!can('inv.approve')) { toast('你冇批核權限', 'err'); return; }
      const t = itemTotals(loan.itemId);
      if (t.available < Number(loan.qty)) {
        if (!(await confirmDlg({ title: '庫存不足', danger: true, okText: '仍然批准',
          message: `現時可用只有 <b>${t.available}</b>，申請數量係 <b>${loan.qty}</b>。仍然批准？（庫存會變負數）` }))) return;
      }
      update('invLoans', loan.id, { status: 'approved', approvedBy: current()?.username || 'super', approvedAt: nowStamp() });
      toast(`已批准：${item?.name} ×${loan.qty}，庫存 −${loan.qty}（待取走）`, 'ok'); refresh();
    }
    if (action === 'reject') {
      const r = await modal({ title: '拒絕借用', body: `<div class="field"><label class="label">原因（可選）</label>
        <input class="input" id="q-note" placeholder="例：物資已有其他小隊預留"></div>`,
        actions: [{ label: '取消', class: 'btn', value: null }, { label: '確定拒絕', class: 'btn-danger', onClick: el => el.querySelector('#q-note').value }] });
      if (r !== null && r !== undefined) {
        update('invLoans', loan.id, { status: 'rejected', approvedBy: current()?.username || '', approvedAt: nowStamp(), note: r || loan.note });
        toast('已拒絕申請', 'ok'); refresh();
      }
    }
    if (action === 'checkout') {
      update('invLoans', loan.id, { status: 'out' });
      toast(`已取走：${item?.name || '物資'} ×${loan.qty}（庫存已於批准時扣除）`, 'ok'); refresh();
    }
    if (action === 'return') {
      update('invLoans', loan.id, { status: 'returned', returnDate: todayISO(), receivedBy: current()?.username || '' });
      toast(`已歸還：${item?.name || '物資'} ×${loan.qty}，庫存回復 +${loan.qty}`, 'ok'); refresh();
    }
    if (action === 'cancel') {
      if (await confirmDlg({ title: '取消借用', okText: '確定取消', message: '確定取消呢宗借用申請？' })) {
        update('invLoans', loan.id, { status: 'cancelled' }); toast('已取消', 'ok'); refresh();
      }
    }
    if (action === 'slip') loanSlip(loan);
    if (action === 'del') {
      if (await confirmDlg({ title: '刪除紀錄', danger: true, okText: '確定刪除', message: '刪除後庫存會相應回復。' })) {
        remove('invLoans', loan.id); toast('已刪除', 'ok'); refresh();
      }
    }
  }));
}

/* ---------- 借用申請表（彈窗） ---------- */
function openLoanForm(root, presetItem) {
  const items = invItems().filter(i => itemTotals(i.id).available > 0 || i.id === presetItem);
  if (!items.length) { toast('暫時冇可借用嘅物資', 'err'); return; }
  const list = activeMembers();
  modal({
    title: '申請借用物資',
    sub: '批核後會自動 −庫存；歸還時自動 +庫存',
    wide: true,
    body: `
      <div class="grid g-2" style="gap:14px">
        <div class="field"><label class="label">物資 <span class="req">*</span></label>
          <select class="select" id="l-item">
            ${items.map(i => { const t = itemTotals(i.id); return `<option value="${i.id}" ${presetItem === i.id ? 'selected' : ''}>${esc(i.name)}（可用 ${t.available} ${esc(i.unit || '')}）</option>`; }).join('')}
          </select></div>
        <div class="field"><label class="label">數量 <span class="req">*</span></label>
          <input class="input" id="l-qty" type="number" min="1" value="1"></div>
        <div class="field"><label class="label">借用人</label>
          <select class="select" id="l-member">
            <option value="">— 我（${esc(current()?.name || '')}）—</option>
            ${list.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label class="label">或輸入名字（非團員）</label>
          <input class="input" id="l-name" placeholder="例：旅部職員"></div>
        <div class="field"><label class="label">借出日期</label>
          <input class="input" id="l-out" value="${todayISO()}"></div>
        <div class="field"><label class="label">應還日期</label>
          <input class="input" id="l-due" value="${addDaysISO(todayISO(), Number(settings().inventory?.loanDays || 14))}"></div>
      </div>
      <div class="field mt-12"><label class="label">用途</label>
        <input class="input" id="l-purpose" placeholder="例：10 月秋季露營（小隊 A）"></div>
      <div class="field mt-12"><label class="label">備註</label>
        <input class="input" id="l-note" placeholder="可選"></div>
      <div id="l-err" class="err mt-8"></div>
      <div class="hint mt-8">批核權：任何已登入嘅領袖或執委都可以批核。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '提交申請', class: 'btn-primary', onClick: el => {
        const itemId = el.querySelector('#l-item').value;
        const qty = Number(el.querySelector('#l-qty').value);
        if (!(qty > 0)) { el.querySelector('#l-err').textContent = '數量要係 1 或以上'; el.querySelector('#l-err').style.display = 'block'; return false; }
        return {
          itemId, qty,
          memberId: el.querySelector('#l-member').value,
          freeName: el.querySelector('#l-name').value.trim(),
          outDate: el.querySelector('#l-out').value,
          dueDate: el.querySelector('#l-due').value,
          purpose: el.querySelector('#l-purpose').value.trim(),
          note: el.querySelector('#l-note').value.trim()
        };
      } }],
    onMount: el => {
      const upd = () => {
        const i = invItem(el.querySelector('#l-item').value);
        el.querySelector('#l-qty').max = itemTotals(i?.id).available;
      };
      el.querySelector('#l-item').addEventListener('change', upd); upd();
    }
  }).then(r => {
    if (!r) return;
    const m = r.memberId ? find('members', r.memberId) : null;
    const rec = add('invLoans', {
      id: uid('ln'), itemId: r.itemId, qty: r.qty,
      borrowerId: r.memberId, borrowerName: r.freeName || m?.name || current()?.name || '',
      purpose: r.purpose, outDate: r.outDate, dueDate: r.dueDate, returnDate: '',
      status: 'requested', requestedBy: current()?.username || 'super', requestedByAccountId: current()?.accountId || 'super',
      requestedAt: nowStamp(), approvedBy: '', note: r.note
    });
    toast('已提交借用申請，等批核', 'ok');
    go('#/inventory/loans');
  });
}

function addDaysISO(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
