# SCOPE — 深資童軍管理系統（vs_portal）做乜／唔做乜

> **一句定位**：深資童軍團嘅**支部管理系統** —— 會議、財務、用戶、物資、團章、通告、進度，
> 一個旅團一支 Apps Script `/exec` ＋ 一張 Google Sheet，可以獨立運作。
>
> **本 repo 嘅特殊地位（2026-11-12 用戶定案）**：呢個係**第一個支部系統**，
> 亦係其他支部系統嘅**參考版本／模版**。所以呢度嘅邊界、初始化保全做法、
> 治理規格要比一般 app 更嚴 —— 人哋會照抄。
>
> 規範來源：[`playerkousas-rgb/readme`](https://github.com/playerkousas-rgb/readme)（真理倉）。
> 通用底線 = PLAYBOOK S／F／A／W／V ＋ 技術棧契約；旅團組織階梯屬**專案案例**（docs/19），唔係通用規則。

## 0. 由下而上施工次序（2026-11-12 用戶更正）

```text
第 1 階段：4 本 BOOK 齊
第 2 階段：4 套 BADGE 齊
第 3 階段：5 個支部系統逐個完成  ← 現在；vs_portal 是第一個／模版
第 4 階段：最後才建立旅系統，由旅系統單向讀取各支部後端
```

**現在沒有中央旅系統。** 所以現階段支部 `Users`、本地密碼及支部 session 就是正常日常登入，
不是「後備／救援登入」；`ALLOW_LOCAL_LOGIN` 必須保持 `true`。repo 內任何尚未啟用的 assertion／exchange
實驗都不是現階段部署前置條件，更不是 Progress 契約。

第 4 階段開始後，由旅系統端建立支部 reader，驗收 action allowlist、最小資料投影、server-side
驗證及跨支部隔離；支部 Progress 不新增設定、狀態查詢或控制。不可倒轉將尚未建立的旅系統
當成現階段支部部署阻擋項。

---

## 1. 系統樹同連結邊界（★ 最重要，抄模版之前先睇呢段）

整個生態系按以下單向資料責任組成：

```text
未來旅系統 ──讀取──▶ 各支部系統後端（5 個；彼此完全隔離）

支部 browser
  ├─ 行政功能
  └─ Progress 內部功能 ──同源 server proxy──▶ 本支部 Unified /exec ──▶ 本支部 Sheet
BADGE 前端 ────────────────────────────────────┘

BOOK ──讀取──▶ BADGE
```

Progress 是支部系統內部功能，不是一個要由支部建立、查詢或控制的跨系統關係。行政、
Progress 與 BADGE 只是以不同 action 使用同一支部 Unified backend 的 client；同一 Sheet
不同分頁不構成額外連結。

### 1.1 允許嘅資料路徑

| 路徑 | 允許 | 說明 |
|---|:--:|---|
| 未來旅系統 → 讀取支部系統後端 | ✅ | reader 由旅系統負責；支部前端不保存旅系統設定 |
| BOOK → 讀取 BADGE | ✅ | 已定的單向跨系統模式 |
| 行政／Progress／BADGE → 本支部 Unified backend | ✅ | 同一後端的業務 action，不是三個系統互接 |
| 支部系統獨立運作 | ✅ | 現階段設計前提；未有旅系統不阻擋部署 |

### 1.2 禁止嘅資料路徑（❌ 一律唔准）

| 禁止 | 原因 |
|---|---|
| **支部 ↔ 支部**（例：VS ↔ ROVER 直接連） | 跨支部只能由未來旅系統分別讀取後聚合 |
| 支部主動寫入／控制旅系統 | 正確方向是旅系統讀支部後端，不可倒轉 |
| Progress 主動 request BADGE、旅系統或另一支部 | Progress 只執行本支部業務 action |
| Progress 查詢／控制本地或上游登入閘門 | 登入入口不是 Progress 業務資料 |
| 為 Progress 建第二 backend、Key、secret 或健康狀態 | 同一 Unified Sheet 已是唯一資料來源 |
| 外部系統取得 browser session／完整 DB | 零特權（EXTERNAL） |

### 1.3 ★ 用戶澄清（2026-11-12）—— 「睇落連埋」唔等於「連上」

用戶原話：

> 「其實佢地所謂既連係因為有旅係同接通兩者，再係旅係統表現出來的，所以嚴格來說不算連上」

**正確理解**：即使 VS 同 ROVER 同時掛喺同一個旅系統下面，
佢哋**之間依然冇任何 direct link**。所謂「一齊見到」，其實係：

```
       旅系統（唯一嘅交匯點）
        ↓讀取        ↓讀取
   VS 支部後端    ROVER 支部後端  ← 兩條獨立嘅 server-side reader 路徑
   （彼此之間冇線，互相唔知對方存在，亦唔會直接請求對方）
```

旅系統**分別**讀兩邊，再喺**旅系統自己嘅畫面**聚合呈現。
所以係**星形（旅為中心）**，唔係網狀；跨支部嘅一切都在旅層發生。

**落地含義**（寫 code 之前對住呢三條）：
1. 支部系統唔准有任何「另一個支部嘅 backend URL／key」嘅設定槽或 env。
2. 支部系統唔准主動 request 另一個支部嘅 `/exec`。
3. 要跨支部聚合？嗰個功能屬**旅系統**，唔屬呢個 repo。

守護測試：`tests/boundary.mjs`（靜態守門，唔准出現橫向連結）。

---

## 2. 做乜（IN SCOPE）

- **支部管理**：會議／點名、行事曆、請假、財務（雙財政年度＋團費）、用戶名冊與權限、
  物資借用、團章、通告與報名、獎章進度、自訂欄位、總表同步。
- **身份**：個人帳號（團長／領袖／執委／團員），團長每團一位、只可轉移。
  成員身份錨點 = **本團支部 Sheet 名冊**。
- **團員自助入口**（`members.html`）：睇通告、RSVP、請假、睇進度＋申報完成。
- **公開頁**：團章／通告／收支申報／物資借用，按可見權限過濾。
- **多旅團**：`data/units.json` 公開 metadata ＋ Vercel env 放 secret；旅團之間資料隔離。
- **後端**：`Code.gs` 由 `assets/js/lib/gastemplate.js` 生成（單一來源）；
  `initializeSheets()` **可重跑、只補結構、絕不改寫用戶資料**（見 §4）。
- **作為模版**：治理檔、邊界定義、初始化保全做法要寫清楚，畀其他支部系統照抄。

## 3. 唔做乜（OUT OF SCOPE — 明確拒絕，唔好「順手加」）

| 唔做 | 原因／出處 |
|---|---|
| 跨支部直連（§1.2） | 用戶定案；跨支部只喺旅層發生 |
| 旅層聚合功能（跨團報表／全旅開關） | 屬旅系統，唔屬支部 repo |
| 在 Progress 加旅系統／BADGE URL、Key、狀態或入口控制 | Progress 是支部內部業務功能，唔管理跨系統關係 |
| 外部 reader 自己開支部成員戶口／反寫支部 | 身份錨點單一 |
| MOCK／示範資料 | 2026-09-24 團長已明確拆除 |
| 登入閘嘅診斷／修復／搶救掣 | 2026-09-26 團長已明確清走 |
| 管理改動自動寫入後端 | 2026-09-24 團長否決；只留頂部「儲存到後端」 |
| 小隊計分板、自助簽到 | 團長明確唔做 |
| 引入 Supabase／Gemini／前端框架 | 現有零依賴路線；冇需求唔搬棧 |

## 4. 初始化資料保全（★ 學 BADGE，抄模版嘅重點）

每次更新 `Code.gs` 之後都可以安心行一次 `initializeSheets()`：

- **只補**缺失分頁、缺失欄位、缺失設定預設值。
- **絕不**改寫／刪除／重排／重新編號任何現有用戶資料。
- **絕不**更換現有 `API_KEY`。
- **idempotent**：連跑兩次，第二次零改動。
- 完成後寫 `INITIALIZED_VERSION` 標記；`status` 回報
  「GS 已更新但未初始化」vs「已初始化且版本相符」。
- 守護測試：`tests/init-preserve.mjs`（前後逐表快照對比）。

## 4b. 唔准積死碼（★ 2026-11-12 加，抄模版嘅分支一樣守）

用戶定案：**「襯未真正有人用之前先把 GS 內多餘的代碼刪掉，不然會越來越腫」**。

### 規則
1. **後端加 action = 要同時有前端呼叫者**。加咗 handler＋白名單但前端冇接
   → `scripts/lint.mjs` ⑦ **紅燈**。唔准「留返日後可能有用」。
2. 真係要保留冇前端呼叫者嘅 action（探活／人手逃生門），要喺
   `INTENTIONAL_NO_CALLER` **登記＋寫低原因**；登記冊有過期檢查。
3. **拆 UI 嗰陣要一併拆後端函數**（或者即刻登記做人手逃生門）。
   2026-09-26 拆掣只拆前端，結果留咗 8 個前端屍體函數 ＋ 6 個孤兒 action
   ＋ `diag` 鏈，到 2026-11-12 先清（`Code.gs` −256 行、`remote.js` −652 行）。
4. **刪測試唔等於綠燈**。如果測試用某函數做「驗證手段」去測其他真實行為，
   要改用生還路徑重建同等覆蓋，唔可以就咁刪斷言。

### 唔准當死碼刪嘅嘢（零呼叫者 ≠ 死）
| 類別 | 例子 | 原因 |
|---|---|---|
| 平台入口 | `onOpen`／`doGet`／`doPost` | GAS 平台呼叫，唔會有 code 引用 |
| 人手入口 | `initializeSheets`／`showApiKey`／`issueSetupKey` | 部署指南叫人喺編輯器執行 |
| 人手搶救 | `repairDb`／`saveDbForce`／`cleanStaleStaging`／`pruneOldDbVersions` | 部署指南嘅救機步驟 |
| 舊資料 fallback | `saveDb`／`dbRawText`／`loadDbPart`（blob 路） | `dbReadRaw` 會 fallback；`0082` 已登記，刪咗讀唔返現有資料 |
| 後端自證 | `syncCheck`／`checkSheetWriteRead` | 寫入＋讀回證明；`saveTables` 內部亦用 |

**落刀之前**：剝走註解／字串再數真實呼叫點（naive grep 會數埋註解同文檔，害你誤刪）。

## 5. 已知豁免／偏離（如實登記，唔靜靜過）

| ID | 事項 | 原因 | 補償 |
|---|---|---|---|
| `EXCEPTION: LICENSE` | 唔加 LICENSE 檔 | 2026-11-12 用戶選擇「私人／版權保留」 | `repo_health` 嘅 license WARN 屬已知；版權聲明寫入 README |
| `EXCEPTION: S3/S4` | `vercel.json` 用 `outputDirectory: "."`、`installCommand: npm ci --omit=dev` | 本站係根目錄純靜態、零 build、零 runtime deps（`buildCommand` 只跑 `build-units.mjs`，唔需要 devDeps） | `.vercelignore` 係唯一部署閘，`npm run lint` 會印實際部署清單並擋住排除運行時檔 |
| `EXCEPTION: L1` | 未做中英一鍵切換 | 本 repo 屬 2026-11-08 雙語定案**之前**已存在嘅 app，規則明寫「現有 repo 一律唔追溯」 | 團章／通告本身已支援中英對照內容 |
