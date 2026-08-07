import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import { acquirePoolResource } from '../../src/db/client.ts';
import {
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../../src/db/config.ts';

test('loads the root environment independently of the invocation directory', async () => {
  const originalDirectory = process.cwd();
  const rootExamplePath = ROOT_ENV_PATH.replace(/\.env$/u, '.env.example');

  try {
    process.chdir('/');
    const configuration = await Effect.runPromise(
      loadDatabaseConfig({
        envPath: rootExamplePath,
        environment: {},
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

test('parses valid local PostgreSQL connection settings', async () => {
  const configuration = await Effect.runPromise(
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

test('keeps missing and malformed configuration in the typed error channel', async () => {
  const missing = await Effect.runPromise(Effect.flip(parseDatabaseConfig({})));
  const malformed = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConfig({
        DATABASE_URL: 'https://localhost/not-postgres',
      }),
    ),
  );

  assert.equal(missing._tag, 'DatabaseConfigError');
  assert.equal(malformed._tag, 'DatabaseConfigError');
});

test('requires distinct administrative and least-privilege runtime identities', async () => {
  const valid = await Effect.runPromise(
    parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
      DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
    }),
  );
  const missing = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
      }),
    ),
  );
  const identical = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos:secret@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://ontos:secret@localhost:5433/ontos',
      }),
    ),
  );
  const superuserCompatible = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://postgres:secret@localhost:5433/ontos',
      }),
    ),
  );

  assert.equal(valid.admin.user, 'ontos_admin');
  assert.equal(valid.runtime.user, 'ontos_runtime');
  assert.equal(missing._tag, 'DatabaseConfigError');
  assert.equal(identical._tag, 'DatabaseConfigError');
  assert.equal(superuserCompatible._tag, 'DatabaseConfigError');
});

test('finalizes the pool resource when its Effect scope closes', async () => {
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
