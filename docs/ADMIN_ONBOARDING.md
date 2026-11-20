# 管理員手冊：Portal 接入既有 BADGE 後端

> **這不是新團開團、搬帳戶或部署新 Sheet／GAS 的流程。** Portal 完整版與 BADGE 輕量版必須使用旅團目前同一個 BADGE `/exec`、API Key、Sheet、`Users` 帳戶及業務資料。不得建立第二身份來源、帳戶表或資料來源，也不得要求匯出／匯入／複製帳戶。
>
> **目前狀態：正式共用 action contract 尚未完成真 Apps Script staging。** 裸 BADGE v9.6 的原生登入／帳戶 actions 與 Portal contract 不相同。單純登記既有 URL／Key、收到 ADMIN 申請或看到 `backendReady` 都不等於已開通。詳見 [`BACKEND_SYNC.md`](BACKEND_SYNC.md)。

## 1. 收到 Portal 接入申請

申請表收集旅團編號／名稱、目前 BADGE 正式 `/exec`、同一 deployment 的 API Key 及聯絡資料，經同源 `POST /api/proxy` 轉發到固定 ADMIN 收件匣。

這是申請通知，不是 Vercel Registry 寫入 API。它不會更改環境變數或自動啟用 Portal。只在 ADMIN 收件匣明確回傳 `receipt: true` 時，才可向申請人表示已取得收件回執；一般 HTTP 成功／申請送出結果不應描述成 ADMIN 已確認收到。結果未知時不要自動重送同一操作，先按 operation ID 查證。

申請中含敏感 API Key；只用核准的管理管道處理，不能貼進 Git、issue、截圖、一般聊天或公開日誌。

## 2. 開通前：核實正式後端契約

### 裸 BADGE v9.6 實際契約

- 登入：`login`，使用 BADGE `Users`，回傳 BADGE `token`。
- 帳戶／身份管理：`addUser`、`bulkAddUsers`、`resetPassword`、`updateUserProfile`、`setUserStatus`、`deleteUser`、`updateUserRole`／`updatePermissions` 等；管理操作需有效登入 token 及 BADGE 角色授權。
- 密碼自助復原：`requestPasswordReset`／`completePasswordReset`。
- Progress／履歷：`load`、`save`、`saveOtherBadge`、`requestComplete`、`getPendingRequests`、`reviewRequest`、`getLogRecords`、`saveLogRecord`、`deleteLogRecord`、`requestLogRecord`、`getLogRequests`、`reviewLogRequest`、`cancelLogRequest` 等原生路徑。

Portal 目前登入／帳戶呼叫 `authLogin`、`authWhoAmI`、`authOpenAccounts`、`authCreateAccount`、`authResetPassword`、`authDeleteAccount`、`authRestoreAccount`、`authForgotPassword`、`authCompletePasswordReset`、`authChangePassword`；Portal 一般行政資料另有 `loadDb`／`saveDb`／`loadTables`／`saveTables` 等 contract。裸 BADGE v9.6 不會因 Portal proxy 有 allowlist 就自動實作這些 handlers。

### 正式 adapter 的責任位置與邊界

正式相容層應由持有 BADGE `Users`、session token、Progress handlers 及權限規則的 **BADGE Apps Script source** 維護，並部署到旅團目前那個 Apps Script 專案與既有 `/exec`。Portal repo 可維護 client contract、Vercel Registry／proxy 及回歸測試；不能在 Portal 加第二個身份庫或把 API Key 當成登入。

升級必須原地保留同一個 Sheet、GAS project、API Key、deployment URL、BADGE 原生 action、使用者及資料；如 Portal 需要新的業務欄位／分頁，必須由核准的正式 adapter 在同一既有 Sheet additive 處理，不可複製 BADGE 帳戶／Progress 到另一來源。只有經核准的 staging 和回退測試完成後，才能更新正式 BADGE deployment。

`apps-script/unified-src/`／`apps-script/UnifiedCode.gs` 是隔離測試組合，不是可直接貼入旅團正式 Sheet 的 adapter release。此 Portal repo 目前尚無已驗收的正式 BADGE compatibility release；未完成前不要登記 Portal Production 或對外稱已開通。

## 3. Vercel Registry（只在正式 staging 全部通過後）

在正確的 Vercel project／environment 設定同一 BADGE deployment 的三項資料：

```dotenv
TROOP_0100_NAME=第一百旅深資童軍團
TROOP_0100_BACKEND=https://script.google.com/macros/s/<既有 BADGE deployment>/exec
TROOP_0100_APIKEY=<同一既有 BADGE deployment 的 API Key>
```

設定到實際使用的 Production／Preview／Development environment 並 Redeploy。不要把 URL／Key 寫入 `data/units.json`、browser 或另設 `PROGRESS*`／`PORTAL*` secret。`/api/units` 不會回傳 URL／Key。

`backendReady` 只證明 Registry 解析到可信任 URL／Key；不證明 action 已安裝、session 可互通、帳戶共用或業務資料可讀寫。

## 4. 正式開通 checklist

未完成 staging 前，以下項目維持「未通過」，不可標為開通：

```text
□ 申請資料指向旅團目前正在使用的 BADGE /exec 與同一 deployment API Key
□ 正式 adapter 已進 BADGE source of truth，且部署於既有 Apps Script project／deployment
□ 沒有新建生產 Sheet/GAS、第二帳戶表、第二密碼或帳戶匯出／匯入／搬移
□ BADGE 原生 login／token 及原生 action 仍正常
□ 同一既有 BADGE Users 帳戶可在 BADGE 與 Portal 登入並回讀同一 YMIS／身份／狀態
□ Portal 批次開戶落入同一 BADGE Users；BADGE 能立即用新帳戶登入
□ 密碼重設、停用／復原、角色／can_tick／allowed_badges 兩邊一致，舊 session 按規格失效
□ BADGE 與 Portal Progress／履歷操作寫入並讀回同一張 Sheet
□ member／執委／領袖／團長權限及 action allowlist 均經真後端測試；未授權 action fail closed
□ 偽造 session／role／YMIS／API Key／backend URL 及跨旅團請求均被拒絕
□ 真 Apps Script staging、並發／Lock、資料保留及回退測試有可核對證據
□ 以上通過後，才在 Vercel 設定 NAME／BACKEND／APIKEY、選對 environment 並 Redeploy
□ `/api/units` 不洩漏 URL／Key；另以真登入及讀寫測試確認整合（不以 backendReady 代替）
□ 通知旅團已驗收開通（不能把申請收件回執當作開通通知）
```

## 5. 不得使用的舊流程

- 不得叫團方建立新 Google Sheet、新 Apps Script project、新 Web App 或第二個 `/exec`；
- 不得要求貼 `UnifiedCode.gs`、執行測試 bundle 的 `initializeSheets` 或建立空白 Sheet；
- 不得要求團方搬移／複製／匯出／匯入 BADGE 使用者、密碼 hash、名冊或 Progress；
- 不得以 Portal 原有 `accounts[].pw` 或 `apps-script/Code.gs` 作為 BADGE Users 的替代品；
- 不得只靠 Vercel proxy allowlist、`backendReady`、Unified VM 或申請回執宣稱共用後端已完成；
- 不得在未驗證資料保留前對既有 Sheet 執行清空、重置或未核准 schema migration。

## 相關文件

- [`BACKEND_SYNC.md`](BACKEND_SYNC.md)：實際 action、登入／session、帳戶、Progress、權限及 Registry 差異
- [`ADD_NEW_UNIT.md`](ADD_NEW_UNIT.md)：舊檔名保留的 Portal 接入既有 BADGE 說明
- [`UNIFIED_NEW_SHEET_SETUP.md`](UNIFIED_NEW_SHEET_SETUP.md)：已退役的舊部署指引（不可照做）
- [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md)：正式既有 BADGE backend staging 記錄