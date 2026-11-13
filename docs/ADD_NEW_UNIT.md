# 新增一個支部（Unified 多支部部署）

> 施工次序：BOOK → BADGE → 5 個支部系統（現在）→ 最後才建立旅系統。現在沒有中央旅系統；新支部以本地帳戶／session 獨立運作。

## 唯一支援的接線

每個旅團只用：

1. 一張 Google Sheet；
2. 一支 [`apps-script/UnifiedCode.gs`](../apps-script/UnifiedCode.gs)；
3. 同一個 `API_KEY`；
4. Vercel 三項 `NAME`／`BACKEND`／`APIKEY`。

管理系統、進度與 BADGE 都讀寫同一張 Sheet。不要另建進度 Script，不要在進度頁貼 `/exec` 或 Key，也不要建立任何 `PORTAL*`／`PROGRESS*` 變數。

## 旅團申請

旅團在閘頁選「部署指南」：

1. 建立新 Google Sheet；
2. 把 `UnifiedCode.gs` 貼到綁定的 Apps Script；
3. 執行 `initializeSheets`；
4. 執行 `showApiKey`；
5. 部署 Web App，取得正式 `/exec`；
6. 送出申請表。

申請由同源 `POST /api/proxy` 的 `submitRegistration` 送往 server 固定的管理員收件匣。Payload 會帶 `appType: "82venture"`、旅團編號／名稱、`/exec`、API Key、聯絡資料及主系統網址。管理員收件匣如有 appType 白名單，必須加入 `82venture`。

API Key 是敏感 server-side HMAC 根；不要貼到 Git、截圖、issue 或公開訊息。

## 管理員開通

以下以 `0081` 為例，在 Vercel 對應環境新增且只新增：

```dotenv
TROOP_0081_NAME=第八十一旅深資童軍團
TROOP_0081_BACKEND=https://script.google.com/macros/s/部署識別碼/exec
TROOP_0081_APIKEY=showApiKey 顯示的同一 API_KEY
```

然後 **Redeploy**。環境變數只會在重新部署後生效，而且 Production／Preview／Development 要分別設定。

### 三項的作用

| 變數 | 作用 |
|---|---|
| `TROOP_0081_NAME` | 公開顯示名稱 |
| `TROOP_0081_BACKEND` | 唯一 Unified GAS `/exec`；`/dev` 或其他網域不接受 |
| `TROOP_0081_APIKEY` | server routing 與用途分隔 HMAC 根；不會由 `/api/units` 回給 browser |

這三項與 BADGE 的旅團登記完全相同。

### 不要設定

```text
TROOP_0081_PORTALSECRET
TROOP_0081_PORTALSESSIONSECRET
PORTAL_SESSION_SECRET
TROOP_0081_PROGRESSBACKEND
TROOP_0081_PROGRESSAPIKEY
TROOP_0081_PROGRESSCATALOG
```

也不要叫使用者在「進度 → 資料來源」輸入後端或 API Key；該頁只顯示同一 Unified Sheet 及實際 Progress action 讀取結果。空的「進度追蹤」分頁會正常顯示 0 項。

## 公開旅團名單（可選 Git metadata）

如要在未載入 server registry 前仍顯示旅團，可在 `data/units.json` 加公開 metadata：

```json
"0081": {
  "code": "0081",
  "name": "第八十一旅深資童軍團",
  "nameEn": "",
  "short": "0081venture",
  "section": "深資童軍",
  "region": "",
  "sponsor": "",
  "address": ""
}
```

只可放公開顯示資料。不要把 `backend`、`apiKey`、團員或帳目放入 Git。沒有種子資料時，不需要建立 `data/units/0081/`。

## 首次驗收

1. `/api/units` 出現旅團，但 JSON 不含 `gasUrl`／`apiKey`。
2. `/?u=0081` 可用支部本地帳戶登入；未登入不可先讀完整行政 DB。
3. `ALLOW_LOCAL_LOGIN=true`；現階段本地入口是正常主入口。
4. `#/progress/settings` 只顯示 Registry 資料來源及實際 Progress action 結果，沒有 `/exec`、Key、catalog URL、登入閘門或旅系統控制。
5. 管理系統寫入、進度勾選及 BADGE 寫入均在同一張 Sheet 出現。
6. 同一 YMIS 在所有前端對應同一人。
7. member session 只可讀寫本人進度；staff session 才可管理進度。
8. browser 偽造 `backend`、`apikey`、YMIS 或角色時，server 必須忽略或拒絕。
9. 重跑 `initializeSheets` 兩次，既有資料、帳戶 hash、進度及 API Key 不變。
10. （旅系統建立後才做）由旅系統端驗收單向讀取支部後端；支部 Progress 不新增設定或 action。BOOK 可另外提交待批匯入，但領袖確認前不得成為正式紀錄。

## 疑難排解

- **旅團沒有出現**：確認三項名稱拼對、選對 Vercel environment，然後 Redeploy。
- **後端 action 無法執行**：確認 URL 是 `https://script.google.com/macros/s/.../exec`，不是 `/dev`。
- **登入或進度失敗**：確認 Vercel `APIKEY` 與該 Unified GAS 的 `showApiKey()` 完全相同。
- **管理頁可用但 Progress action 失敗**：不要加第二套 Progress 變數；檢查 `/api/units` 的 `progressServerSide`／`backendReady` 狀態及同一 Unified GAS 的 action。
- **未來旅系統讀不到支部資料**：在旅系統的支部後端 reader／allowlist 排查；不要在 Progress 新增 URL、Key、狀態查詢或控制。

完整 staging 清單見 [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md)。
