#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import {
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess } from 'effect/unstable/process';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { parse as parseYaml } from 'yaml';

import {
  configureRuntimeCompositionSource,
  validateNativeCompositionSourceUrl,
} from './configure-runtime-composition-source.mts';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ApplicationCompositionSchema,
  ApplicationCompositionArtifactReferenceSchema,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
  OntosShellRuntimeContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '../packages/core-runtime/src/index.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  ActiveApplicationCompositionPublicationError,
  assertNoConflictingPublication,
  decodeActiveApplicationCompositionSnapshot,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from './active-application-composition.mts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/index.ts';
import {
  ApplicationCompositionBackendSchema,
  ONTOS_APPLICATION_COMPOSITION_MAX_MODULES,
} from '../packages/core-runtime/src/modules/application-composition.ts';
import { quiesceInitialCompositionCutover, verifyInitialCompositionCutover } from './initial-composition-cutover.mts';
import { DeploymentEnvironmentSchema } from './materialize-zerops-environment.mts';
import { observeApplicationCompositionBackend } from './observe-application-composition-backend.mts';
import { moduleReleaseAssetWorkerName } from '../packages/core-runtime/src/http/module-release-identity.ts';
import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { applicationCompositionAuthority } from '../packages/core-runtime/src/db/schema.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  publishApplicationCompositionAuthoritySnapshot,
  resumeApplicationCompositionDurableWork,
  runApplicationCompositionMigration,
  verifyInitialApplicationCompositionPublicationEnvironment,
  withApplicationCompositionPublicationLock,
} from './application-composition-authority-publication.mts';
import type { ObservedArtifact, ObservedModuleDeployment } from './active-application-composition.mts';
import { OUTBOX_WORKER_HOST, OutboxWorkerModeSchema, dedicatedOutboxWorkerSetup } from './outbox-worker-delivery.mjs';
import type { OutboxWorkerMode } from './outbox-worker-delivery.mjs';
import { ZeropsApiError } from './zerops-public-api-error.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from './zerops-public-api.mts';

const SHELL_APP_ID = 'shell-super-app';
const SHELL_ZEROPS_SETUP = 'shellsuperapp';
const MF_MANIFEST_PATH = '/mf-manifest.json';
const BUILD_PROOF_ENVIRONMENT = 'build-proof';
const PUBLICATION_READBACK_POLL = Duration.seconds(3);
const PUBLICATION_READBACK_TIMEOUT = Duration.minutes(2);

/**
 * The environment's `OUTBOX_WORKER_MODE` variable. It has no default: an environment that did not choose
 * between dedicated workers and the one host fails instead of silently running the other mode.
 */
const readOutboxWorkerMode = Config.schema(OutboxWorkerModeSchema, 'OUTBOX_WORKER_MODE');

/** One required deployed artifact could not be observed; the complete publication fails. */
export class ActiveApplicationCompositionObservationError extends Schema.TaggedError<ActiveApplicationCompositionObservationError>()(
  'ActiveApplicationCompositionObservationError',
  { appId: OntosDeploymentAppIdSchema, cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      cloudflare: Schema.optionalKey(Schema.Struct({ workerName: Schema.optionalKey(Schema.NonEmptyString) })),
      id: OntosDeploymentAppIdSchema,
      package: Schema.optionalKey(Schema.NonEmptyString),
      surfaceProfile: Schema.optionalKey(Schema.Literal('api-only')),
    }),
  ),
});
type TopologyVertical = (typeof TopologySchema.Type)['verticals'][number];

const ZeropsYamlSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.optionalKey(Schema.Struct({ start: Schema.optionalKey(Schema.String) })),
      setup: Schema.NonEmptyString,
    }),
  ),
});

const CloudflarePlacementSchema = Schema.Struct({
  buildEnvironment: Schema.Record(Schema.String, Schema.String),
  units: Schema.Array(Schema.String),
});
type CloudflarePlacement = typeof CloudflarePlacementSchema.Type;

const StageVariablesSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const otherOutboxWorkerMode = (mode: OutboxWorkerMode): OutboxWorkerMode =>
  mode === 'dedicated' ? 'host' : 'dedicated';

/** The Outbox Worker setups of the mode other than `mode`: the host for `dedicated`, the owners' own for `host`. */
const otherModeWorkerSetupNames = (
  topology: { readonly verticals: readonly { readonly id: string }[] },
  mode: OutboxWorkerMode,
): ReadonlySet<string> =>
  new Set(
    mode === 'dedicated'
      ? [OUTBOX_WORKER_HOST.stageSetup]
      : topology.verticals.map(({ id }) => dedicatedOutboxWorkerSetup(id)),
  );

/** The Worker public URL variable of a placed unit, the one its edge build and output verifier read. */
export const cloudflarePublicUrlVariable = (appId: string): string =>
  `ULTRAMODERN_PUBLIC_URL_${appId.replaceAll('-', '_').toUpperCase()}`;

/** A placed unit's Worker origin, from the reviewed placement's build environment. */
export const cloudflareOrigin = Effect.fn('ActiveApplicationComposition.cloudflareOrigin')(function* cloudflareOrigin(
  placement: CloudflarePlacement,
  appId: string,
) {
  const origin = placement.buildEnvironment[cloudflarePublicUrlVariable(appId)];
  if (!placement.units.includes(appId) || origin === undefined || origin === '') {
    return yield* new ActiveApplicationCompositionPublicationError({
      message: `${appId} is not a placed Worker with buildEnvironment.${cloudflarePublicUrlVariable(appId)}`,
      reason: 'invalid_observation',
    });
  }
  return origin;
});

/** Stage service-ID variable of a deployment unit, named the way the topology implies. */
export const serviceIdVariable = (setup: string): string =>
  setup === SHELL_ZEROPS_SETUP
    ? 'ZEROPS_SHELL_SERVICE_ID'
    : `ZEROPS_${setup.replaceAll('-', '_').toUpperCase()}_SERVICE_ID`;

const artifactUrl = (origin: string, path: string): string => new URL(path, origin).href;

const buildProofOrigin = (appId: string): string => `https://${appId}.build-proof.invalid`;

const workspaceFile = (...segments: readonly string[]) =>
  Path.Path.pipe(Effect.map((platformPath) => platformPath.resolve(import.meta.dirname, '..', ...segments)));

const readWorkspaceText = (...segments: readonly string[]) =>
  Effect.gen(function* readWorkspaceTextFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(yield* workspaceFile(...segments));
  });

const readZeropsYaml = readWorkspaceText('zerops.yaml');

const readTopology = readWorkspaceText('topology', 'reference-topology.json').pipe(
  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TopologySchema))),
);

const writeGitHubOutput = (line: string) =>
  Effect.gen(function* appendGitHubOutput() {
    const outputPath = yield* Config.option(Config.String('GITHUB_OUTPUT'));
    if (Option.isNone(outputPath)) {
      return yield* Effect.void;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.writeFileString(outputPath.value, `${line}\n`, { flag: 'a' });
  });

const unobservable = (appId: string, message: string) => (cause: unknown) =>
  new ActiveApplicationCompositionObservationError({ appId, cause, message });

/** Bounded, uncached fetch of the exact bytes one deployed service serves. */
interface ArtifactBody {
  readonly bytes: number;
  readonly chunks: readonly Uint8Array[];
}

export const fetchArtifact = Effect.fn('ActiveApplicationComposition.fetchArtifact')(function* fetchArtifact(
  appId: string,
  url: string,
) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const body = yield* client
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('cache-control', 'no-cache')))
    .pipe(
      Effect.flatMap((response) =>
        Stream.runFoldEffect(
          response.stream,
          (): ArtifactBody => ({ bytes: 0, chunks: [] }),
          (previous, chunk) => {
            const bytes = previous.bytes + chunk.byteLength;
            return bytes > ONTOS_MODULE_CONTRACT_MAX_BYTES
              ? Effect.fail(
                  new ActiveApplicationCompositionObservationError({
                    appId,
                    message: `${url} exceeds the artifact size bound`,
                  }),
                )
              : Effect.succeed({ bytes, chunks: [...previous.chunks, chunk] });
          },
        ),
      ),
      Effect.mapError(unobservable(appId, `${url} could not be observed`)),
      Effect.timeoutOrElse({
        duration: ARTIFACT_FETCH_TIMEOUT,
        orElse: () =>
          Effect.fail(new ActiveApplicationCompositionObservationError({ appId, message: `${url} timed out` })),
      }),
    );
  const bytes = new Uint8Array(body.bytes);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const artifact: ObservedArtifact = { bytes, url };
  return artifact;
});

/** The stage service id of a setup, or `undefined` when the stage has no such service. */
const provisionedStageServiceId = Effect.fn('ActiveApplicationComposition.provisionedStageServiceId')(
  function* provisionedStageServiceId(setup: string) {
    const variables = yield* Config.String('STAGE_VARIABLES_JSON').pipe(
      Effect.flatMap(Schema.decodeEffect(StageVariablesSchema)),
    );
    const serviceId = variables[serviceIdVariable(setup)];
    return serviceId === undefined || serviceId === '' ? undefined : serviceId;
  },
);

const stageServiceId = Effect.fn('ActiveApplicationComposition.stageServiceId')(function* stageServiceId(
  setup: string,
) {
  const serviceId = yield* provisionedStageServiceId(setup);
  if (serviceId === undefined) {
    return yield* new ZeropsApiError({ message: `missing stage service variable ${serviceIdVariable(setup)}` });
  }
  return serviceId;
});

/** Only the provider-native KV value endpoint may receive a publication credential. */
export const publicationUrl = Config.String(ACTIVE_APPLICATION_COMPOSITION_POLICY.sourceUrlVariable).pipe(
  Effect.flatMap(validateNativeCompositionSourceUrl),
);

const providerFailure = (message: string) => () =>
  new ActiveApplicationCompositionPublicationError({ message, reason: 'publication_failed' });

const publicationClient = Effect.gen(function* publicationClient() {
  const client = yield* HttpClient.HttpClient;
  const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
  return client.pipe(HttpClient.mapRequest((request) => HttpClientRequest.bearerToken(request, Redacted.value(token))));
});

/** Reads native provider storage directly; consumers use a distinct read-only credential. */
export const readPublishedSnapshot = Effect.gen(function* readPublishedSnapshot() {
  const [client, url] = yield* Effect.all([publicationClient, publicationUrl]);
  return yield* client
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('cache-control', 'no-cache')))
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* decodePublishedSnapshotResponse() {
          if (response.status === 404) {
            return Option.none<string>();
          }
          if (response.status !== 200) {
            return yield* new ActiveApplicationCompositionPublicationError({
              message: `composition storage read returned HTTP ${String(response.status)}`,
              reason: 'publication_failed',
            });
          }
          return Option.some(yield* response.text);
        }),
      ),
      Effect.mapError(providerFailure('composition storage could not be read')),
      Effect.timeoutOrElse({
        duration: ARTIFACT_FETCH_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ActiveApplicationCompositionPublicationError({
              message: 'composition storage read timed out',
              reason: 'publication_failed',
            }),
          ),
      }),
    );
});

/** Caller holds the publication lock through using these exact approved release pins. */
export const readCurrentApprovedApplicationCompositionSnapshot = Effect.gen(
  function* readCurrentApprovedApplicationCompositionSnapshot() {
    const stored = yield* readPublishedSnapshot;
    if (Option.isNone(stored)) {
      return yield* providerFailure('a published Application Composition is required')();
    }
    const snapshot = yield* decodeActiveApplicationCompositionSnapshot(stored.value);
    const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
    const database = yield* CoreDatabase;
    const [authority] = yield* database.executor
      .select({
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
        unexpired: sql<boolean>`${applicationCompositionAuthority.validUntil} > clock_timestamp()`,
      })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (authority?.phase !== 'active' || authority.revision !== approved.composition.revision || !authority.unexpired) {
      return yield* providerFailure(
        'the published release requires the current active and unexpired database authority',
      )();
    }
    return approved;
  },
);

/** Caller holds the publication lock through this check and the native ingress write. */
export const assertPublishedShellIngressSnapshot = Effect.fn('ActiveApplicationComposition.assertShellIngress')(
  function* assertPublishedShellIngressSnapshot(receipt: {
    readonly deployment: { readonly appId: string; readonly buildMarker: string };
    readonly federationManifest: { readonly sha256: string; readonly url: string };
    readonly runtimeContract: { readonly sha256: string; readonly url: string };
  }) {
    const approved = yield* readCurrentApprovedApplicationCompositionSnapshot;
    const { shell } = approved.composition;
    if (
      shell.deployment.appId !== receipt.deployment.appId ||
      shell.deployment.buildMarker !== receipt.deployment.buildMarker ||
      shell.runtimeContract.url !== receipt.runtimeContract.url ||
      shell.runtimeContract.sha256 !== receipt.runtimeContract.sha256 ||
      shell.federationManifest.url !== receipt.federationManifest.url ||
      shell.federationManifest.sha256 !== receipt.federationManifest.sha256
    ) {
      return yield* providerFailure('Shell ingress receipt does not match the current approved release')();
    }
    return yield* Effect.void;
  },
);

const ProviderWriteSchema = Schema.Struct({ success: Schema.Boolean });

/**
 * The native database publication lock covers this entire operation. KV has no compare-and-swap:
 * provider readback checks this write, but cannot provide a distributed transaction or global visibility.
 */
const isRetainedAssetUrl = (url: URL, expectedWorker: string): boolean => {
  const [worker, account, provider, tld, ...extra] = url.hostname.split('.');
  return (
    worker === expectedWorker &&
    account !== undefined &&
    account !== '' &&
    provider === 'workers' &&
    tld === 'dev' &&
    extra.length === 0 &&
    url.protocol === 'https:' &&
    url.search === '' &&
    url.hash === ''
  );
};

export const assertRetainedReleaseArtifactPaths = (snapshot: ActiveApplicationCompositionSnapshot) =>
  Effect.gen(function* validateRetainedReleaseArtifactPaths() {
    const shellWorker = yield* moduleReleaseAssetWorkerName(
      snapshot.composition.shell.deployment.appId,
      snapshot.composition.shell.deployment.buildMarker,
    );
    const shellRuntime = new URL(snapshot.composition.shell.runtimeContract.url);
    const shellManifest = new URL(snapshot.composition.shell.federationManifest.url);
    if (
      !isRetainedAssetUrl(shellRuntime, shellWorker) ||
      shellRuntime.pathname !== ONTOS_SHELL_RUNTIME_CONTRACT_PATH ||
      !isRetainedAssetUrl(shellManifest, shellWorker) ||
      shellManifest.origin !== shellRuntime.origin ||
      shellManifest.pathname !== MF_MANIFEST_PATH
    ) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'Shell artifacts must use their retained native release Worker',
        reason: 'invalid_observation',
      });
    }
    return yield* Effect.forEach(
      snapshot.composition.modules,
      (module) =>
        Effect.gen(function* validateRetainedArtifactUrls() {
          const expectedWorker = yield* moduleReleaseAssetWorkerName(
            module.deployment.appId,
            module.deployment.buildMarker,
          );
          const contract = new URL(module.contract.url);
          const canonicalOrigin = isRetainedAssetUrl(contract, expectedWorker);
          const canonicalManifest =
            module.federation.execution === 'server' ||
            (isRetainedAssetUrl(new URL(module.federation.manifest.url), expectedWorker) &&
              new URL(module.federation.manifest.url).origin === contract.origin &&
              new URL(module.federation.manifest.url).pathname === MF_MANIFEST_PATH);
          if (!canonicalOrigin || contract.pathname !== ONTOS_MODULE_CONTRACT_PATH || !canonicalManifest) {
            return yield* new ActiveApplicationCompositionPublicationError({
              message: `module ${module.moduleId} artifacts must use their retained native release Worker`,
              reason: 'invalid_observation',
            });
          }
          return yield* Effect.void;
        }),
      { discard: true },
    );
  });

export const publishSnapshot = Effect.fn('ActiveApplicationComposition.publishSnapshot')(function* publishSnapshot<
  InitialFailure,
  InitialRequirements,
>(
  input: ActiveApplicationCompositionSnapshot,
  snapshotFile: Option.Option<string>,
  verifyInitialCutover: Effect.Effect<void, InitialFailure, InitialRequirements>,
  retainedShellRevision?: string,
) {
  const snapshot = yield* validateActiveApplicationCompositionSnapshot(input).pipe(
    Effect.mapError(
      () =>
        new ActiveApplicationCompositionPublicationError({
          message: 'the complete Application Composition snapshot is invalid or expired',
          reason: 'invalid_observation',
        }),
    ),
  );
  yield* assertRetainedReleaseArtifactPaths(snapshot);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
  yield* publishApplicationCompositionAuthoritySnapshot(
    snapshot,
    Effect.gen(function* publishProviderPointer() {
      const current = yield* readPublishedSnapshot;
      yield* assertNoConflictingPublication(current, snapshot);
      if (retainedShellRevision !== undefined) {
        if (Option.isNone(current)) {
          return yield* providerFailure('retained Shell pins require their current approved release')();
        }
        const previous = yield* decodeActiveApplicationCompositionSnapshot(current.value).pipe(
          Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        );
        if (
          previous.composition.revision !== retainedShellRevision ||
          !Schema.toEquivalence(ApplicationCompositionSchema.fields.shell)(
            previous.composition.shell,
            snapshot.composition.shell,
          )
        ) {
          return yield* providerFailure('retained Shell pins no longer match their current approved release')();
        }
      }
      const [client, url] = yield* Effect.all([publicationClient, publicationUrl]);
      const result = yield* client
        .execute(HttpClientRequest.put(url).pipe(HttpClientRequest.bodyText(encoded, 'application/octet-stream')))
        .pipe(
          Effect.flatMap((response) =>
            Effect.gen(function* decodePublicationResponse() {
              if (response.status < 200 || response.status >= 300) {
                return yield* new ActiveApplicationCompositionPublicationError({
                  message: `composition storage write returned HTTP ${String(response.status)}`,
                  reason: 'publication_failed',
                });
              }
              return yield* response.json;
            }),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(ProviderWriteSchema)),
          Effect.mapError(providerFailure('composition storage write failed')),
          Effect.timeoutOrElse({
            duration: ARTIFACT_FETCH_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ActiveApplicationCompositionPublicationError({
                  message: 'composition storage write timed out',
                  reason: 'publication_failed',
                }),
              ),
          }),
        );
      if (!result.success) {
        return yield* new ActiveApplicationCompositionPublicationError({
          message: 'composition storage rejected the write',
          reason: 'publication_failed',
        });
      }
      yield* readPublishedSnapshot.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(PUBLICATION_READBACK_POLL),
          until: (value) => Option.contains(value, encoded),
        }),
        Effect.timeoutOrElse({
          duration: PUBLICATION_READBACK_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ActiveApplicationCompositionPublicationError({
                message: 'composition storage readback did not return the published value',
                reason: 'publication_failed',
              }),
            ),
        }),
      );
      return snapshot;
    }),
    verifyInitialCutover,
  );
  if (Option.isSome(snapshotFile)) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(snapshotFile.value, encoded);
  }
  yield* Effect.logInfo('Published the complete approved Application Composition', {
    modules: snapshot.composition.modules.map(({ federation, moduleId }) => `${moduleId} (${federation.execution})`),
    revision: snapshot.composition.revision,
    validUntil: DateTime.formatIso(snapshot.validUntil),
  });
  return snapshot;
});

/** A reviewed publisher input selects artifacts; placement never installs a module implicitly. */
export const ApplicationCompositionPublicationCandidateSchema = Schema.Struct({
  modules: Schema.Array(
    Schema.Struct({
      appId: OntosDeploymentAppIdSchema,
      backend: ApplicationCompositionBackendSchema,
      contractUrl: ApplicationCompositionArtifactReferenceSchema.fields.url,
      federationManifestUrl: Schema.optionalKey(ApplicationCompositionArtifactReferenceSchema.fields.url),
    }),
  ).check(Schema.isMaxLength(ONTOS_APPLICATION_COMPOSITION_MAX_MODULES)),
  retainedShellRevision: Schema.optionalKey(ApplicationCompositionSchema.fields.revision),
  shell: Schema.Struct({
    deployment: OntosShellRuntimeContractSchema.fields.deployment,
    federationManifest: ApplicationCompositionArtifactReferenceSchema,
    runtimeContract: ApplicationCompositionArtifactReferenceSchema,
  }),
});
type PublicationCandidate = typeof ApplicationCompositionPublicationCandidateSchema.Type;

const readPublicationCandidate = (file: string) =>
  Effect.gen(function* readCandidateFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonical = yield* fileSystem.realPath(path.resolve(file));
    if (canonical.split(path.sep).some((segment) => segment.startsWith('.env'))) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'the candidate must be a dedicated artifact file',
        reason: 'invalid_observation',
      });
    }
    const bytes = yield* fileSystem.readFile(canonical);
    if (bytes.byteLength > 1024 * 1024) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'the candidate exceeds its byte budget',
        reason: 'invalid_observation',
      });
    }
    const text = yield* Effect.try({
      catch: () =>
        new ActiveApplicationCompositionPublicationError({
          message: 'the candidate is not UTF-8',
          reason: 'invalid_observation',
        }),
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    });
    return yield* Schema.decodeEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema), {
      onExcessProperty: 'error',
    })(text);
  });

/** Full installation observation. Runtime availability never filters this approved inventory. */
export const observeCandidate = Effect.fn('ActiveApplicationComposition.observeCandidate')(function* observeCandidate(
  environment: string,
  candidate: PublicationCandidate,
) {
  const [modules, runtimeContract, federationManifest, observedAt] = yield* Effect.all(
    [
      Effect.forEach(
        candidate.modules,
        (module) =>
          Effect.gen(function* observeCandidateModule() {
            const contract = yield* fetchArtifact(module.appId, module.contractUrl);
            const backend = yield* observeApplicationCompositionBackend({
              appId: module.appId,
              backend: module.backend,
              contract,
            });
            const common: ObservedModuleDeployment = { appId: module.appId, backend, contract };
            return module.federationManifestUrl === undefined
              ? common
              : { ...common, federationManifest: yield* fetchArtifact(module.appId, module.federationManifestUrl) };
          }),
        { concurrency: 4 },
      ),
      fetchArtifact(SHELL_APP_ID, candidate.shell.runtimeContract.url),
      fetchArtifact(SHELL_APP_ID, candidate.shell.federationManifest.url),
      DateTime.now,
    ],
    { concurrency: 3 },
  );
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment,
    modules,
    observedAt,
    shell: { federationManifest, runtimeContract },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
  const observedShell = snapshot.composition.shell;
  if (
    observedShell.deployment.appId !== candidate.shell.deployment.appId ||
    observedShell.deployment.buildMarker !== candidate.shell.deployment.buildMarker ||
    observedShell.runtimeContract.sha256 !== candidate.shell.runtimeContract.sha256 ||
    observedShell.federationManifest.sha256 !== candidate.shell.federationManifest.sha256
  ) {
    return yield* new ActiveApplicationCompositionPublicationError({
      message: 'observed Shell artifacts differ from the exact approved candidate deployment or digests',
      reason: 'invalid_observation',
    });
  }
  return snapshot;
});

const configuredInitialCutover = (environment: string) =>
  Effect.gen(function* verifyConfiguredInitialCutover() {
    const [inventoryFile, receiptFile] = yield* Effect.all([
      Config.String('ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE'),
      Config.String('ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE'),
    ]);
    yield* verifyInitialCompositionCutover({ environment, inventoryFile, receiptFile });
  });

const quiesceInitialCutoverCommand = Command.make(
  'quiesce-initial-cutover',
  {
    environment: Flag.String('environment'),
    inventoryFile: Flag.String('inventory-file'),
    receiptFile: Flag.String('receipt-file'),
  },
  quiesceInitialCompositionCutover,
);

const verifyInitialCutoverCommand = Command.make(
  'verify-initial-cutover',
  { environment: Flag.String('environment') },
  ({ environment }) => verifyInitialApplicationCompositionPublicationEnvironment(configuredInitialCutover(environment)),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const migrateCommand = Command.make(
  'migrate',
  {
    environment: Flag.String('environment'),
    projectId: Flag.String('project-id'),
    serviceId: Flag.String('service-id'),
    versionName: Flag.String('version-name'),
    zeropsYamlPath: Flag.String('zerops-yaml-path'),
  },
  ({ environment, projectId, serviceId, versionName, zeropsYamlPath }) =>
    Effect.gen(function* migrateUnderNativePublicationLock() {
      const path = yield* Path.Path;
      const api = yield* ZeropsPublicApi;
      const deployment = Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.scoped(
            Effect.gen(function* runVerifiedRemoteMigrator() {
              const process = yield* ChildProcess.make(
                'zcli',
                [
                  'push',
                  '--working-dir',
                  '.',
                  '--zerops-yaml-path',
                  path.resolve(zeropsYamlPath),
                  '--workspace-state',
                  'clean',
                  '--deploy-git-folder',
                  '--project-id',
                  projectId,
                  '--service-id',
                  serviceId,
                  '--setup',
                  'migrator',
                  '--version-name',
                  versionName,
                ],
                { cwd: path.resolve(import.meta.dirname, '../..'), stderr: 'inherit', stdout: 'inherit' },
              );
              const exitCode = yield* process.exitCode;
              if (exitCode !== 0) {
                return yield* providerFailure('The native verified migrator deployment failed')();
              }
              return yield* Effect.void;
            }),
          ),
        () =>
          Effect.gen(function* stopCompletedRemoteMigrator() {
            yield* api.stopService(serviceId);
            const stopped = yield* api.findServiceStack(serviceId);
            if (Option.isNone(stopped) || stopped.value.status !== 'STOPPED') {
              return yield* providerFailure('The native migrator did not stop after its deployment')();
            }
            return yield* Effect.void;
          }).pipe(
            Effect.mapError(providerFailure('The native migrator could not be independently verified as stopped')),
            Effect.orDie,
          ),
      );
      yield* runApplicationCompositionMigration(deployment, configuredInitialCutover(environment));
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const resumeDurableWorkCommand = Command.make(
  'resume-durable-work',
  { expectedRevision: Flag.String('expected-revision') },
  ({ expectedRevision }) => resumeApplicationCompositionDurableWork(expectedRevision),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const captureApprovedSnapshotCommand = Command.make(
  'capture-approved-snapshot',
  {
    environment: Flag.Literals('environment', DeploymentEnvironmentSchema.literals),
    snapshotFile: Flag.String('snapshot-file'),
  },
  ({ environment, snapshotFile }) =>
    withApplicationCompositionPublicationLock(
      Effect.gen(function* captureApprovedSnapshot() {
        const approved = yield* readCurrentApprovedApplicationCompositionSnapshot;
        yield* assertRetainedReleaseArtifactPaths(approved);
        const fileSystem = yield* FileSystem.FileSystem;
        const encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
        yield* fileSystem.writeFileString(snapshotFile, encoded);
        yield* Effect.logInfo('Captured the exact approved release before migration', {
          environment,
          revision: approved.composition.revision,
        });
      }),
    ),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const publishCommand = Command.make(
  'publish',
  {
    candidateFile: Flag.String('candidate-file'),
    environment: Flag.String('environment'),
    snapshotFile: Flag.String('snapshot-file').pipe(Flag.optional),
  },
  ({ candidateFile, environment, snapshotFile }) =>
    readPublicationCandidate(candidateFile).pipe(
      Effect.flatMap((candidate) =>
        observeCandidate(environment, candidate).pipe(
          Effect.flatMap((snapshot) =>
            publishSnapshot(
              snapshot,
              snapshotFile,
              configuredInitialCutover(environment),
              candidate.retainedShellRevision,
            ),
          ),
        ),
      ),
    ),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const refreshCommand = Command.make(
  'refresh',
  {
    environment: Flag.String('environment'),
  },
  ({ environment }) =>
    Effect.gen(function* refreshComposition() {
      const current = yield* readPublishedSnapshot;
      if (Option.isNone(current)) {
        return yield* new ActiveApplicationCompositionPublicationError({
          message: 'composition storage has no approved release to refresh',
          reason: 'invalid_observation',
        });
      }
      const approved = yield* decodeActiveApplicationCompositionSnapshot(current.value);
      const candidate: PublicationCandidate = {
        modules: approved.composition.modules.map((module) => {
          const common = { appId: module.deployment.appId, backend: module.backend, contractUrl: module.contract.url };
          return module.federation.execution === 'browser'
            ? { ...common, federationManifestUrl: module.federation.manifest.url }
            : common;
        }),
        shell: {
          deployment: approved.composition.shell.deployment,
          federationManifest: approved.composition.shell.federationManifest,
          runtimeContract: approved.composition.shell.runtimeContract,
        },
      };
      const snapshot = yield* observeCandidate(environment, candidate);
      if (snapshot.composition.revision !== approved.composition.revision) {
        return yield* new ActiveApplicationCompositionPublicationError({
          message: 'refresh observed different release artifacts; an explicit promotion is required',
          reason: 'conflicting_revision',
        });
      }
      return yield* publishSnapshot(snapshot, Option.none(), configuredInitialCutover(environment));
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const configureSourceCommand = Command.make('configure-source', {}, () =>
  Effect.gen(function* configureSource() {
    const [projectId, url, readToken] = yield* Effect.all([
      Config.String('ZEROPS_PROJECT_ID'),
      publicationUrl,
      Config.Redacted('ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN'),
    ]);
    yield* configureRuntimeCompositionSource({ projectId, readToken, url });
    return yield* Effect.logInfo('Configured the stable native composition source');
  }),
);

const ensurePublicAccessCommand = Command.make('ensure-public-access', { setup: Flag.String('setup') }, ({ setup }) =>
  Effect.gen(function* ensurePublicAccess() {
    const api = yield* ZeropsPublicApi;
    const serviceId = yield* stageServiceId(setup);
    const service = yield* api.serviceStack(serviceId);
    if (service.subdomainAccess) {
      return yield* Effect.logInfo(`${setup} already serves its public Zerops subdomain`);
    }
    yield* api.enableSubdomainAccess(serviceId);
    const enabled = yield* api.serviceStack(serviceId);
    if (!enabled.subdomainAccess) {
      return yield* new ZeropsApiError({ message: `${setup} public subdomain is still disabled` });
    }
    return yield* Effect.logInfo(`Enabled the public Zerops subdomain of ${setup}`);
  }),
);

/**
 * Stops a setup's stage service when it runs. A stage that never provisioned the service, deleted it, or whose
 * service already stopped, needs nothing, so the deploy can stop the other Outbox Worker mode's workers on every
 * switch.
 */
const stopServiceCommand = Command.make('stop-service', { setup: Flag.String('setup') }, ({ setup }) =>
  Effect.gen(function* stopService() {
    const serviceId = yield* provisionedStageServiceId(setup);
    if (serviceId === undefined) {
      return yield* Effect.logInfo(`${setup} has no stage service, so there is nothing to stop`);
    }
    const api = yield* ZeropsPublicApi;
    const found = yield* api.findServiceStack(serviceId);
    if (Option.isNone(found)) {
      return yield* Effect.logInfo(`${setup}'s stage service was deleted, so there is nothing to stop`);
    }
    const service = found.value;
    if (service.status !== 'ACTIVE') {
      return yield* Effect.logInfo(`${setup} is ${service.status}, so there is nothing to stop`);
    }
    yield* api.stopService(serviceId);
    return yield* Effect.logInfo(`Stopped ${setup}`);
  }),
);

const definedWorkerSetups = (zeropsYamlText: string, workerSetupNames: ReadonlySet<string>) =>
  Schema.decodeUnknownEffect(ZeropsYamlSchema)(parseYaml(zeropsYamlText)).pipe(
    Effect.map(({ zerops }) => zerops.filter(({ setup }) => workerSetupNames.has(setup)).map(({ setup }) => setup)),
  );

/**
 * The other Outbox Worker mode's setups this revision defines: the host for `dedicated`, the dedicated
 * owner workers for `host`.
 */
export const otherModeWorkerSetups = (
  zeropsYamlText: string,
  topology: { readonly verticals: readonly { readonly id: string }[] },
  mode: OutboxWorkerMode,
) => definedWorkerSetups(zeropsYamlText, otherModeWorkerSetupNames(topology, mode));

/** The Outbox Worker mode's own setups this revision defines. */
export const modeWorkerSetups = (
  zeropsYamlText: string,
  topology: { readonly verticals: readonly { readonly id: string }[] },
  mode: OutboxWorkerMode,
) => definedWorkerSetups(zeropsYamlText, otherModeWorkerSetupNames(topology, otherOutboxWorkerMode(mode)));

/**
 * Whether the Outbox Workers still reflect another Outbox Worker mode. An `OUTBOX_WORKER_MODE` switch changes
 * no source, so the plan cannot see it. The switch shows as the other mode's workers still running, or as
 * one of this mode's workers not running (never deployed, deleted, or stopped by an earlier switch). Either way the
 * plan reconciles the workers of both modes. The deploy target plays no part: both run the workers on Zerops.
 */
const workerModeDriftCommand = Command.make('worker-mode-drift', {}, () =>
  Effect.gen(function* workerModeDrift() {
    const mode = yield* readOutboxWorkerMode;
    const [zeropsYaml, topology] = yield* Effect.all([readZeropsYaml, readTopology], {
      concurrency: 2,
    });
    const api = yield* ZeropsPublicApi;
    const isRunning = Effect.fnUntraced(function* isRunning(setup: string) {
      const serviceId = yield* provisionedStageServiceId(setup);
      if (serviceId === undefined) {
        return false;
      }
      return Option.exists(yield* api.findServiceStack(serviceId), ({ status }) => status === 'ACTIVE');
    });
    const [otherMode, ownMode] = yield* Effect.all([
      otherModeWorkerSetups(zeropsYaml, topology, mode),
      modeWorkerSetups(zeropsYaml, topology, mode),
    ]);
    const running = yield* Effect.filter(otherMode, isRunning, { concurrency: 4 });
    const notRunning = yield* Effect.filter(ownMode, (setup) => Effect.map(isRunning(setup), (up) => !up), {
      concurrency: 4,
    });
    if (running.length > 0) {
      yield* Effect.logInfo(`Outbox Workers of the other mode still run: ${running.join(', ')}`);
    }
    if (notRunning.length > 0) {
      yield* Effect.logInfo(`Outbox Workers of the ${mode} mode do not run: ${notRunning.join(', ')}`);
    }
    const drift = running.length > 0 || notRunning.length > 0;
    if (!drift) {
      yield* Effect.logInfo(`Only the ${mode} Outbox Worker mode's workers run`);
    }
    return yield* writeGitHubOutput(`drift=${drift}`);
  }),
);

/** The one service-ID lookup the deploy scripts use, so shell and TypeScript never map setups differently. */
const stageServiceIdCommand = Command.make('stage-service-id', { setup: Flag.String('setup') }, ({ setup }) =>
  stageServiceId(setup).pipe(Effect.flatMap(Console.log)),
);

const readBuiltArtifact = (appId: string, url: string, ...segments: readonly string[]) =>
  Effect.gen(function* readBuiltArtifactFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fileSystem.readFile(yield* workspaceFile(...segments));
    const artifact: ObservedArtifact = { bytes, url };
    return artifact;
  }).pipe(Effect.mapError(unobservable(appId, `${segments.join('/')} is not built`)));

const observeBuiltModule = (vertical: TopologyVertical) => {
  const origin = buildProofOrigin(vertical.id);
  const contract = readBuiltArtifact(
    vertical.id,
    artifactUrl(origin, ONTOS_MODULE_CONTRACT_PATH),
    'verticals',
    vertical.id,
    'dist',
    'public',
    ONTOS_MODULE_CONTRACT_PATH.slice(1),
  );
  if (vertical.surfaceProfile === 'api-only') {
    return contract.pipe(
      Effect.map((artifact): ObservedModuleDeployment => ({
        appId: vertical.id,
        backend: { baseUrl: `${origin}/`, transport: 'node-http' },
        contract: artifact,
      })),
    );
  }
  const manifest = readBuiltArtifact(
    vertical.id,
    artifactUrl(origin, MF_MANIFEST_PATH),
    'verticals',
    vertical.id,
    'dist',
    MF_MANIFEST_PATH.slice(1),
  );
  return Effect.all([contract, manifest], { concurrency: 2 }).pipe(
    Effect.map(([artifact, federationManifest]): ObservedModuleDeployment => ({
      appId: vertical.id,
      backend: { baseUrl: `${origin}/`, transport: 'node-http' },
      contract: artifact,
      federationManifest,
    })),
  );
};

/**
 * Derives the snapshot from this revision's built artifacts, so CI proves the publisher output decodes
 * as consumers decode it before any deployment depends on it.
 */
export const deriveBuiltSnapshot = Effect.fn('ActiveApplicationComposition.deriveBuiltSnapshot')(function* derive(
  observedAt: DateTime.Utc,
) {
  const topology = yield* readTopology;
  const shellOrigin = buildProofOrigin(SHELL_APP_ID);
  const [modules, runtimeContract, federationManifest] = yield* Effect.all(
    [
      Effect.forEach(topology.verticals, observeBuiltModule, { concurrency: 4 }),
      readBuiltArtifact(
        SHELL_APP_ID,
        artifactUrl(shellOrigin, ONTOS_SHELL_RUNTIME_CONTRACT_PATH),
        'apps',
        SHELL_APP_ID,
        'dist',
        'public',
        ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1),
      ),
      readBuiltArtifact(
        SHELL_APP_ID,
        artifactUrl(shellOrigin, MF_MANIFEST_PATH),
        'apps',
        SHELL_APP_ID,
        'dist',
        MF_MANIFEST_PATH.slice(1),
      ),
    ],
    { concurrency: 3 },
  );
  return yield* deriveActiveApplicationCompositionSnapshot({
    environment: BUILD_PROOF_ENVIRONMENT,
    modules,
    observedAt,
    shell: { federationManifest, runtimeContract },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
});

const proveBuildCommand = Command.make('prove-build', {}, () =>
  Effect.gen(function* proveBuild() {
    const snapshot = yield* deriveBuiltSnapshot(yield* DateTime.now);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const decoded = yield* decodeActiveApplicationCompositionSnapshot(encoded);
    if (decoded.composition.revision !== snapshot.composition.revision) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'the decoded snapshot names a different Application Composition revision',
        reason: 'invalid_observation',
      });
    }
    return yield* Effect.logInfo('Built artifacts form an active Application Composition snapshot consumers decode', {
      modules: decoded.composition.modules.map(({ federation, moduleId }) => `${moduleId} (${federation.execution})`),
      revision: decoded.composition.revision,
    });
  }),
);

const cli = Command.make('publish-active-application-composition').pipe(
  Command.withSubcommands([
    captureApprovedSnapshotCommand,
    publishCommand,
    refreshCommand,
    configureSourceCommand,
    quiesceInitialCutoverCommand,
    verifyInitialCutoverCommand,
    migrateCommand,
    resumeDurableWorkCommand,
    ensurePublicAccessCommand,
    proveBuildCommand,
    stageServiceIdCommand,
    stopServiceCommand,
    workerModeDriftCommand,
  ]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(main).pipe(
        Layer.provide(ZeropsPublicApiLive),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            FetchHttpClient.layer,
            Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          ),
        ),
      ),
    ).pipe(Effect.scoped),
  );
}
