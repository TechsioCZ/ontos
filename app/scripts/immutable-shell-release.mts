#!/usr/bin/env node
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { createUltramodernReleaseBuildMarker } from '@modern-js/app-tools-extensions/release-identity';
import { Config, Duration, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { OntosShellRuntimeContractSchema } from '../packages/core-runtime/src/modules/application-composition.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationLock,
} from './application-composition-authority-publication.mts';
import {
  ImmutableApplicationReleaseError,
  ImmutableApplicationReleasePlanSchema,
  ImmutableShellArtifactReceiptSchema,
  decodeUtf8,
  hash,
  immutableAssetsWranglerConfig,
  deriveImmutableApplicationReleasePlan,
  materializeImmutablePublicAssets,
  readImmutablePublicReleaseFiles,
  readReleaseFiles,
  readRetainedImmutableWorkerVersion,
  readVerifiedReleaseFiles,
  requirePlannedSourceRevision,
  resolveCleanImmutableApplicationSourceRevision,
  validateImmutableAssetRedirects,
  validateImmutablePublicAssets,
  validateReleasePlan,
  verifyImmutableAssetsAccountOrigin,
  verifyPinnedWrangler,
  verifyRetainedPublicAsset,
} from './immutable-application-release.mts';
import type {
  ImmutableApplicationReleasePlan,
  ImmutableShellArtifactReceipt,
  ReleaseFile,
} from './immutable-application-release.mts';
import { OpsShellLive, runCommand } from './ops/ops-shell.mts';
import { assertPublishedShellIngressSnapshot } from './publish-active-application-composition.mts';

const SHELL_ID = 'shell-super-app';
const RUNTIME_PATH = '.well-known/ontos-shell-runtime.json';
const FEDERATION_PATH = 'mf-manifest.json';
const SOURCE_MISMATCH = 'the Shell artifact plan does not identify the current clean Git source revision';
const IMMUTABLE_HEADERS =
  '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n';
const fail = (message: string, cause?: unknown) => new ImmutableApplicationReleaseError({ cause, message });
const JsonText = Schema.fromJsonString(Schema.Json);
const ShellTopologySchema = Schema.Struct({
  shell: Schema.Struct({
    cloudflare: Schema.Struct({ workerName: Schema.NonEmptyString }),
    deliveryUnit: Schema.Struct({ buildMarker: Schema.NonEmptyString, unitId: Schema.Literal('app/shell-super-app') }),
    id: Schema.Literal(SHELL_ID),
  }),
});
const NativeOutputConfigSchema = Schema.Struct({
  assets: Schema.Struct({ directory: Schema.NonEmptyString }),
  compatibility_date: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});
const PlanDocumentSchema = Schema.Struct({
  ...ImmutableApplicationReleasePlanSchema.fields,
  buildEnvironment: Schema.Struct({ MODERN_ASSET_PREFIX: Schema.String, ULTRAMODERN_SOURCE_REVISION: Schema.String }),
});

/** Shell pages keep their stable origin; only frontend chunks use this retained asset origin. */
const makeImmutableShellReleasePlan = Effect.fn('ImmutableShellRelease.plan')(function* shellReleasePlan(input: {
  readonly workersDevSubdomain: string;
  readonly workspaceRoot: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const sourceRevision = yield* resolveCleanImmutableApplicationSourceRevision(input.workspaceRoot);
  const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellTopologySchema))(
    yield* fileSystem.readFileString(path.join(input.workspaceRoot, 'topology/reference-topology.json')),
  );
  const buildMarker = createUltramodernReleaseBuildMarker({
    generationBuildMarker: topology.shell.deliveryUnit.buildMarker,
    sourceRevision,
    unitId: topology.shell.deliveryUnit.unitId,
  });
  return yield* deriveImmutableApplicationReleasePlan({
    appId: SHELL_ID,
    buildMarker,
    sourceRevision,
    workersDevSubdomain: input.workersDevSubdomain,
  });
});

export const validateImmutableShellReleaseArtifacts = Effect.fn('ImmutableShellRelease.artifacts')(
  function* shellReleaseArtifacts(
    plan: ImmutableApplicationReleasePlan,
    input: { readonly assets: readonly ReleaseFile[] },
  ) {
    yield* validateReleasePlan(plan);
    if (plan.appId !== SHELL_ID) {
      return yield* fail('a Shell asset release must identify the Shell deployment');
    }
    const publicArtifacts = yield* validateImmutablePublicAssets(plan, input.assets);
    const assets = new Map(input.assets.map((file) => [file.path, file.bytes]));
    const runtimeBytes = assets.get(RUNTIME_PATH);
    const manifestBytes = assets.get(FEDERATION_PATH);
    if (runtimeBytes === undefined || manifestBytes === undefined) {
      return yield* fail('the complete Shell asset release must retain its runtime contract and federation manifest');
    }
    const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema), {
      onExcessProperty: 'error',
    })(yield* decodeUtf8(runtimeBytes)).pipe(
      Effect.mapError((cause) => fail('Shell runtime artifact is invalid', cause)),
    );
    if (runtime.deployment.buildMarker !== plan.buildMarker) {
      return yield* fail('the Shell runtime artifact identifies a different planned release');
    }
    if (publicArtifacts.federationManifest === undefined) {
      return yield* fail('a retained Shell release must include its federation manifest');
    }
    return {
      ...publicArtifacts,
      federationManifest: publicArtifacts.federationManifest,
      runtimeContract: { sha256: hash(runtimeBytes), url: `${plan.assetsOrigin}${RUNTIME_PATH}` },
    };
  },
);

const verifyShellOutput = Effect.fn('ImmutableShellRelease.output')(function* shellOutput(
  appDirectory: string,
  plan: ImmutableApplicationReleasePlan,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* validateReleasePlan(plan);
  if (plan.appId !== SHELL_ID) {
    return yield* fail('Shell publication must identify the Shell deployment');
  }
  yield* requirePlannedSourceRevision(appDirectory, plan, SOURCE_MISMATCH);
  const output = path.resolve(appDirectory, '.output');
  yield* readVerifiedReleaseFiles(output, plan);
  const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NativeOutputConfigSchema))(
    yield* fileSystem.readFileString(path.join(output, 'wrangler.json')),
  ).pipe(Effect.mapError((cause) => fail('the native Shell output configuration is invalid', cause)));
  const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellTopologySchema))(
    yield* fileSystem.readFileString(path.resolve(appDirectory, '../../topology/reference-topology.json')),
  );
  if (config.name !== topology.shell.cloudflare.workerName) {
    return yield* fail('the native Shell ingress must match its reviewed execution placement');
  }
  const assetsDirectory = path.resolve(output, config.assets.directory);
  if (!assetsDirectory.startsWith(`${output}${path.sep}`)) {
    return yield* fail('native Shell assets must remain inside the verified output');
  }
  yield* validateImmutableAssetRedirects(assetsDirectory);
  const assets = yield* readImmutablePublicReleaseFiles(assetsDirectory);
  yield* validateImmutableShellReleaseArtifacts(plan, { assets });
  yield* verifyPinnedWrangler(appDirectory);
  return { assets, assetsDirectory, config, output };
});

const verifyRetainedShellAssetBytes = (plan: ImmutableApplicationReleasePlan, assets: readonly ReleaseFile[]) =>
  Effect.forEach(
    assets.filter((file) => !['_headers', '_redirects', '.assetsignore'].includes(file.path)),
    (file) => verifyRetainedPublicAsset(plan, file),
    { concurrency: 4, discard: true },
  );

export const deployImmutableShellRelease = Effect.fn('ImmutableShellRelease.deploy')(
  function* deployShellAssets(input: {
    readonly appDirectory: string;
    readonly plan: ImmutableApplicationReleasePlan;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    if (!/^[a-f\d]{32}$/u.test(accountId)) {
      return yield* fail('Shell asset publication requires an exact provider account');
    }
    const { assets: compiledAssets, config, output } = yield* verifyShellOutput(input.appDirectory, input.plan);
    yield* verifyImmutableAssetsAccountOrigin(accountId, token, input.plan);
    const providerUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${input.plan.assetsScriptName}`;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(token))).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail('the Shell asset provider request failed or exceeded its timeout')),
      );
    const current = yield* execute(HttpClientRequest.get(providerUrl));
    if (current.status !== 404) {
      return yield* fail(
        current.status === 200
          ? 'an immutable Shell asset release already exists; it must never be overwritten'
          : 'provider Shell release absence could not be established',
      );
    }
    const retainedAssets = yield* materializeImmutablePublicAssets(compiledAssets, output);
    yield* fileSystem.writeFileString(path.join(retainedAssets, '_headers'), IMMUTABLE_HEADERS);
    const assets = yield* readReleaseFiles(retainedAssets);
    const artifacts = yield* validateImmutableShellReleaseArtifacts(input.plan, { assets });
    const configFile = yield* fileSystem.makeTempFileScoped({
      directory: output,
      prefix: '.wrangler-immutable-shell-config-',
      suffix: '.json',
    });
    yield* fileSystem.writeFileString(
      configFile,
      yield* Schema.encodeEffect(JsonText)(
        immutableAssetsWranglerConfig(input.plan, retainedAssets, config.compatibility_date),
      ),
    );
    yield* requirePlannedSourceRevision(input.appDirectory, input.plan, SOURCE_MISMATCH);
    yield* readVerifiedReleaseFiles(output, input.plan, [retainedAssets, configFile]);
    yield* runCommand({
      args: ['exec', 'wrangler', 'deploy', '--config', configFile],
      command: 'pnpm',
      cwd: input.appDirectory,
      env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId), CLOUDFLARE_API_TOKEN: token },
    });
    yield* verifyRetainedShellAssetBytes(input.plan, assets);
    const assetsVersionId = yield* readRetainedImmutableWorkerVersion(accountId, token, input.plan.assetsScriptName);
    return { artifacts, assetsVersionId, plan: input.plan } satisfies ImmutableShellArtifactReceipt;
  },
  Effect.scoped,
  withApplicationCompositionPublicationLock,
);

/** The one public Shell ingress is deployed separately from its retained frontend artifact release. */
export const deployImmutableShellIngress = Effect.fn('ImmutableShellRelease.ingress')(
  function* deployShellIngress(input: {
    readonly appDirectory: string;
    readonly receipt: ImmutableShellArtifactReceipt;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const receipt = yield* Schema.decodeUnknownEffect(ImmutableShellArtifactReceiptSchema, {
      onExcessProperty: 'error',
    })(input.receipt);
    const {
      assets: compiledAssets,
      assetsDirectory,
      config,
      output,
    } = yield* verifyShellOutput(input.appDirectory, receipt.plan);
    const runtime = yield* fileSystem.readFile(path.join(assetsDirectory, RUNTIME_PATH));
    const federation = yield* fileSystem.readFile(path.join(assetsDirectory, FEDERATION_PATH));
    if (
      hash(runtime) !== receipt.artifacts.runtimeContract.sha256 ||
      hash(federation) !== receipt.artifacts.federationManifest.sha256 ||
      receipt.artifacts.runtimeContract.url !== `${receipt.plan.assetsOrigin}${RUNTIME_PATH}` ||
      receipt.artifacts.federationManifest.url !== `${receipt.plan.assetsOrigin}${FEDERATION_PATH}`
    ) {
      return yield* fail('the Shell ingress must use the exact retained runtime and frontend release receipt');
    }
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    const secretsText = yield* Config.Redacted('ONTOS_IMMUTABLE_RELEASE_SECRETS');
    const secrets = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(Redacted.value(secretsText)).pipe(
      Effect.mapError(() => fail('complete Shell owner secret configuration is invalid')),
    );
    if (!/^[a-f\d]{32}$/u.test(accountId)) {
      return yield* fail('Shell ingress publication requires an exact provider account');
    }
    const retainedAssets = [
      ...compiledAssets.filter((file) => file.path !== '_headers'),
      { bytes: new TextEncoder().encode(IMMUTABLE_HEADERS), path: '_headers' },
    ];
    const artifacts = yield* validateImmutableShellReleaseArtifacts(receipt.plan, { assets: retainedAssets });
    if (artifacts.assetsSha256 !== receipt.artifacts.assetsSha256) {
      return yield* fail('the Shell ingress receipt must retain the complete frontend inventory');
    }
    yield* verifyImmutableAssetsAccountOrigin(accountId, token, receipt.plan);
    if (
      (yield* readRetainedImmutableWorkerVersion(accountId, token, receipt.plan.assetsScriptName)) !==
      receipt.assetsVersionId
    ) {
      return yield* fail('the retained Shell provider deployment no longer matches its receipt');
    }
    yield* verifyRetainedShellAssetBytes(receipt.plan, retainedAssets);
    yield* requirePlannedSourceRevision(input.appDirectory, receipt.plan, SOURCE_MISMATCH);
    yield* readVerifiedReleaseFiles(output, receipt.plan);
    yield* assertPublishedShellIngressSnapshot({
      deployment: { appId: receipt.plan.appId, buildMarker: receipt.plan.buildMarker },
      federationManifest: receipt.artifacts.federationManifest,
      runtimeContract: receipt.artifacts.runtimeContract,
    });
    const ingressAssets = yield* materializeImmutablePublicAssets(compiledAssets, output);
    const ingressConfig = yield* fileSystem.makeTempFileScoped({
      directory: output,
      prefix: '.wrangler-immutable-shell-ingress-',
      suffix: '.json',
    });
    const nativeConfig = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.StructWithRest(Schema.Struct({ assets: Schema.Record(Schema.String, Schema.Json) }), [
          Schema.Record(Schema.String, Schema.Json),
        ]),
      ),
    )(yield* fileSystem.readFileString(path.join(output, 'wrangler.json')));
    yield* fileSystem.writeFileString(
      ingressConfig,
      yield* Schema.encodeEffect(JsonText)({
        ...nativeConfig,
        assets: { ...nativeConfig.assets, directory: ingressAssets },
      }),
    );
    yield* readVerifiedReleaseFiles(output, receipt.plan, [ingressAssets, ingressConfig]);
    yield* runCommand({
      args: ['exec', 'wrangler', 'deploy', '--config', ingressConfig],
      command: 'pnpm',
      cwd: input.appDirectory,
      env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId), CLOUDFLARE_API_TOKEN: token },
    });
    const client = yield* HttpClient.HttpClient;
    const secretUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${config.name}/secrets`;
    for (const [name, value] of Object.entries(secrets)) {
      const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.put(secretUrl), {
        name,
        text: value,
        type: 'secret_text',
      });
      const response = yield* client.execute(HttpClientRequest.bearerToken(request, Redacted.value(token))).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail('complete Shell owner secret installation failed')),
      );
      const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ success: Schema.Boolean }))(
        yield* response.json.pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError(() => fail('complete Shell owner secret acknowledgement exceeded its timeout')),
        ),
      ).pipe(Effect.mapError(() => fail('complete Shell owner secret installation was not acknowledged')));
      if (response.status !== 200 || !result.success) {
        return yield* fail('complete Shell owner secret installation was refused');
      }
    }
    return yield* Effect.void;
  },
  Effect.scoped,
  withApplicationCompositionPublicationLock,
);

const planCommand = Command.make(
  'plan',
  { planFile: Flag.String('plan-file'), workersDevSubdomain: Flag.String('workers-dev-subdomain') },
  ({ planFile, workersDevSubdomain }) =>
    Effect.gen(function* writeShellPlan() {
      const plan = yield* makeImmutableShellReleasePlan({
        workersDevSubdomain,
        workspaceRoot: path.resolve(import.meta.dirname, '..'),
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        planFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(PlanDocumentSchema))({
          ...plan,
          buildEnvironment: {
            MODERN_ASSET_PREFIX: plan.assetsOrigin,
            ULTRAMODERN_SOURCE_REVISION: plan.sourceRevision,
          },
        }),
      );
    }),
);
const deployCommand = Command.make(
  'deploy',
  {
    appDirectory: Flag.String('app-directory'),
    planFile: Flag.String('plan-file'),
    receiptFile: Flag.String('receipt-file'),
  },
  ({ appDirectory, planFile, receiptFile }) =>
    Effect.gen(function* publishShellArtifacts() {
      const fileSystem = yield* FileSystem.FileSystem;
      const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableApplicationReleasePlanSchema))(
        yield* fileSystem.readFileString(planFile),
      );
      const receipt = yield* deployImmutableShellRelease({ appDirectory, plan });
      yield* fileSystem.writeFileString(
        receiptFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ImmutableShellArtifactReceiptSchema))(receipt),
      );
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));
const ingressCommand = Command.make(
  'ingress-deploy',
  { appDirectory: Flag.String('app-directory'), receiptFile: Flag.String('receipt-file') },
  ({ appDirectory, receiptFile }) =>
    Effect.gen(function* publishShellIngress() {
      const fileSystem = yield* FileSystem.FileSystem;
      const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableShellArtifactReceiptSchema), {
        onExcessProperty: 'error',
      })(yield* fileSystem.readFileString(receiptFile));
      yield* deployImmutableShellIngress({ appDirectory, receipt });
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));
const command = Command.make('immutable-shell-release').pipe(
  Command.withSubcommands([planCommand, deployCommand, ingressCommand]),
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
