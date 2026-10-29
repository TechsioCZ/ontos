#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { isMap, isSeq, parseDocument } from 'yaml';

/**
 * `app/zerops.yaml` and the generated `app/zerops-providers.yaml` together describe stage, the
 * environment every push deploys. `zerops.yaml` stays under Zerops' 50 kB build-file limit, so it pushes
 * as-is; the providers together exceed it, so a deploy pushes each setup from its own one-setup copy
 * (`--output-directory`). A deployment to another environment pushes a copy that names that environment
 * in every build and runtime, so its services never run stage-only behaviour. Every runtime reaches SpiceDB over TLS and pins the in-project
 * `spicedb` service's gRPC certificate (`SPICEDB_CA_CERT`); production's copy also points every
 * runtime at production's SpiceDB endpoint, which that certificate must name.
 */
export const DEPLOYMENT_ENVIRONMENT_VARIABLE = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';
export const SPICEDB_ENDPOINT_VARIABLE = 'SPICEDB_ENDPOINT';

export const DeploymentEnvironmentSchema = Schema.Literals(['production', 'stage']);
export type DeploymentEnvironment = typeof DeploymentEnvironmentSchema.Type;

export type ZeropsEnvironmentTarget =
  | { readonly environment: 'production'; readonly spiceDbEndpoint: string }
  | { readonly environment: 'stage' };

export class ZeropsEnvironmentMaterializationError extends Schema.TaggedError<ZeropsEnvironmentMaterializationError>()(
  'ZeropsEnvironmentMaterializationError',
  { message: Schema.String },
) {}

const PHASES = ['build', 'run'] as const;

const variablePaths = (document: ReturnType<typeof parseDocument>, setupCount: number, variable: string) =>
  Array.from({ length: setupCount }, (_, index) => index).flatMap((index) =>
    PHASES.map((phase) => ['zerops', index, phase, 'envVariables', variable]).filter((path) => document.hasIn(path)),
  );

const ZEROPS_BUILD_FILE_LIMIT_BYTES = 50_000;

/** The app-relative files whose setups make up the deployment, in setup order. */
export const ZEROPS_DEPLOYMENT_FILES = ['zerops.yaml', 'zerops-providers.yaml'] as const;

const parseSetups = (zeropsYamlText: string, setup?: string) =>
  Effect.gen(function* parseSetupsEffect() {
    const document = parseDocument(zeropsYamlText);
    const setups = document.get('zerops');
    if (document.errors.length > 0 || !isSeq(setups)) {
      return yield* new ZeropsEnvironmentMaterializationError({ message: 'zerops.yaml has no zerops setups' });
    }
    if (setup !== undefined) {
      const matches = setups.items.filter((item) => isMap(item) && item.get('setup') === setup);
      if (matches.length !== 1) {
        return yield* new ZeropsEnvironmentMaterializationError({
          message: `zerops.yaml needs exactly one setup "${setup}", found ${matches.length}`,
        });
      }
      setups.items = matches;
    }
    return { document, setupCount: setups.items.length };
  });

const withinBuildFileLimit = (text: string, setup: string | undefined) => {
  const subject = setup === undefined ? 'zerops.yaml' : `zerops.yaml setup "${setup}"`;
  return new TextEncoder().encode(text).byteLength < ZEROPS_BUILD_FILE_LIMIT_BYTES
    ? Effect.succeed(text)
    : Effect.fail(
        new ZeropsEnvironmentMaterializationError({
          message: `${subject} must be smaller than ${String(ZEROPS_BUILD_FILE_LIMIT_BYTES)} bytes`,
        }),
      );
};

/** One zerops.yaml text holding the setups of every given deployment file, in order. */
export const joinZeropsDeployments = (texts: readonly string[]) =>
  Effect.gen(function* joinZeropsDeploymentsEffect() {
    const [first, ...rest] = texts;
    if (first === undefined) {
      return yield* new ZeropsEnvironmentMaterializationError({ message: 'no zerops.yaml to join' });
    }
    const { document } = yield* parseSetups(first);
    const setups = document.get('zerops');
    for (const text of rest) {
      const other = (yield* parseSetups(text)).document.get('zerops');
      if (isSeq(setups) && isSeq(other)) {
        setups.items.push(...other.items);
      }
    }
    return document.toString({ lineWidth: 0 });
  });

/** Retains exactly one setup unchanged, within Zerops' 50 kB build-file limit, for a setup that names no environment. */
export const selectZeropsSetup = (zeropsYamlText: string, setup: string) =>
  parseSetups(zeropsYamlText, setup).pipe(
    Effect.flatMap(({ document }) => withinBuildFileLimit(document.toString({ lineWidth: 0 }), setup)),
  );

const configureZeropsEnvironment = (zeropsYamlText: string, target: ZeropsEnvironmentTarget, setup?: string) =>
  Effect.gen(function* configureZeropsEnvironmentEffect() {
    const { document, setupCount } = yield* parseSetups(zeropsYamlText, setup);
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
    return document.toString({ lineWidth: 0 });
  });

/** Configure `target`, optionally retaining exactly one setup, within Zerops' 50 kB build-file limit. */
export const materializeZeropsEnvironment = (zeropsYamlText: string, target: ZeropsEnvironmentTarget, setup?: string) =>
  configureZeropsEnvironment(zeropsYamlText, target, setup).pipe(
    Effect.flatMap((text) => withinBuildFileLimit(text, setup)),
  );

/** Configure `target` across every setup, then split it into one pushable file per setup. */
export const materializeZeropsSetupFiles = (zeropsYamlText: string, target: ZeropsEnvironmentTarget) =>
  Effect.gen(function* materializeZeropsSetupFilesEffect() {
    const text = yield* configureZeropsEnvironment(zeropsYamlText, target);
    const setups = parseDocument(text).get('zerops');
    const names = isSeq(setups) ? setups.items.map((item) => (isMap(item) ? item.get('setup') : undefined)) : [];
    return yield* Effect.all(
      names.map((setup) =>
        Schema.is(Schema.String)(setup) && /^[a-z][a-z0-9-]*$/u.test(setup)
          ? selectZeropsSetup(text, setup).pipe(Effect.map((file) => ({ file, setup })))
          : Effect.fail(
              new ZeropsEnvironmentMaterializationError({
                message: `zerops.yaml setup "${String(setup)}" cannot name a file`,
              }),
            ),
      ),
    );
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
    input: Flag.String('input').pipe(Flag.atLeast(1)),
    output: Flag.String('output').pipe(Flag.optional),
    outputDirectory: Flag.String('output-directory').pipe(Flag.optional),
    setup: Flag.String('setup').pipe(Flag.optional),
    spiceDbEndpoint: Flag.String('spicedb-endpoint').pipe(Flag.optional),
  },
  ({ environment, input, output, outputDirectory, setup, spiceDbEndpoint }) =>
    Effect.gen(function* materialize() {
      const fileSystem = yield* FileSystem.FileSystem;
      const target = yield* commandTarget(environment, spiceDbEndpoint);
      const text = yield* joinZeropsDeployments(
        yield* Effect.all(input.map((file) => fileSystem.readFileString(file))),
      );
      if (Option.isSome(outputDirectory) && Option.isNone(output) && Option.isNone(setup)) {
        const files = yield* materializeZeropsSetupFiles(text, target);
        yield* fileSystem.makeDirectory(outputDirectory.value, { recursive: true });
        yield* Effect.all(
          files.map(({ file, setup: name }) =>
            fileSystem.writeFileString(`${outputDirectory.value}/${name}.yaml`, file),
          ),
        );
        return yield* Effect.logInfo(
          `Wrote ${String(files.length)} ${environment} one-setup zerops.yaml files to ${outputDirectory.value}`,
        );
      }
      if (Option.isNone(output) || Option.isSome(outputDirectory)) {
        return yield* new ZeropsEnvironmentMaterializationError({
          message: 'pass either --output, optionally with --setup, or --output-directory alone',
        });
      }
      yield* fileSystem.writeFileString(
        output.value,
        yield* materializeZeropsEnvironment(text, target, Option.getOrUndefined(setup)),
      );
      return yield* Effect.logInfo(`Wrote the ${environment} zerops.yaml to ${output.value}`);
    }),
);

export const main = Command.run({ version: '1.0.0' })(materializeCommand);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
