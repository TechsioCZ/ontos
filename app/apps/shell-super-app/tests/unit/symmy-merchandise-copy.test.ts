import {
  CatalogSourceProductPageResponseSchema,
  CatalogSourceProductPageForbiddenProblemSchema,
} from '@app/catalog/api/catalog-source-product-page';
import { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { assert, expect, it } from 'effect-rstest';
import {
  copySymmyProductsToMerchandise,
  scheduleSymmyMerchandiseCopy,
  symmyUpsertSourceProductCommand,
} from '../../api/symmy/merchandise-copy.ts';
import { SymmyInternalProductsProjectionSchema } from '../../api/symmy/read-projection-contracts.ts';
import type { SymmyIngressAdmission } from '../../api/symmy/transport.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const at = '2026-11-20T10:00:00.000Z';
const revision = 'a'.repeat(64);
const route = Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)({
  allowedOwnerOperations: [
    { entrypointKey: 'demo.merchandise.import-source-catalog', moduleId: 'demo.merchandise', schemaVersion: '1' },
    {
      entrypointKey: 'commerce.catalog.api.catalog-source-product-page',
      moduleId: 'commerce.catalog',
      schemaVersion: '1',
    },
  ],
  issuerId: 'copy-fixture',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  mappingVersion: 'mapping-1',
  routeId: '77777777-7777-4777-8777-777777777777',
  routeRevision: 'route-1',
  sourceMappingVersion: 'mapping-1',
  sourceNamespace: 'copy-fixture',
  sourceRouteId: '88888888-8888-4888-8888-888888888888',
  sourceRouteRevision: 'route-1',
  tenantId,
});
const sourceItem = () => {
  const productRef = {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  };
  const projection = Schema.decodeUnknownSync(SymmyInternalProductsProjectionSchema)({
    contractVersion: 'INTERNAL_C14',
    count: 1,
    limit: 100,
    offset: 0,
    products: [
      {
        id: `~c14r1.${'a'.repeat(43)}`,
        product: {
          catalogReady: false,
          createdAt: at,
          description: ' Source description ',
          lifecycle: 'DRAFT',
          name: ' Source title ',
          productRef,
          revision: 1,
          updatedAt: at,
          variants: [
            {
              lifecycle: 'WORK_IN_PROGRESS',
              productRef,
              variantId,
              variantRef: {
                moduleId: 'commerce.catalog',
                resourceId: variantId,
                resourceType: 'commerce.catalog.variant',
                tenantId,
              },
            },
          ],
        },
        source_record_id: 'product:erpId:ERP-1',
        variantSources: [{ id: `~c14r1.${'b'.repeat(43)}`, source_record_id: 'variant:erpId:ERP-V1', variantId }],
      },
    ],
    projection: 'products',
    unsupported_fields: ['tax', 'assortment', 'prices', 'stock'],
  });
  const [item] = projection.products;
  assert.isOk(item);
  return item;
};

it('maps accepted source figures and keeps the source timestamp in its wire format', () => {
  const command = symmyUpsertSourceProductCommand(
    sourceItem(),
    new Map([[variantId, { priceNetMinor: 1234, stockOnHand: 5 }]]),
  );
  expect(command).toMatchObject({
    catalogProductId: productId,
    description: 'Source description',
    erpCode: 'ERP-1',
    lifecycle: 'DRAFT',
    name: 'Source title',
    sourceUpdatedAt: at,
    variants: [{ catalogVariantId: variantId, priceNetMinor: 1234, sku: 'ERP-V1', stockOnHand: 5 }],
  });
});

it('omits unknown price and stock rather than inventing zeroes', () => {
  const command = symmyUpsertSourceProductCommand(sourceItem());
  expect(command?.variants[0]).toEqual({ catalogVariantId: variantId, sku: 'ERP-V1' });
});

it('names each of several variants by its Czech source name without the product name, and a single variant not at all', () => {
  const item = sourceItem();
  const secondId = '55555555-5555-4555-8555-555555555555';
  const named = (id: string, code: string, name: string) => ({
    id: `~c14r1.${'c'.repeat(43)}`,
    localizedNames: [
      { locale: 'en', name: 'ignored' },
      { locale: 'cs', name },
    ],
    source_record_id: `variant:variantId:${code}`,
    variantId: id,
  });
  const several = symmyUpsertSourceProductCommand({
    ...item,
    variantSources: [named(variantId, 'ERP-V1', 'Source title 4 x 40'), named(secondId, 'ERP-V2', '5 x 50')],
  });
  expect(several?.variants).toEqual([
    { catalogVariantId: variantId, name: '4 x 40', sku: 'ERP-V1' },
    { catalogVariantId: secondId, name: '5 x 50', sku: 'ERP-V2' },
  ]);
  const single = symmyUpsertSourceProductCommand({
    ...item,
    variantSources: [named(variantId, 'ERP-V1', 'Source title 4 x 40')],
  });
  expect(single?.variants).toEqual([{ catalogVariantId: variantId, sku: 'ERP-V1' }]);
});

it('does not create a command for an unnamed source product or an empty variant source code', () => {
  const item = sourceItem();
  expect(symmyUpsertSourceProductCommand({ ...item, product: { ...item.product, name: '' } })).toBeUndefined();
  expect(
    symmyUpsertSourceProductCommand({
      ...item,
      variantSources: item.variantSources.map((variant) => ({ ...variant, source_record_id: 'variant:erpId:' })),
    }),
  ).toBeUndefined();
});

const assertion = (audience: string) => ({
  apiBaseUrl: `/shell-super-app-api/module-api/${audience}/copy-test/${audience}-api`,
  assertion: Redacted.make('copy-fixture-assertion'),
  compositionRevision: revision,
});

const emptyCatalogPage = () =>
  Response.json(Schema.encodeSync(CatalogSourceProductPageResponseSchema)({ count: 0, items: [] }));
const deniedCatalogPage = () =>
  Response.json(
    CatalogSourceProductPageForbiddenProblemSchema.make({
      detail: 'Owner denied',
      status: 403,
      title: 'Forbidden',
      type: 'https://ontos.dev/problems/catalog-denied',
    }),
    { headers: { 'content-type': 'application/problem+json' }, status: 403 },
  );

const fixture = (blockFirst = false, refuseFirst = false) => {
  const entered = Promise.withResolvers<null>();
  const released = Promise.withResolvers<Response>();
  const firstReply = refuseFirst ? deniedCatalogPage() : emptyCatalogPage();
  const release = () => released.resolve(firstReply);
  const identifiers = new Map<string, number>();
  const requests: string[] = [];
  let catalogPages = 0;
  const admission = (name: string): SymmyIngressAdmission => ({
    ...assertion('symmy-integration'),
    acquireOwnerAssertion: ({ audience }) => Effect.succeed(assertion(audience)),
    acquireRouteAssertion: () => Effect.succeed({ ...assertion('symmy-integration'), route }),
    newRequestIdentifier: Effect.sync(() => {
      const count = (identifiers.get(name) ?? 0) + 1;
      identifiers.set(name, count);
      return `${name}-${String(count)}`;
    }),
  });
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path.endsWith('/reads/catalog-source-product-page')) {
      catalogPages += 1;
      entered.resolve(null);
      if (blockFirst && catalogPages === 1) {
        return released.promise;
      }
      return Promise.resolve(refuseFirst && catalogPages === 1 ? firstReply : emptyCatalogPage());
    }
    if (path.endsWith('/reads/external-price-source-scopes')) {
      return Promise.resolve(Response.json({ scopes: [] }));
    }
    return Promise.resolve(Response.json({ detail: 'Unexpected copy fixture request' }, { status: 500 }));
  };
  return { admission, entered, fakeFetch, identifiers, pages: () => catalogPages, release, requests };
};

it.effect('uses admitted request identifiers and stops pagination on an empty owner page', () =>
  Effect.gen(function* copyEmptyCatalog() {
    const current = fixture();
    const result = yield* copySymmyProductsToMerchandise(current.admission('empty')).pipe(
      Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
    );
    expect(result).toEqual({ outcomes: { CREATED: 0, REFUSED: 0, UNCHANGED: 0, UPDATED: 0 } });
    expect(current.pages()).toBe(1);
    expect(current.identifiers.get('empty')).toBeGreaterThan(0);
    expect(
      current.requests.every(
        (path) =>
          path.endsWith('/reads/catalog-source-product-page') || path.endsWith('/reads/external-price-source-scopes'),
      ),
    ).toBe(true);
  }),
);

it.effect('does no owner work when the route is not enrolled for the import', () =>
  Effect.gen(function* skipUnenrolledCopy() {
    const current = fixture();
    const admission = {
      ...current.admission('unenrolled'),
      acquireRouteAssertion: () =>
        Effect.succeed({
          apiBaseUrl: 'https://copy-fixture.invalid/symmy-integration-api',
          assertion: Redacted.make('copy-fixture-assertion'),
          compositionRevision: revision,
          route: { ...route, allowedOwnerOperations: [] },
        }),
    };
    const result = yield* copySymmyProductsToMerchandise(admission).pipe(
      Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
    );
    expect(result).toEqual({ skipped: 'not_enrolled' });
    expect(current.requests).toEqual([]);
    expect(current.identifiers.size).toBe(0);
  }),
);

const checkCoalescing = Effect.fn('test.SymmyCopy.coalescing')(function* checkCoalescing(refuseFirst: boolean) {
  const current = fixture(true, refuseFirst);
  const program = Effect.gen(function* notifications() {
    yield* scheduleSymmyMerchandiseCopy(current.admission('first'));
    yield* Effect.promise(() => current.entered.promise);
    yield* scheduleSymmyMerchandiseCopy(current.admission('middle'));
    yield* scheduleSymmyMerchandiseCopy(current.admission('latest'));
    current.release();
    yield* TestClock.adjust('10 seconds');
    expect(current.pages()).toBe(2);
    expect(current.identifiers.has('first')).toBe(true);
    expect(current.identifiers.has('middle')).toBe(false);
    expect(current.identifiers.has('latest')).toBe(true);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* drainFixtureQueue() {
        current.release();
        yield* TestClock.adjust('30 seconds');
      }),
    ),
  );
  yield* program.pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
});

it.effect('coalesces notifications received during a full copy into the latest pending admission', () =>
  checkCoalescing(false),
);
it.effect('runs the pending admission even after the current owner read fails', () => checkCoalescing(true));

it.effect('fails closed before sending owner requests when runtime identifiers are unavailable', () =>
  Effect.gen(function* requireRuntimeIdentifiers() {
    const current = fixture();
    const { newRequestIdentifier: omitted, ...admission } = current.admission('missing');
    void omitted;
    const failure = yield* copySymmyProductsToMerchandise(admission).pipe(
      Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
      Effect.flip,
    );
    expect(failure.status).toBe(503);
    expect(current.requests).toEqual([]);
  }),
);
