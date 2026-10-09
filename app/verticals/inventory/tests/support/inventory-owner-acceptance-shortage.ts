import { Effect, Match, Schema } from 'effect';

import {
  evaluateReservationShortageImpact,
  ReservationShortageImpactInputSchema,
} from '../../shared/domain/reservation-shortage-impact.ts';
import type {
  ReservationShortageCandidate,
  ReservationShortageImpactEvaluation,
  ReservationShortagePoolBoundary,
} from '../../shared/domain/reservation-shortage-impact.ts';
import {
  advanceReservationConfirmationHealth,
  ReservationConfirmationSchema,
} from '../../shared/domain/reservation-confirmation.ts';
import type { ReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const affectedPositionId = '22222222-2222-4222-8222-222222222222';
const unrelatedPositionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const configurationId = '66666666-6666-4666-8666-666666666666';
const bindingId = '77777777-7777-4777-8777-777777777777';
const productId = '88888888-8888-4888-8888-888888888888';
const variantId = '99999999-9999-4999-8999-999999999999';
const catalogModuleId = 'commerce.catalog';
const inventoryModuleId = 'commerce.inventory';

const unitRef = {
  moduleId: catalogModuleId,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const positionRef = (resourceId: string) => ({
  moduleId: inventoryModuleId,
  resourceId,
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
});

const affectedPositionRef = positionRef(affectedPositionId);
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' as const };

const makeValidConfirmation = (input: {
  readonly amount: string;
  readonly confirmationId: string;
  readonly issuedAt: string;
  readonly positionId?: string;
  readonly reservationId: string;
}): ReservationConfirmation => {
  const expiresAt = '2026-09-24T12:00:00.000Z';
  const allocation = {
    allocationId: `allocation:${input.confirmationId}`,
    positionRef: positionRef(input.positionId ?? affectedPositionId),
    quantity: { amount: input.amount, unitRef },
    stockItemRef: {
      moduleId: inventoryModuleId,
      resourceId: itemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
  };
  const ownerEvidenceRef = `owner-proof:${input.confirmationId}`;

  return Schema.decodeUnknownSync(ReservationConfirmationSchema, { onExcessProperty: 'error' })({
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
      issuer: {
        backend: 'external_business_system',
        backendId: 'erp-primary',
        origin: 'EXTERNAL_BUSINESS_SYSTEM',
      },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    },
    expiresAt,
    health: {
      observation: { _tag: 'ISSUED', effectiveAt: input.issuedAt, ownerEvidenceRef },
      state: 'VALID',
    },
    issuanceRank: {
      issuedAt: input.issuedAt,
      ownerEvidenceRef,
      source: 'RESERVATION_AUTHORITY_EVIDENCE',
    },
    issuedAt: input.issuedAt,
    ref: {
      moduleId: inventoryModuleId,
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
        moduleId: inventoryModuleId,
        resourceId: input.reservationId,
        resourceType: 'commerce.inventory.inventory-reservation',
        tenantId,
      },
      requirements: [
        {
          allocations: [allocation],
          bindingRef: {
            moduleId: inventoryModuleId,
            resourceId: bindingId,
            resourceType: 'commerce.inventory.catalog-to-stock-binding',
            tenantId,
          },
          catalogSelection: {
            productRef: {
              moduleId: catalogModuleId,
              resourceId: productId,
              resourceType: 'commerce.catalog.product',
              tenantId,
            },
            variantRef: {
              moduleId: catalogModuleId,
              resourceId: variantId,
              resourceType: 'commerce.catalog.variant',
              tenantId,
            },
          },
          exactSelectionMeaning,
          purchaseDemandOccurrenceId: `demand:${input.confirmationId}`,
          quantity: input.amount,
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
    revision: 1,
  });
};

const candidate = (
  confirmation: ReservationConfirmation,
  poolBoundary: ReservationShortagePoolBoundary = 'NONE',
): ReservationShortageCandidate => ({
  allocations: confirmation.reservation.requirements.flatMap(({ allocations }) => allocations),
  confirmation,
  poolBoundary,
});

const decodeInput = Schema.decodeUnknownSync(ReservationShortageImpactInputSchema, { onExcessProperty: 'error' });

const determinateSummary = (evaluation: ReservationShortageImpactEvaluation) =>
  Match.value(evaluation).pipe(
    Match.tag('DETERMINATE', ({ decisions, fencedAmount }) => ({
      decisions: decisions.map(({ affectedQuantity, capacity, confirmationRef, currentHealth, issuanceRank }) => ({
        amount: affectedQuantity.amount,
        capacity,
        confirmationId: confirmationRef.resourceId,
        health: currentHealth,
        issuedAt: issuanceRank.issuedAt,
      })),
      fencedAmount,
    })),
    Match.tag('INDETERMINATE', () => ({ decisions: [], fencedAmount: 'INDETERMINATE' as const })),
    Match.exhaustive,
  );

export const evaluateInventoryOwnerAcceptanceShortage = Effect.fn('evaluateInventoryOwnerAcceptanceShortage')(
  function* evaluateAcceptanceShortage() {
    const olderValid = makeValidConfirmation({
      amount: '3',
      confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      issuedAt: '2026-09-24T10:00:00.000Z',
      reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    });
    const olderAtRisk = yield* advanceReservationConfirmationHealth(olderValid, {
      _tag: 'MATERIAL_IMPAIRMENT',
      effectiveAt: '2026-09-24T10:02:00.000Z',
      ownerEvidenceRef: 'owner-proof:older-at-risk',
    });
    const olderRecovered = yield* advanceReservationConfirmationHealth(olderAtRisk, {
      _tag: 'OWNER_HEALTHY',
      effectiveAt: '2026-09-24T10:03:00.000Z',
      ownerEvidenceRef: 'owner-proof:older-recovered',
    });
    const younger = makeValidConfirmation({
      amount: '1',
      confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      issuedAt: '2026-09-24T10:01:00.000Z',
      reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    });
    const unrelated = makeValidConfirmation({
      amount: '9',
      confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      issuedAt: '2026-09-24T09:59:00.000Z',
      positionId: unrelatedPositionId,
      reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
    });

    const evaluate = (older: ReservationConfirmation) =>
      evaluateReservationShortageImpact(
        decodeInput({
          affectedPositionRef,
          availableQuantity: { amount: '2', unitRef },
          candidates: [candidate(younger), candidate(unrelated), candidate(older)],
        }),
      );
    const atRiskEvaluation = yield* evaluate(olderAtRisk);
    const recoveredEvaluation = yield* evaluate(olderRecovered);

    const terminal = yield* advanceReservationConfirmationHealth(
      makeValidConfirmation({
        amount: '1',
        confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        issuedAt: '2026-09-24T10:04:00.000Z',
        reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
      }),
      { _tag: 'VALIDITY_ELAPSED', effectiveAt: '2026-09-24T12:00:00.000Z' },
    );
    const poolBoundaryEvaluation = yield* evaluateReservationShortageImpact(
      decodeInput({
        affectedPositionRef,
        availableQuantity: { amount: '2', unitRef },
        candidates: [candidate(terminal), candidate(younger, 'RELEASED')],
      }),
    );

    return {
      atRisk: determinateSummary(atRiskEvaluation),
      poolBoundary: {
        ...determinateSummary(poolBoundaryEvaluation),
        explicitlyReleasedConfirmationId: younger.ref.resourceId,
        terminalUnreleasedConfirmationId: terminal.ref.resourceId,
      },
      recovery: {
        confirmationIdentityPreserved: olderRecovered.ref.resourceId === olderAtRisk.ref.resourceId,
        issuanceRankPreserved: olderRecovered.issuanceRank.issuedAt === olderAtRisk.issuanceRank.issuedAt,
        summary: determinateSummary(recoveredEvaluation),
      },
      unrelatedPosition: {
        confirmationId: unrelated.ref.resourceId,
        positionId: unrelatedPositionId,
      },
    } as const;
  },
);
