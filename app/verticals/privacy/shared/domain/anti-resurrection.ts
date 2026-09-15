/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Effect, Schema } from 'effect';

import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from './privacy-measure-handoff.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

export const AntiResurrectionMeasureSchema = Schema.Literals(['DELETE', 'ANONYMIZE']);
export type AntiResurrectionMeasure = typeof AntiResurrectionMeasureSchema.Type;

/** The durable proof is scope and decision bound; it contains no deleted payload. */
export const AntiResurrectionProtectionSchema = Schema.Struct({
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  measure: AntiResurrectionMeasureSchema,
  outcomeStatus: Schema.Literal('SUCCEEDED'),
  ownerExecutionOutcomeRef: Ref,
  protectedAt: Timestamp,
  protectionId: Ref,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  sourceDecisionRef: Ref,
  sourceDecisionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  subjectRef: Ref,
  tenantId: Ref,
});
export type AntiResurrectionProtection = typeof AntiResurrectionProtectionSchema.Type;

export const AntiResurrectionOperationSchema = Schema.Literals([
  'IMPORT',
  'REPLAY',
  'PROJECTION_REBUILD',
  'BACKUP_RECOVERY',
]);
export type AntiResurrectionOperation = typeof AntiResurrectionOperationSchema.Type;

export const AntiResurrectionAttemptSchema = Schema.Struct({
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  operation: AntiResurrectionOperationSchema,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  subjectRef: Ref,
  tenantId: Ref,
  /** Only a separately proven new source may start lawful new processing. */
  sourceInputIsNew: Schema.Boolean,
  sourceInputRef: Schema.NullOr(Ref),
});
export type AntiResurrectionAttempt = typeof AntiResurrectionAttemptSchema.Type;

/** Server-resolved evidence that a legitimate import uses genuinely new input for this exact scope. */
export const AntiResurrectionNewSourceEvidenceSchema = Schema.Struct({
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  evidenceRef: Ref,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  sourceInputRef: Ref,
  subjectRef: Ref,
  tenantId: Ref,
  verifiedAt: Timestamp,
});
export type AntiResurrectionNewSourceEvidence = typeof AntiResurrectionNewSourceEvidenceSchema.Type;

export const AntiResurrectionDecisionSchema = Schema.Literals(['ALLOW', 'BLOCK']);
export type AntiResurrectionDecision = typeof AntiResurrectionDecisionSchema.Type;

export interface AntiResurrectionAssessment {
  readonly decision: AntiResurrectionDecision;
  readonly matchedProtectionIds: readonly string[];
  readonly reason: string;
}

const overlaps = (left: readonly string[], right: readonly string[]): boolean => {
  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
};

const normalizeScope = (refs: readonly string[]): string[] => [...new Set(refs)].toSorted();
const sameScope = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((reference, index) => reference === normalizedRight[index])
  );
};

export class AntiResurrectionProtectionError extends Schema.TaggedError<AntiResurrectionProtectionError>()(
  'AntiResurrectionProtectionError',
  { reason: Schema.String },
) {}

export interface CreateAntiResurrectionProtectionInput {
  readonly handoff: PrivacyMeasureHandoff;
  readonly outcome: OwnerExecutionOutcome;
  readonly protectedAt: string;
  readonly protectionId: string;
}

/** Creates protection only from an authoritative successful destructive outcome for the exact approved scope. */
// fallow-ignore-next-line complexity -- Protection creation is fail-closed across the full coordinator handoff and owner outcome identity.
export const createAntiResurrectionProtection = ({
  handoff,
  outcome,
  protectedAt,
  protectionId,
}: CreateAntiResurrectionProtectionInput): Effect.Effect<
  AntiResurrectionProtection,
  AntiResurrectionProtectionError
> => {
  if (handoff.kind !== 'DELETE' && handoff.kind !== 'ANONYMIZE') {
    return Effect.fail(
      new AntiResurrectionProtectionError({ reason: 'Anti-resurrection protection requires DELETE or ANONYMIZE' }),
    );
  }
  if (outcome.status !== 'SUCCEEDED') {
    return Effect.fail(
      new AntiResurrectionProtectionError({ reason: 'Anti-resurrection protection requires a successful outcome' }),
    );
  }
  if (
    outcome.idempotencyKey !== handoff.idempotencyKey ||
    outcome.measureId !== handoff.measureId ||
    outcome.owningCapability !== handoff.owningCapability ||
    outcome.sourceDecisionRef !== handoff.sourceDecisionRef ||
    outcome.sourceDecisionRevision !== handoff.sourceDecisionRevision ||
    outcome.taskId !== handoff.taskId
  ) {
    return Effect.fail(
      new AntiResurrectionProtectionError({
        reason: 'Destructive outcome does not match the approved measure identity',
      }),
    );
  }
  if (outcome.remainingResourceRefs.length > 0 || !sameScope(outcome.includedResourceRefs, handoff.resourceRefs)) {
    return Effect.fail(
      new AntiResurrectionProtectionError({
        reason: 'Destructive outcome does not prove the exact approved Resource scope',
      }),
    );
  }
  if (outcome.evidenceRefs.length === 0) {
    return Effect.fail(
      new AntiResurrectionProtectionError({ reason: 'Anti-resurrection protection requires outcome evidence' }),
    );
  }
  return Effect.succeed({
    contentScopeRefs: [...new Set(handoff.contentScopeRefs)].toSorted(),
    evidenceRefs: [...new Set([outcome.outcomeId, ...outcome.evidenceRefs])].toSorted(),
    measure: handoff.kind,
    outcomeStatus: 'SUCCEEDED',
    ownerExecutionOutcomeRef: outcome.outcomeId,
    protectedAt,
    protectionId,
    resourceRefs: [...new Set(handoff.resourceRefs)].toSorted(),
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: handoff.sourceDecisionRevision,
    subjectRef: handoff.subjectRef,
    tenantId: handoff.tenantId,
  });
};

/**
 * Checks only the protected subject/resource/content scope. This is not a
 * subject blacklist: unrelated resources and newly proven source input stay
 * usable, while stale material cannot return through any recovery path.
 */
// fallow-ignore-next-line complexity -- Assessment explicitly evaluates every protected identity dimension and fresh-source exception.
export const assessAntiResurrection = (
  protections: readonly AntiResurrectionProtection[],
  attempt: AntiResurrectionAttempt,
  trustedNewSourceEvidence?: AntiResurrectionNewSourceEvidence,
): AntiResurrectionAssessment => {
  const matched = protections.filter(
    (protection) =>
      protection.tenantId === attempt.tenantId &&
      protection.subjectRef === attempt.subjectRef &&
      overlaps(protection.resourceRefs, attempt.resourceRefs) &&
      overlaps(protection.contentScopeRefs, attempt.contentScopeRefs),
  );
  const isNewImport =
    attempt.operation === 'IMPORT' &&
    attempt.sourceInputIsNew &&
    attempt.sourceInputRef !== null &&
    trustedNewSourceEvidence !== undefined &&
    trustedNewSourceEvidence.tenantId === attempt.tenantId &&
    trustedNewSourceEvidence.subjectRef === attempt.subjectRef &&
    trustedNewSourceEvidence.sourceInputRef === attempt.sourceInputRef &&
    sameScope(trustedNewSourceEvidence.resourceRefs, attempt.resourceRefs) &&
    sameScope(trustedNewSourceEvidence.contentScopeRefs, attempt.contentScopeRefs);
  if (matched.length === 0 || isNewImport) {
    return {
      decision: 'ALLOW',
      matchedProtectionIds: matched.map(({ protectionId }) => protectionId),
      reason: isNewImport
        ? 'New source input is permitted and does not resurrect historical material'
        : 'No matching protection scope',
    };
  }
  return {
    decision: 'BLOCK',
    matchedProtectionIds: matched.map(({ protectionId }) => protectionId),
    reason: `Protected ${attempt.operation} would resurrect deleted or anonymized material`,
  };
};
