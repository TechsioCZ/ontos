import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, count, eq, exists, ilike, inArray, isNull } from 'drizzle-orm';
import { Effect } from 'effect';

import type { ProductPageRequest } from '../../shared/apis/product-page.ts';
import {
  commercialSkuReservations,
  productCategoryAssignments,
  productLocalizedFacts,
  products,
} from '../database/schema.ts';
import { catalogMediaReadsForScope } from './catalog-media-reads.ts';
import type { CatalogMediaReads } from './catalog-media-reads.ts';
import { catalogPersistenceForScope } from './catalog-persistence.ts';
import type { CatalogPersistence } from './catalog-persistence.ts';
import { containsPattern } from './catalog-source-correlation.ts';
import { categoryClassificationPersistenceForScope } from './category-classification-persistence.ts';
import type { CategoryClassificationPersistence } from './category-classification-persistence.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { localizedFactsReadsForScope } from './localized-facts-reads.ts';
import type { LocalizedFactsReads } from './localized-facts-reads.ts';
import { variantAxisPersistenceForScope } from './variant-axis-persistence.ts';
import type { VariantAxisPersistence } from './variant-axis-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<void>>[0];

const unavailable = (cause?: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'The Catalog product page is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** The page itself: which Products match, how many, and the Current SKU of their Variants. */
export interface ProductPageReads {
  readonly count: (input: ProductPageRequest) => Effect.Effect<number, CatalogPersistenceUnavailable>;
  /** The Current SKU display code of each Variant that has one, by Variant id. */
  readonly currentSkus: (
    variantIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, CatalogPersistenceUnavailable>;
  readonly productIds: (input: ProductPageRequest) => Effect.Effect<readonly string[], CatalogPersistenceUnavailable>;
}

/** The owner services the page composes for each Product it returns. */
export interface ProductPageServices {
  readonly axes: VariantAxisPersistence;
  readonly catalog: Pick<CatalogPersistence, 'getCurrent'>;
  readonly categories: CategoryClassificationPersistence;
  readonly localized: Pick<LocalizedFactsReads, 'currentProduct' | 'currentVariant'>;
  readonly media: CatalogMediaReads;
  readonly page: ProductPageReads;
}

const onlyTotal = (rows: readonly { readonly total: number }[]) =>
  rows.length === 1 && rows[0] !== undefined ? Effect.succeed(rows[0].total) : Effect.fail(unavailable());

/** The Product's own text row in the requested locale; the primary key makes it at most one. */
const nameInLocale = (locale: string) =>
  and(
    eq(productLocalizedFacts.tenantId, products.tenantId),
    eq(productLocalizedFacts.productId, products.productId),
    eq(productLocalizedFacts.locale, locale),
  );

const productPageForTransaction = (transaction: ScopedTransaction, tenantId: string): ProductPageReads => {
  const directlyIn = (categoryId: string) =>
    exists(
      transaction
        .select({ categoryId: productCategoryAssignments.categoryId })
        .from(productCategoryAssignments)
        .where(
          and(
            eq(productCategoryAssignments.tenantId, products.tenantId),
            eq(productCategoryAssignments.productId, products.productId),
            eq(productCategoryAssignments.categoryId, categoryId),
          ),
        ),
    );
  // A removed text keeps no name, so a Product without a name in the locale never matches a search.
  const matching = (input: ProductPageRequest) =>
    and(
      eq(products.tenantId, tenantId),
      inArray(products.lifecycleState, [...input.lifecycles]),
      input.search === undefined ? undefined : ilike(productLocalizedFacts.name, containsPattern(input.search)),
      input.categoryRef === undefined ? undefined : directlyIn(input.categoryRef.resourceId),
    );
  return {
    count: (input) =>
      transaction
        .select({ total: count() })
        .from(products)
        .leftJoin(productLocalizedFacts, nameInLocale(input.locale))
        .where(matching(input))
        .pipe(Effect.mapError(unavailable), Effect.flatMap(onlyTotal)),
    currentSkus: (variantIds) =>
      variantIds.length === 0
        ? Effect.succeed(new Map())
        : transaction
            .select({
              displayCode: commercialSkuReservations.displayCode,
              variantId: commercialSkuReservations.variantId,
            })
            .from(commercialSkuReservations)
            .where(
              and(
                eq(commercialSkuReservations.tenantId, tenantId),
                inArray(commercialSkuReservations.variantId, [...variantIds]),
                isNull(commercialSkuReservations.packageDefinitionId),
                eq(commercialSkuReservations.state, 'CURRENT'),
              ),
            )
            .pipe(
              Effect.mapError(unavailable),
              // The partial unique index keeps one Current Variant SKU; a second one is unverifiable.
              Effect.flatMap((rows) =>
                new Set(rows.map(({ variantId }) => variantId)).size === rows.length
                  ? Effect.succeed(new Map(rows.map(({ displayCode, variantId }) => [variantId, displayCode])))
                  : Effect.fail(unavailable()),
              ),
            ),
    productIds: (input) =>
      transaction
        .select({ productId: products.productId })
        .from(products)
        .leftJoin(productLocalizedFacts, nameInLocale(input.locale))
        .where(matching(input))
        // PostgreSQL sorts NULL last in ascending order, so Products without a name in the locale follow.
        .orderBy(asc(productLocalizedFacts.name), asc(products.productId))
        .limit(input.limit)
        .offset(input.offset)
        .pipe(
          Effect.mapError(unavailable),
          Effect.map((rows) => rows.map(({ productId }) => productId)),
        ),
  };
};

/** Private owner services inside Core's verified Tenant-scoped read transaction. */
export const productPageServicesForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ProductPageServices> =>
  Effect.all(
    [catalogPersistenceForScope(transaction, scope), categoryClassificationPersistenceForScope(transaction, scope)],
    { concurrency: 1 },
  ).pipe(
    Effect.map(([catalog, categories]) => {
      const localized = localizedFactsReadsForScope(transaction, scope);
      return {
        axes: variantAxisPersistenceForScope(transaction, scope),
        catalog,
        categories,
        localized: { currentProduct: localized.currentProduct, currentVariant: localized.currentVariant },
        media: catalogMediaReadsForScope(transaction, scope),
        page: productPageForTransaction(transaction, scope.tenantId),
      };
    }),
  );
