import { expect, it } from '@app/effect-rstest';
import { Effect, Redacted } from 'effect';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { configureDatabasePool } from '../../src/db/pool-configuration.ts';

const rollbackAndRelease = (client: PoolClient) =>
  Effect.tryPromise(() => client.query('rollback')).pipe(
    Effect.ignore,
    Effect.ensuring(Effect.sync(() => client.release())),
  );

it.live('applies PostgreSQL pool connection and statement deadlines', () =>
  Effect.gen(function* poolDeadlines1() {
    const databaseConfiguration = yield* loadDatabaseConfig();
    const poolConfiguration = yield* configureDatabasePool(
      Redacted.make(databaseConfiguration.connectionString),
      { connectionTimeoutMillis: 200, statement_timeout: 120 },
    );
    const acquirePool = Effect.acquireRelease(
      Effect.sync(() => new Pool({ ...poolConfiguration, max: 1 })),
      (resource) => Effect.promise(() => resource.end()).pipe(Effect.orDie),
    );
    const pool = yield* acquirePool;
    const blocker = yield* acquirePool;

    yield* Effect.scoped(
      Effect.gen(function* poolDeadlines2() {
        const client = yield* Effect.acquireRelease(
          Effect.promise(() => pool.connect()),
          (connection) => Effect.sync(() => connection.release()),
        );
        const settings = yield* Effect.promise(() =>
          client.query<{ statement_timeout: string }>('show statement_timeout'),
        );
        expect(settings.rows[0]?.statement_timeout).toBe('120ms');

        const identity = yield* Effect.promise(() =>
          client.query<{ current_user: string }>('select current_user'),
        );
        expect(identity.rows[0]?.current_user).toBe(databaseConfiguration.user);

        const pidResult = yield* Effect.promise(() =>
          client.query<{ pid: number }>('select pg_backend_pid() as pid'),
        );
        const pid = pidResult.rows[0]?.pid;
        expect(pid !== undefined).toBe(true);

        const cancellation = yield* Effect.flip(
          Effect.tryPromise(() => client.query('select pg_sleep(1)')),
        );
        expect(cancellation.cause).toMatchObject({ code: '57014' });

        const afterCancellation = yield* Effect.promise(() =>
          client.query<{ ok: number; pid: number }>('select pg_backend_pid() as pid, 1 as ok'),
        );
        expect(afterCancellation.rows[0]?.pid).toBe(pid);
        expect(afterCancellation.rows[0]?.ok).toBe(1);

        const timeout = yield* Effect.flip(Effect.tryPromise(() => pool.connect()));
        expect(timeout.cause).toMatchObject({ message: expect.stringMatching(/timeout/iu) });
      }),
    );

    const holder = yield* Effect.acquireRelease(
      Effect.promise(() => blocker.connect()),
      rollbackAndRelease,
    );
    yield* Effect.promise(() => holder.query('begin'));
    yield* Effect.promise(() => holder.query('select pg_advisory_xact_lock(424242)'));

    const waiter = yield* Effect.acquireRelease(
      Effect.promise(() => pool.connect()),
      rollbackAndRelease,
    );
    yield* Effect.promise(() => waiter.query('begin'));
    const lockTimeout = yield* Effect.flip(
      Effect.tryPromise(() => waiter.query('select pg_advisory_xact_lock(424242)')),
    );
    expect(lockTimeout.cause).toMatchObject({ code: '57014' });

    yield* Effect.promise(() => waiter.query('rollback'));
    yield* Effect.promise(() => holder.query('rollback'));
    yield* Effect.promise(() => waiter.query('begin'));
    yield* Effect.promise(() => waiter.query('select pg_advisory_xact_lock(424242)'));
    yield* Effect.promise(() => waiter.query('rollback'));
  }),
);
