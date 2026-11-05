#!/usr/bin/env node
import { createHash } from 'node:crypto';
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
import { Command, Flag } from 'effect/cli';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { parse as parseYaml } from 'yaml';
import { Reactivity } from 'effect/reactivity';
import {
  ApplicationReleaseIntentSchema,
  ApplicationReleaseSelectionSchema,
  readReviewedApplicationReleaseIntent,
} from './application-release-intent.mts';
import type { ApplicationReleaseIntent, ApplicationReleaseSelection } from './application-release-intent.mts';
import { ApplicationMigrationRequirementsSchema } from './application-migration-plan.mts';
import { OpsShellLive } from './ops/ops-shell.mts';
import {
  prepareApplicationMigrationPlan,
  readApplicationMigrationRequirements,
} from './application-migration-runtime.mts';
import {
  applicationMigrationPublicationMode,
  materializeApplicationMigrationProvider,
} from './application-migration-publication.mts';

import {
  configureRuntimeCompositionSource,
  validateNativeCompositionSourceUrl,
} from './configure-runtime-composition-source.mts';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ApplicationCompositionSchema,
  ApplicationCompositionModuleSchema,
  canonicalizeApplicationComposition,
  buildApplicationCompositionCatalog,
  ApplicationCompositionArtifactReferenceSchema,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
  OntosDeploymentIdentitySchema,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '../packages/core-runtime/src/index.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  ActiveApplicationCompositionPublicationError,
  assertNoConflictingPublication,
  applicationCompositionRevision,
  decodeActiveApplicationCompositionSnapshot,
  deriveActiveApplicationCompositionSnapshot,
  deriveApplicationComposition,
  encodeActiveApplicationCompositionSnapshot,
} from './active-application-composition.mts';
import type {
  ApplicationComposition,
  ActiveApplicationCompositionSnapshot,
} from '../packages/core-runtime/src/index.ts';
import {
  ApplicationCompositionBackendSchema,
  ONTOS_APPLICATION_COMPOSITION_MAX_MODULES,
} from '../packages/core-runtime/src/modules/application-composition.ts';
import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from '../packages/core-runtime/src/modules/application-composition-limits.ts';
import {
  quiesceInitialCompositionCutover,
  verifyInitialCompositionCutover,
  verifyRetiredCompositionCutover,
} from './initial-composition-cutover.mts';
import { ApplicationCompositionLegacyOwnersLive } from './application-composition-legacy-owners.mts';
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
import type {
  ApplicationCompositionPinnedArtifacts,
  ObservedArtifact,
  ObservedModuleDeployment,
} from './active-application-composition.mts';
import { OUTBOX_WORKER_HOST, OutboxWorkerModeSchema, dedicatedOutboxWorkerSetup } from './outbox-worker-delivery.mjs';
import type { OutboxWorkerMode } from './outbox-worker-delivery.mjs';
import { ZeropsApiError } from './zerops-public-api-error.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from './zerops-public-api.mts';

const CANDIDATE_FILE_FLAG = 'candidate-file';
const EXPECTED_COMPOSITION_FILE_FLAG = 'expected-composition-file';
const RELEASE_INTENT_FILE_FLAG = 'intent-file';
const DEFAULT_RELEASE_INTENT_FILE = 'topology/application-release-intent.json';
const RELEASE_SELECTION_FILE_FLAG = 'selection-file';
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
const readApprovedApplicationComposition = Effect.fn('ActiveApplicationComposition.readApproved')(
  function* readApprovedApplicationComposition(allowAbsent: boolean) {
    const stored = yield* readPublishedSnapshot;
    if (Option.isNone(stored)) {
      if (!allowAbsent) {
        return yield* providerFailure('a published Application Composition is required')();
      }
      const database = yield* CoreDatabase;
      const [table] = yield* database.executor.execute<{ readonly installed: boolean }>(
        sql`select to_regclass('core.application_composition_authority') is not null as installed`,
        'objects',
      );
      if (table === undefined) {
        return yield* providerFailure('native authority presence could not be established')();
      }
      if (table.installed) {
        const [authority] = yield* database.executor
          .select({ revision: applicationCompositionAuthority.revision })
          .from(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        if (authority !== undefined) {
          return yield* providerFailure('an absent provider pointer conflicts with existing native authority')();
        }
      }
      return Option.none<ActiveApplicationCompositionSnapshot>();
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
    return Option.some(approved);
  },
);

/** Strict approved-release readers never interpret absence as an approved release. */
export const readCurrentApprovedApplicationCompositionSnapshot = readApprovedApplicationComposition(false).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.fail(providerFailure('a published Application Composition is required')()),
      onSome: Effect.succeed,
    }),
  ),
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

/** Capture provider and native absence together while holding the existing publication lock. */
export const captureApprovedApplicationCompositionSnapshot = Effect.fn('ActiveApplicationComposition.captureApproved')(
  function* captureApprovedApplicationComposition(
    options: { readonly allowAbsent?: boolean; readonly baselineOnly?: boolean } = {},
  ) {
    return yield* withApplicationCompositionPublicationLock(
      readApprovedApplicationComposition(options.allowAbsent === true).pipe(
        Effect.tap((captured) =>
          Option.isSome(captured) && options.baselineOnly !== true
            ? assertRetainedReleaseArtifactPaths(captured.value)
            : Effect.void,
        ),
      ),
    );
  },
);

const PublicationBaselineSchema = Schema.Struct({
  retainedModuleAppIds: Schema.Array(OntosDeploymentAppIdSchema).check(
    Schema.isMaxLength(ONTOS_APPLICATION_COMPOSITION_MAX_MODULES),
    Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : 'retained module slots must be unique')),
  ),
  revision: Schema.toEncoded(Schema.OptionFromNullOr(ApplicationCompositionSchema.fields.revision)),
  shellMode: Schema.Literals(['fresh', 'retained']),
}).check(
  Schema.makeFilter((baseline) =>
    baseline.revision !== null || (baseline.retainedModuleAppIds.length === 0 && baseline.shellMode === 'fresh')
      ? undefined
      : 'captured absence cannot retain module or Shell artifacts',
  ),
);
type PublicationBaseline = typeof PublicationBaselineSchema.Type;

const requireProviderBaseline = Effect.fn('ActiveApplicationComposition.requireProviderBaseline')(
  function* requireProviderBaselineEffect(
    current: Option.Option<string>,
    target: ActiveApplicationCompositionSnapshot,
    baseline: PublicationBaseline,
  ) {
    if (Option.isNone(current)) {
      return baseline.revision === null
        ? yield* Effect.void
        : yield* providerFailure('the captured provider baseline is missing')();
    }
    const previous = yield* decodeActiveApplicationCompositionSnapshot(current.value);
    if (applicationCompositionRevision(previous.composition) !== previous.composition.revision) {
      return yield* providerFailure('the current provider revision does not identify its canonical content')();
    }
    // Existing assertNoConflictingPublication already checks monotonic observation/freshness.
    if (
      canonicalizeApplicationComposition(previous.composition) ===
      canonicalizeApplicationComposition(target.composition)
    ) {
      return yield* Effect.void;
    }
    if (previous.composition.revision !== baseline.revision) {
      return yield* providerFailure('the provider no longer identifies the captured baseline or exact target')();
    }
    for (const moduleAppId of baseline.retainedModuleAppIds) {
      const original = previous.composition.modules.find(({ deployment }) => deployment.appId === moduleAppId);
      const retained = target.composition.modules.find(({ deployment }) => deployment.appId === moduleAppId);
      if (
        original === undefined ||
        retained === undefined ||
        !Schema.toEquivalence(ApplicationCompositionModuleSchema)(original, retained)
      ) {
        return yield* providerFailure('retained module pins no longer match the captured provider baseline')();
      }
    }
    if (
      baseline.shellMode === 'retained' &&
      !Schema.toEquivalence(ApplicationCompositionSchema.fields.shell)(
        previous.composition.shell,
        target.composition.shell,
      )
    ) {
      return yield* providerFailure('retained Shell pins no longer match the captured provider baseline')();
    }
    return yield* Effect.void;
  },
);

export const publishSnapshot = Effect.fn('ActiveApplicationComposition.publishSnapshot')(function* publishSnapshot<
  InitialFailure,
  InitialRequirements,
>(
  input: ActiveApplicationCompositionSnapshot,
  snapshotFile: Option.Option<string>,
  verifyInitialCutover: Effect.Effect<void, InitialFailure, InitialRequirements>,
  baseline?: PublicationBaseline,
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
  if (baseline !== undefined) {
    yield* Schema.decodeUnknownEffect(PublicationBaselineSchema, { onExcessProperty: 'error' })(baseline);
    if (
      baseline.retainedModuleAppIds.some(
        (id) => !snapshot.composition.modules.some(({ deployment }) => deployment.appId === id),
      )
    ) {
      return yield* providerFailure('retained baseline slots must belong to the complete target')();
    }
  }
  yield* assertRetainedReleaseArtifactPaths(snapshot);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
  const precondition =
    baseline === undefined
      ? undefined
      : { baselineRevision: baseline.revision, targetRevision: snapshot.composition.revision };
  yield* publishApplicationCompositionAuthoritySnapshot(
    snapshot,
    Effect.gen(function* publishProviderPointer() {
      const current = yield* readPublishedSnapshot;
      yield* assertNoConflictingPublication(current, snapshot);
      if (baseline !== undefined) {
        yield* requireProviderBaseline(current, snapshot, baseline);
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
    precondition,
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
  baseline: PublicationBaselineSchema,
  modules: Schema.Array(
    Schema.Struct({
      appId: OntosDeploymentAppIdSchema,
      backend: ApplicationCompositionBackendSchema,
      contract: ApplicationCompositionArtifactReferenceSchema,
      deployment: OntosDeploymentIdentitySchema,
      federationManifest: Schema.optionalKey(ApplicationCompositionArtifactReferenceSchema),
    }).check(
      Schema.makeFilter((module) =>
        module.appId === module.deployment.appId ? undefined : 'candidate appId must match its exact deployment',
      ),
    ),
  ).check(
    Schema.isMaxLength(ONTOS_APPLICATION_COMPOSITION_MAX_MODULES),
    Schema.makeFilter((modules) =>
      new Set(modules.map(({ appId }) => appId)).size === modules.length
        ? undefined
        : 'candidate deployment slots must be unique',
    ),
  ),
  shell: Schema.Struct({
    deployment: OntosShellRuntimeContractSchema.fields.deployment,
    federationManifest: ApplicationCompositionArtifactReferenceSchema,
    runtimeContract: ApplicationCompositionArtifactReferenceSchema,
  }),
}).check(
  Schema.makeFilter((candidate) =>
    candidate.baseline.retainedModuleAppIds.every((id) => candidate.modules.some((module) => module.appId === id))
      ? undefined
      : 'retained baseline slots must belong to complete candidate membership',
  ),
);
type PublicationCandidate = typeof ApplicationCompositionPublicationCandidateSchema.Type;

const samePublicationIds = (expected: readonly string[], actual: readonly string[]) =>
  expected.length === actual.length && expected.every((id, index) => id === actual[index]);

const requireExpectedReleasePartition = Effect.fn('ActiveApplicationComposition.expectedPartition')(
  function* requireExpectedPartition(input: {
    readonly candidate: PublicationCandidate;
    readonly intent: ApplicationReleaseIntent;
    readonly selection: ApplicationReleaseSelection;
  }) {
    const { candidate, intent, selection } = input;
    const desired = intent.modules.map(({ appId }) => appId);
    const complete = selection.complete.map(({ id }) => id);
    const partition = [...selection.fresh, ...selection.retained].map(({ id }) => id);
    const removed = selection.removed.map(({ appId }) => appId);
    const slots = new Set(desired);
    if (
      slots.size !== desired.length ||
      slots.has(SHELL_APP_ID) ||
      !samePublicationIds(desired, complete) ||
      !samePublicationIds(
        desired,
        candidate.modules.map(({ appId }) => appId),
      ) ||
      partition.length !== desired.length ||
      new Set(partition).size !== desired.length ||
      partition.some((id) => !slots.has(id)) ||
      new Set(removed).size !== removed.length ||
      removed.some((id) => slots.has(id)) ||
      selection.shell.unit.id !== SHELL_APP_ID ||
      !samePublicationIds(
        selection.retained.map(({ id }) => id),
        candidate.baseline.retainedModuleAppIds,
      ) ||
      selection.shell.mode !== candidate.baseline.shellMode
    ) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'expected composition must bind the exact reviewed membership and release partition',
        reason: 'invalid_observation',
      });
    }
    return desired;
  },
);

/** Planning identity only: full semantic validation and exact reviewed artifact/selection binding. */
export const validateExpectedApplicationComposition = Effect.fn('ActiveApplicationComposition.validateExpected')(
  function* validateExpected(input: {
    readonly candidate: PublicationCandidate;
    readonly composition: ApplicationComposition;
    readonly intent: ApplicationReleaseIntent;
    readonly selection: ApplicationReleaseSelection;
  }) {
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
      onExcessProperty: 'error',
    })(input.candidate);
    const composition = yield* Schema.decodeUnknownEffect(ApplicationCompositionSchema, { onExcessProperty: 'error' })(
      input.composition,
    );
    const intent = yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema, { onExcessProperty: 'error' })(
      input.intent,
    );
    const selection = yield* Schema.decodeUnknownEffect(ApplicationReleaseSelectionSchema, {
      onExcessProperty: 'error',
    })(input.selection);
    yield* buildApplicationCompositionCatalog(composition);
    const desired = yield* requireExpectedReleasePartition({ candidate, intent, selection });
    if (
      (intent.migrationRequirements === undefined) !== (selection.migrationRequirements === undefined) ||
      (intent.migrationRequirements !== undefined &&
        selection.migrationRequirements !== undefined &&
        !Schema.toEquivalence(ApplicationMigrationRequirementsSchema)(
          intent.migrationRequirements,
          selection.migrationRequirements,
        ))
    ) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'release selection changes the independently reviewed migration requirements',
        reason: 'invalid_observation',
      });
    }
    const byApp = new Map(composition.modules.map((module) => [module.deployment.appId, module]));
    if (byApp.size !== desired.length || desired.some((id) => !byApp.has(id))) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'expected composition differs from complete reviewed membership',
        reason: 'invalid_observation',
      });
    }
    const sameArtifact = Schema.toEquivalence(ApplicationCompositionArtifactReferenceSchema);
    const sameDeployment = Schema.toEquivalence(OntosDeploymentIdentitySchema);
    const sameBackend = Schema.toEquivalence(ApplicationCompositionBackendSchema);
    for (const expected of candidate.modules) {
      const module = byApp.get(expected.appId);
      if (
        module === undefined ||
        !sameDeployment(expected.deployment, module.deployment) ||
        !sameArtifact(expected.contract, module.contract) ||
        !sameBackend(expected.backend, module.backend) ||
        (module.federation.execution === 'browser'
          ? expected.federationManifest === undefined ||
            !sameArtifact(expected.federationManifest, module.federation.manifest)
          : expected.federationManifest !== undefined)
      ) {
        return yield* new ActiveApplicationCompositionPublicationError({
          message: 'expected composition differs from exact candidate module pins or backend',
          reason: 'invalid_observation',
        });
      }
    }
    if (
      !sameDeployment(candidate.shell.deployment, composition.shell.deployment) ||
      !sameArtifact(candidate.shell.runtimeContract, composition.shell.runtimeContract) ||
      !sameArtifact(candidate.shell.federationManifest, composition.shell.federationManifest)
    ) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'expected composition differs from exact candidate Shell pins',
        reason: 'invalid_observation',
      });
    }
    return composition;
  },
  Effect.mapError((cause) =>
    Schema.is(ActiveApplicationCompositionPublicationError)(cause)
      ? cause
      : new ActiveApplicationCompositionPublicationError({
          cause,
          message: 'expected composition failed complete semantic validation',
          reason: 'invalid_observation',
        }),
  ),
);

const readPublicationDocument = (file: string, maximumBytes: number) =>
  Effect.gen(function* readPublicationDocumentFile() {
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
    if (bytes.byteLength > maximumBytes) {
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
    return text;
  });

const readPublicationCandidate = (file: string) =>
  readPublicationDocument(file, 1024 * 1024).pipe(
    Effect.flatMap(
      Schema.decodeEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema), {
        onExcessProperty: 'error',
      }),
    ),
  );

export const readExpectedPublication = Effect.fn('ActiveApplicationComposition.readExpected')(
  function* readExpected(input: {
    readonly candidateFile: string;
    readonly expectedCompositionFile: string;
    readonly intent: ApplicationReleaseIntent;
    readonly selectionFile: string;
  }) {
    const candidate = yield* readPublicationCandidate(input.candidateFile);
    const composition = yield* readPublicationDocument(
      input.expectedCompositionFile,
      ONTOS_APPLICATION_COMPOSITION_MAX_BYTES,
    ).pipe(
      Effect.flatMap(
        Schema.decodeEffect(Schema.fromJsonString(ApplicationCompositionSchema), { onExcessProperty: 'error' }),
      ),
    );
    const selection = yield* readPublicationDocument(input.selectionFile, 1024 * 1024).pipe(
      Effect.flatMap(
        Schema.decodeEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema), { onExcessProperty: 'error' }),
      ),
    );
    return {
      candidate,
      composition: yield* validateExpectedApplicationComposition({
        candidate,
        composition,
        intent: input.intent,
        selection,
      }),
    };
  },
);

const fetchPinnedCandidateArtifact = Effect.fn('ActiveApplicationComposition.fetchPinnedArtifact')(
  function* fetchPinnedArtifact(appId: string, expected: typeof ApplicationCompositionArtifactReferenceSchema.Type) {
    const artifact = yield* fetchArtifact(appId, expected.url);
    if (createHash('sha256').update(artifact.bytes).digest('hex') !== expected.sha256) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message:
          appId === SHELL_APP_ID
            ? 'observed Shell artifacts differ from the exact approved candidate deployment or digests'
            : 'observed module artifact digest differs from the exact approved candidate pin',
        reason: 'invalid_observation',
      });
    }
    return artifact;
  },
);

const fetchCandidatePinnedArtifacts = Effect.fn('ActiveApplicationComposition.fetchCandidatePins')(
  function* fetchCandidatePinnedArtifacts(environment: string, candidate: PublicationCandidate) {
    const [modules, runtimeContract, federationManifest] = yield* Effect.all(
      [
        Effect.forEach(
          candidate.modules,
          (module) =>
            Effect.gen(function* observeCandidateModule() {
              const contract = yield* fetchPinnedCandidateArtifact(module.appId, module.contract);
              const document = yield* Effect.try({
                catch: (cause) =>
                  new ActiveApplicationCompositionPublicationError({
                    cause,
                    message: 'the pinned module contract is not valid UTF-8',
                    reason: 'invalid_observation',
                  }),
                try: () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contract.bytes),
              }).pipe(
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))),
                Effect.mapError(
                  (cause) =>
                    new ActiveApplicationCompositionPublicationError({
                      cause,
                      message: 'the pinned module contract failed validation',
                      reason: 'invalid_observation',
                    }),
                ),
              );
              if (
                document.deployment.appId !== module.deployment.appId ||
                document.deployment.buildMarker !== module.deployment.buildMarker
              ) {
                return yield* new ActiveApplicationCompositionPublicationError({
                  message: 'observed module deployment differs from the exact approved candidate deployment',
                  reason: 'invalid_observation',
                });
              }
              const observedManifest =
                module.federationManifest === undefined
                  ? undefined
                  : yield* fetchPinnedCandidateArtifact(module.appId, module.federationManifest);
              const common = { appId: module.appId, backend: module.backend, contract };
              return observedManifest === undefined ? common : { ...common, federationManifest: observedManifest };
            }),
          { concurrency: 4 },
        ),
        fetchArtifact(SHELL_APP_ID, candidate.shell.runtimeContract.url),
        fetchArtifact(SHELL_APP_ID, candidate.shell.federationManifest.url),
      ],
      { concurrency: 3 },
    );
    const artifacts: ApplicationCompositionPinnedArtifacts = {
      environment,
      modules,
      shell: { federationManifest, runtimeContract },
    };
    return artifacts;
  },
);

const observePinnedCandidateBackends = (artifacts: ApplicationCompositionPinnedArtifacts) =>
  Effect.forEach(
    artifacts.modules,
    (module) =>
      observeApplicationCompositionBackend({
        appId: module.appId,
        backend: module.backend,
        contract: module.contract,
      }).pipe(Effect.map((backend) => ({ ...module, backend }))),
    { concurrency: 4 },
  );

/** Prepare only content identity: public pinned bytes and declared backends are not deployment approval. */
export const prepareCandidate = Effect.fn('ActiveApplicationComposition.prepareCandidate')(function* prepareCandidate(
  environment: string,
  input: {
    readonly candidate: PublicationCandidate;
    readonly intent: ApplicationReleaseIntent;
    readonly selection: ApplicationReleaseSelection;
  },
  options: { readonly observeBackends?: boolean } = {},
) {
  const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
    onExcessProperty: 'error',
  })(input.candidate);
  const pinned = yield* fetchCandidatePinnedArtifacts(environment, candidate);
  const artifacts =
    options.observeBackends === true ? { ...pinned, modules: yield* observePinnedCandidateBackends(pinned) } : pinned;
  const composition = yield* deriveApplicationComposition(artifacts);
  return yield* validateExpectedApplicationComposition({ ...input, candidate, composition });
});

/** Full installation observation. Runtime availability never filters this approved inventory. */
export const observeCandidate = Effect.fn('ActiveApplicationComposition.observeCandidate')(function* observeCandidate(
  environment: string,
  input: PublicationCandidate,
  expectedComposition?: ApplicationComposition,
) {
  const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError(
      (cause) =>
        new ActiveApplicationCompositionPublicationError({
          cause,
          message: 'the exact publication candidate failed validation',
          reason: 'invalid_observation',
        }),
    ),
  );
  const pinned = yield* fetchCandidatePinnedArtifacts(environment, candidate);
  const modules = yield* observePinnedCandidateBackends(pinned);
  const { federationManifest, runtimeContract } = pinned.shell;
  const observedAt = yield* DateTime.now;
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment,
    modules,
    observedAt,
    shell: { federationManifest, runtimeContract },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
  if (expectedComposition !== undefined && snapshot.composition.revision !== expectedComposition.revision) {
    return yield* new ActiveApplicationCompositionPublicationError({
      message: 'actual observed composition differs from the expected migration target',
      reason: 'conflicting_revision',
    });
  }
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

// Before the first authority row the obsolete pointer must be gone; afterwards the active pointer is
// this system's own release, so later publications re-observe only the retired executables.
const configuredInitialCutover = (environment: string) =>
  Effect.gen(function* verifyConfiguredInitialCutover() {
    const [inventoryFile, receiptFile] = yield* Effect.all([
      Config.String('ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE'),
      Config.String('ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE'),
    ]);
    const database = yield* CoreDatabase;
    const [schema] = yield* database.executor.execute<{ readonly initialized: boolean }>(
      sql`select to_regclass('core.application_composition_authority') is not null as initialized`,
      'objects',
    );
    const published =
      (schema?.initialized ?? false) &&
      (yield* database.executor
        .select({ revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'))).length > 0;
    const input = { environment, inventoryFile, receiptFile };
    yield* published ? verifyRetiredCompositionCutover(input) : verifyInitialCompositionCutover(input);
  });

const quiesceInitialCutoverCommand = Command.make(
  'quiesce-initial-cutover',
  {
    environment: Flag.String('environment'),
    inventoryFile: Flag.String('inventory-file'),
    receiptFile: Flag.String('receipt-file'),
  },
  quiesceInitialCompositionCutover,
).pipe(Command.provide(() => ZeropsPublicApiLive));

const verifyInitialCutoverCommand = Command.make(
  'verify-initial-cutover',
  { environment: Flag.String('environment') },
  ({ environment }) => verifyInitialApplicationCompositionPublicationEnvironment(configuredInitialCutover(environment)),
).pipe(Command.provide(() => Layer.merge(ApplicationCompositionAuthorityAdminDatabaseLive, ZeropsPublicApiLive)));

interface MigrationProviderDeployment {
  readonly projectId: string;
  readonly providerCopyPath: string;
  readonly serviceId: string;
  readonly versionName: string;
}
const deployMigrationProvider = Effect.fn('ApplicationCompositionPublication.deployMigrationProvider')(
  function* deployMigrationProviderEffect(input: MigrationProviderDeployment) {
    const path = yield* Path.Path;
    const process = yield* ChildProcess.make(
      'zcli',
      [
        'push',
        '--working-dir',
        '.',
        '--zerops-yaml-path',
        input.providerCopyPath,
        '--workspace-state',
        'clean',
        '--deploy-git-folder',
        '--project-id',
        input.projectId,
        '--service-id',
        input.serviceId,
        '--setup',
        'migrator',
        '--version-name',
        input.versionName,
      ],
      { cwd: path.resolve(import.meta.dirname, '../..'), stderr: 'inherit', stdout: 'inherit' },
    );
    const exitCode = yield* process.exitCode;
    if (exitCode !== 0) {
      return yield* providerFailure('The native verified migrator deployment failed')();
    }
    return yield* Effect.void;
  },
);

const migrateCommand = Command.make(
  'migrate',
  {
    candidateFile: Flag.String(CANDIDATE_FILE_FLAG).pipe(Flag.optional),
    environment: Flag.String('environment'),
    expectedCompositionFile: Flag.String(EXPECTED_COMPOSITION_FILE_FLAG).pipe(Flag.optional),
    intentFile: Flag.String(RELEASE_INTENT_FILE_FLAG).pipe(Flag.withDefault(DEFAULT_RELEASE_INTENT_FILE)),
    projectId: Flag.String('project-id'),
    selectionFile: Flag.String(RELEASE_SELECTION_FILE_FLAG).pipe(Flag.optional),
    serviceId: Flag.String('service-id'),
    versionName: Flag.String('version-name'),
    zeropsYamlPath: Flag.String('zerops-yaml-path'),
  },
  ({
    candidateFile,
    environment,
    expectedCompositionFile,
    intentFile,
    projectId,
    selectionFile,
    serviceId,
    versionName,
    zeropsYamlPath,
  }) =>
    Effect.scoped(
      Effect.gen(function* migrateUnderNativePublicationLock() {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const appDirectory = path.resolve(import.meta.dirname, '..');
        const reviewedIntentFile = path.relative(appDirectory, path.resolve(appDirectory, intentFile));
        const intent = yield* readReviewedApplicationReleaseIntent(reviewedIntentFile);
        const requirements = yield* readApplicationMigrationRequirements(path.join(appDirectory, reviewedIntentFile));
        const prepared = yield* prepareApplicationMigrationPlan(requirements);
        const mode = applicationMigrationPublicationMode(prepared.plan);
        if (mode === 'none') {
          return yield* Effect.logInfo('Reviewed release requires no migration or owner verification');
        }
        if (Option.isNone(candidateFile) || Option.isNone(expectedCompositionFile) || Option.isNone(selectionFile)) {
          return yield* new ActiveApplicationCompositionPublicationError({
            message:
              'nonempty migration or verification requires candidate-file, selection-file and expected-composition-file',
            reason: 'invalid_observation',
          });
        }
        const expected = yield* readExpectedPublication({
          candidateFile: candidateFile.value,
          expectedCompositionFile: expectedCompositionFile.value,
          intent,
          selectionFile: selectionFile.value,
        });
        const precondition = {
          baselineRevision: expected.candidate.baseline.revision,
          targetRevision: expected.composition.revision,
        };
        const providerSource = yield* fileSystem.readFileString(path.resolve(zeropsYamlPath));
        const providerCopy = yield* materializeApplicationMigrationProvider(providerSource, {
          intentFile: reviewedIntentFile,
          verifyOnly: mode === 'verify-only',
        });
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'ontos-migration-publication-',
        });
        const providerCopyPath = path.join(temporaryDirectory, 'zerops.yaml');
        yield* fileSystem.writeFileString(providerCopyPath, providerCopy);
        const deployment = Effect.gen(function* deployAndStopMigrator() {
          const api = yield* ZeropsPublicApi;
          const stop = api.stopService(serviceId).pipe(
            Effect.mapError((failure) =>
              providerFailure(
                `The native migrator could not be independently verified as stopped: ${failure.message}`,
              )(),
            ),
            Effect.orDie,
          );
          return yield* Effect.acquireUseRelease(
            Effect.void,
            () => deployMigrationProvider({ projectId, providerCopyPath, serviceId, versionName }),
            () => stop,
          );
        });
        return yield* Layer.build(
          Layer.effectDiscard(
            runApplicationCompositionMigration(deployment, configuredInitialCutover(environment), precondition, mode),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                ApplicationCompositionAuthorityAdminDatabaseLive,
                ApplicationCompositionLegacyOwnersLive,
                ZeropsPublicApiLive,
              ),
            ),
          ),
        ).pipe(Effect.asVoid);
      }),
    ),
);

const resumeDurableWorkCommand = Command.make(
  'resume-durable-work',
  { expectedRevision: Flag.String('expected-revision') },
  ({ expectedRevision }) => resumeApplicationCompositionDurableWork(expectedRevision),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const captureApprovedSnapshotCommand = Command.make(
  'capture-approved-snapshot',
  {
    allowAbsent: Flag.Boolean('allow-absent'),
    baselineOnly: Flag.Boolean('baseline-only'),
    environment: Flag.Literals('environment', DeploymentEnvironmentSchema.literals),
    snapshotFile: Flag.String('snapshot-file'),
  },
  ({ allowAbsent, baselineOnly, environment, snapshotFile }) =>
    Effect.gen(function* captureApprovedSnapshot() {
      const captured = yield* captureApprovedApplicationCompositionSnapshot({ allowAbsent, baselineOnly });
      const fileSystem = yield* FileSystem.FileSystem;
      if (Option.isNone(captured)) {
        yield* fileSystem.writeFileString(snapshotFile, 'null\n');
        return yield* Effect.logInfo('Captured actual absence of provider pointer and native authority', {
          environment,
        });
      }
      const encoded = yield* encodeActiveApplicationCompositionSnapshot(captured.value);
      yield* fileSystem.writeFileString(snapshotFile, encoded);
      return yield* Effect.logInfo('Captured the exact approved release before migration', {
        environment,
        revision: captured.value.composition.revision,
      });
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const prepareCommand = Command.make(
  'prepare',
  {
    candidateFile: Flag.String(CANDIDATE_FILE_FLAG),
    environment: Flag.String('environment'),
    expectedCompositionFile: Flag.String(EXPECTED_COMPOSITION_FILE_FLAG),
    intentFile: Flag.String(RELEASE_INTENT_FILE_FLAG).pipe(Flag.withDefault(DEFAULT_RELEASE_INTENT_FILE)),
    observeBackends: Flag.Boolean('observe-backends'),
    selectionFile: Flag.String(RELEASE_SELECTION_FILE_FLAG),
  },
  ({ candidateFile, environment, expectedCompositionFile, intentFile, observeBackends, selectionFile }) =>
    Effect.gen(function* prepareExpectedComposition() {
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const candidate = yield* readPublicationCandidate(candidateFile);
      const selection = yield* readPublicationDocument(selectionFile, 1024 * 1024).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(ApplicationReleaseSelectionSchema), { onExcessProperty: 'error' }),
        ),
      );
      const composition = yield* prepareCandidate(environment, { candidate, intent, selection }, { observeBackends });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(expectedCompositionFile, canonicalizeApplicationComposition(composition));
      return yield* Effect.logInfo('Prepared expected content identity; deployment observation is still required', {
        revision: composition.revision,
      });
    }),
);

const publishCommand = Command.make(
  'publish',
  {
    candidateFile: Flag.String(CANDIDATE_FILE_FLAG),
    environment: Flag.String('environment'),
    expectedCompositionFile: Flag.String(EXPECTED_COMPOSITION_FILE_FLAG),
    intentFile: Flag.String(RELEASE_INTENT_FILE_FLAG).pipe(Flag.withDefault(DEFAULT_RELEASE_INTENT_FILE)),
    selectionFile: Flag.String(RELEASE_SELECTION_FILE_FLAG),
    snapshotFile: Flag.String('snapshot-file').pipe(Flag.optional),
  },
  ({ candidateFile, environment, expectedCompositionFile, intentFile, selectionFile, snapshotFile }) =>
    Effect.gen(function* publishExpectedCandidate() {
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const expected = yield* readExpectedPublication({
        candidateFile,
        expectedCompositionFile,
        intent,
        selectionFile,
      });
      const snapshot = yield* observeCandidate(environment, expected.candidate, expected.composition);
      return yield* publishSnapshot(
        snapshot,
        snapshotFile,
        configuredInitialCutover(environment),
        expected.candidate.baseline,
      );
    }),
).pipe(
  Command.provide(() =>
    Layer.mergeAll(
      ApplicationCompositionAuthorityAdminDatabaseLive,
      ApplicationCompositionLegacyOwnersLive,
      ZeropsPublicApiLive,
    ),
  ),
);

export const refreshApplicationComposition = Effect.fn('ActiveApplicationComposition.refresh')(
  function* refreshComposition(environment: string) {
    const current = yield* readPublishedSnapshot;
    if (Option.isNone(current)) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'composition storage has no approved release to refresh',
        reason: 'invalid_observation',
      });
    }
    const approved = yield* decodeActiveApplicationCompositionSnapshot(current.value);
    const candidate: PublicationCandidate = {
      baseline: {
        retainedModuleAppIds: approved.composition.modules.map(({ deployment }) => deployment.appId),
        revision: approved.composition.revision,
        shellMode: 'retained',
      },
      modules: approved.composition.modules.map((module) => {
        const common = {
          appId: module.deployment.appId,
          backend: module.backend,
          contract: module.contract,
          deployment: module.deployment,
        };
        return module.federation.execution === 'browser'
          ? { ...common, federationManifest: module.federation.manifest }
          : common;
      }),
      shell: {
        deployment: approved.composition.shell.deployment,
        federationManifest: approved.composition.shell.federationManifest,
        runtimeContract: approved.composition.shell.runtimeContract,
      },
    };
    const snapshot = yield* observeCandidate(environment, candidate, approved.composition);
    if (snapshot.composition.revision !== approved.composition.revision) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'refresh observed different release artifacts; an explicit promotion is required',
        reason: 'conflicting_revision',
      });
    }
    return yield* publishSnapshot(snapshot, Option.none(), configuredInitialCutover(environment), candidate.baseline);
  },
);

const refreshCommand = Command.make('refresh', { environment: Flag.String('environment') }, ({ environment }) =>
  refreshApplicationComposition(environment),
).pipe(
  Command.provide(() =>
    Layer.mergeAll(
      ApplicationCompositionAuthorityAdminDatabaseLive,
      ApplicationCompositionLegacyOwnersLive,
      ZeropsPublicApiLive,
    ),
  ),
);

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
).pipe(Command.provide(() => ZeropsPublicApiLive));

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
).pipe(Command.provide(() => ZeropsPublicApiLive));

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
).pipe(Command.provide(() => ZeropsPublicApiLive));

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
).pipe(Command.provide(() => ZeropsPublicApiLive));

const stageBackendOriginUnavailable = providerFailure(
  'The registered native Node backend origin could not be established',
);

/** Read only the registered service's automatic public origin; this neither provisions nor activates ingress. */
export const stageBackendUrl = Effect.fn('ActiveApplicationComposition.stageBackendUrl')(
  function* discoverStageBackendUrl(setup: string) {
    const serviceId = yield* stageServiceId(setup);
    const projectId = yield* Config.String('ZEROPS_PROJECT_ID');
    if (projectId.trim() === '') {
      return yield* stageBackendOriginUnavailable();
    }
    const api = yield* ZeropsPublicApi;
    const service = yield* api.serviceStack(serviceId);
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(service.name)) {
      return yield* stageBackendOriginUnavailable();
    }
    const environment = yield* api.projectEnvFile(projectId);
    const automatic = environment.get(`${service.name}_zeropsSubdomain`)?.trim();
    if (automatic === undefined || !/^(?:https:\/\/)?[a-z\d.-]+\/?$/iu.test(automatic)) {
      return yield* stageBackendOriginUnavailable();
    }
    const url = yield* Effect.try({
      catch: stageBackendOriginUnavailable,
      try: () => new URL(automatic.includes('://') ? automatic : `https://${automatic}`),
    });
    const nativeSuffix = '.zerops.app';
    const labels = url.hostname.slice(0, -nativeSuffix.length).split('.');
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/' ||
      !url.hostname.endsWith(nativeSuffix) ||
      labels.some((label) => label === 'localhost' || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(label))
    ) {
      return yield* stageBackendOriginUnavailable();
    }
    return `${url.origin}/`;
  },
  Effect.mapError(stageBackendOriginUnavailable),
);

const stageBackendUrlCommand = Command.make('stage-backend-url', { setup: Flag.String('setup') }, ({ setup }) =>
  stageBackendUrl(setup).pipe(Effect.flatMap(Console.log)),
).pipe(Command.provide(() => ZeropsPublicApiLive));

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

export const proveBuiltSnapshot = Effect.fn('ActiveApplicationComposition.proveBuiltSnapshot')(
  function* proveBuiltSnapshotEffect({
    snapshot,
    snapshotOutput,
  }: {
    readonly snapshot: ActiveApplicationCompositionSnapshot;
    readonly snapshotOutput?: string;
  }) {
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const decoded = yield* decodeActiveApplicationCompositionSnapshot(encoded);
    if (decoded.composition.revision !== snapshot.composition.revision) {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'the decoded snapshot names a different Application Composition revision',
        reason: 'invalid_observation',
      });
    }
    if (snapshotOutput !== undefined) {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(snapshotOutput, encoded);
    }
    return yield* Effect.logInfo('Built artifacts form an active Application Composition snapshot consumers decode', {
      modules: decoded.composition.modules.map(({ federation, moduleId }) => `${moduleId} (${federation.execution})`),
      revision: decoded.composition.revision,
    });
  },
);

const proveBuildCommand = Command.make(
  'prove-build',
  { snapshotOutput: Flag.String('snapshot-output').pipe(Flag.optional) },
  ({ snapshotOutput }) =>
    Effect.gen(function* proveBuild() {
      const snapshot = yield* deriveBuiltSnapshot(yield* DateTime.now);
      yield* proveBuiltSnapshot(
        Option.isSome(snapshotOutput) ? { snapshot, snapshotOutput: snapshotOutput.value } : { snapshot },
      );
    }),
);

const cli = Command.make('publish-active-application-composition').pipe(
  Command.withSubcommands([
    captureApprovedSnapshotCommand,
    prepareCommand,
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
    stageBackendUrlCommand,
    stopServiceCommand,
    workerModeDriftCommand,
  ]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(main).pipe(
        Layer.provide(OpsShellLive),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Reactivity.layer,
            FetchHttpClient.layer,
            Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
          ),
        ),
      ),
    ).pipe(Effect.scoped),
  );
}
