import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import {
  OntosMcpTextSchema,
  OperationContextDenied,
  ReadHandlerUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { recordsRead } from '../../src/api/records.read.ts';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import {
  PRODUCT_DETAIL_PAGE_LIMIT,
  RecordsRequestSchema,
  StorefrontCatalogQuerySchema,
} from '../../shared/apis/records.ts';
import { merchandiseMcpContribution } from '../../shared/mcp/contribution.ts';

import { MinorAmountSchema } from '../../shared/domain/merchandise-model.ts';

type StorefrontCatalogQueryInput = typeof StorefrontCatalogQuerySchema.Encoded;

const isPayload = Schema.is(MerchandiseCommandPayloadSchema);

it('accepts a CreateOrder command with a caller-supplied order id', () => {
  expect(
    isPayload({
      command: {
        _tag: 'CreateOrder',
        id: 'order-1',
        lines: [{ productId: 'product-1', quantity: 2 }],
        partyId: 'party-1',
      },
      expectedRevision: 0,
    }),
  ).toBe(true);
});

it('rejects a VAT rate outside 0, 10, 12, 21', () => {
  expect(
    isPayload({
      command: {
        _tag: 'CreateProduct',
        active: true,
        category: 'IT',
        lowStockThreshold: 2,
        name: 'Kabel',
        priceMinor: 19_900,
        sku: 'KAB-1',
        unit: 'ks',
        // A rate instead of a classification: Tax holds rates, products only name their classification.
        vatRate: 21,
      },
      expectedRevision: 0,
    }),
  ).toBe(false);
});

it('keeps ORDER out of manual stock movement reasons', () => {
  expect(
    isPayload({
      command: { _tag: 'RecordStockMovement', delta: -1, productId: 'product-1', reason: 'ORDER' },
      expectedRevision: 0,
    }),
  ).toBe(false);
});

it('rejects fractional money amounts', () => {
  expect(Schema.is(MinorAmountSchema)(199.5)).toBe(false);
  expect(Schema.is(MinorAmountSchema)(19_950)).toBe(true);
});

it('tells agents that a records page without summary holds at most the detail cap of products', () => {
  const { description } = merchandiseMcpContribution.reads.records;
  expect(Schema.is(OntosMcpTextSchema)(description)).toBe(true);
  expect(description.en).toContain(
    `a page holds at most ${PRODUCT_DETAIL_PAGE_LIMIT} products regardless of view.limit; read lists with view.summary: true`,
  );
  expect(description.cs).toContain(
    `stránka má nejvýš ${PRODUCT_DETAIL_PAGE_LIMIT} produkty bez ohledu na view.limit; seznamy čtěte s view.summary: true`,
  );
});

it('accepts a records request with no view and with a view filter', () => {
  expect(Schema.is(RecordsRequestSchema)({})).toBe(true);
  expect(Schema.is(RecordsRequestSchema)({ view: { lowStockOnly: true, orderStatus: 'NEW' } })).toBe(true);
});

const catalogScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '11111111-1111-4111-8111-111111111111',
    authContextRef: 'better-auth-session:catalog-contract',
    authMethod: 'session',
    legalEntityId: '44444444-4444-4444-8444-444444444444',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
  }),
  correlationId: 'catalog-contract',
};
const operationTime = new Date('2026-10-24T12:00:00.000Z');
// Deliberately not sorted by id/name: the owner must preserve catalog ordinal order.
const catalogCategoryRow = (id: string, parentId: string | null, published = true) => ({
  description: null,
  hasChildren: false,
  heading: null,
  history: null,
  id,
  imageAlt: null,
  imageSrc: null,
  longDescription: null,
  name: id,
  parentId,
  position: 0,
  published,
  slug: id,
});
const catalogCategoryRows = [
  catalogCategoryRow('z-root', null),
  catalogCategoryRow('b-child', 'z-root'),
  catalogCategoryRow('hidden', null, false),
  catalogCategoryRow('hidden-child', 'hidden'),
  catalogCategoryRow('a-root', null),
];
const catalogInvocation = (query: StorefrontCatalogQueryInput) => ({
  input: { view: { storefront: true, storefrontCatalog: Schema.decodeSync(StorefrontCatalogQuerySchema)(query) } },
  principal: catalogScope,
  registration: recordsRead,
  transport: { correlationId: catalogScope.correlationId },
});

it('accepts explicit category-only and product modes through the public catalog contract', () => {
  for (const mode of ['categories', 'products']) {
    expect(Schema.is(RecordsRequestSchema)({ view: { storefront: true, storefrontCatalog: { mode } } })).toBe(true);
  }
  expect(Schema.is(RecordsRequestSchema)({ view: { storefront: true, storefrontCatalog: { mode: 'unknown' } } })).toBe(
    false,
  );
});

it.layer(NodeCrypto.layer)('Merchandise governed catalog reads', (suite) => {
  suite.effect('category-only governed reads execute no product SQL and preserve published navigation order', () =>
    Effect.gen(function* categoryOnlyRead() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        executeOwnerQuery: ({ params, scope, sql }) => {
          expect(scope).toEqual({ legalEntityId: catalogScope.legalEntityId, tenantId: catalogScope.tenantId });
          expect(params).toContain(catalogScope.tenantId);
          expect(params).toContain(catalogScope.legalEntityId);
          if (sql.includes('from "demo_merchandise"."catalog_heads"')) {
            return Effect.succeed([
              {
                aiChanges: null,
                bootstrapCheckpoint: null,
                homepageFeaturedProductIds: ['private-product-id'],
                revision: 7,
                taxRates: null,
              },
            ]);
          }
          if (sql.includes('from "demo_merchandise"."categories"')) {
            expect(sql).toContain('order by "demo_merchandise"."categories"."ordinal" asc');
            return Effect.succeed(catalogCategoryRows);
          }
          return Effect.die(`Unexpected owner SQL: ${sql}`);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: merchandiseRegistration,
        scope: catalogScope,
      });
      const result = yield* harness.runtime
        .runRead(catalogInvocation({ includeCategories: true, mode: 'categories' }))
        .pipe(Effect.provide(harness.layer), Effect.provideService(AccessDecisionGate, gate.accessDecision));
      expect(result.products).toEqual([]);
      expect(result.orders).toEqual([]);
      expect(result.movements).toEqual([]);
      expect(result.revision).toBe(7);
      expect(result.categories?.map((category) => category.id)).toEqual(['z-root', 'b-child', 'a-root']);
      expect(result.categories?.every((category) => !('history' in category))).toBe(true);
      expect(result.indicators.productCount).toBe(0);
      for (const key of ['page', 'pageSize', 'total', 'totalProducts', 'homepageFeaturedProductIds']) {
        expect(result).not.toHaveProperty(key);
      }
      const { evidenceWrites, ownerQueries, stages } = harness.snapshot();
      expect(ownerQueries).toHaveLength(2);
      expect(ownerQueries.every(({ sql }) => !/products|product_variants|price_tiers/u.test(sql))).toBe(true);
      expect(evidenceWrites).toBe(1);
      expect(stages).toContain('result_decoded');
    }),
  );

  suite.effect('ordinary catalog modes still count/page products and return the identical visible category tree', () =>
    Effect.gen(function* ordinaryCatalogRead() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        executeOwnerQuery: ({ sql }) => {
          if (sql.includes('from "demo_merchandise"."products"')) {
            expect(sql).toContain('count(*)::int');
            expect(sql).toContain('"demo_merchandise"."price_tiers"');
            // The left-joined page is empty; Drizzle still maps its head and total.
            return Effect.succeed([
              [
                { homepageFeaturedProductIds: ['featured-id'], revision: 7 },
                // Twelve nullable product columns, the company's tax rates, then the total, in native SQL row order.
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                0,
              ],
            ]);
          }
          if (sql.includes('from "demo_merchandise"."categories"')) {
            return Effect.succeed(catalogCategoryRows);
          }
          return Effect.die(`Unexpected owner SQL: ${sql}`);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: merchandiseRegistration,
        scope: catalogScope,
      });
      const queries: readonly StorefrontCatalogQueryInput[] = [
        { fields: 'card', includeCategories: true },
        { fields: 'card', includeCategories: true, mode: 'products' },
      ];
      for (const query of queries) {
        const result = yield* harness.runtime
          .runRead(catalogInvocation(query))
          .pipe(Effect.provide(harness.layer), Effect.provideService(AccessDecisionGate, gate.accessDecision));
        expect(result).toMatchObject({
          homepageFeaturedProductIds: ['featured-id'],
          page: 1,
          pageSize: 24,
          products: [],
          revision: 7,
          total: 0,
          totalProducts: 0,
        });
        expect(result.categories?.map((category) => category.id)).toEqual(['z-root', 'b-child', 'a-root']);
      }
      expect(harness.snapshot().ownerQueries).toHaveLength(4);
    }),
  );

  suite.effect('category-only reads reject a cross-tenant principal before owner SQL', () =>
    Effect.gen(function* crossTenantCategories() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        executeOwnerQuery: () => Effect.die('Cross-tenant owner SQL must not run'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: merchandiseRegistration,
        scope: catalogScope,
      });
      const failure = yield* harness.runtime
        .runRead({
          ...catalogInvocation({ mode: 'categories' }),
          principal: { ...catalogScope, tenantId: '55555555-5555-4555-8555-555555555555' },
        })
        .pipe(
          Effect.provide(harness.layer),
          Effect.provideService(AccessDecisionGate, gate.accessDecision),
          Effect.flip,
        );
      expect(Schema.is(OperationContextDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );

  suite.effect('category-only reads of a company without a catalog head answer an empty tree at revision 0', () =>
    Effect.gen(function* missingCategoryHead() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
      const tables: string[] = [];
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        executeOwnerQuery: ({ sql }) => {
          tables.push(sql.includes('"demo_merchandise"."catalog_heads"') ? 'head' : 'other');
          expect(sql.startsWith('select') || sql.startsWith('with')).toBe(true);
          return Effect.succeed([]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: merchandiseRegistration,
        scope: catalogScope,
      });
      const result = yield* harness.runtime
        .runRead(catalogInvocation({ mode: 'categories' }))
        .pipe(Effect.provide(harness.layer), Effect.provideService(AccessDecisionGate, gate.accessDecision));
      expect(result).toMatchObject({ products: [], revision: 0 });
      // The head is read, never written: a read creates no catalog row.
      expect(tables[0]).toBe('head');
    }),
  );
  suite.effect('unfinished bootstrap rejects category reads before any partial category data escapes', () =>
    Effect.gen(function* unfinishedBootstrap() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        executeOwnerQuery: ({ sql }) => {
          expect(sql).toContain('from "demo_merchandise"."catalog_heads"');
          return Effect.succeed([
            {
              aiChanges: null,
              bootstrapCheckpoint: { status: 'IMPORTING' },
              homepageFeaturedProductIds: [],
              revision: 0,
            },
          ]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: merchandiseRegistration,
        scope: catalogScope,
      });
      const failure = yield* harness.runtime
        .runRead(catalogInvocation({ mode: 'categories' }))
        .pipe(
          Effect.provide(harness.layer),
          Effect.provideService(AccessDecisionGate, gate.accessDecision),
          Effect.flip,
        );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().evidenceWrites).toBe(0);
    }),
  );
});
