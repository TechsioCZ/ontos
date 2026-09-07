// @effect-diagnostics asyncFunction:off -- Drizzle Promise callback and settlement boundary; expires: 2026-12-31.
import { Cause, Data, Duration, Effect, Exit, Schema } from 'effect';
import type { CoreDatabaseExecutor, CoreTransaction } from './types.ts';

export type CoreTransactionConfig = NonNullable<Parameters<CoreDatabaseExecutor['transaction']>[1]>;

/** A foreign Drizzle boundary failure or a committed outcome after interruption. */
export class CoreTransactionBridgeFailure extends Schema.TaggedError<CoreTransactionBridgeFailure>()(
  'CoreTransactionBridgeFailure',
  {
    original: Schema.optionalKey(Schema.Unknown),
    outcome: Schema.Literals(['unknown', 'committed']),
  },
) {}

// This rejection is a private rollback signal, never a public Effect failure.
const rejectRollback = (
  token: InstanceType<ReturnType<typeof Data.TaggedError<'TransactionRollback'>>>,
): never => {
  throw token;
};

/**
 * Runs one complete Effect transaction body through Drizzle's Promise API.
 *
 * The caller context is captured once. The body is then evaluated exactly once
 * in one runtime-captured fiber, while the foreign Promise callback remains the
 * only boundary where an Effect run is required. Interruption aborts the body
 * signal and the callback cleanup waits for Drizzle's transaction Promise to
 * settle before the outer fiber is released.
 */
// Unlike traced Effect.fn, this preserves the caller span and original Cause identity.
export const runCoreTransaction = Effect.fnUntraced(function* runCoreTransactionEffect<
  Value,
  TError,
  Requirements,
>(
  executor: {
    readonly transaction: CoreDatabaseExecutor['transaction'];
  },
  body: (transaction: CoreTransaction) => Effect.Effect<Value, TError, Requirements>,
  config?: CoreTransactionConfig,
): Effect.fn.Return<Value, TError | CoreTransactionBridgeFailure, Requirements> {
  const context = yield* Effect.context<Requirements>();
  const rollbackToken = new (Data.TaggedError('TransactionRollback'))(undefined);
  let interruptedSettlementCause: Cause.Cause<TError | CoreTransactionBridgeFailure> | undefined;
  return yield* Effect.callback<Value, TError | CoreTransactionBridgeFailure, Requirements>(
    (resume, signal) => {
      let failedBodyExit: Exit.Failure<Value, TError> | undefined;
      const runBody = async (tx: CoreTransaction): Promise<Value> => {
        const exit = await Effect.runPromiseExitWith(context)(
          Effect.suspend(() => body(tx)),
          { signal },
        );
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        failedBodyExit = exit;
        return rejectRollback(rollbackToken);
      };
      const runDriver = async () => await executor.transaction(runBody, config);
      const transaction = runDriver()
        .then((value) => {
          if (signal.aborted) {
            interruptedSettlementCause = Cause.fail(
              new CoreTransactionBridgeFailure({ outcome: 'committed' }),
            );
          }
          resume(Effect.succeed(value));
        })
        .catch((error) => {
          if (error === rollbackToken && failedBodyExit !== undefined) {
            if (signal.aborted) {
              interruptedSettlementCause = failedBodyExit.cause;
            }
            resume(Effect.failCause(failedBodyExit.cause));
          } else {
            const driverCause = Cause.fail(
              new CoreTransactionBridgeFailure({ original: error, outcome: 'unknown' }),
            );
            const settlementCause =
              failedBodyExit === undefined
                ? driverCause
                : Cause.combine(failedBodyExit.cause, driverCause);
            if (signal.aborted) {
              interruptedSettlementCause = settlementCause;
            }
            resume(Effect.failCause(settlementCause));
          }
        });
      // Cancellation cannot safely release the outer fiber before the driver settles.
      return Effect.promise(async () => await transaction).pipe(
        Effect.timeoutOrElse({ duration: Duration.infinity, orElse: () => Effect.void }),
      );
    },
  ).pipe(
    // Callback cleanup waits for settlement; onExit supplies the original interrupt Cause.
    // Effect 4 replaces the Cause when cleanup fails, so combine explicitly here.
    Effect.onExit((exit) =>
      Exit.isFailure(exit) && interruptedSettlementCause !== undefined
        ? Effect.failCause(Cause.combine(exit.cause, interruptedSettlementCause))
        : Effect.void,
    ),
  );
});
