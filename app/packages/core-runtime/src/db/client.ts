import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import type { DatabaseConfigValue } from './config.ts';
import { DatabaseConfig, loadDatabaseConnectionPair } from './config.ts';
import { DatabaseConnectionError } from './connection-error.ts';
import type { DatabasePoolDeadlines } from './pool-configuration.ts';
import { configureDatabasePool } from './pool-configuration.ts';
import { coreRelations } from './schema.ts';
import { guardPoolAcquisition, refuseInsideDatabaseTransaction } from './transaction-io-guard.ts';
import type { CoreDatabaseExecutor } from './types.ts';

export { DatabaseConnectionError } from './connection-error.ts';
export type { DatabasePoolDeadlines } from './pool-configuration.ts';

export class CoreDatabase extends Context.Service<
  CoreDatabase,
  {
    readonly executor: CoreDatabaseExecutor;
  }
>()('@app/core-runtime/db/client/CoreDatabase') {}

/** Every Core client, including private lock sessions, owns its reactivity and guards acquisition. */
export const guardedPgClientLayer = (
  connectionString: Redacted.Redacted,
  maxConnections?: number,
  poolDeadlines?: Partial<DatabasePoolDeadlines>,
) =>
  Layer.effect(
    PgClient.PgClient,
    Effect.gen(function* guardedPgClient() {
      yield* refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool');
      const configuration = yield* configureDatabasePool(connectionString, poolDeadlines);
      const reactivity = yield* Reactivity.make;
      const client = yield* PgClient.make({ ...configuration, maxConnections }).pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity),
      );
      return guardPoolAcquisition(client);
    }),
  );

export const makeCoreDatabase = Effect.fn('Client.makeCoreDatabase')(function* makeDatabase(
  configuration: DatabaseConfigValue & {
    readonly maxConnections?: number;
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
): Effect.fn.Return<(typeof CoreDatabase)['Service'], DatabaseConnectionError, Scope.Scope> {
  const context = yield* Layer.build(
    guardedPgClientLayer(
      Redacted.make(configuration.connectionString),
      configuration.maxConnections,
      configuration.poolDeadlines,
    ),
  ).pipe(
    Effect.mapError(
      (cause) => new DatabaseConnectionError({ cause, reason: 'Unable to initialize the native PostgreSQL client' }),
    ),
  );
  const client = Context.get(context, PgClient.PgClient);
  return {
    // A marked transaction body that would check out a second pooled connection dies instead.
    executor: yield* makeWithDefaults({ relations: coreRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

/** A distinct owning Layer prevents admin/runtime clients sharing a memoized database identity. */
export const CoreAdminDatabaseLive = Layer.effect(
  CoreDatabase,
  Effect.gen(function* makeAdministrativeCoreDatabaseService() {
    const configuration = yield* loadDatabaseConnectionPair();
    return yield* makeCoreDatabase(configuration.admin);
  }),
);

export const CoreDatabaseLive = Layer.effect(
  CoreDatabase,
  Effect.gen(function* makeCoreDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCoreDatabase(configuration);
  }),
);
