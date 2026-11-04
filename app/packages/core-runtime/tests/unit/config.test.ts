import { NodeFileSystem, NodePath } from '@effect/platform-node';
import { Config, Effect, FileSystem, Layer, Path, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  loadDatabaseIdentityConnections,
  loadAdministrativeDatabaseConnection,
  loadSelectedDatabaseIdentityConnections,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../../src/db/config.ts';
import type { DatabaseEnvironment } from '../../src/db/config.ts';
import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../src/db/database-identities.ts';
import { resolveAppWorkspaceRoot } from '../../src/environment/workspace-environment.ts';

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
    loadDatabaseIdentityConnections({ environment: { ...identityEnvironment, ...overrides }, envPath: missingEnvPath }),
  ).pipe(Effect.map((error) => error.reason));

it.effect('loads a root-anchored database file fixture independently of the invocation directory', () =>
  Layer.build(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)).pipe(
    Effect.flatMap((services) =>
      Effect.gen(function* loadsRootDatabaseFixture() {
        const fileSystem = yield* FileSystem.FileSystem;
        const nodePath = yield* Path.Path;
        const originalDirectory = process.cwd();
        const workspaceRoot = resolveAppWorkspaceRoot(originalDirectory);
        const explicitEnvironmentPath = yield* Config.String('APP_ENV_PATH').pipe(Config.withDefault(''));
        const expectedEnvironmentPath = nodePath.resolve(
          workspaceRoot ?? originalDirectory,
          explicitEnvironmentPath.length === 0 ? '.env' : explicitEnvironmentPath,
        );
        expect(ROOT_ENV_PATH).toBe(expectedEnvironmentPath);
        if (explicitEnvironmentPath.length === 0) {
          expect(ROOT_ENV_PATH.endsWith('/app/.env')).toBe(true);
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            process.chdir(originalDirectory);
          }),
        );
        const fixtureDirectory = yield* fileSystem.makeTempDirectoryScoped({
          directory: workspaceRoot ?? originalDirectory,
          prefix: '.unit-database-',
        });
        const fixturePath = nodePath.join(fixtureDirectory, 'database.fixture');
        yield* fileSystem.writeFileString(fixturePath, `DATABASE_URL=${identityEnvironment.DATABASE_URL}\n`, {
          mode: 0o600,
        });
        process.chdir('/');
        expect(ROOT_ENV_PATH).toBe(expectedEnvironmentPath);
        const configuration = yield* loadDatabaseConfig({
          environment: {},
          envPath: fixturePath,
          identity: SHARED_RUNTIME_IDENTITY,
        });

        expect(configuration.connectionString).toBe(identityEnvironment.DATABASE_URL);
      }).pipe(Effect.provide(services)),
    ),
  ),
);

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
    const party = yield* loadDatabaseConfig({ ...environment, identity: PARTY_REGISTRY_REQUEST_IDENTITY });
    const workerPair = yield* loadDatabaseConnectionPair({ ...environment, identity: PARTY_REGISTRY_WORKER_IDENTITY });
    const shared = yield* loadDatabaseConfig({ ...environment, identity: SHARED_RUNTIME_IDENTITY });
    const missing = yield* Effect.flip(
      loadDatabaseConfig({
        environment: { DATABASE_URL: identityEnvironment.DATABASE_URL },
        envPath: missingEnvPath,
        identity: PARTY_REGISTRY_REQUEST_IDENTITY,
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
        PARTY_REGISTRY_REQUEST_IDENTITY,
        { PARTY_REGISTRY_DATABASE_URL: 'postgresql://ontos_runtime:secret@localhost:5433/ontos' },
      ],
      [
        PARTY_REGISTRY_REQUEST_IDENTITY,
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

it.effect('loads only selected canonical identity URLs and leaves excluded identities absent', () =>
  Effect.gen(function* selectedConnections() {
    const selected = yield* loadSelectedDatabaseIdentityConnections({
      environment: {
        DATABASE_ADMIN_URL: identityEnvironment.DATABASE_ADMIN_URL,
        DATABASE_URL: identityEnvironment.DATABASE_URL,
        PARTY_REGISTRY_DATABASE_URL: 'unrelated malformed URL',
      },
      envPath: missingEnvPath,
      identityIds: ['shared_runtime'],
    });
    expect([...selected.runtime.keys()]).toEqual(['shared_runtime']);
    expect(selected.runtime.get('shared_runtime')?.user).toBe('ontos_runtime');
    expect(selected.runtime.has('party_registry_request')).toBe(false);
    const party = yield* loadSelectedDatabaseIdentityConnections({
      environment: {
        DATABASE_ADMIN_URL: identityEnvironment.DATABASE_ADMIN_URL,
        PARTY_REGISTRY_DATABASE_URL: identityEnvironment.PARTY_REGISTRY_DATABASE_URL,
        PARTY_REGISTRY_WORKER_DATABASE_URL: identityEnvironment.PARTY_REGISTRY_WORKER_DATABASE_URL,
      },
      envPath: missingEnvPath,
      identityIds: ['party_registry_worker', 'party_registry_request'],
    });
    expect([...party.runtime.keys()]).toEqual(['party_registry_request', 'party_registry_worker']);
    expect(party.runtime.has('shared_runtime')).toBe(false);
  }),
);

it.effect('rejects empty, duplicate and unknown selected identities before configuration loading', () =>
  Effect.gen(function* invalidSelection() {
    for (const identityIds of [[], ['shared_runtime', 'shared_runtime'], ['unknown'], ['']]) {
      const failure = yield* loadSelectedDatabaseIdentityConnections({
        environment: {},
        envPath: missingEnvPath,
        identityIds,
      }).pipe(Effect.flip);
      expect(failure.reason).toContain('identity selection');
      expect(failure.reason).not.toContain('DATABASE_ADMIN_URL is required');
    }
  }),
);

it.effect('preserves strict role, override, target and admin separation checks for selected identities', () =>
  Effect.gen(function* selectedIdentitySecurity() {
    const cases: readonly { readonly environment: DatabaseEnvironment; readonly reason: string }[] = [
      {
        environment: { ...identityEnvironment, PARTY_REGISTRY_DATABASE_URL: identityEnvironment.DATABASE_URL },
        reason: 'must connect as the party_registry_runtime role',
      },
      {
        environment: {
          ...identityEnvironment,
          PARTY_REGISTRY_DATABASE_URL: 'postgresql://party_registry_runtime:party@localhost:5433/other',
        },
        reason: 'must target the DATABASE_ADMIN_URL server and database',
      },
      {
        environment: {
          ...identityEnvironment,
          PARTY_REGISTRY_DATABASE_URL: 'postgresql://party_registry_runtime:party@elsewhere:5433/ontos',
        },
        reason: 'must target the DATABASE_ADMIN_URL server and database',
      },
      {
        environment: {
          ...identityEnvironment,
          PARTY_REGISTRY_DATABASE_URL: 'postgresql://party_registry_runtime:party@localhost:5434/ontos',
        },
        reason: 'must target the DATABASE_ADMIN_URL server and database',
      },
      {
        environment: { ...identityEnvironment, DATABASE_ADMIN_URL: identityEnvironment.PARTY_REGISTRY_DATABASE_URL },
        reason: 'Administrative and runtime PostgreSQL identities must be distinct',
      },
      {
        environment: {
          ...identityEnvironment,
          DATABASE_ADMIN_URL: `${identityEnvironment.DATABASE_ADMIN_URL}?user=other`,
        },
        reason: 'must not override its user, server or database with parameters',
      },
    ];
    for (const parameter of ['user', 'host', 'hostaddr', 'port', 'db', 'database', 'dbname', 'USER']) {
      const failure = yield* loadSelectedDatabaseIdentityConnections({
        environment: {
          ...identityEnvironment,
          PARTY_REGISTRY_DATABASE_URL: `${identityEnvironment.PARTY_REGISTRY_DATABASE_URL}?${parameter}=other`,
        },
        envPath: missingEnvPath,
        identityIds: ['party_registry_request'],
      }).pipe(Effect.flip);
      expect(failure.reason).toBe(
        'PARTY_REGISTRY_DATABASE_URL must not override its user, server or database with parameters',
      );
    }
    for (const { environment, reason } of cases) {
      const failure = yield* loadSelectedDatabaseIdentityConnections({
        environment,
        envPath: missingEnvPath,
        identityIds: ['party_registry_request'],
      }).pipe(Effect.flip);
      expect(failure.reason).toContain(reason);
    }
    const all = yield* loadSelectedDatabaseIdentityConnections({
      environment: identityEnvironment,
      envPath: missingEnvPath,
      identityIds: ['shared_runtime', 'shell_gateway_issuer', 'party_registry_request', 'party_registry_worker'],
    });
    const previous = yield* loadDatabaseIdentityConnections({
      environment: identityEnvironment,
      envPath: missingEnvPath,
    });
    for (const [id, connection] of all.runtime) {
      expect(connection).toEqual(previous.runtime[id]);
    }
  }),
);

it.effect('admin-only observation does not require or parse unrelated runtime credentials', () =>
  Effect.gen(function* administrativeObservation() {
    const connection = yield* loadAdministrativeDatabaseConnection({
      environment: {
        DATABASE_ADMIN_URL: identityEnvironment.DATABASE_ADMIN_URL,
        DATABASE_URL: 'unrelated invalid URL',
      },
      envPath: missingEnvPath,
    });
    expect(connection.user).toBe('ontos_admin');
    expect(connection.database).toBe('ontos');
  }),
);

it.effect('admin-only observation rejects missing, malformed and identity-overriding administrative URLs', () =>
  Effect.gen(function* invalidAdministrativeObservation() {
    for (const environment of [
      {},
      { DATABASE_ADMIN_URL: 'invalid' },
      { DATABASE_ADMIN_URL: `${identityEnvironment.DATABASE_ADMIN_URL}?host=elsewhere` },
    ]) {
      const failure = yield* loadAdministrativeDatabaseConnection({ environment, envPath: missingEnvPath }).pipe(
        Effect.flip,
      );
      expect(failure.reason).toContain('DATABASE_ADMIN_URL');
    }
  }),
);
