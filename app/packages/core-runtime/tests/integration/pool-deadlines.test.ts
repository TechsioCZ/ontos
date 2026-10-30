import { NodeSocketServer } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Exit, Layer, Match, Predicate, Redacted, Schema, Stream } from 'effect';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { NetAddress } from 'effect/net';
import { Reactivity } from 'effect/reactivity';
import { Socket } from 'effect/socket';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { DatabaseConfigLive, loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { CoreAdminDatabaseLive, CoreDatabase, CoreDatabaseLive } from '../../src/db/client.ts';
import { SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY } from '../../src/db/database-identities.ts';
import { configureDatabasePool } from '../../src/db/pool-configuration.ts';
import { SESSION_ROLE_MISMATCH_REASON, verifySessionRoleOnFirstUse } from '../../src/db/session-identity.ts';

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

const nativeSessionClient = Effect.gen(function* nativeSessionClient() {
  const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString));
  const reactivity = yield* Reactivity.make;
  const client = yield* PgClient.makeClient(poolConfiguration).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
  );
  return { client, configuration };
});

it.live('builds a database service without a connection and refuses the first use under a foreign role', () =>
  Effect.gen(function* refuseWrongDatabaseRole() {
    const { client } = yield* nativeSessionClient;
    const verified = verifySessionRoleOnFirstUse(client, SHELL_GATEWAY_ISSUER_IDENTITY.role);
    const failure = yield* Effect.flip(verified.unsafe('select 1'));

    expect(Schema.is(SqlError)(failure)).toBe(true);
    expect(Schema.is(ConnectionError)(failure.reason)).toBe(true);
    expect(failure.reason.message).toBe(SESSION_ROLE_MISMATCH_REASON);
  }),
);

it.live('fails a use whose role query fails and verifies again on the next use', () =>
  Effect.gen(function* retryFailedRoleQuery() {
    const { client, configuration } = yield* nativeSessionClient;
    const verified = verifySessionRoleOnFirstUse(client, configuration.expectedRole);
    yield* client.unsafe('begin');
    yield* Effect.flip(client.unsafe('select 1 / 0'));
    expect(Exit.isFailure(yield* Effect.exit(verified.unsafe('select 1')))).toBe(true);
    yield* client.unsafe('rollback');
    expect(yield* verified.unsafe<{ value: number }>('select 1 as value')).toEqual([{ value: 1 }]);
  }),
);

/**
 * A TCP listener that reads the startup packet and never answers, so only the connect deadline ends it.
 * Each handler drains its socket, so the listener owns every accepted connection and can close.
 */
const silentListener = Effect.gen(function* silentListener() {
  const server = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 });
  yield* server.run((socket) => Stream.runDrain(Socket.toStream(socket))).pipe(Effect.forkScoped);
  return yield* Match.value(server.address).pipe(
    Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
    Match.orElse(() => Effect.die('Silent PostgreSQL listener did not bind to TCP')),
  );
});

it.live('applies PostgreSQL connect and statement deadlines', () =>
  Effect.gen(function* poolDeadlines1() {
    const databaseConfiguration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
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
    expect(identity[0]?.current_user).toBe(databaseConfiguration.expectedRole);

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

    const silentAddress = yield* silentListener;
    const timeout = yield* Effect.flip(
      session({ host: NetAddress.formatIp(silentAddress.address), port: silentAddress.port }),
    );
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
