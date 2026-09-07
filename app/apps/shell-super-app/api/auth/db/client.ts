import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
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
  readonly end: (callback?: never) => Promise<void>;
}

const connectionFailure = (cause: unknown) =>
  Object.defineProperty(
    new AuthDatabaseConnectionError({
      reason: 'Unable to initialize the authentication PostgreSQL pool',
    }),
    'cause',
    {
      configurable: false,
      enumerable: false,
      value: cause,
      writable: false,
    },
  );

const invokePromiseWithoutSignal =
  <Value>(operation: () => PromiseLike<Value>) =>
  (_signal: AbortSignal): PromiseLike<Value> =>
    operation();

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, AuthDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: connectionFailure,
      try: acquire,
    }),
    (pool) => Effect.promise(invokePromiseWithoutSignal(pool.end.bind(pool, undefined))),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

export const makeAuthDatabase = (
  configuration: AuthConfigValue,
  poolFactory: PoolFactory = defaultPoolFactory,
) =>
  acquirePoolResource(() =>
    poolFactory({
      connectionString: configuration.connectionString,
    }),
  ).pipe(
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
