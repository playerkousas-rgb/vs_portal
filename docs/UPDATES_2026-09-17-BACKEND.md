# 2026-09-17 修正：資料寫入後端 ＋ 旅團隔離

> 團長回報兩個嚴重問題，兩個都證實係真，兩個都修好咗。
>
> 測試：`npm test` → smoke real **578 / 0** · smoke mock **539 / 0** · public **87 / 0** ·
> gate **29 / 0** · api **29 / 0** · progress **33 / 0** · **remote 44 / 0**（新）。
> 合計 **1,339 通過 / 0 失敗**。

---

## 問題 1：資料只存喺瀏覽器，寫唔入後端

### 症狀

改咗嘅嘢（團員、帳目、通告…）淨係喺自己部機。換手機、換瀏覽器、清 cache ＝ **資料冇晒**。

### 根本原因（三個，環環相扣）

**① `store.js` 嘅 `persist()` 由頭到尾冇 network call**

```js
function persist() {
  lsSet(dbKey(state.mode, state.unitCode), JSON.stringify(state.db));  // 就咁一句
  if (state.db.sync && state.db.sync.auto) {
    state.db.sync.pending = Number(state.db.sync.pending || 0) + 1;    // 得個數字，冇送出
  }
}
```

個 `auto` 掣（介面寫住「改動後排隊等同步」）**只係加一個計數器**，永遠唔會自己送去後端。

**② 「立即同步」係單程、而且有損**

`pushToMaster()` 送嘅係 `buildPayload()` —— 把每個表**攤平**成 Sheet 行：

```js
if (Array.isArray(o.photos)) { o.photos = o.photos.length; }   // 相片 → 淨係剩個數字
```

巢狀欄位（`title.zh`）變咗文字、相片變咗數量。攤平咗就**砌唔返**個資料庫，
所以 `Code.gs` 根本冇寫過對應嘅「讀返」功能 —— 舊版得 `?action=load`，
而嗰個只係讀**進度**嗰 6 個分頁，唔關 app 資料事。

**③ 冇任何讀返嘅路**

即係話：就算你日日撳「立即同步」，換部機一開 app，
`init()` 見 localStorage 空白 → 由 `data/units/0082/*.json` 重新種子 →
你打咗幾個月嘅帳目**一筆都唔會返嚟**。

### 改法

**後端（`Code.gs` v2.1.0）新增「資料庫」分頁 ＋ 三個 action**

| action | 做咩 | 備註 |
|---|---|---|
| `saveDb` | 把**整個資料庫**原樣 JSON 寫入「資料庫」分頁 | 每格上限 50000 字元，所以 45000 一段分段存 |
| `loadDb` | 把所有段拼返，回傳完整資料庫 | 換機／清 cache 之後靠佢攞返資料 |
| `dbInfo` | 只回 meta（幾時更新、幾多筆） | 開機比對用，唔使成份拉落嚟 |

* 寫入用 `LockService` 包住 —— 兩個執委同時改都唔會爛。
* 寫入前會刪走該旅團舊段，唔會殘留。
* 要 API Key 先寫得（唔係人人改得你張表）。
* 其餘分頁（帳目／團員／物資…）**照舊**攤平寫入，畀你自己睇同用公式 —— 佢哋而家係「報表」。

**前端新增 `assets/js/lib/remote.js`**

```
改動 → store.persist() → saveHook → scheduleSave()（debounce 2.5 秒）
     → pushDb() → POST /api/proxy { action:'saveDb', db }
     → 失敗自動重試（4s → 15s → 60s）；離線就等返到線
```

開機（`main.js` → `syncBoot()`）：

```
dbInfo → 後端比本機新（或者本機空白）→ loadDb → store.adoptRemote()
```

**防迴圈**：`adoptRemote()` 同 `commitMeta()` 只寫本機、唔會再觸發上傳。
（開發途中真係中過呢個伏 —— `pushDb` 成功後用 `commit()` 記錄，
`commit()` 又 `pending++` 又觸發 hook，變成無限存。所以簿記一定要行 `commitMeta()`。）

**介面**

* 頂部多咗個**儲存狀態提示**：`已存到後端` / `未儲存` / `儲存緊…` / `離線` / `儲存失敗` /
  **`只存喺本機`**（未設定後端時嘅警告，撳一下直接去設定頁）。
* 「總表同步」頁多咗「儲存狀態」卡：最後寫入／讀取時間、未儲存筆數、上次錯誤，
  同三粒掣 —— **立即儲存到後端** / **由後端還原資料** / **睇後端有咩資料**。
* `auto` 預設**開**（`s.auto !== false`），文案改成「改動後自動儲存到後端」。

**順手修好**：`wipe()`（清空本旅團）以前連後端設定都清埋 ——
清完之後 app 就再冇後端，改動又變返淨係存喺瀏覽器。而家會保留連線設定。

---

## 問題 2：新旅團一開會見到 82 旅嘅資料

### 症狀

團長懷疑「新旅團一開就會睇到我嘅旅團資料」。**證實係真**，而且有兩條路。

### 根本原因

**① 共用後端 fallback（最嚴重）**

`data/units.json` 頂層有個共用 `backend.gasUrl`，而佢就係 **0082 自己張 Sheet**：

```js
// assets/js/lib/units.js（舊）
const shared = entry.fromApi ? {} : (reg.backend || {});
const gasUrl = val.gasUrl || shared.gasUrl || '';   // ← 新旅團冇自己嘅 → 攞咗 82 旅嗰條
```

後果：任何**喺 Registry 有 entry 但未交自己 `/exec`** 嘅旅團，
一登入就會讀寫 **82 旅張 Google Sheet** —— 見到你嘅團員同帳目，
佢自己嘅嘢又會寫入你張表。`public-notice.js` 嘅報名提交都有同一條 fallback。

**② 靜態資料檔公開**

`data/units/0082/` 入面嘅 `members.json`（真實姓名 ＋ YMIS）、`finance.reference.json`、
`constitution.json` 全部係 repo 入面嘅公開靜態檔，任何人開個網址就下載到。

### 改法（① 已修）

`backendOf()` 同 `public-notice.js` **完全移除共用 fallback**：
冇自己登記嘅 `/exec` 就係冇（回 `null`），寧願話「未開戶」都唔會借用人哋個後端。

```js
const gasUrl = val.gasUrl || '';
if (!gasUrl) return null;          // ← 唔會再借用其他旅團嘅後端
```

伺服器端（`api/_registry.js` / `api/proxy.js`）本身已經係隔離嘅 —— 實測未登記旅團回 404。

### 仲未做（②）—— 等你落 order

`data/units/0082/` 嘅靜態檔**今次冇郁**（依你指示：先唔好動資料）。
你講明：**先把 82 旅現有資料寫入後端，下次再開新對話叫 agent 全清變空白。**

下次要做嘅嘢，留咗喺下面「下一步」。

---

## 你而家要做嘅兩步

### 第 1 步：更新 Apps Script（**一定要做，唔做之前嘅嘢都唔會生效**）

舊版 `Code.gs` 冇「資料庫」分頁，收到 `saveDb` 會回「未知 action」。

1. 開你張總 Sheet → **擴充功能 → Apps Script**
2. 全選舊 code 刪走，貼上新版
   （app 內「總表同步 → 下載 Code.gs」，或者 repo 嘅 `apps-script/Code.gs`）
3. **儲存** → 函數揀 `initializeSheets` → **▶ 執行**（會建立「資料庫」分頁）
4. **部署 → 管理部署作業 → ✏️ 編輯 → 版本揀「新版本」→ 部署**
   ⚠️ 一定要出**新版本**，否則 `/exec` 仲係行緊舊 code。
   URL 唔會變，`data/units.json` 唔使改。

### 第 2 步：把現有資料推上後端

用**平時嗰部機、嗰個瀏覽器**（＝有齊你資料嗰部）：

1. 登入 → **帳號與系統 → 資料管理 → 總表同步**
2. 先撳 **「匯出全部資料（JSON）」** 落本機留個底（保險）
3. 撳 **「立即儲存到後端」** → 應該見到「已把整個資料庫儲存到後端」
4. 撳 **「睇後端有咩資料」** 核對團員／帳目數目啱唔啱
5. 確認之後，用**另一部機**（或無痕視窗）開同一個網址 —— 應該自動見到同一份資料

做完呢兩步，你嘅資料就真係喺 Google Sheet 度，唔再係「淨係喺部電話」。

---

## 下一步（下次開新對話再做）

1. **清空 82 旅資料變空白** —— 確認後端有嘢之後，移除 `data/units/0082/` 嘅靜態檔
   （真實姓名 ＋ YMIS 而家係公開可下載嘅）。
2. **收窄 `data/units.json` 頂層共用 `backend`** —— 程式已經唔會用，但個欄位仲喺度，
   建議連同 `_howto` 一齊改成純文件說明，免得下手再接返去。
3. **API Key** —— 0082 而家 `apiKey` 係空字串，即係任何知道 `/exec` 嘅人都寫得。
   建議喺 Apps Script 執行 `showApiKey()`，再放入 Vercel 環境變數 `TROOP_0082_APIKEY`
   （放 env 唔會出現喺瀏覽器，比放 `data/units.json` 安全）。

---

## 改咗啲咩檔

| 檔案 | 改動 |
|---|---|
| `assets/js/lib/remote.js` | **新** —— 後端儲存引擎（自動存、重試、離線排隊、讀返） |
| `assets/js/lib/gastemplate.js` | 「資料庫」分頁 ＋ `saveDb` / `loadDb` / `dbInfo`（v2.1.0） |
| `apps-script/Code.gs` | 由 gastemplate 重新產生（`npm run build:gas`） |
| `assets/js/lib/store.js` | `setSaveHook` / `adoptRemote` / `commitMeta` / `hasLocalContent`；`wipe()` 保留後端設定 |
| `assets/js/lib/units.js` | **移除共用後端 fallback**（旅團隔離） |
| `assets/js/public-notice.js` | 同上（報名提交唔會再送錯旅團） |
| `assets/js/main.js` | 開機同後端對資料、自動儲存、頂部儲存狀態提示 |
| `assets/js/views/tables.js` | 儲存狀態卡 ＋ 三粒新掣；`sync` 一併帶埋整份資料庫 |
| `api/proxy.js` | 放行 `saveDb` / `loadDb` / `dbInfo` |
| `tests/remote.mjs` | **新** —— 44 個測試（含真 HTTP 換機情境） |
| `tests/_device.mjs` / `tests/_fakegas.mjs` | **新** —— 測試用「一部機」模擬器同假 GAS |

### 測試點樣證明「換機唔會冇咗資料」

`tests/remote.mjs` 唔係 mock function call，係真嘢：

```
假 GAS（記憶體 Sheet，同真 Code.gs 一樣分段存）
   ↑ 真 HTTP
dev-server（真 /api/proxy）
   ↑ 真 HTTP
裝置 A（獨立 process、獨立 localStorage）  加人加帳 → 寫後端
裝置 B（另一個 process ＝ 真‧另一部機）    開機 → 讀返 → 見到同一批資料
裝置 C                                      改嘢 → 等 debounce → 自動存
裝置 D                                      開機 → 見到 C 自動存嗰個新團員
```

仲有：分段拼合（2000 個團員、亂序讀返都砌得返）、
示範資料唔會寫入真後端、未登記旅團會被 proxy 擋、log 唔會外洩團員姓名。
