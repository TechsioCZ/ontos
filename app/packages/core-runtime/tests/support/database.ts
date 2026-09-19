import { PgClient } from '@effect/sql-pg';
import type { AnyRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer } from 'effect';
import type { Context } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { testSqlConnection } from './sql-connection.ts';

/** Native SQL connection fixture; Drizzle and Effect own query and transaction execution. */
export const makeTestDatabase = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) =>
  Effect.scoped(
    Effect.gen(function* makeNativeTestDatabase() {
      const connection = testSqlConnection(execute);
      const reactivity = yield* Reactivity.make;
      const client = yield* PgClient.makeWith({
        acquirer: Effect.succeed(connection),
        config: {},
        listenAcquirer: Effect.die('This fixture does not support notifications'),
        transactionAcquirer: Effect.succeed(connection),
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity), Effect.orDie);
      return yield* makeWithDefaults({ relations: coreRelations }).pipe(
        Effect.provideService(PgClient.PgClient, client),
      );
    }),
  );

/** The caller owns the pool and keeps this scope open until its tests finish. */
export const makeTestDatabaseFromPool = <Relations extends AnyRelations>(pool: Pool, relations: Relations) =>
  Effect.gen(function* makePoolTestDatabase() {
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.fromPool({
      acquire: Effect.succeed(pool),
    }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
    return yield* makeWithDefaults({ relations }).pipe(Effect.provideService(PgClient.PgClient, client));
  });

export type TestDatabaseFromPool<Relations extends AnyRelations> = Effect.Success<
  ReturnType<typeof makeTestDatabaseFromPool<Relations>>
>;

/**
 * Layer-shaped `makeTestDatabaseFromPool`, for non-test-file consumers (e.g. shared fixtures)
 * that must depend on the contextual service rather than importing the constructor directly.
 */
export const layerTestDatabaseFromPool = <Relations extends AnyRelations, Self>(
  key: Context.Key<Self, TestDatabaseFromPool<Relations>>,
  pool: Pool,
  relations: Relations,
) => Layer.effect(key, makeTestDatabaseFromPool(pool, relations));

/** Fresh pools per execution; the caller's scope releases them after test cleanup. */
export const testDatabasePools = Effect.gen(function* acquireTestDatabasePools() {
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* acquirePoolResource(() => new Pool({ connectionString: connections.admin.connectionString }));
  const runtimePool = yield* acquirePoolResource(
    () => new Pool({ connectionString: connections.runtime.connectionString }),
  );
  return { admin, runtimePool };
});
