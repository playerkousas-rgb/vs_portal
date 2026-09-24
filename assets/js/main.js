/* ============================================================
   main.js — App Shell / 登入 / 路由 / 旅團選擇 / 示範模式橫額
   ============================================================ */

import {
  init, load, tryLoad, isMock, currentUnit, seedInfo, enterMock, exitMock, exitMockToUnit,
  switchUnit, clearMockData, resetToGate, setMode, setUnitCode, lastRealUnit, CHOSEN_UNIT_KEY
} from './lib/store.js';
import {
  loadRegistry, unitList, unitEntry, defaultUnitCode, registryReachable,
  serverUnitsStatus, bakedUnitsStatus, fileUnitsStatus, fetchRegistryDiag, registryStale,
  canonicalUnitCode
} from './lib/units.js';
import {
  adminInbox, validateApplication, submitApplication, adminChecklist,
  applicationText, downloadCodeGs, copyCodeGs
} from './lib/onboard.js';
import { applyTheme, MAROON } from './lib/theme.js';
import {
  login, loginServer, loginMember, loginPortalFromUrl, logout, current, currentRole, ROLES, displayName, displaySub,
  loginAsMock, accounts, isSuper, can, changeOwnPassword, TEMP_PASSWORD,
  loginSetupKey, applyAccount
} from './lib/auth.js';
import { pendingMeetings, overdueFees, pendingClaims, pendingLoans, profile, notices, onLegacyHost, canonicalUrl } from './lib/model.js';
import { esc, icon, toast, toastAction, modal, confirmDlg } from './lib/util.js';
import { parse, go } from './lib/router.js';

import * as dashboard from './views/dashboard.js';
import * as meetings from './views/meetings.js';
import * as finance from './views/finance.js';
import * as members from './views/members.js';
import * as inventory from './views/inventory.js';
import * as progress from './views/progress.js';
import * as constitution from './views/constitution.js';
import * as accountsView from './views/accounts.js';
import * as docs from './views/docs.js';
import * as noticesView from './views/notices.js';
import * as tables from './views/tables.js';
import { openFieldDesigner } from './views/tables.js';
import * as linksView from './views/links.js';
import * as calendar from './views/calendar.js';
import * as quizzes from './views/quizzes.js';

const VIEWS = {
  dashboard, meetings, finance, members, inventory, progress,
  constitution, notices: noticesView, tables, admin: accountsView, docs, links: linksView,
  calendar, quizzes
};

const NAV = [
  { id: 'dashboard', label: '儀表板', icon: 'home' },
  { id: 'calendar', label: '行事曆', icon: 'calendar' },
  { id: 'quizzes', label: '試卷', icon: 'note' },
  { id: 'meetings', label: '會議', icon: 'clock', badge: () => pendingMeetings().length },
  { id: 'finance', label: '財務', icon: 'wallet', badge: () => overdueFees().length + pendingClaims().length },
  { id: 'members', label: '用戶與身份', icon: 'users' },
  { id: 'inventory', label: '物資', icon: 'grid', badge: () => pendingLoans().length },
  { id: 'progress', label: '進度', icon: 'chart' },
  { id: 'notices', label: '通告', icon: 'megaphone', badge: () => (load()?.notices || []).filter(n => n.status === 'published').length },
  { id: 'links', label: '成員連結', icon: 'share' },
  { id: 'constitution', label: '團章', icon: 'book' },
  { id: 'docs', label: '教學', icon: 'note' },
  { id: 'admin', label: '身份與系統', icon: 'shield' }
];
const MOBILE_MAIN = ['dashboard', 'calendar', 'finance', 'inventory'];

const app = document.getElementById('app');
let bootError = null;

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  /* 舊系統退役截停（2026-09）：如果新 code 有朝一日喺 82venture.vercel.app 度跑
     （例如舊 Vercel project 重建咗），即刻截住 —— 嗰個站冇後端，
     喺嗰度開工只會整出更多混亂（揀唔到旅團、儲存唔到）。 */
  if (onLegacyHost() && !legacyDismissed()) return renderMoved();
  app.innerHTML = loadingScreen();
  try {
    await loadRegistry();
    const portalEntry = await loginPortalFromUrl();
    if (!portalEntry.skipped && !portalEntry.ok) return renderFatal(new Error(portalEntry.msg || '旅系統入口驗證失敗'));
    /* 第一步：先揀旅團（或者 MOCK），揀完先出現登入畫面 */
    if (!unitChosen()) return renderUnitGate();
    await init();
    applyTheme(load()?.unit?.theme);
  } catch (e) {
    console.error(e);
    bootError = e;
    return renderFatal(e);
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('v82:refresh', render);
  window.addEventListener('v82:sync', paintSyncChip);

  /* 資料真正嘅家係旅團自己嘅 Google Sheet：
     真實旅團要先成功載入後端，先可以顯示帳戶／密碼畫面。
     連唔到後端就停喺「後端未連線」頁，唔會畀用家輸入一堆一定登入唔到嘅資料。 */
  const bootSync = await syncBoot();
  if (!isMock() && !bootSync?.ok) {
    /* 舊 session 唔可以繞過後端硬閘直接入 app。 */
    if (current()) logout();
    return renderBackendGate(bootSync);
  }

  /* 示範 session 唔可以帶入真實旅團（否則會用「示範領袖」身份改真資料） */
  if (!isMock() && current()?.mock) logout();
  if (isMock() && !current()) loginAsMock('leader');
  if (!current()) renderLogin();
  else { render(); maybeForceChangePw(); maybeShowLoginConflicts(); }
}

/* ============================================================
   後端儲存 —— 唯一模式（2026-09-20 團長定案）
   ------------------------------------------------------------
     開機／登入   → loadFromBackend()：由後端攞成份資料 ＝ 基準
     之後改乜     → 淨係寫瀏覽器
     撳「儲存到後端」→ saveToBackend()：核對版本 → 逐格三方比對 →
                     唔撞嘅寫入；撞嘅（早走 vs 遲到）彈框問，確認咗先蓋
   冇自動儲存、冇 poll、冇切視窗自動拉、冇關視窗自動寫。
   ============================================================ */
let remoteApi = null;
/* 開機問唔到後端嗰陣嘅原因（登入頁會出橫額） */
let bootSyncWarn = null;
/* 開機三方比對發現上次未存嘅改動同後端撞咗 → 登入之後先問（未登入唔好彈嘢） */
let loginConflicts = null;
let unloadGuardOn = false;
export function remoteMod() { return remoteApi; }

async function syncBoot() {
  if (isMock()) return { ok: true, mock: true };
  try {
    remoteApi = await import('./lib/remote.js');
  } catch (e) {
    console.warn('[sync] 載入唔到 remote 模組', e);
    return { ok: false, error: '同步模組載入失敗 —— 請重新整理頁面再試' };
  }
  const store = await import('./lib/store.js');
  /* 本機一有改動 → 淨係更新頂部狀態（「儲存到後端（N）」），唔會寫後端 */
  store.setSaveHook(() => remoteApi.scheduleSave());

  if (!unloadGuardOn) {
    unloadGuardOn = true;
    /* 離開頁面前提醒有嘢未存。**唔會**寫後端（團長：「唔好比佢有機會出事」）。 */
    window.addEventListener('beforeunload', (e) => {
      if (remoteApi?.hasPending?.()) {
        e.preventDefault();
        e.returnValue = '仲有改動未儲存到後端，真係要離開？';
        return e.returnValue;
      }
    });
  }

  if (!remoteApi.remoteConfigured()) {
    /* 真實旅團冇可用接線：唔可以開登入頁，避免用家以為已登入本機資料。 */
    const out = { ok: false, reason: 'not_configured', error: '呢個旅團未有可用嘅後端接線' };
    bootSyncWarn = out;
    paintSyncChip();
    return out;
  }

  app.innerHTML = loadingScreen('由旅團後端載入資料中…');
  try {
    const r = await remoteApi.loadFromBackend();
    bootSyncWarn = r.ok ? null : r;
    if (r.ok) {
      try { applyTheme(load()?.unit?.theme); } catch { /* ignore */ }
      if (r.merged) {
        loginConflicts = r.conflicts?.length ? { conflicts: r.conflicts, ctx: r.ctx, remoteAt: r.at } : null;
        toastAction('上次未儲存嘅改動已保留喺呢部機 —— 記得撳「儲存到後端」', '去睇', () => go('#/tables/sync'), '');
      }
    }
  } catch (e) {
    console.warn('[sync] 開機由後端載入失敗（未顯示登入頁，亦唔會盲寫後端）', e);
    bootSyncWarn = { ok: false, error: e?.message || String(e) };
  }
  paintSyncChip();
  return bootSyncWarn ? { ok: false, ...bootSyncWarn } : { ok: true, loaded: true };
}

/** 開機三方比對有撞格 → 登入後問一次；剔咗嘅寫入本機（等你撳儲存），冇剔嘅維持後端 */
async function maybeShowLoginConflicts() {
  if (!loginConflicts || !current()) return;
  const lc = loginConflicts;
  loginConflicts = null;
  try {
    const { resolveConflictsDialog } = await import('./views/syncdialog.js');
    const { overridesFor } = await import('./lib/merge3.js');
    const { applyChangesLocal } = await import('./lib/store.js');
    const choice = await resolveConflictsDialog({ conflicts: lc.conflicts, ctx: lc.ctx, mode: 'login', remoteAt: lc.remoteAt });
    const ov = overridesFor(lc.conflicts, choice?.useMine || []);
    if (ov.length) { applyChangesLocal(ov); render(); toast(`已用返你嘅 ${ov.length} 項 —— 記得撳「儲存到後端」`, 'ok'); }
  } catch (e) { console.warn('[sync] 登入衝突對話框失敗', e); }
}

/** 登入頁頂：後端狀態橫額（連唔到／後端仲係空） */
function loginSyncBanner() {
  if (isMock() || !remoteApi) return '';
  if (!remoteApi.remoteConfigured()) return '';
  if (bootSyncWarn) {
    return `<div class="note-box danger mb-12" id="loginSyncWarn">${icon('alert', 15)}<div>
      <b>登入已封鎖 —— 連唔到旅團後端</b><div class="xs mt-4">${esc(bootSyncWarn.error || '未知原因')}</div>
      ${bootSyncWarn.hint ? `<div class="xs mt-4">${esc(bootSyncWarn.hint)}</div>` : ''}
      <div class="xs mt-8">帳戶一定要同後端核對過先至入到主控頁 —— 後端答唔到，
      所以<b>而家登唔到</b>（唔係密碼錯）。呢部機上次留低嘅資料仲喺度，冇蝕。</div>
      <button class="btn btn-xs mt-8" type="button" id="btnRetrySync">${icon('refresh', 13)} 重試連線</button>
    </div></div>`;
  }
  /* 帳戶來源 —— 直接答團長嗰句「咁啱先係登入咗乜？」。
     以前呢個資訊只喺 localStorage 入面，用家根本無從知道
     自己比對緊嘅係後端嘅帳戶，定係一份隨 JS 公開咗嘅種子帳戶。 */
  const accs = (load()?.accounts || []).filter(a => a?.active !== false);
  const fromBackend = !accs.some(a => a?.seeded);
  const src = accs.length === 0
    ? '（一個帳戶都冇）'
    : fromBackend
      ? `後端（${accs.length} 個帳戶）`
      : `⚠ 本機初始帳戶（${accs.filter(a => a.seeded).length} 個種子）—— 後端仲未有帳戶名單`;
  const prov = `<div class="xs faint mt-8">${icon('shield', 12)} 帳戶來源：${esc(src)}`
    + `　·　密碼核對：喺後端讀返嚟嘅名單上進行</div>`;

  const s = remoteApi.syncState();
  if (s.state === 'pending' && remoteApi.hasPending()) {
    return `<div class="note-box warn mb-12">${icon('clock', 15)}<div>呢部機有改動仲未儲存到後端 —— 登入後撳右上角「儲存到後端」。</div>${prov}</div>`;
  }
  return `<div class="mb-12">${prov}</div>`;
}

/** 頂部「儲存狀態」提示 ＋ 唯一嘅行動掣：
      有未存嘢 → 「儲存到後端（N）」；已同步 → 「重新載入」；連唔到 → 「重試」 */
function paintSyncChip() {
  const el = document.getElementById('syncChip');
  if (!el) return;
  if (isMock()) { el.innerHTML = ''; return; }

  if (!remoteApi || !remoteApi.remoteConfigured()) {
    el.innerHTML = `<span class="badge b-warn" title="資料淨係存喺呢部機嘅瀏覽器，換機／清 cache 就會冇咗。去「帳號與系統 → 資料管理 → 總表同步」設定後端。">
      ${icon('alert', 12)} 只存喺本機</span>`;
    el.onclick = () => go('#/tables/sync');
    el.style.cursor = 'pointer';
    return;
  }

  const s = remoteApi.syncState();
  const pending = Number(tryLoad()?.sync?.pending || 0);
  const map = {
    saving:  ['b-warn', 'cloud', '儲存緊…'],
    saved:   ['b-ok', 'check', '已存到後端'],
    pending: ['b-warn', 'clock', `未儲存${pending > 1 ? `（${pending}）` : ''}`],
    loading: ['b-warn', 'cloud', '讀取緊…'],
    conflict:['b-warn', 'alert', '有格同後端唔同'],
    error:   ['b-danger', 'alert', '儲存失敗'],
    unreachable: ['b-danger', 'alert', '連唔到後端'],
    idle:    ['b-ok', 'cloud', '已連後端']
  };
  let state = s.state;
  if (pending > 0 && (state === 'idle' || state === 'saved')) state = 'pending';
  const [cls, ic, label] = map[state] || map.idle;
  const needSave = pending > 0;
  const unreachable = state === 'unreachable';
  const actLabel = needSave ? `儲存到後端${pending > 1 ? `（${pending}）` : ''}` : unreachable ? '重試' : '重新載入';
  const actTitle = needSave
    ? '先核對後端版本；有人喺你登入後儲存過就逐格比對 —— 唔撞嘅寫入，撞嘅會問你'
    : '由後端攞返最新資料（冇未儲存改動，唔會丟嘢）';
  el.innerHTML = `<span class="badge ${cls}" title="${esc(s.msg || label)}">${icon(ic, 12)} ${esc(label)}</span>
    <button class="btn btn-xs ${needSave ? 'btn-primary' : ''}" id="syncActBtn" title="${esc(actTitle)}" ${s.state === 'saving' ? 'disabled' : ''}>
      ${icon(needSave ? 'save' : 'refresh', 12)} ${esc(actLabel)}</button>`;
  el.style.cursor = 'default';
  const badge = el.querySelector('.badge');
  if (badge) badge.style.cursor = 'pointer';
  if (badge) badge.onclick = () => go('#/tables/sync');
  el.querySelector('#syncActBtn')?.addEventListener('click', async () => {
    const btn = el.querySelector('#syncActBtn');
    if (btn) { btn.disabled = true; btn.textContent = '處理中…'; }
    try {
      const dlg = await import('./views/syncdialog.js');
      if (needSave) await dlg.saveWithDialog({ silent: false });
      else await dlg.reloadFromBackend();
    } finally {
      paintSyncChip();
    }
  });
}

/* ============================================================
   旅團選擇閘（登入之前）
   網址有 ?u= / ?mock=1，或者之前已經揀過，就直接入登入畫面。
   ============================================================ */
function unitChosen() {
  const url = new URLSearchParams(location.search);
  const urlUnit = (url.get('u') || '').trim();
  if (urlUnit || url.get('mock') === '1') return true;
  let saved = '';
  try { saved = localStorage.getItem(CHOSEN_UNIT_KEY) || ''; } catch { return false; }
  if (!saved) return false;
  /* 示範模式**唔會**自動記住：下次由普通網址開（例如書籤、首頁連結）一律返旅團選擇閘。
     以前記住咗 MOCK，之後每次開網站都靜靜雞入返示範，用家就覺得「入咗 MOCK 走唔出」。
     想入示範，撳閘嘅 MOCK 或者用 ?mock=1 連結就得。 */
  if (saved.toUpperCase() === 'MOCK') return false;
  /* 例外：記住咗一個 Registry 已經冇嘅旅團（例如之前係 Git entry、而家改咗用
     環境變數開、或者打錯編號）→ 唔好靜靜雞入一個空殼旅團，返去選擇閘再揀。
     只喺「Registry 真係讀到」嘅時候至咁做，否則網絡一斷就會被踢返出嚟。 */
  if (registryReachable() && saved.toUpperCase() !== 'MOCK') {
    const known = unitList().some(u => String(u.code) === String(saved)
      || String(u.code).replace(/^0+/, '') === String(saved).replace(/^0+/, ''));
    if (!known) return false;
  }
  return true;
}
function markChosen(code) {
  try { localStorage.setItem(CHOSEN_UNIT_KEY, code); } catch { /* ignore */ }
}
/* 清選擇記錄＋模擬狀態，返去旅團選擇閘（同「離開示範」共用，見 store.resetToGate） */
function forgetChoice() { resetToGate(); }

/** 伺服器端 Registry（Vercel 環境變數）而家點？ */
function serverRegistryLine() {
  const s = serverUnitsStatus();
  const b = bakedUnitsStatus();
  if (s.ok) {
    return `${icon('check', 13)} 伺服器登記（Vercel 環境變數）：<b>${s.count}</b> 個旅團`;
  }
  /* 即時 API 讀唔到，但部署嗰陣焗好嘅名單有貨 —— 清單照用，唔好嚇親人 */
  if (b.ok) {
    return `${icon('check', 13)} 伺服器登記（部署名單）：<b>${b.count}</b> 個旅團` +
      `<span class="xs faint">（即時狀態讀唔到：${esc(s.error || '網絡錯誤')}）</span>`;
  }
  if (!s.at) return `${icon('clock', 13)} 伺服器登記：未檢查`;
  return `${icon('alert', 13)} 讀唔到伺服器登記清單（<code>${esc(s.error || '網絡錯誤')}</code>）`;
}

/** 旅團嚟自邊條路？（檔案／Vercel 可以並存，合併顯示） */
function unitSourceTags(x) {
  const tags = [];
  if (x.local) tags.push('本地旅團');
  if (x.fromFile) tags.push('檔案');
  if (!x.local && (x.fromApi || x.server)) tags.push('Vercel 登記');
  return tags.length ? ' · ' + tags.join(' · ') : '';
}

function renderUnitGate() {
  document.body.classList.add('login-body');
  const units = unitList();
  const serverUnits = units.filter(x => x.fromApi || x.server);
  const st = serverUnitsStatus();
  const bakedGate = bakedUnitsStatus();
  /* 即時 API 同部署名單兩邊都冇，先至算「讀唔到」 */
  const serverFailed = st.at && !st.ok && !bakedGate.ok;
  /* 清單空咗，係「伺服器讀唔到」定「真係一個都未登記」？兩個講法完全唔同。 */
  const emptyBox = !units.length ? `
    <div class="note-box ${serverFailed ? 'warn' : ''}">${icon(serverFailed ? 'alert' : 'info', 15)}
      <div>
        <b>${serverFailed ? '讀唔到伺服器嘅旅團登記清單。' : '暫時未有旅團登記。'}</b>
        ${serverFailed
          ? `（<code>${esc(st.error || '')}</code>）呢個通常係以下其中一樣：
             <ul style="margin:6px 0 0;padding-left:18px;line-height:1.8">
               <li>環境變數加咗但未 <b>Redeploy</b>（加／改完一定要重新部署先生效）</li>
               <li>變數名唔啱：要 <code>TROOP_&lt;編號&gt;_BACKEND</code>（＋<code>_APIKEY</code>、<code>_NAME</code>）</li>
               <li>部署未完成／網絡問題 —— 可以撳下面「重新載入清單」再試</li>
             </ul>
             你亦可以撳「<b>診斷伺服器登記</b>」睇實際讀到啲咩，或直接<b>輸入旅團編號</b>入去。`
          : `你可以揀下面嘅「試用示範（MOCK）」即刻試玩，或者撳「新旅團申請接入」登記自己旅團 —— 登記好之後，你嘅旅團就會喺呢度出現，由空白資料庫開始。
             <ul style="margin:6px 0 0;padding-left:18px;line-height:1.8">
               <li>已經喺 Vercel 加咗 <code>TROOP_&lt;編號&gt;_*</code>？記得撳 <b>Redeploy</b>，
                   同埋將變數嘅 Environments 勾埋 <b>Preview ＋ Production</b>
                   （淨係勾 Production，開 Preview 網址就會一個都讀唔到）</li>
               <li>撳「<b>診斷伺服器登記</b>」可以即刻睇到伺服器認到咩、邊個變數名打錯咗</li>
             </ul>`}
      </div>
    </div>` : '';

  app.innerHTML = `
  <div class="gate-wrap">
    <div class="gate-card">
      <div class="gate-brand">
        <div class="logo">82</div>
        <div>
          <div class="gate-title">深資童軍管理系統</div>
          <div class="gate-sub">第一步：揀你嘅旅團（或者用示範資料試玩）</div>
        </div>
      </div>

      <div class="gate-status xs ${st.ok ? 'faint' : ''}" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:0 2px 10px">
        <span>${serverRegistryLine()}</span>
        <span class="grow"></span>
        <button class="btn btn-xs" data-act="reload">${icon('refresh', 13)} 重新載入清單</button>
        <button class="btn btn-xs" data-act="diag">${icon('target', 13)} 診斷伺服器登記</button>
      </div>

      <div class="gate-list">
        ${units.map(x => `
          <button class="gate-unit" data-pick="${esc(x.code)}">
            <span class="code">${esc(x.code)}</span>
            <span class="grow">
              <span class="semibold" style="display:block">${esc(x.name || '')}</span>
              <span class="xs faint">${esc(x.nameEn || x.section || '')}${unitSourceTags(x)}</span>
              ${(x.fromApi || x.server) && x.backendReady === false
                ? `<span class="xs" style="display:block;color:var(--warn,#B8892B)">${'⚠'} 後端未設定／URL 未通過驗證 —— 要加 <code>TROOP_${esc(x.code)}_BACKEND</code>（https://script.google.com/macros/s/…/exec）</span>`
                : ''}
            </span>
            ${icon('chevronR', 17)}
          </button>`).join('')}

        ${emptyBox}

        <button class="gate-unit mock" data-pick="MOCK">
          <span class="code">MOCK</span>
          <span class="grow">
            <span class="semibold" style="display:block">試用示範（MOCK）</span>
            <span class="xs faint">假資料，同真實資料完全隔離，隨便試都唔會影響真數據（隨時可以「離開示範」）</span>
          </span>
          ${icon('chevronR', 17)}
        </button>
      </div>

      <div class="gate-apply" style="display:flex;flex-direction:column;gap:12px">
        <div class="row-between wrap gap-8">
          <div class="grow" style="min-width:240px">
            <div class="semibold">已經喺 Vercel 登記咗，但清單見唔到？</div>
            <div class="xs faint">直接輸入旅團編號一樣入得（例如 <code>0082</code>）；入到去先撳「診斷伺服器登記」查原因。</div>
          </div>
          <div class="row gap-8 wrap" style="align-items:center">
            <input class="input" id="gateCode" placeholder="旅團編號，例：0082" style="width:170px" inputmode="numeric">
            <button class="btn btn-sm btn-primary" data-act="goto-code">${icon('chevronR', 15)} 直接進入</button>
          </div>
        </div>

        <div class="row-between wrap gap-8" style="border-top:1px solid var(--line-2);padding-top:12px">
          <div class="grow" style="min-width:240px">
            <div class="semibold">你嘅旅團未喺清單入面？（新旅團部署）</div>
            <div class="xs faint">每個旅團用自己嘅 Google Sheet 做後端。毋須登入，先下載 <code>Code.gs</code> → 建立 Google Sheet → 執行 <code>initializeSheets</code> → 部署做網頁應用程式 → 把 URL 及 API Key 提交登記。</div>
          </div>
          <div class="row gap-8 wrap" style="align-items:center">
            <button class="btn btn-sm" data-act="dl-gs">${icon('download', 15)} 下載 Code.gs</button>
            <button class="btn btn-sm" data-act="guide">${icon('note', 15)} 部署指南</button>
            <button class="btn btn-sm btn-primary" data-act="apply">${icon('plus', 15)} 新旅團申請接入</button>

          </div>
        </div>
      </div>

      <div class="gate-foot">
        揀完之後先會出現<b>登入畫面</b>（領袖 / 執行委員會）。<br>
        管理員開新旅團：喺 <code>data/units.json</code> 加 entry（唔使起資料夾）＋ Vercel 加
        <code>TROOP_&lt;編號&gt;_BACKEND</code> / <code>_APIKEY</code>，再 Redeploy（詳見 docs/ADD_NEW_UNIT.md）。
      </div>
    </div>
  </div>`;

  app.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const code = b.dataset.pick;
    markChosen(code);
    gotoUnit(code, { remember: false });
  }));

  app.querySelector('[data-act="dl-gs"]')?.addEventListener('click', () => downloadCodeGs());
  app.querySelector('[data-act="guide"]')?.addEventListener('click', openDeployGuideModal);
  app.querySelector('[data-act="apply"]')?.addEventListener('click', openApplication);
  app.querySelector('[data-act="reload"]')?.addEventListener('click', async () => {
    app.innerHTML = loadingScreen();
    await loadRegistry(true);
    renderUnitGate();
    const s = serverUnitsStatus();
    const b = bakedUnitsStatus();
    toast(s.ok ? `已重新載入：伺服器登記 ${s.count} 個旅團`
      : (b.ok ? `已重新載入：部署名單 ${b.count} 個旅團（即時 API：${s.error || '讀唔到'}）`
        : `仲係讀唔到伺服器清單：${s.error}`), (s.ok || b.ok) ? 'ok' : 'err');
  });
  app.querySelector('[data-act="diag"]')?.addEventListener('click', openRegistryDiag);
  const goCode = () => {
    const raw = app.querySelector('#gateCode')?.value.trim() || '';
    if (!raw) { toast('請輸入旅團編號', 'err'); return; }
    /* ★ 打「82」都要入到「0082」嗰個旅團 —— 唔好因為少咗兩個 0
       就對團長講「未能連接旅團後端」（詳見 gotoUnit 註解）。 */
    const canon = canonicalUnitCode(raw);
    if (canon && canon !== raw) toast(`旅團編號已校正：${raw} → ${canon}`, 'ok');
    gotoUnit(canon || raw);
  };
  app.querySelector('[data-act="goto-code"]')?.addEventListener('click', goCode);
  app.querySelector('#gateCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') goCode(); });
}

/* ============================================================
   去某個旅團（真實／示範都由呢度行）
   真實旅團一定要帶 ?u=<編號> 而**冇** mock=1 —— store.init() 見到 ?u= 就會用返真實模式，
   唔會再被 localStorage 入面嘅 mode=mock 蓋住（2026-09「揀極都係 MOCK」嘅根本原因）。
   ============================================================ */
function gotoUnit(code, { remember = true } = {}) {
  const isMockCode = String(code).toUpperCase() === 'MOCK';
  /* ★ 一律用 Registry 登記咗嗰個編號入去（82 → 0082）。
     以前打「82」就會 ?u=82 ＋ db.unitCode='82'：
       · /api/proxy 以前搵唔到「0082」→ 404「找不到此旅團或後端網址未設定」
         → 登入硬閘對團長講「未能連接旅團後端」＝「無後端」（後端明明登記得好哋）；
       · 就算代理肯轉發，寫落 Google Sheet 嘅旅團欄會係「82」，
         而用「0082」讀又搵唔到 → 同一張表兩套資料庫，兩邊永遠對唔到料。
     兩邊都喺伺服器端校正咗（api/_registry.js、api/proxy.js），
     呢度再校正多一層，令 ?u=、localStorage、db.unitCode、data/units/<編號>/ 全部一致。 */
  code = isMockCode ? code : (canonicalUnitCode(code) || code);
  if (remember) markChosen(isMockCode ? 'MOCK' : code);
  if (isMockCode) { enterMock(); return; }
  setMode('real');
  setUnitCode(code);
  const u = new URL(location.href);
  u.searchParams.set('u', code);
  u.searchParams.delete('mock');
  u.hash = '';
  location.href = u.toString();
}

/* ============================================================
   診斷：伺服器端到底讀到啲咩？（唔會顯示 API Key）
   ============================================================ */
async function openRegistryDiag() {
  const local = serverUnitsStatus();
  const baked = bakedUnitsStatus();
  const file = fileUnitsStatus();
  const d = await fetchRegistryDiag();
  const rows = [];
  rows.push(['檔案名單 <code>data/units.json</code>', !file.at
    ? '（未檢查）'
    : (file.ok
      ? `<span class="badge b-ok">OK</span>&nbsp; ${file.count} 個旅團`
      : `<span class="badge b-warn">失敗</span> <code>${esc(file.error || '')}</code>`)]);
  rows.push(['瀏覽器讀 <code>/api/units</code>', local.ok
    ? `<span class="badge b-ok">OK</span>&nbsp; ${local.count} 個旅團`
    : `<span class="badge b-warn">失敗</span> <code>${esc(local.error || '')}</code>`]);
  rows.push(['部署時名單（靜態）', !baked.at
    ? '（未檢查）'
    : (baked.ok
      ? `<span class="badge b-ok">OK</span>&nbsp; ${baked.count} 個旅團` +
        (baked.generatedAt ? ` · <span class="xs muted">${esc(baked.generatedAt)}${baked.vercelEnv ? `（${esc(baked.vercelEnv)}）` : ''}</span>` : '')
      : `<span class="badge b-warn">冇</span> <span class="xs muted">呢個部署冇焗名單（舊部署／未經正常 build）</span>`)]);
  rows.push(['伺服器端回應', d.ok
    ? `<span class="badge b-ok">OK</span>`
    : `<span class="badge b-warn">有問題</span> <code>${esc(d.error || '')}</code>`]);
  rows.push(['伺服器認到嘅旅團', (d.ids || []).length
    ? (d.ids || []).map(i => `<code>${esc(i)}</code>`).join('、')
    : '（一個都認唔到）']);
  rows.push(['後端 /exec 已通過白名單', (d.trusted || []).length
    ? (d.trusted || []).map(i => `<code>${esc(i)}</code>`).join('、')
    : '<span class="muted">冇 —— 旅團一定要有 <code>TROOP_&lt;編號&gt;_BACKEND</code>（要 <code>https://script.google.com/macros/s/…/exec</code>）先生效</span>']);
  rows.push(['有 API Key', (d.withKey || []).length
    ? (d.withKey || []).map(i => `<code>${esc(i)}</code>`).join('、')
    : '<span class="muted">冇（未設定 _APIKEY）</span>']);
  rows.push(['執行環境', d.onVercel
    ? `<span class="badge b-ok">Vercel</span> ${d.vercelEnv ? `<code>${esc(d.vercelEnv)}</code>` : ''}`
    : `<span class="badge b-warn">唔似 Vercel</span> <span class="xs muted">${esc(d.env || '')}</span>`]);
  if (d.host) rows.push(['你而家開緊', `<code>${esc(d.host)}</code>`]);

  const suspicious = d.suspicious || [];
  const recognized = d.recognizedNames || [];
  const none = !(d.ids || []).length;

  /* 一個都認唔到 —— 九成係以下其中一樣，直接列出嚟 */
  const emptyHelp = none ? `
    <div class="note-box warn mt-12">${icon('alert', 15)}<div>
      <b>伺服器讀唔到你嘅 TROOP_* 變數，最常見係呢三個原因：</b>
      <ul style="margin:8px 0 0;padding-left:18px;line-height:1.9">
        <li><b>未 Redeploy</b> —— 加／改環境變數之後一定要喺 Vercel 重新部署一次
            （Deployments → 最新嗰個 → ⋯ → Redeploy）</li>
        <li><b>變數只勾咗 Production，但你開緊 Preview／Development 網址</b>
            （網址帶 <code>-git-</code>、隨機字尾，或者唔係你嘅正式網域）。
            去 Vercel → Settings → Environment Variables，將每個 <code>TROOP_*</code> 嘅 Environments
            改成 <b>Production ＋ Preview ＋ Development</b>（或者全部），再 Redeploy</li>
        <li><b>唔係呢個部署</b> —— 環境變數只存在於 Vercel 嗰邊；本機預覽讀唔到，
            要本機都見到就要喺專案嘅 <code>.env.local</code> 自己填同樣嘅變數</li>
      </ul>
      而家嘅環境：<code>${esc(d.vercelEnv || d.env || 'local')}</code>${d.host ? ` · <code>${esc(d.host)}</code>` : ''}
    </div></div>` : '';

  await modal({
    title: '伺服器登記診斷',
    sub: '睇睇 Vercel 環境變數有冇被讀到（唔會顯示任何 API Key）',
    wide: true,
    body: `
      <div class="card" style="padding:14px">
        <table class="table" style="font-size:13px"><tbody>
          ${rows.map(([k, v]) => `<tr><td style="width:190px" class="sm semibold">${k}</td><td class="sm">${v}</td></tr>`).join('')}
        </tbody></table>
      </div>
      ${emptyHelp}

      ${recognized.length ? `
      <div class="note-box info mt-12">${icon('check', 15)}<div>
        <b>已識別嘅變數（名）</b><div class="xs mono" style="word-break:break-all">${recognized.map(esc).join('<br>')}</div>
      </div></div>` : ''}

      ${suspicious.length ? `
      <div class="note-box warn mt-12">${icon('alert', 15)}<div>
        <b>見到疑似旅團變數但認唔到（可能就係佢令旅團唔出現）</b>
        <div class="xs mono" style="word-break:break-all">${suspicious.map(esc).join('<br>')}</div>
        <div class="xs" style="margin-top:6px">正確格式：<code>TROOP_&lt;編號&gt;_BACKEND</code>、<code>TROOP_&lt;編號&gt;_APIKEY</code>、<code>TROOP_&lt;編號&gt;_NAME</code>（<code>GASURL</code>、<code>URL</code>、<code>KEY</code> 等都認得）。</div>
      </div></div>` : ''}

      <div class="note-box info mt-12">${icon('refresh', 15)}<div>
        加／改完環境變數一定要喺 Vercel 撳 <b>Redeploy</b>；只係重新整理瀏覽器係唔會生效㗎。
      </div></div>`,
    actions: [{ label: '重新載入旅團清單', class: 'btn', value: 'reload' }, { label: '關閉', class: 'btn-primary', value: null }]
  }).then(async v => {
    if (v === 'reload') {
      app.innerHTML = loadingScreen();
      await loadRegistry(true);
      renderUnitGate();
    }
  });
}

/* ============================================================
   部署指南彈窗（登入前直接查閱）
   ============================================================ */
async function openDeployGuideModal() {
  await modal({
    title: '🗺️ 深資童軍管理系統 · 多旅團後端部署指南',
    wide: true,
    body: `
      <div class="note-box info mb-12">
        ${icon('check', 16)}
        <div><b>10 分鐘完成部署！</b>本系統為多旅團架構，每個旅團擁有自己獨立的 Google Sheet 後端，毋須登入即可完成部署並提交登記（申請會直接送去平台管理員嘅 ADMIN 系統）。</div>
      </div>
      
      <div class="col gap-12" style="font-size:13.5px;line-height:1.6">
        <div class="card" style="padding:14px">
          <div class="semibold mb-4">第 1 步：下載後端程式碼（Code.gs）</div>
          <div class="xs faint mb-8">毋須登入，直接點擊下方按鈕下載或複製最新單一檔案後端程式碼：</div>
          <div class="row gap-8 wrap">
            <button class="btn btn-sm btn-primary" id="guide-dl-btn" type="button">${icon('download', 15)} ⬇️ 立即下載 Code.gs</button>
            <button class="btn btn-sm" id="guide-copy-btn" type="button">${icon('copy', 15)} 📋 複製原始碼</button>
          </div>
        </div>

        <div class="card" style="padding:14px">
          <div class="semibold mb-4">第 2 步：建立 Google Sheet 並貼上代碼</div>
          <ol class="xs mono" style="padding-left:18px;line-height:1.8">
            <li>開啟 Google Sheets 建立新試算表（例：「第82旅 執委會總表」）</li>
            <li>點擊上方選單「擴充功能」→「Apps Script」</li>
            <li>清空預設代碼，將下載的 <code>Code.gs</code> 全部內容貼上並儲存 💾</li>
          </ol>
        </div>

        <div class="card" style="padding:14px">
          <div class="semibold mb-4">第 3 步：執行 initializeSheets 初始化試算表</div>
          <ol class="xs mono" style="padding-left:18px;line-height:1.8">
            <li>在 Apps Script 函數下拉選單選擇 <code>initializeSheets</code></li>
            <li>點擊「▶ 執行」，依照 Google 提示完成授權（進階 → 前往 → 允許）</li>
            <li>系統自動建立全部工作表（帳目、物資、團員、通告、報名、會議…＋同進度前端共用嘅
              <b>進度追蹤／其他獎章／活動履歷／待批完成／待批履歷／成員名單</b>）</li>
            <li>彈窗會顯示專屬 <b>API Key</b>，請複製保存（日後可執行 <code>showApiKey</code> 再次查看）</li>
          </ol>
        </div>

        <div class="card" style="padding:14px">
          <div class="semibold mb-4">第 4 步：部署為網頁應用程式（Web App）</div>
          <ol class="xs mono" style="padding-left:18px;line-height:1.8">
            <li>點擊右上角「部署」→「新增部署作業」→ 齒輪選擇「網頁應用程式」</li>
            <li>設定：執行身分選「<b>我</b>」；具有存取權的使用者選「<b>任何人</b>」</li>
            <li>點擊「部署」，複製 <b>網頁應用程式網址</b>（以 <code>https://script.google.com/macros/s/…/exec</code> 結尾）</li>
          </ol>
        </div>

        <div class="card" style="padding:14px">
          <div class="semibold mb-4">第 5 步：填申請表 → 直接入 ADMIN 系統</div>
          <div class="xs faint mb-8">
            撳下面個掣會開<b>申請表</b>（旅團編號、名稱、後端 <code>/exec</code>、API Key、聯絡人）。
            送出之後，資料會經<b>同源伺服器轉發</b>，直接落到平台管理員嘅
            <b>ADMIN 系統收件匣</b>（同 VSBADGE 共用同一個收件匣，用 <code>appType: 82venture</code> 分辨）。<br>
            <b>送出就 OK，唔使等回覆</b>：ADMIN 系統唔會回覆申請人，管理員收到之後會轉寄畀團長跟進，
            開好團（加好 <code>TROOP_&lt;編號&gt;_*</code> 環境變數）就會 email 通知你。
            如果幾日都冇消息，用申請內容 WhatsApp／電郵問一聲管理員就得。
            <br>之後：想埋讀「進度追蹤」＝登入後去「進度 → 設定」貼 <code>/exec</code> ＋ API Key（或者交畀管理員一齊設定）；
            通告一開就可以用 QR／WhatsApp 分享收報名，報名直接入你自己嘅 Sheet。
          </div>
          <button class="btn btn-sm btn-primary" id="guide-apply-btn">${icon('plus', 15)} 填寫申請表自動送出（入 ADMIN 系統）</button>
          <div class="xs faint mt-8">送唔到（例如網絡問題）？申請表會畀你<b>複製申請內容</b>，直接 WhatsApp／電郵畀管理員都一樣開得團。</div>
        </div>
      </div>
    `,
    actions: [{ label: '關閉', class: 'btn-primary', value: null }],
    onMount: el => {
      el.querySelector('#guide-dl-btn')?.addEventListener('click', () => downloadCodeGs());
      el.querySelector('#guide-copy-btn')?.addEventListener('click', () => copyCodeGs());
      el.querySelector('#guide-apply-btn')?.addEventListener('click', async () => {
        const { closeModal } = await import('./lib/util.js');
        closeModal(null);
        openApplication();
      });
    }
  });
}

/* ============================================================
   新旅團申請接入（送去平台管理員收件匣）
   ============================================================ */
async function openApplication() {
  const box = adminInbox();
  let mainUrl = '';
  try { mainUrl = location.origin; } catch (e) { mainUrl = ''; }
  const r = await modal({
    title: '新旅團申請接入', wide: true,
    sub: box.configured ? '申請會送去做平台管理員嘅 ADMIN 系統（呢個系統唔會回覆，送出去就得）' : '（未設定收件匣）',
    body: `
      <div class="note-box mb-12">${icon('alert', 15)}<div>
        <b>申請之前請先起好你自己嘅後端</b>（每個旅團一張自己嘅 Google Sheet）：
        <div class="xs mt-4 mb-8">
          1. 獲取 <b>Code.gs</b>（免登入）：
          <button class="btn btn-xs btn-primary ml-8" id="ap-dl-btn" type="button">${icon('download', 13)} 下載 Code.gs</button>
          <button class="btn btn-xs ml-4" id="ap-copy-btn" type="button">${icon('copy', 13)} 複製原始碼</button><br>
          2. 建一張新 Google Sheet → 擴充功能 → Apps Script → 貼上 Code.gs<br>
          3. 執行 <code>initializeSheets</code>（會建好全部分頁），複製 API Key<br>
          4. 部署做<b>網頁應用程式</b>（執行身分：我；存取權：任何人），複製 <code>/exec</code> 網址
        </div></div></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">旅團編號 <span class="req">*</span></label>
          <input class="input" id="ap-id" placeholder="例：0100" maxlength="32"></div>
        <div class="field"><label class="label">旅團名稱 <span class="req">*</span></label>
          <input class="input" id="ap-name" placeholder="例：第一百旅深資童軍團"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">你嘅後端 Apps Script <code>/exec</code> 網址 <span class="req">*</span></label>
          <input class="input" id="ap-url" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="field"><label class="label">API Key</label>
          <input class="input" id="ap-key" placeholder="執行 initializeSheets 之後顯示嗰個"></div>
        <div class="field"><label class="label">聯絡人（電郵／電話）</label>
          <input class="input" id="ap-contact" placeholder="例：scouter@example.hk"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">備註</label>
          <input class="input" id="ap-note" placeholder="例：想同時接入進度追蹤系統"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">主系統網址（自動帶）</label>
          <input class="input" value="${esc(mainUrl)}" readonly style="font-family:var(--mono);font-size:12px;background:var(--bg-2)">
          <div class="hint">呢個係<b>你而家睇緊嘅呢個網站</b>嘅網址，方便管理員核對同登記。</div></div>
      </div>
      <div class="hint mt-8">送出後管理員會把你嘅後端網址加進 Registry，完成開戶。之後你自己喺「<b>進度 → 設定</b>」填入旅團自己嘅 <code>/exec</code> 網址同 API Key，就可以喺呢度直接讀寫進度（一個後端、兩個前端，唔使外連）。</div>`,
    actions: [
      { label: '取消', class: 'btn', value: null },
      { label: '送出申請', class: 'btn-primary', onClick: el => ({
        troopId: el.querySelector('#ap-id').value,
        troopName: el.querySelector('#ap-name').value,
        scriptUrl: el.querySelector('#ap-url').value,
        apiKey: el.querySelector('#ap-key').value,
        contact: el.querySelector('#ap-contact').value,
        note: el.querySelector('#ap-note').value
      }) }
    ],
    onMount: el => {
      el.querySelector('#ap-dl-btn')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        downloadCodeGs();
      });
      el.querySelector('#ap-copy-btn')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        copyCodeGs();
      });
    }
  });
  if (!r) return;
  const v = validateApplication(r);
  if (!v.ok) { toast(v.errors[0], 'err'); return openApplication(); }
  toast('送出中…', 'info');
  const res = await submitApplication(r);
  if (res.ok) {
    await modal({
      title: '申請已送出',
      sub: `${res.payload.troopId} · ${res.payload.troopName} · ${res.via === 'proxy' ? '經伺服器轉發去 ADMIN 系統' : '直接送去 ADMIN 系統'}${res.ms != null ? ` · ${res.ms} ms` : ''}`,
      body: `
        <div class="note-box info mb-12">${icon('check', 15)}<div>
          你張申請已經送去<b>平台管理員嘅 ADMIN 系統</b>。
          <br><span class="xs">呢個系統<b>唔會回覆</b>（App 唔會知 ADMIN 收咗未），所以你唔會喺呢度見到「已收到」——正常，唔使擔心。
          管理員收到之後會轉寄畀團長跟進，開好團就會 email 通知你。</span>
        </div></div>
        <div class="row gap-8 mb-12">
          <button class="btn btn-sm" id="ap-copy-again">${icon('copy', 14)} 複製申請內容（跟進／備用）</button>
        </div>
        <div class="xs faint">管理員收到之後會做嘅嘢（方便你跟進）：</div>
        <ol class="xs mono" style="padding-left:18px;line-height:1.9">
          ${adminChecklist(res.payload.troopId).map(x => `<li>${esc(x)}</li>`).join('')}
        </ol>
        <div class="xs faint mt-8">過幾日都未收到通知？複製上面段字，WhatsApp／電郵畀平台管理員問一聲就得。</div>`,
      actions: [{ label: '好', class: 'btn-primary', value: true }],
      onMount: el => {
        el.querySelector('#ap-copy-again')?.addEventListener('click', async () => {
          const { copyText } = await import('./lib/util.js');
          const okCopy = await copyText(applicationText(res.payload));
          toast(okCopy ? '已複製申請內容' : '複製唔到，請手動抄低', okCopy ? 'ok' : 'err');
        });
      }
    });
  } else {
    const sig = (res.errors || []).join(' · ') || '送出失敗';
    toast(sig, 'err');
    await modal({
      title: '送唔到去 ADMIN 系統', wide: true,
      sub: res.via === 'proxy' ? '（經伺服器轉發時失敗）' : '（直接送出時失敗）',
      body: `
        <div class="note-box danger mb-12">${icon('alert', 15)}<div>
          <b>${esc(sig)}</b><br>
          <span class="xs">申請內容仲喺度，你可以複製落嚟，直接 WhatsApp／電郵畀平台管理員，佢一樣開得團。</span>
        </div></div>
        <textarea class="input mono" rows="9" readonly style="font-size:12px">${esc(applicationText(res.payload))}</textarea>`,
      actions: [
        { label: '關閉', class: 'btn', value: null },
        { label: '再試一次', class: 'btn', value: 'retry' },
        { label: '複製申請內容', class: 'btn-primary', value: 'copy' }
      ]
    }).then(async v => {
      if (v === 'copy') {
        const { copyText } = await import('./lib/util.js');
        toast((await copyText(applicationText(res.payload))) ? '已複製申請內容' : '複製唔到，請手動抄低', 'ok');
      }
      if (v === 'retry') openApplication();
    });
  }
}

function loadingScreen(msg = '載入中…') {
  return `<div style="display:grid;place-items:center;min-height:100vh;color:#9A868C;font-size:14px">${esc(msg)}</div>`;
}

function legacyDismissed() {
  try { return sessionStorage.getItem('v82.legacy.ok') === '1'; } catch { return false; }
}

/* 舊站截停畫面：唔畀人喺個冇後端嘅空站度開工 */
function renderMoved() {
  document.body.classList.add('login-body');
  app.innerHTML = `
  <div class="gate-wrap">
    <div class="gate-card">
      <div class="gate-brand">
        <div class="logo">82</div>
        <div>
          <div class="gate-title">深資童軍管理系統已經搬遷</div>
          <div class="gate-sub">呢個舊網址（82venture.vercel.app）已經退役</div>
        </div>
      </div>
      <div class="note-box warn">${icon('alert', 15)}<div>
        你而家開緊嘅係<b>舊系統</b>，上面嘅資料唔會再更新，儲存都唔會成功。
        請轉去新系統，書籤／捷徑都請更新。
      </div></div>
      <div class="row gap-8 wrap mt-16">
        <a class="btn btn-primary" href="${esc(canonicalUrl())}">${icon('chevronR', 15)} 去新系統</a>
        <button class="btn" id="btnLegacyGo">我知，繼續用舊站</button>
      </div>
      <div class="gate-foot">唔肯定新網址？問你嘅領袖／執委攞最新連結。</div>
    </div>
  </div>`;
  app.querySelector('#btnLegacyGo')?.addEventListener('click', () => {
    try { sessionStorage.setItem('v82.legacy.ok', '1'); } catch { /* ignore */ }
    location.reload();
  });
}

function renderBackendGate(reason = {}) {
  document.body.classList.add('login-body');
  const code = currentUnit() || '—';
  /* 連線原因留喺內部狀態，普通用家只需要知道下一步：再試，或聯絡管理員。 */
  app.innerHTML = `
  <div class="gate-wrap">
    <div class="gate-card">
      <div class="gate-brand">
        <div class="logo">82</div>
        <div>
          <div class="gate-title">未能連接旅團後端</div>
          <div class="gate-sub">旅團 ${esc(code)} · 暫時不能登入</div>
        </div>
      </div>
      <div class="note-box danger">${icon('alert', 16)}<div>
        <b>暫時未能連線，請稍後再試。</b>
        <div class="xs mt-4">後端未連線，所以暫時未能顯示登入畫面。</div>
      </div></div>
      <div class="row gap-8 wrap mt-16">
        <button class="btn btn-primary" id="btnRetryBackend" type="button">${icon('refresh', 15)} 重新連線</button>
        <button class="btn" id="btnChangeUnit" type="button">${icon('chevronL', 15)} 返回揀旅團</button>
      </div>
      <div class="gate-foot">如仍然未能連線，請聯絡旅團管理員。</div>
    </div>
  </div>`;

  app.querySelector('#btnRetryBackend')?.addEventListener('click', async () => {
    const b = app.querySelector('#btnRetryBackend');
    if (b) { b.disabled = true; b.textContent = '連線中…'; }
    const r = await syncBoot();
    if (r?.ok) {
      if (isMock() && !current()) loginAsMock('leader');
      if (!current()) renderLogin();
      else render();
      return;
    }
    renderBackendGate(r);
  });
  app.querySelector('#btnChangeUnit')?.addEventListener('click', () => resetToGate());
}

function renderFatal(e) {
  app.innerHTML = `
  <div style="max-width:640px;margin:60px auto;padding:26px" class="card">
    <div class="row gap-10 mb-12"><span class="stat-ic" style="background:var(--danger-bg);color:var(--danger)">${icon('alert', 18)}</span>
      <div><div class="page-title" style="font-size:19px">讀唔到資料檔案</div>
      <div class="sm muted">系統需要由 HTTP 伺服器開啟（唔可以直接雙擊 HTML 檔）</div></div></div>
    <div class="note-box danger"><div>
      <b>點解決：</b><br>
      1. 喺專案資料夾開一個 HTTP 伺服器，例如 <code>python3 -m http.server 8000</code><br>
      2. 瀏覽器打開 <code>http://localhost:8000</code><br>
      3. 或者部署上 GitHub Pages / Vercel（詳見 README）</div></div>
    <div class="mt-16 xs faint mono">${esc(e?.message || String(e))}</div>
    <button class="btn btn-primary mt-16" onclick="location.reload()">${icon('refresh', 16)} 再試一次</button>
  </div>`;
}

/* ============================================================
   登入
   ============================================================ */
let pickedUnit = null;

/* ============================================================
   登入（★ 2026-09-24：一個入口、身份即帳號）
   ------------------------------------------------------------
   以前有兩個門口（領袖／執行委員會）＋兩個共用帳戶 ——
   團長定案：所有嘢都以個人身份登入，權限跟名冊身份，
   改權限＝改身份（「用戶」頁），所以門口只需要一個：
   打自己嘅電郵（團長／領袖）／YMIS（執委／團員）＋ 密碼。
   ============================================================ */
function renderLogin() {
  document.body.classList.add('login-body');
  const units = unitList();
  const code = currentUnit() || defaultUnitCode();
  const u = unitEntry(code) || {};

  /* 示範模式嘅登入畫面都要有「離開示範」——
     以前只有 app 入面嗰條黃色橫額有，一旦登出／未登入（例如喺「更多」撳登出）
     就完全冇掣返出去，用家感覺就係「入咗 MOCK 出唔返嚟」。 */
  const mockBanner = isMock() ? `
    <div class="gate-mock-banner" style="margin-bottom:14px;padding:12px 14px;border-radius:12px;
      background:repeating-linear-gradient(45deg,#B8892B,#B8892B 12px,#A2761F 12px,#A2761F 24px);color:#fff">
      <div class="semibold" style="font-size:13.5px">示範模式（MOCK）中 —— 而家睇嘅係假資料</div>
      <div class="xs" style="opacity:.92;margin:4px 0 10px">示範資料同真實旅團完全分開，唔會寫入任何 Google Sheet。</div>
      <div class="row gap-8 wrap">
        ${lastRealUnit() ? `<button class="btn btn-sm" id="btnBackReal">${icon('chevronL', 14)} 返 ${esc(lastRealUnit())}（真實旅團）</button>` : ''}
        <button class="btn btn-sm" id="btnExitMock">${icon('logout', 14)} 離開示範（返旅團選擇）</button>
        <button class="btn btn-sm" id="btnGate2">${icon('refresh', 14)} 揀其他旅團</button>
      </div>
    </div>` : `
    <div style="margin-bottom:14px" class="xs faint">
      <button class="btn btn-xs" id="btnGate2">${icon('refresh', 13)} 旅團選擇畫面</button>
    </div>`;

  app.innerHTML = `
  <div class="login-wrap">
    <aside class="login-hero">
      <div class="brandmark">
        <div class="logo">${esc(String(u.code || code || '82').replace(/^0+/, '') || '82')}</div>
        <div>
          <div style="font-weight:800;font-size:16px;letter-spacing:-.01em">深資童軍管理系統</div>
          <div class="xs" style="color:#F0D3D9">${esc(u.name || '深資童軍團')} · 自務自治</div>
        </div>
      </div>
      <div>
        <h1 class="hero-title">${esc(u.name || '深資童軍團')}<br>深資童軍管理系統</h1>
        <p class="hero-sub">會議、財務、團員、物資、團章 —— 一個地方搞掂。財務仲可以出「兩條數」（AGM 旅年度 ＋ 童軍年度）。</p>
        <div class="hero-list">
          ${[['團章內建，可改可輸出 Word / PDF / QR', 'book'],
             ['財務雙財政年度報告（AGM ＋ 4/1–3/31）', 'wallet'],
             ['物資借用自動加減庫存', 'grid'],
             ['生日前 7 日自動提示', 'sparkle']]
            .map(([t, i]) => `<div class="hero-item"><span class="tick">${icon(i, 11)}</span><span>${t}</span></div>`).join('')}
        </div>
      </div>
      <div class="xs" style="color:#D3A9B2">© ${new Date().getFullYear()} ${esc(u.name || '深資童軍管理系統')} · 內部使用</div>
    </aside>

    <main class="login-panel">
      <div class="login-card">
        ${mockBanner}
        ${loginSyncBanner()}

        <h1>登入</h1>
        <p class="sub">
          <b>一個人一個帳號</b>：用自己嘅電郵（團長／領袖）或者 YMIS 會籍編號（執委／團員）＋ 密碼。<br>
          入到去嘅權限＝你喺名冊嘅<b>身份</b>（團長／領袖／執委／團員）。
        </p>
        <form id="loginForm" autocomplete="off">
          <div class="field mt-8">
            <label class="label">電郵 或 YMIS 會籍編號</label>
            <input class="input" id="liUser" autocomplete="username"
              placeholder="團長／領袖：電郵　·　執委／團員：10 位 YMIS">
          </div>
          <div class="field mt-12">
            <label class="label">密碼</label>
            <input class="input" id="liPass" type="password" placeholder="首次：${TEMP_PASSWORD}" autocomplete="current-password">
          </div>
          <div id="liErr" class="err mt-8"></div>
          <button type="submit" class="btn btn-primary btn-lg btn-block mt-16">${icon('key', 17)} 進入系統</button>
        </form>
        <div class="hint mt-8">名冊有個名但未設密碼？首次用 <code>${TEMP_PASSWORD}</code> 入，入去即刻要改。</div>

        <button class="btn btn-ghost btn-block mt-8" type="button" id="btnForgotPassword">忘記密碼？用 EMAIL 重設</button>
        <button class="btn btn-block mt-8" type="button" id="btnApply">${icon('plus', 16)} 未開戶？申請開戶</button>

        <form id="setupKeyForm" class="mt-16" autocomplete="off" style="border-top:1px solid var(--line-2);padding-top:14px">
          <div class="semibold sm mb-8">新旅團開團 KEY（第一個設定嘅人就係「團長」）</div>
          <div class="hint mb-8">喺 Google 試算表 → Apps Script 執行 <code>issueSetupKey()</code>（每次 72 小時；過期再執行一次）。</div>
          <input class="input" id="liSetupKey" placeholder="貼上 EC72-… KEY">
          <div id="liKeyErr" class="err mt-8"></div>
          <button type="submit" class="btn btn-block mt-12">用 KEY 進入開戶</button>
        </form>

        <div class="mt-16">
          <button class="btn btn-block" id="btnMock">${icon('eye', 16)} 試用示範（MOCK）</button>
          <div class="hint mt-8">示範模式用假資料，同真實資料完全分開。</div>
        </div>
        <div class="mt-16" style="border-top:1px solid var(--line-2);padding-top:12px">
          <div class="xs faint">而家嘅旅團：<b class="mono">${esc(code)}</b>${isMock() ? '（示範模式）' : ''}</div>
          <button class="btn btn-xs mt-8" id="btnGate" type="button">${icon('refresh', 13)} 返回旅團選擇</button>
        </div>
      </div>
    </main>
  </div>`;

  const userInput = app.querySelector('#liUser');
  const passInput = app.querySelector('#liPass');
  const err = app.querySelector('#liErr');

  app.querySelector('#loginUnit')?.addEventListener('change', e => {
    pickedUnit = e.target.value;
    const url = new URL(location.href);
    url.searchParams.set('u', pickedUnit);
    location.href = url.toString();
  });

  app.querySelector('#btnMock')?.addEventListener('click', () => enterMock());
  app.querySelector('#btnRetrySync')?.addEventListener('click', async () => {
    const b = app.querySelector('#btnRetrySync');
    if (b) { b.disabled = true; b.textContent = '連線中…'; }
    const r = await syncBoot();
    if (!isMock() && !r?.ok) return renderBackendGate(r);
    renderLogin();
    toast('已由後端載入最新資料', 'ok');
  });
  app.querySelector('#loginDlGs')?.addEventListener('click', () => downloadCodeGs());
  app.querySelector('#loginGuide')?.addEventListener('click', openDeployGuideModal);
  app.querySelector('#btnGate')?.addEventListener('click', () => forgetChoice());
  /* 示範模式登入畫面嘅逃生門（見上面 mockBanner 註釋） */
  app.querySelector('#btnGate2')?.addEventListener('click', () => forgetChoice());
  app.querySelector('#btnExitMock')?.addEventListener('click', () => exitMock());
  app.querySelector('#btnBackReal')?.addEventListener('click', () => exitMockToUnit());

  app.querySelector('#btnApply')?.addEventListener('click', async () => {
    const r = await modal({
      title: '申請開戶',
      sub: '批核後首次密碼係 1234',
      body: `<div class="field"><label class="label">YMIS（10 位）</label>
          <input class="input" id="apY" inputmode="numeric"></div>
        <div class="field mt-12"><label class="label">姓名（同名冊）</label>
          <input class="input" id="apN"></div>
        <div class="field mt-12"><label class="label">電郵（可選）</label>
          <input class="input" id="apE"></div>
        <div id="apErr" class="err mt-8"></div>`,
      actions: [
        { label: '取消', class: 'btn', value: null },
        { label: '送出申請', class: 'btn-primary', onClick: el => {
          const ymis = el.querySelector('#apY').value, name = el.querySelector('#apN').value, email = el.querySelector('#apE').value;
          const res = applyAccount({ ymis, name, email });
          if (!res.ok) { el.querySelector('#apErr').textContent = res.msg; el.querySelector('#apErr').style.display = 'block'; return false; }
          return true;
        } }
      ]
    });
    if (r) toast('已送出，等團長／領袖批准', 'ok');
  });

  app.querySelector('#setupKeyForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const box = app.querySelector('#liKeyErr');
    if (box) { box.textContent = ''; box.style.display = 'none'; }
    /* 呢度唔使行硬閘：`loginSetupKey()` 本身就係打後端（action: verifySetupKey），
       佢自己就係「同後端核對」—— 核對唔到佢會回失敗。 */
    const res = await loginSetupKey(app.querySelector('#liSetupKey')?.value);
    if (!res.ok) {
      if (box) { box.textContent = res.msg; box.style.display = 'block'; }
      return;
    }
    document.body.classList.remove('login-body');
    applyTheme(load()?.unit?.theme);
    location.hash = '#/admin';
    render();
    maybeShowLoginConflicts();
    /* ★ 開戶嗰位 = 團長（每團一位）。仲未有團長 → 即刻問佢係邊個。 */
    await maybeClaimChief();
  });

  app.querySelector('#btnForgotPassword')?.addEventListener('click', async () => {
    const r = await modal({
      title: '忘記密碼',
      sub: '請輸入登記過的 EMAIL；如果帳戶存在，系統會寄出一次性重設連結。',
      body: `<div class="field"><label class="label">EMAIL</label><input class="input" id="forgotEmail" type="email" autocomplete="email"></div><div id="forgotErr" class="err mt-8"></div>`,
      actions: [
        { label: '取消', class: 'btn', value: null },
        { label: '寄出重設連結', class: 'btn-primary', onClick: async el => {
          const email = el.querySelector('#forgotEmail')?.value?.trim() || '';
          if (!email) { el.querySelector('#forgotErr').textContent = '請輸入 EMAIL'; el.querySelector('#forgotErr').style.display = 'block'; return false; }
          try {
            const response = await fetch('./api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'authForgotPassword', unit: code, email, resetUrl: `${location.origin}/reset-password.html` }) });
            const data = await response.json();
            if (!response.ok || data.success === false) throw new Error(data.error || '暫時未能提交');
            return true;
          } catch (error) { el.querySelector('#forgotErr').textContent = error.message || '暫時未能提交，請稍後再試'; el.querySelector('#forgotErr').style.display = 'block'; return false; }
        } }
      ]
    });
    if (r) toast('如果 EMAIL 已登記，重設連結會寄出。', 'ok');
  });

  app.querySelector('#loginForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    err.style.display = 'none';
    const btn = app.querySelector('#loginForm button[type=submit]');
    btn.disabled = true;
    /* ★ 硬閘：登入嗰一刻一定要同後端核對過。核對唔到 → 唔入。
       （後端載入成功＝本機呢份名冊密碼就係後端嗰份 → 個人身份登入即係核對過後端。） */
    const gate = await gateLoginOnBackend();
    if (!gate.ok) {
      if (!isMock()) return renderBackendGate(gate);
      btn.disabled = false;
      passInput.value = '';
      renderLogin();
      toast(gateMessage(gate), 'err');
      return;
    }
    let res = await login('staff', userInput.value, passInput.value);
    /* 舊個人帳戶（開喺後端但本機名冊冇）：最後試一次後端核對 —— 唔會靜靜哋放行。 */
    if (!res.ok && !isMock() && res.notFound === true) {
      const srv = await loginServer('staff', userInput.value, passInput.value).catch(() => ({ ok: false }));
      if (srv?.ok) res = srv;
    }
    btn.disabled = false;
    if (!res.ok) {
      err.textContent = res.msg;
      err.style.display = 'block';
      passInput.value = '';
      passInput.focus();
      return;
    }
    /* 團員（identity = member）登入 → 去團員入口（members.html），唔係管理系統 */
    if (res.role === 'member' && res.member) {
      const { saveHubAuth } = await import('./lib/hub-session.js');
      const { saveMe } = await import('./lib/member-me.js');
      saveHubAuth(code, { id: res.member.id, name: res.member.name, ymis: res.member.ymis, identity: 'member', mustChangePw: !!res.mustChangePw });
      saveMe({ id: res.member.id, name: res.member.name });
      location.href = `./members.html?u=${encodeURIComponent(code)}${res.mustChangePw ? '#forcepw' : ''}`;
      return;
    }
    document.body.classList.remove('login-body');
    applyTheme(load()?.unit?.theme);
    location.hash = '#/dashboard';
    render();
    if (res.mustChangePw) maybeForceChangePw();
    maybeShowLoginConflicts();
    /* ★ 第一個設定嗰位係團長：仲未有團長 → 入到去即刻問（可以撳「稍後」） */
    await maybeClaimChief();
  });
}

/**
 * ★ 開戶嗰個 = 團長（2026-09-24）。
 * 仲未有團長嘅話，用開團 KEY／領袖身份入到去嘅第一件事就係認領團長身份；
 * 唔想即刻設都可以撳「稍後」—— 「用戶」頁同「身份與權限」頁都會再提示。
 */
async function maybeClaimChief() {
  const auth = await import('./lib/auth.js');
  if (auth.current()?.role === 'super') return;
  if (!auth.canClaimChief()) return;
  const s = auth.current() || {};
  const me = s.memberId ? (await import('./lib/model.js')).member(s.memberId) : null;
  const r = await modal({
    title: '設定團長身份',
    sub: '每個旅團永遠只有一個團長（最高權限，可以轉移）。第一個開戶嘅人就係團長。',
    body: chiefFormHtml(me),
    actions: [
      { label: '稍後再設', class: 'btn', value: null },
      { label: '確定', class: 'btn-primary', onClick: async el => {
        const box = el.querySelector('#chiefErr');
        const info = {
          name: el.querySelector('#cName')?.value?.trim() || '',
          email: el.querySelector('#cEmail')?.value?.trim() || '',
          password: el.querySelector('#cPw')?.value || '',
          ymis: el.querySelector('#cYmis')?.value?.trim() || ''
        };
        if (!me && !info.name) { box.textContent = '請填姓名'; box.style.display = 'block'; return false; }
        if (!info.password) { box.textContent = '請設定一個密碼（最少 4 個字）'; box.style.display = 'block'; return false; }
        if (info.password.length < 4) { box.textContent = '密碼最少 4 個字'; box.style.display = 'block'; return false; }
        const res = await auth.claimChief(info);
        if (!res.ok) { box.textContent = res.msg; box.style.display = 'block'; return false; }
        return true;
      } }
    ]
  });
  if (r) {
    toast('已設定團長身份（可以隨時轉移畀下一位）', 'ok');
    render();
  }
}

function chiefFormHtml(me) {
  if (me) {
    return `<p class="sm mb-12">你而家嘅身份係「<b>${esc(me.name)}</b>」。確定之後你就係團長。</p>
      <div class="field"><label class="label">電郵（之後用呢個登入；可以留空用 YMIS）</label>
        <input class="input" id="cEmail" type="email" value="${esc(me.email || '')}"></div>
      <div class="field mt-12"><label class="label">設定密碼（最少 4 個字）</label>
        <input class="input" id="cPw" type="password" autocomplete="new-password"></div>
      <div id="chiefErr" class="err mt-8"></div>`;
  }
  return `<div class="field"><label class="label">姓名</label><input class="input" id="cName"></div>
    <div class="field mt-12"><label class="label">電郵（之後用呢個登入）</label>
      <input class="input" id="cEmail" type="email" placeholder="scouter@example.com"></div>
    <div class="field mt-12"><label class="label">YMIS（可留空）</label><input class="input" id="cYmis"></div>
    <div class="field mt-12"><label class="label">密碼（最少 4 個字）</label>
      <input class="input" id="cPw" type="password" autocomplete="new-password"></div>
    <div id="chiefErr" class="err mt-8"></div>`;
}

/** ★ 登入硬閘（2026-09-20 團長定案）：後端答唔到 → 一律唔准入主控頁。
 *  以前呢度係 `freshenBeforeLogin()`：「連唔到就照登入，橫額會話你知」——
 *  於係出現咗團長講嗰句：「既然都同後端對咗帳戶密碼，點可能入去之後話冇連上後端？」
 *  答案係：根本冇對過（當時 `login()` 係對本機嗰份帳戶名單，後端由頭到尾冇被問過）。
 *  ★ 2026-09-24：名冊同密碼都係**呢個旅團後端**嗰份（冇共用帳戶之後，
 *     本機嗰份就係後端拉落嚟嘅名冊）—— 所以呢個閘更加重要：
 *     先由後端載入成功（`requireBackendForLogin()`），名冊／密碼對得上先算真係核對過。
 *  而家：開機／核對唔到就停喺連線閘，唔會顯示登入表單。 */
async function gateLoginOnBackend() {
  if (isMock()) return { ok: true, mock: true };
  if (!remoteApi) {
    bootSyncWarn = { ok: false, error: '同步模組載入失敗 —— 請重新整理頁面再試' };
    return bootSyncWarn;
  }
  try {
    const g = await remoteApi.requireBackendForLogin();
    bootSyncWarn = g.ok ? null : g;
    paintSyncChip();
    return g;
  } catch (e) {
    console.warn('[sync] 登入前核對後端失敗', e);
    bootSyncWarn = { ok: false, error: e?.message || String(e) };
    paintSyncChip();
    return bootSyncWarn;
  }
}

/** 登入閘失敗嗰陣嘅人話（登入頁同錯誤位共用） */
function gateMessage(g) {
  const why = g?.error || '連唔到旅團後端';
  return `登入已封鎖 —— ${why}`;
}

/** 登出確認：有未儲存改動一定要講明（改動會留喺呢部機，下次登入再三方比對） */
async function confirmLogout() {
  const pending = Number(tryLoad()?.sync?.pending || 0);
  const warn = pending > 0
    ? `<div class="note-box warn mt-8">${icon('alert', 14)}<div>仲有 <b>${pending}</b> 項改動未儲存到後端。登出唔會寫入後端；改動會留喺呢部機，下次開機再同後端比對。<br>想而家就儲存，撳「取消」再撳右上角「儲存到後端」。</div></div>`
    : '';
  return modal({
    title: '登出', body: `<p class="sm">確定登出系統？</p>${warn}`,
    actions: [{ label: '取消', class: 'btn', value: false }, { label: pending > 0 ? '照登出（暫不儲存）' : '登出', class: 'btn-primary', value: true }]
  });
}

/** 登出 → 出返登入頁，同時由後端攞多次（下一個人登入嗰一刻 ＝ 後端嗰一刻） */
async function doLogout() {
  logout();
  document.body.classList.add('login-body');
  const r = await syncBoot();
  if (!isMock() && !r?.ok) return renderBackendGate(r);
  renderLogin();
}

async function maybeForceChangePw() {
  const s = current();
  if (!s?.mustChangePw || s.role === 'super' || s.mock) return;
  const r = await modal({
    title: '首次登入：請改密碼',
    sub: `唔可以繼續用預設密碼 ${TEMP_PASSWORD}`,
    body: `<p class="sm mb-12">為安全起見，第一次登入要設自己嘅密碼（至少 4 個字，唔可以係 ${TEMP_PASSWORD}）。</p>
      <div class="field"><label class="label">新密碼</label>
        <input class="input" id="fp1" type="password" autocomplete="new-password"></div>
      <div class="field mt-12"><label class="label">再輸入一次</label>
        <input class="input" id="fp2" type="password" autocomplete="new-password"></div>
      <div id="fpErr" class="err mt-8"></div>`,
    actions: [
      { label: '儲存新密碼', class: 'btn-primary', onClick: el => {
        const p1 = el.querySelector('#fp1').value, p2 = el.querySelector('#fp2').value;
        const err = el.querySelector('#fpErr');
        if (p1.length < 4) { err.textContent = '至少 4 個字元'; err.style.display = 'block'; return false; }
        if (p1 === TEMP_PASSWORD) { err.textContent = '唔可以繼續用預設密碼'; err.style.display = 'block'; return false; }
        if (p1 !== p2) { err.textContent = '兩次輸入唔一樣'; err.style.display = 'block'; return false; }
        return p1;
      } }
    ]
  });
  if (!r) return maybeForceChangePw();
  const res = await changeOwnPassword('', r);
  toast(res.ok ? '密碼已更改，下次請用新密碼登入' : (res.msg || '改唔到'), res.ok ? 'ok' : 'err');
}

/* 撳分頁去邊個 hash。
   大部分 section 都係 #/<section>/<tab>，但有啲 view 嘅預設分頁係住喺個「淨係 section」
   嘅 hash（例如 #/inventory 就係「物資清單」），咁就唔好加個 /items 落去，
   否則會撳完一次之後 render 同 hash 對唔上。 */
const TAB_AT_ROOT = { inventory: 'items' };
function tabHash(section, tab) {
  return TAB_AT_ROOT[section] === tab ? `#/${section}` : `#/${section}/${tab}`;
}

/* ============================================================
   SHELL
   ============================================================ */
function render() {
  if (bootError) return renderFatal(bootError);
  if (!current()) return renderLogin();
  const r = parse();
  const view = VIEWS[r.section] || VIEWS.dashboard;
  const u = profile();
  const mock = isMock();
  const info = seedInfo();

  app.innerHTML = `
  ${mock ? mockBar() : ''}
  ${info.failed && !mock ? `<div class="banner warn no-print" style="border-radius:0">
      ${icon('alert', 16)} 讀唔到 <code>data/units/${esc(currentUnit())}/</code> 嘅資料檔案，系統用空白資料庫啟動。請用 HTTP 伺服器開啟或部署上網。
    </div>` : ''}
  <div class="shell">
    <nav class="sidebar">
      <div class="sb-brand">
        <div class="logo">${esc(String(u.code || currentUnit() || '82').replace(/^0+/, '') || '82')}</div>
        <div>
          <div class="t truncate">${esc(u.name || '深資童軍團')}</div>
          <div class="s truncate">深資童軍管理系統</div>
        </div>
      </div>

      <div style="padding:10px 10px 0">
        <button type="button" id="unitSwitch" class="unit-chip" style="width:100%;justify-content:space-between"
          title="切換旅團（示範模式下揀真實旅團＝離開示範）">
          <span>${icon('flag', 13)} ${esc(currentUnit())}</span>
          <span class="faint xs">${icon('chevronR', 13)}</span>
        </button>
      </div>

      <div class="sb-nav">
        ${NAV.map(n => sidebarItem(n, r.section)).join('')}
      </div>
      <div class="sb-foot">
        <div class="sb-user">
          <span class="avatar avatar-sm" style="background:${mock ? MAROON.accent : ROLES[currentRole()]?.color || MAROON.brand700}">
            ${icon(currentRole() === 'super' ? 'shield' : currentRole() === 'chief' ? 'sparkle' : currentRole() === 'leader' ? 'flag' : 'users', 14)}</span>
          <div class="grow" style="min-width:0">
            <div class="n truncate">${esc(displayName())}</div>
            <div class="r truncate">${esc(displaySub())}</div>
          </div>
          <button class="btn btn-ghost btn-xs btn-icon" id="btnPw" title="改密碼" style="color:#D3A9B2">${icon('key', 15)}</button>
          <button class="btn btn-ghost btn-xs btn-icon" id="btnLogout" title="登出" style="color:#D3A9B2">${icon('logout', 15)}</button>
        </div>
      </div>
    </nav>

    <div class="main">
      <header class="topbar">
        <div style="min-width:0">
          <div class="tb-title truncate">${esc(view.title ? view.title() : '')}</div>
          <div class="tb-sub truncate">${esc(u.name || '')} ${mock ? '· 示範模式' : ''}</div>
        </div>
        <div class="row gap-8">
          <span id="syncChip" class="no-print"></span>
          ${mock ? `<button class="btn btn-sm no-print" id="topMockExit" title="離開示範模式">${icon('logout', 14)} 離開示範</button>` : ''}
          ${notices().length ? `<span class="badge b-warn no-print"><span class="dot"></span>${notices().length} 項提示</span>` : ''}
          <button class="btn btn-ghost btn-sm hide-desktop" id="btnPw2" title="改密碼">${icon('key', 16)}</button>
          <button class="btn btn-ghost btn-sm hide-desktop" id="btnLogout2" title="登出">${icon('logout', 16)}</button>
        </div>
      </header>
      <div class="content" id="view">${view.render(r)}</div>
    </div>

    <nav class="tabbar">
      ${MOBILE_MAIN.map(id => {
        const n = NAV.find(x => x.id === id);
        return `<button data-nav="${id}" aria-current="${r.section === id ? 'page' : 'false'}">
          <span class="ic">${icon(n.icon, 20)}</span><span>${n.label}</span></button>`;
      }).join('')}
      <button data-nav="more" aria-current="${!MOBILE_MAIN.includes(r.section) ? 'page' : 'false'}">
        <span class="ic">${icon('grid', 20)}</span><span>更多</span></button>
    </nav>
  </div>`;

  // 綁定
  app.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.nav;
    if (id === 'more') return moreSheet();
    go('#/' + id);
  }));
  app.querySelectorAll('#btnLogout, #btnLogout2').forEach(el => el.addEventListener('click', async () => {
    if (isMock()) {
      exitMock();
      return;
    }
    if (await confirmLogout()) doLogout();
  }));
  app.querySelector('#topMockExit')?.addEventListener('click', () => exitMock());
  app.querySelectorAll('#btnPw, #btnPw2').forEach(el => el.addEventListener('click', async () => {
    go('#/admin/data');
  }));

  /* 示範橫額「以 XXX 身份預覽」：<select> 撳落去選值係 change 事件（唔係 click），
     以前用 document click 攞 e.target.id 永遠攞唔到 → 下拉框係壞嘅。 */
  app.querySelector('#mockRole')?.addEventListener('change', e => {
    loginAsMock(e.target.value);
    render();
  });

  /* 任何分頁嘅「欄位」掣（data-fields="transactions" / members / invItems / notices / meetings…）
     都會打開同一個欄位設計器 —— 唔再需要一個獨立「表格」分頁 */
  app.querySelectorAll('[data-fields]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    openFieldDesigner(b.dataset.fields, { onSaved: () => window.dispatchEvent(new CustomEvent('v82:refresh')) });
  }));

  /* ---- 分頁掣（ui.js 個 tabs()）：全域統一綁 ----
     以前每個 view 要自己喺 mount() 綁一次 [data-tab]，漏咗就成頁分頁死晒。
     「帳號與系統」「通告」「表格與同步」就係咁壞咗 —— 六個分頁一粒都撳唔郁，
     連帶入面所有掣（改密碼、備份、旅團設定…）都永遠去唔到，
     用家見到嘅就係「所有掣都壞咗」。
     而家 tabs() 吐出嚟嘅 <div data-tabnav> 一律喺呢度處理：撳分頁 ＝ 去 #/<section>/<tab>。
     注意：淨係揀 [data-tabnav] 入面嘅掣。View 自己手砌、唔想改 hash 嘅
     local 分頁（例如 meetings.js 會議詳情嗰啲）唔會被搶。 */
  app.querySelectorAll('#view [data-tabnav] [data-tab]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tab;
    if (!t) return;
    go(tabHash(r.section, t));
  }));

  const root = app.querySelector('#view');
  try { view.mount(root, r); } catch (e) { console.error('mount error', e); }
  paintSyncChip();
  window.scrollTo({ top: 0 });
}

function mockBar() {
  const role = currentRole();
  const back = lastRealUnit();
  return `
  <div class="mock-bar">
    <span class="tag">MOCK 示範模式</span>
    <span>你而家睇嘅係假資料，所有改動只會寫入示範空間，唔會影響真實資料。</span>
    <div class="btns">
      <select id="mockRole" class="select" style="height:30px;font-size:12.5px;padding:0 8px">
        ${['chief', 'leader', 'exco', 'member', 'super'].map(r => `<option value="${r}" ${role === r ? 'selected' : ''}>以 ${ROLES[r].name} 身份預覽</option>`).join('')}
      </select>
      <button id="mockReset">重設示範</button>
      ${back ? `<button id="mockBackReal">返 ${esc(back)}（真實）</button>` : ''}
      <button id="mockExit">離開示範</button>
    </div>
  </div>`;
}

function sidebarItem(n, active) {
  let b = 0;
  try { b = n.badge ? n.badge() : 0; } catch { b = 0; }
  return `<button class="sb-item" data-nav="${n.id}" aria-current="${active === n.id ? 'page' : 'false'}">
    ${icon(n.icon, 18)}<span>${n.label}</span>
    ${b ? `<span class="cnt">${b}</span>` : ''}
  </button>`;
}

function moreSheet() {
  const items = NAV.filter(n => !MOBILE_MAIN.includes(n.id));
  modal({
    title: '更多',
    body: `<div class="grid g-2" style="gap:10px">
      ${items.map(n => `<button class="role-card" data-more="${n.id}" style="flex-direction:column;align-items:flex-start;gap:6px">
        <span class="role-ic">${icon(n.icon, 18)}</span><span class="role-name">${n.label}</span></button>`).join('')}
      <button class="role-card" data-more="logout" style="flex-direction:column;align-items:flex-start;gap:6px">
        <span class="role-ic">${icon('logout', 18)}</span><span class="role-name">${isMock() ? '離開示範' : '登出'}</span></button>
    </div>`,
    actions: [],
    onMount: el => {
      el.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', async () => {
        const id = b.dataset.more;
        const { closeModal } = await import('./lib/util.js');
        closeModal(null);
        /* 示範模式冇「登出」呢回事 —— 以前呢度 logout() + renderLogin() 會將用家
           留喺一個示範模式嘅登入畫面，又冇橫額又冇掣，睇落好似走唔到。 */
        if (id === 'logout') {
          if (isMock()) { exitMock(); return; }
          if (await confirmLogout()) doLogout();
          return;
        }
        go('#/' + id);
      }));
    }
  });
}

async function unitPicker() {
  const units = unitList();
  const cur = currentUnit();
  await modal({
    title: '選擇旅團',
    sub: `${units.length} 個旅團 · 每個旅團資料獨立`,
    wide: true,
    body: `<div class="unit-grid">
      ${units.map(x => `<button class="unit-card" data-unit="${esc(x.code)}" ${x.code === cur ? 'disabled' : ''}>
        <span class="code">${esc(x.code)}</span>
        <span class="grow"><span class="semibold" style="display:block">${esc(x.name || '')}</span>
          <span class="xs faint">${esc(x.nameEn || '')}${unitSourceTags(x)}</span></span>
        ${x.code === cur ? '<span class="badge b-brand">目前</span>' : icon('chevronR', 16)}
      </button>`).join('')}
    </div>
    ${isMock() ? `<div class="note-box warn mt-16">${icon('alert', 15)}<div>
        你而家喺<b>示範模式</b> —— 揀上面任何一個旅團都會離開示範，返回真實資料（示範資料唔會受影響）。
      </div></div>` : ''}
    <div class="row gap-8 wrap mt-16">
      <button class="btn btn-sm" data-act="pick-gate">${icon('refresh', 14)} 旅團選擇畫面（重新載入清單／轉示範）</button>
      <button class="btn btn-sm" data-act="pick-diag">${icon('target', 14)} 診斷伺服器登記</button>
    </div>
    <div class="hint mt-8">冇你想揀嘅旅團？新旅團要由管理員喺 Vercel 加 <code>TROOP_&lt;編號&gt;_BACKEND</code> 等環境變數（詳見 <code>docs/ADD_NEW_UNIT.md</code>）。</div>`,
    actions: [{ label: '關閉', class: 'btn', value: null }],
    onMount: el => {
      el.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
        const code = b.dataset.unit;
        if (code === cur && !isMock()) return;
        switchUnit(code);
      }));
      el.querySelector('[data-act="pick-gate"]')?.addEventListener('click', () => forgetChoice());
      el.querySelector('[data-act="pick-diag"]')?.addEventListener('click', async () => {
        const { closeModal } = await import('./lib/util.js');
        closeModal(null);
        openRegistryDiag();
      });
    }
  });
}

/* 示範模式橫額按鈕（每次 render 後重新綁定） */
document.addEventListener('click', async e => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === 'mockExit') { exitMock(); return; }
  if (t.id === 'mockBackReal') { exitMockToUnit(); return; }
  /* 側邊欄旅團徽章＝切換旅團入口（unitPicker 會列晒登記咗嘅旅團，
     示範模式揀真實旅團會即時離開示範 —— 逃生門之一） */
  if (t.closest('#unitSwitch')) { unitPicker(); return; }
  if (t.id === 'mockReset') {
    if (await confirmDlg({ title: '重設示範資料', okText: '確定重設', message: '會把示範資料還原成 <code>data/mock/</code> 嘅初始內容。' })) {
      clearMockData();
      const url = new URL(location.href);
      url.searchParams.set('mock', '1');
      location.href = url.toString();
    }
    return;
  }
  /* mockRole 已改做 render() 入面綁 change（select 唔係 click 事件） */
});

boot();
