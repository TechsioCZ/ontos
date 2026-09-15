import { Option, Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Refs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const RetentionEvaluationWorkSchema = Schema.Struct({
  contentScopeRefs: Refs,
  dueAt: PrivacyIsoTimestampSchema,
  evaluatedAt: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  idempotencyRef: Ref,
  ruleRef: Ref,
  ruleVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  source: Schema.Literals(['PERIODIC', 'DSR_ERASURE']),
  status: Schema.Literals(['PENDING', 'READY', 'BLOCKED', 'INDETERMINATE', 'COMPLETED']),
  workRef: Ref,
});
export type RetentionEvaluationWork = typeof RetentionEvaluationWorkSchema.Type;

export const RetentionBlockerSchema = Schema.Struct({
  blockerRef: Ref,
  contentScopeRefs: Refs,
  current: Schema.Boolean,
  kind: Schema.Literals(['RETENTION_EXCEPTION', 'LEGAL_HOLD', 'OBJECT_LOCK', 'UNKNOWN']),
  observedAt: PrivacyIsoTimestampSchema,
  revision: Ref,
});
export type RetentionBlocker = typeof RetentionBlockerSchema.Type;

export const RetentionBlockerAssessmentSchema = Schema.Struct({
  blockerRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  status: Schema.Literals(['READY', 'BLOCKED', 'INDETERMINATE']),
});
export type RetentionBlockerAssessment = typeof RetentionBlockerAssessmentSchema.Type;

export const RetentionExceptionSchema = Schema.Struct({
  authorityRef: Ref,
  contentScopeRefs: Refs,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: PrivacyIsoTimestampSchema,
  exceptionRef: Ref,
  releasedAt: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  reviewRef: Ref,
});
export type RetentionException = typeof RetentionExceptionSchema.Type;

export const PrivacyLegalHoldSchema = Schema.Struct({
  authorityRef: Ref,
  contentScopeRefs: Refs,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: PrivacyIsoTimestampSchema,
  holdRef: Ref,
  releasedAt: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  reviewRef: Ref,
});
export type PrivacyLegalHold = typeof PrivacyLegalHoldSchema.Type;

export const PrivacyDispositionDecisionSchema = Schema.Struct({
  blockerRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  contentScopeRefs: Refs,
  decidedAt: PrivacyIsoTimestampSchema,
  decisionRef: Ref,
  evidenceRefs: Refs,
  outcome: Schema.Literals(['RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE', 'INDETERMINATE']),
  ownerExecutionOutcomeRef: Schema.OptionFromNullOr(Ref),
  reasonRefs: Refs,
  ruleRef: Ref,
  ruleVersion: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PrivacyDispositionDecision = typeof PrivacyDispositionDecisionSchema.Type;

export const HistoricalEvidenceBoundarySchema = Schema.Struct({
  acceptedFactRef: Ref,
  contentDisposed: Schema.Boolean,
  dispositionEvidenceRef: Schema.OptionFromNullOr(Ref),
  historicalArtifactRef: Ref,
  immutableMeaningRef: Ref,
  payloadRetained: Schema.Boolean,
});
export type HistoricalEvidenceBoundary = typeof HistoricalEvidenceBoundarySchema.Type;

export const PrivacyEvidenceRetentionClassSchema = Schema.Literals([
  'CONSENT_HISTORY',
  'DSR_CASE',
  'DSR_VERIFICATION',
  'DELIVERY_EVIDENCE',
  'TEMPORARY_DSR_EXPORT',
  'PRIVACY_DECISION_EVIDENCE',
]);
export type PrivacyEvidenceRetentionClass = typeof PrivacyEvidenceRetentionClassSchema.Type;

export const makeRetentionEvaluationWork = (input: {
  readonly contentScopeRefs: readonly string[];
  readonly dueAt: RetentionEvaluationWork['dueAt'];
  readonly ruleRef: string;
  readonly ruleVersion: number;
  readonly source: RetentionEvaluationWork['source'];
}): RetentionEvaluationWork => {
  const contentScopeRefs = [...new Set(input.contentScopeRefs)].toSorted();
  const identity = `${input.ruleRef}:${input.ruleVersion}:${input.dueAt}:${contentScopeRefs.join('|')}`;
  return {
    contentScopeRefs,
    dueAt: input.dueAt,
    evaluatedAt: Option.none(),
    idempotencyRef: identity,
    ruleRef: input.ruleRef,
    ruleVersion: input.ruleVersion,
    source: input.source,
    status: 'PENDING',
    workRef: `retention-work:${identity}`,
  };
};

/** Scheduled and DSR-triggered evaluation share one idempotent work identity. */
export const sameRetentionEvaluationWork = (left: RetentionEvaluationWork, right: RetentionEvaluationWork): boolean =>
  left.idempotencyRef === right.idempotencyRef;

export const assessCurrentRetentionBlockers = (blockers: readonly RetentionBlocker[]): RetentionBlockerAssessment => {
  if (blockers.some(({ kind }) => kind === 'UNKNOWN')) {
    return { blockerRefs: blockers.map(({ blockerRef }) => blockerRef), status: 'INDETERMINATE' };
  }
  const activeBlockerRefs: string[] = [];
  for (const blocker of blockers) {
    if (blocker.current) {
      activeBlockerRefs.push(blocker.blockerRef);
    }
  }
  return activeBlockerRefs.length > 0
    ? { blockerRefs: activeBlockerRefs, status: 'BLOCKED' }
    : { blockerRefs: [], status: 'READY' };
};

export const isTimedRetentionProtectionActive = (
  protection: RetentionException | PrivacyLegalHold,
  at: RetentionEvaluationWork['dueAt'],
): boolean =>
  at >= protection.effectiveFrom &&
  at < protection.effectiveTo &&
  Option.match(protection.releasedAt, {
    onNone: () => true,
    onSome: (releasedAt) => at < releasedAt,
  });

/** DELETE remains a decision when storage blocks execution; execution outcome is recorded separately. */
export const withOwnerExecutionOutcome = (
  decision: PrivacyDispositionDecision,
  ownerExecutionOutcomeRef: string,
): PrivacyDispositionDecision => ({ ...decision, ownerExecutionOutcomeRef: Option.some(ownerExecutionOutcomeRef) });

/** Temporary export bytes never become proof that an approved response reached its recipient. */
export const privacyEvidenceCanProveDelivery = (retentionClass: PrivacyEvidenceRetentionClass): boolean =>
  retentionClass === 'DELIVERY_EVIDENCE';

export const historicalEvidenceSurvivesPayloadDisposition = (boundary: HistoricalEvidenceBoundary): boolean =>
  boundary.contentDisposed &&
  !boundary.payloadRetained &&
  boundary.immutableMeaningRef.length > 0 &&
  Option.isSome(boundary.dispositionEvidenceRef);
