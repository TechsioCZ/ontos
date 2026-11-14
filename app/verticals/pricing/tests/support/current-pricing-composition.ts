import {
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { makeApiKeyGatewayNativeComposition } from '@app/shell-super-app/testing/api-key-gateway-native';
import { Effect, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

class PricingCompositionFixtureUnavailable extends Schema.TaggedError<PricingCompositionFixtureUnavailable>()(
  'PricingCompositionFixtureUnavailable',
  { cause: Schema.optionalKey(Schema.Defect()), message: Schema.String },
) {}

/**
 * An executable native Node boundary, not an in-process test runtime. The canonical producer and its
 * dynamically imported owner bundle must share the same registration registry. Native imports also
 * keep the tooling project out of Pricing's composite TypeScript project.
 */
const projectCurrentContracts = `
import { NodeServices } from '@effect/platform-node';
import { OntosModuleDeploymentContractSchema, OntosShellRuntimeContractSchema } from '@app/core-runtime';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { Effect, FileSystem, Schema } from 'effect';
import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
import { createShellRuntimeContract } from './scripts/ontos-shell-runtime-contract.ts';

const output = Schema.fromJsonString(Schema.Struct({
  modules: Schema.Array(OntosModuleDeploymentContractSchema),
  shell: OntosShellRuntimeContractSchema,
}));
const topology = Schema.fromJsonString(Schema.Struct({
  shell: Schema.Struct({
    deliveryUnit: Schema.Struct({ buildMarker: Schema.String, unitId: Schema.Literal('app/shell-super-app') }),
  }),
}));
const program = Effect.gen(function* projectContracts() {
  const workspaceRoot = process.cwd();
  const modules = yield* Effect.forEach(
    ['pricing', 'catalog', 'commerce-customer-context', 'commerce-market-catalog', 'price-group-catalog'],
    (vertical) => deriveOntosModuleDeploymentContract({ vertical, workspaceRoot }),
    { concurrency: 1 },
  );
  const fs = yield* FileSystem.FileSystem;
  const { shell } = yield* fs.readFileString('topology/reference-topology.json')
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(topology)));
  const identity = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
    generationBuildMarker: shell.deliveryUnit.buildMarker,
    unitId: shell.deliveryUnit.unitId,
    workspaceRoot,
  }));
  return yield* Schema.encodeEffect(output)({ modules, shell: createShellRuntimeContract(identity.buildMarker) });
});
const document = await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
process.stdout.write(document + '\\n');
`;

const projectedContracts = Schema.fromJsonString(
  Schema.Struct({
    modules: Schema.Array(OntosModuleDeploymentContractSchema),
    shell: OntosShellRuntimeContractSchema,
  }),
);

/**
 * Project the current owners through the repository's public contract producer. No private provider
 * registration, invented operation descriptor, deployment output, or permission grant is a fixture.
 * Node platform requirements belong to the test's outer Layer graph.
 */
export const makeCurrentPricingComposition = Effect.fn('PricingTests.currentComposition')(function* composition() {
  const workspaceRoot = new URL('../../../../', import.meta.url).pathname;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ['--input-type=module', '-e', projectCurrentContracts], {
      cwd: workspaceRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    }),
  );
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ],
    { concurrency: 3 },
  );
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new PricingCompositionFixtureUnavailable({
      message: `The native owner contract projection failed: ${stderr}`,
    });
  }
  const { modules, shell } = yield* Schema.decodeUnknownEffect(projectedContracts)(stdout);
  const pricing = modules.find((contract) => contract.manifest.module.id === 'commerce.pricing');
  if (pricing === undefined) {
    return yield* new PricingCompositionFixtureUnavailable({ message: 'The actual Pricing contract is absent' });
  }
  const shellDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(shell);
  const snapshot = yield* makeApiKeyGatewayNativeComposition(modules, 3_600_000, {
    document: shellDocument,
    receiverDeployment: shell.deployment,
  }).pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
  return { expectedDeployment: pricing.deployment, snapshot };
});
