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

const evaluate = (overrides: Partial<OwnerMeasureEvaluationInput> = {}) =>
  evaluateCommunicationsOwnerMeasure({
    blockers: [],
    confirmedAt,
    coverage: foundCoverage(),
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
    const outcome = evaluate({ evidence: [evidenceOf()] });
    expect(outcome.status).toBe('ACHIEVED');
    expect(outcome.remainingContentRefs).toEqual([]);
    expect(outcome.evidenceRefs).toContain('FICTIONAL-owner-action-evidence-1');
    expect(isOpenObligation(outcome)).toBe(false);
  });

  it('reports PARTIAL with the remaining scope when only part A is evidenced (A achieved, B pending)', () => {
    const outcome = evaluate({
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
      evidenceOf({ ownerCapability: 'commerce.tax' }),
      evidenceOf({ tenantId: '00000000-0000-4000-8000-0000000000ff' }),
      evidenceOf({ requestedScopeRef: 'FICTIONAL-another-scope' }),
      evidenceOf({ measureRef: 'FICTIONAL-measure-2' }),
      evidenceOf({ sourceDecisionRef: 'FICTIONAL-decision-2' }),
      evidenceOf({ sourceDecisionRevision: '2' }),
    ];
    for (const record of foreign) {
      const outcome = evaluate({ evidence: [record] });
      expect(outcome.status).toBe('PENDING');
      expect(outcome.affectedContentRefs).toEqual([]);
    }
    // the exact receipt still counts alongside them: only matching evidence is read
    expect(evaluate({ evidence: [...foreign, evidenceOf()] }).status).toBe('ACHIEVED');
  });

  it('does not count a result for a target the measure did not name, nor a result of the wrong kind', () => {
    const outcome = evaluate({
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
  it('keeps the replaced provider as a known historical holder next to the current transport', () => {
    const holders = externalCopyInventoryOf([
      { observedAtMillis: Date.parse('2026-01-01T00:00:00Z'), providerKey: 'provider-a' },
      { observedAtMillis: Date.parse('2026-01-02T00:00:00Z'), providerKey: 'provider-a' },
      { observedAtMillis: Date.parse('2026-06-01T00:00:00Z'), providerKey: 'provider-b' },
    ]);
    expect(holders.map(({ holderRef, relationship }) => [holderRef, relationship])).toEqual([
      ['step-22-provider:provider-a', 'KNOWN_HISTORICAL_HOLDER'],
      ['step-22-provider:provider-b', 'CURRENT_TRANSPORT'],
    ]);
    expect(holders[0] === undefined ? '' : DateTime.formatIso(holders[0].firstObservedAt)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(holders[0] === undefined ? '' : DateTime.formatIso(holders[0].lastObservedAt)).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('never claims provider-side disposition: a deletion request is not evidence of a deleted copy', () => {
    const holders = externalCopyInventoryOf([
      { observedAtMillis: Date.parse('2026-01-01T00:00:00Z'), providerKey: 'provider-a' },
    ]);
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
