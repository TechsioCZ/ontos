// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import type { Pool, PoolConfig } from 'pg';
import { acquirePoolResource, makePartyDatabase } from '../../src/db/client.ts';

test('finalizes the Party Registry pool when its Effect scope closes', async () => {
  let finalized = false;
  await Effect.runPromise(
    Effect.scoped(
      acquirePoolResource(() => ({
        end: () => {
          finalized = true;
          return Promise.resolve();
        },
      })),
    ),
  );
  assert.equal(finalized, true);
});

test('forwards default pool deadlines to the Party Registry PoolFactory', async () => {
  let receivedConfiguration: PoolConfig | undefined;
  let finalized = false;
  const pool = {
    end: async () => {
      finalized = true;
    },
  } as unknown as Pool;

  await Effect.runPromise(
    Effect.scoped(
      makePartyDatabase(
        {
          connectionString: Redacted.make('postgresql://ontos_runtime:test@localhost:5433/ontos'),
          database: 'ontos',
          host: 'localhost',
          port: 5433,
          user: 'ontos_runtime',
        },
        (configuration) => {
          receivedConfiguration = configuration;
          return pool;
        },
      ),
    ),
  );

  assert.deepEqual(receivedConfiguration, {
    connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos',
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
  assert.equal(finalized, true);
});

test('rejects unsafe URI deadline overrides before Party Registry pool acquisition', async () => {
  let acquired = false;
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        makePartyDatabase(
          {
            connectionString: Redacted.make(
              'postgresql://ontos_runtime:test@localhost:5433/ontos?statement_timeout=1',
            ),
            database: 'ontos',
            host: 'localhost',
            port: 5433,
            user: 'ontos_runtime',
          },
          () => {
            acquired = true;
            throw new Error('pool factory should not run');
          },
        ),
      ),
    ),
  );

  assert.equal(acquired, false);
  assert.equal(error._tag, 'PartyDatabaseConnectionError');
  assert.equal(
    error.reason,
    'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
  );
  assert.equal(error.reason.includes('statement_timeout=1'), false);
});

test('keeps Party Registry pool acquisition failure in the typed error channel', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        makePartyDatabase(
          {
            connectionString: Redacted.make('postgresql://ontos_runtime:test@localhost:5433/ontos'),
            database: 'ontos',
            host: 'localhost',
            port: 5433,
            user: 'ontos_runtime',
          },
          () => {
            throw new Error('pool construction failed');
          },
        ),
      ),
    ),
  );
  assert.equal(error._tag, 'PartyDatabaseConnectionError');
  assert.equal(error.reason, 'Unable to initialize the Party Registry PostgreSQL connection pool');
});
