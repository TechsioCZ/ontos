import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { projectMessageHistoryItem } from '../../src/history/message-history-projection.ts';
import { intentRecord, requestRecord } from './support/access-fixtures.ts';
import { ATTEMPT_2, attempt, conflict, factsOf, observation, recovery, stop } from './support/history-fixtures.ts';
import type { IntentTimelineFacts } from '../../src/domain/history/timeline.ts';

/**
 * [#1409 x #1403] The safe history Read and the owner's source outcome feed derive the headline of a message ONCE
 * (`messageHeadlineOf`), so what the Read shows is what the source is told: the same status, the same attention and the feed's
 * concrete reason, as closed codes only. The merge of the access lane and the retry lane must never leave two derivations.
 */
const readAndFeed = (facts: IntentTimelineFacts) =>
  Effect.gen(function* readAndFeedOf() {
    const intent = intentRecord({ facts });
    const request = requestRecord([intent]);
    const item = yield* projectMessageHistoryItem(request, intent, { includeEndpointMask: true });
    const [outcome] = request.feed.messages;
    if (outcome === undefined) {
      return yield* Effect.die('the feed of one intent has one message');
    }
    return { item, outcome };
  });

const expectAgreement = (
  { item, outcome }: Effect.Success<ReturnType<typeof readAndFeed>>,
  expected: { readonly attention: string; readonly status: string },
) => {
  expect(item.headline.attention).toBe(outcome.attention);
  expect(item.headline.status).toBe(outcome.status);
  expect(item.headline).toMatchObject(expected);
  // the feed's single reason is one of the closed reasons the Read lists, never something else
  if (outcome.reason !== undefined) {
    expect(item.headline.reasonCodes).toContain(outcome.reason);
  }
};

describe('the history Read and the source outcome feed agree on every recovery fact', () => {
  it.effect('[proven stop] a proven stop of the handoff is a failure with its reason, in both', () =>
    Effect.gen(function* provenStop() {
      const both = yield* readAndFeed(factsOf({ stops: [stop({ proven: true })] }));
      expectAgreement(both, { attention: 'FAILURE', status: 'SUPPRESSED' });
      expect(both.item.headline.reasonCodes).toEqual(['PRIVACY_NOT_ALLOWED']);
    }),
  );

  it.effect('[proven stop] a proven stop of the RECOVERY keeps the failure and names the concrete reason', () =>
    Effect.gen(function* provenRecoveryStop() {
      const both = yield* readAndFeed(
        factsOf({
          attempts: [attempt('REJECTED', { reason: 'rate_limited' })],
          recoveries: [recovery({ code: 'PRIVACY_NOT_ALLOWED', outcome: 'STOPPED', proven: true })],
        }),
      );
      expectAgreement(both, { attention: 'FAILURE', status: 'FAILED' });
      expect(both.outcome.reason).toBe('PRIVACY_NOT_ALLOWED');
      expect(both.item.headline.reasonCodes).toEqual(['PRIVACY_NOT_ALLOWED']);
    }),
  );

  it.effect('[unproven stop] a stop that proved nothing needs a re-evaluation, in both', () =>
    Effect.gen(function* unprovenStop() {
      const held = yield* readAndFeed(factsOf({ stops: [stop({ proven: false })] }));
      expectAgreement(held, { attention: 'NEEDS_REEVALUATION', status: 'HELD_UNPROVEN' });
      // the stop of a RECOVERY that only could not establish a fact: the status stays FAILED, the attention is the re-evaluation
      const stopped = yield* readAndFeed(
        factsOf({
          attempts: [attempt('REJECTED', { reason: 'rate_limited' })],
          recoveries: [recovery({ code: 'PRIVACY_AUTHORITY_UNAVAILABLE', outcome: 'STOPPED', proven: false })],
        }),
      );
      expectAgreement(stopped, { attention: 'NEEDS_REEVALUATION', status: 'FAILED' });
      expect(stopped.outcome.reason).toBe('PRIVACY_AUTHORITY_UNAVAILABLE');
    }),
  );

  it.effect(
    '[retry due] a provable refusal is a failure until the next attempt begins, which then is only unknown',
    () =>
      Effect.gen(function* retryDue() {
        const refused = attempt('REJECTED', { reason: 'rate_limited' });
        expectAgreement(yield* readAndFeed(factsOf({ attempts: [refused] })), {
          attention: 'FAILURE',
          status: 'FAILED',
        });
        const halted = yield* readAndFeed(
          factsOf({ attempts: [refused], recoveries: [recovery({ code: 'RECOVERY_LIMIT_REACHED' })] }),
        );
        expectAgreement(halted, { attention: 'FAILURE', status: 'FAILED' });
        expect(halted.item.headline.reasonCodes).toEqual(['RECOVERY_LIMIT_REACHED']);
        // the retry attempt began and has no answer yet: the effect of the intent is unknown, never "in progress"
        const retrying = yield* readAndFeed(
          factsOf({
            attempts: [refused, attempt('PREPARED', { id: ATTEMPT_2, number: 2, prepared: 6 })],
            recoveries: [recovery()],
          }),
        );
        expectAgreement(retrying, { attention: 'UNKNOWN', status: 'PROVIDER_SUBMITTED' });
        // an earlier evaluation about the earlier attempt is superseded, in both
        expect(retrying.item.headline.reasonCodes).toEqual([]);
        expect(retrying.outcome.reason).toBeUndefined();
      }),
  );

  it.effect('[reconciliation pending] disagreeing provider evidence asks for a reconciliation, in both', () =>
    Effect.gen(function* reconciliationPending() {
      const accepted = observation('ACCEPTANCE_PROVEN', { observed: 3 });
      const open = yield* readAndFeed(
        factsOf({
          attempts: [attempt('ACCEPTED')],
          conflicts: [conflict('ACCEPTANCE_PROVEN', { observationId: accepted.observationId, observed: 4 })],
          observations: [accepted],
        }),
      );
      expectAgreement(open, { attention: 'NEEDS_RECONCILIATION', status: 'PROVIDER_ACCEPTED' });
      expect(open.item.headline.needsReconciliation).toBe(true);
      const settled = yield* readAndFeed(
        factsOf({
          attempts: [attempt('ACCEPTED')],
          conflicts: [
            conflict('ACCEPTANCE_PROVEN', { observationId: accepted.observationId, observed: 4, resolved: 9 }),
          ],
          observations: [accepted],
        }),
      );
      expectAgreement(settled, { attention: 'NO_FAILURE', status: 'PROVIDER_ACCEPTED' });
      expect(settled.item.headline.needsReconciliation).toBe(false);
    }),
  );

  it.effect('[late acceptance] a refusal contradicted by a later acceptance is unknown, never a failure, in both', () =>
    Effect.gen(function* lateAcceptance() {
      const both = yield* readAndFeed(
        factsOf({
          attempts: [attempt('REJECTED', { reason: 'rate_limited' })],
          observations: [observation('ACCEPTANCE_PROVEN', { observed: 9 })],
        }),
      );
      expectAgreement(both, { attention: 'UNKNOWN', status: 'INDETERMINATE' });
      expect(both.item.headline).toMatchObject({ contradictory: true, deliveryProven: false });
    }),
  );
});
