# 🗺️ 執委管理系統 旅團部署指南 · 多旅團架構與進度追蹤整合

> 10 分鐘完成部署。本系統為深資童軍團**執委管理系統**；進度紀錄採用**一個後端、兩個前端**（Google Sheet ＋ Apps Script 一個，執委系統同進度前端兩個）。

---

## 🌟 系統架構概念

### 1. 雙系統聯邦運作 (Hub & Progress Tracker)
* **模型：一個後端、兩個前端** —— 旅團只有**一個後端**（Google Sheet ＋ Apps Script `/exec`），
  執委管理系統同進度前端都係前端，讀寫同一份資料。所以執委系統**唔會連去任何其他系統**。
* **主系統（執委管理系統 · ecportal）**：
  - 執委會日常行政：會議紀錄、物資借用及庫存（自動扣除）、團章中英對照、活動通告與即時出席回覆（`notice.html`）、成員手機影相快速記帳（`entry.html`）、雙財政年度（AGM 旅年度 ＋ 4/1–3/31 童軍年度）。
  - 進度紀錄：直接讀／寫旅團自己嘅後端（`?action=load` / `action=save`）。預設用返 `data/units.json` 登記嘅 `backend.gasUrl` / `apiKey`；要覆蓋先喺「進度 → 設定」填。
* **進度前端（團員／領袖用嗰個）**：
  - 專注深資童軍各階段獎章、活動段章、專科章及訓練班紀錄與審批。

### 2. 多旅團獨立後端與「雙試算表隔離」原則 (重要原則)
* **每個旅團嚴格維持 2 張獨立 Google Sheet**：
  - **試算表 ①（執委管理系統專屬）**：儲存帳目、收支申報、物資庫存、物資借用、團員名冊、通告發布、報名出席、會議紀錄。
  - **同一個試算表**：進度追蹤（進度追蹤／其他獎章／待批完成／活動履歷／待批履歷／成員名單分頁）—— 執委系統同進度前端讀寫同一份。
  - **❌ 嚴禁合併為單一 Sheet**：
    - **權限與私隱隔離**：執委管理系統涉及全團銀行結餘、單據與內部行政會議；進度系統涉及個別團員考核與領袖審批。分開確保各持所需權限，避免權限外洩。
    - **架構獨立升級**：兩套系統的 Apps Script 腳本與資料結構各自迭代，分開後任一系統升級均不影響另一方運作。
    - **Apps Script 效能**：避免單一試算表過大觸發 Google 執行逾時（Quota Limit）。
* **不能在登入後才下載 GS**：
  在多旅團架構下，新旅團尚未開戶，不可能亦不需要先登入。
  因此 **`Code.gs` 可在首頁／旅團選擇閘／登入頁面免登入直接下載**。
* **流程順序**：
  1. 旅團負責人先下載 `Code.gs`
  2. 在 Google Sheets 建立試算表並部署 Apps Script Web App
  3. 取得 `/exec` URL 及 API Key
  4. 提交給管理員登記進 `data/units.json` 或 Vercel 環境變數
  5. 重新部署後，旅團正式上線！

---

## 🔧 部署五部曲 (所有旅團共通，10 分鐘)

### 第 1 步：下載後端程式碼 (App 內免登入)
- 訪問系統網址（例 `https://ecportal.vercel.app/` 或本地環境）
- 於首頁旅團選擇閘直接點擊 **「⬇️ 下載 Code.gs」** 或 **「📋 複製原始碼」**（全於 App 介面完成，毋須登入，亦毋須進入 Git）

### 第 2 步：建立 Google Sheet
1. 開啟 [Google Sheets](https://sheets.google.com) → 建立新試算表（例如命名為「第82旅 執委會總表」）
2. 點擊上方選單 **「擴充功能」→「Apps Script」**

### 第 3 步：貼上代碼並初始化
1. 清空預設代碼，貼上 `Code.gs` 全部內容
2. 點擊 💾 儲存
3. 函數下拉選單選擇 **`initializeSheets`** → 點擊 **▶ 執行**
4. 依照 Google 提示完成授權（進階 → 前往 → 允許）
5. 系統會自動建立 9 個棗紅主題工作表：
   - `帳目`（收支明細、付款方式、單據編號）
   - `收支申報`（手機 `entry.html` 影相記帳待批資料）
   - `物資`（器材清單、數量、存放位置）
   - `物資借用`（公開頁 `borrow.html` 借用申請）
   - `團員`（YMIS、姓名、身份、生日、職位）
   - `通告`（通告內容、發布狀態、費用、活動日期）
   - `報名`（公開頁 `notice.html` 即時報名與出席回覆）
   - `會議`（會議紀錄、決議）
   - `同步紀錄`（每次總表同步時間與統計）
6. 彈窗會顯示專屬 **API Key**（格式如 `v82_xxxxxxxxxxxxxxxx`）→ **複製保存**（日後可執行 `showApiKey` 再次查看）

### 第 4 步：部署為網頁應用程式 (Web App)
1. 點擊右上角 **「部署」→「新增部署作業」**
2. 點擊齒輪圖示，選擇 **「網頁應用程式」**
3. 設定：
   - 描述：`執委管理系統 82旅`
   - 執行身分：**我**
   - 具有存取權的使用者：**任何人**（Anyone）
4. 點擊「部署」→ 複製 **網頁應用程式網址**（`https://script.google.com/macros/s/…/exec`）

### 第 5 步：登記至系統 (於 App 內送出或交由管理員登記)

於首頁旅團選擇閘點擊 **「新旅團申請接入」** 直接填寫送出，或將以下資料交由系統管理員：

| 欄位 | 範例 | 說明 |
|---|---|---|
| **旅團編號** | `0123` | 4 位數字或自訂編號 |
| **旅團名稱** | 第一二三旅深資童軍團 | 旅團完整中文名稱 |
| **Apps Script URL** | `https://script.google.com/macros/s/…/exec` | 剛部署的 Web App URL |
| **API Key** | `v82_xxxxxxxxxxxxxxxx` | 執行 initializeSheets 獲得的密鑰 |
| **聯絡人** | `scouter@example.hk` | 旅團負責領袖聯絡 |

---

## 🛠️ 管理員登記指南 (Git / Vercel 維護者)

### 方式 A：登記於 Git（`data/units.json`）
在 `data/units.json` 的 `units` 下加入該旅團：
```jsonc
"0123": {
  "code": "0123",
  "name": "第一二三旅深資童軍團",
  "nameEn": "123rd Hong Kong Group Venture Scout Unit",
  "short": "執委管理系統",
  "backend": {
    "gasUrl": "https://script.google.com/macros/s/AKfyc.../exec",
    "apiKey": "v82_xxxxxxxxxxxxxxxx"
  },
  "progress": {
    "name": "進度紀錄（同一個後端）",
    "mode": "portal",
    "portal": {
      "unitParam": "0123",
      "role": "exec_committee",
      "ymis": "",
      "extraParams": """
    }
  }
}
```
並建立 `data/units/<編號>/` 資料夾（複製範本並填入初始 `unit.json`, `members.json`, `constitution.json`, `finance.json`, `inventory.json`）。

### 方式 B：使用 Vercel 環境變數（免改 Git 即可熱更新後端）
在 Vercel 專案 Settings → Environment Variables 加入：
- `TROOP_0123_BACKEND` = `https://script.google.com/macros/s/…/exec`
- `TROOP_0123_APIKEY` = `v82_xxxxxxxxxxxxxxxx`
- （進度紀錄）**唔使設** —— 要埋讀進度就去「進度 → 設定」填 `/exec` ＋ API Key；想收埋條 Key 先自己用 env 覆蓋（`TROOP_0123_PROGRESSBACKEND` / `_PROGRESSAPIKEY` / `_PROGRESSCATALOG`）

---

## 🔗 進度紀錄：一個後端、兩個前端

```
                    ┌───────────────────────────────┐
   執委管理系統 ───▶ │  旅團自己嘅後端（只有一個）      │ ◀─── 進度前端（團員／領袖用）
   （前端 ①）        │  Google Sheet ＋ Apps Script    │      （前端 ②）
                    └───────────────────────────────┘
```

1. **後端只有一個**：旅團自己嘅 Google Sheet ＋ Apps Script（`/exec`）。進度資料（`進度追蹤`／`其他獎章`／
   `活動履歷`／`待批完成`／`待批履歷`／`成員名單` 分頁）就住喺呢度。
2. **執委管理系統唔連任何其他系統**：只係**讀後端**（`GET ?action=load`）／**寫後端**
   （`POST {action:'save'|'saveOtherBadge', apikey, changes}`）。冇外連、冇 portal、冇 `referer_mismatch`。
3. **API Key＝執委身份**：Key 對得上就讀得、勾得；Key 只會由瀏覽器傳去**同源** `/api/progress`，
   唔會出現在網址、唔會交畀第三方、唔會寫入 log。
4. **考核項目定義**：第 11 版綱要已內建喺 app（`data/progress/items.json`），離線用都得；
   旅團自己改過項目就喺「進度 → 設定」填自訂 https 網址。
5. **兩個前端共用同一批人**：靠 **YMIS（團員／執委）** 同 **Email（領袖）** 對人；
   「總表同步」會同時更新 `成員名單`，所以兩邊見到同一份名冊。

### 後端範本（`Code.gs`）已經支援兩個前端

* 執委系統用：`sync` / `claim` / `noticeSignup` / `loan` / `status` / `ping`
* 進度用：`GET ?action=load`、`POST action=save`、`action=saveOtherBadge`
* 執行一次 `initializeSheets` 會建立所有分頁（包括進度用嘅 5 張 ＋ `成員名單`）
* 改完範本記得跑 `npm run build:gas`（會重新產生 `apps-script/Code.gs`，`npm test` 會檢查兩邊一致）

### 伺服器端設定（可選：只有想收埋條 Key 先需要；唔設就去「進度 → 設定」填）

喺 Vercel 專案 Settings → Environment Variables 加：

- `TROOP_0123_PROGRESSBACKEND` = `https://script.google.com/macros/s/…/exec`
- `TROOP_0123_PROGRESSAPIKEY` = `v82_xxxxxxxxxxxxxxxx`
- `TROOP_0123_PROGRESSCATALOG` = `https://…/items.json`（自訂考核項目定義，可選）

設定咗之後，前端「進度 → 設定」可以留空，API Key 完全唔會落前端。

### 通告報名（同一個後端）

「通告」→「分享報名」：一撳 **WhatsApp** 分享（文字＋報名連結自動填好）、QR 圖可儲存落手機貼落群組、
免登入報名頁 `notice.html?u=<旅團>&n=<通告>`；報名直接寫入後端 `報名` 分頁，執委喺「通告 → 所有報名」睇統計。

## 📊 活動通告出席與活動履歷（進度紀錄）聯動

### 1. 核心需求背景
深資童軍需要累積活動紀錄（如團集會、露營營夜數、遠足歷程、服務時數等）以符合深資童軍獎章（VCS / VAA / DofA）的要求；呢啲紀錄就存喺旅團後端嘅「活動履歷」分頁。執委管理系統嘅通告（Notices）已經完整記錄活動日期、地點、類別及團員出席回覆（RSVP）。

### 2. 整合與橋接設計（已內建）
在「通告詳情」中，系統已實作 **活動履歷匯出**：
1. **自動配對 YMIS**：系統自動將出席名單透過名冊比對出 10 位數字的童軍會籍編號（YMIS），名冊以外回覆則自動標記。
2. **一鍵匯出活動履歷格式**：
   - **`匯出活動履歷（CSV）`**：可直接匯入後端「活動履歷」分頁，或者交畀進度前端。
   - **`匯出活動履歷（JSON）`**：結構化 Payload，包含旅團編號、活動標題、類別標籤、日期、地點及出席成員列表。
3. **無縫交接**：執委於執委管理系統完成點名後，點擊「匯出活動履歷」即可將出席數據帶到後端，供支部領袖進行獎章考核勾選。
4. **批核都喺執委系統**：團員喺進度前端申報之後，執委／領袖喺「進度記錄 → **審批中心**」直接批准／拒絕；批准即刻寫入同一份 `進度追蹤`／`活動履歷`，兩個前端都見到。

### 3. 複雜度與可用性評估 (Evaluation)

| 評估維度 | 評估結論 | 說明 |
|---|---|---|
| **系統複雜度 (Complexity)** | **極低 (Very Low)** | 採用 Loose Coupling（鬆散耦合）架構，透過標準資料交換協定（JSON / CSV / SSO Payload），毋須在底層強行合併 Google Sheets 或跨庫關聯。 |
| **維護性 (Maintainability)** | **極佳 (Excellent)** | 兩邊系統的資料庫與後端各自獨立演進，任何一方更新欄位均不影響另一方，完全避免權限或 Schema 衝突。 |
| **使用者操作體驗 (Usability)** | **極高 (High)** | 執委毋須重複鍵入活動資料與出席名冊，一鍵即可完成資料轉換；進度資料同一個後端，領袖喺執委系統就可以直接勾。 |
| **資料安全性 (Security)** | **同一後端、分頁隔離** | 財務與內部行政資料留喺執委管理系統；進度考核放喺後端嘅進度分頁，API Key 只去同源 `/api/progress`，唔會出現在網址或 log。 |

---

## 👤 首次使用與登入

兩個入口：
- **領袖**：電郵＋密碼。新團未有帳戶 → Apps Script 執行 `issueSetupKey()`（72 小時 KEY）貼上領袖登入頁。
- **團員／執委**：同一個門，YMIS＋密碼。執委身份**跟名冊**，換屆改名冊即可。首次開戶密碼 `1234`（申請或後台／批量開戶）。

想睇齊流程、未加入嘅旅團：首頁揀 **試用示範（MOCK）**。

### 更新 Code.gs 之後要唔要 Run Setup？

| 情況 | 要做咩 |
|---|---|
| **第一次**起後端 | 貼上 Code.gs → 執行 **`initializeSheets`**（建分頁＋出 API Key）→ **部署**做網頁應用程式 |
| **之後只係更新程式**（例如加咗 `issueSetupKey`） | 全部取代貼上 → 儲存 → **部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署**。**唔使再跑 `initializeSheets`**（跑咗亦唔會清資料，淨係補缺嘅分頁） |
| 要一條開團 KEY | 函數選 **`issueSetupKey`** → 執行（同初始化無關；每次 72 小時，過期再執行） |

`initializeSheets` 唔係每次更新都要跑。只有新 Sheet、或者教學話「補建某某分頁」先需要。

---

## 📱 公開功能連結（成員免登入使用）

| 網址 | 功能說明 |
|---|---|
| `/?u=0123` | 執委會管理後台（領袖／執委登入） |
| `/entry.html?u=0123` | 成員手機拍照快速記帳與報銷申報 |
| `/borrow.html?u=0123` | 成員物資借用線上申請 |
| `/notice.html?u=0123&n=<通告編號>` | 活動通告查閱與 RSVP 出席回覆 |
| `/constitution.html?u=0123` | 旅團團章中英對照公開查閱頁面 |

---
COPYRIGHT 2026 執委管理系統 & Scout System
