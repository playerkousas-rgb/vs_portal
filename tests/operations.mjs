import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key)
};
globalThis.location = { protocol: 'https:', hostname: 'portal.example' };

const ops = await import('../assets/js/lib/operations.js');
const gateway = await import('../assets/js/lib/gateway.js');

const id = ops.newOperationId('saveTables');
assert.equal(ops.isOperationId(id), true);
const started = ops.beginOperation('saveTables', { operationId: id, unit: '0082' });
assert.equal(started.outcome, 'unknown');
assert.equal(ops.pendingOperations().some(x => x.id === id), true);
ops.finishOperation(id, { state: 'applied', outcome: 'applied' });
assert.equal(ops.pendingOperations().some(x => x.id === id), false);

assert.deepEqual(ops.classifyWriteOutcome({}, { sent: false }), { outcome: 'not_sent', mayHaveApplied: false });
assert.deepEqual(ops.classifyWriteOutcome({ ok: true }), { outcome: 'applied', mayHaveApplied: true });
assert.deepEqual(ops.classifyWriteOutcome({ ok: false, reason: 'conflict' }), { outcome: 'not_applied', mayHaveApplied: false });
assert.deepEqual(ops.classifyWriteOutcome({ ok: false, reason: 'timeout' }), { outcome: 'unknown', mayHaveApplied: true });
assert.deepEqual(ops.classifyWriteOutcome({ ok: true, outcome: 'unknown' }), { outcome: 'unknown', mayHaveApplied: true });
assert.deepEqual(ops.classifyWriteOutcome({ success: true, operation: { outcome: 'not_applied' } }), { outcome: 'not_applied', mayHaveApplied: false });
assert.match(ops.uncertainWriteText('op:test:123456789'), /唔會自動重送/);

let sentBody = null;
globalThis.fetch = async (_url, init) => {
  sentBody = JSON.parse(init.body);
  return new Response(JSON.stringify({ success: true, ok: true, version: 'v2',
    operationId: sentBody.operationId,
    operation: { id: sentBody.operationId, state: 'applied', outcome: 'applied' }, outcome: 'applied' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const applied = await gateway.postBackend({ action: 'saveTables', tables: { members: [] } }, { unit: '0082' });
assert.equal(applied.ok, true);
assert.equal(applied.outcome, 'applied');
assert.equal(applied.operationId, sentBody.operationId);
assert.equal(sentBody.operation_id, sentBody.operationId);

// Explicit durable outcomes are authoritative over HTTP/business envelopes.
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return new Response(JSON.stringify({ success: true, ok: true, outcome: 'unknown',
    operationId: body.operationId, operation: { id: body.operationId, state: 'unknown', outcome: 'unknown' } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const explicitUnknown = await gateway.postBackend({ action: 'saveTables', tables: { members: [] } }, { unit: '0082' });
assert.equal(explicitUnknown.ok, false);
assert.equal(explicitUnknown.outcome, 'unknown');

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return new Response(JSON.stringify({ success: false, ok: false, outcome: 'applied',
    operationId: body.operationId, operation: { id: body.operationId, state: 'applied', outcome: 'applied' } }),
  { status: 502, headers: { 'Content-Type': 'application/json' } });
};
const explicitApplied = await gateway.postBackend({ action: 'saveTables', tables: { members: [] } }, { unit: '0082' });
assert.equal(explicitApplied.ok, true);
assert.equal(explicitApplied.outcome, 'applied');

// A transport failure after fetch starts is unknown, never a claimed failure and never retried.
let calls = 0;
globalThis.fetch = async () => { calls++; throw new TypeError('network down'); };
const unknown = await gateway.postBackend({ action: 'saveTables', tables: { members: [{ id: 'm1' }] } }, { unit: '0082' });
assert.equal(calls, 1);
assert.equal(unknown.ok, false);
assert.equal(unknown.outcome, 'unknown');
assert.equal(unknown.mayHaveApplied, true);
assert.ok(unknown.operationId);

// A proxy HTML error can happen after it sent upstream. It is unknown and must
// never fall through to the direct URL (which would duplicate the write).
globalThis.location = { protocol: 'https:', hostname: 'portal.example' };
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return new Response('<html><body>Bad Gateway</body></html>',
    { status: 502, headers: { 'Content-Type': 'text/html' } });
};
const htmlUnknown = await gateway.postBackend({ action: 'saveTables', tables: { members: [{ id: 'm2' }] } },
  { unit: '0082', execUrl: 'https://script.google.com/macros/s/AKfycbx1234567890/exec' });
assert.equal(calls, 1);
assert.equal(htmlUnknown.via, 'proxy');
assert.equal(htmlUnknown.outcome, 'unknown');
assert.equal(htmlUnknown.mayHaveApplied, true);

// Similar error wording from an upstream/backend response must not be mistaken
// for the proxy's own unknown-unit 404; doing so would resend the mutation.
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return new Response(JSON.stringify({ success: false, error: '找不到此旅團或後端網址未設定',
    reason: 'upstream_timeout', outcome: 'unknown', mayHaveApplied: true }),
  { status: 502, headers: { 'Content-Type': 'application/json' } });
};
const wordingUnknown = await gateway.postBackend({ action: 'saveTables', tables: { members: [{ id: 'm-wording' }] } },
  { unit: '0082', execUrl: 'https://script.google.com/macros/s/AKfycbx1234567890/exec' });
assert.equal(calls, 1);
assert.equal(wordingUnknown.via, 'proxy');
assert.equal(wordingUnknown.outcome, 'unknown');
assert.equal(wordingUnknown.mayHaveApplied, true);

// Missing proxy never falls back to a browser-selected endpoint, even on 404.
calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  assert.equal(String(url), 'api/proxy');
  return new Response('not found', { status: 404 });
};
const noFallback = await gateway.postBackend({ action: 'saveTables', tables: { members: [{ id: 'm3' }] } },
  { unit: '0082', execUrl: 'https://script.google.com/macros/s/AKfycbx1234567890/exec', apiKey: 'secret', preferDirect: true });
assert.equal(calls, 1);
assert.equal(noFallback.via, 'none');
assert.equal(noFallback.outcome, 'not_sent');

// Client-provided URLs and keys never leave the browser in the proxy payload.
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'api/proxy');
  const body = JSON.parse(init.body);
  for (const key of ['apiKey', 'apikey', 'backend', 'gasUrl']) assert.equal(key in body, false);
  return new Response(JSON.stringify({ ok: false, reason: 'not_registered', error: 'unknown unit' }), { status: 404 });
};
const unregistered = await gateway.postBackend({ action: 'loadDb', apiKey: 'secret', apikey: 'secret', backend: 'evil', gasUrl: 'evil' },
  { unit: '0082', execUrl: 'https://example.org/exec', preferDirect: true });
assert.equal(unregistered.reason, 'not_registered');
assert.equal(unregistered.via, 'proxy');
assert.equal(gateway.beFromQuery('?be=https://example.org/exec'), '');

// With no proxy and no valid direct endpoint, the backend request was never sent.
globalThis.location = { protocol: 'file:', hostname: '' };
const notSent = await gateway.postBackend({ action: 'saveDb', db: {} }, { unit: '0082' });
assert.equal(notSent.via, 'none');
assert.equal(notSent.outcome, 'not_sent');
assert.equal(notSent.mayHaveApplied, false);

console.log('✓ operation ID / timeout outcome tests passed');
