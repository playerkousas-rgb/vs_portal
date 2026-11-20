# 已退役：Unified 新 Sheet 測試部署指引

> **本文件的舊操作步驟已全部作廢，請勿照做。** Portal 接入不需要新建 Sheet／Apps Script project、Web App 或第二個 `/exec`；也不要求匯出、搬移或複製 BADGE 帳戶／資料。
>
> `apps-script/UnifiedCode.gs` 及 `apps-script/unified-src/` 的 release channel 是 `isolated-test-only`。它們是 repo 內隔離測試組合，不是正式 BADGE adapter、不是部署包，也不是共享後端已完成的證據。不得貼入正式旅團 Sheet 或執行其 `initializeSheets`。

## 現行流程

1. 團方只提交目前 BADGE 正式 `/exec`、該 deployment 的 API Key、旅團編號／名稱及聯絡方式。
2. Admin 先核對 BADGE 原生與 Portal 所需 actions、登入 session、帳戶／密碼管理、角色權限及同一資料讀寫。
3. 正式相容層應由 BADGE source of truth 維護，原地更新同一 Apps Script project／deployment、沿用同一 Sheet、API Key、`Users` 及資料；不得建立第二身份或資料來源。
4. 在核准的真 Apps Script staging 環境完成資料保留、跨前端登入／帳戶／Progress／權限及回退測試後，Admin 才把既有 URL／Key 登記到 Vercel Registry 並 Redeploy。

截至目前，本 Portal repo 尚無已完成真實 BADGE staging 的正式 compatibility release；裸 BADGE v9.6 與 Portal 的 `authLogin`／`authWhoAmI`／`authOpenAccounts` contract 不同。`backendReady`、proxy allowlist、Unified VM 測試或申請回執均不能取代 staging。

## 相關文件

- [`BACKEND_SYNC.md`](BACKEND_SYNC.md)：Registry、action、登入／session、帳戶、Progress 及權限差異
- [`ADMIN_ONBOARDING.md`](ADMIN_ONBOARDING.md)：管理員接入及正式驗收 checklist
- [`../DEPLOY_GUIDE_FOR_TROOPS.md`](../DEPLOY_GUIDE_FOR_TROOPS.md)：團方提交既有 BADGE backend 的說明
- [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md)：真實既有 BADGE backend staging 記錄（未驗收前狀態應為 NOT RUN）