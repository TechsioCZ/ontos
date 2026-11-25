import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyOwnerExecutionReceiptSchema } from '../../shared/apis/privacy-owner-execution-outcome.ts';
import { evaluateCommunicationsOwnerMeasure, handoffRecordOf } from '../../shared/privacy-owner/outcome.ts';
import {
  humanDispositionOwnerOf,
  openObligationOf,
} from '../../src/services/privacy-owner-execution-receipt.service.ts';
import {
  allComplete,
  confirmedAt,
  coverageOf,
  enforcementOf,
  evidenceOf,
  foundCoverage,
  measureOf,
} from './support/privacy-owner-fixtures.ts';

/**
 * [#1410 AC-07, AC-13, PRIV-COM-17; #1408 GOV-07; audit T2-14] The open obligation is SHOWN through the owner receipt Read: who is
 * responsible and what happens next, from the human disposition owner Privacy supplied, else an explicit escalation. It
 * carries no deadline and no performed action.
 */
const assessed = { assessedByRef: 'FICTIONAL-privacy-assessment-1', blockers: [] };
const pending = evaluateCommunicationsOwnerMeasure({
  blockerAssessment: assessed,
  confirmedAt,
  coverage: foundCoverage(),
  evidence: [],
  evidenceRefs: ['FICTIONAL-handoff-evidence'],
  measure: measureOf(),
  outcomeRef: 'FICTIONAL-outcome-1',
});
const achieved = evaluateCommunicationsOwnerMeasure({
  blockerAssessment: assessed,
  confirmedAt,
  coverage: coverageOf(allComplete()),
  enforcement: enforcementOf(),
  evidence: [evidenceOf()],
  evidenceRefs: ['FICTIONAL-handoff-evidence'],
  measure: measureOf(),
  outcomeRef: 'FICTIONAL-outcome-1',
});
const owner = (humanDispositionOwnerRef: string) => ({ humanDispositionOwnerRef });

describe('The open obligation shown through the owner receipt', () => {
  it('escalates to the missing human disposition owner while Privacy supplied none (production default)', () => {
    expect(openObligationOf(pending, {})).toMatchObject({
      openObligation: {
        destructiveActionPerformed: false,
        nextStep: 'ASSIGN_HUMAN_DISPOSITION_OWNER',
        outcomeStatus: 'PENDING',
        responsibleOwner: { kind: 'UNASSIGNED_ESCALATE', missingInput: 'HUMAN_DISPOSITION_OWNER' },
        timeLimit: 'SET_BY_APPROVED_PROCESS_NOT_BY_THIS_OWNER',
      },
    });
  });

  it('names the one human disposition owner Privacy supplied and asks for the exact owner Action to be confirmed', () => {
    expect(
      openObligationOf(pending, {
        REQUEST_DECISION_INTENT: owner('FICTIONAL-human-owner'),
        TYPE_LANGUAGE_TEMPLATE_REVISION: owner('FICTIONAL-human-owner'),
      }),
    ).toMatchObject({
      openObligation: {
        nextStep: 'CONFIRM_EXACT_OWNER_ACTION_BY_AUTHORIZED_HUMAN',
        responsibleOwner: { kind: 'ASSIGNED_HUMAN_OWNER', ownerRef: 'FICTIONAL-human-owner' },
      },
    });
  });

  it('never guesses between different supplied owners or accepts a blank one: it stays unassigned', () => {
    expect(
      humanDispositionOwnerOf({
        REQUEST_DECISION_INTENT: owner('FICTIONAL-owner-a'),
        TYPE_LANGUAGE_TEMPLATE_REVISION: owner('FICTIONAL-owner-b'),
      }),
    ).toBeUndefined();
    expect(humanDispositionOwnerOf({ REQUEST_DECISION_INTENT: owner('   ') })).toBeUndefined();
  });

  it('shows no open obligation once every target is evidenced', () => {
    expect(achieved.status).toBe('ACHIEVED');
    expect(openObligationOf(achieved, {})).toEqual({});
  });

  it('is part of the published receipt shape and survives an encode and decode of it', () => {
    const openObligation = handoffRecordOf(pending);
    const { schema } = PrivacyOwnerExecutionReceiptSchema.fields.openObligation;
    const decoded = Schema.decodeUnknownSync(schema)(Schema.encodeUnknownSync(schema)(openObligation));
    expect(decoded.responsibleOwner.kind).toBe('UNASSIGNED_ESCALATE');
    expect(decoded.remainingContentRefs).toEqual(measureOf().targetContentRefs);
  });
});
