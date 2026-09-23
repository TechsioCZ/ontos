import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, desc, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import type {
  DecideProductTypeUnnecessaryPayload,
  DecideProductTypeUnnecessaryResult,
} from '../../shared/actions/decide-product-type-unnecessary.ts';
import {
  productTypeAssignments,
  productTypeUntypedDecisions,
  productVariantAxes,
  productVariantAxisEvents,
  productVariants,
  products,
} from '../database/schema.ts';
import { effectiveAttributeValueReadsForScope } from './effective-attribute-value-reads.ts';
import type { AttributeValueSetValidityBasis } from './effective-attribute-value-reads.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class ProductTypeUntypedDecisionRejected extends Schema.TaggedError<ProductTypeUntypedDecisionRejected>()(
  'ProductTypeUntypedDecisionRejected',
  {
    code: Schema.Literal('product_type_untyped_decision_rejected'),
    reason: Schema.String,
  },
) {}

interface DecisionInput {
  readonly actionInvocationId: string;
  readonly payload: DecideProductTypeUnnecessaryPayload;
  readonly principalId: string;
}

export interface ProductTypeUntypedDecisionPersistence {
  readonly decide: (
    input: DecisionInput,
  ) => Effect.Effect<
    DecideProductTypeUnnecessaryResult,
    ProductTypeUntypedDecisionRejected | CatalogPersistenceUnavailable
  >;
}

const rejected = (reason: string) =>
  new ProductTypeUntypedDecisionRejected({ code: 'product_type_untyped_decision_rejected', reason });
const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};
const sameTokens = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((token, index) => token === expected[index]);

const inventoryBelongsToProduct = (
  inventory: AttributeValueSetValidityBasis,
  variants: readonly (typeof productVariants.$inferSelect)[],
  axes: readonly (typeof productVariantAxes.$inferSelect)[],
  tenantId: string,
  productId: string,
): boolean =>
  inventory.complete &&
  inventory.tenantId === tenantId &&
  inventory.entries.every((entry) => entry.productId === productId) &&
  variants.every((variant) => variant.tenantId === tenantId && variant.productId === productId) &&
  axes.every((axis) => axis.tenantId === tenantId && axis.productId === productId);

const currentVariantInventoryIsConsistent = (
  inventory: AttributeValueSetValidityBasis,
  variants: readonly (typeof productVariants.$inferSelect)[],
): boolean => {
  const ids = new Set(variants.map((variant) => variant.variantId));
  return (
    ids.size === variants.length &&
    inventory.entries.every((entry) => entry.variantId === null || ids.has(entry.variantId))
  );
};

/** Core supplies the transaction and trusted scope; the Product lock serializes the decision basis. */
export const productTypeUntypedDecisionPersistenceForScope = Effect.fn('productTypeUntypedDecisionPersistenceForScope')(
  function* productTypeUntypedDecisionPersistenceForScope(transaction: ScopedTransaction, scope: OperationalScope) {
    const valueReads = yield* effectiveAttributeValueReadsForScope(transaction, scope);
    return {
      decide: Effect.fn('ProductTypeUntypedDecisionPersistence.decide')(function* decide(input: DecisionInput) {
        const { payload } = input;
        const { productRef } = payload;
        if (productRef.tenantId !== scope.tenantId) {
          return yield* rejected('Product is outside the trusted Tenant');
        }
        const productId = productRef.resourceId;
        const [product] = yield* transaction
          .select({
            currentRevision: products.currentRevision,
            productId: products.productId,
            tenantId: products.tenantId,
          })
          .from(products)
          .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, productId)))
          .for('update')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (product === undefined || product.tenantId !== scope.tenantId || product.productId !== productId) {
          return yield* rejected('Product is not Current in the trusted Tenant');
        }
        if (product.currentRevision !== payload.expectedProductRevision) {
          return yield* rejected('Product revision is stale');
        }
        const [assignment, decisions, axisEvents, axes, variants, inventory] = yield* Effect.all(
          [
            transaction
              .select()
              .from(productTypeAssignments)
              .where(
                and(
                  eq(productTypeAssignments.tenantId, scope.tenantId),
                  eq(productTypeAssignments.productId, productId),
                ),
              )
              .for('share')
              .limit(1)
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select()
              .from(productTypeUntypedDecisions)
              .where(
                and(
                  eq(productTypeUntypedDecisions.tenantId, scope.tenantId),
                  eq(productTypeUntypedDecisions.productId, productId),
                ),
              )
              .orderBy(desc(productTypeUntypedDecisions.decisionRevision))
              .limit(1)
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select()
              .from(productVariantAxisEvents)
              .where(
                and(
                  eq(productVariantAxisEvents.tenantId, scope.tenantId),
                  eq(productVariantAxisEvents.productId, productId),
                ),
              )
              .orderBy(desc(productVariantAxisEvents.axisRevision))
              .limit(1)
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select()
              .from(productVariantAxes)
              .where(and(eq(productVariantAxes.tenantId, scope.tenantId), eq(productVariantAxes.productId, productId)))
              .for('share')
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select()
              .from(productVariants)
              .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.productId, productId)))
              .for('share')
              .pipe(Effect.mapError(unavailable)),
            valueReads.readProductTypeValidity([productId]),
          ],
          { concurrency: 1 },
        );
        if (assignment.length !== 0) {
          return yield* rejected('Product has a Current Product Type');
        }
        const [previous] = decisions;
        const decisionRevision = previous?.decisionRevision ?? 0;
        const axisRevision = axisEvents[0]?.axisRevision ?? 0;
        if (
          decisionRevision !== payload.expectedDecisionRevision ||
          axisRevision !== payload.expectedAxisRevision ||
          !inventoryBelongsToProduct(inventory, variants, axes, scope.tenantId, productId)
        ) {
          return yield* rejected('Current Product, axis, value, or decision basis is stale or incomplete');
        }
        const currentVariants = variants.filter((variant) => variant.lifecycleState !== 'RETIRED');
        if (!currentVariantInventoryIsConsistent(inventory, currentVariants)) {
          return yield* rejected('Current Variant value inventory is inconsistent');
        }
        const valueRevisionTokens = inventory.entries
          .filter((entry) => entry.variantId === null)
          .map((entry) => entry.sourceRevisionToken)
          .toSorted();
        const variantRevisionTokens = [
          ...currentVariants.map((variant) => `${variant.variantId}:${variant.currentRevision}`),
          ...inventory.entries
            .filter((entry) => entry.variantId !== null)
            .map((entry) => `${entry.variantId}:${entry.sourceRevisionToken}`),
        ].toSorted();
        if (
          !sameTokens(valueRevisionTokens, payload.expectedValueRevisionTokens) ||
          !sameTokens(variantRevisionTokens, payload.expectedVariantRevisionTokens)
        ) {
          return yield* rejected('Current Product or Variant inventory revisions are stale');
        }
        if (
          payload.decisionState === 'CONFIRMED' &&
          (axes.length !== 0 || inventory.entries.some((entry) => entry.currentState === 'SET'))
        ) {
          return yield* rejected('Structured attributes or Variant Axes still exist');
        }
        const nextRevision = decisionRevision + 1;
        yield* transaction
          .insert(productTypeUntypedDecisions)
          .values({
            actingPrincipalId: input.principalId,
            actionInvocationId: input.actionInvocationId,
            axisRevision,
            decisionRevision: nextRevision,
            decisionState: payload.decisionState,
            evidenceRefs: [...payload.evidenceRefs],
            productId,
            productRevision: product.currentRevision,
            reason: payload.reason,
            structuredAttributesRequired: false,
            tenantId: scope.tenantId,
            valueRevisionTokens,
            variantAxesRequired: false,
            variantRevisionTokens,
          })
          .pipe(Effect.mapError(unavailable));
        return { decisionRevision: nextRevision, decisionState: payload.decisionState, productRef };
      }),
    };
  },
);
