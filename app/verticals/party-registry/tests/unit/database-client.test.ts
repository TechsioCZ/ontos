// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
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

test('keeps Party Registry pool acquisition failure in the typed error channel', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        makePartyDatabase(
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
  assert.equal(error._tag, 'PartyDatabaseConnectionError');
  assert.equal(error.reason, 'Unable to initialize the Party Registry PostgreSQL connection pool');
});
