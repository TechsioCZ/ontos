// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { acquirePoolResource, makeProjectsDatabase } from '../../src/db/client.ts';

test('finalizes the Projects pool when its Effect scope closes', async () => {
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

test('keeps Projects pool acquisition failure in the typed error channel', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        makeProjectsDatabase(
          {
            connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos',
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

  assert.equal(error._tag, 'ProjectsDatabaseConnectionError');
  assert.equal(error.reason, 'Unable to initialize the Projects PostgreSQL connection pool');
});
