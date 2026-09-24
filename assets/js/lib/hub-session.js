/* 團員入口登入狀態（YMIS＋密碼），同執委 session 分開。
   2026-09-18 修正（團長回報「退返系統又要重新登入」）：
   以前用 sessionStorage —— 收咗個 tab／第二日再開／由通告頁返轉頭，session 就冇咗，
   團員次次都要重新登入。而家改用 localStorage：同一部機 30 日內保持登入，
   撳「登出」先會真正清走（過期會自動失效）。 */
const key = code => 'v82.hub.auth.' + String(code || '');
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;   // 30 日

export function loadHubAuth(code) {
  try {
    const o = JSON.parse(localStorage.getItem(key(code)) || 'null');
    if (!o || !o.id) return null;
    /* 過期 → 自動登出（唔使等佢試密碼先知） */
    if (o.at && Date.now() - Number(o.at) > MAX_AGE_MS) {
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
      identity: rec.identity || 'member', at: Date.now()
    }));
  } catch { /* */ }
}

export function clearHubAuth(code) {
  saveHubAuth(code, null);
}
