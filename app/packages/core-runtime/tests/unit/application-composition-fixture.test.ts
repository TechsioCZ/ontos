import { Effect, Schema } from 'effect';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { expect, it } from 'effect-rstest';

import { validateActiveApplicationCompositionSnapshot } from '../../src/modules/active-application-composition.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

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
