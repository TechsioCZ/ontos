/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Effect, Schema } from 'effect';

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Ref = Text;
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

export const PrivacyMeasureKindSchema = Schema.Literals(['RECTIFY', 'RESTRICT', 'ANONYMIZE', 'DELETE', 'EXPORT']);
export type PrivacyMeasureKind = typeof PrivacyMeasureKindSchema.Type;

/** The only payload the coordinator may send to an owning capability. */
export const PrivacyMeasureHandoffSchema = Schema.Struct({
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  controllerObligationRef: Schema.NullOr(Ref),
  dispositionDecision: Schema.NullOr(Schema.Literals(['RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE'])),
  expectedEvidenceRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  idempotencyKey: Ref,
  kind: PrivacyMeasureKindSchema,
  measureId: Ref,
  owningCapability: Ref,
  preconditionRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  requestedAt: Timestamp,
  requestedResult: Ref,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  right: Schema.NullOr(
    Schema.Literals(['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION']),
  ),
  sourceDecisionRef: Ref,
  sourceDecisionRevision: Revision,
  subjectRef: Ref,
  taskId: Ref,
  tenantId: Ref,
});
export type PrivacyMeasureHandoff = typeof PrivacyMeasureHandoffSchema.Type;

export const OwnerExecutionStatusSchema = Schema.Literals([
  'RECEIVED',
  'IN_PROGRESS',
  'SUCCEEDED',
  'PARTIAL',
  'BUSINESS_REJECTED',
  'NOT_APPLICABLE',
  'TECHNICAL_FAILED',
  'BLOCKED',
  'INDETERMINATE',
]);
export type OwnerExecutionStatus = typeof OwnerExecutionStatusSchema.Type;

export const OwnerExecutionOutcomeSchema = Schema.Struct({
  attempt: Revision,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMaxLength(128)),
  idempotencyKey: Ref,
  includedResourceRefs: Schema.Array(Ref).check(Schema.isMaxLength(256)),
  measureId: Ref,
  occurredAt: Timestamp,
  outcomeId: Ref,
  owningCapability: Ref,
  reason: Ref,
  recordedAt: Timestamp,
  remainingResourceRefs: Schema.Array(Ref).check(Schema.isMaxLength(256)),
  sourceDecisionRef: Ref,
  sourceDecisionRevision: Revision,
  status: OwnerExecutionStatusSchema,
  taskId: Ref,
});
export type OwnerExecutionOutcome = typeof OwnerExecutionOutcomeSchema.Type;

/** Public coordinator input identifies an attempt but cannot carry an owner result. */
export const OwnerExecutionOutcomeRequestSchema = Schema.Struct({
  attempt: Revision,
  measureId: Ref,
  taskId: Ref,
});
export type OwnerExecutionOutcomeRequest = typeof OwnerExecutionOutcomeRequestSchema.Type;

/**
 * A result returned by the private owner-authority seam. The coordinator may
 * persist it only after matching every identity and scope dimension against
 * the stored handoff.
 */
export const OwnerExecutionAuthorityResultSchema = Schema.Struct({
  authorityRef: Ref,
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  outcome: OwnerExecutionOutcomeSchema,
  receiptRef: Ref,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  subjectRef: Ref,
  tenantId: Ref,
});
export type OwnerExecutionAuthorityResult = typeof OwnerExecutionAuthorityResultSchema.Type;

export interface OwnerActionRequest {
  readonly actionKey: string;
  readonly handoff: PrivacyMeasureHandoff;
  readonly idempotencyKey: string;
}

export interface PrivacyMeasureAttempt {
  readonly attempt: number;
  readonly outcome: OwnerExecutionOutcome | null;
  readonly request: OwnerActionRequest;
  readonly startedAt: string;
}

export interface PrivacyMeasureDispatch {
  readonly attempts: readonly PrivacyMeasureAttempt[];
  readonly createdAt: string;
  readonly handoff: PrivacyMeasureHandoff;
  readonly status: OwnerExecutionStatus;
}

const unique = (refs: readonly string[]): string[] => [...new Set(refs)];
const stableKey = (parts: readonly string[]): string => parts.map((part) => `${String(part.length)}:${part}`).join('|');
const normalizeScope = (refs: readonly string[]): string[] => unique(refs).toSorted();
const sameScope = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((reference, index) => reference === normalizedRight[index])
  );
};
const overlaps = (left: readonly string[], right: readonly string[]): boolean => {
  const rightRefs = new Set(right);
  return left.some((reference) => rightRefs.has(reference));
};

const handoffFingerprint = (handoff: PrivacyMeasureHandoff): string =>
  stableKey([
    stableKey(handoff.contentScopeRefs.toSorted()),
    handoff.controllerObligationRef ?? '',
    handoff.dispositionDecision ?? '',
    stableKey(handoff.expectedEvidenceRefs.toSorted()),
    handoff.idempotencyKey,
    handoff.kind,
    handoff.measureId,
    handoff.owningCapability,
    stableKey(handoff.preconditionRefs.toSorted()),
    handoff.requestedAt,
    handoff.requestedResult,
    stableKey(handoff.resourceRefs.toSorted()),
    handoff.right ?? '',
    handoff.sourceDecisionRef,
    String(handoff.sourceDecisionRevision),
    handoff.subjectRef,
    handoff.taskId,
    handoff.tenantId,
  ]);

export class PrivacyMeasureInvariantError extends Schema.TaggedError<PrivacyMeasureInvariantError>()(
  'PrivacyMeasureInvariantError',
  { reason: Schema.String },
) {}

const statusFromOutcome = (outcome: OwnerExecutionOutcome | null): OwnerExecutionStatus =>
  outcome?.status ?? 'RECEIVED';

const validateMatchingOwnerRequest = (
  dispatch: PrivacyMeasureDispatch,
  request: OwnerActionRequest,
): PrivacyMeasureInvariantError | undefined => {
  if (request.idempotencyKey !== dispatch.handoff.idempotencyKey) {
    return new PrivacyMeasureInvariantError({ reason: 'Owner Action idempotency identity conflict' });
  }
  if (handoffFingerprint(request.handoff) !== handoffFingerprint(dispatch.handoff)) {
    return new PrivacyMeasureInvariantError({ reason: 'Owner Action payload conflict' });
  }
  return undefined;
};

const outcomeMatchesHandoff = (handoff: PrivacyMeasureHandoff, outcome: OwnerExecutionOutcome): boolean =>
  outcome.idempotencyKey === handoff.idempotencyKey &&
  outcome.measureId === handoff.measureId &&
  outcome.taskId === handoff.taskId &&
  outcome.sourceDecisionRef === handoff.sourceDecisionRef &&
  outcome.sourceDecisionRevision === handoff.sourceDecisionRevision &&
  outcome.owningCapability === handoff.owningCapability;

const outcomeMatchesDispatch = (dispatch: PrivacyMeasureDispatch, outcome: OwnerExecutionOutcome): boolean =>
  outcomeMatchesHandoff(dispatch.handoff, outcome);

const refsWithin = (values: readonly string[], allowed: readonly string[]): boolean => {
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
};

const ownerExecutionAttemptMatches = (
  handoff: PrivacyMeasureHandoff,
  request: OwnerExecutionOutcomeRequest,
  outcome: OwnerExecutionOutcome,
): boolean =>
  request.measureId === handoff.measureId && request.taskId === handoff.taskId && request.attempt === outcome.attempt;

const ownerExecutionResourcePartitionIsExact = (
  handoff: PrivacyMeasureHandoff,
  outcome: OwnerExecutionOutcome,
): boolean =>
  new Set(outcome.includedResourceRefs).size === outcome.includedResourceRefs.length &&
  new Set(outcome.remainingResourceRefs).size === outcome.remainingResourceRefs.length &&
  refsWithin(outcome.includedResourceRefs, handoff.resourceRefs) &&
  refsWithin(outcome.remainingResourceRefs, handoff.resourceRefs) &&
  !overlaps(outcome.includedResourceRefs, outcome.remainingResourceRefs) &&
  sameScope([...outcome.includedResourceRefs, ...outcome.remainingResourceRefs], handoff.resourceRefs);

const ownerExecutionStatusMatchesResourcePartition = (
  handoff: PrivacyMeasureHandoff,
  outcome: OwnerExecutionOutcome,
): boolean => {
  if (outcome.status === 'SUCCEEDED') {
    return outcome.remainingResourceRefs.length === 0 && sameScope(outcome.includedResourceRefs, handoff.resourceRefs);
  }
  if (outcome.status === 'PARTIAL') {
    return outcome.remainingResourceRefs.length > 0;
  }
  return true;
};

const validateOwnerReceiptIdentity = (
  handoff: PrivacyMeasureHandoff,
  request: OwnerExecutionOutcomeRequest,
  authority: OwnerExecutionAuthorityResult,
): string | undefined => {
  const { outcome } = authority;
  if (!ownerExecutionAttemptMatches(handoff, request, outcome)) {
    return 'Owner receipt does not match the requested measure attempt';
  }
  if (authority.tenantId !== handoff.tenantId) {
    return 'Owner receipt does not match the trusted tenant';
  }
  if (!outcomeMatchesHandoff(handoff, outcome)) {
    return 'Owner receipt does not match the dispatched Privacy Measure identity';
  }
  return authority.receiptRef === outcome.outcomeId
    ? undefined
    : 'Owner receipt reference does not match the owner outcome';
};

const validateOwnerReceiptScope = (
  handoff: PrivacyMeasureHandoff,
  authority: OwnerExecutionAuthorityResult,
): string | undefined => {
  if (!sameScope(authority.contentScopeRefs, handoff.contentScopeRefs)) {
    return 'Owner receipt does not match the exact content scope';
  }
  if (!sameScope(authority.resourceRefs, handoff.resourceRefs)) {
    return 'Owner receipt does not match the exact Resource scope';
  }
  if (authority.subjectRef !== handoff.subjectRef) {
    return 'Owner receipt does not match the exact subject scope';
  }
  return sameScope(authority.evidenceRefs, authority.outcome.evidenceRefs)
    ? undefined
    : 'Owner receipt evidence does not match the authoritative outcome evidence';
};

const validateOwnerReceiptPartition = (
  handoff: PrivacyMeasureHandoff,
  outcome: OwnerExecutionOutcome,
): string | undefined => {
  if (!ownerExecutionResourcePartitionIsExact(handoff, outcome)) {
    return 'Owner receipt does not partition the exact approved Resource scope';
  }
  return ownerExecutionStatusMatchesResourcePartition(handoff, outcome)
    ? undefined
    : 'Owner receipt status does not match its completed and remaining Resource scope';
};

/** Validates a private owner receipt before any coordinator ledger can change. */
export const validateOwnerExecutionAuthorityResult = (
  handoff: PrivacyMeasureHandoff,
  request: OwnerExecutionOutcomeRequest,
  authority: OwnerExecutionAuthorityResult,
): string | undefined =>
  validateOwnerReceiptIdentity(handoff, request, authority) ??
  validateOwnerReceiptScope(handoff, authority) ??
  validateOwnerReceiptPartition(handoff, authority.outcome);

const normalizeOwnerOutcome = (outcome: OwnerExecutionOutcome, attempt: number): OwnerExecutionOutcome => ({
  ...outcome,
  attempt,
  evidenceRefs: unique(outcome.evidenceRefs),
  includedResourceRefs: unique(outcome.includedResourceRefs),
  remainingResourceRefs: unique(outcome.remainingResourceRefs),
});

/** Rejects ambiguous handoffs before any owner Action can be invoked. */
export const validatePrivacyMeasureHandoff = (handoff: PrivacyMeasureHandoff): readonly string[] => {
  const errors: string[] = [];
  if (handoff.resourceRefs.length === 0) {
    errors.push('A measure must name at least one Resource');
  }
  if (handoff.contentScopeRefs.length === 0) {
    errors.push('A measure must name at least one content scope');
  }
  if (
    handoff.kind === 'RESTRICT' &&
    handoff.dispositionDecision === null &&
    handoff.requestedResult.toLowerCase().includes('disposition')
  ) {
    errors.push('Disposition restriction must name a Disposition Decision');
  }
  if (
    handoff.kind === 'RESTRICT' &&
    handoff.dispositionDecision === 'RESTRICT' &&
    handoff.requestedResult.toLowerCase().includes('processing')
  ) {
    errors.push('Disposition RESTRICT cannot silently become Processing Restriction');
  }
  return errors;
};

/** Creates durable-coordinator state; the owner Action itself remains owner-local. */
export const createPrivacyMeasureDispatch = (
  handoff: PrivacyMeasureHandoff,
  startedAt: string,
): Effect.Effect<PrivacyMeasureDispatch, PrivacyMeasureInvariantError> => {
  const validationErrors = validatePrivacyMeasureHandoff(handoff);
  return validationErrors.length > 0
    ? Effect.fail(
        new PrivacyMeasureInvariantError({
          reason: `Invalid Privacy Measure handoff: ${validationErrors.join('; ')}`,
        }),
      )
    : Effect.succeed({ attempts: [], createdAt: startedAt, handoff, status: 'RECEIVED' });
};

/** Builds the public Action request. Calling this does not claim execution or completion. */
export const prepareOwnerActionRequest = (dispatch: PrivacyMeasureDispatch, actionKey: string): OwnerActionRequest => ({
  actionKey,
  handoff: dispatch.handoff,
  idempotencyKey: dispatch.handoff.idempotencyKey,
});

const validateOwnerOutcomeForDispatch = (
  dispatch: PrivacyMeasureDispatch,
  outcome: OwnerExecutionOutcome,
): PrivacyMeasureInvariantError | undefined => {
  if (!outcomeMatchesDispatch(dispatch, outcome)) {
    return new PrivacyMeasureInvariantError({
      reason: 'Outcome is assigned to a different measure, decision, or owner',
    });
  }
  return ownerExecutionResourcePartitionIsExact(dispatch.handoff, outcome) &&
    ownerExecutionStatusMatchesResourcePartition(dispatch.handoff, outcome)
    ? undefined
    : new PrivacyMeasureInvariantError({
        reason: 'Owner outcome status does not match the exact approved Resource partition',
      });
};

/** Records an attempt and preserves the exact approved payload for safe retries. */
const recordOwnerExecutionOutcomeInternal = (
  dispatch: PrivacyMeasureDispatch,
  request: OwnerActionRequest,
  outcome: OwnerExecutionOutcome,
  startedAt: string,
  reconciliation: boolean,
): Effect.Effect<PrivacyMeasureDispatch, PrivacyMeasureInvariantError> => {
  const requestError = validateMatchingOwnerRequest(dispatch, request);
  if (requestError !== undefined) {
    return Effect.fail(requestError);
  }
  const outcomeError = validateOwnerOutcomeForDispatch(dispatch, outcome);
  if (outcomeError !== undefined) {
    return Effect.fail(outcomeError);
  }
  if (dispatch.status === 'INDETERMINATE' && !reconciliation) {
    return Effect.fail(
      new PrivacyMeasureInvariantError({
        reason: 'Indeterminate owner execution requires authoritative reconciliation before retry',
      }),
    );
  }
  const prior = dispatch.attempts.at(-1)?.outcome;
  if (prior?.status === 'SUCCEEDED' && outcome.status !== 'SUCCEEDED') {
    return Effect.succeed(dispatch);
  }
  const attempt = dispatch.attempts.length + 1;
  const normalized = normalizeOwnerOutcome(outcome, attempt);
  return Effect.succeed({
    ...dispatch,
    attempts: [...dispatch.attempts, { attempt, outcome: normalized, request, startedAt }],
    status: statusFromOutcome(normalized),
  });
};

/** Records an owner result while preserving invariant failures in the typed Effect error channel. */
export const recordOwnerExecutionOutcome = (
  dispatch: PrivacyMeasureDispatch,
  request: OwnerActionRequest,
  outcome: OwnerExecutionOutcome,
  startedAt: string,
): Effect.Effect<PrivacyMeasureDispatch, PrivacyMeasureInvariantError> =>
  recordOwnerExecutionOutcomeInternal(dispatch, request, outcome, startedAt, false);

/** Reconciles a lost response using an authoritative owner outcome, without repeating a mutation. */
export const reconcilePrivacyMeasure = (
  dispatch: PrivacyMeasureDispatch,
  authoritativeOutcome: OwnerExecutionOutcome,
  recordedAt: string,
): Effect.Effect<PrivacyMeasureDispatch, PrivacyMeasureInvariantError> => {
  const request = prepareOwnerActionRequest(dispatch, `${dispatch.handoff.owningCapability}.public-action`);
  return recordOwnerExecutionOutcomeInternal(
    dispatch,
    request,
    { ...authoritativeOutcome, recordedAt },
    recordedAt,
    true,
  );
};

/** Restart recovery resumes the durable state and leaves indeterminate work unresolved. */
export const recoverPrivacyMeasureDispatch = (dispatch: PrivacyMeasureDispatch): PrivacyMeasureDispatch => ({
  attempts: dispatch.attempts.map((attempt) => ({
    ...attempt,
    request: { ...attempt.request, handoff: dispatch.handoff },
  })),
  createdAt: dispatch.createdAt,
  handoff: dispatch.handoff,
  status: dispatch.status === 'IN_PROGRESS' ? 'INDETERMINATE' : dispatch.status,
});

export const canRetryPrivacyMeasure = (dispatch: PrivacyMeasureDispatch): boolean =>
  dispatch.status === 'TECHNICAL_FAILED' || dispatch.status === 'PARTIAL';
