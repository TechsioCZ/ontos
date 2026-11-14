import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  OntosShellRuntimeContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import {
  makeOwnerApplicationCompositionFixture,
  makePublishedApplicationCompositionSnapshotFixture,
} from '@app/core-runtime/testing/module-contract';
import type { ActiveApplicationCompositionSnapshot, OntosModuleDeploymentContract } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { deriveOntosModuleDeploymentContract } from '../../../../scripts/generate-ontos-module-contract.mts';

const publishedContracts = new Map<string, OntosModuleDeploymentContract>();
const contractPlatform = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const unavailable = (cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: "The enrollment fixture could not derive a dependency owner's published contract",
  });

/** One dependency owner's real published contract, derived once per test process. */
const publishedDependencyContract = Effect.fn('EnrollmentTests.publishedDependencyContract')(
  function* publishedDependencyContract(appId: string) {
    const cached = publishedContracts.get(appId);
    if (cached !== undefined) {
      return cached;
    }
    const contract = yield* deriveOntosModuleDeploymentContract({ vertical: appId }).pipe(
      Effect.provide(contractPlatform),
      Effect.mapError(unavailable),
    );
    publishedContracts.set(appId, contract);
    return contract;
  },
);

/** The real owner's identity, embedded document, and content-addressed release are validated together. */
export const makeEnrollmentApplicationCompositionSnapshot = Effect.fn('EnrollmentTests.makeApplicationComposition')(
  function* makeEnrollmentApplicationComposition(buildMarker: string, additionalAppIds: readonly string[]) {
    const { snapshot } = yield* makeOwnerApplicationCompositionFixture({
      appId: ultramodernApiMarker.appId,
      buildMarker,
      ownerRegistration: commerceCustomerContextRegistration,
    });
    if (additionalAppIds.length === 0) {
      return snapshot;
    }
    // Derive the real public contracts without importing another owner's private registration.
    const contracts = yield* Effect.forEach(additionalAppIds, publishedDependencyContract, { concurrency: 1 });
    const shellDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))({
      contributionAbi: snapshot.composition.shell.contributionAbi,
      coreCapabilities: snapshot.composition.shell.coreCapabilities,
      deployment: snapshot.composition.shell.deployment,
      schemaVersion: '2',
    }).pipe(Effect.mapError(unavailable));
    return yield* makePublishedApplicationCompositionSnapshotFixture({
      contractInputs: [...snapshot.composition.modules.map(({ contractDocument }) => contractDocument), ...contracts],
      publishedShellRuntime: {
        document: shellDocument,
        receiverDeployment: snapshot.composition.shell.deployment,
      },
      validityMs: 300_000,
    }).pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot), Effect.mapError(unavailable));
  },
);

export const enrollmentApplicationCompositionSnapshot = makeEnrollmentApplicationCompositionSnapshot(
  ultramodernApiMarker.buildMarker,
  [],
);
export const enrollmentApplicationCompositionRevision = enrollmentApplicationCompositionSnapshot.pipe(
  Effect.map((snapshot) => snapshot.composition.revision),
);
export const enrollmentApplicationCompositionLayer = Layer.succeed(ActiveApplicationCompositionService, {
  load: enrollmentApplicationCompositionSnapshot,
});

const compositionSourceUrl = 'https://composition.enrollment-acceptance.test/active';

/**
 * The verification material the deployed gateway verifier and the production composition admission
 * read: the fixture's own snapshot served from the controlled composition source, with the caller's
 * gateway keys layered on top. This fixture builds the snapshot in process, so — unlike the
 * deployment's own support — it reads no published Shell artifact.
 */
/**
 * `ownerFetch` carries every request other than the composition source: the ordinary fetch, or a suite's fetch that
 * answers the remote owners it stands in for at their HTTP boundary.
 */
export const enrollmentApplicationCompositionVerificationLayer = (
  snapshot: ActiveApplicationCompositionSnapshot,
  gatewayConfiguration: Readonly<Record<string, string>> = {},
  ownerFetch: typeof globalThis.fetch = fetch,
) =>
  Layer.mergeAll(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...gatewayConfiguration,
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: compositionSourceUrl,
      }),
    ),
    Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
      const request = new Request(input, init);
      if (request.url === compositionSourceUrl) {
        return Response.json(snapshot);
      }
      return await ownerFetch(request);
    }),
  );
