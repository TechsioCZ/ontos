/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle executor construction is the owner database factory boundary; expires: 2027-03-31. */
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';

import { PriceGroupCatalogDatabaseConnectionError } from './connection-error.ts';
import { priceGroupCatalogRelations } from './schema.ts';
import type { PriceGroupCatalogDatabaseExecutor } from './types.ts';

export class PriceGroupCatalogDatabase extends Context.Service<
  PriceGroupCatalogDatabase,
  { readonly executor: PriceGroupCatalogDatabaseExecutor }
>()('@app/price-group-catalog/database/client/PriceGroupCatalogDatabase') {}

export interface PriceGroupCatalogPoolResource {
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- pg owns this foreign driver finalizer shape.
  readonly end: () => Promise<void>;
}

const connectionFailure = (cause: unknown): PriceGroupCatalogDatabaseConnectionError =>
  Object.defineProperty(
    new PriceGroupCatalogDatabaseConnectionError({
      reason: 'Unable to initialize the Price Group Catalog PostgreSQL connection pool',
    }),
    'cause',
    { value: cause },
  );

export const acquirePriceGroupCatalogPool = <Resource extends PriceGroupCatalogPoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, PriceGroupCatalogDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({ catch: connectionFailure, try: acquire }),
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise owns this foreign Promise boundary.
    (pool) => Effect.promise(() => pool.end()),
  );

export type PriceGroupCatalogPoolFactory = (configuration: PoolConfig) => Pool;
const defaultPoolFactory: PriceGroupCatalogPoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makePriceGroupCatalogDatabase = Effect.fn('PriceGroupCatalogDatabase.make')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PriceGroupCatalogPoolFactory = defaultPoolFactory,
): Effect.fn.Return<
  ContextServiceContract<typeof PriceGroupCatalogDatabase>,
  PriceGroupCatalogDatabaseConnectionError,
  Scope.Scope
> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new PriceGroupCatalogDatabaseConnectionError({ reason: error.reason })));
  const pool = yield* acquirePriceGroupCatalogPool(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  return {
    executor: yield* makeWithDefaults({ relations: priceGroupCatalogRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const PriceGroupCatalogDatabaseLive = Layer.effect(
  PriceGroupCatalogDatabase,
  Effect.gen(function* makePriceGroupCatalogDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makePriceGroupCatalogDatabase(configuration);
  }),
);
