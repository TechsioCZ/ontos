import { DatabaseConfigLive, configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { DatabasePoolRegistryLive, DatabasePools } from '../../../../packages/core-runtime/src/db/database-client.ts';
import { EmailRequestDatabaseLive } from '../../api/email/request-database.ts';

const withPoolSharing = (shared: boolean) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({ ONTOS_DATABASE_POOL_SHARED: String(shared) }).pipe(
      ConfigProvider.orElse(ConfigProvider.fromEnv()),
    ),
  );

/** The backend process one email operation's database ran on, in that operation's own scope. */
const operationBackend = Effect.scoped(
  Effect.gen(function* emailOperation() {
    const database = yield* Layer.build(
      EmailRequestDatabaseLive.pipe(Layer.provide(Layer.mergeAll(DatabaseConfigLive, Reactivity.layer))),
    );
    const sql = Context.get(database, PgClient.PgClient);
    const [row] = yield* sql<{ readonly pid: number }>`select pg_backend_pid() as pid`;
    return row?.pid;
  }),
);

it.effect('consecutive email operations reuse the host process pool when pools are shared', () =>
  Effect.scoped(
    Effect.gen(function* sharedPool() {
      const registry = Context.get(
        yield* Layer.build(DatabasePoolRegistryLive.pipe(Layer.provide(Reactivity.layer))),
        DatabasePools,
      );
      // The Shell's long-lived runtime database holds the same pool for the life of the process.
      yield* registry.acquire(yield* configureDatabasePool(yield* Config.Redacted('DATABASE_URL')));
      const first = yield* operationBackend.pipe(Effect.provideService(DatabasePools, registry));
      const second = yield* operationBackend.pipe(Effect.provideService(DatabasePools, registry));
      expect(first).toBeDefined();
      expect(second).toBe(first);
    }),
  ).pipe(withPoolSharing(true)),
);

it.effect('without pool sharing each email operation owns its connection for its scope', () =>
  Effect.gen(function* privatePools() {
    const first = yield* operationBackend;
    const second = yield* operationBackend;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  }).pipe(withPoolSharing(false)),
);
