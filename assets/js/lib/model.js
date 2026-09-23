/* ============================================================
   model.js — 共用業務邏輯
   （會議狀態、團員／生日、財務統計、物資庫存、團章）
   ============================================================ */

import { load, collection, find, commit } from './store.js';
import { unitEntry } from './units.js';
import { isExecUrl, normExecUrl } from './gateway.js';
import { todayISO, parseBirthday, daysUntilBirthday, ageFrom, turningAge } from './dates.js';
import { agmIsDefault, unitFYOf, scoutFYLabel, scoutFYRange, inRange } from './fiscal.js';
export * from './fiscal.js';

/* ---------------- 基本 ---------------- */
export function settings() { return load().settings || {}; }
export function profile() { return load().profile || load().unit || {}; }
export function currency() { return settings().currency || 'HK$'; }
export function money(n) {
  const v = Number(n) || 0;
  return currency() + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ---------------- 公開頁連結（成員免登入用） ----------------
   entry.html      手機記一筆（收支申報）
   borrow.html     物資借用申請
   notice.html     通告 + 回覆出席與否
   constitution.html 團章
   全部都可以喺「帳號與系統 → 旅團設定」或者「成員連結」頁改做自己嘅網址。 */
/** 旅團公開連結（Drive／相簿／IG／FB／網頁），團員登入後先見到 */
export function troopPublicLinks() {
  const L = settings().troopLinks || {};
  const rows = [
    ['drive', 'Google Drive', '雲端硬碟／共用資料夾'],
    ['album', '相簿', '活動相／相簿連結'],
    ['instagram', 'Instagram', '旅團 IG'],
    ['facebook', 'Facebook', '旅團專頁'],
    ['website', '網頁', '旅團／主辦機構網站'],
    ['whatsapp', 'WhatsApp', '聯絡／群組連結']
  ];
  return rows.map(([id, label, desc]) => ({
    id, label, desc, url: String(L[id] || '').trim()
  })).filter(x => x.url);
}

export function publicPageUrl(file, params = {}) {
  const s = settings().publicLinks || {};
  const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
    ? location.origin + String(location.pathname).replace(/[^/]*$/, '')
    : '';
  const target = s[file] || s.base || (origin ? origin + file : file);
  let url;
  try { url = new URL(target, origin || undefined); }
  catch { return target; }
  const p = { ...params };
  /* 自助後端（?be=）：平台伺服器端未登記呢個旅團嗰陣，公開頁經 /api/proxy
     一定 404（「找不到此旅團」）—— 團章／通告／記帳／借用條條都死。
     而家由領袖呢邊把旅團自己嘅 /exec 附埋入連結（呢啲連結本來就係派畀團員嘅，
     /exec 本身又係「任何人」存取，所以冇多洩露任何嘢；API Key 永遠唔會附）。
     平台已經登記好（backendReady）就唔使附，保持網址簡潔。 */
  if (p.be === undefined) {
    const be = selfServeExec();
    if (be) p.be = be;
  }
  Object.entries(p).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  return url.toString();
}

/**
 * 領袖自己登記咗嘅後端 /exec（「總表同步 → 同步設定」嗰格）。
 * 只喺**平台伺服器端未有登記**嗰陣先回傳 —— 平台接線正常就用返正路。
 * @returns {string} 合格嘅 /exec，或者 ''
 */
export function selfServeExec() {
  try {
    const db = load();
    const url = String(db?.sync?.url || db?.backend?.gasUrl || '').trim();
    if (!isExecUrl(url)) return '';
    const code = db?.unitCode || '';
    const entry = code ? unitEntry(code) : null;
    if (entry?.backendReady === true) return '';       // 平台已登記 → 唔使附
    return normExecUrl(url);
  } catch { return ''; }
}

/** 公開連結而家會行邊條路（「成員連結」頁顯示用，等領袖睇到條 link 係咪真係用得） */
export function publicLinkRoute() {
  const db = load();
  const code = db?.unitCode || '';
  const entry = code ? unitEntry(code) : null;
  if (entry?.backendReady === true) {
    return { route: 'proxy', label: '平台代理', ok: true,
      detail: '旅團已喺平台伺服器端登記，公開頁經 /api/proxy 讀寫後端（正路）。' };
  }
  const be = selfServeExec();
  if (be) {
    return { route: 'direct', label: '旅團自己嘅 /exec', ok: true,
      detail: '平台未登記呢個旅團，所以連結附咗你自己嘅 /exec（?be=）—— 團章／通告／記帳／借用照樣用到。' };
  }
  return { route: 'none', label: '未接後端', ok: false,
    detail: '平台未登記呢個旅團，你自己都未貼 /exec —— 公開頁會讀唔到後端資料。'
      + '去「帳號與系統 → 資料管理 → 總表同步 → 同步設定」貼 /exec（＋API Key）就會即刻修好。' };
}
/** 成員用嘅公開連結清單（「成員連結」頁同 QR 都用呢個） */
export function memberLinks() {
  const code = load().unitCode;
  const out = [
    {
      id: 'hub', icon: 'home', label: '團員入口（掃一次就齊）',
      desc: '只需派呢一條：行事曆、回覆出席、試卷、影單據、借物資、團章、通告。QR／WhatsApp 都用呢條。',
      url: publicPageUrl('members.html', { u: code })
    },
    {
      id: 'entry', icon: 'camera', label: '收支申報（手機記一筆）',
      desc: '成員影相 → 揀欄目 → 金額 → 送出，司庫批核後自動入帳（取代 Google Form）',
      url: publicPageUrl('entry.html', { u: code })
    },
    {
      id: 'borrow', icon: 'grid', label: '物資借用申請',
      desc: '成員自己申請借物資，執委喺 APP 批核；借出／歸還自動加減庫存',
      url: publicPageUrl('borrow.html', { u: code })
    },
    {
      id: 'constitution', icon: 'book', label: '團章（公開閱讀）',
      desc: '免登入閱讀最新版團章，可輸出 Word / PDF',
      url: publicPageUrl('constitution.html', { u: code })
    }
  ];
  collection('notices').filter(n => n.status === 'published').slice(0, 40).forEach(n => {
    out.push({
      id: 'notice:' + n.id, icon: 'megaphone', label: `通告：${n.title?.zh || n.id}`,
      desc: `免登入閱讀${n.needSignup ? '＋回覆出席與否' : ''}${n.deadline ? `（截止 ${n.deadline}）` : ''}`,
      url: publicPageUrl('notice.html', { u: code, n: n.id })
    });
  });
  return out;
}

/* ---------------- 舊系統遷移（82venture → ecportal） ----------------
   82venture.vercel.app 係舊嘅單旅團系統，退役之後上面嘅公開頁
   （notice.html / entry.html / borrow.html / constitution.html）會死晒。
   但各旅團資料庫入面儲存咗嘅公開網址（settings.notice.publicBaseUrl、
   settings.publicBaseUrl、settings.publicLinks.*）好可能仲指去舊站 ——
   嗰陣時舊站就係正站，個個都係咁填，仲會跟埋後端同步去每一部機。
   呢度幫手搵出嚟＋一鍵搬去而家呢個站。
   （新舊站嘅公開頁檔名一樣，所以淨係換 host 就得，path＋參數照留。） */

/** 已經退役嘅舊站（唔好再派呢啲 host 嘅連結／QR 出街） */
export const LEGACY_HOSTS = ['82venture.vercel.app'];
/** 新正站（舊站截停畫面會指去呢度；轉 custom domain 嗰陣記得改埋呢度） */
export const CANONICAL_HOST = 'ecportal.vercel.app';
export const canonicalUrl = () => `https://${CANONICAL_HOST}/`;

function hostOf(u) {
  try { return new URL(String(u || ''), 'https://x.invalid').hostname.toLowerCase(); }
  catch { return ''; }
}

/** 呢條連結係咪指去舊站？（相對路徑／留空＝唔係） */
export function isLegacyUrl(u) {
  const h = hostOf(u);
  return !!h && h !== 'x.invalid' && LEGACY_HOSTS.includes(h);
}

/** 而家係咪喺舊站開緊？（main.js boot 截停用） */
export function onLegacyHost() {
  try {
    return LEGACY_HOSTS.includes(String(location.hostname || '').toLowerCase());
  } catch { return false; }
}

/** 把舊站網址換成而家呢個站（淨換 host；唔係舊站網址就原樣回傳） */
export function migrateLegacyUrl(u) {
  try {
    if (!isLegacyUrl(u)) return String(u || '');
    const cur = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
      ? location.origin : '';
    if (!cur) return String(u);
    const next = new URL(String(u));
    const curU = new URL(cur);
    next.protocol = curU.protocol;
    next.host = curU.host;
    return next.toString();
  } catch { return String(u || ''); }
}

/** 搵出資料庫入面所有指去舊站嘅公開網址設定（[{ key, label, url }]） */
export function findLegacyPublicUrls() {
  const out = [];
  const s = settings() || {};
  const push = (key, label, url) => {
    if (url && isLegacyUrl(url)) out.push({ key, label, url: String(url) });
  };
  push('notice.publicBaseUrl', '通告公開頁基礎網址', s.notice?.publicBaseUrl);
  push('publicBaseUrl', '團章公開網址', s.publicBaseUrl);
  const pl = s.publicLinks || {};
  push('publicLinks.base', '公開頁基礎網址', pl.base);
  for (const f of ['entry.html', 'borrow.html', 'notice.html', 'constitution.html']) {
    push('publicLinks.' + f, `公開頁 ${f}`, pl[f]);
  }
  return out;
}

/** 一鍵搬：把上面搵到嘅全部換成而家呢個站。回傳搬咗幾多個。 */
export function migrateLegacyPublicUrls() {
  const found = findLegacyPublicUrls();
  if (!found.length) return 0;
  const db = load();
  db.settings = { ...(db.settings || {}) };
  for (const { key } of found) {
    if (key === 'notice.publicBaseUrl') {
      db.settings.notice = {
        ...(db.settings.notice || {}),
        publicBaseUrl: migrateLegacyUrl(db.settings.notice?.publicBaseUrl)
      };
    } else if (key === 'publicBaseUrl') {
      db.settings.publicBaseUrl = migrateLegacyUrl(db.settings.publicBaseUrl);
    } else if (key.startsWith('publicLinks.')) {
      const k = key.slice('publicLinks.'.length);
      db.settings.publicLinks = {
        ...(db.settings.publicLinks || {}),
        [k]: migrateLegacyUrl(db.settings.publicLinks?.[k])
      };
    }
  }
  commit();
  return found.length;
}

/* ---------------- 會議 ---------------- */
export const MEETING_STATUS = {
  draft:     { label: '草稿',   cls: 'b-grey' },
  pending:   { label: '待處理', cls: 'b-warn' },
  confirmed: { label: '已確定', cls: 'b-info' },
  done:      { label: '已完成', cls: 'b-ok' },
  cancelled: { label: '已取消', cls: 'b-danger' }
};
export const MEETING_TYPES = { exco: '執委會會議', agm: '團員大會', activity: '活動會議', other: '其他' };
export const ATTEND = {
  present: { label: '出席', cls: 'b-ok' },
  late:    { label: '遲到', cls: 'b-warn' },
  apology: { label: '請假', cls: 'b-info' },
  absent:  { label: '缺席', cls: 'b-danger' }
};
export function statusLabel(s) { return (MEETING_STATUS[s] || MEETING_STATUS.draft).label; }
export function statusBadge(s) {
  const m = MEETING_STATUS[s] || MEETING_STATUS.draft;
  return `<span class="badge ${m.cls}"><span class="dot"></span>${m.label}</span>`;
}

/* ---------------- 團員 / 用戶 ---------------- */
/**
 * 身份（呢個系統管嘅係「用戶」：領袖、執委、團員都可能喺名冊入面）
 * identity = 系統身份（決定權限層級、顯示）
 * role     = 團內職位（自由文字，例：主席 / 司庫 / 小隊長）
 */
export const IDENTITIES = {
  leader: { l: '領袖', short: '領袖', c: 'b-brand', level: 3 },
  exco:   { l: '執委', short: '執委', c: 'b-info', level: 2 },
  member: { l: '團員', short: '團員', c: 'b-grey', level: 1 }
};
export function identityLabel(m) {
  const k = m?.identity || 'member';
  return (IDENTITIES[k] || IDENTITIES.member).l;
}
export function identityOf(m) {
  const k = m?.identity || 'member';
  return IDENTITIES[k] ? k : 'member';
}
/** 由舊資料／職位文字推算身份（升級舊資料庫用） */
export function guessIdentity(m) {
  if (m?.identity && IDENTITIES[m.identity]) return m.identity;
  const t = `${m?.role || ''} ${(m?.tags || []).join(' ')}`.toLowerCase();
  if (/(團長|領袖|leader|scouter|隊長)/.test(t)) return 'leader';
  if (/(執委|執行委員會|exco|committee|主席|司庫|文書)/.test(t)) return 'exco';
  return 'member';
}
export function membersByIdentity(k) { return members().filter(m => identityOf(m) === k); }

export function members() { return collection('members'); }
export function member(id) { return find('members', id); }
export function memberName(id) { return member(id)?.name || '—'; }
export function activeMembers() { return members().filter(m => m.status !== 'alumni'); }

/* ---------- 跨系統身份 key（同進度追蹤等外部系統對人用） ----------
   進度資料嘅身份規則：**成員用 YMIS（10 位數字），領袖用 Email**。
   （佢登入頁：「成員：YMIS 10位數字 + 密碼；領袖：Email + 密碼」）
   所以唔可以一刀切要求所有人都有 YMIS —— 領袖本來就唔會有，
   把領袖當「未填 YMIS」係計錯。呢度按身份揀啱嘅 key。 */

/** 呢位用戶**應該**用邊種外部 key（領袖→email，其他→ymis） */
export function expectedKeyKind(m) { return identityOf(m) === 'leader' ? 'email' : 'ymis'; }

/** 用戶嘅跨系統 key（按身份揀：領袖 email 優先，團員／執委 YMIS 優先） */
export function memberKey(m) {
  const ymis = String(m?.ymis || '').trim();
  const email = String(m?.email || '').trim().toLowerCase();
  const order = expectedKeyKind(m) === 'email'
    ? [['email', email], ['ymis', ymis]]
    : [['ymis', ymis], ['email', email]];
  for (const [kind, v] of order) if (v) return { key: v, kind };
  const sys = String(m?.systemId || '').trim();
  if (sys) return { key: sys, kind: 'systemId' };   // 對方認唔到，只係本系統 fallback
  return { key: '', kind: '' };
}
/**
 * 名冊嘅身份 key 覆蓋率。
 * 「對得上」＝有對方認得嘅 key（團員有 YMIS / 領袖有 Email）。
 * systemId 只係本系統 fallback，對方認唔到，所以唔算「對得上」。
 */
export function keyCoverage(list = members(), { youthOnly = false } = {}) {
  if (youthOnly) list = list.filter(m => !progressIgnored(m));
  const total = list.length;
  const leaders = list.filter(m => identityOf(m) === 'leader');
  const youth = list.filter(m => identityOf(m) !== 'leader');
  const withYmis = list.filter(m => String(m.ymis || '').trim()).length;
  const withEmail = list.filter(m => String(m.email || '').trim()).length;
  const withSystemId = list.filter(m => String(m.systemId || '').trim()).length;
  const youthOk = youth.filter(m => String(m.ymis || '').trim());
  const leaderOk = leaders.filter(m => String(m.email || '').trim());
  const matched = youthOk.length + leaderOk.length;
  const unmatched = total - matched;
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  return {
    total, withYmis, withEmail, withSystemId,
    youthTotal: youth.length, leaderTotal: leaders.length,
    youthWithYmis: youthOk.length, leaderWithEmail: leaderOk.length,
    matched, unmatched,
    /** 整體「對方認得到」嘅比例 */
    percent: pct(matched, total),
    youthPercent: pct(youthOk.length, youth.length),
    leaderPercent: pct(leaderOk.length, leaders.length),
    /** 兼容舊寫法：團員嘅 YMIS 覆蓋率 */
    ymisPercent: pct(youthOk.length, youth.length),
    ready: total > 0 && unmatched === 0,
    /** 未對得上嘅人（用嚟列出嚟提示補返） */
    unmatchedList: list.filter(m => {
      const need = expectedKeyKind(m);
      return !(need === 'email' ? String(m.email || '').trim() : String(m.ymis || '').trim());
    }).map(m => ({ id: m.id, name: m.name, identity: identityOf(m), need: expectedKeyKind(m) }))
  };
}
/** 用 key 搵人（YMIS / Email / systemId） */
export function findByKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const kl = k.toLowerCase();
  return members().find(m => String(m.ymis || '').trim() === k
    || String(m.email || '').trim().toLowerCase() === kl
    || String(m.systemId || '').trim() === k) || null;
}
export function memberStatus() {
  return { active: { l: '現役', c: 'b-ok' }, leave: { l: '休假', c: 'b-warn' }, alumni: { l: '舊團員', c: 'b-grey' } };
}
export function memberAge(m) { return ageFrom(m?.birthday); }
export function memberBirthdayText(m) {
  const p = parseBirthday(m?.birthday);
  if (!p) return '—';
  return p.hasYear ? `${p.iso}（${p.m} 月 ${p.d} 日）` : `${p.m} 月 ${p.d} 日（年份待補）`;
}

export const RSVP = {
  present: { label: '出席', cls: 'b-ok' },
  absent:  { label: '不出席', cls: 'b-danger' },
  late:    { label: '遲到', cls: 'b-warn' },
  early:   { label: '早走', cls: 'b-info' }
};
export function events() { return collection('events'); }
export function eventOf(id) { return find('events', id); }
export function publicEvents() {
  return events().filter(e => e.visibility !== 'exco' && e.status !== 'cancelled')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
export function rsvpCounts(ev) {
  const map = ev?.rsvp || {};
  const roll = ev?.rollcall || {};
  const n = k => Object.values(map).filter(x => (x.status || x) === k).length;
  const rn = k => Object.values(roll).filter(x => (x.status || x) === k).length;
  return {
    present: n('present'), absent: n('absent'), late: n('late'), early: n('early'),
    rollPresent: rn('present'), rollAbsent: rn('absent'), rollLate: rn('late'), rollEarly: rn('early'),
    rsvpTotal: Object.keys(map).length, rollTotal: Object.keys(roll).length
  };
}
export function attendanceStats(memberId) {
  const list = events().filter(e => e.status !== 'cancelled');
  let present = 0, late = 0, early = 0, absent = 0;
  list.forEach(e => {
    const s = (e.rollcall || {})[memberId];
    const st = s?.status || s;
    if (st === 'present') present++;
    else if (st === 'late') late++;
    else if (st === 'early') early++;
    else if (st === 'absent') absent++;
  });
  const marked = present + late + early + absent;
  return { present, late, early, absent, total: list.length, marked,
    rate: marked ? Math.round((present + late + early) / marked * 100) : 0 };
}
export function quizzes() { return collection('quizzes'); }

/* ---------------- 生日 ---------------- */
/** 所有團員依「距離下次生日」排序 */
export function birthdayList({ includeAlumni = false } = {}) {
  return members()
    .filter(m => !includeAlumni ? m.status !== 'alumni' : true)
    .filter(m => parseBirthday(m.birthday))
    .map(m => ({
      member: m, name: m.name, id: m.id, birthday: m.birthday,
      days: daysUntilBirthday(m.birthday), age: ageFrom(m.birthday), turning: turningAge(m.birthday),
      md: parseBirthday(m.birthday).md
    }))
    .sort((a, b) => a.days - b.days);
}

/** 生日喺 n 日內（包括今日） */
export function birthdaysWithin(days = 7, opts) {
  return birthdayList(opts).filter(x => x.days !== null && x.days <= days);
}

/** 今個月生日 */
export function birthdaysThisMonth(month = new Date().getMonth() + 1, opts) {
  const mm = String(month).padStart(2, '0');
  return birthdayList(opts).filter(x => x.md.startsWith(mm)).sort((a, b) => Number(a.md.slice(3)) - Number(b.md.slice(3)));
}

export function birthdaySummary() {
  const s = settings().birthday || {};
  return {
    today: birthdaysWithin(0),
    in7: birthdaysWithin(Number(s.remindDaysBefore || 7)),
    month: birthdaysThisMonth(),
    unknown: members().filter(m => !parseBirthday(m.birthday) && m.status !== 'alumni').map(m => m.name)
  };
}

/* ---------------- 財務 ---------------- */
export function tx() { return collection('transactions'); }
export function claims() { return collection('claims'); }
export function fees() { return collection('fees'); }
export function budgets() { return collection('budgets'); }
export function categories(type) { return (load().categories || {})[type] || []; }
export function methods() { return load().methods || ['現金']; }

export function sumBy(list, type) {
  return list.filter(t => t.type === type).reduce((s, t) => s + (Number(t.amount) || 0), 0);
}
export function balance(list = tx()) { return sumBy(list, 'income') - sumBy(list, 'expense'); }
export function monthStats(key) {
  const list = tx().filter(t => String(t.date).slice(0, 7) === key);
  return { income: sumBy(list, 'income'), expense: sumBy(list, 'expense'), net: balance(list), count: list.length };
}
export function allMonths() {
  const set = new Set(tx().map(t => String(t.date).slice(0, 7)));
  set.add(todayISO().slice(0, 7));
  return [...set].sort().reverse();
}

/**
 * 某財政年度嘅 12 個月（YYYY-MM，按時間順序）。
 * 重點（2026-09-16 團長要求）：**冇紀錄嘅月份都要揀得到** ——
 * 所以呢度係由年度起計「砌」足 12 個月出嚟，唔係由帳目反推。
 */
export function fyMonths(yearKey = currentFY()) {
  const r = yearRange(yearKey);            // 童軍年度（4/1–3/31）
  const out = [];
  let y = Number(String(r.start).slice(0, 4));
  let m = Number(String(r.start).slice(5, 7));
  for (let i = 0; i < 12; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
/** '2026-04' → '2026 年 4 月' */
export function monthText(key) {
  const [y, m] = String(key || '').split('-');
  if (!y || !m) return String(key || '');
  return `${y} 年 ${Number(m)} 月`;
}
/** 某年度 + 月份嘅帳目（月份可以係空） */
export function txOfMonth(yearKey, monthKey) {
  return tx().filter(t => String(t.date).slice(0, 7) === monthKey);
}
/** 逐月統計（12 個月，包括冇紀錄嘅） */
export function fyMonthStats(yearKey = currentFY()) {
  const list = tx().filter(t => inRange(t.date, yearRange(yearKey).start, yearRange(yearKey).end));
  return fyMonths(yearKey).map(k => {
    const rows = list.filter(t => String(t.date).slice(0, 7) === k);
    const income = sumBy(rows, 'income'), expense = sumBy(rows, 'expense');
    return { month: k, label: monthText(k), count: rows.length, income, expense, net: income - expense };
  });
}
export function categoryBreakdown(list, type) {
  const map = {};
  list.filter(t => t.type === type).forEach(t => {
    const k = t.category || '其他';
    map[k] = (map[k] || 0) + (Number(t.amount) || 0);
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}
/* ============================================================
   期初結餘（逐年）
   ------------------------------------------------------------
   每一個財政年度都有自己嘅期初結餘：
     2025-26 期初 8,803.28 → 期末 7,846.64
     2026-27 期初 7,846.64（= 上年度期末）→ 加減本年度收支 = 現在結餘
   所以「期初結餘」唔可以得一個全域數字，否则會把上年度嘅期初
   當成本年度嘅期初（見 2026-09-15 修正）。

   來源優先次序：
     1) settings.openingBalances[年度]      ← 明確填咗嘅（例：2026-27 = 7846.64）
     2) 結轉：全期起點 + 該年度開始前所有帳目   ← 有舊帳就自動計到
   ============================================================ */

/** 全期起點（舊欄位，即「由頭開始嗰陣有幾多錢」） */
export function legacyOpening() { return Number(settings().openingBalance || 0); }

/** 明確設定咗嘅逐年期初結餘表 { '2026-27': 7846.64 } */
export function openingBalances() { return settings().openingBalances || {}; }

/** 而家所屬嘅年度（童軍年度 4/1–3/31；同旅年度標籤一致時最簡單） */
export function currentFY() {
  const s = settings();
  return scoutFYLabel(todayISO(), Number(s.scoutFYStartMonth || 4));
}
export function currentFYRange() {
  const s = settings();
  return scoutFYRange(currentFY(), Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1));
}
/** 上一個年度標籤（例：2026-27 → 2025-26） */
export function prevFYKey(yearKey = currentFY()) {
  const y = Number(String(yearKey).split('-')[0]);
  return `${y - 1}-${pad2y(y % 100)}`;
}
function pad2y(n) { return String(n).padStart(2, '0'); }

/** 結轉：某年度開始之前嘅累計（全期起點 + 之前所有帳目） */
export function carriedForward(startISO) {
  const before = tx().filter(t => String(t.date).slice(0, 10) < startISO);
  return legacyOpening() + balance(before);
}
/** 某段期間嘅結餘（全期起點 + 該日之前所有帳目） */
export function balanceAt(startISO) { return carriedForward(startISO); }

/**
 * 某年度嘅期初結餘。
 * @param {string} yearKey 例 '2026-27'（預設＝本年度）
 * @param {object} [range] 該年度範圍（冇傳就用童軍年度計）
 */
export function openingOf(yearKey = currentFY(), range = null) {
  const map = openingBalances();
  if (map[yearKey] !== undefined && map[yearKey] !== null && map[yearKey] !== '') {
    return { amount: Number(map[yearKey]), year: yearKey, explicit: true, date: (range || yearRange(yearKey)).start };
  }
  const r = range || yearRange(yearKey);
  return { amount: carriedForward(r.start), year: yearKey, explicit: false, date: r.start };
}
/** 由年度標籤攞範圍（童軍年度） */
export function yearRange(yearKey) {
  const s = settings();
  return scoutFYRange(yearKey, Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1));
}

/** 兼容舊寫法：而家回傳「本年度」嘅期初結餘（唔再係全域單一數字） */
export function openingBalance() {
  const o = openingOf();
  return { amount: o.amount, date: o.date, year: o.year, explicit: o.explicit };
}

/* ---------- 現在結餘（首頁顯示用） ----------
   現在結餘 = **本年度**期初結餘 + **本年度**收入 − **本年度**支出。
   上年度嘅帳目已經計入「上年度期末 → 本年度期初」，唔會重複加。 */
export function currentBalance() {
  const r = currentFYRange();
  const o = openingOf(r.key, r);
  const rows = tx().filter(t => inRange(t.date, r.start, r.end));
  return o.amount + balance(rows);
}
/** 結餘拆解（本年度），用嚟顯示同解釋負數 */
export function balanceBreakdown() {
  const s = settings();
  const r = currentFYRange();
  const list = tx().filter(t => inRange(t.date, r.start, r.end));
  const inc = sumBy(list, 'income');
  const exp = sumBy(list, 'expense');
  const o = openingOf(r.key, r);
  const now = o.amount + inc - exp;
  const prevKey = prevFYKey(r.key);
  const prevRange = yearRange(prevKey);
  const prevRows = tx().filter(t => inRange(t.date, prevRange.start, prevRange.end));
  const prev = openingOf(prevKey, prevRange);
  const ref = load().reference || {};
  const refOpen = Number(ref.openingBalance || 0);
  const refInc = sumBy(ref.transactions || [], 'income');
  const refExp = sumBy(ref.transactions || [], 'expense');
  const refClose = ref.check?.closing ?? (refOpen + refInc - refExp);
  return {
    year: r.key, range: r,
    opening: o.amount, openingDate: o.date, openingExplicit: o.explicit,
    income: inc, expense: exp, now, count: list.length,
    hasOpening: o.explicit || legacyOpening() !== 0,
    /** 上年度（用嚟對數：上年度期末應該等於本年度期初） */
    prevYear: prevKey, prevOpening: prev.amount,
    prevClosing: prev.amount + balance(prevRows), prevCount: prevRows.length,
    /** 舊帳參考（你嘅 Google Sheet 分頁） */
    referenceOpening: refOpen, referenceClosing: Number(refClose) || 0,
    referenceYear: refYearKey(ref),
    likelyMissingOpening: now < 0 && !o.explicit && legacyOpening() === 0 && refOpen > 0,
    /** 有舊帳參考但未入帳 → 提示去匯入 */
    hasUnimportedReference: (ref.transactions || []).length > 0 && tx().length === 0,
    /** 本年度期初 同 舊帳期末 唔同 → 提示核對 */
    openingMismatch: o.explicit && refOpen > 0 && Math.abs(o.amount - Number(refClose)) > 0.005,
    scoutFYStartMonth: Number(s.scoutFYStartMonth || 4)
  };
}
/** 由參考資料推算佢屬於邊個年度（由帳目日期計，唔靠分頁名） */
export function refYearKey(ref = load().reference || {}) {
  const dates = (ref.transactions || []).map(t => String(t.date).slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return '';
  return scoutFYLabel(dates[dates.length - 1], Number(settings().scoutFYStartMonth || 4));
}
export function pendingClaims() { return claims().filter(c => (c.status || 'pending') === 'pending'); }

/* 團費 */
export function feeSummary(list) {
  /* 預設用收款表（排除領袖／免收），唔好用 raw fees 筆數（會把領袖都計入） */
  if (!list) {
    const st = feeStats();
    return {
      total: st.total, paidCount: st.paidCount, unpaidCount: st.unpaidCount,
      collected: st.collected, outstanding: st.outstanding, expected: st.expected, rate: st.rate
    };
  }
  const paid = list.filter(f => f.paid && !feeExempt(member(f.memberId)));
  const unpaid = list.filter(f => !f.paid && !feeExempt(member(f.memberId)));
  const n = paid.length + unpaid.length;
  return {
    total: n, paidCount: paid.length, unpaidCount: unpaid.length,
    collected: paid.reduce((s, f) => s + (Number(f.amount) || 0), 0),
    outstanding: unpaid.reduce((s, f) => s + (Number(f.amount) || 0), 0),
    expected: [...paid, ...unpaid].reduce((s, f) => s + (Number(f.amount) || 0), 0),
    rate: n ? Math.round(paid.length / n * 100) : 0
  };
}
/**
 * 免收團費？
 *   1) 領袖（身份 = leader）→ **一律免收團費**（2026-09-16 團長要求）
 *   2) 個別成員可以喺「用戶」頁剔「免收團費」（例：榮譽會員、指導員）
 *   3) m.feeExempt === false 可以明確推翻（例：有位領袖要交返）
 */
export function feeExempt(m) {
  if (!m) return false;
  if (m.feeExempt === true) return true;
  if (m.feeExempt === false) return false;
  return identityOf(m) === 'leader';
}
/** 免收團費名單（用嚟喺團費頁交代點解某人唔喺表入面） */
export function feeExemptList() {
  return members().filter(m => m.status !== 'alumni' && feeExempt(m));
}

export function overdueFees() {
  const today = todayISO();
  return fees().filter(f => !f.paid && f.due && f.due < today && !feeExempt(member(f.memberId)));
}

/** 進度系統唔計：領袖、管理員、舊團員 */
export function progressIgnored(m) {
  if (!m) return true;
  if (m.status === 'alumni') return true;
  if (identityOf(m) === 'leader') return true;
  const t = `${m.role || ''} ${m.name || ''} ${(m.tags || []).join(' ')}`;
  return /管理員|超管|admin|系統管理員/i.test(t);
}
export function progressRoster(list = members()) {
  return list.filter(m => !progressIgnored(m));
}

/* ---------- 團費（金額可改，唔係寫死） ---------- */
/** 標準團費（每位團員每年）—— v2.4.0 起支援**逐年**設定（feePerYearMap）：
 *  每年喺「財務 → 設定」可以改當年團費；冇填嘅年份**默認同上一個有設定嘅年度相同**。
 *  settings.feePerYear 仲係「總預設」（舊資料兼容），map 優先。 */
export function feeForYear(period = '') {
  const s = settings();
  const map = s.feePerYearMap || {};
  const p = String(period || '').trim();
  if (p && map[p] != null && map[p] !== '') return Number(map[p]);
  if (p) {
    /* 向過去行，最多 15 年：默認同上年相同（上上年…） */
    const m = /^(\d{4})/.exec(p);
    if (m) {
      const y0 = Number(m[1]);
      for (let i = 1; i <= 15; i++) {
        const yy = `${y0 - i}-${String(y0 - i + 1).slice(-2)}`;
        if (map[yy] != null && map[yy] !== '') return Number(map[yy]);
      }
    }
  }
  return Number(s.feePerYear ?? 360);
}
export function standardFee(period = '') {
  return feeForYear(period || feePeriodOf(todayISO()));
}
/** 海外／優惠團費（預設標準嘅 1/4） */
export function overseasFee() {
  const v = settings().feeOverseas;
  if (v === undefined || v === null || v === '') return Math.round(standardFee() / 4);
  return Number(v);
}
/** 團費預設到期日（例：年度首年 9 月 30 日） */
export function defaultFeeDue(period = feePeriodOf(todayISO())) {
  const tpl = settings().feeDueTemplate;
  const y = String(period).slice(0, 4);
  return (tpl || `${y}-09-30`).replace(/[{]y[}]/g, y);
}

/** 由日期推算團費期別（跟童軍年度，例如 2025-12-07 → 2025-26） */
export function feePeriodOf(dateISO) {
  return scoutFYLabel(dateISO || todayISO(), Number(settings().scoutFYStartMonth || 4));
}
/** 所有出現過嘅期別（由新到舊），並確保「本年度」一定在列 */
export function feePeriods() {
  const list = [...new Set(fees().map(f => f.period).filter(Boolean))];
  const cur = feePeriodOf(todayISO());
  if (!list.includes(cur)) list.push(cur);
  return list.sort().reverse();
}
/** 某位團員某期嘅收費紀錄 */
export function feeOf(memberId, period) {
  return fees().find(f => f.memberId === memberId && f.period === period) || null;
}
/** 團費收款表：每位（非舊團員、非免收）團員 × 某一期 */
export function feeGrid(period = feePeriodOf(todayISO()), { includeAlumni = false } = {}) {
  const fallback = standardFee(period);   // v2.4.0：跟嗰期嘅年度團費（冇設定就跟上年）
  return members()
    .filter(m => (includeAlumni || m.status !== 'alumni') && !feeExempt(m))
    .map(m => {
      const f = feeOf(m.id, period);
      return {
        member: m, id: f?.id || null,
        amount: Number(f?.amount ?? fallback),
        paid: !!f?.paid, paidDate: f?.paidDate || '', method: f?.method || '',
        ref: f?.ref || '', due: f?.due || '', note: f?.note || '',
        txId: f?.txId || '', exists: !!f
      };
    })
    .sort((a, b) => (a.paid === b.paid ? String(a.member.name).localeCompare(String(b.member.name), 'zh-Hant') : a.paid ? 1 : -1));
}
/** 團費統計（某人／某期） */
export function feeStats(period = feePeriodOf(todayISO())) {
  const rows = feeGrid(period);
  const paid = rows.filter(r => r.paid), unpaid = rows.filter(r => !r.paid);
  const today = todayISO();
  return {
    period, rows, total: rows.length, paidCount: paid.length, unpaidCount: unpaid.length,
    collected: paid.reduce((s, r) => s + r.amount, 0),
    outstanding: unpaid.reduce((s, r) => s + r.amount, 0),
    expected: rows.reduce((s, r) => s + r.amount, 0),
    rate: rows.length ? Math.round(paid.length / rows.length * 100) : 0,
    overdue: unpaid.filter(r => r.due && r.due < today).length,
    noRecord: rows.filter(r => !r.exists).length
  };
}
/** 喺文字入面搵吓有冇團員名（用嚟由「曉莉 團費」對應到團員） */
export function matchMemberByName(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const list = members();
  // 1) 全名包含喺文字入面
  const full = list.find(m => m.name && t.includes(m.name));
  if (full) return full;
  // 2) 文字本身係花名／名字一部分（例：大文 → 陳大文、小明 → 李小明）
  const short = list
    .filter(m => m.name && m.name.length >= 3 && t.length >= 2 && m.name.includes(t))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (short) return short;
  // 3) 英文名
  return list.find(m => m.eng && t.toLowerCase().includes(String(m.eng).toLowerCase())) || null;
}

/* ---------------- 物資 ---------------- */
export function invItems() { return collection('invItems'); }
export function invLoans() { return collection('invLoans'); }
export function invAudits() { return collection('invAudits'); }
export function invItem(id) { return find('invItems', id); }
export function invCategories() { return settings().inventory?.categories || []; }

const OPEN_LOAN = ['approved', 'out'];
export function itemTotals(itemId) {
  const item = invItem(itemId);
  if (!item) return { total: 0, adjusted: 0, out: 0, reserved: 0, available: 0 };
  const adjusted = Number(item.total || 0) + invAudits()
    .filter(a => a.itemId === itemId)
    .reduce((s, a) => s + Number(a.delta || 0), 0);
  const out = invLoans().filter(l => l.itemId === itemId && OPEN_LOAN.includes(l.status))
    .reduce((s, l) => s + Number(l.qty || 0), 0);
  const reserved = invLoans().filter(l => l.itemId === itemId && l.status === 'requested')
    .reduce((s, l) => s + Number(l.qty || 0), 0);
  return { total: Number(item.total || 0), adjusted, out, reserved, available: adjusted - out };
}
export function availableQty(itemId) { return itemTotals(itemId).available; }
export function nextItemCode() {
  const db = load();
  const n = invItems().length + 1;
  return db.invNextCode && !invItems().some(i => i.code === db.invNextCode)
    ? db.invNextCode
    : 'G-' + String(n).padStart(3, '0');
}
export function loansByStatus(status) { return invLoans().filter(l => l.status === status); }
export function pendingLoans() { return invLoans().filter(l => l.status === 'requested'); }
export function activeLoans() { return invLoans().filter(l => OPEN_LOAN.includes(l.status)); }
export function overdueLoans() {
  const t = todayISO();
  return invLoans().filter(l => OPEN_LOAN.includes(l.status) && l.dueDate && l.dueDate < t);
}
export function loanStatus() {
  return {
    requested: { l: '待批核', c: 'b-warn' },
    approved:  { l: '已批核（待取）', c: 'b-info' },
    out:       { l: '借出中', c: 'b-brand' },
    returned:  { l: '已歸還', c: 'b-ok' },
    rejected:  { l: '已拒絕', c: 'b-danger' },
    cancelled: { l: '已取消', c: 'b-grey' }
  };
}
export function stockSummary() {
  const items = invItems();
  return {
    kinds: items.length,
    units: items.reduce((s, i) => s + Number(i.total || 0), 0),
    out: activeLoans().reduce((s, l) => s + Number(l.qty || 0), 0),
    pending: pendingLoans().length,
    overdue: overdueLoans().length,
    low: items.filter(i => itemTotals(i.id).available <= 0)
  };
}

/* ---------------- 團章 ---------------- */
export function constitution() { return load().constitution || {}; }
export function articleCount(c = constitution()) {
  return (c.chapters || []).reduce((s, ch) => s + (ch.articles?.length || 0) + (ch.articles || []).reduce((t, a) => t + (a.items?.length || 0), 0), 0);
}

/* ---------------- 待辦 / 日程 ---------------- */
export function openActions() {
  const out = [];
  collection('meetings').forEach(m => {
    (m.decisions || []).forEach(d => { if (!d.done) out.push({ ...d, meetingId: m.id, meetingTitle: m.title }); });
  });
  return out.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
}
export function upcomingMeetings(n = 4) {
  const today = todayISO();
  return collection('meetings')
    .filter(m => String(m.date).slice(0, 10) >= today && m.status !== 'done' && m.status !== 'cancelled')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, n);
}
export function pendingMeetings() { return collection('meetings').filter(m => m.status === 'pending'); }

/* ---------------- 通知中心（儀表板用） ---------------- */
export function notices() {
  const out = [];
  const b = birthdaySummary();
  b.today.forEach(x => out.push({ kind: 'birthday', level: 'ok', text: `今日係 ${x.name} 生日 🎂`, link: '#/members/birthdays' }));
  b.in7.filter(x => x.days > 0).forEach(x => out.push({
    kind: 'birthday', level: 'warn',
    text: `${x.name} ${x.days} 日後生日（${Number(x.md.slice(0, 2))} 月 ${Number(x.md.slice(3))} 日${x.turning ? `，將滿 ${x.turning} 歲` : ''}）`,
    link: '#/members/birthdays'
  }));
  overdueFees().forEach(f => out.push({ kind: 'fee', level: 'danger', text: `團費逾期未收：${memberName(f.memberId)}（${money(f.amount)}，到期 ${f.due}）`, link: '#/finance/fees' }));
  pendingClaims().forEach(c => out.push({ kind: 'claim', level: 'info', text: `收支申報待批：${c.byName || ''} ${c.item}（${money(c.amount)}）`, link: '#/finance/claims' }));
  pendingLoans().forEach(l => out.push({ kind: 'loan', level: 'info', text: `物資借用待批：${l.borrowerName || ''} 借 ${invItem(l.itemId)?.name || ''} ×${l.qty}`, link: '#/inventory/loans' }));
  overdueLoans().forEach(l => out.push({ kind: 'loan', level: 'danger', text: `物資逾期未還：${l.borrowerName || ''} · ${invItem(l.itemId)?.name || ''}（應還 ${l.dueDate}）`, link: '#/inventory/loans' }));
  openActions().filter(a => a.due && a.due < todayISO()).forEach(a => out.push({ kind: 'action', level: 'warn', text: `會議行動逾期：${a.text}`, link: '#/meetings' }));
  // 每年一次：AGM 日期（旅財政年度起點）未確認
  const fy = unitFYOf(todayISO(), settings().agmDates || []);
  if (agmIsDefault(fy.agmYear, settings().agmDates || [])) {
    out.push({ kind: 'agm', level: 'info',
      text: `${fy.agmYear} 年 AGM 日期未確認（現用 ${fy.start}）—— 旅財政年度由此起計，請逐年輸入實際日期`,
      link: '#/finance/reports' });
  }
  return out;
}
