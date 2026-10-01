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
import {
  DeployTargetSchema,
  OUTBOX_WORKER_HOST,
  OutboxWorkerModeSchema,
  dedicatedOutboxWorkerSetup,
} from './outbox-worker-delivery.mjs';
import type { DeployTarget, OutboxWorkerMode } from './outbox-worker-delivery.mjs';
import { ZeropsApiError } from './zerops-public-api-error.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from './zerops-public-api.mts';

const SHELL_APP_ID = 'shell-super-app';
const SHELL_ZEROPS_SETUP = 'shellsuperapp';
const MF_MANIFEST_PATH = '/mf-manifest.json';
const BUILD_PROOF_ENVIRONMENT = 'build-proof';
const CONSUMER_READINESS_TIMEOUT = Duration.minutes(5);
const CONSUMER_READINESS_POLL = Duration.seconds(5);
const PUBLICATION_READBACK_POLL = Duration.seconds(3);
const PUBLICATION_READBACK_TIMEOUT = Duration.minutes(2);
const CONSUMER_PREFLIGHT = `test -n "$${ACTIVE_APPLICATION_COMPOSITION_POLICY.projectVariable}"`;

/** The environment's `DEPLOY_TARGET` variable; unset means `zerops`. */
const readDeployTarget = Config.schema(DeployTargetSchema, 'DEPLOY_TARGET').pipe(
  Config.withDefault<DeployTarget>('zerops'),
);

/**
 * The environment's `OUTBOX_WORKER_MODE` variable. It has no default: an environment that did not choose
 * between dedicated workers and the one host fails instead of silently running the other mode.
 */
const readOutboxWorkerMode = Config.schema(OutboxWorkerModeSchema, 'OUTBOX_WORKER_MODE');

/** One deployed unit could not be observed; recovery keys on the unit's app ID. */
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
const SetupListJsonSchema = Schema.fromJsonString(Schema.Array(Schema.String));

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

/** Zerops setups whose start preflight requires the published snapshot, whichever Outbox Worker mode runs. */
const snapshotConsumerSetups = (zeropsYamlText: string) =>
  Schema.decodeUnknownEffect(ZeropsYamlSchema)(parseYaml(zeropsYamlText)).pipe(
    Effect.map(({ zerops }) =>
      zerops.filter(({ run }) => run?.start?.includes(CONSUMER_PREFLIGHT) === true).map(({ setup }) => setup),
    ),
  );

/**
 * Zerops setups whose start preflight requires the published snapshot; they are its consumers. Only
 * the Outbox Worker mode's services run: the dedicated owner workers, or the one Outbox Worker host.
 */
export const compositionConsumerSetups = (
  zeropsYamlText: string,
  topology: { readonly verticals: readonly { readonly id: string }[] },
  mode: OutboxWorkerMode,
) => {
  const otherMode = otherModeWorkerSetupNames(topology, mode);
  return snapshotConsumerSetups(zeropsYamlText).pipe(
    Effect.map((consumers) => consumers.filter((setup) => !otherMode.has(setup))),
  );
};

/**
 * The consumers a deploy target runs on Zerops. On `zerops` that is every consumer. On `cloudflare` the
 * delivery units run as Workers, so only the consumers that are no delivery unit (the outbox workers)
 * are Zerops services this publication restarts.
 */
export const targetConsumerSetups = (
  consumers: readonly string[],
  target: DeployTarget,
  deliveryUnitSetups: ReadonlySet<string>,
): readonly string[] => (target === 'zerops' ? consumers : consumers.filter((setup) => !deliveryUnitSetups.has(setup)));

/** A snapshot consumer that runs as a placed Worker and reads the snapshot from its Worker secret. */
export interface EdgeCompositionConsumer {
  readonly packageName: string;
  readonly workerName: string;
}

/**
 * The placed Workers among the snapshot consumers. A Worker has no Zerops project variable, so on the
 * `cloudflare` target each publication must also reach them as a Worker secret of the same name.
 */
export const edgeCompositionConsumers = (
  consumers: readonly string[],
  topology: typeof TopologySchema.Type,
  placement: CloudflarePlacement,
): readonly EdgeCompositionConsumer[] =>
  topology.verticals.flatMap(({ cloudflare, id, package: packageName }) => {
    if (!consumers.includes(id) || !placement.units.includes(id)) {
      return [];
    }
    const workerName = cloudflare?.workerName;
    return packageName === undefined || workerName === undefined ? [] : [{ packageName, workerName }];
  });

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

const readPlacement = readWorkspaceText('topology', 'cloudflare-placement.json').pipe(
  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CloudflarePlacementSchema))),
);

/** The Zerops setup that serves a delivery unit on the `zerops` target. */
const zeropsSetupOf = (appId: string): string => (appId === SHELL_APP_ID ? SHELL_ZEROPS_SETUP : appId);

const readConsumerSetups = (target: DeployTarget, mode: OutboxWorkerMode) =>
  Effect.gen(function* readConsumerSetupsEffect() {
    const [zeropsYaml, topology] = yield* Effect.all([readZeropsYaml, readTopology], {
      concurrency: 2,
    });
    const consumers = yield* compositionConsumerSetups(zeropsYaml, topology, mode);
    return targetConsumerSetups(
      consumers,
      target,
      new Set([SHELL_ZEROPS_SETUP, ...topology.verticals.map(({ id }) => zeropsSetupOf(id))]),
    );
  });

/** The placed Worker consumers the deploy target must hand each publication to; none on `zerops`. */
export const readEdgeConsumers = (target: DeployTarget) =>
  Effect.gen(function* readEdgeConsumersEffect() {
    if (target !== 'cloudflare') {
      return [];
    }
    const [zeropsYaml, topology, placement] = yield* Effect.all([readZeropsYaml, readTopology, readPlacement], {
      concurrency: 3,
    });
    // Placed Workers are no Outbox Worker, so the Outbox Worker mode does not change this set.
    const consumers = yield* snapshotConsumerSetups(zeropsYaml);
    return edgeCompositionConsumers(consumers, topology, placement);
  });

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

const publicOrigin = Effect.fn('ActiveApplicationComposition.publicOrigin')(function* publicOrigin(
  environment: ReadonlyMap<string, string>,
  setup: string,
) {
  const api = yield* ZeropsPublicApi;
  const service = yield* api.serviceStack(yield* stageServiceId(setup));
  if (!service.subdomainAccess) {
    return yield* new ZeropsApiError({ message: `${setup} has its public Zerops subdomain disabled` });
  }
  const origin = environment.get(`${service.name}_zeropsSubdomain`);
  if (origin === undefined) {
    return yield* new ZeropsApiError({ message: `the project env file has no ${service.name}_zeropsSubdomain` });
  }
  return origin;
});

/**
 * Resolves each delivery unit's public origin on the deploy target: the Zerops subdomain of its
 * service, or the Worker URL its edge build is given.
 */
type OriginOf = (
  appId: string,
) => Effect.Effect<
  string,
  ActiveApplicationCompositionPublicationError | Config.ConfigError | Schema.SchemaError | ZeropsApiError,
  ZeropsPublicApi
>;

const originResolver = Effect.fn('ActiveApplicationComposition.originResolver')(function* originResolver(
  target: DeployTarget,
) {
  if (target === 'cloudflare') {
    const placement = yield* readPlacement;
    const workerOrigin: OriginOf = (appId) => cloudflareOrigin(placement, appId);
    return workerOrigin;
  }
  const api = yield* ZeropsPublicApi;
  const envFile = yield* api.projectEnvFile(yield* Config.String('ZEROPS_PROJECT_ID'));
  const subdomainOrigin: OriginOf = (appId) => publicOrigin(envFile, zeropsSetupOf(appId));
  return subdomainOrigin;
});

/** Observes every installed module except explicitly pending ones, then publishes one snapshot. */
const publishOnce = Effect.fn('ActiveApplicationComposition.publishOnce')(function* publishOnce(
  environment: string,
  excludedApps: readonly string[],
  target: DeployTarget,
  snapshotFile: Option.Option<string>,
) {
  const api = yield* ZeropsPublicApi;
  const projectId = yield* Config.String('ZEROPS_PROJECT_ID');
  const [topology, originOf] = yield* Effect.all([readTopology, originResolver(target)], { concurrency: 2 });
  const units = yield* Effect.forEach(
    topology.verticals.filter(({ id }) => !excludedApps.includes(id)),
    (vertical) => originOf(vertical.id).pipe(Effect.map((origin): StageUnit => ({ origin, vertical }))),
    { concurrency: 4 },
  );
  const shellOrigin = yield* originOf(SHELL_APP_ID);
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
  // Project variables are listed through Zerops search, which reflects a finished write only eventually.
  const published = yield* api.projectEnvs(projectId).pipe(
    Effect.map((envs) => envs.find((env) => env.key === key)?.content),
    // A search that has not indexed the project yet is the same lag as a stale value: poll again.
    Effect.catchIf(
      (error) => error.reason === 'project_not_indexed',
      () => Effect.void,
    ),
    Effect.repeat({
      schedule: Schedule.spaced(PUBLICATION_READBACK_POLL),
      until: (content) => content === encoded,
    }),
    Effect.timeoutOrElse({
      duration: PUBLICATION_READBACK_TIMEOUT,
      orElse: () =>
        Effect.fail(new ZeropsApiError({ message: `${key} does not hold the value that was just published` })),
    }),
  );
  yield* decodeActiveApplicationCompositionSnapshot(published ?? '');
  // Placed Worker consumers have no Zerops project variable; the deploy hands them this file as a Worker secret.
  if (Option.isSome(snapshotFile)) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(snapshotFile.value, encoded);
  }
  yield* Effect.logInfo('Published the active Application Composition', {
    modules: snapshot.composition.modules.map(({ federation, moduleId }) => `${moduleId} (${federation.execution})`),
    revision: snapshot.composition.revision,
    validUntil: DateTime.formatIso(snapshot.validUntil),
  });
  return snapshot;
});

/** Consumers read the variable only at process start, so every publication restarts them. */
const restartConsumers = Effect.fn('ActiveApplicationComposition.restartConsumers')(function* restartConsumers(
  target: DeployTarget,
  mode: OutboxWorkerMode,
) {
  const api = yield* ZeropsPublicApi;
  const [consumers, topology, originOf] = yield* Effect.all(
    [readConsumerSetups(target, mode), readTopology, originResolver(target)],
    { concurrency: 3 },
  );
  yield* Effect.forEach(
    consumers,
    Effect.fnUntraced(function* restartConsumer(setup) {
      yield* api.restartService(yield* stageServiceId(setup));
      if (topology.verticals.some(({ id }) => id === setup)) {
        const origin = yield* originOf(setup);
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
    snapshotFile: Flag.String('snapshot-file').pipe(Flag.optional),
  },
  ({ environment, excludedApps, recoverConsumers, restartConsumers: restart, snapshotFile }) =>
    Effect.gen(function* publish() {
      const target = yield* readDeployTarget;
      const mode = yield* readOutboxWorkerMode;
      const consumers = yield* readConsumerSetups(target, mode);
      const complete = publishOnce(environment, excludedApps, target, snapshotFile).pipe(
        Effect.andThen(restart ? restartConsumers(target, mode) : Effect.void),
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
                Effect.andThen(publishOnce(environment, [...excludedApps, ...consumers], target, snapshotFile)),
                Effect.andThen(restartConsumers(target, mode)),
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

const EdgeConsumersJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ packageName: Schema.String, workerName: Schema.String })),
);

/** Writes `edge_consumers`: the placed Worker consumers that need each publication as a Worker secret. */
const edgeConsumersCommand = Command.make('edge-consumers', {}, () =>
  Effect.gen(function* edgeConsumers() {
    const json = yield* readDeployTarget.pipe(
      Effect.flatMap(readEdgeConsumers),
      Effect.flatMap(Schema.encodeEffect(EdgeConsumersJsonSchema)),
    );
    yield* Effect.logInfo(`Edge composition consumers: ${json}`);
    return yield* writeGitHubOutput(`edge_consumers=${json}`);
  }),
);

const consumersCommand = Command.make('consumers', {}, () =>
  Effect.gen(function* consumers() {
    const json = yield* Effect.all([readDeployTarget, readOutboxWorkerMode]).pipe(
      Effect.flatMap(([target, mode]) => readConsumerSetups(target, mode)),
      Effect.flatMap(Schema.encodeEffect(SetupListJsonSchema)),
    );
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
    edgeConsumersCommand,
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
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
