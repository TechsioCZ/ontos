import { Clock, DateTime, Duration, Effect, Layer, Option, Ref, Schedule } from 'effect';

import type { DueEnrollmentAttempt, DueEnrollmentAttemptCursor } from '../enrollment/attempts/attempt-persistence.ts';
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
 * A tracked Attempt the journal has not named yet is re-advanced once its last activity is older
 * than the lease window: before that a live claim still owns it, and the claim — not this loop — is
 * what grants ownership, so a sweep that overlaps a live worker is refused by the durable lease
 * rather than by timing.
 *
 * That in-process record dies with the process, and the Attempt it was recording does not: a host
 * killed between the start route's commit and the continuation's answer leaves a durable Attempt
 * no replacement instance has ever heard of. So the registry is only the fast path. Every tick
 * also asks the Attempt journal itself which Attempts are still owed a transition — across every
 * Tenant, because a replacement process has served none of them yet — and advances those too. That
 * listing is the one Attempt surface with no Tenant in it, and it is read in a worker transaction
 * that installs no scope at all, exactly as the Core Outbox poller claims the next due delivery of
 * any Tenant before it knows whose it is.
 *
 * The journal answers with the Attempts a worker can still move on its own: one still running, and
 * one fenced into reconciliation whose owner operation has no authoritative answer on record yet.
 * The single reconcile a fenced Attempt is owed settles that operation, after which the Attempt
 * leaves the listing by itself rather than by a rule predicting the settlement.
 *
 * The sweep budget is durable for the same reason the discovery is: an Attempt no owner effect can
 * move would otherwise be granted a fresh budget by every listing, and the oldest rows are the ones
 * a listing hands out first. So each sweep is counted on the Attempt itself, against the revision
 * it was swept at, and the listing excludes a spent one in SQL — which is also what stops a page of
 * them from hiding newer work behind it. Anything that moves the Attempt resets the count.
 *
 * That count is taken rather than merely written: every replica's listing reports the same due row,
 * so a sweep that charged the budget without also taking the row would let each replica that then
 * lost the transition claim spend a pass it never performed, and a few replicas would exhaust an
 * Attempt swept exactly once. The journal therefore hands out one claim per Attempt per pass, and a
 * replica that does not get it leaves the row alone without charging it.
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
 * journal stops reporting the Attempt, and only something that moves its durable revision — a read
 * that resumes it, or an owner outcome — makes it due again. It is spent durably, because the
 * worker spending it is not durable: a count kept only in a process's memory is re-granted in full
 * by the next listing, so an Attempt nothing can move stays ahead of newer work on every page.
 */
export const SWEEP_BUDGET = 8;
/** The registry is a recovery aid, not a work queue, so it is bounded and drops its oldest entry. */
const MAX_TRACKED_ATTEMPTS = 512;
/** One tick's appetite: how many Attempts it will take from the journal and advance. */
const SWEEP_TICK_LIMIT = 64;
/** One durable page. Smaller than a tick's appetite so a page is never a tick's whole answer. */
const SWEEP_PAGE_LIMIT = 32;
/** How many pages one tick will read before it stops and leaves the rest to the next one. */
const SWEEP_MAX_PAGES = 8;

type Continuation = typeof CommerceEnrollmentContinuation.Service;

/** What one advance knows about the Attempt it is advancing, beyond the identity it advances. */
interface AdvanceEntry {
  readonly attempt: ReadEnrollmentAttemptInput;
  /**
   * Whether the durable journal has ever named this Attempt. Only one it never named is swept on
   * the in-process budget below; for everything else the journal counts the sweeps itself.
   */
  readonly journalled: boolean;
  readonly sweeps: number;
}

interface TrackedAttempt extends AdvanceEntry {
  readonly lastActivityMillis: number;
}

/** One Attempt this tick decided to work on, together with the journal's current word on it. */
interface DueSweep {
  readonly entry: TrackedAttempt;
  /** The revision the journal named for it on this tick; `none` when this tick's listing had none. */
  readonly revision: Option.Option<number>;
}

export interface CommerceEnrollmentContinuationSweepResult {
  /**
   * Due Attempts this tick did not advance: a spent budget, a claim another replica holds, or a
   * claim it could not write at all.
   */
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
  /** Rows one durable page asks for. Smaller pages cost more round trips, never less work. */
  readonly pageLimit?: number;
  /** How long an Attempt must have been untouched before a sweep may advance it again. */
  readonly staleAfterMillis?: number;
}

type Registry = ReadonlyMap<string, TrackedAttempt>;

interface SweeperState {
  readonly registry: Ref.Ref<Registry>;
}

interface DurableListing {
  readonly attempts: readonly DueEnrollmentAttempt[];
  /** Why the journal could not be read, when it could not; `none` when it was read. */
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
  // Only a durable listing ever names an Attempt, so an entry re-registered by an advance keeps the
  // registry's word on whether the journal has named this one rather than forgetting it.
  const tracked = registry.get(key);
  const carried: TrackedAttempt =
    entry.journalled || tracked === undefined ? entry : { ...entry, journalled: tracked.journalled };
  return bounded(new Map([...withoutKey(registry, key), [key, carried]]));
};

/** Record what one advance answered: a settled Attempt is released, every other one is kept. */
const observe = (
  state: SweeperState,
  entry: AdvanceEntry,
  result?: CommerceEnrollmentContinuationResult,
): Effect.Effect<void> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const key = registryKey(entry.attempt);
      return Ref.update(state.registry, (registry) =>
        result !== undefined && isSettled(result)
          ? withoutKey(registry, key)
          : withEntry(registry, key, { ...entry, lastActivityMillis: now }),
      );
    }),
    Effect.asVoid,
  );

const trackedAdvance = (state: SweeperState, inner: Continuation, entry: AdvanceEntry) =>
  inner.advance(entry.attempt).pipe(
    Effect.tap((result) => observe(state, entry, result)),
    // A failed advance is still activity: the Attempt stays tracked so the next sweep retries it.
    Effect.tapError(() => observe(state, entry)),
  );

/** Letting an entry go costs nothing durable: the journal's own count is what withholds the work. */
const release = (state: SweeperState, entry: TrackedAttempt): Effect.Effect<void> =>
  Ref.update(state.registry, (registry) => withoutKey(registry, registryKey(entry.attempt)));

const advanceEntry = (state: SweeperState, inner: Continuation, entry: TrackedAttempt): Effect.Effect<boolean> =>
  trackedAdvance(state, inner, entry).pipe(
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
 * A sweep the journal named a revision for is claimed before it is spent, so the count survives the
 * process spending it and no second replica works the same row on the same pass. A refused claim is
 * another replica's turn or a budget already spent, and a claim that cannot be written at all is
 * not a licence to sweep anyway: either way the tick leaves the Attempt alone rather than working
 * it on a budget nothing is keeping, and neither path charges the Attempt.
 */
const claimedAdvance = (
  state: SweeperState,
  inner: Continuation,
  entry: TrackedAttempt,
  revision: number,
  claimTtlMillis: number,
): Effect.Effect<boolean> =>
  inner.claimSweep({ ...entry.attempt, claimTtlMillis, maxSweeps: SWEEP_BUDGET, revision }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.annotateLogs(Effect.logWarning('The Commerce enrollment sweeper could not claim this sweep'), {
          portalEnrollmentAttemptId: entry.attempt.portalEnrollmentAttemptId,
          reason: String(cause),
        }).pipe(Effect.as(false)),
      onSuccess: Option.match({
        onNone: () => Effect.succeed(false),
        // The journal now holds this Attempt's budget, so the in-process counter has nothing to say.
        onSome: () => advanceEntry(state, inner, { ...entry, journalled: true, sweeps: 0 }),
      }),
    }),
  );

/** One due Attempt: advanced under whichever budget this tick's listing left it under. */
const sweepEntry = (
  state: SweeperState,
  inner: Continuation,
  due: DueSweep,
  claimTtlMillis: number,
): Effect.Effect<boolean> =>
  Option.match(due.revision, {
    // The journal is silent about this Attempt on this tick. One it has named before and is not
    // naming now is not owed a transition any more — its durable budget is spent, or it settled —
    // so the fast path lets it go instead of working it on a count nothing can see. One the journal
    // has never named is a halt this process registered and no listing has reached yet, and only
    // there is the bounded in-process budget the thing that stops a fruitless repeat.
    onNone: () =>
      due.entry.journalled || due.entry.sweeps >= SWEEP_BUDGET
        ? release(state, due.entry).pipe(Effect.as(false))
        : advanceEntry(state, inner, { ...due.entry, sweeps: due.entry.sweeps + 1 }),
    onSome: (revision) => claimedAdvance(state, inner, due.entry, revision, claimTtlMillis),
  });

const cursorAfter = (attempts: readonly DueEnrollmentAttempt[]): Option.Option<DueEnrollmentAttemptCursor> =>
  Option.map(Option.fromNullishOr(attempts.at(-1)), (last) => ({
    portalEnrollmentAttemptId: last.portalEnrollmentAttemptId,
    updatedAt: last.updatedAt,
  }));

/**
 * One durable page. An unreadable journal is reported and the tick keeps whatever it already read:
 * a database that answered three pages and then refused must not cost the tick those three.
 */
const listDuePage = (
  inner: Continuation,
  after: Option.Option<DueEnrollmentAttemptCursor>,
  pageLimit: number,
  staleAfterMillis: number,
): Effect.Effect<DurableListing> =>
  inner.listDue({ after, limit: pageLimit, maxSweeps: SWEEP_BUDGET, staleAfterMillis }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => Effect.succeed<DurableListing>({ attempts: [], unreadable: Option.some(String(cause)) }),
      onSuccess: (attempts) => Effect.succeed<DurableListing>({ attempts, unreadable: Option.none() }),
    }),
  );

/** Everything one tick's paging is decided from, apart from where it has got to. */
interface DuePaging {
  readonly inner: Continuation;
  readonly pageLimit: number;
  readonly staleAfterMillis: number;
}

/**
 * The journal's own answer to what is still owed a transition, read in keyset order until the tick
 * has its appetite. Every row it hands back is one this sweeper may advance: an Attempt whose sweep
 * budget is spent is excluded by the listing itself, so a run of them — always the oldest, so
 * always first in the order — can no longer fill a page ahead of the newer work behind it.
 */
const durableDuePage = (
  paging: DuePaging,
  listing: DurableListing,
  after: Option.Option<DueEnrollmentAttemptCursor>,
  page: number,
): Effect.Effect<DurableListing> => {
  if (page >= SWEEP_MAX_PAGES || listing.attempts.length >= SWEEP_TICK_LIMIT) {
    return Effect.succeed(listing);
  }
  return listDuePage(paging.inner, after, paging.pageLimit, paging.staleAfterMillis).pipe(
    Effect.flatMap((listed) => {
      if (Option.isSome(listed.unreadable)) {
        return Effect.succeed<DurableListing>({ attempts: listing.attempts, unreadable: listed.unreadable });
      }
      const next: DurableListing = {
        attempts: [...listing.attempts, ...listed.attempts],
        unreadable: listing.unreadable,
      };
      // A short page is the end of the journal, so there is nothing left to resume after.
      return listed.attempts.length < paging.pageLimit
        ? Effect.succeed(next)
        : durableDuePage(paging, next, cursorAfter(listed.attempts), page + 1);
    }),
  );
};

const durableDue = (paging: DuePaging): Effect.Effect<DurableListing> =>
  durableDuePage(paging, { attempts: [], unreadable: Option.none() }, Option.none(), 0);

/**
 * What this tick advances: every Attempt the journal reports as due, and every tracked Attempt the
 * journal did not name whose last activity is older than the stale window.
 *
 * The journal's word is never overruled by the registry's. A due row was already aged by the
 * database's own clock against the same window, and it was answered while this process held a
 * durable claim on nothing: it is work this Attempt is owed. An in-process entry says only that
 * something touched the Attempt here, which a halt that changes nothing durable does on every
 * single call — so a client polling the read route, whose resume halts with `IN_FLIGHT`, would
 * otherwise refresh the entry forever and veto the very row the journal keeps offering. What stops
 * a fruitless repeat is the durable sweep budget the claim charges, not this process's memory.
 *
 * The registry therefore only adds Attempts the journal has not named — the halts this process
 * registered that no listing has reached yet — and those carry the bounded in-process budget.
 */
const dueEntries = (
  registry: Registry,
  durable: readonly DueEnrollmentAttempt[],
  now: number,
  staleAfterMillis: number,
): readonly DueSweep[] => {
  const due = new Map<string, DueSweep>();
  for (const listed of durable) {
    const attempt: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: listed.portalEnrollmentAttemptId,
      tenantId: listed.tenantId,
    };
    const key = registryKey(attempt);
    const tracked = registry.get(key);
    due.set(key, {
      entry: {
        attempt,
        journalled: true,
        lastActivityMillis: tracked?.lastActivityMillis ?? DateTime.toEpochMillis(listed.updatedAt),
        sweeps: tracked?.sweeps ?? 0,
      },
      revision: Option.some(listed.revision),
    });
  }
  for (const entry of registry.values()) {
    const key = registryKey(entry.attempt);
    if (!due.has(key) && now - entry.lastActivityMillis >= staleAfterMillis) {
      due.set(key, { entry, revision: Option.none() });
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
  pageLimit: number,
  staleAfterMillis: number,
): Effect.fn.Return<CommerceEnrollmentContinuationSweepResult> {
  const [now, registry] = yield* Effect.all([Clock.currentTimeMillis, Ref.get(state.registry)], { concurrency: 2 });
  const durable = yield* durableDue({ inner, pageLimit, staleAfterMillis });
  if (Option.isSome(durable.unreadable)) {
    yield* Effect.annotateLogs(
      Effect.logWarning('The Commerce enrollment sweeper could not read the durable Attempt journal'),
      { listed: durable.attempts.length, reason: durable.unreadable.value },
    );
  }
  const due = dueEntries(registry, durable.attempts, now, staleAfterMillis);
  // The claim lives exactly as long as the window that made the row due, so the replica that took
  // it is the only one working it right up to the moment the row would be offered again anyway.
  const advanced = yield* Effect.forEach(due, (entry) => sweepEntry(state, inner, entry, staleAfterMillis), {
    concurrency: SWEEP_CONCURRENCY,
  });
  const swept = advanced.filter(Boolean).length;
  const tracked = yield* Ref.get(state.registry);
  return { released: advanced.length - swept, swept, tracked: tracked.size };
});

export const commerceEnrollmentContinuationSweeperFor = Effect.fnUntraced(
  function* commerceEnrollmentContinuationSweeperFor(options: CommerceEnrollmentContinuationSweeperOptions) {
    const registry = yield* Ref.make<Registry>(new Map());
    const state: SweeperState = { registry };
    const inner = options.continuation;
    const pageLimit = options.pageLimit ?? SWEEP_PAGE_LIMIT;
    const staleAfterMillis = options.staleAfterMillis ?? LEASE_WINDOW_MS;
    const sweeper: CommerceEnrollmentContinuationSweeper = {
      continuation: {
        advance: (attempt) => trackedAdvance(state, inner, { attempt, journalled: false, sweeps: 0 }),
        claimSweep: (input) => inner.claimSweep(input),
        listDue: (input) => inner.listDue(input),
      },
      sweep: sweepOnce(state, inner, pageLimit, staleAfterMillis),
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
