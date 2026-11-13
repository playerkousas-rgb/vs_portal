/* 團員入口登入狀態（YMIS＋密碼），同執委 session 分開。
   2026-09-18 修正（團長回報「退返系統又要重新登入」）：
   用 localStorage 保持同一個 GAS 短期 session；只保存 opaque token，最長 8 小時。
   token 過期／缺少就自動登出，唔會單靠可修改嘅本機 identity JSON 放行。 */
const key = code => 'v82.hub.auth.' + String(code || '');
const MAX_AGE_MS = 8 * 3600 * 1000;   // 同 GAS 短期 session（8 小時）

export function loadHubAuth(code) {
  try {
    const o = JSON.parse(localStorage.getItem(key(code)) || 'null');
    if (!o || !o.id) return null;
    /* 冇 server token／有效 expiry／已過期 → 自動登出；本機 JSON 唔可以自己冒充登入。 */
    const expiresAt = Number(o.sessionExpiresAt || 0);
    if (!o.sessionToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
        !Number.isFinite(Number(o.at)) || Date.now() - Number(o.at) > MAX_AGE_MS) {
      localStorage.removeItem(key(code));
      return null;
    }
    return o;
  } catch { return null; }
}

export function saveHubAuth(code, rec) {
  try {
    if (!rec) localStorage.removeItem(key(code));
    else localStorage.setItem(key(code), JSON.stringify({
      id: rec.id, name: rec.name || '', ymis: rec.ymis || '',
      identity: rec.identity || 'member',
      sessionToken: rec.sessionToken || '', sessionExpiresAt: Number(rec.sessionExpiresAt || 0),
      at: Date.now()
    }));
  } catch { /* */ }
}

export function clearHubAuth(code) {
  saveHubAuth(code, null);
}
