import { Effect } from 'effect';
import { insideDatabaseTransaction } from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';

/** Inject owner ports into preparation while retaining Core's write-step I/O guard. */
export const runPreparedAction = <
  Payload,
  Context,
  Prepared,
  Result,
  PrepareError,
  WriteError,
  PrepareServices,
  WriteServices,
>(
  prepare: (payload: Payload, context: NoInfer<Context>) => Effect.Effect<Prepared, PrepareError, PrepareServices>,
  write: (
    payload: Payload,
    context: NoInfer<Context> & { readonly prepared: Prepared },
  ) => Effect.Effect<Result, WriteError, WriteServices>,
  payload: Payload,
  context: Context,
) =>
  prepare(payload, context).pipe(
    Effect.flatMap((prepared) =>
      write(payload, { ...context, prepared }).pipe(insideDatabaseTransaction('test.prepared-action')),
    ),
  );
