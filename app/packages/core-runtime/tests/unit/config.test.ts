import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import { acquirePoolResource } from '../../src/db/client.ts';
import {
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../../src/db/config.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';

void test('loads synthetic configuration independently of the invocation directory', async () => {
  const originalDirectory = process.cwd();

  try {
    process.chdir('/');
    const configuration = await Effect.runPromise(
      loadDatabaseConfig({
        environment: {
          DATABASE_URL: 'postgresql://ontos_runtime:ontos_runtime@localhost:5433/ontos',
        },
        envPath: '/path/that/does/not/exist/ontos-config',
      }),
    );

    assert.equal(ROOT_ENV_PATH.endsWith('/app/.env'), true);
    assert.ok(Redacted.isRedacted(configuration.connectionString));
    assert.equal(
      Redacted.value(configuration.connectionString),
      'postgresql://ontos_runtime:ontos_runtime@localhost:5433/ontos',
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

void test('keeps SpiceDB loader failures typed and secret-safe', async () => {
  const secret = 'spicedb-secret';
  const environment = {
    SPICEDB_ENDPOINT: 'spicedb.internal.example:443',
    SPICEDB_INSECURE: 'false',
    SPICEDB_PRESHARED_KEY: secret,
  };
  const configuration = await Effect.runPromise(
    loadSpiceDbConfig({
      environment,
      envPath: '/path/that/does/not/exist/ontos-spicedb-config',
    }),
  );
  const failure = await Effect.runPromise(
    Effect.flip(
      loadSpiceDbConfig({
        environment,
        envPath: process.cwd(),
      }),
    ),
  );

  assert.deepEqual(configuration, {
    endpoint: 'spicedb.internal.example:443',
    insecureLocal: false,
    preSharedKey: secret,
  });
  assert.equal(failure._tag, 'SpiceDbConfigError');
  assert.equal(failure.reason, 'Unable to load the root environment');
  assert.doesNotMatch(failure.reason, /spicedb-secret/u);
  assert.doesNotMatch(JSON.stringify(failure), /spicedb-secret/u);
});

void test('parses valid local PostgreSQL connection settings', async () => {
  const configuration = await Effect.runPromise(
    parseDatabaseConfig({
      DATABASE_URL: 'postgresql://ontos:ontos@localhost:5433/ontos',
    }),
  );

  assert.ok(Redacted.isRedacted(configuration.connectionString));
  assert.deepEqual(
    {
      ...configuration,
      connectionString: Redacted.value(configuration.connectionString),
    },
    {
      connectionString: 'postgresql://ontos:ontos@localhost:5433/ontos',
      database: 'ontos',
      host: 'localhost',
      port: 5433,
      user: 'ontos',
    },
  );
});

void test('keeps missing and malformed configuration in the typed error channel', async () => {
  const malformedDsn = 'https://runtime:database-password@example.test/not-postgres';
  const malformedEncodingDsn = 'postgresql://runtime:database-password@localhost:5433/%E0%A4%A';
  const missing = await Effect.runPromise(Effect.flip(parseDatabaseConfig({})));
  const malformed = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConfig({
        DATABASE_URL: malformedDsn,
      }),
    ),
  );
  const malformedEncoding = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConfig({
        DATABASE_URL: malformedEncodingDsn,
      }),
    ),
  );

  for (const error of [missing, malformed, malformedEncoding]) {
    assert.equal(error._tag, 'DatabaseConfigError');
    assert.doesNotMatch(error.reason, /database-password/u);
    assert.doesNotMatch(JSON.stringify(error), /database-password/u);
  }
});

void test('requires distinct administrative and least-privilege runtime identities', async () => {
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
  const queryParameterIdentities = await Effect.runPromise(
    parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://connection-proxy@localhost:5433/ontos?user=ontos_admin',
      DATABASE_URL: 'postgresql://connection-proxy@localhost:5433/ontos?user=ontos_runtime',
    }),
  );
  const queryParameterCollision = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://admin-authority@localhost:5433/ontos?user=effective_role',
        DATABASE_URL: 'postgresql://runtime-authority@localhost:5433/ontos?user=effective_role',
      }),
    ),
  );
  const malformedAdmin = await Effect.runPromise(
    Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://admin:admin-password@localhost:5433/%E0%A4%A',
        DATABASE_URL: 'postgresql://runtime:runtime-password@localhost:5433/ontos',
      }),
    ),
  );

  assert.equal(valid.admin.user, 'ontos_admin');
  assert.equal(valid.runtime.user, 'ontos_runtime');
  assert.equal(queryParameterIdentities.admin.user, 'ontos_admin');
  assert.equal(queryParameterIdentities.runtime.user, 'ontos_runtime');
  assert.equal(missing._tag, 'DatabaseConfigError');
  assert.equal(identical._tag, 'DatabaseConfigError');
  assert.equal(queryParameterCollision._tag, 'DatabaseConfigError');
  assert.equal(superuserCompatible._tag, 'DatabaseConfigError');
  assert.equal(malformedAdmin._tag, 'DatabaseConfigError');

  for (const error of [
    missing,
    identical,
    queryParameterCollision,
    superuserCompatible,
    malformedAdmin,
  ]) {
    assert.doesNotMatch(error.reason, /secret|password/u);
    assert.doesNotMatch(JSON.stringify(error), /secret|password/u);
  }
});

void test('finalizes the pool resource when its Effect scope closes', async () => {
  let finalized = false;

  await Effect.runPromise(
    Effect.scoped(
      acquirePoolResource(() => ({
        end: async () => {
          finalized = true;
        },
      })),
    ),
  );

  assert.equal(finalized, true);
});
