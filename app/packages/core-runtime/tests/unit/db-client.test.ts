// @effect-diagnostics asyncFunction:off -- Node test exercises the pg Promise boundary; remove-when: pg has an Effect-native lifecycle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Redacted, Schema } from 'effect';
import { Client, Pool } from 'pg';
import type { PoolConfig } from 'pg';
import {
  DEFAULT_DATABASE_POOL_DEADLINES,
  acquirePoolResource,
  makeCoreDatabase,
} from '../../src/db/client.ts';

import { makeDatabasePoolConfiguration } from '../../src/index.ts';
import type { DatabaseConnectionError, DatabasePoolDeadlines } from '../../src/index.ts';

const rawConnectionString = 'postgresql://synthetic:synthetic@localhost:1/synthetic';

const configuration = {
  connectionString: Redacted.make(rawConnectionString),
  database: 'synthetic',
  host: 'localhost',
  port: 1,
  user: 'synthetic',
};

void test('public pool configuration needs no scope and preserves defaults, overrides, and SSL', async () => {
  const defaults: Effect.Effect<PoolConfig, DatabaseConnectionError> =
    makeDatabasePoolConfiguration(rawConnectionString);
  assert.deepEqual(await Effect.runPromise(defaults), {
    connectionString: rawConnectionString,
    ...DEFAULT_DATABASE_POOL_DEADLINES,
  });
  const connectionString = `${rawConnectionString}?sslmode=require&application_name=synthetic-app`;
  const poolDeadlines: Partial<DatabasePoolDeadlines> = {
    connectionTimeoutMillis: 1,
    lock_timeout: 2_147_483_647,
  };
  assert.deepEqual(
    await Effect.runPromise(makeDatabasePoolConfiguration(connectionString, poolDeadlines)),
    { connectionString, ...DEFAULT_DATABASE_POOL_DEADLINES, ...poolDeadlines },
  );
});

void test('passes bounded pg options through the existing factory and closes its pool', async (t) => {
  let received: PoolConfig | undefined;
  // Lazy: this test never opens a database connection.
  const pool = new Pool();
  const end = t.mock.method(pool, 'end', async () => {});

  await Effect.runPromise(
    Effect.scoped(
      makeCoreDatabase(configuration, (options) => {
        received = options;
        return pool;
      }),
    ),
  );

  assert.equal(received?.query_timeout, undefined);
  assert.deepEqual(DEFAULT_DATABASE_POOL_DEADLINES, {
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
  assert.deepEqual(received, {
    connectionString: rawConnectionString,
    ...DEFAULT_DATABASE_POOL_DEADLINES,
  });
  assert.equal(end.mock.callCount(), 1);
});

void test('allows narrow deadline overrides without changing the factory position', async () => {
  let received: PoolConfig | undefined;
  await Effect.runPromise(
    Effect.scoped(
      makeCoreDatabase(
        { ...configuration, poolDeadlines: { lock_timeout: 100, statement_timeout: 250 } },
        (options) => {
          received = options;
          return new Pool(options);
        },
      ),
    ),
  );
  assert.deepEqual(received, {
    connectionString: rawConnectionString,
    connectionTimeoutMillis: 5000,
    lock_timeout: 100,
    statement_timeout: 250,
  });
});

for (const key of ['connectionTimeoutMillis', 'statement_timeout', 'lock_timeout'] as const) {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    void test(`rejects ${key}=${value} before constructing the pool`, async () => {
      let acquired = false;
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.flip(
            makeCoreDatabase({ ...configuration, poolDeadlines: { [key]: value } }, (options) => {
              acquired = true;
              return new Pool(options);
            }),
          ),
        ),
      );
      assert.equal(error._tag, 'DatabaseConnectionError');
      assert.equal(acquired, false);
    });
  }
}

void test('pg URI deadlines override explicit client options without opening a connection', () => {
  const client = new Client({
    ...DEFAULT_DATABASE_POOL_DEADLINES,
    connectionString: `${rawConnectionString}?statement_timeout=0&lock_timeout=0&connectionTimeoutMillis=0&options=-c%20statement_timeout%3D0`,
  });
  assert.ok('connectionParameters' in client);
  const parameters = client.connectionParameters;
  assert.ok(
    Schema.is(
      Schema.Struct({
        connect_timeout: Schema.Finite,
        lock_timeout: Schema.String,
        options: Schema.String,
        statement_timeout: Schema.String,
      }),
    )(parameters),
  );
  assert.equal(parameters.statement_timeout, '0');
  assert.equal(parameters.lock_timeout, '0');
  assert.equal(parameters.connect_timeout, 0);
  assert.equal(parameters.options, '-c statement_timeout=0');
});

for (const query of [
  'statement_timeout=0',
  'lock_timeout=0',
  'connectionTimeoutMillis=0',
  'connect_timeout=0',
  'query_timeout=0',
  'statement_timeout=100',
  'statement_timeout=',
  'statement%5Ftimeout=0',
  'statement_timeout=100&statement_timeout=0',
  'options=-c%20statement_timeout%3D0',
  'options=--lock-timeout%3D0',
  'options=-c%20search_path%3Dpublic',
]) {
  void test(`rejects URL override ${query} through the typed channel without leaking URI secrets`, async () => {
    let acquired = false;
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          makeCoreDatabase(
            {
              ...configuration,
              connectionString: Redacted.make(
                `${rawConnectionString}?${query}&application_name=private-marker`,
              ),
            },
            (options) => {
              acquired = true;
              return new Pool(options);
            },
          ),
        ),
      ),
    );
    assert.equal(error._tag, 'DatabaseConnectionError');
    assert.match(error.reason, /use poolDeadlines/u);
    assert.doesNotMatch(JSON.stringify(error), /synthetic|private-marker|postgresql:/u);
    assert.equal(acquired, false);
  });
}

void test('preserves SSL and ordinary URI settings verbatim with supported deadline overrides', async () => {
  const connectionString = `${rawConnectionString}?sslmode=require&application_name=synthetic-app`;
  let received: PoolConfig | undefined;
  await Effect.runPromise(
    Effect.scoped(
      makeCoreDatabase(
        {
          ...configuration,
          connectionString: Redacted.make(connectionString),
          poolDeadlines: { statement_timeout: 250 },
        },
        (options) => {
          received = options;
          const client = new Client(options);
          assert.ok('connectionParameters' in client);
          const parameters = client.connectionParameters;
          assert.ok(
            Schema.is(
              Schema.Struct({
                application_name: Schema.String,
                ssl: Schema.Struct({}),
                statement_timeout: Schema.Finite,
              }),
            )(parameters),
          );
          assert.equal(parameters.statement_timeout, 250);
          assert.equal(parameters.application_name, 'synthetic-app');
          return new Pool(options);
        },
      ),
    ),
  );
  assert.equal(received?.connectionString, connectionString);
});

void test('malformed URI validation fails in the typed channel before pool acquisition', async () => {
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.flip(
        makeCoreDatabase({
          ...configuration,
          connectionString: Redacted.make('private-invalid-uri'),
        }),
      ),
    ),
  );
  assert.equal(error._tag, 'DatabaseConnectionError');
  assert.doesNotMatch(JSON.stringify(error), /private-invalid-uri/u);
});

void test('maps factory failure into the connection error channel', async () => {
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.flip(
        makeCoreDatabase(configuration, () => {
          throw new Error('synthetic construction failure');
        }),
      ),
    ),
  );
  assert.equal(error._tag, 'DatabaseConnectionError');
});

for (const [name, outcome] of [
  ['success', Effect.void],
  ['failure', Effect.fail('synthetic failure')],
  ['interruption', Effect.interrupt],
] as const) {
  void test(`awaits pool cleanup exactly once on ${name}`, async () => {
    let finalized = 0;
    let settled = false;
    const started = Promise.withResolvers<boolean>();
    const finish = Promise.withResolvers<boolean>();
    const running = Effect.runPromiseExit(
      Effect.scoped(
        acquirePoolResource(() => ({
          end: async () => {
            finalized += 1;
            started.resolve(true);
            await finish.promise;
          },
        })).pipe(Effect.flatMap(() => outcome)),
      ),
    ).then((exit) => {
      settled = true;
      return exit;
    });
    await started.promise;
    assert.equal(settled, false);
    assert.equal(finalized, 1);
    finish.resolve(true);
    await running;
    assert.equal(settled, true);
    assert.equal(finalized, 1);
  });
}
