// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { DatabaseConfig } from './config.ts';
import type { DatabaseConfigValue } from './config.ts';
import { DatabaseConnectionError } from './connection-error.ts';
import { coreRelations } from './schema.ts';
import type { CoreDatabaseExecutor } from './types.ts';

export { DatabaseConnectionError } from './connection-error.ts';

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

export const makeCoreDatabase = (
  configuration: DatabaseConfigValue,
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.Effect<(typeof CoreDatabase)['Service'], DatabaseConnectionError, Scope.Scope> =>
  acquirePoolResource(() =>
    poolFactory({
      connectionString: configuration.connectionString,
    }),
  ).pipe(
    Effect.map((pool) => ({
      executor: drizzle({
        client: pool,
        relations: coreRelations,
      }),
    })),
  );

export const CoreDatabaseLive = Layer.effect(
  CoreDatabase,
  Effect.gen(function* makeCoreDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCoreDatabase(configuration);
  }),
);
