import { Clock, DateTime, Duration, Effect, Layer, Option, Ref, Schedule } from 'effect';

import type { StaleEnrollmentAttempt } from '../enrollment/attempts/attempt-persistence.ts';
import { CommerceEnrollmentContinuation } from '../enrollment/continuation/enrollment-continuation.ts';
import type { CommerceEnrollmentContinuationResult } from '../enrollment/continuation/enrollment-continuation.ts';
import type { ReadEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';

/**
 * Durable retry for an enrollment journey nobody is waiting on.
 *
 * `advance` halts whenever the journey cannot move right now — another worker holds the lease, the
 * owner is unavailable, the owner's answer was lost — and its only caller is a detached fork of an
 * HTTP request that has already answered. Without something that comes back, such an Attempt stays
 * IN_PROGRESS or RECONCILIATION_REQUIRED for good.
 *
 * The sweeper is that something. It wraps the continuation rather than sitting beside it, so every
 * halt is recorded exactly where halts happen and no caller has to remember to enrol an Attempt.
 * A tracked Attempt is re-advanced once its last activity is older than the lease window: before
 * that a live claim still owns it, and the claim — not this loop — is what grants ownership, so a
 * sweep that overlaps a live worker is refused by the durable lease rather than by timing.
 *
 * That in-process record dies with the process, and the Attempt it was recording does not: a host
 * killed between the start route's commit and the continuation's answer leaves a durable Attempt
 * no replacement instance has ever heard of. So the registry is only the fast path. Every tick
 * also asks the Attempt journal itself which of this deployment's Attempts are still owed a
 * transition, for every Tenant this process has advanced an Attempt for, and advances those too —
 * which is how an Attempt abandoned by one instance is finished by the next. The journal answers
 * with the Attempts a worker can still move on its own; one already halted into reconciliation has
 * had its one automatic reconcile, and waits for a read or an operator rather than for this loop.
 *
 * It follows the shape of the outbox poller's supervision loop: one tick that cannot fail, logged
 * only when it did something, repeated on a fixed schedule for the lifetime of the layer's scope.
 * It is deliberately not a queue: the Attempt journal already is the durable record, and a second
 * durable index of due work would be a second thing to keep true.
 */

/** The continuation's own lease window: before it lapses a live claim still owns the transition. */
const LEASE_WINDOW_MS = 30_000;
/** Attempts queue rather than flooding the owners, exactly as the continuation's permits do. */
const SWEEP_CONCURRENCY = 4;
/**
 * A halt that repeats is an operator fact, not a retry loop: after this many fruitless sweeps the
 * Attempt is released, and only something that moves its durable revision — a read that resumes it,
 * or an owner outcome — makes it due again.
 */
const SWEEP_BUDGET = 8;
/** The registry is a recovery aid, not a work queue, so it is bounded and drops its oldest entry. */
const MAX_TRACKED_ATTEMPTS = 512;
/** One tick's appetite, applied both to each Tenant's durable listing and to the merged result. */
const SWEEP_TICK_LIMIT = 64;
/** Tenants are remembered only to know whom to ask; the oldest is dropped exactly as Attempts are. */
const MAX_TRACKED_TENANTS = 64;

type Continuation = typeof CommerceEnrollmentContinuation.Service;

type TenantId = ReadEnrollmentAttemptInput['tenantId'];

/** What one advance knows about the Attempt it is advancing, beyond the identity it advances. */
interface AdvanceEntry {
  readonly attempt: ReadEnrollmentAttemptInput;
  /** The durable revision the journal last reported; `none` until a listing has named one. */
  readonly revision: Option.Option<number>;
  readonly sweeps: number;
}

interface TrackedAttempt extends AdvanceEntry {
  readonly lastActivityMillis: number;
}

export interface CommerceEnrollmentContinuationSweepResult {
  /** Attempts that ran out of sweep budget and were released without being advanced. */
  readonly released: number;
  /** Attempts whose last activity was older than the stale window and were advanced again. */
  readonly swept: number;
  readonly tracked: number;
}

interface CommerceEnrollmentContinuationSweeper {
  /**
   * The continuation, instrumented. Every answer is the wrapped continuation's own; a halt also
   * registers the Attempt for a later sweep and a completion releases it.
   */
  readonly continuation: Continuation;
  readonly sweep: Effect.Effect<CommerceEnrollmentContinuationSweepResult>;
}

export interface CommerceEnrollmentContinuationSweeperOptions {
  readonly continuation: Continuation;
  /** How long an Attempt must have been untouched before a sweep may advance it again. */
  readonly staleAfterMillis?: number;
  /**
   * Tenants whose journal is scanned from the very first tick, before this instance has advanced
   * an Attempt of its own. A deployment that knows which Tenants it serves names them here; one
   * that does not learns them from the Attempts it is handed, which is why the option is optional
   * rather than the only source.
   */
  readonly tenants?: readonly TenantId[];
}

type Registry = ReadonlyMap<string, TrackedAttempt>;
/** Attempts whose sweep budget ran out, against the durable revision each ran out at. */
type Exhausted = ReadonlyMap<string, number>;
type Tenants = ReadonlySet<TenantId>;

interface SweeperState {
  /**
   * Why this is remembered at all: releasing an entry from the registry is not enough, because the
   * durable listing reports the very same Attempt on the next tick and a merge that knows nothing
   * about the spent budget seeds it again from zero. Marked against the revision it was released
   * at, so the mark says "nothing has moved" rather than "never sweep this again".
   */
  readonly exhausted: Ref.Ref<Exhausted>;
  readonly registry: Ref.Ref<Registry>;
  /** Whom to ask the journal about. A Tenant is remembered on any answer, halt or completion. */
  readonly tenants: Ref.Ref<Tenants>;
}

interface TenantListing {
  readonly attempts: readonly StaleEnrollmentAttempt[];
  /** Why this Tenant's journal could not be read, when it could not; `none` when it was read. */
  readonly unreadable: Option.Option<string>;
}

const registryKey = (attempt: ReadEnrollmentAttemptInput): string =>
  `${attempt.tenantId}/${attempt.portalEnrollmentAttemptId}`;

/** A completed or terminated journey has nothing left to sweep; every other outcome may. */
const isSettled = (result: CommerceEnrollmentContinuationResult): boolean =>
  result.outcome === 'COMPLETE' || result.halt.reason === 'ATTEMPT_TERMINAL';

const withoutKey = <Value>(entries: ReadonlyMap<string, Value>, key: string): ReadonlyMap<string, Value> =>
  new Map([...entries].filter(([candidate]) => candidate !== key));

/** Insertion order is age order, so dropping from the front drops the least recently touched. */
const bounded = <Value>(entries: ReadonlyMap<string, Value>): ReadonlyMap<string, Value> =>
  entries.size <= MAX_TRACKED_ATTEMPTS ? entries : new Map([...entries].slice(entries.size - MAX_TRACKED_ATTEMPTS));

const withEntry = (registry: Registry, key: string, entry: TrackedAttempt): Registry => {
  // Only a durable listing ever names a revision, so an entry re-registered by an advance keeps
  // the one the registry already holds rather than forgetting what this Attempt was last seen at.
  const tracked = registry.get(key);
  const carried: TrackedAttempt =
    Option.isSome(entry.revision) || tracked === undefined ? entry : { ...entry, revision: tracked.revision };
  return bounded(new Map([...withoutKey(registry, key), [key, carried]]));
};

const withMark = (exhausted: Exhausted, key: string, revision: number): Exhausted =>
  bounded(new Map([...withoutKey(exhausted, key), [key, revision]]));

const withTenant = (tenants: Tenants, tenantId: TenantId): Tenants => {
  if (tenants.has(tenantId)) {
    return tenants;
  }
  const next: Tenants = new Set([...tenants, tenantId]);
  return next.size <= MAX_TRACKED_TENANTS ? next : new Set([...next].slice(next.size - MAX_TRACKED_TENANTS));
};

/** Record what one advance answered: a settled Attempt is released, every other one is kept. */
const observe = (
  state: SweeperState,
  entry: AdvanceEntry,
  result?: CommerceEnrollmentContinuationResult,
): Effect.Effect<void> => {
  const key = registryKey(entry.attempt);
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.all(
        [
          Ref.update(state.registry, (registry) =>
            result !== undefined && isSettled(result)
              ? withoutKey(registry, key)
              : withEntry(registry, key, { ...entry, lastActivityMillis: now }),
          ),
          // An advance is movement, whoever asked for it, so an exhaustion mark left by an earlier
          // budget has nothing left to hold back: this Attempt is being worked on again.
          Ref.update(state.exhausted, (exhausted) => withoutKey(exhausted, key)),
          // A settled Attempt releases its registry entry but never its Tenant: the journal may
          // still hold Attempts of that Tenant that this process never started.
          Ref.update(state.tenants, (tenants) => withTenant(tenants, entry.attempt.tenantId)),
        ],
        { concurrency: 1 },
      ),
    ),
    Effect.asVoid,
  );
};

const trackedAdvance = (state: SweeperState, inner: Continuation, entry: AdvanceEntry) =>
  inner.advance(entry.attempt).pipe(
    Effect.tap((result) => observe(state, entry, result)),
    // A failed advance is still activity: the Attempt stays tracked so the next sweep retries it.
    Effect.tapError(() => observe(state, entry)),
  );

/**
 * A spent budget releases the entry and records the revision it was spent at. The durable listing
 * still reports this Attempt every tick; the mark is what stops the next merge from handing it a
 * fresh budget, and it lasts exactly as long as the Attempt stays at that revision.
 */
const release = (state: SweeperState, entry: TrackedAttempt): Effect.Effect<void> => {
  const key = registryKey(entry.attempt);
  return Effect.all(
    [
      Ref.update(state.registry, (registry) => withoutKey(registry, key)),
      Option.match(entry.revision, {
        // An entry no listing ever named cannot be marked: the durable journal is the only thing
        // that will re-create it, and only a listing says which revision it would re-create it at.
        onNone: () => Effect.void,
        onSome: (revision) => Ref.update(state.exhausted, (exhausted) => withMark(exhausted, key, revision)),
      }),
    ],
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
};

/** One tracked Attempt: advanced, or released once it has used up its sweep budget. */
const sweepEntry = (state: SweeperState, inner: Continuation, entry: TrackedAttempt): Effect.Effect<boolean> =>
  entry.sweeps >= SWEEP_BUDGET
    ? release(state, entry).pipe(Effect.as(false))
    : trackedAdvance(state, inner, { ...entry, sweeps: entry.sweeps + 1 }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Effect.annotateLogs(Effect.logWarning('The Commerce enrollment sweeper could not advance this Attempt'), {
              portalEnrollmentAttemptId: entry.attempt.portalEnrollmentAttemptId,
              reason: String(cause),
            }).pipe(Effect.as(true)),
          onSuccess: () => Effect.succeed(true),
        }),
      );

/**
 * The journal's own answer to what is still owed a transition, asked once per known Tenant. A
 * Tenant whose journal cannot be read is reported and skipped: one unreachable Tenant must not
 * cost the tick the Attempts it can still advance.
 */
const listTenantDue = (
  inner: Continuation,
  tenantId: TenantId,
  staleAfterMillis: number,
): Effect.Effect<TenantListing> =>
  inner.listStale({ limit: SWEEP_TICK_LIMIT, staleAfterMillis, tenantId }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => Effect.succeed<TenantListing>({ attempts: [], unreadable: Option.some(String(cause)) }),
      onSuccess: (attempts) => Effect.succeed<TenantListing>({ attempts, unreadable: Option.none() }),
    }),
  );

const durableDue = (
  state: SweeperState,
  inner: Continuation,
  staleAfterMillis: number,
): Effect.Effect<readonly StaleEnrollmentAttempt[]> =>
  Ref.get(state.tenants).pipe(
    Effect.flatMap((tenants) =>
      Effect.forEach([...tenants], (tenantId) => listTenantDue(inner, tenantId, staleAfterMillis), {
        concurrency: SWEEP_CONCURRENCY,
      }),
    ),
    Effect.flatMap((listings) => {
      const due: readonly StaleEnrollmentAttempt[] = listings.flatMap((listing) => [...listing.attempts]);
      const unreadable = listings.flatMap((listing) =>
        Option.isNone(listing.unreadable) ? [] : [listing.unreadable.value],
      );
      return unreadable.length === 0
        ? Effect.succeed(due)
        : Effect.annotateLogs(
            Effect.logWarning('The Commerce enrollment sweeper could not read every durable Attempt journal'),
            { reason: unreadable.join(' | '), unreadable: unreadable.length },
          ).pipe(Effect.as(due));
    }),
  );

/**
 * What this tick advances: every tracked Attempt whose last activity is older than the stale
 * window, and every Attempt the journal reports as due that the registry holds no fresher word on.
 * A journal row is already due by the database's own clock, so it is never re-aged against this
 * process's clock; a row the registry still tracks keeps the registry's entry, because that entry
 * carries the sweep budget this Attempt has already spent. A row still standing at the revision an
 * earlier budget was spent at is skipped: re-seeding it would spend a fresh budget on the identical
 * durable state every tick, and crowd the bounded list out of the Attempts that can still move.
 */
const dueEntries = (
  registry: Registry,
  exhausted: Exhausted,
  durable: readonly StaleEnrollmentAttempt[],
  now: number,
  staleAfterMillis: number,
): readonly TrackedAttempt[] => {
  const due = new Map<string, TrackedAttempt>();
  for (const entry of registry.values()) {
    if (now - entry.lastActivityMillis >= staleAfterMillis) {
      due.set(registryKey(entry.attempt), entry);
    }
  }
  for (const stale of durable) {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: stale.portalEnrollmentAttemptId,
      tenantId: stale.tenantId,
    };
    const key = registryKey(attempt);
    if (!registry.has(key) && exhausted.get(key) !== stale.revision) {
      due.set(key, {
        attempt,
        lastActivityMillis: DateTime.toEpochMillis(stale.updatedAt),
        revision: Option.some(stale.revision),
        sweeps: 0,
      });
    }
  }
  return [...due.values()].slice(0, SWEEP_TICK_LIMIT);
};

/**
 * One sweep. The registry and the durable journal are merged into one due list, and each entry is
 * advanced; the advance itself decides what happens next, exactly as the start route's fork does.
 */
const sweepOnce = Effect.fn('CommerceEnrollmentContinuationSweeper.sweep')(function* sweepOnceEffect(
  state: SweeperState,
  inner: Continuation,
  staleAfterMillis: number,
): Effect.fn.Return<CommerceEnrollmentContinuationSweepResult> {
  const [now, registry, exhausted, durable] = yield* Effect.all(
    [
      Clock.currentTimeMillis,
      Ref.get(state.registry),
      Ref.get(state.exhausted),
      durableDue(state, inner, staleAfterMillis),
    ],
    { concurrency: 4 },
  );
  const due = dueEntries(registry, exhausted, durable, now, staleAfterMillis);
  const advanced = yield* Effect.forEach(due, (entry) => sweepEntry(state, inner, entry), {
    concurrency: SWEEP_CONCURRENCY,
  });
  const swept = advanced.filter(Boolean).length;
  const tracked = yield* Ref.get(state.registry);
  return { released: advanced.length - swept, swept, tracked: tracked.size };
});

export const commerceEnrollmentContinuationSweeperFor = Effect.fnUntraced(
  function* commerceEnrollmentContinuationSweeperFor(options: CommerceEnrollmentContinuationSweeperOptions) {
    const [exhausted, registry, tenants] = yield* Effect.all(
      [Ref.make<Exhausted>(new Map()), Ref.make<Registry>(new Map()), Ref.make<Tenants>(new Set(options.tenants))],
      { concurrency: 1 },
    );
    const state: SweeperState = { exhausted, registry, tenants };
    const inner = options.continuation;
    const staleAfterMillis = options.staleAfterMillis ?? LEASE_WINDOW_MS;
    const sweeper: CommerceEnrollmentContinuationSweeper = {
      continuation: {
        advance: (attempt) => trackedAdvance(state, inner, { attempt, revision: Option.none(), sweeps: 0 }),
        listStale: (input) => inner.listStale(input),
      },
      sweep: sweepOnce(state, inner, staleAfterMillis),
    };
    return sweeper;
  },
);

const hasActivity = (result: CommerceEnrollmentContinuationSweepResult): boolean =>
  result.released > 0 || result.swept > 0;

/** The supervision loop: a tick that cannot fail, logged only when it moved something. */
const runCommerceEnrollmentContinuationSweepLoop = (
  sweep: Effect.Effect<CommerceEnrollmentContinuationSweepResult>,
  intervalMillis: number,
): Effect.Effect<void> =>
  sweep.pipe(
    Effect.tap((result) =>
      hasActivity(result)
        ? Effect.annotateLogs(Effect.logInfo('The Commerce enrollment sweep cycle completed'), {
            released: result.released,
            swept: result.swept,
            tracked: result.tracked,
          })
        : Effect.void,
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(intervalMillis))),
    Effect.asVoid,
  );

/**
 * The swept continuation: the continuation this deployment resolved, instrumented, with the sweep
 * loop running for the lifetime of the layer's scope. It takes the unswept continuation as its own
 * requirement, so root decides which one is wrapped — a host without the enrollment realm sweeps a
 * fail-closed continuation that refuses every Attempt and reports an empty journal, which is a
 * no-op rather than a second code path.
 */
export const CommerceEnrollmentSweptContinuationLive: Layer.Layer<
  CommerceEnrollmentContinuation,
  never,
  CommerceEnrollmentContinuation
> = Layer.effect(
  CommerceEnrollmentContinuation,
  Effect.gen(function* makeCommerceEnrollmentSweptContinuation() {
    const continuation = yield* CommerceEnrollmentContinuation;
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({ continuation });
    yield* Effect.forkScoped(runCommerceEnrollmentContinuationSweepLoop(sweeper.sweep, LEASE_WINDOW_MS));
    return sweeper.continuation;
  }),
);
