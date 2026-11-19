import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { communicationsRelations } from './schema.ts';

const failureFields = { cause: Schema.optionalKey(Schema.Unknown), reason: Schema.String };
const failureContract = Schema.TaggedStruct('CommunicationsDatabaseUnavailable', failureFields);
export const CommunicationsDatabaseUnavailable = Schema.TaggedError<typeof failureContract.Type>()(
  'CommunicationsDatabaseUnavailable',
  failureFields,
);
const unavailable = <Cause>(cause: Cause) =>
  new CommunicationsDatabaseUnavailable({ cause, reason: 'Communications database initialization failed' });

export type CommunicationsDatabaseExecutor = EffectPgDatabase<typeof communicationsRelations>;

export class CommunicationsDatabase extends Context.Service<
  CommunicationsDatabase,
  { readonly executor: CommunicationsDatabaseExecutor }
>()('@app/communications/database/client/CommunicationsDatabase') {}
export const CommunicationsPgClientLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* communicationsPgClient() {
    const configuration = yield* DatabaseConfig;
    const pool = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
      Effect.mapError(unavailable),
    );
    return yield* PgClient.make(pool).pipe(Effect.mapError(unavailable));
  }),
);
export const CommunicationsDatabaseLive = Layer.effect(
  CommunicationsDatabase,
  makeWithDefaults({ relations: communicationsRelations }).pipe(Effect.map((executor) => ({ executor }))),
);
