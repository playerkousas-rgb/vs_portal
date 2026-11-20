# Portal／BADGE 共用旅團既有後端：架構與驗收邊界

> **目前狀態：正式共用尚未驗收。** Portal 完整版要使用旅團目前的 BADGE `/exec`、API Key、Google Sheet、`Users` 帳戶、名冊與業務資料。不得為 Portal 新建生產 Sheet／GAS、另建身份／帳戶表／資料來源，亦不得要求搬移或複製帳戶／資料。
>
> `apps-script/UnifiedCode.gs` 與 `apps-script/unified-src/` 目前是 `isolated-test-only` 測試組合，並非正式 BADGE adapter 或部署指引。

## 1. 目標拓撲

```text
Portal 完整前端 ──同源 Vercel Registry／Proxy──┐
                                               ├──旅團目前使用的 BADGE /exec、API Key、Sheet、Users
BADGE 輕量前端 ────────────────────────────────┘
```

Portal `/api/proxy` 從 server Registry 取既有 `/exec`／API Key，忽略 browser 提交的 URL／Key 並只轉發 allowlist 內 action。Proxy 不會轉換 Portal auth action，也不會替 Apps Script 安裝 handlers。BADGE 前端和 Portal 必須落在同一個既有 backend deployment 與資料上。

`GET /api/units` 的 `backendReady` 只代表 Registry 已有格式正確的 URL／Key，不表示 GAS 已實作 Portal action、登入、帳戶或權限契約。申請送到 ADMIN 收件匣亦不會自動寫 Vercel Registry。

## 2. 核對到的 BADGE／Portal contract 差異

- BADGE v9.6 登入 action 是 `login`，回傳 BADGE `token`；Portal 呼叫 `authLogin`，預期 `sessionToken`、`sessionExpiresAt` 及 Portal account projection。
- BADGE v9.6 以 `validateToken()` 和 `Users` 進行 session／帳戶驗證；`doPost` 沒有 `authWhoAmI` handler。Portal proxy 的 authenticated routes 因而無法直接對裸 v9.6 執行完整身份核對。
- BADGE v9.6 帳戶 action 有 `addUser`／`bulkAddUsers`、`resetPassword`、`updateUserProfile`、`setUserStatus`、`deleteUser`、`updateUserRole`／`updatePermissions`。Portal 呼叫 `authOpenAccounts`、`authCreateAccount`、`authResetPassword`、`authDeleteAccount`、`authRestoreAccount` 等；alias 不在裸 BADGE v9.6。
- BADGE 原生自助密碼流程是 `requestPasswordReset`／`completePasswordReset`；Portal 還呼叫 `authForgotPassword`／`authCompletePasswordReset`。格式、token/session response 及密碼行為要逐項對齊。
- BADGE 原生 Progress／履歷 actions（如 `load`、`save`、`saveOtherBadge`、`requestComplete`、`reviewRequest`、`saveLogRecord`、`reviewLogRequest`）屬其原有 Sheet handlers；Portal 的行政資料 contract 另有 `loadDb`／`saveDb`／`loadTables`／`saveTables`。Portal proxy allowlist 有某 action 不代表 BADGE GAS 實際提供它。
- BADGE 權限按 `Users.role`、`can_tick`、`allowed_badges`、`canManageUser()` 及 action handler 限制；Portal branch schema 是 `member`／`exco`／`leader`／`chief`／`super` 及模組 ACL。正式 adapter 必須以 BADGE 使用者資料為身份權威，逐項映射並由 GAS 驗證，不可信任 browser 的 role／YMIS／姓名或 API Key。
- Portal 原 GAS (`assets/js/lib/gastemplate.js`／`apps-script/Code.gs`) 有獨立帳戶與資料模型，不能作為正式 BADGE Users 或獨立正式部署。
- `unified-extension.gs` 在 `v9.6-u1-test` 隔離 router 提供部分 alias 並將開戶映射到 BADGE `Users`；`releaseChannel` 是 `isolated-test-only`。這是測試證據，不是裸 BADGE 正式 deployment 已相容的證據。

逐項 action、session、密碼／停用及權限比對見 [`BACKEND_SYNC.md`](BACKEND_SYNC.md)。

## 3. 正式 adapter 所屬位置與接線順序

正式相容層應由擁有 BADGE `Users`、token、native Progress handler 及權限規則的 **BADGE Apps Script source of truth** 維護。Portal repo 維護前端 contract、Registry／Proxy 與回歸；不應加入第二身份來源或另建 GAS 資料層。

原地升級的邊界：

- 同一 Apps Script project、同一生產 Sheet、同一 API Key、同一既有 `/exec` deployment；
- 同時保留 BADGE 原生 `login`、帳戶、Progress／履歷等 action；
- Portal aliases 必須服務端映射到同一 BADGE `Users`／session／業務資料；不得產生第二套密碼或帳戶表；
- 如 Portal 完整版確有 BADGE 尚無的行政業務資料，schema 及儲存位置必須屬正式共用 contract，且仍在同一既有 Sheet／project；不得建立第二來源或複製 BADGE identity／Progress；
- 由維護者在核准的真 Apps Script staging 驗證既有資料保留、互通權限及回退，通過後才更新既有正式 deployment。

Portal repository 目前沒有已完成真 Apps Script staging 的正式 BADGE compatibility release。不要先向旅團要求建立新 Sheet／GAS、貼測試 bundle、執行測試 `initializeSheets()` 或把裸 v9.6 登記後稱作已啟用。

## 4. Vercel Registry

只有正式共用 adapter 在真實 staging 通過後，Admin 才登記旅團目前正在使用的資訊：

```dotenv
TROOP_<ID>_NAME=旅團顯示名稱
TROOP_<ID>_BACKEND=https://script.google.com/macros/s/<既有 BADGE deployment>/exec
TROOP_<ID>_APIKEY=<同一既有 BADGE deployment 的 API Key>
```

秘密保存在 Vercel server environment，選對 Production／Preview／Development environment 並 Redeploy。`data/units.json` 只放公開 metadata；不得把 URL／Key 放入 browser、Git、issue 或另外建立 `PROGRESS*`／`PORTAL*` 接線。

## 5. Progress／名冊／帳戶

- 目標：Portal 和 BADGE 的 Progress、名冊、帳戶操作都由同一既有後端及資料權威處理；正式 action contract 完成前，不能宣稱資料已共用。
- BADGE 原生 `load`、`save`、`saveOtherBadge`、審批與履歷 actions 必須保留既有行為；Portal `/api/progress` 的 allowlist 只限制 Portal server 請求，不能替上游增加 handler。
- Portal 名冊新增與開戶分開：名冊編輯不等於 BADGE `Users` 開戶；批量開戶需以已授權 actor 寫入同一 BADGE `Users` 並 readback。
- 名冊同步不得覆蓋 BADGE `role`、密碼 hash、`can_tick`、`allowed_badges` 或帳戶狀態；權限更新要走專用、同一 BADGE 使用者授權的 action。
- `data/progress/items.json` 是前端內建考核項目定義，不是帳戶或業務資料的替代後端。

## 6. 正式 staging checklist

- [ ] BADGE source of truth 有正式版本化 compatibility contract，且在既有 Apps Script project／deployment 原地升級。
- [ ] BADGE 原生登入、token、用戶管理及 Progress／履歷 action 保持正常。
- [ ] 同一現有 BADGE Users 帳戶在兩個前端互相登入；YMIS、角色、狀態及 session 結果一致。
- [ ] Portal 開戶／密碼重設／停用／復原／角色變更在 BADGE Users 立即讀回；不新增第二帳戶或密碼來源。
- [ ] Portal 與 BADGE Progress、名冊及業務資料讀寫落在同一既有 Sheet；無第二資料來源或帳戶鏡像。
- [ ] GAS server 驗證 session、角色及 scope；client role／YMIS／姓名／API Key 不作授權依據。
- [ ] member／執委／領袖／團長及錯旅團、錯 Key、過期 session、非法 action 均 fail closed。
- [ ] 原地更新不清除 BADGE 使用者、hash、名冊、Progress／履歷、API Key；必要的 additive schema 有文件與 staging 結果。
- [ ] 真 Apps Script runtime 的並發、Lock、逾時、readback 及回退測試通過。
- [ ] 以上通過後才設定 Vercel `NAME`／`BACKEND`／`APIKEY` 並 Redeploy；`backendReady` 不作為驗收結果。

全部未跑或未通過的項目保持 `NOT RUN`／`FAIL`；Unified VM 與測試 adapter 不計為真實 staging。最新記錄見 [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md)。