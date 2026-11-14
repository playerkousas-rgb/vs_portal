/* Modal／overlay 行為迴歸：async action、nested modal、換頁後不可留遮罩。 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><main id="app"><button id="pageBtn">頁面按鈕</button></main></body>', {
  url: 'https://example.test/#/progress/settings', pretendToBeVisual: true
});
const { window } = dom;
for (const k of ['window', 'document', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent', 'Node']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? window : window[k], configurable: true, writable: true });
}
const util = await import('../assets/js/lib/util.js?modal-test=' + Date.now());
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n▌Modal / overlay 迴歸測試');

const ui = await import('../assets/js/views/ui.js?modal-test=' + Date.now());
const styleProbe = document.createElement('div');
styleProbe.innerHTML = ui.progressBar('100%;background:url(javascript:alert(1))', 'x" onmouseover="alert(1)');
ok('共用進度條只接受有限數字同已知 tone，動態 style／class 唔可注入',
  styleProbe.querySelector('.bar')?.className === 'bar danger'
    && styleProbe.querySelector('.bar > span')?.getAttribute('style') === 'width:0%'
    && !styleProbe.querySelector('[onmouseover]'));
ok('共用百分比會將負數／超過 100／非有限值夾返 0–100',
  ui.boundedPercent(-8) === 0 && ui.boundedPercent(240) === 100
    && ui.boundedPercent('55.5') === 55.5 && ui.boundedPercent(Infinity) === 0);
const visProbe = document.createElement('div');
visProbe.innerHTML = ui.visSelect('quiz', 'member', 'id="safe-id" onmouseover="alert(1)');
ok('可見範圍下拉拒絕 raw 額外屬性，只接受單一安全 id',
  !visProbe.querySelector('[onmouseover]') && !visProbe.querySelector('#safe-id'));
visProbe.innerHTML = ui.visSelect('quiz', 'member', 'id="safe-id"');
ok('可見範圍下拉仍保留合法靜態 id', !!visProbe.querySelector('#safe-id'));

// title/sub/action metadata are plain text; imported labels must not become HTML attributes/elements.
const safeMeta = util.modal({
  title: '安全測試', sub: '<img id="sub-pwn" src=x onerror=alert(1)>', trustedBodyHtml: '<p>trusted body</p>',
  actions: [{ label: '<img id="label-pwn">', class: 'x" onmouseover="alert(1)', value: null }]
});
const safeOverlay = document.querySelector('.overlay');
ok('modal sub／action label／class 會 escape，唔會變成注入元素或事件屬性',
  !safeOverlay.querySelector('#sub-pwn') && !safeOverlay.querySelector('#label-pwn')
    && !safeOverlay.querySelector('[onmouseover]') && safeOverlay.textContent.includes('<img id="sub-pwn"'));
safeOverlay.querySelector('[data-act="0"]').click();
await safeMeta;

const safeBody = util.modal({
  title: '純文字 body', bodyText: '<img id="body-pwn" src=x onerror=alert(1)>',
  actions: [{ label: '關閉', value: null }]
});
const bodyOverlay = document.querySelector('.overlay');
ok('modal bodyText 預設當純文字 escape',
  !bodyOverlay.querySelector('#body-pwn') && bodyOverlay.textContent.includes('<img id="body-pwn"'));
bodyOverlay.querySelector('[data-act="0"]').click();
await safeBody;
let legacyBodyRejected = false;
try { util.modal({ title: '舊 API', body: '<b>ambiguous</b>' }); } catch { legacyBodyRejected = true; }
ok('modal 拒絕含糊舊 body API，必須揀 bodyText／trustedBodyHtml', legacyBodyRejected);

// Sync conflict markup is application-authored HTML, but every record/timestamp/count still
// crosses an escaping or numeric-normalization boundary before trustedBodyHtml.
const syncdialog = await import('../assets/js/views/syncdialog.js?modal-test=' + Date.now());
const conflictDialog = syncdialog.resolveConflictsDialog({
  conflicts: [{
    key: 'settings/troopName', path: ['settings', 'troopName'],
    mine: { kind: 'set', to: '<img id="mine-pwn">' },
    theirs: { kind: 'set', to: '<img id="theirs-pwn">' }
  }],
  ctx: {
    local: { settings: { troopName: '<img id="mine-pwn">' } },
    remote: { settings: { troopName: '<img id="theirs-pwn">' } }
  },
  mode: 'save', remoteAt: '<img id=when-pwn>', savedCount: '<img id="count-pwn">'
});
const conflictOverlay = document.querySelector('.overlay');
ok('同步衝突視窗用明確 trustedBodyHtml，應用程式表格仍正常 render',
  !!conflictOverlay.querySelector('table input[data-k]'));
ok('同步衝突嘅值／時間／數量唔會穿過 trusted HTML 邊界注入元素',
  !conflictOverlay.querySelector('#mine-pwn') && !conflictOverlay.querySelector('#theirs-pwn')
    && !conflictOverlay.querySelector('#when-pwn') && !conflictOverlay.querySelector('#count-pwn')
    && conflictOverlay.textContent.includes('<img id="mine-pwn">'));
conflictOverlay.querySelector('[data-act="0"]').click();
const conflictResult = await conflictDialog;
ok('同步衝突視窗保留後端後正常回傳空 useMine 清單',
  Array.isArray(conflictResult?.useMine) && conflictResult.useMine.length === 0);

const safeConfirm = util.confirmDlg({ title: '確認', message: '<img id="confirm-pwn">確定？' });
const confirmOverlay = document.querySelector('.overlay');
ok('confirmDlg message 預設當純文字 escape',
  !confirmOverlay.querySelector('#confirm-pwn') && confirmOverlay.textContent.includes('<img id="confirm-pwn">'));
confirmOverlay.querySelector('[data-act="0"]').click();
await safeConfirm;

const guard = await import('../assets/js/lib/guard.js?modal-test=' + Date.now());
const safeDanger = guard.confirmDanger({
  title: '危險確認', message: '<img id="danger-pwn" src=x onerror=alert(1)>刪除？', requireText: '刪除'
});
await wait(0);
const dangerOverlay = document.querySelector('.overlay');
ok('confirmDanger message 預設當純文字 escape',
  !dangerOverlay.querySelector('#danger-pwn') && dangerOverlay.textContent.includes('<img id="danger-pwn"'));
dangerOverlay.querySelector('[data-act="0"]').click();
await safeDanger;

const trustedDanger = guard.confirmDanger({
  title: '可信確認', trustedMessageHtml: '<strong id="danger-trusted">應用程式可信標記</strong>', requireText: '確認'
});
await wait(0);
const trustedDangerOverlay = document.querySelector('.overlay');
ok('confirmDanger 只有明確 trustedMessageHtml 會當 HTML render',
  trustedDangerOverlay.querySelector('#danger-trusted')?.textContent === '應用程式可信標記');
trustedDangerOverlay.querySelector('[data-act="0"]').click();
await trustedDanger;

let invalidTrustedDangerRejected = false;
try {
  await guard.confirmDanger({ trustedMessageHtml: { unsafe: true } });
} catch (err) {
  invalidTrustedDangerRejected = err instanceof TypeError;
}
ok('confirmDanger 拒絕非字串 trustedMessageHtml', invalidTrustedDangerRejected);

// async onClick 回 false：完成之前唔可提早關；完成後應留窗並恢復按鈕。
let release;
const held = util.modal({
  title: 'Async', trustedBodyHtml: '<p>test</p>',
  actions: [{ label: '執行', class: 'btn-primary', onClick: async () => {
    await new Promise(r => { release = r; });
    return false;
  } }]
});
const asyncBtn = document.querySelector('.overlay [data-act="0"]');
asyncBtn.click();
await wait(0);
ok('async modal action 未完成時 overlay 仍在', document.querySelectorAll('.overlay').length === 1);
ok('async modal action 期間按鈕 disabled，避免重複提交', asyncBtn.disabled === true);
release();
await wait(0);
ok('async action 回 false 會保留 modal 並恢復按鈕', document.querySelectorAll('.overlay').length === 1 && asyncBtn.disabled === false);
util.closeModal(null);
await held;

// 明確 value:null 必須原樣回 null；唔可以用 ?? 變成 true（會誤觸發提交）。
const later = util.modal({
  title: '稍後處理', trustedBodyHtml: '<p>not now</p>',
  actions: [{ label: '稍後', class: 'btn', value: null }]
});
document.querySelector('.overlay [data-act="0"]').click();
const laterResult = await later;
ok('modal 明確 value:null 原樣回傳，不會誤當 true', laterResult === null && document.querySelectorAll('.overlay').length === 0);

// nested modal：外層 async callback 等內層，內層完成只關自己，之後外層正常關。
const outer = util.modal({
  title: 'Outer', trustedBodyHtml: '<p>outer</p>',
  actions: [{ label: '連結 BADGE', class: 'btn-primary', onClick: async () => {
    const inner = await util.modal({
      title: 'Inner', trustedBodyHtml: '<p>confirm</p>',
      actions: [{ label: '確定', class: 'btn-primary', value: true }]
    });
    return inner;
  } }]
});
document.querySelector('.overlay [data-act="0"]').click();
await wait(0);
ok('async action 可以安全打開第二層 modal', document.querySelectorAll('.overlay').length === 2);
const overlays = [...document.querySelectorAll('.overlay')];
overlays[1].querySelector('[data-act="0"]').click();
const outerResult = await outer;
await wait(0);
ok('nested modal 關閉次序正確，唔會留透明 overlay', outerResult === true && document.querySelectorAll('.overlay').length === 0);

// X 只關當前一層（舊版 onclick + bubbling 會一次關兩層）。
const p1 = util.modal({ title: 'Layer 1', trustedBodyHtml: 'one' });
const p2 = util.modal({ title: 'Layer 2', trustedBodyHtml: 'two' });
await wait(0);
const layers = [...document.querySelectorAll('.overlay')];
layers[1].querySelector('[data-close-x]').click();
await p2;
ok('第二層 X 只關第二層，第一層仍在', document.querySelectorAll('.overlay').length === 1);
util.closeModal(null);
await p1;

// 模擬 BADGE 操作後 hashchange / refresh：清 stack，再畫頁面，底層按鈕可點。
let clicked = 0;
const pending = util.modal({
  title: 'BADGE 接駁', trustedBodyHtml: '處理中',
  actions: [{ label: '接駁', class: 'btn-primary', onClick: async () => {
    await wait(20);
    return true;
  } }]
});
document.querySelector('.overlay [data-act="0"]').click();
util.closeAllModals(null);
document.getElementById('app').innerHTML = '<button id="afterRoute">換頁後按鈕</button>';
document.getElementById('afterRoute').addEventListener('click', () => { clicked++; });
document.getElementById('afterRoute').click();
await pending;
await wait(30);
ok('refresh/hashchange 後冇殘留 overlay，下一頁按鈕可正常點擊', document.querySelectorAll('.overlay').length === 0 && clicked === 1);

console.log(`\n${fail === 0 ? '✅' : '❌'} Modal：${pass} 過 / ${fail} 唔過`);
process.exit(fail === 0 ? 0 : 1);
