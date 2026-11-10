import { DatabaseConfig, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { promotionRelations } from '../services/persistence-schema.service.ts';

const failureFields = { cause: Schema.optionalKey(Schema.Unknown), reason: Schema.String };
const failureContract = Schema.TaggedStruct('PromotionDatabaseUnavailable', failureFields);
export const PromotionDatabaseUnavailable = Schema.TaggedError<typeof failureContract.Type>()(
  'PromotionDatabaseUnavailable',
  failureFields,
);
const unavailable = <Cause>(cause: Cause) =>
  new PromotionDatabaseUnavailable({ cause, reason: 'Promotion database initialization failed' });

export class PromotionDatabase extends Context.Service<
  PromotionDatabase,
  { readonly executor: EffectPgDatabase<typeof promotionRelations> }
>()('@app/promotion/database/client/PromotionDatabase') {}
export const PromotionPgClientLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* promotionPgClient() {
    const configuration = yield* DatabaseConfig;
    const pool = yield* configureDatabasePool(Redacted.make(configuration.connectionString)).pipe(
      Effect.mapError(unavailable),
    );
    return yield* PgClient.make(pool).pipe(Effect.mapError(unavailable));
  }),
);
export const PromotionDatabaseLive = Layer.effect(
  PromotionDatabase,
  makeWithDefaults({ relations: promotionRelations }).pipe(Effect.map((executor) => ({ executor }))),
);
