/* ============================================================
   progress.js — 進度紀錄（一個後端、兩個前端）
   ------------------------------------------------------------
   設計（2026-09-16 團長更正）：
     · 唔連任何「其他系統」——進度資料本來就係寫入**旅團自己嘅後端**
       （同一個 Google Sheet ＋ 同一支 Apps Script）
     · 兩個前端餵同一個後端：
         ① 深資童軍管理系統（呢度）  ② 進度前端（團員／領袖用）
     · 呢邊只做兩件事：讀後端（GET ?action=load）／寫後端（POST action=save）
     · 預設就用返旅團已登記嘅後端（data/units.json → backend.gasUrl / apiKey），
       所以通常唔使填任何嘢；要覆蓋就喺「進度 → 設定」自己填。
   設定：喺「進度 → 設定」填 /exec ＋ API Key（Apps Script 執行 showApiKey() 複製），
        存在旅團自己嘅資料（跟 JSON 備份走）；env（TROOP_<id>_PROGRESS*）係可選覆蓋。
   安全：API Key 只會由瀏覽器傳去**同源** /api/progress，唔會經第三方；亦唔會出現在 log。
   ============================================================ */

import { load, commit } from './store.js';
import { profile } from './model.js';
import { backendOf, unitEntry } from './units.js';

/** 預設考核項目定義（app 內建，離線可用） */
export const DEFAULT_CATALOG_URL = 'data/progress/items.json';

/* ---------- 設定（跟旅團儲存；會跟 JSON 備份一齊走） ---------- */
export function progressCfg(unitOverride = '') {
  const p = profile();
  const b = p.progress?.backend || {};
  const unit = b.unit || unitOverride || load().unitCode || '';
  const be = backendOf(unit) || {};
  /* 伺服器端 Registry（環境變數）已經有進度後端＋Key：前端唔使填，直接經 /api/progress 讀寫 */
  const serverSide = !!(unitEntry(unit)?.progressServerSide) && !b.backend && !b.apiKey;
  return {
    serverSide,
    /* 後端：旅團自己填嘅 → 冇填就用返 Registry 登記咗嘅旅團後端（兩者其實係同一個後端） */
    backend: b.backend || be.gasUrl || '',
    apiKey: b.apiKey || (b.backend ? '' : (be.apiKey || '')),
    unit,
    name: p.progress?.name || '進度追蹤（同一個後端）',
    catalogUrl: b.catalogUrl || '',
    registered: !b.backend && !!be.gasUrl
  };
}

export function setProgressCfg(patch = {}) {
  const db = load();
  const cur = db.profile?.progress?.backend || {};
  const next = { ...cur, ...patch };
  db.profile = {
    ...(db.profile || db.unit || {}),
    progress: { ...((db.profile || db.unit)?.progress || {}), backend: next }
  };
  commit();
  return progressCfg();
}

export function progressConfigured() {
  const c = progressCfg();
  return !!((c.backend && c.apiKey) || c.serverSide);
}

/** 後端係唔係已經登記好（未填都可以用，話畀用戶知係「自動用返旅團後端」） */
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
        error: '呢部伺服器冇 /api/progress（進度接駁需要 Node 後端）。本機可以用 `npm run dev`，或在 Vercel 部署。' };
    }
    return json;
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'network',
      error: aborted ? '連線逾時（進度系統後端冇回應）' : '連唔到本系統嘅 API（/api/progress）' };
  } finally {
    clearTimeout(timer);
  }
}

const cfgPayload = () => {
  const c = progressCfg();
  return { unit: c.unit, backend: c.backend, apikey: c.apiKey, catalog: c.catalogUrl };
};

/** 讀旅團後端全部進度資料（成員／進度／待批／其他獎章／活動履歷） */
export async function loadRemote() {
  return callApi({ ...cfgPayload(), action: 'load' });
}

/** 讀考核項目定義：預設用 app 內建副本（同源讀檔，離線都用得）；有自訂網址就經伺服器代讀 */
export async function loadItems() {
  const c = progressCfg();
  if (!c.catalogUrl) {
    try {
      const res = await fetch(DEFAULT_CATALOG_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return { ok: true, local: true, data: json };
    } catch (e) {
      return { ok: false, reason: 'catalog_local_failed', error: '讀唔到內建考核項目（data/progress/items.json）' };
    }
  }
  return callApi({ ...cfgPayload(), action: 'catalog' });
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
 * 批准＝寫入後端嘅「進度追蹤」，兩個前端都即刻見到。
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

/**
 * ★ 2026-09-24 後端自查（「人讀到、但係個個都冇進度」）。
 * 一次過問後端：呢支 /exec 係邊張 Sheet／認唔認得 diag（＝係唔係管理系統嘅後端）／
 * 進度追蹤同名冊分頁各有幾多行。
 * @returns {ok, data:{recognized, self, detail, apiKeyUsed}, error}
 */
export async function diagnoseBackend() {
  return callApi({ ...cfgPayload(), action: 'diag' });
}

/** 顯示用：遮一遮 /exec 嘅部署 ID（唔使成條長 URL 擺上螢幕） */
export function maskBackendUrl(u) {
  return String(u || '').replace(/\/macros\/s\/[^/]+/, '/macros/s/…');
}

/** 由自查結果砌出「結論＋要做乜」（純文字，方便測試同閱讀） */
export function diagVerdict(d, summary = {}) {
  const memberCount = Number(summary.memberCount || 0);
  const withProgress = Number(summary.withProgress || 0);
  const detail = d?.detail || null;
  const self = d?.self || null;
  const sheet = detail?.spreadsheet || self?.spreadsheet || '';
  const pg = detail?.progress || null;
  const out = { level: 'ok', title: '', lines: [], steps: [] };

  if (!d) return { level: 'info', title: '未做過自查', lines: [], steps: ['撳「後端資料檢查」睇下後端而家有咩。'] };
  if (d.error) return { level: 'bad', title: '自查失敗：' + d.error, lines: [], steps: [] };

  const rows = pg ? Number(pg.rows || 0) : -1;
  /* 後端網址：可以由呼叫者直接傳（測試／唔想掂 store 都得） */
  let backendHint = String(summary.backend || '');
  if (!backendHint) { try { backendHint = progressCfg().backend || ''; } catch (e) { backendHint = ''; } }
  if (backendHint) out.lines.push(`你填嘅後端：${maskBackendUrl(backendHint)}`);
  if (self?.msg) out.lines.push(`後端自報：${self.msg}${sheet ? `（試算表：${sheet}）` : ''}`);
  else if (self?.error) out.lines.push(`後端自報：${self.error}`);
  out.lines.push(`讀到嘅成員：${memberCount} 位 · 有進度紀錄：${withProgress} 位`);
  if (detail) {
    out.lines.push(`「進度追蹤」分頁：${rows} 行`
      + (pg ? `（${pg.ymis} 個 YMIS、${pg.items} 個項目${pg.blank ? `、${pg.blank} 行空` : ''}）` : ''));
    out.lines.push(`「成員名單」分頁：${Number(detail.memberList?.rows ?? -1)} 行（${Number(detail.memberList?.ymis || 0)} 個 YMIS）`);
    if (Array.isArray(detail.tabs) && detail.tabs.length) {
      out.lines.push('分頁：' + detail.tabs.map(t => `${t.name}(${t.rows < 0 ? '?' : t.rows})`).join('、'));
    }
    if (Array.isArray(detail.missingTabs) && detail.missingTabs.length) {
      out.lines.push('缺咗嘅分頁：' + detail.missingTabs.join('、'));
    }
  }

  if (!d.recognized) {
    out.level = 'warn';
    out.title = '呢支 /exec 唔係「深資童軍管理系統」嘅後端（佢唔識「後端檢查」指令）';
    out.lines.push('可能係：（甲）進度前端（vsbadge）自己嗰支腳本；（乙）未更新嘅舊版 Code.gs。');
    out.steps.push('打開呢支 /exec 對應嘅張 Google Sheet，睇下有冇「進度追蹤」分頁、有冇資料。');
    out.steps.push('如果啲進度其實喺另一張 Sheet（進度前端嗰張）→ 去「設定」改用嗰支 /exec ＋ API Key。');
    out.steps.push('如果你想兩個前端用同一份資料：喺呢張 Sheet 貼新版 Code.gs（v2.7.1）→ 部署 → 執行一次 initializeSheets() 補分頁。');
    return out;
  }

  if (rows <= 0) {
    out.level = 'bad';
    out.title = `「${sheet || '呢張 Sheet'}」嘅「進度追蹤」分頁一條紀錄都冇（所以個個都顯示冇進度）`;
    out.steps.push('打開呢張 Google Sheet 睇「進度追蹤」分頁：係咪存在？係咪一行資料都冇？');
    out.steps.push('分頁唔見咗 → 喺 Apps Script 執行 initializeSheets()（只補缺嘅分頁，唔會刪資料）；'
      + '如果係啱啱唔見，Google Sheets「檔案 → 版本記錄」可以還原舊版（連分頁資料）。');
    out.steps.push('分頁在但係空 → 你嘅進度應該係另一張 Sheet（進度前端嗰張）→ 去「設定」改用嗰支 /exec ＋ API Key；'
      + '或者就喺呢邊「勾選進度」開始記。');
    out.steps.push('如果係舊版 Code.gs（v2.6.1／v2.6.2）刪過分頁 → 貼新版（v2.7.1）＋重新部署就唔會再發生。');
    return out;
  }

  /* 有進度，但同名冊一個都對唔上 */
  const matched = Number(pg?.matchedWithMemberList || 0);
  if (pg && matched === 0 && Number(pg.notInMemberList || 0) > 0) {
    out.level = 'warn';
    out.title = '有進度紀錄，但冇一個 YMIS 對得上「成員名單」（所以每個人睇落都係 0）';
    out.steps.push('喺 Google Sheet 對一對：「進度追蹤」第一欄嘅 YMIS 同「成員名單」第一欄係咪同一批號碼。');
    out.steps.push('「進度 → 成員進度」用到嘅係會員編號（YMIS）；名冊缺 YMIS 或者號碼唔同，就會對唔上。');
    out.steps.push('去「用戶名冊」補／改 YMIS，或者修正「進度追蹤」嗰欄。');
    return out;
  }

  out.level = 'ok';
  out.title = `後端正常：讀到 ${memberCount} 位成員、${withProgress} 位有進度（${pg ? `${pg.ymis} 個 YMIS、${pg.items} 個項目` : ''}）`;
  if (withProgress === 0 && memberCount > 0) {
    out.level = 'warn';
    out.title = '後端有成員，但冇人有進度紀錄';
  }
  out.steps.push('睇「成員進度」分頁揀人 → 逐項睇佢嘅完成情況；要記新項目就去「勾選進度」。');
  return out;
}

/** 測試連線：讀一次 load，睇下 API Key 對唔對 */
export async function testConnection() {
  const started = Date.now();
  const r = await loadRemote();
  const members = r?.data?.members?.length ?? 0;
  return {
    ...r,
    ms: Date.now() - started,
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    summary: r.ok
      ? `連通 ✓ 讀到 ${members} 位成員、${Object.keys(r.data?.progress || {}).length} 位有進度紀錄`
      : (r.error || '連線失敗')
  };
}

/* ============================================================
   團員自助進度（2026-09-18 第 5 項要求）
   團員喺團員入口申報「完成咗某個考核項目」→ 寫入後端「待批完成」
   → 執委喺「進度 → 審批中心」批准 → 先真正寫入進度。
   團員冇 API Key，所以唔會直接改到進度；後端 addRequest 係免 key 動作。
   ============================================================ */
/** 申報完成：{ ymis, name, item_id, item_name, requested_date, evidence } */
export async function submitProgressRequest(req = {}) {
  return callApi({
    ...cfgPayload(), action: 'addRequest',
    data: {
      ymis: String(req.ymis || ''), name: String(req.name || ''),
      item_id: String(req.item_id || ''), item_name: String(req.item_name || ''),
      requested_date: String(req.requested_date || ''), evidence: String(req.evidence || '')
    }
  });
}

/** 查自己嘅申報紀錄（待批／已批／已拒） */
export async function loadMyRequests(ymis) {
  return callApi({ ...cfgPayload(), action: 'myRequests', data: { ymis: String(ymis || '') } });
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
