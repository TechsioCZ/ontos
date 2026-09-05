// @effect-diagnostics asyncFunction:off
/* eslint-disable promise/prefer-await-to-callbacks -- Drizzle owns this Promise callback boundary. */
import { Cause, Context, Effect, Exit } from 'effect';
import type { CoreDatabaseExecutor, CoreTransaction } from './types.ts';

type TransactionRollbackToken = symbol;

/**
 * The only exception-shaped value allowed by this bridge. It exists solely to
 * make Drizzle roll back after an Effect body returns a failed Exit; it never
 * crosses back into the Effect error channel.
 */
class TransactionRollback<Error> {
  readonly cause: Cause.Cause<Error>;
  readonly #token: TransactionRollbackToken;

  constructor(token: TransactionRollbackToken, cause: Cause.Cause<Error>) {
    this.#token = token;
    this.cause = cause;
  }

  matches(token: TransactionRollbackToken): boolean {
    return this.#token === token;
  }
}

/** A rejection from the foreign Drizzle transaction boundary. */
export class CoreTransactionBridgeFailure {
  readonly _tag = 'CoreTransactionBridgeFailure';
  readonly original: unknown;

  constructor(original: unknown) {
    this.original = original;
  }
}

const runTransaction = <Value, Error, Requirements>(
  executor: CoreDatabaseExecutor,
  context: Context.Context<Requirements>,
  body: (transaction: CoreTransaction) => Effect.Effect<Value, Error, Requirements>,
  token: TransactionRollbackToken,
  signal: AbortSignal,
): Promise<Value> =>
  executor.transaction((transaction) =>
    Effect.runPromiseExitWith(context)(
      Effect.suspend(() => body(transaction)),
      { signal },
    ).then((exit) =>
      Exit.isSuccess(exit)
        ? exit.value
        : Promise.reject(new TransactionRollback(token, exit.cause)),
    ),
  );

/**
 * Runs one complete Effect transaction body through Drizzle's Promise API.
 *
 * The caller context is captured once. The body is then evaluated exactly once
 * in one runtime-captured fiber, while the foreign Promise callback remains the
 * only boundary where an Effect run is required. Interruption aborts the body
 * signal and the callback cleanup waits for Drizzle's transaction Promise to
 * settle before the outer fiber is released.
 */
export const runCoreTransaction = <Value, Error, Requirements>(
  executor: CoreDatabaseExecutor,
  body: (transaction: CoreTransaction) => Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error | CoreTransactionBridgeFailure, Requirements> =>
  Effect.gen(function* runCoreTransactionEffect() {
    const context = yield* Effect.context<Requirements>();
    const rollbackToken = Symbol('@app/core-runtime/db/transaction-bridge/rollback');
    const isOwnRollback = (error: unknown): error is TransactionRollback<Error> =>
      error instanceof TransactionRollback && error.matches(rollbackToken);

    return yield* Effect.callback<Value, Error | CoreTransactionBridgeFailure, Requirements>(
      (resume, signal) => {
        const transaction = Promise.resolve().then(() =>
          runTransaction(executor, context, body, rollbackToken, signal),
        );
        transaction.then(
          (value) => resume(Effect.succeed(value)),
          (error: unknown) => {
            if (isOwnRollback(error)) {
              resume(Effect.failCause(error.cause));
            } else {
              resume(Effect.fail(new CoreTransactionBridgeFailure(error)));
            }
          },
        );
        return Effect.promise(() =>
          transaction.then(
            () => undefined,
            () => undefined,
          ),
        );
      },
    );
  });
