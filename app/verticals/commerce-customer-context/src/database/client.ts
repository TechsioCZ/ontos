import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import { CommerceCustomerContextDatabaseConnectionError } from './connection-error.ts';
import { commerceCustomerContextRelations } from './schema.ts';
import type { CommerceCustomerContextDatabaseExecutor } from './types.ts';

export class CommerceCustomerContextDatabase extends Context.Service<
  CommerceCustomerContextDatabase,
  { readonly executor: CommerceCustomerContextDatabaseExecutor }
>()('@app/commerce-customer-context/database/client/CommerceCustomerContextDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

const connectionFailure = (cause: unknown): CommerceCustomerContextDatabaseConnectionError =>
  Object.defineProperty(
    new CommerceCustomerContextDatabaseConnectionError({
      reason: 'Unable to initialize the Commerce Customer Context PostgreSQL connection pool',
    }),
    'cause',
    { value: cause },
  );

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, CommerceCustomerContextDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(Effect.try({ catch: connectionFailure, try: acquire }), (pool) =>
    Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;
const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makeCommerceCustomerContextDatabase = Effect.fn(
  'CommerceCustomerContextDatabase.make',
)(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.fn.Return<
  ContextServiceContract<typeof CommerceCustomerContextDatabase>,
  CommerceCustomerContextDatabaseConnectionError,
  Scope.Scope
> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(
    Effect.mapError(
      (error) => new CommerceCustomerContextDatabaseConnectionError({ reason: error.reason }),
    ),
  );
  const pool = yield* acquirePoolResource(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
  return {
    executor: yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const CommerceCustomerContextDatabaseLive = Layer.effect(
  CommerceCustomerContextDatabase,
  Effect.gen(function* makeDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCommerceCustomerContextDatabase(configuration);
  }),
);
