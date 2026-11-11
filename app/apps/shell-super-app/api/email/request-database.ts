import { DatabaseConfig, configureDatabasePool, openDatabaseClient } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Redacted } from 'effect';

/**
 * The database of one email operation (a dispatch or a receipt list), built in that operation's own scope only after
 * its route has authorized the work. With `ONTOS_DATABASE_POOL_SHARED=true` (the Node app host) it draws from the
 * process's shared runtime pool, so the 10 s dispatch trigger reuses a warm connection instead of connecting and
 * authenticating anew each time; otherwise (Workers, standalone runs) the operation owns its pool for its scope.
 * The application root provides `DatabaseConfig` and `Reactivity`.
 */
export const EmailRequestDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* makeEmailRequestDatabase() {
    const config = yield* DatabaseConfig;
    const configuration = yield* configureDatabasePool(Redacted.make(config.connectionString));
    return yield* openDatabaseClient(configuration);
  }),
);
