import type {
  AntiResurrectionProtectionEncoded,
  PrivacyMeasureEncoded,
  PrivacyOwnerCoveragePartEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerExecutionOutcomeEncoded,
  PrivacyOwnerReconciliationResultEncoded,
} from '@app/shared-contracts';
import { Function as EffectFunction, Match } from 'effect';

/**
 * Inventory-owned privacy scope that must be accounted for before Inventory can truthfully report
 * complete NO_DATA. These are responsibilities, not assertions that every scope contains personal data.
 */
export const inventoryPrivacyOwnerScopeParts = [
  'ACTOR_PRINCIPAL_ATTRIBUTION',
  'CURRENT_RESERVATION_CORRELATIONS',
  'BACKEND_AUTHORITY_AND_CUTOVER_HISTORY',
  'DEMAND_SELECTION_BINDING_AND_REQUIREMENTS_HISTORY',
  'RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY',
  'CONFIRMATION_SHORTAGE_PRIORITY_AND_RELEASE_HISTORY',
  'COMMITMENT_PROTECTION_HISTORY',
  'COMMITTED_OBLIGATION_HISTORY',
  'EFFECT_AND_RECONCILIATION_EVIDENCE',
  'PHYSICAL_STOCK_EFFECT_AND_STOCK_CORRECTION_EVIDENCE',
  'EXTERNAL_SOURCE_ASSERTION_COVERAGE_AND_CORRELATION_HISTORY',
  'EXTERNAL_COPY_RESPONSIBILITIES',
  'IMPORT_REPLAY_PROJECTION_AND_BACKUP_RESPONSIBILITIES',
] as const;

export type InventoryPrivacyOwnerScopePart = (typeof inventoryPrivacyOwnerScopeParts)[number];

export interface InventoryPrivacyScopeObservation {
  readonly coverageStatus: PrivacyOwnerCoveragePartEncoded['coverageStatus'];
  readonly evidenceRefs: readonly string[];
  readonly foundContentRefs: readonly string[];
  readonly observedAt: PrivacyOwnerCoveragePartEncoded['observedAt'];
  readonly scopePart: InventoryPrivacyOwnerScopePart;
  readonly unresolvedReason?: string;
}

export interface InventoryPrivacyCoverageInput {
  readonly assessedAt: PrivacyOwnerCoverageResultEncoded['assessedAt'];
  readonly evidenceRefs: readonly string[];
  readonly observations: readonly InventoryPrivacyScopeObservation[];
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

/**
 * Adapts complete Inventory-owned scope observations to the shared Privacy Owner Contract.
 * Missing or duplicate scope observations remain indeterminate instead of becoming NO_DATA.
 */
export const assessInventoryPrivacyOwnerCoverage = (
  input: InventoryPrivacyCoverageInput,
): PrivacyOwnerCoverageResultEncoded => {
  const observationsByPart = new Map<InventoryPrivacyOwnerScopePart, InventoryPrivacyScopeObservation[]>();
  for (const observation of input.observations) {
    const observations = observationsByPart.get(observation.scopePart) ?? [];
    observations.push(observation);
    observationsByPart.set(observation.scopePart, observations);
  }

  const coverageParts = inventoryPrivacyOwnerScopeParts.map((scopePart): PrivacyOwnerCoveragePartEncoded => {
    const observations = observationsByPart.get(scopePart) ?? [];
    const [observation] = observations;
    if (observations.length !== 1 || observation === undefined) {
      const unresolvedReason =
        observations.length === 0
          ? 'REQUIRED_INVENTORY_OWNER_SCOPE_NOT_OBSERVED'
          : 'DUPLICATE_INVENTORY_OWNER_SCOPE_OBSERVATION';
      return {
        coverageStatus: 'INDETERMINATE',
        evidenceRefs: observations.flatMap(({ evidenceRefs }) => evidenceRefs),
        foundContentRefs: observations.flatMap(({ foundContentRefs }) => foundContentRefs),
        observedAt: input.assessedAt,
        scopeRef: `commerce.inventory/privacy-owner-scope/${scopePart}`,
        unresolvedReason,
      };
    }

    const coveragePart = {
      coverageStatus: observation.coverageStatus,
      evidenceRefs: [...observation.evidenceRefs],
      foundContentRefs: [...observation.foundContentRefs],
      observedAt: observation.observedAt,
      scopeRef: `commerce.inventory/privacy-owner-scope/${scopePart}`,
    };
    if (observation.coverageStatus === 'COMPLETE') {
      return coveragePart;
    }
    return {
      ...coveragePart,
      unresolvedReason: observation.unresolvedReason ?? 'INVENTORY_OWNER_SCOPE_NOT_COMPLETELY_VERIFIED',
    };
  });
  const coverageStatus = aggregateCoverageStatus(coverageParts);
  const anyContentFound = coverageParts.some(({ foundContentRefs }) => foundContentRefs.length > 0);
  let contentStatus: PrivacyOwnerCoverageResultEncoded['contentStatus'];
  if (anyContentFound) {
    contentStatus = 'FOUND';
  } else if (coverageStatus === 'COMPLETE') {
    contentStatus = 'NO_DATA';
  } else {
    contentStatus = 'UNKNOWN';
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

export const inventoryPrivacyEvidencePreservationClasses = [
  'REQUIRED_RESERVATION_EVIDENCE',
  'REQUIRED_COMMITTED_OBLIGATION_EVIDENCE',
  'REQUIRED_HISTORICAL_EVIDENCE',
  'PRIVACY_RELEVANT_OWNER_COPY',
] as const;
export type InventoryPrivacyEvidencePreservationClass = (typeof inventoryPrivacyEvidencePreservationClasses)[number];

export interface InventoryPrivacyMeasureTarget {
  readonly contentRef: string;
  readonly preservationClass: InventoryPrivacyEvidencePreservationClass;
}

export interface InventoryPrivacyPreviousAttempt {
  readonly measure: PrivacyMeasureEncoded;
  readonly outcome: PrivacyOwnerExecutionOutcomeEncoded;
}

export interface InventoryPrivacyMeasureEvaluationInput {
  readonly antiResurrectionProtection?: AntiResurrectionProtectionEncoded;
  readonly confirmedAt: PrivacyOwnerExecutionOutcomeEncoded['confirmedAt'];
  readonly coverage: PrivacyOwnerCoverageResultEncoded;
  readonly evidenceRefs: readonly string[];
  readonly measure: PrivacyMeasureEncoded;
  readonly outcomeRef: string;
  readonly previousAttempt?: InventoryPrivacyPreviousAttempt;
  readonly reconciliation?: PrivacyOwnerReconciliationResultEncoded;
  readonly targets: readonly InventoryPrivacyMeasureTarget[];
}

export interface InventoryPrivacyMeasureEvaluation {
  readonly antiResurrectionProtection?: AntiResurrectionProtectionEncoded;
  readonly outcome: PrivacyOwnerExecutionOutcomeEncoded;
}

const canonicalReferences = (references: readonly string[]): readonly string[] => [...references].toSorted();

const canonicalPrivacySubject = (subject: PrivacyMeasureEncoded['scope']['subject']) =>
  Match.value(subject).pipe(
    Match.tag('RESOLVED_DATA_SUBJECT', ({ _tag, subjectRef }) => ({ _tag, subjectRef })),
    Match.tag('ANONYMOUS_PRIVACY_CONTEXT', ({ _tag, contextRef }) => ({ _tag, contextRef })),
    Match.exhaustive,
  );

const canonicalOwnerScope = (scope: PrivacyMeasureEncoded['scope']) => ({
  controllerRef: scope.controllerRef,
  dsrControllerObligationRef: scope.dsrControllerObligationRef ?? null,
  ownerCapability: scope.ownerCapability,
  requestedScopePartRefs: canonicalReferences(scope.requestedScopePartRefs),
  requestedScopeRef: scope.requestedScopeRef,
  subject: canonicalPrivacySubject(scope.subject),
  tenantId: scope.tenantId,
  trustedLookupRefs: canonicalReferences(scope.trustedLookupRefs),
});

/** Stable comparison value persisted by the previous-attempt measure itself. */
/* oxlint-disable effect-native/no-native-json-stringify -- The explicitly ordered canonical projection is the persisted fingerprint contract; expires: 2027-03-31. */
export const inventoryPrivacyMeasureIdentityFingerprint = (measure: PrivacyMeasureEncoded): string =>
  JSON.stringify({
    expectedEvidenceRefs: canonicalReferences(measure.expectedEvidenceRefs),
    idempotencyKey: measure.idempotencyKey,
    intendedOutcome: measure.intendedOutcome,
    measureRef: measure.measureRef,
    preconditionRefs: canonicalReferences(measure.preconditionRefs),
    requestedAt: measure.requestedAt,
    scope: canonicalOwnerScope(measure.scope),
    sourceDecisionRef: measure.sourceDecisionRef,
    sourceDecisionRevision: measure.sourceDecisionRevision,
    targetContentRefs: canonicalReferences(measure.targetContentRefs),
  });
/* oxlint-enable effect-native/no-native-json-stringify */

const hasSameMeasureIntent = (left: PrivacyMeasureEncoded, right: PrivacyMeasureEncoded): boolean =>
  inventoryPrivacyMeasureIdentityFingerprint(left) === inventoryPrivacyMeasureIdentityFingerprint(right);

const hasExactReferences = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const canonicalLeft = canonicalReferences(left);
  const canonicalRight = canonicalReferences(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((reference, index) => reference === canonicalRight[index])
  );
};

const hasSamePrivacySubject = (
  left: ReturnType<typeof canonicalPrivacySubject>,
  right: ReturnType<typeof canonicalPrivacySubject>,
): boolean =>
  Match.value(left).pipe(
    Match.tag('RESOLVED_DATA_SUBJECT', ({ subjectRef }) =>
      Match.value(right).pipe(
        Match.tag('RESOLVED_DATA_SUBJECT', (candidate) => subjectRef === candidate.subjectRef),
        Match.orElse(() => false),
      ),
    ),
    Match.tag('ANONYMOUS_PRIVACY_CONTEXT', ({ contextRef }) =>
      Match.value(right).pipe(
        Match.tag('ANONYMOUS_PRIVACY_CONTEXT', (candidate) => contextRef === candidate.contextRef),
        Match.orElse(() => false),
      ),
    ),
    Match.exhaustive,
  );

const hasSameOwnerScope = (left: PrivacyMeasureEncoded['scope'], right: PrivacyMeasureEncoded['scope']): boolean => {
  const leftCanonical = canonicalOwnerScope(left);
  const rightCanonical = canonicalOwnerScope(right);
  return (
    leftCanonical.controllerRef === rightCanonical.controllerRef &&
    leftCanonical.dsrControllerObligationRef === rightCanonical.dsrControllerObligationRef &&
    leftCanonical.ownerCapability === rightCanonical.ownerCapability &&
    leftCanonical.requestedScopeRef === rightCanonical.requestedScopeRef &&
    leftCanonical.tenantId === rightCanonical.tenantId &&
    hasSamePrivacySubject(leftCanonical.subject, rightCanonical.subject) &&
    hasExactReferences(leftCanonical.requestedScopePartRefs, rightCanonical.requestedScopePartRefs) &&
    hasExactReferences(leftCanonical.trustedLookupRefs, rightCanonical.trustedLookupRefs)
  );
};

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

/**
 * Evaluates Inventory's truthful response without inventing a generic privacy mutation path.
 * Inventory currently has no approved generic privacy Action; required business evidence is preserved,
 * and any indeterminate prior attempt must be reconciled before this evaluator considers a retry.
 */
// oxlint-disable-next-line eslint/complexity -- The owner decision table remains intentionally explicit and exhaustively tested; expires: 2027-03-31.
export const evaluateInventoryPrivacyMeasure = (
  input: InventoryPrivacyMeasureEvaluationInput,
): InventoryPrivacyMeasureEvaluation => {
  const baseOutcome = {
    confirmedAt: input.confirmedAt,
    evidenceRefs: [...input.evidenceRefs],
    measureRef: input.measure.measureRef,
    outcomeRef: input.outcomeRef,
    scope: input.measure.scope,
    sourceDecisionRef: input.measure.sourceDecisionRef,
    sourceDecisionRevision: input.measure.sourceDecisionRevision,
  } as const;
  const remainingContentRefs = [...input.measure.targetContentRefs];

  if (input.previousAttempt !== undefined) {
    if (!hasSameMeasureIntent(input.previousAttempt.measure, input.measure)) {
      return {
        outcome: {
          ...baseOutcome,
          affectedContentRefs: [],
          reason: 'IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT',
          reconciliationRequired: false,
          remainingContentRefs,
          status: 'BUSINESS_REJECTED',
        },
      };
    }

    if (input.previousAttempt.outcome.status === 'INDETERMINATE') {
      const { reconciliation } = input;
      if (
        reconciliation === undefined ||
        reconciliation.measureRef !== input.measure.measureRef ||
        reconciliation.sourceDecisionRevision !== input.measure.sourceDecisionRevision ||
        reconciliation.status === 'STILL_INDETERMINATE' ||
        reconciliation.status === 'PARTIAL_CONFIRMED'
      ) {
        return {
          outcome: {
            ...baseOutcome,
            affectedContentRefs: [],
            reason: 'OWNER_RECONCILIATION_REQUIRED_BEFORE_RETRY',
            reconciliationRequired: true,
            remainingContentRefs,
            status: 'INDETERMINATE',
          },
        };
      }
      if (reconciliation.status === 'EXECUTION_CONFIRMED') {
        const requiredProtectionKind = requiredAntiResurrectionKind(input.measure.intendedOutcome);
        const protection = input.antiResurrectionProtection;
        const hasCompleteProtection =
          requiredProtectionKind === undefined ||
          (protection !== undefined &&
            protection.kind === requiredProtectionKind &&
            hasSameOwnerScope(protection.scope, input.measure.scope) &&
            protection.sourceDecisionRef === input.measure.sourceDecisionRef &&
            protection.sourceDecisionRevision === input.measure.sourceDecisionRevision &&
            protection.sourceOutcomeRef === input.outcomeRef &&
            hasExactReferences(protection.protectedContentRefs, input.measure.targetContentRefs) &&
            hasExactReferences(protection.staleSourceResponsibilities, [
              'IMPORT',
              'REPLAY',
              'PROJECTION_REBUILD',
              'BACKUP_RECOVERY',
            ]));

        if (!hasCompleteProtection) {
          return {
            outcome: {
              ...baseOutcome,
              affectedContentRefs: [...input.measure.targetContentRefs],
              evidenceRefs: [...input.evidenceRefs, ...reconciliation.evidenceRefs],
              reason: 'EXECUTION_CONFIRMED_BUT_ANTI_RESURRECTION_PROTECTION_NOT_PROVEN',
              reconciliationRequired: false,
              remainingContentRefs,
              status: 'PARTIAL',
            },
          };
        }

        const achieved = {
          outcome: {
            ...baseOutcome,
            affectedContentRefs: [...input.measure.targetContentRefs],
            evidenceRefs: [...input.evidenceRefs, ...reconciliation.evidenceRefs],
            reason: 'ORIGINAL_OWNER_EXECUTION_CONFIRMED_BY_RECONCILIATION',
            reconciliationRequired: false,
            remainingContentRefs: [],
            status: 'ACHIEVED',
          },
        } satisfies InventoryPrivacyMeasureEvaluation;
        return protection === undefined ? achieved : { ...achieved, antiResurrectionProtection: protection };
      }
      if (!reconciliation.retryAllowed) {
        return {
          outcome: {
            ...baseOutcome,
            affectedContentRefs: [],
            reason: 'OWNER_RECONCILIATION_DID_NOT_AUTHORIZE_RETRY',
            reconciliationRequired: true,
            remainingContentRefs,
            status: 'INDETERMINATE',
          },
        };
      }
    } else {
      return { outcome: input.previousAttempt.outcome };
    }
  }

  if (
    input.coverage.scope.requestedScopeRef !== input.measure.scope.requestedScopeRef ||
    input.coverage.scope.tenantId !== input.measure.scope.tenantId ||
    input.coverage.scope.ownerCapability !== input.measure.scope.ownerCapability
  ) {
    return {
      outcome: {
        ...baseOutcome,
        affectedContentRefs: [],
        reason: 'OWNER_COVERAGE_SCOPE_DOES_NOT_MATCH_MEASURE_SCOPE',
        reconciliationRequired: false,
        remainingContentRefs,
        status: 'BUSINESS_REJECTED',
      },
    };
  }

  if (input.coverage.coverageStatus !== 'COMPLETE') {
    return {
      outcome: {
        ...baseOutcome,
        affectedContentRefs: [],
        reason: 'COMPLETE_INVENTORY_OWNER_SCOPE_COVERAGE_REQUIRED',
        reconciliationRequired: true,
        remainingContentRefs,
        status: 'INDETERMINATE',
      },
    };
  }

  if (input.coverage.contentStatus === 'NO_DATA') {
    return {
      outcome: {
        ...baseOutcome,
        affectedContentRefs: [],
        reason: 'COMPLETE_INVENTORY_OWNER_SCOPE_CONFIRMS_NO_DATA',
        reconciliationRequired: false,
        remainingContentRefs: [],
        status: 'NOT_APPLICABLE',
      },
    };
  }

  const protectedTargets = input.targets.filter(
    ({ preservationClass }) => preservationClass !== 'PRIVACY_RELEVANT_OWNER_COPY',
  );
  if (protectedTargets.length > 0) {
    return {
      outcome: {
        ...baseOutcome,
        affectedContentRefs: [],
        reason: 'REQUIRED_RESERVATION_COMMITTED_OR_HISTORICAL_EVIDENCE_MUST_BE_PRESERVED',
        reconciliationRequired: false,
        remainingContentRefs,
        status: 'BUSINESS_REJECTED',
      },
    };
  }

  return {
    outcome: {
      ...baseOutcome,
      affectedContentRefs: [],
      reason: 'NO_APPROVED_INVENTORY_PRIVACY_MUTATION_ACTION',
      reconciliationRequired: false,
      remainingContentRefs,
      status: 'BUSINESS_REJECTED',
    },
  };
};

export const inventoryPrivacyOwnerContract = {
  antiResurrectionProtectionRequiredFor: [
    'DELETE',
    'ANONYMIZE',
    'ENFORCE_DISPOSITION_RESTRICTION',
    'ENFORCE_PROCESSING_RESTRICTION',
  ],
  copiedCommerceCustomerProfileFieldsForReservation: [],
  ownerCapability: 'commerce.inventory',
  ownerMutationBoundary: 'NO_APPROVED_GENERIC_PRIVACY_MUTATION_ACTION',
  requiredScopeParts: inventoryPrivacyOwnerScopeParts,
  stockRecordsArePersonalByExistence: false,
} as const;
