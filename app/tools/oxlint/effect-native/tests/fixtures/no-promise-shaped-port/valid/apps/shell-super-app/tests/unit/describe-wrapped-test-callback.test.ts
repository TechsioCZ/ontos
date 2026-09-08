import { describeWrapped, describeWrapped as describeSuite } from 'effect-rstest';
import * as suite from 'effect-rstest';
import { Effect, Layer } from 'effect';

describeWrapped('suite', (it) => {
  it('synchronous callback', () => {});
  it.effect('Effect callback', () => Effect.void);
  it.layer(Layer.empty)('nested layer', (nestedIt) => {
    nestedIt.effect('nested Effect callback', () => Effect.void);
  });
  describeSuite('nested wrapper', (nestedIt) => {
    nestedIt.effect('nested wrapper Effect callback', () => Effect.void);
  });
});
const localDescribe = suite.describeWrapped;
localDescribe('local alias', ((it) => {
  const check = it;
  check.effect('aliased Effect callback', () => Effect.void);
}) satisfies Parameters<typeof describeWrapped>[1]);
function unrelated(callbacks: {
  describeWrapped: (
    name: string,
    callback: (it: (name: string, callback: () => unknown) => void) => void,
  ) => void;
}) {
  callbacks.describeWrapped('ordinary callback object', (it) => {
    it('unrelated async callback', async () => {});
  });
}
void unrelated;
