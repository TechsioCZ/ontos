import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogSelectionMembershipSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog membership source is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

/** Only Catalog may issue membership, from both locked Current rows in the same scoped transaction. */
export const catalogSelectionMembershipForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  issue: Effect.fn('CatalogSelectionMembership.issue')(function* issue(productRef: ProductRef, variantRef: VariantRef) {
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
      .select({ currentRevision: products.currentRevision, productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productRef.resourceId)))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return { reason: 'PRODUCT_MISSING', status: 'INVALID' } as const;
    }

    const [variant] = yield* transaction
      .select({
        currentRevision: productVariants.currentRevision,
        productId: productVariants.productId,
        variantId: productVariants.variantId,
      })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, variantRef.resourceId)))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (variant === undefined) {
      return { reason: 'VARIANT_MISSING', status: 'INVALID' } as const;
    }
    if (variant.productId !== product.productId) {
      return { reason: 'WRONG_PRODUCT', status: 'INVALID' } as const;
    }
    if (
      !Number.isSafeInteger(product.currentRevision) ||
      product.currentRevision < 1 ||
      product.currentRevision > 2_147_483_647 ||
      !Number.isSafeInteger(variant.currentRevision) ||
      variant.currentRevision < 1 ||
      variant.currentRevision > 2_147_483_647
    ) {
      return { reason: 'CURRENT_REVISION_UNAVAILABLE', status: 'INDETERMINATE' } as const;
    }

    const revision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(variant.currentRevision).pipe(
      Effect.mapError(unavailable),
    );
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const membership = yield* Schema.decodeEffect(CatalogSelectionMembershipSchema)({
      attestationId: randomUUID(),
      observedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision },
    }).pipe(Effect.mapError(unavailable));
    return { membership, status: 'ISSUED' } as const;
  }),
});
