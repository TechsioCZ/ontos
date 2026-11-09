import { Effect, Predicate, Redacted } from 'effect';
import { afterAll, expect, it, rs } from 'effect-rstest';

import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import type { LoadDatabaseConfigOptions, LoadDatabaseConnectionPairOptions } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { environmentTestAccessTarget } from '../../src/testing/tenant-access.ts';
import type { TestTenantAccessTarget } from '../../src/testing/tenant-access.ts';

/** No dotenv file, so each test sees only the environment it passes. */
const missingEnvPath = '/nonexistent/ontos-tenant-access-target-test/.env';

const runtimeUrl = 'postgresql://ontos_runtime:runtime@localhost:5433/ontos';
const adminUrl = 'postgresql://ontos_ci_admin:admin@localhost:5433/ontos';

const fixtureTarget: TestTenantAccessTarget = {
  spiceDb: { endpoint: '127.0.0.1:50051', preSharedKey: 'test-pre-shared-key' },
  writerConnectionString: Redacted.make(runtimeUrl),
};

// Only the environment boundary is substituted; the real config decoders and identity checks run.
rs.mock('../../src/db/config.ts', () => {
  const actual = rs.requireActual<{
    loadDatabaseConfig: typeof loadDatabaseConfig;
    loadDatabaseConnectionPair: typeof loadDatabaseConnectionPair;
  }>('../../src/db/config.ts');
  return {
    ...actual,
    loadDatabaseConfig: (options: LoadDatabaseConfigOptions) =>
      actual.loadDatabaseConfig({
        ...options,
        environment: options.environment ?? { DATABASE_URL: runtimeUrl },
        envPath: missingEnvPath,
      }),
    loadDatabaseConnectionPair: (options?: LoadDatabaseConnectionPairOptions) =>
      actual.loadDatabaseConnectionPair({
        ...options,
        environment: options?.environment ?? { DATABASE_URL: runtimeUrl },
        envPath: missingEnvPath,
      }),
  };
});
rs.mock('../../src/permissions/config.ts', () => ({
  ...rs.requireActual('../../src/permissions/config.ts'),
  loadSpiceDbConfig: () => Effect.succeed(fixtureTarget.spiceDb),
}));

afterAll(() => {
  rs.doUnmock('../../src/db/config.ts');
  rs.doUnmock('../../src/permissions/config.ts');
  rs.resetModules();
});

it('a fixture target carries a writer credential and no administrative one', () => {
  const hasAdminKey: 'adminConnectionString' extends keyof TestTenantAccessTarget ? true : false = false;
  expect(hasAdminKey).toBe(false);
  expect(Redacted.value(fixtureTarget.writerConnectionString)).toBe(runtimeUrl);
});

it.effect('the environment target selects the shared runtime credential and never the admin login', () =>
  Effect.gen(function* writerCredentialBoundary() {
    const target = yield* environmentTestAccessTarget;
    expect(Redacted.value(target.writerConnectionString)).toBe(runtimeUrl);
    expect(target.spiceDb).toEqual(fixtureTarget.spiceDb);
    // The shared runtime login the target now selects needs no administrative configuration.
    const writer = yield* loadDatabaseConfig({
      environment: { DATABASE_URL: runtimeUrl },
      envPath: missingEnvPath,
      identity: SHARED_RUNTIME_IDENTITY,
    });
    expect(writer.connectionString).toBe(runtimeUrl);
    expect(writer.expectedRole).toBe('ontos_runtime');

    // The administrative pair the target used to require is no longer consulted.
    const withoutAdmin = yield* Effect.flip(
      loadDatabaseConnectionPair({ environment: { DATABASE_URL: runtimeUrl }, envPath: missingEnvPath }),
    );
    expect(Predicate.isTagged(withoutAdmin, 'DatabaseConfigError')).toBe(true);
    expect(withoutAdmin.reason).toContain('DATABASE_ADMIN_URL');

    // An administrative login cannot stand in for the writer credential.
    const adminAsWriter = yield* Effect.flip(
      loadDatabaseConfig({
        environment: { DATABASE_URL: adminUrl },
        envPath: missingEnvPath,
        identity: SHARED_RUNTIME_IDENTITY,
      }),
    );
    expect(Predicate.isTagged(adminAsWriter, 'DatabaseConfigError')).toBe(true);
    expect(adminAsWriter.reason).toBe('DATABASE_URL must connect as the ontos_runtime role');
  }),
);
