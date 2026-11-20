# 深資童軍管理系統

深資童軍支部管理平台：會議、行事曆、財務、用戶與身份、物資、通告、團章、進度及資料同步。Runtime 使用原生 HTML／CSS／JavaScript ES Modules；Portal 完整版的目標是與 BADGE 輕量版共用各旅團現有 BADGE Google Sheet、Apps Script 後端及帳戶。正式共用 action contract 尚待完成及 staging 驗收，詳見 [`docs/BACKEND_SYNC.md`](docs/BACKEND_SYNC.md)。

> [!IMPORTANT]
> **所有支部內容只限已登入的本地身份。** 系統沒有匿名通告、匿名團章、匿名申報、匿名借用或 `publicProfile`。
>
> `notice.html`、`constitution.html`、`entry.html`、`borrow.html` 只保留舊網址兼容，會轉到 `members.html` 登入流程；它們不會匿名讀取或寫入資料。

## 目前系統邊界

```text
Portal 完整前端 ── Portal server Registry／同源 Proxy ─▶ 旅團既有 BADGE /exec／Sheet／Users
BADGE 輕量前端 ─────────────────────────────────────────▶ 同一既有 BADGE 後端
```

**產品關係：BADGE 是功能較精簡的前端，支部系統是功能完整版前端；旅團可只用其中一個，也可兩個一起用。** 單獨使用任何一個時都不應依賴另一個前端網站開啟或登入；一起使用時，兩個前端應連同一支部的完整共用後端和資料，而不是互相同步兩套帳戶或資料。這與成員系統／區管理系統共用後端的模式相似，但 BADGE 本身有登入，不是公開免登入入口。

這是目標架構，不代表目前已驗收完成。Vercel Registry／Proxy 已存在，但裸 BADGE v9.6 action contract 與 Portal auth actions 不同；Admin 登記 URL／Key 本身不會補上相容 adapter。Unified GAS 是未經真實 Apps Script 驗收的候選版，不可視為已驗收的正式共享後端。支部負責人自行試用前請閱讀 [`docs/USER_SELF_TEST.md`](docs/USER_SELF_TEST.md)；正式狀態及缺口見 [`docs/BACKEND_SYNC.md`](docs/BACKEND_SYNC.md)。

- 已有 BADGE 後端的旅團加入 Portal 時，不應另建 Sheet／GAS、第二帳戶表或資料來源；既有 BADGE Users／名冊是身份與資料權威。全新支部首次建置及只有 Portal 的既有部署如何升級，需另行制定及驗證，不能假定每個旅團已有 BADGE。
- 瀏覽器不會把 API Key 當身份；敏感資料必須由正式共用後端按同一 BADGE 使用者及服務端授權重新驗證。
- Registry 只保存 server-side `/exec`／Key，`/api/units` 不回傳 secret；`backendReady` 不代表 action 相容。
- BOOK 匯入只會先成為待批資料；領袖確認後才可寫入正式紀錄。
- 更完整的邊界見 [`SCOPE.md`](SCOPE.md)。

## 支部身份與權限

身份及模組定義集中在 [`assets/js/lib/branch-config.js`](assets/js/lib/branch-config.js)。`exco` 等身份只屬目前 `venture-scout` 支部 schema，不是平台通用身份。

| 身份 | 層級 | 說明 |
|---|---:|---|
| `member` | 1 | 團員 |
| `exco` | 2 | 執委 |
| `leader` | 3 | 領袖 |
| `chief` | 4 | 團長（單一） |
| `super` | 5 | 隱藏平台管理身份 |

每個側欄模組都有三個獨立開關：

```text
db.accessControl.modules[moduleId][roleId] = { show, read, edit }
```

- `show`：側欄是否顯示。
- `read`：是否可以直接開啟路由及讀取資料。
- `edit`：是否可以修改；`edit` 必定包含 `read`。
- 權限單調向上：低身份已有的 grant，高身份不能較少。
- 操作者只會看到自己及較低身份的權限欄；只可修改嚴格較低身份。
- 隱藏入口不等於授權。直接輸入 URL、直接呼叫 API 或偽造 payload，仍須通過後端檢查。

純資料正規化及遷移在 [`assets/js/lib/access-schema.js`](assets/js/lib/access-schema.js)，前端 runtime gate 在 [`assets/js/lib/access.js`](assets/js/lib/access.js)。Portal 原 GAS 與 BADGE 的身份資料模型不同；不能因此宣稱已使用同一 BADGE 帳戶。正式共用後端必須以既有 BADGE Users 為權威，並由該 GAS 對 Portal actions 重新驗證角色及 scope。

### 身份資料保密

Portal 測試後端的行政資料投影設計只回傳（正式 BADGE adapter 尚未驗收）：

1. 操作者自己的 member／account 列；以及
2. 嚴格較低身份的列。

同級其他人及較高身份不會送到瀏覽器。完整或逐表寫入時，後端會先補回投影中省略的 server 列，再驗證真正差異；client 新增的列仍必須通過 `create` 權限，不能冒充「投影省略列」。密碼 hash、帳戶綁定、角色、資料庫 envelope 及 server metadata 都是受保護欄位。

## 入口

| 入口 | 用途 |
|---|---|
| `index.html?u=<支部編號>` | 已登入行政入口 |
| `members.html?u=<支部編號>` | 已登入團員自助入口 |
| `reset-password.html?u=<支部編號>` | 伺服器驗證的密碼復原 |
| `notice.html`／`constitution.html`／`entry.html`／`borrow.html` | 舊連結兼容；只轉到 `members.html`，不匿名 fetch |

團員入口只經 session-bound actions 讀寫本人資料，包括安全內容投影、RSVP、試卷、通告回覆、請假與個人進度。Client 提交的 `memberId`、身份或角色不會成為權威值。

## 功能模組

目前支部 schema 包含：

- 儀表板
- 行事曆及請假
- 試卷
- 會議
- 財務
- 用戶與身份
- 物資
- 進度
- 通告
- 團員入口連結
- 團章
- 資料管理
- 系統管理

實際可見、可讀、可編輯範圍由每個支部自己的 `db.accessControl` 決定。

## 後端來源與隔離測試產物

| 路徑 | 用途 |
|---|---|
| `assets/js/lib/gastemplate.js` | 本 repo 原 Portal GAS source；含 Portal 自有帳戶模型，不能作為共用 BADGE Users 的正式後端 |
| `apps-script/Code.gs` | 由 Portal GAS source 生成的相容性／歷史 artifact；不是裸 BADGE 共用後端 |
| `apps-script/unified-src/` | pinned BADGE v9.6 + Portal adapter 的隔離測試 source |
| `apps-script/UnifiedCode.gs` | 由 Unified builder 生成的 `isolated-test-only` 候選 artifact；未經正式驗收，支部負責人自行測試參考 [`docs/USER_SELF_TEST.md`](docs/USER_SELF_TEST.md) |

正式共用 BADGE 後端的 action contract、升級／回退與 staging 驗收仍未完成。修改任何 source 不會自動更新旅團既有 Apps Script deployment。

Unified builder 只驗證隔離測試組合，不構成正式共用後端部署證據。

## 本機開發

需求：Node.js 20 或以上。

```bash
npm install
npm run dev
```

開發伺服器會把 `api/*.js` 與共用 branch schema 複製到同一個 generation，避免 Node ESM cache 令 API 改動看似沒有生效。

其他常用指令：

```bash
npm run build          # 重建 Portal／Unified GAS 及 units metadata
npm run lint           # JS、JSON、HTML 引用、action allowlist、部署清單、版號
npm test               # 完整測試
npm run check          # build + lint + 完整測試
npm run test:access    # 支部 schema／單調權限規則
npm run test:gas       # Portal GAS
npm run test:unified   # Unified GAS
```

## Portal 登記既有 BADGE 後端

完整狀態與 Admin 步驟見 [`docs/BACKEND_SYNC.md`](docs/BACKEND_SYNC.md) 及 [`docs/ADMIN_ONBOARDING.md`](docs/ADMIN_ONBOARDING.md)。基本原則：

1. 團方提供目前 BADGE 正式 Apps Script `/exec` 與同一 deployment API Key。
2. 不為 Portal 建立另一張 Google Sheet／GAS，不建立第二身份／帳戶表，不要求搬移或複製資料。
3. Admin 先核對正式共用登入／開戶／權限 action contract，並完成真 Apps Script staging。
4. 只有相容性驗收完成後，才把既有 URL／Key 登記到 Vercel Registry 並 Redeploy。
5. `/api/units` 的 `backendReady` 僅代表 URL／Key 設定存在，不代表上游 action 已支援。

常用環境變數：

```text
TROOP_<ID>_NAME
TROOP_<ID>_BACKEND
TROOP_<ID>_APIKEY
SUPER_KEY
PUBLIC_APP_ORIGIN
```

`data/units.json`／`data/units.generated.json` 只可保存公開 metadata，不可保存 API Key 或其他秘密。

> 本工作分支沒有自動部署。修改 repository artifact 不會改動現有 production deployment；部署必須另行明確執行。

## 資料與寫入安全

- 行政讀寫先由同一支部 GAS 以 opaque session 對回 actor。
- `show` 只影響導覽；`read`／`edit` 由前端及後端分別檢查。
- 未登記 top-level 欄位 fail closed 到系統模組。
- `schema`、`kind`、`unitCode`、受保護 metadata、密碼及身份綁定不可由一般整庫 payload 改寫。
- 操作 ID 與 operation journal 防止 timeout 後盲目重送造成重複寫入；結果不明時只可查狀態。
- 本機 URL 的支部別名會先 canonicalize（例如 `82` → `0082`），不會分裂成兩套資料庫。
- 只有頂部明確「儲存到後端」會提交行政改動；本機 pending 與後端 readback 會保留真實狀態。

## 內容可見範圍

內容最低可見級別是已登入 `member`。舊資料會安全遷移：

- `vis: "other"` 收窄為 `member`；
- `db.publicProfile` 被移除；
- 舊匿名 actions `notices`、`constitution`、`noticeSignup`、`claim`、`loan` 不在 Edge allowlist，GAS 亦不提供匿名處理。

未來如需跨支部分享，必須是三個獨立 gate：

1. 來源支部批准整個資料包；
2. 接收支部明確接受；
3. 接收支部再授權自己的本地身份。

任何一步都不能由匿名網址、單一 token 或來源支部角色代替。

## 重要文件

- [`SCOPE.md`](SCOPE.md)：系統樹、責任及禁止路徑
- [`DEPLOY_GUIDE_FOR_TROOPS.md`](DEPLOY_GUIDE_FOR_TROOPS.md)：支部部署與更新
- [`docs/UNIFIED_ARCHITECTURE_TEST.md`](docs/UNIFIED_ARCHITECTURE_TEST.md)：Unified 組合及隔離測試
- [`docs/UPDATES_2026-09-24.md`](docs/UPDATES_2026-09-24.md)：匿名模型退役及目前 authenticated contract
- [`CHANGELOG.md`](CHANGELOG.md)：歷史變更

`docs/UPDATES_*` 的舊日期文件是歷史紀錄，可能描述已退役流程；若與本 README、`SCOPE.md` 或 2026-09-24 authenticated contract 衝突，以目前程式及上述現行文件為準。

## 授權

版權保留；repository 未提供開源授權。
