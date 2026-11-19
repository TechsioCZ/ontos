import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
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

const readOperationTime = (transaction: CoreTransaction, statement: SQL) =>
  transaction.execute<{ readonly operation_at: Date }>(statement, 'objects').pipe(
    Effect.mapError(transactionTimeUnavailable),
    Effect.flatMap((rows) => {
      const [row] = rows;
      if (row === undefined || !Predicate.isDate(row.operation_at) || !Number.isFinite(row.operation_at.getTime())) {
        return Effect.fail(transactionTimeUnavailable());
      }
      return Effect.succeed(DateTime.fromDateUnsafe(row.operation_at));
    }),
  );

/** Reads PostgreSQL's immutable start time for this open transaction. */
export const trustedTransactionTime = (transaction: CoreTransaction) =>
  readOperationTime(transaction, sql`select transaction_timestamp() as operation_at`);

/**
 * Reads PostgreSQL's `statement_timestamp()` of this one statement: the start of the statement Core
 * issues now, so it is never earlier than any lock wait (a composition fence) earlier in the same
 * transaction, unlike `transaction_timestamp()`.
 */
export const trustedStatementTime = (transaction: CoreTransaction) =>
  readOperationTime(transaction, sql`select statement_timestamp() as operation_at`);
