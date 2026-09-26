import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Scope } from 'effect';
import { Context, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { PartyDatabaseConnectionError } from './connection-error.ts';
import { partyRelations } from './schema.ts';
import type { PartyDatabaseExecutor } from './types.ts';

export class PartyDatabase extends Context.Service<
  PartyDatabase,
  {
    readonly executor: PartyDatabaseExecutor;
  }
>()('@app/party-registry/db/client/PartyDatabase') {}

const connectionFailure = (cause: unknown): PartyDatabaseConnectionError =>
  Object.defineProperty(
    new PartyDatabaseConnectionError({
      reason: 'Unable to initialize the Party Registry PostgreSQL connection pool',
    }),
    'cause',
    { value: cause },
  );

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makePartyDatabase = Effect.fn('Client.makePartyDatabase')(function* makeDatabase(
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly maxConnections?: number;
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
): Effect.fn.Return<ContextServiceContract<typeof PartyDatabase>, PartyDatabaseConnectionError, Scope.Scope> {
  const poolConfiguration = yield* configureDatabasePool(
    Redacted.make(configuration.connectionString),
    configuration.poolDeadlines,
  ).pipe(Effect.mapError((error) => new PartyDatabaseConnectionError({ reason: error.reason })));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.make({ ...poolConfiguration, maxConnections: configuration.maxConnections }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(connectionFailure),
  );
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
