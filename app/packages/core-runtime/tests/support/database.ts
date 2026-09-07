import type { Pool } from 'pg';
import { PgClient } from '@effect/sql-pg';
import type { AnyRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { Connection } from 'effect/unstable/sql/SqlConnection';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { coreRelations } from '../../src/db/schema.ts';
import { runEffectTestSync } from './effect-runtime.ts';

/** Native SQL connection fixture; Drizzle and Effect own query and transaction execution. */
export const makeTestDatabase = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) =>
  runEffectTestSync(
    Effect.scoped(
      Effect.gen(function* makeNativeTestDatabase() {
        const values = (sql: string, params: readonly unknown[]) =>
          execute(sql, params).pipe(Effect.map((rows) => rows.map(Object.values)));
        const connection: Connection = {
          execute,
          executeRaw: execute,
          executeStream: (sql, params) => Stream.fromIterableEffect(execute(sql, params)),
          executeUnprepared: execute,
          executeValues: values,
          executeValuesUnprepared: values,
        };
        const reactivity = yield* Reactivity.make;
        const client = yield* PgClient.makeWith({
          acquirer: Effect.succeed(connection),
          config: {},
          listenAcquirer: Effect.die('This fixture does not support notifications'),
          transactionAcquirer: Effect.succeed(connection),
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity), Effect.orDie);
        return yield* makeWithDefaults({ relations: coreRelations }).pipe(
          Effect.provideService(PgClient.PgClient, client),
        );
      }),
    ),
  );

/** The caller owns the pool and keeps this scope open until its tests finish. */
export const makeTestDatabaseFromPool = <Relations extends AnyRelations>(
  pool: Pool,
  relations: Relations,
) =>
  Effect.gen(function* makePoolTestDatabase() {
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    return yield* makeWithDefaults({ relations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
  });
