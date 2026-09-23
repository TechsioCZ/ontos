import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, desc, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import type { SetProductTypeResult } from '../../shared/actions/set-product-type.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import { readCartOpenSelectionPopulation } from '../../shared/domain/catalog-open-selection-population.ts';
import type { ProductTypeRef } from '../../shared/resources/product-type.ts';
import {
  productTypeAssignmentEvents,
  productTypeAssignments,
  productTypeRevisions,
  productTypes,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class ProductTypeAssignmentRejected extends Schema.TaggedError<ProductTypeAssignmentRejected>()(
  'ProductTypeAssignmentRejected',
  {
    code: Schema.Literal('product_type_stale_impact_basis'),
    reason: Schema.String,
  },
) {}

const stale = (reason: string) =>
  new ProductTypeAssignmentRejected({ code: 'product_type_stale_impact_basis', reason });

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export interface SetProductTypePersistenceInput {
  readonly actionInvocationId: string;
  readonly expectedProductRevision: number;
  readonly impactBasis: string;
  readonly nextProductTypeRef?: ProductTypeRef;
  readonly principalId: string;
  readonly productId: string;
  readonly reason: string;
}

export interface ProductTypeAssignmentPersistence {
  readonly set: (
    input: SetProductTypePersistenceInput,
  ) => Effect.Effect<SetProductTypeResult, ProductTypeAssignmentRejected | CatalogPersistenceUnavailable>;
}

/**
 * Revalidates the Cart-owned population token and Catalog-owned Current rows before changing one
 * Product Type assignment. A non-empty open-selection population remains blocked because the
 * existing evidence reader can only assess the Current assignment, not the proposed one.
 */
export const productTypeAssignmentPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  authoritativeBasis: {
    /** Injected Cart owner contract; absent means Catalog cannot attest the population. */
    readonly openSelections?: CartOpenSelectionPopulationPort;
  } = {},
): Effect.Effect<ProductTypeAssignmentPersistence> => {
  const { tenantId } = scope;
  const readPopulation = () => {
    if (authoritativeBasis.openSelections === undefined) {
      return Effect.fail(stale('A complete Current Cart selection basis is required'));
    }
    return readCartOpenSelectionPopulation(authoritativeBasis.openSelections, tenantId).pipe(
      Effect.mapError((failure) => stale(failure.reason)),
    );
  };

  const set: ProductTypeAssignmentPersistence['set'] = Effect.fn('ProductTypeAssignmentPersistence.set')(
    // oxlint-disable-next-line eslint/complexity -- One transaction keeps every fail-closed basis check adjacent to the atomic assignment write; owner: Catalog #423; expires: 2027-03-31.
    function* set(input) {
      if (input.nextProductTypeRef !== undefined && input.nextProductTypeRef.tenantId !== tenantId) {
        return yield* stale('Product Type is outside the trusted Tenant');
      }

      const initialPopulation = yield* readPopulation();
      if (initialPopulation.revisionToken !== input.impactBasis) {
        return yield* stale('Cart selection impact basis is stale');
      }
      if (initialPopulation.selections.length !== 0) {
        return yield* stale('Open selections require candidate Product Type reassessment before assignment');
      }

      const [product] = yield* transaction
        .select({ currentRevision: products.currentRevision })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, input.productId)))
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (product === undefined || product.currentRevision !== input.expectedProductRevision) {
        return yield* stale('Product is absent or changed since impact review');
      }
      const nextProductRevision = product.currentRevision + 1;
      if (!Number.isSafeInteger(nextProductRevision)) {
        return yield* stale('The next Product revision cannot be represented safely');
      }

      const [assignment] = yield* transaction
        .select({
          assignmentRevision: productTypeAssignments.assignmentRevision,
          productTypeId: productTypeAssignments.productTypeId,
        })
        .from(productTypeAssignments)
        .where(
          and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, input.productId)),
        )
        .for('share')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      const previousProductTypeId = assignment?.productTypeId ?? null;
      const nextProductTypeId = input.nextProductTypeRef?.resourceId ?? null;
      if (previousProductTypeId === nextProductTypeId) {
        return yield* stale('No Product Type transition exists');
      }

      const [latestEvent] = yield* transaction
        .select({ assignmentRevision: productTypeAssignmentEvents.assignmentRevision })
        .from(productTypeAssignmentEvents)
        .where(
          and(
            eq(productTypeAssignmentEvents.tenantId, tenantId),
            eq(productTypeAssignmentEvents.productId, input.productId),
          ),
        )
        .orderBy(desc(productTypeAssignmentEvents.assignmentRevision))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      const assignmentRevision = (latestEvent?.assignmentRevision ?? 0) + 1;
      if (!Number.isSafeInteger(assignmentRevision)) {
        return yield* stale('The next Product Type assignment revision cannot be represented safely');
      }

      if (nextProductTypeId !== null) {
        const [nextType] = yield* transaction
          .select({ currentRevision: productTypes.currentRevision })
          .from(productTypes)
          .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, nextProductTypeId)))
          .for('share')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (nextType === undefined) {
          return yield* stale('Product Type is absent from the trusted Tenant');
        }
        const [nextRevision] = yield* transaction
          .select({ productTypeRevisionId: productTypeRevisions.productTypeRevisionId })
          .from(productTypeRevisions)
          .where(
            and(
              eq(productTypeRevisions.tenantId, tenantId),
              eq(productTypeRevisions.productTypeId, nextProductTypeId),
              eq(productTypeRevisions.revision, nextType.currentRevision),
            ),
          )
          .for('share')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (nextRevision === undefined) {
          return yield* stale('Current Product Type revision evidence is absent');
        }
      }

      const confirmedPopulation = yield* readPopulation();
      if (
        confirmedPopulation.tenantId !== initialPopulation.tenantId ||
        confirmedPopulation.revisionToken !== input.impactBasis ||
        confirmedPopulation.selections.length !== 0
      ) {
        return yield* stale('Cart selection impact basis changed during assignment review');
      }

      const updatedAt = yield* DateTime.nowAsDate;
      const [updatedProduct] = yield* transaction
        .update(products)
        .set({ currentRevision: nextProductRevision, updatedAt })
        .where(
          and(
            eq(products.tenantId, tenantId),
            eq(products.productId, input.productId),
            eq(products.currentRevision, input.expectedProductRevision),
          ),
        )
        .returning({ currentRevision: products.currentRevision })
        .pipe(Effect.mapError(unavailable));
      if (updatedProduct?.currentRevision !== nextProductRevision) {
        return yield* stale('Product changed before the assignment could be committed');
      }

      yield* nextProductTypeId === null
        ? transaction
            .delete(productTypeAssignments)
            .where(
              and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, input.productId)),
            )
            .pipe(Effect.mapError(unavailable))
        : transaction
            .insert(productTypeAssignments)
            .values({
              assignedByActionInvocationId: input.actionInvocationId,
              assignedByPrincipalId: input.principalId,
              assignmentRevision,
              productId: input.productId,
              productTypeId: nextProductTypeId,
              tenantId,
            })
            .onConflictDoUpdate({
              set: {
                assignedAt: updatedAt,
                assignedByActionInvocationId: input.actionInvocationId,
                assignedByPrincipalId: input.principalId,
                assignmentRevision,
                productTypeId: nextProductTypeId,
              },
              target: [productTypeAssignments.tenantId, productTypeAssignments.productId],
            })
            .pipe(Effect.mapError(unavailable));
      yield* transaction
        .insert(productTypeAssignmentEvents)
        .values({
          actingPrincipalId: input.principalId,
          actionInvocationId: input.actionInvocationId,
          assignmentRevision,
          nextProductTypeId,
          previousProductTypeId,
          productId: input.productId,
          reason: input.reason,
          tenantId,
        })
        .pipe(Effect.mapError(unavailable));

      const productRef = {
        moduleId: 'commerce.catalog' as const,
        resourceId: input.productId,
        resourceType: 'commerce.catalog.product' as const,
        tenantId,
      };
      const result = { productRef, revision: nextProductRevision, unresolvedProductRefs: [] };
      return input.nextProductTypeRef === undefined
        ? result
        : { ...result, currentProductTypeRef: input.nextProductTypeRef };
    },
  );

  return Effect.succeed({ set });
};
