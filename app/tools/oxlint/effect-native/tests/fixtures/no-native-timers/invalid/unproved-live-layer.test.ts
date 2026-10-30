// expect-count: 3
import { Effect } from 'effect';
import { it } from 'effect-rstest';

declare const layer: unknown;
it.layer(layer, { excludeTestServices: false })((suite) => {
  suite.effect('ordinary unit timing', () => Effect.sleep('20 millis'));
});
const options = { excludeTestServices: true };
function shadowedOptions(options: { excludeTestServices: boolean }) {
  it.layer(layer, options)((suite) => {
    suite.effect('unknown clock', () => Effect.sleep('20 millis'));
  });
}
function fakeRunner(it: any) {
  it.layer(layer, { excludeTestServices: true })((suite) => {
    suite.effect('lookalike suite', () => Effect.sleep('20 millis'));
  });
}
