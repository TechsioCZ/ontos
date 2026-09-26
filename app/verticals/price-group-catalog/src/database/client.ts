/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle executor construction is the owner database factory boundary; expires: 2027-03-31. */
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { PriceGroupCatalogDatabaseConnectionError } from './connection-error.ts';
import { priceGroupCatalogRelations } from './schema.ts';
import type { PriceGroupCatalogDatabaseExecutor } from './types.ts';

export class PriceGroupCatalogDatabase extends Context.Service<
  PriceGroupCatalogDatabase,
  { readonly executor: PriceGroupCatalogDatabaseExecutor }
>()('@app/price-group-catalog/database/client/PriceGroupCatalogDatabase') {}

const connectionFailure = (cause: unknown): PriceGroupCatalogDatabaseConnectionError =>
  Object.defineProperty(
    new PriceGroupCatalogDatabaseConnectionError({
      reason: 'Unable to initialize the Price Group Catalog PostgreSQL client',
    }),
    'cause',
    { value: cause },
  );

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makePriceGroupCatalogDatabase = Effect.fn('PriceGroupCatalogDatabase.make')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly maxConnections?: number;
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
): Effect.fn.Return<
  ContextServiceContract<typeof PriceGroupCatalogDatabase>,
  PriceGroupCatalogDatabaseConnectionError,
  Scope.Scope
> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new PriceGroupCatalogDatabaseConnectionError({ reason: error.reason })));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.make({ ...poolConfiguration, maxConnections: configuration.maxConnections }).pipe(
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
