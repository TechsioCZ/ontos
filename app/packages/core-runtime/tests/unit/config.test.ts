import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  loadDatabaseIdentityConnections,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../../src/db/config.ts';
import type { DatabaseEnvironment } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY } from '../../src/db/database-identities.ts';
import {
  FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  FIXTURE_REQUEST_IDENTITY,
  FIXTURE_WORKER_IDENTITY,
} from '../support/database-identities.ts';

/** No dotenv file, so each test sees only the environment it passes. */
const missingEnvPath = '/nonexistent/ontos-config-test/.env';

const identityEnvironment = {
  DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
  DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
  PARTY_REGISTRY_DATABASE_URL: 'postgresql://party_registry_runtime:party@localhost:5433/ontos',
  PARTY_REGISTRY_WORKER_DATABASE_URL: 'postgresql://party_registry_worker:worker@localhost:5433/ontos',
  SHELL_GATEWAY_ISSUER_DATABASE_URL: 'postgresql://shell_gateway_issuer:issuer@localhost:5433/ontos',
} satisfies DatabaseEnvironment;

const identityFailure = (overrides: DatabaseEnvironment) =>
  Effect.flip(
    loadDatabaseIdentityConnections({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      environment: { ...identityEnvironment, ...overrides },
      envPath: missingEnvPath,
    }),
  ).pipe(Effect.map((error) => error.reason));

it.layer(NodeServices.layer)((suite) => {
  suite.effect('loads an absolute configuration fixture independently of the invocation directory', () =>
    Effect.gen(function* absoluteConfigurationFixture() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-database-config-' });
      const fixturePath = `${directory}/database.fixture`;
      const connectionString = 'postgresql://ontos_runtime:ontos_runtime@localhost:5433/ontos';
      yield* fileSystem.writeFileString(fixturePath, `DATABASE_URL=${connectionString}\n`);
      const originalDirectory = process.cwd();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.chdir(originalDirectory);
        }),
      );
      process.chdir('/');
      const configuration = yield* loadDatabaseConfig({
        environment: {},
        envPath: fixturePath,
        identity: SHARED_RUNTIME_IDENTITY,
      });

      expect(configuration.user).toBe(SHARED_RUNTIME_IDENTITY.role);
      expect(configuration.connectionString).toBe(connectionString);
    }),
  );
});

it.effect('parses valid local PostgreSQL connection settings', () =>
  Effect.gen(function* migratedTest() {
    const configuration = yield* parseDatabaseConfig({
      DATABASE_URL: 'postgresql://ontos:ontos@localhost:5433/ontos',
    });

    expect(configuration).toEqual({
      connectionString: 'postgresql://ontos:ontos@localhost:5433/ontos',
      database: 'ontos',
      host: 'localhost',
      port: 5433,
      user: 'ontos',
    });
  }),
);

it.effect('keeps missing and malformed configuration in the typed error channel', () =>
  Effect.gen(function* migratedTest() {
    const missing = yield* Effect.flip(parseDatabaseConfig({}));
    const malformed = yield* Effect.flip(
      parseDatabaseConfig({
        DATABASE_URL: 'https://localhost/not-postgres',
      }),
    );

    expect(Predicate.isTagged(missing, 'DatabaseConfigError')).toBe(true);
    expect(Predicate.isTagged(malformed, 'DatabaseConfigError')).toBe(true);
  }),
);

it.effect('requires distinct administrative and least-privilege runtime identities', () =>
  Effect.gen(function* migratedTest() {
    const valid = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
      DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
    });
    const missing = yield* Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
      }),
    );
    const identical = yield* Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos:secret@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://ontos:secret@localhost:5433/ontos',
      }),
    );
    const superuserCompatible = yield* Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
        DATABASE_URL: 'postgresql://postgres:secret@localhost:5433/ontos',
      }),
    );
    const queryParameterIdentities = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: 'postgresql://connection-proxy@localhost:5433/ontos?user=ontos_admin',
      DATABASE_URL: 'postgresql://connection-proxy@localhost:5433/ontos?user=ontos_runtime',
    });
    const queryParameterCollision = yield* Effect.flip(
      parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: 'postgresql://admin-authority@localhost:5433/ontos?user=effective_role',
        DATABASE_URL: 'postgresql://runtime-authority@localhost:5433/ontos?user=effective_role',
      }),
    );

    expect(valid.admin.user).toBe('ontos_admin');
    expect(valid.runtime.user).toBe('ontos_runtime');
    expect(queryParameterIdentities.admin.user).toBe('ontos_admin');
    expect(queryParameterIdentities.runtime.user).toBe('ontos_runtime');
    expect(Predicate.isTagged(missing, 'DatabaseConfigError')).toBe(true);
    expect(Predicate.isTagged(identical, 'DatabaseConfigError')).toBe(true);
    expect(Predicate.isTagged(queryParameterCollision, 'DatabaseConfigError')).toBe(true);
    expect(Predicate.isTagged(superuserCompatible, 'DatabaseConfigError')).toBe(true);
  }),
);

it.effect('each runtime identity loads from its own URL key and names that key when it is missing', () =>
  Effect.gen(function* identityKeysAreRead() {
    const environment = { environment: identityEnvironment, envPath: missingEnvPath };
    const issuer = yield* loadDatabaseConfig({ ...environment, identity: SHELL_GATEWAY_ISSUER_IDENTITY });
    const party = yield* loadDatabaseConfig({ ...environment, identity: FIXTURE_REQUEST_IDENTITY });
    const workerPair = yield* loadDatabaseConnectionPair({ ...environment, identity: FIXTURE_WORKER_IDENTITY });
    const shared = yield* loadDatabaseConfig({ ...environment, identity: SHARED_RUNTIME_IDENTITY });
    const missing = yield* Effect.flip(
      loadDatabaseConfig({
        environment: { DATABASE_URL: identityEnvironment.DATABASE_URL },
        envPath: missingEnvPath,
        identity: FIXTURE_REQUEST_IDENTITY,
      }),
    );

    expect(issuer.user).toBe('shell_gateway_issuer');
    expect(party.user).toBe('party_registry_runtime');
    expect(workerPair.runtime.user).toBe('party_registry_worker');
    expect(workerPair.admin.user).toBe('ontos_admin');
    expect(shared.user).toBe('ontos_runtime');
    expect(missing.reason).toBe('PARTY_REGISTRY_DATABASE_URL is required');
  }),
);

it.effect('a runtime identity URL must connect as that identity role', () =>
  Effect.gen(function* identityRoleIsChecked() {
    const mismatches = [
      [SHARED_RUNTIME_IDENTITY, { DATABASE_URL: 'postgresql://party_registry_runtime:secret@localhost:5433/ontos' }],
      [
        FIXTURE_REQUEST_IDENTITY,
        { PARTY_REGISTRY_DATABASE_URL: 'postgresql://ontos_runtime:secret@localhost:5433/ontos' },
      ],
      [
        FIXTURE_REQUEST_IDENTITY,
        {
          PARTY_REGISTRY_DATABASE_URL:
            'postgresql://party_registry_runtime:secret@localhost:5433/ontos?user=ontos_runtime',
        },
      ],
    ] as const;
    for (const [identity, environment] of mismatches) {
      const failure = yield* Effect.flip(loadDatabaseConfig({ environment, envPath: missingEnvPath, identity }));
      expect(failure.reason).toBe(`${identity.urlKey} must connect as the ${identity.role} role`);
    }
  }),
);

it.effect('loads every checked-in identity against the admin database', () =>
  Effect.gen(function* identityConnectionsLoad() {
    const connections = yield* loadDatabaseIdentityConnections({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      environment: identityEnvironment,

      envPath: missingEnvPath,
    });

    expect(connections.admin.user).toBe('ontos_admin');
    expect(Object.fromEntries(Object.entries(connections.runtime).map(([id, { user }]) => [id, user]))).toEqual({
      party_registry_request: 'party_registry_runtime',
      party_registry_worker: 'party_registry_worker',
      shared_runtime: 'ontos_runtime',
      shell_gateway_issuer: 'shell_gateway_issuer',
    });
  }),
);

it.effect('rejects identity connections that share, swap or redirect their login', () =>
  Effect.gen(function* identityConnectionsFailClosed() {
    const equalUsers = yield* identityFailure({
      DATABASE_ADMIN_URL: 'postgresql://ontos_runtime:admin@localhost:5433/ontos',
    });
    const wrongUser = yield* identityFailure({
      PARTY_REGISTRY_DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
    });
    const otherDatabase = yield* identityFailure({
      PARTY_REGISTRY_WORKER_DATABASE_URL: 'postgresql://party_registry_worker:worker@localhost:5433/other',
    });
    const otherHost = yield* identityFailure({
      SHELL_GATEWAY_ISSUER_DATABASE_URL: 'postgresql://shell_gateway_issuer:issuer@db.internal:5433/ontos',
    });
    const userOverride = yield* identityFailure({
      PARTY_REGISTRY_DATABASE_URL: 'postgresql://party_registry_runtime:party@localhost:5433/ontos?user=ontos_admin',
    });
    const adminOverride = yield* identityFailure({
      DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos?dbname=other',
    });

    expect(equalUsers).toBe('Administrative and runtime PostgreSQL identities must be distinct');
    expect(wrongUser).toBe('PARTY_REGISTRY_DATABASE_URL must connect as the party_registry_runtime role');
    expect(otherDatabase).toBe(
      'PARTY_REGISTRY_WORKER_DATABASE_URL must target the DATABASE_ADMIN_URL server and database',
    );
    expect(otherHost).toBe('SHELL_GATEWAY_ISSUER_DATABASE_URL must target the DATABASE_ADMIN_URL server and database');
    expect(userOverride).toBe(
      'PARTY_REGISTRY_DATABASE_URL must not override its user, server or database with parameters',
    );
    expect(adminOverride).toBe('DATABASE_ADMIN_URL must not override its user, server or database with parameters');
  }),
);
