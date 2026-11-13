# Unified Apps Script staging 驗收紀錄

> 新 Sheet 的部署次序、函式名稱及環境變數見 [`UNIFIED_NEW_SHEET_SETUP.md`](UNIFIED_NEW_SHEET_SETUP.md)。不得填入 secret、完整 API Key、完整 Sheet ID 或登入 token。

## 測試環境

| 項目 | 紀錄 |
|---|---|
| 日期／測試人 | 未執行 |
| Git branch／commit | `arena/2d134fc0-vs-portal`／未 commit |
| `UnifiedCode.gs` | 463,921 bytes；SHA-256 `511267298ff83a7d4ee4fee9997672cf679120cf955795acb95c65468d467f87` |
| 測試 Sheet（只記遮罩 ID） | 未提供 |
| 測試 deployment（只記遮罩 ID） | 未提供 |
| 測試 Preview URL | 未提供 |
| 回退版本 | 未記錄 |

## 驗收結果

狀態可填 `PASS`／`FAIL`／`NOT RUN`／`DEFERRED`。未真正於 Google Apps Script runtime 執行必須保留 `NOT RUN`；只屬第 4 階段旅系統的項目，在旅系統尚未開始前標 `DEFERRED`，不計入第 3 階段支部獨立驗收。

| # | 真實 runtime 驗收 | 狀態 | 證據／備註（不可貼 secret） |
|---|---|---|---|
| 1 | vsbadge v9.6 登入、進度、獎章、履歷 | NOT RUN | |
| 2 | `initializeSheets()` 首次＋重跑兩次；既有資料／API Key／hash 完全保留 | NOT RUN | |
| 3 | 第 4 階段：中央 SSO 兩個前端均可進入 | DEFERRED | 現在未有中央旅系統；不阻擋支部獨立驗收 |
| 4 | 第 4 階段：10–20 個並發相同 purpose token，只有 1 成功（真 ScriptCache＋ScriptLock） | DEFERRED | 旅系統開始後才測 |
| 5 | 第 4 階段：跨支部／過期／錯 secret／重放全部 fail closed | DEFERRED | 旅系統開始後才測 |
| 6 | member／exco／leader／chief action scope；exco 以 saveTables／saveDb／分件／sync 偽造 identity 均拒絕 | NOT RUN | |
| 7 | event／quiz／notice `STAGING_SECRET` 未出現在 hub projection | NOT RUN | |
| 8 | 偽造 role／memberId／YMIS、猜高權內容 id 均失敗 | NOT RUN | |
| 9 | RSVP／答卷／請假只改本人，保留其他成員資料 | NOT RUN | |
| 10 | 模擬 response 遺失後重試；請假 create／withdraw 無重複、無假成功 | NOT RUN | |
| 11 | 兩 client 真 Sheet 並發不同格合併；同格衝突明確拒絕 | NOT RUN | |
| 12 | Portal 新增成員 ↔ 進度前端同一 YMIS 雙向可見 | NOT RUN | |
| 13 | Drive 測試上載可讀、DB 只留 URL、測試檔已清理 | NOT RUN | |
| 14 | MailApp 寄達測試地址；token 單次使用；真 ScriptLock 無重入／死鎖；回應／log 無 token、密碼 | NOT RUN | |
| 15 | 第 4 階段：`ALLOW_LOCAL_LOGIN=false` 時中央 SSO 可用、支部本地登入拒絕 | DEFERRED | 現階段必須保持 `ALLOW_LOCAL_LOGIN=true` |
| 16 | 回退演練成功，測試資料／trigger／Drive 檔案已清理 | NOT RUN | |

## 本機／VM 前置結果（不等於 staging）

- `npm run check`: PASS（2026-11-12，exit 0；包括重建兩份 GAS 及完整測試鏈）
- lint：22 / 0
- Smoke：591 / 0
- Portal `tests/gas.mjs`: 308 / 0
- `tests/api.mjs`: 75 / 0
- `tests/progress.mjs`: 56 / 0
- `tests/gate.mjs`: 51 / 0
- `tests/login.mjs`: 43 / 0
- `tests/usersim.mjs`: 33 / 0
- `tests/hub.mjs`: 93 / 0
- 真 `Code.gs` HTTP chain `tests/e2ereal.mjs`: 71 / 0
- Unified `tests/unified-gas.mjs`: 65 / 0
- Portal compatibility SHA-256：`c22e074349ed790997548d65de90dcac4b778b0e6d3df49d6136575a5b7ba48e`
- Unified SHA-256：`511267298ff83a7d4ee4fee9997672cf679120cf955795acb95c65468d467f87`

## 施工階段更正

2026-11-12 用戶確認由下而上施工：**BOOK 齊 → BADGE 齊 → 5 個支部系統（現在）→ 最後才建立並接通旅系統**。

因此目前找不到中央 assertion signer 是預期狀態，不是支部獨立部署缺陷。repo 內的 verifier／exchange 測試只保護第 4 階段接口，不能當成中央已完成；同時亦不應反過來阻擋第 3 階段。現階段：

- 支部 `Users`、本地密碼及支部 session 是正常身份來源，不稱為「救援帳戶」；
- `ALLOW_LOCAL_LOGIN` 必須保持 `true`；
- 不測、不啟用、不宣稱中央 SSO／旅系統已接通；
- 待五個支部完成並開始旅系統後，才把 #3–#5、#15 由 `DEFERRED` 轉為真 staging 驗收。

## 最終決定

### 第 3 階段：支部獨立部署

- [ ] #1、#2、#6–#14、#16 共 12 項全部 PASS
- [ ] `ALLOW_LOCAL_LOGIN=true`，本地 staff／member 登入實測通過
- [ ] 批准考慮支部獨立 PR／部署

目前決定：**不批准 Production**（原因只是真 Apps Script staging 尚未執行；不是因為未有中央系統）。

### 第 4 階段：旅系統接通

- [ ] 真正中央 signer 已實作
- [ ] #3–#5、#15 全部 PASS
- [ ] 批准標示「旅系統已接通」

目前決定：**DEFERRED**（旅系統尚未開始建立）。
