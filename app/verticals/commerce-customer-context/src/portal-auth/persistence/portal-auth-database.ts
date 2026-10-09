/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle construction is this owner's database factory boundary; expires: 2027-03-31. */
import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { CommercePortalAuthDatabaseConnectionError } from '../../../api/portal-auth/db/connection-error.ts';
import { CommercePortalAuthConfig } from '../../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../../api/portal-auth/provider/config.ts';
import { commercePortalAuthDatabaseSchema, commercePortalAuthRelations } from './portal-auth-tables.ts';
import type {
  CommercePortalAuthDatabaseAdapter,
  CommercePortalAuthDatabaseExecutor,
} from './portal-auth-database-types.ts';

export class CommercePortalAuthDatabase extends Context.Service<
  CommercePortalAuthDatabase,
  {
    readonly adapter: CommercePortalAuthDatabaseAdapter;
    readonly executor: CommercePortalAuthDatabaseExecutor;
  }
>()('@app/commerce-customer-context/portal-auth/persistence/portal-auth-database/CommercePortalAuthDatabase') {}

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
  const client = yield* PgClient.make(poolConfiguration).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  const executor = yield* makeWithDefaults({ relations: commercePortalAuthRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, commercePortalAuthDatabaseSchema);
  return { adapter, executor };
});

export const CommercePortalAuthDatabaseLive = Layer.effect(
  CommercePortalAuthDatabase,
  Effect.gen(function* makeCommercePortalAuthDatabaseService() {
    const configuration = yield* CommercePortalAuthConfig;
    return yield* makeCommercePortalAuthDatabase(configuration);
  }),
);
