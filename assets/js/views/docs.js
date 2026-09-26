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
import { backendOf } from '../lib/units.js';
import { envUnitTemplate, envUnitSteps } from '../lib/onboard.js';
import { esc, icon, copyText, toast } from '../lib/util.js';
import { go } from '../lib/router.js';
import { pageHead, tabs, noteBox, kv } from './ui.js';

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
        ${nav.map(([k, l]) => `<div class="list-item" style="cursor:pointer" data-sec="${k}">
          <div class="li-main"><div class="li-t sm ${section === k ? 'semibold' : ''}" style="${section === k ? 'color:var(--brand-700)' : ''}">${esc(l)}</div></div>
          ${section === k ? icon('chevronR', 15) : ''}
        </div>`).join('')}
      </div>
      <div style="padding:14px 16px;border-top:1px solid var(--line-2)">
        ${noteBox(`目前旅團：<b>${esc(profile().name || '')}</b><br>身份：${esc(displayName())}（${ROLES[currentRole()]?.name || ''}）
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
      <tr><td>財務</td><td>帳目、雙財政年度報告、團費、收支申報、預算、匯入舊帳</td></tr>
      <tr><td>團員</td><td>名冊、生日表、出席率、個人紀錄</td></tr>
      <tr><td>物資</td><td>物資登記、借用批核（自動加減庫存）、借用單</td></tr>
      <tr><td>團章 / 進度 / 系統</td><td>團章編輯輸出、讀寫進度紀錄、帳戶及資料管理</td></tr>
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
  ${noteBox('執委唔使每人開「執委帳戶」。名冊剔做執委，下次用同一個 YMIS 入就係管理系統。', 'brand')}
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
  ${P(`現時版本 <b>v${esc(c.version || '')}</b>，${(c.chapters || []).length} 章，中英對照（資料由你嘅 Google Doc 內建）。`)}
  ${H('睇／改')}
  <div class="steps">
    <div class="step"><div>右上角切換 <b>中文 / English / 中英對照</b></div></div>
    <div class="step"><div>有編輯權（領袖或超管）就按「編輯」</div></div>
    <div class="step"><div>逐章改標題、逐條改條文，可以加章節、加條文、加子項（甲／乙／(i)）</div></div>
    <div class="step"><div>改完按「發布新版本」填版本號同摘要</div></div>
  </div>
  ${H('輸出')}
  <table class="table table-compact">
    <thead><tr><th>格式</th><th>用途</th></tr></thead>
    <tbody>
      <tr><td>Word（.doc）</td><td>交去總會／列印；Word、Google Docs 都開得</td></tr>
      <tr><td>PDF</td><td>按「PDF」→ 列印視窗選「另存為 PDF」</td></tr>
      <tr><td>Markdown</td><td>放上網／版本管理</td></tr>
      <tr><td>單一 HTML</td><td>一個檔案包含全份團章＋中英切換，可離線睇、可上載做公開頁</td></tr>
      <tr><td>constitution.json</td><td>發布檔：上載去 <code>data/units/${esc(currentUnit())}/</code> 更新公開頁</td></tr>
    </tbody>
  </table>
  ${H('QR Code 畀團員睇')}
  ${P(`QR Code 會指向 <code>constitution.html?u=${esc(currentUnit())}</code>（免登入公開閱讀頁，同樣有中英切換）。`)}
  ${P('如果想指向自己嘅網址（例如你上載咗單一 HTML 去學校網站），喺右邊「公開網址」改咗佢再儲存，QR 就會跟住變。')}`;
}

function financeDoc() {
  return `
  ${H('兩條數：點解')}
  ${P(`<b>旅團（童軍）財政年度</b>：每年 4 月 1 日至 3 月 31 日。<br>
        <b>旅財政年度</b>：由當年 AGM 起計，到下一年 AGM 前一日（本團多數喺暑假開 AGM）。`)}
  ${P('所以同一批帳目會有兩個結論。系統內建兩個引擎，喺「財政年度報告」可以：')}
  <ul>
    <li>分別揀年度，同時見到 <b>期初結餘 → 收入 → 支出 → 淨額 → 期末結餘</b></li>
    <li>「兩條數對照」一表睇齊兩個制嘅結果</li>
    <li>輸出 Word／PDF：可以一份文件同時載兩份報告（AGM 用），亦可以只出一份</li>
  </ul>
  ${noteBox(`<b>AGM 日期每年都唔同</b>：喺「財政年度報告 → 逐年輸入 AGM 日期」逐年填。
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
  ${noteBox('想睇完整日常流程（連月結／年結步驟）：去「教學 → <b>日常點輸入</b>」，或者睇 repo 內 <code>docs/DAILY_ENTRY.md</code>（可以列印貼喺會議室）。', 'brand')}`;
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
      <tr><td><b>成員自己交單</b>（取代 Google Form）</td><td><b>手機開 <code>entry.html?u=0082</code></b>（掃 QR）</td><td>影相 → 揀欄目 → 金額、項目、姓名（免登入）</td></tr>
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
  ${noteBox('記帳三句真言：<b>分類要一致</b>（同一個意思用同一個分類，年結才靚）、<b>項目寫得具體</b>（三個月後你自己都睇得明）、<b>單據影相／編號</b>（有單冇單，一查就知）。', 'brand')}

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
  ${noteBox(`<b>新入團按月計</b>（跟團章第 8 條）：如果中途入團，按「建立 $360」之後再改成實際金額（例如 6 個月 = $180）就得。<br>
    海外團員收 1/4（$90）。`, 'info')}

  ${H('月結（每月 5 分鐘）')}
  <div class="steps">
    <div class="step"><div>財務 → 帳目：篩選月份，睇下收入／支出合計</div></div>
    <div class="step"><div>睇「未收團費」同「待批核申報」，跟一跟</div></div>
    <div class="step"><div>輸出 Word／PDF 一份畀領袖存檔（或者貼上群組）</div></div>
  </div>

  ${H('年結（AGM 前）')}
  <div class="steps">
    <div class="step"><div>財務 → 財政年度報告 → 揀「旅財政年度（AGM 起計）」</div></div>
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
  ${noteBox('欄位名可以照用你原本嘅中文字：日期 / 類型（收入、支出）/ 項目 / 金額 / 分類 / 方式 / 經手人（負責人）/ 年度 / 團費（打 ✓ 或寫團員名）/ 備註。系統會自動對位，唔需要改格式。', 'info')}

  ${H('想印出嚟貼喺房？')}
  ${P('呢一頁可以按瀏覽器「列印」存成 PDF，貼喺物資房／會議室；或者喺「財務 → 匯入」下載空白範本 CSV，跟住格式填就得。')}`;
}

function mobileDoc() {
  return `
  ${H('一句話：唔使再開 Google Form，用手機影相就交得')}
  ${P('成員（同家長）唔需要帳號：掃 QR 或者開 <code>entry.html?u=0082</code> 就得。流程係 <b>① 揀支出／收入 → ② 影相 → ③ 揀欄目 → ④ 打金額 → 送出</b>。')}
  <div class="steps">
    <div class="step"><div>領袖／執委：<b>財務 → 收支申報 → 右上「畀成員自己填（QR）」</b></div></div>
    <div class="step"><div>彈出嘅 QR Code：<b>下載 SVG</b> 或按「<b>列印 QR 海報</b>」→ 貼喺團址／物資房／派通告</div></div>
    <div class="step"><div>同時都可以「複製網址」貼落 WhatsApp 群</div></div>
    <div class="step"><div>成員照住做：揀欄目（例：活動／交通／膳食／團費收入）、影低單據、打金額同理姓名</div></div>
    <div class="step"><div>送出之後：如果旅團設定咗 Apps Script，紀錄<b>直接寫入總 Sheet</b>；未設定就存喺成員自己部手機，佢可以按「複製內容」傳畀司庫</div></div>
  </div>
  ${noteBox('想完全自動：喺「財務 → 收支申報 → 畀成員自己填」貼上 Apps Script <code>/exec</code> 網址（同「系統 → 資料管理 → 總表同步」可以共用同一個），成員一送出就入總表嘅「待批申報」分頁，仲可以順手存埋相片去 Google Drive。', 'brand')}

  ${H('執委／領袖喺 APP 內填')}
  <div class="steps">
    <div class="step"><div><b>儀表板 → 「影相記一筆」</b>：最快，開門就係申報表</div></div>
    <div class="step"><div>或者 <b>財務 → 收支申報 → 我要申報</b>：一樣有相機、日期、分類</div></div>
    <div class="step"><div>批核：喺「收支申報」按「<b>批准並入帳</b>」→ 自動寫入帳目（金額、分類、日期、相片一齊跟）</div></div>
    <div class="step"><div>相片太佔位？去「系統 → 資料管理 → 儲存用量」按「清理已入帳嘅相片（保留記錄）」</div></div>
  </div>

  ${H('通告：一撳 WhatsApp 分享 ＋ QR 報名')}
  <div class="steps">
    <div class="step"><div><b>通告 → 開新通告</b>：揀類型（活動／會議／招募／一般／AGM）</div></div>
    <div class="step"><div>填<b>中文標題</b>（英文標題可留空）；打內容（活動通告記得填日期、地點、費用、截止日期、名額）</div></div>
    <div class="step"><div>需要報名就開「<b>要報名</b>」→ 下面可以<b>自己加／改／刪報名欄目</b>（姓名、電話、飲食禁忌、備註…），剔「必填」</div></div>
    <div class="step"><div>按「<b>發布並分享</b>」→ 彈出<b>分享對話框</b></div></div>
    <div class="step"><div>撳「<b>用 WhatsApp 分享</b>」：即刻開 WhatsApp，標題／日期／地點／費用／截止／內容重點同<b>報名連結</b>都自動填好（可以改完先送）</div></div>
    <div class="step"><div>要貼圖就用「<b>儲存 QR 圖</b>」（存落手機相簿再貼落群組），或者「列印 QR 海報」貼喺團址</div></div>
    <div class="step"><div>成員／家長<b>免登入</b>撳連結／掃 QR 就睇到通告全文，順手報名</div></div>
    <div class="step"><div>返到 APP：通告 → 該通告 → <b>報名名單</b>（出席／唔出席／未回覆）可以睇／匯出 CSV／Word、列印簽到表</div></div>
  </div>
  ${noteBox('公開頁係獨立嘅 <code>notice.html?u=0082&amp;n=通告編號</code>：只顯示該張通告，唔會露出其他資料。<b>每次分享一張</b>，到期就喺 APP 內改狀態，或者直接開新一張。報名會直接寫入旅團後端（同一個後端、兩個前端）。', 'info')}

  ${H('常見問題')}
  ${P('<b>冇網絡？</b>APP 同公開頁都係靜態檔案，載入之後照用得；送出嘅紀錄會先存喺裝置，之後再傳畀司庫。')}
  ${P('<b>驚亂？</b>申報只係「待批核」，要司庫或領袖按批准才會入帳；錯嘅可以拒絕或者刪除。')}
  ${P('<b>想改欄目？</b>通告嘅報名欄目係逐張通告自己設定；財務／物資／用戶／會議嘅欄目，去返<b>嗰個分頁</b>按右上角「<b>欄位</b>」掣（唔再需要一個獨立「表格」分頁）。')}`;
}

function tablesDoc() {
  return `
  ${H('一句話：成個系統就係一張大表，欄位自己話事')}
  ${P('想改欄位就去<b>嗰個分頁</b>按「<b>欄位</b>」掣（財務／用戶／物資／通告／會議 都有）：可以改名、加欄、改類型、隱藏、排次序 —— 好似內建一個 Google Sheet。進階嘅「插入自己嘅 Sheet」同「總表同步」喺「<b>系統 → 資料管理</b>」。')}

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
    <div class="step"><div>系統 → 資料管理 → <b>插入自己嘅 Sheet</b> → 貼上連結（記得帶 <code>gid=</code>，即係你停留嘅分頁）</div></div>
    <div class="step"><div>按「讀取欄位」→ 系統自動幫你對應（日期→日期、金額→金額、付款人→經手人…）</div></div>
    <div class="step"><div>對應唔啱就逐個下拉改；可以剔「匯入前清空該表」避免重複</div></div>
    <div class="step"><div>按「匯入」→ 有預覽筆數；之後可以「儲存做同步來源」，隨時再按「同步」拉最新版本</div></div>
  </div>
  ${noteBox('冇公開連結都可以：喺 Sheet 選取範圍 → Ctrl+C → 按「改為貼上 CSV」照樣讀得到。', 'info')}

  ${H('③ 總表同步：旅團獨立專屬 Google Sheet 後端')}
  ${P('每個旅團使用<b>獨立專屬嘅 Google Sheet</b>（深資童軍管理系統一張，進度追蹤系統另設一張，兩張完全分開獨立維護，互不干擾）。')}
  <div class="steps">
    <div class="step"><div>開你旅團嘅專屬 Google Sheet → <b>擴充功能 → Apps Script</b></div></div>
    <div class="step"><div>APP 內免登入或於「總表同步 → <b>下載 Code.gs</b>」→ 貼上去（全部取代）</div></div>
    <div class="step"><div>第一次：執行 <code>initializeSheets</code> 建分頁＋API Key。之後只更新程式：貼上 → 儲存 → 部署「新版本」，<b>唔使再 initialize</b></div></div>
    <div class="step"><div>開團 KEY：執行 <code>issueSetupKey()</code>（72 小時；過期再執行）</div></div>
    <div class="step"><div><b>部署 → 新增部署作業 → 網頁應用程式</b>；執行身分：我；存取權：任何人</div></div>
    <div class="step"><div>複製 <code>/exec</code> 網址，貼返「Apps Script 網址」，填旅團編號與 API Key</div></div>
    <div class="step"><div>儲存設定 → 改動之後撳頂部「<b>儲存到後端</b>」就寫入；唔會自動同步</div></div>
    <div class="step"><div>專屬 Sheet 會自動建立／更新分頁：帳目、物資、團員、收支申報、通告、報名、會議、同步紀錄</div></div>
  </div>
  ${noteBox('<b>一個後端、兩個前端。</b>每個旅團一張 Google Sheet ＋ 一支 Apps Script：深資童軍管理系統同進度前端共用同一份資料（進度追蹤／其他獎章／活動履歷等分頁由 <code>initializeSheets</code> 建立）。相片唔會直接塞入 Sheet（只記數量），如果想存相就喺 Code.gs 頂部填 <code>DRIVE_FOLDER_ID</code>，相片會自動上載去 Drive 再貼連結落 Sheet。', 'brand')}

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
  ${noteBox('可用數量＝登記總數 ＋ 盤點調整 − 未歸還借用。因為係即時由紀錄推算，唔會出現「加減錯數」。', 'brand')}
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
  const p = profile();
  const u = p.progress || {};
  const b = u.backend || {};
  const masked = b.apiKey ? '已設定（' + '•'.repeat(8) + '）' : '（未設定）';
  const be = backendOf(load().unitCode) || {};
  const shownBackend = b.backend ? maskExec(b.backend) : (be.gasUrl ? maskExec(be.gasUrl) + '（用返旅團登記嘅後端）' : '（未設定）');
  return `
  ${H('設計：一個後端、兩個前端')}
  ${P('旅團只有<b>一個後端</b> —— 一張 Google Sheet ＋ 一支 Apps Script（<code>/exec</code>）。'
    + '<b>深資童軍管理系統</b>同<b>進度前端</b>（團員／領袖用嗰個）係<b>兩個前端</b>，讀寫同一份資料。')}
  ${noteBox('所以深資童軍管理系統<b>唔需要連去任何其他系統</b>：唔開分頁、唔用 portal、唔會出 <code>referer_mismatch</code>。'
    + '進度資料本身就係寫入旅團自己嘅後端。', 'brand')}
  ${P('呢邊做三件事：')}
  <ul style="padding-left:18px;line-height:1.9" class="sm">
    <li><b>讀</b>：<code>GET ?action=load</code> —— 成員、進度、待批完成、其他獎章、活動履歷</li>
    <li><b>寫</b>：<code>POST {action:'save'|'saveOtherBadge', apikey}</code> —— 直接勾／取消勾</li>
    <li><b>批</b>：<code>POST {action:'reviewRequest'|'reviewLogRequest'}</code> —— 「審批中心」批准／拒絕團員申報；
      批准即刻寫入「進度追蹤」／「活動履歷」</li>
  </ul>
  ${P('<b>API Key＝執委身份</b>：Key 對得上就讀得、勾得。Key 只會由瀏覽器傳去<b>同源</b> <code>/api/progress</code>，'
    + '唔會出現在網址、唔會交畀第三方、亦唔會寫入 log。')}

  ${H('審批中心（批團員嘅申報）')}
  ${P('團員喺進度前端自己申報「我完成咗某項」之後，會入後端嘅「待批完成」分頁；'
    + '執委／領袖喺<b>「進度記錄 → 審批中心」</b>就會見到，直接撳<b>批准</b>或<b>拒絕</b>。')}
  <ul style="padding-left:18px;line-height:1.9" class="sm">
    <li><b>批准</b>＝寫入「進度追蹤」（唔會重複開新行；已有紀錄就更新完成日期）</li>
    <li><b>拒絕</b>＝狀態改「已拒絕」，團員可以重新申報；紀錄唔會被刪</li>
    <li>同一版仲有<b>待批履歷</b>（團員自行申報嘅服務／活動紀錄），批准會寫入「活動履歷」</li>
    <li>要喺有<b>勾選權限</b>嘅帳號先批得（睇得到、但批唔到）</li>
  </ul>
  ${noteBox('團員嗰邊只需要專心自己嘅紀錄冊（申報、睇進度）；批核、勾選、通告、財務全部喺深資童軍管理系統搞掂，唔使兩個系統跳來跳去。', 'brand')}

  ${H('點設定（通常唔使填）')}
  <div class="steps">
    <div class="step"><div>如果旅團後端已經登記喺 <code>data/units.json</code>（<code>backend.gasUrl</code> / <code>apiKey</code>），'
      + '「進度」頁會自動用返佢 —— 咩都唔使填</div></div>
    <div class="step"><div>未登記就喺「<b>進度 → 設定</b>」填 <b>/exec 網址</b> ＋ <b>API Key</b>（執行 <code>showApiKey()</code> 複製）</div></div>
    <div class="step"><div>儲存之後撳「重新讀取」→ 見到成員同進度就成功；之後喺「勾選進度」直接勾</div></div>
  </div>
  ${noteBox('後端要係本系統嘅 <code>Code.gs</code>（或者已經支援 <code>?action=load</code> 同 <code>action=save</code> 嘅版本）：'
    + '「系統 → 資料管理 → 總表同步」可以下載最新範本，執行一次 <code>initializeSheets</code> 會建好'
    + '「進度追蹤／其他獎章／活動履歷」等分頁。', 'info')}
  ${noteBox('<b>設好後端之後，想埋讀取進度追蹤？</b>去「進度 → 設定」：'
    + '① 貼 <code>/exec</code> 網址（Apps Script → 部署 → 管理部署） ② 貼 API Key（Apps Script 執行 '
    + '<code>showApiKey()</code>） ③ 儲存後撳「重新讀取」見到團員名單就成功。'
    + '兩個值存在旅團自己嘅資料（跟 JSON 備份走）。', 'info')}

  ${H('考核項目定義')}
  ${P('項目定義（第 11 版綱要）已經<b>內建</b>喺 <code>data/progress/items.json</code>，離線都用得，唔使連任何網站。'
    + '如果旅團自己改過項目，喺「設定 → 自訂考核項目定義」填一條公開 https 網址就得。')}

  ${H('身份對應（兩邊用同一批人）')}
  ${P('<b>團員／執委用 YMIS（10 位數字）、領袖用 Email</b>。喺「用戶」度逐個補，'
    + '用戶頁會顯示覆蓋率同「未對上」名單；未補嘅只可以用姓名配對（會撞名、會漏）。')}

  ${H('目前設定')}
  <pre><code>${esc(JSON.stringify({
    backend: shownBackend,
    apiKey: masked,
    unit: b.unit || currentUnit(),
    catalog: b.catalogUrl || '（內建 data/progress/items.json）',
    mode: '同一個後端（直接讀寫）'
  }, null, 2))}</code></pre>`;
}

/** /exec 只顯示頭段，避免成條 deployment id 喺教學出現 */
function maskExec(u) {
  return String(u || '').replace(/\/macros\/s\/[^/]+/, '/macros/s/…');
}

/* 管理員專用（方法 A：Git Registry）—— 普通用戶冇 Git／Vercel 權限，唔需要見到 */
function adminGitSteps() {
  return `
  ${H('管理員手工加（進階 · 方法 A）')}
  <div class="steps">
    <div class="step"><div>最快嘅做法係<b>方法 B</b>（Vercel 環境變數）—— 睇「教學 → <b>開新旅團（唔使改 Git）</b>」有逐步教學同可複製嘅環境變數範本</div></div>
    <div class="step"><div>方法 A：喺 <code>data/units.json</code> 嘅 <code>units</code> 加一個編號，例如 <code>"0100": { "code": "0100", "name": "第一百旅深資童軍團", "dataPath": "data/units/0100/", "backend": { "gasUrl": "…/exec", "apiKey": "…" } }</code></div></div>
    <div class="step"><div>建立 <code>data/units/0100/</code> 資料夾，複製 0082 嘅檔案再改內容</div></div>
    <div class="step"><div>Commit &amp; push（如果用 GitHub Pages / Vercel，會自動部署）→ 旅團選擇器就會見到新旅團</div></div>
  </div>
  ${P('<span class="xs faint">詳細欄位名同每次收到申請嘅 checklist：見 repo 入面 <code>docs/ADD_NEW_UNIT.md</code> 同 <code>docs/ADMIN_ONBOARDING.md</code>。</span>')}`;
}

/* 新旅團接入步驟（步驟 1–5 喺登入前嘅「部署指南」已經有；呢度俾超管睇返完整流程） */
function multiUnitOnboardSteps() {
  return `
  ${H('新旅團點接入（推薦：用申請表）')}
  ${P('<b>每個旅團用自己嘅 Google Sheet 做後端</b>，唔係共用一張總表。流程：')}
  <div class="steps">
    <div class="step"><div><b>起後端</b> —— 「系統 → 資料管理 → 總表同步」下載 <code>Code.gs</code> → 建一張新 Google Sheet → 擴充功能 → Apps Script → 貼上</div></div>
    <div class="step"><div>執行 <code>initializeSheets</code>（會建好全部分頁），複製 <b>API Key</b></div></div>
    <div class="step"><div>部署做<b>網頁應用程式</b>（執行身分：我；存取權：任何人），複製 <code>/exec</code> 網址</div></div>
    <div class="step"><div>旅團喺登入前嘅旅團閘撳「<b>新旅團申請接入</b>」（或者直接將 <code>/exec</code> ＋ Key 交畀你）</div></div>
    <div class="step"><div>你收到之後 → 「教學 → <b>開新旅團（唔使改 Git）</b>」加 5 個 <code>TROOP_&lt;編號&gt;_*</code> 環境變數 → Redeploy</div></div>
    <div class="step"><div>通知旅團更新 <code>Code.gs</code>（同自己嗰張 Sheet 對齊）＋ 登入試一次</div></div>
  </div>`;
}

/* 非超管：唔需要接入教學（登入前已經有齊），只留一句指路 */
function multiUnitOnboardNote() {
  return `
  ${H('新旅團點接入？')}
  ${noteBox('旅團自己申請接入嘅步驟（起後端 → initializeSheets → 部署 → 送出申請）'
    + '喺<b>登入前嘅旅團閘「部署指南」</b>已經有齊，毋須登入都睇得到。<br>'
    + '呢個平台嘅旅團登記（<code>TROOP_&lt;編號&gt;_*</code> 設定）由<b>超級管理員</b>負責 —— '
    + '將你嘅 <code>/exec</code> 網址同 API Key 交畀佢就得。', 'info')}`;
}

function multiUnitDoc() {
  return `
  ${H('多旅團架構（每個旅團一個後端）')}
  <pre><code>data/
  units.json                 ← 旅團 Registry（邊幾個旅團、資料路徑）
  units/0082/                ← 每個旅團一個資料夾
    unit.json                ← 旅團資料 + 設定（團費、AGM 日期、主色）
    constitution.json        ← 團章（中英）
    members.json             ← 團員（含生日）
    finance.json             ← 帳目 / 團費 / 申報 / 預算
    inventory.json           ← 物資 / 借用
    meetings.json            ← 會議（可選）</code></pre>
  ${isSuper() ? multiUnitOnboardSteps() : multiUnitOnboardNote()}
  ${isSuper() ? adminGitSteps() : ''}
  ${H('資料隔離')}
  ${P('每個旅團嘅資料存喺 <code>venture82.unit.&lt;編號&gt;.db.v2</code>，互相睇唔到、改唔到。團章公開頁用 <code>constitution.html?u=編號</code>，QR Code 亦會自動帶旅團編號。')}
  ${H('權限')}
  ${P('每個旅團有自己嘅帳戶清單（領袖 / 執委）。超管帳戶係全平台共用嘅隱藏帳戶。')}`;
}

/* ============================================================
   開新旅團（方法 B：Vercel 環境變數）—— 唔使改 Git
   ------------------------------------------------------------
   呢章係「驚唔記得點做」用嘅：步驟、可以複製嘅變數範本、
   檢查清單全部喺度。同樣內容亦可以喺「系統 → 旅團設定」撳入嚟。
   ============================================================ */
function superOnlyDoc() {
  return `
  ${H('呢一章只限超級管理員')}
  ${noteBox('「開新旅團」要改 Vercel 環境變數（`TROOP_<編號>_*`），<b>只有超級管理員做得到</b>。'
    + '如果你要開新旅團，將旅團嘅 <code>/exec</code> 網址同 API Key 交畀系統管理員就得。', 'warn')}
  ${P('日常團務請睇：<b>快速開始</b>、<b>進度紀錄（同一個後端）</b>、<b>財務</b>、<b>日常點輸入</b>等章節。')}`;
}

function newUnitDoc() {
  return `
  ${H('開新旅團：方法 B（唔使改 Git，最快）')}
  ${P('情境：<b>旅團畀你一個 Apps Script <code>/exec</code> 網址 ＋ API Key</b>，你想佢即刻可以登入用。')}
  ${noteBox('兩個方法並存，唔使二選一：<br>'
    + '<b>方法 B（呢一章）</b>＝喺 Vercel 加環境變數，唔使改 Git；旅團由空白資料開始，'
    + '團章／名冊／舊帳之後慢慢入（或者隨時搬去方法 A）。<br>'
    + '<b>方法 A</b>＝喺 <code>data/units.json</code> ＋ <code>data/units/&lt;編號&gt;/</code> 加檔案（可以預載資料）。', 'brand')}

  ${H('第 1 步：產生環境變數（喺下面填一填、撳複製）')}
  <div class="card"><div style="padding:16px 18px">
    <div class="grid g-2" style="gap:12px">
      <div class="field"><label class="label">旅團編號</label>
        <input class="input" id="nu-code" placeholder="例：0081" value="0081"></div>
      <div class="field"><label class="label">旅團名稱</label>
        <input class="input" id="nu-name" placeholder="例：第八十一旅深資童軍團"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">/exec 網址（旅團畀你嗰個）</label>
        <input class="input" id="nu-exec" placeholder="https://script.google.com/macros/s/AKfy…/exec"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">API Key</label>
        <input class="input" id="nu-key" placeholder="執行 showApiKey() 複製嘅字串"></div>
    </div>
    <div class="row gap-8 wrap mt-12">
      <button class="btn btn-primary" data-act="gen-env">${icon('refresh', 15)} 產生</button>
      <button class="btn" data-act="copy-env">${icon('copy', 15)} 複製環境變數</button>
      <button class="btn" data-act="copy-steps">${icon('copy', 15)} 複製逐步指示</button>
    </div>
    <pre class="code mt-12" id="nu-out">${esc(envUnitTemplate('0081'))}</pre>
    <div class="hint">複製之後：Vercel → 專案 → <b>Settings → Environment Variables</b> 逐個貼上（可以一次貼多行，
      佢會自動拆）。</div>
  </div></div>

  ${H('第 2 步：Redeploy')}
  <div class="steps">
    ${envUnitSteps('0081').map(x => `<div class="step"><div>${esc(x)}</div></div>`).join('')}
  </div>
  ${noteBox('環境變數<b>要 Redeploy 先生效</b>（唔係即刻）。部署完旅團清單就會見到新編號，'
    + '佢嘅資料由<b>空白</b>開始（唔會讀 <code>data/units/&lt;編號&gt;/</code>，因為冇呢個資料夾）。', 'warn')}

  ${H('第 3 步：旅團登入之後')}
  <ul style="padding-left:18px;line-height:1.95" class="sm">
    <li><b>通告</b>：開通告 → 喺「總表同步」撳一次同步 → 公開頁（<code>notice.html?u=&lt;編號&gt;&amp;n=&lt;通告編號&gt;</code>）
      會直接由佢自己嘅後端讀 → 可以 WhatsApp 分享 ＋ QR 收報名（唔使改 Git 都公開到）</li>
    <li><b>進度</b>：如果已經設咗 <code>TROOP_&lt;編號&gt;_PROGRESSBACKEND</code> ＋ <code>_PROGRESSAPIKEY</code>，
      前端「進度」頁會顯示「<b>伺服器端已設定</b>」，唔使填任何嘢就讀到成員、勾得進度、批得申報</li>
    <li><b>團章</b>：去「團章」寫好 → 發布 → 公開頁 <code>constitution.html?u=&lt;編號&gt;</code></li>
    <li><b>名冊</b>：去「用戶」加執委／領袖帳戶同團員（之後同步一次就會寫入佢自己嘅 Sheet）</li>
  </ul>

  ${H('方法 A：Git Registry（想預載資料先用）')}
  <div class="steps">
    <div class="step"><div>喺 <code>data/units.json</code> 嘅 <code>units</code> 加一個編號：
      <code>"0100": { "code": "0100", "name": "…", "dataPath": "data/units/0100/", "backend": { "gasUrl": "…/exec", "apiKey": "…" } }</code></div></div>
    <div class="step"><div>建立 <code>data/units/0100/</code>，複製 0082 嘅檔案再改（<code>unit.json</code>／
      <code>constitution.json</code>／<code>members.json</code>／<code>finance.json</code>／<code>inventory.json</code>…）</div></div>
    <div class="step"><div>Commit & push → 部署 → 旅團清單見到新編號</div></div>
  </div>
  ${P('<span class="xs faint">詳細欄位：repo 入面 <code>docs/ADD_NEW_UNIT.md</code>；'
    + '每次收到申請嘅 checklist：<code>docs/ADMIN_ONBOARDING.md</code>。</span>')}

  ${H('檢查清單（照住剔）')}
  <ul style="padding-left:18px;line-height:1.95" class="sm">
    <li>□ 收到旅團嘅 <code>/exec</code> 網址 ＋ API Key</li>
    <li>□ Vercel 加咗 5 個 <code>TROOP_&lt;編號&gt;_*</code> 變數</li>
    <li>□ Redeploy 完成，旅團清單見到新編號</li>
    <li>□ 旅團更新咗 Code.gs ＋ 部署新版本（第一次先要 initializeSheets）</li>
    <li>□ 實測：登入 → 開一張測試通告 → 用 QR／連結報名 → Sheet「報名」分頁見到紀錄</li>
    <li>□ 實測：進度頁見到成員（或者顯示「伺服器端已設定」）</li>
    <li>□ 通知旅團：以後自己入「進度 → 設定」可以覆蓋 <code>/exec</code> ＋ Key</li>
  </ul>`;
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
      <tr><td>全站備份</td><td>JSON（系統 → 資料管理）</td></tr>
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
