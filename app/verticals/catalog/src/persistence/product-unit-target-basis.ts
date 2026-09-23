import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match } from 'effect';

import type { SetProductUnitTargetDivisibilityPayload } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { packageContentRevisions, packageDefinitions, productVariants, products } from '../database/schema.ts';
import { resolveEffectiveRevision } from './package-persistence.ts';
import { ProductUnitPersistenceUnavailable } from './product-unit-persistence.ts';

const unavailable = (cause: unknown) => {
  const failure = new ProductUnitPersistenceUnavailable({
    code: 'product_unit_persistence_unavailable',
    reason: 'Authoritative Product Unit target basis is unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

type VerifyTarget = SetProductUnitTargetDivisibilityPayload['target'];
type VerifySources = SetProductUnitTargetDivisibilityPayload['expectedSources'];
type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const validTargetSources = (target: VerifyTarget, expectedSources: VerifySources, tenantId: string) =>
  target.tenantId === tenantId &&
  expectedSources.product.resourceRef.tenantId === tenantId &&
  expectedSources.variant.resourceRef.tenantId === tenantId &&
  (expectedSources.packageDefinition === undefined ||
    expectedSources.packageDefinition.resourceRef.tenantId === tenantId) &&
  (target.targetType === 'commerce.catalog.variant'
    ? expectedSources.packageDefinition === undefined
    : expectedSources.packageDefinition !== undefined);

const packageRevisionStatus = (
  revisions: readonly (typeof packageContentRevisions.$inferSelect)[],
  definition: typeof packageDefinitions.$inferSelect,
  expectedRevision: number,
  tenantId: string,
  at: Date,
): 'valid' | 'invalid' | 'stale' => {
  if (revisions.length !== definition.currentRevision) {
    return 'invalid';
  }
  const revision = Match.value(resolveEffectiveRevision(revisions, at)).pipe(
    Match.tag('invalid', () => null),
    Match.tag('resolved', ({ revision: effective }) => effective),
    Match.exhaustive,
  );
  if (revision === null) {
    return 'invalid';
  }
  const content = revisions.find((row) => row.revision === revision);
  if (
    content?.lifecycleState !== 'ACTIVE' ||
    content.productId !== definition.productId ||
    content.variantId !== definition.variantId ||
    content.packageDefinitionId !== definition.packageDefinitionId ||
    content.tenantId !== tenantId
  ) {
    return 'invalid';
  }
  return expectedRevision === revision ? 'valid' : 'stale';
};

export const productUnitTargetBasisForScope = (transaction: ScopedTransaction, scope: OperationalScope) => {
  const basis = {
    verify: Effect.fn('ProductUnitTargetBasis.verify')(function* verify(
      target: VerifyTarget,
      expectedSources: VerifySources,
    ) {
      if (!validTargetSources(target, expectedSources, scope.tenantId)) {
        return 'invalid' as const;
      }
      let variantId = target.targetId;
      let packageProductId: string | undefined;
      if (target.targetType === 'commerce.catalog.package-definition') {
        const [packageRow] = yield* transaction
          .select()
          .from(packageDefinitions)
          .where(
            and(
              eq(packageDefinitions.tenantId, scope.tenantId),
              eq(packageDefinitions.packageDefinitionId, target.targetId),
            ),
          )
          .for('update')
          .limit(1);
        if (packageRow === undefined || packageRow.lifecycleState !== 'ACTIVE') {
          return 'invalid' as const;
        }
        if (expectedSources.packageDefinition?.resourceRef.resourceId !== packageRow.packageDefinitionId) {
          return 'invalid' as const;
        }
        const revisions = yield* transaction
          .select()
          .from(packageContentRevisions)
          .where(
            and(
              eq(packageContentRevisions.tenantId, scope.tenantId),
              eq(packageContentRevisions.packageDefinitionId, packageRow.packageDefinitionId),
            ),
          );
        const status = packageRevisionStatus(
          revisions,
          packageRow,
          expectedSources.packageDefinition.revision,
          scope.tenantId,
          DateTime.toDateUtc(yield* DateTime.now),
        );
        if (status !== 'valid') {
          return status;
        }
        ({ variantId } = packageRow);
        packageProductId = packageRow.productId;
      }
      const [variantRow] = yield* transaction
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.variantId, variantId)))
        .for('update')
        .limit(1);
      if (variantRow === undefined) {
        return 'invalid' as const;
      }
      if (variantRow.lifecycleState !== 'ACTIVE') {
        return 'invalid' as const;
      }
      if (expectedSources.variant.resourceRef.resourceId !== variantRow.variantId) {
        return 'invalid' as const;
      }
      if (expectedSources.variant.revision !== variantRow.currentRevision) {
        return 'stale' as const;
      }
      if (packageProductId !== undefined && packageProductId !== variantRow.productId) {
        return 'invalid' as const;
      }
      const [product] = yield* transaction
        .select()
        .from(products)
        .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, variantRow.productId)))
        .for('update')
        .limit(1);
      if (product?.lifecycleState !== 'ACTIVE') {
        return 'invalid' as const;
      }
      if (expectedSources.product.resourceRef.resourceId !== product.productId) {
        return 'invalid' as const;
      }
      return expectedSources.product.revision === product.currentRevision ? ('valid' as const) : ('stale' as const);
    }, Effect.mapError(unavailable)),
  };
  return basis;
};
