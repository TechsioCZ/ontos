import type {
  PrivacyMeasureEncoded,
  PrivacyOwnerCoveragePartEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerExecutionOutcomeEncoded,
} from '@app/shared-contracts';
import { Match } from 'effect';

export const TAX_PRIVACY_OWNER_CAPABILITY = 'commerce.tax';

/**
 * TAX-owned privacy responsibilities that must all be accounted for before TAX can truthfully report complete
 * NO_DATA (#956 F13-F19). They are responsibilities, not assertions that every part holds personal data.
 */
export const taxPrivacyOwnerScopeParts = [
  'ACTOR_PRINCIPAL_ATTRIBUTION',
  'TAX_RULE_GOVERNANCE_HISTORY',
  'TAX_FACT_AUTHORITY_CONTRACT_HISTORY',
  'SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY',
  'SOURCE_CONFLICT_DETECTION_EVIDENCE',
  'ACCEPTED_TAX_TERMS_COPIES',
  'EXTERNAL_COPY_AND_RECOVERY_RESPONSIBILITIES',
] as const;
export type TaxPrivacyOwnerScopePart = (typeof taxPrivacyOwnerScopeParts)[number];

export const taxPrivacyOwnerScopeRef = (scopePart: TaxPrivacyOwnerScopePart): string =>
  `${TAX_PRIVACY_OWNER_CAPABILITY}/privacy-owner-scope/${scopePart}`;

export const taxPrivacyOwnerScopeRefs: readonly string[] = taxPrivacyOwnerScopeParts.map(taxPrivacyOwnerScopeRef);

const scopePartByRef = new Map(
  taxPrivacyOwnerScopeParts.map((scopePart) => [taxPrivacyOwnerScopeRef(scopePart), scopePart] as const),
);

/**
 * Published TAX owner and copy coverage declaration (#956 F16-F17, H "TAX publishes exact owner/copy coverage").
 * Accepted Tax Terms copies are held by Order/Billing snapshots under their own Privacy Owner Contracts; TAX
 * persists none (#907 D2 default (a)). TAX has no external recipient (#907 D5 default: no VIES/ARES/Integration
 * Route). Attribution coverage is observed per Selling Legal Entity, the TAX row-level isolation boundary.
 */
export const taxPrivacyOwnerDeclaration = {
  acceptedTaxTermsCopyHolders: ['Order Acceptance Decision Bundle / Order Snapshot', 'Billing Document snapshots'],
  attributionCoverageBoundary: 'SELLING_LEGAL_ENTITY',
  externalCopyRecipients: [],
  ownerCapability: TAX_PRIVACY_OWNER_CAPABILITY,
  ownerMutationBoundary: 'NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION',
} as const;

export interface TaxPrivacyScopeObservation {
  readonly coverageStatus: PrivacyOwnerCoveragePartEncoded['coverageStatus'];
  readonly evidenceRefs: readonly string[];
  readonly foundContentRefs: readonly string[];
  readonly observedAt: PrivacyOwnerCoveragePartEncoded['observedAt'];
  readonly scopePart: TaxPrivacyOwnerScopePart;
  readonly unresolvedReason?: string;
}

export interface TaxPrivacyCoverageInput {
  readonly assessedAt: PrivacyOwnerCoverageResultEncoded['assessedAt'];
  readonly evidenceRefs: readonly string[];
  readonly observations: readonly TaxPrivacyScopeObservation[];
  readonly scope: PrivacyOwnerCoverageResultEncoded['scope'];
}

const incompleteCoveragePriority = [
  'INDETERMINATE',
  'UNAVAILABLE',
  'PARTIAL',
] as const satisfies readonly PrivacyOwnerCoverageResultEncoded['coverageStatus'][];

const aggregateCoverageStatus = (
  parts: readonly PrivacyOwnerCoveragePartEncoded[],
): PrivacyOwnerCoverageResultEncoded['coverageStatus'] => {
  if (parts.length > 0 && parts.every(({ coverageStatus }) => coverageStatus === 'COMPLETE')) {
    return 'COMPLETE';
  }
  return (
    incompleteCoveragePriority.find((status) => parts.some(({ coverageStatus }) => coverageStatus === status)) ??
    'INDETERMINATE'
  );
};

const indeterminatePart = (
  scopeRef: string,
  assessedAt: string,
  unresolvedReason: string,
  observations: readonly TaxPrivacyScopeObservation[] = [],
): PrivacyOwnerCoveragePartEncoded => ({
  coverageStatus: 'INDETERMINATE',
  evidenceRefs: observations.flatMap(({ evidenceRefs }) => evidenceRefs),
  foundContentRefs: observations.flatMap(({ foundContentRefs }) => foundContentRefs),
  observedAt: assessedAt,
  scopeRef,
  unresolvedReason,
});

const coveragePartOf = (
  scopeRef: string,
  observations: readonly TaxPrivacyScopeObservation[],
  assessedAt: string,
): PrivacyOwnerCoveragePartEncoded => {
  const [observation] = observations;
  if (observations.length !== 1 || observation === undefined) {
    return indeterminatePart(
      scopeRef,
      assessedAt,
      observations.length === 0 ? 'REQUIRED_TAX_OWNER_SCOPE_NOT_OBSERVED' : 'DUPLICATE_TAX_OWNER_SCOPE_OBSERVATION',
      observations,
    );
  }
  const part = {
    coverageStatus: observation.coverageStatus,
    evidenceRefs: [...observation.evidenceRefs],
    foundContentRefs: [...observation.foundContentRefs],
    observedAt: observation.observedAt,
    scopeRef,
  };
  return observation.coverageStatus === 'COMPLETE'
    ? part
    : { ...part, unresolvedReason: observation.unresolvedReason ?? 'TAX_OWNER_SCOPE_NOT_COMPLETELY_VERIFIED' };
};

/**
 * Adapts TAX scope observations to the shared Privacy Owner Contract for exactly the requested owner scope parts.
 * A requested part TAX does not own, a foreign owner capability, or a missing/duplicate observation stays
 * INDETERMINATE instead of becoming NO_DATA (#956 F18-F20). Each part carries its own observation time: the
 * contribution never claims an atomic snapshot across parts or with foreign owners (#956 F21-F22).
 */
export const assessTaxPrivacyOwnerCoverage = (input: TaxPrivacyCoverageInput): PrivacyOwnerCoverageResultEncoded => {
  const isTaxScope = input.scope.ownerCapability === TAX_PRIVACY_OWNER_CAPABILITY;
  const coverageParts = input.scope.requestedScopePartRefs.map((scopeRef) => {
    const scopePart = scopePartByRef.get(scopeRef);
    if (!isTaxScope) {
      return indeterminatePart(scopeRef, input.assessedAt, 'NOT_A_TAX_OWNER_CAPABILITY_SCOPE');
    }
    if (scopePart === undefined) {
      return indeterminatePart(scopeRef, input.assessedAt, 'NOT_A_TAX_OWNER_SCOPE_PART');
    }
    return coveragePartOf(
      scopeRef,
      input.observations.filter((observation) => observation.scopePart === scopePart),
      input.assessedAt,
    );
  });
  const coverageStatus = aggregateCoverageStatus(coverageParts);
  let contentStatus: PrivacyOwnerCoverageResultEncoded['contentStatus'] = 'UNKNOWN';
  if (coverageParts.some(({ foundContentRefs }) => foundContentRefs.length > 0)) {
    contentStatus = 'FOUND';
  } else if (coverageStatus === 'COMPLETE') {
    contentStatus = 'NO_DATA';
  }
  return {
    assessedAt: input.assessedAt,
    contentStatus,
    coverageParts,
    coverageStatus,
    evidenceRefs: [...input.evidenceRefs],
    scope: input.scope,
  };
};

/** A Current Legal Hold or retention obligation decided by Privacy; TAX owns neither (#956 E, F34). */
export interface TaxPrivacyMeasureBlocker {
  readonly blockerRef: string;
  readonly contentRefs: readonly string[];
  readonly kind: 'LEGAL_HOLD' | 'RETENTION_OBLIGATION';
}

export interface TaxPrivacyPreviousAttempt {
  readonly measure: PrivacyMeasureEncoded;
  readonly outcome: PrivacyOwnerExecutionOutcomeEncoded;
}

export interface TaxPrivacyMeasureEvaluationInput {
  readonly blockers: readonly TaxPrivacyMeasureBlocker[];
  readonly confirmedAt: PrivacyOwnerExecutionOutcomeEncoded['confirmedAt'];
  readonly coverage: PrivacyOwnerCoverageResultEncoded;
  readonly evidenceRefs: readonly string[];
  readonly measure: PrivacyMeasureEncoded;
  readonly outcomeRef: string;
  readonly previousAttempt?: TaxPrivacyPreviousAttempt;
}

const canonicalReferences = (references: readonly string[]): readonly string[] => [...references].toSorted();

const hasExactReferences = (left: readonly string[], right: readonly string[]): boolean => {
  const canonicalLeft = canonicalReferences(left);
  const canonicalRight = canonicalReferences(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((reference, index) => reference === canonicalRight[index])
  );
};

const subjectKey = (subject: PrivacyMeasureEncoded['scope']['subject']): string =>
  Match.value(subject).pipe(
    Match.tag('RESOLVED_DATA_SUBJECT', ({ subjectRef }) => `RESOLVED_DATA_SUBJECT:${subjectRef}`),
    Match.tag('ANONYMOUS_PRIVACY_CONTEXT', ({ contextRef }) => `ANONYMOUS_PRIVACY_CONTEXT:${contextRef}`),
    Match.exhaustive,
  );

/** Exact owner scope equality; reference lists compare as sets because their order carries no meaning. */
const isSameOwnerScope = (left: PrivacyMeasureEncoded['scope'], right: PrivacyMeasureEncoded['scope']): boolean =>
  left.controllerRef === right.controllerRef &&
  (left.dsrControllerObligationRef ?? '') === (right.dsrControllerObligationRef ?? '') &&
  left.ownerCapability === right.ownerCapability &&
  left.requestedScopeRef === right.requestedScopeRef &&
  left.tenantId === right.tenantId &&
  subjectKey(left.subject) === subjectKey(right.subject) &&
  hasExactReferences(left.requestedScopePartRefs, right.requestedScopePartRefs) &&
  hasExactReferences(left.trustedLookupRefs, right.trustedLookupRefs);

/** Measure identity: a retry of the same Privacy Measure must carry exactly this meaning (#956 F47). */
export const isSameTaxPrivacyMeasureIdentity = (left: PrivacyMeasureEncoded, right: PrivacyMeasureEncoded): boolean =>
  left.idempotencyKey === right.idempotencyKey &&
  left.intendedOutcome === right.intendedOutcome &&
  left.measureRef === right.measureRef &&
  left.requestedAt === right.requestedAt &&
  left.sourceDecisionRef === right.sourceDecisionRef &&
  left.sourceDecisionRevision === right.sourceDecisionRevision &&
  isSameOwnerScope(left.scope, right.scope) &&
  hasExactReferences(left.expectedEvidenceRefs, right.expectedEvidenceRefs) &&
  hasExactReferences(left.preconditionRefs, right.preconditionRefs) &&
  hasExactReferences(left.targetContentRefs, right.targetContentRefs);

const outcomeOf = (
  input: TaxPrivacyMeasureEvaluationInput,
  status: 'BLOCKED' | 'BUSINESS_REJECTED' | 'INDETERMINATE' | 'NOT_APPLICABLE',
  reason: string,
): PrivacyOwnerExecutionOutcomeEncoded => ({
  affectedContentRefs: [],
  confirmedAt: input.confirmedAt,
  evidenceRefs: [...input.evidenceRefs],
  measureRef: input.measure.measureRef,
  outcomeRef: input.outcomeRef,
  reason,
  reconciliationRequired: status === 'INDETERMINATE',
  remainingContentRefs: status === 'NOT_APPLICABLE' ? [] : [...input.measure.targetContentRefs],
  scope: input.measure.scope,
  sourceDecisionRef: input.measure.sourceDecisionRef,
  sourceDecisionRevision: input.measure.sourceDecisionRevision,
  status,
});

const isDestructive = (intendedOutcome: PrivacyMeasureEncoded['intendedOutcome']): boolean =>
  intendedOutcome === 'DELETE' || intendedOutcome === 'ANONYMIZE';

/** Validates the Current target and Privacy-owned blockers before any owner effect (#956 F33-F35). */
const evaluateCurrentMeasure = (input: TaxPrivacyMeasureEvaluationInput): PrivacyOwnerExecutionOutcomeEncoded => {
  const { coverage, measure } = input;
  if (!isSameOwnerScope(coverage.scope, measure.scope)) {
    return outcomeOf(input, 'BUSINESS_REJECTED', 'OWNER_COVERAGE_SCOPE_DOES_NOT_MATCH_MEASURE_SCOPE');
  }
  if (coverage.coverageStatus !== 'COMPLETE' && coverage.contentStatus !== 'FOUND') {
    return outcomeOf(input, 'INDETERMINATE', 'TAX_OWNER_SCOPE_COVERAGE_INCOMPLETE');
  }
  if (coverage.contentStatus === 'NO_DATA') {
    return outcomeOf(input, 'NOT_APPLICABLE', 'COMPLETE_TAX_OWNER_SCOPE_CONFIRMS_NO_DATA');
  }
  const currentContent = new Set(coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs));
  if (!measure.targetContentRefs.every((contentRef) => currentContent.has(contentRef))) {
    // Absence from partial coverage proves nothing (#956 F20): only complete coverage settles a missing target.
    return coverage.coverageStatus === 'COMPLETE'
      ? outcomeOf(input, 'BUSINESS_REJECTED', 'TARGET_CONTENT_NOT_IN_CURRENT_TAX_OWNER_COVERAGE')
      : outcomeOf(input, 'INDETERMINATE', 'TAX_OWNER_SCOPE_COVERAGE_INCOMPLETE');
  }
  const targets = new Set(measure.targetContentRefs);
  const blocked = input.blockers.some(({ contentRefs }) => contentRefs.some((contentRef) => targets.has(contentRef)));
  if (isDestructive(measure.intendedOutcome) && blocked) {
    return outcomeOf(input, 'BLOCKED', 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT');
  }
  return outcomeOf(input, 'BUSINESS_REJECTED', 'NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
};

/** Settled outcomes TAX itself produces; any other supplied status is not TAX evidence and is never replayed. */
const settledTaxStatuses: ReadonlySet<PrivacyOwnerExecutionOutcomeEncoded['status']> = new Set([
  'BLOCKED',
  'BUSINESS_REJECTED',
  'NOT_APPLICABLE',
]);

const isSettledTaxOutcome = (outcome: PrivacyOwnerExecutionOutcomeEncoded): boolean =>
  settledTaxStatuses.has(outcome.status);

/**
 * Evaluates TAX's truthful owner response to an approved Privacy Measure. Every TAX row is append-only governance
 * evidence and TAX has no approved privacy mutation lifecycle, so TAX never alters an artifact and keeps presenting
 * it as the original (#956 F38-F40) and never reports ACHIEVED, PARTIAL or an anti-resurrection protection for an
 * effect it cannot perform (F32, F35, F42). Owner Execution Outcome stays separate from the Privacy decision (F29).
 *
 * Retry keeps the measure identity (F47): a changed identity is rejected and a settled TAX outcome is replayed. An
 * INDETERMINATE outcome here only ever means coverage was incomplete; no TAX effect was attempted, so the owner
 * reconciliation is a fresh evaluation against Current coverage and can never duplicate an effect (F48-F49). A
 * supplied previous status TAX cannot produce (e.g. ACHIEVED) is re-evaluated, never echoed (F32, F35).
 */
export const evaluateTaxPrivacyMeasure = (
  input: TaxPrivacyMeasureEvaluationInput,
): PrivacyOwnerExecutionOutcomeEncoded => {
  const previous = input.previousAttempt;
  if (previous === undefined) {
    return evaluateCurrentMeasure(input);
  }
  if (!isSameTaxPrivacyMeasureIdentity(previous.measure, input.measure)) {
    return outcomeOf(input, 'BUSINESS_REJECTED', 'IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT');
  }
  return isSettledTaxOutcome(previous.outcome) ? previous.outcome : evaluateCurrentMeasure(input);
};
