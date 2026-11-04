import { Effect } from 'effect';

/** Operational safety ceiling, not the 200 ms complete-response performance target. */
export const SHELL_SEARCH_REQUEST_BUDGET_MILLIS = 10_000;

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
