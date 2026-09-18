/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle construction is this owner's database factory boundary; expires: 2027-03-31. */
import { configureDatabasePool } from '@app/core-runtime';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

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

/** Structurally derived from the real driver type, not re-declared, so the finalizer stays the pg contract. */
export type CommercePortalAuthPoolResource = Pick<Pool, 'end'>;

const connectionFailure = (cause: unknown): CommercePortalAuthDatabaseConnectionError =>
  Object.defineProperty(
    new CommercePortalAuthDatabaseConnectionError({
      reason: 'Unable to initialize the Commerce portal authentication PostgreSQL pool',
    }),
    'cause',
    { value: cause },
  );

const acquireCommercePortalAuthPool = <Resource extends CommercePortalAuthPoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, CommercePortalAuthDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({ catch: connectionFailure, try: acquire }),
    // pg overloads end(callback); call with no argument so an AbortSignal is not treated as one.
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise owns this foreign driver boundary.
    (pool) => Effect.promise(() => pool.end()),
  );

export type CommercePortalAuthPoolFactory = (configuration: PoolConfig) => Pool;
const defaultPoolFactory: CommercePortalAuthPoolFactory = (configuration) => new Pool(configuration);

export const makeCommercePortalAuthDatabase = Effect.fn('CommercePortalAuthDatabase.make')(function* makeDatabase(
  configuration: Pick<CommercePortalAuthConfigValue, 'connectionString'>,
  poolFactory: CommercePortalAuthPoolFactory = defaultPoolFactory,
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
  const pool = yield* acquireCommercePortalAuthPool(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  const executor = yield* makeWithDefaults({ relations: commercePortalAuthRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client),
  );

  return {
    executor,
    // Better Auth owns this Promise-based adapter; provider application reads use the native executor.
    adapter: drizzleAdapter(drizzle({ client: pool, relations: commercePortalAuthRelations }), {
      provider: 'pg',
      schema: commercePortalAuthDatabaseSchema,
      schemaName: COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
      transaction: true,
    }),
  };
});

export const CommercePortalAuthDatabaseLive = Layer.effect(
  CommercePortalAuthDatabase,
  Effect.gen(function* makeCommercePortalAuthDatabaseService() {
    const configuration = yield* CommercePortalAuthConfig;
    return yield* makeCommercePortalAuthDatabase(configuration);
  }),
);
