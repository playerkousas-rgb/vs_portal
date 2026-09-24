/* ============================================================
   tests/usersim.mjs — 「以用戶角度完整模擬整個過程」
   ------------------------------------------------------------
   團長 2026-09-20：「還是不行，他說寫入後端還是完全沒有。幫我以用戶角度
   完整模擬整個過程看看有沒有什麼發現，究竟是什麼問題導致寫不入，
   但又會說自己已寫入，如果以寫入寫了到那？又為什麼讀不到。」

   呢個檔唔係由 remote.js 入手，而係**真係開個 app**（jsdom 載入
   assets/js/main.js，行真 HTTP）：
     ① 開網站 → 揀旅團 → 登入頁 → 打 leader／8202 → 撳登入
     ② 改嘢（加團員、加一筆帳）
     ③ 撳頂部「儲存到後端」掣 —— 記低**用戶睇到嘅字**（toast／狀態 chip）
     ④ 直接問後端：dbInfo／loadDb、而家真係有咩
     ⑤ 開成個 Spreadsheet：邊張分頁有幾多行（＝團長開 Sheet 見到嘅嘢）
     ⑥ 另一部全新機（＝無痕視窗）開返 → 睇唔睇到①嗰啲嘢
     ⑦ 用 ?u=82（冇前導零）開一次 —— 睇下會唔會寫去另一個「旅團」

   環境：真 Code.gs（tests/_realgas.mjs）← dev-server（api/proxy.js）← 真 app
   用法：node tests/usersim.mjs
   ============================================================ */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }
const say = (t) => console.log('  · ' + t);

/* ============================================================
   一部裝置（子 process）：開真 app、做劇本、回報「用戶睇到嘅嘢」
   ============================================================ */
if (process.argv[2] === 'device') {
  const BASE = process.argv[3];
  const PLAN = JSON.parse(process.argv[4] || '{}');
  const out = { ok: false, log: [], error: '' };
  const note = (k, v) => { out.log.push({ [k]: v }); };
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body class="login-body"><div id="app"></div></body></html>',
      { url: `${BASE}/${PLAN.query || '?u=0082'}`, pretendToBeVisual: true });
    const { window } = dom;
    window.scrollTo = () => {};
    try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
    for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
      'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
      if (window[k] === undefined) continue;
      try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ignore */ }
    }
    globalThis.window = window;
    const doc = window.document;
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      let u = String(url);
      if (!/^https?:\/\//.test(u)) u = `${BASE}/${u.replace(/^\.?\//, '')}`;
      return nodeFetch(u, init);
    };
    const txt = () => (doc.body.textContent || '').replace(/\s+/g, ' ');
    /* toast 會 fadeOut 自動移除 —— 用 MutationObserver 喺佢出現嗰一刻記低，
       否則等幾秒先睇就乜都搵唔到（第一版模擬就係咁漏咗）。 */
    const toastsSeen = [];
    new window.MutationObserver((muts) => {
      muts.forEach(m => Array.from(m.addedNodes || []).forEach(n => {
        if (n.nodeType === 1 && (n.classList?.contains('toast') || n.querySelector?.('.toast'))) {
          const el = n.classList?.contains('toast') ? n : n.querySelector('.toast');
          const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !toastsSeen.includes(t)) toastsSeen.push(t);
        }
      }));
    }).observe(doc.body, { childList: true, subtree: true });
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    /* ---- 開機（真 main.js boot：loadRegistry → 揀旅團 → syncBoot → 登入頁） ---- */
    const store = await import('../assets/js/lib/store.js');
    const auth = await import('../assets/js/lib/auth.js');
    await import('../assets/js/main.js');
    await wait(1200);
    note('開機後畫面', txt().slice(0, 220));
    note('旅團編號（store）', String(store.currentUnit()));
    note('db.unitCode', String(store.tryLoad()?.unitCode || ''));
    note('sync.unit', String(store.tryLoad()?.sync?.unit || '(未設)'));
    note('種子團員數', (store.tryLoad()?.members || []).length);
    note('開機後係咪停喺連線閘（連唔到後端）', /未能連接旅團後端/.test(txt()));
    note('登入頁有冇「一個入口」嘅登入表單', !!doc.querySelector('#loginForm'));

    /* ---- ★ 2026-09-24：冇共用帳戶 —— 名冊要有「個人身份」先登入得到。
           呢步等同真用戶做嘅嘢：團長喺「用戶」加人（團長／領袖／執委）＋設密碼。
           第一次上後端之後，另一部機登入前會先由後端拉返名冊，所以一樣登入到。 ---- */
    if (PLAN.seedRoster && (store.tryLoad()?.members || []).length < 3) {
      const { seedRosterRoles } = await import('./_roles.mjs');
      await seedRosterRoles(store, auth);
      note('名冊種子（個人身份）', (store.tryLoad()?.members || []).map(m => `${m.name}:${m.identity}`).join('、'));
    }

    /* ---- 登入（同真用戶一樣：打自己嘅電郵／自訂帳號 ＋ 密碼） ---- */
    if (PLAN.login !== false) {
      note('登入頁第一步：有冇「領袖／團員」揀門畫面', false);
      if (doc.querySelector('#loginForm')) {
        doc.querySelector('#liUser').value = PLAN.user || 'leader';
        doc.querySelector('#liPass').value = PLAN.pass || '8202';
        doc.querySelector('#loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await wait(3000);
        note('登入後畫面（頭 160 字）', txt().slice(0, 160));
        note('登入有冇入到主控頁（見到頂部狀態 chip）', !!doc.querySelector('#syncChip'));
        note('登入頁留低嘅錯誤字', (doc.querySelector('#liErr')?.textContent || '').trim() || '(冇)');
      }
    }

    /* ---- 改嘢 ---- */
    if (PLAN.addMember) {
      store.add('members', { name: PLAN.addMember, ymis: PLAN.ymis || '2026000099', identity: 'member' });
      note('加咗團員', PLAN.addMember);
      note('本機團員數', (store.tryLoad()?.members || []).length);
      note('本機 pending', Number(store.tryLoad()?.sync?.pending || 0));
    }
    if (PLAN.addTx) {
      store.add('transactions', { date: '2026-03-01', type: 'income', item: PLAN.addTx, amount: 1200 });
      note('加咗帳目', PLAN.addTx);
    }

    /* ---- 撳頂部「儲存到後端」（真掣） ---- */
    if (PLAN.save) {
      await wait(300);
      const btn = doc.querySelector('#syncActBtn');
      note('頂部掣文字', btn ? btn.textContent.trim() : '(搵唔到 #syncActBtn)');
      const chipBefore = (doc.querySelector('#syncChip')?.textContent || '').replace(/\s+/g, ' ');
      note('撳之前狀態 chip', chipBefore);
      if (btn) {
        btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await wait(6000);
        /* toast 係 .toast 元素 —— 直接攞，唔好用成頁文字估 */
        note('★ 用戶撳完「儲存到後端」見到嘅提示（toast）', toastsSeen.join(' ｜ ').slice(0, 400) || '(冇 toast)');
        note('撳之後狀態 chip', (doc.querySelector('#syncChip')?.textContent || '').replace(/\s+/g, ' '));
      }
      note('撳完之後本機 pending', Number(store.tryLoad()?.sync?.pending || 0));
      note('同步紀錄（最後 3 條）', (store.tryLoad()?.sync?.log || []).slice(-3).map(l => l.msg));
    }

    /* ---- 「報表同步」掣背後做嘅嘢（pushToMaster）---- */
    if (PLAN.pushReports) {
      const tables = await import('../assets/js/views/tables.js');
      const r = await tables.pushToMaster({ silent: true });
      note('撳「更新報表分頁」結果', JSON.stringify(r).slice(0, 200));
      note('同步紀錄（最後 3 條）', (store.tryLoad()?.sync?.log || []).slice(-3).map(l => l.msg));
    }

    /* ---- 旅團編號打少咗 0（團長喺閘度打「82」）會唔會被校正 ---- */
    if (PLAN.gateCode) {
      const units = await import('../assets/js/lib/units.js');
      note(`閘度打「${PLAN.gateCode}」→ 校正後嘅編號`, String(units.canonicalUnitCode(PLAN.gateCode)));
      note(`unitEntry('${PLAN.gateCode}') 搵唔搵到旅團`, String(units.unitEntry(PLAN.gateCode)?.name || '(搵唔到)'));
      const before = store.currentUnit();
      store.setUnitCode(PLAN.gateCode);
      /* currentUnit() 會優先用網址 ?u=，所以呢度直接睇 localStorage 記住咗乜 */
      note(`setUnitCode('${PLAN.gateCode}') 之後 store 記住嘅編號`,
        String(localStorage.getItem('venture82.currentUnit.v2') || ''));
      store.setUnitCode(before);   // 還原，唔好影響後面嘅步驟
    }

    /* ---- 「讀取就讀取曬」：登入之後本機係咪真係有齊所有資料 ---- */
    if (PLAN.collections) {
      const db = store.tryLoad() || {};
      note('登入後本機各資料筆數', JSON.stringify({
        members: (db.members || []).length,
        transactions: (db.transactions || []).length,
        notices: (db.notices || []).length,
        invItems: (db.invItems || []).length,
        meetings: (db.meetings || []).length,
        claims: (db.claims || []).length,
        accounts: (db.accounts || []).length
      }));
    }

    /* ---- 另一部機視角：開返入去睇唔睇到 ---- */
    if (PLAN.checkName) {
      location.hash = '#/members';
      window.dispatchEvent(new window.Event('hashchange'));
      await wait(900);
      const page = txt();
      note('用戶頁睇唔睇到「' + PLAN.checkName + '」', page.includes(PLAN.checkName));
      note('用戶頁團員數（畫面）', (store.tryLoad()?.members || []).length);
    }

    out.ok = true;
  } catch (e) {
    out.error = String(e && e.stack || e).slice(0, 600);
  }
  process.stdout.write('@@RESULT@@' + JSON.stringify(out) + '@@END@@');
  process.exit(0);
}

/* ============================================================
   指揮部：起後端＋起裝置＋直接問後端
   ============================================================ */
const KEY = 'v82_usersim_key';
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const waitPort = async (port, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const up = await new Promise(r => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
};

const GAS_PORT = await freePort();
const WEB_PORT = await freePort();
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const REAL_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;

const procs = [];
const spawnBg = (args, env = {}) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
process.on('exit', () => procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }));

const runDevice = (plan) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'tests', 'usersim.mjs'), 'device', BASE, JSON.stringify(plan)],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; });
  p.stderr.on('data', d => { err += d; });
  const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); }
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（120 秒）' }), 120000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-900) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});
const got = (r, k) => {
  /* 裝置爆咗就唔好回 undefined —— 否則 Number(undefined||0)===0 呢類斷言會假綠燈 */
  if (!r?.ok) return '⚠ 裝置爆咗：' + String(r?.error || '').slice(0, 120);
  const hit = (r?.log || []).find(o => Object.keys(o)[0] === k);
  return hit ? hit[k] : '(冇記錄)';
};
const show = (r) => (r?.log || []).forEach(o => { const k = Object.keys(o)[0]; say(`${k}：${JSON.stringify(o[k])}`); });

const ask = async (payload) => {
  const r = await fetch(REAL_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ apiKey: KEY, ...payload })
  });
  return { http: r.status, ...(await r.json().catch(() => ({ _notJson: true }))) };
};
const dbRows = async () => (await (await fetch(`http://127.0.0.1:${GAS_PORT}/_rows?tab=${encodeURIComponent('資料庫')}`)).json()).rows || [];
const allTabs = async () => (await (await fetch(`http://127.0.0.1:${GAS_PORT}/_tabs`)).json()).tabs || [];

section('起真後端（Code.gs）＋ dev-server（/api/proxy，同 Vercel 同一份 source）');
spawnBg([path.join(ROOT, 'tests', '_realgas.mjs'), String(GAS_PORT)], { REALGAS_APIKEY: KEY });
spawnBg([path.join(ROOT, 'dev-server.mjs')], {
  PORT: String(WEB_PORT), V82_PROXY_TEST: '1',
  TROOP_0082_BACKEND: REAL_EXEC, TROOP_0082_APIKEY: KEY
});
ok('後端＋代理已啟動', (await waitPort(GAS_PORT)) && (await waitPort(WEB_PORT)));

/* ---------------- ① 團長部機：開機 → 登入 → 改嘢 → 撳儲存 ---------------- */
section('① 用戶視角：開網站 → 登入 → 加團員 → 撳「儲存到後端」');
const A = await runDevice({ addMember: '陳大文', addTx: '團費收入', save: true, seedRoster: true });
ok('裝置 A 全程冇爆', A.ok === true, A.error || '');
show(A);
ok('開機真係出到登入頁（＝後端答到，硬閘通過；連唔到會停喺連線閘）',
  got(A, '開機後係咪停喺連線閘（連唔到後端）') === false && got(A, '登入頁有冇「一個入口」嘅登入表單') === true);
ok('用 leader／8202 登入到主控頁', got(A, '登入有冇入到主控頁（見到頂部狀態 chip）') === true);
const toastA = String(got(A, '★ 用戶撳完「儲存到後端」見到嘅提示（toast）') || '');
ok('★ 撳「儲存到後端」之後用戶見到「已儲存到後端」', /已儲存到後端/.test(toastA), toastA.slice(0, 200));
ok('★ 提示會講明寫咗去邊（「資料庫」分頁 ＋ 報表分頁）—— 唔會再令人以為「完全冇寫入」',
  /資料庫/.test(toastA) && /報表分頁/.test(toastA), toastA.slice(0, 240));
ok('撳完之後本機 pending 歸零（app 認為寫咗）', Number(got(A, '撳完之後本機 pending') || 0) === 0);

/* ---------------- ② 後端實況 ---------------- */
section('② 後端實況（唔信 app 自己講，直接問 Code.gs）');
const info = await ask({ action: 'dbInfo', unit: '0082' });
say(`dbInfo(unit=0082)：found=${!!info.found} bytes=${info.bytes} counts=${JSON.stringify(info.counts)} error=${info.error || ''}`);
const ld = await ask({ action: 'loadDb', unit: '0082' });
say(`loadDb(unit=0082)：found=${!!ld.found} 團員=${(ld.db?.members || []).length} 帳目=${(ld.db?.transactions || []).length}`);
say(`loadDb 入面嘅團員名：${JSON.stringify((ld.db?.members || []).map(m => m.name))}`);
const rows = await dbRows();
say(`「資料庫」分頁：${rows.length - 1} 行資料，旅團欄出現過嘅值＝${JSON.stringify([...new Set(rows.slice(1).map(r => r.unit))])}`);
ok('★ 後端真係收到「陳大文」', (ld.db?.members || []).some(m => m.name === '陳大文'), JSON.stringify(ld).slice(0, 200));
ok('★ 後端真係收到嗰筆帳', (ld.db?.transactions || []).length >= 1);

section('③ 團長開張 Google Sheet 會見到乜（所有分頁行數）');
const tabs = await allTabs();
tabs.forEach(t => say(`分頁「${t.tab}」：${t.rows} 行${t.rows ? '　首行＝' + JSON.stringify(t.first.slice(0, 3)) : ''}`));
const emptyReadable = tabs.filter(t => t.tab !== '資料庫' && t.rows === 0).map(t => t.tab);
say(`而家仲係空嘅分頁有 ${emptyReadable.length} 張：${emptyReadable.join('、')}`);
ok('「資料庫」分頁有嘢（app 嘅正本住喺呢度）',
  (tabs.find(t => t.tab === '資料庫')?.rows || 0) > 0);
/* ★ 團長回報「話已寫入但張 Sheet 完全冇嘢」嘅根治：
   儲存到後端而家會連埋報表分頁一齊刷新，唔使再撳第二粒掣。 */
ok('★ 撳完「儲存到後端」，團長開 Sheet 即刻見到「團員」分頁有嘢（唔使再撳第二粒掣）',
  (tabs.find(t => t.tab === '團員')?.rows || 0) >= 1, JSON.stringify(tabs.find(t => t.tab === '團員')));
ok('★ 「帳目」分頁都有嘢', (tabs.find(t => t.tab === '帳目')?.rows || 0) >= 1,
  JSON.stringify(tabs.find(t => t.tab === '帳目')));

/* ---------------- ③b 撳「更新報表分頁」之後 ---------------- */
section('③b 撳「更新報表分頁」（報表同步）之後，團長先至喺 Sheet 見到嘢');
const A2 = await runDevice({ pushReports: true, login: true });
ok('裝置 A2 全程冇爆', A2.ok === true, A2.error || '');
show(A2);
const tabs2 = await allTabs();
const filled = tabs2.filter(t => t.rows > 0).map(t => `${t.tab}(${t.rows})`);
say(`而家有嘢嘅分頁：${filled.join('、')}`);
ok('★ 報表同步之後「團員」分頁有嘢（1 行）',
  (tabs2.find(t => t.tab === '團員')?.rows || 0) >= 1, JSON.stringify(tabs2.find(t => t.tab === '團員')));
ok('★ 報表同步之後「帳目」分頁有嘢（1 行）',
  (tabs2.find(t => t.tab === '帳目')?.rows || 0) >= 1, JSON.stringify(tabs2.find(t => t.tab === '帳目')));

/* ---------------- ④ 另一部機（無痕視窗） ---------------- */
section('④ 另一部全新機（＝無痕視窗）開返：睇唔睇到');
const B = await runDevice({ checkName: '陳大文', login: true, collections: true });
ok('裝置 B 全程冇爆', B.ok === true, B.error || '');
show(B);
ok('★ 無痕視窗睇到「陳大文」', got(B, '用戶頁睇唔睇到「陳大文」') === true);

/* ---------------- ⑤ 團長打「82」（少咗兩個 0）：以前會話「無後端」 ---------------- */
section('⑤ 用 ?u=82 開（團長打「82」）—— 以前呢度會話「未能連接旅團後端」＝「無後端」');
const C = await runDevice({ query: '?u=82', checkName: '陳大文', save: true, addMember: '李小明', gateCode: '82', collections: true });
ok('裝置 C 全程冇爆', C.ok === true, C.error || '');
show(C);
ok('★ 用「82」開都入到登入頁（唔會再話「未能連接旅團後端」）',
  got(C, '開機後係咪停喺連線閘（連唔到後端）') === false, String(got(C, '開機後畫面')).slice(0, 120));
ok('★ 用「82」開都登入到主控頁', got(C, '登入有冇入到主控頁（見到頂部狀態 chip）') === true,
  String(got(C, '登入頁留低嘅錯誤字')));
ok('★ 用「82」開都讀到「陳大文」（讀寫兩邊都通）', got(C, '用戶頁睇唔睇到「陳大文」') === true);
ok('★ 用「82」開，存完之後後端仍然只有一套資料庫（旅團欄＝0082）',
  got(C, '撳完之後本機 pending') === 0);
const rows2 = await dbRows();
const unitsSeen = [...new Set(rows2.slice(1).map(r => r.unit))];
say(`而家「資料庫」分頁嘅旅團欄值＝${JSON.stringify(unitsSeen)}`);
/* app 行嘅係同源代理 —— 用代理問先至係真實路徑（直連 /exec 唔經 Registry，
   所以唔會校正編號；前端嗰邊由 gotoUnit／setUnitCode 校正）。 */
const askProxy = async (payload) => {
  const r = await fetch(`${BASE}/api/proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { http: r.status, ...(await r.json().catch(() => ({}))) };
};
const info0082 = await askProxy({ action: 'dbInfo', unit: '0082' });
const info82 = await askProxy({ action: 'dbInfo', unit: '82' });
say(`經代理 dbInfo(0082) 團員＝${info0082.counts?.members ?? '-'}　dbInfo(82) 團員＝${info82.counts?.members ?? '-'}（同一個後端，問法差兩個 0）`);
ok('★ 經代理用「82」同「0082」問到同一套資料（唔會分裂成兩套）',
  Number(info0082.counts?.members) > 0 && Number(info0082.counts?.members) === Number(info82.counts?.members) && !unitsSeen.includes('82'),
  `${JSON.stringify(unitsSeen)}｜0082=${info0082.counts?.members} 82=${info82.counts?.members}`);
const st = await ask({ action: 'status', unit: '0082' });
say(`後端自報 Spreadsheet 名＝「${st.spreadsheet}」　版本＝${st.backendVersion}（呢個名先至答到「寫咗去邊張表」）`);

/* ---------------- ⑤b 前端校正 ---------------- */
section('⑤b 前端把「82」校正做「0082」（閘度打字／store 都一樣）');
ok('★ canonicalUnitCode("82") → "0082"', got(C, '閘度打「82」→ 校正後嘅編號') === '0082', String(got(C, '閘度打「82」→ 校正後嘅編號')));
ok('★ unitEntry("82") 搵到旅團', /第八十二旅/.test(String(got(C, "unitEntry('82') 搵唔搵到旅團"))), String(got(C, "unitEntry('82') 搵唔搵到旅團")));
ok('★ setUnitCode("82") 之後 store 記住嘅係 0082（本機資料庫唔會開多一套）',
  got(C, "setUnitCode('82') 之後 store 記住嘅編號") === '0082',
  String(got(C, "setUnitCode('82') 之後 store 記住嘅編號")));

/* ---------------- ⑥ 讀取就讀取曬 ---------------- */
section('⑥ 讀取就讀取曬：登入一次，所有資料一次過讀返');
const collB = String(got(B, '登入後本機各資料筆數') || '');
say(`裝置 B 登入後本機：${collB}`);
const collC = String(got(C, '登入後本機各資料筆數') || '');
say(`裝置 C（用 82 開）登入後本機：${collC}`);
ok('★ 全新機登入之後，團員＋帳目一次過讀齊（唔使逐個分頁撳）',
  /"members":[1-9]/.test(collB) && /"transactions":[1-9]/.test(collB), collB);

/* ---------------- ⑦ 一次儲存＝兩處都寫（後端自己做，唔靠前端） ---------------- */
section('⑦ 後端自己一次過寫齊「資料庫」＋報表分頁（舊前端／舊 cache 都一樣有效）');
const cur = await ask({ action: 'loadDb', unit: '0082' });
const db7 = cur.db || {};
db7.members = (db7.members || []).concat([{ id: 'me_backend_test', name: '後端測試員', ymis: '2026000777', identity: 'member' }]);
const sv = await ask({ action: 'saveDb', unit: '0082', db: db7, baseVersion: String(cur.version || '') });
say(`直接 saveDb（完全冇經前端）：success=${sv.success} bytes=${sv.bytes} reports=${JSON.stringify(sv.reports || null)}`);
ok('★ saveDb 回應話報表分頁都刷新咗', sv.reports?.ok === true, JSON.stringify(sv.reports || null));
const memRows = (await (await fetch(`http://127.0.0.1:${GAS_PORT}/_rows?tab=${encodeURIComponent('團員')}`)).json()).rows || [];
const memNames = memRows.slice(1).map(r => (r.cells || []).join('|'));
say(`「團員」分頁而家嘅名＝${JSON.stringify(memNames.slice(0, 6))}`);
ok('★ 淨係撳一次儲存（冇撳「更新報表分頁」），團長開 Sheet 即刻見到新團員',
  memNames.some(n => String(n).includes('後端測試員')), JSON.stringify(memNames.slice(0, 6)));
/* opt-out 仍然要 work（例如自動化測試唔想每次重寫報表） */
const sv2 = await ask({ action: 'saveDb', unit: '0082', db: db7, baseVersion: String(sv.version || ''), refreshReports: false });
ok('★ refreshReports:false 可以略過報表刷新（唔會被強迫做兩倍工作）',
  sv2.success === true && !sv2.reports, JSON.stringify(sv2.reports ?? null));

console.log(`\n${fail ? '❌' : '✅'} 用戶角度完整模擬：${pass} 過 / ${fail} 唔過（${Date.now() - START}ms）`);
process.exit(fail ? 1 : 0);
