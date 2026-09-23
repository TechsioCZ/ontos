import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { resolveProductOnlyVariant } from '../../shared/domain/variant-exact-form.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Product-only Variant identity is unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

/** The Product lock serializes this read with Variant creation, which locks the same owner row. */
export const productOnlyVariantResolutionForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  resolve: Effect.fn('productOnlyVariantResolutionForScope.resolve')(function* resolve(productRef: ProductRef) {
    if (
      productRef.moduleId !== 'commerce.catalog' ||
      productRef.resourceType !== 'commerce.catalog.product' ||
      productRef.tenantId !== scope.tenantId
    ) {
      return { status: 'INVALID_SCOPE' } as const;
    }
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, productRef.resourceId)))
      .for('update')
      .limit(1);
    if (product === undefined) {
      return { status: 'PRODUCT_NOT_FOUND' } as const;
    }
    const rows = yield* transaction
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, scope.tenantId),
          eq(productVariants.productId, productRef.resourceId),
          eq(productVariants.lifecycleState, 'ACTIVE'),
        ),
      )
      .limit(2);
    const variants = rows.map((row) => ({
      lifecycle: 'ACTIVE' as const,
      productRef,
      variantId: row.variantId,
      variantRef: {
        moduleId: 'commerce.catalog' as const,
        resourceId: row.variantId,
        resourceType: 'commerce.catalog.variant' as const,
        tenantId: row.tenantId,
      },
    }));
    return resolveProductOnlyVariant({ productRef, variants });
  }, Effect.mapError(unavailable)),
});
