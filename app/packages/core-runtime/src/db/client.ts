// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { DatabaseConfig } from './config.ts';
import type { DatabaseConfigValue } from './config.ts';
import { DatabaseConnectionError } from './connection-error.ts';
import { configureDatabasePool } from './pool-configuration.ts';
import type { DatabasePoolDeadlines } from './pool-configuration.ts';
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
    (pool) => Effect.promise(async () => await pool.end()),
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
  return {
    executor: drizzle({
      client: pool,
      relations: coreRelations,
    }),
  };
});

export const CoreDatabaseLive = Layer.effect(
  CoreDatabase,
  Effect.gen(function* makeCoreDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCoreDatabase(configuration);
  }),
);
