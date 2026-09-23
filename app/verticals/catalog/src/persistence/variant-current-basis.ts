import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { variantAxisPersistenceForScope } from './variant-axis-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

/** Stable length-independent encoding of the empty axis vector. */
export const axisFreeCombinationKey = (): string => createHash('sha256').update('[]').digest('hex');

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

/** Core supplies an already tenant-scoped transaction; all reads share its snapshot. */
export const variantCurrentBasisForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  inspect: Effect.fn('VariantCurrentBasis.inspect')(function* inspect(productRef: ProductRef, variantRef: VariantRef) {
    const { tenantId } = scope;
    if (
      productRef.tenantId !== tenantId ||
      variantRef.tenantId !== tenantId ||
      productRef.moduleId !== 'commerce.catalog' ||
      variantRef.moduleId !== 'commerce.catalog' ||
      productRef.resourceType !== 'commerce.catalog.product' ||
      variantRef.resourceType !== 'commerce.catalog.variant'
    ) {
      return { reason: 'WRONG_SCOPE', status: 'INVALID' } as const;
    }
    const [product] = yield* transaction
      .select({ productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productRef.resourceId)))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return { reason: 'MISSING_PRODUCT', status: 'INVALID' } as const;
    }

    const variants = yield* transaction
      .select({
        lifecycleState: productVariants.lifecycleState,
        productId: productVariants.productId,
        variantId: productVariants.variantId,
      })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productRef.resourceId)))
      .for('share')
      .pipe(Effect.mapError(unavailable));
    const candidate = variants.find((row) => row.variantId === variantRef.resourceId);
    if (candidate === undefined || candidate.productId !== productRef.resourceId) {
      return { reason: 'WRONG_PRODUCT', status: 'INVALID' } as const;
    }
    // A recorded draft or retired form remains addressable as history, but cannot
    // be promoted to a new Current selection even when its axis basis is unknown.
    if (candidate.lifecycleState !== 'ACTIVE') {
      return { reason: 'NOT_CURRENT', status: 'INVALID' } as const;
    }

    const axisReader = variantAxisPersistenceForScope(transaction, scope);
    const axisBasis = yield* axisReader
      .readCurrent(productRef)
      .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.succeed(null)));
    if (axisBasis === null) {
      return { reason: 'AXIS_BASIS_UNAVAILABLE', status: 'INDETERMINATE' } as const;
    }
    if (axisBasis.axisRevision === 0) {
      return { reason: 'AXIS_REVISION_MISSING', status: 'INDETERMINATE' } as const;
    }
    const recorded = yield* axisReader
      .readRecordedCombinations(productRef, axisBasis)
      .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.succeed(null)));
    if (recorded === null) {
      return { reason: 'AXIS_BASIS_UNAVAILABLE', status: 'INDETERMINATE' } as const;
    }
    if (!recorded.some((item) => item.variantId === variantRef.resourceId)) {
      return { reason: 'UNRECORDED_COMBINATION', status: 'INVALID' } as const;
    }
    if (axisBasis.axes.length > 0) {
      const effectiveValues = yield* axisReader
        .readEffectiveValues(productRef, variantRef, axisBasis)
        .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.succeed(null)));
      if (effectiveValues === null) {
        return { reason: 'AXIS_BASIS_UNAVAILABLE', status: 'INDETERMINATE' } as const;
      }
      if (effectiveValues.some((value) => value.source === 'MISSING')) {
        return { reason: 'MISSING_AXIS_VALUE', status: 'INVALID' } as const;
      }
      // Source-qualified rows alone do not establish semantic validity, a
      // Product-specific controlled allowed set, or open-selection safety.
      return { axisRevision: axisBasis.axisRevision, reason: 'ALLOWED_SET_UNPROVEN', status: 'INDETERMINATE' } as const;
    }
    if (variants.some((row) => row.variantId !== variantRef.resourceId && row.lifecycleState === 'ACTIVE')) {
      return { reason: 'DUPLICATE_COMBINATION', status: 'INVALID' } as const;
    }
    // #479 has no owner-issued open-selection proof here. Never promote this candidate.
    return {
      axisRevision: axisBasis.axisRevision,
      combinationKey: axisFreeCombinationKey(),
      reason: 'OPEN_SELECTION_UNPROVEN',
      status: 'INDETERMINATE',
    } as const;
  }),
});
