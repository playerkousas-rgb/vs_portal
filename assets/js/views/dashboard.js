/* ============================================================
   dashboard.js — 儀表板（含生日提示、待辦通知）
   ============================================================ */

import { load } from '../lib/store.js';
import {
  members, birthdaySummary, feeSummary, overdueFees, upcomingMeetings, openActions,
  notices, claims, pendingClaims, stockSummary, balance, currentBalance, balanceBreakdown,
  money, tx, profile, settings
} from '../lib/model.js';
import { esc, icon, avatar, fmtDate, relDay, todayISO } from '../lib/util.js';
import { current, can, displayName } from '../lib/auth.js';
import { pageHead, stat, empty, noteBox } from './ui.js';
import { go } from '../lib/router.js';
import { claimForm } from './finance.js';

export function title() { return '儀表板'; }

export function render() {
  const b = birthdaySummary();
  const f = feeSummary();
  const st = stockSummary();
  const list = notices();
  const today = todayISO();
  const months = new Set(tx().map(t => String(t.date).slice(0, 7)));
  const curMonth = today.slice(0, 7);
  const bal = balanceBreakdown();

  return `
  ${pageHead({
    title: '儀表板',
    sub: `${profile().name || ''} · 今日 ${fmtDate(today, 'full')}（${new Date().toLocaleDateString('zh-HK', { weekday: 'long' })}）`,
    actions: `
      <button class="btn btn-sm" data-go="#/meetings/new">${icon('plus', 15)} 開會</button>
      <button class="btn btn-sm" data-go="#/finance/new">${icon('plus', 15)} 記帳</button>
      <button class="btn btn-sm" data-go="#/inventory/loans?new=1">${icon('plus', 15)} 借物資</button>`
  })}

  ${list.length ? `
  <div class="card mb-16">
    <div class="card-head">
      <div><div class="card-title">提示中心</div>
        <div class="card-sub">${list.length} 項要跟進（生日、團費、申報、借用、會議行動）</div></div>
      <span class="badge b-warn"><span class="dot"></span>${list.filter(x => x.level === 'danger').length} 項緊急</span>
    </div>
    <div style="padding:6px 0">
      ${list.slice(0, 8).map(n => `
        <div class="row gap-12" style="padding:10px 16px;border-bottom:1px solid var(--line-2);cursor:pointer" data-go="${n.link}">
          <span class="stat-ic" style="background:var(--${n.level === 'danger' ? 'danger' : n.level === 'warn' ? 'warn' : 'brand'}-bg);color:var(--${n.level === 'danger' ? 'danger' : n.level === 'warn' ? 'warn' : 'brand'}-700)">
            ${icon(n.kind === 'birthday' ? 'sparkle' : n.kind === 'fee' ? 'wallet' : n.kind === 'claim' ? 'note' : n.kind === 'loan' ? 'grid' : n.kind === 'agm' ? 'calendar' : 'alert', 15)}
          </span>
          <div class="grow sm">${esc(n.text)}</div>
          ${icon('chevronR', 15)}
        </div>`).join('')}
    </div>
  </div>` : ''}

  <div class="card mb-16 quick-capture">
    <div class="card-head">
      <div><div class="card-title">手機快速記一筆</div>
        <div class="card-sub">成員用手機就可以：影低單據 → 揀欄目 → 送出（唔使再開 Google Form）</div></div>
    </div>
    <div style="padding:14px 16px">
      <div class="row gap-8 wrap">
        <button class="btn btn-primary btn-lg" data-quick="claim">${icon('camera', 18)} 影相記一筆</button>
        <button class="btn" data-go="#/finance/claims">${icon('note', 16)} 睇待批核申報</button>
        <button class="btn" data-go="#/finance/fees">${icon('wallet', 16)} 交團費</button>
      </div>
      <div class="hint mt-8">送出後：司庫／領袖批核 → 自動入帳。相片會壓縮儲存，帳目可以隨時匯出 CSV / Word。</div>
    </div>
  </div>

  ${bal.now < 0 ? noteBox(
    `<b>點解會見到負數？</b> 而家顯示嘅係「<b>${esc(bal.year)} 年度</b>期初結餘 ＋ 本年度收入 − 本年度支出」。${
      bal.likelyMissingOpening
        ? `你仲未填 <b>${esc(bal.year)} 年度嘅期初結餘</b>（上年度 ${esc(bal.prevYear)} 嘅期末係 <b>${money(bal.prevClosing)}</b>${bal.referenceClosing ? `；你嘅舊帳期末係 <b>${money(bal.referenceClosing)}</b>` : ''}），所以先會變負。`
        : bal.hasOpening ? '請核對本年度期初結餘同期內帳目。' : `而家 ${esc(bal.year)} 年度期初結餘係 0，如果旅團本身有底數，請先填期初結餘。`
    }<div class="row gap-8 mt-10 wrap">
      <button class="btn btn-xs btn-primary" data-go="#/finance/settings">改 ${esc(bal.year)} 期初結餘</button>
      <button class="btn btn-xs" data-go="#/finance/import">匯入舊帳（會自動結轉）</button></div>`, 'warn') + '<div class="mb-16"></div>' : ''}

  <div class="card mb-16">
    <div class="card-head">
      <div><div class="card-title">帳目（現在）· ${esc(bal.year)} 年度</div>
        <div class="card-sub">本年度 ${esc(bal.range.start)} 至 ${esc(bal.range.end)} · 截至 ${fmtDate(today, 'full')} · 本年度 ${bal.count} 筆${months.has(curMonth) ? ' · 本月已有記錄' : ' · 本月未有記錄'}</div></div>
      <button class="btn btn-sm" data-go="#/finance">${icon('wallet', 14)} 去財務</button>
    </div>
    <div style="padding:14px 16px">
      <div class="bal-flow">
        <div class="bal-cell"><div class="bal-k">${esc(bal.year)} 期初結餘</div>
          <div class="bal-v">${money(bal.opening)}</div>
          <div class="bal-s">${bal.openingExplicit
            ? '已設定'
            : bal.prevCount ? `結轉自 ${esc(bal.prevYear)}（${bal.prevCount} 筆）` : '<span class="faint">未填（撳入去設定）</span>'}</div></div>
        <div class="bal-op">＋</div>
        <div class="bal-cell"><div class="bal-k">本年度收入</div>
          <div class="bal-v" style="color:var(--ok)">${money(bal.income)}</div>
          <div class="bal-s">${list2income(bal)} 筆</div></div>
        <div class="bal-op">−</div>
        <div class="bal-cell"><div class="bal-k">本年度支出</div>
          <div class="bal-v" style="color:var(--danger)">${money(bal.expense)}</div>
          <div class="bal-s">${bal.count - list2income(bal)} 筆</div></div>
        <div class="bal-op">＝</div>
        <div class="bal-cell now"><div class="bal-k">現在結餘</div>
          <div class="bal-v" style="color:${bal.now < 0 ? 'var(--danger)' : 'var(--brand-700)'}">${money(bal.now)}</div>
          <div class="bal-s">${bal.now < 0 ? '⚠ 請核對期初結餘' : '可用結餘'}</div></div>
      </div>
      <div class="row-between wrap gap-8 mt-12" style="border-top:1px dashed var(--line-2);padding-top:10px">
        <div class="xs faint">上年度 ${esc(bal.prevYear)}：期初 ${money(bal.prevOpening)} → <b>期末 ${money(bal.prevClosing)}</b>（${bal.prevCount} 筆）
          ${bal.openingExplicit && Math.abs(bal.prevClosing - bal.opening) > 0.005
            ? `<span style="color:var(--warn)"> ⚠ 同本年度期初 ${money(bal.opening)} 唔吻合</span>` : ''}</div>
        <button class="btn btn-xs" data-go="#/finance/settings">${icon('settings', 13)} 逐年期初結餘</button>
      </div>
      ${bal.hasUnimportedReference ? `<div class="hint mt-10">你嘅舊帳（${esc(bal.referenceYear || '')} 分頁，${(load().reference?.transactions || []).length} 筆：期初 ${money(bal.referenceOpening)} → 期末 <b>${money(bal.referenceClosing)}</b>）仲未入帳 ——
        <button class="btn btn-xs" data-go="#/finance/import">去匯入（會把期末結轉做 ${esc(bal.year)} 期初）</button></div>` : ''}
      ${bal.openingMismatch ? `<div class="hint mt-8" style="color:var(--warn)">本年度期初（${money(bal.opening)}）同舊帳期末（${money(bal.referenceClosing)}）唔同，請核對。</div>` : ''}
    </div>
  </div>

  <div class="grid g-4 mb-16">
    ${stat('團員（現役）', String(members().filter(m => m.status === 'active').length), `共 ${members().length} 人（含休假／舊團員）`)}
    ${stat('本月生日 🎂', String(b.month.length), b.in7.length ? `${b.in7.length} 位 7 日內生日` : '7 日內暫無', b.month.length ? 'brand' : '')}
    ${stat('現在結餘', money(bal.now),
      `期初 ${money(bal.opening)} ＋ 收入 ${money(bal.income)} − 支出 ${money(bal.expense)}`,
      bal.now < 0 ? 'danger' : 'ok')}
    ${stat(f.unpaidCount ? '未收團費' : '團費已清', f.unpaidCount ? money(f.outstanding) : '全部收齊',
      `${esc(settings().feePeriodLabel || '')}${f.paidCount}/${f.total} 已收（${f.rate}%）`, f.unpaidCount ? 'warn' : 'ok')}
  </div>

  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">生日提示</div>
            <div class="card-sub">生日前 ${settings().birthday?.remindDaysBefore || 7} 日自動提示</div></div>
          <button class="btn btn-sm" data-go="#/members/birthdays">${icon('chevronR', 14)} 生日表</button>
        </div>
        <div>
          ${(b.in7.length || b.month.length) ? `
            ${b.today.map(x => bdayRow(x, '今日生日 🎂🥳')).join('')}
            ${b.in7.filter(x => x.days > 0).map(x => bdayRow(x)).join('')}
            ${b.month.filter(x => x.days > (settings().birthday?.remindDaysBefore || 7)).map(x => bdayRow(x)).join('')}
          ` : empty('sparkle', '本月暫時冇團員生日', '生日資料可以喺「團員」頁修改')}
        </div>
        ${b.unknown.length ? `<div style="padding:12px 16px;border-top:1px solid var(--line-2)">
          <div class="xs faint">未填生日：${esc(b.unknown.join('、'))}</div></div>` : ''}
      </div>

      <div class="card">
        <div class="card-head">
          <div><div class="card-title">即將舉行嘅會議</div>
            <div class="card-sub">${upcomingMeetings().length} 個</div></div>
          <button class="btn btn-sm" data-go="#/meetings">${icon('calendar', 14)} 全部會議</button>
        </div>
        <div>${upcomingMeetings(4).length ? upcomingMeetings(4).map(m => `
          <div class="list-item" data-go="#/meetings/${m.id}">
            <span class="stat-ic">${icon('calendar', 16)}</span>
            <div class="li-main"><div class="li-t">${esc(m.title)}</div>
              <div class="li-s">${esc(fmtDate(m.date, 'full'))} · ${esc(m.time || '')} · ${esc(m.venue || '')}</div></div>
            <span class="badge b-info">${relDay(m.date)}</span>
          </div>`).join('') : empty('calendar', '暫時冇已排期嘅會議')}
        </div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">我嘅身份</div></div>
        <div style="padding:16px 18px">
          <div class="row gap-12 mb-12">
            <span class="avatar" style="background:${current()?.role === 'exco' ? '#A83A4E' : '#7B2233'}">
              ${icon(current()?.role === 'super' ? 'shield' : current()?.role === 'leader' ? 'flag' : 'users', 17)}</span>
            <div><div class="semibold">${esc(displayName())}</div>
              <div class="xs muted">${esc(current()?.role === 'super' ? '超級管理員' : current()?.role === 'leader' ? '領袖' : '執行委員會')}</div></div>
          </div>
          <div class="xs faint" style="line-height:1.7">
            ${can('admin.accounts') ? '✓ 可管理帳戶<br>' : ''}
            ${can('constitution.edit') ? '✓ 可編輯團章<br>' : '· 團章只可閱讀<br>'}
            ${can('inv.approve') ? '✓ 可批核物資借用<br>' : ''}
            ${can('claim.review') ? '✓ 可批核收支申報' : ''}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">待處理</div></div>
        <div style="padding:6px 0">
          ${row('#/finance/claims', 'note', '收支申報待批', pendingClaims().length)}
          ${row('#/inventory/loans', 'grid', '物資借用待批', st.pending)}
          ${row('#/finance/fees', 'wallet', '團費逾期', overdueFees().length)}
          ${row('#/meetings', 'check', '會議行動未完成', openActions().length)}
          ${row('#/inventory', 'alert', '物資缺貨', st.low.length)}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">物資快況</div></div>
        <div style="padding:16px 18px">
          <div class="grid g-2" style="gap:10px">
            <div><div class="xs faint">物資種類</div><div class="semibold">${st.kinds} 種 / ${st.units} 件</div></div>
            <div><div class="xs faint">借出中</div><div class="semibold">${st.out} 件</div></div>
            <div><div class="xs faint">逾期未還</div><div class="semibold" style="color:${st.overdue ? 'var(--danger)' : 'inherit'}">${st.overdue} 宗</div></div>
            <div><div class="xs faint">待批借用</div><div class="semibold">${st.pending} 宗</div></div>
          </div>
          <button class="btn btn-sm btn-block mt-16" data-go="#/inventory">${icon('grid', 15)} 物資紀錄</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">快速連結</div></div>
        <div style="padding:14px 16px" class="col gap-8">
          <button class="btn btn-block btn-soft" data-go="#/constitution">${icon('book', 16)} 團章（雙語／輸出）</button>
          <button class="btn btn-block btn-soft" data-go="#/progress">${icon('chart', 16)} 進度紀錄系統</button>
          <button class="btn btn-block btn-soft" data-go="#/docs">${icon('note', 16)} 使用教學</button>
        </div>
      </div>
    </div>
  </div>`;
}

function list2income(bal) {
  const r = bal.range;
  return tx().filter(t => t.type === 'income' && String(t.date).slice(0, 10) >= r.start && String(t.date).slice(0, 10) <= r.end).length;
}

function bdayRow(x, custom = '') {
  const isToday = x.days === 0;
  const when = isToday ? (custom || '今日生日') : (x.days === 1 ? '明天' : `${x.days} 日後`);
  return `<div class="bday ${isToday ? 'today' : ''}">
    <span class="cake">${isToday ? '🎂' : icon('sparkle', 16)}</span>
    <div class="grow">
      <div class="semibold sm">${esc(x.name)}</div>
      <div class="xs faint">${Number(x.md.slice(0, 2))} 月 ${Number(x.md.slice(3))} 日${x.turning ? ` · 將滿 ${x.turning} 歲` : x.age !== null ? ` · ${x.age} 歲` : ''}</div>
    </div>
    <div class="when">
      <div class="days sm" style="color:${isToday ? 'var(--accent-700)' : x.days <= 3 ? 'var(--warn)' : 'var(--muted)'}">${esc(when)}</div>
    </div>
  </div>`;
}

function row(link, ic, label, count) {
  return `<div class="row gap-12" style="padding:10px 16px;border-bottom:1px solid var(--line-2);cursor:pointer" data-go="${link}">
    <span class="stat-ic">${icon(ic, 15)}</span>
    <div class="grow sm">${esc(label)}</div>
    <span class="badge ${count ? 'b-warn' : 'b-grey'}">${count}</span>
  </div>`;
}

export function mount(root) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-quick="claim"]').forEach(b => b.addEventListener('click', () => claimForm()));
}
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
