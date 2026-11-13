# 管理員手冊：支部申請接入

> 現行契約：**一張 Sheet、一支 Unified GAS、一個 API Key、三項 Vercel 支部設定。**
>
> 施工次序：BOOK → BADGE → 5 個支部系統（現在）→ 最後才建立旅系統。現在沒有中央旅系統，本地支部帳戶／session 是正常登入。

管理系統、進度及 BADGE 是多個前端，但資料與授權後端只有同一支 Unified Apps Script。API Key 只留在 server，不能當作執委身份。

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

這三項就是 BADGE 使用的同一旅團登記；進度會自動沿用。

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
- 為進度另建 Apps Script／Sheet；
- 用 API Key、query `role`、YMIS 或姓名當使用者身份；
- 以 browser 傳入的 backend／apikey 決定 server 轉發目標。

公開 `data/units.json` 只可放名稱、地區、贊助機構、主題等 metadata。敏感接線只在 Vercel environment。

## 4. 接通後的 server 行為

- `/api/units` 只回公開資料及 `backendReady`／`progressServerSide` 狀態，不回完整 `/exec` 或 API Key。
- `/api/proxy` 與 `/api/progress` 只從 Registry 取同一 `BACKEND`／`APIKEY`。
- browser 提交的 `backend`、`apikey`、角色、YMIS 不能覆蓋 Registry 或 session 身份。
- 進度考核項目固定讀同源 `data/progress/items.json`，不接受 remote catalog proxy。
- 現階段本地支部登入先簽 opaque session，再由 `authWhoAmI` 對回 staff 角色；member action 由 server 固定本人 YMIS。
- `ALLOW_LOCAL_LOGIN` 現階段必須保持 `true`。
- 第 4 階段才啟用中央 SSO assertion、branch exchange 及 exchange JTI；它們屆時由同一 API Key 以不同 purpose 派生，但 API Key 本身不直接簽發 app session。

## 5. 每次收到申請的 checklist

```text
□ 旅團編號及顯示名稱已核對
□ /exec 是正式 Google Apps Script URL，不是 /dev
□ API Key 與 Unified GAS showApiKey 完全相同
□ Vercel 只新增 NAME／BACKEND／APIKEY，沒有 PORTAL*／PROGRESS*
□ 已選對 Production／Preview／Development environment
□ 已 Redeploy
□ /api/units 有旅團且不洩漏 URL／Key
□ 管理系統、進度及 BADGE 都連到同一 Sheet
□ 進度頁沒有 browser backend／Key 輸入欄
□ staff 可管理進度；member 只能本人；未登入 fail closed
□ browser 偽造 backend／apikey／role／YMIS 被忽略或拒絕
□ initializeSheets 重跑兩次仍保留 API Key、帳戶 hash、行政及進度資料
□ ALLOW_LOCAL_LOGIN=true；支部本地 staff／member 登入已實測
□ Email 通知旅團已開通
□ （第 4 階段才做）中央 SSO 的短票、audience、unit、角色、時限及 replay 已在 staging 實測
```

## 6. 身份對應

所有現階段前端以支部同一 canonical YMIS 對人：

- 支部 `Users`、PBKDF2 密碼及 server-issued session 是現階段日常身份權威；
- `ALLOW_LOCAL_LOGIN=true`，本地入口不是後備／救援模式；
- API Key 永遠不是用戶身份；
- browser query 或 shadow account 不能提高角色。

第 4 階段旅系統建立後，才加入無本地密碼的中央 SSO 授權鏡像；中央 subject、角色及 signer 要另行 staging，不能由網址參數冒充。預留契約見 [`UNIFIED_NEW_SHEET_SETUP.md`](UNIFIED_NEW_SHEET_SETUP.md)。完整開團步驟見 [`ADD_NEW_UNIT.md`](ADD_NEW_UNIT.md)。
