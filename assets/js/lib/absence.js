/* ============================================================
   absence.js — 電子請假表（團員自己交 → 領袖／執委覆核）
   ------------------------------------------------------------
   背景（2026-09-26 團長）：參考 XVHK PORTAL 嘅 e-Absence Forms，
   補足本系統請假散落各處（會議請假／通告回覆都有，但冇一張集中嘅請假單）。

   設計：
   · 團員喺**團員入口**（members.html → 我的請假）自己填：
       每日日期 ＋ 時段（全日／上午／下午／晚上）＋ 原因 ＋（可選）出席 / 補課。
   · 請假單只本地寫 `db.absences`（跟「儲存到後端」一齊上後端、換機都留得返，
       三向合併同其他集合一樣；呢處唔逐張打後端 —— 免得動 Code.gs schema）。
   · 領袖／執委喺**管理系統 → 行事曆 → 請假**覆核：接受／拒絕＋備註。
   · 團員身份唔曝露：單上只存 memberId；團員入口只顯示自己啲單。
   · 就咁「唔嚟」遊走喺啲缺勤數字，會唔會都入統計 → 覆核通過先計做「會缺席」。
   ============================================================ */

import { collection, add, update, remove, currentUnit } from './store.js';
import { uid, todayISO } from './util.js';

export const ABSENCE_STATUS = {
  pending:  { label: '待覆核',   cls: 'b-warn' },
  approved: { label: '已接受',   cls: 'b-ok'   },
  rejected: { label: '已拒絕',   cls: 'b-danger' }
};

/** 時段選項（同童子軍一排排、唔使 feel 到「成日唔在場」） */
export const ABSENCE_SLOTS = [
  { id: 'full',   label: '全日' },
  { id: 'am',     label: '上午' },
  { id: 'pm',     label: '下午' },
  { id: 'evening', label: '晚上' }
];

const slotLabel = (s) => (ABSENCE_SLOTS.find(x => x.id === s) || {}).label || (s || '全日');

/** 呢位團員嘅請假單（memberId 兜底 → ymis 兜底） */
export function absencesOf(memberId, ymis) {
  const id = String(memberId || '');
  const y = String(ymis || '');
  return collection('absences').filter(a => {
    if (id && String(a.memberId) === id) return true;
    if (y && String(a.ymis) === y) return true;
    return false;
  });
}

/** 全部請假單（按日期倒序） */
export function allAbsences() {
  return collection('absences').slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/** 覆核統計（按狀態數） */
export function absenceCounts() {
  const n = { pending: 0, approved: 0, rejected: 0, total: 0 };
  collection('absences').forEach(a => {
    n.total += 1;
    const k = a.status === 'approved' ? 'approved' : a.status === 'rejected' ? 'rejected' : 'pending';
    n[k] += 1;
  });
  return n;
}

/** 團員交一張請假（單喺自己部機，即刻落本機，跟同步上後端） */
export function submitAbsence({ memberId = '', ymis = '', date = '', slot = '', reason = '', plan = '' } = {}) {
  const errors = [];
  const d = String(date || '').trim();
  const r = String(reason || '').trim();
  if (!d) errors.push('請揀日子');
  if (!r) errors.push('請寫低原因');
  if (r.length > 2000) errors.push('原因太長（最多 2000 字）');
  if (d && d < todayISO()) errors.push('請假唔可以揀過咗嘅日子');
  if (errors.length) return { ok: false, errors };

  const rec = add('absences', {
    id: 'ab_' + uid(),
    at: new Date().toISOString(),
    unit: currentUnit(),
    memberId: String(memberId || ''),
    ymis: String(ymis || ''),
    date: d,
    slot: String(slot || 'full'),
    reason: r.slice(0, 2000),
    plan: String(plan || '').trim().slice(0, 500),
    status: 'pending',
    reviewedBy: '',
    reviewedAt: '',
    reviewNote: ''
  });
  return { ok: true, record: rec };
}

/** 領袖／執委覆核（接受／拒絕＋備註） */
export function reviewAbsence(id, { decision = 'approved', note = '', reviewer = '' } = {}) {
  const rec = collection('absences').find(x => x.id === id);
  if (!rec) return { ok: false, error: '搵唔到呢張請假單' };
  if (decision !== 'approved' && decision !== 'rejected') return { ok: false, error: '覆核決定唔啱' };
  update('absences', id, {
    status: decision,
    reviewedBy: String(reviewer || '').slice(0, 120),
    reviewedAt: new Date().toISOString(),
    reviewNote: String(note || '').trim().slice(0, 500)
  });
  return { ok: true, record: findOne(id) };
}

/** 團員取消自己一張仲未處理嘅請假 */
export function withdrawAbsence(id, memberId) {
  const rec = collection('absences').find(x => x.id === id);
  if (!rec) return { ok: false, error: '搵唔到呢張請假單' };
  if (String(rec.memberId) !== String(memberId)) return { ok: false, error: '呢張唔係你嘅請假單' };
  if (rec.status !== 'pending') return { ok: false, error: '已經處理咗，唔可以撤回' };
  remove('absences', id);
  return { ok: true };
}

/** 定期上限：例如 4 個禮拜內最多 8 單（防得一張接一張，唔想搞死啲安排） */
export function absenceLimits(list = collection('absences')) {
  const today = todayISO();
  return {
    recentDays: 28,
    recentCount: list.filter(a => a.date >= today).length,
    cap: 8
  };
}

/** 請假單一行（團員入口用，公仔 id 唔出真名之外） */
export function absenceLine(a, { memberName = '', showReviewer = false } = {}) {
  const st = ABSENCE_STATUS[a.status] || ABSENCE_STATUS.pending;
  const extra = [];
  if (memberName) extra.push(`<b>${memberName}</b>`);
  extra.push(`${a.date} · ${slotLabel(a.slot)}`);
  if (showReviewer && a.reviewedBy) extra.push(`覆核：${a.reviewedBy}`);
  return { st, extra };
}

/** 純文字版（輸出／抄送用） */
export function absenceText(a, { memberName = '' } = {}) {
  const st = (ABSENCE_STATUS[a.status] || ABSENCE_STATUS.pending).label;
  return [
    `【請假】${memberName ? memberName : '團員'}（${st}）`,
    `日子：${a.date}　時段：${slotLabel(a.slot)}`,
    `原因：${a.reason || '（冇寫）'}`,
    a.plan ? `補救／出席：${a.plan}` : '',
    a.reviewNote ? `覆核備註：${a.reviewNote}` : '',
    `交表：${a.at || ''}`
  ].filter(Boolean).join('\n');
}

function findOne(id) { return collection('absences').find(x => x.id === id) || null; }

/** CSV（管理系統輸出用；身份唔跟出去） */
export function absencesCsv(rosterNameOf = (mId) => '') {
  const head = ['日期', '時段', '團員', '狀態', '原因', '補救／出席', '覆核人', '覆核備註'];
  const rows = allAbsences().map(a => [
    a.date, slotLabel(a.slot), rosterNameOf(a.memberId), (ABSENCE_STATUS[a.status] || {}).label || '待覆核',
    a.reason || '', a.plan || '', a.reviewedBy || '', a.reviewNote || ''
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return [head.join(','), ...rows].join('\n');
}
