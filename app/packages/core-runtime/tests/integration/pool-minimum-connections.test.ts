import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { ConfigProvider, Context, Crypto, Deferred, Duration, Effect, Exit, Layer, Redacted, Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import { loadDatabaseConfig } from '../../src/db/config.ts';
import { DatabasePoolRegistryLive, DatabasePools, openDatabaseClient } from '../../src/db/database-client.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { configureDatabasePool } from '../../src/db/pool-configuration.ts';

/** Short enough that an idle period longer than it fits a test; the pool checks expiry once per timeout. */
const IDLE_TIMEOUT_MILLIS = 250;
const PAST_IDLE_TIMEOUT = Duration.millis(IDLE_TIMEOUT_MILLIS * 6);

interface PoolSessions {
  readonly idle: number;
  readonly total: number;
}

/**
 * A process-shared runtime-role pool from the process registry, as a served process opens it. Its sessions carry a
 * unique application name, so this test counts only its own backends among everyone else's on the shared database.
 */
const sharedRuntimePool = (budget: { readonly max: number; readonly min: number }) =>
  Effect.gen(function* openSharedRuntimePool() {
    const database = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
    const crypto = yield* Crypto.Crypto;
    const applicationName = `pool-min-${yield* crypto.randomUUIDv4()}`;
    const configuration = yield* configureDatabasePool(Redacted.make(database.connectionString)).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ONTOS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS: String(IDLE_TIMEOUT_MILLIS),
          ONTOS_DATABASE_POOL_MAX_CONNECTIONS: String(budget.max),
          ONTOS_DATABASE_POOL_MIN_CONNECTIONS: String(budget.min),
          ONTOS_DATABASE_POOL_SHARED: 'true',
        }),
      ),
    );
    expect(configuration.minConnections).toBe(budget.min);
    const registry = Context.get(
      yield* Layer.build(DatabasePoolRegistryLive.pipe(Layer.provide(Reactivity.layer))),
      DatabasePools,
    );
    const reactivity = yield* Reactivity.make;
    const client = yield* openDatabaseClient({
      ...configuration,
      startupParameters: { ...configuration.startupParameters, application_name: applicationName },
    }).pipe(Effect.provideService(DatabasePools, registry), Effect.provideService(Reactivity.Reactivity, reactivity));

    // The observer is a separate one-session client under another application name, never counted.
    const observer = yield* PgClient.make({ ...configuration, maxConnections: 1, minConnections: 0 }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const sessions = observer
      .unsafe<{ idle: number; total: number }>(
        "select count(*)::int as total, count(*) filter (where state = 'idle')::int as idle from pg_stat_activity where application_name = $1",
        [applicationName],
      )
      .pipe(Effect.map((rows): PoolSessions => rows[0] ?? { idle: 0, total: 0 }));
    return { client, sessions };
  });

// The pool's idle expiry runs on the real clock against a real server, so no test clock replaces it.
it.layer(NodeCrypto.layer, { excludeTestServices: true })('runtime pool minimum connections', (suite) => {
  suite.effect('keeps exactly the minimum open and idle on creation and after an idle period', () =>
    Effect.gen(function* keepsMinimumWarm() {
      const { client, sessions } = yield* sharedRuntimePool({ max: 4, min: 2 });

      // Creating the pool opens the minimum in the background without any statement.
      let opened = yield* sessions;
      for (let attempt = 0; attempt < 100 && opened.idle < 2; attempt += 1) {
        yield* Effect.sleep(Duration.millis(20));
        opened = yield* sessions;
      }
      expect(opened).toStrictEqual({ idle: 2, total: 2 });

      // Demand above the minimum opens more; once idle past the timeout, only the excess closes.
      yield* Effect.forEach(Array.from({ length: 4 }), () => client.unsafe('select pg_sleep(0.1)'), {
        concurrency: 'unbounded',
        discard: true,
      });
      expect((yield* sessions).total).toBe(4);
      yield* Effect.sleep(PAST_IDLE_TIMEOUT);
      expect(yield* sessions).toStrictEqual({ idle: 2, total: 2 });
    }).pipe(Effect.scoped),
  );

  suite.effect('keeps no connection open after an idle period with the default minimum', () =>
    Effect.gen(function* closesEverythingIdle() {
      const { client, sessions } = yield* sharedRuntimePool({ max: 4, min: 0 });

      expect(yield* sessions).toStrictEqual({ idle: 0, total: 0 });
      yield* client.unsafe('select 1');
      expect((yield* sessions).total).toBe(1);
      yield* Effect.sleep(PAST_IDLE_TIMEOUT);
      expect(yield* sessions).toStrictEqual({ idle: 0, total: 0 });
    }).pipe(Effect.scoped),
  );

  suite.effect('never opens more than the maximum: demand beyond it waits for a released connection', () =>
    Effect.gen(function* boundedByMaximum() {
      const max = 3;
      const { client, sessions } = yield* sharedRuntimePool({ max, min: 2 });
      const parent = yield* Effect.scope;

      // Every connection the pool may open is checked out.
      const leases = yield* Effect.forEach(Array.from({ length: max }), () =>
        Effect.gen(function* holdConnection() {
          const lease = yield* Scope.fork(parent);
          yield* client.reserve.pipe(Scope.provide(lease));
          return lease;
        }),
      );
      expect((yield* sessions).total).toBe(max);

      // Further demand waits instead of opening another connection.
      const served = yield* Deferred.make<boolean>();
      yield* Effect.forEach(Array.from({ length: 2 }), () => client.unsafe('select 1'), {
        concurrency: 'unbounded',
        discard: true,
      }).pipe(Effect.andThen(Deferred.succeed(served, true)), Effect.forkScoped);
      const waiting = yield* client.poolStatistics ?? Effect.die('The shared pool reports no statistics');
      expect(yield* sessions).toStrictEqual({ idle: max, total: max });
      expect(waiting.inUse).toBe(max);
      expect(yield* Deferred.isDone(served)).toBe(false);

      // A released connection serves the waiters; the pool still holds at most its maximum.
      const [first] = leases;
      if (first === undefined) {
        return yield* Effect.die('The maximum test reserved no connection');
      }
      yield* Scope.close(first, Exit.void);
      yield* Deferred.await(served);
      expect((yield* sessions).total).toBe(max);
      return yield* Effect.void;
    }).pipe(Effect.scoped),
  );
});
