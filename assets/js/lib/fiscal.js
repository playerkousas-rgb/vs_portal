/* ============================================================
   fiscal.js — 兩個財政年度引擎（本系統嘅特色）

   1) 童軍／旅團財政年度：每年 4 月 1 日 至 翌年 3 月 31 日（例：2026-27）
   2) 旅（本團）財政年度：由當年 AGM 開始，至下一年 AGM 前一日
      （深資童軍團自務自治，多數喺暑假開 AGM，所以兩條數唔同）

   AGM 日期：settings.agmDates = [{year, date}]，冇設定就自動用
   「每年 8 月最後一個星期六」。
   ============================================================ */

import { pad2 } from './dates.js';

/* ---------- 小工具 ---------- */
function iso(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); }

export function daysInMonth(y, m) { return lastDayOfMonth(y, m); }

export function addDays(isoDate, n) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

export function lastSaturdayOfAugust(year) {
  const d = new Date(year, 7, 31);
  while (d.getDay() !== 6) d.setDate(d.getDate() - 1);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 取某年 AGM 日期（優先用設定，否則用 8 月最後一個星期六） */
export function agmOfYear(year, agmDates = []) {
  const hit = (agmDates || []).find(a => Number(a.year) === Number(year) && a.date);
  if (hit) return String(hit.date).slice(0, 10);
  return lastSaturdayOfAugust(year);
}

/** 該年 AGM 日期係唔係仲用緊預設（未由真人確認） */
export function agmIsDefault(year, agmDates = []) {
  const hit = (agmDates || []).find(a => Number(a.year) === Number(year) && a.date);
  if (!hit) return true;
  if (hit.default) return true;
  return /預設|未設定|待確認|未填/.test(String(hit.note || ''));
}

/** 建立／更新某年 AGM 記錄（回傳新嘅 agmDates 陣列） */
export function setAgmDate(agmDates, year, date, { note = '', isDefault = false } = {}) {
  const list = (agmDates || []).filter(a => Number(a.year) !== Number(year));
  if (date) list.push({ year: Number(year), date: String(date).slice(0, 10), note: note || (isDefault ? '預設（8 月最後一個星期六）' : '已確認'), default: !!isDefault });
  return list.filter(a => a.date).sort((a, b) => Number(a.year) - Number(b.year));
}

/* ---------- 1. 童軍／旅團財政年度 ---------- */
export function scoutFYStartYear(dateISO, startMonth = 4) {
  const [y, m] = String(dateISO).slice(0, 10).split('-').map(Number);
  return m >= startMonth ? y : y - 1;
}
export function scoutFYLabel(dateISO, startMonth = 4) {
  const y = scoutFYStartYear(dateISO, startMonth);
  return `${y}-${pad2((y + 1) % 100)}`;
}
export function scoutFYRange(label, startMonth = 4, startDay = 1) {
  const [a] = String(label).split('-');
  const y = Number(a);
  const endY = y + 1;
  const end = startMonth === 4 && startDay === 1 ? iso(endY, 3, 31) : addDays(iso(endY, startMonth, startDay), -1);
  const start = iso(y, startMonth, startDay);
  return {
    key: `${y}-${pad2(endY % 100)}`, start, end,
    title: `童軍財政年度 ${y}–${pad2(endY % 100)}`,
    sub: `${start.split('-').reverse().join('/')} – ${end.split('-').reverse().join('/')}`,
    kind: 'scout'
  };
}

/* ---------- 2. 旅（AGM）財政年度 ---------- */
/** 回傳某日期所屬嘅旅年度：{ key, start, end, agmYear } */
export function unitFYOf(dateISO, agmDates = []) {
  const [y, m, d] = String(dateISO).slice(0, 10).split('-').map(Number);
  const thisY = agmOfYear(y, agmDates);
  const useThis = String(dateISO).slice(0, 10) >= thisY;
  const agmYear = useThis ? y : y - 1;
  return unitFYRangeByYear(agmYear, agmDates);
}
export function unitFYRangeByYear(agmYear, agmDates = []) {
  const start = agmOfYear(agmYear, agmDates);
  const nextAGM = agmOfYear(agmYear + 1, agmDates);
  const end = addDays(nextAGM, -1);
  return {
    key: `${agmYear}-${pad2((agmYear + 1) % 100)}`,
    start, end, agmYear, nextAGM,
    title: `旅財政年度 ${agmYear}–${pad2((agmYear + 1) % 100)}`,
    sub: `AGM ${start.split('-').reverse().join('/')} – ${end.split('-').reverse().join('/')}（下屆 AGM ${nextAGM.split('-').reverse().join('/')}）`,
    kind: 'unit'
  };
}
export function unitFYLabel(dateISO, agmDates = []) { return unitFYOf(dateISO, agmDates).key; }
export function unitFYRange(label, agmDates = []) {
  const agmYear = Number(String(label).split('-')[0]);
  return unitFYRangeByYear(agmYear, agmDates);
}

/* ---------- 通用 ---------- */
export function inRange(dateISO, start, end) {
  const d = String(dateISO || '').slice(0, 10);
  return d >= start && d <= end;
}

export function summarize(list, range) {
  const rows = (list || []).filter(t => inRange(t.date, range.start, range.end));
  const income = rows.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount || 0), 0);
  const expense = rows.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount || 0), 0);
  return {
    income, expense, net: income - expense, count: rows.length, rows,
    byCategory: (type) => {
      const map = {};
      rows.filter(t => t.type === type).forEach(t => { const k = t.category || '其他'; map[k] = (map[k] || 0) + Number(t.amount || 0); });
      return Object.entries(map).sort((a, b) => b[1] - a[1]);
    },
    byMonth: (() => {
      const map = {};
      rows.forEach(t => {
        const k = String(t.date).slice(0, 7);
        map[k] = map[k] || { income: 0, expense: 0 };
        map[k][t.type] = (map[k][t.type] || 0) + Number(t.amount || 0);
      });
      return Object.keys(map).sort().map(k => ({ month: k, ...map[k], net: map[k].income - map[k].expense }));
    })()
  };
}

/** 列出所有出現過嘅年度（兩套制都列），由新到舊 */
export function listYears(transactions, settings = {}) {
  const startMonth = Number(settings.scoutFYStartMonth || 4);
  const agmDates = settings.agmDates || [];
  const dates = (transactions || []).map(t => String(t.date).slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) {
    const y = new Date().getFullYear();
    return {
      scout: [scoutFYRange(scoutFYLabel(`${y}-09-01`, startMonth), startMonth, Number(settings.scoutFYStartDay || 1))],
      unit: [unitFYRangeByYear(y, agmDates)]
    };
  }
  const scoutKeys = [...new Set(dates.map(d => scoutFYLabel(d, startMonth)))].sort().reverse();
  const unitKeys = [...new Set(dates.map(d => unitFYOf(d, agmDates).key))].sort().reverse();
  // 同時加入「而家」所屬年度，方便睇空白年度
  const now = iso(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
  const curScout = scoutFYLabel(now, startMonth);
  const curUnit = unitFYOf(now, agmDates).key;
  if (!scoutKeys.includes(curScout)) scoutKeys.unshift(curScout);
  if (!unitKeys.includes(curUnit)) unitKeys.unshift(curUnit);
  return {
    scout: scoutKeys.map(k => scoutFYRange(k, startMonth, Number(settings.scoutFYStartDay || 1))),
    unit: unitKeys.map(k => unitFYRange(k, agmDates))
  };
}

/** 過渡期提示：AGM 之後、3 月 31 日之前，兩個年度嘅期間會重疊 */
export function overlapNote(r1, r2) {
  const s = r1.start > r2.start ? r1.start : r2.start;
  const e = r1.end < r2.end ? r1.end : r2.end;
  return s <= e ? `兩段期間有重疊：${s} 至 ${e}` : '兩段期間沒有重疊';
}
