# 統一後端：新 Google Sheet 測試部署步驟

> 適用於目前私人測試分支；不要修改既有旅團 Sheet 或 Production。不要把 API Key、token、完整 Sheet ID 貼到聊天或 Git。
>
> **施工階段：BOOK → BADGE → 5 個支部系統（現在）→ 旅系統（最後）。** 現在未有中央旅系統；
> 本文件 A–C 及 E1 屬支部獨立部署，D 及 E2 只係第 4 階段預留契約。

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
6. 執行 **`showApiKey`**（或 Sheet 選單「🔗 旅系統 → 顯示 API KEY」），安全保存顯示的 Key。
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
| `ALLOW_LOCAL_LOGIN` | 可選 | 未設定視為 `true`。第 3 階段必須保持 `true`；第 4 階段接通旅系統並驗收中央 SSO 後才可測 `false`。 |

**不要新增 `PORTAL_SESSION_SECRET`。** Portal assertion、branch exchange 與 exchange JTI 都由同一 `API_KEY` 以不同 purpose 派生；API Key 本身不等於使用者身份。

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

## D. 第 4 階段預留：中央 SSO 簽章契約（現在不啟用）

現在未有中央旅系統，支部以自己的 `Users`、密碼及 opaque session 正常獨立運作。以下契約保留到五個支部系統完成、開始建立旅系統時才實作。

屆時中央旅系統必須在 server 端使用該旅團同一 `APIKEY` 派生 assertion key：

```text
assertionKey = HMAC-SHA256(key=APIKEY, message="vs-portal-central-assertion-v1")
assertion    = base64url(JSON payload) + "." + base64url(HMAC-SHA256(key=assertionKey, message=payloadPart))
```

payload 必須包括：

```json
{
  "typ": "central-sso-assertion",
  "iss": "central-travel-system",
  "aud": "vs-portal:branch:0082",
  "u": "0082",
  "role": "member",
  "sub": "中央權威身份 ID",
  "name": "顯示名稱",
  "iat": 0,
  "exp": 0,
  "jti": "單次唯一值"
}
```

規則：assertion 最長 90 秒；`role` 只可為 `member`、`exco`、`leader`、`chief`、`admin`；`jti` 必須單次；query string 的 `role/src/ymis/name` 一律不可信。

`/api/portal` 驗證後只簽最長 60 秒、指定支部 audience 的 exchange token。Unified GAS 必須兌換成 opaque branch session，並以 `ScriptLock`＋`ScriptCache` 阻止重放。

> **第 4 階段接通阻擋條件：** 本 repo 現時只預留 verifier／exchange；未來中央旅系統的真實 assertion signer 必須先實作並通過 staging 契約測試，才可聲稱「中央 SSO／旅系統已接通」。這**不阻擋第 3 階段支部獨立部署**。

## E. 驗收順序

### E1. 現階段：支部獨立驗收

1. Vercel Redeploy 後確認 `/api/units` 只顯示接駁狀態，不洩漏 `/exec` 或 API Key。
2. 管理系統：`/?u=0082`。
3. 團員入口：`/members.html?u=0082`。
4. 進度頁確認沒有後端／API Key 輸入欄，讀寫均走同源 `/api/progress`。
5. 測管理寫入、進度寫入及 BADGE 寫入都落在同一張 Sheet。
6. 測本地 staff 與 member session 權限；API Key 不可直接冒充用戶。
7. 確認 `ALLOW_LOCAL_LOGIN=true`，本地帳戶可正常登入。
8. 填寫 [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md) 的現階段項目；未通過前不要切換既有旅團或 Production。

### E2. 第 4 階段：旅系統接通驗收

1. 中央 signer 已由中央登入 session 固定 claims，不相信 browser query 身份。
2. 測 assertion 過期、錯 audience、錯 unit、錯 role、重放及另一旅團 Key 全部拒絕。
3. 真實測試中央 SSO 可進兩個支部前端後，才將 `ALLOW_LOCAL_LOGIN=false`，再驗中央 SSO 與 server-to-server signed path。
4. 未全數通過，只可保留支部獨立模式，不可標示旅系統已接通。
