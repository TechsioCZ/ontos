import type {
  AntiResurrectionProtectionEncoded,
  PrivacyMeasureEncoded,
  PrivacyOwnerCoveragePartEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerExecutionOutcomeEncoded,
  PrivacyOwnerReconciliationResultEncoded,
} from '@app/shared-contracts';
import { Function as EffectFunction, Match } from 'effect';

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

/**
 * Private TAX tables examined per scope part. Attribution columns exist on every table; the Selling Legal Entity
 * content parts own disjoint table sets. A part with no tables holds no TAX persistence by declaration.
 */
export const taxPrivacyOwnerScopePartTables = {
  ACCEPTED_TAX_TERMS_COPIES: [],
  ACTOR_PRINCIPAL_ATTRIBUTION: [
    'tax_rules',
    'tax_rule_revisions',
    'tax_rule_revision_end_facts',
    'tax_rule_corrections',
    'tax_fact_authority_contracts',
    'tax_fact_authority_contract_revisions',
    'tax_source_assertions',
    'tax_source_conflicts',
  ],
  EXTERNAL_COPY_AND_RECOVERY_RESPONSIBILITIES: [],
  SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY: ['tax_source_assertions'],
  SOURCE_CONFLICT_DETECTION_EVIDENCE: ['tax_source_conflicts'],
  TAX_FACT_AUTHORITY_CONTRACT_HISTORY: ['tax_fact_authority_contracts', 'tax_fact_authority_contract_revisions'],
  TAX_RULE_GOVERNANCE_HISTORY: [
    'tax_rules',
    'tax_rule_revisions',
    'tax_rule_revision_end_facts',
    'tax_rule_corrections',
  ],
} as const satisfies Record<TaxPrivacyOwnerScopePart, readonly string[]>;

/** Opaque owner reference to one TAX row, safe to hand to Privacy without exposing the table content. */
export const taxPrivacyContentRef = (tableName: string, rowId: string): string =>
  `${TAX_PRIVACY_OWNER_CAPABILITY}/${tableName}/${rowId}`;

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
  if (parts.every(({ coverageStatus }) => coverageStatus === 'COMPLETE')) {
    return 'COMPLETE';
  }
  return (
    incompleteCoveragePriority.find((status) => parts.some(({ coverageStatus }) => coverageStatus === status)) ??
    'INDETERMINATE'
  );
};

const coveragePartOf = (
  scopePart: TaxPrivacyOwnerScopePart,
  observations: readonly TaxPrivacyScopeObservation[],
  assessedAt: string,
): PrivacyOwnerCoveragePartEncoded => {
  const scopeRef = taxPrivacyOwnerScopeRef(scopePart);
  const [observation] = observations;
  if (observations.length !== 1 || observation === undefined) {
    return {
      coverageStatus: 'INDETERMINATE',
      evidenceRefs: observations.flatMap(({ evidenceRefs }) => evidenceRefs),
      foundContentRefs: observations.flatMap(({ foundContentRefs }) => foundContentRefs),
      observedAt: assessedAt,
      scopeRef,
      unresolvedReason:
        observations.length === 0 ? 'REQUIRED_TAX_OWNER_SCOPE_NOT_OBSERVED' : 'DUPLICATE_TAX_OWNER_SCOPE_OBSERVATION',
    };
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
 * Adapts TAX scope observations to the shared Privacy Owner Contract. Each part carries its own observation time:
 * the contribution never claims an atomic snapshot across parts or with foreign owners (#956 F21-F22). Missing or
 * duplicate observations stay INDETERMINATE instead of becoming NO_DATA (#956 F18-F20).
 */
export const assessTaxPrivacyOwnerCoverage = (input: TaxPrivacyCoverageInput): PrivacyOwnerCoverageResultEncoded => {
  const coverageParts = taxPrivacyOwnerScopeParts.map((scopePart) =>
    coveragePartOf(
      scopePart,
      input.observations.filter((observation) => observation.scopePart === scopePart),
      input.assessedAt,
    ),
  );
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
  readonly antiResurrectionProtection?: AntiResurrectionProtectionEncoded;
  readonly blockers: readonly TaxPrivacyMeasureBlocker[];
  readonly confirmedAt: PrivacyOwnerExecutionOutcomeEncoded['confirmedAt'];
  readonly coverage: PrivacyOwnerCoverageResultEncoded;
  readonly evidenceRefs: readonly string[];
  readonly measure: PrivacyMeasureEncoded;
  readonly outcomeRef: string;
  readonly previousAttempt?: TaxPrivacyPreviousAttempt;
  readonly reconciliation?: PrivacyOwnerReconciliationResultEncoded;
}

export interface TaxPrivacyMeasureEvaluation {
  readonly antiResurrectionProtection?: AntiResurrectionProtectionEncoded;
  readonly outcome: PrivacyOwnerExecutionOutcomeEncoded;
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

const requiredAntiResurrectionKind = (
  intendedOutcome: PrivacyMeasureEncoded['intendedOutcome'],
): AntiResurrectionProtectionEncoded['kind'] | undefined =>
  Match.value(intendedOutcome).pipe(
    Match.when('DELETE', () => 'DELETED_SCOPE' as const),
    Match.when('ANONYMIZE', () => 'ANONYMIZED_SCOPE' as const),
    Match.when('ENFORCE_DISPOSITION_RESTRICTION', () => 'OWNER_ENFORCED_DISPOSITION_RESTRICTION' as const),
    Match.when('ENFORCE_PROCESSING_RESTRICTION', () => 'OWNER_ENFORCED_PROCESSING_RESTRICTION' as const),
    Match.when('RECTIFY', EffectFunction.constUndefined),
    Match.exhaustive,
  );

const allStaleSourceResponsibilities = ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'];

/** Anti-resurrection evidence scoped to exactly this measure's content and outcome (#956 F42-F44, F50). */
const provesProtection = (input: TaxPrivacyMeasureEvaluationInput): boolean => {
  const requiredKind = requiredAntiResurrectionKind(input.measure.intendedOutcome);
  const protection = input.antiResurrectionProtection;
  return (
    requiredKind === undefined ||
    (protection !== undefined &&
      protection.kind === requiredKind &&
      isSameOwnerScope(protection.scope, input.measure.scope) &&
      protection.sourceDecisionRef === input.measure.sourceDecisionRef &&
      protection.sourceDecisionRevision === input.measure.sourceDecisionRevision &&
      protection.sourceOutcomeRef === input.outcomeRef &&
      hasExactReferences(protection.protectedContentRefs, input.measure.targetContentRefs) &&
      hasExactReferences(protection.staleSourceResponsibilities, allStaleSourceResponsibilities))
  );
};

type OutcomeFields = Pick<
  PrivacyOwnerExecutionOutcomeEncoded,
  'affectedContentRefs' | 'reason' | 'reconciliationRequired' | 'remainingContentRefs' | 'status'
>;

const outcomeOf = (
  input: TaxPrivacyMeasureEvaluationInput,
  fields: OutcomeFields,
  extraEvidenceRefs: readonly string[] = [],
): PrivacyOwnerExecutionOutcomeEncoded => ({
  ...fields,
  confirmedAt: input.confirmedAt,
  evidenceRefs: [...input.evidenceRefs, ...extraEvidenceRefs],
  measureRef: input.measure.measureRef,
  outcomeRef: input.outcomeRef,
  scope: input.measure.scope,
  sourceDecisionRef: input.measure.sourceDecisionRef,
  sourceDecisionRevision: input.measure.sourceDecisionRevision,
});

const notAchieved = (
  input: TaxPrivacyMeasureEvaluationInput,
  status: 'BLOCKED' | 'BUSINESS_REJECTED' | 'INDETERMINATE',
  reason: string,
): TaxPrivacyMeasureEvaluation => ({
  outcome: outcomeOf(input, {
    affectedContentRefs: [],
    reason,
    reconciliationRequired: status === 'INDETERMINATE',
    remainingContentRefs: [...input.measure.targetContentRefs],
    status,
  }),
});

/**
 * Retry of an INDETERMINATE attempt is decided by owner reconciliation, never by repeating the effect
 * (#956 F47-F48). None means reconciliation authorized a fresh evaluation.
 */
const reconcileIndeterminateAttempt = (
  input: TaxPrivacyMeasureEvaluationInput,
): TaxPrivacyMeasureEvaluation | undefined => {
  const { reconciliation } = input;
  if (
    reconciliation === undefined ||
    reconciliation.measureRef !== input.measure.measureRef ||
    reconciliation.sourceDecisionRevision !== input.measure.sourceDecisionRevision ||
    reconciliation.status === 'STILL_INDETERMINATE' ||
    reconciliation.status === 'PARTIAL_CONFIRMED'
  ) {
    return notAchieved(input, 'INDETERMINATE', 'OWNER_RECONCILIATION_REQUIRED_BEFORE_RETRY');
  }
  if (reconciliation.status === 'NOT_EXECUTED') {
    return reconciliation.retryAllowed
      ? undefined
      : notAchieved(input, 'INDETERMINATE', 'OWNER_RECONCILIATION_DID_NOT_AUTHORIZE_RETRY');
  }
  const targets = [...input.measure.targetContentRefs];
  if (!provesProtection(input)) {
    return {
      outcome: outcomeOf(
        input,
        {
          affectedContentRefs: targets,
          reason: 'EXECUTION_CONFIRMED_BUT_ANTI_RESURRECTION_PROTECTION_NOT_PROVEN',
          reconciliationRequired: false,
          remainingContentRefs: targets,
          status: 'PARTIAL',
        },
        reconciliation.evidenceRefs,
      ),
    };
  }
  const achieved = {
    outcome: outcomeOf(
      input,
      {
        affectedContentRefs: targets,
        reason: 'ORIGINAL_OWNER_EXECUTION_CONFIRMED_BY_RECONCILIATION',
        reconciliationRequired: false,
        remainingContentRefs: [],
        status: 'ACHIEVED',
      },
      reconciliation.evidenceRefs,
    ),
  } satisfies TaxPrivacyMeasureEvaluation;
  const protection = input.antiResurrectionProtection;
  return protection === undefined ? achieved : { ...achieved, antiResurrectionProtection: protection };
};

const isDestructive = (intendedOutcome: PrivacyMeasureEncoded['intendedOutcome']): boolean =>
  intendedOutcome === 'DELETE' || intendedOutcome === 'ANONYMIZE';

/** Validates the Current target and Privacy-owned blockers before any owner effect (#956 F33-F35). */
const evaluateFreshMeasure = (input: TaxPrivacyMeasureEvaluationInput): TaxPrivacyMeasureEvaluation => {
  const { coverage, measure } = input;
  if (!isSameOwnerScope(coverage.scope, measure.scope)) {
    return notAchieved(input, 'BUSINESS_REJECTED', 'OWNER_COVERAGE_SCOPE_DOES_NOT_MATCH_MEASURE_SCOPE');
  }
  if (coverage.coverageStatus !== 'COMPLETE') {
    return notAchieved(input, 'INDETERMINATE', 'COMPLETE_TAX_OWNER_SCOPE_COVERAGE_REQUIRED');
  }
  if (coverage.contentStatus === 'NO_DATA') {
    return {
      outcome: outcomeOf(input, {
        affectedContentRefs: [],
        reason: 'COMPLETE_TAX_OWNER_SCOPE_CONFIRMS_NO_DATA',
        reconciliationRequired: false,
        remainingContentRefs: [],
        status: 'NOT_APPLICABLE',
      }),
    };
  }
  const currentContent = new Set(coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs));
  if (!measure.targetContentRefs.every((contentRef) => currentContent.has(contentRef))) {
    return notAchieved(input, 'BUSINESS_REJECTED', 'TARGET_CONTENT_NOT_IN_CURRENT_TAX_OWNER_COVERAGE');
  }
  const targets = new Set(measure.targetContentRefs);
  const blocked = input.blockers.some(({ contentRefs }) => contentRefs.some((contentRef) => targets.has(contentRef)));
  if (isDestructive(measure.intendedOutcome) && blocked) {
    return notAchieved(input, 'BLOCKED', 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT');
  }
  return notAchieved(input, 'BUSINESS_REJECTED', 'NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
};

/**
 * Evaluates TAX's truthful owner response to an approved Privacy Measure. Every TAX row is append-only governance
 * evidence and TAX has no approved privacy mutation lifecycle, so TAX never alters an artifact and keeps presenting
 * it as the original (#956 F38-F40): the outcome is NOT_APPLICABLE, BLOCKED, BUSINESS_REJECTED or INDETERMINATE,
 * never a fabricated ACHIEVED (F32, F35). Owner Execution Outcome stays separate from the Privacy decision (F29).
 */
export const evaluateTaxPrivacyMeasure = (input: TaxPrivacyMeasureEvaluationInput): TaxPrivacyMeasureEvaluation => {
  const previous = input.previousAttempt;
  if (previous === undefined) {
    return evaluateFreshMeasure(input);
  }
  if (!isSameTaxPrivacyMeasureIdentity(previous.measure, input.measure)) {
    return notAchieved(input, 'BUSINESS_REJECTED', 'IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT');
  }
  if (previous.outcome.status !== 'INDETERMINATE') {
    return { outcome: previous.outcome };
  }
  return reconcileIndeterminateAttempt(input) ?? evaluateFreshMeasure(input);
};

/**
 * Published TAX owner coverage declaration (#956 H "TAX publishes exact owner/copy coverage"). Accepted Tax Terms
 * copies are held by Order/Billing snapshots under their own Privacy Owner Contracts; TAX persists none (#907 D2
 * default (a)). TAX has no external recipient (#907 D5 default: no VIES/ARES/Integration Route).
 */
export const taxPrivacyOwnerContract = {
  acceptedTaxTermsCopyHolders: ['Order Acceptance Decision Bundle / Order Snapshot', 'Billing Document snapshots'],
  antiResurrectionProtectionRequiredFor: [
    'DELETE',
    'ANONYMIZE',
    'ENFORCE_DISPOSITION_RESTRICTION',
    'ENFORCE_PROCESSING_RESTRICTION',
  ],
  externalCopyRecipients: [],
  ownerCapability: TAX_PRIVACY_OWNER_CAPABILITY,
  ownerMutationBoundary: 'NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION',
  requiredScopeParts: taxPrivacyOwnerScopeParts,
  scopePartTables: taxPrivacyOwnerScopePartTables,
} as const;
