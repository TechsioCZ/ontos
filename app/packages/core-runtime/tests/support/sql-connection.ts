import { Effect, Stream } from 'effect';
import type { Connection } from 'effect/unstable/sql/SqlConnection';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export const testSqlConnection = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
): Connection => {
  const values = (sql: string, params: readonly unknown[]) =>
    execute(sql, params).pipe(Effect.map((rows) => rows.map(Object.values)));
  const connection: Connection = {
    execute,
    executeRaw: execute,
    executeStream: (sql, params) => Stream.fromIterableEffect(execute(sql, params)),
    executeUnprepared: execute,
    executeValues: values,
    executeValuesUnprepared: values,
  };
  return connection;
};
