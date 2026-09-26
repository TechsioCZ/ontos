import { Duplex } from 'node:stream';

import { PgClient } from '@effect/sql-pg';
import { Effect, Function as Fn, Predicate, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/unstable/reactivity';

import { loadDatabaseConfig } from '../../src/db/config.ts';
import { configureDatabasePool } from '../../src/db/pool-configuration.ts';

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
