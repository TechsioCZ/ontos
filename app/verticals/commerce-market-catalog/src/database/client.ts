/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle executor construction is this owner database factory boundary; expires: 2027-03-31. */
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import { commerceMarketCatalogRelations } from './schema.ts';
import { CommerceMarketCatalogDatabaseConnectionError } from './connection-error.ts';
import type { CommerceMarketCatalogDatabaseExecutor } from './types.ts';

export class CommerceMarketCatalogDatabase extends Context.Service<
  CommerceMarketCatalogDatabase,
  { readonly executor: CommerceMarketCatalogDatabaseExecutor }
>()('@app/commerce-market-catalog/database/client/CommerceMarketCatalogDatabase') {}

interface PoolResource {
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- pg owns this foreign driver finalizer shape.
  readonly end: () => Promise<void>;
}

const connectionFailure = (cause: unknown): CommerceMarketCatalogDatabaseConnectionError =>
  Object.defineProperty(
    new CommerceMarketCatalogDatabaseConnectionError({
      reason: 'Unable to initialize the Commerce Market Catalog PostgreSQL connection pool',
    }),
    'cause',
    { value: cause },
  );

const acquirePool = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, CommerceMarketCatalogDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({ catch: connectionFailure, try: acquire }),
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise owns this foreign Promise boundary.
    (pool) => Effect.promise(() => pool.end()),
  );

type PoolFactory = (configuration: PoolConfig) => Pool;
const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);
type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

const makeCommerceMarketCatalogDatabase = Effect.fn('CommerceMarketCatalogDatabase.make')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PoolFactory = defaultPoolFactory,
) {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new CommerceMarketCatalogDatabaseConnectionError({ reason: error.reason })));
  const pool = yield* acquirePool(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  return {
    executor: yield* makeWithDefaults({ relations: commerceMarketCatalogRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const CommerceMarketCatalogDatabaseLive = Layer.effect(
  CommerceMarketCatalogDatabase,
  Effect.gen(function* makeDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCommerceMarketCatalogDatabase(configuration);
  }),
);
