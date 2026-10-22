import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import type { DatabaseConfigValue } from './config.ts';
import { DatabaseConfig } from './config.ts';
import { DatabaseConnectionError } from './connection-error.ts';
import type { DatabasePoolDeadlines } from './pool-configuration.ts';
import { configureDatabasePool } from './pool-configuration.ts';
import { coreRelations } from './schema.ts';
import { guardPoolAcquisition } from './transaction-io-guard.ts';
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
 * Every runtime PostgreSQL pool, Core's and each owner's: inside a marked database transaction, a statement or
 * transaction that would check out one of its connections dies (`IoInsideDatabaseTransaction`, pool-acquisition).
 */
export const makeGuardedPgClient = (
  options: Parameters<typeof PgClient.make>[0],
): Effect.Effect<PgClient.PgClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  PgClient.make(options).pipe(Effect.map(guardPoolAcquisition));

export const makeCoreDatabase = Effect.fn('Client.makeCoreDatabase')(function* makeDatabase(
  configuration: DatabaseConfigValue & {
    readonly maxConnections?: number;
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
): Effect.fn.Return<(typeof CoreDatabase)['Service'], DatabaseConnectionError, Scope.Scope> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  );
  const reactivity = yield* Reactivity.make;
  const client = yield* makeGuardedPgClient({
    ...poolConfiguration,
    maxConnections: configuration.maxConnections,
  }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(
      (cause) => new DatabaseConnectionError({ cause, reason: 'Unable to initialize the native PostgreSQL client' }),
    ),
  );
  return {
    executor: yield* makeWithDefaults({ relations: coreRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const CoreDatabaseLive = Layer.effect(
  CoreDatabase,
  Effect.gen(function* makeCoreDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCoreDatabase(configuration);
  }),
);
