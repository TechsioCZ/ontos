import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Redacted, Schema } from 'effect';
import type { SchemaAST } from 'effect';

import {
  AKROS_STAGE_PROOF_INPUT,
  assertAcceptedEffects,
  assertCurrentListPrice,
  assertNativeApplied,
  assertOrderSnapshots,
  assertRecordReadback,
  assertReplayIdentity,
  createSymmyProofClient,
  decimalEqual,
  makeSymmyProofNames,
  parseSymmyOperatorCookieJar,
  proveCustomers,
  proveSymmyFullFunction,
  proveSymmyProduct,
  proveSymmyProductStockList,
  readSymmyProofConfig,
  SymmyProofFailure,
  symmyProofFailureLine,
  symmyNativeCategoryPayload,
  symmyNativeProductPayload,
  symmyNativeMediaPayload,
  symmyOwnerReadEnvelope,
  sanitizeSymmyFailureBody,
  runSymmyProofLanes,
  symmyNativeResultLine,
} from './stage-symmy-full-function-proof.mts';
import type { SymmyProofClient } from './stage-symmy-full-function-proof.mts';
import { SymmyPriceListsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/price-lists-batch-upsert-request-contract.ts';
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

test('one product job item carries all owner effects and retains its identity on replay', async (t) => {
  const config = { ...readSymmyProofConfig({ SYMMY_API_KEY: 'synthetic-key' }), origin: 'https://proof.invalid' };
  const effects = Array.from({ length: 10 }, (_, index) => ({
    effectId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    owner: index === 8 ? 'commerce.pricing' : index === 9 ? 'commerce.inventory' : 'commerce.catalog',
    status: 'accepted_change',
  }));
  const items = [{ itemId, outcome: 'accepted', effects }];
  let pageReads = 0;
  let writes = 0;
  let prefix = '';
  const ref = (resourceId: string, resourceType: string) => ({
    moduleId: 'commerce.catalog', resourceId, resourceType, tenantId: config.input.unitRef.tenantId,
  });
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (url.pathname === '/api/symmy/v1/admin/products') {
      prefix = url.searchParams.get('q') ?? '';
      if (pageReads++ === 0) return Response.json({ count: 0, products: [] });
      return Response.json({ count: 1, products: [{
        id: itemId, sourceRecordId: `product:erpId:${prefix}_PRODUCT`,
        product: {
          name: `${prefix}_PRODUCT`, productRef: ref(itemId, 'commerce.catalog.product'),
          variants: [{ variantId: effectId, variantRef: ref(effectId, 'commerce.catalog.variant') }],
        },
        variantSources: [{ sourceRecordId: `variant:variantId:${prefix}_VARIANT`, variantId: effectId }],
      }] });
    }
    if (url.pathname === '/api/symmy/v1/products/batch') {
      assert.equal(init.method, 'POST');
      writes++;
      return writes === 1
        ? Response.json({ jobId: itemId, status: 'queued' }, { status: 202 })
        : Response.json({ items });
    }
    if (url.pathname === `/api/symmy/v1/jobs/${itemId}`) {
      return Response.json({ jobId: itemId, status: 'completed_all', items });
    }
    throw new Error('Unexpected product proof request');
  });
  const result = await proveSymmyProduct(config);
  assert.equal(result.names.prefix, prefix);
  assert.equal(writes, 2);
  assert.equal(pageReads, 3);
});

test('a fresh price-list meaning becomes current before readback', async () => {
  const config = readSymmyProofConfig({ SYMMY_API_KEY: 'synthetic-key' });
  let productReads = 0;
  let prefix = '';
  const events: string[] = [];
  const result = (owners: readonly string[]) => ({ status: 200, body: { items: [{
    itemId, outcome: 'accepted',
    effects: owners.map((owner, index) => ({
      effectId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      owner, status: 'accepted_change',
    })),
    itemKey: `${prefix}_VARIANT`, locationKey: config.input.locationKey,
  }] } });
  const ref = (resourceId: string, resourceType: string) => ({
    moduleId: 'commerce.catalog', resourceId, resourceType, tenantId: config.input.unitRef.tenantId,
  });
  const client: SymmyProofClient = {
    async read(path) {
      if (path.startsWith('/api/symmy/v1/price-lists?')) {
        events.push('read-list');
        throw new Error('Reached list read');
      }
      prefix = new URL(path, config.origin).searchParams.get('q') ?? '';
      if (productReads++ === 0) return { count: 0, products: [] };
      return { count: 1, products: [{
        id: itemId, sourceRecordId: `product:erpId:${prefix}_PRODUCT`,
        product: {
          name: `${prefix}_PRODUCT`, productRef: ref(itemId, 'commerce.catalog.product'),
          variants: [{ variantId: effectId, variantRef: ref(effectId, 'commerce.catalog.variant') }],
        },
        variantSources: [{ sourceRecordId: `variant:variantId:${prefix}_VARIANT`, variantId: effectId }],
      }] };
    },
    async write(path, body) {
      if (path.endsWith('/inventory/stock/batch')) return result(['commerce.inventory']);
      if (path.endsWith('/price-lists/batch-upsert')) {
        const request = Schema.decodeUnknownSync(SymmyPriceListsBatchRequestSchema)(body);
        const [list] = request.priceLists;
        assert.ok(list !== undefined && list.purpose.includes(prefix));
        return result(['pricing.price-group-catalog']);
      }
      return result(['commerce.catalog', 'commerce.catalog', 'commerce.pricing']);
    },
    async settle(response, expected, boundary) {
      return assertAcceptedEffects(response.body, expected, boundary);
    },
    async waitUntil(instant, boundary) {
      assert.equal(boundary, 'price-list-readback');
      assert.ok(Date.parse(instant) > Date.now());
      events.push('wait-list-start');
    },
    async ownerRead() { throw new Error('Unexpected owner read'); },
  };
  await assert.rejects(proveSymmyProductStockList(config, client), /Reached list read/u);
  assert.deepEqual(events, ['wait-list-start', 'read-list']);
});

test('two customer items retain all eleven owner effects and replay identities', async () => {
  const config = readSymmyProofConfig({ SYMMY_API_KEY: 'synthetic-key' });
  const names = makeSymmyProofNames();
  const ref = (resourceId: string) => ({
    moduleId: 'party.registry', resourceType: 'party', resourceId,
    tenantId: config.input.unitRef.tenantId,
  });
  const effects = Array.from({ length: 11 }, (_, index) => ({
    effectId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    owner: index < 7 ? 'party.registry' : 'commerce.customer-context',
    status: 'accepted_change',
  }));
  const items = [
    { itemId, outcome: 'accepted', effects: effects.slice(0, 6) },
    { itemId: effectId, outcome: 'accepted', effects: effects.slice(6) },
  ];
  const page = { count: 2, customers: [
    { kind: 'ORGANIZATION', id: names.organization, resourceId: itemId },
    { kind: 'PERSON', id: names.person, resourceId: effectId },
  ].map(({ kind, id, resourceId }) => ({
    sourceRecordId: id, partyRef: ref(resourceId),
    profile: {
      profileRef: { ...ref(resourceId), kind: kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY' },
      subject: kind === 'PERSON'
        ? { kind: 'RETAIL', partyRef: ref(resourceId), sellingLegalEntityRef: ref(itemId) }
        : { kind: 'COUNTERPARTY', counterpartyRef: ref(resourceId) },
    },
    party: {
      outcome: 'AVAILABLE', partyType: kind,
      businessName: kind === 'ORGANIZATION' ? names.organization : null,
      firstName: kind === 'PERSON' ? names.prefix : null,
      lastName: kind === 'PERSON' ? 'Acceptance' : null,
      contactPoints: [
        { type: 'EMAIL', normalizedValue: `${id.toLowerCase()}@example.invalid` },
        { type: 'PHONE', normalizedValue: '+12025550123' },
      ],
    },
  })) };
  let writes = 0;
  const client: SymmyProofClient = {
    async read() { return page; },
    async write() { writes++; return { status: 200, body: { items } }; },
    async settle(response, expected, boundary) {
      const accepted = assertAcceptedEffects(response.body, expected, boundary);
      assert.throws(() => assertAcceptedEffects({ items: [items[0]] }, expected, boundary), /item-count/u);
      assert.throws(() => assertAcceptedEffects({ items: [
        { ...items[0], effects: effects.slice(0, 5) }, items[1],
      ] }, expected, boundary), /effect-count/u);
      assert.throws(() => assertAcceptedEffects({ items: items.map((item) => ({
        ...item, effects: item.effects.map((effect) => ({ ...effect, status: 'denied' })),
      })) }, expected, boundary), /effect-outcome/u);
      return accepted;
    },
    async waitUntil() { throw new Error('Unexpected wait'); },
    async ownerRead() { throw new Error('Unexpected owner read'); },
  };
  const result = await proveCustomers(config, client, names);
  assert.equal(result.customers.length, 2);
  assert.equal(writes, 2);
});

test('configuration keeps the environment key Redacted and uses only published stage refs', () => {
  const secret = 'not-a-live-key-never-log-this';
  const config = readSymmyProofConfig({ SYMMY_API_KEY: secret });
  assert.equal(config.origin, 'https://ontos-stage.web-revolution.cz');
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

test('list-price readback accepts canonical decimal basis but rejects a different quantity or unit', () => {
  const { input } = readSymmyProofConfig({ SYMMY_API_KEY: 'synthetic-key' });
  const ref = { ...input.unitRef, resourceId: itemId };
  const variant = { ...ref, resourceId: effectId };
  const proof = {
    names: makeSymmyProofNames(), productRef: ref, variantRef: variant,
    baseAmount: '1', stockAmount: '1', listAmount: '19.5', effectiveFrom: '2026-11-23T12:00:00.000Z',
  };
  const value = (quantity: string, unitRef = input.unitRef) => ({
    outcome: 'PRICE_DEFINITION_CURRENT',
    definition: {
      priceRef: ref,
      identityKey: {
        catalogSelection: { productRef: ref, variantRef: variant },
        commercialScope: input.commercialScope,
        priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: ref },
        unitBasis: { quantity, unitRef },
      },
      revision: {
        effectiveFrom: proof.effectiveFrom, monetaryAmount: { amount: '19.500000', currencyCode: input.currencyCode },
        revision: 1, revisionId: itemId,
      },
    },
  });
  assert.doesNotThrow(() => assertCurrentListPrice(value('1.000000'), proof, input, ref, proof.effectiveFrom));
  for (const invalid of [value('2.000000'), value('1', { ...input.unitRef, resourceId: effectId })]) {
    assert.throws(() => assertCurrentListPrice(invalid, proof, input, ref, proof.effectiveFrom), /readback/u);
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

test('operator owner-read plans use documented company-scoped reads, never a tenant-only source receiver', () => {
  const company = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(symmyOwnerReadEnvelope('catalog/sku-lookup', { code: 'ERP-1' }, company, 'sku-readback'), {
    audience: 'catalog', legalEntityId: company, readName: 'sku-lookup', query: { code: 'ERP-1' },
  });
  const query = {
    customerConfigurationId: 'akros',
    variantRefs: [{ ...AKROS_STAGE_PROOF_INPUT.unitRef, resourceType: 'commerce.catalog.variant' }],
  };
  const stock = symmyOwnerReadEnvelope('inventory/catalog-variant-on-hand-page', query, company, 'stock-readback');
  assert.equal(stock.legalEntityId, company);
  assert.equal(stock.readName, 'catalog-variant-on-hand-page');
  assert.throws(() => symmyOwnerReadEnvelope(
    'catalog/sku-lookup', { code: 'ERP-1', operation: 'WRITE' }, company, 'sku-readback',
  ), /input-contract/u);
});

test('serialized operator gateway token authorizes the actual owner read', async (t) => {
  const config = {
    ...readSymmyProofConfig({ SYMMY_API_KEY: 'synthetic-key' }),
    origin: 'https://proof.invalid',
    legalEntityId: itemId,
    operatorCookie: Redacted.make('synthetic-cookie'),
  };
  const base = '/shell-super-app-api/module-api/merchandise/test/merchandise-api';
  const revision = 'a'.repeat(64);
  const query = { view: { limit: 0, ordersLimit: 0, summary: true } };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    calls.push(input.pathname);
    switch (input.pathname) {
      case '/shell-super-app-api/auth/session':
        return Response.json({ state: 'authenticated', identity: {
          tenantId: config.input.unitRef.tenantId, legalEntityId: itemId,
        } });
      case '/shell-super-app-api/shell/composition':
        return Response.json({ state: 'available', compositionRevision: revision });
      case '/shell-super-app-api/auth/gateway-context':
        return Response.json({ apiBaseUrl: base, compositionRevision: revision, token: 'synthetic-assertion' });
      case `${base}/reads/records`: {
        const headers = new Headers(init.headers);
        assert.equal(headers.get('authorization'), 'Bearer synthetic-assertion');
        assert.equal(headers.get('x-ontos-composition-revision'), revision);
        assert.match(headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/u);
        assert.equal(headers.has('cookie') || headers.has('x-api-key'), false);
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), query);
        return Response.json({ revision: 7 });
      }
      default: throw new Error('Unexpected proof request');
    }
  });
  assert.deepEqual(await createSymmyProofClient(config).ownerRead('merchandise/records', query, 'category-readback'),
    { revision: 7 });
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1), `${base}/reads/records`);
});

test('full proof requires separate operator read authentication before any HTTP request', async () => {
  const config = readSymmyProofConfig({ SYMMY_API_KEY: 'not-a-live-key' });
  await assert.rejects(proveSymmyFullFunction(config), /FAIL configuration:read-auth-required/u);
});

test('Netscape operator jar parsing selects only live same-origin Shell cookies and keeps them Redacted', () => {
  const now = 1_700_000_000_000;
  const jar = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_ontos-stage-n1.web-revolution.cz\tFALSE\t/\tTRUE\t0\tsession\top-secret',
    '.web-revolution.cz\tTRUE\t/\tTRUE\t1800000000\tshared\tshared-secret',
    'unrelated.invalid\tFALSE\t/\tTRUE\t0\tforeign\tforeign-secret',
    'ontos-stage-n1.web-revolution.cz\tFALSE\t/private\tTRUE\t0\tprivate\tprivate-secret',
    'ontos-stage-n1.web-revolution.cz\tFALSE\t/\tTRUE\t1600000000\texpired\texpired-secret',
  ].join('\n');
  const parsed = parseSymmyOperatorCookieJar(jar, 'https://ontos-stage-n1.web-revolution.cz', now);
  assert.equal(Redacted.value(parsed), 'session=op-secret; shared=shared-secret');
  assert.equal(String(parsed).includes('op-secret'), false);
  assert.throws(() => parseSymmyOperatorCookieJar(
    'ontos-stage-n1.web-revolution.cz\tFALSE\t/\tTRUE\t0\tsession\tvalue;injected=secret',
    'https://ontos-stage-n1.web-revolution.cz', now,
  ), /FAIL configuration:input-contract/u);
  assert.throws(() => parseSymmyOperatorCookieJar('', 'https://ontos-stage-n1.web-revolution.cz', now),
    /read-auth-required/u);
});

test('HTTP failure diagnostics retain only closed contract metadata, never detail, token, cookie or customer values', () => {
  const credential = Redacted.make('test-api-key-do-not-log');
  const safe = sanitizeSymmyFailureBody({
    _tag: 'SymmyStockDependencyNotReadyProblem', status: 503,
    reason: 'ITEM_NOT_PROVISIONED', retryable: true,
    detail: 'customer@example.invalid test-api-key-do-not-log session=cookie-value',
    itemKey: 'private-erp-id', token: 'jwt-value',
  }, credential);
  assert.deepEqual(safe, {
    kind: 'problem', tag: 'SymmyStockDependencyNotReadyProblem', reason: 'ITEM_NOT_PROVISIONED', retryable: true,
  });
  const error = new SymmyProofFailure('stock-import', 'http-status', 503, safe);
  assert.match(symmyProofFailureLine(error), /^FAIL stock-import:http-status:503 body=/u);
  assert.deepEqual(error.safeBody, safe);
  for (const secret of ['customer@', 'test-api-key', 'cookie-value', 'private-erp-id', 'jwt-value']) {
    assert.equal(symmyProofFailureLine(error).includes(secret), false);
  }
  assert.deepEqual(sanitizeSymmyFailureBody({
    _tag: 'unrecognized-secret-tag', code: 'customer@example.invalid', detail: 'secret',
  }, credential), { kind: 'unrecognized-problem' });
  const collision = sanitizeSymmyFailureBody({
    _tag: 'SymmyUnavailableProblem', code: 'POLICY_NOT_FOUND',
  }, Redacted.make('POLICY_NOT_FOUND'));
  assert.equal(JSON.stringify(collision).includes('POLICY_NOT_FOUND'), false);
});

test('independent lanes start together and drain all work after an early failure, reporting only sanitized failures', async () => {
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const names = ['commerce', 'customers', 'native-catalog', 'orders'] satisfies readonly import('./stage-symmy-full-function-proof.mts').SymmyProofLaneName[];
  const started: string[] = [];
  const reports: string[] = [];
  let finished = false;
  const work = runSymmyProofLanes(names.map((name, index) => ({
    name, run: async () => {
      started.push(name);
      await gates[index]?.promise;
    },
  })), (line) => reports.push(line)).then(
    () => { finished = true; return undefined; },
    (error: unknown) => { finished = true; return error; },
  );
  assert.deepEqual(started, names);
  gates[0]?.reject(new Error('secret-token customer@example.invalid'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  for (const gate of gates.slice(1)) gate.resolve();
  const error = await work;
  assert.ok(error instanceof SymmyProofFailure);
  assert.equal(error.code, 'lane-failed');
  assert.deepEqual(error.safeBody, { kind: 'lanes', failed: ['commerce'] });
  assert.equal(reports.length, 4);
  assert.equal(reports.filter((line) => line.startsWith('PASS lane:')).length, 3);
  assert.ok(reports.includes('FAIL lane:commerce FAIL full-proof:unexpected'));
  assert.equal(reports.join('\n').includes('secret-token'), false);
  assert.equal(reports.join('\n').includes('customer@'), false);
});

test('synthetic storefront result exposes only the requested safe identifiers', () => {
  const result = {
    sku: 'SP_TEST_VARIANT', productId: 'product-123', slug: 'sp-test-product',
    categoryId: 'category:123', categorySlug: 'sp-test-category',
    imageId: '11111111-1111-4111-8111-111111111111',
    token: 'never-output-this',
  };
  const line = symmyNativeResultLine(result);
  assert.ok(line.startsWith('RESULT native-catalog '));
  assert.equal(line.includes('never-output-this'), false);
  assert.ok(line.includes('"productId":"product-123"'));
  assert.ok(line.includes('"categorySlug":"sp-test-category"'));
  assert.throws(() => symmyNativeResultLine({ ...result, productId: 'customer@example.invalid' }), /readback/u);
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
    pricesIncludeVat: false, totalMinor: 121, totalVatMinor: 21, totalNetMinor: 100,
    lines: [{ productId: 'existing-product', sku: 'ERP-1', unitPriceMinor: 100,
      quantity: 1, vatRate: 21, totalMinor: 121, totalVatMinor: 21 }],
    contact: { email: 'never-log@example.invalid' },
  };
  const parsed = assertOrderSnapshots([order]);
  assert.equal(parsed.some((row) => 'contact' in row), false);
  for (const body of [
    [], [order, order], [{ ...order, lines: [] }],
    [{ ...order, totalNetMinor: 99 }],
    [{ ...order, totalMinor: 999, totalNetMinor: 978 }],
    [{ ...order, lines: [{ ...order.lines[0], totalMinor: 1, totalVatMinor: 0 }] }],
    [{ ...order, lines: [{ ...order.lines[0], quantity: 0 }] }],
    [{ ...order, lines: [{ ...order.lines[0], productId: '' }] }],
  ]) {
    assert.throws(() => assertOrderSnapshots(body), /FAIL order-export:/u);
  }
});

test('order reconciliation handles fractional quantities, net or gross unit prices, and gross shipping', () => {
  for (const [pricesIncludeVat, lineGross, lineVat] of [[false, 184, 32], [true, 152, 26]] as const) {
    const line = { productId: 'p', sku: 'SKU', quantity: 1.5, unitPriceMinor: 101, vatRate: 21,
      totalMinor: lineGross, totalVatMinor: lineVat };
    const order = { id: 'o', number: 'OBJ', currencyCode: 'CZK', pricesIncludeVat, lines: [line],
      shipping: { method: 'PPL', label: 'PPL', priceMinor: 121, vatRate: 21 },
      totalMinor: lineGross + 121, totalVatMinor: lineVat + 21, totalNetMinor: lineGross - lineVat + 100 };
    assert.doesNotThrow(() => assertOrderSnapshots([order]));
    for (const wrong of [
      { ...order, pricesIncludeVat: !pricesIncludeVat },
      { ...order, lines: [{ ...line, totalVatMinor: lineVat - 1 }] },
      { ...order, shipping: { ...order.shipping, vatRate: 0 } },
      { ...order, shipping: undefined },
      { ...order, totalMinor: lineGross, totalVatMinor: lineVat, totalNetMinor: lineGross - lineVat },
    ]) assert.throws(() => assertOrderSnapshots([wrong]), /FAIL order-export:/u);
  }
});
