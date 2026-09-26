/* ============================================================
   tests/drafts.mjs — 草稿防呆回歸（2026-09-25 修正）
   ------------------------------------------------------------
   之前嘅病：bindDraftAutosave() 一入分頁就 register 咗 flush，
   flush 又無條件 saveDraft()。所以「純粹撳入入面再轉走、乜都冇掂過」
   都會生成一份草稿，main.js 轉分頁嗰陣就彈
   「呢個分頁有 1 份未完成草稿」嘅假警告。

   修正：flush 之前對返「入版嗰陣」嘅欄位值（baseline），一樣就唔寫、
   唔報告；真係改過先暫存。另外 stop() 會解除追蹤。
   ============================================================ */

import {
  bindDraftAutosave, stashActiveDrafts, activeDrafts, clearActiveDrafts,
  saveDraft, readDraft, clearDraft, dropAllDrafts, applyDraft
} from '../assets/js/lib/guard.js';

let pass = 0, fail = 0, t = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(x) { console.log('\n▌' + x); }

/* ---------- 最細 localStorage shim ---------- */
const ls = new Map();
globalThis.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: k => { ls.delete(k); }
};

/* ---------- 最細 DOM 元素 shim ---------- */
function mkFields(values) {
  /* values: { name: string|boolean … } → 一系列 [data-draft] 欄位 */
  const els = Object.entries(values).map(([k, v]) => {
    const el = {
      dataset: { draft: k },
      type: typeof v === 'boolean' ? 'checkbox' : 'text',
      value: typeof v === 'boolean' ? undefined : String(v),
      checked: typeof v === 'boolean' ? v : undefined,
      handlers: {},
      addEventListener(ev, fn) { (this.handlers[ev] ||= []).push(fn); },
      fire(ev) { (this.handlers[ev] || []).forEach(fn => fn()); }
    };
    return el;
  });
  const root = {
    _els: els,
    querySelectorAll(sel) {
      if (sel !== '[data-draft]') return [];
      return [...this._els];
    },
    querySelector(sel) {
      if (sel === '[data-draft-stamp]') return this._stamp || null;
      if (sel === '[data-draft-banner]') return this._banner || null;
      return null;
    },
    _stamp: null
  };
  return { root, els };
}

function setValue(els, k, v) {
  const el = els.find(e => e.dataset.draft === k);
  if (!el) return;
  if (typeof v === 'boolean') { el.checked = v; } else { el.value = String(v); }
  el.fire('input'); el.fire('change');
}

/* ============================================================ */
dropAllDrafts();
section('① 純粹入分頁再轉走（冇掂過）→ 唔應該有草稿');

{
  dropAllDrafts(); clearActiveDrafts();
  const { root } = mkFields({ name: '陳大文', phone: '9111 1111', role: '主席' });
  const a = bindDraftAutosave(root, 'member', 'new');

  // 模擬「入版 → 轉分頁」：乜都冇改
  const n = stashActiveDrafts();
  ok('轉分頁回報 0 份草稿（唔係 1 份）', n === 0, `n=${n}`);
  ok('冇寫入任何草稿紀錄', readDraft('member', 'new') === null);
  ok('activeDrafts() 係空', activeDrafts().length === 0);

  a.stop();
}

section('② 真係改咗 → 轉分頁先至暫存兼回報');
{
  dropAllDrafts(); clearActiveDrafts();
  const { root, els } = mkFields({ name: '陳大文', phone: '', role: '主席' });
  const a = bindDraftAutosave(root, 'member', 'new');
  setValue(els, 'phone', '9222 2222');                    // 真係改咗一格

  const n = stashActiveDrafts();
  ok('轉分頁回報 1 份草稿', n === 1, `n=${n}`);
  const rec = readDraft('member', 'new');
  ok('草稿已暫存', !!rec, JSON.stringify(rec && rec.data));
  ok('暫存嘅係改咗之後嘅值', rec && rec.data.phone === '9222 2222');

  a.stop(); clearDraft('member', 'new');
}

section('③ 改完又改返原樣 → 唔會冤枉佢');
{
  dropAllDrafts(); clearActiveDrafts();
  const { root, els } = mkFields({ name: '陳大文', phone: '9111 1111' });
  const a = bindDraftAutosave(root, 'member', 'new');
  setValue(els, 'phone', '9333 3333');     // 改
  setValue(els, 'phone', '9111 1111');     // 改返原樣

  const n = stashActiveDrafts();
  ok('內容同入版一樣 → 0 份草稿', n === 0, `n=${n}`);
  ok('冇草稿寫落', readDraft('member', 'new') === null);

  a.stop();
}

section('④ stop() 解除追蹤（轉分頁 render 拆除嗰陣）');
{
  dropAllDrafts(); clearActiveDrafts();
  const { root } = mkFields({ name: '陳大文' });
  const a = bindDraftAutosave(root, 'member', 'new');
  a.stop();                                               // render 拆除 / 轉分頁

  const n = stashActiveDrafts();
  ok('停咗監聽之後唔再回報', n === 0, `n=${n}`);
}

section('⑤ markDirty()（applyDraft 回填）：欄位值冇變都要照暫存');
{
  dropAllDrafts(); clearActiveDrafts();
  // 先整一份「入版前」舊草稿
  saveDraft('member', 'm7', { name: '舊名', phone: '9999 9999' });

  // 入版：欄位用資料庫值；applyDraft 回填舊草稿（值同入版唔同）
  const { root, els } = mkFields({ name: '新名', phone: '1111 1111' });
  const a = bindDraftAutosave(root, 'member', 'm7');
  applyDraft(root, 'member', 'm7');     // 回填 name=舊名 phone=9999…
  a.markDirty();

  const n = stashActiveDrafts();
  ok('回填咗舊草稿 → 轉分頁當作有草稿', n === 1, `n=${n}`);
  const rec = readDraft('member', 'm7');
  ok('暫存內容 = 回填後嘅值', rec && rec.data.name === '舊名' && rec.data.phone === '9999 9999');

  a.stop(); clearDraft('member', 'm7');
}

section('⑥ 回填咗舊草稿但**冇** markDirty → 唔會冤枉（欄位同入版一樣嗰陣）');
{
  dropAllDrafts(); clearActiveDrafts();
  saveDraft('fin-settings', '0082', { scoutFYStartMonth: '4' });

  // 欄位入版就係 4，回填亦都係 4（值冇變）
  const { root } = mkFields({ scoutFYStartMonth: '4' });
  const a = bindDraftAutosave(root, 'fin-settings', '0082');
  applyDraft(root, 'fin-settings', '0082');

  const n = stashActiveDrafts();
  ok('回填值同入版一樣 → 0 份草稿', n === 0, `n=${n}`);

  a.stop(); clearDraft('fin-settings', '0082');
}

/* ============================================================ */
dropAllDrafts(); clearActiveDrafts();
console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
