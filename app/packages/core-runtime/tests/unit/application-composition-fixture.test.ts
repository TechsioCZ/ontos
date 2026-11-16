import { Effect, Schema } from 'effect';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { expect, it } from 'effect-rstest';

import { validateActiveApplicationCompositionSnapshot } from '../../src/modules/active-application-composition.ts';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
  makePublishedApplicationCompositionSnapshotFixture,
} from '../../src/testing/module-contract.ts';
import { ONTOS_SHELL_CONTRIBUTION_ABI } from '../../src/modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';

it.effect('retains separate receiving releases and validates exact composition documents and revision', () =>
  Effect.gen(function* separateReceivingReleases() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(['catalog', 'pricing'], {
      catalog: 'actual-catalog-build',
      pricing: 'actual-pricing-build',
    });
    expect(snapshot.composition.modules.map(({ deployment }) => deployment)).toEqual([
      { appId: 'catalog', buildMarker: 'actual-catalog-build' },
      { appId: 'pricing', buildMarker: 'actual-pricing-build' },
    ]);
    expect(yield* validateActiveApplicationCompositionSnapshot(snapshot)).toEqual(snapshot);
  }),
);

it.effect('preserves existing single-marker fixture callers', () =>
  Effect.gen(function* existingSingleMarker() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(['catalog', 'pricing'], 'existing-build');
    expect(snapshot.composition.modules.map(({ deployment }) => deployment.buildMarker)).toEqual([
      'existing-build',
      'existing-build',
    ]);
    expect(yield* validateActiveApplicationCompositionSnapshot(snapshot)).toEqual(snapshot);
  }),
);

it.effect('rejects a missing app marker without substituting another receiving release', () =>
  Effect.gen(function* missingReceivingRelease() {
    const result = yield* Effect.flip(
      makeApplicationCompositionSnapshotFixture(['catalog', 'pricing'], { catalog: 'catalog-only' }),
    );
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(result)).toBe(true);
  }),
);

const publishedReceiver = { appId: 'shell-super-app', buildMarker: 'published-fixture-shell' } as const;
const publishedShellDocument = JSON.stringify(
  {
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [],
    deployment: publishedReceiver,
    schemaVersion: '2',
  },
  null,
  2,
);

it.effect('builds published fixture DTOs from exact owner and receiving Shell documents', () =>
  Effect.gen(function* publishedContractBytes() {
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
      makeModuleContractFixture({ appId: 'catalog', buildMarker: 'published-catalog', moduleId: 'catalog.fixture' }),
    );
    const contractDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(OntosModuleDeploymentContractSchema, { space: 2 }),
    )(contract);
    const snapshot = yield* makePublishedApplicationCompositionSnapshotFixture({
      contractInputs: [contractDocument],
      publishedShellRuntime: { document: publishedShellDocument, receiverDeployment: publishedReceiver },
      validityMs: 60_000,
    });
    expect(snapshot.composition.modules[0]?.contractDocument).toBe(contractDocument);
    expect(snapshot.composition.shell.deployment).toEqual(publishedReceiver);
    expect(snapshot.composition.shell.runtimeContract.url).toContain('/releases/published-fixture-shell/');
    expect(yield* validateActiveApplicationCompositionSnapshot(snapshot)).toEqual(snapshot);
  }),
);

it.effect('rejects a different published receiver through the typed fixture failure', () =>
  Effect.gen(function* mismatchedPublishedReceiver() {
    const failure = yield* Effect.flip(
      makePublishedApplicationCompositionSnapshotFixture({
        contractInputs: [],
        publishedShellRuntime: {
          document: publishedShellDocument,
          receiverDeployment: { ...publishedReceiver, buildMarker: 'other-published-shell' },
        },
        validityMs: 60_000,
      }),
    );
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(failure)).toBe(true);
    expect(failure.reason).toBe('The actual Shell runtime document must match the compiled fixture receiver');
  }),
);

it.effect('rejects malformed published contracts and nonpositive validity through typed fixture failures', () =>
  Effect.gen(function* malformedPublishedFixtureData() {
    const receiver = { document: publishedShellDocument, receiverDeployment: publishedReceiver };
    const malformed = yield* Effect.flip(
      makePublishedApplicationCompositionSnapshotFixture({
        contractInputs: [{}],
        publishedShellRuntime: receiver,
        validityMs: 60_000,
      }),
    );
    const validity = yield* Effect.flip(
      makePublishedApplicationCompositionSnapshotFixture({
        contractInputs: [],
        publishedShellRuntime: receiver,
        validityMs: 0,
      }),
    );
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(malformed)).toBe(true);
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(validity)).toBe(true);
  }),
);
