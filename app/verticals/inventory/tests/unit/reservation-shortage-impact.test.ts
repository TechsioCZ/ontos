import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  ReservationShortageCandidate,
  ReservationShortageImpactEvaluation,
  ReservationShortagePoolBoundary,
} from '../../shared/domain/reservation-shortage-impact.ts';
import {
  evaluateReservationShortageImpact,
  ReservationShortageImpactInputSchema,
  ReservationShortageImpactRejected,
} from '../../shared/domain/reservation-shortage-impact.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import type { ReservationConfirmationHealthState } from '../../shared/domain/reservation-confirmation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const affectedPositionId = '22222222-2222-4222-8222-222222222222';
const unrelatedPositionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const configurationId = '66666666-6666-4666-8666-666666666666';
const productId = '77777777-7777-4777-8777-777777777777';
const variantId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const positionRef = (resourceId: string) => ({
  moduleId: 'commerce.inventory' as const,
  resourceId,
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
});
const affectedPositionRef = positionRef(affectedPositionId);
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;

const observationFor = (healthState: ReservationConfirmationHealthState, issuedAt: string, expiresAt: string) =>
  Match.value(healthState).pipe(
    Match.when('VALID', () => ({
      _tag: 'ISSUED' as const,
      effectiveAt: issuedAt,
      ownerEvidenceRef: `owner-proof:${issuedAt}`,
    })),
    Match.when('AT_RISK', () => ({
      _tag: 'MATERIAL_IMPAIRMENT' as const,
      effectiveAt: '2026-09-24T10:10:00.000Z',
      ownerEvidenceRef: `owner-proof:impairment:${issuedAt}`,
    })),
    Match.when('UNVERIFIABLE', () => ({
      _tag: 'OWNER_UNVERIFIABLE' as const,
      effectiveAt: '2026-09-24T10:10:00.000Z',
      reason: 'OWNER_EVIDENCE_UNAVAILABLE' as const,
    })),
    Match.when('REVOKED', () => ({
      _tag: 'DEFINITIVE_REVOCATION' as const,
      decision: 'DEFINITIVE' as const,
      effectiveAt: '2026-09-24T10:10:00.000Z',
      ownerEvidenceRef: `owner-proof:revoked:${issuedAt}`,
    })),
    Match.when('EXPIRED', () => ({ _tag: 'VALIDITY_ELAPSED' as const, effectiveAt: expiresAt })),
    Match.exhaustive,
  );

const makeCandidate = (input: {
  readonly amount?: string;
  readonly confirmationId: string;
  readonly healthState?: ReservationConfirmationHealthState;
  readonly issuedAt: string;
  readonly poolBoundary?: ReservationShortagePoolBoundary;
  readonly positionId?: string;
  readonly reservationId: string;
}): ReservationShortageCandidate => {
  const amount = input.amount ?? '1';
  const expiresAt = '2026-09-24T11:00:00.000Z';
  const healthState = input.healthState ?? 'VALID';
  const allocationPositionRef = positionRef(input.positionId ?? affectedPositionId);
  const allocation = {
    allocationId: `allocation:${input.confirmationId}`,
    positionRef: allocationPositionRef,
    quantity: { amount, unitRef },
    stockItemRef: {
      moduleId: 'commerce.inventory' as const,
      resourceId: itemId,
      resourceType: 'commerce.inventory.stock-item' as const,
      tenantId,
    },
  };
  const ownerEvidenceRef = `owner-proof:${input.issuedAt}`;
  const confirmation = Schema.decodeUnknownSync(ReservationConfirmationSchema, { onExcessProperty: 'error' })({
    authorityEvidence: {
      effectId: `effect:${input.confirmationId}`,
      evidence: {
        allocations: [
          {
            allocationId: allocation.allocationId,
            quantity: allocation.quantity,
            stockItemRef: allocation.stockItemRef,
            stockPositionRef: allocation.positionRef,
          },
        ],
        attemptId: `attempt:${input.confirmationId}`,
        customerConfigurationId: 'customer-configuration-primary',
        ownerEvidenceRef,
        reservationId: input.reservationId,
        tenantId,
        validFrom: input.issuedAt,
        validUntil: expiresAt,
      },
      issuer: { backend: 'external_business_system', backendId: 'erp-primary', origin: 'EXTERNAL_BUSINESS_SYSTEM' },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    },
    expiresAt,
    health: { observation: observationFor(healthState, input.issuedAt, expiresAt), state: healthState },
    issuanceRank: {
      issuedAt: input.issuedAt,
      ownerEvidenceRef,
      source: 'RESERVATION_AUTHORITY_EVIDENCE',
    },
    issuedAt: input.issuedAt,
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: input.confirmationId,
      resourceType: 'commerce.inventory.reservation-confirmation',
      tenantId,
    },
    reservation: {
      authority: {
        configurationId,
        customerConfigurationId: 'customer-configuration-primary',
        revision: 1,
        selectedAt: '2026-09-24T09:00:00.000Z',
        selection: {
          backend: 'external_business_system',
          backendId: 'erp-primary',
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'UNSUPPORTED',
        },
        tenantId,
      },
      establishedAt: input.issuedAt,
      lifecycleMeaning: 'PROVISIONAL_RESERVATION',
      origin: { attemptId: `attempt:${input.confirmationId}`, kind: 'ORDER_COMMITMENT_ATTEMPT' },
      ref: {
        moduleId: 'commerce.inventory',
        resourceId: input.reservationId,
        resourceType: 'commerce.inventory.inventory-reservation',
        tenantId,
      },
      requirements: [
        {
          allocations: [allocation],
          bindingRef: {
            moduleId: 'commerce.inventory',
            resourceId: bindingId,
            resourceType: 'commerce.inventory.catalog-to-stock-binding',
            tenantId,
          },
          catalogSelection: {
            productRef: {
              moduleId: 'commerce.catalog',
              resourceId: productId,
              resourceType: 'commerce.catalog.product',
              tenantId,
            },
            variantRef: {
              moduleId: 'commerce.catalog',
              resourceId: variantId,
              resourceType: 'commerce.catalog.variant',
              tenantId,
            },
          },
          exactSelectionMeaning,
          purchaseDemandOccurrenceId: `demand:${input.confirmationId}`,
          quantity: amount,
          stockItem: {
            createdAt: input.issuedAt,
            exactSelectionMeaning,
            lifecycle: 'CURRENT',
            retiredAt: null,
            revision: 1,
            stockItemRef: allocation.stockItemRef,
            unitRef,
          },
          unitRef,
        },
      ],
    },
    revision: healthState === 'VALID' ? 1 : 2,
  });
  return {
    allocations: confirmation.reservation.requirements.flatMap(({ allocations }) => allocations),
    confirmation,
    poolBoundary: input.poolBoundary ?? 'NONE',
  };
};

const decodeInput = Schema.decodeUnknownSync(ReservationShortageImpactInputSchema, { onExcessProperty: 'error' });

const expectDeterminateDecisions = (
  evaluation: ReservationShortageImpactEvaluation,
  expected: readonly unknown[],
): void => {
  Match.value(evaluation).pipe(
    Match.tag('DETERMINATE', ({ decisions }) => {
      expect(decisions).toMatchObject(expected);
      return true;
    }),
    Match.tag('INDETERMINATE', () => {
      expect.fail('expected determinate shortage impact');
      return false;
    }),
    Match.exhaustive,
  );
};

const expectIndeterminateOrder = (evaluation: ReservationShortageImpactEvaluation): void => {
  Match.value(evaluation).pipe(
    Match.tag('DETERMINATE', () => {
      expect.fail('expected indeterminate shortage impact');
      return false;
    }),
    Match.tag('INDETERMINATE', (indeterminate) => {
      expect(indeterminate).toMatchObject({
        candidateRefs: [
          { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
          { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
        ],
        reason: 'AUTHORITATIVE_ISSUANCE_ORDER_UNRESOLVABLE',
        reconciliationRequired: true,
      });
      return true;
    }),
    Match.exhaustive,
  );
};

describe('Reservation shortage impact', () => {
  it.effect('uses owner issuance rank instead of arrival order and protects the oldest fitting prefix', () =>
    Effect.gen(function* ownerIssuanceRankWins() {
      const candidates = [
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
          issuedAt: '2026-09-24T10:03:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          issuedAt: '2026-09-24T10:01:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          issuedAt: '2026-09-24T10:02:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          issuedAt: '2026-09-24T10:00:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        }),
      ];

      const evaluation = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '3', unitRef },
          candidates,
        }),
      );

      expectDeterminateDecisions(evaluation, [
        { capacity: 'HONORABLE', confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' } },
        { capacity: 'HONORABLE', confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' } },
        { capacity: 'HONORABLE', confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' } },
        { capacity: 'SHORTAGE', confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4' } },
      ]);
    }),
  );

  it.effect('never lets a younger best-fit Confirmation skip an older all-or-nothing shortage', () =>
    Effect.gen(function* noBestFitSkipping() {
      const evaluation = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '2', unitRef },
          candidates: [
            makeCandidate({
              amount: '1',
              confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
              issuedAt: '2026-09-24T10:01:00.000Z',
              reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
            }),
            makeCandidate({
              amount: '3',
              confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
              issuedAt: '2026-09-24T10:00:00.000Z',
              reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
            }),
          ],
        }),
      );

      expectDeterminateDecisions(evaluation, [
        { affectedQuantity: { amount: '3' }, capacity: 'SHORTAGE' },
        { affectedQuantity: { amount: '1' }, capacity: 'SHORTAGE' },
      ]);
    }),
  );

  it.effect('retains stable rank and fences protected, committed, or terminal-unreleased Quantity', () =>
    Effect.gen(function* stablePriorityMembership() {
      const candidates = [
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          healthState: 'AT_RISK',
          issuedAt: '2026-09-24T10:00:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          healthState: 'UNVERIFIABLE',
          issuedAt: '2026-09-24T10:01:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          issuedAt: '2026-09-24T10:02:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
          issuedAt: '2026-09-24T10:03:00.000Z',
          poolBoundary: 'COMMITMENT_PROTECTED',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
          healthState: 'EXPIRED',
          issuedAt: '2026-09-24T10:04:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
          healthState: 'REVOKED',
          issuedAt: '2026-09-24T10:05:00.000Z',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
          issuedAt: '2026-09-24T10:06:00.000Z',
          poolBoundary: 'RELEASED',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8',
          issuedAt: '2026-09-24T10:07:00.000Z',
          poolBoundary: 'COMMITTED_OBLIGATION',
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8',
        }),
        makeCandidate({
          confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
          issuedAt: '2026-09-24T09:59:00.000Z',
          positionId: unrelatedPositionId,
          reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9',
        }),
      ];

      const evaluation = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '2', unitRef },
          candidates,
        }),
      );

      expect(evaluation).toMatchObject({ fencedAmount: '4' });
      expectDeterminateDecisions(evaluation, [
        {
          capacity: 'SHORTAGE',
          confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
          currentHealth: 'AT_RISK',
          issuanceRank: { issuedAt: '2026-09-24T10:00:00.000Z' },
        },
        {
          capacity: 'SHORTAGE',
          confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
          currentHealth: 'UNVERIFIABLE',
          issuanceRank: { issuedAt: '2026-09-24T10:01:00.000Z' },
        },
        {
          capacity: 'SHORTAGE',
          confirmationRef: { resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' },
          currentHealth: 'VALID',
          issuanceRank: { issuedAt: '2026-09-24T10:02:00.000Z' },
        },
      ]);
    }),
  );

  it.effect('does not let a younger Confirmation consume an expired but unreleased hold', () =>
    Effect.gen(function* fenceTerminalUnreleasedHold() {
      const evaluation = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '1', unitRef },
          candidates: [
            makeCandidate({
              confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
              healthState: 'EXPIRED',
              issuedAt: '2026-09-24T10:00:00.000Z',
              reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
            }),
            makeCandidate({
              confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
              issuedAt: '2026-09-24T10:01:00.000Z',
              reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
            }),
          ],
        }),
      );

      expect(evaluation).toMatchObject({ fencedAmount: '1' });
      expectDeterminateDecisions(evaluation, [{ capacity: 'SHORTAGE' }]);
    }),
  );

  it.effect('requires reconciliation when owner evidence cannot order two competing Confirmations', () =>
    Effect.gen(function* unresolvedOwnerOrder() {
      const evaluation = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '1', unitRef },
          candidates: [
            makeCandidate({
              confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
              issuedAt: '2026-09-24T10:00:00.000Z',
              reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
            }),
            makeCandidate({
              confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
              issuedAt: '2026-09-24T10:00:00Z',
              reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
            }),
          ],
        }),
      );

      expectIndeterminateOrder(evaluation);
    }),
  );

  it.effect('rejects unit-scope and duplicate-identity corruption through the typed channel', () =>
    Effect.gen(function* typedFailures() {
      const candidate = makeCandidate({
        confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        issuedAt: '2026-09-24T10:00:00.000Z',
        reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      });
      const wrongUnit = {
        ...unitRef,
        resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      };
      const unitFailure = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '1', unitRef: wrongUnit },
          candidates: [candidate],
        }),
      ).pipe(Effect.flip);
      const duplicateFailure = yield* evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '1', unitRef },
          candidates: [candidate, candidate],
        }),
      ).pipe(Effect.flip);

      expect(Schema.is(ReservationShortageImpactRejected)(unitFailure)).toBe(true);
      expect(unitFailure).toMatchObject({
        code: 'inventory_reservation_shortage_impact_rejected',
        reason: 'CANDIDATE_ALLOCATION_UNIT_MISMATCH',
      });
      expect(Schema.is(ReservationShortageImpactRejected)(duplicateFailure)).toBe(true);
      expect(duplicateFailure).toMatchObject({
        code: 'inventory_reservation_shortage_impact_rejected',
        reason: 'DUPLICATE_CONFIRMATION',
      });
    }),
  );
});
