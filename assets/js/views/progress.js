/* ============================================================
   progress.js — 進度紀錄（一個 Unified 後端、多個前端）
   ------------------------------------------------------------
   統一設計：
     · 深資童軍管理系統唔會另接進度系統或第二支 GAS。
     · 行政、進度與 BADGE 都寫入旅團同一個 Google Sheet＋Unified /exec；
       前端只係不同介面，唔會建立第二份名冊或身份來源。
     · 所以呢邊只做兩件事：讀同一後端、寫同一後端。API Key 只係 server routing／HMAC 根，
       用戶身份必須由 server-issued session 核實。

   讀：POST /api/progress { action:'load', unit, sessionToken }
   寫：POST /api/progress { action:'save'|'saveOtherBadge', unit, sessionToken }
       （/exec 與 API Key 只留 server Registry，瀏覽器不能另指後端）

   分頁：總覽 / 成員進度 / 勾選進度 / 審批中心 / 設定
   ============================================================ */

import { profile, members, keyCoverage, progressRoster, progressIgnored, identityOf } from '../lib/model.js';
import { esc, icon, modal, toast, todayISO } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, noteBox, kv, chipbar, progressBar } from './ui.js';
import {
  progressCfg, progressConfigured,
  loadRemote, loadItems, saveTicks, flattenItems, summarizeRemote, memberDetail,
  reviewRequest, reviewLogRequest
} from '../lib/progress.js';

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
    errMsg = r.error || '讀取失敗';
    /* Unified GAS 閂咗本地直接入口時，API 會改用同一 API Key 派生的簽名。
       如果 signed path 都失敗，就如實顯示 Registry／Key 不一致。 */
    if (r.upstream_only) {
      errMsg = (r.linked
        ? '同一 Unified 後端閂咗「直接入口」，簽名亦被拒 —— 請管理員核對 Vercel APIKEY 同 GAS API_KEY 完全相同。'
        : '同一 Unified 後端只接受簽名請求；請管理員核對 BADGE 與支部 APP 共用的 BACKEND／APIKEY。');
    }
    refresh();
    return;
  }
  remote = { data: r.data || {}, at: new Date().toLocaleString('zh-HK', { hour12: false }) };
  const it = await loadItems();
  if (it.ok) catalog = flattenItems(it.data);
  loading = false;
  refresh();
}

/** 未接駁：只顯示 server Registry 合約，不再叫用戶把 Key 放入 browser。 */
function needSetup() {
  const unit = progressCfg().unit || '0082';
  return `
  <div class="card" style="max-width:780px">
    <div class="card-head"><div><div class="card-title">同一 Unified Sheet 資料來源尚未登記</div>
      <div class="card-sub">管理、進度及 BADGE 共用一支 GAS；前端之間不需要互相接駁</div></div></div>
    <div style="padding:16px 18px" class="sm muted">
      ${noteBox('<b>唔好喺瀏覽器貼 API Key。</b>平台管理員只需在 Vercel 登記同 BADGE 完全相同的三個值；'
        + '進度頁會自動沿用，亦不接受第二個進度後端。', 'brand')}
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
    <div class="sm mt-4">連線正常。「進度追蹤」分頁而家係空，所以每個人顯示 0；新建 Sheet 本來就會係呢個狀態。
    之後經 Progress 或 BADGE 寫入同一分頁，數字就會直接更新。</div>
    <div class="row gap-8 mt-8 wrap">
      <button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 查看同一 Sheet 資料來源</button>
    </div></div></div>`;
}

function overviewView() {
  if (!progressConfigured()) return needSetup();
  if (errMsg) {
    return `<div class="note-box warn">${icon('alert', 15)}<div><b>讀唔到後端：</b>${esc(errMsg)}
      <div class="xs mt-4">如果係「Invalid API Key」→ 去 Apps Script 重新複製 API Key；
        如果係「搵唔到 <code>progress</code>」→ 喺後端執行一次 <code>initializeSheets</code>。</div></div></div>
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
    喺呢度勾選＝直接寫入<b>同一 Unified Sheet</b>（管理系統同 BADGE 共用），效果一樣。
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
          <button class="btn btn-xs" data-bulk="${g.id}|1">全勾</button>
          <button class="btn btn-xs" data-bulk="${g.id}|0">全清</button>
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
    body: `
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
function reviewView() {
  if (!progressConfigured()) return needSetup();
  if (!remote) return empty('check', '未讀取後端', '按右上「重新讀取」');
  const reqs = remote.data.pendingRequests || [];
  const logReqs = remote.data.logRequests || [];
  const supported = remote.data.logRequestsSupported !== false;
  const canTick = can('progress.tick');

  const actions = (kind, id) => canTick ? `
    <div class="row gap-6">
      <button class="btn btn-xs btn-primary" data-rev-kind="${kind}" data-rev-id="${esc(id)}"
        data-rev-decision="approved" ${reviewing ? 'disabled' : ''}>批准</button>
      <button class="btn btn-xs" data-rev-kind="${kind}" data-rev-id="${esc(id)}"
        data-rev-decision="rejected" ${reviewing ? 'disabled' : ''}>拒絕</button>
    </div>` : '<span class="xs faint">需要勾選權限</span>';

  if (!reqs.length && !logReqs.length) {
    return `${noteBox('後端冇待批嘅申請 —— 團員喺進度前端申報之後，就會自動出現在呢度，唔使去其他系統。', 'ok')}
      <div class="row gap-8 mt-12"><button class="btn" data-act="reload">${icon('refresh', 15)} 重新讀取</button></div>`;
  }

  return `
  ${noteBox(canTick
    ? '喺呢度<b>直接批</b>：批准＝即時寫入同一 Unified Sheet（進度追蹤／活動履歷），管理系統同 BADGE 都即刻見到。'
    : '你冇勾選／審批權限 —— 可以睇，但要領袖或執委先批得。',
    canTick ? 'ok' : 'warn')}

  <div class="row-between wrap gap-12 mt-12 mb-12">
    <div class="sm muted">待批完成 <b>${reqs.length}</b> 項 · 待批履歷 <b>${logReqs.length}</b> 條</div>
    <div class="field" style="margin:0"><label class="label xs">確認日期（批准時用；留空＝用申報日期）</label>
      <input class="input" id="rv-date" type="date" value="${esc(reviewDate)}" style="width:auto"></div>
  </div>

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">待批完成（${reqs.length}）</div>
      <div class="card-sub">團員自己申報嘅考核項目 —— 批准就會寫入「進度追蹤」</div></div></div>
    ${reqs.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th>團員</th><th>YMIS</th><th>項目</th><th>申報日期</th><th>證明／備註</th><th>申請時間</th><th class="right">審批</th></tr></thead>
      <tbody>${reqs.map(r => `<tr>
        <td class="semibold sm">${esc(r.name || '')}</td>
        <td class="mono xs">${esc(r.ymis || '')}</td>
        <td class="sm">${esc(r.item_name || '')}<div class="xs faint mono">${esc(r.item_id || '')}</div></td>
        <td class="mono sm">${esc(r.requested_date || '')}</td>
        <td class="sm">${r.evidence ? `<a href="${esc(r.evidence)}" target="_blank" rel="noopener" class="xs">連結</a>` : '<span class="faint xs">—</span>'}</td>
        <td class="mono xs">${esc(r.created_at || '')}</td>
        <td class="right">${actions('req', r.request_id)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div style="padding:16px" class="sm faint">冇待批完成申請</div>`}
  </div>

  <div class="card">
    <div class="card-head"><div><div class="card-title">待批履歷（${logReqs.length}）</div>
      <div class="card-sub">團員自行申報嘅服務／活動紀錄 —— 批准就會寫入「活動履歷」</div></div></div>
    ${!supported ? `<div style="padding:16px" class="sm muted">後端未建「待批履歷」分頁 —— 去 Apps Script 執行一次 <code>initializeSheets</code> 就會有。</div>`
      : logReqs.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th>種類</th><th>團員</th><th>日期</th><th>標題</th><th>角色／時數</th><th>申請時間</th><th class="right">審批</th></tr></thead>
      <tbody>${logReqs.map(r => `<tr>
        <td class="sm">${esc(r.kind === 'edit' ? '修改' : '新增')}</td>
        <td class="semibold sm">${esc(r.name || '')}<div class="xs faint mono">${esc(r.ymis || '')}</div></td>
        <td class="mono sm">${esc(String(r.date || '').slice(0, 10))}</td>
        <td class="sm">${esc(r.title || '')}${r.detail ? `<div class="xs faint">${esc(String(r.detail).slice(0, 60))}</div>` : ''}</td>
        <td class="sm">${esc(r.role || '')}${r.hours ? ` · ${esc(r.hours)} 小時` : ''}</td>
        <td class="mono xs">${esc(r.created_at || '')}</td>
        <td class="right">${actions('log', r.request_id)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : `<div style="padding:16px" class="sm faint">冇待批履歷申報</div>`}
  </div>`;
}

/* ---------- 資料來源：同一 Unified Sheet，不做前端互相接駁 ---------- */
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
        <div class="card-sub">管理、進度及 BADGE 唔係互相接駁；同一支 GAS 按 action 讀同一張 Sheet 嘅不同分頁</div></div>
        <span class="badge ${remote ? 'b-ok' : errMsg ? 'b-danger' : 'b-warn'}"><span class="dot"></span>${remote ? '已成功讀取' : errMsg ? 'Progress 讀取失敗' : '尚未讀取'}</span></div>
      <div style="padding:16px 18px" class="sm muted">
        ${noteBox(`${icon('shield', 15)}<div>瀏覽器不保存 <code>/exec</code> 或 API Key；平台只使用<br>
          <code>TROOP_${esc(c.unit || '0082')}_NAME</code>、<code>_BACKEND</code>、<code>_APIKEY</code>。
          一個 <code>/exec</code>、一個 API Key、一張 Sheet；API Key 不是用戶身份。</div>`, 'ok')}
        <div class="note-box info mt-12"><div class="sm"><b>空分頁亦係成功結果。</b>
          新 Sheet 的「進度追蹤」沒有紀錄時應顯示 0，唔會當成連線失敗；亦唔需要另建或另查 BADGE 後端。</div></div>
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
          ${kv([
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

  root.querySelectorAll('[data-act="settings"]').forEach(b => b.addEventListener('click', () => {
    tab = 'settings'; go('#/progress/settings'); refresh();
  }));
  root.querySelectorAll('[data-act="reload"]').forEach(b => b.addEventListener('click', () => fetchAll()));

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
    const changes = Object.entries(pending).map(([key, val]) => {
      const [ymis, itemId] = key.split('|');
      return { ymis, itemId, date: tickDate || todayISO(), uncomplete: !val, note: '' };
    });
    if (!changes.length) return;
    const onCount = changes.filter(c => !c.uncomplete).length;
    const offCount = changes.length - onCount;
    const r = await saveTicks(changes, current()?.name || '深資童軍管理系統');
    if (!r.ok) { toast(r.error || '儲存失敗', 'err'); return; }
    const processed = r.data?.processed ?? changes.length;
    toast(`已寫入後端：新增 ${onCount} 項、取消 ${offCount} 項（後端處理 ${processed} 項）`, 'ok');
    pending = {};
    await fetchAll({ silent: true });
  });

  /* 審批中心：批准 / 拒絕 */
  const rvDate = root.querySelector('#rv-date');
  if (rvDate) rvDate.addEventListener('change', () => { reviewDate = rvDate.value; });
  root.querySelectorAll('[data-rev-id]').forEach(b => b.addEventListener('click', async () => {
    if (!can('progress.tick')) { toast('你冇審批權限（要領袖或執委）', 'err'); return; }
    if (reviewing) return;
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
      body: `<p class="sm">${decision === 'approved'
          ? '批准會即刻寫入同一 Unified Sheet，管理系統同 BADGE 都見到。'
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
    if (!r.ok) { toast(r.error || '審批失敗', 'err'); refresh(); return; }
    toast(r.data?.message || (decision === 'approved' ? '已批准 ✓' : '已拒絕'), 'ok');
    await fetchAll({ silent: true });
  }));

  /* 第一次入嚟：自動讀一次 */
  if (progressConfigured() && !remote && !loading && !errMsg) setTimeout(() => fetchAll({ silent: true }), 30);
}
