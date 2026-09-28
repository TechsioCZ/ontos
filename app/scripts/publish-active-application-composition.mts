#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, DateTime, Duration, Effect, FileSystem, Layer, Option, Path, Schedule, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { parse as parseYaml } from 'yaml';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
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
import type { ObservedArtifact, ObservedModuleDeployment } from './active-application-composition.mts';
import { ZeropsApiError } from './zerops-public-api-error.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from './zerops-public-api.mts';

const SHELL_APP_ID = 'shell-super-app';
const SHELL_ZEROPS_SETUP = 'shellsuperapp';
const MF_MANIFEST_PATH = '/mf-manifest.json';
const BUILD_PROOF_ENVIRONMENT = 'build-proof';
const CONSUMER_READINESS_TIMEOUT = Duration.minutes(5);
const CONSUMER_READINESS_POLL = Duration.seconds(5);
const CONSUMER_PREFLIGHT = `test -n "$${ACTIVE_APPLICATION_COMPOSITION_POLICY.projectVariable}"`;

/** One deployed unit could not be observed; recovery keys on the unit's app ID. */
export class ActiveApplicationCompositionObservationError extends Schema.TaggedError<ActiveApplicationCompositionObservationError>()(
  'ActiveApplicationCompositionObservationError',
  { appId: OntosDeploymentAppIdSchema, cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      id: OntosDeploymentAppIdSchema,
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

const StageVariablesSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const SetupListJsonSchema = Schema.fromJsonString(Schema.Array(Schema.String));

/** Zerops setups whose start preflight requires the published snapshot; they are its consumers. */
export const compositionConsumerSetups = (zeropsYamlText: string) =>
  Schema.decodeUnknownEffect(ZeropsYamlSchema)(parseYaml(zeropsYamlText)).pipe(
    Effect.map(({ zerops }) =>
      zerops.filter(({ run }) => run?.start?.includes(CONSUMER_PREFLIGHT) === true).map(({ setup }) => setup),
    ),
  );

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

const readTopology = readWorkspaceText('topology', 'reference-topology.json').pipe(
  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TopologySchema))),
);

const readConsumerSetups = readWorkspaceText('zerops.yaml').pipe(Effect.flatMap(compositionConsumerSetups));

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
const fetchArtifact = Effect.fn('ActiveApplicationComposition.fetchArtifact')(function* fetchArtifact(
  appId: string,
  url: string,
) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const body = yield* client
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader('cache-control', 'no-cache')))
    .pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.mapError(unobservable(appId, `${url} could not be observed`)),
      Effect.timeoutOrElse({
        duration: ARTIFACT_FETCH_TIMEOUT,
        orElse: () =>
          Effect.fail(new ActiveApplicationCompositionObservationError({ appId, message: `${url} timed out` })),
      }),
    );
  if (body.byteLength > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
    return yield* new ActiveApplicationCompositionObservationError({
      appId,
      message: `${url} exceeds the artifact size bound`,
    });
  }
  const artifact: ObservedArtifact = { bytes: new Uint8Array(body), url };
  return artifact;
});

interface StageUnit {
  readonly origin: string;
  readonly vertical: TopologyVertical;
}

const observeStageModule = ({ origin, vertical }: StageUnit) =>
  vertical.surfaceProfile === 'api-only'
    ? fetchArtifact(vertical.id, artifactUrl(origin, ONTOS_MODULE_CONTRACT_PATH)).pipe(
        Effect.map((contract): ObservedModuleDeployment => ({ appId: vertical.id, contract })),
      )
    : Effect.all(
        [
          fetchArtifact(vertical.id, artifactUrl(origin, ONTOS_MODULE_CONTRACT_PATH)),
          fetchArtifact(vertical.id, artifactUrl(origin, MF_MANIFEST_PATH)),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([contract, federationManifest]): ObservedModuleDeployment => ({
          appId: vertical.id,
          contract,
          federationManifest,
        })),
      );

const stageServiceId = Effect.fn('ActiveApplicationComposition.stageServiceId')(function* stageServiceId(
  setup: string,
) {
  const variables = yield* Config.String('STAGE_VARIABLES_JSON').pipe(
    Effect.flatMap(Schema.decodeEffect(StageVariablesSchema)),
  );
  const serviceId = variables[serviceIdVariable(setup)];
  if (serviceId === undefined || serviceId === '') {
    return yield* new ZeropsApiError({ message: `missing stage service variable ${serviceIdVariable(setup)}` });
  }
  return serviceId;
});

const publicOrigin = Effect.fn('ActiveApplicationComposition.publicOrigin')(function* publicOrigin(
  environment: ReadonlyMap<string, string>,
  setup: string,
) {
  const api = yield* ZeropsPublicApi;
  const service = yield* api.serviceStack(yield* stageServiceId(setup));
  const origin = environment.get(`${service.name}_zeropsSubdomain`);
  if (origin === undefined || !service.subdomainAccess) {
    return yield* new ZeropsApiError({ message: `${setup} has no enabled public Zerops subdomain` });
  }
  return origin;
});

/** Observes every installed module except explicitly pending ones, then publishes one snapshot. */
const publishOnce = Effect.fn('ActiveApplicationComposition.publishOnce')(function* publishOnce(
  environment: string,
  excludedApps: readonly string[],
) {
  const api = yield* ZeropsPublicApi;
  const projectId = yield* Config.String('ZEROPS_PROJECT_ID');
  const [topology, envFile] = yield* Effect.all([readTopology, api.projectEnvFile(projectId)], { concurrency: 2 });
  const units = yield* Effect.forEach(
    topology.verticals.filter(({ id }) => !excludedApps.includes(id)),
    (vertical) => publicOrigin(envFile, vertical.id).pipe(Effect.map((origin): StageUnit => ({ origin, vertical }))),
    { concurrency: 4 },
  );
  const shellOrigin = yield* publicOrigin(envFile, SHELL_ZEROPS_SETUP);
  const [modules, runtimeContract, federationManifest, observedAt] = yield* Effect.all(
    [
      Effect.forEach(units, observeStageModule, { concurrency: 4 }),
      fetchArtifact(SHELL_APP_ID, artifactUrl(shellOrigin, ONTOS_SHELL_RUNTIME_CONTRACT_PATH)),
      fetchArtifact(SHELL_APP_ID, artifactUrl(shellOrigin, MF_MANIFEST_PATH)),
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
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
  const key = ACTIVE_APPLICATION_COMPOSITION_POLICY.projectVariable;
  const existing = (yield* api.projectEnvs(projectId)).find((env) => env.key === key);
  yield* assertNoConflictingPublication(Option.fromNullishOr(existing?.content), snapshot);
  yield* api.upsertProjectEnv(projectId, existing, key, encoded);
  const published = (yield* api.projectEnvs(projectId)).find((env) => env.key === key);
  if (published?.content !== encoded) {
    return yield* new ZeropsApiError({ message: `${key} does not hold the value that was just published` });
  }
  yield* decodeActiveApplicationCompositionSnapshot(published.content);
  yield* Effect.logInfo('Published the active Application Composition', {
    modules: snapshot.composition.modules.map(({ federation, moduleId }) => `${moduleId} (${federation.execution})`),
    revision: snapshot.composition.revision,
    validUntil: DateTime.formatIso(snapshot.validUntil),
  });
  return snapshot;
});

/** Consumers read the variable only at process start, so every publication restarts them. */
const restartConsumers = Effect.gen(function* restartConsumers() {
  const api = yield* ZeropsPublicApi;
  const projectId = yield* Config.String('ZEROPS_PROJECT_ID');
  const [consumers, topology, envFile] = yield* Effect.all(
    [readConsumerSetups, readTopology, api.projectEnvFile(projectId)],
    { concurrency: 3 },
  );
  yield* Effect.forEach(
    consumers,
    Effect.fnUntraced(function* restartConsumer(setup) {
      yield* api.restartService(yield* stageServiceId(setup));
      if (topology.verticals.some(({ id }) => id === setup)) {
        const origin = yield* publicOrigin(envFile, setup);
        yield* fetchArtifact(setup, artifactUrl(origin, ONTOS_MODULE_CONTRACT_PATH)).pipe(
          Effect.retry(Schedule.spaced(CONSUMER_READINESS_POLL)),
          Effect.timeoutOrElse({
            duration: CONSUMER_READINESS_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ActiveApplicationCompositionObservationError({
                  appId: setup,
                  message: `${setup} did not become ready`,
                }),
              ),
          }),
        );
      }
      return yield* Effect.logInfo(`Restarted composition consumer ${setup}`);
    }),
    { concurrency: 1, discard: true },
  );
});

const publishCommand = Command.make(
  'publish',
  {
    environment: Flag.String('environment'),
    excludedApps: Flag.String('exclude-app').pipe(Flag.atLeast(0)),
    recoverConsumers: Flag.Boolean('recover-consumers').pipe(Flag.withDefault(false)),
    restartConsumers: Flag.Boolean('restart-consumers').pipe(Flag.withDefault(false)),
  },
  ({ environment, excludedApps, recoverConsumers, restartConsumers: restart }) =>
    Effect.gen(function* publish() {
      const consumers = yield* readConsumerSetups;
      const complete = publishOnce(environment, excludedApps).pipe(
        Effect.andThen(restart ? restartConsumers : Effect.void),
      );
      if (!recoverConsumers) {
        return yield* complete;
      }
      // A consumer that stopped because its snapshot expired cannot be observed. Publish the inventory
      // without it, restart it on that snapshot, then observe and publish the complete inventory.
      return yield* complete.pipe(
        Effect.catchTag('ActiveApplicationCompositionObservationError', (error) =>
          consumers.includes(error.appId)
            ? Effect.logWarning(`Composition consumer ${error.appId} is unobservable; recovering it`).pipe(
                Effect.andThen(publishOnce(environment, [...excludedApps, ...consumers])),
                Effect.andThen(restartConsumers),
                Effect.andThen(complete),
              )
            : Effect.fail(error),
        ),
      );
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

/** The one service-ID lookup the deploy scripts use, so shell and TypeScript never map setups differently. */
const stageServiceIdCommand = Command.make('stage-service-id', { setup: Flag.String('setup') }, ({ setup }) =>
  stageServiceId(setup).pipe(Effect.flatMap(Console.log)),
);

const consumersCommand = Command.make('consumers', {}, () =>
  Effect.gen(function* consumers() {
    const json = yield* readConsumerSetups.pipe(Effect.flatMap(Schema.encodeEffect(SetupListJsonSchema)));
    yield* Effect.logInfo(`Composition consumers: ${json}`);
    return yield* writeGitHubOutput(`consumers=${json}`);
  }),
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
      Effect.map((artifact): ObservedModuleDeployment => ({ appId: vertical.id, contract: artifact })),
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
    publishCommand,
    ensurePublicAccessCommand,
    consumersCommand,
    proveBuildCommand,
    stageServiceIdCommand,
  ]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(main).pipe(
        Layer.provide(ZeropsPublicApiLive),
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
