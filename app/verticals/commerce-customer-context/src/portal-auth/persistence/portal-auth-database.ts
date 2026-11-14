/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle construction is this owner's database factory boundary; expires: 2027-03-31. */
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { configureDatabasePool, openDatabaseClient, DatabaseConfig } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { CommercePortalAuthDatabaseConnectionError } from '../../../api/portal-auth/db/connection-error.ts';
import { CommercePortalAuthConfig } from '../../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../../api/portal-auth/provider/config.ts';
import { commercePortalAuthDatabaseSchema, commercePortalAuthRelations } from './portal-auth-tables.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database-service.ts';

const connectionFailure = (cause: unknown): CommercePortalAuthDatabaseConnectionError =>
  new CommercePortalAuthDatabaseConnectionError({
    cause,
    reason: 'Unable to initialize the Commerce portal authentication PostgreSQL pool',
  });

export const makeCommercePortalAuthDatabase = Effect.fn('CommercePortalAuthDatabase.make')(function* makeDatabase(
  configuration: Pick<CommercePortalAuthConfigValue, 'connectionString'>,
): Effect.fn.Return<
  (typeof CommercePortalAuthDatabase)['Service'],
  CommercePortalAuthDatabaseConnectionError,
  Scope.Scope
> {
  const poolConfiguration = yield* configureDatabasePool(configuration.connectionString).pipe(
    Effect.mapError(
      (error) =>
        new CommercePortalAuthDatabaseConnectionError({
          reason: error.reason,
        }),
    ),
  );
  const reactivity = yield* Reactivity.make;
  const client = yield* openDatabaseClient(poolConfiguration).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  const executor = yield* makeWithDefaults({ relations: commercePortalAuthRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, commercePortalAuthDatabaseSchema);
  return { adapter, executor };
});

/** Operator entrypoint: use the explicitly parsed database identity rather than the request realm's URL. */
export const CommercePortalAuthDatabaseFromDatabaseConfigLive = Layer.effect(
  CommercePortalAuthDatabase,
  Effect.gen(function* makeCommercePortalAuthOperatorDatabase() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCommercePortalAuthDatabase({ connectionString: Redacted.make(configuration.connectionString) });
  }),
);

export const CommercePortalAuthDatabaseLive = Layer.effect(
  CommercePortalAuthDatabase,
  Effect.gen(function* makeCommercePortalAuthDatabaseService() {
    const configuration = yield* CommercePortalAuthConfig;
    return yield* makeCommercePortalAuthDatabase(configuration);
  }),
);
