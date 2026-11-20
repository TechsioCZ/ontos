import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  evaluateCommunicationsOwnerMeasure,
  externalCopyInventoryOf,
  handoffRecordOf,
  isOpenObligation,
  isSameMeasureIdentity,
  manualDispositionProcess,
} from '../../shared/privacy-owner/outcome.ts';
import type { OwnerMeasureEvaluationInput } from '../../shared/privacy-owner/outcome.ts';
import {
  allComplete,
  confirmedAt,
  coverageOf,
  evidenceOf,
  foundCoverage,
  intentRef,
  measureOf,
  ownerScope,
} from './support/privacy-owner-fixtures.ts';

/** Without evidence the targets are still found (pending); with evidence the owner's rows are gone unless a test says otherwise. */
const hold = (contentRefs: readonly string[]) => [
  { blockerRef: 'FICTIONAL-hold-1', contentRefs, kind: 'LEGAL_HOLD' as const },
];
const relationships = (holders: ReturnType<typeof externalCopyInventoryOf>) =>
  holders.map(({ holderRef, relationship }) => [holderRef, relationship]);

const evaluate = (overrides: Partial<OwnerMeasureEvaluationInput> = {}) =>
  evaluateCommunicationsOwnerMeasure({
    blockers: [],
    confirmedAt,
    coverage: (overrides.evidence?.length ?? 0) > 0 ? coverageOf(allComplete()) : foundCoverage(),
    evidence: [],
    evidenceRefs: ['FICTIONAL-handoff-evidence'],
    measure: measureOf(),
    outcomeRef: 'FICTIONAL-outcome-1',
    ...overrides,
  });

/**
 * [#1410 PRIV-COM-07/12/17, AC-06/AC-07, BDD "Privacy opatreni a jeho vykonani jsou samostatna fakta"] Receiving or approving a
 * measure is not executing it. Only matching, human-confirmed owner evidence reaches ACHIEVED or PARTIAL.
 */
describe('Owner Execution Outcome of Communications', () => {
  it('stays PENDING after an approved but unconfirmed erasure: no automatic DELETE, no false ACHIEVED', () => {
    const outcome = evaluate();
    expect(outcome.status).toBe('PENDING');
    expect(outcome.reason).toBe('AWAITING_HUMAN_CONFIRMED_OWNER_ACTION');
    expect(outcome.affectedContentRefs).toEqual([]);
    expect(outcome.remainingContentRefs).toEqual([intentRef('a'), intentRef('b')]);
    expect(isOpenObligation(outcome)).toBe(true);
  });

  it('reaches ACHIEVED only when confirmed owner evidence covers every exact target', () => {
    const outcome = evaluate({ coverage: coverageOf(allComplete()), evidence: [evidenceOf()] });
    expect(outcome.status).toBe('ACHIEVED');
    expect(outcome.remainingContentRefs).toEqual([]);
    expect(outcome.evidenceRefs).toContain('FICTIONAL-owner-action-evidence-1');
    expect(isOpenObligation(outcome)).toBe(false);
  });

  it('reports PARTIAL with the remaining scope when only part A is evidenced (A achieved, B pending)', () => {
    const outcome = evaluate({
      coverage: coverageOf(allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [intentRef('b')] } })),
      evidence: [evidenceOf({ results: [{ contentRef: intentRef('a'), result: 'REMOVED' }] })],
    });
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.affectedContentRefs).toEqual([intentRef('a')]);
    expect(outcome.remainingContentRefs).toEqual([intentRef('b')]);
    expect(isOpenObligation(outcome)).toBe(true);
  });

  it('is INDETERMINATE with reconciliation required after a failure past a possible mutation, and never invites a retry', () => {
    const outcome = evaluate({
      evidence: [
        evidenceOf({
          results: [
            { contentRef: intentRef('a'), result: 'REMOVED' },
            { contentRef: intentRef('b'), result: 'FAILED_AFTER_POSSIBLE_MUTATION' },
          ],
        }),
      ],
    });
    expect(outcome.status).toBe('INDETERMINATE');
    expect(outcome.reconciliationRequired).toBe(true);
    expect(outcome.reason).toBe('OWNER_ACTION_FAILED_AFTER_POSSIBLE_MUTATION');
    // repeating the evaluation changes nothing: there is no retry path to take
    expect(
      evaluate({
        evidence: [evidenceOf({ results: [{ contentRef: intentRef('b'), result: 'FAILED_AFTER_POSSIBLE_MUTATION' }] })],
      }),
    ).toMatchObject({
      reconciliationRequired: true,
      status: 'INDETERMINATE',
    });
  });

  it('reports IN_PROGRESS only on human-confirmed in-progress evidence, never from a receipt or a timer', () => {
    expect(evaluate({ evidence: [evidenceOf({ phase: 'IN_PROGRESS', results: [] })] }).status).toBe('IN_PROGRESS');
    expect(evaluate().status).not.toBe('IN_PROGRESS');
  });

  it('ignores a receipt of another owner, tenant, scope, measure or revision: it never confirms Communications', () => {
    const foreign = [
      evidenceOf({ scope: ownerScope({ ownerCapability: 'commerce.tax' }) }),
      evidenceOf({ scope: ownerScope({ tenantId: '00000000-0000-4000-8000-0000000000ff' }) }),
      evidenceOf({ scope: ownerScope({ requestedScopeRef: 'FICTIONAL-another-scope' }) }),
      evidenceOf({ measureRef: 'FICTIONAL-measure-2' }),
      evidenceOf({ sourceDecisionRef: 'FICTIONAL-decision-2' }),
      evidenceOf({ sourceDecisionRevision: '2' }),
    ];
    for (const record of foreign) {
      const outcome = evaluate({ coverage: foundCoverage(), evidence: [record] });
      expect(outcome.status).toBe('PENDING');
      expect(outcome.affectedContentRefs).toEqual([]);
    }
    // the exact receipt still counts alongside them: only matching evidence is read
    expect(evaluate({ evidence: [...foreign, evidenceOf()] }).status).toBe('ACHIEVED');
  });

  it('ignores evidence for another subject, controller, lookup or scope part: forged scope binding never counts', () => {
    const forged = [
      evidenceOf({
        scope: ownerScope({ subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-another-subject' } }),
      }),
      evidenceOf({
        scope: ownerScope({ subject: { _tag: 'ANONYMOUS_PRIVACY_CONTEXT', contextRef: 'FICTIONAL-subject-1' } }),
      }),
      evidenceOf({ scope: ownerScope({ controllerRef: 'FICTIONAL-another-controller' }) }),
      evidenceOf({ scope: ownerScope({ trustedLookupRefs: ['FICTIONAL-another-lookup'] }) }),
      evidenceOf({ scope: ownerScope({ requestedScopePartRefs: [ownerScope().requestedScopePartRefs[0] ?? 'x'] }) }),
    ];
    for (const record of forged) {
      expect(evaluate({ coverage: foundCoverage(), evidence: [record] })).toMatchObject({
        affectedContentRefs: [],
        status: 'PENDING',
      });
    }
  });

  it('ignores a confirmation without a human: a blank, untrimmed or oversized confirming reference is no confirmation', () => {
    for (const confirmedByHumanRef of ['', '   ', ' FICTIONAL-human-1', 'FICTIONAL-human-1 ', 'x'.repeat(1001)]) {
      expect(evaluate({ coverage: foundCoverage(), evidence: [evidenceOf({ confirmedByHumanRef })] })).toMatchObject({
        affectedContentRefs: [],
        status: 'PENDING',
      });
    }
    expect(evaluate({ coverage: foundCoverage(), evidence: [evidenceOf({ evidenceRef: '' })] }).status).toBe('PENDING');
  });

  it('never counts a result of an IN_PROGRESS or RECEIVED record, even when it is mixed with a COMPLETED one', () => {
    const inProgress = evidenceOf({
      confirmedAt: DateTime.makeUnsafe('2026-11-19T13:00:00.000Z'),
      evidenceRef: 'FICTIONAL-in-progress',
      phase: 'IN_PROGRESS',
      results: [{ contentRef: intentRef('b'), result: 'REMOVED' }],
    });
    const completedA = evidenceOf({ results: [{ contentRef: intentRef('a'), result: 'REMOVED' }] });
    // an in-progress record claiming B removed does not make B achieved: the Action is still running
    const mixed = evaluate({ evidence: [completedA, inProgress] });
    expect(mixed).toMatchObject({
      affectedContentRefs: [intentRef('a')],
      remainingContentRefs: [intentRef('b')],
      status: 'IN_PROGRESS',
    });
    // alone, an in-progress record that claims everything removed is still not ACHIEVED
    const alone = evaluate({
      evidence: [
        evidenceOf({ phase: 'IN_PROGRESS' }),
        evidenceOf({ evidenceRef: 'FICTIONAL-received', phase: 'RECEIVED' }),
      ],
    });
    expect(alone.status).not.toBe('ACHIEVED');
    expect(alone.affectedContentRefs).toEqual([]);
  });

  it('reports RECEIVED when the owner took the measure over and nothing has started', () => {
    const outcome = evaluate({ evidence: [evidenceOf({ phase: 'RECEIVED', results: [] })] });
    expect(outcome).toMatchObject({
      affectedContentRefs: [],
      reason: 'MEASURE_RECEIVED_BY_OWNER_NOTHING_STARTED',
      remainingContentRefs: [intentRef('a'), intentRef('b')],
      status: 'RECEIVED',
    });
    expect(isOpenObligation(outcome)).toBe(true);
  });

  it('reports TECHNICAL_FAILED for a definite failure that proved no mutation, and INDETERMINATE when a mutation is possible', () => {
    const failed = evaluate({
      evidence: [
        evidenceOf({
          results: [
            { contentRef: intentRef('a'), result: 'FAILED_BEFORE_ANY_MUTATION' },
            { contentRef: intentRef('b'), result: 'FAILED_BEFORE_ANY_MUTATION' },
          ],
        }),
      ],
    });
    expect(failed).toMatchObject({
      reason: 'OWNER_ACTION_FAILED_BEFORE_ANY_MUTATION',
      reconciliationRequired: false,
      remainingContentRefs: [intentRef('a'), intentRef('b')],
      status: 'TECHNICAL_FAILED',
    });
    expect(isOpenObligation(failed)).toBe(true);
    // a possible mutation next to a proven non-mutation is INDETERMINATE, never a retryable failure
    expect(
      evaluate({
        evidence: [
          evidenceOf({
            results: [
              { contentRef: intentRef('a'), result: 'FAILED_BEFORE_ANY_MUTATION' },
              { contentRef: intentRef('b'), result: 'FAILED_AFTER_POSSIBLE_MUTATION' },
            ],
          }),
        ],
      }).status,
    ).toBe('INDETERMINATE');
    // possible mutation reported by a still-running Action is likewise never ignored
    expect(
      evaluate({
        evidence: [
          evidenceOf({
            phase: 'IN_PROGRESS',
            results: [{ contentRef: intentRef('a'), result: 'FAILED_AFTER_POSSIBLE_MUTATION' }],
          }),
        ],
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('keeps the proven part PARTIAL when the rest failed before any mutation', () => {
    expect(
      evaluate({
        evidence: [
          evidenceOf({
            results: [
              { contentRef: intentRef('a'), result: 'REMOVED' },
              { contentRef: intentRef('b'), result: 'FAILED_BEFORE_ANY_MUTATION' },
            ],
          }),
        ],
      }),
    ).toMatchObject({
      affectedContentRefs: [intentRef('a')],
      remainingContentRefs: [intentRef('b')],
      status: 'PARTIAL',
    });
  });

  it('is never ACHIEVED while a current Legal Hold sits on an evidenced target: BLOCKED or PARTIAL with the reason', () => {
    expect(evaluate({ blockers: hold([intentRef('a'), intentRef('b')]), evidence: [evidenceOf()] })).toMatchObject({
      affectedContentRefs: [],
      reason: 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT_ON_EVIDENCED_TARGET',
      status: 'BLOCKED',
    });
    expect(evaluate({ blockers: hold([intentRef('a')]), evidence: [evidenceOf()] })).toMatchObject({
      affectedContentRefs: [intentRef('b')],
      reason: 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT_ON_PART_OF_THE_EVIDENCED_TARGETS',
      remainingContentRefs: [intentRef('a')],
      status: 'PARTIAL',
    });
  });

  it('never accepts a claimed REMOVED while the exact-reference lookup still FINDS the row: INDETERMINATE, reconcile first', () => {
    const outcome = evaluate({ coverage: foundCoverage(), evidence: [evidenceOf()] });
    expect(outcome).toMatchObject({
      reason: 'CLAIMED_REMOVAL_CONTRADICTED_BY_CURRENT_COVERAGE',
      reconciliationRequired: true,
      status: 'INDETERMINATE',
    });
    // once the rows are really gone from complete coverage, the same evidence is believed
    expect(evaluate({ coverage: coverageOf(allComplete()), evidence: [evidenceOf()] }).status).toBe('ACHIEVED');
    // a non-removing outcome keeps its row by design, so the row being found is no contradiction there
    expect(
      evaluate({
        coverage: foundCoverage(),
        evidence: [
          evidenceOf({
            results: [
              { contentRef: intentRef('a'), result: 'RESTRICTED' },
              { contentRef: intentRef('b'), result: 'RESTRICTED' },
            ],
          }),
        ],
        measure: measureOf({ intendedOutcome: 'ENFORCE_PROCESSING_RESTRICTION' }),
      }).status,
    ).toBe('ACHIEVED');
  });

  it('does not count a result for a target the measure did not name, nor a result of the wrong kind', () => {
    const outcome = evaluate({
      coverage: foundCoverage(),
      evidence: [
        evidenceOf({
          results: [
            { contentRef: intentRef('zzz'), result: 'REMOVED' },
            { contentRef: intentRef('a'), result: 'RESTRICTED' },
            { contentRef: intentRef('b'), result: 'NOT_EXECUTED' },
          ],
        }),
      ],
    });
    expect(outcome.status).toBe('PENDING');
    expect(outcome.affectedContentRefs).toEqual([]);
  });

  it('is BLOCKED by a Current Legal Hold or retention obligation on a destructive target, before any owner effect', () => {
    const outcome = evaluate({
      blockers: [{ blockerRef: 'FICTIONAL-hold-1', contentRefs: [intentRef('a')], kind: 'LEGAL_HOLD' }],
    });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.remainingContentRefs).toEqual([intentRef('a'), intentRef('b')]);
  });

  it('is NOT_APPLICABLE only on complete coverage that proves no data, and INDETERMINATE when coverage cannot say', () => {
    expect(evaluate({ coverage: coverageOf(allComplete()) }).status).toBe('NOT_APPLICABLE');
    const incomplete = coverageOf(
      allComplete({ PROVIDER_COPY_WORKING_COPY_PROTECTION: { coverageStatus: 'PARTIAL', unresolvedReason: 'BACKUP' } }),
    );
    expect(evaluate({ coverage: incomplete }).status).toBe('INDETERMINATE');
  });

  it('re-checks the coverage before NOT_APPLICABLE: a forged NO_DATA over an incomplete or found part is never believed', () => {
    const honest = coverageOf(allComplete());
    const [first, ...rest] = honest.coverageParts;
    const incompletePart =
      first === undefined ? [] : [{ ...first, coverageStatus: 'PARTIAL' as const, unresolvedReason: 'X' }];
    const forgedIncomplete = { ...honest, coverageParts: [...incompletePart, ...rest] };
    expect(evaluate({ coverage: forgedIncomplete }).status).not.toBe('NOT_APPLICABLE');
    const foundPart = first === undefined ? [] : [{ ...first, foundContentRefs: [intentRef('a'), intentRef('b')] }];
    const forgedFound = { ...honest, coverageParts: [...foundPart, ...rest] };
    expect(evaluate({ coverage: forgedFound }).status).not.toBe('NOT_APPLICABLE');
    expect(evaluate({ coverage: honest }).status).toBe('NOT_APPLICABLE');
  });

  it('rejects a coverage of another scope and a retry whose identity changed', () => {
    expect(
      evaluate({ coverage: coverageOf(allComplete(), ownerScope({ requestedScopeRef: 'FICTIONAL-other' })) }).status,
    ).toBe('BUSINESS_REJECTED');
    const changed = measureOf({ intendedOutcome: 'ANONYMIZE' });
    expect(evaluate({ measure: changed, previousMeasure: measureOf() }).reason).toBe(
      'IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT',
    );
    expect(isSameMeasureIdentity(measureOf(), measureOf({ targetContentRefs: [intentRef('b'), intentRef('a')] }))).toBe(
      true,
    );
    expect(evaluate({ measure: measureOf(), previousMeasure: measureOf() }).status).toBe('PENDING');
  });

  it('is not for another owner: a Tax measure is business-rejected here', () => {
    const measure = measureOf({ scope: ownerScope({ ownerCapability: 'commerce.tax' }) });
    expect(evaluate({ coverage: coverageOf(allComplete(), measure.scope), measure }).status).toBe('BUSINESS_REJECTED');
  });

  it('answers a repeated handoff identically: the same measure never changes the data or the state', () => {
    expect(evaluate()).toEqual(evaluate());
    expect(evaluate({ previousMeasure: measureOf() })).toEqual(evaluate());
  });
});

describe('Handoff record of a pending obligation (AC-16, BDD "Predana povinnost ceka na potvrzeni konkretnim clovekem")', () => {
  it('names the responsible human owner and the next step, carries no deadline and records no destructive action', () => {
    const record = handoffRecordOf(evaluate(), 'FICTIONAL-human-owner');
    expect(record).toMatchObject({
      destructiveActionPerformed: false,
      nextStep: 'CONFIRM_EXACT_OWNER_ACTION_BY_AUTHORIZED_HUMAN',
      outcomeStatus: 'PENDING',
      responsibleOwner: { kind: 'ASSIGNED_HUMAN_OWNER', ownerRef: 'FICTIONAL-human-owner' },
      timeLimit: 'SET_BY_APPROVED_PROCESS_NOT_BY_THIS_OWNER',
    });
    expect(Object.keys(record)).not.toContain('deadline');
  });

  it('escalates to the product owner to assign one while no human disposition owner is supplied (an open input gate)', () => {
    const record = handoffRecordOf(evaluate());
    expect(record.responsibleOwner).toEqual({
      escalateTo: 'PRODUCT_OWNER',
      kind: 'UNASSIGNED_ESCALATE',
      missingInput: 'HUMAN_DISPOSITION_OWNER',
    });
    expect(record.nextStep).toBe('ASSIGN_HUMAN_DISPOSITION_OWNER');
  });

  it('stays open for the remaining targets after a partial result and for reconciliation after an indeterminate one', () => {
    const partial = handoffRecordOf(
      evaluate({ evidence: [evidenceOf({ results: [{ contentRef: intentRef('a'), result: 'REMOVED' }] })] }),
      'FICTIONAL-human-owner',
    );
    expect(partial.nextStep).toBe('COMPLETE_REMAINING_TARGETS');
    expect(partial.remainingContentRefs).toEqual([intentRef('b')]);
    const indeterminate = handoffRecordOf(
      evaluate({
        evidence: [evidenceOf({ results: [{ contentRef: intentRef('b'), result: 'FAILED_AFTER_POSSIBLE_MUTATION' }] })],
      }),
      'FICTIONAL-human-owner',
    );
    expect(indeterminate.nextStep).toBe('RECONCILE_OWNER_STATE_BEFORE_ANY_RETRY');
  });
});

/** [#1410 AC-10, PRIV-COM-14, #603] A provider change keeps every earlier external holder and invents no provider-side disposition. */
describe('External copy inventory', () => {
  const facts = [
    { observedAtMillis: Date.parse('2026-01-01T00:00:00Z'), providerKey: 'provider-a' },
    { observedAtMillis: Date.parse('2026-01-02T00:00:00Z'), providerKey: 'provider-a' },
    { observedAtMillis: Date.parse('2026-06-01T00:00:00Z'), providerKey: 'provider-b' },
  ];
  it('keeps the replaced provider as a PRIOR provider next to the current transport the deployment names', () => {
    const holders = externalCopyInventoryOf(facts, 'provider-b');
    expect(relationships(holders)).toEqual([
      ['step-22-provider:provider-a', 'PRIOR_PROVIDER'],
      ['step-22-provider:provider-b', 'CURRENT_TRANSPORT'],
    ]);
    expect(holders[0] === undefined ? '' : DateTime.formatIso(holders[0].firstObservedAt)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(holders[0] === undefined ? '' : DateTime.formatIso(holders[0].lastObservedAt)).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('never calls the latest fact the current transport: without a named current provider every holder is historical', () => {
    expect(relationships(externalCopyInventoryOf(facts))).toEqual([
      ['step-22-provider:provider-a', 'HISTORICAL_TRANSPORT'],
      ['step-22-provider:provider-b', 'HISTORICAL_TRANSPORT'],
    ]);
    // the deployment can name the OLDER provider as current: then the one handed a message last is the prior one
    expect(relationships(externalCopyInventoryOf(facts, 'provider-a'))).toEqual([
      ['step-22-provider:provider-a', 'CURRENT_TRANSPORT'],
      ['step-22-provider:provider-b', 'PRIOR_PROVIDER'],
    ]);
  });

  it('never claims provider-side disposition: a deletion request is not evidence of a deleted copy', () => {
    const holders = externalCopyInventoryOf(
      [{ observedAtMillis: Date.parse('2026-01-01T00:00:00Z'), providerKey: 'provider-a' }],
      'provider-a',
    );
    expect(
      holders.every(
        ({ providerSideDispositionEvidence }) => providerSideDispositionEvidence === 'NOT_HELD_BY_COMMUNICATIONS',
      ),
    ).toBe(true);
  });

  it('is empty when no provider ever observed anything, without claiming that nothing was ever sent', () => {
    expect(externalCopyInventoryOf([])).toEqual([]);
  });
});

/** [#1410 AC-13] The manual-operable disposition process exists as typed data: exactly one step changes data, and only a human starts it. */
describe('Manual disposition process contract', () => {
  it('has exactly one data-changing step, performed by the owner Action only after a human confirmed that exact Action', () => {
    const changing = manualDispositionProcess.filter(({ changesOwnerData }) => changesOwnerData);
    expect(changing.map(({ key }) => key)).toEqual(['OWNER_ACTION_EXECUTED_FOR_THE_EXACT_SCOPE']);
    const keys = manualDispositionProcess.map(({ key }) => key);
    expect(keys.indexOf('AUTHORIZED_HUMAN_CONFIRMS_EXACT_OWNER_ACTION')).toBe(
      keys.indexOf('OWNER_ACTION_EXECUTED_FOR_THE_EXACT_SCOPE') - 1,
    );
    expect(
      manualDispositionProcess.find(({ key }) => key === 'AUTHORIZED_HUMAN_CONFIRMS_EXACT_OWNER_ACTION')?.actor,
    ).toBe('AUTHORIZED_HUMAN');
  });

  it('never lets Communications act: every step it performs only observes or hands over', () => {
    for (const step of manualDispositionProcess.filter(({ actor }) => actor === 'COMMUNICATIONS_OBSERVATION_ONLY')) {
      expect(step.changesOwnerData).toBe(false);
    }
  });

  it('keeps a measure on an external provider copy pending: a provider API request is not provider-side disposition', () => {
    const providerRef = 'step-22-provider:provider-a';
    const outcome = evaluateCommunicationsOwnerMeasure({
      blockers: [],
      confirmedAt,
      coverage: coverageOf(allComplete({ PROVIDER_COPY_WORKING_COPY_PROTECTION: { foundContentRefs: [providerRef] } })),
      evidence: [],
      evidenceRefs: ['FICTIONAL-provider-accepted-the-request'],
      measure: measureOf({ targetContentRefs: [providerRef] }),
      outcomeRef: 'FICTIONAL-outcome-provider',
    });
    expect(outcome.status).toBe('PENDING');
    expect(outcome.remainingContentRefs).toEqual([providerRef]);
  });
});
