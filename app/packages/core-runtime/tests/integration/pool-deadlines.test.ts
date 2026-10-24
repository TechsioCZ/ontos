import { Duplex } from 'node:stream';

import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Function as Fn, Layer, Predicate, Redacted } from 'effect';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/unstable/reactivity';

import { DatabaseConfigLive, loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { CoreAdminDatabaseLive, CoreDatabase, CoreDatabaseLive } from '../../src/db/client.ts';
import { configureDatabasePool } from '../../src/db/pool-configuration.ts';

class RuntimeDatabaseIdentity extends Context.Service<RuntimeDatabaseIdentity, string>()(
  '@app/core-runtime/tests/integration/pool-deadlines.test/RuntimeDatabaseIdentity',
) {}

const currentDatabaseUser = Effect.gen(function* readDatabaseIdentity() {
  const database = yield* CoreDatabase;
  const rows = yield* database.executor.execute<{ current_user: string }>(sql`select current_user`, 'objects');
  return rows[0]?.current_user ?? '';
});
const runtimeIdentityLive = Layer.effect(RuntimeDatabaseIdentity, currentDatabaseUser).pipe(
  Layer.provide(CoreDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

it.live('keeps administrator and runtime identities distinct in one memoized operator composition', () =>
  Effect.gen(function* distinctOperatorClients() {
    const configuration = yield* loadDatabaseConnectionPair();
    const context = yield* Layer.build(Layer.mergeAll(runtimeIdentityLive, CoreAdminDatabaseLive));
    const admin = yield* currentDatabaseUser.pipe(
      Effect.provideService(CoreDatabase, Context.get(context, CoreDatabase)),
    );
    const runtime = Context.get(context, RuntimeDatabaseIdentity);
    expect(admin).toBe(configuration.admin.user);
    expect(runtime).toBe(configuration.runtime.user);
    expect(admin).not.toBe(runtime);
  }),
);

/** A transport that accepts the startup packet and never answers, so only the connect deadline ends it. */
const silentTransport = () =>
  new Duplex({
    read: Fn.constVoid,
    write: (_chunk, _encoding, written) => {
      written();
    },
  });

it.live('applies PostgreSQL connect and statement deadlines', () =>
  Effect.gen(function* poolDeadlines1() {
    const databaseConfiguration = yield* loadDatabaseConfig();
    const clientConfiguration = yield* configureDatabasePool(Redacted.make(databaseConfiguration.connectionString), {
      connectTimeoutMillis: 200,
      statement_timeout: 120,
    });
    const reactivity = yield* Reactivity.make;
    // One physical session per client, so backend identity and transaction state are observable.
    const session = (overrides: Omit<PgClient.PgClientConfig, 'url'> = {}) =>
      PgClient.makeClient({ ...clientConfiguration, ...overrides }).pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity),
      );

    const client = yield* session();
    const settings = yield* client.unsafe<{ statement_timeout: string }>('show statement_timeout');
    expect(settings[0]?.statement_timeout).toBe('120ms');

    const identity = yield* client.unsafe<{ current_user: string }>('select current_user');
    expect(identity[0]?.current_user).toBe(databaseConfiguration.user);

    const pidResult = yield* client.unsafe<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = pidResult[0]?.pid;
    expect(pid !== undefined).toBe(true);

    const cancellation = yield* Effect.flip(client.unsafe('select pg_sleep(1)'));
    expect(Predicate.isTagged(cancellation.reason, 'StatementTimeoutError')).toBe(true);
    expect(cancellation.reason.cause).toMatchObject({ code: '57014' });

    const afterCancellation = yield* client.unsafe<{ ok: number; pid: number }>(
      'select pg_backend_pid() as pid, 1 as ok',
    );
    expect(afterCancellation[0]?.pid).toBe(pid);
    expect(afterCancellation[0]?.ok).toBe(1);

    const timeout = yield* Effect.flip(session({ stream: silentTransport }));
    expect(Predicate.isTagged(timeout.reason, 'ConnectionError')).toBe(true);
    expect(timeout.message).toMatch(/timed out/iu);

    const holder = yield* session();
    const waiter = yield* session();
    yield* holder.unsafe('begin');
    yield* holder.unsafe('select pg_advisory_xact_lock(424242)');
    yield* waiter.unsafe('begin');
    const lockTimeout = yield* Effect.flip(waiter.unsafe('select pg_advisory_xact_lock(424242)'));
    expect(lockTimeout.reason.cause).toMatchObject({ code: '57014' });

    yield* waiter.unsafe('rollback');
    yield* holder.unsafe('rollback');
    yield* waiter.unsafe('begin');
    yield* waiter.unsafe('select pg_advisory_xact_lock(424242)');
    yield* waiter.unsafe('rollback');
  }),
);
