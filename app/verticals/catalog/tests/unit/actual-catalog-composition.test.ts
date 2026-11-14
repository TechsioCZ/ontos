import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  catalogSourceObservationProcess,
  deriveActualCatalogCompositionSnapshot,
} from '../support/actual-catalog-composition.fixture.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer), { excludeTestServices: true })(
  'native Catalog observation process',
  (suite) => {
    suite.effect('executes source larger than the Linux per-argument limit without truncation', () =>
      Effect.gen(function* largeCatalogObservation() {
        const source = `/*${'x'.repeat(256 * 1024)}*/ process.stdout.write('complete');`;
        const child = yield* catalogSourceObservationProcess(
          source,
          new URL('../../../../', import.meta.url).pathname,
          {},
        );
        const [output, code, errors] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: 3 },
        );
        expect(code, errors).toBe(0);
        expect(output).toBe('complete');
      }),
    );
    suite.effect(
      'derives the complete owner composition from genuine source declarations',
      () =>
        Effect.gen(function* completeSourceComposition() {
          const snapshot = yield* deriveActualCatalogCompositionSnapshot(
            new URL('../../../../', import.meta.url).pathname,
          );
          const catalog = snapshot.composition.modules.find(
            ({ deployment }) => deployment.appId === ultramodernDeliveryUnit.appId,
          );
          expect(catalog?.deployment).toEqual({
            appId: ultramodernDeliveryUnit.appId,
            buildMarker: ultramodernDeliveryUnit.buildMarker,
          });
          expect(catalog?.contractDocument).toContain('commerce.catalog');
          expect(snapshot.composition.shell.sharedSingletons.length).toBeGreaterThan(0);
        }),
      30_000,
    );
  },
);
