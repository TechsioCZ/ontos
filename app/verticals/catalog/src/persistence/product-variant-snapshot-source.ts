import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Effect, Option } from 'effect';
import { and, asc, eq, sql } from 'drizzle-orm';

import type {
  ProductVariantSnapshotRequest,
  ProductVariantSnapshotResponse,
} from '../../shared/apis/product-variant-snapshot.ts';
import { productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export interface ProductVariantSnapshotSourceValue {
  readonly capturedAt: ProductVariantSnapshotResponse['capturedAt'];
  readonly productRevision: number;
  readonly variants: readonly {
    readonly variantId: string;
    readonly variantRevision: number;
  }[];
}

export interface ProductVariantSnapshotSource {
  readonly readCurrent: (
    request: ProductVariantSnapshotRequest,
  ) => Effect.Effect<Option.Option<ProductVariantSnapshotSourceValue>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause: unknown) => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Current Product Variant targets are temporarily unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

/**
 * One SQL statement observes the Product revision and its complete ACTIVE Variant set from the
 * same PostgreSQL statement snapshot. WIP/retired Variants and later inserts are deliberately not
 * part of the issued target snapshot.
 */
export const productVariantSnapshotSourceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ProductVariantSnapshotSource => ({
  readCurrent: Effect.fn('ProductVariantSnapshotSource.readCurrent')(function* readCurrent(request) {
    const rows = yield* transaction
      .select({
        // PostgreSQL supplies the observation instant in the same statement snapshot as the
        // Product and complete ACTIVE Variant set; an application clock cannot attest that cut.
        capturedAt: sql<string>`to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        productId: products.productId,
        productRevision: products.currentRevision,
        variantId: productVariants.variantId,
        variantRevision: productVariants.currentRevision,
      })
      .from(products)
      .leftJoin(
        productVariants,
        and(
          eq(productVariants.tenantId, products.tenantId),
          eq(productVariants.productId, products.productId),
          eq(productVariants.lifecycleState, 'ACTIVE'),
        ),
      )
      .where(
        and(
          eq(products.tenantId, scope.tenantId),
          eq(products.productId, request.productRef.resourceId),
          eq(products.lifecycleState, 'ACTIVE'),
        ),
      )
      .orderBy(asc(productVariants.variantId))
      .pipe(Effect.mapError(unavailable));

    const [first] = rows;
    if (first === undefined) {
      return Option.none();
    }
    return Option.some({
      capturedAt: first.capturedAt,
      productRevision: first.productRevision,
      variants: rows.flatMap(({ variantId, variantRevision }) =>
        variantId === null || variantRevision === null ? [] : [{ variantId, variantRevision }],
      ),
    });
  }),
});
