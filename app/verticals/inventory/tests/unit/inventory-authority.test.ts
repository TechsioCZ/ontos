import { Effect, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventoryBackendConfigurationInputSchema } from '../../shared/inventory-launch-scope.ts';
import type {
  InventoryAttemptReservationIdentityBinding,
  InventoryReservationId,
  OrderCommitmentAttemptId,
} from '../../shared/domain/inventory-authority.ts';
import {
  continueInventoryObligationAfterCommit,
  establishInventoryAuthority,
  InventoryAuthorityAssignmentSchema,
  InventoryAuthorityOperationSchema,
  InventoryBackendContinuityInputSchema,
  InventoryCommitContinuationInputSchema,
  inventoryNonAuthorityBoundaries,
  InventoryOwnerEvidenceInputSchema,
  InventoryReservationAuthorityProposalSchema,
  makeInventoryReservationAuthorityService,
  requireExplicitBackendCutover,
  resolveInventoryOwnerEvidence,
} from '../../shared/domain/inventory-authority.ts';

const decodeBackendConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationInputSchema);
const decodeBackendContinuity = Schema.decodeUnknownSync(InventoryBackendContinuityInputSchema);
const decodeCommitContinuation = Schema.decodeUnknownSync(InventoryCommitContinuationInputSchema);
const decodeInventoryAuthority = Schema.decodeUnknownSync(InventoryAuthorityAssignmentSchema);
const decodeInventoryAuthorityOperation = Schema.decodeUnknownSync(InventoryAuthorityOperationSchema);
const decodeOwnerEvidenceInput = Schema.decodeUnknownSync(InventoryOwnerEvidenceInputSchema);
const decodeReservationProposal = Schema.decodeUnknownSync(InventoryReservationAuthorityProposalSchema);

const makeTestReservationAuthority = Effect.gen(function* makeTestReservationAuthority() {
  const bindings = yield* Ref.make(new Map<OrderCommitmentAttemptId, InventoryReservationId>());

  return makeInventoryReservationAuthorityService({
    readOrBind: ({ attemptId, proposedReservationId }) =>
      Ref.modify(
        bindings,
        (
          current,
        ): readonly [
          InventoryAttemptReservationIdentityBinding,
          Map<OrderCommitmentAttemptId, InventoryReservationId>,
        ] => {
          const existing = current.get(attemptId);
          if (existing !== undefined) {
            return [
              {
                attemptId,
                reservationId: existing,
                status: 'ALREADY_BOUND',
              },
              current,
            ];
          }

          const updated = new Map([...current, [attemptId, proposedReservationId] as const]);
          return [
            {
              attemptId,
              reservationId: proposedReservationId,
              status: 'BOUND_NOW',
            },
            updated,
          ];
        },
      ),
  });
});

describe('Inventory authority', () => {
  it.effect('uses the selected external backend directly as the only stock and Reservation authority', () =>
    Effect.gen(function* selectExternalAuthority() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );

      expect(authority).toEqual({
        authorityMode: 'SINGLE_CUSTOMER_CONFIGURATION_BACKEND',
        customerConfigurationId: 'customer-configuration-1',
        cutoverMode: 'EXPLICIT_ONLY',
        fallbackBackend: null,
        ownerAccess: 'DIRECT_EXTERNAL_OWNER_CONTRACT',
        physicalStockSystemOfRecord: 'external_business_system',
        reservationAuthority: 'external_business_system',
        selectedBackend: 'external_business_system',
      });
    }),
  );

  it.effect('uses OntOS WMS as the sole authority when it is selected', () =>
    Effect.gen(function* selectWmsAuthority() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-2',
          selectedBackends: ['ontos_wms'],
        }),
      );

      expect(authority).toMatchObject({
        fallbackBackend: null,
        ownerAccess: 'ONTOS_WMS_OWNER_CONTRACT',
        physicalStockSystemOfRecord: 'ontos_wms',
        reservationAuthority: 'ontos_wms',
        selectedBackend: 'ontos_wms',
      });
    }),
  );

  it.effect('inherits the Launch rejection for dual authority instead of choosing one backend', () =>
    Effect.gen(function* rejectDualAuthority() {
      const error = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system', 'ontos_wms'],
        }),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: 'exactly_one_backend_required',
        selectedBackends: ['external_business_system', 'ontos_wms'],
      });
    }),
  );

  it('rejects an authority document whose owner roles disagree with the selected backend', () => {
    expect(() =>
      decodeInventoryAuthority({
        authorityMode: 'SINGLE_CUSTOMER_CONFIGURATION_BACKEND',
        customerConfigurationId: 'customer-configuration-1',
        cutoverMode: 'EXPLICIT_ONLY',
        fallbackBackend: null,
        ownerAccess: 'DIRECT_EXTERNAL_OWNER_CONTRACT',
        physicalStockSystemOfRecord: 'ontos_wms',
        reservationAuthority: 'external_business_system',
        selectedBackend: 'external_business_system',
      }),
    ).toThrow();
  });

  it('keeps routes, caches and downstream domains outside Inventory authority', () => {
    expect(inventoryNonAuthorityBoundaries).toEqual([
      { participant: 'INTEGRATION_ROUTE', role: 'TRANSPORT_ONLY' },
      { participant: 'LOCAL_INVENTORY_BOOKKEEPING', role: 'EVIDENCE_ONLY' },
      { participant: 'AVAILABILITY', role: 'READ_OWNER_EVIDENCE_ONLY' },
      { participant: 'ORDER', role: 'OWNS_ACCEPTED_PURCHASE_ONLY' },
      { participant: 'FULFILLMENT', role: 'EXECUTION_EVIDENCE_ONLY' },
    ]);

    expect(() => decodeInventoryAuthorityOperation('RESERVATION_RENEWAL')).toThrow();
  });

  it.effect('uses one Reservation for the whole Attempt across multiple Stock Positions', () =>
    Effect.gen(function* useOneReservation() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const reservationAuthority = yield* makeTestReservationAuthority;
      const decision = yield* reservationAuthority.establish(
        decodeReservationProposal({
          allocations: [
            { authorityBackend: 'external_business_system', stockPositionId: 'position-1' },
            { authorityBackend: 'external_business_system', stockPositionId: 'position-2' },
          ],
          attemptId: 'attempt-1',
          authority,
          reservationIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        }),
      );

      expect(decision).toEqual({
        allocationCount: 2,
        attemptId: 'attempt-1',
        coverage: 'ALL_ATTEMPT_STOCK_REQUIREMENTS',
        reservationAuthority: 'external_business_system',
        reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        reservationIdentityStatus: 'ESTABLISHED',
      });
    }),
  );

  it.effect('rejects multiple Reservations or a second allocation authority for one Attempt', () =>
    Effect.gen(function* rejectFragmentedAuthority() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const reservationAuthority = yield* makeTestReservationAuthority;
      const cardinalityError = yield* reservationAuthority
        .establish(
          decodeReservationProposal({
            allocations: [{ authorityBackend: 'external_business_system', stockPositionId: 'position-1' }],
            attemptId: 'attempt-1',
            authority,
            reservationIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
          }),
        )
        .pipe(Effect.flip);
      const authorityError = yield* reservationAuthority
        .establish(
          decodeReservationProposal({
            allocations: [
              { authorityBackend: 'external_business_system', stockPositionId: 'position-1' },
              { authorityBackend: 'ontos_wms', stockPositionId: 'position-2' },
            ],
            attemptId: 'attempt-1',
            authority,
            reservationIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
          }),
        )
        .pipe(Effect.flip);

      expect(cardinalityError).toMatchObject({
        fallbackApplied: false,
        outcome: 'invalid_cardinality',
        reason: 'exactly_one_reservation_per_attempt_required',
      });
      expect(authorityError).toMatchObject({
        fallbackApplied: false,
        outcome: 'authority_mismatch',
        reason: 'all_allocations_require_selected_backend',
      });
    }),
  );

  it.effect('accepts an exact retry but rejects a different Reservation for the same Attempt', () =>
    Effect.gen(function* preserveAttemptReservationIdentity() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const allocation = {
        authorityBackend: 'external_business_system' as const,
        stockPositionId: 'position-1',
      };
      const reservationAuthority = yield* makeTestReservationAuthority;
      yield* reservationAuthority.establish(
        decodeReservationProposal({
          allocations: [allocation],
          attemptId: 'attempt-1',
          authority,
          reservationIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        }),
      );
      const exactRetry = yield* reservationAuthority.establish(
        decodeReservationProposal({
          allocations: [allocation],
          attemptId: 'attempt-1',
          authority,
          reservationIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        }),
      );
      const conflict = yield* reservationAuthority
        .establish(
          decodeReservationProposal({
            allocations: [allocation],
            attemptId: 'attempt-1',
            authority,
            reservationIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
          }),
        )
        .pipe(Effect.flip);

      expect(exactRetry).toMatchObject({
        reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        reservationIdentityStatus: 'EXACT_RETRY',
      });
      expect(conflict).toMatchObject({
        fallbackApplied: false,
        outcome: 'conflict',
        reason: 'attempt_reservation_identity_conflict',
      });
    }),
  );

  it.effect('accepts only selected-owner evidence as authoritative', () =>
    Effect.gen(function* acceptOwnerEvidence() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const decision = yield* resolveInventoryOwnerEvidence(
        decodeOwnerEvidenceInput({
          authority,
          observation: {
            issuer: { backend: 'external_business_system', kind: 'INVENTORY_BACKEND' },
            kind: 'CONFIRMED',
            ownerEvidenceRef: 'owner-proof-1',
            verification: 'OWNER_VERIFIED',
          },
          operation: 'RESERVATION_CONFIRMATION',
        }),
      );

      expect(decision).toEqual({
        authorityRole: 'RESERVATION_AUTHORITY',
        issuerBackend: 'external_business_system',
        kind: 'AUTHORITATIVE_OWNER_EVIDENCE',
        operation: 'RESERVATION_CONFIRMATION',
        ownerEvidenceRef: 'owner-proof-1',
      });
    }),
  );

  it.effect('rejects evidence attributed to an unselected backend, local bookkeeping or route', () =>
    Effect.gen(function* rejectNonOwnerEvidence() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const issuers = [
        { backend: 'ontos_wms', kind: 'INVENTORY_BACKEND' },
        { kind: 'LOCAL_INVENTORY_BOOKKEEPING' },
        { kind: 'INTEGRATION_ROUTE' },
      ] as const;

      for (const issuer of issuers) {
        const error = yield* resolveInventoryOwnerEvidence(
          decodeOwnerEvidenceInput({
            authority,
            observation: {
              issuer,
              kind: 'CONFIRMED',
              ownerEvidenceRef: 'non-owner-proof',
              verification: 'OWNER_VERIFIED',
            },
            operation: 'RESERVATION_CONFIRMATION',
          }),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({
          fallbackApplied: false,
          outcome: 'conflict',
          reason: 'owner_evidence_issuer_mismatch',
          selectedBackend: 'external_business_system',
        });
      }
    }),
  );

  it.effect('keeps unsupported, unavailable, conflicting and indeterminate owner outcomes explicit', () =>
    Effect.gen(function* rejectUnprovenOutcomes() {
      const authority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const expectations = [
        ['UNSUPPORTED', 'unsupported', 'selected_backend_does_not_support_required_guarantee'],
        ['UNAVAILABLE', 'unavailable', 'selected_backend_unavailable'],
        ['CONFLICT', 'conflict', 'selected_backend_evidence_conflict'],
        ['INDETERMINATE', 'indeterminate', 'selected_backend_evidence_indeterminate'],
      ] as const;

      for (const [kind, outcome, reason] of expectations) {
        const error = yield* resolveInventoryOwnerEvidence(
          decodeOwnerEvidenceInput({
            authority,
            observation: { kind },
            operation: 'RESERVATION_CREATE',
          }),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({
          fallbackApplied: false,
          outcome,
          reason,
          selectedBackend: 'external_business_system',
        });
      }
    }),
  );

  it.effect('continues the same Inventory obligation identity after proven Order commit', () =>
    Effect.gen(function* continueCommittedObligation() {
      const result = yield* continueInventoryObligationAfterCommit(
        decodeCommitContinuation({
          acceptedOrderEvidenceRef: 'accepted-order-proof-1',
          acceptedOrderId: 'order-1',
          attemptId: 'attempt-1',
          currentMeaning: 'PROVISIONAL_RESERVATION',
          reservationObligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      );

      expect(result).toEqual({
        acceptedOrderEvidenceRef: 'accepted-order-proof-1',
        acceptedOrderId: 'order-1',
        attemptId: 'attempt-1',
        fulfillmentRole: 'EXECUTION_EVIDENCE_ONLY',
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        obligationOwner: 'INVENTORY',
        orderOwnerRole: 'ACCEPTED_PURCHASE',
        reservationObligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
    }),
  );

  it.effect('requires explicit cutover instead of runtime backend failover', () =>
    Effect.gen(function* rejectRuntimeFailover() {
      const currentAuthority = yield* establishInventoryAuthority(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const error = yield* requireExplicitBackendCutover(
        decodeBackendContinuity({ currentAuthority, requestedBackend: 'ontos_wms' }),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        fallbackApplied: false,
        outcome: 'cutover_required',
        reason: 'backend_change_requires_explicit_cutover',
        resolution: 'explicit_cutover_required',
        selectedBackend: 'external_business_system',
      });
    }),
  );
});
