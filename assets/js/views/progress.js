/* ============================================================
   progress.js — 進度紀錄（一個後端、兩個前端）
   ------------------------------------------------------------
   團長 2026-09-16 更正設計：
     · 深資童軍管理系統**唔需要連去任何其他系統**（唔開分頁、唔用 portal）
     · 重點係：進度資料本來就係寫入**旅團自己嘅後端**（一個 Google Sheet
       ＋ 一支 Apps Script /exec）——後端只有一個，前端有兩個：
          ① 深資童軍管理系統（呢度）   ② 進度前端（團員／領袖用）
     · 所以呢邊只做兩件事：讀後端、寫後端。API Key 對得上就等於執委身份。

   讀：POST /api/progress { action:'load' }           → GET 後端 ?action=load
   寫：POST /api/progress { action:'save'|'saveOtherBadge' }
       （API Key 只會去同源 /api/progress，唔會出現在網址，亦唔會寫入 log）

   分頁：總覽 / 成員進度 / 勾選進度 / 審批中心 / 設定
   ============================================================ */

import { load } from '../lib/store.js';
import { profile, members, keyCoverage, progressRoster, progressIgnored, identityOf } from '../lib/model.js';
import { esc, icon, modal, toast, todayISO, confirmDlg } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, noteBox, kv, chipbar, progressBar } from './ui.js';
import {
  progressCfg, setProgressCfg, progressConfigured, progressIsRegistered,
  loadRemote, loadItems, saveTicks, flattenItems, summarizeRemote, memberDetail,
  reviewRequest, reviewLogRequest, maskBackendUrl,
  getLinkState, setLocalLogin
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
let linkMode = '';        // ''＝apikey 直連／'link'＝經 VSBADGE 旅系統簽名／'closed'＝後端閂咗直接入口
let door = null;          // ★ VSBADGE 開關掣：{ allow_local_login, link_flag_set, node, loading, hasKey } 

export function title() { return '進度紀錄'; }
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

/* ============================================================
   讀後端
   ============================================================ */
async function fetchAll({ silent = false } = {}) {
  if (!progressConfigured()) {
    /* 2026-09 修：未設定時靜默 return → 「重新讀取」撳咗冇任何反應（死掣）。
       而家俾個提示，話畀用家知要填咗設定先讀得到。 */
    if (!silent) toast('尚未設定進度後端——請喺「設定」填入 /exec 網址同 API Key', 'info');
    return;
  }
  loading = true; errMsg = '';
  if (!silent) refresh();
  const r = await loadRemote();
  if (!r.ok) {
    loading = false; remote = null;
    errMsg = r.error || '讀取失敗';
    /* ★ VSBADGE 旅系統接駁：後端閂咗「直接入口」嗰陣，API 會帶 upstream_only。
       如果經簽名都入到（linked）就唔會嚟到呢度；嚟到＝真係入唔到，照直講。 */
    if (r.upstream_only) {
      errMsg = (r.linked
        ? '進度後端閂咗「直接入口」，簽名都入唔到 —— 請核對 API Key 係咪嗰張進度 Sheet 嘅 SHEET KEY。'
        : '進度後端閂咗「直接入口」（進度前端／VSBADGE 嘅「旅系統」設定），只接受簽名請求。'
          + '去「進度 → 設定」貼返嗰張進度 Sheet 嘅 API Key（Apps Script 執行 showApiKey()），系統就會自動用簽名接駁。');
    }
    refresh();
    return;
  }
  remote = { data: r.data || {}, at: new Date().toLocaleString('zh-HK', { hour12: false }) };
  linkMode = r.linked ? 'link' : (r.upstream_only ? 'closed' : '');
  const it = await loadItems();
  if (it.ok) catalog = flattenItems(it.data);
  loading = false;
  refresh();
}

/** 未接駁：一步一步教（唔使去任何其他網站，只係去自己嗰張 Sheet） */
function needSetup() {
  const c = progressCfg();
  const reg = progressIsRegistered();
  return `
  <div class="card" style="max-width:780px">
    <div class="card-head"><div><div class="card-title">第一步：同你嘅後端對上</div>
      <div class="card-sub">一個後端、兩個前端 —— 進度資料就喺旅團自己嘅 Google Sheet，唔使去其他系統</div></div></div>
    <div style="padding:16px 18px" class="sm muted">
      ${noteBox('<b>設計係咁：</b>旅團只有<b>一個後端</b>（Google Sheet ＋ Apps Script）——'
        + '深資童軍管理系統同進度前端係<big>兩個前端</big>，共用同一份資料。所以呢度只係「讀／寫你嘅後端」，'
        + '唔會連去任何其他網站。', 'brand')}
      <ol style="padding-left:18px;line-height:1.95" class="mt-8">
        <li>打開旅團嘅 Google Sheet → 擴充功能 → Apps Script</li>
        <li>如果未有後端：貼上「系統 → 資料管理 → 總表同步」下載嘅 <code>Code.gs</code>，執行 <code>initializeSheets</code>
          （會建好 進度追蹤／其他獎章／活動履歷 等分頁）</li>
        <li>複製 <b>API Key</b>（執行 <code>showApiKey()</code>）同 <b>網頁應用程式 /exec 網址</b></li>
        <li>返嚟喺「<b>設定</b>」填入（或者叫管理員登記喺 <code>data/units.json</code>，就唔使每次填）</li>
      </ol>
      ${reg ? `<div class="hint mt-8">你嘅旅團後端已經登記好，只要補 API Key 就得。</div>` : ''}
      ${c.backend && !c.apiKey ? `<div class="hint mt-8">已有後端網址（${esc(maskUrl(c.backend))}），欠 API Key。</div>` : ''}
      <div class="row gap-8 mt-12 wrap">
        <button class="btn btn-primary" data-act="settings">${icon('settings', 16)} 去設定</button>
        <button class="btn" data-go="#/admin/data">${icon('cloud', 16)} 下載 Code.gs</button>
      </div>
    </div>
  </div>`;
}

/** 待批總數（分頁標籤用） */
function reviewCount() {
  const d = remote?.data || {};
  return (d.pendingRequests || []).length + (d.logRequests || []).length;
}

const maskUrl = u => String(u || '').replace(/\/macros\/s\/[^/]+/, '/macros/s/…');


/* ============================================================
   ★ 2026-09-25 VSBADGE 開關掣（本系統閂／開 VSBADGE 後端嘅「直接入口」）
   ------------------------------------------------------------
   掣喺**呢邊**先有（防 VSBADGE 前端有人誤關）；閂嘅係 VSBADGE 嗰支後端，
   唔會掂本系統。授權喺伺服器端嗰條 SHEET KEY（＝進度後端自己嘅 API_KEY）。
   ============================================================ */
async function refreshDoor() {
  door = { loading: true, hasKey: false };
  refresh();
  const r = await getLinkState();
  if (r.ok && r.data) {
    door = {
      loading: false,
      hasKey: true,
      allow_local_login: r.data.allow_local_login,
      node: r.data.node || '',
      link_flag_set: r.data.link_flag_set,
      at: new Date().toLocaleString('zh-HK', { hour12: false })
    };
  } else {
    /* 讀唔到＝後端唔係 vsbadge 旅系統版／冇 key 簽唔到名（server 回 no_sign_key）。 */
    door = { loading: false, hasKey: false, error: r.error || '讀唔到 VSBADGE 後端狀態' };
  }
  refresh();
  return door;
}

async function doorToggle(toClose) {
  if (door?.loading) return;
  const sure = await confirmDlg({
    title: toClose ? '閂 VSBADGE 後端嘅「直接入口」？' : '開返 VSBADGE 後端嘅「直接入口」？',
    danger: toClose,
    okText: toClose ? '確定閂' : '確定開',
    message: toClose
      ? '閂咗之後，VSBADGE 嗰支後端只接受簽名（sig）請求，佢哋用開嘅 apikey／本機登入會入唔到。'
        + '<br><br>本系統（VS-PORTAL）之後會用簽名照樣讀寫；本系統自己嘅後端唔受影響。'
      : '開返之後，VSBADGE 嗰支後端恢復收 apikey／本機登入。'
  });
  if (!sure) return;
  door = { ...(door || {}), loading: true };
  refresh();
  const r = await setLocalLogin(!toClose);
  if (r.ok) {
    toast(toClose ? '已閂 VSBADGE 後端嘅直接入口 — 只收簽名。' : '已開返 VSBADGE 後端嘅直接入口。', 'ok');
    await refreshDoor();
  } else {
    door = { ...(door || {}), loading: false };
    toast(r.error || '開關失敗', 'err');
    refresh();
  }
}

/* ---------- 總覽 ---------- */
/** ★「人讀到、但個個冇進度」橫額 —— 直接講出下一步，唔使人自己猜 */
function emptyProgressBanner() {
  if (!remote) return '';
  const sum = summarizeRemote(remote.data, { catalog, roster: members() });
  if (!sum.memberCount || sum.withProgress > 0) return '';
  const raw = remote.data?.progress || {};
  const ticks = Object.values(raw).reduce((a, p) => a + Object.keys(p || {}).length, 0);
  return `<div class="note-box warn">${icon('alert', 15)}<div>
    <b>讀到 ${sum.memberCount} 位成員，但係冇任何人有進度紀錄</b>
    <div class="sm mt-4">後端回嘅「進度追蹤」係空嘅（${ticks} 格）——所以每個人都顯示 0。
    多數係：你填嘅 <code>/exec</code> 唔係進度資料嗰張 Sheet／「進度追蹤」分頁唔見咗或者空。</div>
    <div class="row gap-8 mt-8 wrap">
      <button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 檢查設定</button>
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
      </div>` : `<div class="note-box">${icon('alert', 15)}<div>未讀到考核項目定義（<code>data/progress/items.json</code>）。喺「設定」可以填自訂定義。</div></div>`}

      <div class="card">
        <div class="card-head"><div><div class="card-title">待批（${pendingReqs.length + logReqs.length}）</div>
          <div class="card-sub">團員自己申報、等批嘅項目同履歷 —— 喺「審批中心」直接批（同一個後端）</div></div>
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
    喺呢度勾選＝直接寫入<b>旅團自己嘅後端</b>（同進度前端共用同一個 Sheet），效果一樣。
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
    : `<div class="note-box">${icon('alert', 15)}<div>未讀到考核項目定義 —— 應該係 <code>data/progress/items.json</code>；如果改咗位置，去「設定」填自訂定義網址。</div></div>`}`;
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
    ? '喺呢度<b>直接批</b>：批准＝即時寫入旅團自己嘅後端（進度追蹤／活動履歷），兩個前端都即刻見到。'
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

/* ---------- 設定：VSBADGE 開關掣 ---------- */
function doorCard() {
  if (door?.loading) {
    return `<div class="sm muted">讀取 VSBADGE 後端狀態中…</div>`;
  }
  if (!door) {
    /* 第一次入設定／未讀狀態 */
    return `<div class="col gap-8">
      <div class="faint xs">撳「讀取狀態」睇 VSBADGE 後端而家嘅直接入口係開定閂。</div>
      <div><button class="btn btn-sm" data-act="door-refresh">${icon('refresh', 14)} 讀取狀態</button></div>
    </div>`;
  }
  if (door.error) {
    return `<div class="note-box warn">${icon('alert', 14)}<div>
      <b>讀唔到 VSBADGE 後端狀態</b>
      <div class="xs mt-4">${esc(door.error)}
        <div class="faint">（多數係：嗰支 /exec 唔係 VSBADGE 旅系統版，或者伺服器端未設定嗰支進度後端嘅 SHEET KEY
        ＝ <code>TROOP_${esc((progressCfg().unit || '0082'))}_PROGRESSAPIKEY</code>）</div>
      </div>
      <div class="mt-8"><button class="btn btn-sm" data-act="door-refresh">${icon('refresh', 14)} 再試</button></div>
    </div></div>`;
  }
  const open = door.allow_local_login;
  return `<div class="col gap-10">
    <div>${open
      ? `<span class="badge b-ok"><span class="dot"></span>直接入口：開（apikey／本機登入入到）</span>`
      : `<span class="badge b-warn"><span class="dot"></span>直接入口：已閂（只收簽名）</span>`}</div>
    ${door.node ? `<div class="xs faint">後端節點：${esc(door.node)}${door.link_flag_set ? ` · flag＝${esc(door.link_flag_set)}` : ''}</div>` : ''}
    ${door.at ? `<div class="xs faint">上次讀取：${esc(door.at)}</div>` : ''}
    <div class="row gap-8 wrap">
      <button class="btn btn-sm" data-act="door-refresh">${icon('refresh', 14)} 讀取狀態</button>
      ${open
        ? `<button class="btn btn-sm btn-accent" data-act="door-close">${icon('lock', 14)} 閂咗佢（只收簽名）</button>`
        : `<button class="btn btn-sm" data-act="door-open">${icon('unlock', 14)} 開返（容許本機登入）</button>`}
    </div>
    <div class="xs faint">只會鬱到上面填嘅嗰支 VSBADGE /exec；本系統（VS-PORTAL）之後用簽名照讀照寫。</div>
  </div>`;
}

/* ---------- 設定 ---------- */
function settingsView() {
  const c = progressCfg();
  const reg = progressIsRegistered();
  /* 正式 Vercel 旅團由 Registry／Proxy 管理接線；普通用家唔需要亦唔應該
     再見到 /exec、API Key 或自訂路線。 */
  if (c.serverSide) {
    return `
    <div class="card" style="max-width:780px">
      <div class="card-head"><div><div class="card-title">進度後端已準備好</div>
        <div class="card-sub">由平台安全接線，呢部機唔需要填任何設定。</div></div>
        <span class="badge b-ok"><span class="dot"></span>已接通</span></div>
      <div style="padding:16px 18px" class="sm muted">
        <div class="note-box ok">${icon('shield', 15)}<div>
          進度紀錄同旅團其他資料使用同一個後端。平台已經處理好連線資料，
          你只需要按頁面上嘅「重新讀取」或進行核心操作。
        </div></div>
        <div class="row gap-8 mt-12">
          <button class="btn btn-primary" data-act="reload">${icon('refresh', 15)} 重新讀取</button>
          <button class="btn" data-go="#/progress/overview">返回進度總覽</button>
        </div>
      </div>
    </div>`;
  }
  return `
  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">後端（旅團自己嘅 Apps Script）</div>
          <div class="card-sub">進度資料同其他資料都喺同一張 Google Sheet —— 唔使填其他系統嘅資料</div></div></div>
        <div style="padding:16px 18px">
          <div class="grid g-2" style="gap:12px">
            <div class="field" style="grid-column:1/-1"><label class="label">Web App <code>/exec</code> 網址</label>
              <input class="input" id="p-backend" value="${esc(c.backend)}" placeholder="https://script.google.com/macros/s/…/exec">
              <div class="hint">留空＝用返旅團已登記嘅後端（<code>data/units.json</code>${reg ? '' : '：暫時未登記'}）。部署：執行身分「我」、存取權「任何人」。</div></div>
            <div class="field" style="grid-column:1/-1"><label class="label">API Key</label>
              <input class="input" id="p-key" type="text" value="${esc(c.apiKey)}" placeholder="喺 Apps Script 執行 showApiKey()">
              <div class="hint">API Key 就等於<b>執委身份</b>：對得上就讀得、勾得。只會由本系統嘅伺服器傳去你自己嘅後端。</div></div>
            <div class="field"><label class="label">旅團編號</label>
              <input class="input" id="p-unit" value="${esc(c.unit)}" placeholder="0082"></div>
            <div class="field"><label class="label">顯示名稱</label>
              <input class="input" id="p-name" value="${esc(c.name)}"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">自訂考核項目定義（可選）</label>
              <input class="input" id="p-catalog" value="${esc(c.catalogUrl || '')}" placeholder="留空＝用內建 data/progress/items.json">
              <div class="hint">內建副本已經有第 11 版綱要嘅項目。如果旅團自己改過項目，可以喺呢度填一條公開 https 網址。</div></div>
          </div>
          <div class="row gap-8 wrap mt-12">
            <button class="btn btn-primary" data-act="save-cfg">${icon('save', 16)} 儲存</button>
            <button class="btn" data-act="reload">${icon('refresh', 16)} 重新讀取</button>
            <button class="btn btn-ghost" data-act="clear-cfg">${icon('trash', 15)} 清除自訂設定</button>
          </div>
          ${noteBox('★ 呢啲設定係<b>跟旅團資料庫走</b>嘅：撳完「儲存」系統會<b>自動寫入後端</b>（頂部狀態會轉做「已存到後端」；'
            + '想即刻寫就撳頂部「儲存到後端」），'
            + '無痕視窗／另一部機（新裝置）先會自動有同一組設定。<b>冇撳</b>嘅話，只有呢部機讀得到 ——'
            + '換部機就會好似「無痕讀唔到後端」。', 'warn')}
          <div class="hint mt-8"><b>點填：</b>① 喺 Apps Script 撳「部署 → 管理部署」複製 <code>/exec</code> 網址；
            ② 喺 Apps Script 執行 <code>showApiKey()</code> 複製 API Key；③ 貼上面兩個格 → 儲存後撳「重新讀取」見到成員就成功。
            <div class="xs faint mt-4">填完存在旅團自己嘅資料（跟 JSON 備份走），唔會交畀第三方。
              如果想收埋條 Key 唔落前端，先設環境變數 <code>TROOP_${esc((c.unit || '0082'))}_PROGRESSBACKEND</code> /
              <code>…_PROGRESSAPIKEY</code>。</div></div>
        </div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">VSBADGE 後端「直接入口」</div>
          <div class="card-sub">呢個掣淨係閂／開 VSBADGE 嗰支後端（本系統用簽名照讀照寫，唔受影響）</div></div>
        <div style="padding:14px 16px" class="sm muted">
          ${doorCard()}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">連線狀態</div></div>
        <div style="padding:14px 16px">
          ${kv([
            ['後端網址', c.backend ? `<span style="color:var(--ok)">${c.registered ? '用返旅團登記咗嘅後端' : '已填'}</span>`
              : c.serverSide ? '<span style="color:var(--ok)">伺服器端已設定</span>' : '<span style="color:var(--warn)">未設定</span>'],
            ['API Key', c.apiKey ? '<span style="color:var(--ok)">已填</span>'
              : c.serverSide ? '<span style="color:var(--ok)">伺服器端已設定</span>' : '<span style="color:var(--warn)">未填</span>'],
            ['接駁方式', linkMode === 'link'
              ? '<span style="color:var(--ok)">已接駁 VSBADGE 旅系統（簽名）</span>'
              : linkMode === 'closed'
                ? '<span style="color:var(--warn)">後端閂咗直接入口（要簽名）</span>'
                : '<span>API Key 直連</span>'],
            ['考核項目', catalog ? `${Object.keys(catalog).length} 項` : '未讀取'],
            ['上次讀取', remote ? esc(remote.at) : '—'],
            ['讀到嘅成員', remote ? String((remote.data.members || []).length) : '—']
          ])}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">跨系統對人</div></div>
        <div style="padding:14px 16px" class="sm muted">
          用<b>會籍編號（YMIS）</b>對同一個人。現時對得上：<b>${keyCoverage(members(), { youthOnly: true }).percent}%</b>
          （${keyCoverage(members(), { youthOnly: true }).matched}／${keyCoverage(members(), { youthOnly: true }).total} 位團員／執委；領袖同管理員唔計入進度）。
          <div class="mt-8"><button class="btn btn-sm btn-block" data-go="#/members">${icon('users', 15)} 去用戶名冊填 YMIS</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">權限</div></div>
        <div style="padding:14px 16px" class="sm muted">
          睇進度：全部已登入用戶。勾進度／改設定：${can('progress.tick') ? '<b style="color:var(--ok)">你而家可以</b>' : '<span style="color:var(--warn)">你冇權限（要領袖或執委）</span>'}。
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
  const cfg = progressCfg();
  const configured = progressConfigured();
  const serverManaged = cfg.serverSide;
  /* 分頁數字要同「成員進度」表格一致 —— summarizeRemote 會剔走管理員／領袖，
     以前呢度直接用後端 raw members 數，搞到「標籤 12 人、表得 11 行」。 */
  const memberCount = configured && remote
    ? summarizeRemote(remote.data, { catalog, roster: members() }).memberCount
    : 0;

  return `
  ${pageHead({
    title: '進度紀錄',
    sub: configured
      ? `${progressCfg().name} · 直接讀寫旅團自己嘅後端${progressCfg().serverSide ? '（後端由伺服器端設定）' : ''}${remote ? ` · 上次讀取 ${remote.at}` : ''}`
      : '未接駁 —— 去「設定」填入旅團後端嘅 /exec 網址同 API Key',
    actions: `
      <button class="btn btn-sm" data-act="reload" ${configured ? '' : 'disabled'}>${icon('refresh', 15)} ${loading ? '讀取中…' : '重新讀取'}</button>
      ${serverManaged ? '' : `<button class="btn btn-sm btn-primary" data-act="settings">${icon('settings', 15)} 設定</button>`}`
  })}

  ${tabs([
    ['overview', '總覽'],
    ...(configured ? [
      ['members', `成員進度${remote ? `（${memberCount}）` : ''}`],
      ['tick', can('progress.tick') ? '勾選進度' : '勾選進度（無權限）', Object.keys(pending).length || undefined],
      ['review', `審批中心${reviewCount() ? `（${reviewCount()}）` : ''}`]
    ] : []),
    ...(serverManaged ? [] : [['settings', configured ? '設定' : '設定（未接駁）']])
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
          ? '批准會即刻寫入後端，兩個前端都見到。'
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

  /* 設定 */
  const readCfg = () => {
    const v = k => root.querySelector(k)?.value.trim() || '';
    const patch = {
      backend: v('#p-backend'), apiKey: v('#p-key'),
      unit: v('#p-unit') || load().unitCode, name: v('#p-name') || '進度追蹤（同一個後端）',
      catalogUrl: v('#p-catalog')
    };
    setProgressCfg(patch);
    return patch;
  };
  root.querySelector('[data-act="save-cfg"]')?.addEventListener('click', () => {
    if (!can('progress.tick')) { toast('只有領袖／執委可以改設定', 'err'); return; }
    readCfg();
    const pend = Number(load()?.sync?.pending || 0);
    toast(pend > 0
      ? '已儲存 —— 自動寫入後端中，其他裝置／無痕好快讀得到（想即刻寫就撳頂部「儲存到後端」）'
      : '已儲存設定', 'ok');
    tab = 'overview';
    fetchAll();
  });
  root.querySelector('[data-act="clear-cfg"]')?.addEventListener('click', async () => {
    if (!(await modal({
      title: '清除自訂設定', danger: true,
      body: '<p class="sm">會清空你填嘅後端網址／API Key／自訂考核項目（之後會自動用返旅團登記咗嘅後端）。名冊同其他資料唔會受影響。</p>',
      actions: [{ label: '取消', class: 'btn', value: false }, { label: '清除', class: 'btn-accent', value: true }]
    }))) return;
    setProgressCfg({ backend: '', apiKey: '', catalogUrl: '' });
    remote = null; catalog = null; errMsg = '';
    toast('已清除', 'ok'); refresh();
  });

  /* ★ VSBADGE 開關掣（閂／開 VSBADGE 後端嘅直接入口） */
  root.querySelector('[data-act="door-refresh"]')?.addEventListener('click', () => { refreshDoor(); });
  root.querySelector('[data-act="door-close"]')?.addEventListener('click', () => { doorToggle(true); });
  root.querySelector('[data-act="door-open"]')?.addEventListener('click', () => { doorToggle(false); });
  if (tab === 'settings' && progressConfigured() && (!door || !door.at)) {
    /* 入到設定先至靜靜讀一次門況（冇 key 就唔讀，慳一程） */
    const c = progressCfg();
    if (c.serverSide || c.apiKey) setTimeout(() => refreshDoor(), 30);
  }

  /* 第一次入嚟：自動讀一次 */
  if (progressConfigured() && !remote && !loading && !errMsg) setTimeout(() => fetchAll({ silent: true }), 30);
}
