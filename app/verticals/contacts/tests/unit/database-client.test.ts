// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { acquirePoolResource, makeContactsDatabase } from '../../src/db/client.ts';

test('finalizes the Contacts pool when its Effect scope closes', async () => {
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

test('keeps Contacts pool acquisition failure in the typed error channel', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        makeContactsDatabase(
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

  assert.equal(error._tag, 'ContactsDatabaseConnectionError');
  assert.equal(error.reason, 'Unable to initialize the Contacts PostgreSQL connection pool');
});
