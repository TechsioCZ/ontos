import {
  EffectDrizzleAuthTransactionHooks,
  makeEffectDrizzleAuthAdapter,
} from '@app/better-auth-effect-drizzle/server';
import type { EffectDrizzleAuthTransaction } from '@app/better-auth-effect-drizzle/server';
import {
  DatabaseConfig,
  SHARED_RUNTIME_IDENTITY,
  acceptPersonInvitationFromTransaction,
  configureDatabasePool,
  verifyDatabaseSessionRole,
} from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { BetterAuthNativeAdapter } from '../better-auth-native-adapter.ts';
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
  yield* verifyDatabaseSessionRole(client, SHARED_RUNTIME_IDENTITY.role).pipe(Effect.mapError(connectionFailure));
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema).pipe(
    Effect.provideService(EffectDrizzleAuthTransactionHooks, {
      afterConsume: Effect.fn('AuthDatabase.acceptConsumedInvitation')(function* acceptConsumedInvitation(
        transaction: EffectDrizzleAuthTransaction,
        model: string,
        row: Parameters<(typeof EffectDrizzleAuthTransactionHooks)['Service']['afterConsume']>[2],
      ) {
        if (
          model !== 'verification' ||
          !Schema.is(Schema.String)(row['identifier']) ||
          !row['identifier'].startsWith('reset-password:')
        ) {
          return;
        }
        // Only consumeOne inside the native password transaction reaches this hook. Deletes/cleanup and sign-in do not.
        // Decode no token-bearing field: credentials and invitation secrets must not enter failures or audit evidence.
        const consumed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            expiresAt: Schema.Date,
            id: Schema.String,
            value: Schema.String,
          }),
        )({ expiresAt: row['expiresAt'], id: row['id'], value: row['value'] });
        yield* acceptPersonInvitationFromTransaction(transaction, {
          expiresAt: consumed.expiresAt,
          providerSubjectId: consumed.value,
          verificationId: consumed.id,
        });
      }, Effect.orDie),
    }),
  );
  return { adapter, executor };
});

/** Project only the native SDK factory from this request's Auth persistence; never expose its executor. */
export const BetterAuthNativeAdapterLive = Layer.effect(
  BetterAuthNativeAdapter,
  Effect.gen(function* makeBetterAuthNativeAdapter() {
    const database = yield* AuthDatabase;
    return { forOptions: database.adapter };
  }),
);

export const AuthDatabaseLive = Layer.effect(
  AuthDatabase,
  Effect.gen(function* makeAuthDatabaseService() {
    const configuration = yield* AuthConfig;
    return yield* makeAuthDatabase(configuration);
  }),
);

/**
 * Opens the authentication database from the runtime role's `DatabaseConfig` alone, for operator
 * tools such as the schema verifier that never sign sessions and so hold no Better Auth secret.
 */
export const AuthDatabaseFromDatabaseConfigLive = Layer.effect(
  AuthDatabase,
  Effect.gen(function* makeAuthDatabaseFromDatabaseConfig() {
    const configuration = yield* DatabaseConfig;
    return yield* makeAuthDatabase(configuration);
  }),
);
