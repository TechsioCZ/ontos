// @effect-diagnostics runEffectInsideEffect:off
import { db } from '@mvp2/core-runtime/db/client';
import type { CoreTransaction } from '@mvp2/core-runtime/db/types';
import { Cause, Effect, Option } from 'effect';
import { OutboxWorkerError, outboxWorkerError } from './errors.ts';

export const runCoreTransaction = <A, E>(
  body: (tx: CoreTransaction) => Effect.Effect<A, E>,
): Effect.Effect<A, E | OutboxWorkerError> =>
  Effect.tryPromise({
    try: () =>
      db.transaction((tx) =>
        Effect.runPromiseExit(body(tx)).then((exit) => {
          if (exit._tag === 'Success') {
            return exit.value;
          }

          const failure = Cause.failureOption(exit.cause);
          return Promise.reject(Option.isSome(failure) ? failure.value : Cause.squash(exit.cause));
        }),
      ),
    catch: (error) =>
      error instanceof OutboxWorkerError
        ? error
        : outboxWorkerError('Outbox worker transaction failed.', error),
  });
