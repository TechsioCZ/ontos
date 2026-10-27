import { Effect } from 'effect';
import { it as sdk } from 'effect-rstest';

declare const layer: unknown;
sdk.layer(layer, { excludeTestServices: true })((suite) => {
  suite.effect('external transaction race', () => Effect.gen(function* () {
    yield* Effect.sleep('20 millis');
  }));
});
