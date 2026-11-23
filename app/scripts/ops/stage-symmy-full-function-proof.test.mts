import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Redacted } from 'effect';

import {
  AKROS_STAGE_PROOF_INPUT,
  assertAcceptedEffects,
  assertNativeApplied,
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
  symmyNativeCategoryPayload,
  symmyNativeProductPayload,
  symmyNativeMediaPayload,
  symmyOwnerReadEnvelope,
} from './stage-symmy-full-function-proof.mts';
import { Schema } from 'effect';
import {
  SymmyDemoCategoriesBatchRequestSchema,
  SymmyDemoProductsBatchRequestSchema,
  SymmyDemoMediaUploadRequestSchema,
} from '../../apps/shell-super-app/api/symmy/demo-catalog-contract.ts';

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

test('full proof rejects an unsafe origin before any HTTP request or fixture creation', async () => {
  const config = readSymmyProofConfig({ SYMMY_API_KEY: 'not-a-live-key' });
  await assert.rejects(
    proveSymmyFullFunction({ ...config, origin: 'http://example.invalid' }),
    /FAIL configuration:input-contract/u,
  );
});

test('native category/product/image builders satisfy the actual public request schemas', () => {
  const names = makeSymmyProofNames();
  const strict = { onExcessProperty: 'error' } satisfies SchemaAST.ParseOptions;
  Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema, strict)(symmyNativeCategoryPayload(names, 4));
  Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema, strict)(symmyNativeProductPayload(names, 5));
  const image = Schema.decodeUnknownSync(SymmyDemoMediaUploadRequestSchema, strict)(
    symmyNativeMediaPayload(names, 'native-product-from-write-response', 6),
  );
  assert.equal(image.image.filename, `${names.image}.png`);
  assert.equal(Buffer.from(image.image.full.contentBase64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('native APPLIED proof binds exact tenant, company, item and advancing revision, not HTTP 200 alone', () => {
  const scope = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    legalEntityId: '22222222-2222-4222-8222-222222222222',
    previousRevision: 4,
  };
  const body = {
    tenantId: scope.tenantId, legalEntityId: scope.legalEntityId, ownerModuleId: 'demo.merchandise',
    revision: 5, items: [{ entityId: 'native-product', index: 0, outcome: 'APPLIED', revision: 5 }],
  };
  assert.equal(assertNativeApplied(body, scope, 'category-import').item.entityId, 'native-product');
  for (const invalid of [
    { ...body, legalEntityId: scope.tenantId }, { ...body, tenantId: scope.legalEntityId },
    { ...body, revision: 4 }, { ...body, items: [] },
    { ...body, items: [{ ...body.items[0], outcome: 'QUEUED' }] },
    { ...body, items: [{ ...body.items[0], revision: 6 }] },
  ]) {
    assert.throws(() => assertNativeApplied(invalid, scope, 'category-import'), /FAIL category-import:/u);
  }
});

test('owner relay uses documented read bodies and preserves required versus forbidden company scope', () => {
  const company = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(symmyOwnerReadEnvelope('catalog/sku-lookup', { code: 'ERP-1' }, company, 'sku-readback'), {
    audience: 'catalog', legalEntityId: company, readName: 'sku-lookup', query: { code: 'ERP-1' },
  });
  const query = {
    customerConfigurationId: 'akros', externalScope: 'akros', namespace: 'akros-erp',
    issuer: { backendKind: 'external_business_system', backendId: 'akros-erp' },
    itemKey: 'NEW-ERP-ITEM', locationKey: 'AKROS-SKLAD-1',
  };
  const stock = symmyOwnerReadEnvelope('inventory/source-stock-position-resolution', query, company, 'stock-readback');
  assert.equal('legalEntityId' in stock, false);
  assert.equal(stock.readName, 'source-stock-position-resolution');
  assert.throws(() => symmyOwnerReadEnvelope(
    'catalog/sku-lookup', { code: 'ERP-1', operation: 'WRITE' }, company, 'sku-readback',
  ), /input-contract/u);
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
