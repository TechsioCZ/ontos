// expect-count: 7
import { describeWrapped, describeWrapped as describeSuite } from '@app/effect-rstest';
import * as suite from '@app/effect-rstest';
import { Layer } from 'effect';

describeWrapped('suite', (it) => {
  it('async callback', async () => {});
  it('inferred Promise callback', () => Promise.resolve());
  describeWrapped('nested wrapper', (nestedIt) => {
    nestedIt('nested wrapper async callback', async () => {});
  });
  it.layer(Layer.empty)('nested layer', (nestedIt) => {
    nestedIt('nested async callback', async () => {});
  });
});
describeSuite('named alias', (it) => {
  const check = it;
  check('local test alias', async () => {});
});
suite.describeWrapped('namespace', function (it) {
  it('function expression suite', async () => {});
});
const localDescribe = suite.describeWrapped;
localDescribe('local suite alias', ((it) => {
  it('wrapped callback', (async () => {}) satisfies () => unknown);
}) satisfies Parameters<typeof describeWrapped>[1]);
