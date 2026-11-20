# Portal／BADGE 共用既有後端 staging 記錄

> **本文件記錄的是正式 BADGE backend 的 staging；不是 Unified 新 Sheet 部署紀錄。** 不得要求旅團建立第二張生產 Sheet／GAS、搬移或複製帳戶。測試可由維護者使用核准的 staging 環境；正式接線必須沿用旅團目前 BADGE `/exec`、API Key、Sheet、`Users` 及資料。
>
> `apps-script/UnifiedCode.gs`／`unified-src/` 標記為 `isolated-test-only`，不是正式相容版本。此組合、VM 測試、proxy allowlist 與 Registry `backendReady` 均不等於真實既有 BADGE Apps Script staging。

## 測試環境記錄

| 項目 | 紀錄 |
|---|---|
| 日期／測試人 | 未執行 |
| Portal branch／commit | 本工作分支；未記錄正式 release commit |
| BADGE upstream 基準 | `playerkousas-rgb/vsbadge@87c76a98b95ff7b5e2a7be02198142c72aefc24e`（v9.6） |
| 正式共用 adapter version／hash | 尚未建立／未提供 |
| 測試 BADGE GAS version | 未提供 |
| 測試 deployment（遮罩 ID） | 未提供 |
| 測試 Sheet（遮罩 ID） | 未提供 |
| 既有 `/exec` 是否保留 | 未驗收 |
| API Key／既有資料保留 | 未驗收 |
| 回退版本與演練 | 未記錄 |

**目前結論：候選 adapter 已建立，但未有真 Apps Script 部署及驗收證據；真 Apps Script 測試為 NOT RUN。不得宣稱已批准正式開通。** 支部負責人如決定自行試用候選版，請先按 [`USER_SELF_TEST.md`](USER_SELF_TEST.md) 備份並了解回退限制。

## 用戶提供測試 Sheet：唯讀結構檢查

2026-11-20 透過已連接的 Google Drive 唯讀檢查用戶提供的試算表（檔案名 `Untitled spreadsheet`）。用戶其後澄清自己的旅團亦在使用它，並非純隔離環境；帳戶可編輯，但**沒有修改 Sheet、Apps Script、deployment 或資料**。以匯出工作簿檢查表頭後，臨時匯出檔已刪除，沒有把試算表內容或敏感資料加入 repo。用戶會自行測試；因這是實際使用中的旅團資料，先完整備份並記錄可回退版本，且任何寫入或升級都必須明確提醒可能影響現有用戶。

- 存在 BADGE 的 `Users`、`成員名單`、`進度追蹤`、`密碼重設` 及其他進度／履歷分頁；未看到 Portal 行政儲存／報表分頁。
- `Users` 有一筆資料；`成員名單` 和 `進度追蹤` 沒有資料行，這是合法測試起點，不要求先建立普通成員或複製帳戶。
- `進度追蹤` 六個位置式表頭符合候選版 preflight；`Users` 有 `ymis` 及其他既有帳戶欄位，也有 `squad`、`squad_role`；`成員名單` 亦有額外 `小隊` 欄。使用相同欄位順序及**合成資料**新增 VM 測試，初始化及 Portal 名冊更新均保留額外欄位的原有值；實際升級仍需驗證。
- 只讀檢查未證明 Sheet 綁定的 Apps Script 版本或 `/exec`，亦未執行初始化、寫入、雙前端、並發或回退。此環境的 Drive connector 沒有 Apps Script 原始碼編輯、部署或執行工具，不能由此宣稱 staging 通過。

## 正式 staging 驗收

`PASS` 必須指真 Apps Script runtime 與同一既有 BADGE 資料模型的可核查結果。只在 VM、mock、測試 router 或靜態檢視中通過，該項仍是 `NOT RUN`。

| # | 必須驗證 | 狀態 | 證據／備註（不可貼 secret） |
|---|---|---|---|
| 1 | 正式相容 adapter 來自 BADGE source of truth，且更新到既有 GAS project／deployment，保留原 `/exec` 與 API Key | NOT RUN | |
| 2 | BADGE 原生 `login`／`token`、`addUser`／`bulkAddUsers` 及既有 Progress actions 均保持可用 | NOT RUN | |
| 3 | Portal `authLogin`／`authWhoAmI` 從同一 BADGE `Users` 驗證帳戶、session、YMIS、姓名、角色及狀態 | NOT RUN | |
| 4 | 同一既有帳戶可從 BADGE 與 Portal 互相登入；沒有第二帳戶／密碼資料表 | NOT RUN | |
| 5 | Portal 批次開戶落到同一 BADGE `Users`；BADGE 立即可登入；已有帳戶不重複建立 | NOT RUN | |
| 6 | 密碼更改／管理重設／自助重設沿用同一 BADGE 密碼權威，重設後舊 session 按規格失效 | NOT RUN | |
| 7 | Portal 停用／復原與 BADGE `setUserStatus`／安全刪除行為一致；帳戶與 Progress 歷史不會被意外刪除 | NOT RUN | |
| 8 | Portal 角色／can_tick／allowed_badges 變更與 BADGE `updateUserRole`／`updatePermissions` 一致，不能升權或遺失既有欄位 | NOT RUN | |
| 9 | 名冊新增／更新不覆蓋 BADGE 權限欄；同一 YMIS 在兩個前端互相讀回 | NOT RUN | |
| 10 | Portal `loadDb`／`saveDb`／`loadTables`／`saveTables`（如納入正式 contract）與 BADGE 原生資料共存於同一既有 Sheet；不建立第二個資料來源 | NOT RUN | |
| 11 | `load`／`save`／`saveOtherBadge`、待批完成及活動履歷等 Progress action 在兩個前端讀寫同一張 Sheet | NOT RUN | |
| 12 | member／執委／領袖／團長的帳戶、行政及 Progress action scope；未授權 action 均由 GAS 服務端 fail closed | NOT RUN | |
| 13 | 缺少／偽造／過期 session、browser `role`／YMIS、單獨 API Key 及錯旅團 URL／Key 均被拒絕 | NOT RUN | |
| 14 | Vercel proxy 只選 Registry 的既有 `/exec`／Key，且沒有把 action allowlist 或 `backendReady` 當作身份／相容性檢查 | NOT RUN | |
| 15 | 並發／Lock、逾時結果、重放、資料版本與 readback；沒有假成功或重覆開戶 | NOT RUN | |
| 16 | 原地升級後 BADGE `Users`、hash、名冊、Progress／履歷、API Key 及現有使用者逐項保留 | NOT RUN | |
| 17 | 回退到先前 BADGE deployment version 成功；不需新建 Sheet／GAS 或複製帳戶 | NOT RUN | |

任何未通過或未執行項目都不應標記「已開通」。Registry 的 `backendReady` 只代表格式正確的 URL／Key 已設定。

## 隔離測試（不計為 staging）

- `apps-script/unified-src/manifest.json` 的 `releaseChannel` 是 `isolated-test-only`；2026-11-20 候選 `apps-script/UnifiedCode.gs` SHA-256 `874d7d90c245d9eff3de186c0ef4c09df8a9ea383729aa17b328e952f1377af4` 的 `npm run test:unified` 為 **156 PASS／0 FAIL**（包括按提供的 Sheet 表頭新增的兩項模擬測試）。涵蓋共用首個管理員、同 Sheet 現有 BADGE 資料直接讀取、所有普通及分件寫入強制共享版本、首筆 delegated 權限、簽名入口控制及 rescue session、刪除／重新加入、寫入後並發版本、部分失敗與 operation ID 私隱。這是模擬而非真 GAS；source 變動後須重建重測。
- `tests/gas.mjs` 測的是 Portal repo 的 GAS template，不代表 BADGE 既有部署。
- 2026-11-20 在臨時 BADGE checkout（`vsbadge@1085b033ad83488f50fa2323e7d216646bdb9ceb`，原 `Code.gs` hash 與 pinned v9.6 相同）對候選執行未修改的 BADGE `security`、`password_reset`、`auth-hardening`、`login-kdf`、`request-review`、`legacy_progress`、`troop_link` 七組 Node 測試：**71 PASS／4 FAIL**。舊的 6 項逐項結果如下：
  1. **密碼重設初始化：** 原測試的 Sheet mock 缺 `getSheetId()`。只在隔離測試副本補上真 GAS API 的 mock 後，密碼重設組 13／13 通過；真 GAS staging 仍未測。
  2. **匿名 GET load：** 原測試期望可匿名讀取，候選刻意要求 session，以防洩露名冊及進度。BADGE 現有前端透過 proxy 帶 token；模擬測試驗證已登入讀取，真前端仍須驗收。
  3. **初始化時刪除保留超管歷史列：** 原測試期望刪除和匿名化舊列；候選按資料保全要求保留，不可為通過測試刪掉歷史資料。舊保留 token 不獲驗證。另修復已驗證的無狀態救援 session 在關閉入口後仍能 GET load。
  4. **簽名遠端入口控制：** 已恢復 BADGE 原有簽名路由及防重播，原上游測試通過。
  5. **接駁資料只存 Properties：** 同上，原上游測試通過。
  6. **GS 只容許一處版本字樣：** 原測試是 BADGE 單源檔的格式規範；組合版包含 Portal 來源版本、release 常數和註解，因此不符合，並非 runtime 測試。未修改上游測試不通過；不能聲稱全面相容。

  額外診斷把隔離副本的 Sheet mock 及上述兩項明確改變的預期調整後，其餘測試（包括關口救援流程）通過，只餘版本字樣規範（74／75）。這不是原始上游測試通過，也不是完整 BADGE 或 staging。
- 2026-11-20 最終候選 `npm run check` exit 0（包含 Unified VM 154/0 和 GS VM 端到端測試）；上一輪額外 `npm run test:audit` 為 44/44 組成功、1847 個元素、0 問題。這些均是本地結果，不代替上列 BADGE 相容問題或真實 staging。
- **發布阻擋：** 普通 Portal 寫入現在必須帶 `U-` 版本；強制修復仍刻意繞過版本檢查，必須人工確認。舊式含完整 `db` 的報表同步現被拒絕，以免繞過寫入保護；未認領報表、Script Properties tombstone 容量／配額、所有原生寫入及並發仍需審核。上游相容差異與真實 staging #1–#17 未完成前不能發布。新旅團無一般用戶／業務記錄屬正常，兩個前端共享同一 `Users` 首個管理員，不另設帳戶表。
- `tests/api.mjs` 可驗證 Registry／proxy 路由與 allowlist，但不會讓裸 BADGE v9.6 出現 Portal auth handlers。
- Portal 文件、測試或程式碼修改不會自動更新任何真 Apps Script deployment。

以上項目可作為程式回歸證據，不能把正式 staging 的 `NOT RUN` 改成 `PASS`。

## 開通決定

- [ ] BADGE source of truth 已接受正式 adapter 與版本化 action contract
- [ ] 真實既有 BADGE Apps Script staging 的 #1–#17 全部 PASS
- [ ] 同一帳戶、密碼、session、角色、名冊及 Progress 已跨前端互相讀回
- [ ] 原地回退演練成功，沒有第二 Sheet／GAS、帳戶表或資料來源
- [ ] 維護者批准將既有 URL／Key 登記至 Vercel 指定 environment

目前決定：**NOT APPROVED — adapter 尚未建立／部署，真 Apps Script staging 尚未執行。**