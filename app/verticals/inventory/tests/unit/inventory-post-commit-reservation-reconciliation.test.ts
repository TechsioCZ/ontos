import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  EstablishInventoryReservationInputSchema,
  ImportedCommittedObligationSchema,
  InventoryObligationRequirementSchema,
  RuntimeCommittedInventoryObligationSchema,
  RuntimeOrderCommitProofObservationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import { InventoryPostCommitReductionRequestSchema } from '../../shared/domain/inventory-post-commit-reservation-reconciliation.ts';
import { InventoryCommittedObligationStateEvidenceSchema } from '../../shared/domain/inventory-source-obligation-reconciliation.ts';
import { AppliedPhysicalStockEffectSchema } from '../../shared/domain/physical-stock-effect.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { InventoryReservationRefSchema } from '../../shared/resources/inventory-reservation.ts';
import { makeInventoryPostCommitReservationReconciliationService } from '../../src/services/inventory-post-commit-reservation-reconciliation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const replacementItemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const locationId = '77777777-7777-4777-8777-777777777777';
const configurationId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';
const effectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const occurredAt = '2026-09-24T10:00:00.000Z';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const itemRef = {
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;
const replacementItemRef = { ...itemRef, resourceId: replacementItemId };
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const stockLocationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const bindingRef = {
  moduleId: 'commerce.inventory',
  resourceId: bindingId,
  resourceType: 'commerce.inventory.catalog-to-stock-binding',
  tenantId,
} as const;
const authority = {
  configurationId,
  customerConfigurationId: 'customer-configuration-primary',
  revision: 1 as const,
  selectedAt: '2026-09-24T09:00:00.000Z',
  selection: {
    backend: 'external_business_system' as const,
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED' as const,
    stockCorrectionCapability: 'UNSUPPORTED' as const,
  },
  tenantId,
};
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: occurredAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});
const requirement = Schema.decodeUnknownSync(InventoryObligationRequirementSchema)({
  allocations: [
    {
      allocationId: 'allocation-1',
      positionRef,
      quantity: { amount: '5', unitRef },
      stockItemRef: itemRef,
    },
  ],
  bindingRef,
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'demand-occurrence-1',
  quantity: '5',
  stockItem,
  unitRef,
});
const reservationInput = Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema)({
  authority,
  establishedAt: occurredAt,
  origin: { attemptId: 'attempt-checkout-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: reservationId,
    resourceType: 'commerce.inventory.inventory-reservation',
    tenantId,
  },
  requirements: [requirement],
});
const reservation = {
  ...reservationInput,
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
} satisfies ProvisionalInventoryReservation;
const proofObservation = Schema.decodeUnknownSync(RuntimeOrderCommitProofObservationSchema)({
  acceptedOrderId: 'accepted-order-1',
  attemptId: reservation.origin.attemptId,
  evidenceRef: 'accepted-order-proof-1',
  observedAt: '2026-09-24T10:05:00.000Z',
  reservationRef: reservation.ref,
  tenantId,
});
const committed = Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
  ...reservation,
  confirmationTerminationReleasesStock: false,
  historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  obligationReductionCreatesOnHand: false,
  orderProof: {
    ...proofObservation,
    authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
    commitStatus: 'COMMITTED',
  },
  physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
  remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
});
const appliedIssue = Schema.decodeUnknownSync(AppliedPhysicalStockEffectSchema)({
  _tag: 'APPLIED',
  evidence: {
    appliedAt: '2026-09-24T11:00:00.000Z',
    backend: authority.selection.backend,
    backendConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    backendEvidenceRef: 'erp-primary:issue:1',
    backendId: authority.selection.backendId,
    effectId,
    issuer: authority.selection.backendId,
    kind: 'ISSUE',
    positionRef,
    quantity: { amount: '5', unitRef },
  },
  request: {
    actionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    backend: authority.selection.backend,
    backendConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    backendId: authority.selection.backendId,
    customerConfigurationId: authority.customerConfigurationId,
    effectId,
    kind: 'ISSUE',
    legalEntityId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    positionRef,
    quantity: { amount: '5', unitRef },
    reason: { code: 'ORDER_FULFILLMENT', reference: 'accepted-order-1' },
    requestedAt: '2026-09-24T10:30:00.000Z',
    stockItemRef: itemRef,
    stockLocationRef,
  },
});
const reducedEvidence = Schema.decodeUnknownSync(InventoryCommittedObligationStateEvidenceSchema)({
  obligationRef: reservation.ref,
  observedAt: '2026-09-24T11:05:00.000Z',
  ownerEvidenceRef: 'inventory:obligation-reduction:issue-1',
  positionRef,
  remainingQuantity: { amount: '0', unitRef },
  stockItemRef: itemRef,
});
const importedObligation = Schema.decodeUnknownSync(ImportedCommittedObligationSchema)({
  authority,
  importedAt: occurredAt,
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  orderProof: {
    acceptedOrderId: 'legacy-order-42',
    authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
    commitStatus: 'COMMITTED',
    evidenceRef: 'erp-primary:order-commit:42',
    observedAt: occurredAt,
    sourceOrderId: 'erp-order-42',
    sourceSystem: 'erp-primary',
  },
  origin: {
    kind: 'IMPORTED_PROVEN_ORDER',
    sourceObligationId: 'erp-obligation-42',
    sourceOrderId: 'erp-order-42',
    sourceSystem: 'erp-primary',
  },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    resourceType: 'commerce.inventory.imported-committed-obligation',
    tenantId,
  },
  requirements: [requirement],
  runtimeAttemptId: null,
});
const importedIssue = Schema.decodeUnknownSync(AppliedPhysicalStockEffectSchema)({
  ...appliedIssue,
  evidence: {
    ...appliedIssue.evidence,
    backendEvidenceRef: 'erp-primary:issue:42',
    effectId: '10101010-1010-4010-8010-101010101010',
  },
  request: {
    ...appliedIssue.request,
    effectId: '10101010-1010-4010-8010-101010101010',
    reason: { code: 'ORDER_FULFILLMENT', reference: 'legacy-order-42' },
  },
});
const importedReducedEvidence = Schema.decodeUnknownSync(InventoryCommittedObligationStateEvidenceSchema)({
  ...reducedEvidence,
  obligationRef: importedObligation.ref,
  ownerEvidenceRef: 'inventory:obligation-reduction:legacy-issue-42',
});

const exactCommitTransition = {
  transition: (
    candidate: ProvisionalInventoryReservation,
    observation: typeof RuntimeOrderCommitProofObservationSchema.Type,
  ) =>
    Effect.succeed(
      Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
        ...candidate,
        confirmationTerminationReleasesStock: false,
        historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        obligationReductionCreatesOnHand: false,
        orderProof: {
          ...observation,
          authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
          commitStatus: 'COMMITTED',
        },
        physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
        remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
      }),
    ),
};

describe('Inventory post-commit Reservation reconciliation', () => {
  it.effect(
    'transitions the same Reservation identity after proven commit without creating a duplicate obligation',
    () =>
      Effect.gen(function* recoverMissingCommit() {
        let commitCalls = 0;
        const service = makeInventoryPostCommitReservationReconciliationService({
          commitTransition: exactCommitTransition,
          obligationStore: {
            commitReservation: (obligation) => {
              commitCalls += 1;
              return Effect.succeed({ obligation, outcome: 'COMMITTED' as const });
            },
            read: () => Effect.succeed(Option.some(reservation)),
          },
          physicalEffectReader: { read: () => Effect.succeed(Option.none()) },
          reductionWriter: { reduceAfterAppliedIssue: () => Effect.die('not exercised') },
        });

        const result = yield* service.recoverCommitTransition(proofObservation);

        expect(commitCalls).toBe(1);
        expect(result).toMatchObject({
          duplicateObligationCreated: false,
          orderRolledBack: false,
          outcome: 'COMMITTED',
        });
        expect(result.obligation.ref).toEqual(reservation.ref);
        expect(result.obligation.authority).toEqual(reservation.authority);
        expect(result.obligation.requirements).toEqual(reservation.requirements);
        expect(result.obligation.confirmationTerminationReleasesStock).toBe(false);
      }),
  );

  it.effect('returns an exact replay for the already committed identity without another write', () =>
    Effect.gen(function* replayCommitted() {
      let commitCalls = 0;
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => {
            commitCalls += 1;
            return Effect.die('must not rewrite an already committed obligation');
          },
          read: () => Effect.succeed(Option.some(committed)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.none()) },
        reductionWriter: { reduceAfterAppliedIssue: () => Effect.die('not exercised') },
      });

      const result = yield* service.recoverCommitTransition(proofObservation);

      expect(result.outcome).toBe('EXACT_REPLAY');
      expect(result.obligation).toEqual(committed);
      expect(commitCalls).toBe(0);
    }),
  );

  it.effect('repairs only the missing obligation reduction after a proven Issue', () =>
    Effect.gen(function* recoverReduction() {
      let reductions = 0;
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('not exercised'),
          read: () => Effect.succeed(Option.some(committed)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.some(appliedIssue)) },
        reductionWriter: {
          reduceAfterAppliedIssue: (request) => {
            reductions += 1;
            expect(request.issue).toEqual(appliedIssue);
            expect(request.obligation.ref).toEqual(reservation.ref);
            expect(request.allocation.allocationId).toBe('allocation-1');
            return Effect.succeed({ evidence: reducedEvidence, outcome: 'REDUCED' as const });
          },
        },
      });

      const result = yield* service.recoverObligationReduction(
        Schema.decodeUnknownSync(InventoryPostCommitReductionRequestSchema)({
          allocationId: requirement.allocations[0]?.allocationId,
          issueEffectId: appliedIssue.request.effectId,
          obligationRef: reservation.ref,
          purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
        }),
      );

      expect(reductions).toBe(1);
      expect(result).toMatchObject({
        obligationReduction: { evidence: reducedEvidence, outcome: 'REDUCED' },
        orderRolledBack: false,
        physicalEffectExecuted: false,
      });
    }),
  );

  it.effect('fails closed when the proven Issue is not exact-bound to the historical allocation', () =>
    Effect.gen(function* rejectMismatchedIssue() {
      const mismatchedIssue = Schema.decodeUnknownSync(AppliedPhysicalStockEffectSchema)({
        ...appliedIssue,
        evidence: { ...appliedIssue.evidence, positionRef: { ...positionRef, resourceId: replacementItemId } },
      });
      let reductions = 0;
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('not exercised'),
          read: () => Effect.succeed(Option.some(committed)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.some(mismatchedIssue)) },
        reductionWriter: {
          reduceAfterAppliedIssue: () => {
            reductions += 1;
            return Effect.die('mismatched Issue must not reduce the obligation');
          },
        },
      });

      const failure = yield* service
        .recoverObligationReduction(
          Schema.decodeUnknownSync(InventoryPostCommitReductionRequestSchema)({
            allocationId: requirement.allocations[0]?.allocationId,
            issueEffectId: appliedIssue.request.effectId,
            obligationRef: reservation.ref,
            purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'PHYSICAL_ISSUE_SCOPE_MISMATCH' });
      expect(reductions).toBe(0);
    }),
  );

  it.effect('rejects an applied non-fulfillment Issue before invoking obligation reduction', () =>
    Effect.gen(function* rejectNonFulfillmentIssue() {
      const correctionIssue = Schema.decodeUnknownSync(AppliedPhysicalStockEffectSchema)({
        ...appliedIssue,
        evidence: {
          ...appliedIssue.evidence,
          backendEvidenceRef: 'erp-primary:issue:correction-1',
          effectId: '20202020-2020-4020-8020-202020202020',
        },
        request: {
          ...appliedIssue.request,
          effectId: '20202020-2020-4020-8020-202020202020',
          reason: { code: 'STOCK_CORRECTION', reference: committed.orderProof.acceptedOrderId },
        },
      });
      let reductions = 0;
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('not exercised'),
          read: () => Effect.succeed(Option.some(committed)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.some(correctionIssue)) },
        reductionWriter: {
          reduceAfterAppliedIssue: () => {
            reductions += 1;
            return Effect.die('non-fulfillment Issue must not reduce a committed Order obligation');
          },
        },
      });

      const failure = yield* service
        .recoverObligationReduction(
          Schema.decodeUnknownSync(InventoryPostCommitReductionRequestSchema)({
            allocationId: requirement.allocations[0]?.allocationId,
            issueEffectId: correctionIssue.request.effectId,
            obligationRef: reservation.ref,
            purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'PHYSICAL_ISSUE_SCOPE_MISMATCH' });
      expect(reductions).toBe(0);
    }),
  );

  it.effect('uses the same exact post-commit reduction model for an imported committed obligation', () =>
    Effect.gen(function* reconcileImported() {
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('not exercised'),
          read: () => Effect.succeed(Option.some(importedObligation)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.some(importedIssue)) },
        reductionWriter: {
          reduceAfterAppliedIssue: () =>
            Effect.succeed({ evidence: importedReducedEvidence, outcome: 'EXACT_REPLAY' as const }),
        },
      });

      const result = yield* service.recoverObligationReduction(
        Schema.decodeUnknownSync(InventoryPostCommitReductionRequestSchema)({
          allocationId: requirement.allocations[0]?.allocationId,
          issueEffectId: importedIssue.request.effectId,
          obligationRef: importedObligation.ref,
          purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
        }),
      );

      expect(result.obligationReduction).toEqual({
        evidence: importedReducedEvidence,
        outcome: 'EXACT_REPLAY',
      });
      expect(result.orderRolledBack).toBe(false);
      expect(result.physicalEffectExecuted).toBe(false);
    }),
  );

  it.effect('preserves historical Stock Item X and records a post-commit exception when Current resolves to Y', () =>
    Effect.gen(function* preserveHistoricalBinding() {
      const currentBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        bindingRef,
        catalogSelection: selection,
        effectiveFrom: '2026-09-24T12:00:00.000Z',
        exactSelectionMeaning,
        revision: 2,
        stockItemRef: replacementItemRef,
        unitRef,
      });
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('not exercised'),
          read: () => Effect.succeed(Option.some(committed)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.none()) },
        reductionWriter: { reduceAfterAppliedIssue: () => Effect.die('not exercised') },
      });

      const result = yield* service.assessCurrentBinding({
        currentBinding,
        obligation: committed,
        purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
      });

      expect(result).toMatchObject({
        currentStockItemRef: replacementItemRef,
        exception: 'POST_COMMIT_BINDING_MISMATCH',
        historicalStockItemRef: itemRef,
        orderRolledBack: false,
        replacementObligationCreated: false,
        retargeted: false,
      });
      expect(result.obligation).toEqual(committed);
      expect(result.obligation.requirements[0]?.stockItem.stockItemRef).toEqual(itemRef);
    }),
  );

  it.effect('rejects another Order proof for an already committed Reservation', () =>
    Effect.gen(function* rejectAnotherOrder() {
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('must not rewrite committed truth'),
          read: () => Effect.succeed(Option.some(committed)),
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.none()) },
        reductionWriter: { reduceAfterAppliedIssue: () => Effect.die('not exercised') },
      });

      const failure = yield* service
        .recoverCommitTransition(
          Schema.decodeUnknownSync(RuntimeOrderCommitProofObservationSchema)({
            ...proofObservation,
            acceptedOrderId: 'accepted-order-2',
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'ORDER_COMMIT_PROOF_MISMATCH' });
    }),
  );

  it.effect('rejects a foreign Tenant before reading owner state', () =>
    Effect.gen(function* rejectForeignTenant() {
      let reads = 0;
      const service = makeInventoryPostCommitReservationReconciliationService({
        commitTransition: exactCommitTransition,
        obligationStore: {
          commitReservation: () => Effect.die('not exercised'),
          read: () => {
            reads += 1;
            return Effect.succeed(Option.some(committed));
          },
        },
        physicalEffectReader: { read: () => Effect.succeed(Option.none()) },
        reductionWriter: { reduceAfterAppliedIssue: () => Effect.die('not exercised') },
      });
      const foreignRef = Schema.decodeUnknownSync(InventoryReservationRefSchema)({
        ...reservation.ref,
        tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });

      const failure = yield* service
        .recoverCommitTransition(
          Schema.decodeUnknownSync(RuntimeOrderCommitProofObservationSchema)({
            ...proofObservation,
            reservationRef: foreignRef,
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH' });
      expect(reads).toBe(0);
    }),
  );
});
