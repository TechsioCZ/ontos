/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle construction is this owner's database factory boundary; expires: 2027-03-31. */
import { configureDatabasePool } from '@app/core-runtime';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Duration, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { Pool } from 'pg';

import { CommercePortalAuthDatabaseConnectionError } from '../../../api/portal-auth/db/connection-error.ts';
import { CommercePortalAuthConfig } from '../../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../../api/portal-auth/provider/config.ts';
import {
  commercePortalAuthDatabaseSchema,
  commercePortalAuthRelations,
  COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
} from './portal-auth-tables.ts';
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
  Object.defineProperty(
    new CommercePortalAuthDatabaseConnectionError({
      reason: 'Unable to initialize the Commerce portal authentication PostgreSQL pool',
    }),
    'cause',
    { value: cause },
  );

const acquireBetterAuthPool = (
  acquire: () => Pool,
): Effect.Effect<Pool, CommercePortalAuthDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({ catch: connectionFailure, try: acquire }),
    // pg overloads end(callback); call with no argument so an AbortSignal is not treated as one.
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise owns this foreign driver boundary.
    (pool) => Effect.promise(() => pool.end()),
  );

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

  // Better Auth's Drizzle adapter awaits Promise query builders, and no Promise Drizzle driver runs over
  // the native Effect client, so the adapter alone keeps a pg Pool. It carries the same validated
  // connect deadline and server-enforced statement/lock timeouts as the native client above.
  const pool = yield* acquireBetterAuthPool(
    () =>
      new Pool({
        connectionString: Redacted.value(configuration.connectionString),
        connectionTimeoutMillis: Duration.toMillis(
          Duration.fromInputUnsafe(poolConfiguration.connectTimeout ?? Duration.zero),
        ),
        options: Object.entries(poolConfiguration.startupParameters ?? {})
          .map(([name, value]) => `-c ${name}=${value}`)
          .join(' '),
      }),
  );

  return {
    adapter: drizzleAdapter(drizzle({ client: pool, relations: commercePortalAuthRelations }), {
      provider: 'pg',
      schema: commercePortalAuthDatabaseSchema,
      schemaName: COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
      transaction: true,
    }),
    executor,
  };
});

export const CommercePortalAuthDatabaseLive = Layer.effect(
  CommercePortalAuthDatabase,
  Effect.gen(function* makeCommercePortalAuthDatabaseService() {
    const configuration = yield* CommercePortalAuthConfig;
    return yield* makeCommercePortalAuthDatabase(configuration);
  }),
);
