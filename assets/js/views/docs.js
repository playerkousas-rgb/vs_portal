/* ============================================================
   docs.js — 使用教學（內建）＋ 多旅團部署指南
   ------------------------------------------------------------
   ★ 2026-09-24 團長：「刪除示範資料 (MOCK) 我都在用要MOCK 幹什麼」
     → 示範資料（data/mock/）同成個示範模式拆走，教學入面嗰個
       「示範資料（MOCK）」章節一齊刪。
   ============================================================ */

import { profile } from '../lib/model.js';
import { accounts, currentRole, displayName, isSuper, ROLES } from '../lib/auth.js';
import { load, currentUnit } from '../lib/store.js';
import { envUnitTemplate, envUnitSteps } from '../lib/onboard.js';
import { esc, icon, copyText, toast } from '../lib/util.js';
import { go } from '../lib/router.js';
import { pageHead, tabs, noteBoxHtml, kvHtml } from './ui.js';

let section = 'start';
let lang = 'zh';

export function title() { return '教學'; }

const NAV = [
  ['start', '快速開始'],
  ['accounts', '帳戶與權限'],
  ['constitution', '團章'],
  ['finance', '財務（兩條數）'],
  ['daily', '日常點輸入'],
  ['mobile', '手機記帳與通告'],
  ['inventory', '物資與借用'],
  ['birthday', '生日提示'],
  ['progress', '進度紀錄（同一個後端）'],
  ['multiunit', '多旅團部署'],
  ['newunit', '開新旅團（唔使改 Git）'],
  ['tablesync', '插入自己嘅 Sheet 與總表同步'],
  ['backup', '輸出與備份']
];

export function render(params) {
  /* 用戶只需日常教學；多旅團／開新旅團／總表同步只限超管 */
  const userOk = new Set(['start', 'accounts', 'constitution', 'finance', 'daily', 'mobile', 'inventory', 'birthday', 'progress', 'backup']);
  const nav = NAV.filter(([k]) => isSuper() ? (k !== 'newunit' || isSuper()) : userOk.has(k));
  if (params.id === 'newunit' && !isSuper()) section = 'newunit';          // 直接打網址入嚟 → 下面會顯示「只限超管」
  else if (nav.some(([k]) => k === params.id)) section = params.id;
  return `
  ${pageHead({
    title: '使用教學',
    sub: `畀執委、領袖同新接手嘅團員睇 —— 由登入到輸出文件一步一步`,
    actions: `<button class="btn btn-sm" data-act="print">${icon('print', 15)} 列印教學</button>`
  })}
  <div class="grid g-1-2">
    <div class="card no-print" style="align-self:start">
      <div class="card-head"><div class="card-title">目錄</div></div>
      <div style="padding:8px 0">
        ${nav.map(([k, l]) => `<div class="list-item" style="cursor:pointer" data-sec="${esc(k)}">
          <div class="li-main"><div class="li-t sm ${section === k ? 'semibold' : ''}" style="${esc(section === k ? 'color:var(--brand-700)' : '')}">${esc(l)}</div></div>
          ${section === k ? icon('chevronR', 15) : ''}
        </div>`).join('')}
      </div>
      <div style="padding:14px 16px;border-top:1px solid var(--line-2)">
        ${noteBoxHtml(`目前旅團：<b>${esc(profile().name || '')}</b><br>身份：${esc(displayName())}（${esc(ROLES[currentRole()]?.name || '')}）
          `)}
      </div>
    </div>
    <div class="card"><div style="padding:22px 24px" class="guide">${body()}</div></div>
  </div>`;
}

function body() {
  switch (section) {
    case 'accounts': return accountsDoc();
    case 'constitution': return constitutionDoc();
    case 'finance': return financeDoc();
    case 'daily': return dailyDoc();
    case 'mobile': return mobileDoc();
    case 'tablesync': return tablesDoc();
    case 'inventory': return inventoryDoc();
    case 'birthday': return birthdayDoc();
    case 'progress': return progressDoc();
    case 'multiunit': return multiUnitDoc();
    case 'newunit': return isSuper() ? newUnitDoc() : superOnlyDoc();
    case 'backup': return backupDoc();
    default: return startDoc();
  }
}

const H = (t) => `<h3>${esc(t)}</h3>`;
const P = (t) => `<p>${t}</p>`;

function startDoc() {
  return `
  ${H('1. 登入（兩個入口）')}
  ${P('<b>團員同執委同一個門</b>：YMIS（10 位）＋密碼。系統睇名冊身份 —— 執委入管理系統，團員入團員頁。換屆只要改名冊「身份」，唔使另開帳戶。')}
  ${P('<b>領袖</b>用另一個門：電郵＋密碼。新旅團未有領袖帳戶：喺 Apps Script 執行 <code>issueSetupKey()</code>，把 72 小時 KEY 貼上領袖登入頁。')}
  ${P('開戶：名冊有個名嘅團員／執委，首次密碼 <code>1234</code> 就入得（入去要改）；唔喺名冊嘅人可以喺登入頁申請（要執委／領袖批准）。')}
  ${isSuper() ? P('<b>超級管理員</b>係隱藏帳戶，唔會出現喺任何旅團名單。') : ''}
  <div class="steps">
    <div class="step"><div>揀「領袖」或「團員／執委」</div></div>
    <div class="step"><div>領袖填電郵；團員／執委填 YMIS ＋ 密碼</div></div>
    <div class="step"><div>未開戶 → 申請，或者「用戶」頁批准／批量開戶</div></div>
  </div>
  ${H('2. 六個模組')}
  <table class="table table-compact">
    <thead><tr><th>模組</th><th>做咩</th></tr></thead>
    <tbody>
      <tr><td>儀表板</td><td>提示中心（生日／團費／申報／借用／會議行動）、結餘、快況</td></tr>
      <tr><td>會議</td><td>議程、點名、會議記錄、決議行動</td></tr>
      <tr><td>財務</td><td>帳目、過往紀錄、團費、收支申報、活動預算、設定（含匯入舊帳）；年結報告喺頂部</td></tr>
      <tr><td>團員</td><td>名冊、生日表、出席率、個人紀錄</td></tr>
      <tr><td>物資</td><td>物資登記、借用批核（自動加減庫存）、借用單</td></tr>
      <tr><td>團章 / 進度</td><td>團章編輯輸出、讀寫進度紀錄</td></tr>
      <tr><td>資料管理</td><td>總表同步、插入自己嘅 Sheet、儲存與備份（領袖限定）</td></tr>
      <tr><td>系統</td><td>旅團設定、操作紀錄（領袖限定）</td></tr>
    </tbody>
  </table>
`;
}

function accountsDoc() {
  return `
  ${H('帳戶層級')}
  <table class="table table-compact">
    <thead><tr><th>身份</th><th>點登入</th><th>權限跟邊度</th></tr></thead>
    <tbody>
      ${isSuper() ? '<tr><td>超級管理員（隱藏）</td><td>（唔顯示）</td><td>平台維護</td></tr>' : ''}
      <tr><td>領袖</td><td>電郵＋密碼（或開團 KEY）</td><td>領袖帳戶</td></tr>
      <tr><td>執委</td><td>YMIS＋密碼（同團員一個門）</td><td><b>名冊身份</b>（換屆改名冊）</td></tr>
      <tr><td>團員</td><td>YMIS＋密碼</td><td>團員頁（自己進度、連結）</td></tr>
    </tbody>
  </table>
  ${noteBoxHtml('執委唔使每人開「執委帳戶」。名冊剔做執委，下次用同一個 YMIS 入就係管理系統。', 'brand')}
  ${H('開戶')}
  <div class="steps">
    <div class="step"><div>名冊有個名＝已開戶：首次密碼 <code>1234</code>，第一次登入要改</div></div>
    <div class="step"><div>唔喺名冊嘅人：登入頁申請，或者「用戶」頁批量開戶／批准</div></div>
    <div class="step"><div>領袖：喺「用戶」填電郵＋入口密碼，就用電郵喺「領袖」入口登入（唔使另開帳戶）</div></div>
  </div>
  ${H('改密碼')}
  ${P('登入後頂部鎖匙，或者「系統 → 自己改密碼」。')}`;
}

function constitutionDoc() {
  const c = load().constitution;
  return `
  ${H('內建團章')}
  ${P(`現時版本 <b>v${esc(c.version || '')}</b>，${(c.chapters || []).length} 章，中英對照。`)}
  ${H('睇／改／發布')}
  <div class="steps">
    <div class="step"><div>右上角切換 <b>中文 / English / 中英對照</b></div></div>
    <div class="step"><div>有團章編輯權先可以改章節、條文同子項；發布權再獨立核對</div></div>
    <div class="step"><div>發布後撳「儲存到後端」，團員入口只會投影已發布版本</div></div>
  </div>
  ${H('輸出')}
  ${P('Word、PDF、Markdown、HTML 同 JSON 都係管理者下載的文件／備份；下載檔本身唔係匿名發布機制，唔應上載去公開網站。')}
  ${H('QR Code 畀團員睇')}
  ${P(`QR 指向 <code>members.html?u=${esc(currentUnit())}#/constitution</code>。成員掃描後仍要用本團個人身份登入；後端核實 session 先回已發布團章。QR 本身唔係閱讀憑證。`)}`;
}

function financeDoc() {
  return `
  ${H('兩條數：點解')}
  ${P(`<b>旅團（童軍）財政年度</b>：每年 4 月 1 日至 3 月 31 日。<br>
        <b>旅財政年度</b>：由當年 AGM 起計，到下一年 AGM 前一日（本團多數喺暑假開 AGM）。`)}
  ${P('所以同一批帳目會有兩個結論。系統內建兩個引擎，喺「財務 → 年結報告」可以：')}
  <ul>
    <li>分別揀年度，同時見到 <b>期初結餘 → 收入 → 支出 → 淨額 → 期末結餘</b></li>
    <li>「兩條數對照」一表睇齊兩個制嘅結果</li>
    <li>輸出 Word／PDF：可以一份文件同時載兩份報告（AGM 用），亦可以只出一份</li>
  </ul>
  ${noteBoxHtml(`<b>AGM 日期每年都唔同</b>：喺「財務 → 年結報告 → 逐年輸入 AGM 日期」逐年填。
    未填／未確認嘅年份會標示「未確認」，報告頁同儀表板都會提醒你；確認之後報告就用你填嘅日期起計。`, 'info')}
  ${H('日常記帳')}
  <div class="steps">
    <div class="step"><div>「財務 → 新增收支」填類型、金額、日期、項目、方式</div></div>
    <div class="step"><div>勾「已收到單據」方便日後查帳</div></div>
    <div class="step"><div>需要時用月份／類型／分類／關鍵字篩選，再輸出一份</div></div>
  </div>
  ${H('取代 Google Form：收支申報')}
  ${P('同團員講：「要 claim 錢，入 82venture → 財務 → 收支申報 → 我要申報」。提交後會入「待批核」，司庫或領袖按「批准並入帳」就會<b>自動加入帳目</b>，唔使再 copy 去 Google Sheet。')}
  ${H('舊帳匯入')}
  ${P('「財務 → 匯入」有兩個方法：① 喺 Google Sheet 選取範圍複製，直接貼落去（Tab 分隔）；② 「檔案 → 下載 → 逗號分隔值 (.csv)」，再用「上載 CSV 檔」。')}
  ${P('支援你原本嗰種 <b>Google Form 格式</b>：<code>時間戳記 / 日期 / 收入或支出 / 收入項目 / 支出項目 / 收入 / 支出 / 結餘 / 上載單據 / 付款人 / 備註</code>。')}
  <ul>
    <li>收入／支出兩欄分開嘅寫法都會自動對位</li>
    <li>「上載單據」嘅 Drive 連結會保留喺帳目（勾「保留單據連結」）</li>
    <li>表底嘅 <b>總結行</b>（上年度結餘 / 本年度收入 / 總計支出 / 結餘）唔會當成交易，系統會用嚟<b>對數</b></li>
    <li>「20XX 年度結餘」會自動認做<b>期初結餘</b>，匯入時可以一齊寫入年度設定</li>
    <li>「付款人」寫花名都認得出團員（例：<b>大文</b> → 陳大文），團費會自動標記已收</li>
  </ul>
  ${P('系統會自動辨認欄位（日期／類型／項目／金額／分類／方式／經手人／備註），支援引號欄位、<code>HK$</code>、千分位、負數，亦會跳過「BAD deb」呢類標題行；確認預覽數字無誤先按「確認匯入」。')}
  ${H('團費（金額可改，唔係寫死）')}
  ${P('「財務 → 團費」有一張<b>收款表</b>：每位團員一行，一眼睇齊邊個交咗、幾時交、用咩方式、單號、入咗帳未。')}
  <ul>
    <li><b>團費金額設定</b>：改標準團費（例：$360 → $400）、海外／優惠團費（例：$90）、預設到期日；
      可以同時更新「未收」紀錄（已收嘅唔會亂改）</li>
    <li><b>逐個團員改金額</b>：收款表每行嘅 ✎，可以打自訂金額，亦有快捷（標準／海外／按月／半年），
      例：6 月入團收半年 $180、海外團員 $90</li>
    <li>新年度按「<b>開新年度團費</b>」一次過建立（每人金額可以逐行改；同年度唔會重複）</li>
    <li>有人交錢 → 按「<b>標記已收</b>」填<b>收到金額</b>／日期／方式／收據號 → <b>同時自動入帳</b>
      （金額改過嘅話，已連結嘅帳目會一齊更新）</li>
    <li>按錯 → 「<b>取消收款</b>」會改回未收，相關帳目一齊撤銷</li>
    <li>🖨 可以直接列印<b>團費收據</b>；「複製催繳名單」可以貼落 WhatsApp</li>
    <li>期別跟童軍年度（2026 年 9 月收嘅係 <code>2026-27</code>）；中途入團自己改成按月金額</li>
  </ul>
  ${noteBoxHtml('想睇完整日常流程（連月結／年結步驟）：去「教學 → <b>日常點輸入</b>」，或者睇 repo 內 <code>docs/DAILY_ENTRY.md</code>（可以列印貼喺會議室）。', 'brand')}`;
}

function dailyDoc() {
  return `
  ${H('一句話：三種入法，睇你手上有咩')}
  <div class="scroll-x"><table class="table">
    <thead><tr><th>情況</th><th>用邊個入口</th><th>要填幾多樣</th></tr></thead>
    <tbody>
      <tr><td>有人交錢 / 買嘢收入</td><td><b>財務 → 新增收支 → 收入</b></td><td>金額、日期、項目（例：團費／活動費）</td></tr>
      <tr><td>你墊支買咗嘢</td><td><b>財務 → 收支申報 → 我要申報</b></td><td>金額、日期、項目、分類（等批核後自動入帳）</td></tr>
      <tr><td>開完會 / 活動後一次過補</td><td><b>財務 → 匯入</b>（貼上或上載 CSV）</td><td>一段表：日期、類型、項目、金額</td></tr>
      <tr><td>收團費</td><td><b>財務 → 團費</b>（收款表）</td><td>喺團員一行按「標記已收」→ 自動入帳</td></tr>
      <tr><td><b>成員個人交單</b></td><td><b>暫停</b></td><td>舊匿名 entry.html 已刪；等 session-bound 個人 action 完成先開放</td></tr>
    </tbody>
  </table></div>

  ${H('最常用：30 秒記一筆')}
  <div class="steps">
    <div class="step"><div>財務 → 右上「<b>+ 新增收支</b>」</div></div>
    <div class="step"><div>揀 <b>收入 / 支出</b> → 打<b>金額</b>（用數字就得，唔使打 HK$）</div></div>
    <div class="step"><div><b>日期</b>已經自動填今日（要改就改）</div></div>
    <div class="step"><div><b>項目</b>寫清楚少少：例「全團大會場地租金」、「12/7 partyroom」、「曉莉 團費」</div></div>
    <div class="step"><div>揀<b>分類</b>同<b>方式</b>；有單據就勾「已收到單據」，填單號</div></div>
    <div class="step"><div>按「新增帳目」。完 —— 結餘即刻更新，月結／年結自動計</div></div>
  </div>
  ${noteBoxHtml('記帳三句真言：<b>分類要一致</b>（同一個意思用同一個分類，年結才靚）、<b>項目寫得具體</b>（三個月後你自己都睇得明）、<b>單據影相／編號</b>（有單冇單，一查就知）。', 'brand')}

  ${H('團費：金額可以年年改，記錄邊個交咗')}
  ${P('「財務 → 團費」有一張<b>收款表</b>：每位團員一行，一眼睇齊邊個交咗、幾時交、用咩方式交、單號幾多。')}
  <div class="steps">
    <div class="step"><div><b>銀碼跟團章預設 $360，但可以隨時改</b>：按「<b>金額設定</b>」改標準團費、海外團員（1/4）、按月（新入團）、繳費期限 → 套用到全團</div></div>
    <div class="step"><div>個別團員金額唔同（例如中途入團 $180）：喺佢一行按 <b>✎</b> 直接改銀碼</div></div>
    <div class="step"><div>新年度開始：按「<b>開新年度團費</b>」→ 為所有現役團員一次過建立紀錄（會用你設定嘅金額）</div></div>
    <div class="step"><div>有人交錢：喺佢一行按「<b>標記已收</b>」→ 填日期、方式、收據號 → 系統<b>同時自動入帳</b>（唔使入兩次）</div></div>
    <div class="step"><div>按錯咗：按「<b>取消收款</b>」→ 紀錄改回未收，相關帳目一齊撤銷</div></div>
    <div class="step"><div>要收據：按 🖨 → 即刻列印／存 PDF（有司庫簽署位）</div></div>
    <div class="step"><div>追人：「<b>複製催繳名單</b>」→ 直接貼落 WhatsApp 群；或者輸出收款表 Word 貼堂</div></div>
  </div>
  ${noteBoxHtml(`<b>新入團按月計</b>（跟團章第 8 條）：如果中途入團，按「建立 $360」之後再改成實際金額（例如 6 個月 = $180）就得。<br>
    海外團員收 1/4（$90）。`, 'info')}

  ${H('月結（每月 5 分鐘）')}
  <div class="steps">
    <div class="step"><div>財務 → 帳目：篩選月份，睇下收入／支出合計</div></div>
    <div class="step"><div>睇「未收團費」同「待批核申報」，跟一跟</div></div>
    <div class="step"><div>輸出 Word／PDF 一份畀領袖存檔（或者貼上群組）</div></div>
  </div>

  ${H('年結（AGM 前）')}
  <div class="steps">
    <div class="step"><div>財務 → 年結報告 → 揀「旅財政年度（AGM 起計）」</div></div>
    <div class="step"><div>逐年確認 AGM 日期（未確認會有黃色提示）</div></div>
    <div class="step"><div>按「Word（兩份報告一份文件）」或「PDF」→ 就有齊期初、收入、支出、淨額、期末結餘</div></div>
    <div class="step"><div>同時出「童軍年度（4/1–3/31）」嗰份交總會／存檔</div></div>
  </div>

  ${H('由 Google Sheet 搬舊帳（一次過）')}
  <div class="steps">
    <div class="step"><div>Google Sheet → <b>檔案 → 下載 → 逗號分隔值 (.csv)</b></div></div>
    <div class="step"><div>82venture → 財務 → 匯入 → <b>上載 CSV 檔</b>（或者喺 Sheet 選取範圍 Ctrl+C，貼落個格）</div></div>
    <div class="step"><div>睇預覽（讀到幾多筆、收入／支出合計、認得出邊幾位交咗團費）</div></div>
    <div class="step"><div>按「確認匯入」→ 帳目同團費紀錄一齊建立；錯嘅可以逐筆刪</div></div>
  </div>
  ${noteBoxHtml('欄位名可以照用你原本嘅中文字：日期 / 類型（收入、支出）/ 項目 / 金額 / 分類 / 方式 / 經手人（負責人）/ 年度 / 團費（打 ✓ 或寫團員名）/ 備註。系統會自動對位，唔需要改格式。', 'info')}

  ${H('想印出嚟貼喺房？')}
  ${P('呢一頁可以按瀏覽器「列印」存成 PDF，貼喺物資房／會議室；或者喺「財務 → 匯入」下載空白範本 CSV，跟住格式填就得。')}`;
}

function mobileDoc() {
  return `
  ${H('團員入口：一條登入 QR')}
  ${P('只派 <code>members.html?u=旅團編號</code>。QR 只帶用戶去登入頁；後端用 opaque session 對回本團個人身份，再按身份層級投影活動、試卷、通告同已發布團章。')}
  ${noteBoxHtml('<b>匿名入口已刪除：</b><code>entry.html</code>、<code>borrow.html</code>、<code>notice.html</code>、<code>constitution.html</code> 舊網址只會轉去團員登入入口；後端亦唔再接受匿名 claim／loan／noticeSignup／notices／constitution action。', 'brand')}
  ${H('通告分享同報名')}
  <div class="steps">
    <div class="step"><div>通告 → 開新通告 → 選擇「邊個睇到」（只列本支部已登入身份）</div></div>
    <div class="step"><div>發布後可複製登入連結、WhatsApp 文字或 QR；連結保留指定通告路線</div></div>
    <div class="step"><div>成員登入後先收到通告全文；報名回覆由 server session 綁定本人，唔採用前端自報身份</div></div>
    <div class="step"><div>行政介面「通告 → 報名紀錄」睇名單、輸出 CSV／Word 或列印</div></div>
  </div>
  ${H('收支申報／物資借用')}
  ${P('舊匿名手機表已停用。目前收支申報只可在已登入行政介面使用；團員個人申報／借用要等專用 session-bound action 完成先重新開放，唔會退回「填姓名就當本人」的做法。')}
  ${H('常見問題')}
  ${P('<b>可唔可以把 QR 當公開頁？</b>唔可以。未登入者只見登入閘；身份、可見範圍同寫入對象全部由後端核實。')}
  ${P('<b>跨支部資料點分享？</b>唔用匿名網址。要經來源支部批准整個資料包、接收支部接受、再由接收支部授權本地身份三道獨立門。')}`;
}

function tablesDoc() {
  return `
  ${H('一句話：成個系統就係一張大表，欄位自己話事')}
  ${P('想改欄位就去<b>嗰個分頁</b>按「<b>欄位</b>」掣（財務／用戶／物資／通告／會議 都有）：可以改名、加欄、改類型、隱藏、排次序 —— 好似內建一個 Google Sheet。進階嘅「插入自己嘅 Sheet」同「總表同步」喺「<b>資料管理</b>」。')}

  ${H('① 改欄位（改名／加減）')}
  <div class="steps">
    <div class="step"><div>去嗰個分頁（例：財務 → 帳目）→ 按右上「欄位」→ 見到一行行欄位</div></div>
    <div class="step"><div><b>改名</b>：直接把「經手人」改成「負責人」，全 APP 顯示即時跟住（資料唔會亂）</div></div>
    <div class="step"><div><b>加欄位</b>：按「加欄位」→ 填名稱、揀類型（文字／數字／日期／下拉／相片…）；下拉可以填選項（用「、」分隔）</div></div>
    <div class="step"><div><b>必填／顯示</b>：可以剔「必填」，或者收起一啲唔用嘅欄（例如「單據號碼」）</div></div>
    <div class="step"><div><b>刪除／排序</b>：用 ↑ ↓ 排位，🗑 刪欄位（只係唔再顯示，舊資料仍然保留喺備份）</div></div>
    <div class="step"><div>搞亂咗？按「<b>還原預設</b>」一鍵返原廠</div></div>
  </div>

  ${H('② 插入其他旅團／自己嘅 Google Sheet')}
  ${P('如果旅團本身已經有一張帳目表或者物資表，唔需要重新入過：')}
  <div class="steps">
    <div class="step"><div>Google Sheet → 共用 → 改為「<b>知道連結嘅任何人均可檢視</b>」（只讀）</div></div>
    <div class="step"><div>資料管理 → <b>插入自己嘅 Sheet</b> → 貼上連結（記得帶 <code>gid=</code>，即係你停留嘅分頁）</div></div>
    <div class="step"><div>按「讀取欄位」→ 系統自動幫你對應（日期→日期、金額→金額、付款人→經手人…）</div></div>
    <div class="step"><div>對應唔啱就逐個下拉改；可以剔「匯入前清空該表」避免重複</div></div>
    <div class="step"><div>按「匯入」→ 有預覽筆數；之後可以「儲存做同步來源」，隨時再按「同步」拉最新版本</div></div>
  </div>
  ${noteBoxHtml('冇公開連結都可以：喺 Sheet 選取範圍 → Ctrl+C → 按「改為貼上 CSV」照樣讀得到。', 'info')}

  ${H('③ Portal 接入旅團既有 BADGE 後端（目前未開通）')}
  ${P('產品目標係 Portal 完整版與 BADGE 前端沿用<b>同一個旅團既有 BADGE <code>/exec</code>、API Key、Sheet、Users 帳戶及業務資料</b>。不得為 Portal 新建 Sheet／Apps Script、第二帳戶表或另一資料來源；亦不得複製／搬移帳戶。')}
  ${noteBoxHtml('<b>正式共用 action contract 與真 Apps Script staging 尚未完成。</b>裸 BADGE v9.6 的 <code>login</code>／<code>token</code> 及帳戶 actions，與 Portal 的 <code>authLogin</code>／<code>authWhoAmI</code>／<code>authOpenAccounts</code> 不直接相容。只登記 URL／Key 或看到 <code>backendReady</code>，都不代表 Portal 已接通。', 'warn')}
  <div class="steps">
    <div class="step"><div>團方只提供目前 BADGE 正式 <code>/exec</code>、同一 deployment 的 API Key、旅團資料及聯絡方式；不要開新 Sheet／GAS 或執行測試初始化。</div></div>
    <div class="step"><div>Admin 先完成並核對正式 BADGE／Portal 共用 action contract，確認同一 BADGE <code>Users</code> 是唯一身份、密碼與權限權威。</div></div>
    <div class="step"><div>在核准的真實 Apps Script staging 驗證同一帳戶雙向登入、帳戶／角色／狀態更新、Progress 讀寫、資料保留及回退；VM／mock 不計 staging。</div></div>
    <div class="step"><div>只有正式 staging 全部通過後，Admin 才把既有 BADGE 的 <code>TROOP_&lt;ID&gt;_NAME／BACKEND／APIKEY</code> 登記至 Vercel 並 Redeploy。</div></div>
  </div>
  ${P('Unified Code.gs 與 <code>apps-script/unified-src/</code> 只供隔離測試，不能貼入正式 BADGE Sheet、不能用來建第二個後端。正式驗收狀態見 <code>docs/UNIFIED_STAGING_RESULTS.md</code>；目前所有正式項目仍為 <code>NOT RUN</code>。')}

  ${H('④ 儲存與備份')}
  ${P('所有資料存喺<b>你自己嘅瀏覽器</b>（localStorage，大約 5MB）。相片最佔位，所以：')}
  <div class="steps">
    <div class="step"><div>「儲存與備份」頁見到用量條；相片會自動壓縮（最長邊 1400px）</div></div>
    <div class="step"><div>唔夠位：按「清理已入帳嘅相片（保留記錄）」（帳目仍然保留「有單據」標記）</div></div>
    <div class="step"><div>長遠：設定總表同步，或者去「資料管理」匯出 JSON 備份／匯出 CSV</div></div>
  </div>`;
}

function inventoryDoc() {
  return `
  ${H('登記物資')}
  ${P('「物資 → 新增物資」填名稱、編號、分類、總數量、單位、存放位置、狀況。')}
  ${H('借用流程（自動加減庫存）')}
  <div class="steps">
    <div class="step"><div>任何已登入帳戶按「申請借用」：揀物資、數量、借用人、借出／應還日期、用途</div></div>
    <div class="step"><div><b>任何已登入帳戶都可以批核</b>：按「批准」或「拒絕」</div></div>
    <div class="step"><div>取走物資時按「已取走」→ 系統自動 <b>−庫存</b></div></div>
    <div class="step"><div>歸還時按「已歸還」→ 系統自動 <b>＋庫存</b></div></div>
  </div>
  ${noteBoxHtml('可用數量＝登記總數 ＋ 盤點調整 − 未歸還借用。因為係即時由紀錄推算，唔會出現「加減錯數」。', 'brand')}
  ${H('盤點')}
  ${P('每次活動前後去「盤點紀錄 → 新增盤點」，填 −1／+2 同原因（損耗、遺失、新購），庫存就會跟住調整，並且有紀錄可查。')}
  ${H('輸出')}
  ${P('可以輸出物資清單（Word）、借用紀錄（Word）、單一借用單（可列印簽名，含 QR Code），亦有空白借用單可以印出嚟即場填。')}`;
}

function birthdayDoc() {
  return `
  ${H('生日資料')}
  ${P('「團員 → 編輯」可以填出生日期。支援兩種寫法：')}
  <ul>
    <li><code>2010-03-26</code>（完整日期，會顯示年齡／將滿歲數）</li>
    <li><code>03-26</code>（只知道月日，年齡欄顯示「—」）</li>
  </ul>
  ${H('提示位置')}
  <ul>
    <li><b>儀表板 → 生日提示</b>：今日生日 → 顯示「今日生日 🎂」</li>
    <li><b>生日前 7 日</b>：自動列出「X 位團員生日快到」（你可喺 unit.json 改 remindDaysBefore）</li>
    <li><b>本月生日</b>：儀表板同「團員 → 生日表」都有</li>
    <li><b>名冊</b>：生日 7 日內會喺該行顯示提示</li>
  </ul>
  ${H('輸出')}
  ${P('「團員 → 生日表」可以輸出 Word／PDF／CSV，仲可以匯出 <code>.ics</code> 加入 Google Calendar / iPhone 日曆（每年自動重複）。')}`;
}

function progressDoc() {
  const unit = currentUnit() || '0082';
  return `
  ${H('Progress 前端與 BADGE 共用後端')}
  ${P('產品目標係<b>一個旅團、一個既有 BADGE 後端、一套帳戶</b>；vs_portal 提供完整管理前端，vsbadge 提供較輕前端。Portal 的 Progress 經同源 <code>/api/progress</code> 代理，不能另選 GAS、Sheet 或帳戶來源。')}
  ${noteBoxHtml('<b>正式共用後端尚未完成驗收。</b>Registry 登記和 <code>backendReady</code> 只代表 URL／Key 設定存在，唔代表 GAS 支援 Portal 全部 actions。裸 BADGE v9.6 的 action names 同 Portal auth contract 不同；Unified bundle 目前只供隔離測試。詳見 <code>docs/BACKEND_SYNC.md</code>。', 'warn')}
  ${noteBoxHtml('瀏覽器不保存後端網址或 API Key；Progress 頁不接受第二個 backend。API Key 只作 server routing／用途分隔 HMAC 根，<b>不等於用戶身份</b>；每個 action 仍須由 server session、role、scope 及 allowlist 授權。', 'brand')}

  ${H('Admin 登記的 Registry 欄位')}
  <pre class="code">TROOP_${esc(unit)}_NAME
TROOP_${esc(unit)}_BACKEND
TROOP_${esc(unit)}_APIKEY</pre>
  <ul style="padding-left:18px;line-height:1.9" class="sm">
    <li><code>NAME</code>：旅團顯示名稱</li>
    <li><code>BACKEND</code>：團方提供的既有 BADGE 正式 <code>/exec</code>；只有共用 contract 通過驗收才可啟用 Portal</li>
    <li><code>APIKEY</code>：同一既有 deployment 的 API Key；只留 server</li>
  </ul>
  ${noteBoxHtml('Admin 登記後要 Redeploy。不要建立新 Sheet/GAS、第二帳戶表或搬移帳戶；亦不要設定 <code>PROGRESSBACKEND</code>／<code>PROGRESSAPIKEY</code>。', 'info')}

  ${H('讀寫與批核')}
  <ul style="padding-left:18px;line-height:1.9" class="sm">
    <li><b>目標讀取</b>：staff session 可讀獲授權資料；團員只讀 session 限定的本人資料</li>
    <li><b>目標寫入</b>：<code>save</code>／<code>saveOtherBadge</code> 等 BADGE action 由既有共用 GAS 授權</li>
    <li><b>目標批核</b>：<code>reviewRequest</code>／<code>reviewLogRequest</code> 必須寫回同一旅團後端</li>
  </ul>

  ${H('考核項目定義')}
  ${P('第 11 版綱要已內建在 <code>data/progress/items.json</code>，離線可用；它是靜態目錄，不是第二個資料後端。')}

  ${H('身份對應')}
  ${P('兩個前端必須以同一 BADGE 使用者與 YMIS 對人；帳戶及密碼只由既有 BADGE Users 管理。真實跨前端登入、開戶及資料讀回驗收完成前，不應宣稱 Portal 已開通。')}`;
}

/* 管理員接線：只登記團方既有 BADGE backend，不建立第二資料來源。 */
function adminGitSteps() {
  return `
  ${H('Admin 接線：登記既有 BADGE backend')}
  <div class="steps">
    <div class="step"><div>先核實團方提供的既有 <b>BADGE <code>/exec</code> 與同一 deployment 的 API Key</b>；不新建 Sheet/GAS，不複製或搬移帳戶</div></div>
    <div class="step"><div>確認正式共用後端 action contract 已部署並通過真實 staging；裸 BADGE v9.6 的 <code>login</code>／<code>bulkAddUsers</code> 與 Portal auth actions 並不直接相容</div></div>
    <div class="step"><div>通過相容性驗收後，才在 Vercel 登記 <code>TROOP_&lt;ID&gt;_NAME／BACKEND／APIKEY</code>，選對環境並 Redeploy</div></div>
    <div class="step"><div><code>backendReady</code> 只表示 Registry URL／Key 存在；還要用同一 BADGE Users 帳戶驗證兩個前端登入、開戶與資料讀回</div></div>
  </div>
  ${P('<span class="xs faint">逐項契約與待驗收邊界：見 <code>docs/BACKEND_SYNC.md</code>。申請只送固定 ADMIN 收件匣，不會自動修改 Vercel Registry。</span>')}`;
}

/* Portal 接入既有 BADGE 後端；不建立空白旅團資料庫。 */
function multiUnitOnboardSteps() {
  return `
  ${H('Portal 點樣接入既有 BADGE？')}
  ${P('Portal 與 BADGE 目標係共用同一旅團既有後端、BADGE Users 帳戶與資料，不是每個前端各建 Sheet／GAS。')}
  <div class="steps">
    <div class="step"><div>團方提供目前 BADGE 正式 <code>/exec</code> 與該 deployment 的 API Key</div></div>
    <div class="step"><div>經登入前旅團閘提交「申請 Portal 接入」；申請只到固定 ADMIN 收件匣，不會自動寫 Registry</div></div>
    <div class="step"><div>Admin 核對正式共用 action contract，確認同一 BADGE Users／Sheet 可服務 Portal 與 BADGE</div></div>
    <div class="step"><div>驗收通過後 Admin 才登記 Vercel <code>NAME／BACKEND／APIKEY</code>，並 Redeploy</div></div>
    <div class="step"><div>用同一既有帳戶測試兩個前端登入、批次開戶、角色／狀態變更及資料讀回</div></div>
  </div>
  ${noteBoxHtml('目前 Portal 使用的 <code>authLogin</code>／<code>authWhoAmI</code>／<code>authOpenAccounts</code> 不等同裸 BADGE v9.6 的 action contract；Unified adapter 僅為隔離測試用途。未有正式 staging 通過前，接線仍屬未完成。', 'warn')}`;
}

/* 非超管指向既有後端申請流程。 */
function multiUnitOnboardNote() {
  return `
  ${H('Portal 接入既有 BADGE 後端')}
  ${noteBoxHtml('請把既有 BADGE <code>/exec</code> 與 API Key 交畀超級管理員核對；不用新建 Sheet／GAS，也不會另建或搬移帳戶。'
    + '正式共用 action contract 驗收後，Admin 才登記 <code>TROOP_&lt;編號&gt;_*</code>。申請收件或 <code>backendReady</code> 都不是功能已啟用的證明。', 'info')}`;
}

function multiUnitDoc() {
  return `
  ${H('多旅團 Registry 與既有 BADGE 後端')}
  <pre><code>Portal Vercel Registry
  TROOP_&lt;ID&gt;_NAME
  TROOP_&lt;ID&gt;_BACKEND  ──→ 既有 BADGE Apps Script /exec
  TROOP_&lt;ID&gt;_APIKEY   ──→ 同一 BADGE deployment 的 Key
                                 │
                                 └── BADGE Users／名冊／業務資料</code></pre>
  ${isSuper() ? multiUnitOnboardSteps() : multiUnitOnboardNote()}
  ${isSuper() ? adminGitSteps() : ''}
  ${H('資料與身份')}
  ${P('每個旅團的 Badge Users、YMIS 名冊、BADGE 業務資料仍以旅團原有後端為權威；Portal 僅以 server-side Registry 代理獲授權 action。不得為 Portal 建第二帳戶表、搬移／複製帳戶或另建資料來源。正式整合尚須完成真實後端 action 與權限驗收。')}
  ${H('權限')}
  ${P('Portal action 需由既有共用 GAS 以有效 BADGE 身份及伺服器授權檢查；UI 顯示、Registry 設定或 API Key 本身都不是使用者權限。')}`;
}

/* ============================================================
   Admin 開通 Portal 至既有 BADGE 後端
   ============================================================ */
function superOnlyDoc() {
  return `
  ${H('Admin 接入既有 BADGE 後端')}
  ${P('<b>詳細登記步驟只限超級管理員。</b>')}
  ${noteBoxHtml('這不是新建旅團資料庫流程。團方提供目前 BADGE 使用的 <code>/exec</code> 與 API Key；Portal 要沿用既有 BADGE Users、名冊及資料，不另建 Sheet/GAS、帳戶或資料來源。', 'warn')}
  ${P('先核實正式共用 action contract 及權限，再登記 Vercel Registry。裸 BADGE v9.6 與 Portal auth actions 尚不直接相容；詳見 <code>docs/BACKEND_SYNC.md</code>。')}
  ${P('一般使用教學：<b>快速開始</b>、<b>Progress 與 BADGE 共用後端</b>、<b>財務</b>、<b>日常點輸入</b>。')}`;
}

function newUnitDoc() {
  return `
  ${H('Admin：為既有 BADGE 後端登記 Portal')}
  ${P('情境：團方已在使用 BADGE，要求 Portal 完整版共用<b>同一既有後端、同一批帳戶及資料</b>。不得為 Portal 建新 Sheet／GAS、複製帳戶或要求搬資料。')}
  ${noteBoxHtml('目前 Portal 會呼叫 <code>authLogin</code>／<code>authWhoAmI</code>／<code>authOpenAccounts</code>；裸 BADGE v9.6 原生契約為 <code>login</code>／<code>addUser</code>／<code>bulkAddUsers</code> 等。只登記既有 URL／Key 未能補上 action adapter；Unified bundle 只是隔離測試。', 'warn')}

  ${H('第 1 步：核實團方提交資料')}
  <ul class="sm" style="padding-left:18px;line-height:1.9">
    <li>核對旅團 ID／名稱、正在使用的 BADGE 正式 <code>/exec</code>、同一 deployment API Key 及目前 BADGE 版本</li>
    <li>確認要求中沒有新建 Sheet／GAS、建立第二帳戶表、匯入／搬移帳戶或另設資料來源</li>
    <li>申請會由同源 <code>/api/proxy</code> 送到固定 ADMIN 收件匣；它不會自動寫 Registry</li>
  </ul>

  ${H('第 2 步：先完成正式相容性驗收')}
  <div class="steps">
    <div class="step"><div>在正式共用 GAS action contract 中保留 BADGE 原生登入與帳戶管理，並提供 Portal 所需身份／開戶 action</div></div>
    <div class="step"><div>身份、密碼、YMIS、角色／狀態以既有 BADGE <code>Users</code>／Sheet 為唯一權威；不要用 Portal <code>accounts[].pw</code> 另建身份</div></div>
    <div class="step"><div>用真實既有測試 Sheet／Apps Script deployment 驗證 BADGE 與 Portal 登入、批次開戶、角色變更、停用及彼此讀回</div></div>
    <div class="step"><div>核實 proxy 只用伺服器 Registry URL／Key，action allowlist 與 session/role/scope 都在服務端限制；Unified VM 測試不能取代 staging</div></div>
  </div>
  ${P('<span class="xs faint">正式 source、升級／回退步驟及 upstream 對照：見 <code>docs/BACKEND_SYNC.md</code>。未完成 staging 前不要標記已開通。</span>')}

  ${H('第 3 步：登記 Vercel Registry（驗收通過後）')}
  <div class="card"><div style="padding:16px 18px">
    <div class="grid g-2" style="gap:12px">
      <div class="field"><label class="label">旅團編號</label><input class="input" id="nu-code" placeholder="例：0081" value="0081"></div>
      <div class="field"><label class="label">旅團名稱</label><input class="input" id="nu-name" placeholder="例：第八十一旅深資童軍團"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">既有 BADGE /exec</label><input class="input" id="nu-exec" placeholder="https://script.google.com/macros/s/…/exec"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">同一 BADGE deployment API Key</label><input class="input" id="nu-key" placeholder="團方提供的既有 Key"></div>
    </div>
    <div class="row gap-8 wrap mt-12">
      <button class="btn btn-primary" data-act="gen-env">${icon('refresh', 15)} 產生</button>
      <button class="btn" data-act="copy-env">${icon('copy', 15)} 複製環境變數</button>
      <button class="btn" data-act="copy-steps">${icon('copy', 15)} 複製逐步指示</button>
    </div>
    <pre class="code mt-12" id="nu-out">${esc(envUnitTemplate('0081'))}</pre>
    <div class="hint">只在正式共用 contract 通過驗收後，將三個變數加入正確的 Vercel project/environment；不要把 Key 放入 Git 或送到 browser。</div>
  </div></div>
  <div class="steps">${envUnitSteps('0081').map(x => `<div class="step"><div>${esc(x)}</div></div>`).join('')}</div>

  ${H('第 4 步：開通後驗收')}
  <ul style="padding-left:18px;line-height:1.95" class="sm">
    <li>□ Vercel 環境變數來自同一既有 BADGE deployment，Redeploy 完成</li>
    <li>□ /api/units 隱藏 URL／Key；backendReady 不當作相容性證明</li>
    <li>□ 同一 BADGE 使用者可在 BADGE 與 Portal 登入，YMIS／角色一致</li>
    <li>□ 任一前端開戶／停用／角色更新後，另一前端讀回同一 Users 資料</li>
    <li>□ Portal 與 BADGE 讀寫同一旅團業務資料；沒有第二 Sheet、GAS、帳戶表或資料來源</li>
  </ul>
  ${P('<span class="xs faint">若需要公開旅團名稱，可以選擇只在 <code>data/units.json</code> 加公開 metadata；不得放 backend／apiKey 或私人業務資料。</span>')}
  `;
}

function backupDoc() {
  return `
  ${H('可以輸出咩')}
  <table class="table table-compact">
    <thead><tr><th>位置</th><th>格式</th></tr></thead>
    <tbody>
      <tr><td>團章</td><td>Word、PDF、Markdown、單一 HTML、JSON、QR Code（SVG）</td></tr>
      <tr><td>財務</td><td>雙年度報告（Word / PDF）、逐筆帳目（CSV / Word / PDF）、團費（Word / CSV）</td></tr>
      <tr><td>團員／生日</td><td>名冊（CSV / Word）、生日表（Word / PDF / CSV / .ics 日曆）</td></tr>
      <tr><td>物資</td><td>物資清單（Word）、借用紀錄（Word）、借用單（PDF 列印）</td></tr>
      <tr><td>全站備份</td><td>JSON（資料管理）</td></tr>
    </tbody>
  </table>
  ${H('備份（重要）')}
  ${P('本系統係純前端，資料存喺你嘅瀏覽器（localStorage）。所以：')}
  <ul>
    <li>每次開完會／記完帳 → 「資料管理 → 匯出全部資料（JSON）」</li>
    <li>備份放落旅團共用雲端（Google Drive / OneDrive）</li>
    <li>換電腦或換瀏覽器：先匯出，再喺新機「匯入備份」</li>
    <li>想多人同時用：把 repo 部署上網（GitHub Pages / Vercel），每人用自己帳號登入（但資料仍以每部機為單位，建議由司庫統一記帳）</li>
  </ul>
  ${H('PDF 提示')}
  ${P('所有 PDF 都係用瀏覽器列印功能：按「PDF」→ 喺列印視窗嘅目的地揀「另存為 PDF」。')}`;
}

export function mount(root) {
  root.querySelectorAll('[data-sec]').forEach(el => el.addEventListener('click', () => {
    section = el.dataset.sec;
    refresh();
  }));
  root.querySelectorAll('[data-act="print"]').forEach(b => b.addEventListener('click', () => window.print()));
  /* 開新旅團：產生／複製環境變數 */
  const nu = {
    code: () => root.querySelector('#nu-code')?.value.trim() || '0081',
    name: () => root.querySelector('#nu-name')?.value.trim() || '',
    exec: () => root.querySelector('#nu-exec')?.value.trim() || '',
    key: () => root.querySelector('#nu-key')?.value.trim() || ''
  };
  const out = () => root.querySelector('#nu-out');
  const paintNu = () => {
    const el = out();
    if (el) el.textContent = envUnitTemplate(nu.code(), nu.name(), nu.exec(), nu.key());
  };
  ['#nu-code', '#nu-name', '#nu-exec', '#nu-key'].forEach(sel => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener('input', paintNu);
  });
  root.querySelector('[data-act="gen-env"]')?.addEventListener('click', () => { paintNu(); toast('已更新範本', 'ok'); });
  root.querySelector('[data-act="copy-env"]')?.addEventListener('click', async () => {
    paintNu();
    const ok = await copyText(envUnitTemplate(nu.code(), nu.name(), nu.exec(), nu.key()));
    toast(ok ? '已複製環境變數 —— 貼落 Vercel → Settings → Environment Variables' : '複製失敗，請手動選取', ok ? 'ok' : 'err');
  });
  root.querySelector('[data-act="copy-steps"]')?.addEventListener('click', async () => {
    const ok = await copyText(envUnitSteps(nu.code()).map((x, i) => `${i + 1}. ${x}`).join('\n'));
    toast(ok ? '已複製逐步指示' : '複製失敗，請手動選取', ok ? 'ok' : 'err');
  });
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
