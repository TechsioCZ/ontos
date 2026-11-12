// Storefront reads (merchandise-queries.ts) against PostgreSQL: the catalog is written with `replaceSnapshot` into
// a fresh company scope, then the bounded SQL reads are asserted.
import { randomUUID } from 'node:crypto';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabase,
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';

import {
  MerchandiseCommandSchema,
  MerchandiseNotFound,
  MerchandiseRevisionConflict,
  merchandiseMarketCommandSchemas,
} from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { RecordsViewSchema, StorefrontCatalogQuerySchema } from '../../shared/apis/records.ts';
import { MarketIdSchema, convertGrossMinor } from '../../shared/domain/market-offers.ts';

import {
  categoryTree,
  indicators,
  orderPage,
  productCategoryCounts,
  productMovements,
  staffProducts,
  storefrontOrderStatus,
  storefrontCustomerOrders,
  storefrontProducts,
} from '../../src/services/merchandise-queries.ts';
import {
  catalogHeads,
  merchandiseRelations,
  priceTiers,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import { resetToAkrosBaseline } from '../../src/services/akros-demo-reset.ts';
import { applyMarketCommand } from '../../src/services/market-commands.ts';
import {
  catalogMarketScope,
  listMarkets,
  loadMarket,
  loadOrderMarketContext,
  marketExceptionPage,
  productMarketRows,
} from '../../src/services/market-store.ts';
import {
  loadHead,
  loadWorkingSet,
  persistChange,
  productSearchText,
  whereScope,
} from '../../src/services/merchandise-store.ts';
import type { MerchandiseDb, StoreScope } from '../../src/services/merchandise-store.ts';
import { evolveMerchandiseState, workingSetRequestOf } from '../../src/services/persistence.service.ts';
import type { MerchandiseFixture } from './support/merchandise-database.ts';
import {
  catalogInput,
  catalogState,
  decodeState,
  encodeState,
  withMerchandise,
} from './support/merchandise-database.ts';
import { TEST_RATES, TEST_TAX } from '../support/tax-fixtures.ts';

type RecordsViewInput = typeof RecordsViewSchema.Encoded;
type StorefrontCatalogQueryInput = typeof StorefrontCatalogQuerySchema.Encoded;

type StaffProductPage = Effect.Success<ReturnType<typeof staffProducts>>;
type OrderPage = Effect.Success<ReturnType<typeof orderPage>>;
type StorefrontProductPage = Effect.Success<ReturnType<typeof storefrontProducts>>;
const staffProductIds = (page: Pick<StaffProductPage, 'products'>) => page.products.map((product) => product.id);
const staffProductPageSummary = (page: Pick<StaffProductPage, 'products' | 'total'>) => [
  page.total,
  staffProductIds(page),
];
const orderPageSummary = (page: OrderPage) => [page.total, page.orders.map((order) => order.id)];
const orderIdsFor = (fixture: Pick<MerchandiseFixture, 'db' | 'scope'>) => (view: RecordsViewInput) =>
  orderPage(fixture.db, fixture.scope, Schema.decodeSync(RecordsViewSchema)(view)).pipe(Effect.map(orderPageSummary));
const firstVariantSummary = (page: StorefrontProductPage) => page.products[0]?.variantSummary;

const catalogPage = ({ db, scope }: MerchandiseFixture, query: StorefrontCatalogQueryInput) =>
  storefrontProducts(db, scope, { query: Schema.decodeSync(StorefrontCatalogQuerySchema)(query) });

const catalogVariantSummary = (target: MerchandiseFixture) =>
  catalogPage(target, { fields: 'card', productIds: ['p1'] }).pipe(Effect.map(firstVariantSummary));

/** Listing ids (cards: a full page holds at most two products). */
const idsOf = (fixture: MerchandiseFixture, query: StorefrontCatalogQueryInput) =>
  catalogPage(fixture, { fields: 'card', ...query }).pipe(Effect.map(staffProductIds));

const onCatalog = <A, E>(run: (fixture: MerchandiseFixture) => Effect.Effect<A, E>) =>
  withMerchandise(catalogState, run);

it.live('previews only the first three active sellable variant names without hydrating card variants', () => {
  const variants = [
    { active: false, attributes: '', id: 'hidden-size', name: 'Hidden size', priceMinor: 100 },
    { attributes: '', id: 'first', name: '8,5 - ML', priceMinor: 100 },
    { attributes: '', id: 'second', name: '6,5 - XS', priceMinor: 100 },
    { attributes: '', id: 'third', name: '7 - S', priceMinor: 100 },
    { attributes: '', id: 'fourth', name: '9 - L', priceMinor: 100 },
    { attributes: '', name: 'Descriptive option without a sellable identity' },
  ];
  const state = decodeState({
    ...catalogInput,
    movements: [],
    orders: [],
    products: [{ ...catalogInput.products[0], variants }],
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* cardVariantPreview() {
      const page = yield* catalogPage(fixture, { fields: 'card' });
      expect(page.products[0]?.storefrontVariantPreview).toEqual({
        total: 4,
        variants: [
          { id: 'first', name: '8,5 - ML' },
          { id: 'second', name: '6,5 - XS' },
          { id: 'third', name: '7 - S' },
        ],
      });
      expect(page.products[0]?.variantSummary?.count).toBe(4);
      expect(page.products[0]).not.toHaveProperty('variantRecords');
      expect(page.products[0]).not.toHaveProperty('variants');
      expect(page.products[0]).not.toHaveProperty('description');
      expect(page.products[0]?.availability).toBe('OUT_OF_STOCK');
      const staff = yield* staffProducts(
        fixture.db,
        fixture.scope,
        Schema.decodeSync(RecordsViewSchema)({ productId: 'p1', summary: true }),
        false,
      );
      expect(staff.products[0]).not.toHaveProperty('storefrontVariantPreview');
    }),
  );
});

it.live('retains card24 pagination and full2 limits while projecting empty variant previews', () => {
  const state = decodeState({
    ...catalogInput,
    movements: [],
    orders: [],
    products: Array.from({ length: 25 }, (_, index) => ({
      ...catalogInput.products[0],
      id: `preview-${index}`,
      sku: `preview-${index}`,
      slug: `preview-${index}`,
      variants: [],
    })),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* cardPreviewPaging() {
      const first = yield* catalogPage(fixture, { fields: 'card', pageSize: 24 });
      const second = yield* catalogPage(fixture, { fields: 'card', page: 2, pageSize: 24 });
      const full = yield* catalogPage(fixture, { fields: 'full', pageSize: 24 });
      expect(first.total).toBe(25);
      expect(first.pageSize).toBe(24);
      expect(first.products).toHaveLength(24);
      expect(second.products).toHaveLength(1);
      expect(new Set([...first.products, ...second.products].map((product) => product.id)).size).toBe(25);
      expect(first.products.every((product) => product.storefrontVariantPreview?.total === 0)).toBe(true);
      expect(first.products[0]?.storefrontVariantPreview?.variants).toEqual([]);
      expect(full.pageSize).toBe(2);
      expect(full.products).toHaveLength(2);
    }),
  );
});

it.live('hides unpublished products and returns the storefront category tree without history', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase1() {
      const page = yield* catalogPage(fixture, { fields: 'card' });
      expect(page.total).toBe(3);
      expect(page.products.map((product) => product.id)).toEqual(['p1', 'p2', 'p3']);
      const tree = yield* categoryTree(fixture.db, fixture.scope, { storefront: true });
      expect(tree.map((category) => category.id)).toEqual(['r', 'c']);
      expect(tree.every((category) => !('history' in category))).toBe(true);
    }),
  ),
);

it.live('filters by category slug including descendants through categoryPathIds', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase2() {
      expect(yield* idsOf(fixture, { categorySlug: 'srouby' })).toEqual(['p1', 'p3']);
      expect(yield* idsOf(fixture, { categorySlug: 'metricke' })).toEqual(['p1']);
      expect((yield* catalogPage(fixture, { categorySlug: 'neexistuje' })).total).toBe(0);
    }),
  ),
);

it.live('resolves a storefront category slug within the product statement without a lookup round trip', () =>
  Effect.gen(function* categoryProductRoundTrips() {
    const statements: { readonly parameters: readonly unknown[]; readonly text: string }[] = [];
    const db = yield* makeTestDatabase((text, parameters) =>
      Effect.sync(() => {
        statements.push({ parameters, text });
        return [];
      }),
    );
    const scope = {
      legalEntityId: '00000000-0000-4000-8000-000000000001',
      tenantId: '00000000-0000-4000-8000-000000000002',
    };
    const failure = yield* storefrontProducts(db, scope, {
      query: { categorySlug: 'missing-category', fields: 'card' },
    }).pipe(Effect.flip);
    expect(failure.reason).toBe('The storefront catalog is not initialized');
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain('"demo_merchandise"."categories"');
    expect(statements[0]?.text).toContain('"category_path_ids" @> array[');
    expect(statements[0]?.parameters).toContain('missing-category');
    expect(statements[0]?.parameters).toContain(scope.tenantId);
    expect(statements[0]?.parameters).toContain(scope.legalEntityId);
  }),
);

it.live('resolves the active category slug within the tree statement without a lookup round trip', () =>
  Effect.gen(function* categoryTreeRoundTrips() {
    const statements: { readonly parameters: readonly unknown[]; readonly text: string }[] = [];
    const db = yield* makeTestDatabase((text, parameters) =>
      Effect.sync(() => {
        statements.push({ parameters, text });
        return [];
      }),
    );
    const scope = {
      legalEntityId: '00000000-0000-4000-8000-000000000001',
      tenantId: '00000000-0000-4000-8000-000000000002',
    };
    expect(yield* categoryTree(db, scope, { activeSlug: 'missing-category', storefront: true })).toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain('"demo_merchandise"."categories"');
    expect(statements[0]?.parameters).toContain('missing-category');
    expect(statements[0]?.parameters).toContain(scope.tenantId);
    expect(statements[0]?.parameters).toContain(scope.legalEntityId);
  }),
);

const categoryContentRow = (id: string, parentId: string | null, published = true) => [
  `Description ${id}`,
  true,
  `Heading ${id}`,
  null,
  id,
  `Image ${id}`,
  `/images/${id}.jpg`,
  `Long ${id}`,
  id,
  parentId,
  0,
  published,
  id,
];

it.live('projects compact category content identically to the full tree and hides unpublished ancestors', () =>
  Effect.gen(function* compactCategoryContent() {
    const db = yield* makeTestDatabase(() =>
      Effect.succeed([
        categoryContentRow('root', null),
        categoryContentRow('active', 'root'),
        categoryContentRow('child', 'active'),
        categoryContentRow('other', 'root'),
        categoryContentRow('hidden', 'root', false),
        categoryContentRow('hidden-child', 'hidden'),
      ]),
    );
    const scope = {
      legalEntityId: '00000000-0000-4000-8000-000000000001',
      tenantId: '00000000-0000-4000-8000-000000000002',
    };
    const full = yield* categoryTree(db, scope, { activeSlug: 'active', storefront: true });
    const compact = yield* categoryTree(db, scope, { activeSlug: 'active', contentOnly: true, storefront: true });
    expect(compact).toEqual(
      full.filter((node) => node.id === 'active' || Option.getOrNull(node.parentId) === 'active'),
    );
    expect(compact.map((node) => node.id)).toEqual(['active', 'child']);
    expect(compact[0]).toMatchObject({
      description: 'Description active',
      heading: 'Heading active',
      longDescription: 'Long active',
    });
    expect(compact[1]).toMatchObject({ imageAlt: 'Image child', imageSrc: '/images/child.jpg' });
    expect(yield* categoryTree(db, scope, { activeSlug: 'hidden', contentOnly: true, storefront: true })).toEqual([]);
    expect(yield* categoryTree(db, scope, { activeSlug: 'missing', contentOnly: true, storefront: true })).toEqual([]);
  }),
);

const node = (id: string, parentId: string | null, published = true) => ({
  ...catalogInput.categories[0],
  id,
  parentId,
  published,
  slug: id,
});

it.live('reads compact content with the full tree visibility rules across ancestors, cycles and company scopes', () => {
  const state = decodeState({
    ...catalogInput,
    categories: [
      node('root', null),
      node('active', 'root'),
      node('child', 'active'),
      node('grandchild', 'child'),
      node('hidden', 'root', false),
      node('hidden-active', 'hidden'),
      node('hidden-child', 'hidden-active'),
      node('cycle-a', 'cycle-b'),
      node('cycle-b', 'cycle-a'),
      node('orphan', 'missing-parent'),
      ...Array.from({ length: 100 }, (_, index) => node(`unrelated-${index}`, 'root')),
    ],
  });
  return withMerchandise(state, (fixture) =>
    // Matching ids in another company must not hide or enrich this company's branch.
    withMerchandise(
      decodeState({ ...catalogInput, categories: [node('root', null, false), node('active', 'root', false)] }),
      () =>
        Effect.gen(function* compactStoredBranches() {
          for (const activeId of ['active', 'hidden-active', 'cycle-a', 'orphan', 'missing']) {
            const full = yield* categoryTree(fixture.db, fixture.scope, { activeId, storefront: true });
            const expected = full.filter(
              (category) => category.id === activeId || Option.getOrNull(category.parentId) === activeId,
            );
            for (const selector of [{ activeId }, { activeSlug: activeId }]) {
              expect(
                yield* categoryTree(fixture.db, fixture.scope, {
                  ...selector,
                  contentOnly: true,
                  storefront: true,
                }),
              ).toEqual(expected);
            }
          }
          expect(
            (yield* categoryTree(fixture.db, fixture.scope, {
              activeSlug: 'active',
              contentOnly: true,
              storefront: true,
            })).map((category) => category.id),
          ).toEqual(['active', 'child']);
          expect(
            yield* categoryTree(fixture.db, fixture.scope, {
              activeSlug: 'hidden-active',
              contentOnly: true,
              storefront: true,
            }),
          ).toEqual([]);
        }),
    ),
  );
});

it.live('lists featured products in homepage order followed by recommended ones', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase3() {
      expect(yield* idsOf(fixture, { featured: true })).toEqual(['p3', 'p1']);
    }),
  ),
);

it.live('takes the homepage order from the products featured positions, not from a stored list', () =>
  withMerchandise(decodeState({ ...catalogInput, homepageFeaturedProductIds: ['p1'] }), (fixture) =>
    Effect.gen(function* featuredFromPositions() {
      // The stored list names p1 only, but p3 holds the first featured position; the homepage follows the positions.
      expect(yield* idsOf(fixture, { featured: true })).toEqual(['p3', 'p1']);
      const result = yield* catalogPage(fixture, { featured: true, fields: 'card' });
      // The head lists only products with a featured position; recommended ones follow in the listing, not in the list.
      expect(result.head).toEqual({ homepageFeaturedProductIds: ['p3'], revision: fixture.revision });
    }),
  ),
);

it.live('filters by label', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase4() {
      expect(yield* idsOf(fixture, { label: 'sale' })).toEqual(['p2']);
      expect(yield* idsOf(fixture, { label: 'recommended' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { label: 'new' })).toEqual([]);
    }),
  ),
);

it.live('searches name, sku and variant text case-insensitively', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase5() {
      expect(yield* idsOf(fixture, { q: 'm8' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'p1-m8' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'p2' })).toEqual(['p2']);
    }),
  ),
);

it.live('ignores diacritics and word order and searches parameters', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase6() {
      expect(yield* idsOf(fixture, { q: 'sroub' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'ŠROUB' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'zinkovany sroub' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'nerez a2' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'sroub neexistuje' })).toEqual([]);
      // LIKE wildcards in the query are literal text, not patterns.
      expect(yield* idsOf(fixture, { q: '%' })).toEqual([]);
      expect(yield* idsOf(fixture, { q: '_' })).toEqual([]);
    }),
  ),
);

const searchVariant = (key: string, activity: Option.Option<boolean> = Option.none()) => {
  const variant = {
    attributes: `attribute-${key}`,
    id: `variant-${key}`,
    name: `name-${key}`,
    parameters: [{ label: `label-${key}`, unit: `unit-${key}`, value: `value-${key}` }],
    priceMinor: 100,
    sku: `SKU-${key}`,
  };
  return Option.match(activity, { onNone: () => variant, onSome: (active) => ({ ...variant, active }) });
};

const variantSearchState = decodeState({
  ...catalogInput,
  products: [
    {
      ...catalogInput.products[0],
      variants: [
        searchVariant('enabled', Option.some(true)),
        searchVariant('legacy'),
        searchVariant('disabled', Option.some(false)),
        // Active informational text remains searchable; activity is not a new price/identity requirement.
        { attributes: 'informational-legacy', name: 'Informational' },
      ],
    },
  ],
});

it.live('search excludes inactive-only variant SKU, name, attributes and parameter text in card and full reads', () =>
  withMerchandise(variantSearchState, (fixture) =>
    Effect.gen(function* inactiveVariantSearch() {
      for (const q of [
        'SKU-disabled',
        'name-disabled',
        'attribute-disabled',
        'label-disabled',
        'value-disabled',
        'unit-disabled',
      ]) {
        for (const fields of ['card', 'full'] as const) {
          const page = yield* catalogPage(fixture, { fields, q });
          expect([page.total, staffProductIds(page)]).toEqual([0, []]);
        }
        const staff = yield* staffProducts(fixture.db, fixture.scope, { search: q, summary: true }, false);
        expect(staffProductPageSummary(staff)).toEqual([0, []]);
      }
      // A product-level word cannot rescue an inactive-only word in an AND search.
      expect(yield* idsOf(fixture, { q: 'ŠROUB SKU-disabled' })).toEqual([]);
      // Inactive variants still exist for owner detail/history; search must not delete them.
      const detail = yield* catalogPage(fixture, { productIds: ['p1'] });
      expect(detail.products[0]?.variantRecords?.map((variant) => [variant.id, variant.active])).toEqual([
        ['variant-enabled', true],
        ['variant-legacy', true],
        ['variant-disabled', false],
      ]);
    }),
  ),
);

it.live(
  'search treats explicit active and unset variants alike without changing informational or product matches',
  () =>
    withMerchandise(variantSearchState, (fixture) =>
      Effect.gen(function* activeAndUnsetVariantSearch() {
        for (const key of ['enabled', 'legacy']) {
          for (const q of [
            `SKU-${key}`,
            `name-${key}`,
            `attribute-${key}`,
            `label-${key}`,
            `value-${key}`,
            `unit-${key}`,
            `value-${key} ŠROUB`,
          ]) {
            for (const fields of ['card', 'full'] as const) {
              const page = yield* catalogPage(fixture, { fields, q });
              expect([page.total, staffProductIds(page)]).toEqual([1, ['p1']]);
            }
          }
        }
        expect(yield* idsOf(fixture, { q: 'informational-legacy' })).toEqual(['p1']);
        expect(yield* idsOf(fixture, { q: 'nerez a2' })).toEqual(['p1']);
        expect(yield* idsOf(fixture, { q: 'p1' })).toEqual(['p1']);
        const page = yield* catalogPage(fixture, { fields: 'card', q: 'SKU-legacy' });
        expect(page.products[0]?.variantRecords).toBeUndefined();
        expect(page.products[0]?.variantSummary?.count).toBe(2);
      }),
    ),
);

const searchStateWithActivity = (state: MerchandiseState, activity: Option.Option<boolean>): MerchandiseState => ({
  ...state,
  products: state.products.map((product) => ({
    ...product,
    variants: (product.variants ?? []).map((variant) => {
      if (variant.id !== 'variant-legacy') {
        return variant;
      }
      const { active: _active, ...rest } = variant;
      void _active;
      return Option.match(activity, { onNone: () => rest, onSome: (active) => ({ ...rest, active }) });
    }),
  })),
});

const changeSearchVariantActivity = (fixture: MerchandiseFixture, activity: Option.Option<boolean>) =>
  fixture.db.transaction((transaction) =>
    Effect.gen(function* changeVariantActivity() {
      const head = yield* loadHead(transaction, fixture.scope, { lock: true });
      if (head === undefined) {
        return yield* Effect.die('The search fixture must have a catalog head');
      }
      const working = yield* loadWorkingSet(transaction, fixture.scope, head, { productIds: ['p1'] });
      const changed = searchStateWithActivity(working.state, activity);
      const revision = yield* persistChange(
        transaction,
        fixture.scope,
        working,
        changed,
        DateTime.makeUnsafe(catalogInput.products[0].updatedAt),
        TEST_RATES,
      );
      expect(revision).toBe(head.revision + 1);
      return revision;
    }),
  );

it.live('rewrites variant search text on activity changes through the owner persistence path', () =>
  withMerchandise(variantSearchState, (fixture) =>
    Effect.gen(function* variantSearchActivityChanges() {
      for (const activity of [Option.some(false), Option.some(true), Option.none<boolean>()]) {
        yield* changeSearchVariantActivity(fixture, activity);
        for (const q of ['SKU-legacy', 'value-legacy']) {
          expect(yield* idsOf(fixture, { q })).toEqual(Option.contains(activity, false) ? [] : ['p1']);
        }
        expect(yield* idsOf(fixture, { q: 'SKU-disabled' })).toEqual([]);
      }
    }),
  ),
);

/** Test-only runtime transaction: exercise the existing session-setting RLS policy, not the admin fixture. */
const scopedSearchRead = <A, E>(
  db: MerchandiseFixture['db'],
  scope: StoreScope,
  run: (transaction: MerchandiseDb) => Effect.Effect<A, E>,
) =>
  db.transaction((transaction) =>
    Effect.gen(function* scopedVariantSearch() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true),
          set_config('ontos.legal_entity_id', ${scope.legalEntityId}, true)`,
        'objects',
      );
      return yield* run(transaction);
    }),
  );

const runtimeSearch = (db: MerchandiseDb, scope: StoreScope, q: string) =>
  storefrontProducts(db, scope, { query: { fields: 'card', q } });

const assertOwnSearchScope = (db: MerchandiseFixture['db'], scope: StoreScope, otherScope: StoreScope) =>
  scopedSearchRead(db, scope, (transaction) =>
    Effect.gen(function* ownSearchScope() {
      expect(yield* transaction.select({ id: products.id }).from(products)).toEqual([{ id: 'p1' }]);
      expect(staffProductIds(yield* runtimeSearch(transaction, scope, 'SKU-legacy'))).toEqual(['p1']);
      expect((yield* runtimeSearch(transaction, scope, 'SKU-disabled')).total).toBe(0);
      // Row security hides the other company's head and products alike: its catalog reads as empty, never as data.
      const foreign = yield* runtimeSearch(transaction, otherScope, 'SKU-legacy');
      expect({ products: foreign.products, total: foreign.total }).toEqual({ products: [], total: 0 });
    }),
  );

const runtimeSearchChecks = (fixture: MerchandiseFixture, otherScope: StoreScope) =>
  Effect.scoped(
    Effect.gen(function* runtimeVariantSearch() {
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.runtime.connectionString);
      const runtime = yield* makeTestDatabaseFromClient(client, merchandiseRelations);
      // No scope sees no rows, even without an application WHERE predicate.
      expect(yield* runtime.select({ id: products.id }).from(products)).toEqual([]);
      yield* assertOwnSearchScope(runtime, fixture.scope, otherScope);
      for (const scope of [
        { ...fixture.scope, tenantId: randomUUID() },
        { ...fixture.scope, legalEntityId: randomUUID() },
      ]) {
        expect(
          yield* scopedSearchRead(runtime, scope, (transaction) =>
            transaction.select({ id: products.id }).from(products),
          ),
        ).toEqual([]);
      }
      yield* fixture.db
        .update(catalogHeads)
        .set({ bootstrapCheckpoint: { status: 'RUNNING' } })
        .where(whereScope(catalogHeads, fixture.scope));
      const unverified = yield* scopedSearchRead(runtime, fixture.scope, (transaction) =>
        runtimeSearch(transaction, fixture.scope, 'SKU-legacy'),
      ).pipe(Effect.flip);
      expect(unverified).toMatchObject({ reason: 'The storefront catalog is not initialized' });
    }),
  );

it.live('keeps variant search scoped under the runtime role and fails closed on an unverified catalog', () =>
  withMerchandise(variantSearchState, (fixture) =>
    withMerchandise(variantSearchState, (other) => runtimeSearchChecks(fixture, other.scope)),
  ),
);

it.live('applies publication, activity, archive and pagination gates to active variant search matches', () => {
  const state = decodeState({
    ...catalogInput,
    products: [
      { id: 'visible-a', published: true },
      { id: 'visible-b' },
      { active: false, id: 'inactive' },
      { id: 'unpublished', published: false },
      {
        demoArchive: {
          actor: {
            principalId: '20000000-0000-4000-8000-000000000002',
            tenantId: '20000000-0000-4000-8000-000000000001',
          },
          at: catalogInput.products[0].updatedAt,
          reason: 'Archived test product',
        },
        id: 'archived',
      },
    ].map((product) => ({
      ...catalogInput.products[0],
      ...product,
      name: product.id,
      sku: product.id,
      variants: [searchVariant('visible')],
    })),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* visibleVariantSearchPages() {
      for (const [page, ids] of [
        [1, ['visible-a']],
        [2, ['visible-b']],
        [3, []],
      ] as const) {
        const result = yield* catalogPage(fixture, { fields: 'card', page, pageSize: 1, q: 'SKU-visible' });
        expect([result.total, result.page, result.pageSize, staffProductIds(result)]).toEqual([2, page, 1, ids]);
      }
      const full = yield* catalogPage(fixture, { pageSize: 24, q: 'SKU-visible' });
      expect([full.total, full.pageSize, staffProductIds(full)]).toEqual([2, 2, ['visible-a', 'visible-b']]);
    }),
  );
});

it.live('sends heading and long description only for the requested category', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase7() {
      const tree = yield* categoryTree(fixture.db, fixture.scope, { activeSlug: 'metricke', storefront: true });
      const active = tree.find((category) => category.id === 'c');
      const root = tree.find((category) => category.id === 'r');
      expect(active?.longDescription).toBe('Dlouhý popis');
      expect(active?.heading).toBe('Metrické');
      expect(root?.longDescription).toBeUndefined();
      expect(root?.heading).toBeUndefined();
      // Roots always carry their tile content.
      expect(root?.description).toBe('Krátký popis');
      expect(root?.imageAlt).toBe('Šrouby');
    }),
  ),
);

it.live('pages results while keeping the total', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase8() {
      const result = yield* catalogPage(fixture, { page: 2, pageSize: 2 });
      expect(result.products.map((product) => product.id)).toEqual(['p3']);
      expect(result.total).toBe(3);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(2);
      expect(result.head).toEqual({ homepageFeaturedProductIds: ['p3'], revision: fixture.revision });
      // A full page never holds more than two products; cards honour the requested size.
      expect((yield* catalogPage(fixture, { pageSize: 10 })).products.length).toBe(2);
      expect((yield* catalogPage(fixture, { fields: 'card', pageSize: 10 })).products.length).toBe(3);
      const beyondEnd = yield* catalogPage(fixture, { page: 10, pageSize: 2 });
      expect(beyondEnd.products).toEqual([]);
      expect(beyondEnd.total).toBe(3);
      const missing = yield* catalogPage(fixture, { slug: 'not-a-product' });
      expect(missing.products).toEqual([]);
      expect(missing.total).toBe(0);
      const summary = yield* staffProducts(fixture.db, fixture.scope, { limit: 0, summary: true }, false);
      expect(summary.products).toEqual([]);
      expect(summary.total).toBe(4);
    }),
  ),
);

it.live('answers an empty catalog at revision 0 when the company has no catalog head', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* assertMissingHead() {
      const page = yield* storefrontProducts(
        db,
        { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000001' },
        { query: { fields: 'card' } },
      );
      expect({ head: page.head, products: page.products, total: page.total }).toEqual({
        head: { homepageFeaturedProductIds: [], revision: 0 },
        products: [],
        total: 0,
      });
      const searched = yield* storefrontProducts(
        db,
        { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000001' },
        { query: { fields: 'card', q: 'sroub' } },
      );
      expect(searched.total).toBe(0);
    }),
  ),
);

it.live('returns the full product shape with derived paragraphs, gallery and variant records', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase9() {
      const [product] = (yield* catalogPage(fixture, { categorySlug: 'metricke' })).products;
      expect(product?.descriptionParagraphs).toEqual(['První odstavec', 'Druhý odstavec']);
      expect(product?.gallery).toEqual(['/a.jpg', '/b.jpg']);
      expect('variants' in (product ?? {})).toBe(false);
      expect('contentHistory' in (product ?? {})).toBe(false);
      expect(product?.priceHistory).toEqual([]);
      expect(
        product?.variantRecords?.map((variant) => [variant.id, variant.stockOnHand, variant.grossPriceMinor]),
      ).toEqual([['v1', 5, 121]]);
      expect(product?.variantRecords?.[0]?.priceHistory).toEqual([]);
      expect(product?.stockOnHand).toBe(5);
      expect(product?.availability).toBe('IN_STOCK');
    }),
  ),
);

it.live('loads ordered tiers and variant stock without multiplying independent child rows', () => {
  const tiers = [
    { minimumQuantity: 1, priceExcludingVatMinor: 100, priceMinor: 121 },
    { minimumQuantity: 10, priceExcludingVatMinor: 90, priceMinor: 109 },
  ];
  const state = decodeState({
    ...catalogInput,
    products: catalogInput.products.map((product) => {
      const priced = { ...product, priceTiers: tiers };
      if (product.id !== 'p1') {
        return priced;
      }
      return {
        ...priced,
        variants: [
          { attributes: '', id: 'v1', name: 'M8', priceMinor: 100, priceTiers: tiers },
          { attributes: '', id: 'v2', name: 'M10', priceMinor: 200, priceTiers: tiers.slice(0, 1) },
          { attributes: 'informational', name: 'Not sellable' },
        ],
      };
    }),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* assertIndependentChildren() {
      const page = yield* catalogPage(fixture, { productIds: ['p2', 'p1'] });
      expect(page.products.map((product) => product.id)).toEqual(['p2', 'p1']);
      expect(page.products.map((product) => product.priceTiers)).toEqual([tiers, tiers]);
      const variants = page.products[1]?.variantRecords;
      expect(variants?.map((variant) => [variant.id, variant.stockOnHand])).toEqual([
        ['v1', 5],
        ['v2', 0],
      ]);
      expect(variants?.map((variant) => variant.priceTiers)).toEqual([tiers, tiers.slice(0, 1)]);
      expect(page.products[0]?.variantRecords).toBeUndefined();
    }),
  );
});

it.live('card shape omits variants, description and parameters', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase10() {
      const [card] = (yield* catalogPage(fixture, { categorySlug: 'metricke', fields: 'card' })).products;
      expect(card?.variantRecords).toBeUndefined();
      expect(card?.description).toBeUndefined();
      expect(card?.parameters).toBeUndefined();
      expect('variants' in (card ?? {})).toBe(false);
      expect('contentHistory' in (card ?? {})).toBe(false);
      expect(card?.grossPriceMinor).toBe(121);
      expect(card?.availability).toBe('IN_STOCK');
    }),
  ),
);

it.live('narrows variant records to the requested cart variants', () =>
  onCatalog((fixture) =>
    Effect.gen(function* catalogReadCase11() {
      const cart = yield* catalogPage(fixture, { productIds: ['p3', 'p1'], variantIds: ['v1'] });
      expect(cart.products.map((product) => product.id)).toEqual(['p3', 'p1']);
      expect(cart.products[1]?.variantRecords?.map((variant) => variant.id)).toEqual(['v1']);
      const none = yield* catalogPage(fixture, { productIds: ['p1'], variantIds: ['nope'] });
      expect(none.products[0]?.variantRecords).toEqual([]);
    }),
  ),
);

it.live('summarizes active sellable variants on every storefront product', () => {
  const state = decodeState({
    ...catalogInput,
    movements: [
      ...catalogInput.movements,
      {
        at: catalogInput.movements[0].at,
        delta: 3,
        id: 'receipt-v2',
        productId: 'p1',
        reason: 'RECEIPT',
        variantId: 'v2',
      },
      {
        at: catalogInput.movements[0].at,
        delta: 7,
        id: 'receipt-v3',
        productId: 'p1',
        reason: 'RECEIPT',
        variantId: 'v3',
      },
    ],
    products: catalogInput.products.map((product) =>
      product.id === 'p1'
        ? {
            ...product,
            variants: [
              { attributes: '', id: 'v1', name: 'M8 × 20', priceMinor: 100, sku: 'P1-M8' },
              { attributes: '', id: 'v2', name: 'M10 × 30', priceMinor: 300, sku: 'P1-M10', unit: 'bal' },
              { active: false, attributes: '', id: 'v3', name: 'M6 × 10', priceMinor: 10, sku: 'P1-M6' },
              { attributes: 'pouze informace', name: 'Informační' },
              { attributes: '', id: 'v5', name: 'Bez ceny', sku: 'P1-X', unit: 'm' },
            ],
          }
        : product,
    ),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* catalogReadCase12() {
      for (const fields of ['card', 'full'] as const) {
        const page = yield* catalogPage(fixture, { fields, productIds: ['p1', 'p2'] });
        const summaries = Object.fromEntries(page.products.map((product) => [product.id, product.variantSummary]));
        expect(summaries).toEqual({
          p1: { count: 2, minGrossPriceMinor: Option.some(121), stockOnHand: 8, units: ['bal', 'ks'] },
          p2: { count: 0, minGrossPriceMinor: Option.none(), stockOnHand: 0, units: [] },
        });
      }
    }),
  );
});

it.live('projects order status only for matching storefront id and clientRequestId', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* catalogReadCase13() {
      expect(yield* storefrontOrderStatus(db, scope, { clientRequestId: 'secret-request-1', orderId: 'o1' })).toEqual({
        id: 'o1',
        number: 'OBJ-2026-0001',
        status: 'NEW',
        statusLabel: 'Nová',
        updatedAt: DateTime.makeUnsafe(catalogInput.orders[0].updatedAt),
      });
      expect(
        yield* storefrontOrderStatus(db, scope, { clientRequestId: 'wrong-request-id', orderId: 'o1' }),
      ).toBeNull();
      // Removed DEMO orders are never shown, even with the right secret.
      expect(
        yield* storefrontOrderStatus(db, scope, { clientRequestId: 'secret-request-2', orderId: 'o2' }),
      ).toBeNull();
    }),
  ),
);

it.live('ranks exact/name/SKU matches before descriptions and variant-only matches', () => {
  const state: MerchandiseState = {
    ...catalogState,
    products: catalogState.products.slice(0, 3).map((product, index) => ({
      ...product,
      name: ['BITY', 'Šroub DIN 933/A2', 'DIN 933'][index],
      shortDescription: 'DIN 933',
      sku: ['BITY', 'SROUB', 'DIN933'][index],
    })),
  };
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* catalogReadCase14() {
      const byName = yield* catalogPage(fixture, { fields: 'card', q: 'din 933', sort: 'name' });
      expect(byName.products.map((product) => product.name)).toEqual(['DIN 933', 'Šroub DIN 933/A2', 'BITY']);
      const byPrice = yield* catalogPage(fixture, { q: 'din 933', sort: 'price-asc' });
      expect(byPrice.products[0]?.name).toBe('DIN 933');
    }),
  );
});

it.live(
  'prefers photography only within the same search relevance tier, not over exact matches or price sorting',
  () => {
    const [template] = catalogInput.products;
    const state = decodeState({
      ...catalogInput,
      homepageFeaturedProductIds: [],
      movements: [],
      orders: [],
      products: [
        { id: 'exact', imageSrc: '/akros/products/image-unavailable.svg', name: 'DIN 933' },
        { id: 'missing', imageSrc: '/akros/products/image-unavailable.svg', name: 'DIN 933 A' },
        { id: 'photo', imageSrc: '/akros/products/sroub.jpg', name: 'Šroub DIN 933' },
        { id: 'gallery', images: ['/akros/products/sroub-b.jpg'], name: 'Šroub DIN 933 B' },
        { id: 'loose', imageSrc: '/akros/products/bity.jpg', name: 'BITY', shortDescription: 'DIN 933' },
      ].map((product, index) => ({
        ...template,
        images: [],
        ...product,
        currentPriceMinor: index + 1,
        sku: product.id,
      })),
    });
    return withMerchandise(state, (fixture) => {
      const ids = (query: StorefrontCatalogQueryInput) => idsOf(fixture, query);
      return Effect.gen(function* catalogReadCase15() {
        expect(yield* ids({ q: 'DIN 933' })).toEqual(['exact', 'photo', 'gallery', 'missing', 'loose']);
        expect(yield* ids({ q: 'DIN 933', sort: 'name' })).toEqual(['exact', 'photo', 'gallery', 'missing', 'loose']);
        expect(yield* ids({ sort: 'name' })).toEqual(['loose', 'exact', 'missing', 'photo', 'gallery']);
        // Every product's price comes from the same variant, so price order falls back to catalog order.
        expect(yield* ids({ q: 'DIN 933', sort: 'price-asc' })).toEqual([
          'exact',
          'missing',
          'photo',
          'gallery',
          'loose',
        ]);
      });
    });
  },
);

it.live('sorts and filters by gross price and availability', () => {
  const state: MerchandiseState = {
    ...catalogState,
    products: catalogState.products.filter((product) => product.id !== 'p1'),
  };
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* catalogReadCase16() {
      expect(yield* idsOf(fixture, { sort: 'price-asc' })).toEqual(['p3', 'p2']);
      expect(yield* idsOf(fixture, { sort: 'price-desc' })).toEqual(['p2', 'p3']);
      expect(yield* idsOf(fixture, { minMinor: 40 })).toEqual(['p2']);
      expect(yield* idsOf(fixture, { maxMinor: 40 })).toEqual(['p3']);
      expect(yield* idsOf(fixture, { availability: 'in-stock' })).toEqual([]);
      expect(yield* idsOf(fixture, { availability: 'out-of-stock' })).toEqual(['p2', 'p3']);
    }),
  );
});

it.live('hides an unpublished category and its descendants from the public navigation only', () => {
  const state: MerchandiseState = {
    ...catalogState,
    categories: Option.getOrThrow(Option.fromUndefinedOr(catalogState.categories)).map((category) =>
      category.id === 'r' ? { ...category, published: false } : category,
    ),
  };
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* catalogReadCase17() {
      expect(yield* categoryTree(fixture.db, fixture.scope, { storefront: true })).toEqual([]);
      const staff = yield* categoryTree(fixture.db, fixture.scope, { storefront: false });
      expect(staff.map((category) => [category.id, category.published])).toEqual([
        ['r', false],
        ['c', undefined],
      ]);
      expect((yield* catalogPage(fixture, {})).products.length).toBeGreaterThan(0);
    }),
  );
});

it.live('never reads another company’s rows', () =>
  onCatalog((fixture) =>
    withMerchandise(
      {
        ...catalogState,
        movements: [{ ...catalogState.movements[0], delta: 2 }],
        orders: [],
        products: catalogState.products.slice(0, 2),
      },
      (other) =>
        Effect.gen(function* catalogReadCase18() {
          expect(yield* idsOf(fixture, {})).toEqual(['p1', 'p2', 'p3']);
          expect(yield* idsOf(other, {})).toEqual(['p1', 'p2']);
          expect(
            yield* storefrontOrderStatus(other.db, other.scope, { clientRequestId: 'secret-request-1', orderId: 'o1' }),
          ).toBeNull();
          // Same product and variant ids in both companies: each summary aggregates only its own variant rows.
          expect(yield* catalogVariantSummary(fixture)).toEqual({
            count: 1,
            minGrossPriceMinor: Option.some(121),
            stockOnHand: 5,
            units: ['ks'],
          });
          expect(yield* catalogVariantSummary(other)).toEqual({
            count: 1,
            minGrossPriceMinor: Option.some(121),
            stockOnHand: 2,
            units: ['ks'],
          });
        }),
    ),
  ),
);

it.live('staff reads page, filter and sort in SQL and indicators cover the whole company', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* catalogReadCase19() {
      const staffIds = (view: RecordsViewInput, storefront = false) =>
        staffProducts(db, scope, Schema.decodeSync(RecordsViewSchema)(view), storefront).pipe(
          Effect.map(staffProductIds),
        );
      expect(yield* staffIds({ summary: true })).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(yield* staffIds({ summary: true }, true)).toEqual(['p1', 'p2', 'p3']);
      expect(yield* staffIds({ search: 'sroub', summary: true })).toEqual(['p1']);
      expect(yield* staffIds({ categoryId: 'r', summary: true })).toEqual(['p1', 'p3']);
      expect(yield* staffIds({ lowStockOnly: true, summary: true })).toEqual(['p2', 'p3', 'p4']);
      expect(yield* staffIds({ productSort: 'price-desc', summary: true })).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(yield* staffIds({ productSort: 'price-asc', summary: true })).toEqual(['p4', 'p3', 'p2', 'p1']);
      expect(yield* staffIds({ limit: 2, offset: 1, summary: true })).toEqual(['p2', 'p3']);
      const summary = yield* staffProducts(db, scope, { limit: 1, summary: true }, false);
      expect(summary.total).toBe(4);
      expect(summary.products[0]?.variants).toBeUndefined();
      expect(summary.products[0]?.stockOnHand).toBe(5);
      const detail = yield* staffProducts(db, scope, {}, false);
      expect(detail.products.length).toBe(2);
      expect(detail.products[0]?.variantRecords?.map((variant) => variant.stockOnHand)).toEqual([5]);

      const orderIds = orderIdsFor({ db, scope });
      expect(yield* orderIds({})).toEqual([1, ['o1']]);
      expect(yield* orderIds({ orderSearch: 'OBJ-2026-0001' })).toEqual([1, ['o1']]);
      expect(yield* orderIds({ orderSearch: 'OBJ-2026-0002' })).toEqual([0, []]);
      expect(yield* orderIds({ orderStatus: 'CONFIRMED' })).toEqual([0, []]);

      expect((yield* productMovements(db, scope, 'p1')).map((movement) => movement.id)).toEqual(['receipt']);
      expect(yield* productMovements(db, scope, 'p2')).toEqual([]);

      expect(yield* indicators(db, scope)).toEqual({
        lowStockCount: 3,
        openOrderValueMinor: 100,
        orderCount: 1,
        productCount: 4,
        stockValueMinor: 500,
      });
    }),
  ),
);

it.live('staff list filters by tagged ids and product category label across pages, with grouped variant counts', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* staffTagAndCategoryFilters() {
      const page = (view: RecordsViewInput) =>
        staffProducts(db, scope, Schema.decodeSync(RecordsViewSchema)({ summary: true, ...view }), false).pipe(
          Effect.map(staffProductPageSummary),
        );
      expect(yield* page({ taggedProductIds: ['p2', 'p4', 'unknown'] })).toEqual([2, ['p2', 'p4']]);
      expect(yield* page({ limit: 1, offset: 1, taggedProductIds: ['p2', 'p4'] })).toEqual([2, ['p4']]);
      expect(yield* page({ taggedProductIds: [] })).toEqual([0, []]);
      expect(yield* page({ category: 'Šrouby', taggedProductIds: ['p1', 'p2'] })).toEqual([1, ['p1']]);
      expect(yield* productCategoryCounts(db, scope)).toEqual([
        { name: 'Matice', productCount: 1 },
        { name: 'Podložky', productCount: 1 },
        { name: 'Šrouby', productCount: 2 },
      ]);
      const rows = yield* staffProducts(db, scope, { summary: true }, false);
      expect(rows.products.map((product) => [product.id, product.variantCount])).toEqual([
        ['p1', 1],
        ['p2', 0],
        ['p3', 0],
        ['p4', 0],
      ]);
    }),
  ),
);

it.live('order search matches customers resolved from the register and the tag filter narrows the total', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* orderCustomerSearch() {
      const orderIds = orderIdsFor({ db, scope });
      expect(yield* orderIds({ orderSearch: 'novák' })).toEqual([0, []]);
      expect(yield* orderIds({ orderCustomerPartyIds: ['storefront-guest'], orderSearch: 'novák' })).toEqual([
        1,
        ['o1'],
      ]);
      expect(yield* orderIds({ orderCustomerPartyIds: ['someone-else'], orderSearch: 'novák' })).toEqual([0, []]);
      expect(yield* orderIds({ orderCustomerPartyIds: ['someone-else'], orderSearch: '0001' })).toEqual([1, ['o1']]);
      expect(yield* orderIds({ taggedOrderIds: ['o1'] })).toEqual([1, ['o1']]);
      expect(yield* orderIds({ taggedOrderIds: ['o2'] })).toEqual([0, []]);
    }),
  ),
);

it.live('in-app AKROS reset writes the bundled baseline part by part and advances the revision', () =>
  onCatalog(({ db, revision, scope }) =>
    Effect.gen(function* akrosReset() {
      const next = yield* db.transaction((transaction) => resetToAkrosBaseline(transaction, scope));
      expect(next).toBe(revision + 1);
      const totals = yield* indicators(db, scope);
      expect(totals.productCount).toBe(1289);
      expect(totals.orderCount).toBe(6);
      const head = yield* loadHead(db, scope);
      expect(head?.homepageFeaturedProductIds.length).toBeGreaterThan(0);
      expect(
        (yield* staffProducts(
          db,
          scope,
          Schema.decodeSync(RecordsViewSchema)({ productIds: ['p1'], summary: true }),
          false,
        )).total,
      ).toBe(0);
    }),
  ),
);

it.live(
  'customer orders filter by verified subject in SQL, isolate detail and paginate without exposing guests or removed orders',
  () => {
    const [original] = catalogInput.orders;
    const state = decodeState({
      ...catalogInput,
      orders: [
        ...Array.from({ length: 51 }, (_, index) => ({
          ...original,
          clientRequestId: `customer-submission-${index}`,
          customerAccountId: 'customer-one',
          id: `customer-order-${index}`,
          number: `OBJ-TEST-${index}`,
        })),
        {
          ...original,
          clientRequestId: 'other-submission',
          customerAccountId: 'customer-two',
          id: 'other-customer',
          number: 'OTHER-CUSTOMER',
        },
        { ...original, clientRequestId: 'guest-submission', id: 'guest-order', number: 'GUEST-ORDER' },
        {
          ...original,
          channel: 'STAFF',
          clientRequestId: 'staff-submission',
          customerAccountId: 'customer-one',
          id: 'staff-order',
          number: 'STAFF-ORDER',
        },
        { ...catalogInput.orders[1], customerAccountId: 'customer-one', id: 'removed-order' },
      ],
    });
    return withMerchandise(state, ({ db, scope }) =>
      Effect.gen(function* catalogReadCase20() {
        const first = yield* storefrontCustomerOrders(db, scope, { customerAccountId: 'customer-one' });
        expect(first.total).toBe(51);
        expect(first.orders).toHaveLength(50);
        expect(first.orders.every((order) => order.customerAccountId === 'customer-one')).toBe(true);
        const second = yield* storefrontCustomerOrders(db, scope, { customerAccountId: 'customer-one', offset: 50 });
        expect(second.orders).toHaveLength(1);
        expect(first.orders.some((order) => order.id === second.orders[0].id)).toBe(false);
        expect(
          (yield* storefrontCustomerOrders(db, scope, {
            customerAccountId: 'customer-one',
            orderId: 'customer-order-0',
          })).orders[0]?.lines,
        ).toEqual(original.lines);
        for (const orderId of ['other-customer', 'guest-order', 'staff-order', 'removed-order']) {
          expect(
            (yield* storefrontCustomerOrders(db, scope, { customerAccountId: 'customer-one', orderId })).orders,
          ).toEqual([]);
        }
        expect(
          (yield* storefrontCustomerOrders(
            db,
            { ...scope, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
            { customerAccountId: 'customer-one' },
          )).orders,
        ).toEqual([]);
      }),
    );
  },
);

const packageStockVariant = (id: string, constraints: { minimumQuantity?: number; packageQuantity?: number } = {}) => ({
  attributes: '',
  id,
  name: id,
  priceMinor: 100,
  sku: id,
  ...constraints,
});

it.live('counts only independently orderable variant packages in both card and detail summaries', () => {
  const balances = [
    ['partial-one', 15],
    ['partial-two', 40],
    ['rounded-below', 75],
    ['rounded-ready', 100],
    ['fallback', 49],
  ] as const;
  const state = decodeState({
    ...catalogInput,
    movements: balances.map(([variantId, delta]) => ({
      at: catalogInput.movements[0].at,
      delta,
      id: `receipt-${variantId}`,
      productId: 'p1',
      reason: 'RECEIPT',
      variantId,
    })),
    products: [
      {
        ...catalogInput.products[0],
        minimumQuantity: 50,
        packageQuantity: 50,
        variants: [
          packageStockVariant('partial-one', { minimumQuantity: 50, packageQuantity: 50 }),
          packageStockVariant('partial-two', { minimumQuantity: 50, packageQuantity: 50 }),
          packageStockVariant('rounded-below', { minimumQuantity: 75, packageQuantity: 50 }),
          packageStockVariant('rounded-ready', { minimumQuantity: 75, packageQuantity: 50 }),
          packageStockVariant('fallback'),
        ],
      },
    ],
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* packageStockSummary() {
      for (const fields of ['card', 'full'] as const) {
        const page = yield* catalogPage(fixture, { fields, productIds: ['p1'] });
        expect(page.products[0]?.variantSummary).toEqual({
          count: 5,
          minGrossPriceMinor: Option.some(121),
          stockOnHand: 100,
          units: ['ks'],
        });
        if (fields === 'full') {
          expect(page.products[0]?.variantRecords?.map((row) => row.stockOnHand)).toEqual([15, 40, 75, 100, 49]);
        }
      }
    }),
  );
});

// ------------------------------------------------------------------------------------------------ markets

const MARKET_ID = Schema.decodeUnknownSync(MarketIdSchema)(randomUUID());
const UNKNOWN_MARKET_ID = Schema.decodeUnknownSync(MarketIdSchema)(randomUUID());
const marketNow = DateTime.makeUnsafe('2026-11-01T10:00:00.000Z');
const decodeMarketCommand = Schema.decodeUnknownSync(Schema.Union(merchandiseMarketCommandSchemas));
type MarketCommandInput = (typeof merchandiseMarketCommandSchemas)[number]['Encoded'];
/** EUR at half the CZK gross, rounded to whole cents: every converted price is easy to check by hand. */
const halfPriceMarket = {
  _tag: 'ConfigureMarket',
  currency: 'EUR',
  exchangeRate: '0.5',
  marketCode: 'TEST-EU',
  marketId: MARKET_ID,
  offerMode: 'WHOLE_CATALOGUE',
  roundingMinor: 1,
} satisfies MarketCommandInput;

const runMarketCommand = ({ db, scope }: MerchandiseFixture, input: MarketCommandInput) =>
  db.transaction((transaction) => applyMarketCommand(transaction, scope, decodeMarketCommand(input), marketNow));

/** Storefront card listing restricted to the market (`marketId` resolved the way persistence resolves it). */
const marketPage = (fixture: MerchandiseFixture, marketId: string, query: StorefrontCatalogQueryInput = {}) =>
  Effect.gen(function* marketCatalogPage() {
    const market = yield* loadMarket(fixture.db, fixture.scope, marketId);
    return yield* storefrontProducts(fixture.db, fixture.scope, {
      market: catalogMarketScope(fixture.scope, market),
      query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ fields: 'card', ...query }),
    });
  });
const marketIds = (fixture: MerchandiseFixture, marketId: string, query: StorefrontCatalogQueryInput = {}) =>
  marketPage(fixture, marketId, query).pipe(Effect.map(staffProductIds));

it.live('lists only the products a market offers, with every price in the market currency', () =>
  onCatalog((fixture) =>
    Effect.gen(function* marketCatalog() {
      const configured = yield* runMarketCommand(fixture, { ...halfPriceMarket, expectedRevision: 0 });
      expect(configured.marketRevision).toBe(1);
      yield* runMarketCommand(fixture, {
        _tag: 'SetProductMarketOffer',
        marketId: MARKET_ID,
        offered: false,
        productId: 'p2',
      });
      // WHOLE_CATALOGUE: everything published except the withdrawn product, in every storefront mode.
      expect(yield* marketIds(fixture, MARKET_ID)).toEqual(['p1', 'p3']);
      expect(yield* marketIds(fixture, MARKET_ID, { label: 'sale' })).toEqual([]);
      expect(yield* marketIds(fixture, MARKET_ID, { productIds: ['p2', 'p3'] })).toEqual(['p3']);
      expect(yield* marketIds(fixture, MARKET_ID, { featured: true })).toEqual(['p3', 'p1']);
      expect(yield* marketIds(fixture, MARKET_ID, { categorySlug: 'srouby' })).toEqual(['p1', 'p3']);
      // Prices: the CZK gross × 0.5, half-up; full pages convert variants too.
      const czkPage = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'] });
      const eurPage = yield* marketPage(fixture, MARKET_ID, { fields: 'full', productIds: ['p1'] });
      const [czkProduct] = czkPage.products;
      const [eurProduct] = eurPage.products;
      expect(eurProduct?.currentPriceMinor).toBe(
        convertGrossMinor(czkProduct?.currentPriceMinor ?? -1, halfPriceMarket),
      );
      expect(eurProduct?.variantRecords?.map((variant) => variant.grossPriceMinor)).toEqual(
        czkProduct?.variantRecords?.map((variant) => convertGrossMinor(variant.grossPriceMinor ?? -1, halfPriceMarket)),
      );
      expect(eurProduct?.variantSummary?.minGrossPriceMinor).toEqual(Option.some(61));
      // Price bounds are market-currency amounts: 61 (p1) passes, 18 (p3: 36 Kč) does not.
      expect(yield* marketIds(fixture, MARKET_ID, { minMinor: 50 })).toEqual(['p1']);
      expect(yield* marketIds(fixture, MARKET_ID, { maxMinor: 60 })).toEqual(['p3']);
      // A market without settings offers nothing.
      expect((yield* marketPage(fixture, UNKNOWN_MARKET_ID)).total).toBe(0);
      // The staff views: exception counts, the exception page, the product's markets.
      const [market] = yield* listMarkets(fixture.db, fixture.scope);
      expect(market).toMatchObject({
        exceptionCounts: { notOffered: 1, offered: 0 },
        exchangeRate: '0.5',
        marketCode: 'TEST-EU',
        revision: 1,
      });
      expect(yield* marketExceptionPage(fixture.db, fixture.scope, { marketId: MARKET_ID })).toEqual({
        items: [{ name: 'Podložka', offered: false, productId: 'p2', sku: 'P2' }],
        marketId: MARKET_ID,
        total: 1,
      });
      const [p2Market] = yield* productMarketRows(fixture.db, fixture.scope, 'p2');
      expect(p2Market?.exception).toEqual(Option.some(false));
    }),
  ),
);

it.live('keeps variant search behind the existing market offer and currency price gates', () =>
  withMerchandise(variantSearchState, (fixture) =>
    Effect.gen(function* marketVariantSearch() {
      yield* runMarketCommand(fixture, halfPriceMarket);
      for (const q of ['SKU-enabled', 'SKU-legacy']) {
        expect(yield* marketIds(fixture, MARKET_ID, { maxMinor: 61, minMinor: 61, q })).toEqual(['p1']);
        expect(yield* marketIds(fixture, MARKET_ID, { minMinor: 62, q })).toEqual([]);
        expect(yield* marketIds(fixture, MARKET_ID, { maxMinor: 60, q })).toEqual([]);
        expect(yield* marketIds(fixture, UNKNOWN_MARKET_ID, { q })).toEqual([]);
      }
      expect(yield* marketIds(fixture, MARKET_ID, { q: 'SKU-disabled' })).toEqual([]);
      yield* runMarketCommand(fixture, {
        _tag: 'SetProductMarketOffer',
        marketId: MARKET_ID,
        offered: false,
        productId: 'p1',
      });
      expect(yield* marketIds(fixture, MARKET_ID, { q: 'SKU-enabled' })).toEqual([]);
    }),
  ),
);

it.live('switches a market to selected products, guards its revision and removes it with its exceptions', () =>
  onCatalog((fixture) =>
    Effect.gen(function* marketLifecycle() {
      yield* runMarketCommand(fixture, halfPriceMarket);
      yield* runMarketCommand(fixture, {
        _tag: 'SetMarketProductOffers',
        marketId: MARKET_ID,
        offered: false,
        productIds: ['p2'],
      });
      // The new default (not offered) makes the p2 exception redundant: it is dropped.
      const switched = yield* runMarketCommand(fixture, {
        ...halfPriceMarket,
        expectedRevision: 1,
        offerMode: 'SELECTED_PRODUCTS',
      });
      expect(switched.marketRevision).toBe(2);
      expect((yield* marketExceptionPage(fixture.db, fixture.scope, { marketId: MARKET_ID })).total).toBe(0);
      expect(yield* marketIds(fixture, MARKET_ID)).toEqual([]);
      yield* runMarketCommand(fixture, {
        _tag: 'SetMarketProductOffers',
        marketId: MARKET_ID,
        offered: true,
        productIds: ['p3'],
      });
      expect(yield* marketIds(fixture, MARKET_ID)).toEqual(['p3']);
      // Offering the default again stores nothing.
      yield* runMarketCommand(fixture, {
        _tag: 'SetProductMarketOffer',
        marketId: MARKET_ID,
        offered: false,
        productId: 'p1',
      });
      expect((yield* listMarkets(fixture.db, fixture.scope))[0]?.exceptionCounts).toEqual({
        notOffered: 0,
        offered: 1,
      });
      const stale = yield* runMarketCommand(fixture, { ...halfPriceMarket, expectedRevision: 1 }).pipe(Effect.flip);
      expect(Schema.is(MerchandiseRevisionConflict)(stale)).toBe(true);
      const missingProduct = yield* runMarketCommand(fixture, {
        _tag: 'SetProductMarketOffer',
        marketId: MARKET_ID,
        offered: true,
        productId: 'nope',
      }).pipe(Effect.flip);
      expect(Schema.is(MerchandiseNotFound)(missingProduct)).toBe(true);
      yield* runMarketCommand(fixture, { _tag: 'RemoveMarket', marketId: MARKET_ID });
      expect(yield* listMarkets(fixture.db, fixture.scope)).toEqual([]);
      expect((yield* marketExceptionPage(fixture.db, fixture.scope, { marketId: MARKET_ID })).total).toBe(0);
      const removedAgain = yield* runMarketCommand(fixture, { _tag: 'RemoveMarket', marketId: MARKET_ID }).pipe(
        Effect.flip,
      );
      expect(Schema.is(MerchandiseNotFound)(removedAgain)).toBe(true);
    }),
  ),
);

it.live('refuses a product offer saved over a newer offer change, and keeps calls without the read offer working', () =>
  onCatalog((fixture) =>
    Effect.gen(function* staleOffer() {
      yield* runMarketCommand(fixture, halfPriceMarket);
      const offer = { _tag: 'SetProductMarketOffer', marketId: MARKET_ID, productId: 'p2' } as const;
      // Read as offered (whole catalogue), withdrawn against that read: accepted.
      yield* runMarketCommand(fixture, { ...offer, expectedOffered: true, offered: false });
      expect(yield* marketIds(fixture, MARKET_ID)).toEqual(['p1', 'p3']);
      // A second editor still holds the old read (offered) and saves over the withdrawal: refused, nothing written.
      const stale = yield* runMarketCommand(fixture, { ...offer, expectedOffered: true, offered: true }).pipe(
        Effect.flip,
      );
      expect(Schema.is(MerchandiseRevisionConflict)(stale)).toBe(true);
      expect(yield* marketIds(fixture, MARKET_ID)).toEqual(['p1', 'p3']);
      // Without the read offer (agents, seed scripts) the command sets the offer as before.
      yield* runMarketCommand(fixture, { ...offer, offered: true });
      expect(yield* marketIds(fixture, MARKET_ID)).toContain('p2');
    }),
  ),
);

const marketActor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const decodeOrderCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);

/** PlaceStorefrontOrder the way persistence runs it, with the market context read from the market tables. */
const placeMarketOrder = (
  fixture: MerchandiseFixture,
  overrides: { readonly expectedUnitPriceMinor: number; readonly marketId: string },
) =>
  fixture.db.transaction((transaction) =>
    Effect.gen(function* placeOrderInMarket() {
      const command = decodeOrderCommand({
        _tag: 'PlaceStorefrontOrder',
        clientRequestId: `client-${randomUUID()}`,
        contact: { email: 'jana@example.cz', name: 'Jana Nováková' },
        deliveryAddress: { city: 'Bratislava', postalCode: '81101', street: 'Hlavná 1' },
        expectedShippingPriceMinor: 3950,
        lines: [
          { expectedUnitPriceMinor: overrides.expectedUnitPriceMinor, productId: 'p1', quantity: 2, variantId: 'v1' },
        ],
        marketId: overrides.marketId,
        partyId: 'test-customer-party',
        shippingMethod: 'ZASILKOVNA',
      });
      if (!Predicate.isTagged(command, 'PlaceStorefrontOrder') || command.marketId === undefined) {
        return yield* Effect.die('The fixture command must be a market storefront order');
      }
      const head = yield* loadHead(transaction, fixture.scope, { lock: true });
      if (head === undefined) {
        return yield* Effect.die('missing head');
      }
      const resourceId = `order-${randomUUID()}`;
      const working = yield* loadWorkingSet(transaction, fixture.scope, head, workingSetRequestOf(command, resourceId));
      const market = yield* loadOrderMarketContext(
        transaction,
        fixture.scope,
        command.marketId,
        command.lines.map((line) => line.productId),
      );
      const change = yield* evolveMerchandiseState(working.state, command, {
        actor: marketActor,
        market,
        now: marketNow,
        resourceId,
        tax: TEST_TAX,
      });
      if (change.state !== working.state) {
        yield* persistChange(transaction, fixture.scope, working, change.state, marketNow, TEST_RATES);
      }
      return { resourceId, result: change.storefrontOrder };
    }),
  );

it.live('PlaceStorefrontOrder in a market reprices, rejects what the market does not offer and stores the market', () =>
  onCatalog((fixture) =>
    Effect.gen(function* marketOrder() {
      yield* runMarketCommand(fixture, halfPriceMarket);
      // A CZK expectation (121) is a changed price in the EUR market (61).
      const stale = yield* placeMarketOrder(fixture, { expectedUnitPriceMinor: 121, marketId: MARKET_ID });
      expect(stale.result?.outcome).toBe('REJECTED');
      expect(stale.result?.issues[0]).toMatchObject({ code: 'PRICE_CHANGED', currentUnitPriceMinor: 61 });
      const unknown = yield* placeMarketOrder(fixture, { expectedUnitPriceMinor: 61, marketId: UNKNOWN_MARKET_ID });
      expect(unknown.result?.issues[0]?.code).toBe('MARKET_UNAVAILABLE');
      const placed = yield* placeMarketOrder(fixture, { expectedUnitPriceMinor: 61, marketId: MARKET_ID });
      expect(placed.result?.outcome).toBe('PLACED');
      expect(placed.result?.shippingPriceMinor).toBe(3950);
      expect(placed.result?.totalMinor).toBe(2 * 61 + 3950);
      expect(placed.result?.market).toEqual({
        configured: true,
        currency: 'EUR',
        marketCode: 'TEST-EU',
        marketId: MARKET_ID,
      });
      // The order read decodes the stored document: the market snapshot survives the round trip.
      const page = yield* orderPage(
        fixture.db,
        fixture.scope,
        Schema.decodeSync(RecordsViewSchema)({ ordersLimit: 10 }),
      );
      const stored = page.orders.find((order) => order.id === placed.resourceId);
      expect(stored?.market).toEqual({
        currency: 'EUR',
        exchangeRate: '0.5',
        marketCode: 'TEST-EU',
        marketId: MARKET_ID,
        roundingMinor: 1,
      });
      expect(stored?.lines[0]?.unitPriceMinor).toBe(61);
      // Withdrawn from the market: nothing is saved.
      yield* runMarketCommand(fixture, {
        _tag: 'SetProductMarketOffer',
        marketId: MARKET_ID,
        offered: false,
        productId: 'p1',
      });
      const withdrawn = yield* placeMarketOrder(fixture, { expectedUnitPriceMinor: 61, marketId: MARKET_ID });
      expect(withdrawn.result?.issues).toEqual([
        expect.objectContaining({ code: 'NOT_OFFERED_IN_MARKET', productId: 'p1', variantId: 'v1' }),
      ]);
      expect(
        (yield* orderPage(fixture.db, fixture.scope, Schema.decodeSync(RecordsViewSchema)({ ordersLimit: 10 }))).orders,
      ).toHaveLength(page.orders.length);
    }),
  ),
);

// ------------------------------------------------------------------------------------------------ current search inclusion and compact leaf evidence

it.live(
  'rejects poisoned inactive parent search_text before counting/paging and finds current text missing from the index',
  () => {
    const state = decodeState({
      ...catalogInput,
      products: ['bad-a', 'bad-b', 'good-a', 'good-b'].map((id) => ({
        ...catalogInput.products[0],
        id,
        name: id,
        sku: id,
        variants: [{ ...searchVariant(id), active: !id.startsWith('bad'), sku: 'CURRENT-NEEDLE' }],
      })),
    });
    return withMerchandise(state, (fixture) =>
      Effect.gen(function* poisonedCatalogText() {
        yield* fixture.db
          .update(products)
          .set({ searchText: 'current-needle poisoned inactive parent text' })
          .where(whereScope(products, fixture.scope));
        for (const [page, ids] of [
          [1, ['good-a']],
          [2, ['good-b']],
          [3, []],
        ] as const) {
          const result = yield* catalogPage(fixture, { fields: 'card', page, pageSize: 1, q: 'CURRENT-NEEDLE' });
          expect([result.total, staffProductIds(result)]).toEqual([2, ids]);
          expect(result.products.every((product) => product.searchMatch?.kind === 'single')).toBe(true);
        }
        yield* fixture.db
          .update(products)
          .set({ searchText: 'old index missing every current term' })
          .where(whereScope(products, fixture.scope));
        const current = yield* catalogPage(fixture, { fields: 'card', q: 'CURRENT-NEEDLE' });
        expect([current.total, staffProductIds(current)]).toEqual([2, ['good-a', 'good-b']]);
      }),
    );
  },
);

it.live('exhausts multiple current-text batches before publishing a complete count and page', () => {
  const state = decodeState({
    ...catalogInput,
    products: Array.from({ length: 130 }, (_, index) => ({
      ...catalogInput.products[0],
      id: `candidate-${index}`,
      name: `Candidate ${index}`,
      sku: `CANDIDATE-${index}`,
      variants: [{ ...searchVariant(`batch-${index}`), active: index === 129, sku: 'BATCH-NEEDLE' }],
    })),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* completeCurrentTextStream() {
      yield* fixture.db
        .update(products)
        .set({ searchText: 'batch-needle old inactive matches' })
        .where(whereScope(products, fixture.scope));
      const first = yield* catalogPage(fixture, { fields: 'card', pageSize: 1, q: 'BATCH-NEEDLE' });
      expect([first.total, staffProductIds(first)]).toEqual([1, ['candidate-129']]);
      const beyond = yield* catalogPage(fixture, { fields: 'card', page: 2, pageSize: 1, q: 'BATCH-NEEDLE' });
      expect([beyond.total, staffProductIds(beyond)]).toEqual([1, []]);
    }),
  );
});

it.live(
  'uses the owner normalizer for current Unicode inclusion, not a finite accent translation approximation',
  () => {
    const state = decodeState({
      ...catalogInput,
      products: ['ŠROUB', 'S\u030CROUB', 'İSTANBUL', 'ΟΣ', 'ẞ', 'Ångström', 'ÅNGSTRÖM', 'Žluťoučký'].map(
        (name, index) => ({
          ...catalogInput.products[1],
          id: `unicode-${index}`,
          name,
          sku: `plain-${index}`,
        }),
      ),
    });
    return withMerchandise(state, (fixture) =>
      Effect.gen(function* unicodeCurrentInclusion() {
        yield* fixture.db
          .update(products)
          .set({ searchText: 'stale unrelated text' })
          .where(whereScope(products, fixture.scope));
        for (const q of ['sroub', 'istanbul', 'ος', 'ß', 'angstrom', 'zlutoucky']) {
          const expected = state.products
            .filter((product) => productSearchText(product).includes(q))
            .map((product) => product.id);
          const result = yield* catalogPage(fixture, { fields: 'card', q });
          expect(result.total).toBe(expected.length);
          expect(new Set(staffProductIds(result))).toEqual(new Set(expected));
        }
      }),
    );
  },
);

const attributionState = decodeState({
  ...catalogInput,
  products: [
    {
      ...catalogInput.products[0],
      name: 'Family',
      parameters: [],
      sku: 'BASE',
      variants: [
        { ...searchVariant('exact'), name: 'Steel needle', sku: 'EXACT' },
        {
          ...searchVariant('long'),
          name: 'Long needle',
          parameters: [{ label: 'Size', unit: '', value: 'M8' }],
          sku: 'EXACT-LONG',
        },
        { ...searchVariant('dup-a'), sku: 'DUP' },
        { ...searchVariant('dup-b'), sku: 'DUP' },
        { ...searchVariant('zero'), priceMinor: 0, sku: 'FREE' },
        { ...searchVariant('inactive', Option.some(false)), sku: 'EXACT' },
        { attributes: 'info-only', name: 'Informational' },
      ],
    },
  ],
});

it.live(
  'keeps substring leaf attribution separate from all-word inclusion, exact SKU priority and duplicate SKU multiplicity',
  () =>
    withMerchandise(attributionState, (fixture) =>
      Effect.gen(function* compactAttribution() {
        const exact = yield* catalogPage(fixture, { fields: 'card', q: 'EXACT' });
        expect(exact.products[0]?.searchMatch).toMatchObject({
          kind: 'single',
          variant: { id: 'variant-exact', sku: 'EXACT' },
        });
        const duplicate = yield* catalogPage(fixture, { fields: 'card', q: 'DUP' });
        expect(duplicate.products[0]?.searchMatch).toEqual({ count: 2, kind: 'multiple' });
        const multiple = yield* catalogPage(fixture, { fields: 'card', q: 'needle' });
        expect(multiple.products[0]?.searchMatch).toEqual({ count: 2, kind: 'multiple' });
        expect((yield* catalogPage(fixture, { fields: 'card', q: 'Family' })).products[0]?.searchMatch).toEqual({
          kind: 'product',
        });
        for (const q of ['Family EXACT', 'needle M8', 'info-only']) {
          const page = yield* catalogPage(fixture, { fields: 'card', q });
          expect(page.total).toBe(1);
          expect(page.products[0]?.searchMatch).toEqual({ kind: 'unattributed' });
        }
        expect((yield* catalogPage(fixture, { fields: 'card', q: 'FREE' })).products[0]?.searchMatch).toMatchObject({
          kind: 'single',
          variant: { grossPriceMinor: 0, id: 'variant-zero', priceMinor: 0 },
        });
        expect((yield* catalogPage(fixture, { fields: 'card', q: '  ' })).products[0]?.searchMatch).toBeUndefined();
      }),
    ),
);

it.live('returns onlyVariant only for the whole active sellable singleton set and never fabricates attribution', () => {
  const state = decodeState({
    ...catalogInput,
    products: [
      {
        ...catalogInput.products[0],
        name: 'Family',
        variants: [
          searchVariant('only'),
          searchVariant('inactive', Option.some(false)),
          { attributes: 'info-only', name: 'Informational' },
          { attributes: '', id: 'no-price', name: 'No price' },
        ],
      },
    ],
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* onlyVariantEvidence() {
      expect((yield* catalogPage(fixture, { fields: 'card', q: 'Family' })).products[0]?.searchMatch).toMatchObject({
        kind: 'product',
        onlyVariant: { id: 'variant-only' },
      });
      expect((yield* catalogPage(fixture, { fields: 'card', q: 'info-only' })).products[0]?.searchMatch).toMatchObject({
        kind: 'unattributed',
        onlyVariant: { id: 'variant-only' },
      });
    }),
  );
});

it.live('produces exact evidence for every page group beyond eight without reading any group history blobs', () => {
  const state = decodeState({
    ...catalogInput,
    products: Array.from({ length: 10 }, (_, index) => ({
      ...catalogInput.products[0],
      id: `group-${index}`,
      name: `Group ${index}`,
      sku: `GROUP-${index}`,
      variants: [{ ...searchVariant(`chosen-${index}`), sku: 'NEEDLE' }, searchVariant(`other-${index}`)],
    })),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* allPageGroupsCompact() {
      // Public leaf presentation must not hydrate either selected or unselected private history arrays.
      yield* fixture.db
        .update(productVariants)
        .set({
          document: sql`jsonb_set(${productVariants.document}, '{priceHistory}', '"must not hydrate private history"'::jsonb)`,
        })
        .where(whereScope(productVariants, fixture.scope));
      const page = yield* catalogPage(fixture, { fields: 'card', pageSize: 10, q: 'NEEDLE' });
      expect([page.total, page.products.length]).toEqual([10, 10]);
      for (const product of page.products) {
        expect(product.searchMatch).toMatchObject({ kind: 'single', variant: { sku: 'NEEDLE' } });
        expect(product.variantRecords).toBeUndefined();
        const wire = JSON.stringify(product.searchMatch);
        for (const key of ['priceHistory', 'priceTiers', 'parameters', 'attributes', 'variants']) {
          expect(wire.includes(`"${key}"`)).toBe(false);
        }
      }
    }),
  );
});

const compactTier = (priceMinor: number) => [
  { minimumQuantity: 1, priceExcludingVatMinor: priceMinor - 10, priceMinor },
];

it.live('selects singleton documents and tiers by product-position pairs, never a cross-product variant id set', () => {
  const state = decodeState({
    ...catalogInput,
    movements: [],
    products: [
      {
        ...catalogInput.products[0],
        id: 'pair-a',
        name: 'Pair A',
        sku: 'PAIR-A',
        variants: [
          { ...searchVariant('a'), id: 'reused-id', priceTiers: compactTier(111), sku: 'NEEDLE' },
          { ...searchVariant('a-other'), priceTiers: compactTier(999) },
        ],
      },
      {
        ...catalogInput.products[0],
        id: 'pair-b',
        name: 'Pair B',
        sku: 'PAIR-B',
        variants: [
          { ...searchVariant('b-other'), priceTiers: compactTier(888) },
          { ...searchVariant('b'), id: 'reused-id', priceTiers: compactTier(222), sku: 'NEEDLE' },
        ],
      },
    ],
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* selectedSearchPairs() {
      const page = yield* catalogPage(fixture, { fields: 'card', q: 'NEEDLE' });
      expect(page.products.map((product) => product.searchMatch)).toMatchObject([
        { kind: 'single', variant: { displayPriceExcludingVatMinor: 101, grossPriceMinor: 111, id: 'reused-id' } },
        { kind: 'single', variant: { displayPriceExcludingVatMinor: 212, grossPriceMinor: 222, id: 'reused-id' } },
      ]);
    }),
  );
});

it.live(
  'keeps compact singleton offers in the resolved market with post-conversion display-net and fresh leaf fields',
  () => {
    const state = decodeState({
      ...catalogInput,
      movements: [{ ...catalogInput.movements[0], variantId: 'variant-leaf' }],
      products: [
        {
          ...catalogInput.products[0],
          variants: [
            {
              ...searchVariant('leaf'),
              imageSrc: 'media:leaf-image',
              minimumQuantity: 3,
              packageQuantity: 2,
              priceTiers: [
                { minimumQuantity: 1, priceExcludingVatMinor: 91, priceMinor: 121 },
                { minimumQuantity: 1, priceExcludingVatMinor: 70, priceMinor: 122 },
                { minimumQuantity: 2, priceExcludingVatMinor: 50, priceMinor: 124 },
              ],
              sku: 'LEAF',
              sourceUnit: 'm',
            },
            searchVariant('other'),
          ],
        },
      ],
    });
    return withMerchandise(state, (fixture) =>
      Effect.gen(function* compactMarketOffer() {
        yield* runMarketCommand(fixture, { ...halfPriceMarket, roundingMinor: 10 });
        const page = yield* marketPage(fixture, MARKET_ID, { q: 'LEAF' });
        expect(page.products[0]?.searchMatch).toMatchObject({
          kind: 'single',
          variant: {
            currency: 'EUR',
            displayPriceExcludingVatMinor: 40,
            grossPriceMinor: 60,
            id: 'variant-leaf',
            imageSrc: 'media:leaf-image',
            minimumQuantity: 3,
            packageQuantity: 2,
            priceMinor: 50,
            sourceUnit: 'm',
            stockOnHand: 5,
          },
        });
        const full = yield* marketPage(fixture, MARKET_ID, {
          fields: 'full',
          productIds: ['p1'],
          variantIds: ['variant-leaf'],
        });
        expect(full.products[0]?.variantRecords?.[0]).toMatchObject({
          grossPriceMinor: 60,
          priceMinor: 50,
          stockOnHand: 5,
        });
        expect((yield* marketPage(fixture, UNKNOWN_MARKET_ID, { q: 'LEAF' })).products).toEqual([]);
        yield* runMarketCommand(fixture, {
          _tag: 'SetProductMarketOffer',
          marketId: MARKET_ID,
          offered: false,
          productId: 'p1',
        });
        expect((yield* marketPage(fixture, MARKET_ID, { q: 'LEAF' })).products).toEqual([]);
      }),
    );
  },
);

// ------------------------------------------------------------------------------------------------ historical inline-only public offering parity

const historicalInlineState = decodeState({
  ...catalogInput,
  movements: [{ ...catalogInput.movements[0], delta: 9, variantId: 'legacy-exact' }],
  orders: [],
  products: [
    {
      ...catalogInput.products[0],
      name: 'Legacy family',
      sku: 'LEGACY-PARENT',
      variants: [
        {
          attributes: 'small',
          id: 'legacy-exact',
          imageSrc: 'media:legacy-image',
          minimumQuantity: 3,
          name: 'Needle small',
          packageQuantity: 2,
          priceMinor: 100,
          priceTiers: [
            { minimumQuantity: 1, priceExcludingVatMinor: 91, priceMinor: 121 },
            { minimumQuantity: 1, priceExcludingVatMinor: 70, priceMinor: 122 },
            { minimumQuantity: 2, priceExcludingVatMinor: 50, priceMinor: 124 },
          ],
          sku: 'INLINE',
          sourceUnit: 'm',
        },
        { attributes: 'large', id: 'legacy-long', name: 'Needle large', priceMinor: 200, sku: 'INLINE-LONG' },
        { attributes: '', id: 'legacy-dup-a', name: 'Duplicate A', priceMinor: 300, sku: 'DUP' },
        { attributes: '', id: 'legacy-dup-b', name: 'Duplicate B', priceMinor: 400, sku: 'DUP' },
        { attributes: '', id: 'legacy-zero', name: 'Zero leaf', priceMinor: 0, sku: 'FREEINLINE' },
        { active: false, attributes: '', id: 'legacy-inactive', name: 'Inactive leaf', priceMinor: 500, sku: 'INLINE' },
        { attributes: 'informational-only', name: 'No identity or price' },
        { attributes: '', id: 'legacy-no-price', name: 'No price', sku: 'UNPRICED' },
        { attributes: '', name: 'No identity', priceMinor: 600, sku: 'NOIDENTITY' },
      ],
    },
  ],
});

/** Seed the historical canonical representation in this disposable fixture, not a live migration/write path. */
const installInlineOnly = (fixture: MerchandiseFixture, state: MerchandiseState) =>
  Effect.gen(function* installHistoricalInlineFixture() {
    const encoded = encodeState(state);
    yield* Effect.forEach(
      encoded.products,
      (product) =>
        fixture.db
          .update(products)
          .set({ document: product })
          .where(and(whereScope(products, fixture.scope), eq(products.id, product.id))),
      { concurrency: 1, discard: true },
    );
    yield* fixture.db
      .delete(priceTiers)
      .where(and(whereScope(priceTiers, fixture.scope), sql`${priceTiers.variantPosition} >= 0`));
    yield* fixture.db.delete(productVariants).where(whereScope(productVariants, fixture.scope));
    expect(
      yield* fixture.db
        .select({ id: productVariants.variantId })
        .from(productVariants)
        .where(whereScope(productVariants, fixture.scope)),
    ).toEqual([]);
  });

const withInlineOnly = <A, E>(state: MerchandiseState, run: (fixture: MerchandiseFixture) => Effect.Effect<A, E>) =>
  withMerchandise(state, (fixture) => installInlineOnly(fixture, state).pipe(Effect.andThen(() => run(fixture))));

const approvedInlineLeaf = (page: StorefrontProductPage, id: string) => {
  const leaf = page.products[0]?.variantRecords?.find((variant) => variant.id === id);
  if (leaf === undefined) {
    expect.unreachable('The unchanged explicit full owner contract must expose this real fixture leaf');
  }
  return leaf;
};

it.live(
  'historical inline-only full and cart contracts expose actual identified priced leaves without normalized rows',
  () =>
    withInlineOnly(historicalInlineState, (fixture) =>
      Effect.gen(function* canonicalInlineFullOffer() {
        const full = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'] });
        const leaf = approvedInlineLeaf(full, 'legacy-exact');
        expect(leaf).toMatchObject({
          active: true,
          grossPriceMinor: 121,
          id: 'legacy-exact',
          imageSrc: 'media:legacy-image',
          minimumQuantity: 3,
          name: 'Needle small',
          packageQuantity: 2,
          priceMinor: 100,
          sku: 'INLINE',
          sourceUnit: 'm',
          unit: 'm',
        });
        // Observe the approved hydrator's actual source behavior, not a new compact stock fallback:
        // the product ledger has 9, but without normalized variant stock the full leaf is unavailable.
        expect(full.products[0]?.stockOnHand).toBe(9);
        expect([leaf.stockOnHand, leaf.availability]).toEqual([0, 'OUT_OF_STOCK']);
        expect(full.products[0]?.variantRecords?.filter((variant) => variant.active)).toHaveLength(5);
        const cart = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'], variantIds: ['legacy-exact'] });
        expect(cart.products[0]?.variantRecords).toEqual([leaf]);
      }),
    ),
);

it.live('historical inline-only compact exact leaf preserves the unchanged full public offer', () =>
  withInlineOnly(historicalInlineState, (fixture) =>
    Effect.gen(function* compactInlineExactOffer() {
      const full = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'] });
      const leaf = approvedInlineLeaf(full, 'legacy-exact');
      const compact = yield* catalogPage(fixture, { fields: 'card', q: 'INLINE' });
      expect(compact.total).toBe(1);
      expect(compact.products[0]?.variantRecords).toBeUndefined();
      expect(compact.products[0]?.searchMatch).toMatchObject({
        kind: 'single',
        variant: {
          availability: leaf.availability,
          currency: 'CZK',
          grossPriceMinor: leaf.grossPriceMinor,
          id: leaf.id,
          imageSrc: leaf.imageSrc,
          minimumQuantity: leaf.minimumQuantity,
          name: leaf.name,
          packageQuantity: leaf.packageQuantity,
          priceMinor: leaf.priceMinor,
          sku: leaf.sku,
          sourceUnit: leaf.sourceUnit,
          stockOnHand: leaf.stockOnHand,
          unit: leaf.unit,
        },
      });
      const wire = JSON.stringify(compact.products[0]?.searchMatch);
      for (const key of ['priceHistory', 'priceTiers', 'parameters', 'attributes', 'variants']) {
        expect(wire.includes(`"${key}"`)).toBe(false);
      }
    }),
  ),
);

it.live(
  'historical inline-only ambiguity, duplicate SKUs, zero price and whole-set fallback follow the full contract',
  () =>
    withInlineOnly(historicalInlineState, (fixture) =>
      Effect.gen(function* compactInlineMultiplicity() {
        const full = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'] });
        const duplicateCount = full.products[0]?.variantRecords?.filter(
          (variant) => variant.active && variant.sku === 'DUP',
        ).length;
        expect(duplicateCount).toBe(2);
        expect((yield* catalogPage(fixture, { fields: 'card', q: 'DUP' })).products[0]?.searchMatch).toEqual({
          count: duplicateCount,
          kind: 'multiple',
        });
        expect((yield* catalogPage(fixture, { fields: 'card', q: 'needle' })).products[0]?.searchMatch).toEqual({
          count: 2,
          kind: 'multiple',
        });
        expect((yield* catalogPage(fixture, { fields: 'card', q: 'Legacy family' })).products[0]?.searchMatch).toEqual({
          kind: 'product',
        });
        const zero = approvedInlineLeaf(full, 'legacy-zero');
        expect(
          (yield* catalogPage(fixture, { fields: 'card', q: 'FREEINLINE' })).products[0]?.searchMatch,
        ).toMatchObject({
          kind: 'single',
          variant: {
            grossPriceMinor: zero.grossPriceMinor,
            id: zero.id,
            priceMinor: zero.priceMinor,
            stockOnHand: zero.stockOnHand,
          },
        });
      }),
    ),
);

const historicalOnlyState: MerchandiseState = {
  ...historicalInlineState,
  products: historicalInlineState.products.map((product) => ({
    ...product,
    variants: (product.variants ?? []).filter(
      (variant) =>
        variant.id === 'legacy-exact' ||
        variant.active === false ||
        variant.id === undefined ||
        variant.priceMinor === undefined,
    ),
  })),
};

it.live('historical inline-only onlyVariant comes from the entire genuine active full-detail set', () =>
  withInlineOnly(historicalOnlyState, (fixture) =>
    Effect.gen(function* compactInlineOnlyFallback() {
      const full = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'] });
      const active = full.products[0]?.variantRecords?.filter((variant) => variant.active);
      expect(active).toHaveLength(1);
      const leaf = approvedInlineLeaf(full, 'legacy-exact');
      for (const q of ['Legacy family', 'informational-only']) {
        const expectedKind = q === 'Legacy family' ? 'product' : 'unattributed';
        expect((yield* catalogPage(fixture, { fields: 'card', q })).products[0]?.searchMatch).toMatchObject({
          kind: expectedKind,
          onlyVariant: {
            grossPriceMinor: leaf.grossPriceMinor,
            id: leaf.id,
            priceMinor: leaf.priceMinor,
            stockOnHand: leaf.stockOnHand,
          },
        });
      }
    }),
  ),
);

const historicalUnavailableState: MerchandiseState = {
  ...historicalInlineState,
  products: historicalInlineState.products.map((product) => ({
    ...product,
    variants: (product.variants ?? []).filter(
      (variant) => variant.id === undefined || variant.priceMinor === undefined,
    ),
  })),
};

it.live('historical inline-only missing identity or price has exact full-detail unavailability parity', () =>
  withInlineOnly(historicalUnavailableState, (fixture) =>
    Effect.gen(function* unavailableInlineIdentityOrPrice() {
      const full = yield* catalogPage(fixture, { fields: 'full', productIds: ['p1'] });
      expect(full.products[0]?.variantRecords).toBeUndefined();
      for (const q of ['UNPRICED', 'NOIDENTITY', 'informational-only']) {
        const compact = yield* catalogPage(fixture, { fields: 'card', q });
        expect(compact.total).toBe(1);
        expect(compact.products[0]?.searchMatch).toEqual({ kind: 'unattributed' });
      }
    }),
  ),
);

it.live('historical inline-only compact market offer equals full/cart conversion with post-rounding display net', () =>
  withInlineOnly(historicalInlineState, (fixture) =>
    Effect.gen(function* compactInlineMarketOffer() {
      yield* runMarketCommand(fixture, { ...halfPriceMarket, roundingMinor: 10 });
      const full = yield* marketPage(fixture, MARKET_ID, {
        fields: 'full',
        productIds: ['p1'],
        variantIds: ['legacy-exact'],
      });
      const leaf = approvedInlineLeaf(full, 'legacy-exact');
      expect([leaf.grossPriceMinor, leaf.priceMinor]).toEqual([60, 50]);
      expect((yield* marketPage(fixture, MARKET_ID, { q: 'INLINE' })).products[0]?.searchMatch).toMatchObject({
        kind: 'single',
        variant: {
          availability: leaf.availability,
          currency: 'EUR',
          displayPriceExcludingVatMinor: 40,
          grossPriceMinor: leaf.grossPriceMinor,
          id: leaf.id,
          priceMinor: leaf.priceMinor,
          stockOnHand: leaf.stockOnHand,
        },
      });
      expect((yield* marketPage(fixture, UNKNOWN_MARKET_ID, { q: 'INLINE' })).products).toEqual([]);
      yield* runMarketCommand(fixture, {
        _tag: 'SetProductMarketOffer',
        marketId: MARKET_ID,
        offered: false,
        productId: 'p1',
      });
      expect((yield* marketPage(fixture, MARKET_ID, { q: 'INLINE' })).products).toEqual([]);
    }),
  ),
);
