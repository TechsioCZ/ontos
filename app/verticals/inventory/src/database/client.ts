/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle executor construction is this owner database factory boundary; expires: 2027-03-31. */
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { InventoryDatabaseConnectionError } from './connection-error.ts';
import { inventoryRelations } from './schema.ts';
import type { InventoryDatabaseExecutor } from './types.ts';

export class InventoryDatabase extends Context.Service<
  InventoryDatabase,
  { readonly executor: InventoryDatabaseExecutor }
>()('@app/inventory/database/client/InventoryDatabase') {}

const connectionFailure = (cause: unknown): InventoryDatabaseConnectionError =>
  Object.defineProperty(
    new InventoryDatabaseConnectionError({ reason: 'Unable to initialize the Inventory PostgreSQL connection pool' }),
    'cause',
    { value: cause },
  );

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

const makeInventoryDatabase = Effect.fn('InventoryDatabase.make')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
): Effect.fn.Return<ContextServiceContract<typeof InventoryDatabase>, InventoryDatabaseConnectionError, Scope.Scope> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new InventoryDatabaseConnectionError({ reason: error.reason })));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.make(poolConfiguration).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  return {
    executor: yield* makeWithDefaults({ relations: inventoryRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const InventoryDatabaseLive = Layer.effect(
  InventoryDatabase,
  Effect.gen(function* makeDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeInventoryDatabase(configuration);
  }),
);
