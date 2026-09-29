#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { isSeq, parseDocument } from 'yaml';

/**
 * `app/zerops.yaml` describes stage, the environment every push deploys. A deployment to another
 * environment pushes a copy that names that environment in every build and runtime, so its services
 * never run stage-only behaviour such as the insecure in-project SpiceDB transport.
 */
export const DEPLOYMENT_ENVIRONMENT_VARIABLE = 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT';

export const DeploymentEnvironmentSchema = Schema.Literals(['production', 'stage']);
export type DeploymentEnvironment = typeof DeploymentEnvironmentSchema.Type;

export class ZeropsEnvironmentMaterializationError extends Schema.TaggedError<ZeropsEnvironmentMaterializationError>()(
  'ZeropsEnvironmentMaterializationError',
  { message: Schema.String },
) {}

const PHASES = ['build', 'run'] as const;

/** The zerops.yaml text with every build and runtime that names its deployment environment naming `environment`. */
export const materializeZeropsEnvironment = (zeropsYamlText: string, environment: DeploymentEnvironment) =>
  Effect.gen(function* materializeZeropsEnvironmentEffect() {
    const document = parseDocument(zeropsYamlText);
    const setups = document.get('zerops');
    if (document.errors.length > 0 || !isSeq(setups)) {
      return yield* new ZeropsEnvironmentMaterializationError({ message: 'zerops.yaml has no zerops setups' });
    }
    const paths = setups.items.flatMap((_, index) =>
      PHASES.map((phase) => ['zerops', index, phase, 'envVariables', DEPLOYMENT_ENVIRONMENT_VARIABLE]).filter((path) =>
        document.hasIn(path),
      ),
    );
    if (paths.length === 0) {
      return yield* new ZeropsEnvironmentMaterializationError({
        message: `no zerops.yaml setup sets ${DEPLOYMENT_ENVIRONMENT_VARIABLE}`,
      });
    }
    for (const path of paths) {
      document.setIn(path, environment);
    }
    return document.toString({ lineWidth: 0 });
  });

const materializeCommand = Command.make(
  'materialize-zerops-environment',
  {
    environment: Flag.Literals('environment', DeploymentEnvironmentSchema.literals),
    input: Flag.String('input'),
    output: Flag.String('output'),
  },
  ({ environment, input, output }) =>
    Effect.gen(function* materialize() {
      const fileSystem = yield* FileSystem.FileSystem;
      const text = yield* materializeZeropsEnvironment(yield* fileSystem.readFileString(input), environment);
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
