/* ============================================================
   progress.js — Progress（一個 Unified 後端、多個 client）
   ------------------------------------------------------------
   設計：
     · Progress 業務資料寫入旅團自己嘅 Google Sheet，由同一支 Unified Apps Script
       按 action 選取進度分頁。
     · 深資童軍管理系統與 BADGE 都只係呢個後端的 client。
     · 呢邊只做兩件事：讀後端（GET ?action=load）／寫後端（POST action=save）。
     · 固定使用旅團 Registry 已登記嘅同一 BACKEND／APIKEY；browser 冇第二套路線。
   設定：Vercel 只需 TROOP_<id>_NAME／BACKEND／APIKEY，與 BADGE 完全相同。
   安全：API Key 只留 server；瀏覽器只送 unit＋opaque session，不能改後端或冒充身份。
   ============================================================ */

import { load, getSession } from './store.js';
import { unitEntry } from './units.js';

/** 預設考核項目定義（app 內建，離線可用） */
export const DEFAULT_CATALOG_URL = 'data/progress/items.json';

/* ---------- 資料來源（browser 沒有後端／Key／catalog override） ---------- */
export function progressCfg(unitOverride = '') {
  const unit = unitOverride || load().unitCode || '';
  const serverSide = !!unitEntry(unit)?.progressServerSide;
  return {
    serverSide,
    /* 故意不把 /exec 或 API Key 放進 browser config。 */
    backend: '',
    apiKey: '',
    unit,
    name: '進度追蹤（同一個後端）',
    registered: serverSide
  };
}

export function progressConfigured() {
  return progressCfg().serverSide;
}

/** 同一旅團 BACKEND＋APIKEY 已由 server Registry 登記。 */
export function progressIsRegistered() {
  return progressCfg().registered === true;
}

/* ---------- 呼叫 /api/progress（同源） ---------- */
async function callApi(payload, { timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('./api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 唔係 JSON：多數係冇 API（純靜態伺服器） */ }
    if (!json) {
      return { ok: false, reason: 'no_api',
        error: '呢部伺服器冇 /api/progress（Progress 要經同源 server API 讀寫支部 Unified Sheet）。本機可以用 `npm run dev`，或在 Vercel 部署。' };
    }
    return json;
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'network',
      error: aborted ? 'Progress action 逾時（Unified GAS 冇回應）' : '本系統 API（/api/progress）暫時無法回應' };
  } finally {
    clearTimeout(timer);
  }
}

function sessionPayload(session = null) {
  const s = session || getSession() || {};
  return s.sessionToken ? { sessionToken: s.sessionToken } : {};
}
const cfgPayload = (session = null) => {
  const c = progressCfg();
  return { unit: c.unit, ...sessionPayload(session) };
};

/** 讀旅團後端全部進度資料（成員／進度／待批／其他獎章／活動履歷） */
export async function loadRemote() {
  return callApi({ ...cfgPayload(), action: 'load' });
}

/** 讀 app 內建考核項目定義（同源靜態檔，離線可用；不接受 remote override）。 */
export async function loadItems() {
  try {
    /* 內建考核項目係靜態檔（data/progress/items.json）：交畀 CDN cache（vercel.json /data/(.*)\.json） */
    const res = await fetch(DEFAULT_CATALOG_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    return { ok: true, local: true, data: json };
  } catch (e) {
    return { ok: false, reason: 'catalog_local_failed', error: '讀唔到內建考核項目（data/progress/items.json）' };
  }
}

/** 勾／取消勾進度 —— 直接寫入旅團自己嘅後端（同進度前端同一個 Sheet） */
export async function saveTicks(changes, confirmer = '') {
  return callApi({ ...cfgPayload(), action: 'save', data: { changes, confirmer } });
}

/** 其他獎章（服務／活動／訓練班 等） */
export async function saveOtherBadges(records) {
  return callApi({ ...cfgPayload(), action: 'saveOtherBadge', data: { records } });
}

/**
 * 審批中心：批／拒「待批完成」（團員申報嘅考核項目）
 * 批准＝寫入後端嘅「進度追蹤」，所有使用該分頁的 client 都即刻見到。
 */
export async function reviewRequest(requestId, { decision = 'approved', note = '', reviewer = '', confirmedDate = '' } = {}) {
  return callApi({ ...cfgPayload(), action: 'reviewRequest',
    data: { request_id: requestId, decision, review_note: note, reviewer,
      confirmed_date: confirmedDate } });
}

/** 審批中心：批／拒「待批履歷」（團員自行申報嘅活動／服務紀錄） */
export async function reviewLogRequest(requestId, { decision = 'approved', note = '', reviewer = '' } = {}) {
  return callApi({ ...cfgPayload(), action: 'reviewLogRequest',
    data: { request_id: requestId, decision, review_note: note, reviewer } });
}

/** 顯示用：遮一遮 /exec 嘅部署 ID（唔使成條長 URL 擺上螢幕） */
export function maskBackendUrl(u) {
  return String(u || '').replace(/\/macros\/s\/[^/]+/, '/macros/s/…');
}

/* ============================================================
   團員個人 BADGE bridge
   server 先用短期 session 對回本人 YMIS；瀏覽器送嘅 identity 欄位一律唔採用。
   myProgress 後端亦只回本人，唔會先把全團 load payload 轉到瀏覽器再篩。
   ============================================================ */
export async function loadMyProgress(session) {
  return callApi({ ...cfgPayload(session), action: 'myProgress' });
}

/** 申報完成：身份由 session 決定；req 只包含業務欄位。 */
export async function submitProgressRequest(req = {}, session = null) {
  return callApi({
    ...cfgPayload(session), action: 'addRequest',
    data: {
      item_id: String(req.item_id || ''), item_name: String(req.item_name || ''),
      requested_date: String(req.requested_date || ''), evidence: String(req.evidence || '')
    }
  });
}

/** 向後兼容獨立查詢；一樣由 session 決定本人，唔接受 ymis。 */
export async function loadMyRequests(session) {
  return callApi({ ...cfgPayload(session), action: 'myRequests' });
}

/* ============================================================
   項目目錄（items.json）
   ============================================================ */
/** 攤平成 { itemId: { id, name, badgeId, badgeName, segmentId, segmentName } } */
export function flattenItems(itemsJson) {
  const map = {};
  (itemsJson?.badges || []).forEach(b => {
    (b.segments || []).forEach(seg => {
      (seg.items || []).forEach(it => {
        map[it.id] = {
          id: it.id, name: it.name || it.id, en: it.en || '',
          badgeId: b.id, badgeName: b.name || b.id, badgeIcon: b.icon || '🏅', badgeColor: b.color || '',
          segmentId: seg.code, segmentName: seg.name || ''
        };
      });
    });
  });
  return map;
}

/* ============================================================
   進度統計
   ============================================================ */
/** 由 load 回應取出某人嘅進度 { itemId: {date, confirmer} } */
export function progressOf(data, ymis) {
  const p = data?.progress || {};
  return p[ymis] || null;
}

export function memberDoneCount(data, ymis) {
  const p = progressOf(data, ymis);
  return p ? Object.keys(p).length : 0;
}

/** 後端嘅成員（{ymis,name}）對應本系統名冊 */
export function matchLocalMember(members, remote) {
  const list = members || [];
  return list.find(m => m.ymis && String(m.ymis) === String(remote.ymis))
    || list.find(m => String(m.name || '').trim() && String(m.name).trim() === String(remote.name || '').trim())
    || null;
}

/**
 * 總覽統計
 * @param {object} data load 回應
 * @param {object} catalog flattenItems() 結果（可選，只影響「完成率」）
 * @param {number} totalItems 項目總數（冇 catalog 時用）
 */
function progressIgnoredSafe(m) {
  if (!m) return false;
  if (m.status === 'alumni') return true;
  if (m.identity === 'leader') return true;
  const t = `${m.role || ''} ${m.name || ''} ${(m.tags || []).join(' ')}`;
  return /管理員|超管|admin|系統管理員/i.test(t);
}
function remoteIsAdmin(m) {
  const t = `${m?.name || ''} ${m?.role || ''} ${m?.ymis || ''}`;
  return /管理員|超管|admin|系統管理員/i.test(t);
}

export function summarizeRemote(data, { catalog = null, roster = [] } = {}) {
  const members = (data?.members || []).filter(m => {
    if (remoteIsAdmin(m)) return false;
    const local = matchLocalMember(roster, m);
    if (local && (local.identity === 'leader' || progressIgnoredSafe(local))) return false;
    return true;
  });
  const progress = data?.progress || {};
  const totalItems = catalog ? Object.keys(catalog).length : 0;
  const rows = members.map(m => {
    const p = progress[m.ymis] || {};
    const done = Object.keys(p).length;
    const dates = Object.values(p).map(x => x?.date).filter(Boolean).sort();
    const local = matchLocalMember(roster, m);
    return {
      ymis: m.ymis, name: m.name, done,
      rate: totalItems ? Math.round(done / totalItems * 100) : null,
      lastDate: dates[dates.length - 1] || '',
      localId: local?.id || '', localName: local?.name || '', identity: local?.identity || '',
      matched: !!local
    };
  });
  // 每個獎章：邊幾多位成員有進度、總共勾咗幾多
  let badgeStats = [];
  if (catalog) {
    const byBadge = {};
    Object.values(catalog).forEach(it => {
      byBadge[it.badgeId] = byBadge[it.badgeId] || { id: it.badgeId, icon: it.badgeIcon, name: it.badgeName, items: 0, ticks: 0, members: 0 };
      byBadge[it.badgeId].items += 1;
    });
    Object.values(progress).forEach(p => {
      const seen = {};
      Object.keys(p).forEach(itemId => {
        const it = catalog[itemId];
        if (!it || !byBadge[it.badgeId]) return;
        byBadge[it.badgeId].ticks += 1;
        seen[it.badgeId] = true;
      });
      Object.keys(seen).forEach(b => { byBadge[b].members += 1; });
    });
    badgeStats = Object.values(byBadge);
  }
  const doneRows = rows.filter(r => r.done > 0);
  return {
    members: rows, memberCount: members.length,
    withProgress: doneRows.length,
    totalTicks: rows.reduce((a, r) => a + r.done, 0),
    avgRate: totalItems && rows.length ? Math.round(rows.reduce((a, r) => a + r.done, 0) / (rows.length * totalItems) * 100) : null,
    totalItems, badgeStats,
    unmatched: rows.filter(r => !r.matched).length
  };
}

/** 一位成員嘅項目清單（連完成日期），按獎章分組 */
export function memberDetail(data, catalog, ymis) {
  const p = progressOf(data, ymis) || {};
  const groups = {};
  Object.values(catalog || {}).forEach(it => {
    groups[it.badgeId] = groups[it.badgeId] || { id: it.badgeId, icon: it.badgeIcon, name: it.badgeName, items: [] };
    groups[it.badgeId].items.push({ ...it, done: !!p[it.id], date: p[it.id]?.date || '', confirmer: p[it.id]?.confirmer || '' });
  });
  return {
    done: Object.keys(p).length,
    badges: Object.values(groups).map(g => ({
      ...g, done: g.items.filter(i => i.done).length, total: g.items.length,
      rate: g.items.length ? Math.round(g.items.filter(i => i.done).length / g.items.length * 100) : 0
    })),
    extras: Object.keys(p).filter(id => !(catalog || {})[id]).map(id => ({ id, ...p[id] }))
  };
}
