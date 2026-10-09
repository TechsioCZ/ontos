import { Schema } from 'effect';

import { InventoryPreCommitCompensationRejected } from './inventory-pre-commit-compensation-rejected.ts';
import { InventoryPreCommitCompensationUnavailable } from './inventory-pre-commit-compensation-unavailable.ts';
import {
  ReservationCreateAllocationSchema,
  ReservationCreateEffectSchema,
  ResolvedNoReservationCreateEffectSchema,
} from './inventory-reservation-create.ts';
import { ReservationEvidenceIssuerSchema } from './reservation-authority.ts';
import { ReleaseInventoryReservationResultSchema } from './inventory-reservation-release.ts';
import { OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';
import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const CompensateInventoryPreCommitPayloadSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  authorizationTargetRef: InventoryReservationRefSchema,
  createEffectId: ReservationAuthorityEffectIdSchema,
});
export type CompensateInventoryPreCommitPayload = typeof CompensateInventoryPreCommitPayloadSchema.Type;

export const InventoryPreCommitCleanupObservationSchema = Schema.Union([
  Schema.TaggedStruct('CLEANED', {
    authorityIssuer: ReservationEvidenceIssuerSchema,
    cleanedAllocations: Schema.Array(ReservationCreateAllocationSchema),
    cleanedAt: instant,
    cleanupEvidenceRef: boundedText,
    effectAbsenceProven: Schema.Literal(true),
    effectId: ReservationAuthorityEffectIdSchema,
  }),
  Schema.TaggedStruct('ALREADY_CLEANED', {
    authorityIssuer: ReservationEvidenceIssuerSchema,
    cleanedAllocations: Schema.Array(ReservationCreateAllocationSchema),
    cleanedAt: instant,
    cleanupEvidenceRef: boundedText,
    effectAbsenceProven: Schema.Literal(true),
    effectId: ReservationAuthorityEffectIdSchema,
  }),
  Schema.TaggedStruct('INDETERMINATE', {
    effectId: ReservationAuthorityEffectIdSchema,
    observedAt: instant,
    reason: Schema.Literals(['AUTHORITY_OUTCOME_UNKNOWN', 'CLEANUP_EVIDENCE_UNAVAILABLE']),
  }),
]);
export type InventoryPreCommitCleanupObservation = typeof InventoryPreCommitCleanupObservationSchema.Type;

const blockedResult = Schema.Struct({
  effect: ReservationCreateEffectSchema,
  orderTruth: Schema.Union([
    Schema.TaggedStruct('COMMITTED', { evidenceRef: boundedText, observedAt: instant }),
    Schema.TaggedStruct('NOT_COMMITTED_OPEN', { evidenceRef: boundedText, observedAt: instant }),
    Schema.TaggedStruct('INDETERMINATE', {
      observedAt: instant,
      reason: Schema.Literals(['ORDER_EVIDENCE_MISSING', 'ORDER_EVIDENCE_UNAVAILABLE', 'ORDER_EVIDENCE_INDETERMINATE']),
    }),
  ]),
  outcome: Schema.Literal('BLOCKED'),
  reason: Schema.Literals(['ORDER_COMMITTED', 'ATTEMPT_NOT_CLOSED', 'ORDER_TRUTH_UNKNOWN']),
  safelyReusable: Schema.Literal(false),
});

export const CompensateInventoryPreCommitResultSchema = Schema.Union([
  Schema.Struct({
    effect: ResolvedNoReservationCreateEffectSchema,
    outcome: Schema.Literals(['CREATE_EFFECT_COMPENSATED', 'ALREADY_COMPENSATED']),
    safelyReusable: Schema.Literal(true),
  }),
  Schema.Struct({
    effect: ResolvedNoReservationCreateEffectSchema,
    outcome: Schema.Literal('NO_COMPENSATION_REQUIRED'),
    safelyReusable: Schema.Literal(true),
  }),
  Schema.Struct({
    createEffect: ReservationCreateEffectSchema,
    outcome: Schema.Literal('RESERVATION_RELEASE'),
    release: ReleaseInventoryReservationResultSchema,
  }),
  Schema.Struct({
    effect: ReservationCreateEffectSchema,
    observedAt: instant,
    outcome: Schema.Literal('RECONCILIATION_REQUIRED'),
    reason: Schema.Literal('CLEANUP_OUTCOME_UNKNOWN'),
    safelyReusable: Schema.Literal(false),
  }),
  blockedResult,
]);
export type CompensateInventoryPreCommitResult = typeof CompensateInventoryPreCommitResultSchema.Type;

export const CompensateInventoryPreCommitErrorSchema = Schema.Union([
  InventoryPreCommitCompensationRejected,
  InventoryPreCommitCompensationUnavailable,
]);
export type CompensateInventoryPreCommitError = typeof CompensateInventoryPreCommitErrorSchema.Type;

export { InventoryPreCommitCompensationRejected } from './inventory-pre-commit-compensation-rejected.ts';
export { InventoryPreCommitCompensationUnavailable } from './inventory-pre-commit-compensation-unavailable.ts';
