import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format } from 'node:util';

import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Predicate,
  Redacted,
  Result,
  Schema,
} from 'effect';
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
  proveOwnerAddresses,
  proveSymmyFullFunction,
  proveSymmyProduct,
  proveSymmyProductStockList,
  readSymmyProofConfig,
  SymmyProofFailure,
  symmyProofFailureLine,
  symmyNativeCategoryPayload,
  symmyCustomerGroupPayload,
  symmyNativeProductPayload,
  symmyNativeMediaPayload,
  symmyOwnerReadEnvelope,
  sanitizeSymmyFailureBody,
  runSymmyProofLanes,
  symmyNativeResultLine,
} from './stage-symmy-full-function-proof.mts';
import type {
  SymmyProofClient,
  SymmyFullProofContext,
  SymmyProofLaneName,
} from './stage-symmy-full-function-proof.mts';
import { SymmyCustomerGroupsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/customer-groups-batch-request-contract.ts';
import { SymmyPriceListsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/price-lists-batch-upsert-request-contract.ts';
import {
  SymmyDemoCategoriesBatchRequestSchema,
  SymmyDemoProductsBatchRequestSchema,
  SymmyDemoMediaUploadRequestSchema,
} from '../../apps/shell-super-app/api/symmy/demo-catalog-contract.ts';

await using runtime = ManagedRuntime.make(Layer.empty);
const expectFailure = <A, E>(program: Effect.Effect<A, E>, expected: assert.AssertPredicate) =>
  Effect.gen(function* expectProofFailure() {
    const exit = yield* Effect.exit(program);
    assert.ok(Exit.isFailure(exit), 'Expected the proof Effect to fail');
    assert.throws(() => {
      throw Cause.squash(exit.cause);
    }, expected);
  });
const CATALOG_REVISION_PATH = '/api/symmy/v1/catalog/revision';
const CATALOG_OWNER = 'commerce.catalog';
const PRICING_OWNER = 'commerce.pricing';
const PRODUCT_IMPORT = 'product-import';
const PRODUCT_REPLAY = 'product-replay';
const SYNTHETIC_KEY = 'synthetic-key';
const PROOF_ORIGIN = 'https://proof.invalid';
const CATALOG_VARIANT = 'commerce.catalog.variant';
const PARTY_OWNER = 'party.registry';
const CUSTOMER_OWNER = 'commerce.customer-context';
const STOCK_READBACK = 'stock-readback';
const COOKIE_ORIGIN = 'https://ontos-stage-n1.web-revolution.cz';

const itemId = '11111111-1111-4111-8111-111111111111';
const effectId = '22222222-2222-4222-8222-222222222222';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: CATALOG_OWNER,
  resourceId,
  resourceType,
  tenantId: AKROS_STAGE_PROOF_INPUT.unitRef.tenantId,
});
const catalogExpectation = { effectsAtLeast: 1, itemsAtLeast: 1, owners: { [CATALOG_OWNER]: 1 } };
const outcome = (
  status: string,
  extra: { readonly effectId?: string; readonly originalStatus?: string; readonly owner?: string } = {},
) => ({
  items: [
    {
      effects: [{ effectId, owner: CATALOG_OWNER, status, ...extra }],
      itemId,
      outcome: 'accepted',
    },
  ],
});

await test('202 admission alone, empty items, wrong owners and missing effects never prove acceptance', () => {
  for (const body of [
    { jobId: itemId, status: 'queued' },
    { items: [] },
    { items: [{ effects: [], itemId, outcome: 'accepted' }] },
    outcome('accepted_change', { owner: PRICING_OWNER }),
  ]) {
    assert.throws(
      () => Result.getOrThrow(assertAcceptedEffects(body, catalogExpectation, PRODUCT_IMPORT)),
      SymmyProofFailure,
    );
  }
  assert.throws(
    () =>
      Result.getOrThrow(
        assertAcceptedEffects(
          outcome('accepted_change'),
          {
            ...catalogExpectation,
            effectsAtLeast: 2,
          },
          PRODUCT_IMPORT,
        ),
      ),
    /effect-count/u,
  );
});

await test('every refused or unsettled effect fails even if the item claims accepted', () => {
  for (const status of [
    'waiting',
    'executing',
    'indeterminate',
    'unsupported',
    'stale',
    'unresolved',
    'ambiguous',
    'denied',
    'conflict',
    'unavailable',
    'invalid',
  ]) {
    assert.throws(
      () => Result.getOrThrow(assertAcceptedEffects(outcome(status), catalogExpectation, PRODUCT_IMPORT)),
      /effect-outcome/u,
    );
  }
});

await test('duplicate is accepted only with a verified accepted original status', () => {
  for (const originalStatus of ['accepted_change', 'accepted_no_change']) {
    Result.getOrThrow(
      assertAcceptedEffects(outcome('duplicate', { originalStatus }), catalogExpectation, PRODUCT_IMPORT),
    );
  }
  for (const originalStatus of [undefined, 'denied', 'indeterminate']) {
    assert.throws(() =>
      Result.getOrThrow(
        assertAcceptedEffects(outcome('duplicate', { originalStatus }), catalogExpectation, PRODUCT_IMPORT),
      ),
    );
  }
});

await test('replay preserves item/effect identities, not just a successful HTTP response', () => {
  const original = Result.getOrThrow(
    assertAcceptedEffects(outcome('accepted_change'), catalogExpectation, PRODUCT_IMPORT),
  );
  const replay = Result.getOrThrow(
    assertAcceptedEffects(
      outcome('duplicate', { originalStatus: 'accepted_change' }),
      catalogExpectation,
      PRODUCT_REPLAY,
    ),
  );
  Result.getOrThrow(assertReplayIdentity(original, replay, PRODUCT_REPLAY));
  const changed = Result.getOrThrow(
    assertAcceptedEffects(outcome('accepted_change', { effectId: itemId }), catalogExpectation, PRODUCT_REPLAY),
  );
  assert.throws(() => Result.getOrThrow(assertReplayIdentity(original, changed, PRODUCT_REPLAY)), /replay-identity/u);
});

await test('one product job item carries all owner effects and retains its identity on replay', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const config = {
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      };
      const effects = Array.from({ length: 10 }, (_, index) => ({
        effectId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        owner: [
          CATALOG_OWNER,
          CATALOG_OWNER,
          CATALOG_OWNER,
          CATALOG_OWNER,
          CATALOG_OWNER,
          CATALOG_OWNER,
          CATALOG_OWNER,
          CATALOG_OWNER,
          PRICING_OWNER,
          'commerce.inventory',
        ][index],
        status: 'accepted_change',
      }));
      const items = [{ effects, itemId, outcome: 'accepted' }];
      let pageReads = 0;
      let writes = 0;
      let prefix = '';

      t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
        if (url.pathname === '/api/symmy/v1/admin/products') {
          prefix = url.searchParams.get('q') ?? '';
          pageReads += 1;
          if (pageReads === 1) {
            return Response.json({ count: 0, products: [] });
          }
          return Response.json({
            count: 1,
            products: [
              {
                id: itemId,
                product: {
                  name: `${prefix}_PRODUCT`,
                  productRef: catalogRef(itemId, 'commerce.catalog.product'),
                  variants: [{ variantId: effectId, variantRef: catalogRef(effectId, CATALOG_VARIANT) }],
                },
                sourceRecordId: `product:erpId:${prefix}_PRODUCT`,
                variantSources: [{ sourceRecordId: `variant:variantId:${prefix}_VARIANT`, variantId: effectId }],
              },
            ],
          });
        }
        if (url.pathname === '/api/symmy/v1/products/batch') {
          assert.equal(init.method, 'POST');
          writes += 1;
          return writes === 1
            ? Response.json({ jobId: itemId, status: 'queued' }, { status: 202 })
            : Response.json({ items });
        }
        if (url.pathname === `/api/symmy/v1/jobs/${itemId}`) {
          return Response.json({ items, jobId: itemId, status: 'completed_all' });
        }
        throw new Error('Unexpected product proof request');
      });
      const result = yield* proveSymmyProduct(config);
      assert.equal(result.names.prefix, prefix);
      assert.equal(writes, 2);
      assert.equal(pageReads, 3);
    }),
  ));

await test('a fresh price-list meaning becomes current before readback', () =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const config = Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY }));
      let productReads = 0;
      let prefix = '';
      const events: string[] = [];
      const result = (owners: readonly string[]) => ({
        body: {
          items: [
            {
              effects: owners.map((owner, index) => ({
                effectId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                owner,
                status: 'accepted_change',
              })),
              itemId,
              itemKey: `${prefix}_VARIANT`,
              locationKey: config.input.locationKey,
              outcome: 'accepted',
            },
          ],
        },
        status: 200,
      });

      const client: SymmyProofClient = {
        ownerRead: Effect.fn('fakeownerRead')(function* ownerRead() {
          return yield* Effect.die(new Error('Unexpected owner read'));
        }),
        read: Effect.fn('fakeread')(function* read(path) {
          if (path.startsWith('/api/symmy/v1/price-lists?')) {
            events.push('read-list');
            return yield* Effect.die(new Error('Reached list read'));
          }
          prefix = new URL(path, config.origin).searchParams.get('q') ?? '';
          productReads += 1;
          if (productReads === 1) {
            return { count: 0, products: [] };
          }
          return {
            count: 1,
            products: [
              {
                id: itemId,
                product: {
                  name: `${prefix}_PRODUCT`,
                  productRef: catalogRef(itemId, 'commerce.catalog.product'),
                  variants: [{ variantId: effectId, variantRef: catalogRef(effectId, CATALOG_VARIANT) }],
                },
                sourceRecordId: `product:erpId:${prefix}_PRODUCT`,
                variantSources: [{ sourceRecordId: `variant:variantId:${prefix}_VARIANT`, variantId: effectId }],
              },
            ],
          };
        }),
        settle: Effect.fn('fakesettle')(function* settle(response, expectation, boundary) {
          return yield* Effect.fromResult(assertAcceptedEffects(response.body, expectation, boundary));
        }),
        waitUntil: (instant, boundary) =>
          Effect.sync(() => {
            assert.equal(boundary, 'price-list-readback');
            assert.ok(Date.parse(instant) > DateTime.toEpochMillis(DateTime.nowUnsafe()));
            events.push('wait-list-start');
          }),
        write: (path, body) =>
          Effect.sync(() => {
            if (path.endsWith('/inventory/stock/batch')) {
              return result(['commerce.inventory']);
            }
            if (path.endsWith('/price-lists/batch-upsert')) {
              const request = Schema.decodeUnknownSync(SymmyPriceListsBatchRequestSchema)(body);
              const [list] = request.priceLists;
              assert.ok(list !== undefined && list.purpose.includes(prefix));
              return result(['pricing.price-group-catalog']);
            }
            return result([CATALOG_OWNER, CATALOG_OWNER, PRICING_OWNER]);
          }),
      };
      yield* expectFailure(proveSymmyProductStockList(config, client), /Reached list read/u);
      assert.deepEqual(events, ['wait-list-start', 'read-list']);
    }),
  ));

await test('two customer items retain all eleven owner effects and replay identities', () =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const config = Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY }));
      const names = makeSymmyProofNames();
      const ref = (resourceId: string) => ({
        moduleId: PARTY_OWNER,
        resourceId,
        resourceType: 'party',
        tenantId: config.input.unitRef.tenantId,
      });
      const effects = Array.from({ length: 11 }, (_, index) => ({
        effectId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        owner: index < 7 ? PARTY_OWNER : CUSTOMER_OWNER,
        status: 'accepted_change',
      }));
      const items = [
        { effects: effects.slice(0, 6), itemId, outcome: 'accepted' },
        { effects: effects.slice(6), itemId: effectId, outcome: 'accepted' },
      ];
      const page = {
        count: 2,
        customers: [
          { id: names.organization, kind: 'ORGANIZATION', resourceId: itemId },
          { id: names.person, kind: 'PERSON', resourceId: effectId },
        ].map(({ id, kind, resourceId }) => ({
          party: {
            businessName: kind === 'ORGANIZATION' ? names.organization : null,
            contactPoints: [
              { normalizedValue: `${id.toLowerCase()}@example.invalid`, type: 'EMAIL' },
              { normalizedValue: '+12025550123', type: 'PHONE' },
            ],
            firstName: kind === 'PERSON' ? names.prefix : null,
            lastName: kind === 'PERSON' ? 'Acceptance' : null,
            outcome: 'AVAILABLE',
            partyType: kind,
          },
          partyRef: ref(resourceId),
          profile: {
            profileRef: { ...ref(resourceId), kind: kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY' },
            subject:
              kind === 'PERSON'
                ? { kind: 'RETAIL', partyRef: ref(resourceId), sellingLegalEntityRef: ref(itemId) }
                : { counterpartyRef: ref(resourceId), kind: 'COUNTERPARTY' },
          },
          sourceRecordId: id,
        })),
      };
      const refusedItems = items.map((item) => ({
        ...item,
        effects: item.effects.map((effect) => ({ ...effect, status: 'denied' })),
      }));
      let writes = 0;
      const client: SymmyProofClient = {
        ownerRead: Effect.fn('fakeownerRead')(function* ownerRead() {
          return yield* Effect.die(new Error('Unexpected owner read'));
        }),
        read: () => Effect.sync(() => Schema.decodeUnknownSync(Schema.Json)(page)),
        settle: Effect.fn('fakesettle')(function* settle(response, expectation, boundary) {
          const accepted = yield* Effect.fromResult(assertAcceptedEffects(response.body, expectation, boundary));
          assert.throws(
            () => Result.getOrThrow(assertAcceptedEffects({ items: [items[0]] }, expectation, boundary)),
            /item-count/u,
          );
          assert.throws(
            () =>
              Result.getOrThrow(
                assertAcceptedEffects(
                  { items: [{ ...items[0], effects: effects.slice(0, 5) }, items[1]] },
                  expectation,
                  boundary,
                ),
              ),
            /effect-count/u,
          );
          assert.throws(
            () =>
              Result.getOrThrow(
                assertAcceptedEffects(
                  {
                    items: refusedItems,
                  },
                  expectation,
                  boundary,
                ),
              ),
            /effect-outcome/u,
          );
          return accepted;
        }),
        waitUntil: Effect.fn('fakewaitUntil')(function* waitUntil() {
          return yield* Effect.die(new Error('Unexpected wait'));
        }),
        write: () =>
          Effect.sync(() => {
            writes += 1;
            return { body: { items }, status: 200 };
          }),
      };
      const result = yield* proveCustomers(config, client, names);
      assert.equal(result.customers.length, 2);
      assert.equal(writes, 2);
    }),
  ));

await test('address readback uses the authorized source view, not buyer-only staff access, and checks every value', () =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const names = makeSymmyProofNames();
      const { tenantId } = AKROS_STAGE_PROOF_INPUT.unitRef;
      const partyRef = { moduleId: PARTY_OWNER, resourceId: itemId, resourceType: 'party.registry.party', tenantId };
      const seller = {
        moduleId: 'core.identity',
        resourceId: effectId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      };
      const retail = {
        moduleId: CUSTOMER_OWNER,
        resourceId: itemId,
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      };
      const counterparty = {
        ...retail,
        resourceId: effectId,
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      };
      const context: SymmyFullProofContext = {
        address: {
          label: `${names.prefix}_ADDRESS`,
          postalAddress: {
            addressLine1: 'Acceptance fixture 1',
            city: 'Test City',
            countryCode: 'CZ',
            postalCode: '11000',
          },
          purposes: ['BILLING', 'DELIVERY'],
        },
        customers: [
          {
            customerId: names.person,
            kind: 'PERSON',
            partyRef,
            profileId: itemId,
            profileRef: retail,
            subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef: seller },
          },
          {
            customerId: names.organization,
            kind: 'ORGANIZATION',
            partyRef,
            profileId: effectId,
            profileRef: counterparty,
            subject: {
              counterpartyRef: { ...partyRef, resourceType: 'party.registry.counterparty' },
              kind: 'COUNTERPARTY',
            },
          },
        ],
        names,
      };
      const page = {
        count: 2,
        customers: context.customers.map((customer) => ({
          addresses: [
            {
              ...context.address,
              lifecycle: 'ACTIVE',
              origin: { kind: 'COMMERCE_ONLY', postalAddress: context.address.postalAddress },
              profile:
                customer.subject.kind === 'COUNTERPARTY'
                  ? {
                      counterpartyRef: customer.subject.counterpartyRef,
                      kind: 'COUNTERPARTY',
                      profileRef: customer.profileRef,
                    }
                  : { kind: 'RETAIL', profileRef: customer.profileRef },
              revision: 1,
              savedAddressRef: {
                moduleId: CUSTOMER_OWNER,
                resourceId: customer.profileId,
                resourceType: 'commerce.customer-context.saved-address',
                tenantId,
              },
            },
          ],
          profile: {
            profileRef: { ...customer.profileRef, kind: customer.subject.kind },
            subject: customer.subject,
          },
          sourceRecordId: customer.customerId,
        })),
      };
      let current = Schema.decodeUnknownSync(Schema.Json)(page);
      const client: SymmyProofClient = {
        ownerRead: Effect.fn('fakeownerRead')(function* ownerRead() {
          return yield* Effect.fail(new SymmyProofFailure('address-readback', 'read-permission', 403));
        }),
        read: (path, boundary) =>
          Effect.sync(() => {
            assert.equal(boundary, 'address-readback');
            assert.equal(new URL(path, PROOF_ORIGIN).searchParams.get('fields'), 'sourceRecordId,profile,addresses');
            return current;
          }),
        settle: Effect.fn('fakesettle')(function* settle() {
          return yield* Effect.die(new Error('Address verification must not start a job'));
        }),
        waitUntil: Effect.fn('fakewaitUntil')(function* waitUntil() {
          return yield* Effect.die(new Error('Address verification must not wait'));
        }),
        write: Effect.fn('fakewrite')(function* write() {
          return yield* Effect.die(new Error('Address verification must not write'));
        }),
      };
      yield* proveOwnerAddresses(client, context);
      for (const changes of [
        { label: 'Wrong label' },
        { purposes: ['DELIVERY'] },
        { origin: { kind: 'COMMERCE_ONLY', postalAddress: { ...context.address.postalAddress, city: 'Wrong city' } } },
      ]) {
        current = Schema.decodeUnknownSync(Schema.Json)({
          ...page,
          customers: page.customers.map((customer) => ({
            ...customer,
            addresses: customer.addresses.map((address) => ({ ...address, ...changes })),
          })),
        });
        yield* expectFailure(proveOwnerAddresses(client, context), /address-readback:readback/u);
      }
      current = Schema.decodeUnknownSync(Schema.Json)({
        ...page,
        customers: page.customers.map((customer) => ({ ...customer, addresses: [] })),
      });
      yield* expectFailure(proveOwnerAddresses(client, context), /address-readback:readback/u);
    }),
  ));

await test('customer group acceptance payload obeys the real native meaning-key contract and remains unique', () => {
  const first = symmyCustomerGroupPayload(makeSymmyProofNames());
  const second = symmyCustomerGroupPayload(makeSymmyProofNames());
  Schema.decodeUnknownSync(SymmyCustomerGroupsBatchRequestSchema, { onExcessProperty: 'error' })(first);
  Schema.decodeUnknownSync(SymmyCustomerGroupsBatchRequestSchema, { onExcessProperty: 'error' })(second);
  const [a] = first.customerGroups;
  const [b] = second.customerGroups;
  assert.ok(a !== undefined && b !== undefined);
  assert.notEqual(a.meaningKey, b.meaningKey);
  assert.equal(a.businessCode, a.code);
  assert.match(a.meaningKey, /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);
  const nativeBusinessMeaning = (group: typeof a) =>
    JSON.stringify(
      [group.purpose, group.membershipCriteria].map((value) => value.trim().replaceAll(/\s+/gu, ' ').toLowerCase()),
    );
  assert.notEqual(nativeBusinessMeaning(a), nativeBusinessMeaning(b));
});

await test('configuration keeps the environment key Redacted and uses only published stage refs', () =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const secret = 'not-a-live-key-never-log-this';
      const config = Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: secret }));
      assert.equal(config.origin, 'https://ontos-stage.web-revolution.cz');
      assert.equal(Redacted.value(config.apiKey), secret);
      assert.equal(format('%s', config.apiKey).includes(secret), false);
      assert.deepEqual(config.input, AKROS_STAGE_PROOF_INPUT);
      assert.ok(Predicate.isFunction((yield* createSymmyProofClient(config)).settle));
      assert.throws(() => runtime.runSync(createSymmyProofClient({ ...config, timeoutMs: 0 })), /input-contract/u);
      for (const origin of ['http://example.test', 'https://example.test/path', `https://${secret}@example.test`]) {
        assert.throws(
          () => Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: secret, SYMMY_PROOF_ORIGIN: origin })),
          (error) => {
            assert.ok(Schema.is(SymmyProofFailure)(error));
            return !symmyProofFailureLine(error).includes(secret);
          },
        );
      }
    }),
  ));

await test('all entity names share a fresh bounded ERP/business-code-safe namespace', () => {
  const first = makeSymmyProofNames();
  const second = makeSymmyProofNames();
  assert.notEqual(first.prefix, second.prefix);
  for (const value of Object.values(first)) {
    assert.match(value, /^[A-Z][A-Z0-9_]*$/u);
    assert.ok(value.startsWith(first.prefix));
    assert.ok(value.length <= 64);
  }
});

await test('decimal equality stays exact beyond Number precision and rejects malformed values', () => {
  assert.equal(decimalEqual('123.450', '123.45'), true);
  assert.equal(decimalEqual('0.000', '0'), true);
  assert.equal(decimalEqual('9007199254740993', '9007199254740992'), false);
  for (const value of ['01', '-1', '1e2', '', Number.NaN, 123.45, null]) {
    assert.equal(decimalEqual(value, value), false);
  }
});

await test('list-price readback accepts canonical decimal basis but rejects a different quantity or unit', () => {
  const { input } = Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY }));
  const ref = { ...input.unitRef, resourceId: itemId };
  const variant = { ...ref, resourceId: effectId };
  const proof = {
    baseAmount: '1',
    effectiveFrom: '2026-11-23T12:00:00.000Z',
    listAmount: '19.5',
    names: makeSymmyProofNames(),
    productRef: ref,
    stockAmount: '1',
    variantRef: variant,
  };
  const value = (quantity: string, unitRef = input.unitRef) => ({
    definition: {
      identityKey: {
        catalogSelection: { productRef: ref, variantRef: variant },
        commercialScope: input.commercialScope,
        priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: ref },
        unitBasis: { quantity, unitRef },
      },
      priceRef: ref,
      revision: {
        effectiveFrom: proof.effectiveFrom,
        monetaryAmount: { amount: '19.500000', currencyCode: input.currencyCode },
        revision: 1,
        revisionId: itemId,
      },
    },
    outcome: 'PRICE_DEFINITION_CURRENT',
  });
  assert.doesNotThrow(() =>
    Result.getOrThrow(assertCurrentListPrice(value('1.000000'), proof, input, ref, proof.effectiveFrom)),
  );
  for (const invalid of [value('2.000000'), value('1', { ...input.unitRef, resourceId: effectId })]) {
    assert.throws(
      () => Result.getOrThrow(assertCurrentListPrice(invalid, proof, input, ref, proof.effectiveFrom)),
      /readback/u,
    );
  }
});

await test('unexpected errors and schema failures never echo secret or customer input', () => {
  const sensitive = 'sensitive-customer@example.invalid secret-token';
  assert.equal(symmyProofFailureLine(new Error(sensitive)), 'FAIL full-proof:unexpected');
  try {
    Result.getOrThrow(assertAcceptedEffects({ items: sensitive }, catalogExpectation, 'customer-import'));
    assert.fail('malformed response passed');
  } catch (error) {
    assert.equal(symmyProofFailureLine(error), 'FAIL customer-import:schema');
  }
});

await test('full proof rejects an unsafe origin before any HTTP request or fixture creation', () =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const config = Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: 'not-a-live-key' }));
      const unsafe = new URL(PROOF_ORIGIN);
      unsafe.protocol = 'http:';
      yield* expectFailure(
        proveSymmyFullFunction({ ...config, origin: unsafe.origin }),
        /FAIL configuration:input-contract/u,
      );
    }),
  ));

await test('native category/product/image builders satisfy the actual public request schemas', () => {
  const names = makeSymmyProofNames();
  const strict = { onExcessProperty: 'error' } satisfies SchemaAST.ParseOptions;
  Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema, strict)(symmyNativeCategoryPayload(names, 4));
  Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema, strict)(symmyNativeProductPayload(names, 5));
  const image = Schema.decodeUnknownSync(
    SymmyDemoMediaUploadRequestSchema,
    strict,
  )(symmyNativeMediaPayload(names, 'native-product-from-write-response', 6));
  assert.equal(image.image.filename, `${names.image}.png`);
  assert.equal(
    Buffer.from(image.image.full.contentBase64, 'base64').subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
  );
});

await test('native APPLIED proof binds exact tenant, company, item and advancing revision, not HTTP 200 alone', () => {
  const scope = {
    legalEntityId: effectId,
    previousRevision: 4,
    tenantId: itemId,
  };
  const body = {
    items: [{ entityId: 'native-product', index: 0, outcome: 'APPLIED', revision: 5 }],
    legalEntityId: scope.legalEntityId,
    ownerModuleId: 'demo.merchandise',
    revision: 5,
    tenantId: scope.tenantId,
  };
  assert.equal(Result.getOrThrow(assertNativeApplied(body, scope, 'category-import')).item.entityId, 'native-product');
  for (const invalid of [
    { ...body, legalEntityId: scope.tenantId },
    { ...body, tenantId: scope.legalEntityId },
    { ...body, revision: 4 },
    { ...body, items: [] },
    { ...body, items: [{ ...body.items[0], outcome: 'QUEUED' }] },
    { ...body, items: [{ ...body.items[0], revision: 6 }] },
  ]) {
    assert.throws(
      () => Result.getOrThrow(assertNativeApplied(invalid, scope, 'category-import')),
      /FAIL category-import:/u,
    );
  }
});

await test('operator owner-read plans use documented company-scoped reads, never a tenant-only source receiver', () => {
  const company = effectId;
  assert.deepEqual(
    Result.getOrThrow(symmyOwnerReadEnvelope('catalog/sku-lookup', { code: 'ERP-1' }, company, 'sku-readback')),
    {
      audience: 'catalog',
      legalEntityId: company,
      query: { code: 'ERP-1' },
      readName: 'sku-lookup',
    },
  );
  const query = {
    customerConfigurationId: 'akros',
    variantRefs: [{ ...AKROS_STAGE_PROOF_INPUT.unitRef, resourceType: CATALOG_VARIANT }],
  };
  const stock = Result.getOrThrow(
    symmyOwnerReadEnvelope('inventory/catalog-variant-on-hand-page', query, company, STOCK_READBACK),
  );
  assert.equal(stock.legalEntityId, company);
  assert.equal(stock.readName, 'catalog-variant-on-hand-page');
  assert.throws(
    () =>
      Result.getOrThrow(
        symmyOwnerReadEnvelope('catalog/sku-lookup', { code: 'ERP-1', operation: 'WRITE' }, company, 'sku-readback'),
      ),
    /input-contract/u,
  );
});

await test('serialized operator gateway token authorizes the actual owner read', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const config = {
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        legalEntityId: itemId,
        operatorCookie: Redacted.make('synthetic-cookie'),
        origin: PROOF_ORIGIN,
      };
      const base = '/shell-super-app-api/module-api/merchandise/test/merchandise-api';
      const revision = 'a'.repeat(64);
      const query = { view: { limit: 0, ordersLimit: 0, summary: true } };
      const calls: string[] = [];
      t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
        calls.push(input.pathname);
        switch (input.pathname) {
          case '/shell-super-app-api/auth/session': {
            return Response.json({
              identity: {
                legalEntityId: itemId,
                tenantId: config.input.unitRef.tenantId,
              },
              state: 'authenticated',
            });
          }
          case '/shell-super-app-api/shell/composition': {
            return Response.json({ compositionRevision: revision, state: 'available' });
          }
          case '/shell-super-app-api/auth/gateway-context': {
            return Response.json({ apiBaseUrl: base, compositionRevision: revision, token: 'synthetic-assertion' });
          }
          case `${base}/reads/records`: {
            const headers = new Headers(init.headers);
            assert.equal(headers.get('authorization'), 'Bearer synthetic-assertion');
            assert.equal(headers.get('x-ontos-composition-revision'), revision);
            assert.match(headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/u);
            assert.equal(headers.has('cookie') || headers.has('x-api-key'), false);
            assert.equal(init.method, 'POST');
            assert.deepEqual(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(init.body), query);
            return Response.json({ revision: 7 });
          }
          default: {
            throw new Error('Unexpected proof request');
          }
        }
      });
      assert.deepEqual(
        yield* (yield* createSymmyProofClient(config)).ownerRead('merchandise/records', query, 'category-readback'),
        {
          revision: 7,
        },
      );
      assert.equal(calls.length, 4);
      assert.equal(calls.at(-1), `${base}/reads/records`);
    }),
  ));

await test('full proof requires separate operator read authentication before any HTTP request', () =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const config = Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: 'not-a-live-key' }));
      yield* expectFailure(proveSymmyFullFunction(config), /FAIL configuration:read-auth-required/u);
    }),
  ));

await test('Netscape operator jar parsing selects only live same-origin Shell cookies and keeps them Redacted', () => {
  const now = 1_700_000_000_000;
  const jar = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_ontos-stage-n1.web-revolution.cz\tFALSE\t/\tTRUE\t0\tsession\top-secret',
    '.web-revolution.cz\tTRUE\t/\tTRUE\t1800000000\tshared\tshared-secret',
    'unrelated.invalid\tFALSE\t/\tTRUE\t0\tforeign\tforeign-secret',
    'ontos-stage-n1.web-revolution.cz\tFALSE\t/private\tTRUE\t0\tprivate\tprivate-secret',
    'ontos-stage-n1.web-revolution.cz\tFALSE\t/\tTRUE\t1600000000\texpired\texpired-secret',
  ].join('\n');
  const parsed = Result.getOrThrow(parseSymmyOperatorCookieJar(jar, COOKIE_ORIGIN, now));
  assert.equal(Redacted.value(parsed), 'session=op-secret; shared=shared-secret');
  assert.equal(format('%s', parsed).includes('op-secret'), false);
  assert.throws(
    () =>
      Result.getOrThrow(
        parseSymmyOperatorCookieJar(
          'ontos-stage-n1.web-revolution.cz\tFALSE\t/\tTRUE\t0\tsession\tvalue;injected=secret',
          COOKIE_ORIGIN,
          now,
        ),
      ),
    /FAIL configuration:input-contract/u,
  );
  assert.throws(() => Result.getOrThrow(parseSymmyOperatorCookieJar('', COOKIE_ORIGIN, now)), /read-auth-required/u);
});

await test('HTTP failure diagnostics retain only closed contract metadata, never detail, token, cookie or customer values', () => {
  const credential = Redacted.make('test-api-key-do-not-log');
  const safe = sanitizeSymmyFailureBody(
    {
      _tag: 'SymmyStockDependencyNotReadyProblem',
      detail: 'customer@example.invalid test-api-key-do-not-log session=cookie-value',
      itemKey: 'private-erp-id',
      reason: 'ITEM_NOT_PROVISIONED',
      retryable: true,
      status: 503,
      token: 'jwt-value',
    },
    credential,
  );
  assert.deepEqual(safe, {
    kind: 'problem',
    reason: 'ITEM_NOT_PROVISIONED',
    retryable: true,
    tag: 'SymmyStockDependencyNotReadyProblem',
  });
  const error = new SymmyProofFailure('stock-import', 'http-status', 503, safe);
  assert.match(symmyProofFailureLine(error), /^FAIL stock-import:http-status:503 body=/u);
  assert.deepEqual(error.safeBody, safe);
  for (const secret of ['customer@', 'test-api-key', 'cookie-value', 'private-erp-id', 'jwt-value']) {
    assert.equal(symmyProofFailureLine(error).includes(secret), false);
  }
  assert.deepEqual(
    sanitizeSymmyFailureBody(
      {
        _tag: 'unrecognized-secret-tag',
        code: 'customer@example.invalid',
        detail: 'secret',
      },
      credential,
    ),
    { kind: 'unrecognized-problem' },
  );
  const collision = sanitizeSymmyFailureBody(
    {
      _tag: 'SymmyUnavailableProblem',
      code: 'POLICY_NOT_FOUND',
    },
    Redacted.make('POLICY_NOT_FOUND'),
  );
  assert.equal(JSON.stringify(collision).includes('POLICY_NOT_FOUND'), false);
});

await test('independent lanes start together and drain all work after an early failure, reporting only sanitized failures', () =>
  runtime.runPromise(
    Effect.gen(function* laneSettlementTest() {
      const names = ['commerce', 'customers', 'native-catalog', 'orders'] satisfies readonly SymmyProofLaneName[];
      const gates = yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* laneGate() {
            return { gate: yield* Deferred.make<boolean, Error>(), name };
          }),
        { concurrency: 1 },
      );
      const ready = yield* Deferred.make<boolean>();
      const started: string[] = [];
      const reports: string[] = [];
      let finished = false;
      const fiber = yield* Effect.forkChild(
        runSymmyProofLanes(
          gates.map(({ gate, name }) => ({
            name,
            run: () =>
              Effect.gen(function* gatedLane() {
                started.push(name);
                if (started.length === names.length) {
                  yield* Deferred.succeed(ready, true);
                }
                yield* Deferred.await(gate).pipe(Effect.orDie);
              }),
          })),
          (line) =>
            Effect.sync(() => {
              reports.push(line);
            }),
        ).pipe(
          Effect.result,
          Effect.ensuring(
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      yield* Deferred.await(ready);
      assert.deepEqual(started, names);
      const [first, ...rest] = gates;
      assert.ok(first !== undefined);
      yield* Deferred.fail(first.gate, new Error('secret-token customer@example.invalid'));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(finished, false);
      yield* Effect.forEach(rest, ({ gate }) => Deferred.succeed(gate, true), { concurrency: 1 });
      const result = yield* Fiber.join(fiber);
      assert.ok(Result.isFailure(result));
      const { failure: error } = result;
      assert.ok(Schema.is(SymmyProofFailure)(error));
      assert.equal(error.code, 'lane-failed');
      assert.deepEqual(error.safeBody, { failed: ['commerce'], kind: 'lanes' });
      assert.equal(reports.length, 4);
      assert.equal(reports.filter((line) => line.startsWith('PASS lane:')).length, 3);
      assert.ok(reports.includes('FAIL lane:commerce FAIL full-proof:unexpected'));
      assert.equal(reports.join('\n').includes('secret-token'), false);
      assert.equal(reports.join('\n').includes('customer@'), false);
    }),
  ));

await test('synthetic storefront result exposes only the requested safe identifiers', () => {
  const result = {
    categoryId: 'category:123',
    categorySlug: 'sp-test-category',
    imageId: itemId,
    productId: 'product-123',
    sku: 'SP_TEST_VARIANT',
    slug: 'sp-test-product',
    token: 'never-output-this',
  };
  const line = Result.getOrThrow(symmyNativeResultLine(result));
  assert.ok(line.startsWith('RESULT native-catalog '));
  assert.equal(line.includes('never-output-this'), false);
  assert.ok(line.includes('"productId":"product-123"'));
  assert.ok(line.includes('"categorySlug":"sp-test-category"'));
  assert.throws(
    () => Result.getOrThrow(symmyNativeResultLine({ ...result, productId: 'customer@example.invalid' })),
    /readback/u,
  );
});

await test('readback requires exactly one record matching both identity and value', () => {
  const contract = {
    fields: { amount: '/quantity/amount', itemKey: '/identity/key' },
    recordsPointer: '/rows',
  };
  const expectedRow = { amount: '17', itemKey: 'SCOPED_VARIANT' };
  const row = { identity: { key: 'SCOPED_VARIANT' }, quantity: { amount: '17.00' } };
  Result.getOrThrow(assertRecordReadback({ rows: [row] }, contract, expectedRow, STOCK_READBACK, ['amount']));
  for (const rows of [
    [],
    [row, row],
    [{ ...row, identity: { key: 'ANOTHER_VARIANT' } }],
    [{ ...row, quantity: { amount: '16' } }],
    [{ identity: row.identity }],
  ]) {
    assert.throws(
      () => Result.getOrThrow(assertRecordReadback({ rows }, contract, expectedRow, STOCK_READBACK, ['amount'])),
      /FAIL stock-readback:/u,
    );
  }
});

await test('JSON pointers decode escaped field names without traversing object prototypes', () => {
  Result.getOrThrow(
    assertRecordReadback(
      { 'a/b': { '~amount': '17' } },
      {
        fields: { amount: '/a~1b/~0amount' },
        recordsPointer: '',
      },
      { amount: '17' },
      STOCK_READBACK,
    ),
  );
  for (const pointer of ['/toString', '/bad~2escape', 'relative']) {
    assert.throws(() =>
      Result.getOrThrow(
        assertRecordReadback({}, { fields: { amount: pointer }, recordsPointer: '' }, { amount: '17' }, STOCK_READBACK),
      ),
    );
  }
});

await test('order export needs real nonempty persisted orders, lines and consistent monetary snapshots', () => {
  const order = {
    contact: { email: 'never-log@example.invalid' },
    currencyCode: 'CZK',
    id: 'existing-order',
    lines: [
      {
        productId: 'existing-product',
        quantity: 1,
        sku: 'ERP-1',
        totalMinor: 121,
        totalVatMinor: 21,
        unitPriceMinor: 100,
        vatRate: 21,
      },
    ],
    number: 'ORDER-1',
    pricesIncludeVat: false,
    totalMinor: 121,
    totalNetMinor: 100,
    totalVatMinor: 21,
  };
  const parsed = Result.getOrThrow(assertOrderSnapshots([order]));
  assert.equal(
    parsed.some((row) => 'contact' in row),
    false,
  );
  for (const body of [
    [],
    [order, order],
    [{ ...order, lines: [] }],
    [{ ...order, totalNetMinor: 99 }],
    [{ ...order, totalMinor: 999, totalNetMinor: 978 }],
    [{ ...order, lines: [{ ...order.lines[0], totalMinor: 1, totalVatMinor: 0 }] }],
    [{ ...order, lines: [{ ...order.lines[0], quantity: 0 }] }],
    [{ ...order, lines: [{ ...order.lines[0], productId: '' }] }],
  ]) {
    assert.throws(() => Result.getOrThrow(assertOrderSnapshots(body)), /FAIL order-export:/u);
  }
});

await test('order reconciliation handles fractional quantities, net or gross unit prices, and gross shipping', () => {
  for (const [pricesIncludeVat, lineGross, lineVat] of [
    [false, 184, 32],
    [true, 152, 26],
  ] as const) {
    const line = {
      productId: 'p',
      quantity: 1.5,
      sku: 'SKU',
      totalMinor: lineGross,
      totalVatMinor: lineVat,
      unitPriceMinor: 101,
      vatRate: 21,
    };
    const order = {
      currencyCode: 'CZK',
      id: 'o',
      lines: [line],
      number: 'OBJ',
      pricesIncludeVat,
      shipping: { label: 'PPL', method: 'PPL', priceMinor: 121, vatRate: 21 },
      totalMinor: lineGross + 121,
      totalNetMinor: lineGross - lineVat + 100,
      totalVatMinor: lineVat + 21,
    };
    assert.doesNotThrow(() => Result.getOrThrow(assertOrderSnapshots([order])));
    for (const wrong of [
      { ...order, pricesIncludeVat: !pricesIncludeVat },
      { ...order, lines: [{ ...line, totalVatMinor: lineVat - 1 }] },
      { ...order, shipping: { ...order.shipping, vatRate: 0 } },
      Object.fromEntries(Object.entries(order).filter(([key]) => key !== 'shipping')),
      { ...order, totalMinor: lineGross, totalNetMinor: lineGross - lineVat, totalVatMinor: lineVat },
    ]) {
      assert.throws(() => Result.getOrThrow(assertOrderSnapshots([wrong])), /FAIL order-export:/u);
    }
  }
});

await test('schema and configuration failures retain redacted causes without exposing invalid input', () => {
  const sensitive = 'private-proof-input@example.invalid';
  assert.throws(
    () => Result.getOrThrow(assertAcceptedEffects({ items: sensitive }, catalogExpectation, PRODUCT_IMPORT)),
    (error) => {
      assert.ok(Schema.is(SymmyProofFailure)(error));
      assert.equal(error.code, 'schema');
      assert.ok(Redacted.isRedacted(error.privateCause));
      assert.equal(JSON.stringify(error).includes(sensitive), false);
      assert.equal(symmyProofFailureLine(error).includes(sensitive), false);
      return true;
    },
  );
  assert.throws(
    () => Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY, SYMMY_PROOF_INPUT_JSON: sensitive })),
    (error) => {
      assert.ok(Schema.is(SymmyProofFailure)(error));
      assert.equal(error.code, 'input-contract');
      assert.ok(Redacted.isRedacted(error.privateCause));
      assert.equal(JSON.stringify(error).includes(sensitive), false);
      return true;
    },
  );
});

await test('non-JSON outbound input fails before fetch and retains only a redacted serialization cause', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', () => {
        calls += 1;
        return Promise.reject(new Error('A malformed payload must never reach transport'));
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      yield* expectFailure(
        client.write('/api/symmy/v1/products/batch', { value: 1n }, 'invalid-json', PRODUCT_IMPORT),
        (error) => {
          assert.ok(Schema.is(SymmyProofFailure)(error));
          assert.equal(error.code, 'input-contract');
          assert.ok(Redacted.isRedacted(error.privateCause));
          return true;
        },
      );
      assert.equal(calls, 0);
    }),
  ));

await test('HTTP response bounds, redirects and malformed documents retain their rejection controls without retries', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      let calls = 0;
      const responses = [
        new Response(null, { headers: { location: 'https://must-not-follow.invalid' }, status: 302 }),
        new Response('not-json', { status: 200 }),
        new Response('not-json', { status: 503 }),
        new Response(null, { status: 200 }),
        new Response('x'.repeat(2_000_001), { status: 200 }),
      ];
      t.mock.method(globalThis, 'fetch', () => {
        const response = responses[calls];
        calls += 1;
        assert.ok(response !== undefined, 'the proof retried a rejected response');
        return Promise.resolve(response);
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), /:redirect$/u);
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), /:schema:200$/u);
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), /:http-status:503 body=.*non-json/u);
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), /:schema:200$/u);
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), /:response-too-large$/u);
      assert.equal(calls, responses.length);
    }),
  ));

await test('interrupting before headers aborts the authenticated request without retrying', (t) =>
  runtime.runPromise(
    Effect.gen(function* requestInterruptionTest() {
      const requested = yield* Deferred.make<AbortSignal>();
      const pending = Promise.withResolvers<Response>();
      const fetchMock = t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => {
        assert.equal(url.origin, PROOF_ORIGIN);
        assert.equal(new Headers(init.headers).get('x-api-key'), SYNTHETIC_KEY);
        const { signal } = init;
        assert.ok(signal !== undefined && signal !== null);
        Deferred.doneUnsafe(requested, Effect.succeed(signal));
        signal.addEventListener('abort', () => pending.reject(new Error('Synthetic request aborted')), { once: true });
        return pending.promise;
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      const fiber = yield* Effect.forkChild(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT));
      const signal = yield* Deferred.await(requested);
      assert.equal(signal.aborted, false);
      yield* Fiber.interrupt(fiber);
      assert.equal(signal.aborted, true);
      assert.equal(fetchMock.mock.callCount(), 1);
    }),
  ));

await test('interrupting a pending body read cancels the unread stream and aborts its authenticated request', (t) =>
  runtime.runPromise(
    Effect.gen(function* bodyInterruptionTest() {
      const requested = yield* Deferred.make<AbortSignal>();
      const reading = yield* Deferred.make<boolean>();
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancellations += 1;
          },
          pull() {
            Deferred.doneUnsafe(reading, Effect.succeed(true));
          },
        },
        { highWaterMark: 0 },
      );
      const fetchMock = t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => {
        assert.equal(url.origin, PROOF_ORIGIN);
        assert.equal(new Headers(init.headers).get('x-api-key'), SYNTHETIC_KEY);
        const { signal } = init;
        assert.ok(signal !== undefined && signal !== null);
        Deferred.doneUnsafe(requested, Effect.succeed(signal));
        return Promise.resolve(new Response(body));
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      const fiber = yield* Effect.forkChild(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT));
      yield* Deferred.await(reading);
      const signal = yield* Deferred.await(requested);
      assert.equal(signal.aborted, false);
      assert.equal(body.locked, true);
      yield* Fiber.interrupt(fiber);
      assert.equal(signal.aborted, true);
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
      assert.equal(fetchMock.mock.callCount(), 1);
    }),
  ));

await test('the response byte limit cancels an unclosed body and aborts the request without retrying', (t) =>
  runtime.runPromise(
    Effect.gen(function* bodyLimitCleanupTest() {
      const requested = yield* Deferred.make<AbortSignal>();
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancellations += 1;
          },
          pull(controller) {
            controller.enqueue(new Uint8Array(2_000_001));
          },
        },
        { highWaterMark: 0 },
      );
      const fetchMock = t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => {
        assert.equal(url.origin, PROOF_ORIGIN);
        const { signal } = init;
        assert.ok(signal !== undefined && signal !== null);
        Deferred.doneUnsafe(requested, Effect.succeed(signal));
        return Promise.resolve(new Response(body));
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), /:response-too-large$/u);
      assert.equal((yield* Deferred.await(requested)).aborted, true);
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
      assert.equal(fetchMock.mock.callCount(), 1);
    }),
  ));

await test('network failures retain the original foreign cause privately and never print it', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const cause = new Error('synthetic-secret-transport-cause');
      let calls = 0;
      t.mock.method(globalThis, 'fetch', () => {
        calls += 1;
        return Promise.reject(cause);
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      yield* expectFailure(client.read(CATALOG_REVISION_PATH, PRODUCT_IMPORT), (error) => {
        assert.ok(Schema.is(SymmyProofFailure)(error));
        assert.equal(error.code, 'network');
        assert.ok(Redacted.isRedacted(error.privateCause));
        assert.equal(Redacted.value(error.privateCause), cause);
        assert.equal(JSON.stringify(error).includes(cause.message), false);
        assert.equal(symmyProofFailureLine(error).includes(cause.message), false);
        return true;
      });
      assert.equal(calls, 1);
    }),
  ));

await test('job identity and terminal failures stop after one poll rather than accepting partial work', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', () => {
        calls += 1;
        return Promise.resolve(
          Response.json({
            items: [],
            jobId: calls === 1 ? effectId : itemId,
            status: 'completed_none',
          }),
        );
      });
      const client = yield* createSymmyProofClient({
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        origin: PROOF_ORIGIN,
      });
      const admission = { body: { jobId: itemId, status: 'queued' }, status: 202 };
      yield* expectFailure(client.settle(admission, catalogExpectation, PRODUCT_IMPORT), /:job-identity$/u);
      assert.equal(calls, 1);
      yield* expectFailure(client.settle(admission, catalogExpectation, PRODUCT_IMPORT), /:job-terminal:200 body=/u);
      assert.equal(calls, 2);
      yield* expectFailure(client.waitUntil('invalid-instant', PRODUCT_IMPORT), /:input-contract$/u);
    }),
  ));

await test('owner failures scrub both cookie and temporary token collisions in otherwise allowed problem metadata', (t) =>
  runtime.runPromise(
    Effect.gen(function* nativeProofTest() {
      const cookie = 'ITEM_NOT_PROVISIONED';
      const token = 'POLICY_NOT_FOUND';
      const revision = 'b'.repeat(64);
      const config = {
        ...Result.getOrThrow(readSymmyProofConfig({ SYMMY_API_KEY: SYNTHETIC_KEY })),
        legalEntityId: itemId,
        operatorCookie: Redacted.make(cookie),
        origin: PROOF_ORIGIN,
      };
      const paths: string[] = [];
      t.mock.method(globalThis, 'fetch', (url: URL) => {
        paths.push(url.pathname);
        switch (paths.length) {
          case 1: {
            return Promise.resolve(
              Response.json({
                identity: { legalEntityId: itemId, tenantId: config.input.unitRef.tenantId },
                state: 'authenticated',
              }),
            );
          }
          case 2: {
            return Promise.resolve(Response.json({ compositionRevision: revision, state: 'available' }));
          }
          case 3: {
            return Promise.resolve(
              Response.json({
                apiBaseUrl: '/shell-super-app-api/module-api/merchandise/test/merchandise-api',
                compositionRevision: revision,
                token,
              }),
            );
          }
          case 4: {
            return Promise.resolve(
              Response.json(
                {
                  _tag: 'SymmyStockDependencyNotReadyProblem',
                  code: token,
                  detail: `${cookie} ${token}`,
                  reason: cookie,
                },
                { status: 403 },
              ),
            );
          }
          default: {
            return Promise.reject(new Error('Owner authentication must not retry'));
          }
        }
      });
      yield* expectFailure(
        (yield* createSymmyProofClient(config)).ownerRead(
          'merchandise/records',
          { view: { limit: 0, ordersLimit: 0 } },
          PRODUCT_IMPORT,
        ),
        (error) => {
          assert.ok(Schema.is(SymmyProofFailure)(error));
          assert.equal(error.code, 'read-permission');
          assert.deepEqual(error.safeBody, { kind: 'unrecognized-problem' });
          assert.equal(symmyProofFailureLine(error).includes(cookie), false);
          assert.equal(symmyProofFailureLine(error).includes(token), false);
          return true;
        },
      );
      assert.deepEqual(paths, [
        '/shell-super-app-api/auth/session',
        '/shell-super-app-api/shell/composition',
        '/shell-super-app-api/auth/gateway-context',
        '/shell-super-app-api/module-api/merchandise/test/merchandise-api/reads/records',
      ]);
    }),
  ));

await test('JSON pointer traversal retains array index and length behavior while rejecting non-own array properties', () => {
  Result.getOrThrow(
    assertRecordReadback(
      { rows: [{ amount: '17' }] },
      {
        fields: { amount: '/amount' },
        recordsPointer: '/rows/0',
      },
      { amount: '17' },
      STOCK_READBACK,
    ),
  );
  Result.getOrThrow(
    assertRecordReadback(
      { rows: [{ amount: '17' }] },
      {
        fields: { length: '/rows/length' },
        recordsPointer: '',
      },
      { length: 1 },
      STOCK_READBACK,
    ),
  );
  assert.throws(
    () =>
      Result.getOrThrow(
        assertRecordReadback(
          { rows: [{ amount: '17' }] },
          {
            fields: { value: '/rows/map' },
            recordsPointer: '',
          },
          { value: 1 },
          STOCK_READBACK,
        ),
      ),
    /readback/u,
  );
});
