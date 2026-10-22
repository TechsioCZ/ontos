import { Data, Effect, Exit } from 'effect';
import type { Cause } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import { installOperationalScope } from './scoped-transaction.ts';
import type { ScopedTransactionExecutor } from './scoped-transaction.ts';
import { insideDatabaseTransaction } from './transaction-io-guard.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from './types.ts';
import { OwnerTransactionUnavailable } from './owner-transaction-unavailable.ts';

/**
 * A short owner transaction outside an operation's own transaction: admitted by the same composition revision,
 * with the same operational scope installed, and guarded like the operation's transaction. It is for evaluations
 * that interleave remote owner calls with owner-state reads: each owner-state read gets its own short transaction,
 * and no remote call ever runs while one is open.
 */
export type OwnerTransaction = <Value, Failure, Requirements>(
  step: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
) => Effect.Effect<Value, Failure | OperationContextUnavailable | OwnerTransactionUnavailable, Requirements>;

/** The owner step's own outcome, carried out of the rolled-back transaction unchanged. */
class OwnerStepFailed<Failure> extends Data.TaggedError('OwnerStepFailed')<{
  readonly ownerCause: Cause.Cause<Failure>;
}> {}

const unavailable = (reason: string, cause?: unknown): OwnerTransactionUnavailable =>
  Object.defineProperty(new OwnerTransactionUnavailable({ code: 'owner_transaction_unavailable', reason }), 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
  });

const admissionUnavailable = (cause: unknown) =>
  unavailable('The approved Application Composition no longer admits this owner transaction', cause);

/** Builds the short owner transactions of one governed operation. */
export const ownerTransactionFor =
  <AdmissionFailure>(owner: {
    /** Admits the operation's composition revision inside each short transaction. */
    readonly admit: (transaction: CoreTransaction) => Effect.Effect<unknown, AdmissionFailure>;
    readonly executor: CoreDatabaseExecutor;
    readonly operationKey: string;
    readonly scope: OperationalScope;
  }): OwnerTransaction =>
  <Value, Failure, Requirements>(
    step: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
  ) => {
    // The owner step's failure rolls the transaction back and then surfaces exactly as the owner raised it.
    const ownerStep = (scoped: ScopedTransactionExecutor) =>
      Effect.flatMap(Effect.exit(step(scoped)), (exit) =>
        Exit.isSuccess(exit)
          ? Effect.succeed(exit.value)
          : Effect.fail(new OwnerStepFailed({ ownerCause: exit.cause })),
      );
    return owner.executor
      .transaction((transaction) =>
        owner.admit(transaction).pipe(
          Effect.mapError(admissionUnavailable),
          Effect.andThen(installOperationalScope(transaction, owner.scope)),
          Effect.flatMap(ownerStep),
          // Between BEGIN and COMMIT nothing reaches SpiceDB, a module, the network, or a second pooled connection.
          insideDatabaseTransaction(owner.operationKey),
        ),
      )
      .pipe(
        Effect.catchTags({
          OwnerStepFailed: (failed: OwnerStepFailed<Failure>) => Effect.failCause(failed.ownerCause),
          SqlError: (cause) => Effect.fail(unavailable('The short owner transaction failed', cause)),
        }),
      );
  };
