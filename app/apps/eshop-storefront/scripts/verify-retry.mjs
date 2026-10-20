// Isolated regression proof: no live service, real credential or writes. Node with TS support.
import assert from 'node:assert/strict';
import { readRecords, callAction, OntosError } from '../server/ontos.ts';

process.env.ONTOS_STOREFRONT_API_KEY = 'isolated-retry-proof';
process.env.ONTOS_SHELL_URL = 'http://isolated.invalid';
process.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL = 'http://isolated.invalid/active';
let revision = 'a'.repeat(64);
let assertions = 0;
let reads = 0;
let discovery = 0;
let mode;
const tokens = new Set();
const original = globalThis.fetch;
// AbortSignal.timeout intentionally uses an unref'ed timer; keep this standalone proof alive.
const lifetime = setInterval(() => {}, 1000);
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/active')) {
    discovery += 1;
    return Response.json({ composition: { revision } });
  }
  if (String(url).endsWith('/gateway-context')) {
    assertions += 1;
    if (mode === 'gateway-forbidden' || mode === 'gateway-unauthorized') {
      return Response.json({ code: 'rejected' }, { status: mode === 'gateway-forbidden' ? 403 : 401 });
    }
    assert.equal(JSON.parse(init.body).compositionRevision, revision, 'assertion uses active composition');
    return Response.json({ apiBaseUrl: '/merchandise-api', compositionRevision: revision, token: `single-use-${assertions}` });
  }
  reads += 1;
  assert(!tokens.has(init.headers.authorization), 'single-use assertion never reused');
  tokens.add(init.headers.authorization);
  assert.equal(init.headers['x-ontos-composition-revision'], revision);
  if (mode === 'forbidden') return Response.json({ code: 'forbidden' }, { status: 403 });
  if (mode === 'invalid') return Response.json({ code: 'invalid' }, { status: 422 });
  if (mode === 'unauthorized' || (mode === 'renew' && reads === 1)) return Response.json({}, { status: 401 });
  if (mode === 'hung') {
    await new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  }
  if (mode === 'published' && reads === 1) {
    revision = 'b'.repeat(64);
    return Response.json({ code: 'unavailable' }, { status: 503 });
  }
  // Five failed attempts exceed the previous three-attempt / 1.8 s window.
  if (mode === 'down' || mode === 'action' || (mode === 'recover' && reads < 6)) {
    return Response.json({ code: 'unavailable' }, { status: [502, 503, 504][(reads - 1) % 3] });
  }
  return Response.json({ products: [{ id: 'owner-response', priceMinor: 32100 }] });
};
const reset = (next) => { mode = next; reads = 0; };
const rejected = (status) => (error) => error instanceof OntosError && error.status === status;
try {
  reset('recover');
  let count = assertions;
  const started = performance.now();
  const result = await readRecords('merchandise', 'records', { view: { storefront: true } });
  assert.equal(result.products[0].priceMinor, 32100);
  assert.equal(reads, 6);
  assert.equal(assertions - count, 6);
  assert(performance.now() - started >= 7400, 'recovery covers a >7-second restart');
  console.log('PASS >7-second 502/503/504 recovery; fresh single-use assertions; real returned price');

  reset('published');
  count = discovery;
  await readRecords('merchandise', 'records', {});
  assert.equal(reads, 2);
  assert(discovery > count, 'transient 503 rediscovers composition without waiting for 409');
  console.log('PASS composition rediscovered after transient read failure');

  reset('renew');
  await readRecords('merchandise', 'records', {});
  assert.equal(reads, 2);
  reset('unauthorized');
  await assert.rejects(() => readRecords('merchandise', 'records', {}), rejected(401));
  assert.equal(reads, 2, 'rejected read assertion is renewed only once');
  console.log('PASS rejected read assertion renewed once, persistent rejection stays blocked');

  for (const [next, status] of [['forbidden', 403], ['invalid', 422], ['gateway-forbidden', 403], ['gateway-unauthorized', 401]]) {
    reset(next);
    count = assertions;
    await assert.rejects(() => readRecords('merchandise', 'records', {}), rejected(status));
    assert.equal(assertions - count, 1, `${next}: no retry`);
    assert.equal(reads, next.startsWith('gateway-') ? 0 : 1);
  }
  console.log('PASS no retry on permission denial, invalid input or rejected gateway credentials');

  reset('down');
  await assert.rejects(() => readRecords('merchandise', 'records', {}), rejected(503));
  assert.equal(reads, 8, 'persistent fast failure stops after eight attempts');
  console.log('PASS persistent failure remains bounded, never returns stale data');

  reset('hung');
  const hungAt = performance.now();
  await assert.rejects(() => readRecords('merchandise', 'records', {}), rejected(503));
  assert.equal(reads, 1, 'deadline stops a hung read without starting another');
  assert(performance.now() - hungAt < 22_000, 'one 20 s deadline bounds the entire operation');
  console.log('PASS hung upstream aborted at the shared 20-second deadline');

  reset('action');
  await assert.rejects(() => callAction('merchandise', 'apply-command', {}, 'isolated-key'), rejected(502));
  assert.equal(reads, 1, 'Actions are not automatically retried');
  console.log('PASS no automatic Action retry');
} finally {
  globalThis.fetch = original;
  clearInterval(lifetime);
}
