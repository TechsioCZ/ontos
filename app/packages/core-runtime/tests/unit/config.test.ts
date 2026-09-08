import { expect, it } from 'effect-rstest';

import { Effect, Predicate } from 'effect';
import { acquirePoolResource } from '../../src/db/client.ts';
import {
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '../../src/db/config.ts';

it.effect('loads the root environment independently of the invocation directory', () =>
  Effect.gen(function* migratedTest() {
    const originalDirectory = process.cwd();
    const rootExamplePath = ROOT_ENV_PATH.replace(/\.env$/u, '.env.example');

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.chdir(originalDirectory);
      }),
    );
    process.chdir('/');
    const configuration = yield* loadDatabaseConfig({
      environment: {},
      envPath: rootExamplePath,
    });

    expect(ROOT_ENV_PATH.endsWith('/app/.env')).toBe(true);
    expect(configuration.connectionString).toBe(
      'postgresql://ontos_runtime:ontos_runtime@localhost:5433/ontos',
    );
  }),
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

it.effect('finalizes the pool resource when its Effect scope closes', () =>
  Effect.gen(function* migratedTest() {
    let finalized = false;

    yield* Effect.scoped(
      acquirePoolResource(() => ({
        end: () => {
          finalized = true;
          return Promise.resolve();
        },
      })),
    );

    expect(finalized).toBe(true);
  }),
);
