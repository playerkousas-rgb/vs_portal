# Portal 接入旅團既有 BADGE 後端

> **檔名沿用歷史名稱；這不是「新團接入」或搬帳戶流程。** 團方已在使用 BADGE。Portal 完整版必須接到同一個既有 BADGE `/exec`、API Key、Sheet、`Users` 帳戶及資料；不得新建另一張生產 Sheet／GAS、另建身份／帳戶表、搬移／複製帳戶或分開資料。
>
> **正式共享尚未驗收。** 裸 BADGE v9.6 使用原生 `login`／`token` 與 `bulkAddUsers` 等 action；Portal 目前需要 `authLogin`／`authWhoAmI`／`authOpenAccounts` 等 action。只提交或登記 URL／Key 不會自動使兩組 contract 相容。細節見 [`BACKEND_SYNC.md`](BACKEND_SYNC.md)。

## 團方提交

在 Portal 登入前旅團閘提交：

1. 旅團編號及名稱；
2. 目前 BADGE 正式 Apps Script `/exec`；
3. 與該 deployment 配對的現有 API Key；
4. 聯絡資料（選填）。

申請由同源 `POST /api/proxy` 轉發到固定 ADMIN 收件匣；不會自動寫 Vercel Registry。只有 ADMIN 明確回傳 `receipt: true` 才可說收到收件回執。申請不是開通完成通知，也不要求團方建立 Sheet／GAS 或搬帳戶。

API Key 是 secret，必須只經核准途徑交給平台管理員；不得放入 Git、公開訊息或截圖。

## 正式後端更新責任

裸 BADGE v9.6 並未提供 Portal 使用的 auth aliases。正式相容層必須在**BADGE source of truth** 維護，原地更新旅團目前使用的 Apps Script project／deployment：

- 保留 BADGE 原生登入、token、`Users`、角色／`can_tick`／`allowed_badges`、Progress action 及資料；
- 增加經服務端授權的 Portal contract adapter，讓 Portal 登入、身份核對、開戶、停用／復原、密碼及角色操作使用同一 BADGE `Users`／session；
- 若 Portal 完整版需要 BADGE 尚無的業務資料欄位，須在同一既有 Sheet／project 以正式 schema additive 儲存；不得建立第二個 Sheet／GAS 或複製 BADGE identity／Progress；
- 在經核准的真 Apps Script staging 環境先測資料保留、權限、並發及回退，再更新現有正式 deployment。任何初始化／migration 都要由已驗收 adapter 明確規定，不可先對正式資料試跑。

Portal repo 目前沒有已驗收可部署的正式 BADGE compatibility release。`apps-script/unified-src/` 及 `apps-script/UnifiedCode.gs` 是 `isolated-test-only`；不可部署、貼入正式 Sheet 或以 VM 測試宣稱接通。

## Admin 登記 Registry（只限正式驗收通過後）

在正確的 Vercel environment 設定同一既有 BADGE `/exec` 與 API Key：

```dotenv
TROOP_0081_NAME=第八十一旅深資童軍團
TROOP_0081_BACKEND=https://script.google.com/macros/s/<既有 BADGE deployment>/exec
TROOP_0081_APIKEY=<同一既有 BADGE deployment 的 API Key>
```

選 Production／Preview／Development 實際使用環境並 Redeploy。`/api/units` 的 `backendReady` 只代表 URL／Key 已設定；不代表 BADGE 有 Portal handlers、帳戶可共用或資料可互通。

不要建立 `TROOP_*_PROGRESSBACKEND`、`PROGRESSAPIKEY`、`PORTALSECRET` 等第二套接線；也不要把 secret 放進 `data/units.json` 或 browser。

## 跨前端驗收

使用既有 BADGE 帳戶及既有 BADGE Sheet，在同一個正式相容版本確認：

1. 同一帳戶以 BADGE 原生登入與 Portal 登入後，YMIS、姓名、角色、狀態一致；
2. Portal 批次開戶後，同一個 BADGE `Users` 能查到帳戶，BADGE 可直接登入；
3. 密碼重設、停用／復原、角色及 BADGE 權限欄位變更互相讀回，舊 session 按規格失效；
4. Portal Progress／履歷與 BADGE 對同一 YMIS 的資料讀寫落在同一張 Sheet；
5. member、執委、領袖、團長只可執行該角色獲授權的 action；偽造 session／role／YMIS／API Key、未授權 action 及跨旅團請求全部 fail closed；
6. 既有使用者、密碼 hash、名冊、Progress／履歷及 API Key 未被重設、覆寫或搬移；
7. 記錄 GAS version、測試結果與回退方式，不記 secret、token 或完整 Sheet ID。

沒有真實既有 BADGE backend staging 證據前，Portal 接線狀態保持「未驗收／不可宣稱已開通」。

## 舊新 Sheet／Unified 指引

舊文件 [`UNIFIED_NEW_SHEET_SETUP.md`](UNIFIED_NEW_SHEET_SETUP.md) 已退役。不要照其指示建立新 Sheet、貼 UnifiedCode.gs、執行 `initializeSheets` 或部署另一支 GAS。該 bundle 只供隔離測試，不是正式 BADGE adapter。
