import { NodeServices } from '@effect/platform-node';
import { Effect, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { catalogSourceObservationProcess } from '../support/actual-catalog-composition.fixture.ts';

it.layer(NodeServices.layer, { excludeTestServices: true })('native Catalog observation process', (suite) => {
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
});
