# Unified Sheet：行政、進度、通告與申報

> 每個支部只有一張 Google Sheet 與一支 Unified Apps Script。管理系統、進度、BADGE、公開通告及申報都寫回這張 Sheet；不共用其他支部的後端。
>
> 現在是「BOOK → BADGE → 5 個支部系統」的第 3 階段，尚未有中央旅系統；本地支部帳戶是正常身份來源。

## 1. 拓撲

```text
管理系統 ─────────────┐
進度頁／BADGE ─────────┼──▶ 同一 Unified GAS /exec ──▶ 同一旅團 Sheet
通告／申報公開頁 ──────┘
```

不同前端可以有不同 action，但 routing 與 server-to-server HMAC 根都使用該旅團同一 `API_KEY`。API Key 不等於用戶身份；行政與進度權限仍由 server-issued session 決定。

## 2. 建立 Unified Sheet

1. 建立新的 Google Sheet。
2. **擴充功能 → Apps Script**。
3. 貼上 [`../apps-script/UnifiedCode.gs`](../apps-script/UnifiedCode.gs)。
4. 執行 `initializeSheets`。
5. 執行 `showApiKey`，安全保存 Key。
6. 部署 Web App（執行身分：我；存取權：任何人），取得正式 `/exec`。
7. Vercel 只設定：

```dotenv
TROOP_<ID>_NAME=旅團顯示名稱
TROOP_<ID>_BACKEND=https://script.google.com/macros/s/部署識別碼/exec
TROOP_<ID>_APIKEY=showApiKey 顯示的值
```

8. Redeploy。

不要把 `/exec`／API Key 寫入 Git 的 `data/units.json` 或 browser profile。不要設定 `PORTAL*`／`PROGRESS*` 第二套接線。

## 3. Sheet 內的資料

`initializeSheets` 只增補缺失 schema，不應清空現有資料或輪換 API Key。Unified Sheet 會涵蓋：

- 行政資料庫及報表：團員、帳目、物資、會議、通告、報名、申報等；
- 身份與授權映射：`Users` 及 canonical roster；
- 進度：`進度追蹤`、`其他獎章`、`待批完成`、`活動履歷`、`待批履歷`、`成員名單`；
- 操作與同步紀錄。

`Users` 本地帳戶保存 PBKDF2 hash，並在 `ALLOW_LOCAL_LOGIN=true` 時作正常日常登入。未來旅系統的 server-side reader 不會取代這個身份來源、關閉本地登入，亦不會要求 Progress 建立上游帳戶鏡像。

## 4. 行政資料保存

完整管理介面的讀寫必須先有有效 branch session：

1. 登入取得 server-issued opaque session；
2. 讀取目前 server version；
3. 本機修改；
4. 「儲存到後端」做版本與受保護欄位核對；
5. 同格衝突要明確處理，不得靜默覆蓋。

API Key 只由 server Registry 注入，不能取代 session。browser 自報 role、`__serverSigned`、YMIS 或帳戶欄位不構成授權。

## 5. 進度

- 管理系統經同源 `/api/progress` 呼叫同一 Unified GAS；BADGE 亦用同一 `/exec` 與 API Key 讀寫同一 Sheet。
- action dispatcher 直接選取 `進度追蹤`、`成員名單` 等分頁；所有分頁都屬於同一後端。
- staff 可管理全團；member action 由 session 固定本人 YMIS。
- 審批 `reviewRequest`／`reviewLogRequest` 寫回同一張 Sheet。
- 考核項目固定讀同源 `data/progress/items.json`；不是第二資料後端。
- 「進度 → 資料來源」沒有 backend、API Key、remote catalog、登入閘門或旅系統接口。
- `進度追蹤` 沒有資料時正常回成功空集合，介面顯示 0 項，不得顯示「讀取失敗」。
- 未來旅系統單向讀取支部後端；Progress 不參與該 reader 契約。
- BOOK 可讀取 BADGE 正式資料，也可提交匯入候選；候選先進待批，只有領袖確認後才寫入正式進度／履歷。

## 6. 手機申報與通告

### 收支申報

公開 `entry.html?u=<ID>` 可提供手機申報入口；後端 action 只可寫入指定待批資料，不得取得完整行政 DB。單據相片如啟用 Drive，DB 只保存 URL。

執委／領袖在管理系統批核後，才正式寫入帳目。

### 通告報名

每張通告使用獨立 `notice.html?u=<ID>&n=<通告編號>`。公開回應只可寫入該通告的白名單欄位，不能讀取其他行政資料。

## 7. 多旅團隔離

- 每旅團各有一張 Sheet、一支 Unified GAS、一個 API Key。
- Registry 以 `TROOP_<ID>_NAME/BACKEND/APIKEY` 分開。
- 另一旅團 API Key、session 或未授權 server reader request 全部不可跨旅使用。
- 不存在「未登記旅團借用預設後端」fallback。
- `/api/units` 不回傳 secret 或完整 `/exec`。

## 8. 驗收

- [ ] `/api/units` 顯示正確旅團 Registry 狀態，無 secret。
- [ ] 未登入不能下載完整行政 DB。
- [ ] 管理寫入、進度寫入與 BADGE 寫入落在同一 Sheet。
- [ ] 同一 YMIS 在所有前端對應同一人。
- [ ] browser 偽造 backend／apikey／role／YMIS 不可改路或升權。
- [ ] member 只可本人；staff scope 正確。
- [ ] 通告／申報只寫白名單欄位，不能讀完整 DB。
- [ ] 重跑 `initializeSheets` 兩次，API Key、帳戶 hash、行政與進度資料不變。
- [ ] 另一旅團 token／Key 全部拒絕。
- [ ] 真 Apps Script staging 已測 Lock、Cache、Sheet、Drive、Mail 及並發。

完整 staging 證據表見 [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md)。
