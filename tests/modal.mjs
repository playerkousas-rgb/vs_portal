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

// async onClick 回 false：完成之前唔可提早關；完成後應留窗並恢復按鈕。
let release;
const held = util.modal({
  title: 'Async', body: '<p>test</p>',
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
  title: '稍後處理', body: '<p>not now</p>',
  actions: [{ label: '稍後', class: 'btn', value: null }]
});
document.querySelector('.overlay [data-act="0"]').click();
const laterResult = await later;
ok('modal 明確 value:null 原樣回傳，不會誤當 true', laterResult === null && document.querySelectorAll('.overlay').length === 0);

// nested modal：外層 async callback 等內層，內層完成只關自己，之後外層正常關。
const outer = util.modal({
  title: 'Outer', body: '<p>outer</p>',
  actions: [{ label: '連結 BADGE', class: 'btn-primary', onClick: async () => {
    const inner = await util.modal({
      title: 'Inner', body: '<p>confirm</p>',
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
const p1 = util.modal({ title: 'Layer 1', body: 'one' });
const p2 = util.modal({ title: 'Layer 2', body: 'two' });
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
  title: 'BADGE 接駁', body: '處理中',
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
