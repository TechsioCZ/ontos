import { NodeServices } from '@effect/platform-node';
import { OntosDeploymentAppIdSchema, ONTOS_SHELL_CONTRIBUTION_ABI } from '@app/core-runtime';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../../../../packages/core-runtime/src/modules/module-dependency-contracts.ts';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makePublishedApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';

const releaseIntentPath = new URL('../../../../topology/application-release-intent.json', import.meta.url);
const ReleaseIntentSchema = Schema.fromJsonString(
  Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })) }),
);

/**
 * The approved composition of every module the release installs, with this Shell as its receiver: what a deployed
 * Shell loads as its installed module catalog. Built from the release intent and each module's derived contract.
 */
export const installedReleaseComposition = Effect.gen(function* installedReleaseComposition() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const intent = yield* Schema.decodeUnknownEffect(ReleaseIntentSchema)(
    yield* fileSystem.readFileString(yield* path.fromFileUrl(releaseIntentPath)),
  );
  const contracts = yield* Effect.forEach(
    intent.modules,
    ({ appId }) => deriveOntosModuleDeploymentContract({ vertical: appId }),
    { concurrency: 4 },
  );
  const receiverDeployment = { appId: 'shell-super-app', buildMarker: ultramodernDeliveryUnit.buildMarker } as const;
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    deployment: receiverDeployment,
    schemaVersion: '2',
  });
  return yield* makePublishedApplicationCompositionSnapshotFixture({
    contractInputs: contracts,
    publishedShellRuntime: { document, receiverDeployment },
    validityMs: 600_000,
  });
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
