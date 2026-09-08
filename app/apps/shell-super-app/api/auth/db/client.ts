import { configureDatabasePool } from '@app/core-runtime';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

import { AuthConfig } from '../config.ts';
import type { AuthConfigValue } from '../config.ts';
import { AuthDatabaseConnectionError } from './connection-error.ts';
import { authDatabaseSchema, authRelations } from './schema.ts';
import type {
  AuthDatabaseExecutor,
  BetterAuthDatabaseAdapter,
} from './types.ts';

export class AuthDatabase extends Context.Service<
  AuthDatabase,
  {
    readonly adapter: BetterAuthDatabaseAdapter;
    readonly executor: AuthDatabaseExecutor;
  }
>()('@app/shell-super-app/api/auth/db/client/AuthDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

const connectionFailure = (cause: unknown) =>
  Object.defineProperty(
    new AuthDatabaseConnectionError({
      reason: 'Unable to initialize the authentication PostgreSQL pool',
    }),
    'cause',
    { value: cause }
  );

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource
): Effect.Effect<Resource, AuthDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: connectionFailure,
      try: acquire,
    }),
    // pg overloads end(callback); pass no arguments so an AbortSignal cannot become a callback.
    // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign Promise boundary.
    (pool) => Effect.promise(() => pool.end())
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) =>
  new Pool(configuration);

const mapPoolConfigurationError = (error: { readonly reason: string }) =>
  new AuthDatabaseConnectionError({
    reason: `Unable to initialize the authentication PostgreSQL pool: ${error.reason}`,
  });

export const makeAuthDatabase = Effect.fn('AuthDatabase.make')(
  function* makeDatabase(
    configuration: Pick<AuthConfigValue, 'connectionString'>,
    poolFactory: PoolFactory = defaultPoolFactory
  ): Effect.fn.Return<
    (typeof AuthDatabase)['Service'],
    AuthDatabaseConnectionError,
    Scope.Scope
  > {
    const poolConfiguration = yield* configureDatabasePool(
      Redacted.make(configuration.connectionString)
    ).pipe(Effect.mapError(mapPoolConfigurationError));
    const pool = yield* acquirePoolResource(() =>
      poolFactory(poolConfiguration)
    );
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.fromPool({
      acquire: Effect.succeed(pool),
    }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(connectionFailure)
    );
    const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client)
    );
    return {
      executor,
      // Better Auth owns this Promise-based adapter; application queries use the native executor.
      adapter: drizzleAdapter(
        drizzle({ client: pool, relations: authRelations }),
        {
          provider: 'pg',
          schema: authDatabaseSchema,
          transaction: true,
        }
      ),
    };
  }
);

export const AuthDatabaseLive = Layer.effect(
  AuthDatabase,
  Effect.gen(function* makeAuthDatabaseService() {
    const configuration = yield* AuthConfig;
    return yield* makeAuthDatabase(configuration);
  })
);
