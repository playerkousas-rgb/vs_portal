# 支部部署指南：Unified GAS／Sheet

> **施工次序：BOOK → BADGE → 5 個支部系統（現在）→ 最後才建立並接通旅系統。**
> 現在沒有中央旅系統；本指南先驗收支部獨立運作，本地帳戶／session 是正常主入口。

## 一句講清楚

每個旅團只需要：

- 一張 Google Sheet；
- 一支 Unified Apps Script；
- 一個 API Key；
- Vercel 三項 `TROOP_<ID>_NAME/BACKEND/APIKEY`。

深資童軍管理系統、進度頁與 BADGE 是不同前端，但全部讀寫同一張 Sheet。不要建立第二支進度 GAS，不要在 browser 保存 API Key。

## 1. 建立後端

1. 開一張新的 Google Sheet。
2. **擴充功能 → Apps Script**。
3. 把 [`apps-script/UnifiedCode.gs`](apps-script/UnifiedCode.gs) 全部貼到 `Code.gs`。
4. 儲存並執行 `initializeSheets`；首次會要求 Sheet、Mail、Drive 權限。
5. 再執行 `initializeSheets` 兩次，確認資料及 API Key 沒有重置。
6. 執行 `showApiKey`，安全保存 Key。
7. **部署 → 新部署 → 網頁應用程式**：
   - 執行身分：我；
   - 存取權：任何人；
   - 複製正式 `/exec`，不要用 `/dev`。

`UnifiedCode.gs` 是生成產物。維護者改 source 後用：

```bash
npm run build:gas:unified
npm run test:unified
```

不要直接手改 generated `UnifiedCode.gs`。

## 2. 申請接入

在系統閘頁選「新旅團申請接入」，提交：

- 旅團編號；
- 旅團名稱；
- Unified GAS `/exec`；
- `showApiKey()` 顯示的 Key；
- 聯絡資料。

申請經同源 `/api/proxy` 送到 server 固定的管理員收件匣。API Key 是敏感 server secret，不要貼到 Git、issue、截圖或群組。

## 3. 管理員只設定三項

以 `0123` 為例：

```dotenv
TROOP_0123_NAME=第一二三旅深資童軍團
TROOP_0123_BACKEND=https://script.google.com/macros/s/部署識別碼/exec
TROOP_0123_APIKEY=同一 Unified GAS 的 API_KEY
```

設定到正確的 Vercel Production／Preview／Development environment，然後 **Redeploy**。

三項與 BADGE 完全相同；進度自動沿用。不設定：

```text
TROOP_0123_PORTALSECRET
TROOP_0123_PORTALSESSIONSECRET
PORTAL_SESSION_SECRET
TROOP_0123_PROGRESSBACKEND
TROOP_0123_PROGRESSAPIKEY
TROOP_0123_PROGRESSCATALOG
```

## 4. 後端與身份安全

- `/api/units` 只回公開 metadata 及 Registry readiness，不回完整 `/exec` 或 API Key。
- `/api/proxy` 與 `/api/progress` 只使用 server Registry 的同一 `BACKEND`／`APIKEY`。
- browser 傳入的 backend／apikey 會被忽略，不能改送另一支 GAS。
- API Key 只作 routing 及用途分隔 HMAC 根，**不等於執委身份**。
- staff 管理 action 必須有 server-issued session；member action 只可操作 session 固定的本人 YMIS。
- query string 的 role、YMIS、姓名不是授權依據。
- 支部 `Users`／本地密碼核實後，由 Unified GAS 簽 opaque session；`ALLOW_LOCAL_LOGIN` 保持 `true`。
- 未來旅系統只由旅系統 server 單向讀取支部後端，正如 BOOK 讀 BADGE；支部 browser、Progress 及登入流程不需要上游狀態或控制。
- 旅系統 reader 必須有獨立的 action allowlist、最小資料投影及 server-side 驗證；API Key 本身仍不等於任何支部用戶身份。

## 5. 進度紀錄

進度資料在同一 Sheet 的 `進度追蹤`、`其他獎章`、`待批完成`、`活動履歷`、`待批履歷`、`成員名單` 等分頁。

- 管理系統經同源 `/api/progress` 讀寫；
- BADGE 經同一 Unified GAS 讀寫；
- 兩邊用同一 canonical YMIS 對人；
- 考核項目固定讀 app 內建 `data/progress/items.json`，不是第二資料後端；
- 「進度 → 資料來源」只交代同一 Unified Sheet 及實際 Progress action 結果，沒有 `/exec`、API Key、catalog URL、登入閘門或旅系統接口；
- `進度追蹤` 分頁為空是正常成功結果，顯示 0 項而不是「讀取失敗」；
- 審批 `reviewRequest`／`reviewLogRequest` 寫回同一張 Sheet；
- 未來由旅系統單向讀取支部後端，正如 BOOK 讀 BADGE；毋須在 Progress 設定、查詢或顯示。

## 6. 首次驗收

### 現階段：支部獨立

1. `/api/units` 顯示旅團 Registry 已備妥且不洩漏 secret。
2. `/?u=0123` 可用支部本地帳戶登入；未登入不能讀完整行政 DB。
3. 確認 `ALLOW_LOCAL_LOGIN=true`，staff／member 均取得自己角色的 server-issued session。
4. 管理系統寫一筆測試資料，確認同一 Sheet 出現。
5. 進度頁勾一項，確認 `進度追蹤` 出現；BADGE 即時讀到同一筆。
6. BADGE 寫一筆，管理系統即時讀到。
7. member 只能本人；exco／leader scope 正確；API Key 單獨不能登入。
8. 偽造 browser backend／apikey／role／YMIS 全部無法改路或升權。
9. 再執行 `initializeSheets` 兩次，API Key、帳戶 hash、行政及進度資料逐筆不變。

### 旅系統建立後：單向讀取支部後端（現在不做）

由旅系統端驗收 reader 的 action allowlist、最小資料投影、錯支部／錯 Key、逾時及重放防護；並確認支部 Progress 完全不新增設定、狀態查詢或控制。支部本地登入維持正常運作。

## 7. 更新 Unified GAS

1. 先在 Sheet 副本測試，不要直接覆蓋 Production 首測。
2. 在 repo 執行完整 `npm run check`。
3. 貼入同一 commit 生成的 `UnifiedCode.gs`。
4. 執行一次 `initializeSheets`；它只能增補缺失 schema，不可清空或重編資料。
5. 建立新的 Web App version，保留 `/exec` 接線。
6. 依 [`docs/UNIFIED_STAGING_RESULTS.md`](docs/UNIFIED_STAGING_RESULTS.md) 做真 Apps Script staging。
7. 任何一項失敗，回退到上一 deployment version。

## 8. 疑難排解

### 旅團未出現

- 三項變數名稱是否用相同四位旅團編號；
- 是否設定在目前網址所屬 Vercel environment；
- 是否 Redeploy；
- `/exec` 是否符合 `https://script.google.com/macros/s/.../exec`。

### 管理系統可開，但 Progress action 失敗

不要新增 `PROGRESS*`。核對：

- `/api/units` 的 `backendReady` 與 `progressServerSide`；
- Vercel API Key 是否與 `showApiKey()` 相同；
- Unified GAS 是否為最新 build，並有進度 actions／分頁；
- 使用者是否有有效 session 及正確 role。

### 更新後缺分頁

在測試副本執行 `initializeSheets`。它應只新增缺失分頁／欄，不覆寫既有資料。如不符合，停止部署並回退。

### 未來旅系統讀不到支部後端（現在未有旅系統，不適用）

只在旅系統 reader 排查：

- action 是否在旅系統 reader allowlist；
- unit 與支部 backend Registry 是否正確；
- server-side 驗證、時限及重放防護是否通過；
- 回應是否只含旅層需要的最小投影；
- 錯支部、錯 Key 或未授權 action 是否 fail closed。

不要在 Progress 加 URL、Key、狀態查詢、登入入口控制或 browser identity fallback。
