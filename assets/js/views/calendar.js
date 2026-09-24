/* 行事曆（活動，唔係會議）—— 團員可見／執委內部、RSVP、點名、出席統計 */
import { collection, find, add, update, remove } from '../lib/store.js';
import { memberName, RSVP, rsvpCounts, attendanceStats, activeMembers } from '../lib/model.js';
import { esc, icon, uid, todayISO, toast, modal, confirmDlg } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, noteBox, visSelect } from './ui.js';
import { contentVis } from '../lib/public-profile.js';

let tab = 'cal';
let cursor = todayISO().slice(0, 7);

/* ---------- 點名草稿（2026-09-18 團長回報改） ----------
   以前撳一下就寫入資料庫（跟住仲自動同步去後端），而且成頁重繪彈返上去頂。
   而家：撳掣只係記喺 draft，改到啱為止；撳「確定點名」先一次過寫入
   （一次 persist ＝ 一次後端同步），期間只係局部重繪點名嗰嚿，唔會跳位。 */
let rollDraft = null;        // { [memberId]: status }
let rollDraftFor = '';       // draft 屬於邊個活動

function rollEff(e, mid) {
  if (rollDraftFor === String(e.id) && rollDraft && rollDraft[mid] !== undefined) return rollDraft[mid];
  const base = (e.rollcall || {})[mid];
  return (base && typeof base === 'object' ? base.status : base) || '';
}
function rollDirty(e) {
  return rollDraftFor === String(e.id) && !!rollDraft && Object.keys(rollDraft).length > 0;
}

export function title() { return '行事曆'; }
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

const KINDS = { assembly: '集會', activity: '活動', ec: '執委會', other: '其他' };

function list() { return collection('events'); }

export function render(params) {
  if (['cal', 'list', 'stats'].includes(params.id)) tab = params.id;
  else if (params.id === 'new') return editor(null, params.query);
  else if (params.id && params.action === 'edit') return editor(find('events', params.id), params.query);
  else if (params.id) return detail(params.id, params.query);
  return `
  ${pageHead({
    title: '行事曆',
    sub: '活動／集會：團員可見或只限執委＋領袖。所有活動都有回覆同點名。',
    actions: can('calendar.edit') ? `<button class="btn btn-sm btn-primary" data-go="#/calendar/new">${icon('plus', 15)} 新增活動</button>` : ''
  })}
  ${tabs([['cal', '月曆'], ['list', '清單', list().length], ['stats', '出席統計']], tab)}
  ${tab === 'stats' ? statsView() : tab === 'list' ? listView() : monthView()}`;
}

function monthView() {
  const [yy, mm] = cursor.split('-').map(Number);
  const first = new Date(yy, mm - 1, 1);
  const startDow = (first.getDay() + 6) % 7;
  const days = new Date(yy, mm, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  /* 多日（過夜）活動：每個活動由 date 到 dateEnd（冇填就用 date 當日）
     每一日都會出現 —— 2026-09-18 第 3 項要求 */
  const monthStart = `${cursor}-01`, monthEnd = `${cursor}-${String(days).padStart(2, '0')}`;
  const byDay = {};
  list().forEach(e => {
    const d0 = String(e.date || '').slice(0, 10);
    if (!d0) return;
    const d1 = (String(e.dateEnd || '').slice(0, 10) >= d0) ? String(e.dateEnd).slice(0, 10) : d0;
    const from = d0 > monthStart ? d0 : monthStart;
    const to = d1 < monthEnd ? d1 : monthEnd;
    if (from > to) return;
    const start = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
    for (let t = start; t <= end; t.setDate(t.getDate() + 1)) {
      const d = t.getDate();
      (byDay[d] = byDay[d] || []).push(e);
    }
  });
  return `<div class="card">
    <div class="card-head">
      <div class="row gap-8">
        <button class="btn btn-sm" data-cal="prev">${icon('chevronL', 14)}</button>
        <div class="card-title">${yy} 年 ${mm} 月</div>
        <button class="btn btn-sm" data-cal="next">${icon('chevronR', 14)}</button>
      </div>
    </div>
    <div class="cal-grid">
      ${['一','二','三','四','五','六','日'].map(w => `<div class="cal-dow">${w}</div>`).join('')}
      ${cells.map(d => {
        if (!d) return '<div class="cal-cell empty"></div>';
        const iso = `${cursor}-${String(d).padStart(2, '0')}`;
        const items = byDay[d] || [];
        return `<div class="cal-cell" data-calday="${iso}">
          <div class="cal-n">${d}</div>
          ${items.map(e => {
            const c = rsvpCounts(e);
            const multi = e.dateEnd && e.dateEnd !== e.date;
            return `<button class="cal-ev ${e.visibility === 'exco' ? 'exco' : ''}" data-open="${e.id}">
              ${multi && String(e.date) !== iso ? '↳ ' : ''}${esc((e.title || '').slice(0, 18))}${multi ? ' …' : ''}
              <span class="xs faint"> ${c.present + c.late + c.early}出／${c.absent}唔出</span>
            </button>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>
    <div class="hint" style="padding:10px 14px">棗紅＝團員可見；虛線＝只限執委＋領袖。過夜活動會由首日拉到尾日（…＝仲有下日）。撳日子新增，撳活動睇人數同點名。</div>
  </div>`;
}

function listView() {
  const rows = list().slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!rows.length) return empty('calendar', '未有活動', '按右上「新增活動」');
  return `<div class="card"><div class="scroll-x"><table class="table">
    <thead><tr><th>日期</th><th>活動</th><th>可見</th><th>回覆</th><th>點名</th></tr></thead>
    <tbody>${rows.map(e => {
      const c = rsvpCounts(e);
      const overnight = e.dateEnd && e.dateEnd !== e.date;
      return `<tr data-open="${e.id}" style="cursor:pointer">
        <td class="mono sm">${esc(e.date)}${overnight ? `<br>至 ${esc(e.dateEnd)}` : ''} ${esc(e.time || '')}</td>
        <td><div class="semibold sm">${esc(e.title)}${overnight ? ' <span class="tag">過夜</span>' : ''}</div><div class="xs faint">${esc(KINDS[e.kind] || '')} · ${esc(e.venue || '')}</div></td>
        <td>${e.visibility === 'exco' ? '<span class="badge b-warn">執委＋領袖</span>' : '<span class="badge b-ok">團員可見</span>'}</td>
        <td class="sm">出 ${c.present} · 唔出 ${c.absent} · 遲 ${c.late} · 早 ${c.early}</td>
        <td class="sm">${c.rollTotal ? `已點 ${c.rollTotal}` : '<span class="faint">未點名</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
}

function statsView() {
  const roster = activeMembers();
  const evs = list().filter(e => e.status !== 'cancelled');
  if (!evs.length) return empty('chart', '未有活動，未有出席統計');
  const rows = roster.map(m => {
    const s = attendanceStats(m.id);
    return { m, ...s };
  }).sort((a, b) => b.rate - a.rate);
  return `<div class="note-box mb-16">${icon('chart', 15)}<div>統計用<strong>執委點名</strong>（唔係團員自己回覆），方便計全年出席率。</div></div>
  <div class="card"><div class="scroll-x"><table class="table table-compact">
    <thead><tr><th>成員</th><th class="right">出席</th><th class="right">遲到</th><th class="right">早走</th><th class="right">不出席</th><th class="right">已點</th><th style="width:140px">出席率</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="semibold sm">${esc(r.m.name)}<div class="xs faint">${esc(r.m.role || '')}</div></td>
      <td class="right">${r.present}</td><td class="right">${r.late}</td><td class="right">${r.early}</td>
      <td class="right">${r.absent}</td><td class="right">${r.marked}/${r.total}</td>
      <td><div class="bar"><span style="width:${r.rate}%"></span></div><div class="xs faint">${r.rate}%</div></td>
    </tr>`).join('')}</tbody>
  </table></div></div>`;
}

function peopleOf(ev, key) {
  const map = ev[key] || {};
  const groups = { present: [], absent: [], late: [], early: [] };
  Object.entries(map).forEach(([id, v]) => {
    const st = v.status || v;
    if (groups[st]) groups[st].push(memberName(id));
  });
  return groups;
}

/* ---------- 點名 pane（草稿制：確定先寫入） ---------- */
function rollPaneInner(e, roster) {
  const dirty = rollDirty(e);
  const marked = roster.filter(m => rollEff(e, m.id)).length;
  const nChanges = dirty ? Object.keys(rollDraft).length : 0;
  return `<div class="card">
    <div class="card-head"><div><div class="card-title">執委點名</div>
      <div class="card-sub">已點 ${marked} / ${roster.length} · 點名結果會計入出席統計${dirty ? ` · <b style="color:var(--warn)">有 ${nChanges} 個改動未確定</b>` : ''}</div></div>
      <div class="row gap-6 wrap">
        <button class="btn btn-xs" data-attact="all">全部出席</button>
        <button class="btn btn-xs" data-attact="discard" ${dirty ? '' : 'disabled'}>放棄改動</button>
        <button class="btn btn-xs btn-primary" data-attact="commit" ${dirty ? '' : 'disabled'}>${icon('check', 13)} 確定點名${dirty ? `（${nChanges}）` : ''}</button>
      </div></div>
    ${noteBox(dirty
      ? `有 ${nChanges} 個改動<b>仲未儲存</b> —— 撳右上「確定點名」先會一次過寫入後端。`
      : '撳掣點名<b>唔會即刻寫入後端</b>；點晒全團先撳右上「確定點名」，一次過儲存。中途撳錯可以「放棄改動」或者再撳同一個掣還原。', dirty ? 'warn' : 'brand')}
    <div class="scroll-x"><table class="table table-compact">
      <thead><tr><th>成員</th><th>回覆</th><th>點名</th></tr></thead>
      <tbody>${roster.map(m => {
        const r = (e.rsvp || {})[m.id];
        const rst = r?.status || r || '';
        const cst = rollEff(e, m.id);
        return `<tr>
          <td class="semibold sm">${esc(m.name)}</td>
          <td class="xs">${rst ? RSVP[rst]?.label : '—'}</td>
          <td>${['present','absent','late','early'].map(k =>
            `<button class="btn btn-xs ${cst === k ? 'btn-primary' : 'btn-ghost'}" data-roll="${m.id}" data-val="${k}">${RSVP[k].label}</button>`).join(' ')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

/** 只重繪點名嗰嚿 —— 唔會成頁重繪、唔會彈返上去頂 */
function paintRollPane(root, params) {
  const host = root.querySelector('#rollPane');
  const e = find('events', params.id);
  if (!host || !e) return;
  host.innerHTML = rollPaneInner(e, activeMembers());
  bindRollPane(root, params);
}

function bindRollPane(root, params) {
  const pane = root.querySelector('#rollPane');
  if (!pane) return;
  pane.querySelectorAll('[data-roll]').forEach(b => b.addEventListener('click', () => {
    const e = find('events', params.id);
    if (!e) return;
    if (rollDraftFor !== String(e.id) || !rollDraft) { rollDraft = {}; rollDraftFor = String(e.id); }
    const mid = b.dataset.roll, v = b.dataset.val;
    if (rollEff(e, mid) === v) delete rollDraft[mid];       // 再撳同一個＝還原
    else rollDraft[mid] = v;
    paintRollPane(root, params);
  }));
  pane.querySelectorAll('[data-attact]').forEach(b => b.addEventListener('click', async () => {
    const e = find('events', params.id);
    if (!e) return;
    const act = b.dataset.attact;
    if (act === 'all') {
      if (rollDraftFor !== String(e.id) || !rollDraft) { rollDraft = {}; rollDraftFor = String(e.id); }
      activeMembers().forEach(m => { rollDraft[m.id] = 'present'; });
      toast('已暫存全部出席 —— 記得撳「確定點名」', 'info');
      paintRollPane(root, params);
    } else if (act === 'discard') {
      rollDraft = {}; rollDraftFor = String(e.id);
      paintRollPane(root, params);
    } else if (act === 'commit') {
      if (!rollDirty(e)) return;
      const roll = { ...(e.rollcall || {}) };
      let n = 0;
      Object.entries(rollDraft).forEach(([mid, st]) => { roll[mid] = { status: st, at: todayISO() }; n++; });
      update('events', e.id, { rollcall: roll });
      toast(`已點名 ${n} 個改動，一次過寫入後端 ✓`, 'ok');
      rollDraft = {}; rollDraftFor = String(e.id);
      paintRollPane(root, params);
    }
  }));
}

function detail(id, query) {
  const e = find('events', id);
  if (!e) return empty('alert', '搵唔到呢個活動');
  /* 開另一個活動：丟埋上一個嘅未確定點名草稿（唔會帶過去第二個活動） */
  if (rollDraftFor && rollDraftFor !== String(id)) { rollDraft = null; rollDraftFor = ''; }
  const pane = query.tab || 'info';
  const c = rsvpCounts(e);
  const rsvp = peopleOf(e, 'rsvp');
  const roll = peopleOf(e, 'rollcall');
  const roster = activeMembers();
  const overnight = e.dateEnd && e.dateEnd !== e.date;
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/calendar">${icon('chevronL', 15)} 返回行事曆</button></div>
  ${pageHead({
    title: e.title,
    sub: `${e.date}${overnight ? ` 至 ${e.dateEnd}（過夜）` : ''} ${e.time || ''} · ${e.venue || ''} · ${KINDS[e.kind] || ''} · ${e.visibility === 'exco' ? '只限執委＋領袖' : '團員可見'}`,
    actions: can('calendar.edit') ? `<button class="btn btn-sm" data-act="edit">${icon('edit', 15)} 編輯</button>
      <button class="btn btn-sm btn-danger" data-act="del">${icon('trash', 15)}</button>` : ''
  })}
  <div class="grid g-4 mb-16">
    ${stat('出席', String(c.present), '團員回覆', 'ok')}
    ${stat('不出席', String(c.absent), '', c.absent ? 'danger' : '')}
    ${stat('遲到', String(c.late), '', c.late ? 'warn' : '')}
    ${stat('早走', String(c.early), '', '')}
  </div>
  <div class="seg mb-16 no-print">
    ${[['info', '內容'], ['who', '邊個回覆'], ['roll', '點名']].map(([k, l]) =>
      `<button data-dtab="${k}" aria-selected="${pane === k}">${l}</button>`).join('')}
  </div>
  ${pane === 'who' ? `<div class="grid g-2">${['present','absent','late','early'].map(k => `
    <div class="card"><div class="card-head"><div class="card-title">${RSVP[k].label}（${rsvp[k].length}）</div></div>
      <div style="padding:12px 16px" class="sm">${rsvp[k].length ? rsvp[k].map(esc).join('、') : '<span class="faint">未有</span>'}</div></div>`).join('')}</div>`
  : pane === 'roll' ? `<div id="rollPane">${rollPaneInner(e, roster)}</div>`
  : `<div class="card card-pad"><div class="sm" style="white-space:pre-wrap">${esc(e.detail || '未有詳細內容')}</div>
      ${e.fee ? `<div class="mt-12 xs">費用：${esc(e.fee)}</div>` : ''}
      ${e.deadline ? `<div class="xs">回覆截止：${esc(e.deadline)}</div>` : ''}</div>`}`;
}

function editor(e, query = {}) {
  const d = e || { title: '', date: query.date || todayISO(), dateEnd: '', time: '19:30', venue: '', kind: 'activity', visibility: 'members', detail: '', fee: '', deadline: '' };
  const dOvernight = !!(d.dateEnd && d.dateEnd !== d.date);
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/calendar">${icon('chevronL', 15)} 返回</button></div>
  ${pageHead({ title: e ? '編輯活動' : '新增活動', sub: '揀「團員可見」或「只限執委＋領袖」' })}
  <div class="card card-pad" style="max-width:720px">
    <div class="grid g-2" style="gap:12px">
      <div class="field" style="grid-column:1/-1"><label class="label">名稱 <span class="req">*</span></label>
        <input class="input" id="e-title" value="${esc(d.title)}" placeholder="例：週五集會／遠足／兩日營"></div>
      <div class="field"><label class="label">日期（開始）</label><input class="input" type="date" id="e-date" value="${esc(d.date)}"></div>
      <div class="field"><label class="label">時間</label><input class="input" type="time" id="e-time" value="${esc(d.time || '')}"></div>
      <div class="field" style="grid-column:1/-1">
        <label class="check"><input type="checkbox" id="e-overnight" ${dOvernight ? 'checked' : ''}> 過夜／多日活動（兩日營、大露營、外港交流等）</label>
      </div>
      <div class="field" style="grid-column:1/-1;${dOvernight ? '' : 'display:none'}" id="e-dateend-wrap">
        <label class="label">結束日期</label>
        <input class="input" type="date" id="e-dateend" value="${esc(d.dateEnd || d.date)}">
        <div class="hint mt-4">月曆會由開始日拉到結束日，團員入口都會見到「X 至 Y」。</div>
      </div>
      <div class="field"><label class="label">地點</label><input class="input" id="e-venue" value="${esc(d.venue || '')}"></div>
      <div class="field"><label class="label">種類</label>
        <select class="select" id="e-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:1/-1"><label class="label">邊個睇到</label>
        ${visSelect('event', contentVis(d, 'event'), 'id="e-vis"')}
        <div class="hint mt-4">設「對外公開」＝ <b>免登入</b>都睇到（會出現喺登入頁「公開資料」／對外專頁）。去側邊欄<b>公開資料</b>可以一眼睇晒而家公開緊啲乜。</div></div>
      <div class="field"><label class="label">費用（可空）</label><input class="input" id="e-fee" value="${esc(d.fee || '')}"></div>
      <div class="field"><label class="label">回覆截止</label><input class="input" type="date" id="e-dead" value="${esc(d.deadline || '')}"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">內容／資訊</label>
        <textarea class="textarea" id="e-detail" rows="6">${esc(d.detail || '')}</textarea></div>
    </div>
    <div class="row gap-8 mt-16" style="justify-content:flex-end">
      <button class="btn" data-go="#/calendar">取消</button>
      <button class="btn btn-primary" data-act="save">${icon('save', 16)} 儲存</button>
    </div>
  </div>`;
}

export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); go('#/calendar/' + el.dataset.open); }));
  root.querySelector('[data-cal="prev"]')?.addEventListener('click', () => {
    const [y, m] = cursor.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    refresh();
  });
  root.querySelector('[data-cal="next"]')?.addEventListener('click', () => {
    const [y, m] = cursor.split('-').map(Number);
    const d = new Date(y, m, 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    refresh();
  });
  root.querySelectorAll('[data-calday]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-open]')) return;
    if (!can('calendar.edit')) return;
    go('#/calendar/new?date=' + el.dataset.calday);
  }));
  root.querySelectorAll('[data-dtab]').forEach(b => b.addEventListener('click', () => {
    go('#/calendar/' + params.id + '?tab=' + b.dataset.dtab);
  }));
  /* 點名（草稿制 —— 確定先一次過寫入；局部重繪，唔會彈上去頂） */
  bindRollPane(root, params);
  root.querySelector('[data-act="edit"]')?.addEventListener('click', () => go('#/calendar/' + params.id + '/edit'));
  if (params.action === 'edit' && params.id) {
    /* fall through save on editor if we rendered editor via id/edit — handled below if render used editor */
  }
  root.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除活動', danger: true, okText: '刪除', message: '確定刪除此活動？回覆同點名會一齊刪。' })) {
      remove('events', params.id); toast('已刪除', 'ok'); go('#/calendar');
    }
  });
  root.querySelector('#e-overnight')?.addEventListener('change', e => {
    const wrap = root.querySelector('#e-dateend-wrap');
    if (!wrap) return;
    wrap.style.display = e.target.checked ? '' : 'none';
    if (e.target.checked) {
      const inp = root.querySelector('#e-dateend');
      if (inp && !inp.value) inp.value = root.querySelector('#e-date')?.value || todayISO();
    }
  });
  root.querySelector('[data-act="save"]')?.addEventListener('click', () => {
    const v = k => root.querySelector(k)?.value.trim() || '';
    const title = v('#e-title');
    if (!title) { toast('請填名稱', 'err'); return; }
    const date = v('#e-date') || todayISO();
    /* 過夜／多日：勾咗先有 dateEnd；尾日早過頭日就當返同一日 */
    const overnight = !!root.querySelector('#e-overnight')?.checked;
    let dateEnd = v('#e-dateend');
    if (!overnight) dateEnd = '';
    else if (!dateEnd || dateEnd < date) dateEnd = date;
    const payload = {
      title, date, dateEnd, time: v('#e-time'), venue: v('#e-venue'),
      kind: v('#e-kind') || 'activity',
      /* ★「邊個睇到」升級做五級（對外公開／團員／執委／領袖／團長）。
         visibility 係舊欄（得 members／exco 兩級），繼續寫住等舊代碼（團員入口
         嘅 `visibility !== 'exco'` 過濾、Code.gs 報表）唔使改都照行。 */
      vis: v('#e-vis') || 'member',
      visibility: v('#e-vis') === 'exco' ? 'exco' : 'members',
      detail: v('#e-detail'), fee: v('#e-fee'), deadline: v('#e-dead'), status: 'ok'
    };
    if (params.id && params.id !== 'new') {
      update('events', params.id, payload); toast('已更新', 'ok'); go('#/calendar/' + params.id);
    } else {
      const rec = add('events', { id: uid('ev'), rsvp: {}, rollcall: {}, ...payload });
      toast('已新增活動', 'ok'); go('#/calendar/' + rec.id);
    }
  });
}
