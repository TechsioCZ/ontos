// @effect-diagnostics asyncFunction:off
import { makeDatabasePoolConfiguration } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { AuthConfig } from '../config.ts';
import type { AuthConfigValue } from '../config.ts';
import { AuthDatabaseConnectionError } from './connection-error.ts';
import { authRelations } from './schema.ts';
import type { AuthDatabaseExecutor } from './types.ts';

export class AuthDatabase extends Context.Service<
  AuthDatabase,
  {
    readonly executor: AuthDatabaseExecutor;
  }
>()('@app/shell-super-app/api/auth/db/client/AuthDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, AuthDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new AuthDatabaseConnectionError({
          reason: 'Unable to initialize the authentication PostgreSQL pool',
        }),
      try: acquire,
    }),
    (pool) => Effect.promise(async () => await pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

export const makeAuthDatabase = (
  configuration: AuthConfigValue,
  poolFactory: PoolFactory = defaultPoolFactory,
) =>
  makeDatabasePoolConfiguration(Redacted.value(configuration.connectionString)).pipe(
    Effect.mapError(
      () =>
        new AuthDatabaseConnectionError({
          reason: 'Unable to initialize the authentication PostgreSQL pool',
        }),
    ),
    Effect.flatMap((poolConfiguration) =>
      acquirePoolResource(() => poolFactory(poolConfiguration)),
    ),
    Effect.map((pool) => ({
      executor: drizzle({
        client: pool,
        relations: authRelations,
      }),
    })),
  );

export const AuthDatabaseLive = Layer.effect(
  AuthDatabase,
  Effect.gen(function* makeAuthDatabaseService() {
    const configuration = yield* AuthConfig;
    return yield* makeAuthDatabase(configuration);
  }),
);
