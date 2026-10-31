import { expect, test } from 'effect-rstest';

import { operatorChanges } from '../../src/permissions/principal-operators.ts';

test('operatorChanges adds missing operators and removes stale ones', () => {
  expect(operatorChanges(['a', 'b'], ['b', 'c'])).toEqual({ add: ['c'], remove: ['a'] });
});

test('operatorChanges is empty when both sides are empty', () => {
  expect(operatorChanges([], [])).toEqual({ add: [], remove: [] });
});

test('operatorChanges counts duplicate desired operators once', () => {
  expect(operatorChanges([], ['x', 'x', 'y'])).toEqual({ add: ['x', 'y'], remove: [] });
});
