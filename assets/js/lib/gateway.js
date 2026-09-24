/* ============================================================
   gateway.js — 前端 → 旅團後端（Apps Script /exec）嘅統一入口
   ------------------------------------------------------------
   兩條路，**兩條都要行得通**：

   ① 同源 /api/proxy（正路，平台管理員設定）
        旅團喺伺服器端登記咗（TROOP_<編號>_BACKEND / TROOP_<編號>_APIKEY），
        API Key 留喺伺服器，瀏覽器乜都唔使知。最穩陣。

   ② 直接打旅團自己嘅 /exec（自助路線，領袖自己搞得掂）
        平台未登記嗰陣，領袖喺「帳號與系統 → 資料管理 → 總表同步」
        貼自己嘅 /exec（要 key 嘅 action 再貼 API Key）；
        公開頁則由「成員連結」生成嘅連結帶 ?be=<exec>。

   【2026-09-19 團長回報：無痕＋普通 Chrome 都同步唔到、公開連結都冇修好，
     懷疑「有啲嘢把解決問題嘅方法封死」—— 懷疑係啱嘅。】
   舊 remote.js 係咁寫：
        if (r.ok && r.json) return normalize(r.json);
        if (!r.noApi) { if (r.json) return normalize(r.json); ... }
   proxy 對「未登記旅團」回嘅係 **HTTP 404 ＋ JSON**（`{success:false,
   error:'找不到此旅團或後端網址未設定'}`），而 `noApi` 只在**回應唔係 JSON**
   嗰陣先會 set —— 所以 `r.json` 永遠 truthy，函數喺 ① 就 return 咗，
   ② 條路（用家自己貼嘅 /exec）**一行都未行過**。
   即係：平台環境變數一日未設定好，領袖自己貼 /exec 都係死，
   而「叫平台管理員加環境變數」又唔係領袖自己做得到 → 兩邊都死鎖。
   呢個模組把兩條路統一返，並且如實報告「行緊邊條路／點解唔得」。
   ============================================================ */

/** Apps Script 正式部署網址白名單（同 api/_registry.js 嘅 EXEC_URL_RE 一致）。
    用家自己貼嘅 /exec 一定要過呢關，先至會把資料庫／相片送上去 ——
    防止貼錯網址、或者由匯入嘅舊設定指去其他地方。 */
export const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

export function isExecUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || s.length > 300) return false;
  if (EXEC_URL_RE.test(s)) return true;
  /* 本機開發／測試例外：**頁面本身**就係喺 localhost 度開嗰陣，
     先至准打本機後端（同 api/_registry.js 嘅 V82_PROXY_TEST 同一個用意）。
     正式站（https://….vercel.app）永遠過唔到呢條 —— 唔會變成開放中繼。 */
  try {
    const host = typeof location !== 'undefined' ? String(location.hostname || '').toLowerCase() : '';
    const onLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';
    if (onLocal && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/[A-Za-z0-9._~\-/?=&%]*$/i.test(s)) return true;
  } catch { /* ignore */ }
  return false;
}

/** 正規化（去空白／尾 slash） */
export function normExecUrl(u) {
  const s = String(u || '').trim();
  return s.replace(/\/+$/, '');
}

/* proxy 話「呢個旅團未喺伺服器端登記」。
   注意：呢個**唔係**後端壞咗，而係平台未幫你接線 ——
   所以呢種情況一定要跌落入 ②（自助路線），唔可以當失敗收工。 */
export const UNREGISTERED_RE = /找不到此旅團|後端網址未設定|unknown unit|not registered|no backend/i;

/** 有冇同源 /api/proxy 可以用（http/https 先有；file:// 冇） */
export function proxyUsable() {
  try { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol); }
  catch { return false; }
}

/**
 * 由網址 ?be= 攞「自助後端」（公開頁用：團員掃 QR 入嚟嗰陣，
 * 連結本身就帶住旅團自己嘅 /exec，唔使靠平台伺服器端登記）。
 * 一律要過白名單；唔合格就當冇（寧願顯示「未連接」都唔好送資料去奇怪地方）。
 */
export function beFromQuery(search) {
  try {
    const s = typeof search === 'string' ? search : (typeof location !== 'undefined' ? location.search : '');
    const v = new URLSearchParams(s).get('be') || '';
    const u = normExecUrl(v);
    return isExecUrl(u) ? u : '';
  } catch { return ''; }
}

/* Vercel 代理單一回應上限 4.5MB。爆咗嗰陣 Vercel 唔會回 JSON，
   而係回一段純文字（例如 FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE）。
   前端一定要認得出呢種情況 —— 佢嘅救法（分段讀／瘦身）同「後端壞咗」完全唔同。 */
export const PAYLOAD_TOO_LARGE_RE = /PAYLOAD_TOO_LARGE|response.{0,20}too large|body.{0,20}too large|payload.{0,20}exceed/i;

/** 回應過大嗰陣嘅人話解釋（唔會再講「未設定後端網址」） */
function tooLargeError(status, text) {
  if (PAYLOAD_TOO_LARGE_RE.test(text)) {
    return '後端回應大過 Vercel 代理上限（4.5MB）—— 資料庫太大，一次過讀唔晒。'
      + '前端會自動改用分段讀取；如果仍然失敗，就要把後端更新到 v2.6.0（支援 loadDbPart），'
      + '並且喺「總表同步 → 體積檢查」做一次「相片瘦身」。';
  }
  return `後端回應格式異常（HTTP ${status}）`;
}

async function postJson(endpoint, body, timeoutMs, plain) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      /* text/plain 避免 CORS preflight（Apps Script 唔支援 OPTIONS） */
      headers: { 'Content-Type': plain ? 'text/plain;charset=utf-8' : 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); }
    catch {
      /* 文字唔係 JSON：有啲環境（測試 stub／某啲代理）只暴露 res.json()。
         瀏覽器度呢度會拋「body already used」—— 照樣當「唔係 JSON」處理。 */
      try { if (typeof res.json === 'function') json = await res.json(); } catch { /* 真係唔係 JSON */ }
    }
    if (!json) {
      return {
        ok: false, json: null, status: res.status,
        /* 同源 proxy 根本唔存在（靜態伺服器回 HTML／404） */
        noApi: res.status === 404 || /<!doctype|<html/i.test(text),
        /* 回應過大（Vercel 4.5MB 硬上限）要**講真話**：呢個唔係「後端壞」，
           更唔係「未設定後端網址」—— 係資料庫大過單一回應上限，要分段讀。
           2026-09-20 事故：呢度淨係回「回應格式異常」，用家完全估唔到死因。 */
        tooLarge: PAYLOAD_TOO_LARGE_RE.test(text),
        error: tooLargeError(res.status, text), reason: PAYLOAD_TOO_LARGE_RE.test(text) ? 'too_large' : 'bad_response'
      };
    }
    return { ok: res.ok, json, status: res.status, noApi: false, tooLarge: false, error: '', reason: '' };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, json: null, status: 0, noApi: false, tooLarge: false, error: aborted ? '連線逾時' : (e?.message || '網絡錯誤'), reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 送一個 action 去旅團後端。
 *
 * @param {object} payload   已經包埋 `action`（同其他欄位）
 * @param {object} opts
 *   - unit      旅團編號（必填）
 *   - execUrl   自助路線嘅 /exec（留空＝淨係試 proxy）
 *   - apiKey    自助路線要帶嘅 key（proxy 路線唔使 —— 伺服器端會注入）
 *   - timeoutMs
 * @returns {Promise<{ok:boolean, json:object|null, via:'proxy'|'direct'|'none',
 *                    error:string, reason:string, unregistered:boolean}>}
 *   `via` ＝ 最後真係行咗邊條路（界面／診斷用嚟講清楚）
 *   `unregistered` ＝ proxy 話「平台未登記呢個旅團」（自助路線嘅訊號）
 */
export async function postBackend(payload, { unit, execUrl = '', apiKey = '', timeoutMs = 60000 } = {}) {
  const body0 = { ...payload, unit };
  let unregistered = false;

  /* ---- ① 同源 proxy（正路）----
     **唔好送空 apiKey**：proxy 係 `if (unit.apiKey && !payload.apiKey)` 先注入，
     送個空字串上去會令伺服器端條 key 注入唔到。 */
  if (proxyUsable()) {
    const body = { ...body0 };
    if (apiKey) { body.apiKey = apiKey; body.apikey = apiKey; }
    const r = await postJson('api/proxy', body, timeoutMs, false);
    const errText = String(r.json?.error || '');
    if (r.json && !UNREGISTERED_RE.test(errText)) {
      return { ok: r.ok, json: r.json, via: 'proxy', error: r.error, reason: r.reason, unregistered: false, tooLarge: false };
    }
    /* proxy 明確話「未登記呢個旅團」→ 唔係失敗，係「平台未接線」→ 跌落入 ② */
    if (r.json && UNREGISTERED_RE.test(errText)) unregistered = true;
    /* proxy 回咗其他錯誤（未授權／後端壞／逾時／回應過大）→ 如實報，唔好扮冇事 */
    if (!unregistered) {
      if (r.json) return { ok: false, json: r.json, via: 'proxy', error: errText || r.error, reason: r.reason || 'backend', unregistered: false, tooLarge: false };
      /* ★ 回應過大（Vercel 4.5MB）一定唔可以跌落 ②：
         後端答咗話，只係答唔晒 —— 跌去自助路線只會對用家講
         「未設定後端網址」，把真正死因（資料庫太大）完全蓋住。
         （2026-09-20 事故。） */
      if (r.tooLarge) {
        return { ok: false, json: null, via: 'proxy', error: r.error, reason: 'too_large', unregistered: false, tooLarge: true };
      }
      if (!r.noApi) return { ok: false, json: null, via: 'proxy', error: r.error, reason: r.reason || 'network', unregistered: false, tooLarge: false };
      /* r.noApi ＝ 呢個部署根本冇 /api（純靜態）→ 跌落入 ② */
    }
  }

  /* ---- ② 直接打旅團自己嘅 /exec（自助路線）---- */
  const url = normExecUrl(execUrl);
  if (!url) {
    return {
      ok: false, json: null, via: 'none', unregistered,
      reason: unregistered ? 'not_registered' : 'not_configured',
      error: unregistered
        ? '平台伺服器端未登記呢個旅團嘅後端，而連結／設定亦冇帶後端網址'
        : '未設定後端網址'
    };
  }
  if (!isExecUrl(url)) {
    return {
      ok: false, json: null, via: 'direct', unregistered, reason: 'bad_url',
      error: '後端網址唔係 Apps Script 正式部署網址（/exec）'
    };
  }
  const direct = { ...body0 };
  if (apiKey) { direct.apiKey = apiKey; direct.apikey = apiKey; }
  const d = await postJson(url, direct, timeoutMs, true);
  if (d.json) return { ok: d.ok, json: d.json, via: 'direct', error: '', reason: '', unregistered };
  return { ok: false, json: null, via: 'direct', error: d.error || '連唔到旅團後端', reason: d.reason || 'network', unregistered };
}

/** 短網址（顯示用） */
export function shortExec(u) {
  const s = String(u || '');
  if (!s) return '';
  const m = /\/macros\/s\/([A-Za-z0-9_-]+)/.exec(s);
  return m ? `script.google.com/…/${m[1].slice(0, 8)}…/exec` : s.slice(0, 48);
}
