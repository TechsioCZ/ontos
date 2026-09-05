import { DatabaseConfig } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
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
  configuration: ContextServiceContract<typeof DatabaseConfig>,
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.Effect<
  ContextServiceContract<typeof PartyDatabase>,
  PartyDatabaseConnectionError,
  Scope.Scope
> =>
  acquirePoolResource(() =>
    poolFactory({
      connectionString: configuration.connectionString,
    }),
  ).pipe(
    Effect.map((pool) => ({
      executor: drizzle({
        client: pool,
        relations: partyRelations,
      }),
    })),
  );

export const PartyDatabaseLive = Layer.effect(
  PartyDatabase,
  Effect.gen(function* makePartyDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makePartyDatabase(configuration);
  }),
);
