/* oxlint-disable effect-native/no-effect-provide-in-library -- Native Drizzle executor construction is the owner database factory boundary and follows the proven Core/Party factory; expires: 2027-03-31. */
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import { PaymentTermCatalogDatabaseConnectionError } from './connection-error.ts';
import { paymentTermCatalogRelations } from './schema.ts';
import type { PaymentTermCatalogDatabaseExecutor } from './types.ts';

export class PaymentTermCatalogDatabase extends Context.Service<
  PaymentTermCatalogDatabase,
  { readonly executor: PaymentTermCatalogDatabaseExecutor }
>()('@app/payment-term-catalog/database/client/PaymentTermCatalogDatabase') {}

export interface PaymentTermCatalogPoolResource {
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- pg owns this foreign driver finalizer shape.
  readonly end: () => Promise<void>;
}

const connectionFailure = (cause: unknown): PaymentTermCatalogDatabaseConnectionError =>
  Object.defineProperty(
    new PaymentTermCatalogDatabaseConnectionError({
      reason: 'Unable to initialize the Payment Term Catalog PostgreSQL connection pool',
    }),
    'cause',
    { value: cause },
  );

export const acquirePaymentTermCatalogPool = <Resource extends PaymentTermCatalogPoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, PaymentTermCatalogDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({ catch: connectionFailure, try: acquire }),
    // pg overloads end(callback); call with no argument so an AbortSignal is not treated as one.
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise owns this foreign Promise boundary; an async wrapper is rejected by Effect diagnostics.
    (pool) => Effect.promise(() => pool.end()),
  );

export type PaymentTermCatalogPoolFactory = (configuration: PoolConfig) => Pool;
const defaultPoolFactory: PaymentTermCatalogPoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makePaymentTermCatalogDatabase = Effect.fn('PaymentTermCatalogDatabase.make')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PaymentTermCatalogPoolFactory = defaultPoolFactory,
): Effect.fn.Return<
  ContextServiceContract<typeof PaymentTermCatalogDatabase>,
  PaymentTermCatalogDatabaseConnectionError,
  Scope.Scope
> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new PaymentTermCatalogDatabaseConnectionError({ reason: error.reason })));
  const pool = yield* acquirePaymentTermCatalogPool(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  return {
    executor: yield* makeWithDefaults({ relations: paymentTermCatalogRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const PaymentTermCatalogDatabaseLive = Layer.effect(
  PaymentTermCatalogDatabase,
  Effect.gen(function* makePaymentTermCatalogDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makePaymentTermCatalogDatabase(configuration);
  }),
);
