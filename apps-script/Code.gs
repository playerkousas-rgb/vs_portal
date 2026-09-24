/**
 * ============================================================
 *  82venture · 總表同步與多旅團後端 Apps Script（Code.gs）
 *  版本：v2.6.3
 *
 *  ★ v2.6.3 修正（2026-09-21，團長回報「佢話已寫入但張 Sheet 完全冇嘢；
 *    唔好搞咁多掣要人按，存入後端就資料庫同分頁都 SAVE 曬」）：
 *    一次儲存＝兩處都寫。以前「儲存到後端」（saveDb）淨係寫「資料庫」分頁
 *    （分段 JSON，人喺 Sheet 度睇唔明），團員／帳目／物資…嗰啲**睇得明嘅報表分頁**
 *    要另外撳「更新報表分頁」（action:sync）先會填 —— 團長撳完儲存再開 Google Sheet，
 *    見到 16 張分頁全空，自然以為「佢呃我，根本冇寫入」。
 *    而家 saveDb／saveDbCommit 寫完「資料庫」之後，會即用同一份資料刷新晒報表分頁
 *    （重用 syncAll／writeTab，冇第二套攤平邏輯）；body.refreshReports === false 先至略過。
 *    ⚠ 呢個係**後端**行為：貼咗新版 Code.gs，就算前端係舊 cache 都一樣一粒掣搞掂。
 *
 *  ★ v2.6.2 修正（2026-09-20，團長回報「儲存唔到去後端／後端讀取唔到，
 *    只能用 JSON 備份」）：分件儲存嘅暫存行**清唔乾淨** —— 舊 cleanStaging
 *    把「一梳連續行」嘅起點向上移但冇把梳長 +1，所以一梳 N 行最後只刪到 1 行。
 *    分件儲存（資料庫大過 2.8MB）每存一次就留低 N-1 行垃圾（每行 45000 字，
 *    即係成份資料庫嘅複製品）喺「資料庫」分頁。Sheet 越嚟越大 →
 *    每次 getValues() 越來越慢 → 最後 saveDb／loadDb 撞 GAS 執行時間／記憶體
 *    上限 → 讀寫一齊死，而 status／ping 照樣話「正常」（所以「測試連線」會呃人）。
 *    順手把「先刪暫存、再用舊行號刪舊段」呢個行號走位隱患一次過修好
 *    （saveDbCommit 而家一次過由底往上刪晒）；全後端統一用 deleteRowRuns()。
 *    ⚠ 已經中招嘅 Sheet：貼新版 → 執行一次 cleanStaleStaging() 清走積存垃圾行。
 *
 *  ★ v2.6.1 修正（2026-09-20，團長回報 3 項問題）：
 *    ① 「成員進度不知為何重複了」——死因：報表同步（writeTab）用**前端 schema key 次序**
 *       寫「團員」分頁（旅團,id,name,eng,identity,…,ymis,…），
 *       但進度讀取（progressMembers）寫死「第 2 欄=ymis、第 4 欄=姓名」
 *       （嗰個係 initializeSheets 嘅次序：旅團,id,ymis,systemId,姓名,…）。
 *       兩套次序唔同 → 讀錯欄，每人都多咗一行「YMIS=姓名、名=身份」。
 *       修正：progressMembers 改為照標題列搵返 ymis／姓名 喺邊一欄，唔再寫死欄號。
 *    ② 「同步會為這旅團再創建分頁（物資82）」——死因：sheetName() 喺
 *       per-unit-sheet 模式會回「分頁名·旅團編號」（物資·0082），
 *       同 initializeSheets() 建嘅無後綴分頁（物資）係兩張唔同嘅表。
 *       一張總表＝一個旅團，根本唔需要後綴。修正：報表一律寫返無後綴分頁，
 *       並順手清走舊版留低嘅後綴分身，等資料歸返一張表。
 *    ③ 「由後端重新載入仍不成功」——其中一個可修嘅死因係 BACKEND_VERSION
 *       一直係 'v2.5.0'（寫住 v2.6.0 功能、但版本號冇跟上），
 *       令同步診斷／提示誤判後端版本。已升做 'v2.6.1'。
 *       （真正載入仲要：Apps Script 貼新 Code.gs → 部署 → 版本揀「新版本」。）
 *
 *  ★ v2.6.0 新增（2026-09-20，團長回報「無痕同普通視窗對唔到料、又話我冇後端」）：
 *    ① loadDbPart —— **分段讀取**成份資料庫。
 *       死因：Vercel 代理單一回應有 4.5MB 硬上限。資料庫一大過呢個數，
 *       loadDb 一次過回成份 JSON 就會令 Vercel 回 500
 *       FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE（純文字，唔係 JSON），
 *       前端見到「唔係 JSON」就以為「呢個部署冇 /api」，跌落自助路線，
 *       最後對用家講「未設定後端網址」—— 明明後端登記得好哋。
 *       每段淨係回 1,000,000 字純文字，前端逐段拼返；每段都帶 version，
 *       讀緊嗰陣有人儲存咗（version 變咗）前端會由頭再讀，唔會拼出半新半舊。
 *    ② 前端 pullDb 而家會先問 dbInfo 攞體積：經代理而大過 3MB 就直接分段讀，
 *       細嘅單一讀失敗都會自動退去分段 —— 所以**唔會再靜靜地讀唔到**。
 *    ③ 順帶修正（呢個先係資料庫變大嘅真正源頭）：單據相片直上 Drive 嘅
 *       uploadPhotos action 一直漏咗喺 Vercel 代理白名單，代理一律回 400，
 *       前端於是跌返落「本地存做後備」，每張單據相都以 base64 dataURL
 *       寫入 db.claims[].photos[].dataUrl，base64 仲會脹大約 33% ——
 *       所以「明明單據係直上 Drive」都照樣把「資料庫」分頁撐爆。
 *       （修正喺 api/proxy.js 白名單；scripts/lint.mjs 而家會擋住再漏。）
 *
 *  ★ v2.5.0 新增（2026-09-18 深夜，團長回報 6 項問題）：
 *    ① constitution —— 公開團章免登入讀取（APP「發布」＋同步之後，
 *       constitution.html 公開頁即刻見到最新版，唔使再人手上載
 *       data/units/<編號>/constitution.json）。
 *    ② loadPublicNotices 改為由「資料庫」分頁（正本）讀 —— 以前淨係讀
 *       「通告全文」分頁，而嗰分頁要手動撳「總表同步」先會更新，
 *       新發布嘅通告喺公開頁會一直見唔到。
 *    ③ 公開頁送出嘅嘢（通告報名／收支申報／物資借用）而家會**寫入資料庫**，
 *       執委部機開住 APP 就會自動拉到（以前只寫報表分頁，APP 入面永遠見唔到）。
 *       通告報名會按「同一通告＋同名」防重複。
 *    ④ status 回 backendVersion，APP 可以檢查後端係咪舊版。
 *  ★ v2.4.0 新增（2026-09-18 同一晚，長壽命架構）：
 *    分件儲存 saveDbPart / saveDbCommit —— 資料庫大過單一請求上限都照存得：
 *    前端把 db 拆成 N 件（每件 < 3MB）逐件送，暫存喺「資料庫」分頁
 *    （unit='__staging__'），全部到齊一次過原子式拼合寫入。
 *    所以：旅團用十幾二十年，資料庫十幾 MB 都照常用得（配額按件數計，冇天花板）。
 *  ★ v2.3.0 新增（2026-09-18 同一晚，體積治理）：
 *    ① uploadPhotos —— 相片直接上 Drive（回連結），唔使再入 app 資料庫 JSON
 *       （以前 APP 內申報嘅相 dataURL 會將「資料庫」分頁撐到爆 9MB）
 *    ② dbInfo 附帶逐分頁體積（sizes）—— app 可以畫「體積檢查」
 *    ③ saveDb 刪舊段改為一次過 deleteRows（以前逐行刪，大資料會燒晒 GAS 配額）
 *  ★ v2.2.0 新增（2026-09-18 團長事故修正）：
 *    ① saveDb 樂觀鎖（baseVersion）—— 舊瀏覽器／離線耐咗嘅裝置，唔可以再
 *       用過時資料「盲蓋」後端（之前試過一登入就把另一部機同步嘅資料清空）。
 *       版本對唔上 → 回 conflict:true，等 app 自動「拉後端＋合併＋重存」。
 *    ② addRequest / myRequests —— 團員喺團員入口申報進度完成（寫入「待批完成」，
 *       執委喺審批中心批），同埋查返自己嘅申報狀態。
 *
 *  ★ v2.1.0 新增：「資料庫」分頁 —— app 嘅資料真正存喺後端，
 *    換手機／換瀏覽器／清 cache 都唔會冇咗（action: saveDb / loadDb / dbInfo）。
 *    舊版只係把資料攤平寫入報表分頁（讀唔返），所以一定要更新部署先生效。
 *
 *  功能：
 *   0. 整份資料庫讀／寫（「資料庫」分頁，app 真正嘅儲存）
 *   1. 帳目／財務雙年度資料同步
 *   2. 成員名單與 YMIS 跨系統身份管理
 *   3. 物資清單與公開借用申請（borrow.html）
 *   4. 通告發布與即時報名／出席回覆（notice.html）
 *   5. 成員手機影相記帳／收支申報（entry.html）
 *   6. 會議紀錄與操作審計
 *
 *  快速部署步驟：
 *   1. 建立新的 Google Sheet（例如命名為「82旅 執委會總表」）
 *   2. 點擊「擴充功能」→「Apps Script」
 *   3. 清空預設代碼，貼上本程式碼（Code.gs 全部）
 *   4. 點擊「儲存」，函數選單選「initializeSheets」，點「▶ 執行」完成授權與初始化
 *   5. 執行完成後會顯示 API Key，請複製保存
 *   6. 點擊「部署」→「新增部署作業」→ 齒輪「網頁應用程式」
 *      - 執行身分：我
 *      - 具有存取權的使用者：任何人
 *   7. 複製 Web App URL（/exec 結尾）
 *   8. 將 URL 與 API Key 提交給 Git 負責人／管理員登記於 data/units.json 或 Vercel 環境變數
 * ============================================================
 */

/** 呢份 Script 會用到嘅分頁名稱（同步／查詢時用） */
var SHEET_TABS = ['資料庫', '帳目', '物資', '團員', '收支申報', '通告', '通告全文', '報名', '物資借用', '會議', '設定', '同步紀錄', '審計紀錄',
  '進度追蹤', '其他獎章', '待批完成', '活動履歷', '待批履歷', '成員名單'];

/** 每個旅團分開一個 Sheet（工作表）定用同一個 Sheet 加「旅團」欄？ */
var MODE = 'per-unit-sheet';   // 'per-unit-sheet' = 每個旅團獨立工作表；'one-sheet' = 全部用同一張

/** 相片上載（可選）：填咗資料夾 ID 就會將成員影嘅單據存去 Drive
 *  Drive 資料夾 → 共用 → 複製資料夾 ID（/folders/ 之後嗰串） */
var DRIVE_FOLDER_ID = '';

/** 後端版本（status 會回報；APP 用嚟檢查「你張 Sheet 係咪仲行舊 code」） */
var BACKEND_VERSION = 'v2.6.3';

/* ============================================================
   初始化與 API KEY 管理
   ============================================================ */

/** 取得或自動產生 API Key */
function getApiKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = 'v82_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', key);
  }
  return key;
}

/** 顯示目前 API Key（在 Apps Script 編輯器執行此函數） */
function showApiKey() {
  var apiKey = getApiKey();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  if (ui) {
    ui.alert('執委管理系統 API Key', '你嘅旅團 API Key 為：\n\n' + apiKey + '\n\n請複製並交由 Git/Vercel 管理員作登記。', ui.ButtonSet.OK);
  }
  Logger.log('==============================');
  Logger.log('執委管理系統 API Key: ' + apiKey);
  Logger.log('==============================');
  return apiKey;
}

/** SHA-256 hex（開團 KEY 只存雜湊） */
function sha256HexGs(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || ''), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* PBKDF2-HMAC-SHA256：支部帳戶密碼用；hash／salt 只會留喺後端資料。
   GAS 沒有原生 PBKDF2，所以按 RFC 8018 實作，最低 100,000 iterations。 */
function pbkdf2Sha256Hex(password, salt, iterations) {
  var count = Number(iterations || 120000);
  if (!isFinite(count) || count < 100000) count = 120000;
  if (count > 1000000) count = 1000000;
  var pass = Utilities.newBlob(String(password || '')).getBytes();
  var saltBytes = Utilities.newBlob(String(salt || '')).getBytes();
  var block = saltBytes.concat([0, 0, 0, 1]);
  var u = Utilities.computeHmacSha256Signature(block, pass);
  var out = u.slice();
  for (var i = 1; i < count; i++) {
    u = Utilities.computeHmacSha256Signature(u, pass);
    for (var j = 0; j < out.length; j++) out[j] = (out[j] ^ u[j]);
  }
  return out.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/** 支部帳戶密碼政策：最短 4 位；1234 只可作首次／重設後密碼。 */
function passwordPolicy(password) {
  var value = String(password == null ? '' : password);
  if (value.length < 4) return { ok: false, error: '密碼最少要 4 位' };
  return { ok: true, temporary: value === '1234' };
}

function makePasswordRecord(password, forceChange) {
  var policy = passwordPolicy(password);
  if (!policy.ok) return { ok: false, error: policy.error };
  var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var iterations = 120000;
  return { ok: true, pw: { algo: 'pbkdf2-sha256', salt: salt, iterations: iterations,
    hash: pbkdf2Sha256Hex(password, salt, iterations) },
    mustChangePw: forceChange === undefined ? policy.temporary : !!forceChange };
}

function verifyPasswordRecord(record, password) {
  if (!record || record.algo !== 'pbkdf2-sha256' || !record.salt || !record.hash) return false;
  var policy = passwordPolicy(password);
  if (!policy.ok) return false;
  var got = pbkdf2Sha256Hex(password, record.salt, record.iterations);
  if (got.length !== String(record.hash).length) return false;
  var same = 0;
  for (var i = 0; i < got.length; i++) same |= got.charCodeAt(i) ^ String(record.hash).charCodeAt(i);
  return same === 0;
}

/**
 * 開團登入 KEY：喺 Apps Script 編輯器執行呢個函數。
 * 每次產生新 KEY，有效 72 小時；過期再執行一次。唔會寫入工作表、唔會喺 App 顯示超管。
 */
function issueSetupKey() {
  var raw = Utilities.getUuid().replace(/-/g, '').substring(0, 20).toUpperCase();
  var key = 'EC72-' + raw;
  var exp = Date.now() + 72 * 3600 * 1000;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SETUP_KEY_HASH', sha256HexGs(key));
  props.setProperty('SETUP_KEY_EXP', String(exp));
  var until = Utilities.formatDate(new Date(exp), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm');
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* */ }
  if (ui) {
    ui.alert('開團登入 KEY（72 小時）', key + '\n\n有效至：' + until + '\n過期請再執行 issueSetupKey()。\n喺執委系統「領袖登入」貼上呢條 KEY。', ui.ButtonSet.OK);
  }
  Logger.log('SETUP KEY: ' + key + ' until ' + until);
  return key;
}

function verifySetupKey(key) {
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('SETUP_KEY_HASH') || '';
  var exp = Number(props.getProperty('SETUP_KEY_EXP') || 0);
  if (!hash || !exp) return { ok: false, success: false, error: '未產生 KEY。請喺 Apps Script 執行 issueSetupKey()' };
  if (Date.now() > exp) return { ok: false, success: false, error: 'KEY 已過期（72 小時）。請再執行 issueSetupKey()' };
  if (sha256HexGs(String(key || '').trim()) !== hash) return { ok: false, success: false, error: 'KEY 不正確' };
  return { ok: true, success: true, hoursLeft: Math.round((exp - Date.now()) / 3600000) };
}

/** 初始化試算表：建立所有必要分頁、設定棗紅標題列及凍結頂列 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var brandColor = '#7B2233'; // 82venture 棗紅主色
  var headerColor = '#FFFFFF';

  var sheetConfigs = [
    /* 「資料庫」＝ 真正嘅資料主體（app 嘅完整資料庫，分段存 JSON）。
       其他分頁係由佢攤平出嚟畀人睇／畀你自己用公式嘅「報表」。
       唔好人手改呢個分頁 —— 改咗會令 app 讀唔返。 */
    { name: '資料庫', headers: ['旅團', '段號', '內容(JSON)', '更新時間', '版本'] },
    { name: '帳目', headers: ['旅團', 'id', '日期', '類型', '項目', '金額', '分類', '方式', '負責人', '單據編號', '期別', '備註', '同步時間'] },
    { name: '收支申報', headers: ['旅團', '時間', '日期', '類型', '欄目', '項目', '金額', '付款人', '備註', '相片張數', '相片連結', '紀錄編號'] },
    { name: '物資', headers: ['旅團', 'id', '物資編號', '物資名稱', '分類', '總數量', '單位', '存放位置', '狀態', '備註', '同步時間'] },
    { name: '物資借用', headers: ['旅團', '時間', '申請人', '聯絡電話', '物資編號', '物資名稱', '數量', '借用日', '歸還日', '用途', '狀態', '紀錄編號'] },
    { name: '團員', headers: ['旅團', 'id', 'ymis', 'systemId', '姓名', '英文名', '身份', '生日', '職位', '狀態', '電話', '電郵', '加入日期', '備註', '同步時間'] },
    { name: '通告', headers: ['旅團', 'id', '標題(中)', '標題(英)', '類型', '狀態', '活動日期', '截止日期', '活動地點', '集合時間及地點', '解散時間及地點', '內容／程序', '服裝', '費用', '名額', '查詢', '發布日期', '同步時間'] },
    /* 通告全文（JSON）：公開頁直接讀呢個分頁 —— 新通告唔使改 Git 都公開得到 */
    { name: '通告全文', headers: ['旅團', 'id', '狀態', '標題', 'JSON', '更新時間'] },
    { name: '報名', headers: ['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)'] },
    { name: '會議', headers: ['旅團', 'id', '日期', '標題', '地點', '狀態', '備註', '同步時間'] },
    { name: '同步紀錄', headers: ['時間', '旅團', '旅團名稱', '統計內容'] },
    { name: '審計紀錄', headers: ['時間', '旅團', 'action', '結果', '途徑', '操作者'] },
    /* ↓↓↓ 同「進度前端」共用嘅分頁（一個後端、兩個前端）：欄位順序唔可以改 ↓↓↓ */
    { name: '進度追蹤', headers: ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註'] },
    { name: '其他獎章', headers: ['YMIS', '獎章 ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間'] },
    { name: '待批完成', headers: ['request_id', 'ymis', 'name', 'item_id', 'item_name', 'requested_date', 'evidence', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note', 'confirmed_date'] },
    { name: '活動履歷', headers: ['record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'recorder', 'recorded_at', 'updated_at'] },
    { name: '待批履歷', headers: ['request_id', 'kind', 'target_record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note'] },
    { name: '成員名單', headers: ['YMIS', '姓名', '加入日期', '支部', '聯絡'] }
  ];

  sheetConfigs.forEach(function(cfg) {
    var sh = ss.getSheetByName(cfg.name);
    if (!sh) sh = ss.insertSheet(cfg.name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(cfg.headers);
      sh.getRange(1, 1, 1, cfg.headers.length)
        .setFontWeight('bold')
        .setBackground(brandColor)
        .setFontColor(headerColor);
      sh.setFrozenRows(1);
    }
  });

  // 確保取得 API Key
  var apiKey = getApiKey();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  if (ui) {
    ui.alert(
      '初始化完成！',
      '執委管理系統 所有分頁已建立成功（包括進度追蹤／其他獎章／活動履歷 —— 同進度前端共用同一個後端）！\n\n' +
      '你嘅 API Key 為：\n' + apiKey + '\n\n' +
      '下一步：\n' +
      '1. 點擊「部署」→「新增部署作業」\n' +
      '2. 選擇「網頁應用程式」（執行身分：我；存取權：任何人）\n' +
      '3. 複製 /exec 網址並連同 API Key 交予 Git 管理員登記。',
      ui.ButtonSet.OK
    );
  }
  Logger.log('82venture initialized successfully. API Key: ' + apiKey);
  return { ok: true, apiKey: apiKey };
}

/* ============================================================
   HTTP 請求處理
   ============================================================ */

/* 呢個後端識做嘅 action（用嚟回提示，等用家睇到「未知 action」嗰陣知道有乜）。
   ★ 呢個陣列一定要同下面 doPost 入面真正處理緊嘅 action 一模一樣 ——
     scripts/lint.mjs 會逐個比對，漏咗／多咗都會紅燈。
     （2026-09-20 之前呢句係手寫死嘅字串，一直漏咗 constitution，
       加咗 loadDbPart 之後更加唔可以再靠人手記得改。） */
var SUPPORTED_ACTIONS = ['ping', 'test', 'status', 'sync', 'claim', 'noticeSignup', 'loan',
  'authLogin', 'authChangePassword', 'authResetPassword', 'authDeleteAccount', 'authRestoreAccount', 'authForgotPassword', 'authResetByToken', 'saveDb', 'loadDb', 'loadDbPart', 'dbInfo', 'saveDbPart', 'saveDbCommit', 'verifySetupKey',
  'uploadPhotos', 'constitution', 'notices',
  'save', 'saveOtherBadge', 'reviewRequest', 'reviewLogRequest', 'addRequest', 'myRequests'];

/**
 * BUILD §1／§2：敏感 action 必須由 server-side API_KEY 明確授權。
 * 未初始化 API_KEY 時 fail closed；公開讀取／匿名申請另行處理。
 */
function requireAuth(expectedKey, suppliedKey) {
  if (!expectedKey) return { ok: false, success: false, error: '未授權：後端尚未設定 API Key', code: 'AUTH_NOT_CONFIGURED' };
  if (!suppliedKey || suppliedKey !== expectedKey) {
    return { ok: false, success: false, error: '未授權：API Key 唔正確', code: 'AUTH_REQUIRED' };
  }
  return { ok: true };
}

/**
 * Server-side access audit：只記 metadata，絕不記 API Key、密碼或整份 payload。
 * Sheet 未初始化時靜默略過，唔可以因為審計本身令登入／同步失敗。
 */
function auditAccess(body, result) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('審計紀錄');
    if (!sh) return;
    var row = [new Date(), textOf(body && (body.unit || body.troopId)),
      textOf(body && body.action).substring(0, 40), textOf(result).substring(0, 40),
      textOf(body && (body.via || 'api')).substring(0, 30),
      textOf(body && (body.actor || body.username || body.ymis)).substring(0, 120)];
    sh.appendRow(row);
    var last = sh.getLastRow();
    if (last > 5001) sh.deleteRows(2, last - 5001);
  } catch (ignore) { /* audit fail 不可阻斷主流程 */ }
}

/** 收到 POST 時處理 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    auditAccess(body, 'received');
    var expectedKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    // 兩個前端都會用同一條 key（大寫 apiKey / 細寫 apikey 都收）
    var key = body.apiKey || body.apikey || '';
    body.apiKey = key;

    // 若伺服器端有設定 API_KEY，且請求有傳入 key，進行核對
    if (expectedKey && key && key !== expectedKey) {
      return json({ ok: false, success: false, error: 'API key 唔正確' });
    }

    /* ---- 支部帳戶登入：密碼核對留喺 GAS，前端只收安全身份資料 ---- */
    if (body.action === 'authLogin') {
      var loginAuth = requireAuth(expectedKey, key);
      if (!loginAuth.ok) return json(loginAuth);
      var loginDb = loadDb(textOf(body.unit));
      var loginName = textOf(body.username || body.email || body.ymis).toLowerCase();
      var loginPw = textOf(body.password);
      var loginRec = null;
      var loginKind = '';
      (loginDb.db && loginDb.db.accounts || []).some(function (a) {
        if (a && a.active !== false && (textOf(a.username).toLowerCase() === loginName || textOf(a.email).toLowerCase() === loginName)) {
          loginRec = a; loginKind = 'account'; return true;
        }
        return false;
      });
      if (!loginRec) (loginDb.db && loginDb.db.members || []).some(function (m) {
        if (m && m.status !== 'alumni' && !m.accountDeletedAt && (textOf(m.ymis).toLowerCase() === loginName || textOf(m.email).toLowerCase() === loginName)) {
          loginRec = m; loginKind = 'member'; return true;
        }
        return false;
      });
      var loginPassword = loginRec && (loginRec.pw || loginRec.hubPw);
      var loginOk = false;
      if (loginRec && loginPassword && loginPassword.algo === 'pbkdf2-sha256') {
        loginOk = verifyPasswordRecord(loginPassword, loginPw);
      } else if (loginRec && loginPassword && loginPassword.algo === 'sha256') {
        loginOk = sha256HexGs(loginPassword.salt + '::' + loginPw) === textOf(loginPassword.hash);
      } else if (loginRec && !loginPassword && loginPw === '1234') {
        loginOk = true;
      }
      if (!loginOk) return json({ ok: false, success: false, error: '帳號或密碼不正確' });
      var loginRole = loginRec.role || loginRec.identity || 'member';
      return json({ ok: true, success: true, account: {
        id: textOf(loginRec.id), username: textOf(loginRec.username || loginRec.email || loginRec.ymis),
        email: textOf(loginRec.email), name: textOf(loginRec.name), role: loginRole, kind: loginKind
      }, mustChangePw: !!(loginRec.mustChangePw || loginRec.hubMustChangePw || !loginPassword || loginPw === '1234') });
    }

    /* ---- 支部帳戶自己改密碼：舊密碼正確先可寫入新 PBKDF2 record ---- */
    if (body.action === 'authChangePassword') {
      var changeAuth = requireAuth(expectedKey, key);
      if (!changeAuth.ok) return json(changeAuth);
      var changed = withLock(function () {
        var current = loadDb(textOf(body.unit));
        var loginName2 = textOf(body.username || body.email || body.ymis).toLowerCase();
        var rec2 = null;
        (current.db && current.db.accounts || []).some(function (a) {
          if (a && a.active !== false && (textOf(a.username).toLowerCase() === loginName2 || textOf(a.email).toLowerCase() === loginName2)) { rec2 = a; return true; }
          return false;
        });
        if (!rec2) (current.db && current.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && (textOf(m.ymis).toLowerCase() === loginName2 || textOf(m.email).toLowerCase() === loginName2)) { rec2 = m; return true; }
          return false;
        });
        var oldRecord = rec2 && (rec2.pw || rec2.hubPw);
        var oldOk = false;
        if (rec2 && oldRecord && oldRecord.algo === 'pbkdf2-sha256') oldOk = verifyPasswordRecord(oldRecord, textOf(body.oldPassword));
        else if (rec2 && oldRecord && oldRecord.algo === 'sha256') oldOk = sha256HexGs(oldRecord.salt + '::' + textOf(body.oldPassword)) === textOf(oldRecord.hash);
        else if (rec2 && !oldRecord && textOf(body.oldPassword) === '1234') oldOk = true;
        if (!oldOk) return { success: false, error: '舊密碼不正確' };
        var next = makePasswordRecord(textOf(body.newPassword), false);
        if (!next.ok) return { success: false, error: next.error };
        if (rec2.hubPw !== undefined || rec2.ymis !== undefined) {
          rec2.hubPw = next.pw; rec2.hubMustChangePw = false; delete rec2.hubPassword;
        } else {
          rec2.pw = next.pw; rec2.mustChangePw = false; rec2.defaultPw = false; delete rec2.password;
        }
        var saved2 = saveDb({ unit: textOf(body.unit), db: current.db, baseVersion: current.version, refreshReports: false });
        return saved2.success === true ? { success: true, version: saved2.version || '' } : saved2;
      });
      return json({ ok: changed.success === true, success: changed.success === true, version: changed.version || '', error: changed.error || '' });
    }

    /* ---- 領袖替成員重設密碼：由 server-side 重新核對領袖身份 ---- */
    if (body.action === 'authResetPassword') {
      var resetAuth = requireAuth(expectedKey, key);
      if (!resetAuth.ok) return json(resetAuth);
      var reset = withLock(function () {
        var resetDb = loadDb(textOf(body.unit));
        var actorName = textOf(body.actorUsername || body.actorEmail).toLowerCase();
        var targetName = textOf(body.targetUsername || body.targetEmail || body.targetYmis).toLowerCase();
        var actor = null, target = null;
        (resetDb.db && resetDb.db.accounts || []).some(function (a) {
          if (a && a.active !== false && (textOf(a.username).toLowerCase() === actorName || textOf(a.email).toLowerCase() === actorName)) { actor = a; return true; }
          return false;
        });
        if (!actor) (resetDb.db && resetDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && (textOf(m.email).toLowerCase() === actorName || textOf(m.ymis).toLowerCase() === actorName)) { actor = m; return true; }
          return false;
        });
        var actorPw = actor && (actor.pw || actor.hubPw);
        var actorOk = false;
        if (actor && actorPw && actorPw.algo === 'pbkdf2-sha256') actorOk = verifyPasswordRecord(actorPw, textOf(body.actorPassword));
        else if (actor && actorPw && actorPw.algo === 'sha256') actorOk = sha256HexGs(actorPw.salt + '::' + textOf(body.actorPassword)) === textOf(actorPw.hash);
        else if (actor && !actorPw && textOf(body.actorPassword) === '1234') actorOk = true;
        if (!actorOk) return { success: false, error: '管理員帳戶或密碼不正確' };
        var actorRole = textOf(actor.role || actor.identity).toLowerCase();
        if (actorRole !== 'leader' && actorRole !== 'admin' && actorRole !== 'super') return { success: false, error: '你沒有權限重設其他帳戶密碼' };
        (resetDb.db && resetDb.db.accounts || []).some(function (a) {
          if (a && a.active !== false && (textOf(a.username).toLowerCase() === targetName || textOf(a.email).toLowerCase() === targetName)) { target = a; return true; }
          return false;
        });
        if (!target) (resetDb.db && resetDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && (textOf(m.ymis).toLowerCase() === targetName || textOf(m.email).toLowerCase() === targetName)) { target = m; return true; }
          return false;
        });
        if (!target) return { success: false, error: '搵唔到要重設嘅帳戶' };
        var targetRole = textOf(target.role || target.identity).toLowerCase();
        if (targetRole === 'leader' || targetRole === 'admin') return { success: false, error: '不能由支部領袖重設另一個領袖帳戶' };
        var nextReset = makePasswordRecord(textOf(body.newPassword), true);
        if (!nextReset.ok) return { success: false, error: nextReset.error };
        if (target.hubPw !== undefined || target.ymis !== undefined) {
          target.hubPw = nextReset.pw; target.hubMustChangePw = true; delete target.hubPassword;
        } else {
          target.pw = nextReset.pw; target.mustChangePw = true; target.defaultPw = textOf(body.newPassword) === '1234'; delete target.password;
        }
        var savedReset = saveDb({ unit: textOf(body.unit), db: resetDb.db, baseVersion: resetDb.version, refreshReports: false });
        return savedReset.success === true ? { success: true, version: savedReset.version || '' } : savedReset;
      });
      return json({ ok: reset.success === true, success: reset.success === true, version: reset.version || '', error: reset.error || '' });
    }

    /* ---- 管理員／團長刪除帳戶：只刪 accounts row，不刪成員資料 ---- */
    if (body.action === 'authDeleteAccount') {
      var deleteAuth = requireAuth(expectedKey, key);
      if (!deleteAuth.ok) return json(deleteAuth);
      var deleted = withLock(function () {
        var deleteDb = loadDb(textOf(body.unit));
        var actorName3 = textOf(body.actorUsername || body.actorEmail).toLowerCase();
        var targetName3 = textOf(body.targetUsername || body.targetEmail).toLowerCase();
        var actor3 = null, target3 = null, targetIndex = -1;
        (deleteDb.db && deleteDb.db.accounts || []).some(function (a) {
          if (a && a.active !== false && (textOf(a.username).toLowerCase() === actorName3 || textOf(a.email).toLowerCase() === actorName3)) { actor3 = a; return true; }
          return false;
        });
        if (!actor3) return { success: false, error: '管理員帳戶不存在' };
        var actorPw3 = actor3.pw || actor3.hubPw;
        var actorOk3 = actorPw3 && actorPw3.algo === 'pbkdf2-sha256'
          ? verifyPasswordRecord(actorPw3, textOf(body.actorPassword))
          : actorPw3 && actorPw3.algo === 'sha256'
            ? sha256HexGs(actorPw3.salt + '::' + textOf(body.actorPassword)) === textOf(actorPw3.hash)
            : textOf(body.actorPassword) === '1234';
        if (!actorOk3) return { success: false, error: '管理員帳戶或密碼不正確' };
        var actorRole3 = textOf(actor3.role || actor3.identity).toLowerCase();
        if (actorRole3 !== 'leader' && actorRole3 !== 'admin' && actorRole3 !== 'super') return { success: false, error: '你沒有權限刪除帳戶' };
        (deleteDb.db && deleteDb.db.accounts || []).some(function (a, i) {
          if (a && (textOf(a.username).toLowerCase() === targetName3 || textOf(a.email).toLowerCase() === targetName3)) { target3 = a; targetIndex = i; return true; }
          return false;
        });
        if (!target3) return { success: false, error: '搵唔到要刪除嘅帳戶' };
        if (textOf(target3.id) === textOf(actor3.id)) return { success: false, error: '不能刪除自己目前登入嘅帳戶' };
        var targetRole3 = textOf(target3.role || target3.identity).toLowerCase();
        if (targetRole3 === 'leader' || targetRole3 === 'admin') {
          var managerCount3 = (deleteDb.db.accounts || []).filter(function (a) {
            var r = textOf(a && (a.role || a.identity)).toLowerCase();
            return a && a.active !== false && (r === 'leader' || r === 'admin');
          }).length;
          if (managerCount3 <= 1) return { success: false, error: '不能刪除最後一個管理員／團長帳戶，請先開通另一個管理員' };
        }
        var linkedMember = textOf(target3.memberId);
        deleteDb.db.accounts.splice(targetIndex, 1);
        deleteDb.db.deletedAccounts = deleteDb.db.deletedAccounts || [];
        deleteDb.db.deletedAccounts.push({ id: textOf(target3.id), username: textOf(target3.username), email: textOf(target3.email),
          name: textOf(target3.name), role: textOf(target3.role), memberId: linkedMember, deletedAt: new Date().toISOString() });
        /* 成員 row 保留；只標記其管理登入已撤銷，避免資料與歷史被刪掉。 */
        (deleteDb.db.members || []).forEach(function (m) {
          if (linkedMember && textOf(m.id) === linkedMember) m.accountDeletedAt = new Date().toISOString();
        });
        var savedDelete = saveDb({ unit: textOf(body.unit), db: deleteDb.db, baseVersion: deleteDb.version, refreshReports: false });
        return savedDelete.success === true ? { success: true, version: savedDelete.version || '' } : savedDelete;
      });
      return json({ ok: deleted.success === true, success: deleted.success === true, version: deleted.version || '', error: deleted.error || '' });
    }

    /* ---- 復原已刪除登入：保留成員資料，重新建立帳戶 row ---- */
    if (body.action === 'authRestoreAccount') {
      var restoreAuth = requireAuth(expectedKey, key);
      if (!restoreAuth.ok) return json(restoreAuth);
      var restored = withLock(function () {
        var restoreDb = loadDb(textOf(body.unit));
        var actorName4 = textOf(body.actorUsername || body.actorEmail).toLowerCase();
        var actor4 = null, member4 = null;
        (restoreDb.db && restoreDb.db.accounts || []).some(function (a) {
          if (a && a.active !== false && (textOf(a.username).toLowerCase() === actorName4 || textOf(a.email).toLowerCase() === actorName4)) { actor4 = a; return true; }
          return false;
        });
        if (!actor4) return { success: false, error: '管理員帳戶不存在' };
        var actorPw4 = actor4.pw || actor4.hubPw;
        var actorOk4 = actorPw4 && actorPw4.algo === 'pbkdf2-sha256'
          ? verifyPasswordRecord(actorPw4, textOf(body.actorPassword))
          : actorPw4 && actorPw4.algo === 'sha256'
            ? sha256HexGs(actorPw4.salt + '::' + textOf(body.actorPassword)) === textOf(actorPw4.hash)
            : textOf(body.actorPassword) === '1234';
        if (!actorOk4) return { success: false, error: '管理員帳戶或密碼不正確' };
        var actorRole4 = textOf(actor4.role || actor4.identity).toLowerCase();
        if (actorRole4 !== 'leader' && actorRole4 !== 'admin' && actorRole4 !== 'super') return { success: false, error: '你沒有權限復原帳戶' };
        var restoreTarget = textOf(body.targetEmail || body.targetYmis).toLowerCase();
        var tombstone = null;
        (restoreDb.db && restoreDb.db.deletedAccounts || []).some(function (d) {
          if (d && (textOf(d.email).toLowerCase() === restoreTarget || textOf(d.username).toLowerCase() === restoreTarget)) { tombstone = d; return true; }
          return false;
        });
        (restoreDb.db && restoreDb.db.members || []).some(function (m) {
          if (m && m.accountDeletedAt && (textOf(m.email).toLowerCase() === restoreTarget || textOf(m.ymis).toLowerCase() === restoreTarget)) { member4 = m; return true; }
          return false;
        });
        if (!member4 && !tombstone) return { success: false, error: '搵唔到可復原嘅已刪除帳戶' };
        var restorePw = makePasswordRecord(textOf(body.newPassword || '1234'), true);
        if (!restorePw.ok) return { success: false, error: restorePw.error };
        var role4 = textOf((member4 && member4.identity) || (tombstone && tombstone.role) || 'member');
        restoreDb.db.accounts = restoreDb.db.accounts || [];
        restoreDb.db.accounts.push({ id: 'acc_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
          role: role4, username: textOf((member4 && (member4.email || member4.ymis)) || (tombstone && tombstone.username)),
          email: textOf((member4 && member4.email) || (tombstone && tombstone.email)),
          name: textOf((member4 && member4.name) || (tombstone && tombstone.name)),
          memberId: textOf((member4 && member4.id) || (tombstone && tombstone.memberId)), active: true,
          pw: restorePw.pw, mustChangePw: true, defaultPw: textOf(body.newPassword || '1234') === '1234' });
        if (member4) delete member4.accountDeletedAt;
        if (tombstone) restoreDb.db.deletedAccounts = restoreDb.db.deletedAccounts.filter(function (d) { return d !== tombstone; });
        var savedRestore = saveDb({ unit: textOf(body.unit), db: restoreDb.db, baseVersion: restoreDb.version, refreshReports: false });
        return savedRestore.success === true ? { success: true, version: savedRestore.version || '' } : savedRestore;
      });
      return json({ ok: restored.success === true, success: restored.success === true, version: restored.version || '', error: restored.error || '' });
    }

    /* ---- EMAIL 忘記密碼：一次性 token，回應永遠不透露帳戶是否存在 ---- */
    if (body.action === 'authForgotPassword') {
      var forgotAuth = requireAuth(expectedKey, key);
      if (!forgotAuth.ok) return json(forgotAuth);
      var forgotDb = loadDb(textOf(body.unit));
      var forgotEmail = textOf(body.email).trim().toLowerCase();
      var forgotTarget = null;
      (forgotDb.db && forgotDb.db.accounts || []).some(function (a) {
        if (a && a.active !== false && textOf(a.email).toLowerCase() === forgotEmail) { forgotTarget = { id: textOf(a.id), kind: 'account', email: textOf(a.email) }; return true; }
        return false;
      });
      if (!forgotTarget) (forgotDb.db && forgotDb.db.members || []).some(function (m) {
        if (m && m.status !== 'alumni' && textOf(m.email).toLowerCase() === forgotEmail) { forgotTarget = { id: textOf(m.id), kind: 'member', email: textOf(m.email) }; return true; }
        return false;
      });
      if (forgotTarget) {
        var rawToken = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
        var tokenHash = sha256HexGs(rawToken);
        var tokenKey = 'PWD_RESET_' + textOf(body.unit) + '_' + tokenHash;
        PropertiesService.getScriptProperties().setProperty(tokenKey, JSON.stringify({ id: forgotTarget.id, kind: forgotTarget.kind, exp: Date.now() + 30 * 60 * 1000 }));
        var origin = textOf(body.resetUrl || body.origin);
        if (origin.slice(-1) === '/') origin = origin.slice(0, -1);
        var link = (origin || 'https://scout-system.example/reset-password') + '?unit=' + encodeURIComponent(textOf(body.unit)) + '&token=' + encodeURIComponent(rawToken);
        var lineBreak = String.fromCharCode(10);
        try { MailApp.sendEmail(forgotTarget.email, 'Scout System 重設密碼', '請在 30 分鐘內開啟以下連結重設密碼：' + lineBreak + lineBreak + link); } catch (mailErr) { /* 不向外洩漏寄信錯誤 */ }
      }
      return json({ ok: true, success: true, message: '如果電郵已登記，重設連結會寄出。' });
    }

    if (body.action === 'authResetByToken') {
      var tokenAuth = requireAuth(expectedKey, key);
      if (!tokenAuth.ok) return json(tokenAuth);
      var token = textOf(body.token);
      var tokenHash2 = sha256HexGs(token);
      var tokenKey2 = 'PWD_RESET_' + textOf(body.unit) + '_' + tokenHash2;
      var tokenRaw = PropertiesService.getScriptProperties().getProperty(tokenKey2);
      var tokenInfo = null;
      try { tokenInfo = tokenRaw ? JSON.parse(tokenRaw) : null; } catch (tokenErr) { tokenInfo = null; }
      if (!tokenInfo || Number(tokenInfo.exp || 0) < Date.now()) {
        if (tokenRaw) PropertiesService.getScriptProperties().deleteProperty(tokenKey2);
        return json({ ok: false, success: false, error: '重設連結無效或已過期' });
      }
      var tokenDb = loadDb(textOf(body.unit));
      var tokenTarget = null;
      var tokenList = tokenInfo.kind === 'member' ? (tokenDb.db && tokenDb.db.members || []) : (tokenDb.db && tokenDb.db.accounts || []);
      tokenList.some(function (r) { if (r && textOf(r.id) === textOf(tokenInfo.id)) { tokenTarget = r; return true; } return false; });
      var tokenPw = makePasswordRecord(textOf(body.newPassword), true);
      if (!tokenTarget) return json({ ok: false, success: false, error: '帳戶不存在' });
      if (!tokenPw.ok) return json({ ok: false, success: false, error: tokenPw.error });
      if (tokenInfo.kind === 'member') { tokenTarget.hubPw = tokenPw.pw; tokenTarget.hubMustChangePw = true; delete tokenTarget.hubPassword; }
      else { tokenTarget.pw = tokenPw.pw; tokenTarget.mustChangePw = true; tokenTarget.defaultPw = textOf(body.newPassword) === '1234'; delete tokenTarget.password; }
      var tokenSaved = saveDb({ unit: textOf(body.unit), db: tokenDb.db, baseVersion: tokenDb.version, refreshReports: false });
      if (tokenSaved.success !== true) return json({ ok: false, success: false, error: tokenSaved.error || '重設失敗，請重新申請' });
      PropertiesService.getScriptProperties().deleteProperty(tokenKey2);
      return json({ ok: true, success: true, mustChangePw: true });
    }

    /* ---- 整份資料庫讀／寫（app 嘅真正儲存；一定要 API Key）---- */
    if (body.action === 'saveDb' || body.action === 'loadDb' || body.action === 'loadDbPart'
      || body.action === 'dbInfo' || body.action === 'saveDbPart' || body.action === 'saveDbCommit') {
      var dbAuth = requireAuth(expectedKey, key);
      if (!dbAuth.ok) return json(dbAuth);
      if (body.action === 'saveDb') {
        var sv = withLock(function () { return saveDb(body); });
        return json({ ok: sv.success === true, success: sv.success === true, conflict: sv.conflict === true,
          chunks: sv.chunks || 0, bytes: sv.bytes || 0, at: sv.at || '', version: sv.version || '', error: sv.error || '',
          /* v2.6.3：報表分頁係咪喺同一次請求入面一齊刷新咗（前端就唔使再發第二次）。
             呢個欄位一定要**明確列出**—— 呢度係逐個欄位砌回應，漏咗就會靜靜地冇咗。 */
          reports: sv.reports || null });
      }
      if (body.action === 'saveDbPart') {
        var sp = withLock(function () { return saveDbPart(body); });
        return json({ ok: sp.success === true, success: sp.success === true, conflict: sp.conflict === true,
          partIdx: sp.partIdx || 0, chunks: sp.chunks || 0, version: sp.version || '', error: sp.error || '' });
      }
      if (body.action === 'saveDbCommit') {
        var sc = withLock(function () { return saveDbCommit(body); });
        return json({ ok: sc.success === true, success: sc.success === true, conflict: sc.conflict === true,
          chunks: sc.chunks || 0, bytes: sc.bytes || 0, at: sc.at || '', version: sc.version || '', error: sc.error || '',
          reports: sc.reports || null });
      }
      if (body.action === 'dbInfo') {
        var nfo = dbInfo(textOf(body.unit));
        return json({ ok: nfo.success === true, success: nfo.success === true, found: !!nfo.found,
          at: nfo.at || '', version: nfo.version || '', bytes: nfo.bytes || 0,
          sizes: nfo.sizes || null, photoBytes: nfo.photoBytes || 0, counts: nfo.counts || null,
          stagingRows: nfo.stagingRows || 0, stagingBytes: nfo.stagingBytes || 0, error: nfo.error || '' });
      }
      /* v2.6.0：分段讀取 —— 每次淨係回一段純文字，唔會撞代理 4.5MB 回應上限 */
      if (body.action === 'loadDbPart') {
        var lp = loadDbPart(textOf(body.unit), body.partIdx);
        return json({ ok: lp.success === true, success: lp.success === true, found: !!lp.found,
          part: lp.part || '', partIdx: lp.partIdx || 0, parts: lp.parts || 0, bytes: lp.bytes || 0,
          at: lp.at || '', version: lp.version || '', error: lp.error || '' });
      }
      var ld = loadDb(textOf(body.unit));
      return json({ ok: ld.success === true, success: ld.success === true, found: !!ld.found,
        db: ld.db || null, at: ld.at || '', version: ld.version || '', bytes: ld.bytes || 0,
        stagingRows: ld.stagingRows || 0, stagingBytes: ld.stagingBytes || 0, error: ld.error || '' });
    }

    /* ---- 進度追蹤（同進度前端共用同一個後端；API Key＝執委身份）---- */
    if (body.action === 'save' || body.action === 'saveOtherBadge') {
      var progressAuth = requireAuth(expectedKey, key);
      if (!progressAuth.ok) return json(progressAuth);
      if (body.action === 'save') {
        var pr = withLock(function () { return saveProgress(body.changes || [], body.confirmer || ''); });
        return json({ ok: pr.success === true, success: pr.success === true, processed: pr.processed || 0, error: pr.error || '' });
      }
      var pbo = withLock(function () { return saveOtherBadges(body.records || []); });
      return json({ ok: pbo.success === true, success: pbo.success === true, processed: pbo.processed || 0, error: pbo.error || '' });
    }

    /* ---- 審批中心（執委系統內直接批；同一個 API Key＝執委身份）---- */
    if (body.action === 'reviewRequest' || body.action === 'reviewLogRequest') {
      var reviewAuth = requireAuth(expectedKey, key);
      if (!reviewAuth.ok) return json(reviewAuth);
      if (body.action === 'reviewRequest') {
        var rq = withLock(function () {
          return reviewProgressRequest(body.request_id, body.decision, body.review_note,
            body.reviewer || '執委管理系統', body.confirmed_date);
        });
        return json({ ok: rq.success === true, success: rq.success === true,
          message: rq.message || '', error: rq.error || '' });
      }
      var lq = withLock(function () {
        return reviewLogRequest(body.request_id, body.decision, body.review_note, body.reviewer || '執委管理系統');
      });
      return json({ ok: lq.success === true, success: lq.success === true,
        message: lq.message || '', record_id: lq.record_id || '', error: lq.error || '' });
    }

    /* 公開通告（免 API Key）：只回已發布嘅通告全文 */
    if (body.action === 'notices') {
      return json({ success: true, ok: true, unit: textOf(body.unit), notices: loadPublicNotices(textOf(body.unit)) });
    }

    /* 公開團章（v2.5.0，免 API Key）：APP「發布」＋同步咗之後，
       constitution.html 公開頁即刻讀到最新版 —— 只回 constitution 同旅團名，
       唔會漏名冊／帳目等其他資料。 */
    if (body.action === 'constitution') {
      var cons = publicConstitution(textOf(body.unit));
      return json({ ok: cons.success === true, success: cons.success === true, found: !!cons.found,
        constitution: cons.constitution || null, unitName: cons.unitName || '',
        version: cons.version || '', at: cons.at || '', error: cons.error || '' });
    }

    if (body.action === 'verifySetupKey') {
      if (expectedKey && key !== expectedKey) {
        return json({ ok: false, success: false, error: '未授權：API Key 唔正確' });
      }
      return json(verifySetupKey(body.key || body.setupKey || ''));
    }
    if (body.action === 'ping') return json({ ok: true, msg: 'pong', unit: body.unit, at: body.at });
    if (body.action === 'noticeSignup') {
      /* v2.5.0：報名除咗寫「報名」分頁，仲會寫入資料庫（APP 執委端先至睇得到） */
      var sgn = withLock(function () { return appendSignup(body); });
      return json({ ok: sgn.success !== false, success: sgn.success !== false,
        msg: sgn.duplicate ? '已經記錄過呢份報名' : '已記錄報名', duplicate: !!sgn.duplicate });
    }
    if (body.action === 'claim') {
      var saved = withLock(function () { return appendClaim(body); });
      return json({ ok: true, msg: '已記錄，等批核', photos: saved.photos || 0 });
    }
    /* ---- 相片上 Drive（v2.3.0；免 API Key，同 claim 同一信任級別）----
       APP 內申報用：只存檔回連結，唔會寫任何報表行（報表行由 syncAll 負責）。 */
    if (body.action === 'uploadPhotos') {
      var upPhotos = (body.payload && body.payload.photos) || [];
      var links = savePhotos(upPhotos, textOf(body.unit), textOf(body.payload && body.payload.id) || 'x', textOf(body.folderId));
      return json({ ok: true, links: links, saved: links.length, asked: upPhotos.length });
    }
    if (body.action === 'loan') {
      withLock(function () { appendLoan(body); });
      return json({ ok: true, msg: '已記錄借用申請，等批核', photos: 0 });
    }
    if (body.action === 'sync') {
      var syncAuth = requireAuth(expectedKey, key);
      if (!syncAuth.ok) return json(syncAuth);
      var counts = withLock(function () { return syncAll(body); });
      /* 有帶整份資料庫就順便存埋（一次過搞掂「睇得到嘅報表」＋「讀得返嘅資料庫」） */
      var dbSaved = null;
      if (body.db && typeof body.db === 'object') {
        var syncDbAuth = requireAuth(expectedKey, key);
        if (!syncDbAuth.ok) return json(syncDbAuth);
        dbSaved = withLock(function () { return saveDb(body); });
      }
      return json({ ok: true, msg: '已寫入總表', counts: counts, unit: body.unit, at: body.at,
        db: dbSaved ? { saved: dbSaved.success === true, conflict: dbSaved.conflict === true, chunks: dbSaved.chunks || 0, bytes: dbSaved.bytes || 0, error: dbSaved.error || '' } : null });
    }
    /* ---- 團員申報進度完成（免 API Key：寫入「待批完成」等執委批核）----
       團員喺團員入口揀項目申報 → 執委喺「進度 → 審批中心」批准 → 寫入進度。 */
    if (body.action === 'addRequest') {
      var ar = withLock(function () { return addProgressRequest(body); });
      return json({ ok: ar.success === true, success: ar.success === true, request_id: ar.request_id || '', error: ar.error || '' });
    }
    if (body.action === 'myRequests') {
      /* 團員查返自己嘅申報狀態（只會回自己 YMIS 嘅紀錄） */
      return json(loadMyRequests(textOf(body.ymis)));
    }
    if (body.action === 'status' || body.action === 'test') {
      return json({ ok: true, msg: '82venture 後端正常', spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(), tabs: SHEET_TABS, backendVersion: BACKEND_VERSION, at: new Date() });
    }
    // 兼容：冇 action 但係 82venture 嘅資料（當 sync）
    if (!body.action && body.tables) {
      var c2 = syncAll(body);
      return json({ ok: true, msg: '已寫入總表（無 action，當 sync）', counts: c2, unit: body.unit });
    }
    return json({ ok: false, error: '未知 action：' + body.action, got: Object.keys(body || {}), hint: '支援 action: ' + SUPPORTED_ACTIONS.join(' / ') });
  } catch (err) {
    if (err && err.code === 'LOCK_BUSY') {
      return json({ ok: false, success: false, error: '系統繁忙，請稍後重試', code: 'LOCK_BUSY' });
    }
    return json({ ok: false, error: String(err) });
  }
}

/** 收到 GET 時處理：?action=load 讀進度（兩個前端用同一份資料） */
function doGet(e) {
  var action = '';
  var supplied = '';
  try {
    action = String((e && e.parameter && e.parameter.action) || '');
    supplied = String((e.parameter && (e.parameter.apikey || e.parameter.apiKey)) || '');
  } catch (err0) { action = ''; }
  if (action === 'notices') return json({ success: true, ok: true, unit: textOf((e.parameter && e.parameter.unit) || ''), notices: loadPublicNotices(textOf((e.parameter && e.parameter.unit) || '')) });
  if (action === 'constitution') {
    var consG = publicConstitution(textOf((e.parameter && e.parameter.unit) || ''));
    return json({ ok: consG.success === true, success: consG.success === true, found: !!consG.found,
      constitution: consG.constitution || null, unitName: consG.unitName || '',
      version: consG.version || '', at: consG.at || '', error: consG.error || '' });
  }
  if (action === 'load') {
    var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (supplied && expected && supplied !== expected) return json({ success: false, ok: false, error: 'Invalid API Key' });
    var data = loadProgressData();
    data.success = true; data.ok = true;
    return json(data);
  }
  if (action === 'loadDb' || action === 'dbInfo') {
    var expectedDb = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (expectedDb && supplied !== expectedDb) return json({ success: false, ok: false, error: '未授權：API Key 唔正確' });
    var unitParam = textOf((e.parameter && e.parameter.unit) || '');
    if (action === 'dbInfo') {
      var gi = dbInfo(unitParam);
      return json({ ok: gi.success === true, success: gi.success === true, found: !!gi.found,
        at: gi.at || '', version: gi.version || '', bytes: gi.bytes || 0,
        sizes: gi.sizes || null, photoBytes: gi.photoBytes || 0, counts: gi.counts || null, error: gi.error || '' });
    }
    var gd = loadDb(unitParam);
    return json({ ok: gd.success === true, success: gd.success === true, found: !!gd.found,
      db: gd.db || null, at: gd.at || '', version: gd.version || '', bytes: gd.bytes || 0, error: gd.error || '' });
  }
  return json({
    ok: true,
    msg: '執委管理系統 後端已啟動',
    spreadsheet: (function () { try { return SpreadsheetApp.getActiveSpreadsheet().getName(); } catch (err) { return '(未綁定試算表)'; } })(),
    tabs: SHEET_TABS,
    api: ['ping', 'status', 'sync', 'saveDb', 'loadDb', 'dbInfo', 'claim', 'noticeSignup', 'loan', 'load', 'save', 'saveOtherBadge'],
    usage: 'APP 內「帳號與系統 → 資料管理 → 總表同步」填呢個 /exec 網址即可'
  });
}

/* ============================================================
   資料庫（整份資料）讀／寫 —— 真正嘅「後端儲存」
   ------------------------------------------------------------
   點解要呢個：其他分頁（帳目／團員…）係「攤平咗畀人睇」嘅報表，
   相片變咗數量、巢狀欄位變咗文字，讀返上去砌唔返原本嘅資料庫。
   所以整份 app 資料庫會原原本本序列化成 JSON，分段寫入「資料庫」分頁
   （每格上限 50000 字元，所以要分段）。
     寫：POST { action:'saveDb', unit, apiKey, db:{…} }
     讀：POST { action:'loadDb', unit, apiKey }   或 GET ?action=loadDb&unit=…&apikey=…
     睇：POST { action:'dbInfo', unit, apiKey }   → 只回 meta（幾時更新、幾大）
   ============================================================ */

var DB_CHUNK = 45000;          // 每格字元數（Sheet 單格上限 50000）
var DB_TAB = '資料庫';

function dbSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DB_TAB);
  if (!sh) {
    sh = ss.insertSheet(DB_TAB);
    sh.appendRow(['旅團', '段號', '內容(JSON)', '更新時間', '版本']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#7B2233').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 寫入整份資料庫（原子：先驗版本，再刪舊段，再寫新段）
 *  v2.2.0 樂觀鎖：body.baseVersion = 呢部機「上一次見過嘅後端版本」。
 *  後端已有版本而 baseVersion 對唔上（包括舊 app 冇送 baseVersion）
 *  → 拒絕寫入回 conflict:true，等 app 拉後端合併完再嚟。
 *  咁樣過時裝置（例如離線咗幾日嘅瀏覽器）就永遠唔會把另一部機
 *  啱啱同步嘅資料一鋪清空。baseVersion 同現版一致、或者後端本身
 *  仲係空（第一次存）→ 照樣接受。 */
function saveDb(body) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var db = body.db;
  if (!db || typeof db !== 'object') return { success: false, error: '冇收到資料庫內容（db）' };

  var text = JSON.stringify(db);
  if (text.length > 9000000) return { success: false, error: '資料太大（超過 9MB），請先喺 app 內清理相片' };

  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();

  /* 先睇而家後端有咩版本（呢個旅團最後一段嘅「版本」欄） */
  var curVersion = '';
  for (var v = rows.length - 1; v >= 1; v--) {
    if (textOf(rows[v][0]) === unit) { curVersion = textOf(rows[v][4]); break; }
  }
  var baseVersion = textOf(body.baseVersion);
  if (curVersion && baseVersion !== curVersion) {
    return { success: false, conflict: true, version: curVersion,
      error: '後端已有較新版本（另一部機剛剛同步過）。唔敢用舊資料蓋上去 —— app 會自動拉後端合併後重存。' };
  }

  /* v2.3.0：舊段成梳一次過刪（deleteRows）—— 以前逐行 deleteRow，
     200 段資料 = 200 次調用（每次成頁 shift），GAS 配額同時間都燒好快。
     v2.6.2：改用全後端唯一嘅 deleteRowRuns（同 cleanStaging 同一套邏輯）。 */
  var oldRows = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== unit) continue;
    oldRows.push(i + 1);
  }
  deleteRowRuns(sh, oldRows);

  var now = new Date();
  /* v2.2.0：版本由**伺服器**派（ISO 時間＋隨機尾數）。
     唔好用 db.meta.updatedAt 做版本 —— 佢只有分鐘精度，兩部機同一分鐘內
     先後存，版本字串會撞到一樣，樂觀鎖就會誤判「無衝突」，過時資料
     又可以盲蓋上去（2026-09-18 事故嘅隱藏版）。 */
  var version = now.toISOString() + '-' + Math.floor(Math.random() * 100000);
  var chunks = [];
  for (var p = 0; p < text.length; p += DB_CHUNK) chunks.push(text.substring(p, p + DB_CHUNK));
  if (!chunks.length) chunks = ['{}'];

  var out = chunks.map(function (c, idx) { return [unit, idx + 1, c, now, version]; });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);

  /* ★ v2.6.3：一次儲存，兩處都寫 —— 順手刷新晒報表分頁（團員／帳目／物資…），
     團長開 Google Sheet 即刻睇到嘢，唔使再撳第二粒掣。 */
  var reports = body.refreshReports === false ? null : refreshReportsFromDb(db, unit);

  return { success: true, chunks: chunks.length, bytes: text.length, at: now, version: version, reports: reports };
}

/** 由「資料庫」分頁把某旅團嘅所有段讀出嚟、拼返成份 JSON 純文字。
 *  v2.6.0 抽出嚟做共用：loadDb（一次過回成份）同 loadDbPart（分段回）
 *  一定要用**同一套**讀法，否則分段讀返嘅同整份讀返嘅會唔同 —— 咁樣
 *  「大資料庫分段讀」就會靜靜地讀到另一份資料，比讀唔到更危險。 */
function dbRawText(unit) {
  unit = textOf(unit);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_TAB);
  if (!sh) return { found: false, text: '', at: '', version: '', stagingRows: 0, stagingBytes: 0 };
  var rows = sh.getDataRange().getValues();
  var parts = [];
  var at = '', version = '';
  /* v2.6.2：順手數一數「暫存垃圾行」—— 舊版 cleanStaging 漏刪留低嘅行
     （每行 45000 字）會令分頁越嚟越大，最後 saveDb／loadDb 撞 GAS
     執行時間／記憶體上限（症狀：儲存同讀取一齊死，但 status 話正常）。
     呢度本來就要讀成份分頁，所以順手数數係零成本；dbInfo 會報上去，
     app 嘅「同步診斷」見到就會叫人更新 Code.gs ＋ 執行 cleanStaleStaging()。 */
  var stagingRows = 0, stagingBytes = 0;
  for (var i = 1; i < rows.length; i++) {
    var u = textOf(rows[i][0]);
    if (u === '__staging__') {           // v2.4.0：分件暫存唔係正式資料
      stagingRows++;
      stagingBytes += String(rows[i][2] == null ? '' : rows[i][2]).length;
      continue;
    }
    if (unit && u && u !== unit) continue;
    if (!unit && !u) continue;
    parts.push({ seq: Number(rows[i][1]) || 0, text: String(rows[i][2] == null ? '' : rows[i][2]) });
    if (rows[i][3]) at = rows[i][3];
    if (rows[i][4]) version = textOf(rows[i][4]);
  }
  if (!parts.length) return { found: false, text: '', at: at, version: version, stagingRows: stagingRows, stagingBytes: stagingBytes };
  parts.sort(function (a, b) { return a.seq - b.seq; });
  return {
    found: true, text: parts.map(function (p) { return p.text; }).join(''), at: at, version: version,
    stagingRows: stagingRows, stagingBytes: stagingBytes
  };
}

/** 讀返整份資料庫（把所有段拼返） */
function loadDb(unit) {
  var raw = dbRawText(unit);
  if (!raw.found) {
    return { success: true, found: false, db: null, at: raw.at, version: raw.version, bytes: 0,
      stagingRows: raw.stagingRows, stagingBytes: raw.stagingBytes, error: '' };
  }
  try {
    return { success: true, found: true, db: JSON.parse(raw.text), at: raw.at, version: raw.version,
      bytes: raw.text.length, stagingRows: raw.stagingRows, stagingBytes: raw.stagingBytes };
  } catch (e) {
    return { success: false, found: true, db: null, error: '資料庫內容壞咗（JSON 解析失敗），請用 app 嘅 JSON 備份還原',
      stagingRows: raw.stagingRows, stagingBytes: raw.stagingBytes };
  }
}

/* v2.6.0 分段讀取：Vercel 代理單一回應有 4.5MB 硬上限，
   loadDb 一次過回成份 JSON，資料庫一大就會 500 FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE
   （純文字，前端當「唔係 JSON」→ 誤判「呢個部署冇 /api」→ 對用家講「未設定後端網址」）。
   每段淨係回 LOAD_PART_CHARS 字純文字（約 1MB，留足水位），前端逐段拼返。
   每段都帶 version —— 前端逐段核對，讀緊嗰陣有人儲存咗就由頭再讀，
   唔會拼出半新半舊嘅 JSON（半新半舊會 JSON.parse 失敗，或者更差：parse 到但資料錯亂）。 */
var LOAD_PART_CHARS = 1000000;

/** 讀成份資料庫嘅其中一段（partIdx 由 0 起） */
function loadDbPart(unit, partIdx) {
  var idx = parseInt(partIdx, 10);
  if (isNaN(idx) || idx < 0) idx = 0;
  var raw = dbRawText(unit);
  if (!raw.found) {
    return { success: true, found: false, part: '', partIdx: idx, parts: 0, bytes: 0, at: raw.at, version: raw.version, error: '' };
  }
  var total = raw.text.length;
  var n = Math.max(1, Math.ceil(total / LOAD_PART_CHARS));
  /* 段號超範圍：通常係讀緊嗰陣另一部機儲存咗、資料庫縮細咗。
     唔好靜靜地回空字串（前端會以為讀完）—— 明確報錯，等前端由頭再讀。 */
  if (idx >= n) {
    return { success: false, found: true, part: '', partIdx: idx, parts: n, bytes: total, at: raw.at, version: raw.version,
      error: '段號超出範圍（讀緊嗰陣資料庫變咗）—— 請由頭再讀' };
  }
  return {
    success: true, found: true,
    part: raw.text.substring(idx * LOAD_PART_CHARS, (idx + 1) * LOAD_PART_CHARS),
    partIdx: idx, parts: n, bytes: total, at: raw.at, version: raw.version, error: ''
  };
}

/* v2.4.0 分件儲存：前端把 db 拆成 N 件逐件送（每件 < 3MB），
   件寫入「資料庫」分頁嘅暫存行（unit='__staging__'，version=saveId，
   seq = partIdx*100000 + chunkIdx），全部到齊後 saveDbCommit 原子式拼合。
   好處：旅團用幾十年、db 幾十 MB 都照存得到（行現有所有路徑，包括 proxy）。 */
function stagingRows(unit, saveId) {
  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== '__staging__') continue;
    var ver = textOf(rows[i][4]);
    if (saveId) { if (ver === saveId) out.push({ row: i + 1, seq: Number(rows[i][1]) || 0, text: String(rows[i][2] == null ? '' : rows[i][2]) }); }
    else if (!unit || ver.indexOf(unit + '-stg-') === 0) out.push({ row: i + 1, at: rows[i][3] });
  }
  return out;
}

function saveDbPart(body) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var data = body.data;
  var idx = Number(body.partIdx);
  var parts = Number(body.parts);
  if (!data || typeof data !== 'object') return { success: false, error: '冇收到分件內容（data）' };
  if (!Number.isFinite(idx) || idx < 0 || !parts || idx >= parts) return { success: false, error: '分件編號唔啱（partIdx/parts）' };
  var saveId = textOf(body.saveId);
  if (saveId.indexOf(unit + '-stg-') !== 0) return { success: false, error: 'saveId 唔啱格式' };

  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();

  /* 版本檢查：同 saveDb 一樣 —— 第一件就擋，唔會寫咗一半先知撞版 */
  var curVersion = '';
  for (var v = rows.length - 1; v >= 1; v--) {
    if (textOf(rows[v][0]) === unit) { curVersion = textOf(rows[v][4]); break; }
  }
  var baseVersion = textOf(body.baseVersion);
  if (curVersion && baseVersion !== curVersion) {
    return { success: false, conflict: true, version: curVersion, error: '後端已有較新版本（另一部機剛剛同步過）' };
  }

  /* 過期暫存清走（90 分鐘前嘅）—— 唔會越積越多
     v2.6.2：改用 deleteRowRuns（同 cleanStaging 同一套邏輯，唔會漏刪） */
  var cutoff = Date.now() - 90 * 60 * 1000;
  var stale = stagingRows('');   // 全部暫存行（連 at）
  var dead = stale.filter(function (r) {
    var at = new Date(r.at || 0).getTime() || 0;
    return at && at < cutoff;
  }).map(function (r) { return r.row; });
  deleteRowRuns(sh, dead);

  var text = JSON.stringify(data);
  var chunks = [];
  for (var p2 = 0; p2 < text.length; p2 += DB_CHUNK) chunks.push(text.substring(p2, p2 + DB_CHUNK));
  if (!chunks.length) chunks = ['{}'];
  var now = new Date();
  var out = [];
  for (var c2 = 0; c2 < chunks.length; c2++) out.push(['__staging__', idx * 100000 + (c2 + 1), chunks[c2], now, saveId]);
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  return { success: true, partIdx: idx, chunks: chunks.length };
}

function saveDbCommit(body) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var saveId = textOf(body.saveId);
  var parts = Number(body.parts);
  if (saveId.indexOf(unit + '-stg-') !== 0) return { success: false, error: 'saveId 唔啱格式' };

  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();

  /* commit 前最後一次版本檢查 */
  var curVersion = '';
  for (var v = rows.length - 1; v >= 1; v--) {
    if (textOf(rows[v][0]) === unit) { curVersion = textOf(rows[v][4]); break; }
  }
  var baseVersion = textOf(body.baseVersion);
  if (curVersion && baseVersion !== curVersion) {
    return { success: false, conflict: true, version: curVersion, error: '後端已有較新版本（另一部機剛剛同步過）' };
  }

  var got = stagingRows(unit, saveId);
  if (!got.length) return { success: false, error: '搵唔到暫存分件（可能已過期，請重新儲存）' };
  var byPart = {};
  got.forEach(function (r) {
    var idx = Math.floor(r.seq / 100000);
    (byPart[idx] = byPart[idx] || []).push(r);
  });
  var missing = [];
  for (var pi = 0; pi < parts; pi++) { if (!byPart[pi]) missing.push(pi); }
  if (missing.length) return { success: false, error: '缺少分件：' + missing.join(', ') + '（請重新儲存）' };

  /* 拼合：同一 key 所有件都係陣列 → 接駁（前端把大陣列拆件）；否則後件覆蓋 */
  var merged = {};
  var order = Object.keys(byPart).map(Number).sort(function (a, b) { return a - b; });
  order.forEach(function (pi2) {
    byPart[pi2].sort(function (a, b) { return a.seq - b.seq; });
    var partDb = JSON.parse(byPart[pi2].map(function (r) { return r.text; }).join(''));
    Object.keys(partDb).forEach(function (k) {
      var incoming = partDb[k];
      if (Array.isArray(incoming) && Array.isArray(merged[k])) merged[k] = merged[k].concat(incoming);
      else merged[k] = incoming;
    });
  });
  var text = JSON.stringify(merged);
  if (text.length > 40000000) { cleanStaging(sh, got); return { success: false, error: '拼合後太大（>40MB）' }; }

  /* 刪暫存＋舊段：**一次過**由底往上刪（v2.6.2）。
     以前係「先 cleanStaging(暫存)，再用上面讀返嘅行號刪舊段」——
     行號係**刪之前**計嘅：暫存行一旦喺舊段之上（上一次分件儲存中途死咗、
     之後又有普通儲存喺下面加咗行），刪完暫存所有行號就會向上移，
     第二輪 deleteRows 就指錯行 —— 輕則拋例外（儲存失敗），
     重則刪錯行 → 「資料庫」分頁剩返半新半舊嘅段 → loadDb 砌唔成 JSON
     → 後端讀唔到，之後每次儲存都話「未讀到後端版本，唔會盲寫」。 */
  var kill = [];
  got.forEach(function (r) { kill.push(r.row); });
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== unit) continue;
    kill.push(i + 1);
  }
  deleteRowRuns(sh, kill);

  var now = new Date();
  var version = now.toISOString() + '-' + Math.floor(Math.random() * 100000);
  var chunks = [];
  for (var p3 = 0; p3 < text.length; p3 += DB_CHUNK) chunks.push(text.substring(p3, p3 + DB_CHUNK));
  if (!chunks.length) chunks = ['{}'];
  var out2 = [];
  for (var c3 = 0; c3 < chunks.length; c3++) out2.push([unit, c3 + 1, chunks[c3], now, version]);
  sh.getRange(sh.getLastRow() + 1, 1, out2.length, 5).setValues(out2);

  /* ★ v2.6.3：分件儲存都要一次過做齊兩處（呢度先至有成份拼合好嘅資料庫） */
  var reports2 = body.refreshReports === false ? null : refreshReportsFromDb(merged, unit);

  return { success: true, chunks: chunks.length, bytes: text.length, at: now, version: version, parts: parts, reports: reports2 };
}

/* v2.6.2：把一批行號計成一梳一梳、由最底嗰梳刪起（全後端唯一嘅刪行方法）。
   一次過 deleteRows 而唔係逐行 deleteRow：200 段資料逐行刪 ＝ 200 次調用
   （每次成頁 shift），GAS 配額同執行時間都燒好快（v2.3.0 起）。

   ★ 點解一定要**一個**方法、**一次過**刪晒（v2.6.2，團長回報「儲存唔到去
     後端／後端讀取唔到」查到）：
     ① 舊 cleanStaging 係「把梳嘅起點向上移」但**冇**把梳長 +1 ——
        一梳連續暫存行最後淨係刪到**一行**，其餘 N-1 行全部留喺
        「資料庫」分頁。分件儲存一次就留低成份資料庫嘅垃圾行
        （每行 45000 字），每次儲存又留多一份 —— Sheet 越嚟越大，
        每次 getValues() 越來越慢，最後 saveDb／loadDb 撞 GAS
        執行時間／記憶體上限：讀寫一齊死。
     ② 「先刪暫存、再用之前讀返嘅行號刪舊段」係錯嘅：刪咗暫存之後
        所有行號會向上移，第二輪就用錯行號（見 saveDbCommit）。 */
function deleteRowRuns(sh, rowNos) {
  var list = [];
  (rowNos || []).forEach(function (n) {
    var v = Number(n);
    if (Number.isFinite(v) && v >= 1) list.push(v);
  });
  if (!list.length) return 0;
  list.sort(function (a, b) { return a - b; });
  var runs = [];
  list.forEach(function (rowNo) {
    if (runs.length && runs[runs.length - 1][0] + runs[runs.length - 1][1] === rowNo) runs[runs.length - 1][1]++;
    else runs.push([rowNo, 1]);
  });
  for (var i = runs.length - 1; i >= 0; i--) sh.deleteRows(runs[i][0], runs[i][1]);
  return list.length;
}

function cleanStaging(sh, rowsArr) {
  return deleteRowRuns(sh, (rowsArr || []).map(function (r) { return r.row; }));
}

/** v2.6.2 逃生門：一次過清走「資料庫」分頁入面所有 __staging__ 暫存行。
 *  舊版（v2.6.1 之前）cleanStaging 漏刪留低嘅垃圾行，每行 45000 字 ——
 *  分件儲存存過幾次，「資料庫」分頁就會塞滿成份資料庫嘅複製品，
 *  每次 getValues() 越嚟越慢，最後 saveDb／loadDb 撞 GAS 執行時間／記憶體上限
 *  （症狀：「儲存唔到去後端／後端讀取唔到」，但 status 話正常）。
 *  貼咗新版 Code.gs 之後，喺 Apps Script 編輯器執行一次
 *  cleanStaleStaging() 即刻清乾淨；正常儲存唔會再產生垃圾行。
 *  正式資料（unit ＝ 旅團編號嘅行）一行都唔會掂。 */
function cleanStaleStaging() {
  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();
  var dead = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== '__staging__') continue;
    dead.push(i + 1);
  }
  var n = deleteRowRuns(sh, dead);
  var left = Math.max(0, sh.getLastRow() - 1);
  Logger.log('cleanStaleStaging：清走 ' + n + ' 行暫存垃圾，「資料庫」分頁剩返 ' + left + ' 行');
  return { ok: true, removed: n, rowsLeft: left };
}

/** 只睇 meta：後端有冇資料、幾時更新（唔會傳成份資料庫落嚟）。
 *  v2.3.0：附帶逐分頁體積（sizes，只計 JSON 字元長度）同相片 bytes ——
 *  app 用嚟畫「體積檢查」，等成團人用嗰陣知道邊個分頁食緊嘢。 */
function dbInfo(unit) {
  var r = loadDb(unit);
  if (!r.success) return { success: false, error: r.error };
  var db = r.db || {};
  var sizes = {}, photoBytes = 0;
  if (r.found) {
    var keys = Object.keys(db).sort(function (a, b) {
      return JSON.stringify(db[b] || null).length - JSON.stringify(db[a] || null).length;
    });
    keys.slice(0, 14).forEach(function (k) { sizes[k] = JSON.stringify(db[k] || null).length; });
    (db.claims || []).forEach(function (c) {
      (c.photos || []).forEach(function (ph) {
        if (ph && ph.dataUrl) photoBytes += String(ph.dataUrl).length;
      });
    });
  }
  return {
    success: true, found: !!r.found, at: r.at || '', version: r.version || '', bytes: r.bytes || 0,
    sizes: sizes, photoBytes: photoBytes,
    /* v2.6.2：舊版留低嘅暫存垃圾行（正常應該係 0）—— app 嘅「同步診斷」
       見到就會話你知要更新 Code.gs ＋ 執行 cleanStaleStaging() 清走。 */
    stagingRows: r.stagingRows || 0, stagingBytes: r.stagingBytes || 0,
    counts: r.found ? {
      members: (db.members || []).length,
      transactions: (db.transactions || []).length,
      meetings: (db.meetings || []).length,
      notices: (db.notices || []).length,
      invItems: (db.invItems || []).length,
      accounts: (db.accounts || []).length
    } : null
  };
}

/* ============================================================
   主同步核心
   ============================================================ */

/** ★ v2.6.3：由成份資料庫攤平出報表分頁要嘅 tables（同前端 buildPayload 同一個意思）。
 *  注意：通告要保留 signups 原裝 —— writeSignups／writeNoticesFull 要用；
 *  相片／附件就只記數量（dataURL 唔應該寫落報表分頁）。 */
function tablesFromDb(db) {
  db = db || {};
  function rows(list) {
    return (list || []).map(function (r) {
      var o = {};
      for (var k in r) { if (r.hasOwnProperty(k)) o[k] = r[k]; }
      if (Object.prototype.toString.call(o.photos) === '[object Array]') o.photos = o.photos.length;
      if (Object.prototype.toString.call(o.attachments) === '[object Array]') o.attachments = o.attachments.length;
      return o;
    });
  }
  return {
    members: rows(db.members),
    transactions: rows(db.transactions),
    claims: rows(db.claims),
    invItems: rows(db.invItems),
    invLoans: rows(db.invLoans),
    meetings: rows(db.meetings),
    notices: db.notices || []
  };
}

/** ★ v2.6.3：一次儲存＝兩處都寫 —— 「資料庫」分頁（app 正本）＋報表分頁（人睇嗰啲）。
 *  報表刷新失敗唔應該令成次儲存變失敗（資料已經安全寫入「資料庫」分頁），
 *  所以呢度一律 try/catch，把結果如實報返上去。 */
function refreshReportsFromDb(db, unit) {
  if (!unit || unit === 'UNKNOWN') return null;
  try {
    var counts = syncAll({
      unit: unit,
      unitName: textOf(db && db.profile && db.profile.name) || textOf(db && db.unit && db.unit.name),
      tables: tablesFromDb(db)
    });
    return { ok: true, counts: counts };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

function syncAll(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var unit = body.unit || 'UNKNOWN';
  var tables = body.tables || {};
  var schema = body.schema || {};
  var counts = {};

  // 帳目（合併「財務」）
  counts['transactions'] = writeTab(ss, body, '帳目', tables.transactions, schema.transactions, ['date', 'type', 'item', 'amount', 'category', 'method', 'byName', 'ref', 'period', 'note']);
  counts['claims'] = writeTab(ss, body, '收支申報', tables.claims, schema.claims, ['date', 'type', 'item', 'amount', 'category', 'byName', 'status', 'note']);
  counts['invItems'] = writeTab(ss, body, '物資', tables.invItems, schema.invItems, ['code', 'name', 'category', 'total', 'unit', 'location', 'condition', 'note']);
  counts['members'] = writeTab(ss, body, '團員', tables.members, schema.members, ['ymis', 'systemId', 'name', 'eng', 'identity', 'birthday', 'role', 'status', 'phone', 'email', 'join', 'note']);

  // 成員名單（同進度前端共用，兩邊見同一批人）
  counts['memberList'] = writeMemberList(ss, tables.members || []);

  // 通告：一張通告一行
  counts['notices'] = writeTab(ss, body, '通告', tables.notices, schema.notices,
    ['title.zh', 'title.en', 'type', 'status', 'eventDate', 'deadline', 'venue', 'assembly', 'dismissal',
     'programme', 'dress', 'fee', 'quota', 'enquiry', 'publishAt']);

  // 通告全文（公開頁讀呢個分頁；只公開 status=published）
  counts['noticesFull'] = writeNoticesFull(ss, unit, tables.notices || []);

  // 報名：每一份報名一行（由通告內嘅 signups 攤開）
  counts['signups'] = writeSignups(ss, body, tables.notices || []);

  // 物資借用（借出／歸還紀錄）
  counts['invLoans'] = writeTab(ss, body, '物資借用', tables.invLoans, schema.invLoans, ['borrowerName', 'itemName', 'qty', 'outDate', 'dueDate', 'status', 'note']);

  // 會議
  counts['meetings'] = writeTab(ss, body, '會議', tables.meetings, schema.meetings, ['date', 'title', 'venue', 'status', 'note']);

  // 設定（每次更新，方便你睇邊個旅團幾時同步）
  var log = ss.getSheetByName('同步紀錄') || ss.insertSheet('同步紀錄');
  log.appendRow([new Date(), unit, body.unitName || '', JSON.stringify(counts)]);
  log.getRange(1, 1, 1, 4).setFontWeight('bold');

  // v2.6.1：順手清走舊版留低嘅後綴分身（物資·0082、帳目·0082、團員·0082、
  // 收支申報·0082、通告·0082、報名·0082、物資借用·0082、會議·0082）。
  // 查實啲資料頭先已經寫返落無後綴分頁，呢啲只係舊 code 遺物；唔刪佢，
  // 團長下次同步仲會見到「物資82」嗰啲分頁。
  removeSuffixedTabs(ss, unit);

  return counts;
}

/** 刪走上次同步留低嘅「分頁名·旅團編號」分身（同一個旅團先刪） */
function removeSuffixedTabs(ss, unit) {
  try {
    var suffix = '·' + textOf(unit);
    if (!unit || suffix === '·') return;
    ss.getSheets().forEach(function (sh) {
      var nm = sh.getName();
      /* ★ v2.6.3 修正一個潛伏咗兩版嘅炸彈：
         舊寫法 nm.indexOf(suffix) === nm.length - suffix.length，
         喺「個名根本冇嗰個後綴」嗰陣 indexOf 回 -1，
         於是條件變成 nm.length === suffix.length - 1 ——
         即係**任何名字長度啱撞正 4 個字**嘅分頁都會被刪！
         「進度追蹤」「待批完成」「活動履歷」「待批履歷」「成員名單」「同步紀錄」「通告全文」
         全部係 4 個字 —— 一撳報表同步就成批分頁連資料一齊冇咗
         （團員進度、批核紀錄）。而家嚴格比對結尾，而且要長過個後綴先算。 */
      if (nm.length > suffix.length && nm.slice(nm.length - suffix.length) === suffix) {
        try { ss.deleteSheet(sh); } catch (e) { /* 刪唔到就留低，唔好成全個同步失敗 */ }
      }
    });
  } catch (e) { /* ignore */ }
}

/** 寫入一個工作表（每次同步會重寫該旅團嘅資料，避免重複） */
function writeTab(ss, body, baseName, rows, schema, fallbackKeys) {
  rows = rows || [];
  var keys = (schema && schema.length ? schema.map(function (f) { return f.key; }) : fallbackKeys) || [];
  // 加上未定義但有值嘅欄位
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (keys.indexOf(k) < 0 && k !== 'id' && k !== 'photos' && k !== 'attachments' && k !== 'signups') keys.push(k);
    });
  });
  var header = ['旅團'].concat(['id']).concat(keys).concat(['同步時間']);
  var data = rows.map(function (r) {
    return [body.unit].concat([r.id || '']).concat(keys.map(function (k) { return cell(getPath(r, k)); }))
      .concat([new Date()]);
  });

  var name = sheetName(baseName, body.unit);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (data.length) sh.getRange(2, 1, data.length, header.length).setValues(data);
  sh.setFrozenRows(1);
  return rows.length;
}

/** 通告全文：一行一張通告（JSON 原樣存起，公開頁免登入讀） */
function writeNoticesFull(ss, unit, notices) {
  var sh = ss.getSheetByName('通告全文') || ss.insertSheet('通告全文');
  sh.clear();
  sh.getRange(1, 1, 1, 6).setValues([['旅團', 'id', '狀態', '標題', 'JSON', '更新時間']]).setFontWeight('bold');
  var data = (notices || []).map(function (n) {
    var slim = {
      id: n.id, type: n.type, status: n.status,
      title: n.title || {}, body: n.body || {},
      eventDate: n.eventDate || '', deadline: n.deadline || '',
      venue: n.venue || '', assembly: n.assembly || '', dismissal: n.dismissal || '',
      programme: n.programme || '', dress: n.dress || '', fee: n.fee || '',
      quota: Number(n.quota) || 0, enquiry: n.enquiry || '',
      needSignup: n.needSignup !== false,
      fields: n.fields || [], publishAt: n.publishAt || '',
      signupCount: (n.signups && n.signups.length) || 0,
      unit: unit, unitName: n.unitName || ''
    };
    return [unit, textOf(n.id), textOf(n.status), textOf(n.title && n.title.zh), JSON.stringify(slim), new Date()];
  });
  if (data.length) sh.getRange(2, 1, data.length, 6).setValues(data);
  sh.setFrozenRows(1);
  return data.length;
}

/**
 * 讀公開通告（免登入）：只回 published
 * 兩個前端共用一個後端 —— 公開頁唔使等改 Git，同步完就見到新通告
 *
 * v2.5.0：改為由「資料庫」分頁（APP 儲存嘅正本）讀 ——
 * 以前淨係讀「通告全文」分頁，但嗰分頁要手動撳「總表同步」先會更新，
 * APP 新開／改完嘅通告喺公開頁會一直見唔到（團長回報「其他功能成唔成唔知」嘅死因之一）。
 * 「通告全文」分頁留返做後備（舊資料／從未同步過嘅旅團）。
 */
function loadPublicNotices(unit) {
  try {
    var r = loadDb(unit);
    if (r.success && r.found && r.db && Array.isArray(r.db.notices)) {
      var fromDb = r.db.notices.filter(function (n) { return n && n.status === 'published' && n.id; });
      if (fromDb.length) return fromDb;
    }
  } catch (e0) { /* 跌落去「通告全文」分頁 */ }
  var out = [];
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('通告全文');
  if (!sh) return out;
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var u = textOf(rows[i][0]);
    if (unit && u && u !== unit) continue;
    if (textOf(rows[i][2]) !== 'published') continue;
    var raw = rows[i][4];
    if (!raw) continue;
    try {
      var obj = JSON.parse(String(raw));
      if (obj && obj.id) out.push(obj);
    } catch (e) { /* 壞行就略過 */ }
  }
  return out;
}

/**
 * 公開團章（v2.5.0，免 API Key）：由「資料庫」分頁抽 constitution。
 * 只回 constitution（＋旅團名／版本）—— 名冊、帳目等一概唔會出去。
 * 只回已經有內容嘅（未寫過團章／未同步過 → found:false，公開頁會用靜態檔後備）。
 */
function publicConstitution(unit) {
  var r;
  try { r = loadDb(unit); } catch (e) { return { success: false, found: false, error: String(e) }; }
  if (!r.success) return { success: false, found: false, error: r.error || '' };
  if (!r.found) return { success: true, found: false };
  var db = r.db || {};
  var c = db.constitution;
  if (!c || !Array.isArray(c.chapters) || !c.chapters.length) return { success: true, found: false };
  return {
    success: true, found: true, constitution: c,
    unitName: (db.profile && db.profile.name) || (db.unit && db.unit.name) || '',
    version: c.version || '', at: r.at || ''
  };
}

/** 通告報名（攤開） */
function writeSignups(ss, body, notices) {
  var rows = [];
  notices.forEach(function (n) {
    (n.signups || []).forEach(function (s) {
      var v = s.values || {};
      rows.push([body.unit, n.id, n.title && n.title.zh || '', s.at || '', v.name || '', v.contact || '', attendOf(v), JSON.stringify(v)]);
    });
  });
  var name = sheetName('報名', body.unit);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var header = ['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
  return rows.length;
}

/* ============================================================
   一個後端、兩個前端：進度追蹤
   ------------------------------------------------------------
   呢個後端同時餵兩個前端：
     ① 執委管理系統（呢邊）   ② 進度追蹤前端（團員／領袖用）
   共用分頁：進度追蹤 / 其他獎章 / 待批完成 / 活動履歷 / 待批履歷 / 成員名單
   讀：GET  ?action=load[&apikey=…]
   寫：POST { action:'save' | 'saveOtherBadge', apikey, changes / records }
   ============================================================ */

function textOf(v) { return String(v === null || v === undefined ? '' : v).trim(); }

function dateOf(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    try { return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); } catch (err) { /* 用下面嘅 fallback */ }
    try { return v.toISOString().slice(0, 10); } catch (err2) { return String(v); }
  }
  return textOf(v);
}

/** 成員名單：以「成員名單」為主，補上「團員」分頁（執委系統同步過嚟嘅） */
function progressMembers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  var seen = {};
  var mSheet = ss.getSheetByName('成員名單');
  if (mSheet) {
    var m = mSheet.getDataRange().getValues();
    for (var i = 1; i < m.length; i++) {
      var ymis = textOf(m[i][0]);
      if (!ymis || seen[ymis]) continue;
      out.push({ ymis: ymis, name: textOf(m[i][1]) });
      seen[ymis] = true;
    }
  }
  var tSheet = null;
  var all = ss.getSheets();
  for (var k = 0; k < all.length; k++) {
    var nm = all[k].getName();
    if (nm === '團員' || nm.indexOf('團員·') === 0) { tSheet = all[k]; break; }
  }
  if (tSheet) {
    /* v2.6.1（2026-09-20 團長回報「成員進度重複」）：
       以前寫死「第 2 欄＝ymis、第 4 欄＝姓名」（嗰個係 initializeSheets 嘅次序），
       但報表同步（writeTab）係用前端 schema 次序寫（…,name,…,identity,…,ymis,…），
       兩套唔同結果讀錯欄——每人多咗一行「ymis=姓名、name=身份」。
       而家照標題列搵返 ymis／姓名 喺邊一欄，兩個次序都啱。 */
    var t = tSheet.getDataRange().getValues();
    var head = (t.length ? t[0] : []).map(function (c) { return textOf(c); });
    var ciYmis = -1, ciName = -1;
    for (var c = 0; c < head.length; c++) {
      if (ciYmis < 0 && (head[c] === 'ymis' || head[c].toLowerCase() === 'ymis')) ciYmis = c;
      if (ciName < 0 && /^姓名$|^名$|^name$/i.test(head[c])) ciName = c;
    }
    /* 搵唔到欄就退返 initializeSheets 嘅舊次序（旅團,id,ymis,systemId,姓名,…） */
    if (ciYmis < 0) ciYmis = 2;
    if (ciName < 0) ciName = 4;
    for (var j = 1; j < t.length; j++) {
      var y2 = textOf(t[j][ciYmis]);
      if (!y2 || seen[y2]) continue;
      out.push({ ymis: y2, name: textOf(t[j][ciName]) });
      seen[y2] = true;
    }
  }
  return out;
}

/** 讀全部進度資料（同進度前端嘅 /exec?action=load 同一種格式） */
function loadProgressData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var progress = {};
  var flat = {};
  var i, rows;

  var pSheet = ss.getSheetByName('進度追蹤');
  if (pSheet) {
    rows = pSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      var ymis = textOf(rows[i][0]);
      var itemId = textOf(rows[i][1]);
      if (!ymis || !itemId) continue;
      if (!progress[ymis]) { progress[ymis] = {}; flat[ymis] = {}; }
      progress[ymis][itemId] = { date: dateOf(rows[i][2]), confirmer: textOf(rows[i][4]) };
      flat[ymis][itemId] = dateOf(rows[i][2]);
    }
  }

  var other = {};
  var oSheet = ss.getSheetByName('其他獎章');
  if (oSheet) {
    rows = oSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      var oy = textOf(rows[i][0]);
      var ob = textOf(rows[i][1]);
      if (!oy || !ob) continue;
      if (!other[oy]) other[oy] = {};
      other[oy][ob] = { name: textOf(rows[i][2]), date: dateOf(rows[i][3]), cert: textOf(rows[i][4]) };
    }
  }

  var pending = [];
  var prSheet = ss.getSheetByName('待批完成');
  if (prSheet) {
    rows = prSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (textOf(rows[i][7]) !== 'pending') continue;
      pending.push({
        request_id: textOf(rows[i][0]), ymis: textOf(rows[i][1]), name: textOf(rows[i][2]),
        item_id: textOf(rows[i][3]), item_name: textOf(rows[i][4]),
        requested_date: dateOf(rows[i][5]), evidence: textOf(rows[i][6]),
        status: 'pending', created_at: dateOf(rows[i][8])
      });
    }
  }

  var logs = [];
  var lSheet = ss.getSheetByName('活動履歷');
  if (lSheet) {
    rows = lSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (!textOf(rows[i][0])) continue;
      logs.push({
        record_id: textOf(rows[i][0]), type: textOf(rows[i][1]) || 'activity',
        ymis: textOf(rows[i][2]), name: textOf(rows[i][3]), date: dateOf(rows[i][4]),
        title: textOf(rows[i][5]), role: textOf(rows[i][6]), hours: textOf(rows[i][7]),
        cert_no: textOf(rows[i][8]), detail: textOf(rows[i][9]), recorder: textOf(rows[i][10]),
        recorded_at: textOf(rows[i][11])
      });
    }
  }

  var logRequests = [];
  var lrSheet = ss.getSheetByName('待批履歷');
  if (lrSheet) {
    rows = lrSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (!textOf(rows[i][0]) || textOf(rows[i][12]) !== 'pending') continue;
      logRequests.push({
        request_id: textOf(rows[i][0]), kind: textOf(rows[i][1]) || 'new',
        target_record_id: textOf(rows[i][2]), type: textOf(rows[i][3]) || 'activity',
        ymis: textOf(rows[i][4]), name: textOf(rows[i][5]), date: dateOf(rows[i][6]),
        title: textOf(rows[i][7]), role: textOf(rows[i][8]), hours: textOf(rows[i][9]),
        cert_no: textOf(rows[i][10]), detail: textOf(rows[i][11]),
        status: 'pending', created_at: textOf(rows[i][13])
      });
    }
  }

  return {
    members: progressMembers(),
    progress: progress,
    flatProgress: flat,
    pendingRequests: pending,
    otherBadges: other,
    logs: logs,
    logsSupported: !!ss.getSheetByName('活動履歷'),
    logRequests: logRequests,
    logRequestsSupported: !!ss.getSheetByName('待批履歷'),
    at: new Date()
  };
}

/**
 * 同時多人寫入就排隊（LockService）。
 * BUILD 要求「等唔到鎖就拒絕」，唔可以未攞到鎖仍然讀→改→寫，否則
 * 兩個請求會同時覆蓋資料。等候失敗會拋出可識別錯誤，由 doPost 統一回傳
 * 429；所有呼叫者都必須先攞到鎖，並由 finally 釋放。
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    var busy = new Error('LOCK_BUSY');
    busy.code = 'LOCK_BUSY';
    throw busy;
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/** 勾／取消勾（同進度前端寫入同一個分頁） */
function saveProgress(changes, confirmer) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('進度追蹤');
  if (!sheet) return { success: false, error: '搵唔到「進度追蹤」分頁（請先執行 initializeSheets）' };
  var processed = 0;
  (changes || []).forEach(function (c) {
    var ymis = textOf(c.ymis);
    var itemId = textOf(c.itemId);
    if (!ymis || !itemId) return;
    var rows = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rows.length; i++) {
      if (textOf(rows[i][0]) === ymis && textOf(rows[i][1]) === itemId) {
        if (c.uncomplete) {
          sheet.deleteRow(i + 1);
        } else {
          sheet.getRange(i + 1, 3).setValue(c.date || '');
          sheet.getRange(i + 1, 4).setValue(new Date());
          sheet.getRange(i + 1, 5).setValue(confirmer || c.confirmer || '');
          sheet.getRange(i + 1, 6).setValue(c.note || '');
        }
        found = true; processed++; break;
      }
    }
    if (!found && !c.uncomplete) {
      sheet.appendRow([ymis, itemId, c.date || '', new Date(), confirmer || c.confirmer || '', c.note || '']);
      processed++;
    }
  });
  return { success: true, processed: processed };
}

/** 其他獎章（服務／活動／訓練班以外嘅證書紀錄） */
function saveOtherBadges(records) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('其他獎章');
  if (!sheet) return { success: false, error: '搵唔到「其他獎章」分頁（請先執行 initializeSheets）' };
  var processed = 0;
  (records || []).forEach(function (r) {
    var ymis = textOf(r.ymis);
    var badgeId = textOf(r.badgeId || r.id);
    if (!ymis || !badgeId) return;
    var rows = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rows.length; i++) {
      if (textOf(rows[i][0]) === ymis && textOf(rows[i][1]) === badgeId) {
        if (r.uncomplete) { sheet.deleteRow(i + 1); }
        else {
          sheet.getRange(i + 1, 3).setValue(textOf(r.name));
          sheet.getRange(i + 1, 4).setValue(r.date || '');
          sheet.getRange(i + 1, 5).setValue(textOf(r.cert));
          sheet.getRange(i + 1, 6).setValue(textOf(r.note));
          sheet.getRange(i + 1, 7).setValue(new Date());
        }
        found = true; processed++; break;
      }
    }
    if (!found && !r.uncomplete) {
      sheet.appendRow([ymis, badgeId, textOf(r.name), r.date || '', textOf(r.cert), textOf(r.note), new Date()]);
      processed++;
    }
  });
  return { success: true, processed: processed };
}

/* ============================================================
   團員申報進度完成（v2.2.0，畀團員入口用；免 API Key）
   寫入「待批完成」分頁，狀態 pending；執委喺審批中心批准後
   先會真正寫入「進度追蹤」。唔會直接改任何進度資料。
   ============================================================ */
function addProgressRequest(body) {
  var ymis = textOf(body.ymis);
  var itemId = textOf(body.item_id);
  if (!ymis || !itemId) return { success: false, error: '缺少 ymis 或 item_id' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批完成');
  if (!sheet) return { success: false, error: '搵唔到「待批完成」分頁（請先執行 initializeSheets）' };
  var reqId = 'req_' + textOf(body.unit) + '_' + new Date().getTime() + '_' + Math.floor(Math.random() * 900 + 100);
  var reqDate = textOf(body.requested_date) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.appendRow([reqId, ymis, textOf(body.name), itemId, textOf(body.item_name),
    reqDate, textOf(body.evidence), 'pending', new Date(), '', '', '', '']);
  return { success: true, request_id: reqId };
}

/** 團員查自己嘅申報（只回該 YMIS 嘅紀錄；pending 嘅排先） */
function loadMyRequests(ymis) {
  ymis = textOf(ymis);
  if (!ymis) return { ok: true, success: true, requests: [] };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批完成');
  if (!sheet) return { ok: true, success: true, requests: [] };
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][1]) !== ymis) continue;
    out.push({
      request_id: textOf(rows[i][0]), item_id: textOf(rows[i][3]), item_name: textOf(rows[i][4]),
      requested_date: dateOf(rows[i][5]), status: textOf(rows[i][7]) || 'pending',
      review_note: textOf(rows[i][11]), confirmed_date: dateOf(rows[i][12]),
      created_at: rows[i][8] ? new Date(rows[i][8]).toISOString() : ''
    });
  }
  out.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  return { ok: true, success: true, requests: out.slice(0, 60) };
}

/* ============================================================
   審批中心：待批完成（團員申報 → 執委／領袖喺執委管理系統批）
   批准＝寫入「進度追蹤」（同一個後端、兩個前端都即刻見到）
   ============================================================ */
function reviewProgressRequest(reqId, decision, note, reviewer, confirmedDate) {
  reqId = textOf(reqId);
  if (!reqId) return { success: false, error: '缺少 request_id' };
  if (decision !== 'approved' && decision !== 'rejected') return { success: false, error: '無效決定' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批完成');
  if (!sheet) return { success: false, error: '搵唔到「待批完成」分頁（請先執行 initializeSheets）' };
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== reqId) continue;
    if (textOf(rows[i][7]) !== 'pending') return { success: false, error: '呢個申請已經處理過' };
    var reqDate = dateOf(rows[i][5]);
    var finalDate = textOf(confirmedDate) || reqDate || dateOf(new Date());
    sheet.getRange(i + 1, 8).setValue(decision);
    sheet.getRange(i + 1, 10).setValue(textOf(reviewer));
    sheet.getRange(i + 1, 11).setValue(new Date());
    sheet.getRange(i + 1, 12).setValue(textOf(note));
    sheet.getRange(i + 1, 13).setValue(finalDate);
    if (decision !== 'approved') return { success: true, message: '已拒絕' };
    var ymis = textOf(rows[i][1]);
    var itemId = textOf(rows[i][3]);
    var pSheet = ss.getSheetByName('進度追蹤');
    if (!pSheet) return { success: false, error: '搵唔到「進度追蹤」分頁' };
    var prow = pSheet.getDataRange().getValues();
    var hit = -1;
    for (var k = 1; k < prow.length; k++) {
      if (textOf(prow[k][0]) === ymis && textOf(prow[k][1]) === itemId) { hit = k; break; }
    }
    var memo = '由申請轉入：' + textOf(note);
    if (hit >= 0) {
      pSheet.getRange(hit + 1, 3).setValue(finalDate);
      pSheet.getRange(hit + 1, 4).setValue(new Date());
      pSheet.getRange(hit + 1, 5).setValue(textOf(reviewer));
      pSheet.getRange(hit + 1, 6).setValue(memo);
    } else {
      pSheet.appendRow([ymis, itemId, finalDate, new Date(), textOf(reviewer), memo]);
    }
    return { success: true, message: '已批准並寫入進度' };
  }
  return { success: false, error: '搵唔到申請（可能已經處理）' };
}

/* 待批履歷：團員自行申報活動履歷 → 執委／領袖批准 */
function reviewLogRequest(reqId, decision, note, reviewer) {
  reqId = textOf(reqId);
  if (!reqId) return { success: false, error: '缺少 request_id' };
  if (decision !== 'approved' && decision !== 'rejected') return { success: false, error: '無效決定' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批履歷');
  if (!sheet) return { success: false, error: '搵唔到「待批履歷」分頁（請先執行 initializeSheets）' };
  var rows = sheet.getDataRange().getValues();
  var rowIndex = -1, row = null;
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) === reqId) { rowIndex = i + 1; row = rows[i]; break; }
  }
  if (!row) return { success: false, error: '搵唔到申報' };
  if (textOf(row[12]) !== 'pending') return { success: false, error: '呢個申報已經處理過' };
  var kind = textOf(row[1]) || 'new';
  var rec = {
    type: textOf(row[3]) || 'activity', ymis: textOf(row[4]), name: textOf(row[5]),
    date: dateOf(row[6]), title: textOf(row[7]), role: textOf(row[8]), hours: textOf(row[9]),
    cert_no: textOf(row[10]), detail: textOf(row[11])
  };
  if (decision !== 'approved') {
    sheet.getRange(rowIndex, 13).setValue('rejected');
    sheet.getRange(rowIndex, 15).setValue(textOf(reviewer));
    sheet.getRange(rowIndex, 16).setValue(new Date());
    sheet.getRange(rowIndex, 17).setValue(textOf(note));
    return { success: true, message: '已拒絕申報' };
  }
  var lSheet = ss.getSheetByName('活動履歷');
  if (!lSheet) return { success: false, error: '搵唔到「活動履歷」分頁' };
  var recordId = '';
  var recorder = '';
  if (kind === 'edit') {
    var targetId = textOf(row[2]);
    var ld = lSheet.getDataRange().getValues();
    var li = -1;
    for (var j = 1; j < ld.length; j++) { if (textOf(ld[j][0]) === targetId) { li = j; break; } }
    if (li < 0) return { success: false, error: '搵唔到原紀錄（可能已被刪除）' };
    recorder = textOf(ld[li][10]);
    lSheet.getRange(li + 1, 2, 1, 12).setValues([[
      rec.type, rec.ymis, rec.name, rec.date, rec.title, rec.role,
      rec.hours, rec.cert_no, rec.detail, recorder, textOf(ld[li][11]), new Date()
    ]]);
    recordId = targetId;
  } else {
    recordId = 'LOG_' + new Date().getTime() + '_' + Math.random().toString(36).substr(2, 5);
    recorder = rec.name + '（自行申報）';
    lSheet.appendRow([recordId, rec.type, rec.ymis, rec.name, rec.date, rec.title, rec.role,
      rec.hours, rec.cert_no, rec.detail, recorder, new Date(), '']);
  }
  sheet.getRange(rowIndex, 13).setValue('approved');
  sheet.getRange(rowIndex, 15).setValue(textOf(reviewer));
  sheet.getRange(rowIndex, 16).setValue(new Date());
  sheet.getRange(rowIndex, 17).setValue(textOf(note));
  return { success: true, message: kind === 'edit' ? '已批准修改並更新紀錄' : '已批准並寫入活動履歷', record_id: recordId };
}

/** 成員名單：由執委系統嘅名冊更新（唔會刪人，進度紀錄照樣對得返） */
function writeMemberList(ss, rows) {
  var sh = ss.getSheetByName('成員名單');
  if (!sh) {
    sh = ss.insertSheet('成員名單');
    sh.appendRow(['YMIS', '姓名', '加入日期', '支部', '聯絡']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  var existing = {};
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) existing[textOf(data[i][0])] = i + 1;
  var n = 0;
  (rows || []).forEach(function (m) {
    var ymis = textOf(m.ymis);
    if (!ymis) return;
    var row = [ymis, textOf(m.name), textOf(m.join || m.joinDate), textOf(m.role || m.branch), textOf(m.phone || m.email)];
    if (existing[ymis]) sh.getRange(existing[ymis], 1, 1, 5).setValues([row]);
    else { sh.appendRow(row); existing[ymis] = sh.getLastRow(); }
    n++;
  });
  return n;
}

/* ============================================================
   公開頁動作：收支申報／物資借用／通告報名
   ------------------------------------------------------------
   v2.5.0 起呢三樣嘢**都會寫入「資料庫」分頁**（APP 嘅正本）：
   以前只係寫報表分頁（收支申報／物資借用／報名），執委部機嘅 APP
   永遠見唔到 —— 成員送出咗申報，司庫要自己開 Google Sheet 先知有嘢等批。
   而家寫入資料庫之後，執委部機開住 APP（60 秒 poll／開機拉）就會自動見到。
   （後端從來未同步過資料庫嘅旅團：照舊淨係寫報表分頁，唔會無中生有起個 db。）
   ============================================================ */

/**
 * 把一筆紀錄寫入資料庫（要喺 withLock 入面用）。
 * mutator(db) 改 db；回 false = 唔使存（例如重複報名）。
 * 回 { found, dbSaved, skip }（後端冇資料庫 → found:false，只寫報表分頁）。
 */
function appendIntoDb(unit, mutator) {
  var r = loadDb(unit);
  if (!r.success || !r.found || !r.db) return { found: false, dbSaved: false, skip: false };
  if (mutator(r.db) === false) return { found: true, dbSaved: false, skip: true };
  /* 用啱啱讀到嘅版本做 baseVersion —— 同一把鎖入面冇人插到隊，實得 */
  var sv = saveDb({ unit: unit, db: r.db, baseVersion: String(r.version || '') });
  return { found: true, dbSaved: sv.success === true, skip: false, error: sv.error || '' };
}

/** 時間戳（同 APP 嘅 nowStamp() 一樣格式） */
function nowStampGs() {
  return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss');
}

/** 手機記一筆（成員影相＋選欄目） */
function appendClaim(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var name = sheetName('收支申報', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['旅團', '時間', '日期', '類型', '欄目', '項目', '金額', '付款人', '備註', '相片張數', '相片連結', '紀錄編號'])
      .getRange(1, 1, 1, 12).setFontWeight('bold');
  }
  var links = savePhotos(p.photos || [], body.unit || '', p.id || '', textOf(body.folderId));
  sh.appendRow([
    body.unit || '', new Date(), p.date || '', p.type === 'income' ? '收入' : '支出',
    p.category || '', p.item || '', Number(p.amount) || 0, p.byName || '', p.note || '',
    (p.photos || []).length, links.join('\n'), p.id || ''
  ]);
  /* v2.5.0：同時寫入資料庫（APP「財務 → 收支申報」待批清單即刻見到） */
  var dbR = appendIntoDb(body.unit || '', function (db) {
    if (!Array.isArray(db.claims)) db.claims = [];
    if (db.claims.some(function (c) { return c && String(c.id) === String(p.id || ''); })) return false;   // 防重送
    db.claims.push({
      id: p.id || ('cl_' + Date.now()),
      type: p.type === 'income' ? 'income' : 'expense',
      amount: Number(p.amount) || 0,
      date: p.date || '',
      category: p.category || '',
      item: p.item || '',
      byName: p.byName || '',
      memberId: p.memberId || '',
      note: (p.note || '') + (p.contact ? '（聯絡：' + p.contact + '）' : ''),
      receipt: !!(p.receipt || (p.photos || []).length),
      photos: links.map(function (l) { return { name: '', type: 'image/jpeg', link: l }; }),
      photosOnDrive: links.length > 0,
      status: 'pending',
      requestedBy: 'public:entry',
      requestedAt: nowStampGs()
    });
  });
  return { photos: links.length, dbSaved: dbR.dbSaved, dbFound: dbR.found };
}

/** 將 base64 相片存去 Drive（未設定資料夾就只記數量） */
/** v2.3.0 單據 Drive 資料夾：優先次序
 *  ① 前端明確指定（APP 內「財務 → 設定」填嘅 settings.receiptDrive，uploadPhotos 帶上嚟）
 *  ② 該旅團資料庫 settings.receiptDrive（團員入口 entry.html 走呢條路）
 *  ③ Apps Script Script Property DRIVE_FOLDER_ID（部署時設定嘅預設）
 *  收連結或者 ID 都得（自動抽出 folders/… ID）。 */
function receiptFolderId(explicit, unit) {
  var v = textOf(explicit);
  if (!v && unit) {
    try {
      var r = loadDb(unit);
      if (r.found && r.db && r.db.settings) v = textOf(r.db.settings.receiptDrive);
    } catch (e2) { /* 讀唔到就用預設 */ }
  }
  if (!v) return '';
  var m = String(v).match(/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(v)) return v;
  return '';
}

function savePhotos(photos, unit, id, explicitFolder) {
  var out = [];
  var fid = receiptFolderId(explicitFolder, unit) || DRIVE_FOLDER_ID;
  if (!fid) return out;
  var folder;
  try { folder = DriveApp.getFolderById(fid); } catch (e) { return out; }
  for (var i = 0; i < photos.length; i++) {
    try {
      var ph = photos[i];
      var b64 = String(ph.dataUrl || '').split(',')[1] || '';
      if (!b64) continue;
      var blob = Utilities.newBlob(Utilities.base64Decode(b64), ph.type || 'image/jpeg', unit + '_' + id + '_' + (i + 1) + '.jpg');
      var f = folder.createFile(blob);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      out.push(f.getUrl());
    } catch (e2) { /* 單張失敗唔好中斷 */ }
  }
  return out;
}

/** 物資借用（成員公開頁 borrow.html） */
function appendLoan(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var name = sheetName('物資借用', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['旅團', '時間', '申請人', '聯絡電話', '物資編號', '物資名稱', '數量', '借用日', '歸還日', '用途', '狀態', '紀錄編號'])
      .getRange(1, 1, 1, 12).setFontWeight('bold');
  }
  sh.appendRow([
    body.unit || '', new Date(), p.byName || '', p.contact || '', p.itemCode || '', p.itemName || '',
    Number(p.qty) || 1, p.fromDate || '', p.toDate || '', p.purpose || '', '待批核', p.id || ''
  ]);
  /* v2.5.0：同時寫入資料庫（APP「物資 → 借用與批核」即刻見到） */
  var dbR = appendIntoDb(body.unit || '', function (db) {
    if (!Array.isArray(db.invLoans)) db.invLoans = [];
    if (db.invLoans.some(function (l) { return l && String(l.id) === String(p.id || ''); })) return false;   // 防重送
    db.invLoans.push({
      id: p.id || ('ln_' + Date.now()),
      itemId: p.itemId || '',
      qty: Number(p.qty) || 1,
      borrowerName: p.byName || '',
      borrowerId: '',
      purpose: p.purpose || '',
      outDate: p.fromDate || '',
      dueDate: p.toDate || '',
      returnDate: '',
      status: 'requested',
      requestedBy: 'public:borrow',
      requestedByAccountId: '',
      requestedAt: nowStampGs(),
      approvedBy: '',
      note: p.contact ? '聯絡：' + p.contact : ''
    });
  });
  return { dbSaved: dbR.dbSaved, dbFound: dbR.found };
}

/** 公開頁即時報名（notice.html）。
    v2.5.0：同時寫入資料庫 —— 執委喺 APP「通告 → 報名紀錄」即刻見到，
    並按「同一通告＋同一個名」防重複（換裝置重複提交都唔會重複入數）。 */
function appendSignup(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var v = p.values || {};
  var name = sheetName('報名', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)']).getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  var dup = false;
  var dbR = appendIntoDb(body.unit || '', function (db) {
    if (!Array.isArray(db.notices)) db.notices = [];
    var n = null;
    for (var i = 0; i < db.notices.length; i++) {
      if (String(db.notices[i] && db.notices[i].id) === String(p.noticeId || '')) { n = db.notices[i]; break; }
    }
    if (!n) return false;                                   // 資料庫未有你張通告（未同步過）→ 淨係寫報表分頁
    if (!Array.isArray(n.signups)) n.signups = [];
    var who = String(v.name || '').trim();
    if (who && n.signups.some(function (s) { return s && String(s.name || (s.values && s.values.name) || '').trim() === who; })) {
      dup = true;
      return false;                                         // 同一通告＋同名 → 唔好重複入數
    }
    n.signups.push({
      id: 'sg_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      at: p.at || nowStampGs(),
      name: who,
      values: v
    });
  });
  if (dup) return { success: true, duplicate: true, dbSaved: false };
  sh.appendRow([body.unit || '', p.noticeId || '', p.noticeTitle || '', p.at || new Date(), v.name || '', v.contact || '', attendOf(v), JSON.stringify(v)]);
  return { success: true, duplicate: false, dbSaved: dbR.dbSaved, dbFound: dbR.found };
}

/* ============================================================
   工具函數
   ============================================================ */

function sheetName(base, unit) {
  /* v2.6.1（2026-09-20 團長回報）：總表本身**就係**一個旅團嘅 Sheet。
     initializeSheets() 建嘅係無後綴分頁（物資／帳目／團員…），
     以前呢度喺 per-unit-sheet 模式照樣回「分頁名·旅團編號」（物資·0082），
     同 initializeSheets 兩套名對唔上，結果每次同步都**多生一張**「物資·0082」。
     而家報表一律寫返無後綴分頁，同 initializeSheets 一致，
     即等於填落原本嗰張「物資」度，唔會再生分身。 */
  return base;
}

function getPath(obj, path) {
  if (!path) return '';
  return path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, obj);
}

/** 由報名欄位抽出「出席與否」（欄位 key 通常係 attend / rsvp） */
function attendOf(v) {
  if (!v) return '';
  var keys = ['attend', 'rsvp', 'attendance', '出席', '出席與否'];
  for (var i = 0; i < keys.length; i++) {
    if (v[keys[i]] !== undefined && v[keys[i]] !== null && String(v[keys[i]]) !== '') return String(v[keys[i]]);
  }
  return '';
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.length + ' 項';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
