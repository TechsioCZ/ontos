import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/reactivity';

import type { RuntimeDatabaseConfigValue } from './config.ts';
import { DatabaseConfig, loadDatabaseConnectionPair } from './config.ts';
import { DatabaseConnectionError } from './connection-error.ts';
import { openDatabaseClient } from './database-client.ts';
import type { DatabasePoolDeadlines } from './pool-configuration.ts';
import { configureDatabasePool } from './pool-configuration.ts';
import { coreRelations } from './schema.ts';
import { verifySessionRoleOnFirstUse } from './session-identity.ts';
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

/**
 * Every Core client, including private lock sessions, owns its reactivity and guards acquisition. A pooled client
 * may draw from the process-shared pool; a private session always owns its pool, because it holds session state.
 */
export const guardedPgClientLayer = (
  connectionString: Redacted.Redacted,
  session: {
    readonly maxConnections?: number | undefined;
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines> | undefined;
    readonly pooling: 'pooled' | 'private';
  },
) =>
  Layer.effect(
    PgClient.PgClient,
    Effect.gen(function* guardedPgClient() {
      yield* refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool');
      const configuration = yield* configureDatabasePool(
        connectionString,
        session.poolDeadlines,
        session.maxConnections,
      );
      const reactivity = yield* Reactivity.make;
      const client = yield* (
        session.pooling === 'pooled' ? openDatabaseClient(configuration) : PgClient.make(configuration)
      ).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
      return guardPoolAcquisition(client);
    }),
  );

export const makeCoreDatabase = Effect.fn('Client.makeCoreDatabase')(function* makeDatabase(
  configuration: RuntimeDatabaseConfigValue & {
    readonly maxConnections?: number;
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
): Effect.fn.Return<(typeof CoreDatabase)['Service'], DatabaseConnectionError, Scope.Scope> {
  const context = yield* Layer.build(
    guardedPgClientLayer(Redacted.make(configuration.connectionString), {
      maxConnections: configuration.maxConnections,
      poolDeadlines: configuration.poolDeadlines,
      pooling: 'pooled',
    }),
  ).pipe(
    Effect.mapError(
      (cause) => new DatabaseConnectionError({ cause, reason: 'Unable to initialize the native PostgreSQL client' }),
    ),
  );
  // Building the database opens no connection; the first use confirms the enrolled session role.
  const client = verifySessionRoleOnFirstUse(Context.get(context, PgClient.PgClient), configuration.expectedRole);
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
