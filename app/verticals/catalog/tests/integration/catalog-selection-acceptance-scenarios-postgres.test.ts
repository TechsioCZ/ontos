import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  catalogRelations,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  packageUnitDivisibility,
  products,
  productTypeAssignmentEvents,
  productTypeAssignments,
  productTypeRevisions,
  productTypeUntypedDecisions,
  productTypes,
  productUnitRuleRevisions,
  productUnits,
  productVariantAxisEvents,
  productVariants,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { catalogSelectionCurrentBasisForScope } from '../../src/persistence/catalog-selection-current-basis.ts';
import { setCompositionPersistenceForScope } from '../../src/persistence/set-composition-persistence.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const productId = randomUUID();
const variantA = randomUUID();
const variantB = randomUUID();
const unitId = randomUUID();
const productTypeId = randomUUID();
const productTypeRevisionId = randomUUID();
const packageDefinitionId = randomUUID();
const compositionId = randomUUID();
const componentAId = randomUUID();
const componentBId = randomUUID();
const componentProductId = randomUUID();
const componentVariantId = randomUUID();
const evidenceRefs = ['catalog:selection-acceptance-postgres'];
const effectiveAt = new Date('2026-09-01T00:00:00.000Z');

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', productId);
const selectionFor = (variantId: string) =>
  Schema.decodeUnknownSync(CatalogSelectionSchema)({
    productRef,
    variantRef: ref('commerce.catalog.variant', variantId),
  });
const packageSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: {
    contentRevision: { resourceRef: ref('commerce.catalog.package-definition', packageDefinitionId), revision: 4 },
    optionRef: ref('commerce.catalog.package-definition', packageDefinitionId),
  },
  productRef,
  variantRef: ref('commerce.catalog.variant', variantA),
});

interface BasisFact {
  readonly role: string;
  readonly source: { readonly resourceRef: { readonly resourceId: string } };
}
const variantBasisOf = (basis: readonly BasisFact[]) =>
  basis.find(({ role }) => role === 'VARIANT')?.source.resourceRef.resourceId;
const assessFor = (current: Parameters<typeof assessCatalogSelection>[0]['current'], selection: CatalogSelection) =>
  assessCatalogSelection({ assessedAt: current.assessedAt, current, purpose: 'PURCHASE_ACCEPTANCE', selection });

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:selection-acceptance-postgres:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'selection-acceptance-postgres',
};

const revisionRow = (revision: number) => ({
  actingPrincipalId: principalId,
  actionInvocationId: randomUUID(),
  changeKind: revision === 1 ? ('INITIAL' as const) : ('MATERIAL_CHANGE' as const),
  compositionId,
  effectiveFrom: effectiveAt,
  evidenceRefs,
  lifecycleState: 'ACTIVE' as const,
  predecessorRevision: revision === 1 ? null : revision - 1,
  productId,
  reason: `Set composition revision ${revision}`,
  revision,
  tenantId,
  variantId: variantA,
});

it.live('issues Current Catalog Selection evidence for distinct Variants, changed packages, and Set history', () =>
  Effect.scoped(
    Effect.gen(function* catalogSelectionAcceptance() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, catalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, catalogRelations);
      const withTenant = <Value, Failure>(
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedSelectionTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const read = (selection: CatalogSelection) =>
        withTenant((transaction) =>
          catalogSelectionCurrentBasisForScope(
            // @ts-expect-error The integration transaction lacks only Core's private scope brand.
            transaction,
            scope,
          ).read({ purpose: 'PURCHASE_ACCEPTANCE', selection }),
        );

      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedCatalogSelectionGraph() {
          yield* transaction.insert(products).values({
            createdByActionInvocationId: productId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            name: 'Selection target',
            productId,
            tenantId,
          });
          yield* transaction.insert(productVariantAxisEvents).values({
            actingPrincipalId: principalId,
            actionInvocationId: variantA,
            attributeDefinitionIds: [],
            attributeDefinitionRevisions: [],
            axisRevision: 1,
            evidenceRefs,
            productId,
            reason: 'No variant axes',
            tenantId,
          });
          yield* transaction.insert(productVariants).values([
            {
              combinationAxisRevision: 1,
              combinationKey: '0'.repeat(64),
              createdByActionInvocationId: variantA,
              createdByPrincipalId: principalId,
              currentRevision: 1,
              lifecycleState: 'ACTIVE',
              productId,
              tenantId,
              variantId: variantA,
            },
            {
              combinationAxisRevision: 1,
              combinationKey: '1'.repeat(64),
              createdByActionInvocationId: randomUUID(),
              createdByPrincipalId: principalId,
              currentRevision: 1,
              lifecycleState: 'ACTIVE',
              productId,
              tenantId,
              variantId: variantB,
            },
          ]);
          yield* transaction.insert(productTypes).values({
            createdByActionInvocationId: productTypeId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            name: 'Selection type',
            productTypeId,
            tenantId,
          });
          yield* transaction.insert(productTypeRevisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: productTypeRevisionId,
            effectiveAt,
            productTypeId,
            productTypeRevisionId,
            reason: 'Initial type revision',
            revision: 1,
            tenantId,
          });
          yield* transaction.insert(productTypeAssignmentEvents).values({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            assignmentRevision: 1,
            nextProductTypeId: productTypeId,
            previousProductTypeId: null,
            productId,
            reason: 'Initial Product Type assignment',
            tenantId,
          });
          yield* transaction.insert(productTypeAssignments).values({
            assignedByActionInvocationId: randomUUID(),
            assignedByPrincipalId: principalId,
            assignmentRevision: 1,
            productId,
            productTypeId,
            tenantId,
          });
          yield* transaction.insert(productUnits).values({
            code: `piece-${unitId}`,
            currentRuleRevision: 1,
            label: 'piece',
            lifecycleState: 'ACTIVE',
            tenantId,
            unitId,
          });
          yield* transaction.insert(productUnitRuleRevisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            changeKind: 'CREATED',
            evidenceRefs,
            lifecycleState: 'ACTIVE',
            reason: 'Whole pieces',
            revision: 1,
            rounding: 'UP',
            step: '1',
            tenantId,
            unitId,
          });
          yield* transaction.insert(variantUnitDivisibility).values([
            {
              currentRevision: 1,
              divisible: false,
              tenantId,
              unitId,
              variantId: variantA,
            },
            {
              currentRevision: 1,
              divisible: false,
              tenantId,
              unitId,
              variantId: variantB,
            },
          ]);

          // Package with pinned content revision 4 (ten units) and successor 5 (eight units).
          yield* transaction.insert(packageDefinitions).values({
            createdByActionInvocationId: randomUUID(),
            createdByPrincipalId: principalId,
            currentOptionRevision: 2,
            currentRevision: 4,
            lifecycleState: 'ACTIVE',
            optionState: 'ACTIVE',
            packageDefinitionId,
            productId,
            tenantId,
            variantId: variantA,
          });
          yield* transaction.insert(packageContentRevisions).values(
            [
              { amount: '10', effectiveAt: new Date('2026-09-01T00:00:00.000Z'), revision: 1 },
              { amount: '10', effectiveAt: new Date('2026-09-02T00:00:00.000Z'), revision: 2 },
              { amount: '10', effectiveAt: new Date('2026-09-03T00:00:00.000Z'), revision: 3 },
              { amount: '10', effectiveAt: new Date('2026-09-04T00:00:00.000Z'), revision: 4 },
            ].map(({ amount, effectiveAt: contentEffectiveAt, revision }) => ({
              actingPrincipalId: principalId,
              actionInvocationId: randomUUID(),
              amount,
              effectiveAt: contentEffectiveAt,
              evidenceRefs,
              lifecycleState: 'ACTIVE',
              packageDefinitionId,
              productId,
              reason: 'Pinned package content',
              revision,
              tenantId,
              unitResourceId: unitId,
              unitResourceType: 'commerce.catalog.product-unit',
              variantId: variantA,
            })),
          );
          yield* transaction.insert(packageUnitDivisibility).values({
            currentRevision: 1,
            divisible: false,
            packageDefinitionId,
            tenantId,
            unitId,
          });
          yield* transaction.insert(packageOptionRoleRevisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            contentRevision: 4,
            effectiveAt,
            evidenceRefs,
            independentlyRequested: true,
            looseUnitsSubstitutable: false,
            packageDefinitionId,
            productId,
            revision: 2,
            state: 'ACTIVE',
            tenantId,
            validationReason: 'Independently selectable package',
            variantId: variantA,
          });
        }),
      );

      // S1: two Variants of one Product are distinct selections with distinct Current basis.
      const beforeA = yield* read(selectionFor(variantA));
      const beforeB = yield* read(selectionFor(variantB));
      expect(beforeA.status).toBe('OBSERVED');
      expect(beforeB.status).toBe('OBSERVED');
      if (beforeA.status !== 'OBSERVED' || beforeB.status !== 'OBSERVED') {
        return;
      }
      expect(variantBasisOf(beforeA.basis)).toBe(variantA);
      expect(variantBasisOf(beforeB.basis)).toBe(variantB);
      expect(beforeA.membership.attestationId).not.toBe(beforeB.membership.attestationId);
      expect(assessFor(beforeA, selectionFor(variantA)).status).toBe('VALID');
      expect(assessFor(beforeB, selectionFor(variantB)).status).toBe('VALID');
      expect(assessFor(beforeA, selectionFor(variantB)).status).toBe('INDETERMINATE');

      // S2: the old pinned Package Content revision still explains its own amount.
      const pinned = yield* read(packageSelection);
      expect(pinned.status).toBe('OBSERVED');
      if (pinned.status === 'OBSERVED') {
        const packageContent = pinned.basis.find(({ role }) => role === 'PACKAGE_CONTENT');
        expect(packageContent?.source.revision).toBe(4);
        expect(packageContent?.source.resourceRef.resourceId).toBe(packageDefinitionId);
      }
      expect(
        yield* admin
          .select({ amount: packageContentRevisions.amount })
          .from(packageContentRevisions)
          .where(
            and(
              eq(packageContentRevisions.tenantId, tenantId),
              eq(packageContentRevisions.packageDefinitionId, packageDefinitionId),
              eq(packageContentRevisions.revision, 4),
            ),
          ),
      ).toEqual([{ amount: '10' }]);

      yield* admin.insert(packageContentRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        amount: '8',
        effectiveAt: new Date('2026-09-05T00:00:00.000Z'),
        evidenceRefs,
        lifecycleState: 'ACTIVE',
        packageDefinitionId,
        productId,
        reason: 'New package content',
        revision: 5,
        tenantId,
        unitResourceId: unitId,
        unitResourceType: 'commerce.catalog.product-unit',
        variantId: variantA,
      });
      yield* admin
        .update(packageDefinitions)
        .set({ currentRevision: 5 })
        .where(eq(packageDefinitions.packageDefinitionId, packageDefinitionId));
      const afterChange = yield* read(packageSelection);
      expect(afterChange.status).toBe('INVALID');
      expect(afterChange.basis.some(({ role }) => role === 'PACKAGE_CONTENT')).toBe(false);

      // S6: an accepted Set Composition revision stays exactly explainable after a successor.
      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedSetComposition() {
          yield* transaction.insert(products).values({
            createdByActionInvocationId: componentProductId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            name: 'Set component product',
            productId: componentProductId,
            tenantId,
          });
          yield* transaction.insert(productVariantAxisEvents).values({
            actingPrincipalId: principalId,
            actionInvocationId: componentVariantId,
            attributeDefinitionIds: [],
            attributeDefinitionRevisions: [],
            axisRevision: 1,
            evidenceRefs,
            productId: componentProductId,
            reason: 'No variant axes',
            tenantId,
          });
          yield* transaction.insert(productVariants).values({
            combinationAxisRevision: 1,
            combinationKey: '2'.repeat(64),
            createdByActionInvocationId: componentVariantId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            productId: componentProductId,
            tenantId,
            variantId: componentVariantId,
          });
          yield* transaction.insert(setCompositions).values({
            compositionId,
            currentRevision: 1,
            productId,
            tenantId,
            variantId: variantA,
          });
          yield* transaction.insert(setCompositionRevisions).values([revisionRow(1), revisionRow(2)]);
          yield* transaction.insert(setCompositionComponents).values(
            [
              { amount: '1', componentId: componentAId, revision: 1 },
              { amount: '2', componentId: componentBId, revision: 1 },
              { amount: '3', componentId: componentAId, revision: 2 },
              { amount: '4', componentId: componentBId, revision: 2 },
            ].map(({ amount, componentId, revision }) => ({
              componentId,
              componentProductId,
              componentVariantId,
              compositionId,
              quantityAmount: amount,
              quantityUnitId: unitId,
              revision,
              tenantId,
            })),
          );
          yield* transaction
            .update(setCompositions)
            .set({ currentRevision: 2 })
            .where(eq(setCompositions.compositionId, compositionId));
        }),
      );

      const history = yield* withTenant((transaction) =>
        setCompositionPersistenceForScope(
          // @ts-expect-error The integration transaction lacks only Core's private scope brand.
          transaction,
          scope,
        ).readRevision({ compositionId, revision: 1 }),
      );
      expect(Option.isSome(history)).toBe(true);
      if (Option.isSome(history)) {
        const amountByComponent = new Map<string, string>(
          history.value.revision.components.map(({ componentId, quantity }) => [componentId, quantity.amount]),
        );
        expect(amountByComponent.get(componentAId)).toBe('1');
        expect(amountByComponent.get(componentBId)).toBe('2');
      }
      const current = yield* withTenant((transaction) =>
        setCompositionPersistenceForScope(
          // @ts-expect-error The integration transaction lacks only Core's private scope brand.
          transaction,
          scope,
        ).readCurrent({ at: new Date('2026-09-18T00:00:00.000Z'), compositionId }),
      );
      expect(Option.isSome(current) && current.value.revision.reference.revision).toBe(2);
    }),
  ),
);

it.live('issues VALID selection evidence from an exact confirmed-untyped decision and invalidates source drift', () =>
  Effect.scoped(
    Effect.gen(function* confirmedUntypedSelectionAcceptance() {
      const untypedTenantId = randomUUID();
      const untypedProductId = randomUUID();
      const untypedVariantId = randomUUID();
      const untypedUnitId = randomUUID();
      const untypedScope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:selection-untyped-postgres:run:1',
          authMethod: 'system',
          principalId,
          tenantId: untypedTenantId,
        }),
        correlationId: 'selection-untyped-postgres',
      };
      const untypedProductRef = {
        moduleId: 'commerce.catalog' as const,
        resourceId: untypedProductId,
        resourceType: 'commerce.catalog.product' as const,
        tenantId: untypedTenantId,
      };
      const untypedSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        productRef: untypedProductRef,
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: untypedVariantId,
          resourceType: 'commerce.catalog.variant',
          tenantId: untypedTenantId,
        },
      });
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, catalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, catalogRelations);
      const read = () =>
        runtime.transaction((transaction) =>
          Effect.gen(function* readUntypedSelection() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${untypedTenantId}, true)`, 'objects');
            return yield* catalogSelectionCurrentBasisForScope(
              // @ts-expect-error The integration transaction lacks only Core's private scope brand.
              transaction,
              untypedScope,
            ).read({ purpose: 'PURCHASE_ACCEPTANCE', selection: untypedSelection });
          }),
        );

      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedUntypedSelection() {
          yield* transaction.insert(products).values({
            createdByActionInvocationId: randomUUID(),
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            name: 'Confirmed untyped selection',
            productId: untypedProductId,
            tenantId: untypedTenantId,
          });
          yield* transaction.insert(productVariantAxisEvents).values({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            attributeDefinitionIds: [],
            attributeDefinitionRevisions: [],
            axisRevision: 3,
            evidenceRefs: ['catalog:confirmed-untyped-selection:axes-cleared'],
            productId: untypedProductId,
            reason: 'Historical axes are now cleared',
            tenantId: untypedTenantId,
          });
          yield* transaction.insert(productVariants).values({
            combinationAxisRevision: 3,
            combinationKey: '3'.repeat(64),
            createdByActionInvocationId: randomUUID(),
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            productId: untypedProductId,
            tenantId: untypedTenantId,
            variantId: untypedVariantId,
          });
          yield* transaction.insert(productTypeUntypedDecisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            axisRevision: 3,
            decisionRevision: 1,
            decisionState: 'CONFIRMED',
            evidenceRefs: ['catalog:confirmed-untyped-selection'],
            productId: untypedProductId,
            productRevision: 1,
            reason: 'No structured attributes or Variant axes are required',
            structuredAttributesRequired: false,
            tenantId: untypedTenantId,
            valueRevisionTokens: [],
            variantAxesRequired: false,
            variantRevisionTokens: [`${untypedVariantId}:1`],
          });
          yield* transaction.insert(productUnits).values({
            code: `piece-${untypedUnitId}`,
            currentRuleRevision: 1,
            label: 'piece',
            lifecycleState: 'ACTIVE',
            tenantId: untypedTenantId,
            unitId: untypedUnitId,
          });
          yield* transaction.insert(productUnitRuleRevisions).values({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            changeKind: 'CREATED',
            evidenceRefs,
            lifecycleState: 'ACTIVE',
            reason: 'Whole pieces',
            revision: 1,
            rounding: 'UP',
            step: '1',
            tenantId: untypedTenantId,
            unitId: untypedUnitId,
          });
          yield* transaction.insert(variantUnitDivisibility).values({
            currentRevision: 1,
            divisible: false,
            tenantId: untypedTenantId,
            unitId: untypedUnitId,
            variantId: untypedVariantId,
          });
        }),
      );

      const current = yield* read();
      expect(current.status).toBe('OBSERVED');
      if (current.status !== 'OBSERVED') {
        return;
      }
      expect(current.basis).toContainEqual({
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: untypedProductRef, revision: 1 },
      });
      expect(current.basis.some(({ role }) => role === 'PRODUCT_TYPE')).toBe(false);
      expect(assessFor(current, untypedSelection).status).toBe('VALID');

      yield* admin
        .update(products)
        .set({ currentRevision: 2 })
        .where(and(eq(products.tenantId, untypedTenantId), eq(products.productId, untypedProductId)));
      const drifted = yield* read();
      expect(drifted.status).toBe('INDETERMINATE');
      expect(drifted.basis.some(({ role }) => role === 'PRODUCT_TYPE_UNTYPED_DECISION')).toBe(false);
    }),
  ),
);
