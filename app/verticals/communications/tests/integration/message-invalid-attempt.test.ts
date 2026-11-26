import { DateTime, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { decideOne, historyOf, intentHistoryOf, targetOf } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import {
  attemptsOf,
  kindOf,
  observationsOf,
  reconcileOnly,
  recoverableType,
  recoveriesOf,
  stepWith,
} from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

/**
 * [#1402 T3-11, #1403] A message the Messaging Adapter PROVED malformed (the provider was never asked) is stored as the certain
 * failure it is, not as an unknown effect. The handoff contract carries the proof; the worker never guesses it. Native
 * PostgreSQL through the real scoped routines; the adapter is a labelled double.
 */
const invalid = () =>
  Effect.succeed({
    field: 'to',
    kind: 'MESSAGE_INVALID',
    proof: 'PROVIDER_NOT_ASKED',
    reason: 'invalid_format',
  } as const);

describe('a message the adapter proved malformed (#1402 T3-11)', () => {
  it.live(
    'is stored as MESSAGE_INVALID, reads as a proven FAILED with its own evidence, awaits no reconciliation and is never retried',
    () =>
      Effect.gen(function* certainFailure() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = handoffDouble(invalid);
        const { intentId, requestId } = yield* decideOne(world);
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          evidence: { outcome: { kind: 'MESSAGE_INVALID', proof: 'PROVIDER_NOT_ASKED' } },
          followUp: 'NONE',
          kind: 'HANDED_OFF',
        });
        const [attempt] = yield* attemptsOf(world, intentId);
        expect(attempt).toMatchObject({ attemptNumber: 1, state: 'MESSAGE_INVALID' });
        expect(attempt?.evidence).toMatchObject({ field: 'to', reason: 'invalid_format' });
        // never INDETERMINATE: the history says what is certain
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ status: 'FAILED' });
        expect(record.history.summary.status).not.toBe('INDETERMINATE');
        // the public history schema advertises this technical evidence, and now a stored attempt can really produce it
        expect(record.history.entries.find(({ kind }) => kind === 'SUBMISSION_ANSWERED')).toMatchObject({
          reasonCodes: ['invalid_format'],
          status: 'FAILED',
          technical: 'MESSAGE_INVALID',
        });
        expect((yield* historyOf(world, requestId)).feed.messages).toMatchObject([
          { attention: 'FAILURE', status: 'FAILED' },
        ]);
        // every later delivery is only an evaluation: no reconciliation is awaited, nothing is sent again, the halt is recorded once
        for (let delivery = 0; delivery < 3; delivery += 1) {
          expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HALTED:MESSAGE_INVALID');
        }
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { code: 'MESSAGE_INVALID', evaluationSeq: 1, outcome: 'HALTED', proven: false },
        ]);
        const { feed } = yield* historyOf(world, requestId);
        expect(feed.messages).toMatchObject([{ attention: 'FAILURE', reason: 'MESSAGE_INVALID', status: 'FAILED' }]);
        expect(feed.sourceImpact).toBe('SOURCE_OWNER_DECIDES');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('has nothing to observe: a provider observation of it is NOT_SUBMITTED, never a contradiction', () =>
    Effect.gen(function* nothingToObserve() {
      const world = yield* setup({ types: [recoverableType()] });
      const handoff = handoffDouble(invalid);
      const { intentId } = yield* decideOne(world);
      yield* stepWith(world, handoff, intentId);
      const [attempt] = yield* attemptsOf(world, intentId);
      const outcome = yield* reconcileOnly(world, intentId, [
        step22Double.acceptanceProven(
          targetOf(world, intentId, attempt?.attemptId ?? ''),
          { key: 'late', observedAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 10, 0)) },
          'PROVIDER_EVENT',
        ),
      ]);
      expect(outcome.answers).toEqual(['NOT_SUBMITTED']);
      expect(yield* observationsOf(world, intentId)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'is never stored on a guess: an answer without the proof is an unreadable one, so it stays INDETERMINATE',
    () =>
      Effect.gen(function* withoutProof() {
        const world = yield* setup({ types: [recoverableType()] });
        // what a careless adapter could return at runtime: a malformed-message answer that does not state the proof
        const unreadable = JSON.parse('{"field":"to","kind":"MESSAGE_INVALID","reason":"invalid_format"}');
        const guess = handoffDouble(() => Effect.succeed(unreadable));
        const { intentId } = yield* decideOne(world);
        expect(yield* stepWith(world, guess, intentId)).toMatchObject({
          evidence: { outcome: { kind: 'INDETERMINATE', reason: 'response_invalid' } },
          kind: 'HANDED_OFF',
        });
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
        expect(kindOf(yield* stepWith(world, guess, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        expect(guess.calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
