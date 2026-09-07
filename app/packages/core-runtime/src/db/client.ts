import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import type { DatabaseConfigValue } from './config.ts';
import { DatabaseConfig } from './config.ts';
import { DatabaseConnectionError } from './connection-error.ts';
import type { DatabasePoolDeadlines } from './pool-configuration.ts';
import { configureDatabasePool } from './pool-configuration.ts';
import { coreRelations } from './schema.ts';
import type { CoreDatabaseExecutor } from './types.ts';

export { DatabaseConnectionError } from './connection-error.ts';
export { DEFAULT_DATABASE_POOL_DEADLINES } from './pool-configuration.ts';
export type { DatabasePoolDeadlines } from './pool-configuration.ts';

export class CoreDatabase extends Context.Service<
  CoreDatabase,
  {
    readonly executor: CoreDatabaseExecutor;
  }
>()('@app/core-runtime/db/client/CoreDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

const connectionFailure = (reason: string, cause: unknown): DatabaseConnectionError =>
  Object.defineProperty(new DatabaseConnectionError({ reason }), 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, DatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) =>
        connectionFailure('Unable to initialize the PostgreSQL connection pool', cause),
      try: acquire,
    }),
    // pg overloads end(callback); invoke it with no arguments so the AbortSignal is never a callback.
    // eslint-disable-next-line typescript/promise-function-async -- Effect owns this foreign Promise boundary.
    (pool) => Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

export const makeCoreDatabase = Effect.fn('Client.makeCoreDatabase')(function* makeDatabase(
  configuration: DatabaseConfigValue & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.fn.Return<(typeof CoreDatabase)['Service'], DatabaseConnectionError, Scope.Scope> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  );
  const pool = yield* acquirePoolResource(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError((cause) =>
      connectionFailure('Unable to initialize the native PostgreSQL client', cause),
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
