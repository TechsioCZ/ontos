/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Effect, Schema } from 'effect';

import { validateOwnerExecutionAuthorityResult } from './privacy-measure-handoff.ts';
import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from './privacy-measure-handoff.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

export const AntiResurrectionMeasureSchema = Schema.Literals(['RESTRICT', 'DELETE', 'ANONYMIZE']);
export type AntiResurrectionMeasure = typeof AntiResurrectionMeasureSchema.Type;

export const AntiResurrectionOperationSchema = Schema.Literals([
  'IMPORT',
  'REPLAY',
  'PROJECTION_REBUILD',
  'BACKUP_RECOVERY',
]);
export type AntiResurrectionOperation = typeof AntiResurrectionOperationSchema.Type;

/** Owner-local proof that every recovery/import/replay gate participated. */
export const AntiResurrectionEnforcementReceiptSchema = Schema.Struct({
  authorityRef: Ref,
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  measure: AntiResurrectionMeasureSchema,
  operations: Schema.Array(AntiResurrectionOperationSchema).check(Schema.isMinLength(4), Schema.isMaxLength(4)),
  ownerModuleId: Ref,
  receiptRef: Ref,
  resourceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  subjectRef: Ref,
  taskId: Ref,
  tenantId: Ref,
});
export type AntiResurrectionEnforcementReceipt = typeof AntiResurrectionEnforcementReceiptSchema.Type;

/** The durable proof is scope and decision bound; it contains no deleted payload. */
export const AntiResurrectionProtectionSchema = Schema.Struct({
  contentScopeRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  enforcementReceipt: AntiResurrectionEnforcementReceiptSchema,
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

export const AntiResurrectionDecisionSchema = Schema.Literals(['ALLOW', 'BLOCK', 'PARTIAL']);
export type AntiResurrectionDecision = typeof AntiResurrectionDecisionSchema.Type;

export interface AntiResurrectionAssessment {
  readonly blockedResourceRefs: readonly string[];
  readonly decision: AntiResurrectionDecision;
  readonly matchedProtectionIds: readonly string[];
  readonly reason: string;
  readonly unaffectedResourceRefs: readonly string[];
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
  readonly authority: OwnerExecutionAuthorityResult;
  readonly enforcementReceipt: AntiResurrectionEnforcementReceipt;
  readonly handoff: PrivacyMeasureHandoff;
  readonly protectedAt: string;
  readonly protectionId: string;
}

/** Creates protection only from an authoritative successful destructive or exact-restriction owner outcome. */
// fallow-ignore-next-line complexity -- Protection creation is fail-closed across the full coordinator handoff and owner outcome identity.
export const createAntiResurrectionProtection = ({
  authority,
  enforcementReceipt,
  handoff,
  protectedAt,
  protectionId,
}: CreateAntiResurrectionProtectionInput): Effect.Effect<
  AntiResurrectionProtection,
  AntiResurrectionProtectionError
> => {
  const { outcome } = authority;
  if (
    (handoff.kind !== 'DELETE' && handoff.kind !== 'ANONYMIZE' && handoff.kind !== 'RESTRICT') ||
    (handoff.kind === 'RESTRICT' && handoff.dispositionDecision !== 'RESTRICT')
  ) {
    return Effect.fail(
      new AntiResurrectionProtectionError({
        reason: 'Anti-resurrection protection requires DELETE, ANONYMIZE, or an owner-enforced Disposition RESTRICT',
      }),
    );
  }
  if (outcome.status !== 'SUCCEEDED') {
    return Effect.fail(
      new AntiResurrectionProtectionError({ reason: 'Anti-resurrection protection requires a successful outcome' }),
    );
  }
  const authorityError = validateOwnerExecutionAuthorityResult(
    handoff,
    {
      attempt: outcome.attempt,
      measureId: handoff.measureId,
      taskId: handoff.taskId,
    } satisfies OwnerExecutionOutcomeRequest,
    authority,
  );
  if (authorityError !== undefined) {
    return Effect.fail(
      new AntiResurrectionProtectionError({
        reason: authorityError,
      }),
    );
  }
  if (outcome.remainingResourceRefs.length > 0 || !sameScope(outcome.includedResourceRefs, handoff.resourceRefs)) {
    return Effect.fail(
      new AntiResurrectionProtectionError({
        reason: 'Owner outcome does not prove the exact approved Resource scope',
      }),
    );
  }
  if (outcome.evidenceRefs.length === 0) {
    return Effect.fail(
      new AntiResurrectionProtectionError({ reason: 'Anti-resurrection protection requires outcome evidence' }),
    );
  }
  const expectedOperations: readonly AntiResurrectionOperation[] = [
    'IMPORT',
    'REPLAY',
    'PROJECTION_REBUILD',
    'BACKUP_RECOVERY',
  ];
  if (
    enforcementReceipt.tenantId !== handoff.tenantId ||
    enforcementReceipt.ownerModuleId !== handoff.owningCapability ||
    enforcementReceipt.taskId !== handoff.taskId ||
    enforcementReceipt.measure !== handoff.kind ||
    enforcementReceipt.subjectRef !== handoff.subjectRef ||
    !sameScope(enforcementReceipt.contentScopeRefs, handoff.contentScopeRefs) ||
    !sameScope(enforcementReceipt.resourceRefs, handoff.resourceRefs) ||
    !sameScope(enforcementReceipt.operations, expectedOperations) ||
    enforcementReceipt.evidenceRefs.length !== new Set(enforcementReceipt.evidenceRefs).size
  ) {
    return Effect.fail(
      new AntiResurrectionProtectionError({
        reason: 'Anti-resurrection protection requires an exact owner-local enforcement receipt',
      }),
    );
  }
  return Effect.succeed({
    contentScopeRefs: [...new Set(handoff.contentScopeRefs)].toSorted(),
    enforcementReceipt,
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
    matched.every(({ measure }) => measure !== 'RESTRICT') &&
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
      blockedResourceRefs: [],
      decision: 'ALLOW',
      matchedProtectionIds: normalizeScope(matched.map(({ protectionId }) => protectionId)),
      reason: isNewImport
        ? 'New source input is permitted and does not resurrect historical material'
        : 'No matching protection scope',
      unaffectedResourceRefs: normalizeScope(attempt.resourceRefs),
    };
  }
  const blockedResourceRefs = normalizeScope(
    attempt.resourceRefs.filter((resourceRef) =>
      matched.some(({ resourceRefs }) => resourceRefs.includes(resourceRef)),
    ),
  );
  const blockedResourceRefSet = new Set(blockedResourceRefs);
  const unaffectedResourceRefs = normalizeScope(
    attempt.resourceRefs.filter((resourceRef) => !blockedResourceRefSet.has(resourceRef)),
  );
  const decision = unaffectedResourceRefs.length === 0 ? 'BLOCK' : 'PARTIAL';
  return {
    blockedResourceRefs,
    decision,
    matchedProtectionIds: normalizeScope(matched.map(({ protectionId }) => protectionId)),
    reason:
      decision === 'PARTIAL'
        ? `Protected ${attempt.operation} contains both protected and unaffected Resource references`
        : `Protected ${attempt.operation} would bypass a current ${matched.some(({ measure }) => measure === 'RESTRICT') ? 'owner restriction or deleted/anonymized' : 'deleted or anonymized'} scope`,
    unaffectedResourceRefs,
  };
};
