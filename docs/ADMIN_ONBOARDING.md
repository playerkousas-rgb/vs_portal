# 管理員手冊：支部申請接入

> 現行契約：**一張 Sheet、一支 Unified GAS、一個 API Key、三項 Vercel 支部設定。**
>
> 施工次序：BOOK → BADGE → 5 個支部系統（現在）→ 最後才建立旅系統。現在沒有中央旅系統，本地支部帳戶／session 是正常登入。

每支部只有一支具備身份、行政、Progress、獎章、履歷及申報能力的完整 Unified Apps Script。支部系統是功能完整版前端；BADGE 是只呈現部分流程的輕量前端，而不是另一支精簡 GS。兩者共用同一資料與授權後端；API Key 只留在 server，不能當作執委身份。

## 1. 申請人先完成

1. 建立一張新的 Google Sheet。
2. 在綁定的 Apps Script 貼上 [`apps-script/UnifiedCode.gs`](../apps-script/UnifiedCode.gs)。
3. 執行 `initializeSheets`。
4. 執行 `showApiKey`，安全保存 API Key。
5. 部署 Web App（執行身分：我；存取權：任何人），複製正式 `/exec`。
6. 在 App 的「新旅團申請接入」送出旅團編號、名稱、`/exec`、API Key 與聯絡資料。

申請會先送同源 `POST /api/proxy`（`action=submitRegistration`），再由 server 固定的管理員收件匣接收。Payload 以 `appType: "82venture"` 分辨；收件匣如有白名單要加入該值。

只有連線／逾時或收件匣明確回 `success:false` 才算失敗。管理員收到後仍要自行通知申請人開通結果。

## 2. 管理員只設定三項

以旅團 `0100` 為例，在正確的 Vercel environment 設定：

```dotenv
TROOP_0100_NAME=第一百旅深資童軍團
TROOP_0100_BACKEND=https://script.google.com/macros/s/部署識別碼/exec
TROOP_0100_APIKEY=該 Unified GAS 的 showApiKey 值
```

然後 **Redeploy**。

| 變數 | 核對 |
|---|---|
| `NAME` | 公開顯示名稱正確 |
| `BACKEND` | 只接受 Google Apps Script 正式 `/exec`；不接受 `/dev` |
| `APIKEY` | 與同一 Unified GAS 的 `API_KEY` 完全相同 |

這三項就是 BADGE 使用的同一支部 Registry；功能完整版 vs_portal 與輕量版 vsbadge 都連到同一支完整後端，Progress 只是完整版前端內的業務模組。

## 3. 禁止建立第二套接線

不要設定：

```text
TROOP_<ID>_PORTALSECRET
TROOP_<ID>_PORTALSESSIONSECRET
PORTAL_SESSION_SECRET
TROOP_<ID>_PROGRESSBACKEND
TROOP_<ID>_PROGRESSAPIKEY
TROOP_<ID>_PROGRESSCATALOG
```

不要：

- 把 backend 或 API Key 放進 `data/units.json`／`unit.json`；
- 叫使用者在進度頁貼 `/exec` 或 Key；
- 為進度或 BADGE 輕量前端另建 Apps Script／Sheet；
- 因 BADGE 未顯示某功能就把畫面隱藏當成授權；
- 用 API Key、query `role`、YMIS 或姓名當使用者身份；
- 以 browser 傳入的 backend／apikey 決定 server 轉發目標。

公開 `data/units.json` 只可放名稱、地區、贊助機構、主題等 metadata。敏感接線只在 Vercel environment。

## 4. Registry 登記後的 server 行為

- `/api/units` 只回公開資料及 `backendReady`／`progressServerSide` 狀態，不回完整 `/exec` 或 API Key。
- `/api/proxy` 與 `/api/progress` 只從 Registry 取同一完整 `BACKEND`／`APIKEY`。
- 功能完整版與輕量版前端各自受 action allowlist 約束；Unified GS 再按 session、role、scope 授權。
- browser 提交的 `backend`、`apikey`、角色、YMIS 不能覆蓋 Registry 或 session 身份。
- 進度考核項目固定讀同源 `data/progress/items.json`，不接受 remote catalog proxy。
- 本地支部登入先簽 opaque session，再由 `authWhoAmI` 對回 staff 角色；member action 由 server 固定本人 YMIS。
- `ALLOW_LOCAL_LOGIN` 保持 `true`；支部本地帳戶是正常登入來源。
- repo 內 assertion／exchange 只屬隔離 auth fixture，不在開團時啟用，也不是未來旅系統 reader 的規格。
- 未來旅系統由旅系統 server 單向讀取支部後端最小投影；支部 Progress 不保存或控制該關係。

## 5. 每次收到申請的 checklist

```text
□ 旅團編號及顯示名稱已核對
□ /exec 是正式 Google Apps Script URL，不是 /dev
□ API Key 與 Unified GAS showApiKey 完全相同
□ Vercel 只新增 NAME／BACKEND／APIKEY，沒有 PORTAL*／PROGRESS*
□ 已選對 Production／Preview／Development environment
□ 已 Redeploy
□ /api/units 有旅團且不洩漏 URL／Key
□ Unified GS 同時具備身份、行政、Progress、獎章、履歷及申報能力
□ 功能完整版 vs_portal 與輕量版 vsbadge 都連到同一 Sheet，沒有第二支精簡 GS
□ 進度頁沒有 browser backend／Key 輸入欄
□ 兩個前端均受 action allowlist 限制；staff 可管理進度，member 只能本人，未登入 fail closed
□ browser 偽造 backend／apikey／role／YMIS 被忽略或拒絕
□ initializeSheets 重跑兩次仍保留 API Key、帳戶 hash、行政及進度資料
□ ALLOW_LOCAL_LOGIN=true；支部本地 staff／member 登入已實測
□ assertion／exchange fixture 沒有被當成開團或旅系統前置條件
□ Email 通知旅團已開通
```

## 6. 身份對應

功能完整版 vs_portal 與輕量版 vsbadge 以支部同一 canonical YMIS 對人：

- 支部 `Users`、PBKDF2 密碼及 server-issued session 是現階段日常身份權威；
- `ALLOW_LOCAL_LOGIN=true`，本地入口不是後備／救援模式；
- API Key 永遠不是用戶身份；
- browser query 或 shadow account 不能提高角色。

未來旅系統建立後，只由旅系統端加入單向支部 reader；不在支部建立中央帳戶鏡像，亦不關閉本地登入。reader 的 allowlist、最小投影及 server-side 驗證須另行 staging。邊界見 [`UNIFIED_NEW_SHEET_SETUP.md`](UNIFIED_NEW_SHEET_SETUP.md)，完整開團步驟見 [`ADD_NEW_UNIT.md`](ADD_NEW_UNIT.md)。
