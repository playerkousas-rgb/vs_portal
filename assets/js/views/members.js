/* ============================================================
   members.js — 團員名冊、個人紀錄、生日表（可改、可輸出）
   ============================================================ */

import { collection, find, add, update, remove, commit, load, newSystemId } from '../lib/store.js';
import {
  members, member, memberName, attendanceStats, fees, memberStatus, memberBirthdayText,
  birthdayList, birthdaysThisMonth, birthdaysWithin, birthdaySummary, money, settings, profile,
  IDENTITIES, identityLabel, identityOf, guessIdentity, keyCoverage, memberKey, expectedKeyKind,
  feeExempt, feeExemptList, chief
} from '../lib/model.js';
import {
  bindDraftAutosave, readDraft, applyDraft, clearDraft, draftBanner, confirmDanger, undoable
} from '../lib/guard.js';
import { parseBirthday, ageFrom, daysUntilBirthday, turningAge, todayISO, isValidBirthday } from '../lib/dates.js';
import {
  esc, icon, avatar, fmtDate, relDay, modal, confirmDlg, toast, uid, download, nf, pct
} from '../lib/util.js';
import { toCSV, toWord, printDoc, download as dlFile, stamp } from '../lib/exporter.js';
import { go, parse } from '../lib/router.js';
import {
  can, setMemberHubPassword, TEMP_PASSWORD, openMemberAccount, reviewAccountApp,
  setMemberIdentity, canClaimChief, claimChief, canChangePasswordOf,
  displayName, current
} from '../lib/auth.js';
import { pageHead, tabs, empty, kv, chipbar, progressBar, noteBox } from './ui.js';

let kw = '';
let statusFilter = 'all';
let idFilter = 'all';
let bdayMonth = new Date().getMonth() + 1;
let tab = 'list';

export function title() { return '用戶與身份'; }

/** 團長狀態橫額：冇團長 → 提示認領（開戶嗰個 = 團長）；有團長 → 顯示係邊位 */
function chiefBanner() {
  const c = chief();
  if (c) {
    return `<div class="note-box mb-16">${icon('sparkle', 15)}<div>
      <b>團長：${esc(c.name)}</b>${c.email ? `（${esc(c.email)}）` : (c.ymis ? `（${esc(c.ymis)}）` : '')}
      —— 每個旅團永遠只有一位團長（最高權限），可以隨時轉移。
      <div class="xs faint mt-4">想交棒：去下一位嘅用戶頁撳「設為團長（轉移）」。</div></div></div>`;
  }
  const mine = canClaimChief();
  return `<div class="note-box warn mb-16">${icon('alert', 15)}<div>
    <b>仲未設定團長</b> —— 第一個設定嘅人（開戶嗰位）就係團長。
    <div class="xs mt-4">${mine ? '你而家可以認領團長身份（之後可以轉移）。' : '請團長／領袖入去認領。'}</div>
    ${mine ? `<button class="btn btn-sm btn-primary mt-8" data-act="claim-chief">${icon('sparkle', 14)} 我係團長（認領身份）</button>` : ''}
  </div></div>`;
}

export function render(params) {
  const id = params.id;
  if (id === 'new') return editor(null);
  if (id === 'edit') return editor(params.action);        // #/members/edit/<id>
  if (id === 'birthdays') return birthdayView();
  if (id) return detail(id);
  return listView();
}

/* ============================================================
   名冊
   ============================================================ */
function listView() {
  const all = members();
  const S = memberStatus();
  let list = all;
  if (statusFilter !== 'all') list = list.filter(m => m.status === statusFilter);
  if (idFilter !== 'all') list = list.filter(m => identityOf(m) === idFilter);
  if (kw) {
    const k = kw.toLowerCase();
    list = list.filter(m => (m.name + ' ' + (m.eng || '') + ' ' + (m.role || '') + ' ' + identityLabel(m) + ' ' + (m.phone || '')).toLowerCase().includes(k));
  }
  const b = birthdaySummary();
  const cnt = k => all.filter(m => identityOf(m) === k).length;

  return `
  ${pageHead({
    title: '用戶',
    sub: `${all.length} 位 · 團長 ${cnt('chief')} · 領袖 ${cnt('leader')} · 執委 ${cnt('exco')} · 團員 ${cnt('member')}`,
    actions: `
      ${can('member.export') ? `<button class="btn btn-sm" data-act="exp-csv">${icon('download', 15)} CSV</button>
      <button class="btn btn-sm" data-act="exp-word">${icon('download', 15)} Word</button>
      <button class="btn btn-sm" data-act="exp-bday">${icon('sparkle', 15)} 生日表</button>` : ''}
      <button class="btn btn-sm" data-fields="members" title="改名／加欄位（例：小隊、收據編號）">${icon('table', 15)} 欄位</button>
      ${can('member.create') ? `<button class="btn btn-sm" data-act="bulk-open">${icon('users', 15)} 批量開戶</button>
      <button class="btn btn-sm btn-primary" data-act="new">${icon('plus', 15)} 新增用戶</button>` : ''}`
  })}

  <div class="note-box mb-16">${icon('users', 15)}<div>
    呢度係<b>用戶名冊</b> —— 團長、領袖、執委同團員都會列喺呢度，<b>每人一個帳號</b>（冇共用帳號）。
    每一行都可以撳「<b>編輯</b>」改資料同<b>身份</b>；<b>改身份就係改權限</b>（換屆唔使開新帳戶）。
    <div class="xs faint mt-4">登入代號：團長／領袖用<b>電郵</b>，執委／團員用 <b>YMIS</b>（冇都可以設「自訂帳號」）。改動會先暫存喺呢部裝置，撳「儲存」先寫入。</div></div></div>

  ${chiefBanner()}

  ${(() => {
    const apps = collection('accountApps').filter(a => a.status === 'pending');
    if (!apps.length || !can('member.create')) return '';
    return `<div class="card mb-16"><div class="card-head"><div class="card-title">待批開戶</div></div>
      ${apps.map(a => `<div class="list-item">
        <div class="li-main"><div class="li-t">${esc(a.name)} · ${esc(a.ymis)}</div>
          <div class="li-s">${esc(a.rosterName ? '名冊：' + a.rosterName : '名冊未有此人')}${a.email ? ' · ' + esc(a.email) : ''}</div></div>
        <button class="btn btn-xs btn-primary" data-act="approve-app" data-id="${a.id}">批准（密碼 ${TEMP_PASSWORD}）</button>
        <button class="btn btn-xs" data-act="reject-app" data-id="${a.id}">拒絕</button>
      </div>`).join('')}</div>`;
  })()}

  ${(() => {
    const kc = keyCoverage(all);
    if (!kc.total || kc.unmatched === 0) return '';
    const names = kc.unmatchedList.slice(0, 6)
      .map(x => `${esc(x.name)}（${x.need === 'email' ? '要 Email' : '要 YMIS'}）`).join('、');
    return `<div class="note-box ${kc.matched ? '' : 'warn'} mb-16">${icon('alert', 15)}<div>
      <b>可以同進度系統對上：${kc.percent}%</b>（${kc.matched}／${kc.total} 位）
      · 團員／執委 ${kc.youthWithYmis}／${kc.youthTotal} 有 YMIS
      · 領袖 ${kc.leaderWithEmail}／${kc.leaderTotal} 有 Email
      <div class="xs">進度追蹤係<b>獨立系統</b>。對方嘅規矩係<b>團員用 YMIS（10 位數字）、領袖用 Email</b>，
      所以要按身份補啱嗰個欄；未補嘅只可以用姓名配對（會撞名、會漏）。</div>
      <div class="xs mt-4">未對得上：${names}${kc.unmatchedList.length > 6 ? ` 等 ${kc.unmatchedList.length} 位` : ''}</div></div></div>`;
  })()}

  <div class="grid g-3 mb-16">
    <div class="card" style="cursor:pointer" data-go="#/members/birthdays">
      <div style="padding:15px 16px">
        <div class="stat-label">本月生日 🎂</div>
        <div class="stat-value brand">${b.month.length}<span class="sm faint" style="font-weight:600"> 位</span></div>
        <div class="stat-sub">${b.month.slice(0, 3).map(x => esc(x.name)).join('、') || '本月暫無'}${b.month.length > 3 ? ' 等' : ''}</div>
      </div>
    </div>
    <div class="card">
      <div style="padding:15px 16px">
        <div class="stat-label">7 日內生日</div>
        <div class="stat-value" style="color:${b.in7.length ? 'var(--warn)' : 'inherit'}">${b.in7.length}<span class="sm faint" style="font-weight:600"> 位</span></div>
        <div class="stat-sub">${b.in7.map(x => `${esc(x.name)}（${x.days === 0 ? '今日' : x.days + '日'}）`).join('、') || '暫無'}</div>
      </div>
    </div>
    <div class="card">
      <div style="padding:15px 16px">
        <div class="stat-label">未填生日</div>
        <div class="stat-value">${b.unknown.length}<span class="sm faint" style="font-weight:600"> 位</span></div>
        <div class="stat-sub truncate">${b.unknown.map(esc).join('、') || '全部已填'}</div>
      </div>
    </div>
  </div>

  <div class="row-between mb-16 wrap gap-12 no-print">
    <div class="col gap-8" style="min-width:0">
      ${chipbar([['all', '全部身份', all.length], ['chief', '團長', cnt('chief')], ['leader', '領袖', cnt('leader')], ['exco', '執委', cnt('exco')], ['member', '團員', cnt('member')]], idFilter, 'data-ident')}
      ${chipbar([['all', '全部狀態', all.length], ['active', '現役', all.filter(m => m.status === 'active').length],
        ['leave', '休假', all.filter(m => m.status === 'leave').length], ['alumni', '舊團員', all.filter(m => m.status === 'alumni').length]], statusFilter, 'data-status')}
    </div>
    <div class="search-wrap">
      <span class="ic">${icon('search', 15)}</span>
      <input class="input" id="mSearch" placeholder="搜尋姓名／身份／職位／電話…" value="${esc(kw)}">
    </div>
  </div>

  <div class="card">
    ${list.length ? `<div class="scroll-x"><table class="table">
      <thead><tr>
        <th>用戶</th><th>身份</th><th>職位</th><th>生日</th><th class="center">年齡</th>
        <th class="center">出席率</th><th class="center">收費</th><th>狀態</th><th></th>
      </tr></thead>
      <tbody>${list.map(m => {
        const s = attendanceStats(m.id);
        const mf = fees().filter(f => f.memberId === m.id);
        const unpaid = mf.filter(f => !f.paid);
        const p = parseBirthday(m.birthday);
        const dLeft = daysUntilBirthday(m.birthday);
        return `<tr style="cursor:pointer" data-open="${m.id}">
          <td><div class="row gap-10">${avatar(m.name)}
            <div><div class="semibold">${esc(m.name)}</div><div class="xs faint">${esc(m.eng || '')}</div></div></div></td>
          <td><span class="badge ${IDENTITIES[identityOf(m)].c}"><span class="dot"></span>${esc(identityLabel(m))}</span></td>
          <td><div class="sm">${esc(m.role || '—')}</div>
            ${(m.tags || []).length ? `<div class="row gap-4 mt-4 wrap">${m.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}</td>
          <td class="mono sm">${p ? `${Number(p.md.slice(0, 2))}/${Number(p.md.slice(3))}${p.hasYear ? ` <span class="faint">(${p.y})</span>` : ' <span class="faint">(年份待補)</span>'}` : '<span class="faint">未填</span>'}
            ${dLeft !== null && dLeft <= 7 ? `<div class="xs" style="color:var(--accent-700);font-weight:700">${dLeft === 0 ? '🎂 今日生日' : `${dLeft} 日後生日`}</div>` : ''}</td>
          <td class="center mono">${ageFrom(m.birthday) ?? '—'}</td>
          <td class="center" style="min-width:96px">
            <div class="sm mono" style="color:${s.rate >= 80 ? 'var(--ok)' : s.rate >= 50 ? 'var(--warn)' : 'var(--danger)'}">${s.rate}%</div>
            ${progressBar(s.rate)}
            <div class="xs faint mt-4">${s.present}/${s.total} 次</div>
          </td>
          <td class="center">${feeExempt(m)
            ? '<span class="badge b-grey" title="領袖／已設定免收團費">免收團費</span>'
            : (mf.length ? (unpaid.length
              ? `<span class="badge b-danger">欠 ${unpaid.length} 筆</span>`
              : `<span class="badge b-ok"><span class="dot"></span>已清</span>`) : '<span class="faint xs">—</span>')}</td>
          <td><span class="badge ${S[m.status]?.c || 'b-grey'}"><span class="dot"></span>${S[m.status]?.l || m.status}</span></td>
          <td class="right">${can('member.edit')
            ? `<button class="btn btn-xs" data-edit="${m.id}">${icon('edit', 13)} 編輯</button>`
            : icon('chevronR', 15)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : empty('users', '搵唔到用戶', '試下清除搜尋或篩選條件')}
  </div>`;
}

/* ============================================================
   生日表（可改、可輸出）
   ============================================================ */
function birthdayView() {
  const b = birthdaySummary();
  const opts = { includeAlumni: false };
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const list = birthdaysThisMonth(bdayMonth, opts);
  const next7 = birthdaysWithin(Number(settings().birthday?.remindDaysBefore || 7), opts);

  return `
  ${pageHead({
    title: '生日表',
    sub: `旅團團員生日一覽 · 生日前 ${settings().birthday?.remindDaysBefore || 7} 日自動提示`,
    actions: `
      <button class="btn btn-sm" data-act="exp-bday-word">${icon('download', 15)} Word</button>
      <button class="btn btn-sm" data-act="exp-bday-pdf">${icon('print', 15)} PDF</button>
      <button class="btn btn-sm" data-act="exp-bday-csv">${icon('download', 15)} CSV</button>
      <button class="btn btn-sm" data-act="exp-bday-ics">${icon('calendar', 15)} 匯入日曆（.ics）</button>`
  })}

  ${next7.length ? `<div class="card mb-16">${noteBox(`<b>${next7.length} 位</b>團員生日快到：` +
    next7.map(x => `${esc(x.name)}（${x.days === 0 ? '今日' : x.days + ' 日後'}，${Number(x.md.slice(0, 2))} 月 ${Number(x.md.slice(3))} 日${x.turning ? ` 將滿 ${x.turning} 歲` : ''}）`).join('、'), 'warn')}</div>` : ''}

  ${chipbar(monthNames.map((n, i) => [String(i + 1), n, birthdaysThisMonth(i + 1, opts).length]),
    String(bdayMonth), 'data-month')}

  <div class="card mt-16">
    <div class="card-head">
      <div><div class="card-title">${monthNames[bdayMonth - 1]}生日團員</div>
        <div class="card-sub">${list.length} 位</div></div>
    </div>
    <div>
      ${list.length ? list.map(x => {
        const m = x.member;
        return `<div class="bday ${x.days === 0 ? 'today' : ''}" style="cursor:pointer" data-open="${m.id}">
          <span class="cake">${icon('sparkle', 16)}</span>
          <div class="grow">
            <div class="semibold sm">${esc(m.name)} <span class="faint xs">${esc(m.role || '')}</span></div>
            <div class="xs faint">${Number(x.md.slice(0, 2))} 月 ${Number(x.md.slice(3))} 日${x.turning ? ` · 將滿 ${x.turning} 歲` : x.age !== null ? ` · ${x.age} 歲` : ''}${m.phone ? ` · ${esc(m.phone)}` : ''}</div>
          </div>
          <div class="when sm ${x.days <= 7 ? '' : 'faint'}" style="font-weight:700;color:${x.days === 0 ? 'var(--accent-700)' : x.days <= 7 ? 'var(--warn)' : 'var(--muted)'}">
            ${x.days === 0 ? '🎂 今日' : x.days + ' 日後'}
          </div>
        </div>`;
      }).join('') : empty('sparkle', `${monthNames[bdayMonth - 1]}冇團員生日`)}
    </div>
  </div>

  <div class="card mt-16">
    <div class="card-head"><div><div class="card-title">全年生日表</div>
      <div class="card-sub">可以列印出嚟貼喺旅部</div></div></div>
    <div class="scroll-x">
      <table class="table table-compact">
        <thead><tr><th>月份</th><th>團員</th><th class="center">日期</th><th class="center">年齡</th></tr></thead>
        <tbody>
          ${monthNames.map((n, i) => {
            const rows = birthdaysThisMonth(i + 1, opts);
            return `<tr>
              <td class="semibold">${n}</td>
              <td>${rows.map(x => esc(x.name)).join('、') || '<span class="faint">—</span>'}</td>
              <td class="center mono">${rows.map(x => `${Number(x.md.slice(0, 2))}/${Number(x.md.slice(3))}`).join('、') || '<span class="faint">—</span>'}</td>
              <td class="center mono">${rows.map(x => (turningAge(x.member.birthday) ?? '—')).join('、')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ============================================================
   個人紀錄
   ============================================================ */
function detail(id) {
  const m = member(id);
  if (!m) return `<div class="card">${empty('users', '搵唔到呢位團員')}</div>`;
  const s = attendanceStats(m.id);
  const myFees = fees().filter(f => f.memberId === id);
  const doneMeetings = collection('meetings').filter(x => x.status === 'done');
  const myLoans = collection('invLoans').filter(l => l.borrowerId === id || l.borrowerName === m.name);
  const dLeft = daysUntilBirthday(m.birthday);

  return `
  ${pageHead({
    title: m.name,
    sub: `${identityLabel(m)}${m.role ? ' · ' + m.role : ''}${m.eng ? ' · ' + m.eng : ''} · ${memberStatus()[m.status]?.l || ''}`,
    actions: `
      <button class="btn btn-sm" data-go="#/members">${icon('chevronL', 15)} 返回名冊</button>
      ${identityOf(m) === 'member'
        ? (can('member.edit') ? `<button class="btn btn-sm" data-act="open-hub" data-id="${m.id}">${icon('key', 15)} 開戶（首次密碼 ${TEMP_PASSWORD}）</button>` : '')
        : (canChangePasswordOf('member:' + m.id) ? `<button class="btn btn-sm" data-act="set-pw" data-id="${m.id}">${icon('key', 15)} 設定密碼</button>` : '')}
      ${can('member.edit') ? `<button class="btn btn-sm btn-primary" data-act="edit" data-id="${m.id}">${icon('edit', 15)} 編輯</button>` : ''}
      ${can('admin.chief') && identityOf(m) !== 'chief'
        ? `<button class="btn btn-sm" data-act="make-chief" data-id="${m.id}">${icon('sparkle', 15)} 設為團長（轉移）</button>` : ''}`
  })}

  ${dLeft !== null && dLeft <= (settings().birthday?.remindDaysBefore || 7) ? noteBox(
    dLeft === 0 ? `🎂 今日係 ${esc(m.name)} 生日！` : `🎂 ${esc(m.name)} ${dLeft} 日後生日（${memberBirthdayText(m)}${turningAge(m.birthday) ? `，將滿 ${turningAge(m.birthday)} 歲` : ''}）`, 'warn') + '<div class="mb-16"></div>' : ''}

  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">基本資料</div></div>
        <div style="padding:18px">
          ${kv([
            ['姓名', `<b>${esc(m.name)}</b>`],
            ['身份', `<span class="badge ${IDENTITIES[identityOf(m)].c}"><span class="dot"></span>${esc(identityLabel(m))}</span>`],
            ['英文名', esc(m.eng || '—')],
            ['會籍編號（YMIS）', m.ymis
              ? `<span class="semibold" style="font-family:var(--mono)">${esc(m.ymis)}</span> <span class="tag brand">可對應進度系統</span>`
              : (expectedKeyKind(m) === 'ymis'
                ? '<span style="color:var(--warn)">未填 —— 團員／執委要有 YMIS 先可以同進度系統對上</span>'
                : '<span class="faint">領袖用 Email 對應，YMIS 可以留空</span>')],
            ['系統 ID', `<span class="xs faint" style="font-family:var(--mono)">${esc(m.systemId || '—')}</span>`],
            ['生日', `${esc(memberBirthdayText(m))}${ageFrom(m.birthday) !== null ? ` · ${ageFrom(m.birthday)} 歲` : ''}`],
            ['職位', esc(m.role || '—')],
            ['聯絡電話', esc(m.phone || '—')],
            ['電郵', esc(m.email || '—')],
            ['入團日期', esc(m.join || '—')],
            ['標籤', (m.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'],
            ['狀態', `<span class="badge ${memberStatus()[m.status]?.c || 'b-grey'}">${memberStatus()[m.status]?.l || m.status}</span>`],
            ['團費', feeExempt(m)
              ? `<span class="badge b-grey">免收團費</span> <span class="xs faint">${identityOf(m) === 'leader' ? '（領袖唔收團費）' : '（已設定免收）'}</span>`
              : '<span class="sm">需繳交</span>'],
            ['備註', esc(m.note || '—')]
          ])}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">出席紀錄</div>
          <div class="card-sub">出席 ${s.present} · 遲到 ${s.late} · 請假 ${s.apology} · 缺席 ${s.absent}</div></div>
          <span class="badge ${s.rate >= 80 ? 'b-ok' : s.rate >= 50 ? 'b-warn' : 'b-danger'}">${s.rate}%</span></div>
        <div>
          ${doneMeetings.length ? doneMeetings.map(mt => {
            const a = (mt.attendance || {})[id];
            const label = { present: ['出席', 'b-ok'], late: ['遲到', 'b-warn'], apology: ['請假', 'b-info'], absent: ['缺席', 'b-danger'] }[a] || ['未記錄', 'b-grey'];
            return `<div class="list-item" data-go="#/meetings/${mt.id}">
              <div class="li-main"><div class="li-t">${esc(mt.title)}</div>
                <div class="li-s mono">${esc(mt.date)}</div></div>
              <span class="badge ${label[1]}">${label[0]}</span></div>`;
          }).join('') : empty('calendar', '暫無會議紀錄')}
        </div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">收費紀錄</div>
          <div class="card-sub">${myFees.filter(f => f.paid).length}/${myFees.length} 已收</div></div>
        <div>${myFees.length ? myFees.map(f => `
          <div class="list-item">
            <div class="li-main"><div class="li-t">${esc(f.label || f.period || '團費')}</div>
              <div class="li-s">${money(f.amount)}${f.due ? ` · 到期 ${esc(f.due)}` : ''}${f.paidDate ? ` · 已收 ${esc(f.paidDate)}` : ''}</div></div>
            ${f.paid ? `<span class="badge b-ok"><span class="dot"></span>已收</span>`
              : can('fee.mark') ? `<button class="btn btn-xs" data-act="mark-fee" data-id="${f.id}">標記已收</button>`
              : `<span class="badge b-danger">未收</span>`}
          </div>`).join('') : empty('wallet', '暫無收費紀錄')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">物資借用</div></div>
        <div>${myLoans.length ? myLoans.slice(0, 6).map(l => {
          const item = find('invItems', l.itemId);
          return `<div class="list-item" data-go="#/inventory/loans">
            <div class="li-main"><div class="li-t">${esc(item?.name || '物資')} ×${l.qty}</div>
              <div class="li-s">${esc(l.outDate || '')} → ${esc(l.dueDate || '')}</div></div>
            <span class="badge b-grey">${esc(l.status)}</span></div>`;
        }).join('') : empty('grid', '暫無借用紀錄')}
        </div>
      </div>

      ${can('member.note') ? `<div class="card">
        <div class="card-head"><div class="card-title">領袖備註</div></div>
        <div style="padding:16px 18px">
          <textarea class="textarea" id="noteBox" placeholder="例：本年負責先鋒工程訓練，10 月需覆誓…">${esc(m.note || '')}</textarea>
          <button class="btn btn-sm btn-primary btn-block mt-12" data-act="save-note" data-id="${m.id}">${icon('save', 15)} 儲存備註</button>
        </div>
      </div>` : ''}

      ${can('member.delete') ? `<button class="btn btn-danger btn-block" data-act="del" data-id="${m.id}">${icon('trash', 15)} 刪除此用戶</button>` : ''}
    </div>
  </div>`;
}

/* ============================================================
   編輯
   ============================================================ */
function editor(id) {
  const m = id ? member(id) : null;
  const ident = m ? identityOf(m) : 'member';
  return `
  ${pageHead({ title: m ? `編輯：${m.name}` : '新增用戶',
    sub: '身份（團長 / 領袖 / 執委 / 團員）同資料都可以改；改身份＝改權限；生日可以只填月日（例：03-26）',
    actions: `<button class="btn btn-sm" data-act="cancel">${icon('chevronL', 15)} 取消</button>` })}
  ${draftBanner('member', id || 'new', '用戶資料')}
  <div class="card" style="max-width:760px">
    <div style="padding:20px">
      <div class="grid g-2" style="gap:14px">
        <div class="field"><label class="label">姓名 <span class="req">*</span></label>
          <input class="input" id="f-name" data-draft="name" value="${esc(m?.name || '')}" placeholder="例：陳大文"></div>
        <div class="field"><label class="label">身份 <span class="req">*</span></label>
          ${can('member.identity') ? `<select class="select" id="f-identity" data-draft="identity" ${ident === 'chief' ? 'disabled' : ''}>
            ${Object.entries(IDENTITIES).map(([k, v]) => (k === 'chief' && !can('admin.chief') ? '' : `<option value="${k}" ${ident === k ? 'selected' : ''}>${v.l}</option>`)).join('')}
          </select>` : `<input class="input" value="${esc(identityLabel(m || { identity: 'member' }))}" readonly style="background:var(--bg-2)">`}
          <div class="hint">${ident === 'chief'
            ? '團長身份唔可以用下拉改 —— 要交棒：去下一位嘅用戶頁撳「設為團長（轉移）」。'
            : can('member.identity')
              ? '身份＝權限：團長（每團一位）／領袖／執委／團員。換屆改身份就得，唔使開新帳戶。'
              : '你（執委）可以改資料，但改身份要由團長／領袖處理。'}</div></div>
        <div class="field"><label class="label">英文名</label>
          <input class="input" id="f-eng" data-draft="eng" value="${esc(m?.eng || '')}" placeholder="例：Chan Tai Man"></div>
        <div class="field"><label class="label">會籍編號（YMIS）</label>
          <input class="input" id="f-ymis" data-draft="ymis" value="${esc(m?.ymis || '')}" placeholder="同進度追蹤系統一樣嗰個">
          <div class="hint">團員入口登入用（YMIS＋密碼）。同進度系統同一個編號。</div></div>
        <div class="field"><label class="label">團員入口密碼</label>
          <input class="input" id="f-hubpw" type="text" autocomplete="new-password" placeholder="${m?.hubPw?.hash || m?.hubPassword ? '已設定 —— 留空＝唔改' : `留空＝預設 ${TEMP_PASSWORD}`}">
          <div class="hint">${m?.hubPw?.hash || m?.hubPassword ? `已有密碼${m.hubPwUpdatedAt ? `（${esc(m.hubPwUpdatedAt)}）` : ''}。` : `未設就用預設 ${TEMP_PASSWORD}，首次登入要改。`}<b>呢個就係佢本人嘅登入密碼</b>（所有人同一個入口：電郵／YMIS／自訂帳號 ＋ 呢個密碼）。<b>冇共用帳戶</b>。</div></div>
        <div class="field"><label class="label">系統 ID（自動產生，唔好改）</label>
          <input class="input" value="${esc(m?.systemId || '（儲存時自動產生）')}" readonly style="font-family:var(--mono);font-size:12px;background:var(--bg-2)">
          <div class="hint">冇 YMIS 時嘅 fallback；一旦產生就唔會再改。</div></div>
        <div class="field"><label class="label">職位（團內）</label>
          <input class="input" id="f-role" data-draft="role" value="${esc(m?.role || '')}" placeholder="例：主席 / 司庫 / 小隊長"></div>
        <div class="field"><label class="label">出生日期（生日）</label>
          <input class="input" id="f-birthday" data-draft="birthday" value="${esc(m?.birthday || '')}" placeholder="YYYY-MM-DD 或 MM-DD">
          <div class="hint">用嚟做生日提示同生日表；未確定年份可以只填 MM-DD。</div></div>
        <div class="field"><label class="label">電話</label>
          <input class="input" id="f-phone" data-draft="phone" value="${esc(m?.phone || '')}" placeholder="9xxx xxxx"></div>
        <div class="field"><label class="label">電郵（團長／領袖用呢個登入）</label>
          <input class="input" id="f-email" data-draft="email" value="${esc(m?.email || '')}"></div>
        <div class="field"><label class="label">自訂登入帳號（可選）</label>
          <input class="input" id="f-loginid" data-draft="loginId" value="${esc(m?.loginId || '')}" placeholder="冇電郵／YMIS 時嘅登入代號">
          <div class="hint">登入代號次序：電郵 → 自訂帳號 → YMIS。呢個係<b>個人</b>帳號，唔係共用帳號。</div></div>
        <div class="field"><label class="label">入團日期</label>
          <input class="input" id="f-join" data-draft="join" value="${esc(m?.join || '')}" placeholder="YYYY-MM-DD"></div>
        <div class="field"><label class="label">狀態</label>
          <select class="select" id="f-status" data-draft="status">
            ${Object.entries(memberStatus()).map(([k, v]) => `<option value="${k}" ${m?.status === k ? 'selected' : ''}>${v.l}</option>`).join('')}
          </select></div>
        <div class="field"><label class="label">標籤（用逗號分隔）</label>
          <input class="input" id="f-tags" data-draft="tags" value="${esc((m?.tags || []).join(', '))}" placeholder="執委會, 小隊"></div>
        <div class="field" style="grid-column:1/-1">
          <label class="check"><input type="checkbox" id="f-feeexempt" ${m?.feeExempt ? 'checked' : ''}> 免收團費</label>
          <div class="hint">
            <b>領袖一律免收團費</b>（身份 = 領袖嘅話，呢個剔唔剔都唔會出現在團費收款表）。
            呢個剔係畀其他情況用，例如榮譽會員、指導員、休假成員。
            如果某位領袖要交團費，喺 <code>data/units/&lt;旅團&gt;/members.json</code> 該成員加 <code>"feeExempt": false</code>。
          </div></div>
      </div>
      <div class="field mt-16"><label class="label">備註</label>
        <textarea class="textarea" id="f-note" data-draft="note">${esc(m?.note || '')}</textarea></div>
      <div id="f-err" class="err mt-8"></div>
      <div class="hint mb-8" data-draft-stamp></div>
      <div class="row gap-8 wrap">
        <button class="btn btn-primary" data-act="save" data-id="${id || ''}">${icon('save', 16)} ${m ? '儲存' : '新增用戶'}</button>
        <button class="btn" data-act="cancel">${icon('x', 16)} 取消</button>
      </div>
      <div class="hint mt-8">未撳「儲存」之前，改動只係暫存喺呢部裝置（瀏覽器），唔會寫入資料庫，更唔會送去總表。</div>
    </div>
  </div>`;
}

/* ============================================================
   輸出
   ============================================================ */
function exportRosterCSV() {
  const headers = ['姓名', '英文名', '身份', '職位', '生日', '年齡', '電話', '電郵', '入團日期', '狀態', '標籤', '備註'];
  const rows = members().map(m => [
    m.name, m.eng || '', identityLabel(m), m.role || '', m.birthday || '', ageFrom(m.birthday) ?? '',
    m.phone || '', m.email || '', m.join || '', memberStatus()[m.status]?.l || m.status,
    (m.tags || []).join(' '), m.note || ''
  ]);
  toCSV({ filename: `用戶名冊_${stamp()}.csv`, headers, rows });
}

function rosterWord() {
  const rows = members().map(m => `<tr>
    <td>${esc(m.name)}</td><td>${esc(identityLabel(m))}</td><td>${esc(m.role || '')}</td>
    <td>${esc(m.birthday || '')}</td><td class="num">${ageFrom(m.birthday) ?? ''}</td>
    <td>${esc(m.phone || '')}</td><td>${esc(m.join || '')}</td>
    <td>${esc(memberStatus()[m.status]?.l || '')}</td></tr>`).join('');
  const all = members();
  const cnt = k => all.filter(m => identityOf(m) === k).length;
  toWord({
    filename: `用戶名冊_${stamp()}.doc`,
    title: '用戶名冊',
    org: profile().name,
    bodyHtml: `<div class="doc-head"><div class="doc-title">用戶名冊</div>
      <div class="doc-sub">${esc(profile().name || '')} · 共 ${all.length} 位（團長 ${cnt('chief')} · 領袖 ${cnt('leader')} · 執委 ${cnt('exco')} · 團員 ${cnt('member')}）· 列印日期 ${todayISO()}</div></div>
      <table><thead><tr><th>姓名</th><th>身份</th><th>職位</th><th>出生日期</th><th class="num">年齡</th><th>電話</th><th>入團</th><th>狀態</th></tr></thead>
      <tbody>${rows}</tbody></table>`
  });
}

function birthdayTableHtml(title = '團員生日表') {
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const all = birthdayList();
  return `
  <div class="doc-head"><div class="doc-title">${esc(title)}</div>
    <div class="doc-sub">${esc(profile().name || '')} · 更新日期 ${todayISO()}</div></div>
  <table>
    <thead><tr><th style="width:70pt">月份</th><th>團員</th><th style="width:70pt" class="num">日期</th><th style="width:56pt" class="num">將滿</th></tr></thead>
    <tbody>
      ${monthNames.map((n, i) => {
        const rows = birthdaysThisMonth(i + 1);
        if (!rows.length) return '';
        return `<tr><td>${n}</td>
          <td>${rows.map(x => esc(x.name) + (x.member.role ? `（${esc(x.member.role)}）` : '')).join('、')}</td>
          <td class="num">${rows.map(x => `${Number(x.md.slice(0, 2))}/${Number(x.md.slice(3))}`).join('<br>')}</td>
          <td class="num">${rows.map(x => turningAge(x.member.birthday) ?? '—').join('<br>')}</td></tr>`;
      }).join('')}
    </tbody>
  </table>
  <p class="note">提示：生日前 ${settings().birthday?.remindDaysBefore || 7} 日系統會自動提醒。${all.filter(x => !parseBirthday(x.member.birthday)?.hasYear).length ? '部分團員未填出生年份，年齡欄以「—」顯示。' : ''}</p>`;
}

function exportBirthdayWord() {
  toWord({ filename: `團員生日表_${stamp()}.doc`, title: '團員生日表', org: profile().name, bodyHtml: birthdayTableHtml() });
}
function exportBirthdayPdf() {
  printDoc({ title: '團員生日表', org: profile().name, bodyHtml: birthdayTableHtml() });
}
function exportBirthdayCSV() {
  toCSV({
    filename: `團員生日表_${stamp()}.csv`,
    headers: ['月份', '姓名', '生日', '出生年份', '將滿歲數', '職位', '電話'],
    rows: birthdayList().map(x => [
      Number(x.md.slice(0, 2)), x.name, x.md, parseBirthday(x.birthday).hasYear ? parseBirthday(x.birthday).y : '',
      turningAge(x.member.birthday) ?? '', x.member.role || '', x.member.phone || ''
    ])
  });
}
/** 匯出 .ics（可加入 Google Calendar / iPhone 日曆，每年重複） */
function exportBirthdayIcs() {
  const y = new Date().getFullYear();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//82venture//Birthdays//ZH-HK', 'CALSCALE:GREGORIAN'
  ];
  birthdayList().forEach(x => {
    const p = parseBirthday(x.birthday);
    const start = `${y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
    lines.push('BEGIN:VEVENT',
      `UID:${x.id}-birthday@82venture`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${start}`,
      'DURATION:P1D',
      'RRULE:FREQ=YEARLY',
      `SUMMARY:${x.name} 生日 🎂`,
      `DESCRIPTION:${profile().name || ''} 團員生日`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  dlFile(`團員生日_${stamp()}.ics`, lines.join('\r\n'), 'text/calendar;charset=utf-8');
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root, params = {}) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));

  root.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => { statusFilter = b.dataset.status; refresh(); }));
  root.querySelectorAll('[data-ident]').forEach(b => b.addEventListener('click', () => { idFilter = b.dataset.ident; refresh(); }));
  root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    go('#/members/edit/' + b.dataset.edit);
  }));

  /* 編輯器：草稿先暫存喺瀏覽器（防呆） */
  if (params.id === 'edit' || params.id === 'new') {
    const draftId = params.action || 'new';
    bindDraftAutosave(root, 'member', draftId);
    root.querySelector('[data-draft-restore]')?.addEventListener('click', () => {
      applyDraft(root, 'member', draftId);
      toast('已還原暫存嘅內容', 'ok');
      root.querySelector('[data-draft-banner]')?.remove();
    });
    root.querySelector('[data-draft-discard]')?.addEventListener('click', () => {
      clearDraft('member', draftId);
      toast('已放棄暫存', 'ok');
      refresh();
    });
  }
  root.querySelectorAll('[data-month]').forEach(b => b.addEventListener('click', () => { bdayMonth = Number(b.dataset.month); refresh(); }));
  const s = root.querySelector('#mSearch');
  if (s) {
    s.addEventListener('input', () => { kw = s.value; clearTimeout(s._t); s._t = setTimeout(() => { const p = s.selectionStart; refresh(); const n = document.querySelector('#mSearch'); if (n) { n.focus(); n.setSelectionRange(p, p); } }, 220); });
  }
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    go('#/members/' + el.dataset.open);
  }));

  root.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', async () => {
    const act = el.dataset.act;
    const id = el.dataset.id;

    if (act === 'new') return go('#/members/new');
    if (act === 'edit') return go('#/members/edit/' + id);
    if (act === 'cancel') return go('#/members');
    if (act === 'exp-csv') { exportRosterCSV(); toast('已匯出 CSV', 'ok'); }
    if (act === 'exp-word') { rosterWord(); toast('已輸出 Word（.doc）', 'ok'); }
    if (act === 'exp-bday') return go('#/members/birthdays');
    if (act === 'exp-bday-word') { exportBirthdayWord(); toast('已輸出 Word', 'ok'); }
    if (act === 'exp-bday-pdf') { exportBirthdayPdf(); toast('已開啟列印，可另存為 PDF', 'ok'); }
    if (act === 'exp-bday-csv') { exportBirthdayCSV(); toast('已匯出 CSV', 'ok'); }
    if (act === 'exp-bday-ics') { exportBirthdayIcs(); toast('已匯出 .ics 日曆檔', 'ok'); }

    if (act === 'save') {
      const v = k => root.querySelector(k)?.value.trim() || '';
      const name = v('#f-name');
      const birthday = v('#f-birthday');
      const err = root.querySelector('#f-err');
      if (!name) { err.textContent = '請填姓名'; err.style.display = 'block'; return; }
      if (!isValidBirthday(birthday)) { err.textContent = '生日格式唔正確（例：2010-03-26 或 03-26）'; err.style.display = 'block'; return; }
      const identityField = root.querySelector('#f-identity');
      const wantIdentity = identityField?.value || (id ? identityOf(member(id)) : 'member');
      const patch = {
        name, birthday, eng: v('#f-eng'), role: v('#f-role'), phone: v('#f-phone'), email: v('#f-email'),
        ymis: v('#f-ymis'),
        loginId: v('#f-loginid'),
        join: v('#f-join'), status: root.querySelector('#f-status').value,
        tags: v('#f-tags').split(',').map(x => x.trim()).filter(Boolean), note: v('#f-note')
      };
      /* 免收團費：有剔 = true；冇剔 = 移除欄位（回到「領袖自動免收 / 其他人要交」嘅預設） */
      if (root.querySelector('#f-feeexempt')?.checked) patch.feeExempt = true;
      else delete patch.feeExempt;
      /* 同名防呆：唔好一時手誤開多一個同一個人 */
      const dup = members().find(m => m.id !== id && String(m.name).trim() === name);
      if (dup && !(await confirmDlg({
        title: '已經有同名用戶', okText: '照樣儲存',
        message: `名冊入面已經有 <b>${esc(name)}</b>（${esc(identityLabel(dup))}）。如果係同一個人，請返回改用「編輯」。`
      }))) return;

      if (id) {
        const before = { ...member(id) };
        update('members', id, patch);
        /* ★ 身份＝權限：一律經 setMemberIdentity（佢會守住「團長只有一位」「唔可以改自己」呢啲規則） */
        if (can('member.identity') && identityField && !identityField.disabled && wantIdentity !== before.identity) {
          const idRes = await setMemberIdentity(id, wantIdentity);
          if (!idRes.ok) {
            update('members', id, { identity: before.identity });
            err.textContent = idRes.msg; err.style.display = 'block'; return;
          }
        }
        clearDraft('member', id);
        toast(`已儲存 ${name}（${identityLabel(member(id))}）`, 'ok');
        const hubPw = v('#f-hubpw');
        if (hubPw) {
          const pwRes = await setMemberHubPassword(id, hubPw);
          if (!pwRes.ok) toast(pwRes.msg, 'err');
        }
        undoable('（可以撳「還原」復原今次改動）', () => { update('members', id, before); refresh(); });
        go('#/members/' + id);
      } else {
        const nid = uid('m');
        const rec = add('members', { ...patch, id: nid, systemId: newSystemId(load().unitCode, nid) });
        clearDraft('member', 'new');
        const hubPw = v('#f-hubpw');
        if (hubPw) {
          const pwRes = await setMemberHubPassword(rec.id, hubPw);
          if (!pwRes.ok) toast(pwRes.msg, 'err');
        }
        /* 新增：身份唔可以直接落 chief（團長要轉移／認領）—— 如果冇 chief 而設定者
           有 admin.chief 權，就用 setMemberIdentity 行同一條安全路。 */
        if (wantIdentity === 'chief') {
          const cr = await setMemberIdentity(rec.id, 'chief');
          if (!cr.ok) { update('members', rec.id, { identity: 'member' }); toast(cr.msg, 'err'); }
        }
        toast(`已新增 ${name}（${identityLabel(member(rec.id))}）`, 'ok');
        go('#/members/' + rec.id);
      }
    }

    /* ★ 開戶嗰個 = 團長：冇團長嘅話可以認領（用戶頁橫額） */
    if (act === 'claim-chief') {
      const me = current()?.memberId ? member(current().memberId) : null;
      const r = await modal({
        title: '認領團長身份',
        sub: '每個旅團永遠只有一位團長（最高權限，可以轉移）',
        body: me
          ? `<p class="sm">你係 <b>${esc(me.name)}</b>。確定之後你就係團長。</p>`
          : `<div class="field"><label class="label">姓名</label><input class="input" id="ccName"></div>
             <div class="field mt-12"><label class="label">電郵（之後用呢個登入）</label><input class="input" id="ccEmail" type="email"></div>`,
        actions: [
          { label: '取消', class: 'btn', value: null },
          { label: '確定', class: 'btn-primary', onClick: el => {
            if (me) return { name: me.name };
            const name = el.querySelector('#ccName')?.value.trim() || '';
            if (!name) return false;
            return { name, email: el.querySelector('#ccEmail')?.value.trim() || '' };
          } }
        ]
      });
      if (r) {
        const res = await claimChief(me ? { name: me.name } : r);
        toast(res.ok ? '已設定團長身份' : res.msg, res.ok ? 'ok' : 'err');
        refresh();
      }
      return;
    }

    /* ★ 轉移團長身份（現任團長交棒） */
    if (act === 'make-chief') {
      const m = member(id);
      if (!m) return;
      const cur = chief();
      const okGo = await confirmDlg({
        title: '轉移團長身份', okText: '確定轉移',
        message: `將團長身份轉移畀 <b>${esc(m.name)}</b>？` +
          (cur ? `<br>${esc(cur.name)} 會變返「領袖」。` : '') +
          '<br><span class="xs faint">團長係最高權限（可以改任何身份、改任何密碼）。轉移之後你嘅身份即刻改變。</span>'
      });
      if (!okGo) return;
      const res = await setMemberIdentity(id, 'chief');
      toast(res.ok ? `已將團長身份轉移畀 ${m.name}` : res.msg, res.ok ? 'ok' : 'err');
      refresh();
      return;
    }

    /* 設定入面嗰個入口密碼（團長／領袖可以幫人設） */
    if (act === 'set-pw') {
      const m = member(id);
      if (!m) return;
      const r = await modal({
        title: `設定密碼：${m.name}`,
        sub: '設定之後即刻生效（唔使等儲存到後端）',
        body: `<div class="field"><label class="label">新密碼（最少 4 個字）</label>
            <input class="input" id="sp1" type="password" autocomplete="new-password"></div>
          <div class="field mt-12"><label class="label">再輸入一次</label>
            <input class="input" id="sp2" type="password" autocomplete="new-password"></div>
          <div id="spErr" class="err mt-8"></div>
          <div class="hint mt-8">留空＝維持不變。</div>`,
        actions: [
          { label: '取消', class: 'btn', value: null },
          { label: '儲存', class: 'btn-primary', onClick: el => {
            const p1 = el.querySelector('#sp1').value, p2 = el.querySelector('#sp2').value;
            const box = el.querySelector('#spErr');
            if (!p1) { box.textContent = '請輸入新密碼'; box.style.display = 'block'; return false; }
            if (p1.length < 4) { box.textContent = '最少 4 個字'; box.style.display = 'block'; return false; }
            if (p1 !== p2) { box.textContent = '兩次輸入唔一樣'; box.style.display = 'block'; return false; }
            return p1;
          } }
        ]
      });
      if (r) {
        const res = await setMemberHubPassword(id, r);
        toast(res.ok ? '密碼已設定' : res.msg, res.ok ? 'ok' : 'err');
      }
      return;
    }

    if (act === 'open-hub') {
      const res = await openMemberAccount(id);
      toast(res.ok ? `已開戶：首次密碼 ${TEMP_PASSWORD}（登入後要改）` : res.msg, res.ok ? 'ok' : 'err');
      refresh();
      return;
    }

    if (act === 'bulk-open') {
      const list = members().filter(m => m.status !== 'alumni' && !m.hubPw?.hash && !m.hubPassword);
      if (!list.length) { toast('全部人都已經開咗戶', 'ok'); return; }
      const okGo = await confirmDlg({
        title: '批量開戶', okText: `為 ${list.length} 位開戶`,
        message: `會為 <b>${list.length}</b> 位未開戶嘅人設首次密碼 <b>${TEMP_PASSWORD}</b>（首次登入要改）。`
      });
      if (!okGo) return;
      let n = 0;
      for (const m of list) { const r = await openMemberAccount(m.id); if (r.ok) n++; }
      toast(`已為 ${n} 位開戶（首次密碼 ${TEMP_PASSWORD}）`, 'ok');
      refresh();
      return;
    }

    if (act === 'approve-app' || act === 'reject-app') {
      const res = await reviewAccountApp(id, { decision: act === 'approve-app' ? 'approved' : 'rejected', reviewer: displayName() });
      toast(res.ok ? '已處理開戶申請' : res.msg, res.ok ? 'ok' : 'err');
      refresh();
      return;
    }

    if (act === 'save-note') {
      update('members', id, { note: root.querySelector('#noteBox').value });
      toast('備註已儲存', 'ok'); refresh();
    }

    if (act === 'mark-fee') {
      update('fees', id, { paid: true, paidDate: todayISO(), method: '（由團員頁標記）' });
      toast('已標記收款', 'ok'); refresh();
    }

    if (act === 'del') {
      const m = member(id);
      if (!m) return;
      const okDel = await confirmDanger({
        title: '刪除用戶', okText: '確定刪除', requireText: m.name,
        message: `確定刪除 <b>${esc(m.name)}</b>（${esc(identityLabel(m))}）？<br>
          佢嘅出席紀錄會保留但名字會顯示為「—」。<br>
          <span class="xs faint">刪除只會改呢部裝置嘅資料庫；已經同步咗去總表嘅資料要另外處理。</span>`
      });
      if (!okDel) return;
      const snapshot = { ...m };
      const idx = Math.max(0, members().findIndex(x => x.id === id));
      remove('members', id);
      clearDraft('member', id);
      undoable(`已刪除 ${m.name}`, () => {
        const list = collection('members');
        list.splice(Math.min(idx, list.length), 0, snapshot);
        commit(); refresh();
      });
      go('#/members');
    }
  }));
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
