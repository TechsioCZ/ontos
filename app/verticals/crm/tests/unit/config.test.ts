import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import { acquireCrmPoolResource } from '../../src/db/client.ts';
import {
  CRM_ROOT_ENV_PATH,
  loadCrmDatabaseConfig,
  parseCrmDatabaseConfig,
  parseCrmDatabaseConnectionPair,
} from '../../src/db/config.ts';

test('loads CRM database configuration from the workspace root', async () => {
  const originalDirectory = process.cwd();
  const rootExamplePath = CRM_ROOT_ENV_PATH.replace(/\.env$/u, '.env.example');

  try {
    process.chdir('/');
    const configuration = await Effect.runPromise(
      loadCrmDatabaseConfig({
        envPath: rootExamplePath,
        environment: {},
      }),
    );

    assert.equal(CRM_ROOT_ENV_PATH.endsWith('/app/.env'), true);
    assert.equal(configuration.user, 'ontos_runtime');
  } finally {
    process.chdir(originalDirectory);
  }
});

test('keeps missing and malformed CRM configuration in the typed error channel', async () => {
  const missing = await Effect.runPromise(Effect.flip(parseCrmDatabaseConfig({})));
  const malformed = await Effect.runPromise(
    Effect.flip(parseCrmDatabaseConfig({ DATABASE_URL: 'https://localhost/not-postgres' })),
  );

  assert.equal(missing._tag, 'CrmDatabaseConfigError');
  assert.equal(malformed._tag, 'CrmDatabaseConfigError');
});

test('requires separate admin and ontos_runtime identities', async () => {
  const valid = await Effect.runPromise(
    parseCrmDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
      DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
    }),
  );
  const missingAdmin = await Effect.runPromise(
    Effect.flip(
      parseCrmDatabaseConnectionPair({
        DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
      }),
    ),
  );
  const wrongRuntime = await Effect.runPromise(
    Effect.flip(
      parseCrmDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://crm_app:runtime@localhost:5433/ontos',
      }),
    ),
  );
  const identical = await Effect.runPromise(
    Effect.flip(
      parseCrmDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
      }),
    ),
  );

  assert.equal(valid.admin.user, 'ontos_admin');
  assert.equal(valid.runtime.user, 'ontos_runtime');
  assert.equal(missingAdmin._tag, 'CrmDatabaseConfigError');
  assert.equal(wrongRuntime._tag, 'CrmDatabaseConfigError');
  assert.equal(identical._tag, 'CrmDatabaseConfigError');
});

test('finalizes the CRM pool resource when its Effect scope closes', async () => {
  let finalized = false;

  await Effect.runPromise(
    Effect.scoped(
      acquireCrmPoolResource(() => ({
        end: () => {
          finalized = true;
          return Promise.resolve();
        },
      })),
    ),
  );

  assert.equal(finalized, true);
});
