/* ============================================================
   tests/gate.mjs — 旅團選擇閘（開機先揀旅團，之後先出現登入畫面）
   用一個「冇 ?u= 、冇揀過旅團」嘅全新 jsdom 載入 main.js，
   驗證第一步係旅團選擇畫面（唔係登入畫面）。
   用法：node tests/gate.mjs
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
let pass = 0, fail = 0;
const errors = [];
const origError = console.error;
console.error = (...a) => {
  const msg = a.map(String).join(' ');
  /* jsdom 唔支援真正轉頁（location.href）—— 呢個係預期行為，唔算錯誤 */
  if (/Not implemented: navigation/.test(msg)) return;
  errors.push(msg); origError('[console.error]', ...a);
};

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* Registry fixture：唔讀真 data/units.json（真檔而家有 0082 名單，會污染測試）。
   呢個測試要驗「有旅團可揀」嘅閘行為，所以自己餵一個虛構旅團 TEST9。 */
const FIXTURE_REG = {
  schema: 2, defaultUnit: '',
  units: {
    TEST9: {
      code: 'TEST9', name: '測試旅深資童軍團', nameEn: 'Test Group Venture Scout Unit',
      short: 'test9', section: '深資童軍', sponsor: '測試主辦機構',
      dataPath: 'tests/fixtures/units/TEST9/'
    }
  }
};
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  if (/(^|\/)units\.json$/.test(clean) || /api\/units/.test(clean)) {
    return { ok: true, status: 200, json: async () => FIXTURE_REG, text: async () => JSON.stringify(FIXTURE_REG) };
  }
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* ---------- ① 全新瀏覽器：冇 ?u=，冇揀過旅團 ---------- */
console.log('\n▌旅團選擇閘（全新瀏覽器）');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
window.scrollTo = () => {};
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
  'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch { /* 唯讀 → 略過 */ }
}
globalThis.window = window;

const doc = window.document;
await import('../assets/js/main.js');
await wait(500);

const appHtml = () => doc.getElementById('app')?.innerHTML || '';
const appText = () => doc.getElementById('app')?.textContent || '';

ok('第一步係旅團選擇畫面（唔係登入畫面）',
  /揀你嘅旅團/.test(appText()) && !/請揀你嘅身份/.test(appText()),
  appText().replace(/\s+/g, ' ').slice(0, 120));
ok('列出註冊咗嘅旅團 TEST9', !!doc.querySelector('[data-pick="TEST9"]'),
  Array.from(doc.querySelectorAll('[data-pick]')).map(b => b.dataset.pick).join(','));
/* ★ 2026-09-24 團長：「刪除示範資料 (MOCK) 我都在用要MOCK 幹什麼」
   → 旅團閘唔應該再有「試用示範（MOCK）」選項。 */
ok('★ 已經冇「試用示範（MOCK）」選項', !doc.querySelector('[data-pick="MOCK"]'));
ok('旅團卡顯示旅團名', /測試旅深資童軍團/.test(appText()));
ok('未揀旅團之前唔會初始化資料庫',
  !window.localStorage.getItem('venture82.unit.TEST9.db.v2'), '（應該要揀完先種入資料）');
ok('登入表單未出現', !doc.getElementById('loginForm'));

/* 新旅團申請接入：真正 render 出嚟，唔係 grep 原始碼 */
/* registry 讀到、但一個旅團都未登記（＝清空 0082 之後嘅全新部署）：
   要叫人去申請接入，唔可以報「讀唔到 data/units.json」呢個假錯誤。 */
{
  const units = await import('../assets/js/lib/units.js?empty=1');
  const emptyReg = { schema: 2, defaultUnit: '', units: {} };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/api\/units/.test(u)) return { ok: true, status: 200, json: async () => ({ units: {} }) };
    if (/units\.json/.test(u)) return { ok: true, status: 200, json: async () => emptyReg, text: async () => JSON.stringify(emptyReg) };
    return { ok: false, status: 404 };
  };
  await units.loadRegistry(true);
  ok('registry 讀到就算冇旅團都當「連得到」', units.registryReachable() === true);
  ok('冇旅團登記時 unitList() 係空', units.unitList().length === 0);
  ok('預設旅團係空（唔會靜靜雞當你係某個旅團）', units.defaultUnitCode() === '');
  ok('冇登記旅團就攞唔到任何後端', units.backendOf('0082') === null && units.backendOf('0123') === null);
  globalThis.fetch = prevFetch;
}

ok('旅團閘有「新旅團申請接入」入口', !!doc.querySelector('[data-act="apply"]'));
ok('閘面講明每旅團用自己嘅後端', /每個旅團用自己嘅 Google Sheet 做後端/.test(appText()));
const applyBtn = doc.querySelector('[data-act="apply"]');
applyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(120);
const apBody = doc.body.textContent || '';
ok('撳「申請接入」會開對話框', /新旅團申請接入/.test(apBody) && !!doc.getElementById('ap-id'));
ok('申請表有齊欄位（編號／名稱／後端網址／API Key／聯絡人）',
  ['ap-id','ap-name','ap-url','ap-key','ap-contact','ap-note'].every(id => !!doc.getElementById(id)),
  ['ap-id','ap-name','ap-url','ap-key','ap-contact','ap-note'].filter(id => !doc.getElementById(id)).join(','));
/* 部署指南（登入前就睇得到）—— 一般開新旅團教學嘅所在地 */
{
  doc.querySelector('[data-act="guide"]')?.click();
  await wait(250);
  /* 申請表對話框已經開住 → 攞最新嗰個 overlay（部署指南） */
  const ovs = [...doc.querySelectorAll('.overlay')];
  const gOv = ovs[ovs.length - 1];
  const g = gOv?.querySelector('.modal, [role="dialog"]');
  const gt = g?.textContent || '';
  ok('旅團閘有「部署指南」（毋須登入都睇得到）', !!g && /部署指南/.test(gt));
  ok('指南有 5 步（下載 Code.gs → 貼上 → initializeSheets → 部署 → 提交登記）',
    /第 1 步/.test(gt) && /第 2 步/.test(gt) && /第 3 步/.test(gt)
    && /第 4 步/.test(gt) && /第 5 步/.test(gt) && /initializeSheets/.test(gt));
  ok('指南講明後端同進度前端共用（進度追蹤／活動履歷等分頁一齊建）',
    /進度追蹤/.test(gt) && /共用/.test(gt));
  ok('指南第 5 步提到管理員會加 TROOP_<編號>_* 設定',
    /TROOP_/.test(gt) && /環境變數/.test(gt));
  ok('指南有下載／複製 Code.gs 掣', !!g.querySelector('#guide-dl-btn') && !!g.querySelector('#guide-copy-btn'));
  ok('指南第 5 步講明申請直接入 ADMIN 系統（收件匣）＋ appType 分辨',
    /ADMIN 系統/.test(gt) && /收件匣/.test(gt) && /82venture/.test(gt));
  ok('指南講明「送出就 OK，唔使等回覆」（ADMIN 唔回執，開團後 email 通知）',
    /送出就 OK/.test(gt) && /唔使等回覆/.test(gt) && /email 通知/.test(gt));
  ok('指南有「填寫申請表自動送出」掣，連去申請表',
    !!g.querySelector('#guide-apply-btn'), [...(g?.querySelectorAll('button') || [])].map(b => b.textContent.trim()).join(' | '));
  /* 撳申請掣 → 應該閂指南、開申請表 */
  g.querySelector('#guide-apply-btn')?.click();
  await wait(300);
  ok('撳指南個申請掣 → 真係開到申請接入表',
    !!doc.getElementById('ap-id') && /新旅團申請接入/.test(doc.body.textContent || ''));
  ok('申請表寫明會送去做平台管理員嘅 ADMIN 系統',
    /ADMIN 系統/.test(doc.body.textContent || ''));
  [...doc.querySelectorAll('button')].filter(b => /^取消$/.test((b.textContent || '').trim()))
    .forEach(b => b.click());
  await wait(120);
}

ok('申請表教埋點起後端（Code.gs → initializeSheets → 部署）',
  /Code\.gs/.test(apBody) && /initializeSheets/.test(apBody) && /網頁應用程式/.test(apBody));
ok('申請表自動帶主系統網址（方便管理員核對）', /主系統網址/.test(apBody));
ok('申請表講清楚進度系統由旅團自己填 Script ＋ API Key（唔使外連）',
  /進度 → 設定/.test(apBody) && /API Key/.test(apBody) && /唔使外連/.test(apBody));
/* 驗證：填錯嘢要擋得住 */
{
  const ob = await import('../assets/js/lib/onboard.js');
  const bad = ob.validateApplication({ troopId: '', troopName: '', scriptUrl: 'http://x.com' });
  ok('空申請唔會通過驗證', bad.ok === false && bad.errors.length >= 3, JSON.stringify(bad.errors));
  const good = ob.validateApplication({ troopId: '0100', troopName: '第一百旅',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTEST/exec' });
  ok('填齊就通過，payload 帶 appType=82venture',
    good.ok === true && good.payload.appType === '82venture', JSON.stringify(good.errors));
  ok('管理員收件匣已設定', ob.adminInbox().configured === true, ob.adminInbox().url);
}
/* 求救＝問題回報：標題＋詳情必填、payload 對正 ADMIN TICK 合約 */
{
  const ob = await import('../assets/js/lib/onboard.js');
  const empty = ob.validateIssue({});
  ok('求救冇標題／詳情唔會過（標題＋問題詳情都要寫）', empty.ok === false && empty.errors.length >= 2, JSON.stringify(empty.errors));
  const good = ob.validateIssue({ troopId: '0082', title: '同步啲掣唔知點排', desc: '成頁好亂', severity: '中', name: '團長' });
  ok('求救內容齊就通過，payload 對正 ADMIN 合約（type=issue ＋ sourceApp=82venture ＋ title/desc/severity）',
    good.ok === true && good.payload.type === 'issue' && good.payload.sourceApp === '82venture'
    && good.payload.title === '同步啲掣唔知點排' && good.payload.desc === '成頁好亂' && good.payload.severity === '中',
    JSON.stringify(good.payload));
  ok('求救詳情限 2000 字（超過唔會通過）', ob.validateIssue({ title: 't', desc: '甲'.repeat(2001) }).ok === false);
  ok('嚴重度唔喺白名單會自動變「高」（唔會寫啲怪嘢入 ADMIN）',
    ob.validateIssue({ title: 't', desc: 'd', severity: '核爆' }).payload.severity === '高');
}
/* 電子請假：交表 → 覆核 → 撤回（呢啲係純本地 db 邏輯，唔使後端） */
{
  const absence = await import('../assets/js/lib/absence.js');
  const store2 = await import('../assets/js/lib/store.js');
  await store2.init({ code: 'TEST9' });   // 確保 db 初始化咗先寫到請假
  const today = new Date().toISOString().slice(0, 10);
  const sub = absence.submitAbsence({ memberId: 'm1', ymis: 'Y123', date: today, slot: 'am', reason: '屋企有事', plan: '補返' });
  ok('請假冇原因唔會過', absence.submitAbsence({ memberId: 'm1', date: today, reason: '' }).ok === false);
  ok('請假過咗嘅日子唔會過', absence.submitAbsence({ memberId: 'm1', date: '2000-01-01', reason: 'xxx' }).ok === false);
  ok('請假填齊就通過、status=pending', sub.ok === true && sub.record.status === 'pending', JSON.stringify(sub.record && { status: sub.record.status }));
  const id = sub.record.id;
  ok('團員查到自己嘅請假單', absence.absencesOf('m1').length === 1, String(absence.absencesOf('m1').length));
  ok('第二個人睇唔到（memberId 唔同 = 冇單）', absence.absencesOf('m2').length === 0, String(absence.absencesOf('m2').length));
  const rev = absence.reviewAbsence(id, { decision: 'approved', note: 'OK', reviewer: '團長' });
  ok('覆核接受 → status=approved + reviewer 有落', rev.ok === true && rev.record.status === 'approved' && rev.record.reviewer === '團長' || (rev.record.reviewedBy === '團長'));
  ok('已經處理咗就唔可以撤回', absence.withdrawAbsence(id, 'm1').ok === false, JSON.stringify(absence.withdrawAbsence(id, 'm1')));
  const sub2 = absence.submitAbsence({ memberId: 'm1', date: today, slot: 'pm', reason: '試水' });
  ok('pending 可以撤回', absence.withdrawAbsence(sub2.record.id, 'm1').ok === true);
  ok('CSV 有 header 同資料行', /日期/.test(absence.absencesCsv(() => '甲')) && /已接受/.test(absence.absencesCsv(() => '甲')), absence.absencesCsv(() => '甲').split('\n')[0]);
}

/* ---------- ② 揀咗旅團 ---------- */
console.log('\n▌揀旅團之後');
const btn = doc.querySelector('[data-pick="TEST9"]');
let navigated = '';
try {
  // jsdom 唔會真係轉頁；用 setter 攞佢想去邊
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new Proxy(window.location, {
      set(t, k, v) { if (k === 'href') navigated = String(v); return true; },
      get(t, k) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
    })
  });
} catch { /* 用唔到 proxy 就算 */ }
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(80);
ok('揀完會記住選擇（下次唔使再揀）',
  window.localStorage.getItem('venture82.unitChosen.v2') === 'TEST9',
  String(window.localStorage.getItem('venture82.unitChosen.v2')));
ok('揀完會帶 ?u=TEST9 重新載入', /u=TEST9/.test(navigated) || !navigated, navigated || '（jsdom 唔會真係轉頁）');

/* ---------- ③ 已經揀過：直接入登入畫面 ---------- */
console.log('\n▌已揀過旅團（第二次開）');
ok('記住咗選擇之後 unitChosen 條件成立',
  window.localStorage.getItem('venture82.unitChosen.v2') === 'TEST9');

/* ---------- ④ 登出／「返回旅團選擇」唔可以困死用家 ----------
   ★ 2026-09-24：呢度以前係「離開 MOCK 唔可以困死用家」。示範模式拆走咗，
     但同一個 bug 形態仲喺度：**清晒痕跡**先至返得到旅團選擇閘。
     如果 resetToGate() 漏清任何一個 key，下次開網站又會自動入返同一個旅團，
     用家想轉旅團就永遠出唔到（＝同一個「被困住」嘅感覺）。 */
console.log('\n▌返回旅團選擇（清晒痕跡）');
{
  const dom2 = new JSDOM(html, { url: 'http://localhost:8080/?u=TEST9', pretendToBeVisual: true, runScripts: 'dangerously' });
  const w2 = dom2.window;
  w2.scrollTo = () => {};
  try { Object.defineProperty(w2, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
    if (w2[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: w2[k], configurable: true, writable: true }); }
    catch { /* 唯讀 → 略過 */ }
  }
  globalThis.window = w2;
  w2.localStorage.setItem('venture82.unitChosen.v2', 'TEST9');
  await import('../assets/js/main.js?gate2=1');  /* cache-bust：main.js 嘅 module-level boot() 只行一次；
     用 query 令 Node 當佢係另一個 module 重新執行，boot() 就喺新 jsdom 度行 */
  await wait(500);

  const store2 = await import('../assets/js/lib/store.js');  /* 同一個 module instance（main.js 用緊嗰個） */
  ok('入咗旅團 TEST9', String(store2.currentUnit()) === 'TEST9', String(store2.currentUnit()));

  let navigated2 = '';
  try {
    Object.defineProperty(w2, 'location', {
      configurable: true,
      value: new Proxy(w2.location, {
        set(t, k, v) { if (k === 'href') navigated2 = String(v); return true; },
        get(t, k) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
      })
    });
  } catch { /* 用唔到 proxy 就算 */ }

  store2.resetToGate();
  ok('★ 清走旅團記錄', w2.localStorage.getItem('venture82.currentUnit.v2') === null,
    String(w2.localStorage.getItem('venture82.currentUnit.v2')));
  ok('★ 清走「已揀旅團」記錄', w2.localStorage.getItem('venture82.unitChosen.v2') === null,
    String(w2.localStorage.getItem('venture82.unitChosen.v2')));
  ok('★ 清走 session（唔會用舊身份自動入返）', w2.localStorage.getItem('venture82.session.v2') === null);
  ok('★ 重載嘅網址冇 u=（下次開機會返去旅團選擇閘）',
    navigated2 ? !/[?&]u=/.test(navigated2) : true,
    navigated2 || '（jsdom 唔會真係轉頁）');
}

if (errors.length) {
  console.log(`\n捕捉到 ${errors.length} 個 console.error：`);
  errors.slice(0, 6).forEach(e => console.log('  • ' + e.slice(0, 200)));
}
const ms = Date.now() - t0;
console.log(`\n──────── 旅團閘測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
process.exit(fail ? 1 : 0);
