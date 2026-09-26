import type { Effect as EffectType, Option } from 'effect';
import { DateTime, Effect, Match, Result, Schema } from 'effect';

import type { ProvisionalInventoryReservation } from './inventory-obligation.ts';
import { ProvisionalInventoryReservationSchema } from './inventory-obligation.ts';
import type { AuthoritativeReservationEvidence, ReservationAuthorityAllocation } from './reservation-authority.ts';
import { AuthoritativeReservationEvidenceSchema } from './reservation-authority.ts';
import type { ReservationConfirmationRef } from '../resources/reservation-confirmation.ts';
import { ReservationConfirmationRefSchema } from '../resources/reservation-confirmation.ts';
import type { ReservationConfirmationUnavailable } from './reservation-confirmation-unavailable.ts';

export { ReservationConfirmationUnavailable } from './reservation-confirmation-unavailable.ts';

const boundedEvidenceRef = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const confirmationInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const ReservationConfirmationHealthStateSchema = Schema.Literals([
  'VALID',
  'AT_RISK',
  'REVOKED',
  'EXPIRED',
  'UNVERIFIABLE',
]);
export type ReservationConfirmationHealthState = typeof ReservationConfirmationHealthStateSchema.Type;

const ReservationConfirmationIssuedObservationSchema = Schema.TaggedStruct('ISSUED', {
  effectiveAt: confirmationInstant,
  ownerEvidenceRef: boundedEvidenceRef,
});
const ReservationConfirmationOwnerHealthyObservationSchema = Schema.TaggedStruct('OWNER_HEALTHY', {
  effectiveAt: confirmationInstant,
  ownerEvidenceRef: boundedEvidenceRef,
});
const ReservationConfirmationMaterialImpairmentObservationSchema = Schema.TaggedStruct('MATERIAL_IMPAIRMENT', {
  effectiveAt: confirmationInstant,
  ownerEvidenceRef: boundedEvidenceRef,
});
const ReservationConfirmationBindingCorrectionObservationSchema = Schema.TaggedStruct('BINDING_CORRECTION', {
  correctionEvidenceRef: boundedEvidenceRef,
  effectiveAt: confirmationInstant,
});
const ReservationConfirmationDefinitiveRevocationObservationSchema = Schema.TaggedStruct('DEFINITIVE_REVOCATION', {
  decision: Schema.Literal('DEFINITIVE'),
  effectiveAt: confirmationInstant,
  ownerEvidenceRef: boundedEvidenceRef,
});
const ReservationConfirmationOwnerUnverifiableObservationSchema = Schema.TaggedStruct('OWNER_UNVERIFIABLE', {
  effectiveAt: confirmationInstant,
  reason: Schema.Literals([
    'OWNER_EVIDENCE_MISSING',
    'OWNER_EVIDENCE_STALE',
    'OWNER_EVIDENCE_UNAVAILABLE',
    'OWNER_EVIDENCE_INDETERMINATE',
  ]),
});
const ReservationConfirmationValidityElapsedObservationSchema = Schema.TaggedStruct('VALIDITY_ELAPSED', {
  effectiveAt: confirmationInstant,
});

export const ReservationConfirmationHealthObservationSchema = Schema.Union([
  ReservationConfirmationIssuedObservationSchema,
  ReservationConfirmationOwnerHealthyObservationSchema,
  ReservationConfirmationMaterialImpairmentObservationSchema,
  ReservationConfirmationBindingCorrectionObservationSchema,
  ReservationConfirmationDefinitiveRevocationObservationSchema,
  ReservationConfirmationOwnerUnverifiableObservationSchema,
  ReservationConfirmationValidityElapsedObservationSchema,
]);
export type ReservationConfirmationHealthObservation = typeof ReservationConfirmationHealthObservationSchema.Type;

export const ReservationConfirmationHealthSchema = Schema.Struct({
  observation: ReservationConfirmationHealthObservationSchema,
  state: ReservationConfirmationHealthStateSchema,
});

export const ReservationConfirmationIssuanceRankSchema = Schema.Struct({
  issuedAt: confirmationInstant,
  ownerEvidenceRef: boundedEvidenceRef,
  source: Schema.Literal('RESERVATION_AUTHORITY_EVIDENCE'),
});

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameAllocation = (
  expected: ProvisionalInventoryReservation['requirements'][number]['allocations'][number],
  actual: ReservationAuthorityAllocation,
) =>
  String(expected.allocationId) === String(actual.allocationId) &&
  expected.quantity.amount === actual.quantity.amount &&
  sameRef(expected.quantity.unitRef, actual.quantity.unitRef) &&
  sameRef(expected.stockItemRef, actual.stockItemRef) &&
  sameRef(expected.positionRef, actual.stockPositionRef);

const proofMatchesReservation = (
  reservation: ProvisionalInventoryReservation,
  evidence: AuthoritativeReservationEvidence,
  operation: AuthoritativeReservationEvidence['operation'] = 'RESERVATION_CONFIRMATION',
) => {
  const expectedAllocations = reservation.requirements.flatMap(({ allocations }) => allocations);
  const actualAllocations = evidence.evidence.allocations;
  return (
    evidence.operation === operation &&
    evidence.evidence.attemptId === reservation.origin.attemptId &&
    evidence.evidence.reservationId === reservation.ref.resourceId &&
    String(evidence.evidence.tenantId) === String(reservation.ref.tenantId) &&
    evidence.evidence.customerConfigurationId === reservation.authority.customerConfigurationId &&
    expectedAllocations.length === actualAllocations.length &&
    expectedAllocations.every((expected) => actualAllocations.some((actual) => sameAllocation(expected, actual)))
  );
};

const healthStateFor = (
  observation: Exclude<ReservationConfirmationHealthObservation, { readonly _tag: 'ISSUED' }>,
): ReservationConfirmationHealthState =>
  Match.value(observation).pipe(
    Match.tag('OWNER_HEALTHY', () => 'VALID' as const),
    Match.tag('MATERIAL_IMPAIRMENT', () => 'AT_RISK' as const),
    Match.tag('BINDING_CORRECTION', () => 'AT_RISK' as const),
    Match.tag('DEFINITIVE_REVOCATION', () => 'REVOKED' as const),
    Match.tag('VALIDITY_ELAPSED', () => 'EXPIRED' as const),
    Match.tag('OWNER_UNVERIFIABLE', () => 'UNVERIFIABLE' as const),
    Match.exhaustive,
  );

const ReservationConfirmationBaseSchema = Schema.Struct({
  authorityEvidence: AuthoritativeReservationEvidenceSchema,
  expiresAt: confirmationInstant,
  health: ReservationConfirmationHealthSchema,
  issuanceRank: ReservationConfirmationIssuanceRankSchema,
  issuedAt: confirmationInstant,
  ref: ReservationConfirmationRefSchema,
  reservation: ProvisionalInventoryReservationSchema,
  revision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
});
type ReservationConfirmationCandidate = typeof ReservationConfirmationBaseSchema.Type;

const confirmationProofInvariant = (confirmation: ReservationConfirmationCandidate): string | undefined => {
  const { authorityEvidence, expiresAt, issuanceRank, issuedAt, ref, reservation } = confirmation;
  if (
    String(ref.tenantId) !== String(reservation.ref.tenantId) ||
    String(ref.tenantId) !== String(authorityEvidence.evidence.tenantId)
  ) {
    return 'Confirmation, Reservation, and authority evidence must share one Tenant';
  }
  if (
    issuedAt !== authorityEvidence.evidence.validFrom ||
    expiresAt !== authorityEvidence.evidence.validUntil ||
    issuanceRank.issuedAt !== issuedAt ||
    issuanceRank.ownerEvidenceRef !== authorityEvidence.evidence.ownerEvidenceRef
  ) {
    return 'Confirmation issuance, expiry, and rank must preserve the original authority evidence';
  }
  if (issuedAt >= expiresAt) {
    return 'Reservation Confirmation validity interval must be non-empty';
  }
  const expectedOrigin =
    reservation.authority.selection.backend === 'external_business_system' ? 'EXTERNAL_BUSINESS_SYSTEM' : 'ONTOS_WMS';
  return authorityEvidence.issuer.backend !== reservation.authority.selection.backend ||
    authorityEvidence.issuer.backendId !== reservation.authority.selection.backendId ||
    authorityEvidence.issuer.origin !== expectedOrigin ||
    !proofMatchesReservation(reservation, authorityEvidence)
    ? 'Confirmation must preserve the exact selected authority and Reservation proof scope'
    : undefined;
};

const confirmationHealthInvariant = (confirmation: ReservationConfirmationCandidate): string | undefined => {
  const { expiresAt, health, issuedAt, revision } = confirmation;
  const issued = Schema.is(ReservationConfirmationIssuedObservationSchema)(health.observation);
  const validityElapsed = Schema.is(ReservationConfirmationValidityElapsedObservationSchema)(health.observation);
  const expectedHealthState = issued ? 'VALID' : healthStateFor(health.observation);
  if (health.state !== expectedHealthState) {
    return 'Confirmation health state must match its exact observation evidence';
  }
  if ((revision === 1) !== issued || health.observation.effectiveAt < issuedAt) {
    return 'Initial issuance and later health revisions must preserve monotonic proof time';
  }
  return (validityElapsed && health.observation.effectiveAt < expiresAt) ||
    (!validityElapsed && health.observation.effectiveAt >= expiresAt)
    ? 'Confirmation health evidence must respect the original expiry boundary'
    : undefined;
};

export const ReservationConfirmationSchema = ReservationConfirmationBaseSchema.check(
  Schema.makeFilter(
    (confirmation) => confirmationProofInvariant(confirmation) ?? confirmationHealthInvariant(confirmation),
  ),
);
export type ReservationConfirmation = typeof ReservationConfirmationSchema.Type;

export class ReservationConfirmationRejected extends Schema.TaggedError<ReservationConfirmationRejected>()(
  'ReservationConfirmationRejected',
  {
    code: Schema.Literal('reservation_confirmation_rejected'),
    confirmationRef: Schema.optionalKey(ReservationConfirmationRefSchema),
    reason: Schema.Literals([
      'INVALID_CONFIRMATION',
      'TENANT_SCOPE_MISMATCH',
      'RESERVATION_SCOPE_MISMATCH',
      'AUTHORITY_SCOPE_MISMATCH',
      'PROOF_SCOPE_MISMATCH',
      'INVALID_PROOF_VALIDITY',
      'IDENTITY_NAMESPACE_COLLISION',
      'SIBLING_CONFIRMATION_FORBIDDEN',
      'CONFIRMATION_IDENTITY_CONFLICT',
      'CONFIRMATION_NOT_FOUND',
      'TERMINAL_HEALTH_STATE',
      'INVALID_HEALTH_TRANSITION',
      'HEALTH_OBSERVATION_BEFORE_ISSUANCE',
      'PROTECTION_ESTABLISHMENT_AFTER_EVALUATION',
      'PROTECTION_ESTABLISHMENT_OUTSIDE_VALID_INTERVAL',
      'REVISION_CONFLICT',
    ]),
  },
) {}

export type ReservationConfirmationError = ReservationConfirmationRejected | ReservationConfirmationUnavailable;

export interface ReservationConfirmationPersistence {
  readonly createOrRead: (
    candidate: ReservationConfirmation,
  ) => EffectType.Effect<
    { readonly confirmation: ReservationConfirmation; readonly outcome: 'INSERTED' | 'EXISTING' },
    ReservationConfirmationError
  >;
  readonly findByRef: (
    ref: ReservationConfirmationRef,
  ) => EffectType.Effect<Option.Option<ReservationConfirmation>, ReservationConfirmationError>;
  readonly findByReservationAttempt: (
    reservationRef: ProvisionalInventoryReservation['ref'],
    attemptId: ProvisionalInventoryReservation['origin']['attemptId'],
  ) => EffectType.Effect<Option.Option<ReservationConfirmation>, ReservationConfirmationError>;
  readonly readHistory: (
    ref: ReservationConfirmationRef,
  ) => EffectType.Effect<readonly ReservationConfirmation[], ReservationConfirmationError>;
  readonly saveRevision: (input: {
    readonly current: ReservationConfirmation;
    readonly next: ReservationConfirmation;
  }) => EffectType.Effect<ReservationConfirmation, ReservationConfirmationError>;
}

export interface ReservationConfirmationProtectionObservation {
  readonly evidence: AuthoritativeReservationEvidence;
  /**
   * A prospective establishment is a new owner effect requested while the Confirmation is currently usable.
   * Original-effect recovery only proves when an already-requested effect actually happened.
   */
  readonly kind: 'ORIGINAL_EFFECT_RECOVERY' | 'PROSPECTIVE_ESTABLISHMENT';
}

export interface ReservationConfirmationCommitmentEvaluationInput {
  readonly evaluatedAt: typeof confirmationInstant.Type;
  readonly protection?: ReservationConfirmationProtectionObservation;
}

const rejected = (reason: ReservationConfirmationRejected['reason'], confirmationRef?: ReservationConfirmationRef) =>
  confirmationRef === undefined
    ? new ReservationConfirmationRejected({ code: 'reservation_confirmation_rejected', reason })
    : new ReservationConfirmationRejected({ code: 'reservation_confirmation_rejected', confirmationRef, reason });

export const establishReservationConfirmation = Effect.fn('establishReservationConfirmation')(
  function* establishConfirmation(input: {
    readonly authorityEvidence: AuthoritativeReservationEvidence;
    readonly confirmationRef: ReservationConfirmationRef;
    readonly reservation: ProvisionalInventoryReservation;
  }) {
    const { authorityEvidence, confirmationRef, reservation } = input;
    if (confirmationRef.tenantId !== reservation.ref.tenantId) {
      return yield* rejected('TENANT_SCOPE_MISMATCH', confirmationRef);
    }
    if (
      String(confirmationRef.resourceId) === String(reservation.ref.resourceId) ||
      String(confirmationRef.resourceId) === String(reservation.origin.attemptId)
    ) {
      return yield* rejected('IDENTITY_NAMESPACE_COLLISION', confirmationRef);
    }
    if (
      authorityEvidence.issuer.backend !== reservation.authority.selection.backend ||
      authorityEvidence.issuer.backendId !== reservation.authority.selection.backendId ||
      authorityEvidence.issuer.origin !==
        (reservation.authority.selection.backend === 'external_business_system'
          ? 'EXTERNAL_BUSINESS_SYSTEM'
          : 'ONTOS_WMS')
    ) {
      return yield* rejected('AUTHORITY_SCOPE_MISMATCH', confirmationRef);
    }
    if (!proofMatchesReservation(reservation, authorityEvidence)) {
      return yield* rejected('PROOF_SCOPE_MISMATCH', confirmationRef);
    }
    const { ownerEvidenceRef, validFrom, validUntil } = authorityEvidence.evidence;
    if (
      DateTime.toEpochMillis(DateTime.makeUnsafe(validUntil)) <= DateTime.toEpochMillis(DateTime.makeUnsafe(validFrom))
    ) {
      return yield* rejected('INVALID_PROOF_VALIDITY', confirmationRef);
    }
    return yield* Schema.decodeEffect(ReservationConfirmationSchema)({
      authorityEvidence,
      expiresAt: validUntil,
      health: {
        observation: { _tag: 'ISSUED', effectiveAt: validFrom, ownerEvidenceRef },
        state: 'VALID',
      },
      issuanceRank: { issuedAt: validFrom, ownerEvidenceRef, source: 'RESERVATION_AUTHORITY_EVIDENCE' },
      issuedAt: validFrom,
      ref: confirmationRef,
      reservation,
      revision: 1,
    }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_CONFIRMATION', confirmationRef), { cause })));
  },
);

export const advanceReservationConfirmationHealth = Effect.fn('advanceReservationConfirmationHealth')(
  function* advanceHealth(
    confirmation: ReservationConfirmation,
    observation: Exclude<ReservationConfirmationHealthObservation, { readonly _tag: 'ISSUED' }>,
  ) {
    if (confirmation.health.state === 'REVOKED' || confirmation.health.state === 'EXPIRED') {
      return yield* rejected('TERMINAL_HEALTH_STATE', confirmation.ref);
    }
    if (observation.effectiveAt < confirmation.issuedAt) {
      return yield* rejected('HEALTH_OBSERVATION_BEFORE_ISSUANCE', confirmation.ref);
    }
    if (observation.effectiveAt < confirmation.health.observation.effectiveAt) {
      return yield* rejected('INVALID_HEALTH_TRANSITION', confirmation.ref);
    }
    const nextState = healthStateFor(observation);
    const validityElapsed = Schema.is(ReservationConfirmationValidityElapsedObservationSchema)(observation);
    if (validityElapsed && observation.effectiveAt < confirmation.expiresAt) {
      return yield* rejected('INVALID_HEALTH_TRANSITION', confirmation.ref);
    }
    if (!validityElapsed && observation.effectiveAt >= confirmation.expiresAt) {
      return yield* rejected('INVALID_HEALTH_TRANSITION', confirmation.ref);
    }
    if (
      confirmation.health.state === 'VALID' &&
      Schema.is(ReservationConfirmationOwnerHealthyObservationSchema)(observation)
    ) {
      return yield* rejected('INVALID_HEALTH_TRANSITION', confirmation.ref);
    }
    return yield* Schema.decodeEffect(ReservationConfirmationSchema)({
      ...confirmation,
      health: { observation, state: nextState },
      revision: confirmation.revision + 1,
    }).pipe(Effect.mapError((cause) => Object.assign(rejected('INVALID_CONFIRMATION', confirmation.ref), { cause })));
  },
);

export const reservationConfirmationCanEstablishProtection = (
  confirmation: ReservationConfirmation,
  establishmentAt: string,
): boolean =>
  confirmation.health.state === 'VALID' &&
  establishmentAt >= confirmation.issuedAt &&
  establishmentAt < confirmation.expiresAt;

const instantMillis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));

export const reservationConfirmationValidityHasElapsed = (
  confirmation: ReservationConfirmation,
  evaluatedAt: string,
): boolean => instantMillis(evaluatedAt) >= instantMillis(confirmation.expiresAt);

const protectionMatchesConfirmation = (
  confirmation: ReservationConfirmation,
  protection: AuthoritativeReservationEvidence,
): boolean =>
  protection.issuer.backend === confirmation.authorityEvidence.issuer.backend &&
  protection.issuer.backendId === confirmation.authorityEvidence.issuer.backendId &&
  protection.issuer.origin === confirmation.authorityEvidence.issuer.origin &&
  proofMatchesReservation(confirmation.reservation, protection, 'COMMITMENT_PROTECTION');

const sameConfirmationTimeline = (current: ReservationConfirmation, revision: ReservationConfirmation): boolean =>
  sameRef(current.ref, revision.ref) &&
  current.issuedAt === revision.issuedAt &&
  current.expiresAt === revision.expiresAt &&
  current.issuanceRank.issuedAt === revision.issuanceRank.issuedAt &&
  current.issuanceRank.ownerEvidenceRef === revision.issuanceRank.ownerEvidenceRef &&
  current.reservation.origin.attemptId === revision.reservation.origin.attemptId &&
  sameRef(current.reservation.ref, revision.reservation.ref);

const confirmationWasValidAt = (
  confirmation: ReservationConfirmation,
  healthHistory: readonly ReservationConfirmation[],
  establishedAtMillis: number,
): boolean => {
  let effectiveRevision: ReservationConfirmation | undefined;
  for (const revision of healthHistory) {
    if (!sameConfirmationTimeline(confirmation, revision)) {
      return false;
    }
    if (
      instantMillis(revision.health.observation.effectiveAt) <= establishedAtMillis &&
      (effectiveRevision === undefined || revision.revision > effectiveRevision.revision)
    ) {
      effectiveRevision = revision;
    }
  }
  return effectiveRevision?.health.state === 'VALID';
};

/**
 * Evaluates the authoritative establishment time, not evidence arrival time. A new prospective effect is never
 * allowed after expiry; recovery may only prove that the already-requested original effect happened in time.
 */
export const evaluateReservationConfirmationCommitment = Effect.fn('ReservationConfirmation.evaluateCommitment')(
  function* evaluateCommitment(
    confirmation: ReservationConfirmation,
    input: ReservationConfirmationCommitmentEvaluationInput,
    healthHistory: readonly ReservationConfirmation[] = [confirmation],
  ) {
    const evaluatedAt = yield* Schema.decodeEffect(confirmationInstant)(input.evaluatedAt).pipe(
      Effect.mapError((cause) => Object.assign(rejected('INVALID_HEALTH_TRANSITION', confirmation.ref), { cause })),
    );
    const evaluatedAtMillis = instantMillis(evaluatedAt);
    const issuedAtMillis = instantMillis(confirmation.issuedAt);
    const expiresAtMillis = instantMillis(confirmation.expiresAt);

    if (input.protection !== undefined) {
      const { evidence, kind } = input.protection;
      if (!protectionMatchesConfirmation(confirmation, evidence)) {
        return yield* rejected('PROOF_SCOPE_MISMATCH', confirmation.ref);
      }
      const establishedAtMillis = instantMillis(evidence.evidence.validFrom);
      if (establishedAtMillis > evaluatedAtMillis) {
        return yield* rejected('PROTECTION_ESTABLISHMENT_AFTER_EVALUATION', confirmation.ref);
      }
      const establishedInTime = establishedAtMillis >= issuedAtMillis && establishedAtMillis < expiresAtMillis;
      const establishedDuringValidInterval = confirmationWasValidAt(confirmation, healthHistory, establishedAtMillis);
      if (establishedInTime && !establishedDuringValidInterval) {
        return yield* rejected('PROTECTION_ESTABLISHMENT_OUTSIDE_VALID_INTERVAL', confirmation.ref);
      }
      const prospectiveAllowed =
        kind === 'PROSPECTIVE_ESTABLISHMENT' &&
        confirmation.health.state === 'VALID' &&
        evaluatedAtMillis < expiresAtMillis &&
        establishedDuringValidInterval;
      if (establishedInTime && (kind === 'ORIGINAL_EFFECT_RECOVERY' || prospectiveAllowed)) {
        return {
          confirmation,
          fence: 'PRESERVED' as const,
          outcome: 'PROTECTION_ESTABLISHED_IN_TIME' as const,
          protectionEvidence: evidence,
        };
      }
    }

    if (
      confirmation.health.state === 'EXPIRED' ||
      confirmation.health.state === 'REVOKED' ||
      evaluatedAtMillis >= expiresAtMillis
    ) {
      return {
        confirmation,
        outcome: 'TERMINAL_READINESS_LOSS' as const,
        replacement: 'BLOCKED_UNTIL_PREDECESSOR_RESOLVED' as const,
      };
    }
    if (confirmation.health.state === 'VALID') {
      return { confirmation, outcome: 'READY_TO_ESTABLISH_PROTECTION' as const };
    }
    return {
      confirmation,
      health: confirmation.health.state,
      outcome: 'NOT_READY' as const,
    };
  },
);

const canonicalReservationSchema = Schema.fromJsonString(ProvisionalInventoryReservationSchema);
const canonicalReservation = (reservation: ProvisionalInventoryReservation) =>
  Result.getOrThrow(Schema.encodeResult(canonicalReservationSchema)(reservation));

export const sameReservationConfirmationIssuance = (
  left: ReservationConfirmation,
  input: {
    readonly confirmationRef: ReservationConfirmationRef;
    readonly effectId: AuthoritativeReservationEvidence['effectId'];
    readonly reservation: ProvisionalInventoryReservation;
  },
): boolean =>
  sameRef(left.ref, input.confirmationRef) &&
  left.authorityEvidence.effectId === input.effectId &&
  canonicalReservation(left.reservation) === canonicalReservation(input.reservation);
