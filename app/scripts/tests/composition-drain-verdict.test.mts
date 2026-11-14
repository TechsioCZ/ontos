/**
 * The operator's pre-flight verdict and the publisher's give-up message must say what really happens in each
 * authority phase, because an operator acts on them before or during a deploy.
 */
import { Effect, Fiber, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { publicationVerdict } from '../../packages/core-runtime/src/outbox/drain-preflight.ts';
import type { PublicationVerdictInput } from '../../packages/core-runtime/src/outbox/drain-preflight.ts';
import { describeUndrainableOutboxWork } from '../../packages/core-runtime/src/outbox/undrainable-work.ts';
import type { UndrainableOutboxDelivery } from '../../packages/core-runtime/src/outbox/undrainable-work.ts';
import {
  abandonedTransitionMessage,
  drainWindow,
  remainingInDrainWindow,
  retryWhileLockNotAvailable,
  waitUntilOutboxDrained,
} from '../application-composition-authority-publication.mts';
import type { DrainPoll } from '../application-composition-authority-publication.mts';

const noBlockers = { deliveries: 0, durable: 0, unmatched: 0 } as const;
const quiet = {
  deliveriesRefused: 0,
  drainBlockers: noBlockers,
  phase: 'active',
  stalledMessages: 0,
  unmatched: 0,
} as const satisfies PublicationVerdictInput;

describe('composition drain pre-flight verdict', () => {
  it('starts the drain on an active authority with nothing that cannot drain', () => {
    expect(publicationVerdict(quiet)).toMatchObject({ proceeds: true });
  });

  it('does not refuse a freshly written unmatched message, which the running matcher takes', () => {
    // The publisher waits for the running matcher before the fence; only a message unmatched for a whole budget
    // refuses the drain.
    const fresh = publicationVerdict({ ...quiet, unmatched: 3 });
    expect(fresh.proceeds).toBe(true);
    expect(fresh.line).toContain('waits for the running matcher');
    expect(publicationVerdict({ ...quiet, stalledMessages: 1, unmatched: 3 })).toMatchObject({ proceeds: false });
  });

  it('refuses on an active authority when the pre-flight would refuse a delivery', () => {
    const verdict = publicationVerdict({ ...quiet, deliveriesRefused: 2 });
    expect(verdict.proceeds).toBe(false);
    expect(verdict.line).toContain('2 delivery(ies) would be refused');
  });

  it('asks the migrated promotion exactly what requireDrainedWork blocks on', () => {
    // The pre-flight subset is empty, yet a migrated promotion still blocks on each of these.
    for (const blocker of [
      { ...noBlockers, deliveries: 1 },
      { ...noBlockers, durable: 1 },
      { ...noBlockers, unmatched: 1 },
    ]) {
      const verdict = publicationVerdict({ ...quiet, drainBlockers: blocker, phase: 'migrated' });
      expect(verdict.proceeds).toBe(false);
      expect(verdict.line).toContain('promote without a drain');
    }
    expect(publicationVerdict({ ...quiet, phase: 'migrated' }).proceeds).toBe(true);
  });

  it('never answers yes for a draining or sealed authority', () => {
    expect(publicationVerdict({ ...quiet, phase: 'draining' })).toMatchObject({ proceeds: false });
    expect(publicationVerdict({ ...quiet, phase: 'draining' }).line).toContain('already refuses reads');
    expect(publicationVerdict({ ...quiet, phase: 'sealed' })).toMatchObject({ proceeds: false });
  });
});

describe('abandoned drained transition message', () => {
  it('leaves the outcome to the restore that follows when the transition began on an active or draining authority', () => {
    // The publisher then returns that authority to active and appends what happened; this message must not
    // claim an outcome of its own.
    for (const phase of ['active', 'draining'] as const) {
      const message = abandonedTransitionMessage(phase);
      expect(message).toContain('re-drains, so the Application Composition transition was abandoned');
      expect(message).not.toContain('left in draining');
    }
  });

  it('does not claim a migrated authority was left in draining', () => {
    const message = abandonedTransitionMessage('migrated');
    expect(message).not.toContain('draining');
    expect(message).toContain('stays migrated');
  });
});

/** A refusal carrying a PostgreSQL SQLSTATE, the shape the restore's failure finder reads. */
class SqlStateRefusal extends Schema.TaggedError<SqlStateRefusal>()('SqlStateRefusal', { code: Schema.String }) {}

const LOCK_NOT_AVAILABLE = new SqlStateRefusal({ code: '55P03' });

/** A restore that is refused `refusals` times with `refusal`, then succeeds; counts its attempts. */
const refusedRestore = (
  attempts: Ref.Ref<number>,
  options: { readonly refusal: SqlStateRefusal; readonly refusals: number },
) =>
  Ref.updateAndGet(attempts, (count) => count + 1).pipe(
    Effect.flatMap((attempt) =>
      attempt <= options.refusals ? Effect.fail(options.refusal) : Effect.succeed('restored'),
    ),
  );

describe('restore of a draining authority while a lock is busy', () => {
  it.effect('tries the restore again while it only waited for a lock, and then restores', () =>
    Effect.gen(function* retriesBusyLock() {
      const attempts = yield* Ref.make(0);
      const restore = yield* retryWhileLockNotAvailable(
        refusedRestore(attempts, { refusal: LOCK_NOT_AVAILABLE, refusals: 2 }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust('1 minute');
      expect(yield* Fiber.join(restore)).toBe('restored');
      expect(yield* Ref.get(attempts)).toBe(3);
    }),
  );

  it.effect('gives up after a bounded number of attempts and still reports the lock refusal', () =>
    Effect.gen(function* boundsBusyLock() {
      const attempts = yield* Ref.make(0);
      const restore = yield* retryWhileLockNotAvailable(
        refusedRestore(attempts, { refusal: LOCK_NOT_AVAILABLE, refusals: 100 }),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust('10 minutes');
      expect(yield* Fiber.join(restore)).toBe(LOCK_NOT_AVAILABLE);
      expect(yield* Ref.get(attempts)).toBe(5);
    }),
  );

  it.effect('does not retry any other refusal', () =>
    Effect.gen(function* refusesOnce() {
      const attempts = yield* Ref.make(0);
      const unique = new SqlStateRefusal({ code: '23505' });
      const failure = yield* retryWhileLockNotAvailable(
        refusedRestore(attempts, { refusal: unique, refusals: 1 }),
      ).pipe(Effect.flip);
      expect(failure).toBe(unique);
      expect(yield* Ref.get(attempts)).toBe(1);
    }),
  );
});

const IN_FLIGHT: DrainPoll = { drained: false, refusals: [] };
const DRAINED: DrainPoll = { drained: true, refusals: [] };
const DIED: DrainPoll = { drained: false, refusals: ['Outbox work that this drain could never finish: dead: …'] };

/** A drain whose polls answer `answers` in order, the last one forever; counts the polls. */
const scriptedPoll = (polls: Ref.Ref<number>, answers: readonly DrainPoll[]) =>
  Ref.updateAndGet(polls, (count) => count + 1).pipe(
    Effect.map((poll) => answers[Math.min(poll, answers.length) - 1] ?? DRAINED),
  );

describe('Outbox drain wait', () => {
  it.effect('ends at once with the refusal when outstanding work can never finish', () =>
    Effect.gen(function* stopsAtOnce() {
      const polls = yield* Ref.make(0);
      const failure = yield* waitUntilOutboxDrained(scriptedPoll(polls, [DIED])).pipe(Effect.flip);
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(failure.reason).toContain('The Application Composition drain was stopped');
      expect(failure.reason).toContain('dead: …');
      expect(yield* Ref.get(polls)).toBe(1);
    }),
  );

  it.effect('stops on the first poll after work became undrainable mid-drain', () =>
    Effect.gen(function* stopsMidDrain() {
      const polls = yield* Ref.make(0);
      const wait = yield* waitUntilOutboxDrained(scriptedPoll(polls, [IN_FLIGHT, IN_FLIGHT, DIED])).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('10 minutes');
      expect((yield* Fiber.join(wait)).reason).toContain('The Application Composition drain was stopped');
      expect(yield* Ref.get(polls)).toBe(3);
    }),
  );

  it.effect('keeps waiting for work that is merely in flight', () =>
    Effect.gen(function* waitsForDrainable() {
      const polls = yield* Ref.make(0);
      const wait = yield* waitUntilOutboxDrained(scriptedPoll(polls, [IN_FLIGHT, IN_FLIGHT, IN_FLIGHT, DRAINED])).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      expect(yield* Ref.get(polls)).toBe(2);
      yield* TestClock.adjust('1 minute');
      yield* Fiber.join(wait);
      expect(yield* Ref.get(polls)).toBe(4);
    }),
  );
});

describe('drain window', () => {
  const startedAtMs = 1_000_000;

  it('ends when the budget runs out, measured from when the budget clock started', () => {
    const window = drainWindow({ budgetMs: 300_000, leaseRemainingMs: 3_600_000, startedAtMs });
    expect(window).toEqual({ budgetMs: 300_000, deadlineMs: startedAtMs + 300_000 });
    // Time spent before the pre-flight, the durable wait or the fence retries counts against the same budget.
    expect(remainingInDrainWindow(window, startedAtMs + 120_000)).toBe(180_000);
  });

  it('never runs past the retiring lease less its margin', () => {
    const window = drainWindow({ budgetMs: 300_000, leaseRemainingMs: 90_000, startedAtMs });
    expect(window.deadlineMs).toBe(startedAtMs + 60_000);
  });

  it('never reports less than nothing left', () => {
    const window = drainWindow({ budgetMs: 300_000, leaseRemainingMs: 3_600_000, startedAtMs });
    expect(remainingInDrainWindow(window, startedAtMs + 400_000)).toBe(0);
  });
});

describe('undrainable work description', () => {
  const scheduled: UndrainableOutboxDelivery = {
    attemptsCount: 0,
    availableAt: new Date('2026-11-15T09:30:00.000Z'),
    consumerModuleKey: 'payment',
    deferred: true,
    outboxMessageId: 'message',
    reason: 'scheduled-beyond-budget',
    status: 'pending',
    tenantId: 'tenant',
    workerKey: 'payment.execute-gateway-operation',
  };

  it('says when the owner itself deferred the delivery, and until when', () => {
    expect(describeUndrainableOutboxWork([scheduled])).toContain(
      'scheduled-beyond-budget (deferred by its owner until 2026-11-15T09:30:00.000Z): --tenant-id tenant',
    );
  });

  it('does not call a failure backing off a deferral', () => {
    const described = describeUndrainableOutboxWork([{ ...scheduled, attemptsCount: 3, deferred: false }]);
    expect(described).toContain('scheduled-beyond-budget: --tenant-id tenant');
    expect(described).not.toContain('deferred');
  });
});
