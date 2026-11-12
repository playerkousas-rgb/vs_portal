/* ============================================================
   tests/init-preserve.mjs — 初始化資料保全守護測試
   ------------------------------------------------------------
   守嘅係本 repo 作為「其他支部系統參考模版」最重要嘅一條鐵律：

     ★ 每次更新 Code.gs 之後，都可以安心行一次 initializeSheets()，
       而唔會破壞用戶原本嘅資料。

   學 vsbadge（ensureUserColumns / VS_GS_INITIALIZED_VERSION / v9.1 定案），
   用「前後逐表快照對比」證明，而唔係淨係 assert 啲字串：
     ① 舊 Sheet（已有資料、欄位唔齊）→ 初始化會補齊缺失欄位
     ② 補欄只加喺最右；現有每一格（連欄位位置）一個字都冇改
     ③ 現有 API Key 唔會換
     ④ idempotent：連跑兩次，第二次零結構改動、快照完全一樣
     ⑤ 未行初始化 → status 報 initializeRequired:true；行之後變 false
     ⑥ 第一行唔似標題列 → 唔敢自動加欄（如實報 skipped，唔污染資料）
     ⑦ 缺失分頁會建立（包括「資料表」—— 逐表寫入嘅正本目標）

   用法：node tests/init-preserve.mjs
   ============================================================ */

import { makeGas } from './_gasvm.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 逐表快照：分頁名 → 全部行（深拷貝，避免之後被改動影響）。 */
function snapshot(gas) {
  const out = {};
  for (const sh of gas.sheets.values()) out[sh.getName()] = JSON.parse(JSON.stringify(sh._rows));
  return out;
}
/** 只比較「資料行」（跳過 header），用嚟證明用戶資料零改動。 */
function dataRows(rows) { return rows.slice(1); }

console.log('\n▌① 舊 Sheet 升級：補缺失欄位，但唔改任何現有資料');
{
  const gas = makeGas({ apiKey: 'v82_existing_key_keep_me' });

  /* 扮一張用咗幾年嘅舊 Sheet：
     · 「團員」只得舊欄（欠 英文名／systemId／職位… 等新欄）
     · 「進度追蹤」齊欄（同進度前端共用，欄位位置唔可以變）
     · 每個表都有真實用戶資料 */
  const members = gas.sandbox.SpreadsheetApp.getActiveSpreadsheet().insertSheet('團員');
  members.appendRow(['旅團', 'id', 'ymis', '姓名', '身份', '生日', '同步時間']);
  members.appendRow(['0082', 'm-1', '1234567890', '陳大文', '團員', '2008-03-15', '2026-01-01T00:00:00Z']);
  members.appendRow(['0082', 'm-2', '0987654321', '李小明', '執委', '2007-11-02', '2026-01-02T00:00:00Z']);

  const progress = gas.sandbox.SpreadsheetApp.getActiveSpreadsheet().insertSheet('進度追蹤');
  progress.appendRow(['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註']);
  progress.appendRow(['1234567890', 'vs-a-1', '2026-02-01', '2026-02-01T10:00:00Z', '領袖甲', '已完成']);

  const badges = gas.sandbox.SpreadsheetApp.getActiveSpreadsheet().insertSheet('其他獎章');
  badges.appendRow(['YMIS', '獎章 ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間']);
  badges.appendRow(['1234567890', 'b-1', '游泳章', '2026-03-01', 'CERT-99', '', '2026-03-01T00:00:00Z']);

  /* 用戶自訂欄（唔喺標準 header 清單入面）—— 更加唔准整走 */
  members.getRange(1, 8).setValue('自訂欄（團長自己加）');
  members.getRange(2, 8).setValue('我嘅備註');

  const before = snapshot(gas);
  const init1 = gas.sandbox.initializeSheets();

  ok('初始化回 ok/success', init1.ok === true && init1.success === true, JSON.stringify(init1).slice(0, 160));
  ok('明確回報「已保全現有資料」', init1.preservedExistingData === true);

  const after1 = snapshot(gas);

  /* ① 補欄：新欄加喺最右，舊欄位置不變 */
  const mHeaderAfter = after1['團員'][0];
  ok('舊「團員」標題列保留原有欄位順序',
    eq(mHeaderAfter.slice(0, 7), before['團員'][0].slice(0, 7)),
    JSON.stringify(mHeaderAfter));
  ok('用戶自訂欄仍然喺原位（第 8 欄）', mHeaderAfter[7] === '自訂欄（團長自己加）', String(mHeaderAfter[7]));
  ok('自訂欄嘅資料冇被推走', after1['團員'][1][7] === '我嘅備註', String(after1['團員'][1][7]));
  ok('缺失欄位已補齊（英文名／systemId／職位…）',
    ['英文名', 'systemId', '職位', '狀態', '電話', '電郵', '加入日期', '備註'].every(h => mHeaderAfter.includes(h)),
    JSON.stringify(mHeaderAfter));
  ok('補欄數目 > 0（證明舊 Sheet 真係升得到新欄）',
    (init1.addedColumns.find(r => r.tab === '團員')?.addedColumns.length || 0) > 0);

  /* ② 用戶資料一個字都冇改 */
  ok('「團員」資料行完全冇改（連 YMIS / 生日 / 自訂備註）',
    eq(dataRows(after1['團員']).map(r => r.slice(0, 8)), dataRows(before['團員']).map(r => r.slice(0, 8))),
    JSON.stringify(dataRows(after1['團員'])));
  ok('「進度追蹤」全表零改動（同進度前端共用）', eq(after1['進度追蹤'], before['進度追蹤']));
  ok('「其他獎章」全表零改動', eq(after1['其他獎章'], before['其他獎章']));

  /* ③ API Key 不變 */
  ok('現有 API Key 冇被更換', gas.props.get('API_KEY') === 'v82_existing_key_keep_me', String(gas.props.get('API_KEY')));
  ok('回傳嘅 apiKey 就係原本嗰條', init1.apiKey === 'v82_existing_key_keep_me');

  /* ④ 缺失分頁建立（包括「資料表」） */
  ok('已建立「資料表」（逐表寫入正本目標）', !!gas.sheets.get('資料表'));
  ok('已建立「資料庫」（舊路兼容）', !!gas.sheets.get('資料庫'));
  ok('已建立「成員名單」', !!gas.sheets.get('成員名單'));
  ok('已建立「待批完成」／「活動履歷」／「待批履歷」',
    ['待批完成', '活動履歷', '待批履歷'].every(n => !!gas.sheets.get(n)));

  /* ⑤ 初始化標記 */
  ok('已寫 INITIALIZED_VERSION 標記',
    gas.props.get('INITIALIZED_VERSION') === init1.backendVersion,
    `${gas.props.get('INITIALIZED_VERSION')} vs ${init1.backendVersion}`);
  ok('回報 initializationCurrent = true', init1.initializationCurrent === true);
  ok('回報 initializeRequired = false', init1.initializeRequired === false);

  console.log('\n▌ idempotent：再行一次，零改動');
  const init2 = gas.sandbox.initializeSheets();
  const after2 = snapshot(gas);
  ok('第二次初始化仍然 ok', init2.ok === true);
  ok('第二次冇再補任何欄位', init2.addedColumns.length === 0, JSON.stringify(init2.addedColumns));
  ok('第二次冇再新建任何分頁', init2.created.length === 0, JSON.stringify(init2.created));
  ok('連跑兩次之後全表快照完全一樣（idempotent）', eq(after2, after1));
  ok('API Key 仍然係原本嗰條', gas.props.get('API_KEY') === 'v82_existing_key_keep_me');

  console.log('\n▌③ 第三次都安全（升級後重複執行）');
  gas.sandbox.initializeSheets();
  ok('第三次快照仍然一樣', eq(snapshot(gas), after1));
}

console.log('\n▌④ status 三態：分清楚「貼咗新 GS」同「行咗初始化」');
{
  const gas = makeGas({ apiKey: 'v82_status_key' });
  gas.sandbox.initializeSheets();
  /* 清除標記 = 扮「啱啱貼咗新版本 Code.gs，但未行 initializeSheets()」 */
  gas.props.delete('INITIALIZED_VERSION');

  const before = gas.post({ action: 'status' });
  ok('status 正常回應', before.ok === true);
  ok('未初始化 → initializedVersion 係空', before.initializedVersion === '', String(before.initializedVersion));
  ok('未初始化 → initializationCurrent = false', before.initializationCurrent === false);
  ok('未初始化 → initializeRequired = true', before.initializeRequired === true);
  ok('status 有回報 backendVersion', typeof before.backendVersion === 'string' && before.backendVersion.length > 0);

  gas.sandbox.initializeSheets();
  const after = gas.post({ action: 'status' });
  ok('行之後 → initializationCurrent = true', after.initializationCurrent === true);
  ok('行之後 → initializeRequired = false', after.initializeRequired === false);
  ok('行之後 → initializedVersion = backendVersion', after.initializedVersion === after.backendVersion);
  ok('status 唔會洩漏 API Key', !JSON.stringify(after).includes('v82_status_key'));
}

console.log('\n▌⑤ 全新空白 Sheet：由零建齊，唔會炸');
{
  const gas = makeGas();
  const r = gas.sandbox.initializeSheets();
  ok('空白 Sheet 初始化 ok', r.ok === true);
  ok('自動生成 API Key（原本冇 key）', typeof r.apiKey === 'string' && r.apiKey.length > 0);
  ok('新建咗所有分頁', r.created.length >= 15, String(r.created.length));
  ok('全部標準分頁都有標題列',
    [...gas.sheets.values()].every(sh => sh.getLastRow() >= 1 && sh._rows[0].length > 0));
  const snap1 = snapshot(gas);
  gas.sandbox.initializeSheets();
  ok('空白 Sheet 都可以重跑（idempotent）', eq(snapshot(gas), snap1));
}

console.log('\n▌⑥ 防呆：第一行唔似標題列 → 唔敢自動加欄');
{
  const gas = makeGas({ apiKey: 'v82_weird_key' });
  const ss = gas.sandbox.SpreadsheetApp.getActiveSpreadsheet();
  /* 用戶喺「團員」分頁第一行寫咗自己嘅嘢（唔係我哋嘅 header） */
  const weird = ss.insertSheet('團員');
  weird.appendRow(['我自己整嘅表', '隨便寫']);
  weird.appendRow(['資料甲', '資料乙']);
  const before = snapshot(gas);

  const r = gas.sandbox.initializeSheets();
  const after = snapshot(gas);
  const skipped = (r.skipped || []).find(x => x.tab === '團員');
  ok('如實回報 skipped（唔靜靜當成功）', !!skipped, JSON.stringify(r.skipped));
  ok('skipped 原因係 first-row-not-header', skipped?.skipped === 'first-row-not-header');
  ok('該分頁完全冇被改動（唔污染用戶資料）', eq(after['團員'], before['團員']));
  ok('其他分頁照樣建齊', !!gas.sheets.get('進度追蹤') && !!gas.sheets.get('資料表'));
}

console.log(`\n──────── 初始化保全測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
