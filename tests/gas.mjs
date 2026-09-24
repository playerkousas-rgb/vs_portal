/* ============================================================
   tests/gas.mjs — 真係行 apps-script/Code.gs（唔係假後端）
   -----------------------------------------------------------
   背景（2026-09 真實故障）：
   用家部署咗新 Code.gs，但撳「立即儲存到後端」財政／生日資料都入唔到。
   原因：initializeSheets() 會自動生成一條 API Key 入 Script Properties，
   而 data/units.json 入面 0082 嘅 apiKey 係 ""，
   doPost 對 saveDb / loadDb / dbInfo 用嚴格檢查（expectedKey && key !== expectedKey）
   → 後端回「未授權：API Key 唔正確」，資料一直寫唔入。
   偏偏 status / ping 唔使 key，所以「測試連線」照樣顯示成功 —— 好誤導。

   以前啲測試全部打假後端（tests/_fakegas.mjs），假後端又冇做 API Key 檢查，
   所以呢個故障喺 CI 係完全隱形嘅。呢個檔用一個迷你 GAS 模擬器
   真正執行 Code.gs，驗返成個授權 + 存取契約。

   用法：node tests/gas.mjs
   ============================================================ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeGas, makeSheet } from './_gasvm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }


/* 一份似真嘅資料庫（財政 + 生日 —— 正正係用家話入唔到嗰啲） */
const sampleDb = () => ({
  meta: { updatedAt: new Date().toISOString() },
  unitCode: '0082',
  members: [
    { id: 'm1', name: '陳大文', birthday: '2008-03-14', identity: 'venture' },
    { id: 'm2', name: '李小明', birthday: '2009-11-02', identity: 'venture' }
  ],
  transactions: [
    { id: 't1', date: '2026-01-05', item: '團費收入', income: 1200, expense: 0 },
    { id: 't2', date: '2026-02-11', item: '營具維修', income: 0, expense: 340 }
  ],
  notices: [], invItems: [], meetings: [], accounts: []
});

/* ============================================================
   ① Code.gs 本身載入得到 + 有齊 action
   ============================================================ */
section('Code.gs 載入 / 基本契約');
{
  const g = makeGas();
  ok('Code.gs 行得起（語法冇問題）', typeof g.sandbox.doPost === 'function');
  ok('有 saveDb / loadDb / dbInfo', ['saveDb', 'loadDb', 'dbInfo'].every(f => typeof g.sandbox[f] === 'function'));
  ok('有 initializeSheets / showApiKey', typeof g.sandbox.initializeSheets === 'function' && typeof g.sandbox.showApiKey === 'function');
  const r = g.post({ action: 'status' });
  ok('status 唔使 API Key 都答到', r.ok === true, JSON.stringify(r).slice(0, 100));
  ok('「資料庫」分頁喺 SHEET_TABS 入面', (g.sandbox.SHEET_TABS || []).includes('資料庫'));
  ok('審計紀錄分頁喺 SHEET_TABS 入面', (g.sandbox.SHEET_TABS || []).includes('審計紀錄'));
}

/* 審計唔可以帶出 key／密碼／整份 payload */
section('Server-side access audit');
{
  const g = makeGas({ apiKey: 'audit-test-key' });
  g.sandbox.initializeSheets();
  g.post({ action: 'status', unit: '0082', apiKey: 'audit-test-key', actor: 'leader@example.com', password: 'never-log-this' });
  const rows = g.sheets.get('審計紀錄')._rows;
  const line = JSON.stringify(rows);
  ok('request metadata 寫入審計紀錄', rows.length >= 2 && line.includes('status') && line.includes('0082'));
  ok('審計紀錄不包含 API Key／密碼／payload', !line.includes('audit-test-key') && !line.includes('never-log-this'));
}

section('支部帳戶 PBKDF2 密碼基礎');
{
  const g = makeGas();
  const expected = '0394a2ede332c9a13eb82e9b24631604c31df978b4e2f0fbd2c549944f9d79a5';
  ok('後端提供 PBKDF2-HMAC-SHA256', typeof g.sandbox.pbkdf2Sha256Hex === 'function');
  ok('PBKDF2 使用最低 100,000 iterations 的標準結果',
    g.sandbox.pbkdf2Sha256Hex('password', 'salt', 100000) === expected);
  ok('密碼最短 4 位', g.sandbox.passwordPolicy('123').ok === false && g.sandbox.passwordPolicy('1234').ok === true);
  const temporary = g.sandbox.makePasswordRecord('1234');
  ok('預設 1234 會標記 mustChangePw', temporary.ok === true && temporary.mustChangePw === true);
  ok('帳戶只保存 PBKDF2 hash／salt，不保存明文密碼',
    temporary.pw.algo === 'pbkdf2-sha256' && !Object.prototype.hasOwnProperty.call(temporary.pw, 'password'));
  ok('PBKDF2 password record 可以驗證及拒絕錯密碼',
    g.sandbox.verifyPasswordRecord(temporary.pw, '1234') === true &&
    g.sandbox.verifyPasswordRecord(temporary.pw, 'wrong') === false);

  g.sandbox.initializeSheets();
  const account = g.sandbox.makePasswordRecord('abcd');
  const seeded = { unitCode: '0082', accounts: [{ id: 'a1', username: 'leader@example.com', email: 'leader@example.com', role: 'leader', active: true, pw: account.pw, mustChangePw: false }], members: [], transactions: [] };
  g.post({ action: 'saveDb', unit: '0082', db: seeded });
  const login = g.post({ action: 'authLogin', unit: '0082', username: 'leader@example.com', password: 'abcd' });
  ok('authLogin 由 GAS 核對 PBKDF2，不回傳 hash', login.ok === true && login.account?.role === 'leader' && !JSON.stringify(login).includes(account.pw.hash));
  const denied = g.post({ action: 'authLogin', unit: '0082', username: 'leader@example.com', password: 'wrong' });
  ok('authLogin 錯密碼拒絕', denied.ok === false);
  const changed = g.post({ action: 'authChangePassword', unit: '0082', username: 'leader@example.com', oldPassword: 'abcd', newPassword: '1234' });
  ok('authChangePassword 由 GAS 寫入新 hash', changed.ok === true, JSON.stringify(changed));
  const oldLogin = g.post({ action: 'authLogin', unit: '0082', username: 'leader@example.com', password: 'abcd' });
  const newLogin = g.post({ action: 'authLogin', unit: '0082', username: 'leader@example.com', password: '1234' });
  ok('改密碼後舊密碼失效、新密碼標記 mustChangePw', oldLogin.ok === false && newLogin.ok === true && newLogin.mustChangePw === true);
}

/* ============================================================
   ② 後端未設 API Key（Script Properties 空）→ 應該寫得入
   ============================================================ */
section('後端冇設 API Key：敏感 action 必須 fail closed');
{
  const g = makeGas();
  const db = sampleDb();
  const save = g.post({ action: 'saveDb', unit: '0082', apiKey: '', apikey: '', db });
  ok('saveDb fail closed', save.ok === false && save.code === 'AUTH_NOT_CONFIGURED', JSON.stringify(save).slice(0, 140));
  const back = g.post({ action: 'loadDb', unit: '0082', apiKey: '', apikey: '' });
  ok('loadDb fail closed', back.ok === false && back.code === 'AUTH_NOT_CONFIGURED');
  ok('未設定 API Key 不會回傳財政資料', back.db === undefined);
  ok('未設定 API Key 不會回傳團員資料', back.db === undefined);
}

/* ============================================================
   ③ ★ 真實故障：initializeSheets 生成咗 key，但 app 條 key 係空
   ============================================================ */
section('★ 真實故障：後端有 key、app 條 key 空');
{
  const g = makeGas();
  g.sandbox.initializeSheets();
  const generated = g.props.get('API_KEY');
  ok('initializeSheets 會自動生成 API Key', !!generated, String(generated));

  const db = sampleDb();
  const blocked = g.post({ action: 'saveDb', unit: '0082', apiKey: '', apikey: '', db });
  ok('空 key 寫入會被拒（＝用家撞到嗰個情況）',
    blocked.ok === false && /API ?Key|未授權/.test(blocked.error || ''), JSON.stringify(blocked).slice(0, 140));

  const okSave = g.post({ action: 'saveDb', unit: '0082', apiKey: generated, apikey: generated, db });
  ok('填啱 key 就寫得入', okSave.ok === true, JSON.stringify(okSave).slice(0, 140));

  /* 最誤導嗰part：連線測試照樣話 OK */
  const ping = g.post({ action: 'status', unit: '0082', apiKey: '', apikey: '' });
  ok('status 空 key 都回 ok（所以「測試連線」會呃人）', ping.ok === true);
  const info = g.post({ action: 'dbInfo', unit: '0082', apiKey: '', apikey: '' });
  ok('dbInfo 空 key 會被拒（所以用佢驗寫入權先準）',
    info.ok === false && /API ?Key|未授權/.test(info.error || ''));
}

/* ============================================================
   ③b v2.6.1（2026-09-20 團長回報）：
   ① 同步後嘅「團員」分頁要用**標題列**搵 ymis／姓名（唔好寫死欄號）
      —— 否則報表同步（schema 次序）同 initializeSheets（固定次序）兩套欄位
         次序唔同，進度讀取讀錯欄，每個人都會多咗一行「ymis=姓名、name=身份」。
   ② 報表同步要寫返**無後綴**分頁（物資／團員…），唔好再生「物資·0082」，
      並順手清走舊版留低嘅後綴分身。
   ============================================================ */
section('v2.6.1 團長回報：同步生分身分頁＋成員進度重複');
{
  const g = makeGas({ apiKey: 'test_key' });

  /* 先照 initializeSheets 咁建「無後綴」分頁 */
  g.sandbox.initializeSheets();
  const ss = g.sandbox.SpreadsheetApp.getActiveSpreadsheet();

  /* 成員名單（進度前端嘅另一來源）喺呢度要有資料 */
  const ml = ss.getSheetByName('成員名單');
  ml.appendRow(['8202001', '陳大文', '2025-01-01', '深資', '98765432']);
  ml.appendRow(['8202002', '李小明', '2025-02-01', '深資', '91234567']);

  /* 用真嘅前端 schema 欄位次序（writeTab 就跟呢套）整一份報表同步 */
  const schema = { members: [
    { key: 'name' }, { key: 'eng' }, { key: 'identity' }, { key: 'birthday' }, { key: 'role' },
    { key: 'status' }, { key: 'phone' }, { key: 'email' }, { key: 'join' }, { key: 'ymis' },
    { key: 'systemId' }, { key: 'note' }
  ] };
  const tables = {
    members: [
      { id: 'm1', name: '陳大文', eng: '', identity: 'member', birthday: '2008-03-14', role: '', status: 'active', phone: '', email: '', join: '', ymis: '8202001', systemId: '', note: '' },
      { id: 'm2', name: '李小明', eng: '', identity: 'member', birthday: '2009-11-02', role: '', status: 'active', phone: '', email: '', join: '', ymis: '8202002', systemId: '', note: '' }
    ],
    transactions: [], claims: [], invItems: [], notices: [], invLoans: [], meetings: []
  };
  const r = g.post({ action: 'sync', unit: '0082', unitName: '82旅', tables, schema, skipDb: true });
  ok('② 報表同步成功', r.ok === true && (r.counts?.members || 0) === 2, JSON.stringify(r).slice(0, 140));

  const names = ss.getSheets().map(s => s.getName());
  ok('② 唔會再生「物資·0082」等後綴分頁', !names.some(n => /·0082$/.test(n)), names.join(', '));
  ok('② 有無後綴「物資」分頁（資料寫落原本嗰張）', names.includes('物資'), names.join(', '));

  /* 模擬舊版留低嘅後綴分身 → 下次同步要清走 */
  ss.insertSheet('物資·0082');
  ss.insertSheet('團員·0082');
  g.post({ action: 'sync', unit: '0082', unitName: '82旅', tables, schema, skipDb: true });
  const names2 = ss.getSheets().map(s => s.getName());
  ok('② 舊版留低嘅後綴分身會被清走', !names2.some(n => /·0082$/.test(n)), names2.join(', '));

  /* ★ v2.6.3 迴歸測試：removeSuffixedTabs 舊寫法
       nm.indexOf(suffix) === nm.length - suffix.length
     喺「個名根本冇嗰個後綴」嗰陣 indexOf 回 -1，條件變成
       nm.length === suffix.length - 1
     —— 即係**名啱好 4 個字**嘅分頁一律被刪。「進度追蹤」「待批完成」
     「成員名單」「同步紀錄」「活動履歷」「待批履歷」「通告全文」全部都係 4 個字。
     以前淨係撳「報表同步」先會中招；v2.6.3 起 saveDb 都會刷新報表分頁，
     即係**每次儲存**都會刪走團員進度同批核紀錄 —— 呢度釘死佢。 */
  const FOUR = ['進度追蹤', '待批完成', '成員名單', '同步紀錄', '活動履歷', '待批履歷', '通告全文'];
  const missing = () => FOUR.filter(n => !ss.getSheetByName(n));
  ok('② 清後綴分身唔會誤刪「名啱好 4 個字」嘅分頁（進度追蹤／待批完成…）',
    missing().length === 0, missing().join(', ') || '全部仲在');

  /* v2.6.3：saveDb 一次過寫齊兩處（資料庫＋報表分頁），一樣唔可以誤刪。
     用**另一個 sandbox** —— 呢度寫入嘅團員會入「團員」分頁，
     留喺同一個 sandbox 會污染後面「成員無重複（2 人）」嗰個斷言。 */
  {
    const g2 = makeGas({ apiKey: 'test_key' });
    g2.sandbox.initializeSheets();
    const ss2 = g2.sandbox.SpreadsheetApp.getActiveSpreadsheet();
    const miss2 = () => ['進度追蹤', '待批完成', '成員名單', '同步紀錄', '活動履歷', '待批履歷', '通告全文']
      .filter(n => !ss2.getSheetByName(n));
    const KEY61 = g2.props.get('API_KEY') || 'K1';
    const sv61 = g2.post({ action: 'saveDb', unit: '0082', apiKey: KEY61,
      db: { members: [{ id: 'm9', name: '王五', ymis: '8202009', identity: 'member' }], transactions: [] } });
    ok('② saveDb 而家會回報「報表分頁已一齊刷新」', sv61.reports?.ok === true, JSON.stringify(sv61.reports || null).slice(0, 120));
    ok('② saveDb 一次過寫齊兩處：「團員」分頁即刻有嘢（唔使再撳報表同步）',
      (ss2.getSheetByName('團員')?.getLastRow() || 0) >= 2, String(ss2.getSheetByName('團員')?.getLastRow()));
    ok('② saveDb 之後，4 個字嘅分頁一個都冇少（進度／批核資料唔會被儲存刪走）',
      miss2().length === 0, miss2().join(', ') || '全部仲在');
    const sv62 = g2.post({ action: 'saveDb', unit: '0082', apiKey: KEY61, refreshReports: false,
      baseVersion: String(sv61.version || ''), db: { members: [], transactions: [] } });
    ok('② refreshReports:false 會略過報表刷新（舊行為仍然得）', sv62.ok === true && !sv62.reports,
      JSON.stringify(sv62.reports ?? null));
  }

  /* ① 進度讀取：以「團員」＋「成員名單」合一，唔可以讀錯欄搞到重複 */
  const load = g.get({ action: 'load', unit: '0082' });
  const mem = load.members || [];
  ok('① 成員無重複（2 人，唔係 4 人）', mem.length === 2, JSON.stringify(mem));
  ok('① YMIS 正確（係 8202001／8202002，唔係攞咗姓名／身份）',
    mem.some(m => m.ymis === '8202001' && m.name === '陳大文')
    && mem.some(m => m.ymis === '8202002' && m.name === '李小明'),
    JSON.stringify(mem));
}

/* ============================================================
   ④ 讀返嚟嘅資料要同寫出去嗰份一模一樣（唔可以走樣）
   ============================================================ */
section('round-trip：資料唔可以走樣');
{
  const g = makeGas({ apiKey: 'test_key' });
  const db = sampleDb();
  db.notices = [{ id: 'n1', title: { zh: '週年大會', en: 'AGM' }, status: 'published', signups: [{ name: '陳大文' }] }];
  db.settings = { currency: 'HK$', nested: { deep: { value: 42 } } };
  g.post({ action: 'saveDb', unit: '0082', db });
  const back = g.post({ action: 'loadDb', unit: '0082' });
  ok('巢狀物件原樣讀返（通告標題中英）', back.db?.notices?.[0]?.title?.zh === '週年大會');
  ok('深層巢狀 settings 原樣讀返', back.db?.settings?.nested?.deep?.value === 42);
  ok('報名名單唔會走樣', back.db?.notices?.[0]?.signups?.[0]?.name === '陳大文');
  ok('整份 JSON 完全相等', JSON.stringify(back.db) === JSON.stringify(db));
}

/* ============================================================
   ⑤ 大份資料要分段寫（Sheet 單格上限 50000 字元）
   ============================================================ */
section('大資料分段');
{
  const g = makeGas({ apiKey: 'test_key' });
  const db = sampleDb();
  db.blob = 'x'.repeat(120000);
  const save = g.post({ action: 'saveDb', unit: '0082', db });
  ok('120k 字元寫得入', save.ok === true, JSON.stringify(save).slice(0, 120));
  ok('會分做多段（每段 < 50000）', (save.chunks || 0) >= 3, 'chunks=' + save.chunks);
  const back = g.post({ action: 'loadDb', unit: '0082' });
  ok('分段拼返完整無缺', back.db?.blob?.length === 120000);
}

/* ============================================================
   ⑤b v2.6.0 分段讀取 loadDbPart
   ------------------------------------------------------------
   背景（2026-09-20 團長回報「無痕同普通視窗對唔到料，仲話我冇後端」）：
   Vercel 代理單一回應有 4.5MB 硬上限。資料庫大過呢個數，loadDb 一次過
   回成份 JSON 就會令 Vercel 回 500 純文字（FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE），
   前端當「唔係 JSON」→ 誤判「呢個部署冇 /api」→ 對用家講「未設定後端網址」。
   每部機於是讀唔到後端、各自儲存自己嗰份 —— 兩邊永遠對唔到料。
   loadDbPart 每次淨係回一段純文字，前端逐段拼返，就唔會撞呢個上限。
   ============================================================ */
section('v2.6.0 分段讀取：loadDbPart（大過 4.5MB 都讀得返）');
{
  const g = makeGas({ apiKey: 'test_key' });
  /* 砌一個 5MB 嘅資料庫（大過 Vercel 4.5MB 回應上限） */
  const db = sampleDb();
  db.blob = 'y'.repeat(5_000_000);
  const save = g.post({ action: 'saveDb', unit: '0082', db });
  const totalBytes = save.bytes || 0;
  ok('5MB 資料庫分件寫得入', save.ok === true && totalBytes > 4_500_000,
    `bytes=${totalBytes} ok=${save.ok}`);
  ok('呢個體積一次過 loadDb 確實會爆 Vercel 上限（測試前提成立）', totalBytes > 4.5 * 1024 * 1024);

  /* 逐段讀返 */
  const first = g.post({ action: 'loadDbPart', unit: '0082', partIdx: 0 });
  ok('loadDbPart 回 ok＋found', first.ok === true && first.found === true, JSON.stringify(first).slice(0, 140));
  ok('loadDbPart 回 bytes＝成份體積', first.bytes === totalBytes, `${first.bytes} vs ${totalBytes}`);
  ok('loadDbPart 回 parts＞1（真係要分段）', (first.parts || 0) > 1, 'parts=' + first.parts);
  ok('loadDbPart 每段 < 4.5MB（唔會再撞上限）',
    String(first.part || '').length < 4.5 * 1024 * 1024, 'len=' + String(first.part || '').length);
  ok('loadDbPart 每段約 1MB（留足水位）',
    String(first.part || '').length <= 1_000_000, 'len=' + String(first.part || '').length);
  ok('loadDbPart 回 version（前端用嚟核對有冇讀緊嗰陣被人儲存）',
    typeof first.version === 'string' && first.version.length > 0);

  let text = '', parts = first.parts || 1, versionDrift = false;
  for (let i = 0; i < parts; i++) {
    const r = g.post({ action: 'loadDbPart', unit: '0082', partIdx: i });
    if (r.version !== first.version) versionDrift = true;
    text += String(r.part || '');
  }
  ok('逐段讀返：段段同一個 version（冇讀到半新半舊）', versionDrift === false);
  ok('逐段讀返：拼埋長度同成份一樣', text.length === totalBytes, `${text.length} vs ${totalBytes}`);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  ok('逐段讀返：砌返完整 JSON（parse 得到）', parsed !== null);
  ok('逐段讀返：內容同成份 loadDb 一模一样',
    parsed?.blob?.length === 5_000_000 && parsed?.unitCode === db.unitCode,
    `blob=${parsed?.blob?.length}`);

  /* 同一份資料，兩條路一定要讀到同一份 —— dbRawText 共用先至會咁 */
  const whole = g.post({ action: 'loadDb', unit: '0082' });
  ok('loadDb 同 loadDbPart 讀到同一個 version', whole.version === first.version);
  ok('loadDb 同 loadDbPart 讀到同一個 bytes', whole.bytes === first.bytes);

  /* 段號超範圍：唔可以靜靜地回空字串（前端會以為讀完） */
  const over = g.post({ action: 'loadDbPart', unit: '0082', partIdx: parts + 5 });
  ok('段號超範圍 → 明確報錯（唔係靜靜地回空）', over.ok === false && /超出範圍/.test(String(over.error || '')),
    JSON.stringify(over).slice(0, 140));

  /* 負數／垃圾 partIdx 唔可以擲錯 */
  const neg = g.post({ action: 'loadDbPart', unit: '0082', partIdx: -3 });
  ok('負數 partIdx 當 0 處理（唔會擲錯）', neg.ok === true && neg.partIdx === 0);

  /* 空後端 */
  const g2 = makeGas({ apiKey: 'test_key' });
  const empty = g2.post({ action: 'loadDbPart', unit: '0082', partIdx: 0 });
  ok('空後端 loadDbPart 回 found:false（唔係報錯）', empty.ok === true && empty.found === false,
    JSON.stringify(empty).slice(0, 120));

  /* 旅團隔離：唔可以分段讀到人哋嘅 */
  const g3 = makeGas({ apiKey: 'test_key' });
  const a = sampleDb(); a.unitCode = '0082'; a.members = [{ id: 'a', name: '0082 團員' }];
  const b = sampleDb(); b.unitCode = '0099'; b.members = [{ id: 'b', name: '0099 團員' }];
  g3.post({ action: 'saveDb', unit: '0082', db: a });
  g3.post({ action: 'saveDb', unit: '0099', db: b });
  const pa = g3.post({ action: 'loadDbPart', unit: '0082', partIdx: 0 });
  ok('分段讀都有旅團隔離（0082 讀唔到 0099）',
    /0082 團員/.test(String(pa.part)) && !/0099 團員/.test(String(pa.part)));

  /* 授權：同 loadDb 一樣要 API Key */
  const g4 = makeGas({ apiKey: 'test_key' });
  g4.sandbox.initializeSheets();          // 會自動生成 API Key（同真實部署一樣）
  const noKey = g4.post({ action: 'loadDbPart', unit: '0082', partIdx: 0, apiKey: '', apikey: '' });
  ok('loadDbPart 冇 key → 未授權（同 loadDb 一樣嚴）', noKey.ok === false && /API ?Key|未授權/.test(String(noKey.error || '')),
    JSON.stringify(noKey).slice(0, 140));
  const withKey = g4.post({ action: 'loadDbPart', unit: '0082', partIdx: 0, apiKey: g4.props.get('API_KEY') });
  ok('loadDbPart 填啱 key 就讀到', withKey.ok === true, JSON.stringify(withKey).slice(0, 140));

  /* 未知 action 嘅提示要講真話（以前手寫死，漏咗 constitution） */
  const unknown = g.post({ action: 'no_such_action', unit: '0082' });
  ok('未知 action 提示列出 loadDbPart', /loadDbPart/.test(String(unknown.hint || '')));
  ok('未知 action 提示列出 constitution（以前漏咗）', /constitution/.test(String(unknown.hint || '')));
}

/* ============================================================
   ⑥ 旅團隔離：唔可以讀到人哋旅團嘅資料
   ============================================================ */
section('旅團隔離');
{
  const g = makeGas({ apiKey: 'test_key' });
  const a = sampleDb(); a.unitCode = '0082'; a.members = [{ id: 'a', name: '0082 團員' }];
  const b = sampleDb(); b.unitCode = '0099'; b.members = [{ id: 'b', name: '0099 團員' }];
  g.post({ action: 'saveDb', unit: '0082', db: a });
  g.post({ action: 'saveDb', unit: '0099', db: b });
  const ra = g.post({ action: 'loadDb', unit: '0082' });
  const rb = g.post({ action: 'loadDb', unit: '0099' });
  ok('0082 只讀到自己嘅', ra.db?.members?.[0]?.name === '0082 團員');
  ok('0099 只讀到自己嘅', rb.db?.members?.[0]?.name === '0099 團員');
  /* 再存一次 0082，唔可以整爛 0099（v2.2.0 起要帶 baseVersion 樂觀鎖） */
  a.members.push({ id: 'a2', name: '新團員' });
  const v6 = g.post({ action: 'loadDb', unit: '0082' });
  g.post({ action: 'saveDb', unit: '0082', db: a, baseVersion: v6.version || '' });
  const rb2 = g.post({ action: 'loadDb', unit: '0099' });
  ok('覆寫 0082 唔會影響 0099', rb2.db?.members?.[0]?.name === '0099 團員' && rb2.found === true);
}

/* ============================================================
   ⑦ 覆寫唔可以留低舊段（唔係 append 上去）
   ============================================================ */
section('覆寫要乾淨');
{
  const g = makeGas({ apiKey: 'test_key' });
  const big = sampleDb(); big.blob = 'y'.repeat(100000);
  g.post({ action: 'saveDb', unit: '0082', db: big });
  const small = sampleDb();
  const v7 = g.post({ action: 'loadDb', unit: '0082' });
  g.post({ action: 'saveDb', unit: '0082', db: small, baseVersion: v7.version || '' });
  const back = g.post({ action: 'loadDb', unit: '0082' });
  ok('大份變細份之後，讀返嘅係細份（冇殘留舊段）', back.db?.blob === undefined && JSON.stringify(back.db) === JSON.stringify(small));
}

/* ============================================================
   ⑧ app 同後端嘅 Code.gs 要同步（build 出嚟嗰份）
   ============================================================ */
section('gastemplate 同 apps-script/Code.gs 一致');
{
  const built = fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8');
  const tpl = fs.readFileSync(path.join(ROOT, 'assets/js/lib/gastemplate.js'), 'utf8');
  ok('gastemplate 有 saveDb / loadDb / dbInfo', /saveDb/.test(tpl) && /loadDb/.test(tpl) && /dbInfo/.test(tpl));
  ok('兩份都有「資料庫」分頁', /資料庫/.test(built) && /資料庫/.test(tpl));
  ok('版本號一致',
    (built.match(/v?2\.4\.\d/) || [''])[0] === (tpl.match(/v?2\.4\.\d/) || [''])[0],
    `built=${(built.match(/v?2\.4\.\d/) || [''])[0]} tpl=${(tpl.match(/v?2\.4\.\d/) || [''])[0]}`);
}

/* ============================================================
   ⑧ 樂觀鎖（v2.2.0）：過時裝置唔可以用舊資料盲蓋後端
   ------------------------------------------------------------
   2026-09-18 真實事故：普通 Chrome（本機過時）一登入就把
   另一部機啱啱同步嘅資料整個蓋走 —— 後端一定要拒收舊版本。
   ============================================================ */
section('樂觀鎖：saveDb baseVersion（過時裝置唔可以盲蓋後端）');
{
  const g = makeGas({ apiKey: 'test_key' });
  /* 後端仲係空 → 第一次存唔使 baseVersion 都得（新旅團開張） */
  const first = g.post({ action: 'saveDb', unit: '0110', db: sampleDb() });
  ok('後端空：第一次存成功（唔使 baseVersion）', first.ok === true, JSON.stringify(first).slice(0, 120));
  const V1 = first.version;

  /* 另一部機用正確 baseVersion 存新版本 */
  const db2 = sampleDb(); db2.meta.updatedAt = '2026-09-18T12:00:00.000Z'; db2.members.push({ id: 'm9', name: '第二部機加嘅' });
  const second = g.post({ action: 'saveDb', unit: '0110', db: db2, baseVersion: V1 });
  ok('baseVersion 對上 → 存得到', second.ok === true, JSON.stringify(second).slice(0, 120));
  const V2 = second.version;
  ok('版本有更新', V2 && V2 !== V1, `${V1} -> ${V2}`);

  /* 過時裝置攞住舊 baseVersion（V1）想蓋 → 拒收 + conflict */
  const stale = sampleDb(); stale.meta.updatedAt = '2026-09-18T09:00:00.000Z'; stale.members = [];
  const conflictSave = g.post({ action: 'saveDb', unit: '0110', db: stale, baseVersion: V1 });
  ok('舊 baseVersion → 拒收（conflict:true）', conflictSave.ok === false && conflictSave.conflict === true, JSON.stringify(conflictSave).slice(0, 160));
  ok('拒收嗰陣話畀你知後端而家咩版本', conflictSave.version === V2, JSON.stringify(conflictSave.version));
  const unchanged = g.post({ action: 'loadDb', unit: '0110' });
  ok('拒收之後後端資料冇被改動', unchanged.db?.members?.length === 3, JSON.stringify(unchanged.db?.members?.length));

  /* 冇帶 baseVersion（舊版 app）而後端有版本 → 都要拒收（防盲蓋） */
  const legacy = g.post({ action: 'saveDb', unit: '0110', db: stale });
  ok('冇 baseVersion（舊版 app）→ 一樣拒收', legacy.ok === false && legacy.conflict === true, JSON.stringify(legacy).slice(0, 160));

  /* 唔同旅團互不影響 */
  const other = g.post({ action: 'saveDb', unit: '0220', db: sampleDb() });
  ok('另一個旅團（後端空）照樣第一次存得到', other.ok === true, JSON.stringify(other).slice(0, 120));
}

/* ============================================================
   ⑨ 團員自助申報（v2.2.0）：addRequest / myRequests
   ------------------------------------------------------------
   團員喺團員入口申報完成 → 寫入「待批完成」（pending），
   執委喺審批中心批核。addRequest 免 API Key（同 claim/loan 睇齊）。
   ============================================================ */
section('團員自助申報：addRequest / myRequests');
{
  const g = makeGas({ apiKey: 'test_key' });
  g.sandbox.initializeSheets();
  const ar = g.post({ action: 'addRequest', unit: '0082', ymis: '2026000001', name: '陳大文', item_id: 'VS-C1', item_name: '技能科 第 1 項', requested_date: '2026-09-18', evidence: '夏季營完成' });
  ok('addRequest 免 key 都寫得到（寫入待批完成）', ar.ok === true && !!ar.request_id, JSON.stringify(ar).slice(0, 160));
  const mine = g.post({ action: 'myRequests', unit: '0082', ymis: '2026000001' });
  ok('myRequests 攞返自己嘅申報', mine.ok === true && mine.requests?.length === 1, JSON.stringify(mine).slice(0, 200));
  ok('申報狀態係 pending', mine.requests?.[0]?.status === 'pending', JSON.stringify(mine.requests?.[0]));
  ok('項目名／日期正確', mine.requests?.[0]?.item_name === '技能科 第 1 項' && mine.requests?.[0]?.requested_date === '2026-09-18', JSON.stringify(mine.requests?.[0]));
  const other = g.post({ action: 'myRequests', unit: '0082', ymis: '9999999999' });
  ok('第二個團員查唔到人哋嘅申報', other.ok === true && other.requests?.length === 0, JSON.stringify(other));

  /* 缺欄位要拒 */
  const bad = g.post({ action: 'addRequest', unit: '0082', ymis: '', item_id: '' });
  ok('缺 ymis/item_id → 拒', bad.ok === false, JSON.stringify(bad).slice(0, 120));
}

/* ============================================================
   ⑩ 體積治理（v2.3.0）：uploadPhotos／dbInfo sizes
   ------------------------------------------------------------
   APP 內申報嘅相片要直接上 Drive（唔好入 db JSON）；
   dbInfo 要回逐分頁體積（app 畫「體積檢查」用）。
   ============================================================ */
section('體積治理：uploadPhotos 上 Drive／dbInfo 回體積');
{
  const g = makeGas({ apiKey: 'test_key' });
  /* 唔叫 initializeSheets（唔想生成 API Key 擋住 saveDb；呢個 section 只測體積契約） */
  /* savePhotos 冇 DRIVE_FOLDER_ID 嗰陣會回空陣列 —— 契約唔可以爆 */
  const up = g.post({ action: 'uploadPhotos', unit: '0082',
    payload: { id: 'c_test1', photos: [{ name: 'a.jpg', type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAAA' }] } });
  ok('uploadPhotos 免 key 都用到', up.ok === true, JSON.stringify(up).slice(0, 160));
  ok('uploadPhotos 回 links 陣列（冇 Folder 時係空）', Array.isArray(up.links) && up.saved === 0, JSON.stringify(up));

  /* dbInfo 回逐分頁體積 */
  const db = sampleDb();
  db.claims = [{ id: 'c1', photos: [{ name: 'x', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(1000) }] }];
  const saved = g.post({ action: 'saveDb', unit: '0082', db });
  ok('存一份有相片嘅 db 成功', saved.ok === true, JSON.stringify(saved).slice(0, 140));
  const info = g.post({ action: 'dbInfo', unit: '0082' });
  ok('dbInfo 回 sizes（逐分頁 bytes）', info.ok === true && typeof info.sizes === 'object' && info.sizes.members > 0, JSON.stringify(info.sizes || {}));
  ok('dbInfo 回 photoBytes（相片食緊幾多）', info.photoBytes > 1000, JSON.stringify(info.photoBytes));
  ok('dbInfo counts 照舊有（向後兼容）', info.counts?.members === 2, JSON.stringify(info.counts));

  /* 大份 db 再存一次：確認 deleteRows 成梳刪唔會爛（存完讀得返） */
  const big = sampleDb(); big.blob = 'z'.repeat(60000);
  const bigSave = g.post({ action: 'saveDb', unit: '0082', db: big, baseVersion: saved.version });
  ok('大份資料重存（成梳刪舊段）成功', bigSave.ok === true, JSON.stringify(bigSave).slice(0, 120));
  const bigBack = g.post({ action: 'loadDb', unit: '0082' });
  ok('成梳刪之後讀返冇殘留', bigBack.db?.blob?.length === 60000);
}

/* ------------------------------------------------------------
   ⑪ 分件儲存（v2.4.0 長壽命）：saveDbPart／saveDbCommit
   db 大過單一請求上限都存得到 —— 暫存→逐件→拼合→清暫存。
   ------------------------------------------------------------ */
section('分件儲存：saveDbPart／saveDbCommit（長壽命架構）');
{
  const g = makeGas({ apiKey: 'test_key' });
  const mk = (tag) => ({
    schema: 2, kind: 'ecportal', unitCode: '0082',
    members: [{ id: 'm' + tag, name: '團員' + tag }],
    blob: tag.repeat(3000)          // 每件帶啲肉
  });
  const saveId = '0082-stg-' + Date.now().toString(36) + '-abcd';

  /* 5 件：冇 part 0（要拒）、齊件、saveId 唔啱格式、partIdx 越界、撞版 */
  const noPart0 = g.post({ action: 'saveDbPart', unit: '0082', saveId, partIdx: 1, parts: 5, baseVersion: '', data: mk('1') });
  ok('分件冇 part 0 開頭都照收（版本檢查只做一次）', noPart0.ok === true, JSON.stringify(noPart0).slice(0, 120));
  g.post({ action: 'saveDbPart', unit: '0082', saveId, partIdx: 3, parts: 5, baseVersion: '', data: mk('3') });
  const badId = g.post({ action: 'saveDbPart', unit: '0082', saveId: '0082-xxx', partIdx: 0, parts: 2, baseVersion: '', data: mk('x') });
  ok('saveId 唔係 <unit>-stg- 開頭會拒', badId.ok === false, JSON.stringify(badId).slice(0, 120));
  const oob = g.post({ action: 'saveDbPart', unit: '0082', saveId, partIdx: 9, parts: 5, baseVersion: '', data: mk('9') });
  ok('partIdx 越界會拒', oob.ok === false, JSON.stringify(oob).slice(0, 100));

  /* 補埋第 0（版本檢查位）同其餘件 → commit */
  g.post({ action: 'saveDbPart', unit: '0082', saveId, partIdx: 0, parts: 5, baseVersion: '', data: mk('0') });
  g.post({ action: 'saveDbPart', unit: '0082', saveId, partIdx: 2, parts: 5, baseVersion: '', data: mk('2') });
  g.post({ action: 'saveDbPart', unit: '0082', saveId, partIdx: 4, parts: 5, baseVersion: '', data: mk('4') });

  const missing = g.post({ action: 'saveDbCommit', unit: '0082', saveId, parts: 7, baseVersion: '' });
  ok('缺件 commit 會拒（話埋邊件缺）', missing.ok === false && /缺少分件/.test(String(missing.error)), JSON.stringify(missing).slice(0, 140));

  const committed = g.post({ action: 'saveDbCommit', unit: '0082', saveId, parts: 5, baseVersion: '' });
  ok('齊件 commit 成功＋回新版本', committed.ok === true && !!committed.version, JSON.stringify(committed).slice(0, 140));

  const back = g.post({ action: 'loadDb', unit: '0082' });
  ok('拼合後讀得返：陣列按件序接駁（5 件各帶 1 個 → 5 個）', back.db?.members?.length === 5, JSON.stringify(back.db?.members));
  ok('後件覆蓋：blob 係最後一件嘅內容', back.db?.blob === '4'.repeat(3000), String(back.db?.blob || '').slice(0, 20));

  const info = g.post({ action: 'dbInfo', unit: '0082' });
  ok('dbInfo 唔會俾暫存行污染 counts', info.counts?.members === 5, JSON.stringify(info.counts));

  /* 撞版：part 0 對住新版本就拒 */
  const conflictPart = g.post({ action: 'saveDbPart', unit: '0082', saveId: '0082-stg-x1-aaaa', partIdx: 0, parts: 2, baseVersion: '舊版本', data: mk('a') });
  ok('分件撞版（part 0 版本唔對）會拒', conflictPart.ok === false && conflictPart.conflict === true, JSON.stringify(conflictPart).slice(0, 140));
  const conflictCommit = g.post({ action: 'saveDbCommit', unit: '0082', saveId: '0082-stg-x1-aaaa', parts: 2, baseVersion: committed.version + '-old' });
  ok('commit 撞版都會拒', conflictCommit.ok === false && conflictCommit.conflict === true, JSON.stringify(conflictCommit).slice(0, 120));

  /* 暫存唔會污染正常 loadDb／成梳刪：再存一次單件確認舊暫存清走 */
  const again = g.post({ action: 'saveDb', unit: '0082', db: mk('Z'), baseVersion: committed.version });
  ok('分件之後照樣可以單件儲存', again.ok === true, JSON.stringify(again).slice(0, 100));
  const back2 = g.post({ action: 'loadDb', unit: '0082' });
  ok('單件重存後讀返啱', back2.db?.blob === 'Z'.repeat(3000));

  /* receiptFolderId 三層：uploadPhotos 帶 folderId（folders/ URL 都收） */
  const upF = g.post({ action: 'uploadPhotos', unit: '0082', folderId: 'https://drive.google.com/drive/folders/ABC123',
    payload: { id: 'c_f1', photos: [{ name: 'b.jpg', type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BBBB' }] } });
  ok('uploadPhotos 帶 folderId 免 key 用到（契約唔爆）', upF.ok === true && Array.isArray(upF.links), JSON.stringify(upF).slice(0, 140));
}


/* ============================================================
   ⑨ v2.5.0 公開頁：團章／通告讀「資料庫」正本＋公開頁送出寫入資料庫
   （團長回報：團章發布咗公開頁睇唔到、成員送出嘅嘢執委見唔到）
   ============================================================ */
section('v2.5.0：公開團章／通告讀正本、公開頁送出寫入資料庫');
{
  const g = makeGas({ apiKey: 'test_key' });
  /* 種一份有已發布團章＋通告嘅資料庫 */
  const db = sampleDb();
  db.profile = { name: '第八十二旅深資童軍團' };
  db.constitution = { version: '3.1', status: 'published', chapters: [{ heading: { zh: '總則' }, articles: [] }] };
  db.notices = [
    { id: 'n1', title: { zh: '開放報名' }, status: 'published', needSignup: true, signups: [] },
    { id: 'n2', title: { zh: '草稿' }, status: 'draft', signups: [] }
  ];
  ok('種資料入後端', g.post({ action: 'saveDb', unit: '0082', db }).ok === true);

  const ping = g.post({ action: 'status' });
  ok('status 回報 backendVersion（APP 可以驗後端係咪舊版）',
    /^v2\./.test(String(ping.backendVersion || '')), JSON.stringify(ping.backendVersion));

  const cons = g.post({ action: 'constitution', unit: '0082' });
  ok('公開團章：免 key 讀到已發布版（發布＋同步即刻見到）',
    cons.ok === true && cons.found === true && cons.constitution?.version === '3.1', JSON.stringify(cons).slice(0, 120));
  ok('公開團章：有旅團名', cons.unitName === '第八十二旅深資童軍團', cons.unitName);
  ok('公開團章：只回 constitution，唔會漏名冊／帳目',
    !JSON.stringify(cons).includes('陳大文') && cons.db === undefined);

  const nt = g.post({ action: 'notices', unit: '0082' });
  ok('公開通告：由資料庫正本讀（淨係 published；唔使再手動「總表同步」）',
    (nt.notices || []).length === 1 && nt.notices[0]?.id === 'n1',
    JSON.stringify((nt.notices || []).map(n => n.id)));

  /* 公開頁報名 → 寫入資料庫（同名防重複） */
  const sg1 = g.post({ action: 'noticeSignup', unit: '0082', payload: { noticeId: 'n1', noticeTitle: '開放報名', values: { name: '陳大文', attend: '出席' } } });
  ok('公開頁報名成功', sg1.ok === true && sg1.duplicate === false, JSON.stringify(sg1));
  const sg2 = g.post({ action: 'noticeSignup', unit: '0082', payload: { noticeId: 'n1', values: { name: '陳大文', attend: '出席' } } });
  ok('同一通告同名再報 → 防重複（換裝置重複提交都唔會重複入數）',
    sg2.ok === true && sg2.duplicate === true, JSON.stringify(sg2));
  const back1 = g.post({ action: 'loadDb', unit: '0082' });
  const n1 = (back1.db?.notices || []).find(n => n.id === 'n1');
  ok('報名寫入咗資料庫（執委部機開住 APP 就會拉到）',
    (n1?.signups || []).length === 1 && n1.signups[0]?.name === '陳大文', JSON.stringify(n1?.signups));

  /* 公開收支申報 → 寫入 db.claims（pending） */
  const cl = g.post({ action: 'claim', unit: '0082', payload: { id: 'cl_x1', type: 'expense', amount: 100, date: '2026-09-18', item: '物資', byName: '陳大文', photos: [] } });
  ok('公開收支申報送到', cl.ok === true, JSON.stringify(cl));
  g.post({ action: 'claim', unit: '0082', payload: { id: 'cl_x1', type: 'expense', amount: 100, date: '2026-09-18', item: '物資', byName: '陳大文', photos: [] } });
  const back2 = g.post({ action: 'loadDb', unit: '0082' });
  const claims = back2.db?.claims || [];
  const clRec = claims.find(c => c.id === 'cl_x1');
  ok('收支申報寫入資料庫（APP「財務→收支申報」待批清單即刻見到）',
    clRec?.status === 'pending' && clRec?.byName === '陳大文', JSON.stringify(clRec));
  ok('重送同一筆申報唔會重複入數', claims.length === 1, String(claims.length));

  /* 公開借用 → 寫入 db.invLoans（requested） */
  const ln = g.post({ action: 'loan', unit: '0082', payload: { id: 'ln_x1', itemId: 'gi01', qty: 2, byName: '陳大文', fromDate: '2026-10-01', toDate: '2026-10-03', purpose: '露營', contact: '12345678' } });
  ok('公開借用申請送到', ln.ok === true, JSON.stringify(ln));
  const back3 = g.post({ action: 'loadDb', unit: '0082' });
  const lnRec = (back3.db?.invLoans || []).find(l => l.id === 'ln_x1');
  ok('借用寫入資料庫（APP「物資→借用與批核」即刻見到）',
    lnRec?.status === 'requested' && lnRec?.qty === 2, JSON.stringify(lnRec));

  /* 旅團隔離＋未發布團章 → found:false */
  const db2 = sampleDb();
  db2.constitution = { version: '0.1', status: 'draft', chapters: [] };
  g.post({ action: 'saveDb', unit: '0099', db: db2 });
  const cons99 = g.post({ action: 'constitution', unit: '0099' });
  ok('未發布團章 → found:false（公開頁會用靜態檔後備）', cons99.ok === true && cons99.found === false, JSON.stringify(cons99).slice(0, 100));
  const cons88 = g.post({ action: 'constitution', unit: '0088' });
  ok('後端冇資料嘅旅團 → found:false（唔會撈錯隔籬旅）', cons88.ok === true && cons88.found === false);
}


/* ============================================================
   ⑩ 寫入衝突模擬（2026-09-19 團長問題：「團員入口做進度追蹤，
   兩個系統會唔會寫入衝突？密碼唔同、YMIS 一樣得唔得？」）
   答案嘅根據 —— 三條寫入路線各寫各嘅分頁：
     執委系統 saveDb →「資料庫」分頁（成個 app db）
     進度前端 save →「進度追蹤」分頁（要 API Key＝執委身份）
     團員入口 addRequest →「待批完成」分頁（免 key、只可 append）
   模擬三邊輪流＋穿插咁寫，驗證冇任何一邊嘅資料被蓋走。
   ============================================================ */
section('寫入衝突模擬：執委 db ＋ 進度前端 ＋ 團員入口三路齊寫');
{
  const g = makeGas({ apiKey: 'K1' });
  g.sandbox.initializeSheets();                        // 建齊分頁（資料庫／進度追蹤／待批完成…）
  const KEY = g.props.get('API_KEY') || 'K1';

  /* ① 執委系統：saveDb 推名冊（陳大文＋李小明） */
  const db1 = sampleDb();
  ok('① 執委 saveDb 推名冊成功', g.post({ action: 'saveDb', unit: '0082', db: db1, apiKey: KEY }).ok === true);

  /* ② 兩個團員（唔同密碼都好，身份靠 YMIS）同時申報完成 —— 免 key */
  const a1 = g.post({ action: 'addRequest', unit: '0082', ymis: '2008-001', name: '陳大文', item_id: 'L1-ACT-01', item_name: '參加六次活動', requested_date: '2026-09-01', evidence: 'A' });
  const a2 = g.post({ action: 'addRequest', unit: '0082', ymis: '2009-002', name: '李小明', item_id: 'L1-ACT-01', item_name: '參加六次活動', requested_date: '2026-09-02', evidence: 'B' });
  ok('② 兩個團員各自申報成功（免 key，各有一條 request_id）',
    a1.ok === true && a2.ok === true && a1.request_id !== a2.request_id,
    JSON.stringify([a1.request_id, a2.request_id]));

  /* ③ 進度前端（執委身份）同時直接勾另一項 —— 要 key */
  const s1 = g.post({ action: 'save', unit: '0082', apiKey: KEY, changes: [{ ymis: '2008-001', itemId: 'L1-SRV-01', date: '2026-08-30' }], confirmer: '陳領袖' });
  ok('③ 進度前端直接勾項成功（API Key＝執委身份）', s1.ok === true && s1.processed === 1, JSON.stringify(s1));
  const sBad = g.post({ action: 'save', unit: '0082', apiKey: '錯key', changes: [{ ymis: '2008-001', itemId: 'X', date: '2026-08-30' }] });
  ok('③ 冇 key／錯 key 想直接勾 → 拒（團員入口只能夠申報，等批）', sBad.ok === false);

  /* ④ 執委再推新版成個資料庫（團員申報緊嘅時候） */
  const info1 = g.post({ action: 'dbInfo', unit: '0082', apiKey: KEY });
  const db2 = sampleDb();
  db2.members.push({ id: 'm3', name: '新團員', birthday: '2010-06-01', identity: 'member' });
  const sv2 = g.post({ action: 'saveDb', unit: '0082', db: db2, apiKey: KEY, baseVersion: String(info1.version || '') });
  ok('④ 執委再推新版 db（全份覆寫「資料庫」分頁）成功', sv2.ok === true, JSON.stringify(sv2).slice(0, 100));

  /* ★ 關鍵：db 覆寫之後，三邊資料全部原封不動 */
  const ld = g.get({ action: 'load' });
  ok('★ db 覆寫後：進度追蹤紀錄仲喺度（唔會被 saveDb 蓋走）',
    ld.progress?.['2008-001']?.['L1-SRV-01']?.date === '2026-08-30', JSON.stringify(ld.progress));
  ok('★ db 覆寫後：兩個團員嘅申報仲喺度（pendingRequests 2 條）',
    (ld.pendingRequests || []).length === 2, JSON.stringify((ld.pendingRequests || []).map(r => r.ymis)));
  ok('★ db 覆寫後：loadDb 名冊係新版（3 人）',
    (g.post({ action: 'loadDb', unit: '0082', apiKey: KEY }).db?.members || []).length === 3);

  /* ⑤ 執委批核陳大文嘅申請 → 寫入進度追蹤 */
  const rv = g.post({ action: 'reviewRequest', unit: '0082', apiKey: KEY, request_id: a1.request_id, decision: 'approved', review_note: 'OK', reviewer: '陳領袖', confirmed_date: '2026-09-19' });
  ok('⑤ 執委批核成功（批准＝寫入進度追蹤）', rv.ok === true, JSON.stringify(rv));
  const my1 = g.post({ action: 'myRequests', unit: '0082', ymis: '2008-001' });
  const my2 = g.post({ action: 'myRequests', unit: '0082', ymis: '2009-002' });
  ok('⑤ 陳大文見到自己申請「已批准」', my1.requests?.[0]?.status === 'approved', JSON.stringify(my1.requests?.[0]));
  ok('⑤ myRequests 只回自己（李小明仲係 pending，見唔到陳大文嘅）',
    my2.requests?.length === 1 && my2.requests[0]?.status === 'pending', JSON.stringify(my2.requests?.map(r => r.status)));
  const ld2 = g.get({ action: 'load' });
  ok('★ 批核寫入咗進度追蹤：陳大文 L1-ACT-01 有日期＋批核人（兩個前端都即刻見到）',
    ld2.progress?.['2008-001']?.['L1-ACT-01']?.confirmer === '陳領袖', JSON.stringify(ld2.progress?.['2008-001']));

  /* ⑥ 同一項再批一次 → 拒（防重複入數） */
  const rv2 = g.post({ action: 'reviewRequest', unit: '0082', apiKey: KEY, request_id: a1.request_id, decision: 'approved', reviewer: '陳領袖' });
  ok('⑥ 同一申請批兩次 → 拒（唔會重複入數）', rv2.ok === false, JSON.stringify(rv2));
}


console.log(`\n${fail === 0 ? '✅' : '❌'} Code.gs：${pass} 過 / ${fail} 唔過（${Date.now() - t0}ms）`);
process.exit(fail === 0 ? 0 : 1);
