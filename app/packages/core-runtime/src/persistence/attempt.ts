import { Effect } from 'effect';

/** Builds a lazy server-only Effect adapter for owner-local PromiseLike persistence operations. */
export const makePersistenceAttempt =
  <Failure>(mapFailure: (cause: unknown) => Failure) =>
  <Value>(operation: () => PromiseLike<Value>): Effect.Effect<Value, Failure> =>
    // eslint-disable-next-line effect-native/require-timeout-on-external-effect -- Owners retain timeout and retry policy; #362 forbids either here.
    Effect.tryPromise({ catch: mapFailure, try: operation });
