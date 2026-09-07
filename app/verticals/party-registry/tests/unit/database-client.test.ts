import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Predicate } from 'effect';
import { acquirePoolResource, makePartyDatabase } from '../../src/db/client.ts';

void test('finalizes the Party Registry pool when its Effect scope closes', async () => {
  let finalized = false;
  await runEffectTestPromise(
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

void test('keeps Party Registry pool acquisition failure in the typed error channel', async () => {
  const error = await runEffectTestPromise(
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
  assert.ok(Predicate.isTagged(error, 'PartyDatabaseConnectionError'));
  assert.equal(error.reason, 'Unable to initialize the Party Registry PostgreSQL connection pool');
});
