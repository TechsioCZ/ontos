import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off -- node:test and pg expose Promise-based integration seams. remove-when: shared Effect-native test and driver APIs land.
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { makeDatabasePoolConfiguration } from '../../src/db/pool-configuration.ts';

type PostgresError = Pick<DatabaseError, 'code' | 'message'>;

const hasSqlState =
  (code: string) =>
  (error: PostgresError): boolean =>
    error.code === code;

const hasTimeoutMessage = (error: PostgresError): boolean => /timeout/iu.test(error.message);

const rollbackAndRelease = async (client: PoolClient | undefined): Promise<void> => {
  if (client === undefined) {
    return;
  }
  await Promise.allSettled([client.query('rollback')]);
  client.release();
};

void test('applies PostgreSQL pool connection and statement deadlines', async () => {
  // eslint-disable-next-line effect-native/no-effect-run-in-tests -- PostgreSQL integration tests bridge Effect configuration into node:test. remove-when: the shared itEffect/itLayer harness lands.
  const { databaseConfiguration, poolConfiguration } = await Effect.runPromise(
    Effect.gen(function* loadPoolConfiguration() {
      const database = yield* loadDatabaseConfig();
      const pool = yield* makeDatabasePoolConfiguration(Redacted.value(database.connectionString), {
        connectionTimeoutMillis: 200,
        statement_timeout: 120,
      });
      return { databaseConfiguration: database, poolConfiguration: pool };
    }),
  );
  const pool = new Pool({ ...poolConfiguration, max: 1 });
  const blocker = new Pool({ ...poolConfiguration, max: 1 });

  try {
    const client = await pool.connect();
    try {
      const settings = await client.query<{ statement_timeout: string }>('show statement_timeout');
      assert.equal(settings.rows[0]?.statement_timeout, '120ms');

      const identity = await client.query<{ current_user: string }>('select current_user');
      assert.equal(identity.rows[0]?.current_user, databaseConfiguration.user);

      const pidResult = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = pidResult.rows[0]?.pid;
      assert.ok(pid !== undefined);

      await assert.rejects(client.query('select pg_sleep(1)'), hasSqlState('57014'));

      const afterCancellation = await client.query<{ ok: number; pid: number }>(
        'select pg_backend_pid() as pid, 1 as ok',
      );
      assert.equal(afterCancellation.rows[0]?.pid, pid);
      assert.equal(afterCancellation.rows[0]?.ok, 1);

      await assert.rejects(pool.connect(), hasTimeoutMessage);
    } finally {
      client.release();
    }

    const holder = await blocker.connect();
    let waiter: PoolClient | undefined;
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(424242)');

      waiter = await pool.connect();
      await waiter.query('begin');
      await assert.rejects(
        waiter.query('select pg_advisory_xact_lock(424242)'),
        hasSqlState('57014'),
      );

      await waiter.query('rollback');
      await holder.query('rollback');

      await waiter.query('begin');
      await waiter.query('select pg_advisory_xact_lock(424242)');
      await waiter.query('rollback');
    } finally {
      await rollbackAndRelease(waiter);
      await rollbackAndRelease(holder);
    }
  } finally {
    await Promise.allSettled([pool.end(), blocker.end()]);
  }
});
