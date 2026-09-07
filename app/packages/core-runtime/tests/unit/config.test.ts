import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import test from 'node:test';
import { Effect, Predicate } from 'effect';
import { acquirePoolResource } from '../../src/db/client.ts';
import {
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../../src/db/config.ts';

void test('loads the root environment independently of the invocation directory', async () => {
  const originalDirectory = process.cwd();
  const rootExamplePath = ROOT_ENV_PATH.replace(/\.env$/u, '.env.example');

  try {
    process.chdir('/');
    const configuration = await runEffectTestPromise(
      loadDatabaseConfig({
        environment: {},
        envPath: rootExamplePath,
      }),
    );

    assert.equal(ROOT_ENV_PATH.endsWith('/app/.env'), true);
    assert.equal(
      configuration.connectionString,
      'postgresql://ontos_runtime:ontos_runtime@localhost:5433/ontos',
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

void test('parses valid local PostgreSQL connection settings', async () => {
  const configuration = await runEffectTestPromise(
    parseDatabaseConfig({
      DATABASE_URL: 'postgresql://ontos:ontos@localhost:5433/ontos',
    }),
  );

  assert.deepEqual(configuration, {
    connectionString: 'postgresql://ontos:ontos@localhost:5433/ontos',
    database: 'ontos',
    host: 'localhost',
    port: 5433,
    user: 'ontos',
  });
});

void test('keeps missing and malformed configuration in the typed error channel', async () => {
  const missing = await runEffectTestPromise(Effect.flip(parseDatabaseConfig({})));
  const malformed = await runEffectTestPromise(
    Effect.flip(
      parseDatabaseConfig({
        DATABASE_URL: 'https://localhost/not-postgres',
      }),
    ),
  );

  assert.ok(Predicate.isTagged(missing, 'DatabaseConfigError'));
  assert.ok(Predicate.isTagged(malformed, 'DatabaseConfigError'));
});

void test('requires distinct administrative and least-privilege runtime identities', async () => {
  const valid = await runEffectTestPromise(
    parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
      DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
    }),
  );
  const missing = await runEffectTestPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
      }),
    ),
  );
  const identical = await runEffectTestPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos:secret@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://ontos:secret@localhost:5433/ontos',
      }),
    ),
  );
  const superuserCompatible = await runEffectTestPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://postgres:secret@localhost:5433/ontos',
      }),
    ),
  );
  const queryParameterIdentities = await runEffectTestPromise(
    parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://connection-proxy@localhost:5433/ontos?user=ontos_admin',
      DATABASE_URL: 'postgresql://connection-proxy@localhost:5433/ontos?user=ontos_runtime',
    }),
  );
  const queryParameterCollision = await runEffectTestPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://admin-authority@localhost:5433/ontos?user=effective_role',
        DATABASE_URL: 'postgresql://runtime-authority@localhost:5433/ontos?user=effective_role',
      }),
    ),
  );

  assert.equal(valid.admin.user, 'ontos_admin');
  assert.equal(valid.runtime.user, 'ontos_runtime');
  assert.equal(queryParameterIdentities.admin.user, 'ontos_admin');
  assert.equal(queryParameterIdentities.runtime.user, 'ontos_runtime');
  assert.ok(Predicate.isTagged(missing, 'DatabaseConfigError'));
  assert.ok(Predicate.isTagged(identical, 'DatabaseConfigError'));
  assert.ok(Predicate.isTagged(queryParameterCollision, 'DatabaseConfigError'));
  assert.ok(Predicate.isTagged(superuserCompatible, 'DatabaseConfigError'));
});

void test('finalizes the pool resource when its Effect scope closes', async () => {
  let finalized = false;

  await runEffectTestPromise(
    Effect.scoped(
      acquirePoolResource(() => ({
        // oxlint-disable-next-line effect-native/no-promise-shaped-port -- This fixture implements pg Pool.end's foreign Promise API.
        end: async () => {
          finalized = true;
        },
      })),
    ),
  );

  assert.equal(finalized, true);
});
