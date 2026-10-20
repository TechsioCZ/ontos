// Isolated regression proof: no live service, secrets or writes. Run with Node's TypeScript support.
import assert from 'node:assert/strict';
import { readRecords, OntosError } from '../server/ontos.ts';

process.env.ONTOS_STOREFRONT_API_KEY = 'isolated-retry-proof';
process.env.ONTOS_SHELL_URL = 'http://isolated.invalid';
process.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL = 'http://isolated.invalid/active';
const revision = 'a'.repeat(64);
let assertions = 0;
let reads = 0;
let mode = 'recover';
const original = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/active')) return Response.json({ composition: { revision } });
  if (String(url).endsWith('/gateway-context')) {
    assertions += 1;
    return Response.json({ apiBaseUrl: '/merchandise-api', compositionRevision: revision, token: `single-use-${assertions}` });
  }
  reads += 1;
  if (mode === 'forbidden') return Response.json({ code: 'forbidden' }, { status: 403 });
  if (mode === 'down' || reads < 3) return Response.json({ code: 'unavailable' }, { status: reads === 1 ? 502 : 503 });
  return Response.json({ products: [{ id: 'real-owner-response' }] });
};
try {
  const result = await readRecords('merchandise', 'records', { view: { storefront: true } });
  assert.equal(result.products[0].id, 'real-owner-response');
  assert.equal(reads, 3);
  assert.equal(assertions, 3, 'every retry gets a new single-use assertion');
  mode = 'down';
  reads = 0;
  await assert.rejects(() => readRecords('merchandise', 'records', {}), (error) => error instanceof OntosError && error.status === 503);
  assert.equal(reads, 3, 'persistent failure stops after three attempts');
  mode = 'forbidden';
  reads = 0;
  await assert.rejects(() => readRecords('merchandise', 'records', {}), (error) => error instanceof OntosError && error.status === 403);
  assert.equal(reads, 1, 'permission denial is not retried');
  console.log('PASS transient 502/503 recovery; fresh assertions; bounded retries; no retry on forbidden');
} finally {
  globalThis.fetch = original;
}
