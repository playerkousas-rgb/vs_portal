# 統一 GS 隔離測試版（支部獨立；預留未來旅系統接口）

> **狀態：只供本 repo／本分支私人測試。** 這不是 `vsbadge` 發佈版，沒有部署、沒有推送到 `vsbadge`，亦不會自動影響任何現有旅團。
>
> **施工次序（2026-11-12 用戶更正）：BOOK → BADGE → 5 個支部系統（現在）→ 旅系統（最後）。**
> 現在沒有中央旅系統；支部本地帳戶／session 是正常主入口，`ALLOW_LOCAL_LOGIN` 必須保持 `true`。
> assertion／exchange 是第 4 階段預留接口，未有 signer 不阻擋第 3 階段支部獨立驗收。
>
> 測試產物：[`apps-script/UnifiedCode.gs`](../apps-script/UnifiedCode.gs)
> 重建：`npm run build:gas:unified`
> 自動測試：`npm run test:unified`

## 1. 拓撲：現在與第 4 階段

### 1.1 現在（第 3 階段）

```text
每支部一張共用 Sheet＋一支 UnifiedCode.gs
  ├─ 支部 Users／本地密碼／opaque session（正常日常登入）
  ├─ BADGE：進度、獎章、履歷、申報
  └─ 支部行政：財務、物資、會議、通告、報名、完整名冊
       ├─ 完整支部前端（vs_portal）
       └─ 輕量進度前端（vsbadge）
```

#### 已採用的成員／區系統參考模式

本架構按 `member-portal@e7aafdce` 與 `scout-district-portal@6997ae7c` 的主 Sheet 模式校正：

- 兩個前端共用同一張主 Google Sheet、同一份 `Code.gs`、同一個 `/exec` 及同一 API Key；
- 前端不互相接駁，只各自以 action allowlist 經 server proxy 呼叫同一 GAS；
- GAS 按 action 直接讀寫同一張 Sheet 的不同分頁；
- 分頁存在但沒有資料時回成功空集合／0 項，不得當成連線失敗；
- 登入閘門、未來上游或另一前端的狀態，不得成為讀取本 Sheet 進度分頁的前置檢查。

因此第 3 階段進度頁只顯示「同一 Sheet 資料來源」及實際讀取結果，不執行 `getLinkState`，也不顯示前端之間的「接駁」控制。`getLinkState`／`setLocalLogin` 只保留為底層第 4 階段契約與伺服器防誤關測試。

### 1.2 第 4 階段目標（旅系統建立後才啟用）

```text
一張中央旅系統 Sheet
  ├─ Users：唯一登入身份
  ├─ Memberships：每人在哪個支部及其角色
  ├─ Units：每支部的登記／接駁資料
  └─ 90 秒簽署 assertion
          │
          ▼
vs_portal /api/portal（驗 issuer、audience、unit、role、exp、jti）
  └─ 60 秒、單次使用、指定支部的 exchange token
          │
          ▼
每支部一張共用 Sheet＋一支 UnifiedCode.gs
  ├─ vsbadge v9.6：Users 授權鏡像、進度、獎章、履歷、申報
  ├─ 支部行政：財務、物資、會議、通告、報名、完整名冊
  └─ 同一個 8 小時 opaque session
       ├─ 完整支部前端（vs_portal）
       └─ 輕量進度前端（vsbadge）
```

不是「全組織永遠兩張 Sheet」。第 4 階段完成後的目標數量是：

- 中央旅系統：**1 張**（現在尚未建立）；
- 每個支部：**各 1 張共用 Sheet**；
- 支部完整介面和進度介面只是兩個前端，不能各自另建業務資料或帳戶。

## 2. 資料權威來源

| 資料 | 權威來源 | 說明 |
|---|---|---|
| 現階段支部登入帳戶／密碼 | 支部 `Users` | 正常日常身份來源；PBKDF2 hash 留在該支部 Sheet |
| 現階段支部角色／action scope | 支部 `Users`＋server-issued session | 角色名稱與 action scope 兩者都要通過 |
| 支部名冊及行政資料 | 該支部共用 Sheet | 完整支部前端讀寫此處 |
| 進度、獎章、履歷、待批申報 | 同一張支部 Sheet | 保留 vsbadge v9.6 原有表格及流程 |
| 第 4 階段中央帳戶／會籍 | 未來中央旅系統 | 旅系統建立後才成為 SSO 權威；現在不存在 |
| 第 4 階段支部 SSO 鏡像 | 支部 `Users` | 無密碼授權映射，不取代現階段本地帳戶，直到遷移另行驗收 |
| API Key | 該支部 Apps Script `ScriptProperties` | 初始化只在完全缺失時建立，永不輪換既有 Key |

### 支部 `Users` 的兩個階段

vsbadge v9.6 的角色授權與歷史資料以 YMIS／`Users` 為錨點，因此統一版保留它：

1. **現在（第 3 階段）**：本地帳戶保留 PBKDF2 hash，是支部正常日常登入；不可稱作救援帳戶，`ALLOW_LOCAL_LOGIN` 保持 `true`。
2. **未來（第 4 階段）**：旅系統存在後才可加入 `password_hash` 為空、`auth_by=central-sso` 的支部授權鏡像。中央 assertion 不得提高既有本地帳戶角色上限；是否關閉本地入口要在完整遷移及回退驗收後決定。

## 3. 第 4 階段預留：SSO 流程與密鑰分工

### 3.1 三段短票

1. 中央旅系統簽發最長 90 秒 assertion：
   `{u, sub, role, name, iss, aud, iat, exp, jti}`。
2. `/api/portal` 驗證 assertion 並消耗其 `jti`，再簽發最長 60 秒的
   `typ=central-sso-exchange` purpose token；它**不是 app session**。
3. 瀏覽器立即經 `/api/proxy` 呼叫 `authPortalExchange`。支部 GS 驗簽並消耗第二個 `jti`，才簽發 8 小時 opaque branch session。purpose token 隨即丟棄。

支部 GS 以共享 `ScriptCache` 保存已使用的 `jti`，並用 `ScriptLock` 將 `get`＋`put` 包成原子區段；Cache／Lock 任一不可用都 fail closed。網址中的 assertion 兌換後會由 `history.replaceState` 移除，避免留在 history／截圖。

### 3.2 一個 API Key、三個用途分隔 key

每支部只保留既有 `API_KEY`。中央 issuer、Vercel 及該支部 Unified GAS 按用途派生不同 HMAC key：

| purpose | 用途 |
|---|---|
| `vs-portal-central-assertion-v1` | 中央 issuer 簽、Vercel `/api/portal` 驗最長 90 秒 assertion |
| `vs-portal-branch-exchange-v1` | Vercel 簽、目標 Unified GAS 驗最長 60 秒 exchange |
| `vs-portal-branch-exchange-jti-v1` | 由 `unit + assertion jti` 決定單次 exchange jti |

派生公式為 `hex(HMAC-SHA256(key=API_KEY, message=purpose))`。各用途 token 仍要固定 `typ`、`iss`、`aud`、`unit`、角色與時間窗；另一旅團的 API Key 不可驗證。

不要設定 `TROOP_<ID>_PORTALSECRET`、`TROOP_<ID>_PORTALSESSIONSECRET` 或 GAS `PORTAL_SESSION_SECRET`。API Key 只可留在 server 端作 routing／HMAC 根，不是使用者身份。

## 4. 角色與 action scope

| 有效角色 | 必須 scope | 可用範圍 |
|---|---|---|
| `member` | `identity:read branch:read progress:self` | 本人資料／本人進度；不可寫行政資料 |
| `exco` | 加 `branch:write progress:manage` | 一般行政讀寫及進度管理 |
| `leader`／`chief`／`admin` | 再加 `identity:manage branch:repair` | 帳戶授權管理、修復／強制救援操作 |
| 平台 `super` | Vercel 8 小時 HMAC session＋server-to-server sig | 隱藏救援；不把 SUPER_KEY 或 session 交給 GAS／瀏覽器 action |

安全規則：

- 前端自報 `role`、YMIS、姓名不作授權依據。
- 管理前端未登入時不再先拉 `loadDb`：先由 `authLogin`（或同源 `/api/auth` 超管）取得 server-issued session，staff 才載入完整行政資料；避免「loadDb 要 session、但舊流程先 loadDb 才登入」循環。
- `/api/proxy` 對行政 action 先呼叫同一支 GS 的 `authWhoAmI`；API Key 只供 server 路由，不是用戶登入。Portal `Code.gs` 直連 `/exec` 亦要求 branch session；網絡 body 自報內部 `__serverSigned` marker 會先被刪除。首次建置由有效開團 KEY 換取短期 setup session，不以 Key 冒充身份。
- GS 再做一次角色及 scope 驗證；只有其中一層通過並不足夠。Unified router 驗證 actor 後只在記憶體注入 delegated role／subject 與 pinned baseline 產生的 identity map；compatibility 的 `saveTables`、整庫、分件 commit、`sync`、force restore 會再逐欄核對。網絡入口會刪除所有同名 marker。
- `members[].identity`、帳戶 role／memberId／password／刪除紀錄屬受保護欄；exco 不可藉一般行政 save 升權，leader 不可改自己或團長。Unified 的 `accounts` 只可由中央 Users 無密碼投影重建。
- 第 4 階段中央 assertion 的角色不能提高現階段既有支部本地帳戶的角色上限。
- 進度個人 action（`loadMine`／`addRequest`／`myRequests`）由 server session 固定 YMIS，再以支部 Key 簽 server-to-server request；瀏覽器偽造 YMIS 會被丟棄。
- 團員入口不准呼叫行政 `loadDb`／`saveDb`。`hubLoad` 只回本人名冊及按 server 角色過濾的內容；event／quiz／notice 逐層以**正面欄位白名單**重建（包括 question、本人 RSVP／response），絕不使用「clone 全紀錄再刪已知敏感欄」；未來新增行政欄預設不會外洩。
- 團員投影存入獨立 `hub`／`hubbase` localStorage namespace；`remote.js` 在非 hub scope 採用投影會回 `HUB_SCOPE_REQUIRED`，不可能覆蓋同瀏覽器行政工作副本。
- `hubRsvp`／`hubQuiz`／`hubAbsence` 的 memberId、YMIS、姓名、角色全部由 opaque session 推導；client 同名欄位即使偽造亦不採用。前端不先樂觀改本機，成功回新投影才顯示；失敗保留可重試狀態。請假固定 request id，create／withdraw 重試為冪等。

## 5. Action 路由對照

### vsbadge v9.6 原路保留

- 身份及帳戶復原：`login`、`logout`、`changePassword`、忘記密碼；
- 進度：`load`、`save`、`saveOtherBadge`；
- 申報／審批：`requestComplete`、`reviewRequest`；
- 活動履歷：`getLogRecords`、`saveLogRecord`、`requestLogRecord`、`reviewLogRequest` 等；
- 用戶／權限、PBKDF2、HMAC 上下游、`ALLOW_LOCAL_LOGIN`、無損初始化。

### 統一層新增／轉接

| Action | 用途 |
|---|---|
| `authPortalExchange` | 中央 purpose token → 8 小時支部 session |
| `authWhoAmI` | opaque session → 安全身份／角色／scope |
| `authLogin` | 現階段完整支部前端的正常本地登入；受 `ALLOW_LOCAL_LOGIN` 控制（第 3 階段保持開啟） |
| `loadMine` | 只回 session 對應 YMIS 的進度／獎章／履歷／申報 |
| `addRequest`／`myRequests` | 個人申報 bridge，YMIS 由 server session 固定 |
| `hubLoad` | 團員入口安全投影：只回本人可見內容，不回完整行政 db |
| `hubRsvp`／`hubQuiz`／`hubAbsence` | 只寫 session 本人的出席、答卷、請假；寫完回新安全投影 |
| `loadDb`／`loadTables`／`saveDb`／`saveTables`／分件／`sync`／force | 舊完整行政介面兼容層；讀寫前做 session＋scope＋受保護欄位驗證 |

舊 Portal 的帳戶 action 不會路由到 namespaced compatibility module。第 3 階段帳戶由支部 BADGE `Users` 原生功能管理；舊 alias 會回 `BRANCH_IDENTITY_MANAGED`，避免重建第二身份來源。第 4 階段若中央 SSO session 嘗試在支部建立密碼或改中央身份，則回 `CENTRAL_IDENTITY_MANAGED`。

## 6. 無損初始化保證

`initializeSheets()` 依次執行：

1. 原裝 vsbadge v9.6 增補初始化；
2. 行政兼容分頁增補初始化；
3. 寫入 `UNIFIED_GS_INITIALIZED_VERSION=v9.6-u1-test`。

禁止事項：

- 不清空、不重建、不重新編號現有資料；
- 不覆寫既有帳戶、PBKDF2 hash、進度、獎章、履歷、待批紀錄；
- 不更換既有 `API_KEY`；
- 不把 Portal blob 內的 `accounts[].pw/password` 當身份來源；
- 不把某個前端的角色 query 當授權。

行政資料載入時，`members` 會與 `成員名單`／`Users` 合併；`accounts` 永遠由安全 Users projection 產生，不會保存 client 提交的 shadow account 或密碼欄位。

## 7. Source 與可回退性

```text
apps-script/unified-src/
  manifest.json                 # 版本、commit、SHA-256、test-only channel
  vsbadge-v9.6.gs               # exact upstream baseline
  portal-admin-v2.8.8.gs        # 已知生成 checkpoint；只在 IIFE 內作行政兼容
  unified-extension.gs          # 唯一公開 router／SSO／scope／projection

scripts/build-unified-gas.mjs                # 校驗兩個 pinned SHA-256 後才組裝
apps-script/UnifiedCode.gs                   # 生成測試產物
assets/js/lib/unifiedtemplate.generated.js   # 同一 bytes 的 app 內下載模組
```

組裝器寫 `UnifiedCode.gs` 與 byte-for-byte 對應的 browser download module，**不會寫**現行 `apps-script/Code.gs`。舊 Portal 的 89 個函式全部封在 IIFE，不能 shadow vsbadge v9.6 的 188 個全域函式；其歷史 Portal secret verifier亦在 composition 時停用，Unified exchange 是唯一票據入口。

`npm run build:gas:unified` 會先核對 pinned sources 的 SHA-256，再重建 `UnifiedCode.gs`；`npm run test:unified` 會重建後執行 VM fixtures。最終大小、SHA-256 與全套測試結果應以同一個待部署 commit 的 command output 為準，不在文件硬編可能過期的 generated hash。這些仍屬 VM／本機 HTTP 驗收，不取代下節真 Apps Script staging。

## 8. 私人驗收程序

1. 複製現有支部 Sheet 作測試副本；不要直接在正式 Sheet 首測。
2. 在測試副本貼入 `apps-script/UnifiedCode.gs`。
3. Script Properties 保留原 `API_KEY`；不要新增 `PORTAL_SESSION_SECRET`。
4. 執行一次 `initializeSheets()`；核對回傳 `preservedExistingData:true`。
5. 部署測試 `/exec`，本分支 Preview 只設定 `TROOP_<ID>_NAME/BACKEND/APIKEY`，並指向同一 Unified GAS。
6. 依次驗收，並保存時間、測試 deployment id、測試 Sheet id（可遮中段）及結果截圖／JSON：
   - 原 vsbadge 登入／進度／獎章／履歷仍可用；
   - 支部本地帳戶可進兩個前端，`ALLOW_LOCAL_LOGIN=true`；staff／member 身份只取 server-issued session；
   - member 不能寫行政資料；exco／leader scope 正確；
   - 團員入口只收到本人安全投影；在測試 event／quiz／notice 加一個未列入 schema 的 `STAGING_SECRET` 欄，回應不得出現；
   - 偽造 role／memberId、猜領袖內容 id、重放他人資料全部失敗；
   - RSVP／答卷／請假只改本人，同時保留其他成員原資料；故意在 server 已寫後切斷 client response，再按重試，不得產生兩張請假；
   - 兩個 client 同時修改不同成員／不同格，真 Sheet 最後必須兩項都存在；同格衝突須明確拒絕而非靜默覆蓋；
   - 完整介面新增成員後，進度介面立即看到同一 YMIS；進度介面勾選後，完整介面立即讀到同一筆；
   - 對測試 Drive folder 上載一張細圖：回應 URL 可讀、DB 只留 URL、刪除測試檔後無殘留；
   - 以測試收件地址執行忘記密碼／通知流程：`MailApp` 真正寄達，而且 log／回應不含 token 或密碼；
   - 初始化前後逐分頁保存 row/column/hash 快照；重跑 `initializeSheets()` 兩次後 API Key、hash、進度及行政資料逐筆不變，只可新增缺失分頁／最右欄。
7. 在 `docs/UNIFIED_STAGING_RESULTS.md` 填寫第 3 階段證據；任何適用項目未通過都不得改 Production。
8. 回退：將測試 deployment 改回原版本或貼回原 GS；不要把測試 URL／Key 放入 Production。

### 第 4 階段另行驗收（現在 DEFERRED）

旅系統真正建立後才測：中央 SSO 進入兩個前端；10–20 個並發相同 purpose token 只可一個成功；其他支部／過期／錯 key／重放全部拒絕；最後才測 `ALLOW_LOCAL_LOGIN=false` 而中央 SSO 仍可用。未全數通過不可聲稱旅系統已接通，但不影響上述支部獨立驗收。

## 9. 目前邊界

- 本 repo 已實作支部統一 GS、支部本地 session／action scope，並預留 Vercel assertion 驗證、purpose-token exchange 及前端兌換接口。
- 現在沒有中央旅系統；缺少 signer 是施工次序的預期狀態，**不阻擋第 3 階段支部獨立驗收**。第 4 階段開始後才按 §3 實作 signer；fixtures 不可冒充中央已完成。
- `apps-script/Code.gs` 仍是原 Portal 生成檔；私人驗收用的是獨立 `UnifiedCode.gs`。
- 先前未完成的 Portal `authChangePassword` 局部編輯沒有混入兼容 source；現階段本地帳戶照正常密碼流程，未來中央 SSO 身份則一律拒絕建立支部本地密碼。
- Node VM 測試會驗證 `CacheService`／`LockService` 呼叫、TTL、重放及競態防護合約，但不等於 Google Apps Script 真實 runtime；§8 的測試副本仍須實測真 Cache／Lock、Drive、Mail 及 Sheet 配額行為。
- 未經明確驗收批准，不更新 `vsbadge`、不開 Production PR、不部署正式環境。
