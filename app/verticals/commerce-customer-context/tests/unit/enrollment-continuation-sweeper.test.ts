import { randomUUID } from 'node:crypto';

import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  ClaimEnrollmentSweepInput,
  DueEnrollmentAttempt,
  DueEnrollmentAttemptCursor,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { CommerceEnrollmentContinuationService } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import {
  commerceEnrollmentContinuationSweeperFor,
  SWEEP_BUDGET,
} from '../../src/workers/enrollment-continuation-sweeper.ts';
import type { CommerceEnrollmentContinuationSweepResult } from '../../src/workers/enrollment-continuation-sweeper.ts';
import { EnrollmentAttemptIdSchema, EnrollmentTenantIdSchema } from '../../shared/enrollment-contracts.ts';
import type { ReadEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';

/**
 * The sweeper's seam, without PostgreSQL: what one tick decides to advance, given an in-process
 * registry and a durable journal that disagree about what is owed a transition.
 */

const attemptId = (value: string) => Schema.decodeSync(EnrollmentAttemptIdSchema)(value);
const tenantId = (value: string) => Schema.decodeSync(EnrollmentTenantIdSchema)(value);

/** A keyset over the scripted journal's own order: a cursor resumes strictly after its row. */
const resumeIndex = (rows: readonly DueEnrollmentAttempt[], after: Option.Option<DueEnrollmentAttemptCursor>): number =>
  Option.match(after, {
    onNone: () => 0,
    onSome: (cursor) => rows.findIndex((row) => row.portalEnrollmentAttemptId === cursor.portalEnrollmentAttemptId) + 1,
  });

interface ScriptedContinuation {
  /** Every Attempt `advance` was called with, in call order. */
  readonly advanced: Effect.Effect<readonly string[]>;
  readonly service: CommerceEnrollmentContinuationService;
}

/** The durable sweep accounting `claim_portal_enrollment_sweep` keeps, one entry per Attempt. */
interface ScriptedSweep {
  readonly count: number;
  readonly revision: number;
}

/**
 * The exclusion `list_due_portal_enrollment_attempts` applies: an Attempt still standing at the
 * revision its budget was spent against is not offered again, and anything that moves the revision
 * puts it back in the listing with the whole budget ahead of it.
 */
const isExhausted = (sweeps: ReadonlyMap<string, ScriptedSweep>, row: DueEnrollmentAttempt, maxSweeps: number) => {
  const recorded = sweeps.get(row.portalEnrollmentAttemptId);
  return recorded !== undefined && recorded.revision === row.revision && recorded.count >= maxSweeps;
};

/** A continuation that answers from a durable journal and records what it was asked to advance. */
const scriptedContinuation = Effect.fnUntraced(function* scriptedContinuation(
  journal: Ref.Ref<readonly DueEnrollmentAttempt[]>,
  outcome: 'COMPLETE' | 'HALTED',
) {
  const log = yield* Ref.make<readonly string[]>([]);
  const sweeps = yield* Ref.make<ReadonlyMap<string, ScriptedSweep>>(new Map());
  const service: CommerceEnrollmentContinuationService = {
    advance: (input) =>
      Ref.update(log, (calls) => [...calls, input.portalEnrollmentAttemptId]).pipe(
        Effect.as(
          outcome === 'COMPLETE'
            ? { outcome: 'COMPLETE' as const }
            : { halt: { reason: 'IN_FLIGHT' as const, transition: Option.none() }, outcome: 'HALTED' as const },
        ),
      ),
    claimSweep: (input) =>
      Ref.modify(sweeps, (recorded) => {
        const previous = recorded.get(input.portalEnrollmentAttemptId);
        // The routine's own refusal: a budget already spent at this revision is charged no further.
        if (previous !== undefined && previous.revision === input.revision && previous.count >= input.maxSweeps) {
          return [Option.none<number>(), recorded] as const;
        }
        const count = previous === undefined || previous.revision !== input.revision ? 1 : previous.count + 1;
        return [
          Option.some(count),
          new Map([...recorded, [input.portalEnrollmentAttemptId, { count, revision: input.revision }]]),
        ] as const;
      }),
    listDue: (input) =>
      Effect.all([Ref.get(journal), Ref.get(sweeps)], { concurrency: 2 }).pipe(
        Effect.map(([rows, recorded]) => {
          const offered = rows.filter((row) => !isExhausted(recorded, row, input.maxSweeps));
          const start = resumeIndex(offered, input.after);
          return offered.slice(start, start + input.limit);
        }),
      ),
  };
  const scripted: ScriptedContinuation = { advanced: Ref.get(log), service };
  return scripted;
});

const due = (attempt: ReadEnrollmentAttemptInput, revision = 1): DueEnrollmentAttempt => ({
  ...attempt,
  revision,
  state: 'IN_PROGRESS',
  updatedAt: DateTime.makeUnsafe(new Date(0)),
});

const journalOf = (...rows: readonly DueEnrollmentAttempt[]) => Ref.make<readonly DueEnrollmentAttempt[]>(rows);

/** How many ticks a test may spend waiting for a budget to run out before it gives up. */
const MAX_SWEEP_TICKS = 64;

/**
 * Tick until the sweeper releases an Attempt, which is the tick its sweep budget ran out on. The
 * budget itself stays the worker's own constant rather than being restated here.
 */
const sweepUntilReleased = Effect.fnUntraced(function* sweepUntilReleased(
  sweep: Effect.Effect<CommerceEnrollmentContinuationSweepResult>,
) {
  for (let tick = 0; tick < MAX_SWEEP_TICKS; tick += 1) {
    const result = yield* sweep;
    if (result.released > 0) {
      return result;
    }
  }
  return yield* Effect.die('The sweeper never released the Attempt whose budget should have run out');
});

it.effect('seeds a tick from the durable journal when its registry has never seen the Attempt', () =>
  Effect.gen(function* seedsFromJournal() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const scripted = yield* scriptedContinuation(yield* journalOf(due(attempt)), 'COMPLETE');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      staleAfterMillis: 0,
    });

    const sweep = yield* sweeper.sweep;

    // A registry-only sweeper has nothing to iterate here, so dropping the durable seed makes both
    // of these empty: the Attempt its process never started stays where the last one left it. The
    // sweeper is told no Tenant at all, so the listing is the only thing that could have named one.
    expect(sweep.swept).toBe(1);
    expect(yield* scripted.advanced).toStrictEqual([attempt.portalEnrollmentAttemptId]);
  }),
);

it.effect('reads past a whole page of Attempts an earlier budget gave up on', () =>
  Effect.gen(function* pagesPastExhaustedAttempts() {
    const attemptFor = (): ReadEnrollmentAttemptInput => ({
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    });
    const [older, oldest, fresh] = [attemptFor(), attemptFor(), attemptFor()];
    const journal = yield* journalOf(due(oldest), due(older));
    const scripted = yield* scriptedContinuation(journal, 'HALTED');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      pageLimit: 2,
      staleAfterMillis: 0,
    });

    // Both spend their durable budget at the revision they are standing at, which is what takes
    // them out of the listing while nothing moves them.
    expect((yield* sweepUntilReleased(sweeper.sweep)).released).toBe(2);
    const spent = (yield* scripted.advanced).length;

    // A newer Attempt arrives behind them in the journal's oldest-first order. Were the two spent
    // rows still offered they would be the tick's whole first page, and a tick that stops after one
    // page would never reach this one.
    yield* Ref.set(journal, [due(oldest), due(older), due(fresh)]);

    expect((yield* sweeper.sweep).swept).toBe(1);
    expect((yield* scripted.advanced).slice(spent)).toStrictEqual([fresh.portalEnrollmentAttemptId]);
  }),
);

it.effect('advances an Attempt once per tick when the registry and the journal both report it', () =>
  Effect.gen(function* registryAndJournalAgree() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const scripted = yield* scriptedContinuation(yield* journalOf(due(attempt)), 'HALTED');
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

/** Longer than this test takes, so nothing in it ages out of the registry by the clock. */
const POLL_STALE_WINDOW_MILLIS = 60_000;

it.effect('advances an Attempt the journal still reports due although the registry saw a halt moments ago', () =>
  Effect.gen(function* durableRowSurvivesAFreshHalt() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const scripted = yield* scriptedContinuation(yield* journalOf(due(attempt)), 'HALTED');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      staleAfterMillis: POLL_STALE_WINDOW_MILLIS,
    });

    // What the read route's resume does through this very continuation: it halts IN_FLIGHT, writes
    // nothing durable, and refreshes the in-process entry's last activity. A client polling the
    // Attempt does exactly this, over and over, for as long as it waits.
    expect((yield* sweeper.continuation.advance(attempt)).outcome).toBe('HALTED');

    const sweep = yield* sweeper.sweep;

    // The journal still lists the Attempt: nothing moved its durable revision, and the database's
    // own clock is what decided it is due. Letting the fresh registry entry veto that row leaves
    // `swept` at 0 and the second call below missing — and an Attempt somebody is waiting on is
    // then the one Attempt the sweeper will never re-advance.
    expect(sweep.swept).toBe(1);
    expect(yield* scripted.advanced).toStrictEqual([
      attempt.portalEnrollmentAttemptId,
      attempt.portalEnrollmentAttemptId,
    ]);
  }),
);

it.effect('leaves an Attempt alone once its budget ran out, until its durable revision moves', () =>
  Effect.gen(function* exhaustedAttemptIsNotReseeded() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const journal = yield* journalOf(due(attempt));
    const scripted = yield* scriptedContinuation(journal, 'HALTED');
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: scripted.service,
      staleAfterMillis: 0,
    });

    const released = yield* sweepUntilReleased(sweeper.sweep);
    expect(released.tracked).toBe(0);
    const spent = (yield* scripted.advanced).length;

    // The Attempt is still in the journal and still unchanged; it is its own recorded count, at
    // the revision it is standing at, that stops the listing offering it. A budget held only in
    // this process's memory would be granted again by the very next tick's listing, so an Attempt
    // no owner effect can move would be advanced for the life of the process — and, being among
    // the oldest, would crowd the Attempts that can still finish out of every bounded page.
    expect((yield* sweeper.sweep).swept).toBe(0);
    expect((yield* scripted.advanced).length).toBe(spent);

    // A revision change is the journal's own word that something moved this Attempt — a read
    // resumed it, or an owner answered — so the budget starts again.
    yield* Ref.set(journal, [due(attempt, 2)]);

    expect((yield* sweeper.sweep).swept).toBe(1);
    expect((yield* scripted.advanced).length).toBe(spent + 1);
  }),
);

it.effect('leaves an Attempt another replica has claimed alone, and charges it nothing', () =>
  Effect.gen(function* refusedClaimIsNotSwept() {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId(randomUUID()),
      tenantId: tenantId(randomUUID()),
    };
    const advanced = yield* Ref.make<readonly string[]>([]);
    const claims = yield* Ref.make<readonly ClaimEnrollmentSweepInput[]>([]);
    const service: CommerceEnrollmentContinuationService = {
      advance: (input) =>
        Ref.update(advanced, (calls) => [...calls, input.portalEnrollmentAttemptId]).pipe(
          Effect.as({ outcome: 'COMPLETE' as const }),
        ),
      // The journal refuses the claim: another replica already holds this Attempt's pass, so the
      // routine charged nothing and grants no licence to advance.
      claimSweep: (input) => Ref.update(claims, (calls) => [...calls, input]).pipe(Effect.as(Option.none())),
      listDue: () => Effect.succeed([due(attempt)]),
    };
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
      continuation: service,
      staleAfterMillis: 0,
    });

    const sweep = yield* sweeper.sweep;

    // The listing offered the row, so a sweeper that advanced on anything but a granted claim would
    // run the very transition the replica holding the claim is already running.
    expect(sweep.swept).toBe(0);
    expect(sweep.released).toBe(1);
    expect(yield* Ref.get(advanced)).toStrictEqual([]);
    // One bid, and the budget it names is the sweeper's own, so the journal can refuse a spent one.
    expect((yield* Ref.get(claims)).map((call) => call.portalEnrollmentAttemptId)).toStrictEqual([
      attempt.portalEnrollmentAttemptId,
    ]);
    expect((yield* Ref.get(claims)).map((call) => call.maxSweeps)).toStrictEqual([SWEEP_BUDGET]);
  }),
);
