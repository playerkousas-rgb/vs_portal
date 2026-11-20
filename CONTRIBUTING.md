# CONTRIBUTING — 點樣改呢個 repo

> 本 repo 係**其他支部系統嘅參考模版**。改動要經得起人抄。

## 1. 開工前

1. 讀 [`AGENTS.md`](AGENTS.md)（開工順序）＋ [`SCOPE.md`](SCOPE.md)（邊界／唔做清單）。
2. 確認你嘅改動冇跨越 `SCOPE.md` §1.2 嘅禁止連結（尤其係跨支部直連）。
3. 新增模組／改邊界／推翻產品定案 → **先問用戶**，唔准自己揀 default。

## 2. 分支同 PR

- 唔好直接改 `main`；用 feature branch → PR。
- Commit 用 Conventional Commits：`feat:` / `fix:` / `docs:` / `test:` / `perf:` / `chore:`。
- PR 描述要寫：
  - 改咗乜、點解
  - **身份錨點有冇改** / **registry 有冇加** / **key 有冇 rotate**
  - 有冇改 `Code.gs`（要唔要重新部署 ＋ 行 `initializeSheets()`）
  - 實測結果（貼真實數字，唔好寫「應該得」）
  - 有豁免就寫 `EXCEPTION: <ID> — 原因 — 補償`

## 3. 交付前閘門（全部要綠）

```bash
npm install
npm run lint
npm run build:gas
npm test
node scripts/guard.mjs
node scripts/repo_health_v1.0.mjs .
```

任何 FAIL = 唔准 merge。WARN 要如實寫入 PR。

## 4. 共用後端及 BADGE 同步

- 目標架構：Portal 使用旅團現有 BADGE GAS、Sheet、Users 及資料。正式 Portal contract 尚待實作及真實 staging，不得宣稱已共用或新建第二後端。
- 本 repo 隔離測試用 Portal 後端來源是 `assets/js/lib/gastemplate.js`；`apps-script/Code.gs` 由 `npm run build:gas` 生成，禁止直接手改生成檔。
- BADGE 每次維護要以 upstream commit 為基準逐項比對，將適用的行為／修正移植到共用後端，再同步 API action、前端契約及回歸測試；不得只複製整份 BADGE GS，也不得只更新測試用副本而聲稱共用後端已同步。
- `apps-script/UnifiedCode.gs` 和 `apps-script/unified-src/` 目前是 `isolated-test-only` 的歷史整合測試產物，不是正式共用後端來源或部署目標。不可把它當成 Portal 必須增長至 8,000 多行的設計要求。
- 每次後端變更跑 `npm run build:gas`、`npm run lint`、相關測試及 `git diff --check`；action 必須同時更新相應代理 allowlist 和伺服器端授權測試。
- 目前 upstream BADGE 維護基準：`playerkousas-rgb/vsbadge@87c76a98b95ff7b5e2a7be02198142c72aefc24e`（2026-11-20 PR #40）。逐項移植狀態見 `docs/BACKEND_SYNC.md`。

## 5. 寫測試

- 新增行為要有測試守（F14：文件每一句「一定要」都有測試）。
- **fixture 唔准寫死日期** —— 用相對今日嘅滾動日期（見 `AGENTS.md` §6）。
- 唔好為咗綠燈而放寬斷言；要改斷言就要解釋點解原本嘅期望係錯。

## 6. 唔好做

- 唔好 commit secret／`.env.local`／真實團員資料。
- 唔好加返 MOCK、登入閘診斷掣、自動寫入（已被用戶明確否決）。
- 唔好引入 runtime dependency（現有零依賴；jsdom 只係 devDependency）。
- 唔好直接改 `apps-script/Code.gs`（生成檔）。

## 7. 授權

本 repo **版權保留**，未提供開源授權（2026-11-12 用戶定案）。
即係預設「All rights reserved」—— 未得書面同意唔可以複製／再發佈。
參考模版嘅做法可以喺同一帳戶嘅姊妹 repo 內部沿用。
