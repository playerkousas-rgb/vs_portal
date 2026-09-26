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

const DRAFT_KEY = 'venture82.drafts.v2';
const CONFIRM_KEY = 'venture82.safeguard.v2';

let memStore = {};   // localStorage 唔可用時嘅後備
function lsGet(k) { try { return localStorage.getItem(k); } catch { return memStore[k] ?? null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { memStore[k] = v; } }

/* ============================================================
   1) 草稿暫存（瀏覽器）
   ============================================================ */
function readAll() {
  try { return JSON.parse(lsGet(DRAFT_KEY) || '{}') || {}; } catch { return {}; }
}
function writeAll(map) {
  try { lsSet(DRAFT_KEY, JSON.stringify(map)); return true; } catch (e) { return false; }
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

/** 所有暫存（用嚟喺「系統 → 資料管理」睇／清） */
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
export async function confirmDanger({ title = '確認', message = '', okText = '確定', requireText = '', danger = true }) {
  const { modal, esc } = await import('./util.js');
  if (!enabled().requireConfirm) {
    const { confirmDlg } = await import('./util.js');
    return !!(await confirmDlg({ title, message, okText, danger }));
  }
  const need = String(requireText || '').trim();
  const r = await modal({
    title,
    body: `<p style="font-size:14.5px;line-height:1.7">${message}</p>
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
   3) 可還原動作
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
