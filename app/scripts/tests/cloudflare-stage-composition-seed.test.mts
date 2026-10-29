import { DateTime, Duration, Effect, Layer, Match, Option, Redacted } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import {
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import {
  copyCompositionSnapshot,
  seedComposition,
  validateSeedSnapshot,
} from '../ops/cloudflare-stage-composition-seed.mts';
import { APP_DIRECTORY, fakeFiles } from './stage-operations-fixture.mts';

const encoder = new TextEncoder();
const SOURCE_AUTHORIZATION = 'Bearer old-token';
const TARGET_AUTHORIZATION = 'Bearer new-token';
const source = { accountId: 'old-account', apiToken: Redacted.make('old-token'), namespaceId: 'old-namespace' };
const target = { accountId: 'new-account', apiToken: Redacted.make('new-token'), namespaceId: 'new-namespace' };

const snapshotBytes = (expired: boolean) =>
  Effect.gen(function* snapshotBytesEffect() {
    const now = yield* DateTime.now;
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'stage',
      modules: [],
      observedAt: expired ? DateTime.subtract(now, { days: 2 }) : now,
      shell: {
        federationManifest: {
          bytes: encoder.encode(
            JSON.stringify({
              exposes: [],
              name: 'shellSuperApp',
              shared: governedSharedSingletonPackages.map((name) => ({
                name,
                requiredVersion: '1.0.0',
                singleton: true,
              })),
            }),
          ),
          url: 'https://shell.example/mf-manifest.json',
        },
        runtimeContract: {
          bytes: encoder.encode(JSON.stringify(createShellRuntimeContract('seed-build'))),
          url: 'https://shell.example/.well-known/ontos-shell-runtime.json',
        },
      },
      validity: Duration.hours(24),
    });
    // Whitespace is deliberately noncanonical and must survive the migration exactly.
    return encoder.encode(` \n${yield* encodeActiveApplicationCompositionSnapshot(snapshot)}\n  `);
  });

it.effect('copies an unexpired active snapshot byte-for-byte using separate account credentials', () =>
  Effect.gen(function* copiesExactBytes() {
    const bytes = yield* snapshotBytes(false);
    const requests: {
      readonly bytes: Option.Option<Uint8Array>;
      readonly method: string;
      readonly token: string;
      readonly url: string;
    }[] = [];
    const client = HttpClient.make((request, url) => {
      requests.push({
        bytes: Match.value(request.body).pipe(
          Match.tag('Uint8Array', ({ body }) => Option.some(body)),
          Match.orElse(() => Option.none()),
        ),
        method: request.method,
        token: request.headers.authorization ?? '',
        url: url.href,
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(request.method === 'GET' ? bytes : JSON.stringify({ success: true }), { status: 200 }),
        ),
      );
    });
    yield* copyCompositionSnapshot(source, target).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(requests.map(({ method, token, url }) => [method, token, url])).toEqual([
      [
        'GET',
        SOURCE_AUTHORIZATION,
        'https://api.cloudflare.com/client/v4/accounts/old-account/storage/kv/namespaces/old-namespace/values/active',
      ],
      [
        'PUT',
        TARGET_AUTHORIZATION,
        'https://api.cloudflare.com/client/v4/accounts/new-account/storage/kv/namespaces/new-namespace/values/active',
      ],
    ]);
    expect(Option.getOrThrow(requests[1]?.bytes ?? Option.none())).toEqual(bytes);
  }),
);

it.effect('refuses an expired snapshot without writing to the new account', () =>
  Effect.gen(function* refusesExpiredSnapshot() {
    const bytes = yield* snapshotBytes(true);
    const methods: string[] = [];
    const client = HttpClient.make((request) => {
      methods.push(request.method);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes)));
    });
    yield* copyCompositionSnapshot(source, target).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
    );
    expect(methods).toEqual(['GET']);
  }),
);

it.effect('rejects invalid UTF-8 and malformed snapshots as typed failures', () =>
  Effect.gen(function* refusesInvalidSnapshot() {
    for (const bytes of [new Uint8Array([0xff]), encoder.encode('{}'), encoder.encode('not json')]) {
      const error = yield* validateSeedSnapshot(bytes).pipe(Effect.flip);
      expect(error.message).toContain('invalid or expired');
    }
  }),
);

it.effect('seed dry run needs no credential files or network and never writes', () =>
  Effect.gen(function* dryRunSeed() {
    const files = fakeFiles();
    yield* seedComposition({ dryRun: true, envFile: '/missing/new', oldEnvFile: '/missing/old' }).pipe(
      Effect.provide(files.layer),
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die('unexpected network')),
        ),
      ),
    );
    expect(files.writes.size).toBe(0);
  }),
);

const seedFiles = (namespaceId = target.namespaceId, accountId = target.accountId) =>
  fakeFiles({
    'new-credentials': `CLOUDFLARE_ACCOUNT_ID=${accountId}\nCLOUDFLARE_API_TOKEN=new-token\n`,
    'old-credentials': 'CLOUDFLARE_ACCOUNT_ID=old-account\nCLOUDFLARE_API_TOKEN=old-token\n',
    'topology/cloudflare-placement.json': JSON.stringify({
      buildEnvironment: { ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: namespaceId },
      units: [],
    }),
    'topology/stage-edge.json': JSON.stringify({
      accountId: target.accountId,
      emailSender: 'noreply@shell.stage.example.com',
      shellHostname: 'shell.stage.example.com',
      spicedbHostname: 'spicedb.stage.example.com',
      storefrontCatalogKvId: '',
      storefrontHostname: 'storefront.stage.example.com',
      workersDevSubdomain: 'stage-example',
      zone: 'stage.example.com',
    }),
  });
const seedOptions = {
  dryRun: false,
  envFile: `${APP_DIRECTORY}/new-credentials`,
  oldEnvFile: `${APP_DIRECTORY}/old-credentials`,
};

it.effect('seeds through explicit old/new credential files after discovering namespaces in each account', () =>
  Effect.gen(function* seedsFromFiles() {
    const bytes = yield* snapshotBytes(false);
    const files = seedFiles();
    const methods: string[] = [];
    const tokens: string[] = [];
    const client = HttpClient.make((request, url) => {
      methods.push(request.method);
      tokens.push(request.headers.authorization ?? '');
      if (url.searchParams.has('page')) {
        const namespace = url.pathname.includes(source.accountId) ? source : target;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              result: [{ id: namespace.namespaceId, title: 'ontos-stage-active-application-composition' }],
              success: true,
            }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(request.method === 'GET' ? bytes : JSON.stringify({ success: true })),
        ),
      );
    });
    yield* seedComposition(seedOptions).pipe(
      Effect.provide(files.layer),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    expect(methods).toEqual(['GET', 'GET', 'GET', 'PUT']);
    expect(tokens).toEqual([SOURCE_AUTHORIZATION, TARGET_AUTHORIZATION, SOURCE_AUTHORIZATION, TARGET_AUTHORIZATION]);
    expect(files.writes.size).toBe(0);
  }),
);

it.effect('refuses missing composition IDs and mismatched new-account credentials before any HTTP request', () =>
  Effect.gen(function* rejectsUnsafeSeedInputs() {
    for (const files of [seedFiles(''), seedFiles(target.namespaceId, 'wrong-account')]) {
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.method);
        return Effect.die('unexpected HTTP request');
      });
      const error = yield* seedComposition(seedOptions).pipe(
        Effect.provide(files.layer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error.message).toMatch(/empty|must equal/u);
      expect(requests).toEqual([]);
      expect(files.writes.size).toBe(0);
    }
  }),
);
