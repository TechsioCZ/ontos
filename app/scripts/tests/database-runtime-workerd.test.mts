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

const adminUrl = 'postgresql://ontos_admin@localhost:5433/ontos';

// The Worker module reads workerd's own Hyperdrive bindings through `cloudflare:workers`.
const probeWorker = `
import { env } from 'cloudflare:workers';
import { Config, ConfigProvider, Effect } from 'effect';
import { databaseRuntime } from ${JSON.stringify(databaseRuntimeModule)};
import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from ${JSON.stringify(databaseIdentitiesModule)};

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

export default {
  async fetch() {
    return Response.json({
      bindings: {
        issuer: env.GATEWAY_ISSUER_HYPERDRIVE.connectionString,
        shared: env.HYPERDRIVE.connectionString,
      },
      issuer: await read(SHELL_GATEWAY_ISSUER_IDENTITY),
      missing: await read(PARTY_REGISTRY_REQUEST_IDENTITY),
      shared: await read(SHARED_RUNTIME_IDENTITY),
      workerOnly: await read(PARTY_REGISTRY_WORKER_IDENTITY),
    });
  },
};
`;

const ReadSchema = Schema.Union([
  Schema.Struct({ failure: Schema.Struct({ reason: Schema.String, tag: Schema.String }) }),
  Schema.Struct({ urls: Schema.Tuple([Schema.String, Schema.String]) }),
]);
const ProbeResultSchema = Schema.Struct({
  bindings: Schema.Struct({ issuer: Schema.String, shared: Schema.String }),
  issuer: ReadSchema,
  missing: ReadSchema,
  shared: ReadSchema,
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
                GATEWAY_ISSUER_HYPERDRIVE:
                  'postgresql://shell_gateway_issuer:TEST_issuer@127.0.0.1:5432/ontos_issuer?sslmode=disable',
                HYPERDRIVE: 'postgresql://ontos_runtime:TEST_runtime@127.0.0.1:5432/ontos_shared?sslmode=disable',
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
    expect([shared.username, shared.pathname]).toEqual(['ontos_runtime', '/ontos_shared']);
    expect([issuer.username, issuer.pathname]).toEqual(['shell_gateway_issuer', '/ontos_issuer']);
    expect(result.shared).toEqual({ urls: [result.bindings.shared, adminUrl] });
    expect(result.issuer).toEqual({ urls: [result.bindings.issuer, adminUrl] });
    expect(result.missing).toEqual({
      failure: { reason: 'The PARTY_REGISTRY_HYPERDRIVE Worker binding is required', tag: 'DatabaseConfigError' },
    });
    expect(result.workerOnly).toEqual({
      failure: { reason: 'This database identity has no Cloudflare Worker binding', tag: 'DatabaseConfigError' },
    });
  }).pipe(Effect.scoped),
);
