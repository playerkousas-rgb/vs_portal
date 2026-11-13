# AGENTS — Agent 開工順序同施工邊界（vs_portal）

> **本 repo = 第一個支部系統，亦係其他支部系統嘅參考模版。**
> 你改嘅嘢人哋會照抄，所以邊界同保全規則要比一般 app 更嚴。

## 0. Boot（任何 Agent 第一步，順序唔可以調轉）

1. 讀 [`SCOPE.md`](SCOPE.md) —— 特別係 **§1 系統樹邊界** 同 **§3 唔做清單**。
2. 讀真理倉 [`readme/README.md`](https://github.com/playerkousas-rgb/readme/blob/main/README.md)
   ＋ [`PLAYBOOK.md`](https://github.com/playerkousas-rgb/readme/blob/main/PLAYBOOK.md)（通用規則 ID）。
   旅團組織階梯屬**專案案例**（readme/docs/19），唔係通用底線。
3. 讀本檔 §2–§4；改後端必讀 §4。
4. 開工前跑閘門（見 §5），`ok: true` 先好郁手。

> **改現有功能唔使行開新 repo 嘅 INTAKE**（真理倉明寫）；只需要問清楚「想改乜」。
> 但**新增模組／改邊界**就要先問用戶，唔准自己揀 default。

## 1. 我係邊個級（施工前自問）

本 repo = **BRANCH（支部）**。

| 可以做 | 唔准做（越級） |
|---|---|
| 改本團 Sheet 嘅資料結構／讀寫邏輯 | 改其他支部嘅 Sheet／backend |
| 改本 repo 前端、`/api`、`Code.gs` 範本 | 冒充 ADMIN 改平台 `units.json` 以外單位嘅登記／Vercel env |
| 做本團嘅通告／財務／物資／Progress 內部功能 | 在 Progress 加 BADGE／旅系統 URL、Key、狀態或登入控制 |
| 經同源 proxy 以業務 action 讀寫**自己嘅** Unified Sheet | 主動連另一個支部／旅系統；倒轉未來「旅讀支部」方向 |

**跨支部聚合 = 旅系統嘅工作，唔係呢個 repo。**（`SCOPE.md` §1.3：星形，唔係網狀）

## 2. 身份同資料單一來源

- 成員身份錨點 = **本團支部 Sheet 名冊**（`members`）。Progress 只按 YMIS 使用同一名冊；搵唔到人 = 本團未開戶，唔會自己補。
- 旅團編號正規化只得一個實現（`82`/`082`/`0082` 同一團）—— `api/_registry.js`。
- Secret 只住 Vercel env / GAS ScriptProperties；**永遠**唔入 Git／前端／URL／QR／Sheet 儲存格。
- 前端唔揸 service key；經同源 `/api/proxy` 注入。新增 action 一定要入白名單（`npm run lint` 會擋）。

## 3. 產品定案（唔准推翻，除非用戶明確改口）

| 定案 | 內容 |
|---|---|
| 個人帳號 | 冇共用執委／領袖帳戶；團長每團一位、只可轉移 |
| 寫入 | 管理改動先留本機；**只有**頂部「儲存到後端（N）」會寫後端。冇自動寫入 |
| 衝突 | 三方逐格比對；同格唔同值要列出、未寫入、等用戶確認 |
| 收據 | 寫完要 readback 核對；唔確定唔准自動重送（F6-b） |
| 公開資料 | 只讀總覽；真正編輯返所屬模組；按可見權限過濾 |
| 前後端定位 | 每支部 Unified GS 有完整功能；vs_portal 是功能完整版前端，BADGE 是輕量前端。唔准因 BADGE 輕量而拆第二支精簡 GS；授權仍由 server role／scope 決定 |
| BOOK／BADGE | BOOK 可讀正式資料及提交待批匯入；只有領袖確認後先可寫入正式紀錄，唔准直接匯入繞過審批 |
| 已拆除 | MOCK、登入閘診斷／修復／搶救掣 —— 唔准加返 |

## 4. 改 `Code.gs` 嘅鐵律（★ 模版重點）

1. **唯一來源** = `assets/js/lib/gastemplate.js`。
   改完跑 `npm run build:gas` 生成 `apps-script/Code.gs`；**唔好直接改生成檔**。
2. **`initializeSheets()` 必須可重跑而唔破壞資料**（學 vsbadge）：
   - 只補缺失分頁／欄位／設定預設值
   - 現有資料一個字都唔准改；`API_KEY` 唔准換
   - idempotent（連跑兩次，第二次零改動）
   - 完成寫 `INITIALIZED_VERSION`；`status` 要回報初始化狀態
   - 改完一定要跑 `node tests/init-preserve.mjs`（快照對比）
3. 版號：`assets/js/lib/version.js` 嘅 `APP_VERSION` 同 `gastemplate.js` 嘅
   `BACKEND_VERSION` 必須一致（`npm run lint` 會擋）。
4. 歷史註解寫「自 vX.Y 起…」敘述式，**唔好**寫 `// vX.Y`（F15 guard 會擋）。
5. 前端／後端一齊發版；部署拷貝要同步。

## 5. 閘門（ Definition of Done ）

```bash
npm run lint                  # 零依賴靜態檢查（含 action 白名單 / 部署清單）
npm run build:gas             # 由範本生成 Code.gs
npm test                      # 全部 suite（含 init-preserve / boundary）
node scripts/guard.mjs        # 真理倉 S/F/A/W/V 通用防呆
node scripts/repo_health_v1.0.mjs .   # 12 樣起手檔體檢
```

- 任何一項 FAIL = **唔准交付**。
- `WARN` 入 backlog，唔阻塞，但要如實講。
- **本地綠 ≠ 完成**：GAS 302 轉址、Drive 權限、ScriptProperties 配額、`onOpen` 授權
  喺新部署仍然要真機跑一次。冇真機就要寫明「未真機驗證」。

## 6. 測試時間炸彈（2026-11-12 教訓）

fixture **唔准寫死日期**。`tests/fixtures/units/TEST9/notices.json` 原本寫死
`deadline: 2026-09-28`，一過咗日報名表就唔渲染 → `form` null → suite crash →
**後面 19 個 suite 一次都跑唔到，但 npm 表面上好似有跑**。
而家 `tests/public.mjs` 用滾動日期（相對今日）。新增 fixture 要跟同一做法。
