/**
 * The operator's pre-flight verdict and the publisher's give-up message must say what really happens in each
 * authority phase, because an operator acts on them before or during a deploy.
 */
import { Effect, Fiber, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { publicationVerdict } from '../../packages/core-runtime/src/outbox/drain-preflight.ts';
import type { PublicationVerdictInput } from '../../packages/core-runtime/src/outbox/drain-preflight.ts';
import {
  abandonedTransitionMessage,
  retryWhileLockNotAvailable,
} from '../application-composition-authority-publication.mts';

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
