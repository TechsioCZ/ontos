import { Effect, Exit, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import {
  AkrosPlaygroundCopyError,
  akrosCopyDestination,
  akrosCopySource,
  akrosPlaygroundAccounts,
  BootstrapCopyCatalogSchema,
  bootstrapCopyCatalog,
  cachedCopyRead,
  CopyPlanSchema,
  CopySnapshotSchema,
  canonicalCopyJson,
  copyAssociationId,
  copyDigest,
  copyMarketId,
  copyMediaDigest,
  copyPlanFromSnapshot,
  RecordsRequest,
  readCopyOffers,
  readCopyProducts,
  validateCopyPlan,
} from '../demo/akros-playground-copy.mts';
import { demoId } from '../demo/fixture-ids.mts';
import { checkCopyBootstrap } from '../demo/seed-akros-playground.mts';

const at = '2026-11-02T10:00:00.000Z';
const checkpointDirectory = '/owned/revision-42';
const checkpointCategory = 'category-a';
const product = (index = 0) => ({
  active: true,
  category: 'Šrouby',
  categoryId: 'screws',
  categoryPathIds: ['screws'],
  createdAt: at,
  currentPriceMinor: 123,
  id: `product-${index}`,
  images: [],
  lowStock: false,
  lowStockThreshold: 0,
  name: `Šroub ${index}`,
  priceHistory: [{ effectiveFrom: at, priceMinor: 123 }],
  sku: `SCREW-${index}`,
  slug: `sroub-${index}`,
  stockOnHand: 0,
  stockValueMinor: 0,
  unit: 'ks',
  updatedAt: at,
  vatRate: 21,
});

it.effect('reuses durable source details after interruption and keeps checkpoint files owner-only', () =>
  Effect.gen(function* checkpointTest() {
    const files = new Map<string, string>();
    const modes: number[] = [];
    let loads = 0;
    const fs = FileSystem.makeNoop({
      exists: (file) => Effect.succeed(files.has(file)),
      makeDirectory: (_directory, options) =>
        Effect.sync(() => {
          modes.push(options?.mode ?? 0);
        }),
      readFileString: (file) => Effect.succeed(files.get(file) ?? ''),
      writeFileString: (file, value, options) =>
        Effect.sync(() => {
          modes.push(options?.mode ?? 0);
          files.set(file, value);
        }),
    });
    const schema = Schema.Struct({ revision: Schema.Int });
    const load = Effect.sync(() => {
      loads += 1;
      return { revision: 42 };
    });
    const first = yield* cachedCopyRead(fs, checkpointDirectory, checkpointCategory, schema, load);
    const resumed = yield* cachedCopyRead(fs, checkpointDirectory, checkpointCategory, schema, load);
    expect(first).toEqual(resumed);
    expect(loads).toBe(1);
    expect(modes).toEqual([0o700, 0o600]);
    yield* cachedCopyRead(fs, '/owned/revision-43', checkpointCategory, schema, load);
    expect(loads).toBe(2);
  }),
);

it.effect('refuses a truncated checkpoint instead of silently replacing captured source data', () =>
  Effect.gen(function* corruptCheckpointTest() {
    let reads = 0;
    const fs = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed('{"revision":'),
    });
    const failure = yield* Effect.exit(
      cachedCopyRead(
        fs,
        checkpointDirectory,
        'product-a',
        Schema.Struct({ revision: Schema.Int }),
        Effect.sync(() => {
          reads += 1;
          return { revision: 42 };
        }),
      ),
    );
    expect(Exit.isFailure(failure)).toBe(true);
    expect(reads).toBe(0);
  }),
);
const snapshotInput = () => ({
  capturedAt: at,
  catalog: {
    associations: [],
    completenessEvidence: {
      observedAt: at,
      ownerRevision: 'snapshot-1',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'markets' },
    },
    markets: [],
    observedAt: at,
  },
  categories: [
    {
      description: 'Spojovací materiál',
      hasChildren: false,
      heading: 'Šrouby',
      id: 'screws',
      imageAlt: 'Šrouby AKROS',
      imageSrc: '/akros/screws.svg',
      longDescription: 'Přesný původní obsah',
      name: 'Šrouby',
      parentId: null,
      position: 0,
      published: true,
      slug: 'srouby',
    },
  ],
  featuredProductIds: ['product-0'],
  marketOffers: [],
  media: [],
  origin: 'https://ontos-stage.web-revolution.cz',
  products: [product()],
  revision: 42,
  source: akrosCopySource,
  storefront: { applications: [], observedAt: at },
});
const snapshot = () => Schema.decodeUnknownEffect(CopySnapshotSchema)(snapshotInput());
const reader = (respond: (payload: typeof RecordsRequest.Type) => object) => ({
  call: <P extends Schema.Top, R extends Schema.Top>(
    _audience: string,
    _path: string,
    _payloadSchema: P,
    payload: P['Type'],
    resultSchema: R,
  ) =>
    Schema.decodeUnknownEffect(RecordsRequest)(payload).pipe(
      Effect.flatMap((request) => Schema.decodeUnknownEffect(resultSchema)(respond(request))),
    ),
});
const readView = RecordsRequest;
const response = (products: readonly unknown[], totalProducts: number, revision = 42) => ({
  actorPrincipalRef: { principalId: demoId('principal', 'source-admin'), tenantId: akrosCopySource.tenantId },
  canWrite: true,
  indicators: {
    lowStockCount: 0,
    openOrderValueMinor: 0,
    orderCount: 0,
    productCount: totalProducts,
    stockValueMinor: 0,
  },
  movements: [],
  orders: [],
  products,
  revision,
  totalProducts,
});

it.effect('refuses an empty destination before dispatching any catalog, gallery or market write', () =>
  Effect.gen(function* missingBootstrapTest() {
    const source = yield* snapshot();
    const routes: string[] = [];
    const base = reader(() => response([], 0));
    const client = {
      call: <P extends Schema.Top, R extends Schema.Top>(
        audience: string,
        path: string,
        payloadSchema: P,
        payload: P['Type'],
        resultSchema: R,
      ) => {
        routes.push(path);
        return base.call(audience, path, payloadSchema, payload, resultSchema);
      },
    };
    const failure = yield* checkCopyBootstrap(client, source).pipe(Effect.flip);
    expect(failure.reason).toContain('bootstrap');
    expect(routes.every((route) => route === '/reads/records')).toBe(true);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it('uses only the agreed isolated tenant, company and account identities', () => {
  expect(akrosCopyDestination).toEqual({
    legalEntityId: demoId('legal-entity', 'akros-playground'),
    tenantId: demoId('tenant', 'akros-playground'),
  });
  expect(akrosCopyDestination.tenantId).not.toBe(akrosCopySource.tenantId);
  expect(akrosPlaygroundAccounts).toEqual({
    admin: 'admin@akros.playground',
    eshop: 'eshop@akros.playground',
    expedition: 'expedice@akros.playground',
  });
  expect(copyMarketId('source')).not.toBe('source');
  expect(copyMarketId('source')).toBe(copyMarketId('source'));
  expect(copyAssociationId('source')).not.toBe(copyMarketId('source'));
});

it('fingerprints ignore object key order but retain array ordering', () => {
  expect(copyDigest({ a: 1, b: 2 })).toBe(copyDigest({ a: 1, b: 2 }));
  expect(copyDigest([1, 2])).not.toBe(copyDigest([2, 1]));
  expect(canonicalCopyJson({ value: null })).toBe('{"value":null}');
});

it.effect('accepts an unchanged approved frozen plan', () =>
  Effect.gen(function* copyTest() {
    const plan = copyPlanFromSnapshot(yield* snapshot());
    expect(Schema.is(CopyPlanSchema)(plan)).toBe(true);
    yield* validateCopyPlan(plan, plan.fingerprint);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('plans five non-retired markets explicitly while retaining both retired QA markets in the snapshot', () =>
  Effect.gen(function* fiveMarketScopeTest() {
    const codes = ['AKROS-CZ', 'AKROS-SK', 'AKROS-EU', 'AKROS-CZ-B2B', 'AKROS-PL', 'AKROS-QA-A', 'AKROS-QA-B'];
    const input = snapshotInput();
    const markets = codes.map((code, index) => {
      const resourceId = demoId('market', code);
      let lifecycle = 'ACTIVE';
      if (index >= 5) {
        lifecycle = 'RETIRED';
      } else if (index === 4) {
        lifecycle = 'SUSPENDED';
      }
      return {
        channels: ['B2C'],
        definitionRevisionRef: {
          moduleId: 'commerce.market-catalog',
          resourceId: `${resourceId}:1`,
          resourceType: 'commerce.market-catalog.market-definition-revision',
          tenantId: akrosCopySource.tenantId,
        },
        effectivePeriod: { startsAt: at },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle,
        marketCode: code,
        marketRef: {
          moduleId: 'commerce.market-catalog',
          resourceId,
          resourceType: 'commerce.market-catalog.market',
          tenantId: akrosCopySource.tenantId,
        },
        purpose: 'Původní trh',
        revision: 1,
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: akrosCopySource.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: akrosCopySource.tenantId,
        },
        supportedLocales: ['cs'],
      };
    });
    const source = yield* Schema.decodeUnknownEffect(CopySnapshotSchema)({
      ...input,
      catalog: { ...input.catalog, markets },
    });
    const plan = copyPlanFromSnapshot(source);
    yield* validateCopyPlan(plan, plan.fingerprint);
    expect(plan.snapshot.catalog.markets).toHaveLength(7);
    expect(plan.copyScope.marketIds).toHaveLength(5);
    expect(plan.copyScope.excludedRetiredMarketIds).toHaveLength(2);
    expect(plan.copyScope.marketIds).toContain(demoId('market', 'AKROS-PL'));
    const { fingerprint: _fingerprint, ...content } = plan;
    const changed = {
      ...content,
      copyScope: { ...content.copyScope, marketIds: content.copyScope.marketIds.slice(1) },
    };
    const altered = { ...changed, fingerprint: copyDigest(changed) };
    expect(Exit.isFailure(yield* Effect.exit(validateCopyPlan(altered, altered.fingerprint)))).toBe(true);
  }),
);

it.effect('refuses unapproved fingerprints, edited data and wrong destinations', () =>
  Effect.gen(function* copyTest() {
    const plan = copyPlanFromSnapshot(yield* snapshot());
    for (const [changed, approval] of [
      [plan, '0'.repeat(64)],
      [{ ...plan, snapshot: { ...plan.snapshot, revision: 43 } }, plan.fingerprint],
      [{ ...plan, destination: akrosCopySource }, plan.fingerprint],
    ] as const) {
      const result = yield* Effect.exit(validateCopyPlan(changed, approval));
      expect(Exit.isFailure(result)).toBe(true);
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('rejects media tampering even with a recalculated plan fingerprint', () =>
  Effect.gen(function* copyTest() {
    const source = yield* snapshot();
    const media = {
      contentBase64: 'YWJj',
      contentSha256: copyMediaDigest('YWJj'),
      mimeType: 'image/jpeg' as const,
    };
    const valid = copyPlanFromSnapshot({
      ...source,
      media: [{ full: media, reference: 'media:source', thumbnail: media }],
    });
    yield* validateCopyPlan(valid, valid.fingerprint);
    const damaged = copyPlanFromSnapshot({
      ...valid.snapshot,
      media: [{ ...valid.snapshot.media[0], full: { ...media, contentBase64: 'ZGVm' } }],
    });
    expect(Exit.isFailure(yield* Effect.exit(validateCopyPlan(damaged, damaged.fingerprint)))).toBe(true);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('prepares an actor-free bootstrap without carrying Core Media links across tenants', () =>
  Effect.gen(function* copyTest() {
    const source = yield* Schema.decodeUnknownEffect(CopySnapshotSchema)({
      ...snapshotInput(),
      products: [
        {
          ...product(),
          contentHistory: [
            {
              actor: { principalId: demoId('principal', 'old-person'), tenantId: akrosCopySource.tenantId },
              after: 'x',
              at,
              before: 'y',
              fields: [],
            },
          ],
          images: ['media:old-tenant', '/akros/immutable.jpg'],
          imageSrc: 'media:old-tenant',
          priceHistory: [
            {
              changedBy: { principalId: demoId('principal', 'old-person'), tenantId: akrosCopySource.tenantId },
              effectiveFrom: at,
              priceMinor: 123,
            },
          ],
        },
      ],
    });
    const prepared = yield* bootstrapCopyCatalog(source);
    expect(Schema.is(BootstrapCopyCatalogSchema)(prepared)).toBe(true);
    expect(prepared.products[0]?.product.id).toBe('product-0');
    expect(prepared.categories[0]?.id).toBe('screws');
    expect(prepared.products[0]?.product.images).toEqual(['/akros/immutable.jpg']);
    expect(prepared.products[0]?.product.imageSrc).toBe('');
    expect(prepared.products[0]?.product.contentHistory).toBeUndefined();
    expect(prepared.products[0]?.product.priceHistory[0]?.changedBy).toBeUndefined();
    expect(prepared.homepageFeaturedProductIds).toEqual(['product-0']);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('retains exact variant identities, prices, tiers and stock instead of inventing product stock', () =>
  Effect.gen(function* copyTest() {
    const source = yield* Schema.decodeUnknownEffect(CopySnapshotSchema)({
      ...snapshotInput(),
      products: [
        {
          ...product(),
          stockOnHand: 17,
          variantRecords: [
            {
              active: true,
              attributes: 'M6',
              availability: 'IN_STOCK',
              grossPriceMinor: 121,
              id: 'v-1',
              name: 'M6',
              priceHistory: [],
              priceMinor: 100,
              sku: 'SCREW-v1',
              stockOnHand: 17,
            },
          ],
          variants: [
            {
              attributes: 'M6',
              id: 'v-1',
              name: 'M6',
              priceMinor: 100,
              priceTiers: [{ minimumQuantity: 10, priceExcludingVatMinor: 80, priceMinor: 97 }],
            },
          ],
        },
      ],
    });
    const prepared = yield* bootstrapCopyCatalog(source);
    expect(prepared.products[0]?.stock).toEqual([{ quantity: 17, variantId: 'v-1' }]);
    expect(prepared.products[0]?.product.variants?.[0]?.priceTiers?.[0]?.priceMinor).toBe(97);
    const bad = { ...source, products: source.products.map((entry) => ({ ...entry, stockOnHand: 18 })) };
    expect(Exit.isFailure(yield* Effect.exit(bootstrapCopyCatalog(bad)))).toBe(true);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('captures every product detail beyond the 250-row list page, retaining ordinal order', () =>
  Effect.gen(function* copyTest() {
    const rows = Array.from({ length: 251 }, (_, index) => product(index));
    const calls: (typeof RecordsRequest.Type)[] = [];
    const client = reader((payload) => {
      calls.push(payload);
      const { view = {} } = Schema.decodeUnknownSync(readView)(payload);
      if (view.productId !== undefined) {
        return response(
          rows.filter(({ id }) => id === view.productId),
          rows.length,
        );
      }
      return response(view.limit === 0 ? [] : rows.slice(view.offset ?? 0, (view.offset ?? 0) + 250), rows.length);
    });
    const captured = yield* readCopyProducts(client);
    expect(captured.products).toHaveLength(251);
    expect(captured.products[250]?.id).toBe('product-250');
    expect(calls).toHaveLength(254);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('fails closed on a changed catalog revision and on repeated paging rows', () =>
  Effect.gen(function* copyTest() {
    for (const changedRevision of [true, false]) {
      const client = reader((payload) => {
        const { view = {} } = Schema.decodeUnknownSync(readView)(payload);
        if (view.limit === 0) {
          return response([], 251);
        }
        if (view.productId !== undefined) {
          return response([product()], 251, changedRevision ? 43 : 42);
        }
        return response([product()], 251);
      });
      const failure = yield* readCopyProducts(client).pipe(Effect.flip);
      expect(Schema.is(AkrosPlaygroundCopyError)(failure)).toBe(true);
    }
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('captures complete exception pages rather than trusting exception counts alone', () =>
  Effect.gen(function* copyTest() {
    const exceptions = Array.from({ length: 251 }, (_, index) => ({
      name: `Šroub ${index}`,
      offered: false,
      productId: `product-${index}`,
      sku: `SCREW-${index}`,
    }));
    const marketId = demoId('market', 'test');
    const client = reader((payload) => {
      const { view = {} } = Schema.decodeUnknownSync(readView)(payload);
      if (view.marketExceptions === undefined) {
        return {
          ...response([], 251),
          markets: [
            {
              currency: 'EUR',
              exceptionCounts: { notOffered: 251, offered: 0 },
              exchangeRate: '0.04',
              marketCode: 'AKROS-SK',
              marketId,
              offerMode: 'WHOLE_CATALOGUE',
              revision: 1,
              roundingMinor: 10,
              updatedAt: at,
            },
          ],
        };
      }
      const offset = view.marketExceptions.offset ?? 0;
      return {
        ...response([], 251),
        marketExceptions: { items: exceptions.slice(offset, offset + 250), marketId, total: 251 },
      };
    });
    const captured = yield* readCopyOffers(client);
    expect(captured[0]?.exceptions).toHaveLength(251);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
