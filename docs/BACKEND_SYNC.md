# Portal／BADGE 共用後端接線與同步紀錄

> **產品目標：** BADGE 是較精簡的前端，支部系統是完整版前端；可只用其中一個，也可兩個一起用。各前端不能以另一前端在線或登入為前提。兩個一起使用同一支部時，應共用一個完整後端、同一 Sheet、`Users`、名冊和相關業務資料，不是兩個後端之間複製資料。
>
> **既有 BADGE 加入 Portal 的情境：** 沿用原有 `/exec`、API Key、Sheet 和帳戶，不得為加入 Portal 另建 Sheet、GAS、身份或資料來源，也不得搬移／複製帳戶。這不等於要求每個旅團必須先使用 BADGE：全新支部及只有 Portal 的既有部署，其首次建置／升級流程仍需另行設計驗證。
>
> **目前版本：** BADGE main v9.7 已包含完整 Unified 及 Portal Users adapter；本 repo 的 v9.8 建基於該完整檔案；BADGE 下次修改時才需要先承接更新後的完整版本。以下對裸 v9.6 的 contract 比較屬歷史背景，不代表 v9.7 缺少 adapter。兩邊更新次序見 [`SHARED_BACKEND_VERSIONING.md`](SHARED_BACKEND_VERSIONING.md)。Portal v9.8 尚未經真 Apps Script 雙前端驗收；收到申請、Vercel `backendReady` 或 VM 測試不等於已開通。

## 0. 前端與後端的關係

```text
BADGE 前端 ──▶ 自己的同源 proxy ──┐
                                  ├──▶ 同一支部後端（Apps Script）──▶ 同一 Sheet／Users／業務資料
Portal 前端 ─▶ 自己的同源 proxy ──┘
```

Portal 的登入、身份核對和資料讀寫是向**共用後端**提出請求，並非呼叫 BADGE 前端、嵌入 BADGE 網站或透過 BADGE 前端中轉。兩邊帳戶以後端為權威；密碼驗證和授權在後端處理，前端不應讀取密碼 hash。各自登入畫面可獨立向後端登入；共用帳戶不自動表示兩個網站的瀏覽器 session 已互通或需要單點登入。

此處「直接向後端」是指業務上不依賴另一前端；現有瀏覽器流量仍經各自的同源 server proxy，以便保護 API Key、按支部選路及執行服務端檢查。API Key 不代替使用者登入，後端仍須驗證 session、身份及權限。

## 0.1 參考：成員系統與區管理系統

核對 [`member-portal` README](https://github.com/playerkousas-rgb/member-portal/blob/de879a495a3a12d15129fa8e101179a7c07be6e7/README.md)、[其 GS 版本庫](https://github.com/playerkousas-rgb/member-portal/blob/de879a495a3a12d15129fa8e101179a7c07be6e7/backend/gs-releases/README.md) 及 [`scout-district-portal` 對接合約](https://github.com/playerkousas-rgb/scout-district-portal/blob/e72112fdcc0a57a0cc02a14935b08521647d4e75/docs/member-gs-handshake.md)：兩個前端各有 proxy／允許的 actions，主要業務共用同一主 Sheet、GS、`/exec` 和 API Key；後端變更需雙向比對版本、保留舊 action 並同步發佈。訓練班等外接系統是該案例中另列的例外，不應誤當全部功能都只用一個 Script。

可借鑑的是**一套後端、不同前端範圍，集中維護及同步合約**，不是照搬免登入權限：成員系統公開免登入，只能讀公開資料／提交申請；區管理系統需登入。BADGE 自己已有登入和帳戶管理，與 Portal 共用時兩邊都須遵守支部後端的身份和授權規則。參考 repo 文件有版本快照與補丁；應比較兩邊實際最新版本，而非假設任一份文件總是較新或照搬其維護分工。

本 repo 的 `UnifiedCode.gs` 是以 BADGE v9.7 **完整共用後端**為基礎的 v9.8 候選實作，保留 Portal 相容層及 BADGE 新增的全團投影；尚未經真實 Apps Script 驗收，不是已驗收的正式 release 或已上線結果。支部負責人如明白風險並決定自行測試，應先備份並參考 [`USER_SELF_TEST.md`](USER_SELF_TEST.md)。以下裸 v9.6 action 差異是歷史比較，不是 v9.7 的現況。

### 原地升級候選版的保護及未解事項

- **新旅團與既有旅團是兩種正常起點：** 既有 BADGE 旅團直接沿用同一後端已有的帳戶、名冊及進度；全新旅團可直接使用 Portal，不需要先使用 BADGE 前端。新旅團尚未有一般用戶或業務紀錄是正常的，初始化在同一 Sheet 的 `Users` 建立首個預設管理員，兩個前端使用同一帳戶，不需要第二個管理員或另一套開戶流程。
- 候選版新建 `Users` 時保留 BADGE 的首個管理員及首次更改預設密碼要求；已有 `Users` 表不重設或自動補建該帳戶。仍須在真 Apps Script staging 驗證新旅團透過兩個前端登入、首次改密碼及重跑初始化；不得把隔離測試當成已部署。
- 產生器固定 BADGE v9.7 **完整 GS** 的來源及 hash，在此基礎明確套用 v9.8 修正；原始 baseline 不會被覆寫。為保留既有旅團歷史，候選版停用 v9.7 初始化中刪改舊保留帳號、審計及相關歷史行的清理步驟；舊保留 session 仍由驗證程式拒絕。這是與 BADGE v9.7 原有清理政策的明確差異；舊保留角色或電郵列不能登入、使用舊 session 或由 assertion fixture 復活，並須由後續版本保留這些保護。已有 `Users` 表時不補建預設帳戶，亦不在初始化時改寫既有密碼旗標。
- 升級前先核對 BADGE `進度追蹤` 的位置式表頭及 `Users.ymis`；不認得的格式會停止。只在可辨識結構增補欄／表，行政分頁跳過或後續失敗須如實回報 partial，不可標記共用版本已完成；只在兩階段完成後顯示成功，亦不在 log 輸出 API Key。部分失敗不是交易回滾：可能已有增補，重試前須核對。
- 報表同步不再重寫 `成員名單`、刪除帶旅團後綴的分頁或裁剪同步歷史。候選版只會清除由初始化新建且以 sheet ID 登記的報表分頁；若同名分頁已有資料或被替換，刷新會停止並回報，不能自動認領。儲存行政資料與刷新報表是不同結果：資料儲存成功但報表失敗時須檢查 `reports`。
- 初始化不改動既有 `ALLOW_LOCAL_LOGIN`（未設定即開啟）；若舊設定是關閉，Portal 正常登入仍受阻，須由 Sheet 管理員核對後明確開啟。簽名 `getLinkState` 及 `setLocalLogin` 交回 BADGE 既有簽名及防重播驗證；沒有有效簽名不可讀取或控制。這控制同一後端，關閉時會影響兩個前端。
- **直接讀取及並發保護（候選版，仍須 staging）：** `loadDb`／`loadTables` 及分段讀取會先結合同一 Sheet 的 `Users`、`成員名單` 與行政資料，再按已核實身份過濾；Portal 專用表沒有資料可以是空的。正常寫入以包含名冊及帳戶投影的 `U-` 版本檢查衝突，成功寫入與名冊更新在同一 script lock 內，並於鎖內回傳版本。BADGE 刪除純名冊成員會記錄 Script Properties tombstone，避免舊行政副本復活；明確重新加入時清除。行政資料已寫入但名冊或版本核對失敗時須重新讀取，不可盲目重送。隔離 VM 已測上述情況及首筆 delegated 寫入權限；並未證明真 GAS、多裝置或所有原生寫入路徑安全。
- **寫入合約：** Portal 尚未有舊版用戶，因此普通 `saveDb`、`saveTables`、`saveDbPart`、`saveDbCommit` 必須帶有效 `U-` 共用版本；缺少或舊格式一律拒絕，先讀取再寫入。團員入口內部寫入亦使用同一共用版本。特權強制修復刻意繞過版本檢查，需人工確認；含整份 `db` 的報表 `sync` 已拒絕，須先經正常儲存再同步報表。
- **仍須驗收：** tombstone 使用 Script Properties，容量、配額與大量資料的效能仍須真實 staging 檢查；舊的未登記報表分頁不會自動認領。BADGE 原始測試有安全及保全政策差異，須連同兩個真實前端、既有 deployment 升級及回退測試驗收後才可發布。
- operation ID 只用作查詢狀態及防止重複執行，不能代替登入或重播含私人資料的完整回應；重試須按結果核對並重新授權讀取。
- `tests/unified-gas.mjs` 在 VM 模擬既有資料及跨 action 登入，並非 Google Apps Script、真實部署、所有版本 schema 或完整 BADGE 回歸的證明。仍須檢查原生 BADGE 行為、簽名與權限、初始化副作用、舊部署升級／回退，以及與最新 BADGE source 的整合。
- **特殊帳戶依賴尚待處理：** vendored BADGE 的特殊平台管理員驗票目前仍指向 `vsbadge.vercel.app/api/super`；一般支部 `Users` 登入不需要 BADGE 前端。它不可被誤說為 Portal 日常登入依賴，但正式共用後端需要在保持既有特殊帳戶安全及相容的前提下，決定如何移除對 BADGE 網站的依賴並測試。


## 1. Admin 開通實際流程（已有 BADGE 的旅團）

### 1.1 團方提交的是既有後端資料

目前開通申請表由 `assets/js/lib/onboard.js` 組成 `{ troopId, troopName, scriptUrl, apiKey, contact, ... }`，並 POST 到同源 `/api/proxy`，`action=submitRegistration`。

`api/proxy.js` 對 `submitRegistration` 使用伺服器固定的 `SCOUT_ADMIN_API`，驗證 `/exec` 外形後把申請送到中央 ADMIN 收件匣。這是**申請／通知路徑，不是 Registry 寫入 API**：它不會呼叫 Vercel API、不會修改環境變數，也不會自動啟用 Portal。

### 1.2 Admin 登記設定

Admin 收到申請後，實際接線來源是 Vercel server environment：

```dotenv
TROOP_<ID>_NAME=旅團顯示名稱
TROOP_<ID>_BACKEND=https://script.google.com/macros/s/<deployment-id>/exec
TROOP_<ID>_APIKEY=<同一個既有 BADGE backend 的 API_KEY>
```

`api/_registry.js` 以 `getTrustedUnit()` 解析設定、只接受可信任的 GAS `/exec` URL；環境變數優先於檔案資料。改完環境變數要部署到正確的 Vercel Production／Preview／Development environment 並 Redeploy。`data/units.json` 只適合放公開 metadata，不能放 API Key。

`GET /api/units` 只公開旅團名稱及 `backendReady` 等狀態，不回 GAS URL 或 API Key。**`backendReady` 只代表 Registry 有可信任 URL 和 Key，不代表該 GAS 已實作 Portal 所需 actions。**

### 1.3 Portal 呼叫已登記後端

一般支部 action 由 `assets/js/lib/gateway.js` 送到同源 `/api/proxy`。代理依旅團 ID 呼叫 `getTrustedUnit()`，刪除 browser 提交的 API Key，再用 Registry 的 Key 轉發至 Registry 的 GAS URL。Browser 不能用 body 改寫實際 upstream URL 或 Key。

`openMemberAccounts()` 對尚未開戶的名冊成員批次送出 `action: 'authOpenAccounts'`、YMIS、姓名、Email、身份及臨時密碼；成功後再讀回。這是另一個明確的帳戶開通動作，不是新增名冊成員時自動建立帳戶。Proxy allowlist 有 `authOpenAccounts`，一般 session 會被轉發到該 GAS；平台 super 才由 proxy 加上 server-side 簽名。Proxy 本身不會把 Portal auth action 改寫成 BADGE action，最後仍要由 upstream GAS 實作相同 action contract。

## 2. 已核實的 action／登入／帳戶／權限差異

| 功能 | Portal 目前 wire contract | 裸 BADGE v9.6 實際 contract | 尚缺的正式工作 |
|---|---|---|---|
| 登入 | `authLogin`（username／email／YMIS + password），前端預期 `{ sessionToken, sessionExpiresAt, account, mustChangePw }` | `login`，在 BADGE `Users` 驗證後回 `{ token, user, force_change_password, ... }` | 在 BADGE source 提供正式 Portal alias／response projection；不能另存 Portal 密碼 |
| Session / identity | `authWhoAmI` 以 Portal `sessionToken` 對回 account／role／YMIS；Portal Proxy 會在 admin／Progress 請求前驗 session | 原生 token 由 `validateToken()` 驗證；裸 v9.6 `doPost`／signed action route 無 Portal `authWhoAmI` handler | 讓 Portal session 欄位安全承載或適配 BADGE token，並由同一 GAS 每次重新驗證 Users 狀態及角色；不得相信 body role／YMIS |
| 批次開戶 | `authOpenAccounts` 帶 `{ users: [{ targetYmis, ymis, name, email, role, password }] }` | `bulkAddUsers` 帶 BADGE user rows，handler 為 `handleBulkAddUsers()`／`createUsersBatch()`，寫入 BADGE `Users`／名冊 | 經 BADGE 同一帳戶管理授權轉換欄位、保留既有帳戶及 hash、逐筆報告結果並 readback；不建第二表 |
| 單戶新增 | `authCreateAccount` | `addUser` | 明確定義 YMIS／Email 唯一性及 BADGE 原生管理角色，不可由 Portal 建立 shadow account |
| 改密碼 | `authChangePassword`（本人 old/new + session），`authResetPassword`（管理員 target + new） | `changePassword`（token + `old_password`／`new_password`）；`resetPassword`（`target_ymis`／`new_password` + 管理員 token） | 對齊欄位、密碼規則、reset 後 token 撤銷與回應；hash 只能由 BADGE Users 寫入 |
| 忘記密碼 | `authForgotPassword`／`authCompletePasswordReset`（email／code／newPassword） | `requestPasswordReset`／`completePasswordReset`（`login_id`／code／`new_password`） | 驗證回應是否可等價投影，保持 BADGE reset hash／單次碼／rate-limit；不另建 Portal reset store |
| 停用／復原／刪除 | `authDeleteAccount`、`authRestoreAccount` | `setUserStatus`（active／inactive）、`deleteUser`（保留 tombstone） | 明確對齊 Portal UI 語義與 BADGE 軟停用／tombstone；停用要失效既有 token，不刪除 Progress 歷史 |
| 角色及 BADGE 權限 | Portal `member`／`exco`／`leader`／`chief`／`super` + module ACL | BADGE `member`／`exec_committee`／`branch_leader`／`group_leader`／`admin`，另有 `can_tick`／`allowed_badges`；`canManageUser()` 依 hierarchy 限制 | 正式映射表與每個 action 的伺服端 scope；只更新 `allowed_badges` 時不得清掉 role／`can_tick`，也不可升權 |
| 名冊 | Portal `members`／`accounts` 會透過 `loadTables`／`saveTables` 保存；開戶與名冊新增分開 | `getMembers`／`addMember` 及 Users `syncMemberRow()`；角色／帳戶狀態由 Users 權威資料提供 | 同一 YMIS 投影；名冊編輯不可覆寫 Users 權限／hash；批次開戶需明確 action |
| Progress／履歷 | Portal `/api/progress` 經 Registry proxy 呼叫 `load`、`save`、`saveOtherBadge`、審批及個人 action | v9.6 原生 `load`、`save`、`saveOtherBadge`、`requestComplete`、`reviewRequest`、`getLogRecords`、`saveLogRecord`、`reviewLogRequest` 等 | 逐項核對參數、response、actor 權限及同一 Sheet readback；allowlist 不會創造上游 handler |
| Portal 完整版行政資料 | `loadDb`／`saveDb`／`loadTables`／`saveTables`、帳目／物資／會議／通告等 | 裸 BADGE v9.6 沒有相同的完整 Portal DB actions | 完整共用後端須提供正式 schema／handler；已有 BADGE 時在同一既有 Sheet／GAS 中維護，不能另建 Portal backend 或複製 BADGE identity／Progress |

候選角色對照曾在隔離 router 中試作 `member→member`、`exco→exec_committee`、`leader→branch_leader`、`chief→group_leader`、`super→server-super`；這**不是正式批准或已部署映射**。BADGE `super_admin`／`admin` 的例外權限不能由 browser claim 或一般 Portal 帳戶映射取得。

BADGE v9.6 `doPost` 以登入後 `token` 保護帳戶管理；管理 action 依 `getRoleLevel()`／`canManageUser()` 檢查，普通使用者的 `can_tick` 只控制部分進度寫入，不等於帳戶管理權。API Key 只作服務端 routing／簽名根，不能取代 BADGE user token 或角色授權。

共用 GS 的 router 提供 Portal aliases，並把批次開戶映射到 `handleBulkAddUsers()`／BADGE `Users`。這層已包含在固定的 BADGE v9.7 完整來源內；舊的 `unified-extension.gs` 保留歷史參考，不再是 v9.8 產生器的輸入。VM 測試不可證明既有 BADGE `/exec` 已安裝或 Apps Script runtime 行為。

因此，目前只有可追蹤的**前端 → Registry → Proxy → action forwarding** 路徑；正式共用後端 action contract、版本化 release、原地更新與真實 Apps Script staging 仍未完成。單有 URL／Key、proxy allowlist、申請回執或 `backendReady` 都不足以證明功能已接通。

## 3. BADGE PR #40 維護對照

來源：[vsbadge PR #40 — Fix account sign-in and permission sync](https://github.com/playerkousas-rgb/vsbadge/pull/40)。合併 commit：`87c76a98b95ff7b5e2a7be02198142c72aefc24e`；BADGE `apps-script/Code.gs` SHA-256：`63148a32095694a92a45d9fa14fc190b7fd8e35336080d2c48ad9adf61c34a10`。

PR #41 是隔離 Unified 測試 bundle，不是另一個 BADGE 正式後端版本：[vsbadge PR #41](https://github.com/playerkousas-rgb/vsbadge/pull/41)。

| BADGE 維護內容 | Portal 現況 | 同步狀態 |
|---|---|---|
| 團員可用 YMIS 或 Email 登入 | Portal 原 GAS `authLogin` 支援 email／YMIS／loginId；Unified test adapter 則轉用 BADGE 本地 Users login | Portal 原 GAS 有相似行為但不是共享帳戶證據；Unified 行為仍需正式落地 |
| 僅更新 `allowed_badges` 時保留 role／`can_tick` | Portal branch module ACL 不是 BADGE 的 `Users.allowed_badges` 欄位 | 不逐欄照抄；需在同一 BADGE `Users` 權威資料模型驗證等價權限 |
| 已驗證 `load` 回傳安全權限 snapshot | Portal `authWhoAmI` 與 Progress response 分開 | 尚未對齊正式共用 response contract |
| `can_tick=true` 不代表一般團員可直接寫全團進度 | `/api/progress` 以服務端身份／權限限制讀寫 | Portal proxy 行為有測試；仍需確認正式共用 GAS 的服務端授權一致 |

## 4. 正式接通的必要條件

1. 以 BADGE `Users`／既有 Sheet 為唯一帳戶和密碼權威；不得使用 Portal `accounts[].pw` 建第二身份來源，也不得複製帳戶。
2. 為 Portal 前端需要的登入、身份核對、批次開戶、停用／復原等 action 提供**正式且版本化的 BADGE 共用後端 contract**。可以是被核准的同一 GAS router adapter，但必須更新既有部署／沿用既有資料與 API Key；不能只把 Unified test artifact 改名後宣稱已完成。
3. 同一既有 BADGE `/exec` 必須能同時服務 BADGE 原生 `login`／`bulkAddUsers` 等 action 與 Portal action；兩個前端的使用者登入、開戶、重設／停用以及角色變更都要在同一 `Users` 資料上互相讀回。
4. 在保留同一 Sheet、API Key、現有密碼 hash、使用者及 BADGE 行為的前提下，先做版本／升級與回退驗收，再由 Admin 把既有 URL／Key 登記到 Vercel。
5. 以真實既有測試 Sheet／GAS deployment 完成跨前端驗收；VM 的 BADGE vendored source 測試不可替代 Apps Script staging。

## 5. 每次 upstream 同步程序

1. 釘選 BADGE upstream commit，檢視 `apps-script/Code.gs`、前端、身份／權限 action 及測試差異。
2. 逐項映射到共用 `Users` 與 Portal 權限模型；已等價的功能只補回歸測試，不複製帳戶表或密碼資料。
3. 更新共用 backend source、action/proxy contract、Portal UI 與回歸測試。兩邊每次修改前以較新的完整 GS 為基礎；目前 v9.8 候選版尚未經真實 Apps Script 驗收，詳見 [`SHARED_BACKEND_VERSIONING.md`](SHARED_BACKEND_VERSIONING.md)。
4. 執行 `npm run check`、`git diff --check`，並另做真 Apps Script staging。
5. 只在正式共用 source、建置產物、action contract、同一帳戶資料及 staging 都對應同一版後，才把項目標作已同步／已開通。
