/* ============================================================
   tests/_fakegas.mjs — 假 Apps Script（/exec）＋ dev-server 代理
   ------------------------------------------------------------
   行為同真 Code.gs 一樣（saveDb / loadDb / dbInfo 分段存拼），
   但存喺記憶體，方便測試「換機」情境而唔使真係去 Google。
   用法：node tests/_fakegas.mjs <port>
   ============================================================ */

import http from 'node:http';

const PORT = Number(process.argv[2] || 8799);
const DB_CHUNK = 45000;

/* 模擬 Sheet：一行一段 [unit, seq, text, at, version] */
let sheet = [];
/* ★ v2.8.0「資料表」分頁（簡單寫入）：一行一段 [unit, table, seq, text, at, saveId] */
let simpleSheet = [];
/* 模擬「待批完成」分頁（addRequest / myRequests） */
const requests = [];
/* 模擬「進度追蹤」分頁（save / reviewRequest；同一個後端、兩個前端共用） */
const progressRows = [];          // { ymis, itemId, date, confirmer, note }
/* 模擬「成員名單」分頁（saveDb 會由名冊更新 —— 同真 Code.gs syncMembers） */
const progressMembers = [];       // { ymis, name }

/* saveDb 之後同步「成員名單」（同真 Code.gs：唔會刪人，進度紀錄對得返） */
function syncProgressMembers(db) {
  (db.members || []).forEach(m => {
    const ymis = String(m.ymis || '').trim();
    if (!ymis) return;
    const hit = progressMembers.find(x => x.ymis === ymis);
    if (hit) hit.name = String(m.name || hit.name);
    else progressMembers.push({ ymis, name: String(m.name || '') });
  });
}

/* GET ?action=load —— 同真 Code.gs loadProgressData 同一種格式（兩個前端共用） */
function loadProgress() {
  const progress = {}, flat = {};
  progressRows.forEach(r => {
    if (!progress[r.ymis]) { progress[r.ymis] = {}; flat[r.ymis] = {}; }
    progress[r.ymis][r.itemId] = { date: r.date || '', confirmer: r.confirmer || '' };
    flat[r.ymis][r.itemId] = r.date || '';
  });
  return {
    ok: true, success: true,
    members: progressMembers.map(m => ({ ymis: m.ymis, name: m.name })),
    progress, flatProgress: flat,
    pendingRequests: requests.filter(r => r.status === 'pending').map(r => ({ ...r })),
    otherBadges: {}, logs: [], logsSupported: true, logRequests: [], logRequestsSupported: true,
    at: new Date().toISOString()
  };
}

/* POST action=save（進度前端／執委系統直接勾；同真 saveProgress） */
function saveProgress(body) {
  let processed = 0;
  (body.changes || []).forEach(c => {
    const ymis = String(c.ymis || '').trim();
    const itemId = String(c.itemId || '').trim();
    if (!ymis || !itemId) return;
    const i = progressRows.findIndex(r => r.ymis === ymis && r.itemId === itemId);
    if (c.uncomplete) { if (i >= 0) progressRows.splice(i, 1); processed++; return; }
    if (i >= 0) progressRows[i] = { ymis, itemId, date: c.date || '', confirmer: body.confirmer || c.confirmer || '', note: c.note || '' };
    else progressRows.push({ ymis, itemId, date: c.date || '', confirmer: body.confirmer || c.confirmer || '', note: c.note || '' });
    processed++;
  });
  return { ok: true, success: true, processed };
}

/* POST action=reviewRequest（執委批核；同真 reviewProgressRequest） */
function reviewRequest(body) {
  const reqId = String(body.request_id || '');
  const r = requests.find(x => x.request_id === reqId);
  if (!r) return { ok: false, success: false, error: '搵唔到申請（可能已經處理）' };
  if (r.status !== 'pending') return { ok: false, success: false, error: '呢個申請已經處理過' };
  const decision = body.decision === 'approved' ? 'approved' : 'rejected';
  r.status = decision;
  r.review_note = String(body.review_note || '');
  r.reviewer = String(body.reviewer || '');
  r.confirmed_date = String(body.confirmed_date || '') || r.requested_date || new Date().toISOString().slice(0, 10);
  if (decision !== 'approved') return { ok: true, success: true, message: '已拒絕' };
  const i = progressRows.findIndex(p => p.ymis === r.ymis && p.itemId === r.item_id);
  const row = { ymis: r.ymis, itemId: r.item_id, date: r.confirmed_date, confirmer: r.reviewer, note: '由申請轉入：' + r.review_note };
  if (i >= 0) progressRows[i] = row; else progressRows.push(row);
  return { ok: true, success: true, message: '已批准並寫入進度' };
}

function saveDb(body) {
  const unit = String(body.unit || 'UNKNOWN');
  const text = JSON.stringify(body.db);
  /* v2.2.0 樂觀鎖（同真 Code.gs 一致）：後端已有版本而 baseVersion 對唔上
     → 拒收回 conflict，等 app 自動拉後端合併。 */
  const cur = [...sheet].reverse().find(r => r[0] === unit);
  const curVersion = cur ? String(cur[4] || '') : '';
  const baseVersion = String(body.baseVersion ?? '');
  if (curVersion && baseVersion !== curVersion) {
    return { ok: false, success: false, conflict: true, version: curVersion,
      error: '後端已有較新版本（另一部機剛剛同步過）' };
  }
  sheet = sheet.filter(r => r[0] !== unit);            // 刪走舊段
  const now = new Date().toISOString();
  /* 同真 Code.gs v2.2.0 一致：版本由伺服器派（時間＋隨機尾數），唔會撞 */
  const version = now + '-' + Math.floor(Math.random() * 100000);
  for (let p = 0, i = 1; p < text.length; p += DB_CHUNK, i++) {
    sheet.push([unit, i, text.substring(p, p + DB_CHUNK), now, version]);
  }
  syncProgressMembers(body.db || {});                  // 名冊 → 「成員名單」分頁
  /* ★ v2.8.0：同真 Code.gs 一樣 —— 舊路線寫完「資料庫」之後**鏡像**去「資料表」。
     讀取一律以「資料表」为先，唔鏡像嘅話舊路線（舊版前端／saveDbForce 搶救上載）
     寫嘅嘢就會讀唔到，兩邊各睇各嘅。 */
  try { saveTables({ unit, tables: body.db || {}, full: true, refreshReports: false }); } catch { /* 鏡像失敗唔阻斷 */ }
  return { ok: true, success: true, bytes: text.length, chunks: Math.ceil(text.length / DB_CHUNK), at: now, version };
}

/* v2.4.0 分件：暫存行 unit='__staging__'，version=saveId，載入時一律 skip */
function saveDbPart(body) {
  const unit = String(body.unit || 'UNKNOWN');
  const saveId = String(body.saveId || '');
  const parts = Number(body.parts || 0);
  const partIdx = Number(body.partIdx || 0);
  if (!saveId.startsWith(unit + '-stg-')) return { ok: false, success: false, error: 'saveId 格式唔啱' };
  if (partIdx < 0 || partIdx >= parts) return { ok: false, success: false, error: 'partIdx 越界' };
  /* 樂觀鎖：part 0 對版本 */
  if (partIdx === 0) {
    const cur = [...sheet].reverse().find(r => r[0] === unit);
    const curVersion = cur ? String(cur[4] || '') : '';
    if (curVersion && String(body.baseVersion ?? '') !== curVersion) {
      return { ok: false, success: false, conflict: true, version: curVersion, error: '後端已有較新版本（另一部機剛剛同步過）' };
    }
  }
  const now = new Date().toISOString();
  const chunks = String(JSON.stringify(body.data ?? {}));
  /* 重試覆寫：只刪同一 saveId 同一件（唔可以刪埋隔籬件！真 Code.gs 只清過期暫存，呢度收緊啲防重試堆疊） */
  sheet = sheet.filter(r => !(r[0] === '__staging__' && r[4] === saveId && Math.floor(r[1] / 100000) === partIdx));
  let seq = partIdx * 100000;
  for (let p = 0; p < chunks.length; p += DB_CHUNK) {
    seq++;
    sheet.push(['__staging__', seq, chunks.substring(p, p + DB_CHUNK), now, saveId]);
  }
  return { ok: true, success: true, part: partIdx, at: now };
}

function saveDbCommit(body) {
  const unit = String(body.unit || 'UNKNOWN');
  const saveId = String(body.saveId || '');
  const parts = Number(body.parts || 0);
  const have = [...new Set(sheet.filter(r => r[0] === '__staging__' && r[4] === saveId)
    .map(r => Math.floor(r[1] / 100000)))].sort((a, b) => a - b);
  const missing = [];
  for (let i = 0; i < parts; i++) if (!have.includes(i)) missing.push(i);
  if (missing.length) return { ok: false, success: false, error: '缺少分件：' + missing.join(',') + '（請重新儲存）' };
  const cur = [...sheet].reverse().find(r => r[0] === unit);
  const curVersion = cur ? String(cur[4] || '') : '';
  if (curVersion && String(body.baseVersion ?? '') !== curVersion) {
    return { ok: false, success: false, conflict: true, version: curVersion, error: '後端已有較新版本' };
  }
  /* 拼合：逐 part 重組 → 陣列 concat、其他後件覆蓋 */
  let merged = {};
  for (let i = 0; i < parts; i++) {
    const text = sheet.filter(r => r[0] === '__staging__' && r[4] === saveId && Math.floor(r[1] / 100000) === i)
      .sort((a, b) => a[1] - b[1]).map(r => r[2]).join('');
    const piece = JSON.parse(text);
    for (const [k, v] of Object.entries(piece)) {
      merged[k] = Array.isArray(v) && Array.isArray(merged[k]) ? merged[k].concat(v) : v;
    }
  }
  const text = JSON.stringify(merged);
  if (text.length > 40000000) return { ok: false, success: false, error: '拼合後體積超過 40MB 上限' };
  sheet = sheet.filter(r => r[0] !== unit && !(r[0] === '__staging__' && r[4] === saveId));  // 舊段＋暫存成梳清
  const now = new Date().toISOString();
  const version = now + '-' + Math.floor(Math.random() * 100000);
  for (let p = 0, i = 1; p < text.length; p += DB_CHUNK, i++) {
    sheet.push([unit, i, text.substring(p, p + DB_CHUNK), now, version]);
  }
  try { saveTables({ unit, tables: merged, full: true, refreshReports: false }); } catch { /* 鏡像失敗唔阻斷 */ }
  return { ok: true, success: true, bytes: text.length, at: now, version };
}

/* ★ 2026-09-24：同真 Code.gs 睇齊 —— 按**版本分組**讀，只讀砌得返 JSON 嘅最新一套。
   以前係「同一旅團所有段一齊拼」：有兩套以上（舊版漏刪／手動加行）就會
   拼壞或者永遠讀到舊嗰套（團長回報：「新儲嘅完全讀唔到」）。 */
function dbRawText(unit, strict) {
  const groups = new Map(), order = [];
  let legacy = [], stagingRows = 0, staleRows = 0;
  for (const r of sheet) {
    if (r[0] === '__staging__') { stagingRows++; continue; }
    if (strict) { if (String(r[0] || '') !== String(unit || '')) continue; }
    else if (unit && r[0] && r[0] !== unit) continue;
    const ver = String(r[4] || '');
    const part = { seq: Number(r[1]) || 0, text: String(r[2] == null ? '' : r[2]) };
    if (!ver) { legacy.push(part); continue; }
    if (!groups.has(ver)) { groups.set(ver, { parts: [], at: r[3] || '' }); order.push(ver); }
    groups.get(ver).parts.push(part);
    if (r[3]) groups.get(ver).at = r[3];
  }
  const cands = order.map(v => ({
    version: v, at: groups.get(v).at, rowsN: groups.get(v).parts.length,
    text: groups.get(v).parts.slice().sort((a, b) => a.seq - b.seq).map(p => p.text).join('')
  })).reverse();                                  // 寫入永遠喺最底 → 反轉就係新→舊
  let picked = -1, brokenNewer = 0;
  for (let i = 0; i < cands.length; i++) {
    try { JSON.parse(cands[i].text); picked = i; break; }
    catch { /* 壞咗（寫入中斷）→ 試舊一套 */ }
  }
  if (picked < 0 && !cands.length && legacy.length) {
    return { found: true, text: legacy.slice().sort((a, b) => a.seq - b.seq).map(p => p.text).join(''),
      version: '', at: '', stagingRows, staleRows: 0, versions: 0, brokenNewer: 0 };
  }
  const pick = picked >= 0 ? cands[picked] : cands[0];
  brokenNewer = picked > 0 ? picked : 0;
  if (pick) for (let i = 0; i < cands.length; i++) if (cands[i] !== pick) staleRows += cands[i].rowsN;
  return {
    found: !!(pick && pick.text), text: pick ? pick.text : '', version: pick ? pick.version : (pick?.at || ''),
    at: pick ? pick.at : '', stagingRows, staleRows, versions: cands.length, brokenNewer
  };
}

/* ★ v2.8.0：同真 Code.gs dbReadRaw 一樣 —— 讀取一律以「資料表」为先。
   公開頁（團章／通告）同 authLogin 全部都經 loadDb，所以一定要同一個入口，
   否則就會出現「app 讀到新資料、公開頁讀到舊資料」。 */
function loadDb(unit) {
  const simple = loadTables(unit);
  if (simple.found) {
    return { ok: true, success: true, found: true, db: simple.db, at: simple.at, version: simple.version,
      bytes: JSON.stringify(simple.db).length, stagingRows: 0, staleRows: 0, versions: 1,
      broken: simple.broken || [], mode: 'simple' };
  }
  const raw = dbRawText(unit);
  if (!raw.found) return { ok: true, success: true, found: false, db: null, at: '', version: '',
    stagingRows: raw.stagingRows, staleRows: raw.staleRows, versions: raw.versions };
  try {
    const db = JSON.parse(raw.text);
    return { ok: true, success: true, found: true, db, at: raw.at, version: raw.version, bytes: raw.text.length,
      stagingRows: raw.stagingRows, staleRows: raw.staleRows, versions: raw.versions, brokenNewer: raw.brokenNewer };
  } catch (e) {
    return { ok: false, success: false, found: true, db: null, error: '資料庫內容壞咗',
      stagingRows: raw.stagingRows, staleRows: raw.staleRows, versions: raw.versions };
  }
}

/* ============================================================
   ★ v2.8.0「簡單寫入」—— 同真 Code.gs saveTables／loadTables 一樣嘅行為
   ------------------------------------------------------------
   一個請求淨係寫有改過嗰幾個表；**先寫新、後刪舊**；冇樂觀鎖。
   讀嗰陣逐表砌返，某個表砌唔成就淨係 skip 嗰個表（broken）。
   ============================================================ */
function saveTables(body) {
  const unit = String(body.unit || 'UNKNOWN');
  const tables = body.tables;
  if (!tables || typeof tables !== 'object') return { ok: false, success: false, error: '冇收到表內容（tables）' };
  const now = new Date().toISOString();
  const saveId = 'S' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 100000);
  const rows = [];
  const saved = {};
  let bytes = 0;
  for (const [name, val] of Object.entries(tables)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(String(name))) continue;
    const text = JSON.stringify(val === undefined ? null : val);
    if (text.length > 9000000) continue;
    bytes += text.length;
    const segs = [];
    for (let p = 0; p < text.length; p += DB_CHUNK) segs.push(text.substring(p, p + DB_CHUNK));
    if (!segs.length) segs.push(text);
    segs.forEach((c, k) => rows.push([unit, String(name), k + 1, c, now, saveId]));
    saved[name] = { segs: segs.length, bytes: text.length };
  }
  if (!rows.length) return { ok: false, success: false, error: '冇一個表寫得入（表名或者內容唔合規格）' };
  /* ① 先寫新 */
  simpleSheet = simpleSheet.concat(rows);
  /* ② 後刪舊（同一旅團＋同一個表、但唔係呢次 saveId）。
     body.full ＝ 呢次送咗成份嘅所有表 → 順手清走「已經冇咗嘅表」，
     否則頂層某個 key 消失咗，佢嘅行會永遠留低做幽靈（讀返會多出啲應該冇咗嘅資料）。 */
  /* 同真 Code.gs 一樣：寫完順手由名冊更新「成員名單」分頁（進度頁揀人用）。
     ★ 要用「寫完之後」嘅名冊 —— 呢次淨係寫咗幾個表，其余表要讀返返嚟一齊睇。 */
  syncProgressMembers(loadTables(unit).db || {});
  const names = Object.keys(saved);
  const full = body.full === true;
  simpleSheet = simpleSheet.filter(r => {
    if (r[0] !== unit || r[5] === saveId) return true;
    if (!full && !names.includes(String(r[1]))) return true;
    return false;
  });
  /* 同真 Code.gs 一樣：寫完順手由名冊更新「成員名單」分頁（進度頁揀人用）。
     ★ 一定要喺**刪舊之後**先讀 —— 呢度新舊兩套段同時存在，讀早咗會讀到舊嗰套。 */
  syncProgressMembers(loadTables(unit).db || {});
  return { ok: true, success: true, tables: saved, bytes, at: now, version: saveId, reports: { ok: true, counts: {} } };
}

function loadTables(unit) {
  unit = String(unit || '');
  const byTable = {};
  let at = '', version = '';
  for (let idx = 0; idx < simpleSheet.length; idx++) {
    const r = simpleSheet[idx];
    if (String(r[0] || '') !== unit) continue;
    const name = String(r[1] || '');
    if (!name) continue;
    (byTable[name] = byTable[name] || []).push({ seq: Number(r[2]) || 0, text: String(r[3] ?? ''), ver: String(r[5] || ''), row: idx });
    if (r[4] && String(r[4]) > at) at = String(r[4]);
    if (String(r[5] || '') > version) version = String(r[5] || '');
  }
  const db = {}, counts = {}, broken = [];
  for (const [name, parts] of Object.entries(byTable)) {
    const groups = {};
    parts.forEach(p => {
      const g = groups[p.ver] = groups[p.ver] || [];
      g.push(p);
      g.lastRow = Math.max(g.lastRow || 0, p.row || 0);
    });
    /* ① 段數多嘅先（完整嗰套）；② 平手就揀分頁上最後出現嗰套（＝最新寫入）。
       淨係靠段數嘅話，新舊兩套段數一樣時排序唔穩定，隨時讀返舊嗰套。 */
    const keys = Object.keys(groups).sort((a, b) =>
      (groups[b].length - groups[a].length) || (groups[b].lastRow - groups[a].lastRow));
    let done = false;
    for (const k of keys) {
      const text = groups[k].slice().sort((a, b) => a.seq - b.seq).map(p => p.text).join('');
      try {
        const val = JSON.parse(text);
        db[name] = val;
        counts[name] = Array.isArray(val) ? val.length : 1;
        done = true;
        break;
      } catch { /* 呢套砌唔成 → 試下一套 */ }
    }
    if (!done) broken.push(name);
  }
  const found = Object.keys(db).length > 0;
  return { ok: true, success: true, found, db: found ? db : null, tables: counts, broken, at, version };
}

function loadTablesPart(unit, idx) {
  const i = Math.max(0, parseInt(idx, 10) || 0);
  const all = loadTables(unit);
  if (!all.found) return { ok: true, success: true, found: false, idx: i, count: 0, name: '', broken: all.broken || [], at: all.at, version: all.version };
  const names = Object.keys(all.db || {}).sort();
  if (i >= names.length) return { ok: false, success: false, found: true, idx: i, count: names.length, name: '', broken: all.broken || [], error: '表編號超出範圍', at: all.at, version: all.version };
  const name = names[i];
  return { ok: true, success: true, found: true, idx: i, count: names.length, name, value: all.db[name], broken: all.broken || [], at: all.at, version: all.version };
}

function dbStats(db) {
  db = db || {};
  return {
    bytes: JSON.stringify(db).length,
    counts: {
      members: (db.members || []).length,
      transactions: (db.transactions || []).length,
      meetings: (db.meetings || []).length,
      notices: (db.notices || []).length,
      invItems: (db.invItems || []).length,
      accounts: (db.accounts || []).length
    }
  };
}

/* ★ v2.8.0：先睇「資料表」分頁（簡單寫入），冇先至跌返去舊嘅「資料庫」整份 blob */
function dbInfo(unit) {
  const adv = NO_SIMPLE ? {} : { simpleWrite: true };
  const simple = loadTables(unit);
  if (simple.found) {
    const a = dbStats(simple.db || {});
    return { ok: true, success: true, found: true, mode: 'simple', at: simple.at, version: simple.version,
      bytes: a.bytes, counts: a.counts, broken: simple.broken, ...adv };
  }
  const r = loadDb(unit);
  if (!r.found) return { ok: true, success: true, found: false, mode: 'empty', ...adv };
  const db = r.db || {};
  const b = dbStats(db);
  return { ok: true, success: true, found: true, mode: 'blob', at: r.at, version: r.version, bytes: r.bytes,
    counts: b.counts, ...adv };
}

/* 後端如果設咗 API_KEY（真 Code.gs 行完 initializeSheets 就一定會有），
   saveDb / loadDb / dbInfo 就要條 key 啱先做得 —— 呢個正正係
   「app 條 key 留空 → 寫唔入」嗰個真實故障。
   用法：FAKEGAS_APIKEY=xxx node tests/_fakegas.mjs <port> */
const EXPECTED_KEY = process.env.FAKEGAS_APIKEY || '';
/* ★ 測試用：模擬「未更新到 v2.8.0」嘅舊 Code.gs —— 唔報 simpleWrite，
   而且唔識 saveTables／loadTables（回「未知 action」）。
   前端見到就應該自動跌返舊嘅整份 saveDb 路線，唔會斷。 */
const NO_SIMPLE = process.env.FAKEGAS_NO_SIMPLE === '1';

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    /* GET ?action=load —— 進度前端／團員入口「我的進度」讀同一份資料 */
    let qAction = '';
    try { qAction = new URL(req.url, 'http://localhost').searchParams.get('action') || ''; } catch { /* */ }
    let out;
    const a = qAction || body.action || '';
    const key = body.apiKey || body.apikey || '';
    const needsKey = a === 'saveDb' || a === 'loadDb' || a === 'dbInfo' || a === 'saveDbPart' || a === 'saveDbCommit'
      || a === 'saveTables' || a === 'loadTables' || a === 'loadTablesPart'
      || a === 'save' || a === 'saveOtherBadge' || a === 'reviewRequest' || a === 'reviewLogRequest';

    if (a === 'load') {
      out = loadProgress();
    } else if (EXPECTED_KEY && needsKey && key !== EXPECTED_KEY) {
      out = { ok: false, success: false, error: '未授權：API Key 唔正確' };
    } else if (a === 'saveDb') out = saveDb(body);
    else if (a === 'saveDbPart') out = saveDbPart(body);
    else if (a === 'saveDbCommit') out = saveDbCommit(body);
    else if (a === 'loadDb') out = loadDb(String(body.unit || ''));
    else if (a === 'dbInfo') out = dbInfo(String(body.unit || ''));
    else if (a === 'saveTables') out = saveTables(body);
    else if (a === 'loadTables') out = loadTables(String(body.unit || ''));
    else if (a === 'loadTablesPart') out = loadTablesPart(String(body.unit || ''), body.idx);
    else if (a === 'sync') {
      out = { ok: true, success: true, msg: '已寫入總表', counts: {} };
      if (body.db) {
        if (EXPECTED_KEY && key !== EXPECTED_KEY) out.db = { saved: false, error: '未授權：API Key 唔正確' };
        else { const sv = saveDb(body); out.db = { saved: sv.success === true, conflict: sv.conflict === true, error: sv.error || '' }; }
      }
    } else if (a === 'addRequest') {
      /* 團員申報進度（同真 Code.gs 一樣：記入記憶體，狀態 pending） */
      if (!body.ymis || !body.item_id) out = { ok: false, success: false, error: '缺少 ymis 或 item_id' };
      else {
        const id = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 900 + 100);
        requests.push({
          request_id: id, ymis: String(body.ymis), name: String(body.name || ''),
          item_id: String(body.item_id), item_name: String(body.item_name || ''),
          requested_date: String(body.requested_date || ''), status: 'pending',
          review_note: '', confirmed_date: '', created_at: new Date().toISOString()
        });
        out = { ok: true, success: true, request_id: id };
      }
    } else if (a === 'myRequests') {
      out = { ok: true, success: true, requests: requests.filter(r => r.ymis === String(body.ymis || '')).slice(0, 60) };
    } else if (a === 'save' || a === 'saveOtherBadge') {
      out = saveProgress(body);
    } else if (a === 'reviewRequest') {
      out = reviewRequest(body);
    } else if (a === 'status' || a === 'ping') out = { ok: true, success: true, msg: 'pong',
      backendVersion: NO_SIMPLE ? 'v2.7.2' : 'v2.8.0', ...(NO_SIMPLE ? {} : { simpleWrite: true }) };
    /* ★ 測試用：把「資料表」入面某個表嘅第一段弄壞 ——
       證明「壞一個表淨係唔要嗰個表」，唔會連累成份資料庫讀唔到。 */
    else if (a === '__corrupt') {
      const unit = String(body.unit || ''), table = String(body.table || '');
      let n = 0;
      simpleSheet = simpleSheet.map(r => {
        if (String(r[0]) === unit && String(r[1]) === table && Number(r[2]) === 1) {
          n++; return [r[0], r[1], r[2], '{壞咗嘅 JSON', r[4], r[5]];
        }
        return r;
      });
      out = { ok: true, success: true, corrupted: n };
    }
    /* ★ 測試用：數一數「資料表」分頁而家有幾多行（證明「先寫新、後刪舊」冇留垃圾） */
    else if (a === '__simpleRows') {
      const unit = String(body.unit || '');
      const rows = simpleSheet.filter(r => String(r[0]) === unit);
      const byTable = {}, versions = {};
      rows.forEach(r => {
        const t = String(r[1]);
        byTable[t] = (byTable[t] || 0) + 1;
        /* 每個表而家嗰套嘅 saveId —— 用嚟證明「只寫改過嗰幾個表」 */
        versions[t] = String(r[5] || '');
      });
      out = { ok: true, success: true, total: rows.length, byTable, versions };
    }
    /* v2.5.0 公開團章：由「資料庫」抽 constitution（同真 Code.gs 一樣） */
    else if (a === 'constitution') {
      const r = loadDb(String(body.unit || ''));
      const db = (r.found && r.db) || {};
      const c = db.constitution;
      if (r.found && c && Array.isArray(c.chapters) && c.chapters.length) {
        out = { ok: true, success: true, found: true, constitution: c,
          unitName: (db.profile && db.profile.name) || (db.unit && db.unit.name) || '', version: c.version || '' };
      } else out = { ok: true, success: true, found: false, constitution: null };
    }
    /* v2.5.0 公開通告：由「資料庫」讀（同真 Code.gs 一樣） */
    else if (a === 'notices') {
      const r = loadDb(String(body.unit || ''));
      /* ★ 同真 Code.gs（gastemplate.js loadPublicNotices）一致：
         免登入公開接口淨係出「對外公開」（vis ＝ 'other'，冇設當對外公開）嗰啲通告。 */
      const fromDb = (r.found && Array.isArray(r.db.notices))
        ? r.db.notices.filter(n => n && n.status === 'published' && n.id && String(n.vis || 'other') === 'other') : [];
      out = { ok: true, success: true, notices: fromDb };
    }
    /* v2.5.0 公開頁報名：寫入資料庫（同真 Code.gs 一樣，同名防重複） */
    else if (a === 'noticeSignup') {
      const p = body.payload || {};
      const v = p.values || {};
      const r = loadDb(String(body.unit || ''));
      let dup = false, saved = false;
      if (r.found && r.db && Array.isArray(r.db.notices)) {
        const n = r.db.notices.find(x => String(x && x.id) === String(p.noticeId || ''));
        if (n) {
          if (!Array.isArray(n.signups)) n.signups = [];
          const who = String(v.name || '').trim();
          if (who && n.signups.some(s => String((s && s.name) || ((s.values || {}).name) || '').trim() === who)) dup = true;
          else {
            n.signups.push({ id: 'sg_' + Date.now(), at: p.at || new Date().toISOString(), name: who, values: v });
            const sv = saveDb({ unit: body.unit, db: r.db, baseVersion: String(r.version || '') });
            saved = sv.success === true;
          }
        }
      }
      out = { ok: true, success: true, duplicate: dup, dbSaved: saved, msg: dup ? '已經記錄過呢份報名' : '已記錄報名' };
    }
    /* v2.5.0 公開收支申報／物資借用：寫入資料庫 */
    else if (a === 'claim' || a === 'loan') {
      const p = body.payload || {};
      const r = loadDb(String(body.unit || ''));
      let saved = false;
      if (r.found && r.db) {
        if (a === 'claim') {
          if (!Array.isArray(r.db.claims)) r.db.claims = [];
          if (!r.db.claims.some(c => String(c && c.id) === String(p.id || ''))) {
            r.db.claims.push({ id: p.id || ('cl_' + Date.now()), type: p.type === 'income' ? 'income' : 'expense',
              amount: Number(p.amount) || 0, date: p.date || '', category: p.category || '', item: p.item || '',
              byName: p.byName || '', note: p.note || '', status: 'pending', requestedBy: 'public:entry', requestedAt: new Date().toISOString() });
          }
        } else {
          if (!Array.isArray(r.db.invLoans)) r.db.invLoans = [];
          if (!r.db.invLoans.some(l => String(l && l.id) === String(p.id || ''))) {
            r.db.invLoans.push({ id: p.id || ('ln_' + Date.now()), itemId: p.itemId || '', qty: Number(p.qty) || 1,
              borrowerName: p.byName || '', purpose: p.purpose || '', outDate: p.fromDate || '', dueDate: p.toDate || '',
              returnDate: '', status: 'requested', requestedBy: 'public:borrow', requestedAt: new Date().toISOString(), approvedBy: '', note: '' });
          }
        }
        const sv = saveDb({ unit: body.unit, db: r.db, baseVersion: String(r.version || '') });
        saved = sv.success === true;
      }
      out = { ok: true, success: true, msg: '已記錄，等批核', dbSaved: saved };
    }
    else out = { ok: false, success: false, error: '未知 action：' + a };

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake-gas listening on ${PORT}`);
});
