import { DateTime, Option, Schema } from 'effect';

import type { AuthoritativePrivacyRetentionRuleVersion } from './privacy-retention-rule.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const RuleVersionId = Ref.pipe(Schema.brand('RuleVersionId'));
const LegalEntityId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const Refs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128));
const OptionalRefs = Schema.Array(Ref).check(Schema.isMaxLength(128));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const RetentionEvaluationMessageIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrivacyRetentionEvaluationMessageId'),
);
const RetentionEvaluationSourceSchema = Schema.Literals(['PERIODIC', 'DSR_ERASURE']);

export const PrivacyDispositionOutcomeSchema = Schema.Literals(['RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE']);
export type PrivacyDispositionOutcome = typeof PrivacyDispositionOutcomeSchema.Type;

const DeterminateRetentionEvaluationStatusSchema = Schema.Literals(['READY', 'BLOCKED', 'COMPLETED']);
export type DeterminateRetentionEvaluationStatus = typeof DeterminateRetentionEvaluationStatusSchema.Type;

const ProtectionAuthorityKindSchema = Schema.Literals(['EXCEPTION_AUTHORITY', 'LEGAL_HOLD_AUTHORITY']);
export type ProtectionAuthorityKind = typeof ProtectionAuthorityKindSchema.Type;

/** Narrow request accepted from an Action caller; governance is resolved by an owner authority. */
export const RetentionProtectionRequestSchema = Schema.Struct({
  contentScopeRefs: Refs,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: PrivacyIsoTimestampSchema,
  protectionRef: Ref,
});
export type RetentionProtectionRequest = typeof RetentionProtectionRequestSchema.Type;

const ProtectionGovernanceFields = {
  actorPrincipalRef: Ref,
  authorityKind: ProtectionAuthorityKindSchema,
  authorityRef: Ref,
  controllerRef: Ref,
  evidenceRefs: Refs,
  policyRef: Ref,
  policyVersion: PositiveInteger,
  provenanceRef: Ref,
  reasonTypeRef: Ref,
  reasonTypeVersion: PositiveInteger,
  releaseConditionRef: Schema.OptionFromNullOr(Ref),
  releasedAt: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  releasedByPrincipalRef: Schema.OptionFromNullOr(Ref),
  releaseEvidenceRefs: OptionalRefs,
  releaseReasonRef: Schema.OptionFromNullOr(Ref),
  releaseRef: Schema.OptionFromNullOr(Ref),
  reviewDueAt: PrivacyIsoTimestampSchema,
  reviewedAt: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  reviewEvidenceRefs: OptionalRefs,
  reviewRef: Ref,
} as const;

export const RetentionEvaluationRequestSchema = Schema.Struct({
  contentScopeRef: Ref,
  ruleRef: Ref,
  ruleVersion: PositiveInteger,
  ruleVersionId: RuleVersionId,
  source: RetentionEvaluationSourceSchema,
});
export type RetentionEvaluationRequest = typeof RetentionEvaluationRequestSchema.Type;

const RetentionEvaluationWorkFields = {
  businessStartAt: PrivacyIsoTimestampSchema,
  businessStartRef: Ref,
  contentScopeRefs: Refs,
  controllerRef: Ref,
  dispositionOutcome: PrivacyDispositionOutcomeSchema,
  dueAt: PrivacyIsoTimestampSchema,
  evaluatedAt: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  evidenceRefs: Refs,
  idempotencyRef: Ref,
  policyRef: Ref,
  policyVersion: PositiveInteger,
  provenanceRef: Ref,
  ruleAuthorityRef: Ref,
  ruleRef: Ref,
  ruleVersion: PositiveInteger,
  ruleVersionId: RuleVersionId,
  source: RetentionEvaluationSourceSchema,
  status: Schema.Literals(['PENDING', 'READY', 'BLOCKED', 'INDETERMINATE', 'COMPLETED']),
  workRef: Ref,
} as const;

export const RetentionEvaluationWorkSchema = Schema.Struct(RetentionEvaluationWorkFields);
export type RetentionEvaluationWork = typeof RetentionEvaluationWorkSchema.Type;

export const RetentionWorkerEvaluationEvidenceSchema = Schema.Struct({
  blockerRefs: OptionalRefs,
  controllerRef: Ref,
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluationRef: Ref,
  evidenceRefs: Refs,
  messageId: RetentionEvaluationMessageIdSchema,
  outcome: PrivacyDispositionOutcomeSchema,
  ownerOutcomeRef: Schema.OptionFromNullOr(Ref),
  policyRef: Ref,
  policyVersion: PositiveInteger,
  provenanceRef: Ref,
});
export type RetentionWorkerEvaluationEvidence = typeof RetentionWorkerEvaluationEvidenceSchema.Type;

export const ProcessedRetentionEvaluationWorkSchema = Schema.Struct({
  ...RetentionEvaluationWorkFields,
  workerEvaluation: RetentionWorkerEvaluationEvidenceSchema,
});
export type ProcessedRetentionEvaluationWork = typeof ProcessedRetentionEvaluationWorkSchema.Type;

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
  ...ProtectionGovernanceFields,
  contentScopeRefs: Refs,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: PrivacyIsoTimestampSchema,
  exceptionRef: Ref,
}).check(
  Schema.makeFilter((value) =>
    value.authorityKind === 'EXCEPTION_AUTHORITY'
      ? undefined
      : [{ issue: 'Retention Exception must use Exception Authority', path: ['authorityKind'] }],
  ),
);
export type RetentionException = typeof RetentionExceptionSchema.Type;

export const PrivacyLegalHoldSchema = Schema.Struct({
  ...ProtectionGovernanceFields,
  contentScopeRefs: Refs,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: PrivacyIsoTimestampSchema,
  holdRef: Ref,
}).check(
  Schema.makeFilter((value) =>
    value.authorityKind === 'LEGAL_HOLD_AUTHORITY'
      ? undefined
      : [{ issue: 'Legal Hold must use Legal Hold Authority', path: ['authorityKind'] }],
  ),
);
export type PrivacyLegalHold = typeof PrivacyLegalHoldSchema.Type;

export const RetentionEvaluationSchema = Schema.Struct({
  blockerRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  contentScopeRefs: Refs,
  controllerRef: Ref,
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluationRef: Ref,
  evidenceRefs: Refs,
  outcome: PrivacyDispositionOutcomeSchema,
  policyRef: Ref,
  policyVersion: PositiveInteger,
  provenanceRef: Ref,
  ruleRef: Ref,
  ruleVersion: PositiveInteger,
  ruleVersionId: RuleVersionId,
  status: DeterminateRetentionEvaluationStatusSchema,
});
export type RetentionEvaluation = typeof RetentionEvaluationSchema.Type;
const retentionEvaluationEquivalent = Schema.toEquivalence(RetentionEvaluationSchema);

export const PrivacyDispositionDecisionSchema = Schema.Struct({
  actorPrincipalRef: Ref,
  authorityRef: Ref,
  blockerRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  contentScopeRefs: Refs,
  controllerRef: Ref,
  decidedAt: PrivacyIsoTimestampSchema,
  decisionRef: Ref,
  evaluationRef: Ref,
  evidenceRefs: Refs,
  outcome: PrivacyDispositionOutcomeSchema,
  ownerExecutionOutcomeRef: Schema.OptionFromNullOr(Ref),
  policyRef: Ref,
  policyVersion: PositiveInteger,
  provenanceRef: Ref,
  reasonRefs: Refs,
  ruleRef: Ref,
  ruleVersion: PositiveInteger,
  ruleVersionId: RuleVersionId,
});
export type PrivacyDispositionDecision = typeof PrivacyDispositionDecisionSchema.Type;

/** Public input identifies the evaluation and idempotent decision intent only. */
export const PrivacyDispositionDecisionRequestSchema = Schema.Struct({
  decisionRef: Ref,
  evaluationRef: Ref,
});
export type PrivacyDispositionDecisionRequest = typeof PrivacyDispositionDecisionRequestSchema.Type;

/** Private governance result binds the outcome to the exact current evaluation. */
export const PrivacyDispositionDecisionAuthorityResultSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  decision: PrivacyDispositionDecisionSchema,
  evaluation: RetentionEvaluationSchema,
  legalEntityId: LegalEntityId,
  status: Schema.Literals(['CURRENT', 'STALE', 'CONFLICT', 'UNAVAILABLE']),
  tenantId: TenantId,
});
export type PrivacyDispositionDecisionAuthorityResult = typeof PrivacyDispositionDecisionAuthorityResultSchema.Type;

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

/** Retention scheduling is derived from the persisted rule and its trusted business-start instant. */
export const calculateRetentionEvaluationDueAt = (
  rule: AuthoritativePrivacyRetentionRuleVersion,
): RetentionEvaluationWork['dueAt'] => {
  if (rule.retentionWindow.kind === 'END_AT') {
    return rule.retentionWindow.endAt;
  }
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(rule.businessStartAt), { days: rule.retentionWindow.durationDays }),
  );
};

export const makeRetentionEvaluationWork = (input: {
  readonly rule: AuthoritativePrivacyRetentionRuleVersion;
  readonly source: RetentionEvaluationWork['source'];
}): RetentionEvaluationWork => {
  const { rule } = input;
  const dueAt = calculateRetentionEvaluationDueAt(rule);
  const contentScopeRefs = [rule.contentScopeRef];
  const identity = [
    rule.ruleRef,
    rule.ruleVersion,
    rule.policyRef,
    rule.policyVersion,
    rule.controllerRef,
    rule.contentScopeRef,
    rule.businessStartRef,
    dueAt,
  ].join(':');
  return {
    businessStartAt: rule.businessStartAt,
    businessStartRef: rule.businessStartRef,
    contentScopeRefs,
    controllerRef: rule.controllerRef,
    dispositionOutcome: rule.dispositionOutcome,
    dueAt,
    evaluatedAt: Option.none(),
    evidenceRefs: [...rule.evidenceRefs].toSorted(),
    idempotencyRef: identity,
    policyRef: rule.policyRef,
    policyVersion: rule.policyVersion,
    provenanceRef: rule.provenanceRef,
    ruleAuthorityRef: rule.authorityRef,
    ruleRef: rule.ruleRef,
    ruleVersion: rule.ruleVersion,
    ruleVersionId: rule.ruleVersionId,
    source: input.source,
    status: 'PENDING',
    workRef: `retention-work:${identity}`,
  };
};

export type RetentionEvaluationWorkPreparation =
  | { readonly valid: true; readonly work: RetentionEvaluationWork }
  | { readonly reasons: readonly string[]; readonly valid: false };

/** Builds persisted work only from an owner-resolved Rule Version and a narrow scheduling intent. */
export const prepareRetentionEvaluationWork = (
  rule: AuthoritativePrivacyRetentionRuleVersion,
  request: RetentionEvaluationRequest,
): RetentionEvaluationWorkPreparation => {
  const reasons: string[] = [];
  if (
    request.ruleRef !== rule.ruleRef ||
    request.ruleVersion !== rule.ruleVersion ||
    request.ruleVersionId !== rule.ruleVersionId
  ) {
    reasons.push('retention_evaluation_rule_identity_mismatch');
  }
  if (request.contentScopeRef !== rule.contentScopeRef) {
    reasons.push('retention_evaluation_content_scope_mismatch');
  }
  const work = makeRetentionEvaluationWork({ rule, source: request.source });
  const dueAt = DateTime.toEpochMillis(DateTime.makeUnsafe(work.dueAt));
  const effectiveFrom = DateTime.toEpochMillis(DateTime.makeUnsafe(rule.effectiveFrom));
  const effectiveTo = Option.match(rule.effectiveTo, {
    onNone: () => null,
    onSome: (value) => DateTime.toEpochMillis(DateTime.makeUnsafe(value)),
  });
  if (dueAt < effectiveFrom || (effectiveTo !== null && dueAt >= effectiveTo)) {
    reasons.push('retention_evaluation_rule_not_effective_at_due_time');
  }
  return reasons.length > 0 ? { reasons, valid: false } : { valid: true, work };
};

/** Scheduled and DSR-triggered evaluation share one idempotent work identity. */
export const sameRetentionEvaluationWork = (left: RetentionEvaluationWork, right: RetentionEvaluationWork): boolean =>
  left.idempotencyRef === right.idempotencyRef;

const exactRefs = (left: readonly string[], right: readonly string[]): boolean => {
  const sortedRight = right.toSorted();
  return left.length === right.length && left.toSorted().every((value, index) => value === sortedRight[index]);
};

const collectMismatches = (checks: readonly (readonly [boolean, string])[]): readonly string[] =>
  checks.flatMap(([valid, message]) => (valid ? [] : [message]));

const releaseFieldsPresent = (protection: RetentionException | PrivacyLegalHold): boolean =>
  Option.isSome(protection.releasedAt) &&
  Option.isSome(protection.releaseConditionRef) &&
  Option.isSome(protection.releaseRef) &&
  Option.isSome(protection.releaseReasonRef) &&
  Option.isSome(protection.releasedByPrincipalRef) &&
  protection.releaseEvidenceRefs.length > 0;

const releaseFieldsAbsent = (protection: RetentionException | PrivacyLegalHold): boolean =>
  Option.isNone(protection.releasedAt) &&
  Option.isNone(protection.releaseConditionRef) &&
  Option.isNone(protection.releaseRef) &&
  Option.isNone(protection.releaseReasonRef) &&
  Option.isNone(protection.releasedByPrincipalRef) &&
  protection.releaseEvidenceRefs.length === 0;

export type RetentionProtectionValidation =
  | { readonly valid: true }
  | { readonly errors: readonly string[]; readonly valid: false };

const protectionPeriodErrors = (protection: RetentionException | PrivacyLegalHold): readonly string[] => {
  const errors: string[] = [];
  if (protection.effectiveTo <= protection.effectiveFrom) {
    errors.push('Protection effective period must end after it starts');
  }
  if (protection.reviewDueAt < protection.effectiveFrom || protection.reviewDueAt >= protection.effectiveTo) {
    errors.push('Protection review due time must be inside its effective period');
  }
  return errors;
};

const protectionReleaseErrors = (protection: RetentionException | PrivacyLegalHold): readonly string[] => {
  const released = Option.isSome(protection.releasedAt);
  if ((released && !releaseFieldsPresent(protection)) || (!released && !releaseFieldsAbsent(protection))) {
    return ['Release requires release time, reason, actor, reference, and evidence together'];
  }
  if (released && Option.getOrThrow(protection.releasedAt) < protection.effectiveFrom) {
    return ['Protection cannot be released before it becomes effective'];
  }
  return [];
};

const protectionReviewErrors = (protection: RetentionException | PrivacyLegalHold): readonly string[] => {
  const reviewed = Option.isSome(protection.reviewedAt);
  return reviewed === protection.reviewEvidenceRefs.length > 0
    ? []
    : ['A recorded review requires review evidence, and review evidence requires a review time'];
};

export const validateRetentionProtection = (
  protection: RetentionException | PrivacyLegalHold,
): RetentionProtectionValidation => {
  const errors = [
    ...protectionPeriodErrors(protection),
    ...protectionReleaseErrors(protection),
    ...protectionReviewErrors(protection),
  ];
  return errors.length === 0 ? { valid: true } : { errors, valid: false };
};

export type PrivacyDispositionDecisionValidation =
  | { readonly valid: true }
  | { readonly errors: readonly string[]; readonly valid: false };

export const validateRetentionEvaluationAgainstWork = (
  evaluation: RetentionEvaluation,
  work: RetentionEvaluationWork,
): PrivacyDispositionDecisionValidation => {
  const errors = collectMismatches([
    [evaluation.evaluationRef === work.workRef, 'Retention Evaluation reference does not match work'],
    [
      evaluation.ruleRef === work.ruleRef &&
        evaluation.ruleVersion === work.ruleVersion &&
        evaluation.ruleVersionId === work.ruleVersionId,
      'Retention Evaluation rule does not match work',
    ],
    [evaluation.controllerRef === work.controllerRef, 'Retention Evaluation controller does not match work'],
    [
      evaluation.policyRef === work.policyRef && evaluation.policyVersion === work.policyVersion,
      'Retention Evaluation policy does not match work',
    ],
    [evaluation.outcome === work.dispositionOutcome, 'Retention Evaluation outcome does not match work'],
    [evaluation.provenanceRef === work.provenanceRef, 'Retention Evaluation provenance does not match work'],
    [
      exactRefs(evaluation.contentScopeRefs, work.contentScopeRefs),
      'Retention Evaluation content scope does not match work',
    ],
    [exactRefs(evaluation.evidenceRefs, work.evidenceRefs), 'Retention Evaluation evidence does not match work'],
    [evaluation.evaluatedAt >= work.dueAt, 'Retention Evaluation predates due work'],
  ]);
  return errors.length === 0 ? { valid: true } : { errors, valid: false };
};

const validateDispositionFields = (
  decision: PrivacyDispositionDecision,
  evaluation: RetentionEvaluation,
): readonly string[] =>
  collectMismatches([
    [decision.evaluationRef === evaluation.evaluationRef, 'Disposition Decision evaluation reference mismatch'],
    [decision.outcome === evaluation.outcome, 'Disposition Decision outcome does not match evaluation'],
    [
      decision.ruleRef === evaluation.ruleRef &&
        decision.ruleVersion === evaluation.ruleVersion &&
        decision.ruleVersionId === evaluation.ruleVersionId,
      'Disposition Decision rule does not match evaluation',
    ],
    [decision.controllerRef === evaluation.controllerRef, 'Disposition Decision controller does not match evaluation'],
    [
      decision.policyRef === evaluation.policyRef && decision.policyVersion === evaluation.policyVersion,
      'Disposition Decision policy does not match evaluation',
    ],
    [decision.provenanceRef === evaluation.provenanceRef, 'Disposition Decision provenance does not match evaluation'],
    [
      exactRefs(decision.contentScopeRefs, evaluation.contentScopeRefs),
      'Disposition Decision content scope does not match evaluation',
    ],
    [exactRefs(decision.blockerRefs, evaluation.blockerRefs), 'Disposition Decision blockers do not match evaluation'],
    [
      exactRefs(decision.evidenceRefs, evaluation.evidenceRefs),
      'Disposition Decision evidence does not match evaluation',
    ],
    [decision.decidedAt >= evaluation.evaluatedAt, 'Disposition Decision predates its evaluation'],
  ]);

export const validateDispositionDecisionAgainstEvaluation = (
  decision: PrivacyDispositionDecision,
  evaluation: RetentionEvaluation,
): PrivacyDispositionDecisionValidation => {
  const errors = ['READY', 'BLOCKED', 'COMPLETED'].includes(evaluation.status)
    ? validateDispositionFields(decision, evaluation)
    : [];
  return errors.length === 0 ? { valid: true } : { errors, valid: false };
};

const validateDispositionAuthorityCurrentness = (
  authority: PrivacyDispositionDecisionAuthorityResult,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
): string | undefined => {
  if (authority.status !== 'CURRENT') {
    return `Retention Disposition governance is ${authority.status.toLowerCase()}`;
  }
  if (authority.asOf !== asOf || authority.tenantId !== tenantId || authority.legalEntityId !== legalEntityId) {
    return 'Retention Disposition governance does not match the exact Tenant, Legal Entity, or as-of time';
  }
  return undefined;
};

const validateDispositionAuthorityEvaluation = (
  authority: PrivacyDispositionDecisionAuthorityResult,
  evaluation: RetentionEvaluation,
): string | undefined => {
  if (
    authority.evaluation.evaluationRef !== evaluation.evaluationRef ||
    authority.evaluation.evaluatedAt !== evaluation.evaluatedAt ||
    authority.evaluation.status !== evaluation.status ||
    !retentionEvaluationEquivalent(authority.evaluation, evaluation)
  ) {
    return 'Retention Disposition governance does not match the exact current evaluation';
  }
  return undefined;
};

const validateDispositionAuthorityDecision = (
  request: PrivacyDispositionDecisionRequest,
  authority: PrivacyDispositionDecisionAuthorityResult,
  evaluation: RetentionEvaluation,
  principalId: string,
  asOf: string,
): string | undefined => {
  const { decision } = authority;
  if (
    decision.decisionRef !== request.decisionRef ||
    decision.evaluationRef !== request.evaluationRef ||
    decision.actorPrincipalRef !== principalId ||
    decision.decidedAt !== asOf ||
    decision.authorityRef.length === 0 ||
    decision.reasonRefs.length === 0 ||
    decision.evidenceRefs.length === 0
  ) {
    return 'Retention Disposition governance did not provide an exact trusted decision identity or provenance';
  }
  const validation = validateDispositionDecisionAgainstEvaluation(decision, evaluation);
  return validation.valid ? undefined : validation.errors.join('; ');
};

/** Validates a trusted disposition verdict and its exact current evaluation. */
export const validateDispositionDecisionAuthorityResult = (
  request: PrivacyDispositionDecisionRequest,
  authority: PrivacyDispositionDecisionAuthorityResult,
  evaluation: RetentionEvaluation,
  principalId: string,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
): string | undefined =>
  validateDispositionAuthorityCurrentness(authority, tenantId, legalEntityId, asOf) ??
  validateDispositionAuthorityEvaluation(authority, evaluation) ??
  validateDispositionAuthorityDecision(request, authority, evaluation, principalId, asOf);

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
