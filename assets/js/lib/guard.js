/* ============================================================
   guard.js — 防呆層（避免手誤即時寫入）

   三件事：
   1) 草稿暫存：所有編輯器輸入嘅內容，先自動存喺瀏覽器
      （localStorage，key = venture82.drafts.v2），未撳「儲存」
      唔會寫入資料庫；刷新／撳錯返回都唔會不見咗。
   2) 危險動作確認：刪除／重設／還原要打字確認（打低個名先得撳）。
   3) 可還原：刪咗嘅嘢可以即刻撳「還原」撈返。

   寫入總表（Apps Script）一律唔會自動發生：
   改動只會「排隊」（store.commit 會累加 sync.pending），
   要到用家撳頂部「儲存到後端」先真正送出。
   ============================================================ */

import { currentUnit } from './store.js';

const DRAFT_KEY = 'venture82.drafts.v2';
const CONFIRM_KEY = 'venture82.safeguard.v2';
const SAFETY_KEY = 'venture82.safety-snapshots.v1';
const MAX_SAFETY_SNAPSHOTS = 6; // five history slots plus one pre-restore rollback slot

let memStore = {};   // localStorage 唔可用時嘅後備（只保住今次頁面）
function lsGet(k) {
  if (Object.prototype.hasOwnProperty.call(memStore, k)) return memStore[k];
  try { return localStorage.getItem(k); }
  catch { return null; }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
    delete memStore[k];
    return true;
  } catch {
    memStore[k] = v;
    return false;
  }
}
/* Drafts and safety snapshots can contain member/finance data. Keep them in the
   active unit's storage namespace so switching troops in one browser cannot show
   or restore another troop's unsaved content. Legacy unscoped keys are deliberately
   not auto-migrated because they do not record which unit owned them. */
function storageScope() {
  const unit = String(currentUnit?.() || '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/.test(unit) ? unit : 'unselected';
}
function scopedKey(base) { return `${base}.${storageScope()}`; }

/* ============================================================
   1) 草稿暫存（瀏覽器）
   ============================================================ */
function readAll() {
  try { return JSON.parse(lsGet(scopedKey(DRAFT_KEY)) || '{}') || {}; } catch { return {}; }
}
function writeAll(map) {
  try { return lsSet(scopedKey(DRAFT_KEY), JSON.stringify(map)); } catch (e) { return false; }
}
const keyOf = (section, id) => `${section}::${id || 'new'}`;

/** 把一份編輯中嘅內容暫存去瀏覽器（唔會入資料庫） */
export function saveDraft(section, id, data) {
  const map = readAll();
  map[keyOf(section, id)] = { at: new Date().toISOString(), data };
  return writeAll(map);
}

/** 讀返暫存（冇就返 null） */
export function readDraft(section, id) {
  const rec = readAll()[keyOf(section, id)];
  return rec ? rec : null;
}

/** 儲存成功之後清走暫存 */
export function clearDraft(section, id) {
  const map = readAll();
  delete map[keyOf(section, id)];
  writeAll(map);
  activeKeys.delete(keyOf(section, id));
}

/** 所有暫存（用嚟喺「資料管理」睇／清） */
export function listDrafts() {
  return Object.entries(readAll()).map(([k, v]) => {
    const [section, id] = k.split('::');
    return { key: k, section, id, at: v.at, data: v.data };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
export function dropDraft(key) {
  const map = readAll();
  delete map[key];
  writeAll(map);
}
export function dropAllDrafts() { writeAll({}); }

/** 暫存咗幾耐（顯示用） */
export function draftAgeText(at) {
  if (!at) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  if (mins < 1) return '啱啱';
  if (mins < 60) return `${mins} 分鐘前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 日前`;
}

/* ---------- 自動暫存表單 ---------- */
/**
 * 把一個表單（root 內所有 [data-draft] 欄位）自動暫存去瀏覽器。
 * @param {HTMLElement} root
 * @param {string} section  例：'member' / 'notice' / 'tx' / 'claim' / 'meeting'
 * @param {string|number} id  編輯中嘅紀錄 id（新增用 'new'）
 * @param {object} [opts] { extra: () => ({...}) 例如相片陣列, onSaved: (at)=>{} , interval: 700 }
 * @returns {{ markDirty: () => void, stop: () => void }}
 *   - stop()     停止監聽兼解除呢個分頁嘅草稿追蹤（轉分頁／render 拆除嗰陣 call）
 *   - markDirty() 欄位值被程式改咗（例如 applyDraft 回填、掣自動填數）嗰陣 call，
 *                 等下次 flush 唔好以為「冇改過」而掉咗
 */
export function bindDraftAutosave(root, section, id, opts = {}) {
  if (!root || !enabled().autosave) return () => {};
  const fields = () => Array.from(root.querySelectorAll('[data-draft]'));
  let timer = null;
  const dk = keyOf(section, id);

  const collect = () => {
    const out = {};
    fields().forEach(el => {
      const k = el.dataset.draft;
      if (!k) return;
      if (el.type === 'checkbox') out[k] = el.checked;
      else out[k] = el.value;
    });
    if (typeof opts.extra === 'function') {
      try { Object.assign(out, opts.extra() || {}); } catch { /* ignore */ }
    }
    return out;
  };
  const same = (a, b) => {
    const ka = Object.keys(a).filter(k => !k.startsWith('_'));
    const kb = Object.keys(b).filter(k => !k.startsWith('_'));
    if (ka.length !== kb.length) return false;
    return ka.every(k => String(a[k]) === String(b[k]));
  };
  /* 以「入版嗰陣」嘅欄位值做基準 —— 純粹 load 完 page 然後轉走，同基準一樣
     就唔應該構成一份「草稿」（唔寫落 browser 亦唔報告）。入版前已有舊草稿、
     之後 applyDraft() 回填唔同值嗰陣，先由 call site 打 markDirty()。 */
  const baseline = collect();
  let forced = false;   // markDirty() 打咗之後，就算欄位值冇變都要照寫

  const flush = () => {
    const cur = collect();
    /* 冇真係改過（同基準一樣，又冇打 markDirty）＝ 空白草稿 → 唔寫亦唔報告 */
    if (!forced && same(cur, baseline)) { opts.onSaved?.(true); return; }
    const okSaved = saveDraft(section, id, cur);
    if (okSaved) activeKeys.add(dk);
    const stamp = root.querySelector('[data-draft-stamp]');
    if (stamp) {
      stamp.textContent = okSaved
        ? `已暫存喺呢部裝置（${new Date().toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}）· 未撳「儲存」唔會寫入資料庫`
        : '瀏覽器儲存空間已滿 —— 請先清理相片或匯出備份';
    }
    opts.onSaved?.(okSaved);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, opts.interval || 700); };

  fields().forEach(el => {
    el.addEventListener('input', schedule);
    el.addEventListener('change', schedule);
  });
  pendingFlushes.add(flush);
  const stop = () => {
    clearTimeout(timer);
    pendingFlushes.delete(flush);
    /* 停止監聽同時解除呢個分頁嘅追蹤 —— 唔好留低唔屬於呢個分頁嘅「未完成草稿」 */
    activeKeys.delete(dk);
  };
  return { markDirty: () => { forced = true; }, stop };
}

/* 所有仲未落筆（debounce 未到）嘅 flush —— 離開分頁前要即刻寫落瀏覽器，
   否則「打完最後一個字 0.7 秒內就轉頁」會蝕咗嗰下。 */
const pendingFlushes = new Set();

/* ---------- 而家呢個分頁有邊啲未儲存草稿（離開分頁閘用） ----------
   ★ 2026-09-24 團長：「每個分頁有他的儲存按鈕，如果離開分頁前有未儲的東西…
      會提示用戶有未暫存遊覽器的改動」。
   bindDraftAutosave() 每次真係寫咗草稿就登記一個 key；
   main.js 轉分頁之前問 activeDrafts()，有嘢就彈提示。 */
const activeKeys = new Set();

/**
 * ★ 離開分頁（2026-09-24 團長定案，再修訂）：
 *   草稿一律**當佢自動暫存咗喺瀏覽器** —— 寫瀏覽器唔等如寫後端，
 *   所以離開分頁**唔使彈框問**，亦**永遠唔會放棄**任何嘢。
 *
 *   呢度做兩件事：
 *     ① 即刻 flush 所有未落筆嘅草稿（debounce 未到嗰啲）→ 寫落 localStorage；
 *     ② 清走「呢個分頁」嘅追蹤（草稿本身**留低**，返嚟可以撳「還原」）。
 *
 *   真正要問嘅係「未寫入**後端**」—— 嗰個只喺登出／閂頁問（main.js confirmLogout）。
 * @returns {number} 呢個分頁有幾多份未完成草稿（0 ＝ 冇）
 */
export function stashActiveDrafts() {
  pendingFlushes.forEach(fn => { try { fn(); } catch { /* 一個失敗唔好拖累其他 */ } });
  const n = activeDrafts().length;
  activeKeys.clear();
  return n;
}

export function activeDrafts() {
  const all = readAll();
  return [...activeKeys].filter(k => all[k]).map(k => {
    const [section, id] = k.split('::');
    return { key: k, section, id, at: all[k].at };
  });
}
export function clearActiveDrafts() { activeKeys.clear(); }
/** 放棄呢個分頁所有未儲存草稿（**只**喺用家明確撳「放棄」嗰陣先用 ——
 *  轉分頁唔會再自動放棄，見 stashActiveDrafts()） */
export function discardActiveDrafts() {
  const map = readAll();
  activeKeys.forEach(k => { delete map[k]; });
  writeAll(map);
  activeKeys.clear();
}

/** 還原草稿欄位值（喺 render 之後 call） */
export function applyDraft(root, section, id) {
  const rec = readDraft(section, id);
  if (!rec) return null;
  Array.from(root.querySelectorAll('[data-draft]')).forEach(el => {
    const k = el.dataset.draft;
    if (!(k in rec.data)) return;
    if (el.type === 'checkbox') el.checked = !!rec.data[k];
    else el.value = rec.data[k] ?? '';
  });
  return rec;
}

/** 「偵測到未完成草稿」提示條（要配 [data-draft-restore] / [data-draft-discard] 按鈕） */
export function draftBanner(section, id, label = '草稿') {
  const rec = readDraft(section, id);
  if (!rec) return '';
  return `<div class="note-box warn draft-banner" data-draft-banner>
    <span>💾</span>
    <div class="grow">偵測到<b>未完成嘅${label}</b>（${draftAgeText(rec.at)}暫存喺呢部裝置）。
      <div class="xs faint">內容只存喺瀏覽器，未撳「儲存」唔會寫入資料庫。</div></div>
    <div class="row gap-6">
      <button class="btn btn-xs btn-primary" data-draft-restore>還原</button>
      <button class="btn btn-xs" data-draft-discard>放棄</button>
    </div></div>`;
}

/* ============================================================
   2) 危險動作確認（打字確認）
   ============================================================ */
/**
 * 要求使用者打低指定文字先得撳「確定」。
 * @returns {Promise<boolean>}
 */
export async function confirmDanger({ title = '確認', message = '', trustedMessageHtml, okText = '確定', requireText = '', danger = true }) {
  const { modal, esc } = await import('./util.js');
  if (trustedMessageHtml !== undefined && typeof trustedMessageHtml !== 'string') {
    throw new TypeError('trustedMessageHtml must be an application-authored HTML string');
  }
  if (!enabled().requireConfirm) {
    const { confirmDlg } = await import('./util.js');
    return !!(await confirmDlg({ title, message, trustedMessageHtml, okText, danger }));
  }
  const renderedMessage = trustedMessageHtml === undefined ? esc(message) : trustedMessageHtml;
  const need = String(requireText || '').trim();
  const r = await modal({
    title,
    trustedBodyHtml: `<p style="font-size:14.5px;line-height:1.7">${renderedMessage}</p>
      ${need ? `
      <div class="field mt-12">
        <label class="label">請打低 <code>${esc(need)}</code> 以確認（防手誤）</label>
        <input class="input" id="gd-text" autocomplete="off" placeholder="${esc(need)}">
      </div>` : `
      <label class="check mt-12"><input type="checkbox" id="gd-tick"> 我明白呢個動作<b>無法自動復原</b></label>`}`,
    actions: [
      { label: '取消', class: 'btn', value: false },
      { label: okText, class: danger ? 'btn-accent' : 'btn-primary', value: true, disabled: true }
    ],
    onMount: el => {
      const btn = el.querySelector('[data-act="1"]');
      const input = el.querySelector('#gd-text');
      const tick = el.querySelector('#gd-tick');
      const sync = () => {
        const ok = need ? String(input.value).trim() === need : tick.checked;
        btn.disabled = !ok;
      };
      input?.addEventListener('input', sync);
      tick?.addEventListener('change', sync);
      sync();
    }
  });
  return !!r;
}

/* ============================================================
   3) 批量／危險操作：dry-run → 詳細 diff → 備份／回復 → 明確確認
   ============================================================ */

/**
 * 全系統共用嘅批量確認。呢個畫面本身只做 dry-run，唔會改資料。
 * caller 要喺回 true 之後先 createSafetySnapshot／真正寫入，再自行 readback。
 */
export async function confirmBulkOperation({
  title = '確認批量操作', actionLabel = '確認執行', count = 0, scope = '',
  changes = [], preview = [], warnings = [], requireText = '',
  backupText = '執行前會自動建立本機安全快照。',
  rollbackText = '如結果唔啱，可用安全快照還原。',
  readbackText = '完成後系統會重新計數核對結果。', danger = false
} = {}) {
  const { modal, esc } = await import('./util.js');
  const need = String(requireText || `確認 ${Number(count) || 0}`).trim();
  const rows = (Array.isArray(preview) ? preview : []).map((row, i) => {
    const r = row && typeof row === 'object' ? row : { label: String(row || '') };
    return `<tr><td class="mono xs">${i + 1}</td><td class="sm"><b>${esc(r.label || r.name || r.id || '—')}</b>${r.detail ? `<div class="xs faint">${esc(r.detail)}</div>` : ''}</td>
      <td class="sm">${esc(r.before ?? '—')}</td><td class="sm">${esc(r.after ?? '—')}</td></tr>`;
  }).join('');
  const r = await modal({
    title,
    sub: '呢一步只係預覽；未確認之前唔會改任何正式資料',
    wide: true,
    trustedBodyHtml: `
      <div class="note-box info mb-12"><div><b>Dry-run：準備處理 ${Number(count) || 0} 項</b>
        ${scope ? `<div class="xs mt-4">範圍：${esc(scope)}</div>` : ''}</div></div>
      ${(Array.isArray(changes) ? changes : []).length ? `<div class="kv mb-12">${changes.map(c => `
        <div class="kv-row sm"><span>${esc(c.label || '')}</span><span>${esc(c.before ?? '—')} → <b>${esc(c.after ?? '—')}</b>${c.detail ? `<div class="xs faint">${esc(c.detail)}</div>` : ''}</span></div>`).join('')}</div>` : ''}
      ${rows ? `<div class="scroll-x bulk-diff"><table class="table table-compact">
        <thead><tr><th>#</th><th>記錄</th><th>執行前</th><th>執行後</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      ${warnings.map(w => `<div class="note-box warn mt-8"><div>${esc(w)}</div></div>`).join('')}
      <div class="note-box mt-12"><div>
        <b>備份：</b>${esc(backupText)}<br>
        <b>回復：</b>${esc(rollbackText)}<br>
        <b>核對：</b>${esc(readbackText)}
      </div></div>
      <div class="field mt-12"><label class="label">請打低 <code>${esc(need)}</code> 先可以執行（防手誤）</label>
        <input class="input" id="bulk-confirm-text" autocomplete="off" inputmode="text" placeholder="${esc(need)}"></div>
      <label class="check mt-12"><input type="checkbox" id="bulk-confirm-scope"> 我已核對上面嘅範圍、數量同變更方向</label>`,
    actions: [
      { label: '取消（唔改資料）', class: 'btn', value: false },
      { label: actionLabel, class: danger ? 'btn-danger' : 'btn-primary', value: true, disabled: true }
    ],
    onMount: el => {
      const input = el.querySelector('#bulk-confirm-text');
      const tick = el.querySelector('#bulk-confirm-scope');
      const btn = el.querySelector('[data-act="1"]');
      const sync = () => { btn.disabled = String(input?.value || '').trim() !== need || !tick?.checked; };
      input?.addEventListener('input', sync);
      tick?.addEventListener('change', sync);
      sync();
    }
  });
  return !!r;
}

function safetyMap() {
  try {
    const parsed = JSON.parse(lsGet(scopedKey(SAFETY_KEY)) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** 建立可下載／可程式還原嘅本機安全快照；最多保留最近 6 份。 */
export function createSafetySnapshot(label, data, meta = {}, { preserveId = '' } = {}) {
  let json;
  try { json = typeof data === 'string' ? data : JSON.stringify(data); }
  catch (e) { return { ok: false, error: '快照序列化失敗：' + (e?.message || e) }; }
  const rec = {
    id: `safe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: String(label || '批量操作前'), at: new Date().toISOString(), unit: storageScope(),
    bytes: new Blob([json]).size, meta: meta && typeof meta === 'object' ? meta : {}, json
  };
  const existing = safetyMap();
  const pinned = preserveId ? existing.find(x => x.id === preserveId) : null;
  const list = [rec, ...(pinned ? [pinned] : []), ...existing.filter(x => !pinned || x.id !== pinned.id)]
    .slice(0, MAX_SAFETY_SNAPSHOTS);
  try {
    /* A memory fallback is useful for drafts, but it is not a durable safety
       backup: a refresh would erase it. Destructive/bulk work may proceed only
       after localStorage confirms the snapshot was persisted and can be read. */
    const key = scopedKey(SAFETY_KEY);
    const persisted = lsSet(key, JSON.stringify(list));
    if (!persisted) delete memStore[key];
    const found = persisted && safetyMap().some(x => x.id === rec.id);
    return found ? { ok: true, ...rec } : { ok: false, error: '瀏覽器儲存空間不足，未能建立安全快照' };
  } catch (e) {
    return { ok: false, error: '瀏覽器儲存空間不足，未能建立安全快照' };
  }
}

export function listSafetySnapshots() {
  return safetyMap().map(({ json, ...meta }) => meta);
}
export function readSafetySnapshot(id) {
  const rec = safetyMap().find(x => x.id === id);
  if (!rec) return null;
  try { return { ...rec, data: JSON.parse(rec.json) }; }
  catch { return { ...rec, data: rec.json }; }
}
export function dropSafetySnapshot(id) {
  try { return lsSet(scopedKey(SAFETY_KEY), JSON.stringify(safetyMap().filter(x => x.id !== id))); }
  catch { return false; }
}

/** 下載快照；wipe／整庫還原等不可逆動作用呢個，唔只靠 localStorage。 */
export async function downloadSafetySnapshot(snapshot, filename = '') {
  if (!snapshot?.json) return false;
  const { download } = await import('./util.js');
  const safe = String(filename || snapshot.label || '安全快照').replace(/[\\/:*?"<>|]+/g, '_');
  download(`${safe}_${String(snapshot.at || '').slice(0, 19).replace(/[-:T]/g, '')}.json`, snapshot.json, 'application/json');
  return true;
}

/* ============================================================
   4) 可還原動作
   ============================================================ */
/**
 * 執行一個動作，並喺 toast 提供「還原」。
 * @param {string} message 例：'已刪除 陳大文'
 * @param {() => void} undoFn
 */
export async function undoable(message, undoFn, kind = 'ok') {
  const { toastAction } = await import('./util.js');
  toastAction(message, '還原', () => { undoFn(); }, kind);
}

/* ============================================================
   設定
   ============================================================ */
const DEFAULTS = { autosave: true, requireConfirm: true, undo: true };
export function enabled() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(lsGet(CONFIRM_KEY) || '{}') || {}) };
  } catch { return { ...DEFAULTS }; }
}
export function setSafeguard(patch) {
  const next = { ...enabled(), ...patch };
  lsSet(CONFIRM_KEY, JSON.stringify(next));
  return next;
}
