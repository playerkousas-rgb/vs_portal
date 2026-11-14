/* ============================================================
   progress.js — 進度紀錄（完整 Unified 後端；vs_portal 完整版前端內的模組）
   ------------------------------------------------------------
   統一設計：
     · Unified GS 具備身份、行政、Progress、獎章、履歷及申報完整能力。
       vs_portal 是功能完整版前端，vsbadge 是只呈現部分流程的輕量前端；兩者共用同一權威資料。
     · 呢個模組只做兩件事：讀同一後端、寫同一後端。API Key 只係 server routing／HMAC 根，
       每個 action 仍要經 allowlist，並由 server-issued session、role、scope 核實。

   讀：POST /api/progress { action:'load', unit, sessionToken }
   寫：POST /api/progress { action:'save'|'saveOtherBadge', unit, sessionToken }
       （/exec 與 API Key 只留 server Registry，瀏覽器不能另指後端）

   分頁：總覽 / 成員進度 / 勾選進度 / 審批中心 / 設定
   ============================================================ */

import { profile, members, keyCoverage, progressRoster, progressIgnored, identityOf } from '../lib/model.js';
import { esc, icon, modal, toast, todayISO, safeHref } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, noteBoxHtml, kvHtml, chipbar, progressBar } from './ui.js';
import {
  progressCfg, progressConfigured,
  loadRemote, loadItems, saveTicks, flattenItems, summarizeRemote, memberDetail,
  reviewRequest, reviewLogRequest, bulkReviewRequests, checkProgressOperation
} from '../lib/progress.js';
import { confirmBulkOperation } from '../lib/guard.js';
import { pendingOperations, finishOperation } from '../lib/operations.js';

/* ---------- 狀態 ---------- */
let tab = 'overview';
let remote = null;        // { data, at }
let catalog = null;       // flattenItems() 結果
let loading = false;
let errMsg = '';
let selYmis = '';         // 成員進度 / 勾選 用
let selBadge = 'all';     // 勾選：獎章篩選
let pending = {};         // { 'ymis|itemId': true/false } 未儲存嘅改動
let tickDate = '';        // 勾選日期
let memberSearch = '';
let reviewing = false;    // 審批中
let reviewDate = '';      // 審批：確認日期（留空＝用申報日期）
let reviewSelection = new Set(); // `${kind}:${request_id}`；只保存仍然 pending 的選擇
let uncertainReview = null;      // { operationId, count, unit }；未查清之前禁止重送同一批

function pendingProgressWrite(actions) {
  const allowed = new Set(Array.isArray(actions) ? actions : [actions]);
  const unit = String(progressCfg().unit || '');
  return pendingOperations().find(x => String(x.unit || '') === unit
    && allowed.has(x.action) && x.outcome === 'unknown') || null;
}
function unresolvedReviewOperation() {
  if (uncertainReview?.operationId && uncertainReview.unit === String(progressCfg().unit || '')) return uncertainReview;
  const op = pendingProgressWrite('bulkReviewRequests');
  return op ? { operationId: op.id, count: 0, unit: String(op.unit || '') } : null;
}

export function title() { return '進度紀錄'; }
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

/* ============================================================
   讀後端
   ============================================================ */
async function fetchAll({ silent = false } = {}) {
  if (!progressConfigured()) {
    if (!silent) toast('旅團後端尚未由平台登記；請管理員核對同 BADGE 一樣嘅 NAME／BACKEND／APIKEY', 'info');
    return;
  }
  loading = true; errMsg = '';
  if (!silent) refresh();
  const r = await loadRemote();
  if (!r.ok) {
    loading = false; remote = null;
    errMsg = r.error || 'Progress action 讀取失敗';
    refresh();
    return;
  }
  remote = { data: r.data || {}, at: new Date().toLocaleString('zh-HK', { hour12: false }) };
  reconcileReviewSelection();
  const it = await loadItems();
  if (it.ok) catalog = flattenItems(it.data);
  loading = false;
  refresh();
}

/** 未登記資料來源：只顯示 server Registry 合約，不叫用戶把 Key 放入 browser。 */
function needSetup() {
  const unit = progressCfg().unit || '0082';
  return `
  <div class="card" style="max-width:780px">
    <div class="card-head"><div><div class="card-title">同一 Unified Sheet 資料來源尚未登記</div>
      <div class="card-sub">vs_portal 功能完整版與 vsbadge 輕量版前端使用同一支完整 Unified GS</div></div></div>
    <div style="padding:16px 18px" class="sm muted">
      ${noteBoxHtml('<b>唔好喺瀏覽器貼 API Key。</b>平台管理員只需在 Vercel 登記同 BADGE 完全相同的三個值；'
        + '兩個前端會沿用同一完整後端，亦不接受第二個進度或 BADGE 精簡後端。', 'brand')}
      <pre class="code mt-12">TROOP_${esc(unit)}_NAME
TROOP_${esc(unit)}_BACKEND
TROOP_${esc(unit)}_APIKEY</pre>
      <div class="hint mt-8"><code>BACKEND</code> 係同一 Unified Apps Script 正式 <code>/exec</code>；
        <code>APIKEY</code> 必須等於該 Sheet 的 <code>API_KEY</code>。更新 Vercel 後要 Redeploy。</div>
      <div class="row gap-8 mt-12 wrap">
        <button class="btn" data-go="#/tables/sync">${icon('cloud', 16)} 查看 Apps Script</button>
      </div>
    </div>
  </div>`;
}

/** 待批總數（分頁標籤用） */
function reviewCount() {
  const d = remote?.data || {};
  return (d.pendingRequests || []).length + (d.logRequests || []).length;
}

/* ---------- 總覽 ---------- */
/** ★「人讀到、但個個冇進度」橫額 —— 直接講出下一步，唔使人自己猜 */
function emptyProgressBanner() {
  if (!remote) return '';
  const sum = summarizeRemote(remote.data, { catalog, roster: members() });
  if (!sum.memberCount || sum.withProgress > 0) return '';
  const raw = remote.data?.progress || {};
  const ticks = Object.values(raw).reduce((a, p) => a + Object.keys(p || {}).length, 0);
  return `<div class="note-box info">${icon('check', 15)}<div>
    <b>已成功讀到同一 Unified Sheet 嘅 ${sum.memberCount} 位成員；目前有 ${ticks} 格進度紀錄</b>
    <div class="sm mt-4">Progress action 已成功。「進度追蹤」分頁而家係空，所以每個人顯示 0；新建 Sheet 本來就會係呢個狀態。
    之後經 Progress 或 BADGE 寫入同一分頁，數字就會直接更新。</div>
    <div class="row gap-8 mt-8 wrap">
      <button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 查看同一 Sheet 資料來源</button>
    </div></div></div>`;
}

function overviewView() {
  if (!progressConfigured()) return needSetup();
  if (errMsg) {
    return `<div class="note-box warn">${icon('alert', 15)}<div><b>讀唔到後端：</b>${esc(errMsg)}
      <div class="xs mt-4">如果係「Invalid API Key」→ 請平台管理員核對 Vercel <code>APIKEY</code> 與同一 Unified GAS 的 Script Property；
        如果係缺少進度分頁 → 喺後端執行一次 <code>initializeSheets</code>。瀏覽器毋須亦不可貼 Key。</div></div></div>
      <div class="row gap-8 mt-12"><button class="btn" data-act="settings">${icon('settings', 15)} 檢查設定</button>
      <button class="btn" data-act="reload">${icon('refresh', 15)} 再試</button></div>`;
  }
  if (!remote) return `<div class="card"><div style="padding:34px" class="center muted">${loading ? '讀取後端中…（最多等 45 秒）' : '按「重新讀取」開始'}</div></div>`;

  const S = summarizeRemote(remote.data, { catalog, roster: members() });
  const pendingReqs = remote.data.pendingRequests || [];
  const logs = remote.data.logs || [];
  const logReqs = remote.data.logRequests || [];

  return `
  <div class="grid g-4 mb-16">
    ${stat('後端成員', String(S.memberCount), `${S.withProgress} 位有進度紀錄`, '')}
    ${stat('已勾項目', String(S.totalTicks), catalog ? `共 ${S.totalItems} 個考核項目` : '（未讀到項目定義）', 'ok')}
    ${stat('平均完成率', S.avgRate === null ? '—' : S.avgRate + '%', '以全團 × 全部項目計', S.avgRate >= 50 ? 'ok' : '')}
    ${stat('待確認', String(pendingReqs.length), pendingReqs.length ? '團員申報、等領袖確認' : '冇待確認', pendingReqs.length ? 'warn' : 'ok')}
  </div>

  ${emptyProgressBanner()}

  ${S.unmatched ? `<div class="note-box mb-16">${icon('alert', 15)}<div>
    有 <b>${S.unmatched}</b> 位後端成員喺本系統名冊搵唔到（多數係未填 YMIS）。
    去「用戶」幫佢哋填返<b>會籍編號（YMIS）</b>，兩邊就對得返。</div></div>` : ''}

  <div class="grid g-2-1">
    <div class="col gap-16">
      ${catalog ? `<div class="card">
        <div class="card-head"><div><div class="card-title">獎章進度（全團）</div>
          <div class="card-sub">每個獎章：有幾多人開始、合共勾咗幾多項</div></div></div>
        <div style="padding:14px 18px" class="col gap-14">
          ${S.badgeStats.map(b => {
            const ticksRate = b.items ? Math.round(b.ticks / (b.items * Math.max(1, S.memberCount)) * 100) : 0;
            return `<div>
              <div class="row-between xs mb-4"><span>${esc(b.icon)} <b>${esc(b.name)}</b> <span class="faint">${esc(b.id)}</span></span>
                <span class="mono">${b.members} 人開始 · 勾咗 ${b.ticks} 項 / ${b.items * Math.max(1, S.memberCount)}</span></div>
              ${progressBar(ticksRate)}
            </div>`;
          }).join('')}
        </div>
      </div>` : `<div class="note-box">${icon('alert', 15)}<div>未讀到內建考核項目定義（<code>data/progress/items.json</code>）；請重新部署完整靜態資產。</div></div>`}

      <div class="card">
        <div class="card-head"><div><div class="card-title">待批（${pendingReqs.length + logReqs.length}）</div>
          <div class="card-sub">團員自己申報、等批嘅項目同履歷 —— 喺「審批中心」直接批入同一 Unified Sheet</div></div>
          <button class="btn btn-sm ${pendingReqs.length + logReqs.length ? 'btn-primary' : ''}" data-go="#/progress/review">${icon('check', 15)} 去審批中心</button></div>
        ${pendingReqs.length ? `<div class="scroll-x"><table class="table table-compact">
          <thead><tr><th>申請日期</th><th>團員</th><th>項目</th><th>申報日期</th></tr></thead>
          <tbody>${pendingReqs.slice(0, 20).map(r => `<tr>
            <td class="mono sm">${esc(r.created_at || '')}</td>
            <td class="sm">${esc(r.name || r.ymis || '')}</td>
            <td class="sm">${esc(r.item_name || r.item_id || '')}</td>
            <td class="mono sm">${esc(r.requested_date || '')}</td></tr>`).join('')}</tbody>
        </table></div>` : `<div style="padding:16px" class="sm faint">冇待批完成申請</div>`}
        ${logReqs.length ? `<div style="padding:12px 16px;border-top:1px solid var(--line-2)" class="sm muted">
          另有 <b>${logReqs.length}</b> 條活動履歷申報等批（一樣喺「審批中心」處理）</div>` : ''}
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">活動履歷</div>
          <div class="card-sub">服務／活動／訓練班紀錄（同後端同一份）</div></div></div>
        <div style="padding:16px 18px">
          <div class="grid g-2" style="gap:10px">
            <div><div class="xs faint">已批紀錄</div><div class="semibold">${logs.length} 條</div></div>
            <div><div class="xs faint">待批申報</div><div class="semibold">${logReqs.length} 條</div></div>
          </div>
          ${logs.length ? `<div class="mt-12 col gap-6">${logs.slice(0, 6).map(l => `
            <div class="list-item"><div class="li-main"><div class="li-t">${esc(l.name || l.title || '')}</div>
              <div class="li-s">${esc(l.kind || l.type || '')} · ${esc(String(l.date || '').slice(0, 10))}</div></div></div>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">本系統保留嘅資料</div>
          <div class="card-sub">出席率、團費 —— 進度同獎章由後端擁有</div></div></div>
        <div style="padding:14px 16px" class="sm muted">
          兩邊用<b>會籍編號（YMIS）</b>對同一個人。喺「用戶」填好 YMIS，呢度嘅完成率就會自動對應到正確嘅團員。
          <div class="mt-8 xs faint">上次讀取：${esc(remote.at || '')}</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------- 成員進度 ---------- */
function membersView() {
  if (!progressConfigured()) return needSetup();
  if (!remote) return empty('check', '未讀取後端', '按右上「重新讀取」');
  const S = summarizeRemote(remote.data, { catalog, roster: members() });
  const kw = memberSearch.trim().toLowerCase();
  const rows = S.members
    .filter(r => !kw || `${r.name} ${r.ymis} ${r.localName}`.toLowerCase().includes(kw))
    .sort((a, b) => b.done - a.done);

  return `
  <div class="row-between wrap gap-12 mb-12">
    <div class="toolbar">
      <div class="field" style="margin:0"><input class="input" id="mSearch" value="${esc(memberSearch)}" placeholder="搵名 / YMIS" style="width:220px"></div>
      ${catalog ? chipbar([['all', '全部獎章']].concat([...new Set(Object.values(catalog).map(i => i.badgeId))].map(b => {
        const it = Object.values(catalog).find(x => x.badgeId === b) || {};
        return [b, `${it.badgeIcon || ''} ${it.badgeName || b}`];
      })), selBadge, 'data-badge') : ''}
    </div>
    <div class="sm muted">${S.memberCount} 位 · ${S.withProgress} 位有紀錄 · 未對上 ${S.unmatched}</div>
  </div>

  <div class="card">
    <div class="scroll-x"><table class="table table-compact">
      <thead><tr><th>團員</th><th>YMIS</th><th class="right">已勾</th>${catalog ? '<th style="width:190px">完成率</th>' : ''}<th class="right">最近</th><th>對應名冊</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr data-member="${esc(r.ymis)}" style="cursor:pointer">
        <td class="semibold sm">${esc(r.name)}</td>
        <td class="mono xs">${esc(r.ymis)}</td>
        <td class="right mono">${r.done}</td>
        ${catalog ? `<td>${r.rate === null ? '<span class="faint xs">—</span>' : progressBar(r.rate)}</td>` : ''}
        <td class="right mono xs">${esc(r.lastDate || '—')}</td>
        <td class="sm ${r.matched ? '' : 'faint'}">${r.matched ? esc(r.localName || '') : '<span style="color:var(--warn)">未對上</span>'}</td>
        <td class="right hide-mobile"><span class="xs faint">撳入明細</span></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

/* ---------- 勾選 ---------- */
function tickView() {
  if (!progressConfigured()) return needSetup();
  if (!remote) return empty('check', '未讀取後端', '按右上「重新讀取」');
  const data = remote.data || {};
  const list = data.members || [];
  if (!list.length) return empty('users', '後端冇成員名單', '喺後端執行 initializeSheets，或者喺「系統 → 總表同步」同步一次團員名冊。');
  if (!selYmis || !list.some(m => String(m.ymis) === String(selYmis))) selYmis = list[0].ymis;
  const progress = data.progress || {};
  const done = progress[selYmis] || {};
  const badgeIds = catalog ? [...new Set(Object.values(catalog).map(i => i.badgeId))] : [];
  const shown = catalog ? Object.values(catalog).filter(i => selBadge === 'all' || i.badgeId === selBadge) : [];
  const pendingCount = Object.keys(pending).length;

  return `
  <div class="note-box mb-16">${icon('check', 15)}<div>
    喺呢度勾選＝直接寫入<b>同一 Unified Sheet</b>（功能完整版支部前端同 BADGE 輕量前端共用），效果一樣。
    未撳「儲存」之前唔會送出。
  </div></div>

  <div class="row-between wrap gap-12 mb-16 no-print">
    <div class="toolbar">
      <select class="select" id="tickMember" style="width:auto">
        ${list.map(m => `<option value="${esc(m.ymis)}" ${String(m.ymis) === String(selYmis) ? 'selected' : ''}>${esc(m.name)}（${esc(m.ymis)}）· 已勾 ${Object.keys(progress[m.ymis] || {}).length}</option>`).join('')}
      </select>
      ${badgeIds.length ? chipbar([['all', '全部獎章']].concat(badgeIds.map(b => {
        const it = Object.values(catalog).find(x => x.badgeId === b) || {};
        return [b, `${it.badgeIcon || ''} ${it.badgeName || b}`];
      })), selBadge, 'data-badge') : ''}
      <div class="field" style="margin:0"><input class="input" id="tickDate" type="date" value="${esc(tickDate || todayISO())}" style="width:auto"></div>
    </div>
    <div class="row gap-8 wrap">
      <button class="btn" data-act="undo-ticks" ${pendingCount ? '' : 'disabled'}>${icon('refresh', 15)} 放棄改動</button>
      <button class="btn btn-primary" data-act="save-ticks" ${pendingCount ? '' : 'disabled'}>${icon('save', 15)} 儲存${pendingCount ? `（${pendingCount} 項）` : ''}</button>
    </div>
  </div>

  ${catalog ? `<div class="col gap-12">${groupByBadge(shown, done).map(g => `
    <div class="card">
      <div class="card-head"><div><div class="card-title">${esc(g.icon)} ${esc(g.name)}</div>
        <div class="card-sub">已勾 ${g.items.filter(it => eff(it.id, !!(done[it.id]))).length} / ${g.items.length}</div></div>
        <div class="row gap-6">
          <button class="btn btn-xs" data-bulk="${esc(g.id)}|1">全勾</button>
          <button class="btn btn-xs" data-bulk="${esc(g.id)}|0">全清</button>
        </div></div>
      <div style="padding:6px 0">${g.items.map(it => {
        const orig = !!(done[it.id]);
        const cur = eff(it.id, orig);
        const changed = pending[`${selYmis}|${it.id}`] !== undefined;
        return `<label class="list-item" style="cursor:pointer;${changed ? 'background:var(--brand-50)' : ''}">
          <input type="checkbox" data-tick="${esc(it.id)}" ${cur ? 'checked' : ''} style="width:18px;height:18px">
          <div class="li-main"><div class="li-t">${esc(it.name)}</div>
            <div class="li-s">${esc(it.id)}${orig && done[it.id]?.date ? ` · 原勾選日 ${esc(done[it.id].date)}` : ''}${changed ? ' · <b>未儲存</b>' : ''}</div></div>
        </label>`;
      }).join('')}</div>
    </div>`).join('')}</div>`
    : `<div class="note-box">${icon('alert', 15)}<div>未讀到內建考核項目定義（<code>data/progress/items.json</code>）；請重新部署完整靜態資產。</div></div>`}`;
}

function eff(itemId, fallback = false) {
  const key = `${selYmis}|${itemId}`;
  return pending[key] === undefined ? fallback : pending[key];
}

function groupByBadge(items, done) {
  const groups = {};
  items.forEach(it => {
    groups[it.badgeId] = groups[it.badgeId] || { id: it.badgeId, icon: it.badgeIcon, name: it.badgeName, items: [] };
    groups[it.badgeId].items.push(it);
  });
  return Object.values(groups);
}

async function openMemberDetail(ymis) {
  const data = remote?.data || {};
  const row = (data.members || []).find(m => String(m.ymis) === String(ymis)) || { name: ymis };
  const local = members().find(m => String(m.ymis || '') === String(ymis));
  const d = memberDetail(data, catalog, ymis);
  await modal({
    title: row.name || ymis, sub: `YMIS ${ymis}${local ? ` · 名冊：${local.name}` : ' · 名冊未對上'}`, wide: true,
    trustedBodyHtml: `
      <div class="row gap-12 wrap mb-12">
        <span class="badge b-ok">已勾 ${d.done} 項</span>
        ${catalog ? `<span class="badge b-grey">項目共 ${Object.keys(catalog).length}</span>` : ''}
      </div>
      ${d.badges.map(g => `<div class="card mb-12"><div class="card-head"><div>
          <div class="card-title">${esc(g.icon)} ${esc(g.name)}</div>
          <div class="card-sub">${g.done} / ${g.total}（${g.rate}%）</div></div></div>
        <div style="padding:8px 16px">${g.items.map(i => `
          <div class="row-between" style="padding:5px 0;border-bottom:1px solid var(--line-2)">
            <span class="sm">${i.done ? '<b style="color:var(--ok)">✓</b> ' : '<span class="faint">○</span> '}${esc(i.name)}</span>
            <span class="xs faint mono">${esc(i.date || '')}</span></div>`).join('')}</div>
      </div>`).join('')}
      ${d.extras.length ? `<div class="note-box">${icon('alert', 15)}<div>另有 ${d.extras.length} 項唔喺現行項目定義內（可能係舊版綱要）：${esc(d.extras.map(x => x.id).slice(0, 8).join('、'))}</div></div>` : ''}`,
    actions: [{ label: '關閉', class: 'btn', value: null }]
  });
}

/* ---------- 審批中心（批／拒團員申報 —— 批准＝寫入後端） ---------- */
function reviewKey(kind, id) { return `${kind}:${String(id || '')}`; }
function pendingReviewRows() {
  const d = remote?.data || {};
  return [
    ...(d.pendingRequests || []).map(row => ({ kind: 'req', request_id: String(row.request_id || ''), row })),
    ...(d.logRequests || []).map(row => ({ kind: 'log', request_id: String(row.request_id || ''), row }))
  ].filter(item => item.request_id);
}
function reconcileReviewSelection() {
  const valid = new Set(pendingReviewRows().map(item => reviewKey(item.kind, item.request_id)));
  reviewSelection = new Set([...reviewSelection].filter(key => valid.has(key)));
}
function selectedReviewRows() {
  const byKey = new Map(pendingReviewRows().map(item => [reviewKey(item.kind, item.request_id), item]));
  return [...reviewSelection].map(key => byKey.get(key)).filter(Boolean);
}

function reviewView() {
  if (!progressConfigured()) return needSetup();
  if (!remote) return empty('check', '未讀取後端', '按右上「重新讀取」');
  const reqs = remote.data.pendingRequests || [];
  const logReqs = remote.data.logRequests || [];
  const supported = remote.data.logRequestsSupported !== false;
  const canTick = can('progress.tick');
  const unresolved = unresolvedReviewOperation();
  const reviewLocked = reviewing || !!unresolved;
  reconcileReviewSelection();
  const allRows = pendingReviewRows();
  const selected = selectedReviewRows();
  const selectedReqs = selected.filter(item => item.kind === 'req').length;
  const selectedLogs = selected.length - selectedReqs;
  const allSelected = allRows.length > 0 && selected.length === allRows.length;

  const rejectAction = (kind, id) => canTick ? `
    <button class="btn btn-xs" data-rev-kind="${esc(kind)}" data-rev-id="${esc(id)}"
      data-rev-decision="rejected" ${reviewLocked ? 'disabled' : ''}>拒絕</button>`
    : '<span class="xs faint">需要審批權限</span>';
  const selector = (kind, id, label) => canTick
    ? `<input type="checkbox" data-review-select data-kind="${esc(kind)}" data-id="${esc(id)}"
        aria-label="${esc(label)}" ${reviewSelection.has(reviewKey(kind, id)) ? 'checked' : ''}
        ${reviewLocked ? 'disabled' : ''} style="width:18px;height:18px">`
    : '<span class="faint">—</span>';

  if (!reqs.length && !logReqs.length) {
    reviewSelection.clear();
    return `${noteBoxHtml('後端冇待批嘅申請 —— 團員喺進度前端申報之後，就會自動出現在呢度，唔使去其他系統。', 'ok')}
      <div class="row gap-8 mt-12"><button class="btn" data-act="reload">${icon('refresh', 15)} 重新讀取</button></div>`;
  }

  return `
  ${noteBoxHtml(canTick
    ? '先 <b>tick</b> 要處理嘅申請，再撳「<b>批量批准</b>」。瀏覽器只會送出<b>一次</b>審批 request；Unified 後端會先驗完整批次，再在同一次處理內寫入同一 Sheet。'
    : '你冇勾選／審批權限 —— 可以睇，但要領袖或執委先批得。',
    canTick ? 'ok' : 'warn')}
  ${unresolved ? `<div class="note-box danger mt-12"><div><b>上次批量操作結果仍然未知，已鎖住再次審批，避免重複。</b>
    <div class="xs mt-4">操作編號：<code>${esc(unresolved.operationId)}</code></div>
    <button class="btn btn-sm mt-8" data-act="check-review-operation">${icon('refresh', 14)} 查狀態並重新讀取</button></div></div>` : ''}

  <div class="card mt-12 mb-16">
    <div style="padding:14px 16px" class="row-between wrap gap-12">
      <div class="row gap-12 wrap">
        <label class="check" style="margin:0">
          <input type="checkbox" id="rv-select-all" ${allSelected ? 'checked' : ''}
            ${!canTick || reviewLocked || !allRows.length ? 'disabled' : ''}>
          全選待批（${allRows.length}）
        </label>
        <span class="badge ${selected.length ? 'b-info' : 'b-grey'}" id="rv-selected-count">
          已選 <b>${selected.length}</b> 項${selected.length ? `（進度 ${selectedReqs}、履歷 ${selectedLogs}）` : ''}
        </span>
        ${selected.length ? `<button class="btn btn-xs" data-act="clear-reviews" ${reviewLocked ? 'disabled' : ''}>清除選擇</button>` : ''}
      </div>
      <button class="btn btn-primary" data-act="bulk-approve"
        ${!canTick || reviewLocked || !selected.length ? 'disabled' : ''}>${icon('check', 15)}
        ${reviewing ? '批准中…' : unresolved ? '先查上次操作狀態' : `批量批准${selected.length ? `（${selected.length}）` : ''}`}</button>
    </div>
    <div style="padding:0 16px 14px" class="xs muted">
      防手誤：未選不可送出；送出前會再列出數量確認。拒絕仍逐項確認，避免一批誤拒。
    </div>
  </div>

  <div class="row-between wrap gap-12 mb-12">
    <div class="sm muted">待批完成 <b>${reqs.length}</b> 項 · 待批履歷 <b>${logReqs.length}</b> 條</div>
    <div class="field" style="margin:0"><label class="label xs">確認日期（批准進度時用；留空＝用申報日期）</label>
      <input class="input" id="rv-date" type="date" value="${esc(reviewDate)}" style="width:auto"></div>
  </div>

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">待批完成（${reqs.length}）</div>
      <div class="card-sub">勾選後可連同履歷一次批量批准，寫入「進度追蹤」</div></div></div>
    ${reqs.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th class="center" style="width:54px">選取</th><th>團員</th><th>YMIS</th><th>項目</th><th>申報日期</th><th>證明／備註</th><th>申請時間</th><th class="right">其他操作</th></tr></thead>
      <tbody>${reqs.map(r => `<tr>
        <td class="center">${selector('req', r.request_id, `選取 ${r.name || r.ymis || ''} ${r.item_name || r.item_id || ''}`)}</td>
        <td class="semibold sm">${esc(r.name || '')}</td>
        <td class="mono xs">${esc(r.ymis || '')}</td>
        <td class="sm">${esc(r.item_name || '')}<div class="xs faint mono">${esc(r.item_id || '')}</div></td>
        <td class="mono sm">${esc(r.requested_date || '')}</td>
        <td class="sm">${r.evidence && safeHref(r.evidence, { allowRelative: false, allowContact: false }) !== '#'
          ? `<a href="${esc(safeHref(r.evidence, { allowRelative: false, allowContact: false }))}" target="_blank" rel="noopener noreferrer" class="xs">連結</a>`
          : '<span class="faint xs">—</span>'}</td>
        <td class="mono xs">${esc(r.created_at || '')}</td>
        <td class="right">${rejectAction('req', r.request_id)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div style="padding:16px" class="sm faint">冇待批完成申請</div>`}
  </div>

  <div class="card">
    <div class="card-head"><div><div class="card-title">待批履歷（${logReqs.length}）</div>
      <div class="card-sub">勾選後可連同進度一次批量批准，寫入「活動履歷」</div></div></div>
    ${!supported ? `<div style="padding:16px" class="sm muted">後端未建「待批履歷」分頁 —— 去 Apps Script 執行一次 <code>initializeSheets</code> 就會有。</div>`
      : logReqs.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th class="center" style="width:54px">選取</th><th>種類</th><th>團員</th><th>日期</th><th>標題</th><th>角色／時數</th><th>申請時間</th><th class="right">其他操作</th></tr></thead>
      <tbody>${logReqs.map(r => `<tr>
        <td class="center">${selector('log', r.request_id, `選取 ${r.name || r.ymis || ''} ${r.title || ''}`)}</td>
        <td class="sm">${esc(r.kind === 'edit' ? '修改' : '新增')}</td>
        <td class="semibold sm">${esc(r.name || '')}<div class="xs faint mono">${esc(r.ymis || '')}</div></td>
        <td class="mono sm">${esc(String(r.date || '').slice(0, 10))}</td>
        <td class="sm">${esc(r.title || '')}${r.detail ? `<div class="xs faint">${esc(String(r.detail).slice(0, 60))}</div>` : ''}</td>
        <td class="sm">${esc(r.role || '')}${r.hours ? ` · ${esc(r.hours)} 小時` : ''}</td>
        <td class="mono xs">${esc(r.created_at || '')}</td>
        <td class="right">${rejectAction('log', r.request_id)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div style="padding:16px" class="sm faint">冇待批履歷申報</div>`}
  </div>`;
}

/* ---------- 資料來源：同一 Unified Sheet 的 action 結果 ---------- */
function settingsView() {
  const c = progressCfg();
  if (!c.serverSide) return needSetup();
  const ticks = remote
    ? Object.values(remote.data?.progress || {}).reduce((total, person) => total + Object.keys(person || {}).length, 0)
    : null;
  return `
  <div class="grid g-2-1">
    <div class="card">
      <div class="card-head"><div><div class="card-title">同一 Unified Sheet 資料來源</div>
        <div class="card-sub">vs_portal 功能完整版與 vsbadge 輕量版前端按獲准 action 使用同一支完整 GS</div></div>
        <span class="badge ${remote ? 'b-ok' : errMsg ? 'b-danger' : 'b-warn'}"><span class="dot"></span>${remote ? '已成功讀取' : errMsg ? 'Progress 讀取失敗' : '尚未讀取'}</span></div>
      <div style="padding:16px 18px" class="sm muted">
        ${noteBoxHtml(`${icon('shield', 15)}<div>瀏覽器不保存 <code>/exec</code> 或 API Key；平台只使用<br>
          <code>TROOP_${esc(c.unit || '0082')}_NAME</code>、<code>_BACKEND</code>、<code>_APIKEY</code>。
          一個 <code>/exec</code>、一個 API Key、一張 Sheet；API Key 不是用戶身份，功能有冇顯示亦唔係授權。</div>`, 'ok')}
        <div class="note-box info mt-12"><div class="sm"><b>空分頁亦係成功結果。</b>
          新 Sheet 的「進度追蹤」沒有紀錄時應顯示 0，唔會當成讀取失敗；Progress 亦不會另建或另查 BADGE 後端。</div></div>
        ${errMsg ? `<div class="note-box danger mt-12">${icon('alert', 15)}<div><b>最近一次 Progress action 失敗：</b>${esc(errMsg)}</div></div>` : ''}
        <div class="row gap-8 mt-12">
          <button class="btn btn-primary" data-act="reload">${icon('refresh', 15)} 重新讀取同一 Sheet</button>
          <button class="btn" data-go="#/progress/overview">返回進度總覽</button>
        </div>
      </div>
    </div>
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">資料讀取結果</div></div>
        <div style="padding:14px 16px">
          ${kvHtml([
            ['資料來源', '<span style="color:var(--ok)">同一 Unified GAS／Sheet</span>'],
            ['Registry', 'NAME／BACKEND／APIKEY 已由 server 登記'],
            ['進度分頁', '進度追蹤／其他獎章／待批完成／活動履歷／待批履歷／成員名單'],
            ['讀取結果', remote
              ? '<span style="color:var(--ok)">Progress action 成功</span>'
              : errMsg
                ? `<span style="color:var(--danger)">Progress action 失敗：${esc(errMsg)}</span>`
                : '尚未執行 Progress action'],
            ['考核項目', catalog ? `${Object.keys(catalog).length} 項` : '未讀取'],
            ['讀到嘅成員', remote ? String((remote.data.members || []).length) : '—'],
            ['進度紀錄', ticks == null ? '—' : `${ticks} 格`],
            ['上次讀取', remote ? esc(remote.at) : '—']
          ])}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">支部帳戶同樣喺呢張 Sheet</div>
          <div class="card-sub">Users 係唯一帳戶權威；唔需要去另一套系統開戶</div></div></div>
        <div style="padding:14px 16px" class="sm muted">
          團長／領袖可以由功能完整版前端直接單戶或批量開戶、重設密碼及管理登入狀態；
          操作會直接寫入同一 Unified Sheet 的 <b>Users</b>，首次密碼預設為 <b>1234</b>並強制更改。
          <div class="row gap-8 mt-10 wrap">
            <button class="btn btn-sm btn-primary" data-go="#/members">${icon('users', 15)} 直接開戶／批量開戶</button>
            <button class="btn btn-sm" data-go="#/members/accounts">${icon('shield', 15)} 身份與帳號</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">同一 Sheet 對人</div></div>
        <div style="padding:14px 16px" class="sm muted">
          用<b>會籍編號（YMIS）</b>對同一個人。現時對得上：<b>${keyCoverage(members(), { youthOnly: true }).percent}%</b>
          （${keyCoverage(members(), { youthOnly: true }).matched}／${keyCoverage(members(), { youthOnly: true }).total} 位團員／執委。）
          <div class="mt-8"><button class="btn btn-sm btn-block" data-go="#/members">${icon('users', 15)} 去用戶名冊填 YMIS</button></div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   頁面
   ============================================================ */
export function render(params) {
  if (params?.id && ['overview', 'members', 'tick', 'review', 'settings'].includes(params.id)) tab = params.id;
  else tab = 'overview';   // 由側邊欄入返嚟時，返去總覽
  const configured = progressConfigured();
  /* 分頁數字要同「成員進度」表格一致 —— summarizeRemote 會剔走管理員／領袖，
     以前呢度直接用後端 raw members 數，搞到「標籤 12 人、表得 11 行」。 */
  const memberCount = configured && remote
    ? summarizeRemote(remote.data, { catalog, roster: members() }).memberCount
    : 0;

  return `
  ${pageHead({
    title: '進度紀錄',
    sub: configured
      ? `${progressCfg().name} · 直接讀同一 Unified Sheet 嘅進度分頁${remote ? ` · 上次讀取 ${remote.at}` : ''}`
      : '未登記資料來源 —— 請平台管理員核對 NAME／BACKEND／APIKEY',
    actions: `
      <button class="btn btn-sm" data-act="reload" ${configured ? '' : 'disabled'}>${icon('refresh', 15)} ${loading ? '讀取中…' : '重新讀取'}</button>
      <button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 資料來源</button>`
  })}

  ${tabs([
    ['overview', '總覽'],
    ...(configured ? [
      ['members', `成員進度${remote ? `（${memberCount}）` : ''}`],
      ['tick', can('progress.tick') ? '勾選進度' : '勾選進度（無權限）', Object.keys(pending).length || undefined],
      ['review', `審批中心${reviewCount() ? `（${reviewCount()}）` : ''}`]
    ] : []),
    ['settings', configured ? '資料來源' : '資料來源（未登記）']
  ], tab)}

  ${tab === 'settings' ? settingsView()
    : !configured ? needSetup()
    : tab === 'members' ? membersView()
    : tab === 'tick' ? tickView()
    : tab === 'review' ? reviewView()
    : overviewView()}`;
}

export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  /* 分頁掣由 main.js 統一綁（ui.js tabs() → [data-tabnav]），呢度唔使再綁 */

  /* Route once through hashchange.  The old go()+immediate refresh double-render could
     replace the clicked DOM before navigation cleanup, leaving a stale overlay above
     the data-source page and making every control look dead. */
  root.querySelectorAll('[data-act="settings"]').forEach(b => b.addEventListener('click', () => {
    go('#/progress/settings');
  }));
  root.querySelectorAll('[data-act="reload"]').forEach(b => b.addEventListener('click', () => fetchAll()));
  root.querySelector('[data-act="check-review-operation"]')?.addEventListener('click', async () => {
    const pendingOp = unresolvedReviewOperation();
    if (!pendingOp?.operationId || reviewing) return;
    reviewing = true; refresh();
    const status = await checkProgressOperation(pendingOp.operationId);
    const outcome = String(status?.operation?.outcome || status?.data?.operation?.outcome || status?.outcome || 'unknown');
    await fetchAll({ silent: true });
    reviewing = false;
    if (outcome === 'applied' || outcome === 'not_applied' || outcome === 'not_sent') {
      finishOperation(pendingOp.operationId, { state: outcome, outcome, mayHaveApplied: outcome === 'applied' });
      uncertainReview = null;
      if (outcome === 'applied') reviewSelection.clear();
      toast(outcome === 'applied' ? '操作日誌顯示已套用；已重新讀取核對' : '操作日誌顯示未套用；已解除鎖定，可重新檢查後再做', outcome === 'applied' ? 'ok' : 'warn');
    } else {
      uncertainReview = pendingOp;
      toast('狀態仍然未知／處理中；冇重送，審批繼續鎖住', 'warn');
    }
    refresh();
  });

  /* 成員搜尋 / 明細 */
  const ms = root.querySelector('#mSearch');
  if (ms) {
    ms.addEventListener('input', () => { memberSearch = ms.value; refresh(); });
    ms.addEventListener('keydown', e => { if (e.key === 'Enter') refresh(); });
  }
  root.querySelectorAll('[data-member]').forEach(b => b.addEventListener('click', () => openMemberDetail(b.dataset.member)));

  /* 勾選 */
  const tickMember = root.querySelector('#tickMember');
  if (tickMember) tickMember.addEventListener('change', () => { selYmis = tickMember.value; refresh(); });
  const tickDateEl = root.querySelector('#tickDate');
  if (tickDateEl) tickDateEl.addEventListener('change', () => { tickDate = tickDateEl.value; });
  root.querySelectorAll('[data-badge]').forEach(b => b.addEventListener('click', () => { selBadge = b.dataset.badge; refresh(); }));
  root.querySelectorAll('[data-tick]').forEach(cb => cb.addEventListener('change', () => {
    const itemId = cb.dataset.tick;
    const key = `${selYmis}|${itemId}`;
    const orig = !!((remote?.data?.progress || {})[selYmis] || {})[itemId];
    if (cb.checked === orig) delete pending[key];
    else pending[key] = cb.checked;
    refresh();
  }));
  root.querySelectorAll('[data-bulk]').forEach(b => b.addEventListener('click', () => {
    const [badgeId, on] = b.dataset.bulk.split('|');
    const data = remote?.data || {};
    const done = (data.progress || {})[selYmis] || {};
    Object.values(catalog || {}).filter(i => i.badgeId === badgeId).forEach(i => {
      const key = `${selYmis}|${i.id}`;
      const val = on === '1';
      if (val === !!done[i.id]) delete pending[key]; else pending[key] = val;
    });
    refresh();
  }));
  root.querySelector('[data-act="undo-ticks"]')?.addEventListener('click', () => { pending = {}; toast('已放棄未儲存嘅改動', 'ok'); refresh(); });
  root.querySelector('[data-act="save-ticks"]')?.addEventListener('click', async () => {
    if (!can('progress.tick')) { toast('你冇勾選權限', 'err'); return; }
    const unresolved = pendingProgressWrite('save');
    if (unresolved) {
      const status = await checkProgressOperation(unresolved.id);
      const outcome = String(status?.operation?.outcome || status?.data?.operation?.outcome || status?.outcome || 'unknown');
      if (outcome === 'applied' || outcome === 'not_applied') {
        finishOperation(unresolved.id, { state: outcome, outcome, mayHaveApplied: outcome === 'applied' });
        if (outcome === 'applied') { pending = {}; await fetchAll({ silent: true }); }
        toast(outcome === 'applied' ? '上次操作已套用；已重新讀取，冇重送' : '上次操作確定未套用；請重新核對再儲存', outcome === 'applied' ? 'ok' : 'warn');
        refresh();
      } else toast(`上次操作 ${unresolved.id} 仍然未知；今次冇重送`, 'warn');
      return;
    }
    const changes = Object.entries(pending).map(([key, val]) => {
      const [ymis, itemId] = key.split('|');
      return { ymis, itemId, date: tickDate || todayISO(), uncomplete: !val, note: '' };
    });
    if (!changes.length) return;
    const onCount = changes.filter(c => !c.uncomplete).length;
    const offCount = changes.length - onCount;
    const selectedMember = (remote?.data?.members || []).find(m => String(m.ymis || '') === String(selYmis || ''));
    const ok = await confirmBulkOperation({
      title: 'Dry-run：批量更新進度', actionLabel: `確認寫入 ${changes.length} 項`, count: changes.length,
      scope: `${selectedMember?.name || selYmis || '所選成員'}／${selBadge === 'all' ? '全部獎章' : selBadge}`,
      requireText: `確認 ${changes.length}`, danger: offCount > 0,
      changes: [
        { label: '新增完成', before: 0, after: onCount },
        { label: '取消完成', before: 0, after: offCount },
        { label: '確認日期', before: '—', after: tickDate || todayISO() }
      ],
      preview: changes.slice(0, 80).map(c => ({ label: catalog?.[c.itemId]?.name || c.itemId, before: c.uncomplete ? '已完成' : '未完成', after: c.uncomplete ? '取消完成' : '標記完成' })),
      warnings: offCount ? [`今次會取消 ${offCount} 項已完成進度；請特別核對。`] : [],
      backupText: '後端會保留操作編號；送出前本機 pending 清單仍然保留。',
      rollbackText: '如批錯，可用相反勾選建立一個清楚可核對嘅更正操作；系統唔會暗中覆寫。',
      readbackText: '完成後會重新讀取同一 Unified Sheet，核對最新進度。'
    });
    if (!ok) return;
    const r = await saveTicks(changes, current()?.name || '深資童軍管理系統');
    if (!r.ok) {
      if (r.outcome === 'unknown' || r.mayHaveApplied) toast(`${r.error} 操作編號：${r.operationId || '（未提供）'}；請再撳儲存只會查狀態，唔會重送。`, 'warn');
      else toast(r.error || '寫入確定未套用', 'err');
      return;
    }
    const processed = r.data?.processed ?? changes.length;
    toast(`已寫入後端：新增 ${onCount} 項、取消 ${offCount} 項（後端處理 ${processed} 項）`, 'ok');
    pending = {};
    await fetchAll({ silent: true });
  });

  /* 審批中心：先 tick，再用一個 backend request 批量批准；拒絕逐項確認。 */
  const rvDate = root.querySelector('#rv-date');
  if (rvDate) rvDate.addEventListener('change', () => { reviewDate = rvDate.value; });
  root.querySelector('#rv-select-all')?.addEventListener('change', e => {
    if (!can('progress.tick') || reviewing) return;
    if (e.currentTarget.checked) {
      pendingReviewRows().forEach(item => reviewSelection.add(reviewKey(item.kind, item.request_id)));
    } else {
      reviewSelection.clear();
    }
    refresh();
  });
  root.querySelectorAll('[data-review-select]').forEach(cb => cb.addEventListener('change', () => {
    if (!can('progress.tick') || reviewing) return;
    const key = reviewKey(cb.dataset.kind, cb.dataset.id);
    if (cb.checked) reviewSelection.add(key); else reviewSelection.delete(key);
    refresh();
  }));
  root.querySelector('[data-act="clear-reviews"]')?.addEventListener('click', () => {
    if (reviewing) return;
    reviewSelection.clear();
    refresh();
  });
  root.querySelector('[data-act="bulk-approve"]')?.addEventListener('click', async () => {
    if (!can('progress.tick')) { toast('你冇審批權限（要領袖或執委）', 'err'); return; }
    if (reviewing) return;
    reconcileReviewSelection();
    const selected = selectedReviewRows();
    if (!selected.length) { toast('請先 tick 至少一項待批申請', 'warn'); return; }
    const reqCount = selected.filter(item => item.kind === 'req').length;
    const logCount = selected.length - reqCount;
    const yes = await confirmBulkOperation({
      title: 'Dry-run：批量批准申報', actionLabel: `確認批准 ${selected.length} 項`, count: selected.length,
      scope: `待批中心／進度 ${reqCount} 項／履歷 ${logCount} 項`, requireText: `確認 ${selected.length}`,
      changes: [
        { label: '待批申報', before: selected.length, after: 0 },
        { label: '新增完成進度', before: 0, after: reqCount },
        { label: '新增履歷', before: 0, after: logCount },
        { label: '確認日期', before: '申報日期', after: reviewDate || '各項申報日期' }
      ],
      preview: selected.slice(0, 100).map(item => {
        const row = item.row || {};
        return { label: `${row.name || row.ymis || ''} · ${item.kind === 'log' ? (row.title || '履歷申報') : (row.item_name || row.item_id || '進度申報')}`,
          before: '待批', after: item.kind === 'log' ? '批准並加入履歷' : '批准並標記完成' };
      }),
      warnings: ['瀏覽器只會送一次 request；Unified 後端會先驗齊整批，再喺同一個鎖內寫入。'],
      backupText: '原申報記錄會保留狀態、審批人同時間，操作亦有 operation ID。',
      rollbackText: '如批錯，領袖要用進度更正／履歷管理做有記錄嘅修正，唔會靜靜刪原申報。',
      readbackText: '完成後會重新讀取待批、進度同履歷，核對實際處理數。'
    });
    if (!yes) return;
    reviewing = true; refresh();
    const r = await bulkReviewRequests(selected.map(item => ({
      kind: item.kind, request_id: item.request_id
    })), { confirmedDate: reviewDate });
    reviewing = false;
    if (!r.ok) {
      if (r.outcome === 'unknown' || r.mayHaveApplied) {
        uncertainReview = { operationId: r.operationId || '', count: selected.length, unit: String(progressCfg().unit || '') };
        toast(`${r.error || '批量操作結果未知'} 操作編號：${r.operationId || '（未提供）'}；已鎖住再次審批，唔會重送。`, 'warn');
      } else {
        toast(r.error || '批量審批確定未套用；選擇已保留', 'err');
      }
      refresh(); return;
    }
    const processed = Number(r.data?.processed ?? selected.length);
    reviewSelection.clear();
    toast(r.data?.message || `已批量批准 ${processed} 項 ✓`, 'ok');
    await fetchAll({ silent: true });
  });

  root.querySelectorAll('[data-rev-id]').forEach(b => b.addEventListener('click', async () => {
    if (!can('progress.tick')) { toast('你冇審批權限（要領袖或執委）', 'err'); return; }
    if (reviewing) return;
    const unresolved = pendingProgressWrite(['reviewRequest', 'reviewLogRequest']);
    if (unresolved) {
      const status = await checkProgressOperation(unresolved.id);
      const outcome = String(status?.operation?.outcome || status?.data?.operation?.outcome || status?.outcome || 'unknown');
      if (outcome === 'applied' || outcome === 'not_applied') {
        finishOperation(unresolved.id, { state: outcome, outcome, mayHaveApplied: outcome === 'applied' });
        await fetchAll({ silent: true });
        toast(outcome === 'applied' ? '上次審批已套用；已重新讀取，冇重送' : '上次審批未套用；請重新核對', outcome === 'applied' ? 'ok' : 'warn');
      } else toast(`上次審批 ${unresolved.id} 結果仍未知；今次冇重送`, 'warn');
      return;
    }
    const kind = b.dataset.revKind;
    const id = b.dataset.revId;
    const decision = b.dataset.revDecision;
    /* 防呆：批／拒都一定要撳「確定」先生效（唔會一撳就寫入後端） */
    const row = kind === 'log'
      ? (remote?.data?.logRequests || []).find(x => String(x.request_id) === String(id))
      : (remote?.data?.pendingRequests || []).find(x => String(x.request_id) === String(id));
    const who = row ? esc(row.name || row.ymis || '') : '';
    const what = kind === 'log'
      ? esc(row?.title || '') + (row?.date ? `（${esc(String(row.date).slice(0, 10))}）` : '')
      : esc(row?.item_name || row?.item_id || '');
    const when = reviewDate ? `確認日期：<b>${esc(reviewDate)}</b>` : '確認日期：<b>申報日期</b>';
    const yes = await modal({
      title: decision === 'approved' ? '確定批准？' : '確定拒絕？',
      danger: decision !== 'approved',
      trustedBodyHtml: `<p class="sm">${decision === 'approved'
          ? '批准會即刻寫入同一 Unified Sheet，功能完整版支部前端同 BADGE 輕量前端都見到。'
          : '拒絕只會改狀態，唔會刪紀錄，團員可以重新申報。'}</p>
        <div class="note-box mt-8"><div class="sm"><b>${who}</b> · ${what}<br>${when}</div></div>`,
      actions: [{ label: '取消', class: 'btn', value: false },
        { label: decision === 'approved' ? '確定批准' : '確定拒絕', class: decision === 'approved' ? 'btn-primary' : 'btn-accent', value: true }]
    });
    if (!yes) return;
    reviewing = true; refresh();
    const reviewer = current()?.name || '深資童軍管理系統';
    const r = kind === 'log'
      ? await reviewLogRequest(id, { decision, reviewer })
      : await reviewRequest(id, { decision, reviewer, confirmedDate: reviewDate });
    reviewing = false;
    if (!r.ok) {
      toast(r.outcome === 'unknown' || r.mayHaveApplied
        ? `${r.error || '審批結果未知'} 操作編號：${r.operationId || '（未提供）'}；唔會自動重送。`
        : (r.error || '審批確定未套用'), r.outcome === 'unknown' || r.mayHaveApplied ? 'warn' : 'err');
      refresh(); return;
    }
    toast(r.data?.message || (decision === 'approved' ? '已批准 ✓' : '已拒絕'), 'ok');
    await fetchAll({ silent: true });
  }));

  /* 第一次入嚟：自動讀一次 */
  if (progressConfigured() && !remote && !loading && !errMsg) setTimeout(() => fetchAll({ silent: true }), 30);
}
