#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  MICROVERTICAL_RELEASE_ENVELOPE_PATH,
  verifyCloudflareReleaseEnvelopeStaging,
} from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { resolveUltramodernSourceRevision } from '@modern-js/app-tools-extensions/release-identity';
import {
  Array as EffectArray,
  Config,
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
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type { PlatformError } from 'effect/PlatformError';

import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../packages/core-runtime/src/http/module-release-identity.ts';
import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import { ApplicationCompositionCloudflareWorkerBackendSchema } from '../packages/core-runtime/src/modules/application-composition.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import { decodeActiveApplicationCompositionSnapshot } from './active-application-composition.mts';
import {
  ApplicationCompositionPublicationCandidateSchema,
  assertRetainedReleaseArtifactPaths,
} from './publish-active-application-composition.mts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';
import {
  ApplicationReleaseIntentSchema,
  applicationReleaseSelectCommand,
  readReviewedApplicationReleaseIntent,
} from './application-release-intent.mts';
import type { ApplicationReleaseIntent } from './application-release-intent.mts';
import { verifyImmutableBackendModuleContent } from './immutable-backend-package.mts';
import { OpsShellLive, runCommand } from './ops/ops-shell.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationLock,
} from './application-composition-authority-publication.mts';

export class ImmutableApplicationReleaseError extends Schema.TaggedError<ImmutableApplicationReleaseError>()(
  'ImmutableApplicationReleaseError',
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const SHELL_APP_ID = 'shell-super-app';

const sourceRevision = Schema.String.check(Schema.isPattern(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u));
const buildMarker = Schema.String.check(Schema.isPattern(/^[a-f\d]{16}$/u));
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
  plan: ImmutableApplicationReleasePlan,
  assetsDirectory: string,
  compatibilityDate: string,
) => ({
  assets: { directory: assetsDirectory, html_handling: 'none', not_found_handling: 'none' },
  compatibility_date: compatibilityDate,
  name: plan.assetsScriptName,
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
    remoteEntry: Schema.optionalKey(Schema.Struct({ name: Schema.String, path: Schema.optionalKey(Schema.String) })),
  }),
  remoteEntry: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
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

const validateReleaseFilePaths = Effect.fn('ImmutableApplicationRelease.filePaths')(
  function* validateReleaseFilePathsEffect(files: readonly ReleaseFile[]) {
    const paths = new Set<string>();
    for (const file of files) {
      if (
        !/^[\w.@$()-]+(?:\/[\w.@$()-]+)*$/u.test(file.path) ||
        file.path.split('/').some((part) => part === '..' || part === '.') ||
        paths.has(file.path)
      ) {
        return yield* fail('artifact inventory contains an unsafe or duplicate path');
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
  function* validateImmutablePublicAssetsEffect(plan: ImmutableApplicationReleasePlan, files: readonly ReleaseFile[]) {
    yield* validateReleasePlan(plan);
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
      const entries = federationEntrypoints(manifest);
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
    const contractBytes = assets.get('.well-known/ontos-module-manifest.json');
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
  readonly contractUrl: string;
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

export const makeImmutableApplicationReleasePublicationCandidate = Effect.fn('ImmutableApplicationRelease.candidate')(
  function* publicationCandidateEffect(
    receipts: readonly ImmutableApplicationReleaseReceipt[],
    intent: ApplicationReleaseIntent,
    shellReceipt?: ImmutableShellArtifactReceipt,
    retainedSnapshot?: ActiveApplicationCompositionSnapshot,
  ) {
    yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema, { onExcessProperty: 'error' })(intent).pipe(
      Effect.mapError((cause) => fail('the reviewed complete release intent failed validation', cause)),
    );
    const selection = new Set(intent.modules.map((module) => module.appId));
    if (selection.size !== intent.modules.length || selection.has(SHELL_APP_ID) || receipts.length !== selection.size) {
      return yield* fail('every selected module requires exactly one retained deployment receipt');
    }
    const identities = new Set<string>();
    const modules = [];
    for (const raw of receipts) {
      const receipt = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseReceiptSchema, {
        onExcessProperty: 'error',
      })(raw).pipe(Effect.mapError((cause) => fail('release receipt failed validation', cause)));
      yield* validateReleasePlan(receipt.plan);
      if (
        identities.has(receipt.plan.appId) ||
        !selection.has(receipt.plan.appId) ||
        receipt.backend.workerName !== receipt.plan.backendScriptName ||
        receipt.backend.baseUrl !==
          receipt.plan.assetsOrigin.replace(
            `${receipt.plan.assetsScriptName}.`,
            `${receipt.plan.backendScriptName}.`,
          ) ||
        receipt.artifacts.contract.url !== `${receipt.plan.assetsOrigin}.well-known/ontos-module-manifest.json` ||
        (receipt.artifacts.federationManifest !== undefined &&
          receipt.artifacts.federationManifest.url !== `${receipt.plan.assetsOrigin}mf-manifest.json`)
      ) {
        return yield* fail('candidate requires unique, retained, exact release deployment receipts');
      }
      identities.add(receipt.plan.appId);
      const module: ImmutableApplicationReleaseCandidateModule = {
        appId: receipt.plan.appId,
        backend: receipt.backend,
        contractUrl: receipt.artifacts.contract.url,
      };
      modules.push(
        receipt.artifacts.federationManifest === undefined
          ? module
          : { ...module, federationManifestUrl: receipt.artifacts.federationManifest.url },
      );
    }
    if (shellReceipt !== undefined) {
      if (retainedSnapshot !== undefined) {
        return yield* fail('publication requires exactly one genuine Shell artifact source');
      }
      return { modules, shell: yield* shellReceiptArtifacts(shellReceipt) };
    }
    if (retainedSnapshot === undefined) {
      return yield* fail('publication requires a genuine Shell receipt or captured approved snapshot');
    }
    const approved = yield* validateActiveApplicationCompositionSnapshot(retainedSnapshot).pipe(
      Effect.mapError((cause) => fail('the retained approved snapshot is invalid or expired', cause)),
    );
    yield* assertRetainedReleaseArtifactPaths(approved).pipe(
      Effect.mapError((cause) => fail('the approved snapshot does not identify retained native release assets', cause)),
    );
    const { deployment, federationManifest, runtimeContract } = approved.composition.shell;
    return {
      modules,
      retainedShellRevision: approved.composition.revision,
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
  function* verifyNativeReleaseOutputEffect(output: string, plan: ImmutableApplicationReleasePlan) {
    const envelope = yield* Effect.tryPromise({
      catch: (cause) => fail('the native Cloudflare release envelope does not bind the final artifact bytes', cause),
      try: async () => await verifyCloudflareReleaseEnvelopeStaging(output),
    });
    if (
      envelope === undefined ||
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
    plan: ImmutableApplicationReleasePlan,
    ownedPaths: readonly string[] = [],
  ) {
    const envelope = yield* verifyNativeReleaseOutput(output, plan);
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
  function* requirePlannedSourceRevisionEffect(
    directory: string,
    plan: ImmutableApplicationReleasePlan,
    message: string,
  ) {
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
  function* verifyRetainedPublicAssetEffect(plan: ImmutableApplicationReleasePlan, file: ReleaseFile) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${plan.assetsOrigin}${file.path}`);
    const bytes = new Uint8Array(file.bytes.byteLength);
    const receivedSize = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => 0,
        (received, chunk) => {
          if (received + chunk.byteLength > bytes.byteLength) {
            return Effect.fail(fail('the deployed asset body exceeds its compiled artifact byte length'));
          }
          return Effect.sync(() => {
            bytes.set(chunk, received);
            return received + chunk.byteLength;
          });
        },
      ),
    );
    if (
      response.status !== 200 ||
      receivedSize !== file.bytes.byteLength ||
      hash(bytes) !== hash(file.bytes) ||
      response.headers['access-control-allow-origin'] !== '*' ||
      !response.headers['cache-control']?.includes('immutable') ||
      response.headers['x-content-type-options'] !== 'nosniff'
    ) {
      return yield* fail('the deployed immutable public release does not serve the exact compiled asset inventory');
    }
    return yield* Effect.void;
  },
  Effect.timeout(Duration.seconds(30)),
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
    plan: ImmutableApplicationReleasePlan,
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
      yield* fileSystem.readFileString(path.join(assetsDirectory, '.well-known/ontos-module-manifest.json')),
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
      if (response.status !== 200 || !envelope.success) {
        return yield* fail('complete backend release secret installation failed');
      }
    }
    yield* deploy(assetsConfig, []);
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
      assets.filter((file) => !['_headers', '_redirects', '.assetsignore'].includes(file.path)),
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

const PlanDocumentSchema = Schema.Struct({
  ...ImmutableApplicationReleasePlanSchema.fields,
  buildEnvironment: Schema.Record(Schema.String, Schema.String),
});

const deployCommand = Command.make(
  'deploy',
  {
    appDirectory: Flag.String('app-directory'),
    planFile: Flag.String('plan-file'),
    receiptFile: Flag.String('receipt-file'),
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
    candidateFile: Flag.String('candidate-file'),
    intentFile: Flag.String('intent-file'),
    receiptFiles: Flag.String('receipt-file').pipe(Flag.atLeast(0)),
    retainedShellSnapshotFile: Flag.String('retained-shell-snapshot-file').pipe(Flag.optional),
    shellReceiptFile: Flag.String('shell-receipt-file').pipe(Flag.optional),
  },
  ({ candidateFile, intentFile, receiptFiles, retainedShellSnapshotFile, shellReceiptFile }) =>
    Effect.gen(function* candidateCommandEffect() {
      if (Option.isSome(shellReceiptFile) === Option.isSome(retainedShellSnapshotFile)) {
        yield* fail('select exactly one genuine Shell receipt or captured approved snapshot file');
      }
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
      const retainedSnapshot = yield* Option.match(retainedShellSnapshotFile, {
        onNone: () => Effect.succeed(Option.none<ActiveApplicationCompositionSnapshot>()),
        onSome: (file) =>
          fileSystem
            .readFileString(file)
            .pipe(Effect.flatMap(decodeActiveApplicationCompositionSnapshot), Effect.map(Option.some)),
      });
      const candidate = yield* makeImmutableApplicationReleasePublicationCandidate(
        receipts,
        intent,
        Option.getOrUndefined(shellReceipt),
        Option.getOrUndefined(retainedSnapshot),
      );
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
  Command.withSubcommands([applicationReleaseSelectCommand, planCommand, deployCommand, candidateCommand]),
);
const executableLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(
    Layer.mergeAll(
      OpsShellLive,
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'error' }),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);
if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped));
}
