import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  ReservationConfirmation,
  ReservationConfirmationPersistence,
} from '../../shared/domain/reservation-confirmation.ts';
import {
  evaluateReservationConfirmationCommitment,
  ReservationConfirmationRejected,
  reservationConfirmationCanEstablishProtection,
} from '../../shared/domain/reservation-confirmation.ts';
import {
  EstablishInventoryReservationInputSchema,
  establishInventoryReservation,
} from '../../shared/domain/inventory-obligation.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import { StockItemRefSchema } from '../../shared/resources/stock-item.ts';
import type { ReservationConfirmationIssuer } from '../../src/services/reservation-confirmation.service.ts';
import { makeReservationConfirmationService } from '../../src/services/reservation-confirmation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const confirmationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const bindingId = '88888888-8888-4888-8888-888888888888';
const issuedAt = '2026-09-24T10:00:00.000Z';
const expiresAt = '2026-09-24T10:15:00.000Z';
const attemptId = 'attempt-checkout-1';
const effectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('effect:confirmation:attempt-1');
const decodeReservationInput = Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema, {
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
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
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
});
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: issuedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});
const reservationInput = () =>
  decodeReservationInput({
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
    establishedAt: issuedAt,
    origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: reservationId,
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    requirements: [
      {
        allocations: [
          {
            allocationId: 'allocation-1',
            positionRef: {
              moduleId: 'commerce.inventory',
              resourceId: positionId,
              resourceType: 'commerce.inventory.stock-position',
              tenantId,
            },
            quantity: { amount: '10', unitRef },
            stockItemRef: itemRef,
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
        purchaseDemandOccurrenceId: 'demand-occurrence-1',
        quantity: '10',
        stockItem,
        unitRef,
      },
    ],
  });

const makeMemoryPersistence = () => {
  let current: ReservationConfirmation | undefined;
  const history: ReservationConfirmation[] = [];
  const persistence: ReservationConfirmationPersistence = {
    createOrRead: (candidate) => {
      if (current === undefined) {
        current = candidate;
        history.push(candidate);
        return Effect.succeed({ confirmation: candidate, outcome: 'INSERTED' as const });
      }
      return Effect.succeed({ confirmation: current, outcome: 'EXISTING' as const });
    },
    findByRef: (ref) =>
      Effect.succeed(
        current?.ref.resourceId === ref.resourceId && current.ref.tenantId === ref.tenantId
          ? Option.some(current)
          : Option.none(),
      ),
    findByReservationAttempt: (reservationRef, requestedAttemptId) =>
      Effect.succeed(
        current?.reservation.ref.resourceId === reservationRef.resourceId &&
          current.reservation.origin.attemptId === requestedAttemptId
          ? Option.some(current)
          : Option.none(),
      ),
    readHistory: () => Effect.succeed(history),
    saveRevision: ({ current: expected, next }) => {
      if (current?.revision !== expected.revision) {
        return Effect.fail(
          new ReservationConfirmationRejected({
            code: 'reservation_confirmation_rejected',
            reason: 'REVISION_CONFLICT',
          }),
        );
      }
      current = next;
      history.push(next);
      return Effect.succeed(next);
    },
  };
  return { persistence, readCurrent: () => current };
};

const issuer: ReservationConfirmationIssuer = {
  issue: (request) =>
    Schema.decodeUnknownEffect(AuthoritativeReservationEvidenceSchema)({
      effectId: request.effectId,
      evidence: {
        allocations: request.reservation.allocations,
        attemptId: request.reservation.attemptId,
        customerConfigurationId: request.configuration.customerConfigurationId,
        ownerEvidenceRef: 'owner-proof:confirmation:1',
        reservationId: request.reservation.reservationId,
        tenantId: request.reservation.tenantId,
        validFrom: issuedAt,
        validUntil: expiresAt,
      },
      issuer: {
        backend: request.configuration.selection.backend,
        backendId: request.configuration.selection.backendId,
        origin: 'EXTERNAL_BUSINESS_SYSTEM',
      },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    }).pipe(Effect.orDie),
};

const protectionEvidenceAt = (establishedAt: string) =>
  Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
    effectId: 'effect:protection:attempt-1',
    evidence: {
      allocations: reservationInput().requirements.flatMap(({ allocations }) =>
        allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
          allocationId,
          quantity,
          stockItemRef,
          stockPositionRef: positionRef,
        })),
      ),
      attemptId,
      customerConfigurationId: 'customer-configuration-primary',
      ownerEvidenceRef: 'owner-proof:protection:1',
      reservationId,
      tenantId,
      validFrom: establishedAt,
      validUntil: '2026-09-25T10:00:00.000Z',
    },
    issuer: {
      backend: 'external_business_system',
      backendId: 'erp-primary',
      origin: 'EXTERNAL_BUSINESS_SYSTEM',
    },
    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
    operation: 'COMMITMENT_PROTECTION',
  });

const confirmationRef = Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: confirmationId,
  resourceType: 'commerce.inventory.reservation-confirmation',
  tenantId,
});

describe('Inventory Reservation Confirmation', () => {
  it.effect('issues one selected-authority proof preserving the exact Reservation meaning and stable rank', () =>
    Effect.gen(function* issueConfirmation() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const result = yield* makeReservationConfirmationService({ issuer, persistence: memory.persistence }).issue({
        confirmationRef,
        effectId,
        reservation,
      });

      expect(result.outcome).toBe('ISSUED');
      expect(result.confirmation).toMatchObject({
        expiresAt,
        health: { state: 'VALID' },
        issuanceRank: { issuedAt, ownerEvidenceRef: 'owner-proof:confirmation:1' },
        issuedAt,
        reservation: {
          origin: { attemptId },
          ref: { resourceId: reservationId },
          requirements: [
            {
              allocations: [{ positionRef: { resourceId: positionId }, quantity: { amount: '10' } }],
              bindingRef: { resourceId: bindingId },
              quantity: '10',
              stockItem: { stockItemRef: { resourceId: itemId } },
            },
          ],
        },
      });
      expect(reservationConfirmationCanEstablishProtection(result.confirmation, '2026-09-24T10:14:59.999Z')).toBe(true);
      expect(reservationConfirmationCanEstablishProtection(result.confirmation, expiresAt)).toBe(false);
    }),
  );

  it.effect('replays the same proof identity and rejects a sibling Confirmation for the Attempt', () =>
    Effect.gen(function* replayOneIdentity() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      const input = { confirmationRef, effectId, reservation };

      const first = yield* service.issue(input);
      const replay = yield* service.issue(input);
      const firstRequirement = Option.getOrThrow(Option.fromNullishOr(reservation.requirements[0]));
      const changedMeaning = yield* service
        .issue({
          ...input,
          reservation: {
            ...reservation,
            requirements: [
              {
                ...firstRequirement,
                stockItem: { ...firstRequirement.stockItem, revision: 2 },
              },
            ],
          },
        })
        .pipe(Effect.flip);
      const sibling = yield* service
        .issue({
          ...input,
          confirmationRef: Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
            ...confirmationRef,
            resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          }),
        })
        .pipe(Effect.flip);

      expect(first.outcome).toBe('ISSUED');
      expect(replay).toEqual({ confirmation: first.confirmation, outcome: 'EXACT_REPLAY' });
      expect(changedMeaning).toMatchObject({ reason: 'CONFIRMATION_IDENTITY_CONFLICT' });
      expect(sibling).toMatchObject({ reason: 'SIBLING_CONFIRMATION_FORBIDDEN' });
    }),
  );

  it.effect('marks material impairment AT_RISK without revoking or releasing the Reservation', () =>
    Effect.gen(function* recordImpairment() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      const issued = yield* service.issue({
        confirmationRef,
        effectId,
        reservation,
      });
      const atRisk = yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'MATERIAL_IMPAIRMENT',
          effectiveAt: '2026-09-24T10:05:00.000Z',
          ownerEvidenceRef: 'owner-proof:impairment:1',
        },
      });

      expect(atRisk.health.state).toBe('AT_RISK');
      expect(atRisk.reservation).toEqual(issued.confirmation.reservation);
      expect(atRisk.issuanceRank).toEqual(issued.confirmation.issuanceRank);
      expect(atRisk.authorityEvidence).toEqual(issued.confirmation.authorityEvidence);
      expect(atRisk).not.toHaveProperty('releasedAt');
    }),
  );

  it.effect('makes a binding correction AT_RISK without retargeting Item X and recovers the same proof identity', () =>
    Effect.gen(function* preserveBindingLineage() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      const issued = yield* service.issue({
        confirmationRef,
        effectId,
        reservation,
      });
      const atRisk = yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'BINDING_CORRECTION',
          correctionEvidenceRef: 'catalog-binding-correction:1',
          effectiveAt: '2026-09-24T10:05:00.000Z',
        },
      });
      const recovered = yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'OWNER_HEALTHY',
          effectiveAt: '2026-09-24T10:06:00.000Z',
          ownerEvidenceRef: 'owner-proof:recovery:1',
        },
      });

      expect(atRisk.health.state).toBe('AT_RISK');
      expect(recovered.health.state).toBe('VALID');
      expect(recovered.ref).toEqual(issued.confirmation.ref);
      expect(recovered.issuedAt).toBe(issuedAt);
      expect(recovered.expiresAt).toBe(expiresAt);
      expect(recovered.issuanceRank).toEqual(issued.confirmation.issuanceRank);
      expect(recovered.reservation.requirements[0]?.stockItem.stockItemRef.resourceId).toBe(itemId);
    }),
  );

  it.effect('rejects an out-of-order recovery older than the latest health observation', () =>
    Effect.gen(function* rejectOutOfOrderRecovery() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });
      const atRisk = yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'MATERIAL_IMPAIRMENT',
          effectiveAt: '2026-09-24T10:10:00.000Z',
          ownerEvidenceRef: 'owner-proof:impairment:late',
        },
      });
      const failure = yield* service
        .recordHealth({
          confirmationRef,
          observation: {
            _tag: 'OWNER_HEALTHY',
            effectiveAt: '2026-09-24T10:05:00.000Z',
            ownerEvidenceRef: 'owner-proof:recovery:stale',
          },
        })
        .pipe(Effect.flip);

      expect(atRisk.health.state).toBe('AT_RISK');
      expect(failure).toMatchObject({ reason: 'INVALID_HEALTH_TRANSITION' });
      expect(memory.readCurrent()?.health.state).toBe('AT_RISK');
      expect(memory.readCurrent()?.revision).toBe(2);
    }),
  );

  it.effect('requires explicit definitive owner evidence for REVOKED and keeps it terminal', () =>
    Effect.gen(function* revokeDefinitively() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });
      const revoked = yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'DEFINITIVE_REVOCATION',
          decision: 'DEFINITIVE',
          effectiveAt: '2026-09-24T10:07:00.000Z',
          ownerEvidenceRef: 'owner-proof:revocation:1',
        },
      });
      const recoveryFailure = yield* service
        .recordHealth({
          confirmationRef,
          observation: {
            _tag: 'OWNER_HEALTHY',
            effectiveAt: '2026-09-24T10:08:00.000Z',
            ownerEvidenceRef: 'owner-proof:too-late:1',
          },
        })
        .pipe(Effect.flip);

      expect(revoked.health.state).toBe('REVOKED');
      expect(recoveryFailure).toMatchObject({ reason: 'TERMINAL_HEALTH_STATE' });
    }),
  );

  it.effect('expires only at the original boundary and never renews the proof', () =>
    Effect.gen(function* expireAtBoundary() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      const issued = yield* service.issue({
        confirmationRef,
        effectId,
        reservation,
      });
      const early = yield* service
        .recordHealth({
          confirmationRef,
          observation: { _tag: 'VALIDITY_ELAPSED', effectiveAt: '2026-09-24T10:14:59.999Z' },
        })
        .pipe(Effect.flip);
      const expired = yield* service.recordHealth({
        confirmationRef,
        observation: { _tag: 'VALIDITY_ELAPSED', effectiveAt: expiresAt },
      });

      expect(early).toMatchObject({ reason: 'INVALID_HEALTH_TRANSITION' });
      expect(expired.health.state).toBe('EXPIRED');
      expect(expired.expiresAt).toBe(issued.confirmation.expiresAt);
      expect(expired.issuanceRank).toEqual(issued.confirmation.issuanceRank);
    }),
  );

  it.effect('materializes terminal expiry at the exclusive boundary and cannot restore readiness', () =>
    Effect.gen(function* materializeTerminalExpiry() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      const issued = yield* service.issue({ confirmationRef, effectId, reservation });

      const beforeBoundary = yield* service.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: '2026-09-24T10:14:59.999Z',
      });
      const atBoundary = yield* service.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: expiresAt,
      });
      const replay = yield* service.issue({ confirmationRef, effectId, reservation });

      expect(beforeBoundary).toMatchObject({ outcome: 'READY_TO_ESTABLISH_PROTECTION' });
      expect(atBoundary).toMatchObject({
        confirmation: { health: { state: 'EXPIRED' } },
        outcome: 'TERMINAL_READINESS_LOSS',
        replacement: 'BLOCKED_UNTIL_PREDECESSOR_RESOLVED',
      });
      expect(atBoundary.confirmation.ref).toEqual(issued.confirmation.ref);
      expect(atBoundary.confirmation.expiresAt).toBe(expiresAt);
      expect(replay).toMatchObject({ confirmation: { health: { state: 'EXPIRED' } }, outcome: 'EXACT_REPLAY' });
      expect(memory.readCurrent()).not.toHaveProperty('renewedAt');
      expect(memory.readCurrent()).not.toHaveProperty('releasedAt');
    }),
  );

  it.effect('preserves an in-time Protection proven only after Confirmation expiry', () =>
    Effect.gen(function* recoverInTimeProtection() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });
      const expired = yield* service.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: '2026-09-24T10:30:00.000Z',
      });

      const recovered = yield* service.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: '2026-09-24T11:00:00.000Z',
        protection: {
          evidence: protectionEvidenceAt('2026-09-24T10:14:59.999Z'),
          kind: 'ORIGINAL_EFFECT_RECOVERY',
        },
      });

      expect(recovered).toMatchObject({
        confirmation: { health: { state: 'EXPIRED' } },
        fence: 'PRESERVED',
        outcome: 'PROTECTION_ESTABLISHED_IN_TIME',
      });
      expect(recovered.confirmation).toMatchObject({
        expiresAt,
        issuanceRank: { issuedAt, ownerEvidenceRef: 'owner-proof:confirmation:1' },
        ref: confirmationRef,
      });
      expect(recovered.confirmation).not.toHaveProperty('releasedAt');
      const expiredAt = Match.value(expired.confirmation.health.observation).pipe(
        Match.tag('VALIDITY_ELAPSED', ({ effectiveAt }) => effectiveAt),
        Match.orElse(() => null),
      );
      const history = yield* service.readHistory(confirmationRef);
      const finalObservation = Option.getOrThrow(Option.fromNullishOr(history.at(-1))).health.observation;
      const historyExpiredAt = Match.value(finalObservation).pipe(
        Match.tag('VALIDITY_ELAPSED', ({ effectiveAt }) => effectiveAt),
        Match.orElse(() => null),
      );
      expect(expiredAt).toBe(expiresAt);
      expect(historyExpiredAt).toBe(expiresAt);
    }),
  );

  it.effect('rejects future-dated original-effect recovery evidence', () =>
    Effect.gen(function* rejectFutureRecovery() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });

      const failure = yield* service
        .evaluateForCommitment({
          confirmationRef,
          evaluatedAt: '2026-09-24T10:05:00.000Z',
          protection: {
            evidence: protectionEvidenceAt('2026-09-24T10:10:00.000Z'),
            kind: 'ORIGINAL_EFFECT_RECOVERY',
          },
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'PROTECTION_ESTABLISHMENT_AFTER_EVALUATION' });
    }),
  );

  it.effect('rejects recovery proof established after authoritative impairment or revocation', () =>
    Effect.gen(function* rejectContradictoryRecovery() {
      for (const terminalObservation of [
        {
          _tag: 'MATERIAL_IMPAIRMENT' as const,
          effectiveAt: '2026-09-24T10:05:00.000Z',
          ownerEvidenceRef: 'owner-proof:impairment:1',
        },
        {
          _tag: 'DEFINITIVE_REVOCATION' as const,
          decision: 'DEFINITIVE' as const,
          effectiveAt: '2026-09-24T10:05:00.000Z',
          ownerEvidenceRef: 'owner-proof:revocation:1',
        },
      ]) {
        const reservation = yield* establishInventoryReservation(reservationInput());
        const memory = makeMemoryPersistence();
        const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
        yield* service.issue({ confirmationRef, effectId, reservation });
        yield* service.recordHealth({ confirmationRef, observation: terminalObservation });

        const failure = yield* service
          .evaluateForCommitment({
            confirmationRef,
            evaluatedAt: '2026-09-24T10:10:00.000Z',
            protection: {
              evidence: protectionEvidenceAt('2026-09-24T10:06:00.000Z'),
              kind: 'ORIGINAL_EFFECT_RECOVERY',
            },
          })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ reason: 'PROTECTION_ESTABLISHMENT_OUTSIDE_VALID_INTERVAL' });
      }
    }),
  );

  it.effect('does not let prospective establishment backdate across an OWNER_HEALTHY recovery', () =>
    Effect.gen(function* rejectProspectiveBackdating() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });
      yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'MATERIAL_IMPAIRMENT',
          effectiveAt: '2026-09-24T10:05:00.000Z',
          ownerEvidenceRef: 'owner-proof:impairment:1',
        },
      });
      yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'OWNER_HEALTHY',
          effectiveAt: '2026-09-24T10:06:00.000Z',
          ownerEvidenceRef: 'owner-proof:recovery:1',
        },
      });

      const failure = yield* service
        .evaluateForCommitment({
          confirmationRef,
          evaluatedAt: '2026-09-24T10:07:00.000Z',
          protection: {
            evidence: protectionEvidenceAt('2026-09-24T10:05:30.000Z'),
            kind: 'PROSPECTIVE_ESTABLISHMENT',
          },
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'PROTECTION_ESTABLISHMENT_OUTSIDE_VALID_INTERVAL' });
    }),
  );

  it.effect('rejects post-expiry Protection establishment and keeps the original Attempt terminal', () =>
    Effect.gen(function* rejectLateProtection() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });

      const evaluated = yield* service.evaluateForCommitment({
        confirmationRef,
        evaluatedAt: '2026-09-24T10:30:00.000Z',
        protection: {
          evidence: protectionEvidenceAt(expiresAt),
          kind: 'ORIGINAL_EFFECT_RECOVERY',
        },
      });

      const backdatedProspective = yield* evaluateReservationConfirmationCommitment(evaluated.confirmation, {
        evaluatedAt: '2026-09-24T10:30:00.000Z',
        protection: {
          evidence: protectionEvidenceAt('2026-09-24T10:14:59.999Z'),
          kind: 'PROSPECTIVE_ESTABLISHMENT',
        },
      }).pipe(Effect.flip);

      expect(evaluated).toMatchObject({
        confirmation: { health: { state: 'EXPIRED' } },
        outcome: 'TERMINAL_READINESS_LOSS',
        replacement: 'BLOCKED_UNTIL_PREDECESSOR_RESOLVED',
      });
      expect(backdatedProspective).toMatchObject({ reason: 'PROTECTION_ESTABLISHMENT_OUTSIDE_VALID_INTERVAL' });
    }),
  );

  it.effect('preserves every revision in immutable history', () =>
    Effect.gen(function* preserveHistory() {
      const reservation = yield* establishInventoryReservation(reservationInput());
      const memory = makeMemoryPersistence();
      const service = makeReservationConfirmationService({ issuer, persistence: memory.persistence });
      yield* service.issue({ confirmationRef, effectId, reservation });
      yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'OWNER_UNVERIFIABLE',
          effectiveAt: '2026-09-24T10:05:00.000Z',
          reason: 'OWNER_EVIDENCE_UNAVAILABLE',
        },
      });
      yield* service.recordHealth({
        confirmationRef,
        observation: {
          _tag: 'OWNER_HEALTHY',
          effectiveAt: '2026-09-24T10:06:00.000Z',
          ownerEvidenceRef: 'owner-proof:recovery:1',
        },
      });

      const history = yield* service.readHistory(confirmationRef);
      expect(history.map(({ health, revision }) => [revision, health.state])).toEqual([
        [1, 'VALID'],
        [2, 'UNVERIFIABLE'],
        [3, 'VALID'],
      ]);
      expect(history.map(({ issuanceRank }) => issuanceRank)).toEqual([
        history[0]?.issuanceRank,
        history[0]?.issuanceRank,
        history[0]?.issuanceRank,
      ]);
    }),
  );
});
