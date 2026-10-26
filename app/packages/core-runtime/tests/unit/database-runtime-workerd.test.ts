import { Config, ConfigProvider, Effect, Predicate } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY } from '../../src/db/database-identities.ts';
import type { DatabaseIdentity } from '../../src/db/database-identities.ts';
import { databaseRuntime } from '../../src/db/database-runtime.workerd.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { FIXTURE_REQUEST_IDENTITY, FIXTURE_WORKER_IDENTITY } from '../support/database-identities.ts';

const bindings = rs.hoisted(() => ({
  env: {
    GATEWAY_ISSUER_HYPERDRIVE: {
      connectionString: 'postgresql://issuer-proxy:proxy-secret@issuer.hyperdrive.local:5432/issuer-slot',
    },
    HYPERDRIVE: {
      connectionString: 'postgresql://runtime-proxy:proxy-secret@runtime.hyperdrive.local:5432/runtime-slot',
    },
  },
}));

rs.mock('cloudflare:workers', () => ({ env: bindings.env }));
rs.mock('#database-runtime', () => ({ databaseRuntime }));

const adminUrl = 'postgresql://ontos_admin@localhost:5433/ontos';
const base = ConfigProvider.fromUnknown({ DATABASE_ADMIN_URL: adminUrl });

const readWorkerUrls = (identity: DatabaseIdentity) =>
  databaseRuntime
    .runtimeDatabaseProvider(base, identity)
    .pipe(
      Effect.flatMap((provider) =>
        Effect.all([
          Config.String(identity.urlKey).parse(provider),
          Config.String('DATABASE_ADMIN_URL').parse(provider),
        ]),
      ),
    );

it.effect('each Worker identity reads its own Hyperdrive binding under its URL key', () =>
  Effect.gen(function* workerIdentitiesUseTheirBindings() {
    const shared = yield* readWorkerUrls(SHARED_RUNTIME_IDENTITY);
    const issuer = yield* readWorkerUrls(SHELL_GATEWAY_ISSUER_IDENTITY);

    expect(shared).toEqual([bindings.env.HYPERDRIVE.connectionString, adminUrl]);
    expect(issuer).toEqual([bindings.env.GATEWAY_ISSUER_HYPERDRIVE.connectionString, adminUrl]);
  }),
);

it.effect('loads proxy transport credentials without claiming they identify the origin role or database', () =>
  Effect.gen(function* proxyCredentialsAreNotOriginMetadata() {
    for (const identity of [SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY]) {
      const configuration = yield* loadDatabaseConfig({
        environment: { DATABASE_URL: 'postgresql://untrusted-direct@localhost:5432/untrusted' },
        envPath: '/nonexistent/ontos-worker-config-test/.env',
        identity,
      });
      const expectedUrl =
        identity.id === SHARED_RUNTIME_IDENTITY.id
          ? bindings.env.HYPERDRIVE.connectionString
          : bindings.env.GATEWAY_ISSUER_HYPERDRIVE.connectionString;

      expect(configuration.connectionString).toBe(expectedUrl);
      expect(configuration.expectedRole).toBe(identity.role);
      expect(configuration).not.toHaveProperty('user');
      expect(configuration).not.toHaveProperty('database');
    }
  }),
);

it.effect('a missing Hyperdrive binding fails with the binding name', () =>
  Effect.gen(function* missingBindingFails() {
    const failure = yield* Effect.flip(databaseRuntime.runtimeDatabaseProvider(base, FIXTURE_REQUEST_IDENTITY));

    expect(Predicate.isTagged(failure, 'DatabaseConfigError')).toBe(true);
    expect(failure.reason).toBe('The PARTY_REGISTRY_HYPERDRIVE Worker binding is required');
  }),
);

it.effect('an identity without a Worker binding cannot connect from a Worker', () =>
  Effect.gen(function* workerOnlyIdentityFails() {
    const failure = yield* Effect.flip(databaseRuntime.runtimeDatabaseProvider(base, FIXTURE_WORKER_IDENTITY));

    expect(Predicate.isTagged(failure, 'DatabaseConfigError')).toBe(true);
    expect(failure.reason).toBe('This database identity has no Cloudflare Worker binding');
  }),
);
