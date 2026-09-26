import type { Effect as EffectType, Option } from 'effect';
import { Effect, Result, Schema } from 'effect';

import { ReservationConfirmationSchema } from './reservation-confirmation.ts';
import { CommitmentProtectionConflict } from './commitment-protection-conflict.ts';
import { CommitmentProtectionRejected } from './commitment-protection-rejected.ts';
import { CommitmentProtectionUnavailable } from './commitment-protection-unavailable.ts';
import { LegalEntityIdSchema } from './physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';
import { AuthoritativeReservationEvidenceSchema } from './reservation-authority.ts';
import { CommitmentProtectionRefSchema } from '../resources/commitment-protection.ts';
import { ReservationConfirmationRefSchema } from '../resources/reservation-confirmation.ts';

const protectionInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const boundedEvidenceRef = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

export const EstablishCommitmentProtectionPayloadSchema = Schema.Struct({
  confirmationRef: ReservationConfirmationRefSchema,
  effectId: ReservationAuthorityEffectIdSchema,
  protectionRef: CommitmentProtectionRefSchema,
});
export type EstablishCommitmentProtectionPayload = typeof EstablishCommitmentProtectionPayloadSchema.Type;

const CommitmentProtectionEstablishedObservationSchema = Schema.TaggedStruct('ESTABLISHED', {
  effectiveAt: protectionInstant,
  ownerEvidenceRef: boundedEvidenceRef,
});
export const CommitmentProtectionHealthObservationSchema = Schema.Union([
  CommitmentProtectionEstablishedObservationSchema,
  Schema.TaggedStruct('BINDING_CORRECTION', {
    correctionEvidenceRef: boundedEvidenceRef,
    effectiveAt: protectionInstant,
  }),
  Schema.TaggedStruct('MATERIAL_IMPAIRMENT', {
    effectiveAt: protectionInstant,
    ownerEvidenceRef: boundedEvidenceRef,
  }),
]);

export const CommitmentProtectionSchema = Schema.Struct({
  authorityEvidence: AuthoritativeReservationEvidenceSchema,
  confirmation: ReservationConfirmationSchema,
  establishedAt: protectionInstant,
  health: Schema.Struct({
    observation: CommitmentProtectionHealthObservationSchema,
    reconciliationRequired: Schema.Boolean,
    state: Schema.Literals(['PROTECTED', 'AT_RISK']),
  }),
  ref: CommitmentProtectionRefSchema,
  revision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
}).check(
  Schema.makeFilter(({ authorityEvidence, confirmation, establishedAt, health, ref, revision }) => {
    const initial = Schema.is(CommitmentProtectionEstablishedObservationSchema)(health.observation);
    if (
      String(ref.tenantId) !== String(confirmation.ref.tenantId) ||
      authorityEvidence.operation !== 'COMMITMENT_PROTECTION' ||
      String(authorityEvidence.evidence.tenantId) !== String(confirmation.ref.tenantId) ||
      authorityEvidence.evidence.reservationId !== confirmation.reservation.ref.resourceId ||
      authorityEvidence.evidence.attemptId !== confirmation.reservation.origin.attemptId ||
      establishedAt !== authorityEvidence.evidence.validFrom
    ) {
      return 'Commitment Protection must preserve its exact Confirmation, Reservation, Attempt, and authority proof';
    }
    if ((revision === 1) !== initial) {
      return 'Only the first Commitment Protection revision may carry establishment evidence';
    }
    if (
      (health.state === 'PROTECTED' && (!initial || health.reconciliationRequired)) ||
      (health.state === 'AT_RISK' && (initial || !health.reconciliationRequired))
    ) {
      return 'Commitment Protection health must preserve its monotonic fence meaning';
    }
    return true;
  }),
);
export type CommitmentProtection = typeof CommitmentProtectionSchema.Type;

export const CommitmentProtectionEffectRequestSchema = Schema.Struct({
  confirmation: ReservationConfirmationSchema,
  effectId: ReservationAuthorityEffectIdSchema,
  legalEntityId: LegalEntityIdSchema,
  protectionRef: CommitmentProtectionRefSchema,
});
export type CommitmentProtectionEffectRequest = typeof CommitmentProtectionEffectRequestSchema.Type;

export const CommitmentProtectionNotProtectableReasonSchema = Schema.Literals([
  'CONFIRMATION_NOT_FOUND',
  'CONFIRMATION_NOT_VALID',
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_REVOKED',
  'AUTHORITY_REJECTED',
  'AUTHORITY_UNSUPPORTED',
  'ESTABLISHMENT_AFTER_EXPIRY',
]);

export const CommitmentProtectionEffectSchema = Schema.Union([
  Schema.TaggedStruct('PROTECTED', {
    protection: CommitmentProtectionSchema,
    request: CommitmentProtectionEffectRequestSchema,
  }),
  Schema.TaggedStruct('NOT_PROTECTABLE', {
    reason: CommitmentProtectionNotProtectableReasonSchema,
    request: CommitmentProtectionEffectRequestSchema,
  }),
]);
export type CommitmentProtectionEffect = typeof CommitmentProtectionEffectSchema.Type;

export const CommitmentProtectionProtectedResultSchema = Schema.TaggedStruct('PROTECTED', {
  protection: CommitmentProtectionSchema,
  replayed: Schema.Boolean,
});
export const CommitmentProtectionAtRiskResultSchema = Schema.TaggedStruct('AT_RISK', {
  protection: CommitmentProtectionSchema,
  reconciliationRequired: Schema.Literal(true),
  replayed: Schema.Boolean,
});
export const CommitmentProtectionIndeterminateResultSchema = Schema.TaggedStruct('INDETERMINATE', {
  effectId: ReservationAuthorityEffectIdSchema,
  fence: Schema.Literal('BLOCKED_PENDING_RECOVERY'),
  recovery: Schema.Literal('RECOVER_ORIGINAL_EFFECT'),
  replayed: Schema.Boolean,
});
export const CommitmentProtectionNotProtectableResultSchema = Schema.TaggedStruct('NOT_PROTECTABLE', {
  effectId: ReservationAuthorityEffectIdSchema,
  reason: CommitmentProtectionNotProtectableReasonSchema,
  replayed: Schema.Boolean,
});
export const EstablishCommitmentProtectionResultSchema = Schema.Union([
  CommitmentProtectionProtectedResultSchema,
  CommitmentProtectionAtRiskResultSchema,
  CommitmentProtectionIndeterminateResultSchema,
  CommitmentProtectionNotProtectableResultSchema,
]);
export type EstablishCommitmentProtectionResult = typeof EstablishCommitmentProtectionResultSchema.Type;

export const EstablishCommitmentProtectionErrorSchema = Schema.Union([
  CommitmentProtectionRejected,
  CommitmentProtectionConflict,
  CommitmentProtectionUnavailable,
]);
export type EstablishCommitmentProtectionError = typeof EstablishCommitmentProtectionErrorSchema.Type;

export { CommitmentProtectionConflict } from './commitment-protection-conflict.ts';
export { CommitmentProtectionRejected } from './commitment-protection-rejected.ts';
export { CommitmentProtectionUnavailable } from './commitment-protection-unavailable.ts';

export interface CommitmentProtectionPersistence {
  readonly createOrRead: (
    candidate: CommitmentProtection,
  ) => EffectType.Effect<
    { readonly outcome: 'INSERTED' | 'EXISTING'; readonly protection: CommitmentProtection },
    EstablishCommitmentProtectionError
  >;
  readonly findByRef: (
    ref: typeof CommitmentProtectionRefSchema.Type,
  ) => EffectType.Effect<Option.Option<CommitmentProtection>, CommitmentProtectionUnavailable>;
  readonly findByReservationAttempt: (
    reservationId: string,
    attemptId: string,
  ) => EffectType.Effect<Option.Option<CommitmentProtection>, CommitmentProtectionUnavailable>;
  readonly readHistory: (
    ref: typeof CommitmentProtectionRefSchema.Type,
  ) => EffectType.Effect<readonly CommitmentProtection[], CommitmentProtectionUnavailable>;
  readonly saveRevision: (input: {
    readonly current: CommitmentProtection;
    readonly next: CommitmentProtection;
  }) => EffectType.Effect<CommitmentProtection, EstablishCommitmentProtectionError>;
}

const canonicalRequestSchema = Schema.fromJsonString(CommitmentProtectionEffectRequestSchema);
export const canonicalCommitmentProtectionRequest = (request: CommitmentProtectionEffectRequest): string =>
  Result.getOrThrow(Schema.encodeResult(canonicalRequestSchema)(request));

export const sameCommitmentProtectionRequest = (
  left: CommitmentProtectionEffectRequest,
  right: CommitmentProtectionEffectRequest,
): boolean => canonicalCommitmentProtectionRequest(left) === canonicalCommitmentProtectionRequest(right);

const rejected = (
  effectId: typeof ReservationAuthorityEffectIdSchema.Type,
  reason: CommitmentProtectionRejected['reason'],
) => new CommitmentProtectionRejected({ code: 'commitment_protection_rejected', effectId, reason });

const sameReference = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

export const establishCommitmentProtection = Effect.fn('CommitmentProtection.establish')(function* establish(input: {
  readonly authorityEvidence: typeof AuthoritativeReservationEvidenceSchema.Type;
  readonly confirmation: typeof ReservationConfirmationSchema.Type;
  readonly protectionRef: typeof CommitmentProtectionRefSchema.Type;
}) {
  const { authorityEvidence, confirmation, protectionRef } = input;
  if (String(protectionRef.tenantId) !== String(confirmation.ref.tenantId)) {
    return yield* rejected(authorityEvidence.effectId, 'TENANT_SCOPE_MISMATCH');
  }
  if (
    authorityEvidence.operation !== 'COMMITMENT_PROTECTION' ||
    authorityEvidence.issuer.backend !== confirmation.authorityEvidence.issuer.backend ||
    authorityEvidence.issuer.backendId !== confirmation.authorityEvidence.issuer.backendId ||
    authorityEvidence.issuer.origin !== confirmation.authorityEvidence.issuer.origin
  ) {
    return yield* rejected(authorityEvidence.effectId, 'AUTHORITY_SCOPE_MISMATCH');
  }
  const expectedAllocations = confirmation.reservation.requirements.flatMap(({ allocations }) => allocations);
  const actualAllocations = authorityEvidence.evidence.allocations;
  const proofMatches =
    String(authorityEvidence.evidence.tenantId) === String(confirmation.ref.tenantId) &&
    authorityEvidence.evidence.reservationId === confirmation.reservation.ref.resourceId &&
    authorityEvidence.evidence.attemptId === confirmation.reservation.origin.attemptId &&
    authorityEvidence.evidence.customerConfigurationId === confirmation.reservation.authority.customerConfigurationId &&
    expectedAllocations.length === actualAllocations.length &&
    expectedAllocations.every((expected) =>
      actualAllocations.some(
        (actual) =>
          String(expected.allocationId) === String(actual.allocationId) &&
          expected.quantity.amount === actual.quantity.amount &&
          sameReference(expected.quantity.unitRef, actual.quantity.unitRef) &&
          sameReference(expected.stockItemRef, actual.stockItemRef) &&
          sameReference(expected.positionRef, actual.stockPositionRef),
      ),
    );
  if (!proofMatches) {
    return yield* rejected(authorityEvidence.effectId, 'PROOF_SCOPE_MISMATCH');
  }
  return yield* Schema.decodeEffect(CommitmentProtectionSchema)({
    authorityEvidence,
    confirmation,
    establishedAt: authorityEvidence.evidence.validFrom,
    health: {
      observation: {
        _tag: 'ESTABLISHED',
        effectiveAt: authorityEvidence.evidence.validFrom,
        ownerEvidenceRef: authorityEvidence.evidence.ownerEvidenceRef,
      },
      reconciliationRequired: false,
      state: 'PROTECTED',
    },
    ref: protectionRef,
    revision: 1,
  }).pipe(
    Effect.mapError((cause) => Object.assign(rejected(authorityEvidence.effectId, 'INVALID_PROTECTION'), { cause })),
  );
});

export const markCommitmentProtectionAtRisk = Effect.fn('CommitmentProtection.markAtRisk')(function* markAtRisk(
  current: CommitmentProtection,
  observation: Exclude<typeof CommitmentProtectionHealthObservationSchema.Type, { readonly _tag: 'ESTABLISHED' }>,
) {
  if (observation.effectiveAt < current.establishedAt) {
    return yield* rejected(current.authorityEvidence.effectId, 'INVALID_PROTECTION');
  }
  return yield* Schema.decodeEffect(CommitmentProtectionSchema)({
    ...current,
    health: { observation, reconciliationRequired: true, state: 'AT_RISK' },
    revision: current.revision + 1,
  }).pipe(
    Effect.mapError((cause) =>
      Object.assign(rejected(current.authorityEvidence.effectId, 'INVALID_PROTECTION'), { cause }),
    ),
  );
});
