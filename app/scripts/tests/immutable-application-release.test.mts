import nodePath from 'node:path';
import nodeProcess from 'node:process';

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
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Order,
  Redacted,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import {
  ImmutableApplicationReleaseError,
  ImmutableApplicationReleaseReceiptSchema,
  deployImmutableApplicationRelease,
  immutableAssetsWranglerConfig,
  deriveImmutableApplicationReleasePlan,
  makeImmutableApplicationReleasePublicationCandidate,
  resolveCleanImmutableApplicationSourceRevision,
  validateImmutableApplicationReleaseArtifacts,
} from '../immutable-application-release.mts';
import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  applicationCompositionRevision,
  deriveActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import { OpsShell, OpsShellLive, runCommand } from '../ops/ops-shell.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';
import { OpsCommandError } from '../ops/ops-command-error.mts';

const APP_ID = 'party-registry';
const GIT_COMMAND = 'git';
const TRUSTED_GIT_DIRECTORY = '/trusted/repository';
const WORKERS_SUBDOMAIN = 'ontos-test';
const CONTRACT_PATH = '.well-known/ontos-module-manifest.json';
const FEDERATION_MANIFEST_PATH = 'mf-manifest.json';
const REMOTE_ENTRY_PATH = 'remoteEntry.js';
const PAGE_JS_PATH = 'page.js';
const PAGE_CSS_PATH = 'page.css';
const DETAILS_JS_PATH = 'details.js';
const DETAILS_CSS_PATH = 'details.css';
const SHARED_JS_PATH = 'shared.js';
const SHARED_CSS_PATH = 'shared.css';
const ASSETS_VERSION_ID = '018c4a3c-a8de-4b15-948c-b45e83adb551';
const BACKEND_VERSION_ID = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f';
const COMPATIBILITY_DATE = '2026-09-24';
const PUBLIC_RELEASE_DIRECTORY = './public-release';
const BUILD_MARKER = '0123456789abcdef';
const SOURCE_REVISION = 'a'.repeat(40);
const WRANGLER_VERSION = '4.137.0';
const WRANGLER_CONFIG_PATH = 'wrangler.json';
const WORKER_METADATA_PATH = 'server/modern-worker-manifest.json';
const BACKEND_ENTRY_PATH = 'server/index.mjs';
const text = (value: string) => new TextEncoder().encode(value);
const json = (value: Schema.Json) => text(JSON.stringify(value));
const file = (path: string, bytes = text('retained release bytes')) => ({ bytes, path });

const planFor = (appId = APP_ID) =>
  deriveImmutableApplicationReleasePlan({
    appId,
    buildMarker: BUILD_MARKER,
    sourceRevision: SOURCE_REVISION,
    workersDevSubdomain: WORKERS_SUBDOMAIN,
  });

const backendFor = (plan: Parameters<typeof validateImmutableApplicationReleaseArtifacts>[0]) =>
  Schema.decodeUnknownSync(ImmutableApplicationReleaseReceiptSchema.fields.backend)({
    baseUrl: `https://${plan.backendScriptName}.${WORKERS_SUBDOMAIN}.workers.dev/`,
    transport: 'cloudflare-worker',
    versionId: BACKEND_VERSION_ID,
    workerName: plan.backendScriptName,
  });

const artifactInventory = (plan: Parameters<typeof validateImmutableApplicationReleaseArtifacts>[0]) => {
  const contract = {
    deployment: { appId: plan.appId, buildMarker: plan.buildMarker },
    manifest: {
      activation: {
        defaultState: 'inactive',
        preservesHistoryWhenInactive: true,
        scope: 'tenant',
        supportedStates: ['inactive', 'active'],
      },
      module: {
        description: 'An immutable retained module release',
        displayName: 'Party registry',
        id: 'party.registry',
        implementedAs: 'ultramodern_microvertical',
        kind: 'business_module',
      },
      publicSurface: {
        actions: [],
        api: [],
        businessPermissions: [],
        components: [],
        events: [],
        reports: [],
        resourceTypes: [],
        search: [],
        shellContributions: {
          mediaAttachments: [],
          navigation: [],
          pages: [],
          publicComponents: [],
          reports: [],
          resourceDetails: [],
          search: [],
          timelines: [],
        },
      },
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: '2',
  };
  const manifest = {
    exposes: [
      {
        assets: {
          css: { async: [DETAILS_CSS_PATH], sync: [PAGE_CSS_PATH] },
          js: { async: [DETAILS_JS_PATH], sync: [PAGE_JS_PATH] },
        },
      },
    ],
    metaData: { publicPath: plan.assetsOrigin },
    remoteEntry: { name: REMOTE_ENTRY_PATH },
    shared: [
      {
        assets: {
          css: { async: [], sync: [SHARED_CSS_PATH] },
          js: { async: [SHARED_JS_PATH], sync: [] },
        },
      },
    ],
  };
  return {
    assets: [
      file(CONTRACT_PATH, json(contract)),
      file(FEDERATION_MANIFEST_PATH, json(manifest)),
      file(REMOTE_ENTRY_PATH),
      file(PAGE_JS_PATH),
      file(DETAILS_JS_PATH),
      file(PAGE_CSS_PATH),
      file(DETAILS_CSS_PATH),
      file(SHARED_JS_PATH),
      file(SHARED_CSS_PATH),
    ],
    backendEntrypoint: 'worker/index.mjs',
    backendFiles: [file('worker/index.mjs', text('export default { fetch() { return new Response("ok"); } };'))],
    contract,
    deliveryUnit: {
      buildMarker: plan.buildMarker,
      sourceRevision: plan.sourceRevision,
      unitId: `app/${plan.appId}`,
    },
  };
};

const approvedShellSnapshot = Effect.gen(function* approvedShellSnapshotEffect() {
  const plan = yield* planFor('shell-super-app');
  return yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'stage',
    modules: [],
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: {
        bytes: json({
          exposes: [],
          name: 'shellSuperApp',
          shared: governedSharedSingletonPackages.map((name) => ({ name, requiredVersion: '1.0.0', singleton: true })),
        }),
        url: `${plan.assetsOrigin}mf-manifest.json`,
      },
      runtimeContract: {
        bytes: json(createShellRuntimeContract(plan.buildMarker)),
        url: `${plan.assetsOrigin}.well-known/ontos-shell-runtime.json`,
      },
    },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
});

const receiptFor = (appId = APP_ID) =>
  Effect.gen(function* retainedReleaseReceipt() {
    const plan = yield* planFor(appId);
    const artifacts = yield* validateImmutableApplicationReleaseArtifacts(plan, artifactInventory(plan));
    return {
      artifacts,
      assetsVersionId: ASSETS_VERSION_ID,
      backend: backendFor(plan),
      plan,
    };
  });

const gitResult = (command: OpsCommand, directory: string, revision = SOURCE_REVISION, status = '') => {
  if (command.args.join(' ') === 'rev-parse --show-toplevel') {
    return `${directory}\n`;
  }
  return command.args[0] === 'status' ? status : `${revision}\n`;
};

const writeNativeEnvelope = Effect.fn('test.writeNativeReleaseEnvelope')(function* writeNativeEnvelopeEffect(
  output: string,
  plan: Parameters<typeof validateImmutableApplicationReleaseArtifacts>[0],
  assets: ReturnType<typeof artifactInventory>['assets'],
  unitId?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const identityUnitId = unitId ?? `app/${plan.appId}`;
  const supportFiles = [
    file('worker/__modern_bff_effect.mjs', text('export const effectApi = "retained owner API";')),
    file('backend-manifest.json', json({ deliveryUnit: { ...plan, unitId: identityUnitId } })),
    file('backend-container.cjs', text('module.exports = { retainedBackend: true };')),
  ];
  for (const support of supportFiles) {
    const destination = nodePath.join(output, support.path);
    yield* fileSystem.makeDirectory(nodePath.dirname(destination), { recursive: true });
    yield* fileSystem.writeFile(destination, support.bytes);
  }
  const browserPaths = assets.filter(({ path }) => path.endsWith('.js')).map(({ path }) => `public/${path}`);
  const files = [
    { logicalPath: WRANGLER_CONFIG_PATH, runtime: 'cloudflare-deployment' },
    { logicalPath: WORKER_METADATA_PATH, runtime: 'cloudflare-deployment' },
    { logicalPath: BACKEND_ENTRY_PATH, runtime: 'workerd' },
    { logicalPath: 'public/_headers', runtime: 'public-metadata' },
    ...assets.map(({ path }) => ({
      logicalPath: `public/${path}`,
      runtime: path.endsWith('.js') ? 'browser' : 'public-asset',
    })),
    { logicalPath: supportFiles[0].path, runtime: 'workerd-effect' },
    { logicalPath: supportFiles[1].path, runtime: 'module-federation-manifest' },
    { logicalPath: supportFiles[2].path, runtime: 'commonjs-module' },
  ];
  const envelope = yield* Effect.tryPromise({
    catch: (cause) =>
      new ImmutableApplicationReleaseError({ cause, message: 'native test envelope could not be created' }),
    try: async () =>
      await createMicroVerticalReleaseEnvelope({
        artifactRoot: output,
        artifacts: files,
        identity: {
          buildMarker: plan.buildMarker,
          releaseVersion: '1.0.0',
          sourceRevision: plan.sourceRevision,
          unitId: identityUnitId,
        },
        surfaces: {
          apiBackend: [supportFiles[0].path],
          backendFederation: { container: supportFiles[2].path, manifest: supportFiles[1].path },
          ssr: [BACKEND_ENTRY_PATH],
          uiClient: EffectArray.sort(browserPaths, Order.String),
        },
        target: 'cloudflare',
      }),
  });
  const destination = nodePath.join(output, MICROVERTICAL_RELEASE_ENVELOPE_PATH);
  yield* fileSystem.makeDirectory(nodePath.dirname(destination), { recursive: true });
  yield* fileSystem.writeFileString(destination, canonicalSerializeMicroVerticalReleaseEnvelope(envelope));
});

it.effect('requires real Git HEAD and a clean checkout without inheriting Git environment overrides', () =>
  Effect.gen(function* cleanGitEvidence() {
    const commands: OpsCommand[] = [];
    const revision = yield* resolveCleanImmutableApplicationSourceRevision(TRUSTED_GIT_DIRECTORY).pipe(
      Effect.provideService(OpsShell, {
        run: (command) => {
          commands.push(command);
          return Effect.succeed(gitResult(command, TRUSTED_GIT_DIRECTORY));
        },
      }),
    );
    expect(revision).toBe(SOURCE_REVISION);
    expect(commands.map(({ args }) => args)).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--verify', 'HEAD'],
      ['status', '--porcelain=v1', '--untracked-files=all'],
    ]);
    for (const command of commands) {
      expect(command.command).toBe(GIT_COMMAND);
      expect(command.cwd).toBe(TRUSTED_GIT_DIRECTORY);
      expect(command.env).toEqual({});
      expect(command.extendEnv).toBe(false);
    }
  }),
);

it.effect('rejects dirty, untracked, invalid, and unavailable Git source evidence', () =>
  Effect.gen(function* invalidGitEvidence() {
    for (const [revision, status] of [
      [SOURCE_REVISION, ' M source.ts\n'],
      [SOURCE_REVISION, '?? untracked-source.ts\n'],
      ['workspace', ''],
      ['b'.repeat(39), ''],
    ]) {
      const failure = yield* resolveCleanImmutableApplicationSourceRevision(TRUSTED_GIT_DIRECTORY).pipe(
        Effect.provideService(OpsShell, {
          run: (command) => Effect.succeed(gitResult(command, TRUSTED_GIT_DIRECTORY, revision, status)),
        }),
        Effect.flip,
      );
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const unavailable = yield* resolveCleanImmutableApplicationSourceRevision('/not-a-repository').pipe(
      Effect.provideService(OpsShell, {
        run: () => Effect.fail(new OpsCommandError({ command: GIT_COMMAND, message: 'repository discovery failed' })),
      }),
      Effect.flip,
    );
    expect(unavailable.message).toBe('immutable release publication requires a clean Git checkout');
  }),
);

it.effect('executes source checks without inherited process environment selectors', () =>
  runCommand({
    args: [
      '--input-type=module',
      '-e',
      'process.stdout.write(JSON.stringify({ inheritedPath: Boolean(process.env.PATH), explicit: process.env.ONTOS_TEST_RELEASE_SENTINEL }));',
    ],
    command: nodeProcess.execPath,
    env: { ONTOS_TEST_RELEASE_SENTINEL: Redacted.make('explicit-release-value') },
    extendEnv: false,
  }).pipe(
    Effect.tap((stdout) =>
      Effect.sync(() => {
        expect(stdout).toBe('{"inheritedPath":false,"explicit":"explicit-release-value"}');
      }),
    ),
    Effect.provide(OpsShellLive.pipe(Layer.provide(NodeServices.layer))),
  ),
);

it.effect('derives stable bounded provider names and the retained assets origin from a release identity', () =>
  Effect.gen(function* releaseIdentity() {
    const first = yield* planFor();
    const same = yield* planFor();
    const different = yield* planFor('inventory');
    expect(first).toEqual(same);
    expect(first.backendScriptName).toMatch(/^ontos-[a-f0-9]{56}$/u);
    expect(first.assetsScriptName).toMatch(/^assets-[a-f0-9]{56}$/u);
    expect(first.backendScriptName).not.toBe(first.assetsScriptName);
    expect(different.backendScriptName).not.toBe(first.backendScriptName);
    expect(first.assetsOrigin).toBe(`https://${first.assetsScriptName}.ontos-test.workers.dev/`);
  }),
);

it.effect('rejects incomplete or ambiguous release identities before deriving provider names', () =>
  Effect.gen(function* invalidReleaseIdentity() {
    for (const override of [
      { buildMarker: 'party-build' },
      { buildMarker: `${BUILD_MARKER}0` },
      { buildMarker: BUILD_MARKER.toUpperCase() },
      { sourceRevision: 'dirty' },
      { sourceRevision: 'a'.repeat(39) },
      { sourceRevision: `${SOURCE_REVISION}-dirty` },
      { appId: '../party-registry' },
      { workersDevSubdomain: 'https://other.example' },
    ]) {
      const failure = yield* deriveImmutableApplicationReleasePlan({
        appId: APP_ID,
        buildMarker: BUILD_MARKER,
        sourceRevision: SOURCE_REVISION,
        workersDevSubdomain: WORKERS_SUBDOMAIN,
        ...override,
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const sha256Source = yield* deriveImmutableApplicationReleasePlan({
      appId: APP_ID,
      buildMarker: BUILD_MARKER,
      sourceRevision: 'b'.repeat(64),
      workersDevSubdomain: WORKERS_SUBDOMAIN,
    });
    expect(sha256Source.sourceRevision).toBe('b'.repeat(64));
  }),
);

it.effect('makes an assets-only worker config with neither a backend entrypoint nor SPA fallback', () =>
  Effect.gen(function* assetsOnlyConfig() {
    const plan = yield* planFor();
    expect(immutableAssetsWranglerConfig(plan, PUBLIC_RELEASE_DIRECTORY, COMPATIBILITY_DATE)).toEqual({
      assets: {
        directory: PUBLIC_RELEASE_DIRECTORY,
        html_handling: 'none',
        not_found_handling: 'none',
      },
      compatibility_date: COMPATIBILITY_DATE,
      name: plan.assetsScriptName,
      workers_dev: true,
    });
  }),
);

it.effect(
  'binds exact contract and federation bytes to their retained URLs and hashes inventory independently of order',
  () =>
    Effect.gen(function* completeInventory() {
      const plan = yield* planFor();
      const inventory = artifactInventory(plan);
      const approved = yield* validateImmutableApplicationReleaseArtifacts(plan, inventory);
      const reversed = yield* validateImmutableApplicationReleaseArtifacts(plan, {
        ...inventory,
        assets: EffectArray.reverse(inventory.assets),
        backendFiles: EffectArray.reverse(inventory.backendFiles),
      });
      expect(reversed).toEqual(approved);
      expect(approved.assetsSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(approved.workerSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(approved.contract.url).toBe(`${plan.assetsOrigin}.well-known/ontos-module-manifest.json`);
      expect(approved.contract.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(approved.federationManifest?.url).toBe(`${plan.assetsOrigin}mf-manifest.json`);
      expect(approved.federationManifest?.sha256).toMatch(/^[a-f0-9]{64}$/u);

      const changedBytes = yield* validateImmutableApplicationReleaseArtifacts(plan, {
        ...inventory,
        assets: inventory.assets.map((asset) =>
          asset.path === PAGE_JS_PATH ? file(asset.path, text('different retained module bytes')) : asset,
        ),
      });
      expect(changedBytes.assetsSha256).not.toBe(approved.assetsSha256);
      expect(changedBytes.workerSha256).toBe(approved.workerSha256);
    }),
);

it.effect('refuses missing manifest JS, CSS, remote entry, or public contract files', () =>
  Effect.gen(function* incompleteInventory() {
    const plan = yield* planFor();
    const inventory = artifactInventory(plan);
    for (const missing of [
      PAGE_JS_PATH,
      DETAILS_JS_PATH,
      PAGE_CSS_PATH,
      DETAILS_CSS_PATH,
      REMOTE_ENTRY_PATH,
      SHARED_JS_PATH,
      SHARED_CSS_PATH,
      CONTRACT_PATH,
    ]) {
      const failure = yield* validateImmutableApplicationReleaseArtifacts(plan, {
        ...inventory,
        assets: inventory.assets.filter(({ path }) => path !== missing),
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

it.effect('supports a complete API-only release without inventing a federation manifest', () =>
  Effect.gen(function* apiOnlyRelease() {
    const plan = yield* planFor('server-module');
    const inventory = artifactInventory(plan);
    const artifacts = yield* validateImmutableApplicationReleaseArtifacts(plan, {
      ...inventory,
      assets: inventory.assets.filter(({ path }) => path === CONTRACT_PATH),
    });
    expect(artifacts.federationManifest).toBeUndefined();
    const candidate = yield* makeImmutableApplicationReleasePublicationCandidate(
      [
        {
          artifacts,
          assetsVersionId: ASSETS_VERSION_ID,
          backend: backendFor(plan),
          plan,
        },
      ],
      { modules: [{ appId: plan.appId }] },
      undefined,
      yield* approvedShellSnapshot,
    );
    expect(candidate.modules).toEqual([
      {
        appId: plan.appId,
        backend: backendFor(plan),
        contractUrl: artifacts.contract.url,
      },
    ]);
  }),
);

it.effect('reports malformed contract and manifest bytes as validation failures', () =>
  Effect.gen(function* malformedEvidence() {
    const plan = yield* planFor();
    const inventory = artifactInventory(plan);
    for (const target of [CONTRACT_PATH, FEDERATION_MANIFEST_PATH]) {
      for (const invalid of [text('{'), new Uint8Array([0xc3, 0x28])]) {
        const failure = yield* validateImmutableApplicationReleaseArtifacts(plan, {
          ...inventory,
          assets: inventory.assets.map((asset) => (asset.path === target ? file(asset.path, invalid) : asset)),
        }).pipe(Effect.flip);
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
      }
    }
  }),
);

it.effect('rejects nonretained federation origins and contract or delivery identities from another build', () =>
  Effect.gen(function* mismatchedRelease() {
    const plan = yield* planFor();
    const inventory = artifactInventory(plan);
    const foreignManifest = {
      metaData: { publicPath: 'https://mutable.example/' },
      remoteEntry: { name: REMOTE_ENTRY_PATH },
    };
    const mutations = [
      { ...inventory, deliveryUnit: { ...inventory.deliveryUnit, buildMarker: 'fedcba9876543210' } },
      { ...inventory, deliveryUnit: { ...inventory.deliveryUnit, sourceRevision: 'b'.repeat(40) } },
      { ...inventory, deliveryUnit: { ...inventory.deliveryUnit, unitId: 'app/other-app' } },
      { ...inventory, contract: { deployment: { appId: 'other-app', buildMarker: plan.buildMarker } } },
      {
        ...inventory,
        assets: inventory.assets.map((asset) =>
          asset.path === FEDERATION_MANIFEST_PATH ? file(asset.path, json(foreignManifest)) : asset,
        ),
      },
    ];
    for (const mutation of mutations) {
      const failure = yield* validateImmutableApplicationReleaseArtifacts(plan, mutation).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

it.effect('refuses duplicate paths, traversal paths, public source maps, and public secret artifacts', () =>
  Effect.gen(function* forbiddenPublicFiles() {
    const plan = yield* planFor();
    const inventory = artifactInventory(plan);
    for (const unsafe of [
      file(PAGE_JS_PATH),
      file('../private/key.pem'),
      file('/absolute.js'),
      file('nested/../private.js'),
      file('page.js.map'),
      file('.env'),
      file('credentials.json'),
      file('private-key.pem'),
    ]) {
      const failure = yield* validateImmutableApplicationReleaseArtifacts(plan, {
        ...inventory,
        assets: [...inventory.assets, unsafe],
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const missingBackend = yield* validateImmutableApplicationReleaseArtifacts(plan, {
      ...inventory,
      backendFiles: [file('worker/other.mjs')],
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(missingBackend)).toBe(true);
  }),
);

it.effect('builds the publisher candidate only from the exact retained deployment receipt URLs', () =>
  Effect.gen(function* exactPublicationCandidate() {
    const receipt = yield* receiptFor();
    const approved = yield* approvedShellSnapshot;
    const candidate = yield* makeImmutableApplicationReleasePublicationCandidate(
      [receipt],
      { modules: [{ appId: receipt.plan.appId }] },
      undefined,
      approved,
    );
    expect(candidate).toEqual({
      modules: [
        {
          appId: receipt.plan.appId,
          backend: receipt.backend,
          contractUrl: receipt.artifacts.contract.url,
          federationManifestUrl: receipt.artifacts.federationManifest?.url,
        },
      ],
      retainedShellRevision: approved.composition.revision,
      shell: {
        deployment: approved.composition.shell.deployment,
        federationManifest: approved.composition.shell.federationManifest,
        runtimeContract: approved.composition.shell.runtimeContract,
      },
    });
  }),
);

it.effect('rejects backend receipts for another account or another valid immutable Worker', () =>
  Effect.gen(function* forgedNativeWorkerPlacement() {
    const receipt = yield* receiptFor();
    const foreignWorker = yield* receiptFor('inventory');
    const approved = yield* approvedShellSnapshot;
    const intent = { modules: [{ appId: receipt.plan.appId }] };
    const valid = yield* makeImmutableApplicationReleasePublicationCandidate([receipt], intent, undefined, approved);
    expect(valid.modules[0]?.backend).toEqual(receipt.backend);
    const foreignAccount = {
      ...receipt.backend,
      baseUrl: `https://${receipt.plan.backendScriptName}.foreign-account.workers.dev/`,
    };
    for (const backend of [foreignAccount, foreignWorker.backend]) {
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate(
        [{ ...receipt, backend }],
        intent,
        undefined,
        approved,
      ).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

it.effect(
  'rejects missing, expired and inconsistent approved snapshots instead of retaining guessed Shell artifacts',
  () =>
    Effect.gen(function* invalidApprovedShellHandoff() {
      const receipt = yield* receiptFor();
      const intent = { modules: [{ appId: receipt.plan.appId }] };
      const approved = yield* approvedShellSnapshot;
      const missing = yield* makeImmutableApplicationReleasePublicationCandidate([receipt], intent).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(missing)).toBe(true);
      const expired = {
        ...approved,
        observedAt: DateTime.makeUnsafe(-1000),
        validUntil: DateTime.makeUnsafe(0),
      };
      const mismatched = {
        ...approved,
        composition: {
          ...approved.composition,
          shell: {
            ...approved.composition.shell,
            deployment: { ...approved.composition.shell.deployment, buildMarker: 'another-release' },
          },
        },
      };
      for (const snapshot of [expired, mismatched]) {
        const failure = yield* makeImmutableApplicationReleasePublicationCandidate(
          [receipt],
          intent,
          undefined,
          snapshot,
        ).pipe(Effect.flip);
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
      }
    }),
);

it.effect(
  'rejects a canonical snapshot with mutable Shell origins and does not invent missing requested module receipts',
  () =>
    Effect.gen(function* rejectsUnretainedAndMissingArtifacts() {
      const receipt = yield* receiptFor();
      const approved = yield* approvedShellSnapshot;
      const mutableComposition = {
        ...approved.composition,
        shell: {
          ...approved.composition.shell,
          federationManifest: {
            ...approved.composition.shell.federationManifest,
            url: 'https://mutable.example/mf-manifest.json',
          },
          runtimeContract: {
            ...approved.composition.shell.runtimeContract,
            url: 'https://mutable.example/.well-known/ontos-shell-runtime.json',
          },
        },
      };
      const composition = { ...mutableComposition, revision: applicationCompositionRevision(mutableComposition) };
      const mutable = yield* makeImmutableApplicationReleasePublicationCandidate(
        [receipt],
        { modules: [{ appId: receipt.plan.appId }] },
        undefined,
        { ...approved, composition },
      ).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(mutable)).toBe(true);
      expect(mutable.message).toContain('retained native release assets');
      const missingReceipt = yield* makeImmutableApplicationReleasePublicationCandidate(
        [],
        { modules: [{ appId: receipt.plan.appId }] },
        undefined,
        approved,
      ).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(missingReceipt)).toBe(true);
      expect(missingReceipt.message).toContain('every selected module');
    }),
);

it.effect('refuses reused release identities and receipts that redirect publication away from retained assets', () =>
  Effect.gen(function* invalidPublicationReceipts() {
    const receipt = yield* receiptFor();
    const approved = yield* approvedShellSnapshot;
    const forged = {
      ...receipt,
      artifacts: {
        ...receipt.artifacts,
        contract: {
          ...receipt.artifacts.contract,
          url: 'https://mutable.example/.well-known/ontos-module-manifest.json',
        },
      },
    };
    const reused = {
      ...receipt,
      plan: { ...receipt.plan, sourceRevision: 'b'.repeat(40) },
    };
    const invalidReceipts = [
      [receipt, receipt],
      [receipt, reused],
      [forged],
      [{ ...receipt, backend: { ...receipt.backend, workerName: '' } }],
      [{ ...receipt, assetsVersionId: '' }],
      [{ ...receipt, plan: { ...receipt.plan, backendScriptName: 'mutable-owner' } }],
    ];
    for (const receipts of invalidReceipts) {
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate(
        receipts,
        { modules: [{ appId: receipt.plan.appId }] },
        undefined,
        approved,
      ).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    for (const versionId of ['', 'invalid-native-version']) {
      expect(
        Schema.is(ImmutableApplicationReleaseReceiptSchema)({ ...receipt, backend: { ...receipt.backend, versionId } }),
      ).toBe(false);
    }
  }),
);

it.effect('requires deployment receipts for exactly the reviewed full module set', () =>
  Effect.gen(function* reviewedReleaseMembership() {
    const receipt = yield* receiptFor();
    const otherReceipt = yield* receiptFor('inventory');
    const approved = yield* approvedShellSnapshot;
    const intents = [
      { modules: [] },
      { modules: [{ appId: receipt.plan.appId }, { appId: otherReceipt.plan.appId }] },
      { modules: [{ appId: otherReceipt.plan.appId }] },
    ];
    for (const intent of intents) {
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate(
        [receipt],
        intent,
        undefined,
        approved,
      ).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const unreviewed = yield* makeImmutableApplicationReleasePublicationCandidate(
      [receipt, otherReceipt],
      { modules: [{ appId: receipt.plan.appId }] },
      undefined,
      approved,
    ).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(unreviewed)).toBe(true);
  }),
);

const refusesExistingProviderRelease = (existingBackend: boolean) =>
  Effect.scoped(
    Effect.gen(function* existingProviderRelease() {
      const fileSystem = yield* FileSystem.FileSystem;
      const appDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-release-refusal-' });
      const plan = yield* planFor();
      const inventory = artifactInventory(plan);
      const output = nodePath.join(appDirectory, '.output');
      const publicDirectory = nodePath.join(output, 'public');
      yield* fileSystem.makeDirectory(nodePath.join(publicDirectory, '.well-known'), { recursive: true });
      yield* fileSystem.makeDirectory(nodePath.join(output, 'server'), { recursive: true });
      yield* fileSystem.writeFileString(
        nodePath.join(output, WRANGLER_CONFIG_PATH),
        JSON.stringify({
          assets: { directory: 'public' },
          compatibility_date: COMPATIBILITY_DATE,
          main: BACKEND_ENTRY_PATH,
        }),
      );
      yield* fileSystem.writeFileString(
        nodePath.join(output, WORKER_METADATA_PATH),
        JSON.stringify({ deliveryUnit: inventory.deliveryUnit }),
      );
      yield* fileSystem.writeFileString(nodePath.join(output, BACKEND_ENTRY_PATH), 'export default {};');
      for (const { bytes, path: assetPath } of inventory.assets) {
        yield* fileSystem.writeFile(nodePath.join(publicDirectory, assetPath), bytes);
      }
      const compiledHeaders = '/*\n  Cache-Control: no-cache\n';
      yield* fileSystem.writeFileString(nodePath.join(publicDirectory, '_headers'), compiledHeaders);
      yield* writeNativeEnvelope(output, plan, inventory.assets);
      yield* fileSystem.writeFileString(
        nodePath.join(appDirectory, 'package.json'),
        JSON.stringify({ devDependencies: { wrangler: WRANGLER_VERSION } }),
      );

      const requests: { readonly method: string; readonly url: string }[] = [];
      const commands: OpsCommand[] = [];
      const client = HttpClient.make((request, destination) => {
        if (destination.pathname.endsWith('/workers/subdomain')) {
          requests.push({ method: request.method, url: destination.href });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ result: { subdomain: WORKERS_SUBDOMAIN }, success: true }),
            ),
          );
        }
        const status = existingBackend || requests.length > 1 ? 200 : 404;
        requests.push({ method: request.method, url: destination.href });
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
      });
      const refusalLayer = Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(OpsShell, {
          run: (command) => {
            if (command.command === GIT_COMMAND) {
              return Effect.succeed(gitResult(command, appDirectory));
            }
            if (command.args.join(' ') === 'exec wrangler --version') {
              return Effect.succeed(WRANGLER_VERSION);
            }
            commands.push(command);
            return Effect.die(new Error('An existing immutable release must never execute a deployment command'));
          },
        }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
            CLOUDFLARE_API_TOKEN: 'release-refusal-test-token',
            ONTOS_IMMUTABLE_RELEASE_SECRETS: '{}',
          }),
        ),
      );
      const failure = yield* deployImmutableApplicationRelease({
        appDirectory,
        plan,
      }).pipe(Effect.provide(refusalLayer), Effect.flip);

      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
      expect(failure.message).toBe('an immutable release identity already exists; publication must never overwrite it');
      expect(commands).toEqual([]);
      expect(requests.map(({ method }) => method)).toEqual(existingBackend ? ['GET', 'GET'] : ['GET', 'GET', 'GET']);
      expect(requests[0]?.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/subdomain`,
      );
      expect(requests[1]?.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${plan.backendScriptName}`,
      );
      if (!existingBackend) {
        expect(requests[2]?.url).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${plan.assetsScriptName}`,
        );
      }
      expect(yield* fileSystem.exists(nodePath.join(output, '.wrangler-immutable-backend.json'))).toBe(false);
      expect(yield* fileSystem.exists(nodePath.join(output, '.wrangler-immutable-assets.json'))).toBe(false);
      expect(yield* fileSystem.readFileString(nodePath.join(publicDirectory, '_headers'))).toBe(compiledHeaders);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect('refuses an existing backend identity before commands, secret writes, or generated deployment config', () =>
  refusesExistingProviderRelease(true),
);

it.effect('refuses an existing assets identity before commands, secret writes, or generated deployment config', () =>
  refusesExistingProviderRelease(false),
);

const prepareDeployment = Effect.fn('test.prepareImmutableRelease')(function* prepareDeploymentEffect(
  options: {
    readonly accountSubdomain?: string;
    readonly assetDeploymentPercentage?: number;
    readonly backendDeploymentVersions?: readonly { readonly percentage: number; readonly version_id: string }[];
    readonly backendSubdomainEnabled?: boolean;
    readonly backendSubdomainStatus?: number;
    readonly backendSubdomainSuccess?: boolean;
    readonly changedSource?: boolean;
    readonly deployedEntrypoint?: string | false;
    readonly envelopeUnitId?: string;
    readonly initialSource?: string;
    readonly noBundle?: boolean;
    readonly omitBackendSubdomainEnabled?: boolean;
    readonly omitEnvelope?: boolean;
    readonly oversizedAssetBody?: boolean;
    readonly ownerSecrets?: Readonly<Record<string, string>>;
    readonly resolvedWranglerVersion?: string;
    readonly stallAssetBody?: boolean;
    readonly tamperWorkerAfterEnvelope?: boolean;
    readonly tamperWorkerDuringPackaging?: boolean;
    readonly unboundFile?: boolean;
    readonly unboundFileDuringPackaging?: boolean;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const appDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-release-deploy-' });
  const output = nodePath.join(appDirectory, '.output');
  const publicDirectory = nodePath.join(output, 'public');
  const plan = yield* planFor();
  const inventory = artifactInventory(plan);
  const capturedMain = options.noBundle === true ? 'index.mjs' : 'index.js';
  const capturedModules = [
    file(capturedMain, text('import "./chunk.js"; export default {};')),
    file('chunk.js', text('export const retained = "exact packaged module bytes";')),
  ];
  yield* fileSystem.makeDirectory(nodePath.join(publicDirectory, '.well-known'), { recursive: true });
  yield* fileSystem.makeDirectory(nodePath.join(output, 'server'), { recursive: true });
  yield* fileSystem.writeFileString(
    nodePath.join(output, WRANGLER_CONFIG_PATH),
    JSON.stringify({
      alias: { runtime: './server/index.mjs' },
      assets: { directory: 'public' },
      compatibility_date: COMPATIBILITY_DATE,
      main: BACKEND_ENTRY_PATH,
      no_bundle: options.noBundle === true,
      rules: [{ globs: ['**/*.mjs'], type: 'ESModule' }],
    }),
  );
  yield* fileSystem.writeFileString(
    nodePath.join(output, WORKER_METADATA_PATH),
    JSON.stringify({ deliveryUnit: inventory.deliveryUnit }),
  );
  yield* fileSystem.writeFileString(nodePath.join(output, BACKEND_ENTRY_PATH), 'export default {};');
  for (const { bytes, path: assetPath } of inventory.assets) {
    yield* fileSystem.writeFile(nodePath.join(publicDirectory, assetPath), bytes);
  }
  const originalHeaders = '/*\n  Cache-Control: no-cache\n';
  yield* fileSystem.writeFileString(nodePath.join(publicDirectory, '_headers'), originalHeaders);
  yield* fileSystem.writeFileString(
    nodePath.join(appDirectory, 'package.json'),
    JSON.stringify({ devDependencies: { wrangler: WRANGLER_VERSION } }),
  );
  if (options.omitEnvelope !== true) {
    yield* writeNativeEnvelope(output, plan, inventory.assets, options.envelopeUnitId);
  }
  if (options.tamperWorkerAfterEnvelope === true) {
    yield* fileSystem.writeFileString(nodePath.join(output, BACKEND_ENTRY_PATH), 'export default { changed: true };');
  }
  if (options.unboundFile === true) {
    yield* fileSystem.writeFileString(
      nodePath.join(output, 'undeclared-owner-module.mjs'),
      'export const hidden = true;',
    );
  }
  const assetReadStarted = yield* Deferred.make<boolean>();
  const commands: OpsCommand[] = [];
  const capturedConfigs: Readonly<Record<string, Schema.Json>>[] = [];
  const requests: string[] = [];
  const providerWrites: { readonly method: string; readonly url: string }[] = [];
  let canceledAssetBodies = 0;
  let checkedSource = 0;
  let absentChecks = 0;
  const providerResponse = (destination: URL): Response => {
    if (destination.pathname.endsWith('/workers/subdomain')) {
      return Response.json({
        result: { subdomain: options.accountSubdomain ?? WORKERS_SUBDOMAIN },
        success: true,
      });
    }
    if (destination.pathname.endsWith(`/workers/scripts/${plan.backendScriptName}/subdomain`)) {
      return Response.json(
        {
          result:
            options.omitBackendSubdomainEnabled === true ? {} : { enabled: options.backendSubdomainEnabled ?? true },
          success: options.backendSubdomainSuccess ?? true,
        },
        { status: options.backendSubdomainStatus ?? 200 },
      );
    }
    if (destination.pathname.endsWith('/content/v2')) {
      const content = new FormData();
      for (const module of capturedModules) {
        content.append(module.path, new File([module.bytes], module.path));
      }
      return new Response(content, {
        headers:
          options.deployedEntrypoint === false ? {} : { 'cf-entrypoint': options.deployedEntrypoint ?? capturedMain },
      });
    }
    if (destination.pathname.endsWith(`/workers/scripts/${plan.backendScriptName}/deployments`)) {
      return Response.json({
        result: {
          deployments: [
            { versions: options.backendDeploymentVersions ?? [{ percentage: 100, version_id: BACKEND_VERSION_ID }] },
          ],
        },
        success: true,
      });
    }
    if (destination.pathname.endsWith('/deployments')) {
      return Response.json({
        result: {
          deployments: [
            { versions: [{ percentage: options.assetDeploymentPercentage ?? 100, version_id: ASSETS_VERSION_ID }] },
          ],
        },
        success: true,
      });
    }
    if (destination.pathname.endsWith('/secrets')) {
      return Response.json({ result: { name: 'OWNER_BINDING', type: 'secret_text' }, success: true });
    }
    const status = absentChecks < 2 ? 404 : 200;
    absentChecks += 1;
    return new Response(null, { status });
  };
  const client = HttpClient.make((request, destination) =>
    Effect.gen(function* retainedProviderResponse() {
      requests.push(destination.href);
      if (request.method !== 'GET') {
        providerWrites.push({ method: request.method, url: destination.href });
      }
      let response: Response;
      if (destination.hostname === 'api.cloudflare.com') {
        response = providerResponse(destination);
      } else {
        yield* Deferred.succeed(assetReadStarted, true);
        const asset = inventory.assets.find(({ path }) => destination.pathname === `/${path}`);
        let body: ArrayBuffer | ReadableStream<Uint8Array> | undefined =
          asset === undefined ? undefined : new Uint8Array(asset.bytes).buffer;
        if (options.stallAssetBody === true) {
          body = new ReadableStream<Uint8Array>({
            cancel: () => {
              canceledAssetBodies += 1;
            },
          });
        } else if (options.oversizedAssetBody === true) {
          body = new Uint8Array((asset?.bytes.byteLength ?? 0) + 1).buffer;
        }
        response = new Response(body, {
          headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'public, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          },
          status: asset === undefined ? 404 : 200,
        });
      }
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const shellLayer = Layer.succeed(OpsShell, {
    run: (command: OpsCommand) =>
      Effect.gen(function* nativeDeploymentCommand() {
        if (command.command === GIT_COMMAND) {
          if (command.args[0] === 'status') {
            checkedSource += 1;
          }
          const revision =
            options.initialSource ??
            (options.changedSource === true && checkedSource > 0 ? 'b'.repeat(40) : SOURCE_REVISION);
          return gitResult(command, appDirectory, revision);
        }
        if (command.args.join(' ') === 'exec wrangler --version') {
          return options.resolvedWranglerVersion ?? WRANGLER_VERSION;
        }
        commands.push(command);
        const config = command.args[command.args.indexOf('--config') + 1];
        if (config === undefined) {
          return yield* Effect.die('a native release command must identify its Wrangler config');
        }
        capturedConfigs.push(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
            yield* fileSystem.readFileString(config),
          ),
        );
        if (command.args.includes('--dry-run')) {
          const directory = command.args[command.args.indexOf('--outdir') + 1];
          if (directory === undefined) {
            return yield* Effect.die('native packaging must identify its captured output directory');
          }
          for (const module of capturedModules) {
            yield* fileSystem.writeFile(nodePath.join(directory, module.path), module.bytes);
          }
          if (options.tamperWorkerDuringPackaging === true) {
            yield* fileSystem.writeFileString(
              nodePath.join(output, BACKEND_ENTRY_PATH),
              'export default { changed: true };',
            );
          }
          if (options.unboundFileDuringPackaging === true) {
            yield* fileSystem.writeFileString(
              nodePath.join(output, 'unbound-during-packaging.mjs'),
              'export const extra = true;',
            );
          }
        }
        return '';
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OpsCommandError({ cause, command: 'native release fixture', message: 'native test packaging failed' }),
        ),
      ),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    shellLayer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_API_TOKEN: 'immutable-release-test-token',
        ONTOS_IMMUTABLE_RELEASE_SECRETS: JSON.stringify(options.ownerSecrets ?? {}),
      }),
    ),
  );
  return {
    assetReadStarted,
    canceledAssetBodies: () => canceledAssetBodies,
    capturedConfigs,
    commands,
    deploy: deployImmutableApplicationRelease({ appDirectory, plan }).pipe(Effect.provide(layer)),
    originalHeaders,
    output,
    plan,
    providerWrites,
    publicDirectory,
    requests,
  };
});

it.effect('publishes the complete captured native package and leaves compiled assets unchanged', () =>
  Effect.scoped(
    Effect.gen(function* completeNativeUpload() {
      const fixture = yield* prepareDeployment({ ownerSecrets: { OWNER_BINDING: 'owned-release-test-binding' } });
      const receipt = yield* fixture.deploy;
      const fileSystem = yield* FileSystem.FileSystem;
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(receipt.backend.versionId).toBe(BACKEND_VERSION_ID);
      expect(receipt.backend).toEqual(backendFor(fixture.plan));
      expect(receipt.artifacts.workerSha256).toMatch(/^[a-f\d]{64}$/u);
      expect(fixture.commands).toHaveLength(3);
      expect(fixture.commands[0]?.args).toContain('--dry-run');
      expect(fixture.commands[1]?.args).toContain('--no-bundle');
      expect(fixture.commands.every(({ args }) => !args.includes('--dispatch-namespace'))).toBe(true);
      expect(fixture.capturedConfigs[0]?.workers_dev).toBe(true);
      expect(fixture.capturedConfigs[1]?.workers_dev).toBe(true);
      expect(fixture.requests.some((url) => url.includes('/dispatch/'))).toBe(false);
      const backendEndpoint = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${fixture.plan.backendScriptName}`;
      expect(fixture.requests).toContain(`${backendEndpoint}/content/v2`);
      expect(fixture.requests).toContain(`${backendEndpoint}/subdomain`);
      expect(fixture.requests).toContain(`${backendEndpoint}/deployments`);
      expect(fixture.providerWrites).toEqual([{ method: 'PUT', url: `${backendEndpoint}/secrets` }]);
      expect(fixture.capturedConfigs[1]?.rules).toContainEqual({
        fallthrough: true,
        globs: ['**/*.js', '**/*.mjs'],
        type: 'ESModule',
      });
      expect(fixture.capturedConfigs[1]?.find_additional_modules).toBe(true);
      expect(fixture.capturedConfigs[1]?.alias).toBeUndefined();
      expect(yield* fileSystem.readFileString(nodePath.join(fixture.publicDirectory, '_headers'))).toBe(
        fixture.originalHeaders,
      );
      expect(
        (yield* fileSystem.readDirectory(fixture.output)).some((name) => name.startsWith('.wrangler-immutable-')),
      ).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects another source revision before inspecting output or making provider requests', () =>
  Effect.scoped(
    Effect.gen(function* mismatchedGitSource() {
      const fixture = yield* prepareDeployment({ initialSource: 'b'.repeat(40) });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe('the release plan does not identify the current clean Git source revision');
      expect(fixture.commands).toEqual([]);
      expect(fixture.requests).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rechecks the clean source revision after native packaging and before publishing any Worker', () =>
  Effect.scoped(
    Effect.gen(function* changedSourceDuringPackaging() {
      const fixture = yield* prepareDeployment({ changedSource: true });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe('the source revision changed while preparing the immutable upload package');
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.commands[0]?.args).toContain('--dry-run');
      expect(fixture.requests).toHaveLength(3);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('times out stalled asset body readback after successful response headers', () =>
  Effect.scoped(
    Effect.gen(function* stalledAssetBodyReadback() {
      const fixture = yield* prepareDeployment({ stallAssetBody: true });
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.assetReadStarted);
      yield* TestClock.adjust('30 seconds');
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe('immutable release asset readback failed or exceeded its timeout');
      expect(fixture.canceledAssetBodies()).toBeGreaterThan(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'requires a genuine native envelope and rejects changed, foreign, or undeclared artifacts before provider I/O',
  () =>
    Effect.scoped(
      Effect.gen(function* invalidNativeSourceArtifacts() {
        for (const options of [
          { omitEnvelope: true },
          { tamperWorkerAfterEnvelope: true },
          { envelopeUnitId: 'app/foreign-owner' },
          { unboundFile: true },
        ]) {
          const fixture = yield* prepareDeployment(options);
          const failure = yield* fixture.deploy.pipe(Effect.flip);
          expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
          expect(failure.message).toMatch(/native.*(?:envelope|artifact)/u);
          expect(fixture.requests).toEqual([]);
          expect(fixture.commands).toEqual([]);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses a global or different Wrangler version before capture or provider I/O', () =>
  Effect.scoped(
    Effect.gen(function* invalidNativeToolchain() {
      const fixture = yield* prepareDeployment({ resolvedWranglerVersion: '4.95.0' });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe('the resolved native Wrangler version differs from the delivery unit toolchain pin');
      expect(fixture.requests).toEqual([]);
      expect(fixture.commands).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses absent or foreign native entrypoints even when every retained module byte matches', () =>
  Effect.scoped(
    Effect.gen(function* differentNativeEntrypoint() {
      const entrypoints: readonly (false | string)[] = [false, 'chunk.js'];
      for (const deployedEntrypoint of entrypoints) {
        const fixture = yield* prepareDeployment({ deployedEntrypoint });
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        expect(failure.message).toBe('the provider retained a missing or different immutable Worker entrypoint');
        expect(fixture.requests.some((url) => url.includes(`.${WORKERS_SUBDOMAIN}.workers.dev/`))).toBe(false);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rechecks bound and undeclared source output after packaging before any native upload', () =>
  Effect.scoped(
    Effect.gen(function* changedOutputDuringNativePackaging() {
      for (const options of [{ tamperWorkerDuringPackaging: true }, { unboundFileDuringPackaging: true }]) {
        const fixture = yield* prepareDeployment(options);
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
        expect(failure.message).toMatch(/native.*(?:envelope|artifact)/u);
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.commands[0]?.args).toContain('--dry-run');
        expect(fixture.requests).toHaveLength(3);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('bounds deployed asset response bytes by the exact compiled file size', () =>
  Effect.scoped(
    Effect.gen(function* oversizedPublicArtifact() {
      const fixture = yield* prepareDeployment({ oversizedAssetBody: true });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe('immutable release asset readback failed or exceeded its timeout');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('preserves the actual native entrypoint extension when the compiled Worker disables bundling', () =>
  Effect.scoped(
    Effect.gen(function* unbundledNativeEntrypoint() {
      const fixture = yield* prepareDeployment({ noBundle: true });
      const receipt = yield* fixture.deploy;
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(fixture.capturedConfigs[1]?.main).toMatch(/\/index\.mjs$/u);
      expect(fixture.capturedConfigs[1]?.no_bundle).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects public assets outside the locked native account before any deployment command', () =>
  Effect.scoped(
    Effect.gen(function* foreignNativeAssetsAccount() {
      const fixture = yield* prepareDeployment({ accountSubdomain: 'foreign-account' });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe('the immutable assets origin does not belong to the locked Cloudflare account');
      expect(fixture.commands).toEqual([]);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatch(/\/workers\/subdomain$/u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('requires the immutable assets receipt to identify a complete native provider deployment', () =>
  Effect.scoped(
    Effect.gen(function* partialNativeAssetDeployment() {
      const fixture = yield* prepareDeployment({ assetDeploymentPercentage: 50 });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe(
        'the immutable Worker release has no actual single-version active deployment receipt',
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('requires provider confirmation that the immutable backend is enabled on workers.dev', () =>
  Effect.scoped(
    Effect.gen(function* missingNativeBackendHostname() {
      for (const options of [
        { backendSubdomainEnabled: false },
        { omitBackendSubdomainEnabled: true },
        { backendSubdomainSuccess: false },
        { backendSubdomainStatus: 404 },
      ]) {
        const fixture = yield* prepareDeployment(options);
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
        expect(fixture.capturedConfigs[1]?.workers_dev).toBe(true);
        expect(
          fixture.requests.some((url) => url.endsWith(`/workers/scripts/${fixture.plan.backendScriptName}/subdomain`)),
        ).toBe(true);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('requires one backend provider version serving every request before issuing its release receipt', () =>
  Effect.scoped(
    Effect.gen(function* missingOrPartialNativeBackendVersion() {
      const ambiguousVersions = [
        { percentage: 50, version_id: BACKEND_VERSION_ID },
        { percentage: 50, version_id: ASSETS_VERSION_ID },
      ];
      for (const backendDeploymentVersions of [
        [],
        ambiguousVersions,
        [{ percentage: 99, version_id: BACKEND_VERSION_ID }],
        [{ percentage: 100, version_id: 'invalid-native-version' }],
      ]) {
        const fixture = yield* prepareDeployment({ backendDeploymentVersions });
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
        expect(
          fixture.requests.some((url) =>
            url.endsWith(`/workers/scripts/${fixture.plan.backendScriptName}/deployments`),
          ),
        ).toBe(true);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
