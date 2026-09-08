import { it, layer } from 'effect-rstest';
import { Effect, Layer } from 'effect';
import { test } from '@playwright/test';

it('synchronous callback', () => {});
it.effect('native program', () => Effect.void);
layer(Layer.empty)('suite', (suiteIt) => {
  suiteIt('synchronous layer callback', () => {});
  suiteIt.effect('native layer program', () => Effect.void);
});
it('shadowed Promise', () => {
  const Promise = { resolve: () => 1 };
  return Promise.resolve();
});
it('unused nested Promise thunk', () => {
  const thunk = () => Promise.resolve();
  void thunk;
});
function registerLocally(suiteIt: (name: string, callback: () => void) => void) {
  suiteIt('unrelated parameter', async () => {});
}
void registerLocally;
test('SDK adapter', async () => {});
