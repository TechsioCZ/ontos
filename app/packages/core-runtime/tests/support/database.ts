import { PgClient } from '@effect/sql-pg';
import type { AnyRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Redacted, Scope } from 'effect';
import type { Context } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { testSqlConnection } from './sql-connection.ts';

/** Scripted SQL connection fixture; Drizzle and Effect own query and transaction execution. */
export const makeTestDatabase = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) =>
  Effect.scoped(
    makeWithDefaults({ relations: coreRelations }).pipe(
      Effect.provide(scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute)))),
      Effect.provide(Reactivity.layer),
    ),
  );

/** The caller owns the client and keeps its scope open until its tests finish. */
export const makeTestDatabaseFromClient = <Relations extends AnyRelations>(
  client: PgClient.PgClient,
  relations: Relations,
) => makeWithDefaults({ relations }).pipe(Effect.provideService(PgClient.PgClient, client));

export type TestDatabaseFromClient<Relations extends AnyRelations> = Effect.Success<
  ReturnType<typeof makeTestDatabaseFromClient<Relations>>
>;

/**
 * Layer-shaped `makeTestDatabaseFromClient`, for non-test-file consumers (e.g. shared fixtures)
 * that must depend on the contextual service rather than importing the constructor directly.
 */
export const layerTestDatabaseFromClient = <Relations extends AnyRelations, Self>(
  key: Context.Key<Self, TestDatabaseFromClient<Relations>>,
  client: PgClient.PgClient,
  relations: Relations,
) => Layer.effect(key, makeTestDatabaseFromClient(client, relations));

/**
 * Acquires a resource in a scope of its own, which the caller's scope closes only after every
 * finalizer the caller registers afterwards.
 *
 * Effect's `Pool` cannot open a connection once the scope it was made in has begun closing, so a
 * cleanup finalizer registered in the same scope as a native client waits forever whenever no pooled
 * connection is still open (none was opened, or every one idle-closed). Owning the client in a
 * separate scope, closed by a finalizer registered before any cleanup, keeps it usable for all of them.
 */
export const acquireOutlivingCleanup = <Value, Failure, Requirements>(
  acquire: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* acquireInOwnScope() {
    const resourceScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(resourceScope, exit));
    return yield* acquire.pipe(Scope.provide(resourceScope));
  });

/** Scoped native PostgreSQL client that stays usable for every cleanup finalizer registered after it. */
export const makeTestPgClient = Effect.fn('TestDatabase.makeTestPgClient')(function* makeTestPgClient(
  connectionString: string,
  options: Omit<PgClient.PgPoolConfig, 'url'> = {},
) {
  const reactivity = yield* Reactivity.make;
  return yield* acquireOutlivingCleanup(
    PgClient.make({ ...options, url: Redacted.make(connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    ),
  );
});

/** Scoped single-session client, for tests that observe one backend or hold an explicit transaction. */
export const makeTestPgSession = Effect.fn('TestDatabase.makeTestPgSession')(function* makeTestPgSession(
  connectionString: string,
  options: Omit<PgClient.PgClientConfig, 'url'> = {},
) {
  const reactivity = yield* Reactivity.make;
  return yield* PgClient.makeClient({ ...options, url: Redacted.make(connectionString) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
  );
});

/** Fresh native clients per execution; the caller's scope releases them after test cleanup. */
export const testDatabaseClients = Effect.gen(function* acquireTestDatabaseClients() {
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const runtime = yield* makeTestPgClient(connections.runtime.connectionString);
  return { admin, runtime };
});
