import { describe, expect, it } from 'effect-rstest';

import { historyOfIntent, summarizeIntent, timelineOf } from '../../src/domain/history/timeline.ts';
import type { IntentTimelineFacts } from '../../src/domain/history/timeline.ts';
import type { AttemptState, ObservationKind } from '../../src/domain/history/vocabulary.ts';
import { ATTEMPT_1, ATTEMPT_2, attempt, factsOf, observation, stop } from './support/history-fixtures.ts';

/**
 * [#1402 H-02 H-03 H-04 H-05 H-06 H-07 AC-02 AC-03 AC-04 AC-05 AC-10] The headline of an intent says no more than the facts
 * prove, and a later observation adds a fact without ever removing or rewriting an earlier one.
 */
const statusOf = (facts: IntentTimelineFacts) => summarizeIntent(facts).status;

describe('Truthful message history: request, decision, intent, attempt and observation stay distinct', () => {
  it('[H-03] a suppressed intent is SUPPRESSED and never a provider failure', () => {
    const history = historyOfIntent(factsOf({ intentStatus: 'SUPPRESSED', reason: 'PRIVACY_NOT_ALLOWED' }));
    expect(history.summary.status).toBe('SUPPRESSED');
    expect(history.entries.map(({ kind, status }) => [kind, status])).toEqual([['INTENT_SUPPRESSED', 'SUPPRESSED']]);
    expect(history.entries[0]?.reasonCodes).toEqual(['PRIVACY_NOT_ALLOWED']);
    // no attempt exists, so nothing can read as submitted, accepted or failed
    expect(history.summary).toMatchObject({ deliveryProven: false, providerAccepted: false });
  });

  it('[H-03] a stop at the last handoff is SUPPRESSED too, with its reason categories, and is not a failure', () => {
    const history = historyOfIntent(
      factsOf({ stops: [stop({ categories: ['PRIVACY_NOT_ALLOWED', 'SOURCE_STALE'] })] }),
    );
    expect(history.summary.status).toBe('SUPPRESSED');
    expect(history.entries.map(({ kind }) => kind)).toEqual(['INTENT_PREPARED', 'HANDOFF_STOPPED']);
    expect(history.entries[1]?.reasonCodes).toEqual(['PRIVACY_NOT_ALLOWED', 'SOURCE_STALE']);
  });

  it('[H-04] a prepared intent that no provider was asked about is PREPARED, not accepted', () => {
    const history = historyOfIntent(factsOf({}));
    expect(history.summary).toEqual({
      contradictory: false,
      deliveryProven: false,
      providerAccepted: false,
      status: 'PREPARED',
    });
  });

  it('[H-04] an attempt that began without an answer is PROVIDER_SUBMITTED with an unknown effect', () => {
    expect(statusOf(factsOf({ attempts: [attempt('PREPARED')] }))).toBe('PROVIDER_SUBMITTED');
  });

  it('[H-04 AC-03 AC-10] an accepted submission is PROVIDER_ACCEPTED and stays so without delivery evidence', () => {
    const facts = factsOf({ attempts: [attempt('ACCEPTED')] });
    expect(statusOf(facts)).toBe('PROVIDER_ACCEPTED');
    expect(summarizeIntent(facts).deliveryProven).toBe(false);
  });

  it('[H-04] DELIVERED exists only with a delivery observation, and that observation keeps the earlier acceptance', () => {
    const facts = factsOf({
      attempts: [attempt('ACCEPTED')],
      observations: [observation('DELIVERY_PROVEN', { observed: 10 })],
    });
    const history = historyOfIntent(facts);
    expect(history.summary).toMatchObject({ deliveryProven: true, providerAccepted: true, status: 'DELIVERED' });
    expect(history.entries.map(({ status }) => status)).toEqual([
      'PREPARED',
      'PROVIDER_SUBMITTED',
      'PROVIDER_ACCEPTED',
      'DELIVERED',
    ]);
  });

  it('[H-05 AC-05] a bounce after acceptance is a NEW observation: the headline is FAILED and the acceptance stays', () => {
    const history = historyOfIntent(
      factsOf({
        attempts: [attempt('ACCEPTED')],
        observations: [observation('DELIVERY_FAILED', { failureClass: 'BOUNCED_PERMANENT', observed: 20 })],
      }),
    );
    expect(history.summary).toMatchObject({ deliveryProven: false, providerAccepted: true, status: 'FAILED' });
    const answered = history.entries.find(({ kind }) => kind === 'SUBMISSION_ANSWERED');
    const bounced = history.entries.find(({ kind }) => kind === 'PROVIDER_OBSERVED');
    expect(answered?.status).toBe('PROVIDER_ACCEPTED');
    expect(bounced).toMatchObject({
      observationKind: 'DELIVERY_FAILED',
      reasonCodes: ['BOUNCED_PERMANENT'],
      status: 'FAILED',
    });
  });

  it('[H-06 AC-04] a timeout is INDETERMINATE: not failed, not accepted', () => {
    const history = historyOfIntent(factsOf({ attempts: [attempt('INDETERMINATE', { reason: 'timeout' })] }));
    expect(history.summary).toMatchObject({ providerAccepted: false, status: 'INDETERMINATE' });
    expect(history.entries.at(-1)).toMatchObject({
      reasonCodes: ['timeout'],
      status: 'INDETERMINATE',
      technical: 'ACCEPTANCE_INDETERMINATE',
    });
  });

  it('[H-06] an unavailable provider is INDETERMINATE too, because it does not prove that nothing was accepted', () => {
    expect(statusOf(factsOf({ attempts: [attempt('UNAVAILABLE', { reason: 'provider_unavailable' })] }))).toBe(
      'INDETERMINATE',
    );
  });

  it('[H-03] an explicit provider refusal is a proven FAILED, never an acceptance', () => {
    const summary = summarizeIntent(factsOf({ attempts: [attempt('REJECTED', { reason: 'provider_rejected' })] }));
    expect(summary).toMatchObject({ providerAccepted: false, status: 'FAILED' });
  });

  it('[AC-04] a reconciliation that proved NON-acceptance keeps the indeterminate answer and adds a proven failure', () => {
    const history = historyOfIntent(
      factsOf({
        attempts: [attempt('INDETERMINATE', { reason: 'timeout' })],
        observations: [observation('NON_ACCEPTANCE_PROVEN', { observed: 30 })],
      }),
    );
    expect(history.summary).toMatchObject({ providerAccepted: false, status: 'FAILED' });
    expect(history.entries.map(({ status, technical }) => [status, technical ?? null])).toEqual([
      ['PREPARED', null],
      ['PROVIDER_SUBMITTED', 'SUBMISSION_STARTED'],
      ['INDETERMINATE', 'ACCEPTANCE_INDETERMINATE'],
      ['FAILED', null],
    ]);
  });

  it('[AC-04] a reconciliation that proved acceptance keeps both observations and ends at PROVIDER_ACCEPTED', () => {
    const history = historyOfIntent(
      factsOf({
        attempts: [attempt('INDETERMINATE', { reason: 'transport' })],
        observations: [observation('ACCEPTANCE_PROVEN', { observed: 30 })],
      }),
    );
    expect(history.summary).toMatchObject({ providerAccepted: true, status: 'PROVIDER_ACCEPTED' });
    expect(
      history.entries.filter(({ kind }) => kind === 'SUBMISSION_ANSWERED' || kind === 'PROVIDER_OBSERVED'),
    ).toHaveLength(2);
  });

  it('[AC-04 AC-05] timeout, later acceptance, then a bounce: every fact stays explainable and the head is FAILED after acceptance', () => {
    const history = historyOfIntent(
      factsOf({
        attempts: [attempt('INDETERMINATE')],
        observations: [
          observation('ACCEPTANCE_PROVEN', { observed: 10 }),
          observation('DELIVERY_FAILED', { failureClass: 'BOUNCED_PERMANENT', observed: 20 }),
        ],
      }),
    );
    expect(history.summary).toMatchObject({ providerAccepted: true, status: 'FAILED' });
    expect(history.entries.map(({ status }) => status)).toEqual([
      'PREPARED',
      'PROVIDER_SUBMITTED',
      'INDETERMINATE',
      'PROVIDER_ACCEPTED',
      'FAILED',
    ]);
  });

  it('never claims DELIVERED without a delivery observation, for every combination of answer and evidence', () => {
    const states: readonly AttemptState[] = [
      'ACCEPTED',
      'INDETERMINATE',
      'NOT_ATTEMPTED',
      'PREPARED',
      'REJECTED',
      'UNAVAILABLE',
    ];
    const kinds: readonly ObservationKind[] = [
      'ACCEPTANCE_PROVEN',
      'DELIVERY_FAILED',
      'DELIVERY_PROVEN',
      'NON_ACCEPTANCE_PROVEN',
    ];
    const subsets = Array.from({ length: 2 ** kinds.length }, (_, mask) =>
      kinds.filter((_kind, index) => Math.floor(mask / 2 ** index) % 2 === 1),
    );
    for (const state of states) {
      for (const subset of subsets) {
        const summary = summarizeIntent(
          factsOf({
            attempts: [attempt(state)],
            observations: subset.map((kind, index) =>
              observation(kind, { failureClass: 'BOUNCED_PERMANENT', observed: 10 + index }),
            ),
          }),
        );
        if (summary.status === 'DELIVERED') {
          expect(subset).toContain('DELIVERY_PROVEN');
          expect(summary.contradictory).toBe(false);
        }
        if (summary.status === 'PROVIDER_ACCEPTED' || summary.status === 'DELIVERED') {
          // an acceptance claim always rests on an accepted answer or on a proving observation
          expect(state === 'ACCEPTED' || subset.some((kind) => kind !== 'NON_ACCEPTANCE_PROVEN')).toBe(true);
        }
      }
    }
  });

  it('refuses to pick a side when the evidence contradicts itself: INDETERMINATE and flagged', () => {
    const summary = summarizeIntent(
      factsOf({
        attempts: [attempt('INDETERMINATE')],
        observations: [
          observation('ACCEPTANCE_PROVEN', { observed: 10 }),
          observation('NON_ACCEPTANCE_PROVEN', { observed: 11 }),
        ],
      }),
    );
    expect(summary).toMatchObject({ contradictory: true, deliveryProven: false, status: 'INDETERMINATE' });
    const rejectedButDelivered = summarizeIntent(
      factsOf({ attempts: [attempt('REJECTED')], observations: [observation('DELIVERY_PROVEN', { observed: 10 })] }),
    );
    expect(rejectedButDelivered).toMatchObject({ contradictory: true, deliveryProven: false, status: 'INDETERMINATE' });
  });

  it('[0..N] keeps several attempts of one intent as separate facts: an unattempted first one never blocks the next', () => {
    const facts = factsOf({
      attempts: [
        attempt('NOT_ATTEMPTED', { number: 1 }),
        attempt('ACCEPTED', { id: ATTEMPT_2, number: 2, prepared: 5 }),
      ],
    });
    const history = historyOfIntent(facts);
    expect(history.summary.status).toBe('PROVIDER_ACCEPTED');
    expect(
      history.entries.filter(({ kind }) => kind === 'ATTEMPT_PREPARED').map(({ attemptNumber }) => attemptNumber),
    ).toEqual([1, 2]);
  });
});

describe('Late, duplicate and out-of-order observations keep one explicit, deterministic timeline', () => {
  it('orders by the explicit key and gives the same timeline whatever order the facts arrive in', () => {
    const accepted = observation('ACCEPTANCE_PROVEN', { observed: 5, recorded: 40 });
    const delivered = observation('DELIVERY_PROVEN', { observed: 9, recorded: 41 });
    const facts = factsOf({ attempts: [attempt('INDETERMINATE')], observations: [accepted, delivered] });
    const reversed = factsOf({ attempts: [attempt('INDETERMINATE')], observations: [delivered, accepted] });
    expect(timelineOf(reversed)).toEqual(timelineOf(facts));
    expect(timelineOf(facts).map(({ observationKind }) => observationKind ?? null)).toEqual([
      null,
      null,
      null,
      'ACCEPTANCE_PROVEN',
      'DELIVERY_PROVEN',
    ]);
  });

  it('[H-07] marks an observation that was RECORDED after a later one as out of order, without moving or dropping any', () => {
    const bounce = observation('DELIVERY_FAILED', { failureClass: 'BOUNCED_PERMANENT', observed: 30, recorded: 31 });
    const lateAcceptance = observation('ACCEPTANCE_PROVEN', { observed: 10, recorded: 50 });
    const entries = timelineOf(
      factsOf({ attempts: [attempt('INDETERMINATE')], observations: [bounce, lateAcceptance] }),
    ).filter(({ kind }) => kind === 'PROVIDER_OBSERVED');
    expect(entries.map(({ observationKind, outOfOrder }) => [observationKind, outOfOrder])).toEqual([
      ['ACCEPTANCE_PROVEN', true],
      ['DELIVERY_FAILED', false],
    ]);
    // the late acceptance explains the bounce; it does not turn the head into an acceptance
    expect(statusOf(factsOf({ attempts: [attempt('INDETERMINATE')], observations: [bounce, lateAcceptance] }))).toBe(
      'FAILED',
    );
  });

  it('never orders a provider observation before the attempt it observes was prepared, and keeps the claim as claimed', () => {
    const early = observation('ACCEPTANCE_PROVEN', { observed: 0 });
    const entry = timelineOf(
      factsOf({ attempts: [attempt('INDETERMINATE', { finished: 6, prepared: 5 })], observations: [early] }),
    ).find(({ kind }) => kind === 'PROVIDER_OBSERVED');
    expect(entry?.occurredAt.epochMilliseconds).toBe(early.observedAt.epochMilliseconds);
    expect(entry?.orderedAt.epochMilliseconds).toBeGreaterThan(entry?.occurredAt.epochMilliseconds ?? 0);
  });

  it('keeps an observation of another attempt apart: it never changes the answer of its sibling', () => {
    const facts = factsOf({
      attempts: [
        attempt('NOT_ATTEMPTED', { number: 1 }),
        attempt('INDETERMINATE', { id: ATTEMPT_2, number: 2, prepared: 5 }),
      ],
      observations: [observation('NON_ACCEPTANCE_PROVEN', { attemptId: ATTEMPT_2, observed: 9 })],
    });
    expect(statusOf(facts)).toBe('FAILED');
    expect(
      statusOf(
        factsOf({
          attempts: [
            attempt('NOT_ATTEMPTED', { number: 1 }),
            attempt('INDETERMINATE', { id: ATTEMPT_2, number: 2, prepared: 5 }),
          ],
          observations: [observation('NON_ACCEPTANCE_PROVEN', { attemptId: ATTEMPT_1, observed: 9 })],
        }),
      ),
    ).toBe('INDETERMINATE');
  });
});
