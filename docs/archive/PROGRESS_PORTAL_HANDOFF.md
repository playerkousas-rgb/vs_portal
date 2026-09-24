# 進度系統 Portal 交接（已停用 · 歷史記錄）

> ⛔ **2026-09-16：呢個設計已經停用。**
> 團長指正：唔需要「連入」任何其他系統 —— 進度資料本身就係寫入旅團自己嘅後端，
> 所以係**一個後端、兩個前端**（深資童軍管理系統 ＋ 進度前端）。執委系統只讀／寫後端
> （`?action=load` / `action=save`），冇外連、冇 portal、冇 `referer_mismatch`。
> 下面係舊 portal 方案嘅交接記錄，純粹留底。

# 進度系統 Portal 交接（深資童軍管理系統 → VSBADGE）

最後核實：2026-09-15，對 `vsbadge` repo（v8.7）＋ `https://vsbadge.vercel.app` 實測。

> ⚠️ **2026-09-16 更新：主要做法已改為「直接接駁」。**
> 深資童軍管理系統唔再靠 Portal 外連顯示進度 —— 旅團喺「進度 → 設定」填自己嘅 VSBADGE `/exec` 網址同 API Key，
> 由 `api/progress.js` 直接讀寫（`load` / `save` / `saveOtherBadge` / `items`）。
> 本文檔保留做 **舊入口（portal）** 嘅設計與安全交接記錄；VSBADGE v3.1 已經加咗本文檔建議嘅
> `api/portal.js` 驗證（`portalOrigin` / `portalRoles`），所以而家未登記就直接開連結會出 `referer_mismatch`。

---

## 1. 而家實際點運作

VSBADGE `index.html` 嘅 portal 分支（約 line 1786）：

```js
if (from === 'portal' && ymis && role) {
  currentUser = {
    ymis: ymis, name: nameParam, role: role,
    can_tick: ['admin','group_leader','branch_leader','exec_committee','super_admin'].includes(role),
    allowed_badges: '*', email: params.get('email') || '', isPortal: true
  };
  currentToken = 'portal-' + Date.now();   // 虛擬 token
  // 跳過登入，直接顯示 mainApp
  if (troopRegistered) loadItemsAndProgress();
}
```

兩個關鍵事實（都係實測確認）：

1. **`ymis` 唔會同旅團成員名單核對。** 我用一個任意字串 `EXCO-82`、
   後來用自動產生嘅 `PORTAL-0082-EXCO`，兩次都入到，介面顯示「**執委會**(PORTAL-0082-EXCO) 自己」。
   → 所以主系統可以**自己派身份**，旅團接入時**唔使先去進度系統開帳戶**。
2. **`u` 必須已登記**喺對方伺服器端 Registry（`/api/troops` → `data/troops.json` + `TROOP_*` env），
   否則顯示「未在伺服器端 troops.json / env 找到」。

82venture 而家送出嘅連結（零設定，`portal.ymis` 留空）：

```
https://vsbadge.vercel.app/?u=0082&role=exec_committee&ymis=PORTAL-0082-EXCO
  &name=執行委員會&from=portal&src=<主系統 origin>&ts=<毫秒>&embed=1
```

* `ymis` 由 `portalIdentity()` 自動產生：`PORTAL-<旅團編號>-<角色縮寫>`
  （`EXCO` / `LEADER` / `GLEADER` / `ADMIN` / `SUPER` / `MEMBER`）
* `src` / `ts` 係**為下文第 3 節預留**，對方而家會忽略

---

## 2. ⚠️ 安全問題：portal 模式而家完全冇驗證

上面嗰段 code **只係信 URL 參數**。任何知道格式嘅人都可以直接砌一條網址，
攞到任何已登記旅團嘅**最高權限**：

```
https://vsbadge.vercel.app/?u=0082&from=portal&role=super_admin&ymis=x
```

* `role=super_admin` → `can_tick: true`、`allowed_badges: '*'`，仲有「用戶管理」「審批中心」
* `ymis=x` 随便填都得（唔核對）
* 唔使密碼、唔使登入、唔使來自任何特定網站

我今次就是用同一個機制（`role=exec_committee`）入到去驗證連通 —— 即係話
**呢個唔係理論風險，係已經可以咁做**。

呢個洞喺 VSBADGE 嗰邊，唔喺 82venture。但因為你想靠「由執委系統入去就自動有權限」，
**放寬之前必須先加驗證**，否則等於把整個旅團嘅進度資料同用戶管理公開。

---

## 3. 建議改法（VSBADGE 側）

目標：做到你要嘅「由執委系統（領袖／超管／執委）進入就自動有權限、旅團零額外設定」，
同時唔再係任何人砌條 URL 就入到。

### 3a. Registry 加兩個欄位

旅團接入時**已經**要提交主系統資料（你個流程：DL Code.gs → 建 Sheet → 部署 → 交 URL 俾管理員）。
同一次提交順手登記多兩樣就得，旅團唔使額外做嘢：

```jsonc
// data/troops.json
"0082": {
  "name": "第 82 旅",
  "backend": "https://script.google.com/macros/s/…/exec",
  "portalOrigin": "https://82venture.vercel.app",   // ← 新增：核准嘅主系統 origin
  "portalRoles": ["exec_committee", "branch_leader", "group_leader"]  // ← 新增：允許嘅交接角色
}
```

`api/_registry.js` 嘅 `getTrustedTroop()` 一併回傳呢兩個欄位；
`api/troops.js` **唔好**公開佢哋（同 `backend` 一樣只留伺服器端）。

### 3b. 加一個伺服器端驗證 endpoint

```js
// api/portal.js —— 主系統交接驗證（只回 ok／role，唔洩後端）
export default async function handler(req, res) {
  const { u, role, src } = req.query;
  const troop = getTrustedTroop(u);
  if (!troop?.portalOrigin) return res.status(200).json({ ok: false, reason: 'troop_not_portal_enabled' });
  if (src !== troop.portalOrigin) return res.status(200).json({ ok: false, reason: 'origin_not_allowed' });
  const allowed = troop.portalRoles || ['exec_committee'];
  if (!allowed.includes(role)) return res.status(200).json({ ok: false, reason: 'role_not_allowed' });
  res.status(200).json({ ok: true, role });
}
```

### 3c. `handlePortalParams()` 改成先問伺服器

```js
// 由「淨係信 URL」改成「問過伺服器先」
const v = await fetch(`/api/portal?u=${encodeURIComponent(u)}&role=${encodeURIComponent(role)}&src=${encodeURIComponent(src||'')}`)
  .then(r => r.json()).catch(() => ({ ok: false }));
if (from === 'portal' && v.ok && role) {
  currentUser = { ymis: ymis || `PORTAL-${u}-${role}`, name: nameParam, role,
    can_tick: TICK_ROLES.includes(role), allowed_badges: '*', isPortal: true };
  …
} else if (from === 'portal') {
  // 明確講失敗原因，唔好靜靜地跌返登入頁
  showPortalError(v.reason);   // origin_not_allowed / role_not_allowed / troop_not_portal_enabled
}
```

* `ymis` 變成**可以省略**（自動 `PORTAL-<u>-<role>`）→ 做到你要嘅零設定
* `src` 由主系統帶（82venture **已經有送**），伺服器同 registry 對 → 唔再係任何人砌 URL 就入到
* 失敗要有明確訊息，唔好靜靜地跌返登入頁（呢個正正係今次連通失敗睇唔出原因嘅根源）

### 3d. 限制：`src` 係可偽造嘅

`src` 係 URL 參數，用 `curl` 之類嘅非瀏覽器 client 可以隨便填。
`Referer` / `Origin` header 就唔可以由 JS 偽造（瀏覽器強制），所以**最好一併檢查**：

```js
const refOrigin = new URL(req.headers.referer || '').origin;   // 或 req.headers.origin（iframe 會有）
if (refOrigin !== troop.portalOrigin) return …{ ok: false, reason: 'referer_mismatch' };
```

對「瀏覽器入面嘅人手操作」呢個已經足夠。如果要**密碼學級別**嘅保證，就要：

> 主系統加一個 serverless function（Vercel）持有 per-troop secret，
> 簽發短時效 token `{u, role, exp, sig}`；VSBADGE 用同一個 secret 驗證。
>
> **注意**：82venture 而家係**純靜態、零後端**（你呢個係明確約束），
> secret 放前端等於公開，所以呢一步等於要放寬嗰個約束。要做先講。

---

## 4. 82venture 呢邊已經做定嘅嘢

| 項目 | 狀態 |
| --- | --- |
| `portalIdentity()` 自動產生 `PORTAL-<旅團>-<角色>`，`portal.ymis` 可以留空 | ✅ 已實測入到 |
| `buildUrl()` 帶 `src`（主系統 origin）＋ `ts` | ✅ 對方而家忽略，改好就即刻生效 |
| `role` 改用 `<select>`，只允許對方認得嘅值 | ✅ 避免填 `exco` 之類對方唔認嘅字 |
| `readiness()` 10 項，含「網址唔好係 GAS /exec」「有 portal 身份」「角色有勾選權」 | ✅ |
| 跨系統身份 key（團員 YMIS / 領袖 Email / fallback systemId） | ✅ 見 `model.memberKey()` |

## 5. 刻意唔做

* **L3 事件推**（出席／活動／報名 推去對方計進度）—— 你話太複雜，唔想因小失大
* **喺 82venture 自己介面顯示每人進度**：對方 `/api/proxy` **一個 `Access-Control` header 都冇**
  （已 grep `api/` 同 `vercel.json`），係同源限定，純靜態嘅 82venture 讀唔到。
  而家嘅做法係 **portal 免登入 ＋ 內嵌（`embed=1`）**；
  對方 `vercel.json` 冇設 `X-Frame-Options`，所以內嵌可行。
