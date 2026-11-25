import { describe, expect, it } from 'effect-rstest';

import { evaluateCommunicationsOwnerMeasure } from '../../shared/privacy-owner/outcome.ts';
import type {
  EvidencedTargetResult,
  OwnerEnforcementSignal,
  OwnerMeasureEvaluationInput,
} from '../../shared/privacy-owner/outcome.ts';
import {
  allComplete,
  confirmedAt,
  coverageOf,
  evidenceOf,
  foundCoverage,
  intentRef,
  measureOf,
} from './support/privacy-owner-fixtures.ts';

/**
 * [R-D11, #1410 PRIV-COM-12 and AC-07, #1408 BDD "Opravneny owner Action prokaze skutecny vysledek"] A human's confirmation that
 * an owner Action ran is a claim. Communications has no restriction gate, no rectification record and no disposition routine
 * (every personal-data table blocks UPDATE and DELETE), so without a real enforcement signal NO measure reaches ACHIEVED or
 * PARTIAL, and the claim is never reported as an enforced restriction of data that is still being served.
 */
const targets = [intentRef('a'), intentRef('b')];

const CASES = [
  {
    intendedOutcome: 'ENFORCE_PROCESSING_RESTRICTION',
    reason: 'OWNER_RESTRICTION_ENFORCEMENT_NOT_VERIFIABLE',
    result: 'RESTRICTED',
    stillHeld: true,
  },
  {
    intendedOutcome: 'ENFORCE_DISPOSITION_RESTRICTION',
    reason: 'OWNER_RESTRICTION_ENFORCEMENT_NOT_VERIFIABLE',
    result: 'RESTRICTED',
    stillHeld: true,
  },
  {
    intendedOutcome: 'RECTIFY',
    reason: 'OWNER_RECTIFICATION_NOT_VERIFIABLE',
    result: 'RECTIFIED',
    stillHeld: true,
  },
  {
    intendedOutcome: 'DELETE',
    reason: 'OWNER_DISPOSITION_NOT_VERIFIABLE_NO_DISPOSITION_ROUTINE',
    result: 'REMOVED',
    stillHeld: false,
  },
  {
    intendedOutcome: 'ANONYMIZE',
    reason: 'OWNER_DISPOSITION_NOT_VERIFIABLE_NO_DISPOSITION_ROUTINE',
    result: 'ANONYMIZED',
    stillHeld: false,
  },
] as const satisfies readonly {
  readonly intendedOutcome: OwnerMeasureEvaluationInput['measure']['intendedOutcome'];
  readonly reason: string;
  readonly result: EvidencedTargetResult;
  readonly stillHeld: boolean;
}[];

const signal = (enforcedContentRefs: readonly string[]): OwnerEnforcementSignal => ({
  enforcedContentRefs,
  signalRef: 'FICTIONAL-enforcement-signal-1',
});

/** The coverage a CLAIMED action leaves: a restricted or rectified record is still held, a removed one is not found. */
const evaluate = (
  { intendedOutcome, result, stillHeld }: (typeof CASES)[number],
  overrides: Partial<OwnerMeasureEvaluationInput> = {},
  claimed: readonly string[] = targets,
) =>
  evaluateCommunicationsOwnerMeasure({
    blockerAssessment: { assessedByRef: 'FICTIONAL-privacy-assessment-1', blockers: [] },
    confirmedAt,
    coverage: stillHeld
      ? foundCoverage()
      : coverageOf(allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [] } })),
    evidence: [evidenceOf({ results: claimed.map((contentRef) => ({ contentRef, result })) })],
    evidenceRefs: ['FICTIONAL-handoff-evidence'],
    measure: measureOf({ intendedOutcome }),
    outcomeRef: 'FICTIONAL-outcome-1',
    ...overrides,
  });

describe('Communications owner outcome without a real enforcement signal', () => {
  for (const testCase of CASES) {
    it(`holds a human-confirmed ${testCase.intendedOutcome} INDETERMINATE and never reports it achieved`, () => {
      const outcome = evaluate(testCase);
      expect(outcome).toMatchObject({
        affectedContentRefs: [],
        reason: testCase.reason,
        reconciliationRequired: true,
        remainingContentRefs: targets,
        status: 'INDETERMINATE',
      });
    });

    it(`reaches ACHIEVED for ${testCase.intendedOutcome} only with a signal for every claimed target`, () => {
      const outcome = evaluate(testCase, { enforcement: signal(targets) });
      expect(outcome.status).toBe('ACHIEVED');
      expect(outcome.evidenceRefs).toContain('FICTIONAL-enforcement-signal-1');
    });

    it(`holds ${testCase.intendedOutcome} INDETERMINATE when the signal covers only part of the claimed targets`, () => {
      const outcome = evaluate(testCase, { enforcement: signal([intentRef('a')]) });
      expect(outcome).toMatchObject({ affectedContentRefs: [], reason: testCase.reason, status: 'INDETERMINATE' });
    });

    it(`ignores a signal for content the ${testCase.intendedOutcome} claim does not name`, () => {
      const outcome = evaluate(testCase, { enforcement: signal([intentRef('unrelated')]) });
      expect(outcome.status).toBe('INDETERMINATE');
    });
  }

  it('does not let a signal replace the contradiction of a removal the lookup still finds', () => {
    const outcome = evaluateCommunicationsOwnerMeasure({
      blockerAssessment: { assessedByRef: 'FICTIONAL-privacy-assessment-1', blockers: [] },
      confirmedAt,
      coverage: foundCoverage(),
      enforcement: signal(targets),
      evidence: [evidenceOf()],
      evidenceRefs: ['FICTIONAL-handoff-evidence'],
      measure: measureOf({ intendedOutcome: 'DELETE' }),
      outcomeRef: 'FICTIONAL-outcome-1',
    });
    expect(outcome).toMatchObject({
      reason: 'CLAIMED_REMOVAL_CONTRADICTED_BY_CURRENT_COVERAGE',
      status: 'INDETERMINATE',
    });
  });

  it('still answers PENDING before any evidence, so the open obligation is not mistaken for a claim', () => {
    const outcome = evaluateCommunicationsOwnerMeasure({
      blockerAssessment: { assessedByRef: 'FICTIONAL-privacy-assessment-1', blockers: [] },
      confirmedAt,
      coverage: foundCoverage(),
      evidence: [],
      evidenceRefs: ['FICTIONAL-handoff-evidence'],
      measure: measureOf({ intendedOutcome: 'ENFORCE_PROCESSING_RESTRICTION' }),
      outcomeRef: 'FICTIONAL-outcome-1',
    });
    expect(outcome.status).toBe('PENDING');
  });
});
