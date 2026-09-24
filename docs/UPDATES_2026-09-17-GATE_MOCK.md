# 2026-09-17 修正：首頁揀唔到 Vercel 登記嘅旅團 ＋ 入咗 MOCK 出唔返

> 團長回報兩件事：
> 1. 「旅團後端／API Key 全部用 Vercel 環境變數登記，但首頁揀唔到自己旅團。」
> 2. 「入咗 MOCK 之後好難離開。」
>
> 兩個都重現到，兩個都係真 bug，而且係**同一個根源** —— 模式（真實／示範）
> 只信 `localStorage`，完全唔理網址。順手補齊診斷工具，令「旅團唔出現」以後自己查得到。
>
> 測試：`npm test` → smoke real **541** · smoke mock **524** · 公開頁 **87** · 旅團閘 **39** ·
> **旅團登記／示範 66（新）** · api **32** · progress **33** · remote **64** · tabs **47** · Code.gs **28**
> ＝ **1,461 通過 / 0 失敗**。

---

## 問題 1：揀極自己旅團都係入 MOCK

### 症狀

去過一次「試用示範（MOCK）」之後，返旅團選擇畫面揀返**自己旅團**（Vercel 環境變數開嘅），
入到去：

* 頂部仍然係黃色「MOCK 示範模式」橫額
* 睇到嘅係假資料（唔係自己 Google Sheet 嘅嘢）
* 改嘢**永遠唔會寫入後端**（見到「只存喺本機」）

### 根本原因

`store.js` 開機時係咁決定模式：

```js
state.mode = opts.mode || lsGet(K.mode) || 'real';
if (url.get('mock') === '1') state.mode = 'mock';
```

`lsGet(K.mode)` 一寫入就**永遠贏** —— 去過 MOCK 之後，`venture82.mode.v2 = 'mock'`，
之後就算網址係 `?u=0081`（真人真旅團、冇 `mock=1`）都照樣當示範模式：

| 應該 | 實際（舊） |
|---|---|
| mode `real`、讀 `venture82.unit.0081.db.v2` | mode `mock`、讀 `venture82.mock.db.v2` |
| 開機同旅團後端對資料 | `syncBoot()` 見到 `isMock()` 即刻 `return` |
| 出登入畫面 | 自動用「示範領袖」身份登入 |

用家嘅感覺就係「我揀咗自己旅團，但入唔到」。

### 改法：網址最權威

`store.js` 新增 `resolveTarget()`，模式／旅團一律照以下次序：

| 次序 | 來源 | 例子 |
|---|---|---|
| 1 | 程式內部指定 | `init({ mode:'mock', unit:'MOCK' })` |
| 2 | 示範 | `?mock=1` **或** `?u=MOCK` |
| 3 | 真實 | `?u=0081`（就算 localStorage 寫住 mode=mock） |
| 4 | 上次記錄 | `venture82.mode.v2` / `venture82.currentUnit.v2` |
| 5 | 預設 | `real` |

* 示範模式嘅旅團編號**一律**係 `MOCK`（唔會再出現「真實模式但編號 MOCK」嘅空殼）。
* 真實模式會寫低「最後一個真實旅團」`venture82.lastRealUnit.v2`（離開示範時用）。
* 由示範切去真旅團（`switchUnit()`／旅團閘）會即時刪走 `mock` 記錄。

---

## 問題 2：入咗 MOCK 出唔返

除咗上面同一個模式 bug，仲有幾個死位：

| 情況 | 舊行為 | 新行為 |
|---|---|---|
| 撳過一次 MOCK，之後**每次**開網站 | 靜靜雞直接入返示範（連旅團閘都唔出） | 示範**唔會**自動記住；普通網址一律返旅團閘 |
| `?u=MOCK`（冇 `mock=1`，例如書籤／分享連結） | 當「真旅團 MOCK」→ 冇橫額、冇離開掣、又報「讀唔到資料檔」 | 直接當示範模式，橫額同離開掣齊全 |
| 手機「更多 → 登出」（示範模式） | `logout()` ＋ 停留喺登入畫面（示範帳戶冇密碼，登入唔返） | 直接「離開示範」返旅團閘 |
| 想去返自己旅團 | 要離開示範 → 閘 → 再揀一次 | 橫額多咗一粒「**返 0081（真實）**」，一撳返去 |
| 離開示範 | 清 mode／unit／已揀記錄 | 連**登入 session** 都清（唔會用示範身份碰真資料） |
| 喺 app 入面搵離開掣 | 只有黃色橫額有 | 橫額＋頂部 bar＋「更多」選單＋「帳號與系統 → 示範資料」都有 |

另外：`resetToGate()`（離開示範）而家會一齊清 session；開機亦會檢查
「真實模式但 session 係示範帳戶」＝即刻清走。

---

## 順手做埋：旅團唔出現，以後自己查得到

團長今次最難查嘅係「我明明加咗 Vercel 環境變數，點解首頁見唔到旅團」。
以前 `/api/units` 一失敗（未 redeploy、變數名打錯、函數 500…），前端就**靜靜雞**
當「冇旅團」，個閘只會寫「暫時未有旅團登記」——完全查唔到原因。而家：

### 1. 旅團閘有狀態列

```
伺服器登記（Vercel 環境變數）：1 個旅團      [重新載入清單] [診斷伺服器登記]
```

讀唔到就變紅色，寫明 `HTTP 500` 之類，並列出三個最常見原因（未 Redeploy／變數名／網絡）。

### 2. 「診斷伺服器登記」彈窗

會顯示：

* 瀏覽器讀 `/api/units` 成唔成功、HTTP 狀態
* 伺服器**認到嘅旅團編號**
* 邊啲旅團有通過白名單嘅 `/exec`、邊啲有 API Key（只有名，**冇值**）
* 執行環境係唔係 Vercel
* **疑似打錯名嘅變數**（例如 `TROOP0082_BACKEND`、`TROOP_0082_BACKENDXD`）

### 3. 清單見唔到都有路入

閘面多咗「**直接輸入旅團編號**」→ 打 `0082` 撳「直接進入」一樣入得去
（照樣行 `?u=0082` 同真實模式），唔會再完全冇路走。

### 4. 環境變數寫法認得多咗

| 以前只認 | 而家都認 |
|---|---|
| `TROOP_0082_BACKEND` | `_BACKENDURL`、`_BACKEND_URL`、`_GASURL`、`_GAS_URL`、`_GAS`、`_EXEC`、`_URL`、`_SCRIPTURL`、`_WEBAPP_URL` |
| `TROOP_0082_APIKEY` | `_API_KEY`、`_KEY`、`_TOKEN`、`_APITOKEN`、`_SECRET` |
| `TROOP_0082_NAME` | `_TROOPNAME`、`_DISPLAYNAME`、`_NAMEEN`、`_EN` |
| — | `TROOP_0082`（簡寫：值直接放 `/exec`，值一定要合法） |
| — | `TROOPS_JSON`／`TROOP_REGISTRY`（一次過用 JSON 登記） |

（唔合法嘅 `_BACKEND`（例如 `http://evil.com/exec`）一樣會被擋：旅團會出現，
但標明「後端未設定／URL 未通過驗證」，proxy 亦一定唔會轉發。）

---

## 你而家要留意嘅（3 步）

1. **Redeploy 一次**（有改 `api/` 就要）。
2. 開首頁 —— 應該見到「伺服器登記（Vercel 環境變數）：N 個旅團」。
   * 見到自己旅團 → 撳入去，應該係**正常登入畫面**（唔會再係 MOCK）。
   * 見唔到 → 撳「診斷伺服器登記」，佢會直接話你知邊個變數名認唔到。
3. 如果之前卡咗喺 MOCK：撳「離開示範」，或者直接用新嘅「返 0082（真實）」掣。

---

## 改咗啲咩檔

| 檔案 | 改動 |
|---|---|
| `assets/js/lib/store.js` | `resolveTarget()`（網址最權威）、`lastRealUnit()`、`exitMockToUnit()`、`enterMock()` 帶 `u=MOCK`、`switchUnit()` 同步模式、`resetToGate()` 清 session |
| `assets/js/lib/units.js` | `serverUnitsStatus()`、`fetchRegistryDiag()`、失敗重試同狀態記錄、只有 API 有旅團時嘅 fallback |
| `assets/js/main.js` | 旅團閘狀態列＋「重新載入／診斷／直接輸入編號」、`gotoUnit()`、`openRegistryDiag()`、示範登入橫額、頂部「離開示範」、`unitChosen()` 唔會再鎖死喺唔存在嘅旅團 |
| `api/_registry.js` | 變數名 aliases、`TROOP_82` 簡寫、`TROOPS_JSON`、`registryDiagnostics()` |
| `api/units.js` | `GET /api/units?diag=1` |
| `dev-server.mjs` | 改 `api/*.js` 之後即時生效（唔使重啟；以前 Node module cache 會照跑舊 code） |
| `tests/gate-env.mjs` | **新** 66 個測試（真 handler ＋ 真 jsdom，重現兩個回報） |
| `package.json` | `npm test` 加入新測試；加 `npm run test:gate-env` |

### 測試點樣證明

`tests/gate-env.mjs` 唔係 mock function call：

* 用**真** `api/units.js` handler ＋ 真 `process.env.TROOP_0081_*`
* 用真 jsdom 開 `index.html`，行真 `main.js`，驗閘面內容同轉頁方向
* 驗「MOCK → 揀真旅團」一定要變返 `real`（就係團長撞到嗰個情況）
* 驗「`?u=MOCK` 冇 `mock=1`」唔會變空殼
* 驗離開示範清晒 mode／unit／已揀記錄／session
* 驗診斷唔會洩漏 API Key 值
