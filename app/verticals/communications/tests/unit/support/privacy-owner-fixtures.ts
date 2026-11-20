import { DateTime } from 'effect';
import type {
  PrivacyMeasureEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerScopeEncoded,
} from '@app/shared-contracts';

import { assessCommunicationsOwnerCoverage, communicationsContentRef } from '../../../shared/privacy-owner/coverage.ts';
import type { CategoryObservation } from '../../../shared/privacy-owner/coverage.ts';
import { INVENTORY_CATEGORY_IDS, scopePartRefs } from '../../../shared/privacy-owner/inventory.ts';
import type { InventoryCategoryId } from '../../../shared/privacy-owner/inventory.ts';
import type { OwnerExecutionEvidenceRecord } from '../../../shared/privacy-owner/outcome.ts';

/** Every value below is a FICTIONAL test value. None is a legal basis, retention period, purpose id or controller. */
export const tenantId = '00000000-0000-4000-8000-0000000000a1';
export const observedAt = '2026-11-19T10:00:00.000Z';
export const confirmedAt = '2026-11-19T12:00:00.000Z';
export const confirmedInstant = DateTime.makeUnsafe(confirmedAt);

export const ownerScope = (overrides: Partial<PrivacyOwnerScopeEncoded> = {}): PrivacyOwnerScopeEncoded => ({
  controllerRef: 'FICTIONAL-controller',
  ownerCapability: 'communications.core',
  requestedScopePartRefs: [...scopePartRefs],
  requestedScopeRef: 'FICTIONAL-requested-scope',
  subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-1' },
  tenantId,
  trustedLookupRefs: ['FICTIONAL-lookup-1'],
  ...overrides,
});

export const observation = (
  category: InventoryCategoryId,
  overrides: Partial<CategoryObservation> = {},
): CategoryObservation => ({
  category,
  coverageStatus: 'COMPLETE',
  evidenceRefs: [`FICTIONAL-evidence/${category}`],
  foundContentRefs: [],
  observedAt,
  ...overrides,
});

export const allComplete = (overrides: Partial<Record<InventoryCategoryId, Partial<CategoryObservation>>> = {}) =>
  INVENTORY_CATEGORY_IDS.map((category) => observation(category, overrides[category]));

export const coverageOf = (
  observations: readonly CategoryObservation[],
  scope: PrivacyOwnerScopeEncoded = ownerScope(),
): PrivacyOwnerCoverageResultEncoded =>
  assessCommunicationsOwnerCoverage({
    assessedAt: observedAt,
    evidenceRefs: ['FICTIONAL-evidence'],
    observations,
    scope,
  });

export const intentRef = (id: string) => communicationsContentRef('intent', id);
export const requestRef = (id: string) => communicationsContentRef('request', id);

export const measureOf = (overrides: Partial<PrivacyMeasureEncoded> = {}): PrivacyMeasureEncoded => ({
  expectedEvidenceRefs: ['FICTIONAL-expected-evidence'],
  idempotencyKey: 'FICTIONAL-idempotency-1',
  intendedOutcome: 'DELETE',
  measureRef: 'FICTIONAL-measure-1',
  preconditionRefs: [],
  requestedAt: observedAt,
  scope: ownerScope(),
  sourceDecisionRef: 'FICTIONAL-decision-1',
  sourceDecisionRevision: '1',
  targetContentRefs: [intentRef('a'), intentRef('b')],
  ...overrides,
});

export const evidenceOf = (overrides: Partial<OwnerExecutionEvidenceRecord> = {}): OwnerExecutionEvidenceRecord => ({
  confirmedAt: confirmedInstant,
  confirmedByHumanRef: 'FICTIONAL-human-1',
  evidenceRef: 'FICTIONAL-owner-action-evidence-1',
  measureRef: 'FICTIONAL-measure-1',
  phase: 'COMPLETED',
  results: [
    { contentRef: intentRef('a'), result: 'REMOVED' },
    { contentRef: intentRef('b'), result: 'REMOVED' },
  ],
  scope: ownerScope(),
  sourceDecisionRef: 'FICTIONAL-decision-1',
  sourceDecisionRevision: '1',
  ...overrides,
});

/** A complete coverage that FOUND the measure's targets, so a pending measure is judged on its own merits. */
export const foundCoverage = () =>
  coverageOf(allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [intentRef('a'), intentRef('b')] } }));
