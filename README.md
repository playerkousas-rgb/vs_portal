# 深資童軍管理系統

深資童軍支部管理平台：會議、行事曆、財務、用戶與身份、物資、通告、團章、進度及資料同步。Runtime 使用原生 HTML／CSS／JavaScript ES Modules；每個支部使用自己的 Google Sheet 與 Apps Script 後端。

> [!IMPORTANT]
> **所有支部內容只限已登入的本地身份。** 系統沒有匿名通告、匿名團章、匿名申報、匿名借用或 `publicProfile`。
>
> `notice.html`、`constitution.html`、`entry.html`、`borrow.html` 只保留舊網址兼容，會轉到 `members.html` 登入流程；它們不會匿名讀取或寫入資料。

## 目前系統邊界

```text
支部行政前端（index.html） ─┐
已登入團員入口（members.html）├─ 同源 API ─▶ 本支部 Apps Script ─▶ 本支部 Sheet
BADGE 輕量前端 ──────────────┘

未來旅系統 ──獨立、只讀、最小投影──▶ 各支部後端
```

每個支部使用**同一支完整 Unified GAS**。**支部系統前端是功能完整版**，包含行政及 Progress；**BADGE 是輕量前端**，只呈現其工作流程，不代表另有一支精簡後端。前端有沒有顯示某功能不是安全邊界；每個 action 仍由後端按 **session、role 及 scope** 與本支部 grant 驗證。

- 支部本地帳戶與 opaque session 是正常登入來源，不是後備入口。
- 瀏覽器不會把 API Key 當身份；敏感資料由後端按已驗 session 重新授權。
- 支部之間不可直接連線、不可保存另一支部的 URL／Key，也不可互相讀寫。
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

純資料正規化及遷移在 [`assets/js/lib/access-schema.js`](assets/js/lib/access-schema.js)，前端 runtime gate 在 [`assets/js/lib/access.js`](assets/js/lib/access.js)。Portal GAS 與 Unified GAS 會使用同樣的支部角色層級、模組 grant 及細項 ACL 重新驗證。

### 身份資料保密

行政資料投影只回傳：

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

## 後端與生成檔

| 路徑 | 用途 |
|---|---|
| `assets/js/lib/gastemplate.js` | Portal GAS 單一來源 |
| `apps-script/Code.gs` | 由 `gastemplate.js` 生成的 Portal artifact |
| `apps-script/unified-src/` | Unified baseline、Portal compatibility checkpoint、extension 及 manifest |
| `apps-script/UnifiedCode.gs` | 生成的完整 Unified artifact |
| `assets/js/lib/unifiedtemplate.generated.js` | App 下載用、與 Unified artifact byte-for-byte 一致 |

不要直接修改生成檔。修改來源後執行：

```bash
npm run build
```

Unified builder 會核對 vendored baseline 及 Portal compatibility checkpoint 的 SHA-256，防止來源靜默漂移。

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

## 支部部署設定

完整步驟見 [`DEPLOY_GUIDE_FOR_TROOPS.md`](DEPLOY_GUIDE_FOR_TROOPS.md)。基本原則：

1. 每個支部建立自己的 Google Sheet／Apps Script deployment。
2. 貼上經 builder 生成及測試的 artifact。
3. 執行 `initializeSheets()`；它只補缺失結構、保留現有資料與 API Key，並可重複執行。
4. 重新部署 `/exec`。
5. 在 server 環境登記支部 metadata；秘密只放 server 環境，不放 browser 或 `data/units.json`。

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
