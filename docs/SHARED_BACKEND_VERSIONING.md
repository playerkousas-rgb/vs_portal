# Portal／BADGE 同一份共用後端：版本與同步

兩個前端使用同一套完整 Apps Script；功能範圍不同不代表應分叉出精簡 GS。Portal `apps-script/UnifiedCode.gs` 和 BADGE `apps-script/Code.gs` 分別保存各自最近一次更新的完整產物；兩個 repo 可以暫時停留在不同版本，不必在每次修改後立即同步。下一次任何一邊修改前，須先承接兩邊較新的完整版本。比較**實際完整檔案 SHA-256**；同一版號但內容不同須先查清並整合。

## 每次更新前

1. 先確認兩個 repo 的最新 main，以及兩邊工作中的更新。Portal 執行 `npm run sync:check`（需 GitHub CLI 已登入及網絡）；它比較兩個遠端 main 及目前 Portal 工作分支。也可用 `npm run sync:check -- --badge /path/to/vsbadge` 比較本地 checkout，但該模式不核對遠端。指令只讀；0 表示已對齊、2 表示有漂移、3 表示未能核對。核對失敗不可假設自己持有最新版本。
2. **先比 GS 數值版本**，不以提交日期或 revision 日期凌駕版號。例如 v9.10 高於 v9.9。版本相同但 SHA 不同時，必須先比較差異及整合，不可憑日期選邊覆蓋。亦要留意未合併的並行更新；遇到版本碰撞先協調。
3. 用較新的**完整共用 GS**為底，保留雙方功能和資料保護，先處理差異再修改。以目前最高共用版本遞增一版：目前 BADGE 9.7，Portal 修改後為 9.8；下次 BADGE 若在 9.8 基礎修改則為 9.9。單純把完全相同的檔案同步到另一 repo **不用再加版**，否則永遠無法真正對齊。
4. 跑修改方的完整測試，以及另一前端與共用 GS 有關的相容測試；更新修改方的版本公告、下載、測試預期及 hash。不同 repo 版本暫時不同屬正常，不用要求另一邊即時修改；下一次另一邊更新時先承接當時較新的完整 GS、再遞增版本。
5. 不要把 git 合併當成既有旅團已部署；Apps Script、初始化及 `/exec` 更新仍須團方執行和驗收，先備份並保留可回退版本。

## 此次對齊狀態

- 核對到 BADGE main `a11935bf273b3199dd970de15a6ec0fa5174bf75`，v9.7；完整 GS SHA-256 `ada6f5012d1ff19a6701031c1e9a61ae7083876fcf35fc547792d59b886f9f4d`。它已包含 Portal 功能及 BADGE 的 `progressAll`。
- Portal 以完整 v9.7 固定副本為來源，產生 v9.8：修正 `ecStatus` 在未設 API Key 時接受空 Key、成功初始化把 Key 寫入日誌、失敗初始化可能生成 Key；並沿用既有不自動刪改歷史資料的 Portal 保全規則。v9.7 的保留超管舊資料清理政策與此不同；v9.8 不刪除歷史列，但拒絕由保留身分／角色列登入、使用舊 session 或藉 fixture 新建鏡像，亦在操作紀錄回應中隱藏保留身分或 token；仍有 BADGE 清理測試的政策差異。
- BADGE main 目前為 v9.7，Portal 此次更新為 v9.8；不要求 BADGE 即時修改。下次 BADGE 如有更新，先核對 Portal 最新完整 GS 並以最高版本遞增（如仍是 9.8 則改為 9.9）。BADGE 現行公告及下載仍是 v9.7；遠端旅團部署版本未核實。
- BADGE v9.7 原版 `npm test` 通過（含端到端 173/0）。把目前 v9.8 放入臨時 BADGE checkout，先 build 並只調整前端和測試版號後，Node 測試為 112/114：一項舊 mock 無 `Users` 工作表、另一項期望刪除超管歷史資料。只在臨時副本補模擬一般有效帳戶後為 113/114，餘下仍是超管清理政策差異。這是適配後診斷，不是原測試通過，也未涵蓋真 GAS。Portal 模擬測試另有保留歷史且拒絕舊保留身分登入和 session 的回歸。
- 原始完整 v9.7 放在 `apps-script/unified-src/vsbadge-v9.7.txt`，由 `manifest.json` 固定 hash；`npm run build:gas:unified` 用明確、單次匹配的轉換產生完整 v9.8 和 byte-for-byte 相同的瀏覽器下載內容。舊 `vsbadge-v9.6.gs`、`portal-admin-v2.8.8.gs` 和 `unified-extension.gs` 是歷史參考，不是新 build 輸入。
