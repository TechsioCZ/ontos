import { Effect, Result, Schema } from 'effect';

import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import { ProvisionalInventoryReservationSchema } from './inventory-obligation.ts';
import type { ProvisionalInventoryReservation } from './inventory-obligation.ts';
import {
  EstablishedReservationCreateEffectSchema,
  ReservationCreateEffectSchema,
  ResolvedNoReservationCreateEffectSchema,
} from './inventory-reservation-create.ts';
import type { ReservationCreateEffect } from './inventory-reservation-create.ts';
import {
  ReleasedReservationEffectSchema,
  ReservationReleaseCommittedTruthSchema,
  ReservationReleaseEffectSchema,
  ReservationReleaseEffectIdSchema,
  ReservationReleaseNotCommittedClosedTruthSchema,
  ReservationReleaseNotCommittedOpenTruthSchema,
  ReservationReleaseOrderIndeterminateTruthSchema,
  ReservationReleaseOrderTruthSchema,
} from './inventory-reservation-release.ts';
import type { ReservationReleaseOrderTruth } from './inventory-reservation-release.ts';
import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';
import { OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const InventoryAttemptReplacementCauseSchema = Schema.Literals([
  'FAILED',
  'ABANDONED',
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_REVOKED',
]);

export const InventoryReplacementAttemptSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  authority: InventoryBackendConfigurationSchema,
  createEffectId: ReservationAuthorityEffectIdSchema,
  reservationRef: InventoryReservationRefSchema,
});
export type InventoryReplacementAttempt = typeof InventoryReplacementAttemptSchema.Type;

export const InventoryAttemptReplacementEvaluationSchema = Schema.Struct({
  evaluatedAt: instant,
  orderTruth: ReservationReleaseOrderTruthSchema,
  predecessorCreateEffect: ReservationCreateEffectSchema,
  predecessorReleaseEffect: Schema.optionalKey(ReservationReleaseEffectSchema),
  replacement: InventoryReplacementAttemptSchema,
  replacementCause: InventoryAttemptReplacementCauseSchema,
});
export type InventoryAttemptReplacementEvaluation = typeof InventoryAttemptReplacementEvaluationSchema.Type;

const predecessorIdentityFields = {
  attemptId: OrderCommitmentAttemptIdSchema,
  authority: InventoryBackendConfigurationSchema,
  createEffectId: ReservationAuthorityEffectIdSchema,
  reservationRef: InventoryReservationRefSchema,
} as const;

export const InventoryAttemptReplacementLineageSchema = Schema.Struct({
  closureProof: ReservationReleaseNotCommittedClosedTruthSchema,
  establishedAt: instant,
  predecessor: Schema.Struct(predecessorIdentityFields),
  predecessorResolution: Schema.Union([
    Schema.TaggedStruct('NO_RESERVATION_PROVEN', {
      effectAbsenceProven: Schema.Literal(true),
      observedAt: instant,
    }),
    Schema.TaggedStruct('RESERVATION_RELEASED', {
      ownerEvidenceRef: boundedText,
      releasedAt: instant,
      releaseEffectId: ReservationReleaseEffectIdSchema,
    }),
  ]),
  replacement: Schema.Struct(predecessorIdentityFields),
  replacementCause: InventoryAttemptReplacementCauseSchema,
});
export type InventoryAttemptReplacementLineage = typeof InventoryAttemptReplacementLineageSchema.Type;

export const InventoryAttemptReplacementBlockedSchema = Schema.TaggedStruct('BLOCKED', {
  debtAttemptId: OrderCommitmentAttemptIdSchema,
  evaluatedAt: instant,
  reason: Schema.Literals([
    'PREDECESSOR_COMMITTED',
    'PREDECESSOR_NOT_CLOSED',
    'PREDECESSOR_TRUTH_INDETERMINATE',
    'PREDECESSOR_CREATE_EFFECT_UNRESOLVED',
    'PREDECESSOR_RESERVATION_UNRESOLVED',
  ]),
  replacementAllowed: Schema.Literal(false),
});

export const InventoryAttemptReplacementEligibleSchema = Schema.TaggedStruct('ELIGIBLE', {
  lineage: InventoryAttemptReplacementLineageSchema,
  replacementAllowed: Schema.Literal(true),
});

export const InventoryAttemptReplacementDecisionSchema = Schema.Union([
  InventoryAttemptReplacementBlockedSchema,
  InventoryAttemptReplacementEligibleSchema,
]);
export type InventoryAttemptReplacementDecision = typeof InventoryAttemptReplacementDecisionSchema.Type;

export class InventoryAttemptReplacementRejected extends Schema.TaggedError<InventoryAttemptReplacementRejected>()(
  'InventoryAttemptReplacementRejected',
  {
    code: Schema.Literal('inventory_attempt_replacement_rejected'),
    reason: Schema.Literals([
      'ATTEMPT_IDENTITY_REUSED',
      'RESERVATION_IDENTITY_REUSED',
      'CREATE_EFFECT_IDENTITY_REUSED',
      'TENANT_SCOPE_MISMATCH',
      'BACKEND_SWITCH_REQUIRES_CUTOVER',
      'PREDECESSOR_RESOLUTION_SCOPE_MISMATCH',
    ]),
  },
) {}

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

const sameAuthority = (
  left: typeof InventoryBackendConfigurationSchema.Type,
  right: typeof InventoryBackendConfigurationSchema.Type,
) =>
  left.configurationId === right.configurationId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.revision === right.revision &&
  left.selectedAt === right.selectedAt &&
  left.tenantId === right.tenantId &&
  left.selection.backend === right.selection.backend &&
  left.selection.backendId === right.selection.backendId &&
  left.selection.exactReservationCapability === right.selection.exactReservationCapability &&
  left.selection.stockCorrectionCapability === right.selection.stockCorrectionCapability;

const reject = (reason: InventoryAttemptReplacementRejected['reason']) =>
  Effect.fail(new InventoryAttemptReplacementRejected({ code: 'inventory_attempt_replacement_rejected', reason }));

const blocked = (
  attemptId: typeof OrderCommitmentAttemptIdSchema.Type,
  evaluatedAt: string,
  reason: (typeof InventoryAttemptReplacementBlockedSchema.Type)['reason'],
): InventoryAttemptReplacementDecision => ({
  _tag: 'BLOCKED',
  debtAttemptId: attemptId,
  evaluatedAt,
  reason,
  replacementAllowed: false,
});

const requireDistinctReplacementIdentity = (
  predecessor: ReservationCreateEffect,
  replacement: InventoryReplacementAttempt,
) => {
  const { request } = predecessor;
  if (request.reservation.origin.attemptId === replacement.attemptId) {
    return reject('ATTEMPT_IDENTITY_REUSED');
  }
  if (sameRef(request.reservation.ref, replacement.reservationRef)) {
    return reject('RESERVATION_IDENTITY_REUSED');
  }
  if (request.effectId === replacement.createEffectId) {
    return reject('CREATE_EFFECT_IDENTITY_REUSED');
  }
  if (
    request.reservation.ref.tenantId !== replacement.reservationRef.tenantId ||
    request.authority.tenantId !== replacement.authority.tenantId
  ) {
    return reject('TENANT_SCOPE_MISMATCH');
  }
  if (!sameAuthority(request.authority, replacement.authority)) {
    return reject('BACKEND_SWITCH_REQUIRES_CUTOVER');
  }
  return Effect.void;
};

const canonicalReservationSchema = Schema.fromJsonString(ProvisionalInventoryReservationSchema);
const canonicalReservation = (reservation: ProvisionalInventoryReservation) =>
  Result.getOrThrow(Schema.encodeResult(canonicalReservationSchema)(reservation));

const issuerMatchesAuthority = (
  authority: typeof InventoryBackendConfigurationSchema.Type,
  issuer: (typeof ReleasedReservationEffectSchema.Type)['authorityIssuer'],
) =>
  issuer.backend === authority.selection.backend &&
  issuer.backendId === authority.selection.backendId &&
  issuer.origin ===
    (authority.selection.backend === 'external_business_system' ? 'EXTERNAL_BUSINESS_SYSTEM' : 'ONTOS_WMS');

const releaseMatchesPredecessor = (
  createEffect: typeof EstablishedReservationCreateEffectSchema.Type,
  releaseEffect: typeof ReleasedReservationEffectSchema.Type,
  closureProof: typeof ReservationReleaseNotCommittedClosedTruthSchema.Type,
) =>
  releaseEffect.safelyReusable &&
  releaseEffect.request.legalEntityId === createEffect.request.legalEntityId &&
  canonicalReservation(releaseEffect.request.reservation) === canonicalReservation(createEffect.reservation) &&
  issuerMatchesAuthority(createEffect.request.authority, releaseEffect.authorityIssuer) &&
  releaseEffect.safeReleaseProof.order.closureEvidenceRef === closureProof.closureEvidenceRef &&
  releaseEffect.safeReleaseProof.order.nonCommitEvidenceRef === closureProof.nonCommitEvidenceRef &&
  releaseEffect.safeReleaseProof.order.observedAt === closureProof.observedAt;

export const evaluateInventoryAttemptReplacement = Effect.fn('InventoryAttemptReplacement.evaluate')(
  function* evaluateInventoryAttemptReplacement(
    input: InventoryAttemptReplacementEvaluation,
  ): Effect.fn.Return<InventoryAttemptReplacementDecision, InventoryAttemptReplacementRejected> {
    const { predecessorCreateEffect: predecessor, replacement } = input;
    yield* requireDistinctReplacementIdentity(predecessor, input.replacement);
    const { request } = predecessor;
    const { attemptId } = request.reservation.origin;

    if (Schema.is(ReservationReleaseCommittedTruthSchema)(input.orderTruth)) {
      return blocked(attemptId, input.evaluatedAt, 'PREDECESSOR_COMMITTED');
    }
    if (Schema.is(ReservationReleaseNotCommittedOpenTruthSchema)(input.orderTruth)) {
      return blocked(attemptId, input.evaluatedAt, 'PREDECESSOR_NOT_CLOSED');
    }
    if (Schema.is(ReservationReleaseOrderIndeterminateTruthSchema)(input.orderTruth)) {
      return blocked(attemptId, input.evaluatedAt, 'PREDECESSOR_TRUTH_INDETERMINATE');
    }
    const closureProof = input.orderTruth;

    let predecessorResolution: (typeof InventoryAttemptReplacementLineageSchema.Type)['predecessorResolution'];
    if (Schema.is(ResolvedNoReservationCreateEffectSchema)(predecessor)) {
      predecessorResolution = {
        _tag: 'NO_RESERVATION_PROVEN',
        effectAbsenceProven: predecessor.effectAbsenceProven,
        observedAt: predecessor.observedAt,
      };
    } else if (Schema.is(EstablishedReservationCreateEffectSchema)(predecessor)) {
      const release = input.predecessorReleaseEffect;
      if (release === undefined || !Schema.is(ReleasedReservationEffectSchema)(release)) {
        return blocked(attemptId, input.evaluatedAt, 'PREDECESSOR_RESERVATION_UNRESOLVED');
      }
      if (!releaseMatchesPredecessor(predecessor, release, closureProof)) {
        return yield* reject('PREDECESSOR_RESOLUTION_SCOPE_MISMATCH');
      }
      predecessorResolution = {
        _tag: 'RESERVATION_RELEASED',
        ownerEvidenceRef: release.ownerEvidenceRef,
        releasedAt: release.releasedAt,
        releaseEffectId: release.request.effectId,
      };
    } else {
      return blocked(attemptId, input.evaluatedAt, 'PREDECESSOR_CREATE_EFFECT_UNRESOLVED');
    }

    return {
      _tag: 'ELIGIBLE',
      lineage: {
        closureProof,
        establishedAt: input.evaluatedAt,
        predecessor: {
          attemptId,
          authority: request.authority,
          createEffectId: request.effectId,
          reservationRef: request.reservation.ref,
        },
        predecessorResolution,
        replacement,
        replacementCause: input.replacementCause,
      },
      replacementAllowed: true,
    };
  },
);

export const InventoryLatePredecessorEffectSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  effectId: ReservationAuthorityEffectIdSchema,
  observedAt: instant,
  ownerEvidenceRef: boundedText,
  reservationRef: InventoryReservationRefSchema,
});

export const InventoryLatePredecessorEffectDecisionSchema = Schema.Struct({
  attributedAttemptId: OrderCommitmentAttemptIdSchema,
  committedOrderPreserved: Schema.Boolean,
  mayEvidenceReplacement: Schema.Literal(false),
  mayReopenPredecessor: Schema.Literal(false),
  outcome: Schema.Literals(['PREDECESSOR_RECONCILIATION_DEBT', 'REPLACEMENT_CONFLICT_DEBT']),
  replacementAttemptId: OrderCommitmentAttemptIdSchema,
});
export type InventoryLatePredecessorEffectDecision = typeof InventoryLatePredecessorEffectDecisionSchema.Type;

export const classifyLatePredecessorEffect = (
  lineage: InventoryAttemptReplacementLineage,
  effect: typeof InventoryLatePredecessorEffectSchema.Type,
  orderTruth: ReservationReleaseOrderTruth,
): Effect.Effect<InventoryLatePredecessorEffectDecision, InventoryAttemptReplacementRejected> => {
  if (
    effect.attemptId !== lineage.predecessor.attemptId ||
    !sameRef(effect.reservationRef, lineage.predecessor.reservationRef)
  ) {
    return reject('PREDECESSOR_RESOLUTION_SCOPE_MISMATCH');
  }
  const committed = Schema.is(ReservationReleaseCommittedTruthSchema)(orderTruth);
  return Effect.succeed({
    attributedAttemptId: lineage.predecessor.attemptId,
    committedOrderPreserved: committed,
    mayEvidenceReplacement: false,
    mayReopenPredecessor: false,
    outcome: committed ? 'REPLACEMENT_CONFLICT_DEBT' : 'PREDECESSOR_RECONCILIATION_DEBT',
    replacementAttemptId: lineage.replacement.attemptId,
  });
};
