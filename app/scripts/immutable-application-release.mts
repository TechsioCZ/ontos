#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  MICROVERTICAL_RELEASE_ENVELOPE_KIND,
  SHELL_RELEASE_ENVELOPE_KIND,
  verifyMicroVerticalReleaseEnvelope,
} from '@modern-js/app-tools-extensions/release-envelope';
import type { ReleaseEnvelopeKind } from '@modern-js/app-tools-extensions/release-envelope';
import { MICROVERTICAL_RELEASE_ENVELOPE_PATH } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import {
  createUltramodernReleaseBuildMarker,
  resolveUltramodernSourceRevision,
} from '@modern-js/app-tools-extensions/release-identity';
import {
  Array as EffectArray,
  Config,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { isMap, isSeq, parseDocument } from 'yaml';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { PlatformError } from 'effect/PlatformError';

import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../packages/core-runtime/src/http/module-release-identity.ts';
import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import type { OntosDeploymentIdentitySchema } from '../packages/core-runtime/src/modules/manifest.ts';
import {
  ApplicationCompositionCloudflareWorkerBackendSchema,
  ApplicationCompositionBackendSchema,
  OntosShellRuntimeContractSchema,
} from '../packages/core-runtime/src/modules/application-composition.ts';
import type { ApplicationCompositionArtifactReferenceSchema } from '../packages/core-runtime/src/modules/application-composition.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import { decodeActiveApplicationCompositionSnapshot } from './active-application-composition.mts';
import {
  ApplicationCompositionPublicationCandidateSchema,
  assertRetainedReleaseArtifactPaths,
  readExpectedPublication,
  serviceIdVariable,
} from './publish-active-application-composition.mts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';
import {
  ApplicationReleaseIntentSchema,
  ApplicationReleaseSelectionSchema,
  applicationReleaseSelectCommand,
  readReviewedApplicationReleaseIntent,
} from './application-release-intent.mts';
import type { ApplicationReleaseIntent, ApplicationReleaseSelection } from './application-release-intent.mts';
import { verifyImmutableBackendModuleContent } from './immutable-backend-package.mts';
import { OpsShellLive, runCommand } from './ops/ops-shell.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from './zerops-public-api.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationLock,
} from './application-composition-authority-publication.mts';

export class ImmutableApplicationReleaseError extends Schema.TaggedError<ImmutableApplicationReleaseError>()(
  'ImmutableApplicationReleaseError',
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const ImmutableAssetNotReady = Data.TaggedError('ImmutableAssetNotReady')<{
  readonly cause: unknown;
  readonly message: string;
}>;
type ImmutableAssetNotReadyError = InstanceType<typeof ImmutableAssetNotReady>;

const SHELL_APP_ID = 'shell-super-app';
const NATIVE_ENVELOPE_MISMATCH = 'the native Cloudflare release envelope does not bind the final artifact bytes';
const PUBLIC_ASSET_INVENTORY_MISMATCH =
  'the deployed immutable public release does not serve the exact compiled asset inventory';

const sourceRevision = Schema.String.check(Schema.isPattern(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u));
const buildMarker = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const appId = OntosDeploymentAppIdSchema;
const workerVersionIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand('WorkerVersionId'),
  Schema.decodeTo(Schema.String),
);
const deliveryUnitIdSchema = Schema.NonEmptyString.pipe(Schema.brand('DeliveryUnitId'), Schema.decodeTo(Schema.String));
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const artifact = Schema.Struct({ sha256, url: Schema.String });

export const ImmutableApplicationReleasePlanSchema = Schema.Struct({
  appId,
  assetsOrigin: Schema.String,
  assetsScriptName: Schema.String,
  backendScriptName: Schema.String,
  buildMarker,
  sourceRevision,
});
export type ImmutableApplicationReleasePlan = typeof ImmutableApplicationReleasePlanSchema.Type;

export const ImmutableApplicationReleaseReceiptSchema = Schema.Struct({
  artifacts: Schema.Struct({
    assetsSha256: sha256,
    contract: artifact,
    federationManifest: Schema.optionalKey(artifact),
    workerSha256: sha256,
  }),
  assetsVersionId: workerVersionIdSchema,
  backend: ApplicationCompositionCloudflareWorkerBackendSchema,
  plan: ImmutableApplicationReleasePlanSchema,
});
export type ImmutableApplicationReleaseReceipt = typeof ImmutableApplicationReleaseReceiptSchema.Type;

export const ImmutableShellArtifactReceiptSchema = Schema.Struct({
  artifacts: Schema.Struct({
    assetsSha256: sha256,
    federationManifest: artifact,
    runtimeContract: artifact,
  }),
  assetsVersionId: workerVersionIdSchema,
  plan: ImmutableApplicationReleasePlanSchema,
});
export type ImmutableShellArtifactReceipt = typeof ImmutableShellArtifactReceiptSchema.Type;

const PUBLIC_ASSETS_RETAINED = 'public-assets-retained';
const NODE_BACKEND_DEPLOYED = 'node-backend-deployed';
const OWNER_CONTRACT_PATH = '.well-known/ontos-module-manifest.json';
const ASSETS_IGNORE_FILE = '.assetsignore';
const APP_DIRECTORY_FLAG = 'app-directory';
const ASSETS_RECEIPT_FLAG = 'assets-receipt-file';
const CANDIDATE_FILE_FLAG = 'candidate-file';
const INTENT_FILE_FLAG = 'intent-file';
const RECEIPT_FILE_FLAG = 'receipt-file';
const SELECTION_FILE_FLAG = 'selection-file';

/** A source/build plan is not proof of either uploaded assets or a deployed Node backend. */
const ZeropsNativeId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9]{22}$/u)).pipe(Schema.brand('ZeropsNativeId'));
const [ApplicationCompositionNodeHttpBackendSchema] = ApplicationCompositionBackendSchema.members;
export const ImmutableNodeReleasePlanSchema = Schema.Struct({
  appId,
  assetsOrigin: Schema.String,
  assetsScriptName: Schema.String,
  backend: ApplicationCompositionNodeHttpBackendSchema,
  buildMarker,
  projectId: ZeropsNativeId,
  provider: Schema.Literal('zerops'),
  serviceId: ZeropsNativeId,
  setup: Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u)),
  sourceRevision,
});
export type ImmutableNodeReleasePlan = typeof ImmutableNodeReleasePlanSchema.Type;
const NodeArtifactsSchema = Schema.Struct({
  assetsSha256: sha256,
  contract: Schema.optionalKey(artifact),
  federationManifest: Schema.optionalKey(artifact),
  runtimeContract: Schema.optionalKey(artifact),
});
export const ImmutableNodeAssetReceiptSchema = Schema.Struct({
  artifacts: NodeArtifactsSchema,
  assetsVersionId: workerVersionIdSchema,
  plan: ImmutableNodeReleasePlanSchema,
  stage: Schema.Literal(PUBLIC_ASSETS_RETAINED),
});
export type ImmutableNodeAssetReceipt = typeof ImmutableNodeAssetReceiptSchema.Type;
const NativeNodeVersionSchema = Schema.Struct({
  id: ZeropsNativeId,
  projectId: ZeropsNativeId,
  sequence: Schema.Int,
  serviceStackId: ZeropsNativeId,
  source: Schema.Literals(['CLI', 'GUI', 'GITHUB', 'GITLAB', 'GIT', 'NONE']),
  status: Schema.Literal('ACTIVE'),
});
export const ImmutableNodeReleaseReceiptSchema = Schema.Struct({
  ...ImmutableNodeAssetReceiptSchema.fields,
  backendMarker: artifact,
  nativeVersion: NativeNodeVersionSchema,
  /** Witnessed exit 0 and unchanged clean checkout; not a cryptographic hash of the remote backend binary. */
  sourceEvidence: Schema.Struct({ kind: Schema.Literal('witnessed-clean-git-push'), sourceRevision }),
  stage: Schema.Literal(NODE_BACKEND_DEPLOYED),
});
export type ImmutableNodeReleaseReceipt = typeof ImmutableNodeReleaseReceiptSchema.Type;
type PublicAssetPlan = ImmutableApplicationReleasePlan | ImmutableNodeReleasePlan;

const fail = (message: string, cause?: unknown) => new ImmutableApplicationReleaseError({ cause, message });

export const resolveCleanImmutableApplicationSourceRevision = Effect.fn('ImmutableApplicationRelease.cleanSource')(
  function* cleanSourceRevision(directory: string) {
    const git = (args: readonly string[]) =>
      runCommand({ args, command: 'git', cwd: directory, env: {}, extendEnv: false }).pipe(
        Effect.mapError((cause) => fail('immutable release publication requires a clean Git checkout', cause)),
      );
    yield* git(['rev-parse', '--show-toplevel']);
    const revision = (yield* git(['rev-parse', '--verify', 'HEAD'])).trim();
    if ((yield* git(['status', '--porcelain=v1', '--untracked-files=all'])).trim() !== '') {
      return yield* fail('immutable release publication requires a clean Git checkout');
    }
    return yield* Schema.decodeUnknownEffect(sourceRevision)(revision).pipe(
      Effect.mapError((cause) => fail('immutable release publication requires a real Git source revision', cause)),
    );
  },
);

export const deriveImmutableApplicationReleasePlan = Effect.fn('ImmutableApplicationRelease.plan')(
  function* makeImmutableReleasePlan(input: {
    readonly appId: string;
    readonly buildMarker: string;
    readonly sourceRevision: string;
    readonly workersDevSubdomain: string;
  }) {
    yield* Schema.decodeUnknownEffect(Schema.Struct({ appId, buildMarker, sourceRevision }), {
      onExcessProperty: 'error',
    })({
      appId: input.appId,
      buildMarker: input.buildMarker,
      sourceRevision: input.sourceRevision,
    }).pipe(Effect.mapError((cause) => fail('release evidence failed validation', cause)));
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(input.workersDevSubdomain)) {
      return yield* fail('an exact Cloudflare workers.dev subdomain is required');
    }
    const [backendScriptName, assetsScriptName] = yield* Effect.all([
      moduleReleaseWorkerName(input.appId, input.buildMarker),
      moduleReleaseAssetWorkerName(input.appId, input.buildMarker),
    ]).pipe(Effect.mapError((cause) => fail('release identity could not be calculated', cause)));
    return {
      appId: input.appId,
      assetsOrigin: `https://${assetsScriptName}.${input.workersDevSubdomain}.workers.dev/`,
      assetsScriptName,
      backendScriptName,
      buildMarker: input.buildMarker,
      sourceRevision: input.sourceRevision,
    } satisfies ImmutableApplicationReleasePlan;
  },
);

export const immutableAssetsWranglerConfig = (
  plan: PublicAssetPlan,
  assetsDirectory: string,
  compatibilityDate: string,
) => ({
  assets: { directory: assetsDirectory, html_handling: 'none', not_found_handling: 'none' },
  compatibility_date: compatibilityDate,
  name: plan.assetsScriptName,
  preview_urls: false,
  workers_dev: true,
});

export const validateReleasePlan = (plan: ImmutableApplicationReleasePlan) =>
  Effect.gen(function* validateReleasePlanEffect() {
    yield* Schema.decodeUnknownEffect(ImmutableApplicationReleasePlanSchema, { onExcessProperty: 'error' })(plan).pipe(
      Effect.mapError((cause) => fail('release plan failed validation', cause)),
    );
    const [backendName, assetsName] = yield* Effect.all([
      moduleReleaseWorkerName(plan.appId, plan.buildMarker),
      moduleReleaseAssetWorkerName(plan.appId, plan.buildMarker),
    ]).pipe(Effect.mapError((cause) => fail('release identity could not be calculated', cause)));
    const origin = URL.parse(plan.assetsOrigin);
    if (
      backendName !== plan.backendScriptName ||
      assetsName !== plan.assetsScriptName ||
      origin === null ||
      origin.href !== plan.assetsOrigin ||
      origin.protocol !== 'https:' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      origin.username !== '' ||
      origin.password !== '' ||
      !new RegExp(`^${assetsName}\\.[a-z\\d](?:[a-z\\d-]*[a-z\\d])?\\.workers\\.dev$`, 'u').test(origin.hostname)
    ) {
      return yield* fail('provider names and assets origin must identify the exact immutable release');
    }
    return yield* Effect.void;
  });

export const validateImmutableNodeReleasePlan = Effect.fn('ImmutableNodeRelease.validatePlan')(
  function* validateNodePlan(plan: ImmutableNodeReleasePlan) {
    yield* Schema.decodeUnknownEffect(ImmutableNodeReleasePlanSchema, { onExcessProperty: 'error' })(plan).pipe(
      Effect.mapError((cause) => fail('Node release plan failed validation', cause)),
    );
    if (plan.backend.baseUrl === plan.assetsOrigin) {
      return yield* fail('the Node API deployment origin cannot be an assets-only Worker');
    }
    const name = yield* moduleReleaseAssetWorkerName(plan.appId, plan.buildMarker).pipe(
      Effect.mapError((cause) => fail('Node asset identity is invalid', cause)),
    );
    const origin = URL.parse(plan.assetsOrigin);
    if (
      name !== plan.assetsScriptName ||
      origin === null ||
      origin.href !== plan.assetsOrigin ||
      origin.protocol !== 'https:' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      origin.username !== '' ||
      origin.password !== '' ||
      !new RegExp(`^${name}\\.[a-z\\d](?:[a-z\\d-]*[a-z\\d])?\\.workers\\.dev$`, 'u').test(origin.hostname)
    ) {
      return yield* fail('Node assets must use the existing exact immutable Worker release origin');
    }
    return yield* Effect.void;
  },
);
const validatePublicAssetPlan = (plan: PublicAssetPlan) =>
  Schema.is(ImmutableNodeReleasePlanSchema)(plan) ? validateImmutableNodeReleasePlan(plan) : validateReleasePlan(plan);

export interface ReleaseFile {
  readonly bytes: Uint8Array;
  readonly path: string;
}
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const InventorySchema = Schema.Array(Schema.Struct({ path: Schema.String, sha256, size: Schema.Number }));
const inventoryHash = Effect.fn('ImmutableApplicationRelease.inventoryHash')(function* inventoryHashEffect(
  files: readonly ReleaseFile[],
) {
  const inventory = EffectArray.sort(
    files,
    Order.mapInput(Order.String, (file: ReleaseFile) => file.path),
  ).map((file) => ({ path: file.path, sha256: hash(file.bytes), size: file.bytes.byteLength }));
  return hash(yield* Schema.encodeEffect(Schema.fromJsonString(InventorySchema))(inventory));
});
export const decodeUtf8 = (bytes: Uint8Array) =>
  Effect.try({
    catch: (cause) => fail('release artifact is not exact UTF-8', cause),
    try: () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  });
const ReleaseContractSchema = Schema.Struct({ deployment: Schema.Struct({ appId, buildMarker }) });
const ManifestSchema = Schema.Struct({
  exposes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        assets: Schema.Struct({
          css: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
          js: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
        }),
      }),
    ),
  ),
  metaData: Schema.Struct({
    publicPath: Schema.String,
    remoteEntry: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String,
        path: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  remoteEntry: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  remotes: Schema.optionalKey(Schema.Array(Schema.Json)),
  shared: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        assets: Schema.Struct({
          css: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
          js: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
        }),
      }),
    ),
  ),
});

const federationEntrypoints = (manifest: typeof ManifestSchema.Type): readonly string[] => {
  const { remoteEntry } = manifest.metaData;
  if (remoteEntry === undefined) {
    return manifest.remoteEntry === undefined ? [] : [manifest.remoteEntry.name];
  }
  return [`${remoteEntry.path ?? ''}${remoteEntry.name}`];
};

const ShellRouteAssetsSchema = Schema.Struct({
  routeAssets: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      assets: Schema.Array(Schema.NonEmptyString),
      referenceCssAssets: Schema.Array(Schema.NonEmptyString),
    }),
  ),
});

const isShellConsumerManifest = (manifest: typeof ManifestSchema.Type) => {
  const { remoteEntry } = manifest.metaData;
  return (
    remoteEntry?.name === '' &&
    remoteEntry.path === '' &&
    remoteEntry.type === 'global' &&
    manifest.remoteEntry === undefined &&
    manifest.exposes?.length === 0 &&
    manifest.remotes?.length === 0
  );
};

const shellConsumerEntrypoints = Effect.fn('ImmutableApplicationRelease.shellConsumerEntrypoints')(
  function* nativeShellConsumerEntrypoints(
    assetsOrigin: string,
    manifest: typeof ManifestSchema.Type,
    assets: ReadonlyMap<string, ReleaseFile['bytes']>,
  ) {
    if (!isShellConsumerManifest(manifest)) {
      return yield* fail('a Shell consumer manifest must not declare a remote producer or static remotes');
    }
    const routesBytes = assets.get('routes-manifest.json');
    if (routesBytes === undefined) {
      return yield* fail('a Shell consumer release requires its native route asset manifest');
    }
    const routes = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellRouteAssetsSchema))(
      yield* decodeUtf8(routesBytes),
    ).pipe(Effect.mapError((cause) => fail('the native Shell route asset manifest is invalid', cause)));
    const routeAssets = Object.values(routes.routeAssets);
    if (routeAssets.length === 0 || routeAssets.some((route) => !route.assets.some((entry) => entry.endsWith('.js')))) {
      return yield* fail('every native Shell route must retain a compiled client entrypoint');
    }
    const nativeEntries = routeAssets.flatMap((route) => [...route.assets, ...route.referenceCssAssets]);
    const { origin } = new URL(assetsOrigin);
    const paths: string[] = [];
    for (const entry of nativeEntries) {
      const destination = URL.parse(entry, assetsOrigin);
      if (
        destination === null ||
        destination.origin !== origin ||
        destination.search !== '' ||
        destination.hash !== '' ||
        destination.username !== '' ||
        destination.password !== '' ||
        ![destination.href, destination.pathname, destination.pathname.slice(1)].includes(entry)
      ) {
        return yield* fail('native Shell route assets must identify exact files within the immutable origin');
      }
      paths.push(destination.pathname.slice(1));
    }
    return paths;
  },
);

const validateReleaseFilePaths = Effect.fn('ImmutableApplicationRelease.filePaths')(
  function* validateReleaseFilePathsEffect(files: readonly ReleaseFile[]) {
    const paths = new Set<string>();
    for (const file of files) {
      if (
        !/^[\w.@$()[\]-]+(?:\/[\w.@$()[\]-]+)*$/u.test(file.path) ||
        file.path.split('/').some((part) => part === '..' || part === '.') ||
        paths.has(file.path)
      ) {
        return yield* fail('artifact inventory contains an unsafe or duplicate path', { path: file.path });
      }
      paths.add(file.path);
    }
    return yield* Effect.void;
  },
);

const validateImmutablePublicAssetInventory = Effect.fn('ImmutableApplicationRelease.publicInventory')(
  function* validateImmutablePublicAssetInventoryEffect(assets: readonly ReleaseFile[]) {
    yield* validateReleaseFilePaths(assets);
    if (
      assets.some((file) =>
        /(?:\.map(?:\.(?:gz|br))?$|(?:^|\/)(?:\.env|worker|server|node_modules|credentials|private-key)(?:[./]|$)|\.(?:pem|key)$)/u.test(
          file.path,
        ),
      )
    ) {
      return yield* fail('public release assets contain private runtime files or sourcemaps');
    }
    return yield* Effect.void;
  },
);

const validateReleaseInventory = Effect.fn('ImmutableApplicationRelease.validateInventory')(
  function* validateReleaseInventoryEffect(
    assets: readonly ReleaseFile[],
    backendFiles: readonly ReleaseFile[],
    backendEntrypoint: string,
  ) {
    yield* validateImmutablePublicAssetInventory(assets);
    yield* validateReleaseFilePaths(backendFiles);
    if (!backendFiles.some((file) => file.path === backendEntrypoint)) {
      return yield* fail('the complete compiled Worker entrypoint is missing');
    }
    return yield* Effect.void;
  },
);

interface ImmutablePublicReleaseArtifacts {
  readonly assetsSha256: string;
  readonly federationManifest?: { readonly sha256: string; readonly url: string };
}

export const validateImmutablePublicAssets = Effect.fn('ImmutableApplicationRelease.publicAssets')(
  function* validateImmutablePublicAssetsEffect(plan: PublicAssetPlan, files: readonly ReleaseFile[]) {
    yield* validatePublicAssetPlan(plan);
    yield* validateImmutablePublicAssetInventory(files);
    const assets = new Map(files.map((file) => [file.path, file.bytes]));
    const manifestBytes = assets.get('mf-manifest.json');
    if (manifestBytes !== undefined) {
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema))(
        yield* decodeUtf8(manifestBytes),
      ).pipe(Effect.mapError((cause) => fail('Federation release manifest is invalid', cause)));
      if (manifest.metaData.publicPath !== plan.assetsOrigin) {
        return yield* fail('Federation publicPath must already point at the immutable release origin');
      }
      const entries =
        plan.appId === SHELL_APP_ID
          ? yield* shellConsumerEntrypoints(plan.assetsOrigin, manifest, assets)
          : federationEntrypoints(manifest);
      const required = [
        ...entries,
        ...[...(manifest.exposes ?? []), ...(manifest.shared ?? [])].flatMap(({ assets: asset }) => [
          ...asset.js.sync,
          ...asset.js.async,
          ...asset.css.sync,
          ...asset.css.async,
        ]),
      ];
      if (entries.length === 0 || required.some((entry) => !assets.has(entry.replace(/^\/+/u, '')))) {
        return yield* fail('Federation manifest references an absent release entrypoint or chunk');
      }
    }
    const artifacts: ImmutablePublicReleaseArtifacts = { assetsSha256: yield* inventoryHash(files) };
    return manifestBytes === undefined
      ? artifacts
      : {
          ...artifacts,
          federationManifest: { sha256: hash(manifestBytes), url: `${plan.assetsOrigin}mf-manifest.json` },
        };
  },
);

export const validateImmutableApplicationReleaseArtifacts = Effect.fn('ImmutableApplicationRelease.artifacts')(
  function* validateImmutableReleaseArtifactsEffect(
    plan: ImmutableApplicationReleasePlan,
    input: {
      readonly assets: readonly ReleaseFile[];
      readonly backendEntrypoint: string;
      readonly backendFiles: readonly ReleaseFile[];
      readonly contract: { readonly deployment: { readonly appId: string; readonly buildMarker: string } };
      readonly deliveryUnit: { readonly buildMarker: string; readonly sourceRevision: string; readonly unitId: string };
    },
  ) {
    yield* validateReleasePlan(plan);
    if (
      input.deliveryUnit.sourceRevision !== plan.sourceRevision ||
      input.deliveryUnit.buildMarker !== plan.buildMarker ||
      input.deliveryUnit.unitId !== `app/${plan.appId}` ||
      input.contract.deployment.appId !== plan.appId ||
      input.contract.deployment.buildMarker !== plan.buildMarker
    ) {
      return yield* fail(
        'compiled Worker, deployment contract and release plan must identify the same clean source release',
      );
    }
    yield* validateReleaseInventory(input.assets, input.backendFiles, input.backendEntrypoint);
    const assets = new Map(input.assets.map((file) => [file.path, file.bytes]));
    const contractBytes = assets.get(OWNER_CONTRACT_PATH);
    if (contractBytes === undefined) {
      return yield* fail('the exact deployment contract must be part of the immutable public assets');
    }
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseContractSchema))(
      yield* decodeUtf8(contractBytes),
    ).pipe(Effect.mapError((cause) => fail('release contract bytes are invalid', cause)));
    if (contract.deployment.appId !== plan.appId || contract.deployment.buildMarker !== plan.buildMarker) {
      return yield* fail('published contract bytes identify a different release');
    }
    const artifacts: ImmutableApplicationReleaseReceipt['artifacts'] = {
      ...(yield* validateImmutablePublicAssets(plan, input.assets)),
      contract: { sha256: hash(contractBytes), url: `${plan.assetsOrigin}.well-known/ontos-module-manifest.json` },
      workerSha256: yield* inventoryHash(input.backendFiles),
    };
    return artifacts;
  },
);

interface ImmutableApplicationReleaseCandidateModule {
  readonly appId: string;
  readonly backend: typeof ApplicationCompositionCloudflareWorkerBackendSchema.Type;
  readonly contract: typeof ApplicationCompositionArtifactReferenceSchema.Type;
  readonly deployment: typeof OntosDeploymentIdentitySchema.Type;
  readonly federationManifest?: typeof ApplicationCompositionArtifactReferenceSchema.Type;
}

const shellReceiptArtifacts = Effect.fn('ImmutableApplicationRelease.shellReceipt')(
  function* shellReceiptArtifactsEffect(raw: ImmutableShellArtifactReceipt) {
    const receipt = yield* Schema.decodeUnknownEffect(ImmutableShellArtifactReceiptSchema, {
      onExcessProperty: 'error',
    })(raw).pipe(Effect.mapError((cause) => fail('the retained Shell artifact receipt failed validation', cause)));
    yield* validateReleasePlan(receipt.plan);
    if (
      receipt.plan.appId !== SHELL_APP_ID ||
      receipt.artifacts.runtimeContract.url !== `${receipt.plan.assetsOrigin}.well-known/ontos-shell-runtime.json` ||
      receipt.artifacts.federationManifest.url !== `${receipt.plan.assetsOrigin}mf-manifest.json`
    ) {
      return yield* fail('the Shell artifact receipt must identify the exact retained Shell release');
    }
    return {
      deployment: { appId: SHELL_APP_ID, buildMarker: receipt.plan.buildMarker },
      federationManifest: receipt.artifacts.federationManifest,
      runtimeContract: receipt.artifacts.runtimeContract,
    } satisfies (typeof ApplicationCompositionPublicationCandidateSchema.Type)['shell'];
  },
);

export interface ImmutableApplicationReleaseReceiptResolutionInput {
  readonly approvedBaseline?: ActiveApplicationCompositionSnapshot;
  readonly currentSourceRevision: string;
  readonly intent: ApplicationReleaseIntent;
  readonly receipts: readonly ImmutableApplicationReleaseReceipt[];
  readonly selection: ApplicationReleaseSelection;
}

interface ImmutableApplicationReleaseCandidateInput extends ImmutableApplicationReleaseReceiptResolutionInput {
  readonly shellReceipt?: ImmutableShellArtifactReceipt;
}

const sameReleaseIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const validateReceiptPartition = Effect.fn('ImmutableApplicationRelease.receiptPartition')(function* receiptPartition(
  input: Pick<ImmutableApplicationReleaseReceiptResolutionInput, 'approvedBaseline' | 'intent' | 'selection'>,
) {
  yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema, { onExcessProperty: 'error' })(input.intent).pipe(
    Effect.mapError((cause) => fail('the reviewed complete release intent failed validation', cause)),
  );
  yield* Schema.decodeUnknownEffect(ApplicationReleaseSelectionSchema, { onExcessProperty: 'error' })(
    input.selection,
  ).pipe(Effect.mapError((cause) => fail('release selection failed validation', cause)));
  const desired = input.intent.modules.map(({ appId: selectedAppId }) => selectedAppId);
  const complete = input.selection.complete.map(({ id }) => id);
  const partition = [...input.selection.fresh, ...input.selection.retained].map(({ id }) => id);
  const slots = new Set(desired);
  if (
    slots.size !== desired.length ||
    slots.has(SHELL_APP_ID) ||
    !sameReleaseIds(desired, complete) ||
    partition.length !== desired.length ||
    new Set(partition).size !== desired.length ||
    partition.some((id) => !slots.has(id)) ||
    input.selection.shell.unit.id !== SHELL_APP_ID
  ) {
    return yield* fail(
      'release selection must partition the exact reviewed module membership once with a separate Shell',
    );
  }
  if (input.selection.shell.mode === 'retained' && input.approvedBaseline === undefined) {
    return yield* fail('retained Shell publication requires the captured approved baseline');
  }
  const removed =
    input.approvedBaseline?.composition.modules
      .filter(({ deployment }) => !slots.has(deployment.appId))
      .map(({ deployment }) => deployment.appId) ?? [];
  if (
    !sameReleaseIds(
      removed,
      input.selection.removed.map(({ appId: removedAppId }) => removedAppId),
    )
  ) {
    return yield* fail('removed release slots must match the captured baseline and reviewed membership');
  }
  return { fresh: new Set(input.selection.fresh.map(({ id }) => id)), slots };
});

const validateDeploymentReceipt = Effect.fn('ImmutableApplicationRelease.deploymentReceipt')(
  function* deploymentReceipt(raw: ImmutableApplicationReleaseReceipt) {
    yield* validateReleasePlan(raw.plan);
    if (
      raw.backend.workerName !== raw.plan.backendScriptName ||
      raw.backend.baseUrl !==
        raw.plan.assetsOrigin.replace(`${raw.plan.assetsScriptName}.`, `${raw.plan.backendScriptName}.`) ||
      raw.artifacts.contract.url !== `${raw.plan.assetsOrigin}.well-known/ontos-module-manifest.json` ||
      (raw.artifacts.federationManifest !== undefined &&
        raw.artifacts.federationManifest.url !== `${raw.plan.assetsOrigin}mf-manifest.json`)
    ) {
      return yield* fail('candidate requires unique, retained, exact release deployment receipts');
    }
    return yield* Effect.void;
  },
);

const validateRetainedReceipt = Effect.fn('ImmutableApplicationRelease.retainedReceipt')(function* retainedReceipt(
  receipt: ImmutableApplicationReleaseReceipt,
  baseline: ActiveApplicationCompositionSnapshot,
) {
  const previous = baseline.composition.modules.find(({ deployment }) => deployment.appId === receipt.plan.appId);
  if (previous === undefined) {
    return yield* fail('retained release receipt has no captured approved module slot');
  }
  if (previous.backend.transport !== 'cloudflare-worker') {
    return yield* fail('Cloudflare release receipts cannot prove retained Node backend artifacts');
  }
  const previousManifest = previous.federation.execution === 'browser' ? previous.federation.manifest : undefined;
  if (
    previous.deployment.buildMarker !== receipt.plan.buildMarker ||
    previous.contract.url !== receipt.artifacts.contract.url ||
    previous.contract.sha256 !== receipt.artifacts.contract.sha256 ||
    previous.backend.baseUrl !== receipt.backend.baseUrl ||
    previous.backend.workerName !== receipt.backend.workerName ||
    previous.backend.versionId !== receipt.backend.versionId ||
    previousManifest?.url !== receipt.artifacts.federationManifest?.url ||
    previousManifest?.sha256 !== receipt.artifacts.federationManifest?.sha256
  ) {
    return yield* fail(
      'retained release receipt differs from the captured approved deployment, contract, federation or backend',
    );
  }
  return yield* Effect.void;
});

/** Resolves original receipts only. Runtime authority and native artifact existence remain independent gates. */
export const resolveImmutableApplicationReleaseReceipts = Effect.fn('ImmutableApplicationRelease.resolveReceipts')(
  function* resolveReceipts(input: ImmutableApplicationReleaseReceiptResolutionInput) {
    const currentRevision = yield* Schema.decodeUnknownEffect(sourceRevision)(input.currentSourceRevision).pipe(
      Effect.mapError((cause) => fail('the current release source revision is invalid', cause)),
    );
    const approved =
      input.approvedBaseline === undefined
        ? undefined
        : yield* validateActiveApplicationCompositionSnapshot(input.approvedBaseline).pipe(
            Effect.mapError((cause) => fail('the retained approved snapshot is invalid or expired', cause)),
          );
    const partitionInput = approved === undefined ? input : { ...input, approvedBaseline: approved };
    const { fresh, slots } = yield* validateReceiptPartition(partitionInput);
    yield* Schema.decodeUnknownEffect(Schema.Array(ImmutableApplicationReleaseReceiptSchema), {
      onExcessProperty: 'error',
    })(input.receipts).pipe(Effect.mapError((cause) => fail('release receipt failed validation', cause)));
    const byApp = new Map(input.receipts.map((receipt) => [receipt.plan.appId, receipt]));
    if (byApp.size !== input.receipts.length || input.receipts.length !== slots.size) {
      return yield* fail('every selected module requires exactly one retained deployment receipt');
    }
    const ordered: ImmutableApplicationReleaseReceipt[] = [];
    for (const { id } of input.selection.complete) {
      const receipt = byApp.get(id);
      if (receipt === undefined) {
        return yield* fail('candidate requires unique, retained, exact release deployment receipts');
      }
      yield* validateDeploymentReceipt(receipt);
      if (fresh.has(id)) {
        if (receipt.plan.sourceRevision !== currentRevision) {
          return yield* fail('fresh release receipts must identify the actual current source revision');
        }
      } else {
        if (approved === undefined) {
          return yield* fail('retained release receipts require the captured approved baseline');
        }
        yield* validateRetainedReceipt(receipt, approved);
      }
      ordered.push(receipt);
    }
    return ordered;
  },
);

export const makeImmutableApplicationReleasePublicationCandidate = Effect.fn('ImmutableApplicationRelease.candidate')(
  function* publicationCandidateEffect(input: ImmutableApplicationReleaseCandidateInput) {
    const receipts = yield* resolveImmutableApplicationReleaseReceipts(input);
    const baseline = {
      retainedModuleAppIds: input.selection.retained.map(({ id }) => id),
      revision: input.approvedBaseline?.composition.revision ?? null,
      shellMode: input.selection.shell.mode,
    };
    const modules = receipts.map((receipt) => {
      const module: ImmutableApplicationReleaseCandidateModule = {
        appId: receipt.plan.appId,
        backend: receipt.backend,
        contract: receipt.artifacts.contract,
        deployment: { appId: receipt.plan.appId, buildMarker: receipt.plan.buildMarker },
      };
      return receipt.artifacts.federationManifest === undefined
        ? module
        : { ...module, federationManifest: receipt.artifacts.federationManifest };
    });
    if (input.selection.shell.mode === 'fresh') {
      if (input.shellReceipt === undefined) {
        return yield* fail('fresh Shell publication requires its genuine current-source Shell receipt');
      }
      const shell = yield* shellReceiptArtifacts(input.shellReceipt);
      if (input.shellReceipt.plan.sourceRevision !== input.currentSourceRevision) {
        return yield* fail('fresh Shell publication requires its genuine current-source Shell receipt');
      }
      return { baseline, modules, shell };
    }
    if (input.shellReceipt !== undefined || input.approvedBaseline === undefined) {
      return yield* fail('retained Shell publication requires only the captured approved baseline artifact source');
    }
    const approved = yield* validateActiveApplicationCompositionSnapshot(input.approvedBaseline).pipe(
      Effect.mapError((cause) => fail('the retained approved snapshot is invalid or expired', cause)),
    );
    yield* assertRetainedReleaseArtifactPaths(approved).pipe(
      Effect.mapError((cause) => fail('the approved snapshot does not identify retained native release assets', cause)),
    );
    const { deployment, federationManifest, runtimeContract } = approved.composition.shell;
    return {
      baseline,
      modules,
      shell: { deployment, federationManifest, runtimeContract },
    };
  },
);

export const readReleaseFiles = (
  root: string,
  base = '',
): Effect.Effect<readonly ReleaseFile[], PlatformError | ImmutableApplicationReleaseError, FileSystem.FileSystem> =>
  Effect.gen(function* readReleaseFilesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const canonicalRoot = yield* fileSystem.realPath(root);
    const files: ReleaseFile[] = [];
    for (const name of yield* fileSystem.readDirectory(path.join(canonicalRoot, base))) {
      const relative = base === '' ? name : `${base}/${name}`;
      const location = path.join(canonicalRoot, relative);
      if ((yield* fileSystem.realPath(location)) !== location) {
        return yield* fail('release inventory may not include symbolic links');
      }
      const info = yield* fileSystem.stat(location);
      if (info.type === 'Directory') {
        files.push(...(yield* readReleaseFiles(canonicalRoot, relative)));
      } else if (info.type === 'File') {
        files.push({ bytes: yield* fileSystem.readFile(location), path: relative });
      } else {
        return yield* fail('release inventory must contain only regular files and directories');
      }
    }
    return files;
  });

export const readImmutablePublicReleaseFiles = Effect.fn('ImmutableApplicationRelease.publicFiles')(
  function* readImmutablePublicReleaseFilesEffect(root: string) {
    const files = yield* readReleaseFiles(root);
    yield* validateReleaseFilePaths(files);
    return files.filter((file) => !/\.map(?:\.(?:gz|br))?$/u.test(file.path));
  },
);

export const materializeImmutablePublicAssets = Effect.fn('ImmutableApplicationRelease.materializePublicAssets')(
  function* materializeImmutablePublicAssetsEffect(files: readonly ReleaseFile[], directory?: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* validateImmutablePublicAssetInventory(files);
    const destination = yield* fileSystem.makeTempDirectoryScoped({
      directory,
      prefix: 'ontos-immutable-assets-',
    });
    for (const file of files) {
      const location = path.join(destination, file.path);
      yield* fileSystem.makeDirectory(path.dirname(location), { recursive: true });
      yield* fileSystem.writeFile(location, file.bytes);
    }
    return destination;
  },
);

const WranglerSchema = Schema.StructWithRest(
  Schema.Struct({
    alias: Schema.optionalKey(Schema.Json),
    assets: Schema.StructWithRest(Schema.Struct({ directory: Schema.NonEmptyString }), [
      Schema.Record(Schema.String, Schema.Json),
    ]),
    build: Schema.optionalKey(Schema.Json),
    compatibility_date: Schema.NonEmptyString,
    define: Schema.optionalKey(Schema.Json),
    main: Schema.NonEmptyString,
    minify: Schema.optionalKey(Schema.Json),
    no_bundle: Schema.optionalKey(Schema.Boolean),
    rules: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          fallthrough: Schema.optionalKey(Schema.Boolean),
          globs: Schema.Array(Schema.String),
          type: Schema.Literals([
            'ESModule',
            'CommonJS',
            'CompiledWasm',
            'Data',
            'Text',
            'PythonModule',
            'PythonRequirement',
          ]),
        }),
      ),
    ),
    tsconfig: Schema.optionalKey(Schema.Json),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const DeliveryUnitSchema = Schema.Struct({
  deliveryUnit: Schema.Struct({ buildMarker, sourceRevision, unitId: deliveryUnitIdSchema }),
});
const ApiEnvelope = Schema.Struct({ result: Schema.Json, success: Schema.Boolean });
const PinnedNativeTools = Schema.Struct({
  devDependencies: Schema.Struct({
    wrangler: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/u)),
  }),
});

export const verifyPinnedWrangler = Effect.fn('ImmutableApplicationRelease.nativeToolchain')(
  function* verifyPinnedWranglerEffect(directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const tools = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PinnedNativeTools))(
      yield* fileSystem.readFileString(path.join(directory, 'package.json')),
    ).pipe(Effect.mapError((cause) => fail('the delivery unit must pin its exact native Wrangler version', cause)));
    const version = yield* runCommand({
      args: ['exec', 'wrangler', '--version'],
      command: 'pnpm',
      cwd: directory,
    }).pipe(Effect.mapError((cause) => fail('the pinned native Wrangler toolchain is unavailable', cause)));
    if (version.trim() !== tools.devDependencies.wrangler) {
      return yield* fail('the resolved native Wrangler version differs from the delivery unit toolchain pin');
    }
    return yield* Effect.void;
  },
);

const verifyNativeReleaseOutput = Effect.fn('ImmutableApplicationRelease.nativeEnvelope')(
  function* verifyNativeReleaseOutputEffect(output: string, plan: PublicAssetPlan, expectedKind: ReleaseEnvelopeKind) {
    const fileSystem = yield* FileSystem.FileSystem;
    const envelopeMismatch = Schema.is(ImmutableNodeReleasePlanSchema)(plan)
      ? 'the native Node release envelope does not bind the final artifact bytes'
      : NATIVE_ENVELOPE_MISMATCH;
    const serializedEnvelope = yield* fileSystem
      .readFileString(path.join(output, MICROVERTICAL_RELEASE_ENVELOPE_PATH))
      .pipe(Effect.mapError((cause) => fail(envelopeMismatch, cause)));
    const envelopeValue = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
      serializedEnvelope,
    ).pipe(Effect.mapError((cause) => fail(envelopeMismatch, cause)));
    const envelope = yield* Effect.tryPromise({
      catch: (cause) => fail(envelopeMismatch, cause),
      try: async () =>
        await verifyMicroVerticalReleaseEnvelope(envelopeValue, {
          artifactRoot: output,
          expectedKind,
          expectedTarget: Schema.is(ImmutableNodeReleasePlanSchema)(plan) ? 'node' : 'cloudflare',
        }),
    });
    if (
      envelope.identity.unitId !== `app/${plan.appId}` ||
      envelope.identity.buildMarker !== plan.buildMarker ||
      envelope.identity.sourceRevision !== plan.sourceRevision
    ) {
      return yield* fail('the native Cloudflare release envelope identifies a different planned source release');
    }
    return envelope;
  },
);

export const readVerifiedReleaseFiles = Effect.fn('ImmutableApplicationRelease.verifiedFiles')(
  function* readVerifiedReleaseFilesEffect(
    output: string,
    plan: PublicAssetPlan,
    ownedPaths: readonly string[] = [],
    expectedKind: ReleaseEnvelopeKind = MICROVERTICAL_RELEASE_ENVELOPE_KIND,
  ) {
    const envelope = yield* verifyNativeReleaseOutput(output, plan, expectedKind);
    const boundPaths = new Set(envelope.artifacts.map(({ logicalPath }) => logicalPath));
    const temporaryPaths = ownedPaths.map((owned) => path.relative(output, owned).split(path.sep).join('/'));
    const files = (yield* readReleaseFiles(output)).filter(
      (file) => !temporaryPaths.some((owned) => file.path === owned || file.path.startsWith(`${owned}/`)),
    );
    if (files.some((file) => file.path !== MICROVERTICAL_RELEASE_ENVELOPE_PATH && !boundPaths.has(file.path))) {
      return yield* fail('the compiled release contains a file absent from its native artifact envelope');
    }
    return files;
  },
);

export const requirePlannedSourceRevision = Effect.fn('ImmutableApplicationRelease.requirePlannedSource')(
  function* requirePlannedSourceRevisionEffect(directory: string, plan: PublicAssetPlan, message: string) {
    if ((yield* resolveCleanImmutableApplicationSourceRevision(directory)) !== plan.sourceRevision) {
      return yield* fail(message);
    }
    return yield* Effect.void;
  },
);

export const validateImmutableAssetRedirects = Effect.fn('ImmutableApplicationRelease.assetRedirects')(
  function* validateImmutableAssetRedirectsEffect(directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const redirectsFile = path.join(directory, '_redirects');
    if (yield* fileSystem.exists(redirectsFile)) {
      const redirects = yield* fileSystem.readFileString(redirectsFile);
      if (redirects.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'))) {
        return yield* fail('immutable release asset delivery must not redirect any artifact URL');
      }
    }
    return yield* Effect.void;
  },
);

export const verifyRetainedPublicAsset = Effect.fn('ImmutableApplicationRelease.assetReadback')(
  function* verifyRetainedPublicAssetEffect(plan: PublicAssetPlan, file: ReleaseFile) {
    const client = yield* HttpClient.HttpClient;
    const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
    const url = `${plan.assetsOrigin}${encodedPath}`;
    const bytes = new Uint8Array(file.bytes.byteLength);
    let lastNotReady: ImmutableAssetNotReadyError | null = null;
    const attempt = Effect.scoped(
      Effect.gen(function* readRetainedPublicAssetAttempt() {
        const response = yield* client.get(url);
        if (response.status === 404) {
          yield* response.stream.pipe(Stream.runDrain);
          return false;
        }
        if (response.status !== 200) {
          return yield* fail('the deployed immutable public asset did not return HTTP 200', {
            path: file.path,
            status: response.status,
          });
        }
        const headerState = {
          hasCacheHeader: response.headers['cache-control'] !== undefined,
          hasCorsHeader: response.headers['access-control-allow-origin'] !== undefined,
          hasImmutableCache: response.headers['cache-control']?.includes('immutable') ?? false,
          hasNoSniff: response.headers['x-content-type-options'] === 'nosniff',
          hasNoSniffHeader: response.headers['x-content-type-options'] !== undefined,
          hasPublicCors: response.headers['access-control-allow-origin'] === '*',
          path: file.path,
          status: response.status,
        };
        if (
          file.path === 'robots.txt' &&
          (!headerState.hasPublicCors || !headerState.hasImmutableCache || !headerState.hasNoSniff)
        ) {
          lastNotReady = new ImmutableAssetNotReady({
            cause: headerState,
            message: PUBLIC_ASSET_INVENTORY_MISMATCH,
          });
          yield* response.stream.pipe(Stream.runDrain);
          return false;
        }
        if (!headerState.hasPublicCors || !headerState.hasImmutableCache || !headerState.hasNoSniff) {
          return yield* fail(PUBLIC_ASSET_INVENTORY_MISMATCH, headerState);
        }
        const metadata = {
          contentEncoding: response.headers['content-encoding'] ?? null,
          contentType: response.headers['content-type'] ?? null,
          expectedBytes: bytes.byteLength,
          path: file.path,
          status: response.status,
        };
        const receivedSize = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => 0,
            (received, chunk) => {
              if (received + chunk.byteLength > bytes.byteLength) {
                return Effect.fail(
                  new ImmutableAssetNotReady({
                    cause: { ...metadata, observedBytes: received + chunk.byteLength },
                    message: 'the deployed asset body exceeds its compiled artifact byte length',
                  }),
                );
              }
              return Effect.sync(() => {
                bytes.set(chunk, received);
                return received + chunk.byteLength;
              });
            },
          ),
        );
        if (receivedSize !== file.bytes.byteLength || hash(bytes) !== hash(file.bytes)) {
          return yield* new ImmutableAssetNotReady({
            cause: { ...metadata, observedBytes: receivedSize },
            message: PUBLIC_ASSET_INVENTORY_MISMATCH,
          });
        }
        return true;
      }),
    ).pipe(
      Effect.catchTag('ImmutableAssetNotReady', (cause) => {
        lastNotReady = cause;
        return Effect.succeed(false);
      }),
    );
    return yield* Effect.gen(function* awaitRetainedPublicAssetBytes() {
      while (!(yield* attempt)) {
        yield* Effect.sleep(Duration.seconds(1));
      }
    }).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.catchTag('TimeoutError', (cause) =>
        Effect.fail(lastNotReady === null ? cause : fail(lastNotReady.message, lastNotReady.cause)),
      ),
    );
  },
  Effect.mapError((cause) => fail('immutable release asset readback failed or exceeded its timeout', cause)),
);

const NativeAccountSubdomain = Schema.Struct({
  result: Schema.Struct({ subdomain: Schema.String.check(Schema.isPattern(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u)) }),
  success: Schema.Boolean,
});

export const verifyImmutableAssetsAccountOrigin = Effect.fn('ImmutableApplicationRelease.accountOrigin')(
  function* verifyImmutableAssetsAccountOriginEffect(
    accountId: string,
    token: Redacted.Redacted,
    plan: PublicAssetPlan,
  ) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.bearerToken(
        HttpClientRequest.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`),
        Redacted.value(token),
      ),
    );
    const account = yield* Schema.decodeUnknownEffect(NativeAccountSubdomain)(yield* response.json);
    if (
      response.status !== 200 ||
      !account.success ||
      plan.assetsOrigin !== `https://${plan.assetsScriptName}.${account.result.subdomain}.workers.dev/`
    ) {
      return yield* fail('the immutable assets origin does not belong to the locked Cloudflare account');
    }
    return account.result.subdomain;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) =>
    Schema.is(ImmutableApplicationReleaseError)(cause)
      ? cause
      : fail('the immutable assets account origin could not be observed within its timeout'),
  ),
);

export const readRetainedImmutableWorkerVersion = Effect.fn('ImmutableApplicationRelease.providerVersion')(
  function* readRetainedImmutableWorkerVersionEffect(accountId: string, token: Redacted.Redacted, scriptName: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.bearerToken(
        HttpClientRequest.get(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
        ),
        Redacted.value(token),
      ),
    );
    const history = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        result: Schema.Struct({
          deployments: Schema.Array(
            Schema.Struct({
              versions: Schema.Array(Schema.Struct({ percentage: Schema.Number, version_id: workerVersionIdSchema })),
            }),
          ),
        }),
        success: Schema.Boolean,
      }),
    )(yield* response.json);
    const versions = history.result.deployments[0]?.versions;
    const version = versions?.[0];
    if (response.status !== 200 || !history.success || versions?.length !== 1 || version?.percentage !== 100) {
      return yield* fail('the immutable Worker release has no actual single-version active deployment receipt');
    }
    return version.version_id;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) =>
    Schema.is(ImmutableApplicationReleaseError)(cause)
      ? cause
      : fail('the retained immutable Worker deployment history could not be observed within its timeout'),
  ),
);

const WorkerVisibilityResponse = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ code: Schema.Number }))),
  result: Schema.OptionFromOptionalNullOr(Schema.Struct({ name: Schema.String })),
  success: Schema.Boolean,
});
const NativeWorkerLookupFailure = Schema.Struct({ providerCode: Schema.Number, providerPath: Schema.String });

const completeImmutableAssetsRouting = Effect.fn('ImmutableApplicationRelease.completeAssetsRouting')(
  function* completeImmutableAssetsRoutingEffect(accountId: string, token: Redacted.Redacted, plan: PublicAssetPlan) {
    const client = yield* HttpClient.HttpClient;
    const providerPath = `/accounts/${accountId}/workers/workers/${plan.assetsScriptName}`;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(token)));
    const workerReady = Effect.gen(function* observeUploadedAssetsWorker() {
      const response = yield* execute(HttpClientRequest.get(`https://api.cloudflare.com/client/v4${providerPath}`));
      const observed = yield* Schema.decodeUnknownEffect(WorkerVisibilityResponse)(yield* response.json);
      if (
        response.status === 200 &&
        observed.success &&
        Option.exists(observed.result, (worker) => worker.name === plan.assetsScriptName)
      ) {
        return true;
      }
      if (
        response.status === 404 &&
        !observed.success &&
        observed.errors?.length === 1 &&
        observed.errors[0]?.code === 10_007
      ) {
        return false;
      }
      return yield* fail('the uploaded immutable assets Worker could not be observed', {
        providerPath,
        status: response.status,
      });
    });
    while (!(yield* workerReady)) {
      yield* Effect.sleep(Duration.seconds(1));
    }
    yield* readRetainedImmutableWorkerVersion(accountId, token, plan.assetsScriptName);
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${plan.assetsScriptName}/subdomain`,
      ),
      { enabled: true, previews_enabled: false },
    );
    const response = yield* execute(
      HttpClientRequest.setHeader(request, 'Cloudflare-Workers-Script-Api-Date', '2025-08-01'),
    );
    const acknowledgement = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        result: Schema.Struct({ enabled: Schema.Boolean, previews_enabled: Schema.Boolean }),
        success: Schema.Boolean,
      }),
    )(yield* response.json);
    if (
      response.status !== 200 ||
      !acknowledgement.success ||
      !acknowledgement.result.enabled ||
      acknowledgement.result.previews_enabled
    ) {
      return yield* fail('the immutable assets Worker routing was not enabled with previews disabled');
    }
    return yield* Effect.void;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) => fail('immutable assets routing completion failed or exceeded its timeout', cause)),
);

export const deployImmutableAssets = Effect.fn('ImmutableApplicationRelease.deployAssets')(
  function* deployImmutableAssetsEffect(input: {
    readonly accountId: string;
    readonly appDirectory: string;
    readonly configFile: string;
    readonly plan: PublicAssetPlan;
    readonly token: Redacted.Redacted;
  }) {
    const command = {
      args: ['exec', 'wrangler', 'deploy', '--config', input.configFile],
      captureProviderFailure: true,
      command: 'pnpm',
      cwd: input.appDirectory,
      env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(input.accountId), CLOUDFLARE_API_TOKEN: input.token },
    };
    yield* runCommand(command).pipe(
      Effect.catchTag('OpsCommandError', (failure) =>
        Effect.gen(function* recoverUploadedAssetsRouting() {
          if (
            failure.command !== [command.command, ...command.args].join(' ') ||
            !Schema.is(NativeWorkerLookupFailure)(failure.cause) ||
            failure.cause.providerCode !== 10_007 ||
            failure.cause.providerPath !== `/accounts/${input.accountId}/workers/workers/${input.plan.assetsScriptName}`
          ) {
            return yield* failure;
          }
          return yield* completeImmutableAssetsRouting(input.accountId, input.token, input.plan);
        }),
      ),
    );
  },
);

/** Called only inside the repository's environment-wide serialized publication job. Never deletes a release. */
export const deployImmutableApplicationRelease = Effect.fn('ImmutableApplicationRelease.deploy')(
  function* deployImmutableReleaseEffect(input: {
    readonly appDirectory: string;
    readonly plan: ImmutableApplicationReleasePlan;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const apiToken = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    const secretsText = yield* Config.Redacted('ONTOS_IMMUTABLE_RELEASE_SECRETS');
    const secrets = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(Redacted.value(secretsText)).pipe(Effect.mapError(() => fail('backend secret configuration is invalid')));
    if (!/^[a-f\d]{32}$/u.test(accountId)) {
      return yield* fail('release publication requires an exact Cloudflare account');
    }
    const plan = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleasePlanSchema, {
      onExcessProperty: 'error',
    })(input.plan).pipe(Effect.mapError((cause) => fail('release plan failed validation', cause)));
    yield* validateReleasePlan(plan);
    yield* requirePlannedSourceRevision(
      input.appDirectory,
      plan,
      'the release plan does not identify the current clean Git source revision',
    );
    const output = path.resolve(input.appDirectory, '.output');
    const outputFiles = yield* readVerifiedReleaseFiles(output, plan);
    yield* verifyPinnedWrangler(input.appDirectory);
    const wrangler = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WranglerSchema))(
      yield* fileSystem.readFileString(path.join(output, 'wrangler.json')),
    );
    const delivery = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveryUnitSchema))(
      yield* fileSystem.readFileString(path.join(output, 'server/modern-worker-manifest.json')),
    );
    const assetsDirectory = path.resolve(output, wrangler.assets.directory);
    if (!assetsDirectory.startsWith(`${output}${path.sep}`)) {
      return yield* fail('native public assets must remain inside the compiled release output');
    }
    yield* validateImmutableAssetRedirects(assetsDirectory);
    const compiledAssets = yield* readImmutablePublicReleaseFiles(assetsDirectory);
    const backendFiles = outputFiles.filter(
      (file) => !file.path.startsWith(`${path.relative(output, assetsDirectory).split(path.sep).join('/')}/`),
    );
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseContractSchema))(
      yield* fileSystem.readFileString(path.join(assetsDirectory, OWNER_CONTRACT_PATH)),
    );
    yield* validateImmutableApplicationReleaseArtifacts(plan, {
      assets: compiledAssets,
      backendEntrypoint: wrangler.main.replace(/^\.\//u, ''),
      backendFiles,
      contract,
      deliveryUnit: delivery.deliveryUnit,
    });
    const accountSubdomain = yield* verifyImmutableAssetsAccountOrigin(accountId, apiToken, plan);
    const apiUrl = (suffix: string) => `https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(apiToken))).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail('Cloudflare release request failed')),
      );
    const backendScript = `/workers/scripts/${plan.backendScriptName}`;
    for (const suffix of [backendScript, `/workers/scripts/${plan.assetsScriptName}`]) {
      const current = yield* execute(HttpClientRequest.get(apiUrl(suffix)));
      if (current.status !== 404) {
        return yield* fail(
          current.status === 200
            ? 'an immutable release identity already exists; publication must never overwrite it'
            : 'provider release absence could not be established',
        );
      }
    }
    const deployedAssetsDirectory = yield* materializeImmutablePublicAssets(compiledAssets);
    // Native assets-only Workers apply these bytes directly; the compiled assets stay unchanged.
    yield* fileSystem.writeFileString(
      path.join(deployedAssetsDirectory, '_headers'),
      '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n',
    );
    const assets = yield* readReleaseFiles(deployedAssetsDirectory);
    const artifacts = yield* validateImmutableApplicationReleaseArtifacts(plan, {
      assets,
      backendEntrypoint: wrangler.main.replace(/^\.\//u, ''),
      backendFiles,
      contract,
      deliveryUnit: delivery.deliveryUnit,
    });
    const backendConfig = yield* fileSystem.makeTempFileScoped({
      directory: output,
      prefix: '.wrangler-immutable-backend-',
      suffix: '.json',
    });
    const assetsConfig = yield* fileSystem.makeTempFileScoped({
      directory: output,
      prefix: '.wrangler-immutable-assets-',
      suffix: '.json',
    });
    yield* fileSystem.writeFileString(
      backendConfig,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))({
        ...wrangler,
        assets: { ...wrangler.assets, directory: deployedAssetsDirectory },
        main: path.resolve(output, wrangler.main),
        name: plan.backendScriptName,
        preview_urls: false,
        routes: [],
        workers_dev: true,
      }),
    );
    yield* fileSystem.writeFileString(
      assetsConfig,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        immutableAssetsWranglerConfig(plan, deployedAssetsDirectory, wrangler.compatibility_date),
      ),
    );
    const deploy = (configFile: string, extra: readonly string[]) =>
      runCommand({
        args: ['exec', 'wrangler', 'deploy', '--config', configFile, ...extra],
        command: 'pnpm',
        cwd: input.appDirectory,
        env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId), CLOUDFLARE_API_TOKEN: apiToken },
      });
    const packageDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: 'ontos-immutable-package-',
    });
    yield* deploy(backendConfig, ['--dry-run', '--outdir', packageDirectory]);
    const packagedModules = (yield* readReleaseFiles(packageDirectory)).filter(
      (file) => file.path !== 'README.md' && !file.path.endsWith('.map'),
    );
    const packagedMain =
      wrangler.no_bundle === true ? path.basename(wrangler.main) : `${path.parse(wrangler.main).name}.js`;
    if (!packagedModules.some((file) => file.path === packagedMain)) {
      return yield* fail('the native Worker packager did not capture the complete deployment entrypoint');
    }
    const capturedConfig = {
      ...wrangler,
      assets: { ...wrangler.assets, directory: deployedAssetsDirectory },
      base_dir: packageDirectory,
      find_additional_modules: true,
      main: path.join(packageDirectory, packagedMain),
      name: plan.backendScriptName,
      no_bundle: true,
      preview_urls: false,
      routes: [],
      rules: [{ fallthrough: true, globs: ['**/*.js', '**/*.mjs'], type: 'ESModule' }, ...(wrangler.rules ?? [])],
      upload_source_maps: false,
      workers_dev: true,
    };
    delete capturedConfig.alias;
    delete capturedConfig.build;
    delete capturedConfig.define;
    delete capturedConfig.minify;
    delete capturedConfig.tsconfig;
    yield* fileSystem.writeFileString(
      backendConfig,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(capturedConfig),
    );
    yield* requirePlannedSourceRevision(
      input.appDirectory,
      plan,
      'the source revision changed while preparing the immutable upload package',
    );
    yield* readVerifiedReleaseFiles(output, plan, [
      assetsConfig,
      backendConfig,
      deployedAssetsDirectory,
      packageDirectory,
    ]);
    yield* deploy(backendConfig, ['--no-bundle']);
    for (const [name, text] of Object.entries(secrets)) {
      const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.put(apiUrl(`${backendScript}/secrets`)), {
        name,
        text,
        type: 'secret_text',
      });
      const response = yield* execute(request);
      const envelope = yield* Schema.decodeUnknownEffect(ApiEnvelope)(
        yield* response.json.pipe(Effect.mapError(() => fail('secret installation response is invalid'))),
      ).pipe(Effect.mapError(() => fail('secret installation response is invalid')));
      if ((response.status !== 200 && response.status !== 201) || !envelope.success) {
        return yield* fail('complete backend release secret installation failed');
      }
    }
    yield* deployImmutableAssets({
      accountId,
      appDirectory: input.appDirectory,
      configFile: assetsConfig,
      plan,
      token: apiToken,
    });
    const installed = yield* execute(HttpClientRequest.get(apiUrl(backendScript)));
    if (installed.status !== 200) {
      return yield* fail('complete immutable Worker release was not retained');
    }
    const subdomain = yield* execute(HttpClientRequest.get(apiUrl(`${backendScript}/subdomain`)));
    const subdomainState = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ result: Schema.Struct({ enabled: Schema.Boolean }), success: Schema.Boolean }),
    )(yield* subdomain.json).pipe(Effect.mapError(() => fail('native Worker subdomain readback is invalid')));
    if (subdomain.status !== 200 || !subdomainState.success || !subdomainState.result.enabled) {
      return yield* fail('the immutable backend has no enabled native workers.dev route');
    }
    const installedContent = yield* execute(HttpClientRequest.get(apiUrl(`${backendScript}/content/v2`)));
    if (installedContent.status !== 200) {
      return yield* fail('the provider did not retain the complete immutable Worker module content');
    }
    if (installedContent.headers['cf-entrypoint'] !== packagedMain) {
      return yield* fail('the provider retained a missing or different immutable Worker entrypoint');
    }
    const workerSha256 = yield* verifyImmutableBackendModuleContent(
      packagedModules,
      yield* installedContent.formData.pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail('the retained Worker module content could not be read within its timeout')),
      ),
    ).pipe(
      Effect.mapError((cause) => fail('the deployed Worker differs from the captured native upload package', cause)),
    );
    yield* Effect.forEach(
      assets.filter((file) => !['_headers', '_redirects', ASSETS_IGNORE_FILE].includes(file.path)),
      (file) => verifyRetainedPublicAsset(plan, file),
      { concurrency: 4 },
    );
    const versionId = yield* readRetainedImmutableWorkerVersion(accountId, apiToken, plan.backendScriptName);
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
      baseUrl: `https://${plan.backendScriptName}.${accountSubdomain}.workers.dev/`,
      transport: 'cloudflare-worker',
      versionId,
      workerName: plan.backendScriptName,
    }).pipe(Effect.mapError((cause) => fail('the observed immutable Worker placement is invalid', cause)));
    const assetsVersionId = yield* readRetainedImmutableWorkerVersion(accountId, apiToken, plan.assetsScriptName);
    return {
      artifacts: { ...artifacts, workerSha256 },
      assetsVersionId,
      backend,
      plan,
    } satisfies ImmutableApplicationReleaseReceipt;
  },
  Effect.scoped,
);

const GeneratedNodeUnitSchema = Schema.Struct({
  deliveryUnit: Schema.Struct({
    appId,
    buildMarker: Schema.NonEmptyString,
    unitId: Schema.String.pipe(Schema.brand('UltramodernDeliveryUnitId')),
  }),
});

export const deriveImmutableNodeReleasePlan = Effect.fn('ImmutableNodeRelease.plan')(function* deriveNodePlan(input: {
  readonly appDirectory: string;
  readonly backend: typeof ApplicationCompositionNodeHttpBackendSchema.Type;
  readonly projectId: string;
  readonly serviceId: string;
  readonly setup: string;
  readonly workersDevSubdomain: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const revision = yield* resolveCleanImmutableApplicationSourceRevision(input.appDirectory);
  const generated = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GeneratedNodeUnitSchema))(
    yield* fileSystem.readFileString(path.join(input.appDirectory, 'shared/ultramodern-build.json')),
  ).pipe(Effect.mapError((cause) => fail('Node source delivery-unit metadata is invalid', cause)));
  if (generated.deliveryUnit.unitId !== `app/${generated.deliveryUnit.appId}`) {
    return yield* fail('Node source directory does not identify its own delivery unit');
  }
  const marker = createUltramodernReleaseBuildMarker({
    generationBuildMarker: generated.deliveryUnit.buildMarker,
    sourceRevision: revision,
    unitId: generated.deliveryUnit.unitId,
  });
  const placement = yield* deriveImmutableApplicationReleasePlan({
    appId: generated.deliveryUnit.appId,
    buildMarker: marker,
    sourceRevision: revision,
    workersDevSubdomain: input.workersDevSubdomain,
  });
  const plan = yield* Schema.decodeUnknownEffect(ImmutableNodeReleasePlanSchema, { onExcessProperty: 'error' })({
    appId: placement.appId,
    assetsOrigin: placement.assetsOrigin,
    assetsScriptName: placement.assetsScriptName,
    backend: input.backend,
    buildMarker: marker,
    projectId: input.projectId,
    provider: 'zerops',
    serviceId: input.serviceId,
    setup: input.setup,
    sourceRevision: revision,
  }).pipe(Effect.mapError((cause) => fail('Node plan input is invalid', cause)));
  yield* validateImmutableNodeReleasePlan(plan);
  return plan;
});

export const immutableNodeBuildEnvironment = (plan: ImmutableNodeReleasePlan) => ({
  [`ULTRAMODERN_PUBLIC_URL_${plan.appId.replaceAll('-', '_').toUpperCase()}`]: plan.backend.baseUrl,
  MODERN_ASSET_PREFIX: plan.assetsOrigin,
  ULTRAMODERN_SOURCE_REVISION: plan.sourceRevision,
});

export const validateImmutableNodePublicArtifacts = Effect.fn('ImmutableNodeRelease.publicArtifacts')(
  function* nodeArtifacts(plan: ImmutableNodeReleasePlan, assets: readonly ReleaseFile[]) {
    yield* validateImmutableNodeReleasePlan(plan);
    const common = yield* validateImmutablePublicAssets(plan, assets);
    const expected = plan.appId === SHELL_APP_ID ? '.well-known/ontos-shell-runtime.json' : OWNER_CONTRACT_PATH;
    const bytes = assets.find((file) => file.path === expected)?.bytes;
    if (bytes === undefined) {
      return yield* fail('Node public output is missing its exact owner contract');
    }
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseContractSchema))(
      yield* decodeUtf8(bytes),
    ).pipe(Effect.mapError((cause) => fail('Node public owner contract is invalid', cause)));
    if (contract.deployment.appId !== plan.appId || contract.deployment.buildMarker !== plan.buildMarker) {
      return yield* fail('Node public contract differs from the planned source/build');
    }
    const reference = { sha256: hash(bytes), url: `${plan.assetsOrigin}${expected}` };
    if (plan.appId === SHELL_APP_ID) {
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema), {
        onExcessProperty: 'error',
      })(yield* decodeUtf8(bytes)).pipe(
        Effect.mapError((cause) => fail('Node Shell runtime contract is invalid', cause)),
      );
      if (common.federationManifest === undefined) {
        return yield* fail('Node Shell public output requires its real Federation manifest');
      }
      return yield* Schema.decodeUnknownEffect(NodeArtifactsSchema)({ ...common, runtimeContract: reference });
    }
    return yield* Schema.decodeUnknownEffect(NodeArtifactsSchema)({ ...common, contract: reference });
  },
);

export const readVerifiedNodeReleaseOutput = Effect.fn('ImmutableNodeRelease.output')(function* nodeOutput(
  appDirectory: string,
  plan: ImmutableNodeReleasePlan,
) {
  yield* validateImmutableNodeReleasePlan(plan);
  yield* requirePlannedSourceRevision(
    appDirectory,
    plan,
    'Node plan does not identify the current clean source checkout',
  );
  const output = path.resolve(appDirectory, '.output');
  // SDK verification checks the complete local Node payload, not a fabricated Cloudflare backend package.
  yield* readVerifiedReleaseFiles(
    output,
    plan,
    [],
    plan.appId === SHELL_APP_ID ? SHELL_RELEASE_ENVELOPE_KIND : MICROVERTICAL_RELEASE_ENVELOPE_KIND,
  );
  const publicDirectory = path.join(output, 'public');
  yield* validateImmutableAssetRedirects(publicDirectory);
  const compiledAssets = yield* readImmutablePublicReleaseFiles(publicDirectory);
  const assets = [
    ...compiledAssets.filter((entry) => entry.path !== '_headers'),
    {
      bytes: new TextEncoder().encode(
        '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n',
      ),
      path: '_headers',
    },
  ];
  const artifacts = yield* validateImmutableNodePublicArtifacts(plan, assets);
  const build = assets.find((file) => file.path === 'ultramodern-build.json');
  if (build === undefined) {
    return yield* fail('Node public output lacks its native compiled delivery-unit marker');
  }
  const identity = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveryUnitSchema))(
    yield* decodeUtf8(build.bytes),
  ).pipe(Effect.mapError((cause) => fail('Node compiled delivery-unit marker is invalid', cause)));
  if (
    identity.deliveryUnit.unitId !== `app/${plan.appId}` ||
    identity.deliveryUnit.buildMarker !== plan.buildMarker ||
    identity.deliveryUnit.sourceRevision !== plan.sourceRevision
  ) {
    return yield* fail('Node compiled marker does not bind the planned clean source');
  }
  return { artifacts, assets, build, output };
});

export const deployImmutableNodeAssets = Effect.fn('ImmutableNodeRelease.assets')(function* deployNodeAssets(input: {
  readonly appDirectory: string;
  readonly plan: ImmutableNodeReleasePlan;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const verified = yield* readVerifiedNodeReleaseOutput(input.appDirectory, input.plan);
  yield* verifyPinnedWrangler(input.appDirectory);
  const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
  const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
  yield* verifyImmutableAssetsAccountOrigin(accountId, token, input.plan);
  const assetsDirectory = yield* materializeImmutablePublicAssets(verified.assets);
  const configuration = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-node-assets-' });
  const configFile = path.join(configuration, 'wrangler.json');
  yield* fileSystem.writeFileString(
    configFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      immutableAssetsWranglerConfig(input.plan, assetsDirectory, '2025-08-01'),
    ),
  );
  const client = yield* HttpClient.HttpClient;
  const existence = yield* client
    .execute(
      HttpClientRequest.bearerToken(
        HttpClientRequest.get(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${input.plan.assetsScriptName}`,
        ),
        Redacted.value(token),
      ),
    )
    .pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.mapError(() => fail('Node immutable asset existence could not be checked')),
    );
  const originalVersion =
    existence.status === 200
      ? yield* readRetainedImmutableWorkerVersion(accountId, token, input.plan.assetsScriptName)
      : undefined;
  if (existence.status === 404) {
    yield* deployImmutableAssets({ accountId, appDirectory: input.appDirectory, configFile, plan: input.plan, token });
  } else if (existence.status !== 200) {
    return yield* fail('Node immutable asset existence could not be checked');
  }
  yield* Effect.forEach(
    verified.assets.filter((file) => !['_headers', '_redirects', ASSETS_IGNORE_FILE].includes(file.path)),
    (file) => verifyRetainedPublicAsset(input.plan, file),
    { concurrency: 4, discard: true },
  );
  const assetsVersionId = yield* readRetainedImmutableWorkerVersion(accountId, token, input.plan.assetsScriptName);
  if (originalVersion !== undefined && originalVersion !== assetsVersionId) {
    return yield* fail('the existing immutable asset version changed during reconciliation');
  }
  return {
    artifacts: verified.artifacts,
    assetsVersionId,
    plan: input.plan,
    stage: PUBLIC_ASSETS_RETAINED,
  } satisfies ImmutableNodeAssetReceipt;
}, Effect.scoped);

/** Changes only one selected build prefix; all other materialized YAML values remain native. */
export const materializeImmutableNodePushYaml = Effect.fn('ImmutableNodeRelease.pushYaml')(
  function* nodePushYaml(input: { readonly plan: ImmutableNodeReleasePlan; readonly sourceFile: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(input.sourceFile);
    const document = yield* Effect.try({
      catch: (cause) => fail('materialized Zerops YAML is invalid', cause),
      try: () => parseDocument(source),
    });
    if (document.errors.length !== 0) {
      return yield* fail('materialized Zerops YAML has parse errors');
    }
    const setups = document.get('zerops');
    if (!isSeq(setups)) {
      return yield* fail('materialized Zerops YAML requires its native setup list');
    }
    const matches: number[] = [];
    for (let index = 0; index < setups.items.length; index += 1) {
      if (document.getIn(['zerops', index, 'setup']) === input.plan.setup) {
        matches.push(index);
      }
    }
    const [selected] = matches;
    if (matches.length !== 1 || selected === undefined || !isMap(document.getIn(['zerops', selected, 'build']))) {
      return yield* fail('Node push requires exactly one selected executable setup');
    }
    const variables = document.getIn(['zerops', selected, 'build', 'envVariables']);
    if (variables !== undefined && !isMap(variables)) {
      return yield* fail('Node build environment must be a native YAML mapping');
    }
    document.setIn(['zerops', selected, 'build', 'envVariables', 'MODERN_ASSET_PREFIX'], input.plan.assetsOrigin);
    const apiOriginKey = `ULTRAMODERN_PUBLIC_URL_${input.plan.appId.replaceAll('-', '_').toUpperCase()}`;
    document.setIn(['zerops', selected, 'build', 'envVariables', apiOriginKey], input.plan.backend.baseUrl);
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-node-push-' });
    const file = path.join(directory, 'zerops.yaml');
    yield* fileSystem.writeFileString(file, String(document));
    return file;
  },
);

const equalNativeNodeVersion = (
  left: typeof NativeNodeVersionSchema.Type,
  right: typeof NativeNodeVersionSchema.Type,
): boolean =>
  left.id === right.id &&
  left.projectId === right.projectId &&
  left.serviceStackId === right.serviceStackId &&
  left.sequence === right.sequence &&
  left.source === right.source &&
  left.status === right.status;

const sameArtifact = (left: typeof artifact.Type | undefined, right: typeof artifact.Type | undefined): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined && left.sha256 === right.sha256 && left.url === right.url;
const sameNodeArtifacts = (left: typeof NodeArtifactsSchema.Type, right: typeof NodeArtifactsSchema.Type): boolean =>
  left.assetsSha256 === right.assetsSha256 &&
  sameArtifact(left.contract, right.contract) &&
  sameArtifact(left.federationManifest, right.federationManifest) &&
  sameArtifact(left.runtimeContract, right.runtimeContract);
const validateNodeAssetReceipt = Effect.fn('ImmutableNodeRelease.assetReceipt')(function* nodeAssetReceipt(
  receipt: ImmutableNodeAssetReceipt,
  plan: ImmutableNodeReleasePlan,
) {
  yield* Schema.decodeUnknownEffect(ImmutableNodeAssetReceiptSchema, { onExcessProperty: 'error' })(receipt).pipe(
    Effect.mapError((cause) => fail('Node asset-only evidence is invalid', cause)),
  );
  if (!Schema.toEquivalence(ImmutableNodeReleasePlanSchema)(receipt.plan, plan)) {
    return yield* fail('Node public asset evidence belongs to a different original plan');
  }
  yield* validateImmutableNodeReleasePlan(plan);
  return yield* Effect.void;
});

const assertNodeExpectedSlot = Effect.fn('ImmutableNodeRelease.expectedSlot')(function* expectedNodeSlot(
  receipt: ImmutableNodeAssetReceipt,
  candidate: typeof ApplicationCompositionPublicationCandidateSchema.Type,
) {
  const { artifacts, plan } = receipt;
  if (plan.appId === SHELL_APP_ID) {
    if (
      candidate.shell.deployment.buildMarker !== plan.buildMarker ||
      !sameArtifact(candidate.shell.runtimeContract, artifacts.runtimeContract) ||
      !sameArtifact(candidate.shell.federationManifest, artifacts.federationManifest)
    ) {
      return yield* fail('Node Shell push differs from the exact prepared target');
    }
  } else {
    const slot = candidate.modules.find(({ appId: id }) => id === plan.appId);
    if (
      slot === undefined ||
      slot.deployment.buildMarker !== plan.buildMarker ||
      slot.backend.transport !== 'node-http' ||
      slot.backend.baseUrl !== plan.backend.baseUrl ||
      !sameArtifact(slot.contract, artifacts.contract) ||
      !sameArtifact(slot.federationManifest, artifacts.federationManifest)
    ) {
      return yield* fail('Node stable push differs from its exact prepared target');
    }
  }
  return yield* Effect.void;
});

/** No remote archive hash is claimed: source evidence is this witnessed successful clean-checkout push plus exact live marker. */
export const deployImmutableNodeRelease = Effect.fn('ImmutableNodeRelease.deploy')(function* deployNodeRelease(input: {
  readonly appDirectory: string;
  readonly assetReceipt: ImmutableNodeAssetReceipt;
  readonly candidateFile: string;
  readonly expectedCompositionFile: string;
  readonly intentFile: string;
  readonly selectionFile: string;
  readonly zeropsYamlPath: string;
}) {
  const { plan } = input.assetReceipt;
  const intent = yield* readReviewedApplicationReleaseIntent(input.intentFile);
  const expected = yield* readExpectedPublication({
    candidateFile: input.candidateFile,
    expectedCompositionFile: input.expectedCompositionFile,
    intent,
    selectionFile: input.selectionFile,
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const selection = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema), {
    onExcessProperty: 'error',
  })(yield* fileSystem.readFileString(input.selectionFile)).pipe(
    Effect.mapError((cause) => fail('Node deploy selection is invalid', cause)),
  );
  if (
    plan.appId === SHELL_APP_ID
      ? selection.shell.mode !== 'fresh'
      : !selection.fresh.some(({ id }) => id === plan.appId)
  ) {
    return yield* fail('Node deploy may push only this exact reviewed fresh slot');
  }
  yield* assertNodeExpectedSlot(input.assetReceipt, expected.candidate);
  yield* validateNodeAssetReceipt(input.assetReceipt, plan);
  const verified = yield* readVerifiedNodeReleaseOutput(input.appDirectory, plan);
  if (!sameNodeArtifacts(verified.artifacts, input.assetReceipt.artifacts)) {
    return yield* fail('Node compiled public pins changed after asset upload');
  }
  const gitRoot = (yield* runCommand({
    args: ['rev-parse', '--show-toplevel'],
    command: 'git',
    cwd: input.appDirectory,
    env: {},
    extendEnv: false,
  })).trim();
  if (!path.isAbsolute(gitRoot) || path.relative(gitRoot, path.resolve(input.appDirectory)).startsWith('..')) {
    return yield* fail('Node source directory is outside the witnessed Git checkout');
  }
  const yaml = yield* materializeImmutableNodePushYaml({ plan, sourceFile: input.zeropsYamlPath });
  if (!path.relative(gitRoot, yaml).startsWith('..')) {
    return yield* fail('temporary Node deployment YAML must remain outside the clean Git checkout');
  }
  yield* requirePlannedSourceRevision(gitRoot, plan, 'Node push source changed before deployment');
  return yield* withApplicationCompositionPublicationLock(
    Effect.gen(function* witnessedNodePush() {
      yield* requirePlannedSourceRevision(gitRoot, plan, 'Node source changed while waiting for the publication guard');
      const token = yield* Config.Redacted('ZEROPS_TOKEN');
      yield* runCommand({
        args: [
          'push',
          '--working-dir',
          '.',
          '--zerops-yaml-path',
          yaml,
          '--workspace-state',
          'clean',
          '--deploy-git-folder',
          '--project-id',
          plan.projectId,
          '--service-id',
          plan.serviceId,
          '--setup',
          plan.setup,
          '--version-name',
          plan.sourceRevision,
        ],
        command: 'zcli',
        cwd: gitRoot,
        env: { ZEROPS_TOKEN: token },
      }).pipe(Effect.mapError((cause) => fail('the witnessed clean-source Node push did not succeed', cause)));
      yield* requirePlannedSourceRevision(gitRoot, plan, 'Node source checkout changed during deployment');
      const serviceVariables = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
      )({ [serviceIdVariable(plan.setup)]: plan.serviceId });
      yield* runCommand({
        args: ['--silent', 'active-composition:publish', 'ensure-public-access', '--setup', plan.setup],
        command: 'pnpm',
        cwd: path.join(gitRoot, 'app'),
        env: { STAGE_VARIABLES_JSON: Redacted.make(serviceVariables), ZEROPS_TOKEN: token },
      }).pipe(Effect.mapError((cause) => fail('Node public access did not pass native readback', cause)));
      const api = yield* ZeropsPublicApi;
      const before = yield* api
        .activeAppVersion(plan.projectId, plan.serviceId)
        .pipe(Effect.mapError((cause) => fail('Node native active version readback failed', cause)));
      yield* Effect.forEach(
        verified.assets.filter((file) => !['_headers', '_redirects', ASSETS_IGNORE_FILE].includes(file.path)),
        (file) => verifyRetainedPublicAsset(plan, file),
        { concurrency: 4, discard: true },
      );
      const client = yield* HttpClient.HttpClient;
      // The stable Node backend must actually serve its own compiled marker and owner contract.
      const ownerPath = plan.appId === SHELL_APP_ID ? '.well-known/ontos-shell-runtime.json' : OWNER_CONTRACT_PATH;
      for (const compiled of [verified.build, ...verified.assets.filter((file) => file.path === ownerPath)]) {
        const response = yield* client.get(new URL(compiled.path, plan.backend.baseUrl)).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError(() => fail('Node backend artifact request failed')),
        );
        const received = yield* response.arrayBuffer.pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError(() => fail('Node backend artifact body failed')),
        );
        if (response.status !== 200 || hash(new Uint8Array(received)) !== hash(compiled.bytes)) {
          return yield* fail('live Node backend does not match the planned compiled source marker and contract');
        }
      }
      const after = yield* api
        .activeAppVersion(plan.projectId, plan.serviceId)
        .pipe(Effect.mapError((cause) => fail('Node native active version confirmation failed', cause)));
      if (!equalNativeNodeVersion(before, after)) {
        return yield* fail('the active native Node version changed during exact artifact observation');
      }
      const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
      const cloudflareToken = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
      if (
        (yield* readRetainedImmutableWorkerVersion(accountId, cloudflareToken, plan.assetsScriptName)) !==
        input.assetReceipt.assetsVersionId
      ) {
        return yield* fail('original immutable Node public asset version changed');
      }
      // Re-read local SDK-bound output after provider I/O; no planned metadata is promoted to a receipt on partial success.
      const final = yield* readVerifiedNodeReleaseOutput(input.appDirectory, plan);
      if (!sameNodeArtifacts(final.artifacts, input.assetReceipt.artifacts)) {
        return yield* fail('Node local public output changed during deployment');
      }
      return {
        artifacts: input.assetReceipt.artifacts,
        assetsVersionId: input.assetReceipt.assetsVersionId,
        backendMarker: {
          sha256: hash(verified.build.bytes),
          url: new URL(verified.build.path, plan.backend.baseUrl).href,
        },
        nativeVersion: after,
        plan,
        sourceEvidence: { kind: 'witnessed-clean-git-push', sourceRevision: plan.sourceRevision },
        stage: NODE_BACKEND_DEPLOYED,
      } satisfies ImmutableNodeReleaseReceipt;
    }),
    { baselineRevision: expected.candidate.baseline.revision, targetRevision: expected.composition.revision },
  );
}, Effect.scoped);

const validateNodeReceipt = Effect.fn('ImmutableNodeRelease.validateReceipt')(function* nodeReceipt(
  receipt: ImmutableNodeReleaseReceipt,
) {
  yield* Schema.decodeUnknownEffect(ImmutableNodeReleaseReceiptSchema, { onExcessProperty: 'error' })(receipt).pipe(
    Effect.mapError((cause) => fail('Node deployed receipt is invalid', cause)),
  );
  yield* validateImmutableNodeReleasePlan(receipt.plan);
  if (
    receipt.sourceEvidence.sourceRevision !== receipt.plan.sourceRevision ||
    receipt.nativeVersion.projectId !== receipt.plan.projectId ||
    receipt.nativeVersion.serviceStackId !== receipt.plan.serviceId ||
    receipt.backendMarker.url !== new URL('ultramodern-build.json', receipt.plan.backend.baseUrl).href
  ) {
    return yield* fail('Node receipt does not bind its original source and native placement');
  }
  return yield* Effect.void;
});

const validateNodeArtifactPins = Effect.fn('ImmutableNodeRelease.pins')(function* nodePins(receipt: {
  readonly artifacts: typeof NodeArtifactsSchema.Type;
  readonly plan: ImmutableNodeReleasePlan;
}) {
  const { artifacts, plan } = receipt;
  if (plan.appId === SHELL_APP_ID) {
    if (
      artifacts.contract !== undefined ||
      artifacts.runtimeContract?.url !== `${plan.assetsOrigin}.well-known/ontos-shell-runtime.json` ||
      artifacts.federationManifest?.url !== `${plan.assetsOrigin}mf-manifest.json`
    ) {
      return yield* fail('Node Shell evidence must pin its exact runtime/Federation artifacts');
    }
  } else if (
    artifacts.runtimeContract !== undefined ||
    artifacts.contract?.url !== `${plan.assetsOrigin}.well-known/ontos-module-manifest.json` ||
    (artifacts.federationManifest !== undefined &&
      artifacts.federationManifest.url !== `${plan.assetsOrigin}mf-manifest.json`)
  ) {
    return yield* fail('Node module evidence must pin its exact owner public artifacts');
  }
  return yield* Effect.void;
});

export interface ImmutableNodeCandidateInput {
  readonly approvedBaseline?: ActiveApplicationCompositionSnapshot;
  readonly currentSourceRevision: string;
  readonly freshAssets: readonly ImmutableNodeAssetReceipt[];
  readonly intent: ApplicationReleaseIntent;
  readonly phase: 'preflight' | 'deployed';
  readonly receipts: readonly ImmutableNodeReleaseReceipt[];
  readonly selection: ApplicationReleaseSelection;
  readonly shell: ImmutableNodeAssetReceipt | ImmutableNodeReleaseReceipt;
}

const nodeCandidateModule = Effect.fn('ImmutableNodeRelease.candidateModule')(function* nodeCandidateModuleEffect(
  entry: ImmutableNodeAssetReceipt | ImmutableNodeReleaseReceipt,
  input: {
    readonly currentSourceRevision: string;
    readonly fresh: boolean;
    readonly phase: 'preflight' | 'deployed';
    readonly previous: ActiveApplicationCompositionSnapshot['composition']['modules'][number] | undefined;
  },
) {
  yield* validateImmutableNodeReleasePlan(entry.plan);
  yield* validateNodeArtifactPins(entry);
  if (input.fresh) {
    if (
      entry.plan.sourceRevision !== input.currentSourceRevision ||
      (input.phase === 'preflight' ? entry.stage !== PUBLIC_ASSETS_RETAINED : entry.stage !== NODE_BACKEND_DEPLOYED)
    ) {
      return yield* fail('fresh Node slot has the wrong original source or evidence stage');
    }
  } else {
    const { previous } = input;
    if (
      entry.stage !== NODE_BACKEND_DEPLOYED ||
      previous === undefined ||
      previous.backend.transport !== 'node-http' ||
      previous.backend.baseUrl !== entry.plan.backend.baseUrl ||
      previous.deployment.buildMarker !== entry.plan.buildMarker ||
      !sameArtifact(previous.contract, entry.artifacts.contract) ||
      !sameArtifact(
        previous.federation.execution === 'browser' ? previous.federation.manifest : undefined,
        entry.artifacts.federationManifest,
      )
    ) {
      return yield* fail('retained Node receipt must be the original exact approved deployment, artifacts and backend');
    }
  }
  const { contract } = entry.artifacts;
  if (contract === undefined) {
    return yield* fail('Node module slot lacks its actual owner contract pin');
  }
  const module = {
    appId: entry.plan.appId,
    backend: entry.plan.backend,
    contract,
    deployment: { appId: entry.plan.appId, buildMarker: entry.plan.buildMarker },
  };
  return entry.artifacts.federationManifest === undefined
    ? module
    : { ...module, federationManifest: entry.artifacts.federationManifest };
});

const nodeCandidateShell = Effect.fn('ImmutableNodeRelease.candidateShell')(function* nodeCandidateShellEffect(input: {
  readonly currentSourceRevision: string;
  readonly mode: 'fresh' | 'retained';
  readonly phase: 'preflight' | 'deployed';
  readonly previous: ActiveApplicationCompositionSnapshot['composition']['shell'] | undefined;
  readonly shell: ImmutableNodeAssetReceipt | ImmutableNodeReleaseReceipt;
}) {
  const { shell } = input;
  if (shell.stage === PUBLIC_ASSETS_RETAINED) {
    yield* validateNodeAssetReceipt(shell, shell.plan);
  }
  yield* validateImmutableNodeReleasePlan(shell.plan);
  yield* validateNodeArtifactPins(shell);
  if (shell.plan.appId !== SHELL_APP_ID) {
    return yield* fail('Node candidate requires a separate actual Shell slot');
  }
  if (input.mode === 'fresh') {
    if (
      shell.plan.sourceRevision !== input.currentSourceRevision ||
      (input.phase === 'preflight' ? shell.stage !== PUBLIC_ASSETS_RETAINED : shell.stage !== NODE_BACKEND_DEPLOYED)
    ) {
      return yield* fail('fresh Node Shell has the wrong evidence stage or source');
    }
  } else {
    const { previous } = input;
    if (
      shell.stage !== NODE_BACKEND_DEPLOYED ||
      previous === undefined ||
      previous.deployment.buildMarker !== shell.plan.buildMarker ||
      !sameArtifact(previous.runtimeContract, shell.artifacts.runtimeContract) ||
      !sameArtifact(previous.federationManifest, shell.artifacts.federationManifest)
    ) {
      return yield* fail('retained Node Shell must keep its original approved artifact identities');
    }
  }
  if (shell.stage === NODE_BACKEND_DEPLOYED) {
    yield* validateNodeReceipt(shell);
  }
  const { federationManifest, runtimeContract } = shell.artifacts;
  if (runtimeContract === undefined || federationManifest === undefined) {
    return yield* fail('Node Shell artifact evidence is incomplete');
  }
  return {
    deployment: { appId: SHELL_APP_ID, buildMarker: shell.plan.buildMarker },
    federationManifest,
    runtimeContract,
  };
});

/** Reuses complete reviewed membership; asset-only evidence is admissible exclusively for preflight fresh slots. */
export const makeImmutableNodeReleasePublicationCandidate = Effect.fn('ImmutableNodeRelease.candidate')(
  function* nodeCandidate(input: ImmutableNodeCandidateInput) {
    yield* Schema.decodeUnknownEffect(sourceRevision)(input.currentSourceRevision).pipe(
      Effect.mapError((cause) => fail('Node candidate requires the real current source revision', cause)),
    );
    const approved =
      input.approvedBaseline === undefined
        ? undefined
        : yield* validateActiveApplicationCompositionSnapshot(input.approvedBaseline).pipe(
            Effect.mapError((cause) => fail('Node baseline is invalid or expired', cause)),
          );
    const partitionInput = approved === undefined ? input : { ...input, approvedBaseline: approved };
    const { fresh, slots } = yield* validateReceiptPartition(partitionInput);
    yield* Schema.decodeUnknownEffect(Schema.Literals(['preflight', 'deployed']))(input.phase).pipe(
      Effect.mapError((cause) => fail('Node candidate phase is invalid', cause)),
    );
    if (input.phase === 'deployed' && input.freshAssets.length !== 0) {
      return yield* fail('final Node candidate requires deployed receipts, never asset-only plans');
    }
    yield* Schema.decodeUnknownEffect(Schema.Array(ImmutableNodeAssetReceiptSchema), { onExcessProperty: 'error' })(
      input.freshAssets,
    ).pipe(Effect.mapError((cause) => fail('Node fresh asset evidence is invalid', cause)));
    yield* Effect.forEach(input.receipts, (receipt) => validateNodeReceipt(receipt), { concurrency: 1 });
    const evidence = [...input.freshAssets, ...input.receipts];
    const byApp = new Map(evidence.map((entry) => [entry.plan.appId, entry]));
    if (byApp.size !== evidence.length || evidence.length !== slots.size) {
      return yield* fail('every Node membership slot requires exactly one genuine evidence stage');
    }
    const modules: (typeof ApplicationCompositionPublicationCandidateSchema.Type)['modules'][number][] = [];
    for (const { id } of input.selection.complete) {
      const entry = byApp.get(id);
      if (entry === undefined) {
        return yield* fail('a complete Node publication may not drop a missing slot');
      }
      modules.push(
        yield* nodeCandidateModule(entry, {
          currentSourceRevision: input.currentSourceRevision,
          fresh: fresh.has(id),
          phase: input.phase,
          previous: approved?.composition.modules.find(({ deployment }) => deployment.appId === id),
        }),
      );
    }
    const shell = yield* nodeCandidateShell({
      currentSourceRevision: input.currentSourceRevision,
      mode: input.selection.shell.mode,
      phase: input.phase,
      previous: approved?.composition.shell,
      shell: input.shell,
    });
    const candidate = {
      baseline: {
        retainedModuleAppIds: input.selection.retained.map(({ id }) => id),
        revision: approved?.composition.revision ?? null,
        shellMode: input.selection.shell.mode,
      },
      modules,
      shell,
    };
    return yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
      onExcessProperty: 'error',
    })(candidate).pipe(Effect.mapError((cause) => fail('the complete Node candidate is invalid', cause)));
  },
);

export const observeImmutableNodeReceipt = Effect.fn('ImmutableNodeRelease.observeReceipt')(
  function* observeNodeReceipt(receipt: ImmutableNodeReleaseReceipt) {
    yield* validateNodeReceipt(receipt);
    yield* validateNodeArtifactPins(receipt);
    const api = yield* ZeropsPublicApi;
    const before = yield* api
      .activeAppVersion(receipt.plan.projectId, receipt.plan.serviceId)
      .pipe(Effect.mapError((cause) => fail('retained Node version cannot be observed', cause)));
    if (!equalNativeNodeVersion(before, receipt.nativeVersion)) {
      return yield* fail('retained Node native version is no longer the original approved identity');
    }
    const client = yield* HttpClient.HttpClient;
    const references = [
      receipt.artifacts.contract,
      receipt.artifacts.federationManifest,
      receipt.artifacts.runtimeContract,
    ].flatMap((value) => (value === undefined ? [] : [value]));
    for (const reference of [...references, receipt.backendMarker]) {
      const response = yield* client.get(reference.url).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError((cause) => fail('retained Node artifact readback is unavailable', cause)),
      );
      const bytes = yield* response.arrayBuffer.pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError((cause) => fail('retained Node artifact readback is unavailable', cause)),
      );
      if (response.status !== 200 || hash(new Uint8Array(bytes)) !== reference.sha256) {
        return yield* fail('retained Node artifact differs from its original exact pin');
      }
    }
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    if (
      (yield* readRetainedImmutableWorkerVersion(accountId, token, receipt.plan.assetsScriptName)) !==
      receipt.assetsVersionId
    ) {
      return yield* fail('retained Node public asset Worker version changed');
    }
    const after = yield* api
      .activeAppVersion(receipt.plan.projectId, receipt.plan.serviceId)
      .pipe(Effect.mapError((cause) => fail('retained Node version confirmation failed', cause)));
    if (!equalNativeNodeVersion(before, after)) {
      return yield* fail('retained Node native version changed during observation');
    }
    return yield* Effect.void;
  },
);

/** Preflight rechecks original deployed evidence; planned fresh backends have no native receipt yet. */
export const observeImmutableNodeCandidateReceipts = Effect.fn('ImmutableNodeRelease.observeCandidateReceipts')(
  function* observeNodeCandidateReceipts(input: Pick<ImmutableNodeCandidateInput, 'receipts' | 'shell'>) {
    yield* Effect.forEach(input.receipts, (receipt) => observeImmutableNodeReceipt(receipt), { concurrency: 1 });
    if (input.shell.stage === NODE_BACKEND_DEPLOYED) {
      yield* observeImmutableNodeReceipt(input.shell);
    }
  },
);

const NodePlanDocumentSchema = Schema.Struct({
  ...ImmutableNodeReleasePlanSchema.fields,
  buildEnvironment: Schema.Record(Schema.String, Schema.String),
});
const readNodeDocument = <A, I>(file: string, codec: Schema.Codec<A, I>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(file)),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(codec))),
  );
const nodePlanCommand = Command.make(
  'node-plan',
  {
    appDirectory: Flag.String(APP_DIRECTORY_FLAG),
    backendBaseUrl: Flag.String('backend-base-url'),
    planFile: Flag.String('plan-file'),
    projectId: Flag.String('project-id'),
    serviceId: Flag.String('service-id'),
    setup: Flag.String('setup'),
    workersDevSubdomain: Flag.String('workers-dev-subdomain'),
  },
  ({ appDirectory, backendBaseUrl, planFile, projectId, serviceId, setup, workersDevSubdomain }) =>
    Effect.gen(function* nodePlanCommandEffect() {
      const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionNodeHttpBackendSchema)({
        baseUrl: backendBaseUrl,
        transport: 'node-http',
      }).pipe(Effect.mapError((cause) => fail('declared Node backend is invalid', cause)));
      const plan = yield* deriveImmutableNodeReleasePlan({
        appDirectory,
        backend,
        projectId,
        serviceId,
        setup,
        workersDevSubdomain,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        planFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(NodePlanDocumentSchema))({
          ...plan,
          buildEnvironment: immutableNodeBuildEnvironment(plan),
        }),
      );
    }),
);
const nodeAssetsCommand = Command.make(
  'node-assets',
  {
    appDirectory: Flag.String(APP_DIRECTORY_FLAG),
    assetsReceiptFile: Flag.String(ASSETS_RECEIPT_FLAG),
    planFile: Flag.String('plan-file'),
  },
  ({ appDirectory, assetsReceiptFile, planFile }) =>
    Effect.gen(function* nodeAssetsCommandEffect() {
      const document = yield* readNodeDocument(planFile, NodePlanDocumentSchema);
      const plan = yield* Schema.decodeUnknownEffect(ImmutableNodeReleasePlanSchema)(document);
      const receipt = yield* deployImmutableNodeAssets({ appDirectory, plan });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        assetsReceiptFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ImmutableNodeAssetReceiptSchema))(receipt),
      );
    }).pipe(withApplicationCompositionPublicationLock),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));
const nodeDeployCommand = Command.make(
  'node-deploy',
  {
    appDirectory: Flag.String(APP_DIRECTORY_FLAG),
    assetsReceiptFile: Flag.String(ASSETS_RECEIPT_FLAG),
    candidateFile: Flag.String(CANDIDATE_FILE_FLAG),
    expectedCompositionFile: Flag.String('expected-composition-file'),
    intentFile: Flag.String(INTENT_FILE_FLAG).pipe(Flag.withDefault('topology/application-release-intent.json')),
    receiptFile: Flag.String(RECEIPT_FILE_FLAG),
    selectionFile: Flag.String(SELECTION_FILE_FLAG),
    zeropsYamlPath: Flag.String('zerops-yaml-path'),
  },
  ({
    appDirectory,
    assetsReceiptFile,
    candidateFile,
    expectedCompositionFile,
    intentFile,
    receiptFile,
    selectionFile,
    zeropsYamlPath,
  }) =>
    Effect.gen(function* nodeDeployCommandEffect() {
      const assetReceipt = yield* readNodeDocument(assetsReceiptFile, ImmutableNodeAssetReceiptSchema);
      const receipt = yield* deployImmutableNodeRelease({
        appDirectory,
        assetReceipt,
        candidateFile,
        expectedCompositionFile,
        intentFile,
        selectionFile,
        zeropsYamlPath,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        receiptFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ImmutableNodeReleaseReceiptSchema))(receipt),
      );
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));
const nodeCandidateCommand = Command.make(
  'node-candidate',
  {
    approvedBaselineFile: Flag.String('approved-baseline-file').pipe(Flag.optional),
    assetsReceiptFiles: Flag.String(ASSETS_RECEIPT_FLAG).pipe(Flag.atLeast(0)),
    candidateFile: Flag.String(CANDIDATE_FILE_FLAG),
    intentFile: Flag.String(INTENT_FILE_FLAG),
    phase: Flag.Literals('phase', ['preflight', 'deployed']),
    receiptFiles: Flag.String(RECEIPT_FILE_FLAG).pipe(Flag.atLeast(0)),
    selectionFile: Flag.String(SELECTION_FILE_FLAG),
    shellFile: Flag.String('shell-receipt-file'),
  },
  ({
    approvedBaselineFile,
    assetsReceiptFiles,
    candidateFile,
    intentFile,
    phase,
    receiptFiles,
    selectionFile,
    shellFile,
  }) =>
    Effect.gen(function* nodeCandidateCommandEffect() {
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const selection = yield* readNodeDocument(selectionFile, ApplicationReleaseSelectionSchema);
      const freshAssets = yield* Effect.forEach(
        assetsReceiptFiles,
        (file) => readNodeDocument(file, ImmutableNodeAssetReceiptSchema),
        { concurrency: 1 },
      );
      const receipts = yield* Effect.forEach(
        receiptFiles,
        (file) => readNodeDocument(file, ImmutableNodeReleaseReceiptSchema),
        { concurrency: 1 },
      );
      const shell = yield* readNodeDocument(
        shellFile,
        phase === 'preflight' && selection.shell.mode === 'fresh'
          ? Schema.Union([ImmutableNodeAssetReceiptSchema, ImmutableNodeReleaseReceiptSchema])
          : ImmutableNodeReleaseReceiptSchema,
      );
      const baseline = yield* Option.match(approvedBaselineFile, {
        onNone: () => Effect.succeed(Option.none<ActiveApplicationCompositionSnapshot>()),
        onSome: (file) =>
          FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) => fileSystem.readFileString(file)),
            Effect.flatMap(decodeActiveApplicationCompositionSnapshot),
            Effect.map(Option.some),
          ),
      });
      const input: ImmutableNodeCandidateInput = {
        currentSourceRevision: yield* resolveCleanImmutableApplicationSourceRevision(
          path.resolve(import.meta.dirname, '..'),
        ),
        freshAssets,
        intent,
        phase,
        receipts,
        selection,
        shell,
      };
      const candidate = yield* makeImmutableNodeReleasePublicationCandidate(
        Option.isSome(baseline) ? { ...input, approvedBaseline: baseline.value } : input,
      );
      yield* observeImmutableNodeCandidateReceipts({ receipts, shell });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        candidateFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema))(candidate),
      );
      return yield* Effect.void;
    }),
);

const PlanDocumentSchema = Schema.Struct({
  ...ImmutableApplicationReleasePlanSchema.fields,
  buildEnvironment: Schema.Record(Schema.String, Schema.String),
});

const deployCommand = Command.make(
  'deploy',
  {
    appDirectory: Flag.String(APP_DIRECTORY_FLAG),
    planFile: Flag.String('plan-file'),
    receiptFile: Flag.String(RECEIPT_FILE_FLAG),
  },
  ({ appDirectory, planFile, receiptFile }) =>
    withApplicationCompositionPublicationLock(
      Effect.gen(function* deployCommandEffect() {
        const fileSystem = yield* FileSystem.FileSystem;
        const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableApplicationReleasePlanSchema))(
          yield* fileSystem.readFileString(planFile),
        );
        const receipt = yield* deployImmutableApplicationRelease({ appDirectory, plan });
        yield* fileSystem.writeFileString(
          receiptFile,
          yield* Schema.encodeEffect(Schema.fromJsonString(ImmutableApplicationReleaseReceiptSchema))(receipt),
        );
      }),
    ),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const candidateCommand = Command.make(
  'candidate',
  {
    approvedBaselineFile: Flag.String('approved-baseline-file').pipe(Flag.optional),
    candidateFile: Flag.String(CANDIDATE_FILE_FLAG),
    intentFile: Flag.String(INTENT_FILE_FLAG),
    receiptFiles: Flag.String(RECEIPT_FILE_FLAG).pipe(Flag.atLeast(0)),
    selectionFile: Flag.String(SELECTION_FILE_FLAG),
    shellReceiptFile: Flag.String('shell-receipt-file').pipe(Flag.optional),
  },
  ({ approvedBaselineFile, candidateFile, intentFile, receiptFiles, selectionFile, shellReceiptFile }) =>
    Effect.gen(function* candidateCommandEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const receipts = yield* Effect.forEach(
        receiptFiles,
        (file) =>
          fileSystem
            .readFileString(file)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableApplicationReleaseReceiptSchema)),
              ),
            ),
        { concurrency: 4 },
      );
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const shellReceipt = yield* Option.match(shellReceiptFile, {
        onNone: () => Effect.succeed(Option.none<ImmutableShellArtifactReceipt>()),
        onSome: (file) =>
          fileSystem
            .readFileString(file)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableShellArtifactReceiptSchema))),
              Effect.map(Option.some),
            ),
      });
      const approvedBaseline = yield* Option.match(approvedBaselineFile, {
        onNone: () => Effect.succeed(Option.none<ActiveApplicationCompositionSnapshot>()),
        onSome: (file) =>
          fileSystem
            .readFileString(file)
            .pipe(Effect.flatMap(decodeActiveApplicationCompositionSnapshot), Effect.map(Option.some)),
      });
      const selection = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema), {
        onExcessProperty: 'error',
      })(yield* fileSystem.readFileString(selectionFile));
      const input: ImmutableApplicationReleaseCandidateInput = {
        currentSourceRevision: yield* resolveCleanImmutableApplicationSourceRevision(
          path.resolve(import.meta.dirname, '..'),
        ),
        intent,
        receipts,
        selection,
      };
      const withShell = Option.match(shellReceipt, {
        onNone: () => input,
        onSome: (receipt) => ({ ...input, shellReceipt: receipt }),
      });
      const candidateInput = Option.match(approvedBaseline, {
        onNone: () => withShell,
        onSome: (baseline) => ({ ...withShell, approvedBaseline: baseline }),
      });
      const candidate = yield* makeImmutableApplicationReleasePublicationCandidate(candidateInput);
      yield* fileSystem.writeFileString(
        candidateFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema))(candidate),
      );
    }),
);

const planCommand = Command.make(
  'plan',
  {
    planFile: Flag.String('plan-file'),
    vertical: Flag.String('vertical'),
    workersDevSubdomain: Flag.String('workers-dev-subdomain'),
  },
  ({ planFile, vertical, workersDevSubdomain }) =>
    Effect.gen(function* planCommandEffect() {
      const workspaceRoot = path.resolve(import.meta.dirname, '..');
      const cleanRevision = yield* resolveCleanImmutableApplicationSourceRevision(workspaceRoot);
      const contract = yield* deriveOntosModuleDeploymentContract({ vertical, workspaceRoot });
      const revision = yield* Effect.try({
        catch: (cause) => fail('source revision cannot be resolved', cause),
        try: () => resolveUltramodernSourceRevision(workspaceRoot),
      });
      if (revision !== cleanRevision) {
        yield* fail('the configured source revision does not identify the current clean Git checkout');
      }
      const plan = yield* deriveImmutableApplicationReleasePlan({
        ...contract.deployment,
        sourceRevision: revision,
        workersDevSubdomain,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        planFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(PlanDocumentSchema))({
          ...plan,
          buildEnvironment: {
            [`ULTRAMODERN_PUBLIC_URL_${plan.appId.replaceAll('-', '_').toUpperCase()}`]: plan.assetsOrigin,
            MODERN_ASSET_PREFIX: plan.assetsOrigin,
            ULTRAMODERN_SOURCE_REVISION: cleanRevision,
          },
        }),
      );
    }),
);

const command = Command.make('immutable-application-release').pipe(
  Command.withSubcommands([
    applicationReleaseSelectCommand,
    planCommand,
    deployCommand,
    candidateCommand,
    nodePlanCommand,
    nodeAssetsCommand,
    nodeDeployCommand,
    nodeCandidateCommand,
  ]),
);
const executableLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(
    Layer.mergeAll(
      OpsShellLive,
      FetchHttpClient.layer,
      ZeropsPublicApiLive.pipe(Layer.provide(FetchHttpClient.layer)),
      Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'error' }),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);
if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped));
}
