import type { Effect as EffectType } from 'effect';
import { Effect, Option, Schema } from 'effect';

import {
  ReservationConfirmationRejected,
  advanceReservationConfirmationHealth,
  establishReservationConfirmation,
  evaluateReservationConfirmationCommitment,
  reservationConfirmationValidityHasElapsed,
  sameReservationConfirmationIssuance,
} from '../../shared/domain/reservation-confirmation.ts';
import type {
  ReservationConfirmation,
  ReservationConfirmationCommitmentEvaluationInput,
  ReservationConfirmationError,
  ReservationConfirmationHealthObservation,
  ReservationConfirmationPersistence,
} from '../../shared/domain/reservation-confirmation.ts';
import type {
  AuthoritativeReservationEvidence,
  ReservationAuthorityIssueRequest,
} from '../../shared/domain/reservation-authority.ts';
import { ReservationAuthorityIssueRequestSchema } from '../../shared/domain/reservation-authority.ts';
import type { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import type { ReservationConfirmationRef } from '../../shared/resources/reservation-confirmation.ts';
import type { ReservationIssuerFailure } from './reservation-issuer.service.ts';

export interface ReservationConfirmationIssuer {
  readonly issue: (
    request: ReservationAuthorityIssueRequest,
  ) => EffectType.Effect<AuthoritativeReservationEvidence, ReservationIssuerFailure>;
}

export interface IssueReservationConfirmationInput {
  readonly confirmationRef: ReservationConfirmationRef;
  readonly effectId: typeof ReservationAuthorityEffectIdSchema.Type;
  readonly reservation: ProvisionalInventoryReservation;
}

const rejected = (reason: ReservationConfirmationRejected['reason'], confirmationRef?: ReservationConfirmationRef) =>
  confirmationRef === undefined
    ? new ReservationConfirmationRejected({ code: 'reservation_confirmation_rejected', reason })
    : new ReservationConfirmationRejected({ code: 'reservation_confirmation_rejected', confirmationRef, reason });

const decodeAuthorityRequest = Schema.decodeUnknownEffect(ReservationAuthorityIssueRequestSchema, {
  onExcessProperty: 'error',
});
const authorityRequestFor = (input: IssueReservationConfirmationInput) =>
  decodeAuthorityRequest({
    configuration: input.reservation.authority,
    effectId: input.effectId,
    operation: 'RESERVATION_CONFIRMATION',
    reservation: {
      allocations: input.reservation.requirements.flatMap(({ allocations }) =>
        allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
          allocationId,
          quantity,
          stockItemRef,
          stockPositionRef: positionRef,
        })),
      ),
      attemptId: input.reservation.origin.attemptId,
      reservationId: input.reservation.ref.resourceId,
      tenantId: input.reservation.ref.tenantId,
    },
  }).pipe(
    Effect.mapError((cause) => Object.assign(rejected('RESERVATION_SCOPE_MISMATCH', input.confirmationRef), { cause })),
  );

const resultForExisting = (existing: ReservationConfirmation, input: IssueReservationConfirmationInput) =>
  sameReservationConfirmationIssuance(existing, input)
    ? Effect.succeed({ confirmation: existing, outcome: 'EXACT_REPLAY' as const })
    : Effect.fail(
        rejected(
          existing.ref.resourceId === input.confirmationRef.resourceId
            ? 'CONFIRMATION_IDENTITY_CONFLICT'
            : 'SIBLING_CONFIRMATION_FORBIDDEN',
          input.confirmationRef,
        ),
      );

export const makeReservationConfirmationService = (dependencies: {
  readonly issuer: ReservationConfirmationIssuer;
  readonly persistence: ReservationConfirmationPersistence;
}) => ({
  evaluateForCommitment: Effect.fn('ReservationConfirmationService.evaluateForCommitment')(
    function* evaluateForCommitment(
      input: ReservationConfirmationCommitmentEvaluationInput & {
        readonly confirmationRef: ReservationConfirmationRef;
      },
    ) {
      const found = yield* dependencies.persistence.findByRef(input.confirmationRef);
      if (Option.isNone(found)) {
        return yield* rejected('CONFIRMATION_NOT_FOUND', input.confirmationRef);
      }
      let confirmation = found.value;
      const healthHistory = yield* dependencies.persistence.readHistory(input.confirmationRef);
      yield* evaluateReservationConfirmationCommitment(confirmation, input, healthHistory);
      if (
        confirmation.health.state !== 'EXPIRED' &&
        confirmation.health.state !== 'REVOKED' &&
        reservationConfirmationValidityHasElapsed(confirmation, input.evaluatedAt)
      ) {
        const expired = yield* advanceReservationConfirmationHealth(confirmation, {
          _tag: 'VALIDITY_ELAPSED',
          effectiveAt: confirmation.expiresAt,
        });
        confirmation = yield* dependencies.persistence.saveRevision({ current: confirmation, next: expired });
      }
      const completeHistory =
        healthHistory.at(-1)?.revision === confirmation.revision ? healthHistory : [...healthHistory, confirmation];
      return yield* evaluateReservationConfirmationCommitment(confirmation, input, completeHistory);
    },
  ),
  issue: Effect.fn('ReservationConfirmationService.issue')(function* issueConfirmation(
    input: IssueReservationConfirmationInput,
  ): Effect.fn.Return<
    { readonly confirmation: ReservationConfirmation; readonly outcome: 'ISSUED' | 'EXACT_REPLAY' },
    ReservationConfirmationError | ReservationIssuerFailure
  > {
    if (input.confirmationRef.tenantId !== input.reservation.ref.tenantId) {
      return yield* rejected('TENANT_SCOPE_MISMATCH', input.confirmationRef);
    }
    const existing = yield* dependencies.persistence.findByReservationAttempt(
      input.reservation.ref,
      input.reservation.origin.attemptId,
    );
    if (Option.isSome(existing)) {
      return yield* resultForExisting(existing.value, input);
    }
    const authorityRequest: ReservationAuthorityIssueRequest = yield* authorityRequestFor(input);
    const authorityEvidence = yield* dependencies.issuer.issue(authorityRequest);
    const candidate = yield* establishReservationConfirmation({
      authorityEvidence,
      confirmationRef: input.confirmationRef,
      reservation: input.reservation,
    });
    const persisted = yield* dependencies.persistence.createOrRead(candidate);
    if (persisted.outcome === 'EXISTING') {
      return yield* resultForExisting(persisted.confirmation, input);
    }
    return { confirmation: persisted.confirmation, outcome: 'ISSUED' as const };
  }),
  read: (confirmationRef: ReservationConfirmationRef) => dependencies.persistence.findByRef(confirmationRef),
  readHistory: (confirmationRef: ReservationConfirmationRef) => dependencies.persistence.readHistory(confirmationRef),
  recordHealth: Effect.fn('ReservationConfirmationService.recordHealth')(function* recordHealth(input: {
    readonly confirmationRef: ReservationConfirmationRef;
    readonly observation: Exclude<ReservationConfirmationHealthObservation, { readonly _tag: 'ISSUED' }>;
  }) {
    const found = yield* dependencies.persistence.findByRef(input.confirmationRef);
    if (Option.isNone(found)) {
      return yield* rejected('CONFIRMATION_NOT_FOUND', input.confirmationRef);
    }
    const current = found.value;
    const next = yield* advanceReservationConfirmationHealth(current, input.observation);
    return yield* dependencies.persistence.saveRevision({ current, next });
  }),
});
