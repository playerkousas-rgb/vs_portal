# CHANGELOG

版號唯一來源：`assets/js/lib/version.js`（`APP_VERSION`）＋
`assets/js/lib/gastemplate.js`（`BACKEND_VERSION`）—— 兩者必須一致（V1／F15）。

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
