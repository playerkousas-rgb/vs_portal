# 支部負責人自行測試共用後端候選版

這份步驟供**明白風險並自行決定測試的支部負責人**使用。`apps-script/UnifiedCode.gs` 是未經真 Google Apps Script 驗收的候選版，不是已驗收的正式 release；合併到本 repo 的 `main` 不會自動更新任何旅團的 Google Apps Script。若測試對象正在供旅團使用，操作期間登入及資料讀寫可能受影響。不要在聊天、issue、截圖或 Git 貼 API Key、帳戶、密碼、token 或 Sheet 私人資料。

## 先備份

1. 在原 Google Sheet 使用「檔案 → 建立副本」，確認副本包含要保留的用戶、名冊、進度和其他分頁。這是備份，**不是另一個供 Portal 使用的後端**。
2. 在原 Sheet 的「擴充功能 → Apps Script」保存／記錄目前程式和 web app 部署版本，確認能在「部署 → 管理部署」選回該版本；保留既有 Script Properties，包括 `API_KEY`。複製 Sheet 不應假設能還原原本的部署及 Script Properties。
3. 確認自己操作的是原旅團的既有專案，並知道原本 `/exec` 所屬的 deployment。不要刪除原部署或新建另一個正式 Sheet／帳戶表。

## 貼入及初始化

1. 從本 repo 的 `apps-script/UnifiedCode.gs` 複製**整份**候選程式；不要誤用 Portal 歷史版本 `apps-script/Code.gs`。若 Apps Script 專案有多個程式檔，先核對避免重複的 `doGet`、`doPost`、`initializeSheets` 等定義，不要盲目刪除其他程式。
2. 在原有 BADGE Apps Script 專案替換對應的原 GS 程式並儲存。不要清除 Script Properties 或改 API Key。
3. 在編輯器選擇並執行一次 `initializeSheets`，按 Google 提示授權。查看結果／執行紀錄；**若報錯或顯示部分完成，不代表已回滾**，先停止並核對分頁及備份，不要盲目重試。
4. 若要讓原有 `/exec` 使用新程式，在「部署 → 管理部署」選**原有 web app deployment**、編輯並選擇新版本；確認部署 ID／`/exec` 沒變。儲存程式或執行初始化本身不會更新既有 `/exec` 的版本。

## 自行檢查

- 原 `Users`、密碼 hash、名冊、進度、履歷及額外欄位是否仍在；新加入的 Portal 專用分頁可以是空的。
- 使用同一個既有帳戶，分別試 BADGE 及 Portal 登入；試一次受權的名冊更新及進度讀寫，再由另一前端讀回。
- 測試角色和權限，以及新增資料／切換裝置後讀回；如有異常，記錄操作和不含敏感資料的錯誤，停止繼續寫入。
- Portal Registry 必須指向同一既有 `/exec` 和其 server-side API Key。`backendReady` 只表示 Registry 已設定，不代表整合已通過。

## 回退

在「部署 → 管理部署」把**原有 deployment**選回升級前的版本，核對原 `/exec` 可用。這只回退程式，**不會自動還原 Sheet 或 Script Properties 的變更**；如需恢復資料，由備份核對後還原相應分頁／儲存格。若初始化部分完成，亦須檢查新增分頁和欄位，勿盲目刪除原有資料。

結果和待驗收項目見 [`UNIFIED_STAGING_RESULTS.md`](UNIFIED_STAGING_RESULTS.md)。
