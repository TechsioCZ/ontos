import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CompileInventoryHistoricalEvidenceInputSchema,
  InventoryHistoricalEvidenceRejected,
  compileInventoryHistoricalEvidence,
} from '../../shared/domain/inventory-audit-and-historical-evidence.ts';
import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventoryEffectLedgerRecordSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import {
  ImportedCommittedObligationSchema,
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const confirmationOneId = '33333333-3333-4333-8333-333333333333';
const confirmationTwoId = '34333333-3333-4333-8333-333333333333';
const itemXId = '44444444-4444-4444-8444-444444444444';
const itemYId = '45444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionOneId = '66666666-6666-4666-8666-666666666666';
const positionTwoId = '67666666-6666-4666-8666-666666666666';
const externalConfigurationId = '77777777-7777-4777-8777-777777777777';
const wmsConfigurationId = '78777777-7777-4777-8777-777777777777';
const bindingId = '88888888-8888-4888-8888-888888888888';
const attemptId = 'attempt-checkout-1';
const customerConfigurationId = 'customer-configuration-primary';
const issuedAt = '2026-09-25T10:00:00.000Z';
const expiresAt = '2026-09-25T11:00:00.000Z';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const ref = <ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.inventory' as const,
  resourceId,
  resourceType,
  tenantId,
});
const itemXRef = ref(itemXId, 'commerce.inventory.stock-item' as const);
const itemYRef = ref(itemYId, 'commerce.inventory.stock-item' as const);
const positionOneRef = ref(positionOneId, 'commerce.inventory.stock-position' as const);
const positionTwoRef = ref(positionTwoId, 'commerce.inventory.stock-position' as const);
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const catalogSelection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;

const configuration = (
  configurationId: string,
  backend: 'external_business_system' | 'ontos_wms',
  backendId: string,
  selectedAt: string,
) =>
  Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId,
    customerConfigurationId,
    revision: 1,
    selectedAt,
    selection: {
      backend,
      backendId,
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
    },
    tenantId,
  });

const externalAuthority = configuration(
  externalConfigurationId,
  'external_business_system',
  'erp-primary',
  '2026-09-25T09:00:00.000Z',
);
const wmsAuthority = configuration(wmsConfigurationId, 'ontos_wms', 'ontos-wms-primary', '2026-09-25T12:00:00.000Z');

const stockItem = (stockItemRef: typeof itemXRef) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: '2026-09-25T08:00:00.000Z',
    exactSelectionMeaning,
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef,
    unitRef,
  });

const acceptedBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: ref(bindingId, 'commerce.inventory.catalog-to-stock-binding'),
  catalogSelection,
  effectiveFrom: '2026-09-25T08:30:00.000Z',
  exactSelectionMeaning,
  revision: 1,
  stockItemRef: itemXRef,
  unitRef,
});

const allocation = (allocationId: string, positionRef: typeof positionOneRef, amount: string) => ({
  allocationId,
  positionRef,
  quantity: { amount, unitRef },
  stockItemRef: itemXRef,
});

const subjectReservation = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
  authority: externalAuthority,
  establishedAt: issuedAt,
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
  origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
  ref: ref(reservationId, 'commerce.inventory.inventory-reservation'),
  requirements: [
    {
      allocations: [allocation('allocation-p1', positionOneRef, '4'), allocation('allocation-p2', positionTwoRef, '6')],
      bindingRef: acceptedBinding.bindingRef,
      catalogSelection,
      exactSelectionMeaning,
      purchaseDemandOccurrenceId: 'demand-occurrence-1',
      quantity: '10',
      stockItem: stockItem(itemXRef),
      unitRef,
    },
  ],
});

const confirmation = (input: {
  readonly confirmationId: string;
  readonly health?: 'VALID' | 'AT_RISK';
  readonly issuedAt: string;
  readonly reservation?: typeof subjectReservation;
  readonly revision?: number;
}) => {
  const reservation = input.reservation ?? subjectReservation;
  const health = input.health ?? 'VALID';
  const ownerEvidenceRef = `owner-proof:${input.confirmationId}`;
  return Schema.decodeUnknownSync(ReservationConfirmationSchema)({
    authorityEvidence: {
      effectId: `effect:${input.confirmationId}`,
      evidence: {
        allocations: reservation.requirements.flatMap(({ allocations }) =>
          allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
            allocationId,
            quantity,
            stockItemRef,
            stockPositionRef: positionRef,
          })),
        ),
        attemptId: reservation.origin.attemptId,
        customerConfigurationId,
        ownerEvidenceRef,
        reservationId: reservation.ref.resourceId,
        tenantId,
        validFrom: input.issuedAt,
        validUntil: expiresAt,
      },
      issuer: { backend: 'external_business_system', backendId: 'erp-primary', origin: 'EXTERNAL_BUSINESS_SYSTEM' },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    },
    expiresAt,
    health:
      health === 'VALID'
        ? { observation: { _tag: 'ISSUED', effectiveAt: input.issuedAt, ownerEvidenceRef }, state: 'VALID' }
        : {
            observation: {
              _tag: 'MATERIAL_IMPAIRMENT',
              effectiveAt: '2026-09-25T10:15:00.000Z',
              ownerEvidenceRef: 'owner-proof:impairment',
            },
            state: 'AT_RISK',
          },
    issuanceRank: { issuedAt: input.issuedAt, ownerEvidenceRef, source: 'RESERVATION_AUTHORITY_EVIDENCE' },
    issuedAt: input.issuedAt,
    ref: ref(input.confirmationId, 'commerce.inventory.reservation-confirmation'),
    reservation,
    revision: input.revision ?? (health === 'VALID' ? 1 : 2),
  });
};

const firstConfirmation = confirmation({ confirmationId: confirmationOneId, issuedAt });

const correctedBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  ...acceptedBinding,
  effectiveFrom: '2026-09-25T10:30:00.000Z',
  revision: 2,
  stockItemRef: itemYRef,
});

const validInput = () =>
  Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
    actorContext: {
      actorId: 'inventory-operator-1',
      authorizationEvidenceRef: 'authorization-proof-1',
      permission: 'inventory.audit.read',
      policyEvidenceRef: 'policy-proof-1',
      principalId: 'principal-1',
    },
    assembledAt: '2026-09-25T12:30:00.000Z',
    backendTransitions: [
      {
        effectiveBoundary: '2026-09-25T12:00:00.000Z',
        ownerEvidenceRef: 'cutover-proof-1',
        postCutoverConfiguration: wmsAuthority,
        preCutoverConfiguration: externalAuthority,
        purpose: 'PLANNED_BACKEND_REPLACEMENT_NOT_OUTAGE_RECOVERY',
      },
    ],
    committedLineage: [],
    confirmationHistory: [firstConfirmation],
    reconciliationIntervals: [],
    relatedEvidence: [],
    requirementEvidence: [
      {
        acceptedBinding,
        allocations: subjectReservation.requirements[0]?.allocations,
        currentCorrection: {
          currentBinding: correctedBinding,
          historyEntry: {
            binding: acceptedBinding,
            endedAt: correctedBinding.effectiveFrom,
            ownerEvidenceRef: 'binding-correction-proof-1',
            transition: 'CORRECTED',
          },
        },
        purchaseDemandOccurrenceId: 'demand-occurrence-1',
        quantity: '10',
        unitRef,
      },
    ],
    reservation: subjectReservation,
    shortageDecisions: [],
  });

const priorityHistoryInput = () => {
  const secondReservation = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
    ...subjectReservation,
    origin: { attemptId: 'attempt-checkout-2', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: ref('23222222-2222-4222-8222-222222222222', 'commerce.inventory.inventory-reservation'),
  });
  const second = confirmation({
    confirmationId: confirmationTwoId,
    issuedAt: '2026-09-25T10:05:00.000Z',
    reservation: secondReservation,
  });
  return Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
    ...validInput(),
    confirmationHistory: [firstConfirmation, second],
    shortageDecisions: [
      {
        decidedAt: '2026-09-25T10:10:00.000Z',
        evaluation: {
          _tag: 'DETERMINATE',
          affectedPositionRef: positionOneRef,
          decisions: [
            {
              affectedQuantity: { amount: '4', unitRef },
              capacity: 'HONORABLE',
              confirmationRef: firstConfirmation.ref,
              currentHealth: 'VALID',
              issuanceRank: firstConfirmation.issuanceRank,
            },
            {
              affectedQuantity: { amount: '4', unitRef },
              capacity: 'SHORTAGE',
              confirmationRef: second.ref,
              currentHealth: 'VALID',
              issuanceRank: second.issuanceRank,
            },
          ],
          fencedAmount: '0',
        },
        input: {
          affectedPositionRef: positionOneRef,
          availableQuantity: { amount: '4', unitRef },
          candidates: [
            {
              allocations: firstConfirmation.reservation.requirements.flatMap(({ allocations }) => allocations),
              confirmation: firstConfirmation,
              poolBoundary: 'NONE',
            },
            {
              allocations: second.reservation.requirements.flatMap(({ allocations }) => allocations),
              confirmation: second,
              poolBoundary: 'NONE',
            },
          ],
        },
      },
    ],
  });
};

describe('Inventory audit and historical evidence', () => {
  it.effect('preserves exact demand meaning and P1/P2 allocations after a later binding correction', () =>
    Effect.gen(function* preserveDemandAndAllocation() {
      const packet = yield* compileInventoryHistoricalEvidence(validInput());
      const [requirement] = packet.requirementEvidence;

      expect(requirement).toMatchObject({
        acceptedBinding: { stockItemRef: { resourceId: itemXId } },
        allocations: [
          { positionRef: { resourceId: positionOneId }, quantity: { amount: '4' } },
          { positionRef: { resourceId: positionTwoId }, quantity: { amount: '6' } },
        ],
        currentCorrection: { currentBinding: { stockItemRef: { resourceId: itemYId } } },
        quantity: '10',
      });
      expect(packet.historicalAllocationSubstitutionApplied).toBe(false);
    }),
  );

  it.effect('explains shortage priority from authoritative C1-before-C2 issuance rank', () =>
    Effect.gen(function* preservePriority() {
      const packet = yield* compileInventoryHistoricalEvidence(priorityHistoryInput());

      const evaluation = packet.shortageDecisions[0]?.evaluation;
      expect(evaluation).toBeDefined();
      if (evaluation !== undefined) {
        const determinate = Match.value(evaluation).pipe(
          Match.tag('DETERMINATE', ({ decisions }) => {
            expect(decisions.map(({ confirmationRef }) => confirmationRef.resourceId)).toEqual([
              confirmationOneId,
              confirmationTwoId,
            ]);
            expect(decisions[0]?.issuanceRank.issuedAt).toBe(issuedAt);
            return true;
          }),
          Match.tag('INDETERMINATE', () => {
            expect.fail('expected determinate historical shortage evidence');
            return false;
          }),
          Match.exhaustive,
        );
        expect(determinate).toBe(true);
      }
    }),
  );

  it.effect('keeps the external historical Reservation authority after migration selects WMS', () =>
    Effect.gen(function* preserveHistoricalAuthority() {
      const packet = yield* compileInventoryHistoricalEvidence(validInput());

      expect(packet.historicalAuthority.selection).toMatchObject({
        backend: 'external_business_system',
        backendId: 'erp-primary',
      });
      expect(packet.currentAuthority.selection).toMatchObject({ backend: 'ontos_wms', backendId: 'ontos-wms-primary' });
      expect(packet.authorityRewriteApplied).toBe(false);
    }),
  );

  it.effect('preserves the original issuance rank through AT_RISK and recovery of the same Confirmation', () =>
    Effect.gen(function* preserveRankThroughRecovery() {
      const atRisk = confirmation({
        confirmationId: confirmationOneId,
        health: 'AT_RISK',
        issuedAt,
        revision: 2,
      });
      const recovered = Schema.decodeUnknownSync(ReservationConfirmationSchema)({
        ...atRisk,
        health: {
          observation: {
            _tag: 'OWNER_HEALTHY',
            effectiveAt: '2026-09-25T10:20:00.000Z',
            ownerEvidenceRef: 'owner-proof:recovered',
          },
          state: 'VALID',
        },
        revision: 3,
      });
      const packet = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        confirmationHistory: [firstConfirmation, atRisk, recovered],
      });

      expect(packet.confirmationHistory.map(({ issuanceRank }) => issuanceRank)).toEqual([
        firstConfirmation.issuanceRank,
        firstConfirmation.issuanceRank,
        firstConfirmation.issuanceRank,
      ]);
    }),
  );

  it.effect('rejects a later Current Position substituted into historical allocations', () =>
    Effect.gen(function* rejectPositionSubstitution() {
      const input = validInput();
      const [requirement] = input.requirementEvidence;
      const failure = yield* compileInventoryHistoricalEvidence({
        ...input,
        requirementEvidence:
          requirement === undefined
            ? []
            : [
                {
                  ...requirement,
                  allocations: requirement.allocations.map((entry, index) =>
                    index === 0
                      ? {
                          ...entry,
                          positionRef: ref('69666666-6666-4666-8666-666666666666', entry.positionRef.resourceType),
                        }
                      : entry,
                  ),
                },
              ],
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(InventoryHistoricalEvidenceRejected);
      expect(failure.reason).toBe('REQUIREMENT_EVIDENCE_MISMATCH');
    }),
  );

  it.effect('rejects rewritten Confirmation issuance rank and fabricated recovery priority', () =>
    Effect.gen(function* rejectRankRewrite() {
      const atRisk = confirmation({
        confirmationId: confirmationOneId,
        health: 'AT_RISK',
        issuedAt,
        revision: 2,
      });
      const forgedRecovery = Schema.decodeUnknownSync(ReservationConfirmationSchema)({
        ...atRisk,
        authorityEvidence: {
          ...atRisk.authorityEvidence,
          evidence: {
            ...atRisk.authorityEvidence.evidence,
            ownerEvidenceRef: 'owner-proof:fabricated-rank',
            validFrom: '2026-09-25T10:20:00.000Z',
          },
        },
        health: {
          observation: {
            _tag: 'OWNER_HEALTHY',
            effectiveAt: '2026-09-25T10:20:00.000Z',
            ownerEvidenceRef: 'owner-proof:recovered',
          },
          state: 'VALID',
        },
        issuanceRank: {
          issuedAt: '2026-09-25T10:20:00.000Z',
          ownerEvidenceRef: 'owner-proof:fabricated-rank',
          source: 'RESERVATION_AUTHORITY_EVIDENCE',
        },
        issuedAt: '2026-09-25T10:20:00.000Z',
        revision: 3,
      });
      const failure = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        confirmationHistory: [firstConfirmation, atRisk, forgedRecovery],
      }).pipe(Effect.flip);

      expect(failure.reason).toBe('CONFIRMATION_RANK_REWRITTEN');
    }),
  );

  it.effect('rejects accepted and correction binding evidence with changed Selection provenance', () =>
    Effect.gen(function* rejectSelectionRewrite() {
      const input = validInput();
      const [requirement] = input.requirementEvidence;
      expect(requirement).toBeDefined();
      if (requirement === undefined || requirement.currentCorrection === undefined) {
        return;
      }
      const changedSelection = {
        ...catalogSelection,
        variantRef: { ...catalogSelection.variantRef, resourceId: 'abababab-abab-4bab-8bab-abababababab' },
      };
      const changedAcceptedBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...requirement.acceptedBinding,
        catalogSelection: changedSelection,
      });
      const acceptedFailure = yield* compileInventoryHistoricalEvidence({
        ...input,
        requirementEvidence: [{ ...requirement, acceptedBinding: changedAcceptedBinding }],
      }).pipe(Effect.flip);
      const changedCurrentBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...correctedBinding,
        catalogSelection: changedSelection,
      });
      const correctionFailure = yield* compileInventoryHistoricalEvidence({
        ...input,
        requirementEvidence: [
          {
            ...requirement,
            currentCorrection: {
              currentBinding: changedCurrentBinding,
              historyEntry: requirement.currentCorrection.historyEntry,
            },
          },
        ],
      }).pipe(Effect.flip);

      expect(acceptedFailure.reason).toBe('REQUIREMENT_EVIDENCE_MISMATCH');
      expect(correctionFailure.reason).toBe('BINDING_CORRECTION_MISMATCH');
    }),
  );

  it.effect('rejects shortage evidence with reversed decisions or forged capacity', () =>
    Effect.gen(function* rejectForgedShortage() {
      const input = priorityHistoryInput();
      const [shortage] = input.shortageDecisions;
      expect(shortage).toBeDefined();
      if (shortage === undefined) {
        return;
      }
      const determinate = Match.value(shortage.evaluation).pipe(
        Match.tag('DETERMINATE', (evaluation) => evaluation),
        Match.tag('INDETERMINATE', () => null),
        Match.exhaustive,
      );
      expect(determinate).not.toBeNull();
      if (determinate === null) {
        return;
      }
      const [olderDecision, youngerDecision] = determinate.decisions;
      expect(olderDecision).toBeDefined();
      expect(youngerDecision).toBeDefined();
      if (olderDecision === undefined || youngerDecision === undefined) {
        return;
      }
      const reversedFailure = yield* compileInventoryHistoricalEvidence({
        ...input,
        shortageDecisions: [
          {
            ...shortage,
            evaluation: { ...determinate, decisions: [youngerDecision, olderDecision] },
          },
        ],
      }).pipe(Effect.flip);
      const forgedCapacity = determinate.decisions.map((decision, index) =>
        index === 1 ? { ...decision, capacity: 'HONORABLE' as const } : decision,
      );
      const capacityFailure = yield* compileInventoryHistoricalEvidence({
        ...input,
        shortageDecisions: [{ ...shortage, evaluation: { ...determinate, decisions: forgedCapacity } }],
      }).pipe(Effect.flip);

      expect(reversedFailure.reason).toBe('SHORTAGE_RANK_MISMATCH');
      expect(capacityFailure.reason).toBe('SHORTAGE_RANK_MISMATCH');
    }),
  );

  it.effect('accepts UNVERIFIABLE recovery without changing identity or issuance rank', () =>
    Effect.gen(function* preserveUnverifiableRecovery() {
      const unverifiable = Schema.decodeUnknownSync(ReservationConfirmationSchema)({
        ...firstConfirmation,
        health: {
          observation: {
            _tag: 'OWNER_UNVERIFIABLE',
            effectiveAt: '2026-09-25T10:15:00.000Z',
            reason: 'OWNER_EVIDENCE_UNAVAILABLE',
          },
          state: 'UNVERIFIABLE',
        },
        revision: 2,
      });
      const recovered = Schema.decodeUnknownSync(ReservationConfirmationSchema)({
        ...unverifiable,
        health: {
          observation: {
            _tag: 'OWNER_HEALTHY',
            effectiveAt: '2026-09-25T10:20:00.000Z',
            ownerEvidenceRef: 'owner-proof:recovered-from-unverifiable',
          },
          state: 'VALID',
        },
        revision: 3,
      });
      const packet = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        confirmationHistory: [firstConfirmation, unverifiable, recovered],
      });

      expect(packet.confirmationHistory.at(-1)).toMatchObject({
        health: { state: 'VALID' },
        issuanceRank: firstConfirmation.issuanceRank,
        ref: firstConfirmation.ref,
      });
    }),
  );

  it.effect('rejects a Confirmation revision gap even when each snapshot is individually valid', () =>
    Effect.gen(function* rejectRevisionGap() {
      const atRiskWithGap = confirmation({
        confirmationId: confirmationOneId,
        health: 'AT_RISK',
        issuedAt,
        revision: 3,
      });
      const failure = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        confirmationHistory: [firstConfirmation, atRiskWithGap],
      }).pipe(Effect.flip);

      expect(failure.reason).toBe('CONFIRMATION_HISTORY_INVALID');
    }),
  );

  it.effect('rejects a backend cutover before Reservation establishment or outside the exact authority root', () =>
    Effect.gen(function* rejectInvalidCutoverChronology() {
      const earlyWms = configuration(wmsConfigurationId, 'ontos_wms', 'ontos-wms-primary', '2026-09-25T09:30:00.000Z');
      const failure = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        backendTransitions: [
          {
            effectiveBoundary: '2026-09-25T09:30:00.000Z',
            ownerEvidenceRef: 'invalid-early-cutover',
            postCutoverConfiguration: earlyWms,
            preCutoverConfiguration: externalAuthority,
            purpose: 'PLANNED_BACKEND_REPLACEMENT_NOT_OUTAGE_RECOVERY',
          },
        ],
      }).pipe(Effect.flip);
      const lateRoot = configuration(
        externalConfigurationId,
        'external_business_system',
        'erp-primary',
        '2026-09-25T10:05:00.000Z',
      );
      const lateRootFailure = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        backendTransitions: [],
        confirmationHistory: [],
        reservation: { ...subjectReservation, authority: lateRoot },
      }).pipe(Effect.flip);

      expect(failure.reason).toBe('BACKEND_LINEAGE_MISMATCH');
      expect(lateRootFailure.reason).toBe('BACKEND_LINEAGE_MISMATCH');
    }),
  );

  it.effect('preserves runtime and imported committed-obligation lineage without fabricating an Attempt', () =>
    Effect.gen(function* preserveCommittedLineage() {
      const runtime = Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
        authority: externalAuthority,
        confirmationTerminationReleasesStock: false,
        establishedAt: issuedAt,
        historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        obligationReductionCreatesOnHand: false,
        orderProof: {
          acceptedOrderId: 'accepted-order-runtime-1',
          attemptId,
          authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
          commitStatus: 'COMMITTED',
          evidenceRef: 'order-commit-proof-runtime-1',
          observedAt: '2026-09-25T10:25:00.000Z',
          reservationRef: subjectReservation.ref,
          tenantId,
        },
        origin: subjectReservation.origin,
        physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
        ref: subjectReservation.ref,
        remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
        requirements: subjectReservation.requirements,
      });
      const imported = Schema.decodeUnknownSync(ImportedCommittedObligationSchema)({
        authority: externalAuthority,
        importedAt: '2026-09-25T10:30:00.000Z',
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        orderProof: {
          acceptedOrderId: 'accepted-order-imported-1',
          authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
          commitStatus: 'COMMITTED',
          evidenceRef: 'order-migration-proof-1',
          observedAt: '2026-09-25T10:29:00.000Z',
          sourceOrderId: 'source-order-1',
          sourceSystem: 'legacy-order-system',
        },
        origin: {
          kind: 'IMPORTED_PROVEN_ORDER',
          sourceObligationId: 'source-obligation-1',
          sourceOrderId: 'source-order-1',
          sourceSystem: 'legacy-order-system',
        },
        ref: ref('b2222222-2222-4222-8222-222222222222', 'commerce.inventory.imported-committed-obligation'),
        requirements: subjectReservation.requirements,
        runtimeAttemptId: null,
      });
      const packet = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        committedLineage: [
          { _tag: 'RUNTIME_COMMITTED', obligation: runtime },
          { _tag: 'IMPORTED_COMMITTED', obligation: imported },
        ],
      });

      expect(packet.committedLineage).toHaveLength(2);
      const [, importedLineage] = packet.committedLineage;
      expect(importedLineage).toBeDefined();
      if (importedLineage !== undefined) {
        const importedSourceOrderId = Match.value(importedLineage).pipe(
          Match.tag('IMPORTED_COMMITTED', ({ obligation }) => obligation.origin.sourceOrderId),
          Match.tag('RUNTIME_COMMITTED', () => null),
          Match.exhaustive,
        );
        expect(importedSourceOrderId).toBe('source-order-1');
      }

      const mismatchedImported = Schema.decodeUnknownSync(ImportedCommittedObligationSchema)({
        ...imported,
        orderProof: { ...imported.orderProof, sourceOrderId: 'different-source-order' },
      });
      const mismatchFailure = yield* compileInventoryHistoricalEvidence({
        ...validInput(),
        committedLineage: [{ _tag: 'IMPORTED_COMMITTED', obligation: mismatchedImported }],
      }).pipe(Effect.flip);
      expect(mismatchFailure.reason).toBe('COMMITTED_LINEAGE_MISMATCH');
    }),
  );

  it.effect('binds physical and ledger evidence to exact allocation scope and an open reconciliation interval', () =>
    Effect.gen(function* preserveRelatedEvidence() {
      const effectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const stockLocationRef = ref('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'commerce.inventory.stock-location');
      const fullRequest = {
        actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        backend: 'external_business_system' as const,
        backendConfigurationRef: ref(externalConfigurationId, 'commerce.inventory.inventory-backend-configuration'),
        backendId: 'erp-primary',
        customerConfigurationId,
        effectId,
        kind: 'ISSUE' as const,
        legalEntityId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        positionRef: positionOneRef,
        quantity: { amount: '4', unitRef },
        reason: { code: 'ORDER_FULFILLMENT', reference: 'order-1' },
        requestedAt: '2026-09-25T10:35:00.000Z',
        stockItemRef: itemXRef,
        stockLocationRef,
      };
      const physical = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        _tag: 'INDETERMINATE',
        reason: 'BACKEND_OUTCOME_UNKNOWN',
        request: fullRequest,
      });
      const ledger = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
        currentState: 'INDETERMINATE',
        effectId,
        intent: {
          _tag: 'PHYSICAL_ISSUE',
          request: fullRequest,
        },
        requestedAt: fullRequest.requestedAt,
        resolution: null,
        revision: 2,
        tenantId,
        updatedAt: '2026-09-25T10:36:00.000Z',
      });
      const correlation = {
        allocationIds: ['allocation-p1'],
        attemptId,
        authority: externalAuthority,
        effectId,
        positionRefs: [positionOneRef],
        reservationRef: subjectReservation.ref,
      } as const;
      const packet = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          reconciliationIntervals: [
            {
              attemptId,
              effectId,
              finalResolution: null,
              indeterminateFrom: '2026-09-25T10:36:00.000Z',
              possiblePartialEffectIds: [effectId],
            },
          ],
          relatedEvidence: [
            { _tag: 'PHYSICAL_STOCK_EFFECT', correlation, value: physical },
            { _tag: 'EFFECT_LEDGER', correlation, value: ledger },
          ],
        }),
      );

      expect(packet.relatedEvidence).toHaveLength(2);
      expect(packet.reconciliationIntervals[0]).toMatchObject({
        finalResolution: null,
        possiblePartialEffectIds: [effectId],
      });

      const appliedPhysical = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        _tag: 'APPLIED',
        evidence: {
          appliedAt: '2026-09-25T10:40:00.000Z',
          backend: 'external_business_system',
          backendConfigurationRef: fullRequest.backendConfigurationRef,
          backendEvidenceRef: 'backend-applied-effect-proof-1',
          backendId: 'erp-primary',
          effectId,
          issuer: 'erp-primary',
          kind: 'ISSUE',
          positionRef: positionOneRef,
          quantity: { amount: '4', unitRef },
        },
        request: fullRequest,
      });
      const resolvedLedger = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
        ...ledger,
        currentState: 'SUCCEEDED',
        resolution: { _tag: 'PHYSICAL_ISSUE', effect: appliedPhysical },
        revision: 3,
        updatedAt: '2026-09-25T10:40:00.000Z',
      });
      const resolvedPacket = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          reconciliationIntervals: [
            {
              attemptId,
              effectId,
              finalResolution: {
                ownerEvidenceRef: 'backend-applied-effect-proof-1',
                resolvedAt: '2026-09-25T10:40:00.000Z',
                state: 'SUCCEEDED',
              },
              indeterminateFrom: '2026-09-25T10:36:00.000Z',
              possiblePartialEffectIds: [effectId],
            },
          ],
          relatedEvidence: [{ _tag: 'EFFECT_LEDGER', correlation, value: resolvedLedger }],
        }),
      );

      expect(resolvedPacket.reconciliationIntervals[0]?.finalResolution).toMatchObject({ state: 'SUCCEEDED' });

      const unboundPartialFailure = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          reconciliationIntervals: [
            {
              attemptId,
              effectId,
              finalResolution: null,
              indeterminateFrom: '2026-09-25T10:36:00.000Z',
              possiblePartialEffectIds: ['abababab-abab-4bab-8bab-abababababab'],
            },
          ],
          relatedEvidence: [{ _tag: 'EFFECT_LEDGER', correlation, value: ledger }],
        }),
      ).pipe(Effect.flip);
      expect(unboundPartialFailure.reason).toBe('RECONCILIATION_LINEAGE_MISMATCH');
    }),
  );

  it.effect('rejects related evidence correlated to the wrong allocation and Position pair', () =>
    Effect.gen(function* rejectWrongEvidenceCorrelation() {
      const effectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const physical = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        _tag: 'REQUESTED',
        request: {
          actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          backend: 'external_business_system',
          backendConfigurationRef: ref(externalConfigurationId, 'commerce.inventory.inventory-backend-configuration'),
          backendId: 'erp-primary',
          customerConfigurationId,
          effectId,
          kind: 'ISSUE',
          legalEntityId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          positionRef: positionOneRef,
          quantity: { amount: '4', unitRef },
          reason: { code: 'ORDER_FULFILLMENT', reference: 'order-1' },
          requestedAt: '2026-09-25T10:35:00.000Z',
          stockItemRef: itemXRef,
          stockLocationRef: ref('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'commerce.inventory.stock-location'),
        },
      });
      const failure = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          relatedEvidence: [
            {
              _tag: 'PHYSICAL_STOCK_EFFECT',
              correlation: {
                allocationIds: ['allocation-p2'],
                attemptId,
                authority: externalAuthority,
                effectId,
                positionRefs: [positionOneRef],
                reservationRef: subjectReservation.ref,
              },
              value: physical,
            },
          ],
        }),
      ).pipe(Effect.flip);

      expect(failure.reason).toBe('RELATED_EVIDENCE_SCOPE_MISMATCH');

      const mismatchedEffect = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        ...physical,
        request: { ...physical.request, effectId: 'accccccc-cccc-4ccc-8ccc-cccccccccccc' },
      });
      const mismatchedEffectFailure = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          relatedEvidence: [
            {
              _tag: 'PHYSICAL_STOCK_EFFECT',
              correlation: {
                allocationIds: ['allocation-p1'],
                attemptId,
                authority: externalAuthority,
                effectId,
                positionRefs: [positionOneRef],
                reservationRef: subjectReservation.ref,
              },
              value: mismatchedEffect,
            },
          ],
        }),
      ).pipe(Effect.flip);
      const supersetFailure = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          relatedEvidence: [
            {
              _tag: 'PHYSICAL_STOCK_EFFECT',
              correlation: {
                allocationIds: ['allocation-p1', 'allocation-p2'],
                attemptId,
                authority: externalAuthority,
                effectId,
                positionRefs: [positionOneRef, positionTwoRef],
                reservationRef: subjectReservation.ref,
              },
              value: physical,
            },
          ],
        }),
      ).pipe(Effect.flip);
      const quantitySuperset = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        ...physical,
        request: { ...physical.request, quantity: { amount: '10', unitRef } },
      });
      const subsetFailure = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          relatedEvidence: [
            {
              _tag: 'PHYSICAL_STOCK_EFFECT',
              correlation: {
                allocationIds: ['allocation-p1'],
                attemptId,
                authority: externalAuthority,
                effectId,
                positionRefs: [positionOneRef],
                reservationRef: subjectReservation.ref,
              },
              value: quantitySuperset,
            },
          ],
        }),
      ).pipe(Effect.flip);

      const releaseLedger = (requestEffectId: string) =>
        Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
          currentState: 'INDETERMINATE',
          effectId,
          intent: {
            _tag: 'RESERVATION_RELEASE',
            request: {
              effectId: requestEffectId,
              legalEntityId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              reservation: subjectReservation,
            },
          },
          requestedAt: '2026-09-25T10:35:00.000Z',
          resolution: null,
          revision: 2,
          tenantId,
          updatedAt: '2026-09-25T10:36:00.000Z',
        });
      const fullCorrelation = {
        allocationIds: ['allocation-p1', 'allocation-p2'],
        attemptId,
        authority: externalAuthority,
        effectId,
        positionRefs: [positionOneRef, positionTwoRef],
        reservationRef: subjectReservation.ref,
      } as const;
      const ledgerEffectMismatch = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          relatedEvidence: [
            {
              _tag: 'EFFECT_LEDGER',
              correlation: fullCorrelation,
              value: releaseLedger('accccccc-cccc-4ccc-8ccc-cccccccccccc'),
            },
          ],
        }),
      ).pipe(Effect.flip);
      const ledgerSubsetFailure = yield* compileInventoryHistoricalEvidence(
        Schema.decodeUnknownSync(CompileInventoryHistoricalEvidenceInputSchema)({
          ...validInput(),
          relatedEvidence: [
            {
              _tag: 'EFFECT_LEDGER',
              correlation: {
                ...fullCorrelation,
                allocationIds: ['allocation-p1'],
                positionRefs: [positionOneRef],
              },
              value: releaseLedger(effectId),
            },
          ],
        }),
      ).pipe(Effect.flip);

      expect(mismatchedEffectFailure.reason).toBe('RELATED_EVIDENCE_SCOPE_MISMATCH');
      expect(supersetFailure.reason).toBe('RELATED_EVIDENCE_SCOPE_MISMATCH');
      expect(subsetFailure.reason).toBe('RELATED_EVIDENCE_SCOPE_MISMATCH');
      expect(ledgerEffectMismatch.reason).toBe('RELATED_EVIDENCE_SCOPE_MISMATCH');
      expect(ledgerSubsetFailure.reason).toBe('RELATED_EVIDENCE_SCOPE_MISMATCH');
    }),
  );
});
