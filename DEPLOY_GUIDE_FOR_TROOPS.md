# Portal 接入旅團既有 BADGE 後端

> **適用範圍：已有 BADGE、希望加入 Portal 的旅團；本文件不是全新支部的首次部署指南。** BADGE 與 Portal 可單獨或一起使用；一起使用時，Portal 完整版要接到旅團目前使用的 BADGE Apps Script `/exec`、API Key、Google Sheet、`Users` 帳戶及業務資料。不得為加入 Portal 新建 Sheet／GAS、另建身份或帳戶表、搬移／複製帳戶或分開資料。只有 Portal 的既有支部與全新支部的部署／升級流程仍待另行設計驗證，不能假設必須先使用 BADGE。
>
> **目前尚未完成正式共用後端驗收。** 裸 BADGE v9.6 的登入及帳戶 action 與 Portal contract 不相同；只登記 URL／Key 不會自動補上 adapter。`apps-script/UnifiedCode.gs` 是候選版，並非已驗收正式 release。若支部負責人明白風險並決定自行測試，可先備份並參考 [`docs/USER_SELF_TEST.md`](docs/USER_SELF_TEST.md)；細節見 [`docs/BACKEND_SYNC.md`](docs/BACKEND_SYNC.md)。

## 目標接線

```text
Portal 完整前端 ──同源 /api/proxy──┐
                                  ├──旅團目前使用的 BADGE /exec、API Key、Sheet、Users
BADGE 輕量前端 ───────────────────┘
```

Portal 的 Vercel Registry／proxy 只負責按旅團選取可信任的既有 `/exec`，並在伺服器端注入 API Key。它不會改寫上游 action，也不會替 BADGE GAS 安裝相容程式。BADGE 前端原有的 `/exec` 設定亦須指向同一個既有 deployment。

## 團方需要提交甚麼

在 Portal 登入前旅團閘選「申請 Portal 接入」，提供：

- 旅團編號及名稱；
- 旅團目前正式使用的 BADGE Apps Script `/exec`；
- **同一個 BADGE deployment** 的 API Key；
- 聯絡資料（選填）。

API Key 是敏感資料，只經申請流程交給平台管理員；不可貼到 Git、issue、截圖或公開群組。申請送往固定 ADMIN 收件匣，不會自動寫入 Vercel Registry。只有系統收到 ADMIN 明確回傳的 `receipt: true` 才顯示已取得收件回執；一般送出成功、逾時或 no-cors 都不等於 ADMIN 已確認收到。

申請表不要求建立 Sheet／GAS，也不要求匯出、匯入、搬移或複製帳戶。

## Admin 開通次序

### 1. 核對既有 BADGE backend

核對旅團、正式 `/exec`、API Key 及目前部署版本；確認 URL 與 Key 屬於同一個現有 Apps Script deployment。不要用 `/dev` 或測試帳戶代替正式資料。

### 2. 先解決正式 action contract，不要先把 Registry readiness 當成開通

歷史比較：沒有 Portal adapter 的裸 BADGE v9.6：

- 登入用 `login`，回傳 BADGE `token`；
- 帳戶管理用 `addUser`／`bulkAddUsers`、`resetPassword`、`setUserStatus`、`updateUserRole` 等原生 action；
- 使用 BADGE `Users`、session token 及角色授權。

Portal 目前登入／帳戶路徑呼叫 `authLogin`、`authWhoAmI`、`authOpenAccounts` 等 action。裸 v9.6 沒有這些同名 handlers；Portal proxy、Progress allowlist、`backendReady`、VM 或 `isolated-test-only` Unified 測試均不會替正式 GAS 增加 handlers。

正式相容層必須由**擁有 BADGE `Users` 與原生 action 的 BADGE Apps Script source**維護，並更新到旅團**同一個既有 Apps Script 專案、同一張 Sheet、同一 API Key 及既有 `/exec` deployment**。升級只能原地更新，不可另建正式專案／Sheet；正式開通前須完成真實環境驗證，並保留原 deployment version 以便回退。支部負責人決定自行試用候選版時，先按 [`docs/USER_SELF_TEST.md`](docs/USER_SELF_TEST.md) 備份和核對風險。相容層須同時保留 BADGE 原生 action，並讓 Portal action 在服務端映射到同一個 BADGE `Users`／session／資料；不得引入第二帳戶表或第二身份權威。

BADGE v9.7 已包含完整共用後端及 Portal 相容層；Portal 的 v9.8 建基於此，BADGE 下一次修改前應承接更新後的完整版本；目前沒有真 Apps Script 驗收紀錄。不要把 Registry 登記或本機模擬測試誤當成真實驗收；支部負責人自行試用可參考 [`docs/USER_SELF_TEST.md`](docs/USER_SELF_TEST.md)。

### 3. 相容性 staging 全部通過後才登記 Registry

在正確的 Vercel environment 設定以下三項，值必須來自旅團目前那個 BADGE backend：

```dotenv
TROOP_<ID>_NAME=旅團顯示名稱
TROOP_<ID>_BACKEND=https://script.google.com/macros/s/<既有 deployment>/exec
TROOP_<ID>_APIKEY=<同一既有 BADGE deployment 的 API Key>
```

選對 Production／Preview／Development environment 並 Redeploy。不要把 URL／Key 寫入 `data/units.json` 或 browser；不要另設 Portal／Progress backend 或 API Key。

`GET /api/units` 的 `backendReady` 只代表 Registry 找到可信任 URL 與 Key，不代表 GAS action、登入、帳戶或權限相容。

## 真實後端驗收清單

必須以既有 BADGE Sheet／Apps Script deployment（或經核准的相同版本 staging 副本）驗收，VM 測試不代替此清單：

1. 同一個既有 BADGE 帳戶可用 BADGE 原生登入，也可用 Portal 登入；兩邊回到同一 YMIS、姓名、角色及帳戶狀態。
2. Portal session 必須由 BADGE 後端簽發／驗證；過期、停用、重設密碼及角色變更後的舊 session 必須按規格失效。API Key、browser `role`、姓名或 YMIS 不得當成登入身份。
3. Portal 批次開戶只新增到 BADGE `Users`；BADGE 可立即用該帳戶登入，兩邊不得出現重複帳戶或密碼來源。
4. Portal 的密碼重設、停用／復原及角色／`can_tick`／`allowed_badges` 權限更新，要在 BADGE 與 Portal 兩邊讀回一致；需保留 BADGE 原有管理限制及稽核。
5. BADGE 與 Portal 對同一 YMIS 的名冊及 Progress actions 讀寫同一張 Sheet；新增、審批、停用和讀取都互相可見，不得寫入第二個資料來源。
6. member、執委、領袖及團長各自測試允許／拒絕的 action；偽造 session、角色、YMIS、API Key 或另一旅團的 URL／Key 全部 fail closed。
7. 原地更新及必要的 additive schema 準備，不得清空、重建、覆寫或要求搬移既有 BADGE `Users`、密碼 hash、名冊、Progress／履歷或 API Key。
8. 記錄 staging commit、GAS version、遮罩 deployment 標識、測試結果及回退步驟；不要記錄 secret、完整 Sheet ID 或 token。

未完成上述驗收前，維持「未完成／不可正式開通」。

## 目前不要做

- 不要建立新 Google Sheet、Apps Script project、Web App 或第二個 `/exec`；
- 不要把未驗收的 Unified 候選版宣稱為正式 release；支部負責人決定自行測試時，先備份並按 [`docs/USER_SELF_TEST.md`](docs/USER_SELF_TEST.md) 操作；
- 不要把 Portal 原有 `accounts[].pw`／Portal GAS 帳戶模型當作 BADGE Users；
- 不要匯出／匯入、搬移或複製 BADGE 使用者與密碼 hash；
- 不要只因 `backendReady === true`、proxy allowlist 有 action、VM 測試通過或收到申請回執就宣稱已接通；
- 不要自動替未知版本的既有 Sheet 執行 schema migration、reset 或覆蓋操作。

## 相關文件

- [`docs/BACKEND_SYNC.md`](docs/BACKEND_SYNC.md)：Registry、實際 action、登入、帳戶及權限差異
- [`docs/ADMIN_ONBOARDING.md`](docs/ADMIN_ONBOARDING.md)：管理員接入 checklist
- [`docs/UNIFIED_NEW_SHEET_SETUP.md`](docs/UNIFIED_NEW_SHEET_SETUP.md)：已退役的舊新 Sheet 指引（不可照做）
- [`docs/UNIFIED_STAGING_RESULTS.md`](docs/UNIFIED_STAGING_RESULTS.md)：既有 BADGE 後端 staging 記錄