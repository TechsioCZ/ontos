import { Config, ConfigProvider, Effect, Predicate } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../src/db/database-identities.ts';
import type { DatabaseIdentity } from '../../src/db/database-identities.ts';
import { databaseRuntime } from '../../src/db/database-runtime.workerd.ts';

const bindings = rs.hoisted(() => ({
  env: {
    GATEWAY_ISSUER_HYPERDRIVE: { connectionString: 'postgresql://shell_gateway_issuer@hyperdrive.local:5432/ontos' },
    HYPERDRIVE: { connectionString: 'postgresql://ontos_runtime@hyperdrive.local:5432/ontos' },
  },
}));

rs.mock('cloudflare:workers', () => ({ env: bindings.env }));

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

it.effect('a missing Hyperdrive binding fails with the binding name', () =>
  Effect.gen(function* missingBindingFails() {
    const failure = yield* Effect.flip(databaseRuntime.runtimeDatabaseProvider(base, PARTY_REGISTRY_REQUEST_IDENTITY));

    expect(Predicate.isTagged(failure, 'DatabaseConfigError')).toBe(true);
    expect(failure.reason).toBe('The PARTY_REGISTRY_HYPERDRIVE Worker binding is required');
  }),
);

it.effect('an identity without a Worker binding cannot connect from a Worker', () =>
  Effect.gen(function* workerOnlyIdentityFails() {
    const failure = yield* Effect.flip(databaseRuntime.runtimeDatabaseProvider(base, PARTY_REGISTRY_WORKER_IDENTITY));

    expect(Predicate.isTagged(failure, 'DatabaseConfigError')).toBe(true);
    expect(failure.reason).toBe('This database identity has no Cloudflare Worker binding');
  }),
);
