import { sql } from 'drizzle-orm';
import { DateTime, Effect, Predicate } from 'effect';
import type { CoreTransaction } from '../db/types.ts';
import { OperationContextUnavailable } from './errors.ts';

const transactionTimeUnavailable = (cause?: unknown): OperationContextUnavailable => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The trusted operation time could not be established',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** Reads PostgreSQL's immutable start time for this open transaction. */
export const trustedTransactionTime = (transaction: CoreTransaction) =>
  transaction
    .execute<{ readonly operation_at: Date }>(sql`select transaction_timestamp() as operation_at`, 'objects')
    .pipe(
      Effect.mapError(transactionTimeUnavailable),
      Effect.flatMap((rows) => {
        const [row] = rows;
        if (row === undefined || !Predicate.isDate(row.operation_at) || !Number.isFinite(row.operation_at.getTime())) {
          return Effect.fail(transactionTimeUnavailable());
        }
        return Effect.succeed(DateTime.fromDateUnsafe(row.operation_at));
      }),
    );
