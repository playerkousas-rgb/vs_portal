# Unified Apps Script staging 驗收紀錄

> 新 Sheet 的部署次序、函式名稱及環境變數見 [`UNIFIED_NEW_SHEET_SETUP.md`](UNIFIED_NEW_SHEET_SETUP.md)。不得填入 secret、完整 API Key、完整 Sheet ID 或登入 token。

## 測試環境

| 項目 | 紀錄 |
|---|---|
| 日期／測試人 | 未執行 |
| Git branch／commit | `arena/58e4908e-vs-portal`／本次前後端定位更正 commit |
| `UnifiedCode.gs` | 465,500 bytes；SHA-256 `21d74689762d662d400a3bdc8e30368b3f295311a4e8daa4d7f245dd5787ee6e` |
| 測試 Sheet（只記遮罩 ID） | 未提供 |
| 測試 deployment（只記遮罩 ID） | 未提供 |
| 測試 Preview URL | 未提供 |
| 回退版本 | 未記錄 |

## 驗收結果

狀態可填 `PASS`／`FAIL`／`NOT RUN`／`DEFERRED`。未真正於 Google Apps Script runtime 執行必須保留 `NOT RUN`；只屬未來旅系統 reader 的項目，在旅系統尚未開始前標 `DEFERRED`，不計入支部獨立驗收。

| # | 真實 runtime 驗收 | 狀態 | 證據／備註（不可貼 secret） |
|---|---|---|---|
| 1 | 同一完整 Unified GS 上：vs_portal 功能完整版流程及 vsbadge 輕量版登入、進度、獎章、履歷 | NOT RUN | 不另建 BADGE 精簡 GS |
| 2 | `initializeSheets()` 首次＋重跑兩次；既有資料／API Key／hash 完全保留 | NOT RUN | |
| 3 | 未來旅系統 reader 只可呼叫 allowlisted read action，回最小投影 | DEFERRED | 現在未有旅系統；不阻擋支部獨立驗收 |
| 4 | reader 的錯 unit／錯 Key／未授權 action／逾時／重放全部 fail closed | DEFERRED | 旅系統建立後由旅系統端測 |
| 5 | 五個支部 reader 互相隔離，旅層聚合不造成支部 ↔ 支部路徑 | DEFERRED | 旅系統建立後由旅系統端測 |
| 6 | member／exco／leader／chief action scope；exco 以 saveTables／saveDb／分件／sync 偽造 identity 均拒絕 | NOT RUN | |
| 7 | event／quiz／notice `STAGING_SECRET` 未出現在 hub projection | NOT RUN | |
| 8 | 偽造 role／memberId／YMIS、猜高權內容 id 均失敗 | NOT RUN | |
| 9 | RSVP／答卷／請假只改本人，保留其他成員資料 | NOT RUN | |
| 10 | 模擬 response 遺失後重試；請假 create／withdraw 無重複、無假成功 | NOT RUN | |
| 11 | 功能完整版與輕量版前端在真 Sheet 並發不同格合併；同格衝突明確拒絕 | NOT RUN | |
| 12 | vs_portal 新增成員 ↔ vsbadge 輕量前端同一 YMIS 雙向可見；各自 action allowlist／role／scope 生效 | NOT RUN | |
| 13 | Drive 測試上載可讀、DB 只留 URL、測試檔已清理 | NOT RUN | |
| 14 | MailApp 寄達測試地址；token 單次使用；真 ScriptLock 無重入／死鎖；回應／log 無 token、密碼 | NOT RUN | |
| 15 | 未來 reader 運作時支部 `ALLOW_LOCAL_LOGIN=true`，Progress 無新增旅系統設定／控制 | DEFERRED | 本地登入永久維持正常入口 |
| 16 | 回退演練成功，測試資料／trigger／Drive 檔案已清理 | NOT RUN | |

## 本機／VM 前置結果（不等於 staging）

- `npm test`: PASS（2026-11-12，exit 0；包括重建兩份 GAS 及完整測試鏈）
- lint：22 / 0
- Smoke：602 / 0
- `tests/progress.mjs`: 48 / 0
- 系統樹 boundary：51 / 0
- 真 `Code.gs` contract `tests/gas.mjs`: 308 / 0
- 真 `Code.gs` HTTP chain `tests/e2ereal.mjs`: 71 / 0
- Unified `tests/unified-gas.mjs`: 76 / 0
- Portal compatibility SHA-256：`c22e074349ed790997548d65de90dcac4b778b0e6d3df49d6136575a5b7ba48e`
- Unified SHA-256：`21d74689762d662d400a3bdc8e30368b3f295311a4e8daa4d7f245dd5787ee6e`

## 施工階段更正

2026-11-12 用戶確認由下而上施工：**BOOK 齊 → BADGE 齊 → 5 個支部系統（現在）→ 最後才建立並接通旅系統**。

同日確認前後端定位：每支部 Unified GS／Sheet 是完整功能後端；vs_portal 是功能完整版前端，vsbadge 是輕量前端。輕量只描述 UI／client surface，不代表另有精簡 GS；兩個前端均須通過各自 action allowlist 及後端 session／role／scope 驗證。

因此目前沒有旅系統 reader 是預期狀態，不是支部獨立部署缺陷。repo 內 verifier／exchange 只屬隔離 auth fixture，不能當成旅系統施工規格或完成證據，也不應反過來阻擋支部驗收。現階段：

- 支部 `Users`、本地密碼及支部 session 是正常身份來源，不稱為「救援帳戶」；
- `ALLOW_LOCAL_LOGIN` 保持 `true`；
- assertion／exchange fixture 不啟用為正式登入，不宣稱中央 SSO／旅系統已接通；
- 待五個支部完成並建立旅系統後，才由旅系統端把 #3–#5、#15 轉為 reader staging 驗收。

## 最終決定

### 支部獨立部署

- [ ] #1、#2、#6–#14、#16 共 12 項全部 PASS
- [ ] `ALLOW_LOCAL_LOGIN=true`，本地 staff／member 登入實測通過
- [ ] 批准考慮支部獨立 PR／部署

目前決定：**不批准 Production**（原因只是真 Apps Script staging 尚未執行；不是因為未有旅系統）。

### 旅系統 reader（最後階段）

- [ ] 旅系統端已實作 allowlisted、最小投影的支部 reader
- [ ] #3–#5、#15 全部 PASS
- [ ] 隔離 assertion／exchange fixture 沒有被當成完成證據

目前決定：**DEFERRED**（旅系統尚未開始建立）。
