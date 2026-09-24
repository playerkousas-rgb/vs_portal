/* ============================================================
   tests/_device.mjs — 「一部裝置」模擬器（畀 tests/remote.mjs 用）
   ------------------------------------------------------------
   每次執行 ＝ 一部全新嘅機（全新 process、全新 localStorage）。
   會經**真實 HTTP** 打去 dev-server 嘅 /api/proxy，再由 proxy 轉去假 GAS。
   用法：node tests/_device.mjs <baseUrl> <動作JSON>
   輸出：一行 JSON（畀父 process 讀）
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2];
const PLAN = JSON.parse(process.argv[3] || '{}');

const out = { ok: false, steps: [], error: '' };

try {
  /* ---- 一部全新嘅「瀏覽器」 ---- */
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `${BASE}/?u=0082`, pretendToBeVisual: true
  });
  const { window } = dom;
  window.scrollTo = () => {};
  try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    if (window[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ignore */ }
  }
  globalThis.window = window;

  /* ---- fetch：相對路徑補返 base，行真 HTTP ---- */
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let u = String(url);
    if (!/^https?:\/\//.test(u)) u = `${BASE}/${u.replace(/^\.?\//, '')}`;
    return nodeFetch(u, init);
  };

  const units = await import('../assets/js/lib/units.js');
  const store = await import('../assets/js/lib/store.js');
  const remote = await import('../assets/js/lib/remote.js');
  const auth = await import('../assets/js/lib/auth.js');

  await units.loadRegistry(true);
  await store.init({ mode: 'real', unit: '0082' });
  /* 同 main.js 一樣：改動會自動排一次寫入（critical＝即刻）。
     舊劇本想測「未撳掣之前後端應該冇嘢」嘅，加 { bootAutoSave:false }。 */
  store.setSaveHook((info) => remote.scheduleSave(info));
  /* ★ 2026-09-24：模擬「status 通、但讀寫被拒」（最常見嘅死因：API Key 唔啱）。
     呢個情況正正係「以為同步到，其實一個字都寫唔入」，所以一定要測得到。 */
  if (PLAN.badKey) {
    const db = store.tryLoad();
    db.sync = { ...(db.sync || {}), apiKey: 'definitely_wrong_key' };
    store.commitMeta();
  }
  if (PLAN.bootLoad) await remote.loadFromBackend();

  out.configured = remote.remoteConfigured();
  out.cfg = { url: remote.remoteCfg().url, unit: remote.remoteCfg().unit };
  out.seededMembers = store.load().members.length;

  const DB_KEY = `venture82.unit.0082.db.v2`;
  const BASE_KEY = `venture82.unit.0082.base.v2`;
  const names = () => (store.tryLoad()?.members || []).map(m => m.name).sort();
  let lastConflicts = [];
  const pendingN = () => Number(store.tryLoad()?.sync?.pending || 0);
  /* 劇本式衝突回答：step.useMine ＝ true（全部用我嘅）／false（全部保留後端）／
     ['子串', …]（key 或者人話描述入面有呢啲字先用我嘅） */
  const scriptedResolver = (step) => async ({ conflicts, ctx }) => {
    const described = remote.describeConflicts(conflicts, ctx);
    out.lastDialog = described.map(d => ({ key: d.key, where: `${d.module} › ${d.record} › ${d.field}`, mine: d.mineText, theirs: d.theirsText }));
    if (step.useMine === true) return { useMine: true };
    if (!step.useMine) return { useMine: [] };
    const want = Array.isArray(step.useMine) ? step.useMine : [String(step.useMine)];
    return { useMine: described.filter(d => want.some(w => d.key.includes(w) || `${d.module}${d.record}${d.field}${d.mineText}`.includes(w))).map(d => d.key) };
  };

  /* ---- 依照劇本做嘢 ---- */
  for (const step of (PLAN.steps || [])) {
    if (step.op === 'wipe') {
      store.wipe();
      out.steps.push({ op: 'wipe', members: store.load().members.length });
    }
    if (step.op === 'addMember') {
      /* identity 可以指定（2026-09-24 團員入口要測「邊個睇到」——
         要一個 leader 身份嘅團員先至驗到權限升高見到更多公開資料）。 */
      store.add('members', { name: step.name, ymis: step.ymis, identity: step.identity || 'member' });
      out.steps.push({ op: 'addMember', name: step.name, identity: step.identity || 'member', total: store.load().members.length });
    }
    /* 公開資料（db.publicProfile）—— 團員入口要讀佢 show 社交媒體／相簿／網站／連結 */
    if (step.op === 'setPublicProfile') {
      const db = store.load();
      db.publicProfile = step.obj;
      store.commit();
      out.steps.push({ op: 'setPublicProfile', keys: Object.keys(step.obj || {}) });
    }
    if (step.op === 'bulkMembers') {
      /* 灌大量團員把 db 谷大過分件閾值 —— 測 v2.4.0 分件儲存。
         一次過注入再 commit 一次（同真實「試算表匯入」路徑一樣；
         唔係逐個 add —— 咁樣會千幾次全 db 序列化，純粹燒記憶體）。 */
      const db = store.load();
      for (let i = 0; i < (step.count || 0); i++) {
        db.members.push({ id: 'mb' + i, name: (step.prefix || 'Bulk') + i, ymis: '2026' + String(1000000 + i), identity: 'member', note: 'x'.repeat((step.kb || 2) * 1024) });
      }
      store.commit();
      const db2 = store.load();
      out.steps.push({ op: 'bulkMembers', total: db2.members.length, bytes: JSON.stringify(db2).length });
    }
    if (step.op === 'addTx') {
      store.add('transactions', { date: step.date, type: step.type, item: step.item, amount: step.amount });
      out.steps.push({ op: 'addTx', total: store.load().transactions.length });
    }
    /* 設置測試資料（tests/hub.mjs 用）：一次過放入活動／通告／連結等 */
    if (step.op === 'put') {
      const db = store.load();
      db[step.coll] = step.rows;
      store.commit();
      out.steps.push({ op: 'put', coll: step.coll, n: (step.rows || []).length });
    }
    if (step.op === 'patchSettings') {
      const db = store.load();
      db.settings = { ...(db.settings || {}), ...step.patch };
      store.commit();
      out.steps.push({ op: 'patchSettings', keys: Object.keys(step.patch || {}) });
    }
    if (step.op === 'setConstitution') {
      const db = store.load();
      db.constitution = step.obj;
      store.commit();
      out.steps.push({ op: 'setConstitution', version: step.obj?.version || '' });
    }
    /* ★ 2026-09-24 團長：「我只想要頂部1個儲到後端的制,其他任何時候都是暫儲在遊覽器」
       → 自動儲存成條路都拆咗，setAutoSave 呢個 op 亦都冇嘢可以調（remote.setAutoSave 已刪）。
       保留 op 名稱只係為咗舊 plan 唔會爆 —— 佢而家乜都唔做，只係報告而家嘅狀態。 */
    if (step.op === 'setAutoSave') {
      out.steps.push({ op: 'setAutoSave', removed: true, on: false, state: remote.syncState().state });
    }
    /* 等一排（而家冇自動儲存，純粹俾時間過） */
    if (step.op === 'wait') {
      await new Promise(r => setTimeout(r, Number(step.ms || 2500)));
      out.steps.push({ op: 'wait', ms: Number(step.ms || 2500), pending: pendingN(), syncState: remote.syncState().state });
    }
    /* ---- 帳戶／身份（tests/accountsync.mjs 用）---- */
    /* 「用戶與身份」頁開一個人（名冊紀錄＝帳號本身） */
    if (step.op === 'addStaff') {
      const rec = store.add('members', {
        name: step.name, email: step.email || '', ymis: step.ymis || '',
        identity: step.identity || 'leader', status: 'active'
      });
      out.steps.push({ op: 'addStaff', id: rec.id, pending: pendingN(), pendingAccounts: remote.pendingAccounts?.() ?? 0 });
    }
    /* 「用戶與身份」幫佢設登入密碼（＝名冊 hubPw）。id 可以用 '@last' ＝ 頭先開嗰個 */
    if (step.op === 'setHubPw') {
      const ms = store.load().members;
      const id = step.id === '@last' ? (ms[ms.length - 1]?.id || '') : step.id;
      const r = await auth.setMemberHubPassword(id, step.pw);
      out.steps.push({ op: 'setHubPw', ok: !!r.ok, msg: r.msg || '', pending: pendingN(), pendingAccounts: remote.pendingAccounts?.() ?? 0, state: remote.syncState().state, statusMsg: remote.syncState().msg || '' });
    }
    /* 直接問後端：呢個 login 代號喺後端嗰份名冊存唔存在 */
    if (step.op === 'backendHasLogin') {
      const got = await remote.pullDb();
      const list = (got.ok && got.db?.members) || [];
      const k = String(step.login || '').trim().toLowerCase();
      const hit = list.find(m => [m.email, m.loginId, m.ymis].some(v => String(v || '').trim().toLowerCase() === k));
      out.steps.push({
        op: 'backendHasLogin', ok: got.ok, found: !!hit, withPw: !!(hit?.hubPw?.hash || hit?.hubPassword),
        backendMembers: list.length, error: got.error || ''
      });
    }
    /* 登入閘 ＋ 個人登入（同 main.js gateLoginOnBackend() → loginIdentity() 同一條路） */
    if (step.op === 'login') {
      const gate = await remote.requireBackendForLogin();
      let res = null;
      if (gate.ok) res = await auth.loginIdentity(step.login, step.pw);
      out.steps.push({
        op: 'login', gateOk: !!gate.ok, gateReason: gate.reason || '', gateError: (gate.error || '').slice(0, 120),
        ok: !!(res && res.ok), msg: res?.msg || '', role: res?.role || '',
        session: !!store.getSession(), pending: pendingN()
      });
    }
    if (step.op === 'logout') { auth.logout(); out.steps.push({ op: 'logout', session: !!store.getSession() }); }
    /* 同一個瀏覽器另一個分頁寫咗 localStorage（瀏覽器會派 storage event） */
    if (step.op === 'otherTabWrite') {
      const db = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
      const before = (db?.members || []).length;
      if (db) {
        db.members = [...(db.members || []), {
          id: 'me_othertab', name: step.name || '另一分頁開嘅人',
          email: step.email || 'othertab@example.com', identity: 'leader', status: 'active'
        }];
        localStorage.setItem(DB_KEY, JSON.stringify(db));
      }
      try {
        window.dispatchEvent(new window.StorageEvent('storage', {
          key: DB_KEY, newValue: localStorage.getItem(DB_KEY), oldValue: null, storageArea: localStorage
        }));
      } catch (e) { out.steps.push({ op: 'otherTabWrite', eventError: String(e?.message || e) }); }
      await new Promise(r => setTimeout(r, 150));
      out.steps.push({
        op: 'otherTabWrite', before, after: (store.tryLoad()?.members || []).length,
        seesName: (store.tryLoad()?.members || []).some(m => m.name === (step.name || '另一分頁開嘅人'))
      });
    }
    /* 讀進度後端（同一個 /exec）：成員名單有幾多個 YMIS、進度追蹤有幾多格 */
    if (step.op === 'progressLoad') {
      const r = await fetch(`${BASE}/api/progress`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit: '0082', action: 'load' })
      }).then(x => x.json()).catch(e => ({ ok: false, error: String(e) }));
      const d = r?.data || {};
      const ymisList = (d.members || []).map(m => String(m.ymis || '')).filter(Boolean);
      out.steps.push({
        op: 'progressLoad', ok: !!r?.ok, error: r?.error || '',
        memberList: ymisList.length, ymis: ymisList,
        progressPeople: Object.keys(d.progress || {}).length,
        ticks: Object.values(d.progress || {}).reduce((a, p2) => a + Object.keys(p2 || {}).length, 0)
      });
    }
    /* 直接勾一項進度（經 /api/progress → 旅團後端「進度追蹤」分頁） */
    if (step.op === 'progressTick') {
      const r = await fetch(`${BASE}/api/progress`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit: '0082', action: 'save', data: {
          changes: [{ ymis: step.ymis, itemId: step.itemId, date: step.date || '2026-09-24' }],
          confirmer: step.confirmer || '測試領袖'
        } })
      }).then(x => x.json()).catch(e => ({ ok: false, error: String(e) }));
      out.steps.push({ op: 'progressTick', ok: !!(r?.ok || r?.success), error: r?.error || '' });
    }
    /* 本機名冊有邊啲 login 代號（email／loginId／ymis） */
    if (step.op === 'logins') {
      out.steps.push({
        op: 'logins',
        list: (store.tryLoad()?.members || []).map(m => ({
          name: m.name, email: m.email || '', ymis: m.ymis || '',
          identity: m.identity || '', hasPw: !!(m.hubPw?.hash || m.hubPassword)
        }))
      });
    }
    /* 領袖喺「總表同步 → 同步設定」貼 /exec ＋ API Key（自助路線） */
    if (step.op === 'setSync') {
      /* 連線設定係呢部機自己嘅嘢：只寫本機（commitMeta），唔計入未儲存改動 */
      const db = store.load();
      db.sync = { ...(db.sync || {}), url: step.url || '', apiKey: step.apiKey || '', unit: step.unit || '0082' };
      store.commitMeta();
      const cfg = remote.remoteCfg();
      out.steps.push({ op: 'setSync', url: cfg.url, hasKey: !!cfg.apiKey, viaProxy: cfg.viaProxy, ok: cfg.ok, pending: pendingN() });
    }
    /* 「同步診斷」：逐格驗成條鏈 */
    if (step.op === 'diagnose') {
      const d = await remote.remoteDiagnose();
      out.steps.push({
        op: 'diagnose', ok: d.ok, route: d.route, backendVersion: d.backendVersion,
        summary: d.summary || '', blockers: (d.blockers || []).map(b => b.id),
        stages: (d.stages || []).map(s => `${s.id}:${s.state}`)
      });
    }
    /* 「儲存到後端」—— 唯一寫入路（核對版本 → 三方比對 → 撞就問 resolver） */
    if (step.op === 'push' || step.op === 'save' || step.op === 'syncNow') {
      const policy = step.policy || 'ask';
      out.lastDialog = null;
      const r = await remote.saveToBackend({ policy, resolver: scriptedResolver(step), silent: true });
      out.steps.push({
        op: step.op, ok: !!r.ok, pushed: !!r.pushed, error: r.error || '', reason: r.reason || '', hint: (r.hint || '').slice(0, 400),
        bytes: r.bytes || 0, parts: r.parts || 0, version: String(r.version || ''),
        remoteChanged: !!r.remoteChanged, mine: r.mine ?? null, theirs: r.theirs ?? null, same: r.same ?? null, applied: r.applied ?? null,
        conflicts: (r.conflicts || []).map(c => c.key), resolved: r.resolved || 0, kept: r.kept ?? 0,
        overrideOk: r.overrideOk, dialog: out.lastDialog,
        pending: pendingN(), members: names().length, names: names(), state: remote.syncState().state
      });
    }
    /* 「登入／開機」—— 由後端攞成份資料做基準（有未存改動就三方比對保留） */
    if (step.op === 'load' || step.op === 'checksync') {
      const r = await remote.loadFromBackend({ policy: step.policy || 'ask' });
      lastConflicts = r.conflicts || [];
      const described = r.conflicts?.length ? remote.describeConflicts(r.conflicts, r.ctx) : [];
      const base = store.getBase();
      out.steps.push({
        op: step.op, ok: !!r.ok, found: r.found !== false, fresh: !!r.fresh, merged: !!r.merged, legacy: !!r.legacy,
        error: r.error || '', reason: r.reason || '', version: String(r.version || ''),
        mine: r.mine ?? null, theirs: r.theirs ?? null, same: r.same ?? null,
        conflicts: (r.conflicts || []).map(c => c.key),
        dialog: described.map(d => ({ key: d.key, where: `${d.module} › ${d.record} › ${d.field}`, mine: d.mineText, theirs: d.theirsText })),
        baseVersion: String(base?.version || ''), baseEmpty: !!base?.empty,
        pending: pendingN(), members: names().length, names: names(), state: remote.syncState().state
      });
    }
    /* 登入前嘅 ensureFresh（登入頁擺咗耐先撳登入） */
    if (step.op === 'ensureFresh') {
      const r = await remote.ensureFresh({ maxAgeMs: step.maxAgeMs ?? 0 });
      out.steps.push({ op: 'ensureFresh', ok: !!r.ok, fresh: !!r.fresh, upToDate: !!r.upToDate, skipped: r.skipped || '', members: names().length, names: names(), pending: pendingN() });
    }
    /* 登入時衝突對話框揀「用我嘅」→ 寫落本機（等撳儲存）；用上一個 load 回嘅 conflicts */
    if (step.op === 'applyMine') {
      const merge3 = await import('../assets/js/lib/merge3.js');
      const keys = step.useMine === true ? true
        : (lastConflicts || []).map(c => c.key).filter(k => !step.match || k.includes(step.match));
      const ov = merge3.overridesFor(lastConflicts || [], keys);
      store.applyChangesLocal(ov);
      out.steps.push({ op: 'applyMine', applied: ov.length, pending: pendingN() });
    }
    /* 改完嘢淨係暫存：等幾秒都唔會自動寫後端 */
    if (step.op === 'stage' || step.op === 'manualStage' || step.op === 'autosave') {
      store.add('members', { name: step.name, ymis: step.ymis, identity: 'member' });
      remote.scheduleSave();
      await new Promise(r => setTimeout(r, step.waitMs || 3000));
      out.steps.push({ op: step.op, pending: pendingN(), state: remote.syncState().state, msg: remote.syncState().msg || '', members: names().length });
    }
    /* 直接改一格（例如點名）—— 測「同一格唔同值」 */
    if (step.op === 'setField') {
      const db = store.load();
      const rec = (db[step.coll] || []).find(r => r.id === step.id);
      if (!rec) { out.steps.push({ op: 'setField', ok: false, error: '搵唔到紀錄' }); continue; }
      let cur = rec;
      const segs = step.path.slice(0, -1);
      segs.forEach(k => { if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; });
      cur[step.path[step.path.length - 1]] = step.value;
      store.commit();
      out.steps.push({ op: 'setField', ok: true, id: step.id, path: step.path, value: step.value, pending: pendingN() });
    }
    /* 讀一格返嚟（驗證合併結果） */
    if (step.op === 'getField') {
      const db = store.load();
      const rec = (db[step.coll] || []).find(r => r.id === step.id);
      let cur = rec;
      (step.path || []).forEach(k => { cur = cur == null ? undefined : cur[k]; });
      out.steps.push({ op: 'getField', id: step.id, path: step.path, value: cur === undefined ? null : cur, exists: !!rec });
    }
    /* 直接問後端攞成份 db，睇下頂層有咩 key（驗 sync／backend 冇上到 Sheet） */
    if (step.op === 'backendKeys') {
      const cfg = remote.remoteCfg();
      const r = await fetch(cfg.url || `${BASE}/api/proxy`, {
        method: 'POST', headers: { 'Content-Type': cfg.url ? 'text/plain;charset=utf-8' : 'application/json' },
        body: JSON.stringify(cfg.url ? { action: 'loadDb', unit: cfg.unit || '0082', apiKey: cfg.apiKey } : { action: 'loadDb', unit: cfg.unit || '0082' })
      });
      const j = await r.json().catch(() => ({}));
      out.steps.push({ op: 'backendKeys', ok: !!j.ok && !!j.found, keys: Object.keys(j.db || {}).sort(), version: String(j.version || '') });
    }
    /* 劇本中途直接問後端而家有咩（唔信前端自己講）——
       要喺兩個 step **之間**取樣先有意義，例如證明「手動模式下未撳同步
       之前，後端真係一個字都未收到」。 */
    if (step.op === 'backendPeek') {
      const cfg = remote.remoteCfg();
      const r = await fetch(cfg.url || `${BASE}/api/proxy`, {
        method: 'POST', headers: { 'Content-Type': cfg.url ? 'text/plain;charset=utf-8' : 'application/json' },
        body: JSON.stringify(cfg.url ? { action: 'dbInfo', unit: cfg.unit || '0082', apiKey: cfg.apiKey } : { action: 'dbInfo', unit: cfg.unit || '0082' })
      });
      const j = await r.json().catch(() => ({}));
      out.steps.push({
        op: 'backendPeek', http: r.status, found: !!j.found,
        members: Number(j.counts?.members || 0), version: String(j.version || '')
      });
    }
    /* ★ 2026-09-24：「後端實況」—— 只讀核對（本機 vs 後端） */
    if (step.op === 'reality') {
      const r = await remote.backendReality();
      out.steps.push({
        op: 'reality', ok: !!r.ok, found: !!r.found, route: r.route || '', sheet: r.sheet || '',
        backendVersion: r.backendVersion || '', version: String(r.version || ''), bytes: Number(r.bytes || 0),
        counts: r.counts || null, local: r.local || null, rows: r.rows || [],
        pending: Number(r.pending || 0), pendingAccounts: Number(r.pendingAccounts || 0),
        level: r.verdict?.level || '', title: r.verdict?.title || '', detail: r.verdict?.detail || '',
        error: r.error || '', hint: (r.hint || '').slice(0, 400)
      });
    }
    /* ★ 2026-09-24：儲存之後即刻核對（寫咗去邊、後端有冇） */
    if (step.op === 'verify') {
      /* 冇指定就用「後端上次寫入畀嘅版本」—— 同 saveWithDialog 傳 r.version 一樣 */
      const r = await remote.verifyAgainstBackend(step.version || (store.tryLoad()?.sync?.lastSyncedVersion || ''));
      out.steps.push({
        op: 'verify', ok: !!r.ok, matched: !!r.matched, version: String(r.version || ''),
        expectedVersion: String(r.expectedVersion || ''), versionOk: !!r.versionOk, countsOk: !!r.countsOk,
        sheet: r.sheet || '', bytes: Number(r.bytes || 0), rows: r.rows || [],
        backend: r.backend || null, local: r.local || null, error: r.error || ''
      });
    }
    /* ★ 2026-09-24：一寫一讀驗證（寫個記號落後端再讀返出嚟對） */
    if (step.op === 'probe') {
      const r = await remote.syncProbe({ cleanup: step.cleanup !== false });
      out.steps.push({
        op: 'probe', ok: !!r.ok, matched: !!r.matched, nonce: String(r.nonce || ''), seen: String(r.seen || ''),
        savedVersion: String(r.savedVersion || ''), readVersion: String(r.readVersion || ''),
        cleanedUp: !!r.cleanedUp, cleanupError: String(r.cleanupError || ''),
        writeMs: Number(r.writeMs || 0), readMs: Number(r.readMs || 0),
        wroteButCannotRead: !!r.wroteButCannotRead, error: r.error || '', hint: (r.hint || '').slice(0, 400),
        pending: pendingN()
      });
    }
    /* 「公開資料」頁會派出去嘅公開連結（驗 ?be= 自助後端附埋入 link） */
    if (step.op === 'links') {
      const model = await import('../assets/js/lib/model.js');
      const route = model.publicLinkRoute();
      const list = model.memberLinks();
      out.steps.push({
        op: 'links', route: route.route, label: route.label, routeOk: route.ok,
        selfServeExec: model.selfServeExec(),
        urls: list.slice(0, 6).map(l => ({ id: l.id, url: l.url }))
      });
    }
    if (step.op === 'info') {
      const i = await remote.remoteInfo();
      out.steps.push({ op: 'info', ok: i.ok, found: !!i.found, reason: i.reason || '', error: (i.error || '').slice(0, 80), counts: i.counts || null, at: i.at || '' });
    }
    /* 「由後端重新載入」（丟棄本機未存改動；冇 pending 嗰陣同 load 一樣） */
    if (step.op === 'pull') {
      const g = await remote.discardAndReload();
      let adopted = null;
      if (g.ok) {
        adopted = {
          members: store.load().members.length,
          transactions: store.load().transactions.length,
          names: store.load().members.map(m => m.name),
          pending: Number(store.load().sync?.pending || 0)
        };
      }
      out.steps.push({ op: 'pull', ok: g.ok, found: g.ok ? true : (g.reason === 'empty' ? false : null), error: g.error || '', reason: g.reason || '', adopted });
    }
    if (step.op === 'snapshot') {
      const db = store.load();
      out.steps.push({
        op: 'snapshot',
        members: db.members.length,
        transactions: db.transactions.length,
        names: db.members.map(m => m.name),
        hasLocalContent: store.hasLocalContent(),
        updatedAt: store.localUpdatedAt(),
        lastSyncedVersion: String(db.sync?.lastSyncedVersion || ''),
        baseVersion: String(store.getBase()?.version || ''),
        hasBase: !!store.getBase(),
        localChanges: store.localChanges().length,
        pending: Number(db.sync?.pending || 0)
      });
    }
    /* 「第 N 部機」模擬：把呢部機嘅本機 db 匯出／匯入（模擬同一部機走開咗再返嚟，
       中間有第二部機更新咗後端 —— 用嚟測衝突復原）。 */
    /* 「同一部機走開再返嚟」：把本機 db ＋ 基準快照原樣存檔／讀返（唔係備份檔格式） */
    if (step.op === 'export') {
      fs.writeFileSync(step.file, JSON.stringify({ db: localStorage.getItem(DB_KEY), base: localStorage.getItem(BASE_KEY) }), 'utf8');
      out.steps.push({ op: 'export', file: step.file, members: store.load().members.length, hasBase: !!localStorage.getItem(BASE_KEY) });
    }
    /* 模擬「隊友喺另一部機儲存」：直接經 proxy 用正確 baseVersion 寫入後端 */
    if (step.op === 'teammatePush') {
      const got = await remote.pullDb();
      if (!got.ok || !got.db) { out.steps.push({ op: 'teammatePush', ok: false, error: got.error || '後端空' }); continue; }
      const db = JSON.parse(JSON.stringify(got.db));
      db.members = [...(db.members || []), { id: 'm8' + Date.now(), name: step.name, ymis: step.ymis, identity: 'member' }];
      db.meta = { ...(db.meta || {}), updatedAt: '2026-09-18T20:00:00.000Z' };
      const cfg = remote.remoteCfg();
      const r = await (await fetch(cfg.url || `${BASE}/api/proxy`, {
        method: 'POST', headers: { 'Content-Type': cfg.url ? 'text/plain;charset=utf-8' : 'application/json' },
        body: JSON.stringify({ action: 'saveDb', unit: '0082', db, baseVersion: String(got.version || ''), ...(cfg.url ? { apiKey: cfg.apiKey } : {}) })
      })).json();
      out.steps.push({ op: 'teammatePush', ok: r.ok === true, version: String(r.version || '') });
    }
    if (step.op === 'import') {
      const st = JSON.parse(fs.readFileSync(step.file, 'utf8'));
      if (st.db) localStorage.setItem(DB_KEY, st.db); else localStorage.removeItem(DB_KEY);
      if (st.base) localStorage.setItem(BASE_KEY, st.base); else localStorage.removeItem(BASE_KEY);
      store.reloadFromStorage();
      const db = store.load();
      out.steps.push({
        op: 'import', file: step.file, members: db.members.length,
        names: db.members.map(m => m.name), pending: Number(db.sync?.pending || 0),
        lastSyncedVersion: String(db.sync?.lastSyncedVersion || ''), hasBase: !!store.getBase()
      });
    }
  }

  out.ok = true;
} catch (e) {
  out.error = e?.stack || String(e);
}

process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '@@END@@\n');
/* jsdom 會留低 timer／rAF handle，唔明確 exit 就會吊死 */
process.exit(out.ok ? 0 : 1);
