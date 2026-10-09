import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AntiResurrectionProtectionSchema,
  PrivacyMeasureSchema,
  PrivacyOwnerCoverageResultSchema,
  PrivacyOwnerExecutionOutcomeSchema,
  PrivacyOwnerReconciliationResultSchema,
} from '../../src/index.ts';
import type {
  PrivacyMeasureEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerExecutionOutcomeEncoded,
} from '../../src/index.ts';

const decodeCoverage = Schema.decodeUnknownSync(PrivacyOwnerCoverageResultSchema, {
  onExcessProperty: 'error',
});
const decodeMeasure = Schema.decodeUnknownSync(PrivacyMeasureSchema, { onExcessProperty: 'error' });
const decodeOutcome = Schema.decodeUnknownSync(PrivacyOwnerExecutionOutcomeSchema, {
  onExcessProperty: 'error',
});

const scope = {
  controllerRef: 'legal-entity:controller-a',
  dsrControllerObligationRef: 'privacy:dsr-obligation-7',
  ownerCapability: 'commerce.inventory',
  requestedScopePartRefs: [
    'inventory-privacy-scope:reservation-history',
    'inventory-privacy-scope:recovery-responsibilities',
  ],
  requestedScopeRef: 'privacy-owner-scope:inventory/7',
  subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'party:subject-7' },
  tenantId: 'tenant-a',
  trustedLookupRefs: ['reservation:opaque-correlation-7'],
} as const;

const completeNoData = {
  assessedAt: '2026-09-28T12:00:00.000Z',
  contentStatus: 'NO_DATA',
  coverageParts: [
    {
      coverageStatus: 'COMPLETE',
      evidenceRefs: ['inventory-evidence:reservation-history-empty-7'],
      foundContentRefs: [],
      observedAt: '2026-09-28T11:59:00.000Z',
      scopeRef: 'inventory-privacy-scope:reservation-history',
    },
    {
      coverageStatus: 'COMPLETE',
      evidenceRefs: ['inventory-evidence:recovery-responsibility-checked-7'],
      foundContentRefs: [],
      observedAt: '2026-09-28T11:58:00.000Z',
      scopeRef: 'inventory-privacy-scope:recovery-responsibilities',
    },
  ],
  coverageStatus: 'COMPLETE',
  evidenceRefs: ['inventory-evidence:coverage-7'],
  scope,
} as const satisfies PrivacyOwnerCoverageResultEncoded;

const measure = {
  expectedEvidenceRefs: ['privacy:expected-outcome-7'],
  idempotencyKey: 'privacy-measure:7/revision-3',
  intendedOutcome: 'DELETE',
  measureRef: 'privacy-measure:7',
  preconditionRefs: ['privacy:current-blocker-check-7'],
  requestedAt: '2026-09-28T12:01:00.000Z',
  scope,
  sourceDecisionRef: 'privacy-disposition-decision:7',
  sourceDecisionRevision: 'revision-3',
  targetContentRefs: ['inventory-evidence:opaque-correlation-7'],
} as const satisfies PrivacyMeasureEncoded;

it('accepts NO_DATA only with complete evidence for every requested owner-scope part', () => {
  expect(decodeCoverage(completeNoData)).toBeDefined();

  for (const invalid of [
    {
      ...completeNoData,
      coverageParts: [
        completeNoData.coverageParts[0],
        {
          ...completeNoData.coverageParts[1],
          coverageStatus: 'INDETERMINATE',
          unresolvedReason: 'backup coverage has not been reconciled',
        },
      ],
    },
    {
      ...completeNoData,
      coverageParts: [
        {
          ...completeNoData.coverageParts[0],
          foundContentRefs: ['reservation-history:found-7'],
        },
        completeNoData.coverageParts[1],
      ],
    },
    { ...completeNoData, coverageParts: [] },
    {
      ...completeNoData,
      coverageParts: [completeNoData.coverageParts[0], completeNoData.coverageParts[0]],
    },
  ]) {
    expect(() => decodeCoverage(invalid)).toThrow();
  }
});

it('keeps found content separate from partial or indeterminate coverage', () => {
  expect(
    decodeCoverage({
      ...completeNoData,
      contentStatus: 'FOUND',
      coverageParts: [
        {
          ...completeNoData.coverageParts[0],
          foundContentRefs: ['reservation-history:found-7'],
        },
        {
          ...completeNoData.coverageParts[1],
          coverageStatus: 'INDETERMINATE',
          unresolvedReason: 'recovery responsibilities are not verified',
        },
      ],
      coverageStatus: 'INDETERMINATE',
    }),
  ).toBeDefined();
});

it('binds a Privacy Measure to an exact subject, scope, source decision, revision and stable identity', () => {
  expect(decodeMeasure(measure)).toBeDefined();
  expect(() => decodeMeasure({ ...measure, targetContentRefs: [] })).toThrow();
  expect(() => decodeMeasure({ ...measure, sourceDecisionRevision: '' })).toThrow();
  expect(() => decodeMeasure({ ...measure, privateOwnerTable: 'inventory_reservations' })).toThrow();
});

it('distinguishes truthful owner outcomes and requires reconciliation for indeterminate execution', () => {
  const indeterminate = {
    affectedContentRefs: [],
    confirmedAt: '2026-09-28T12:02:00.000Z',
    evidenceRefs: ['inventory-effect:7'],
    measureRef: measure.measureRef,
    outcomeRef: 'privacy-owner-outcome:7',
    reason: 'the owner mutation may have committed before the response was lost',
    reconciliationRequired: true,
    remainingContentRefs: measure.targetContentRefs,
    scope,
    sourceDecisionRef: measure.sourceDecisionRef,
    sourceDecisionRevision: measure.sourceDecisionRevision,
    status: 'INDETERMINATE',
  } as const satisfies PrivacyOwnerExecutionOutcomeEncoded;

  expect(decodeOutcome(indeterminate)).toBeDefined();
  expect(() => decodeOutcome({ ...indeterminate, reconciliationRequired: false })).toThrow();
  expect(() =>
    decodeOutcome({
      ...indeterminate,
      affectedContentRefs: ['inventory-evidence:removed-7'],
      reconciliationRequired: false,
      remainingContentRefs: [],
      status: 'PARTIAL',
    }),
  ).toThrow();
});

it('allows retry only after reconciliation proves non-execution and Current preconditions are rechecked', () => {
  const decodeReconciliation = Schema.decodeUnknownSync(PrivacyOwnerReconciliationResultSchema, {
    onExcessProperty: 'error',
  });

  expect(
    decodeReconciliation({
      evidenceRefs: ['inventory-effect:7/not-executed'],
      measureRef: measure.measureRef,
      observedAt: '2026-09-28T12:03:00.000Z',
      preconditionsRecheckedAt: '2026-09-28T12:04:00.000Z',
      retryAllowed: true,
      sourceDecisionRevision: measure.sourceDecisionRevision,
      status: 'NOT_EXECUTED',
    }),
  ).toBeDefined();
  expect(() =>
    decodeReconciliation({
      evidenceRefs: ['inventory-effect:7/unknown'],
      measureRef: measure.measureRef,
      observedAt: '2026-09-28T12:03:00.000Z',
      preconditionsRecheckedAt: '2026-09-28T12:04:00.000Z',
      retryAllowed: true,
      sourceDecisionRevision: measure.sourceDecisionRevision,
      status: 'STILL_INDETERMINATE',
    }),
  ).toThrow();
});

it('requires exact anti-resurrection scope without retaining the removed payload', () => {
  const decodeProtection = Schema.decodeUnknownSync(AntiResurrectionProtectionSchema, {
    onExcessProperty: 'error',
  });

  const protection = {
    enforcedAt: '2026-09-28T12:05:00.000Z',
    evidenceRefs: ['inventory-evidence:delete-proof-7'],
    kind: 'DELETED_SCOPE',
    protectedContentRefs: measure.targetContentRefs,
    protectionRef: 'anti-resurrection:inventory/7',
    retainsRemovedPayload: false,
    scope,
    sourceDecisionRef: measure.sourceDecisionRef,
    sourceDecisionRevision: measure.sourceDecisionRevision,
    sourceOutcomeRef: 'privacy-owner-outcome:7',
    staleSourceResponsibilities: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
  } as const;

  expect(decodeProtection(protection)).toBeDefined();
  expect(() => decodeProtection({ ...protection, sourceDecisionRevision: '' })).toThrow();
  expect(() =>
    decodeProtection({
      ...protection,
      protectedContentRefs: [measure.targetContentRefs[0], measure.targetContentRefs[0]],
    }),
  ).toThrow();
  expect(() =>
    decodeProtection({
      ...protection,
      removedPayload: { email: 'must-not-be-retained@example.test' },
    }),
  ).toThrow();
});
