import { DateTime, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { decideOne, historyOf, ingest, targetOf } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { attemptsOf, stepWith } from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';
import type { ObservationDetails } from '../support/step22-observation-double.ts';

/**
 * [#1396 BR-10 D.5, BDD "Provider eviduje blokovaný kontakt"] A provider block of the ORIGINAL endpoint stops the message with its
 * own reason, read from the stored provider observations of an earlier message to the same endpoint. It is a provider fact and
 * never a Privacy one, an unrelated endpoint is unaffected, and a later proven delivery to the endpoint lifts it. The observations
 * come from the labelled step 22 double: no provider or bounce transport exists in this lane.
 */
const setup = (recipients: readonly string[]) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, { recipients })));

const OBSERVED_AT = DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 12, 0));
const details = (key: string): ObservationDetails => ({ key, observedAt: OBSERVED_AT });

/** A message to `recipient` of one occurrence, handed off (accepted); its identities and the attempt it made. */
const handedOff = Effect.fn('ProviderSuppressionTest.handedOff')(function* send(
  world: World,
  recipient: string,
  occurrenceId: string,
) {
  const { intentId, requestId } = yield* decideOne(world, recipient, occurrenceId);
  const processing = yield* stepWith(world, handoffDouble(), intentId);
  expect(processing.kind).toBe('HANDED_OFF');
  const [attempt] = yield* attemptsOf(world, intentId);
  if (attempt === undefined) {
    return yield* Effect.die('the handed-off intent has no attempt');
  }
  return { intentId, requestId, target: targetOf(world, intentId, attempt.attemptId) };
});

const nextMessage = Effect.fn('ProviderSuppressionTest.nextMessage')(function* next(
  world: World,
  recipient: string,
  occurrenceId: string,
) {
  const handoff = handoffDouble();
  const { intentId, requestId } = yield* decideOne(world, recipient, occurrenceId);
  return { handoff, intentId, processing: yield* stepWith(world, handoff, intentId), requestId };
});

const stoppedAsProviderBounce = {
  kind: 'STOPPED',
  reasons: [{ category: 'PROVIDER_SUPPRESSED', cause: 'PROVIDER_BOUNCED', proven: true }],
} as const;

describe('a provider block of the original endpoint is fed into the last stoppable handoff (T3-01)', () => {
  it.live(
    'an earlier permanent bounce of the same endpoint stops the next message with the provider reason; an unrelated endpoint stays clear',
    () =>
      Effect.gen(function* blockedEndpoint() {
        const world = yield* setup(['customer-1', 'customer-2']);
        const first = yield* handedOff(world, 'customer-1', 'occurrence-1');
        yield* ingest(world, step22Double.bounced(first.target, details('bounce-1')));

        const blocked = yield* nextMessage(world, 'customer-1', 'occurrence-2');
        expect(blocked.processing).toMatchObject(stoppedAsProviderBounce);
        expect(blocked.handoff.calls).toHaveLength(0);
        // a provider suppression is never a Privacy NOT_ALLOWED, and the source learns the concrete reason
        const { feed } = yield* historyOf(world, blocked.requestId);
        expect(feed.messages[0]).toMatchObject({ reason: 'PROVIDER_SUPPRESSED', status: 'SUPPRESSED' });

        const unrelated = yield* nextMessage(world, 'customer-2', 'occurrence-3');
        expect(unrelated.processing.kind).toBe('HANDED_OFF');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'only the LATEST conclusive evidence counts: a later proven delivery to the endpoint lifts an earlier bounce, a later bounce restores it',
    () =>
      Effect.gen(function* latestEvidenceWins() {
        const world = yield* setup(['customer-1']);
        const first = yield* handedOff(world, 'customer-1', 'occurrence-1');
        const second = yield* handedOff(world, 'customer-1', 'occurrence-2');
        const third = yield* handedOff(world, 'customer-1', 'occurrence-3');
        // delivery first, bounce after: the latest conclusive fact is the bounce
        yield* ingest(world, step22Double.delivered(second.target, details('delivered-2')));
        yield* ingest(world, step22Double.bounced(first.target, details('bounce-1')));
        expect((yield* nextMessage(world, 'customer-1', 'occurrence-4')).processing).toMatchObject(
          stoppedAsProviderBounce,
        );
        // a delivery to the same endpoint after the bounce: the endpoint works, so nothing is held for it
        yield* ingest(world, step22Double.delivered(third.target, details('delivered-3')));
        expect((yield* nextMessage(world, 'customer-1', 'occurrence-5')).processing.kind).toBe('HANDED_OFF');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('a transient bounce is no block: only a permanent bounce is read as provider suppression', () =>
    Effect.gen(function* transientBounce() {
      const world = yield* setup(['customer-1']);
      const first = yield* handedOff(world, 'customer-1', 'occurrence-1');
      yield* ingest(world, step22Double.bounced(first.target, details('soft-bounce-1'), 'BOUNCED_TRANSIENT'));
      expect((yield* nextMessage(world, 'customer-1', 'occurrence-2')).processing.kind).toBe('HANDED_OFF');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
