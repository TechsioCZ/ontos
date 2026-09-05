import { DatabaseConfig, makeDatabasePoolConfiguration } from '@app/core-runtime';
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { PartyDatabaseConnectionError } from './connection-error.ts';
import { partyRelations } from './schema.ts';
import type { PartyDatabaseExecutor } from './types.ts';

export class PartyDatabase extends Context.Service<
  PartyDatabase,
  {
    readonly executor: PartyDatabaseExecutor;
  }
>()('@app/party-registry/db/client/PartyDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, PartyDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new PartyDatabaseConnectionError({
          reason: 'Unable to initialize the Party Registry PostgreSQL connection pool',
        }),
      try: acquire,
    }),
    (pool) => Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makePartyDatabase = (
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.Effect<
  ContextServiceContract<typeof PartyDatabase>,
  PartyDatabaseConnectionError,
  Scope.Scope
> =>
  Effect.gen(function* makePartyDatabase() {
    const poolConfiguration = yield* makeDatabasePoolConfiguration(
      Redacted.value(configuration.connectionString),
      configuration.poolDeadlines,
    ).pipe(Effect.mapError((error) => new PartyDatabaseConnectionError({ reason: error.reason })));
    const pool = yield* acquirePoolResource(() => poolFactory(poolConfiguration));
    return {
      executor: drizzle({
        client: pool,
        relations: partyRelations,
      }),
    };
  });

export const PartyDatabaseLive = Layer.effect(
  PartyDatabase,
  Effect.gen(function* makePartyDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makePartyDatabase(configuration);
  }),
);
