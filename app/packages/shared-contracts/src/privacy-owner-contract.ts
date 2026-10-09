import { DateTime, Schema } from 'effect';

const OpaquePrivacyReferenceSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);
const IdempotencyKeySchema = OpaquePrivacyReferenceSchema.pipe(Schema.brand('PrivacyIdempotencyKey'));
const TenantIdSchema = OpaquePrivacyReferenceSchema.pipe(Schema.brand('PrivacyTenantId'));

const PrivacyReferenceListSchema = Schema.Array(OpaquePrivacyReferenceSchema);

const hasUniqueReferences = (references: readonly string[]): boolean => new Set(references).size === references.length;

export const PrivacySubjectSchema = Schema.Union([
  Schema.TaggedStruct('RESOLVED_DATA_SUBJECT', {
    subjectRef: OpaquePrivacyReferenceSchema,
  }),
  Schema.TaggedStruct('ANONYMOUS_PRIVACY_CONTEXT', {
    contextRef: OpaquePrivacyReferenceSchema,
  }),
]);
export type PrivacySubject = typeof PrivacySubjectSchema.Type;
export type PrivacySubjectEncoded = typeof PrivacySubjectSchema.Encoded;

/**
 * Exact authorized owner scope. The owner receives a confirmed subject/context and does not
 * perform Party Matching or infer authority from the lookup references.
 */
export const PrivacyOwnerScopeSchema = Schema.Struct({
  controllerRef: OpaquePrivacyReferenceSchema,
  dsrControllerObligationRef: Schema.optionalKey(OpaquePrivacyReferenceSchema),
  ownerCapability: OpaquePrivacyReferenceSchema,
  requestedScopePartRefs: PrivacyReferenceListSchema,
  requestedScopeRef: OpaquePrivacyReferenceSchema,
  subject: PrivacySubjectSchema,
  tenantId: TenantIdSchema,
  trustedLookupRefs: PrivacyReferenceListSchema,
}).check(
  Schema.makeFilter((scope) =>
    scope.requestedScopePartRefs.length > 0 &&
    hasUniqueReferences(scope.requestedScopePartRefs) &&
    hasUniqueReferences(scope.trustedLookupRefs)
      ? undefined
      : {
          issue: 'requested owner scope parts must be non-empty and all scope references must be unique',
          path: ['requestedScopePartRefs'],
        },
  ),
);
export type PrivacyOwnerScope = typeof PrivacyOwnerScopeSchema.Type;
export type PrivacyOwnerScopeEncoded = typeof PrivacyOwnerScopeSchema.Encoded;

export const PrivacyOwnerCoverageStatusSchema = Schema.Literals([
  'COMPLETE',
  'PARTIAL',
  'UNAVAILABLE',
  'INDETERMINATE',
]);
export type PrivacyOwnerCoverageStatus = typeof PrivacyOwnerCoverageStatusSchema.Type;

export const PrivacyOwnerContentStatusSchema = Schema.Literals(['FOUND', 'NO_DATA', 'UNKNOWN']);
export type PrivacyOwnerContentStatus = typeof PrivacyOwnerContentStatusSchema.Type;

export const PrivacyOwnerCoveragePartSchema = Schema.Struct({
  coverageStatus: PrivacyOwnerCoverageStatusSchema,
  evidenceRefs: PrivacyReferenceListSchema,
  foundContentRefs: PrivacyReferenceListSchema,
  observedAt: Schema.DateTimeUtcFromString,
  scopeRef: OpaquePrivacyReferenceSchema,
  unresolvedReason: Schema.optionalKey(OpaquePrivacyReferenceSchema),
}).check(
  Schema.makeFilter((part) => {
    if (part.coverageStatus === 'COMPLETE' && part.unresolvedReason !== undefined) {
      return {
        issue: 'complete coverage must not retain an unresolved reason',
        path: ['unresolvedReason'],
      };
    }
    if (part.coverageStatus !== 'COMPLETE' && part.unresolvedReason === undefined) {
      return {
        issue: 'incomplete coverage must explain its unresolved scope',
        path: ['unresolvedReason'],
      };
    }
    return true;
  }),
);
export type PrivacyOwnerCoveragePart = typeof PrivacyOwnerCoveragePartSchema.Type;
export type PrivacyOwnerCoveragePartEncoded = typeof PrivacyOwnerCoveragePartSchema.Encoded;

/**
 * Owner-local coverage evidence. Content presence and coverage completeness remain independent:
 * NO_DATA is valid only after every requested owner-scope part is completely examined.
 */
export const PrivacyOwnerCoverageResultSchema = Schema.Struct({
  assessedAt: Schema.DateTimeUtcFromString,
  contentStatus: PrivacyOwnerContentStatusSchema,
  coverageParts: Schema.Array(PrivacyOwnerCoveragePartSchema),
  coverageStatus: PrivacyOwnerCoverageStatusSchema,
  evidenceRefs: PrivacyReferenceListSchema,
  scope: PrivacyOwnerScopeSchema,
}).check(
  Schema.makeFilter((result) => {
    const coveredScopeRefs = result.coverageParts.map(({ scopeRef }) => scopeRef);
    const uniqueCoveredScopeRefs = new Set(coveredScopeRefs);
    const exactRequestedScopeCovered =
      uniqueCoveredScopeRefs.size === coveredScopeRefs.length &&
      uniqueCoveredScopeRefs.size === result.scope.requestedScopePartRefs.length &&
      result.scope.requestedScopePartRefs.every((scopeRef) => uniqueCoveredScopeRefs.has(scopeRef));
    const allPartsComplete =
      exactRequestedScopeCovered && result.coverageParts.every((part) => part.coverageStatus === 'COMPLETE');
    const anyContentFound = result.coverageParts.some((part) => part.foundContentRefs.length > 0);

    if ((result.coverageStatus === 'COMPLETE') !== allPartsComplete) {
      return {
        issue: 'COMPLETE requires every requested owner-scope part to be present and complete',
        path: ['coverageStatus'],
      };
    }
    if (result.contentStatus === 'NO_DATA' && (!allPartsComplete || anyContentFound)) {
      return {
        issue: 'NO_DATA requires complete owner-scope coverage with no found content',
        path: ['contentStatus'],
      };
    }
    if (result.contentStatus === 'FOUND' && !anyContentFound) {
      return {
        issue: 'FOUND requires at least one found owner content reference',
        path: ['contentStatus'],
      };
    }
    if (result.contentStatus === 'UNKNOWN' && allPartsComplete) {
      return {
        issue: 'complete coverage must resolve content presence to FOUND or NO_DATA',
        path: ['contentStatus'],
      };
    }
    return true;
  }),
);
export type PrivacyOwnerCoverageResult = typeof PrivacyOwnerCoverageResultSchema.Type;
export type PrivacyOwnerCoverageResultEncoded = typeof PrivacyOwnerCoverageResultSchema.Encoded;

export const PrivacyMeasureIntendedOutcomeSchema = Schema.Literals([
  'RECTIFY',
  'ENFORCE_DISPOSITION_RESTRICTION',
  'ENFORCE_PROCESSING_RESTRICTION',
  'ANONYMIZE',
  'DELETE',
]);
export type PrivacyMeasureIntendedOutcome = typeof PrivacyMeasureIntendedOutcomeSchema.Type;

/** Approved exact-scope owner work. It is not permission to bypass the owner's public Actions. */
export const PrivacyMeasureSchema = Schema.Struct({
  expectedEvidenceRefs: PrivacyReferenceListSchema,
  idempotencyKey: IdempotencyKeySchema,
  intendedOutcome: PrivacyMeasureIntendedOutcomeSchema,
  measureRef: OpaquePrivacyReferenceSchema,
  preconditionRefs: PrivacyReferenceListSchema,
  requestedAt: Schema.DateTimeUtcFromString,
  scope: PrivacyOwnerScopeSchema,
  sourceDecisionRef: OpaquePrivacyReferenceSchema,
  sourceDecisionRevision: OpaquePrivacyReferenceSchema,
  targetContentRefs: PrivacyReferenceListSchema,
}).check(
  Schema.makeFilter((measure) =>
    measure.targetContentRefs.length > 0 &&
    hasUniqueReferences(measure.targetContentRefs) &&
    hasUniqueReferences(measure.preconditionRefs) &&
    hasUniqueReferences(measure.expectedEvidenceRefs)
      ? undefined
      : {
          issue: 'a Privacy Measure must identify non-empty unique targets and unique evidence/precondition references',
          path: ['targetContentRefs'],
        },
  ),
);
export type PrivacyMeasure = typeof PrivacyMeasureSchema.Type;
export type PrivacyMeasureEncoded = typeof PrivacyMeasureSchema.Encoded;

export const PrivacyOwnerExecutionStatusSchema = Schema.Literals([
  'RECEIVED',
  'IN_PROGRESS',
  'ACHIEVED',
  'PARTIAL',
  'BUSINESS_REJECTED',
  'NOT_APPLICABLE',
  'TECHNICAL_FAILED',
  'BLOCKED',
  'PENDING',
  'INDETERMINATE',
]);
export type PrivacyOwnerExecutionStatus = typeof PrivacyOwnerExecutionStatusSchema.Type;

/** Authoritative owner result; transport acknowledgement is never represented as ACHIEVED. */
export const PrivacyOwnerExecutionOutcomeSchema = Schema.Struct({
  affectedContentRefs: PrivacyReferenceListSchema,
  confirmedAt: Schema.DateTimeUtcFromString,
  evidenceRefs: PrivacyReferenceListSchema,
  measureRef: OpaquePrivacyReferenceSchema,
  outcomeRef: OpaquePrivacyReferenceSchema,
  reason: OpaquePrivacyReferenceSchema,
  reconciliationRequired: Schema.Boolean,
  remainingContentRefs: PrivacyReferenceListSchema,
  scope: PrivacyOwnerScopeSchema,
  sourceDecisionRef: OpaquePrivacyReferenceSchema,
  sourceDecisionRevision: OpaquePrivacyReferenceSchema,
  status: PrivacyOwnerExecutionStatusSchema,
}).check(
  Schema.makeFilter((outcome) => {
    if (outcome.status === 'ACHIEVED' && outcome.remainingContentRefs.length > 0) {
      return {
        issue: 'ACHIEVED cannot leave unresolved target content',
        path: ['remainingContentRefs'],
      };
    }
    if (
      outcome.status === 'PARTIAL' &&
      (outcome.affectedContentRefs.length === 0 || outcome.remainingContentRefs.length === 0)
    ) {
      return {
        issue: 'PARTIAL must identify both completed and remaining content',
        path: ['remainingContentRefs'],
      };
    }
    if (outcome.status === 'INDETERMINATE' && !outcome.reconciliationRequired) {
      return {
        issue: 'INDETERMINATE requires owner reconciliation before retry',
        path: ['reconciliationRequired'],
      };
    }
    return true;
  }),
);
export type PrivacyOwnerExecutionOutcome = typeof PrivacyOwnerExecutionOutcomeSchema.Type;
export type PrivacyOwnerExecutionOutcomeEncoded = typeof PrivacyOwnerExecutionOutcomeSchema.Encoded;

export const PrivacyOwnerReconciliationStatusSchema = Schema.Literals([
  'EXECUTION_CONFIRMED',
  'NOT_EXECUTED',
  'PARTIAL_CONFIRMED',
  'STILL_INDETERMINATE',
]);
export type PrivacyOwnerReconciliationStatus = typeof PrivacyOwnerReconciliationStatusSchema.Type;

export const PrivacyOwnerReconciliationResultSchema = Schema.Struct({
  evidenceRefs: PrivacyReferenceListSchema,
  measureRef: OpaquePrivacyReferenceSchema,
  observedAt: Schema.DateTimeUtcFromString,
  preconditionsRecheckedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  retryAllowed: Schema.Boolean,
  sourceDecisionRevision: OpaquePrivacyReferenceSchema,
  status: PrivacyOwnerReconciliationStatusSchema,
}).check(
  Schema.makeFilter((result) => {
    if (result.retryAllowed && result.status !== 'NOT_EXECUTED') {
      return {
        issue: 'retry is allowed only after authoritative confirmation that execution did not occur',
        path: ['retryAllowed'],
      };
    }
    if (result.retryAllowed && result.preconditionsRecheckedAt === undefined) {
      return {
        issue: 'retry requires Current preconditions to be rechecked after reconciliation',
        path: ['preconditionsRecheckedAt'],
      };
    }
    if (
      result.preconditionsRecheckedAt !== undefined &&
      DateTime.toEpochMillis(result.preconditionsRecheckedAt) < DateTime.toEpochMillis(result.observedAt)
    ) {
      return {
        issue: 'preconditions must be rechecked at or after the reconciliation observation',
        path: ['preconditionsRecheckedAt'],
      };
    }
    return true;
  }),
);
export type PrivacyOwnerReconciliationResult = typeof PrivacyOwnerReconciliationResultSchema.Type;
export type PrivacyOwnerReconciliationResultEncoded = typeof PrivacyOwnerReconciliationResultSchema.Encoded;

export const AntiResurrectionProtectionKindSchema = Schema.Literals([
  'DELETED_SCOPE',
  'ANONYMIZED_SCOPE',
  'OWNER_ENFORCED_DISPOSITION_RESTRICTION',
  'OWNER_ENFORCED_PROCESSING_RESTRICTION',
]);
export type AntiResurrectionProtectionKind = typeof AntiResurrectionProtectionKindSchema.Type;

/** Minimal proof for stale-source rejection. It deliberately cannot carry the removed payload. */
export const AntiResurrectionProtectionSchema = Schema.Struct({
  enforcedAt: Schema.DateTimeUtcFromString,
  evidenceRefs: PrivacyReferenceListSchema,
  kind: AntiResurrectionProtectionKindSchema,
  protectedContentRefs: PrivacyReferenceListSchema,
  protectionRef: OpaquePrivacyReferenceSchema,
  retainsRemovedPayload: Schema.Literal(false),
  scope: PrivacyOwnerScopeSchema,
  sourceDecisionRef: OpaquePrivacyReferenceSchema,
  sourceDecisionRevision: OpaquePrivacyReferenceSchema,
  sourceOutcomeRef: OpaquePrivacyReferenceSchema,
  staleSourceResponsibilities: Schema.Array(
    Schema.Literals(['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY']),
  ),
}).check(
  Schema.makeFilter((protection) =>
    protection.protectedContentRefs.length > 0 &&
    protection.staleSourceResponsibilities.length > 0 &&
    hasUniqueReferences(protection.protectedContentRefs) &&
    new Set(protection.staleSourceResponsibilities).size === protection.staleSourceResponsibilities.length
      ? undefined
      : {
          issue: 'anti-resurrection protection requires unique exact content and stale-source responsibilities',
          path: ['protectedContentRefs'],
        },
  ),
);
export type AntiResurrectionProtection = typeof AntiResurrectionProtectionSchema.Type;
export type AntiResurrectionProtectionEncoded = typeof AntiResurrectionProtectionSchema.Encoded;
