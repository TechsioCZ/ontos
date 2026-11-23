import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Redacted } from 'effect';

import {
  AKROS_STAGE_PROOF_INPUT,
  assertAcceptedEffects,
  assertOrderSnapshots,
  assertRecordReadback,
  assertReplayIdentity,
  createSymmyProofClient,
  decimalEqual,
  makeSymmyProofNames,
  proveSymmyFullFunction,
  readSymmyProofConfig,
  SymmyProofFailure,
  symmyProofFailureLine,
} from './stage-symmy-full-function-proof.mts';

const itemId = '11111111-1111-4111-8111-111111111111';
const effectId = '22222222-2222-4222-8222-222222222222';
const expected = { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.catalog': 1 } };
const outcome = (status: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  items: [{
    effects: [{ effectId, owner: 'commerce.catalog', status, ...extra }],
    itemId,
    outcome: 'accepted',
  }],
});

test('202 admission alone, empty items, wrong owners and missing effects never prove acceptance', () => {
  for (const body of [
    { jobId: itemId, status: 'queued' }, { items: [] },
    { items: [{ effects: [], itemId, outcome: 'accepted' }] },
    outcome('accepted_change', { owner: 'commerce.pricing' }),
  ]) {
    assert.throws(() => assertAcceptedEffects(body, expected, 'product-import'), SymmyProofFailure);
  }
  assert.throws(() => assertAcceptedEffects(outcome('accepted_change'), {
    ...expected, effectsAtLeast: 2,
  }, 'product-import'), /effect-count/u);
});

test('every refused or unsettled effect fails even if the item claims accepted', () => {
  for (const status of [
    'waiting', 'executing', 'indeterminate', 'unsupported', 'stale', 'unresolved',
    'ambiguous', 'denied', 'conflict', 'unavailable', 'invalid',
  ]) {
    assert.throws(() => assertAcceptedEffects(outcome(status), expected, 'product-import'), /effect-outcome/u);
  }
});

test('duplicate is accepted only with a verified accepted original status', () => {
  for (const originalStatus of ['accepted_change', 'accepted_no_change']) {
    assertAcceptedEffects(outcome('duplicate', { originalStatus }), expected, 'product-import');
  }
  for (const originalStatus of [undefined, 'denied', 'indeterminate']) {
    assert.throws(() => assertAcceptedEffects(outcome('duplicate', { originalStatus }), expected, 'product-import'));
  }
});

test('replay preserves item/effect identities, not just a successful HTTP response', () => {
  const original = assertAcceptedEffects(outcome('accepted_change'), expected, 'product-import');
  const replay = assertAcceptedEffects(
    outcome('duplicate', { originalStatus: 'accepted_change' }), expected, 'product-replay',
  );
  assertReplayIdentity(original, replay, 'product-replay');
  const changed = assertAcceptedEffects(outcome('accepted_change', { effectId: itemId }), expected, 'product-replay');
  assert.throws(() => assertReplayIdentity(original, changed, 'product-replay'), /replay-identity/u);
});

test('configuration keeps the environment key Redacted and uses only published stage refs', () => {
  const secret = 'not-a-live-key-never-log-this';
  const config = readSymmyProofConfig({ SYMMY_API_KEY: secret });
  assert.equal(Redacted.value(config.apiKey), secret);
  assert.equal(String(config.apiKey).includes(secret), false);
  assert.deepEqual(config.input, AKROS_STAGE_PROOF_INPUT);
  assert.equal(typeof createSymmyProofClient(config).settle, 'function');
  assert.throws(() => createSymmyProofClient({ ...config, timeoutMs: 0 }), /input-contract/u);
  for (const origin of ['http://example.test', 'https://example.test/path', `https://${secret}@example.test`]) {
    assert.throws(
      () => readSymmyProofConfig({ SYMMY_API_KEY: secret, SYMMY_PROOF_ORIGIN: origin }),
      (error: unknown) => !symmyProofFailureLine(error).includes(secret),
    );
  }
});

test('all entity names share a fresh bounded ERP/business-code-safe namespace', () => {
  const first = makeSymmyProofNames();
  const second = makeSymmyProofNames();
  assert.notEqual(first.prefix, second.prefix);
  for (const value of Object.values(first)) {
    assert.match(value, /^[A-Z][A-Z0-9_]*$/u);
    assert.ok(value.startsWith(first.prefix));
    assert.ok(value.length <= 64);
  }
});

test('decimal equality stays exact beyond Number precision and rejects malformed values', () => {
  assert.equal(decimalEqual('123.450', '123.45'), true);
  assert.equal(decimalEqual('0.000', '0'), true);
  assert.equal(decimalEqual('9007199254740993', '9007199254740992'), false);
  for (const value of ['01', '-1', '1e2', '', NaN, 123.45, null]) {
    assert.equal(decimalEqual(value, value), false);
  }
});

test('unexpected errors and schema failures never echo secret or customer input', () => {
  const sensitive = 'sensitive-customer@example.invalid secret-token';
  assert.equal(symmyProofFailureLine(new Error(sensitive)), 'FAIL full-proof:unexpected');
  try {
    assertAcceptedEffects({ items: sensitive }, expected, 'customer-import');
    assert.fail('malformed response passed');
  } catch (error) {
    assert.equal(symmyProofFailureLine(error), 'FAIL customer-import:schema');
  }
});

test('full proof fails closed on missing endpoint wiring before creating an HTTP client or fixtures', async () => {
  const config = readSymmyProofConfig({ SYMMY_API_KEY: 'not-a-live-key' });
  await assert.rejects(
    Promise.resolve(Reflect.apply(proveSymmyFullFunction, undefined, [config, undefined])),
    /FAIL configuration:missing-wiring/u,
  );
});

test('readback requires exactly one record matching both identity and value', () => {
  const contract = {
    recordsPointer: '/rows',
    fields: { itemKey: '/identity/key', amount: '/quantity/amount' },
  };
  const expectedRow = { itemKey: 'SCOPED_VARIANT', amount: '17' };
  const row = { identity: { key: 'SCOPED_VARIANT' }, quantity: { amount: '17.00' } };
  assertRecordReadback({ rows: [row] }, contract, expectedRow, 'stock-readback', ['amount']);
  for (const rows of [
    [], [row, row],
    [{ ...row, identity: { key: 'ANOTHER_VARIANT' } }],
    [{ ...row, quantity: { amount: '16' } }],
    [{ identity: row.identity }],
  ]) {
    assert.throws(() => assertRecordReadback(
      { rows }, contract, expectedRow, 'stock-readback', ['amount'],
    ), /FAIL stock-readback:/u);
  }
});

test('JSON pointers decode escaped field names without traversing object prototypes', () => {
  assertRecordReadback({ 'a/b': { '~amount': '17' } }, {
    recordsPointer: '', fields: { amount: '/a~1b/~0amount' },
  }, { amount: '17' }, 'stock-readback');
  for (const pointer of ['/toString', '/bad~2escape', 'relative']) {
    assert.throws(() => assertRecordReadback(
      {}, { recordsPointer: '', fields: { amount: pointer } }, { amount: '17' }, 'stock-readback',
    ));
  }
});

test('order export needs real nonempty persisted orders, lines and consistent monetary snapshots', () => {
  const order = {
    id: 'existing-order', number: 'ORDER-1', currencyCode: 'CZK',
    totalMinor: 121, totalVatMinor: 21, totalNetMinor: 100,
    lines: [{ productId: 'existing-product', sku: 'ERP-1', unitPriceMinor: 100,
      quantity: 1, totalMinor: 121, totalVatMinor: 21 }],
    contact: { email: 'never-log@example.invalid' },
  };
  const parsed = assertOrderSnapshots([order]);
  assert.equal(parsed.some((row) => 'contact' in row), false);
  for (const body of [
    [], [order, order], [{ ...order, lines: [] }],
    [{ ...order, totalNetMinor: 99 }],
    [{ ...order, lines: [{ ...order.lines[0], quantity: 0 }] }],
    [{ ...order, lines: [{ ...order.lines[0], productId: '' }] }],
  ]) {
    assert.throws(() => assertOrderSnapshots(body), /FAIL order-export:/u);
  }
});
