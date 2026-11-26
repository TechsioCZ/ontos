import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { historyOfIntent } from '../../src/domain/history/timeline.ts';
import { sourceOutcomeFeedOf } from '../../src/domain/history/source-outcome.ts';
import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../shared/communication-intake.ts';
import { HistorySlotKeySchema } from '../../shared/communication-history.ts';
import {
  ATTEMPT_1,
  ATTEMPT_2,
  INTENT_ID,
  attempt,
  conflict,
  factsOf,
  observation,
  recovery,
  stop,
} from './support/history-fixtures.ts';

/**
 * [#1403 AC-03 AC-09 R-10] What the recovery decided is visible to the source through the EXISTING outcome vocabulary: a proven
 * failure with a concrete reason, a stop that proves nothing as a re-evaluation, a settled conflict as no longer needing
 * reconciliation. Nothing is rewritten: every earlier fact stays in the timeline.
 */
/** Neither the decision nor the intent carries a reason of its own here: what the feed says comes from the recovery. */
const decisionReason = Option.getOrUndefined(Option.none<string>());
const decodeRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema);

/** The source feed of one request with one intent, which is REQUIRED unless a test says otherwise. */
const feedOf = (facts: ReturnType<typeof factsOf>, requiredness: 'OPTIONAL' | 'REQUIRED' = 'REQUIRED') =>
  sourceOutcomeFeedOf({
    decision: {
      decisionId: CommunicationDecisionIdSchema.make('44444444-4444-4444-8444-444444444444'),
      noMessageReason: decisionReason,
      outcome: 'MESSAGE_INTENTS',
      requiredness,
      unresolvedSlots: [],
    },
    intents: [
      {
        intentId: MessageIntentIdSchema.make(INTENT_ID),
        reason: decisionReason,
        recipientRef: decodeRef({
          moduleId: 'fixture.party',
          resourceId: 'customer-1',
          resourceType: 'fixture.customer',
        }),
        slotKey: HistorySlotKeySchema.make('primary'),
        summary: historyOfIntent(facts).summary,
      },
    ],
    requestId: CommunicationRequestIdSchema.make('55555555-5555-4555-8555-555555555555'),
  });

describe('a provider refusal whose recovery did not continue is reported with its concrete reason', () => {
  const refused = attempt('REJECTED', { reason: 'rate_limited' });

  it("[S03 AC-07] NO_RECOVERY_RULE: a proven failure that requires the source owner's decision, never a retry loop", () => {
    const facts = factsOf({ attempts: [refused], recoveries: [recovery({ code: 'NO_RECOVERY_RULE' })] });
    const { summary } = historyOfIntent(facts);
    expect(summary.status).toBe('FAILED');
    expect(summary.recovery).toMatchObject({ code: 'NO_RECOVERY_RULE', outcome: 'HALTED' });
    expect(feedOf(facts)).toMatchObject({
      messages: [{ attention: 'FAILURE', reason: 'NO_RECOVERY_RULE', status: 'FAILED' }],
      requiredOutcome: 'FAILED',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('[R-10] a PROVEN stop of the recovery is a failure with the reason that stopped it', () => {
    const facts = factsOf({
      attempts: [refused],
      recoveries: [recovery({ code: 'PRIVACY_NOT_ALLOWED', outcome: 'STOPPED', proven: true })],
    });
    expect(feedOf(facts).messages[0]).toMatchObject({
      attention: 'FAILURE',
      reason: 'PRIVACY_NOT_ALLOWED',
      status: 'FAILED',
    });
  });

  it('a stop that only could not establish a fact proves nothing against the message: it is re-evaluated, not a final failure', () => {
    const facts = factsOf({
      attempts: [refused],
      recoveries: [recovery({ code: 'PRIVACY_AUTHORITY_UNAVAILABLE', outcome: 'STOPPED', proven: false })],
    });
    const feed = feedOf(facts);
    expect(feed.messages[0]).toMatchObject({
      attention: 'NEEDS_REEVALUATION',
      reason: 'PRIVACY_AUTHORITY_UNAVAILABLE',
    });
    expect(feed.requiredOutcome).toBe('NEEDS_REEVALUATION');
  });

  it('an evaluation about an EARLIER attempt is superseded by the later attempt it concerned', () => {
    const facts = factsOf({
      attempts: [refused, attempt('ACCEPTED', { id: ATTEMPT_2, number: 2, prepared: 6 })],
      recoveries: [recovery({ attemptId: ATTEMPT_1, code: 'NO_RECOVERY_RULE' })],
    });
    expect(historyOfIntent(facts).summary.recovery).toBeUndefined();
    expect(feedOf(facts).messages[0]).toMatchObject({ attention: 'NO_FAILURE', status: 'PROVIDER_ACCEPTED' });
  });
});

describe('a conflict of provider evidence is settled by an appended resolution, never by removing it', () => {
  const accepted = observation('ACCEPTANCE_PROVEN', { observed: 3 });

  it('[S06] an unresolved conflict needs reconciliation; a resolved one keeps its trace and no longer does', () => {
    const open = factsOf({
      attempts: [attempt('ACCEPTED')],
      conflicts: [conflict('ACCEPTANCE_PROVEN', { observationId: accepted.observationId, observed: 4 })],
      observations: [accepted],
    });
    const settled = factsOf({
      attempts: [attempt('ACCEPTED')],
      conflicts: [conflict('ACCEPTANCE_PROVEN', { observationId: accepted.observationId, observed: 4, resolved: 9 })],
      observations: [accepted],
    });
    expect(historyOfIntent(open).summary.needsReconciliation).toBe(true);
    expect(historyOfIntent(settled).summary.needsReconciliation).toBe(false);
    // both keep the trace of the disagreement in the timeline
    expect(historyOfIntent(open).entries.filter(({ kind }) => kind === 'OBSERVATION_CONFLICTED')).toHaveLength(1);
    expect(historyOfIntent(settled).entries.filter(({ kind }) => kind === 'OBSERVATION_CONFLICTED')).toHaveLength(1);
  });
});

describe('a stop is superseded only by a LATER attempt that the Current evaluation cleared', () => {
  it('[F3] an unproven stop followed by a cleared attempt that submitted nothing no longer holds the message', () => {
    const stillHeld = factsOf({ stops: [stop({ at: 1, proven: false })] });
    expect(historyOfIntent(stillHeld).summary.status).toBe('HELD_UNPROVEN');
    const superseded = factsOf({
      attempts: [attempt('NOT_ATTEMPTED', { prepared: 5 })],
      stops: [stop({ at: 1, proven: false })],
    });
    expect(historyOfIntent(superseded).summary.status).toBe('PREPARED');
    // a stop recorded after the attempt stays current
    const later = factsOf({
      attempts: [attempt('NOT_ATTEMPTED', { prepared: 1 })],
      stops: [stop({ at: 5, proven: false, seq: 2 })],
    });
    expect(historyOfIntent(later).summary.status).toBe('HELD_UNPROVEN');
  });
});
