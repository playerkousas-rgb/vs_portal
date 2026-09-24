# 俾進度前端 Agent 嘅工作簡報（已停用 · 歷史記錄）

> ⛔ **2026-09-16：唔需要再改進度前端。**
> 新模型係**一個後端、兩個前端**：進度資料就喺旅團自己嘅後端（同一支 `/exec`），
> 執委管理系統自己會讀／寫（`?action=load` / `action=save` / `action=saveOtherBadge`），
> 唔需要 portal、唔需要 `portalOrigin`、唔需要對方加任何 endpoint。
> 下面係舊 portal 方案嘅簡報，純粹留底。

# 俾 VSBADGE Agent 嘅工作简报（可以直接貼過去）

> 用法：由呢一行開始，成段貼俾負責 `playerkousas-rgb/vsbadge` 個 agent。

---

## 任務：修 Portal 免登入模式嘅驗證洞，並支援「主系統自動帶身份、旅團零設定」

### 背景

`vsbadge` 同一個叫 **82venture** 嘅執委管理系統（`playerkousas-rgb/82venture`）做聯邦式對接：
82venture 係主系統（hub），vsbadge 係進度系統，**進度資料由 vsbadge 擁有**，82venture 只做入口同管理。
82venture 用 portal 信任模式把執委／領袖身份帶過嚟，例如：

```
https://vsbadge.vercel.app/?u=0082&role=exec_committee&ymis=PORTAL-0082-EXCO&name=執行委員會&from=portal&src=https://82venture.example&ts=1789449435427&embed=1
```

`src`（主系統 origin）同 `ts`（毫秒時間戳）**82venture 已經有送**，你改好就即刻生效，唔使佢再改。

### 問題 1：portal 模式完全冇驗證（安全漏洞）

`index.html` 約 line 1786：

```js
if (from === 'portal' && ymis && role) {
  currentUser = {
    ymis, name: nameParam, role,
    can_tick: ['admin','group_leader','branch_leader','exec_committee','super_admin'].includes(role),
    allowed_badges: '*', email: params.get('email') || '', isPortal: true
  };
  currentToken = 'portal-' + Date.now();
  // 跳過登入，直接顯示 mainApp
}
```

呢段**淨係信 URL 參數**，冇任何來源驗證。已實測：

```
https://vsbadge.vercel.app/?u=0082&from=portal&role=super_admin&ymis=x
```

任何知道格式嘅人都可以用呢條網址攞到 0082 嘅 **super_admin**：`can_tick: true`、
`allowed_badges: '*'`，仲有「用戶管理」「審批中心」。唔使密碼、唔使登入、唔使來自任何特定網站。
`ymis=x` 随便填都得，因為 portal 分支**唔會核對 `ymis` 係咪真係該旅團成員**。

### 問題 2：要求人手填 `ymis`，令新旅團接入變麻煩

而家 `ymis` 係必要參數。82venture 嗰邊已經改成自動產生 `PORTAL-<旅團>-<角色>`
（實測 `PORTAL-0082-EXCO` 可以正常入到，介面顯示「執委會(PORTAL-0082-EXCO) 自己」），
所以**功能上已經唔需要人手填**。但 `if (… && ymis && …)` 呢個條件要保留兼容，
同時要把 `ymis` 變成可省略（冇帶就自動 `PORTAL-<u>-<role>`）。

---

### 要做嘅改動

#### 1. Registry 加兩個欄位（`api/_registry.js` + `data/troops.json`）

```jsonc
// data/troops.json
"0082": {
  "name": "第 82 旅",
  "en": "82nd Group",
  "backend": "https://script.google.com/macros/s/…/exec",
  "portalOrigin": "https://82venture.vercel.app",
  "portalRoles": ["exec_committee", "branch_leader", "group_leader"]
}
```

* `getTrustedTroop()` 一併回傳 `portalOrigin` / `portalRoles`
* 支援 env 覆寫，跟返現有命名風格：`TROOP_<ID>_PORTALORIGIN` / `TROOP_<ID>_PORTALROLES`
  （逗號分隔），同埋現有嘅大階／去前導零變體
* **`api/troops.js` 唔好公開呢兩個欄位**（同 `backend` / `apikey` 一樣只留伺服器端）
* 冇設 `portalOrigin` 嘅旅團 = **唔開放 portal**（fail closed）

#### 2. 新增 `api/portal.js`（伺服器端驗證 endpoint）

```js
import { getTrustedTroop } from './_registry.js';

const TICK_ROLES = ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'];

export default function handler(req, res) {
  const send = (o, status = 200) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).json(o);
  };
  const { u, role, src } = req.query;
  const troop = getTrustedTroop(String(u || ''));
  if (!troop) return send({ ok: false, reason: 'unknown_troop' });
  if (!troop.portalOrigin) return send({ ok: false, reason: 'troop_not_portal_enabled' });

  // 來源驗證：src 參數 + 瀏覽器強制嘅 Referer/Origin（src 可被非瀏覽器 client 偽造）
  const refOrigin = (() => {
    try { return new URL(req.headers.referer || '').origin; } catch { return ''; }
  })();
  const origin = refOrigin || req.headers.origin || '';
  if (origin && origin !== troop.portalOrigin) return send({ ok: false, reason: 'referer_mismatch' });
  if (src && src !== troop.portalOrigin) return send({ ok: false, reason: 'origin_not_allowed' });
  if (!origin && !src) return send({ ok: false, reason: 'no_origin' });

  const allowed = (troop.portalRoles && troop.portalRoles.length ? troop.portalRoles : ['exec_committee']);
  if (!allowed.includes(String(role || ''))) return send({ ok: false, reason: 'role_not_allowed' });
  if (!TICK_ROLES.includes(String(role || ''))) return send({ ok: false, reason: 'role_not_allowed' });

  return send({ ok: true, role: String(role), troop: troop.id, name: troop.name });
}
```

`vercel.json` 加 route：`{ "src": "/api/portal/?", "dest": "/api/portal.js" }`
（現有 `/api/(.*)` 兜底應該已經 cover，確認一下）。

**唔好加 CORS header** —— 呢個 endpoint 只給同源前端用，保持同 `/api/proxy` 一樣嘅同源限定原則。

#### 3. `handlePortalParams()` 改成先問伺服器

```js
if (from === 'portal') {
  let v = { ok: false, reason: 'no_response' };
  try {
    const qs = new URLSearchParams({ u: u || '', role: role || '', src: params.get('src') || '' });
    v = await fetch('/api/portal?' + qs.toString()).then(r => r.json());
  } catch (e) { console.warn('portal verify failed', e); }

  if (v.ok) {
    currentUser = {
      ymis: ymis || `PORTAL-${u}-${role}`,      // ← ymis 變成可省略
      name: nameParam, role,
      can_tick: ['admin','group_leader','branch_leader','exec_committee','super_admin'].includes(role),
      allowed_badges: '*', email: params.get('email') || '', isPortal: true
    };
    // …現有嘅顯示 mainApp / setupTabsByRole() / loadItemsAndProgress() 照舊
  } else {
    // **唔好靜靜地跌返登入頁** —— 要明確講原因（呢個正正係之前連通失敗睇唔出原因嘅根源）
    showPortalError(v.reason);   // unknown_troop / troop_not_portal_enabled / referer_mismatch /
                                 // origin_not_allowed / role_not_allowed / no_origin
    return;
  }
}
```

`showPortalError(reason)` 要顯示人話訊息，例如：
* `referer_mismatch` → 「呢個旅團只接受由 <portalOrigin> 進入」
* `role_not_allowed` → 「呢個旅團未開放 <role> 身份接入」
* `troop_not_portal_enabled` → 「呢個旅團未開放主系統接入，請聯絡管理員登記 portalOrigin」

---

### 約束（唔好破壞）

1. **軌道 A（獨立使用）必須照舊**：冇帶 `from=portal` 嘅訪客，揀旅團 → 登入，一切不變
2. **唔好放寬 `/api/proxy`**：保持 action 白名單、`getTrustedTroop()`、`isTrustedExecUrl()`、
   唔 log token／apikey／payload
3. **唔好改 `Code.gs`**：呢個改動純前端 + Vercel API，旅團**唔使**重新部署佢哋嘅 Apps Script
4. **`ymis` 唔好開始強制核對成員名單**：82venture 依賴「主系統自己派身份」做到旅團零設定接入。
   身份核對應該靠 `portalOrigin`（邊個網站可以帶人入嚟），唔係靠 ymis 存唔存在
5. 改完要更新 `docs/EXEC_GUIDE.md` / `DEPLOY_GUIDE_FOR_TROOPS.md` 嘅軌道 B 說明，
   同埋 `tests/`（現有 e2e 用雙 mock GAS 旅團，加一個 portal 驗證 case）

### 驗收標準

```
✅ ?u=0082&from=portal&role=exec_committee&src=<已登記 origin>        → 免登入入到，有勾選權
✅ 同上但 role=super_admin（唔喺 portalRoles 入面）                    → 拒絕，顯示 role_not_allowed
✅ 同上但 src=<未登記 origin>                                         → 拒絕，顯示 origin_not_allowed
✅ 用 curl 直接打（冇 Referer、src 亂填）                              → 拒絕
✅ ?u=<未登記旅團>&from=portal&…                                       → 拒絕，顯示 unknown_troop
✅ 冇帶 from=portal 嘅一般訪客                                         → 照常揀旅團登入（軌道 A 冇壞）
✅ 冇帶 ymis 但其他齊全                                                → 自動用 PORTAL-<u>-<role> 入到
❌ ?u=0082&from=portal&role=super_admin&ymis=x（直接砌 URL）           → 必須失敗（呢個係而家嘅漏洞）
```

### 相關文件（82venture repo）

* `docs/PROGRESS_PORTAL_HANDOFF.md` —— 完整交接協議同實測結果
* `docs/ADMIN_ONBOARDING.md` —— 管理員每個旅團要 set 嘅欄位名（含 `TROOP_<ID>_*` env）
* `assets/js/views/progress.js` —— `portalIdentity()` / `buildUrl()`（82venture 送出乜）
* `assets/js/lib/onboard.js` —— 新旅團申請 payload schema（`appType: '82venture'`，
  同你哋 `submitRegistration` 對齊，可以共用同一個 `SCOUT_ADMIN_API` 收件匣）
