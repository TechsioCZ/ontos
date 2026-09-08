import {
  findPostgresFailure,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { Effect, Option } from 'effect';
import { Pool } from 'pg';

/** Asserts that PostgreSQL itself raised the expected SQLSTATE, not that a driver shape matched. */
export const hasPostgreSqlCode =
  (expected: string) =>
  (error: Parameters<typeof findPostgresFailure>[0]): boolean =>
    Option.exists(findPostgresFailure(error), ({ code }) => code === expected);

/** Binds both roles to one schema; the test scope closes databases before their owned pools. */
export const openBoundaryDatabases = <Database, E, R>(
  openDatabase: (pool: Pool) => Effect.Effect<Database, E, R>,
  runtimeConnections = 1
) =>
  Effect.gen(function* openDatabases() {
    const connections = yield* loadDatabaseConnectionPair();
    const adminPool = yield* Effect.acquireRelease(
      Effect.sync(
        () => new Pool({ connectionString: connections.admin.connectionString })
      ),
      (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie)
    );
    const runtimePool = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: connections.runtime.connectionString,
            max: runtimeConnections,
          })
      ),
      (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie)
    );
    const admin = yield* openDatabase(adminPool);
    const runtime = yield* openDatabase(runtimePool);
    return { admin, runtime };
  });
