import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const databaseRuntimeModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/db/database-runtime.workerd.ts', import.meta.url),
);
const databaseIdentitiesModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/db/database-identities.ts', import.meta.url),
);
const databaseConfigModule = fileURLToPath(new URL('../../packages/core-runtime/src/db/config.ts', import.meta.url));
const fixtureIdentitiesModule = fileURLToPath(
  new URL('../../packages/core-runtime/tests/support/database-identities.ts', import.meta.url),
);

const adminUrl = 'postgresql://ontos_admin@localhost:5433/ontos';

// The Worker module reads workerd's own Hyperdrive bindings through `cloudflare:workers`.
const probeWorker = `
import { env } from 'cloudflare:workers';
import { Config, ConfigProvider, Effect } from 'effect';
import { databaseRuntime } from ${JSON.stringify(databaseRuntimeModule)};
import { loadDatabaseConfig } from ${JSON.stringify(databaseConfigModule)};
import { SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY } from ${JSON.stringify(databaseIdentitiesModule)};
import { FIXTURE_REQUEST_IDENTITY, FIXTURE_WORKER_IDENTITY } from ${JSON.stringify(fixtureIdentitiesModule)};

const base = ConfigProvider.fromUnknown({ DATABASE_ADMIN_URL: ${JSON.stringify(adminUrl)} });
const read = (identity) =>
  Effect.runPromise(
    databaseRuntime.runtimeDatabaseProvider(base, identity).pipe(
      Effect.flatMap((provider) =>
        Effect.all([Config.String(identity.urlKey).parse(provider), Config.String('DATABASE_ADMIN_URL').parse(provider)]),
      ),
      Effect.match({
        onFailure: (failure) => ({ failure: { reason: failure.reason, tag: failure._tag } }),
        onSuccess: (urls) => ({ urls }),
      }),
    ),
  );
// A direct URL in the environment must not win over the binding, and the binding's proxy login is not the origin role.
const load = (identity) =>
  Effect.runPromise(
    loadDatabaseConfig({
      environment: { DATABASE_URL: 'postgresql://untrusted-direct@localhost:5432/untrusted' },
      envPath: '/nonexistent/ontos-worker-config-test/.env',
      identity,
    }).pipe(
      Effect.map((configuration) => ({
        connectionString: configuration.connectionString,
        expectedRole: configuration.expectedRole,
        keys: Object.keys(configuration).sort(),
        role: identity.role,
      })),
    ),
  );

export default {
  async fetch() {
    return Response.json({
      bindings: {
        issuer: env.GATEWAY_ISSUER_HYPERDRIVE.connectionString,
        shared: env.HYPERDRIVE.connectionString,
      },
      issuer: await read(SHELL_GATEWAY_ISSUER_IDENTITY),
      issuerConfiguration: await load(SHELL_GATEWAY_ISSUER_IDENTITY),
      missing: await read(FIXTURE_REQUEST_IDENTITY),
      shared: await read(SHARED_RUNTIME_IDENTITY),
      sharedConfiguration: await load(SHARED_RUNTIME_IDENTITY),
      workerOnly: await read(FIXTURE_WORKER_IDENTITY),
    });
  },
};
`;

const ReadSchema = Schema.Union([
  Schema.Struct({ failure: Schema.Struct({ reason: Schema.String, tag: Schema.String }) }),
  Schema.Struct({ urls: Schema.Tuple([Schema.String, Schema.String]) }),
]);
const LoadedSchema = Schema.Struct({
  connectionString: Schema.String,
  expectedRole: Schema.String,
  keys: Schema.Array(Schema.String),
  role: Schema.String,
});
const ProbeResultSchema = Schema.Struct({
  bindings: Schema.Struct({ issuer: Schema.String, shared: Schema.String }),
  issuer: ReadSchema,
  issuerConfiguration: LoadedSchema,
  missing: ReadSchema,
  shared: ReadSchema,
  sharedConfiguration: LoadedSchema,
  workerOnly: ReadSchema,
});

it.live('each Worker identity reads only its own native Hyperdrive binding and fails closed without one', () =>
  Effect.gen(function* workerIdentitiesUseTheirBindings() {
    const bundle = yield* Effect.promise(() =>
      build({
        bundle: true,
        conditions: ['workerd', 'worker', 'import'],
        external: ['cloudflare:*'],
        format: 'esm',
        platform: 'neutral',
        stdin: { contents: probeWorker, loader: 'js', resolveDir: import.meta.dirname },
        write: false,
      }),
    );
    // No PARTY_REGISTRY_HYPERDRIVE binding: that identity must fail with the binding name.
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare(
            convertV4MiniflareOptions({
              compatibilityDate: '2026-06-02',
              compatibilityFlags: ['nodejs_compat'],
              hyperdrives: {
                // Proxy transport logins, as Hyperdrive hands out: neither names the origin role or database.
                GATEWAY_ISSUER_HYPERDRIVE:
                  'postgresql://issuer-proxy:TEST_issuer@127.0.0.1:5432/issuer-slot?sslmode=disable',
                HYPERDRIVE: 'postgresql://runtime-proxy:TEST_runtime@127.0.0.1:5432/runtime-slot?sslmode=disable',
              },
              modules: true,
              script: bundle.outputFiles[0]?.text ?? '',
            }),
          ),
      ),
      (miniflare) => Effect.promise(() => miniflare.dispose()),
    );
    const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
    const result = Schema.decodeUnknownSync(ProbeResultSchema)(yield* Effect.promise(() => response.json()));

    const shared = new URL(result.bindings.shared);
    const issuer = new URL(result.bindings.issuer);
    expect([shared.username, shared.pathname]).toEqual(['runtime-proxy', '/runtime-slot']);
    expect([issuer.username, issuer.pathname]).toEqual(['issuer-proxy', '/issuer-slot']);
    expect(result.shared).toEqual({ urls: [result.bindings.shared, adminUrl] });
    expect(result.issuer).toEqual({ urls: [result.bindings.issuer, adminUrl] });
    // The loaded configuration carries the identity's role as the expected origin role and no origin metadata.
    for (const [loaded, binding] of [
      [result.sharedConfiguration, result.bindings.shared],
      [result.issuerConfiguration, result.bindings.issuer],
    ] as const) {
      expect(loaded.connectionString).toBe(binding);
      expect(loaded.expectedRole).toBe(loaded.role);
      expect(loaded.keys).toEqual(['connectionString', 'expectedRole']);
    }
    expect(result.missing).toEqual({
      failure: { reason: 'The PARTY_REGISTRY_HYPERDRIVE Worker binding is required', tag: 'DatabaseConfigError' },
    });
    expect(result.workerOnly).toEqual({
      failure: { reason: 'This database identity has no Cloudflare Worker binding', tag: 'DatabaseConfigError' },
    });
  }).pipe(Effect.scoped),
);
