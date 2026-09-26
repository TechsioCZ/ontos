import { Effect } from 'effect';
import { Statement } from 'effect/unstable/sql';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/** Decides, per compiled statement, whether the database should reject it. */
export type StatementFaultHook = (statement: string) => Effect.Effect<void, SqlError>;

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Installs a per-fiber fault hook through Effect SQL's native statement transformer.
 *
 * The hook sees every statement the effect issues before it reaches the driver. A failing hook
 * replaces the statement with one PostgreSQL rejects with the hook's message, so the fault travels
 * through the real driver, error classification, and transaction rollback path.
 */
export const injectStatementFaults =
  (hook: StatementFaultHook) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(self, Statement.CurrentTransformer, (statement, sql) =>
      hook(statement.compile()[0]).pipe(
        Effect.match({
          onFailure: (error) =>
            sql.unsafe(
              `do $fault$ begin raise exception using errcode = 'XX000', message = ${quoteLiteral(error.message)}; end $fault$`,
            ),
          onSuccess: () => statement,
        }),
      ),
    );
