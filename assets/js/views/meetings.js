/* ============================================================
   meetings.js — 會議管理
   ============================================================ */

import { collection, find, add, update, remove, commit, load } from '../lib/store.js';
import {
  MEETING_STATUS, MEETING_TYPES, ATTEND, statusBadge, statusLabel,
  members, memberName, member
} from '../lib/model.js';
import {
  esc, icon, money, fmtDate, weekday, relDay, avatar, uid, todayISO, nowStamp,
  modal, confirmDlg, toast, download
} from '../lib/util.js';
import { go, setQuery } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { noteBox } from './ui.js';

let viewMode = 'list';
let filterStatus = 'all';
let keyword = '';

/* ---------- 出席點名草稿（2026-09-18 團長回報改） ----------
   以前撳一下出席掣就即刻寫入（自動同步後端），成頁重繪又彈返上去頂。
   而家：撳掣只記 draft（局部重繪、唔跳位），撳「確定出席」先一次過寫入。 */
let attDraft = null;         // { [memberId]: 'present'|'late'|'apology'|'absent'|'' }
let attDraftFor = '';        // draft 屬於邊個會議

function attEff(m, mid) {
  if (attDraftFor === m.id && attDraft && attDraft[mid] !== undefined) return attDraft[mid];
  return (m.attendance || {})[mid] || '';
}
function attDirty(m) {
  return attDraftFor === m.id && !!attDraft && Object.keys(attDraft).length > 0;
}

export function title() { return '會議'; }

/* ============================================================
   LIST
   ============================================================ */
export function render(params) {
  if (params.id === 'new') return editor(null);
  if (params.id) return detail(params.id, params.query);

  const all = collection('meetings');
  const counts = {
    all: all.length,
    pending: all.filter(m => m.status === 'pending').length,
    confirmed: all.filter(m => m.status === 'confirmed').length,
    done: all.filter(m => m.status === 'done').length,
    draft: all.filter(m => m.status === 'draft').length
  };
  const list = filter(all);

  return `
  <div class="page-head">
    <div>
      <div class="page-title">會議</div>
      <div class="page-sub">議程、出席、記錄、決議，一條龍跟進</div>
    </div>
    <div class="row gap-8 wrap no-print">
      <div class="seg" role="tablist">
        <button role="tab" aria-selected="${viewMode === 'list'}" data-mode="list">清單</button>
        <button role="tab" aria-selected="${viewMode === 'cal'}" data-mode="cal">行事曆</button>
        <button role="tab" aria-selected="${viewMode === 'board'}" data-mode="board">看板</button>
      </div>
      <button class="btn" data-fields="meetings">${icon('table', 15)} 欄位</button>
      ${can('meeting.create') ? `<button class="btn btn-primary" data-act="new">${icon('plus', 16)} 新增會議</button>` : ''}
    </div>
  </div>

  <div class="row-between mb-16 wrap gap-12 no-print">
    <div class="chipbar">
      ${[['all', '全部'], ['pending', '待處理'], ['confirmed', '已確定'], ['done', '已完成'], ['draft', '草稿']]
        .map(([k, l]) => `<button class="chip" aria-pressed="${filterStatus === k}" data-filter="${k}">${l} <span class="faint">${counts[k] || 0}</span></button>`).join('')}
    </div>
    <div style="position:relative;min-width:190px">
      <input class="input" id="mtSearch" placeholder="搜尋會議…" value="${esc(keyword)}" style="padding-left:32px">
      <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--faint);pointer-events:none;display:flex">${icon('search', 15)}</span>
    </div>
  </div>

  ${viewMode === 'board' ? board(list) : viewMode === 'cal' ? calView(all) : listView(list)}`;
}

function filter(all) {
  let l = all;
  if (filterStatus !== 'all') l = l.filter(m => m.status === filterStatus);
  if (keyword) {
    const k = keyword.toLowerCase();
    l = l.filter(m => (m.title + ' ' + (m.venue || '') + ' ' + (MEETING_TYPES[m.type] || '')).toLowerCase().includes(k));
  }
  return l.sort((a, b) => {
    const rank = { pending: 0, confirmed: 1, draft: 2, done: 3, cancelled: 4 };
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return String(b.date).localeCompare(String(a.date));
  });
}

function listView(list) {
  if (!list.length) return emptyState();
  return `<div class="card"><div class="table-scroll scroll-x">
    <table class="table">
      <thead><tr>
        <th>會議</th><th>類型</th><th>日期</th><th>時間</th><th>地點</th>
        <th>主席</th><th class="center">議程</th><th class="center">決議</th><th>狀態</th><th></th>
      </tr></thead>
      <tbody>${list.map(m => `
        <tr style="cursor:pointer" data-open="${m.id}">
          <td><div class="semibold">${esc(m.title)}</div>
              <div class="xs faint">${esc(relDay(m.date))}</div></td>
          <td><span class="badge b-grey">${esc(MEETING_TYPES[m.type] || '其他')}</span></td>
          <td class="mono nowrap">${esc(m.date)} <span class="xs faint">${esc(weekday(m.date))}</span></td>
          <td class="mono">${esc(m.time)}</td>
          <td class="muted truncate" style="max-width:140px">${esc(m.venue || '—')}</td>
          <td>${esc(memberName(m.chair))}</td>
          <td class="center mono">${(m.agenda || []).length}</td>
          <td class="center mono">${(m.decisions || []).length}</td>
          <td>${statusBadge(m.status)}</td>
          <td class="right nowrap">
            <button class="btn btn-xs btn-ghost" data-open="${m.id}">${icon('chevronR', 15)}</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div></div>`;
}

function board(list) {
  const cols = [
    ['draft', '草稿'], ['pending', '待處理'], ['confirmed', '已確定'], ['done', '已完成']
  ];
  return `<div class="kanban">${cols.map(([k, label]) => {
    const items = list.filter(m => m.status === k);
    return `<div class="kcol">
      <div class="kcol-head"><span>${label}</span><span class="badge b-grey">${items.length}</span></div>
      ${items.map(m => `
        <div class="kcard" data-open="${m.id}">
          <div class="semibold sm" style="line-height:1.4">${esc(m.title)}</div>
          <div class="xs faint mt-4">${esc(m.date)} ${esc(m.time)} · ${esc(m.venue || '地點待定')}</div>
          <div class="row gap-6 mt-8 wrap">
            <span class="badge b-grey">${esc(MEETING_TYPES[m.type] || '其他')}</span>
            ${(m.decisions || []).length ? `<span class="badge b-warn">${(m.decisions || []).filter(d => !d.done).length} 待辦</span>` : ''}
          </div>
        </div>`).join('') || `<div class="xs faint center" style="padding:14px 4px">—</div>`}
    </div>`;
  }).join('')}</div>`;
}

let calCursor = todayISO().slice(0, 7);

function calView(all) {
  const [yy, mm] = calCursor.split('-').map(Number);
  const first = new Date(yy, mm - 1, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0
  const days = new Date(yy, mm, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const byDay = {};
  all.forEach(m => {
    const ds = String(m.date || '').slice(0, 10);
    if (!ds.startsWith(calCursor)) return;
    const d = Number(ds.slice(8, 10));
    (byDay[d] = byDay[d] || []).push(m);
  });
  const prev = () => {
    const d = new Date(yy, mm - 2, 1);
    calCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const next = () => {
    const d = new Date(yy, mm, 1);
    calCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  void prev; void next;
  return `
  <div class="card">
    <div class="card-head">
      <div class="row gap-8">
        <button class="btn btn-sm" data-cal="prev">${icon('chevronL', 14)}</button>
        <div class="card-title">${yy} 年 ${mm} 月</div>
        <button class="btn btn-sm" data-cal="next">${icon('chevronR', 14)}</button>
      </div>
      <button class="btn btn-sm btn-primary" data-act="new">${icon('plus', 14)} 新活動／會議</button>
    </div>
    <div class="cal-grid">
      ${['一','二','三','四','五','六','日'].map(w => `<div class="cal-dow">${w}</div>`).join('')}
      ${cells.map(d => {
        if (!d) return '<div class="cal-cell empty"></div>';
        const iso = `${calCursor}-${String(d).padStart(2, '0')}`;
        const items = byDay[d] || [];
        return `<div class="cal-cell" data-calday="${iso}">
          <div class="cal-n">${d}</div>
          ${items.map(m => `<button class="cal-ev" data-open="${m.id}">${esc((m.title || '').slice(0, 16))}</button>`).join('')}
        </div>`;
      }).join('')}
    </div>
    <div class="hint" style="padding:10px 14px">撳日子可以新增活動（用嚟點名）；撳活動名入去出席表。</div>
  </div>`;
}

function emptyState() {
  return `<div class="card"><div class="empty">${icon('calendar', 36)}
    <div class="empty-title">冇符合條件嘅會議</div>
    <div class="sm mt-4">試下轉其他篩選，或者新增一個會議。</div>
    ${can('meeting.create') ? `<button class="btn btn-primary mt-16" data-act="new">${icon('plus', 16)} 新增會議</button>` : ''}
  </div></div>`;
}

/* ============================================================
   DETAIL
   ============================================================ */
let tab = 'agenda';

function detail(id, query) {
  const m = find('meetings', id);
  if (!m) return `<div class="card"><div class="empty">${icon('alert', 34)}<div class="empty-title">搵唔到呢個會議</div></div></div>`;
  /* 開另一個會議：丟埋上一個嘅未確定出席草稿（唔會帶過去第二個會議） */
  if (attDraftFor && attDraftFor !== m.id) { attDraft = null; attDraftFor = ''; }
  tab = query.tab || 'agenda';

  const att = m.attendance || {};
  const roster = members().filter(x => x.status !== 'alumni');
  const presentN = roster.filter(x => att[x.id] === 'present' || att[x.id] === 'late').length;
  const openN = (m.decisions || []).filter(d => !d.done).length;

  return `
  <div class="no-print mb-12">
    <button class="btn btn-ghost btn-sm" data-go="#/meetings">${icon('chevronL', 15)} 返回會議列表</button>
  </div>

  <div class="page-head">
    <div class="grow">
      <div class="row gap-8 wrap mb-8">
        ${statusBadge(m.status)}
        <span class="badge b-grey">${esc(MEETING_TYPES[m.type] || '其他')}</span>
        ${openN ? `<span class="badge b-warn">${openN} 項待辦</span>` : ''}
      </div>
      <div class="page-title">${esc(m.title)}</div>
      <div class="page-sub mt-8 row gap-16 wrap">
        <span class="row gap-6">${icon('calendar', 15)} ${esc(m.date)} ${esc(weekday(m.date))} ${esc(m.time)} · ${esc(relDay(m.date))}</span>
        <span class="row gap-6">${icon('target', 15)} ${esc(m.venue || '地點待定')}</span>
        <span class="row gap-6">${icon('user', 15)} 主席 ${esc(memberName(m.chair))} · 秘書 ${esc(memberName(m.secretary))}</span>
      </div>
    </div>
    <div class="row gap-8 wrap no-print">
      <select class="select" id="mtStatus" style="width:auto">
        ${Object.entries(MEETING_STATUS).map(([k, v]) =>
          `<option value="${k}" ${m.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <button class="btn" data-act="print">${icon('print', 16)} 列印</button>
      ${can('meeting.edit', m) ? `<button class="btn" data-act="edit">${icon('edit', 16)} 編輯</button>` : ''}
      ${can('meeting.delete', m) ? `<button class="btn btn-danger" data-act="del">${icon('trash', 16)}</button>` : ''}
    </div>
  </div>

  <div class="seg mb-16 no-print" role="tablist">
    ${[['agenda', '議程'], ['attend', `出席 ${presentN}/${roster.length}`], ['minutes', '會議記錄'],
       ['decisions', `決議 / 行動 ${(m.decisions || []).length}`], ['files', `附件 ${(m.attachments || []).length}`]]
      .map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join('')}
  </div>

  <div id="mtPane">${pane(m, tab)}</div>`;
}

function pane(m, t) {
  if (t === 'agenda') return agendaPane(m);
  if (t === 'attend') return attendPane(m);
  if (t === 'minutes') return minutesPane(m);
  if (t === 'decisions') return decisionPane(m);
  return filesPane(m);
}

/* ---------- 議程 ---------- */
function agendaPane(m) {
  const total = (m.agenda || []).reduce((s, a) => s + (Number(a.minutes) || 0), 0);
  return `<div class="card">
    <div class="card-head">
      <div><div class="card-title">議程</div>
        <div class="card-sub">${(m.agenda || []).length} 項 · 預計 ${total} 分鐘</div></div>
      ${can('meeting.edit', m) ? `<button class="btn btn-sm btn-primary" data-act="add-agenda">${icon('plus', 15)} 加入議程</button>` : ''}
    </div>
    ${(m.agenda || []).length ? `<div class="table-scroll scroll-x"><table class="table">
      <thead><tr><th style="width:44px" class="center">#</th><th>議程項目</th><th class="right" style="width:110px">時間</th>${can('meeting.edit', m) ? '<th style="width:70px"></th>' : ''}</tr></thead>
      <tbody>${(m.agenda || []).map((a, i) => `
        <tr>
          <td class="center mono faint">${i + 1}</td>
          <td>${esc(a.text)}</td>
          <td class="right mono muted">${a.minutes || 0} 分</td>
          ${can('meeting.edit', m) ? `<td class="right nowrap">
            <button class="btn btn-xs btn-ghost" data-act="edit-agenda" data-id="${a.id}">${icon('edit', 14)}</button>
            <button class="btn btn-xs btn-ghost" data-act="del-agenda" data-id="${a.id}">${icon('trash', 14)}</button>
          </td>` : ''}
        </tr>`).join('')}</tbody>
    </table></div>` : `<div class="empty">${icon('note', 32)}<div class="empty-title">仲未有任何議程</div></div>`}
  </div>`;
}

/* ---------- 出席 ---------- */
function attendPane(m) {
  return `<div id="attPane">${attendInner(m)}</div>`;
}

function attendInner(m) {
  const roster = members().filter(x => x.status !== 'alumni');
  const n = k => roster.filter(x => attEff(m, x.id) === k).length;
  const editable = can('meeting.minutes') && m.status !== 'cancelled';
  const dirty = editable && attDirty(m);
  const nChanges = dirty ? Object.keys(attDraft).length : 0;
  const marked = roster.filter(x => attEff(m, x.id)).length;
  return `<div class="card">
    <div class="card-head">
      <div><div class="card-title">出席點名</div>
        <div class="card-sub">已點 ${marked}/${roster.length} · 出席 ${n('present')} · 遲到 ${n('late')} · 請假 ${n('apology')} · 缺席 ${n('absent')}${dirty ? ` · <b style="color:var(--warn)">有 ${nChanges} 個改動未確定</b>` : ''}</div></div>
      <div class="row gap-6 no-print">
        ${editable ? `<button class="btn btn-xs" data-attact="all">全部出席</button>
        <button class="btn btn-xs" data-attact="discard" ${dirty ? '' : 'disabled'}>放棄改動</button>
        <button class="btn btn-xs btn-primary" data-attact="commit" ${dirty ? '' : 'disabled'}>${icon('check', 13)} 確定出席${dirty ? `（${nChanges}）` : ''}</button>` : ''}
      </div>
    </div>
    ${editable ? noteBox(dirty
      ? `有 ${nChanges} 個改動<b>仲未儲存</b> —— 撳右上「確定出席」先會一次過寫入後端。`
      : '撳掣點名<b>唔會即刻寫入後端</b>；點晒名先撳右上「確定出席」，一次過儲存。再撳同一格可以還原。', dirty ? 'warn' : 'brand') : ''}
    <div class="table-scroll scroll-x"><table class="table">
      <thead><tr><th>團員</th><th>職位</th><th class="center">出席</th><th class="center">遲到</th><th class="center">請假</th><th class="center">缺席</th><th class="center">清除</th></tr></thead>
      <tbody>${roster.map(mb => {
        const v = attEff(m, mb.id);
        return `
        <tr>
          <td><div class="row gap-8">${avatar(mb.name, 'avatar-sm')}<div><div class="semibold sm">${esc(mb.name)}</div>
            <div class="xs faint">${esc(mb.role)}</div></div></div></td>
          <td class="xs muted">${esc(mb.role)}</td>
          ${['present', 'late', 'apology', 'absent'].map(k => `
            <td class="center"><button class="btn btn-xs ${v === k ? (k === 'present' ? 'btn-soft' : 'btn') : 'btn-ghost'}"
              data-att="${mb.id}" data-val="${k}" ${editable ? '' : 'disabled'}>
              ${v === k ? icon('check', 14) : ''}${ATTEND[k].label}</button></td>`).join('')}
          <td class="center"><button class="btn btn-xs btn-ghost" data-att="${mb.id}" data-val="" ${editable ? '' : 'disabled'}>${icon('x', 14)}</button></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table></div>
  </div>`;
}

/** 只重繪出席嗰嚿 —— 唔會成頁重繪、唔會彈返上去頂 */
function paintAttPane(root, m) {
  const host = root.querySelector('#mtPane');
  if (!host || !m) return;
  if (!host.querySelector('#attPane')) return;
  host.innerHTML = attendPane(m);
  bindAttendPane(root, m);
}

function bindAttendPane(root, m) {
  const pane = root.querySelector('#attPane');
  if (!pane || !m) return;
  const editable = can('meeting.minutes') && m.status !== 'cancelled';
  pane.querySelectorAll('[data-att]').forEach(btn => btn.addEventListener('click', () => {
    if (!editable) return;
    if (attDraftFor !== m.id || !attDraft) { attDraft = {}; attDraftFor = m.id; }
    const mid = btn.dataset.att, v = btn.dataset.val;
    if (v === '') {
      /* 清除：本身有紀錄 → 確定時刪走；本身冇 → 撤返 draft */
      if ((m.attendance || {})[mid]) attDraft[mid] = '';
      else delete attDraft[mid];
    } else if (attEff(m, mid) === v) delete attDraft[mid];   // 再撳同一格＝還原
    else attDraft[mid] = v;
    paintAttPane(root, m);
  }));
  pane.querySelectorAll('[data-attact]').forEach(b => b.addEventListener('click', () => {
    if (!editable) return;
    const act = b.dataset.attact;
    if (act === 'all') {
      if (attDraftFor !== m.id || !attDraft) { attDraft = {}; attDraftFor = m.id; }
      members().filter(x => x.status !== 'alumni').forEach(x => { attDraft[x.id] = 'present'; });
      toast('已暫存全部出席 —— 記得撳「確定出席」', 'info');
      paintAttPane(root, m);
    } else if (act === 'discard') {
      attDraft = {}; attDraftFor = m.id;
      paintAttPane(root, m);
    } else if (act === 'commit') {
      if (!attDirty(m)) return;
      const att = { ...(m.attendance || {}) };
      let on = 0, off = 0;
      Object.entries(attDraft).forEach(([mid, v]) => {
        if (v) { att[mid] = v; on++; } else { delete att[mid]; off++; }
      });
      update('meetings', m.id, { attendance: att, updatedAt: nowStamp() });
      toast(`出席已確定：標記 ${on} 項、清除 ${off} 項，一次過寫入後端 ✓`, 'ok');
      attDraft = {}; attDraftFor = m.id;
      paintAttPane(root, m);
    }
  }));
}

/* ---------- 會議記錄 ---------- */
function minutesPane(m) {
  const editable = can('meeting.minutes');
  return `<div class="card">
    <div class="card-head">
      <div><div class="card-title">會議記錄</div>
        <div class="card-sub">${m.updatedAt ? '最後更新 ' + esc(m.updatedAt) : '尚未撰寫'}</div></div>
      <div class="row gap-6 no-print">
        ${editable ? `<button class="btn btn-sm btn-primary" data-act="edit-minutes">${icon('edit', 15)} ${m.minutes ? '編輯' : '撰寫'}</button>` : ''}
        ${m.minutes ? `<button class="btn btn-sm" data-act="copy-minutes">${icon('copy', 15)} 複製</button>
                       <button class="btn btn-sm" data-act="dl-minutes">${icon('download', 15)} 下載</button>` : ''}
      </div>
    </div>
    <div style="padding:18px">
      ${m.minutes
        ? `<div style="white-space:pre-wrap;line-height:1.85;font-size:14.5px">${esc(m.minutes)}</div>`
        : `<div class="empty">${icon('note', 32)}<div class="empty-title">仲未有會議記錄</div>
           <div class="sm mt-4">秘書可喺會議後喺度撰寫並向團員公布。</div></div>`}
    </div>
  </div>`;
}

/* ---------- 決議 / 行動 ---------- */
function decisionPane(m) {
  const editable = can('meeting.edit', m);
  return `<div class="card">
    <div class="card-head">
      <div><div class="card-title">決議事項 / 待辦行動</div>
        <div class="card-sub">${(m.decisions || []).filter(d => d.done).length} 完成 · ${(m.decisions || []).filter(d => !d.done).length} 待辦</div></div>
      ${editable ? `<button class="btn btn-sm btn-primary" data-act="add-decision">${icon('plus', 15)} 新增</button>` : ''}
    </div>
    ${(m.decisions || []).length ? `<div class="table-scroll scroll-x"><table class="table">
      <thead><tr><th style="width:40px"></th><th>事項</th><th>負責人</th><th>到期</th>${editable ? '<th style="width:70px"></th>' : ''}</tr></thead>
      <tbody>${(m.decisions || []).map(d => `
        <tr>
          <td><button class="btn btn-xs btn-ghost" data-act="toggle-decision" data-id="${d.id}">
            ${d.done ? `<span style="color:var(--ok);display:flex">${icon('check', 16)}</span>` : `<span style="color:#CBD8D0;display:flex">${icon('check', 16)}</span>`}
          </button></td>
          <td><div style="${d.done ? 'text-decoration:line-through;color:var(--faint)' : ''}">${esc(d.text)}</div></td>
          <td>${d.owner ? `<div class="row gap-6">${avatar(memberName(d.owner), 'avatar-sm')}<span class="sm">${esc(memberName(d.owner))}</span></div>` : '<span class="faint">—</span>'}</td>
          <td class="mono sm">${esc(d.due || '—')}</td>
          ${editable ? `<td class="right nowrap">
            <button class="btn btn-xs btn-ghost" data-act="edit-decision" data-id="${d.id}">${icon('edit', 14)}</button>
            <button class="btn btn-xs btn-ghost" data-act="del-decision" data-id="${d.id}">${icon('trash', 14)}</button></td>` : ''}
        </tr>`).join('')}</tbody>
    </table></div>` : `<div class="empty">${icon('target', 32)}<div class="empty-title">仲未有決議事項</div></div>`}
  </div>`;
}

/* ---------- 附件 ---------- */
function filesPane(m) {
  return `<div class="card">
    <div class="card-head">
      <div><div class="card-title">附件</div><div class="card-sub">會議文件、相片、單據</div></div>
      ${can('meeting.edit', m) ? `<button class="btn btn-sm btn-primary" data-act="add-file">${icon('upload', 15)} 新增</button>` : ''}
    </div>
    ${(m.attachments || []).length ? `<div>${(m.attachments || []).map((f, i) => `
      <div class="list-item">
        <div class="stat-ic" style="width:32px;height:32px;border-radius:8px">${icon('note', 16)}</div>
        <div class="li-main"><div class="li-t">${esc(f.name)}</div><div class="li-s">${esc(f.size || '—')}</div></div>
        ${can('meeting.edit', m) ? `<button class="btn btn-xs btn-ghost" data-act="del-file" data-idx="${i}">${icon('trash', 14)}</button>` : ''}
      </div>`).join('')}</div>` : `<div class="empty">${icon('upload', 32)}<div class="empty-title">仲未有附件</div></div>`}
  </div>`;
}

/* ============================================================
   EDITOR
   ============================================================ */
function editor(m) {
  const isNew = !m;
  const d = m || {
    id: '', title: '', type: 'exco', date: todayISO(), time: '19:30', venue: '',
    chair: '', secretary: '', status: 'pending',
    agenda: [], attendance: {}, minutes: '', decisions: [], attachments: []
  };
  const roster = members().filter(x => x.status !== 'alumni');
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/meetings">${icon('chevronL', 15)} 返回</button></div>
  <div class="page-head"><div><div class="page-title">${isNew ? '新增會議' : '編輯會議'}</div>
    <div class="page-sub">填好基本資料，之後可再加議程同記錄</div></div></div>

  <div class="card card-pad" style="max-width:760px">
    <div class="grid g-2">
      <div class="field" style="grid-column:1/-1">
        <label class="label">會議名稱 <span class="req">*</span></label>
        <input class="input" id="f-title" value="${esc(d.title)}" placeholder="例如：九月執委會常會">
      </div>
      <div class="field">
        <label class="label">類型</label>
        <select class="select" id="f-type">
          ${Object.entries(MEETING_TYPES).map(([k, v]) => `<option value="${k}" ${d.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="label">狀態</label>
        <select class="select" id="f-status">
          ${Object.entries(MEETING_STATUS).map(([k, v]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label class="label">日期 <span class="req">*</span></label>
        <input class="input" type="date" id="f-date" value="${esc(d.date)}"></div>
      <div class="field"><label class="label">時間</label>
        <input class="input" type="time" id="f-time" value="${esc(d.time)}"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">地點</label>
        <input class="input" id="f-venue" value="${esc(d.venue)}" placeholder="例如：旅部活動室 / 線上"></div>
      <div class="field"><label class="label">主席</label>
        <select class="select" id="f-chair"><option value="">—</option>
          ${roster.map(x => `<option value="${x.id}" ${d.chair === x.id ? 'selected' : ''}>${esc(x.name)}（${esc(x.role)}）</option>`).join('')}
        </select></div>
      <div class="field"><label class="label">秘書</label>
        <select class="select" id="f-secretary"><option value="">—</option>
          ${roster.map(x => `<option value="${x.id}" ${d.secretary === x.id ? 'selected' : ''}>${esc(x.name)}（${esc(x.role)}）</option>`).join('')}
        </select></div>
    </div>
    <div class="row gap-8 mt-24" style="justify-content:flex-end">
      <button class="btn" data-go="#/meetings">取消</button>
      <button class="btn btn-primary" data-act="save">${icon('save', 16)} 儲存</button>
    </div>
  </div>`;
}

/* ============================================================
   MOUNT
   ============================================================ */
export function mount(root, params) {
  const m = params.id && params.id !== 'new' ? find('meetings', params.id) : null;
  const editable = m ? can('meeting.edit', m) : can('meeting.create');

  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => go('#/meetings/' + el.dataset.open)));

  // 列表：模式 / 篩選 / 搜尋
  root.querySelectorAll('[data-mode]').forEach(el => el.addEventListener('click', () => { viewMode = el.dataset.mode; refresh(); }));
  root.querySelector('[data-cal="prev"]')?.addEventListener('click', () => {
    const [yy, mm] = calCursor.split('-').map(Number);
    const d = new Date(yy, mm - 2, 1);
    calCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    refresh();
  });
  root.querySelector('[data-cal="next"]')?.addEventListener('click', () => {
    const [yy, mm] = calCursor.split('-').map(Number);
    const d = new Date(yy, mm, 1);
    calCursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    refresh();
  });
  root.querySelectorAll('[data-calday]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-open]')) return;
    go('#/meetings/new?date=' + el.dataset.calday);
  }));
  root.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => { filterStatus = el.dataset.filter; refresh(); }));
  const search = root.querySelector('#mtSearch');
  if (search) {
    search.addEventListener('input', () => { keyword = search.value; refresh(search.value); });
  }
  const newBtn = root.querySelector('[data-act="new"]');
  if (newBtn) newBtn.addEventListener('click', () => go('#/meetings/new'));

  // 詳細頁：分頁
  root.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => {
    tab = el.dataset.tab; setQuery({ tab }); refreshPane();
  }));
  const statusSel = root.querySelector('#mtStatus');
  if (statusSel && m && can('meeting.edit', m)) {
    statusSel.addEventListener('change', () => {
      update('meetings', m.id, { status: statusSel.value, updatedAt: nowStamp() });
      toast('狀態已更新為「' + statusLabel(statusSel.value) + '」', 'ok');
      refresh();
    });
  }

  // 出席點名（草稿制 —— 確定先一次過寫入；局部重繪，唔會彈上去頂）
  bindAttendPane(root, m);

  // 各項動作
  root.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (!m) return;

      if (act === 'add-agenda') {
        const r = await modal({
          title: '加入議程項目',
          body: `<div class="field"><label class="label">議程內容</label>
              <textarea class="textarea" id="q-text" placeholder="例如：司庫報告"></textarea></div>
            <div class="field mt-12"><label class="label">預計時間（分鐘）</label>
              <input class="input" id="q-min" type="number" value="10"></div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
                    { label: '加入', class: 'btn-primary', onClick: el => ({
                        text: el.querySelector('#q-text').value.trim(),
                        minutes: Number(el.querySelector('#q-min').value) || 0 }) }]
        });
        if (r && r.text) {
          const ag = [...(m.agenda || []), { id: uid('ag'), text: r.text, minutes: r.minutes }];
          update('meetings', m.id, { agenda: ag, updatedAt: nowStamp() });
          toast('已加入議程', 'ok'); refreshPane();
        }
      }

      if (act === 'edit-agenda') {
        const a = (m.agenda || []).find(x => x.id === btn.dataset.id);
        if (!a) return;
        const r = await modal({
          title: '編輯議程',
          body: `<div class="field"><label class="label">議程內容</label>
              <textarea class="textarea" id="q-text">${esc(a.text)}</textarea></div>
            <div class="field mt-12"><label class="label">預計時間（分鐘）</label>
              <input class="input" id="q-min" type="number" value="${a.minutes || 0}"></div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
                    { label: '儲存', class: 'btn-primary', onClick: el => ({
                        text: el.querySelector('#q-text').value.trim(),
                        minutes: Number(el.querySelector('#q-min').value) || 0 }) }]
        });
        if (r && r.text) {
          const ag = m.agenda.map(x => x.id === a.id ? { ...x, ...r } : x);
          update('meetings', m.id, { agenda: ag, updatedAt: nowStamp() });
          toast('已更新', 'ok'); refreshPane();
        }
      }

      if (act === 'del-agenda') {
        if (await confirmDlg({ title: '刪除議程', message: '確定刪除呢個議程項目？', danger: true, okText: '刪除' })) {
          update('meetings', m.id, { agenda: m.agenda.filter(x => x.id !== btn.dataset.id), updatedAt: nowStamp() });
          toast('已刪除'); refreshPane();
        }
      }

      if (act === 'edit-minutes') {
        const r = await modal({
          title: '會議記錄', wide: true,
          body: `<div class="field"><label class="label">內容</label>
            <textarea class="textarea" id="q-min" style="min-height:280px">${esc(m.minutes || '')}</textarea>
            <div class="hint">建議格式：每段一個議題，開首寫明討論要點及結論。</div></div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
                    { label: '儲存記錄', class: 'btn-primary', onClick: el => el.querySelector('#q-min').value }]
        });
        if (r !== null && r !== undefined) {
          update('meetings', m.id, { minutes: r, updatedAt: nowStamp() });
          toast('會議記錄已儲存', 'ok'); refreshPane();
        }
      }

      if (act === 'copy-minutes') {
        const { copyText } = await import('../lib/util.js');
        if (await copyText(m.minutes || '')) toast('已複製到剪貼簿', 'ok');
      }

      if (act === 'dl-minutes') {
        download(`${m.date}_${m.title}_會議記錄.txt`, m.minutes || '', 'text/plain;charset=utf-8');
        toast('已下載');
      }

      if (act === 'add-decision' || act === 'edit-decision') {
        const d = act === 'edit-decision' ? (m.decisions || []).find(x => x.id === btn.dataset.id) : null;
        const roster = members().filter(x => x.status !== 'alumni');
        const r = await modal({
          title: d ? '編輯決議 / 行動' : '新增決議 / 行動',
          body: `<div class="field"><label class="label">事項 <span class="req">*</span></label>
              <textarea class="textarea" id="q-text" placeholder="例如：於 10 月 10 日前完成遠足路線勘察">${d ? esc(d.text) : ''}</textarea></div>
            <div class="grid g-2 mt-12">
              <div class="field"><label class="label">負責人</label>
                <select class="select" id="q-owner"><option value="">—</option>
                  ${roster.map(x => `<option value="${x.id}" ${d?.owner === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
                </select></div>
              <div class="field"><label class="label">到期日</label>
                <input class="input" type="date" id="q-due" value="${d?.due || ''}"></div>
            </div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
            { label: '儲存', class: 'btn-primary', onClick: el => ({
                text: el.querySelector('#q-text').value.trim(),
                owner: el.querySelector('#q-owner').value,
                due: el.querySelector('#q-due').value }) }]
        });
        if (r && r.text) {
          const list = [...(m.decisions || [])];
          if (d) Object.assign(d, r); else list.push({ id: uid('d'), done: false, ...r });
          update('meetings', m.id, { decisions: list, updatedAt: nowStamp() });
          toast('已儲存', 'ok'); refreshPane();
        }
      }

      if (act === 'toggle-decision') {
        const list = m.decisions.map(x => x.id === btn.dataset.id ? { ...x, done: !x.done } : x);
        update('meetings', m.id, { decisions: list, updatedAt: nowStamp() });
        refreshPane();
      }

      if (act === 'del-decision') {
        if (await confirmDlg({ title: '刪除', message: '確定刪除呢項決議？', danger: true, okText: '刪除' })) {
          update('meetings', m.id, { decisions: m.decisions.filter(x => x.id !== btn.dataset.id), updatedAt: nowStamp() });
          toast('已刪除'); refreshPane();
        }
      }

      if (act === 'add-file') {
        const r = await modal({
          title: '新增附件',
          body: `<div class="field"><label class="label">檔案名稱</label>
              <input class="input" id="q-name" placeholder="例如：議程.pdf"></div>
            <div class="field mt-12"><label class="label">大小（可留空）</label>
              <input class="input" id="q-size" placeholder="例如：412 KB"></div>
            <div class="hint mt-8">原型版本只記錄檔名；接上後端後可改為真正上載檔案。</div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
            { label: '加入', class: 'btn-primary', onClick: el => ({
                name: el.querySelector('#q-name').value.trim(),
                size: el.querySelector('#q-size').value.trim() || '—' }) }]
        });
        if (r && r.name) {
          update('meetings', m.id, { attachments: [...(m.attachments || []), r], updatedAt: nowStamp() });
          toast('已加入附件', 'ok'); refreshPane();
        }
      }

      if (act === 'del-file') {
        const i = Number(btn.dataset.idx);
        update('meetings', m.id, { attachments: m.attachments.filter((_, k) => k !== i), updatedAt: nowStamp() });
        toast('已刪除'); refreshPane();
      }

      if (act === 'edit') go('#/meetings/' + m.id + '/edit');
      if (act === 'print') window.print();

      if (act === 'del') {
        if (await confirmDlg({
          title: '刪除會議', danger: true, okText: '確定刪除',
          message: `確定刪除「<b>${esc(m.title)}</b>」？<br><span class="muted">會議記錄、議程及出席資料會一併刪除，此動作不能復原。</span>`
        })) {
          remove('meetings', m.id);
          toast('會議已刪除', 'ok'); go('#/meetings');
        }
      }

      if (act === 'save') return saveMeeting(root, m);
    });
  });
}

/* ---------- 儲存（新增 / 編輯） ---------- */
function saveMeeting(root, existing) {
  const val = id => root.querySelector(id)?.value ?? '';
  const title = val('#f-title').trim();
  const date = val('#f-date');
  if (!title) { toast('請填寫會議名稱', 'err'); root.querySelector('#f-title')?.focus(); return; }
  if (!date) { toast('請選擇日期', 'err'); return; }

  const payload = {
    title, date,
    type: val('#f-type'), status: val('#f-status'), time: val('#f-time'),
    venue: val('#f-venue').trim(), chair: val('#f-chair'), secretary: val('#f-secretary'),
    updatedAt: nowStamp()
  };

  if (existing) {
    update('meetings', existing.id, payload);
    toast('會議已更新', 'ok');
    go('#/meetings/' + existing.id);
  } else {
    const m = add('meetings', {
      id: uid('mt'), ...payload,
      agenda: [], attendance: {}, minutes: '', decisions: [], attachments: [],
      createdBy: current()?.username || 'system'
    });
    toast('會議已建立', 'ok');
    go('#/meetings/' + m.id);
  }
}

export function refresh() {
  window.dispatchEvent(new CustomEvent('v82:refresh'));
}
function refreshPane() { refresh(); }
