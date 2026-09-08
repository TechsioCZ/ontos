import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { Effect, Option } from 'effect';
import { Pool } from 'pg';

/** Asserts that PostgreSQL itself raised the expected SQLSTATE, not that a driver shape matched. */
export const hasPostgreSqlCode =
  (expected: string) =>
  (error: Parameters<typeof findPostgresFailure>[0]): boolean =>
    Option.exists(findPostgresFailure(error), ({ code }) => code === expected);

/**
 * A database boundary proves two roles against one schema: an admin connection that seeds and
 * purges fixtures, and a deliberately narrow runtime connection that shows what the runtime role
 * may actually do. The caller owns the schema binding and the scope that closes both pools.
 */
export const openBoundaryDatabases = <Database>(
  openDatabase: (pool: Pool) => Promise<Database>,
  runtimeConnections = 1,
): Promise<{
  readonly admin: Database;
  readonly adminPool: Pool;
  readonly runtime: Database;
  readonly runtimePool: Pool;
}> =>
  runEffectTestPromise(
    Effect.gen(function* openDatabases() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = new Pool({ connectionString: connections.admin.connectionString });
      const runtimePool = new Pool({
        connectionString: connections.runtime.connectionString,
        max: runtimeConnections,
      });
      return {
        admin: yield* Effect.promise(() => openDatabase(adminPool)),
        adminPool,
        runtime: yield* Effect.promise(() => openDatabase(runtimePool)),
        runtimePool,
      };
    }),
  );
