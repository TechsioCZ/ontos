import nodePath from 'node:path';
import nodeProcess from 'node:process';

import { parseDocument } from 'yaml';

import { NodeServices } from '@effect/platform-node';
import {
  canonicalSerializeMicroVerticalReleaseEnvelope,
  createMicroVerticalReleaseEnvelope,
  MICROVERTICAL_RELEASE_ENVELOPE_KIND,
  SHELL_RELEASE_ENVELOPE_KIND,
} from '@modern-js/app-tools-extensions/release-envelope';
import type { ReleaseEnvelopeKind } from '@modern-js/app-tools-extensions/release-envelope';
import { MICROVERTICAL_RELEASE_ENVELOPE_PATH } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { createUltramodernReleaseBuildMarker } from '@modern-js/app-tools-extensions/release-identity';
import {
  Array as EffectArray,
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Match,
  Order,
  Redacted,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/http';

import {
  ImmutableApplicationReleaseError,
  ImmutableApplicationReleaseReceiptSchema,
  ImmutableNodeReleasePlanSchema,
  ImmutableNodeReleaseReceiptSchema,
  deriveImmutableNodeReleasePlan,
  immutableNodeBuildEnvironment,
  makeImmutableNodeReleasePublicationCandidate,
  observeImmutableNodeCandidateReceipts,
  materializeImmutableNodePushYaml,
  readVerifiedNodeReleaseOutput,
  validateImmutableNodePublicArtifacts,
  deployImmutableApplicationRelease,
  deployImmutableNodeAssets,
  deployImmutableNodeRelease,
  immutableAssetsWranglerConfig,
  deriveImmutableApplicationReleasePlan,
  makeImmutableApplicationReleasePublicationCandidate,
  readReleaseFiles,
  resolveCleanImmutableApplicationSourceRevision,
  resolveImmutableApplicationReleaseReceipts,
  validateImmutableApplicationReleaseArtifacts,
} from '../immutable-application-release.mts';
import type {
  ImmutableNodeAssetReceipt,
  ImmutableNodeReleasePlan,
  ImmutableNodeReleaseReceipt,
  ReleaseFile,
} from '../immutable-application-release.mts';
import {
  ApplicationReleaseIntentSchema,
  ApplicationReleaseSelectionSchema,
  selectApplicationReleaseUnits,
} from '../application-release-intent.mts';
import type {
  ApplicationReleaseDeploymentUnit,
  ApplicationReleaseIntent,
  ApplicationReleaseSelection,
} from '../application-release-intent.mts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { ApplicationCompositionSchema } from '../../packages/core-runtime/src/modules/application-composition.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ApplicationCompositionPublicationCandidateSchema,
  serviceIdVariable,
} from '../publish-active-application-composition.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import { ApplicationCompositionBackendSchema } from '../../packages/core-runtime/src/index.ts';
import { validateImmutableShellReleaseArtifacts } from '../immutable-shell-release.mts';
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
import { releaseUiFor } from './release-envelope-ui.fixture.mts';
import { planDeploymentImpact } from '../plan-deployment-impact.mts';
import { outboxWorkerHostDelivery } from '../outbox-worker-delivery.mjs';

const SHELL_RUNTIME_FILE = '.well-known/ontos-shell-runtime.json';
const NODE_BUILD_MARKER_FILE = 'ultramodern-build.json';
const PACKAGE_FILE = 'package.json';
const WORKERS_SUBDOMAIN_PATH = '/workers/subdomain';
const WRANGLER_VERSION_COMMAND = 'exec wrangler --version';
const NATIVE_DEPLOYMENTS_PATH = '/deployments';
const IMMUTABLE_CACHE_HEADER = 'public, max-age=31536000, immutable';
const PUBLIC_ASSET_STAGE = 'public-assets-retained';
const PUBLIC_ACCESS_EVENT = 'public-access';
const FEDERATION_ARTIFACT_RUNTIME = 'module-federation-manifest';
const APP_ID = 'party-registry';
const SHELL_APP_ID = 'shell-super-app';
const UNSELECTED_HOST_OWNER = 'commerce-order';
const GIT_COMMAND = 'git';
const TRUSTED_GIT_DIRECTORY = '/trusted/repository';
const WORKERS_SUBDOMAIN = 'ontos-test';
const CONTRACT_PATH = '.well-known/ontos-module-manifest.json';
const FEDERATION_MANIFEST_PATH = 'mf-manifest.json';
const REMOTE_ENTRY_PATH = 'remoteEntry.js';
const PAGE_JS_PATH = 'page.js';
const NATIVE_PAGE_JS_PATH = 'static/js/async/(lang)/$.e213690cdf.js';
const NATIVE_ROUTE_TYPES_PATH = '@mf-types/compiled-types/src/routes/[lang]/contacts/page.d.ts';
const NATIVE_ROUTE_META_TYPES_PATH = '@mf-types/compiled-types/src/routes/[lang]/contacts/route.meta.d.ts';
const PAGE_CSS_PATH = 'page.css';
const DETAILS_JS_PATH = 'details.js';
const DETAILS_CSS_PATH = 'details.css';
const SHARED_JS_PATH = 'shared.js';
const SHARED_CSS_PATH = 'shared.css';
const ASSETS_VERSION_ID = '018c4a3c-a8de-4b15-948c-b45e83adb551';
const BACKEND_VERSION_ID = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f';
const COMPATIBILITY_DATE = '2026-09-24';
const PUBLIC_RELEASE_DIRECTORY = './public-release';
const BUILD_MARKER = '0123456789abcdef'.repeat(4);
const SOURCE_REVISION = 'a'.repeat(40);
const WRANGLER_VERSION = '4.137.0';
const WRANGLER_CONFIG_PATH = 'wrangler.json';
const WORKER_METADATA_PATH = 'server/modern-worker-manifest.json';
const ROBOTS_PATH = 'robots.txt';
const ALL_ABSENT_HEADERS = 'all-absent';
const BACKEND_ENTRY_PATH = 'server/index.mjs';
const OWNER_SECRET_VALUE = 'owned-release-test-binding';
const ASSET_READBACK_FAILURE = 'immutable release asset readback failed or exceeded its timeout';
const ASSETS_ROUTING_FAILURE = 'immutable assets routing completion failed or exceeded its timeout';
const READBACK_DEADLINE = '30 seconds';
const text = (value: string) => new TextEncoder().encode(value);
const json = (value: Schema.Json) => text(JSON.stringify(value));
const file = (path: string, bytes = text('retained release bytes')) => ({ bytes, path });

const applyUnreadyHeaders = (
  headers: Headers,
  policy: { readonly cacheControl?: string; readonly mode: string } | undefined,
): void => {
  const mode = policy?.mode;
  const cacheControl = policy?.cacheControl;
  headers.delete('access-control-allow-origin');
  if (mode === 'empty-cors') {
    headers.set('access-control-allow-origin', '');
  }
  if (mode === ALL_ABSENT_HEADERS) {
    headers.delete('cache-control');
    headers.delete('x-content-type-options');
    if (cacheControl !== undefined) {
      headers.set('cache-control', cacheControl);
    }
  }
};

const planFor = (appId = APP_ID, identity: { readonly buildMarker?: string; readonly sourceRevision?: string } = {}) =>
  deriveImmutableApplicationReleasePlan({
    appId,
    buildMarker: identity.buildMarker ?? BUILD_MARKER,
    sourceRevision: identity.sourceRevision ?? SOURCE_REVISION,
    workersDevSubdomain: WORKERS_SUBDOMAIN,
  });

const backendFor = (plan: Parameters<typeof validateImmutableApplicationReleaseArtifacts>[0]) =>
  Schema.decodeUnknownSync(ImmutableApplicationReleaseReceiptSchema.fields.backend)({
    baseUrl: `https://${plan.backendScriptName}.${WORKERS_SUBDOMAIN}.workers.dev/`,
    transport: 'cloudflare-worker',
    versionId: BACKEND_VERSION_ID,
    workerName: plan.backendScriptName,
  });

const artifactInventory = (
  plan: Pick<
    Parameters<typeof validateImmutableApplicationReleaseArtifacts>[0],
    'appId' | 'assetsOrigin' | 'buildMarker' | 'sourceRevision'
  >,
  pageJsPath = PAGE_JS_PATH,
) => {
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
        id: plan.appId === APP_ID ? 'party.registry' : `fixture.${plan.appId}`,
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
          js: { async: [DETAILS_JS_PATH], sync: [pageJsPath] },
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
      file(pageJsPath),
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
  const plan = yield* planFor(SHELL_APP_ID);
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

const receiptInventory = (plan: Parameters<typeof artifactInventory>[0]) => {
  const inventory = artifactInventory(plan);
  return {
    ...inventory,
    assets: inventory.assets.map((asset) =>
      asset.path === FEDERATION_MANIFEST_PATH
        ? file(
            asset.path,
            json({
              exposes: [],
              metaData: { publicPath: plan.assetsOrigin },
              name: `fixture${plan.appId.replaceAll('-', '')}`,
              remoteEntry: { name: REMOTE_ENTRY_PATH },
              shared: governedSharedSingletonPackages.map((name) => ({
                assets: { css: { async: [], sync: [] }, js: { async: [], sync: [] } },
                name,
                requiredVersion: '1.0.0',
                singleton: true,
              })),
            }),
          )
        : asset,
    ),
  };
};

const receiptFor = (
  appId = APP_ID,
  identity: {
    readonly buildMarker?: string;
    readonly compositionReady?: boolean;
    readonly sourceRevision?: string;
  } = {},
) =>
  Effect.gen(function* retainedReleaseReceipt() {
    const plan = yield* planFor(appId, identity);
    const artifacts = yield* validateImmutableApplicationReleaseArtifacts(
      plan,
      identity.compositionReady === true ? receiptInventory(plan) : artifactInventory(plan),
    );
    return { artifacts, assetsVersionId: ASSETS_VERSION_ID, backend: backendFor(plan), plan };
  });

const unitFor = (id: string): ApplicationReleaseDeploymentUnit => ({
  id,
  packageName: `@app/${id}`,
  path: id === SHELL_APP_ID ? `apps/${id}` : `verticals/${id}`,
  workerName: `ontos-${id}`,
});
const freshSelection = (intent: ApplicationReleaseIntent): ApplicationReleaseSelection => {
  const complete = intent.modules.map(({ appId }) => unitFor(appId));
  return {
    complete,
    fresh: complete,
    removed: [],
    retained: [],
    shell: { mode: 'retained', unit: unitFor(SHELL_APP_ID) },
  };
};
const selectionFor = (
  intent: ApplicationReleaseIntent,
  baseline: ActiveApplicationCompositionSnapshot,
  fresh: readonly string[] = [],
) =>
  selectApplicationReleaseUnits(
    intent,
    [
      ...new Set([
        ...intent.modules.map(({ appId }) => appId),
        ...baseline.composition.modules.map(({ deployment }) => deployment.appId),
        SHELL_APP_ID,
      ]),
    ].map(unitFor),
    fresh.map((id) => ({ id })),
    baseline,
  );

const shellPublicFiles = (plan: Pick<ImmutableNodeReleasePlan, 'assetsOrigin' | 'buildMarker'>) => [
  file(SHELL_RUNTIME_FILE, json(createShellRuntimeContract(plan.buildMarker))),
  file(
    FEDERATION_MANIFEST_PATH,
    json({
      exposes: [],
      metaData: { publicPath: plan.assetsOrigin, remoteEntry: { name: '', path: '', type: 'global' } },
      name: 'shellSuperApp',
      remotes: [],
      shared: governedSharedSingletonPackages.map((name) => ({
        assets: { css: { async: [], sync: [] }, js: { async: [], sync: [] } },
        name,
        requiredVersion: '1.0.0',
        singleton: true,
      })),
    }),
  ),
  file(
    'routes-manifest.json',
    json({ routeAssets: { index: { assets: [`/${PAGE_JS_PATH}`], referenceCssAssets: [`/${PAGE_CSS_PATH}`] } } }),
  ),
  file(PAGE_JS_PATH),
  file(PAGE_CSS_PATH),
];

const baselineFor = (
  receipts: readonly {
    readonly artifacts: {
      readonly contract?: { readonly url: string };
      readonly federationManifest?: { readonly url: string };
    };
    readonly backend: typeof ApplicationCompositionBackendSchema.Type;
    readonly plan: Parameters<typeof receiptInventory>[0];
  }[],
) =>
  Effect.gen(function* receiptBaseline() {
    const plan = yield* planFor(SHELL_APP_ID);
    const shellAssets = shellPublicFiles(plan);
    const shellManifest = shellAssets.find(({ path }) => path === FEDERATION_MANIFEST_PATH);
    const shellRuntime = shellAssets.find(({ path }) => path === SHELL_RUNTIME_FILE);
    if (shellManifest === undefined || shellRuntime === undefined) {
      return yield* Effect.die('Expected actual fixture Shell artifact bytes');
    }
    const modules = [];
    for (const receipt of receipts) {
      const { assets } = receiptInventory(receipt.plan);
      const contract = assets.find(({ path }) => path === CONTRACT_PATH);
      const federationManifest = assets.find(({ path }) => path === FEDERATION_MANIFEST_PATH);
      if (contract === undefined || federationManifest === undefined || receipt.artifacts.contract === undefined) {
        return yield* Effect.die('Expected actual fixture artifact bytes');
      }
      modules.push({
        appId: receipt.plan.appId,
        backend: receipt.backend,
        contract: { bytes: contract.bytes, url: receipt.artifacts.contract.url },
        federationManifest: { bytes: federationManifest.bytes, url: receipt.artifacts.federationManifest?.url ?? '' },
      });
    }
    return yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'stage',
      modules,
      observedAt: yield* DateTime.now,
      shell: {
        federationManifest: {
          bytes: shellManifest.bytes,
          url: `${plan.assetsOrigin}mf-manifest.json`,
        },
        runtimeContract: {
          bytes: shellRuntime.bytes,
          url: `${plan.assetsOrigin}.well-known/ontos-shell-runtime.json`,
        },
      },
      validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
    });
  });

const shellReceiptFor = (identity: { readonly buildMarker: string; readonly sourceRevision: string }) =>
  Effect.gen(function* freshShellReceipt() {
    const plan = yield* planFor(SHELL_APP_ID, identity);
    const artifacts = yield* validateImmutableShellReleaseArtifacts(plan, {
      assets: shellPublicFiles(plan),
    });
    return { artifacts, assetsVersionId: ASSETS_VERSION_ID, plan };
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
  assets: readonly ReleaseFile[],
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
    { logicalPath: supportFiles[1].path, runtime: FEDERATION_ARTIFACT_RUNTIME },
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
        ui: releaseUiFor(plan.appId, plan.buildMarker),
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
      preview_urls: false,
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

it.effect('retains native Modern route filenames in public and backend release inventories', () =>
  Effect.gen(function* nativeRouteInventory() {
    const plan = yield* planFor();
    const pageJsPath = NATIVE_PAGE_JS_PATH;
    const backendPath = 'server/bundles/(lang)/$.mjs';
    const originalInventory = artifactInventory(plan, pageJsPath);
    const inventory = {
      ...originalInventory,
      assets: [...originalInventory.assets, file(NATIVE_ROUTE_TYPES_PATH)],
      backendFiles: [...originalInventory.backendFiles, file(NATIVE_ROUTE_TYPES_PATH)],
    };
    const artifacts = yield* validateImmutableApplicationReleaseArtifacts(plan, {
      ...inventory,
      backendFiles: [...inventory.backendFiles, file(backendPath)],
    });
    const original = yield* validateImmutableApplicationReleaseArtifacts(plan, artifactInventory(plan));
    expect(artifacts.assetsSha256).not.toBe(original.assetsSha256);
    expect(artifacts.workerSha256).not.toBe(original.workerSha256);
    const assetUrl = new URL(`${plan.assetsOrigin}${pageJsPath}`);
    expect(assetUrl.pathname).toBe(`/${pageJsPath}`);
    expect(assetUrl.search).toBe('');
    expect(assetUrl.hash).toBe('');
    const missingNativeAsset = yield* validateImmutableApplicationReleaseArtifacts(plan, {
      ...inventory,
      assets: inventory.assets.filter(({ path }) => path !== pageJsPath),
    }).pipe(Effect.flip);
    expect(missingNativeAsset.message).toBe('Federation manifest references an absent release entrypoint or chunk');
  }),
);

it.effect('rejects unsafe URL paths and duplicate native route filenames in both inventories', () =>
  Effect.gen(function* unsafeNativeRouteInventory() {
    const plan = yield* planFor();
    const pageJsPath = NATIVE_PAGE_JS_PATH;
    const originalInventory = artifactInventory(plan, pageJsPath);
    const inventory = {
      ...originalInventory,
      assets: [...originalInventory.assets, file(NATIVE_ROUTE_TYPES_PATH)],
      backendFiles: [...originalInventory.backendFiles, file(NATIVE_ROUTE_TYPES_PATH)],
    };
    for (const unsafePath of [
      '',
      './chunk.js',
      'nested/./chunk.js',
      'nested/../chunk.js',
      '/absolute.js',
      'nested//chunk.js',
      'nested/chunk.js/',
      String.raw`nested\chunk.js`,
      'nested/%2e%2e/chunk.js',
      'nested%2fchunk.js',
      'nested%5cchunk.js',
      '[lang]/../chunk.js',
      '@mf-types/compiled-types/src/routes/[lang]/../escape.d.ts',
      '[lang]/./chunk.js',
      '/[lang]/chunk.js',
      '[lang]//chunk.js',
      String.raw`[lang]\chunk.js`,
      '[lang]/%2e%2e/chunk.js',
      '%5Blang%5D/chunk.js',
      '[lang]%2fchunk.js',
      NATIVE_ROUTE_TYPES_PATH,
      `${pageJsPath}?secret=1`,
      `${pageJsPath}#fragment`,
      `${pageJsPath}\u0000`,
      `${pageJsPath}\n`,
      pageJsPath,
    ]) {
      const publicFailure = yield* validateImmutableApplicationReleaseArtifacts(plan, {
        ...inventory,
        assets: [...inventory.assets, file(unsafePath)],
      }).pipe(Effect.flip);
      expect(publicFailure.message).toBe('artifact inventory contains an unsafe or duplicate path');
      expect(publicFailure.cause).toEqual({ path: unsafePath });
      const backendFailure = yield* validateImmutableApplicationReleaseArtifacts(plan, {
        ...inventory,
        backendFiles: [...inventory.backendFiles, file(pageJsPath), file(unsafePath)],
      }).pipe(Effect.flip);
      expect(backendFailure.message).toBe('artifact inventory contains an unsafe or duplicate path');
      expect(backendFailure.cause).toEqual({ path: unsafePath });
    }
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
    const candidate = yield* makeImmutableApplicationReleasePublicationCandidate({
      approvedBaseline: yield* approvedShellSnapshot,
      currentSourceRevision: SOURCE_REVISION,
      intent: { modules: [{ appId: plan.appId }] },
      receipts: [
        {
          artifacts,
          assetsVersionId: ASSETS_VERSION_ID,
          backend: backendFor(plan),
          plan,
        },
      ],
      selection: freshSelection({ modules: [{ appId: plan.appId }] }),
    });
    expect(candidate.modules).toEqual([
      {
        appId: plan.appId,
        backend: backendFor(plan),
        contract: artifacts.contract,
        deployment: { appId: plan.appId, buildMarker: plan.buildMarker },
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
      file('page.js.map.gz'),
      file('page.js.map.br'),
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
    const candidate = yield* makeImmutableApplicationReleasePublicationCandidate({
      approvedBaseline: approved,
      currentSourceRevision: SOURCE_REVISION,
      intent: { modules: [{ appId: receipt.plan.appId }] },
      receipts: [receipt],
      selection: freshSelection({ modules: [{ appId: receipt.plan.appId }] }),
    });
    expect(candidate.modules[0]?.contract).toBe(receipt.artifacts.contract);
    expect(candidate.modules[0]?.federationManifest).toBe(receipt.artifacts.federationManifest);
    expect(candidate).toEqual({
      baseline: { retainedModuleAppIds: [], revision: approved.composition.revision, shellMode: 'retained' },
      modules: [
        {
          appId: receipt.plan.appId,
          backend: receipt.backend,
          contract: receipt.artifacts.contract,
          deployment: { appId: receipt.plan.appId, buildMarker: receipt.plan.buildMarker },
          federationManifest: receipt.artifacts.federationManifest,
        },
      ],
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
    const valid = yield* makeImmutableApplicationReleasePublicationCandidate({
      approvedBaseline: approved,
      currentSourceRevision: SOURCE_REVISION,
      intent,
      receipts: [receipt],
      selection: freshSelection(intent),
    });
    expect(valid.modules[0]?.backend).toEqual(receipt.backend);
    const foreignAccount = {
      ...receipt.backend,
      baseUrl: `https://${receipt.plan.backendScriptName}.foreign-account.workers.dev/`,
    };
    for (const backend of [foreignAccount, foreignWorker.backend]) {
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline: approved,
        currentSourceRevision: SOURCE_REVISION,
        intent,
        receipts: [{ ...receipt, backend }],
        selection: freshSelection(intent),
      }).pipe(Effect.flip);
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
      const missing = yield* makeImmutableApplicationReleasePublicationCandidate({
        currentSourceRevision: SOURCE_REVISION,
        intent,
        receipts: [receipt],
        selection: freshSelection(intent),
      }).pipe(Effect.flip);
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
        const failure = yield* makeImmutableApplicationReleasePublicationCandidate({
          approvedBaseline: snapshot,
          currentSourceRevision: SOURCE_REVISION,
          intent,
          receipts: [receipt],
          selection: freshSelection(intent),
        }).pipe(Effect.flip);
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
      const mutable = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline: { ...approved, composition },
        currentSourceRevision: SOURCE_REVISION,
        intent: { modules: [{ appId: receipt.plan.appId }] },
        receipts: [receipt],
        selection: freshSelection({ modules: [{ appId: receipt.plan.appId }] }),
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(mutable)).toBe(true);
      expect(mutable.message).toContain('retained native release assets');
      const missingReceipt = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline: approved,
        currentSourceRevision: SOURCE_REVISION,
        intent: { modules: [{ appId: receipt.plan.appId }] },
        receipts: [],
        selection: freshSelection({ modules: [{ appId: receipt.plan.appId }] }),
      }).pipe(Effect.flip);
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
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline: approved,
        currentSourceRevision: SOURCE_REVISION,
        intent: { modules: [{ appId: receipt.plan.appId }] },
        receipts,
        selection: freshSelection({ modules: [{ appId: receipt.plan.appId }] }),
      }).pipe(Effect.flip);
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
      const failure = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline: approved,
        currentSourceRevision: SOURCE_REVISION,
        intent,
        receipts: [receipt],
        selection: freshSelection(intent),
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const unreviewed = yield* makeImmutableApplicationReleasePublicationCandidate({
      approvedBaseline: approved,
      currentSourceRevision: SOURCE_REVISION,
      intent: { modules: [{ appId: receipt.plan.appId }] },
      receipts: [receipt, otherReceipt],
      selection: freshSelection({ modules: [{ appId: receipt.plan.appId }] }),
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(unreviewed)).toBe(true);
  }),
);

// Scripted unit proof: original receipt pins and bytes, not remote deployment existence.
it.effect(
  'resolves zero one and multiple fresh or retained receipts in reviewed order without rewriting receipt identity',
  () =>
    Effect.gen(function* selectedOriginalReceipts() {
      const oldParty = yield* receiptFor(APP_ID, { compositionReady: true });
      const oldInventory = yield* receiptFor('inventory', { compositionReady: true });
      const approvedBaseline = yield* baselineFor([oldParty, oldInventory]);
      const currentSourceRevision = 'b'.repeat(40);
      const newParty = yield* receiptFor(APP_ID, {
        buildMarker: 'c'.repeat(64),
        compositionReady: true,
        sourceRevision: currentSourceRevision,
      });
      const newInventory = yield* receiptFor('inventory', {
        buildMarker: 'd'.repeat(64),
        compositionReady: true,
        sourceRevision: currentSourceRevision,
      });
      const cases = [
        { expected: [], fresh: [], modules: [], receipts: [] },
        {
          expected: [oldInventory, oldParty],
          fresh: [],
          modules: [{ appId: 'inventory' }, { appId: APP_ID }],
          receipts: [oldParty, oldInventory],
        },
        { expected: [newParty], fresh: [APP_ID], modules: [{ appId: APP_ID }], receipts: [newParty] },
        {
          expected: [newParty, oldInventory],
          fresh: [APP_ID],
          modules: [{ appId: APP_ID }, { appId: 'inventory' }],
          receipts: [oldInventory, newParty],
        },
        {
          expected: [newInventory, newParty],
          fresh: [APP_ID, 'inventory'],
          modules: [{ appId: 'inventory' }, { appId: APP_ID }],
          receipts: [newParty, newInventory],
        },
      ];
      for (const row of cases) {
        const intent = { modules: row.modules };
        const selection = yield* selectionFor(intent, approvedBaseline, row.fresh);
        const resolved = yield* resolveImmutableApplicationReleaseReceipts({
          approvedBaseline,
          currentSourceRevision,
          intent,
          receipts: row.receipts,
          selection,
        });
        expect(resolved).toHaveLength(row.expected.length);
        for (const [index, receipt] of row.expected.entries()) {
          expect(resolved[index]).toBe(receipt);
        }
      }
      expect(oldParty.plan.sourceRevision).toBe(SOURCE_REVISION);
      expect(oldInventory.plan.sourceRevision).toBe(SOURCE_REVISION);
      expect(newParty.plan.sourceRevision).toBe(currentSourceRevision);
    }),
);

it.effect('rejects missing duplicate foreign and stale-fresh receipts without manufacturing replacement receipts', () =>
  Effect.gen(function* rejectsInvalidReceiptMembership() {
    const party = yield* receiptFor(APP_ID, { compositionReady: true });
    const inventory = yield* receiptFor('inventory', { compositionReady: true });
    const foreign = yield* receiptFor('server-module');
    const approvedBaseline = yield* baselineFor([party, inventory]);
    const intent = { modules: [{ appId: APP_ID }, { appId: 'inventory' }] };
    const selection = yield* selectionFor(intent, approvedBaseline);
    for (const receipts of [[party], [party, party], [party, foreign]]) {
      const failure = yield* resolveImmutableApplicationReleaseReceipts({
        approvedBaseline,
        currentSourceRevision: SOURCE_REVISION,
        intent,
        receipts,
        selection,
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const missingBaseline = yield* resolveImmutableApplicationReleaseReceipts({
      currentSourceRevision: SOURCE_REVISION,
      intent,
      receipts: [party, inventory],
      selection,
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(missingBaseline)).toBe(true);
    const fresh = yield* selectionFor(intent, approvedBaseline, [APP_ID]);
    const staleFresh = yield* resolveImmutableApplicationReleaseReceipts({
      approvedBaseline,
      currentSourceRevision: 'b'.repeat(40),
      intent,
      receipts: [party, inventory],
      selection: fresh,
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(staleFresh)).toBe(true);
  }),
);

it.effect('rejects expired baselines and retained marker digest manifest or native backend pin mismatches', () =>
  Effect.gen(function* rejectsRetainedPinDrift() {
    const receipt = yield* receiptFor(APP_ID, { compositionReady: true });
    const approvedBaseline = yield* baselineFor([receipt]);
    const intent = { modules: [{ appId: APP_ID }] };
    const selection = yield* selectionFor(intent, approvedBaseline);
    const manifest = receipt.artifacts.federationManifest;
    if (manifest === undefined) {
      return yield* Effect.die('Expected the actual browser receipt manifest');
    }
    const changedMarker = yield* receiptFor(APP_ID, { buildMarker: 'e'.repeat(64), compositionReady: true });
    const { federationManifest: removedManifest, ...serverArtifacts } = receipt.artifacts;
    expect(removedManifest).toBeDefined();
    const invalid = [
      changedMarker,
      {
        ...receipt,
        artifacts: { ...receipt.artifacts, contract: { ...receipt.artifacts.contract, sha256: 'b'.repeat(64) } },
      },
      {
        ...receipt,
        artifacts: {
          ...receipt.artifacts,
          contract: {
            ...receipt.artifacts.contract,
            url: 'https://mutable.example/.well-known/ontos-module-manifest.json',
          },
        },
      },
      { ...receipt, artifacts: { ...receipt.artifacts, federationManifest: { ...manifest, sha256: 'b'.repeat(64) } } },
      { ...receipt, artifacts: serverArtifacts },
      { ...receipt, backend: { ...receipt.backend, versionId: ASSETS_VERSION_ID } },
    ];
    for (const changed of invalid) {
      const changedReceipt = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseReceiptSchema)(changed);
      const failure = yield* resolveImmutableApplicationReleaseReceipts({
        approvedBaseline,
        currentSourceRevision: SOURCE_REVISION,
        intent,
        receipts: [changedReceipt],
        selection,
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
    const expired = { ...approvedBaseline, observedAt: DateTime.makeUnsafe(-1000), validUntil: DateTime.makeUnsafe(0) };
    const failure = yield* resolveImmutableApplicationReleaseReceipts({
      approvedBaseline: expired,
      currentSourceRevision: SOURCE_REVISION,
      intent,
      receipts: [receipt],
      selection,
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('rejects nonunique incomplete overlapping and removal-inconsistent approved partitions', () =>
  Effect.gen(function* rejectsPartitionDrift() {
    const receipt = yield* receiptFor(APP_ID, { compositionReady: true });
    const removed = yield* receiptFor('inventory', { compositionReady: true });
    const approvedBaseline = yield* baselineFor([receipt, removed]);
    const intent = { modules: [{ appId: APP_ID }] };
    const selection = yield* selectionFor(intent, approvedBaseline);
    const invalid = [
      { ...selection, complete: [...selection.complete, ...selection.complete] },
      { ...selection, retained: [] },
      { ...selection, fresh: selection.complete },
      { ...selection, removed: [] },
      { ...selection, shell: { ...selection.shell, unit: unitFor(APP_ID) } },
    ];
    for (const candidate of invalid) {
      const failure = yield* resolveImmutableApplicationReleaseReceipts({
        approvedBaseline,
        currentSourceRevision: SOURCE_REVISION,
        intent,
        receipts: [receipt],
        selection: candidate,
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    }
  }),
);

it.effect('refuses a Cloudflare receipt as proof for a retained Node backend slot', () =>
  Effect.gen(function* rejectsNodeReceiptGap() {
    const receipt = yield* receiptFor(APP_ID, { compositionReady: true });
    const approved = yield* baselineFor([receipt]);
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema)({
      baseUrl: 'https://private-party.example.com/',
      transport: 'node-http',
    });
    const composition = {
      ...approved.composition,
      modules: approved.composition.modules.map((module) => ({ ...module, backend })),
    };
    const approvedBaseline = {
      ...approved,
      composition: { ...composition, revision: applicationCompositionRevision(composition) },
    };
    const intent = { modules: [{ appId: APP_ID }] };
    const selection = yield* selectionFor(intent, approvedBaseline);
    const failure = yield* resolveImmutableApplicationReleaseReceipts({
      approvedBaseline,
      currentSourceRevision: SOURCE_REVISION,
      intent,
      receipts: [receipt],
      selection,
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
    expect(failure.message).toContain('Node');
  }),
);

it.effect(
  'accepts a fresh genuine Shell receipt alongside retained business receipts from the same approved baseline',
  () =>
    Effect.gen(function* freshShellWithRetainedBusiness() {
      const receipt = yield* receiptFor(APP_ID, { compositionReady: true });
      const approvedBaseline = yield* baselineFor([receipt]);
      const currentSourceRevision = 'b'.repeat(40);
      const shellReceipt = yield* shellReceiptFor({
        buildMarker: 'c'.repeat(64),
        sourceRevision: currentSourceRevision,
      });
      const intent = { modules: [{ appId: APP_ID }] };
      const selection = yield* selectionFor(intent, approvedBaseline, [SHELL_APP_ID]);
      const candidate = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline,
        currentSourceRevision,
        intent,
        receipts: [receipt],
        selection,
        shellReceipt,
      });
      expect(candidate.modules[0]?.backend).toEqual(receipt.backend);
      expect(candidate.shell.deployment.buildMarker).toBe(shellReceipt.plan.buildMarker);
      expect(candidate.baseline).toEqual({
        retainedModuleAppIds: [APP_ID],
        revision: approvedBaseline.composition.revision,
        shellMode: 'fresh',
      });
      expect(receipt.plan.sourceRevision).toBe(SOURCE_REVISION);
      const oldShell = yield* shellReceiptFor({ buildMarker: BUILD_MARKER, sourceRevision: SOURCE_REVISION });
      const staleShell = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline,
        currentSourceRevision,
        intent,
        receipts: [receipt],
        selection,
        shellReceipt: oldShell,
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(staleShell)).toBe(true);
      const retainedSelection = yield* selectionFor(intent, approvedBaseline);
      const unusedShell = yield* makeImmutableApplicationReleasePublicationCandidate({
        approvedBaseline,
        currentSourceRevision,
        intent,
        receipts: [receipt],
        selection: retainedSelection,
        shellReceipt,
      }).pipe(Effect.flip);
      expect(Schema.is(ImmutableApplicationReleaseError)(unusedShell)).toBe(true);
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
        nodePath.join(appDirectory, PACKAGE_FILE),
        JSON.stringify({ devDependencies: { wrangler: WRANGLER_VERSION } }),
      );

      const requests: { readonly method: string; readonly url: string }[] = [];
      const commands: OpsCommand[] = [];
      const client = HttpClient.make((request, destination) => {
        if (destination.pathname.endsWith(WORKERS_SUBDOMAIN_PATH)) {
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
            if (command.args.join(' ') === WRANGLER_VERSION_COMMAND) {
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
    readonly additionalPublicFiles?: readonly ReleaseFile[];
    readonly assetDeploymentPercentage?: number;
    readonly assetHeaderReadiness?: {
      readonly attempts: 'always' | 'once';
      readonly cacheControl?: string;
      readonly mode: 'all-absent' | 'cors-absent' | 'empty-cors';
      readonly path: string;
      readonly stallBody?: boolean;
    };
    readonly assetHeaders?: Readonly<Record<string, string>>;
    readonly assetsDeploymentVersions?: readonly { readonly percentage: number; readonly version_id: string }[];
    readonly assetsSubdomainAcknowledgement?: {
      readonly enabled: boolean;
      readonly previews_enabled: boolean;
      readonly success: boolean;
    };
    readonly assetStatus?: number;
    readonly assetsUploadCommand?: string;
    readonly assetsUploadError?: { readonly providerCode: number; readonly providerPath?: string };
    readonly backendDeploymentVersions?: readonly { readonly percentage: number; readonly version_id: string }[];
    readonly backendSubdomainEnabled?: boolean;
    readonly backendSubdomainStatus?: number;
    readonly backendSubdomainSuccess?: boolean;
    readonly changedSource?: boolean;
    readonly deployedEntrypoint?: string | false;
    readonly envelopeUnitId?: string;
    readonly initialAssetNotFound?: boolean;
    readonly initialSource?: string;
    readonly noBundle?: boolean;
    readonly omitBackendSubdomainEnabled?: boolean;
    readonly omitEnvelope?: boolean;
    readonly overflowingAssetStream?: 'always' | 'once';
    readonly oversizedAssetBody?: boolean;
    readonly ownerSecrets?: Readonly<Record<string, string>>;
    readonly pageJsPath?: string;
    readonly recoveryWorkerName?: string;
    readonly recoveryWorkerStatuses?: readonly number[];
    readonly resolvedWranglerVersion?: string;
    readonly secretStatus?: number;
    readonly secretSuccess?: boolean;
    readonly stallAssetBody?: boolean;
    readonly tamperWorkerAfterEnvelope?: boolean;
    readonly tamperWorkerDuringPackaging?: boolean;
    readonly unboundFile?: boolean;
    readonly unboundFileDuringPackaging?: boolean;
    readonly wrongAssetBytes?: boolean | 'once';
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const appDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-release-deploy-' });
  const output = nodePath.join(appDirectory, '.output');
  const publicDirectory = nodePath.join(output, 'public');
  const plan = yield* planFor();
  const inventory = artifactInventory(plan, options.pageJsPath);
  const nativeAssets = [...inventory.assets, ...(options.additionalPublicFiles ?? [])];
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
  for (const { bytes, path: assetPath } of nativeAssets) {
    const destination = nodePath.join(publicDirectory, assetPath);
    yield* fileSystem.makeDirectory(nodePath.dirname(destination), { recursive: true });
    yield* fileSystem.writeFile(destination, bytes);
  }
  const originalHeaders = '/*\n  Cache-Control: no-cache\n';
  yield* fileSystem.writeFileString(nodePath.join(publicDirectory, '_headers'), originalHeaders);
  yield* fileSystem.writeFileString(
    nodePath.join(appDirectory, PACKAGE_FILE),
    JSON.stringify({ devDependencies: { wrangler: WRANGLER_VERSION } }),
  );
  if (options.omitEnvelope !== true) {
    yield* writeNativeEnvelope(output, plan, nativeAssets, options.envelopeUnitId);
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
  const assetNotFoundStarted = yield* Deferred.make<boolean>();
  const assetHeadersNotReadyStarted = yield* Deferred.make<boolean>();
  const assetAttempts = new Map<string, number>();
  const assetBodyEvents: string[] = [];
  const recoveryWorkerReadStarted = yield* Deferred.make<boolean>();
  const recoveryWorkerPath = `/accounts/${'a'.repeat(32)}/workers/workers/${plan.assetsScriptName}`;
  let recoveryWorkerReads = 0;
  const notFoundBodies: Response[] = [];
  const headerReadinessBodies: Response[] = [];
  const commands: OpsCommand[] = [];
  const capturedConfigs: Readonly<Record<string, Schema.Json>>[] = [];
  const publishedInventories: (readonly ReleaseFile[])[] = [];
  const requests: string[] = [];
  const providerWrites: { readonly method: string; readonly url: string }[] = [];
  let canceledAssetBodies = 0;
  let checkedSource = 0;
  let absentChecks = 0;
  const providerResponse = (destination: URL) =>
    Match.value(destination.pathname).pipe(
      Match.when(`/client/v4${recoveryWorkerPath}`, () =>
        Effect.gen(function* uploadedAssetsWorkerObservation() {
          const status =
            options.recoveryWorkerStatuses?.[recoveryWorkerReads] ?? options.recoveryWorkerStatuses?.at(-1) ?? 200;
          recoveryWorkerReads += 1;
          yield* Deferred.succeed(recoveryWorkerReadStarted, true);
          return Response.json(
            status === 404
              ? { errors: [{ code: 10_007, message: 'Worker is still propagating' }], result: null, success: false }
              : { result: { name: options.recoveryWorkerName ?? plan.assetsScriptName }, success: true },
            { status },
          );
        }),
      ),
      Match.when(
        (path) => path.endsWith(`/workers/scripts/${plan.assetsScriptName}/subdomain`),
        () =>
          Effect.sync(() => {
            const acknowledgement = options.assetsSubdomainAcknowledgement ?? {
              enabled: true,
              previews_enabled: false,
              success: true,
            };
            return Response.json({
              result: { enabled: acknowledgement.enabled, previews_enabled: acknowledgement.previews_enabled },
              success: acknowledgement.success,
            });
          }),
      ),
      Match.when(
        (path) => path.endsWith(WORKERS_SUBDOMAIN_PATH),
        () =>
          Effect.sync(() =>
            Response.json({
              result: { subdomain: options.accountSubdomain ?? WORKERS_SUBDOMAIN },
              success: true,
            }),
          ),
      ),
      Match.when(
        (path) => path.endsWith(`/workers/scripts/${plan.backendScriptName}/subdomain`),
        () =>
          Effect.sync(() =>
            Response.json(
              {
                result:
                  options.omitBackendSubdomainEnabled === true
                    ? {}
                    : { enabled: options.backendSubdomainEnabled ?? true },
                success: options.backendSubdomainSuccess ?? true,
              },
              { status: options.backendSubdomainStatus ?? 200 },
            ),
          ),
      ),
      Match.when(
        (path) => path.endsWith('/content/v2'),
        () =>
          Effect.sync(() => {
            const content = new FormData();
            for (const module of capturedModules) {
              content.append(module.path, new File([module.bytes], module.path));
            }
            return new Response(content, {
              headers:
                options.deployedEntrypoint === false
                  ? {}
                  : { 'cf-entrypoint': options.deployedEntrypoint ?? capturedMain },
            });
          }),
      ),
      Match.when(
        (path) => path.endsWith(`/workers/scripts/${plan.backendScriptName}/deployments`),
        () =>
          Effect.sync(() =>
            Response.json({
              result: {
                deployments: [
                  {
                    versions: options.backendDeploymentVersions ?? [
                      { percentage: 100, version_id: BACKEND_VERSION_ID },
                    ],
                  },
                ],
              },
              success: true,
            }),
          ),
      ),
      Match.when(
        (path) => path.endsWith(NATIVE_DEPLOYMENTS_PATH),
        () =>
          Effect.sync(() =>
            Response.json({
              result: {
                deployments: [
                  {
                    versions: options.assetsDeploymentVersions ?? [
                      { percentage: options.assetDeploymentPercentage ?? 100, version_id: ASSETS_VERSION_ID },
                    ],
                  },
                ],
              },
              success: true,
            }),
          ),
      ),
      Match.when(
        (path) => path.endsWith('/secrets'),
        () =>
          Effect.sync(() =>
            Response.json(
              { result: { name: 'OWNER_BINDING', type: 'secret_text' }, success: options.secretSuccess ?? true },
              { status: options.secretStatus ?? 200 },
            ),
          ),
      ),
      Match.orElse(() =>
        Effect.sync(() => {
          const status = absentChecks < 2 ? 404 : 200;
          absentChecks += 1;
          return new Response(null, { status });
        }),
      ),
    );
  const client = HttpClient.make((request, destination) =>
    Effect.gen(function* retainedProviderResponse() {
      requests.push(destination.href);
      if (request.method !== 'GET') {
        providerWrites.push({ method: request.method, url: destination.href });
      }
      let response: Response;
      if (destination.hostname === 'api.cloudflare.com') {
        response = yield* providerResponse(destination);
      } else {
        assetBodyEvents.push(`get:${destination.href}`);
        yield* Deferred.succeed(assetReadStarted, true);
        if (/%28|%29/u.test(destination.pathname)) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              headers: { location: destination.pathname.replaceAll('%28', '(').replaceAll('%29', ')') },
              status: 307,
            }),
          );
        }
        const asset = nativeAssets.find(({ path }) => decodeURIComponent(destination.pathname) === `/${path}`);
        const attempt = (assetAttempts.get(destination.href) ?? 0) + 1;
        assetAttempts.set(destination.href, attempt);
        const status =
          asset === undefined ||
          (options.initialAssetNotFound === true && asset.path === CONTRACT_PATH && attempt === 1)
            ? 404
            : (options.assetStatus ?? 200);
        const corruptBytes = Match.value(options.wrongAssetBytes).pipe(
          Match.when(true, () => true),
          Match.when('once', () => attempt === 1 && asset?.path === CONTRACT_PATH),
          Match.orElse(() => false),
        );
        const overflowStream = Match.value(options.overflowingAssetStream).pipe(
          Match.when('always', () => true),
          Match.when('once', () => attempt === 1 && asset?.path === CONTRACT_PATH),
          Match.orElse(() => false),
        );
        const compiledByteLength = asset?.bytes.byteLength ?? 0;
        const cancelStalledBody = () => {
          canceledAssetBodies += 1;
        };
        const cancelOverflowingBody = () => {
          canceledAssetBodies += 1;
          assetBodyEvents.push(`cancel:${destination.href}`);
        };
        const startOverflowingBody = (controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.enqueue(new Uint8Array(compiledByteLength + 1));
        };
        let body = Match.value(options).pipe(
          Match.when({ stallAssetBody: true }, () => new ReadableStream<Uint8Array>({ cancel: cancelStalledBody })),
          Match.when({ oversizedAssetBody: true }, () => new Uint8Array(compiledByteLength + 1).buffer),
          Match.when(
            () => overflowStream,
            () => new ReadableStream<Uint8Array>({ cancel: cancelOverflowingBody, start: startOverflowingBody }),
          ),
          Match.when(
            () => corruptBytes,
            () => new Uint8Array(compiledByteLength).buffer,
          ),
          Match.orElse(() => new Uint8Array(asset?.bytes ?? []).buffer),
        );
        if (status === 404) {
          body = new ReadableStream<Uint8Array>({
            cancel: () => {
              canceledAssetBodies += 1;
            },
            start: (controller) => {
              controller.enqueue(new Uint8Array((asset?.bytes.byteLength ?? 0) + 1));
              controller.close();
            },
          });
        }
        const headers = new Headers({
          'access-control-allow-origin': '*',
          'cache-control': IMMUTABLE_CACHE_HEADER,
          'x-content-type-options': 'nosniff',
          ...options.assetHeaders,
        });
        const unreadyHeaders = Match.value(options.assetHeaderReadiness).pipe(
          Match.when(
            Match.defined,
            (policy) => policy.path === asset?.path && (policy.attempts === 'always' || attempt === 1),
          ),
          Match.orElse(() => false),
        );
        if (unreadyHeaders) {
          applyUnreadyHeaders(headers, options.assetHeaderReadiness);
          if (options.assetHeaderReadiness?.mode === ALL_ABSENT_HEADERS) {
            const startUnreadyBody = (controller: ReadableStreamDefaultController<Uint8Array>) => {
              controller.enqueue(text('controlled native default robots response'));
            };
            body = Match.value(options.assetHeaderReadiness.stallBody).pipe(
              Match.when(
                true,
                () => new ReadableStream<Uint8Array>({ cancel: cancelStalledBody, start: startUnreadyBody }),
              ),
              Match.orElse(() => new Uint8Array(text('controlled native default robots response')).buffer),
            );
          }
        }
        if (status === 307) {
          headers.set('location', `${plan.assetsOrigin}${PAGE_JS_PATH}`);
        }
        response = new Response(body, { headers, status });
        if (unreadyHeaders) {
          headerReadinessBodies.push(response);
          yield* Deferred.succeed(assetHeadersNotReadyStarted, true);
        }
        if (status === 404) {
          notFoundBodies.push(response);
          yield* Deferred.succeed(assetNotFoundStarted, true);
        }
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
        if (command.args.join(' ') === WRANGLER_VERSION_COMMAND) {
          return options.resolvedWranglerVersion ?? WRANGLER_VERSION;
        }
        commands.push(command);
        const config = command.args[command.args.indexOf('--config') + 1];
        if (config === undefined) {
          return yield* Effect.die('a native release command must identify its Wrangler config');
        }
        const capturedConfig = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
        )(yield* fileSystem.readFileString(config));
        capturedConfigs.push(capturedConfig);
        const assetsConfig = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ assets: Schema.Struct({ directory: Schema.String }) }),
        )(capturedConfig);
        publishedInventories.push(yield* readReleaseFiles(assetsConfig.assets.directory));
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
        if (capturedConfig.name === plan.assetsScriptName && options.assetsUploadError !== undefined) {
          return yield* Effect.fail({
            providerCode: options.assetsUploadError.providerCode,
            providerPath: options.assetsUploadError.providerPath ?? recoveryWorkerPath,
          });
        }
        return '';
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(
          (cause) =>
            new OpsCommandError({
              cause,
              command: options.assetsUploadCommand ?? [command.command, ...command.args].join(' '),
              message: 'native test packaging failed',
            }),
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
    assetBodyEvents,
    assetHeadersNotReadyStarted,
    assetNotFoundStarted,
    assetReadStarted,
    canceledAssetBodies: () => canceledAssetBodies,
    capturedConfigs,
    commands,
    deploy: deployImmutableApplicationRelease({ appDirectory, plan }).pipe(Effect.provide(layer)),
    headerReadinessBodies,
    notFoundBodies,
    originalHeaders,
    output,
    plan,
    providerWrites,
    publicDirectory,
    publishedInventories,
    recoveryWorkerPath,
    recoveryWorkerReadStarted,
    requests,
  };
});

it.effect('publishes native route chunks without exposing compiler source maps or changing the compiled output', () =>
  Effect.scoped(
    Effect.gen(function* nativePublicPartition() {
      const nativePage = NATIVE_PAGE_JS_PATH;
      const encodedNativePage = 'static/js/async/(lang)/%24.e213690cdf.js';
      const nativeTypes = file('@mf-types/Route.d.ts', text('export declare const route: string;'));
      const nativeRouteDeclarations = [
        file(NATIVE_ROUTE_TYPES_PATH, text('export declare const ContactsPage: () => unknown;')),
        file(NATIVE_ROUTE_META_TYPES_PATH, text('export declare const routeMeta: { title: string };')),
      ];
      const maps = ['.map', '.map.gz', '.map.br'].map((suffix) => file(`${nativePage}${suffix}`));
      const fixture = yield* prepareDeployment({
        additionalPublicFiles: [...maps, nativeTypes, ...nativeRouteDeclarations],
        pageJsPath: nativePage,
      });
      const before = yield* readReleaseFiles(fixture.output);
      const receipt = yield* fixture.deploy;
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(fixture.publishedInventories).toHaveLength(3);
      for (const published of fixture.publishedInventories) {
        expect(published.some(({ path }) => path === nativePage)).toBe(true);
        expect(published).toContainEqual(nativeTypes);
        for (const declaration of nativeRouteDeclarations) {
          expect([...(published.find(({ path }) => path === declaration.path)?.bytes ?? [])]).toEqual([
            ...declaration.bytes,
          ]);
        }
        for (const map of maps) {
          expect(published.some(({ path }) => path === map.path)).toBe(false);
        }
      }
      expect(fixture.requests).toContain(`${fixture.plan.assetsOrigin}${encodedNativePage}`);
      expect(fixture.requests).toContain(`${fixture.plan.assetsOrigin}%40mf-types/Route.d.ts`);
      expect(fixture.requests).toContain(
        `${fixture.plan.assetsOrigin}%40mf-types/compiled-types/src/routes/%5Blang%5D/contacts/page.d.ts`,
      );
      expect(fixture.requests).toContain(
        `${fixture.plan.assetsOrigin}%40mf-types/compiled-types/src/routes/%5Blang%5D/contacts/route.meta.d.ts`,
      );
      for (const declaration of nativeRouteDeclarations) {
        expect(fixture.requests).not.toContain(`${fixture.plan.assetsOrigin}${declaration.path}`);
      }
      expect(fixture.requests.some((url) => url.includes('%28') || url.includes('%29'))).toBe(false);
      expect(fixture.requests).not.toContain(`${fixture.plan.assetsOrigin}${nativePage}`);
      expect(fixture.requests).not.toContain(`${fixture.plan.assetsOrigin}${nativeTypes.path}`);
      for (const map of maps) {
        expect(fixture.requests).not.toContain(`${fixture.plan.assetsOrigin}${map.path}`);
        expect(fixture.requests).not.toContain(
          `${fixture.plan.assetsOrigin}${encodedNativePage}${map.path.slice(nativePage.length)}`,
        );
      }
      expect(yield* readReleaseFiles(fixture.output)).toEqual(before);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses native public private files before provider access while partitioning compiler maps', () =>
  Effect.scoped(
    Effect.gen(function* nativePrivateFileRefusal() {
      const fixture = yield* prepareDeployment({
        additionalPublicFiles: [file('page.js.map.br'), file('credentials.json')],
      });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe('public release assets contain private runtime files or sourcemaps');
      expect(fixture.commands).toEqual([]);
      expect(fixture.requests).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('publishes the complete captured native package and leaves compiled assets unchanged', () =>
  Effect.scoped(
    Effect.gen(function* completeNativeUpload() {
      const fixture = yield* prepareDeployment({ ownerSecrets: { OWNER_BINDING: OWNER_SECRET_VALUE } });
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
      expect(fixture.capturedConfigs[2]?.name).toBe(fixture.plan.assetsScriptName);
      expect(fixture.capturedConfigs[2]?.preview_urls).toBe(false);
      expect(fixture.capturedConfigs[2]?.workers_dev).toBe(true);
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

it.effect('accepts a successful 201 secret creation before publishing retained module assets', () =>
  Effect.scoped(
    Effect.gen(function* createdOwnerSecret() {
      const fixture = yield* prepareDeployment({
        ownerSecrets: { OWNER_BINDING: OWNER_SECRET_VALUE },
        secretStatus: 201,
      });
      const receipt = yield* fixture.deploy;
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(receipt.backend.versionId).toBe(BACKEND_VERSION_ID);
      expect(fixture.commands).toHaveLength(3);
      expect(fixture.providerWrites).toEqual([
        {
          method: 'PUT',
          url: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${fixture.plan.backendScriptName}/secrets`,
        },
      ]);
      expect(fixture.requests).toContain(`${fixture.plan.assetsOrigin}mf-manifest.json`);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const response of [
  { secretStatus: 201, secretSuccess: false },
  { secretStatus: 403, secretSuccess: true },
  { secretStatus: 403, secretSuccess: false },
]) {
  it.effect(
    `refuses secret HTTP ${response.secretStatus} success=${response.secretSuccess} before publishing module assets`,
    () =>
      Effect.scoped(
        Effect.gen(function* refusedOwnerSecret() {
          const fixture = yield* prepareDeployment({
            ...response,
            ownerSecrets: { OWNER_BINDING: OWNER_SECRET_VALUE },
          });
          const failure = yield* fixture.deploy.pipe(Effect.flip);
          expect(Schema.is(ImmutableApplicationReleaseError)(failure)).toBe(true);
          expect(failure.message).toMatch(/secret/u);
          expect(fixture.providerWrites).toHaveLength(1);
          expect(fixture.providerWrites[0]?.method).toBe('PUT');
          expect(fixture.providerWrites[0]?.url).toMatch(/\/secrets$/u);
          expect(fixture.commands).toHaveLength(2);
          expect(fixture.requests.some((url) => url.startsWith(fixture.plan.assetsOrigin))).toBe(false);
          expect(
            fixture.requests.some((url) =>
              url.endsWith(`/workers/scripts/${fixture.plan.assetsScriptName}/deployments`),
            ),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

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
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
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

it.effect('bounds persistent oversized asset retries and preserves the first crossing byte count', () =>
  Effect.scoped(
    Effect.gen(function* oversizedPublicArtifact() {
      const fixture = yield* prepareDeployment({ overflowingAssetStream: 'always' });
      const fileSystem = yield* FileSystem.FileSystem;
      const expectedBytes = (yield* fileSystem.readFile(nodePath.join(fixture.publicDirectory, CONTRACT_PATH)))
        .byteLength;
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.assetReadStarted);
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
      expect(cause.message).toBe('the deployed asset body exceeds its compiled artifact byte length');
      expect(cause.cause).toEqual({
        contentEncoding: null,
        contentType: null,
        expectedBytes,
        observedBytes: expectedBytes + 1,
        path: CONTRACT_PATH,
        status: 200,
      });
      const attempts = fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`);
      expect(attempts.length).toBeGreaterThan(1);
      expect(attempts.length).toBeLessThanOrEqual(31);
      expect(fixture.canceledAssetBodies()).toBeGreaterThan(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('reports a nonretryable retained asset HTTP status before reading an oversized error response body', () =>
  Effect.scoped(
    Effect.gen(function* oversizedNotFoundBody() {
      const fixture = yield* prepareDeployment({ assetStatus: 403, oversizedAssetBody: true });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
      expect(cause.message).toBe('the deployed immutable public asset did not return HTTP 200');
      expect(cause.cause).toEqual({ path: CONTRACT_PATH, status: 403 });
      expect(fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('retries a transient 404 at the exact retained module URL and accepts only its compiled bytes', () =>
  Effect.scoped(
    Effect.gen(function* transientPublicArtifact() {
      const fixture = yield* prepareDeployment({ initialAssetNotFound: true });
      const fiber = yield* fixture.deploy.pipe(Effect.forkChild);
      yield* Deferred.await(fixture.assetNotFoundStarted);
      expect(fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`)).toHaveLength(1);
      yield* TestClock.adjust('1 second');
      const receipt = yield* Fiber.join(fiber);
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`)).toHaveLength(2);
      expect(fixture.notFoundBodies).toHaveLength(1);
      expect(fixture.notFoundBodies.every((response) => response.bodyUsed)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('bounds persistent retained module 404 retries by the existing overall readback deadline', () =>
  Effect.scoped(
    Effect.gen(function* persistentPublicArtifactNotFound() {
      const fixture = yield* prepareDeployment({ assetStatus: 404 });
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.assetNotFoundStarted);
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      const attempts = fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`);
      expect(attempts.length).toBeGreaterThan(1);
      expect(attempts.length).toBeLessThanOrEqual(31);
      expect(fixture.notFoundBodies.every((response) => response.bodyUsed)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('bounds persistent corrupt 200 retained module bytes by the overall readback deadline', () =>
  Effect.scoped(
    Effect.gen(function* corruptPublicArtifact() {
      const fixture = yield* prepareDeployment({ wrongAssetBytes: true });
      const fileSystem = yield* FileSystem.FileSystem;
      const expectedBytes = (yield* fileSystem.readFile(nodePath.join(fixture.publicDirectory, CONTRACT_PATH)))
        .byteLength;
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.assetReadStarted);
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
      expect(cause.message).toBe(
        'the deployed immutable public release does not serve the exact compiled asset inventory',
      );
      expect(cause.cause).toEqual({
        contentEncoding: null,
        contentType: null,
        expectedBytes,
        observedBytes: expectedBytes,
        path: CONTRACT_PATH,
        status: 200,
      });
      const attempts = fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`);
      expect(attempts.length).toBeGreaterThan(1);
      expect(attempts.length).toBeLessThanOrEqual(31);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses a retained module redirect immediately without following or retrying it', () =>
  Effect.scoped(
    Effect.gen(function* redirectedPublicArtifact() {
      const fixture = yield* prepareDeployment({ assetStatus: 307 });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
      expect(cause.message).toBe('the deployed immutable public asset did not return HTTP 200');
      expect(cause.cause).toEqual({ path: CONTRACT_PATH, status: 307 });
      expect(fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('retries corrupt 200 bytes at the same pinned module URL until its exact compiled bytes arrive', () =>
  Effect.scoped(
    Effect.gen(function* transientCorruptPublicArtifact() {
      const fixture = yield* prepareDeployment({ wrongAssetBytes: 'once' });
      const fiber = yield* fixture.deploy.pipe(Effect.forkChild);
      yield* Deferred.await(fixture.assetReadStarted);
      const assetUrl = `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`;
      expect(fixture.requests.filter((url) => url === assetUrl)).toHaveLength(1);
      yield* TestClock.adjust('1 second');
      const receipt = yield* Fiber.join(fiber);
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(fixture.requests.filter((url) => url === assetUrl)).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('cancels an oversized open response before retrying its exact pinned module URL', () =>
  Effect.scoped(
    Effect.gen(function* canceledOversizedPublicArtifact() {
      const fixture = yield* prepareDeployment({ overflowingAssetStream: 'once' });
      const fiber = yield* fixture.deploy.pipe(Effect.forkChild);
      yield* Deferred.await(fixture.assetReadStarted);
      const assetUrl = `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`;
      yield* TestClock.adjust('1 second');
      const receipt = yield* Fiber.join(fiber);
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(fixture.requests.filter((url) => url === assetUrl)).toHaveLength(2);
      expect(fixture.assetBodyEvents.filter((event) => event.endsWith(assetUrl))).toEqual([
        `get:${assetUrl}`,
        `cancel:${assetUrl}`,
        `get:${assetUrl}`,
      ]);
      expect(fixture.canceledAssetBodies()).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const invalidAssetHeaders: readonly Readonly<Record<string, string>>[] = [
  { 'access-control-allow-origin': 'https://foreign.example' },
  { 'cache-control': 'public, max-age=0' },
  { 'x-content-type-options': 'unsafe' },
];

const compiledRobots = file(ROBOTS_PATH, text('User-agent: *\nDisallow:\n'));

it.effect(
  'retries an unowned root robots response until the same pinned URL serves compiled bytes and all delivery headers',
  () =>
    Effect.scoped(
      Effect.gen(function* transientRootRobotsReadiness() {
        const fixture = yield* prepareDeployment({
          additionalPublicFiles: [compiledRobots],
          assetHeaderReadiness: {
            attempts: 'once',
            cacheControl: 'max-age=0',
            mode: ALL_ABSENT_HEADERS,
            path: ROBOTS_PATH,
          },
        });
        const fiber = yield* fixture.deploy.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.assetHeadersNotReadyStarted);
        const assetUrl = `${fixture.plan.assetsOrigin}${ROBOTS_PATH}`;
        expect(fixture.requests.filter((url) => url === assetUrl)).toHaveLength(1);
        yield* TestClock.adjust('1 second');
        const receipt = yield* Fiber.join(fiber);
        expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
        expect(fixture.requests.filter((url) => url === assetUrl)).toHaveLength(2);
        expect(fixture.headerReadinessBodies).toHaveLength(1);
        expect(fixture.headerReadinessBodies.every((response) => response.bodyUsed)).toBe(true);
        for (const published of fixture.publishedInventories) {
          expect([...(published.find(({ path }) => path === ROBOTS_PATH)?.bytes ?? [])]).toEqual([
            ...compiledRobots.bytes,
          ]);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'bounds persistent unowned root robots responses by the overall deadline and retains safe presence metadata',
  () =>
    Effect.scoped(
      Effect.gen(function* persistentRootRobotsReadiness() {
        const fixture = yield* prepareDeployment({
          additionalPublicFiles: [compiledRobots],
          assetHeaderReadiness: { attempts: 'always', mode: ALL_ABSENT_HEADERS, path: ROBOTS_PATH },
        });
        const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(fixture.assetHeadersNotReadyStarted);
        yield* TestClock.adjust(READBACK_DEADLINE);
        const failure = yield* Fiber.join(fiber);
        expect(failure.message).toBe(ASSET_READBACK_FAILURE);
        const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
        expect(cause.cause).toEqual({
          hasCacheHeader: false,
          hasCorsHeader: false,
          hasImmutableCache: false,
          hasNoSniff: false,
          hasNoSniffHeader: false,
          hasPublicCors: false,
          path: ROBOTS_PATH,
          status: 200,
        });
        const attempts = fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${ROBOTS_PATH}`);
        expect(attempts.length).toBeGreaterThan(1);
        expect(attempts.length).toBeLessThanOrEqual(31);
        expect(fixture.headerReadinessBodies.every((response) => response.bodyUsed)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('cancels a stalled unowned root robots body at the overall deadline without a second GET', () =>
  Effect.scoped(
    Effect.gen(function* stalledRootRobotsReadiness() {
      const fixture = yield* prepareDeployment({
        additionalPublicFiles: [compiledRobots],
        assetHeaderReadiness: { attempts: 'always', mode: ALL_ABSENT_HEADERS, path: ROBOTS_PATH, stallBody: true },
      });
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.assetHeadersNotReadyStarted);
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
      expect(cause.cause).toMatchObject({
        hasCacheHeader: false,
        hasCorsHeader: false,
        hasNoSniffHeader: false,
        path: ROBOTS_PATH,
        status: 200,
      });
      expect(fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${ROBOTS_PATH}`)).toHaveLength(1);
      expect(fixture.headerReadinessBodies).toHaveLength(1);
      expect(fixture.canceledAssetBodies()).toBeGreaterThan(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const invalidHeaderStates: readonly {
  readonly mode: 'all-absent' | 'cors-absent' | 'empty-cors';
  readonly path: string;
}[] = [
  { mode: 'cors-absent', path: ROBOTS_PATH },
  { mode: 'empty-cors', path: ROBOTS_PATH },
  { mode: ALL_ABSENT_HEADERS, path: CONTRACT_PATH },
];
for (const state of invalidHeaderStates) {
  it.effect(
    `bounds invalid root robots headers and refuses other asset headers immediately ${JSON.stringify(state)}`,
    () =>
      Effect.scoped(
        Effect.gen(function* nonretryableRootRobotsHeaders() {
          const fixture = yield* prepareDeployment({
            additionalPublicFiles: [compiledRobots],
            assetHeaderReadiness: { ...state, attempts: 'always' },
          });
          const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
          if (state.path === ROBOTS_PATH) {
            yield* Deferred.await(fixture.assetHeadersNotReadyStarted);
            yield* TestClock.adjust(READBACK_DEADLINE);
          }
          const failure = yield* Fiber.join(fiber);
          expect(failure.message).toBe(ASSET_READBACK_FAILURE);
          const cause = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseError)(failure.cause);
          expect(cause.cause).toMatchObject({ hasPublicCors: false, path: state.path, status: 200 });
          const attempts = fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${state.path}`);
          if (state.path === ROBOTS_PATH) {
            expect(attempts.length).toBeGreaterThan(1);
            expect(attempts.length).toBeLessThanOrEqual(31);
          } else {
            expect(attempts).toHaveLength(1);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const assetHeaders of invalidAssetHeaders) {
  it.effect(`refuses invalid retained module headers without retrying ${JSON.stringify(assetHeaders)}`, () =>
    Effect.scoped(
      Effect.gen(function* invalidRetainedPublicHeaders() {
        const fixture = yield* prepareDeployment({ assetHeaders, wrongAssetBytes: true });
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        expect(failure.message).toBe(ASSET_READBACK_FAILURE);
        expect(fixture.requests.filter((url) => url === `${fixture.plan.assetsOrigin}${CONTRACT_PATH}`)).toHaveLength(
          1,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

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

it.effect('completes the exact uploaded assets Worker routing without uploading its native artifact again', () =>
  Effect.scoped(
    Effect.gen(function* partialAssetsUpload() {
      const fixture = yield* prepareDeployment({
        assetsUploadError: { providerCode: 10_007 },
        recoveryWorkerStatuses: [404, 200],
      });
      const fiber = yield* fixture.deploy.pipe(Effect.forkChild);
      yield* Deferred.await(fixture.recoveryWorkerReadStarted);
      const workerUrl = `https://api.cloudflare.com/client/v4${fixture.recoveryWorkerPath}`;
      expect(fixture.requests.filter((url) => url === workerUrl)).toHaveLength(1);
      yield* TestClock.adjust('1 second');
      const receipt = yield* Fiber.join(fiber);
      expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
      expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
      expect(fixture.commands).toHaveLength(3);
      expect(fixture.requests.filter((url) => url === workerUrl)).toHaveLength(2);
      expect(fixture.providerWrites).toEqual([
        {
          method: 'POST',
          url: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${fixture.plan.assetsScriptName}/subdomain`,
        },
      ]);
      expect(fixture.requests).toContain(`${fixture.plan.assetsOrigin}${CONTRACT_PATH}`);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const options of [
  { assetsUploadError: { providerCode: 10_006 } },
  { assetsUploadError: { providerCode: 10_007, providerPath: '/accounts/foreign/workers/workers/another-worker' } },
  { assetsUploadCommand: 'a different native command', assetsUploadError: { providerCode: 10_007 } },
]) {
  it.effect(`refuses assets upload recovery for a different native failure ${JSON.stringify(options)}`, () =>
    Effect.scoped(
      Effect.gen(function* foreignAssetsUploadFailure() {
        const fixture = yield* prepareDeployment(options);
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        const commandFailure = yield* Schema.decodeUnknownEffect(OpsCommandError)(failure);
        expect(commandFailure.cause).toEqual({
          providerCode: options.assetsUploadError.providerCode,
          providerPath: options.assetsUploadError.providerPath ?? fixture.recoveryWorkerPath,
        });
        expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
        expect(fixture.requests).not.toContain(`https://api.cloudflare.com/client/v4${fixture.recoveryWorkerPath}`);
        expect(fixture.providerWrites).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('bounds an unobserved uploaded assets Worker by the routing recovery deadline without uploading again', () =>
  Effect.scoped(
    Effect.gen(function* missingUploadedAssetsWorker() {
      const fixture = yield* prepareDeployment({
        assetsUploadError: { providerCode: 10_007 },
        recoveryWorkerStatuses: [404],
      });
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.recoveryWorkerReadStarted);
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSETS_ROUTING_FAILURE);
      expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
      expect(fixture.providerWrites).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'refuses uploaded assets routing recovery with two active provider versions before enabling its subdomain',
  () =>
    Effect.scoped(
      Effect.gen(function* splitUploadedAssetsVersion() {
        const fixture = yield* prepareDeployment({
          assetsDeploymentVersions: [
            { percentage: 50, version_id: ASSETS_VERSION_ID },
            { percentage: 50, version_id: BACKEND_VERSION_ID },
          ],
          assetsUploadError: { providerCode: 10_007 },
        });
        const failure = yield* fixture.deploy.pipe(Effect.flip);
        expect(failure.message).toBe(ASSETS_ROUTING_FAILURE);
        expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
        expect(fixture.providerWrites).toEqual([]);
        expect(fixture.requests.some((url) => url.startsWith(fixture.plan.assetsOrigin))).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const acknowledgement of [
  { enabled: true, previews_enabled: false, success: false },
  { enabled: false, previews_enabled: false, success: true },
  { enabled: true, previews_enabled: true, success: true },
]) {
  it.effect(
    `requires exact successful uploaded assets routing acknowledgement ${JSON.stringify(acknowledgement)}`,
    () =>
      Effect.scoped(
        Effect.gen(function* refusedUploadedAssetsRouting() {
          const fixture = yield* prepareDeployment({
            assetsSubdomainAcknowledgement: acknowledgement,
            assetsUploadError: { providerCode: 10_007 },
          });
          const failure = yield* fixture.deploy.pipe(Effect.flip);
          expect(failure.message).toBe(ASSETS_ROUTING_FAILURE);
          expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
          expect(fixture.providerWrites).toHaveLength(1);
          expect(fixture.providerWrites[0]?.method).toBe('POST');
          expect(fixture.requests.some((url) => url.startsWith(fixture.plan.assetsOrigin))).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('still refuses incorrect compiled assets after native routing completion', () =>
  Effect.scoped(
    Effect.gen(function* corruptRecoveredAssets() {
      const fixture = yield* prepareDeployment({
        assetsUploadError: { providerCode: 10_007 },
        wrongAssetBytes: true,
      });
      const fiber = yield* fixture.deploy.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.assetReadStarted);
      yield* TestClock.adjust(READBACK_DEADLINE);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toBe(ASSET_READBACK_FAILURE);
      expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
      expect(fixture.providerWrites).toHaveLength(1);
      expect(fixture.requests).toContain(`${fixture.plan.assetsOrigin}${CONTRACT_PATH}`);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses a different observed Worker identity before completing uploaded assets routing', () =>
  Effect.scoped(
    Effect.gen(function* foreignObservedAssetsWorker() {
      const fixture = yield* prepareDeployment({
        assetsUploadError: { providerCode: 10_007 },
        recoveryWorkerName: 'a-different-uploaded-worker',
      });
      const failure = yield* fixture.deploy.pipe(Effect.flip);
      expect(failure.message).toBe(ASSETS_ROUTING_FAILURE);
      expect(fixture.capturedConfigs.filter(({ name }) => name === fixture.plan.assetsScriptName)).toHaveLength(1);
      expect(fixture.providerWrites).toEqual([]);
      expect(fixture.requests.some((url) => url.startsWith(fixture.plan.assetsOrigin))).toBe(false);
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

const nodePlanFor = (id = APP_ID, identity: { readonly buildMarker?: string; readonly sourceRevision?: string } = {}) =>
  Effect.gen(function* controlledNodePlan() {
    const placement = yield* planFor(id, identity);
    return yield* Schema.decodeUnknownEffect(ImmutableNodeReleasePlanSchema)({
      appId: placement.appId,
      assetsOrigin: placement.assetsOrigin,
      assetsScriptName: placement.assetsScriptName,
      backend: { baseUrl: `https://${id}.backend.example.test/`, transport: 'node-http' },
      buildMarker: placement.buildMarker,
      projectId: 'P'.repeat(22),
      provider: 'zerops',
      serviceId: 'S'.repeat(22),
      setup: id,
      sourceRevision: placement.sourceRevision,
    });
  });

const nodeAssetsFor = (plan: ImmutableNodeReleasePlan) => {
  const build = file(
    NODE_BUILD_MARKER_FILE,
    json({
      deliveryUnit: {
        appId: plan.appId,
        buildMarker: plan.buildMarker,
        sourceRevision: plan.sourceRevision,
        unitId: `app/${plan.appId}`,
      },
    }),
  );
  return [...receiptInventory(plan).assets, build];
};

const zeropsReleaseInputs = Effect.gen(function* currentZeropsReleaseInputs() {
  const fs = yield* FileSystem.FileSystem;
  const rootDirectory = nodePath.resolve(import.meta.dirname, '../..');
  const unitSchema = Schema.Struct({
    cloudflare: Schema.Struct({ workerName: Schema.String }),
    deliveryUnit: Schema.Struct({
      buildMarker: Schema.String,
      unitId: Schema.String.pipe(Schema.brand('UnitId')),
    }),
    id: Schema.String,
    package: Schema.String,
    path: Schema.String,
  });
  const topology = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ shell: unitSchema, verticals: Schema.Array(unitSchema) })),
  )(yield* fs.readFileString(nodePath.join(rootDirectory, 'topology/reference-topology.json')));
  const intent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
    yield* fs.readFileString(nodePath.join(rootDirectory, 'topology/application-release-intent.json')),
  );
  const units = [topology.shell, ...topology.verticals];
  const available = units.map((entry) => ({
    id: entry.id,
    packageName: entry.package,
    path: entry.path,
    workerName: entry.cloudflare.workerName,
  }));
  const host = yield* outboxWorkerHostDelivery(rootDirectory, topology.verticals);
  const assetsFor = (id: string, revision: string) =>
    Effect.gen(function* sourceBoundNodeAssets() {
      const owner = units.find((entry) => entry.id === id);
      if (owner === undefined) {
        return yield* Effect.die('Missing topology owner in release test');
      }
      const plan = yield* nodePlanFor(id, {
        buildMarker: createUltramodernReleaseBuildMarker({
          generationBuildMarker: owner.deliveryUnit.buildMarker,
          sourceRevision: revision,
          unitId: owner.deliveryUnit.unitId,
        }),
        sourceRevision: revision,
      });
      const artifacts = yield* validateImmutableNodePublicArtifacts(
        plan,
        id === SHELL_APP_ID ? shellPublicFiles(plan) : nodeAssetsFor(plan),
      );
      const receipt: ImmutableNodeAssetReceipt = {
        artifacts,
        assetsVersionId: ASSETS_VERSION_ID,
        plan,
        stage: PUBLIC_ASSET_STAGE,
      };
      return receipt;
    });
  return {
    assetsFor,
    available,
    hostedOwnerIds: host?.owners.map(({ ownerId }) => ownerId) ?? [],
    intent,
    rootDirectory,
  };
});

// Scripted receipt evidence exercises candidate identity checks, not a live provider deployment.
const scriptedNodeReceipt = (assets: ImmutableNodeAssetReceipt) =>
  Schema.decodeUnknownEffect(ImmutableNodeReleaseReceiptSchema)({
    ...assets,
    backendMarker: {
      sha256: 'e'.repeat(64),
      url: new URL(NODE_BUILD_MARKER_FILE, assets.plan.backend.baseUrl).href,
    },
    nativeVersion: {
      id: 'V'.repeat(22),
      projectId: assets.plan.projectId,
      sequence: 1,
      serviceStackId: assets.plan.serviceId,
      source: 'CLI',
      status: 'ACTIVE',
    },
    sourceEvidence: { kind: 'witnessed-clean-git-push', sourceRevision: assets.plan.sourceRevision },
    stage: 'node-backend-deployed',
  });

for (const outboxWorkerMode of ['host', 'dedicated'] as const) {
  it.effect(
    `builds the first full Zerops ${outboxWorkerMode} selection and complete candidate from current topology`,
    () =>
      Effect.gen(function* firstCompleteZeropsRelease() {
        const { assetsFor, available, hostedOwnerIds, intent, rootDirectory } = yield* zeropsReleaseInputs;
        const plan = yield* planDeploymentImpact({ headRevision: SOURCE_REVISION, outboxWorkerMode, rootDirectory });
        expect(plan.comparison.mode).toBe('full');
        const selection = yield* selectApplicationReleaseUnits(
          intent,
          available,
          plan.phases.filter(({ kind }) => kind === 'provider' || kind === 'shell').map(({ id }) => ({ id })),
          undefined,
          'zerops',
        );
        expect(selection.complete.map(({ id }) => id)).toEqual(intent.modules.map(({ appId }) => appId));
        expect(selection.fresh).toEqual(selection.complete);
        expect(selection.retained).toEqual([]);
        expect(selection.removed).toEqual([]);
        expect(selection.shell.mode).toBe('fresh');
        expect(hostedOwnerIds).toContain(UNSELECTED_HOST_OWNER);
        expect(plan.phases.some(({ id }) => id === UNSELECTED_HOST_OWNER)).toBe(true);
        const reviewedHostedOwners = hostedOwnerIds.filter((id) => intent.modules.some(({ appId }) => appId === id));
        expect(plan.units.workers).toEqual(
          outboxWorkerMode === 'host' ? ['outbox-worker-host'] : reviewedHostedOwners.map((id) => `${id}-worker`),
        );
        expect(plan.units.providers).not.toContain(`${UNSELECTED_HOST_OWNER}-worker`);
        expect(plan.phases.some(({ id }) => id === `${UNSELECTED_HOST_OWNER}-worker`)).toBe(false);
        for (const parked of [UNSELECTED_HOST_OWNER, 'commerce-cart', 'availability']) {
          expect(selection.complete.some(({ id }) => id === parked)).toBe(false);
          expect(selection.fresh.some(({ id }) => id === parked)).toBe(false);
          expect(selection.retained.some(({ id }) => id === parked)).toBe(false);
        }
        const freshAssets = yield* Effect.all(selection.fresh.map(({ id }) => assetsFor(id, SOURCE_REVISION)));
        const shell = yield* assetsFor(SHELL_APP_ID, SOURCE_REVISION);
        const input = { currentSourceRevision: SOURCE_REVISION, intent, selection };
        const preflight = yield* makeImmutableNodeReleasePublicationCandidate({
          ...input,
          freshAssets,
          phase: 'preflight',
          receipts: [],
          shell,
        });
        const candidate = yield* makeImmutableNodeReleasePublicationCandidate({
          ...input,
          freshAssets: [],
          phase: 'deployed',
          receipts: yield* Effect.all(freshAssets.map((assets) => scriptedNodeReceipt(assets))),
          shell: yield* scriptedNodeReceipt(shell),
        });
        expect(candidate).toEqual(preflight);
        expect(candidate.modules.map(({ appId }) => appId)).toEqual(selection.complete.map(({ id }) => id));
        expect(candidate.modules.some(({ appId }) => appId === UNSELECTED_HOST_OWNER)).toBe(false);
        expect(candidate.modules.map(({ deployment }) => deployment.buildMarker)).toEqual(
          freshAssets.map(({ plan: entry }) => entry.buildMarker),
        );
        expect(candidate.baseline).toEqual({ retainedModuleAppIds: [], revision: null, shellMode: 'fresh' });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`keeps Zerops ${outboxWorkerMode} candidate markers coherent when only hosted owner A changed`, () =>
    Effect.gen(function* selectiveHostedOwnerCandidate() {
      const { assetsFor, available, hostedOwnerIds, intent, rootDirectory } = yield* zeropsReleaseInputs;
      const ids = intent.modules.map(({ appId }) => appId);
      const oldAssets = yield* Effect.all(ids.map((id) => assetsFor(id, SOURCE_REVISION)));
      const oldReceipts = yield* Effect.all(oldAssets.map((assets) => scriptedNodeReceipt(assets)));
      const approvedBaseline = yield* baselineFor(
        oldReceipts.map((receipt) => ({ ...receipt, backend: receipt.plan.backend })),
      );
      const revision = 'b'.repeat(40);
      const plan = yield* planDeploymentImpact({
        changedPaths: ['verticals/inventory/src/workers/execute-inventory-reservation-release.worker.ts'],
        headRevision: revision,
        outboxWorkerMode,
        rootDirectory,
      });
      const selection = yield* selectApplicationReleaseUnits(
        intent,
        available,
        plan.phases.filter(({ kind }) => kind === 'provider' || kind === 'shell').map(({ id }) => ({ id })),
        approvedBaseline,
        'zerops',
      );
      const freshIds = outboxWorkerMode === 'host' ? ids.filter((id) => hostedOwnerIds.includes(id)) : ['inventory'];
      expect(selection.complete.map(({ id }) => id)).toEqual(ids);
      expect(selection.fresh.map(({ id }) => id)).toEqual(freshIds);
      expect(selection.retained.map(({ id }) => id)).toEqual(ids.filter((id) => !freshIds.includes(id)));
      expect(selection.shell.mode).toBe('retained');
      expect(selection.complete.some(({ id }) => id === UNSELECTED_HOST_OWNER)).toBe(false);
      const receipts: ImmutableNodeReleaseReceipt[] = [];
      for (const old of oldReceipts) {
        receipts.push(
          freshIds.includes(old.plan.appId)
            ? yield* scriptedNodeReceipt(yield* assetsFor(old.plan.appId, revision))
            : old,
        );
      }
      const shellPlan = yield* nodePlanFor(SHELL_APP_ID);
      const shell = yield* scriptedNodeReceipt({
        artifacts: yield* validateImmutableNodePublicArtifacts(shellPlan, shellPublicFiles(shellPlan)),
        assetsVersionId: ASSETS_VERSION_ID,
        plan: shellPlan,
        stage: PUBLIC_ASSET_STAGE,
      });
      const input = {
        approvedBaseline,
        currentSourceRevision: revision,
        freshAssets: [],
        intent,
        phase: 'deployed' as const,
        receipts,
        selection,
        shell,
      };
      const candidate = yield* makeImmutableNodeReleasePublicationCandidate(input);
      expect(candidate.modules.map(({ deployment }) => deployment.buildMarker)).toEqual(
        receipts.map(({ plan: entry }) => entry.buildMarker),
      );
      expect(candidate.baseline.retainedModuleAppIds).toEqual(selection.retained.map(({ id }) => id));
      for (const [index, receipt] of receipts.entries()) {
        expect(receipt.plan.sourceRevision).toBe(freshIds.includes(receipt.plan.appId) ? revision : SOURCE_REVISION);
        expect(receipt.plan.buildMarker === oldReceipts[index]?.plan.buildMarker).toBe(
          !freshIds.includes(receipt.plan.appId),
        );
      }
      if (outboxWorkerMode === 'host') {
        const oldB = oldReceipts.find(({ plan: entry }) => entry.appId === APP_ID);
        if (oldB === undefined) {
          return yield* Effect.die('Expected the original hosted owner B receipt');
        }
        const staleB = yield* makeImmutableNodeReleasePublicationCandidate({
          ...input,
          receipts: receipts.map((receipt) => (receipt.plan.appId === APP_ID ? oldB : receipt)),
        }).pipe(Effect.flip);
        expect(staleB.message).toBe('fresh Node slot has the wrong original source or evidence stage');
      }
      return yield* Effect.void;
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

const writeNodeEnvelope = Effect.fn('test.writeNodeEnvelope')(function* writeNodeEnvelopeEffect(
  output: string,
  plan: ImmutableNodeReleasePlan,
  assets: readonly ReleaseFile[],
  target: 'node' | 'cloudflare' = 'node',
  kind: ReleaseEnvelopeKind = MICROVERTICAL_RELEASE_ENVELOPE_KIND,
) {
  const fs = yield* FileSystem.FileSystem;
  const allBackendFiles = [
    file('index.js', text('export const ssr = true;')),
    file('server/effect-api.mjs'),
    file('server/backend-manifest.json', json({ name: 'controlledOwner' })),
    file('server/backend-container.cjs'),
  ];
  const backendFiles = kind === SHELL_RELEASE_ENVELOPE_KIND ? allBackendFiles.slice(0, 2) : allBackendFiles;
  const publicPaths = EffectArray.sort(
    assets.filter(({ path }) => path.endsWith('.js')).map(({ path }) => `public/${path}`),
    Order.String,
  );
  const baseSurfaces = { apiBackend: [allBackendFiles[1].path], ssr: [allBackendFiles[0].path], uiClient: publicPaths };
  const surfaces =
    kind === SHELL_RELEASE_ENVELOPE_KIND
      ? baseSurfaces
      : {
          ...baseSurfaces,
          backendFederation: { container: allBackendFiles[3].path, manifest: allBackendFiles[2].path },
        };
  for (const entry of [...backendFiles, ...assets.map((asset) => ({ ...asset, path: `public/${asset.path}` }))]) {
    const destination = nodePath.join(output, entry.path);
    yield* fs.makeDirectory(nodePath.dirname(destination), { recursive: true });
    yield* fs.writeFile(destination, entry.bytes);
  }
  const envelope = yield* Effect.tryPromise({
    catch: (cause) => new ImmutableApplicationReleaseError({ cause, message: 'controlled Node envelope failed' }),
    try: async () =>
      await createMicroVerticalReleaseEnvelope({
        artifactRoot: output,
        artifacts: [
          ...backendFiles.map(({ path }, index) => {
            if (index === 2) {
              return { logicalPath: path, runtime: FEDERATION_ARTIFACT_RUNTIME };
            }
            if (target === 'node') {
              return { logicalPath: path, runtime: 'nodejs' };
            }
            const runtimes = ['workerd', 'workerd-effect', FEDERATION_ARTIFACT_RUNTIME, 'commonjs-module'];
            return { logicalPath: path, runtime: runtimes[index] ?? 'workerd' };
          }),
          ...assets.map(({ path }) => ({
            logicalPath: `public/${path}`,
            runtime: path.endsWith('.js') ? 'browser' : 'public-asset',
          })),
        ],
        identity: {
          buildMarker: plan.buildMarker,
          releaseVersion: '1.0.0',
          sourceRevision: plan.sourceRevision,
          unitId: `app/${plan.appId}`,
        },
        kind,
        surfaces,
        target,
        ui: releaseUiFor(plan.appId, plan.buildMarker),
      }),
  });
  const destination = nodePath.join(output, MICROVERTICAL_RELEASE_ENVELOPE_PATH);
  yield* fs.makeDirectory(nodePath.dirname(destination), { recursive: true });
  yield* fs.writeFileString(destination, canonicalSerializeMicroVerticalReleaseEnvelope(envelope));
});

it.effect('keeps Node API origins separate from immutable asset origins and rejects an assets-only backend', () =>
  Effect.gen(function* nodeOrigins() {
    const plan = yield* nodePlanFor();
    const environment = immutableNodeBuildEnvironment(plan);
    expect(environment.MODERN_ASSET_PREFIX).toBe(plan.assetsOrigin);
    expect(environment.ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY).toBe(plan.backend.baseUrl);
    const pins = yield* validateImmutableNodePublicArtifacts(plan, nodeAssetsFor(plan));
    expect(pins.contract?.url).toBe(new URL(CONTRACT_PATH, plan.assetsOrigin).href);
    const error = yield* validateImmutableNodePublicArtifacts(
      { ...plan, backend: { ...plan.backend, baseUrl: plan.assetsOrigin } },
      nodeAssetsFor(plan),
    ).pipe(Effect.flip);
    expect(error.message).toBe('the Node API deployment origin cannot be an assets-only Worker');
  }),
);

it.effect('changes only selected Node public origins in a temporary native provider configuration', () =>
  Effect.gen(function* nodeYaml() {
    const fs = yield* FileSystem.FileSystem;
    const plan = yield* nodePlanFor();
    const sourceDirectory = yield* fs.makeTempDirectoryScoped();
    const sourceFile = nodePath.join(sourceDirectory, 'zerops.yaml');
    const original = `zerops:
  - setup: party-registry
    build:
      envVariables:
        RETAIN: keep
      buildCommands:
        - ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" pnpm build
    run:
      start: node index.js
  - setup: other
    build:
      envVariables:
        MODERN_ASSET_PREFIX: untouched
`;
    yield* fs.writeFileString(sourceFile, original);
    const temporary = yield* materializeImmutableNodePushYaml({ plan, sourceFile });
    expect(nodePath.dirname(temporary)).not.toBe(sourceDirectory);
    const document = parseDocument(yield* fs.readFileString(temporary));
    expect(document.getIn(['zerops', 0, 'build', 'envVariables', 'MODERN_ASSET_PREFIX'])).toBe(plan.assetsOrigin);
    expect(document.getIn(['zerops', 0, 'build', 'envVariables', 'ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY'])).toBe(
      plan.backend.baseUrl,
    );
    expect(document.getIn(['zerops', 0, 'build', 'envVariables', 'ULTRAMODERN_SOURCE_REVISION'])).toBeUndefined();
    expect(document.getIn(['zerops', 0, 'build', 'envVariables', 'RETAIN'])).toBe('keep');
    expect(document.getIn(['zerops', 0, 'build', 'buildCommands', 0])).toContain('$(git rev-parse HEAD)');
    expect(document.getIn(['zerops', 0, 'run', 'start'])).toBe('node index.js');
    expect(document.getIn(['zerops', 1, 'build', 'envVariables', 'MODERN_ASSET_PREFIX'])).toBe('untouched');
    expect(yield* fs.readFileString(sourceFile)).toBe(original);
    yield* fs.writeFileString(
      sourceFile,
      `zerops:
  - setup: party-registry
    build: {}
  - setup: party-registry
    build: {}
`,
    );
    const error = yield* materializeImmutableNodePushYaml({ plan, sourceFile }).pipe(Effect.flip);
    expect(error.message).toBe('Node push requires exactly one selected executable setup');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('verifies real SDK Node envelope bytes and rejects a Cloudflare envelope or tampered Node payload', () =>
  Effect.gen(function* nodeEnvelope() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const output = nodePath.join(directory, '.output');
    const plan = yield* nodePlanFor();
    const assets = nodeAssetsFor(plan);
    yield* writeNodeEnvelope(output, plan, assets);
    const shell = Layer.succeed(OpsShell, { run: (command) => Effect.succeed(gitResult(command, directory)) });
    const verified = yield* readVerifiedNodeReleaseOutput(directory, plan).pipe(Effect.provide(shell));
    expect(verified.artifacts.contract?.url).toBe(new URL(CONTRACT_PATH, plan.assetsOrigin).href);
    yield* fs.writeFileString(nodePath.join(output, 'index.js'), 'tampered');
    expect(
      Schema.is(ImmutableApplicationReleaseError)(
        yield* readVerifiedNodeReleaseOutput(directory, plan).pipe(Effect.provide(shell), Effect.flip),
      ),
    ).toBe(true);
    yield* writeNodeEnvelope(output, plan, assets, 'cloudflare');
    expect(
      Schema.is(ImmutableApplicationReleaseError)(
        yield* readVerifiedNodeReleaseOutput(directory, plan).pipe(Effect.provide(shell), Effect.flip),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'derives the Node plan from genuine clean Git and generated SDK identity rather than a supplied version label',
  () =>
    Effect.gen(function* nodePlanIdentity() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(nodePath.join(directory, 'shared'));
      yield* fs.writeFileString(
        nodePath.join(directory, 'shared/ultramodern-build.json'),
        JSON.stringify({ deliveryUnit: { appId: APP_ID, buildMarker: 'aaebe4ee5a28e557', unitId: `app/${APP_ID}` } }),
      );
      const input: Parameters<typeof deriveImmutableNodeReleasePlan>[0] = {
        appDirectory: directory,
        backend: { baseUrl: 'https://node.example.test/', transport: 'node-http' },
        projectId: 'P'.repeat(22),
        serviceId: 'S'.repeat(22),
        setup: APP_ID,
        workersDevSubdomain: WORKERS_SUBDOMAIN,
      };
      const cleanShell = Layer.succeed(OpsShell, { run: (command) => Effect.succeed(gitResult(command, directory)) });
      const plan = yield* deriveImmutableNodeReleasePlan(input).pipe(Effect.provide(cleanShell));
      expect(plan.sourceRevision).toBe(SOURCE_REVISION);
      expect(plan.buildMarker).not.toBe('aaebe4ee5a28e557');
      expect(plan.buildMarker).toMatch(/^[a-f0-9]{64}$/u);
      expect(plan).toEqual(yield* deriveImmutableNodeReleasePlan(input).pipe(Effect.provide(cleanShell)));
      const dirtyShell = Layer.succeed(OpsShell, {
        run: (command) => Effect.succeed(gitResult(command, directory, SOURCE_REVISION, ' M tracked-source')),
      });
      expect(
        Schema.is(ImmutableApplicationReleaseError)(
          yield* deriveImmutableNodeReleasePlan(input).pipe(Effect.provide(dirtyShell), Effect.flip),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('admits asset-only Node evidence only to preflight and refuses to call it a deployed backend receipt', () =>
  Effect.gen(function* nodeEvidenceStages() {
    const plan = yield* nodePlanFor();
    const publicArtifacts = yield* validateImmutableNodePublicArtifacts(plan, nodeAssetsFor(plan));
    const assets: ImmutableNodeAssetReceipt = {
      artifacts: publicArtifacts,
      assetsVersionId: ASSETS_VERSION_ID,
      plan,
      stage: PUBLIC_ASSET_STAGE,
    };
    const shellPlan = yield* nodePlanFor(SHELL_APP_ID);
    const shellPublic = yield* shellReceiptFor({ buildMarker: BUILD_MARKER, sourceRevision: SOURCE_REVISION });
    const shell: ImmutableNodeAssetReceipt = {
      artifacts: shellPublic.artifacts,
      assetsVersionId: ASSETS_VERSION_ID,
      plan: shellPlan,
      stage: PUBLIC_ASSET_STAGE,
    };
    const intent: ApplicationReleaseIntent = { modules: [{ appId: plan.appId }] };
    const selection: ApplicationReleaseSelection = {
      ...freshSelection(intent),
      shell: { mode: 'fresh', unit: unitFor(SHELL_APP_ID) },
    };
    const input = {
      currentSourceRevision: SOURCE_REVISION,
      freshAssets: [assets],
      intent,
      receipts: [],
      selection,
      shell,
    };
    const candidate = yield* makeImmutableNodeReleasePublicationCandidate({ ...input, phase: 'preflight' });
    expect(candidate.modules[0]?.backend).toEqual(plan.backend);
    expect(candidate.modules[0]?.contract).toEqual(publicArtifacts.contract);
    expect(candidate.baseline.revision).toBeNull();
    const finalError = yield* makeImmutableNodeReleasePublicationCandidate({ ...input, phase: 'deployed' }).pipe(
      Effect.flip,
    );
    expect(finalError.message).toBe('final Node candidate requires deployed receipts, never asset-only plans');
    const missing = yield* makeImmutableNodeReleasePublicationCandidate({
      ...input,
      freshAssets: [],
      phase: 'preflight',
    }).pipe(Effect.flip);
    const duplicate = yield* makeImmutableNodeReleasePublicationCandidate({
      ...input,
      freshAssets: [assets, assets],
      phase: 'preflight',
    }).pipe(Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(missing)).toBe(true);
    expect(Schema.is(ImmutableApplicationReleaseError)(duplicate)).toBe(true);
  }),
);

it.effect('verifies Node Shell output using the actual SDK Shell envelope kind and source-generation shape', () =>
  Effect.gen(function* nodeShellOutput() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(nodePath.join(directory, 'shared'));
    yield* fs.writeFileString(
      nodePath.join(directory, 'shared/ultramodern-build.json'),
      JSON.stringify({
        deliveryUnit: { appId: SHELL_APP_ID, buildMarker: 'a0db691763b92101', unitId: `app/${SHELL_APP_ID}` },
      }),
    );
    const shell = Layer.succeed(OpsShell, { run: (command) => Effect.succeed(gitResult(command, directory)) });
    const base = yield* nodePlanFor(SHELL_APP_ID);
    const plan = yield* deriveImmutableNodeReleasePlan({
      appDirectory: directory,
      backend: base.backend,
      projectId: base.projectId,
      serviceId: base.serviceId,
      setup: SHELL_APP_ID,
      workersDevSubdomain: WORKERS_SUBDOMAIN,
    }).pipe(Effect.provide(shell));
    const marker = nodeAssetsFor(plan).find(({ path }) => path === NODE_BUILD_MARKER_FILE);
    if (marker === undefined) {
      return yield* Effect.die('Controlled Shell marker is required');
    }
    const assets = [...shellPublicFiles(plan), marker];
    const output = nodePath.join(directory, '.output');
    yield* writeNodeEnvelope(output, plan, assets, 'node', SHELL_RELEASE_ENVELOPE_KIND);
    const verified = yield* readVerifiedNodeReleaseOutput(directory, plan).pipe(Effect.provide(shell));
    expect(verified.artifacts.runtimeContract?.url).toBe(new URL(SHELL_RUNTIME_FILE, plan.assetsOrigin).href);
    expect(verified.artifacts.contract).toBeUndefined();
    yield* writeNodeEnvelope(output, plan, assets);
    const wrongKind = yield* readVerifiedNodeReleaseOutput(directory, plan).pipe(Effect.provide(shell), Effect.flip);
    expect(Schema.is(ImmutableApplicationReleaseError)(wrongKind)).toBe(true);
    return yield* Effect.void;
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const existing of [false, true]) {
  it.effect(
    `retains exact Node public assets without overwriting an existing immutable Worker (existing=${existing})`,
    () =>
      Effect.gen(function* nativeNodeAssets() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const plan = yield* nodePlanFor();
        const assets = nodeAssetsFor(plan);
        yield* writeNodeEnvelope(nodePath.join(directory, '.output'), plan, assets);
        yield* fs.writeFileString(
          nodePath.join(directory, PACKAGE_FILE),
          JSON.stringify({ devDependencies: { wrangler: WRANGLER_VERSION } }),
        );
        const uploads: OpsCommand[] = [];
        const shell = Layer.succeed(OpsShell, {
          run: (command) => {
            if (command.command === 'git') {
              return Effect.succeed(gitResult(command, directory));
            }
            if (command.args.join(' ') === WRANGLER_VERSION_COMMAND) {
              return Effect.succeed(WRANGLER_VERSION);
            }
            uploads.push(command);
            return Effect.succeed('native upload accepted');
          },
        });
        const client = HttpClient.make((request, destination) => {
          if (destination.pathname.endsWith(WORKERS_SUBDOMAIN_PATH)) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ result: { subdomain: WORKERS_SUBDOMAIN }, success: true }),
              ),
            );
          }
          if (destination.pathname.endsWith(NATIVE_DEPLOYMENTS_PATH)) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  result: { deployments: [{ versions: [{ percentage: 100, version_id: ASSETS_VERSION_ID }] }] },
                  success: true,
                }),
              ),
            );
          }
          if (destination.hostname === 'api.cloudflare.com') {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: existing ? 200 : 404 })),
            );
          }
          const asset = assets.find(({ path }) => new URL(path, plan.assetsOrigin).href === destination.href);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array(asset?.bytes ?? []).buffer, {
                headers: {
                  'access-control-allow-origin': '*',
                  'cache-control': IMMUTABLE_CACHE_HEADER,
                  'x-content-type-options': 'nosniff',
                },
                status: asset === undefined ? 404 : 200,
              }),
            ),
          );
        });
        const layer = Layer.mergeAll(
          shell,
          Layer.succeed(HttpClient.HttpClient, client),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
              CLOUDFLARE_API_TOKEN: 'controlled-node-upload-token',
            }),
          ),
        );
        const receipt = yield* deployImmutableNodeAssets({ appDirectory: directory, plan }).pipe(Effect.provide(layer));
        expect(receipt.assetsVersionId).toBe(ASSETS_VERSION_ID);
        expect(receipt.stage).toBe(PUBLIC_ASSET_STAGE);
        expect(uploads.length).toBe(existing ? 0 : 1);
        expect(uploads.every((command) => command.args.includes('deploy'))).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}

const nodePublicationFixture = Effect.fn('test.nodePublication')(function* controlledNodePublication(
  plan: ImmutableNodeReleasePlan,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const assets = nodeAssetsFor(plan);
  yield* writeNodeEnvelope(nodePath.join(directory, '.output'), plan, assets);
  const verified = yield* readVerifiedNodeReleaseOutput(directory, plan);
  const assetReceipt: ImmutableNodeAssetReceipt = {
    artifacts: verified.artifacts,
    assetsVersionId: ASSETS_VERSION_ID,
    plan,
    stage: PUBLIC_ASSET_STAGE,
  };
  const shellPlan = yield* nodePlanFor(SHELL_APP_ID);
  const shellAssets = shellPublicFiles(shellPlan);
  const shellPins = yield* validateImmutableNodePublicArtifacts(shellPlan, shellAssets);
  const shell: ImmutableNodeAssetReceipt = {
    artifacts: shellPins,
    assetsVersionId: ASSETS_VERSION_ID,
    plan: shellPlan,
    stage: PUBLIC_ASSET_STAGE,
  };
  const intent: ApplicationReleaseIntent = { modules: [{ appId: plan.appId }] };
  const selection: ApplicationReleaseSelection = {
    ...freshSelection(intent),
    shell: { mode: 'fresh', unit: unitFor(SHELL_APP_ID) },
  };
  const candidate = yield* makeImmutableNodeReleasePublicationCandidate({
    currentSourceRevision: SOURCE_REVISION,
    freshAssets: [assetReceipt],
    intent,
    phase: 'preflight',
    receipts: [],
    selection,
    shell,
  });
  const contract = assets.find(({ path }) => path === CONTRACT_PATH);
  const manifest = assets.find(({ path }) => path === FEDERATION_MANIFEST_PATH);
  const runtime = shellAssets.find(({ path }) => path === SHELL_RUNTIME_FILE);
  const shellManifest = shellAssets.find(({ path }) => path === FEDERATION_MANIFEST_PATH);
  if (contract === undefined || manifest === undefined || runtime === undefined || shellManifest === undefined) {
    return yield* Effect.die('Controlled publication requires actual fixture contract bytes');
  }
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'stage',
    modules: [
      {
        appId: plan.appId,
        backend: plan.backend,
        contract: { bytes: contract.bytes, url: new URL(contract.path, plan.assetsOrigin).href },
        federationManifest: { bytes: manifest.bytes, url: new URL(manifest.path, plan.assetsOrigin).href },
      },
    ],
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: { bytes: shellManifest.bytes, url: new URL(shellManifest.path, shellPlan.assetsOrigin).href },
      runtimeContract: { bytes: runtime.bytes, url: new URL(runtime.path, shellPlan.assetsOrigin).href },
    },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
  const candidateFile = nodePath.join(directory, 'candidate.json');
  const expectedCompositionFile = nodePath.join(directory, 'expected.json');
  const selectionFile = nodePath.join(directory, 'selection.json');
  const intentFile = nodePath.join(directory, 'intent.json');
  const zeropsYamlPath = nodePath.join(directory, 'zerops.yaml');
  yield* fs.writeFileString(
    candidateFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema))(candidate),
  );
  yield* fs.writeFileString(
    expectedCompositionFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionSchema))(snapshot.composition),
  );
  yield* fs.writeFileString(
    selectionFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema))(selection),
  );
  yield* fs.writeFileString(
    intentFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema))(intent),
  );
  yield* fs.writeFileString(
    zeropsYamlPath,
    `zerops:
  - setup: ${APP_ID}
    build:
      envVariables: {}
      buildCommands: ['git rev-parse HEAD']
`,
  );
  return {
    appDirectory: directory,
    assetReceipt,
    candidateFile,
    expectedCompositionFile,
    intentFile,
    selectionFile,
    zeropsYamlPath,
  };
});

for (const scenario of [
  { stale: false, succeeds: true, versionChanges: false },
  { stale: true, succeeds: true, versionChanges: false },
  { stale: false, succeeds: false, versionChanges: false },
  { stale: false, succeeds: true, versionChanges: true },
]) {
  it.effect(
    `witnesses Node source push only inside its captured publication guard (stale=${scenario.stale}, succeeds=${scenario.succeeds}, versionChanges=${scenario.versionChanges})`,
    () =>
      Effect.gen(function* guardedNodePush() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const plan = yield* nodePlanFor();
        const commands: OpsCommand[] = [];
        const events: string[] = [];
        const shell = Layer.succeed(OpsShell, {
          run: (command) => {
            if (command.command === 'git') {
              return Effect.succeed(gitResult(command, directory));
            }
            commands.push(command);
            if (command.command === 'zcli') {
              events.push('push');
              return scenario.succeeds
                ? Effect.succeed('genuine command exit zero')
                : Effect.fail(new OpsCommandError({ command: 'zcli push', message: 'controlled rejected push' }));
            }
            events.push(PUBLIC_ACCESS_EVENT);
            return Effect.succeed('native public readback verified');
          },
        });
        const input = yield* nodePublicationFixture(plan, directory).pipe(Effect.provide(shell));
        const assets = nodeAssetsFor(plan);
        const nativeVersion = {
          id: 'V'.repeat(22),
          projectId: plan.projectId,
          sequence: 1,
          serviceStackId: plan.serviceId,
          source: 'CLI',
          status: 'ACTIVE',
        };
        let nativeReads = 0;
        let retainedVersionChanged = false;
        const requests: string[] = [];
        const currentNativeVersion = () =>
          (scenario.versionChanges || retainedVersionChanged) && nativeReads > 1
            ? { ...nativeVersion, id: 'W'.repeat(22), sequence: 2 }
            : nativeVersion;
        const client = HttpClient.make((request, destination) => {
          requests.push(destination.href);
          if (destination.pathname.includes('/service-stack/')) {
            nativeReads += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  activeAppVersion: currentNativeVersion(),
                  id: plan.serviceId,
                  projectId: plan.projectId,
                  status: 'ACTIVE',
                }),
              ),
            );
          }
          if (destination.pathname.includes('/app-version/')) {
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(currentNativeVersion())));
          }
          if (destination.pathname.endsWith(NATIVE_DEPLOYMENTS_PATH)) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  result: { deployments: [{ versions: [{ percentage: 100, version_id: ASSETS_VERSION_ID }] }] },
                  success: true,
                }),
              ),
            );
          }
          const asset = assets.find(({ path }) => destination.pathname === `/${path}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array(asset?.bytes ?? []).buffer, {
                headers: {
                  'access-control-allow-origin': '*',
                  'cache-control': IMMUTABLE_CACHE_HEADER,
                  'x-content-type-options': 'nosniff',
                },
                status: asset === undefined ? 404 : 200,
              }),
            ),
          );
        });
        const executor = yield* makeTestDatabase((statement) =>
          Effect.sync(() => {
            if (statement.includes('pg_advisory_unlock(')) {
              events.push('unlock');
              return [{ unlocked: true }];
            }
            if (statement.includes('pg_advisory_lock(')) {
              events.push('lock');
            }
            if (statement.includes('application_composition_authority')) {
              return scenario.stale ? [{ phase: 'active', revision: 'f'.repeat(64) }] : [];
            }
            return [];
          }),
        );
        const http = Layer.succeed(HttpClient.HttpClient, client);
        const layer = Layer.mergeAll(
          shell,
          http,
          ZeropsPublicApiLive.pipe(Layer.provide(http)),
          Layer.succeed(CoreDatabase, { executor }),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
              CLOUDFLARE_API_TOKEN: 'controlled-asset-token',
              ZEROPS_TOKEN: 'controlled-node-token',
            }),
          ),
        );
        const checkoutFiles = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          realPath: (location) =>
            location === nodePath.resolve(import.meta.dirname, '../..')
              ? Effect.succeed(directory)
              : fs.realPath(location),
        });
        const deploy = deployImmutableNodeRelease(input).pipe(Effect.provide(Layer.merge(layer, checkoutFiles)));
        if (scenario.stale) {
          const failure = yield* deploy.pipe(Effect.flip);
          expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
          expect(commands).toEqual([]);
          expect(requests).toEqual([]);
          expect(events).toEqual(['lock', 'unlock']);
        } else if (!scenario.succeeds) {
          expect(Schema.is(ImmutableApplicationReleaseError)(yield* deploy.pipe(Effect.flip))).toBe(true);
          expect(events).toEqual(['lock', 'push', 'unlock']);
          expect(requests).toEqual([]);
        } else if (scenario.versionChanges) {
          const changed = yield* deploy.pipe(Effect.flip);
          expect(Schema.is(ImmutableApplicationReleaseError)(changed)).toBe(true);
          expect(changed.message).toBe('the active native Node version changed during exact artifact observation');
          expect(events).toEqual(['lock', 'push', PUBLIC_ACCESS_EVENT, 'unlock']);
        } else {
          const receipt = yield* deploy;
          expect(receipt.nativeVersion.id).toBe(nativeVersion.id);
          expect(receipt.sourceEvidence.sourceRevision).toBe(SOURCE_REVISION);
          expect(events).toEqual(['lock', 'push', PUBLIC_ACCESS_EVENT, 'unlock']);
          const push = commands.find(({ command }) => command === 'zcli');
          expect(push?.cwd).toBe(directory);
          expect(push?.args).toEqual(
            expect.arrayContaining([
              '--deploy-git-folder',
              '--workspace-state',
              'clean',
              '--version-name',
              SOURCE_REVISION,
            ]),
          );
          expect(commands.some(({ args }) => args.includes('ensure-public-access'))).toBe(true);
          const publicAccess = commands.find(({ args }) => args.includes('ensure-public-access'));
          const serviceVariables = publicAccess?.env?.STAGE_VARIABLES_JSON;
          if (serviceVariables === undefined) {
            return yield* Effect.die('The actual public gateway requires the single planned service ID');
          }
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(
              Redacted.value(serviceVariables),
            ),
          ).toEqual({ [serviceIdVariable(plan.setup)]: plan.serviceId });
          expect(nativeReads).toBe(2);
          const plannedShell = yield* nodePlanFor(SHELL_APP_ID);
          const plannedShellPins = yield* validateImmutableNodePublicArtifacts(
            plannedShell,
            shellPublicFiles(plannedShell),
          );
          const shellEvidence: ImmutableNodeAssetReceipt = {
            artifacts: plannedShellPins,
            assetsVersionId: ASSETS_VERSION_ID,
            plan: plannedShell,
            stage: PUBLIC_ASSET_STAGE,
          };
          yield* observeImmutableNodeCandidateReceipts({ receipts: [receipt], shell: shellEvidence }).pipe(
            Effect.provide(layer),
          );
          expect(nativeReads).toBe(4);
          const actualRequests = requests.length;
          yield* observeImmutableNodeCandidateReceipts({ receipts: [], shell: shellEvidence }).pipe(
            Effect.provide(layer),
          );
          expect(requests.length).toBe(actualRequests);
          retainedVersionChanged = true;
          const staleRetained = yield* observeImmutableNodeCandidateReceipts({
            receipts: [receipt],
            shell: shellEvidence,
          }).pipe(Effect.provide(layer), Effect.flip);
          expect(Schema.is(ImmutableApplicationReleaseError)(staleRetained)).toBe(true);
          expect(commands.filter(({ command }) => command === 'zcli')).toHaveLength(1);
        }
        return yield* Effect.void;
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}
