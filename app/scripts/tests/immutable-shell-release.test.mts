import { createHash } from 'node:crypto';
import nodePath from 'node:path';

import { NodeServices } from '@effect/platform-node';
import {
  canonicalSerializeMicroVerticalReleaseEnvelope,
  createMicroVerticalReleaseEnvelope,
} from '@modern-js/app-tools-extensions/release-envelope';
import { MICROVERTICAL_RELEASE_ENVELOPE_PATH } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import {
  Array as EffectArray,
  ConfigProvider,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Match,
  Order,
  Schema,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ActiveApplicationCompositionPublicationError,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import type { ImmutableApplicationReleasePlan } from '../immutable-application-release.mts';
import {
  ImmutableApplicationReleaseError,
  deriveImmutableApplicationReleasePlan,
  makeImmutableApplicationReleasePublicationCandidate,
} from '../immutable-application-release.mts';
import {
  deployImmutableShellIngress,
  deployImmutableShellRelease,
  validateImmutableShellReleaseArtifacts,
} from '../immutable-shell-release.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';
import { OpsShell } from '../ops/ops-shell.mts';

const BUILD_MARKER = '0123456789abcdef';
const SOURCE_REVISION = 'a'.repeat(40);
const APP_ID = 'shell-super-app';
const CONTRACT_PATH = '.well-known/ontos-shell-runtime.json';
const MANIFEST_PATH = 'mf-manifest.json';
const WRANGLER_VERSION = '4.137.0';
const BACKEND_PATH = 'server/index.mjs';
const WORKER_METADATA_PATH = 'server/modern-worker-manifest.json';
const REMOTE_ENTRY_PATH = 'remoteEntry.js';
const BFF_PATH = 'worker/__modern_bff_effect.mjs';
const BACKEND_MANIFEST_PATH = 'backend-manifest.json';
const WRANGLER_CONFIG_PATH = 'wrangler.json';
const DEPLOY_EVENT = 'deploy-command';
const PROVIDER_VERSION = 'actual-provider-version';
const WORKERS_DEV_SUBDOMAIN = 'ontos-test';
const OWNER_SECRET_VALUE = 'owned-test-value';
const PUBLICATION_LOCK = 'pg_advisory_lock';
const ACCOUNT_SUBDOMAIN_URL = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/subdomain`;
const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/storage/kv/namespaces/${'b'.repeat(32)}/values/active`;
const RETAINED_HEADERS =
  '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n';
const text = (value: string) => new TextEncoder().encode(value);
const json = (value: Schema.Json) => text(JSON.stringify(value));
const file = (path: string, bytes = text('retained Shell bytes')) => ({
  bytes,
  path,
});
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const gitResult = (command: OpsCommand, appDirectory: string) => {
  if (command.args[0] === 'status') {
    return '';
  }
  if (command.args.includes('--show-toplevel')) {
    return `${nodePath.resolve(appDirectory, '../..')}\n`;
  }
  return `${SOURCE_REVISION}\n`;
};

const planFor = () =>
  deriveImmutableApplicationReleasePlan({
    appId: APP_ID,
    buildMarker: BUILD_MARKER,
    sourceRevision: SOURCE_REVISION,
    workersDevSubdomain: WORKERS_DEV_SUBDOMAIN,
  });

const inventoryFor = (plan: ImmutableApplicationReleasePlan) => ({
  assets: [
    file(CONTRACT_PATH, json(createShellRuntimeContract(plan.buildMarker))),
    file(
      MANIFEST_PATH,
      json({
        exposes: [
          {
            assets: {
              css: { async: ['async.css'], sync: ['main.css'] },
              js: { async: ['async.js'], sync: ['main.js'] },
            },
            path: './ShellProof',
          },
        ],
        metaData: { publicPath: plan.assetsOrigin },
        name: 'shellSuperApp',
        remoteEntry: { name: REMOTE_ENTRY_PATH },
        shared: governedSharedSingletonPackages.map((name) => ({
          assets: {
            css: { async: [], sync: ['shared.css'] },
            js: { async: ['shared.js'], sync: [] },
          },
          name,
          requiredVersion: '1.0.0',
          singleton: true,
        })),
      }),
    ),
    ...[REMOTE_ENTRY_PATH, 'main.js', 'async.js', 'shared.js', 'main.css', 'async.css', 'shared.css'].map((path) =>
      file(path),
    ),
  ],
});

it.effect('pins the complete Shell runtime contract and federation inventory to exact retained bytes', () =>
  Effect.gen(function* exactShellArtifactBytes() {
    const plan = yield* planFor();
    const inventory = inventoryFor(plan);
    const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, inventory);
    const reversed = yield* validateImmutableShellReleaseArtifacts(plan, {
      assets: EffectArray.reverse(inventory.assets),
    });
    expect(reversed).toEqual(artifacts);
    expect(artifacts.runtimeContract).toEqual({
      sha256: sha256(inventory.assets[0].bytes),
      url: `${plan.assetsOrigin}${CONTRACT_PATH}`,
    });
    expect(artifacts.federationManifest).toEqual({
      sha256: sha256(inventory.assets[1].bytes),
      url: `${plan.assetsOrigin}${MANIFEST_PATH}`,
    });
    const changed = yield* validateImmutableShellReleaseArtifacts(plan, {
      assets: inventory.assets.map((asset) =>
        asset.path === 'main.js' ? file(asset.path, text('different Shell implementation')) : asset,
      ),
    });
    expect(changed.assetsSha256).not.toBe(artifacts.assetsSha256);
    expect(changed.runtimeContract).toEqual(artifacts.runtimeContract);
  }),
);

it.effect('requires every Shell contract, federation manifest, entrypoint, and synchronous or asynchronous chunk', () =>
  Effect.gen(function* completeShellInventory() {
    const plan = yield* planFor();
    const inventory = inventoryFor(plan);
    for (const missing of inventory.assets) {
      const failure = yield* validateImmutableShellReleaseArtifacts(plan, {
        assets: inventory.assets.filter((asset) => asset.path !== missing.path),
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects malformed UTF-8 or JSON and a runtime contract from another Shell build', () =>
  Effect.gen(function* invalidShellContract() {
    const plan = yield* planFor();
    const inventory = inventoryFor(plan);
    for (const target of [CONTRACT_PATH, MANIFEST_PATH]) {
      for (const bytes of [text('{'), new Uint8Array([0xc3, 0x28])]) {
        const failure = yield* validateImmutableShellReleaseArtifacts(plan, {
          assets: inventory.assets.map((asset) => (asset.path === target ? file(asset.path, bytes) : asset)),
        }).pipe(Effect.flip);
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
      }
    }
    const wrongContracts = [
      { ...createShellRuntimeContract(plan.buildMarker), schemaVersion: '1' },
      {
        ...createShellRuntimeContract(plan.buildMarker),
        deployment: {
          appId: 'party-registry',
          buildMarker: plan.buildMarker,
        },
      },
      createShellRuntimeContract('fedcba9876543210'),
      {
        deployment: { appId: APP_ID, buildMarker: plan.buildMarker },
        schemaVersion: '2',
      },
    ];
    for (const contract of wrongContracts) {
      const failure = yield* validateImmutableShellReleaseArtifacts(plan, {
        assets: inventory.assets.map((asset) =>
          asset.path === CONTRACT_PATH ? file(asset.path, json(contract)) : asset,
        ),
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

it.effect('refuses a federation manifest that would fetch Shell chunks from a mutable origin', () =>
  Effect.gen(function* nonretainedShellOrigin() {
    const plan = yield* planFor();
    const inventory = inventoryFor(plan);
    const failure = yield* validateImmutableShellReleaseArtifacts(plan, {
      assets: inventory.assets.map((asset) =>
        asset.path === MANIFEST_PATH
          ? file(
              asset.path,
              json({
                metaData: { publicPath: 'https://mutable-shell.example/' },
                remoteEntry: { name: REMOTE_ENTRY_PATH },
              }),
            )
          : asset,
      ),
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
  }),
);

it.effect('rejects duplicate or unsafe public paths and public secrets or source maps', () =>
  Effect.gen(function* unsafeShellAssets() {
    const plan = yield* planFor();
    const inventory = inventoryFor(plan);
    for (const unsafe of [
      'main.js',
      '../private.js',
      '/absolute.js',
      'nested/../escape.js',
      '.env',
      'credentials.json',
      'private-key.pem',
      'main.js.map',
    ]) {
      const failure = yield* validateImmutableShellReleaseArtifacts(plan, {
        assets: [...inventory.assets, file(unsafe)],
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

const writeNativeShellOutput = Effect.fn('test.writeNativeShellOutput')(function* writeNativeShellOutputEffect(
  appDirectory: string,
  plan: ImmutableApplicationReleasePlan,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const output = nodePath.join(appDirectory, '.output');
  const inventory = inventoryFor(plan);
  const supportFiles = [
    file(BFF_PATH, text('export const effectApi = "retained Shell API";')),
    file(BACKEND_MANIFEST_PATH, json({ deliveryUnit: { ...plan, unitId: `app/${APP_ID}` } })),
    file('backend-container.cjs', text('module.exports = { retainedShellBackend: true };')),
    file(
      WRANGLER_CONFIG_PATH,
      json({
        assets: { directory: 'public' },
        compatibility_date: '2026-09-24',
        main: BACKEND_PATH,
        name: 'app-shell-super-app',
      }),
    ),
    file(
      WORKER_METADATA_PATH,
      json({
        deliveryUnit: {
          buildMarker: plan.buildMarker,
          sourceRevision: plan.sourceRevision,
          unitId: `app/${APP_ID}`,
        },
      }),
    ),
    file(BACKEND_PATH, text('export default { fetch() { return new Response("Shell"); } };')),
    file('public/_headers', text('/*\n  Cache-Control: no-cache\n')),
  ];
  for (const asset of [
    ...supportFiles,
    ...inventory.assets.map(({ bytes, path }) => ({
      bytes,
      path: `public/${path}`,
    })),
  ]) {
    const destination = nodePath.join(output, asset.path);
    yield* fileSystem.makeDirectory(nodePath.dirname(destination), {
      recursive: true,
    });
    yield* fileSystem.writeFile(destination, asset.bytes);
  }
  const envelope = yield* Effect.tryPromise({
    catch: (cause) =>
      new ImmutableApplicationReleaseError({
        cause,
        message: 'native Shell test envelope could not be created',
      }),
    try: () =>
      createMicroVerticalReleaseEnvelope({
        artifactRoot: output,
        artifacts: [
          ...supportFiles.map(({ path }) => ({
            logicalPath: path,
            runtime: Match.value(path).pipe(
              Match.when(Match.is(WRANGLER_CONFIG_PATH, WORKER_METADATA_PATH), () => 'cloudflare-deployment'),
              Match.when(BACKEND_PATH, () => 'workerd'),
              Match.when('public/_headers', () => 'public-metadata'),
              Match.when(BFF_PATH, () => 'workerd-effect'),
              Match.when(BACKEND_MANIFEST_PATH, () => 'module-federation-manifest'),
              Match.orElse(() => 'commonjs-module'),
            ),
          })),
          ...inventory.assets.map(({ path }) => ({
            logicalPath: `public/${path}`,
            runtime: path.endsWith('.js') ? 'browser' : 'public-asset',
          })),
        ],
        identity: {
          buildMarker: plan.buildMarker,
          releaseVersion: '1.0.0',
          sourceRevision: plan.sourceRevision,
          unitId: `app/${APP_ID}`,
        },
        surfaces: {
          apiBackend: [BFF_PATH],
          backendFederation: {
            container: 'backend-container.cjs',
            manifest: BACKEND_MANIFEST_PATH,
          },
          ssr: [BACKEND_PATH],
          uiClient: EffectArray.sort(
            inventory.assets.filter(({ path }) => path.endsWith('.js')).map(({ path }) => `public/${path}`),
            Order.String,
          ),
        },
        target: 'cloudflare',
      }),
  });
  const destination = nodePath.join(output, MICROVERTICAL_RELEASE_ENVELOPE_PATH);
  yield* fileSystem.makeDirectory(nodePath.dirname(destination), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(destination, canonicalSerializeMicroVerticalReleaseEnvelope(envelope));
  yield* fileSystem.writeFileString(
    nodePath.join(appDirectory, 'package.json'),
    JSON.stringify({ devDependencies: { wrangler: WRANGLER_VERSION } }),
  );
  const topologyDirectory = nodePath.resolve(appDirectory, '../../topology');
  yield* fileSystem.makeDirectory(topologyDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    nodePath.join(topologyDirectory, 'reference-topology.json'),
    JSON.stringify({
      shell: {
        cloudflare: { workerName: 'app-shell-super-app' },
        deliveryUnit: { buildMarker: plan.buildMarker, unitId: `app/${APP_ID}` },
        id: APP_ID,
      },
    }),
  );
  return { output, publicDirectory: nodePath.join(output, 'public') };
});

const rejectsNativeShellTampering = (tamper: 'asset' | 'identity' | 'missing-envelope') =>
  Effect.scoped(
    Effect.gen(function* rejectsTamperedShellRelease() {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: 'ontos-shell-release-validation-',
      });
      const appDirectory = nodePath.join(workspaceRoot, 'apps', APP_ID);
      const plan = yield* planFor();
      const { output, publicDirectory } = yield* writeNativeShellOutput(appDirectory, plan);
      if (tamper === 'asset') {
        yield* fileSystem.writeFileString(nodePath.join(publicDirectory, 'main.js'), 'tampered after envelope');
      } else if (tamper === 'identity') {
        yield* fileSystem.writeFileString(
          nodePath.join(output, WORKER_METADATA_PATH),
          JSON.stringify({
            deliveryUnit: {
              buildMarker: 'fedcba9876543210',
              sourceRevision: plan.sourceRevision,
              unitId: `app/${APP_ID}`,
            },
          }),
        );
      } else {
        yield* fileSystem.remove(nodePath.join(output, MICROVERTICAL_RELEASE_ENVELOPE_PATH));
      }
      const requests: string[] = [];
      const mutations: OpsCommand[] = [];
      const layer = Layer.mergeAll(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request, destination) => {
            requests.push(destination.href);
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })));
          }),
        ),
        Layer.succeed(OpsShell, {
          run: (command) => {
            if (command.command === 'git') {
              return Effect.succeed(gitResult(command, appDirectory));
            }
            if (command.args.join(' ') === 'exec wrangler --version') {
              return Effect.succeed(WRANGLER_VERSION);
            }
            mutations.push(command);
            return Effect.die(new Error('Tampered Shell artifacts must not execute a provider mutation'));
          },
        }),
        Layer.effect(
          CoreDatabase,
          makeTestDatabase((statement) =>
            Effect.succeed(statement.includes('pg_advisory_unlock') ? [{ unlocked: true }] : []),
          ).pipe(Effect.map((executor) => ({ executor }))),
        ),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
            CLOUDFLARE_API_TOKEN: 'shell-release-test-token',
          }),
        ),
      );
      const failure = yield* deployImmutableShellRelease({
        appDirectory,
        plan,
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
      expect(requests).toEqual([]);
      expect(mutations).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect('rejects modified Shell asset bytes before any provider observation or deployment', () =>
  rejectsNativeShellTampering('asset'),
);
it.effect('rejects changed Shell delivery identity before any provider observation or deployment', () =>
  rejectsNativeShellTampering('identity'),
);
it.effect('requires the native release envelope before any provider observation or deployment', () =>
  rejectsNativeShellTampering('missing-envelope'),
);

const deploymentLayer = (
  appDirectory: string,
  client: HttpClient.HttpClient,
  commands: OpsCommand[],
  events: string[],
  secrets: Readonly<Record<string, string>> = {},
  authority?: { readonly phase: string; readonly revision: string; readonly unexpired: boolean },
) =>
  Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(OpsShell, {
      run: (command) => {
        if (command.command === 'git') {
          return Effect.succeed(gitResult(command, appDirectory));
        }
        if (command.args.join(' ') === 'exec wrangler --version') {
          return Effect.succeed(WRANGLER_VERSION);
        }
        commands.push(command);
        events.push(DEPLOY_EVENT);
        return Effect.succeed('retained Shell deployed');
      },
    }),
    Layer.effect(
      CoreDatabase,
      makeTestDatabase((statement) =>
        Effect.sync(() => {
          events.push(statement);
          if (statement.includes('pg_advisory_unlock')) {
            return [{ unlocked: true }];
          }
          return authority !== undefined && statement.includes('clock_timestamp()') ? [authority] : [];
        }),
      ).pipe(Effect.map((executor) => ({ executor }))),
    ),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_API_TOKEN: 'shell-release-test-token',
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: KV_URL,
        ONTOS_IMMUTABLE_RELEASE_SECRETS: JSON.stringify(secrets),
      }),
    ),
  );

it.effect(
  'publishes retained Shell assets before its public ingress and installs owner secrets under the same database lock',
  () =>
    Effect.scoped(
      Effect.gen(function* retainedShellDeployment() {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-shell-release-deploy-' });
        const appDirectory = nodePath.join(workspaceRoot, 'apps', APP_ID);
        const plan = yield* planFor();
        const { publicDirectory } = yield* writeNativeShellOutput(appDirectory, plan);
        const inventory = inventoryFor(plan);
        const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
          environment: 'stage',
          modules: [],
          observedAt: yield* DateTime.now,
          shell: {
            federationManifest: { bytes: inventory.assets[1].bytes, url: `${plan.assetsOrigin}${MANIFEST_PATH}` },
            runtimeContract: { bytes: inventory.assets[0].bytes, url: `${plan.assetsOrigin}${CONTRACT_PATH}` },
          },
          validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
        });
        const encodedSnapshot = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
        let publishedSnapshot: string | null = encodedSnapshot;
        const commands: OpsCommand[] = [];
        const requests: string[] = [];
        const events: string[] = [];
        const providerUrl = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${plan.assetsScriptName}`;
        const client = HttpClient.make((request, destination) => {
          requests.push(destination.href);
          events.push(destination.href, request.method === 'PUT' ? 'secret-installation' : 'provider-request');
          const asset = inventory.assets.find(
            (assetFile) => `${plan.assetsOrigin}${assetFile.path}` === destination.href,
          );
          const response = Match.value(asset).pipe(
            Match.when(
              Match.defined,
              (retainedAsset) =>
                new Response(retainedAsset.bytes, {
                  headers: {
                    'access-control-allow-origin': '*',
                    'cache-control': 'public, max-age=31536000, immutable',
                    'x-content-type-options': 'nosniff',
                  },
                }),
            ),
            Match.orElse(() =>
              Match.value(destination.href).pipe(
                Match.when(ACCOUNT_SUBDOMAIN_URL, () =>
                  Response.json({ result: { subdomain: WORKERS_DEV_SUBDOMAIN }, success: true }),
                ),
                Match.when(KV_URL, () =>
                  publishedSnapshot === null ? new Response(null, { status: 404 }) : new Response(publishedSnapshot),
                ),
                Match.when(`${providerUrl}/deployments`, () =>
                  Response.json({
                    result: {
                      deployments: [{ versions: [{ percentage: 100, version_id: 'shell-retained-provider-version' }] }],
                    },
                    success: true,
                  }),
                ),
                Match.when(
                  `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/app-shell-super-app/secrets`,
                  () => Response.json({ success: true }),
                ),
                Match.orElse(() => new Response(null, { status: 404 })),
              ),
            ),
          );
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        });
        const receipt = yield* deployImmutableShellRelease({ appDirectory, plan }).pipe(
          Effect.provide(deploymentLayer(appDirectory, client, commands, events)),
        );
        expect(receipt.plan).toEqual(plan);
        expect(receipt.assetsVersionId).toBe('shell-retained-provider-version');
        expect(receipt.artifacts.runtimeContract.url).toBe(`${plan.assetsOrigin}${CONTRACT_PATH}`);
        expect(receipt.artifacts.federationManifest.url).toBe(`${plan.assetsOrigin}${MANIFEST_PATH}`);
        expect(commands).toHaveLength(1);
        expect(commands[0].args.slice(0, 4)).toEqual(['exec', 'wrangler', 'deploy', '--config']);
        expect(requests.slice(0, 2)).toEqual([ACCOUNT_SUBDOMAIN_URL, providerUrl]);
        expect(requests.some((url) => url.includes('/dispatch/'))).toBe(false);
        expect(requests.some((url) => url.includes('/secrets'))).toBe(false);
        for (const asset of inventory.assets) {
          expect(requests).toContain(`${plan.assetsOrigin}${asset.path}`);
        }
        const lock = events.findIndex((event) => event.includes(PUBLICATION_LOCK));
        expect(lock).toBeGreaterThanOrEqual(0);
        expect(lock).toBeLessThan(events.indexOf('provider-request'));
        expect(lock).toBeLessThan(events.indexOf(DEPLOY_EVENT));
        expect(yield* fileSystem.readFileString(nodePath.join(publicDirectory, '_headers'))).toBe(
          '/*\n  Cache-Control: no-cache\n',
        );
        publishedSnapshot = null;
        const missingPublishedRelease = yield* deployImmutableShellIngress({ appDirectory, receipt }).pipe(
          Effect.provide(deploymentLayer(appDirectory, client, commands, events)),
          Effect.flip,
        );
        expect(Schema.is(ActiveApplicationCompositionPublicationError)(missingPublishedRelease)).toBe(true);
        expect(commands).toHaveLength(1);
        expect(requests.some((url) => url.includes('/secrets'))).toBe(false);
        publishedSnapshot = encodedSnapshot;
        yield* deployImmutableShellIngress({ appDirectory, receipt }).pipe(
          Effect.provide(
            deploymentLayer(
              appDirectory,
              client,
              commands,
              events,
              { TEST_OWNER_SECRET: OWNER_SECRET_VALUE },
              { phase: 'active', revision: snapshot.composition.revision, unexpired: true },
            ),
          ),
        );
        expect(commands).toHaveLength(2);
        expect(requests).toContain(KV_URL);
        expect(events.lastIndexOf(KV_URL)).toBeLessThan(events.lastIndexOf(DEPLOY_EVENT));
        expect(events.findIndex((event) => event.includes('clock_timestamp()'))).toBeLessThan(
          events.lastIndexOf(DEPLOY_EVENT),
        );
        expect(commands[1].args).toEqual([
          'exec',
          'wrangler',
          'deploy',
          '--config',
          nodePath.join(appDirectory, '.output', WRANGLER_CONFIG_PATH),
        ]);
        expect(events.filter((event) => event.includes(PUBLICATION_LOCK))).toHaveLength(3);
        expect(events.indexOf('secret-installation')).toBeGreaterThan(events.lastIndexOf(DEPLOY_EVENT));
        expect(requests.filter((url) => url.endsWith('/secrets'))).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses an existing retained Shell asset identity before executing deployment commands', () =>
  Effect.scoped(
    Effect.gen(function* existingShellAssetIdentity() {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-shell-release-existing-' });
      const appDirectory = nodePath.join(workspaceRoot, 'apps', APP_ID);
      const plan = yield* planFor();
      yield* writeNativeShellOutput(appDirectory, plan);
      const commands: OpsCommand[] = [];
      const requests: string[] = [];
      const events: string[] = [];
      const client = HttpClient.make((request, destination) => {
        requests.push(destination.href);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            destination.href === ACCOUNT_SUBDOMAIN_URL
              ? Response.json({ result: { subdomain: WORKERS_DEV_SUBDOMAIN }, success: true })
              : new Response(null, { status: 200 }),
          ),
        );
      });
      const failure = yield* deployImmutableShellRelease({ appDirectory, plan }).pipe(
        Effect.provide(deploymentLayer(appDirectory, client, commands, events)),
        Effect.flip,
      );
      expect(failure.message).toBe('an immutable Shell asset release already exists; it must never be overwritten');
      expect(commands).toEqual([]);
      expect(requests).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses a Shell ingress receipt that substitutes mutable URLs or different contract bytes', () =>
  Effect.scoped(
    Effect.gen(function* forgedShellIngressReceipt() {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-shell-ingress-receipt-' });
      const appDirectory = nodePath.join(workspaceRoot, 'apps', APP_ID);
      const plan = yield* planFor();
      yield* writeNativeShellOutput(appDirectory, plan);
      const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, inventoryFor(plan));
      const receipt = { artifacts, assetsVersionId: PROVIDER_VERSION, plan };
      const commands: OpsCommand[] = [];
      const requests: string[] = [];
      const events: string[] = [];
      const client = HttpClient.make((request, destination) => {
        requests.push(destination.href);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })));
      });
      const layer = deploymentLayer(appDirectory, client, commands, events);
      for (const forged of [
        {
          ...receipt,
          artifacts: { ...artifacts, runtimeContract: { ...artifacts.runtimeContract, sha256: 'b'.repeat(64) } },
        },
        {
          ...receipt,
          artifacts: {
            ...artifacts,
            federationManifest: {
              ...artifacts.federationManifest,
              url: 'https://mutable-shell.example/mf-manifest.json',
            },
          },
        },
      ]) {
        const failure = yield* deployImmutableShellIngress({ appDirectory, receipt: forged }).pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
        expect(failure.message).toBe(
          'the Shell ingress must use the exact retained runtime and frontend release receipt',
        );
      }
      expect(commands).toEqual([]);
      expect(requests).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses ambiguous or partial retained Shell provider deployments before deploying public ingress', () =>
  Effect.scoped(
    Effect.gen(function* ambiguousShellProviderVersion() {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-shell-release-rollout-' });
      const appDirectory = nodePath.join(workspaceRoot, 'apps', APP_ID);
      const plan = yield* planFor();
      yield* writeNativeShellOutput(appDirectory, plan);
      const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, {
        assets: [...inventoryFor(plan).assets, file('_headers', text(RETAINED_HEADERS))],
      });
      const receipt = { artifacts, assetsVersionId: PROVIDER_VERSION, plan };
      const commands: OpsCommand[] = [];
      const requests: string[] = [];
      const events: string[] = [];
      const historyUrl = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${plan.assetsScriptName}/deployments`;
      for (const versions of [
        [
          { percentage: 50, version_id: PROVIDER_VERSION },
          { percentage: 50, version_id: 'another-provider-version' },
        ],
        [{ percentage: 99, version_id: PROVIDER_VERSION }],
      ]) {
        const client = HttpClient.make((request, destination) => {
          requests.push(destination.href);
          const response =
            destination.href === ACCOUNT_SUBDOMAIN_URL
              ? Response.json({ result: { subdomain: WORKERS_DEV_SUBDOMAIN }, success: true })
              : Response.json({ result: { deployments: [{ versions }] }, success: true });
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        });
        const failure = yield* deployImmutableShellIngress({ appDirectory, receipt }).pipe(
          Effect.provide(
            deploymentLayer(appDirectory, client, commands, events, { TEST_OWNER_SECRET: OWNER_SECRET_VALUE }),
          ),
          Effect.flip,
        );
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
        expect(failure.message).toMatch(/version|deployment|receipt/u);
      }
      expect(requests).toEqual([ACCOUNT_SUBDOMAIN_URL, historyUrl, ACCOUNT_SUBDOMAIN_URL, historyUrl]);
      expect(commands).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'refuses a foreign account asset origin before uploading Shell assets, deploying ingress, or installing secrets',
  () =>
    Effect.scoped(
      Effect.gen(function* foreignAccountShellOrigin() {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-shell-release-account-' });
        const appDirectory = nodePath.join(workspaceRoot, 'apps', APP_ID);
        const plan = yield* planFor();
        yield* writeNativeShellOutput(appDirectory, plan);
        const assets = [...inventoryFor(plan).assets, file('_headers', text(RETAINED_HEADERS))];
        const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, { assets });
        const receipt = { artifacts, assetsVersionId: PROVIDER_VERSION, plan };
        const commands: OpsCommand[] = [];
        const requests: { readonly method: string; readonly url: string }[] = [];
        const events: string[] = [];
        const client = HttpClient.make((request, destination) => {
          requests.push({ method: request.method, url: destination.href });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ result: { subdomain: 'foreign-account' }, success: true }),
            ),
          );
        });
        const layer = deploymentLayer(appDirectory, client, commands, events, {
          TEST_OWNER_SECRET: OWNER_SECRET_VALUE,
        });
        const assetsFailure = yield* deployImmutableShellRelease({ appDirectory, plan }).pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        const ingressFailure = yield* deployImmutableShellIngress({ appDirectory, receipt }).pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        expect(Schema.is(ImmutableApplicationReleaseError)(assetsFailure)).toBe(true);
        expect(Schema.is(ImmutableApplicationReleaseError)(ingressFailure)).toBe(true);
        expect(assetsFailure.message).toMatch(/account|origin|subdomain/u);
        expect(ingressFailure.message).toMatch(/account|origin|subdomain/u);
        expect(requests).toEqual([
          { method: 'GET', url: ACCOUNT_SUBDOMAIN_URL },
          { method: 'GET', url: ACCOUNT_SUBDOMAIN_URL },
        ]);
        expect(commands).toEqual([]);
        expect(events.filter((event) => event.includes(PUBLICATION_LOCK))).toHaveLength(2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('publishes the exact Shell receipt identity and artifact pins and refuses an absent approved snapshot', () =>
  Effect.gen(function* retainedShellPublicationUrls() {
    const plan = yield* planFor();
    const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, inventoryFor(plan));
    const intent = { modules: [] };
    const receipt = { artifacts, assetsVersionId: PROVIDER_VERSION, plan };
    const updated = yield* makeImmutableApplicationReleasePublicationCandidate([], intent, receipt);
    expect(updated.shell).toEqual({
      deployment: { appId: APP_ID, buildMarker: plan.buildMarker },
      federationManifest: artifacts.federationManifest,
      runtimeContract: artifacts.runtimeContract,
    });
    const absent = yield* makeImmutableApplicationReleasePublicationCandidate([], intent).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(absent)).toBe(true);
    const approved = yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'stage',
      modules: [],
      observedAt: yield* DateTime.now,
      shell: {
        federationManifest: { bytes: inventoryFor(plan).assets[1].bytes, url: artifacts.federationManifest.url },
        runtimeContract: { bytes: inventoryFor(plan).assets[0].bytes, url: artifacts.runtimeContract.url },
      },
      validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
    });
    const ambiguous = yield* makeImmutableApplicationReleasePublicationCandidate([], intent, receipt, approved).pipe(
      Effect.flip,
    );
    expect(Schema.is(ImmutableApplicationReleaseError)(ambiguous)).toBe(true);
  }),
);

it.effect('rejects Shell publication receipts that identify a business module or point at mutable artifact URLs', () =>
  Effect.gen(function* invalidShellPublicationReceipt() {
    const plan = yield* planFor();
    const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, inventoryFor(plan));
    const receipt = { artifacts, assetsVersionId: PROVIDER_VERSION, plan };
    const businessPlan = yield* deriveImmutableApplicationReleasePlan({
      appId: 'party-registry',
      buildMarker: BUILD_MARKER,
      sourceRevision: SOURCE_REVISION,
      workersDevSubdomain: WORKERS_DEV_SUBDOMAIN,
    });
    for (const forged of [
      { ...receipt, plan: businessPlan },
      {
        ...receipt,
        artifacts: {
          ...artifacts,
          runtimeContract: {
            ...artifacts.runtimeContract,
            url: 'https://mutable-shell.example/.well-known/ontos-shell-runtime.json',
          },
        },
      },
    ]) {
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate([], { modules: [] }, forged).pipe(
        Effect.flip,
      );
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);
