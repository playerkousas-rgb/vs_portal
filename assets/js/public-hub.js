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
import { profile, publicEvents, RSVP, quizzes, activeMembers, publicPageUrl, troopPublicLinks, identityOf, IDENTITIES } from './lib/model.js';
import { publicProfile, visibleTo, socialName, socialIcon, contentVis } from './lib/public-profile.js';
import { loadMe, saveMe } from './lib/member-me.js';
import { loadHubAuth, saveHubAuth, clearHubAuth } from './lib/hub-session.js';
import { beFromQuery } from './lib/gateway.js';
import { loginMember, changeMemberOwnPassword, TEMP_PASSWORD } from './lib/auth.js';
import { progressConfigured, loadMyProgress, loadItems, flattenItems, memberDetail, submitProgressRequest } from './lib/progress.js';
import { absencesOf, allAbsences, ABSENCE_STATUS, ABSENCE_SLOTS, absenceCounts } from './lib/absence.js';
import { esc, icon, toast, todayISO, modal, confirmDlg, closeAllModals, uid } from './lib/util.js';

const app = document.getElementById('app');
let syncReady = false;      /* 後端路由準備好（已有 session 就完成安全投影核實）先畀登入 */
/* 拉唔到後端嘅真正原因 —— 一定要顯示出嚟。以前淨係 console.warn，
   團員見到嘅係一個正常嘅登入頁，但名冊係空 → 點都入唔到，
   完全唔知發生咩事（2026-09-19 團長回報「公開連結冇修好」）。 */
let syncError = '';
/* 團員入口嘅 remote 模組引用（syncBoot 入面 assign）。
   rsvp()／submitQuiz() 要用佢 —— 見 pushSubmit() 註解。 */
let hubRemote = null;
/* 本人 mutation 唔再先改本機：pending／失敗都有明確狀態，失敗可原封重試。
   成功回應帶 server projection，remote 採用後先重畫，所以毋須「估」回滾。 */
let hubSubmitState = { pending: false, retry: null };

function hubSubmitBanner() {
  if (hubSubmitState.pending) {
    return `<div class="note-box info mb-12" id="hubSubmitState">${icon('cloud', 14)}<div><b>${esc(hubSubmitState.pending)}送出中…</b><div class="xs mt-4">請勿關閉頁面。</div></div></div>`;
  }
  const retry = hubSubmitState.retry;
  if (!retry) return '';
  return `<div class="note-box danger mb-12" id="hubSubmitState">${icon('alert', 14)}<div class="grow">
    <b>${esc(retry.what)}未送到</b><div class="xs mt-4">${esc(retry.error || '網絡或後端暫時失敗')}。本機畫面未當作成功；可以安全重試。</div>
    <button class="btn btn-xs btn-danger mt-8" id="hubRetrySubmit" type="button">重新送出</button>
  </div></div>`;
}

/**
 * 團員交嘢（回覆出席／交卷）之後**即刻**寫返後端。
 *
 * 團員交嘅嘢係**入站資料**：呢部機係團員嘅，佢交完就關，永遠唔會有人喺佢部機
 * 撳「儲存到後端」。如果暫存住，份回覆就永遠困喺團員部機 —— 等如冇交過。
 *
 * 所以入站提交即刻走 hubRsvp／hubQuiz／hubAbsence：GAS 由 opaque session 對回本人，
 * 完全唔採用 client memberId／role，只改本人嗰格。寫完回本人安全投影，唔會下載、
 * 亦唔會上傳整份行政資料庫。
 */
async function pushSubmit(what, kind, payload) {
  if (hubSubmitState.pending) return { ok: false, error: '上一項仍在送出' };
  const fail = (error) => {
    hubSubmitState = { pending: false, retry: { what, kind, payload: JSON.parse(JSON.stringify(payload || {})), error: String(error || '未知錯誤') } };
    paint();
    toast(`${what}未送到後端 —— 請按「重新送出」`, 'warn');
    return { ok: false, error: String(error || '未知錯誤') };
  };
  if (!hubRemote?.remoteConfigured?.()) return fail('旅團後端未設定');
  const auth = loadHubAuth(code());
  if (!auth?.sessionToken) return fail('登入狀態已失效，請重新登入');
  hubSubmitState = { pending: what, retry: null };
  paint();
  try {
    const options = { sessionToken: auth.sessionToken };
    const r = kind === 'rsvp'
      ? await hubRemote.saveHubRsvp(payload, options)
      : kind === 'quiz'
        ? await hubRemote.saveHubQuiz(payload, options)
        : await hubRemote.saveHubAbsence(payload, options);
    if (!r?.ok) return fail(r?.error || '後端拒絕請求');
    /* 後端回嘅係寫完之後嘅本人安全投影；remote 已採用後先當成功。 */
    hubSubmitState = { pending: false, retry: null };
    paint();
    toast(`${what}已送出`, 'ok');
    return r;
  } catch (e) {
    return fail(e?.message || '網絡錯誤');
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
      syncError = '呢個網址冇帶旅團編號，或者未接後端 —— 請用系統「公開資料」頁生成嘅連結。';
    } else {
      const auth = loadHubAuth(code());
      if (auth?.sessionToken) {
        const rc = await hubRemote.loadHubView({ sessionToken: auth.sessionToken });
        if (!rc?.ok) {
          clearHubIdentity(auth);
          syncError = rc?.error || '登入狀態已失效，請重新登入';
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
  const auth = loadHubAuth(code());
  if (!auth) return paintGate();
  saveMe({ id: auth.id, name: auth.name });
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
    saveHubAuth(code(), { id: m.id, name: m.name, ymis: m.ymis, identity: m.identity || 'member',
      mustChangePw: !!res.mustChangePw, sessionToken: res.sessionToken, sessionExpiresAt: res.sessionExpiresAt });
    saveMe({ id: m.id, name: m.name });
    syncError = '';
    paint();
    if (res.mustChangePw) forceMemberPw(m.id);
  });
}

/* ============================================================
   公開資料（團員入口版）
   ------------------------------------------------------------
   團長 2026-09-24：「團員入口應該讀『旅團設定』頁嘅資料（主要係連結）
   同『公開資料』（主要係 APP 內嘅內容）。」

   兩個來源：
     A. 旅團設定（`settings.troopLinks`，經 `troopPublicLinks()`）
        —— 6 個固定槽：Drive／相簿／IG／FB／網頁／WhatsApp。登入咗就見到。
     B. 公開資料（`db.publicProfile`）
        —— 社交媒體／相簿／網站／其他連結／「關於我團」，
           每一項都有「邊個睇到」：`other(1) < member(2) < exco(3) < leader(4) < chief(5)`。

   ★ 合併規則 —— 唔會出現兩條一樣嘅 IG：
     · 公開資料**有設**嗰個槽（IG／FB／WhatsApp／相簿／網站）→ 一律由公開資料話事：
       睇得到就出，睇唔到就**連旅團設定嗰條都唔出**。
       因為團長喺「公開資料」設咗可見範圍，就係想由嗰度統一管晒對外嘅嘢。
     · 公開資料**冇設**嗰個槽 → 用返旅團設定嗰條（舊資料唔會無端端消失）。
       Drive 喺公開資料冇對應，所以永遠嚟自旅團設定。
   ============================================================ */

/** 呢位團員嘅身份（用嚟計「邊個睇到」）。未登入／搵唔到＝''→ 乜都唔見。 */
function viewerIdentity(auth) {
  const m = activeMembers().find(x => x.id === auth?.id) || null;
  return m ? identityOf(m) : '';
}
/** 行事曆／通告／試卷：呢位團員睇唔睇到？（各自嘅編輯器設「邊個睇到」） */
function canSeeContent(rec, kind, role) {
  return visibleTo(contentVis(rec, kind), role);
}
function safeHref(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}
function card(it) {
  return { href: safeHref(it.url), ic: it.ic || 'link', label: String(it.title || it.label || '').trim(), desc: String(it.desc || '').trim(), url: String(it.url || '').trim() };
}

/** 公開資料 ＋ 旅團設定 → 團員入口見到嘅嘢。
 *  回傳 { about, groups:[{title, desc, items}] } —— 冇嘢嘅組唔會出。 */
function hubPublic(auth) {
  const role = viewerIdentity(auth);
  const pp = publicProfile();
  const seen = (arr) => (Array.isArray(arr) ? arr : []).filter(x => String(x?.url || '').trim());
  const may = (it) => visibleTo(it?.vis, role);

  const socials = seen(pp.socials).filter(may);
  const albums = seen(pp.albums).filter(may);
  const links = seen(pp.links).filter(may);
  const siteUrl = String(pp.site?.url || '').trim();
  const siteOn = siteUrl && may(pp.site);
  const aboutTx = String(pp.about?.text || '').trim();
  const aboutOn = aboutTx && may(pp.about);

  const legacy = troopPublicLinks();                       // 旅團設定（6 個固定槽）
  const legacyById = id => legacy.find(l => l.id === id);
  /* 公開資料「管緊」邊啲槽 —— 管緊嘅話，旅團設定嗰條要讓位（包括設咗睇唔到） */
  /* 後端安全投影會移除睇唔到項目嘅 URL，但保留 managedSlots，
     避免隱藏咗嘅公開資料槽又跌返去顯示旅團設定舊連結。 */
  const managed = new Set(Array.isArray(pp.managedSlots) ? pp.managedSlots : []);
  seen(pp.socials).forEach(s => { if (['instagram', 'facebook', 'whatsapp'].includes(s.kind)) managed.add(s.kind); });
  if (seen(pp.albums).length) managed.add('album');
  if (siteUrl) managed.add('website');
  /** 旅團設定嗰條要讓位俾公開資料 —— 公開資料管緊呢個槽就唔出 */
  const fallback = (id, ic) => {
    const l = legacyById(id);
    return (l && !managed.has(id)) ? card({ ...l, ic }) : null;
  };
  const plus = (...arr) => arr.filter(Boolean);

  /* ① 社交媒體 —— 公開資料嘅（連 YouTube／Telegram／電郵／電話）＋ 旅團設定剩低嘅 */
  const socialItems = [
    ...socials.map(s => card({ ...s, ic: socialIcon(s.kind), desc: s.desc || socialName(s.kind) })),
    ...plus(fallback('instagram', 'instagram'), fallback('facebook', 'facebook'), fallback('whatsapp', 'whatsapp'))
  ];

  /* ② 相簿 —— 公開資料嘅相簿 ＋ 旅團設定「相簿」＋「Drive」（Drive 公開資料冇得設） */
  const albumItems = [
    ...albums.map(a => card({ ...a, ic: 'image' })),
    ...plus(fallback('album', 'image'), legacyById('drive') ? card({ ...legacyById('drive'), ic: 'cloud' }) : null)
  ];

  /* ③ 網站與其他連結 —— 公開資料「網站」／旅團設定「網頁」／公開資料其他連結 */
  const linkItems = [
    ...plus(siteOn ? card({ title: pp.site.title || '旅團網站', url: siteUrl, desc: pp.site.desc || '', ic: 'globe' }) : null,
            fallback('website', 'globe')),
    ...links.map(l => card({ ...l, ic: 'external' }))
  ];

  const groups = [
    { title: '社交媒體', desc: '我團嘅 IG／FB／YouTube 等 —— 撳一下就開', items: socialItems },
    { title: '相簿', desc: '活動相、共用雲端硬碟', items: albumItems },
    { title: '網站與其他連結', desc: '旅團網頁同其他有用連結', items: linkItems }
  ].filter(g => g.items.length);

  return { about: aboutOn ? aboutTx : '', groups };
}

/** 一張連結卡（團員入口用） */
function linkCard(it) {
  return `<a class="hub-card" href="${esc(it.href)}" target="_blank" rel="noopener noreferrer">
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
  /* ★ 通告都有「邊個睇到」（喺通告編輯器設，預設「對外公開」＝免登入都睇到） */
  const notices = (load().notices || []).filter(n => n.status === 'published' && canSeeContent(n, 'notice', role))
    .sort((a, b) => Number(closedN(a, today)) - Number(closedN(b, today)));
  const media = hubPublic(auth);
  const u = code();
  const tools = [
    { href: '#/progress', icon: 'target', title: '我的進度', desc: '睇自己獎章進度，仲可以申報完成咗邊項' },
    { href: '#/absence', icon: 'calendar', title: '我的請假', desc: '嚟唔到？寫低邊日同原因，等覆核' },
    { href: publicPageUrl('entry.html', { u }), icon: 'camera', title: '影單據／記一筆', desc: '墊支或代收，影相交司庫' },
    { href: publicPageUrl('borrow.html', { u }), icon: 'grid', title: '借物資', desc: '申請借用旅團物資' },
    { href: publicPageUrl('constitution.html', { u }), icon: 'book', title: '團章', desc: '免登入閱讀' }
  ];
  return `
    <div class="semibold mb-8">我要做</div>
    ${tools.map(t => t.href.startsWith('#')
      ? `<button class="hub-card" type="button" data-open="${esc(t.href)}" style="width:100%;text-align:left">
          <span class="stat-ic">${icon(t.icon, 18)}</span>
          <div class="grow"><div class="semibold">${esc(t.title)}</div><div class="xs muted mt-4">${esc(t.desc)}</div></div>
        </button>`
      : `<a class="hub-card" href="${esc(withName(t.href, auth))}">
          <span class="stat-ic">${icon(t.icon, 18)}</span>
          <div class="grow"><div class="semibold">${esc(t.title)}</div><div class="xs muted mt-4">${esc(t.desc)}</div></div>
        </a>`).join('')}

    ${media.about ? `
    <div class="semibold mt-24 mb-8">關於我團</div>
    <div class="card card-pad"><div class="sm" style="white-space:pre-wrap">${esc(media.about)}</div></div>` : ''}

    ${media.groups.map(g => `
    <div class="semibold mt-24 mb-8">${esc(g.title)}</div>
    <div class="xs muted mb-8">${esc(g.desc)}</div>
    ${g.items.map(linkCard).join('')}`).join('')}

    <div class="semibold mt-24 mb-8">活動行事曆</div>
    ${evs.length ? evs.map(e => {
      const st = myRsvp(e, auth);
      const overnight = e.dateEnd && e.dateEnd !== e.date;
      return `<button class="hub-card" type="button" data-open="#/cal/${e.id}" style="width:100%;text-align:left">
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
      return `<button class="hub-card" type="button" data-open="#/cal/${e.id}" style="width:100%;text-align:left;opacity:.78">
        <span class="stat-ic">${icon('calendar', 18)}</span>
        <div class="grow"><div class="semibold">${esc(e.title)} <span class="badge b-grey">已完結</span></div>
          <div class="xs muted mt-4">${esc(e.date)}${e.dateEnd && e.dateEnd !== e.date ? ' 至 ' + esc(e.dateEnd) : ''} ${esc(e.venue || '')}</div>
          ${st ? `<div class="xs mt-4"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(RSVP[st]?.label)}</span></div>` : ''}</div>
      </button>`;
    }).join('')}` : ''}

    <div class="semibold mt-24 mb-8">試卷</div>
    ${qz.length ? qz.map(q => `<button class="hub-card" type="button" data-open="#/quiz/${q.id}" style="width:100%;text-align:left">
      <span class="stat-ic">${icon('note', 18)}</span>
      <div class="grow"><div class="semibold">${esc(q.title)}</div>
        <div class="xs muted mt-4">${(q.questions || []).length} 題</div></div>
    </button>`).join('') : '<div class="card card-pad muted">暫時未有開放試卷。</div>'}

    <div class="semibold mt-24 mb-8">通告</div>
    ${notices.length ? notices.map(n => {
      const href = publicPageUrl('notice.html', { u, n: n.id });
      const closed = closedN(n, today);
      return `<a class="hub-card" href="${esc(withName(href, auth))}" ${closed ? 'style="opacity:.78"' : ''}>
        <span class="stat-ic">${icon('megaphone', 18)}</span>
        <div class="grow"><div class="semibold">${esc(n.title?.zh || n.id)}${closed ? ' <span class="badge b-grey">已截止</span>' : ''}</div>
          <div class="xs muted mt-4">${esc(n.eventDate || '')} ${n.needSignup
            ? (closed ? '· 報名已截止（想報就搵領袖／執委）' : (n.deadline ? `· 截止 ${esc(n.deadline)}` : '· 可回覆出席'))
            : ''}</div></div>
      </a>`;
    }).join('') : '<div class="card card-pad muted">暫時未有已發布通告。</div>'}
  `;
}

function withName(url, auth) {
  const me = loadMe();
  const name = me.name || auth?.name || '';
  if (!name) return url;
  try {
    const u = new URL(url, location.href);
    u.searchParams.set('name', name);
    if (me.id || auth?.id) u.searchParams.set('mid', me.id || auth.id);
    return u.toString();
  } catch { return url; }
}

/* ============================================================
   回覆出席／交卷 —— 直接用登入身份（登入咗就知你係邊個）
   ============================================================ */
function whoAmI(auth) {
  if (auth?.id) {
    const m = activeMembers().find(x => x.id === auth.id) || null;
    return { id: auth.id, name: m?.name || auth.name || '', email: m?.email || '' };
  }
  return null;
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
        <button class="btn btn-sm ${st === 'present' ? 'btn-primary' : ''}" type="button" data-eid="${e.id}" data-rsvp="present">${RSVP.present.label}</button>
        <button class="btn btn-sm ${st === 'absent' ? 'btn-primary' : ''}" type="button" data-eid="${e.id}" data-rsvp="absent">${RSVP.absent.label}</button>
      </div>
      ${st ? `<div class="xs mt-10"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(myRsvpLine(e, auth))}</span>
        <button class="btn btn-xs btn-ghost" type="button" data-eid="${e.id}" data-rsvp="edit">改一改</button></div>` : ''}`}
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
  const memberId = String(auth?.id || '');
  const ymis = String(auth?.ymis || '');
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
      body: `<div class="grid g-2" style="gap:12px">
          <div class="field"><label class="label">日子 <span class="req">*</span></label>
            <input class="input" type="date" id="ab-date" value="${esc(todayISO())}"></div>
          <div class="field"><label class="label">時段</label>
            <select class="select" id="ab-slot">${ABSENCE_SLOTS.map(s => `<option value="${s.id}" ${s.id === 'full' ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
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
        ${(d.badges || []).filter(b => b.total).map(b => `
          <div class="mt-16">
            <div class="row-between sm"><span>${esc(b.icon || '')} ${esc(b.name)}</span><span class="mono xs">${b.done}/${b.total}（${b.rate}%）</span></div>
            <div class="progress mt-4"><i style="width:${b.rate}%"></i></div>
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
          </div>`).join('') || '<div class="xs muted mt-8">未有考核項目定義。</div>'}
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
    body: `<div class="field"><label class="label">完成日期</label>
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
}

/** 團員入口求救 —— 同管理系統走同一條 ADMIN「問題回報」（圖書館嗰張表）。 */
async function openHubSOS(auth) {
  const { openMemberSOS } = await import('./lib/onboard.js');
  const m = auth?.id ? activeMembers().find(x => x.id === auth.id) : null;
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
    body: fieldsHtml,
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
    if (item.type === 'multi') answers[item.id] = [...app.querySelectorAll(`[data-ans="${item.id}"]:checked`)].map(el => el.value);
    else if (item.type === 'single') answers[item.id] = app.querySelector(`[data-ans="${item.id}"]:checked`)?.value || '';
    else answers[item.id] = app.querySelector(`[data-ans="${item.id}"]`)?.value.trim() || '';
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
    body: `<div class="field"><label class="label">新密碼</label>
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
