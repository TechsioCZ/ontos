import { Effect } from 'effect';

/** Operational safety ceiling, not the 200 ms complete-response performance target. */
export const SHELL_SEARCH_REQUEST_BUDGET_MILLIS = 10_000;

/**
 * One owner's whole attempt (assertion, owner call, decode and its one retry together) gets this long. Without it the
 * answer waits for the slowest of all owners, up to the request budget (10 s; the owner transport allows 30 s).
 * 5 s and not less: on stage (2026-11-13) a complete search took 3 to 4.5 s, because every owner queues for the same
 * few database connections, so a shorter deadline would cut healthy owners and make every answer partial. Lower it
 * once per-owner timings are known. A late owner's results are left out and the answer is marked partial.
 */
export const SHELL_SEARCH_PROVIDER_DEADLINE_MILLIS = 5000;

/**
 * Enclose the entire governed request, including admission, retries, queued providers and evidence.
 * Nested safety ceilings cannot extend or restart the enclosing request's timeout. Direct internal
 * callers are bounded too, without hiding dependencies or mutating a fiber's context.
 * Expiry is the caller's typed failure, never a partial response or successful empty collection.
 */
export const withShellSearchRequestBudget = <A, E, R, TimeoutError>(
  program: Effect.Effect<A, E, R>,
  onTimeout: () => TimeoutError,
): Effect.Effect<A, E | TimeoutError, R> =>
  program.pipe(
    Effect.timeoutOrElse({
      duration: SHELL_SEARCH_REQUEST_BUDGET_MILLIS,
      orElse: () => Effect.fail(onTimeout()),
    }),
  );
