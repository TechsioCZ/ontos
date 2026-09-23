import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionOwnerAssessmentResult } from '../../shared/domain/catalog-selection-owner-contract.ts';
import { catalogSelectionValidityAttestationFor } from '../../shared/domain/catalog-selection-validity.ts';
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
  productTypes,
  productUnitRuleRevisions,
  productUnits,
  productVariantAxisEvents,
  productVariants,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { catalogSelectionCurrentBasisForScope } from '../../src/persistence/catalog-selection-current-basis.ts';
import { catalogSelectionEvidenceForScope } from '../../src/persistence/catalog-selection-evidence-service.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const productId = randomUUID();
const variantId = randomUUID();
const unitId = randomUUID();
const productTypeId = randomUUID();
const productTypeRevisionId = randomUUID();
const packageDefinitionId = randomUUID();
const evidenceRefs = ['catalog:selection-source-change-postgres'];
const effectiveAt = new Date('2026-09-01T00:00:00.000Z');

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: {
    contentRevision: {
      resourceRef: ref('commerce.catalog.package-definition', packageDefinitionId),
      revision: 4,
    },
    optionRef: ref('commerce.catalog.package-definition', packageDefinitionId),
  },
  productRef: ref('commerce.catalog.product', productId),
  variantRef: ref('commerce.catalog.variant', variantId),
});

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:selection-source-change-postgres:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'selection-source-change-postgres',
};

const basisOf = (evidence: CatalogSelectionOwnerAssessmentResult) =>
  'basis' in evidence ? evidence.basis : ([] as const);

it.live('re-assesses a changed deciding source for the same Selection identity without reusing stale evidence', () =>
  Effect.scoped(
    Effect.gen(function* catalogSelectionSourceChange() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, catalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, catalogRelations);
      const withTenant = <Value, Failure>(
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedSourceChangeTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const readCurrent = () =>
        withTenant((transaction) =>
          catalogSelectionCurrentBasisForScope(
            // @ts-expect-error The integration transaction lacks only Core's private scope brand.
            transaction,
            scope,
          ).read({ purpose: 'PURCHASE_ACCEPTANCE', selection }),
        );
      const assessEvidence = () =>
        withTenant((transaction) =>
          catalogSelectionEvidenceForScope(
            // @ts-expect-error The integration transaction lacks only Core's private scope brand.
            transaction,
            scope,
          ).assess({ purpose: 'PURCHASE_ACCEPTANCE', selection }),
        );

      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedPackageSelection() {
          yield* transaction.insert(products).values({
            createdByActionInvocationId: productId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            name: 'Source change target',
            productId,
            tenantId,
          });
          yield* transaction.insert(productVariantAxisEvents).values({
            actingPrincipalId: principalId,
            actionInvocationId: variantId,
            attributeDefinitionIds: [],
            attributeDefinitionRevisions: [],
            axisRevision: 1,
            evidenceRefs,
            productId,
            reason: 'No variant axes',
            tenantId,
          });
          yield* transaction.insert(productVariants).values({
            combinationAxisRevision: 1,
            combinationKey: '3'.repeat(64),
            createdByActionInvocationId: variantId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            productId,
            tenantId,
            variantId,
          });
          yield* transaction.insert(productTypes).values({
            createdByActionInvocationId: productTypeId,
            createdByPrincipalId: principalId,
            currentRevision: 1,
            name: 'Source change type',
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
          yield* transaction.insert(variantUnitDivisibility).values({
            currentRevision: 1,
            divisible: false,
            tenantId,
            unitId,
            variantId,
          });
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
            variantId,
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
              variantId,
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
            variantId,
          });
        }),
      );

      const prepared = yield* assessEvidence();
      const ownerDecision = yield* readCurrent();
      expect(ownerDecision.status).toBe('OBSERVED');
      if (ownerDecision.status !== 'OBSERVED') {
        return;
      }
      expect(
        assessCatalogSelection({
          assessedAt: ownerDecision.assessedAt,
          current: ownerDecision,
          purpose: 'PURCHASE_ACCEPTANCE',
          selection,
        }).status,
      ).toBe('VALID');
      expect(
        basisOf(prepared.evidence).some(({ role, source }) => role === 'PACKAGE_CONTENT' && source.revision === 4),
      ).toBe(true);
      const originalAttestation = catalogSelectionValidityAttestationFor({
        evidence: assessCatalogSelection({
          assessedAt: ownerDecision.assessedAt,
          current: ownerDecision,
          purpose: 'PURCHASE_ACCEPTANCE',
          selection,
        }),
        purpose: 'PURCHASE_ACCEPTANCE',
        validUntil: '2099-01-01T00:00:00.000Z',
      });
      expect(
        originalAttestation?.basis.some(({ role, source }) => role === 'PACKAGE_CONTENT' && source.revision === 4),
      ).toBe(true);

      // A different transaction changes the deciding Package Content revision.
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
        variantId,
      });
      yield* admin
        .update(packageDefinitions)
        .set({ currentRevision: 5 })
        .where(eq(packageDefinitions.packageDefinitionId, packageDefinitionId));

      const reassessed = yield* assessEvidence();
      expect(reassessed.evidence).toMatchObject({ status: 'INVALID' });
      expect(reassessed.validity).toBeUndefined();
      expect(basisOf(reassessed.evidence).some(({ role }) => role === 'PACKAGE_CONTENT')).toBe(false);
      expect(
        basisOf(prepared.evidence).some(({ role, source }) => role === 'PACKAGE_CONTENT' && source.revision === 4),
      ).toBe(true);

      const rowsBeforeRetry = yield* admin
        .select({ revision: packageContentRevisions.revision })
        .from(packageContentRevisions)
        .where(eq(packageContentRevisions.tenantId, tenantId));
      const retry = yield* assessEvidence();
      expect(retry.evidence).toMatchObject({ status: 'INVALID' });
      const rowsAfterRetry = yield* admin
        .select({ revision: packageContentRevisions.revision })
        .from(packageContentRevisions)
        .where(eq(packageContentRevisions.tenantId, tenantId));
      expect(rowsAfterRetry).toEqual(rowsBeforeRetry);
    }),
  ),
);
