import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { AuthConfig } from '../config.ts';
import type { AuthConfigValue } from '../config.ts';
import { AuthDatabaseConnectionError } from './connection-error.ts';
import { authDatabaseSchema, authRelations } from './schema.ts';
import type { AuthDatabaseExecutor, BetterAuthDatabaseAdapter } from './types.ts';

export class AuthDatabase extends Context.Service<
  AuthDatabase,
  {
    readonly adapter: BetterAuthDatabaseAdapter;
    readonly executor: AuthDatabaseExecutor;
  }
>()('@app/shell-super-app/api/auth/db/client/AuthDatabase') {}

const connectionFailure = (cause: unknown): AuthDatabaseConnectionError =>
  new AuthDatabaseConnectionError({ cause, reason: 'Unable to initialize the authentication PostgreSQL pool' });

const mapPoolConfigurationError = (error: { readonly reason: string }) =>
  new AuthDatabaseConnectionError({
    reason: `Unable to initialize the authentication PostgreSQL pool: ${error.reason}`,
  });

export const makeAuthDatabase = Effect.fn('AuthDatabase.make')(function* makeDatabase(
  configuration: Pick<AuthConfigValue, 'connectionString'>,
): Effect.fn.Return<(typeof AuthDatabase)['Service'], AuthDatabaseConnectionError, Scope.Scope> {
  const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
    Effect.mapError(mapPoolConfigurationError),
  );
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.make(poolConfiguration).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
  return { adapter, executor };
});

export const AuthDatabaseLive = Layer.effect(
  AuthDatabase,
  Effect.gen(function* makeAuthDatabaseService() {
    const configuration = yield* AuthConfig;
    return yield* makeAuthDatabase(configuration);
  }),
);
