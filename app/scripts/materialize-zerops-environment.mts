#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { isSeq, parseDocument } from 'yaml';
import { OUTBOX_WORKER_HOST } from './outbox-worker-delivery.mjs';

/**
 * `app/zerops.yaml` describes stage, the environment every push deploys. A deployment to another
 * environment pushes a copy that names that environment in every build and runtime, so its services
 * never run stage-only behaviour. Every runtime reaches SpiceDB over TLS and pins the in-project
 * `spicedb` service's gRPC certificate (`SPICEDB_CA_CERT`); production's copy also points every
 * runtime at production's SpiceDB endpoint, which that certificate must name.
 */
export const DEPLOYMENT_ENVIRONMENT_VARIABLE = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';
export const SPICEDB_ENDPOINT_VARIABLE = 'SPICEDB_ENDPOINT';

export const DeploymentEnvironmentSchema = Schema.Literals(['production', 'stage']);
export type DeploymentEnvironment = typeof DeploymentEnvironmentSchema.Type;

export type ZeropsEnvironmentTarget = (
  | { readonly environment: 'production'; readonly spiceDbEndpoint: string }
  | { readonly environment: 'stage' }
) & { readonly compositionIntentFile?: string };

export class ZeropsEnvironmentMaterializationError extends Schema.TaggedError<ZeropsEnvironmentMaterializationError>()(
  'ZeropsEnvironmentMaterializationError',
  { message: Schema.String },
) {}

const PHASES = ['build', 'run'] as const;

const variablePaths = (document: ReturnType<typeof parseDocument>, setupCount: number, variable: string) =>
  Array.from({ length: setupCount }, (_, index) => index).flatMap((index) =>
    PHASES.map((phase) => ['zerops', index, phase, 'envVariables', variable]).filter((path) => document.hasIn(path)),
  );

const setWorkerHostReleaseIntent = (
  document: ReturnType<typeof parseDocument>,
  setupCount: number,
  intentFile: string,
) =>
  Effect.gen(function* setHostReleaseIntent() {
    if (
      intentFile.length === 0 ||
      /^(?:\/|[A-Za-z]:[\\/])/u.test(intentFile) ||
      intentFile.split(/[\\/]/u).includes('..')
    ) {
      return yield* new ZeropsEnvironmentMaterializationError({
        message: 'the worker release intent must be a workspace-relative checkout file',
      });
    }
    const hosts = Array.from({ length: setupCount }, (_, index) => index).filter(
      (index) => document.getIn(['zerops', index, 'setup']) === OUTBOX_WORKER_HOST.stageSetup,
    );
    const [host] = hosts;
    if (hosts.length !== 1 || host === undefined || !document.hasIn(['zerops', host, 'build'])) {
      return yield* new ZeropsEnvironmentMaterializationError({
        message: 'the worker release intent requires exactly one executable host setup',
      });
    }
    document.setIn(['zerops', host, 'build', 'envVariables', 'COMPOSITION_INTENT_FILE'], intentFile);
    return yield* Effect.void;
  });

/** The zerops.yaml text with every build and runtime configured for `target`. */
export const materializeZeropsEnvironment = (zeropsYamlText: string, target: ZeropsEnvironmentTarget) =>
  Effect.gen(function* materializeZeropsEnvironmentEffect() {
    const document = parseDocument(zeropsYamlText);
    const setups = document.get('zerops');
    if (document.errors.length > 0 || !isSeq(setups)) {
      return yield* new ZeropsEnvironmentMaterializationError({ message: 'zerops.yaml has no zerops setups' });
    }
    const setupCount = setups.items.length;
    const environmentPaths = variablePaths(document, setupCount, DEPLOYMENT_ENVIRONMENT_VARIABLE);
    if (environmentPaths.length === 0) {
      return yield* new ZeropsEnvironmentMaterializationError({
        message: `no zerops.yaml setup sets ${DEPLOYMENT_ENVIRONMENT_VARIABLE}`,
      });
    }
    for (const path of environmentPaths) {
      document.setIn(path, target.environment);
    }
    if (target.environment === 'production') {
      if (target.spiceDbEndpoint.length === 0 || target.spiceDbEndpoint.includes('://')) {
        return yield* new ZeropsEnvironmentMaterializationError({
          message: `production needs its TLS SpiceDB endpoint as host:port, got "${target.spiceDbEndpoint}"`,
        });
      }
      const endpointPaths = variablePaths(document, setupCount, SPICEDB_ENDPOINT_VARIABLE);
      if (endpointPaths.length === 0) {
        return yield* new ZeropsEnvironmentMaterializationError({
          message: `no zerops.yaml setup sets ${SPICEDB_ENDPOINT_VARIABLE}`,
        });
      }
      for (const path of endpointPaths) {
        document.setIn(path, target.spiceDbEndpoint);
      }
    }
    if (target.compositionIntentFile !== undefined) {
      yield* setWorkerHostReleaseIntent(document, setupCount, target.compositionIntentFile);
    }
    return document.toString({ lineWidth: 0 });
  });

const commandTarget = (environment: DeploymentEnvironment, spiceDbEndpoint: Option.Option<string>) =>
  Effect.gen(function* commandTargetEffect() {
    if (environment === 'stage') {
      if (Option.isSome(spiceDbEndpoint)) {
        return yield* new ZeropsEnvironmentMaterializationError({
          message: 'stage reaches the in-project SpiceDB that zerops.yaml names; drop --spicedb-endpoint',
        });
      }
      return { environment } satisfies ZeropsEnvironmentTarget;
    }
    if (Option.isNone(spiceDbEndpoint)) {
      return yield* new ZeropsEnvironmentMaterializationError({
        message: 'production needs --spicedb-endpoint, the production environment variable SPICEDB_ENDPOINT',
      });
    }
    return { environment, spiceDbEndpoint: spiceDbEndpoint.value } satisfies ZeropsEnvironmentTarget;
  });

const materializeCommand = Command.make(
  'materialize-zerops-environment',
  {
    environment: Flag.Literals('environment', DeploymentEnvironmentSchema.literals),
    input: Flag.String('input'),
    output: Flag.String('output'),
    spiceDbEndpoint: Flag.String('spicedb-endpoint').pipe(Flag.optional),
  },
  ({ environment, input, output, spiceDbEndpoint }) =>
    Effect.gen(function* materialize() {
      const fileSystem = yield* FileSystem.FileSystem;
      const target = yield* commandTarget(environment, spiceDbEndpoint);
      const compositionIntentFile = yield* Config.String('COMPOSITION_INTENT_FILE').pipe(
        Config.withDefault('topology/application-release-intent.json'),
      );
      const text = yield* materializeZeropsEnvironment(yield* fileSystem.readFileString(input), {
        ...target,
        compositionIntentFile,
      });
      yield* fileSystem.writeFileString(output, text);
      yield* Effect.logInfo(`Wrote the ${environment} zerops.yaml to ${output}`);
    }),
);

export const main = Command.run({ version: '1.0.0' })(materializeCommand);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
