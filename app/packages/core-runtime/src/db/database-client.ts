import { PgClient } from '@effect/sql-pg';
import { Context, Data, Duration, Effect, HashMap, Layer, Predicate, RcMap } from 'effect';
import type { Redacted, Scope } from 'effect';
import type { Reactivity } from 'effect/reactivity';
import { SqlClient, SqlError } from 'effect/sql';
import type { SqlConnection } from 'effect/sql';

import type { DatabasePoolConfiguration } from './pool-configuration.ts';

/** The host owns the registry; each owner scope retains only the pool it uses. */
export interface DatabasePoolRegistry {
  readonly acquire: (
    configuration: DatabasePoolConfiguration,
  ) => Effect.Effect<PgClient.PgClient, SqlError.SqlError, Scope.Scope>;
}

declare global {
  /** Installed and released by the Node host's startup scope, not by owner bundles. */
  var ontosDatabasePoolRegistry: DatabasePoolRegistry | undefined;
}

/** Independent BFF runtimes use the host-owned registry; tests may provide their own scoped registry. */
export const DatabasePools = Context.Reference<DatabasePoolRegistry>('@app/core-runtime/db/DatabasePools', {
  defaultValue: () => ({
    acquire: (configuration) =>
      Effect.suspend(() => {
        const registry = globalThis.ontosDatabasePoolRegistry;
        return registry === undefined
          ? Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.UnknownError({
                  cause: 'The process host has not initialized database pools',
                  message: 'Shared database pools require a scoped process host registry',
                  operation: 'acquire',
                }),
              }),
            )
          : registry.acquire(configuration);
      }),
  }),
});

const durationMillis = (duration: Duration.Input | undefined) =>
  duration === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(duration));

/** Structural keys retain redaction and include every setting our pool configuration can produce. */
class DatabasePoolKey extends Data.Class<{
  readonly connectTimeout: number | undefined;
  readonly idleTimeout: number | undefined;
  readonly maxConnections: number | undefined;
  readonly startupParameters: HashMap.HashMap<string, string>;
  readonly url: Redacted.Redacted | undefined;
}> {}

const sharedPoolKey = (configuration: DatabasePoolConfiguration) =>
  new DatabasePoolKey({
    connectTimeout: durationMillis(configuration.connectTimeout),
    idleTimeout: durationMillis(configuration.idleTimeout),
    maxConnections: configuration.maxConnections,
    startupParameters: HashMap.fromIterable(Object.entries(configuration.startupParameters ?? {})),
    url: configuration.url,
  });

/** RcMap coalesces first acquisition and releases the native client with its final owner scope. */
export const DatabasePoolRegistryLive = Layer.effect(
  DatabasePools,
  Effect.gen(function* makeRegistry() {
    const pools = yield* RcMap.make({
      lookup: (key: DatabasePoolKey) =>
        PgClient.make({
          connectTimeout: key.connectTimeout,
          idleTimeout: key.idleTimeout,
          maxConnections: key.maxConnections,
          startupParameters: Object.fromEntries(key.startupParameters),
          url: key.url,
        }),
    });
    return {
      acquire: (configuration: DatabasePoolConfiguration) => RcMap.get(pools, sharedPoolKey(configuration)),
    } satisfies DatabasePoolRegistry;
  }),
);

/** PostgreSQL answers `COMMIT` with `ROLLBACK` when the transaction had already failed. */
const commitUnlessAborted = (connection: SqlConnection.Connection) =>
  connection.executeRaw('COMMIT', []).pipe(
    Effect.flatMap((result) =>
      Predicate.hasProperty(result, 'command') && result.command === 'ROLLBACK'
        ? Effect.fail(
            new SqlError.SqlError({
              reason: new SqlError.UnknownError({
                cause: result,
                message: 'PgClient: COMMIT rolled back an aborted transaction',
                operation: 'commit',
              }),
            }),
          )
        : Effect.void,
    ),
  );

/**
 * This owner's own client over the shared pool. It keeps its own transaction service and Reactivity, exactly as a
 * private `PgClient.make` would: a statement through it inside another client's transaction checks out its own pooled
 * connection instead of joining that transaction, and transaction-scoped settings never cross clients. Statements,
 * transactions, and `reserve` all take an exclusive session from the shared pool for their duration.
 *
 * The @effect/sql-pg 4.0.7 package has no public PgClient constructor over an existing PgPool or SqlConnection acquirer.
 * SqlClient.make is the public seam for a separate transaction identity. Only PostgreSQL transaction controls and
 * tracing attributes are supplied here; the native client owns connections, protocol, codecs, JSON and notifications.
 * The COMMIT check is necessary because PostgreSQL reports ROLLBACK, not an error, after an ignored statement error.
 */
const clientOnSharedPool = Effect.fnUntraced(function* clientOnSharedPool(
  pool: PgClient.PgClient,
  maxConnections: number | undefined,
) {
  const { config } = pool;
  const acquire = pool.reserve.pipe(
    Effect.timed,
    Effect.tap(([duration]) =>
      Duration.toMillis(duration) < 1000
        ? Effect.void
        : Effect.logWarning('Shared database pool checkout waited at least one second').pipe(
            Effect.annotateLogs({
              elapsedMs: Duration.toMillis(duration),
              maxConnections,
            }),
          ),
    ),
    Effect.map(([, connection]) => connection),
  );
  const client = yield* SqlClient.make({
    acquirer: acquire,
    commit: commitUnlessAborted,
    compiler: PgClient.makeCompiler(),
    driver: 'pg',
    prepareTransactionControls: true,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    spanAttributes: [
      ...Object.entries(config.spanAttributes ?? {}),
      ['db.system.name', 'postgresql'],
      ['db.namespace', config.database ?? config.username ?? 'postgres'],
      ['server.address', config.host ?? 'localhost'],
      ['server.port', config.port ?? 5432],
    ],
  });
  const pgClient: PgClient.PgClient = Object.assign(client, {
    config,
    json: pool.json,
    listen: pool.listen,
    notify: pool.notify,
    [PgClient.TypeId]: PgClient.TypeId,
  });
  return pgClient;
});

/**
 * The native PostgreSQL client for a configured pool. With `ONTOS_DATABASE_POOL_SHARED=true` every client in this
 * process with the same connection identity and pool settings draws from one native pool, which stays open while any
 * of their scopes is open; otherwise the client owns its pool, as `PgClient.make` does. A session that holds state
 * past one transaction, such as a session advisory lock, takes `PgClient.make` directly and never joins a shared pool.
 */
export const openDatabaseClient = (
  configuration: DatabasePoolConfiguration,
): Effect.Effect<PgClient.PgClient, SqlError.SqlError, Scope.Scope | Reactivity.Reactivity> =>
  configuration.processShared
    ? DatabasePools.pipe(
        Effect.flatMap((registry) => registry.acquire(configuration)),
        Effect.flatMap((pool) => clientOnSharedPool(pool, configuration.maxConnections)),
      )
    : PgClient.make(configuration);
