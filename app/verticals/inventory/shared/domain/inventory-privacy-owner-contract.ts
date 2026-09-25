import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { DateTime, Schema } from 'effect';

import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';

const boundedReference = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const privacyInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

const PrivacyResourceRefSchema = CoreSearchResourceRefSchema;
const InventoryPrivacyRequestScopeIdSchema = boundedReference.pipe(Schema.brand('InventoryPrivacyRequestScopeId'));
const InventoryPrivacyMeasureIdSchema = boundedReference.pipe(Schema.brand('InventoryPrivacyMeasureId'));
const inventoryModuleId = 'commerce.inventory' as const;

export const InventoryPrivacyCoverageAreaSchema = Schema.Literals([
  'CURRENT_RESERVATION_CORRELATIONS',
  'HISTORICAL_INVENTORY_EVIDENCE',
  'ACTOR_PRINCIPAL_ATTRIBUTION',
  'KNOWN_EXTERNAL_DOWNSTREAM_COPIES',
  'RECOVERY_IMPORT_COPIES',
]);
export type InventoryPrivacyCoverageArea = typeof InventoryPrivacyCoverageAreaSchema.Type;

/** Exact Inventory content/evidence identity authorized for one Privacy owner request. */
export const InventoryPrivacyContentScopeSchema = Schema.Struct({
  contentScopeRef: boundedReference,
  financialEvidenceRef: Schema.Union([boundedReference, Schema.Null]),
  historicalEvidenceAssembledAt: privacyInstant,
  historicalEvidenceRef: boundedReference,
  historicalReservationRef: InventoryReservationRefSchema,
  orderCommitEvidenceRef: Schema.Union([boundedReference, Schema.Null]),
  resourceRefs: Schema.NonEmptyArray(CoreSearchResourceRefSchema),
});
export type InventoryPrivacyContentScope = typeof InventoryPrivacyContentScopeSchema.Type;

export const InventoryPrivacyScopeBindingSchema = Schema.Struct({
  contentScope: InventoryPrivacyContentScopeSchema,
  privacySubjectRef: PrivacyResourceRefSchema,
  requestScopeId: InventoryPrivacyRequestScopeIdSchema,
  tenantId: PrivacyResourceRefSchema.fields.tenantId,
});
export type InventoryPrivacyScopeBinding = typeof InventoryPrivacyScopeBindingSchema.Type;

export const InventoryPrivacyOwnerScopeSchema = Schema.Struct({
  authorizationEvidenceRef: boundedReference,
  confirmedSubjectEvidenceRef: boundedReference,
  contentScope: InventoryPrivacyContentScopeSchema,
  ownerModuleId: Schema.Literal(inventoryModuleId),
  privacySubjectRef: PrivacyResourceRefSchema,
  requestedCoverage: Schema.NonEmptyArray(InventoryPrivacyCoverageAreaSchema),
  requestScopeId: InventoryPrivacyRequestScopeIdSchema,
  tenantId: PrivacyResourceRefSchema.fields.tenantId,
}).check(
  Schema.makeFilter(({ contentScope, privacySubjectRef, requestedCoverage, tenantId }) => {
    if (
      privacySubjectRef.tenantId !== tenantId ||
      String(contentScope.historicalReservationRef.tenantId) !== String(tenantId) ||
      contentScope.resourceRefs.some((ref) => ref.tenantId !== tenantId)
    ) {
      return 'Confirmed Privacy Subject and Inventory owner scope must share one Tenant';
    }
    return new Set(requestedCoverage).size === requestedCoverage.length
      ? undefined
      : 'Inventory owner coverage areas must be requested exactly once';
  }),
);
export type InventoryPrivacyOwnerScope = typeof InventoryPrivacyOwnerScopeSchema.Type;

const completeCoverageFields = {
  binding: InventoryPrivacyScopeBindingSchema,
  capturedAt: privacyInstant,
  observedAt: privacyInstant,
};

export const InventoryPrivacyCoverageFoundSchema = Schema.TaggedStruct('FOUND', {
  ...completeCoverageFields,
  area: InventoryPrivacyCoverageAreaSchema,
  evidenceRefs: Schema.NonEmptyArray(boundedReference),
});
export const InventoryPrivacyCoverageNoDataSchema = Schema.TaggedStruct('NO_DATA', {
  ...completeCoverageFields,
  area: InventoryPrivacyCoverageAreaSchema,
  exhaustiveSearchEvidenceRef: boundedReference,
});
export const InventoryPrivacyCoverageUncheckedSchema = Schema.TaggedStruct('UNCHECKED', {
  area: InventoryPrivacyCoverageAreaSchema,
  binding: InventoryPrivacyScopeBindingSchema,
  reason: Schema.Literals([
    'CURRENT_SCOPE_NOT_CHECKED',
    'HISTORICAL_EVIDENCE_NOT_CHECKED',
    'EXTERNAL_COPY_RESPONSIBILITY_NOT_CHECKED',
    'RECOVERY_IMPORT_RESPONSIBILITY_NOT_CHECKED',
  ]),
});
export const InventoryPrivacyCoverageUnavailableSchema = Schema.TaggedStruct('UNAVAILABLE', {
  area: InventoryPrivacyCoverageAreaSchema,
  binding: InventoryPrivacyScopeBindingSchema,
  reason: Schema.Literals(['OWNER_UNAVAILABLE', 'MODULE_DISABLED', 'COVERAGE_EVIDENCE_UNAVAILABLE']),
});

export const InventoryPrivacyCoverageCheckSchema = Schema.Union([
  InventoryPrivacyCoverageFoundSchema,
  InventoryPrivacyCoverageNoDataSchema,
  InventoryPrivacyCoverageUncheckedSchema,
  InventoryPrivacyCoverageUnavailableSchema,
]);
export type InventoryPrivacyCoverageCheck = typeof InventoryPrivacyCoverageCheckSchema.Type;

export const InventoryPrivacyOwnerCoverageInputSchema = Schema.Struct({
  checks: Schema.Array(InventoryPrivacyCoverageCheckSchema),
  scope: InventoryPrivacyOwnerScopeSchema,
});
export type InventoryPrivacyOwnerCoverageInput = typeof InventoryPrivacyOwnerCoverageInputSchema.Type;

const coverageResultBase = {
  checks: Schema.Array(InventoryPrivacyCoverageCheckSchema),
  scope: InventoryPrivacyOwnerScopeSchema,
};
export const InventoryPrivacyCompleteNoDataSchema = Schema.TaggedStruct('COMPLETE_NO_DATA', {
  ...coverageResultBase,
  completeNoData: Schema.Literal(true),
  coveredAreas: Schema.Array(InventoryPrivacyCoverageAreaSchema),
});
export const InventoryPrivacyCompleteFoundSchema = Schema.TaggedStruct('COMPLETE_FOUND', {
  ...coverageResultBase,
  complete: Schema.Literal(true),
  contributions: Schema.Array(InventoryPrivacyCoverageFoundSchema),
  coveredAreas: Schema.Array(InventoryPrivacyCoverageAreaSchema),
});
export const InventoryPrivacyPartialCoverageSchema = Schema.TaggedStruct('PARTIAL', {
  ...coverageResultBase,
  completeNoData: Schema.Literal(false),
  unresolvedAreas: Schema.Array(InventoryPrivacyCoverageAreaSchema),
});
export const InventoryPrivacyOwnerCoverageResultSchema = Schema.Union([
  InventoryPrivacyCompleteNoDataSchema,
  InventoryPrivacyCompleteFoundSchema,
  InventoryPrivacyPartialCoverageSchema,
]);
export type InventoryPrivacyOwnerCoverageResult = typeof InventoryPrivacyOwnerCoverageResultSchema.Type;

const samePrivacyResourceRef = Schema.toEquivalence(PrivacyResourceRefSchema);
const samePrivacyContentScope = Schema.toEquivalence(InventoryPrivacyContentScopeSchema);
const checkMatchesOwnerScope = (check: InventoryPrivacyCoverageCheck, scope: InventoryPrivacyOwnerScope) =>
  check.binding.requestScopeId === scope.requestScopeId &&
  check.binding.tenantId === scope.tenantId &&
  samePrivacyResourceRef(check.binding.privacySubjectRef, scope.privacySubjectRef) &&
  samePrivacyContentScope(check.binding.contentScope, scope.contentScope);

/**
 * Composes Inventory-owned lookup evidence without performing Party Matching. Completeness is measured
 * against the exact authorized requested owner scope, not against whichever stores happened to answer.
 */
export const evaluateInventoryPrivacyOwnerCoverage = (
  input: InventoryPrivacyOwnerCoverageInput,
): InventoryPrivacyOwnerCoverageResult => {
  const byArea = new Map<InventoryPrivacyCoverageArea, InventoryPrivacyCoverageCheck[]>();
  for (const check of input.checks) {
    byArea.set(check.area, [...(byArea.get(check.area) ?? []), check]);
  }
  const requestedCoverage = new Set(input.scope.requestedCoverage);
  const isCompleteCheck = Schema.is(
    Schema.Union([InventoryPrivacyCoverageFoundSchema, InventoryPrivacyCoverageNoDataSchema]),
  );
  const unresolvedAreas = input.scope.requestedCoverage.filter((area) => {
    const checks = byArea.get(area);
    return checks?.length !== 1 || !isCompleteCheck(checks[0]);
  });
  const outOfScopeOrDuplicate = input.checks.some(
    (check) =>
      !requestedCoverage.has(check.area) ||
      (byArea.get(check.area)?.length ?? 0) !== 1 ||
      !checkMatchesOwnerScope(check, input.scope),
  );
  if (unresolvedAreas.length > 0 || outOfScopeOrDuplicate) {
    const incomplete = unresolvedAreas.length > 0 ? unresolvedAreas : [...input.scope.requestedCoverage];
    return {
      _tag: 'PARTIAL',
      checks: input.checks,
      completeNoData: false,
      scope: input.scope,
      unresolvedAreas: incomplete,
    };
  }
  const contributions = input.checks.filter(Schema.is(InventoryPrivacyCoverageFoundSchema));
  if (contributions.length === 0) {
    return {
      _tag: 'COMPLETE_NO_DATA',
      checks: input.checks,
      completeNoData: true,
      coveredAreas: [...input.scope.requestedCoverage],
      scope: input.scope,
    };
  }
  return {
    _tag: 'COMPLETE_FOUND',
    checks: input.checks,
    complete: true,
    contributions,
    coveredAreas: [...input.scope.requestedCoverage],
    scope: input.scope,
  };
};

const directCustomerProfileField = Schema.Literals([
  'PERSON_NAME',
  'EMAIL',
  'POSTAL_ADDRESS',
  'COMMERCE_CUSTOMER_PROFILE',
]);

/** Inventory reservation evidence keeps business references, never a convenience copy of customer profile data. */
export const InventoryReservationPrivacyDataProfileSchema = Schema.Struct({
  directCustomerProfileCopy: Schema.Literal('ABSENT'),
  opaqueCorrelationsMayBePrivacyRelevant: Schema.Literal(true),
  profileFieldsStoredSolelyForReservation: Schema.Array(directCustomerProfileField).check(Schema.isMaxLength(0)),
  reservationRef: InventoryReservationRefSchema,
  retainedEvidenceKinds: Schema.Array(
    Schema.Literals([
      'ATTEMPT_CORRELATION',
      'ORDER_CORRELATION',
      'RESOURCE_REF',
      'ACTOR_PRINCIPAL_ATTRIBUTION',
      'OWNER_BUSINESS_EVIDENCE',
    ]),
  ),
});
export type InventoryReservationPrivacyDataProfile = typeof InventoryReservationPrivacyDataProfileSchema.Type;

export const InventoryPrivacyDispositionSchema = Schema.Literals(['DELETE', 'ANONYMIZE', 'RESTRICT']);
export type InventoryPrivacyDisposition = typeof InventoryPrivacyDispositionSchema.Type;

export const InventoryPrivacyMeasureSchema = Schema.Struct({
  antiResurrectionProtectionRequired: Schema.Boolean,
  approvedAt: privacyInstant,
  approvedDecisionRef: boundedReference,
  approvedDecisionRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  contentScope: InventoryPrivacyContentScopeSchema,
  measureId: InventoryPrivacyMeasureIdSchema,
  ownerModuleId: Schema.Literal(inventoryModuleId),
  privacySubjectRef: PrivacyResourceRefSchema,
  requestedDisposition: InventoryPrivacyDispositionSchema,
  requestScopeId: InventoryPrivacyRequestScopeIdSchema,
  targetAreas: Schema.NonEmptyArray(InventoryPrivacyCoverageAreaSchema),
  tenantId: PrivacyResourceRefSchema.fields.tenantId,
});
export type InventoryPrivacyMeasure = typeof InventoryPrivacyMeasureSchema.Type;

const InventoryPrivacyRetentionAllowedSchema = Schema.TaggedStruct('DISPOSITION_ALLOWED', {
  effectiveAt: privacyInstant,
  evidenceRef: boundedReference,
});
const InventoryPrivacyRetentionRequiredSchema = Schema.TaggedStruct('RETAIN_REQUIRED', {
  evidenceRef: boundedReference,
  retainUntil: privacyInstant,
});
const InventoryPrivacyRetentionUnverifiedSchema = Schema.TaggedStruct('UNVERIFIED', {
  reason: boundedReference,
});
const InventoryPrivacyRetentionEvidenceSchema = Schema.Union([
  InventoryPrivacyRetentionAllowedSchema,
  InventoryPrivacyRetentionRequiredSchema,
  InventoryPrivacyRetentionUnverifiedSchema,
]);
const InventoryPrivacyLegalHoldClearSchema = Schema.TaggedStruct('CLEAR', {
  evidenceRef: boundedReference,
  observedAt: privacyInstant,
});
const InventoryPrivacyLegalHoldActiveSchema = Schema.TaggedStruct('ACTIVE', {
  evidenceRef: boundedReference,
  observedAt: privacyInstant,
});
const InventoryPrivacyLegalHoldUnverifiedSchema = Schema.TaggedStruct('UNVERIFIED', {
  reason: boundedReference,
});
const InventoryPrivacyLegalHoldEvidenceSchema = Schema.Union([
  InventoryPrivacyLegalHoldClearSchema,
  InventoryPrivacyLegalHoldActiveSchema,
  InventoryPrivacyLegalHoldUnverifiedSchema,
]);
const InventoryPrivacyBusinessDispositionAllowedSchema = Schema.TaggedStruct('DISPOSITION_ALLOWED', {
  evidenceRef: boundedReference,
});
const InventoryPrivacyCommittedEvidenceRequiredSchema = Schema.TaggedStruct(
  'REQUIRED_COMMITTED_STOCK_OR_ORDER_EVIDENCE',
  { evidenceRef: boundedReference },
);
const InventoryPrivacyReservationEvidenceRequiredSchema = Schema.TaggedStruct(
  'REQUIRED_RESERVATION_OR_HISTORICAL_EVIDENCE',
  { evidenceRef: boundedReference },
);
const InventoryPrivacyBusinessInvariantUnverifiedSchema = Schema.TaggedStruct('UNVERIFIED', {
  reason: boundedReference,
});
const InventoryPrivacyBusinessInvariantEvidenceSchema = Schema.Union([
  InventoryPrivacyBusinessDispositionAllowedSchema,
  InventoryPrivacyCommittedEvidenceRequiredSchema,
  InventoryPrivacyReservationEvidenceRequiredSchema,
  InventoryPrivacyBusinessInvariantUnverifiedSchema,
]);

export const InventoryPrivacyOwnerDispositionEvidenceSchema = Schema.Struct({
  businessInvariant: InventoryPrivacyBusinessInvariantEvidenceSchema,
  legalHold: InventoryPrivacyLegalHoldEvidenceSchema,
  observedAt: privacyInstant,
  ownerOrderFence: boundedReference,
  ownerVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  retention: InventoryPrivacyRetentionEvidenceSchema,
});
export type InventoryPrivacyOwnerDispositionEvidence = typeof InventoryPrivacyOwnerDispositionEvidenceSchema.Type;

export const InventoryPrivacyNoMatchingCopyTargetSchema = Schema.TaggedStruct('NO_MATCHING_COPY', {
  area: InventoryPrivacyCoverageAreaSchema,
  binding: InventoryPrivacyScopeBindingSchema,
  copyRefs: Schema.Array(boundedReference).check(Schema.isMaxLength(0)),
  lookupEvidenceRef: boundedReference,
});
export const InventoryPrivacyMatchingCopyTargetSchema = Schema.TaggedStruct('MATCHING_COPY', {
  area: InventoryPrivacyCoverageAreaSchema,
  binding: InventoryPrivacyScopeBindingSchema,
  copyRefs: Schema.NonEmptyArray(boundedReference),
  dispositionEvidence: InventoryPrivacyOwnerDispositionEvidenceSchema,
  ownerActionRef: boundedReference,
  supportedDisposition: InventoryPrivacyDispositionSchema,
});
export const InventoryPrivacyMeasureTargetSchema = Schema.Union([
  InventoryPrivacyNoMatchingCopyTargetSchema,
  InventoryPrivacyMatchingCopyTargetSchema,
]);
export type InventoryPrivacyMeasureTarget = typeof InventoryPrivacyMeasureTargetSchema.Type;

export const InventoryPrivacyMeasureEvaluationInputSchema = Schema.Struct({
  measure: InventoryPrivacyMeasureSchema,
  priorExecution: Schema.optionalKey(
    Schema.Struct({
      outcome: Schema.Literal('INDETERMINATE'),
      ownerExecutionEvidenceRef: boundedReference,
    }),
  ),
  scope: InventoryPrivacyOwnerScopeSchema,
  targets: Schema.Array(InventoryPrivacyMeasureTargetSchema),
});
export type InventoryPrivacyMeasureEvaluationInput = typeof InventoryPrivacyMeasureEvaluationInputSchema.Type;

const rejectedOutcome = (
  measureId: InventoryPrivacyMeasure['measureId'],
  reason: InventoryPrivacyBusinessRejection['reason'],
) =>
  ({
    _tag: 'BUSINESS_REJECTED',
    fabricatedSuccess: false,
    measureId,
    mutationPerformed: false,
    reason,
  }) as const;

export const InventoryPrivacyBusinessRejectionSchema = Schema.TaggedStruct('BUSINESS_REJECTED', {
  fabricatedSuccess: Schema.Literal(false),
  measureId: InventoryPrivacyMeasureIdSchema,
  mutationPerformed: Schema.Literal(false),
  reason: Schema.Literals([
    'OWNER_SCOPE_MISMATCH',
    'TARGET_SCOPE_MISMATCH',
    'REQUIRED_COMMITTED_STOCK_OR_ORDER_EVIDENCE',
    'REQUIRED_RESERVATION_OR_HISTORICAL_EVIDENCE',
    'RETENTION_REQUIRES_PRESERVATION',
    'LEGAL_HOLD_ACTIVE',
    'UNSUPPORTED_OWNER_DISPOSITION',
  ]),
});
export type InventoryPrivacyBusinessRejection = typeof InventoryPrivacyBusinessRejectionSchema.Type;

export const InventoryPrivacyDispositionActionEvidenceSchema = Schema.Struct({
  area: InventoryPrivacyCoverageAreaSchema,
  copyRefs: Schema.NonEmptyArray(boundedReference),
  dispositionEvidence: InventoryPrivacyOwnerDispositionEvidenceSchema,
  ownerActionRef: boundedReference,
});
export type InventoryPrivacyDispositionActionEvidence = typeof InventoryPrivacyDispositionActionEvidenceSchema.Type;

export const InventoryPrivacyOwnerActionRequiredSchema = Schema.TaggedStruct('OWNER_ACTION_REQUIRED', {
  actions: Schema.Array(InventoryPrivacyDispositionActionEvidenceSchema),
  antiResurrectionProtectionRequired: Schema.Boolean,
  contentScope: InventoryPrivacyContentScopeSchema,
  disposition: InventoryPrivacyDispositionSchema,
  measureId: InventoryPrivacyMeasureIdSchema,
  ownerActionRefs: Schema.Array(boundedReference),
  privacySubjectRef: PrivacyResourceRefSchema,
  privateMutationAllowed: Schema.Literal(false),
  requestScopeId: InventoryPrivacyRequestScopeIdSchema,
  targetAreas: Schema.NonEmptyArray(InventoryPrivacyCoverageAreaSchema),
  targetedCopyRefs: Schema.Array(boundedReference),
  tenantId: PrivacyResourceRefSchema.fields.tenantId,
});
export type InventoryPrivacyOwnerActionRequired = typeof InventoryPrivacyOwnerActionRequiredSchema.Type;

export const InventoryPrivacyReconciliationRequiredSchema = Schema.TaggedStruct('RECONCILIATION_REQUIRED', {
  competingFreshExecutionAllowed: Schema.Literal(false),
  measureId: InventoryPrivacyMeasureIdSchema,
  priorExecutionEvidenceRef: boundedReference,
});
export const InventoryPrivacyMeasureIndeterminateSchema = Schema.TaggedStruct('INDETERMINATE', {
  measureId: InventoryPrivacyMeasureIdSchema,
  reason: Schema.Literal('CURRENT_TARGET_OR_BLOCKER_UNVERIFIED'),
  retryRequiresReconciliation: Schema.Literal(true),
});

export const InventoryPrivacyMeasurePlanSchema = Schema.Union([
  InventoryPrivacyBusinessRejectionSchema,
  InventoryPrivacyReconciliationRequiredSchema,
  InventoryPrivacyMeasureIndeterminateSchema,
  Schema.TaggedStruct('NOT_APPLICABLE', {
    measureId: InventoryPrivacyMeasureIdSchema,
    mutationPerformed: Schema.Literal(false),
    reason: Schema.Literal('NO_MATCHING_INVENTORY_DATA'),
  }),
  InventoryPrivacyOwnerActionRequiredSchema,
]);
export type InventoryPrivacyMeasurePlan = typeof InventoryPrivacyMeasurePlanSchema.Type;

const bindingMatchesOwnerScope = (binding: InventoryPrivacyScopeBinding, scope: InventoryPrivacyOwnerScope) =>
  binding.requestScopeId === scope.requestScopeId &&
  binding.tenantId === scope.tenantId &&
  samePrivacyResourceRef(binding.privacySubjectRef, scope.privacySubjectRef) &&
  samePrivacyContentScope(binding.contentScope, scope.contentScope);

const InventoryPrivacyDispositionBlockerSchema = Schema.Union([
  Schema.Literals([
    'REQUIRED_COMMITTED_STOCK_OR_ORDER_EVIDENCE',
    'REQUIRED_RESERVATION_OR_HISTORICAL_EVIDENCE',
    'RETENTION_REQUIRES_PRESERVATION',
    'LEGAL_HOLD_ACTIVE',
    'CURRENT_TARGET_OR_BLOCKER_UNVERIFIED',
  ]),
  Schema.Null,
]);
type InventoryPrivacyDispositionBlocker = typeof InventoryPrivacyDispositionBlockerSchema.Type;

const findDispositionBlocker = (
  targets: readonly (typeof InventoryPrivacyMatchingCopyTargetSchema.Type)[],
  approvedAt: string,
): InventoryPrivacyDispositionBlocker => {
  if (
    targets.some((target) =>
      Schema.is(InventoryPrivacyCommittedEvidenceRequiredSchema)(target.dispositionEvidence.businessInvariant),
    )
  ) {
    return 'REQUIRED_COMMITTED_STOCK_OR_ORDER_EVIDENCE';
  }
  if (
    targets.some((target) =>
      Schema.is(InventoryPrivacyReservationEvidenceRequiredSchema)(target.dispositionEvidence.businessInvariant),
    )
  ) {
    return 'REQUIRED_RESERVATION_OR_HISTORICAL_EVIDENCE';
  }
  if (
    targets.some((target) => Schema.is(InventoryPrivacyRetentionRequiredSchema)(target.dispositionEvidence.retention))
  ) {
    return 'RETENTION_REQUIRES_PRESERVATION';
  }
  if (
    targets.some((target) => Schema.is(InventoryPrivacyLegalHoldActiveSchema)(target.dispositionEvidence.legalHold))
  ) {
    return 'LEGAL_HOLD_ACTIVE';
  }
  const approvalTime = DateTime.toEpochMillis(DateTime.makeUnsafe(approvedAt));
  const unverifiedOrStale = targets.some(({ dispositionEvidence }) => {
    if (
      Schema.is(InventoryPrivacyBusinessInvariantUnverifiedSchema)(dispositionEvidence.businessInvariant) ||
      Schema.is(InventoryPrivacyLegalHoldUnverifiedSchema)(dispositionEvidence.legalHold) ||
      Schema.is(InventoryPrivacyRetentionUnverifiedSchema)(dispositionEvidence.retention)
    ) {
      return true;
    }
    const observedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(dispositionEvidence.observedAt));
    const legalHoldObservedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(dispositionEvidence.legalHold.observedAt));
    const retentionEffectiveAt = Schema.is(InventoryPrivacyRetentionAllowedSchema)(dispositionEvidence.retention)
      ? DateTime.toEpochMillis(DateTime.makeUnsafe(dispositionEvidence.retention.effectiveAt))
      : observedAt;
    return observedAt < approvalTime || legalHoldObservedAt < approvalTime || retentionEffectiveAt > observedAt;
  });
  return unverifiedOrStale ? 'CURRENT_TARGET_OR_BLOCKER_UNVERIFIED' : null;
};

const buildDispositionActionPlan = (
  targets: readonly (typeof InventoryPrivacyMatchingCopyTargetSchema.Type)[],
  requestedDisposition: InventoryPrivacyDisposition,
) => {
  const ownerActionRefs: string[] = [];
  const targetedCopyRefs: string[] = [];
  const actions: InventoryPrivacyDispositionActionEvidence[] = [];
  const seenActionRefs = new Set<string>();
  const seenCopyRefs = new Set<string>();
  for (const target of targets) {
    const targetCopyRefs = new Set(target.copyRefs);
    if (target.supportedDisposition !== requestedDisposition) {
      return { actions, failureReason: 'UNSUPPORTED_OWNER_DISPOSITION' as const, ownerActionRefs, targetedCopyRefs };
    }
    if (
      seenActionRefs.has(target.ownerActionRef) ||
      targetCopyRefs.size !== target.copyRefs.length ||
      target.copyRefs.some((copyRef) => seenCopyRefs.has(copyRef))
    ) {
      return { actions, failureReason: 'TARGET_SCOPE_MISMATCH' as const, ownerActionRefs, targetedCopyRefs };
    }
    seenActionRefs.add(target.ownerActionRef);
    for (const copyRef of target.copyRefs) {
      seenCopyRefs.add(copyRef);
    }
    ownerActionRefs.push(target.ownerActionRef);
    targetedCopyRefs.push(...target.copyRefs);
    actions.push({
      area: target.area,
      copyRefs: target.copyRefs,
      dispositionEvidence: target.dispositionEvidence,
      ownerActionRef: target.ownerActionRef,
    });
  }
  return { actions, failureReason: null, ownerActionRefs, targetedCopyRefs };
};

/** Evaluates the handoff only. A supported state change still has to run through the named owner Action. */
export const evaluateInventoryPrivacyMeasure = (
  input: InventoryPrivacyMeasureEvaluationInput,
): InventoryPrivacyMeasurePlan => {
  const { measure, scope } = input;
  const requestedCoverage = new Set(scope.requestedCoverage);
  if (
    measure.ownerModuleId !== scope.ownerModuleId ||
    measure.requestScopeId !== scope.requestScopeId ||
    measure.tenantId !== scope.tenantId ||
    !samePrivacyResourceRef(measure.privacySubjectRef, scope.privacySubjectRef) ||
    !samePrivacyContentScope(measure.contentScope, scope.contentScope)
  ) {
    return rejectedOutcome(measure.measureId, 'OWNER_SCOPE_MISMATCH');
  }
  if (measure.targetAreas.some((area) => !requestedCoverage.has(area))) {
    return rejectedOutcome(measure.measureId, 'TARGET_SCOPE_MISMATCH');
  }
  if (input.priorExecution?.outcome === 'INDETERMINATE') {
    return {
      _tag: 'RECONCILIATION_REQUIRED',
      competingFreshExecutionAllowed: false,
      measureId: measure.measureId,
      priorExecutionEvidenceRef: input.priorExecution.ownerExecutionEvidenceRef,
    };
  }
  const exactTargets: InventoryPrivacyMeasureTarget[] = [];
  for (const area of measure.targetAreas) {
    const matches = input.targets.filter((target) => target.area === area);
    const [target] = matches;
    if (matches.length !== 1 || target === undefined || !bindingMatchesOwnerScope(target.binding, scope)) {
      return rejectedOutcome(measure.measureId, 'TARGET_SCOPE_MISMATCH');
    }
    exactTargets.push(target);
  }
  if (input.targets.length !== exactTargets.length) {
    return rejectedOutcome(measure.measureId, 'TARGET_SCOPE_MISMATCH');
  }
  const matchingTargets = exactTargets.filter(Schema.is(InventoryPrivacyMatchingCopyTargetSchema));
  if (matchingTargets.length === 0) {
    return {
      _tag: 'NOT_APPLICABLE',
      measureId: measure.measureId,
      mutationPerformed: false,
      reason: 'NO_MATCHING_INVENTORY_DATA',
    };
  }
  const dispositionBlocker = findDispositionBlocker(matchingTargets, measure.approvedAt);
  if (dispositionBlocker === 'CURRENT_TARGET_OR_BLOCKER_UNVERIFIED') {
    return {
      _tag: 'INDETERMINATE',
      measureId: measure.measureId,
      reason: 'CURRENT_TARGET_OR_BLOCKER_UNVERIFIED',
      retryRequiresReconciliation: true,
    };
  }
  if (dispositionBlocker !== null) {
    return rejectedOutcome(measure.measureId, dispositionBlocker);
  }
  const actionPlan = buildDispositionActionPlan(matchingTargets, measure.requestedDisposition);
  if (actionPlan.failureReason !== null) {
    return rejectedOutcome(measure.measureId, actionPlan.failureReason);
  }
  return {
    _tag: 'OWNER_ACTION_REQUIRED',
    actions: actionPlan.actions,
    antiResurrectionProtectionRequired: measure.antiResurrectionProtectionRequired,
    contentScope: measure.contentScope,
    disposition: measure.requestedDisposition,
    measureId: measure.measureId,
    ownerActionRefs: actionPlan.ownerActionRefs,
    privacySubjectRef: measure.privacySubjectRef,
    privateMutationAllowed: false,
    requestScopeId: measure.requestScopeId,
    targetAreas: [...measure.targetAreas],
    targetedCopyRefs: actionPlan.targetedCopyRefs,
    tenantId: measure.tenantId,
  };
};

export const InventoryPrivacyContributionContentItemSchema = Schema.Struct({
  accessEligible: Schema.Boolean,
  contentKind: Schema.Literals([
    'OPAQUE_RESERVATION_CORRELATION',
    'ACTOR_PRINCIPAL_ATTRIBUTION',
    'INVENTORY_BUSINESS_EVIDENCE',
    'EXTERNAL_DOWNSTREAM_RESPONSIBILITY',
  ]),
  contentRef: boundedReference,
  portabilityEligible: Schema.Boolean,
  resourceRef: CoreSearchResourceRefSchema,
  sourceEvidenceRef: boundedReference,
  thirdPartyProtected: Schema.Boolean,
  valueForm: Schema.Literals(['OPAQUE_REFERENCE', 'OWNER_EVIDENCE_SUMMARY']),
});
export type InventoryPrivacyContributionContentItem = typeof InventoryPrivacyContributionContentItemSchema.Type;

export const InventoryPrivacyOwnerContributionSchema = Schema.TaggedStruct('OWNER_CONTRIBUTION', {
  atomicCrossOwnerSnapshotClaimed: Schema.Literal(false),
  binding: InventoryPrivacyScopeBindingSchema,
  capturedAt: privacyInstant,
  completion: Schema.Literals(['COMPLETE', 'PARTIAL']),
  content: Schema.Array(InventoryPrivacyContributionContentItemSchema),
  contributionRef: boundedReference,
  exclusions: Schema.Array(
    Schema.Struct({
      contentRef: boundedReference,
      reason: Schema.Literals([
        'NOT_ACCESS_ELIGIBLE',
        'NOT_PORTABILITY_ELIGIBLE',
        'THIRD_PARTY_PROTECTION',
        'OUTSIDE_AUTHORIZED_SCOPE',
        'SOURCE_EVIDENCE_MISMATCH',
        'SOURCE_NOT_FOUND_IN_COVERAGE',
        'COVERAGE_SCOPE_MISMATCH',
        'NO_DATA_COVERAGE_CONFLICT',
      ]),
    }),
  ),
  observedAt: privacyInstant,
  rawProviderPayloadIncluded: Schema.Literal(false),
  requestKind: Schema.Literals(['ACCESS', 'PORTABILITY']),
});
export type InventoryPrivacyOwnerContribution = typeof InventoryPrivacyOwnerContributionSchema.Type;

const contributionCoverageContradictionReasons = new Set<
  InventoryPrivacyOwnerContribution['exclusions'][number]['reason']
>(['NO_DATA_COVERAGE_CONFLICT', 'SOURCE_NOT_FOUND_IN_COVERAGE', 'COVERAGE_SCOPE_MISMATCH']);

const contributionExclusionReason = (
  candidate: InventoryPrivacyContributionContentItem,
  requestKind: 'ACCESS' | 'PORTABILITY',
  scope: InventoryPrivacyOwnerScope,
  completeNoData: boolean,
  coverageMatches: boolean,
  foundHistoricalEvidenceRefs: ReadonlySet<string>,
): InventoryPrivacyOwnerContribution['exclusions'][number]['reason'] | null => {
  if (completeNoData) {
    return 'NO_DATA_COVERAGE_CONFLICT';
  }
  if (!coverageMatches) {
    return 'COVERAGE_SCOPE_MISMATCH';
  }
  const authorizedResource = scope.contentScope.resourceRefs.some((ref) =>
    samePrivacyResourceRef(ref, candidate.resourceRef),
  );
  if (candidate.resourceRef.tenantId !== scope.tenantId || !authorizedResource) {
    return 'OUTSIDE_AUTHORIZED_SCOPE';
  }
  if (candidate.sourceEvidenceRef !== scope.contentScope.historicalEvidenceRef) {
    return 'SOURCE_EVIDENCE_MISMATCH';
  }
  if (!foundHistoricalEvidenceRefs.has(candidate.sourceEvidenceRef)) {
    return 'SOURCE_NOT_FOUND_IN_COVERAGE';
  }
  if (candidate.thirdPartyProtected) {
    return 'THIRD_PARTY_PROTECTION';
  }
  if (requestKind === 'ACCESS' && !candidate.accessEligible) {
    return 'NOT_ACCESS_ELIGIBLE';
  }
  if (requestKind === 'PORTABILITY' && !candidate.portabilityEligible) {
    return 'NOT_PORTABILITY_ELIGIBLE';
  }
  return null;
};

export const compileInventoryPrivacyOwnerContribution = (input: {
  readonly candidateContent: readonly InventoryPrivacyContributionContentItem[];
  readonly capturedAt: string;
  readonly contributionRef: string;
  readonly coverage: InventoryPrivacyOwnerCoverageResult;
  readonly observedAt: string;
  readonly requestKind: 'ACCESS' | 'PORTABILITY';
  readonly scope: InventoryPrivacyOwnerScope;
}): InventoryPrivacyOwnerContribution => {
  const { candidateContent, coverage, requestKind, scope } = input;
  const content: InventoryPrivacyContributionContentItem[] = [];
  const exclusions: InventoryPrivacyOwnerContribution['exclusions'][number][] = [];
  const completeNoData = Schema.is(InventoryPrivacyCompleteNoDataSchema)(coverage);
  const coverageMatches =
    coverage.scope.requestScopeId === scope.requestScopeId &&
    coverage.scope.tenantId === scope.tenantId &&
    samePrivacyResourceRef(coverage.scope.privacySubjectRef, scope.privacySubjectRef) &&
    samePrivacyContentScope(coverage.scope.contentScope, scope.contentScope);
  const foundHistoricalEvidenceRefs = new Set<string>();
  for (const check of coverage.checks) {
    if (
      check.area === 'HISTORICAL_INVENTORY_EVIDENCE' &&
      checkMatchesOwnerScope(check, scope) &&
      Schema.is(InventoryPrivacyCoverageFoundSchema)(check)
    ) {
      for (const evidenceRef of check.evidenceRefs) {
        foundHistoricalEvidenceRefs.add(evidenceRef);
      }
    }
  }
  for (const candidate of candidateContent) {
    const reason = contributionExclusionReason(
      candidate,
      requestKind,
      scope,
      completeNoData,
      coverageMatches,
      foundHistoricalEvidenceRefs,
    );
    if (reason === null) {
      content.push(candidate);
    } else {
      exclusions.push({ contentRef: candidate.contentRef, reason });
    }
  }
  const hasCoverageContradiction = exclusions.some(({ reason }) =>
    contributionCoverageContradictionReasons.has(reason),
  );
  return {
    _tag: 'OWNER_CONTRIBUTION',
    atomicCrossOwnerSnapshotClaimed: false,
    binding: {
      contentScope: scope.contentScope,
      privacySubjectRef: scope.privacySubjectRef,
      requestScopeId: scope.requestScopeId,
      tenantId: scope.tenantId,
    },
    capturedAt: input.capturedAt,
    completion:
      coverageMatches &&
      !Schema.is(InventoryPrivacyPartialCoverageSchema)(coverage) &&
      !hasCoverageContradiction &&
      !(completeNoData && candidateContent.length > 0)
        ? 'COMPLETE'
        : 'PARTIAL',
    content,
    contributionRef: input.contributionRef,
    exclusions,
    observedAt: input.observedAt,
    rawProviderPayloadIncluded: false,
    requestKind,
  };
};

export const InventoryPrivacyTemporaryExportSchema = Schema.TaggedStruct('TEMPORARY_DSR_EXPORT', {
  contribution: InventoryPrivacyOwnerContributionSchema,
  copiedCustomerProfileSynthesized: Schema.Literal(false),
  createdAt: privacyInstant,
  deliveryAccessRef: boundedReference,
  expiresAt: privacyInstant,
  exportRef: boundedReference,
  rawProviderPayloadIncluded: Schema.Literal(false),
  revokedPriorDeliveryAccessRef: Schema.Union([boundedReference, Schema.Null]),
}).check(
  Schema.makeFilter(({ createdAt, expiresAt }) =>
    DateTime.toEpochMillis(DateTime.makeUnsafe(expiresAt)) > DateTime.toEpochMillis(DateTime.makeUnsafe(createdAt))
      ? undefined
      : 'Temporary DSR Export must expire after it is created',
  ),
);
export type InventoryPrivacyTemporaryExport = typeof InventoryPrivacyTemporaryExportSchema.Type;

export const InventoryAntiResurrectionProtectionSchema = Schema.Struct({
  backupRestoreReconciliationRequired: Schema.Literal(true),
  contentScope: InventoryPrivacyContentScopeSchema,
  deletedPayloadRetained: Schema.Literal(false),
  disposition: InventoryPrivacyDispositionSchema,
  effectiveAt: privacyInstant,
  measureId: InventoryPrivacyMeasureIdSchema,
  privacySubjectRef: PrivacyResourceRefSchema,
  protectionEvidenceRef: boundedReference,
  removedCopyRefs: Schema.NonEmptyArray(boundedReference),
  requestScopeId: InventoryPrivacyRequestScopeIdSchema,
  staleImportBlocked: Schema.Literal(true),
  staleReplayBlocked: Schema.Literal(true),
  targetAreas: Schema.NonEmptyArray(InventoryPrivacyCoverageAreaSchema),
  tenantId: PrivacyResourceRefSchema.fields.tenantId,
});
export type InventoryAntiResurrectionProtection = typeof InventoryAntiResurrectionProtectionSchema.Type;

const inventoryPrivacyExecutionEvidenceFields = {
  actionEvidence: Schema.Array(InventoryPrivacyDispositionActionEvidenceSchema),
};
export const InventoryPrivacyMeasureExecutionSchema = Schema.Union([
  Schema.Struct({
    ...inventoryPrivacyExecutionEvidenceFields,
    achievedAt: privacyInstant,
    achievedCopyRefs: Schema.NonEmptyArray(boundedReference),
    measureId: InventoryPrivacyMeasureIdSchema,
    outcome: Schema.Literal('ACHIEVED'),
    ownerExecutionEvidenceRef: boundedReference,
  }),
  Schema.Struct({
    ...inventoryPrivacyExecutionEvidenceFields,
    measureId: InventoryPrivacyMeasureIdSchema,
    outcome: Schema.Literal('INDETERMINATE'),
    ownerExecutionEvidenceRef: boundedReference,
  }),
  Schema.Struct({
    ...inventoryPrivacyExecutionEvidenceFields,
    achievedAt: privacyInstant,
    achievedCopyRefs: Schema.Array(boundedReference),
    measureId: InventoryPrivacyMeasureIdSchema,
    outcome: Schema.Literal('PARTIAL'),
    ownerExecutionEvidenceRef: boundedReference,
    unresolvedCopyRefs: Schema.NonEmptyArray(boundedReference),
  }),
  Schema.Struct({
    ...inventoryPrivacyExecutionEvidenceFields,
    blockerEvidenceRef: boundedReference,
    measureId: InventoryPrivacyMeasureIdSchema,
    outcome: Schema.Literal('BLOCKED'),
  }),
  Schema.Struct({
    ...inventoryPrivacyExecutionEvidenceFields,
    failureEvidenceRef: boundedReference,
    measureId: InventoryPrivacyMeasureIdSchema,
    outcome: Schema.Literal('TECHNICAL_FAILED'),
    retryMayDuplicateEffect: Schema.Literal(false),
  }),
]);
export type InventoryPrivacyMeasureExecution = typeof InventoryPrivacyMeasureExecutionSchema.Type;

export const InventoryPrivacyAchievedSchema = Schema.TaggedStruct('ACHIEVED', {
  antiResurrectionProtectionEvidenceRef: Schema.Union([boundedReference, Schema.Null]),
  measureId: InventoryPrivacyMeasureIdSchema,
  ownerExecutionEvidenceRef: boundedReference,
});
export const InventoryPrivacyExecutionIndeterminateSchema = Schema.TaggedStruct('INDETERMINATE', {
  measureId: InventoryPrivacyMeasureIdSchema,
  reason: Schema.Literals([
    'OWNER_EXECUTION_INDETERMINATE',
    'ANTI_RESURRECTION_PROTECTION_MISSING',
    'EXECUTION_COPY_PARTITION_INVALID',
  ]),
  retryRequiresReconciliation: Schema.Literal(true),
});
export const InventoryPrivacyExecutionPartialSchema = Schema.TaggedStruct('PARTIAL', {
  achievedCopyRefs: Schema.Array(boundedReference),
  antiResurrectionProtectionEvidenceRef: Schema.Union([boundedReference, Schema.Null]),
  measureId: InventoryPrivacyMeasureIdSchema,
  ownerExecutionEvidenceRef: boundedReference,
  unresolvedCopyRefs: Schema.NonEmptyArray(boundedReference),
});
export const InventoryPrivacyExecutionBlockedSchema = Schema.TaggedStruct('BLOCKED', {
  blockerEvidenceRef: boundedReference,
  measureId: InventoryPrivacyMeasureIdSchema,
  mutationPerformed: Schema.Literal(false),
  reason: Schema.Literals(['OWNER_REPORTED_BLOCKER', 'OWNER_EVIDENCE_CHANGED']),
});
export const InventoryPrivacyExecutionTechnicalFailedSchema = Schema.TaggedStruct('TECHNICAL_FAILED', {
  failureEvidenceRef: boundedReference,
  measureId: InventoryPrivacyMeasureIdSchema,
  retryMayDuplicateEffect: Schema.Literal(false),
});
export const InventoryPrivacyOwnerExecutionOutcomeSchema = Schema.Union([
  InventoryPrivacyAchievedSchema,
  InventoryPrivacyExecutionPartialSchema,
  InventoryPrivacyExecutionBlockedSchema,
  InventoryPrivacyExecutionTechnicalFailedSchema,
  InventoryPrivacyExecutionIndeterminateSchema,
]);
export type InventoryPrivacyOwnerExecutionOutcome = typeof InventoryPrivacyOwnerExecutionOutcomeSchema.Type;

const sameAreas = (left: readonly InventoryPrivacyCoverageArea[], right: readonly InventoryPrivacyCoverageArea[]) => {
  const rightAreas = new Set(right);
  return left.length === right.length && left.every((area) => rightAreas.has(area));
};
const sameReferences = (left: readonly string[], right: readonly string[]) => {
  const leftReferences = new Set(left);
  const rightReferences = new Set(right);
  return (
    leftReferences.size === left.length &&
    rightReferences.size === right.length &&
    left.length === right.length &&
    left.every((reference) => rightReferences.has(reference))
  );
};
const sameDispositionEvidence = Schema.toEquivalence(InventoryPrivacyOwnerDispositionEvidenceSchema);

const actionEvidenceMatchesPlan = (
  executionEvidence: readonly InventoryPrivacyDispositionActionEvidence[],
  plan: InventoryPrivacyOwnerActionRequired,
) => {
  const executionByAction = new Map(executionEvidence.map((evidence) => [evidence.ownerActionRef, evidence]));
  if (
    executionEvidence.length !== plan.actions.length ||
    executionByAction.size !== executionEvidence.length ||
    new Set(plan.actions.map(({ ownerActionRef }) => ownerActionRef)).size !== plan.actions.length
  ) {
    return false;
  }
  return plan.actions.every((planned) => {
    const actual = executionByAction.get(planned.ownerActionRef);
    return (
      actual !== undefined &&
      actual.area === planned.area &&
      sameReferences(actual.copyRefs, planned.copyRefs) &&
      sameDispositionEvidence(actual.dispositionEvidence, planned.dispositionEvidence)
    );
  });
};

const isExactCopyPartition = (
  achieved: readonly string[],
  unresolved: readonly string[],
  targeted: readonly string[],
) => {
  const achievedSet = new Set(achieved);
  const unresolvedSet = new Set(unresolved);
  return (
    achievedSet.size === achieved.length &&
    unresolvedSet.size === unresolved.length &&
    achieved.every((reference) => !unresolvedSet.has(reference)) &&
    sameReferences([...achieved, ...unresolved], targeted)
  );
};

const protectionMatchesExecution = (
  protection: InventoryAntiResurrectionProtection | null,
  plan: InventoryPrivacyOwnerActionRequired,
  achievedAt: string,
  achievedCopyRefs: readonly string[],
) =>
  protection !== null &&
  protection.measureId === plan.measureId &&
  protection.requestScopeId === plan.requestScopeId &&
  protection.tenantId === plan.tenantId &&
  samePrivacyResourceRef(protection.privacySubjectRef, plan.privacySubjectRef) &&
  samePrivacyContentScope(protection.contentScope, plan.contentScope) &&
  protection.disposition === plan.disposition &&
  sameAreas(protection.targetAreas, plan.targetAreas) &&
  sameReferences(protection.removedCopyRefs, achievedCopyRefs) &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(protection.effectiveAt)) >=
    DateTime.toEpochMillis(DateTime.makeUnsafe(achievedAt));

const indeterminateExecution = (
  measureId: InventoryPrivacyMeasure['measureId'],
  reason: (typeof InventoryPrivacyExecutionIndeterminateSchema.Type)['reason'],
): InventoryPrivacyOwnerExecutionOutcome => ({
  _tag: 'INDETERMINATE',
  measureId,
  reason,
  retryRequiresReconciliation: true,
});

type PartialPrivacyMeasureExecution = Extract<InventoryPrivacyMeasureExecution, { readonly outcome: 'PARTIAL' }>;
type AchievedPrivacyMeasureExecution = Extract<InventoryPrivacyMeasureExecution, { readonly outcome: 'ACHIEVED' }>;

const finalizePartialPrivacyMeasure = (
  execution: PartialPrivacyMeasureExecution,
  plan: InventoryPrivacyOwnerActionRequired,
  protection: InventoryAntiResurrectionProtection | null,
): InventoryPrivacyOwnerExecutionOutcome => {
  if (!isExactCopyPartition(execution.achievedCopyRefs, execution.unresolvedCopyRefs, plan.targetedCopyRefs)) {
    return indeterminateExecution(plan.measureId, 'EXECUTION_COPY_PARTITION_INVALID');
  }
  if (
    plan.antiResurrectionProtectionRequired &&
    execution.achievedCopyRefs.length > 0 &&
    !protectionMatchesExecution(protection, plan, execution.achievedAt, execution.achievedCopyRefs)
  ) {
    return indeterminateExecution(plan.measureId, 'ANTI_RESURRECTION_PROTECTION_MISSING');
  }
  return {
    _tag: 'PARTIAL',
    achievedCopyRefs: execution.achievedCopyRefs,
    antiResurrectionProtectionEvidenceRef: protection?.protectionEvidenceRef ?? null,
    measureId: plan.measureId,
    ownerExecutionEvidenceRef: execution.ownerExecutionEvidenceRef,
    unresolvedCopyRefs: execution.unresolvedCopyRefs,
  };
};

const finalizeAchievedPrivacyMeasure = (
  execution: AchievedPrivacyMeasureExecution,
  plan: InventoryPrivacyOwnerActionRequired,
  protection: InventoryAntiResurrectionProtection | null,
): InventoryPrivacyOwnerExecutionOutcome => {
  if (!isExactCopyPartition(execution.achievedCopyRefs, [], plan.targetedCopyRefs)) {
    return indeterminateExecution(plan.measureId, 'EXECUTION_COPY_PARTITION_INVALID');
  }
  if (
    plan.antiResurrectionProtectionRequired &&
    !protectionMatchesExecution(protection, plan, execution.achievedAt, execution.achievedCopyRefs)
  ) {
    return indeterminateExecution(plan.measureId, 'ANTI_RESURRECTION_PROTECTION_MISSING');
  }
  return {
    _tag: 'ACHIEVED',
    antiResurrectionProtectionEvidenceRef: protection?.protectionEvidenceRef ?? null,
    measureId: plan.measureId,
    ownerExecutionEvidenceRef: execution.ownerExecutionEvidenceRef,
  };
};

export const finalizeInventoryPrivacyMeasure = (input: {
  readonly execution: InventoryPrivacyMeasureExecution;
  readonly plan: InventoryPrivacyOwnerActionRequired;
  readonly protection: InventoryAntiResurrectionProtection | null;
}): InventoryPrivacyOwnerExecutionOutcome => {
  const { execution, plan, protection } = input;
  if (execution.measureId !== plan.measureId) {
    return indeterminateExecution(plan.measureId, 'OWNER_EXECUTION_INDETERMINATE');
  }
  if (!actionEvidenceMatchesPlan(execution.actionEvidence, plan)) {
    const [firstExecutionAction] = execution.actionEvidence;
    const [firstPlannedAction] = plan.actions;
    return {
      _tag: 'BLOCKED',
      blockerEvidenceRef:
        firstExecutionAction?.dispositionEvidence.ownerOrderFence ??
        firstPlannedAction?.dispositionEvidence.ownerOrderFence ??
        'inventory-owner-evidence:missing',
      measureId: plan.measureId,
      mutationPerformed: false,
      reason: 'OWNER_EVIDENCE_CHANGED',
    };
  }
  if (execution.outcome === 'INDETERMINATE') {
    return indeterminateExecution(plan.measureId, 'OWNER_EXECUTION_INDETERMINATE');
  }
  if (execution.outcome === 'PARTIAL') {
    return finalizePartialPrivacyMeasure(execution, plan, protection);
  }
  if (execution.outcome === 'BLOCKED') {
    return {
      _tag: 'BLOCKED',
      blockerEvidenceRef: execution.blockerEvidenceRef,
      measureId: plan.measureId,
      mutationPerformed: false,
      reason: 'OWNER_REPORTED_BLOCKER',
    };
  }
  if (execution.outcome === 'TECHNICAL_FAILED') {
    return {
      _tag: 'TECHNICAL_FAILED',
      failureEvidenceRef: execution.failureEvidenceRef,
      measureId: plan.measureId,
      retryMayDuplicateEffect: false,
    };
  }
  return finalizeAchievedPrivacyMeasure(execution, plan, protection);
};
