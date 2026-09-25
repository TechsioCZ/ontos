import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  classifyLatePredecessorEffect,
  evaluateInventoryAttemptReplacement,
  InventoryAttemptReplacementBlockedSchema,
  InventoryAttemptReplacementEligibleSchema,
  InventoryAttemptReplacementRejected,
  InventoryLatePredecessorEffectSchema,
  InventoryReplacementAttemptSchema,
} from '../../shared/domain/inventory-attempt-replacement-lineage.ts';
import type { InventoryAttemptReplacementEvaluation } from '../../shared/domain/inventory-attempt-replacement-lineage.ts';
import {
  InventoryReservationCreateRequestSchema,
  ReservationCreateAllocationSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type { ReservationCreateEffect } from '../../shared/domain/inventory-reservation-create.ts';
import {
  ReleasedReservationEffectSchema,
  ReservationReleaseMutationIdSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import { InventoryReservationRefSchema } from '../../shared/resources/inventory-reservation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-25T10:00:00.000Z';
const authority = {
  configurationId: '77777777-7777-4777-8777-777777777777',
  customerConfigurationId: 'customer-primary',
  revision: 1 as const,
  selectedAt: timestamp,
  selection: {
    backend: 'external_business_system' as const,
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED' as const,
    stockCorrectionCapability: 'SUPPORTED' as const,
  },
  tenantId,
};
const predecessorReservationRef = Schema.decodeUnknownSync(InventoryReservationRefSchema)({
  moduleId: 'commerce.inventory' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.inventory.inventory-reservation' as const,
  tenantId,
});
const replacementReservationRef = Schema.decodeUnknownSync(InventoryReservationRefSchema)({
  ...predecessorReservationRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
});
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const stockItemRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.inventory.stock-item' as const,
  tenantId,
};
const positionRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
};
const allocation = Schema.decodeUnknownSync(ReservationCreateAllocationSchema)({
  allocationId: 'allocation-1',
  quantity: { amount: '2', unitRef },
  stockItemRef,
  stockPositionRef: positionRef,
});
const request = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
  authority,
  commerceContext: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-primary',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    customerConfigurationId: authority.customerConfigurationId,
    evidenceRef: 'commerce-context:1',
    observedAt: timestamp,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    status: 'CURRENT_OWNER_VERIFIED',
    storefrontRef: { appId: 'storefront-primary', tenantId },
    tenantId,
  },
  effectId: 'create-effect-predecessor',
  legalEntityId,
  mutationId: '99999999-9999-4999-8999-999999999999',
  requestedAt: timestamp,
  reservation: {
    origin: { attemptId: 'attempt-predecessor', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: predecessorReservationRef,
    requirements: [
      {
        allocations: [
          {
            allocationId: allocation.allocationId,
            positionRef,
            quantity: allocation.quantity,
            stockItemRef,
          },
        ],
        bindingRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          resourceType: 'commerce.inventory.catalog-to-stock-binding',
          tenantId,
        },
        catalogSelection: {
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
        },
        exactSelectionMeaning: { id: 'catalog-owner:selection-1', kind: 'PRODUCT_VARIANT' },
        purchaseDemandOccurrenceId: 'demand-1',
        quantity: '2',
        stockItem: {
          createdAt: timestamp,
          exactSelectionMeaning: { id: 'catalog-owner:selection-1', kind: 'PRODUCT_VARIANT' },
          lifecycle: 'CURRENT',
          retiredAt: null,
          revision: 1,
          stockItemRef,
          unitRef,
        },
        unitRef,
      },
    ],
  },
  sourceActionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
});
const closedTruth = {
  _tag: 'NOT_COMMITTED_CLOSED' as const,
  closureEvidenceRef: 'order:closed:predecessor',
  nonCommitEvidenceRef: 'order:not-committed:predecessor',
  observedAt: timestamp,
};
const replacement = Schema.decodeUnknownSync(InventoryReplacementAttemptSchema)({
  attemptId: 'attempt-replacement',
  authority,
  createEffectId: 'create-effect-replacement',
  reservationRef: replacementReservationRef,
});
const resolvedNoReservation = (): ReservationCreateEffect => ({
  _tag: 'RESOLVED_NO_RESERVATION',
  effectAbsenceProven: true,
  observedAt: timestamp,
  reason: 'BACKEND_REJECTED',
  request,
});
const established = (): Extract<ReservationCreateEffect, { readonly _tag: 'ESTABLISHED' }> => ({
  _tag: 'ESTABLISHED',
  ownerEvidenceRef: 'erp:reservation:predecessor',
  request,
  reservation: {
    authority: request.authority,
    establishedAt: timestamp,
    lifecycleMeaning: 'PROVISIONAL_RESERVATION',
    origin: request.reservation.origin,
    ref: request.reservation.ref,
    requirements: request.reservation.requirements,
  },
});
const released = () =>
  Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
    _tag: 'RELEASED',
    activeAllocations: [],
    authorityIssuer: {
      backend: authority.selection.backend,
      backendId: authority.selection.backendId,
      origin: 'EXTERNAL_BUSINESS_SYSTEM',
    },
    ownerEvidenceRef: 'erp:release:predecessor',
    releasedAt: timestamp,
    releaseOutcome: 'RELEASED',
    request: {
      effectId: 'release-effect-predecessor',
      legalEntityId,
      mutationId: Schema.decodeUnknownSync(ReservationReleaseMutationIdSchema)('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
      requestedAt: timestamp,
      reservation: established().reservation,
      sourceActionInvocationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    },
    revision: 2,
    safelyReusable: true,
    safeReleaseProof: {
      order: closedTruth,
      protection: { _tag: 'ABSENT_PROVEN', evidenceRef: 'protection:absent', observedAt: timestamp },
    },
  });

const evaluate = (overrides: Partial<InventoryAttemptReplacementEvaluation> = {}) =>
  evaluateInventoryAttemptReplacement({
    evaluatedAt: timestamp,
    orderTruth: closedTruth,
    predecessorCreateEffect: resolvedNoReservation(),
    replacement,
    replacementCause: 'ABANDONED',
    ...overrides,
  });

describe('Inventory closed Attempt and replacement lineage', () => {
  it.effect(
    'allows a distinct replacement only after authoritative closure and proven absence of predecessor effects',
    () =>
      Effect.gen(function* allowResolvedPredecessor() {
        const result = yield* evaluate();
        expect(Schema.is(InventoryAttemptReplacementEligibleSchema)(result)).toBe(true);
        if (!Schema.is(InventoryAttemptReplacementEligibleSchema)(result)) {
          yield* Effect.die('expected eligible replacement');
        }

        expect(result).toMatchObject({
          lineage: {
            predecessor: {
              attemptId: 'attempt-predecessor',
              createEffectId: 'create-effect-predecessor',
              reservationRef: predecessorReservationRef,
            },
            predecessorResolution: { effectAbsenceProven: true },
            replacement,
          },
          replacementAllowed: true,
        });
      }),
  );

  it.effect('allows replacement after the predecessor whole Reservation is authoritatively released', () =>
    Effect.gen(function* allowReleasedReservation() {
      const result = yield* evaluate({
        predecessorCreateEffect: established(),
        predecessorReleaseEffect: released(),
      });
      expect(Schema.is(InventoryAttemptReplacementEligibleSchema)(result)).toBe(true);
      if (!Schema.is(InventoryAttemptReplacementEligibleSchema)(result)) {
        yield* Effect.die('expected eligible replacement');
      }

      expect(result).toMatchObject({
        lineage: {
          predecessorResolution: {
            ownerEvidenceRef: 'erp:release:predecessor',
            releaseEffectId: 'release-effect-predecessor',
          },
        },
      });
    }),
  );

  it.effect('does not treat abandonment, expiry, or revocation as authoritative closure', () =>
    Effect.gen(function* blockWithoutClosure() {
      const open = yield* evaluate({
        orderTruth: { _tag: 'NOT_COMMITTED_OPEN', evidenceRef: 'order:open', observedAt: timestamp },
        replacementCause: 'CONFIRMATION_EXPIRED',
      });
      const unknown = yield* evaluate({
        orderTruth: { _tag: 'INDETERMINATE', observedAt: timestamp, reason: 'ORDER_EVIDENCE_UNAVAILABLE' },
        replacementCause: 'CONFIRMATION_REVOKED',
      });

      expect(Schema.is(InventoryAttemptReplacementBlockedSchema)(open)).toBe(true);
      expect(Schema.is(InventoryAttemptReplacementBlockedSchema)(unknown)).toBe(true);
      expect(open).toMatchObject({ reason: 'PREDECESSOR_NOT_CLOSED', replacementAllowed: false });
      expect(unknown).toMatchObject({
        reason: 'PREDECESSOR_TRUTH_INDETERMINATE',
        replacementAllowed: false,
      });
    }),
  );

  it.effect('keeps unresolved create side effects as predecessor debt', () =>
    Effect.gen(function* blockUnresolvedCreate() {
      const result = yield* evaluate({
        predecessorCreateEffect: {
          _tag: 'RECONCILIATION_REQUIRED',
          constrainedAllocations: [allocation],
          observedAt: timestamp,
          ownerEvidenceRef: 'erp:partial-hold',
          request,
        },
      });
      expect(Schema.is(InventoryAttemptReplacementBlockedSchema)(result)).toBe(true);

      expect(result).toMatchObject({
        debtAttemptId: 'attempt-predecessor',
        reason: 'PREDECESSOR_CREATE_EFFECT_UNRESOLVED',
      });
    }),
  );

  it.effect('keeps an unreleased predecessor Reservation as debt even after Order closure', () =>
    Effect.gen(function* blockUnreleasedReservation() {
      const result = yield* evaluate({ predecessorCreateEffect: established() });
      expect(Schema.is(InventoryAttemptReplacementBlockedSchema)(result)).toBe(true);

      expect(result).toMatchObject({
        reason: 'PREDECESSOR_RESERVATION_UNRESOLVED',
        replacementAllowed: false,
      });
    }),
  );

  it.effect('rejects Attempt, Reservation, effect, or backend identity reuse', () =>
    Effect.gen(function* rejectIdentityReuse() {
      const failures = yield* Effect.all([
        evaluate({
          replacement: Schema.decodeUnknownSync(InventoryReplacementAttemptSchema)({
            ...replacement,
            attemptId: request.reservation.origin.attemptId,
          }),
        }).pipe(Effect.flip),
        evaluate({
          replacement: Schema.decodeUnknownSync(InventoryReplacementAttemptSchema)({
            ...replacement,
            reservationRef: predecessorReservationRef,
          }),
        }).pipe(Effect.flip),
        evaluate({
          replacement: Schema.decodeUnknownSync(InventoryReplacementAttemptSchema)({
            ...replacement,
            createEffectId: request.effectId,
          }),
        }).pipe(Effect.flip),
        evaluate({
          replacement: Schema.decodeUnknownSync(InventoryReplacementAttemptSchema)({
            ...replacement,
            authority: {
              ...authority,
              selection: { ...authority.selection, backendId: 'erp-replacement' },
            },
          }),
        }).pipe(Effect.flip),
      ]);

      expect(failures.every((failure) => Schema.is(InventoryAttemptReplacementRejected)(failure))).toBe(true);
      expect(failures.map(({ reason }) => reason)).toEqual([
        'ATTEMPT_IDENTITY_REUSED',
        'RESERVATION_IDENTITY_REUSED',
        'CREATE_EFFECT_IDENTITY_REUSED',
        'BACKEND_SWITCH_REQUIRES_CUTOVER',
      ]);
    }),
  );

  it.effect('rejects release evidence that is not scoped to the exact predecessor Reservation and closure proof', () =>
    Effect.gen(function* rejectForeignRelease() {
      const foreignRelease = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
        ...released(),
        request: {
          ...released().request,
          reservation: { ...established().reservation, ref: replacementReservationRef },
        },
      });
      const failure = yield* evaluate({
        predecessorCreateEffect: established(),
        predecessorReleaseEffect: foreignRelease,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'PREDECESSOR_RESOLUTION_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects release evidence with mutated predecessor requirements or allocations', () =>
    Effect.gen(function* rejectMutatedReservationScope() {
      const original = released();
      const { reservation } = established();
      const [requirement] = reservation.requirements;
      if (requirement === undefined) {
        yield* Effect.die('expected predecessor requirement');
      }
      const mutatedRequirementRelease = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
        ...original,
        request: {
          ...original.request,
          reservation: {
            ...reservation,
            requirements: [{ ...requirement, quantity: '3' }],
          },
        },
      });
      const mutatedAllocationRelease = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
        ...original,
        request: {
          ...original.request,
          reservation: {
            ...reservation,
            requirements: [
              {
                ...requirement,
                allocations: requirement.allocations.map((candidate) => ({
                  ...candidate,
                  quantity: { ...candidate.quantity, amount: '1' },
                })),
              },
            ],
          },
        },
      });
      const failures = yield* Effect.all(
        [mutatedRequirementRelease, mutatedAllocationRelease].map((predecessorReleaseEffect) =>
          evaluate({ predecessorCreateEffect: established(), predecessorReleaseEffect }).pipe(Effect.flip),
        ),
      );

      expect(failures).toHaveLength(2);
      expect(failures.every((failure) => failure.reason === 'PREDECESSOR_RESOLUTION_SCOPE_MISMATCH')).toBe(true);
    }),
  );

  it.effect('rejects release evidence from another legal entity or Reservation Authority issuer', () =>
    Effect.gen(function* rejectForeignReleaseAuthority() {
      const original = released();
      const wrongLegalEntityRelease = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
        ...original,
        request: {
          ...original.request,
          legalEntityId: '12121212-1212-4121-8121-121212121212',
        },
      });
      const wrongIssuerRelease = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
        ...original,
        authorityIssuer: { ...original.authorityIssuer, backendId: 'erp-foreign' },
      });
      const failures = yield* Effect.all(
        [wrongLegalEntityRelease, wrongIssuerRelease].map((predecessorReleaseEffect) =>
          evaluate({ predecessorCreateEffect: established(), predecessorReleaseEffect }).pipe(Effect.flip),
        ),
      );

      expect(failures).toHaveLength(2);
      expect(failures.every((failure) => failure.reason === 'PREDECESSOR_RESOLUTION_SCOPE_MISMATCH')).toBe(true);
    }),
  );

  it.effect('attributes late work to the predecessor without reopening it or evidencing the replacement', () =>
    Effect.gen(function* preserveLateEffectLineage() {
      const eligible = Schema.decodeUnknownSync(InventoryAttemptReplacementEligibleSchema)(yield* evaluate());
      const lateEffect = Schema.decodeUnknownSync(InventoryLatePredecessorEffectSchema)({
        attemptId: eligible.lineage.predecessor.attemptId,
        effectId: 'late-provider-effect',
        observedAt: timestamp,
        ownerEvidenceRef: 'erp:late-effect',
        reservationRef: predecessorReservationRef,
      });
      const ordinaryDebt = yield* classifyLatePredecessorEffect(eligible.lineage, lateEffect, closedTruth);
      const commitConflict = yield* classifyLatePredecessorEffect(eligible.lineage, lateEffect, {
        _tag: 'COMMITTED',
        evidenceRef: 'order:late-commit',
        observedAt: timestamp,
      });

      expect(ordinaryDebt).toMatchObject({
        attributedAttemptId: 'attempt-predecessor',
        committedOrderPreserved: false,
        mayEvidenceReplacement: false,
        mayReopenPredecessor: false,
        outcome: 'PREDECESSOR_RECONCILIATION_DEBT',
      });
      expect(commitConflict).toMatchObject({
        attributedAttemptId: 'attempt-predecessor',
        committedOrderPreserved: true,
        mayEvidenceReplacement: false,
        mayReopenPredecessor: false,
        outcome: 'REPLACEMENT_CONFLICT_DEBT',
        replacementAttemptId: 'attempt-replacement',
      });
    }),
  );
});
