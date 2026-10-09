import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyOwnerCoverageResultSchema, PrivacyOwnerExecutionOutcomeSchema } from '@app/shared-contracts';

import {
  assessInventoryPrivacyOwnerCoverage,
  evaluateInventoryPrivacyMeasure,
  inventoryPrivacyOwnerContract,
  inventoryPrivacyOwnerScopeParts,
} from '../../shared/inventory-privacy-owner-contract.ts';
import type { InventoryPrivacyScopeObservation } from '../../shared/inventory-privacy-owner-contract.ts';

const scope = {
  controllerRef: 'legal-entity:controller-a',
  dsrControllerObligationRef: 'privacy:dsr-obligation-858',
  ownerCapability: 'commerce.inventory',
  requestedScopePartRefs: inventoryPrivacyOwnerScopeParts.map(
    (scopePart) => `commerce.inventory/privacy-owner-scope/${scopePart}`,
  ),
  requestedScopeRef: 'privacy-owner-scope:inventory/858',
  subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'party:subject-858' },
  tenantId: 'tenant-a',
  trustedLookupRefs: ['reservation-correlation:opaque-858'],
} as const;

const completeObservations = (foundByPart: Partial<Record<string, readonly string[]>> = {}) =>
  inventoryPrivacyOwnerScopeParts.map((scopePart): InventoryPrivacyScopeObservation => ({
    coverageStatus: 'COMPLETE',
    evidenceRefs: [`inventory-coverage:${scopePart}`],
    foundContentRefs: foundByPart[scopePart] ?? [],
    observedAt: '2026-09-28T12:00:00.000Z',
    scopePart,
  }));

const assess = (observations: readonly InventoryPrivacyScopeObservation[]) =>
  assessInventoryPrivacyOwnerCoverage({
    assessedAt: '2026-09-28T12:01:00.000Z',
    evidenceRefs: ['inventory-coverage:assessment-858'],
    observations,
    scope,
  });

const measure = {
  expectedEvidenceRefs: ['privacy:expected-owner-outcome-858'],
  idempotencyKey: 'privacy-measure:858/revision-1',
  intendedOutcome: 'DELETE',
  measureRef: 'privacy-measure:858',
  preconditionRefs: ['privacy:blocker-check-858'],
  requestedAt: '2026-09-28T12:02:00.000Z',
  scope,
  sourceDecisionRef: 'privacy-disposition-decision:858',
  sourceDecisionRevision: 'revision-1',
  targetContentRefs: ['inventory-reservation-history:858'],
} as const;

const evaluate = (overrides: Partial<Parameters<typeof evaluateInventoryPrivacyMeasure>[0]> = {}) =>
  evaluateInventoryPrivacyMeasure({
    confirmedAt: '2026-09-28T12:03:00.000Z',
    coverage: assess(
      completeObservations({
        RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY: ['inventory-reservation-history:858'],
      }),
    ),
    evidenceRefs: ['inventory-privacy-measure-evaluation:858'],
    measure,
    outcomeRef: 'privacy-owner-outcome:inventory/858',
    targets: [
      {
        contentRef: 'inventory-reservation-history:858',
        preservationClass: 'REQUIRED_HISTORICAL_EVIDENCE',
      },
    ],
    ...overrides,
  });

describe('Inventory Privacy Owner Contract adoption', () => {
  it('does not treat absence of a Current Reservation as complete NO_DATA', () => {
    const currentOnly = assess([
      {
        coverageStatus: 'COMPLETE',
        evidenceRefs: ['inventory-coverage:current-reservation-empty'],
        foundContentRefs: [],
        observedAt: '2026-09-28T12:00:00.000Z',
        scopePart: 'CURRENT_RESERVATION_CORRELATIONS',
      },
    ]);

    expect(currentOnly.contentStatus).toBe('UNKNOWN');
    expect(currentOnly.coverageStatus).toBe('INDETERMINATE');
    expect(currentOnly.coverageParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          coverageStatus: 'INDETERMINATE',
          scopeRef: 'commerce.inventory/privacy-owner-scope/RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY',
        }),
        expect.objectContaining({
          coverageStatus: 'INDETERMINATE',
          scopeRef: 'commerce.inventory/privacy-owner-scope/IMPORT_REPLAY_PROJECTION_AND_BACKUP_RESPONSIBILITIES',
        }),
      ]),
    );
    expect(Schema.decodeUnknownSync(PrivacyOwnerCoverageResultSchema)(currentOnly)).toBeDefined();
  });

  it('returns complete NO_DATA only after every Inventory owner responsibility is completely covered', () => {
    const noData = assess(completeObservations());

    expect(noData.coverageStatus).toBe('COMPLETE');
    expect(noData.contentStatus).toBe('NO_DATA');
    expect(noData.coverageParts).toHaveLength(inventoryPrivacyOwnerScopeParts.length);
    expect(Schema.decodeUnknownSync(PrivacyOwnerCoverageResultSchema)(noData)).toBeDefined();
  });

  it('preserves historical evidence and external or recovery responsibilities in a FOUND result', () => {
    const found = assess(
      completeObservations({
        EXTERNAL_SOURCE_ASSERTION_COVERAGE_AND_CORRELATION_HISTORY: ['external-correlation:historical-858'],
        RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY: ['reservation-history:858'],
      }),
    );

    expect(found.coverageStatus).toBe('COMPLETE');
    expect(found.contentStatus).toBe('FOUND');
    expect(
      found.coverageParts.find(({ scopeRef }) => scopeRef.endsWith('/RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY'))
        ?.foundContentRefs,
    ).toEqual(['reservation-history:858']);
  });

  it('rejects generic disposition that would destroy required reservation, committed, or historical evidence', () => {
    const evaluation = evaluate();

    expect(evaluation.antiResurrectionProtection).toBeUndefined();
    expect(evaluation.outcome).toMatchObject({
      affectedContentRefs: [],
      reason: 'REQUIRED_RESERVATION_COMMITTED_OR_HISTORICAL_EVIDENCE_MUST_BE_PRESERVED',
      status: 'BUSINESS_REJECTED',
    });
    expect(Schema.decodeUnknownSync(PrivacyOwnerExecutionOutcomeSchema)(evaluation.outcome)).toBeDefined();
  });

  it('requires reconciliation before retrying an indeterminate owner measure', () => {
    const previousAttempt = {
      measure,
      outcome: {
        affectedContentRefs: [],
        confirmedAt: '2026-09-28T12:02:30.000Z',
        evidenceRefs: ['inventory-effect:privacy-858'],
        measureRef: measure.measureRef,
        outcomeRef: 'privacy-owner-outcome:inventory/858/attempt-1',
        reason: 'owner mutation may have committed before the response was lost',
        reconciliationRequired: true,
        remainingContentRefs: measure.targetContentRefs,
        scope,
        sourceDecisionRef: measure.sourceDecisionRef,
        sourceDecisionRevision: measure.sourceDecisionRevision,
        status: 'INDETERMINATE',
      },
    } as const;

    expect(evaluate({ previousAttempt }).outcome).toMatchObject({
      reason: 'OWNER_RECONCILIATION_REQUIRED_BEFORE_RETRY',
      reconciliationRequired: true,
      status: 'INDETERMINATE',
    });

    expect(
      evaluate({
        previousAttempt,
        reconciliation: {
          evidenceRefs: ['inventory-effect:privacy-858/not-executed'],
          measureRef: measure.measureRef,
          observedAt: '2026-09-28T12:04:00.000Z',
          preconditionsRecheckedAt: '2026-09-28T12:05:00.000Z',
          retryAllowed: true,
          sourceDecisionRevision: measure.sourceDecisionRevision,
          status: 'NOT_EXECUTED',
        },
      }).outcome,
    ).toMatchObject({
      reason: 'REQUIRED_RESERVATION_COMMITTED_OR_HISTORICAL_EVIDENCE_MUST_BE_PRESERVED',
      status: 'BUSINESS_REJECTED',
    });
  });

  it('rejects retry identity drift in subject, authorized scope, preconditions, or lookup references', () => {
    const previousAttempt = {
      measure,
      outcome: {
        affectedContentRefs: [],
        confirmedAt: '2026-09-28T12:02:30.000Z',
        evidenceRefs: ['inventory-effect:privacy-858'],
        measureRef: measure.measureRef,
        outcomeRef: 'privacy-owner-outcome:inventory/858/original',
        reason: 'original owner work is pending',
        reconciliationRequired: false,
        remainingContentRefs: measure.targetContentRefs,
        scope,
        sourceDecisionRef: measure.sourceDecisionRef,
        sourceDecisionRevision: measure.sourceDecisionRevision,
        status: 'PENDING',
      },
    } as const;
    const driftedMeasures = [
      {
        ...measure,
        scope: {
          ...measure.scope,
          subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'party:different-subject' } as const,
        },
      },
      {
        ...measure,
        scope: {
          ...measure.scope,
          requestedScopePartRefs: measure.scope.requestedScopePartRefs.slice(1),
        },
      },
      { ...measure, preconditionRefs: [...measure.preconditionRefs, 'privacy:new-precondition'] },
      {
        ...measure,
        scope: {
          ...measure.scope,
          trustedLookupRefs: [...measure.scope.trustedLookupRefs, 'reservation-correlation:different'],
        },
      },
    ];

    for (const driftedMeasure of driftedMeasures) {
      expect(evaluate({ measure: driftedMeasure, previousAttempt }).outcome).toMatchObject({
        reason: 'IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT',
        status: 'BUSINESS_REJECTED',
      });
    }
  });

  it('does not report reconciled destructive execution as achieved without exact anti-resurrection protection', () => {
    const previousAttempt = {
      measure,
      outcome: {
        affectedContentRefs: [],
        confirmedAt: '2026-09-28T12:02:30.000Z',
        evidenceRefs: ['inventory-effect:privacy-858'],
        measureRef: measure.measureRef,
        outcomeRef: 'privacy-owner-outcome:inventory/858/attempt-1',
        reason: 'owner mutation may have committed before the response was lost',
        reconciliationRequired: true,
        remainingContentRefs: measure.targetContentRefs,
        scope,
        sourceDecisionRef: measure.sourceDecisionRef,
        sourceDecisionRevision: measure.sourceDecisionRevision,
        status: 'INDETERMINATE',
      },
    } as const;
    const reconciliation = {
      evidenceRefs: ['inventory-effect:privacy-858/executed'],
      measureRef: measure.measureRef,
      observedAt: '2026-09-28T12:04:00.000Z',
      retryAllowed: false,
      sourceDecisionRevision: measure.sourceDecisionRevision,
      status: 'EXECUTION_CONFIRMED',
    } as const;

    expect(evaluate({ previousAttempt, reconciliation }).outcome).toMatchObject({
      reason: 'EXECUTION_CONFIRMED_BUT_ANTI_RESURRECTION_PROTECTION_NOT_PROVEN',
      status: 'PARTIAL',
    });

    const antiResurrectionProtection = {
      enforcedAt: '2026-09-28T12:04:00.000Z',
      evidenceRefs: ['inventory-anti-resurrection:858'],
      kind: 'DELETED_SCOPE',
      protectedContentRefs: measure.targetContentRefs,
      protectionRef: 'inventory-anti-resurrection:858',
      retainsRemovedPayload: false,
      scope,
      sourceDecisionRef: measure.sourceDecisionRef,
      sourceDecisionRevision: measure.sourceDecisionRevision,
      sourceOutcomeRef: 'privacy-owner-outcome:inventory/858',
      staleSourceResponsibilities: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
    } as const;
    const protectedEvaluation = evaluate({
      antiResurrectionProtection,
      previousAttempt,
      reconciliation,
    });
    expect(protectedEvaluation.outcome).toMatchObject({
      reason: 'ORIGINAL_OWNER_EXECUTION_CONFIRMED_BY_RECONCILIATION',
      status: 'ACHIEVED',
    });
    expect(protectedEvaluation.antiResurrectionProtection).toMatchObject({
      kind: 'DELETED_SCOPE',
      retainsRemovedPayload: false,
    });

    const mismatchedProtections = [
      { ...antiResurrectionProtection, sourceOutcomeRef: 'privacy-owner-outcome:different' },
      { ...antiResurrectionProtection, sourceDecisionRevision: 'revision-different' },
      {
        ...antiResurrectionProtection,
        scope: { ...antiResurrectionProtection.scope, tenantId: 'tenant-different' },
      },
      {
        ...antiResurrectionProtection,
        scope: { ...antiResurrectionProtection.scope, controllerRef: 'legal-entity:different-controller' },
      },
      {
        ...antiResurrectionProtection,
        scope: {
          ...antiResurrectionProtection.scope,
          subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'party:different-subject' } as const,
        },
      },
      {
        ...antiResurrectionProtection,
        scope: {
          ...antiResurrectionProtection.scope,
          requestedScopePartRefs: antiResurrectionProtection.scope.requestedScopePartRefs.slice(1),
        },
      },
      { ...antiResurrectionProtection, protectedContentRefs: ['inventory-reservation-history:different'] },
      ...antiResurrectionProtection.staleSourceResponsibilities.map((omittedResponsibility) => ({
        ...antiResurrectionProtection,
        staleSourceResponsibilities: antiResurrectionProtection.staleSourceResponsibilities.filter(
          (responsibility) => responsibility !== omittedResponsibility,
        ),
      })),
    ];
    for (const mismatchedProtection of mismatchedProtections) {
      expect(
        evaluate({
          antiResurrectionProtection: mismatchedProtection,
          previousAttempt,
          reconciliation,
        }).outcome,
      ).toMatchObject({
        reason: 'EXECUTION_CONFIRMED_BUT_ANTI_RESURRECTION_PROTECTION_NOT_PROVEN',
        status: 'PARTIAL',
      });
    }
  });

  it('does not invent a privacy mutation Action or copy Commerce Customer Profile fields for reservations', () => {
    expect(inventoryPrivacyOwnerContract).toMatchObject({
      copiedCommerceCustomerProfileFieldsForReservation: [],
      ownerMutationBoundary: 'NO_APPROVED_GENERIC_PRIVACY_MUTATION_ACTION',
      stockRecordsArePersonalByExistence: false,
    });

    const evaluation = evaluate({
      targets: [
        {
          contentRef: 'inventory-owner-copy:858',
          preservationClass: 'PRIVACY_RELEVANT_OWNER_COPY',
        },
      ],
    });
    expect(evaluation.outcome).toMatchObject({
      reason: 'NO_APPROVED_INVENTORY_PRIVACY_MUTATION_ACTION',
      status: 'BUSINESS_REJECTED',
    });
    expect(evaluation.antiResurrectionProtection).toBeUndefined();
  });
});
