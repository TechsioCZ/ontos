// Bounded reads over the normalized merchandise tables. Every list is paged and filtered in PostgreSQL; the
// largest unit a read ever materializes is one page of products (with variants only for detail reads).
import { and, asc, desc, eq, inArray, like, mapColumnsInSQLToAlias, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import type {
  CategoryTrail,
  RecordsView,
  StorefrontCatalogQuery,
  StorefrontOrderStatus,
} from '../../shared/apis/records.ts';
import { CATEGORY_RESULT_LIMIT, categoryQueryWords, rankCategories } from '../../shared/domain/category-search.ts';
import { CatalogChangeSchema } from '../../shared/domain/merchandise-model.ts';
import type {
  CategoryNode,
  Order,
  OrderStatus,
  ProductRecord,
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
  MerchandiseStoreFailure,
  query,
  whereScope,
} from './merchandise-store.ts';
import type { MerchandiseDb, StoreScope } from './merchandise-store.ts';
import { toProductRecord } from './stock-levels.ts';
import {
  DEFAULT_STOREFRONT_PAGE_SIZE,
  normalizeSearchText,
  storefrontStatusOf,
  toStorefrontProduct,
} from './storefront-catalog.ts';

export const DEFAULT_PRODUCT_LIMIT = 50;
/** Products per page that carry their variants (one AKROS product can hold ~400 variants, ~400 kB). */
export const DETAIL_PAGE_LIMIT = 2;
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

type VariantSummary = NonNullable<ProductRecord['variantSummary']>;

/**
 * Active sellable variants of the row's product in aggregate, computed inside the page query (no N+1). The scope
 * is bound as parameters: an unqualified outer column would resolve to the variant row itself.
 */
const variantSummarySql = (scope: StoreScope) => sql<VariantSummary>`(select json_build_object(
    'count', count(*)::int,
    'minGrossPriceMinor', min(v.gross_price_minor),
    'stockOnHand', coalesce(sum(v.stock_on_hand), 0),
    'units', coalesce(array_agg(distinct v.unit order by v.unit), '{}'::text[]))
  from ${productVariants} v
  where v.tenant_id = ${scope.tenantId}::uuid and v.legal_entity_id = ${scope.legalEntityId}::uuid
    and v.product_id = ${outerProductId} and v.variant_id is not null and v.price_minor is not null
    and v.active)`;

interface StorefrontHead {
  readonly homepageFeaturedProductIds: readonly string[];
  readonly revision: number;
}

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
          ? sql<StorefrontHead | null>`(select json_build_object(
            'revision', ${catalogHeads.revision}, 'homepageFeaturedProductIds', ${catalogHeads.homepageFeaturedProductIds})
          from ${catalogHeads} where ${whereScope(catalogHeads, scope)})`.as('head')
          : sql<StorefrontHead | null>`null::json`.as('head'),
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
          : sql<VariantSummary | null>`null::json`.as('variant_summary'),
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
  const records = yield* Effect.try({
    catch: (cause) => new MerchandiseStoreFailure({ cause, reason: 'Stored rows do not decode' }),
    try: () =>
      hydrateProducts(rows, variantRows, tierRows).map(({ product, stock }, index): ProductRecord => {
        const row = rows[index]!;
        const summary = {
          ...(row.variantSummary === null ? {} : { variantSummary: row.variantSummary }),
          ...(row.variantCount === null ? {} : { variantCount: row.variantCount }),
        };
        if (input.variants) return { ...toProductRecord(product, stock), ...summary };
        const { variants: _variants, ...rest } = product;
        void _variants;
        return {
          ...rest,
          availability: row.availability as NonNullable<ProductRecord['availability']>,
          ...(row.grossPriceMinor === null ? {} : { grossPriceMinor: row.grossPriceMinor }),
          lowStock: row.lowStock,
          stockOnHand: row.stockOnHand,
          stockValueMinor: row.stockValueMinor,
          ...summary,
        };
      }),
  });
  return { head: result[0]?.head ?? null, products: records, total } satisfies ProductPage;
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

const staffProductOrder = (sort: RecordsView['productSort']): SQL[] => {
  switch (sort) {
    case 'name': {
      return [asc(products.nameKey), asc(products.ordinal)];
    }
    case 'sku': {
      return [asc(products.skuKey)];
    }
    case 'price-asc': {
      return [sql`${products.grossPriceMinor} asc nulls last`, asc(products.ordinal)];
    }
    case 'price-desc': {
      return [sql`${products.grossPriceMinor} desc nulls last`, asc(products.ordinal)];
    }
    case 'stock-asc': {
      return [asc(products.stockOnHand), asc(products.ordinal)];
    }
    case 'stock-desc': {
      return [desc(products.stockOnHand), asc(products.ordinal)];
    }
    case 'updated-desc': {
      return [desc(products.updatedAt), asc(products.ordinal)];
    }
    case undefined: {
      return [asc(products.ordinal)];
    }
  }
};

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
        : Math.min(view.limit ?? DETAIL_PAGE_LIMIT, input.detailLimit ?? DETAIL_PAGE_LIMIT),
    offset: view.offset ?? 0,
    orderBy: staffProductOrder(view.productSort),
    variantCount: view.summary === true,
    variantSummary: view.summary === true,
    variants: view.summary !== true,
  }).pipe(
    Effect.map((page) => ({
      ...page,
      products: page.products.map((record): ProductRecord => {
        if (view.summary === true) {
          const { contentHistory: _history, ...summary } = record;
          void _history;
          return { ...summary, priceHistory: [] };
        }
        if (!storefront) return record;
        const { variants: _raw, contentHistory: _content, ...publicProduct } = record;
        void _raw;
        void _content;
        return {
          ...publicProduct,
          priceHistory: [],
          ...(record.variantRecords === undefined
            ? {}
            : { variantRecords: record.variantRecords.map((variant) => ({ ...variant, priceHistory: [] })) }),
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

/** Category id of a storefront slug, or undefined. */
const categoryIdBySlug = (db: MerchandiseDb, scope: StoreScope, slug: string) =>
  query(
    db
      .select({ id: categories.id })
      .from(categories)
      .where(and(whereScope(categories, scope), eq(categories.slug, slug)))
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]?.id));

const labelFilter = (label: NonNullable<StorefrontCatalogQuery['label']>) =>
  label === 'action'
    ? eq(products.isAction, true)
    : label === 'recommended'
      ? eq(products.isRecommended, true)
      : label === 'sale'
        ? eq(products.isSale, true)
        : eq(products.isNew, true);

const IN_STOCK = ['IN_STOCK', 'LOW_STOCK'];

/**
 * Storefront catalog page: visible products (active, published, not archived), filters AND-ed, relevance or price
 * order, one page. Listing cards (`fields: 'card'`) never load variants; every product carries `variantSummary`.
 */
export const storefrontProducts = Effect.fn('MerchandiseQueries.storefrontProducts')(function* storefrontProducts(
  db: MerchandiseDb,
  scope: StoreScope,
  input: { readonly query: StorefrontCatalogQuery },
) {
  const catalog = input.query;
  const featuredIds = sql`((select h.homepage_featured_product_ids from ${catalogHeads} h
    where h.tenant_id = ${scope.tenantId}::uuid and h.legal_entity_id = ${scope.legalEntityId}::uuid))::text[]`;
  const categoryId =
    catalog.categorySlug === undefined ? undefined : yield* categoryIdBySlug(db, scope, catalog.categorySlug);
  const words = wordsOf(catalog.q);
  const needle = normalizeSearchText(catalog.q ?? '');
  const filters: (SQL | undefined)[] = [
    eq(products.archived, false),
    eq(products.active, true),
    eq(products.published, true),
    catalog.featured === true
      ? or(sql`${products.id} = any(${featuredIds})`, eq(products.isRecommended, true))
      : undefined,
    catalog.productIds === undefined ? undefined : idsFilter(products.id, catalog.productIds),
    catalog.slug === undefined ? undefined : eq(products.slug, catalog.slug),
    catalog.categorySlug === undefined
      ? undefined
      : categoryId === undefined
        ? sql`false`
        : or(eq(products.categoryId, categoryId), sql`${products.categoryPathIds} @> ${textArray([categoryId])}`),
    catalog.label === undefined ? undefined : labelFilter(catalog.label),
    ...containsAll(products.searchText, words),
    catalog.minMinor === undefined ? undefined : sql`coalesce(${products.grossPriceMinor}, 0) >= ${catalog.minMinor}`,
    catalog.maxMinor === undefined ? undefined : sql`coalesce(${products.grossPriceMinor}, 0) <= ${catalog.maxMinor}`,
    catalog.availability === 'in-stock' ? inArray(products.availability, IN_STOCK) : undefined,
    catalog.availability === 'out-of-stock'
      ? sql`${products.availability} not in ('IN_STOCK', 'LOW_STOCK')`
      : undefined,
  ];
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
  const base: SQL[] =
    catalog.productIds !== undefined
      ? [sql`array_position(${textArray(catalog.productIds)}, ${products.id})`]
      : catalog.featured === true
        ? [sql`array_position(${featuredIds}, ${products.id}) asc nulls last`, asc(products.ordinal)]
        : [asc(products.ordinal)];
  const named = catalog.sort === 'name' || (catalog.sort === undefined && words.length > 0);
  const ranked = named ? [...relevance, asc(products.nameKey), asc(products.ordinal)] : base;
  const orderBy =
    catalog.sort === 'price-asc'
      ? [sql`${products.grossPriceMinor} asc nulls last`, ...ranked]
      : catalog.sort === 'price-desc'
        ? [sql`${products.grossPriceMinor} desc nulls last`, ...ranked]
        : ranked;
  const fields = catalog.fields ?? 'full';
  const requested = catalog.pageSize ?? DEFAULT_STOREFRONT_PAGE_SIZE;
  const pageSize =
    fields === 'card'
      ? requested
      : Math.min(requested, catalog.variantIds === undefined ? DETAIL_PAGE_LIMIT : CART_PAGE_LIMIT);
  const page = catalog.page ?? 1;
  const variantIds = catalog.variantIds === undefined ? undefined : new Set(catalog.variantIds);
  const result = yield* productPage(db, scope, {
    catalogHead: true,
    filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    orderBy,
    variants: fields === 'full',
    variantSummary: true,
  });
  if (result.head === null) {
    return yield* new MerchandiseStoreFailure({ reason: 'The storefront catalog is not initialized' });
  }
  return {
    head: result.head,
    page,
    pageSize,
    products: result.products.map((record) =>
      toStorefrontProduct(
        variantIds === undefined || record.variantRecords === undefined
          ? record
          : { ...record, variantRecords: record.variantRecords.filter((variant) => variantIds.has(variant.id)) },
        fields,
      ),
    ),
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
  [...ancestors].reverse().map((ancestor) => ancestor.name),
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
    return { matches: roots.map(({ id, trail }): CategoryTrail => ({ id, trail })), total: roots[0]?.total ?? 0 };
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
  return { matches: ranked.map(({ id, trail }): CategoryTrail => ({ id, trail })), total: rows[0]?.total ?? 0 };
});

/** Path labels of these tree categories (unknown ids are left out). */
export const categoryTrailsOf = Effect.fn('MerchandiseQueries.categoryTrailsOf')(function* categoryTrailsOf(
  db: MerchandiseDb,
  scope: StoreScope,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [] as readonly CategoryTrail[];
  }
  const rows = yield* query(
    withAncestors(db, scope, inArray(categories.id, unique)),
    'Category paths could not be read',
  );
  return rows.map(({ id, trail }): CategoryTrail => ({ id, trail }));
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
export const categoryTree = Effect.fn('MerchandiseQueries.categoryTree')(function* categoryTree(
  db: MerchandiseDb,
  scope: StoreScope,
  input: {
    readonly activeId?: string | undefined;
    readonly activeSlug?: string | undefined;
    readonly storefront: boolean;
  },
) {
  const activeId =
    input.activeId ??
    (input.activeSlug === undefined ? undefined : yield* categoryIdBySlug(db, scope, input.activeSlug));
  const active = activeId === undefined ? sql`false` : eq(categories.id, activeId);
  // Storefront tiles and the sidebar show images of roots and of the active category's children.
  const shown = input.storefront
    ? or(
        sql`${categories.parentId} is null`,
        active,
        activeId === undefined ? sql`false` : eq(categories.parentId, activeId),
      )
    : active;
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
      .where(whereScope(categories, scope))
      .orderBy(asc(categories.ordinal)),
    'Categories could not be read',
  );
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const visible = (id: string) => {
    const seen = new Set<string>();
    let current = byId.get(id);
    while (current !== undefined && !seen.has(current.id)) {
      if (current.published === false) return false;
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return true;
  };
  return yield* Effect.try({
    catch: (cause) => new MerchandiseStoreFailure({ cause, reason: 'Stored rows do not decode' }),
    try: () =>
      rows
        .filter((row) => !input.storefront || visible(row.id))
        .map((row): CategoryNode => ({
          hasChildren: row.hasChildren,
          id: row.id,
          name: row.name,
          parentId: row.parentId,
          position: row.position,
          slug: row.slug,
          ...(row.published === null ? {} : { published: row.published }),
          ...(row.heading === null ? {} : { heading: row.heading }),
          ...(row.description === null ? {} : { description: row.description }),
          ...(row.longDescription === null ? {} : { longDescription: row.longDescription }),
          ...(row.imageSrc === null ? {} : { imageSrc: row.imageSrc }),
          ...(row.imageAlt === null ? {} : { imageAlt: row.imageAlt }),
          ...(row.history === null || row.history === undefined ? {} : { history: decodeHistory(row.history) }),
        })),
  });
});

const decodeHistory = Schema.decodeUnknownSync(Schema.Array(CatalogChangeSchema));

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
  if (limit === 0 || total === 0) return { orders: [] as readonly Order[], total };
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
  const decoded = yield* Effect.try({
    catch: (cause) => new MerchandiseStoreFailure({ cause, reason: 'Stored rows do not decode' }),
    try: () => rows.map((row) => decodeOrderDocument(row.document)),
  });
  return { orders: decoded as readonly Order[], total };
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
    return yield* Effect.try({
      catch: (cause) => new MerchandiseStoreFailure({ cause, reason: 'Stored rows do not decode' }),
      try: () => rows.map((row) => decodeOrderDocument(row.document)),
    });
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
    if (row === undefined) return null;
    const order = yield* Effect.try({
      catch: (cause) => new MerchandiseStoreFailure({ cause, reason: 'Stored rows do not decode' }),
      try: () => decodeOrderDocument(row.document),
    });
    return storefrontStatusOf(order) satisfies StorefrontOrderStatus;
  },
);

/** One product's ledger: the newest 500 movements, oldest first. */
export const productMovements = Effect.fn('MerchandiseQueries.productMovements')(function* productMovements(
  db: MerchandiseDb,
  scope: StoreScope,
  productId: string,
) {
  const rows = yield* query(
    db
      .select()
      .from(stockMovements)
      .where(and(whereScope(stockMovements, scope), eq(stockMovements.productId, productId)))
      .orderBy(desc(stockMovements.ordinal))
      .limit(MOVEMENT_LIMIT),
  );
  return yield* Effect.try({
    catch: (cause) => new MerchandiseStoreFailure({ cause, reason: 'Stored rows do not decode' }),
    try: (): readonly StockMovement[] => rows.toReversed().map(decodeMovementRow),
  });
});

/** Company-wide indicators in two aggregate queries. */
export const indicators = Effect.fn('MerchandiseQueries.indicators')(function* indicators(
  db: MerchandiseDb,
  scope: StoreScope,
) {
  const [catalog] = yield* query(
    db
      .select({
        lowStockCount: sql<number>`count(*) filter (where ${products.lowStock})::int`,
        productCount: sql<number>`count(*)::int`,
        stockValueMinor: sql<number>`coalesce(sum(${products.stockValueMinor}), 0)::bigint`,
      })
      .from(products)
      .where(and(whereScope(products, scope), eq(products.archived, false))),
  );
  const [sales] = yield* query(
    db
      .select({
        openOrderValueMinor: sql<number>`coalesce(sum(${orders.totalMinor}) filter (where ${inArray(orders.status, [...OPEN_ORDER_STATUSES])}), 0)::bigint`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(and(whereScope(orders, scope), eq(orders.removed, false))),
  );
  return {
    lowStockCount: catalog?.lowStockCount ?? 0,
    openOrderValueMinor: Number(sales?.openOrderValueMinor ?? 0),
    orderCount: sales?.orderCount ?? 0,
    productCount: catalog?.productCount ?? 0,
    stockValueMinor: Number(catalog?.stockValueMinor ?? 0),
  };
});
