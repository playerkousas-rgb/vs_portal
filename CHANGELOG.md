# CHANGELOG

版號唯一來源：`assets/js/lib/version.js`（`APP_VERSION`）＋
`assets/js/lib/gastemplate.js`（`BACKEND_VERSION`）—— 兩者必須一致（V1／F15）。

---

## v2.8.7 — 2026-11-12

**UI 簡化：一個功能一個入口 ＋「無權就唔准入」**

用家原話：「我在 APP 內看到太多重複的東西了，東指西指，又有很多副標題。」
審計報告：[`UI_AUDIT_2026-11-12.md`](UI_AUDIT_2026-11-12.md)（含量化點算＋角色實測）。
用家定案：全面簡化／執委無權就唔准入（唔係唯讀）／財政分頁收斂到 6 個。

### 導覽：兩份人手清單 → 一個登記冊（F3）
- `main.js` 以前有 `VIEWS`（路由）同 `NAV`（側欄）**兩份**人手清單，結果 `tables`
  有路由但側欄冇登記 = **孤兒頁**，只可以靠其他頁嘅文字連結入去。
  而家 `NAV` 係唯一登記處（每項自帶 `view` ＋ `perm`），`VIEWS` 由佢推導，唔會再漂移。
- **「資料管理」升做側欄獨立入口**（`#/tables`），唔再係「系統」底下嘅分頁。
- **「教學」搬去頂欄**一鍵入口。佢本來喺側欄，但如果收埋入「系統」，
  執委（冇 `admin.units`）就會連說明都睇唔到 —— 所以放頂欄，全部身份都搵得到。

### 刪除重複入口（東指西指）
- **刪走 `accounts.js` 嘅 `dataView()`（73 行）**：佢係一個純指路頁，3 張卡
  淨係叫你去 `#/tables` 嗰 3 個分頁，而 `tables.js` 又有一粒掣指返嚟 —— **兜圈**。
  「系統」而家得返 **旅團設定／操作紀錄** 兩個分頁。
- 刪走 `tables.js` 入面「去『資料管理』備份／還原」嘅自我指路掣（佢指去自己）。
- **財政 8 → 6 個分頁**：
  ①「年度報告」本來**同時有頂部掣 ＋ 分頁**（重複入口）→ 只留頂部「年結報告」掣；
  ②「匯入舊帳」係一次性搬舊數嘅工具，唔係日常操作 → 併入「設定」底部一個
  　`<details>`（預設收埋）。**功能一樣都冇刪**，輸入框／預覽／匯入掣全部保留。
- **舊連結全部照樣行得**（唔會斷書籤）：`#/admin/data` → `#/tables`；
  `#/finance/import` → 設定頁並**自動展開**匯入區。

### 權限：無權就唔准入（用家定案）
實測發現兩個真問題（詳情見審計報告丙部）：
- **執委入到「系統 → 旅團設定」**：14 個輸入框打得到字，但 3 粒儲存掣全部係灰嘅（disabled），
  完全冇解釋 —— 用戶會以為壞機。
- **執委入到「資料管理 → 總表同步」**：4 個輸入框（含 API-Key）打得到字，
  「儲存設定」仲要係**撳得落**嘅，因為 `save-sync` handler **完全冇權限檢查**。
  影響有限（只寫本機 `commitMeta()`；`api/proxy.js` 用伺服器環境嘅 URL／Key，
  所以**唔會洩密、唔會跨旅團寫入**），但會造成「改完之後自己睇唔到資料」嘅幽靈故障。

修正（fail-closed，三層）：
1. `render()` 逐 section 檢查登記冊嘅 `perm`，冇權 → `renderNoAccess()` 告示頁
   （有「返儀表板」／「睇教學」掣，**唔會困死用戶**）。
2. 側欄／「更多」選單／手機底欄只顯示有權嘅項目。
3. `tables.js` 嘅 `render()` ＋ `mount()` 再各自擋一次；`save-sync` handler
   自己檢查 `table.sync`（就算將來有人直接 call 都寫唔到）。

**順手修一個會被呢次改動引爆嘅陷阱**：頂欄「改密碼」掣本來係 `go('#/admin/data')`
—— 嗰頁根本冇密碼表單，而且「系統」而家對執委封閉，會變成**連自己密碼都改唔到**
（`admin.pw.self` 超管／領袖／執委都有）。改為直接開 `ownPasswordForm()` 彈窗。

### 副標題／說明文字
- 刪走純屬「把分頁名再讀一次」嘅副標題（資料管理「三樣嘢：…」、系統「…／資料管理／操作紀錄」）；
  動態資料（結餘、日期、人數）同表單指示**全部保留**。
- 「公開資料」副標題唔再叫人「要改去『旅團設定』或各自嘅頁」（每張卡自己已經有掣）。
- **修正 48 處因為拆走舊架構而變錯嘅指示／連結**：全 repo 嘅
  「系統 → 資料管理 → …」→「資料管理 → …」；「財務 → 財政年度報告」→「財務 → 年結報告」。
  亦將財務／進度頁仍然指去 `#/admin`／`#/admin/data` 嘅內部按鈕直接改去真正分頁，
  連 Apps Script 狀態回應嘅使用提示都一併修正。唔改嘅話用戶照住撳會兜路或撳唔到。

### 新增守門（兩個都實測注入驗證過）
- **`tests/ui-ia.mjs`（44 斷言）**：登記冊／舊連結轉址／分頁數量／執委拒絕／
  `save-sync` fail-closed／改密碼唔可以跳去被禁頁／領袖團長功能冇被收走。
  注入「改密碼跳返 `#/admin/data`」＋「拆走 tables 權限閘」→ 乾淨 2 ✗、exit 1；還原 → 44/0。
- **`scripts/lint.mjs` §⑧**：唔准再出現指去已拆走導覽路徑嘅文字。
  注入一句「系統 → 資料管理」→ 紅燈並指出檔案行號；還原 → 21/0。
- 已加入 `npm test`（`tabs.mjs` 之後）＋ `npm run test:ia`。

### 測試契約更新（唔係放寬斷言）
- `tests/tabs.mjs`：系統分頁 `['unit','data','audit']` → `['unit','audit']`；
  財政分頁移除 `reports`／`import`；`#/admin/data` 嘅「備份」檢查搬去 `#/tables/data`。
- `tests/smoke.mjs`：本來驗「指路卡有 `data-go` 連結」→ 改驗**真正入口**
  （舊 hash 轉址 ＋ 真嘅 `data-tab` 分頁掣）。

### 後端
- **冇改任何 GS 邏輯**。`Code.gs` diff 只係檔頭／`BACKEND_VERSION` 版號字串
  （由 `version.js` 推導），以及 `doGet()` 狀態回應入面一行已過時嘅導覽提示。`build:gas` sha256 可重現。
- 用戶資料／API Key **完全唔受影響**；唔需要跑 `initializeSheets()`。

---

## v2.8.6 — 2026-11-12

**GS 死碼精簡（襯未真正有人用之前拆走，唔會越積越腫）**

背景：`Code.gs` 已經 3545 行。實測發現一批「後端有 handler、白名單又放行，
但前端根本冇人 call」嘅孤兒代碼 —— 呢啲唔會令任何測試紅燈，所以一直靜靜雞累積。
對應 UI 大部分喺 2026-09-26 團長要求拆掣時已經拆走，但後端函數同測試夾具留咗度。

### 刪除（GS）
- **2 個真死函數**：`linkNonceGs()`、`setLocalLoginAllowed()`（邏輯早已內聯喺
  `menuLocalLoginOff/On` ＋ `setLocalLogin` handler，冇任何呼叫者）。
- **6 個孤兒 action**（handler ＋ `SUPPORTED_ACTIONS` ＋ 兩個代理白名單）：
  `claimDecision`、`loanDecision`、`noticeSubscribe`、`noticeSubscriptions`、
  `authChangePassword`、`authResetByToken`。
  前端對應功能係純本機（例如 `auth.js` 改密碼），從來冇 call 過呢啲 action。
- **`diag` 自查鏈**：`diagnoseBackendTabs()`（109 行）＋ `doPost`／`doGet` 分支
  ＋ `api/progress.js` 嘅 diag 分支（35 行）＋ 白名單 entry。

### 刪除（前端 `assets/js/lib/remote.js`）
- 8 個屍體函數：`remoteDiagnose`、`backendHealth`、`backendReality`、`syncProbe`、
  `repairBackend`、`forcePushBackend`、`testConnection`、`testReadWrite`
  ＋ 只服務佢哋嘅 `FIX_ENV`／`firstBlocker` ＋ 未用嘅 `shortExec` import。

### 刻意保留（唔係死碼）
- **舊 blob 讀寫路**（`saveDb`／`dbRawText`／`loadDbPart`…）：`dbReadRaw` 仍然會
  fallback 去呢條路，而 `0082` 已經登記咗 —— 刪落去隨時讀唔返現有用戶資料。
- **人手逃生門**：`repairDb`／`saveDbForce`／`cleanStaleStaging`／`pruneOldDbVersions`
  ／`syncCheck` —— `DEPLOY_GUIDE_FOR_TROOPS.md` 嘅搶救步驟靠佢哋。
- `verifyAgainstBackend()`（`syncdialog.js` 用緊）、`checkSheetWriteRead()`（`saveTables` 用緊）。

### 新增守門（防止再腫）
- `scripts/lint.mjs` **⑦ 孤兒 action 守門**：後端有 handler 但前端冇人 call → **紅燈**。
  要保留就要喺 `INTENTIONAL_NO_CALLER` 登記＋寫低原因（而家登記咗 6 個：
  `ping`／`status`／`test` 探活、`repairDb`／`saveDbForce` 人手搶救、`syncCheck` 自證）。
  登記冊本身亦有過期檢查（已刪或已接返前端嘅要移走）。
  已實測：注入一個假孤兒 handler → 即時紅燈；移除後回復綠燈。
  （原本 ④ 只守「前端有 call → 後端要有」，方向相反，捉唔到呢類腫脹。）

### 測試（唔係刪測試就當綠）
凡是原本用死函數做「驗證手段」去測其他真實行為嘅，全部改用生還嘅路徑重建，
覆蓋冇減少，有啲更硬：
- `tests/e2ereal.mjs`：diag 斷言 → **直接讀 Sheet**（`/_tabs`）＋ `status`
  （唔再信後端自我報告，改驗真正寫咗落去資料）；`checkReadWrite` fixture
  → 直接經真 proxy 打 `syncCheck`；同步診斷 → `remoteInfo` ＋ `verifyAgainstBackend`。
- `tests/reality.mjs`：改用 live `verifyAgainstBackend()`，仍然驗齊
  「未撳掣對唔上 → 撳咗對得上 → 第二部機讀得返 → Key 錯要拒且唔盲寫」。
- `tests/remote.mjs`：5MB 分段讀 → 直接叫 live `pullDb()`（驗真正嗰條路）；
  搶救三寶一節 → 改驗「介面唔可以加返掣」＋「後端逃生門仍放行」＋「屍體唔准翻生」。
- `tests/gas.mjs`：「重設密碼後舊 session 立即失效」由已刪嘅 `authChangePassword`
  搬去 live `authResetPassword`（同一個 `revokeAuthSessions()` 機制），並加對照組。
- `tests/progress.mjs`：diag 一節 → 釘死「已移除嘅 action 唔可以再放行」。
- `tests/selfserve.mjs` / `tests/simplewrite.mjs`：診斷／實況 → `remoteInfo`／`verifyAgainstBackend`。

### 實測結果
- `Code.gs`：**3545 → 3289 行**（−256 行，−8.0%；204092 → 187730 bytes）。
- `assets/js/lib/remote.js`：**1870 → 1218 行**（−652 行，−34.9%）。
- 全部閘門綠：lint **20/0**、guard **PASS 17**、repo_health **8/2/0**（2 個 WARN 係既定版權保留）、
  `npm test` **exit 0 / 0 失敗**、`build:gas` sha256 可重現。
- **用戶資料／API Key 零影響**：純刪冇呼叫者嘅代碼，冇改任何寫入路徑或金鑰邏輯。

### 抓到的自身錯誤（如實記錄）
一次性刪除腳本用 `^function name(...)...^}` 正则，對**單行**函數 `linkNonceGs()`
會一路食到下一個行首 `}`，連帶刪走咗 live 嘅 `linkCanonicalGs()`（簽名驗證要用）。
`tests/gas.mjs` 簽名測試即刻 7 紅 → 已還原該函數，並用「全函數清單＋逐個函數體比對」
核實最終只有預期嘅 3 個頂層函數消失、其餘函數體一字不變。

---

## v2.8.5 — 2026-11-12

**按真理倉 README 對齊 ＋ 初始化資料保全（本 repo 係其他支部系統嘅參考模版）**

### 修復
- **測試時間炸彈（root cause）**：`tests/public.mjs` 嘅 fixture
  `tests/fixtures/units/TEST9/notices.json` 寫死 `deadline: 2026-09-28`。
  今日已過該日 → 公開頁判「已截止」→ 唔渲染報名表 → `form` 為 `null` →
  suite 中途 crash（`TypeError: Cannot read properties of null`）。
  **後果：`npm test` 實際 exit 1，而且後面 19 個 suite 從來冇跑過。**
  改法：讀 fixture 時將可報名通告嘅 `deadline`／`eventDate` 平移去相對今日嘅未來
  （滾動日期），產品邏輯零改動。修復後全套 **exit 0 / 0 失敗**。

### 新增
- `initializeSheets()` **可重跑而唔破壞用戶資料**（學 vsbadge `ensureUserColumns`）：
  補缺失分頁 ＋ **補缺失欄位**（舊 Sheet 而家升得到新欄）、只補缺失設定預設值、
  現有資料零改寫、`API_KEY` 不變、idempotent。
- `INITIALIZED_VERSION` ScriptProperties 標記 ＋ `status` 回報
  `initializedVersion` / `initializationCurrent`（「已更新 GS 但未初始化」三態）。
- `tests/init-preserve.mjs`：初始化前後逐表快照對比 ＋ idempotent ＋ API Key 不變。
- `tests/boundary.mjs`：系統樹邊界守門（禁止跨支部直連）。
- 治理檔：`SCOPE.md`（含系統樹星形邊界）、`AGENTS.md`、`GLOSSARY.md`、
  `CONTRIBUTING.md`、本檔、`.env.example`。
- 由真理倉抄入 `scripts/`：`guard.mjs`、`final_check_v1.0.mjs`、
  `repo_health_v1.0.mjs`、`preflight_v1.0.mjs`、`check_skills_v1.0.mjs`。

### 對齊修正
- `.vercelignore`：目錄條目改帶斜線（S2）；實際部署清單不變（80 檔）。
- `.gitignore`：加 `!.env.example` 例外（原本被 `.env.*` 擋走，令範本檔入唔到 Git）。
- F15：35 處歷史註解由 `// vX.Y` 改寫成「自 vX.Y 起…」敘述式
  （**保留全部版號同歷史事實**，只改表達方式）。
- **版號真正單一來源**：Code.gs 檔頭 以前獨立寫死 `v2.8.4`，
  升 `BACKEND_VERSION` 就會漏改（升 v2.8.5 嗰陣實際紅咗）。而家兩者都由
  `version.js` 嘅 `APP_VERSION` 推導；並補上 `scripts/lint.mjs` §⑥
  真正嘅一致性閘門（`version.js` 註解一直聲稱 lint 會擋，但其實冇呢個檢查）。
- `tests/gas.mjs` / `tests/simplewrite.mjs`：版號斷言改為由 `version.js` 推導，
  唔再寫死某個舊版號（語義不變：驗三邊一致，而唔係等於某字串）。
- `.github/workflows/guard.yml`：Actions 釘 40-hex SHA（A16）；
  按 PREFLIGHT.md 建議只用 `pull_request` + 每週 cron + 手動，唔用 `push:['**']`。
- `DEPLOY_GUIDE_FOR_TROOPS.md`：更新指示改為「**每次更新 Code.gs 都跑一次
  `initializeSheets()`**」（舊文寫「唔使再跑」，因為舊版唔會補欄）。

### 實測結果（2026-11-12）
- `npm run lint` → **18 通過 / 0 失敗**（新增 4 項版號閘門）
- `npm test` → **exit 0**，25 個 suite 全部跑完、**0 失敗**
  （新增 `init-preserve` 43／`boundary` 24；`gas` 263／`remote` 289／`simplewrite` 70）
- `node scripts/guard.mjs` → **GUARD PASS 17 項全綠**（對齊前係 12 FAIL）
- `node scripts/repo_health_v1.0.mjs .` → **PASS 8 / WARN 2 / FAIL 0**
  （2 個 WARN 都係 LICENSE，屬用戶定案嘅已知豁免）
- `npm run build:gas` 兩次 sha256 一致（生成檔冪等）
- **未真機驗證**：GAS 302 轉址／Drive 權限／ScriptProperties 配額／`onOpen` 授權
  仍未喺真實 Google 部署跑過（本地 VM 模擬器唔等於真機）。

### 已知豁免
- `EXCEPTION: LICENSE` — 用戶選擇版權保留，唔加 LICENSE 檔。
- `EXCEPTION: S3/S4` — 根目錄純靜態、零 build、零 runtime deps。
- `EXCEPTION: L1` — 雙語規則明寫唔追溯現有 repo。

---

## v2.8.4 及之前

歷史紀錄見 `README.md` 頂部同 `docs/UPDATES_*.md`（逐日詳細記錄）。
