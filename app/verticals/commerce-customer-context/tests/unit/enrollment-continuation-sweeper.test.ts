import { randomUUID } from 'node:crypto';

import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { StaleEnrollmentAttempt } from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { CommerceEnrollmentContinuationService } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import { commerceEnrollmentContinuationSweeperFor } from '../../src/workers/enrollment-continuation-sweeper.ts';
import { EnrollmentAttemptIdSchema, EnrollmentTenantIdSchema } from '../../shared/enrollment-contracts.ts';
import type { ReadEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';

/**
 * The sweeper's seam, without PostgreSQL: what one tick decides to advance, given an in-process
 * registry and a durable journal that disagree about what is owed a transition.
 */

const attemptId = (value: string) => Schema.decodeSync(EnrollmentAttemptIdSchema)(value);
const tenantId = (value: string) => Schema.decodeSync(EnrollmentTenantIdSchema)(value);

interface ScriptedContinuation {
  /** Every Attempt `advance` was called with, in call order. */
  readonly advanced: Effect.Effect<readonly string[]>;
  readonly service: CommerceEnrollmentContinuationService;
}

/** A continuation that answers from a fixed journal and records what it was asked to advance. */
const scriptedContinuation = Effect.fnUntraced(function* scriptedContinuation(
  journal: readonly StaleEnrollmentAttempt[],
  outcome: 'COMPLETE' | 'HALTED',
) {
  const log = yield* Ref.make<readonly string[]>([]);
  const service: CommerceEnrollmentContinuationService = {
    advance: (input) =>
      Ref.update(log, (calls) => [...calls, input.portalEnrollmentAttemptId]).pipe(
        Effect.as(
          outcome === 'COMPLETE'
            ? { outcome: 'COMPLETE' as const }
            : { halt: { reason: 'IN_FLIGHT' as const, transition: Option.none() }, outcome: 'HALTED' as const },
        ),
      ),
    listStale: (input) => Effect.succeed(journal.filter((entry) => entry.tenantId === input.tenantId)),
  };
  const scripted: ScriptedContinuation = { advanced: Ref.get(log), service };
  return scripted;
});

const stale = (attempt: ReadEnrollmentAttemptInput): StaleEnrollmentAttempt => ({
  ...attempt,
  state: 'IN_PROGRESS',
  updatedAt: DateTime.makeUnsafe(new Date(0)),
});

it.effect('seeds a tick from the durable journal when its registry has never seen the Attempt', () =>
  Effect.gen(function* seedsFromJournal() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const scripted = yield* scriptedContinuation([stale(attempt)], 'COMPLETE');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      staleAfterMillis: 0,
      tenants: [attempt.tenantId],
    });

    const sweep = yield* sweeper.sweep;

    // A registry-only sweeper has nothing to iterate here, so dropping the durable seed makes both
    // of these empty: the Attempt its process never started stays where the last one left it.
    expect(sweep.swept).toBe(1);
    expect(yield* scripted.advanced).toStrictEqual([attempt.portalEnrollmentAttemptId]);
  }),
);

it.effect('scans the journal of a Tenant it learned from an Attempt it already settled', () =>
  Effect.gen(function* learnsTenantFromTraffic() {
    const scope = tenantId(randomUUID());
    const served: ReadEnrollmentAttemptInput = { portalEnrollmentAttemptId: attemptId(randomUUID()), tenantId: scope };
    const abandoned: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: scope,
    };
    const scripted = yield* scriptedContinuation([stale(abandoned)], 'COMPLETE');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      staleAfterMillis: 0,
    });

    // Nothing has been served yet, so there is no Tenant to ask about and nothing is due.
    expect((yield* sweeper.sweep).swept).toBe(0);

    // One request completes cleanly. It leaves no registry entry — and the Tenant behind it is
    // exactly what lets the next tick find the Attempt a previous process abandoned.
    expect((yield* sweeper.continuation.advance(served)).outcome).toBe('COMPLETE');

    const sweep = yield* sweeper.sweep;

    expect(sweep.swept).toBe(1);
    expect(yield* scripted.advanced).toStrictEqual([
      served.portalEnrollmentAttemptId,
      abandoned.portalEnrollmentAttemptId,
    ]);
  }),
);

it.effect('advances an Attempt once per tick when the registry and the journal both report it', () =>
  Effect.gen(function* registryAndJournalAgree() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const scripted = yield* scriptedContinuation([stale(attempt)], 'HALTED');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      staleAfterMillis: 0,
    });

    // The halt registers the Attempt, and the journal reports the very same one as due.
    expect((yield* sweeper.continuation.advance(attempt)).outcome).toBe('HALTED');
    const sweep = yield* sweeper.sweep;

    // Merging the two sources by Attempt identity is what keeps this at two calls rather than
    // three: one for the halt, one for the tick, and none for the duplicate.
    expect(sweep.swept).toBe(1);
    expect(yield* scripted.advanced).toStrictEqual([
      attempt.portalEnrollmentAttemptId,
      attempt.portalEnrollmentAttemptId,
    ]);
    expect(sweep.tracked).toBe(1);
  }),
);
