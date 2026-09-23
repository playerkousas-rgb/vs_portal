/* ============================================================
   merge3.js — 三方比對（登入快照 → 我改咗乜 vs 後端改咗乜）
   ------------------------------------------------------------
   2026-09-20 團長定案（一個方式，冇第二條路）：

     · 登入嗰一刻由後端攞資料 ＝ **基準（base）**
     · 之後改乜都淨係喺自己部機
     · 撳「儲存到後端」嗰一刻先至核對：
         我改咗乜   ＝ diff(base, 本機)
         後端改咗乜 ＝ diff(base, 後端而家)
         同一格、同一個值           → 大家想改同一樣嘢 → 冇問題
         唔同格                     → 兩邊都保留，一齊儲存
         同一格、唔同值（早走 vs 遲到）→ **衝突**：嗰一格唔會寫入後端，
                                      彈出嚟畀用家再確認；佢確認先至蓋過去

   呢個檔係**純函數**：唔掂 localStorage、唔掂 DOM、唔打網絡 ——
   tests/merge3.mjs 直接用團長講嘅劇本釘死每一條規則。

   路徑（path）表示法：
     ['events', {id:'ev1'}, 'rollcall', 'mem_3']
       └ 頂層 key   └ 陣列按 id 定位   └ 物件 key  └ 葉（值）
     字串 key ＝ 'events/ev1/rollcall/mem_3'（{id} 段用 id 本身）

   改動（change）：
     { path, kind:'set'|'add'|'del', from, to, soft }
       set  葉值由 from 變成 to（from===undefined ＝ 新 key；to===undefined ＝ 刪 key）
       add  陣列入面新增一條有 id 嘅紀錄（to ＝ 成條紀錄）
       del  陣列入面刪走一條有 id 嘅紀錄（from ＝ 成條紀錄）
       soft 純簿記欄位（updatedAt 呢類）—— 兩邊唔同都唔算衝突
   ============================================================ */

/** 頂層純簿記／連線設定 —— 永遠唔比對、唔合併（每部機自己嘅） */
export const SKIP_TOP = new Set(['sync', 'meta', 'backend', 'unitCode', 'schema', 'kind']);

/** 葉欄位入面嘅「時間戳簿記」：兩邊都改咗但值唔同，唔算衝突（我嘅贏，靜靜地） */
export const SOFT_KEYS = new Set(['updatedAt', 'updatedBy', 'modifiedAt', 'syncedAt', 'lastLoginAt', 'pwUpdatedAt']);

/* ---------------- 基本工具 ---------------- */
export function isPlainObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 陣列係咪「每條都有 id 嘅紀錄」（團員／帳目／通告／議程…） */
export function isIdArray(v) {
  return Array.isArray(v) && v.length > 0
    && v.every(x => isPlainObj(x) && x.id !== undefined && x.id !== null && x.id !== '');
}

/** 結構相等（唔理 key 次序 —— 兩部機 spread 出嚟嘅 key 次序可以唔同） */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') {
    /* NaN !== NaN；其餘純量已經喺上面 a===b 判斷咗 */
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

export function clone(v) {
  if (v === undefined) return undefined;
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/** path → 字串 key（畀 Map／Set 用） */
export function pathKey(path) {
  return (path || []).map(seg => (isPlainObj(seg) ? `[${String(seg.id)}]` : String(seg))).join('/');
}

function segEq(a, b) {
  if (isPlainObj(a) && isPlainObj(b)) return String(a.id) === String(b.id);
  return a === b;
}

/* ---------------- diff ---------------- */
function idIndex(arr) {
  const m = new Map();
  (Array.isArray(arr) ? arr : []).forEach((x, i) => {
    if (isPlainObj(x) && x.id !== undefined && !m.has(String(x.id))) m.set(String(x.id), i);
  });
  return m;
}

/** 兩個值係咪應該當「按 id 嘅紀錄陣列」嚟逐條比（空陣列跟對面） */
function treatAsIdArray(a, b) {
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (!aArr && !bArr) return false;
  if (aArr && bArr) {
    if (!a.length && !b.length) return false;               // 兩邊都空 → 相等，點都冇 diff
    if (!a.length) return isIdArray(b);
    if (!b.length) return isIdArray(a);
    return isIdArray(a) && isIdArray(b);
  }
  /* 一邊 undefined／null、另一邊係 id 陣列 → 逐條 add／del */
  const only = aArr ? a : b;
  const other = aArr ? b : a;
  return (other === undefined || other === null) && isIdArray(only);
}

function diffNode(a, b, path, out) {
  if (treatAsIdArray(a, b)) {
    const ia = idIndex(a), ib = idIndex(b);
    ia.forEach((i, id) => {
      if (!ib.has(id)) out.push({ path: [...path, { id }], kind: 'del', from: a[i], to: undefined });
    });
    ib.forEach((j, id) => {
      if (!ia.has(id)) out.push({ path: [...path, { id }], kind: 'add', from: undefined, to: b[j] });
      else diffNode(a[ia.get(id)], b[j], [...path, { id }], out);
    });
    return;
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach(k => diffNode(a[k], b[k], [...path, k], out));
    return;
  }
  /* 一邊係物件、另一邊 undefined → 逐格落去（咁樣兩邊各填一格唔會撞成一個大衝突） */
  if (isPlainObj(a) && (b === undefined || b === null)) {
    Object.keys(a).forEach(k => diffNode(a[k], undefined, [...path, k], out));
    return;
  }
  if (isPlainObj(b) && (a === undefined || a === null)) {
    Object.keys(b).forEach(k => diffNode(undefined, b[k], [...path, k], out));
    return;
  }
  if (deepEqual(a, b)) return;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return;
  const last = path[path.length - 1];
  out.push({ path, kind: 'set', from: a, to: b, soft: typeof last === 'string' && SOFT_KEYS.has(last) });
}

/**
 * 成個資料庫比對：base → cur 有咩改動。
 * @returns {Array<change>}
 */
export function diffDb(base, cur) {
  const out = [];
  const a = isPlainObj(base) ? base : {};
  const b = isPlainObj(cur) ? cur : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.forEach(k => {
    if (SKIP_TOP.has(k) || k.startsWith('_')) return;   // _exportedFrom 之類嘅備份標記唔係資料
    diffNode(a[k], b[k], [k], out);
  });
  return out;
}

/* ---------------- apply ---------------- */
function getAt(obj, path) {
  let cur = obj;
  for (const seg of path) {
    if (cur === undefined || cur === null) return undefined;
    if (isPlainObj(seg)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find(x => isPlainObj(x) && String(x.id) === String(seg.id));
    } else cur = cur[seg];
  }
  return cur;
}
export { getAt };

/** 行到 path 倒數第二層（沿途冇就開），回傳 { parent, last } */
function ensureParent(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = path[i + 1];
    if (isPlainObj(seg)) {
      if (!Array.isArray(cur)) return null;
      let rec = cur.find(x => isPlainObj(x) && String(x.id) === String(seg.id));
      if (!rec) { rec = { id: seg.id }; cur.push(rec); }
      cur = rec;
    } else {
      if (cur[seg] === undefined || cur[seg] === null) cur[seg] = isPlainObj(next) ? [] : {};
      cur = cur[seg];
    }
  }
  return { parent: cur, last: path[path.length - 1] };
}

/** 把一個改動套落 obj（就地修改） */
export function applyChange(obj, ch) {
  if (!ch || !Array.isArray(ch.path) || !ch.path.length) return obj;
  const at = ensureParent(obj, ch.path);
  if (!at) return obj;
  const { parent, last } = at;
  if (isPlainObj(last)) {
    /* 陣列紀錄 add／del／整條 set */
    if (!Array.isArray(parent)) return obj;
    const i = parent.findIndex(x => isPlainObj(x) && String(x.id) === String(last.id));
    if (ch.kind === 'del' || ch.to === undefined) { if (i >= 0) parent.splice(i, 1); return obj; }
    if (i >= 0) parent[i] = clone(ch.to); else parent.push(clone(ch.to));
    return obj;
  }
  if (ch.kind === 'del' || ch.to === undefined) { delete parent[last]; return obj; }
  parent[last] = clone(ch.to);
  return obj;
}

export function applyChanges(obj, changes) {
  (changes || []).forEach(ch => applyChange(obj, ch));
  return obj;
}

/* ---------------- 三方合併 ---------------- */
function isPrefix(shortPath, longPath) {
  if (shortPath.length >= longPath.length) return false;
  for (let i = 0; i < shortPath.length; i++) if (!segEq(shortPath[i], longPath[i])) return false;
  return true;
}

/** 兩個改動係咪「同一樣嘢」（大家都想改成一樣） */
function sameChange(m, t) {
  if (m.kind !== t.kind) return false;
  return deepEqual(m.to, t.to);
}

/**
 * 三方合併。
 * @param base   登入／上次儲存嗰陣嘅快照
 * @param local  本機而家
 * @param remote 後端而家
 * @returns {{
 *   mine: change[], theirs: change[],
 *   same: change[],                 // 兩邊改成一樣（唔使理）
 *   applied: change[],              // 我嘅、唔撞嘅 → 已經套入 merged
 *   conflicts: Array<{key, path, mine, theirs, override}>,
 *   merged: object                  // 後端而家 ＋ 我嘅唔撞改動（衝突格保持後端）
 * }}
 *   conflict.override ＝ 用家揀「用我嘅」嗰陣要套落 merged 嘅改動
 */
export function threeWay(base, local, remote) {
  const mine = diffDb(base, local);
  const theirs = diffDb(base, remote);
  const tIndex = new Map();
  theirs.forEach(t => tIndex.set(pathKey(t.path), t));

  const same = [], applied = [], conflicts = [];
  mine.forEach(m => {
    const key = pathKey(m.path);
    const t = tIndex.get(key);
    if (t) {
      if (sameChange(m, t)) { same.push(m); return; }
      if (m.soft || t.soft) { applied.push(m); return; }          // 時間戳：我嘅贏，唔嘈
      conflicts.push({ key, path: m.path, mine: m, theirs: t, override: m });
      return;
    }
    /* 佢刪咗成條紀錄、我改咗入面一格 → 衝突（用我嘅＝把我嗰條成條放返） */
    const anc = theirs.find(x => x.kind === 'del' && isPrefix(x.path, m.path));
    if (anc) {
      const rec = getAt(local, anc.path);
      conflicts.push({ key, path: m.path, mine: m, theirs: anc,
        override: { path: anc.path, kind: 'add', from: undefined, to: rec } });
      return;
    }
    /* 我刪咗成條紀錄、佢改咗入面一格 → 衝突（用我嘅＝照刪） */
    if (m.kind === 'del') {
      const inside = theirs.filter(x => isPrefix(m.path, x.path));
      if (inside.length) {
        conflicts.push({ key, path: m.path, mine: m, theirs: inside[0], theirsAll: inside, override: m });
        return;
      }
    }
    applied.push(m);
  });

  const merged = clone(isPlainObj(remote) ? remote : {});
  applyChanges(merged, applied);
  normalizeMerged(merged);
  return { mine, theirs, same, applied, conflicts, merged };
}

/** 合併後嘅小整理：操作紀錄最新喺頂、唔好無限長 */
function normalizeMerged(db) {
  if (Array.isArray(db.auditLog) && db.auditLog.length > 1) {
    db.auditLog.sort((a, b) => String(b?.at || '').localeCompare(String(a?.at || '')));
    if (db.auditLog.length > 400) db.auditLog.length = 400;
  }
}

/** 用家揀咗「用我嘅」嘅衝突 → 要套落資料庫嘅改動 */
export function overridesFor(conflicts, useMineKeys) {
  const want = useMineKeys === true ? null : new Set(useMineKeys || []);
  return (conflicts || []).filter(c => !want || want.has(c.key)).map(c => c.override);
}

/* ============================================================
   人話（畀衝突對話框顯示）
   ============================================================ */
const MODULES = {
  members: '用戶', transactions: '帳目', claims: '收支申報', fees: '團費', budgets: '預算',
  meetings: '會議', events: '行事曆', notices: '通告', quizzes: '試卷',
  invItems: '物資', invLoans: '物資借用', invAudits: '盤點', invNextCode: '物資編號',
  accounts: '帳戶', accountApps: '開戶申請', settings: '設定', unit: '旅團資料', profile: '旅團資料',
  constitution: '團章', categories: '收支分類', methods: '付款方式', tableSchema: '欄位設計',
  tableSources: 'Sheet 來源', reference: '舊帳參考', auditLog: '操作紀錄'
};
const FIELDS = {
  name: '姓名', nameEn: '英文名', title: '標題', date: '日期', amount: '金額', status: '狀態',
  attendance: '點名', rollcall: '點名', rsvp: '出席回覆', phone: '電話', email: '電郵', birthday: '生日',
  ymis: 'YMIS', identity: '身份', role: '職位', note: '備註', notes: '備註', item: '項目', category: '分類',
  method: '方式', paid: '已交', paidDate: '交費日期', qty: '數量', venue: '地點', time: '時間',
  minutes: '會議記錄', agenda: '議程', decisions: '決議', body: '內容', deadline: '截止', fee: '費用',
  quota: '名額', signups: '報名', type: '類型', tags: '標籤', location: '位置', code: '編號',
  dueDate: '到期日', outDate: '借出日期', returnDate: '歸還日期', purpose: '用途', borrowerName: '借用人',
  zh: '中文', en: '英文', chapters: '章節', articles: '條文', heading: '標題', preamble: '序言',
  version: '版本', published: '已發布', receipt: '單據', memberId: '團員', due: '到期',
  troopLinks: '公開連結', instagram: 'Instagram', facebook: 'Facebook', website: '網頁',
  feePerYear: '年度團費', openingBalances: '期初結餘', agmDates: 'AGM 日期', password: '密碼', pw: '密碼',
  hubPw: '入口密碼', active: '啟用', username: '帳號', done: '已完成', owner: '負責人', text: '內容',
  planned: '預算', actual: '實際', items: '項目', period: '期別', label: '名稱', chair: '主席', secretary: '文書',
  photos: '相片', publishAt: '發布日期', eventDate: '活動日期', createdAt: '建立時間', mustChangePw: '需改密碼'
};
const VALUES = {
  present: '出席', late: '遲到', early: '早走', absent: '缺席／不出席', apology: '請假',
  pending: '待處理', approved: '已批准', rejected: '已拒絕', published: '已發布', draft: '草稿',
  confirmed: '已確定', done: '已完成', completed: '已完成', cancelled: '已取消',
  requested: '申請中', out: '已借出', returned: '已歸還', overdue: '逾期',
  income: '收入', expense: '支出', leader: '領袖', exco: '執委', member: '團員',
  active: '現役', alumni: '舊團員', true: '是', false: '否'
};

function recordName(rec) {
  if (!isPlainObj(rec)) return '';
  const t = rec.title;
  const name = rec.name || (isPlainObj(t) ? (t.zh || t.en) : t) || rec.item || rec.activity
    || (isPlainObj(rec.heading) ? rec.heading.zh : rec.heading) || rec.label || rec.username
    || rec.borrowerName || rec.text || rec.zh || rec.date || '';
  return String(name || '').slice(0, 40);
}

export function fmtValue(v) {
  if (v === undefined || v === null || v === '') return '（空）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return (VALUES[v] || v).slice(0, 80);
  if (Array.isArray(v)) return `（${v.length} 項）`;
  if (isPlainObj(v)) {
    const n = recordName(v);
    if (n) return n;
    const ks = Object.keys(v);
    return ks.length ? `（${ks.length} 格：${ks.slice(0, 4).join('、')}${ks.length > 4 ? '…' : ''}）` : '（空）';
  }
  return String(v).slice(0, 80);
}

/**
 * 把一個衝突講成人話。
 * @param c   threeWay() 回嘅 conflict
 * @param ctx { local, remote }（用嚟搵紀錄名／團員名）
 * @returns {{ module, record, field, where, mineText, theirsText }}
 */
export function describeConflict(c, ctx = {}) {
  const path = c.path || [];
  const top = String(path[0] || '');
  const module = MODULES[top] || top;
  const dbs = [ctx.local, ctx.remote].filter(Boolean);
  const memberName = (id) => {
    for (const db of dbs) {
      const m = (db?.members || []).find(x => String(x?.id) === String(id));
      if (m) return m.name || id;
    }
    return '';
  };
  const lookup = (p) => {
    for (const db of dbs) { const v = getAt(db, p); if (v !== undefined) return v; }
    return undefined;
  };

  let record = '';
  const fieldParts = [];
  for (let i = 1; i < path.length; i++) {
    const seg = path[i];
    if (isPlainObj(seg)) {
      const rec = lookup(path.slice(0, i + 1))
        || (c.mine?.kind !== 'set' ? (c.mine?.to || c.mine?.from) : null)
        || (c.theirs?.kind !== 'set' ? (c.theirs?.to || c.theirs?.from) : null);
      const nm = recordName(rec) || String(seg.id);
      if (!record) record = nm; else fieldParts.push(nm);
      continue;
    }
    const k = String(seg);
    const mn = memberName(k);
    fieldParts.push(mn || FIELDS[k] || k);
  }
  const field = fieldParts.join(' › ');
  const text = (ch) => {
    if (!ch) return '（冇改）';
    if (ch.kind === 'del') return '刪除咗呢筆';
    if (ch.kind === 'add') return `新增：${fmtValue(ch.to)}`;
    return fmtValue(ch.to);
  };
  return {
    module, record, field,
    where: [module, record, field].filter(Boolean).join(' › '),
    mineText: text(c.mine),
    theirsText: text(c.theirs)
  };
}

/** 改動數目歸納成一句（畀 toast／狀態列） */
export function summarize(changes) {
  const byTop = {};
  (changes || []).forEach(ch => {
    const top = String(ch.path?.[0] || '');
    byTop[top] = (byTop[top] || 0) + 1;
  });
  return Object.entries(byTop).map(([k, n]) => `${MODULES[k] || k} ${n}`).join('、');
}
