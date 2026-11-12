# CHANGELOG

版號唯一來源：`assets/js/lib/version.js`（`APP_VERSION`）＋
`assets/js/lib/gastemplate.js`（`BACKEND_VERSION`）—— 兩者必須一致（V1／F15）。

---

## v2.8.5 — 2026-11-12

**按真理倉 README 對齊 ＋ 初始化資料保全（本 repo 係其他支部系統嘅參考模版）**

### 修復
- **測試時間炸彈（root cause）**：`tests/public.mjs` 嘅 fixture
  `tests/fixtures/units/TEST9/notices.json` 寫死 `deadline: 2026-09-28`。
  今日已過該日 → 公開頁判「已截止」→ 唔渲染報名表 → `form` 為 `null` →
  suite 中途 crash（`TypeError: Cannot read properties of null`）。
  **後果：`npm test` 實際 exit 1，而且後面 19 個 suite 從來冇跑過。**
  改法：讀 fixture 時將可報名通告嘅 `deadline`／`eventDate` 平移去相對今日嘅未來
  （滾動日期），產品邏輯零改動。修復後全套 **exit 0 / 0 失敗**。

### 新增
- `initializeSheets()` **可重跑而唔破壞用戶資料**（學 vsbadge `ensureUserColumns`）：
  補缺失分頁 ＋ **補缺失欄位**（舊 Sheet 而家升得到新欄）、只補缺失設定預設值、
  現有資料零改寫、`API_KEY` 不變、idempotent。
- `INITIALIZED_VERSION` ScriptProperties 標記 ＋ `status` 回報
  `initializedVersion` / `initializationCurrent`（「已更新 GS 但未初始化」三態）。
- `tests/init-preserve.mjs`：初始化前後逐表快照對比 ＋ idempotent ＋ API Key 不變。
- `tests/boundary.mjs`：系統樹邊界守門（禁止跨支部直連）。
- 治理檔：`SCOPE.md`（含系統樹星形邊界）、`AGENTS.md`、`GLOSSARY.md`、
  `CONTRIBUTING.md`、本檔、`.env.example`。
- 由真理倉抄入 `scripts/`：`guard.mjs`、`final_check_v1.0.mjs`、
  `repo_health_v1.0.mjs`、`preflight_v1.0.mjs`、`check_skills_v1.0.mjs`。

### 對齊修正
- `.vercelignore`：目錄條目改帶斜線（S2）；實際部署清單不變（80 檔）。
- `.gitignore`：加 `!.env.example` 例外（原本被 `.env.*` 擋走，令範本檔入唔到 Git）。
- F15：35 處歷史註解由 `// vX.Y` 改寫成「自 vX.Y 起…」敘述式
  （**保留全部版號同歷史事實**，只改表達方式）。
- **版號真正單一來源**：Code.gs 檔頭 以前獨立寫死 `v2.8.4`，
  升 `BACKEND_VERSION` 就會漏改（升 v2.8.5 嗰陣實際紅咗）。而家兩者都由
  `version.js` 嘅 `APP_VERSION` 推導；並補上 `scripts/lint.mjs` §⑥
  真正嘅一致性閘門（`version.js` 註解一直聲稱 lint 會擋，但其實冇呢個檢查）。
- `tests/gas.mjs` / `tests/simplewrite.mjs`：版號斷言改為由 `version.js` 推導，
  唔再寫死某個舊版號（語義不變：驗三邊一致，而唔係等於某字串）。
- `.github/workflows/guard.yml`：Actions 釘 40-hex SHA（A16）；
  按 PREFLIGHT.md 建議只用 `pull_request` + 每週 cron + 手動，唔用 `push:['**']`。
- `DEPLOY_GUIDE_FOR_TROOPS.md`：更新指示改為「**每次更新 Code.gs 都跑一次
  `initializeSheets()`**」（舊文寫「唔使再跑」，因為舊版唔會補欄）。

### 實測結果（2026-11-12）
- `npm run lint` → **18 通過 / 0 失敗**（新增 4 項版號閘門）
- `npm test` → **exit 0**，25 個 suite 全部跑完、**0 失敗**
  （新增 `init-preserve` 43／`boundary` 24；`gas` 263／`remote` 289／`simplewrite` 70）
- `node scripts/guard.mjs` → **GUARD PASS 17 項全綠**（對齊前係 12 FAIL）
- `node scripts/repo_health_v1.0.mjs .` → **PASS 8 / WARN 2 / FAIL 0**
  （2 個 WARN 都係 LICENSE，屬用戶定案嘅已知豁免）
- `npm run build:gas` 兩次 sha256 一致（生成檔冪等）
- **未真機驗證**：GAS 302 轉址／Drive 權限／ScriptProperties 配額／`onOpen` 授權
  仍未喺真實 Google 部署跑過（本地 VM 模擬器唔等於真機）。

### 已知豁免
- `EXCEPTION: LICENSE` — 用戶選擇版權保留，唔加 LICENSE 檔。
- `EXCEPTION: S3/S4` — 根目錄純靜態、零 build、零 runtime deps。
- `EXCEPTION: L1` — 雙語規則明寫唔追溯現有 repo。

---

## v2.8.4 及之前

歷史紀錄見 `README.md` 頂部同 `docs/UPDATES_*.md`（逐日詳細記錄）。
