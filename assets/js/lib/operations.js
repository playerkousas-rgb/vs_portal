/* ============================================================
   operations.js — 寫入 operation ID／明確結果狀態
   ------------------------------------------------------------
   Google Apps Script / proxy 逾時只代表「未收到回應」，唔代表「冇寫入」。
   所有重要寫入帶 operation_id；前端只使用四種狀態：
     not_sent / not_applied / applied / unknown
   unknown 絕不自動重送，只可查狀態或做只讀 readback。
   ============================================================ */

const JOURNAL_KEY = 'venture82.operations.v1';
const MAX_JOURNAL = 40;
let memory = [];

function readJournalRaw() {
  try {
    const value = localStorage.getItem(JOURNAL_KEY);
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return memory.slice(); }
}
function writeJournalRaw(rows) {
  const safe = rows.slice(0, MAX_JOURNAL);
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(safe)); }
  catch { memory = safe; }
}

export function newOperationId(action = 'write') {
  const prefix = String(action || 'write').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 28) || 'write';
  let random = '';
  try { random = crypto.randomUUID().replace(/-/g, ''); }
  catch { random = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
  return `${prefix}:${Date.now().toString(36)}:${random.slice(0, 24)}`;
}

export function isOperationId(value) {
  return /^[A-Za-z0-9_.:-]{12,120}$/.test(String(value || ''));
}

export function beginOperation(action, meta = {}) {
  const id = isOperationId(meta.operationId) ? String(meta.operationId) : newOperationId(action);
  const rec = {
    id, action: String(action || ''), state: 'sending', outcome: 'unknown',
    at: new Date().toISOString(), updatedAt: new Date().toISOString(),
    unit: String(meta.unit || ''), label: String(meta.label || '')
  };
  writeJournalRaw([rec, ...readJournalRaw().filter(x => x.id !== id)]);
  return rec;
}

export function finishOperation(id, patch = {}) {
  const rows = readJournalRaw();
  const index = rows.findIndex(x => x.id === id);
  const base = index >= 0 ? rows[index] : { id, action: String(patch.action || ''), at: new Date().toISOString() };
  const next = { ...base, ...patch, updatedAt: new Date().toISOString() };
  if (index >= 0) rows.splice(index, 1);
  writeJournalRaw([next, ...rows]);
  return next;
}

export function operationJournal() { return readJournalRaw(); }
export function pendingOperations() {
  return readJournalRaw().filter(x => x.outcome === 'unknown' || x.state === 'processing' || x.state === 'sending');
}
export function dropOperation(id) { writeJournalRaw(readJournalRaw().filter(x => x.id !== id)); }

/** 將 transport／業務回應分類；caller 必須話畀我知 request 有冇真正開始 send。 */
export function classifyWriteOutcome(response, { sent = true } = {}) {
  const r = response || {};
  const explicit = String(r.outcome || r.operation?.outcome || r.operation?.state || '').toLowerCase();
  if (!sent || explicit === 'not_sent') return { outcome: 'not_sent', mayHaveApplied: false };
  /* A status envelope can itself be `ok:true` while reporting that the original
     write is unknown/not-applied. The explicit write outcome always wins. */
  if (explicit === 'unknown' || explicit === 'processing') return { outcome: 'unknown', mayHaveApplied: true };
  if (explicit === 'not_applied') return { outcome: 'not_applied', mayHaveApplied: false };
  if (explicit === 'applied' || explicit === 'completed') return { outcome: 'applied', mayHaveApplied: true };
  if (r.ok === true || r.success === true) return { outcome: 'applied', mayHaveApplied: true };
  if (['invalid', 'bad_url', 'not_configured', 'not_registered', 'conflict',
    'session_required', 'session_invalid', 'action_scope_denied', 'no_selection'].includes(String(r.reason || r.code || '').toLowerCase())) {
    return { outcome: 'not_applied', mayHaveApplied: false };
  }
  const uncertain = r.mayHaveApplied === true || ['timeout', 'network', 'upstream_timeout', 'bad_response', 'too_large', 'unknown', 'processing']
    .includes(String(r.reason || explicit).toLowerCase());
  return uncertain
    ? { outcome: 'unknown', mayHaveApplied: true }
    : { outcome: 'not_applied', mayHaveApplied: false };
}

export function operationResult(response, operation, opts = {}) {
  const result = classifyWriteOutcome(response, opts);
  const id = String(response?.operationId || response?.operation_id || response?.operation?.id || operation?.id || '');
  if (id) finishOperation(id, {
    state: result.outcome === 'unknown' ? (response?.operation?.state || 'unknown') : result.outcome,
    outcome: result.outcome,
    mayHaveApplied: result.mayHaveApplied,
    error: String(response?.error || '').slice(0, 240)
  });
  return { ...result, operationId: id };
}

export function uncertainWriteText(operationId = '') {
  return `Google 後端逾時／斷線，結果暫時係「未知」：可能未寫，亦可能已經寫入。`
    + `${operationId ? ` 操作編號：${operationId}。` : ''}`
    + '系統唔會自動重送，避免重複；請先用「查狀態／重新讀取核對」。';
}
