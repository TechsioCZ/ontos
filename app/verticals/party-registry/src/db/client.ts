import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';

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

const connectionFailure = (cause: unknown): PartyDatabaseConnectionError =>
  Object.defineProperty(
    new PartyDatabaseConnectionError({
      reason: 'Unable to initialize the Party Registry PostgreSQL connection pool',
    }),
    'cause',
    { value: cause },
  );

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, PartyDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: connectionFailure,
      try: acquire,
    }),
    // pg overloads end(callback); invoke it with no arguments so the AbortSignal is never a callback.
    (pool) => Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makePartyDatabase = Effect.fn('Client.makePartyDatabase')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.fn.Return<ContextServiceContract<typeof PartyDatabase>, PartyDatabaseConnectionError, Scope.Scope> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new PartyDatabaseConnectionError({ reason: error.reason })));
  const pool = yield* acquirePoolResource(() => poolFactory(poolConfiguration));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.fromPool({
    acquire: Effect.succeed(pool),
  }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity), Effect.mapError(connectionFailure));
  return {
    executor: yield* makeWithDefaults({ relations: partyRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    ),
  };
});

export const PartyDatabaseLive = Layer.effect(
  PartyDatabase,
  Effect.gen(function* makePartyDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makePartyDatabase(configuration);
  }),
);
