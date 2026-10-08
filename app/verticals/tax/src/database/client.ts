import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import { TaxDatabaseConnectionError } from './connection-error.ts';
import { taxRelations } from './schema.ts';
import type { TaxDatabaseExecutor } from './types.ts';

export class TaxDatabase extends Context.Service<TaxDatabase, { readonly executor: TaxDatabaseExecutor }>()(
  '@app/tax/database/client/TaxDatabase',
) {}

const connectionFailure = (cause: unknown): TaxDatabaseConnectionError =>
  new TaxDatabaseConnectionError({
    cause,
    reason: 'Unable to initialize the Tax native PostgreSQL client',
  });

export const TaxPgClientLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* makeTaxPgClient() {
    const configuration = yield* DatabaseConfig;
    const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
      Effect.mapError((error) => new TaxDatabaseConnectionError({ reason: error.reason })),
    );
    return yield* PgClient.make(poolConfiguration).pipe(Effect.mapError(connectionFailure));
  }),
);

export const TaxDatabaseLive = Layer.effect(
  TaxDatabase,
  makeWithDefaults({ relations: taxRelations }).pipe(Effect.map((executor) => ({ executor }))),
);
