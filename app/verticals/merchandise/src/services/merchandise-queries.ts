// Bounded reads over the normalized merchandise tables. Every list is paged and filtered in PostgreSQL; the
// largest unit a read ever materializes is one page of products (with variants only for detail reads).
import { and, asc, desc, eq, gt, inArray, like, mapColumnsInSQLToAlias, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Effect, Match, Option, Schema } from 'effect';
import { PRODUCT_DETAIL_PAGE_LIMIT } from '../../shared/apis/records.ts';
import type {
  CategoryTrail,
  RecordsView,
  StorefrontCatalogQuery,
  StorefrontOrderStatus,
} from '../../shared/apis/records.ts';
import {
  CATEGORY_RESULT_LIMIT,
  categoryQueryWords,
  normalizeCategoryName,
  rankCategories,
} from '../../shared/domain/category-search.ts';
import {
  AvailabilitySchema,
  CatalogCategoryIdSchema,
  ProductIdReferenceSchema,
  CategoryNodeSchema,
  CatalogParameterSchema,
  ProductVariantSchema,
  StorefrontVariantPreviewSchema,
  VariantIdSchema,
  VariantSummarySchema,
} from '../../shared/domain/merchandise-model.ts';
import type {
  Order,
  OrderStatus,
  ProductRecord,
  SearchMatch,
  StockMovement,
} from '../../shared/domain/merchandise-model.ts';
import {
  catalogHeads,
  categories,
  orders,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../database/schema.ts';
import {
  decodeMovementRow,
  decodeOrderDocument,
  hydrateProducts,
  loadHead,
  MerchandiseStoreFailure,
  productSearchText,
  query,
  whereScope,
} from './merchandise-store.ts';
import type { MerchandiseDb, StoreScope } from './merchandise-store.ts';
import { toProductRecord } from './stock-levels.ts';
import { czkBoundsForMarket } from '../../shared/domain/market-offers.ts';
import { NO_CATALOG_MARKET } from './market-store.ts';
import type { CatalogMarketScope, StoredMarket } from './market-store.ts';
import { productInMarketCurrency, searchVariantOffer } from './market-pricing.ts';
import {
  DEFAULT_STOREFRONT_PAGE_SIZE,
  normalizeSearchText,
  storefrontStatusOf,
  toStorefrontProduct,
} from './storefront-catalog.ts';

const noCategoryTrails: readonly CategoryTrail[] = [];
const noOrders: readonly Order[] = [];

const STORED_ROWS_REASON = 'Stored rows do not decode';
const storedRowsFailure = (cause: MerchandiseStoreFailure['cause']) =>
  new MerchandiseStoreFailure({ cause, reason: STORED_ROWS_REASON });

export const DEFAULT_PRODUCT_LIMIT = 50;
const CART_PAGE_LIMIT = 50;
export const DEFAULT_ORDER_LIMIT = 100;
const MOVEMENT_LIMIT = 500;

/** Order statuses that count as open order value. DELIVERED and CANCELLED are closed. */
const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED'];

const likeEscape = (value: string) => value.replaceAll(/[\\%_]/gu, (match) => `\\${match}`);
const wordsOf = (text: string | undefined) =>
  normalizeSearchText(text ?? '')
    .split(/\s+/u)
    .filter((word) => word !== '');
const containsAll = (column: SQL | AnyPgColumn, words: readonly string[]) =>
  words.map((word) => like(column, `%${likeEscape(word)}%`));
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;
const idsFilter = (column: AnyPgColumn, ids: readonly string[]) =>
  ids.length === 0 ? sql`false` : inArray(column, [...ids]);

/**
 * Homepage featured products, in order: the products' own featured positions (`featured_position`, set by
 * UpdateProduct), limited to what the storefront shows. The one source of the homepage order; no separate list.
 */
const featuredProductIdsOf = (
  scope: StoreScope,
) => sql`(select coalesce(array_agg(f.id order by f.featured_position asc, f.ordinal asc), '{}'::text[])
  from ${products} f
  where f.tenant_id = ${scope.tenantId}::uuid and f.legal_entity_id = ${scope.legalEntityId}::uuid
    and f.featured_position is not null and f.archived = false and f.active = true and f.published = true)`;

// ------------------------------------------------------------------------------------------------ products

const productSelection = {
  availability: products.availability,
  document: products.document,
  grossPriceMinor: products.grossPriceMinor,
  id: products.id,
  lowStock: products.lowStock,
  stockOnHand: products.stockOnHand,
  stockValueMinor: products.stockValueMinor,
};

const outerProductId = sql.raw('"products"."id"');

type VariantSummaryEncoded = typeof VariantSummarySchema.Encoded;

/**
 * Active sellable variants of the row's product in aggregate, computed inside the page query (no N+1). The scope
 * is bound as parameters: an unqualified outer column would resolve to the variant row itself.
 */
// A positive ledger balance is not available stock when it cannot cover one mandatory package.
// Match order-quantity and the detail purchase constraints, per variant (never pool partial packages).
const variantMinimumSql = sql`coalesce((v.document->>'minimumQuantity')::numeric,
  (${sql.raw('"products"."document"')}->>'minimumQuantity')::numeric, 1)`;
const variantPackageSql = sql`coalesce((v.document->>'packageQuantity')::numeric,
  (${sql.raw('"products"."document"')}->>'packageQuantity')::numeric)`;
const variantOrderMinimumSql = sql`case when ${variantPackageSql} > 0
  then ceil(${variantMinimumSql} / ${variantPackageSql} - 0.000001) * ${variantPackageSql}
  else ${variantMinimumSql} end`;
const variantSummarySql = (scope: StoreScope) => sql<VariantSummaryEncoded>`(select json_build_object(
    'count', count(*)::int,
    'minGrossPriceMinor', min(v.gross_price_minor),
    'stockOnHand', coalesce(sum(case when v.stock_on_hand >= ${variantOrderMinimumSql}
      then v.stock_on_hand else 0 end), 0),
    'units', coalesce(array_agg(distinct v.unit order by v.unit), '{}'::text[]))
  from ${productVariants} v
  where v.tenant_id = ${scope.tenantId}::uuid and v.legal_entity_id = ${scope.legalEntityId}::uuid
    and v.product_id = ${outerProductId} and v.variant_id is not null and v.price_minor is not null
    and v.active)`;

const StorefrontHeadSchema = Schema.Struct({
  homepageFeaturedProductIds: Schema.Array(ProductIdReferenceSchema),
  revision: Schema.Int,
});
type StorefrontHead = typeof StorefrontHeadSchema.Type;
type StorefrontHeadEncoded = typeof StorefrontHeadSchema.Encoded;

interface ProductPage {
  readonly head: StorefrontHead | null;
  readonly products: readonly ProductRecord[];
  readonly total: number;
}

/**
 * One page of product records. `variants: false` (list rows) leaves variants out and takes the derived stock
 * fields from their stored columns; detail pages hydrate variants and derive records exactly like a write does.
 */
const productPage = Effect.fn('MerchandiseQueries.productPage')(function* productPage(
  db: MerchandiseDb,
  scope: StoreScope,
  input: {
    readonly catalogHead?: boolean;
    readonly filters: readonly (SQL | undefined)[];
    readonly limit: number;
    readonly offset: number;
    readonly orderBy: readonly SQL[];
    readonly variantCount?: boolean;
    readonly variantPreview?: boolean;
    readonly variants: boolean;
    readonly variantSummary?: boolean;
  },
) {
  const where = and(whereScope(products, scope), ...input.filters);
  // Count and page share one statement/snapshot, including an empty or out-of-range page. Each
  // relation is aggregated independently, avoiding a variants × tiers join and tunnel round trips.
  const counted = db
    .select({
      head:
        input.catalogHead === true
          ? sql<StorefrontHeadEncoded | null>`(select json_build_object(
            'revision', ${catalogHeads.revision}, 'homepageFeaturedProductIds', ${featuredProductIdsOf(scope)})
          from ${catalogHeads} where ${whereScope(catalogHeads, scope)}
            and (${catalogHeads.bootstrapCheckpoint} is null
              or ${catalogHeads.bootstrapCheckpoint}->>'status' = 'VERIFIED'))`.as('head')
          : sql<StorefrontHeadEncoded | null>`null::json`.as('head'),
      total: sql<number>`count(*)::int`.as('total'),
    })
    .from(products)
    .where(where)
    .as('product_total');
  const tierVariantFilter = input.variants ? sql.empty() : sql`and t.variant_position = -1`;
  const selected = db
    .select({
      ...productSelection,
      // Outer paging order must survive the join, without a window that hydrates skipped rows.
      hasPhoto: products.hasPhoto,
      nameKey: products.nameKey,
      ordinal: products.ordinal,
      skuKey: products.skuKey,
      tierRows: sql<Parameters<typeof hydrateProducts>[2]>`(select coalesce(json_agg(json_build_object(
          'minimumQuantity', t.minimum_quantity, 'position', t.position,
          'priceExcludingVatMinor', t.price_excluding_vat_minor, 'priceMinor', t.price_minor,
          'productId', t.product_id, 'variantPosition', t.variant_position)), '[]'::json)
        from ${priceTiers} t
        where t.tenant_id = ${scope.tenantId}::uuid and t.legal_entity_id = ${scope.legalEntityId}::uuid
          and t.product_id = ${outerProductId}
          ${tierVariantFilter})`.as('tier_rows'),
      updatedAt: products.updatedAt,
      variantCount:
        input.variantCount === true
          ? sql<number>`(select count(*)::int from ${productVariants} v
            where v.tenant_id = ${scope.tenantId}::uuid and v.legal_entity_id = ${scope.legalEntityId}::uuid
              and v.product_id = ${outerProductId} and v.variant_id is not null
              and v.price_minor is not null)`.as('variant_count')
          : sql<number | null>`null::int`.as('variant_count'),
      variantPreview:
        input.variantPreview === true
          ? sql<typeof StorefrontVariantPreviewSchema.Encoded.variants>`(select coalesce(
              json_agg(json_build_object('id', v.variant_id, 'name', v.name) order by v.position), '[]'::json)
            from (select v.variant_id, v.name, v.position from ${productVariants} v
              where v.tenant_id = ${scope.tenantId}::uuid and v.legal_entity_id = ${scope.legalEntityId}::uuid
                and v.product_id = ${outerProductId} and v.variant_id is not null and v.price_minor is not null
                and v.active
              order by v.position limit 3) v)`.as('variant_preview')
          : sql<typeof StorefrontVariantPreviewSchema.Encoded.variants | null>`null::json`.as('variant_preview'),
      variantRows: input.variants
        ? sql<Parameters<typeof hydrateProducts>[1]>`(select coalesce(json_agg(json_build_object(
            'document', v.document, 'position', v.position, 'productId', v.product_id,
            'stockOnHand', v.stock_on_hand, 'variantId', v.variant_id)), '[]'::json)
          from ${productVariants} v
          where v.tenant_id = ${scope.tenantId}::uuid and v.legal_entity_id = ${scope.legalEntityId}::uuid
            and v.product_id = ${outerProductId})`.as('variant_rows')
        : sql<Parameters<typeof hydrateProducts>[1]>`'[]'::json`.as('variant_rows'),
      variantSummary:
        input.variantSummary === true
          ? variantSummarySql(scope).as('variant_summary')
          : sql<VariantSummaryEncoded | null>`null::json`.as('variant_summary'),
    })
    .from(products)
    .where(where)
    .orderBy(...input.orderBy)
    .limit(input.limit)
    .offset(input.offset)
    .as('product_page');
  const result = yield* query(
    db
      .select({
        head: counted.head,
        product: {
          availability: selected.availability,
          document: selected.document,
          grossPriceMinor: selected.grossPriceMinor,
          id: selected.id,
          lowStock: selected.lowStock,
          stockOnHand: selected.stockOnHand,
          stockValueMinor: selected.stockValueMinor,
          tierRows: selected.tierRows,
          variantCount: selected.variantCount,
          variantPreview: selected.variantPreview,
          variantRows: selected.variantRows,
          variantSummary: selected.variantSummary,
        },
        total: counted.total,
      })
      .from(counted)
      .leftJoin(selected, sql`true`)
      .orderBy(...input.orderBy.map((order) => mapColumnsInSQLToAlias(order, 'product_page'))),
    'Products could not be read',
  );
  const total = result[0]?.total ?? 0;
  const rows = result.flatMap(({ product }) => (product === null ? [] : [product]));
  const variantRows = rows.flatMap((row) => row.variantRows);
  const tierRows = rows.flatMap((row) => row.tierRows);
  const hydrated = yield* hydrateProducts(rows, variantRows, tierRows).pipe(Effect.mapError(storedRowsFailure));
  const records = yield* Effect.forEach(
    hydrated,
    Effect.fn('MerchandiseQueries.productRecord')(function* productRecord(
      { product, stock }: (typeof hydrated)[number],
      index: number,
    ) {
      const row = rows[index];
      if (row === undefined) {
        return yield* new MerchandiseStoreFailure({ reason: STORED_ROWS_REASON });
      }
      const [variantSummary, availability] = yield* Effect.all(
        [
          row.variantSummary === null ? Effect.void : Schema.decodeEffect(VariantSummarySchema)(row.variantSummary),
          input.variants ? Effect.void : Schema.decodeUnknownEffect(AvailabilitySchema)(row.availability),
        ],
        { concurrency: 1 },
      ).pipe(Effect.mapError(storedRowsFailure));
      let record: ProductRecord;
      if (input.variants) {
        record = toProductRecord(product, stock);
      } else {
        const { variants: _variants, ...rest } = product;
        void _variants;
        record = {
          ...rest,
          lowStock: row.lowStock,
          stockOnHand: row.stockOnHand,
          stockValueMinor: row.stockValueMinor,
        };
        if (availability !== undefined) {
          record = { ...record, availability };
        }
        if (row.grossPriceMinor !== null) {
          record = { ...record, grossPriceMinor: row.grossPriceMinor };
        }
      }
      if (variantSummary !== undefined) {
        record = { ...record, variantSummary };
        if (row.variantPreview !== null) {
          const storefrontVariantPreview = yield* Schema.decodeEffect(StorefrontVariantPreviewSchema)({
            total: variantSummary.count,
            variants: row.variantPreview,
          }).pipe(Effect.mapError(storedRowsFailure));
          record = { ...record, storefrontVariantPreview };
        }
      }
      if (row.variantCount !== null) {
        record = { ...record, variantCount: row.variantCount };
      }
      return record;
    }),
    { concurrency: 1 },
  );
  const rawHead = result[0]?.head;
  const head =
    rawHead === undefined || rawHead === null
      ? null
      : yield* Schema.decodeEffect(StorefrontHeadSchema)(rawHead).pipe(Effect.mapError(storedRowsFailure));
  return { head, products: records, total } satisfies ProductPage;
});

const staffProductFilters = (view: RecordsView, storefront: boolean): (SQL | undefined)[] => [
  eq(products.archived, false),
  ...(storefront ? [eq(products.active, true), eq(products.published, true)] : []),
  view.productId === undefined ? undefined : eq(products.id, view.productId),
  view.productIds === undefined ? undefined : idsFilter(products.id, view.productIds),
  view.taggedProductIds === undefined ? undefined : idsFilter(products.id, view.taggedProductIds),
  view.slug === undefined ? undefined : eq(products.slug, view.slug),
  view.categoryId === undefined
    ? undefined
    : or(eq(products.categoryId, view.categoryId), sql`${products.categoryPathIds} @> ${textArray([view.categoryId])}`),
  ...containsAll(products.searchText, wordsOf(view.search)),
  view.active === undefined ? undefined : eq(products.active, view.active),
  view.category === undefined ? undefined : eq(products.category, view.category),
  view.lowStockOnly === true ? eq(products.lowStock, true) : undefined,
];

const staffProductOrder = (sort: RecordsView['productSort']): SQL[] =>
  Match.value(sort).pipe(
    Match.when('name', () => [asc(products.nameKey), asc(products.ordinal)]),
    Match.when('sku', () => [asc(products.skuKey)]),
    Match.when('price-asc', () => [sql`${products.grossPriceMinor} asc nulls last`, asc(products.ordinal)]),
    Match.when('price-desc', () => [sql`${products.grossPriceMinor} desc nulls last`, asc(products.ordinal)]),
    Match.when('stock-asc', () => [asc(products.stockOnHand), asc(products.ordinal)]),
    Match.when('stock-desc', () => [desc(products.stockOnHand), asc(products.ordinal)]),
    Match.when('updated-desc', () => [desc(products.updatedAt), asc(products.ordinal)]),
    Match.orElse(() => [asc(products.ordinal)]),
  );

/** Staff (and plain storefront) product page; customers never see price or content history. */
export const staffProducts = (
  db: MerchandiseDb,
  scope: StoreScope,
  view: RecordsView,
  storefront: boolean,
  input: { readonly detailLimit?: number } = {},
) =>
  productPage(db, scope, {
    filters: staffProductFilters(view, storefront),
    limit:
      view.summary === true
        ? (view.limit ?? DEFAULT_PRODUCT_LIMIT)
        : Math.min(view.limit ?? PRODUCT_DETAIL_PAGE_LIMIT, input.detailLimit ?? PRODUCT_DETAIL_PAGE_LIMIT),
    offset: view.offset ?? 0,
    orderBy: staffProductOrder(view.productSort),
    variantCount: view.summary === true,
    variants: view.summary !== true,
    variantSummary: view.summary === true,
  }).pipe(
    Effect.map((page) => ({
      ...page,
      products: page.products.map((record): ProductRecord => {
        if (view.summary === true) {
          const { contentHistory: _history, ...summary } = record;
          void _history;
          return { ...summary, priceHistory: [] };
        }
        if (!storefront) {
          return record;
        }
        const { contentHistory: _content, variants: _raw, ...publicProduct } = record;
        void _raw;
        void _content;
        const projected = { ...publicProduct, priceHistory: [] };
        return record.variantRecords === undefined
          ? projected
          : {
              ...projected,
              variantRecords: record.variantRecords.map((variant) => ({ ...variant, priceHistory: [] })),
            };
      }),
    })),
  );

/** At most this many distinct product category labels; free-text categories of one company stay far below it. */
const PRODUCT_CATEGORY_LIMIT = 500;

/**
 * The distinct `category` labels of the company's (non-archived) products with their product counts, in Czech
 * alphabetical order: the staff category filter of companies without a storefront category tree.
 */
export const productCategoryCounts = Effect.fn('MerchandiseQueries.productCategoryCounts')(
  function* productCategoryCounts(db: MerchandiseDb, scope: StoreScope) {
    const rows = yield* query(
      db
        .select({ name: products.category, productCount: sql<number>`count(*)::int` })
        .from(products)
        .where(and(whereScope(products, scope), eq(products.archived, false)))
        .groupBy(products.category)
        .orderBy(asc(products.category))
        .limit(PRODUCT_CATEGORY_LIMIT),
      'Product categories could not be read',
    );
    return rows.toSorted((left, right) => left.name.localeCompare(right.name, 'cs'));
  },
);

/** Scoped scalar subquery: resolve a slug in the consuming statement, not a separate round trip. */
const categoryIdBySlug = (db: MerchandiseDb, scope: StoreScope, slug: string) =>
  db
    .select({ id: categories.id })
    .from(categories)
    .where(and(whereScope(categories, scope), eq(categories.slug, slug)))
    .limit(1);

const labelFilter = (label: NonNullable<StorefrontCatalogQuery['label']>) => {
  if (label === 'action') {
    return eq(products.isAction, true);
  }
  if (label === 'recommended') {
    return eq(products.isRecommended, true);
  }
  if (label === 'sale') {
    return eq(products.isSale, true);
  }
  return eq(products.isNew, true);
};
const storefrontBaseOrder = (catalog: StorefrontCatalogQuery, featuredIds: SQL): SQL[] => {
  if (catalog.productIds !== undefined) {
    return [sql`array_position(${textArray(catalog.productIds)}, ${products.id})`];
  }
  if (catalog.featured === true) {
    return [sql`array_position(${featuredIds}, ${products.id}) asc nulls last`, asc(products.ordinal)];
  }
  return [asc(products.ordinal)];
};
const storefrontPriceOrder = (sort: StorefrontCatalogQuery['sort'], ranked: SQL[]): SQL[] => {
  if (sort === 'price-asc') {
    return [sql`${products.grossPriceMinor} asc nulls last`, ...ranked];
  }
  if (sort === 'price-desc') {
    return [sql`${products.grossPriceMinor} desc nulls last`, ...ranked];
  }
  return ranked;
};

const IN_STOCK = ['IN_STOCK', 'LOW_STOCK'];

const storefrontFilters = (
  catalog: StorefrontCatalogQuery,
  featuredIds: SQL,
  categoryId: ReturnType<typeof categoryIdBySlug> | undefined,
) => [
  eq(products.archived, false),
  eq(products.active, true),
  eq(products.published, true),
  catalog.featured === true
    ? or(sql`${products.id} = any(${featuredIds})`, eq(products.isRecommended, true))
    : undefined,
  catalog.productIds === undefined ? undefined : idsFilter(products.id, catalog.productIds),
  catalog.slug === undefined ? undefined : eq(products.slug, catalog.slug),
  categoryId === undefined
    ? undefined
    : or(eq(products.categoryId, categoryId), sql`${products.categoryPathIds} @> array[${categoryId}]::text[]`),
  catalog.label === undefined ? undefined : labelFilter(catalog.label),
  catalog.minMinor === undefined ? undefined : sql`coalesce(${products.grossPriceMinor}, 0) >= ${catalog.minMinor}`,
  catalog.maxMinor === undefined ? undefined : sql`coalesce(${products.grossPriceMinor}, 0) <= ${catalog.maxMinor}`,
  catalog.availability === 'in-stock' ? inArray(products.availability, IN_STOCK) : undefined,
  catalog.availability === 'out-of-stock' ? sql`${products.availability} not in ('IN_STOCK', 'LOW_STOCK')` : undefined,
];

/** Market-currency price bounds as the equivalent CZK bounds of the stored gross prices. */
const catalogInCzk = (catalog: StorefrontCatalogQuery, pricing: Option.Option<StoredMarket>): StorefrontCatalogQuery =>
  Option.match(pricing, {
    onNone: () => catalog,
    onSome: (market) => ({ ...catalog, ...czkBoundsForMarket(catalog, market) }),
  });

const SearchVariantRowSchema = Schema.Struct({
  id: VariantIdSchema,
  /** Historical inline leaf row; its presentation scalars live in the product document, not in variant rows. */
  inline: Schema.Boolean,
  name: Schema.String,
  parameters: Schema.Array(CatalogParameterSchema),
  position: Schema.Int,
  productId: ProductIdReferenceSchema,
  sku: Schema.OptionFromNullOr(Schema.String),
});
type SearchVariantRow = typeof SearchVariantRowSchema.Type;

const parametersText = (parameters: ProductRecord['parameters']) =>
  (parameters ?? []).map(({ label, unit, value }) => `${label} ${value} ${unit}`).join(' ');

/** Preserve existing storefront substring attribution, independently of catalog all-word inclusion. */
const searchPlanOf = (product: ProductRecord, rows: readonly SearchVariantRow[], needle: string) => {
  const exact: SearchVariantRow[] = [];
  const matching: SearchVariantRow[] = [];
  for (const row of rows) {
    const sku = Option.getOrElse(row.sku, () => `${product.sku}-${row.id}`);
    if (normalizeSearchText(sku) === needle) {
      exact.push(row);
    }
    if (normalizeSearchText(`${sku} ${row.name} ${parametersText(row.parameters)}`).includes(needle)) {
      matching.push(row);
    }
  }
  const description = (product.description ?? '')
    .split(/\n\s*\n/u)
    .find((paragraph) => paragraph.trim() !== '')
    ?.trim();
  const productMatches = normalizeSearchText(
    `${product.name} ${product.sku} ${description ?? product.shortDescription ?? ''} ${parametersText(product.parameters)}`,
  ).includes(needle);
  let attributed = matching;
  if (exact.length > 0) {
    attributed = exact;
  } else if (productMatches) {
    attributed = [];
  }
  let kind: SearchMatch['kind'] = 'unattributed';
  let selected: SearchVariantRow | undefined;
  if (attributed.length === 1) {
    kind = 'single';
    [selected] = attributed;
  } else if (attributed.length > 1) {
    kind = 'multiple';
  } else {
    if (productMatches) {
      kind = 'product';
    }
    selected = rows.length === 1 ? rows[0] : undefined;
  }
  return { count: attributed.length, kind, product, selected };
};
type SearchPlan = ReturnType<typeof searchPlanOf>;

// ProductMetadataSchema's canonical maximum; overflow fails closed, never truncates evidence.
const MAX_PRODUCT_VARIANTS = 1000;
const VARIANT_SET_OVERFLOW_REASON = 'Stored variant set exceeds the catalog bound';
const CURRENT_SEARCH_BATCH = 128;
const CurrentSearchProductSchema = Schema.Struct({
  id: ProductIdReferenceSchema,
  legacyVariants: Schema.Array(ProductVariantSchema).check(Schema.isMaxLength(MAX_PRODUCT_VARIANTS)),
  name: Schema.String,
  ordinal: Schema.Int,
  parameters: Schema.Array(CatalogParameterSchema),
  shortDescription: Schema.String,
  sku: Schema.String,
});
const CurrentSearchVariantSchema = Schema.Struct({
  attributes: Schema.String,
  name: Schema.String,
  parameters: Schema.Array(CatalogParameterSchema),
  productId: ProductIdReferenceSchema,
  sku: Schema.OptionFromNullOr(Schema.String),
});

/**
 * Exact current inclusion uses the SAME JS normalizer as writes. A finite SQL accent translation or a different
 * ICU/Unicode casing version is not that contract. Stream only text scalars in bounded candidate batches,
 * exhaust them BEFORE SQL count/public pagination, and hydrate only the eventual public page.
 */
const currentSearchBatch = Effect.fn('MerchandiseQueries.currentSearchBatch')(function* currentSearchBatch(
  db: MerchandiseDb,
  scope: StoreScope,
  filters: readonly (SQL | undefined)[],
  words: readonly string[],
  after: Option.Option<number>,
) {
  const rows = yield* query(
    db
      .select({
        id: products.id,
        // Historical inline fallback: project only searchable fields, NEVER full inline variants/history/tier blobs.
        legacyVariants: sql<unknown>`case when exists(select 1 from ${productVariants} existing
      where existing.tenant_id = ${scope.tenantId}::uuid and existing.legal_entity_id = ${scope.legalEntityId}::uuid
        and existing.product_id = ${outerProductId}) then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'active', legacy.value->'active', 'attributes', legacy.value->'attributes',
        'name', legacy.value->'name', 'parameters', legacy.value->'parameters', 'sku', legacy.value->'sku'))
        order by legacy.position), '[]'::jsonb)
      from jsonb_array_elements(coalesce(${products.document}->'variants', '[]'::jsonb))
        with ordinality legacy(value, position) where legacy.position <= ${MAX_PRODUCT_VARIANTS + 1}) end`,
        name: products.name,
        ordinal: products.ordinal,
        parameters: sql<unknown>`coalesce(${products.document}->'parameters', '[]'::jsonb)`,
        shortDescription: sql<string>`coalesce(${products.document}->>'shortDescription', '')`,
        sku: products.sku,
      })
      .from(products)
      .where(
        and(
          whereScope(products, scope),
          ...filters,
          Option.getOrUndefined(after.pipe(Option.map((ordinal) => gt(products.ordinal, ordinal)))),
        ),
      )
      .orderBy(asc(products.ordinal))
      .limit(CURRENT_SEARCH_BATCH),
  );
  const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(CurrentSearchProductSchema))(rows).pipe(
    Effect.mapError(storedRowsFailure),
  );
  if (candidates.length === 0) {
    return { after, done: true, ids: [] };
  }
  const variantRows = yield* query(
    db
      .select({
        attributes: sql<string>`coalesce(${productVariants.document}->>'attributes', '')`,
        name: productVariants.name,
        parameters: sql<unknown>`coalesce(${productVariants.document}->'parameters', '[]'::jsonb)`,
        productId: productVariants.productId,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .where(
        and(
          whereScope(productVariants, scope),
          idsFilter(
            productVariants.productId,
            candidates.map((product) => product.id),
          ),
          eq(productVariants.active, true),
        ),
      )
      .orderBy(asc(productVariants.position))
      .limit(candidates.length * MAX_PRODUCT_VARIANTS + 1),
  );
  const variants = yield* Schema.decodeUnknownEffect(Schema.Array(CurrentSearchVariantSchema))(variantRows).pipe(
    Effect.mapError(storedRowsFailure),
  );
  const grouped = new Map<string, (typeof variants)[number][]>();
  for (const variant of variants) {
    const group = grouped.get(variant.productId) ?? [];
    group.push(variant);
    grouped.set(variant.productId, group);
  }
  if ([...grouped.values()].some((group) => group.length > MAX_PRODUCT_VARIANTS)) {
    return yield* new MerchandiseStoreFailure({ reason: VARIANT_SET_OVERFLOW_REASON });
  }
  const ids = candidates.flatMap((product) => {
    const normalized = grouped.get(product.id);
    const text = productSearchText({
      ...product,
      variants:
        normalized === undefined
          ? product.legacyVariants
          : normalized.map((variant) => ({
              attributes: variant.attributes,
              name: variant.name,
              parameters: variant.parameters,
              sku: Option.getOrElse(variant.sku, () => ''),
            })),
    });
    return words.every((word) => text.includes(word)) ? [product.id] : [];
  });
  return {
    after: Option.fromUndefinedOr(candidates.at(-1)?.ordinal),
    done: candidates.length < CURRENT_SEARCH_BATCH,
    ids,
  };
});

const currentProductInclusion = Effect.fn('MerchandiseQueries.currentProductInclusion')(
  function* currentProductInclusion(
    db: MerchandiseDb,
    scope: StoreScope,
    filters: readonly (SQL | undefined)[],
    words: readonly string[],
  ) {
    const [head] = yield* query(
      db
        .select({ revision: catalogHeads.revision })
        .from(catalogHeads)
        .where(
          and(
            whereScope(catalogHeads, scope),
            or(
              sql`${catalogHeads.bootstrapCheckpoint} is null`,
              sql`${catalogHeads.bootstrapCheckpoint}->>'status' = 'VERIFIED'`,
            ),
          ),
        )
        .limit(1),
    );
    if (head === undefined) {
      return yield* new MerchandiseStoreFailure({ reason: 'The storefront catalog is not initialized' });
    }
    let after = Option.none<number>();
    let done = false;
    const ids: ProductRecord['id'][] = [];
    yield* Effect.whileLoop({
      body: () => currentSearchBatch(db, scope, filters, words, after),
      step: (batch) => {
        ({ after, done } = batch);
        ids.push(...batch.ids);
      },
      while: () => !done,
    });
    // One schema-encoded bound value avoids a parameter ceiling for broad searches, without a result cache.
    const encodedIds = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProductIdReferenceSchema)))(
      ids,
    ).pipe(Effect.mapError(storedRowsFailure));
    const filter =
      ids.length === 0 ? sql`false` : sql`${products.id} in (select jsonb_array_elements_text(${encodedIds}::jsonb))`;
    return { filter, revision: head.revision };
  },
);

/** Only searchable scalars, not variant documents, stock, prices, histories or tiers of whole groups. */
const searchVariantRows = Effect.fn('MerchandiseQueries.searchVariantRows')(function* searchVariantRows(
  db: MerchandiseDb,
  scope: StoreScope,
  page: readonly ProductRecord[],
) {
  const rows = yield* query(
    db
      .select({
        id: productVariants.variantId,
        inline: sql<boolean>`false`.as('inline'),
        name: productVariants.name,
        parameters: sql<unknown>`coalesce(${productVariants.document}->'parameters', '[]'::jsonb)`,
        position: productVariants.position,
        productId: productVariants.productId,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .where(
        and(
          whereScope(productVariants, scope),
          idsFilter(
            productVariants.productId,
            page.map((product) => product.id),
          ),
          eq(productVariants.active, true),
          sql`${productVariants.variantId} is not null`,
          sql`${productVariants.priceMinor} is not null`,
        ),
      )
      .orderBy(asc(productVariants.position))
      .limit(page.length * MAX_PRODUCT_VARIANTS + 1),
  );
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(SearchVariantRowSchema))(rows).pipe(
    Effect.mapError(storedRowsFailure),
  );
  const grouped = new Map<string, SearchVariantRow[]>();
  for (const row of decoded) {
    const group = grouped.get(row.productId) ?? [];
    group.push(row);
    grouped.set(row.productId, group);
  }
  if ([...grouped.values()].some((group) => group.length > MAX_PRODUCT_VARIANTS)) {
    return yield* new MerchandiseStoreFailure({ reason: VARIANT_SET_OVERFLOW_REASON });
  }
  // A product without any normalized variant rows still exposes its historical inline leaf set; the owner hydrator
  // keeps those inline variants only under the same zero-row condition. Project searchable/leaf scalars only.
  const legacyRows = yield* query(
    db
      .select({
        productId: products.id,
        variants: sql<unknown>`case when exists(select 1 from ${productVariants} existing
      where existing.tenant_id = ${scope.tenantId}::uuid and existing.legal_entity_id = ${scope.legalEntityId}::uuid
        and existing.product_id = ${outerProductId}) then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', legacy.value->'id', 'inline', true, 'name', legacy.value->'name',
        'parameters', case when jsonb_typeof(legacy.value->'parameters') = 'array'
          then legacy.value->'parameters' else '[]'::jsonb end,
        'position', (legacy.position - 1)::int, 'productId', ${outerProductId}, 'sku', legacy.value->'sku')
        order by legacy.position), '[]'::jsonb)
      from jsonb_array_elements(coalesce(${products.document}->'variants', '[]'::jsonb))
        with ordinality legacy(value, position)
      where legacy.position <= ${MAX_PRODUCT_VARIANTS + 1}
        and jsonb_typeof(legacy.value->'id') = 'string'
        and jsonb_typeof(legacy.value->'priceMinor') = 'number'
        and coalesce((legacy.value->>'active')::boolean, true)) end`,
      })
      .from(products)
      .where(
        and(
          whereScope(products, scope),
          idsFilter(
            products.id,
            page.map((product) => product.id),
          ),
        ),
      ),
  );
  const legacy = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        productId: ProductIdReferenceSchema,
        variants: Schema.Array(SearchVariantRowSchema),
      }),
    ),
  )(legacyRows).pipe(Effect.mapError(storedRowsFailure));
  for (const candidate of legacy) {
    if (candidate.variants.length > MAX_PRODUCT_VARIANTS) {
      return yield* new MerchandiseStoreFailure({ reason: VARIANT_SET_OVERFLOW_REASON });
    }
    if (candidate.variants.length > 0 && !grouped.has(candidate.productId)) {
      grouped.set(candidate.productId, [...candidate.variants]);
    }
  }
  return grouped;
});

const selectedSearchRows = Effect.fn('MerchandiseQueries.selectedSearchRows')(function* selectedSearchRows(
  db: MerchandiseDb,
  scope: StoreScope,
  plans: readonly SearchPlan[],
) {
  const pairs = plans.flatMap((plan) => (plan.selected === undefined ? [] : [plan.selected]));
  if (pairs.length === 0) {
    return { inlineVariants: [], tiers: [], variants: [] };
  }
  const normalizedPairs = pairs.filter((pair) => !pair.inline);
  const inlinePairs = pairs.filter((pair) => pair.inline);
  // A variant id is NOT globally unique. Every predicate is a product+position pair, not two independent IN lists.
  const variants: { readonly document: unknown; readonly productId: string; readonly stockOnHand: number }[] =
    normalizedPairs.length === 0
      ? []
      : yield* query(
          db
            .select({
              document: sql<unknown>`jsonb_strip_nulls(jsonb_build_object(
      'active', ${productVariants.active}, 'attributes', '', 'id', ${productVariants.variantId},
      'name', ${productVariants.name}, 'priceMinor', ${productVariants.priceMinor}, 'sku', ${productVariants.sku},
      'unit', ${productVariants.document}->'unit', 'sourceUnit', ${productVariants.document}->'sourceUnit',
      'imageSrc', ${productVariants.document}->'imageSrc',
      'minimumQuantity', ${productVariants.document}->'minimumQuantity',
      'packageQuantity', ${productVariants.document}->'packageQuantity'))`,
              productId: productVariants.productId,
              stockOnHand: productVariants.stockOnHand,
            })
            .from(productVariants)
            .where(
              and(
                whereScope(productVariants, scope),
                eq(productVariants.active, true),
                sql`${productVariants.variantId} is not null`,
                sql`${productVariants.priceMinor} is not null`,
                or(
                  ...normalizedPairs.map((pair) =>
                    and(eq(productVariants.productId, pair.productId), eq(productVariants.position, pair.position)),
                  ),
                ),
              ),
            )
            .limit(normalizedPairs.length + 1),
        );
  if (variants.length !== normalizedPairs.length) {
    return yield* new MerchandiseStoreFailure({ reason: 'The selected search variants changed during the read' });
  }
  const tiers =
    normalizedPairs.length === 0
      ? []
      : yield* query(
          db
            .select({
              minimumQuantity: priceTiers.minimumQuantity,
              position: priceTiers.position,
              priceExcludingVatMinor: priceTiers.priceExcludingVatMinor,
              priceMinor: priceTiers.priceMinor,
              productId: priceTiers.productId,
            })
            .from(priceTiers)
            .where(
              and(
                whereScope(priceTiers, scope),
                or(
                  ...normalizedPairs.map((pair) =>
                    and(eq(priceTiers.productId, pair.productId), eq(priceTiers.variantPosition, pair.position)),
                  ),
                ),
              ),
            )
            .orderBy(asc(priceTiers.position)),
        );
  // Historical inline leaves are selected by the same product+document-position pair. Only the selected variant's
  // approved owner scalars and its own tiers are projected; histories, informational siblings and other groups stay out.
  const encodedPairs =
    inlinePairs.length === 0
      ? undefined
      : yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Array(Schema.Struct({ position: Schema.Int, product_id: ProductIdReferenceSchema })),
          ),
        )(inlinePairs.map((pair) => ({ position: pair.position, product_id: pair.productId }))).pipe(
          Effect.mapError(storedRowsFailure),
        );
  const inlineVariants =
    encodedPairs === undefined
      ? []
      : yield* query(
          db
            .select({
              document: sql<unknown>`jsonb_strip_nulls(jsonb_build_object(
      'active', true, 'attributes', '', 'id', legacy.value->'id',
      'imageSrc', legacy.value->'imageSrc',
      'minimumQuantity', legacy.value->'minimumQuantity',
      'name', legacy.value->'name',
      'packageQuantity', legacy.value->'packageQuantity',
      'priceMinor', legacy.value->'priceMinor',
      'priceTiers', case when jsonb_typeof(legacy.value->'priceTiers') = 'array' then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'minimumQuantity', tier.value->'minimumQuantity',
          'priceExcludingVatMinor', tier.value->'priceExcludingVatMinor',
          'priceMinor', tier.value->'priceMinor') order by tier.position), '[]'::jsonb)
        from jsonb_array_elements(legacy.value->'priceTiers') with ordinality tier(value, position)
      ) end,
      'sku', legacy.value->'sku',
      'sourceUnit', legacy.value->'sourceUnit',
      'unit', legacy.value->'unit'))`,
              productId: products.id,
            })
            .from(sql`jsonb_to_recordset(${encodedPairs}::jsonb) as pair(product_id text, position int)`)
            .innerJoin(products, sql`${products.id} = pair.product_id`)
            .crossJoin(
              sql`jsonb_array_elements(coalesce(${products.document}->'variants', '[]'::jsonb))
                with ordinality as legacy(value, position)`,
            )
            .where(and(whereScope(products, scope), sql`(legacy.position - 1)::int = pair.position`))
            .limit(inlinePairs.length + 1),
        );
  if (inlineVariants.length !== inlinePairs.length) {
    return yield* new MerchandiseStoreFailure({ reason: 'The selected search variants changed during the read' });
  }
  return { inlineVariants, tiers, variants };
});

const searchMatchOf = Effect.fn('MerchandiseQueries.searchMatchOf')(function* searchMatchOf(
  plan: SearchPlan,
  selected: Effect.Success<ReturnType<typeof selectedSearchRows>>,
  pricing: Option.Option<StoredMarket>,
): Effect.fn.Return<SearchMatch, MerchandiseStoreFailure> {
  if (plan.kind === 'multiple') {
    return { count: plan.count, kind: 'multiple' };
  }
  if (plan.selected === undefined) {
    return { kind: plan.kind === 'product' ? 'product' : 'unattributed' };
  }
  const normalized = plan.selected.inline
    ? undefined
    : selected.variants.find((variant) => variant.productId === plan.product.id);
  const inline = plan.selected.inline
    ? selected.inlineVariants.find((variant) => variant.productId === plan.product.id)
    : undefined;
  const document = normalized?.document ?? inline?.document;
  if (document === undefined) {
    return yield* new MerchandiseStoreFailure({ reason: 'A selected search variant is missing' });
  }
  const decoded = yield* Schema.decodeUnknownEffect(ProductVariantSchema)(document).pipe(
    Effect.mapError(storedRowsFailure),
  );
  const tiers = plan.selected.inline
    ? []
    : selected.tiers.flatMap((tier) =>
        tier.productId === plan.product.id
          ? [
              {
                minimumQuantity: tier.minimumQuantity,
                priceExcludingVatMinor: tier.priceExcludingVatMinor,
                priceMinor: tier.priceMinor,
              },
            ]
          : [],
      );
  const variant = tiers.length === 0 ? decoded : { ...decoded, priceTiers: tiers };
  const record = toProductRecord(
    { ...plan.product, variants: [variant] },
    {
      total: plan.product.stockOnHand,
      // No normalized variant row exists for a historical inline leaf, so the owner hydrator has no stock entry for
      // it either; let `toProductRecord` derive the same value instead of fabricating a number here.
      variants:
        normalized === undefined ? new Map<string, number>() : new Map([[plan.selected.id, normalized.stockOnHand]]),
    },
  );
  const leaf = record.variantRecords?.[0];
  if (leaf === undefined || leaf.id !== plan.selected.id || !leaf.active) {
    return yield* new MerchandiseStoreFailure({ reason: 'A selected search variant is no longer sellable' });
  }
  const offer = searchVariantOffer(leaf, pricing);
  return plan.kind === 'single'
    ? { kind: 'single', variant: offer }
    : { kind: plan.kind === 'product' ? 'product' : 'unattributed', onlyVariant: offer };
});

const currentSearchMatches = Effect.fn('MerchandiseQueries.currentSearchMatches')(function* currentSearchMatches(
  db: MerchandiseDb,
  scope: StoreScope,
  page: readonly ProductRecord[],
  needle: string,
  pricing: Option.Option<StoredMarket>,
) {
  if (needle === '' || page.length === 0) {
    return new Map<string, SearchMatch>();
  }
  const grouped = yield* searchVariantRows(db, scope, page);
  const plans = page.map((product) => searchPlanOf(product, grouped.get(product.id) ?? [], needle));
  const selected = yield* selectedSearchRows(db, scope, plans);
  const matches = yield* Effect.forEach(
    plans,
    (plan) => searchMatchOf(plan, selected, pricing).pipe(Effect.map((match) => [plan.product.id, match] as const)),
    { concurrency: 1 },
  );
  return new Map(matches);
});

const verifySearchRevision = Effect.fn('MerchandiseQueries.verifySearchRevision')(function* verifySearchRevision(
  db: MerchandiseDb,
  scope: StoreScope,
  head: StorefrontHead,
  needle: string,
  productCount: number,
) {
  if (needle === '' || productCount === 0) {
    return yield* Effect.void;
  }
  // Additional bounded reads must not release evidence mixed across canonical writer revisions.
  const currentHead = yield* loadHead(db, scope);
  if (currentHead?.revision !== head.revision) {
    return yield* new MerchandiseStoreFailure({ reason: 'The catalog changed during the search read' });
  }
  return yield* Effect.void;
});

/**
 * Storefront catalog page: visible products (active, published, not archived), filters AND-ed, relevance or price
 * order, one page. Listing cards (`fields: 'card'`) never hydrate variants; they carry only a three-name preview
 * and `variantSummary` from the same SQL snapshot.
 * With `market` (the catalog's resolved `marketId`) only that market's offer is listed and every price is in its
 * currency.
 */
export const storefrontProducts = Effect.fn('MerchandiseQueries.storefrontProducts')(function* storefrontProducts(
  db: MerchandiseDb,
  scope: StoreScope,
  input: { readonly market?: CatalogMarketScope; readonly query: StorefrontCatalogQuery },
) {
  const { offer, pricing } = input.market ?? NO_CATALOG_MARKET;
  const catalog = catalogInCzk(input.query, pricing);
  const featuredIds = sql`${featuredProductIdsOf(scope)}::text[]`;
  const categoryId = catalog.categorySlug === undefined ? undefined : categoryIdBySlug(db, scope, catalog.categorySlug);
  const words = wordsOf(catalog.q);
  const needle = normalizeSearchText(catalog.q ?? '');
  const baseFilters = [...storefrontFilters(catalog, featuredIds, categoryId), Option.getOrUndefined(offer)];
  const inclusion = words.length === 0 ? undefined : yield* currentProductInclusion(db, scope, baseFilters, words);
  const filters = inclusion === undefined ? baseFilters : [...baseFilters, inclusion.filter];
  const nameSku = sql`${products.nameKey} || ' ' || ${products.skuKey}`;
  const relevance =
    words.length === 0
      ? []
      : [
          sql`case
            when ${products.nameKey} = ${needle} or ${products.skuKey} = ${needle} then 0
            when ${products.nameKey} like ${`%${likeEscape(needle)}%`} or ${products.skuKey} like ${`%${likeEscape(needle)}%`} then 1
            when ${and(...containsAll(nameSku, words))} then 2
            else 3 end`,
          desc(products.hasPhoto),
        ];
  const base = storefrontBaseOrder(catalog, featuredIds);
  const named = catalog.sort === 'name' || (catalog.sort === undefined && words.length > 0);
  const ranked = named ? [...relevance, asc(products.nameKey), asc(products.ordinal)] : base;
  const orderBy = storefrontPriceOrder(catalog.sort, ranked);
  const fields = catalog.fields ?? 'full';
  const requested = catalog.pageSize ?? DEFAULT_STOREFRONT_PAGE_SIZE;
  const pageSize =
    fields === 'card'
      ? requested
      : Math.min(requested, catalog.variantIds === undefined ? PRODUCT_DETAIL_PAGE_LIMIT : CART_PAGE_LIMIT);
  const page = catalog.page ?? 1;
  const variantIds = catalog.variantIds === undefined ? undefined : new Set(catalog.variantIds);
  const result = yield* productPage(db, scope, {
    catalogHead: true,
    filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    orderBy,
    variantPreview: fields === 'card',
    variants: fields === 'full',
    variantSummary: true,
  });
  if (result.head === null) {
    return yield* new MerchandiseStoreFailure({ reason: 'The storefront catalog is not initialized' });
  }
  if (inclusion !== undefined && inclusion.revision !== result.head.revision) {
    return yield* new MerchandiseStoreFailure({ reason: 'The catalog changed during the search read' });
  }
  const matches = yield* currentSearchMatches(db, scope, result.products, needle, pricing);
  yield* verifySearchRevision(db, scope, result.head, needle, result.products.length);
  return {
    head: result.head,
    page,
    pageSize,
    products: result.products.map((record) => {
      const product = toStorefrontProduct(
        variantIds === undefined || record.variantRecords === undefined
          ? record
          : { ...record, variantRecords: record.variantRecords.filter((variant) => variantIds.has(variant.id)) },
        fields,
      );
      const converted = Option.match(pricing, {
        onNone: () => product,
        onSome: (market) => productInMarketCurrency(product, market),
      });
      const match = matches.get(record.id);
      // The singleton was converted separately from its canonical source exactly once; attach AFTER product conversion.
      return match === undefined ? converted : { ...converted, searchMatch: match };
    }),
    total: result.total,
  };
});

// ------------------------------------------------------------------------------------------------ categories

// ------------------------------------------------------------------------------------------------ category search

/** Ancestors joined per category; the trail stops there (as the editor's own trail walk does). */
const TRAIL_DEPTH = 12;
/** Candidates PostgreSQL pre-ranks for one search; the server ranks them and returns the best `limit`. */
const CATEGORY_CANDIDATE_LIMIT = 200;
const ancestors = Array.from({ length: TRAIL_DEPTH }, (_, index) =>
  alias(categories, `category_ancestor_${index + 1}`),
);
/** Root-first path label built in PostgreSQL, so a search never ships the whole tree to the Worker. */
const trailExpression = sql<string>`concat_ws(' › ', ${sql.join(
  ancestors.toReversed().map((ancestor) => ancestor.name),
  sql`, `,
)}, ${categories.name})`;
// Lower case without diacritics, as `foldCategoryText` folds the query (PostgreSQL here has no unaccent).
const FOLD_FROM = 'áäčďéěëíĺľňóôöŕřšťúůüýžàâçèêîïùûÿåãõñ';
const FOLD_TO = 'aacdeeeillnooorrstuuuyzaaceeiiuuyaaon';
const folded = (value: SQL | AnyPgColumn) => sql<string>`translate(lower(${value}), ${FOLD_FROM}, ${FOLD_TO})`;

const depthExpression = sql<number>`${sql.join(
  ancestors.map((ancestor) => sql`(${ancestor.id} is not null)::int`),
  sql` + `,
)} + 1`;

/** Categories of the company matching `condition`, each with its path label, depth and the match count. */
const withAncestors = (db: MerchandiseDb, scope: StoreScope, condition?: SQL) => {
  let statement = db
    .select({
      depth: depthExpression,
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      total: sql<number>`(count(*) over ())::int`,
      trail: trailExpression,
    })
    .from(categories)
    .$dynamic();
  let child: {
    readonly id: AnyPgColumn;
    readonly legalEntityId: AnyPgColumn;
    readonly parentId: AnyPgColumn;
    readonly tenantId: AnyPgColumn;
  } = categories;
  for (const ancestor of ancestors) {
    statement = statement.leftJoin(
      ancestor,
      and(
        eq(ancestor.tenantId, child.tenantId),
        eq(ancestor.legalEntityId, child.legalEntityId),
        eq(ancestor.id, child.parentId),
      ),
    );
    child = ancestor;
  }
  return statement.where(and(whereScope(categories, scope), condition));
};

/**
 * Tree categories whose path or slug carries every word of `text` (case- and diacritics-insensitive), best first,
 * at most `limit`; blank text lists the top-level categories. PostgreSQL filters and pre-ranks (own name carries the
 * last word, then shallower paths), the Worker ranks those candidates like the editor's picker did.
 */
export const searchCategoryTrails = Effect.fn('MerchandiseQueries.searchCategoryTrails')(function* searchCategoryTrails(
  db: MerchandiseDb,
  scope: StoreScope,
  input: { readonly limit?: number | undefined; readonly text: string },
) {
  const limit = input.limit ?? CATEGORY_RESULT_LIMIT;
  const words = categoryQueryWords(input.text);
  if (words.length === 0) {
    const roots = yield* query(
      withAncestors(db, scope, sql`${categories.parentId} is null`)
        .orderBy(asc(categories.position), asc(categories.ordinal))
        .limit(limit),
      'Categories could not be searched',
    );
    return {
      matches: roots.map(({ id, trail }): CategoryTrail => ({ id: CatalogCategoryIdSchema.make(id), trail })),
      total: roots[0]?.total ?? 0,
    };
  }
  const haystack = folded(sql`${trailExpression} || ' ' || ${categories.slug}`);
  const lastWord = words.at(-1) ?? '';
  const rows = yield* query(
    withAncestors(db, scope, and(...words.map((word) => like(haystack, `%${likeEscape(word)}%`))))
      .orderBy(
        desc(sql`position(${lastWord} in ${folded(categories.name)}) > 0`),
        asc(depthExpression),
        asc(trailExpression),
      )
      .limit(CATEGORY_CANDIDATE_LIMIT),
    'Categories could not be searched',
  );
  const ranked = rankCategories(rows, input.text).slice(0, limit);
  return {
    matches: ranked.map(({ id, trail }): CategoryTrail => ({ id: CatalogCategoryIdSchema.make(id), trail })),
    total: rows[0]?.total ?? 0,
  };
});

/** Path labels of these tree categories (unknown ids are left out). */
export const categoryTrailsOf = Effect.fn('MerchandiseQueries.categoryTrailsOf')(function* categoryTrailsOf(
  db: MerchandiseDb,
  scope: StoreScope,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return noCategoryTrails;
  }
  const rows = yield* query(
    withAncestors(db, scope, inArray(categories.id, unique)),
    'Category paths could not be read',
  );
  return rows.map(({ id, trail }): CategoryTrail => ({ id: CatalogCategoryIdSchema.make(id), trail }));
});

/** Whether the company has a storefront category tree. */
export const hasCategoryTree = (db: MerchandiseDb, scope: StoreScope) =>
  query(
    db.select({ id: categories.id }).from(categories).where(whereScope(categories, scope)).limit(1),
    'Categories could not be read',
  ).pipe(Effect.map((rows) => rows.length > 0));

/**
 * The category tree in one query (navigation fields only). `detail` names categories that also carry their
 * content (storefront: roots, the active category and its children; staff: the selected one with its history).
 * The storefront tree hides every category below an unpublished one.
 */
interface CategoryDisplayLabels {
  heading?: string;
  imageAlt?: string;
}

const categoryDisplayLabels = (row: { readonly heading: string | null; readonly imageAlt: string | null }) => {
  const labels: CategoryDisplayLabels = {};
  if (row.heading !== null) {
    labels.heading = normalizeCategoryName(row.heading);
  }
  if (row.imageAlt !== null) {
    labels.imageAlt = normalizeCategoryName(row.imageAlt);
  }
  return labels;
};

interface CategoryTreeContent {
  description?: string;
  history?: typeof categories.$inferSelect.history;
  imageSrc?: string;
  longDescription?: string;
  published?: boolean;
}

export const categoryTree = Effect.fn('MerchandiseQueries.categoryTree')(function* categoryTree(
  db: MerchandiseDb,
  scope: StoreScope,
  input: {
    readonly activeId?: string | undefined;
    readonly activeSlug?: string | undefined;
    readonly contentOnly?: boolean;
    readonly storefront: boolean;
  },
) {
  const activeId =
    input.activeId ?? (input.activeSlug === undefined ? undefined : categoryIdBySlug(db, scope, input.activeSlug));
  const active = activeId === undefined ? sql`false` : eq(categories.id, activeId);
  // Storefront tiles and the sidebar show images of roots and of the active category's children.
  const shown = input.storefront
    ? or(
        sql`${categories.parentId} is null`,
        active,
        activeId === undefined ? sql`false` : eq(categories.parentId, activeId),
      )
    : active;
  // A content read needs only the active branch and its ancestors for the publication check below.
  // UNION terminates even a cyclic stored path; every recursive step stays in this company scope.
  const contentBranch =
    input.contentOnly === true
      ? inArray(
          categories.id,
          sql`(with recursive content_branch(id, parent_id) as (
            select ${categories.id}, ${categories.parentId} from ${categories}
            where ${and(
              whereScope(categories, scope),
              or(active, activeId === undefined ? sql`false` : eq(categories.parentId, activeId)),
            )}
            union
            select parent.id, parent.parent_id from ${categories} parent
            inner join content_branch child on parent.id = child.parent_id
            where parent.tenant_id = ${scope.tenantId}::uuid
              and parent.legal_entity_id = ${scope.legalEntityId}::uuid
          ) select id from content_branch)`,
        )
      : undefined;
  const rows = yield* query(
    db
      .select({
        description: sql<string | null>`case when ${shown} then ${categories.description} end`,
        hasChildren: categories.hasChildren,
        heading: sql<string | null>`case when ${active} then ${categories.heading} end`,
        history: input.storefront
          ? sql<unknown>`null`
          : sql<unknown>`case when ${active} then ${categories.history} end`,
        id: categories.id,
        imageAlt: sql<string | null>`case when ${shown} then ${categories.imageAlt} end`,
        imageSrc: sql<string | null>`case when ${shown} then ${categories.imageSrc} end`,
        longDescription: sql<string | null>`case when ${active} then ${categories.longDescription} end`,
        name: categories.name,
        parentId: categories.parentId,
        position: categories.position,
        published: categories.published,
        slug: categories.slug,
      })
      .from(categories)
      .where(and(whereScope(categories, scope), contentBranch))
      .orderBy(asc(categories.ordinal)),
    'Categories could not be read',
  );
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const contentId = input.activeId ?? rows.find((row) => row.slug === input.activeSlug)?.id;
  const visible = (id: string) => {
    const seen = new Set<string>();
    let current = byId.get(id);
    while (current !== undefined && !seen.has(current.id)) {
      if (current.published === false) {
        return false;
      }
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return true;
  };
  const selectedRows = rows.filter(
    (row) =>
      (!input.storefront || visible(row.id)) &&
      (input.contentOnly !== true || row.id === contentId || row.parentId === contentId),
  );
  return yield* Effect.forEach(
    selectedRows,
    (row) => {
      const document = {
        hasChildren: row.hasChildren,
        id: row.id,
        name: normalizeCategoryName(row.name),
        parentId: row.parentId,
        position: row.position,
        slug: row.slug,
        ...categoryDisplayLabels(row),
      };
      const content: CategoryTreeContent = {};
      if (row.published !== null) {
        content.published = row.published;
      }
      if (row.description !== null) {
        content.description = row.description;
      }
      if (row.longDescription !== null) {
        content.longDescription = row.longDescription;
      }
      if (row.imageSrc !== null) {
        content.imageSrc = row.imageSrc;
      }
      if (row.history !== null && row.history !== undefined) {
        content.history = row.history;
      }
      return Schema.decodeUnknownEffect(CategoryNodeSchema)({ ...document, ...content }).pipe(
        Effect.mapError(storedRowsFailure),
      );
    },
    { concurrency: 1 },
  );
});

// ------------------------------------------------------------------------------------------------ orders, movements

/**
 * Every search word occurs in the order's own text (number, guest contact), or the order belongs to a customer
 * whose register name the caller matched (`orderCustomerPartyIds`): staff orders name a party, not a contact.
 */
const orderSearchFilter = (view: RecordsView): SQL | undefined => {
  const words = wordsOf(view.orderSearch);
  if (words.length === 0) {
    return undefined;
  }
  const ownText = and(...containsAll(orders.searchText, words));
  const partyIds = view.orderCustomerPartyIds ?? [];
  return partyIds.length === 0 ? ownText : or(ownText, inArray(orders.partyId, [...partyIds]));
};

export const orderPage = Effect.fn('MerchandiseQueries.orderPage')(function* orderPage(
  db: MerchandiseDb,
  scope: StoreScope,
  view: RecordsView,
) {
  const where = and(
    whereScope(orders, scope),
    eq(orders.removed, false),
    view.orderStatus === undefined ? undefined : eq(orders.status, view.orderStatus),
    view.orderId === undefined ? undefined : eq(orders.id, view.orderId),
    view.orderIds === undefined ? undefined : idsFilter(orders.id, view.orderIds),
    view.orderOpportunityId === undefined ? undefined : eq(orders.opportunityId, view.orderOpportunityId),
    view.taggedOrderIds === undefined ? undefined : idsFilter(orders.id, view.taggedOrderIds),
    orderSearchFilter(view),
  );
  const limit = view.ordersLimit ?? DEFAULT_ORDER_LIMIT;
  const [counted] = yield* query(
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(orders)
      .where(where),
  );
  const total = counted?.total ?? 0;
  if (limit === 0 || total === 0) {
    return { orders: noOrders, total };
  }
  const rows = yield* query(
    db
      .select({ document: orders.document })
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.ordinal))
      .limit(limit)
      .offset(view.ordersOffset ?? 0),
    'Orders could not be read',
  );
  const decoded = yield* Effect.forEach(rows, (row) => decodeOrderDocument(row.document), {
    concurrency: 1,
  }).pipe(Effect.mapError(storedRowsFailure));
  return { orders: decoded, total };
});

/** Guest orders of one storefront submission (replay lookup); never removed ones. */
export const ordersByClientRequest = Effect.fn('MerchandiseQueries.ordersByClientRequest')(
  function* ordersByClientRequest(db: MerchandiseDb, scope: StoreScope, clientRequestId: string) {
    const rows = yield* query(
      db
        .select({ document: orders.document })
        .from(orders)
        .where(and(whereScope(orders, scope), eq(orders.clientRequestId, clientRequestId), eq(orders.removed, false)))
        .limit(5),
    );
    return yield* Effect.forEach(rows, (row) => decodeOrderDocument(row.document), {
      concurrency: 1,
    }).pipe(Effect.mapError(storedRowsFailure));
  },
);

/** Customer-safe status of one storefront order; null unless id AND clientRequestId match a visible order. */
export const storefrontOrderStatus = Effect.fn('MerchandiseQueries.storefrontOrderStatus')(
  function* storefrontOrderStatus(
    db: MerchandiseDb,
    scope: StoreScope,
    lookup: { readonly clientRequestId: string; readonly orderId: string },
  ) {
    const rows = yield* query(
      db
        .select({ document: orders.document })
        .from(orders)
        .where(
          and(
            whereScope(orders, scope),
            eq(orders.id, lookup.orderId),
            eq(orders.clientRequestId, lookup.clientRequestId),
            eq(orders.channel, 'STOREFRONT'),
            eq(orders.removed, false),
          ),
        )
        .limit(1),
    );
    const [row] = rows;
    if (row === undefined) {
      return null;
    }
    const order = yield* decodeOrderDocument(row.document).pipe(Effect.mapError(storedRowsFailure));
    return storefrontStatusOf(order) satisfies StorefrontOrderStatus;
  },
);

/** Account reads are scoped in SQL before decoding: never materialize another customer's order. */
export const storefrontCustomerOrders = Effect.fn('MerchandiseQueries.storefrontCustomerOrders')(
  function* storefrontCustomerOrders(
    db: MerchandiseDb,
    scope: StoreScope,
    lookup: { readonly customerAccountId: string; readonly offset?: number; readonly orderId?: string },
  ) {
    const predicate = and(
      whereScope(orders, scope),
      eq(orders.channel, 'STOREFRONT'),
      eq(orders.removed, false),
      sql`${orders.document}->>'customerAccountId' = ${lookup.customerAccountId}`,
      ...(lookup.orderId === undefined ? [] : [eq(orders.id, lookup.orderId)]),
    );
    const [rows, counts] = yield* Effect.all(
      [
        query(
          db
            .select({ document: orders.document })
            .from(orders)
            .where(predicate)
            .orderBy(desc(orders.createdAt), desc(orders.id))
            .limit(50)
            .offset(lookup.offset ?? 0),
        ),
        query(
          db
            .select({ total: sql<number>`count(*)::int` })
            .from(orders)
            .where(predicate),
        ),
      ],
      { concurrency: 1 },
    );
    const result = yield* Effect.forEach(rows, (row) => decodeOrderDocument(row.document), {
      concurrency: 1,
    }).pipe(Effect.mapError(storedRowsFailure));
    return { orders: result, total: counts[0]?.total ?? 0 };
  },
);

/** One product's ledger: the newest 500 movements, oldest first. */
export const productMovements = Effect.fn('MerchandiseQueries.productMovements')(function* productMovements(
  db: MerchandiseDb,
  scope: StoreScope,
  productId: string,
): Effect.fn.Return<readonly StockMovement[], MerchandiseStoreFailure> {
  const rows = yield* query(
    db
      .select()
      .from(stockMovements)
      .where(and(whereScope(stockMovements, scope), eq(stockMovements.productId, productId)))
      .orderBy(desc(stockMovements.ordinal))
      .limit(MOVEMENT_LIMIT),
  );
  return yield* Effect.forEach(rows.toReversed(), decodeMovementRow, { concurrency: 1 }).pipe(
    Effect.mapError(storedRowsFailure),
  );
});

/** Company-wide indicators in two aggregate queries; open order value counts CZK orders only (no currency mix). The bigint sums arrive as strings and are mapped to numbers. */
export const indicators = Effect.fn('MerchandiseQueries.indicators')(function* indicators(
  db: MerchandiseDb,
  scope: StoreScope,
) {
  const [[catalog], [sales]] = yield* Effect.all(
    [
      query(
        db
          .select({
            lowStockCount: sql<number>`count(*) filter (where ${products.lowStock})::int`,
            productCount: sql<number>`count(*)::int`,
            stockValueMinor: sql`coalesce(sum(${products.stockValueMinor}), 0)::bigint`.mapWith(Number),
          })
          .from(products)
          .where(and(whereScope(products, scope), eq(products.archived, false))),
      ),
      query(
        db
          .select({
            openOrderValueMinor:
              sql`coalesce(sum(${orders.totalMinor}) filter (where ${inArray(orders.status, [...OPEN_ORDER_STATUSES])}
                and coalesce(${orders.document}->'market'->>'currency', 'CZK') = 'CZK'), 0)::bigint`.mapWith(Number),
            orderCount: sql<number>`count(*)::int`,
          })
          .from(orders)
          .where(and(whereScope(orders, scope), eq(orders.removed, false))),
      ),
    ],
    { concurrency: 1 },
  );
  return {
    lowStockCount: catalog?.lowStockCount ?? 0,
    openOrderValueMinor: sales?.openOrderValueMinor ?? 0,
    orderCount: sales?.orderCount ?? 0,
    productCount: catalog?.productCount ?? 0,
    stockValueMinor: catalog?.stockValueMinor ?? 0,
  };
});
