# 0082「揀唔到旅團」＋「儲存唔到」事件（2026-09-17）

> 症狀（用戶原話）：首頁「第一步：揀你嘅旅團」清單冇 0082 揀，標題紅字寫 HTTP 404；
> 用 `https://ecportal.vercel.app/?u=0082` 直入得到（有資料），但「儲存唔到」。環境：PC · Chrome。
> Vercel 環境變數（Production）：`TROOP_0082_BACKEND` / `TROOP_0082_APIKEY` / `TROOP_0082_NAME`。

---

## 1. 生產環境實測（我呢邊，而家）

| 檢查 | 結果 |
|---|---|
| `GET /api/units?diag=1` | ✅ 200，`0082` 在列，`backendReady:true`，三個 `TROOP_0082_*` 全部認到，有 Key、`/exec` 通過白名單，`vercelEnv: production` |
| `GET /api/proxy` | ✅ 回 `405 此 API 只接受 POST 請求`（證明 function 存在、路由正常；POST 先係正路） |

**結論：伺服器端（Vercel functions＋環境變數）而家係正常嘅。**
用戶見到嘅 HTTP 404 係**當時一時讀唔到 `/api/units`**（例如部署／網絡 blip），
而唔係「未登記 0082」—— 未登記只會回 200＋空清單，唔會 404。

---

## 2. 點解當時會咁（還原）

**「揀唔到旅團」**：閘面嘅旅團清單嚟自 `/api/units`。
當時嗰下 404 → `fetchServerUnits()` 回空 → 同本身就係空嘅 `data/units.json`
合併 → **仲要寫埋入 localStorage，洗走咗之前記住嘅 0082** → 個閘變空。
（即係：本來有救生艇，但個浪一打埋嚟，連救生艇都抌埋。）

**「直入有資料、但儲存唔到」**：`?u=0082` 跳過咗個閘，直接用機入面
`localStorage` 嘅舊資料庫開機，所以「有資料」。但儲存要行 `/api/proxy`，
同一時間代理都係 404 → 跌咗落去「直接打 GAS」後備路線 → 舊資料庫冇 key
（key 留喺伺服器端，前端唔會知）→ GAS 回「未授權」→ 儲存失敗。
代理一正常返，儲存就會自己好返（唔使改任何設定）。

---

## 3. 今次改咗咩（code，連測試）

| # | 檔案 | 改動 |
|---|---|---|
| 1 | `assets/js/lib/units.js` | `loadRegistry()` 讀唔齊嗰陣（`/api` 或檔案其中一邊失敗），用「新讀到嘅為主、上次記住嘅補返」合併，**唔再用空殼洗走記住咗嘅旅團**；唔覆蓋 localStorage 嗰份好嘅；新增 `registryStale()` |
| 2 | `assets/js/main.js` | 閘面狀態列：用緊舊清單嗰陣會寫明「顯示緊上次記住嘅清單」，唔會扮冇事 |
| 3 | `assets/js/views/tables.js` | `pushToMaster()`（「測試連線」／「立即同步全部」）冇填本地 `/exec` 嗰陣，**改行同源 `/api/proxy`**（淨送旅團編號，等伺服器端注入 key），唔再一律話「未設定網址」；經代理一定睇 JSON 嘅 `ok/success` 先判成功（GAS 拒絕都係 HTTP 200） |
| 4 | `assets/js/lib/remote.js` | `testConnection()` 同 `remoteConfigured()` 睇齊：有代理＋旅團編號就算接得通，唔再強制要前端填 `/exec` |

測試：`tests/gate-env.mjs` 加第 ⑨ 節（8 項：404/500 頂住、正常空清單照清、兩邊合併）；
`tests/remote.mjs` 加第 ⑧ 節（9 項：經代理送出、唔送空 key、未授權要當失敗、冇代理先算未設定）。
全套 `npm test`：REAL 541、MOCK 524、公開頁 87、閘 39、登記 80、API 32、進度 33、
後端儲存 73、分頁 47、Code.gs 28 —— **全部通過，0 失敗**。

> 注意：以上改動要部署咗先對用戶生效（見第 5 步）。

---

## 4. 請 0082 用戶而家做（3 分鐘驗證）

1. **Hard refresh**：喺 `https://ecportal.vercel.app/` 撳 `Ctrl+Shift+R`
   （清走可能記住咗嘅空清單；部機唔會唔見資料）。
2. 閘面應該見到：`0082 · 第八十二旅深資童軍團 · Vercel 登記`，
   狀態列寫「伺服器登記（Vercel 環境變數）：**1** 個旅團」。
3. 撳 `0082` 入去登入，睇頂部粒「儲存狀態」：
   - 顯示「已存到後端」／「已連後端」＝ 正常。
   - 如果係「儲存失敗」，撳入去（表格與同步 → 總表同步），睇「同步紀錄」最尾嗰行，
     將成句抄返嚟（唔會有 API Key，唔使驚）。
4. 求其改少少嘢（例如開個測試通告草稿再刪咗佢），等幾秒，應該自動變返「已存到後端」。
5. 唔放心就撳「**搬遷檢查**」對一次數（表格與同步 → 總表同步）：全部 ✓ 即係後端有齊嘢。

---

## 5. 如果再發生（拎呢三樣嘢返嚟就夠斷症）

1. 閘面撳「**診斷伺服器登記**」→ 截圖（唔會有 Key 值，最多係變數名）。
2. 話返開緊嘅**完整網址**（係咪 `https://ecportal.vercel.app/`，
   定係有 `-git-`／隨機字尾嘅 Preview 網址——後者讀唔到只勾咗 Production 嘅變數）。
3. 入到去嘅話：「總表同步」最尾幾行同步紀錄。

呢三樣加埋，唔使估，一眼就知係伺服器、部署定係 GAS 嗰邊嘅問題。

---

## 6. 補充：舊站 82venture.vercel.app（另一嫌疑犯＋退役安排）

> 用戶補充：舊站係單旅團系統，將會 delete，懷疑當時係連咗去嗰邊。

### 實測結果（已證實舊站係個活陷阱）

| 檢查 | 結果 |
|---|---|
| `GET 82venture.vercel.app/api/units?diag=1` | ❌ **Vercel 404 NOT_FOUND**（成個 `/api` 冇咗） |
| `GET 82venture.vercel.app/` | 舊版閘面：有 0082（凍結咗嘅舊檔案名單）＋ MOCK，冇診斷／重新載入／直接輸入編號 |

即係：任何人開舊站（舊書籤、瀏覽器自動完成、以前印嘅 QR、WhatsApp 舊連結）
都會見到**紅字 HTTP 404＋儲存唔到**——同今次回報嘅症狀同一個模樣。
（嚴謹起見：用戶話「清單冇 0082」，舊站而家個名單仲有 0082，
所以嗰一單亦可能係正站嗰下 transient；兩邊都處理咗，唔使再估。）

### 點解新系統會「連去舊站」

Runtime code **冇任何寫死嘅舊站網址**（全文檢索過，只剩 `docs/archive/` 兩份舊文件提到）。
真正的通道係**旅團自己資料庫入面儲存咗嘅公開網址**——單旅團年代個個都係填
`https://82venture.vercel.app/notice.html` 呢類網址，而家仲跟住後端同步去每一部機：

- `settings.notice.publicBaseUrl` → 通告分享文字＋QR（`notices.js publicUrl()`）
- `settings.publicBaseUrl` → 團章 QR＋公開連結（`constitution.js publicUrl()`）
- `settings.publicLinks.*` → 成員連結頁全部（`model.js publicPageUrl()`，
  留空嗰陣先會用返而家呢個站，呢個 fallback 係安全嘅）

### 今次加咗嘅防線（同 branch，第二個 commit）

| # | 改動 |
|---|---|
| 1 | `model.js`：`LEGACY_HOSTS`／`isLegacyUrl()`／`findLegacyPublicUrls()`／`migrateLegacyPublicUrls()`（淨換 host，path＋參數照留） |
| 2 | `links.js`（成員連結）：有舊連結就彈紅色橫額＋「一鍵轉去而家呢個網址」，受影響嘅連結卡逐張警告 |
| 3 | `notices.js`：分享彈窗＋通告設定頁，舊連結會警告並指去成員連結搬 |
| 4 | `constitution.js`：團章公開網址係舊站就警告 |
| 5 | `main.js`：如果新 code 喺舊 host 度跑，boot 第一時間截停，顯示「已經搬遷」＋去新系統掣 |

測試：`gate-env` 第 ⑩ 節（5 項）、`remote` 第 ⑨ 節（15 項），全套 1504 項全過。

### 退役舊站 Checklist（次序唔好調亂）

1. **Vercel 後台先睇唔好刪**：82venture project → Deployments（邊個 commit、
   auto-deploy 有冇開）＋ Environment Variables（記低有咩，刪 project 之前截圖留底）。
2. **叫重度用戶喺舊站匯出 JSON 備份**（帳號與系統 → 資料管理 → 匯出）：
   舊站 origin 下嘅 localStorage 刪站之後就拎唔返。後端（Google Sheet）齊嘅話唔使驚，
   但有備份先夠膽。
3. **新站一鍵搬連結**：0082 入新系統 → 成員連結 → 撳「一鍵轉去而家呢個網址」
   （搬完 banner 消失先算乾淨；通告／團章頁嘅警告都會一齊消失）。
4. **重印＋重派**：搬完之後重新下載 QR／重印海報，WhatsApp 群重新貼過新連結，
   廣播話舊網址即將停用。
5. **刪 project**：Vercel → 82venture project → Settings → General → Delete Project。
   注意：`*.vercel.app` 刪 project 即死，**冇得 redirect**；想要緩衝就先 deploy
   一版純跳轉頁上去頂住一排先刪（optional，視乎仲有幾多舊 QR 流出面）。
6. 刪完之後隨手抽查：開幾條新 QR／連結，確認落喺 `ecportal.vercel.app` 讀得到、
   報到名。
