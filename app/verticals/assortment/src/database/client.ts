import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import { AssortmentDatabaseConnectionError } from './connection-error.ts';
import { assortmentRelations } from './schema.ts';
import type { AssortmentDatabaseExecutor } from './types.ts';

export class AssortmentDatabase extends Context.Service<
  AssortmentDatabase,
  { readonly executor: AssortmentDatabaseExecutor }
>()('@app/assortment/database/client/AssortmentDatabase') {}

const connectionFailure = (cause: unknown): AssortmentDatabaseConnectionError =>
  new AssortmentDatabaseConnectionError({
    cause,
    reason: 'Unable to initialize the Assortment native PostgreSQL client',
  });

export const AssortmentPgClientLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* makeAssortmentPgClient() {
    const configuration = yield* DatabaseConfig;
    const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
      Effect.mapError((error) => new AssortmentDatabaseConnectionError({ reason: error.reason })),
    );
    return yield* PgClient.make(poolConfiguration).pipe(Effect.mapError(connectionFailure));
  }),
);

export const AssortmentDatabaseLive = Layer.effect(
  AssortmentDatabase,
  makeWithDefaults({ relations: assortmentRelations }).pipe(Effect.map((executor) => ({ executor }))),
);
