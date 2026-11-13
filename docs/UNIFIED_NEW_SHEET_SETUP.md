# 統一後端：新 Google Sheet 測試部署步驟

> 適用於目前私人測試分支；不要修改既有旅團 Sheet 或 Production。不要把 API Key、token、完整 Sheet ID 貼到聊天或 Git。
>
> **施工次序：BOOK → BADGE → 5 個支部系統（現在）→ 旅系統（最後）。** 現在未有中央旅系統；
> 本文件 A–C 及 E1 是支部獨立部署規格。未來旅系統只由 server 單向讀取支部後端；
> repo 內 assertion／exchange 是隔離 auth fixture，不是旅系統施工契約。

## 先講拓撲

每個旅團只有：

- 一張 Google Sheet；
- 一支 Unified Apps Script Web App；
- 一個 `API_KEY`；
- Vercel 三項旅團設定：`NAME`、`BACKEND`、`APIKEY`。

管理系統、進度頁與 BADGE 都經同一支 Unified GAS 讀寫同一張 Sheet。不要另建進度 GAS，也不要設定任何 `PORTAL*` 或 `PROGRESS*` secret／backend／key。

## A. 建立全新 Sheet 與 Unified Apps Script

1. 開一張全新的 Google Sheet。
2. **擴充功能 → Apps Script**。
3. 刪除預設內容，把 [`apps-script/UnifiedCode.gs`](../apps-script/UnifiedCode.gs) 全部貼入 `Code.gs`。
4. 儲存後，在函式下拉選單執行 **`initializeSheets`**；首次執行要授權 Sheet、Mail、Drive。
5. 再執行 **`initializeSheets`** 兩次，確認既有資料、API Key 及進度資料沒有被重置。
6. 執行 **`showApiKey`**（或 Sheet 選單「🔗 支部系統 → 顯示 API KEY」），安全保存顯示的 Key。
7. 可執行 **`getVsGsReleaseStatus`** 檢查 pinned vsbadge release 狀態。

如要驗證生成產物，先在 repo 執行：

```bash
npm run build:gas:unified
sha256sum apps-script/UnifiedCode.gs
```

`UnifiedCode.gs` 是 builder 產物；不要直接手改。

### Apps Script Script Properties

| 名稱 | 必要性 | 用途 |
|---|---:|---|
| `API_KEY` | 自動 | `initializeSheets()`／`showApiKey()` 管理；是 routing 與用途分隔 HMAC 的 server-side 根密鑰。 |
| `ALLOW_LOCAL_LOGIN` | 可選 | 未設定視為 `true`；支部本地帳戶是正常登入來源，部署及未來旅系統 reader 均保持 `true`。 |

**不要新增 `PORTAL_SESSION_SECRET`。** 隔離測試中的 assertion／exchange 由同一 `API_KEY` 以不同 purpose 派生，但不是現行登入或未來旅系統 reader 的部署設定；API Key 本身不等於使用者身份。

以下由程式自動管理，不要手動改：`VS_GS_INITIALIZED_VERSION`、`UNIFIED_GS_INITIALIZED_VERSION`、session／reset／rate-limit properties。

## B. 部署 Apps Script Web App

1. **部署 → 新部署 → 網頁應用程式**。
2. 執行身分：**我**。
3. 存取權：**任何人**（應用層仍由 HMAC、短期票據與 opaque session 授權）。
4. 複製正式 **`/exec`** URL；不要使用 `/dev`。

## C. Vercel 只設定三項旅團變數

以下以旅團 `0082` 為例：

```dotenv
TROOP_0082_NAME=第八十二旅深資童軍團
TROOP_0082_BACKEND=https://script.google.com/macros/s/你的部署/exec
TROOP_0082_APIKEY=showApiKey 顯示的同一 API_KEY
```

這三項與 BADGE 使用的登記完全相同。更新後要 Redeploy。

不要設定：

- `TROOP_0082_PORTALSECRET`
- `TROOP_0082_PORTALSESSIONSECRET`
- `PORTAL_SESSION_SECRET`
- `TROOP_0082_PROGRESSBACKEND`
- `TROOP_0082_PROGRESSAPIKEY`
- `TROOP_0082_PROGRESSCATALOG`
- `V82_PROXY_TEST`
- `VSBADGE_PROXY_TEST`

`SUPER_KEY` 是平台隱藏超管的獨立可選設定，不是旅團接線的一部分；不設即關閉超管。

## D. 隔離 auth fixture（不是部署或旅系統規格）

支部以自己的 `Users`、密碼及 opaque session 正常運作，`ALLOW_LOCAL_LOGIN` 保持 `true`。
`UnifiedCode.gs` 與 `/api/portal` 仍保留 assertion → exchange → branch session 的安全回歸 fixture，
用來測 purpose separation、audience、時限及 replay 防護。不要在開團或未來旅系統 reader 啟用、
依賴或照抄這條實驗路徑，也不可用 fixture 通過來聲稱旅系統已完成。

未來旅系統的正式資料方向只有：

```text
旅系統 server ──單向讀取最小投影──▶ 支部 Unified backend
```

reader 的 action allowlist、最小投影、server-side 驗證、逾時、重放與跨支部隔離，應在旅系統
repo 建立時另行設計及驗收。支部 Progress 不新增 URL、Key、狀態查詢、入口控制或帳戶鏡像。

## E. 驗收順序

### E1. 現階段：支部獨立驗收

1. Vercel Redeploy 後確認 `/api/units` 只顯示 Registry readiness，不洩漏 `/exec` 或 API Key。
2. 管理系統：`/?u=0082`。
3. 團員入口：`/members.html?u=0082`。
4. 進度頁確認沒有後端／API Key 輸入欄，讀寫均走同源 `/api/progress`。
5. 測管理寫入、進度寫入及 BADGE 寫入都落在同一張 Sheet。
6. 測本地 staff 與 member session 權限；API Key 不可直接冒充用戶。
7. 確認 `ALLOW_LOCAL_LOGIN=true`，本地帳戶可正常登入。
8. 填寫 [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md) 的現階段項目；未通過前不要切換既有旅團或 Production。

### E2. 旅系統建立後：reader 驗收（現在不做）

1. 從旅系統 server 呼叫明確 allowlist 的支部 read action；browser 不持有 reader credential。
2. 回應只含旅層需要的最小投影；不可回完整支部 DB、密碼 hash、session 或其他支部資料。
3. 測錯 unit、錯 Key、未授權 action、逾時及重放全部 fail closed，並確認各支部互相隔離。
4. 支部 Progress 沒有新增旅系統設定／狀態／控制，本地登入仍保持正常可用。
5. 隔離 assertion／exchange fixture 的結果不可當作 reader 或旅系統完成證據。
