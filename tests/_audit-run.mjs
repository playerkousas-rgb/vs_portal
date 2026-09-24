/* ============================================================
   tests/_audit-run.mjs — 按鈕審計 worker（一個模式×角色×分頁 = 一個新 jsdom）
   由 tests/audit-buttons.mjs spawn，唔好直接跑。
   用法：node tests/_audit-run.mjs <mock|real> <chief|leader|exco|super> <section>
   輸出：stdout 一段 JSON 報告
   ============================================================ */

import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [,, MODE, ROLE, SECTION] = process.argv;
if (!MODE || !ROLE || !SECTION) { console.error('用法：node tests/_audit-run.mjs <mode> <role> <section>'); process.exit(2); }

const URL_BASE = MODE === 'mock' ? 'http://localhost:8080/?mock=1&u=MOCK' : 'http://localhost:8080/?u=0082';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 副作用計數器 ---------- */
const fx = { nav: 0, dl: 0, print: 0, clip: 0 };
const errors = []; // {t, msg}
/* jsdom 環境缺失（真實瀏覽器完全正常）：
   window.open＝開新分頁、window.print/focus＝彈列印框（exporter.printDoc 用隱藏 iframe）。
   呢啲只係 jsdom 報「Not implemented」，唔係 app bug —— 歸類做 env-ok。 */
const ENV_RE = /Not implemented: window\.(open|print|focus)/;

const origError = console.error;
console.error = (...a) => {
  const msg = a.map(String).join(' ');
  errors.push({ t: Date.now(), msg });
};

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e?.message || e);
  if (/Not implemented: navigation/.test(msg)) { fx.nav++; return; }
  if (/Not implemented: (form submission|HTMLFormElement)/.test(msg)) { fx.nav++; return; }
  if (/Could not parse CSS/.test(msg)) return;
  errors.push({ t: Date.now(), msg });
});

/* ---------- fetch shim：由 repo 讀檔（/api/* 當 404＝本地冇 env 變數） ---------- */
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  if (/^api\//.test(clean)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* 超管核對而家喺伺服器端（api/auth.js）—— 裝返個有設環境變數嘅「伺服器」。
   注意：上面個 shim 對所有 api/* 一律回 404，installSuperAuth 會先截 api/auth。 */
const { installSuperAuth, TEST_SUPER_PASSWORD } = await import('./_authstub.mjs');
installSuperAuth();

/* ---------- DOM ---------- */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: URL_BASE, pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole: vc });
const { window } = dom;
window.scrollTo = () => {};
window.print = () => { fx.print++; };
window.URL.createObjectURL = () => { fx.dl++; return 'blob:audit'; };
window.URL.revokeObjectURL = () => {};
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
try {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async () => { fx.clip++; } }, configurable: true
  });
} catch { /* jsdom 舊版 navigator 唯讀 → 照計（copyText 會 fallback 提示，都算有反應） */ }
if (typeof window.HashChangeEvent === 'undefined') window.HashChangeEvent = window.Event;
globalThis.HashChangeEvent = window.HashChangeEvent || window.Event;  /* router.js go() 用裸 global */
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
  'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob',
  'FileReader', 'MouseEvent', 'history']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch { /* 唯讀 → 略過 */ }
}
globalThis.window = window;

const doc = window.document;
const appEl = () => doc.getElementById('app');
const errorsSince = (t0) => errors.filter(e => e.t >= t0);

/* ---------- 載入 app ---------- */
const auth = await import('../assets/js/lib/auth.js');
const store = await import('../assets/js/lib/store.js');
const util = await import('../assets/js/lib/util.js');
await import('../assets/js/main.js');
await wait(350);

/* ---------- 登入目標角色 ----------
   ★ 2026-09-24：冇共用帳戶 —— 角色由名冊身份決定（見 tests/_roles.mjs）。
   示範模式用示範團員改身份；真實模式種個人帳號（loginId：chief／leader／exco）。 */
const needSeed = MODE !== 'mock' && ROLE !== 'super';
const { seedRosterRoles, ROLE_PW } = await import('./_roles.mjs');
if (needSeed) await seedRosterRoles(store, auth);
if (MODE === 'mock') {
  if (ROLE !== 'leader') { auth.logout(); auth.loginAsMock(ROLE); }
} else if (ROLE === 'super') {
  const r = await auth.login('leader', 'sheep', TEST_SUPER_PASSWORD);
  if (!r.ok) throw new Error('super 登入失敗');
} else {
  const r = await auth.login(ROLE, ROLE, ROLE_PW[ROLE] || '8202');
  if (!r.ok) throw new Error(ROLE + ' 登入失敗: ' + r.msg);
}
doc.body.classList.remove('login-body');
window.location.hash = '#/' + SECTION;
await wait(250);

/* ---------- 快照 ---------- */
function lsSig() {
  const out = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      out[k] = window.localStorage.getItem(k);
    }
  } catch { /* ignore */ }
  return JSON.stringify(out);
}
function snap() {
  return {
    hash: window.location.hash,
    app: appEl()?.innerHTML || '',
    overlays: doc.querySelectorAll('.overlay').length,
    toasts: [...(doc.getElementById('toasts')?.children || [])].map(t => t.textContent || ''),
    iframes: doc.querySelectorAll('iframe[aria-hidden="true"]').length,  /* exporter.printDoc 隱藏列印 iframe */
    ls: lsSig(),
    fx: { ...fx }
  };
}

/** 有冇「新」toast（同文字嘅 toast 都會疊加 → 用 multiset 對比，唔係 set） */
function hasNewToast(base, after) {
  const c = {};
  for (const t of (base.toasts || [])) c[t] = (c[t] || 0) + 1;
  for (const t of (after.toasts || [])) {
    c[t] = (c[t] || 0) - 1;
    if (c[t] < 0) return true;
  }
  return false;
}

/* ---------- 審計一個元素 ---------- */
const DestructiveRe = /確定|確認|刪除|删除|清除|重設|抹黑|還原預設|wipes|清空/i;
const seen = new Set();
const results = [];

function btnKey(el) {
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  const id = el.id ? '#' + el.id : '';
  const title = el.title || el.getAttribute('aria-label') || '';
  const inner = (el.innerHTML || '').slice(0, 60);
  return [id, title, text, inner].join('|');
}

async function closeOverlaysTo(n) {
  for (let i = 0; i < 5 && doc.querySelectorAll('.overlay').length > n; i++) util.closeModal(null);
  await wait(50);
}

/** 審計一個 modal 入面嘅掣（深度有限） */
async function auditOverlay(overlay, depth, ctx) {
  if (depth > 2) return;
  /* 填埋表單欄（let validation pass），然後逐个掣試 */
  overlay.querySelectorAll('input,textarea,select').forEach(inp => {
    const t = (inp.type || '').toLowerCase();
    if (['file', 'checkbox', 'radio', 'range'].includes(t)) return;
    if (t === 'password') { inp.value = 'audit-test'; return; }
    if (t === 'date' || t === 'datetime-local') { inp.value = '2026-09-17'; return; }
    if (t === 'number') { inp.value = '100'; return; }
    if (inp.tagName === 'SELECT') { inp.selectedIndex = 0; return; }
    inp.value = 'audit-test';
  });

  /* 注意：撳完一個掣彈窗可能已經關咗（X／取消），舊元素脫離文件——
     所以每一輪重新 query，脫咗嘅就跳過。 */
  for (let i = 0; i < 20; i++) {
    const b = [...overlay.querySelectorAll('button:not([disabled]), input[type=submit]')]
      .find(x => x.isConnected && !x.dataset.auditDone);
    if (!b) break;
    b.dataset.auditDone = '1';
    const label = ((b.textContent || b.value) || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const base = snap();
    if (DestructiveRe.test(label) && overlay.querySelector('.modal-foot [data-act]') ) {
      /* confirm 彈窗嘅「確認」掣：唔好撳埋（會真係刪除／重設），記為跳過 */
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'skip-destructive', errors: [] });
      continue;
    }
    const t0 = Date.now();
    errors.length = 0;  /* 清走上一個掣嗰啲延遲 error（例如 320ms 先跑嘅 iframe print），避免串號 */
    try { b.click(); } catch (e) { results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'exception', errors: [String(e?.message || e)] }); continue; }
    await wait(160);
    const after = snap();
    const errs = errorsSince(t0).map(e => e.msg);
    const realErrs = errs.filter(m => !ENV_RE.test(m));
    if (after.overlays > base.overlays) {
      /* 開了新彈窗 → 深入審計，然後收埋 */
      const fresh = [...doc.querySelectorAll('.overlay')][doc.querySelectorAll('.overlay').length - 1];
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'modal', errors: errs });
      await auditOverlay(fresh, depth + 1, ctx);
    } else if (after.overlays < base.overlays) {
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'closed-modal', errors: errs });
    } else if (hasNewToast(base, after) || after.app !== base.app || after.hash !== base.hash
      || after.ls !== base.ls || after.fx.nav > base.fx.nav || after.fx.dl > base.fx.dl
      || after.fx.print > base.fx.print || after.fx.clip > base.fx.clip
      || after.iframes > base.iframes) {
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'effect', errors: errs });
    } else if (realErrs.length) {
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'exception', errors: errs });
    } else if (errs.length) {
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'env-ok', errors: errs });
    } else {
      results.push({ ctx, where: 'modal', key: btnKey(b), label, effect: 'dead', errors: errs });
    }
    await closeOverlaysTo(base.overlays);
  }

  /* 表單：dispatch submit（app 應該 preventDefault） */
  for (const form of overlay.querySelectorAll('form')) {
    const base = snap();
    const t0 = Date.now();
    const ev = new window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    await wait(140);
    const after = snap();
    const errs = errorsSince(t0).map(e => e.msg).filter(m => !ENV_RE.test(m));
    const eff = hasNewToast(base, after) || after.app !== base.app || after.hash !== base.hash
      || after.ls !== base.ls || after.fx.nav > base.fx.nav || after.overlays > base.overlays;
    results.push({ ctx, where: 'modal', key: 'form:' + (form.id || form.outerHTML.slice(0, 40)), label: '(form submit)', effect: ev.defaultPrevented || eff ? 'effect' : (errs.length ? 'exception' : 'dead'), errors: errs });
    await closeOverlaysTo(base.overlays);
  }
}

/** 審計一個範圍嘅全部可撳元素。
    scopeSel 係 selector——render() 每次重寫 app.innerHTML，舊元素引用會失效，
    所以每一輪都要重新 query scope 自己（否則撳到脫離文件嘅死元素＝假 dead）。 */
async function auditScope(scopeSel, ctx, opts = {}) {
  const done = new Set();
  for (let i = 0; i < 100; i++) {
    /* 頂欄／側欄／bottom bar：每個掣都要由「有效果可觀察」嘅起點撳。
       理由：同一個目的地可以有多個響應式分身（例：#btnPw 桌面版同 #btnPw2 手機版
       都係「改密碼 → #/admin/data」）。第一個撳完已經去咗目的地，第二個由同一個
       hash 再撳就冇任何變化 → 假 dead。每次撳之前返去「唔係而家分頁」嘅 hash，
       咁每個掣（包括分身）都真係會轉頁，dead 就只剩返真正冇反應嘅掣。
       render() 重寫 app.innerHTML，所以要 continue 之後重新 query scope。 */
    if (opts.resetHash && window.location.hash !== opts.resetHash) {
      window.location.hash = opts.resetHash;
      await wait(180);
      continue;
    }
    const scope = typeof scopeSel === 'string' ? doc.querySelector(scopeSel) : scopeSel;
    if (!scope || !scope.isConnected) break;
    const el = [...scope.querySelectorAll('button:not([disabled]), input[type=submit], input[type=button], a[href]')]
      .find(x => x.isConnected && !done.has(btnKey(x) + '§' + (x.className || '')));
    if (!el) break;
    done.add(btnKey(el) + '§' + (el.className || ''));
    const k = window.location.hash + '§' + btnKey(el);
    if (seen.has(k)) continue;
    seen.add(k);

    const label = ((el.textContent || el.value) || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (/^https?:/i.test(href)) { results.push({ ctx, key: btnKey(el), label, effect: 'link-external', errors: [] }); continue; }
    }
    /* 已經 active 嘅分頁／篩選／導覽掣再撳一次＝重渲染同一狀態，冇變化係正常。
       （側邊欄用 aria-current="page"，bottom bar 用 aria-current 同款寫法。） */
    const alreadyActive = el.getAttribute('aria-selected') === 'true'
      || el.getAttribute('aria-pressed') === 'true'
      || el.getAttribute('aria-current') === 'page'
      || el.classList.contains('active');

    /* 撳一次、等 160ms、睇有冇反應；反應分類抽成函數，因為「dead」會 retry 一次（見下）。 */
    async function clickAndClassify(target, waitMs) {
      const base = snap();
      const t0 = Date.now();
      errors.length = 0;
      let threw = null;
      try { target.click(); } catch (e) { threw = String(e?.message || e); }
      await wait(waitMs);
      const after = snap();
      const errs = errorsSince(t0).map(e => e.msg);
      const realErrs = errs.filter(m => !ENV_RE.test(m));
      let eff;
      if (threw) eff = 'exception';
      else if (realErrs.length) eff = 'exception';
      else if (after.fx.nav > base.fx.nav) eff = 'navigate';
      else if (after.overlays > base.overlays) eff = 'modal';
      else if (hasNewToast(base, after)) eff = 'toast';
      else if (after.app !== base.app) eff = 'dom';
      else if (after.ls !== base.ls) eff = 'state';
      else if (after.fx.dl > base.fx.dl) eff = 'download';
      else if (after.fx.print > base.fx.print) eff = 'print';
      else if (after.fx.clip > base.fx.clip) eff = 'clipboard';
      else if (after.iframes > base.iframes) eff = 'printdoc';
      else if (errs.length) eff = 'env-ok';
      else eff = 'dead';
      return { eff, after, errs, threw, base };
    }

    const first = await clickAndClassify(el, 160);
    let effect = first.eff;
    const after = first.after, errs = first.errs, threw = first.threw, base = first.base;

    /* ★ 假 dead 防護：jsdom 有時遲過 160ms 先報「Not implemented: window.open」
       （公開頁預覽就係咁：第一次撳落去好似冇反應），又或者上一輪嘅重排打斷咗 render。
       真 dead 掣撳兩次都應該冇反應，所以「dead」一律再撳一次（重新 query，
       因為 render() 可能已經換咗個元素），第二次都話 dead 先算數。 */
    if (effect === 'dead') {
      const scopeNow = typeof scopeSel === 'string' ? doc.querySelector(scopeSel) : scopeSel;
      const again = scopeNow ? [...scopeNow.querySelectorAll('button:not([disabled]), input[type=submit], input[type=button], a[href]')]
        .find(x => x.isConnected && btnKey(x) === btnKey(el)) : null;
      if (again) {
        const second = await clickAndClassify(again, 320);
        if (second.eff !== 'dead') effect = second.eff;
      }
    }

    if (effect === 'modal') {
      const fresh = [...doc.querySelectorAll('.overlay')][doc.querySelectorAll('.overlay').length - 1];
      await auditOverlay(fresh, 1, ctx + ':modal');
      await closeOverlaysTo(base.overlays);
    } else if (effect === 'dead' && DestructiveRe.test(label)) {
      effect = 'skip-destructive';
    } else if (effect === 'dead' && alreadyActive) {
      effect = 'active-noop';
    }
    results.push({ ctx, key: btnKey(el), label, effect, hashAfter: after.hash, errors: threw ? [threw, ...errs] : errs });
  }

  /* 有 onclick 屬性嘅非 button 元素（例如 sync chip 個 span） */
  const scope = typeof scopeSel === 'string' ? doc.querySelector(scopeSel) : scopeSel;
  for (const el of (scope ? [...scope.querySelectorAll('span,div')] : [])) {
    if (!el.isConnected || typeof el.onclick !== 'function' || el.closest('button,a')) continue;
    const k = window.location.hash + '§onclick§' + btnKey(el);
    if (seen.has(k)) continue;
    seen.add(k);
    const label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const base = snap();
    const t0 = Date.now();
    errors.length = 0;
    let threw = null;
    try { el.click(); } catch (e) { threw = String(e?.message || e); }
    await wait(160);
    const after = snap();
    const errs = errorsSince(t0).map(e => e.msg);
    const realErrs = errs.filter(m => !ENV_RE.test(m));
    let effect;
    if (threw) effect = 'exception';
    else if (realErrs.length) effect = 'exception';
    else if (after.fx.nav > base.fx.nav) effect = 'navigate';
    else if (after.overlays > base.overlays) effect = 'modal';
    else if (hasNewToast(base, after)) effect = 'toast';
    else if (after.app !== base.app) effect = 'dom';
    else if (after.iframes > base.iframes) effect = 'printdoc';
    else if (errs.length) effect = 'env-ok';
    else effect = 'dead';
    if (effect === 'modal') {
      const fresh = [...doc.querySelectorAll('.overlay')][doc.querySelectorAll('.overlay').length - 1];
      await auditOverlay(fresh, 1, ctx + ':modal');
      await closeOverlaysTo(base.overlays);
    }
    results.push({ ctx, key: btnKey(el), label, effect, hashAfter: after.hash, errors: threw ? [threw, ...errs] : errs });
  }
}

/* ============================================================ */
const walked = [];

/* 1) 分頁 root + 每個 tab（真撳分頁掣行）—— 要擺前，因為撳側邊欄會轉 hash */
async function auditViewAt(ctx) {
  const beforeOverlays = doc.querySelectorAll('.overlay').length;
  await auditScope('#view', ctx);
  await closeOverlaysTo(beforeOverlays);
  /* 表單 */
  const view = doc.querySelector('#view');
  for (const form of (view ? view.querySelectorAll('form') : [])) {
    const base = snap();
    const t0 = Date.now();
    const ev = new window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    await wait(140);
    const after = snap();
    const errs = errorsSince(t0).map(e => e.msg).filter(m => !ENV_RE.test(m));
    const eff = hasNewToast(base, after) || after.app !== base.app || after.hash !== base.hash
      || after.ls !== base.ls || after.fx.nav > base.fx.nav || after.overlays > base.overlays;
    results.push({ ctx, key: 'form:' + (form.id || form.outerHTML.slice(0, 40)), label: '(form submit)', effect: ev.defaultPrevented || eff ? 'effect' : (errs.length ? 'exception' : 'dead'), errors: errs });
    await closeOverlaysTo(base.overlays);
  }
  walked.push({ ctx, hash: window.location.hash });
}

await auditViewAt(SECTION + ':root');

const TAB_AT_ROOT = { inventory: 'items' };  /* 同 main.js */
const tabHashOf = (tab) => TAB_AT_ROOT[SECTION] === tab ? `#/${SECTION}` : `#/${SECTION}/${tab}`;
const tabIds = [...new Set([...doc.querySelectorAll('#view [data-tabnav] [data-tab]')].map(b => b.dataset.tab).filter(Boolean))];
for (const tab of tabIds) {
  const target = tabHashOf(tab);
  if (window.location.hash === target) {
    /* 而家正喺呢個分頁（root 已經審過）→ 唔使重複撳 */
    continue;
  }
  /* 每次先返返 root 再撳，確保分頁掣有「可觀察」嘅變化 */
  if (window.location.hash !== `#/${SECTION}`) { window.location.hash = `#/${SECTION}`; await wait(150); }
  const btn = [...doc.querySelectorAll('#view [data-tabnav] [data-tab]')].find(b => b.dataset.tab === tab);
  if (!btn) continue;
  const t0 = Date.now();
  try { btn.click(); } catch (e) { results.push({ ctx: SECTION + ':' + tab, key: 'tab', label: tab, effect: 'exception', errors: [String(e?.message || e)] }); continue; }
  await wait(200);
  const tabErrs = errorsSince(t0).map(e => e.msg).filter(m => !ENV_RE.test(m));
  if (tabErrs.length) {
    results.push({ ctx: SECTION + ':' + tab, key: 'tab', label: '分頁:' + tab, effect: 'exception', errors: tabErrs });
  }
  await auditViewAt(SECTION + ':' + tab);
}

/* 2) 側邊欄／頂欄／手機 bottom bar（審埋最後，因為撳佢哋會轉去別的分頁）。
   先跳去一個「唔係而家分頁」嘅 hash，否則撳返目前 active 嘅 nav 掣冇變化＝假 dead。
   resetHash：每個掣撳之前都返返呢個 hash（見 auditScope 上面註解）。 */
const awayHash = SECTION === 'finance' ? '#/meetings' : '#/finance';
window.location.hash = awayHash;
await wait(200);
await auditScope('nav.sidebar', 'shell:sidebar', { resetHash: awayHash });
await closeOverlaysTo(0);
await auditScope('header.topbar', 'shell:topbar', { resetHash: awayHash });
await closeOverlaysTo(0);
await auditScope('nav.tabbar', 'shell:tabbar', { resetHash: awayHash });
await closeOverlaysTo(0);

/* ---------- 輸出 ---------- */
const count = (e) => results.filter(r => r.effect === e).length;
console.log(JSON.stringify({
  mode: MODE, role: ROLE, section: SECTION,
  walked: walked.map(w => w.hash),
  totals: {
    tested: results.length,
    broken: results.filter(r => r.effect === 'exception').length,
    dead: results.filter(r => r.effect === 'dead').length,
    modal: count('modal'), effect: count('effect'), toast: count('toast'), dom: count('dom'),
    state: count('state'), navigate: count('navigate'), closed: count('closed-modal'),
    download: count('download'), print: count('print'), clipboard: count('clipboard'),
    link: count('link-external'), skip: count('skip-destructive'), activeNoop: count('active-noop'),
    envOk: count('env-ok'), printdoc: count('printdoc')
  },
  problems: results.filter(r => r.effect === 'exception' || r.effect === 'dead')
    .map(r => ({ ...r, errors: r.errors.slice(0, 3) }))
}, null, 1));
process.exit(0);
