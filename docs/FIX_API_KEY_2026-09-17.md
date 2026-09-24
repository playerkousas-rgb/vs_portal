# 點解財政／生日匯入唔到後端 —— API Key 未入 Vercel

> 你回報：「用咗最新嘅 GS，但都係唔可以將現有嘅財政匯入後端，生日果啲都係。」
>
> **正確做法：喺 Vercel 加環境變數。唔使、亦都唔應該喺 app 入面打條 key。**

---

## 一句話總結

你個後端行 `initializeSheets` 嗰陣**自動生成咗一條 API Key**，
但平台伺服器端（Vercel）未有呢條 key，所以後端每次都拒絕寫入。

---

## 架構係點（點解唔應該喺 app 打 key）

```
瀏覽器 ──只送旅團編號──▶ /api/proxy ──伺服器端加 API Key──▶ 你嘅 /exec ──▶ Google Sheet
                              ▲
                   TROOP_0082_BACKEND / TROOP_0082_APIKEY
                        （Vercel 環境變數）
```

`api/proxy.js` 收到請求之後會自己補條 key：

```js
const unit = getTrustedUnit(unitCode);              // 由環境變數解析
if (unit.apiKey && !payload.apiKey) payload.apiKey = unit.apiKey;
```

所以**瀏覽器由頭到尾都唔需要知道條 key**，亦都唔應該知 —— 一旦放入前端，
條 key 就會留喺 localStorage，任何開得到 DevTools 嘅人都攞得走。

> 你講得啱：能夠入到旅團就已經代表連通咗，唔應該再叫用家「連」多次。

---

## 點解決（交畀平台管理員，2 分鐘）

### 第 1 步：攞條 API Key

1. 打開你張 Google Sheet → **擴充功能 → Apps Script**
2. 函數下拉選單揀 **`showApiKey`** → 撳 **▶ 執行**
3. 下面「執行記錄」會出：
   ```
   深資童軍管理系統 API Key: v82_xxxxxxxxxxxxxxxxxxxxxxxx
   ```

### 第 2 步：入 Vercel 環境變數

Vercel 專案 → **Settings → Environment Variables**，加呢兩個：

| Name | Value |
|---|---|
| `TROOP_0082_APIKEY` | `v82_xxxxxxxxxxxxxxxxxxxxxxxx` |
| `TROOP_0082_BACKEND` | `https://script.google.com/macros/s/……/exec` |

> `TROOP_0082_BACKEND` 如果 `data/units.json` 已經有啱嘅 `/exec` 就可以唔加；
> 但加咗會蓋過檔案，改後端網址唔使再 commit。

### 第 3 步：重新部署

Vercel → **Deployments → ⋯ → Redeploy**（環境變數要重新部署先生效）。

### 第 4 步：入 app 撳一下

**表格與同步 → 總表同步 → 立即儲存到後端** → 應該見「已把整個資料庫儲存到後端」。
再撳「睇後端有咩資料」對下團員數同帳目數。

---

## 疑難排解

| 訊息 | 即係 | 點做 |
|---|---|---|
| `未授權：API Key 唔正確` | Vercel 未有 key／未 redeploy／key 貼錯 | 重做第 2–3 步，確認變數名連 `0082` 都啱 |
| `未知 action：saveDb` | 個 `/exec` 仲行緊**舊版**程式碼 | Apps Script → 部署 → 管理部署作業 → ✏️ → 版本揀「**新版本**」 |
| `找不到此旅團或後端網址未設定` | proxy 搵唔到 registry entry | check `TROOP_0082_BACKEND` 或 `data/units.json` |
| `資料太大（超過 9MB）` | 相片太多 | 「儲存與備份」撳「清理已入帳嘅相片」 |

---

## 我改咗嘅嘢

我上一版**寫錯咗**，叫你喺 app 入面貼條 key —— 咁做違背咗成個 proxy 架構。
已經改返：

| 改動 | 之前 | 之後 |
|---|---|---|
| **`remote.js` 提示** | 叫用家去「同步設定」填 key | 叫管理員設定 `TROOP_<編號>_APIKEY`，講明條 key 唔會入瀏覽器 |
| **「同步設定」個 key 欄** | `API Key（可留空）`，好似預咗你填 | `通常唔使填`，下面寫明正路係 Vercel 環境變數，呢格淨係純靜態部署先用 |
| **狀態卡提示** | 教你 `showApiKey()` → 貼入 app | 教你 `showApiKey()` → 入 Vercel 環境變數 |

### 順手修好一個真 bug

前端本來**無論如何**都會送 `apiKey: ''` 上 proxy。而 proxy 係咁寫嘅：

```js
if (unit.apiKey && !payload.apiKey) payload.apiKey = unit.apiKey;
//                 ↑ payload.apiKey 係 ''，!'' = true，本來注入到
```

`''` 雖然過到 `!payload.apiKey`，但個設計好脆弱 —— 一旦前端存過任何非空值
（例如你試過喺個欄打過嘢再清空、或者 `seedBackend` 由 registry 抄咗個值落嚟），
就會蓋過伺服器端條 key。而家改成**有 key 先送，冇就唔送**。

### 仲有：唔再強迫前端知道 `/exec`

以前 `remoteCfg().ok` 一定要有 `url` 先肯寫入，即係純靠環境變數開團嘅旅團
（`data/units.json` 冇 entry）就算 proxy 一切正常都會被前端當成「未設定後端」。
而家只要有 `/api/proxy` ＋ 旅團編號就當接得通，`/exec` 交返畀伺服器端。

**測試**：`tests/remote.mjs` 加咗 8 項（52 過 / 0 唔過），
包括「前端唔送 key → GAS 收到伺服器端條 key」同「送空字串唔會整衰注入」。
