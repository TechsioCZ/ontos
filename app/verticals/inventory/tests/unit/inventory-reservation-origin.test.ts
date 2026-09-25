import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommitInventoryReservationInputSchema,
  EstablishInventoryReservationInputSchema,
  ImportCommittedInventoryObligationInputSchema,
  ImportedOrderCommitProofRejected,
  InventoryObligationRequirementSchema,
  RuntimeCommittedInventoryObligationSchema,
  VerifiedRuntimeOrderCommitProofSchema,
  VerifiedImportedOrderCommitProofSchema,
  establishInventoryReservation,
  makeInventoryReservationCommitter,
  makeImportedCommittedObligationImporter,
} from '../../shared/domain/inventory-obligation.ts';
import type {
  ImportedOrderCommitProofObservation,
  RuntimeOrderCommitProofObservation,
} from '../../shared/domain/inventory-obligation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockItemRefSchema } from '../../shared/resources/stock-item.ts';
import type { StockItemRef } from '../../shared/resources/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const importedObligationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const firstPositionId = '66666666-6666-4666-8666-666666666666';
const secondPositionId = '77777777-7777-4777-8777-777777777777';
const configurationId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';
const occurredAt = '2026-09-24T10:00:00.000Z';
const decodeReservationInput = Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema, {
  onExcessProperty: 'error',
});
const decodeCommitInput = Schema.decodeUnknownSync(CommitInventoryReservationInputSchema, {
  onExcessProperty: 'error',
});
const decodeImportedInput = Schema.decodeUnknownSync(ImportCommittedInventoryObligationInputSchema, {
  onExcessProperty: 'error',
});
const decodeRequirement = Schema.decodeUnknownSync(InventoryObligationRequirementSchema, {
  onExcessProperty: 'error',
});

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const itemRef = Schema.decodeUnknownSync(StockItemRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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
const positionRef = (resourceId: string) => ({
  moduleId: 'commerce.inventory' as const,
  resourceId,
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
});
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

const requirement = (purchaseDemandOccurrenceId: string, quantity = '5', allocationItemRef: StockItemRef = itemRef) =>
  decodeRequirement({
    allocations: [
      {
        allocationId: `${purchaseDemandOccurrenceId}:p1`,
        positionRef: positionRef(firstPositionId),
        quantity: { amount: '2', unitRef },
        stockItemRef: allocationItemRef,
      },
      {
        allocationId: `${purchaseDemandOccurrenceId}:p2`,
        positionRef: positionRef(secondPositionId),
        quantity: { amount: '3', unitRef },
        stockItemRef: allocationItemRef,
      },
    ],
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: bindingId,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: selection,
    exactSelectionMeaning,
    purchaseDemandOccurrenceId,
    quantity,
    stockItem,
    unitRef,
  });

const reservationInput = () =>
  decodeReservationInput({
    authority,
    establishedAt: occurredAt,
    origin: { attemptId: 'attempt-checkout-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: reservationId,
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    requirements: [requirement('demand-occurrence-1')],
  });

const authoritativeProofVerifier = {
  verifyCommitted: (observation: ImportedOrderCommitProofObservation) =>
    Effect.succeed({
      ...observation,
      authority: 'ORDER_MIGRATION_PROOF_AUTHORITY' as const,
      commitStatus: 'COMMITTED' as const,
    }),
};

const authoritativeRuntimeCommitVerifier = {
  verifyCommitted: (observation: RuntimeOrderCommitProofObservation) =>
    Effect.succeed({
      ...observation,
      authority: 'ORDER_COMMIT_PROOF_AUTHORITY' as const,
      commitStatus: 'COMMITTED' as const,
    }),
};

const importedInput = () =>
  decodeImportedInput({
    authority,
    importedAt: occurredAt,
    orderProofObservation: {
      acceptedOrderId: 'legacy-order-42',
      evidenceRef: 'erp-order-commit-proof-42',
      observedAt: occurredAt,
      sourceOrderId: 'erp-order-42',
      sourceSystem: 'erp-primary',
    },
    origin: {
      kind: 'IMPORTED_PROVEN_ORDER',
      sourceObligationId: 'erp-hold-42',
      sourceOrderId: 'erp-order-42',
      sourceSystem: 'erp-primary',
    },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: importedObligationId,
      resourceType: 'commerce.inventory.imported-committed-obligation',
      tenantId,
    },
    requirements: [requirement('legacy-demand-occurrence-42')],
    runtimeAttemptId: null,
  });

describe('Inventory Reservation identity and origin', () => {
  it.effect('establishes one Attempt-bound Reservation across two exact Positions under one authority', () =>
    Effect.gen(function* establishSplitReservation() {
      const reservation = yield* establishInventoryReservation(reservationInput());

      expect(reservation).toMatchObject({
        authority,
        lifecycleMeaning: 'PROVISIONAL_RESERVATION',
        origin: { attemptId: 'attempt-checkout-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
        ref: { resourceId: reservationId },
      });
      expect(reservation.requirements[0]?.allocations.map(({ positionRef: ref }) => ref.resourceId)).toEqual([
        firstPositionId,
        secondPositionId,
      ]);
    }),
  );

  it.effect('preserves canonical exact Selection, meaning, binding, Item, Quantity, Unit, and revision evidence', () =>
    Effect.gen(function* preserveResolvedDemand() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const [preserved] = reservation.requirements;

      expect(preserved).toMatchObject({
        bindingRef: { resourceId: bindingId },
        catalogSelection: selection,
        exactSelectionMeaning,
        quantity: '5',
        stockItem: { revision: 1, stockItemRef: itemRef },
        unitRef,
      });
    }),
  );

  it.effect('preserves equal-valued Purchase Demand Occurrences as distinct Requirements', () =>
    Effect.gen(function* preserveOccurrences() {
      const input = reservationInput();
      const reservation = yield* establishInventoryReservation({
        ...input,
        requirements: [requirement('demand-occurrence-1'), requirement('demand-occurrence-2')],
      });

      expect(reservation.requirements.map(({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId)).toEqual([
        'demand-occurrence-1',
        'demand-occurrence-2',
      ]);
    }),
  );

  it.effect('rejects duplicate occurrence identity instead of merging Requirements', () =>
    Effect.gen(function* rejectDuplicateOccurrence() {
      const input = reservationInput();
      const failure = yield* establishInventoryReservation({
        ...input,
        requirements: [requirement('demand-occurrence-1'), requirement('demand-occurrence-1')],
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'DUPLICATE_DEMAND_OCCURRENCE' });
    }),
  );

  it.effect('rejects allocations that do not exactly cover the unchanged requested Quantity', () =>
    Effect.gen(function* rejectPartialCoverage() {
      const input = reservationInput();
      const failure = yield* establishInventoryReservation({
        ...input,
        requirements: [requirement('demand-occurrence-1', '6')],
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'ALLOCATION_QUANTITY_MISMATCH' });
    }),
  );

  it.effect('rejects allocation Item substitution even when Quantity and Unit match', () =>
    Effect.gen(function* rejectItemSubstitution() {
      const input = reservationInput();
      const substitutedItemRef = Schema.decodeUnknownSync(StockItemRefSchema)({
        ...itemRef,
        resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      });
      const failure = yield* establishInventoryReservation({
        ...input,
        requirements: [requirement('demand-occurrence-1', '5', substitutedItemRef)],
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'ALLOCATION_ITEM_MISMATCH' });
    }),
  );

  it.effect('rejects Reservation identity collision with its Attempt namespace', () =>
    Effect.gen(function* rejectIdentityCollision() {
      const input = decodeReservationInput({
        ...reservationInput(),
        origin: { attemptId: reservationId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
      });
      const failure = yield* establishInventoryReservation(input).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'IDENTITY_NAMESPACE_COLLISION' });
    }),
  );

  it.effect('continues the same Reservation obligation identity after authoritative Order commit', () =>
    Effect.gen(function* continueSameObligation() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const committed = yield* makeInventoryReservationCommitter(authoritativeRuntimeCommitVerifier).commit(
        decodeCommitInput({
          orderProofObservation: {
            acceptedOrderId: 'accepted-order-1',
            attemptId: reservation.origin.attemptId,
            evidenceRef: 'accepted-order-proof-1',
            observedAt: '2026-09-24T10:05:00.000Z',
            reservationRef: reservation.ref,
            tenantId,
          },
          reservation,
        }),
      );

      expect(committed).toMatchObject({
        authority: reservation.authority,
        confirmationTerminationReleasesStock: false,
        historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        obligationReductionCreatesOnHand: false,
        orderProof: {
          acceptedOrderId: 'accepted-order-1',
          authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
          commitStatus: 'COMMITTED',
        },
        origin: reservation.origin,
        physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
        ref: reservation.ref,
        remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
        requirements: reservation.requirements,
      });
    }),
  );

  it.effect('fails closed when authoritative commit proof binds another Reservation or Attempt', () =>
    Effect.gen(function* rejectConflictingCommitBinding() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const input = decodeCommitInput({
        orderProofObservation: {
          acceptedOrderId: 'accepted-order-1',
          attemptId: reservation.origin.attemptId,
          evidenceRef: 'accepted-order-proof-1',
          observedAt: '2026-09-24T10:05:00.000Z',
          reservationRef: reservation.ref,
          tenantId,
        },
        reservation,
      });
      const mismatchedProof = Schema.decodeUnknownSync(VerifiedRuntimeOrderCommitProofSchema)({
        ...input.orderProofObservation,
        attemptId: 'another-attempt',
        authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
        commitStatus: 'COMMITTED',
      });

      const failure = yield* makeInventoryReservationCommitter({
        verifyCommitted: () => Effect.succeed(mismatchedProof),
      })
        .commit(input)
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'ORDER_COMMIT_PROOF_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects a committed aggregate whose proof scope does not match its Reservation identity', () =>
    Effect.gen(function* rejectInvalidPersistedProofScope() {
      const reservation = yield* establishInventoryReservation(reservationInput());

      expect(() =>
        Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
          ...reservation,
          confirmationTerminationReleasesStock: false,
          historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
          lifecycleMeaning: 'COMMITTED_OBLIGATION',
          obligationReductionCreatesOnHand: false,
          orderProof: {
            acceptedOrderId: 'accepted-order-1',
            attemptId: 'another-attempt',
            authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
            commitStatus: 'COMMITTED',
            evidenceRef: 'accepted-order-proof-1',
            observedAt: '2026-09-24T10:05:00.000Z',
            reservationRef: reservation.ref,
            tenantId,
          },
          physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
          remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
        }),
      ).toThrow();
    }),
  );

  it.effect('imports only after trusted authoritative proof with source lineage and no synthetic Attempt', () =>
    Effect.gen(function* importProvenOrder() {
      const imported =
        yield* makeImportedCommittedObligationImporter(authoritativeProofVerifier).import(importedInput());

      expect(imported).toMatchObject({
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        orderProof: { authority: 'ORDER_MIGRATION_PROOF_AUTHORITY', commitStatus: 'COMMITTED' },
        origin: { kind: 'IMPORTED_PROVEN_ORDER', sourceOrderId: 'erp-order-42' },
        runtimeAttemptId: null,
      });
      expect(imported).not.toHaveProperty('attemptId');
    }),
  );

  it.effect('fails closed when trusted proof does not match the requested imported Order scope', () =>
    Effect.gen(function* rejectMismatchedProof() {
      const input = importedInput();
      const mismatchedProof = Schema.decodeUnknownSync(VerifiedImportedOrderCommitProofSchema)({
        ...input.orderProofObservation,
        authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
        commitStatus: 'COMMITTED',
        sourceOrderId: 'another-order',
      });
      const mismatchedVerifier = {
        verifyCommitted: () => Effect.succeed(mismatchedProof),
      };

      const failure = yield* makeImportedCommittedObligationImporter(mismatchedVerifier)
        .import(input)
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'IMPORT_PROOF_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects a legacy uncommitted hold as definite non-commit instead of reporting proof unavailability', () =>
    Effect.gen(function* rejectUncommittedHold() {
      const rejectingVerifier = {
        verifyCommitted: () =>
          Effect.fail(
            new ImportedOrderCommitProofRejected({
              code: 'imported_order_commit_proof_rejected',
              reason: 'ORDER_NOT_PROVEN_COMMITTED',
            }),
          ),
      };

      const failure = yield* makeImportedCommittedObligationImporter(rejectingVerifier)
        .import(importedInput())
        .pipe(Effect.flip);

      expect(Schema.is(ImportedOrderCommitProofRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'ORDER_NOT_PROVEN_COMMITTED' });
    }),
  );

  it('rejects fabricated Attempt, missing proof observation, or legacy uncommitted hold at the import boundary', () => {
    const valid = importedInput();
    const { orderProofObservation: _proof, ...withoutProof } = valid;

    expect(() => decodeImportedInput({ ...valid, runtimeAttemptId: 'fabricated-attempt' })).toThrow();
    expect(() => decodeImportedInput(withoutProof)).toThrow();
    expect(() =>
      decodeImportedInput({
        ...valid,
        origin: { kind: 'LEGACY_UNCOMMITTED_HOLD', sourceObligationId: 'hold-42' },
      }),
    ).toThrow();
  });
});
