import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryPrivacyAchievedSchema,
  InventoryPrivacyBusinessRejectionSchema,
  InventoryPrivacyCompleteFoundSchema,
  InventoryPrivacyCompleteNoDataSchema,
  InventoryPrivacyContributionContentItemSchema,
  InventoryPrivacyExecutionBlockedSchema,
  InventoryPrivacyExecutionIndeterminateSchema,
  InventoryPrivacyExecutionPartialSchema,
  InventoryPrivacyExecutionTechnicalFailedSchema,
  InventoryPrivacyMatchingCopyTargetSchema,
  InventoryPrivacyMeasureSchema,
  InventoryPrivacyMeasureIndeterminateSchema,
  InventoryPrivacyOwnerActionRequiredSchema,
  InventoryPrivacyOwnerScopeSchema,
  InventoryPrivacyPartialCoverageSchema,
  InventoryPrivacyReconciliationRequiredSchema,
  InventoryPrivacyTemporaryExportSchema,
  InventoryReservationPrivacyDataProfileSchema,
  compileInventoryPrivacyOwnerContribution,
  evaluateInventoryPrivacyMeasure,
  evaluateInventoryPrivacyOwnerCoverage,
  finalizeInventoryPrivacyMeasure,
} from '../../shared/domain/inventory-privacy-owner-contract.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const subjectRef = {
  moduleId: 'party.registry',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const reservationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.inventory.inventory-reservation',
  tenantId,
} as const;
const observedAt = '2026-09-25T10:05:00.000Z';
const contentScope = {
  contentScopeRef: 'inventory-content:reservation-1',
  financialEvidenceRef: null,
  historicalEvidenceAssembledAt: '2026-09-25T09:55:00.000Z',
  historicalEvidenceRef: 'inventory-history:reservation-1',
  historicalReservationRef: reservationRef,
  orderCommitEvidenceRef: 'order-commit:reservation-1',
  resourceRefs: [reservationRef],
} as const;

const scope = Schema.decodeUnknownSync(InventoryPrivacyOwnerScopeSchema)({
  authorizationEvidenceRef: 'privacy-owner-authorization:case-1',
  confirmedSubjectEvidenceRef: 'privacy-subject-confirmation:case-1',
  contentScope,
  ownerModuleId: 'commerce.inventory',
  privacySubjectRef: subjectRef,
  requestedCoverage: [
    'CURRENT_RESERVATION_CORRELATIONS',
    'HISTORICAL_INVENTORY_EVIDENCE',
    'ACTOR_PRINCIPAL_ATTRIBUTION',
  ],
  requestScopeId: 'privacy-owner-scope:case-1',
  tenantId,
});

const binding = {
  contentScope: scope.contentScope,
  privacySubjectRef: scope.privacySubjectRef,
  requestScopeId: scope.requestScopeId,
  tenantId: scope.tenantId,
};

const noData = (area: (typeof scope.requestedCoverage)[number]) => ({
  _tag: 'NO_DATA' as const,
  area,
  binding,
  capturedAt: observedAt,
  exhaustiveSearchEvidenceRef: `coverage:${area}`,
  observedAt,
});

const completeChecks = scope.requestedCoverage.map(noData);

const measure = Schema.decodeUnknownSync(InventoryPrivacyMeasureSchema)({
  antiResurrectionProtectionRequired: true,
  approvedAt: '2026-09-25T10:00:00.000Z',
  approvedDecisionRef: 'privacy-decision:case-1',
  approvedDecisionRevision: 1,
  contentScope: scope.contentScope,
  measureId: 'privacy-measure:case-1',
  ownerModuleId: 'commerce.inventory',
  privacySubjectRef: scope.privacySubjectRef,
  requestedDisposition: 'DELETE',
  requestScopeId: scope.requestScopeId,
  targetAreas: ['HISTORICAL_INVENTORY_EVIDENCE'],
  tenantId: scope.tenantId,
});

const allowedTarget = () =>
  Schema.decodeUnknownSync(InventoryPrivacyMatchingCopyTargetSchema)({
    _tag: 'MATCHING_COPY',
    area: 'HISTORICAL_INVENTORY_EVIDENCE',
    binding,
    copyRefs: ['inventory-copy:opaque-correlation-1'],
    dispositionEvidence: {
      businessInvariant: { _tag: 'DISPOSITION_ALLOWED', evidenceRef: 'invariant:clear-1' },
      legalHold: { _tag: 'CLEAR', evidenceRef: 'legal-hold:clear-1', observedAt },
      observedAt,
      ownerOrderFence: 'inventory-owner-order:42',
      ownerVersion: 42,
      retention: {
        _tag: 'DISPOSITION_ALLOWED',
        effectiveAt: '2026-09-25T09:00:00.000Z',
        evidenceRef: 'retention:allowed-1',
      },
    },
    ownerActionRef: 'inventory-action:remove-correlation',
    supportedDisposition: 'DELETE',
  });

describe('Inventory Privacy Owner Contract adoption', () => {
  it('does not turn an absent Current Reservation into complete NO_DATA while history is unchecked', () => {
    const result = evaluateInventoryPrivacyOwnerCoverage({
      checks: [
        noData('CURRENT_RESERVATION_CORRELATIONS'),
        {
          _tag: 'UNCHECKED',
          area: 'HISTORICAL_INVENTORY_EVIDENCE',
          binding,
          reason: 'HISTORICAL_EVIDENCE_NOT_CHECKED',
        },
        noData('ACTOR_PRINCIPAL_ATTRIBUTION'),
      ],
      scope,
    });

    expect(Schema.is(InventoryPrivacyPartialCoverageSchema)(result)).toBe(true);
    if (Schema.is(InventoryPrivacyPartialCoverageSchema)(result)) {
      expect(result.unresolvedAreas).toEqual(['HISTORICAL_INVENTORY_EVIDENCE']);
      expect(result.completeNoData).toBe(false);
    }
  });

  it('returns complete NO_DATA only when every check binds exact authorized subject, scope, and #857 evidence', () => {
    const complete = evaluateInventoryPrivacyOwnerCoverage({ checks: completeChecks, scope });
    expect(Schema.is(InventoryPrivacyCompleteNoDataSchema)(complete)).toBe(true);

    const mismatched = evaluateInventoryPrivacyOwnerCoverage({
      checks: completeChecks.map((check, index) =>
        index === 1
          ? {
              ...check,
              binding: {
                ...binding,
                contentScope: { ...binding.contentScope, historicalEvidenceRef: 'inventory-history:other' },
              },
            }
          : check,
      ),
      scope,
    });
    expect(Schema.is(InventoryPrivacyPartialCoverageSchema)(mismatched)).toBe(true);
  });

  it('keeps found data distinct from coverage completeness and preserves owner observation times', () => {
    const result = evaluateInventoryPrivacyOwnerCoverage({
      checks: [
        noData('CURRENT_RESERVATION_CORRELATIONS'),
        {
          _tag: 'FOUND',
          area: 'HISTORICAL_INVENTORY_EVIDENCE',
          binding,
          capturedAt: '2026-09-25T10:06:00.000Z',
          evidenceRefs: ['inventory-history:reservation-1'],
          observedAt,
        },
        noData('ACTOR_PRINCIPAL_ATTRIBUTION'),
      ],
      scope,
    });

    expect(Schema.is(InventoryPrivacyCompleteFoundSchema)(result)).toBe(true);
    if (Schema.is(InventoryPrivacyCompleteFoundSchema)(result)) {
      expect(result.complete).toBe(true);
      expect(result.contributions[0]?.observedAt).toBe(observedAt);
    }
  });

  it('forbids copied customer-profile fields while retaining only opaque business correlations', () => {
    const minimalProfile = {
      directCustomerProfileCopy: 'ABSENT' as const,
      opaqueCorrelationsMayBePrivacyRelevant: true as const,
      profileFieldsStoredSolelyForReservation: [] as const,
      reservationRef,
      retainedEvidenceKinds: ['ATTEMPT_CORRELATION', 'ORDER_CORRELATION'] as const,
    };

    expect(Schema.is(InventoryReservationPrivacyDataProfileSchema)(minimalProfile)).toBe(true);
    expect(
      Schema.is(InventoryReservationPrivacyDataProfileSchema)({
        ...minimalProfile,
        directCustomerProfileCopy: 'PRESENT',
        profileFieldsStoredSolelyForReservation: ['EMAIL'],
      }),
    ).toBe(false);
  });

  it('rejects deletion when immutable committed Order evidence requires preservation', () => {
    const target = allowedTarget();
    const result = evaluateInventoryPrivacyMeasure({
      measure,
      scope,
      targets: [
        {
          ...target,
          dispositionEvidence: {
            ...target.dispositionEvidence,
            businessInvariant: {
              _tag: 'REQUIRED_COMMITTED_STOCK_OR_ORDER_EVIDENCE',
              evidenceRef: scope.contentScope.orderCommitEvidenceRef ?? 'missing',
            },
          },
        },
      ],
    });

    expect(Schema.is(InventoryPrivacyBusinessRejectionSchema)(result)).toBe(true);
    if (Schema.is(InventoryPrivacyBusinessRejectionSchema)(result)) {
      expect(result.reason).toBe('REQUIRED_COMMITTED_STOCK_OR_ORDER_EVIDENCE');
      expect(result.mutationPerformed).toBe(false);
    }
  });

  it('uses exact current retention and Legal Hold evidence instead of caller safety flags', () => {
    const target = allowedTarget();
    const retained = evaluateInventoryPrivacyMeasure({
      measure,
      scope,
      targets: [
        {
          ...target,
          dispositionEvidence: {
            ...target.dispositionEvidence,
            retention: {
              _tag: 'RETAIN_REQUIRED',
              evidenceRef: 'retention:required-1',
              retainUntil: '2027-09-25T00:00:00.000Z',
            },
          },
        },
      ],
    });
    expect(Schema.is(InventoryPrivacyBusinessRejectionSchema)(retained)).toBe(true);
    if (Schema.is(InventoryPrivacyBusinessRejectionSchema)(retained)) {
      expect(retained.reason).toBe('RETENTION_REQUIRES_PRESERVATION');
    }

    const stale = evaluateInventoryPrivacyMeasure({
      measure,
      scope,
      targets: [
        {
          ...target,
          dispositionEvidence: {
            ...target.dispositionEvidence,
            legalHold: {
              _tag: 'CLEAR',
              evidenceRef: 'legal-hold:stale-clear',
              observedAt: '2026-09-25T09:00:00.000Z',
            },
          },
        },
      ],
    });
    expect(Schema.is(InventoryPrivacyMeasureIndeterminateSchema)(stale)).toBe(true);
  });

  it('requires reconciliation before retrying an indeterminate Privacy Measure', () => {
    const result = evaluateInventoryPrivacyMeasure({
      measure,
      priorExecution: {
        outcome: 'INDETERMINATE',
        ownerExecutionEvidenceRef: 'privacy-execution:attempt-1',
      },
      scope,
      targets: [allowedTarget()],
    });

    expect(Schema.is(InventoryPrivacyReconciliationRequiredSchema)(result)).toBe(true);
    if (Schema.is(InventoryPrivacyReconciliationRequiredSchema)(result)) {
      expect(result.competingFreshExecutionAllowed).toBe(false);
    }
  });

  it('rejects area-only target reuse from another request/evidence scope', () => {
    const target = allowedTarget();
    const otherScope = Schema.decodeUnknownSync(InventoryPrivacyOwnerScopeSchema)({
      ...scope,
      requestScopeId: 'privacy-owner-scope:other',
    });
    const result = evaluateInventoryPrivacyMeasure({
      measure,
      scope,
      targets: [{ ...target, binding: { ...target.binding, requestScopeId: otherScope.requestScopeId } }],
    });

    expect(Schema.is(InventoryPrivacyBusinessRejectionSchema)(result)).toBe(true);
    if (Schema.is(InventoryPrivacyBusinessRejectionSchema)(result)) {
      expect(result.reason).toBe('TARGET_SCOPE_MISMATCH');
    }
  });

  it('binds anti-resurrection protection to exact removed copies and post-achievement chronology', () => {
    const ready = evaluateInventoryPrivacyMeasure({ measure, scope, targets: [allowedTarget()] });
    expect(Schema.is(InventoryPrivacyOwnerActionRequiredSchema)(ready)).toBe(true);
    if (!Schema.is(InventoryPrivacyOwnerActionRequiredSchema)(ready)) {
      return;
    }
    const execution = {
      achievedAt: '2026-09-25T10:15:00.000Z',
      achievedCopyRefs: ['inventory-copy:opaque-correlation-1'] as const,
      actionEvidence: ready.actions,
      measureId: measure.measureId,
      outcome: 'ACHIEVED' as const,
      ownerExecutionEvidenceRef: 'privacy-execution:achieved-1',
    };
    const protection = {
      backupRestoreReconciliationRequired: true as const,
      contentScope: ready.contentScope,
      deletedPayloadRetained: false as const,
      disposition: ready.disposition,
      effectiveAt: '2026-09-25T10:16:00.000Z',
      measureId: ready.measureId,
      privacySubjectRef: ready.privacySubjectRef,
      protectionEvidenceRef: 'anti-resurrection:measure-1',
      removedCopyRefs: ['inventory-copy:opaque-correlation-1'] as const,
      requestScopeId: ready.requestScopeId,
      staleImportBlocked: true as const,
      staleReplayBlocked: true as const,
      targetAreas: ready.targetAreas,
      tenantId: ready.tenantId,
    };

    const staleProtection = finalizeInventoryPrivacyMeasure({
      execution,
      plan: ready,
      protection: { ...protection, effectiveAt: '2026-09-25T10:14:00.000Z' },
    });
    expect(Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(staleProtection)).toBe(true);

    const wrongCopyProtection = finalizeInventoryPrivacyMeasure({
      execution,
      plan: ready,
      protection: { ...protection, removedCopyRefs: ['inventory-copy:other'] },
    });
    expect(Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(wrongCopyProtection)).toBe(true);

    const achieved = finalizeInventoryPrivacyMeasure({ execution, plan: ready, protection });
    expect(Schema.is(InventoryPrivacyAchievedSchema)(achieved)).toBe(true);
  });

  it('builds distinct Access and Portability contributions without raw provider/customer-profile payloads', () => {
    const coverage = evaluateInventoryPrivacyOwnerCoverage({
      checks: [
        noData('CURRENT_RESERVATION_CORRELATIONS'),
        {
          _tag: 'FOUND',
          area: 'HISTORICAL_INVENTORY_EVIDENCE',
          binding,
          capturedAt: observedAt,
          evidenceRefs: [scope.contentScope.historicalEvidenceRef],
          observedAt,
        },
        noData('ACTOR_PRINCIPAL_ATTRIBUTION'),
      ],
      scope,
    });
    const [candidateResource] = scope.contentScope.resourceRefs;
    if (candidateResource === undefined) {
      return;
    }
    const validCandidate = Schema.decodeUnknownSync(InventoryPrivacyContributionContentItemSchema)({
      accessEligible: true,
      contentKind: 'OPAQUE_RESERVATION_CORRELATION',
      contentRef: 'content:opaque-correlation-1',
      portabilityEligible: false,
      resourceRef: candidateResource,
      sourceEvidenceRef: scope.contentScope.historicalEvidenceRef,
      thirdPartyProtected: false,
      valueForm: 'OPAQUE_REFERENCE',
    });
    const candidates = [
      validCandidate,
      Schema.decodeUnknownSync(InventoryPrivacyContributionContentItemSchema)({
        accessEligible: true,
        contentKind: 'ACTOR_PRINCIPAL_ATTRIBUTION',
        contentRef: 'content:third-party-attribution-1',
        portabilityEligible: true,
        resourceRef: candidateResource,
        sourceEvidenceRef: scope.contentScope.historicalEvidenceRef,
        thirdPartyProtected: true,
        valueForm: 'OWNER_EVIDENCE_SUMMARY',
      }),
      Schema.decodeUnknownSync(InventoryPrivacyContributionContentItemSchema)({
        accessEligible: true,
        contentKind: 'OPAQUE_RESERVATION_CORRELATION',
        contentRef: 'content:cross-tenant-1',
        portabilityEligible: true,
        resourceRef: { ...candidateResource, tenantId: '44444444-4444-4444-8444-444444444444' },
        sourceEvidenceRef: scope.contentScope.historicalEvidenceRef,
        thirdPartyProtected: false,
        valueForm: 'OPAQUE_REFERENCE',
      }),
      Schema.decodeUnknownSync(InventoryPrivacyContributionContentItemSchema)({
        accessEligible: true,
        contentKind: 'OPAQUE_RESERVATION_CORRELATION',
        contentRef: 'content:unrelated-resource-1',
        portabilityEligible: true,
        resourceRef: { ...candidateResource, resourceId: '55555555-5555-4555-8555-555555555555' },
        sourceEvidenceRef: scope.contentScope.historicalEvidenceRef,
        thirdPartyProtected: false,
        valueForm: 'OPAQUE_REFERENCE',
      }),
      Schema.decodeUnknownSync(InventoryPrivacyContributionContentItemSchema)({
        ...validCandidate,
        contentRef: 'content:wrong-source-1',
        sourceEvidenceRef: 'inventory-history:other',
      }),
    ];
    const access = compileInventoryPrivacyOwnerContribution({
      candidateContent: candidates,
      capturedAt: observedAt,
      contributionRef: 'contribution:access-1',
      coverage,
      observedAt,
      requestKind: 'ACCESS',
      scope,
    });
    const portability = compileInventoryPrivacyOwnerContribution({
      candidateContent: candidates,
      capturedAt: observedAt,
      contributionRef: 'contribution:portability-1',
      coverage,
      observedAt,
      requestKind: 'PORTABILITY',
      scope,
    });

    expect(access.content).toHaveLength(1);
    expect(access.exclusions[0]?.reason).toBe('THIRD_PARTY_PROTECTION');
    expect(portability.content).toHaveLength(0);
    expect(portability.exclusions.map(({ reason }) => reason)).toEqual([
      'NOT_PORTABILITY_ELIGIBLE',
      'THIRD_PARTY_PROTECTION',
      'OUTSIDE_AUTHORIZED_SCOPE',
      'OUTSIDE_AUTHORIZED_SCOPE',
      'SOURCE_EVIDENCE_MISMATCH',
    ]);
    expect(
      Schema.is(InventoryPrivacyTemporaryExportSchema)({
        _tag: 'TEMPORARY_DSR_EXPORT',
        contribution: access,
        copiedCustomerProfileSynthesized: false,
        createdAt: observedAt,
        deliveryAccessRef: 'dsr-delivery-access:1',
        expiresAt: '2026-09-26T10:05:00.000Z',
        exportRef: 'inventory-dsr-export:1',
        rawProviderPayloadIncluded: false,
        revokedPriorDeliveryAccessRef: null,
      }),
    ).toBe(true);

    const noDataContribution = compileInventoryPrivacyOwnerContribution({
      candidateContent: [validCandidate],
      capturedAt: observedAt,
      contributionRef: 'contribution:no-data-conflict-1',
      coverage: evaluateInventoryPrivacyOwnerCoverage({ checks: completeChecks, scope }),
      observedAt,
      requestKind: 'ACCESS',
      scope,
    });
    expect(noDataContribution.content).toHaveLength(0);
    expect(noDataContribution.exclusions[0]?.reason).toBe('NO_DATA_COVERAGE_CONFLICT');
    expect(noDataContribution.completion).toBe('PARTIAL');
  });

  it('never exports a historical candidate when only another area is FOUND or historical evidence is unrelated', () => {
    const [candidateResource] = scope.contentScope.resourceRefs;
    if (candidateResource === undefined) {
      return;
    }
    const candidate = Schema.decodeUnknownSync(InventoryPrivacyContributionContentItemSchema)({
      accessEligible: true,
      contentKind: 'INVENTORY_BUSINESS_EVIDENCE',
      contentRef: 'content:historical-reservation-1',
      portabilityEligible: true,
      resourceRef: candidateResource,
      sourceEvidenceRef: scope.contentScope.historicalEvidenceRef,
      thirdPartyProtected: false,
      valueForm: 'OWNER_EVIDENCE_SUMMARY',
    });
    const currentFoundHistoricalNoData = evaluateInventoryPrivacyOwnerCoverage({
      checks: [
        {
          _tag: 'FOUND',
          area: 'CURRENT_RESERVATION_CORRELATIONS',
          binding,
          capturedAt: observedAt,
          evidenceRefs: ['inventory-current:reservation-1'],
          observedAt,
        },
        noData('HISTORICAL_INVENTORY_EVIDENCE'),
        noData('ACTOR_PRINCIPAL_ATTRIBUTION'),
      ],
      scope,
    });
    const unrelatedHistoricalFound = evaluateInventoryPrivacyOwnerCoverage({
      checks: [
        noData('CURRENT_RESERVATION_CORRELATIONS'),
        {
          _tag: 'FOUND',
          area: 'HISTORICAL_INVENTORY_EVIDENCE',
          binding,
          capturedAt: observedAt,
          evidenceRefs: ['inventory-history:unrelated'],
          observedAt,
        },
        noData('ACTOR_PRINCIPAL_ATTRIBUTION'),
      ],
      scope,
    });

    for (const [index, coverage] of [currentFoundHistoricalNoData, unrelatedHistoricalFound].entries()) {
      const contribution = compileInventoryPrivacyOwnerContribution({
        candidateContent: [candidate],
        capturedAt: observedAt,
        contributionRef: `contribution:historical-contradiction-${index}`,
        coverage,
        observedAt,
        requestKind: 'ACCESS',
        scope,
      });
      expect(contribution.content).toHaveLength(0);
      expect(contribution.exclusions[0]?.reason).toBe('SOURCE_NOT_FOUND_IN_COVERAGE');
      expect(contribution.completion).toBe('PARTIAL');
    }
  });

  it('keeps partial, blocked, technical-failed, and indeterminate owner outcomes distinct', () => {
    const ready = evaluateInventoryPrivacyMeasure({ measure, scope, targets: [allowedTarget()] });
    if (!Schema.is(InventoryPrivacyOwnerActionRequiredSchema)(ready)) {
      return;
    }
    const partial = finalizeInventoryPrivacyMeasure({
      execution: {
        achievedAt: '2026-09-25T10:15:00.000Z',
        achievedCopyRefs: [],
        actionEvidence: ready.actions,
        measureId: measure.measureId,
        outcome: 'PARTIAL',
        ownerExecutionEvidenceRef: 'execution:partial-1',
        unresolvedCopyRefs: ['inventory-copy:opaque-correlation-1'],
      },
      plan: ready,
      protection: null,
    });
    const blocked = finalizeInventoryPrivacyMeasure({
      execution: {
        actionEvidence: ready.actions,
        blockerEvidenceRef: 'execution:blocker-1',
        measureId: measure.measureId,
        outcome: 'BLOCKED',
      },
      plan: ready,
      protection: null,
    });
    const failed = finalizeInventoryPrivacyMeasure({
      execution: {
        actionEvidence: ready.actions,
        failureEvidenceRef: 'execution:failure-1',
        measureId: measure.measureId,
        outcome: 'TECHNICAL_FAILED',
        retryMayDuplicateEffect: false,
      },
      plan: ready,
      protection: null,
    });

    expect(Schema.is(InventoryPrivacyExecutionPartialSchema)(partial)).toBe(true);
    expect(Schema.is(InventoryPrivacyExecutionBlockedSchema)(blocked)).toBe(true);
    expect(Schema.is(InventoryPrivacyExecutionTechnicalFailedSchema)(failed)).toBe(true);
  });

  it('fails closed when owner version, order fence, retention, or hold evidence changes at Action time', () => {
    const ready = evaluateInventoryPrivacyMeasure({ measure, scope, targets: [allowedTarget()] });
    if (!Schema.is(InventoryPrivacyOwnerActionRequiredSchema)(ready)) {
      return;
    }
    const [plannedAction] = ready.actions;
    if (plannedAction === undefined) {
      return;
    }
    const changed = finalizeInventoryPrivacyMeasure({
      execution: {
        actionEvidence: [
          {
            ...plannedAction,
            dispositionEvidence: {
              ...plannedAction.dispositionEvidence,
              ownerOrderFence: 'inventory-owner-order:43',
              ownerVersion: 43,
            },
          },
        ],
        blockerEvidenceRef: 'action-time-owner-evidence:43',
        measureId: measure.measureId,
        outcome: 'BLOCKED',
      },
      plan: ready,
      protection: null,
    });

    expect(Schema.is(InventoryPrivacyExecutionBlockedSchema)(changed)).toBe(true);
    if (Schema.is(InventoryPrivacyExecutionBlockedSchema)(changed)) {
      expect(changed.reason).toBe('OWNER_EVIDENCE_CHANGED');
    }
  });

  it('requires an exact unique copy partition and protection for every achieved copy, including PARTIAL', () => {
    const target = allowedTarget();
    const copyRefs = ['inventory-copy:a', 'inventory-copy:b', 'inventory-copy:c'] as const;
    const ready = evaluateInventoryPrivacyMeasure({
      measure,
      scope,
      targets: [{ ...target, copyRefs }],
    });
    if (!Schema.is(InventoryPrivacyOwnerActionRequiredSchema)(ready)) {
      return;
    }
    const partialExecution = {
      achievedAt: '2026-09-25T10:15:00.000Z',
      actionEvidence: ready.actions,
      measureId: measure.measureId,
      outcome: 'PARTIAL' as const,
      ownerExecutionEvidenceRef: 'execution:partial-partition-1',
    };
    const invalidPartitions = [
      { achievedCopyRefs: ['inventory-copy:a'], unresolvedCopyRefs: copyRefs },
      { achievedCopyRefs: ['inventory-copy:a'], unresolvedCopyRefs: ['inventory-copy:b'] },
      {
        achievedCopyRefs: ['inventory-copy:a'],
        unresolvedCopyRefs: ['inventory-copy:b', 'inventory-copy:unrelated'],
      },
      {
        achievedCopyRefs: ['inventory-copy:a', 'inventory-copy:a'],
        unresolvedCopyRefs: ['inventory-copy:b', 'inventory-copy:c'],
      },
    ] as const;
    for (const partition of invalidPartitions) {
      const outcome = finalizeInventoryPrivacyMeasure({
        execution: { ...partialExecution, ...partition },
        plan: ready,
        protection: null,
      });
      expect(Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(outcome)).toBe(true);
      if (Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(outcome)) {
        expect(outcome.reason).toBe('EXECUTION_COPY_PARTITION_INVALID');
      }
    }

    const exactPartialExecution = {
      ...partialExecution,
      achievedCopyRefs: ['inventory-copy:a'] as const,
      unresolvedCopyRefs: ['inventory-copy:b', 'inventory-copy:c'] as const,
    };
    const missingProtection = finalizeInventoryPrivacyMeasure({
      execution: exactPartialExecution,
      plan: ready,
      protection: null,
    });
    expect(Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(missingProtection)).toBe(true);
    if (Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(missingProtection)) {
      expect(missingProtection.reason).toBe('ANTI_RESURRECTION_PROTECTION_MISSING');
    }

    const protection = {
      backupRestoreReconciliationRequired: true as const,
      contentScope: ready.contentScope,
      deletedPayloadRetained: false as const,
      disposition: ready.disposition,
      effectiveAt: '2026-09-25T10:16:00.000Z',
      measureId: ready.measureId,
      privacySubjectRef: ready.privacySubjectRef,
      protectionEvidenceRef: 'anti-resurrection:partial-a',
      removedCopyRefs: ['inventory-copy:a'] as const,
      requestScopeId: ready.requestScopeId,
      staleImportBlocked: true as const,
      staleReplayBlocked: true as const,
      targetAreas: ready.targetAreas,
      tenantId: ready.tenantId,
    };
    const protectedPartial = finalizeInventoryPrivacyMeasure({
      execution: exactPartialExecution,
      plan: ready,
      protection,
    });
    expect(Schema.is(InventoryPrivacyExecutionPartialSchema)(protectedPartial)).toBe(true);

    const incompleteAchieved = finalizeInventoryPrivacyMeasure({
      execution: {
        achievedAt: '2026-09-25T10:15:00.000Z',
        achievedCopyRefs: ['inventory-copy:a', 'inventory-copy:b'],
        actionEvidence: ready.actions,
        measureId: measure.measureId,
        outcome: 'ACHIEVED',
        ownerExecutionEvidenceRef: 'execution:incomplete-achieved-1',
      },
      plan: ready,
      protection: { ...protection, removedCopyRefs: ['inventory-copy:a', 'inventory-copy:b'] },
    });
    expect(Schema.is(InventoryPrivacyExecutionIndeterminateSchema)(incompleteAchieved)).toBe(true);
  });
});
