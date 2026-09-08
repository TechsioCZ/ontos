// expect-count: 3
import { it, layer } from 'effect-rstest';
import { Layer } from 'effect';

it.layer(Layer.empty)('suite', (suiteIt) => {
  suiteIt('owned callback', async () => {});
  suiteIt.layer(Layer.empty)('nested', (nestedIt) => {
    nestedIt('nested callback', async () => {});
  });
});
layer(Layer.empty)('standalone', (suiteIt) => {
  suiteIt('owned callback', async () => {});
});
