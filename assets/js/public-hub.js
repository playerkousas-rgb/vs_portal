/* ============================================================
   public-hub.js — 團員入口（members.html）
   ------------------------------------------------------------
   2026-09-18 深夜大修（團長回報 6 項問題嘅 1／2／4／5／6）：
   ① 開機會由旅團後端（Google Sheet）拉最新資料 —— 以前淨係讀本機
     localStorage，新裝置／無痕視窗／團員手機全部空白（登入都唔得、
     IG／FB連結／活動／通告全部「未公開」）。而家同執委版一樣：
     開機由後端攞成份資料做基準 → 團員交嘢即刻行同一條儲存路寫返上去
     （核對版本＋三方比對，只寫自己嗰格）。冇背景 poll。
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
import { init, load, update } from './lib/store.js';
import { profile, publicEvents, RSVP, quizzes, activeMembers, publicPageUrl, troopPublicLinks, identityOf, IDENTITIES } from './lib/model.js';
import { loadMe, saveMe } from './lib/member-me.js';
import { loadHubAuth, saveHubAuth, clearHubAuth } from './lib/hub-session.js';
import { loginMember, changeMemberOwnPassword, TEMP_PASSWORD } from './lib/auth.js';
import { progressConfigured, loadRemote, loadItems, flattenItems, memberDetail, submitProgressRequest, loadMyRequests } from './lib/progress.js';
import { esc, icon, toast, todayISO, modal } from './lib/util.js';

const app = document.getElementById('app');
let syncReady = false;      /* 後端拉完（或者確定唔使拉）先畀登入 */
/* 拉唔到後端嘅真正原因 —— 一定要顯示出嚟。以前淨係 console.warn，
   團員見到嘅係一個正常嘅登入頁，但名冊係空 → 點都入唔到，
   完全唔知發生咩事（2026-09-19 團長回報「公開連結冇修好」）。 */
let syncError = '';
/* 團員入口嘅 remote 模組引用（syncBoot 入面 assign）。
   rsvp()／submitQuiz() 要用佢 —— 見 pushSubmit() 註解。 */
let hubRemote = null;

/**
 * 團員交嘢（回覆出席／交卷）之後**即刻**寫返後端。
 *
 * 團員交嘅嘢係**入站資料**：呢部機係團員嘅，佢交完就關，永遠唔會有人喺佢部機
 * 撳「儲存到後端」。如果暫存住，份回覆就永遠困喺團員部機 —— 等如冇交過。
 *
 * 所以入站提交即刻行**同一條**儲存路 saveToBackend()：先核對後端版本、三方比對，
 * 只會寫團員自己嗰格（佢嘅 RSVP／答卷）；執委嘅資料一格都唔會蓋。
 * policy:'mine' ＝ 撞正同一格（例如執委同時幫佢改咗出席）就以團員自己啱啱交嘅為準
 * （團員部機冇人可以答對話框）。
 */
async function pushSubmit(what) {
  if (!hubRemote?.remoteConfigured?.()) return;
  try {
    const r = await hubRemote.saveToBackend({ policy: 'mine', silent: true });
    if (!r?.ok) toast(`${what}已記低喺呢部機，但暫時送唔到後端（${r?.error || '未知'}）—— 請話畀執委知`, 'warn');
    else if (r.remoteChanged) paint();   /* 順便併入咗執委嘅新資料 → 重畫 */
  } catch (e) {
    toast(`${what}已記低喺呢部機，但暫時送唔到後端 —— 請話畀執委知`, 'warn');
  }
}

/* 通告係咪已過報名截止（冇截止日／唔使報名＝未截止） */
function closedN(n, today) {
  return !!(n.needSignup && n.deadline && String(n.deadline) < today);
}

async function boot() {
  const u = new URLSearchParams(location.search);
  const code = (u.get('u') || '').trim() || defaultUnitCode();
  await loadRegistry();
  await init({ mode: 'real', unit: code });
  paint();
  /* 後端先係資料正本：拉完先至有得登入（名冊喺後端度）。
     失敗都唔會死 —— 照用本機資料，狀態條會話畀你知。 */
  syncBoot();
}

/* 開機對一對後端（同 main.js 嘅 syncBoot 同一套邏輯，呢度係 hub 版） */
async function syncBoot() {
  let remoteApi = null;
  try {
    remoteApi = await import('./lib/remote.js');
    hubRemote = remoteApi;      // 畀 pushSubmit()（團員交嘢即刻寫後端）用
    const store = await import('./lib/store.js');
    if (!remoteApi.remoteConfigured?.()) {
      syncError = '呢個網址冇帶旅團編號，或者未接後端 —— 請用系統「成員連結」頁生成嘅連結。';
      syncReady = true; paint(); return;
    }
    store.setSaveHook(() => remoteApi.scheduleSave());
    /* 2026-09-20：同 main.js 一樣行 loadFromBackend() —— 開機由後端攞成份資料做基準。
       上次交咗但送唔出嘅嘢（pending）會三方比對保留（撞正就以團員自己嘅為準）。
       讀唔到就一律唔寫 —— 交卷／回覆都要先有基準先至可以寫。 */
    try {
      const rc = await remoteApi.loadFromBackend({ policy: 'mine' });
      if (!rc?.ok) {
        /* 讀唔到名冊 ＝ 團員一定入唔到。原因如實講（唔好靜靜雞）。
           團員入口要讀成個資料庫（名冊＋密碼），呢個 action 後端要 API Key，
           所以**冇得**靠連結帶 ?be= 自救 —— 一定要平台伺服器端登記好。 */
        syncError = (rc?.error || '讀唔到旅團後端')
          + (rc?.reason === 'not_registered'
            ? '（平台伺服器端未登記呢個旅團：要管理員喺 Vercel 加 TROOP_<編號>_BACKEND／_APIKEY 再 Redeploy。'
              + '團員入口要讀名冊，呢一步冇得由團員自己繞過。）' : '');
      } else if (rc.found === false) {
        syncError = '後端仲未有資料庫 —— 執委請先喺系統撳「儲存到後端」。';
      } else if (!rc.version) {
        syncError = '後端版本舊咗（讀唔到改動版本）—— 執委請更新 Apps Script 去 v2.5.0。';
      }
      /* 上次困住嘅回覆／答卷 → 而家有基準喇，即刻送 */
      if (rc?.ok && rc.found !== false && remoteApi.hasPending?.()) pushSubmit('上次未送出嘅回覆');
    } catch (e) {
      console.warn('[hub] 開機拉後端失敗（照用本機資料）', e);
      syncError = e?.message || String(e);
    }
    window.addEventListener('v82:sync', paintSyncBadge);
  } catch { /* remote 模組載入唔到 —— 照用本機 */ }
  syncReady = true;
  paint();          /* 拉完資料重新畫（登入閘／主頁內容都可能變咗） */
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
        · <button class="btn btn-xs" type="button" id="hubLogout" style="color:#fff;border-color:rgba(255,255,255,.35)">登出</button></div>
    </div>
  </div>
  <div class="hub-wrap">
    ${sec === 'cal' && id ? eventDetail(id, auth)
      : sec === 'quiz' && id ? quizFill(id, auth)
      : sec === 'progress' ? progressPage(auth)
      : home(auth)}
  </div>`;
  bind(auth);
  paintSyncBadge();
  if (sec === 'progress') fillProgressPage(auth);
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
      <div class="xs" style="opacity:.85;margin-top:6px">外人入唔到。首次密碼係 ${TEMP_PASSWORD}，入去要改。</div>
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
    saveHubAuth(code(), { id: m.id, name: m.name, ymis: m.ymis, identity: identityOf(m), mustChangePw: !!res.mustChangePw });
    saveMe({ id: m.id, name: m.name });
    paint();
    if (res.mustChangePw) forceMemberPw(m.id);
  });
}

/* ============================================================
   主頁
   ============================================================ */
function home(auth) {
  const today = todayISO();
  /* ① 活動：分「即將舉行」同「過往」—— 過往嘅唔會排先做提醒，
     但**內容照留得住**：報咗名嘅團員想睇返詳情、遲咗想參加嘅可以
     搵領袖／執委跟進，都唔會搵唔返。 */
  const evAll = publicEvents();
  const isPast = e => {
    const end = String(e.dateEnd || e.date || '').slice(0, 10);
    return !!end && end < today;
  };
  const evs = evAll.filter(e => !isPast(e));
  const pastEvs = evAll.filter(isPast).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  /* ② 試卷：closed 嘅唔顯示（同以前一樣） */
  const qz = quizzes().filter(q => q.status !== 'closed');
  /* ③ 通告：已發布嘅全部顯示 —— 截止咗報名嘅會擺後＋標「已截止」，
     內容照開得到（成員遲咗想報就問領袖／執委）；草稿先係完全唔出街。 */
  const notices = (load().notices || []).filter(n => n.status === 'published')
    .sort((a, b) => Number(closedN(a, today)) - Number(closedN(b, today)));
  const links = troopPublicLinks();
  const u = code();
  const LINK_ICON = { drive: 'cloud', album: 'image', instagram: 'instagram', facebook: 'facebook', website: 'globe', whatsapp: 'whatsapp' };
  const tools = [
    { href: '#/progress', icon: 'target', title: '我的進度', desc: '睇自己獎章進度，仲可以申報完成咗邊項' },
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

    ${links.length ? `
    <div class="semibold mt-24 mb-8">旅團連結</div>
    <div class="xs muted mb-8">後台填咗嘅 IG／FB／網頁等 —— 撳一下就開，唔使記網址</div>
    ${links.map(l => {
      const safe = /^https?:\/\//i.test(l.url) ? l.url : 'https://' + l.url;
      return `<a class="hub-card" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">
        <span class="stat-ic">${icon(LINK_ICON[l.id] || 'link', 18)}</span>
        <div class="grow"><div class="semibold">${esc(l.label)}</div><div class="xs muted mt-4">${esc(l.desc)} · ${esc(l.url)}</div></div>
        <span class="stat-ic">${icon('external', 15)}</span>
      </a>`;
    }).join('')}` : ''}

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
    return { id: auth.id, name: m?.name || auth.name || '' };
  }
  return null;
}

function myRsvp(e, auth) {
  const ident = whoAmI(auth);
  if (!ident?.id) return '';
  const v = (e.rsvp || {})[ident.id];
  return v?.status || v || '';
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
        ${Object.entries(RSVP).map(([k, v]) =>
          `<button class="btn btn-sm ${st === k ? 'btn-primary' : ''}" type="button" data-eid="${e.id}" data-rsvp="${k}">${v.label}</button>`).join('')}
      </div>
      ${st ? `<div class="xs mt-10"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(RSVP[st]?.label || st)}</span>
        <span class="faint">· 撳另一個掣可以改</span></div>` : ''}`}
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
    const [r, it, mine] = await Promise.all([loadRemote(), loadItems(), loadMyRequests(ymis)]);
    if (!r.ok) {
      box.innerHTML = `<div class="card card-pad"><div class="semibold mb-4">我的進度</div>
        <div class="xs muted">${esc(r.error || '讀唔到進度')}</div></div>`;
      return;
    }
    const catalog = it.ok ? flattenItems(it.data) : {};
    const d = memberDetail(r.data, catalog, ymis);
    const myName = (r.data?.members || []).find(m => String(m.ymis) === ymis)?.name || auth?.name || '';
    const reqs = (mine?.ok && mine?.data?.requests) || [];
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
  const res = await submitProgressRequest({ ymis, name: auth?.name || '', item_id: itemId, item_name: itemName, requested_date: r.date, evidence: r.ev });
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
  app.querySelector('#hubLogout')?.addEventListener('click', () => {
    clearHubAuth(code());
    paint();
  });
  app.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.open; paint(); }));
  app.querySelectorAll('[data-rsvp]').forEach(b => b.addEventListener('click', () => rsvp(b.dataset.eid, b.dataset.rsvp, auth)));
  app.querySelector('[data-quiz-submit]')?.addEventListener('click', () => submitQuiz(location.hash.split('/')[2] || location.hash.split('/')[1], auth));
}

function rsvp(eid, status, auth) {
  const ident = whoAmI(auth);
  if (!ident) { toast('請先登入再回覆', 'warn'); return; }
  const e = (load().events || []).find(x => x.id === eid);
  if (!e) return;
  const map = { ...(e.rsvp || {}) };
  map[ident.id] = { status, at: todayISO(), name: ident.name };
  update('events', eid, { rsvp: map });
  toast('已回覆：' + RSVP[status].label, 'ok');
  paint();
  pushSubmit('出席回覆');   // 入站資料：即刻寫後端，唔可以困喺團員部機
}

function submitQuiz(id, auth) {
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
  const responses = { ...(q.responses || {}) };
  responses[ident.id] = { name: ident.name, at: todayISO(), answers };
  update('quizzes', id, { responses });
  toast('已交卷', 'ok');
  location.hash = '#/home';
  paint();
  pushSubmit('答卷');       // 入站資料：即刻寫後端，唔可以困喺團員部機
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
  const res = await changeMemberOwnPassword(memberId, '', r);
  toast(res.ok ? '密碼已更改' : (res.msg || '改唔到'), res.ok ? 'ok' : 'err');
  if (res.ok) {
    const a = loadHubAuth(code());
    if (a) saveHubAuth(code(), { ...a, mustChangePw: false });
    if (location.hash === '#forcepw') location.hash = '#/home';
  }
}

window.addEventListener('hashchange', () => { try { paint(); } catch { /* */ } });
boot().catch(e => {
  app.innerHTML = `<div style="padding:40px" class="muted">載入失敗：${esc(e.message || e)}</div>`;
});
