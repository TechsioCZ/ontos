import { describe, expect, it } from 'effect-rstest';
import { assembleOwnerContributions, decideProtectedContent } from '../../shared/domain/owner-contribution.ts';
import type { OwnerContribution } from '../../shared/domain/owner-contribution.ts';

const contribution = (owner: string, revision = 1, overrides: Partial<OwnerContribution> = {}): OwnerContribution => ({
  batches: [
    {
      batchId: `${owner}-batch-1`,
      capturedAt: '2026-09-14T10:01:00Z',
      consistency: 'CONSISTENT',
      coveredScopeRefs: ['scope-1'],
      includedResourceRefs: [],
      missingScopeRefs: [],
      observedAt: '2026-09-14T10:00:00Z',
      revision: 1,
    },
  ],
  captureTime: '2026-09-14T10:01:00Z',
  completion: 'COMPLETE',
  contributionId: `${owner}-contribution`,
  controllerObligationRef: 'obligation-1',
  coverageResult: 'COMPLETE',
  decisionScope: 'requested-scope',
  exclusions: [],
  includedContentRefs: [],
  observationTime: '2026-09-14T10:00:00Z',
  ownerScope: ['scope-1'],
  owningCapability: owner,
  revision,
  right: 'ACCESS',
  subjectRef: 'subject-1',
  ...overrides,
});

describe('DSR owner contributions', () => {
  it('assembles complete owners while preserving each observation time and no atomic snapshot claim', () => {
    const result = assembleOwnerContributions(
      ['T1', 'T2'],
      [contribution('T1'), contribution('T2', 1, { observationTime: '2026-09-14T11:00:00Z' })],
    );
    expect(result.complete).toBe(true);
    expect(result.atomicSnapshot).toBe(false);
    expect(result.observationTimes.get('T1')).toBe('2026-09-14T10:00:00Z');
    expect(result.observationTimes.get('T2')).toBe('2026-09-14T11:00:00Z');
  });

  it('does not let a missing batch or unavailable owner become complete', () => {
    const result = assembleOwnerContributions(
      ['T1', 'T2'],
      [contribution('T1'), contribution('T2', 1, { completion: 'INCOMPLETE', coverageResult: 'PARTIAL' })],
    );
    expect(result.complete).toBe(false);
    expect(result.contributions[1]?.coverageResult).toBe('PARTIAL');
  });

  it('does not accept COMPLETE coverage without an owner batch', () => {
    expect(assembleOwnerContributions(['T1'], [contribution('T1', 1, { batches: [] })]).complete).toBe(false);
    expect(
      assembleOwnerContributions(['T1'], [contribution('T1', 1, { batches: [], coverageResult: 'NO_DATA' })]).complete,
    ).toBe(true);
  });

  it('uses the newest revision without counting retries as another contribution', () => {
    const result = assembleOwnerContributions(
      ['T1'],
      [
        contribution('T1', 1),
        contribution('T1', 2, { includedContentRefs: ['resource-2'], observationTime: '2026-09-14T12:00:00Z' }),
      ],
    );
    expect(result.contributions.length).toBe(1);
    expect(result.contributions[0]?.revision).toBe(2);
  });

  it('protects the smallest separable third-party scope and fails closed on technical failure', () => {
    expect(
      decideProtectedContent({
        affectedScope: 'third-party-recipient',
        containsOtherDataSubjects: true,
        contentRef: 'message-1',
        eligibleForRight: true,
        protectionSucceeded: true,
        separable: true,
      }).outcome,
    ).toBe('REDACT');
    expect(
      decideProtectedContent({
        affectedScope: 'whole-file',
        containsOtherDataSubjects: true,
        contentRef: 'file-1',
        eligibleForRight: true,
        protectionSucceeded: true,
        separable: false,
      }).outcome,
    ).toBe('EXCLUDE');
    expect(
      decideProtectedContent({
        affectedScope: 'whole-file',
        containsOtherDataSubjects: false,
        contentRef: 'file-2',
        eligibleForRight: true,
        protectionSucceeded: false,
        separable: true,
      }).outcome,
    ).toBe('FAILED');
  });
});
