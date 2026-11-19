import { Deferred, DateTime, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { privacyAllowed, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { decideOne, historyOf, intentHistoryOf, targetOf } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import {
  ELAPSED_CALL_LEASE_MS,
  answers,
  crashAfterProviderCall,
  attemptsOf,
  kindOf,
  observationsOf,
  reconcileOnly,
  recoverableType,
  recoveriesOf,
  stepWith,
  stopsOf,
} from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';
import type { World } from '../support/history-world.ts';
import type { ProviderEvidenceCase } from '../../src/domain/handoff/message-handoff.ts';
import { PREPARE_MESSAGE_HANDOFF_LEASE_MS } from '../../src/handoff/handoff-lease.ts';

/** When the labelled step 22 double claims its reconciliation happened: informational only, never an order. */
const OBSERVED_AT = DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 12, 0));

/** A provider call that never answers: nothing completes it, so only the bound of the step ends it. */
const neverAnswers = Effect.flatMap(Deferred.make<never>(), (unanswered) => Deferred.await(unanswered));

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

/**
 * [#1403 review] A provider answer is never lost and never repeated. The adapter double below reconciles a NON-acceptance of its
 * own attempt WHILE it is still running (the probe of the review) and then answers ACCEPTED: exactly one provider call, the
 * accepted answer persisted as truth, and no second attempt, whatever the evaluation order. The labelled step 22 double stands for
 * the reconciliation; no real provider or reconciliation transport exists.
 */
const reconcilingDuringItsOwnCall = (
  world: World,
  callLeaseMs: number,
  answer: () => Effect.Effect<ProviderEvidenceCase>,
) =>
  handoffDouble((message) =>
    Effect.gen(function* duringTheCall() {
      yield* reconcileOnly(
        world,
        message.intentId,
        [
          step22Double.nonAcceptanceProven(targetOf(world, message.intentId, message.attemptId), {
            key: 'reconciled-during-call',
            observedAt: OBSERVED_AT,
          }),
        ],
        callLeaseMs,
      ).pipe(Effect.orDie);
      return yield* answer();
    }),
  );

describe('a provider answer that meets a reconciliation (#1403 review)', () => {
  it.live(
    '[AC-02 R-05 probe] a reconciliation DURING the call does not close its attempt: one call, the accepted answer recorded, never a second attempt',
    () =>
      Effect.gen(function* probe() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = reconcilingDuringItsOwnCall(world, PREPARE_MESSAGE_HANDOFF_LEASE_MS, answers.accepted);
        const { intentId, requestId } = yield* decideOne(world);
        const first = yield* stepWith(world, handoff, intentId);
        expect(first).toMatchObject({ followUp: 'NONE', kind: 'HANDED_OFF' });
        for (let delivery = 0; delivery < 3; delivery += 1) {
          expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        }
        expect(handoff.calls).toHaveLength(1);
        const attempts = yield* attemptsOf(world, intentId);
        expect(attempts.map(({ state }) => state)).toEqual(['ACCEPTED']);
        // the proof of non-acceptance stays beside the provider's own answer: the history says so instead of picking a side
        expect((yield* observationsOf(world, intentId)).map(({ kind }) => kind)).toEqual(['NON_ACCEPTANCE_PROVEN']);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary).toMatchObject({ contradictory: true, status: 'INDETERMINATE' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 R-05] RECONCILIATION_PENDING: while the call may still run the attempt stays PREPARED and is not a basis of a retry',
    () =>
      Effect.gen(function* pending() {
        const world = yield* setup({ types: [recoverableType()] });
        const { intentId } = yield* decideOne(world);
        // the provider call happened and its answer was never recorded: the attempt stays PREPARED
        yield* crashAfterProviderCall(world, handoffDouble(), intentId);
        const [attempt] = yield* attemptsOf(world, intentId);
        expect(attempt?.state).toBe('PREPARED');
        const outcome = yield* reconcileOnly(
          world,
          intentId,
          [
            step22Double.nonAcceptanceProven(targetOf(world, intentId, attempt?.attemptId ?? ''), {
              key: 'r',
              observedAt: OBSERVED_AT,
            }),
          ],
          PREPARE_MESSAGE_HANDOFF_LEASE_MS,
        );
        expect(outcome).toMatchObject({ closedAttempts: 0, pendingAttempts: 1 });
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['PREPARED']);
        // (c) the next delivery never starts attempt 2 while attempt 1 is in flight
        const next = handoffDouble();
        expect(kindOf(yield* stepWith(world, next, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        expect(next.calls).toEqual([]);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        // once the lease has elapsed the same evidence closes it and the SAME intent continues
        const closed = yield* reconcileOnly(world, intentId, [], ELAPSED_CALL_LEASE_MS);
        expect(closed.pendingAttempts).toBe(0);
        expect(closed.closedAttempts).toBe(1);
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 R-05] an ACCEPTED answer that arrives AFTER its attempt was closed is not swallowed: persisted as an acceptance, and nothing is ever sent again',
    () =>
      Effect.gen(function* late() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = reconcilingDuringItsOwnCall(world, ELAPSED_CALL_LEASE_MS, answers.accepted);
        const { intentId, requestId } = yield* decideOne(world);
        const first = yield* stepWith(world, handoff, intentId);
        expect(kindOf(first)).toBe('LATE_ANSWER:ACCEPTANCE_OBSERVED');
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
        expect((yield* observationsOf(world, intentId)).map(({ kind }) => kind).toSorted()).toEqual([
          'ACCEPTANCE_PROVEN',
          'NON_ACCEPTANCE_PROVEN',
        ]);
        for (let delivery = 0; delivery < 3; delivery += 1) {
          expect(kindOf(yield* stepWith(world, handoff, intentId))).toMatch(/^SKIPPED:/u);
        }
        expect(handoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
        const record = yield* intentHistoryOf(world, requestId);
        // the provider's answer and the reconciliation disagree: the headline says so and every later send stays blocked
        expect(record.history.summary).toMatchObject({ contradictory: true, status: 'INDETERMINATE' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'a late answer that proves nothing new (unknown again) is reported, adds no observation and sends nothing',
    () =>
      Effect.gen(function* lateUnknown() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = reconcilingDuringItsOwnCall(world, ELAPSED_CALL_LEASE_MS, answers.unavailable);
        const { intentId } = yield* decideOne(world);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('LATE_ANSWER:NO_NEW_PROOF');
        expect((yield* observationsOf(world, intentId)).map(({ kind }) => kind)).toEqual(['NON_ACCEPTANCE_PROVEN']);
        expect(handoff.calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'the provider call is bounded by the lease: a call that never answers ends as an INDETERMINATE timeout, never a retry',
    () =>
      Effect.gen(function* bounded() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = handoffDouble(() => neverAnswers);
        const { intentId } = yield* decideOne(world);
        const processing = yield* stepWith(world, handoff, intentId, world.types, 50);
        expect(processing).toMatchObject({
          evidence: { outcome: { kind: 'INDETERMINATE', reason: 'timeout' } },
          followUp: 'NONE',
          kind: 'HANDED_OFF',
        });
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        expect(handoff.calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('a proven stop of an intent whose attempts made no request (#1403 review)', () => {
  it.live(
    '[S12 AC-03] attempt 1 UNAVAILABLE(configuration), then Privacy NOT_ALLOWED: final, SUPPRESSED, a stop for the source, never in progress',
    () =>
      Effect.gen(function* stopAfterNoRequest() {
        const world = yield* setup({ types: [recoverableType()] });
        const handoff = handoffDouble(() => Effect.succeed({ kind: 'UNAVAILABLE', reason: 'configuration' } as const));
        const { intentId, requestId } = yield* decideOne(world);
        expect((yield* stepWith(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        expect(yield* stepWith(world, handoff, intentId)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_NOT_ALLOWED', proven: true }],
        });
        // the stop is the intent's own (no attempt may have left), recorded once, and final
        expect(yield* stopsOf(world, intentId)).toMatchObject([{ evaluationSeq: 1, proven: true }]);
        expect(yield* recoveriesOf(world, intentId)).toEqual([]);
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('SKIPPED:ALREADY_STOPPED');
        expect(handoff.calls).toHaveLength(1);
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe('SUPPRESSED');
        const { feed } = yield* historyOf(world, requestId);
        // the source learns a FINAL stop, not work in progress, and the owner's own handoff stop carries the proof
        expect(feed.messages[0]).toMatchObject({ attention: 'FAILURE', status: 'SUPPRESSED' });
        expect(feed.requiredOutcome).not.toBe('IN_PROGRESS');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
