/* ============================================================
   public-hub.js — 團員入口（members.html）
   ------------------------------------------------------------
   2026-09-18 深夜大修（團長回報 6 項問題嘅 1／2／4／5／6）：
   ① 登入由旅團後端（Google Sheet）核對；成功後只拉「本人可見安全投影」
     —— 以前淨係讀本機，新裝置／無痕視窗全部空白；中途版本又曾直接拉成份
     行政資料庫。現時唔會把密碼 hash、他人請假／答卷／RSVP 送到團員瀏覽器。
     團員提交則走本人專用 action，即時寫返後端，唔經整庫同步。冇背景 poll。
   ② 回覆出席／交卷直接用登入身份（YMIS 登入咗就知你係邊個）——
     以前要「填自己個名」，但個名欄原來冇 render 到，結果次次
     都彈「請填名」而根本冇位填（= 報出席永遠失敗）。
   ③ 登入狀態由 sessionStorage 改做 localStorage（hub-session.js），
     返轉頭唔使重新登入。
   ④ 截止咗報名嘅通告／過去咗嘅活動唔會排先做「提醒」，但**內容照顯示**
     （擺後＋標「已截止／已完結」）—— 報咗名嘅想睇返內容、遲咗想報嘅
     可以搵領袖／執委跟進。草稿先係完全唔出街。
   ============================================================ */
import { loadRegistry, defaultUnitCode } from './lib/units.js';
import { init, load, getSession, setSession } from './lib/store.js';
import { profile, publicEvents, RSVP, quizzes, activeMembers, troopPublicLinks, identityOf, IDENTITIES } from './lib/model.js';
import { visibleTo, contentVis } from './lib/content-visibility.js';
import { loadMe, saveMe } from './lib/member-me.js';
import { loadHubAuth, saveHubAuth, clearHubAuth } from './lib/hub-session.js';
import { beFromQuery } from './lib/gateway.js';
import { loginMember, changeMemberOwnPassword, TEMP_PASSWORD } from './lib/auth.js';
import { progressConfigured, loadMyProgress, loadItems, flattenItems, memberDetail, submitProgressRequest } from './lib/progress.js';
import { absencesOf, allAbsences, ABSENCE_STATUS, ABSENCE_SLOTS, absenceCounts } from './lib/absence.js';
import { esc, icon, toast, todayISO, modal, confirmDlg, closeAllModals, uid, safeHref } from './lib/util.js';
import { uncertainWriteText, finishOperation } from './lib/operations.js';
import { boundedPercent } from './views/ui.js';

const app = document.getElementById('app');
let syncReady = false;      /* 後端路由準備好（已有 session 就完成安全投影核實）先畀登入 */
/* 拉唔到後端嘅真正原因 —— 一定要顯示出嚟。以前淨係 console.warn，
   團員見到嘅係一個正常嘅登入頁，但名冊係空 → 點都入唔到，
   完全唔知發生咩事（2026-09-19 團長回報「公開連結冇修好」）。 */
let syncError = '';
/* 團員入口嘅 remote 模組引用（syncBoot 入面 assign）。
   rsvp()／submitQuiz() 要用佢 —— 見 pushSubmit() 註解。 */
let hubRemote = null;
/* 本人 mutation 唔再先改本機：pending／確定未套用／結果未知分開顯示。
   只有 not_applied 才可原封重試；unknown 會鎖住並核對後端投影，絕不盲目重送。
   成功回應帶 server projection，remote 採用後先重畫，所以毋須「估」回滾。 */
let hubSubmitState = { pending: false, retry: null, unknown: null };
const HUB_UNCERTAIN_KEY = 'venture82.hub-uncertain.v1';

function hubUncertainMap() {
  try {
    const value = JSON.parse(localStorage.getItem(HUB_UNCERTAIN_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function hubActorKey(auth = loadHubAuth(code())) {
  const subject = String(auth?.id || auth?.ymis || '').trim();
  return subject ? `${code()}:${subject}` : '';
}
function rememberHubUnknown(value, auth = loadHubAuth(code())) {
  const key = hubActorKey(auth);
  if (!key) return;
  try { localStorage.setItem(HUB_UNCERTAIN_KEY, JSON.stringify({ ...hubUncertainMap(), [key]: value })); } catch { /* memory state still locks this page */ }
}
function clearRememberedHubUnknown(auth = loadHubAuth(code())) {
  const key = hubActorKey(auth);
  if (!key) return;
  try {
    const map = hubUncertainMap();
    delete map[key];
    localStorage.setItem(HUB_UNCERTAIN_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}
function restoreRememberedHubUnknown(auth = loadHubAuth(code())) {
  const key = hubActorKey(auth);
  const value = key ? hubUncertainMap()[key] : null;
  return value && value.operationId && value.kind && value.payload
    ? { pending: false, retry: null, unknown: value }
    : { pending: false, retry: null, unknown: null };
}

function hubSubmitBanner() {
  if (hubSubmitState.pending) {
    return `<div class="note-box info mb-12" id="hubSubmitState">${icon('cloud', 14)}<div><b>${esc(hubSubmitState.pending)}送出中…</b><div class="xs mt-4">請勿關閉頁面。</div></div></div>`;
  }
  const unknown = hubSubmitState.unknown;
  if (unknown) return `<div class="note-box warn mb-12" id="hubSubmitState">${icon('alert', 14)}<div class="grow">
    <b>${esc(unknown.what)}結果未知，已鎖住重送</b>
    <div class="xs mt-4">${esc(uncertainWriteText(unknown.operationId))}</div>
    <button class="btn btn-xs mt-8" id="hubCheckSubmit" type="button">重新載入本人資料核對</button>
  </div></div>`;
  const retry = hubSubmitState.retry;
  if (!retry) return '';
  return `<div class="note-box danger mb-12" id="hubSubmitState">${icon('alert', 14)}<div class="grow">
    <b>${esc(retry.what)}確定未送到</b><div class="xs mt-4">${esc(retry.error || '後端拒絕請求')}。本機畫面未當作成功；可以安全重試。</div>
    <button class="btn btn-xs btn-danger mt-8" id="hubRetrySubmit" type="button">重新送出</button>
  </div></div>`;
}

function hubMutationVisible(kind, payload = {}) {
  const db = load();
  const memberId = String((db.members || [])[0]?.id || '');
  if (kind === 'rsvp') {
    const mine = (db.events || []).find(row => String(row.id || '') === String(payload.eventId || ''))?.rsvp?.[memberId];
    return !!mine && String(mine.status || '') === String(payload.status || '')
      && String(mine.time || '') === String(payload.time || '')
      && String(mine.reason || '') === String(payload.reason || '');
  }
  if (kind === 'quiz') {
    const answers = (db.quizzes || []).find(row => String(row.id || '') === String(payload.quizId || ''))?.responses?.[memberId]?.answers;
    if (!answers || typeof answers !== 'object') return false;
    return Object.entries(payload.answers || {}).every(([key, value]) => JSON.stringify(answers[key] ?? '') === JSON.stringify(value ?? ''));
  }
  if (kind === 'notice') {
    const signup = (db.notices || []).find(row => String(row.id || '') === String(payload.noticeId || ''))?.mySignup;
    if (!signup?.answers || typeof signup.answers !== 'object') return false;
    return Object.entries(payload.answers || {}).every(([key, value]) => JSON.stringify(signup.answers[key] ?? '') === JSON.stringify(value ?? ''));
  }
  if (kind === 'absence') {
    const row = (db.absences || []).find(item => String(item.id || '') === String(payload.id || ''));
    if (payload.op === 'withdraw') return !row;
    return !!row && String(row.date || '') === String(payload.date || '')
      && String(row.slot || '') === String(payload.slot || '')
      && String(row.reason || '') === String(payload.reason || '')
      && String(row.plan || '') === String(payload.plan || '');
  }
  return false;
}

/**
 * 團員交嘢（回覆出席／交卷）之後**即刻**寫返後端。
 *
 * 團員交嘅嘢係**入站資料**：呢部機係團員嘅，佢交完就關，永遠唔會有人喺佢部機
 * 撳「儲存到後端」。如果暫存住，份回覆就永遠困喺團員部機 —— 等如冇交過。
 *
 * 所以入站提交即刻走 hubRsvp／hubQuiz／hubNoticeSignup／hubAbsence：GAS 由 opaque session 對回本人，
 * 完全唔採用 client memberId／role，只改本人嗰格。寫完回本人安全投影，唔會下載、
 * 亦唔會上傳整份行政資料庫。
 */
async function pushSubmit(what, kind, payload) {
  if (hubSubmitState.pending) return { ok: false, error: '上一項仍在送出' };
  if (hubSubmitState.unknown) {
    toast('上一項結果仍然未知；請先重新載入核對，系統冇重送', 'warn');
    return { ok: false, outcome: 'unknown', error: '上一項結果仍然未知' };
  }
  const fail = (error) => {
    hubSubmitState = { pending: false, unknown: null,
      retry: { what, kind, payload: JSON.parse(JSON.stringify(payload || {})), error: String(error || '未知錯誤') } };
    paint();
    toast(`${what}確定未送到後端 —— 可以按「重新送出」`, 'warn');
    return { ok: false, outcome: 'not_applied', error: String(error || '未知錯誤') };
  };
  const unknown = (result = {}) => {
    const operationId = String(result.operationId || result.operation_id || result.operation?.id || '');
    hubSubmitState = { pending: false, retry: null,
      unknown: { what, kind, payload: JSON.parse(JSON.stringify(payload || {})), operationId, error: String(result.error || '') } };
    rememberHubUnknown(hubSubmitState.unknown);
    paint();
    toast(`${what}結果未知；操作 ${operationId || '未提供'}。系統冇重送。`, 'warn');
    return { ...result, ok: false, outcome: 'unknown', mayHaveApplied: true, operationId };
  };
  if (!hubRemote?.remoteConfigured?.()) return fail('旅團後端未設定');
  const auth = loadHubAuth(code());
  if (!auth?.sessionToken) return fail('登入狀態已失效，請重新登入');
  hubSubmitState = { pending: what, retry: null, unknown: null };
  paint();
  try {
    const options = { sessionToken: auth.sessionToken };
    const r = kind === 'rsvp'
      ? await hubRemote.saveHubRsvp(payload, options)
      : kind === 'quiz'
        ? await hubRemote.saveHubQuiz(payload, options)
        : kind === 'notice'
          ? await hubRemote.saveHubNoticeSignup(payload, options)
          : await hubRemote.saveHubAbsence(payload, options);
    const outcome = String(r?.outcome || r?.operation?.outcome || '').toLowerCase();
    if (outcome === 'unknown' || outcome === 'processing') return unknown(r);
    if (outcome === 'not_applied' || outcome === 'not_sent') return fail(r?.error || '後端拒絕請求');
    if (outcome !== 'applied' && r?.mayHaveApplied === true) return unknown(r);
    if (outcome !== 'applied' && !r?.ok) return fail(r?.error || '後端拒絕請求');
    /* 明確 applied 優先過 transport envelope。後端回嘅係寫完之後嘅本人
       安全投影；remote 採用後先當成功。 */
    hubSubmitState = { pending: false, retry: null, unknown: null };
    clearRememberedHubUnknown(auth);
    paint();
    toast(`${what}已送出`, 'ok');
    return r;
  } catch (e) {
    return unknown({ error: e?.message || '網絡錯誤' });
  }
}

/* 通告係咪已過報名截止（冇截止日／唔使報名＝未截止） */
function closedN(n, today) {
  return !!(n.needSignup && n.deadline && String(n.deadline) < today);
}

function clearHubIdentity(auth = loadHubAuth(code())) {
  clearHubAuth(code());
  const shared = getSession();
  if (auth?.sessionToken && shared?.sessionToken === auth.sessionToken) setSession(null);
}

async function boot() {
  const u = new URLSearchParams(location.search);
  const code = (u.get('u') || '').trim() || defaultUnitCode();
  await loadRegistry();
  /* 團員投影用獨立 store namespace，絕不覆蓋同瀏覽器行政 DB／base。
     ?be= 經 Apps Script /exec 白名單後只作 routing，令未登記旅團的自助連結
     都可登入；安全空殼不會為取得路由而讀完整靜態行政 seed。 */
  await init({ mode: 'hub', scope: 'hub', unit: code, backendUrl: beFromQuery() });
  /* 未確認寫入跨 reload 保持鎖住；否則 timeout 後重新整理就會產生新
     operation ID，使用者一撳便可能重複交 RSVP／答卷／請假。 */
  hubSubmitState = restoreRememberedHubUnknown(loadHubAuth(code));
  app.innerHTML = '<div class="hub-wrap" style="padding-top:32px"><div class="card card-pad muted">正在連接旅團後端…</div></div>';
  await syncBoot();
}

/* 未登入時唔再下載行政資料庫。已有 opaque session 就先由 GAS 核實，再採用
   只含本人可見內容嘅安全投影；核實失敗絕不畫本機快取嘅私有內容。 */
async function syncBoot() {
  try {
    hubRemote = await import('./lib/remote.js');
    const store = await import('./lib/store.js');
    store.setSaveHook(null);       // 團員寫入走 hubRsvp/hubQuiz/hubAbsence，唔走整庫同步
    if (!hubRemote.remoteConfigured?.()) {
      syncError = '呢個網址冇帶旅團編號，或者未接後端 —— 請用系統「團員入口」頁重新產生登入連結。';
    } else {
      const auth = loadHubAuth(code());
      if (auth?.sessionToken) {
        const rc = await hubRemote.loadHubView({ sessionToken: auth.sessionToken });
        if (!rc?.ok) {
          clearHubIdentity(auth);
          syncError = rc?.error || '登入狀態已失效，請重新登入';
        } else {
          const canonical = canonicalHubAuth(auth);
          if (canonical?.id !== auth.id || canonical?.identity !== auth.identity || canonical?.name !== auth.name) {
            saveHubAuth(code(), canonical);
          }
        }
      }
      window.addEventListener('v82:sync', paintSyncBadge);
    }
  } catch (e) {
    const auth = loadHubAuth(code());
    if (auth) clearHubIdentity(auth);
    syncError = e?.message || '團員入口模組載入失敗';
  }
  syncReady = true;
  paint();
  paintSyncBadge();
}

function code() { return load().unitCode; }

/**
 * Unified Users 用 YMIS 做登入 subject，但 Portal 行政資料用不可變 member id。
 * 安全投影只會帶本人一行名冊，所以每次拉完投影後以 id／YMIS 對回該行，
 * 絕不能假設登入 account.memberId（舊 Users adapter 可能係 YMIS）等於 Portal id。
 */
function projectedMember(auth) {
  if (!auth) return null;
  const id = String(auth.id || '');
  const ymis = String(auth.ymis || '').trim();
  return activeMembers().find(m => (id && String(m.id || '') === id)
    || (ymis && String(m.ymis || '').trim() === ymis)) || null;
}
function canonicalHubAuth(auth) {
  const m = projectedMember(auth);
  if (!m) return auth;
  return { ...auth, id: String(m.id || auth.id || ''), ymis: String(m.ymis || auth.ymis || ''),
    name: String(m.name || auth.name || ''), identity: String(m.identity || auth.identity || 'member') };
}

/* 頂部右邊嘅同步狀態（等團員／領袖一眼睇到「資料係咪最新」） */
function paintSyncBadge() {
  const el = document.getElementById('hubSync');
  if (!el) return;
  import('./lib/remote.js').then(r => {
    if (!r.remoteConfigured()) { el.innerHTML = `<span class="badge b-warn">${icon('alert', 11)} 未連後端</span>`; return; }
    const s = r.syncState();
    const pending = Number(load()?.sync?.pending || 0);
    const map = {
      saving: ['b-warn', 'cloud', '儲存緊…'],
      saved: ['b-ok', 'check', '已同步'],
      pending: ['b-warn', 'clock', pending ? `未儲存（${pending}）` : '未儲存'],
      loading: ['b-info', 'cloud', '讀取緊…'],
      error: ['b-danger', 'alert', '同步失敗'],
      conflict: ['b-warn', 'alert', '撞版'],
      unreachable: ['b-danger', 'alert', '連唔到後端'],
      idle: ['b-ok', 'check', '已同步']
    };
    const [cls, ic, label] = map[s.state] || ['b-grey', 'cloud', ''];
    el.innerHTML = `<span class="badge ${cls}" title="資料同步狀態（後端＝旅團 Google Sheet）">${icon(ic, 11)} ${label}</span>`;
  }).catch(() => { el.innerHTML = ''; });
}

function paint() {
  const p = profile();
  const auth = canonicalHubAuth(loadHubAuth(code()));
  if (!auth) return paintGate();
  saveMe({ id: auth.id, name: auth.name }, code());
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [sec, id] = hash.split('/');
  const ident = auth.identity || 'member';
  const identL = IDENTITIES[ident]?.l || '團員';
  app.innerHTML = `
  <div class="hub-top">
    <div class="hub-wrap">
      <div class="xs" style="opacity:.8">團員入口 · ${esc(identL)} · 掃一次齊晒</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
        <div style="font-size:22px;font-weight:800">${esc(p.name || '深資童軍團')}</div>
        <div id="hubSync" style="margin-left:auto"></div>
      </div>
      <div class="xs" style="opacity:.85;margin-top:6px">你好，<b>${esc(auth.name)}</b>（YMIS ${esc(auth.ymis || '—')}）
        · <button class="btn btn-xs" type="button" id="hubSOS" style="color:#fff;border-color:rgba(255,255,255,.35)">${icon('megaphone', 13)} 求救</button>
        · <button class="btn btn-xs" type="button" id="hubLogout" style="color:#fff;border-color:rgba(255,255,255,.35)">登出</button></div>
    </div>
  </div>
  <div class="hub-wrap">
    ${hubSubmitBanner()}
    ${sec === 'cal' && id ? eventDetail(id, auth)
      : sec === 'quiz' && id ? quizFill(id, auth)
      : sec === 'notice' && id ? noticeDetail(id, auth)
      : sec === 'constitution' ? constitutionPage()
      : sec === 'progress' ? progressPage(auth)
      : sec === 'absence' ? absencePage(auth)
      : home(auth)}
  </div>`;
  bind(auth);
  paintSyncBadge();
  if (sec === 'progress') fillProgressPage(auth);
  if (sec === 'absence') bindAbsenceHub(auth);
}

function paintGate() {
  const p = profile();
  app.innerHTML = `
  <div class="hub-top">
    <div class="hub-wrap">
      <div class="xs" style="opacity:.8">團員入口 · 要 YMIS＋密碼</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
        <div style="font-size:22px;font-weight:800">${esc(p.name || '深資童軍團')}</div>
        <div id="hubSync" style="margin-left:auto"></div>
      </div>
      <div class="xs" style="opacity:.85;margin-top:6px">外人入唔到。首次密碼係 ${TEMP_PASSWORD}，入去要改。
        · <button class="btn btn-xs" type="button" id="hubSOS" style="color:#fff;border-color:rgba(255,255,255,.35)">${icon('megaphone', 13)} 求救</button></div>
    </div>
  </div>
  <div class="hub-wrap">
    <form class="card card-pad" id="hubLogin" autocomplete="off">
      <div class="field"><label class="label">YMIS 會籍編號</label>
        <input class="input" id="hYmis" inputmode="numeric" placeholder="10 位數字" autocomplete="username"></div>
      <div class="field mt-12"><label class="label">密碼</label>
        <input class="input" id="hPass" type="password" placeholder="首次：${TEMP_PASSWORD}" autocomplete="current-password"></div>
      <div id="hErr" class="err mt-8"></div>
      ${syncReady ? '' : `<div class="hint mt-8">${icon('cloud', 13)} 正在由旅團後端載入名冊…</div>`}
      ${syncError ? `<div class="note-box warn mt-8">${icon('alert', 14)}<div>
        <b>載入唔到旅團名冊</b> —— 登入多數會失敗。<div class="xs mt-4">${esc(syncError)}</div>
        <div class="xs faint mt-4">請把呢段訊息截圖傳畀領袖／執委跟進。</div>
      </div></div>` : ''}
      <button class="btn btn-primary btn-block mt-16" type="submit" ${syncReady ? '' : 'disabled'}>${icon('key', 16)} 進入</button>
    </form>
  </div>`;
  paintSyncBadge();
  app.querySelector('#hubSOS')?.addEventListener('click', () => openHubSOS(null));
  app.querySelector('#hubLogin')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = app.querySelector('#hErr');
    if (err) { err.textContent = ''; err.style.display = 'none'; }
    const res = await loginMember(app.querySelector('#hYmis')?.value, app.querySelector('#hPass')?.value);
    if (!res.ok) {
      if (err) { err.textContent = res.msg; err.style.display = 'block'; }
      return;
    }
    const m = res.member;
    /* 密碼核對成功後，再用同一張 opaque session 拉本人安全投影。未拉成功前
       唔會畫舊 localStorage 資料，避免 client 自改 identity 睇到快取內容。 */
    const pulled = await hubRemote?.loadHubView?.({ sessionToken: res.sessionToken });
    if (!pulled?.ok) {
      if (err) { err.textContent = pulled?.error || '登入成功，但暫時讀唔到團員資料'; err.style.display = 'block'; }
      const shared = getSession();
      if (shared?.sessionToken === res.sessionToken) setSession(null);
      return;
    }
    const projected = activeMembers().find(row => String(row.ymis || '').trim() === String(m.ymis || '').trim()) || null;
    const memberAuth = {
      id: projected?.id || m.id, name: projected?.name || m.name, ymis: projected?.ymis || m.ymis,
      identity: projected?.identity || m.identity || 'member', mustChangePw: !!res.mustChangePw,
      sessionToken: res.sessionToken, sessionExpiresAt: res.sessionExpiresAt
    };
    saveHubAuth(code(), memberAuth);
    saveMe({ id: memberAuth.id, name: memberAuth.name }, code());
    syncError = '';
    paint();
    if (res.mustChangePw) forceMemberPw(m.id);
  });
}

/* ============================================================
   已登入團員資源
   ------------------------------------------------------------
   匿名 `db.publicProfile` 已刪除。團員入口只可在後端核實 session 並取得安全
   投影後顯示 `settings.troopLinks` 的固定內部資源；未登入 gate 一律不渲染。
   ============================================================ */

function viewerIdentity(auth) {
  const member = projectedMember(auth);
  return member ? identityOf(member) : '';
}
function canSeeContent(record, kind, role) {
  return visibleTo(contentVis(record, kind), role);
}
function externalHref(value) {
  const raw = String(value || '').trim();
  if (!raw) return '#';
  const direct = safeHref(raw, { allowRelative: false, allowContact: true });
  if (direct !== '#') return direct;
  if (/^[A-Za-z0-9.-]+(?:\/[^\s]*)?$/.test(raw)) return safeHref('https://' + raw, { allowRelative: false, allowContact: false });
  return '#';
}
function card(item) {
  return {
    href: externalHref(item.url), ic: item.ic || item.icon || 'link',
    label: String(item.title || item.label || '').trim(),
    desc: String(item.desc || '').trim(), url: String(item.url || '').trim()
  };
}
function hubResources() {
  const links = troopPublicLinks().filter(link => String(link?.url || '').trim()).map(link => card(link));
  /* 原有固定槽的 id 在 model() 轉成 label 後可能因舊資料語言不同；按原順序分組
     只係介面整理，全部資料仍已經過登入後安全投影。 */
  const social = links.filter(link => /instagram|facebook|whatsapp|ig|fb/i.test(`${link.label} ${link.url}`));
  const albums = links.filter(link => /相簿|album|drive|雲端/i.test(`${link.label} ${link.url}`));
  const used = new Set([...social, ...albums]);
  const other = links.filter(link => !used.has(link));
  return [
    { title: '社交媒體', desc: '本團已登入成員使用的社交平台入口', items: social },
    { title: '相簿與雲端', desc: '本團成員資源', items: albums },
    { title: '網站與連結', desc: '本團成員常用連結', items: other }
  ].filter(group => group.items.length);
}

/** 一張連結卡（團員入口用） */
function linkCard(it) {
  const href = safeHref(it.href, { allowRelative: false, allowContact: true });
  return `<a class="hub-card" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
    <span class="stat-ic">${icon(it.ic, 18)}</span>
    <div class="grow"><div class="semibold">${esc(it.label || it.href)}</div>
      ${it.desc ? `<div class="xs muted mt-4">${esc(it.desc)}</div>` : ''}
      <div class="xs faint mt-4">${esc(it.url)}</div></div>
    <span class="stat-ic">${icon('external', 15)}</span>
  </a>`;
}

/* ============================================================
   主頁
   ============================================================ */
function home(auth) {
  const today = todayISO();
  /* ① 活動：分「即將舉行」同「過往」—— 過往嘅唔會排先做提醒，
     但**內容照留得住**：報咗名嘅團員想睇返詳情、遲咗想參加嘅可以
     搵領袖／執委跟進，都唔會搵唔返。 */
  const role = viewerIdentity(auth);
  /* ★ 行事曆都有「邊個睇到」（喺活動編輯器設）—— 睇唔到嘅唔會出 */
  const evAll = publicEvents().filter(e => canSeeContent(e, 'event', role));
  const isPast = e => {
    const end = String(e.dateEnd || e.date || '').slice(0, 10);
    return !!end && end < today;
  };
  const evs = evAll.filter(e => !isPast(e));
  const pastEvs = evAll.filter(isPast).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  /* ② 試卷：closed 嘅唔顯示（同以前一樣） */
  /* ★ 試卷都有「邊個睇到」（喺試卷編輯器設） */
  const qz = quizzes().filter(q => q.status !== 'closed' && canSeeContent(q, 'quiz', role));
  /* ③ 通告：已發布嘅全部顯示 —— 截止咗報名嘅會擺後＋標「已截止」，
     內容照開得到（成員遲咗想報就問領袖／執委）；草稿先係完全唔出街。 */
  /* 通告可見範圍只接受已登入身份；舊 other 會收窄成團員。 */
  const notices = (load().notices || []).filter(n => n.status === 'published' && canSeeContent(n, 'notice', role))
    .sort((a, b) => Number(closedN(a, today)) - Number(closedN(b, today)));
  const resourceGroups = hubResources();
  const tools = [
    { href: '#/progress', icon: 'target', title: '我的進度', desc: '睇自己獎章進度，仲可以申報完成咗邊項' },
    { href: '#/absence', icon: 'calendar', title: '我的請假', desc: '嚟唔到？寫低邊日同原因，等覆核' },
    { href: '#/constitution', icon: 'book', title: '團章', desc: '登入後閱讀已發布版本' }
  ];
  return `
    <div class="semibold mb-8">我要做</div>
    ${tools.map(t => `<button class="hub-card" type="button" data-open="${esc(t.href)}" style="width:100%;text-align:left">
      <span class="stat-ic">${icon(t.icon, 18)}</span>
      <div class="grow"><div class="semibold">${esc(t.title)}</div><div class="xs muted mt-4">${esc(t.desc)}</div></div>
    </button>`).join('')}

    ${resourceGroups.map(g => `
    <div class="semibold mt-24 mb-8">${esc(g.title)}</div>
    <div class="xs muted mb-8">${esc(g.desc)}</div>
    ${g.items.map(linkCard).join('')}`).join('')}

    <div class="semibold mt-24 mb-8">活動行事曆</div>
    ${evs.length ? evs.map(e => {
      const st = myRsvp(e, auth);
      const overnight = e.dateEnd && e.dateEnd !== e.date;
      return `<button class="hub-card" type="button" data-open="#/cal/${esc(e.id)}" style="width:100%;text-align:left">
        <span class="stat-ic">${icon('calendar', 18)}</span>
        <div class="grow"><div class="semibold">${esc(e.title)}${overnight ? ' <span class="tag">過夜</span>' : ''}</div>
          <div class="xs muted mt-4">${overnight ? `${esc(e.date)} 至 ${esc(e.dateEnd)}` : esc(e.date)} ${esc(e.time || '')} · ${esc(e.venue || '')}</div>
          ${st ? `<div class="xs mt-4"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(RSVP[st]?.label)}</span></div>` : ''}</div>
      </button>`;
    }).join('') : '<div class="card card-pad muted">暫時未有即將舉行嘅活動。</div>'}

    ${pastEvs.length ? `
    <div class="semibold mt-24 mb-8">過往活動</div>
    <div class="xs muted mb-8">完咗嘅活動 —— 想睇返內容就入去睇；遲咗想參加同類型活動可以留意下一個</div>
    ${pastEvs.map(e => {
      const st = myRsvp(e, auth);
      return `<button class="hub-card" type="button" data-open="#/cal/${esc(e.id)}" style="width:100%;text-align:left;opacity:.78">
        <span class="stat-ic">${icon('calendar', 18)}</span>
        <div class="grow"><div class="semibold">${esc(e.title)} <span class="badge b-grey">已完結</span></div>
          <div class="xs muted mt-4">${esc(e.date)}${e.dateEnd && e.dateEnd !== e.date ? ' 至 ' + esc(e.dateEnd) : ''} ${esc(e.venue || '')}</div>
          ${st ? `<div class="xs mt-4"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(RSVP[st]?.label)}</span></div>` : ''}</div>
      </button>`;
    }).join('')}` : ''}

    <div class="semibold mt-24 mb-8">試卷</div>
    ${qz.length ? qz.map(q => `<button class="hub-card" type="button" data-open="#/quiz/${esc(q.id)}" style="width:100%;text-align:left">
      <span class="stat-ic">${icon('note', 18)}</span>
      <div class="grow"><div class="semibold">${esc(q.title)}</div>
        <div class="xs muted mt-4">${(q.questions || []).length} 題</div></div>
    </button>`).join('') : '<div class="card card-pad muted">暫時未有開放試卷。</div>'}

    <div class="semibold mt-24 mb-8">通告</div>
    ${notices.length ? notices.map(n => {
      const closed = closedN(n, today);
      return `<button class="hub-card" type="button" data-open="#/notice/${esc(n.id)}" style="width:100%;text-align:left${closed ? ';opacity:.78' : ''}">
        <span class="stat-ic">${icon('megaphone', 18)}</span>
        <div class="grow"><div class="semibold">${esc(n.title?.zh || n.id)}${closed ? ' <span class="badge b-grey">已截止</span>' : ''}</div>
          <div class="xs muted mt-4">${esc(n.eventDate || '')} ${n.needSignup
            ? (closed ? '· 報名已截止（想報就搵領袖／執委）' : (n.deadline ? `· 截止 ${esc(n.deadline)}` : '· 可回覆出席'))
            : ''}</div></div>
      </button>`;
    }).join('') : '<div class="card card-pad muted">暫時未有已發布通告。</div>'}
  `;
}

/* ============================================================
   回覆出席／交卷 —— 直接用登入身份（登入咗就知你係邊個）
   ============================================================ */
function whoAmI(auth) {
  const m = projectedMember(auth);
  if (m?.id) return { id: m.id, name: m.name || auth?.name || '', email: m.email || '' };
  return auth?.id ? { id: auth.id, name: auth.name || '', email: '' } : null;
}

function myRsvp(e, auth) {
  const ident = whoAmI(auth);
  if (!ident?.id) return '';
  const v = (e.rsvp || {})[ident.id];
  return v?.status || v || '';
}

/** 已回覆嗰行嘅摘要（遲到／早退帶時間，不出席帶原因） */
function myRsvpLine(e, auth) {
  const ident = whoAmI(auth);
  if (!ident?.id) return '';
  const v = (e.rsvp || {})[ident.id] || {};
  const st = v.status || '';
  const lab = RSVP[st]?.label || st;
  if (st === 'late' || st === 'early') return `${lab}${v.time ? `（${v.time}）` : ''}`;
  if (st === 'absent') return `${lab}${v.reason ? `：${v.reason}` : ''}`;
  return lab;
}

function noticeFieldValue(field, signup) {
  const value = signup?.answers?.[field.key];
  return value === undefined || value === null ? '' : value;
}

function noticeFieldHtml(field, signup, auth) {
  const key = String(field?.key || '');
  const label = String(field?.label || key);
  const type = String(field?.type || 'text');
  const automatic = key === 'name' ? (auth?.name || '') : key === 'ymis' ? (auth?.ymis || '') : '';
  const value = automatic || noticeFieldValue(field, signup);
  const required = field?.required ? ' <span class="req">*</span>' : '';
  const attrs = `data-notice-field="${esc(key)}" ${field?.required ? 'required' : ''}`;
  if (type === 'textarea') {
    return `<div class="field mt-12"><label class="label">${esc(label)}${required}</label><textarea class="textarea" rows="3" ${attrs}>${esc(value)}</textarea></div>`;
  }
  if (type === 'select') {
    return `<div class="field mt-12"><label class="label">${esc(label)}${required}</label><select class="select" ${attrs}>
      <option value="">請選擇</option>${(field.options || []).map(option => `<option value="${esc(option)}" ${String(value) === String(option) ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></div>`;
  }
  if (type === 'radio') {
    return `<fieldset class="field mt-12"><legend class="label">${esc(label)}${required}</legend>${(field.options || []).map(option =>
      `<label class="check"><input type="radio" name="notice-${esc(key)}" value="${esc(option)}" ${attrs} ${String(value) === String(option) ? 'checked' : ''}> ${esc(option)}</label>`).join('')}</fieldset>`;
  }
  if (type === 'check') {
    const values = Array.isArray(value) ? value.map(String) : [];
    return `<fieldset class="field mt-12"><legend class="label">${esc(label)}${required}</legend>${(field.options || []).map(option =>
      `<label class="check"><input type="checkbox" value="${esc(option)}" ${attrs} ${values.includes(String(option)) ? 'checked' : ''}> ${esc(option)}</label>`).join('')}</fieldset>`;
  }
  const htmlType = ['number', 'tel', 'email', 'date'].includes(type) ? type : 'text';
  return `<div class="field mt-12"><label class="label">${esc(label)}${required}</label><input class="input" type="${htmlType}" value="${esc(value)}" ${attrs} ${automatic ? 'readonly' : ''}></div>`;
}

function noticeDetail(id, auth) {
  const notice = (load().notices || []).find(row => String(row.id || '') === String(id || ''));
  if (!notice) return `<button class="btn btn-sm" data-open="#/home">← 返回</button><div class="card card-pad mt-12">你無權閱讀或者搵唔到呢張通告。</div>`;
  const info = [
    ['日期', notice.eventDate], ['地點', notice.venue], ['集合', [notice.assemblyTime, notice.assemblyPlace].filter(Boolean).join(' · ')],
    ['解散', [notice.dismissTime, notice.dismissPlace].filter(Boolean).join(' · ')], ['費用', notice.fee],
    ['服飾', notice.uniform], ['攜帶', notice.bring], ['聯絡', notice.contact]
  ].filter(([, value]) => String(value || '').trim());
  const closed = closedN(notice, todayISO());
  return `<button class="btn btn-sm" data-open="#/home">← 返回</button>
    <article class="card card-pad mt-12">
      <div class="xs faint">已登入通告 · ${esc(notice.publishAt || '')}</div>
      <h2 class="mt-8">${esc(notice.title?.zh || notice.id)}</h2>
      ${notice.title?.en ? `<div class="muted">${esc(notice.title.en)}</div>` : ''}
      ${info.length ? `<div class="mt-16">${info.map(([label, value]) => `<div class="row-between sm" style="padding:6px 0;border-bottom:1px solid var(--line-2)"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')}</div>` : ''}
      ${notice.body?.zh ? `<div class="mt-16" style="white-space:pre-wrap">${esc(notice.body.zh)}</div>` : ''}
      ${notice.body?.en ? `<div class="mt-12 muted" style="white-space:pre-wrap">${esc(notice.body.en)}</div>` : ''}
    </article>
    ${notice.needSignup ? `<form class="card card-pad mt-12" id="hubNoticeSignup">
      <div class="semibold">${notice.mySignup ? '更新我的回覆' : '回覆通告'}</div>
      <div class="xs muted mt-4">回覆會直接綁定目前登入的 ${esc(auth?.name || '')}；唔接受冒認其他成員。</div>
      ${closed ? `<div class="note-box warn mt-12"><div>報名已截止${notice.deadline ? `（${esc(notice.deadline)}）` : ''}。</div></div>`
        : (notice.fields || []).map(field => noticeFieldHtml(field, notice.mySignup, auth)).join('')
          + `<div id="hubNoticeErr" class="err mt-8"></div><button class="btn btn-primary btn-block mt-16" type="submit">${notice.mySignup ? '更新回覆' : '送出回覆'}</button>`}
    </form>` : ''}`;
}

function constitutionPage() {
  const constitution = load().constitution;
  if (!constitution || constitution.status !== 'published') {
    return `<button class="btn btn-sm" data-open="#/home">← 返回</button><div class="card card-pad mt-12">暫時未有已發布團章。</div>`;
  }
  const chapters = (constitution.chapters || []).map(chapter => `<section class="mt-24">
    <h3 style="color:var(--brand-700);border-bottom:1px solid var(--line);padding-bottom:7px">${esc(chapter.heading?.zh || '')}${chapter.heading?.en ? ` <span class="sm muted">／ ${esc(chapter.heading.en)}</span>` : ''}</h3>
    ${(chapter.articles || []).map(article => `<div class="mt-12"><div>${esc(article.zh || '')}</div>${article.en ? `<div class="sm muted">${esc(article.en)}</div>` : ''}
      ${(article.items || []).map(item => `<div class="sm mt-6" style="margin-left:${item.level === 2 ? '32px' : '18px'}">${esc(item.zh || '')}${item.en ? `<div class="muted">${esc(item.en)}</div>` : ''}</div>`).join('')}</div>`).join('')}
  </section>`).join('');
  return `<button class="btn btn-sm" data-open="#/home">← 返回</button><article class="card card-pad mt-12">
    <div class="center"><div class="xs faint">只限已登入成員</div><h2 class="mt-8">${esc(constitution.title?.zh || '團章')}</h2>
      ${constitution.title?.en ? `<div class="muted">${esc(constitution.title.en)}</div>` : ''}</div>
    ${constitution.preamble?.zh || constitution.preamble?.en ? `<div class="note-box brand mt-16"><div>${esc(constitution.preamble?.zh || '')}${constitution.preamble?.en ? `<div class="sm muted mt-4">${esc(constitution.preamble.en)}</div>` : ''}</div></div>` : ''}
    ${chapters}
    <div class="xs faint mt-24">版本 ${esc(constitution.version || '')} · 更新 ${esc(constitution.updated || '')}</div>
  </article>`;
}

async function submitNoticeSignup(auth) {
  const noticeId = location.hash.split('/')[2] || '';
  const notice = (load().notices || []).find(row => String(row.id || '') === String(noticeId));
  if (!notice) return;
  const answers = {};
  for (const field of (notice.fields || [])) {
    const controls = [...app.querySelectorAll('[data-notice-field]')].filter(control => control.dataset.noticeField === String(field.key || ''));
    let value = '';
    if (field.type === 'check') value = controls.filter(control => control.checked).map(control => control.value);
    else if (field.type === 'radio') value = controls.find(control => control.checked)?.value || '';
    else value = controls[0]?.value?.trim?.() ?? controls[0]?.value ?? '';
    if (field.required && (Array.isArray(value) ? !value.length : !String(value).trim())) {
      const error = app.querySelector('#hubNoticeErr');
      if (error) { error.textContent = `請填：${field.label || field.key}`; error.style.display = 'block'; }
      return;
    }
    answers[field.key] = value;
  }
  await pushSubmit('通告回覆', 'notice', { noticeId, answers });
}

function eventDetail(id, auth) {
  const e = (load().events || []).find(x => x.id === id);
  if (!e || e.visibility === 'exco') return '<div class="card card-pad">搵唔到呢個活動。</div>';
  const st = myRsvp(e, auth);
  const overnight = e.dateEnd && e.dateEnd !== e.date;
  const ended = String(e.dateEnd || e.date || '').slice(0, 10) && String(e.dateEnd || e.date).slice(0, 10) < todayISO();
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/home">${icon('chevronL', 14)} 返回</button>
    <div class="card card-pad">
      <div class="page-title" style="font-size:20px">${esc(e.title)}</div>
      <div class="sm muted mt-4">${overnight ? `${esc(e.date)} 至 ${esc(e.dateEnd)}（${esc(e.time || '')} 起步）` : `${esc(e.date)} ${esc(e.time || '')}`} · ${esc(e.venue || '')}</div>
      <div class="sm mt-12" style="white-space:pre-wrap">${esc(e.detail || '未有詳細內容')}</div>
      ${ended
        ? `<div class="badge b-grey mt-16">活動已結束</div>`
        : `<div class="semibold sm mt-16">我會…</div>
      <div class="row wrap gap-8 mt-8">
        <button class="btn btn-sm ${st === 'present' ? 'btn-primary' : ''}" type="button" data-eid="${esc(e.id)}" data-rsvp="present">${RSVP.present.label}</button>
        <button class="btn btn-sm ${st === 'absent' ? 'btn-primary' : ''}" type="button" data-eid="${esc(e.id)}" data-rsvp="absent">${RSVP.absent.label}</button>
      </div>
      ${st ? `<div class="xs mt-10"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(myRsvpLine(e, auth))}</span>
        <button class="btn btn-xs btn-ghost" type="button" data-eid="${esc(e.id)}" data-rsvp="edit">改一改</button></div>` : ''}`}
    </div>`;
}

/* ============================================================
   我的進度（團員自助，2026-09-18 第 5 項要求）
   團員見到自己每個獎章嘅項目：完成咗嘅有日期；未完成嘅可以
   「申報完成」→ 寫入後端「待批完成」→ 執委喺審批中心批准先入數。
   ============================================================ */
function progressPage(auth) {
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/home">${icon('chevronL', 14)} 返回</button>
  <div id="progressBody"><div class="card card-pad muted">載入緊進度…</div></div>`;
}

/* ============================================================
   我的請假（團員自己申報 → 領袖／執委覆核）
   ------------------------------------------------------------
   團員喺呢度填「邊日、咩時段、點解要請假」；寫入本機，跟「儲存到後端」
   一齊上後端，領袖／執委喺管理系統行事曆「請假」tab 覆核。
   ============================================================ */
function absencePage(auth) {
  const member = projectedMember(auth);
  const memberId = String(member?.id || auth?.id || '');
  const ymis = String(member?.ymis || auth?.ymis || '');
  const cn = absenceCounts();
  const mine = absencesOf(memberId, ymis).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/home">${icon('chevronL', 14)} 返回</button>
  <div class="card card-pad">
    <div class="row-between mb-12">
      <div>
        <div class="semibold">我的請假</div>
        <div class="xs muted mt-4">寫低邊日嚟唔到同原因，等領袖／執委覆核；覆核通過先計數。</div>
      </div>
      <button class="btn btn-sm btn-primary" type="button" id="abNew">${icon('calendar', 14)} 請假</button>
    </div>
    ${mine.length
      ? mine.map(a => {
          const st = ABSENCE_STATUS[a.status] || ABSENCE_STATUS.pending;
          return `<div class="list-item">
            <span class="stat-ic">${icon('calendar', 15)}</span>
            <div class="li-main">
              <div class="li-t">${esc(a.date)} · ${esc((ABSENCE_SLOTS.find(x => x.id === a.slot) || {}).label || a.slot || '全日')} <span class="badge ${st.cls}">${esc(st.label)}</span></div>
              <div class="li-s xs muted" style="white-space:pre-wrap">${esc(a.reason || '')}</div>
              ${a.plan ? `<div class="li-s xs">補救／出席：${esc(a.plan)}</div>` : ''}
              ${a.status === 'rejected' && a.reviewNote ? `<div class="li-s xs" style="color:var(--danger)">覆核：${esc(a.reviewNote)}</div>` : ''}
              ${(a.status === 'approved' && a.reviewNote) ? `<div class="li-s xs" style="color:var(--ok)">覆核：${esc(a.reviewNote)}</div>` : ''}
            </div>
            ${a.status === 'pending' ? `<button class="btn btn-xs btn-danger" type="button" data-abwithdraw="${esc(a.id)}">撤回</button>` : ''}
          </div>`;
        }).join('')
      : `<div class="xs muted">仲未交過請假。撳右上「請假」寫第一張。</div>`}
    <div class="xs faint mt-12">已交 ${mine.length} 張 · 待覆核 ${mine.filter(a => a.status === 'pending').length} 張 · 全旅團共 ${cn.total} 張</div>
  </div>`;
}

async function bindAbsenceHub(auth) {
  app.querySelector('#abNew')?.addEventListener('click', async () => {
    const r = await modal({
      title: '請假',
      sub: '寫低邊日嚟唔到同原因；覆核通過先計數',
      trustedBodyHtml: `<div class="grid g-2" style="gap:12px">
          <div class="field"><label class="label">日子 <span class="req">*</span></label>
            <input class="input" type="date" id="ab-date" value="${esc(todayISO())}"></div>
          <div class="field"><label class="label">時段</label>
            <select class="select" id="ab-slot">${ABSENCE_SLOTS.map(s => `<option value="${esc(s.id)}" ${s.id === 'full' ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
        </div>
        <div class="field mt-12"><label class="label">原因 <span class="req">*</span></label>
          <textarea class="textarea" id="ab-reason" rows="3" maxlength="2000" placeholder="例：屋企有事／學校補課／唔舒服"></textarea></div>
        <div class="field mt-12"><label class="label">補救／出席（可選）</label>
          <input class="input" id="ab-plan" maxlength="500" placeholder="例：下個禮拜點名補返"></div>`,
      actions: [
        { label: '取消', class: 'btn', value: false },
        {
          label: '提交', class: 'btn-primary',
          onClick: el => {
            const date = el.querySelector('#ab-date')?.value || '';
            const slot = el.querySelector('#ab-slot')?.value || 'full';
            const reason = (el.querySelector('#ab-reason')?.value || '').trim();
            const plan = (el.querySelector('#ab-plan')?.value || '').trim();
            if (!reason) {
              el.querySelector('.modal-body')?.insertAdjacentHTML('afterbegin', '<div class="note-box danger mb-8"><div class="sm">請寫低原因</div></div>');
              return false;
            }
            return { date, slot, reason, plan };
          }
        }
      ]
    });
    if (!r) return;
    /* 唔先 add 本機：server 成功並回傳新投影後先顯示。固定 id 令網絡斷線後
       重試同一請求仍然冪等，唔會重複開兩張請假。 */
    await pushSubmit('請假單', 'absence', {
      op: 'create', id: 'ab_' + uid(),
      date: r.date, slot: r.slot, reason: r.reason, plan: r.plan
    });
  });
  app.querySelectorAll('[data-abwithdraw]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmDlg({ title: '撤回請假', danger: true, okText: '撤回', message: '確定撤回呢張請假單？' }))) return;
    /* 唔先 remove 本機；失敗時原紀錄原封不動，banner 提供明確重試。 */
    await pushSubmit('撤回請假', 'absence', { op: 'withdraw', id: b.dataset.abwithdraw });
  }));
}



async function fillProgressPage(auth) {
  const box = app.querySelector('#progressBody');
  if (!box) return;
  const ymis = String(auth?.ymis || '').trim();
  if (!progressConfigured()) {
    box.innerHTML = `<div class="card card-pad"><div class="semibold mb-4">我的進度</div>
      <div class="xs muted">旅團未接進度後端。接好之後你會喺呢度見到自己嘅獎章進度。</div></div>`;
    return;
  }
  if (!ymis) {
    box.innerHTML = `<div class="card card-pad"><div class="semibold mb-4">我的進度</div>
      <div class="xs muted">名冊未有你嘅 YMIS 會籍編號，無法對應進度 —— 請搵執委幫你喺「用戶」填返。</div></div>`;
    return;
  }
  try {
    /* 個人 bridge：server 由 session 對出 YMIS，後端只回本人；唔會下載全團 progress 再喺瀏覽器篩。 */
    const [r, it] = await Promise.all([loadMyProgress(auth), loadItems()]);
    if (!r.ok) {
      box.innerHTML = `<div class="card card-pad"><div class="semibold mb-4">我的進度</div>
        <div class="xs muted">${esc(r.error || '讀唔到進度')}</div></div>`;
      return;
    }
    const catalog = it.ok ? flattenItems(it.data) : {};
    const d = memberDetail(r.data, catalog, ymis);
    const myName = (r.data?.members || []).find(m => String(m.ymis) === ymis)?.name || auth?.name || '';
    const reqs = r.data?.requests || [];
    const REQ_LABEL = { pending: ['b-warn', '等批核'], approved: ['b-ok', '已批准'], rejected: ['b-danger', '已拒絕'] };
    box.innerHTML = `
      <div class="card card-pad">
        <div class="semibold">我的進度</div>
        <div class="xs muted mt-4">已完成 <b>${d.done}</b> 項 · YMIS ${esc(ymis)}${myName ? ' · ' + esc(myName) : ''}</div>
        ${(d.badges || []).filter(b => b.total).map(b => {
          const rate = boundedPercent(b.rate);
          return `
          <div class="mt-16">
            <div class="row-between sm"><span>${esc(b.icon || '')} ${esc(b.name)}</span><span class="mono xs">${b.done}/${b.total}（${rate}%）</span></div>
            <div class="progress mt-4"><i style="width:${rate}%"></i></div>
            <div class="mt-8">
              ${b.items.map(x => x.done ? `
                <div class="row-between sm" style="padding:5px 0;border-bottom:1px solid var(--line-2)">
                  <span>${esc(x.name)}</span>
                  <span class="xs" style="color:var(--ok)">${icon('check', 13)} ${esc(x.date || '已完成')}${x.confirmer ? ` · ${esc(x.confirmer)}` : ''}</span>
                </div>` : `
                <div class="row-between sm" style="padding:5px 0;border-bottom:1px solid var(--line-2)">
                  <span class="muted">${esc(x.name)}</span>
                  <button class="btn btn-xs btn-primary" type="button" data-claim="${esc(x.id)}" data-name="${esc(x.name)}">${icon('plus', 12)} 申報完成</button>
                </div>`).join('')}
            </div>
          </div>`;
        }).join('') || '<div class="xs muted mt-8">未有考核項目定義。</div>'}
      </div>
      <div class="card mt-16">
        <div class="card-head"><div><div class="card-title">我嘅申報紀錄</div>
          <div class="card-sub">申報之後等執委批核，批准先算數</div></div></div>
        <div>
          ${reqs.length ? reqs.map(q => {
            const [cls, label] = REQ_LABEL[q.status] || ['b-warn', q.status];
            return `<div class="list-item">
              <span class="stat-ic">${icon('target', 15)}</span>
              <div class="li-main">
                <div class="li-t">${esc(q.item_name || q.item_id)} <span class="badge ${cls}">${esc(label)}</span></div>
                <div class="li-s xs faint">${esc(q.requested_date || '')}${q.review_note ? ' · 備註：' + esc(q.review_note) : ''}${q.confirmed_date && q.status === 'approved' ? ' · 確認日：' + esc(q.confirmed_date) : ''}</div>
              </div>
            </div>`;
          }).join('') : '<div style="padding:12px 16px" class="xs muted">仲未有申報。上面揀一項撳「申報完成」就得。</div>'}
        </div>
      </div>`;
    box.querySelectorAll('[data-claim]').forEach(b => b.addEventListener('click', () => claimProgressDialog(auth, b.dataset.claim, b.dataset.name)));
  } catch (e) {
    box.innerHTML = `<div class="card card-pad muted">${esc(e.message || '載入失敗')}</div>`;
  }
}

async function claimProgressDialog(auth, itemId, itemName) {
  const ymis = String(auth?.ymis || '').trim();
  if (!ymis) { toast('名冊未有你嘅 YMIS，申報唔到', 'err'); return; }
  const r = await modal({
    title: '申報完成',
    sub: itemName,
    trustedBodyHtml: `<div class="field"><label class="label">完成日期</label>
        <input class="input" type="date" id="rqDate" value="${esc(todayISO())}"></div>
      <div class="field mt-12"><label class="label">證據／簡介（可空）</label>
        <textarea class="textarea" id="rqEv" rows="3" placeholder="例：2026 夏季營完成咗全程、導師簽名紀錄…"></textarea></div>
      <div class="hint mt-8">送出之後會變成「待批核」，執委喺審批中心批准先算數。</div>`,
    actions: [
      { label: '取消', class: 'btn', value: null },
      { label: '送出申報', class: 'btn-primary', onClick: el => {
        const date = el.querySelector('#rqDate')?.value || todayISO();
        const ev = el.querySelector('#rqEv')?.value.trim() || '';
        return { date, ev };
      } }
    ]
  });
  if (!r) return;
  const res = await submitProgressRequest({ item_id: itemId, item_name: itemName, requested_date: r.date, evidence: r.ev }, auth);
  if (res.ok) { toast('已送出申報，等執委批核 ✓', 'ok'); paint(); }
  else toast(res.error || '申報失敗，一陣再試', 'err');
}

function quizFill(id, auth) {
  const q = quizzes().find(x => x.id === id);
  if (!q) return '<div class="card card-pad">搵唔到試卷</div>';
  const ident = whoAmI(auth);
  const prev = ident?.id ? (q.responses || {})[ident.id] : null;
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/home">${icon('chevronL', 14)} 返回</button>
    <div class="card card-pad">
      <div class="page-title" style="font-size:20px">${esc(q.title)}</div>
      <div class="sm muted mt-4">${esc(q.note || '')}</div>
      ${(q.questions || []).map((item, i) => `<div class="field mt-16">
        <label class="label">${i + 1}. ${esc(item.prompt)} ${item.required ? '<span class="req">*</span>' : ''}</label>
        ${item.type === 'para' ? `<textarea class="textarea" data-ans="${esc(item.id)}" rows="4">${esc(prev?.answers?.[item.id] || '')}</textarea>`
        : item.type === 'single' ? (item.options || []).map(o =>
          `<label class="check"><input type="radio" name="q_${esc(item.id)}" data-ans="${esc(item.id)}" value="${esc(o)}" ${(prev?.answers?.[item.id] === o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')
        : item.type === 'multi' ? (item.options || []).map(o => {
          const arr = prev?.answers?.[item.id] || [];
          return `<label class="check"><input type="checkbox" data-ans="${esc(item.id)}" value="${esc(o)}" ${arr.includes?.(o) ? 'checked' : ''}> ${esc(o)}</label>`;
        }).join('')
        : `<input class="input" data-ans="${esc(item.id)}" value="${esc(prev?.answers?.[item.id] || '')}">`}
      </div>`).join('')}
      <button class="btn btn-primary btn-block mt-16" type="button" data-quiz-submit>交卷</button>
    </div>`;
}

function bind(auth) {
  app.querySelector('#hubCheckSubmit')?.addEventListener('click', async () => {
    const unknown = hubSubmitState.unknown;
    if (!unknown || !auth?.sessionToken) return;
    let journalOutcome = 'unknown';
    if (unknown.operationId) {
      const status = await hubRemote?.checkOperationStatus?.(unknown.operationId);
      journalOutcome = String(status?.operation?.outcome || status?.outcome || 'unknown').toLowerCase();
    }
    if (journalOutcome === 'not_applied') {
      finishOperation(unknown.operationId, { state: 'not_applied', outcome: 'not_applied', mayHaveApplied: false });
      clearRememberedHubUnknown(auth);
      hubSubmitState = { pending: false, unknown: null,
        retry: { what: unknown.what, kind: unknown.kind, payload: unknown.payload, error: '操作日誌確認未套用' } };
      paint();
      toast('操作日誌確認未套用；而家先可以安全重新送出', 'warn');
      return;
    }
    const r = await hubRemote?.loadHubView?.({ sessionToken: auth.sessionToken });
    if (!r?.ok) { toast(r?.error || '重新載入失敗；結果仍然未知', 'warn'); return; }
    if (journalOutcome === 'applied' || hubMutationVisible(unknown.kind, unknown.payload)) {
      if (unknown.operationId) finishOperation(unknown.operationId, { state: 'applied', outcome: 'applied', mayHaveApplied: true });
      hubSubmitState = { pending: false, retry: null, unknown: null };
      clearRememberedHubUnknown(auth);
      paint();
      toast(journalOutcome === 'applied'
        ? '操作日誌確認已套用；已重新讀取，冇重送'
        : '重新讀取已見到呢項操作，確認已套用；冇重送', 'ok');
    } else {
      toast('操作日誌同重新讀取仍未能確認；結果繼續鎖住，冇重送。', 'warn');
      paint();
    }
  });
  app.querySelector('#hubRetrySubmit')?.addEventListener('click', async () => {
    const retry = hubSubmitState.retry;
    if (retry) await pushSubmit(retry.what, retry.kind, retry.payload);
  });
  app.querySelector('#hubLogout')?.addEventListener('click', () => {
    clearHubIdentity(auth);
    paint();
  });
  app.querySelector('#hubSOS')?.addEventListener('click', () => openHubSOS(auth));
  app.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.open; paint(); }));
  app.querySelectorAll('[data-rsvp]').forEach(b => b.addEventListener('click', () => rsvp(b.dataset.eid, b.dataset.rsvp, auth)));
  app.querySelector('[data-quiz-submit]')?.addEventListener('click', () => submitQuiz(location.hash.split('/')[2] || location.hash.split('/')[1], auth));
  app.querySelector('#hubNoticeSignup')?.addEventListener('submit', event => { event.preventDefault(); submitNoticeSignup(auth); });
}

/** 團員入口求救 —— 同管理系統走同一條 ADMIN「問題回報」（圖書館嗰張表）。 */
async function openHubSOS(auth) {
  const { openMemberSOS } = await import('./lib/onboard.js');
  const m = projectedMember(auth);
  openMemberSOS({ troopId: code(), name: m?.name || auth?.name || '', contact: m?.email || '' });
}

function rsvp(eid, status, auth) {
  const ident = whoAmI(auth);
  if (!ident) { toast('請先登入再回覆', 'warn'); return; }
  const e = (load().events || []).find(x => x.id === eid);
  if (!e) return;
  const cur = (e.rsvp || {})[ident.id] || {};

  /* 撳「出席」／「改一改」＝開小表單，可以揀 出席／遲到／早退（揀時間）／不出席（填原因） */
  if (status !== 'absent') {
    openRsvpForm(e, ident, cur, `
      <div class="field">
        <label class="label">揀一個</label>
        <select class="select" id="rv-kind">
          <option value="present" ${cur.status === 'present' ? 'selected' : ''}>出席</option>
          <option value="late" ${cur.status === 'late' ? 'selected' : ''}>遲到</option>
          <option value="early" ${cur.status === 'early' ? 'selected' : ''}>早走</option>
          <option value="absent" ${cur.status === 'absent' ? 'selected' : ''}>不出席</option>
        </select>
      </div>
      <div class="field mt-12" id="rv-late-wrap"><label class="label">遲到幾點到？（揀時間）</label>
        <input class="input" type="time" id="rv-late-time" value="${esc(cur.status === 'late' ? cur.time : '19:30')}"></div>
      <div class="field mt-12" id="rv-early-wrap"><label class="label">早走幾點走？（揀時間）</label>
        <input class="input" type="time" id="rv-early-time" value="${esc(cur.status === 'early' ? cur.time : '21:00')}"></div>
      <div class="field mt-12" id="rv-reason-wrap"><label class="label">原因 <span class="req">*</span>（不出席要寫，等領袖／執委知）</label>
        <textarea class="textarea" id="rv-reason" rows="3" placeholder="例：屋企有事／唔舒服／學校補課">${esc(cur.reason || '')}</textarea></div>`,
    (el) => {
      const syncWrap = () => {
        const k = el.querySelector('#rv-kind')?.value;
        const lw = el.querySelector('#rv-late-wrap'), ew = el.querySelector('#rv-early-wrap'), rw = el.querySelector('#rv-reason-wrap');
        if (lw) lw.style.display = k === 'late' ? '' : 'none';
        if (ew) ew.style.display = k === 'early' ? '' : 'none';
        if (rw) rw.style.display = k === 'absent' ? '' : 'none';
      };
      el.querySelector('#rv-kind')?.addEventListener('change', syncWrap);
      syncWrap();
    });
  } else {
    /* 不出席 → 直接問原因（等 EC 知） */
    openRsvpForm(e, ident, cur, `
      <div class="field">
        <label class="label">原因 <span class="req">*</span>（等領袖／執委知）</label>
        <textarea class="textarea" id="rv-reason" rows="3" placeholder="例：屋企有事／唔舒服／學校補課">${esc(cur.reason || '')}</textarea>
      </div>`);
  }
}

async function openRsvpForm(e, ident, cur, fieldsHtml, onMount) {
  const r = await modal({
    title: '回覆出席',
    sub: `${e.title}（${e.date}${e.time ? ' ' + e.time : ''}）`,
    trustedBodyHtml: fieldsHtml,
    onMount,
    actions: [
      { label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => {
        const kind = el.querySelector('#rv-kind')?.value || '';
        const lateTime = el.querySelector('#rv-late-time')?.value || '';
        const earlyTime = el.querySelector('#rv-early-time')?.value || '';
        const reason = (el.querySelector('#rv-reason')?.value || '').trim();
        if ((kind || cur.status) === 'absent' && !reason) {
          el.querySelector('.modal-body')?.insertAdjacentHTML('afterbegin',
            '<div class="note-box danger mb-8"><div class="sm">不出席要填原因，等領袖／執委知。</div></div>');
          return false;
        }
        return { kind, lateTime, earlyTime, reason };
      } }
    ]
  });
  if (!r || r === null) return;
  const name = ident.name;
  const rec = { at: todayISO(), name };
  const kind = (r && r.kind) || '';
  if (kind) rec.status = kind;
  if (kind === 'late') rec.time = r.lateTime;
  if (kind === 'early') rec.time = r.earlyTime;
  if ((r || {}).reason) rec.reason = r.reason.slice(0, 500);
  if (!rec.status) rec.status = 'present';
  /* 唔先 update 本機；server 成功回投影先顯示新回覆。失敗保留舊值兼可重試。 */
  await pushSubmit('出席回覆', 'rsvp', {
    eventId: e.id, status: rec.status, time: rec.time || '', reason: rec.reason || ''
  });
}

async function submitQuiz(id, auth) {
  const ident = whoAmI(auth);
  if (!ident) { toast('請先登入再交卷', 'warn'); return; }
  const q = quizzes().find(x => x.id === id);
  if (!q) return;
  const answers = {};
  (q.questions || []).forEach(item => {
    /* Filter by dataset instead of interpolating an imported question ID into a
       CSS selector (quotes/brackets in legacy data must not alter the query). */
    const fields = [...app.querySelectorAll('[data-ans]')]
      .filter(el => el.dataset.ans === String(item.id || ''));
    if (item.type === 'multi') answers[item.id] = fields.filter(el => el.checked).map(el => el.value);
    else if (item.type === 'single') answers[item.id] = fields.find(el => el.checked)?.value || '';
    else answers[item.id] = fields[0]?.value.trim() || '';
    if (item.required && (!answers[item.id] || (Array.isArray(answers[item.id]) && !answers[item.id].length))) {
      toast('請填：' + item.prompt, 'err'); answers._bad = true;
    }
  });
  if (answers._bad) return;
  delete answers._bad;
  /* 入站資料即刻寫後端；唔先改本機，避免失敗後畫面假裝已交。 */
  const sent = await pushSubmit('答卷', 'quiz', { quizId: id, answers });
  if (sent?.ok) {
    location.hash = '#/home';
    paint();
  }
}

async function forceMemberPw(memberId) {
  const r = await modal({
    title: '首次登入：請改密碼',
    sub: `唔可以繼續用預設 ${TEMP_PASSWORD}`,
    trustedBodyHtml: `<div class="field"><label class="label">新密碼</label>
        <input class="input" id="mp1" type="password" autocomplete="new-password"></div>
      <div class="field mt-12"><label class="label">再輸入一次</label>
        <input class="input" id="mp2" type="password" autocomplete="new-password"></div>
      <div id="mpErr" class="err mt-8"></div>`,
    actions: [
      { label: '稍後', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => {
        const p1 = el.querySelector('#mp1').value, p2 = el.querySelector('#mp2').value;
        const err = el.querySelector('#mpErr');
        if (p1.length < 4) { err.textContent = '至少 4 個字'; err.style.display = 'block'; return false; }
        if (p1 === TEMP_PASSWORD) { err.textContent = '唔可以繼續用預設密碼'; err.style.display = 'block'; return false; }
        if (p1 !== p2) { err.textContent = '兩次輸入唔一樣'; err.style.display = 'block'; return false; }
        return p1;
      } }
    ]
  });
  if (!r) return;
  const a = loadHubAuth(code());
  const res = await changeMemberOwnPassword(memberId, '', r, a);
  toast(res.ok ? (res.relogin ? '密碼已更改，請重新登入' : '密碼已更改') : (res.msg || '改唔到'), res.ok ? 'ok' : 'err');
  if (res.ok) {
    if (res.relogin || !res.sessionToken) {
      clearHubIdentity(a);
      paint();
      return;
    }
    if (a) saveHubAuth(code(), { ...a, mustChangePw: false,
      sessionToken: res.sessionToken, sessionExpiresAt: res.sessionExpiresAt });
    if (location.hash === '#forcepw') location.hash = '#/home';
  }
}

window.addEventListener('hashchange', () => { try { closeAllModals(null); paint(); } catch { /* */ } });
boot().catch(e => {
  app.innerHTML = `<div style="padding:40px" class="muted">載入失敗：${esc(e.message || e)}</div>`;
});
